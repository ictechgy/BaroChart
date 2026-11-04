//! 이동·스타일·표시·복제·삭제 그룹 편집을 준비한 뒤 원자적으로 적용한다.

use std::collections::HashSet;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{RESOURCE_LIMITS, canonical_keys, identifier, portable_style};
use crate::drawing_types::{Drawing, DrawingPoint, DrawingStyle};
use crate::drawing_validation::{canonical_drawing_value, validate_drawing};
use crate::drawings::DrawingStore;
use crate::position_drawing::drawing_document_version;

/// 0이 아닌 그룹 이동에 필요한 패널·축·시리즈 메타데이터다.
#[derive(Clone, Copy, Debug)]
pub struct DrawingBindingContext<'a> {
    /// 현재 패널 식별자다.
    pub panels: &'a [DrawingPanelBinding],
    /// 현재 축 식별자와 소유 패널이다.
    pub axes: &'a [DrawingAxisBinding],
    /// 현재 시리즈 식별자와 소유 패널·축이다.
    pub series: &'a [DrawingSeriesBinding],
}

/// 드로잉 바인딩 검사에 사용하는 차트 패널 ID다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawingPanelBinding {
    /// 패널 ID다.
    pub id: JsString,
}

/// 축 식별자와 패널 연결 정보다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawingAxisBinding {
    /// 축 ID다.
    pub id: JsString,
    /// 소유 패널 ID다.
    pub panel: JsString,
}

/// 시리즈 식별자와 패널·축 연결 정보다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawingSeriesBinding {
    /// 시리즈 ID다.
    pub id: JsString,
    /// 소유 패널 ID다.
    pub panel: JsString,
    /// 선택적 축 ID다.
    pub axis_id: Option<JsString>,
}

/// 그룹 변경을 게시한 뒤 렌더링 무효화에 전달하는 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawingInvalidation {
    /// 차트의 기본 경로로 무효화한다.
    Default,
    /// 드로잉 시각 요소만 무효화한다.
    Drawings,
}

/// 작업별 수명주기·바인딩·무효화 어댑터다.
///
/// M4/M5 호출자가 차트·컨트롤러 상태에서 값을 제공한다. 저장소는 컨텍스트, 모델,
/// 컨트롤러 또는 콜백을 보관하지 않는다.
pub struct DrawingEditContext<'a> {
    /// 차트가 해제됐으면 true다.
    pub chart_disposed: bool,
    /// 컨트롤러가 다른 모델 소유이면 false다.
    pub controller_matches_model: bool,
    /// 포인터 제스처가 활성 상태면 true다.
    pub active_gesture: bool,
    /// 현재 바인딩이다. 0이 아닌 이동·복제 작업에 필요하다.
    pub bindings: Option<DrawingBindingContext<'a>>,
    /// 준비 전과 게시 직전에 실행하는 선택적 소유자 검사다.
    pub owner_guard: Option<&'a dyn Fn() -> Result<(), JsError>>,
    /// 커밋된 변경 뒤에만 호출하는 선택적 알림이다.
    pub invalidate: Option<&'a mut dyn FnMut(DrawingInvalidation) -> Result<(), JsError>>,
}

impl Default for DrawingEditContext<'_> {
    fn default() -> Self {
        Self {
            chart_disposed: false,
            controller_matches_model: true,
            active_gesture: false,
            bindings: None,
            owner_guard: None,
            invalidate: None,
        }
    }
}

/// 원본 z 순서대로 기록한 원본 드로잉 ID와 생성된 대상 ID다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawingDuplicateCreated {
    /// 복사한 원본 ID다.
    pub source_id: JsString,
    /// 새로 생성된 ID다.
    pub id: JsString,
}

