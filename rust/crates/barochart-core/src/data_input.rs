//! `JsValue` 데이터 입력을 기존 typed [`BarStore`] 계약으로 소유 변환한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::batch_options::snapshot_batch_options_with_memory;
use crate::coercion::js_to_number_scoped;
use crate::data::{
    Bar, BarStore, BatchEvent, ColumnInputs, Committed, DataEventValue, NumericColumn, validate_bar,
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

enum InputEventKind {
    Batch,
    Reset,
    Prepend,
    Append,
    Update,
    Correction,
    Unknown,
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
    set_data_input_with_reply_gate(store, input, _mode, &mut || Ok(()))
}

/// 전체 bar 입력을 소유·검증한 뒤 고정 reply admission 직전에 게시한다.
pub fn set_data_input_with_reply_gate(
    store: &mut BarStore,
    input: &JsValue,
    _mode: DataInputMode,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let (bars, _snapshot_memory) = bars_input(
        input,
        store.max_bars(),
        "OHLCV array required",
        store.memory_context(),
    )?;
    let committed = store.set_data_with_reply_gate(bars, gate)?;
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
    set_columns_input_with_reply_gate(store, input, length, mode, &mut || Ok(()))
}

/// 숫자 열을 소유·검증한 뒤 고정 reply admission 직전에 게시한다.
pub fn set_columns_input_with_reply_gate(
    store: &mut BarStore,
    input: &JsValue,
    length: Option<&JsValue>,
    mode: DataInputMode,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    match mode {
        DataInputMode::LegacyStore => {
            let requested = explicit_length(length, store.max_bars())?;
            let owned = legacy_columns(input, requested, store.max_bars(), store.memory_context())?;
            commit_columns(store, &owned, Some(owned.inferred_length), gate)
        }
        DataInputMode::ApiFacade => {
            let owned = api_columns(input, store.memory_context())?;
            let requested = explicit_length(length, store.max_bars())?;
            commit_columns(store, &owned, requested, gate)
        }
    }
}

/// reset/append/update/correction/prepend/batch event 하나를 mode별로 적용한다.
pub fn apply_data_event_input(
    store: &mut BarStore,
    event: &JsValue,
    mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    apply_data_event_input_with_reply_gate(store, event, mode, &mut || Ok(()))
}

/// 단일 data event를 소유·검증한 뒤 고정 reply admission 직전에 게시한다.
pub fn apply_data_event_input_with_reply_gate(
    store: &mut BarStore,
    event: &JsValue,
    mode: DataInputMode,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    match event_kind(event)? {
        InputEventKind::Batch => {
            let undefined = JsValue::Undefined;
            let events = property_optional(event, "events").unwrap_or(&undefined);
            apply_data_events_input_with_reply_gate(store, events, None, mode, gate)
        }
        InputEventKind::Reset => {
            let undefined = JsValue::Undefined;
            let columns = property_optional(event, "columns").unwrap_or(&undefined);
            if js_truthy(columns) {
                let length = property_optional(event, "length").unwrap_or(&undefined);
                set_columns_input_with_reply_gate(store, columns, Some(length), mode, gate)
            } else {
                let bars = property_optional(event, "bars").unwrap_or(&undefined);
                set_data_input_with_reply_gate(store, bars, mode, gate)
            }
        }
        InputEventKind::Prepend => {
            let label = match mode {
                DataInputMode::LegacyStore => "Prepend bars required",
                DataInputMode::ApiFacade => "OHLCV array required",
            };
            let undefined = JsValue::Undefined;
            let bars = property_optional(event, "bars").unwrap_or(&undefined);
            prepend_input(store, bars, label, gate)
        }
        InputEventKind::Append => {
            let undefined = JsValue::Undefined;
            let bar = property_optional(event, "bar").unwrap_or(&undefined);
            let committed = store.append_with_reply_gate(read_bar(bar)?, gate)?;
            Ok(map_with(committed, DataEventValue::Index))
        }
        InputEventKind::Update => {
            let undefined = JsValue::Undefined;
            let bar = property_optional(event, "bar").unwrap_or(&undefined);
            update_input(store, bar, gate)
        }
        InputEventKind::Correction => {
            let undefined = JsValue::Undefined;
            let bar = property_optional(event, "bar").unwrap_or(&undefined);
            correction_input(store, bar, gate)
        }
        InputEventKind::Unknown => Err(type_error("Unknown data event").into()),
    }
}

/// Options를 먼저 snapshot한 뒤 strict batch를 원자 적용한다.
pub fn apply_data_events_input(
    store: &mut BarStore,
    events: &JsValue,
    options: Option<&JsValue>,
    mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    apply_data_events_input_with_reply_gate(store, events, options, mode, &mut || Ok(()))
}

/// Strict batch를 stage한 뒤 고정 reply admission 직전에 게시한다.
pub fn apply_data_events_input_with_reply_gate(
    store: &mut BarStore,
    events: &JsValue,
    options: Option<&JsValue>,
    mode: DataInputMode,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let default_options = JsValue::Object(JsObject::new());
    let options = snapshot_batch_options_with_memory(
        match options {
            None | Some(JsValue::Undefined) => &default_options,
            Some(options) => options,
        },
        mode == DataInputMode::LegacyStore,
        store.memory_context(),
    )?;
    let events = match mode {
        DataInputMode::LegacyStore => legacy_batch_events(events, store.memory_context())?,
        DataInputMode::ApiFacade => api_batch_events(events, store.memory_context())?,
    };
    let committed = store
        .apply_events_with_reply_gate(&events.values, &options, gate)
        .map_err(batch_store_error)?;
    Ok(map_with(committed, DataEventValue::Batch))
}

struct OwnedColumns {
    values: [Vec<f64>; 6],
    inferred_length: usize,
    _memory: [MemoryGroup; 6],
}

struct OwnedBatchEvents {
    values: Vec<BatchEvent>,
    _memory: MemoryGroup,
}

fn legacy_columns(
    input: &JsValue,
    explicit_length: Option<usize>,
    max_bars: usize,
    memory: &MemoryContext,
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
    for source in sources {
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
        }
    }
    let (mut values, memory) = numeric_column_snapshots(length, memory)?;
    for (slot, source) in sources.into_iter().enumerate() {
        let Some(JsValue::Array(source)) = source else {
            unreachable!()
        };
        values[slot].extend(source[..length].iter().map(|value| {
            let JsValue::Number(value) = value else {
                unreachable!("numeric columns were validated before allocation")
            };
            *value
        }));
    }
    Ok(OwnedColumns {
        values,
        inferred_length: length,
        _memory: memory,
    })
}

