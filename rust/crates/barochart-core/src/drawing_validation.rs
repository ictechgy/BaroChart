//! 드로잉 레코드·앵커·스타일·문서 버전을 검증한다.

use std::mem::size_of;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{
    JsObject, JsValue, JsonFailure, JsonMode, parse_json_scoped, stringify_json_scoped,
};
use barochart_js::memory::{MemoryContext, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{
    DRAWING_ANCHOR_KEYS, DRAWING_RECORD_KEYS, DRAWING_STYLE_KEYS, bounded_text, portable_font,
};
use crate::drawing_types::{
    Drawing, DrawingParts, DrawingPoint, DrawingPoints, DrawingStyle, DrawingType,
};
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

/// 드로잉 객체를 비회계 테스트 context에서 검증한다.
pub fn validate_drawing(value: &JsValue) -> Result<Drawing, JsError> {
    validate_drawing_with_memory(
        value,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

/// 드로잉 객체를 검증하고 points/style/metadata를 지정 엔진 account에 소유시킨다.
pub fn validate_drawing_with_memory(
    value: &JsValue,
    memory: &MemoryContext,
) -> Result<Drawing, JsError> {
    let mut validation_scope = memory.scope();
    option_record_scoped(value, DRAWING_RECORD_KEYS, "Drawing", &mut validation_scope)?;
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

    let (mut points, points_memory) = memory.try_vec_capacity(point_count).map_err(memory_error)?;
    for point in point_values {
        option_record_scoped(point, DRAWING_ANCHOR_KEYS, "Anchor", &mut validation_scope)?;
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
        Some(value) => Some(bounded_text(value, 2000, "Drawing text", true)?),
    };
    let locked = match record.get(&key("locked")) {
        None | Some(JsValue::Undefined) => None,
        Some(JsValue::Bool(value)) => Some(*value),
        Some(_) => return Err(type_error("Locked must be boolean")),
    };
    let style = match record.get(&key("style")) {
        None | Some(JsValue::Undefined) => None,
        Some(value) => {
            let style = validate_style_borrowed(value, &mut validation_scope)?;
            Some(Arc::new(DrawingStyle::try_from_borrowed(
                style.color,
                style.width,
                style.fill,
                style.font,
                memory,
            )?))
        }
    };
    let points = DrawingPoints::try_from_vec(points, points_memory)?;

    Drawing::try_from_parts(
        DrawingParts {
            id,
            panel,
            locked,
            style,
            kind,
            points,
            text,
            visible,
            axis_id,
            series_id,
        },
        memory,
    )
}

/// JSON 복사와 정규 키 순서를 scoped temporary로 처리해 account 소유 드로잉을 만든다.
pub fn canonical_drawing_with_memory(
    value: &JsValue,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<Drawing, JsError> {
    let mut scope = memory.scope();
    canonical_drawing_scoped(value, dialect, memory, &mut scope)
}

/// 호출자가 보유한 scope를 써서 정규화하고 persistent drawing lease만 분리한다.
pub fn canonical_drawing_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<Drawing, JsError> {
    let copy = copy_drawing_value_scoped(value, dialect, scope)?;
    let canonical = canonicalize_drawing_value_scoped(&copy, scope)?;
    validate_drawing_with_memory(&canonical, memory)
}

/// 기존 테스트와 비회계 도구가 쓰는 정규 드로잉 wrapper다.
pub fn canonical_drawing(value: &JsValue, dialect: NumberDialect) -> Result<Drawing, JsError> {
    canonical_drawing_with_memory(
        value,
        dialect,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

/// 과거의 null 바인딩 치환 규칙을 scoped JSON 복제로 적용한다.
pub fn copy_drawing_value_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut copy = json_copy_scoped(value, dialect, scope)?;
    if let JsValue::Object(record) = &mut copy {
        for field in ["axisId", "seriesId"] {
            if matches!(record.get(&key(field)), Some(JsValue::Null)) {
                record.remove(&key(field));
            }
        }
    }
    Ok(copy)
}

/// 기존 테스트와 비회계 도구가 쓰는 JSON 복사 wrapper다.
pub fn copy_drawing_value(value: &JsValue, dialect: NumberDialect) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    copy_drawing_value_scoped(value, dialect, &mut scope)
}

/// JSON을 다시 복사하지 않고 레코드·스타일·앵커의 정규 키 순서를 fallible 구성한다.
pub fn canonicalize_drawing_value_scoped(
    value: &JsValue,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let record = object(value).ok_or_else(|| type_error("Object required"))?;
    let mut entries = scoped_entries(record.len(), scope)?;
    let mut point_source = None;
    let mut points_lookup = None;
    for field in DRAWING_RECORD_KEYS {
        let name = key(field);
        let Some(source) = record.get(&name) else {
            continue;
        };
        let key = JsString::try_from_str(field, scope).map_err(memory_error)?;
        let value = if *field == "points" && matches!(source, JsValue::Array(_)) {
            let JsValue::Array(points) = source else {
                unreachable!()
            };
            point_source = Some(points.as_slice());
            points_lookup = Some(key.try_clone_scoped(scope).map_err(memory_error)?);
            JsValue::Undefined
        } else if *field == "style" && matches!(source, JsValue::Object(_)) {
            ordered_record_scoped(source, DRAWING_STYLE_KEYS, scope)?
        } else {
            source.try_clone_scoped(scope).map_err(memory_error)?
        };
        entries.push((key, value));
    }
    let mut remaining = scoped_keys(record.len().saturating_sub(entries.len()), scope)?;
    for (name, _) in record.iter() {
        if !DRAWING_RECORD_KEYS
            .iter()
            .any(|field| field.encode_utf16().eq(name.as_units().iter().copied()))
        {
            remaining.push(name.try_clone_scoped(scope).map_err(memory_error)?);
        }
    }
    remaining.sort_unstable();
    for name in remaining {
        let value = record
            .get(&name)
            .expect("remaining drawing key comes from the record")
            .try_clone_scoped(scope)
            .map_err(memory_error)?;
        entries.push((name, value));
    }
    // 큰 points DOM을 만들기 전에 outer record allocation을 끝낸다.
    let mut output = JsObject::try_from_entries_scoped(entries, scope).map_err(memory_error)?;
    if let Some(points) = point_source {
        let mut ordered_points = scoped_values(points.len(), scope)?;
        for point in points {
            ordered_points.push(ordered_record_scoped(point, DRAWING_ANCHOR_KEYS, scope)?);
        }
        *output
            .get_mut(
                points_lookup
                    .as_ref()
                    .expect("points placeholder key exists"),
            )
            .expect("points placeholder exists") = JsValue::Array(ordered_points);
    }
    Ok(JsValue::Object(output))
}

/// 기존 테스트와 비회계 도구가 쓰는 정규화 wrapper다.
pub fn canonicalize_drawing_value(value: &JsValue) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    canonicalize_drawing_value_scoped(value, &mut scope)
}

/// 레코드·스타일·앵커를 정규 키 순서로 fallible 구성한 값을 만든다.
pub fn canonical_drawing_value_scoped(
    drawing: &Drawing,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    drawing.to_value_scoped(scope)
}

/// 기존 테스트와 비회계 도구가 쓰는 정규 값 wrapper다.
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

/// JSON stringify/parse 복사를 caller scope 안에서 fallible 수행한다.
pub fn json_copy_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let text =
        stringify_json_scoped(value, JsonMode::Standard, dialect, scope).map_err(memory_error)?;
    parse_json_scoped(&text, JsonMode::Standard, dialect, scope).map_err(json_failure)
}

/// 기존 테스트와 비회계 도구가 쓰는 JSON 복사 wrapper다.
pub fn json_copy(value: &JsValue, dialect: NumberDialect) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    json_copy_scoped(value, dialect, &mut scope)
}

struct BorrowedStyle<'a> {
    color: Option<&'a JsString>,
    width: Option<f64>,
    fill: Option<&'a JsString>,
    font: Option<&'a JsString>,
}

