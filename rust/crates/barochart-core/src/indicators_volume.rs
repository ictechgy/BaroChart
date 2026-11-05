//! 거래량 지표 8개의 typed 계산 상태와 checkpoint 변환을 제공한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::js_sign;
use barochart_js::string::JsString;

use crate::data::Bar;
use crate::indicator_helpers::{
    CheckpointFieldOrder, Ring, Smoother, canonical_checkpoint, roll, smooth, true_range,
};
use crate::indicator_params::{
    IndicatorParamValue, OrderedIndicatorParams, validate_indicator_params, validate_period,
};
use crate::indicator_types::{
    CreatedIndicator, IndicatorDefinition, IndicatorOutputRow, IndicatorProgram,
    IndicatorProvenance,
};

const VALUE_OUTPUT: &[&str] = &["value"];
const VORTEX_OUTPUTS: &[&str] = &["plus", "minus"];

const OBV_KEYS: &[&str] = &["previous", "value"];
const MFI_KEYS: &[&str] = &["previous", "p", "n"];
const CMF_KEYS: &[&str] = &["f", "v"];
const ADL_KEYS: &[&str] = &["value"];
const CHAIKIN_KEYS: &[&str] = &["value", "f", "l"];
const FORCE_INDEX_KEYS: &[&str] = &["previous", "e"];
const VOLUME_OSCILLATOR_KEYS: &[&str] = &["f", "l"];
const VORTEX_KEYS: &[&str] = &["previous", "tr", "p", "m"];

/// 거래량 프로그램 하나의 계산 상태다.
pub enum VolumeState {
    /// On-balance volume 상태다.
    Obv(ObvState),
    /// Money flow index 상태다.
    Mfi(MfiState),
    /// Chaikin money flow 상태다.
    Cmf(CmfState),
    /// Accumulation/distribution line 상태다.
    Adl(AdlState),
    /// Chaikin oscillator 상태다.
    Chaikin(ChaikinState),
    /// Force index 상태다.
    ForceIndex(ForceIndexState),
    /// Volume oscillator 상태다.
    VolumeOscillator(VolumeOscillatorState),
    /// Vortex 상태다.
    Vortex(VortexState),
}

/// OBV의 직전 종가와 누적 값이다.
pub struct ObvState {
    previous: f64,
    value: f64,
    wire_order: CheckpointFieldOrder,
}

/// MFI의 직전 전형 가격과 양·음 자금 흐름 ring이다.
pub struct MfiState {
    previous: f64,
    positive: Option<Ring>,
    negative: Option<Ring>,
    period: usize,
    wire_order: CheckpointFieldOrder,
}

/// CMF의 자금 흐름 및 거래량 rolling ring이다.
pub struct CmfState {
    flow: Option<Ring>,
    volume: Option<Ring>,
    period: usize,
    wire_order: CheckpointFieldOrder,
}

/// ADL의 누적 자금 흐름 값이다.
pub struct AdlState {
    value: f64,
    wire_order: CheckpointFieldOrder,
}

/// Chaikin oscillator의 ADL과 빠른·느린 smoother다.
pub struct ChaikinState {
    value: f64,
    fast: Option<Smoother>,
    slow: Option<Smoother>,
    fast_period: usize,
    slow_period: usize,
    wire_order: CheckpointFieldOrder,
}

/// Force Index의 직전 종가와 EMA smoother다.
pub struct ForceIndexState {
    previous: f64,
    smoother: Option<Smoother>,
    period: usize,
    wire_order: CheckpointFieldOrder,
}

/// Volume oscillator의 빠른·느린 거래량 ring이다.
pub struct VolumeOscillatorState {
    fast: Option<Ring>,
    slow: Option<Ring>,
    fast_period: usize,
    slow_period: usize,
    wire_order: CheckpointFieldOrder,
}

/// Vortex의 직전 봉과 TR·양·음 이동 ring이다.
pub struct VortexState {
    previous: Option<PreviousBar>,
    true_range: Option<Ring>,
    positive: Option<Ring>,
    negative: Option<Ring>,
    period: usize,
    wire_order: CheckpointFieldOrder,
}

/// Vortex가 다음 TR/VI 계산에 사용하는 직전 봉의 최소 필드다.
#[derive(Clone)]
struct PreviousBar {
    high: f64,
    low: f64,
    close: f64,
    wire_order: CheckpointFieldOrder,
}

