//! 이동평균 계열 11개 builtin의 typed factory, 한 행 계산과 checkpoint wire 변환이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::js_max;
use barochart_js::string::JsString;

use crate::data::Bar;
use crate::indicator_helpers::{
    CheckpointFieldOrder, Ring, Smoother, VwmaAccumulator, canonical_checkpoint, ema_recover,
    rebase_bollinger, roll, sma_roll, smooth, vwma_step,
};
use crate::indicator_params::{
    IndicatorParamValue, OrderedIndicatorParams, validate_indicator_params, validate_period,
};
use crate::indicator_registry::metadata_for_program;
use crate::indicator_types::{
    BarField, CreatedIndicator, IndicatorDefinition, IndicatorOutputRow, IndicatorProgram,
    IndicatorProvenance,
};

const SMA_FIELDS: [&str; 1] = ["r"];
const EMA_FIELDS: [&str; 1] = ["e"];
const WMA_FIELDS: [&str; 1] = ["r"];
const TRIPLE_FIELDS: [&str; 3] = ["f", "l", "s"];
const DEMA_FIELDS: [&str; 2] = ["a", "b"];
const TEMA_FIELDS: [&str; 3] = ["a", "b", "c"];
const HMA_FIELDS: [&str; 3] = ["h", "f", "r"];
const TRIX_FIELDS: [&str; 4] = ["previous", "a", "b", "c"];
const BOLLINGER_FIELDS: [&str; 4] = ["mean", "m2", "a", "head"];

/// Source 열을 쓰는 단일 helper 상태다.
#[derive(Clone, Debug)]
pub struct SourcedRingState {
    period: usize,
    source: BarField,
    ring: Option<Ring>,
    order: CheckpointFieldOrder,
}

/// Source 열을 쓰는 단일 smoother 상태다.
#[derive(Clone, Debug)]
pub struct SourcedSmootherState {
    period: usize,
    source: BarField,
    smoother: Option<Smoother>,
    order: CheckpointFieldOrder,
}

/// Source가 고정된 단일 raw ring 상태다.
#[derive(Clone, Debug)]
pub struct RingAverageState {
    period: usize,
    ring: Option<Ring>,
    order: CheckpointFieldOrder,
}

/// VWMA 기간과 compensated accumulator다.
#[derive(Clone, Debug)]
pub struct VwmaState {
    period: usize,
    state: VwmaAccumulator,
}

/// MACD/PPO가 공유하는 세 smoother와 기간이다.
#[derive(Clone, Debug)]
pub struct TripleSmootherState {
    fast: usize,
    slow: usize,
    signal: usize,
    fast_state: Option<Smoother>,
    slow_state: Option<Smoother>,
    signal_state: Option<Smoother>,
    order: CheckpointFieldOrder,
}

/// Bollinger의 Welford/ring 상태다.
#[derive(Clone, Debug)]
pub struct BollingerState {
    period: usize,
    deviation: f64,
    mean: f64,
    m2: f64,
    values: Vec<f64>,
    head: f64,
    order: CheckpointFieldOrder,
}

/// DEMA/TEMA의 smoother cascade다.
#[derive(Clone, Debug)]
pub struct CascadeState {
    period: usize,
    a: Option<Smoother>,
    b: Option<Smoother>,
    c: Option<Smoother>,
    order: CheckpointFieldOrder,
}

/// HMA의 half/full/root ring 상태다.
#[derive(Clone, Debug)]
pub struct HmaState {
    period: usize,
    half: usize,
    root: usize,
    half_state: Option<Ring>,
    full_state: Option<Ring>,
    root_state: Option<Ring>,
    order: CheckpointFieldOrder,
}

/// TRIX의 이전 triple-EMA 값과 세 smoother다.
#[derive(Clone, Debug)]
pub struct TrixState {
    period: usize,
    previous: f64,
    a: Option<Smoother>,
    b: Option<Smoother>,
    c: Option<Smoother>,
    order: CheckpointFieldOrder,
}

