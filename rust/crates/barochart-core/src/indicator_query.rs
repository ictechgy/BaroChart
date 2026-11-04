//! 계산을 commit한 지표 출력의 named/raw/plot/as-of 조회다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::contracts::js_to_string_with;
use crate::data::BarStore;
use crate::indicator_engine::{IndicatorEngine, IndicatorRead};

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

/// source index를 그대로 쓰거나 plot offset을 역으로 적용한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndicatorQueryMode {
    /// 계산 배열의 raw index다.
    Raw,
    /// plot index에서 output offset을 빼 source index를 찾는다.
    Plot,
}

/// 이미 shape 검증된 query 옵션이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndicatorQueryOptions {
    /// raw/plot 해석이다.
    pub mode: IndicatorQueryMode,
    /// 읽을 수 있는 마지막 source index다. 빈 store에서는 -1이다.
    pub as_of_index: i64,
}

impl IndicatorQueryOptions {
    /// raw JS mode/asOfIndex를 공개 API와 같은 단일 RangeError로 검사한다.
    pub fn validate(mode: &JsValue, as_of_index: JsValue, length: usize) -> Result<Self, JsError> {
        let mode = match mode {
            JsValue::String(value) if text_eq(value, "raw") => IndicatorQueryMode::Raw,
            JsValue::String(value) if text_eq(value, "plot") => IndicatorQueryMode::Plot,
            _ => return Err(range_error("Indicator query index/mode")),
        };
        let JsValue::Number(as_of_index) = as_of_index else {
            return Err(range_error("Indicator query index/mode"));
        };
        if !safe_integer(as_of_index) || as_of_index < -1.0 || as_of_index >= length as f64 {
            return Err(range_error("Indicator query index/mode"));
        }
        Ok(Self {
            mode,
            as_of_index: as_of_index as i64,
        })
    }

    /// raw mode와 현재 마지막 index를 쓴다.
    pub fn raw(length: usize) -> Self {
        Self {
            mode: IndicatorQueryMode::Raw,
            as_of_index: length as i64 - 1,
        }
    }
}

/// 단일 query의 null 가능 결과다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IndicatorPoint {
    /// 유한 출력이면 값, NaN이면 None이다.
    pub value: Option<f64>,
    /// 실제로 읽은 source index다. raw 입력의 -0도 반환값에는 보존한다.
    pub source_index: Option<f64>,
    /// source 봉의 UTC millisecond다.
    pub source_time: Option<f64>,
}

impl IndicatorPoint {
    fn missing() -> Self {
        Self {
            value: None,
            source_index: None,
            source_time: None,
        }
    }
}

fn output_key(read: IndicatorRead<'_>, output: Option<&JsValue>) -> Result<JsString, JsError> {
    match output {
        None | Some(JsValue::Null | JsValue::Undefined) => Ok(JsString::from_str(
            read.output_names()
                .first()
                .expect("definitions have outputs"),
        )),
        Some(value) => js_to_string_with(value, NumberDialect::PLATFORM),
    }
}

fn output_index(read: IndicatorRead<'_>, output: &JsString) -> Option<usize> {
    read.output_names().iter().position(|candidate| {
        output
            .as_units()
            .iter()
            .copied()
            .eq(candidate.encode_utf16())
    })
}

/// 계산을 commit한 뒤 named raw 출력 전체를 빌린다.
pub fn indicator_values<'a>(
    engine: &'a mut IndicatorEngine,
    store: &BarStore,
    host: &dyn Host,
    id: &JsValue,
    output: Option<&JsValue>,
) -> Result<&'a [f64], JsError> {
    let read = engine.get(store, host, id)?;
    let key = output_key(read, output)?;
    let index =
        output_index(read, &key).ok_or_else(|| ordinary_error("Missing indicator output"))?;
    Ok(read
        .output_at(index)
        .expect("definition and output arrays have the same arity"))
}

/// 계산을 commit한 뒤 raw/plot index와 as-of cutoff를 적용해 한 값을 읽는다.
pub fn indicator_value_at(
    engine: &mut IndicatorEngine,
    store: &BarStore,
    host: &dyn Host,
    id: &JsValue,
    output: Option<&JsValue>,
    index: f64,
    options: IndicatorQueryOptions,
) -> Result<IndicatorPoint, JsError> {
    if !safe_integer(index)
        || options.as_of_index < -1
        || options.as_of_index >= store.length() as i64
    {
        return Err(range_error("Indicator query index/mode"));
    }
    if engine.entry(id).is_none() {
        return Err(ordinary_error("Missing indicator"));
    }
    let read = engine.get(store, host, id)?;
    let key = output_key(read, output)?;
    let output_index =
        output_index(read, &key).ok_or_else(|| ordinary_error("Missing indicator output"))?;
    let output_name = read.output_names()[output_index];
    let offset = match options.mode {
        IndicatorQueryMode::Raw => 0.0,
        IndicatorQueryMode::Plot => read.definition().effective_plot_offset(output_name),
    };
    let source = index - offset;
    if source < 0.0
        || source >= read.len() as f64
        || source > options.as_of_index as f64
        || !safe_integer(source)
    {
        return Ok(IndicatorPoint::missing());
    }
    let position = source as usize;
    let value = read
        .output_at(output_index)
        .expect("definition and output arrays have the same arity")[position];
    Ok(IndicatorPoint {
        value: value.is_finite().then_some(value),
        source_index: Some(source),
        source_time: Some(store.columns().time[position]),
    })
}
