//! WTF-16 portable label metrics, fitting, command assembly, and panel titles.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::{JsString, is_js_whitespace};

use crate::contracts::js_to_string_with;

/// Conservative portable text dimensions, not a native glyph measurement.
#[derive(Clone, Copy, Debug)]
pub struct LabelMetrics {
    /// Parsed font size.
    pub size: f64,
    /// Portable ascent estimate.
    pub ascent: f64,
    /// Portable descent estimate.
    pub descent: f64,
    /// Portable line-height estimate.
    pub height: f64,
}

impl LabelMetrics {
    /// Metrics in the source field order.
    pub fn to_value(self) -> JsValue {
        object([
            ("size", JsValue::Number(self.size)),
            ("ascent", JsValue::Number(self.ascent)),
            ("descent", JsValue::Number(self.descent)),
            ("height", JsValue::Number(self.height)),
        ])
    }
}

/// Fitted label text plus its original full text and portable width.
#[derive(Clone, Debug)]
pub struct LabelFit {
    /// Single-line text, possibly shortened with an ellipsis.
    pub text: JsString,
    /// Full single-line text before truncation.
    pub full_text: JsString,
    /// Width used by the layout bounds.
    pub width: f64,
}

/// Text command arguments passed from the renderer/model boundary.
pub struct LabelCommandInput<'a> {
    /// Value coerced to the visible/full text strings.
    pub value: &'a JsValue,
    /// Command X coordinate.
    pub x: f64,
    /// Command Y coordinate.
    pub y: f64,
    /// Maximum visible text width.
    pub max_width: f64,
    /// Original renderer font value retained in the command.
    pub font: &'a JsValue,
    /// Command color value.
    pub color: &'a JsValue,
    /// Command clip value.
    pub clip: &'a JsValue,
    /// Optional final object spread.
    pub metadata: Option<&'a JsValue>,
}

impl LabelFit {
    /// Fit metadata in the source field order.
    pub fn to_value(&self) -> JsValue {
        object([
            ("text", JsValue::String(self.text.clone())),
            ("fullText", JsValue::String(self.full_text.clone())),
            ("width", JsValue::Number(self.width)),
        ])
    }
}

/// Label width model used by the renderer-independent layout.
pub fn label_metrics(font: &JsValue, dialect: NumberDialect) -> Result<LabelMetrics, JsError> {
    let font = js_to_string_with(font, dialect)?;
    let size = regex_font_size(&font, dialect)?;
    Ok(LabelMetrics {
        size,
        ascent: size * 1.12,
        descent: size * 0.38,
        height: size * 1.5,
    })
}

/// Estimates width by source `for...of` code-point iteration over a WTF-16 string.
pub fn label_width(value: &JsString, metrics: LabelMetrics) -> f64 {
    let units = value.as_units();
    let mut cursor = 0usize;
    let mut total = 0.0;
    while cursor < units.len() {
        let first = units[cursor];
        let (code, width) = if (0xD800..=0xDBFF).contains(&first)
            && units
                .get(cursor + 1)
                .is_some_and(|next| (0xDC00..=0xDFFF).contains(next))
        {
            let second = units[cursor + 1];
            let code = 0x10000 + ((u32::from(first) - 0xD800) << 10) + (u32::from(second) - 0xDC00);
            cursor += 2;
            (code, 1.2)
        } else {
            cursor += 1;
            let width = if first > 0x7F {
                1.2
            } else if matches!(first, 0x4D | 0x57 | 0x40 | 0x25) {
                0.98
            } else {
                0.74
            };
            (u32::from(first), width)
        };
        let _ = code;
        total += width;
    }
    total * metrics.size
}

/// Coerces and fits a label, replacing ECMAScript `\s` characters with spaces.
pub fn fit_label(
    value: &JsValue,
    max_width: f64,
    metrics: LabelMetrics,
    dialect: NumberDialect,
) -> Result<Option<LabelFit>, JsError> {
    let full_text = js_to_string_with(value, dialect)?;
    let single_line = collapse_js_whitespace(&full_text);
    if max_width <= 0.0 || max_width.is_nan() {
        return Ok(None);
    }
    let full_width = label_width(&single_line, metrics);
    if full_width <= max_width {
        return Ok(Some(LabelFit {
            text: single_line.clone(),
            full_text,
            width: full_width,
        }));
    }
    let ellipsis = JsString::from_str("…");
    let ellipsis_width = label_width(&ellipsis, metrics);
    if ellipsis_width > max_width {
        return Ok(None);
    }
    let mut text = Vec::new();
    let mut width = 0.0;
    for (character, _) in js_characters(&single_line) {
        let next_width = label_width(&character, metrics);
        if width + next_width + ellipsis_width > max_width {
            break;
        }
        text.extend_from_slice(character.as_units());
        width += next_width;
    }
    text.extend_from_slice(ellipsis.as_units());
    Ok(Some(LabelFit {
        text: JsString::from_utf16(text),
        full_text,
        width: width + ellipsis_width,
    }))
}

