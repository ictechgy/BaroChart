//! 드로잉 저장소, 불변 스냅샷, 문서 저장, undo/redo 이력을 관리한다.

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{RESOURCE_LIMITS, option_record, size_limit};
use crate::drawing_document::{
    DrawingDocumentContext, DrawingDocumentLimits, enforce_drawing_budget, load_drawing_document,
    save_drawing_document,
};
use crate::drawing_types::Drawing;
use crate::drawing_validation::{canonical_drawing, canonical_drawing_value, validate_drawing};
use crate::position_drawing::{PositionMetrics, position_metrics_for};

/// 드로잉 저장소에 적용하는 자원·이력 한도다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawingStoreConfig {
    /// 보관할 undo/redo 스냅샷의 최대 수다.
    pub history_limit: usize,
    /// 한 현재 프레임에 저장할 최대 드로잉 수다.
    pub max_drawings: usize,
    /// 한 현재 프레임에 저장할 최대 앵커 수다.
    pub max_points: usize,
    /// 드로잉 문서의 최대 UTF-16 길이다.
    pub max_document_chars: usize,
    /// 이력 회계에 보관할 최대 바이트 수다.
    pub history_bytes: usize,
}

impl Default for DrawingStoreConfig {
    fn default() -> Self {
        Self {
            history_limit: 100,
            max_drawings: RESOURCE_LIMITS.max_drawings as usize,
            max_points: RESOURCE_LIMITS.max_drawing_points as usize,
            max_document_chars: RESOURCE_LIMITS.max_document_chars as usize,
            history_bytes: RESOURCE_LIMITS.max_history_bytes as usize,
        }
    }
}

/// 불변 스냅샷과 공유하는 드로잉 프레임이다.
pub type DrawingSnapshot = Arc<[Arc<Drawing>]>;

/// 변경 가능한 드로잉 소유자다. 공개된 레코드와 이력 스냅샷은 모두 불변이다.
pub struct DrawingStore {
    pub(crate) items: Vec<Arc<Drawing>>,
    pub(crate) undo_stack: Vec<DrawingSnapshot>,
    pub(crate) redo_stack: Vec<DrawingSnapshot>,
    pub(crate) transaction: Option<DrawingSnapshot>,
    pub(crate) selected: Option<JsString>,
    pub(crate) serial: u64,
    pub(crate) config: DrawingStoreConfig,
    pub(crate) retained_history_bytes: usize,
    pub(crate) dialect: NumberDialect,
}

impl DrawingStore {
    /// 현재 painter 순서의 불변 drawing 레코드를 할당 없이 빌린다.
    pub fn items(&self) -> &[Arc<Drawing>] {
        &self.items
    }

    /// 한도를 확인한 뒤 빈 저장소를 만든다.
    pub fn new(config: DrawingStoreConfig, dialect: NumberDialect) -> Result<Self, JsError> {
        validate_config(config)?;
        Ok(Self {
            items: Vec::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            transaction: None,
            selected: None,
            serial: 0,
            config,
            retained_history_bytes: 0,
            dialect,
        })
    }

    /// JS 기본값과 지정한 수 방언으로 빈 저장소를 만든다.
    pub fn with_defaults(dialect: NumberDialect) -> Self {
        Self::new(DrawingStoreConfig::default(), dialect).expect("valid drawing defaults")
    }

    /// JS 생성자 옵션 레코드에서 저장소를 만든다.
    pub fn from_options(options: &JsValue, dialect: NumberDialect) -> Result<Self, JsError> {
        let Some(options) = object(options) else {
            return Err(type_error("Drawing store options required"));
        };
        let defaults = DrawingStoreConfig::default();
        let history_limit = match options.get(&key("historyLimit")) {
            None | Some(JsValue::Undefined) => defaults.history_limit,
            Some(JsValue::Number(value))
                if value.is_finite()
                    && value.fract() == 0.0
                    && *value >= 1.0
                    && *value <= 10_000.0 =>
            {
                *value as usize
            }
            Some(_) => return Err(range_error("History limit 1..10000")),
        };
        let max_drawings = config_option(
            options,
            "maxDrawings",
            defaults.max_drawings as u64,
            defaults.max_drawings as u64,
        )? as usize;
        let max_points =
            config_option(options, "maxPoints", defaults.max_points as u64, 2_097_152)? as usize;
        let max_document_chars = config_option(
            options,
            "maxDocumentChars",
            RESOURCE_LIMITS.max_document_chars,
            RESOURCE_LIMITS.max_document_chars,
        )? as usize;
        let history_bytes = config_option(
            options,
            "historyBytes",
            RESOURCE_LIMITS.max_history_bytes,
            RESOURCE_LIMITS.max_history_bytes,
        )? as usize;
        Self::new(
            DrawingStoreConfig {
                history_limit,
                max_drawings,
                max_points,
                max_document_chars,
                history_bytes,
            },
            dialect,
        )
    }