impl VolumeState {
    /// 한 봉을 source의 연산 순서대로 처리한다.
    pub fn step(&mut self, bar: &Bar, _index: usize) -> Result<IndicatorOutputRow, JsError> {
        Ok(match self {
            Self::Obv(state) => step_obv(state, bar),
            Self::Mfi(state) => step_mfi(state, bar),
            Self::Cmf(state) => step_cmf(state, bar),
            Self::Adl(state) => step_adl(state, bar),
            Self::Chaikin(state) => step_chaikin(state, bar),
            Self::ForceIndex(state) => step_force_index(state, bar),
            Self::VolumeOscillator(state) => step_volume_oscillator(state, bar),
            Self::Vortex(state) => step_vortex(state, bar),
        })
    }

    /// 초기 상태와 지연 생성 helper를 소스 키 순서대로 wire JSON으로 복사한다.
    pub fn snapshot(&self) -> JsValue {
        let state = match self {
            Self::Obv(state) => state.to_wire(),
            Self::Mfi(state) => state.to_wire(),
            Self::Cmf(state) => state.to_wire(),
            Self::Adl(state) => state.to_wire(),
            Self::Chaikin(state) => state.to_wire(),
            Self::ForceIndex(state) => state.to_wire(),
            Self::VolumeOscillator(state) => state.to_wire(),
            Self::Vortex(state) => state.to_wire(),
        };
        canonical_checkpoint(&state)
    }

    /// 검증된 checkpoint의 구조를 typed state로 원자 복원한다.
    ///
    /// `self`에 든 factory period와 fast/slow 설정은 유지한다. 전체 의미 검증은 공통
    /// checkpoint validator가 이 메서드보다 먼저 수행한다.
    pub fn restore(&mut self, wire: &JsValue) -> Result<(), JsError> {
        let restored = match self {
            Self::Obv(_) => Self::Obv(ObvState::from_wire(wire)?),
            Self::Mfi(state) => Self::Mfi(MfiState::from_wire(wire, state.period)?),
            Self::Cmf(state) => Self::Cmf(CmfState::from_wire(wire, state.period)?),
            Self::Adl(_) => Self::Adl(AdlState::from_wire(wire)?),
            Self::Chaikin(state) => Self::Chaikin(ChaikinState::from_wire(
                wire,
                state.fast_period,
                state.slow_period,
            )?),
            Self::ForceIndex(state) => {
                Self::ForceIndex(ForceIndexState::from_wire(wire, state.period)?)
            }
            Self::VolumeOscillator(state) => Self::VolumeOscillator(
                VolumeOscillatorState::from_wire(wire, state.fast_period, state.slow_period)?,
            ),
            Self::Vortex(state) => Self::Vortex(VortexState::from_wire(wire, state.period)?),
        };
        *self = restored;
        Ok(())
    }
}

/// 공통 파라미터를 보존하고, 정확한 volume factory를 cold 생성한다.
pub fn create(
    program: IndicatorProgram,
    raw_params: &JsValue,
) -> Result<CreatedIndicator<VolumeState>, JsError> {
    let params = validate_indicator_params(raw_params)?;
    let (state, output_names, parameter_order) = match program {
        IndicatorProgram::Obv => (VolumeState::Obv(ObvState::new()), VALUE_OUTPUT, &[][..]),
        IndicatorProgram::Mfi => {
            let period = period_parameter(&params, "period", 14)?;
            (
                VolumeState::Mfi(MfiState::new(period)),
                VALUE_OUTPUT,
                &["period"][..],
            )
        }
        IndicatorProgram::Cmf => {
            let period = period_parameter(&params, "period", 20)?;
            (
                VolumeState::Cmf(CmfState::new(period)),
                VALUE_OUTPUT,
                &["period"][..],
            )
        }
        IndicatorProgram::Adl => (VolumeState::Adl(AdlState::new()), VALUE_OUTPUT, &[][..]),
        IndicatorProgram::Chaikin => {
            let fast = period_parameter(&params, "fast", 3)?;
            let slow = period_parameter(&params, "slow", 10)?;
            if fast >= slow {
                return Err(range_error("Fast < slow"));
            }
            (
                VolumeState::Chaikin(ChaikinState::new(fast, slow)),
                VALUE_OUTPUT,
                &["fast", "slow"][..],
            )
        }
        IndicatorProgram::ForceIndex => {
            let period = period_parameter(&params, "period", 13)?;
            (
                VolumeState::ForceIndex(ForceIndexState::new(period)),
                VALUE_OUTPUT,
                &["period"][..],
            )
        }
        IndicatorProgram::VolumeOscillator => {
            let fast = period_parameter(&params, "fast", 14)?;
            let slow = period_parameter(&params, "slow", 28)?;
            if fast >= slow {
                return Err(range_error("Fast < slow"));
            }
            (
                VolumeState::VolumeOscillator(VolumeOscillatorState::new(fast, slow)),
                VALUE_OUTPUT,
                &["fast", "slow"][..],
            )
        }
        IndicatorProgram::Vortex => {
            let period = period_parameter(&params, "period", 14)?;
            (
                VolumeState::Vortex(VortexState::new(period)),
                VORTEX_OUTPUTS,
                &["period"][..],
            )
        }
        _ => return Err(type_error("Volume indicator program required")),
    };
    let definition = IndicatorDefinition::new(
        program,
        params.ordered_copy(parameter_order)?,
        output_names,
        Vec::new(),
        IndicatorProvenance::Builtin,
    )?;
    Ok(CreatedIndicator { definition, state })
}

