//! 이동·스타일·표시·복제·삭제 그룹 편집을 준비한 뒤 원자적으로 적용한다.

use std::collections::HashSet;
use std::mem::size_of;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json_scoped};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{RESOURCE_LIMITS, identifier, portable_color, portable_font};
use crate::drawing_types::{Drawing, DrawingPoint, DrawingPoints, DrawingStyle};
use crate::drawing_validation::canonical_drawing_value_scoped;
use crate::drawings::{DrawingFrame, DrawingStore};
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
#[derive(Debug, PartialEq, Eq)]
pub struct DrawingEditReceipt {
    /// 변경하거나 생성한 레코드 수다.
    pub changed: usize,
    /// 복제 작업에서만 제공하는 원본·대상 목록이다.
    pub created: Option<Vec<DrawingDuplicateCreated>>,
    /// 커밋 후 무효화 콜백이 오류를 냈는지 나타낸다.
    pub invalidation_failed: bool,
    _memory: MemoryGroup,
}

impl DrawingEditReceipt {
    /// 공개 영수증을 caller scope에서 fallible 직렬화한다.
    pub fn to_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut entries = scoped_entries(3, scope)?;
        entries.push((
            JsString::try_from_str("changed", scope).map_err(memory_error)?,
            JsValue::Number(self.changed as f64),
        ));
        let created_lookup = self
            .created
            .as_ref()
            .map(|_| JsString::try_from_str("created", scope).map_err(memory_error))
            .transpose()?;
        if let Some(key) = &created_lookup {
            entries.push((
                key.try_clone_scoped(scope).map_err(memory_error)?,
                JsValue::Undefined,
            ));
        }
        entries.push((
            JsString::try_from_str("invalidationFailed", scope).map_err(memory_error)?,
            JsValue::Bool(self.invalidation_failed),
        ));
        // created rows를 만들기 전에 outer receipt allocation을 끝낸다.
        let mut receipt =
            JsObject::try_from_entries_scoped(entries, scope).map_err(memory_error)?;
        if let Some(created) = &self.created {
            let bytes = created
                .len()
                .checked_mul(size_of::<JsValue>())
                .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            scope.try_grow(bytes).map_err(memory_error)?;
            let mut rows = Vec::new();
            rows.try_reserve_exact(created.len())
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            for row in created {
                let row_entries = [
                    (
                        JsString::try_from_str("sourceId", scope).map_err(memory_error)?,
                        JsValue::String(
                            row.source_id
                                .try_clone_scoped(scope)
                                .map_err(memory_error)?,
                        ),
                    ),
                    (
                        JsString::try_from_str("id", scope).map_err(memory_error)?,
                        JsValue::String(row.id.try_clone_scoped(scope).map_err(memory_error)?),
                    ),
                ];
                rows.push(JsValue::Object(
                    JsObject::try_from_entries_scoped(row_entries, scope).map_err(memory_error)?,
                ));
            }
            *receipt
                .get_mut(
                    created_lookup
                        .as_ref()
                        .expect("created placeholder key exists"),
                )
                .expect("created placeholder exists") = JsValue::Array(rows);
        }
        Ok(JsValue::Object(receipt))
    }

    /// 공개 영수증을 브리지 키 순서로 직렬화한다.
    pub fn to_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_value_scoped(&mut scope)
            .expect("unaccounted drawing edit receipt serialization")
    }
}

