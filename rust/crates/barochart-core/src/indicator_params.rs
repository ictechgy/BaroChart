//! 지표 팩토리 앞의 공통 파라미터 검증과 저장 순서다.
//!
//! 값은 계산 hot loop에 들어가기 전에 `f64` 또는 `JsString`으로 소유 복사한다. 개별 팩토리의
//! 기본값·범위·알려진 키 검사는 여기서 하지 않아, 빠진 키와 알 수 없는 키를 원본대로 보존한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

use crate::contracts::ordered_record;

const MAX_PARAMS: usize = 32;
const MAX_STRING_UNITS: usize = 256;
const MAX_CALENDAR_UNITS: usize = 65_536;

/// 공통 검증을 통과한 지표 파라미터 원시 값이다.
#[derive(Clone, Debug)]
pub enum IndicatorParamValue {
    /// 유한 JS Number다. `-0` 비트를 보존한다.
    Number(f64),
    /// WTF-16 JS 문자열이다.
    String(JsString),
}

impl IndicatorParamValue {
    fn to_js_value(&self) -> JsValue {
        match self {
            Self::Number(value) => JsValue::Number(*value),
            Self::String(value) => JsValue::String(value.clone()),
        }
    }

    fn object_is(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Number(left), Self::Number(right)) => same_number(*left, *right),
            (Self::String(left), Self::String(right)) => left == right,
            _ => false,
        }
    }
}

/// 자기 열거 키 순서를 보존하는 검증된 지표 파라미터다.
#[derive(Clone, Debug, Default)]
pub struct OrderedIndicatorParams {
    entries: Vec<(JsString, IndicatorParamValue)>,
}

impl OrderedIndicatorParams {
    /// 키·값 쌍을 현재 wire 순서로 순회한다.
    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &IndicatorParamValue)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// 파라미터 수를 돌려준다.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 파라미터가 비었는지 본다.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// ASCII 키가 있는지 본다.
    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// ASCII 키의 원시 값을 찾는다. 없으면 기본값을 만들지 않는다.
    pub fn get(&self, key: &str) -> Option<&IndicatorParamValue> {
        self.entries
            .iter()
            .find(|(candidate, _)| text_eq(candidate, key))
            .map(|(_, value)| value)
    }

    /// ASCII 키가 Number면 그 값을 돌려준다.
    pub fn number(&self, key: &str) -> Option<f64> {
        match self.get(key) {
            Some(IndicatorParamValue::Number(value)) => Some(*value),
            _ => None,
        }
    }

    /// ASCII 키가 문자열이면 빌린 값을 돌려준다.
    pub fn string(&self, key: &str) -> Option<&JsString> {
        match self.get(key) {
            Some(IndicatorParamValue::String(value)) => Some(value),
            _ => None,
        }
    }

    /// 선언된 키를 먼저 두고, 나머지 키를 JS UTF-16 순서로 보존한 새 복사본을 만든다.
    /// 정수 모양 키는 `JsObject` 규칙에 따라 언제나 먼저 나온다.
    pub fn ordered_copy(&self, declared: &[&str]) -> Result<Self, JsError> {
        let ordered = ordered_record(&self.to_js_value(), declared)?;
        validated_from_value(&ordered)
    }

    /// 브리지·checkpoint 경계에서 쓸 JS 객체 복사본을 만든다.
    pub fn to_js_value(&self) -> JsValue {
        let mut object = JsObject::new();
        for (key, value) in &self.entries {
            object.insert(key.clone(), value.to_js_value());
        }
        JsValue::Object(object)
    }

    /// 키 순서를 무시하고 값은 `Object.is` 의미로 비교한다.
    pub fn object_is_equal(&self, other: &Self) -> bool {
        self.len() == other.len()
            && self.entries.iter().all(|(key, value)| {
                other
                    .entries
                    .iter()
                    .find(|(candidate, _)| candidate == key)
                    .is_some_and(|(_, other)| value.object_is(other))
            })
    }
}

/// JS `validateIndicatorParams`와 같은 공통 shape/value 검사 뒤 소유 복사한다.
pub fn validate_indicator_params(value: &JsValue) -> Result<OrderedIndicatorParams, JsError> {
    validated_from_value(value)
}

/// 개별 팩토리가 명시적으로 쓰는 1..10000 period 검사다.
pub fn validate_period(value: f64) -> Result<usize, JsError> {
    if !value.is_finite() || value.fract() != 0.0 || !(1.0..=10_000.0).contains(&value) {
        return Err(range_error("Period must be 1..10000"));
    }
    Ok(value as usize)
}

fn validated_from_value(value: &JsValue) -> Result<OrderedIndicatorParams, JsError> {
    let object = match value {
        JsValue::Object(object) => object,
        JsValue::Array(_) => return Err(type_error("Indicator params: object required")),
        _ => return Err(type_error("Indicator params")),
    };

    let mut reserved: Vec<&JsString> = object
        .iter()
        .map(|(key, _)| key)
        .filter(|key| is_reserved(key))
        .collect();
    if !reserved.is_empty() {
        reserved.sort_unstable();
        let key = reserved[0].slice(0, Some(64));
        let mut message: Vec<u16> = "Indicator params: unsupported field "
            .encode_utf16()
            .collect();
        message.extend_from_slice(key.as_units());
        return Err(JsError::new("TypeError", JsString::from_utf16(message)));
    }
    if object.len() > MAX_PARAMS {
        return Err(type_error("Indicator parameter count"));
    }

    let mut entries = Vec::with_capacity(object.len());
    for (key, value) in object.iter() {
        let value = match value {
            JsValue::Number(value) if value.is_finite() => IndicatorParamValue::Number(*value),
            JsValue::String(value)
                if value.len_utf16()
                    <= if text_eq(key, "calendar") {
                        MAX_CALENDAR_UNITS
                    } else {
                        MAX_STRING_UNITS
                    } =>
            {
                IndicatorParamValue::String(value.clone())
            }
            _ => return Err(type_error("Indicator parameter values")),
        };
        entries.push((key.clone(), value));
    }
    Ok(OrderedIndicatorParams { entries })
}

fn same_number(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        true
    } else if left == 0.0 && right == 0.0 {
        left.to_bits() == right.to_bits()
    } else {
        left == right
    }
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn is_reserved(value: &JsString) -> bool {
    ["__proto__", "constructor", "prototype"]
        .into_iter()
        .any(|key| text_eq(value, key))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