/// Average leaf가 소유하는 11개 typed state다.
#[derive(Clone, Debug)]
pub enum AverageState {
    /// 단순 이동평균이다.
    Sma(SourcedRingState),
    /// 거래량 가중 이동평균이다.
    Vwma(VwmaState),
    /// 지수 이동평균이다.
    Ema(SourcedSmootherState),
    /// 선형 가중 이동평균이다.
    Wma(RingAverageState),
    /// 이동평균 수렴·확산이다.
    Macd(TripleSmootherState),
    /// 볼린저 밴드다.
    Bollinger(BollingerState),
    /// 이중 지수 이동평균이다.
    Dema(CascadeState),
    /// 삼중 지수 이동평균이다.
    Tema(CascadeState),
    /// 헐 이동평균이다.
    Hma(HmaState),
    /// TRIX다.
    Trix(TrixState),
    /// 백분율 가격 오실레이터다.
    Ppo(TripleSmootherState),
}

/// Generic params 검증 뒤 average program의 definition과 typed 초기 상태를 만든다.
pub fn create(
    program: IndicatorProgram,
    params: &JsValue,
) -> Result<CreatedIndicator<AverageState>, JsError> {
    let validated = validate_indicator_params(params)?;
    let state = match program {
        IndicatorProgram::Sma => AverageState::Sma(SourcedRingState {
            period: period(&validated, "period", 20.0)?,
            source: source(&validated),
            ring: None,
            order: CheckpointFieldOrder::empty(),
        }),
        IndicatorProgram::Vwma => AverageState::Vwma(VwmaState {
            period: period(&validated, "period", 20.0)?,
            state: VwmaAccumulator::default(),
        }),
        IndicatorProgram::Ema => AverageState::Ema(SourcedSmootherState {
            period: period(&validated, "period", 20.0)?,
            source: source(&validated),
            smoother: None,
            order: CheckpointFieldOrder::empty(),
        }),
        IndicatorProgram::Wma => AverageState::Wma(RingAverageState {
            period: period(&validated, "period", 20.0)?,
            ring: None,
            order: CheckpointFieldOrder::empty(),
        }),
        IndicatorProgram::Macd => {
            let fast = period(&validated, "fast", 12.0)?;
            let slow = period(&validated, "slow", 26.0)?;
            let signal = period(&validated, "signal", 9.0)?;
            if fast >= slow {
                return Err(range_error("MACD fast < slow"));
            }
            AverageState::Macd(TripleSmootherState::new(fast, slow, signal))
        }
        IndicatorProgram::Bollinger => {
            let period = period(&validated, "period", 20.0)?;
            let deviation = number(&validated, "deviation", 2.0);
            if !deviation.is_finite() || deviation < 0.0 {
                return Err(range_error("Deviation"));
            }
            AverageState::Bollinger(BollingerState {
                period,
                deviation,
                mean: 0.0,
                m2: 0.0,
                values: Vec::new(),
                head: 0.0,
                order: CheckpointFieldOrder::source(BOLLINGER_FIELDS.len()),
            })
        }
        IndicatorProgram::Dema => {
            AverageState::Dema(CascadeState::new(period(&validated, "period", 20.0)?))
        }
        IndicatorProgram::Tema => {
            AverageState::Tema(CascadeState::new(period(&validated, "period", 20.0)?))
        }
        IndicatorProgram::Hma => {
            let period = period(&validated, "period", 20.0)?;
            AverageState::Hma(HmaState {
                period,
                half: <usize as Ord>::max(1, period / 2),
                root: <usize as Ord>::max(1, (period as f64).sqrt().floor() as usize),
                half_state: None,
                full_state: None,
                root_state: None,
                order: CheckpointFieldOrder::empty(),
            })
        }
        IndicatorProgram::Trix => AverageState::Trix(TrixState {
            period: period(&validated, "period", 15.0)?,
            previous: f64::NAN,
            a: None,
            b: None,
            c: None,
            order: CheckpointFieldOrder::source(1),
        }),
        IndicatorProgram::Ppo => {
            let fast = period(&validated, "fast", 12.0)?;
            let slow = period(&validated, "slow", 26.0)?;
            let signal = period(&validated, "signal", 9.0)?;
            if fast >= slow {
                return Err(range_error("Fast < slow"));
            }
            AverageState::Ppo(TripleSmootherState::new(fast, slow, signal))
        }
        _ => return Err(type_error("Average indicator program")),
    };
    let metadata = metadata_for_program(program);
    let params = validated.ordered_copy(metadata.parameter_order)?;
    let definition = IndicatorDefinition::new(
        program,
        params,
        metadata.outputs,
        Vec::new(),
        IndicatorProvenance::Builtin,
    )?;
    Ok(CreatedIndicator { definition, state })
}