/// 그룹 편집 브리지 작업에서 공통으로 사용하는 영수증이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawingEditReceipt {
    /// 변경하거나 생성한 레코드 수다.
    pub changed: usize,
    /// 복제 작업에서만 제공하는 원본·대상 목록이다.
    pub created: Option<Vec<DrawingDuplicateCreated>>,
    /// 커밋 후 무효화 콜백이 오류를 냈는지 나타낸다.
    pub invalidation_failed: bool,
}

impl DrawingEditReceipt {
    /// 공개 영수증을 브리지 키 순서로 직렬화한다.
    pub fn to_value(&self) -> JsValue {
        let mut receipt = JsObject::new();
        receipt.insert(key("changed"), JsValue::Number(self.changed as f64));
        if let Some(created) = &self.created {
            receipt.insert(
                key("created"),
                JsValue::Array(
                    created
                        .iter()
                        .map(|row| {
                            let mut value = JsObject::new();
                            value.insert(key("sourceId"), JsValue::String(row.source_id.clone()));
                            value.insert(key("id"), JsValue::String(row.id.clone()));
                            JsValue::Object(value)
                        })
                        .collect(),
                ),
            );
        }
        receipt.insert(
            key("invalidationFailed"),
            JsValue::Bool(self.invalidation_failed),
        );
        JsValue::Object(receipt)
    }
}

/// 선택한 드로잉을 원시 좌표 기준으로 이동한다.
pub fn translate_drawings(
    store: &mut DrawingStore,
    ids: &JsValue,
    options: &JsValue,
    context: &mut DrawingEditContext<'_>,
) -> Result<DrawingEditReceipt, JsError> {
    group_edit(store, ids, Some(options), Operation::Translate, context)
}

/// 이식 가능한 부분 스타일 패치를 적용한다.
pub fn set_drawings_style(
    store: &mut DrawingStore,
    ids: &JsValue,
    patch: &JsValue,
    context: &mut DrawingEditContext<'_>,
) -> Result<DrawingEditReceipt, JsError> {
    group_edit(store, ids, Some(patch), Operation::Style, context)
}

/// 잠긴 드로잉을 포함해 표시 상태를 바꾼다.
pub fn set_drawings_visibility(
    store: &mut DrawingStore,
    ids: &JsValue,
    visible: &JsValue,
    context: &mut DrawingEditContext<'_>,
) -> Result<DrawingEditReceipt, JsError> {
    group_edit(store, ids, Some(visible), Operation::Visibility, context)
}

/// 원본 z 순서대로 잠금 해제된 복사본을 추가한다.
pub fn duplicate_drawings(
    store: &mut DrawingStore,
    ids: &JsValue,
    options: &JsValue,
    context: &mut DrawingEditContext<'_>,
) -> Result<DrawingEditReceipt, JsError> {
    group_edit(store, ids, Some(options), Operation::Duplicate, context)
}

/// 선택한 드로잉을 삭제한다. 잠긴 항목이 있으면 전체 작업을 거부한다.
pub fn delete_drawings(
    store: &mut DrawingStore,
    ids: &JsValue,
    context: &mut DrawingEditContext<'_>,
) -> Result<DrawingEditReceipt, JsError> {
    group_edit(store, ids, None, Operation::Delete, context)
}

/// 그룹 편집에서 쓰는 이식 가능한 부분 스타일 패치 계약을 적용한다.
pub fn drawing_style_patch(value: &JsValue) -> Result<DrawingStyle, JsError> {
    let record = plain_record(value, "Drawing style plain record required")?;
    if record.is_empty() {
        return Err(type_error("Drawing style nonempty defined patch required"));
    }
    for field in canonical_keys(value, &["color", "fill", "width", "font"])? {
        if !["color", "fill", "width", "font"]
            .iter()
            .any(|allowed| field == JsString::from_str(allowed))
        {
            return Err(type_error("Drawing style fields"));
        }
        let patch_value = record.get(&field).expect("canonical key exists");
        if matches!(patch_value, JsValue::Undefined | JsValue::Null) {
            return Err(type_error("Drawing style nonempty defined patch required"));
        }
    }
    let normalized = portable_style(value, &["color", "fill"], false)?;
    let normalized = plain_record(&normalized, "Drawing style plain record required")?;
    let width = match normalized.get(&key("width")) {
        None => None,
        Some(JsValue::Number(width)) if width.is_finite() && (0.1..=50.0).contains(width) => {
            Some(*width)
        }
        Some(_) => return Err(range_error("Stroke width")),
    };
    Ok(DrawingStyle {
        color: string_field(normalized, "color"),
        width,
        fill: string_field(normalized, "fill"),
        font: string_field(normalized, "font"),
    })
}

