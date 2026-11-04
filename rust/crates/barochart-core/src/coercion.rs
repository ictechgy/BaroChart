//! JSON 값 경계에서 필요한 ECMAScript `ToNumber`와 숫자-왼쪽 `+` coercion이다.
//!
//! callable, Symbol, Proxy나 불투명 host 객체는 이 값 모델에 없으므로 추가하지 않는다. 배열·plain object의
//! `ToPrimitive`와 대상별 오류 문구는 기존 [`crate::contracts::js_to_string_with`]가 정본이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsValue, JsonMode, parse_json_utf16_with};
use barochart_js::num::{NumberDialect, number_to_string_with};
use barochart_js::string::JsString;

use crate::contracts::js_to_string_with;

fn ascii_eq(value: &[u16], expected: &str) -> bool {
    value.iter().copied().eq(expected.encode_utf16())
}

fn ascii_digit(unit: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&unit)
}

fn radix_digit(unit: u16, radix: u8) -> Option<u8> {
    let value = match unit {
        0x30..=0x39 => (unit - 0x30) as u8,
        0x41..=0x46 => (unit - 0x41 + 10) as u8,
        0x61..=0x66 => (unit - 0x61 + 10) as u8,
        _ => return None,
    };
    (value < radix).then_some(value)
}

/// 2진 거듭제곱 radix 정수를 상위 53비트와 guard/sticky로 ties-to-even 반올림한다.
fn power_two_integer(digits: &[u16], radix: u8, width: u32) -> Option<f64> {
    if digits.is_empty()
        || digits
            .iter()
            .any(|unit| radix_digit(*unit, radix).is_none())
    {
        return None;
    }
    let mut started = false;
    let mut bit_length = 0usize;
    let mut top = 0u64;
    let mut guard = false;
    let mut sticky = false;
    for unit in digits {
        let digit = radix_digit(*unit, radix).expect("digits were validated");
        for shift in (0..width).rev() {
            let bit = u64::from((digit >> shift) & 1);
            if !started {
                if bit == 0 {
                    continue;
                }
                started = true;
            }
            bit_length = bit_length.saturating_add(1);
            match bit_length {
                1..=53 => top = (top << 1) | bit,
                54 => guard = bit != 0,
                _ => sticky |= bit != 0,
            }
        }
    }
    if !started {
        return Some(0.0);
    }
    if bit_length <= 53 {
        return Some(top as f64);
    }
    if guard && (sticky || top & 1 != 0) {
        top += 1;
    }
    if top == 1u64 << 53 {
        top >>= 1;
        bit_length = bit_length.saturating_add(1);
    }
    if bit_length > 1_024 {
        return Some(f64::INFINITY);
    }
    let exponent = (bit_length - 1 + 1_023) as u64;
    let fraction = top - (1u64 << 52);
    Some(f64::from_bits((exponent << 52) | fraction))
}

