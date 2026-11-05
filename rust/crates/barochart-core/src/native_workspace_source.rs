//! 실제 chart 구성요소를 빌려 admission/copy하는 native workspace source leaf다.

#![forbid(unsafe_code)]

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::{MemoryContext, MemoryGroup};
use barochart_js::string::JsString;

use crate::checkpoint_codec::safe_checkpoint_stringify_scoped;
use crate::data::{DataIdentity, StoreOptions};
use crate::drawing_types::Drawing;
use crate::drawings::DrawingWorkspaceCaptureToken;
use crate::indicator_engine::EngineEntryCaptureToken;
use crate::markets::Symbol;
use crate::model_state::ModelWorkspaceCaptureToken;
use crate::native_checkpoints::native_checkpoint_footprint;
use crate::native_workspace::{
    NATIVE_WORKSPACE_RESTORE_BYTES, NATIVE_WORKSPACE_SLICE, NativeWorkspacePlan,
    NativeWorkspaceSize, number, object, ordinary_error, range_error, text, type_error,
};
use crate::series_cache::{SeriesCaches, SeriesCachesCaptureToken};
use crate::workspace::{
    WorkspaceContext, WorkspaceInteraction, WorkspaceSymbol, js_string_heap_bytes,
    js_value_heap_bytes, preflight_workspace_with_memory, read_workspace_document_with_memory,
    workspace_binding_scoped,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourcePhase {
    Admission,
    Copy,
}

type DrawingFrames = Vec<Vec<Arc<Drawing>>>;

/// 한 admission step의 host-visible progress다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeWorkspaceSourceProgress {
    pub phase: &'static str,
    pub done: usize,
    pub complete: bool,
    include_done: bool,
}

impl NativeWorkspaceSourceProgress {
    pub fn to_value(&self) -> JsValue {
        let mut fields = vec![("phase", text(self.phase))];
        if self.include_done {
            fields.push(("done", number(self.done)));
        }
        fields.push(("complete", JsValue::Bool(self.complete)));
        let mut value = barochart_js::json::JsObject::new();
        for (name, child) in fields {
            value.insert(JsString::from_str(name), child);
        }
        JsValue::Object(value)
    }
}

/// Source finish receipt에서 Root가 ticket만 덧붙이는 leaf 부분이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeWorkspaceSourceReceipt {
    pub revision: u64,
    pub source_version: u64,
    pub source_bytes: usize,
    pub checkpoint_bytes: usize,
    pub drawing_bytes: usize,
}

impl NativeWorkspaceSourceReceipt {
    pub fn to_value(&self) -> JsValue {
        object([
            ("schema", text("aster.native-workspace-source-finished")),
            ("version", JsValue::Number(1.0)),
            ("revision", JsValue::Number(self.revision as f64)),
            ("sourceVersion", JsValue::Number(self.source_version as f64)),
            ("sourceBytes", number(self.source_bytes)),
            ("checkpointBytes", number(self.checkpoint_bytes)),
            ("drawingBytes", number(self.drawing_bytes)),
        ])
    }
}

struct CapturedSymbol {
    symbol: Symbol,
    provider: Option<JsString>,
    adjustment_version: Option<JsString>,
    _memory: MemoryGroup,
}

struct SourceFingerprint {
    data_identity: DataIdentity,
    serial_bits: u64,
    version_bits: u64,
    time_version_bits: u64,
    length: usize,
    capacity: usize,
    options: StoreOptions,
    model: ModelWorkspaceCaptureToken,
    engine: EngineEntryCaptureToken,
    series_caches: Option<SeriesCachesCaptureToken>,
    drawings: DrawingWorkspaceCaptureToken,
    symbol: Option<CapturedSymbol>,
    symbol_formatters: bool,
    interaction: WorkspaceInteraction,
}

impl SourceFingerprint {
    fn capture(
        context: &WorkspaceContext<'_>,
        series_caches: Option<&SeriesCaches>,
    ) -> Result<Self, JsError> {
        Ok(Self {
            data_identity: context.store.data_identity(),
            serial_bits: context.store.serial().to_bits(),
            version_bits: context.store.version().to_bits(),
            time_version_bits: context.store.time_version().to_bits(),
            length: context.store.length(),
            capacity: context.store.capacity(),
            options: context.store.store_options(),
            model: context.model.capture_workspace_state(),
            engine: context.indicators.capture_entries(),
            series_caches: series_caches.map(SeriesCaches::capture_token),
            drawings: context.drawings.capture_workspace_state()?,
            symbol: context
                .symbol
                .map(|value| capture_symbol(value, context.store.memory_context()))
                .transpose()?,
            symbol_formatters: context.symbol_formatters,
            interaction: context.interaction,
        })
    }

