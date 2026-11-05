//! 정적 linked 지표 `aster.volume-direction@1/pressure`를 구현한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::js_sign;
use barochart_js::string::JsString;

use crate::data::Bar;
use crate::indicator_helpers::CheckpointFieldOrder;
use crate::indicator_params::{
    IndicatorParamValue, OrderedIndicatorParams, validate_indicator_params,
};
use crate::indicator_registry::PRESSURE_DESCRIPTOR;
use crate::indicator_types::{
    CreatedIndicator, IndicatorDefinition, IndicatorOutputRow, IndicatorProgram,
    IndicatorProvenance, PlotOffset,
};

const PRESSURE_OUTPUTS: &[&str] = &["signed", "cumulative"];
const PRESSURE_STATE_KEYS: &[&str] = &["previous", "cumulative"];

/// Pressure의 typed 누적 상태다. Factor는 factory 설정이며 wire state에는 포함하지 않는다.
pub struct PressureState {
    factor: f64,
    previous: f64,
    cumulative: f64,
    wire_order: CheckpointFieldOrder,
}

impl PressureState {
    fn new(factor: f64) -> Self {
        Self {
            factor,
            previous: f64::NAN,
            cumulative: 0.0,
            wire_order: CheckpointFieldOrder::source(PRESSURE_STATE_KEYS.len()),
        }
    }

    /// 한 봉의 signed/cumulative 결과를 고정 출력 행으로 계산한다.
    pub fn step(&mut self, bar: &Bar, _index: usize) -> Result<IndicatorOutputRow, JsError> {
        let signed = if self.previous.is_nan() {
            0.0
        } else {
            js_sign(bar.close - self.previous) * bar.volume * self.factor
        };
        self.previous = bar.close;
        self.cumulative += signed;
        Ok(IndicatorOutputRow::two(signed, self.cumulative))
    }

    /// 이전 종가와 누적 값을 현재 wire 키 순서대로 복사한다.
    pub fn snapshot(&self) -> JsValue {
        self.wire_order.ordered_object(&[
            ("previous", JsValue::Number(self.previous)),
            ("cumulative", JsValue::Number(self.cumulative)),
        ])
    }

    /// 구조가 검증된 wire 상태를 원자 복원하고 factory factor를 유지한다.
    pub fn restore(&mut self, wire: &JsValue) -> Result<(), JsError> {
        let JsValue::Object(record) = wire else {
            return Err(checkpoint_error("state"));
        };
        let wire_order = CheckpointFieldOrder::capture(wire, PRESSURE_STATE_KEYS)
            .ok_or_else(|| checkpoint_error("state"))?;
        let previous = number_field(record, "previous")?;
        let cumulative = number_field(record, "cumulative")?;
        self.previous = previous;
        self.cumulative = cumulative;
        self.wire_order = wire_order;
        Ok(())
    }

    /// Factory에 설정한 factor를 조회한다.
    pub fn factor(&self) -> f64 {
        self.factor
    }
}

/// Generic params 검증 뒤 Pressure factory의 기본값과 범위를 적용한다.
pub fn create_pressure(raw_params: &JsValue) -> Result<CreatedIndicator<PressureState>, JsError> {
    let params = validate_indicator_params(raw_params)?;
    let factor = numeric_parameter(&params, "factor", 1.0)?;
    let shift = numeric_parameter(&params, "shift", 0.0)?;
    if !factor.is_finite()
        || factor.abs() > 1.0
        || !shift.is_finite()
        || shift.fract() != 0.0
        || shift.abs() > 10_000.0
    {
        return Err(range_error("Volume-direction factor/shift"));
    }

    let definition = IndicatorDefinition::new(
        IndicatorProgram::Pressure,
        params.ordered_copy(&["factor", "shift"])?,
        PRESSURE_OUTPUTS,
        vec![
            PlotOffset {
                output: "signed",
                value: shift,
            },
            PlotOffset {
                output: "cumulative",
                value: shift,
            },
        ],
        IndicatorProvenance::Linked(&PRESSURE_DESCRIPTOR),
    )?;
    Ok(CreatedIndicator {
        definition,
        state: PressureState::new(factor),
    })
}

fn numeric_parameter(
    params: &OrderedIndicatorParams,
    name: &str,
    default: f64,
) -> Result<f64, JsError> {
    match params.get(name) {
        None => Ok(default),
        Some(IndicatorParamValue::Number(value)) => Ok(*value),
        Some(IndicatorParamValue::String(_)) => Err(range_error("Volume-direction factor/shift")),
    }
}

fn number_field(record: &JsObject, name: &str) -> Result<f64, JsError> {
    match record.get(&key(name)) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(checkpoint_error("state")),
    }
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn checkpoint_error(message: &str) -> JsError {
    type_error(&format!("Indicator checkpoint {message}"))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
