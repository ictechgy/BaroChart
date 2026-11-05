//! 35개 builtin과 정적 pressure의 checkpoint state integrity validator다.

#![forbid(unsafe_code)]

use std::cmp::{max, min};

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::js_max;
use barochart_js::string::JsString;

use crate::checkpoint_codec::safe_checkpoint_parse;
use crate::indicator_helpers::{exact_state_equal, vwma_accumulate};
use crate::indicator_params::{IndicatorParamValue, OrderedIndicatorParams};
use crate::indicator_types::IndicatorProgram;

const MAX_HISTORY: f64 = 4_194_304.0;

fn fail(reason: &str) -> JsError {
    JsError::new(
        "TypeError",
        JsString::from_str(&format!("Checkpoint {reason}")),
    )
}

fn key(name: &str) -> JsString {
    JsString::from_str(name)
}

fn object(value: &JsValue) -> Result<&JsObject, JsError> {
    match value {
        JsValue::Object(object) => Ok(object),
        _ => Err(fail("state record")),
    }
}

fn record<'a>(
    value: &'a JsValue,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a JsObject, JsError> {
    let object = object(value)?;
    if object.iter().any(|(name, _)| {
        !allowed
            .iter()
            .any(|allowed| name.as_units().iter().copied().eq(allowed.encode_utf16()))
    }) || required.iter().any(|name| object.get(&key(name)).is_none())
    {
        return Err(fail("state keys"));
    }
    Ok(object)
}

fn number(value: &JsValue, finite: bool) -> Result<f64, JsError> {
    match value {
        JsValue::Number(value) if !finite || value.is_finite() => Ok(*value),
        _ => Err(fail("state number")),
    }
}

fn field_number(object: &JsObject, name: &str, finite: bool) -> Result<f64, JsError> {
    object
        .get(&key(name))
        .ok_or_else(|| fail("state keys"))
        .and_then(|value| number(value, finite))
}

fn output_number(value: &JsValue) -> Result<f64, JsError> {
    let value = number(value, false)?;
    if value.is_infinite() {
        return Err(fail("output number"));
    }
    Ok(value)
}

fn integer(value: f64, from: f64, to: f64) -> Result<f64, JsError> {
    if !value.is_finite()
        || value.fract() != 0.0
        || value.abs() > 9_007_199_254_740_991.0
        || value < from
        || value > to
    {
        return Err(fail("state integer"));
    }
    Ok(value)
}

fn integer_value(value: &JsValue, from: f64, to: f64) -> Result<f64, JsError> {
    match value {
        JsValue::Number(value) => integer(*value, from, to),
        _ => Err(fail("state integer")),
    }
}

fn param_number(params: &OrderedIndicatorParams, name: &str, fallback: f64) -> f64 {
    match params.get(name) {
        None => fallback,
        Some(IndicatorParamValue::Number(value)) => *value,
        Some(IndicatorParamValue::String(_)) => f64::NAN,
    }
}

fn param_value(params: &OrderedIndicatorParams, name: &str, fallback: f64) -> JsValue {
    match params.get(name) {
        None => JsValue::Number(fallback),
        Some(IndicatorParamValue::Number(value)) => JsValue::Number(*value),
        Some(IndicatorParamValue::String(value)) => JsValue::String(value.clone()),
    }
}

fn period(params: &OrderedIndicatorParams, name: &str, fallback: f64) -> Result<usize, JsError> {
    Ok(integer(param_number(params, name, fallback), 1.0, 10_000.0)? as usize)
}

fn number_array(value: &JsValue, limit: usize, finite: bool) -> Result<Vec<f64>, JsError> {
    let JsValue::Array(values) = value else {
        return Err(fail("state array"));
    };
    if values.len() > limit {
        return Err(fail("state array"));
    }
    values.iter().map(|value| number(value, finite)).collect()
}

fn bar(value: &JsValue) -> Result<[f64; 3], JsError> {
    let object = record(value, &["high", "low", "close"], &["high", "low", "close"])?;
    let high = field_number(object, "high", true)?;
    let low = field_number(object, "low", true)?;
    let close = field_number(object, "close", true)?;
    if low > high || close < low || close > high {
        return Err(fail("previous OHLC"));
    }
    Ok([high, low, close])
}

fn nullable_bar(value: &JsValue) -> Result<Option<[f64; 3]>, JsError> {
    if matches!(value, JsValue::Null) {
        Ok(None)
    } else {
        bar(value).map(Some)
    }
}

fn ring(value: &JsValue, period: usize, index: usize, sum: bool) -> Result<(), JsError> {
    let allowed = if sum {
        &["a", "head", "sum"][..]
    } else {
        &["a", "head"][..]
    };
    let object = record(value, allowed, allowed)?;
    let values = number_array(
        object.get(&key("a")).expect("required"),
        min(period, index),
        true,
    )?;
    let maximum = if values.len() < period {
        0.0
    } else {
        (period - 1) as f64
    };
    integer_value(object.get(&key("head")).expect("required"), 0.0, maximum)?;
    if sum {
        field_number(object, "sum", false)?;
    }
    Ok(())
}

fn smoothing(value: &JsValue, period: usize, index: usize) -> Result<(), JsError> {
    let object = record(
        value,
        &["count", "sum", "value"],
        &["count", "sum", "value"],
    )?;
    let count = integer_value(
        object.get(&key("count")).expect("required"),
        0.0,
        min(period, index) as f64,
    )?;
    field_number(object, "sum", false)?;
    let current = field_number(object, "value", false)?;
    if current.is_infinite() || count < period as f64 && !current.is_nan() {
        return Err(fail("smoothing state"));
    }
    Ok(())
}

fn extreme(value: &JsValue, period: usize, index: usize, maximum: bool) -> Result<(), JsError> {
    let object = record(value, &["a", "head"], &["a", "head"])?;
    let Some(JsValue::Array(rows)) = object.get(&key("a")) else {
        return Err(fail("extreme queue"));
    };
    if rows.len() > min(period, index) {
        return Err(fail("extreme queue"));
    }
    if !matches!(object.get(&key("head")), Some(JsValue::Number(head)) if *head == 0.0) {
        return Err(fail("extreme queue head"));
    }
    let mut previous_index = -1.0;
    let mut previous_value = None;
    for row in rows {
        let JsValue::Array(pair) = row else {
            return Err(fail("extreme pair"));
        };
        let [index_value, value] = pair.as_slice() else {
            return Err(fail("extreme pair"));
        };
        let index_value = integer_value(
            index_value,
            index.saturating_sub(period) as f64,
            index as f64 - 1.0,
        )?;
        let value = number(value, true)?;
        if index_value <= previous_index
            || previous_value.is_some_and(|previous| {
                if maximum {
                    value >= previous
                } else {
                    value <= previous
                }
            })
        {
            return Err(fail("extreme ordering"));
        }
        previous_index = index_value;
        previous_value = Some(value);
    }
    if index > 0 && rows.is_empty() {
        return Err(fail("empty extreme queue"));
    }
    Ok(())
}