#[derive(Clone, Copy)]
enum Operation {
    Translate,
    Style,
    Visibility,
    Duplicate,
    Delete,
}

impl Operation {
    fn uses_metadata(
        self,
        delta_time: Option<Option<f64>>,
        delta_price: Option<Option<f64>>,
    ) -> bool {
        match self {
            Self::Translate => true,
            Self::Duplicate => !(delta_time == Some(Some(0.0)) && delta_price == Some(Some(0.0))),
            Self::Style | Self::Visibility | Self::Delete => false,
        }
    }

    fn needs_locked_writable(self) -> bool {
        matches!(self, Self::Translate | Self::Style | Self::Delete)
    }

    fn invalidation(self) -> DrawingInvalidation {
        match self {
            Self::Visibility | Self::Duplicate => DrawingInvalidation::Drawings,
            Self::Translate | Self::Style | Self::Delete => DrawingInvalidation::Default,
        }
    }
}

fn group_edit(
    store: &mut DrawingStore,
    ids_value: &JsValue,
    options_value: Option<&JsValue>,
    operation: Operation,
    context: &mut DrawingEditContext<'_>,
) -> Result<DrawingEditReceipt, JsError> {
    if let Some(guard) = context.owner_guard {
        guard()?;
    }

    // JS 복제는 수명주기·제스처 검사보다 먼저 옵션을 정규화한다.
    let duplicate_options = if matches!(operation, Operation::Duplicate) {
        Some(translation_record(
            options_value.expect("duplicate takes options"),
            &["deltaTimeMs", "deltaPrice"],
        )?)
    } else {
        None
    };
    let duplicate_delta = duplicate_options.as_ref().map(|options| {
        (
            number_field(options, "deltaTimeMs"),
            number_field(options, "deltaPrice"),
        )
    });
    let metadata = operation.uses_metadata(
        duplicate_delta.and_then(|delta| delta.0),
        duplicate_delta.and_then(|delta| delta.1),
    );

    if context.chart_disposed {
        return Err(error("Error", "Chart disposed"));
    }
    if !context.controller_matches_model {
        return Err(error(
            "Error",
            "Drawing group edit controller owner mismatch",
        ));
    }
    if context.active_gesture || store.transaction.is_some() {
        return Err(error(
            "Error",
            "Drawing group edit requires no active gesture or transaction",
        ));
    }

    let store_limit = RESOURCE_LIMITS.max_drawings as usize;
    if store.items.len() > store_limit
        || store.undo_stack.len() > 10_000
        || store.redo_stack.len() > 10_000
    {
        return Err(range_error("Drawing group edit array limit/shape"));
    }
    let empty_panels = [];
    let empty_axes = [];
    let empty_series = [];
    let empty_bindings = DrawingBindingContext {
        panels: &empty_panels,
        axes: &empty_axes,
        series: &empty_series,
    };
    let binding_context = context.bindings.unwrap_or(empty_bindings);

    let ids = translation_list(ids_value, 128)?;
    let options_record = match operation {
        Operation::Delete | Operation::Visibility => None,
        Operation::Duplicate => duplicate_options.clone(),
        Operation::Translate => Some(translation_record(
            options_value.expect("translation takes options"),
            &["deltaTimeMs", "deltaPrice"],
        )?),
        Operation::Style => Some(translation_record(
            options_value.expect("style takes options"),
            &["color", "fill", "width", "font"],
        )?),
    };
    let options = options_value;
    if ids.is_empty() {
        return Err(range_error("Drawing group edit requires 1..128 ids"));
    }

    let mut selected = HashSet::with_capacity(ids.len());
    for id in &ids {
        let value = JsValue::String(id.clone());
        identifier(&value, "Drawing id")?;
        if !selected.insert(id.clone()) {
            return Err(type_error("Duplicate drawing id"));
        }
    }

    let visibility = if matches!(operation, Operation::Visibility) {
        match options {
            Some(JsValue::Bool(visible)) => Some(*visible),
            _ => return Err(type_error("Drawing visibility boolean required")),
        }
    } else {
        None
    };
    let (delta_time, delta_price) =
        if matches!(operation, Operation::Translate | Operation::Duplicate) {
            let options = options_record.as_ref().expect("translation options parsed");
            let delta_time = number_field(options, "deltaTimeMs").flatten();
            let delta_price = number_field(options, "deltaPrice").flatten();
            if !delta_time.is_some_and(f64::is_finite) || !delta_price.is_some_and(f64::is_finite) {
                return Err(type_error("Finite deltaTimeMs and deltaPrice required"));
            }
            (
                delta_time.expect("finite delta"),
                delta_price.expect("finite delta"),
            )
        } else {
            (0.0, 0.0)
        };
    let style_patch = if matches!(operation, Operation::Style) {
        let record = options_record
            .as_ref()
            .expect("style options parsed")
            .clone();
        drawing_style_patch(&JsValue::Object(record))?
    } else {
        DrawingStyle {
            color: None,
            width: None,
            fill: None,
            font: None,
        }
    };
    validate_store_config_for_group(store)?;
    if matches!(operation, Operation::Duplicate) && store.serial > 9_007_199_254_740_991 {
        return Err(range_error("Drawing duplication serial"));
    }

    let mut next = store.items.clone();
    let mut seen = HashSet::with_capacity(store.items.len());
    let mut binding: Option<(JsString, Option<JsString>, Option<JsString>)> = None;
    let mut changed = 0usize;
    let mut point_count = 0usize;
    let mut text_count = 0usize;
    let mut pending_copies = Vec::new();
    let mut created = Vec::new();
    let mut next_serial = store.serial;
    let mut clear_selected = matches!(operation, Operation::Delete)
        && store
            .selected
            .as_ref()
            .is_some_and(|id| selected.contains(id));

    for (index, current) in store.items.iter().enumerate() {
        point_count = point_count.saturating_add(current.points.len());
        if point_count > store.config.max_points {
            return Err(range_error("Drawing group edit point limit"));
        }
        validate_drawing(&current.to_value())?;
        let before = current.as_ref().clone();
        text_count = text_count.saturating_add(before.text_len_utf16());
        if !seen.insert(before.id.clone()) {
            return Err(type_error("Duplicate drawing id"));
        }
        if !selected.contains(&before.id) {
            continue;
        }
        if before.locked == Some(true) && operation.needs_locked_writable() {
            return Err(error("Error", "Drawing is locked"));
        }
        if matches!(operation, Operation::Delete) {
            next[index] = Arc::new(before);
            changed += 1;
            continue;
        }
        if matches!(operation, Operation::Visibility) {
            let visible = visibility.expect("visibility checked");
            if (before.visible != Some(false)) != visible {
                let mut candidate = before;
                candidate.visible = Some(visible);
                next[index] = Arc::new(candidate);
                changed += 1;
                if !visible && store.selected.as_ref() == Some(&next[index].id) {
                    clear_selected = true;
                }
            }
            continue;
        }
        if matches!(operation, Operation::Style) {
            let previous = before.style.as_deref();
            let merged = merge_style(previous, &style_patch);
            if !style_patch_matches(previous, &style_patch) {
                let mut candidate = before;
                candidate.style = Some(Arc::new(merged));
                next[index] = Arc::new(candidate);
                changed += 1;
            }
            continue;
        }

        if metadata {
            validate_binding(&before, binding.as_ref(), binding_context)?;
            binding = Some((
                before.panel.clone(),
                before.axis_id.clone(),
                before.series_id.clone(),
            ));
        }
        let mut anchors = Vec::with_capacity(before.points.len());
        let mut moved = false;
        for point in before.points.iter() {
            let time = if delta_time == 0.0 {
                point.time
            } else {
                point.time + delta_time
            };
            let price = if delta_price == 0.0 {
                point.price
            } else {
                point.price + delta_price
            };
            moved |= time != point.time || price != point.price;
            anchors.push(DrawingPoint { time, price });
        }
        let candidate_points = if matches!(operation, Operation::Duplicate) && !metadata {
            before.points.clone()
        } else {
            Arc::from(anchors)
        };
        let mut candidate = before.clone();
        candidate.points = candidate_points;
        if matches!(operation, Operation::Duplicate) {
            candidate.locked = Some(false);
            pending_copies.push(candidate);
            changed += 1;
        } else if moved {
            let candidate = Arc::new(candidate);
            validate_drawing(&candidate.to_value())?;
            next[index] = candidate;
            changed += 1;
        }
    }

    if ids.iter().any(|id| !seen.contains(id)) {
        return Err(error("Error", "Missing drawing"));
    }
    if store.items.len() > store.config.max_drawings
        || point_count > store.config.max_points
        || text_count > 1_000_000
    {
        return Err(range_error("Drawing group edit resource limit"));
    }

    if matches!(operation, Operation::Duplicate) {
        for candidate in &pending_copies {
            point_count = point_count.saturating_add(candidate.points.len());
            text_count = text_count.saturating_add(candidate.text_len_utf16());
        }
        if store.items.len() + pending_copies.len() > store.config.max_drawings
            || point_count > store.config.max_points
            || text_count > 1_000_000
        {
            return Err(range_error("Drawing duplication resource limit"));
        }
        let mut attempts = 0usize;
        for candidate in pending_copies {
            let new_id = loop {
                if next_serial == 9_007_199_254_740_991
                    || attempts > store.items.len() + created.len()
                {
                    return Err(range_error("Drawing duplication ID exhaustion"));
                }
                next_serial += 1;
                attempts += 1;
                let candidate_id = JsString::from_str(&format!("drawing-{next_serial}"));
                if !seen.contains(&candidate_id) {
                    break candidate_id;
                }
            };
            seen.insert(new_id.clone());
            created.push(DrawingDuplicateCreated {
                source_id: candidate.id.clone(),
                id: new_id.clone(),
            });
            let mut duplicate = candidate;
            duplicate.id = new_id;
            next.push(Arc::new(duplicate));
        }
        if serialized_document_length(&next, store.dialect) > store.config.max_document_chars {
            return Err(range_error("Drawing duplication document limit"));
        }
    }
    if matches!(operation, Operation::Delete) {
        next.retain(|drawing| !selected.contains(&drawing.id));
    }

    let mut receipt = DrawingEditReceipt {
        changed,
        created: matches!(operation, Operation::Duplicate).then_some(created),
        invalidation_failed: false,
    };
    if changed == 0 {
        if let Some(guard) = context.owner_guard {
            guard()?;
        }
        return Ok(receipt);
    }

    let current_snapshot = store.snapshot();
    let current_weight = validated_snapshot_weight(&current_snapshot, store.dialect)?;
    if current_weight > store.config.history_bytes {
        return Err(range_error(
            "Drawing group edit undo snapshot exceeds historyBytes",
        ));
    }
    let mut history = Vec::with_capacity(store.undo_stack.len() + 1);
    let mut history_weights = Vec::with_capacity(store.undo_stack.len() + 1);
    let mut prior_history_bytes = 0usize;
    for snapshot in &store.undo_stack {
        if snapshot.len() > store.config.max_drawings {
            return Err(range_error("Drawing group edit array limit/shape"));
        }
        let weight = validated_snapshot_weight(snapshot, store.dialect)?;
        prior_history_bytes = prior_history_bytes.saturating_add(weight);
        if prior_history_bytes > RESOURCE_LIMITS.max_history_bytes as usize {
            return Err(range_error(
                "Drawing group edit retained history resource limit",
            ));
        }
        history.push(snapshot.clone());
        history_weights.push(weight);
    }
    history.push(current_snapshot);
    history_weights.push(current_weight);
    let mut retained_bytes = history_weights.iter().copied().sum::<usize>();
    let mut trim_start = 0usize;
    while history.len() - trim_start > store.config.history_limit
        || retained_bytes > store.config.history_bytes
    {
        retained_bytes = retained_bytes.saturating_sub(history_weights[trim_start]);
        trim_start += 1;
    }
    let next_undo = history[trim_start..].to_vec();
    let next_redo = Vec::new();
    if let Some(guard) = context.owner_guard {
        guard()?;
    }

    // 준비와 예산 검사가 끝났다. 관찰자에게 알리기 전에 준비된 상태를 모두 설치한다.
    store.items = next;
    store.undo_stack = next_undo;
    store.redo_stack = next_redo;
    store.retained_history_bytes = retained_bytes;
    if clear_selected {
        store.selected = None;
    }
    if matches!(operation, Operation::Duplicate) {
        store.serial = next_serial;
    }
    if let Some(invalidate) = context.invalidate.as_deref_mut()
        && invalidate(operation.invalidation()).is_err()
    {
        receipt.invalidation_failed = true;
    }
    Ok(receipt)
}

