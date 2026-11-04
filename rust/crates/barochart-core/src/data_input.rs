//! `JsValue` 데이터 입력을 기존 typed [`BarStore`] 계약으로 소유 변환한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::batch_options::{BatchOptions, snapshot_batch_options};
use crate::coercion::js_to_number_with;
use crate::data::{
    Bar, BarStore, BatchEvent, ColumnInputs, Committed, DataEvent, DataEventValue, NumericColumn,
    validate_bar,
};

const FIELDS: [&str; 6] = ["time", "open", "high", "low", "close", "volume"];

/// 직접 Store 호출과 `ChartAPI` facade snapshot 의미를 구분한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataInputMode {
    /// `BarStore`/`markets.applyDataEvent` 직접 경로다.
    LegacyStore,
    /// `ChartAPI`가 먼저 소유 snapshot/values 변환을 하는 경로다.
    ApiFacade,
}

/// 원시 property 접근의 nullish base 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NullishBase {
    /// JavaScript `null`이다.
    Null,
    /// 빠진 property와 JavaScript `undefined`다.
    Undefined,
}

/// 안정 JS 오류 또는 플랫폼 JS가 직접 만들어야 하는 nullish property 접근이다.
#[derive(Clone, Debug)]
pub enum DataInputError {
    /// 코어가 문구까지 고정한 오류다.
    Js(JsError),
    /// 엔진별 TypeError 문구를 Root transport가 렌더링할 property 접근이다.
    NullishPropertyAccess {
        /// null/undefined base다.
        base: NullishBase,
        /// 접근한 property다.
        property: &'static str,
        /// 근거가 된 source 표현식이다.
        expression: &'static str,
    },
}

impl From<JsError> for DataInputError {
    fn from(value: JsError) -> Self {
        Self::Js(value)
    }
}

/// 전체 bar 배열 입력을 snapshot·검증하고 store reset으로 커밋한다.
pub fn set_data_input(
    store: &mut BarStore,
    input: &JsValue,
    _mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let bars = bars_input(input, store.max_bars(), "OHLCV array required")?;
    let committed = store.set_data(bars)?;
    Ok(map_value(committed, DataEventValue::None))
}

/// 여섯 plain JSON numeric column을 mode별 snapshot 의미로 reset한다.
/// TypedArray는 기존 별도 typed-column leaf가 처리한다.
pub fn set_columns_input(
    store: &mut BarStore,
    input: &JsValue,
    length: Option<&JsValue>,
    mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    match mode {
        DataInputMode::LegacyStore => {
            let requested = explicit_length(length, store.max_bars())?;
            let owned = legacy_columns(input, requested, store.max_bars())?;
            commit_columns(store, &owned, Some(owned.inferred_length))
        }
        DataInputMode::ApiFacade => {
            let owned = api_columns(input)?;
            let requested = explicit_length(length, store.max_bars())?;
            commit_columns(store, &owned, requested)
        }
    }
}

/// reset/append/update/correction/prepend/batch event 하나를 mode별로 적용한다.
pub fn apply_data_event_input(
    store: &mut BarStore,
    event: &JsValue,
    mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let kind = event_kind(event)?;
    match kind.as_str() {
        "batch" => {
            let events = property(event, "events");
            apply_data_events_input(store, &events, None, mode)
        }
        "reset" => {
            let columns = property(event, "columns");
            if js_truthy(&columns) {
                let length = property(event, "length");
                set_columns_input(store, &columns, Some(&length), mode)
            } else {
                let bars = property(event, "bars");
                set_data_input(store, &bars, mode)
            }
        }
        "prepend" => {
            let label = match mode {
                DataInputMode::LegacyStore => "Prepend bars required",
                DataInputMode::ApiFacade => "OHLCV array required",
            };
            let bars = property(event, "bars");
            prepend_input(store, &bars, label)
        }
        "append" => {
            let bar = property(event, "bar");
            let committed = store.append(read_bar(&bar)?)?;
            Ok(map_with(committed, DataEventValue::Index))
        }
        "update" => {
            let bar = property(event, "bar");
            update_input(store, &bar)
        }
        "correction" => {
            let bar = property(event, "bar");
            correction_input(store, &bar)
        }
        _ => Err(type_error("Unknown data event").into()),
    }
}

/// Options를 먼저 snapshot한 뒤 strict batch를 원자 적용한다.
pub fn apply_data_events_input(
    store: &mut BarStore,
    events: &JsValue,
    options: Option<&JsValue>,
    mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let default_options = JsValue::Object(JsObject::new());
    let options = snapshot_batch_options(
        match options {
            None | Some(JsValue::Undefined) => &default_options,
            Some(options) => options,
        },
        mode == DataInputMode::LegacyStore,
    )?;
    let events = match mode {
        DataInputMode::LegacyStore => legacy_batch_events(events)?,
        DataInputMode::ApiFacade => api_batch_events(events)?,
    };
    let committed = store
        .apply_events(&events, &options)
        .map_err(batch_store_error)?;
    Ok(map_with(committed, DataEventValue::Batch))
}

