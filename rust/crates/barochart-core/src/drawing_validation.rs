//! 드로잉 레코드·앵커·스타일·문서 버전을 검증한다.

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_with, stringify_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{
    DRAWING_ANCHOR_KEYS, DRAWING_STYLE_KEYS, bounded_text, option_record, portable_font,
};
use crate::drawing_types::{Drawing, DrawingPoint, DrawingStyle, DrawingType};
use crate::position_drawing::{
    drawing_document_version, position_metrics_for_parts, validate_drawing_document_version,
};

/// JS 원본 순서대로 나열한 지원 드로잉 종류 문자열이다.
pub const DRAWING_TYPES: &[&str] = &[
    "trendline",
    "horizontal",
    "fibonacci",
    "rectangle",
    "ellipse",
    "text",
    "ray",
    "extendedline",
    "channel",
    "fibextension",
    "fibfan",
    "fibtimezones",
    "freehand",
    "measurement",
    "longposition",
    "shortposition",
];

/// 드로잉 종류에 필요한 앵커 수를 반환한다.
pub fn drawing_point_count(kind: DrawingType) -> usize {
    if kind.is_position() {
        4
    } else {
        match kind {
            DrawingType::Horizontal | DrawingType::Text => 1,
            DrawingType::Channel | DrawingType::FibExtension => 3,
            _ => 2,
        }
    }
}

/// 드로잉 객체를 변경하지 않고 검증한다.
pub fn validate_drawing(value: &JsValue) -> Result<Drawing, JsError> {
    option_record(
        value,
        &[
            "id", "type", "panel", "points", "style", "text", "locked", "visible", "axisId",
            "seriesId",
        ],
        "Drawing",
    )?;
    let record = object(value).ok_or_else(|| type_error("Drawing: object required"))?;
    let id = identifier_field(record, "id", "Drawing id")?;
    let panel = identifier_field(record, "panel", "Drawing panel")?;
    let axis_id = optional_identifier_field(record, "axisId", "Drawing axisId")?;
    let series_id = optional_identifier_field(record, "seriesId", "Drawing seriesId")?;

    let type_value = record.get(&key("type"));
    let Some(JsValue::String(type_text)) = type_value else {
        return Err(type_error("Drawing type"));
    };
    let Some(kind) = DrawingType::parse(type_text) else {
        return Err(type_error("Drawing type"));
    };

    let points_value = record.get(&key("points"));
    let Some(JsValue::Array(point_values)) = points_value else {
        return Err(type_error("Drawing anchors"));
    };
    let point_count = point_values.len();
    if if kind == DrawingType::Freehand {
        !(2..=2048).contains(&point_count)
    } else {
        point_count != drawing_point_count(kind)
    } {
        return Err(type_error("Drawing anchors"));
    }

    let mut points = Vec::with_capacity(point_count);
    for point in point_values {
        option_record(point, DRAWING_ANCHOR_KEYS, "Anchor")?;
        let anchor = object(point).ok_or_else(|| type_error("Anchor: object required"))?;
        let Some(time) = number(anchor.get(&key("time"))) else {
            return Err(type_error(
                "Anchor time/price must be finite and within Date range",
            ));
        };
        if !time.is_finite() || time.abs() > 8_640_000_000_000_000.0 {
            return Err(type_error(
                "Anchor time/price must be finite and within Date range",
            ));
        }
        let Some(price) = number(anchor.get(&key("price"))) else {
            return Err(type_error(
                "Anchor time/price must be finite and within Date range",
            ));
        };
        if !price.is_finite() {
            return Err(type_error(
                "Anchor time/price must be finite and within Date range",
            ));
        }
        points.push(DrawingPoint { time, price });
    }
    if kind.is_position() {
        position_metrics_for_parts(kind, &points)?;
    }

    let visible = match record.get(&key("visible")) {
        None | Some(JsValue::Undefined) => None,
        Some(JsValue::Bool(value)) => Some(*value),
        Some(_) => return Err(type_error("Drawing visible must be boolean")),
    };
    let text = match record.get(&key("text")) {
        None | Some(JsValue::Undefined) => None,
        Some(value) => Some(bounded_text(value, 2000, "Drawing text", true)?.clone()),
    };
    let locked = match record.get(&key("locked")) {
        None | Some(JsValue::Undefined) => None,
        Some(JsValue::Bool(value)) => Some(*value),
        Some(_) => return Err(type_error("Locked must be boolean")),
    };
    let style = match record.get(&key("style")) {
        None | Some(JsValue::Undefined) => None,
        Some(value) => Some(Arc::new(validate_style(value)?)),
    };

    Ok(Drawing {
        id,
        panel,
        locked,
        style,
        kind,
        points: Arc::from(points),
        text,
        visible,
        axis_id,
        series_id,
    })
}

