//! 모멘텀·범위 builtin 14종의 typed factory, hot-loop 상태와 checkpoint wire 변환이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

use crate::data::Bar;
use crate::indicator_helpers::{
    CheckpointFieldOrder, ExtremeEntry, ExtremeQueue, Ring, Smoother, canonical_checkpoint,
    extreme, rebase_roll, roll, smooth, true_range,
};
use crate::indicator_params::{
    IndicatorParamValue, OrderedIndicatorParams, validate_indicator_params, validate_period,
};
use crate::indicator_types::{
    CreatedIndicator, IndicatorDefinition, IndicatorOutputRow, IndicatorProgram,
    IndicatorProvenance, PlotOffset,
};

const RSI_KEYS: &[&str] = &["previous", "g", "l"];
const ATR_KEYS: &[&str] = &["previous", "tr"];
const CHANNEL_KEYS: &[&str] = &["h", "l"];
const STOCHASTIC_KEYS: &[&str] = &["h", "l", "k", "d"];
const ROC_KEYS: &[&str] = &["a", "head"];
const CCI_KEYS: &[&str] = &["tp"];
const ADX_KEYS: &[&str] = &["previous", "tr", "p", "m", "dx"];
const KELTNER_KEYS: &[&str] = &["previous", "e", "a"];
const SUPERTREND_KEYS: &[&str] = &["previous", "upper", "lower", "direction", "a"];
const ICHIMOKU_KEYS: &[&str] = &["th", "tl", "kh", "kl", "bh", "bl"];
const STOCH_RSI_KEYS: &[&str] = &["previous", "valid", "k", "d", "g", "l", "h", "z"];
const SAR_KEYS: &[&str] = &["previous", "older", "sar", "ep", "af", "direction"];

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn number_or(params: &OrderedIndicatorParams, key: &str, default: f64) -> f64 {
    match params.get(key) {
        None => default,
        Some(IndicatorParamValue::Number(value)) => *value,
        Some(IndicatorParamValue::String(_)) => f64::NAN,
    }
}

fn param_period(
    params: &OrderedIndicatorParams,
    key: &str,
    default: f64,
) -> Result<usize, JsError> {
    validate_period(number_or(params, key, default))
}

fn definition(
    program: IndicatorProgram,
    params: OrderedIndicatorParams,
    outputs: &'static [&'static str],
    offsets: Vec<PlotOffset>,
) -> Result<IndicatorDefinition, JsError> {
    IndicatorDefinition::new(
        program,
        params,
        outputs,
        offsets,
        IndicatorProvenance::Builtin,
    )
}

/// 모멘텀·범위 지표의 config와 typed hot-loop 상태다.
#[derive(Clone, Debug)]
pub struct MomentumState {
    inner: MomentumInner,
}

#[derive(Clone, Debug)]
enum MomentumInner {
    Rsi(RsiState),
    Atr(AtrState),
    Donchian(ChannelState),
    Aroon(ChannelState),
    Stochastic(StochasticState),
    Roc(RocState),
    WilliamsR(ChannelState),
    Cci(CciState),
    Adx(AdxState),
    Keltner(KeltnerState),
    Supertrend(SupertrendState),
    Ichimoku(IchimokuState),
    StochRsi(StochRsiState),
    ParabolicSar(SarState),
}