// created Vec만 밖으로 이동해 receipt lease보다 오래 살 수 없게 한다.
impl Drop for DrawingEditReceipt {
    fn drop(&mut self) {}
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
    drawing_style_patch_with_memory(
        value,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

fn drawing_style_patch_with_memory(
    value: &JsValue,
    memory: &MemoryContext,
) -> Result<DrawingStyle, JsError> {
    let record = plain_record(value, "Drawing style plain record required")?;
    if record.is_empty() {
        return Err(type_error("Drawing style nonempty defined patch required"));
    }
    for field in ["color", "fill", "width", "font"] {
        if field_value(record, field)
            .is_some_and(|value| matches!(value, JsValue::Undefined | JsValue::Null))
        {
            return Err(type_error("Drawing style nonempty defined patch required"));
        }
    }
    if record.iter().any(|(field, _)| {
        !["color", "fill", "width", "font"]
            .iter()
            .any(|allowed| allowed.encode_utf16().eq(field.as_units().iter().copied()))
    }) {
        return Err(type_error("Drawing style fields"));
    }
    let color = field_value(record, "color")
        .map(portable_color)
        .transpose()?;
    let fill = field_value(record, "fill")
        .map(portable_color)
        .transpose()?;
    let font = field_value(record, "font").map(portable_font).transpose()?;
    let width = match field_value(record, "width") {
        None => None,
        Some(JsValue::Number(width)) if width.is_finite() && (0.1..=50.0).contains(width) => {
            Some(*width)
        }
        Some(_) => return Err(range_error("Stroke width")),
    };
    DrawingStyle::try_from_borrowed(color.as_ref(), width, fill.as_ref(), font.as_ref(), memory)
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
    let memory = store.memory_context().clone();
    let mut group_scope = memory.scope();

    // JS 복제는 수명주기·제스처 검사보다 먼저 옵션을 정규화한다.
    let duplicate_options = if matches!(operation, Operation::Duplicate) {
        Some(translation_record_scoped(
            options_value.expect("duplicate takes options"),
            &["deltaTimeMs", "deltaPrice"],
            &mut group_scope,
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

    let ids = translation_list_scoped(ids_value, 128, &mut group_scope)?;
    let options_record = match operation {
        Operation::Delete | Operation::Visibility => None,
        Operation::Duplicate => duplicate_options,
        Operation::Translate => Some(translation_record_scoped(
            options_value.expect("translation takes options"),
            &["deltaTimeMs", "deltaPrice"],
            &mut group_scope,
        )?),
        Operation::Style => Some(translation_record_scoped(
            options_value.expect("style takes options"),
            &["color", "fill", "width", "font"],
            &mut group_scope,
        )?),
    };
    let options = options_value;
    if ids.is_empty() {
        return Err(range_error("Drawing group edit requires 1..128 ids"));
    }

    let mut selected = HashSet::new();
    try_hashset_capacity(&mut selected, ids.len(), &mut group_scope)?;
    for id in &ids {
        if !selected.insert(id) {
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
        let record = options_record.as_ref().expect("style options parsed");
        drawing_style_patch_with_memory(
            &JsValue::Object(clone_object_scoped(record, &mut group_scope)?),
            &memory,
        )?
    } else {
        DrawingStyle::empty(&memory)
    };
    validate_store_config_for_group(store)?;
    if matches!(operation, Operation::Duplicate) && store.serial > 9_007_199_254_740_991 {
        return Err(range_error("Drawing duplication serial"));
    }

    let extra = if matches!(operation, Operation::Duplicate) {
        ids.len()
    } else {
        0
    };
    let next_capacity = store
        .items
        .len()
        .checked_add(extra)
        .ok_or_else(|| memory.allocation_failure().into_js_error())?;
    let (mut next, next_memory) = memory
        .try_vec_capacity(next_capacity)
        .map_err(memory_error)?;
    next.extend(store.items.iter().cloned());
    let mut seen = HashSet::new();
    try_hashset_capacity(&mut seen, store.items.len(), &mut group_scope)?;
    let mut binding: Option<&Drawing> = None;
    let mut changed = 0usize;
    let mut point_count = 0usize;
    let mut text_count = 0usize;
    let mut pending_copies = scoped_vec_capacity(ids.len(), &mut group_scope)?;
    let mut receipt_scope = memory.scope();
    let mut created = if matches!(operation, Operation::Duplicate) {
        scoped_vec_capacity(ids.len(), &mut receipt_scope)?
    } else {
        Vec::new()
    };
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
        let current_value = current.to_value_scoped(&mut group_scope)?;
        let _validated =
            crate::drawing_validation::validate_drawing_with_memory(&current_value, &memory)?;
        drop(_validated);
        text_count = text_count.saturating_add(current.text_len_utf16());
        if !seen.insert(&current.id) {
            return Err(type_error("Duplicate drawing id"));
        }
        if !selected.contains(&current.id) {
            continue;
        }
        if current.locked == Some(true) && operation.needs_locked_writable() {
            return Err(error("Error", "Drawing is locked"));
        }
        if matches!(operation, Operation::Delete) {
            changed += 1;
            continue;
        }
        if matches!(operation, Operation::Visibility) {
            let visible = visibility.expect("visibility checked");
            if (current.visible != Some(false)) != visible {
                let mut candidate = current.try_clone_with_memory(&memory)?;
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
            let previous = current.style.as_deref();
            if !style_patch_matches(previous, &style_patch) {
                let merged = merge_style(previous, &style_patch, &memory)?;
                let mut candidate = current.try_clone_with_memory(&memory)?;
                candidate.style = Some(Arc::new(merged));
                next[index] = Arc::new(candidate);
                changed += 1;
            }
            continue;
        }

        if metadata {
            validate_binding(current, binding, binding_context)?;
            binding = Some(current);
        }
        let mut moved = false;
        let candidate_points = if matches!(operation, Operation::Duplicate) && !metadata {
            current.points.clone()
        } else {
            let (mut anchors, anchors_memory) = memory
                .try_vec_capacity(current.points.len())
                .map_err(memory_error)?;
            for point in current.points.iter() {
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
            DrawingPoints::try_from_vec(anchors, anchors_memory)?
        };
        let mut candidate = current.try_clone_with_memory(&memory)?;
        candidate.points = candidate_points;
        if matches!(operation, Operation::Duplicate) {
            candidate.locked = Some(false);
            pending_copies.push(Arc::new(candidate));
            changed += 1;
        } else if moved {
            let candidate = Arc::new(candidate);
            let candidate_value = candidate.to_value_scoped(&mut group_scope)?;
            let _validated =
                crate::drawing_validation::validate_drawing_with_memory(&candidate_value, &memory)?;
            drop(_validated);
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
                let mut attempt_scope = memory.scope();
                let candidate_id =
                    JsString::try_from_str(&format!("drawing-{next_serial}"), &mut attempt_scope)
                        .map_err(memory_error)?;
                if !seen.contains(&candidate_id)
                    && !created
                        .iter()
                        .any(|created: &DrawingDuplicateCreated| created.id == candidate_id)
                {
                    break candidate_id
                        .try_clone_scoped(&mut receipt_scope)
                        .map_err(memory_error)?;
                }
            };
            let source_id = candidate
                .id
                .try_clone_scoped(&mut receipt_scope)
                .map_err(memory_error)?;
            let duplicate = Arc::new(candidate.try_clone_with_id(&new_id, &memory)?);
            created.push(DrawingDuplicateCreated {
                source_id,
                id: new_id,
            });
            next.push(duplicate);
        }
        if serialized_document_length(&next, store.dialect, &memory)?
            > store.config.max_document_chars
        {
            return Err(range_error("Drawing duplication document limit"));
        }
    }
    if matches!(operation, Operation::Delete) {
        next.retain(|drawing| !selected.contains(&drawing.id));
    }
    let next = DrawingFrame::try_from_vec(next, next_memory)?;

    let receipt_bytes = usize::try_from(receipt_scope.requested_bytes())
        .map_err(|_| receipt_scope.allocation_failure().into_js_error())?;
    let receipt_memory = receipt_scope
        .split_persistent(receipt_bytes)
        .map_err(memory_error)?;
    let mut receipt = DrawingEditReceipt {
        changed,
        created: matches!(operation, Operation::Duplicate).then_some(created),
        invalidation_failed: false,
        _memory: receipt_memory,
    };
    if changed == 0 {
        if let Some(guard) = context.owner_guard {
            guard()?;
        }
        return Ok(receipt);
    }

    let current_snapshot = store.snapshot();
    let current_weight = validated_snapshot_weight(&current_snapshot, store.dialect, &memory)?;
    if current_weight > store.config.history_bytes {
        return Err(range_error(
            "Drawing group edit undo snapshot exceeds historyBytes",
        ));
    }
    let mut prior_history_bytes = 0usize;
    for snapshot in store.undo_stack.iter() {
        if snapshot.len() > store.config.max_drawings {
            return Err(range_error("Drawing group edit array limit/shape"));
        }
        let weight = validated_snapshot_weight(snapshot, store.dialect, &memory)?;
        prior_history_bytes = prior_history_bytes.saturating_add(weight);
        if prior_history_bytes > RESOURCE_LIMITS.max_history_bytes as usize {
            return Err(range_error(
                "Drawing group edit retained history resource limit",
            ));
        }
    }
    if let Some(guard) = context.owner_guard {
        guard()?;
    }

    // 준비와 예산 검사가 끝났다. 관찰자에게 알리기 전에 준비된 상태를 모두 설치한다.
    store.publish_mutation(next, |store| {
        if clear_selected {
            store.clear_selection();
        }
        if matches!(operation, Operation::Duplicate) {
            store.serial = next_serial;
        }
    })?;
    if let Some(invalidate) = context.invalidate.as_deref_mut()
        && invalidate(operation.invalidation()).is_err()
    {
        receipt.invalidation_failed = true;
    }
    Ok(receipt)
}

fn validate_binding(
    drawing: &Drawing,
    previous: Option<&Drawing>,
    bindings: DrawingBindingContext<'_>,
) -> Result<(), JsError> {
    if previous.is_some_and(|previous| {
        previous.panel != drawing.panel
            || previous.axis_id != drawing.axis_id
            || previous.series_id != drawing.series_id
    }) {
        return Err(error(
            "Error",
            "Drawing group edit requires identical panel/axis/series binding",
        ));
    }
    let panel = &drawing.panel;
    let axis = &drawing.axis_id;
    let series = &drawing.series_id;
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
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut bytes = snapshot.len().saturating_mul(8);
    for drawing in snapshot {
        let mut scope = memory.scope();
        let value = canonical_drawing_value_scoped(drawing, &mut scope)?;
        let _validated = crate::drawing_validation::validate_drawing_with_memory(&value, memory)?;
        drop(_validated);
        let text = stringify_scoped(&value, dialect, &mut scope)?;
        bytes = bytes.saturating_add(2usize.saturating_mul(utf16_len(&text)));
    }
    Ok(bytes)
}

fn serialized_document_length(
    drawings: &[Arc<Drawing>],
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut scope = memory.scope();
    let version = drawing_document_version(drawings);
    let drawings_lookup = JsString::try_from_str("drawings", &mut scope).map_err(memory_error)?;
    let entries = [
        (
            JsString::try_from_str("schema", &mut scope).map_err(memory_error)?,
            JsValue::String(
                JsString::try_from_str("aster.drawings", &mut scope).map_err(memory_error)?,
            ),
        ),
        (
            JsString::try_from_str("version", &mut scope).map_err(memory_error)?,
            JsValue::Number(f64::from(version)),
        ),
        (
            drawings_lookup
                .try_clone_scoped(&mut scope)
                .map_err(memory_error)?,
            JsValue::Undefined,
        ),
    ];
    let mut document =
        JsObject::try_from_entries_scoped(entries, &mut scope).map_err(memory_error)?;
    let mut values = scoped_vec_capacity(drawings.len(), &mut scope)?;
    for drawing in drawings {
        values.push(drawing.to_value_scoped(&mut scope)?);
    }
    *document
        .get_mut(&drawings_lookup)
        .expect("drawings placeholder exists") = JsValue::Array(values);
    let document = JsValue::Object(document);
    Ok(utf16_len(&stringify_scoped(
        &document, dialect, &mut scope,
    )?))
}

fn translation_list_scoped(
    value: &JsValue,
    maximum: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<JsString>, JsError> {
    let JsValue::Array(items) = value else {
        return Err(type_error("Drawing group edit plain array required"));
    };
    if items.len() > maximum {
        return Err(range_error("Drawing group edit array limit/shape"));
    }
    let mut ids = scoped_vec_capacity(items.len(), scope)?;
    for value in items {
        let id = identifier(value, "Drawing id")?;
        ids.push(id.try_clone_scoped(scope).map_err(memory_error)?);
    }
    Ok(ids)
}

fn translation_record_scoped(
    value: &JsValue,
    allowed: &[&str],
    scope: &mut MemoryScope,
) -> Result<JsObject, JsError> {
    let record = plain_record(value, "Drawing group edit plain record required")?;
    for (field, _) in record.iter() {
        if !allowed
            .iter()
            .any(|allowed| allowed.encode_utf16().eq(field.as_units().iter().copied()))
        {
            return Err(type_error("Drawing group edit fields"));
        }
    }
    let mut cloned = value.try_clone_scoped(scope).map_err(memory_error)?;
    match &mut cloned {
        JsValue::Object(record) => Ok(std::mem::take(record)),
        _ => unreachable!("plain record was checked"),
    }
}

fn plain_record<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

fn number_field(record: &JsObject, field: &str) -> Option<Option<f64>> {
    field_value(record, field).map(|value| match value {
        JsValue::Number(value) => Some(*value),
        _ => None,
    })
}

fn field_value<'a>(record: &'a JsObject, field: &str) -> Option<&'a JsValue> {
    record
        .iter()
        .find(|(name, _)| field.encode_utf16().eq(name.as_units().iter().copied()))
        .map(|(_, value)| value)
}

fn merge_style(
    previous: Option<&DrawingStyle>,
    patch: &DrawingStyle,
    memory: &MemoryContext,
) -> Result<DrawingStyle, JsError> {
    DrawingStyle::try_from_borrowed(
        patch
            .color
            .as_ref()
            .or_else(|| previous.and_then(|value| value.color.as_ref())),
        patch
            .width
            .or_else(|| previous.and_then(|value| value.width)),
        patch
            .fill
            .as_ref()
            .or_else(|| previous.and_then(|value| value.fill.as_ref())),
        patch
            .font
            .as_ref()
            .or_else(|| previous.and_then(|value| value.font.as_ref())),
        memory,
    )
}

fn style_patch_matches(previous: Option<&DrawingStyle>, patch: &DrawingStyle) -> bool {
    patch
        .color
        .as_ref()
        .is_none_or(|value| previous.and_then(|value| value.color.as_ref()) == Some(value))
        && patch
            .width
            .is_none_or(|value| previous.and_then(|value| value.width) == Some(value))
        && patch
            .fill
            .as_ref()
            .is_none_or(|value| previous.and_then(|value| value.fill.as_ref()) == Some(value))
        && patch
            .font
            .as_ref()
            .is_none_or(|value| previous.and_then(|value| value.font.as_ref()) == Some(value))
}

fn stringify_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Vec<u8>, JsError> {
    stringify_json_scoped(value, JsonMode::Standard, dialect, scope).map_err(memory_error)
}

fn utf16_len(bytes: &[u8]) -> usize {
    std::str::from_utf8(bytes)
        .expect("JSON writer emits valid UTF-8")
        .encode_utf16()
        .count()
}

fn scoped_entries(
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<(JsString, JsValue)>, JsError> {
    scoped_vec_capacity(capacity, scope)
}

fn clone_object_scoped(object: &JsObject, scope: &mut MemoryScope) -> Result<JsObject, JsError> {
    let mut entries = scoped_entries(object.len(), scope)?;
    for (key, value) in object.iter() {
        entries.push((
            key.try_clone_scoped(scope).map_err(memory_error)?,
            value.try_clone_scoped(scope).map_err(memory_error)?,
        ));
    }
    JsObject::try_from_entries_scoped(entries, scope).map_err(memory_error)
}

fn scoped_vec_capacity<T>(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

fn try_hashset_capacity<T: Eq + std::hash::Hash>(
    values: &mut HashSet<T>,
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let bytes = capacity
        .checked_mul(size_of::<T>().saturating_add(size_of::<usize>()))
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    values
        .try_reserve(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())
}

fn memory_error(failure: barochart_js::memory::MemoryFailure) -> JsError {
    failure.into_js_error()
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
