//! JS oracle `src/core/checkpoint-validation.mjs`와 같은 체크포인트 무손실 JSON 코덱이다.
//!
//! 러스트 브리지가 소유하는 `JsValue` 도메인만 처리한다. 이 값 모델에는 JS getter/prototype/symbol 속성,
//! 배열 구멍, 객체 순환 참조가 없다. 문자열과 키는 WTF-16으로 유지하고, 모든 순회 한도 검사 뒤 깊이가
//! 32 이하임을 확인한 후에만 표식을 재귀 변환한다.

use std::collections::HashSet;
use std::mem::size_of;

use barochart_js::error::JsError;
use barochart_js::json::{
    JsValue, JsonFailure, JsonMode, parse_json_utf16_scoped, stringify_json_scoped,
};
use barochart_js::memory::{MemoryScope, OomStyle};
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
        units if units.iter().copied().eq("NaN".encode_utf16()) => Ok(f64::NAN),
        units if units.iter().copied().eq("Infinity".encode_utf16()) => Ok(f64::INFINITY),
        units if units.iter().copied().eq("-Infinity".encode_utf16()) => Ok(f64::NEG_INFINITY),
        units if units.iter().copied().eq("-0".encode_utf16()) => Ok(-0.0),
        _ => Err(()),
    })
}

fn validate_tree_scoped(
    root: &JsValue,
    decode: bool,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    scope
        .try_grow(size_of::<(&JsValue, usize)>())
        .map_err(|failure| failure.into_js_error())?;
    let mut stack = Vec::new();
    stack
        .try_reserve(1)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    stack.push((root, 0usize));
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
                scope
                    .try_grow(items.len().saturating_mul(size_of::<(&JsValue, usize)>()))
                    .map_err(|failure| failure.into_js_error())?;
                stack
                    .try_reserve(items.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
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
                scope
                    .try_grow(
                        object
                            .len()
                            .saturating_mul(size_of::<(&JsString, &JsValue)>()),
                    )
                    .map_err(|failure| failure.into_js_error())?;
                let mut entries = Vec::new();
                entries
                    .try_reserve(object.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                entries.extend(object.iter());
                for (key, _) in &entries {
                    if !is_unicode_scalar_string(key) {
                        return Err(type_error("Unicode scalar"));
                    }
                }
                scope
                    .try_grow(entries.len().saturating_mul(size_of::<(&JsValue, usize)>()))
                    .map_err(|failure| failure.into_js_error())?;
                stack
                    .try_reserve(entries.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                for (_, child) in entries.into_iter().rev() {
                    stack.push((child, depth + 1));
                }
            }
        }
    }
    Ok(())
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
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    safe_checkpoint_stringify_scoped(value, dialect, &mut scope)
}

/// 지정한 수 방언으로 checkpoint JSON을 scoped fallible allocation해 쓴다.
pub fn safe_checkpoint_stringify_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    validate_tree_scoped(value, false, scope)?;
    let lossless = stringify_json_scoped(value, JsonMode::Lossless, dialect, scope)
        .map_err(|failure| failure.into_js_error())?;
    let bytes = tag_lossless_numbers(&lossless, scope)?;
    let text = std::str::from_utf8(&bytes).expect("the JS JSON writer emits valid UTF-8");
    if text.encode_utf16().count() > MAX_TEXT_UNITS {
        return Err(range_error("text limit"));
    }
    JsString::try_from_str(text, scope).map_err(|failure| failure.into_js_error())
}

const NAN_MARKER: &[u8] = br#"{"$asterNumber":"NaN"}"#;
const POSITIVE_INFINITY_MARKER: &[u8] = br#"{"$asterNumber":"Infinity"}"#;
const NEGATIVE_INFINITY_MARKER: &[u8] = br#"{"$asterNumber":"-Infinity"}"#;
const NEGATIVE_ZERO_MARKER: &[u8] = br#"{"$asterNumber":"-0"}"#;

fn marker_at(bytes: &[u8], index: usize) -> Option<(usize, &'static [u8])> {
    let boundary = |position: usize| {
        bytes
            .get(position)
            .is_none_or(|byte| matches!(*byte, b',' | b']' | b'}' | b' ' | b'\t' | b'\n' | b'\r'))
    };
    for (token, marker) in [
        (b"-Infinity".as_slice(), NEGATIVE_INFINITY_MARKER),
        (b"Infinity".as_slice(), POSITIVE_INFINITY_MARKER),
        (b"NaN".as_slice(), NAN_MARKER),
        (b"-0".as_slice(), NEGATIVE_ZERO_MARKER),
    ] {
        if bytes[index..].starts_with(token) && boundary(index + token.len()) {
            return Some((token.len(), marker));
        }
    }
    None
}

fn tag_lossless_numbers(bytes: &[u8], scope: &mut MemoryScope) -> Result<Vec<u8>, JsError> {
    let mut output_length = 0usize;
    let mut index = 0usize;
    let mut string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                string = false;
            }
            output_length = output_length
                .checked_add(1)
                .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            index += 1;
        } else if byte == b'"' {
            string = true;
            output_length += 1;
            index += 1;
        } else if let Some((consumed, marker)) = marker_at(bytes, index) {
            output_length = output_length
                .checked_add(marker.len())
                .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            index += consumed;
        } else {
            output_length = output_length
                .checked_add(1)
                .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            index += 1;
        }
    }
    scope
        .try_grow(output_length)
        .map_err(|failure| failure.into_js_error())?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(output_length)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    let mut index = 0usize;
    let mut string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if string {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                string = false;
            }
            index += 1;
        } else if byte == b'"' {
            string = true;
            output.push(byte);
            index += 1;
        } else if let Some((consumed, marker)) = marker_at(bytes, index) {
            output.extend_from_slice(marker);
            index += consumed;
        } else {
            output.push(byte);
            index += 1;
        }
    }
    Ok(output)
}