fn paired(object: &JsObject, left: &str, right: &str) -> Result<(), JsError> {
    if object.get(&key(left)).is_some() != object.get(&key(right)).is_some() {
        return Err(fail("paired state"));
    }
    Ok(())
}

fn optional_smoothing(
    object: &JsObject,
    name: &str,
    period: usize,
    index: usize,
    optional: bool,
) -> Result<(), JsError> {
    match object.get(&key(name)) {
        Some(value) => smoothing(value, period, index),
        None if optional => Ok(()),
        None => Err(fail("missing smoothing state")),
    }
}

fn optional_ring(
    object: &JsObject,
    name: &str,
    period: usize,
    index: usize,
    optional: bool,
) -> Result<(), JsError> {
    match object.get(&key(name)) {
        Some(value) => ring(value, period, index, true),
        None if optional => Ok(()),
        None => Err(fail("missing rolling state")),
    }
}

fn optional_extreme(
    object: &JsObject,
    name: &str,
    period: usize,
    index: usize,
    maximum: bool,
    optional: bool,
) -> Result<(), JsError> {
    match object.get(&key(name)) {
        Some(value) => extreme(value, period, index, maximum),
        None if optional => Ok(()),
        None => Err(fail("missing extreme state")),
    }
}

fn last_extreme_pair(value: &JsValue) -> Result<(f64, f64), JsError> {
    let object = object(value)?;
    let Some(JsValue::Array(rows)) = object.get(&key("a")) else {
        return Err(fail("extreme queue"));
    };
    let Some(JsValue::Array(pair)) = rows.last() else {
        return Err(fail("empty extreme queue"));
    };
    let [JsValue::Number(index), JsValue::Number(value)] = pair.as_slice() else {
        return Err(fail("extreme pair"));
    };
    Ok((*index, *value))
}

fn last_extreme_index(value: &JsValue) -> Result<f64, JsError> {
    Ok(last_extreme_pair(value)?.0)
}

fn last_extreme_value(value: &JsValue) -> Result<f64, JsError> {
    Ok(last_extreme_pair(value)?.1)
}

/// 프로그램·파라미터·계산 index에 맞는 checkpoint state를 검증하고 소유 clone을 돌려준다.
pub fn validate_checkpoint_state(
    program: IndicatorProgram,
    params: &OrderedIndicatorParams,
    state: &JsValue,
    index: f64,
) -> Result<JsValue, JsError> {
    let index = integer(index, 0.0, MAX_HISTORY)? as usize;
    if program == IndicatorProgram::Pressure {
        validate_pressure(state, index)?;
        return Ok(state.clone());
    }
    if program == IndicatorProgram::Vwma {
        validate_vwma(state, params, index)?;
        return Ok(state.clone());
    }
    if matches!(program, IndicatorProgram::Vwap | IndicatorProgram::Pivots) {
        let config = session_checkpoint_config(program, params)?;
        if config.advanced {
            validate_session(program, &config, state, index)?;
            return Ok(state.clone());
        }
    }
    if program == IndicatorProgram::Aroon {
        period(params, "period", 25.0)?;
    }
    if index == 0 {
        let initial = initial_state(program, params)?;
        let allowed = object(&initial)?
            .iter()
            .map(|(key, _)| key.to_string_lossy())
            .collect::<Vec<_>>();
        let allowed = allowed.iter().map(String::as_str).collect::<Vec<_>>();
        record(state, &allowed, &allowed)?;
        if !exact_state_equal(state, &initial) {
            return Err(fail("initial state"));
        }
        return Ok(state.clone());
    }
    validate_warm(program, params, state, index)?;
    Ok(state.clone())
}

fn validate_pressure(state: &JsValue, index: usize) -> Result<(), JsError> {
    let object = record(
        state,
        &["previous", "cumulative"],
        &["previous", "cumulative"],
    )
    .map_err(|_| type_error_plain("Volume-direction checkpoint"))?;
    let previous = field_number(object, "previous", false)
        .map_err(|_| type_error_plain("Volume-direction checkpoint"))?;
    let cumulative = field_number(object, "cumulative", true)
        .map_err(|_| type_error_plain("Volume-direction checkpoint"))?;
    let valid = if index == 0 {
        previous.is_nan() && cumulative == 0.0
    } else {
        previous.is_finite()
    };
    if !valid {
        return Err(type_error_plain("Volume-direction checkpoint"));
    }
    Ok(())
}