#[derive(Clone, Debug)]
struct RsiState {
    period: usize,
    previous: f64,
    gain: Option<Smoother>,
    loss: Option<Smoother>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct AtrState {
    period: usize,
    previous: f64,
    tr: Option<Smoother>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct ChannelState {
    period: usize,
    high: Option<ExtremeQueue>,
    low: Option<ExtremeQueue>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct StochasticState {
    period: usize,
    smooth_k: usize,
    smooth_d: usize,
    high: Option<ExtremeQueue>,
    low: Option<ExtremeQueue>,
    k: Option<Ring>,
    d: Option<Ring>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct RocState {
    period: usize,
    values: Vec<f64>,
    head: f64,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct CciState {
    period: usize,
    typical: Option<Ring>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct Bar3 {
    high: f64,
    low: f64,
    close: f64,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct AdxState {
    period: usize,
    previous: Option<Bar3>,
    tr: Option<Smoother>,
    plus: Option<Smoother>,
    minus: Option<Smoother>,
    dx: Option<Smoother>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct KeltnerState {
    period: usize,
    atr_period: usize,
    multiplier: f64,
    previous: f64,
    ema: Option<Smoother>,
    atr: Option<Smoother>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct SupertrendState {
    period: usize,
    multiplier: f64,
    previous: f64,
    upper: f64,
    lower: f64,
    direction: f64,
    atr: Option<Smoother>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct IchimokuState {
    conversion: usize,
    base: usize,
    span: usize,
    th: Option<ExtremeQueue>,
    tl: Option<ExtremeQueue>,
    kh: Option<ExtremeQueue>,
    kl: Option<ExtremeQueue>,
    bh: Option<ExtremeQueue>,
    bl: Option<ExtremeQueue>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct StochRsiState {
    period: usize,
    stoch_period: usize,
    smooth_k: usize,
    smooth_d: usize,
    previous: f64,
    valid: f64,
    k: Option<Ring>,
    d: Option<Ring>,
    gain: Option<Smoother>,
    loss: Option<Smoother>,
    high: Option<ExtremeQueue>,
    low: Option<ExtremeQueue>,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
struct SarState {
    step: f64,
    max: f64,
    previous: Option<Bar3>,
    older: Option<Bar3>,
    sar: f64,
    ep: f64,
    af: f64,
    direction: f64,
    order: CheckpointFieldOrder,
}

/// 공통 params 검증 뒤 지정한 14종 지표를 만든다.
pub fn create(
    program: IndicatorProgram,
    params_value: &JsValue,
) -> Result<CreatedIndicator<MomentumState>, JsError> {
    let raw = validate_indicator_params(params_value)?;
    let (declared, outputs, offsets, inner) = match program {
        IndicatorProgram::Rsi => {
            let period = param_period(&raw, "period", 14.0)?;
            (
                &["period"][..],
                &["value"][..],
                Vec::new(),
                MomentumInner::Rsi(RsiState {
                    period,
                    previous: f64::NAN,
                    gain: None,
                    loss: None,
                    order: CheckpointFieldOrder::source(1),
                }),
            )
        }
        IndicatorProgram::Atr => {
            let period = param_period(&raw, "period", 14.0)?;
            (
                &["period"][..],
                &["value"][..],
                Vec::new(),
                MomentumInner::Atr(AtrState {
                    period,
                    previous: f64::NAN,
                    tr: None,
                    order: CheckpointFieldOrder::source(1),
                }),
            )
        }
        IndicatorProgram::Donchian => {
            let period = param_period(&raw, "period", 20.0)?;
            (
                &["period"][..],
                &["middle", "upper", "lower"][..],
                Vec::new(),
                MomentumInner::Donchian(ChannelState {
                    period,
                    high: None,
                    low: None,
                    order: CheckpointFieldOrder::empty(),
                }),
            )
        }
        IndicatorProgram::Aroon => {
            let period = param_period(&raw, "period", 25.0)?;
            (
                &["period"][..],
                &["up", "down", "oscillator"][..],
                Vec::new(),
                MomentumInner::Aroon(ChannelState {
                    period,
                    high: None,
                    low: None,
                    order: CheckpointFieldOrder::empty(),
                }),
            )
        }
        IndicatorProgram::Stochastic => {
            let period = param_period(&raw, "period", 14.0)?;
            let smooth_k = param_period(&raw, "smoothK", 3.0)?;
            let smooth_d = param_period(&raw, "smoothD", 3.0)?;
            (
                &["period", "smoothK", "smoothD"][..],
                &["k", "d"][..],
                Vec::new(),
                MomentumInner::Stochastic(StochasticState {
                    period,
                    smooth_k,
                    smooth_d,
                    high: None,
                    low: None,
                    k: None,
                    d: None,
                    order: CheckpointFieldOrder::empty(),
                }),
            )
        }
        IndicatorProgram::Roc => {
            let period = param_period(&raw, "period", 12.0)?;
            (
                &["period"][..],
                &["value"][..],
                Vec::new(),
                MomentumInner::Roc(RocState {
                    period,
                    values: Vec::new(),
                    head: 0.0,
                    order: CheckpointFieldOrder::source(2),
                }),
            )
        }
        IndicatorProgram::WilliamsR => {
            let period = param_period(&raw, "period", 14.0)?;
            (
                &["period"][..],
                &["value"][..],
                Vec::new(),
                MomentumInner::WilliamsR(ChannelState {
                    period,
                    high: None,
                    low: None,
                    order: CheckpointFieldOrder::empty(),
                }),
            )
        }
        IndicatorProgram::Cci => {
            let period = param_period(&raw, "period", 20.0)?;
            (
                &["period"][..],
                &["value"][..],
                Vec::new(),
                MomentumInner::Cci(CciState {
                    period,
                    typical: None,
                    order: CheckpointFieldOrder::empty(),
                }),
            )
        }
        IndicatorProgram::Adx => {
            let period = param_period(&raw, "period", 14.0)?;
            (
                &["period"][..],
                &["adx", "plusDI", "minusDI"][..],
                Vec::new(),
                MomentumInner::Adx(AdxState {
                    period,
                    previous: None,
                    tr: None,
                    plus: None,
                    minus: None,
                    dx: None,
                    order: CheckpointFieldOrder::source(1),
                }),
            )
        }
        IndicatorProgram::Keltner => {
            let period = param_period(&raw, "period", 20.0)?;
            let atr_period = param_period(&raw, "atrPeriod", 10.0)?;
            let multiplier = number_or(&raw, "multiplier", 2.0);
            if !multiplier.is_finite() || multiplier < 0.0 {
                return Err(range_error("Multiplier"));
            }
            (
                &["period", "atrPeriod", "multiplier"][..],
                &["middle", "upper", "lower"][..],
                Vec::new(),
                MomentumInner::Keltner(KeltnerState {
                    period,
                    atr_period,
                    multiplier,
                    previous: f64::NAN,
                    ema: None,
                    atr: None,
                    order: CheckpointFieldOrder::source(1),
                }),
            )
        }
        IndicatorProgram::Supertrend => {
            let period = param_period(&raw, "period", 10.0)?;
            let multiplier = number_or(&raw, "multiplier", 3.0);
            if !multiplier.is_finite() || multiplier <= 0.0 {
                return Err(range_error("Multiplier"));
            }
            (
                &["period", "multiplier"][..],
                &["value", "direction"][..],
                Vec::new(),
                MomentumInner::Supertrend(SupertrendState {
                    period,
                    multiplier,
                    previous: f64::NAN,
                    upper: f64::NAN,
                    lower: f64::NAN,
                    direction: 1.0,
                    atr: None,
                    order: CheckpointFieldOrder::source(4),
                }),
            )
        }
        IndicatorProgram::Ichimoku => {
            let conversion = param_period(&raw, "conversion", 9.0)?;
            let base = param_period(&raw, "base", 26.0)?;
            let span = param_period(&raw, "span", 52.0)?;
            let displacement = number_or(&raw, "displacement", 26.0);
            if !displacement.is_finite()
                || displacement.fract() != 0.0
                || !(0.0..=10_000.0).contains(&displacement)
            {
                return Err(range_error("Displacement"));
            }
            (
                &["conversion", "base", "span", "displacement"][..],
                &["tenkan", "kijun", "spanA", "spanB", "chikou"][..],
                vec![
                    PlotOffset {
                        output: "spanA",
                        value: displacement,
                    },
                    PlotOffset {
                        output: "spanB",
                        value: displacement,
                    },
                    PlotOffset {
                        output: "chikou",
                        value: -displacement,
                    },
                ],
                MomentumInner::Ichimoku(IchimokuState {
                    conversion,
                    base,
                    span,
                    th: None,
                    tl: None,
                    kh: None,
                    kl: None,
                    bh: None,
                    bl: None,
                    order: CheckpointFieldOrder::empty(),
                }),
            )
        }
        IndicatorProgram::StochRsi => {
            let period = param_period(&raw, "period", 14.0)?;
            let stoch_period = param_period(&raw, "stochPeriod", 14.0)?;
            let smooth_k = param_period(&raw, "smoothK", 3.0)?;
            let smooth_d = param_period(&raw, "smoothD", 3.0)?;
            (
                &["period", "stochPeriod", "smoothK", "smoothD"][..],
                &["k", "d"][..],
                Vec::new(),
                MomentumInner::StochRsi(StochRsiState {
                    period,
                    stoch_period,
                    smooth_k,
                    smooth_d,
                    previous: f64::NAN,
                    valid: 0.0,
                    k: None,
                    d: None,
                    gain: None,
                    loss: None,
                    high: None,
                    low: None,
                    order: CheckpointFieldOrder::source(2),
                }),
            )
        }
        IndicatorProgram::ParabolicSar => {
            let step = number_or(&raw, "step", 0.02);
            let max = number_or(&raw, "max", 0.2);
            if !step.is_finite() || !max.is_finite() || step <= 0.0 || max < step || max > 1.0 {
                return Err(range_error("SAR acceleration"));
            }
            (
                &["step", "max"][..],
                &["value", "direction"][..],
                Vec::new(),
                MomentumInner::ParabolicSar(SarState {
                    step,
                    max,
                    previous: None,
                    older: None,
                    sar: f64::NAN,
                    ep: f64::NAN,
                    af: step,
                    direction: 1.0,
                    order: CheckpointFieldOrder::source(SAR_KEYS.len()),
                }),
            )
        }
        _ => return Err(type_error("Momentum/range indicator required")),
    };
    let params = raw.ordered_copy(declared)?;
    let definition = definition(program, params, outputs, offsets)?;
    Ok(CreatedIndicator {
        definition,
        state: MomentumState { inner },
    })
}

impl MomentumState {
    /// 고정 출력 개수다.
    pub fn output_len(&self) -> usize {
        match self.inner {
            MomentumInner::Rsi(_)
            | MomentumInner::Atr(_)
            | MomentumInner::Roc(_)
            | MomentumInner::WilliamsR(_)
            | MomentumInner::Cci(_) => 1,
            MomentumInner::Stochastic(_)
            | MomentumInner::Supertrend(_)
            | MomentumInner::StochRsi(_)
            | MomentumInner::ParabolicSar(_) => 2,
            MomentumInner::Donchian(_)
            | MomentumInner::Aroon(_)
            | MomentumInner::Adx(_)
            | MomentumInner::Keltner(_) => 3,
            MomentumInner::Ichimoku(_) => 5,
        }
    }

    /// 한 봉을 JS factory 식 순서로 계산한다.
    pub fn step(&mut self, bar: &Bar, index: usize) -> Result<IndicatorOutputRow, JsError> {
        Ok(match &mut self.inner {
            MomentumInner::Rsi(state) => {
                let delta = bar.close - state.previous;
                state.previous = bar.close;
                if !delta.is_finite() {
                    IndicatorOutputRow::one(f64::NAN)
                } else {
                    state.order.touch(1);
                    let gain = smooth(
                        &mut state.gain,
                        js_max(&[0.0, delta]),
                        state.period,
                        1.0 / state.period as f64,
                    );
                    state.order.touch(2);
                    let loss = smooth(
                        &mut state.loss,
                        js_max(&[0.0, -delta]),
                        state.period,
                        1.0 / state.period as f64,
                    );
                    let value = if !gain.is_finite() {
                        f64::NAN
                    } else if gain == 0.0 && loss == 0.0 {
                        50.0
                    } else if loss == 0.0 {
                        100.0
                    } else {
                        100.0 - 100.0 / (1.0 + gain / loss)
                    };
                    IndicatorOutputRow::one(value)
                }
            }
            MomentumInner::Atr(state) => {
                let tr = true_range(bar, state.previous);
                state.previous = bar.close;
                state.order.touch(1);
                IndicatorOutputRow::one(smooth(
                    &mut state.tr,
                    tr,
                    state.period,
                    1.0 / state.period as f64,
                ))
            }
            MomentumInner::Donchian(state) => {
                state.order.touch(0);
                let high = extreme(&mut state.high, bar.high, state.period, index, true);
                state.order.touch(1);
                let low = extreme(&mut state.low, bar.low, state.period, index, false);
                IndicatorOutputRow::three((high + low) / 2.0, high, low)
            }
            MomentumInner::Aroon(state) => {
                state.order.touch(0);
                extreme(&mut state.high, bar.high, state.period + 1, index, true);
                state.order.touch(1);
                extreme(&mut state.low, bar.low, state.period + 1, index, false);
                if index < state.period {
                    IndicatorOutputRow::three(f64::NAN, f64::NAN, f64::NAN)
                } else {
                    let high = state.high.as_ref().expect("extreme created");
                    let low = state.low.as_ref().expect("extreme created");
                    let high_index = high.entries[high.head as usize].index as usize;
                    let low_index = low.entries[low.head as usize].index as usize;
                    let up =
                        100.0 * (state.period - (index - high_index)) as f64 / state.period as f64;
                    let down =
                        100.0 * (state.period - (index - low_index)) as f64 / state.period as f64;
                    IndicatorOutputRow::three(up, down, up - down)
                }
            }
            MomentumInner::Stochastic(state) => {
                state.order.touch(0);
                let high = extreme(&mut state.high, bar.high, state.period, index, true);
                state.order.touch(1);
                let low = extreme(&mut state.low, bar.low, state.period, index, false);
                let raw = if !high.is_finite() {
                    f64::NAN
                } else if high == low {
                    50.0
                } else {
                    100.0 * (bar.close - low) / (high - low)
                };
                state.order.touch(2);
                let k = roll(&mut state.k, raw, state.smooth_k);
                state.order.touch(3);
                let d = roll(&mut state.d, k, state.smooth_d);
                IndicatorOutputRow::two(k, d)
            }
            MomentumInner::Roc(state) => {
                let mut result = f64::NAN;
                if state.values.len() == state.period {
                    let head = state.head as usize;
                    let old = state.values[head];
                    result = if old == 0.0 {
                        f64::NAN
                    } else {
                        (bar.close / old - 1.0) * 100.0
                    };
                    state.values[head] = bar.close;
                    state.head = (state.head + 1.0) % state.period as f64;
                } else {
                    state.values.push(bar.close);
                }
                IndicatorOutputRow::one(result)
            }
            MomentumInner::WilliamsR(state) => {
                state.order.touch(0);
                let high = extreme(&mut state.high, bar.high, state.period, index, true);
                state.order.touch(1);
                let low = extreme(&mut state.low, bar.low, state.period, index, false);
                IndicatorOutputRow::one(if !high.is_finite() {
                    f64::NAN
                } else if high == low {
                    -50.0
                } else {
                    -100.0 * (high - bar.close) / (high - low)
                })
            }
            MomentumInner::Cci(state) => {
                let typical = (bar.high + bar.low + bar.close) / 3.0;
                state.order.touch(0);
                roll(&mut state.typical, typical, state.period);
                let ring = state.typical.as_mut().expect("roll created");
                if ring.values.len() < state.period {
                    IndicatorOutputRow::one(f64::NAN)
                } else {
                    let mean = rebase_roll(ring) / state.period as f64;
                    if !mean.is_finite() {
                        IndicatorOutputRow::one(f64::NAN)
                    } else {
                        let mut deviation = 0.0;
                        for value in &ring.values {
                            deviation += (*value - mean).abs();
                        }
                        deviation /= state.period as f64;
                        IndicatorOutputRow::one(if deviation == 0.0 {
                            0.0
                        } else {
                            (typical - mean) / (0.015 * deviation)
                        })
                    }
                }
            }
            MomentumInner::Adx(state) => {
                let previous = state.previous.clone();
                state.previous = Some(Bar3::from(bar));
                let Some(previous) = previous else {
                    return Ok(IndicatorOutputRow::three(f64::NAN, f64::NAN, f64::NAN));
                };
                let up = bar.high - previous.high;
                let down = previous.low - bar.low;
                let alpha = 1.0 / state.period as f64;
                state.order.touch(1);
                let tr = smooth(
                    &mut state.tr,
                    true_range(bar, previous.close),
                    state.period,
                    alpha,
                );
                state.order.touch(2);
                let plus = smooth(
                    &mut state.plus,
                    if up > down && up > 0.0 { up } else { 0.0 },
                    state.period,
                    alpha,
                );
                state.order.touch(3);
                let minus = smooth(
                    &mut state.minus,
                    if down > up && down > 0.0 { down } else { 0.0 },
                    state.period,
                    alpha,
                );
                let plus_di = if !tr.is_finite() {
                    f64::NAN
                } else if tr == 0.0 {
                    0.0
                } else {
                    100.0 * plus / tr
                };
                let minus_di = if !tr.is_finite() {
                    f64::NAN
                } else if tr == 0.0 {
                    0.0
                } else {
                    100.0 * minus / tr
                };
                let dx = if plus_di + minus_di == 0.0 {
                    0.0
                } else {
                    100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di)
                };
                state.order.touch(4);
                IndicatorOutputRow::three(
                    smooth(&mut state.dx, dx, state.period, alpha),
                    plus_di,
                    minus_di,
                )
            }
            MomentumInner::Keltner(state) => {
                let alpha = 2.0 / (state.period + 1) as f64;
                state.order.touch(1);
                let middle = smooth(&mut state.ema, bar.close, state.period, alpha);
                state.order.touch(2);
                let atr = smooth(
                    &mut state.atr,
                    true_range(bar, state.previous),
                    state.atr_period,
                    1.0 / state.atr_period as f64,
                );
                state.previous = bar.close;
                IndicatorOutputRow::three(
                    middle,
                    middle + state.multiplier * atr,
                    middle - state.multiplier * atr,
                )
            }
            MomentumInner::Supertrend(state) => {
                state.order.touch(4);
                let atr = smooth(
                    &mut state.atr,
                    true_range(bar, state.previous),
                    state.period,
                    1.0 / state.period as f64,
                );
                let previous = state.previous;
                state.previous = bar.close;
                if !atr.is_finite() {
                    IndicatorOutputRow::two(f64::NAN, f64::NAN)
                } else {
                    let upper = (bar.high + bar.low) / 2.0 + state.multiplier * atr;
                    let lower = (bar.high + bar.low) / 2.0 - state.multiplier * atr;
                    if !state.upper.is_finite() {
                        state.upper = upper;
                        state.lower = lower;
                    } else {
                        let old_upper = state.upper;
                        let old_lower = state.lower;
                        state.upper = if upper < old_upper || previous > old_upper {
                            upper
                        } else {
                            old_upper
                        };
                        state.lower = if lower > old_lower || previous < old_lower {
                            lower
                        } else {
                            old_lower
                        };
                        if state.direction < 0.0 && bar.close > state.upper {
                            state.direction = 1.0;
                        } else if state.direction > 0.0 && bar.close < state.lower {
                            state.direction = -1.0;
                        }
                    }
                    IndicatorOutputRow::two(
                        if state.direction > 0.0 {
                            state.lower
                        } else {
                            state.upper
                        },
                        state.direction,
                    )
                }
            }
            MomentumInner::Ichimoku(state) => {
                state.order.touch(0);
                let th = extreme(&mut state.th, bar.high, state.conversion, index, true);
                state.order.touch(1);
                let tl = extreme(&mut state.tl, bar.low, state.conversion, index, false);
                state.order.touch(2);
                let kh = extreme(&mut state.kh, bar.high, state.base, index, true);
                state.order.touch(3);
                let kl = extreme(&mut state.kl, bar.low, state.base, index, false);
                state.order.touch(4);
                let bh = extreme(&mut state.bh, bar.high, state.span, index, true);
                state.order.touch(5);
                let bl = extreme(&mut state.bl, bar.low, state.span, index, false);
                let tenkan = (th + tl) / 2.0;
                let kijun = (kh + kl) / 2.0;
                IndicatorOutputRow::five(
                    tenkan,
                    kijun,
                    (tenkan + kijun) / 2.0,
                    (bh + bl) / 2.0,
                    bar.close,
                )
            }
            MomentumInner::StochRsi(state) => {
                let delta = bar.close - state.previous;
                state.previous = bar.close;
                let mut rsi = f64::NAN;
                if delta.is_finite() {
                    state.order.touch(4);
                    let gain = smooth(
                        &mut state.gain,
                        js_max(&[0.0, delta]),
                        state.period,
                        1.0 / state.period as f64,
                    );
                    state.order.touch(5);
                    let loss = smooth(
                        &mut state.loss,
                        js_max(&[0.0, -delta]),
                        state.period,
                        1.0 / state.period as f64,
                    );
                    rsi = if !gain.is_finite() {
                        f64::NAN
                    } else if gain == 0.0 && loss == 0.0 {
                        50.0
                    } else if loss == 0.0 {
                        100.0
                    } else {
                        100.0 - 100.0 / (1.0 + gain / loss)
                    };
                }
                let mut raw = f64::NAN;
                if rsi.is_finite() {
                    let valid = state.valid as usize;
                    state.valid += 1.0;
                    state.order.touch(6);
                    let high = extreme(&mut state.high, rsi, state.stoch_period, valid, true);
                    state.order.touch(7);
                    let low = extreme(&mut state.low, rsi, state.stoch_period, valid, false);
                    raw = if !high.is_finite() {
                        f64::NAN
                    } else if high == low {
                        50.0
                    } else {
                        100.0 * (rsi - low) / (high - low)
                    };
                }
                state.order.touch(2);
                let k = roll(&mut state.k, raw, state.smooth_k);
                state.order.touch(3);
                let d = roll(&mut state.d, k, state.smooth_d);
                IndicatorOutputRow::two(k, d)
            }
            MomentumInner::ParabolicSar(state) => {
                let Some(previous) = state.previous.clone() else {
                    state.previous = Some(Bar3::from(bar));
                    return Ok(IndicatorOutputRow::two(f64::NAN, f64::NAN));
                };
                if !state.sar.is_finite() {
                    state.direction = if bar.close >= previous.close {
                        1.0
                    } else {
                        -1.0
                    };
                    state.sar = if state.direction > 0.0 {
                        js_min(&[previous.low, bar.low])
                    } else {
                        js_max(&[previous.high, bar.high])
                    };
                    state.ep = if state.direction > 0.0 {
                        js_max(&[previous.high, bar.high])
                    } else {
                        js_min(&[previous.low, bar.low])
                    };
                } else {
                    let mut sar = state.sar + state.af * (state.ep - state.sar);
                    let older = state.older.clone().unwrap_or_else(|| previous.clone());
                    sar = if state.direction > 0.0 {
                        js_min(&[sar, previous.low, older.low])
                    } else {
                        js_max(&[sar, previous.high, older.high])
                    };
                    if if state.direction > 0.0 {
                        bar.low < sar
                    } else {
                        bar.high > sar
                    } {
                        state.direction = -state.direction;
                        sar = state.ep;
                        state.ep = if state.direction > 0.0 {
                            bar.high
                        } else {
                            bar.low
                        };
                        state.af = state.step;
                    } else if if state.direction > 0.0 {
                        bar.high > state.ep
                    } else {
                        bar.low < state.ep
                    } {
                        state.ep = if state.direction > 0.0 {
                            bar.high
                        } else {
                            bar.low
                        };
                        state.af = js_min(&[state.max, state.af + state.step]);
                    }
                    state.sar = sar;
                }
                state.older = Some(previous);
                state.previous = Some(Bar3::from(bar));
                IndicatorOutputRow::two(state.sar, state.direction)
            }
        })
    }

    /// 현재 typed state의 canonical checkpoint를 만든다.
    pub fn snapshot(&self) -> JsValue {
        match &self.inner {
            MomentumInner::Rsi(state) => state.order.ordered_present_object(&[
                ("previous", Some(JsValue::Number(state.previous))),
                ("g", state.gain.as_ref().map(smoother_snapshot)),
                ("l", state.loss.as_ref().map(smoother_snapshot)),
            ]),
            MomentumInner::Atr(state) => state.order.ordered_present_object(&[
                ("previous", Some(JsValue::Number(state.previous))),
                ("tr", state.tr.as_ref().map(smoother_snapshot)),
            ]),
            MomentumInner::Donchian(state)
            | MomentumInner::Aroon(state)
            | MomentumInner::WilliamsR(state) => channel_snapshot(state),
            MomentumInner::Stochastic(state) => state.order.ordered_present_object(&[
                (
                    "h",
                    state.high.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "l",
                    state.low.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                ("k", state.k.as_ref().map(Ring::to_wire)),
                ("d", state.d.as_ref().map(Ring::to_wire)),
            ]),
            MomentumInner::Roc(state) => state.order.ordered_object(&[
                (
                    "a",
                    JsValue::Array(state.values.iter().copied().map(JsValue::Number).collect()),
                ),
                ("head", JsValue::Number(state.head)),
            ]),
            MomentumInner::Cci(state) => state
                .order
                .ordered_present_object(&[("tp", state.typical.as_ref().map(Ring::to_wire))]),
            MomentumInner::Adx(state) => state.order.ordered_present_object(&[
                ("previous", Some(bar3_wire(state.previous.clone()))),
                ("tr", state.tr.as_ref().map(smoother_snapshot)),
                ("p", state.plus.as_ref().map(smoother_snapshot)),
                ("m", state.minus.as_ref().map(smoother_snapshot)),
                ("dx", state.dx.as_ref().map(smoother_snapshot)),
            ]),
            MomentumInner::Keltner(state) => state.order.ordered_present_object(&[
                ("previous", Some(JsValue::Number(state.previous))),
                ("e", state.ema.as_ref().map(smoother_snapshot)),
                ("a", state.atr.as_ref().map(smoother_snapshot)),
            ]),
            MomentumInner::Supertrend(state) => state.order.ordered_present_object(&[
                ("previous", Some(JsValue::Number(state.previous))),
                ("upper", Some(JsValue::Number(state.upper))),
                ("lower", Some(JsValue::Number(state.lower))),
                ("direction", Some(JsValue::Number(state.direction))),
                ("a", state.atr.as_ref().map(smoother_snapshot)),
            ]),
            MomentumInner::Ichimoku(state) => state.order.ordered_present_object(&[
                (
                    "th",
                    state.th.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "tl",
                    state.tl.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "kh",
                    state.kh.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "kl",
                    state.kl.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "bh",
                    state.bh.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "bl",
                    state.bl.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
            ]),
            MomentumInner::StochRsi(state) => state.order.ordered_present_object(&[
                ("previous", Some(JsValue::Number(state.previous))),
                ("valid", Some(JsValue::Number(state.valid))),
                ("k", state.k.as_ref().map(Ring::to_wire)),
                ("d", state.d.as_ref().map(Ring::to_wire)),
                ("g", state.gain.as_ref().map(smoother_snapshot)),
                ("l", state.loss.as_ref().map(smoother_snapshot)),
                (
                    "h",
                    state.high.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
                (
                    "z",
                    state.low.as_ref().map(ExtremeQueue::canonical_snapshot),
                ),
            ]),
            MomentumInner::ParabolicSar(state) => state.order.ordered_object(&[
                ("previous", bar3_wire(state.previous.clone())),
                ("older", bar3_wire(state.older.clone())),
                ("sar", JsValue::Number(state.sar)),
                ("ep", JsValue::Number(state.ep)),
                ("af", JsValue::Number(state.af)),
                ("direction", JsValue::Number(state.direction)),
            ]),
        }
    }

    /// 구조적으로 올바른 checkpoint wire를 현재 factory config를 유지한 채 복원한다.
    pub fn restore(&mut self, wire: &JsValue) -> Result<(), JsError> {
        restore_inner(&mut self.inner, wire)
    }
}

impl From<&Bar> for Bar3 {
    fn from(bar: &Bar) -> Self {
        Self {
            high: bar.high,
            low: bar.low,
            close: bar.close,
            order: CheckpointFieldOrder::source(3),
        }
    }
}

fn channel_snapshot(state: &ChannelState) -> JsValue {
    state.order.ordered_present_object(&[
        (
            "h",
            state.high.as_ref().map(ExtremeQueue::canonical_snapshot),
        ),
        (
            "l",
            state.low.as_ref().map(ExtremeQueue::canonical_snapshot),
        ),
    ])
}

fn smoother_snapshot(state: &Smoother) -> JsValue {
    canonical_checkpoint(&state.to_wire())
}

fn bar3_wire(value: Option<Bar3>) -> JsValue {
    match value {
        None => JsValue::Null,
        Some(value) => value.order.ordered_object(&[
            ("high", JsValue::Number(value.high)),
            ("low", JsValue::Number(value.low)),
            ("close", JsValue::Number(value.close)),
        ]),
    }
}

fn restore_inner(inner: &mut MomentumInner, wire: &JsValue) -> Result<(), JsError> {
    let mut next = inner.clone();
    match &mut next {
        MomentumInner::Rsi(state) => {
            let (object, order) = state_object(wire, RSI_KEYS)?;
            state.previous = required_number(object, "previous")?;
            state.gain = optional_smoother(object, "g")?;
            state.loss = optional_smoother(object, "l")?;
            state.order = order;
        }
        MomentumInner::Atr(state) => {
            let (object, order) = state_object(wire, ATR_KEYS)?;
            state.previous = required_number(object, "previous")?;
            state.tr = optional_smoother(object, "tr")?;
            state.order = order;
        }
        MomentumInner::Donchian(state)
        | MomentumInner::Aroon(state)
        | MomentumInner::WilliamsR(state) => {
            restore_channel(state, wire)?;
        }
        MomentumInner::Stochastic(state) => {
            let (object, order) = state_object(wire, STOCHASTIC_KEYS)?;
            state.high = optional_extreme(object, "h")?;
            state.low = optional_extreme(object, "l")?;
            state.k = optional_ring(object, "k")?;
            state.d = optional_ring(object, "d")?;
            state.order = order;
        }
        MomentumInner::Roc(state) => {
            let (object, order) = state_object(wire, ROC_KEYS)?;
            state.values = required_number_array(object, "a")?;
            state.head = required_number(object, "head")?;
            state.order = order;
        }
        MomentumInner::Cci(state) => {
            let (object, order) = state_object(wire, CCI_KEYS)?;
            state.typical = optional_ring(object, "tp")?;
            state.order = order;
        }
        MomentumInner::Adx(state) => {
            let (object, order) = state_object(wire, ADX_KEYS)?;
            state.previous = required_bar3(object, "previous")?;
            state.tr = optional_smoother(object, "tr")?;
            state.plus = optional_smoother(object, "p")?;
            state.minus = optional_smoother(object, "m")?;
            state.dx = optional_smoother(object, "dx")?;
            state.order = order;
        }
        MomentumInner::Keltner(state) => {
            let (object, order) = state_object(wire, KELTNER_KEYS)?;
            state.previous = required_number(object, "previous")?;
            state.ema = optional_smoother(object, "e")?;
            state.atr = optional_smoother(object, "a")?;
            state.order = order;
        }
        MomentumInner::Supertrend(state) => {
            let (object, order) = state_object(wire, SUPERTREND_KEYS)?;
            state.previous = required_number(object, "previous")?;
            state.upper = required_number(object, "upper")?;
            state.lower = required_number(object, "lower")?;
            state.direction = required_number(object, "direction")?;
            state.atr = optional_smoother(object, "a")?;
            state.order = order;
        }
        MomentumInner::Ichimoku(state) => {
            let (object, order) = state_object(wire, ICHIMOKU_KEYS)?;
            state.th = optional_extreme(object, "th")?;
            state.tl = optional_extreme(object, "tl")?;
            state.kh = optional_extreme(object, "kh")?;
            state.kl = optional_extreme(object, "kl")?;
            state.bh = optional_extreme(object, "bh")?;
            state.bl = optional_extreme(object, "bl")?;
            state.order = order;
        }
        MomentumInner::StochRsi(state) => {
            let (object, order) = state_object(wire, STOCH_RSI_KEYS)?;
            state.previous = required_number(object, "previous")?;
            state.valid = required_number(object, "valid")?;
            state.k = optional_ring(object, "k")?;
            state.d = optional_ring(object, "d")?;
            state.gain = optional_smoother(object, "g")?;
            state.loss = optional_smoother(object, "l")?;
            state.high = optional_extreme(object, "h")?;
            state.low = optional_extreme(object, "z")?;
            state.order = order;
        }
        MomentumInner::ParabolicSar(state) => {
            let (object, order) = state_object(wire, SAR_KEYS)?;
            state.previous = required_bar3(object, "previous")?;
            state.older = required_bar3(object, "older")?;
            state.sar = required_number(object, "sar")?;
            state.ep = required_number(object, "ep")?;
            state.af = required_number(object, "af")?;
            state.direction = required_number(object, "direction")?;
            state.order = order;
        }
    }
    *inner = next;
    Ok(())
}

fn restore_channel(state: &mut ChannelState, wire: &JsValue) -> Result<(), JsError> {
    let (object, order) = state_object(wire, CHANNEL_KEYS)?;
    state.high = optional_extreme(object, "h")?;
    state.low = optional_extreme(object, "l")?;
    state.order = order;
    Ok(())
}

fn state_object<'a>(
    wire: &'a JsValue,
    allowed: &[&str],
) -> Result<(&'a JsObject, CheckpointFieldOrder), JsError> {
    let JsValue::Object(object) = wire else {
        return Err(type_error("Indicator checkpoint object"));
    };
    let Some(order) = CheckpointFieldOrder::capture_present(wire, allowed) else {
        return Err(type_error("Indicator checkpoint fields"));
    };
    Ok((object, order))
}

fn get<'a>(object: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    object.get(&JsString::from_str(key))
}

fn required_number(object: &JsObject, key: &str) -> Result<f64, JsError> {
    match get(object, key) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(type_error("Indicator checkpoint number")),
    }
}

fn required_number_array(object: &JsObject, key: &str) -> Result<Vec<f64>, JsError> {
    let Some(JsValue::Array(values)) = get(object, key) else {
        return Err(type_error("Indicator checkpoint array"));
    };
    values
        .iter()
        .map(|value| match value {
            JsValue::Number(value) => Ok(*value),
            _ => Err(type_error("Indicator checkpoint number")),
        })
        .collect()
}

fn optional_ring(object: &JsObject, key: &str) -> Result<Option<Ring>, JsError> {
    get(object, key).map(parse_ring).transpose()
}

fn parse_ring(value: &JsValue) -> Result<Ring, JsError> {
    let JsValue::Object(object) = value else {
        return Err(type_error("Indicator checkpoint ring"));
    };
    let values = required_number_array(object, "a")?;
    let head = required_number(object, "head")?;
    let sum = required_number(object, "sum")?;
    let mut ring = Ring::from_parts(values, head, sum);
    if !ring.capture_wire_order(value) {
        return Err(type_error("Indicator checkpoint ring"));
    }
    Ok(ring)
}

fn optional_smoother(object: &JsObject, key: &str) -> Result<Option<Smoother>, JsError> {
    get(object, key).map(parse_smoother).transpose()
}

fn parse_smoother(value: &JsValue) -> Result<Smoother, JsError> {
    let JsValue::Object(object) = value else {
        return Err(type_error("Indicator checkpoint smoother"));
    };
    let mut smoother = Smoother::from_parts(
        required_number(object, "count")?,
        required_number(object, "sum")?,
        required_number(object, "value")?,
    );
    if !smoother.capture_wire_order(value) {
        return Err(type_error("Indicator checkpoint smoother"));
    }
    Ok(smoother)
}

fn optional_extreme(object: &JsObject, key: &str) -> Result<Option<ExtremeQueue>, JsError> {
    get(object, key).map(parse_extreme).transpose()
}

fn parse_extreme(value: &JsValue) -> Result<ExtremeQueue, JsError> {
    let JsValue::Object(object) = value else {
        return Err(type_error("Indicator checkpoint extreme"));
    };
    let Some(JsValue::Array(rows)) = get(object, "a") else {
        return Err(type_error("Indicator checkpoint extreme"));
    };
    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let JsValue::Array(pair) = row else {
            return Err(type_error("Indicator checkpoint extreme"));
        };
        let [JsValue::Number(index), JsValue::Number(value)] = pair.as_slice() else {
            return Err(type_error("Indicator checkpoint extreme"));
        };
        entries.push(ExtremeEntry::from_parts(*index, *value));
    }
    let head = required_number(object, "head")?;
    if CheckpointFieldOrder::capture(value, &["a", "head"]).is_none() {
        return Err(type_error("Indicator checkpoint extreme"));
    }
    Ok(ExtremeQueue::from_parts(entries, head))
}

fn required_bar3(object: &JsObject, key: &str) -> Result<Option<Bar3>, JsError> {
    match get(object, key) {
        Some(JsValue::Null) => Ok(None),
        Some(value @ JsValue::Object(object)) => {
            let Some(order) = CheckpointFieldOrder::capture(value, &["high", "low", "close"])
            else {
                return Err(type_error("Indicator checkpoint OHLC"));
            };
            Ok(Some(Bar3 {
                high: required_number(object, "high")?,
                low: required_number(object, "low")?,
                close: required_number(object, "close")?,
                order,
            }))
        }
        _ => Err(type_error("Indicator checkpoint OHLC")),
    }
}