/// StringNumericLiteral의 십진 부분을 JSON 숫자 문법으로 바꾼다.
fn normalized_decimal(value: &[u16]) -> Option<Vec<u16>> {
    let mut index = 0usize;
    let negative = value.first() == Some(&(b'-' as u16));
    if matches!(value.first(), Some(unit) if *unit == b'+' as u16 || *unit == b'-' as u16) {
        index += 1;
    }
    let integer_start = index;
    while value.get(index).is_some_and(|unit| ascii_digit(*unit)) {
        index += 1;
    }
    let integer_end = index;
    let fraction_start = if value.get(index) == Some(&(b'.' as u16)) {
        index += 1;
        let start = index;
        while value.get(index).is_some_and(|unit| ascii_digit(*unit)) {
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
    let exponent_start = index;
    if matches!(value.get(index), Some(unit) if *unit == b'e' as u16 || *unit == b'E' as u16) {
        index += 1;
        if matches!(value.get(index), Some(unit) if *unit == b'+' as u16 || *unit == b'-' as u16) {
            index += 1;
        }
        let digits = index;
        while value.get(index).is_some_and(|unit| ascii_digit(*unit)) {
            index += 1;
        }
        if digits == index {
            return None;
        }
    }
    if index != value.len() {
        return None;
    }

    let integer = &value[integer_start..integer_end];
    let first_nonzero = integer.iter().position(|unit| *unit != b'0' as u16);
    let mut normalized = Vec::with_capacity(value.len() + 2);
    if negative {
        normalized.push(b'-' as u16);
    }
    match first_nonzero {
        Some(first) => normalized.extend_from_slice(&integer[first..]),
        None => normalized.push(b'0' as u16),
    }
    if let Some(start) = fraction_start {
        normalized.push(b'.' as u16);
        if start == fraction_end {
            normalized.push(b'0' as u16);
        } else {
            normalized.extend_from_slice(&value[start..fraction_end]);
        }
    }
    if exponent_start < value.len() {
        normalized.extend_from_slice(&value[exponent_start..]);
    }
    Some(normalized)
}

fn string_to_number(value: &JsString, dialect: NumberDialect) -> f64 {
    let trimmed = JsString::trim(value);
    let value = trimmed.as_units();
    if value.is_empty() {
        return 0.0;
    }
    if ascii_eq(value, "Infinity") || ascii_eq(value, "+Infinity") {
        return f64::INFINITY;
    }
    if ascii_eq(value, "-Infinity") {
        return f64::NEG_INFINITY;
    }
    if value.len() >= 2 && value[0] == b'0' as u16 {
        let parsed = match value[1] {
            unit if unit == b'x' as u16 || unit == b'X' as u16 => {
                power_two_integer(&value[2..], 16, 4)
            }
            unit if unit == b'o' as u16 || unit == b'O' as u16 => {
                power_two_integer(&value[2..], 8, 3)
            }
            unit if unit == b'b' as u16 || unit == b'B' as u16 => {
                power_two_integer(&value[2..], 2, 1)
            }
            _ => None,
        };
        if let Some(parsed) = parsed {
            return parsed;
        }
        if matches!(value[1], unit if unit == b'x' as u16 || unit == b'X' as u16 || unit == b'o' as u16 || unit == b'O' as u16 || unit == b'b' as u16 || unit == b'B' as u16)
        {
            return f64::NAN;
        }
    }
    let Some(normalized) = normalized_decimal(value) else {
        return f64::NAN;
    };
    match parse_json_utf16_with(&normalized, JsonMode::Standard, dialect) {
        Ok(JsValue::Number(value)) => value,
        _ => f64::NAN,
    }
}

/// JSON 값 경계에서 ECMAScript `ToNumber`를 수행한다.
///
/// 배열·객체는 기존 `js_to_string_with`의 bounded `ToPrimitive`를 거쳐 문자열 숫자 문법으로 읽는다.
/// 문자열 숫자가 문법에 맞지 않으면 오류가 아니라 NaN이며, 대상 숫자 방언은 긴 십진 반올림에 적용된다.
pub fn js_to_number_with(value: &JsValue, dialect: NumberDialect) -> Result<f64, JsError> {
    Ok(match value {
        JsValue::Undefined => f64::NAN,
        JsValue::Null => 0.0,
        JsValue::Bool(false) => 0.0,
        JsValue::Bool(true) => 1.0,
        JsValue::Number(value) => *value,
        JsValue::String(value) => string_to_number(value, dialect),
        JsValue::Array(_) | JsValue::Object(_) => {
            let primitive = js_to_string_with(value, dialect)?;
            string_to_number(&primitive, dialect)
        }
    })
}

/// 왼쪽이 이미 Number인 ECMAScript `+`를 수행한다.
///
/// 오른쪽 `ToPrimitive` 결과가 문자열(원래 문자열·배열·plain object)이면 왼쪽 Number를 JS 표기로 붙이고,
/// 그 밖의 primitive는 `ToNumber` 뒤 binary64 덧셈을 한다. 결과 종류를 보존하기 위해 `JsValue`를 돌려준다.
pub fn js_add_number_with(
    left: f64,
    right: &JsValue,
    dialect: NumberDialect,
) -> Result<JsValue, JsError> {
    if matches!(
        right,
        JsValue::String(_) | JsValue::Array(_) | JsValue::Object(_)
    ) {
        let right = js_to_string_with(right, dialect)?;
        let left = number_to_string_with(left, dialect);
        let mut units = Vec::with_capacity(left.encode_utf16().count() + right.len_utf16());
        units.extend(left.encode_utf16());
        units.extend_from_slice(right.as_units());
        Ok(JsValue::String(JsString::from_utf16(units)))
    } else {
        Ok(JsValue::Number(left + js_to_number_with(right, dialect)?))
    }
}