fn type_error_plain(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error_plain(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn initial_state(
    program: IndicatorProgram,
    params: &OrderedIndicatorParams,
) -> Result<JsValue, JsError> {
    Ok(match program {
        IndicatorProgram::Sma
        | IndicatorProgram::Ema
        | IndicatorProgram::Wma
        | IndicatorProgram::Macd
        | IndicatorProgram::Donchian
        | IndicatorProgram::Aroon
        | IndicatorProgram::Stochastic
        | IndicatorProgram::WilliamsR
        | IndicatorProgram::Cci
        | IndicatorProgram::Cmf
        | IndicatorProgram::Dema
        | IndicatorProgram::Tema
        | IndicatorProgram::Hma
        | IndicatorProgram::Ichimoku
        | IndicatorProgram::Ppo
        | IndicatorProgram::VolumeOscillator => object_value([]),
        IndicatorProgram::Rsi
        | IndicatorProgram::Atr
        | IndicatorProgram::Mfi
        | IndicatorProgram::Keltner
        | IndicatorProgram::Trix
        | IndicatorProgram::ForceIndex => object_value([("previous", JsValue::Number(f64::NAN))]),
        IndicatorProgram::Bollinger => object_value([
            ("mean", JsValue::Number(0.0)),
            ("m2", JsValue::Number(0.0)),
            ("a", JsValue::Array(Vec::new())),
            ("head", JsValue::Number(0.0)),
        ]),
        IndicatorProgram::Roc => object_value([
            ("a", JsValue::Array(Vec::new())),
            ("head", JsValue::Number(0.0)),
        ]),
        IndicatorProgram::Obv => object_value([
            ("previous", JsValue::Number(f64::NAN)),
            ("value", JsValue::Number(0.0)),
        ]),
        IndicatorProgram::Vwap => object_value([
            ("session", JsValue::Number(f64::NAN)),
            ("pv", JsValue::Number(0.0)),
            ("v", JsValue::Number(0.0)),
        ]),
        IndicatorProgram::Adx | IndicatorProgram::Vortex => {
            object_value([("previous", JsValue::Null)])
        }
        IndicatorProgram::Supertrend => object_value([
            ("previous", JsValue::Number(f64::NAN)),
            ("upper", JsValue::Number(f64::NAN)),
            ("lower", JsValue::Number(f64::NAN)),
            ("direction", JsValue::Number(1.0)),
        ]),
        IndicatorProgram::StochRsi => object_value([
            ("previous", JsValue::Number(f64::NAN)),
            ("valid", JsValue::Number(0.0)),
        ]),
        IndicatorProgram::Adl => object_value([("value", JsValue::Number(0.0))]),
        IndicatorProgram::Chaikin => object_value([("value", JsValue::Number(0.0))]),
        IndicatorProgram::Pivots => object_value([
            ("session", JsValue::Number(f64::NAN)),
            ("high", JsValue::Number(f64::NAN)),
            ("low", JsValue::Number(f64::NAN)),
            ("close", JsValue::Number(f64::NAN)),
            ("levels", JsValue::Array(vec![JsValue::Number(f64::NAN); 5])),
        ]),
        IndicatorProgram::ParabolicSar => object_value([
            ("previous", JsValue::Null),
            ("older", JsValue::Null),
            ("sar", JsValue::Number(f64::NAN)),
            ("ep", JsValue::Number(f64::NAN)),
            ("af", param_value(params, "step", 0.02)),
            ("direction", JsValue::Number(1.0)),
        ]),
        IndicatorProgram::Pressure | IndicatorProgram::Vwma => unreachable!(),
    })
}

fn object_value<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in entries {
        object.insert(key(name), value);
    }
    JsValue::Object(object)
}

fn checkpoint_session(value: &JsValue) -> Result<f64, JsError> {
    let session = number(value, false)?;
    if session.is_nan() || session.is_finite() && session.fract() != 0.0 {
        return Err(fail("session"));
    }
    Ok(session)
}

fn validate_legacy_vwap(state: &JsValue) -> Result<(), JsError> {
    let object = record(state, &["session", "pv", "v"], &["session", "pv", "v"])?;
    checkpoint_session(object.get(&key("session")).expect("required"))?;
    field_number(object, "pv", false)?;
    let volume = field_number(object, "v", false)?;
    if volume < 0.0 {
        return Err(fail("negative volume"));
    }
    Ok(())
}

fn validate_legacy_pivots(state: &JsValue) -> Result<(), JsError> {
    let object = record(
        state,
        &["session", "high", "low", "close", "levels"],
        &["session", "high", "low", "close", "levels"],
    )?;
    checkpoint_session(object.get(&key("session")).expect("required"))?;
    let values = object_value([
        ("high", object.get(&key("high")).expect("required").clone()),
        ("low", object.get(&key("low")).expect("required").clone()),
        (
            "close",
            object.get(&key("close")).expect("required").clone(),
        ),
    ]);
    bar(&values)?;
    let levels = number_array(object.get(&key("levels")).expect("required"), 5, false)?;
    if levels.len() != 5 {
        return Err(fail("pivot levels"));
    }
    Ok(())
}

fn validate_sar(
    state: &JsValue,
    params: &OrderedIndicatorParams,
    index: usize,
) -> Result<(), JsError> {
    let object = record(
        state,
        &["previous", "older", "sar", "ep", "af", "direction"],
        &["previous", "older", "sar", "ep", "af", "direction"],
    )?;
    bar(object.get(&key("previous")).expect("required"))?;
    let older = nullable_bar(object.get(&key("older")).expect("required"))?;
    field_number(object, "sar", false)?;
    field_number(object, "ep", false)?;
    let acceleration = field_number(object, "af", true)?;
    let direction = object.get(&key("direction")).expect("required");
    if acceleration < param_number(params, "step", 0.02)
        || acceleration > param_number(params, "max", 0.2)
        || !matches!(direction, JsValue::Number(1.0 | -1.0))
    {
        return Err(fail("SAR state"));
    }
    if index == 1 && older.is_some() || index >= 2 && older.is_none() {
        return Err(fail("SAR history"));
    }
    Ok(())
}

fn object_is_number(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        true
    } else if left == 0.0 && right == 0.0 {
        left.to_bits() == right.to_bits()
    } else {
        left == right
    }
}

fn vwma_pair<'a>(value: &'a JsValue, reason: &str) -> Result<(&'a JsValue, &'a JsValue), JsError> {
    let JsValue::Array(pair) = value else {
        return Err(fail(reason));
    };
    let [left, right] = pair.as_slice() else {
        return Err(fail(reason));
    };
    Ok((left, right))
}

fn validate_vwma(
    state: &JsValue,
    params: &OrderedIndicatorParams,
    index: usize,
) -> Result<(), JsError> {
    let period = period(params, "period", 20.0)?;
    let object = record(
        state,
        &["a", "head", "sums", "invalid", "positive"],
        &["a", "head", "sums", "invalid", "positive"],
    )?;
    let Some(JsValue::Array(rows)) = object.get(&key("a")) else {
        return Err(fail("VWMA window"));
    };
    if rows.len() != min(period, index) {
        return Err(fail("VWMA window"));
    }
    let head = integer_value(
        object.get(&key("head")).expect("required"),
        0.0,
        (period - 1) as f64,
    )? as usize;
    let wanted_head = if index < period { 0 } else { index % period };
    if head != wanted_head {
        return Err(fail("VWMA head"));
    }

    let mut invalid = 0usize;
    let mut positive = 0usize;
    let mut expected = [[0.0, 0.0]; 3];
    for offset in 0..rows.len() {
        let row = &rows[(head + offset) % rows.len()];
        let (product, volume) = vwma_pair(row, "VWMA pair")?;
        let product = number(product, false)?;
        if product.is_nan() {
            return Err(fail("VWMA product"));
        }
        let volume = number(volume, true)?;
        if volume < 0.0 || volume == 0.0 && product != 0.0 {
            return Err(fail("VWMA volume"));
        }
        invalid += usize::from(!product.is_finite());
        positive += usize::from(volume > 0.0);
        vwma_accumulate(&mut expected[1], volume);
        if product.is_finite() {
            vwma_accumulate(&mut expected[0], product);
            vwma_accumulate(&mut expected[2], product.abs());
        }
    }

    let counter_matches = |name: &str, expected: usize| matches!(object.get(&key(name)), Some(JsValue::Number(actual)) if *actual == expected as f64);
    if !counter_matches("invalid", invalid) || !counter_matches("positive", positive) {
        return Err(fail("VWMA counters"));
    }
    let Some(JsValue::Array(sums)) = object.get(&key("sums")) else {
        return Err(fail("VWMA sums"));
    };
    if sums.len() != 3 {
        return Err(fail("VWMA sums"));
    }
    let strict = index.is_multiple_of(period)
        || positive == 0
        || [1usize, 2].into_iter().any(|slot| {
            let total = expected[slot][0] + expected[slot][1];
            !total.is_finite() || total >= f64::MAX / 4.0
        });
    for slot in 0..3 {
        let (sum, correction) = vwma_pair(&sums[slot], "VWMA compensation")?;
        let sum = output_number(sum)?;
        let correction = number(correction, true)?;
        if sum.is_nan() && correction != 0.0 {
            return Err(fail("VWMA invalid sum"));
        }
        let actual = sum + correction;
        let wanted = expected[slot][0] + expected[slot][1];
        if actual.is_nan() != wanted.is_nan()
            || actual == f64::INFINITY
            || actual == f64::NEG_INFINITY
        {
            return Err(fail("VWMA sum status"));
        }
        if strict {
            if ![sum, correction]
                .into_iter()
                .zip(expected[slot])
                .all(|(actual, expected)| object_is_number(actual, expected))
            {
                return Err(fail("VWMA canonical sums"));
            }
        } else if wanted.is_finite() {
            let scale = if slot == 1 {
                wanted.abs()
            } else {
                expected[2][0] + expected[2][1]
            };
            let tolerance = js_max(&[
                f64::from_bits(1) * 32.0 * period as f64,
                scale.abs() * f64::EPSILON * 32.0 * period as f64,
            ]);
            if (actual - wanted).abs() > tolerance || correction.abs() > tolerance {
                return Err(fail("VWMA sum consistency"));
            }
        }
    }
    Ok(())
}