/// Creates a text scene command; metadata spread last may override command fields.
pub fn label_command(
    input: LabelCommandInput<'_>,
    dialect: NumberDialect,
) -> Result<JsValue, JsError> {
    let metrics = label_metrics(input.font, dialect)?;
    let Some(fit) = fit_label(input.value, input.max_width, metrics, dialect)? else {
        return Ok(JsValue::Null);
    };
    let mut command = JsObject::new();
    command.insert(key("op"), JsValue::String(key("text")));
    command.insert(key("x"), JsValue::Number(input.x));
    command.insert(key("y"), JsValue::Number(input.y));
    command.insert(key("text"), JsValue::String(fit.text));
    command.insert(key("fullText"), JsValue::String(fit.full_text));
    command.insert(key("font"), input.font.clone());
    command.insert(key("color"), input.color.clone());
    command.insert(key("clip"), input.clip.clone());
    command.insert(
        key("labelBounds"),
        JsValue::Array(vec![
            JsValue::Number(input.x),
            JsValue::Number(input.y - metrics.ascent),
            JsValue::Number(fit.width),
            JsValue::Number(metrics.height),
        ]),
    );
    if let Some(metadata) = input.metadata {
        spread_properties(&mut command, metadata);
    }
    Ok(JsValue::Object(command))
}

/// Builds a panel title, preserving source filtering, nullish fallback, Set order, and join behavior.
pub fn panel_title(
    panel: &JsValue,
    series: &[JsValue],
    dialect: NumberDialect,
) -> Result<JsString, JsError> {
    let panel_record = as_object(panel).ok_or_else(|| type_error("Panel title object required"))?;
    let undefined = JsValue::Undefined;
    let panel_id = panel_record.get(&key("id")).unwrap_or(&undefined);
    let panel_label = panel_record.get(&key("label"));
    let title = panel_label
        .filter(|value| !matches!(value, JsValue::Undefined | JsValue::Null))
        .unwrap_or(panel_id);
    let mut parts = vec![join_element(title, dialect)?];
    let mut unique = Vec::<JsValue>::new();
    for series_value in series {
        let row = as_object(series_value)
            .ok_or_else(|| type_error("Panel title series object required"))?;
        if !strict_equal(row.get(&key("panel")), Some(panel_id))
            || matches!(row.get(&key("visible")), Some(JsValue::Bool(false)))
        {
            continue;
        }
        let candidate = row
            .get(&key("label"))
            .filter(|value| !matches!(value, JsValue::Undefined | JsValue::Null))
            .or_else(|| row.get(&key("indicator")));
        let Some(candidate) = candidate else {
            continue;
        };
        if !js_truthy(candidate) || unique.iter().any(|value| same_value_zero(value, candidate)) {
            continue;
        }
        unique.push(candidate.clone());
        parts.push(join_element(candidate, dialect)?);
    }
    let separator = JsString::from_str(" · ");
    let mut output = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            output.extend_from_slice(separator.as_units());
        }
        output.extend_from_slice(part.as_units());
    }
    Ok(JsString::from_utf16(output))
}

fn regex_font_size(font: &JsString, dialect: NumberDialect) -> Result<f64, JsError> {
    let units = font.as_units();
    let mut start = 0usize;
    while start < units.len() {
        if !font_regex_unit(units[start]) {
            start += 1;
            continue;
        }
        let token_start = start;
        while start < units.len() && font_regex_unit(units[start]) {
            start += 1;
        }
        if units.get(start..start + 2) == Some(&[b'p' as u16, b'x' as u16]) {
            return Ok(parse_number_capture(&units[token_start..start], dialect));
        }
    }
    Ok(12.0)
}

fn font_regex_unit(unit: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&unit) || unit == b'.' as u16
}