struct OwnedColumns {
    values: [Vec<f64>; 6],
    inferred_length: usize,
}

fn legacy_columns(
    input: &JsValue,
    explicit_length: Option<usize>,
    max_bars: usize,
) -> Result<OwnedColumns, DataInputError> {
    let sources: [Option<&JsValue>; 6] = FIELDS.map(|key| property_optional(input, key));
    let length = match explicit_length {
        Some(length) => length,
        None => match sources[0] {
            Some(JsValue::Array(values)) => values.len(),
            _ => return Err(bar_count_error(max_bars).into()),
        },
    };
    if length > max_bars {
        return Err(bar_count_error(max_bars).into());
    }
    for source in sources {
        if !matches!(source, Some(JsValue::Array(values)) if values.len() >= length) {
            return Err(type_error("Numeric column arrays required").into());
        }
    }
    let mut values: [Vec<f64>; 6] = std::array::from_fn(|_| Vec::with_capacity(length));
    for (slot, source) in sources.into_iter().enumerate() {
        let Some(JsValue::Array(source)) = source else {
            unreachable!()
        };
        for value in &source[..length] {
            let JsValue::Number(value) = value else {
                return Err(type_error("Numeric column values required").into());
            };
            if !value.is_finite() {
                return Err(type_error("Numeric column values required").into());
            }
            values[slot].push(*value);
        }
    }
    Ok(OwnedColumns {
        values,
        inferred_length: length,
    })
}

fn api_columns(input: &JsValue) -> Result<OwnedColumns, DataInputError> {
    let mut values: [Vec<f64>; 6] = std::array::from_fn(|_| Vec::new());
    for (slot, key) in FIELDS.into_iter().enumerate() {
        let Some(JsValue::Array(source)) = property_optional(input, key) else {
            return Err(type_error("Values must be Float64Array or a JSON array").into());
        };
        values[slot].reserve(source.len());
        for value in source {
            match value {
                JsValue::Null => values[slot].push(f64::NAN),
                JsValue::Number(value) if value.is_finite() => values[slot].push(*value),
                _ => return Err(type_error("Finite numbers or null gaps required").into()),
            }
        }
    }
    Ok(OwnedColumns {
        inferred_length: values[0].len(),
        values,
    })
}

fn commit_columns(
    store: &mut BarStore,
    owned: &OwnedColumns,
    length: Option<usize>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let inputs = ColumnInputs {
        time: NumericColumn::F64(&owned.values[0]),
        open: NumericColumn::F64(&owned.values[1]),
        high: NumericColumn::F64(&owned.values[2]),
        low: NumericColumn::F64(&owned.values[3]),
        close: NumericColumn::F64(&owned.values[4]),
        volume: NumericColumn::F64(&owned.values[5]),
    };
    let committed = store.set_columns(&inputs, length)?;
    Ok(map_value(committed, DataEventValue::None))
}

fn prepend_input(
    store: &mut BarStore,
    input: &JsValue,
    array_error: &str,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let JsValue::Array(values) = input else {
        return Err(type_error(array_error).into());
    };
    if values.is_empty() {
        let committed = store.prepend(Vec::new())?;
        return Ok(map_value(committed, DataEventValue::None));
    }
    if values.len() + store.length() > store.max_bars() {
        return Err(bar_count_error(store.max_bars()).into());
    }
    if store.length() != 0 {
        let last = values.last().expect("nonempty prepend");
        let raw_time = raw_time_value(last, "bars[bars.length - 1].time")?;
        let time = js_to_number_with(
            raw_time.unwrap_or(&JsValue::Undefined),
            NumberDialect::PLATFORM,
        )?;
        if time >= store.columns().time[0] {
            return Err(
                range_error("Prepend must precede existing history without overlap").into(),
            );
        }
    }
    let bars: Vec<Bar> = values.iter().map(bar_from_any).collect();
    let committed = store.prepend(bars)?;
    Ok(map_value(committed, DataEventValue::None))
}

fn update_input(
    store: &mut BarStore,
    value: &JsValue,
) -> Result<Committed<DataEventValue>, DataInputError> {
    if store.length() == 0 {
        return Err(range_error("Update is only the current bar").into());
    }
    let raw_time = raw_property_time(value, "event.bar.time")?;
    if !matches!(raw_time, Some(time) if time == store.columns().time[store.length() - 1]) {
        return Err(range_error("Update is only the current bar").into());
    }
    let committed =
        store.apply_event(DataEvent::Update(read_bar(value)?), &BatchOptions::empty())?;
    Ok(committed)
}