fn session_record<'a>(value: &'a JsValue, allowed: &[&str]) -> Result<&'a JsObject, JsError> {
    let object = match value {
        JsValue::Object(object) => object,
        _ => return Err(type_error_plain("Session checkpoint: object required")),
    };
    for (name, _) in object.iter() {
        if !allowed
            .iter()
            .any(|allowed| name.as_units().iter().copied().eq(allowed.encode_utf16()))
        {
            return Err(type_error_plain(&format!(
                "Session checkpoint: unsupported field {}",
                name.slice(0, Some(64)).to_string_lossy()
            )));
        }
    }
    for name in allowed {
        if object.get(&key(name)).is_none() {
            return Err(type_error_plain(&format!(
                "Session checkpoint missing {name}"
            )));
        }
    }
    Ok(object)
}

fn labelled_record<'a>(
    value: &'a JsValue,
    allowed: &[&str],
    required: &[&str],
    label: &str,
) -> Result<&'a JsObject, JsError> {
    let JsValue::Object(object) = value else {
        return Err(type_error_plain(&format!("{label}: object required")));
    };
    for (name, _) in object.iter() {
        if !allowed
            .iter()
            .any(|allowed| name.as_units().iter().copied().eq(allowed.encode_utf16()))
        {
            return Err(type_error_plain(&format!(
                "{label}: unsupported field {}",
                name.slice(0, Some(64)).to_string_lossy()
            )));
        }
    }
    for name in required {
        if object.get(&key(name)).is_none() {
            return Err(type_error_plain(&format!("{label} missing {name}")));
        }
    }
    Ok(object)
}

fn session_utf8_bytes(value: &JsString) -> Result<usize, JsError> {
    let units = value.as_units();
    let mut bytes = 0usize;
    let mut index = 0usize;
    while index < units.len() {
        match units[index] {
            0..=0x7f => {
                bytes += 1;
                index += 1;
            }
            0x80..=0x7ff => {
                bytes += 2;
                index += 1;
            }
            0xd800..=0xdbff => {
                if index + 1 >= units.len() || !(0xdc00..=0xdfff).contains(&units[index + 1]) {
                    return Err(type_error_plain("Session Unicode scalar"));
                }
                bytes += 4;
                index += 2;
            }
            0xdc00..=0xdfff => return Err(type_error_plain("Session Unicode scalar")),
            _ => {
                bytes += 3;
                index += 1;
            }
        }
    }
    Ok(bytes)
}

fn session_text<'a>(
    value: &'a JsValue,
    maximum: usize,
    label: &str,
) -> Result<&'a JsString, JsError> {
    let JsValue::String(value) = value else {
        return Err(type_error_plain(&format!("{label} string limit")));
    };
    if value.as_units().is_empty() || value.len_utf16() > maximum {
        return Err(type_error_plain(&format!("{label} string limit")));
    }
    session_utf8_bytes(value)?;
    Ok(value)
}

fn session_array<'a>(
    value: &'a JsValue,
    maximum: usize,
    label: &str,
) -> Result<&'a [JsValue], JsError> {
    match value {
        JsValue::Array(values) if values.len() <= maximum => Ok(values),
        _ => Err(type_error_plain(&format!("{label} array limit"))),
    }
}

fn session_clock(value: &JsValue) -> Result<usize, JsError> {
    let JsValue::String(value) = value else {
        return Err(type_error_plain("Session HH:mm clock"));
    };
    let units = value.as_units();
    let digit = |index: usize| {
        units
            .get(index)
            .is_some_and(|unit| (48..=57).contains(unit))
    };
    if units.len() != 5
        || !digit(0)
        || !digit(1)
        || units[2] != b':' as u16
        || !digit(3)
        || !digit(4)
    {
        return Err(type_error_plain("Session HH:mm clock"));
    }
    let hour = usize::from(units[0] - 48) * 10 + usize::from(units[1] - 48);
    let minute = usize::from(units[3] - 48) * 10 + usize::from(units[4] - 48);
    if hour > 23 || minute > 59 {
        return Err(type_error_plain("Session HH:mm clock"));
    }
    Ok(hour * 60 + minute)
}

fn validate_session_windows(value: &JsValue) -> Result<(), JsError> {
    let windows = session_array(value, 16, "Session windows")?;
    let mut previous_close = 0usize;
    for (index, window) in windows.iter().enumerate() {
        let window = labelled_record(
            window,
            &["open", "close", "kind"],
            &["open", "close"],
            "Session window",
        )?;
        let open = session_clock(window.get(&key("open")).expect("required"))?;
        let clock = session_clock(window.get(&key("close")).expect("required"))?;
        let close = if clock <= open { clock + 1_440 } else { clock };
        let default_kind = JsValue::String(JsString::from_str("regular"));
        let kind = session_text(
            window.get(&key("kind")).unwrap_or(&default_kind),
            128,
            "Session kind",
        )?;
        if kind.as_units().contains(&(b',' as u16)) || JsString::trim(kind) != *kind {
            return Err(type_error_plain(
                "Session kind without comma/outer whitespace",
            ));
        }
        if index != 0 && open < previous_close {
            return Err(range_error_plain("Ordered nonoverlapping session windows"));
        }
        previous_close = close;
    }
    Ok(())
}