impl TripleSmootherState {
    fn new(fast: usize, slow: usize, signal: usize) -> Self {
        Self {
            fast,
            slow,
            signal,
            fast_state: None,
            slow_state: None,
            signal_state: None,
            order: CheckpointFieldOrder::empty(),
        }
    }
}

impl CascadeState {
    fn new(period: usize) -> Self {
        Self {
            period,
            a: None,
            b: None,
            c: None,
            order: CheckpointFieldOrder::empty(),
        }
    }
}

impl AverageState {
    /// 한 봉을 source 식 순서로 계산한다. Output Infinity 검사는 상위 engine이 담당한다.
    pub fn step(&mut self, bar: &Bar, index: usize) -> Result<IndicatorOutputRow, JsError> {
        let output = match self {
            Self::Sma(state) => {
                state.order.touch(0);
                IndicatorOutputRow::one(sma_roll(
                    &mut state.ring,
                    state.source.read(bar),
                    state.period,
                ))
            }
            Self::Vwma(state) => {
                IndicatorOutputRow::one(vwma_step(&mut state.state, bar, index, state.period))
            }
            Self::Ema(state) => {
                state.order.touch(0);
                IndicatorOutputRow::one(ema_recover(
                    &mut state.smoother,
                    state.source.read(bar),
                    state.period,
                    2.0 / (state.period as f64 + 1.0),
                ))
            }
            Self::Wma(state) => {
                state.order.touch(0);
                IndicatorOutputRow::one(weighted(&mut state.ring, bar.close, state.period))
            }
            Self::Macd(state) => {
                state.order.touch(0);
                let fast = ema_value(&mut state.fast_state, bar.close, state.fast);
                state.order.touch(1);
                let slow = ema_value(&mut state.slow_state, bar.close, state.slow);
                let value = fast - slow;
                state.order.touch(2);
                let signal = ema_value(&mut state.signal_state, value, state.signal);
                IndicatorOutputRow::three(value, signal, value - signal)
            }
            Self::Bollinger(state) => bollinger_step(state, bar),
            Self::Dema(state) => {
                state.order.touch(0);
                let a = ema_value(&mut state.a, bar.close, state.period);
                state.order.touch(1);
                let b = ema_value(&mut state.b, a, state.period);
                IndicatorOutputRow::one(2.0 * a - b)
            }
            Self::Tema(state) => {
                state.order.touch(0);
                let a = ema_value(&mut state.a, bar.close, state.period);
                state.order.touch(1);
                let b = ema_value(&mut state.b, a, state.period);
                state.order.touch(2);
                let c = ema_value(&mut state.c, b, state.period);
                IndicatorOutputRow::one(3.0 * a - 3.0 * b + c)
            }
            Self::Hma(state) => {
                state.order.touch(0);
                let half = weighted(&mut state.half_state, bar.close, state.half);
                state.order.touch(1);
                let full = weighted(&mut state.full_state, bar.close, state.period);
                state.order.touch(2);
                IndicatorOutputRow::one(weighted(
                    &mut state.root_state,
                    2.0 * half - full,
                    state.root,
                ))
            }
            Self::Trix(state) => {
                state.order.touch(1);
                let a = ema_value(&mut state.a, bar.close, state.period);
                state.order.touch(2);
                let b = ema_value(&mut state.b, a, state.period);
                state.order.touch(3);
                let value = ema_value(&mut state.c, b, state.period);
                let previous = state.previous;
                state.previous = value;
                let change = if !previous.is_finite() || previous == 0.0 {
                    f64::NAN
                } else {
                    (value / previous - 1.0) * 100.0
                };
                IndicatorOutputRow::one(if change.is_finite() { change } else { f64::NAN })
            }
            Self::Ppo(state) => {
                state.order.touch(0);
                let fast = ema_value(&mut state.fast_state, bar.close, state.fast);
                state.order.touch(1);
                let slow = ema_value(&mut state.slow_state, bar.close, state.slow);
                let value = if slow == 0.0 {
                    f64::NAN
                } else {
                    100.0 * (fast - slow) / slow
                };
                state.order.touch(2);
                let signal = ema_value(&mut state.signal_state, value, state.signal);
                IndicatorOutputRow::three(value, signal, value - signal)
            }
        };
        Ok(output)
    }