    fn matches(
        &self,
        context: &WorkspaceContext<'_>,
        series_caches: Option<&SeriesCaches>,
    ) -> Result<bool, JsError> {
        let identity = context.store.data_identity();
        let options = context.store.store_options();
        Ok(self.data_identity.matches(&identity)
            && self.serial_bits == context.store.serial().to_bits()
            && self.version_bits == context.store.version().to_bits()
            && self.time_version_bits == context.store.time_version().to_bits()
            && self.length == context.store.length()
            && self.capacity == context.store.capacity()
            && same_options(self.options, options)
            && context.model.validate_workspace_state(&self.model)
            && context.indicators.validate_capture(&self.engine)
            && match (&self.series_caches, series_caches) {
                (Some(token), Some(caches)) => caches.validate_capture(token),
                (None, None) => true,
                _ => false,
            }
            && context.drawings.validate_workspace_state(&self.drawings)
            && same_symbol(self.symbol.as_ref(), context.symbol)
            && self.symbol_formatters == context.symbol_formatters
            && self.interaction.gesture_active == context.interaction.gesture_active
            && self.interaction.pointer_count == context.interaction.pointer_count)
    }
}

/// Source runtime의 admission과 순차 column cursor를 소유한다.
pub struct NativeWorkspaceSource {
    revision: u64,
    max_bytes: usize,
    size: NativeWorkspaceSize,
    phase: SourcePhase,
    closed: bool,
    fingerprint: SourceFingerprint,
    document: JsValue,
    binding: JsValue,
    checkpoint_rows: Vec<(JsString, usize)>,
    checkpoint_entry: usize,
    checkpoint_row: usize,
    checkpoint_last_key: Option<usize>,
    frames: Vec<Vec<Arc<Drawing>>>,
    frame_at: usize,
    drawing_at: usize,
    seen_drawings: Vec<Arc<Drawing>>,
    record_count: usize,
    drawing_count: usize,
    offsets: [usize; 6],
    source_bytes: usize,
    checkpoint_bytes: usize,
    drawing_bytes: usize,
    ingestion_document: Option<JsString>,
    metadata_json: Option<JsString>,
    plan: Option<NativeWorkspacePlan>,
    memory: MemoryGroup,
}

