//! JS oracle `src/core/checkpoint-validation.mjs`와 같은 체크포인트 무손실 JSON 코덱이다.
//!
//! 러스트 브리지가 소유하는 `JsValue` 도메인만 처리한다. 이 값 모델에는 JS getter/prototype/symbol 속성,
//! 배열 구멍, 객체 순환 참조가 없다. 문자열과 키는 WTF-16으로 유지하고, 모든 순회 한도 검사 뒤 깊이가
//! 32 이하임을 확인한 후에만 표식을 재귀 변환한다.

use std::collections::HashSet;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16_with, stringify_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::{JsString, is_js_whitespace};

const MAX_TEXT_UNITS: usize = 8_388_608;
const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 250_000;
const NUMBER_MARKER: &str = "$asterNumber";

fn type_error(reason: &str) -> JsError {
    JsError::new(
        "TypeError",
        JsString::from_str(&format!("Checkpoint {reason}")),
    )
}

fn range_error(reason: &str) -> JsError {
    JsError::new(
        "RangeError",
        JsString::from_str(&format!("Checkpoint {reason}")),
    )
}

fn is_unicode_scalar_string(value: &JsString) -> bool {
    let mut index = 0;
    let units = value.as_units();
    while index < units.len() {
        match units[index] {
            0xd800..=0xdbff => {
                if index + 1 >= units.len() || !(0xdc00..=0xdfff).contains(&units[index + 1]) {
                    return false;
                }
                index += 2;
            }
            0xdc00..=0xdfff => return false,
            _ => index += 1,
        }
    }
    true
}

fn marker_value(value: &JsValue) -> Option<Result<f64, ()>> {
    let JsValue::Object(object) = value else {
        return None;
    };
    let marker_key = JsString::from_str(NUMBER_MARKER);
    let marker = object.get(&marker_key)?;
    if object.len() != 1 {
        return Some(Err(()));
    }
    let JsValue::String(marker) = marker else {
        return Some(Err(()));
    };
    Some(match marker.as_units() {
        units if units == "NaN".encode_utf16().collect::<Vec<_>>() => Ok(f64::NAN),
        units if units == "Infinity".encode_utf16().collect::<Vec<_>>() => Ok(f64::INFINITY),
        units if units == "-Infinity".encode_utf16().collect::<Vec<_>>() => Ok(f64::NEG_INFINITY),
        units if units == "-0".encode_utf16().collect::<Vec<_>>() => Ok(-0.0),
        _ => Err(()),
    })
}

fn validate_tree(root: &JsValue, decode: bool) -> Result<(), JsError> {
    let mut stack = vec![(root, 0usize)];
    let mut nodes = 0usize;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        if depth > MAX_DEPTH || nodes > MAX_NODES {
            return Err(range_error("state limit"));
        }
        match value {
            JsValue::Undefined => return Err(type_error("unsupported value")),
            JsValue::Null | JsValue::Bool(_) => {}
            JsValue::Number(number) => {
                if decode && !number.is_finite() {
                    return Err(type_error("untagged nonfinite number"));
                }
            }
            JsValue::String(text) => {
                if !is_unicode_scalar_string(text) {
                    return Err(type_error("Unicode scalar"));
                }
            }
            JsValue::Array(items) => {
                stack
                    .try_reserve(items.len())
                    .map_err(|_| type_error("unsupported value"))?;
                for item in items.iter().rev() {
                    stack.push((item, depth + 1));
                }
            }
            JsValue::Object(object) => {
                if decode && object.get(&JsString::from_str(NUMBER_MARKER)).is_some() {
                    if marker_value(value).is_none_or(|marker| marker.is_err()) {
                        return Err(type_error("number marker"));
                    }
                    continue;
                }
                let entries: Vec<_> = object.iter().collect();
                for (key, _) in &entries {
                    if !is_unicode_scalar_string(key) {
                        return Err(type_error("Unicode scalar"));
                    }
                }
                stack
                    .try_reserve(entries.len())
                    .map_err(|_| type_error("unsupported value"))?;
                for (_, child) in entries.into_iter().rev() {
                    stack.push((child, depth + 1));
                }
            }
        }
    }
    Ok(())
}