fn validate_portable_calendar(value: &JsValue) -> Result<(), JsError> {
    let calendar = labelled_record(
        value,
        &["timezone", "weekdays", "windows", "exceptions", "ambiguity"],
        &["timezone", "weekdays", "windows"],
        "Session options",
    )?;
    session_text(
        calendar.get(&key("timezone")).expect("required"),
        128,
        "Session timezone",
    )?;
    let weekdays = session_array(
        calendar.get(&key("weekdays")).expect("required"),
        7,
        "Session weekdays",
    )?;
    let mut seen = [false; 7];
    for weekday in weekdays {
        let JsValue::Number(weekday) = weekday else {
            return Err(type_error_plain("Unique weekdays 0..6 required"));
        };
        if weekday.fract() != 0.0 || *weekday < 0.0 || *weekday > 6.0 {
            return Err(type_error_plain("Unique weekdays 0..6 required"));
        }
        let weekday = *weekday as usize;
        if seen[weekday] {
            return Err(type_error_plain("Unique weekdays 0..6 required"));
        }
        seen[weekday] = true;
    }
    validate_session_windows(calendar.get(&key("windows")).expect("required"))?;
    if let Some(exceptions) = calendar.get(&key("exceptions")) {
        let JsValue::Object(exceptions) = exceptions else {
            return Err(type_error_plain("Session exceptions: object required"));
        };
        if exceptions.len() > 512 {
            return Err(range_error_plain("Session exception limit 512"));
        }
        let mut entries = exceptions.iter().collect::<Vec<_>>();
        entries.sort_unstable_by_key(|(name, _)| *name);
        for (date, windows) in entries {
            if date.as_units().is_empty() || date.len_utf16() > 10 {
                return Err(type_error_plain("Session date string limit"));
            }
            session_utf8_bytes(date)?;
            if ascii_date_parts(date).is_none() {
                return Err(type_error_plain("Session ISO date"));
            }
            validate_session_windows(windows)?;
        }
    }
    if let Some(ambiguity) = calendar.get(&key("ambiguity"))
        && !matches!(ambiguity, JsValue::String(value) if ["earlier", "later", "reject"].into_iter().any(|expected| text_matches(value, expected)))
    {
        return Err(type_error_plain("Session ambiguity earlier/later/reject"));
    }
    Ok(())
}

fn session_count(object: &JsObject, index: usize) -> Result<usize, JsError> {
    let Some(JsValue::Number(count)) = object.get(&key("count")) else {
        return Err(type_error_plain("Session checkpoint count"));
    };
    if !count.is_finite()
        || count.fract() != 0.0
        || count.abs() > 9_007_199_254_740_991.0
        || *count < 0.0
        || *count > index as f64
    {
        return Err(type_error_plain("Session checkpoint count"));
    }
    Ok(*count as usize)
}

fn ascii_date_parts(value: &JsString) -> Option<(i64, i64, i64)> {
    let units = value.as_units();
    if units.len() != 10 || units[4] != b'-' as u16 || units[7] != b'-' as u16 {
        return None;
    }
    for (index, unit) in units.iter().enumerate() {
        if index != 4 && index != 7 && !(b'0' as u16..=b'9' as u16).contains(unit) {
            return None;
        }
    }
    let digits = |from: usize, to: usize| {
        units[from..to].iter().fold(0i64, |value, unit| {
            value * 10 + i64::from(unit - b'0' as u16)
        })
    };
    let year = digits(0, 4);
    let month = digits(5, 7);
    let day = digits(8, 10);
    if !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > days[(month - 1) as usize] {
        return None;
    }
    Some((year, month, day))
}

fn date_weekday(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let since_epoch = era * 146_097 + day_of_era - 719_468;
    (since_epoch + 4).rem_euclid(7)
}

fn text_matches(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn calendar_windows<'a>(calendar: &'a JsValue, date: &JsString) -> Option<&'a [JsValue]> {
    let JsValue::Object(calendar) = calendar else {
        return None;
    };
    if let Some(JsValue::Object(exceptions)) = calendar.get(&key("exceptions"))
        && let Some(JsValue::Array(windows)) = exceptions.get(date)
    {
        return Some(windows);
    }
    let (year, month, day) = ascii_date_parts(date)?;
    let weekday = date_weekday(year, month, day) as f64;
    let Some(JsValue::Array(weekdays)) = calendar.get(&key("weekdays")) else {
        return None;
    };
    if !weekdays
        .iter()
        .any(|value| matches!(value, JsValue::Number(value) if *value == weekday))
    {
        return Some(&[]);
    }
    match calendar.get(&key("windows")) {
        Some(JsValue::Array(windows)) => Some(windows),
        _ => None,
    }
}

fn calendar_includes(calendar: &JsValue, date: &JsString, kinds: &[JsString]) -> bool {
    let Some(windows) = calendar_windows(calendar, date) else {
        return false;
    };
    windows.iter().any(|window| {
        let JsValue::Object(window) = window else {
            return false;
        };
        match window.get(&key("kind")) {
            Some(JsValue::String(kind)) => kinds.contains(kind),
            None => kinds.iter().any(|value| text_matches(value, "regular")),
            _ => false,
        }
    })
}

enum SessionCheckpointMode {
    Anchor(f64),
    Calendar(JsValue, Vec<JsString>),
    Bucket,
}

struct SessionCheckpointConfig {
    mode: SessionCheckpointMode,
    advanced: bool,
}