impl NativeWorkspaceSource {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        context: &WorkspaceContext<'_>,
        document_text: &JsValue,
        binding: &JsValue,
        size: NativeWorkspaceSize,
        revision: f64,
        max_bytes: usize,
    ) -> Result<Self, JsError> {
        Self::new_with_ingestion_document(
            context,
            document_text,
            binding,
            size,
            revision,
            max_bytes,
            None,
        )
    }

    /// Root가 실제 ingestion owner의 lease/save를 끝낸 경우 그 canonical 문서를
    /// workspace metadata와 별도 필드로 운반한다. Lease/epoch 검사는 Root가 계속 소유한다.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_ingestion_document(
        context: &WorkspaceContext<'_>,
        document_text: &JsValue,
        binding: &JsValue,
        size: NativeWorkspaceSize,
        revision: f64,
        max_bytes: usize,
        ingestion_document: Option<JsString>,
    ) -> Result<Self, JsError> {
        Self::new_with_runtime_state(
            context,
            None,
            document_text,
            binding,
            size,
            revision,
            max_bytes,
            ingestion_document,
        )
    }

    /// Production source가 model과 함께 현재 series-cache identity도 고정한다.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_runtime_state(
        context: &WorkspaceContext<'_>,
        series_caches: Option<&SeriesCaches>,
        document_text: &JsValue,
        binding: &JsValue,
        size: NativeWorkspaceSize,
        revision: f64,
        max_bytes: usize,
        ingestion_document: Option<JsString>,
    ) -> Result<Self, JsError> {
        if context.interaction.gesture_active
            || context.interaction.pointer_count != 0
            || context.drawings.transaction().is_some()
        {
            return Err(ordinary_error("Workspace source active gesture"));
        }
        let revision = source_integer_f64(revision, u64::MAX as f64, "host revision")? as u64;
        if max_bytes == 0 || max_bytes > NATIVE_WORKSPACE_RESTORE_BYTES {
            return Err(range_error("Workspace source byte limit"));
        }
        if !size.width.is_finite() || !size.height.is_finite() {
            return Err(JsError::new(
                "TypeError",
                JsString::from_str("Workspace source size"),
            ));
        }
        if ingestion_document
            .as_ref()
            .is_some_and(|document| document.len_utf16() > 32_768)
        {
            return Err(range_error("Native workspace ingestion document limit"));
        }
        let memory = context.store.memory_context().clone();
        let fingerprint_bytes = fingerprint_reservation(context, series_caches)?;
        let mut fingerprint_memory = memory
            .reserve_group(
                fingerprint_bytes
                    .checked_mul(2)
                    .ok_or_else(|| memory.allocation_failure().into_js_error())?,
            )
            .map_err(|failure| failure.into_js_error())?;
        let before = SourceFingerprint::capture(context, series_caches)?;
        let mut validation_scope = memory.scope();
        let binding = workspace_binding_scoped(binding, context.dialect, &mut validation_scope)?;
        let document = read_workspace_document_with_memory(
            document_text,
            context.host,
            context.dialect,
            &memory,
        )?;
        let (_preflight, preflight_memory) =
            preflight_workspace_with_memory(context, document_text, &binding, None, &memory)?;
        drop((_preflight, preflight_memory));
        if !before.matches(context, series_caches)? {
            return Err(stale_error());
        }
        if !memory.shares_account(context.model.memory_context())
            || !memory.shares_account(context.indicators.memory_context())
            || !memory.shares_account(context.drawings.memory_context())
            || series_caches.is_some_and(|caches| !memory.shares_account(caches.memory_context()))
        {
            return Err(type_error("Native workspace source memory context"));
        }

        let mut source_bytes = context.store.bytes();
        let mut checkpoint_bytes = 0usize;
        let (_, snapshots, capture_memory) = context
            .indicators
            .capture_native_entries_with_memory(context.store, &memory)?;
        let mut source_memory = MemoryGroup::empty(memory.clone());
        let (mut checkpoint_rows, checkpoint_rows_memory) = memory
            .try_vec_capacity(snapshots.len())
            .map_err(|failure| failure.into_js_error())?;
        source_memory
            .absorb(checkpoint_rows_memory)
            .map_err(|failure| failure.into_js_error())?;
        let mut row_scope = memory.scope();
        for snapshot in &snapshots {
            for values in &snapshot.arrays {
                charge(&mut source_bytes, values.len().saturating_mul(8), max_bytes)?;
            }
            let checkpoint_count = snapshot.checkpoints.len();
            charge(
                &mut checkpoint_bytes,
                checkpoint_count.saturating_mul(128),
                max_bytes.saturating_sub(source_bytes),
            )?;
            checkpoint_rows.push((
                snapshot
                    .id
                    .try_clone_scoped(&mut row_scope)
                    .map_err(|failure| failure.into_js_error())?,
                checkpoint_count,
            ));
        }
        let row_bytes = usize::try_from(row_scope.requested_bytes())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        source_memory
            .absorb(
                row_scope
                    .split_persistent(row_bytes)
                    .map_err(|failure| failure.into_js_error())?,
            )
            .map_err(|failure| failure.into_js_error())?;
        drop((snapshots, capture_memory));
        for series in &context.model.series {
            if let Some(values) = &series.values {
                charge(
                    &mut source_bytes,
                    values.len().saturating_mul(8),
                    max_bytes.saturating_sub(checkpoint_bytes),
                )?;
            }
            if let Some(bytes) = series_caches
                .and_then(|caches| caches.info(&series.id))
                .map(|info| info.bytes)
            {
                charge(
                    &mut source_bytes,
                    bytes,
                    max_bytes.saturating_sub(checkpoint_bytes),
                )?;
            }
        }

        let (frames, frames_memory) = drawing_frames(context, &memory)?;
        source_memory
            .absorb(frames_memory)
            .map_err(|failure| failure.into_js_error())?;
        if frames.len() > 20_001 {
            return Err(range_error("Workspace source drawing frame count"));
        }
        let mut drawing_bytes = 0usize;
        for frame in &frames {
            if frame.len() > 10_000 {
                return Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Workspace source drawing frame"),
                ));
            }
            charge(
                &mut drawing_bytes,
                frame.len().saturating_mul(8),
                max_bytes
                    .saturating_sub(source_bytes)
                    .saturating_sub(checkpoint_bytes),
            )?;
        }
        let fingerprint = SourceFingerprint::capture(context, series_caches)?;
        if !before.matches(context, series_caches)?
            || !fingerprint.matches(context, series_caches)?
        {
            return Err(stale_error());
        }
        let mut retained_scope = memory.scope();
        let document_value = document
            .value()
            .try_clone_scoped(&mut retained_scope)
            .map_err(|failure| failure.into_js_error())?;
        let binding = binding
            .try_clone_scoped(&mut retained_scope)
            .map_err(|failure| failure.into_js_error())?;
        let ingestion_document = ingestion_document
            .as_ref()
            .map(|document| {
                document
                    .try_clone_scoped(&mut retained_scope)
                    .map_err(|failure| failure.into_js_error())
            })
            .transpose()?;
        let retained_bytes = js_value_heap_bytes(&document_value)
            .saturating_add(js_value_heap_bytes(&binding))
            .saturating_add(ingestion_document.as_ref().map_or(0, js_string_heap_bytes));
        source_memory
            .absorb(
                retained_scope
                    .split_persistent(retained_bytes)
                    .map_err(|failure| failure.into_js_error())?,
            )
            .map_err(|failure| failure.into_js_error())?;
        let seen_capacity = frames.iter().map(Vec::len).sum();
        let (seen_drawings, seen_memory) = memory
            .try_vec_capacity(seen_capacity)
            .map_err(|failure| failure.into_js_error())?;
        source_memory
            .absorb(seen_memory)
            .map_err(|failure| failure.into_js_error())?;
        source_memory
            .absorb(
                fingerprint_memory
                    .split(fingerprint_bytes)
                    .map_err(|failure| failure.into_js_error())?,
            )
            .map_err(|failure| failure.into_js_error())?;
        drop(fingerprint_memory);
        Ok(Self {
            revision,
            max_bytes,
            size,
            phase: SourcePhase::Admission,
            closed: false,
            fingerprint,
            document: document_value,
            binding,
            checkpoint_rows,
            checkpoint_entry: 0,
            checkpoint_row: 0,
            checkpoint_last_key: None,
            frames,
            frame_at: 0,
            drawing_at: 0,
            seen_drawings,
            record_count: 0,
            drawing_count: 0,
            offsets: [0; 6],
            source_bytes,
            checkpoint_bytes,
            drawing_bytes,
            ingestion_document,
            metadata_json: None,
            plan: None,
            memory: source_memory,
        })
    }

    pub fn check(&self, context: &WorkspaceContext<'_>, revision: f64) -> Result<bool, JsError> {
        self.check_inner(context, None, revision)
    }

    pub fn check_with_series_caches(
        &self,
        context: &WorkspaceContext<'_>,
        series_caches: &SeriesCaches,
        revision: f64,
    ) -> Result<bool, JsError> {
        self.check_inner(context, Some(series_caches), revision)
    }

    fn check_inner(
        &self,
        context: &WorkspaceContext<'_>,
        series_caches: Option<&SeriesCaches>,
        revision: f64,
    ) -> Result<bool, JsError> {
        self.active()?;
        if revision.to_bits() != (self.revision as f64).to_bits()
            || !self.fingerprint.matches(context, series_caches)?
        {
            return Err(stale_error());
        }
        Ok(true)
    }

    pub fn step(
        &mut self,
        context: &WorkspaceContext<'_>,
        max_records: usize,
        revision: f64,
    ) -> Result<NativeWorkspaceSourceProgress, JsError> {
        let result = self.step_inner(context, None, max_records, revision);
        if result.is_err() {
            self.abort();
        }
        result
    }

    pub fn step_with_series_caches(
        &mut self,
        context: &WorkspaceContext<'_>,
        series_caches: &SeriesCaches,
        max_records: usize,
        revision: f64,
    ) -> Result<NativeWorkspaceSourceProgress, JsError> {
        let result = self.step_inner(context, Some(series_caches), max_records, revision);
        if result.is_err() {
            self.abort();
        }
        result
    }

    fn step_inner(
        &mut self,
        context: &WorkspaceContext<'_>,
        series_caches: Option<&SeriesCaches>,
        max_records: usize,
        revision: f64,
    ) -> Result<NativeWorkspaceSourceProgress, JsError> {
        self.active()?;
        if max_records == 0 || max_records > 64 {
            return Err(range_error("Workspace source admission work"));
        }
        self.check_inner(context, series_caches, revision)?;
        if self.phase == SourcePhase::Copy {
            return Ok(NativeWorkspaceSourceProgress {
                phase: "copy",
                done: 0,
                complete: true,
                include_done: false,
            });
        }
        let mut work = 0usize;
        while self.checkpoint_entry < self.checkpoint_rows.len() && work < max_records {
            let (id, count) = &self.checkpoint_rows[self.checkpoint_entry];
            if self.checkpoint_row == *count {
                self.checkpoint_entry += 1;
                self.checkpoint_row = 0;
                self.checkpoint_last_key = None;
                continue;
            }
            let mut scope = self.memory.context().scope();
            let lookup = id
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            let entry = context
                .indicators
                .entry(&JsValue::String(lookup))
                .ok_or_else(stale_error)?;
            let (key, value) = entry
                .checkpoint_next(self.checkpoint_last_key)
                .ok_or_else(stale_error)?;
            let bytes = native_checkpoint_footprint(value)?.logical_bytes;
            self.charge(bytes, ChargeKind::Checkpoint)?;
            self.checkpoint_row += 1;
            self.checkpoint_last_key = Some(key);
            self.record_count += 1;
            work += 1;
            self.check_inner(context, series_caches, revision)?;
        }
        while self.checkpoint_entry == self.checkpoint_rows.len()
            && self.frame_at < self.frames.len()
            && work < max_records
        {
            let frame = &self.frames[self.frame_at];
            if self.drawing_at == frame.len() {
                self.frame_at += 1;
                self.drawing_at = 0;
                continue;
            }
            let drawing = Arc::clone(&frame[self.drawing_at]);
            self.drawing_at += 1;
            work += 1;
            if !self
                .seen_drawings
                .iter()
                .any(|seen| Arc::ptr_eq(seen, &drawing))
            {
                let mut scope = self.memory.context().scope();
                let drawing_value = drawing.to_value_scoped(&mut scope)?;
                let bytes = native_checkpoint_footprint(&drawing_value)?.logical_bytes;
                self.charge(bytes, ChargeKind::Drawing)?;
                self.seen_drawings.push(drawing);
                self.drawing_count += 1;
            }
            self.check_inner(context, series_caches, revision)?;
        }
        let done = self.record_count + self.drawing_count;
        if self.checkpoint_entry < self.checkpoint_rows.len() || self.frame_at < self.frames.len() {
            return Ok(NativeWorkspaceSourceProgress {
                phase: "admission",
                done,
                complete: false,
                include_done: true,
            });
        }
        let options = context.store.store_options();
        let memory = self.memory.context().clone();
        let mut scope = memory.scope();
        let mut metadata = barochart_js::json::JsObject::new();
        metadata.insert(
            JsString::from_str("schema"),
            text("aster.native-workspace-target"),
        );
        metadata.insert(JsString::from_str("version"), JsValue::Number(1.0));
        if let Some(document) = &self.ingestion_document {
            metadata.insert(
                JsString::from_str("dataIngestion"),
                JsValue::String(
                    document
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            );
        }
        let document_text =
            safe_checkpoint_stringify_scoped(&self.document, context.dialect, &mut scope)?;
        metadata.insert(
            JsString::from_str("document"),
            JsValue::String(document_text),
        );
        metadata.insert(
            JsString::from_str("datasetBinding"),
            self.binding
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        );
        metadata.insert(
            JsString::from_str("source"),
            object([
                ("length", number(context.store.length())),
                ("maxBars", number(options.max_bars)),
                ("timeframeMs", JsValue::Number(options.timeframe_ms)),
                ("timeOrigin", JsValue::Number(options.time_origin)),
                ("version", JsValue::Number(context.store.version())),
                ("timeVersion", JsValue::Number(context.store.time_version())),
            ]),
        );
        metadata.insert(
            JsString::from_str("size"),
            object([
                ("width", JsValue::Number(self.size.width)),
                ("height", JsValue::Number(self.size.height)),
            ]),
        );
        metadata.insert(
            JsString::from_str("retainedBytes"),
            number(self.source_bytes + self.checkpoint_bytes + self.drawing_bytes),
        );
        metadata.insert(JsString::from_str("maxBytes"), number(self.max_bytes));
        let metadata = JsValue::Object(metadata);
        let temporary_metadata_json =
            safe_checkpoint_stringify_scoped(&metadata, context.dialect, &mut scope)?;
        let plan = crate::native_workspace::native_workspace_target_spec_with_memory(
            &temporary_metadata_json,
            context.host,
            context.dialect,
            &memory,
        )?
        .plan;
        self.check_inner(context, series_caches, revision)?;
        let mut result_scope = memory.scope();
        let metadata_json = temporary_metadata_json
            .try_clone_scoped(&mut result_scope)
            .map_err(|failure| failure.into_js_error())?;
        let metadata_bytes = js_string_heap_bytes(&metadata_json);
        self.memory
            .absorb(
                result_scope
                    .split_persistent(metadata_bytes)
                    .map_err(|failure| failure.into_js_error())?,
            )
            .map_err(|failure| failure.into_js_error())?;
        drop((metadata, temporary_metadata_json, scope));
        self.metadata_json = Some(metadata_json);
        self.plan = Some(plan);
        self.phase = SourcePhase::Copy;
        Ok(NativeWorkspaceSourceProgress {
            phase: "copy",
            done,
            complete: true,
            include_done: true,
        })
    }

    pub fn read_slice<'a>(
        &mut self,
        context: &WorkspaceContext<'a>,
        slot: usize,
        offset: usize,
        count: usize,
        revision: f64,
    ) -> Result<&'a [f64], JsError> {
        self.read_slice_inner(context, None, slot, offset, count, revision)
    }

    pub fn read_slice_with_series_caches<'a>(
        &mut self,
        context: &WorkspaceContext<'a>,
        series_caches: &SeriesCaches,
        slot: usize,
        offset: usize,
        count: usize,
        revision: f64,
    ) -> Result<&'a [f64], JsError> {
        self.read_slice_inner(context, Some(series_caches), slot, offset, count, revision)
    }

    /// Runtime F64 routing이 borrowed handoff 전에 같은 guard/cursor/bounds를 검사한다.
    pub fn check_read_slice_with_series_caches(
        &self,
        context: &WorkspaceContext<'_>,
        series_caches: &SeriesCaches,
        slot: usize,
        offset: usize,
        count: usize,
        revision: f64,
    ) -> Result<(), JsError> {
        self.active()?;
        self.check_inner(context, Some(series_caches), revision)?;
        if self.phase != SourcePhase::Copy
            || slot >= 6
            || offset != self.offsets[slot]
            || count == 0
            || count > NATIVE_WORKSPACE_SLICE
            || offset.saturating_add(count) > context.store.length()
        {
            return Err(range_error("Workspace source copy slice"));
        }
        Ok(())
    }

    fn read_slice_inner<'a>(
        &mut self,
        context: &WorkspaceContext<'a>,
        series_caches: Option<&SeriesCaches>,
        slot: usize,
        offset: usize,
        count: usize,
        revision: f64,
    ) -> Result<&'a [f64], JsError> {
        let result = (|| {
            self.active()?;
            self.check_inner(context, series_caches, revision)?;
            if self.phase != SourcePhase::Copy
                || slot >= 6
                || offset != self.offsets[slot]
                || count == 0
                || count > NATIVE_WORKSPACE_SLICE
                || offset.saturating_add(count) > context.store.length()
            {
                return Err(range_error("Workspace source copy slice"));
            }
            let columns = context.store.columns();
            let values = match slot {
                0 => &columns.time,
                1 => &columns.open,
                2 => &columns.high,
                3 => &columns.low,
                4 => &columns.close,
                5 => &columns.volume,
                _ => unreachable!(),
            };
            self.offsets[slot] += count;
            self.check_inner(context, series_caches, revision)?;
            Ok(&values[offset..offset + count])
        })();
        if result.is_err() {
            self.abort();
        }
        result
    }

    pub fn finish(
        &mut self,
        context: &WorkspaceContext<'_>,
        revision: f64,
    ) -> Result<NativeWorkspaceSourceReceipt, JsError> {
        self.finish_inner(context, None, revision)
    }

    pub fn finish_with_series_caches(
        &mut self,
        context: &WorkspaceContext<'_>,
        series_caches: &SeriesCaches,
        revision: f64,
    ) -> Result<NativeWorkspaceSourceReceipt, JsError> {
        self.finish_inner(context, Some(series_caches), revision)
    }

    fn finish_inner(
        &mut self,
        context: &WorkspaceContext<'_>,
        series_caches: Option<&SeriesCaches>,
        revision: f64,
    ) -> Result<NativeWorkspaceSourceReceipt, JsError> {
        let result = (|| {
            self.active()?;
            self.check_inner(context, series_caches, revision)?;
            if self.phase != SourcePhase::Copy
                || self
                    .offsets
                    .iter()
                    .any(|offset| *offset != context.store.length())
            {
                return Err(ordinary_error("Workspace source copy incomplete"));
            }
            let receipt = NativeWorkspaceSourceReceipt {
                revision: self.revision,
                source_version: context.store.version() as u64,
                source_bytes: self.source_bytes,
                checkpoint_bytes: self.checkpoint_bytes,
                drawing_bytes: self.drawing_bytes,
            };
            self.closed = true;
            Ok(receipt)
        })();
        if result.is_err() {
            self.abort();
        }
        result
    }

    pub fn metadata_json(&self) -> Option<&JsString> {
        self.metadata_json.as_ref()
    }

    /// Metadata 반환 복사와 serialization 수명 group을 함께 만든다.
    pub fn metadata_json_accounted(&self) -> Result<Option<(JsString, MemoryGroup)>, JsError> {
        let Some(metadata) = &self.metadata_json else {
            return Ok(None);
        };
        let mut scope = self.memory.context().scope();
        let metadata = metadata
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let memory = scope
            .split_persistent(js_string_heap_bytes(&metadata))
            .map_err(|failure| failure.into_js_error())?;
        Ok(Some((metadata, memory)))
    }

    pub fn plan(&self) -> Option<&NativeWorkspacePlan> {
        self.plan.as_ref()
    }

    pub fn buffers(&self) -> Option<[usize; 6]> {
        (self.phase == SourcePhase::Copy).then_some([self.fingerprint.length; 6])
    }

    /// Admission/copy 보유물을 폐기한다. 두 번째 호출은 false다.
    pub fn abort(&mut self) -> bool {
        if self.closed {
            return false;
        }
        self.closed = true;
        self.metadata_json = None;
        self.plan = None;
        self.ingestion_document = None;
        self.document = JsValue::Undefined;
        self.binding = JsValue::Undefined;
        self.checkpoint_rows = Vec::new();
        self.frames = Vec::new();
        self.seen_drawings = Vec::new();
        let context = self.memory.context().clone();
        self.memory = MemoryGroup::empty(context);
        true
    }

    fn active(&self) -> Result<(), JsError> {
        if self.closed {
            Err(ordinary_error("Workspace source capture closed"))
        } else {
            Ok(())
        }
    }

    fn charge(&mut self, bytes: usize, kind: ChargeKind) -> Result<(), JsError> {
        if bytes > self.max_bytes
            || self.source_bytes + self.checkpoint_bytes + self.drawing_bytes
                > self.max_bytes - bytes
        {
            return Err(range_error("Workspace source logical byte limit"));
        }
        match kind {
            ChargeKind::Checkpoint => self.checkpoint_bytes += bytes,
            ChargeKind::Drawing => self.drawing_bytes += bytes,
        }
        Ok(())
    }
}