fn marker(number: f64) -> JsValue {
    let text = if number.is_nan() {
        "NaN"
    } else if number == f64::INFINITY {
        "Infinity"
    } else if number == f64::NEG_INFINITY {
        "-Infinity"
    } else {
        "-0"
    };
    let mut object = JsObject::new();
    object.insert(
        JsString::from_str(NUMBER_MARKER),
        JsValue::String(JsString::from_str(text)),
    );
    JsValue::Object(object)
}

fn encode_markers(value: &JsValue) -> JsValue {
    match value {
        JsValue::Number(number)
            if !number.is_finite() || *number == 0.0 && number.is_sign_negative() =>
        {
            marker(*number)
        }
        JsValue::Array(items) => JsValue::Array(items.iter().map(encode_markers).collect()),
        JsValue::Object(object) => {
            let mut encoded = JsObject::new();
            for (key, value) in object.iter() {
                encoded.insert(key.clone(), encode_markers(value));
            }
            JsValue::Object(encoded)
        }
        _ => value.clone(),
    }
}

fn decode_markers(value: &JsValue) -> JsValue {
    match value {
        JsValue::Object(_) => match marker_value(value) {
            Some(Ok(number)) => JsValue::Number(number),
            Some(Err(())) => unreachable!("validated checkpoint marker"),
            None => {
                let JsValue::Object(object) = value else {
                    unreachable!()
                };
                let mut decoded = JsObject::new();
                for (key, child) in object.iter() {
                    decoded.insert(key.clone(), decode_markers(child));
                }
                JsValue::Object(decoded)
            }
        },
        JsValue::Array(items) => JsValue::Array(items.iter().map(decode_markers).collect()),
        _ => value.clone(),
    }
}

/// 이 빌드의 수 방언으로 특수 숫자를 표식 처리해 체크포인트 JSON을 쓴다.
pub fn safe_checkpoint_stringify(value: &JsValue) -> Result<JsString, JsError> {
    safe_checkpoint_stringify_with(value, NumberDialect::PLATFORM)
}

/// 지정한 수 방언으로 특수 숫자를 표식 처리해 체크포인트 JSON을 쓴다.
pub fn safe_checkpoint_stringify_with(
    value: &JsValue,
    dialect: NumberDialect,
) -> Result<JsString, JsError> {
    validate_tree(value, false)?;
    let tagged = encode_markers(value);
    let bytes = stringify_json_with(&tagged, JsonMode::Standard, dialect);
    let text = std::str::from_utf8(&bytes).expect("the JS JSON writer emits valid UTF-8");
    if text.encode_utf16().count() > MAX_TEXT_UNITS {
        return Err(range_error("text limit"));
    }
    Ok(JsString::from_str(text))
}

fn parse_quoted_key(text: &[u16], dialect: NumberDialect) -> Result<JsString, JsError> {
    let parsed = parse_json_utf16_with(text, JsonMode::Standard, dialect)?;
    match &parsed {
        JsValue::String(value) => Ok(value.clone()),
        _ => Err(JsError::new(
            "SyntaxError",
            JsString::from_str("Checkpoint object key"),
        )),
    }
}

fn raw_number_is_nonfinite(text: &[u16], dialect: NumberDialect) -> bool {
    let Some(ascii) = text
        .iter()
        .map(|unit| u8::try_from(*unit).ok())
        .collect::<Option<Vec<_>>>()
    else {
        return true;
    };
    let Ok(literal) = std::str::from_utf8(&ascii) else {
        return true;
    };
    let Some(normalized) = normalize_number_token(literal) else {
        return true;
    };
    match parse_json_utf16_with(
        &normalized.encode_utf16().collect::<Vec<_>>(),
        JsonMode::Standard,
        dialect,
    ) {
        Ok(JsValue::Number(value)) => !value.is_finite(),
        _ => true,
    }
}