fn api_columns(input: &JsValue, memory: &MemoryContext) -> Result<OwnedColumns, DataInputError> {
    let sources = FIELDS.map(|key| property_optional(input, key));
    for source in sources {
        let Some(JsValue::Array(source)) = source else {
            return Err(type_error("Values must be Float64Array or a JSON array").into());
        };
        for value in source {
            match value {
                JsValue::Null => {}
                JsValue::Number(value) if value.is_finite() => {}
                _ => return Err(type_error("Finite numbers or null gaps required").into()),
            }
        }
    }
    let inferred_length = match sources[0] {
        Some(JsValue::Array(source)) => source.len(),
        _ => unreachable!("column sources were validated"),
    };
    let capacities = sources.map(|source| match source {
        Some(JsValue::Array(source)) => source.len(),
        _ => unreachable!("column sources were validated"),
    });
    let (mut values, memory) = numeric_column_snapshots_with_capacities(capacities, memory)?;
    for (slot, source) in sources.into_iter().enumerate() {
        let Some(JsValue::Array(source)) = source else {
            unreachable!("column sources were validated")
        };
        values[slot].extend(source.iter().map(|value| match value {
            JsValue::Null => f64::NAN,
            JsValue::Number(value) => *value,
            _ => unreachable!("column values were validated before allocation"),
        }));
    }
    Ok(OwnedColumns {
        inferred_length,
        values,
        _memory: memory,
    })
}

fn numeric_column_snapshots(
    capacity: usize,
    memory: &MemoryContext,
) -> Result<([Vec<f64>; 6], [MemoryGroup; 6]), DataInputError> {
    numeric_column_snapshots_with_capacities([capacity; 6], memory)
}