    /// 현재 불변 드로잉 프레임을 공유 스냅샷으로 반환한다.
    pub fn snapshot(&self) -> DrawingSnapshot {
        Arc::from(self.items.clone())
    }

    /// 설정된 저장소 한도를 반환한다.
    pub fn config(&self) -> DrawingStoreConfig {
        self.config
    }

    /// 현재 선택된 드로잉 ID를 반환한다.
    pub fn selected(&self) -> Option<&JsString> {
        self.selected.as_ref()
    }

    /// 생성 ID에 사용하는 단조 증가 serial을 반환한다.
    pub fn serial(&self) -> u64 {
        self.serial
    }

    /// 활성 트랜잭션이 있으면 시작 시점의 불변 프레임을 반환한다.
    pub fn transaction(&self) -> Option<&DrawingSnapshot> {
        self.transaction.as_ref()
    }

    /// 오래된 순서부터 최근 순서대로 undo 프레임을 반환한다.
    pub fn undo_stack(&self) -> &[DrawingSnapshot] {
        &self.undo_stack
    }

    /// 오래된 순서부터 최근 순서대로 redo 프레임을 반환한다.
    pub fn redo_stack(&self) -> &[DrawingSnapshot] {
        &self.redo_stack
    }

    /// 보관 중인 이력 바이트 수를 반환한다.
    pub fn retained_history_bytes(&self) -> usize {
        self.retained_history_bytes
    }

    /// 현재 공유 프레임에서 드로잉 트랜잭션을 시작한다.
    pub fn begin(&mut self) -> Result<(), JsError> {
        if self.transaction.is_some() {
            return Err(error("Error", "A drawing transaction is already active"));
        }
        self.transaction = Some(self.snapshot());
        Ok(())
    }

    /// 길이나 드로잉 레코드 식별성이 바뀐 경우에만 트랜잭션을 커밋한다.
    pub fn commit(&mut self) {
        let Some(before) = self.transaction.take() else {
            return;
        };
        if !same_frame_identity(&before, &self.items) {
            self.undo_stack.push(before);
            self.redo_stack.clear();
            self.trim_history();
        }
    }

    /// 트랜잭션의 원래 프레임을 복원하고 숨겨지거나 삭제된 선택을 해제한다.
    pub fn cancel(&mut self) {
        let Some(before) = self.transaction.take() else {
            return;
        };
        self.items = before.to_vec();
        if self.selected.as_ref().is_some_and(|selected| {
            !self
                .items
                .iter()
                .any(|drawing| drawing.id == *selected && drawing.visible != Some(false))
        }) {
            self.selected = None;
        }
    }