impl ObvState {
    fn new() -> Self {
        Self {
            previous: f64::NAN,
            value: 0.0,
            wire_order: source_order(OBV_KEYS, &["previous", "value"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("previous", Some(JsValue::Number(self.previous))),
            ("value", Some(JsValue::Number(self.value))),
        ])
    }

    fn from_wire(wire: &JsValue) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, OBV_KEYS, OBV_KEYS)?;
        Ok(Self {
            previous: number_field(&record, "previous")?,
            value: number_field(&record, "value")?,
            wire_order,
        })
    }
}

impl MfiState {
    fn new(period: usize) -> Self {
        Self {
            previous: f64::NAN,
            positive: None,
            negative: None,
            period,
            wire_order: source_order(MFI_KEYS, &["previous"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("previous", Some(JsValue::Number(self.previous))),
            ("p", self.positive.as_ref().map(Ring::to_wire)),
            ("n", self.negative.as_ref().map(Ring::to_wire)),
        ])
    }

    fn from_wire(wire: &JsValue, period: usize) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, MFI_KEYS, &["previous"])?;
        Ok(Self {
            previous: number_field(&record, "previous")?,
            positive: optional_ring_field(&record, "p")?,
            negative: optional_ring_field(&record, "n")?,
            period,
            wire_order,
        })
    }
}

impl CmfState {
    fn new(period: usize) -> Self {
        Self {
            flow: None,
            volume: None,
            period,
            wire_order: CheckpointFieldOrder::empty(),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("f", self.flow.as_ref().map(Ring::to_wire)),
            ("v", self.volume.as_ref().map(Ring::to_wire)),
        ])
    }

    fn from_wire(wire: &JsValue, period: usize) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, CMF_KEYS, &[])?;
        Ok(Self {
            flow: optional_ring_field(&record, "f")?,
            volume: optional_ring_field(&record, "v")?,
            period,
            wire_order,
        })
    }
}

impl AdlState {
    fn new() -> Self {
        Self {
            value: 0.0,
            wire_order: source_order(ADL_KEYS, &["value"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order
            .ordered_present_object(&[("value", Some(JsValue::Number(self.value)))])
    }

    fn from_wire(wire: &JsValue) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, ADL_KEYS, ADL_KEYS)?;
        Ok(Self {
            value: number_field(&record, "value")?,
            wire_order,
        })
    }
}

impl ChaikinState {
    fn new(fast_period: usize, slow_period: usize) -> Self {
        Self {
            value: 0.0,
            fast: None,
            slow: None,
            fast_period,
            slow_period,
            wire_order: source_order(CHAIKIN_KEYS, &["value"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("value", Some(JsValue::Number(self.value))),
            ("f", self.fast.as_ref().map(Smoother::to_wire)),
            ("l", self.slow.as_ref().map(Smoother::to_wire)),
        ])
    }

    fn from_wire(wire: &JsValue, fast_period: usize, slow_period: usize) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, CHAIKIN_KEYS, &["value"])?;
        Ok(Self {
            value: number_field(&record, "value")?,
            fast: optional_smoother_field(&record, "f")?,
            slow: optional_smoother_field(&record, "l")?,
            fast_period,
            slow_period,
            wire_order,
        })
    }
}