fn numeric_column_snapshots_with_capacities(
    capacities: [usize; 6],
    memory: &MemoryContext,
) -> Result<([Vec<f64>; 6], [MemoryGroup; 6]), DataInputError> {
    let (time, time_memory) = memory
        .try_vec_capacity(capacities[0])
        .map_err(memory_input_error)?;
    let (open, open_memory) = memory
        .try_vec_capacity(capacities[1])
        .map_err(memory_input_error)?;
    let (high, high_memory) = memory
        .try_vec_capacity(capacities[2])
        .map_err(memory_input_error)?;
    let (low, low_memory) = memory
        .try_vec_capacity(capacities[3])
        .map_err(memory_input_error)?;
    let (close, close_memory) = memory
        .try_vec_capacity(capacities[4])
        .map_err(memory_input_error)?;
    let (volume, volume_memory) = memory
        .try_vec_capacity(capacities[5])
        .map_err(memory_input_error)?;
    Ok((
        [time, open, high, low, close, volume],
        [
            time_memory,
            open_memory,
            high_memory,
            low_memory,
            close_memory,
            volume_memory,
        ],
    ))
}

fn commit_columns(
    store: &mut BarStore,
    owned: &OwnedColumns,
    length: Option<usize>,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let inputs = ColumnInputs {
        time: NumericColumn::F64(&owned.values[0]),
        open: NumericColumn::F64(&owned.values[1]),
        high: NumericColumn::F64(&owned.values[2]),
        low: NumericColumn::F64(&owned.values[3]),
        close: NumericColumn::F64(&owned.values[4]),
        volume: NumericColumn::F64(&owned.values[5]),
    };
    let committed = store.set_columns_with_reply_gate(&inputs, length, gate)?;
    Ok(map_value(committed, DataEventValue::None))
}

fn prepend_input(
    store: &mut BarStore,
    input: &JsValue,
    array_error: &str,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let JsValue::Array(values) = input else {
        return Err(type_error(array_error).into());
    };
    if values.is_empty() {
        let committed = store.prepend_with_reply_gate(Vec::new(), gate)?;
        return Ok(map_value(committed, DataEventValue::None));
    }
    if values.len() + store.length() > store.max_bars() {
        return Err(bar_count_error(store.max_bars()).into());
    }
    if store.length() != 0 {
        let last = values.last().expect("nonempty prepend");
        let raw_time = raw_time_value(last, "bars[bars.length - 1].time")?;
        let mut scope = store.memory_context().scope();
        let time = js_to_number_scoped(
            raw_time.unwrap_or(&JsValue::Undefined),
            NumberDialect::PLATFORM,
            &mut scope,
        )?;
        if time >= store.columns().time[0] {
            return Err(
                range_error("Prepend must precede existing history without overlap").into(),
            );
        }
    }
    let (mut bars, _snapshot_memory) = store
        .memory_context()
        .try_vec_capacity(values.len())
        .map_err(memory_input_error)?;
    bars.extend(values.iter().map(bar_from_any));
    let committed = store.prepend_with_reply_gate(bars, gate)?;
    Ok(map_value(committed, DataEventValue::None))
}

fn update_input(
    store: &mut BarStore,
    value: &JsValue,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    if store.length() == 0 {
        return Err(range_error("Update is only the current bar").into());
    }
    let raw_time = raw_property_time(value, "event.bar.time")?;
    if !matches!(raw_time, Some(time) if time == store.columns().time[store.length() - 1]) {
        return Err(range_error("Update is only the current bar").into());
    }
    let committed = store.update_with_reply_gate(store.length() - 1, read_bar(value)?, gate)?;
    Ok(map_value(committed, DataEventValue::None))
}

