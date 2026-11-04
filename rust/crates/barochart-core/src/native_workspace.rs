//! Native workspace source/target가 공유하는 bounded metadata와 logical plan이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::checkpoint_codec::safe_checkpoint_parse_scoped;
use crate::contracts::{RESOURCE_LIMITS, option_record};
use crate::native_checkpoints::NATIVE_CHECKPOINT_TOTAL_BYTES;
use crate::workspace::{
    ValidatedWorkspace, js_string_heap_bytes, js_value_heap_bytes,
    read_workspace_document_with_memory, workspace_binding_same, workspace_binding_scoped,
};

/// JS restore protocol의 최대 combined logical reservation이다.
pub const NATIVE_WORKSPACE_RESTORE_BYTES: usize = 805_306_368;
/// Target indicator output vector의 최대 logical bytes다.
pub const NATIVE_WORKSPACE_OUTPUT_BYTES: usize = 268_435_456;
/// 한 source/target column 호출이 옮기는 최대 f64 개수다.
pub const NATIVE_WORKSPACE_SLICE: usize = 262_144;

/// Restore가 보존하는 canvas 크기다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NativeWorkspaceSize {
    pub width: f64,
    pub height: f64,
}

/// Source admission과 target create가 공유하는 logical allocation plan이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeWorkspacePlan {
    pub retained_bytes: usize,
    pub source_bytes: usize,
    pub output_bytes: usize,
    pub range_bytes: usize,
    pub checkpoint_bytes: usize,
    pub record_metadata_bytes: usize,
    pub scratch_bytes: usize,
    pub document_bytes: usize,
    pub transfer_bytes: usize,
    pub ingestion_bytes: usize,
    pub total_bytes: usize,
    pub max_bytes: usize,
    pub capacity: usize,
    pub outputs: usize,
}

impl NativeWorkspacePlan {
    /// Host가 검사하는 source key order의 plan record다.
    pub fn to_value(&self) -> JsValue {
        object([
            ("retainedBytes", number(self.retained_bytes)),
            ("sourceBytes", number(self.source_bytes)),
            ("outputBytes", number(self.output_bytes)),
            ("rangeBytes", number(self.range_bytes)),
            ("checkpointBytes", number(self.checkpoint_bytes)),
            ("recordMetadataBytes", number(self.record_metadata_bytes)),
            ("scratchBytes", number(self.scratch_bytes)),
            ("documentBytes", number(self.document_bytes)),
            ("transferBytes", number(self.transfer_bytes)),
            ("ingestionBytes", number(self.ingestion_bytes)),
            ("totalBytes", number(self.total_bytes)),
            ("maxBytes", number(self.max_bytes)),
            ("capacity", number(self.capacity)),
            ("outputs", number(self.outputs)),
        ])
    }
}

/// 검증된 target metadata다. 문서와 binding은 target runtime이 소유한다.
pub(crate) struct NativeWorkspaceSpec {
    pub document: ValidatedWorkspace,
    pub binding: JsValue,
    pub length: usize,
    pub max_bars: usize,
    pub timeframe_ms: f64,
    pub time_origin: f64,
    pub version: f64,
    pub time_version: f64,
    pub size: NativeWorkspaceSize,
    pub ingestion: Option<JsString>,
    pub plan: NativeWorkspacePlan,
    pub _metadata_memory: MemoryGroup,
}

/// Metadata를 target과 같은 순서로 검증하고 admission plan을 계산한다.
pub fn native_workspace_target_plan(
    text: &JsString,
    host: &dyn Host,
    dialect: NumberDialect,
) -> Result<NativeWorkspacePlan, JsError> {
    Ok(native_workspace_target_spec(text, host, dialect)?.plan)
}