enum ChargeKind {
    Checkpoint,
    Drawing,
}

fn charge(total: &mut usize, bytes: usize, limit: usize) -> Result<(), JsError> {
    if bytes > limit || *total > limit - bytes {
        return Err(range_error("Workspace source logical byte limit"));
    }
    *total += bytes;
    Ok(())
}

fn source_integer_f64(value: f64, maximum: f64, label: &str) -> Result<f64, JsError> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > maximum {
        return Err(range_error(&format!("Workspace source {label}")));
    }
    Ok(value)
}

fn fingerprint_reservation(
    context: &WorkspaceContext<'_>,
    series_caches: Option<&SeriesCaches>,
) -> Result<usize, JsError> {
    let memory = context.store.memory_context();
    let bytes = context
        .model
        .series
        .len()
        .checked_mul(64)
        .and_then(|value| {
            context
                .indicators
                .len()
                .checked_mul(512)
                .and_then(|entries| value.checked_add(entries))
        })
        .and_then(|value| {
            series_caches
                .map_or(0, SeriesCaches::len)
                .checked_mul(256)
                .and_then(|entries| value.checked_add(entries))
        })
        .ok_or_else(|| memory.allocation_failure().into_js_error())?;
    Ok(bytes)
}

fn stale_error() -> JsError {
    JsError::new(
        "StaleSourceError",
        JsString::from_str("Workspace source stale: owner/data/configuration changed"),
    )
}