fn correction_input(
    store: &mut BarStore,
    value: &JsValue,
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<Committed<DataEventValue>, DataInputError> {
    let raw_time = raw_time_value(value, "event.bar.time")?;
    if store.length() == 0 {
        return Err(range_error("Correction requires an existing timestamp").into());
    }
    let mut scope = store.memory_context().scope();
    let time = js_to_number_scoped(
        raw_time.unwrap_or(&JsValue::Undefined),
        NumberDialect::PLATFORM,
        &mut scope,
    )?;
    let index = store.lower_bound(time);
    if index == store.length()
        || !matches!(raw_time, Some(JsValue::Number(raw)) if *raw == store.columns().time[index])
    {
        return Err(range_error("Correction requires an existing timestamp").into());
    }
    let committed = store.update_with_reply_gate(index, read_bar(value)?, gate)?;
    Ok(map_value(committed, DataEventValue::None))
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
    memory: &MemoryContext,
) -> Result<(Vec<Bar>, MemoryGroup), DataInputError> {
    let JsValue::Array(values) = input else {
        return Err(type_error(array_error).into());
    };
    if values.len() > max_bars {
        return Err(bar_count_error(max_bars).into());
    }
    for value in values {
        read_bar(value)?;
    }
    let (mut bars, group) = memory
        .try_vec_capacity(values.len())
        .map_err(memory_input_error)?;
    for value in values {
        bars.push(read_bar(value)?);
    }
    Ok((bars, group))
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

fn legacy_batch_events(
    value: &JsValue,
    memory: &MemoryContext,
) -> Result<OwnedBatchEvents, DataInputError> {
    let JsValue::Array(events) = value else {
        return Err(type_error("Data batch array required").into());
    };
    if events.is_empty() || events.len() > 4096 {
        return Err(range_error("Data batch event count must be 1..4096").into());
    }
    let (mut output, memory) = memory
        .try_vec_capacity(events.len())
        .map_err(memory_input_error)?;
    for value in events {
        let event = strict_record(value, &["kind", "bar"], "Data batch event", true)?;
        let kind = string_value(event.get(&JsString::from_str("kind")));
        let kind = match kind {
            Some(value) if text_eq(value, "append") => 0,
            Some(value) if text_eq(value, "update") => 1,
            Some(value) if text_eq(value, "correction") => 2,
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
    Ok(OwnedBatchEvents {
        values: output,
        _memory: memory,
    })
}

fn api_batch_events(
    value: &JsValue,
    memory: &MemoryContext,
) -> Result<OwnedBatchEvents, DataInputError> {
    let JsValue::Array(events) = value else {
        return Err(ingestion_error("1–4096 ordered events required").into());
    };
    if events.is_empty() || events.len() > 4096 {
        return Err(ingestion_error("1–4096 ordered events required").into());
    }
    let (mut output, memory) = memory
        .try_vec_capacity(events.len())
        .map_err(memory_input_error)?;
    for value in events {
        let event = ingestion_record(value, &["kind", "bar"], "Event")?;
        let kind = string_value(event.get(&JsString::from_str("kind")));
        let kind = match kind {
            Some(value) if text_eq(value, "append") => 0,
            Some(value) if text_eq(value, "update") => 1,
            Some(value) if text_eq(value, "correction") => 2,
            _ => return Err(ingestion_error("Ordered append/update/correction required").into()),
        };
        let undefined = JsValue::Undefined;
        let bar_value = property_optional(value, "bar").unwrap_or(&undefined);
        let bar_object = ingestion_record(bar_value, &FIELDS, "OHLCV")?;
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
    Ok(OwnedBatchEvents {
        values: output,
        _memory: memory,
    })
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

fn event_kind(value: &JsValue) -> Result<InputEventKind, DataInputError> {
    let value = property_optional(value, "kind")
        .and_then(|value| string_value(Some(value)))
        .ok_or_else(|| DataInputError::from(type_error("Data event kind required")))?;
    Ok(if text_eq(value, "batch") {
        InputEventKind::Batch
    } else if text_eq(value, "reset") {
        InputEventKind::Reset
    } else if text_eq(value, "prepend") {
        InputEventKind::Prepend
    } else if text_eq(value, "append") {
        InputEventKind::Append
    } else if text_eq(value, "update") {
        InputEventKind::Update
    } else if text_eq(value, "correction") {
        InputEventKind::Correction
    } else {
        InputEventKind::Unknown
    })
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

fn string_value(value: Option<&JsValue>) -> Option<&JsString> {
    match value {
        Some(JsValue::String(value)) => Some(value),
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

fn memory_input_error(error: barochart_js::memory::MemoryFailure) -> DataInputError {
    DataInputError::Js(error.into_js_error())
}