impl ForceIndexState {
    fn new(period: usize) -> Self {
        Self {
            previous: f64::NAN,
            smoother: None,
            period,
            wire_order: source_order(FORCE_INDEX_KEYS, &["previous"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("previous", Some(JsValue::Number(self.previous))),
            ("e", self.smoother.as_ref().map(Smoother::to_wire)),
        ])
    }

    fn from_wire(wire: &JsValue, period: usize) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, FORCE_INDEX_KEYS, &["previous"])?;
        Ok(Self {
            previous: number_field(&record, "previous")?,
            smoother: optional_smoother_field(&record, "e")?,
            period,
            wire_order,
        })
    }
}

impl VolumeOscillatorState {
    fn new(fast_period: usize, slow_period: usize) -> Self {
        Self {
            fast: None,
            slow: None,
            fast_period,
            slow_period,
            wire_order: CheckpointFieldOrder::empty(),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("f", self.fast.as_ref().map(Ring::to_wire)),
            ("l", self.slow.as_ref().map(Ring::to_wire)),
        ])
    }

    fn from_wire(wire: &JsValue, fast_period: usize, slow_period: usize) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, VOLUME_OSCILLATOR_KEYS, &[])?;
        Ok(Self {
            fast: optional_ring_field(&record, "f")?,
            slow: optional_ring_field(&record, "l")?,
            fast_period,
            slow_period,
            wire_order,
        })
    }
}

impl VortexState {
    fn new(period: usize) -> Self {
        Self {
            previous: None,
            true_range: None,
            positive: None,
            negative: None,
            period,
            wire_order: source_order(VORTEX_KEYS, &["previous"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            (
                "previous",
                Some(
                    self.previous
                        .as_ref()
                        .map_or(JsValue::Null, PreviousBar::to_wire),
                ),
            ),
            ("tr", self.true_range.as_ref().map(Ring::to_wire)),
            ("p", self.positive.as_ref().map(Ring::to_wire)),
            ("m", self.negative.as_ref().map(Ring::to_wire)),
        ])
    }

    fn from_wire(wire: &JsValue, period: usize) -> Result<Self, JsError> {
        let (record, wire_order) = root_record(wire, VORTEX_KEYS, &["previous"])?;
        let previous = match record.get(&key("previous")) {
            Some(JsValue::Null) => None,
            Some(value) => Some(PreviousBar::from_wire(value)?),
            None => return Err(checkpoint_error("state keys")),
        };
        Ok(Self {
            previous,
            true_range: optional_ring_field(&record, "tr")?,
            positive: optional_ring_field(&record, "p")?,
            negative: optional_ring_field(&record, "m")?,
            period,
            wire_order,
        })
    }
}

impl PreviousBar {
    fn from_bar(bar: &Bar) -> Self {
        Self {
            high: bar.high,
            low: bar.low,
            close: bar.close,
            wire_order: source_order(&["high", "low", "close"], &["high", "low", "close"]),
        }
    }

    fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_present_object(&[
            ("high", Some(JsValue::Number(self.high))),
            ("low", Some(JsValue::Number(self.low))),
            ("close", Some(JsValue::Number(self.close))),
        ])
    }

    fn from_wire(value: &JsValue) -> Result<Self, JsError> {
        let JsValue::Object(record) = value else {
            return Err(checkpoint_error("state record"));
        };
        record_fields(record, &["high", "low", "close"], &["high", "low", "close"])?;
        let wire_order = CheckpointFieldOrder::capture(value, &["high", "low", "close"])
            .ok_or_else(|| checkpoint_error("state keys"))?;
        Ok(Self {
            high: number_field(record, "high")?,
            low: number_field(record, "low")?,
            close: number_field(record, "close")?,
            wire_order,
        })
    }
}

fn step_obv(state: &mut ObvState, bar: &Bar) -> IndicatorOutputRow {
    if state.previous.is_finite() {
        state.value += js_sign(bar.close - state.previous) * bar.volume;
    }
    state.previous = bar.close;
    IndicatorOutputRow::one(state.value)
}

