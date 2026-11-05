//! Native indicator-params worker/source 순수 상태기계다.
//!
//! Root Engine이 registration/ticket/busy/lease를 소유하고, 이 모듈은 실제 typed payload,
//! checkpoint ledger, bounded calculation과 detached publication stage만 소유한다.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::checkpoint_codec::{safe_checkpoint_parse_scoped, safe_checkpoint_stringify_scoped};
use crate::contracts::{RESOURCE_LIMITS, identifier, option_record};
use crate::data::{Bar, Columns, DataIdentity, ModelDataState, StoreOptions, validate_bar};
use crate::indicator_engine::{
    CalculationStep, IndicatorCalculation, IndicatorEngine, IndicatorEngineOptions,
    NativeIndicatorCaptureToken, NativeIndicatorEntrySnapshot, NativeIndicatorReplacementStage,
};
use crate::indicator_helpers::exact_state_equal;
use crate::indicator_modules::validate_indicator_module_binding;
use crate::ingestion::{AsyncIngestionLease, IngestionOwner};
use crate::model_state::ModelState;
use crate::native_checkpoints::{
    NATIVE_CHECKPOINT_RECORD_BYTES, NATIVE_CHECKPOINT_TOTAL_BYTES, NativeCheckpointMap,
    native_checkpoint_footprint,
};
use crate::range_index::RangeIndex;
use crate::series_cache::{SeriesCacheBufferView, SeriesCaches, SeriesCachesCaptureToken};
use crate::workspace::js_value_heap_bytes;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const PARAMS_MAX_BYTES: usize = 805_306_368;
const PARAMS_METADATA_CHARS: usize = 131_072;
const PARAMS_CHUNK: usize = 16_384;

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut output = JsObject::new();
    for (name, value) in entries {
        output.insert(key(name), value);
    }
    JsValue::Object(output)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", key(message))
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", key(message))
}

fn protocol_stringify(
    value: &JsValue,
    dialect: NumberDialect,
    style: OomStyle,
) -> Result<JsString, JsError> {
    let mut scope = MemoryScope::unaccounted(style);
    safe_checkpoint_stringify_scoped(value, dialect, &mut scope)
}

fn protocol_stringify_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    safe_checkpoint_stringify_scoped(value, dialect, scope)
}