fn session_checkpoint_config(
    program: IndicatorProgram,
    params: &OrderedIndicatorParams,
) -> Result<SessionCheckpointConfig, JsError> {
    // `sessionStudyParams` parses the calendar before checking every conflict.
    let calendar = match params.get("calendar") {
        None => None,
        Some(IndicatorParamValue::String(text)) if !text.as_units().is_empty() => {
            if session_utf8_bytes(text)? > 65_536 {
                return Err(range_error_plain("Session calendar 64KiB limit"));
            }
            let parsed = safe_checkpoint_parse(&JsValue::String(text.clone()))?;
            validate_portable_calendar(&parsed)?;
            Some(parsed)
        }
        Some(_) => return Err(type_error_plain("Session calendar string limit")),
    };
    let anchor_present = params.contains("anchorTime");
    if params.contains("sessionMs") && (calendar.is_some() || anchor_present) {
        return Err(type_error_plain(
            "sessionMs conflicts with calendar/anchorTime",
        ));
    }
    let anchor = match params.get("anchorTime") {
        None => None,
        Some(IndicatorParamValue::Number(value))
            if program == IndicatorProgram::Vwap
                && value.fract() == 0.0
                && value.abs() <= 8_640_000_000_000_000.0 =>
        {
            Some(*value)
        }
        Some(_) => return Err(range_error_plain("VWAP anchor UTC milliseconds")),
    };
    match params.get("sessionMs") {
        None => {}
        Some(IndicatorParamValue::Number(value)) if *value > 0.0 => {}
        Some(_) => return Err(range_error_plain("Session duration")),
    }

    let kinds = match params.get("kinds") {
        None => vec![JsString::from_str("regular")],
        Some(IndicatorParamValue::String(value)) if calendar.is_some() => {
            let kinds = value
                .as_units()
                .split(|unit| *unit == b',' as u16)
                .map(|units| JsString::from_utf16(units.to_vec()))
                .collect::<Vec<_>>();
            let valid = !value.as_units().is_empty()
                && kinds.len() <= 16
                && kinds.iter().all(|kind| {
                    !kind.as_units().is_empty()
                        && JsString::trim(kind) == *kind
                        && kind.len_utf16() <= 128
                })
                && kinds
                    .iter()
                    .enumerate()
                    .all(|(index, kind)| !kinds[..index].contains(kind));
            if !valid {
                return Err(type_error_plain("Unique comma-separated session kinds"));
            }
            kinds
        }
        Some(IndicatorParamValue::String(_)) => {
            return Err(type_error_plain("Session kinds require calendar"));
        }
        Some(_) if calendar.is_some() => {
            return Err(type_error_plain("Session kinds string limit"));
        }
        Some(_) => return Err(type_error_plain("Session kinds require calendar")),
    };
    if program == IndicatorProgram::Vwap {
        if let Some(source) = params.get("source") {
            let valid = matches!(source, IndicatorParamValue::String(value) if ["hlc3", "close", "hl2", "ohlc4"].into_iter().any(|expected| text_matches(value, expected)));
            if !valid {
                return Err(type_error_plain("VWAP source"));
            }
        }
        if let Some(deviation) = params.get("deviation")
            && !matches!(deviation, IndicatorParamValue::Number(value) if *value >= 0.0)
        {
            return Err(range_error_plain("VWAP deviation multiplier"));
        }
    }
    let advanced = calendar.is_some()
        || anchor.is_some()
        || params.contains("kinds")
        || program == IndicatorProgram::Vwap
            && (params.contains("source") || params.contains("deviation"));
    let mode = if let Some(anchor) = anchor {
        SessionCheckpointMode::Anchor(anchor)
    } else if let Some(calendar) = calendar {
        SessionCheckpointMode::Calendar(calendar, kinds)
    } else {
        SessionCheckpointMode::Bucket
    };
    Ok(SessionCheckpointConfig { mode, advanced })
}

fn validate_session_identity(
    config: &SessionCheckpointConfig,
    object: &JsObject,
    index: usize,
) -> Result<usize, JsError> {
    let count = session_count(object, index)?;
    let session = object.get(&key("session")).expect("required");
    if matches!(session, JsValue::Null) {
        if count != 0 {
            return Err(type_error_plain("Session checkpoint initial session"));
        }
        return Ok(count);
    }
    if count == 0 {
        return Err(type_error_plain("Session checkpoint missing count"));
    }
    match &config.mode {
        SessionCheckpointMode::Anchor(anchor) => {
            if !matches!(session, JsValue::Number(value) if *value == *anchor) {
                return Err(type_error_plain("Session checkpoint anchor"));
            }
        }
        SessionCheckpointMode::Calendar(calendar, kinds) => {
            let JsValue::String(date) = session else {
                return Err(type_error_plain("Session date string limit"));
            };
            if date.as_units().is_empty() || date.len_utf16() > 10 {
                return Err(type_error_plain("Session date string limit"));
            }
            session_utf8_bytes(date)?;
            if ascii_date_parts(date).is_none() {
                return Err(type_error_plain("Session ISO date"));
            }
            if !calendar_includes(calendar, date, kinds) {
                return Err(type_error_plain("Session checkpoint excluded date"));
            }
        }
        SessionCheckpointMode::Bucket => {
            if !matches!(session, JsValue::Number(value) if value.is_finite() && value.fract() == 0.0)
            {
                return Err(type_error_plain("Session checkpoint bucket"));
            }
        }
    }
    Ok(count)
}

fn session_finite(object: &JsObject, name: &str) -> Result<f64, JsError> {
    match object.get(&key(name)) {
        Some(JsValue::Number(value)) if value.is_finite() => Ok(*value),
        _ => Err(type_error_plain("Session checkpoint finite numbers")),
    }
}

fn session_near(left: f64, right: f64) -> bool {
    (left - right).abs() <= js_max(&[1.0, left.abs(), right.abs()]) * 1e-10
}