fn validate_binding(
    drawing: &Drawing,
    previous: Option<&(JsString, Option<JsString>, Option<JsString>)>,
    bindings: DrawingBindingContext<'_>,
) -> Result<(), JsError> {
    let current = (
        drawing.panel.clone(),
        drawing.axis_id.clone(),
        drawing.series_id.clone(),
    );
    if previous.is_some_and(|previous| previous != &current) {
        return Err(error(
            "Error",
            "Drawing group edit requires identical panel/axis/series binding",
        ));
    }
    let (panel, axis, series) = &current;
    let panel_found = bindings.panels.iter().any(|value| value.id == *panel);
    let axis_found = axis.as_ref().is_none_or(|axis| {
        bindings
            .axes
            .iter()
            .any(|value| value.id == *axis && value.panel == *panel)
    });
    let series_found = series.as_ref().is_none_or(|series| {
        bindings
            .series
            .iter()
            .any(|value| value.id == *series && value.panel == *panel && value.axis_id == *axis)
    });
    if !panel_found || !axis_found || !series_found {
        return Err(error("Error", "Missing or mismatched drawing binding"));
    }
    Ok(())
}

fn validate_store_config_for_group(store: &DrawingStore) -> Result<(), JsError> {
    let config = store.config;
    if config.max_drawings > 10_000
        || config.max_points > 2_097_152
        || config.max_document_chars > RESOURCE_LIMITS.max_document_chars as usize
        || config.history_limit == 0
        || config.history_limit > 10_000
        || config.history_bytes > RESOURCE_LIMITS.max_history_bytes as usize
    {
        return Err(range_error("Drawing group edit history/resource limit"));
    }
    Ok(())
}