fn step_mfi(state: &mut MfiState, bar: &Bar) -> IndicatorOutputRow {
    let typical_price = (bar.high + bar.low + bar.close) / 3.0;
    let sign = js_sign(typical_price - state.previous);
    state.previous = typical_price;
    if !sign.is_finite() {
        return IndicatorOutputRow::one(f64::NAN);
    }
    let positive = roll_field(
        &mut state.positive,
        &mut state.wire_order,
        1,
        if sign > 0.0 {
            typical_price * bar.volume
        } else {
            0.0
        },
        state.period,
    );
    let negative = roll_field(
        &mut state.negative,
        &mut state.wire_order,
        2,
        if sign < 0.0 {
            typical_price * bar.volume
        } else {
            0.0
        },
        state.period,
    );
    let value = if !positive.is_finite() {
        f64::NAN
    } else if positive == 0.0 && negative == 0.0 {
        50.0
    } else if negative == 0.0 {
        100.0
    } else {
        100.0 - 100.0 / (1.0 + positive / negative)
    };
    IndicatorOutputRow::one(value)
}

fn step_cmf(state: &mut CmfState, bar: &Bar) -> IndicatorOutputRow {
    let flow_value = money_flow(bar);
    let flow = roll_field(
        &mut state.flow,
        &mut state.wire_order,
        0,
        flow_value,
        state.period,
    );
    let volume = roll_field(
        &mut state.volume,
        &mut state.wire_order,
        1,
        bar.volume,
        state.period,
    );
    IndicatorOutputRow::one(if !flow.is_finite() || volume == 0.0 {
        f64::NAN
    } else {
        flow / volume
    })
}

fn step_adl(state: &mut AdlState, bar: &Bar) -> IndicatorOutputRow {
    state.value += money_flow(bar);
    IndicatorOutputRow::one(state.value)
}

fn step_chaikin(state: &mut ChaikinState, bar: &Bar) -> IndicatorOutputRow {
    state.value += money_flow(bar);
    let fast = smooth_field(
        &mut state.fast,
        &mut state.wire_order,
        1,
        state.value,
        state.fast_period,
    );
    let slow = smooth_field(
        &mut state.slow,
        &mut state.wire_order,
        2,
        state.value,
        state.slow_period,
    );
    IndicatorOutputRow::one(fast - slow)
}

fn step_force_index(state: &mut ForceIndexState, bar: &Bar) -> IndicatorOutputRow {
    let value = (bar.close - state.previous) * bar.volume;
    state.previous = bar.close;
    let value = smooth_field(
        &mut state.smoother,
        &mut state.wire_order,
        1,
        value,
        state.period,
    );
    IndicatorOutputRow::one(value)
}

fn step_volume_oscillator(state: &mut VolumeOscillatorState, bar: &Bar) -> IndicatorOutputRow {
    let fast = roll_field(
        &mut state.fast,
        &mut state.wire_order,
        0,
        bar.volume,
        state.fast_period,
    );
    let slow = roll_field(
        &mut state.slow,
        &mut state.wire_order,
        1,
        bar.volume,
        state.slow_period,
    );
    IndicatorOutputRow::one(if slow == 0.0 {
        f64::NAN
    } else {
        100.0 * (fast - slow) / slow
    })
}

fn step_vortex(state: &mut VortexState, bar: &Bar) -> IndicatorOutputRow {
    let previous = state
        .previous
        .as_ref()
        .map(|previous| (previous.high, previous.low, previous.close));
    state.previous = Some(PreviousBar::from_bar(bar));
    let Some((previous_high, previous_low, previous_close)) = previous else {
        return IndicatorOutputRow::two(f64::NAN, f64::NAN);
    };
    let tr = roll_field(
        &mut state.true_range,
        &mut state.wire_order,
        1,
        true_range(bar, previous_close),
        state.period,
    );
    let positive = roll_field(
        &mut state.positive,
        &mut state.wire_order,
        2,
        (bar.high - previous_low).abs(),
        state.period,
    );
    let negative = roll_field(
        &mut state.negative,
        &mut state.wire_order,
        3,
        (bar.low - previous_high).abs(),
        state.period,
    );
    if tr == 0.0 {
        IndicatorOutputRow::two(f64::NAN, f64::NAN)
    } else {
        IndicatorOutputRow::two(positive / tr, negative / tr)
    }
}