fn validate_session(
    program: IndicatorProgram,
    config: &SessionCheckpointConfig,
    state: &JsValue,
    index: usize,
) -> Result<(), JsError> {
    let allowed = if program == IndicatorProgram::Vwap {
        &["session", "count", "pv", "v", "mean", "m2"][..]
    } else {
        &["session", "count", "high", "low", "close", "levels"][..]
    };
    let object = session_record(state, allowed)?;
    let count = validate_session_identity(config, object, index)?;
    if index == 0 && !matches!(object.get(&key("session")), Some(JsValue::Null)) {
        return Err(type_error_plain("Session checkpoint initial state"));
    }
    if program == IndicatorProgram::Vwap {
        let price_volume = session_finite(object, "pv")?;
        let volume = session_finite(object, "v")?;
        let mean = session_finite(object, "mean")?;
        let variance = session_finite(object, "m2")?;
        if volume < 0.0 || variance < 0.0 {
            return Err(type_error_plain("Session checkpoint volume/variance"));
        }
        if volume == 0.0 && (price_volume != 0.0 || mean != 0.0 || variance != 0.0)
            || count == 0 && volume != 0.0
            || count == 1 && variance != 0.0
            || volume > 0.0 && !session_near(mean, price_volume / volume)
        {
            return Err(type_error_plain("Session checkpoint VWAP invariant"));
        }
        return Ok(());
    }

    let Some(JsValue::Array(level_values)) = object.get(&key("levels")) else {
        return Err(type_error_plain("Session checkpoint levels array limit"));
    };
    if level_values.len() > 5 {
        return Err(type_error_plain("Session checkpoint levels array limit"));
    }
    if level_values.len() != 5 {
        return Err(type_error_plain("Session checkpoint level count"));
    }
    let empty = level_values
        .iter()
        .all(|value| matches!(value, JsValue::Number(value) if value.is_nan()));
    if !empty
        && level_values
            .iter()
            .any(|value| !matches!(value, JsValue::Number(value) if value.is_finite()))
    {
        return Err(type_error_plain("Session checkpoint pivot levels"));
    }
    if count == 0 {
        if !matches!(object.get(&key("high")), Some(JsValue::Null))
            || !matches!(object.get(&key("low")), Some(JsValue::Null))
            || !matches!(object.get(&key("close")), Some(JsValue::Null))
            || !empty
        {
            return Err(type_error_plain("Session checkpoint initial OHLC"));
        }
    } else {
        let values = ["high", "low", "close"].map(|name| match object.get(&key(name)) {
            Some(JsValue::Number(value)) if value.is_finite() => Some(*value),
            _ => None,
        });
        let [Some(high), Some(low), Some(close)] = values else {
            return Err(type_error_plain("Session checkpoint OHLC"));
        };
        if low > high || close < low || close > high {
            return Err(type_error_plain("Session checkpoint OHLC"));
        }
    }
    if !empty {
        let levels = level_values
            .iter()
            .map(|value| match value {
                JsValue::Number(value) => *value,
                _ => unreachable!("finite pivot levels were checked"),
            })
            .collect::<Vec<_>>();
        let [pivot, resistance1, support1, resistance2, support2] = levels.as_slice() else {
            unreachable!("five pivot levels were checked")
        };
        let low = 2.0 * pivot - resistance1;
        let high = 2.0 * pivot - support1;
        let close = resistance1 + support1 - pivot;
        if ![low, high, close].into_iter().all(f64::is_finite)
            || high < low
            || close < low - 1e-10 * js_max(&[1.0, low.abs()])
            || close > high + 1e-10 * js_max(&[1.0, high.abs()])
            || !session_near(resistance2 - pivot, pivot - support2)
            || !session_near(resistance1 - support1, resistance2 - pivot)
        {
            return Err(type_error_plain("Session checkpoint pivot invariant"));
        }
    }
    Ok(())
}