fn validated_snapshot_weight(
    snapshot: &[Arc<Drawing>],
    dialect: NumberDialect,
) -> Result<usize, JsError> {
    let mut bytes = snapshot.len().saturating_mul(8);
    for drawing in snapshot {
        let value = canonical_drawing_value(drawing);
        validate_drawing(&value)?;
        let text = stringify(&value, dialect);
        bytes = bytes.saturating_add(2usize.saturating_mul(utf16_len(&text)));
    }
    Ok(bytes)
}

fn serialized_document_length(drawings: &[Arc<Drawing>], dialect: NumberDialect) -> usize {
    let version = drawing_document_version(drawings);
    let mut document = JsObject::new();
    document.insert(
        key("schema"),
        JsValue::String(JsString::from_str("aster.drawings")),
    );
    document.insert(key("version"), JsValue::Number(f64::from(version)));
    document.insert(
        key("drawings"),
        JsValue::Array(drawings.iter().map(|drawing| drawing.to_value()).collect()),
    );
    utf16_len(&stringify(&JsValue::Object(document), dialect))
}

fn translation_list(value: &JsValue, maximum: usize) -> Result<Vec<JsString>, JsError> {
    let JsValue::Array(items) = value else {
        return Err(type_error("Drawing group edit plain array required"));
    };
    if items.len() > maximum {
        return Err(range_error("Drawing group edit array limit/shape"));
    }
    items
        .iter()
        .map(|value| match value {
            JsValue::String(value) => Ok(value.clone()),
            _ => Err(type_error("Drawing id: string limit 128")),
        })
        .collect()
}