    /// 현재 typed state를 JS snapshot field order로 복사·canonicalize한다.
    pub fn snapshot(&self) -> JsValue {
        let raw = match self {
            Self::Sma(state) => optional_ring_object(&state.order, &SMA_FIELDS, [&state.ring]),
            Self::Vwma(state) => state.state.to_wire(),
            Self::Ema(state) => {
                optional_smoother_object(&state.order, &EMA_FIELDS, [&state.smoother])
            }
            Self::Wma(state) => optional_ring_object(&state.order, &WMA_FIELDS, [&state.ring]),
            Self::Macd(state) | Self::Ppo(state) => optional_smoother_object(
                &state.order,
                &TRIPLE_FIELDS,
                [&state.fast_state, &state.slow_state, &state.signal_state],
            ),
            Self::Bollinger(state) => state.order.ordered_present_object(&[
                ("mean", Some(JsValue::Number(state.mean))),
                ("m2", Some(JsValue::Number(state.m2))),
                (
                    "a",
                    Some(JsValue::Array(
                        state.values.iter().copied().map(JsValue::Number).collect(),
                    )),
                ),
                ("head", Some(JsValue::Number(state.head))),
            ]),
            Self::Dema(state) => {
                optional_smoother_object(&state.order, &DEMA_FIELDS, [&state.a, &state.b])
            }
            Self::Tema(state) => {
                optional_smoother_object(&state.order, &TEMA_FIELDS, [&state.a, &state.b, &state.c])
            }
            Self::Hma(state) => optional_ring_object(
                &state.order,
                &HMA_FIELDS,
                [&state.half_state, &state.full_state, &state.root_state],
            ),
            Self::Trix(state) => state.order.ordered_present_object(&[
                ("previous", Some(JsValue::Number(state.previous))),
                ("a", state.a.as_ref().map(Smoother::to_wire)),
                ("b", state.b.as_ref().map(Smoother::to_wire)),
                ("c", state.c.as_ref().map(Smoother::to_wire)),
            ]),
        };
        canonical_checkpoint(&raw)
    }