fn correction_input(
    store: &mut BarStore,
    value: &JsValue,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let raw_time = raw_time_value(value, "event.bar.time")?;
    if store.length() == 0 {
        return Err(range_error("Correction requires an existing timestamp").into());
    }
    let time = js_to_number_with(
        raw_time.unwrap_or(&JsValue::Undefined),
        NumberDialect::PLATFORM,
    )?;
    let index = store.lower_bound(time);
    if index == store.length()
        || !matches!(raw_time, Some(JsValue::Number(raw)) if *raw == store.columns().time[index])
    {
        return Err(range_error("Correction requires an existing timestamp").into());
    }
    let committed = store.apply_event(
        DataEvent::Correction(read_bar(value)?),
        &BatchOptions::empty(),
    )?;
    Ok(committed)
}

fn raw_property_time(
    value: &JsValue,
    expression: &'static str,
) -> Result<Option<f64>, DataInputError> {
    Ok(match raw_time_value(value, expression)? {
        Some(JsValue::Number(value)) => Some(*value),
        _ => None,
    })
}

fn raw_time_value<'a>(
    value: &'a JsValue,
    expression: &'static str,
) -> Result<Option<&'a JsValue>, DataInputError> {
    match value {
        JsValue::Null => Err(DataInputError::NullishPropertyAccess {
            base: NullishBase::Null,
            property: "time",
            expression,
        }),
        JsValue::Undefined => Err(DataInputError::NullishPropertyAccess {
            base: NullishBase::Undefined,
            property: "time",
            expression,
        }),
        JsValue::Object(object) => Ok(object.get(&JsString::from_str("time"))),
        _ => Ok(None),
    }
}

fn bars_input(
    input: &JsValue,
    max_bars: usize,
    array_error: &str,
) -> Result<Vec<Bar>, DataInputError> {
    let JsValue::Array(values) = input else {
        return Err(type_error(array_error).into());
    };
    if values.len() > max_bars {
        return Err(bar_count_error(max_bars).into());
    }
    values.iter().map(read_bar).collect()
}

fn read_bar(value: &JsValue) -> Result<Bar, DataInputError> {
    if matches!(value, JsValue::Array(_)) {
        return Ok(bar_from_any(value));
    }
    let JsValue::Object(object) = value else {
        return Err(type_error("OHLCV object required").into());
    };
    Ok(bar_from_object(object))
}

fn bar_from_any(value: &JsValue) -> Bar {
    match value {
        JsValue::Object(object) => bar_from_object(object),
        _ => Bar {
            time: f64::NAN,
            open: f64::NAN,
            high: f64::NAN,
            low: f64::NAN,
            close: f64::NAN,
            volume: f64::NAN,
        },
    }
}

fn bar_from_object(object: &JsObject) -> Bar {
    Bar {
        time: number_or_nan(object.get(&JsString::from_str("time"))),
        open: number_or_nan(object.get(&JsString::from_str("open"))),
        high: number_or_nan(object.get(&JsString::from_str("high"))),
        low: number_or_nan(object.get(&JsString::from_str("low"))),
        close: number_or_nan(object.get(&JsString::from_str("close"))),
        volume: number_or_nan(object.get(&JsString::from_str("volume"))),
    }
}

fn strict_bar(value: &JsValue, label: &str) -> Result<Bar, DataInputError> {
    let object = strict_record(value, &FIELDS, label, true)?;
    Ok(bar_from_object(object))
}

fn legacy_batch_events(value: &JsValue) -> Result<Vec<BatchEvent>, DataInputError> {
    let JsValue::Array(events) = value else {
        return Err(type_error("Data batch array required").into());
    };
    if events.is_empty() || events.len() > 4096 {
        return Err(range_error("Data batch event count must be 1..4096").into());
    }
    let mut output = Vec::with_capacity(events.len());
    for value in events {
        let event = strict_record(value, &["kind", "bar"], "Data batch event", true)?;
        let kind = string_value(event.get(&JsString::from_str("kind")));
        let kind = match kind.as_deref() {
            Some("append") => 0,
            Some("update") => 1,
            Some("correction") => 2,
            _ => {
                return Err(type_error(
                    "Data batch event kind must be append, update or correction",
                )
                .into());
            }
        };
        let bar = strict_bar(
            event.get(&JsString::from_str("bar")).expect("required bar"),
            "Data batch OHLCV",
        )?;
        validate_bar(&bar, f64::NEG_INFINITY)?;
        output.push(match kind {
            0 => BatchEvent::Append(bar),
            1 => BatchEvent::Update(bar),
            _ => BatchEvent::Correction(bar),
        });
    }
    Ok(output)
}

