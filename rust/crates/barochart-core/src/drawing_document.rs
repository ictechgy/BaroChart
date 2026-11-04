//! 버전 드로잉 문서를 원자적으로 검증하고 정규 JSON으로 저장·불러온다.

use std::collections::HashSet;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16_with, stringify_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{RESOURCE_LIMITS, assert_json_text_depth_with, bounded_text, option_record};
use crate::drawing_types::Drawing;
use crate::drawing_validation::{
    canonicalize_drawing_value, copy_drawing_value, validate_document_version, validate_drawing,
};
use crate::position_drawing::drawing_document_version;

/// 드로잉 문서 작업에 적용하는 한도다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawingDocumentLimits {
    /// 저장 문서에 넣을 수 있는 최대 드로잉 수다.
    pub max_drawings: usize,
    /// 저장 드로잉의 최대 전체 앵커 수다.
    pub max_points: usize,
    /// JSON 문자열의 최대 UTF-16 코드 단위 수다.
    pub max_document_chars: usize,
}

impl Default for DrawingDocumentLimits {
    fn default() -> Self {
        Self {
            max_drawings: RESOURCE_LIMITS.max_drawings as usize,
            max_points: RESOURCE_LIMITS.max_drawing_points as usize,
            max_document_chars: RESOURCE_LIMITS.max_document_chars as usize,
        }
    }
}

/// 문서가 참조하는 panel을 검사한다.
pub type DrawingPanelValidator<'a> = dyn Fn(&JsString) -> Result<bool, JsError> + 'a;
/// 문서의 drawing binding을 검사한다.
pub type DrawingBindingValidator<'a> = dyn Fn(&Drawing) -> Result<bool, JsError> + 'a;
/// 검증된 스타일을 대상 renderer 값으로 변환한다.
pub type DrawingStyleDecoder<'a> = dyn Fn(&JsValue) -> Result<JsValue, JsError> + 'a;

/// 모델에 불러올 때 쓰는 불변 작업별 호스트 검사기다.
///
/// M4/M5 어댑터가 패널·바인딩 조회와 이식 스타일 변환을 제공한다. 문서 리프는 이 참조를
/// 보관하지 않고 모델이나 컨트롤러에 직접 접근하지 않는다.
#[derive(Default)]
pub struct DrawingDocumentContext<'a> {
    /// 대상 차트에 패널이 있는지 확인한다.
    pub validate_panel: Option<&'a DrawingPanelValidator<'a>>,
    /// 선택적 축·시리즈 바인딩이 대상 차트와 일치하는지 확인한다.
    pub validate_binding: Option<&'a DrawingBindingValidator<'a>>,
    /// 구조 검증 뒤 대상 렌더러에 맞는 스타일로 변환한다.
    pub style_decoder: Option<&'a DrawingStyleDecoder<'a>>,
}

/// 최소 버전의 정규 문서 문자열을 만든다.
pub fn save_drawing_document(
    drawings: &[Arc<Drawing>],
    max_document_chars: usize,
    dialect: NumberDialect,
    transaction_active: bool,
) -> Result<JsString, JsError> {
    if transaction_active {
        return Err(error("Error", "Commit or cancel before saving"));
    }
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
    let bytes = stringify_json_with(&JsValue::Object(document), JsonMode::Standard, dialect);
    bounded_generated_text(&bytes, max_document_chars, "Drawing document")
}

/// 저장소 상태를 바꾸지 않고 전체 드로잉 문서를 검증·준비한다.
pub fn load_drawing_document(
    text: &JsString,
    limits: DrawingDocumentLimits,
    dialect: NumberDialect,
    context: &DrawingDocumentContext<'_>,
    transaction_active: bool,
) -> Result<Vec<Arc<Drawing>>, JsError> {
    let value = JsValue::String(text.clone());
    let text = bounded_text(&value, limits.max_document_chars, "Drawing document", true)?;
    let parsed_text = assert_json_text_depth_with(
        &JsValue::String(text.clone()),
        32,
        "Drawing document depth limit",
        dialect,
    )?;
    let document = parse_json_utf16_with(parsed_text.as_units(), JsonMode::Standard, dialect)?;
    option_record(
        &document,
        &["schema", "version", "drawings"],
        "Drawing document",
    )?;
    let record = object(&document).ok_or_else(|| type_error("Unsupported drawing document"))?;
    let version = match record.get(&key("version")) {
        Some(JsValue::Number(version)) if matches!(*version, 1.0 | 2.0 | 3.0 | 4.0) => *version,
        _ => return Err(type_error("Unsupported drawing document")),
    };
    let schema = record.get(&key("schema"));
    let drawings_value = record.get(&key("drawings"));
    let undefined = JsValue::Undefined;
    let JsValue::Array(raw_drawings) = drawings_value.unwrap_or(&undefined) else {
        return Err(type_error("Unsupported drawing document"));
    };
    if !matches!(schema, Some(JsValue::String(value)) if value == &JsString::from_str("aster.drawings"))
        || raw_drawings.len() > limits.max_drawings
    {
        return Err(type_error("Unsupported drawing document"));
    }

    let mut drawings = Vec::with_capacity(raw_drawings.len());
    for raw in raw_drawings {
        let drawing = validate_drawing(raw)?;
        validate_document_version(&drawing, version)?;
        if let Some(validate) = context.validate_binding
            && !validate(&drawing)?
        {
            return Err(error("Error", "Invalid drawing binding"));
        }
        if let Some(validate) = context.validate_panel
            && !validate(&drawing.panel)?
        {
            return Err(error("Error", "Missing drawing panel"));
        }

        let mut copied = copy_drawing_value(raw, dialect)?;
        if let Some(decode) = context.style_decoder
            && let JsValue::Object(record) = &mut copied
            && let Some(style) = record.get(&key("style")).cloned()
        {
            record.insert(key("style"), decode(&style)?);
        }
        let canonical = canonicalize_drawing_value(&copied)?;
        drawings.push(Arc::new(validate_drawing(&canonical)?));
    }

    enforce_drawing_budget(&drawings, limits)?;
    let mut ids = HashSet::with_capacity(drawings.len());
    if drawings
        .iter()
        .any(|drawing| !ids.insert(drawing.id.clone()))
    {
        return Err(type_error("Duplicate drawing ids"));
    }
    if transaction_active {
        return Err(error("Error", "Cannot load during a gesture"));
    }
    save_drawing_document(&drawings, limits.max_document_chars, dialect, false)?;
    Ok(drawings)
}

/// 저장소의 공개 드로잉 수 및 앵커 예산 검사를 적용한다.
pub fn enforce_drawing_budget(
    drawings: &[Arc<Drawing>],
    limits: DrawingDocumentLimits,
) -> Result<(), JsError> {
    if drawings.len() > limits.max_drawings {
        return Err(range_error("Drawing count limit"));
    }
    let mut points = 0usize;
    let mut text = 0usize;
    for drawing in drawings {
        points = points.saturating_add(drawing.points.len());
        text = text.saturating_add(drawing.text_len_utf16());
    }
    if points > limits.max_points || text > 1_000_000 {
        return Err(range_error("Drawing points/text limit"));
    }
    Ok(())
}

fn bounded_generated_text(bytes: &[u8], max: usize, label: &str) -> Result<JsString, JsError> {
    let text = std::str::from_utf8(bytes).expect("JSON writer emits valid UTF-8");
    if text.encode_utf16().count() > max {
        return Err(type_error(&format!("{label}: string limit {max}")));
    }
    Ok(JsString::from_str(text))
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