    /// 의미 검증을 마친 wire를 typed state로 원자 변환한다. 구조 오류는 기존 state를 보존한다.
    pub fn restore(&mut self, validated_wire: &JsValue) -> Result<(), JsError> {
        let restored = match self {
            Self::Sma(current) => Self::Sma(SourcedRingState {
                period: current.period,
                source: current.source,
                ring: parse_optional_ring(validated_wire, &SMA_FIELDS, 0)?,
                order: parse_optional_order(validated_wire, &SMA_FIELDS)?,
            }),
            Self::Vwma(current) => Self::Vwma(VwmaState {
                period: current.period,
                state: parse_vwma(validated_wire)?,
            }),
            Self::Ema(current) => Self::Ema(SourcedSmootherState {
                period: current.period,
                source: current.source,
                smoother: parse_optional_smoother(validated_wire, &EMA_FIELDS, 0)?,
                order: parse_optional_order(validated_wire, &EMA_FIELDS)?,
            }),
            Self::Wma(current) => Self::Wma(RingAverageState {
                period: current.period,
                ring: parse_optional_ring(validated_wire, &WMA_FIELDS, 0)?,
                order: parse_optional_order(validated_wire, &WMA_FIELDS)?,
            }),
            Self::Macd(current) => Self::Macd(parse_triple(current, validated_wire)?),
            Self::Ppo(current) => Self::Ppo(parse_triple(current, validated_wire)?),
            Self::Bollinger(current) => Self::Bollinger(parse_bollinger(current, validated_wire)?),
            Self::Dema(current) => Self::Dema(parse_cascade(current, validated_wire, false)?),
            Self::Tema(current) => Self::Tema(parse_cascade(current, validated_wire, true)?),
            Self::Hma(current) => Self::Hma(HmaState {
                period: current.period,
                half: current.half,
                root: current.root,
                half_state: parse_optional_ring(validated_wire, &HMA_FIELDS, 0)?,
                full_state: parse_optional_ring(validated_wire, &HMA_FIELDS, 1)?,
                root_state: parse_optional_ring(validated_wire, &HMA_FIELDS, 2)?,
                order: parse_optional_order(validated_wire, &HMA_FIELDS)?,
            }),
            Self::Trix(current) => Self::Trix(parse_trix(current, validated_wire)?),
        };
        *self = restored;
        Ok(())
    }
}

fn bollinger_step(state: &mut BollingerState, bar: &Bar) -> IndicatorOutputRow {
    let mut cancellation = false;
    if state.values.len() == state.period {
        let head = persisted_index(state.head);
        let old = state.values[head];
        if state.period > 1 {
            let total = state.period as f64 * state.mean;
            let remaining = total - old;
            let next = if total.is_finite() {
                remaining / (state.period - 1) as f64
            } else {
                state.mean + (state.mean - old) / (state.period - 1) as f64
            };
            let removed_m2 = (old - state.mean) * (old - next);
            let scale = js_max(&[total.abs(), old.abs()]);
            let severe = total.is_finite()
                && scale > 0.0
                && remaining.abs() <= scale * f64::EPSILON * 4.0 * state.period as f64;
            cancellation = !next.is_finite()
                || severe
                    && removed_m2.is_finite()
                    && state.m2.is_finite()
                    && removed_m2.abs() >= state.m2.abs() / 2.0;
            state.m2 -= removed_m2;
            state.mean = next;
        } else {
            state.mean = 0.0;
            state.m2 = 0.0;
        }
        state.values[head] = bar.close;
        state.head = (state.head + 1.0) % state.period as f64;
    } else {
        state.values.push(bar.close);
    }
    let count = state.values.len();
    let delta = bar.close - state.mean;
    state.mean += delta / count as f64;
    state.m2 += delta * (bar.close - state.mean);
    if count == state.period && state.period > 1 && (cancellation || state.m2 < 0.0) {
        (state.mean, state.m2) = rebase_bollinger(&state.values, state.head);
    }
    if count < state.period {
        return IndicatorOutputRow::three(f64::NAN, f64::NAN, f64::NAN);
    }
    let deviation = state.deviation * (js_max(&[0.0, state.m2]) / state.period as f64).sqrt();
    IndicatorOutputRow::three(state.mean, state.mean + deviation, state.mean - deviation)
}

fn weighted(state: &mut Option<Ring>, value: f64, period: usize) -> f64 {
    let mean = roll(state, value, period);
    if !mean.is_finite() {
        return f64::NAN;
    }
    let ring = state.as_ref().expect("roll creates a ring");
    let mut total = 0.0;
    for offset in 0..period {
        let index = (ring.head + offset as f64) % period as f64;
        total += ring.values[persisted_index(index)] * (offset + 1) as f64;
    }
    total / (period * (period + 1) / 2) as f64
}