fn translation_record(value: &JsValue, allowed: &[&str]) -> Result<JsObject, JsError> {
    let record = plain_record(value, "Drawing group edit plain record required")?;
    for (field, _) in record.iter() {
        if !allowed
            .iter()
            .any(|allowed| field == &JsString::from_str(allowed))
        {
            return Err(type_error("Drawing group edit fields"));
        }
    }
    Ok(record.clone())
}

fn plain_record<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

fn number_field(record: &JsObject, field: &str) -> Option<Option<f64>> {
    record.get(&key(field)).map(|value| match value {
        JsValue::Number(value) => Some(*value),
        _ => None,
    })
}

fn string_field(record: &JsObject, field: &str) -> Option<JsString> {
    match record.get(&key(field)) {
        Some(JsValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn merge_style(previous: Option<&DrawingStyle>, patch: &DrawingStyle) -> DrawingStyle {
    let empty = DrawingStyle {
        color: None,
        width: None,
        fill: None,
        font: None,
    };
    let previous = previous.unwrap_or(&empty);
    DrawingStyle {
        color: patch.color.clone().or_else(|| previous.color.clone()),
        width: patch.width.or(previous.width),
        fill: patch.fill.clone().or_else(|| previous.fill.clone()),
        font: patch.font.clone().or_else(|| previous.font.clone()),
    }
}

fn style_patch_matches(previous: Option<&DrawingStyle>, patch: &DrawingStyle) -> bool {
    let empty = DrawingStyle {
        color: None,
        width: None,
        fill: None,
        font: None,
    };
    let previous = previous.unwrap_or(&empty);
    patch
        .color
        .as_ref()
        .is_none_or(|value| previous.color.as_ref() == Some(value))
        && patch
            .width
            .is_none_or(|value| previous.width == Some(value))
        && patch
            .fill
            .as_ref()
            .is_none_or(|value| previous.fill.as_ref() == Some(value))
        && patch
            .font
            .as_ref()
            .is_none_or(|value| previous.font.as_ref() == Some(value))
}

fn stringify(value: &JsValue, dialect: NumberDialect) -> Vec<u8> {
    stringify_json_with(value, JsonMode::Standard, dialect)
}

fn utf16_len(bytes: &[u8]) -> usize {
    std::str::from_utf8(bytes)
        .expect("JSON writer emits valid UTF-8")
        .encode_utf16()
        .count()
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    error("TypeError", message)
}

fn range_error(message: &str) -> JsError {
    error("RangeError", message)
}