fn normalize_number_token(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = usize::from(bytes.first() == Some(&b'-'));
    let integer_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let integer_end = index;
    let fraction_start = if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        Some(start)
    } else {
        None
    };
    let fraction_end = index;
    if integer_start == integer_end && fraction_start.is_none_or(|start| start == fraction_end) {
        return None;
    }
    if bytes
        .get(index)
        .is_some_and(|byte| matches!(*byte, b'e' | b'E'))
    {
        index += 1;
        if bytes
            .get(index)
            .is_some_and(|byte| matches!(*byte, b'+' | b'-'))
        {
            index += 1;
        }
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
    }
    if index != bytes.len() {
        return None;
    }
    let integer = &value[integer_start..integer_end];
    let normalized_integer = integer.trim_start_matches('0');
    let mut normalized = String::new();
    if value.starts_with('-') {
        normalized.push('-');
    }
    if integer_start == integer_end || normalized_integer.is_empty() {
        normalized.push('0');
    } else {
        normalized.push_str(normalized_integer);
    }
    if let Some(start) = fraction_start {
        normalized.push('.');
        if start == fraction_end {
            normalized.push('0');
        } else {
            normalized.push_str(&value[start..fraction_end]);
        }
    }
    if fraction_end < bytes.len() {
        normalized.push_str(&value[fraction_end..]);
    }
    Some(normalized)
}

fn scan_text(text: &[u16], dialect: NumberDialect) -> Result<(), JsError> {
    let mut index = 0usize;
    let mut depth = 0isize;
    let mut frames: Vec<Option<HashSet<JsString>>> = Vec::new();
    while index < text.len() {
        let unit = text[index];
        if unit == b'"' as u16 {
            let start = index;
            index += 1;
            while index < text.len() {
                if text[index] == b'\\' as u16 {
                    index += 2;
                } else if text[index] == b'"' as u16 {
                    break;
                } else {
                    index += 1;
                }
            }
            let end = std::cmp::min(index, text.len().saturating_sub(1));
            let mut next = index.saturating_add(1);
            while next < text.len() && is_js_whitespace(text[next]) {
                next += 1;
            }
            if next < text.len()
                && text[next] == b':' as u16
                && let Some(Some(keys)) = frames.last_mut()
            {
                let key = parse_quoted_key(&text[start..=end], dialect)?;
                if !keys.insert(key) {
                    return Err(type_error("duplicate state key"));
                }
            }
        } else if unit == b'{' as u16 || unit == b'[' as u16 {
            depth += 1;
            if depth > MAX_DEPTH as isize {
                return Err(range_error("depth limit"));
            }
            frames.push((unit == b'{' as u16).then(HashSet::new));
        } else if unit == b'}' as u16 || unit == b']' as u16 {
            depth -= 1;
            frames.pop();
        } else if unit == b'-' as u16 || (0x30..=0x39).contains(&unit) {
            let start = index;
            let mut end = index + 1;
            while end < text.len()
                && matches!(text[end], 0x30..=0x39 | 0x45 | 0x65 | 0x2b | 0x2d | 0x2e)
            {
                end += 1;
            }
            if raw_number_is_nonfinite(&text[start..end], dialect) {
                return Err(type_error("untagged nonfinite number"));
            }
            index = end - 1;
        }
        index += 1;
    }
    Ok(())
}

/// 이 빌드의 수 방언으로 체크포인트 JSON을 검사하고 특수 숫자를 복원한다.
pub fn safe_checkpoint_parse(value: &JsValue) -> Result<JsValue, JsError> {
    safe_checkpoint_parse_with(value, NumberDialect::PLATFORM)
}

/// 지정한 수 방언으로 체크포인트 JSON을 검사하고 특수 숫자를 복원한다.
pub fn safe_checkpoint_parse_with(
    value: &JsValue,
    dialect: NumberDialect,
) -> Result<JsValue, JsError> {
    let JsValue::String(text) = value else {
        return Err(range_error("text limit"));
    };
    if text.len_utf16() > MAX_TEXT_UNITS {
        return Err(range_error("text limit"));
    }
    scan_text(text.as_units(), dialect)?;
    let parsed = parse_json_utf16_with(text.as_units(), JsonMode::Standard, dialect)?;
    validate_tree(&parsed, true)?;
    Ok(decode_markers(&parsed))
}