fn ema_value(state: &mut Option<Smoother>, value: f64, period: usize) -> f64 {
    smooth(state, value, period, 2.0 / (period as f64 + 1.0))
}

fn optional_ring_object<const N: usize>(
    order: &CheckpointFieldOrder,
    names: &[&str; N],
    states: [&Option<Ring>; N],
) -> JsValue {
    let fields: Vec<(&str, Option<JsValue>)> = names
        .iter()
        .copied()
        .zip(
            states
                .into_iter()
                .map(|state| state.as_ref().map(Ring::to_wire)),
        )
        .collect();
    order.ordered_present_object(&fields)
}

fn optional_smoother_object<const N: usize>(
    order: &CheckpointFieldOrder,
    names: &[&str; N],
    states: [&Option<Smoother>; N],
) -> JsValue {
    let fields: Vec<(&str, Option<JsValue>)> = names
        .iter()
        .copied()
        .zip(
            states
                .into_iter()
                .map(|state| state.as_ref().map(Smoother::to_wire)),
        )
        .collect();
    order.ordered_present_object(&fields)
}

fn parse_optional_order(
    value: &JsValue,
    allowed: &[&str],
) -> Result<CheckpointFieldOrder, JsError> {
    CheckpointFieldOrder::capture_present(value, allowed).ok_or_else(checkpoint_error)
}

fn parse_optional_ring(
    value: &JsValue,
    allowed: &[&str],
    index: usize,
) -> Result<Option<Ring>, JsError> {
    let object = as_object(value)?;
    match object.get(&JsString::from_str(allowed[index])) {
        Some(value) => parse_ring(value).map(Some),
        None => Ok(None),
    }
}

fn parse_optional_smoother(
    value: &JsValue,
    allowed: &[&str],
    index: usize,
) -> Result<Option<Smoother>, JsError> {
    let object = as_object(value)?;
    match object.get(&JsString::from_str(allowed[index])) {
        Some(value) => parse_smoother(value).map(Some),
        None => Ok(None),
    }
}

fn parse_ring(value: &JsValue) -> Result<Ring, JsError> {
    let object = as_object(value)?;
    let values = number_array(required(object, "a")?)?;
    let mut ring = Ring::from_parts(
        values,
        as_number(required(object, "head")?)?,
        as_number(required(object, "sum")?)?,
    );
    if !ring.capture_wire_order(value) {
        return Err(checkpoint_error());
    }
    Ok(ring)
}

fn parse_smoother(value: &JsValue) -> Result<Smoother, JsError> {
    let object = as_object(value)?;
    let mut state = Smoother::from_parts(
        as_number(required(object, "count")?)?,
        as_number(required(object, "sum")?)?,
        as_number(required(object, "value")?)?,
    );
    if !state.capture_wire_order(value) {
        return Err(checkpoint_error());
    }
    Ok(state)
}

fn parse_vwma(value: &JsValue) -> Result<VwmaAccumulator, JsError> {
    let object = as_object(value)?;
    let values = pair_array(required(object, "a")?)?;
    let sums = pair_array(required(object, "sums")?)?;
    let sums: [[f64; 2]; 3] = sums.try_into().map_err(|_| checkpoint_error())?;
    let mut state = VwmaAccumulator::from_parts(
        values,
        as_number(required(object, "head")?)?,
        sums,
        as_number(required(object, "invalid")?)?,
        as_number(required(object, "positive")?)?,
    );
    if !state.capture_wire_order(value) {
        return Err(checkpoint_error());
    }
    Ok(state)
}

fn parse_triple(
    current: &TripleSmootherState,
    value: &JsValue,
) -> Result<TripleSmootherState, JsError> {
    Ok(TripleSmootherState {
        fast: current.fast,
        slow: current.slow,
        signal: current.signal,
        fast_state: parse_optional_smoother(value, &TRIPLE_FIELDS, 0)?,
        slow_state: parse_optional_smoother(value, &TRIPLE_FIELDS, 1)?,
        signal_state: parse_optional_smoother(value, &TRIPLE_FIELDS, 2)?,
        order: parse_optional_order(value, &TRIPLE_FIELDS)?,
    })
}