fn scoped_entries(
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<(JsString, JsValue)>, JsError> {
    scope
        .try_grow(capacity.saturating_mul(std::mem::size_of::<(JsString, JsValue)>()))
        .map_err(|failure| failure.into_js_error())?;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(entries)
}

fn push_scoped(
    entries: &mut Vec<(JsString, JsValue)>,
    name: &str,
    value: JsValue,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    entries.push((
        JsString::try_from_str(name, scope).map_err(|failure| failure.into_js_error())?,
        value,
    ));
    Ok(())
}

fn scoped_text(value: &str, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    JsString::try_from_str(value, scope)
        .map(JsValue::String)
        .map_err(|failure| failure.into_js_error())
}

fn publish_receipt_with_memory(
    layout: &JsValue,
    id: &JsString,
    registration: u64,
    noop: bool,
    memory: &MemoryContext,
) -> Result<(JsValue, MemoryGroup, u64), JsError> {
    let mut scope = memory.scope();
    let mut entries = scoped_entries(7, &mut scope)?;
    push_scoped(
        &mut entries,
        "schema",
        scoped_text("aster.native-params-published", &mut scope)?,
        &mut scope,
    )?;
    push_scoped(&mut entries, "version", JsValue::Number(1.0), &mut scope)?;
    push_scoped(
        &mut entries,
        "registration",
        JsValue::Number(registration as f64),
        &mut scope,
    )?;
    push_scoped(
        &mut entries,
        "status",
        scoped_text(if noop { "unchanged" } else { "committed" }, &mut scope)?,
        &mut scope,
    )?;
    push_scoped(
        &mut entries,
        "id",
        JsValue::String(
            id.try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        &mut scope,
    )?;
    push_scoped(
        &mut entries,
        "outputs",
        property(layout, "outputs")
            .unwrap_or(&JsValue::Array(Vec::new()))
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        &mut scope,
    )?;
    push_scoped(
        &mut entries,
        "plotOffsets",
        property(layout, "plotOffsets")
            .unwrap_or(&JsValue::Object(JsObject::new()))
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        &mut scope,
    )?;
    let receipt = JsValue::Object(
        JsObject::try_from_entries_scoped(entries, &mut scope)
            .map_err(|failure| failure.into_js_error())?,
    );
    let build_bytes = scope.requested_bytes();
    let group = scope
        .split_persistent(js_value_heap_bytes(&receipt))
        .map_err(|failure| failure.into_js_error())?;
    Ok((receipt, group, build_bytes))
}

fn property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn string(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

fn text_is(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn exact_integer(value: f64, minimum: f64, maximum: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (minimum..=maximum).contains(&value)
}

fn number_field(value: &JsValue, name: &str, message: &str) -> Result<f64, JsError> {
    match property(value, name) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(type_error(message)),
    }
}

fn safe_usize(value: f64, maximum: usize, message: &str) -> Result<usize, JsError> {
    if exact_integer(value, 0.0, maximum as f64) {
        Ok(value as usize)
    } else {
        Err(range_error(message))
    }
}

fn layout_value(snapshot: &NativeIndicatorEntrySnapshot) -> JsValue {
    let mut offsets = JsObject::new();
    for offset in &snapshot.definition.plot_offsets {
        offsets.insert(key(offset.output), JsValue::Number(offset.value));
    }
    object([
        (
            "outputs",
            JsValue::Array(
                snapshot
                    .definition
                    .outputs
                    .iter()
                    .map(|output| text(output))
                    .collect(),
            ),
        ),
        ("plotOffsets", JsValue::Object(offsets)),
    ])
}

/// Native params phase/progress 영수증이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeParamsProgress {
    /// phase 문자열이다.
    pub phase: &'static str,
    /// phase 안의 완료 단위다.
    pub done: usize,
    /// phase 전체 단위다.
    pub total: usize,
    /// ready terminal 여부다.
    pub complete: bool,
}

impl NativeParamsProgress {
    /// bridge key 순서의 값이다.
    pub fn to_js_value(&self) -> JsValue {
        object([
            ("phase", text(self.phase)),
            ("done", JsValue::Number(self.done as f64)),
            ("total", JsValue::Number(self.total as f64)),
            ("complete", JsValue::Bool(self.complete)),
        ])
    }
}

/// Target checkpoint source record다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeParamsCheckpointRecord {
    /// checkpoint boundary index다.
    pub index: usize,
    /// exact safe-checkpoint text다.
    pub text: JsString,
}

#[derive(Clone)]
struct NativeParamsBinding {
    registration: u64,
    id: JsString,
    name: JsString,
    params: JsValue,
    module: Option<JsValue>,
    length: usize,
    capacity: usize,
    outputs: Vec<JsString>,
    plot_offsets: JsValue,
    max_bytes: usize,
}

impl NativeParamsBinding {
    fn to_target_metadata(&self) -> JsValue {
        let mut value = JsObject::new();
        value.insert(key("schema"), text("aster.native-params-target"));
        value.insert(key("version"), JsValue::Number(1.0));
        value.insert(
            key("registration"),
            JsValue::Number(self.registration as f64),
        );
        value.insert(key("id"), JsValue::String(self.id.clone()));
        value.insert(key("name"), JsValue::String(self.name.clone()));
        value.insert(key("params"), self.params.clone());
        if let Some(module) = &self.module {
            value.insert(key("module"), module.clone());
        }
        value.insert(key("length"), JsValue::Number(self.length as f64));
        value.insert(key("capacity"), JsValue::Number(self.capacity as f64));
        value.insert(
            key("outputs"),
            JsValue::Array(self.outputs.iter().cloned().map(JsValue::String).collect()),
        );
        value.insert(key("plotOffsets"), self.plot_offsets.clone());
        value.insert(key("maxBytes"), JsValue::Number(self.max_bytes as f64));
        JsValue::Object(value)
    }
}

struct NativeParamsTargetSpec {
    binding: NativeParamsBinding,
    template: Option<NativeIndicatorEntrySnapshot>,
    plan: JsValue,
    checkpoint_count: usize,
}

impl NativeParamsTargetSpec {
    fn parse(
        text: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        if text.len_utf16() > PARAMS_METADATA_CHARS {
            return Err(range_error("Native params metadata limit"));
        }
        // Metadata is a bounded protocol document, not a persistent payload budget. Keep its
        // parser allocations fallible and use the engine's error style without charging those
        // short-lived protocol objects to the payload account.
        let mut parse_scope = MemoryScope::unaccounted(memory.oom_style());
        let value = safe_checkpoint_parse_scoped(
            &JsValue::String(text.clone()),
            dialect,
            &mut parse_scope,
        )?;
        option_record(
            &value,
            &[
                "schema",
                "version",
                "registration",
                "id",
                "name",
                "params",
                "module",
                "length",
                "capacity",
                "outputs",
                "plotOffsets",
                "maxBytes",
            ],
            "Native params metadata",
        )?;
        if !matches!(property(&value, "schema"), Some(JsValue::String(value)) if text_is(value, "aster.native-params-target"))
            || !matches!(property(&value, "version"), Some(JsValue::Number(1.0)))
        {
            return Err(type_error("Native params protocol"));
        }
        let registration = number_field(&value, "registration", "Native params protocol")?;
        if !exact_integer(registration, 1.0, MAX_SAFE_INTEGER) {
            return Err(type_error("Native params protocol"));
        }
        let id_value = property(&value, "id")
            .cloned()
            .ok_or_else(|| type_error("Indicator id"))?;
        let name_value = property(&value, "name")
            .cloned()
            .ok_or_else(|| type_error("Indicator name"))?;
        let id = identifier(&id_value, "Indicator id")?.clone();
        let name = identifier(&name_value, "Indicator name")?.clone();
        let params = property(&value, "params")
            .cloned()
            .ok_or_else(|| type_error("Indicator params"))?;
        crate::indicator_params::validate_indicator_params(&params)?;
        validate_indicator_module_binding(&name, property(&value, "module"))?;
        let length = safe_usize(
            number_field(&value, "length", "Native params dimensions")?,
            RESOURCE_LIMITS.max_bars as usize,
            "Native params dimensions",
        )?;
        let capacity = safe_usize(
            number_field(&value, "capacity", "Native params dimensions")?,
            RESOURCE_LIMITS.max_bars as usize,
            "Native params dimensions",
        )?;
        if capacity < 16 || !capacity.is_power_of_two() || capacity < length {
            return Err(range_error("Native params dimensions"));
        }
        let max_bytes = safe_usize(
            number_field(&value, "maxBytes", "Native params byte limit")?,
            PARAMS_MAX_BYTES,
            "Native params byte limit",
        )?;
        if max_bytes == 0 {
            return Err(range_error("Native params byte limit"));
        }
        let probe_memory = MemoryContext::unaccounted(memory.oom_style());
        let probe_data = ModelDataState::new_with_memory(
            StoreOptions::default(),
            Vec::new(),
            probe_memory.clone(),
        )?;
        let mut probe =
            IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), probe_memory)?;
        probe.add(probe_data.store(), host, &id_value, &name_value, &params)?;
        let (_, mut templates, template_memory) = probe.capture_native_entries_with_memory(
            probe_data.store(),
            &MemoryContext::unaccounted(memory.oom_style()),
        )?;
        drop(template_memory);
        let template = templates
            .pop()
            .ok_or_else(|| type_error("Native params output binding"))?;
        let expected_layout = object([
            (
                "outputs",
                property(&value, "outputs")
                    .cloned()
                    .unwrap_or(JsValue::Undefined),
            ),
            (
                "plotOffsets",
                property(&value, "plotOffsets")
                    .cloned()
                    .unwrap_or(JsValue::Undefined),
            ),
        ]);
        if !exact_state_equal(&layout_value(&template), &expected_layout)
            || !exact_state_equal(&template.params, &params)
        {
            return Err(type_error("Native params output binding"));
        }
        let output_bytes = template
            .definition
            .outputs
            .len()
            .checked_mul(capacity)
            .and_then(|values| values.checked_mul(8))
            .ok_or_else(|| range_error("Native params output limit"))?;
        if output_bytes > 268_435_456 {
            return Err(range_error("Native params output limit"));
        }
        let checkpoint_count = if length == 0 { 0 } else { length / 256 + 1 };
        let source_bytes = length * 48;
        let checkpoint_bytes = NATIVE_CHECKPOINT_TOTAL_BYTES;
        let record_metadata_bytes = checkpoint_count * 128;
        let scratch_bytes = 16 * 1_024 * 1_024;
        let total_bytes =
            source_bytes + output_bytes + checkpoint_bytes + record_metadata_bytes + scratch_bytes;
        if total_bytes > max_bytes {
            return Err(range_error("Native params target logical byte limit"));
        }
        let plan = object([
            ("sourceBytes", JsValue::Number(source_bytes as f64)),
            ("outputBytes", JsValue::Number(output_bytes as f64)),
            ("checkpointBytes", JsValue::Number(checkpoint_bytes as f64)),
            (
                "recordMetadataBytes",
                JsValue::Number(record_metadata_bytes as f64),
            ),
            ("scratchBytes", JsValue::Number(scratch_bytes as f64)),
            ("totalBytes", JsValue::Number(total_bytes as f64)),
        ]);
        let Some(JsValue::Array(outputs)) = property(&value, "outputs") else {
            return Err(type_error("Native params output binding"));
        };
        let mut output_names = Vec::new();
        output_names
            .try_reserve_exact(outputs.len())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        for value in outputs {
            output_names.push(
                string(value)
                    .cloned()
                    .ok_or_else(|| type_error("Native params output binding"))?,
            );
        }
        Ok(Self {
            binding: NativeParamsBinding {
                registration: registration as u64,
                id,
                name,
                params,
                module: property(&value, "module").cloned(),
                length,
                capacity,
                outputs: output_names,
                plot_offsets: property(&value, "plotOffsets")
                    .cloned()
                    .unwrap_or_else(|| JsValue::Object(JsObject::new())),
                max_bytes,
            },
            template: Some(template),
            plan,
            checkpoint_count,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetPhase {
    Capture,
    Validate,
    Calculate,
    Outputs,
    Ready,
    Closed,
}

impl TargetPhase {
    fn name(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Validate => "validate",
            Self::Calculate => "calculate",
            Self::Outputs => "outputs",
            Self::Ready => "ready",
            Self::Closed => "closed",
        }
    }
}

fn target_columns_with_memory(
    capacity: usize,
    memory: &MemoryContext,
) -> Result<(Columns, MemoryGroup), JsError> {
    let (time, mut group) = memory
        .try_vec_filled(capacity, 0.0_f64)
        .map_err(|failure| failure.into_js_error())?;
    let (open, open_group) = memory
        .try_vec_filled(capacity, 0.0_f64)
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(open_group)
        .map_err(|failure| failure.into_js_error())?;
    let (high, high_group) = memory
        .try_vec_filled(capacity, 0.0_f64)
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(high_group)
        .map_err(|failure| failure.into_js_error())?;
    let (low, low_group) = memory
        .try_vec_filled(capacity, 0.0_f64)
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(low_group)
        .map_err(|failure| failure.into_js_error())?;
    let (close, close_group) = memory
        .try_vec_filled(capacity, 0.0_f64)
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(close_group)
        .map_err(|failure| failure.into_js_error())?;
    let (volume, volume_group) = memory
        .try_vec_filled(capacity, 0.0_f64)
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(volume_group)
        .map_err(|failure| failure.into_js_error())?;
    Ok((
        Columns {
            time,
            open,
            high,
            low,
            close,
            volume,
        },
        group,
    ))
}

fn target_output_arrays_with_memory(
    outputs: usize,
    capacity: usize,
    memory: &MemoryContext,
) -> Result<(Vec<Vec<f64>>, MemoryGroup), JsError> {
    let mut arrays = Vec::new();
    arrays
        .try_reserve_exact(outputs)
        .map_err(|_| memory.allocation_failure().into_js_error())?;
    let mut group = MemoryGroup::empty(memory.clone());
    for _ in 0..outputs {
        let (values, values_group) = memory
            .try_vec_filled(capacity, f64::NAN)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(values_group)
            .map_err(|failure| failure.into_js_error())?;
        arrays.push(values);
    }
    Ok((arrays, group))
}

/// Isolated-runtime native params target다.
pub struct NativeParamsTarget {
    spec: NativeParamsTargetSpec,
    dialect: NumberDialect,
    memory: MemoryContext,
    columns: Option<Columns>,
    received: [usize; 6],
    phase: TargetPhase,
    chunk_size: Option<usize>,
    at: usize,
    output: usize,
    previous: f64,
    index: Option<RangeIndex>,
    payload_memory: Option<MemoryGroup>,
    data: Option<ModelDataState>,
    engine: Option<IndicatorEngine>,
    calculation: Option<IndicatorCalculation>,
}

impl NativeParamsTarget {
    /// Worker metadata를 검증하고 input columns를 선할당한다.
    pub fn new(
        metadata: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
    ) -> Result<Self, JsError> {
        Self::new_with_memory(
            metadata,
            dialect,
            host,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
    }

    /// Worker metadata를 검증하고 engine account에 input columns를 선할당한다.
    pub fn new_with_memory(
        metadata: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        let spec = NativeParamsTargetSpec::parse(metadata, dialect, host, &memory)?;
        let capacity = spec.binding.capacity;
        let (columns, mut payload_memory) = target_columns_with_memory(capacity, &memory)?;
        let (index, index_memory) =
            RangeIndex::new_with_memory(0, &[], &[], Some(&[]), capacity, false, &memory)?;
        payload_memory
            .absorb(index_memory)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self {
            spec,
            dialect,
            memory,
            columns: Some(columns),
            received: [0; 6],
            phase: TargetPhase::Capture,
            chunk_size: None,
            at: 0,
            output: 0,
            previous: f64::NEG_INFINITY,
            index: Some(index),
            payload_memory: Some(payload_memory),
            data: None,
            engine: None,
            calculation: None,
        })
    }

    /// 여섯 input column을 slot별 연속 prefix로 받는다.
    pub fn target(&mut self, slot: f64, offset: f64, count: f64) -> Result<&mut [f64], JsError> {
        if self.phase != TargetPhase::Capture
            || !exact_integer(slot, 0.0, 5.0)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, PARAMS_CHUNK as f64)
        {
            return Err(range_error("Native params input slice"));
        }
        let slot = slot as usize;
        if offset as usize != self.received[slot]
            || offset + count > self.spec.binding.length as f64
        {
            return Err(range_error("Native params input slice"));
        }
        self.received[slot] += count as usize;
        let columns = self.columns.as_mut().expect("params columns");
        let values = match slot {
            0 => &mut columns.time,
            1 => &mut columns.open,
            2 => &mut columns.high,
            3 => &mut columns.low,
            4 => &mut columns.close,
            5 => &mut columns.volume,
            _ => unreachable!(),
        };
        Ok(&mut values[offset as usize..(offset + count) as usize])
    }

    /// input completeness를 확인하고 bounded validation을 시작한다.
    pub fn start(&mut self) -> Result<(), JsError> {
        if self.phase != TargetPhase::Capture
            || self
                .received
                .iter()
                .any(|received| *received != self.spec.binding.length)
        {
            return Err(ordinary_error("Native params incomplete input"));
        }
        self.phase = TargetPhase::Validate;
        Ok(())
    }

    /// 고정 chunk size로 validate/calculate/output-tail 검사를 진행한다.
    pub fn step(
        &mut self,
        max_bars: f64,
        host: &dyn Host,
    ) -> Result<NativeParamsProgress, JsError> {
        if !exact_integer(max_bars, 1.0, PARAMS_CHUNK as f64) {
            return Err(range_error("Native params work size"));
        }
        let max_bars = max_bars as usize;
        if self.chunk_size.is_some_and(|size| size != max_bars) {
            return Err(range_error("Native params work size must remain fixed"));
        }
        self.chunk_size = Some(max_bars);
        if self.phase == TargetPhase::Capture {
            return Err(ordinary_error("Native params not started"));
        }
        if self.phase == TargetPhase::Closed {
            return Err(ordinary_error("Native params target closed"));
        }
        let length = self.spec.binding.length;
        if self.phase == TargetPhase::Validate {
            let end = std::cmp::min(length, self.at + max_bars);
            let columns = self.columns.as_ref().expect("params columns");
            while self.at < end {
                let index = self.at;
                let bar = Bar {
                    time: columns.time[index],
                    open: columns.open[index],
                    high: columns.high[index],
                    low: columns.low[index],
                    close: columns.close[index],
                    volume: columns.volume[index],
                };
                validate_bar(&bar, self.previous)?;
                self.previous = bar.time;
                self.index
                    .as_mut()
                    .expect("params range index")
                    .update(index, bar.low, bar.high, bar.volume)?;
                self.at += 1;
            }
            if self.at < length {
                return Ok(self.progress(self.at, length));
            }
            self.initialize_engine()?;
            self.phase = TargetPhase::Calculate;
            self.at = 0;
            return Ok(self.progress(0, length));
        }
        if self.phase == TargetPhase::Calculate {
            let engine = self.engine.as_mut().expect("params engine");
            let data = self.data.as_ref().expect("params data");
            if self.calculation.is_none() {
                self.calculation = Some(engine.calculate(
                    JsValue::String(self.spec.binding.id.clone()),
                    max_bars as f64,
                ));
            }
            let step = self
                .calculation
                .as_mut()
                .expect("params calculation")
                .step(engine, data.store(), host)?;
            match step {
                CalculationStep::Yield { to, .. } => {
                    return Ok(self.progress(to, length));
                }
                CalculationStep::Complete { .. } | CalculationStep::Exhausted => {
                    self.calculation = None;
                    let entry = engine
                        .entry(&JsValue::String(self.spec.binding.id.clone()))
                        .expect("params entry");
                    if entry.checkpoint_keys().len() != self.spec.checkpoint_count {
                        return Err(type_error("Native params checkpoint count"));
                    }
                    self.phase = TargetPhase::Outputs;
                    self.at = 0;
                    self.output = 0;
                    return Ok(self.progress(
                        0,
                        self.spec.binding.outputs.len() * self.spec.binding.capacity,
                    ));
                }
            }
        }
        if self.phase == TargetPhase::Outputs {
            let entry = self
                .engine
                .as_ref()
                .expect("params engine")
                .entry(&JsValue::String(self.spec.binding.id.clone()))
                .expect("params entry");
            let mut remaining = max_bars;
            while self.output < self.spec.binding.outputs.len() && remaining > 0 {
                let output = self.spec.binding.outputs[self.output].to_string_lossy();
                let values = entry
                    .output_capacity(&output)
                    .ok_or_else(|| type_error("Native params output capacity"))?;
                if values.len() != self.spec.binding.capacity {
                    return Err(type_error("Native params output capacity"));
                }
                let end = std::cmp::min(self.spec.binding.capacity, self.at + remaining);
                while self.at < end {
                    let value = values[self.at];
                    if self.at >= length {
                        if !value.is_nan() {
                            return Err(type_error("Native params output finite/NaN"));
                        }
                    } else if value.is_infinite() {
                        return Err(type_error("Native params output finite/NaN"));
                    }
                    self.at += 1;
                    remaining -= 1;
                }
                if self.at == self.spec.binding.capacity {
                    self.at = 0;
                    self.output += 1;
                }
            }
            if self.output < self.spec.binding.outputs.len() {
                return Ok(self.progress(
                    self.output * self.spec.binding.capacity + self.at,
                    self.spec.binding.outputs.len() * self.spec.binding.capacity,
                ));
            }
            self.phase = TargetPhase::Ready;
        }
        Ok(self.progress(1, 1))
    }

    fn initialize_engine(&mut self) -> Result<(), JsError> {
        let (arrays, output_memory) = target_output_arrays_with_memory(
            self.spec.binding.outputs.len(),
            self.spec.binding.capacity,
            &self.memory,
        )?;
        let columns = self.columns.take().expect("params columns");
        let index = self.index.take().expect("params range index");
        let payload_memory = self.payload_memory.take().expect("params memory");
        // The validated target payload was charged before it crossed into the store. Rebuild
        // the store through the accounted adoption seam so the target does not charge it twice.
        let data = ModelDataState::from_validated_native_snapshot_columns_with_memory(
            1.0,
            StoreOptions {
                timeframe_ms: 60_000.0,
                time_origin: 0.0,
                max_bars: RESOURCE_LIMITS.max_bars as usize,
            },
            columns,
            index,
            self.spec.binding.length,
            1.0,
            1.0,
            payload_memory,
        )?;
        let mut engine = IndicatorEngine::new_with_memory(
            IndicatorEngineOptions::default(),
            self.memory.clone(),
        )?;
        let mut template = self
            .spec
            .template
            .take()
            .ok_or_else(|| ordinary_error("Native params target entry changed"))?;
        template.arrays = arrays;
        template.checkpoints.clear();
        template.revision = 0.0;
        template.dirty = 0;
        template.dirty_to = Some(self.spec.binding.length);
        template.invalidated = true;
        template.length = 0;
        template.computed_from = None;
        template.computed_until = None;
        template.prepared_version = None;
        let stage =
            engine.stage_native_restore_with_memory(data.store(), vec![template], output_memory)?;
        engine.publish_native_restore(data.store(), stage)?;
        self.data = Some(data);
        self.engine = Some(engine);
        Ok(())
    }

    fn progress(&self, done: usize, total: usize) -> NativeParamsProgress {
        NativeParamsProgress {
            phase: self.phase.name(),
            done,
            total,
            complete: self.phase == TargetPhase::Ready,
        }
    }

    /// Ready result descriptor다.
    pub fn descriptor(&self) -> Result<JsValue, JsError> {
        let mut scope = MemoryScope::unaccounted(self.memory.oom_style());
        self.descriptor_scoped(&mut scope)
    }

    /// Ready descriptor를 caller serialization scope에 직접 만든다.
    pub fn descriptor_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        self.ready()?;
        let checkpoint_bytes = self.checkpoint_bytes_scoped(scope)?;
        let capacity = 13 + usize::from(self.spec.binding.module.is_some());
        let mut entries = scoped_entries(capacity, scope)?;
        push_scoped(
            &mut entries,
            "schema",
            scoped_text("aster.native-params-result", scope)?,
            scope,
        )?;
        push_scoped(&mut entries, "version", JsValue::Number(1.0), scope)?;
        push_scoped(
            &mut entries,
            "registration",
            JsValue::Number(self.spec.binding.registration as f64),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "id",
            JsValue::String(
                self.spec
                    .binding
                    .id
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "name",
            JsValue::String(
                self.spec
                    .binding
                    .name
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "params",
            self.spec
                .binding
                .params
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            scope,
        )?;
        if let Some(module) = &self.spec.binding.module {
            push_scoped(
                &mut entries,
                "module",
                module
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
                scope,
            )?;
        }
        scope
            .try_grow(
                self.spec
                    .binding
                    .outputs
                    .len()
                    .saturating_mul(std::mem::size_of::<JsValue>()),
            )
            .map_err(|failure| failure.into_js_error())?;
        let mut outputs = Vec::new();
        outputs
            .try_reserve_exact(self.spec.binding.outputs.len())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        for output in &self.spec.binding.outputs {
            outputs.push(JsValue::String(
                output
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ));
        }
        push_scoped(&mut entries, "outputs", JsValue::Array(outputs), scope)?;
        push_scoped(
            &mut entries,
            "plotOffsets",
            self.spec
                .binding
                .plot_offsets
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            scope,
        )?;
        push_scoped(
            &mut entries,
            "length",
            JsValue::Number(self.spec.binding.length as f64),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "capacity",
            JsValue::Number(self.spec.binding.capacity as f64),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "checkpointCount",
            JsValue::Number(self.spec.checkpoint_count as f64),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "checkpointBytes",
            JsValue::Number(checkpoint_bytes as f64),
            scope,
        )?;
        push_scoped(
            &mut entries,
            "plan",
            self.spec
                .plan
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            scope,
        )?;
        JsObject::try_from_entries_scoped(entries, scope)
            .map(JsValue::Object)
            .map_err(|failure| failure.into_js_error())
    }

    /// Ready output capacity slice다.
    pub fn output_buffer(&self, slot: f64, offset: f64, count: f64) -> Result<&[f64], JsError> {
        self.ready()?;
        if !exact_integer(slot, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, PARAMS_CHUNK as f64)
            || slot >= self.spec.binding.outputs.len() as f64
            || offset + count > self.spec.binding.capacity as f64
        {
            return Err(range_error("Native params output slice"));
        }
        let output = self.spec.binding.outputs[slot as usize].to_string_lossy();
        let values = self
            .engine
            .as_ref()
            .expect("params engine")
            .entry(&JsValue::String(self.spec.binding.id.clone()))
            .and_then(|entry| entry.output_capacity(&output))
            .ok_or_else(|| range_error("Native params output slice"))?;
        Ok(&values[offset as usize..(offset + count) as usize])
    }

    /// Ready checkpoint record 하나다.
    pub fn checkpoint(&self, ordinal: f64) -> Result<NativeParamsCheckpointRecord, JsError> {
        let mut scope = MemoryScope::unaccounted(self.memory.oom_style());
        self.checkpoint_scoped(ordinal, &mut scope)
    }

    /// Ready checkpoint text를 caller serialization scope에 직접 만든다.
    pub fn checkpoint_scoped(
        &self,
        ordinal: f64,
        scope: &mut MemoryScope,
    ) -> Result<NativeParamsCheckpointRecord, JsError> {
        self.ready()?;
        if !exact_integer(
            ordinal,
            0.0,
            self.spec.checkpoint_count.saturating_sub(1) as f64,
        ) || ordinal >= self.spec.checkpoint_count as f64
        {
            return Err(range_error("Native params checkpoint ordinal"));
        }
        let index = ordinal as usize * 256;
        let lookup = self
            .spec
            .binding
            .id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let state = self
            .engine
            .as_ref()
            .expect("params engine")
            .entry(&JsValue::String(lookup))
            .and_then(|entry| entry.checkpoint(index))
            .ok_or_else(|| range_error("Native params checkpoint ordinal"))?;
        let text = protocol_stringify_scoped(state, self.dialect, scope)?;
        if text.len_utf16() * 2 > NATIVE_CHECKPOINT_RECORD_BYTES {
            return Err(range_error("Native params checkpoint record limit"));
        }
        Ok(NativeParamsCheckpointRecord { index, text })
    }

    fn checkpoint_bytes_scoped(&self, scope: &mut MemoryScope) -> Result<usize, JsError> {
        let lookup = self
            .spec
            .binding
            .id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let entry = self
            .engine
            .as_ref()
            .expect("params engine")
            .entry(&JsValue::String(lookup))
            .expect("params entry");
        let mut total = 0usize;
        let mut after = None;
        while let Some((index, state)) = entry.checkpoint_next(after) {
            total = total
                .checked_add(native_checkpoint_footprint(state)?.encoded_bytes)
                .ok_or_else(|| range_error("Native checkpoint total byte limit"))?;
            after = Some(index);
        }
        Ok(total)
    }

    fn ready(&self) -> Result<(), JsError> {
        if self.phase == TargetPhase::Closed {
            Err(ordinary_error("Native params target closed"))
        } else if self.phase != TargetPhase::Ready {
            Err(ordinary_error("Native params target not ready"))
        } else {
            Ok(())
        }
    }

    /// Target-owned calculation state를 닫는다.
    pub fn dispose(&mut self) {
        self.phase = TargetPhase::Closed;
        self.columns = None;
        self.index = None;
        self.payload_memory = None;
        self.data = None;
        if let Some(engine) = &mut self.engine {
            engine.dispose();
        }
        self.engine = None;
        self.calculation = None;
    }
}

struct ParamsSourceFingerprint {
    data: DataIdentity,
    version_bits: u64,
    model: Vec<u8>,
    model_identity: crate::model_state::ModelWorkspaceCaptureToken,
    values_identity: crate::model_state::SeriesValuesReferenceToken,
    indicators: NativeIndicatorCaptureToken,
    caches: SeriesCachesCaptureToken,
}

/// Web actor용 params source fingerprint다.
///
/// 기존 NativeParamsSource의 fingerprint는 NativeWorkspace source와 같은 보수적인
/// model snapshot을 포함한다. 웹은 view/follow/theme/drawing/history/controller를
/// 바꿀 수 있어야 하므로 그 fingerprint를 약화하지 않고 별도 토큰을 둔다. 이 토큰은
/// 실제 data store와 indicator/model owner만 읽으며, 값 배열이나 표시 상태를 복제하지 않는다.
/// Series cache는 data/value/configuration에서 재생성하는 파생 표시 상태라 stale read-set이 아니다.
#[cfg(target_arch = "wasm32")]
struct WebParamsSourceFingerprint {
    data: DataIdentity,
    serial_bits: u64,
    version_bits: u64,
    time_version_bits: u64,
    length: usize,
    capacity: usize,
    model: crate::model_state::ModelWebParamsCaptureToken,
    indicators: NativeIndicatorCaptureToken,
}

#[cfg(target_arch = "wasm32")]
impl WebParamsSourceFingerprint {
    /// 웹 params 작업의 좁은 read-set을 capture한다.
    pub fn capture(
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        _caches: &SeriesCaches,
        _dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        let store = owner.data().store();
        Ok(Self {
            data: store.data_identity(),
            serial_bits: store.serial().to_bits(),
            version_bits: store.version().to_bits(),
            time_version_bits: store.time_version().to_bits(),
            length: store.length(),
            capacity: store.capacity(),
            model: model.capture_web_params_state(),
            indicators: engine.capture_native_token_accounted(store)?,
        })
    }

    /// 표시 상태를 제외하고 web params 작업의 계산 read-set만 검증한다.
    pub fn matches(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        _caches: &SeriesCaches,
        _dialect: NumberDialect,
    ) -> bool {
        let store = owner.data().store();
        self.data.matches(&store.data_identity())
            && self.serial_bits == store.serial().to_bits()
            && self.version_bits == store.version().to_bits()
            && self.time_version_bits == store.time_version().to_bits()
            && self.length == store.length()
            && self.capacity == store.capacity()
            && model.validate_web_params_state(&self.model)
            && engine.validate_native_capture(store, &self.indicators)
    }
}

enum ParamsSourceFingerprintKind {
    Strict(ParamsSourceFingerprint),
    #[cfg(target_arch = "wasm32")]
    Web(WebParamsSourceFingerprint),
}

impl ParamsSourceFingerprint {
    fn capture(
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        let fingerprint_text = protocol_stringify(
            &model.snapshot(),
            dialect,
            owner.data().store().memory_context().oom_style(),
        )?;
        let units = fingerprint_text.as_units();
        let bytes = units.len().checked_mul(2).ok_or_else(|| {
            owner
                .data()
                .store()
                .memory_context()
                .allocation_failure()
                .into_js_error()
        })?;
        let mut model_fingerprint = Vec::new();
        model_fingerprint.try_reserve_exact(bytes).map_err(|_| {
            owner
                .data()
                .store()
                .memory_context()
                .allocation_failure()
                .into_js_error()
        })?;
        for unit in units {
            model_fingerprint.extend_from_slice(&unit.to_le_bytes());
        }
        Ok(Self {
            data: owner.data().store().data_identity(),
            version_bits: owner.data().store().version().to_bits(),
            model: model_fingerprint,
            model_identity: model.capture_workspace_state(),
            values_identity: model.capture_series_values_reference(),
            indicators: engine.capture_native_token_accounted(owner.data().store())?,
            caches: caches.capture_token(),
        })
    }

    fn matches(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        dialect: NumberDialect,
    ) -> bool {
        let store = owner.data().store();
        if !self.data.matches(&store.data_identity())
            || self.version_bits != store.version().to_bits()
            || !engine.validate_native_capture(store, &self.indicators)
            || !caches.validate_capture(&self.caches)
            || !model.validate_workspace_state(&self.model_identity)
            || !model.validate_series_values_reference(&self.values_identity)
        {
            return false;
        }
        protocol_stringify(
            &model.snapshot(),
            dialect,
            owner.data().store().memory_context().oom_style(),
        )
        .is_ok_and(|value| {
            value
                .as_units()
                .iter()
                .flat_map(|unit| unit.to_le_bytes())
                .eq(self.model.iter().copied())
        })
    }
}

fn add_unique_bytes(seen: &mut HashSet<(usize, usize)>, values: &[f64], total: &mut usize) {
    let identity = (values.as_ptr() as usize, values.len());
    if seen.insert(identity) {
        *total = total.saturating_add(values.len().saturating_mul(8));
    }
}

fn retained_source_bytes(
    owner: &IngestionOwner,
    lease: &AsyncIngestionLease,
    model: &ModelState,
    engine: &IndicatorEngine,
    caches: &SeriesCaches,
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut seen = HashSet::new();
    seen.try_reserve(
        16usize
            .saturating_add(engine.len().saturating_mul(8))
            .saturating_add(model.series.len().saturating_mul(4)),
    )
    .map_err(|_| memory.allocation_failure().into_js_error())?;
    let mut total = 0usize;
    let columns = owner.data().store().columns();
    for values in [
        columns.time.as_slice(),
        columns.open.as_slice(),
        columns.high.as_slice(),
        columns.low.as_slice(),
        columns.close.as_slice(),
        columns.volume.as_slice(),
    ] {
        add_unique_bytes(&mut seen, values, &mut total);
    }
    let tree = owner.data().store().index().buffer_view();
    add_unique_bytes(&mut seen, tree.min, &mut total);
    add_unique_bytes(&mut seen, tree.max, &mut total);
    if let Some(sum) = tree.sum {
        add_unique_bytes(&mut seen, sum, &mut total);
    }
    for id in engine.entry_ids() {
        let entry = engine
            .entry(&JsValue::String(id))
            .expect("entry id current");
        for output in entry.definition().outputs {
            if let Some(values) = entry.output_capacity(output) {
                add_unique_bytes(&mut seen, values, &mut total);
            }
        }
    }
    for series in &model.series {
        if let Some(values) = series.values.as_deref() {
            add_unique_bytes(&mut seen, values, &mut total);
        }
        if let Some(view) = caches.buffer_view(&series.id) {
            let tree = match view {
                SeriesCacheBufferView::Flat { tree }
                | SeriesCacheBufferView::Block { tree, .. } => tree,
            };
            add_unique_bytes(&mut seen, tree.min, &mut total);
            add_unique_bytes(&mut seen, tree.max, &mut total);
            if let Some(sum) = tree.sum {
                add_unique_bytes(&mut seen, sum, &mut total);
            }
        }
    }
    if let Some(ingestion) = owner.async_buffer_view(lease) {
        for values in ingestion.columns {
            add_unique_bytes(&mut seen, values, &mut total);
        }
        total = total.saturating_add(ingestion.kinds.len());
    }
    Ok(total)
}

fn definition_layout_equal(
    left: &NativeIndicatorEntrySnapshot,
    right: &crate::indicator_types::IndicatorDefinition,
) -> bool {
    left.definition.outputs == right.outputs
        && left.definition.outputs.iter().all(|output| {
            left.definition.effective_plot_offset(output).to_bits()
                == right.effective_plot_offset(output).to_bits()
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourcePhase {
    Admission,
    Noop,
    Copy,
    Receive,
    Validate,
    Armed,
    Closed,
}

struct CheckpointCursor {
    id: JsString,
    key: usize,
    target: bool,
}

/// Owner-runtime params source/import/publication state다.
pub struct NativeParamsSource {
    revision: f64,
    registration: u64,
    id: JsString,
    max_bytes: usize,
    source_capacity: usize,
    dialect: NumberDialect,
    phase: SourcePhase,
    fingerprint: ParamsSourceFingerprintKind,
    noop: bool,
    layout: JsValue,
    binding: Option<NativeParamsBinding>,
    metadata_json: Option<JsString>,
    metadata_memory: MemoryGroup,
    candidate: Option<NativeIndicatorEntrySnapshot>,
    offsets: [usize; 6],
    checkpoint_rows: Vec<CheckpointCursor>,
    _checkpoint_rows_memory: MemoryGroup,
    checkpoint_at: usize,
    source_bytes: usize,
    old_checkpoint_bytes: usize,
    other_checkpoint_bytes: usize,
    remaining_checkpoint_bytes: usize,
    plan: Option<JsValue>,
    import: Option<NativeParamsImport>,
    candidate_memory: Option<MemoryGroup>,
    replacement: Option<NativeIndicatorReplacementStage>,
    checkpoint_entries: Option<Vec<(usize, JsValue)>>,
    checkpoint_memory: Option<MemoryGroup>,
    dependent_ids: Vec<JsString>,
    _dependent_ids_memory: MemoryGroup,
    receipt: Option<JsValue>,
    receipt_memory: MemoryGroup,
    receipt_build_bytes: u64,
}

impl NativeParamsSource {
    /// Prepared publish receipt가 현재 보유한 exact requested bytes다.
    pub fn receipt_accounted_bytes(&self) -> u64 {
        self.receipt_memory.requested_bytes()
    }

    /// Prepared receipt construction scope의 exact requested peak contribution이다.
    pub fn receipt_build_bytes(&self) -> u64 {
        self.receipt_build_bytes
    }

    /// Live entry와 요청 params를 capture한다. Root가 별도 busy/lease를 먼저 획득한다.
    #[allow(clippy::too_many_arguments)]
    pub fn capture(
        owner: &IngestionOwner,
        lease: &AsyncIngestionLease,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        id: &JsValue,
        params: &JsValue,
        revision: f64,
        registration: f64,
        max_bytes: f64,
        dialect: NumberDialect,
        host: &dyn Host,
    ) -> Result<Self, JsError> {
        Self::capture_with_mode(
            owner,
            lease,
            model,
            engine,
            caches,
            id,
            params,
            revision,
            registration,
            max_bytes,
            dialect,
            host,
            false,
        )
    }

    /// 웹 actor가 표시 상태와 독립된 params read-set을 같은 begin 호출 안에서 capture한다.
    #[cfg(target_arch = "wasm32")]
    #[allow(clippy::too_many_arguments)]
    pub fn capture_web(
        owner: &IngestionOwner,
        lease: &AsyncIngestionLease,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        id: &JsValue,
        params: &JsValue,
        revision: f64,
        registration: f64,
        max_bytes: f64,
        dialect: NumberDialect,
        host: &dyn Host,
    ) -> Result<Self, JsError> {
        Self::capture_with_mode(
            owner,
            lease,
            model,
            engine,
            caches,
            id,
            params,
            revision,
            registration,
            max_bytes,
            dialect,
            host,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn capture_with_mode(
        owner: &IngestionOwner,
        lease: &AsyncIngestionLease,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        id: &JsValue,
        params: &JsValue,
        revision: f64,
        registration: f64,
        max_bytes: f64,
        dialect: NumberDialect,
        host: &dyn Host,
        web: bool,
    ) -> Result<Self, JsError> {
        let id = identifier(id, "Indicator id")?.clone();
        if !exact_integer(revision, 0.0, MAX_SAFE_INTEGER) {
            return Err(range_error("Native params host revision"));
        }
        if !exact_integer(registration, 1.0, MAX_SAFE_INTEGER) {
            return Err(range_error("Native params registration"));
        }
        if !exact_integer(max_bytes, 1.0, PARAMS_MAX_BYTES as f64) {
            return Err(range_error("Native params byte budget"));
        }
        crate::indicator_params::validate_indicator_params(params)?;
        let memory = owner.data().store().memory_context();
        let mut requested_scope = MemoryScope::unaccounted(memory.oom_style());
        let requested = params
            .try_clone_scoped(&mut requested_scope)
            .map_err(|failure| failure.into_js_error())?;
        crate::indicator_params::validate_indicator_params(&requested)?;
        let current = engine
            .entry(&JsValue::String(id.clone()))
            .ok_or_else(|| ordinary_error("Missing indicator"))?;
        let source_memory = owner.data().store().memory_context().clone();
        if !source_memory.shares_account(engine.memory_context())
            || !source_memory.shares_account(caches.memory_context())
        {
            return Err(type_error("Native params memory context"));
        }
        if engine.checkpoint_size() != 256 {
            return Err(range_error("Native params checkpoint size"));
        }
        let noop = exact_state_equal(current.params(), &requested);
        let mut offsets = JsObject::new();
        for offset in &current.definition().plot_offsets {
            offsets.insert(key(offset.output), JsValue::Number(offset.value));
        }
        let layout = object([
            (
                "outputs",
                JsValue::Array(
                    current
                        .definition()
                        .outputs
                        .iter()
                        .map(|output| text(output))
                        .collect(),
                ),
            ),
            ("plotOffsets", JsValue::Object(offsets)),
        ]);
        #[cfg(target_arch = "wasm32")]
        let fingerprint = if web {
            ParamsSourceFingerprintKind::Web(WebParamsSourceFingerprint::capture(
                owner, model, engine, caches, dialect,
            )?)
        } else {
            ParamsSourceFingerprintKind::Strict(ParamsSourceFingerprint::capture(
                owner, model, engine, caches, dialect,
            )?)
        };
        #[cfg(not(target_arch = "wasm32"))]
        let fingerprint = {
            let _ = web;
            ParamsSourceFingerprintKind::Strict(ParamsSourceFingerprint::capture(
                owner, model, engine, caches, dialect,
            )?)
        };
        if noop {
            return Ok(Self {
                revision,
                registration: registration as u64,
                id,
                max_bytes: max_bytes as usize,
                source_capacity: owner.data().store().capacity(),
                dialect,
                phase: SourcePhase::Noop,
                fingerprint,
                noop,
                layout,
                binding: None,
                metadata_json: None,
                metadata_memory: MemoryGroup::empty(source_memory.clone()),
                candidate: None,
                offsets: [0; 6],
                checkpoint_rows: Vec::new(),
                _checkpoint_rows_memory: MemoryGroup::empty(source_memory.clone()),
                checkpoint_at: 0,
                source_bytes: 0,
                old_checkpoint_bytes: 0,
                other_checkpoint_bytes: 0,
                remaining_checkpoint_bytes: 0,
                plan: None,
                import: None,
                candidate_memory: None,
                replacement: None,
                checkpoint_entries: None,
                checkpoint_memory: None,
                dependent_ids: Vec::new(),
                _dependent_ids_memory: MemoryGroup::empty(source_memory.clone()),
                receipt: None,
                receipt_memory: MemoryGroup::empty(source_memory.clone()),
                receipt_build_bytes: 0,
            });
        }
        let probe_memory = MemoryContext::unaccounted(source_memory.oom_style());
        let probe_data = ModelDataState::new_with_memory(
            StoreOptions::default(),
            Vec::new(),
            probe_memory.clone(),
        )?;
        let mut probe =
            IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), probe_memory)?;
        probe.add(
            probe_data.store(),
            host,
            &JsValue::String(id.clone()),
            &JsValue::String(current.name().clone()),
            &requested,
        )?;
        let (_, mut candidates, candidate_memory) =
            probe.capture_native_entries_with_memory(probe_data.store(), &source_memory)?;
        let candidate = candidates
            .pop()
            .ok_or_else(|| type_error("Native params factory changed params"))?;
        if !exact_state_equal(&candidate.params, &requested) {
            return Err(type_error("Native params factory changed params"));
        }
        if !definition_layout_equal(&candidate, current.definition()) {
            return Err(type_error("Native params output schema/offset change"));
        }
        let length = owner.data().store().length();
        let capacity = owner.data().store().capacity();
        let output_count = engine
            .entry_ids()
            .into_iter()
            .map(|entry_id| {
                if entry_id == id {
                    candidate.definition.outputs.len()
                } else {
                    engine
                        .entry(&JsValue::String(entry_id))
                        .expect("entry current")
                        .definition()
                        .outputs
                        .len()
                }
            })
            .sum::<usize>();
        if output_count
            .checked_mul(capacity)
            .and_then(|values| values.checked_mul(8))
            .is_none_or(|bytes| bytes > engine.max_output_bytes())
        {
            return Err(range_error("Native params total output byte limit"));
        }
        let mut plot_offsets = JsObject::new();
        for offset in &candidate.definition.plot_offsets {
            plot_offsets.insert(key(offset.output), JsValue::Number(offset.value));
        }
        let module = match candidate.definition.provenance {
            crate::indicator_types::IndicatorProvenance::Linked(_) => {
                Some(crate::indicator_modules::pressure_descriptor_value())
            }
            crate::indicator_types::IndicatorProvenance::Builtin => None,
        };
        let mut output_names = Vec::new();
        output_names
            .try_reserve_exact(candidate.definition.outputs.len())
            .map_err(|_| source_memory.allocation_failure().into_js_error())?;
        for output in candidate.definition.outputs {
            output_names.push(key(output));
        }
        let binding = NativeParamsBinding {
            registration: registration as u64,
            id: id.clone(),
            name: candidate.name.clone(),
            params: candidate.params.clone(),
            module,
            length,
            capacity,
            outputs: output_names,
            plot_offsets: JsValue::Object(plot_offsets),
            max_bytes: max_bytes as usize,
        };
        let metadata = binding.to_target_metadata();
        let mut metadata_scope = source_memory.scope();
        let metadata_json = protocol_stringify_scoped(&metadata, dialect, &mut metadata_scope)?;
        let metadata_memory = metadata_scope
            .split_persistent(
                metadata_json
                    .len_utf16()
                    .saturating_mul(std::mem::size_of::<u16>()),
            )
            .map_err(|failure| failure.into_js_error())?;
        let checkpoint_count = engine
            .entry_ids_iter()
            .map(|entry_id| {
                engine
                    .entry_by_id(entry_id)
                    .expect("entry id current")
                    .checkpoint_len()
            })
            .try_fold(0usize, |total, count| total.checked_add(count))
            .ok_or_else(|| source_memory.allocation_failure().into_js_error())?;
        let (mut checkpoint_rows, mut checkpoint_rows_memory) = source_memory
            .try_vec_capacity(checkpoint_count)
            .map_err(|failure| failure.into_js_error())?;
        let mut checkpoint_scope = source_memory.scope();
        for entry_id in engine.entry_ids_iter() {
            let entry = engine.entry_by_id(entry_id).expect("entry current");
            let mut after = None;
            while let Some((checkpoint, _)) = entry.checkpoint_next(after) {
                checkpoint_rows.push(CheckpointCursor {
                    id: entry_id
                        .try_clone_scoped(&mut checkpoint_scope)
                        .map_err(|failure| failure.into_js_error())?,
                    key: checkpoint,
                    target: entry_id == &id,
                });
                after = Some(checkpoint);
            }
        }
        debug_assert_eq!(checkpoint_rows.len(), checkpoint_count);
        let checkpoint_string_bytes = usize::try_from(checkpoint_scope.requested_bytes())
            .map_err(|_| source_memory.allocation_failure().into_js_error())?;
        let checkpoint_strings = checkpoint_scope
            .split_persistent(checkpoint_string_bytes)
            .map_err(|failure| failure.into_js_error())?;
        checkpoint_rows_memory
            .absorb(checkpoint_strings)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self {
            revision,
            registration: registration as u64,
            id,
            max_bytes: max_bytes as usize,
            source_capacity: owner.data().store().capacity(),
            dialect,
            phase: SourcePhase::Admission,
            fingerprint,
            noop,
            layout,
            binding: Some(binding),
            metadata_json: Some(metadata_json),
            metadata_memory,
            candidate: Some(candidate),
            offsets: [0; 6],
            checkpoint_rows,
            _checkpoint_rows_memory: checkpoint_rows_memory,
            checkpoint_at: 0,
            source_bytes: retained_source_bytes(
                owner,
                lease,
                model,
                engine,
                caches,
                &source_memory,
            )?,
            old_checkpoint_bytes: 0,
            other_checkpoint_bytes: 0,
            remaining_checkpoint_bytes: 0,
            plan: None,
            import: None,
            candidate_memory: Some(candidate_memory),
            replacement: None,
            checkpoint_entries: None,
            checkpoint_memory: None,
            dependent_ids: Vec::new(),
            _dependent_ids_memory: MemoryGroup::empty(source_memory.clone()),
            receipt: None,
            receipt_memory: MemoryGroup::empty(source_memory),
            receipt_build_bytes: 0,
        })
    }

    /// 현재 source/store/entry/cache identity와 host revision을 검사한다.
    pub fn check(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        revision: f64,
    ) -> Result<(), JsError> {
        let matches = match &self.fingerprint {
            ParamsSourceFingerprintKind::Strict(fingerprint) => {
                revision.to_bits() == self.revision.to_bits()
                    && fingerprint.matches(owner, model, engine, caches, self.dialect)
            }
            #[cfg(target_arch = "wasm32")]
            ParamsSourceFingerprintKind::Web(fingerprint) => {
                revision.to_bits() == self.revision.to_bits()
                    && fingerprint.matches(owner, model, engine, caches, self.dialect)
            }
        };
        if self.phase == SourcePhase::Closed || !matches {
            return Err(JsError::new(
                "StaleSourceError",
                key("Native params stale: source/owner changed"),
            ));
        }
        Ok(())
    }

    /// 웹 params 작업의 계산 read-set을 검사한다. view/follow/theme/drawing/history/controller
    /// 변경은 이 검사에서 stale을 만들지 않으며, data/indicator/cache 변경은 stale이다.
    /// Target metadata는 changed 요청에서 admission 완료 뒤에만 host가 사용한다.
    pub fn metadata_json(&self) -> Option<&JsString> {
        self.metadata_json.as_ref()
    }

    /// Bridge ArmWrite가 handoff 전에 검사할 output slot 수와 owner capacity다.
    pub fn result_shape(&self) -> (usize, usize) {
        let outputs = match property(&self.layout, "outputs") {
            Some(JsValue::Array(outputs)) => outputs.len(),
            _ => 0,
        };
        (outputs, self.source_capacity)
    }

    /// Armed write handoff가 mutable slice를 빌리기 전에 동일 phase/cursor/bounds를 검사한다.
    #[allow(clippy::too_many_arguments)]
    pub fn check_result_slice(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        slot: f64,
        offset: f64,
        count: f64,
        revision: f64,
    ) -> Result<(), JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.phase != SourcePhase::Receive {
            return Err(ordinary_error("Native params result phase"));
        }
        self.import
            .as_ref()
            .expect("params import")
            .check_target(slot, offset, count)
    }

    /// Admission/checkpoint byte accounting을 maxRecords 단위로 진행한다.
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        max_records: f64,
        revision: f64,
    ) -> Result<JsValue, JsError> {
        let mut scope = MemoryScope::unaccounted(self.metadata_memory.context().oom_style());
        self.step_scoped(
            owner,
            model,
            engine,
            caches,
            max_records,
            revision,
            &mut scope,
        )
    }

    /// Admission progress와 metadata output을 caller serialization scope에 만든다.
    #[allow(clippy::too_many_arguments)]
    pub fn step_scoped(
        &mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        max_records: f64,
        revision: f64,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.phase == SourcePhase::Noop {
            return Ok(object([
                ("phase", text("noop")),
                ("complete", JsValue::Bool(true)),
            ]));
        }
        if self.phase != SourcePhase::Admission {
            return Ok(object([
                (
                    "phase",
                    text(match self.phase {
                        SourcePhase::Copy => "copy",
                        SourcePhase::Receive => "receive",
                        SourcePhase::Validate => "validate",
                        SourcePhase::Armed => "armed",
                        SourcePhase::Admission => "admission",
                        SourcePhase::Noop => "noop",
                        SourcePhase::Closed => "closed",
                    }),
                ),
                ("complete", JsValue::Bool(true)),
            ]));
        }
        if !exact_integer(max_records, 1.0, 64.0) {
            return Err(range_error("Native params admission records"));
        }
        let end = std::cmp::min(
            self.checkpoint_rows.len(),
            self.checkpoint_at + max_records as usize,
        );
        while self.checkpoint_at < end {
            let row = &self.checkpoint_rows[self.checkpoint_at];
            let entry = engine
                .entry(&JsValue::String(row.id.clone()))
                .ok_or_else(|| {
                    JsError::new(
                        "StaleSourceError",
                        key("Native params stale: source/owner changed"),
                    )
                })?;
            let state = entry.checkpoint(row.key).ok_or_else(|| {
                JsError::new(
                    "StaleSourceError",
                    key("Native params stale: source/owner changed"),
                )
            })?;
            let footprint = native_checkpoint_footprint(state)?;
            self.old_checkpoint_bytes = self
                .old_checkpoint_bytes
                .saturating_add(footprint.logical_bytes + 128);
            if !row.target {
                self.other_checkpoint_bytes = self
                    .other_checkpoint_bytes
                    .saturating_add(footprint.encoded_bytes);
            }
            self.checkpoint_at += 1;
            self.check(owner, model, engine, caches, revision)?;
            if self.old_checkpoint_bytes + self.source_bytes > self.max_bytes {
                return Err(range_error("Native params retained source budget"));
            }
        }
        if self.checkpoint_at < self.checkpoint_rows.len() {
            return Ok(object([
                ("phase", text("admission")),
                ("complete", JsValue::Bool(false)),
            ]));
        }
        if self.other_checkpoint_bytes > NATIVE_CHECKPOINT_TOTAL_BYTES {
            return Err(range_error("Native params other checkpoint byte limit"));
        }
        self.remaining_checkpoint_bytes =
            NATIVE_CHECKPOINT_TOTAL_BYTES - self.other_checkpoint_bytes;
        let binding = self.binding.as_ref().expect("changed binding");
        let checkpoint_count = if binding.length == 0 {
            0
        } else {
            binding.length / 256 + 1
        };
        let output = binding.capacity * binding.outputs.len() * 8;
        let retained_bytes = self.source_bytes + self.old_checkpoint_bytes;
        let worker_source_bytes = binding.length * 48;
        let checkpoint_bytes = NATIVE_CHECKPOINT_TOTAL_BYTES * 2;
        let record_metadata_bytes = checkpoint_count * 256;
        let scratch_bytes = 32 * 1_024 * 1_024;
        let transfer_bytes = PARAMS_CHUNK * 8 * 2;
        let total_bytes = retained_bytes
            + worker_source_bytes
            + output
            + output
            + checkpoint_bytes
            + record_metadata_bytes
            + scratch_bytes
            + transfer_bytes;
        if total_bytes > self.max_bytes {
            return Err(range_error("Native params combined logical byte limit"));
        }
        let plan = object([
            ("retainedBytes", JsValue::Number(retained_bytes as f64)),
            (
                "workerSourceBytes",
                JsValue::Number(worker_source_bytes as f64),
            ),
            ("workerOutputBytes", JsValue::Number(output as f64)),
            ("ownerOutputBytes", JsValue::Number(output as f64)),
            ("checkpointBytes", JsValue::Number(checkpoint_bytes as f64)),
            (
                "recordMetadataBytes",
                JsValue::Number(record_metadata_bytes as f64),
            ),
            ("scratchBytes", JsValue::Number(scratch_bytes as f64)),
            ("transferBytes", JsValue::Number(transfer_bytes as f64)),
            ("totalBytes", JsValue::Number(total_bytes as f64)),
        ]);
        self.plan = Some(plan.clone());
        self.phase = SourcePhase::Copy;
        Ok(object([
            ("phase", text("copy")),
            ("complete", JsValue::Bool(true)),
            (
                "metadataJSON",
                JsValue::String(
                    self.metadata_json
                        .as_ref()
                        .expect("changed metadata")
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ),
            (
                "plan",
                plan.try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        ]))
    }

    /// Changed source의 여섯 logical column을 연속 slice로 빌린다.
    #[allow(clippy::too_many_arguments)]
    pub fn check_buffer_slice(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        slot: f64,
        offset: f64,
        count: f64,
        revision: f64,
    ) -> Result<(), JsError> {
        self.check(owner, model, engine, caches, revision)?;
        let length = self.binding.as_ref().map_or(0, |binding| binding.length);
        if self.phase != SourcePhase::Copy
            || !exact_integer(slot, 0.0, 5.0)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, PARAMS_CHUNK as f64)
        {
            return Err(range_error("Native params source slice"));
        }
        let slot = slot as usize;
        if offset as usize != self.offsets[slot] || offset + count > length as f64 {
            return Err(range_error("Native params source slice"));
        }
        Ok(())
    }

    /// Changed source의 여섯 logical column을 연속 slice로 빌린다.
    #[allow(clippy::too_many_arguments)]
    pub fn buffer<'a>(
        &mut self,
        owner: &'a IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        slot: f64,
        offset: f64,
        count: f64,
        revision: f64,
    ) -> Result<&'a [f64], JsError> {
        self.check_buffer_slice(owner, model, engine, caches, slot, offset, count, revision)?;
        let slot = slot as usize;
        self.offsets[slot] += count as usize;
        let columns = owner.data().store().columns();
        let values = match slot {
            0 => &columns.time,
            1 => &columns.open,
            2 => &columns.high,
            3 => &columns.low,
            4 => &columns.close,
            5 => &columns.volume,
            _ => unreachable!(),
        };
        Ok(&values[offset as usize..(offset + count) as usize])
    }

    /// Worker descriptor를 검증하고 owner-side result import를 만든다.
    #[allow(clippy::too_many_arguments)]
    pub fn receive(
        &mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        text: &JsString,
        revision: f64,
    ) -> Result<(), JsError> {
        self.check(owner, model, engine, caches, revision)?;
        let binding = self
            .binding
            .clone()
            .ok_or_else(|| ordinary_error("Native params source copy incomplete"))?;
        if self.phase != SourcePhase::Copy
            || self.offsets.iter().any(|offset| *offset != binding.length)
        {
            return Err(ordinary_error("Native params source copy incomplete"));
        }
        let mut candidate = self
            .candidate
            .take()
            .ok_or_else(|| ordinary_error("Native params source copy incomplete"))?;
        // The probe arrays/checkpoints are only a definition template. Worker output replaces
        // them below, so release their capture group before the result-write candidate starts.
        candidate.arrays = Vec::new();
        candidate.checkpoints.clear();
        self.candidate_memory.take();
        let memory = owner.data().store().memory_context().clone();
        self.import = Some(NativeParamsImport::new(
            text,
            binding,
            candidate,
            self.remaining_checkpoint_bytes,
            self.dialect,
            memory,
        )?);
        self.phase = SourcePhase::Receive;
        Ok(())
    }

    /// Worker output slice를 owner import buffer에 직접 쓴다.
    #[allow(clippy::too_many_arguments)]
    pub fn result_buffer<'a>(
        &'a mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        slot: f64,
        offset: f64,
        count: f64,
        revision: f64,
    ) -> Result<&'a mut [f64], JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.phase != SourcePhase::Receive {
            return Err(ordinary_error("Native params result phase"));
        }
        self.import
            .as_mut()
            .expect("params import")
            .target(slot, offset, count)
    }

    /// Worker checkpoint record를 owner import ledger에 넣는다.
    #[allow(clippy::too_many_arguments)]
    pub fn checkpoint(
        &mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        index: f64,
        text: &JsString,
        revision: f64,
    ) -> Result<(), JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.phase != SourcePhase::Receive {
            return Err(ordinary_error("Native params result phase"));
        }
        self.import
            .as_mut()
            .expect("params import")
            .checkpoint(index, text)?;
        self.check(owner, model, engine, caches, revision)
    }

    /// Owner result arrays를 maxValues 단위로 검증한다.
    #[allow(clippy::too_many_arguments)]
    pub fn validate(
        &mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        max_values: f64,
        revision: f64,
    ) -> Result<NativeParamsProgress, JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.phase == SourcePhase::Receive {
            self.import.as_mut().expect("params import").start()?;
            self.phase = SourcePhase::Validate;
        }
        if self.phase != SourcePhase::Validate {
            return Err(ordinary_error("Native params validation phase"));
        }
        let result = self
            .import
            .as_mut()
            .expect("params import")
            .step(max_values)?;
        self.check(owner, model, engine, caches, revision)?;
        Ok(result)
    }

    /// Worker cleanup acknowledgement 뒤 detached replacement commit을 준비한다.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        &mut self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        revision: f64,
    ) -> Result<(), JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.noop {
            if self.phase != SourcePhase::Noop {
                return Err(ordinary_error("Native params validation phase"));
            }
        } else {
            let memory = owner.data().store().memory_context().clone();
            let dependent_count = model
                .series
                .iter()
                .filter(|series| series.indicator.as_ref() == Some(&self.id))
                .count();
            let (mut dependent_ids, mut dependent_ids_memory) = memory
                .try_vec_capacity(dependent_count)
                .map_err(|failure| failure.into_js_error())?;
            let mut dependent_scope = memory.scope();
            for series in &model.series {
                if series.indicator.as_ref() == Some(&self.id) {
                    dependent_ids.push(
                        series
                            .id
                            .try_clone_scoped(&mut dependent_scope)
                            .map_err(|failure| failure.into_js_error())?,
                    );
                }
            }
            let dependent_string_bytes = usize::try_from(dependent_scope.requested_bytes())
                .map_err(|_| memory.allocation_failure().into_js_error())?;
            let dependent_strings = dependent_scope
                .split_persistent(dependent_string_bytes)
                .map_err(|failure| failure.into_js_error())?;
            dependent_ids_memory
                .absorb(dependent_strings)
                .map_err(|failure| failure.into_js_error())?;
            let (candidate, result_memory, checkpoint_entries, checkpoint_memory) = self
                .import
                .as_mut()
                .ok_or_else(|| ordinary_error("Native params validation phase"))?
                .take_ready()?;
            // The import vectors are the same allocation that the replacement candidate will
            // publish. The replacement API owns the candidate lease, so retire the temporary
            // write-candidate lease before staging; this keeps the old+candidate peak exact.
            drop(result_memory);
            self.dependent_ids = dependent_ids;
            self._dependent_ids_memory = dependent_ids_memory;
            self.replacement = Some(engine.stage_native_replacement(
                owner.data().store(),
                &JsValue::String(self.id.clone()),
                candidate,
            )?);
            self.checkpoint_entries = Some(checkpoint_entries);
            self.checkpoint_memory = Some(checkpoint_memory);
        }
        let (receipt, receipt_memory, receipt_build_bytes) = publish_receipt_with_memory(
            &self.layout,
            &self.id,
            self.registration,
            self.noop,
            owner.data().store().memory_context(),
        )?;
        self.receipt = Some(receipt);
        self.receipt_memory = receipt_memory;
        self.receipt_build_bytes = receipt_build_bytes;
        self.phase = SourcePhase::Armed;
        Ok(())
    }

    /// Callback 없는 최종 owner commit으로 entry와 dependent cache metadata를 게시한다.
    #[allow(clippy::too_many_arguments)]
    pub fn publish(
        &mut self,
        owner: &IngestionOwner,
        model: &mut ModelState,
        engine: &mut IndicatorEngine,
        caches: &mut SeriesCaches,
        revision: f64,
    ) -> Result<JsValue, JsError> {
        let (receipt, memory) = self.publish_accounted(owner, model, engine, caches, revision)?;
        let mut scope = MemoryScope::unaccounted(memory.context().oom_style());
        let output = receipt
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        drop((receipt, memory));
        Ok(output)
    }

    /// Prepared receipt와 group을 owner commit 뒤 allocation 없이 함께 이동한다.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_accounted(
        &mut self,
        owner: &IngestionOwner,
        model: &mut ModelState,
        engine: &mut IndicatorEngine,
        caches: &mut SeriesCaches,
        revision: f64,
    ) -> Result<(JsValue, MemoryGroup), JsError> {
        self.check(owner, model, engine, caches, revision)?;
        if self.phase != SourcePhase::Armed {
            return Err(ordinary_error("Native params not armed"));
        }
        if !self.noop {
            let stage = self
                .replacement
                .take()
                .ok_or_else(|| ordinary_error("Native params not armed"))?;
            engine.publish_native_replacement(owner.data().store(), stage)?;
            let checkpoint_entries = self
                .checkpoint_entries
                .take()
                .ok_or_else(|| ordinary_error("Native params not armed"))?;
            let checkpoint_memory = self
                .checkpoint_memory
                .take()
                .ok_or_else(|| ordinary_error("Native params not armed"))?;
            engine.install_checkpoint_entries_with_memory(
                &JsValue::String(self.id.clone()),
                checkpoint_entries,
                None,
                checkpoint_memory,
            )?;
            for id in &self.dependent_ids {
                let series = model
                    .series
                    .iter_mut()
                    .find(|series| &series.id == id)
                    .expect("captured dependent series remains current");
                series.range_index_ready = false;
                series.revision = None;
                series.dirty_from = 0.0;
                caches.remove(id);
            }
        }
        let receipt = self
            .receipt
            .take()
            .ok_or_else(|| ordinary_error("Native params not armed"))?;
        let context = self.receipt_memory.context().clone();
        let receipt_memory =
            std::mem::replace(&mut self.receipt_memory, MemoryGroup::empty(context));
        self.phase = SourcePhase::Closed;
        Ok((receipt, receipt_memory))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImportPhase {
    Receive,
    Validate,
    Ready,
    Closed,
}

struct NativeParamsImport {
    binding: NativeParamsBinding,
    dialect: NumberDialect,
    arrays: Vec<Option<Vec<f64>>>,
    arrays_memory: MemoryGroup,
    received: Vec<usize>,
    checkpoint_map: NativeCheckpointMap,
    expected_checkpoint_bytes: usize,
    checkpoint_count: usize,
    ordinal: usize,
    phase: ImportPhase,
    output: usize,
    at: usize,
    template: Option<NativeIndicatorEntrySnapshot>,
    ready: Option<NativeIndicatorEntrySnapshot>,
    ready_checkpoints: Option<Vec<(usize, JsValue)>>,
    ready_checkpoint_memory: Option<MemoryGroup>,
}

type ReadyParamsImport = (
    NativeIndicatorEntrySnapshot,
    MemoryGroup,
    Vec<(usize, JsValue)>,
    MemoryGroup,
);

impl NativeParamsImport {
    fn new(
        text: &JsString,
        expected: NativeParamsBinding,
        template: NativeIndicatorEntrySnapshot,
        checkpoint_bytes: usize,
        dialect: NumberDialect,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        if text.len_utf16() > PARAMS_METADATA_CHARS {
            return Err(range_error("Native params result metadata limit"));
        }
        let mut parse_scope = MemoryScope::unaccounted(memory.oom_style());
        let value = safe_checkpoint_parse_scoped(
            &JsValue::String(text.clone()),
            dialect,
            &mut parse_scope,
        )?;
        option_record(
            &value,
            &[
                "schema",
                "version",
                "registration",
                "id",
                "name",
                "params",
                "module",
                "outputs",
                "plotOffsets",
                "length",
                "capacity",
                "checkpointCount",
                "checkpointBytes",
                "plan",
            ],
            "Native params result",
        )?;
        if !matches!(property(&value, "schema"), Some(JsValue::String(value)) if text_is(value, "aster.native-params-result"))
            || !matches!(property(&value, "version"), Some(JsValue::Number(1.0)))
        {
            return Err(type_error("Native params result protocol"));
        }
        let binding_matches = matches!(property(&value, "registration"), Some(JsValue::Number(value)) if value.to_bits() == (expected.registration as f64).to_bits())
            && matches!(property(&value, "id"), Some(JsValue::String(value)) if value == &expected.id)
            && matches!(property(&value, "name"), Some(JsValue::String(value)) if value == &expected.name)
            && matches!(property(&value, "length"), Some(JsValue::Number(value)) if value.to_bits() == (expected.length as f64).to_bits())
            && matches!(property(&value, "capacity"), Some(JsValue::Number(value)) if value.to_bits() == (expected.capacity as f64).to_bits());
        if !binding_matches {
            return Err(type_error("Native params result binding"));
        }
        let params = property(&value, "params")
            .cloned()
            .ok_or_else(|| type_error("Native params result parameters"))?;
        crate::indicator_params::validate_indicator_params(&params)?;
        if !exact_state_equal(&params, &expected.params) {
            return Err(type_error("Native params result parameters"));
        }
        validate_indicator_module_binding(&expected.name, property(&value, "module"))?;
        if property(&value, "module").is_some() != expected.module.is_some()
            || property(&value, "module")
                .zip(expected.module.as_ref())
                .is_some_and(|(left, right)| !exact_state_equal(left, right))
        {
            return Err(type_error("Native params result output binding"));
        }
        let outputs = property(&value, "outputs")
            .cloned()
            .ok_or_else(|| type_error("Native params result output binding"))?;
        let offsets = property(&value, "plotOffsets")
            .cloned()
            .ok_or_else(|| type_error("Native params result output binding"))?;
        let expected_outputs = JsValue::Array(
            expected
                .outputs
                .iter()
                .cloned()
                .map(JsValue::String)
                .collect(),
        );
        if !exact_state_equal(&outputs, &expected_outputs)
            || !exact_state_equal(&offsets, &expected.plot_offsets)
        {
            return Err(type_error("Native params result output binding"));
        }
        let checkpoint_count = safe_usize(
            number_field(
                &value,
                "checkpointCount",
                "Native params result checkpoint budget",
            )?,
            RESOURCE_LIMITS.max_bars as usize + 1,
            "Native params result checkpoint budget",
        )?;
        let expected_count = if expected.length == 0 {
            0
        } else {
            expected.length / 256 + 1
        };
        let expected_checkpoint_bytes = safe_usize(
            number_field(
                &value,
                "checkpointBytes",
                "Native params result checkpoint budget",
            )?,
            checkpoint_bytes,
            "Native params result checkpoint budget",
        )?;
        if checkpoint_count != expected_count {
            return Err(range_error("Native params result checkpoint budget"));
        }
        let budget = crate::native_checkpoints::NativeCheckpointBudget::new_with_memory(
            checkpoint_bytes,
            memory.clone(),
        )?;
        let checkpoint_map = NativeCheckpointMap::new(
            template.definition.program,
            template.definition.params.clone(),
            budget,
            256,
        )?;
        let mut arrays = Vec::new();
        arrays
            .try_reserve_exact(expected.outputs.len())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        arrays.resize_with(expected.outputs.len(), || None);
        let mut received = Vec::new();
        received
            .try_reserve_exact(expected.outputs.len())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        received.resize(expected.outputs.len(), 0);
        Ok(Self {
            binding: expected,
            dialect,
            arrays,
            arrays_memory: MemoryGroup::empty(memory),
            received,
            checkpoint_map,
            expected_checkpoint_bytes,
            checkpoint_count,
            ordinal: 0,
            phase: ImportPhase::Receive,
            output: 0,
            at: 0,
            template: Some(template),
            ready: None,
            ready_checkpoints: None,
            ready_checkpoint_memory: None,
        })
    }

    fn check_target(&self, slot: f64, offset: f64, count: f64) -> Result<(), JsError> {
        if self.phase != ImportPhase::Receive
            || !exact_integer(slot, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, PARAMS_CHUNK as f64)
            || slot >= self.arrays.len() as f64
        {
            return Err(range_error("Native params result slice"));
        }
        let slot = slot as usize;
        if offset as usize != self.received[slot] || offset + count > self.binding.capacity as f64 {
            return Err(range_error("Native params result slice"));
        }
        Ok(())
    }

    fn target(&mut self, slot: f64, offset: f64, count: f64) -> Result<&mut [f64], JsError> {
        self.check_target(slot, offset, count)?;
        let slot = slot as usize;
        if self.arrays[slot].is_none() {
            let (values, values_memory) = self
                .arrays_memory
                .context()
                .try_vec_filled(self.binding.capacity, 0.0_f64)
                .map_err(|failure| failure.into_js_error())?;
            self.arrays_memory
                .absorb(values_memory)
                .map_err(|failure| failure.into_js_error())?;
            self.arrays[slot] = Some(values);
        }
        self.received[slot] += count as usize;
        let values = self.arrays[slot].as_mut().expect("params result array");
        Ok(&mut values[offset as usize..(offset + count) as usize])
    }

    fn checkpoint(&mut self, index: f64, text: &JsString) -> Result<(), JsError> {
        if self.phase != ImportPhase::Receive
            || self.ordinal >= self.checkpoint_count
            || index != (self.ordinal * 256) as f64
            || text.len_utf16() * 2 > NATIVE_CHECKPOINT_RECORD_BYTES
        {
            return Err(range_error("Native params result checkpoint record"));
        }
        let mut scope = self.arrays_memory.context().scope();
        let parse_text = text
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let state =
            safe_checkpoint_parse_scoped(&JsValue::String(parse_text), self.dialect, &mut scope)?;
        self.checkpoint_map.set(index, state)?;
        self.ordinal += 1;
        if self.checkpoint_map.encoded_bytes() > self.expected_checkpoint_bytes {
            return Err(range_error("Native params checkpoint declared bytes"));
        }
        Ok(())
    }

    fn start(&mut self) -> Result<(), JsError> {
        if self.phase != ImportPhase::Receive
            || self
                .received
                .iter()
                .any(|received| *received != self.binding.capacity)
            || self.ordinal != self.checkpoint_count
            || self.checkpoint_map.encoded_bytes() != self.expected_checkpoint_bytes
        {
            return Err(ordinary_error("Native params result incomplete"));
        }
        self.phase = ImportPhase::Validate;
        Ok(())
    }

    fn step(&mut self, max_values: f64) -> Result<NativeParamsProgress, JsError> {
        if !exact_integer(max_values, 1.0, PARAMS_CHUNK as f64) {
            return Err(range_error("Native params validation work size"));
        }
        if self.phase == ImportPhase::Ready {
            return Ok(NativeParamsProgress {
                phase: "ready",
                done: 1,
                total: 1,
                complete: true,
            });
        }
        if self.phase == ImportPhase::Closed {
            return Err(ordinary_error("Native params import closed"));
        }
        if self.phase != ImportPhase::Validate {
            return Err(ordinary_error("Native params result not started"));
        }
        let mut remaining = max_values as usize;
        while self.output < self.arrays.len() && remaining > 0 {
            let values = self.arrays[self.output]
                .as_ref()
                .expect("complete params result array");
            let end = std::cmp::min(self.binding.capacity, self.at + remaining);
            while self.at < end {
                let value = values[self.at];
                if self.at >= self.binding.length {
                    if !value.is_nan() {
                        return Err(type_error("Native params result finite/NaN tail"));
                    }
                } else if value.is_infinite() {
                    return Err(type_error("Native params result finite/NaN tail"));
                }
                self.at += 1;
                remaining -= 1;
            }
            if self.at == self.binding.capacity {
                self.at = 0;
                self.output += 1;
            }
        }
        if self.output < self.arrays.len() {
            return Ok(NativeParamsProgress {
                phase: "validate",
                done: self.output * self.binding.capacity + self.at,
                total: self.arrays.len() * self.binding.capacity,
                complete: false,
            });
        }
        let mut ready_arrays = Vec::new();
        ready_arrays
            .try_reserve_exact(self.arrays.len())
            .map_err(|_| {
                self.arrays_memory
                    .context()
                    .allocation_failure()
                    .into_js_error()
            })?;
        // Publish the sorted checkpoint payload before consuming the template/arrays. If this
        // fallible conversion is denied, the import remains fully receive/validate-owned and the
        // old engine entry is untouched.
        let (checkpoints, checkpoint_memory) = self.checkpoint_map.publish_entries_accounted()?;
        let mut template = self
            .template
            .take()
            .ok_or_else(|| ordinary_error("Native params import definition changed"))?;
        for values in &mut self.arrays {
            ready_arrays.push(values.take().expect("validated params result array"));
        }
        template.arrays = ready_arrays;
        template.checkpoints.clear();
        template.revision = if self.binding.length == 0 { 0.0 } else { 1.0 };
        template.dirty = self.binding.length;
        template.dirty_to = Some(0);
        template.invalidated = false;
        template.length = self.binding.length;
        template.computed_from = Some(0);
        template.computed_until = Some(self.binding.length);
        template.prepared_version = None;
        self.ready = Some(template);
        self.ready_checkpoints = Some(checkpoints);
        self.ready_checkpoint_memory = Some(checkpoint_memory);
        self.phase = ImportPhase::Ready;
        Ok(NativeParamsProgress {
            phase: "ready",
            done: 1,
            total: 1,
            complete: true,
        })
    }

    fn take_ready(&mut self) -> Result<ReadyParamsImport, JsError> {
        if self.phase != ImportPhase::Ready {
            return Err(ordinary_error("Native params result not ready"));
        }
        self.phase = ImportPhase::Closed;
        let template = self
            .ready
            .take()
            .ok_or_else(|| ordinary_error("Native params result not ready"))?;
        let checkpoints = self
            .ready_checkpoints
            .take()
            .ok_or_else(|| ordinary_error("Native params result not ready"))?;
        let checkpoint_memory = self
            .ready_checkpoint_memory
            .take()
            .ok_or_else(|| ordinary_error("Native params result not ready"))?;
        let context = self.arrays_memory.context().clone();
        let result_memory = std::mem::replace(&mut self.arrays_memory, MemoryGroup::empty(context));
        Ok((template, result_memory, checkpoints, checkpoint_memory))
    }
}