fn money_flow(bar: &Bar) -> f64 {
    if bar.high == bar.low {
        0.0
    } else {
        ((2.0 * bar.close - bar.high - bar.low) / (bar.high - bar.low)) * bar.volume
    }
}

fn roll_field(
    state: &mut Option<Ring>,
    root_order: &mut CheckpointFieldOrder,
    root_index: usize,
    value: f64,
    period: usize,
) -> f64 {
    let absent = state.is_none();
    let output = roll(state, value, period);
    if absent && state.is_some() {
        root_order.touch(root_index);
    }
    output
}

fn smooth_field(
    state: &mut Option<Smoother>,
    root_order: &mut CheckpointFieldOrder,
    root_index: usize,
    value: f64,
    period: usize,
) -> f64 {
    let absent = state.is_none();
    let output = smooth(state, value, period, 2.0 / (period as f64 + 1.0));
    if absent && state.is_some() {
        root_order.touch(root_index);
    }
    output
}

fn period_parameter(
    params: &OrderedIndicatorParams,
    key: &str,
    default: usize,
) -> Result<usize, JsError> {
    let Some(value) = params.get(key) else {
        return Ok(default);
    };
    match value {
        IndicatorParamValue::Number(value) => validate_period(*value),
        IndicatorParamValue::String(_) => Err(range_error("Period must be 1..10000")),
    }
}

fn source_order(allowed: &[&str], present: &[&str]) -> CheckpointFieldOrder {
    let mut order = CheckpointFieldOrder::empty();
    for name in present {
        if let Some(index) = allowed.iter().position(|field| field == name) {
            order.touch(index);
        }
    }
    order
}

fn root_record(
    value: &JsValue,
    allowed: &[&str],
    required: &[&str],
) -> Result<(JsObject, CheckpointFieldOrder), JsError> {
    let JsValue::Object(record) = value else {
        return Err(checkpoint_error("state record"));
    };
    let order = CheckpointFieldOrder::capture_present(value, allowed)
        .ok_or_else(|| checkpoint_error("state keys"))?;
    if required
        .iter()
        .any(|field| record.get(&key(field)).is_none())
    {
        return Err(checkpoint_error("state keys"));
    }
    Ok((record.clone(), order))
}

fn record_fields(record: &JsObject, allowed: &[&str], required: &[&str]) -> Result<(), JsError> {
    if record
        .iter()
        .any(|(field, _)| !allowed.iter().any(|allowed| field == &key(allowed)))
        || required
            .iter()
            .any(|field| record.get(&key(field)).is_none())
    {
        return Err(checkpoint_error("state keys"));
    }
    Ok(())
}

fn number_field(record: &JsObject, field: &str) -> Result<f64, JsError> {
    match record.get(&key(field)) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(checkpoint_error("state number")),
    }
}

fn optional_ring_field(record: &JsObject, field: &str) -> Result<Option<Ring>, JsError> {
    record.get(&key(field)).map(ring_from_wire).transpose()
}

fn optional_smoother_field(record: &JsObject, field: &str) -> Result<Option<Smoother>, JsError> {
    record.get(&key(field)).map(smoother_from_wire).transpose()
}

fn ring_from_wire(value: &JsValue) -> Result<Ring, JsError> {
    let JsValue::Object(record) = value else {
        return Err(checkpoint_error("rolling state"));
    };
    let values = match record.get(&key("a")) {
        Some(JsValue::Array(values)) => values
            .iter()
            .map(|value| match value {
                JsValue::Number(value) => Ok(*value),
                _ => Err(checkpoint_error("rolling state number")),
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(checkpoint_error("rolling state array")),
    };
    let mut ring = Ring::from_parts(
        values,
        number_field(record, "head")?,
        number_field(record, "sum")?,
    );
    if !ring.capture_wire_order(value) {
        return Err(checkpoint_error("rolling state keys"));
    }
    Ok(ring)
}

fn smoother_from_wire(value: &JsValue) -> Result<Smoother, JsError> {
    let JsValue::Object(record) = value else {
        return Err(checkpoint_error("smoothing state"));
    };
    let mut smoother = Smoother::from_parts(
        number_field(record, "count")?,
        number_field(record, "sum")?,
        number_field(record, "value")?,
    );
    if !smoother.capture_wire_order(value) {
        return Err(checkpoint_error("smoothing state keys"));
    }
    Ok(smoother)
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