pub(crate) fn native_workspace_target_spec(
    text: &JsString,
    host: &dyn Host,
    dialect: NumberDialect,
) -> Result<NativeWorkspaceSpec, JsError> {
    native_workspace_target_spec_with_memory(
        text,
        host,
        dialect,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

/// Metadata JSON의 parser/value 수명을 explicit account에 묶어 target spec을 만든다.
pub(crate) fn native_workspace_target_spec_with_memory(
    text: &JsString,
    host: &dyn Host,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<NativeWorkspaceSpec, JsError> {
    if text.len_utf16() > 8_388_608 {
        return Err(range_error("Native workspace target metadata"));
    }
    let mut scope = memory.scope();
    let parse_text = text
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let metadata = safe_checkpoint_parse_scoped(&JsValue::String(parse_text), dialect, &mut scope)?;
    option_record(
        &metadata,
        &[
            "schema",
            "version",
            "document",
            "datasetBinding",
            "source",
            "size",
            "retainedBytes",
            "maxBytes",
            "dataIngestion",
        ],
        "Native workspace target",
    )?;
    let metadata_record = record(&metadata, "Native workspace target: object required")?;
    if !matches!(get(metadata_record, "schema"), Some(JsValue::String(value)) if text_eq(value, "aster.native-workspace-target"))
        || !matches!(get(metadata_record, "version"), Some(JsValue::Number(1.0)))
    {
        return Err(type_error("Native workspace target protocol"));
    }

    let document_text = match required(metadata_record, "document")? {
        JsValue::String(value) => value
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        _ => return Err(type_error("Workspace text required")),
    };
    let document = read_workspace_document_with_memory(
        &JsValue::String(document_text),
        host,
        dialect,
        memory,
    )?;
    let binding = workspace_binding_scoped(
        required(metadata_record, "datasetBinding")?,
        dialect,
        &mut scope,
    )?;
    let document_record = record(document.value(), "Workspace: object required")?;
    if !workspace_binding_same(required(document_record, "dataset")?, &binding) {
        return Err(type_error("Native workspace target dataset binding"));
    }

    let source = required(metadata_record, "source")?;
    option_record(
        source,
        &[
            "length",
            "maxBars",
            "timeframeMs",
            "timeOrigin",
            "version",
            "timeVersion",
        ],
        "Native workspace target source",
    )?;
    let source = record(source, "Native workspace target source: object required")?;
    let length = integer(
        required(source, "length")?,
        0,
        RESOURCE_LIMITS.max_bars as usize,
        "Native workspace source length",
    )?;
    let max_bars = integer(
        required(source, "maxBars")?,
        0,
        RESOURCE_LIMITS.max_bars as usize,
        "Native workspace source max bars",
    )?;
    let timeframe_ms = finite(required(source, "timeframeMs")?)?;
    let time_origin = finite(required(source, "timeOrigin")?)?;
    let document_source = record(
        required(document_record, "source")?,
        "Workspace: object required",
    )?;
    let document_length = integer(
        required(document_source, "length")?,
        0,
        RESOURCE_LIMITS.max_bars as usize,
        "Native workspace source length",
    )?;
    if length > max_bars
        || document_length != length
        || timeframe_ms <= 0.0
        || !time_origin.is_finite()
    {
        return Err(range_error("Native workspace target source settings"));
    }
    let version = integer_number(
        required(source, "version")?,
        0.0,
        9_007_199_254_740_990.0,
        "Native workspace source version",
    )?;
    let time_version = integer_number(
        required(source, "timeVersion")?,
        0.0,
        9_007_199_254_740_990.0,
        "Native workspace source time version",
    )?;

    let size = required(metadata_record, "size")?;
    option_record(size, &["width", "height"], "Native workspace target size")?;
    let size = record(size, "Native workspace target size: object required")?;
    let width = finite(required(size, "width")?)?;
    let height = finite(required(size, "height")?)?;
    if !(1.0..=RESOURCE_LIMITS.max_canvas_dimension as f64).contains(&width)
        || !(1.0..=RESOURCE_LIMITS.max_canvas_dimension as f64).contains(&height)
    {
        return Err(range_error("Native workspace target size"));
    }
    if width * height > RESOURCE_LIMITS.max_canvas_pixels as f64 {
        return Err(range_error("Native workspace target pixel limit"));
    }

    let max_bytes = integer(
        required(metadata_record, "maxBytes")?,
        1,
        NATIVE_WORKSPACE_RESTORE_BYTES,
        "Native workspace combined byte limit",
    )?;
    let retained_bytes = integer(
        required(metadata_record, "retainedBytes")?,
        0,
        max_bytes,
        "Native workspace retained source bytes",
    )?;
    let capacity = capacity_for(length);
    let indicators = array(
        required(document_record, "indicators")?,
        "Workspace indicators array",
    )?;
    let outputs = indicators.iter().try_fold(0usize, |sum, indicator| {
        let indicator = record(indicator, "Workspace: object required")?;
        let count = array(required(indicator, "outputs")?, "Indicator outputs array")?.len();
        sum.checked_add(count)
            .ok_or_else(|| range_error("Native workspace target output byte limit"))
    })?;
    let output_bytes = outputs
        .checked_mul(capacity)
        .and_then(|value| value.checked_mul(8))
        .ok_or_else(|| range_error("Native workspace target output byte limit"))?;
    if output_bytes > NATIVE_WORKSPACE_OUTPUT_BYTES {
        return Err(range_error("Native workspace target output byte limit"));
    }

    let validated_ingestion = get(metadata_record, "dataIngestion")
        .map(|text| {
            crate::ingestion::IngestionOwner::validate_workspace_restore_document(
                crate::ingestion::IngestionStoreShape {
                    length,
                    capacity,
                    max_bars,
                    version,
                },
                text,
                dialect,
            )
        })
        .transpose()?;
    let ingestion_bytes = validated_ingestion
        .as_ref()
        .map_or(0, |value| value.capacity * 49 * 3);
    let ingestion = validated_ingestion.map(|value| value.text);
    let series = array(
        required(document_record, "series")?,
        "Workspace series array",
    )?;
    let indexed_series = series.iter().try_fold(0usize, |count, value| {
        let value = record(value, "Workspace: object required")?;
        let indexed = !matches!(get(value, "type"), Some(JsValue::String(kind)) if text_eq(kind, "candles") || text_eq(kind, "ohlc"));
        Ok::<usize, JsError>(count + usize::from(indexed))
    })?;
    let index_capacity = if length >= 65_536 {
        usize::max(1, capacity / 32)
    } else {
        capacity
    };
    let source_bytes = capacity * 96;
    let range_bytes = indexed_series * index_capacity * 48;
    let checkpoint_records = if length == 0 { 0 } else { length / 256 + 1 } * indicators.len();
    let record_metadata_bytes = checkpoint_records * 128;
    let scratch_bytes = 33_554_432;
    let document_bytes = 33_554_432;
    let transfer_bytes = 4_194_304;
    let total_bytes = retained_bytes
        .checked_add(source_bytes)
        .and_then(|value| value.checked_add(output_bytes))
        .and_then(|value| value.checked_add(range_bytes))
        .and_then(|value| value.checked_add(NATIVE_CHECKPOINT_TOTAL_BYTES))
        .and_then(|value| value.checked_add(record_metadata_bytes))
        .and_then(|value| value.checked_add(scratch_bytes))
        .and_then(|value| value.checked_add(document_bytes))
        .and_then(|value| value.checked_add(transfer_bytes))
        .and_then(|value| value.checked_add(ingestion_bytes))
        .ok_or_else(|| range_error("Native workspace combined logical byte limit"))?;
    if total_bytes > max_bytes {
        return Err(range_error("Native workspace combined logical byte limit"));
    }
    let plan = NativeWorkspacePlan {
        retained_bytes,
        source_bytes,
        output_bytes,
        range_bytes,
        checkpoint_bytes: NATIVE_CHECKPOINT_TOTAL_BYTES,
        record_metadata_bytes,
        scratch_bytes,
        document_bytes,
        transfer_bytes,
        ingestion_bytes,
        total_bytes,
        max_bytes,
        capacity,
        outputs,
    };
    let mut retained_scope = memory.scope();
    let binding = binding
        .try_clone_scoped(&mut retained_scope)
        .map_err(|failure| failure.into_js_error())?;
    let ingestion = ingestion
        .as_ref()
        .map(|value| {
            value
                .try_clone_scoped(&mut retained_scope)
                .map_err(|failure| failure.into_js_error())
        })
        .transpose()?;
    let metadata_bytes = js_value_heap_bytes(&binding)
        .saturating_add(ingestion.as_ref().map_or(0, js_string_heap_bytes));
    let metadata_memory = retained_scope
        .split_persistent(metadata_bytes)
        .map_err(|failure| failure.into_js_error())?;
    drop((metadata, scope));
    Ok(NativeWorkspaceSpec {
        document,
        binding,
        length,
        max_bars,
        timeframe_ms,
        time_origin,
        version,
        time_version,
        size: NativeWorkspaceSize { width, height },
        ingestion,
        plan,
        _metadata_memory: metadata_memory,
    })
}

pub(crate) fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, child) in fields {
        value.insert(JsString::from_str(name), child);
    }
    JsValue::Object(value)
}

pub(crate) fn number(value: usize) -> JsValue {
    JsValue::Number(value as f64)
}

pub(crate) fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

pub(crate) fn record<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

pub(crate) fn get<'a>(record: &'a JsObject, name: &str) -> Option<&'a JsValue> {
    record.get(&JsString::from_str(name))
}