    /// JS와 같은 기본 레코드 및 생성 ID 정책을 적용해 드로잉을 추가한다.
    pub fn add(&mut self, input: &JsValue) -> Result<JsString, JsError> {
        option_record(
            input,
            &[
                "id", "type", "panel", "points", "style", "text", "locked", "visible", "axisId",
                "seriesId",
            ],
            "Drawing",
        )?;
        let input_record = object(input).ok_or_else(|| type_error("Drawing: object required"))?;
        let mut serial = self.serial;
        let mut id = match input_record.get(&key("id")) {
            Some(value) if !js_falsy(value) => match value {
                JsValue::String(id) => id.clone(),
                _ => return Err(type_error("Drawing id: string limit 128")),
            },
            _ => loop {
                serial = serial
                    .checked_add(1)
                    .ok_or_else(|| range_error("Drawing serial limit"))?;
                let candidate = JsString::from_str(&format!("drawing-{serial}"));
                if !self.items.iter().any(|drawing| drawing.id == candidate) {
                    break candidate;
                }
            },
        };

        let mut raw = JsObject::new();
        raw.insert(key("id"), JsValue::String(id.clone()));
        raw.insert(key("panel"), JsValue::String(JsString::from_str("price")));
        raw.insert(key("locked"), JsValue::Bool(false));
        let mut style = JsObject::new();
        style.insert(key("color"), JsValue::String(JsString::from_str("#f5b85a")));
        style.insert(key("width"), JsValue::Number(1.5));
        raw.insert(key("style"), JsValue::Object(style));
        for (field, value) in input_record.iter() {
            raw.insert(field.clone(), value.clone());
        }
        raw.insert(key("id"), JsValue::String(id.clone()));
        let raw = JsValue::Object(raw);
        let _validated = validate_drawing(&raw)?;
        let drawing = Arc::new(canonical_drawing(&raw, self.dialect)?);
        id = drawing.id.clone();
        if self.items.iter().any(|current| current.id == id) {
            return Err(error("Error", "Duplicate drawing id"));
        }
        let mut next = self.items.clone();
        next.push(drawing.clone());
        enforce_drawing_budget(&next, self.document_limits())?;
        self.mutate(|store| {
            store.items = next;
            if drawing.visible != Some(false) {
                store.selected = Some(id.clone());
            }
            store.serial = serial;
            Ok(())
        })?;
        Ok(id)
    }

    /// 레코드 하나를 편집한다. 양쪽을 한 번씩 직렬화하고 필요하면 정규 키 순서로 다시 비교한다.
    pub fn edit(&mut self, id: &JsString, patch: &JsValue) -> Result<(), JsError> {
        option_record(
            patch,
            &[
                "type", "panel", "points", "style", "text", "locked", "visible", "axisId",
                "seriesId",
            ],
            "Drawing patch",
        )?;
        let patch = object(patch).ok_or_else(|| type_error("Drawing patch: object required"))?;
        let Some(index) = self.items.iter().position(|drawing| drawing.id == *id) else {
            return Err(error("Error", "Missing drawing"));
        };
        let previous = &self.items[index];
        if previous.locked == Some(true)
            && patch
                .iter()
                .any(|(field, _)| field != &key("locked") && field != &key("visible"))
        {
            return Err(error("Error", "Drawing is locked"));
        }

        let previous_value = canonical_drawing_value(previous);
        let mut next_value = match &previous_value {
            JsValue::Object(record) => record.clone(),
            _ => unreachable!("drawing record serializes as object"),
        };
        for (field, value) in patch.iter() {
            next_value.insert(field.clone(), value.clone());
        }
        let next_value = JsValue::Object(next_value);
        let _next_validated = validate_drawing(&next_value)?;
        let previous_text = stringify(&previous_value, self.dialect);
        let next_text = stringify(&next_value, self.dialect);
        if previous_text == next_text {
            return Ok(());
        }
        if utf16_len(&previous_text) == utf16_len(&next_text) {
            let parsed = parse_json_with(&next_text, JsonMode::Standard, self.dialect)?;
            let canonical = crate::drawing_validation::canonicalize_drawing_value(&parsed)?;
            if previous_text == stringify(&canonical, self.dialect) {
                return Ok(());
            }
        }

        let copied = crate::drawing_validation::copy_drawing_value(&next_value, self.dialect)?;
        let canonical = crate::drawing_validation::canonicalize_drawing_value(&copied)?;
        let mut next_value = validate_drawing(&canonical)?;
        if patch.get(&key("points")).is_none() {
            next_value.points = previous.points.clone();
        }
        if patch.get(&key("style")).is_none() {
            next_value.style = previous.style.clone();
        }
        let next = Arc::new(next_value);
        let mut changed = self.items.clone();
        changed[index] = next.clone();
        enforce_drawing_budget(&changed, self.document_limits())?;
        self.mutate(|store| {
            store.items = changed;
            if next.visible == Some(false) && store.selected.as_ref() == Some(id) {
                store.selected = None;
            }
            Ok(())
        })
    }