fn parse_cascade(
    current: &CascadeState,
    value: &JsValue,
    third: bool,
) -> Result<CascadeState, JsError> {
    let allowed: &[&str] = if third { &TEMA_FIELDS } else { &DEMA_FIELDS };
    Ok(CascadeState {
        period: current.period,
        a: parse_optional_smoother(value, allowed, 0)?,
        b: parse_optional_smoother(value, allowed, 1)?,
        c: if third {
            parse_optional_smoother(value, allowed, 2)?
        } else {
            None
        },
        order: parse_optional_order(value, allowed)?,
    })
}

fn parse_bollinger(current: &BollingerState, value: &JsValue) -> Result<BollingerState, JsError> {
    let object = as_object(value)?;
    let order =
        CheckpointFieldOrder::capture(value, &BOLLINGER_FIELDS).ok_or_else(checkpoint_error)?;
    Ok(BollingerState {
        period: current.period,
        deviation: current.deviation,
        mean: as_number(required(object, "mean")?)?,
        m2: as_number(required(object, "m2")?)?,
        values: number_array(required(object, "a")?)?,
        head: as_number(required(object, "head")?)?,
        order,
    })
}

fn parse_trix(current: &TrixState, value: &JsValue) -> Result<TrixState, JsError> {
    let object = as_object(value)?;
    let order = parse_optional_order(value, &TRIX_FIELDS)?;
    Ok(TrixState {
        period: current.period,
        previous: as_number(required(object, "previous")?)?,
        a: parse_optional_smoother(value, &TRIX_FIELDS, 1)?,
        b: parse_optional_smoother(value, &TRIX_FIELDS, 2)?,
        c: parse_optional_smoother(value, &TRIX_FIELDS, 3)?,
        order,
    })
}

fn as_object(value: &JsValue) -> Result<&JsObject, JsError> {
    let JsValue::Object(value) = value else {
        return Err(checkpoint_error());
    };
    Ok(value)
}

fn required<'a>(object: &'a JsObject, key: &str) -> Result<&'a JsValue, JsError> {
    object
        .get(&JsString::from_str(key))
        .ok_or_else(checkpoint_error)
}

fn as_number(value: &JsValue) -> Result<f64, JsError> {
    let JsValue::Number(value) = value else {
        return Err(checkpoint_error());
    };
    Ok(*value)
}

fn number_array(value: &JsValue) -> Result<Vec<f64>, JsError> {
    let JsValue::Array(values) = value else {
        return Err(checkpoint_error());
    };
    values.iter().map(as_number).collect()
}

fn pair_array(value: &JsValue) -> Result<Vec<[f64; 2]>, JsError> {
    let JsValue::Array(values) = value else {
        return Err(checkpoint_error());
    };
    values
        .iter()
        .map(|value| {
            let JsValue::Array(pair) = value else {
                return Err(checkpoint_error());
            };
            if pair.len() != 2 {
                return Err(checkpoint_error());
            }
            Ok([as_number(&pair[0])?, as_number(&pair[1])?])
        })
        .collect()
}

fn period(params: &OrderedIndicatorParams, key: &str, default: f64) -> Result<usize, JsError> {
    validate_period(number(params, key, default))
}

fn number(params: &OrderedIndicatorParams, key: &str, default: f64) -> f64 {
    match params.get(key) {
        None => default,
        Some(IndicatorParamValue::Number(value)) => *value,
        Some(IndicatorParamValue::String(_)) => f64::NAN,
    }
}

fn source(params: &OrderedIndicatorParams) -> BarField {
    params
        .get("source")
        .map_or(BarField::Close, BarField::from_param)
}

fn persisted_index(value: f64) -> usize {
    debug_assert!(value.is_finite() && value.fract() == 0.0 && value >= 0.0);
    value as usize
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn checkpoint_error() -> JsError {
    type_error("Average indicator checkpoint")
}