fn validate_warm(
    program: IndicatorProgram,
    params: &OrderedIndicatorParams,
    state: &JsValue,
    index: usize,
) -> Result<(), JsError> {
    match program {
        IndicatorProgram::Sma | IndicatorProgram::Wma => {
            let object = record(state, &["r"], &["r"])?;
            ring(
                object.get(&key("r")).expect("required"),
                period(params, "period", 20.0)?,
                index,
                true,
            )
        }
        IndicatorProgram::Ema => {
            let object = record(state, &["e"], &["e"])?;
            smoothing(
                object.get(&key("e")).expect("required"),
                period(params, "period", 20.0)?,
                index,
            )
        }
        IndicatorProgram::Rsi => {
            let object = record(state, &["previous", "g", "l"], &["previous"])?;
            field_number(object, "previous", true)?;
            paired(object, "g", "l")?;
            let period = period(params, "period", 14.0)?;
            optional_smoothing(object, "g", period, index, true)?;
            optional_smoothing(object, "l", period, index, true)
        }
        IndicatorProgram::Atr => {
            let object = record(state, &["previous", "tr"], &["previous", "tr"])?;
            field_number(object, "previous", true)?;
            smoothing(
                object.get(&key("tr")).expect("required"),
                period(params, "period", 14.0)?,
                index,
            )
        }
        IndicatorProgram::Macd | IndicatorProgram::Ppo => {
            let object = record(state, &["f", "l", "s"], &["f", "l", "s"])?;
            optional_smoothing(object, "f", period(params, "fast", 12.0)?, index, false)?;
            optional_smoothing(object, "l", period(params, "slow", 26.0)?, index, false)?;
            optional_smoothing(object, "s", period(params, "signal", 9.0)?, index, false)
        }
        IndicatorProgram::Bollinger => {
            let object = record(
                state,
                &["mean", "m2", "a", "head"],
                &["mean", "m2", "a", "head"],
            )?;
            field_number(object, "mean", false)?;
            field_number(object, "m2", false)?;
            let ring_state = object_value([
                ("a", object.get(&key("a")).expect("required").clone()),
                ("head", object.get(&key("head")).expect("required").clone()),
            ]);
            ring(&ring_state, period(params, "period", 20.0)?, index, false)
        }
        IndicatorProgram::Donchian | IndicatorProgram::WilliamsR => {
            let object = record(state, &["h", "l"], &["h", "l"])?;
            let period = period(
                params,
                "period",
                if program == IndicatorProgram::WilliamsR {
                    14.0
                } else {
                    20.0
                },
            )?;
            optional_extreme(object, "h", period, index, true, false)?;
            optional_extreme(object, "l", period, index, false, false)
        }
        IndicatorProgram::Aroon => {
            let object = record(state, &["h", "l"], &["h", "l"])?;
            let period = period(params, "period", 25.0)? + 1;
            optional_extreme(object, "h", period, index, true, false)?;
            optional_extreme(object, "l", period, index, false, false)?;
            let high = last_extreme_index(object.get(&key("h")).expect("required"))?;
            let low = last_extreme_index(object.get(&key("l")).expect("required"))?;
            let high_value = last_extreme_value(object.get(&key("h")).expect("required"))?;
            let low_value = last_extreme_value(object.get(&key("l")).expect("required"))?;
            if high != index as f64 - 1.0 || low != index as f64 - 1.0 || high_value < low_value {
                return Err(fail("Aroon latest bar"));
            }
            Ok(())
        }
        IndicatorProgram::Stochastic => {
            let object = record(state, &["h", "l", "k", "d"], &["h", "l", "k", "d"])?;
            let window = period(params, "period", 14.0)?;
            optional_extreme(object, "h", window, index, true, false)?;
            optional_extreme(object, "l", window, index, false, false)?;
            optional_ring(object, "k", period(params, "smoothK", 3.0)?, index, false)?;
            optional_ring(object, "d", period(params, "smoothD", 3.0)?, index, false)
        }
        IndicatorProgram::Roc => {
            let object = record(state, &["a", "head"], &["a", "head"])?;
            ring(state, period(params, "period", 12.0)?, index, false)?;
            debug_assert_eq!(object.len(), 2);
            Ok(())
        }
        IndicatorProgram::Cci => {
            let object = record(state, &["tp"], &["tp"])?;
            optional_ring(object, "tp", period(params, "period", 20.0)?, index, false)
        }
        IndicatorProgram::Obv => {
            let object = record(state, &["previous", "value"], &["previous", "value"])?;
            field_number(object, "previous", true)?;
            field_number(object, "value", true)?;
            Ok(())
        }
        IndicatorProgram::Vwap => validate_legacy_vwap(state),
        IndicatorProgram::Mfi => {
            let object = record(state, &["previous", "p", "n"], &["previous"])?;
            field_number(object, "previous", false)?;
            paired(object, "p", "n")?;
            let period = period(params, "period", 14.0)?;
            optional_ring(object, "p", period, index, true)?;
            optional_ring(object, "n", period, index, true)
        }
        IndicatorProgram::Cmf => {
            let object = record(state, &["f", "v"], &["f", "v"])?;
            let period = period(params, "period", 20.0)?;
            optional_ring(object, "f", period, index, false)?;
            optional_ring(object, "v", period, index, false)
        }
        IndicatorProgram::Adx => {
            let object = record(state, &["previous", "tr", "p", "m", "dx"], &["previous"])?;
            bar(object.get(&key("previous")).expect("required"))?;
            paired(object, "tr", "p")?;
            paired(object, "p", "m")?;
            paired(object, "m", "dx")?;
            let period = period(params, "period", 14.0)?;
            for name in ["tr", "p", "m", "dx"] {
                optional_smoothing(object, name, period, index, true)?;
            }
            Ok(())
        }
        IndicatorProgram::Dema | IndicatorProgram::Tema => {
            let names = if program == IndicatorProgram::Dema {
                &["a", "b"][..]
            } else {
                &["a", "b", "c"][..]
            };
            let object = record(state, names, names)?;
            let period = period(params, "period", 20.0)?;
            for name in names {
                optional_smoothing(object, name, period, index, false)?;
            }
            Ok(())
        }
        IndicatorProgram::Hma => {
            let object = record(state, &["r", "h", "f"], &["r", "h", "f"])?;
            let period = period(params, "period", 20.0)?;
            let root = (period as f64).sqrt().floor() as usize;
            optional_ring(object, "r", max(root, 1), index, false)?;
            optional_ring(object, "h", max(period / 2, 1), index, false)?;
            optional_ring(object, "f", period, index, false)
        }
        IndicatorProgram::Keltner => {
            let object = record(state, &["previous", "e", "a"], &["previous", "e", "a"])?;
            field_number(object, "previous", true)?;
            optional_smoothing(object, "e", period(params, "period", 20.0)?, index, false)?;
            optional_smoothing(
                object,
                "a",
                period(params, "atrPeriod", 10.0)?,
                index,
                false,
            )
        }
        IndicatorProgram::Supertrend => {
            let object = record(
                state,
                &["previous", "upper", "lower", "direction", "a"],
                &["previous", "upper", "lower", "direction", "a"],
            )?;
            field_number(object, "previous", true)?;
            field_number(object, "upper", false)?;
            field_number(object, "lower", false)?;
            if !matches!(
                object.get(&key("direction")),
                Some(JsValue::Number(1.0 | -1.0))
            ) {
                return Err(fail("direction"));
            }
            optional_smoothing(object, "a", period(params, "period", 10.0)?, index, false)
        }
        IndicatorProgram::Ichimoku => {
            let names = ["th", "tl", "kh", "kl", "bh", "bl"];
            let object = record(state, &names, &names)?;
            for (prefix, param, fallback) in [
                ("t", "conversion", 9.0),
                ("k", "base", 26.0),
                ("b", "span", 52.0),
            ] {
                let period = period(params, param, fallback)?;
                optional_extreme(object, &format!("{prefix}h"), period, index, true, false)?;
                optional_extreme(object, &format!("{prefix}l"), period, index, false, false)?;
            }
            Ok(())
        }
        IndicatorProgram::Trix => {
            let object = record(
                state,
                &["previous", "a", "b", "c"],
                &["previous", "a", "b", "c"],
            )?;
            field_number(object, "previous", false)?;
            let period = period(params, "period", 15.0)?;
            for name in ["a", "b", "c"] {
                optional_smoothing(object, name, period, index, false)?;
            }
            Ok(())
        }
        IndicatorProgram::StochRsi => {
            let object = record(
                state,
                &["previous", "valid", "g", "l", "h", "z", "k", "d"],
                &["previous", "valid", "k", "d"],
            )?;
            field_number(object, "previous", true)?;
            let valid = integer_value(
                object.get(&key("valid")).expect("required"),
                0.0,
                index as f64,
            )? as usize;
            paired(object, "g", "l")?;
            paired(object, "h", "z")?;
            let rsi_period = period(params, "period", 14.0)?;
            optional_smoothing(object, "g", rsi_period, index, true)?;
            optional_smoothing(object, "l", rsi_period, index, true)?;
            let stoch = period(params, "stochPeriod", 14.0)?;
            optional_extreme(object, "h", stoch, valid, true, valid == 0)?;
            optional_extreme(object, "z", stoch, valid, false, valid == 0)?;
            optional_ring(object, "k", period(params, "smoothK", 3.0)?, index, false)?;
            optional_ring(object, "d", period(params, "smoothD", 3.0)?, index, false)
        }
        IndicatorProgram::Adl => {
            let object = record(state, &["value"], &["value"])?;
            output_number(object.get(&key("value")).expect("required"))?;
            Ok(())
        }
        IndicatorProgram::Chaikin => {
            let object = record(state, &["value", "f", "l"], &["value", "f", "l"])?;
            field_number(object, "value", false)?;
            optional_smoothing(object, "f", period(params, "fast", 3.0)?, index, false)?;
            optional_smoothing(object, "l", period(params, "slow", 10.0)?, index, false)
        }
        IndicatorProgram::ForceIndex => {
            let object = record(state, &["previous", "e"], &["previous", "e"])?;
            field_number(object, "previous", true)?;
            optional_smoothing(object, "e", period(params, "period", 13.0)?, index, false)
        }
        IndicatorProgram::VolumeOscillator => {
            let object = record(state, &["f", "l"], &["f", "l"])?;
            optional_ring(object, "f", period(params, "fast", 14.0)?, index, false)?;
            optional_ring(object, "l", period(params, "slow", 28.0)?, index, false)
        }
        IndicatorProgram::Vortex => {
            let object = record(state, &["previous", "tr", "p", "m"], &["previous"])?;
            bar(object.get(&key("previous")).expect("required"))?;
            paired(object, "tr", "p")?;
            paired(object, "p", "m")?;
            let period = period(params, "period", 14.0)?;
            for name in ["tr", "p", "m"] {
                optional_ring(object, name, period, index, true)?;
            }
            Ok(())
        }
        IndicatorProgram::Pivots => validate_legacy_pivots(state),
        IndicatorProgram::ParabolicSar => validate_sar(state, params, index),
        IndicatorProgram::Vwma | IndicatorProgram::Pressure => unreachable!(),
    }
}