    /// 잠기지 않은 드로잉을 제거하고 해당 선택을 해제한다.
    pub fn remove(&mut self, id: &JsString) -> Result<bool, JsError> {
        let Some(index) = self.items.iter().position(|drawing| drawing.id == *id) else {
            return Ok(false);
        };
        if self.items[index].locked == Some(true) {
            return Ok(false);
        }
        let mut next = self.items.clone();
        next.remove(index);
        self.mutate(|store| {
            store.items = next;
            if store.selected.as_ref() == Some(id) {
                store.selected = None;
            }
            Ok(())
        })?;
        Ok(true)
    }

    /// 표시 중인 드로잉을 선택하거나 선택을 해제한다.
    pub fn select(&mut self, id: Option<&JsString>) -> Result<(), JsError> {
        if let Some(id) = id
            && !self
                .items
                .iter()
                .any(|drawing| drawing.id == *id && drawing.visible != Some(false))
        {
            return Err(error("Error", "Missing or hidden drawing"));
        }
        self.selected = id.cloned();
        Ok(())
    }

    /// 저장된 포지션 드로잉의 지표를 반환한다.
    pub fn position_metrics(&self, id: &JsString) -> Result<PositionMetrics, JsError> {
        let Some(drawing) = self.items.iter().find(|drawing| drawing.id == *id) else {
            return Err(type_error("Position drawing required"));
        };
        if !drawing.kind.is_position() {
            return Err(type_error("Position drawing required"));
        }
        position_metrics_for(drawing)
    }

    /// 현재 프레임을 최소 버전의 정규 문서로 저장한다.
    pub fn save(&self) -> Result<JsString, JsError> {
        save_drawing_document(
            &self.items,
            self.config.max_document_chars,
            self.dialect,
            self.transaction.is_some(),
        )
    }

    /// 전체 문서를 원자적으로 검증하고 불러온다.
    pub fn load(
        &mut self,
        text: &JsString,
        context: &DrawingDocumentContext<'_>,
    ) -> Result<(), JsError> {
        let drawings = load_drawing_document(
            text,
            self.document_limits(),
            self.dialect,
            context,
            self.transaction.is_some(),
        )?;
        self.mutate(|store| {
            store.items = drawings;
            store.selected = None;
            Ok(())
        })
    }

    /// 가장 최근 undo 프레임을 복원하며 활성 제스처가 있으면 먼저 취소한다.
    pub fn undo(&mut self) -> bool {
        if self.transaction.is_some() {
            self.cancel();
        }
        let Some(previous) = self.undo_stack.pop() else {
            return false;
        };
        self.redo_stack.push(self.snapshot());
        self.items = previous.to_vec();
        self.selected = None;
        self.trim_history();
        true
    }

    /// 가장 최근 redo 프레임을 복원하며 활성 제스처가 있으면 먼저 취소한다.
    pub fn redo(&mut self) -> bool {
        if self.transaction.is_some() {
            self.cancel();
        }
        let Some(next) = self.redo_stack.pop() else {
            return false;
        };
        self.undo_stack.push(self.snapshot());
        self.items = next.to_vec();
        self.selected = None;
        self.trim_history();
        true
    }

    /// 활성 트랜잭션이 없으면 자동 트랜잭션으로 작업을 실행한다.
    pub(crate) fn mutate<R>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let owns_transaction = self.transaction.is_none();
        if owns_transaction {
            self.begin()?;
        }
        match operation(self) {
            Ok(result) => {
                if owns_transaction {
                    self.commit();
                }
                Ok(result)
            }
            Err(error) => {
                if owns_transaction {
                    self.cancel();
                }
                Err(error)
            }
        }
    }

    /// 일반 이력 정리를 적용한다. 오래된 undo 프레임부터 제거한 뒤 redo 프레임을 제거한다.
    pub(crate) fn trim_history(&mut self) {
        let mut bytes = self
            .undo_stack
            .iter()
            .chain(&self.redo_stack)
            .map(|snapshot| snapshot_weight(snapshot, self.dialect))
            .sum::<usize>();
        while self.undo_stack.len() > self.config.history_limit || bytes > self.config.history_bytes
        {
            let old = if !self.undo_stack.is_empty() {
                self.undo_stack.remove(0)
            } else if !self.redo_stack.is_empty() {
                self.redo_stack.remove(0)
            } else {
                break;
            };
            bytes = bytes.saturating_sub(snapshot_weight(&old, self.dialect));
        }
        self.retained_history_bytes = bytes;
    }

    pub(crate) fn document_limits(&self) -> DrawingDocumentLimits {
        DrawingDocumentLimits {
            max_drawings: self.config.max_drawings,
            max_points: self.config.max_points,
            max_document_chars: self.config.max_document_chars,
        }
    }
}