fn validate_style_borrowed<'a>(
    value: &'a JsValue,
    scope: &mut MemoryScope,
) -> Result<BorrowedStyle<'a>, JsError> {
    option_record_scoped(value, DRAWING_STYLE_KEYS, "Drawing style", scope)?;
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
            Some(bounded_text(value, 256, "Font", false)?)
        }
    };
    Ok(BorrowedStyle {
        color,
        width,
        fill,
        font,
    })
}

fn ordered_record_scoped(
    value: &JsValue,
    keys: &[&str],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let source = object(value).ok_or_else(|| type_error("Object required"))?;
    let mut entries = scoped_entries(source.len(), scope)?;
    for field in keys {
        let Some(value) = source.get(&key(field)) else {
            continue;
        };
        entries.push((
            JsString::try_from_str(field, scope).map_err(memory_error)?,
            value.try_clone_scoped(scope).map_err(memory_error)?,
        ));
    }
    let mut remaining = scoped_keys(source.len().saturating_sub(entries.len()), scope)?;
    for (name, _) in source.iter() {
        if !keys
            .iter()
            .any(|field| field.encode_utf16().eq(name.as_units().iter().copied()))
        {
            remaining.push(name.try_clone_scoped(scope).map_err(memory_error)?);
        }
    }
    remaining.sort_unstable();
    for name in remaining {
        let value = source
            .get(&name)
            .expect("remaining ordered key comes from the record")
            .try_clone_scoped(scope)
            .map_err(memory_error)?;
        entries.push((name, value));
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

fn scoped_entries(
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<(JsString, JsValue)>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<(JsString, JsValue)>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

fn scoped_values(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<JsValue>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<JsValue>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

fn scoped_keys(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<JsString>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<JsString>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

/// 드로잉 계열 레코드의 허용 키를 allocation 없이 검사하고 오류 문자열만 scope에서 만든다.
pub(crate) fn option_record_scoped(
    value: &JsValue,
    allowed: &[&str],
    label: &str,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let Some(record) = object(value) else {
        return Err(type_error(&format!("{label}: object required")));
    };
    let offending = record
        .iter()
        .map(|(name, _)| name)
        .filter(|name| {
            is_reserved(name)
                || !allowed
                    .iter()
                    .any(|field| field.encode_utf16().eq(name.as_units().iter().copied()))
        })
        .min();
    let Some(offending) = offending else {
        return Ok(());
    };
    let prefix = format!("{label}: unsupported field ");
    let field_units = std::cmp::min(offending.as_units().len(), 64);
    let length = prefix
        .encode_utf16()
        .count()
        .checked_add(field_units)
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    let bytes = length
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut units = Vec::new();
    units
        .try_reserve_exact(length)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    units.extend(prefix.encode_utf16());
    units.extend_from_slice(&offending.as_units()[..field_units]);
    Err(JsError::new("TypeError", JsString::from_utf16(units)))
}

fn is_reserved(value: &JsString) -> bool {
    ["__proto__", "constructor", "prototype"]
        .iter()
        .any(|name| name.encode_utf16().eq(value.as_units().iter().copied()))
}

fn optional_bounded_style_text<'a>(
    style: &'a JsObject,
    field: &str,
) -> Result<Option<&'a JsString>, JsError> {
    match style.get(&key(field)) {
        None | Some(JsValue::Undefined) => Ok(None),
        Some(value) => Ok(Some(bounded_text(value, 128, "Color", false)?)),
    }
}

fn identifier_field<'a>(
    record: &'a JsObject,
    field: &str,
    label: &str,
) -> Result<&'a JsString, JsError> {
    let Some(value) = record.get(&key(field)) else {
        return Err(type_error(&format!("{label}: string limit 128")));
    };
    crate::contracts::identifier(value, label)
}

fn optional_identifier_field<'a>(
    record: &'a JsObject,
    field: &str,
    label: &str,
) -> Result<Option<&'a JsString>, JsError> {
    match record.get(&key(field)) {
        None | Some(JsValue::Undefined) | Some(JsValue::Null) => Ok(None),
        Some(value) => Ok(Some(crate::contracts::identifier(value, label)?)),
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

fn json_failure(failure: JsonFailure) -> JsError {
    match failure {
        JsonFailure::Syntax(error) => error,
        JsonFailure::Memory(failure) => failure.into_js_error(),
    }
}

fn memory_error(failure: barochart_js::memory::MemoryFailure) -> JsError {
    failure.into_js_error()
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