fn parse_quoted_key(
    text: &[u16],
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let parsed = match parse_json_utf16_scoped(text, JsonMode::Standard, dialect, scope) {
        Ok(value) => value,
        Err(JsonFailure::Syntax(error)) => return Err(error),
        Err(JsonFailure::Memory(failure)) => return Err(failure.into_js_error()),
    };
    match &parsed {
        JsValue::String(value) => value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error()),
        _ => Err(JsError::new(
            "SyntaxError",
            JsString::from_str("Checkpoint object key"),
        )),
    }
}

fn raw_number_is_nonfinite(
    text: &[u16],
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<bool, JsError> {
    scope
        .try_grow(text.len())
        .map_err(|failure| failure.into_js_error())?;
    let mut ascii = String::new();
    ascii
        .try_reserve_exact(text.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for &unit in text {
        let Ok(byte) = u8::try_from(unit) else {
            return Ok(true);
        };
        ascii.push(char::from(byte));
    }
    let Some(normalized) = normalize_number_token(&ascii, scope)? else {
        return Ok(true);
    };
    let units =
        JsString::try_from_str(&normalized, scope).map_err(|failure| failure.into_js_error())?;
    Ok(
        match parse_json_utf16_scoped(units.as_units(), JsonMode::Standard, dialect, scope) {
            Ok(JsValue::Number(value)) => !value.is_finite(),
            Ok(_) | Err(JsonFailure::Syntax(_)) => true,
            Err(JsonFailure::Memory(failure)) => return Err(failure.into_js_error()),
        },
    )
}

fn normalize_number_token(value: &str, scope: &mut MemoryScope) -> Result<Option<String>, JsError> {
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
        return Ok(None);
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
            return Ok(None);
        }
    }
    if index != bytes.len() {
        return Ok(None);
    }
    let integer = &value[integer_start..integer_end];
    let normalized_integer = integer.trim_start_matches('0');
    let capacity = value
        .len()
        .checked_add(1)
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(capacity)
        .map_err(|failure| failure.into_js_error())?;
    let mut normalized = String::new();
    normalized
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
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
    Ok(Some(normalized))
}

fn scan_text(text: &[u16], dialect: NumberDialect, scope: &mut MemoryScope) -> Result<(), JsError> {
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
                let key = parse_quoted_key(&text[start..=end], dialect, scope)?;
                let bytes = size_of::<(JsString, usize)>().saturating_add(16);
                scope
                    .try_grow(bytes)
                    .map_err(|failure| failure.into_js_error())?;
                keys.try_reserve(1)
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                if !keys.insert(key) {
                    return Err(type_error("duplicate state key"));
                }
            }
        } else if unit == b'{' as u16 || unit == b'[' as u16 {
            depth += 1;
            if depth > MAX_DEPTH as isize {
                return Err(range_error("depth limit"));
            }
            scope
                .try_grow(size_of::<Option<HashSet<JsString>>>())
                .map_err(|failure| failure.into_js_error())?;
            frames
                .try_reserve(1)
                .map_err(|_| scope.allocation_failure().into_js_error())?;
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
            if raw_number_is_nonfinite(&text[start..end], dialect, scope)? {
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
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    safe_checkpoint_parse_scoped(value, dialect, &mut scope)
}

/// 지정한 수 방언으로 checkpoint JSON을 scoped fallible allocation해 읽는다.
pub fn safe_checkpoint_parse_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let JsValue::String(text) = value else {
        return Err(range_error("text limit"));
    };
    if text.len_utf16() > MAX_TEXT_UNITS {
        return Err(range_error("text limit"));
    }
    scan_text(text.as_units(), dialect, scope)?;
    let mut parsed =
        match parse_json_utf16_scoped(text.as_units(), JsonMode::Standard, dialect, scope) {
            Ok(value) => value,
            Err(JsonFailure::Syntax(error)) => return Err(error),
            Err(JsonFailure::Memory(failure)) => return Err(failure.into_js_error()),
        };
    validate_tree_scoped(&parsed, true, scope)?;
    decode_markers_in_place(&mut parsed, scope)?;
    Ok(parsed)
}

fn decode_markers_in_place(value: &mut JsValue, scope: &mut MemoryScope) -> Result<(), JsError> {
    if let Some(marker) = marker_value(value) {
        *value = JsValue::Number(marker.expect("validated checkpoint marker"));
        return Ok(());
    }
    match value {
        JsValue::Array(items) => {
            for item in items {
                decode_markers_in_place(item, scope)?;
            }
        }
        JsValue::Object(object) => {
            let bytes = object
                .len()
                .checked_mul(size_of::<JsString>())
                .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            scope
                .try_grow(bytes)
                .map_err(|failure| failure.into_js_error())?;
            let mut keys = Vec::new();
            keys.try_reserve_exact(object.len())
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            for (key, _) in object.iter() {
                keys.push(
                    key.try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                );
            }
            for key in keys {
                let child = object
                    .get_mut(&key)
                    .expect("captured checkpoint key remains present");
                decode_markers_in_place(child, scope)?;
            }
        }
        _ => {}
    }
    Ok(())
}
