//! 네이티브 prepare/correction 작업의 순수 source/target 상태기계다.
//!
//! Engine의 ticket, source/target busy slot, ingestion lease와 최종 chart publication은 Root가
//! 소유한다. 이 모듈은 전달 payload와 source fingerprint를 소유하며 unsafe/self-reference를
//! 사용하지 않는다.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::mem::size_of;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::JsString;

use crate::Host;
use crate::batch_options::BatchOptions;
use crate::block_range::BlockRangeIndex;
use crate::checkpoint_codec::{
    safe_checkpoint_parse_scoped, safe_checkpoint_parse_with, safe_checkpoint_stringify_scoped,
    safe_checkpoint_stringify_with,
};
use crate::contracts::{AXIS_KEYS, PANEL_KEYS, RESOURCE_LIMITS, SERIES_KEYS, ordered_record};
use crate::data::{
    Bar, Columns, DataEvent, DataIdentity, ModelDataState, StoreOptions, validate_bar,
};
use crate::indicator_engine::{
    CalculationStep, IndicatorCalculation, IndicatorEngine, IndicatorEngineOptions,
    NativeIndicatorEntrySnapshot,
};
use crate::indicator_helpers::exact_state_equal;
use crate::indicator_modules::{pressure_descriptor_value, validate_indicator_module_binding};
use crate::indicator_types::IndicatorProvenance;
use crate::ingestion::IngestionOwner;
use crate::model_state::{ModelState, Series};
use crate::native_checkpoints::{
    NATIVE_CHECKPOINT_TOTAL_BYTES, NativeCheckpointBudget, NativeCheckpointMap,
};
use crate::range_index::{RangeIndexBufferView, RangeIndexBuilder};
use crate::series_cache::{NativePrebuiltSeriesCache, SeriesCacheBufferView, SeriesCaches};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const ASYNC_SNAPSHOT_BYTES: usize = 536_870_912;
const ASYNC_BUFFER_SLICE: usize = 262_144;
const ASYNC_MAX_BUFFERS: usize = 1_024;
const ASYNC_MAX_INDICATORS: usize = 128;
const ASYNC_MAX_SERIES: usize = 256;

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

fn buffer_ref(slot: usize) -> JsValue {
    object([("buffer", JsValue::Number(slot as f64))])
}

fn optional_field(record: &mut JsObject, name: &str, value: Option<JsValue>) {
    if let Some(value) = value {
        record.insert(key(name), value);
    }
}

/// Host-visible buffer slot/length row다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeBufferDescriptor {
    /// transfer slot이다.
    pub slot: usize,
    /// f64 원소 수다.
    pub length: usize,
}

/// Host-visible checkpoint entry descriptor다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeCheckpointDescriptor {
    /// indicator insertion-order entry다.
    pub entry: usize,
    /// checkpoint record 수다.
    pub total: usize,
    /// 한 호출의 최대 record 수다.
    pub max_rows: usize,
}

/// bounded target step 영수증이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeJobProgress {
    /// JS phase 문자열이다.
    pub phase: &'static str,
    /// phase 안에서 끝낸 단위다.
    pub done: usize,
    /// phase 전체 단위다.
    pub total: usize,
    /// ready terminal 여부다.
    pub complete: bool,
}