fn validate_config(config: DrawingStoreConfig) -> Result<(), JsError> {
    if !(1..=10_000).contains(&config.history_limit) {
        return Err(range_error("History limit 1..10000"));
    }
    for (value, max, label) in [
        (config.max_drawings, 10_000, "maxDrawings"),
        (config.max_points, 2_097_152, "maxPoints"),
        (
            config.max_document_chars,
            RESOURCE_LIMITS.max_document_chars as usize,
            "maxDocumentChars",
        ),
        (
            config.history_bytes,
            RESOURCE_LIMITS.max_history_bytes as usize,
            "historyBytes",
        ),
    ] {
        if value > max {
            return Err(range_error(&format!("{label}: limit {max}")));
        }
    }
    Ok(())
}

fn config_option(
    options: &JsObject,
    field: &str,
    default: u64,
    maximum: u64,
) -> Result<u64, JsError> {
    let Some(value) = options.get(&key(field)) else {
        return Ok(default);
    };
    if matches!(value, JsValue::Undefined) {
        return Ok(default);
    }
    Ok(size_limit(value, maximum, field)? as u64)
}

fn same_frame_identity(previous: &[Arc<Drawing>], current: &[Arc<Drawing>]) -> bool {
    previous.len() == current.len()
        && previous
            .iter()
            .zip(current)
            .all(|(left, right)| Arc::ptr_eq(left, right))
}

fn snapshot_weight(snapshot: &[Arc<Drawing>], dialect: NumberDialect) -> usize {
    snapshot
        .iter()
        .fold(snapshot.len().saturating_mul(8), |sum, drawing| {
            sum.saturating_add(
                2usize.saturating_mul(utf16_len(&stringify(&drawing.to_value(), dialect))),
            )
        })
}

fn stringify(value: &JsValue, dialect: NumberDialect) -> Vec<u8> {
    barochart_js::json::stringify_json_with(value, barochart_js::json::JsonMode::Standard, dialect)
}

fn utf16_len(bytes: &[u8]) -> usize {
    std::str::from_utf8(bytes)
        .expect("JSON writer emits valid UTF-8")
        .encode_utf16()
        .count()
}

fn js_falsy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => true,
        JsValue::Number(value) => *value == 0.0 || value.is_nan(),
        JsValue::String(value) => value.as_units().is_empty(),
        JsValue::Bool(true) | JsValue::Array(_) | JsValue::Object(_) => false,
    }
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
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

#[cfg(test)]
mod internal_tests {
    use super::{DrawingStore, NumberDialect};
    use barochart_js::json::{JsonMode, parse_json};
    use barochart_js::string::JsString;

    #[test]
    fn trim_removes_oldest_undo_before_the_oldest_redo_frame() {
        let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
        for id in ["a", "b"] {
            let input = format!(
                r#"{{"id":"{id}","type":"horizontal","panel":"price","points":[{{"time":1,"price":1}}]}}"#
            );
            store
                .add(&parse_json(input.as_bytes(), JsonMode::Standard).unwrap())
                .unwrap();
        }
        assert!(!store.undo_stack().is_empty());
        store.config.history_bytes = 0;
        assert!(store.undo());
        assert_eq!(store.items().len(), 1);
        assert_eq!(store.items()[0].id, JsString::from_str("a"));
        assert!(store.undo_stack().is_empty());
        assert!(store.redo_stack().is_empty());
        assert_eq!(store.retained_history_bytes(), 0);
        assert!(!store.redo());
    }
}