pub(crate) fn required<'a>(record: &'a JsObject, name: &str) -> Result<&'a JsValue, JsError> {
    get(record, name).ok_or_else(|| type_error(&format!("Native workspace target: missing {name}")))
}

pub(crate) fn array<'a>(value: &'a JsValue, message: &str) -> Result<&'a [JsValue], JsError> {
    match value {
        JsValue::Array(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

pub(crate) fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn finite(value: &JsValue) -> Result<f64, JsError> {
    match value {
        JsValue::Number(value) if value.is_finite() => Ok(*value),
        _ => Err(range_error("Native workspace target source settings")),
    }
}

fn integer(value: &JsValue, minimum: usize, maximum: usize, label: &str) -> Result<usize, JsError> {
    match value {
        JsValue::Number(value)
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= minimum as f64
                && *value <= maximum as f64 =>
        {
            Ok(*value as usize)
        }
        _ => Err(range_error(label)),
    }
}

fn integer_number(
    value: &JsValue,
    minimum: f64,
    maximum: f64,
    label: &str,
) -> Result<f64, JsError> {
    match value {
        JsValue::Number(value)
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= minimum
                && *value <= maximum =>
        {
            Ok(*value)
        }
        _ => Err(range_error(label)),
    }
}

fn capacity_for(length: usize) -> usize {
    let mut capacity = 16;
    while capacity < length {
        capacity *= 2;
    }
    capacity
}

pub(crate) fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

pub(crate) fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

pub(crate) fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}