impl NativeJobProgress {
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

#[derive(Clone)]
struct CheckpointTransfer {
    id: JsString,
    keys: Vec<usize>,
    max_rows: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EntryFingerprint {
    id: JsString,
    name: JsString,
    definition: usize,
    params: JsValueFingerprint,
    revision_bits: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JsValueFingerprint(Vec<u8>);

impl JsValueFingerprint {
    fn capture(value: &JsValue, dialect: NumberDialect) -> Result<Self, JsError> {
        Ok(Self(
            safe_checkpoint_stringify_with(value, dialect)?
                .as_units()
                .iter()
                .flat_map(|unit| unit.to_le_bytes())
                .collect(),
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SeriesFingerprint {
    binding: JsValueFingerprint,
    values: Option<(usize, usize)>,
}

struct NativeSourceFingerprint {
    data: DataIdentity,
    version_bits: u64,
    entries: Vec<EntryFingerprint>,
    registry_names: Vec<&'static str>,
    series: Vec<SeriesFingerprint>,
    series_values_revision_bits: Option<u64>,
}

impl NativeSourceFingerprint {
    fn capture(
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        _caches: &SeriesCaches,
        dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        let store = owner.data().store();
        let entries = engine
            .entry_ids()
            .into_iter()
            .map(|id| {
                let entry = engine
                    .entry(&JsValue::String(id.clone()))
                    .expect("entry id snapshot is current");
                EntryFingerprint {
                    id,
                    name: entry.name().clone(),
                    definition: entry.definition() as *const _ as usize,
                    params: JsValueFingerprint::capture(entry.params(), dialect)
                        .expect("validated params stringify"),
                    revision_bits: entry.revision().to_bits(),
                }
            })
            .collect();
        let series = model
            .series
            .iter()
            .map(|series| {
                Ok(SeriesFingerprint {
                    binding: JsValueFingerprint::capture(&series_binding(series), dialect)?,
                    values: series
                        .values
                        .as_ref()
                        .map(|values| (values.as_ptr() as usize, values.len())),
                })
            })
            .collect::<Result<Vec<_>, JsError>>()?;
        Ok(Self {
            data: store.data_identity(),
            version_bits: store.version().to_bits(),
            entries,
            registry_names: engine.registry_names(),
            series,
            series_values_revision_bits: model.series_values_revision().map(f64::to_bits),
        })
    }

    fn matches(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        _caches: &SeriesCaches,
        dialect: NumberDialect,
    ) -> bool {
        let store = owner.data().store();
        if !self.data.matches(&store.data_identity())
            || self.version_bits != store.version().to_bits()
            || self.registry_names != engine.registry_names()
            || self.series_values_revision_bits != model.series_values_revision().map(f64::to_bits)
        {
            return false;
        }
        if self.entries.len() != engine.len() {
            return false;
        }
        for expected in &self.entries {
            let Some(entry) = engine.entry(&JsValue::String(expected.id.clone())) else {
                return false;
            };
            let actual = EntryFingerprint {
                id: expected.id.clone(),
                name: entry.name().clone(),
                definition: entry.definition() as *const _ as usize,
                params: match JsValueFingerprint::capture(entry.params(), dialect) {
                    Ok(params) => params,
                    Err(_) => return false,
                },
                revision_bits: entry.revision().to_bits(),
            };
            if &actual != expected {
                return false;
            }
        }
        if self.series.len() != model.series.len() {
            return false;
        }
        self.series
            .iter()
            .zip(&model.series)
            .all(|(expected, series)| {
                JsValueFingerprint::capture(&series_binding(series), dialect)
                    .is_ok_and(|value| value == expected.binding)
                    && expected.values
                        == series
                            .values
                            .as_ref()
                            .map(|values| (values.as_ptr() as usize, values.len()))
            })
    }
}

fn series_binding(series: &Series) -> JsValue {
    let raw = series.raw_record();
    let mut binding = JsObject::new();
    for name in ["id", "type", "source", "indicator", "output"] {
        binding.insert(
            key(name),
            property(&raw, name).cloned().unwrap_or(JsValue::Null),
        );
    }
    JsValue::Object(binding)
}

#[derive(Clone, Copy)]
enum TreePart {
    Min,
    Max,
    Sum,
}

enum BufferSlot {
    IndicatorOutput { id: JsString, output: &'static str },
    ExternalSeries { id: JsString },
    SeriesCache { id: JsString, part: TreePart },
    StoreColumn { name: &'static str },
    StoreIndex { part: TreePart },
}

impl BufferSlot {
    fn resolve<'a>(
        &self,
        owner: &'a IngestionOwner,
        model: &'a ModelState,
        engine: &'a IndicatorEngine,
        caches: &'a SeriesCaches,
    ) -> Option<&'a [f64]> {
        match self {
            Self::IndicatorOutput { id, output } => engine
                .entry(&JsValue::String(id.clone()))
                .and_then(|entry| entry.output_capacity(output)),
            Self::ExternalSeries { id } => model
                .series
                .iter()
                .find(|series| &series.id == id)
                .and_then(|series| series.values.as_deref()),
            Self::SeriesCache { id, part } => {
                let tree = match caches.buffer_view(id)? {
                    SeriesCacheBufferView::Flat { tree }
                    | SeriesCacheBufferView::Block { tree, .. } => tree,
                };
                tree_part(tree, *part)
            }
            Self::StoreColumn { name } => {
                let columns = owner.data().store().columns();
                Some(match *name {
                    "time" => &columns.time,
                    "open" => &columns.open,
                    "high" => &columns.high,
                    "low" => &columns.low,
                    "close" => &columns.close,
                    "volume" => &columns.volume,
                    _ => return None,
                })
            }
            Self::StoreIndex { part } => {
                tree_part(owner.data().store().index().buffer_view(), *part)
            }
        }
    }
}

fn tree_part(view: RangeIndexBufferView<'_>, part: TreePart) -> Option<&[f64]> {
    match part {
        TreePart::Min => Some(view.min),
        TreePart::Max => Some(view.max),
        TreePart::Sum => view.sum,
    }
}

struct SlotCollector {
    slots: Vec<BufferSlot>,
    lengths: Vec<usize>,
    views: HashMap<(usize, usize), usize>,
    bytes: usize,
}

impl SlotCollector {
    fn new() -> Self {
        Self {
            slots: Vec::new(),
            lengths: Vec::new(),
            views: HashMap::new(),
            bytes: 0,
        }
    }

    fn put_slice(&mut self, values: &[f64], source: BufferSlot) -> Result<JsValue, JsError> {
        let identity = (values.as_ptr() as usize, values.len());
        if let Some(slot) = self.views.get(&identity) {
            return Ok(buffer_ref(*slot));
        }
        self.bytes = self
            .bytes
            .checked_add(values.len().saturating_mul(8))
            .ok_or_else(|| range_error("Async snapshot byte limit"))?;
        if self.bytes > ASYNC_SNAPSHOT_BYTES || self.slots.len() >= ASYNC_MAX_BUFFERS {
            return Err(range_error("Async snapshot byte limit"));
        }
        let slot = self.slots.len();
        self.slots.push(source);
        self.lengths.push(values.len());
        self.views.insert(identity, slot);
        Ok(buffer_ref(slot))
    }

    fn put_tree(
        &mut self,
        tree: RangeIndexBufferView<'_>,
        source: impl Fn(TreePart) -> BufferSlot,
    ) -> Result<JsValue, JsError> {
        let min = self.put_slice(tree.min, source(TreePart::Min))?;
        let max = self.put_slice(tree.max, source(TreePart::Max))?;
        let sum = tree
            .sum
            .map(|values| self.put_slice(values, source(TreePart::Sum)))
            .transpose()?;
        Ok(object([
            ("size", JsValue::Number(tree.size as f64)),
            ("min", min),
            ("max", max),
            ("sum", sum.unwrap_or(JsValue::Null)),
            ("finiteCounts", JsValue::Bool(tree.finite_counts)),
        ]))
    }
}

fn params_large(value: &JsValue) -> bool {
    [
        "period",
        "fast",
        "slow",
        "signal",
        "smoothK",
        "smoothD",
        "stochPeriod",
        "atrPeriod",
        "conversion",
        "base",
        "span",
    ]
    .iter()
    .any(|name| matches!(property(value, name), Some(JsValue::Number(value)) if *value > 100.0))
}

fn bar_from_event(event: &JsValue, data: &ModelDataState) -> Result<Bar, JsError> {
    let Some(JsValue::String(kind)) = property(event, "kind") else {
        return Err(type_error("Async data event kind"));
    };
    if !text_is(kind, "correction") {
        return Err(type_error("Async data event kind"));
    }
    let Some(JsValue::Object(value)) = property(event, "bar") else {
        return Err(type_error("Every OHLCV field must be finite"));
    };
    let number = |name: &str| match value.get(&key(name)) {
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    };
    let bar = Bar {
        time: number("time"),
        open: number("open"),
        high: number("high"),
        low: number("low"),
        close: number("close"),
        volume: number("volume"),
    };
    validate_bar(&bar, f64::NEG_INFINITY)?;
    let store = data.store();
    let index = store.lower_bound(bar.time);
    if index >= store.length() || store.columns().time[index] != bar.time {
        return Err(range_error("Correction time"));
    }
    Ok(bar)
}

fn series_metadata(
    model: &ModelState,
    caches: &SeriesCaches,
    buffers: &mut SlotCollector,
) -> Result<Vec<JsValue>, JsError> {
    model
        .series
        .iter()
        .map(|series| {
            let options = ordered_record(&series.raw_record(), SERIES_KEYS)?;
            let mut options = match &options {
                JsValue::Object(value) => value.clone(),
                _ => unreachable!("ordered series record"),
            };
            if let Some(values) = series.values.as_deref() {
                options.insert(
                    key("values"),
                    buffers.put_slice(
                        values,
                        BufferSlot::ExternalSeries {
                            id: series.id.clone(),
                        },
                    )?,
                );
            }
            let mut row = JsObject::new();
            row.insert(key("options"), JsValue::Object(options));
            optional_field(&mut row, "revision", series.revision.map(JsValue::Number));
            row.insert(key("dirtyFrom"), JsValue::Number(series.dirty_from));
            let index = if series.range_index_ready {
                caches.buffer_view(&series.id)
            } else {
                None
            };
            let index = match index {
                None => JsValue::Null,
                Some(view) => match view {
                    SeriesCacheBufferView::Flat { tree } => {
                        let id = series.id.clone();
                        let tree = buffers.put_tree(tree, |part| BufferSlot::SeriesCache {
                            id: id.clone(),
                            part,
                        })?;
                        object([
                            ("blocked", JsValue::Bool(false)),
                            ("finiteCounts", JsValue::Bool(true)),
                            ("tree", tree),
                        ])
                    }
                    SeriesCacheBufferView::Block {
                        size,
                        length,
                        block_size,
                        tree,
                    } => {
                        let id = series.id.clone();
                        let tree = buffers.put_tree(tree, |part| BufferSlot::SeriesCache {
                            id: id.clone(),
                            part,
                        })?;
                        object([
                            ("blocked", JsValue::Bool(true)),
                            ("finiteCounts", JsValue::Bool(true)),
                            ("size", JsValue::Number(size as f64)),
                            ("length", JsValue::Number(length as f64)),
                            ("blockSize", JsValue::Number(block_size as f64)),
                            ("tree", tree),
                        ])
                    }
                },
            };
            row.insert(key("index"), index);
            Ok(JsValue::Object(row))
        })
        .collect()
}

fn checkpoint_keys_with_memory(
    entry: crate::indicator_engine::IndicatorEntryView<'_>,
    memory: &MemoryContext,
) -> Result<(Vec<usize>, MemoryGroup), JsError> {
    let (mut keys, group) = memory
        .try_vec_capacity(entry.checkpoint_len())
        .map_err(|failure| failure.into_js_error())?;
    let mut after = None;
    while let Some((index, _)) = entry.checkpoint_next(after) {
        keys.push(index);
        after = Some(index);
    }
    Ok((keys, group))
}

/// 실제 correction source snapshot이다. Ticket/busy/lease는 포함하지 않는다.
pub struct NativeCorrectionSource {
    metadata: JsValue,
    metadata_json: JsString,
    slots: Vec<BufferSlot>,
    lengths: Vec<usize>,
    checkpoints: Vec<CheckpointTransfer>,
    memory: MemoryGroup,
    fingerprint: NativeSourceFingerprint,
    dialect: NumberDialect,
    closed: bool,
}

impl NativeCorrectionSource {
    /// correction event와 현재 실제 owner/model/engine/cache를 원자 snapshot한다.
    pub fn capture(
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        event: &JsValue,
        dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        if engine.len() > ASYNC_MAX_INDICATORS || model.series.len() > ASYNC_MAX_SERIES {
            return Err(type_error("Async protocol"));
        }
        let event_text = safe_checkpoint_stringify_with(event, dialect)?;
        let event = safe_checkpoint_parse_with(&JsValue::String(event_text), dialect)?;
        bar_from_event(&event, owner.data())?;
        // Source-side indicator payload capture is deliberately fallible and tied to the
        // authoritative store context. The host still receives borrowed buffer views below, so
        // this temporary clone is retired before the source is returned.
        let (_, _, capture_memory) = engine.capture_native_entries_with_memory(
            owner.data().store(),
            owner.data().store().memory_context(),
        )?;
        drop(capture_memory);
        let fingerprint = NativeSourceFingerprint::capture(owner, model, engine, caches, dialect)?;
        let store = owner.data().store();
        let source_context = store.memory_context().clone();
        let mut source_memory = MemoryGroup::empty(source_context.clone());
        let mut collector = SlotCollector::new();
        let mut checkpoints = Vec::with_capacity(engine.len());
        let mut indicator_rows = Vec::with_capacity(engine.len());
        for (entry_index, id) in engine.entry_ids().into_iter().enumerate() {
            let entry = engine
                .entry(&JsValue::String(id.clone()))
                .expect("entry id snapshot is current");
            let definition = entry.definition();
            let arrays = definition
                .outputs
                .iter()
                .filter_map(|output| {
                    entry
                        .output_capacity(output)
                        .map(|values| (*output, values))
                })
                .map(|(output, values)| {
                    collector.put_slice(
                        values,
                        BufferSlot::IndicatorOutput {
                            id: id.clone(),
                            output,
                        },
                    )
                })
                .collect::<Result<Vec<_>, JsError>>()?;
            let (keys, keys_memory) = checkpoint_keys_with_memory(entry, &source_context)?;
            source_memory
                .absorb(keys_memory)
                .map_err(|failure| failure.into_js_error())?;
            let max_rows = if matches!(definition.provenance, IndicatorProvenance::Linked(_))
                || params_large(entry.params())
            {
                1
            } else {
                64
            };
            checkpoints.push(CheckpointTransfer {
                id: id.clone(),
                keys,
                max_rows,
            });
            let mut row = JsObject::new();
            row.insert(key("id"), JsValue::String(id));
            row.insert(key("name"), JsValue::String(entry.name().clone()));
            row.insert(key("params"), entry.params().clone());
            if matches!(definition.provenance, IndicatorProvenance::Linked(_)) {
                row.insert(key("module"), pressure_descriptor_value());
            }
            row.insert(
                key("outputs"),
                JsValue::Array(
                    definition
                        .outputs
                        .iter()
                        .map(|output| text(output))
                        .collect(),
                ),
            );
            let mut offsets = JsObject::new();
            for offset in &definition.plot_offsets {
                offsets.insert(key(offset.output), JsValue::Number(offset.value));
            }
            row.insert(key("plotOffsets"), JsValue::Object(offsets));
            row.insert(key("arrays"), JsValue::Array(arrays));
            row.insert(
                key("checkpointCount"),
                JsValue::Number(checkpoints[entry_index].keys.len() as f64),
            );
            row.insert(
                key("checkpointSize"),
                JsValue::Number(engine.checkpoint_size() as f64),
            );
            row.insert(key("revision"), JsValue::Number(entry.revision()));
            row.insert(key("dirty"), JsValue::Number(entry.dirty() as f64));
            row.insert(
                key("dirtyTo"),
                JsValue::Number(entry.dirty_to().unwrap_or(store.length()) as f64),
            );
            row.insert(key("invalidated"), JsValue::Bool(entry.invalidated()));
            row.insert(key("length"), JsValue::Number(entry.length() as f64));
            row.insert(
                key("computedFrom"),
                JsValue::Number(entry.computed_from().unwrap_or(0) as f64),
            );
            row.insert(
                key("computedUntil"),
                JsValue::Number(entry.computed_until().unwrap_or(store.length()) as f64),
            );
            row.insert(key("entry"), JsValue::Number(entry_index as f64));
            indicator_rows.push(JsValue::Object(row));
        }
        let series = series_metadata(model, caches, &mut collector)?;
        let columns = store.columns();
        let mut column_refs = JsObject::new();
        for (name, values) in [
            ("time", columns.time.as_slice()),
            ("open", columns.open.as_slice()),
            ("high", columns.high.as_slice()),
            ("low", columns.low.as_slice()),
            ("close", columns.close.as_slice()),
            ("volume", columns.volume.as_slice()),
        ] {
            column_refs.insert(
                key(name),
                collector.put_slice(values, BufferSlot::StoreColumn { name })?,
            );
        }
        let index = collector.put_tree(store.index().buffer_view(), |part| {
            BufferSlot::StoreIndex { part }
        })?;
        let store_options = store.store_options();
        let store_metadata = object([
            ("length", JsValue::Number(store.length() as f64)),
            ("capacity", JsValue::Number(store.capacity() as f64)),
            ("maxBars", JsValue::Number(store.max_bars() as f64)),
            ("timeframeMs", JsValue::Number(store_options.timeframe_ms)),
            ("timeOrigin", JsValue::Number(store_options.time_origin)),
            ("version", JsValue::Number(store.version())),
            ("timeVersion", JsValue::Number(store.time_version())),
            ("columns", JsValue::Object(column_refs)),
            ("index", index),
        ]);
        let panels = model
            .panels
            .iter()
            .map(|panel| ordered_record(&panel.to_js_value(), PANEL_KEYS))
            .collect::<Result<Vec<_>, JsError>>()?;
        let axes = model
            .axes
            .iter()
            .map(|axis| ordered_record(&axis.to_js_value(), AXIS_KEYS))
            .collect::<Result<Vec<_>, JsError>>()?;
        let metadata = object([
            ("schema", text("aster.async.snapshot")),
            ("protocol", JsValue::Number(1.0)),
            ("event", event),
            ("store", store_metadata),
            ("panels", JsValue::Array(panels)),
            ("axes", JsValue::Array(axes)),
            ("theme", model.theme().clone()),
            ("precision", JsValue::Number(f64::from(model.precision))),
            ("axisWidth", JsValue::Number(model.axis_width)),
            ("indicators", JsValue::Array(indicator_rows)),
            ("series", JsValue::Array(series)),
            (
                "bufferLengths",
                JsValue::Array(
                    collector
                        .lengths
                        .iter()
                        .map(|length| JsValue::Number(*length as f64))
                        .collect(),
                ),
            ),
            (
                "maxOutputBytes",
                JsValue::Number(engine.max_output_bytes() as f64),
            ),
        ]);
        let metadata_json = safe_checkpoint_stringify_with(&metadata, dialect)?;
        let source = Self {
            metadata,
            metadata_json,
            slots: collector.slots,
            lengths: collector.lengths,
            checkpoints,
            memory: source_memory,
            fingerprint,
            dialect,
            closed: false,
        };
        source.check(owner, model, engine, caches)?;
        Ok(source)
    }

    /// parsed lossless metadata tree다.
    pub fn metadata(&self) -> &JsValue {
        &self.metadata
    }

    /// host transport에 주는 exact metadata document다.
    pub fn metadata_json(&self) -> &JsString {
        &self.metadata_json
    }

    /// slot 순서/길이다.
    pub fn buffer_descriptors(&self) -> Vec<NativeBufferDescriptor> {
        self.lengths
            .iter()
            .enumerate()
            .map(|(slot, length)| NativeBufferDescriptor {
                slot,
                length: *length,
            })
            .collect()
    }

    /// indicator 순서의 checkpoint transfer descriptor다.
    pub fn checkpoint_descriptors(&self) -> Vec<NativeCheckpointDescriptor> {
        self.checkpoints
            .iter()
            .enumerate()
            .map(|(entry, row)| NativeCheckpointDescriptor {
                entry,
                total: row.keys.len(),
                max_rows: row.max_rows,
            })
            .collect()
    }

    /// 현재 source owner/config/revision identity를 다시 검사한다.
    pub fn check(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
    ) -> Result<(), JsError> {
        if self.closed
            || !self
                .fingerprint
                .matches(owner, model, engine, caches, self.dialect)
        {
            return Err(ordinary_error(
                "Async stale: data/configuration/revision changed",
            ));
        }
        Ok(())
    }

    /// guard 뒤 f64 buffer slice를 빌린다. count 0은 source처럼 허용한다.
    #[allow(clippy::too_many_arguments)]
    pub fn buffer<'a>(
        &self,
        owner: &'a IngestionOwner,
        model: &'a ModelState,
        engine: &'a IndicatorEngine,
        caches: &'a SeriesCaches,
        slot: f64,
        offset: f64,
        count: f64,
    ) -> Result<&'a [f64], JsError> {
        self.check(owner, model, engine, caches)?;
        if !exact_integer(slot, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 0.0, ASYNC_BUFFER_SLICE as f64)
        {
            return Err(range_error("Async buffer slice"));
        }
        let Some(source) = self.slots.get(slot as usize) else {
            return Err(range_error("Async buffer slice"));
        };
        let Some(buffer) = source.resolve(owner, model, engine, caches) else {
            return Err(ordinary_error(
                "Async stale: data/configuration/revision changed",
            ));
        };
        if buffer.len() != self.lengths[slot as usize] {
            return Err(ordinary_error(
                "Async stale: data/configuration/revision changed",
            ));
        }
        if offset + count > buffer.len() as f64 {
            return Err(range_error("Async buffer slice"));
        }
        Ok(&buffer[offset as usize..(offset + count) as usize])
    }

    /// guard 뒤 checkpoint row chunk를 exact safe-checkpoint text로 만든다.
    #[allow(clippy::too_many_arguments)]
    pub fn checkpoint(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        entry: f64,
        offset: f64,
        count: f64,
    ) -> Result<JsString, JsError> {
        let mut scope = MemoryScope::unaccounted(self.memory.context().oom_style());
        self.checkpoint_scoped(
            owner, model, engine, caches, entry, offset, count, &mut scope,
        )
    }

    /// Checkpoint row JSON을 caller serialization scope에서 직접 만든다.
    #[allow(clippy::too_many_arguments)]
    pub fn checkpoint_scoped(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        entry: f64,
        offset: f64,
        count: f64,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        self.check(owner, model, engine, caches)?;
        if !exact_integer(entry, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, 64.0)
        {
            return Err(range_error("Async checkpoint slice"));
        }
        let Some(row) = self.checkpoints.get(entry as usize) else {
            return Err(range_error("Async checkpoint slice"));
        };
        if count as usize > row.max_rows || offset + count > row.keys.len() as f64 {
            return Err(range_error("Async checkpoint slice"));
        }
        let lookup = row
            .id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let Some(current) = engine.entry(&JsValue::String(lookup)) else {
            return Err(ordinary_error(
                "Async stale: data/configuration/revision changed",
            ));
        };
        let row_slots = (count as usize)
            .checked_mul(size_of::<JsValue>())
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        scope
            .try_grow(row_slots)
            .map_err(|failure| failure.into_js_error())?;
        let mut rows = Vec::new();
        rows.try_reserve_exact(count as usize)
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        for index in offset as usize..(offset + count) as usize {
            let state = current
                .checkpoint(row.keys[index])
                .ok_or_else(|| ordinary_error("Async stale: data/configuration/revision changed"))?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            scope
                .try_grow(2 * size_of::<JsValue>())
                .map_err(|failure| failure.into_js_error())?;
            let mut pair = Vec::new();
            pair.try_reserve_exact(2)
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            pair.push(JsValue::Number(row.keys[index] as f64));
            pair.push(state);
            rows.push(JsValue::Array(pair));
        }
        safe_checkpoint_stringify_scoped(&JsValue::Array(rows), self.dialect, scope)
    }

    /// source transfer를 닫는다. Root가 별도 ingestion lease를 해제한다.
    pub fn dispose(&mut self) {
        self.closed = true;
        self.slots.clear();
        self.lengths.clear();
        self.checkpoints.clear();
        let context = self.memory.context().clone();
        self.memory = MemoryGroup::empty(context);
    }
}

/// Prepare source input kind다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativePrepareKind {
    /// Host가 여섯 열을 target으로 보낸다.
    Columns,
    /// Target이 seed-42 호환 LCG로 열을 생성한다.
    Seeded,
}

impl NativePrepareKind {
    fn as_js(self) -> &'static str {
        match self {
            Self::Columns => "columns",
            Self::Seeded => "seeded",
        }
    }
}

/// 검증된 prepare 요청이다.
#[derive(Clone, Debug, PartialEq)]
pub struct NativePrepareRequest {
    /// 입력 방식이다.
    pub kind: NativePrepareKind,
    /// 결과 bar 수다.
    pub length: usize,
    /// seeded LCG 초기값이다.
    pub seed: u32,
    /// 초기 viewport bar 수다. JS처럼 fractional finite 값도 보존한다.
    pub visible_bars: f64,
}

impl NativePrepareRequest {
    /// JS prepare request record를 exact defaults/order로 검증한다.
    pub fn parse(value: &JsValue) -> Result<Self, JsError> {
        crate::contracts::option_record(
            value,
            &["kind", "length", "count", "seed", "visibleBars"],
            "Prepare request",
        )?;
        let kind = match property(value, "kind").and_then(string) {
            Some(kind) if text_is(kind, "columns") => NativePrepareKind::Columns,
            Some(kind) if text_is(kind, "seeded") => NativePrepareKind::Seeded,
            _ => return Err(type_error("Prepare input kind")),
        };
        let length = match property(
            value,
            match kind {
                NativePrepareKind::Columns => "length",
                NativePrepareKind::Seeded => "count",
            },
        ) {
            Some(JsValue::Number(value))
                if exact_integer(*value, 0.0, RESOURCE_LIMITS.max_bars as f64) =>
            {
                *value as usize
            }
            _ => {
                return Err(range_error(&format!(
                    "Prepare bar count: limit {}",
                    RESOURCE_LIMITS.max_bars
                )));
            }
        };
        let seed = match property(value, "seed") {
            None | Some(JsValue::Undefined | JsValue::Null) => 42,
            Some(JsValue::Number(value)) if exact_integer(*value, 0.0, u32::MAX as f64) => {
                *value as u32
            }
            _ => return Err(range_error("Prepare seed: limit 4294967295")),
        };
        let visible_bars = match property(value, "visibleBars") {
            None | Some(JsValue::Undefined | JsValue::Null) => 200.0,
            Some(JsValue::Number(value))
                if value.is_finite() && (1.0..=RESOURCE_LIMITS.max_bars as f64).contains(value) =>
            {
                *value
            }
            _ => return Err(range_error("Prepare visible bars")),
        };
        Ok(Self {
            kind,
            length,
            seed,
            visible_bars,
        })
    }

    /// metadata.input key 순서다.
    pub fn to_js_value(&self) -> JsValue {
        object([
            ("kind", text(self.kind.as_js())),
            ("length", JsValue::Number(self.length as f64)),
            ("seed", JsValue::Number(f64::from(self.seed))),
            ("visibleBars", JsValue::Number(self.visible_bars)),
        ])
    }
}

/// 실제 prepare source snapshot이다. Data transfer buffer는 columns 요청의 target에서 생긴다.
pub struct NativePrepareSource {
    request: NativePrepareRequest,
    metadata: JsValue,
    metadata_json: JsString,
    prepared_input: JsValue,
    fingerprint: NativeSourceFingerprint,
    dialect: NumberDialect,
    closed: bool,
}

impl NativePrepareSource {
    /// source config/definitions를 capture하되 source data 열은 복사하지 않는다.
    pub fn capture(
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
        request: &JsValue,
        dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        let request = NativePrepareRequest::parse(request)?;
        if request.length > owner.data().store().max_bars() {
            return Err(range_error(&format!(
                "Prepare source bar limit: limit {}",
                owner.data().store().max_bars()
            )));
        }
        if engine.len() > ASYNC_MAX_INDICATORS || model.series.len() > ASYNC_MAX_SERIES {
            return Err(type_error("Prepare indicators"));
        }
        if model.series.iter().any(|series| series.values.is_some()) {
            return Err(type_error("Prepare borrowed series values unsupported"));
        }
        // Keep source capture on the same fallible engine/store memory boundary as target
        // payload capture. The cloned payload is temporary; prepare metadata remains source-owned
        // and never aliases these arrays.
        let (_, _, capture_memory) = engine.capture_native_entries_with_memory(
            owner.data().store(),
            owner.data().store().memory_context(),
        )?;
        drop(capture_memory);
        let fingerprint = NativeSourceFingerprint::capture(owner, model, engine, caches, dialect)?;
        let mut indicators = Vec::with_capacity(engine.len());
        for id in engine.entry_ids() {
            let entry = engine
                .entry(&JsValue::String(id.clone()))
                .expect("entry id snapshot is current");
            let definition = entry.definition();
            let mut row = JsObject::new();
            row.insert(key("id"), JsValue::String(id));
            row.insert(key("name"), JsValue::String(entry.name().clone()));
            row.insert(key("params"), entry.params().clone());
            if matches!(definition.provenance, IndicatorProvenance::Linked(_)) {
                row.insert(key("module"), pressure_descriptor_value());
            }
            row.insert(
                key("outputs"),
                JsValue::Array(
                    definition
                        .outputs
                        .iter()
                        .map(|output| text(output))
                        .collect(),
                ),
            );
            let mut offsets = JsObject::new();
            for offset in &definition.plot_offsets {
                offsets.insert(key(offset.output), JsValue::Number(offset.value));
            }
            row.insert(key("plotOffsets"), JsValue::Object(offsets));
            indicators.push(JsValue::Object(row));
        }
        let series = model
            .series
            .iter()
            .map(|series| ordered_record(&series.raw_record(), SERIES_KEYS))
            .collect::<Result<Vec<_>, JsError>>()?;
        let panels = model
            .panels
            .iter()
            .map(|panel| ordered_record(&panel.to_js_value(), PANEL_KEYS))
            .collect::<Result<Vec<_>, JsError>>()?;
        let axes = model
            .axes
            .iter()
            .map(|axis| ordered_record(&axis.to_js_value(), AXIS_KEYS))
            .collect::<Result<Vec<_>, JsError>>()?;
        let store = owner.data().store();
        let options = store.store_options();
        let store_options = object([
            ("maxBars", JsValue::Number(store.max_bars() as f64)),
            ("timeframeMs", JsValue::Number(options.timeframe_ms)),
            ("timeOrigin", JsValue::Number(options.time_origin)),
        ]);
        let version = store.version() + 1.0;
        let time_version = store.time_version() + 1.0;
        let metadata = object([
            ("schema", text("aster.prepare")),
            ("protocol", JsValue::Number(1.0)),
            ("input", request.to_js_value()),
            ("storeOptions", store_options.clone()),
            ("version", JsValue::Number(version)),
            ("timeVersion", JsValue::Number(time_version)),
            ("panels", JsValue::Array(panels)),
            ("axes", JsValue::Array(axes)),
            ("theme", model.theme().clone()),
            ("precision", JsValue::Number(f64::from(model.precision))),
            ("axisWidth", JsValue::Number(model.axis_width)),
            ("indicators", JsValue::Array(indicators)),
            ("series", JsValue::Array(series)),
            (
                "maxOutputBytes",
                JsValue::Number(engine.max_output_bytes() as f64),
            ),
        ]);
        let prepared_input = object([
            ("input", request.to_js_value()),
            ("version", JsValue::Number(version)),
            ("timeVersion", JsValue::Number(time_version)),
            ("storeOptions", store_options),
            (
                "maxOutputBytes",
                JsValue::Number(engine.max_output_bytes() as f64),
            ),
        ]);
        let metadata_json = safe_checkpoint_stringify_with(&metadata, dialect)?;
        let source = Self {
            request,
            metadata,
            metadata_json,
            prepared_input,
            fingerprint,
            dialect,
            closed: false,
        };
        source.check(owner, model, engine, caches)?;
        Ok(source)
    }

    /// 검증된 prepare request다.
    pub fn request(&self) -> &NativePrepareRequest {
        &self.request
    }

    /// parsed metadata tree다.
    pub fn metadata(&self) -> &JsValue {
        &self.metadata
    }

    /// exact host metadata document다.
    pub fn metadata_json(&self) -> &JsString {
        &self.metadata_json
    }

    /// UI finish binding에 포함할 exact request/version/options record다.
    pub fn prepared_input(&self) -> &JsValue {
        &self.prepared_input
    }

    /// source data/config binding을 검사한다. Cache-only 계산은 무시한다.
    pub fn check(
        &self,
        owner: &IngestionOwner,
        model: &ModelState,
        engine: &IndicatorEngine,
        caches: &SeriesCaches,
    ) -> Result<(), JsError> {
        if self.closed
            || !self
                .fingerprint
                .matches(owner, model, engine, caches, self.dialect)
        {
            return Err(ordinary_error("Prepare stale: data/configuration changed"));
        }
        Ok(())
    }

    /// source state를 닫는다. Root가 별도 ingestion lease를 해제한다.
    pub fn dispose(&mut self) {
        self.closed = true;
    }
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

fn definition_layout(snapshot: &NativeIndicatorEntrySnapshot) -> JsValue {
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

struct PrepareTargetSpec {
    request: NativePrepareRequest,
    store_options: StoreOptions,
    version: f64,
    time_version: f64,
    panels: JsValue,
    axes: JsValue,
    theme: JsValue,
    precision: f64,
    axis_width: f64,
    series: Vec<JsValue>,
    templates: Vec<NativeIndicatorEntrySnapshot>,
    engine_options: IndicatorEngineOptions,
    prepared_input: JsValue,
    capacity: usize,
}

impl PrepareTargetSpec {
    fn parse(
        metadata_text: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let metadata =
            safe_checkpoint_parse_with(&JsValue::String(metadata_text.clone()), dialect)?;
        crate::contracts::option_record(
            &metadata,
            &[
                "schema",
                "protocol",
                "input",
                "storeOptions",
                "version",
                "timeVersion",
                "panels",
                "axes",
                "theme",
                "precision",
                "axisWidth",
                "indicators",
                "series",
                "maxOutputBytes",
            ],
            "Prepare metadata",
        )?;
        if !matches!(property(&metadata, "schema"), Some(JsValue::String(value)) if text_is(value, "aster.prepare"))
            || !matches!(property(&metadata, "protocol"), Some(JsValue::Number(1.0)))
        {
            return Err(type_error("Prepare protocol"));
        }
        let input = property(&metadata, "input").ok_or_else(|| type_error("Prepare input"))?;
        crate::contracts::option_record(
            input,
            &["kind", "length", "seed", "visibleBars"],
            "Prepare input",
        )?;
        let kind = property(input, "kind")
            .and_then(string)
            .ok_or_else(|| type_error("Prepare input kind"))?;
        let length = number_field(input, "length", "Prepare bar count")?;
        let request_value = if text_is(kind, "columns") {
            object([
                ("kind", text("columns")),
                ("length", JsValue::Number(length)),
                (
                    "seed",
                    property(input, "seed")
                        .cloned()
                        .unwrap_or(JsValue::Undefined),
                ),
                (
                    "visibleBars",
                    property(input, "visibleBars")
                        .cloned()
                        .unwrap_or(JsValue::Undefined),
                ),
            ])
        } else if text_is(kind, "seeded") {
            object([
                ("kind", text("seeded")),
                ("count", JsValue::Number(length)),
                (
                    "seed",
                    property(input, "seed")
                        .cloned()
                        .unwrap_or(JsValue::Undefined),
                ),
                (
                    "visibleBars",
                    property(input, "visibleBars")
                        .cloned()
                        .unwrap_or(JsValue::Undefined),
                ),
            ])
        } else {
            return Err(type_error("Prepare input kind"));
        };
        let request = NativePrepareRequest::parse(&request_value)?;
        let mut capacity = 16usize;
        while capacity < request.length {
            capacity = capacity
                .checked_mul(2)
                .ok_or_else(|| range_error("Prepare retained typed-byte budget"))?;
        }
        let store_options_value = property(&metadata, "storeOptions")
            .ok_or_else(|| type_error("Prepare store options"))?;
        crate::contracts::option_record(
            store_options_value,
            &["maxBars", "timeframeMs", "timeOrigin"],
            "Prepare store options",
        )?;
        let max_bars = safe_usize(
            number_field(store_options_value, "maxBars", "Prepare bar limit")?,
            RESOURCE_LIMITS.max_bars as usize,
            "Prepare bar limit",
        )?;
        let timeframe_ms = number_field(
            store_options_value,
            "timeframeMs",
            "Prepare timeframe/origin",
        )?;
        let time_origin = number_field(
            store_options_value,
            "timeOrigin",
            "Prepare timeframe/origin",
        )?;
        if !timeframe_ms.is_finite() || timeframe_ms <= 0.0 || !time_origin.is_finite() {
            return Err(type_error("Prepare timeframe/origin"));
        }
        if request.length > max_bars {
            return Err(range_error(&format!("Prepare bars: limit {max_bars}")));
        }
        let version = number_field(&metadata, "version", "Prepare revision")?;
        let time_version = number_field(&metadata, "timeVersion", "Prepare revision")?;
        if !exact_integer(version, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(time_version, 0.0, MAX_SAFE_INTEGER)
        {
            return Err(range_error("Prepare revision"));
        }
        let max_output_bytes = safe_usize(
            number_field(&metadata, "maxOutputBytes", "Prepare output budget")?,
            ASYNC_SNAPSHOT_BYTES,
            "Prepare output budget",
        )?;
        let engine_options = IndicatorEngineOptions {
            checkpoint_size: 256,
            max_output_bytes,
        };
        let Some(JsValue::Array(indicators)) = property(&metadata, "indicators") else {
            return Err(type_error("Prepare indicators"));
        };
        if indicators.len() > ASYNC_MAX_INDICATORS {
            return Err(type_error("Prepare indicators"));
        }
        let probe_data = ModelDataState::new(StoreOptions::default(), Vec::new())?;
        let mut probe = IndicatorEngine::new_with_memory(engine_options, memory.clone())?;
        for indicator in indicators {
            crate::contracts::option_record(
                indicator,
                &["id", "name", "params", "module", "outputs", "plotOffsets"],
                "Prepare indicator",
            )?;
            let id = property(indicator, "id")
                .cloned()
                .unwrap_or(JsValue::Undefined);
            let name = property(indicator, "name")
                .cloned()
                .unwrap_or(JsValue::Undefined);
            let params = property(indicator, "params")
                .cloned()
                .unwrap_or(JsValue::Undefined);
            let name_text = string(&name).ok_or_else(|| type_error("Prepare output definition"))?;
            validate_indicator_module_binding(name_text, property(indicator, "module"))?;
            probe.add(probe_data.store(), host, &id, &name, &params)?;
            let entry = probe
                .entry(&id)
                .ok_or_else(|| type_error("Prepare output definition"))?;
            let expected = object([
                (
                    "outputs",
                    property(indicator, "outputs")
                        .cloned()
                        .unwrap_or(JsValue::Undefined),
                ),
                (
                    "plotOffsets",
                    property(indicator, "plotOffsets")
                        .cloned()
                        .unwrap_or(JsValue::Undefined),
                ),
            ]);
            let (_, snapshots, capture_memory) =
                probe.capture_native_entries_with_memory(probe_data.store(), memory)?;
            let actual = definition_layout(
                snapshots
                    .last()
                    .expect("new probe entry has native snapshot"),
            );
            if !exact_state_equal(&actual, &expected) || !exact_state_equal(entry.params(), &params)
            {
                return Err(type_error("Prepare output definition"));
            }
            drop(capture_memory);
        }
        let (_, mut templates, capture_memory) =
            probe.capture_native_entries_with_memory(probe_data.store(), memory)?;
        drop(capture_memory);
        for template in &mut templates {
            template.arrays = Vec::new();
        }
        let output_count = templates
            .iter()
            .map(|entry| entry.definition.outputs.len())
            .sum::<usize>();
        if output_count
            .checked_mul(capacity)
            .and_then(|values| values.checked_mul(8))
            .is_none_or(|bytes| bytes > max_output_bytes)
        {
            return Err(range_error("Prepare indicator output budget"));
        }
        if capacity
            .checked_mul(8)
            .and_then(|bytes| bytes.checked_mul(12 + output_count))
            .is_none_or(|bytes| bytes > 805_306_368)
        {
            return Err(range_error("Prepare retained typed-byte budget"));
        }
        let Some(JsValue::Array(series)) = property(&metadata, "series") else {
            return Err(type_error("Prepare series"));
        };
        if series.len() > ASYNC_MAX_SERIES {
            return Err(type_error("Prepare series"));
        }
        for series in series {
            crate::contracts::option_record(
                series,
                &SERIES_KEYS
                    .iter()
                    .copied()
                    .filter(|name| *name != "values")
                    .collect::<Vec<_>>(),
                "Prepare series",
            )?;
            crate::contracts::identifier(
                property(series, "id").unwrap_or(&JsValue::Undefined),
                "Prepare series id",
            )?;
        }
        let panels = property(&metadata, "panels")
            .cloned()
            .ok_or_else(|| type_error("Prepare metadata"))?;
        let axes = property(&metadata, "axes")
            .cloned()
            .unwrap_or_else(|| JsValue::Array(Vec::new()));
        let theme = property(&metadata, "theme")
            .cloned()
            .ok_or_else(|| type_error("Prepare metadata"))?;
        let precision = number_field(&metadata, "precision", "Prepare metadata")?;
        let axis_width = number_field(&metadata, "axisWidth", "Prepare metadata")?;
        let store_options = StoreOptions {
            timeframe_ms,
            time_origin,
            max_bars,
        };
        let prepared_input = object([
            ("input", request.to_js_value()),
            ("version", JsValue::Number(version)),
            ("timeVersion", JsValue::Number(time_version)),
            (
                "storeOptions",
                object([
                    ("maxBars", JsValue::Number(max_bars as f64)),
                    ("timeframeMs", JsValue::Number(timeframe_ms)),
                    ("timeOrigin", JsValue::Number(time_origin)),
                ]),
            ),
            ("maxOutputBytes", JsValue::Number(max_output_bytes as f64)),
        ]);
        Ok(Self {
            request,
            store_options,
            version,
            time_version,
            panels,
            axes,
            theme,
            precision,
            axis_width,
            series: series.clone(),
            templates,
            engine_options,
            prepared_input,
            capacity,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreparePhase {
    Capture,
    Generate,
    Validate,
    StoreIndex,
    Calculate,
    Indices,
    Ready,
}

impl PreparePhase {
    fn name(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Generate => "generate",
            Self::Validate => "validate",
            Self::StoreIndex => "store-index",
            Self::Calculate => "calculate",
            Self::Indices => "indices",
            Self::Ready => "ready",
        }
    }
}

/// Prepare target가 ready 뒤 Root/UI layer에 넘기는 실제 core parts다.
pub struct NativePreparedCore {
    /// 실제 data + ingestion owner다.
    pub owner: IngestionOwner,
    /// 실제 model configuration/view다.
    pub model: ModelState,
    /// 실제 indicator engine/outputs/checkpoints다.
    pub indicators: IndicatorEngine,
    /// 실제 series cache collection이다.
    pub caches: SeriesCaches,
    /// finish UI binding에 대조할 prepare signature다.
    pub prepared_input: JsValue,
}

struct IndexBuildTask {
    series: usize,
    blocked: bool,
    block_size: usize,
    leaves: usize,
    next_leaf: usize,
    next_merge: usize,
    builder: Option<RangeIndexBuilder>,
    memory: Option<MemoryGroup>,
    merging: bool,
    finalize: bool,
}

impl IndexBuildTask {
    fn new(
        series: usize,
        length: usize,
        capacity: usize,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let blocked = length >= crate::series_cache::SERIES_BLOCK_THRESHOLD;
        let block_size = if blocked { 32 } else { 1 };
        let leaves = length.div_ceil(block_size);
        let tree_capacity = capacity.div_ceil(block_size);
        let (builder, builder_memory) =
            RangeIndexBuilder::new_with_memory(tree_capacity, !blocked, blocked, memory)?;
        let next_merge = builder.buffer_view().size.saturating_sub(1);
        Ok(Self {
            series,
            blocked,
            block_size,
            leaves,
            next_leaf: 0,
            next_merge,
            builder: Some(builder),
            memory: Some(builder_memory),
            merging: false,
            finalize: false,
        })
    }
}

/// Actual seeded/columns prepare target state machine다.
pub struct NativePrepareTarget {
    spec: PrepareTargetSpec,
    dialect: NumberDialect,
    memory: MemoryContext,
    columns: Option<Columns>,
    columns_memory: Option<MemoryGroup>,
    received: [usize; 6],
    phase: PreparePhase,
    at: usize,
    previous: f64,
    seed: u32,
    price: f64,
    index_builder: Option<RangeIndexBuilder>,
    index_memory: Option<MemoryGroup>,
    serial: Option<f64>,
    core: Option<NativePreparedCore>,
    entry: usize,
    calculation: Option<IndicatorCalculation>,
    series: usize,
    index_task: Option<IndexBuildTask>,
}

impl NativePrepareTarget {
    /// Prepare metadata를 검증하고 target columns만 선할당한다.
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

    /// Prepare target을 explicit engine memory context에 연결하고 여섯 열을 예약한다.
    pub fn new_with_memory(
        metadata: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        let spec = PrepareTargetSpec::parse(metadata, dialect, host, &memory)?;
        let capacity = spec.capacity;
        let mut columns_memory = MemoryGroup::empty(memory.clone());
        let (time, time_memory) = memory
            .try_vec_filled(capacity, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        columns_memory
            .absorb(time_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (open, open_memory) = memory
            .try_vec_filled(capacity, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        columns_memory
            .absorb(open_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (high, high_memory) = memory
            .try_vec_filled(capacity, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        columns_memory
            .absorb(high_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (low, low_memory) = memory
            .try_vec_filled(capacity, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        columns_memory
            .absorb(low_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (close, close_memory) = memory
            .try_vec_filled(capacity, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        columns_memory
            .absorb(close_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (volume, volume_memory) = memory
            .try_vec_filled(capacity, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        columns_memory
            .absorb(volume_memory)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self {
            seed: spec.request.seed,
            spec,
            dialect,
            memory,
            columns: Some(Columns {
                time,
                open,
                high,
                low,
                close,
                volume,
            }),
            columns_memory: Some(columns_memory),
            received: [0; 6],
            phase: PreparePhase::Capture,
            at: 0,
            previous: f64::NEG_INFINITY,
            price: 100.0,
            index_builder: None,
            index_memory: None,
            serial: None,
            core: None,
            entry: 0,
            calculation: None,
            series: 0,
            index_task: None,
        })
    }

    /// columns input을 slot별 연속 prefix로 받는다.
    pub fn target(&mut self, slot: f64, offset: f64, count: f64) -> Result<&mut [f64], JsError> {
        if self.phase != PreparePhase::Capture
            || self.spec.request.kind != NativePrepareKind::Columns
            || !exact_integer(slot, 0.0, 5.0)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, ASYNC_BUFFER_SLICE as f64)
        {
            return Err(range_error("Prepare target slice"));
        }
        let slot = slot as usize;
        if offset as usize != self.received[slot]
            || offset + count > self.spec.request.length as f64
        {
            return Err(range_error("Prepare target slice"));
        }
        self.received[slot] += count as usize;
        let columns = self.columns.as_mut().expect("capture columns");
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

    /// input 완전성과 target-runtime store serial을 고정하고 bounded work를 시작한다.
    pub fn start(&mut self, serial: f64) -> Result<(), JsError> {
        if self.phase != PreparePhase::Capture
            || self.spec.request.kind == NativePrepareKind::Columns
                && self
                    .received
                    .iter()
                    .any(|received| *received != self.spec.request.length)
        {
            return Err(ordinary_error("Prepare incomplete input"));
        }
        if !exact_integer(serial, 1.0, MAX_SAFE_INTEGER) {
            return Err(range_error("Workspace store serial"));
        }
        let (index_builder, index_memory) =
            RangeIndexBuilder::new_with_memory(self.spec.capacity, false, true, &self.memory)?;
        self.serial = Some(serial);
        self.index_builder = Some(index_builder);
        self.index_memory = Some(index_memory);
        self.phase = match self.spec.request.kind {
            NativePrepareKind::Columns => PreparePhase::Validate,
            NativePrepareKind::Seeded => PreparePhase::Generate,
        };
        self.at = 0;
        Ok(())
    }

    /// JS prepare generator와 같은 phase/done/total 경계로 한 chunk를 처리한다.
    pub fn step(&mut self, max_bars: f64, host: &dyn Host) -> Result<NativeJobProgress, JsError> {
        if !exact_integer(max_bars, 1.0, 65_536.0) {
            return Err(range_error("Prepare step size"));
        }
        if self.phase == PreparePhase::Capture {
            return Err(ordinary_error("Prepare not started"));
        }
        let max_bars = max_bars as usize;
        let length = self.spec.request.length;
        if self.phase == PreparePhase::Generate {
            let end = std::cmp::min(length, self.at + max_bars);
            let columns = self.columns.as_mut().expect("generated columns");
            while self.at < end {
                let index = self.at;
                let open = self.price;
                let mut random = || {
                    self.seed = self
                        .seed
                        .wrapping_mul(1_664_525)
                        .wrapping_add(1_013_904_223);
                    f64::from(self.seed) / 4_294_967_296.0
                };
                self.price = js_max(&[0.1, self.price + (random() - 0.497) * 1.2]);
                columns.time[index] = 1_700_000_000_000.0 + index as f64 * 60_000.0;
                columns.open[index] = open;
                columns.close[index] = self.price;
                columns.high[index] = js_max(&[open, self.price]) + random() * 0.6;
                columns.low[index] = js_max(&[0.01, js_min(&[open, self.price]) - random() * 0.6]);
                columns.volume[index] = (100.0 + random() * 9_900.0).floor();
                self.at += 1;
            }
            let progress = NativeJobProgress {
                phase: "generate",
                done: self.at,
                total: length,
                complete: false,
            };
            if self.at == length {
                self.phase = PreparePhase::Validate;
                self.at = 0;
            }
            return Ok(progress);
        }
        if self.phase == PreparePhase::Validate {
            let end = std::cmp::min(length, self.at + max_bars);
            let columns = self.columns.as_ref().expect("validated columns");
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
                if ![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]
                    .into_iter()
                    .all(f64::is_finite)
                {
                    return Err(type_error("Every OHLCV field must be finite"));
                }
                if !exact_integer(bar.time, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
                    || bar.time.abs() > 8_640_000_000_000_000.0
                {
                    return Err(range_error("OHLCV UTC time"));
                }
                if bar.time <= self.previous {
                    return Err(range_error("OHLCV increasing time"));
                }
                if bar.volume < 0.0
                    || bar.low > js_min(&[bar.open, bar.close])
                    || bar.high < js_max(&[bar.open, bar.close])
                    || bar.low > bar.high
                {
                    return Err(range_error("Invalid OHLCV envelope"));
                }
                self.previous = bar.time;
                self.index_builder
                    .as_mut()
                    .expect("prepare index builder")
                    .leaf(index, bar.low, bar.high, bar.volume)?;
                self.at += 1;
            }
            let progress = NativeJobProgress {
                phase: "validate",
                done: self.at,
                total: length,
                complete: false,
            };
            if self.at == length {
                self.phase = PreparePhase::StoreIndex;
                self.at = self.spec.capacity - 1;
            }
            return Ok(progress);
        }
        if self.phase == PreparePhase::StoreIndex {
            let stop = self.at.saturating_sub(max_bars);
            while self.at > stop {
                self.index_builder
                    .as_mut()
                    .expect("prepare index builder")
                    .merge(self.at)?;
                self.at -= 1;
            }
            let progress = NativeJobProgress {
                phase: "store-index",
                done: self.spec.capacity - 1 - self.at,
                total: self.spec.capacity - 1,
                complete: false,
            };
            if self.at == 0 {
                self.initialize_core()?;
                self.phase = PreparePhase::Calculate;
            }
            return Ok(progress);
        }
        if self.phase == PreparePhase::Calculate {
            let core = self.core.as_mut().expect("initialized prepare core");
            let ids = core.indicators.entry_ids();
            if self.entry < ids.len() {
                if self.calculation.is_none() {
                    self.calculation = Some(
                        core.indicators
                            .calculate(JsValue::String(ids[self.entry].clone()), max_bars as f64),
                    );
                }
                let step = self.calculation.as_mut().expect("calculation token").step(
                    &mut core.indicators,
                    core.owner.data().store(),
                    host,
                )?;
                if matches!(
                    step,
                    CalculationStep::Complete { .. } | CalculationStep::Exhausted
                ) {
                    self.calculation = None;
                    self.entry += 1;
                }
                return Ok(NativeJobProgress {
                    phase: "calculate",
                    done: self.entry,
                    total: ids.len(),
                    complete: false,
                });
            }
            self.install_series()?;
            self.phase = PreparePhase::Indices;
            self.series = 0;
        }
        if self.phase == PreparePhase::Indices {
            let series_count = self
                .core
                .as_ref()
                .expect("initialized prepare core")
                .model
                .series
                .len();
            if self.series < series_count {
                let kind = self
                    .core
                    .as_ref()
                    .expect("initialized prepare core")
                    .model
                    .series[self.series]
                    .kind;
                if matches!(
                    kind,
                    crate::model_state::SeriesKind::Candles | crate::model_state::SeriesKind::Ohlc
                ) {
                    self.series += 1;
                } else {
                    if self.index_task.is_none() {
                        self.index_task = Some(IndexBuildTask::new(
                            self.series,
                            length,
                            self.spec.capacity,
                            &self.memory,
                        )?);
                    }
                    if self.step_index(max_bars)? {
                        self.index_task = None;
                        self.series += 1;
                    }
                }
                return Ok(NativeJobProgress {
                    phase: "indices",
                    done: self.series,
                    total: series_count,
                    complete: false,
                });
            }
            self.phase = PreparePhase::Ready;
        }
        Ok(NativeJobProgress {
            phase: "ready",
            done: 1,
            total: 1,
            complete: true,
        })
    }

    fn initialize_core(&mut self) -> Result<(), JsError> {
        let index = self
            .index_builder
            .take()
            .expect("prepare index builder")
            .finish(self.spec.request.length)?;
        let columns = self.columns.take().expect("prepare columns");
        let mut store_memory = self.columns_memory.take().expect("prepare columns memory");
        store_memory
            .absorb(self.index_memory.take().expect("prepare index memory"))
            .map_err(|failure| failure.into_js_error())?;
        let data = ModelDataState::from_validated_native_snapshot_columns_with_memory(
            self.serial.expect("prepare target serial"),
            self.spec.store_options,
            columns,
            index,
            self.spec.request.length,
            self.spec.version,
            self.spec.time_version,
            store_memory,
        )?;
        let owner = IngestionOwner::new(data, self.dialect);
        let options = object([
            ("panels", self.spec.panels.clone()),
            ("axes", self.spec.axes.clone()),
            ("theme", self.spec.theme.clone()),
            ("precision", JsValue::Number(self.spec.precision)),
            ("axisWidth", JsValue::Number(self.spec.axis_width)),
            (
                "visibleBars",
                JsValue::Number(self.spec.request.visible_bars),
            ),
        ]);
        let model = ModelState::new(owner.data().store(), &options)?;
        let mut engine =
            IndicatorEngine::new_with_memory(self.spec.engine_options, self.memory.clone())?;
        let mut templates = std::mem::take(&mut self.spec.templates);
        let mut indicator_memory = MemoryGroup::empty(self.memory.clone());
        for template in &mut templates {
            template.arrays = Vec::new();
            template
                .arrays
                .try_reserve_exact(template.definition.outputs.len())
                .map_err(|_| self.memory.allocation_failure().into_js_error())?;
            for _ in template.definition.outputs {
                let (values, values_memory) = self
                    .memory
                    .try_vec_filled(self.spec.capacity, f64::NAN)
                    .map_err(|failure| failure.into_js_error())?;
                indicator_memory
                    .absorb(values_memory)
                    .map_err(|failure| failure.into_js_error())?;
                template.arrays.push(values);
            }
            template.checkpoints.clear();
            template.revision = 0.0;
            template.dirty = 0;
            template.dirty_to = Some(self.spec.request.length);
            template.invalidated = true;
            template.length = 0;
            template.computed_from = None;
            template.computed_until = None;
            template.prepared_version = None;
        }
        let stage = engine.stage_native_restore_with_memory(
            owner.data().store(),
            templates,
            indicator_memory,
        )?;
        engine.publish_native_restore(owner.data().store(), stage)?;
        self.core = Some(NativePreparedCore {
            owner,
            model,
            indicators: engine,
            caches: SeriesCaches::new_with_memory(self.memory.clone()),
            prepared_input: self.spec.prepared_input.clone(),
        });
        Ok(())
    }

    fn install_series(&mut self) -> Result<(), JsError> {
        let core = self.core.as_mut().expect("initialized prepare core");
        let ids = core.indicators.entry_ids();
        let projections = ids
            .iter()
            .filter_map(|id| {
                core.indicators
                    .entry(&JsValue::String(id.clone()))
                    .map(|entry| crate::model_state::IndicatorProjection {
                        id: entry.id(),
                        definition: entry.definition(),
                    })
            })
            .collect::<Vec<_>>();
        let context = crate::model_state::ModelContext {
            store: core.owner.data().store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        for series in &self.spec.series {
            core.model.add_series(series, &context)?;
        }
        Ok(())
    }

    fn step_index(&mut self, max_bars: usize) -> Result<bool, JsError> {
        let core = self.core.as_mut().expect("initialized prepare core");
        let task = self.index_task.as_mut().expect("index task");
        if !task.merging && !task.finalize {
            let rows = std::cmp::max(1, max_bars / task.block_size);
            let end = std::cmp::min(task.leaves, task.next_leaf + rows);
            while task.next_leaf < end {
                let block = task.next_leaf;
                let (min, max, count) =
                    series_block_summary(core, task.series, block, task.block_size)?;
                task.builder.as_mut().expect("series index builder").leaf(
                    block,
                    min,
                    max,
                    count as f64,
                )?;
                task.next_leaf += 1;
            }
            if task.next_leaf == task.leaves {
                task.merging = true;
            }
            return Ok(false);
        }
        if task.merging {
            let stop = task.next_merge.saturating_sub(max_bars);
            while task.next_merge > stop {
                task.builder
                    .as_mut()
                    .expect("series index builder")
                    .merge(task.next_merge)?;
                task.next_merge -= 1;
            }
            if task.next_merge == 0 {
                task.merging = false;
                task.finalize = true;
            }
            return Ok(false);
        }
        let builder = task.builder.take().expect("series index builder");
        let tree = builder.finish(task.leaves)?;
        let series = &mut core.model.series[task.series];
        let id = series.id.clone();
        let prebuilt = if task.blocked {
            NativePrebuiltSeriesCache::Block {
                index: BlockRangeIndex::from_owned_tree(
                    self.spec.request.length,
                    self.spec.capacity,
                    task.block_size,
                    tree,
                )?,
            }
        } else {
            NativePrebuiltSeriesCache::Flat {
                tree,
                length: self.spec.request.length,
            }
        };
        let cache_memory = task.memory.take().expect("series index builder memory");
        core.caches.install_prebuilt_with_memory(
            &id,
            core.owner.data().store(),
            prebuilt,
            cache_memory,
        )?;
        let revision = if let Some(indicator) = &series.indicator {
            core.indicators
                .entry(&JsValue::String(indicator.clone()))
                .map(|entry| entry.revision())
                .ok_or_else(|| ordinary_error("Missing indicator"))?
        } else {
            core.owner.data().store().version()
        };
        series.revision = Some(revision);
        series.dirty_from = f64::INFINITY;
        series.range_index_ready = true;
        Ok(true)
    }

    /// ready core를 한 번만 Root/UI layer로 이동한다.
    pub fn take_prepared(&mut self) -> Result<NativePreparedCore, JsError> {
        if self.phase != PreparePhase::Ready {
            return Err(ordinary_error("Async result not ready"));
        }
        self.core
            .take()
            .ok_or_else(|| ordinary_error("Async result not ready"))
    }

    /// 현재 phase 이름이다.
    pub fn phase(&self) -> &'static str {
        self.phase.name()
    }
}

fn series_block_summary(
    core: &NativePreparedCore,
    series_index: usize,
    block: usize,
    block_size: usize,
) -> Result<(f64, f64, usize), JsError> {
    let series = &core.model.series[series_index];
    let values = if let Some(indicator) = &series.indicator {
        let entry = core
            .indicators
            .entry(&JsValue::String(indicator.clone()))
            .ok_or_else(|| ordinary_error("Missing indicator"))?;
        let output = series
            .output
            .as_ref()
            .map(JsString::to_string_lossy)
            .unwrap_or_else(|| entry.definition().outputs[0].to_owned());
        entry
            .output_capacity(&output)
            .ok_or_else(|| ordinary_error("Missing indicator output"))?
    } else {
        let raw = series.raw_record();
        let source = property(&raw, "source")
            .and_then(string)
            .map(JsString::to_string_lossy)
            .unwrap_or_else(|| "close".to_owned());
        let columns = core.owner.data().store().columns();
        match source.as_str() {
            "time" => &columns.time,
            "open" => &columns.open,
            "high" => &columns.high,
            "low" => &columns.low,
            "volume" => &columns.volume,
            _ => &columns.close,
        }
    };
    let length = core.owner.data().store().length();
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut count = 0usize;
    for value in values
        .iter()
        .take(length)
        .skip(block * block_size)
        .take(block_size)
    {
        if value.is_finite() {
            min = js_min(&[min, *value]);
            max = js_max(&[max, *value]);
            count += 1;
        }
    }
    Ok((min, max, count))
}

#[derive(Clone, Copy)]
struct BufferReference(usize);

#[derive(Clone)]
struct TreeWire {
    size: usize,
    min: BufferReference,
    max: BufferReference,
    sum: Option<BufferReference>,
    finite_counts: bool,
}

struct CorrectionStoreSpec {
    length: usize,
    options: StoreOptions,
    version: f64,
    time_version: f64,
    columns: [BufferReference; 6],
    index: TreeWire,
}

struct CorrectionIndicatorSpec {
    template: NativeIndicatorEntrySnapshot,
    arrays: Vec<BufferReference>,
    checkpoint_count: usize,
    checkpoint_size: usize,
}

enum CorrectionCacheSpec {
    Flat {
        tree: TreeWire,
    },
    Block {
        size: usize,
        length: usize,
        block_size: usize,
        tree: TreeWire,
    },
}

struct CorrectionSeriesSpec {
    options: JsValue,
    values: Option<BufferReference>,
    revision: Option<f64>,
    dirty_from: f64,
    cache: Option<CorrectionCacheSpec>,
}

struct CorrectionTargetSpec {
    event: JsValue,
    store: CorrectionStoreSpec,
    panels: JsValue,
    axes: JsValue,
    theme: JsValue,
    precision: f64,
    axis_width: f64,
    indicators: Vec<CorrectionIndicatorSpec>,
    series: Vec<CorrectionSeriesSpec>,
    engine_options: IndicatorEngineOptions,
    buffer_lengths: Vec<usize>,
}

fn parse_buffer_reference(
    value: &JsValue,
    buffer_count: usize,
) -> Result<BufferReference, JsError> {
    crate::contracts::option_record(value, &["buffer"], "Async buffer reference")?;
    let slot = safe_usize(
        number_field(value, "buffer", "Async buffer reference")?,
        buffer_count.saturating_sub(1),
        "Async buffer slot",
    )?;
    if slot >= buffer_count {
        return Err(type_error("Async buffer reference"));
    }
    Ok(BufferReference(slot))
}

fn parse_tree_wire(
    value: &JsValue,
    buffer_count: usize,
    finite_counts: bool,
) -> Result<TreeWire, JsError> {
    crate::contracts::option_record(
        value,
        &["size", "min", "max", "sum", "finiteCounts"],
        "Async index",
    )?;
    let size = safe_usize(
        number_field(value, "size", "Async index size")?,
        RESOURCE_LIMITS.max_bars as usize,
        "Async index size",
    )?;
    if size == 0 || !size.is_power_of_two() {
        return Err(type_error("Async index size"));
    }
    if !matches!(property(value, "finiteCounts"), Some(JsValue::Bool(actual)) if *actual == finite_counts)
    {
        return Err(type_error("Async finite-count cache role"));
    }
    let min = parse_buffer_reference(
        property(value, "min").ok_or_else(|| type_error("Async index buffers"))?,
        buffer_count,
    )?;
    let max = parse_buffer_reference(
        property(value, "max").ok_or_else(|| type_error("Async index buffers"))?,
        buffer_count,
    )?;
    let sum = match property(value, "sum") {
        None | Some(JsValue::Null) => None,
        Some(value) => Some(parse_buffer_reference(value, buffer_count)?),
    };
    Ok(TreeWire {
        size,
        min,
        max,
        sum,
        finite_counts,
    })
}

fn definition_matches_wire(snapshot: &NativeIndicatorEntrySnapshot, wire: &JsValue) -> bool {
    let expected = object([
        (
            "outputs",
            property(wire, "outputs")
                .cloned()
                .unwrap_or(JsValue::Undefined),
        ),
        (
            "plotOffsets",
            property(wire, "plotOffsets")
                .cloned()
                .unwrap_or(JsValue::Undefined),
        ),
    ]);
    exact_state_equal(&definition_layout(snapshot), &expected)
}

impl CorrectionTargetSpec {
    fn parse(
        text: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let metadata = safe_checkpoint_parse_with(&JsValue::String(text.clone()), dialect)?;
        crate::contracts::option_record(
            &metadata,
            &[
                "schema",
                "protocol",
                "event",
                "batchLimits",
                "store",
                "panels",
                "axes",
                "theme",
                "precision",
                "axisWidth",
                "indicators",
                "series",
                "bufferLengths",
                "maxOutputBytes",
            ],
            "Async metadata",
        )?;
        if !matches!(property(&metadata, "schema"), Some(JsValue::String(value)) if text_is(value, "aster.async.snapshot"))
            || !matches!(property(&metadata, "protocol"), Some(JsValue::Number(1.0)))
        {
            return Err(type_error("Async protocol"));
        }
        if property(&metadata, "batchLimits").is_some() {
            return Err(type_error("Async batch limits event"));
        }
        let Some(JsValue::Array(lengths)) = property(&metadata, "bufferLengths") else {
            return Err(type_error("Async protocol"));
        };
        let Some(JsValue::Array(indicator_wire)) = property(&metadata, "indicators") else {
            return Err(type_error("Async protocol"));
        };
        let Some(JsValue::Array(series_wire)) = property(&metadata, "series") else {
            return Err(type_error("Async protocol"));
        };
        if lengths.len() > ASYNC_MAX_BUFFERS
            || indicator_wire.len() > ASYNC_MAX_INDICATORS
            || series_wire.len() > ASYNC_MAX_SERIES
        {
            return Err(type_error("Async protocol"));
        }
        let mut bytes = 0usize;
        let buffer_lengths = lengths
            .iter()
            .map(|value| {
                let JsValue::Number(value) = value else {
                    return Err(range_error("Async buffer"));
                };
                let length = safe_usize(
                    *value,
                    RESOURCE_LIMITS.max_bars as usize * 2,
                    "Async buffer",
                )?;
                bytes = bytes
                    .checked_add(length.saturating_mul(8))
                    .ok_or_else(|| range_error("Async buffer bytes"))?;
                if bytes > ASYNC_SNAPSHOT_BYTES {
                    return Err(range_error("Async buffer bytes"));
                }
                Ok(length)
            })
            .collect::<Result<Vec<_>, JsError>>()?;
        let max_output_bytes = safe_usize(
            number_field(&metadata, "maxOutputBytes", "Async output budget")?,
            ASYNC_SNAPSHOT_BYTES,
            "Async output budget",
        )?;
        let store_wire =
            property(&metadata, "store").ok_or_else(|| type_error("Async protocol"))?;
        crate::contracts::option_record(
            store_wire,
            &[
                "length",
                "capacity",
                "maxBars",
                "timeframeMs",
                "timeOrigin",
                "version",
                "timeVersion",
                "columns",
                "index",
            ],
            "Async store",
        )?;
        let max_bars = safe_usize(
            number_field(store_wire, "maxBars", "Async max bars")?,
            RESOURCE_LIMITS.max_bars as usize,
            "Async max bars",
        )?;
        let capacity = safe_usize(
            number_field(store_wire, "capacity", "Async capacity")?,
            RESOURCE_LIMITS.max_bars as usize,
            "Async capacity",
        )?;
        let length = safe_usize(
            number_field(store_wire, "length", "Async length")?,
            std::cmp::min(capacity, max_bars),
            "Async length",
        )?;
        if capacity < 16 || !capacity.is_power_of_two() || length > capacity {
            return Err(type_error("Async capacity"));
        }
        let timeframe_ms = number_field(store_wire, "timeframeMs", "Async store")?;
        let time_origin = number_field(store_wire, "timeOrigin", "Async store")?;
        let version = number_field(store_wire, "version", "Async revision")?;
        let time_version = number_field(store_wire, "timeVersion", "Async revision")?;
        if !timeframe_ms.is_finite()
            || timeframe_ms <= 0.0
            || !time_origin.is_finite()
            || !exact_integer(version, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(time_version, 0.0, MAX_SAFE_INTEGER)
        {
            return Err(type_error("Async store"));
        }
        let columns_wire =
            property(store_wire, "columns").ok_or_else(|| type_error("Async column length"))?;
        let columns = ["time", "open", "high", "low", "close", "volume"]
            .map(|name| {
                parse_buffer_reference(
                    property(columns_wire, name)
                        .ok_or_else(|| type_error("Async buffer reference"))?,
                    buffer_lengths.len(),
                )
            })
            .into_iter()
            .collect::<Result<Vec<_>, JsError>>()?;
        let columns: [BufferReference; 6] = columns
            .try_into()
            .map_err(|_| type_error("Async column length"))?;
        if columns
            .iter()
            .any(|reference| buffer_lengths[reference.0] != capacity)
        {
            return Err(type_error("Async column length"));
        }
        let index = parse_tree_wire(
            property(store_wire, "index").ok_or_else(|| type_error("Async OHLC index"))?,
            buffer_lengths.len(),
            false,
        )?;
        if index.size != capacity || index.sum.is_none() {
            return Err(type_error("Async OHLC index"));
        }
        let store = CorrectionStoreSpec {
            length,
            options: StoreOptions {
                timeframe_ms,
                time_origin,
                max_bars,
            },
            version,
            time_version,
            columns,
            index,
        };
        let engine_options = IndicatorEngineOptions {
            checkpoint_size: indicator_wire
                .first()
                .map(|row| {
                    safe_usize(
                        number_field(row, "checkpointSize", "Async checkpoint size")?,
                        RESOURCE_LIMITS.max_bars as usize + 1,
                        "Async checkpoint size",
                    )
                })
                .transpose()?
                .unwrap_or(256),
            max_output_bytes,
        };
        if engine_options.checkpoint_size == 0 {
            return Err(type_error("Async checkpoint size"));
        }
        let probe_data = ModelDataState::new(StoreOptions::default(), Vec::new())?;
        let mut probe = IndicatorEngine::new_with_memory(engine_options, memory.clone())?;
        let mut parsed_indicators = Vec::with_capacity(indicator_wire.len());
        for wire in indicator_wire {
            crate::contracts::option_record(
                wire,
                &[
                    "id",
                    "name",
                    "params",
                    "module",
                    "outputs",
                    "plotOffsets",
                    "arrays",
                    "checkpointCount",
                    "checkpointSize",
                    "revision",
                    "dirty",
                    "dirtyTo",
                    "invalidated",
                    "length",
                    "computedFrom",
                    "computedUntil",
                    "entry",
                ],
                "Async indicator metadata",
            )?;
            let id = property(wire, "id").cloned().unwrap_or(JsValue::Undefined);
            let name = property(wire, "name")
                .cloned()
                .unwrap_or(JsValue::Undefined);
            let params = property(wire, "params")
                .cloned()
                .unwrap_or(JsValue::Undefined);
            let name_text =
                string(&name).ok_or_else(|| type_error("Async indicator definition"))?;
            validate_indicator_module_binding(name_text, property(wire, "module"))?;
            probe.add(probe_data.store(), host, &id, &name, &params)?;
            let (_, mut captured, capture_memory) =
                probe.capture_native_entries_with_memory(probe_data.store(), memory)?;
            let mut template = captured
                .pop()
                .ok_or_else(|| type_error("Async indicator definition"))?;
            drop(capture_memory);
            template.arrays = Vec::new();
            if !definition_matches_wire(&template, wire)
                || !exact_state_equal(&template.params, &params)
            {
                return Err(type_error("Async output definition"));
            }
            let Some(JsValue::Array(array_wire)) = property(wire, "arrays") else {
                return Err(type_error("Async indicator shape"));
            };
            if array_wire.len() != template.definition.outputs.len() {
                return Err(type_error("Async output definition"));
            }
            let arrays = array_wire
                .iter()
                .map(|value| parse_buffer_reference(value, buffer_lengths.len()))
                .collect::<Result<Vec<_>, JsError>>()?;
            if arrays
                .iter()
                .any(|reference| buffer_lengths[reference.0] != capacity)
            {
                return Err(type_error("Async output definition"));
            }
            let checkpoint_size = safe_usize(
                number_field(wire, "checkpointSize", "Async checkpoint size")?,
                RESOURCE_LIMITS.max_bars as usize + 1,
                "Async checkpoint size",
            )?;
            if checkpoint_size != engine_options.checkpoint_size {
                return Err(type_error("Async checkpoint size"));
            }
            let checkpoint_count = safe_usize(
                number_field(wire, "checkpointCount", "Async indicator checkpointCount")?,
                RESOURCE_LIMITS.max_bars as usize + 1,
                "Async indicator checkpointCount",
            )?;
            template.revision = number_field(wire, "revision", "Async indicator revision")?;
            if !exact_integer(template.revision, 0.0, MAX_SAFE_INTEGER) {
                return Err(range_error("Async indicator revision"));
            }
            let dirty = number_field(wire, "dirty", "Async dirty")?;
            template.dirty = if dirty == f64::INFINITY {
                length
            } else {
                safe_usize(dirty, RESOURCE_LIMITS.max_bars as usize, "Async dirty")?
            };
            template.dirty_to = Some(safe_usize(
                number_field(wire, "dirtyTo", "Async indicator dirtyTo")?,
                RESOURCE_LIMITS.max_bars as usize + 1,
                "Async indicator dirtyTo",
            )?);
            template.invalidated = match property(wire, "invalidated") {
                Some(JsValue::Bool(value)) => *value,
                _ => return Err(type_error("Async indicator shape")),
            };
            template.length = safe_usize(
                number_field(wire, "length", "Async indicator length")?,
                RESOURCE_LIMITS.max_bars as usize + 1,
                "Async indicator length",
            )?;
            template.computed_from = Some(safe_usize(
                number_field(wire, "computedFrom", "Async indicator computedFrom")?,
                RESOURCE_LIMITS.max_bars as usize + 1,
                "Async indicator computedFrom",
            )?);
            template.computed_until = Some(safe_usize(
                number_field(wire, "computedUntil", "Async indicator computedUntil")?,
                RESOURCE_LIMITS.max_bars as usize + 1,
                "Async indicator computedUntil",
            )?);
            template.prepared_version = None;
            parsed_indicators.push(CorrectionIndicatorSpec {
                template,
                arrays,
                checkpoint_count,
                checkpoint_size,
            });
        }
        let mut output_bytes = 0usize;
        for indicator in &parsed_indicators {
            output_bytes = output_bytes
                .checked_add(
                    indicator
                        .arrays
                        .len()
                        .saturating_mul(capacity)
                        .saturating_mul(8),
                )
                .ok_or_else(|| range_error("Async output bytes"))?;
        }
        if output_bytes > max_output_bytes {
            return Err(range_error("Async output bytes"));
        }
        let mut parsed_series = Vec::with_capacity(series_wire.len());
        for row in series_wire {
            crate::contracts::option_record(
                row,
                &["options", "revision", "dirtyFrom", "index"],
                "Async series metadata",
            )?;
            let mut options = property(row, "options")
                .cloned()
                .ok_or_else(|| type_error("Async series output"))?;
            let values = match &mut options {
                JsValue::Object(record) => record
                    .remove(&key("values"))
                    .map(|value| parse_buffer_reference(&value, buffer_lengths.len()))
                    .transpose()?,
                _ => return Err(type_error("Async series output")),
            };
            if let Some(reference) = values
                && buffer_lengths[reference.0] != length
            {
                return Err(type_error("Async series output"));
            }
            let revision = match property(row, "revision") {
                None | Some(JsValue::Undefined) => None,
                Some(JsValue::Number(value)) => Some(*value),
                _ => return Err(type_error("Async series metadata")),
            };
            let dirty_from = number_field(row, "dirtyFrom", "Async series metadata")?;
            let cache = match property(row, "index") {
                None | Some(JsValue::Null) => None,
                Some(value) => {
                    crate::contracts::option_record(
                        value,
                        &[
                            "blocked",
                            "finiteCounts",
                            "size",
                            "length",
                            "blockSize",
                            "tree",
                        ],
                        "Async series cache",
                    )?;
                    if !matches!(property(value, "finiteCounts"), Some(JsValue::Bool(true))) {
                        return Err(type_error("Async finite-count cache marker"));
                    }
                    match property(value, "blocked") {
                        Some(JsValue::Bool(false)) => Some(CorrectionCacheSpec::Flat {
                            tree: parse_tree_wire(
                                property(value, "tree")
                                    .ok_or_else(|| type_error("Async index buffers"))?,
                                buffer_lengths.len(),
                                true,
                            )?,
                        }),
                        Some(JsValue::Bool(true)) => Some(CorrectionCacheSpec::Block {
                            size: safe_usize(
                                number_field(value, "size", "Async block index")?,
                                RESOURCE_LIMITS.max_bars as usize,
                                "Async cached capacity",
                            )?,
                            length: safe_usize(
                                number_field(value, "length", "Async block index")?,
                                RESOURCE_LIMITS.max_bars as usize,
                                "Async block index",
                            )?,
                            block_size: safe_usize(
                                number_field(value, "blockSize", "Async block index")?,
                                RESOURCE_LIMITS.max_bars as usize,
                                "Async block index",
                            )?,
                            tree: parse_tree_wire(
                                property(value, "tree")
                                    .ok_or_else(|| type_error("Async block tree"))?,
                                buffer_lengths.len(),
                                false,
                            )?,
                        }),
                        _ => return Err(type_error("Async finite-count cache marker")),
                    }
                }
            };
            parsed_series.push(CorrectionSeriesSpec {
                options,
                values,
                revision,
                dirty_from,
                cache,
            });
        }
        Ok(Self {
            event: property(&metadata, "event")
                .cloned()
                .ok_or_else(|| type_error("Async data event kind"))?,
            store,
            panels: property(&metadata, "panels")
                .cloned()
                .ok_or_else(|| type_error("Async protocol"))?,
            axes: property(&metadata, "axes")
                .cloned()
                .unwrap_or_else(|| JsValue::Array(Vec::new())),
            theme: property(&metadata, "theme")
                .cloned()
                .ok_or_else(|| type_error("Async protocol"))?,
            precision: number_field(&metadata, "precision", "Async protocol")?,
            axis_width: number_field(&metadata, "axisWidth", "Async protocol")?,
            indicators: parsed_indicators,
            series: parsed_series,
            engine_options,
            buffer_lengths,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CorrectionPhase {
    Capture,
    Calculate,
    Indices,
    Ready,
}

/// Actual correction target state machine다.
pub struct NativeCorrectionTarget {
    spec: CorrectionTargetSpec,
    dialect: NumberDialect,
    memory: MemoryContext,
    buffers: Vec<Option<Vec<f64>>>,
    buffer_memory: Vec<Option<MemoryGroup>>,
    received: Vec<usize>,
    checkpoint_maps: Vec<NativeCheckpointMap>,
    phase: CorrectionPhase,
    core: Option<NativePreparedCore>,
    entry: usize,
    calculation: Option<IndicatorCalculation>,
    series: usize,
}

impl NativeCorrectionTarget {
    /// Async snapshot metadata를 검증하고 transfer buffers/checkpoint ledgers를 할당한다.
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

    /// Correction target을 explicit engine memory context에 연결한다.
    pub fn new_with_memory(
        metadata: &JsString,
        dialect: NumberDialect,
        host: &dyn Host,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        let spec = CorrectionTargetSpec::parse(metadata, dialect, host, &memory)?;
        let budget =
            NativeCheckpointBudget::new_with_memory(NATIVE_CHECKPOINT_TOTAL_BYTES, memory.clone())?;
        let checkpoint_maps = spec
            .indicators
            .iter()
            .map(|indicator| {
                NativeCheckpointMap::new(
                    indicator.template.definition.program,
                    indicator.template.definition.params.clone(),
                    budget.clone(),
                    indicator.checkpoint_size,
                )
            })
            .collect::<Result<Vec<_>, JsError>>()?;
        let mut buffers = Vec::new();
        let mut buffer_memory = Vec::new();
        buffers
            .try_reserve_exact(spec.buffer_lengths.len())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        buffer_memory
            .try_reserve_exact(spec.buffer_lengths.len())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        for length in &spec.buffer_lengths {
            let (values, values_memory) = memory
                .try_vec_filled(*length, 0.0)
                .map_err(|failure| failure.into_js_error())?;
            buffers.push(Some(values));
            buffer_memory.push(Some(values_memory));
        }
        let received = vec![0; spec.buffer_lengths.len()];
        Ok(Self {
            spec,
            dialect,
            memory,
            buffers,
            buffer_memory,
            received,
            checkpoint_maps,
            phase: CorrectionPhase::Capture,
            core: None,
            entry: 0,
            calculation: None,
            series: 0,
        })
    }

    /// Host가 buffer slot을 정확히 한 번의 연속 prefix로 채운다.
    pub fn target(&mut self, slot: f64, offset: f64, count: f64) -> Result<&mut [f64], JsError> {
        if self.phase != CorrectionPhase::Capture
            || !exact_integer(slot, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(offset, 0.0, MAX_SAFE_INTEGER)
            || !exact_integer(count, 1.0, ASYNC_BUFFER_SLICE as f64)
        {
            return Err(range_error("Async target slice"));
        }
        let slot = slot as usize;
        let Some(buffer) = self.buffers.get_mut(slot).and_then(Option::as_mut) else {
            return Err(range_error("Async target slice"));
        };
        if offset as usize != self.received[slot] || offset + count > buffer.len() as f64 {
            return Err(range_error("Async target slice"));
        }
        self.received[slot] += count as usize;
        Ok(&mut buffer[offset as usize..(offset + count) as usize])
    }

    /// 한 indicator의 checkpoint row chunk를 순서대로 검증/과금한다.
    pub fn checkpoint(&mut self, entry: f64, text: &JsString) -> Result<(), JsError> {
        if self.phase != CorrectionPhase::Capture || !exact_integer(entry, 0.0, MAX_SAFE_INTEGER) {
            return Err(type_error("Async checkpoint rows"));
        }
        let entry = entry as usize;
        let Some(spec) = self.spec.indicators.get(entry) else {
            return Err(type_error("Async checkpoint rows"));
        };
        let Some(map) = self.checkpoint_maps.get_mut(entry) else {
            return Err(type_error("Async checkpoint rows"));
        };
        let mut scope = self.memory.scope();
        let parse_text = text
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let rows =
            safe_checkpoint_parse_scoped(&JsValue::String(parse_text), self.dialect, &mut scope)?;
        let JsValue::Array(rows) = &rows else {
            return Err(type_error("Async checkpoint rows"));
        };
        if rows.is_empty() || rows.len() > 64 {
            return Err(type_error("Async checkpoint rows"));
        }
        for row in rows {
            let JsValue::Array(row) = row else {
                return Err(type_error("Async checkpoint order/history"));
            };
            if row.len() != 2 {
                return Err(type_error("Async checkpoint order/history"));
            }
            let expected = map.size() * spec.checkpoint_size;
            if !matches!(row[0], JsValue::Number(value) if value == expected as f64 && value <= spec.template.length as f64)
            {
                return Err(type_error("Async checkpoint order/history"));
            }
            let state = row[1]
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            map.set(expected as f64, state)?;
        }
        if map.size() > spec.checkpoint_count {
            return Err(range_error("Async checkpoint count"));
        }
        Ok(())
    }

    /// 모든 transfer payload를 실제 store/engine/model/cache로 O(1) 채택한 뒤 event를 적용한다.
    pub fn start(&mut self, serial: f64) -> Result<(), JsError> {
        if self.phase != CorrectionPhase::Capture
            || self
                .received
                .iter()
                .zip(&self.spec.buffer_lengths)
                .any(|(received, length)| received != length)
        {
            return Err(ordinary_error("Async incomplete buffer capture"));
        }
        if !exact_integer(serial, 1.0, MAX_SAFE_INTEGER) {
            return Err(range_error("Workspace store serial"));
        }
        for (spec, map) in self.spec.indicators.iter().zip(&self.checkpoint_maps) {
            if map.size() != spec.checkpoint_count
                || spec.checkpoint_count > 0
                    && spec.checkpoint_count != spec.template.length / spec.checkpoint_size + 1
            {
                return Err(type_error("Async checkpoint completeness"));
            }
            map.validate_history(spec.template.length as f64)?;
        }
        self.initialize_core(serial)?;
        self.phase = CorrectionPhase::Calculate;
        Ok(())
    }

    fn take_buffer(
        &mut self,
        reference: BufferReference,
    ) -> Result<(Vec<f64>, MemoryGroup), JsError> {
        let buffer = self
            .buffers
            .get_mut(reference.0)
            .and_then(Option::take)
            .ok_or_else(|| type_error("Async buffer reference"))?;
        let memory = self
            .buffer_memory
            .get_mut(reference.0)
            .and_then(Option::take)
            .ok_or_else(|| type_error("Async buffer memory"))?;
        let expected = buffer
            .capacity()
            .checked_mul(std::mem::size_of::<f64>())
            .ok_or_else(|| type_error("Async buffer memory"))?;
        if memory.requested_bytes() != expected as u64 {
            return Err(type_error("Async buffer memory"));
        }
        Ok((buffer, memory))
    }

    fn take_tree(
        &mut self,
        wire: &TreeWire,
        count_limit: Option<usize>,
    ) -> Result<(crate::range_index::RangeIndex, MemoryGroup), JsError> {
        let (min, mut memory) = self.take_buffer(wire.min)?;
        let (max, max_memory) = self.take_buffer(wire.max)?;
        memory
            .absorb(max_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (sum, sum_memory) = wire
            .sum
            .map(|reference| self.take_buffer(reference))
            .transpose()?
            .map_or((None, None), |(values, memory)| {
                (Some(values), Some(memory))
            });
        if let Some(sum_memory) = sum_memory {
            memory
                .absorb(sum_memory)
                .map_err(|failure| failure.into_js_error())?;
        }
        let tree = crate::range_index::RangeIndex::from_native_buffers(
            wire.size,
            min,
            max,
            sum,
            wire.finite_counts,
        )?;
        if let Some(limit) = count_limit {
            tree.validate_native_count_tree(limit)?;
        }
        Ok((tree, memory))
    }

    fn initialize_core(&mut self, serial: f64) -> Result<(), JsError> {
        let column_refs = self.spec.store.columns;
        let (time, mut store_memory) = self.take_buffer(column_refs[0])?;
        let (open, open_memory) = self.take_buffer(column_refs[1])?;
        store_memory
            .absorb(open_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (high, high_memory) = self.take_buffer(column_refs[2])?;
        store_memory
            .absorb(high_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (low, low_memory) = self.take_buffer(column_refs[3])?;
        store_memory
            .absorb(low_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (close, close_memory) = self.take_buffer(column_refs[4])?;
        store_memory
            .absorb(close_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (volume, volume_memory) = self.take_buffer(column_refs[5])?;
        store_memory
            .absorb(volume_memory)
            .map_err(|failure| failure.into_js_error())?;
        let columns = Columns {
            time,
            open,
            high,
            low,
            close,
            volume,
        };
        let store_index_wire = self.spec.store.index.clone();
        let store_sum_slot = store_index_wire.sum.map(|reference| reference.0);
        let (store_index, index_memory) = self.take_tree(&store_index_wire, None)?;
        store_memory
            .absorb(index_memory)
            .map_err(|failure| failure.into_js_error())?;
        let data = ModelDataState::from_validated_native_snapshot_columns_with_memory(
            serial,
            self.spec.store.options,
            columns,
            store_index,
            self.spec.store.length,
            self.spec.store.version,
            self.spec.store.time_version,
            store_memory,
        )?;
        let owner = IngestionOwner::new(data, self.dialect);
        let options = object([
            ("panels", self.spec.panels.clone()),
            ("axes", self.spec.axes.clone()),
            ("theme", self.spec.theme.clone()),
            ("precision", JsValue::Number(self.spec.precision)),
            ("axisWidth", JsValue::Number(self.spec.axis_width)),
        ]);
        let mut model = ModelState::new(owner.data().store(), &options)?;
        let indicator_specs = std::mem::take(&mut self.spec.indicators);
        let maps = std::mem::take(&mut self.checkpoint_maps);
        let mut templates = Vec::with_capacity(indicator_specs.len());
        let mut indicator_memory = MemoryGroup::empty(self.memory.clone());
        let mut checkpoint_transfers = Vec::with_capacity(indicator_specs.len());
        for (mut spec, mut map) in indicator_specs.into_iter().zip(maps) {
            let mut arrays = Vec::new();
            arrays
                .try_reserve_exact(spec.arrays.len())
                .map_err(|_| self.memory.allocation_failure().into_js_error())?;
            for reference in &spec.arrays {
                let (values, values_memory) = self.take_buffer(*reference)?;
                indicator_memory
                    .absorb(values_memory)
                    .map_err(|failure| failure.into_js_error())?;
                arrays.push(values);
            }
            spec.template.arrays = arrays;
            let (checkpoints, checkpoints_memory) = map.publish_entries_accounted()?;
            checkpoint_transfers.push((spec.template.id.clone(), checkpoints, checkpoints_memory));
            // Install the fallible sorted entries after the empty-entry restore stage. Converting
            // them through a compatibility BTreeMap would allocate unaccounted nodes and lose the
            // exact moved group.
            spec.template.checkpoints = std::collections::BTreeMap::new();
            templates.push(spec.template);
        }
        let mut engine =
            IndicatorEngine::new_with_memory(self.spec.engine_options, self.memory.clone())?;
        let stage = engine.stage_native_restore_with_memory(
            owner.data().store(),
            templates,
            indicator_memory,
        )?;
        engine.publish_native_restore(owner.data().store(), stage)?;
        for (id, checkpoints, checkpoints_memory) in checkpoint_transfers {
            engine.install_checkpoint_entries_with_memory(
                &JsValue::String(id),
                checkpoints,
                None,
                checkpoints_memory,
            )?;
        }
        let ids = engine.entry_ids();
        let projections = ids
            .iter()
            .filter_map(|id| {
                engine.entry(&JsValue::String(id.clone())).map(|entry| {
                    crate::model_state::IndicatorProjection {
                        id: entry.id(),
                        definition: entry.definition(),
                    }
                })
            })
            .collect::<Vec<_>>();
        let context = crate::model_state::ModelContext {
            store: owner.data().store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        let series_specs = std::mem::take(&mut self.spec.series);
        let mut caches = SeriesCaches::new_with_memory(self.memory.clone());
        let store = owner.data().store();
        for mut spec in series_specs {
            let values_ref = spec.values;
            let values = values_ref
                .map(|reference| self.take_buffer(reference))
                .transpose()?;
            let id = match values {
                Some((values, values_memory)) => model.add_series_with_owned_values(
                    &spec.options,
                    values,
                    values_memory,
                    &context,
                )?,
                None => model.add_series(&spec.options, &context)?,
            };
            let series = model
                .series
                .iter_mut()
                .find(|series| series.id == id)
                .expect("new series exists");
            series.revision = spec.revision;
            series.dirty_from = spec.dirty_from;
            if let Some(cache) = spec.cache.take() {
                let (prebuilt, cache_memory) = match cache {
                    CorrectionCacheSpec::Flat { tree } => {
                        if tree
                            .sum
                            .is_some_and(|reference| Some(reference.0) == store_sum_slot)
                        {
                            return Err(type_error("Async finite-count cache aliases volume"));
                        }
                        let (tree, memory) = self.take_tree(&tree, Some(1))?;
                        (
                            NativePrebuiltSeriesCache::Flat {
                                tree,
                                length: store.length(),
                            },
                            memory,
                        )
                    }
                    CorrectionCacheSpec::Block {
                        size,
                        length,
                        block_size,
                        tree,
                    } => {
                        if tree
                            .sum
                            .is_some_and(|reference| Some(reference.0) == store_sum_slot)
                        {
                            return Err(type_error("Async finite-count cache aliases volume"));
                        }
                        let (tree, memory) = self.take_tree(&tree, Some(32))?;
                        let index =
                            BlockRangeIndex::from_native_tree(size, length, block_size, tree)?;
                        (NativePrebuiltSeriesCache::Block { index }, memory)
                    }
                };
                caches.install_prebuilt_with_memory(
                    &id,
                    owner.data().store(),
                    prebuilt,
                    cache_memory,
                )?;
            }
        }
        let bar = bar_from_event(&self.spec.event, owner.data())?;
        let mut owner = owner;
        let committed = owner
            .data_mut()
            .store_mut()
            .apply_event(DataEvent::Correction(bar), &BatchOptions::empty())?;
        if let Some(change) = committed.change.as_ref() {
            engine.apply_change(owner.data().store(), change);
            model.on_store_change(owner.data().store(), change);
        }
        self.core = Some(NativePreparedCore {
            owner,
            model,
            indicators: engine,
            caches,
            prepared_input: JsValue::Undefined,
        });
        Ok(())
    }

    /// Indicator calculation/series cache update를 source와 같은 phase로 한 step 처리한다.
    pub fn step(&mut self, max_bars: f64, host: &dyn Host) -> Result<NativeJobProgress, JsError> {
        if !exact_integer(max_bars, 1.0, 65_536.0) {
            return Err(range_error("Async calculation work size"));
        }
        if self.phase == CorrectionPhase::Capture {
            return Err(ordinary_error("Async calculation not started"));
        }
        let max_bars = max_bars as usize;
        if self.phase == CorrectionPhase::Calculate {
            let core = self.core.as_mut().expect("initialized correction core");
            let ids = core.indicators.entry_ids();
            if self.entry < ids.len() {
                if self.calculation.is_none() {
                    self.calculation = Some(
                        core.indicators
                            .calculate(JsValue::String(ids[self.entry].clone()), max_bars as f64),
                    );
                }
                let step = self.calculation.as_mut().expect("calculation token").step(
                    &mut core.indicators,
                    core.owner.data().store(),
                    host,
                )?;
                if matches!(
                    step,
                    CalculationStep::Complete { .. } | CalculationStep::Exhausted
                ) {
                    self.calculation = None;
                    self.entry += 1;
                }
                return Ok(NativeJobProgress {
                    phase: "calculate",
                    done: self.entry,
                    total: ids.len(),
                    complete: false,
                });
            }
            self.phase = CorrectionPhase::Indices;
        }
        if self.phase == CorrectionPhase::Indices {
            let total = self
                .core
                .as_ref()
                .expect("initialized correction core")
                .model
                .series
                .len();
            if self.series < total {
                let kind = self
                    .core
                    .as_ref()
                    .expect("initialized correction core")
                    .model
                    .series[self.series]
                    .kind;
                if !matches!(
                    kind,
                    crate::model_state::SeriesKind::Candles | crate::model_state::SeriesKind::Ohlc
                ) {
                    refresh_series_cache(
                        self.core.as_mut().expect("initialized correction core"),
                        self.series,
                    )?;
                }
                self.series += 1;
                return Ok(NativeJobProgress {
                    phase: "indices",
                    done: self.series,
                    total,
                    complete: false,
                });
            }
            self.phase = CorrectionPhase::Ready;
        }
        Ok(NativeJobProgress {
            phase: "ready",
            done: 1,
            total: 1,
            complete: true,
        })
    }

    /// ready core를 Root/UI layer로 한 번 이동한다.
    pub fn take_prepared(&mut self) -> Result<NativePreparedCore, JsError> {
        if self.phase != CorrectionPhase::Ready {
            return Err(ordinary_error("Async result not ready"));
        }
        self.core
            .take()
            .ok_or_else(|| ordinary_error("Async result not ready"))
    }
}

fn refresh_series_cache(core: &mut NativePreparedCore, series_index: usize) -> Result<(), JsError> {
    let store = core.owner.data().store();
    let identity = store.data_identity();
    let series = &mut core.model.series[series_index];
    let (values, revision, computed_from, computed_until, indicator) =
        if let Some(indicator_id) = &series.indicator {
            let entry = core
                .indicators
                .entry(&JsValue::String(indicator_id.clone()))
                .ok_or_else(|| ordinary_error("Missing indicator"))?;
            let output = series
                .output
                .as_ref()
                .map(JsString::to_string_lossy)
                .unwrap_or_else(|| entry.definition().outputs[0].to_owned());
            (
                entry
                    .output_capacity(&output)
                    .ok_or_else(|| ordinary_error("Missing indicator output"))?,
                entry.revision(),
                entry.computed_from().unwrap_or(0) as f64,
                entry.computed_until().unwrap_or(store.length()),
                true,
            )
        } else if let Some(values) = series.values.as_deref() {
            (
                values,
                series.values_revision.unwrap_or(0.0),
                series.dirty_from,
                store.length(),
                false,
            )
        } else {
            let raw = series.raw_record();
            let source = property(&raw, "source")
                .and_then(string)
                .map(JsString::to_string_lossy)
                .unwrap_or_else(|| "close".to_owned());
            let columns = store.columns();
            let values = match source.as_str() {
                "time" => &columns.time,
                "open" => &columns.open,
                "high" => &columns.high,
                "low" => &columns.low,
                "volume" => &columns.volume,
                _ => &columns.close,
            };
            (
                values.as_slice(),
                store.version(),
                series.dirty_from,
                store.length(),
                false,
            )
        };
    core.caches.query_series(
        &series.id,
        indicator,
        &mut series.revision,
        &mut series.dirty_from,
        &mut series.range_index_ready,
        store,
        &identity,
        values,
        revision,
        computed_from,
        computed_until,
        0,
        store.length(),
    )?;
    Ok(())
}