fn api_batch_events(value: &JsValue) -> Result<Vec<BatchEvent>, DataInputError> {
    let JsValue::Array(events) = value else {
        return Err(ingestion_error("1–4096 ordered events required").into());
    };
    if events.is_empty() || events.len() > 4096 {
        return Err(ingestion_error("1–4096 ordered events required").into());
    }
    let mut output = Vec::with_capacity(events.len());
    for value in events {
        let event = ingestion_record(value, &["kind", "bar"], "Event")?;
        let kind = string_value(event.get(&JsString::from_str("kind")));
        let kind = match kind.as_deref() {
            Some("append") => 0,
            Some("update") => 1,
            Some("correction") => 2,
            _ => return Err(ingestion_error("Ordered append/update/correction required").into()),
        };
        let bar_value = property(value, "bar");
        let bar_object = ingestion_record(&bar_value, &FIELDS, "OHLCV")?;
        let bar = bar_from_object(bar_object);
        if let Err(error) = validate_bar(&bar, f64::NEG_INFINITY) {
            return Err(ingestion_error(&error.message.to_string_lossy()).into());
        }
        output.push(match kind {
            0 => BatchEvent::Append(bar),
            1 => BatchEvent::Update(bar),
            _ => BatchEvent::Correction(bar),
        });
    }
    Ok(output)
}

fn strict_record<'a>(
    value: &'a JsValue,
    allowed: &[&str],
    label: &str,
    required: bool,
) -> Result<&'a JsObject, DataInputError> {
    let JsValue::Object(object) = value else {
        return Err(type_error(&format!("{label} plain data record required")).into());
    };
    if object
        .iter()
        .any(|(key, _)| !allowed.iter().any(|allowed| text_eq(key, allowed)))
    {
        return Err(type_error(&format!(
            "{label} unsupported field or accessor data property"
        ))
        .into());
    }
    if required
        && allowed
            .iter()
            .any(|key| object.get(&JsString::from_str(key)).is_none())
    {
        return Err(type_error(&format!("{label} required data property")).into());
    }
    Ok(object)
}

fn ingestion_record<'a>(
    value: &'a JsValue,
    allowed: &[&str],
    label: &str,
) -> Result<&'a JsObject, DataInputError> {
    let JsValue::Object(object) = value else {
        return Err(ingestion_error(&format!("{label} object required")).into());
    };
    if object
        .iter()
        .any(|(key, _)| !allowed.iter().any(|allowed| text_eq(key, allowed)))
    {
        return Err(ingestion_error(&format!("{label} unsupported field")).into());
    }
    Ok(object)
}

fn event_kind(value: &JsValue) -> Result<String, DataInputError> {
    property_optional(value, "kind")
        .and_then(|value| string_value(Some(value)))
        .ok_or_else(|| type_error("Data event kind required").into())
}

fn property(value: &JsValue, key: &str) -> JsValue {
    property_optional(value, key)
        .cloned()
        .unwrap_or(JsValue::Undefined)
}

fn property_optional<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    let JsValue::Object(object) = value else {
        return None;
    };
    object.get(&JsString::from_str(key))
}

fn explicit_length(
    value: Option<&JsValue>,
    max_bars: usize,
) -> Result<Option<usize>, DataInputError> {
    match value {
        None | Some(JsValue::Undefined) => Ok(None),
        Some(JsValue::Number(value))
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= 0.0
                && *value <= max_bars as f64 =>
        {
            Ok(Some(*value as usize))
        }
        _ => Err(bar_count_error(max_bars).into()),
    }
}

fn number_or_nan(value: Option<&JsValue>) -> f64 {
    match value {
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    }
}

fn string_value(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::String(value)) => Some(value.to_string_lossy()),
        _ => None,
    }
}

fn js_truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(value) => *value,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

fn map_value<T>(committed: Committed<T>, value: DataEventValue) -> Committed<DataEventValue> {
    Committed {
        value,
        change: committed.change,
    }
}

fn map_with<T>(
    committed: Committed<T>,
    map: impl FnOnce(T) -> DataEventValue,
) -> Committed<DataEventValue> {
    Committed {
        value: map(committed.value),
        change: committed.change,
    }
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn bar_count_error(max_bars: usize) -> JsError {
    range_error(&format!("Bar count: limit {max_bars}"))
}

fn ingestion_error(message: &str) -> JsError {
    let mut error = JsError::new("IngestionError", JsString::from_str(message));
    error.code = Some("INVALID_INPUT".to_owned());
    error
}

fn batch_store_error(mut error: JsError) -> DataInputError {
    let message = error.message.to_string_lossy();
    if error.name == "RangeError"
        && message.starts_with("Data batch ")
        && message.contains(" budget limit ")
    {
        error.code = Some("STORE_BUDGET".to_owned());
    }
    DataInputError::Js(error)
}