fn drawing_frames(
    context: &WorkspaceContext<'_>,
    memory: &MemoryContext,
) -> Result<(DrawingFrames, MemoryGroup), JsError> {
    let count = 1 + context.drawings.undo_stack().len() + context.drawings.redo_stack().len();
    let (mut frames, mut group) = memory
        .try_vec_capacity(count)
        .map_err(|failure| failure.into_js_error())?;
    for frame in std::iter::once(context.drawings.items())
        .chain(
            context
                .drawings
                .undo_stack()
                .iter()
                .map(|frame| frame.as_ref().as_ref()),
        )
        .chain(
            context
                .drawings
                .redo_stack()
                .iter()
                .map(|frame| frame.as_ref().as_ref()),
        )
    {
        let (owned, frame_memory) = memory
            .try_clone_slice(frame)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(frame_memory)
            .map_err(|failure| failure.into_js_error())?;
        frames.push(owned);
    }
    Ok((frames, group))
}

fn capture_symbol(
    value: WorkspaceSymbol<'_>,
    memory: &MemoryContext,
) -> Result<CapturedSymbol, JsError> {
    let mut scope = memory.scope();
    let clone = |value: &JsString, scope: &mut barochart_js::memory::MemoryScope| {
        value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())
    };
    let symbol = Symbol {
        id: clone(&value.symbol.id, &mut scope)?,
        exchange: clone(&value.symbol.exchange, &mut scope)?,
        timezone: clone(&value.symbol.timezone, &mut scope)?,
        currency: clone(&value.symbol.currency, &mut scope)?,
        volume_unit: clone(&value.symbol.volume_unit, &mut scope)?,
        price_decimals: value.symbol.price_decimals,
        tick_size: value.symbol.tick_size,
        adjustment: value.symbol.adjustment,
    };
    let provider = value
        .provider
        .map(|value| clone(value, &mut scope))
        .transpose()?;
    let adjustment_version = value
        .adjustment_version
        .map(|value| clone(value, &mut scope))
        .transpose()?;
    let bytes = symbol.id.len_utf16()
        + symbol.exchange.len_utf16()
        + symbol.timezone.len_utf16()
        + symbol.currency.len_utf16()
        + symbol.volume_unit.len_utf16()
        + provider.as_ref().map_or(0, JsString::len_utf16)
        + adjustment_version.as_ref().map_or(0, JsString::len_utf16);
    let memory = scope
        .split_persistent(bytes.saturating_mul(std::mem::size_of::<u16>()))
        .map_err(|failure| failure.into_js_error())?;
    Ok(CapturedSymbol {
        symbol,
        provider,
        adjustment_version,
        _memory: memory,
    })
}

fn same_symbol(left: Option<&CapturedSymbol>, right: Option<WorkspaceSymbol<'_>>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.symbol == *right.symbol
                && left.provider.as_ref() == right.provider
                && left.adjustment_version.as_ref() == right.adjustment_version
        }
        _ => false,
    }
}

fn same_options(left: StoreOptions, right: StoreOptions) -> bool {
    left.max_bars == right.max_bars
        && left.timeframe_ms.to_bits() == right.timeframe_ms.to_bits()
        && left.time_origin.to_bits() == right.time_origin.to_bits()
}