/// JSON 복사 규칙을 적용하고 null 바인딩을 생략한 뒤 정규 타입 필드를 만든다.
pub fn canonical_drawing(value: &JsValue, dialect: NumberDialect) -> Result<Drawing, JsError> {
    let copy = copy_drawing_value(value, dialect)?;
    let canonical = canonicalize_drawing_value(&copy)?;
    validate_drawing(&canonical)
}

/// 과거의 null 바인딩 치환 규칙을 포함해 JSON 방식으로 드로잉을 복사한다.
pub fn copy_drawing_value(value: &JsValue, dialect: NumberDialect) -> Result<JsValue, JsError> {
    let mut copy = json_copy(value, dialect)?;
    if let JsValue::Object(record) = &mut copy {
        for field in ["axisId", "seriesId"] {
            if matches!(record.get(&key(field)), Some(JsValue::Null)) {
                record.remove(&key(field));
            }
        }
    }
    Ok(copy)
}

/// JSON을 다시 복사하지 않고 레코드·스타일·앵커의 정규 키 순서를 만든다.
pub fn canonicalize_drawing_value(value: &JsValue) -> Result<JsValue, JsError> {
    let record = object(value).ok_or_else(|| type_error("Object required"))?;
    let ordered = crate::contracts::ordered_record(value, crate::contracts::DRAWING_RECORD_KEYS)?;
    let mut output = match &ordered {
        JsValue::Object(record) => record.clone(),
        _ => unreachable!("ordered_record returns an object"),
    };
    if let Some(JsValue::Array(points)) = record.get(&key("points")) {
        let mut ordered_points = Vec::with_capacity(points.len());
        for point in points {
            ordered_points.push(crate::contracts::ordered_record(
                point,
                DRAWING_ANCHOR_KEYS,
            )?);
        }
        output.insert(key("points"), JsValue::Array(ordered_points));
    }
    if let Some(style) = record.get(&key("style"))
        && matches!(style, JsValue::Object(_))
    {
        output.insert(
            key("style"),
            crate::contracts::ordered_record(style, DRAWING_STYLE_KEYS)?,
        );
    }
    Ok(JsValue::Object(output))
}

/// 레코드·스타일·앵커를 정규 키 순서로 구성한 드로잉 값을 만든다.
pub fn canonical_drawing_value(drawing: &Drawing) -> JsValue {
    drawing.to_value()
}

/// 이 드로잉 값에 필요한 최소 문서 버전을 반환한다.
pub fn document_version(drawings: &[Arc<Drawing>]) -> u8 {
    drawing_document_version(drawings)
}

/// 드로잉 하나의 문서 버전 요구사항을 확인한다.
pub fn validate_document_version(drawing: &Drawing, version: f64) -> Result<(), JsError> {
    validate_drawing_document_version(drawing, version)
}

/// JS JSON 복사 경계와 같도록 한 번 직렬화한 뒤 파싱한다.
pub fn json_copy(value: &JsValue, dialect: NumberDialect) -> Result<JsValue, JsError> {
    let text = stringify_json_with(value, JsonMode::Standard, dialect);
    parse_json_with(&text, JsonMode::Standard, dialect)
}

fn validate_style(value: &JsValue) -> Result<DrawingStyle, JsError> {
    option_record(value, DRAWING_STYLE_KEYS, "Drawing style")?;
    let style = object(value).ok_or_else(|| type_error("Drawing style: object required"))?;
    let width = match style.get(&key("width")) {
        None | Some(JsValue::Undefined) => None,
        Some(JsValue::Number(width)) if width.is_finite() && (0.1..=50.0).contains(width) => {
            Some(*width)
        }
        Some(_) => return Err(range_error("Stroke width")),
    };
    let color = optional_bounded_style_text(style, "color")?;
    let fill = optional_bounded_style_text(style, "fill")?;
    let font = match style.get(&key("font")) {
        None | Some(JsValue::Undefined) => None,
        Some(value) => {
            portable_font(value)?;
            Some(bounded_text(value, 256, "Font", false)?.clone())
        }
    };
    Ok(DrawingStyle {
        color,
        width,
        fill,
        font,
    })
}

fn optional_bounded_style_text(style: &JsObject, field: &str) -> Result<Option<JsString>, JsError> {
    match style.get(&key(field)) {
        None | Some(JsValue::Undefined) => Ok(None),
        Some(value) => Ok(Some(bounded_text(value, 128, "Color", false)?.clone())),
    }
}

fn identifier_field(record: &JsObject, field: &str, label: &str) -> Result<JsString, JsError> {
    let undefined = JsValue::Undefined;
    let value = record.get(&key(field)).unwrap_or(&undefined);
    Ok(crate::contracts::identifier(value, label)?.clone())
}

fn optional_identifier_field(
    record: &JsObject,
    field: &str,
    label: &str,
) -> Result<Option<JsString>, JsError> {
    match record.get(&key(field)) {
        None | Some(JsValue::Undefined) | Some(JsValue::Null) => Ok(None),
        Some(value) => Ok(Some(crate::contracts::identifier(value, label)?.clone())),
    }
}

fn number(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Number(value)) => Some(*value),
        _ => None,
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

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