/// Reuses the JS JSON number parser for the restricted `[0-9.]+` regex capture.
///
/// The normalization only makes that capture valid JSON number grammar: leading zeroes are
/// removed and leading/trailing decimal points receive a zero. Other captures map to JS NaN.
fn parse_number_capture(capture: &[u16], dialect: NumberDialect) -> f64 {
    let dots = capture
        .iter()
        .enumerate()
        .filter_map(|(index, unit)| (*unit == b'.' as u16).then_some(index))
        .collect::<Vec<_>>();
    if dots.len() > 1 {
        return f64::NAN;
    }
    let (integer, fraction) = if let Some(dot) = dots.first().copied() {
        (&capture[..dot], Some(&capture[dot + 1..]))
    } else {
        (capture, None)
    };
    if !integer
        .iter()
        .chain(fraction.into_iter().flatten())
        .any(|unit| (b'0' as u16..=b'9' as u16).contains(unit))
    {
        return f64::NAN;
    }
    let significant_integer = integer
        .iter()
        .position(|unit| *unit != b'0' as u16)
        .map_or(&integer[integer.len().saturating_sub(1)..], |index| {
            &integer[index..]
        });
    let mut normalized = Vec::with_capacity(capture.len() + 2);
    if significant_integer.is_empty() {
        normalized.push(b'0' as u16);
    } else {
        normalized.extend_from_slice(significant_integer);
    }
    if let Some(fraction) = fraction {
        normalized.push(b'.' as u16);
        if fraction.is_empty() {
            normalized.push(b'0' as u16);
        } else {
            normalized.extend_from_slice(fraction);
        }
    }
    match parse_json_utf16_with(&normalized, JsonMode::Standard, dialect) {
        Ok(JsValue::Number(value)) => value,
        _ => f64::NAN,
    }
}

fn collapse_js_whitespace(value: &JsString) -> JsString {
    JsString::from_utf16(
        value
            .as_units()
            .iter()
            .map(|unit| {
                if is_js_whitespace(*unit) {
                    b' ' as u16
                } else {
                    *unit
                }
            })
            .collect(),
    )
}

fn js_characters(value: &JsString) -> Vec<(JsString, u32)> {
    let units = value.as_units();
    let mut output = Vec::with_capacity(units.len());
    let mut cursor = 0usize;
    while cursor < units.len() {
        let first = units[cursor];
        if (0xD800..=0xDBFF).contains(&first)
            && units
                .get(cursor + 1)
                .is_some_and(|next| (0xDC00..=0xDFFF).contains(next))
        {
            let second = units[cursor + 1];
            let code = 0x10000 + ((u32::from(first) - 0xD800) << 10) + (u32::from(second) - 0xDC00);
            output.push((JsString::from_utf16(vec![first, second]), code));
            cursor += 2;
        } else {
            output.push((JsString::from_utf16(vec![first]), u32::from(first)));
            cursor += 1;
        }
    }
    output
}

fn spread_properties(target: &mut JsObject, source: &JsValue) {
    match source {
        JsValue::Object(source) => {
            for (key, value) in source.iter() {
                target.insert(key.clone(), value.clone());
            }
        }
        JsValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                target.insert(JsString::from_str(&index.to_string()), value.clone());
            }
        }
        JsValue::String(value) => {
            for (index, unit) in value.as_units().iter().enumerate() {
                target.insert(
                    JsString::from_str(&index.to_string()),
                    JsValue::String(JsString::from_utf16(vec![*unit])),
                );
            }
        }
        JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => {}
    }
}

fn join_element(value: &JsValue, dialect: NumberDialect) -> Result<JsString, JsError> {
    match value {
        JsValue::Undefined | JsValue::Null => Ok(JsString::default()),
        _ => js_to_string_with(value, dialect),
    }
}

fn strict_equal(left: Option<&JsValue>, right: Option<&JsValue>) -> bool {
    let undefined = JsValue::Undefined;
    match (left.unwrap_or(&undefined), right.unwrap_or(&undefined)) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => {
            !left.is_nan() && !right.is_nan() && left == right
        }
        (JsValue::String(left), JsValue::String(right)) => left == right,
        _ => false,
    }
}

fn same_value_zero(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => {
            left.is_nan() && right.is_nan() || left == right
        }
        (JsValue::String(left), JsValue::String(right)) => left == right,
        _ => false,
    }
}

fn js_truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => false,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Bool(true) | JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

fn as_object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
}

fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in fields {
        object.insert(key(name), value);
    }
    JsValue::Object(object)
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
