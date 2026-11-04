//! 격리 runtime에서 실제 workspace 후보를 만드는 native target leaf다.

#![forbid(unsafe_code)]

use std::borrow::Cow;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json_scoped};
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::JsString;

use crate::Host;
use crate::block_range::BlockRangeIndex;
use crate::data::{Columns, ModelDataState, StoreOptions};
use crate::drawing_document::{
    DrawingDocumentContext, DrawingDocumentLimits, load_drawing_document_with_memory,
};
use crate::drawings::{DrawingFrame, DrawingStore, DrawingStoreConfig};
use crate::indicator_engine::{
    CalculationStep, IndicatorCalculation, IndicatorEngine, IndicatorEngineOptions,
};
use crate::markets::{Adjustment, Symbol};
use crate::model_state::{IndicatorProjection, ModelContext, ModelState, SeriesKind, VisibleRange};
use crate::native_workspace::{
    NATIVE_WORKSPACE_SLICE, NativeWorkspacePlan, NativeWorkspaceSize, NativeWorkspaceSpec, array,
    get, native_workspace_target_spec_with_memory, number, object, ordinary_error, range_error,
    record, required, text, text_eq, type_error,
};
use crate::range_index::RangeIndexBuilder;
use crate::series_cache::{
    NativePrebuiltSeriesCache, SERIES_BLOCK_SIZE, SERIES_BLOCK_THRESHOLD, SeriesCaches,
};
use crate::workspace::{
    WorkspaceContext, WorkspaceInteraction, WorkspaceSymbol, js_value_heap_bytes,
    read_workspace_document_with_memory, save_workspace_with_memory,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetPhase {
    Receive,
    Validate,
    StoreIndex,
    Calculate,
    Indices,
    WorkspaceCheckpoints,
    Ready,
}

/// Target compute의 host-visible bounded progress다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeWorkspaceTargetProgress {
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
    pub complete: bool,
}

impl NativeWorkspaceTargetProgress {
    pub fn to_value(&self) -> JsValue {
        object([
            ("phase", text(self.phase)),
            ("done", number(self.done)),
            ("total", number(self.total)),
            ("complete", JsValue::Bool(self.complete)),
        ])
    }
}

/// Workspace document가 가진 optional symbol 확장 필드를 함께 소유한다.
pub struct NativeWorkspaceSymbol {
    pub symbol: Symbol,
    pub provider: Option<JsString>,
    pub adjustment_version: Option<JsString>,
}

/// Root가 원자 publication 전에 소유하는 완성된 실제 chart 후보다.
pub struct RestoredWorkspace {
    pub data: ModelDataState,
    pub model: ModelState,
    pub indicators: IndicatorEngine,
    pub drawings: DrawingStore,
    pub series_caches: SeriesCaches,
    pub symbol: Option<NativeWorkspaceSymbol>,
    pub symbol_formatters: bool,
    pub ingestion_document: Option<JsString>,
    pub size: NativeWorkspaceSize,
    pub plan: NativeWorkspacePlan,
    pub ingestion_memory: MemoryGroup,
    pub memory: MemoryGroup,
}

impl RestoredWorkspace {
    /// Save/canonical check와 Root publication이 같은 borrowed context shape를 쓴다.
    pub fn workspace_context<'a>(
        &'a self,
        host: &'a dyn Host,
        dialect: NumberDialect,
    ) -> WorkspaceContext<'a> {
        WorkspaceContext {
            host,
            model: &self.model,
            store: self.data.store(),
            indicators: &self.indicators,
            drawings: &self.drawings,
            symbol: self.symbol.as_ref().map(|symbol| WorkspaceSymbol {
                symbol: &symbol.symbol,
                provider: symbol.provider.as_ref(),
                adjustment_version: symbol.adjustment_version.as_ref(),
            }),
            symbol_formatters: self.symbol_formatters,
            interaction: WorkspaceInteraction::default(),
            dialect,
        }
    }
}

/// 여섯 target buffer와 단계별 restore 후보를 소유한다.
pub struct NativeWorkspaceTarget {
    spec: Option<NativeWorkspaceSpec>,
    store_serial: f64,
    dialect: NumberDialect,
    columns: Option<Columns>,
    columns_memory: Option<MemoryGroup>,
    index_builder: Option<RangeIndexBuilder>,
    index_memory: Option<MemoryGroup>,
    offsets: [usize; 6],
    phase: TargetPhase,
    closed: bool,
    validate_at: usize,
    store_index_done: usize,
    indicator_at: usize,
    calculation: Option<IndicatorCalculation>,
    calculation_memory: MemoryGroup,
    calculation_processed: usize,
    index_series: usize,
    series_index_builder: Option<RangeIndexBuilder>,
    series_index_memory: Option<MemoryGroup>,
    series_values_done: usize,
    series_merge_done: usize,
    series_blocked: bool,
    block_min: f64,
    block_max: f64,
    block_finite: usize,
    last_step_work: usize,
    checkpoint_started: bool,
    checkpoint_at: usize,
    checkpoint_ordinal: usize,
    checkpoint_last_key: Option<usize>,
    checkpoint_checked: usize,
    data: Option<ModelDataState>,
    model: Option<ModelState>,
    indicators: Option<IndicatorEngine>,
    drawings: Option<DrawingStore>,
    series_caches: Option<SeriesCaches>,
    symbol: Option<NativeWorkspaceSymbol>,
    symbol_memory: MemoryGroup,
    symbol_formatters: bool,
    memory: MemoryContext,
}

impl NativeWorkspaceTarget {
    /// Bounded metadata를 검증하고 실제 target column allocation을 예약한다.
    pub fn new(
        metadata_json: &JsString,
        host: &dyn Host,
        dialect: NumberDialect,
        store_serial: f64,
    ) -> Result<Self, JsError> {
        Self::new_with_memory(
            metadata_json,
            host,
            dialect,
            store_serial,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
    }

    /// Metadata와 모든 target-owned payload를 explicit engine account에서 fallible하게 만든다.
    pub fn new_with_memory(
        metadata_json: &JsString,
        host: &dyn Host,
        dialect: NumberDialect,
        store_serial: f64,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        let spec = native_workspace_target_spec_with_memory(metadata_json, host, dialect, &memory)?;
        if !store_serial.is_finite() || store_serial.fract() != 0.0 || store_serial < 1.0 {
            return Err(range_error("Workspace store serial"));
        }
        let capacity = spec.plan.capacity;
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
        let (index_builder, index_memory) =
            RangeIndexBuilder::new_with_memory(capacity, false, true, &memory)?;
        Ok(Self {
            spec: Some(spec),
            store_serial,
            dialect,
            columns: Some(Columns {
                time,
                open,
                high,
                low,
                close,
                volume,
            }),
            columns_memory: Some(columns_memory),
            index_builder: Some(index_builder),
            index_memory: Some(index_memory),
            offsets: [0; 6],
            phase: TargetPhase::Receive,
            closed: false,
            validate_at: 0,
            store_index_done: 0,
            indicator_at: 0,
            calculation: None,
            calculation_memory: MemoryGroup::empty(memory.clone()),
            calculation_processed: 0,
            index_series: 0,
            series_index_builder: None,
            series_index_memory: None,
            series_values_done: 0,
            series_merge_done: 0,
            series_blocked: false,
            block_min: f64::INFINITY,
            block_max: f64::NEG_INFINITY,
            block_finite: 0,
            last_step_work: 0,
            checkpoint_started: false,
            checkpoint_at: 0,
            checkpoint_ordinal: 0,
            checkpoint_last_key: None,
            checkpoint_checked: 0,
            data: None,
            model: None,
            indicators: None,
            drawings: None,
            series_caches: None,
            symbol: None,
            symbol_memory: MemoryGroup::empty(memory.clone()),
            symbol_formatters: false,
            memory,
        })
    }

    /// Host의 f64 조각을 target-owned allocation에 순차 복사한다.
    pub fn write_slice(
        &mut self,
        slot: usize,
        offset: usize,
        values: &[f64],
    ) -> Result<(), JsError> {
        self.target_slice(slot, offset, values.len())?
            .copy_from_slice(values);
        Ok(())
    }

    /// FFI가 같은 호출에서 채우는 target-owned 연속 slice를 한 번 handoff한다.
    pub fn target_slice(
        &mut self,
        slot: usize,
        offset: usize,
        count: usize,
    ) -> Result<&mut [f64], JsError> {
        self.active()?;
        let length = self.spec()?.length;
        if self.phase != TargetPhase::Receive
            || slot >= 6
            || offset != self.offsets[slot]
            || count == 0
            || count > NATIVE_WORKSPACE_SLICE
            || offset.saturating_add(count) > length
        {
            self.abort();
            return Err(range_error("Prepare target slice"));
        }
        self.offsets[slot] += count;
        let columns = self.columns.as_mut().expect("receive owns columns");
        let target = match slot {
            0 => &mut columns.time,
            1 => &mut columns.open,
            2 => &mut columns.high,
            3 => &mut columns.low,
            4 => &mut columns.close,
            5 => &mut columns.volume,
            _ => unreachable!(),
        };
        Ok(&mut target[offset..offset + count])
    }

    /// 완전한 여섯 열만 계산 단계로 넘긴다.
    pub fn start(&mut self) -> Result<(), JsError> {
        let result = (|| {
            self.active()?;
            let length = self.spec()?.length;
            if self.phase != TargetPhase::Receive
                || self.offsets.iter().any(|offset| *offset != length)
            {
                return Err(ordinary_error("Prepare incomplete input"));
            }
            self.phase = TargetPhase::Validate;
            Ok(())
        })();
        if result.is_err() {
            self.abort();
        }
        result
    }

    pub fn check(&self) -> Result<bool, JsError> {
        self.active()?;
        Ok(true)
    }

    /// Validation, store tree, indicator, series index, checkpoint와 canonical install을 진행한다.
    pub fn step(
        &mut self,
        host: &dyn Host,
        max_bars: usize,
    ) -> Result<NativeWorkspaceTargetProgress, JsError> {
        self.last_step_work = 0;
        let result = self.step_inner(host, max_bars);
        if result.is_err() {
            self.abort();
        }
        result
    }

    /// 마지막 step이 실제로 처리한 row/tree/checkpoint work unit 수다.
    pub fn last_step_work(&self) -> usize {
        self.last_step_work
    }

    fn step_inner(
        &mut self,
        host: &dyn Host,
        max_bars: usize,
    ) -> Result<NativeWorkspaceTargetProgress, JsError> {
        self.active()?;
        if self.phase == TargetPhase::Receive {
            return Err(ordinary_error("Prepare not started"));
        }
        if max_bars == 0 || max_bars > 65_536 {
            return Err(range_error("Prepare step size"));
        }
        match self.phase {
            TargetPhase::Validate => self.step_validate(max_bars),
            TargetPhase::StoreIndex => self.step_store_index(host, max_bars),
            TargetPhase::Calculate => self.step_calculate(host, max_bars),
            TargetPhase::Indices => self.step_indices(max_bars),
            TargetPhase::WorkspaceCheckpoints => self.step_checkpoints(host, max_bars),
            TargetPhase::Ready => Ok(progress("workspace-ready", 1, 1, true)),
            TargetPhase::Receive => unreachable!(),
        }
    }

    fn step_validate(&mut self, max_bars: usize) -> Result<NativeWorkspaceTargetProgress, JsError> {
        let length = self.spec()?.length;
        let columns = self.columns.as_ref().expect("validate owns columns");
        let end = usize::min(length, self.validate_at.saturating_add(max_bars));
        let mut previous = if self.validate_at == 0 {
            f64::NEG_INFINITY
        } else {
            columns.time[self.validate_at - 1]
        };
        for index in self.validate_at..end {
            let time = columns.time[index];
            let open = columns.open[index];
            let high = columns.high[index];
            let low = columns.low[index];
            let close = columns.close[index];
            let volume = columns.volume[index];
            if ![time, open, high, low, close, volume]
                .into_iter()
                .all(f64::is_finite)
            {
                return Err(type_error("Every OHLCV field must be finite"));
            }
            if time.fract() != 0.0 || time.abs() > 8_640_000_000_000_000.0 {
                return Err(range_error("OHLCV UTC time"));
            }
            if time <= previous {
                return Err(range_error("OHLCV increasing time"));
            }
            if volume < 0.0
                || low > js_min(&[open, close])
                || high < js_max(&[open, close])
                || low > high
            {
                return Err(range_error("Invalid OHLCV envelope"));
            }
            previous = time;
            self.index_builder
                .as_mut()
                .expect("validate owns index builder")
                .leaf(index, low, high, volume)?;
        }
        self.last_step_work = end - self.validate_at;
        self.validate_at = end;
        if self.validate_at == length {
            self.phase = TargetPhase::StoreIndex;
        }
        Ok(progress("validate", self.validate_at, length, false))
    }

    fn step_store_index(
        &mut self,
        host: &dyn Host,
        max_bars: usize,
    ) -> Result<NativeWorkspaceTargetProgress, JsError> {
        let total = self.spec()?.plan.capacity - 1;
        let end = usize::min(total, self.store_index_done.saturating_add(max_bars));
        let start = self.store_index_done;
        while self.store_index_done < end {
            let position = total - self.store_index_done;
            self.index_builder
                .as_mut()
                .expect("store-index owns builder")
                .merge(position)?;
            self.store_index_done += 1;
        }
        self.last_step_work = self.store_index_done - start;
        if self.store_index_done == total {
            self.build_store_and_model(host)?;
            let indicators = document_array(self.spec()?, "indicators")?.len();
            if indicators == 0 {
                self.install_series()?;
                self.phase = if self.model_ref()?.series.is_empty() {
                    TargetPhase::WorkspaceCheckpoints
                } else {
                    TargetPhase::Indices
                };
            } else {
                self.phase = TargetPhase::Calculate;
            }
        }
        Ok(progress("store-index", self.store_index_done, total, false))
    }

    fn step_calculate(
        &mut self,
        host: &dyn Host,
        max_bars: usize,
    ) -> Result<NativeWorkspaceTargetProgress, JsError> {
        let total = document_array(self.spec()?, "indicators")?.len();
        let mut calculation = match self.calculation.take() {
            Some(calculation) => calculation,
            None => {
                let study = record(
                    &document_array(self.spec()?, "indicators")?[self.indicator_at],
                    "Workspace: object required",
                )?;
                let mut scope = self.memory.scope();
                let id = required(study, "id")?
                    .try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?;
                self.calculation_memory = scope
                    .split_persistent(js_value_heap_bytes(&id))
                    .map_err(|failure| failure.into_js_error())?;
                self.indicators_ref()?.calculate(id, max_bars as f64)
            }
        };
        let data = self.data.as_ref().expect("calculate has store");
        let step = calculation.step(
            self.indicators.as_mut().expect("calculate has engine"),
            data.store(),
            host,
        )?;
        match step {
            CalculationStep::Yield { to, .. } => {
                self.last_step_work = to.saturating_sub(self.calculation_processed);
                self.calculation_processed = to;
                self.calculation = Some(calculation);
            }
            CalculationStep::Complete { computed_until, .. } => {
                self.last_step_work = computed_until.saturating_sub(self.calculation_processed);
                self.calculation_processed = 0;
                self.indicator_at += 1;
                self.calculation_memory = MemoryGroup::empty(self.memory.clone());
                if self.indicator_at == total {
                    self.install_series()?;
                    self.phase = if self.model_ref()?.series.is_empty() {
                        TargetPhase::WorkspaceCheckpoints
                    } else {
                        TargetPhase::Indices
                    };
                }
            }
            CalculationStep::Exhausted => {
                self.calculation_memory = MemoryGroup::empty(self.memory.clone());
                return Err(ordinary_error(
                    "Native workspace target calculation exhausted",
                ));
            }
        }
        Ok(progress("calculate", self.indicator_at, total, false))
    }

    fn step_indices(&mut self, max_bars: usize) -> Result<NativeWorkspaceTargetProgress, JsError> {
        let total = self.model_ref()?.series.len();
        if matches!(
            self.model_ref()?.series[self.index_series].kind,
            SeriesKind::Candles | SeriesKind::Ohlc
        ) {
            self.index_series += 1;
            if self.index_series == total {
                self.phase = TargetPhase::WorkspaceCheckpoints;
            }
            return Ok(progress("indices", self.index_series, total, false));
        }
        if self.series_index_builder.is_none() {
            self.begin_series_index()?;
        }
        let length = self.spec()?.length;
        if self.series_values_done < length {
            let values = series_values_for(
                self.model.as_ref().expect("indices have model"),
                self.indicators.as_ref().expect("indices have indicators"),
                self.data.as_ref().expect("indices have data"),
                &self.memory,
                self.index_series,
            )?;
            let start = self.series_values_done;
            let end = usize::min(length, self.series_values_done.saturating_add(max_bars));
            while self.series_values_done < end {
                let position = self.series_values_done;
                let value = values
                    .get(position)
                    .copied()
                    .ok_or_else(|| ordinary_error("Missing series values"))?;
                if self.series_blocked {
                    if value.is_finite() {
                        if value < self.block_min {
                            self.block_min = value;
                        }
                        if value > self.block_max {
                            self.block_max = value;
                        }
                        self.block_finite += 1;
                    }
                    self.series_values_done += 1;
                    if self.series_values_done.is_multiple_of(SERIES_BLOCK_SIZE)
                        || self.series_values_done == length
                    {
                        let block = (self.series_values_done - 1) / SERIES_BLOCK_SIZE;
                        self.series_index_builder
                            .as_mut()
                            .expect("indices own builder")
                            .leaf(
                                block,
                                self.block_min,
                                self.block_max,
                                self.block_finite as f64,
                            )?;
                        self.block_min = f64::INFINITY;
                        self.block_max = f64::NEG_INFINITY;
                        self.block_finite = 0;
                    }
                } else {
                    self.series_index_builder
                        .as_mut()
                        .expect("indices own builder")
                        .leaf(position, value, value, 0.0)?;
                    self.series_values_done += 1;
                }
            }
            self.last_step_work = end - start;
            return Ok(progress("indices", self.index_series, total, false));
        }
        let tree_capacity = if self.series_blocked {
            usize::max(1, self.spec()?.plan.capacity / SERIES_BLOCK_SIZE)
        } else {
            self.spec()?.plan.capacity
        };
        let merge_total = tree_capacity - 1;
        if self.series_merge_done < merge_total {
            let end = usize::min(merge_total, self.series_merge_done.saturating_add(max_bars));
            let start = self.series_merge_done;
            while self.series_merge_done < end {
                let position = merge_total - self.series_merge_done;
                self.series_index_builder
                    .as_mut()
                    .expect("indices own builder")
                    .merge(position)?;
                self.series_merge_done += 1;
            }
            self.last_step_work = self.series_merge_done - start;
            return Ok(progress("indices", self.index_series, total, false));
        }
        self.finish_series_index()?;
        self.index_series += 1;
        if self.index_series == total {
            self.phase = TargetPhase::WorkspaceCheckpoints;
        }
        Ok(progress("indices", self.index_series, total, false))
    }

    fn step_checkpoints(
        &mut self,
        host: &dyn Host,
        max_bars: usize,
    ) -> Result<NativeWorkspaceTargetProgress, JsError> {
        let entries = self.indicators_ref()?.len();
        let per_entry = if self.spec()?.length == 0 {
            0
        } else {
            self.spec()?.length / 256 + 1
        };
        let total = entries.saturating_mul(per_entry);
        if !self.checkpoint_started {
            self.checkpoint_started = true;
            if entries == 0 {
                self.install_workspace(host)?;
                self.phase = TargetPhase::Ready;
            }
            return Ok(progress("workspace-checkpoints", 0, total, false));
        }
        let limit = usize::max(1, max_bars / 256);
        let mut work = 0usize;
        while self.checkpoint_at < entries && work < limit {
            let study = record(
                &document_array(self.spec()?, "indicators")?[self.checkpoint_at],
                "Workspace: object required",
            )?;
            let id = required(study, "id")?;
            let entry = self
                .indicators_ref()?
                .entry(id)
                .expect("id came from engine");
            if entry.checkpoint_len() != per_entry {
                return Err(type_error("Native workspace checkpoint count"));
            }
            if self.checkpoint_ordinal == per_entry {
                self.checkpoint_at += 1;
                self.checkpoint_ordinal = 0;
                self.checkpoint_last_key = None;
                continue;
            }
            let (key, _) = entry
                .checkpoint_next(self.checkpoint_last_key)
                .ok_or_else(|| type_error("Native workspace checkpoint count"))?;
            if key != self.checkpoint_ordinal * 256 {
                return Err(type_error("Native workspace checkpoint boundary"));
            }
            self.checkpoint_ordinal += 1;
            self.checkpoint_last_key = Some(key);
            self.checkpoint_checked += 1;
            work += 1;
        }
        self.last_step_work = work;
        if self.checkpoint_at == entries {
            self.install_workspace(host)?;
            self.phase = TargetPhase::Ready;
            return Ok(progress("workspace-ready", 1, 1, true));
        }
        Ok(progress(
            "workspace-checkpoints",
            self.checkpoint_checked,
            total,
            false,
        ))
    }

    /// Ready 후보를 한 번만 넘긴다. Root가 publication 전 owner를 다시 검사한다.
    pub fn finish(&mut self) -> Result<RestoredWorkspace, JsError> {
        let result = (|| {
            self.active()?;
            if self.phase != TargetPhase::Ready {
                return Err(ordinary_error("Native workspace target not ready"));
            }
            let spec = self.spec.take().expect("ready owns spec");
            let memory_context = self.memory.clone();
            let retained_memory = std::mem::replace(
                &mut self.symbol_memory,
                MemoryGroup::empty(memory_context.clone()),
            );
            let mut scope = memory_context.scope();
            let ingestion_document = spec
                .ingestion
                .as_ref()
                .map(|document| {
                    document
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())
                })
                .transpose()?;
            let bytes = usize::try_from(scope.requested_bytes())
                .map_err(|_| memory_context.allocation_failure().into_js_error())?;
            let ingestion_memory = scope
                .split_persistent(bytes)
                .map_err(|failure| failure.into_js_error())?;
            let result = RestoredWorkspace {
                data: self.data.take().expect("ready owns data"),
                model: self.model.take().expect("ready owns model"),
                indicators: self.indicators.take().expect("ready owns indicators"),
                drawings: self.drawings.take().expect("ready owns drawings"),
                series_caches: self.series_caches.take().expect("ready owns caches"),
                symbol: self.symbol.take(),
                symbol_formatters: self.symbol_formatters,
                ingestion_document,
                size: spec.size,
                plan: spec.plan,
                ingestion_memory,
                memory: retained_memory,
            };
            self.closed = true;
            Ok(result)
        })();
        if result.is_err() {
            self.abort();
        }
        result
    }

    /// Unpublished target을 폐기한다. 두 번째 호출은 false다.
    pub fn abort(&mut self) -> bool {
        if self.closed {
            return false;
        }
        self.closed = true;
        self.columns = None;
        self.columns_memory = None;
        self.index_builder = None;
        self.index_memory = None;
        self.data = None;
        self.model = None;
        if let Some(engine) = self.indicators.as_mut() {
            engine.dispose();
        }
        self.indicators = None;
        self.calculation = None;
        self.calculation_memory = MemoryGroup::empty(self.memory.clone());
        self.series_index_builder = None;
        self.series_index_memory = None;
        self.drawings = None;
        self.series_caches = None;
        self.symbol = None;
        self.symbol_memory = MemoryGroup::empty(self.memory.clone());
        self.spec = None;
        true
    }

    fn build_store_and_model(&mut self, host: &dyn Host) -> Result<(), JsError> {
        let spec = self.spec()?;
        let length = spec.length;
        let options = StoreOptions {
            timeframe_ms: spec.timeframe_ms,
            time_origin: spec.time_origin,
            max_bars: spec.max_bars,
        };
        let version = spec.version + 1.0;
        let time_version = spec.time_version + 1.0;
        self.validate_extent()?;
        let columns = self.columns.take().expect("store build owns columns");
        let mut store_memory = self
            .columns_memory
            .take()
            .expect("store build owns column memory");
        let index = self
            .index_builder
            .take()
            .expect("store build owns index builder")
            .finish(length)?;
        store_memory
            .absorb(
                self.index_memory
                    .take()
                    .expect("store build owns index memory"),
            )
            .map_err(|failure| failure.into_js_error())?;
        let data = ModelDataState::from_validated_native_snapshot_columns_with_memory(
            self.store_serial,
            options,
            columns,
            index,
            length,
            version,
            time_version,
            store_memory,
        )?;
        let model = model_from_document(self.spec()?, data.store())?;
        self.data = Some(data);
        self.model = Some(model);
        self.indicators = Some(self.initialize_indicators(host)?);
        self.drawings = Some(DrawingStore::new_with_memory(
            DrawingStoreConfig::default(),
            self.dialect,
            self.memory.clone(),
        )?);
        self.series_caches = Some(SeriesCaches::new_with_memory(self.memory.clone()));
        let (symbol, symbol_memory) = symbol_from_document(self.spec()?, host, &self.memory)?;
        self.symbol = symbol;
        self.symbol_memory = symbol_memory;
        self.symbol_formatters = document_symbol_formatters(self.spec()?)?;
        Ok(())
    }

    fn initialize_indicators(&self, host: &dyn Host) -> Result<IndicatorEngine, JsError> {
        let spec = self.spec()?;
        let options = StoreOptions {
            timeframe_ms: spec.timeframe_ms,
            time_origin: spec.time_origin,
            max_bars: spec.max_bars,
        };
        let empty = ModelDataState::new_with_memory(options, Vec::new(), self.memory.clone())?;
        let mut seed = IndicatorEngine::new_with_memory(
            IndicatorEngineOptions::default(),
            self.memory.clone(),
        )?;
        for study in document_array(spec, "indicators")? {
            let study = record(study, "Workspace: object required")?;
            seed.add(
                empty.store(),
                host,
                required(study, "id")?,
                required(study, "name")?,
                required(study, "params")?,
            )?;
        }
        let (_, mut snapshots, mut snapshot_memory) =
            seed.capture_native_entries_with_memory(empty.store(), &self.memory)?;
        drop(seed);
        drop(empty);
        for snapshot in &mut snapshots {
            let replaced_array_bytes = snapshot
                .arrays
                .iter()
                .try_fold(0usize, |total, values| {
                    values
                        .capacity()
                        .checked_mul(std::mem::size_of::<f64>())
                        .and_then(|bytes| total.checked_add(bytes))
                })
                .and_then(|bytes| {
                    snapshot
                        .arrays
                        .capacity()
                        .checked_mul(std::mem::size_of::<Vec<f64>>())
                        .and_then(|headers| bytes.checked_add(headers))
                })
                .ok_or_else(|| self.memory.allocation_failure().into_js_error())?;
            let (mut arrays, arrays_memory) = self
                .memory
                .try_vec_capacity(snapshot.definition.outputs.len())
                .map_err(|failure| failure.into_js_error())?;
            snapshot_memory
                .absorb(arrays_memory)
                .map_err(|failure| failure.into_js_error())?;
            for _ in snapshot.definition.outputs {
                let (output, output_memory) = self
                    .memory
                    .try_vec_filled(spec.plan.capacity, f64::NAN)
                    .map_err(|failure| failure.into_js_error())?;
                snapshot_memory
                    .absorb(output_memory)
                    .map_err(|failure| failure.into_js_error())?;
                arrays.push(output);
            }
            snapshot.arrays = arrays;
            let retained = snapshot_memory
                .requested_bytes()
                .checked_sub(replaced_array_bytes as u64)
                .ok_or_else(|| type_error("Native workspace indicator memory"))?;
            snapshot_memory
                .try_resize(retained as usize)
                .map_err(|failure| failure.into_js_error())?;
            snapshot.checkpoints.clear();
            snapshot.revision = 0.0;
            snapshot.dirty = 0;
            snapshot.dirty_to = Some(spec.length);
            snapshot.invalidated = true;
            snapshot.length = 0;
            snapshot.computed_from = None;
            snapshot.computed_until = None;
            snapshot.prepared_version = None;
        }
        let store = self.data.as_ref().expect("indicator init has data").store();
        let mut engine = IndicatorEngine::new_with_memory(
            IndicatorEngineOptions::default(),
            self.memory.clone(),
        )?;
        let stage = engine.stage_native_restore_with_memory(store, snapshots, snapshot_memory)?;
        engine.publish_native_restore(store, stage)?;
        for study in document_array(spec, "indicators")? {
            let study = record(study, "Workspace: object required")?;
            validate_indicator_layout(&engine, study)?;
        }
        Ok(engine)
    }

    fn validate_extent(&self) -> Result<(), JsError> {
        let spec = self.spec()?;
        let source = record(
            required(document_record(spec)?, "source")?,
            "Workspace: object required",
        )?;
        let columns = self.columns.as_ref().expect("extent owns columns");
        let valid = if spec.length == 0 {
            matches!(required(source, "firstTime")?, JsValue::Null)
                && matches!(required(source, "lastTime")?, JsValue::Null)
        } else {
            matches!(required(source, "firstTime")?, JsValue::Number(value) if value.to_bits() == columns.time[0].to_bits())
                && matches!(required(source, "lastTime")?, JsValue::Number(value) if value.to_bits() == columns.time[spec.length - 1].to_bits())
        };
        if valid {
            Ok(())
        } else {
            Err(type_error("Native workspace target source extent"))
        }
    }

    fn install_series(&mut self) -> Result<(), JsError> {
        let source_series = document_array(self.spec()?, "series")?;
        let (mut series, mut series_memory) = self
            .memory
            .try_vec_capacity(source_series.len())
            .map_err(|failure| failure.into_js_error())?;
        let mut series_scope = self.memory.scope();
        for value in source_series {
            series.push(
                value
                    .try_clone_scoped(&mut series_scope)
                    .map_err(|failure| failure.into_js_error())?,
            );
        }
        let series_bytes = usize::try_from(series_scope.requested_bytes())
            .map_err(|_| self.memory.allocation_failure().into_js_error())?;
        series_memory
            .absorb(
                series_scope
                    .split_persistent(series_bytes)
                    .map_err(|failure| failure.into_js_error())?,
            )
            .map_err(|failure| failure.into_js_error())?;
        let data = self.data.as_ref().expect("series has data");
        let engine = self.indicators.as_ref().expect("series has engine");
        let studies = document_array(self.spec()?, "indicators")?;
        let (mut projections, projections_memory) = self
            .memory
            .try_vec_capacity(studies.len())
            .map_err(|failure| failure.into_js_error())?;
        for study in studies {
            let study = record(study, "Workspace: object required")?;
            let entry = engine
                .entry(required(study, "id")?)
                .expect("entry id came from engine");
            projections.push(IndicatorProjection {
                id: entry.id(),
                definition: entry.definition(),
            });
        }
        let context = ModelContext {
            store: data.store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        let model = self.model.as_mut().expect("series has model");
        for value in series {
            model.add_series(&value, &context)?;
        }
        drop((series_memory, projections_memory));
        Ok(())
    }

    fn begin_series_index(&mut self) -> Result<(), JsError> {
        self.series_blocked = self.spec()?.length >= SERIES_BLOCK_THRESHOLD;
        let capacity = if self.series_blocked {
            usize::max(1, self.spec()?.plan.capacity / SERIES_BLOCK_SIZE)
        } else {
            self.spec()?.plan.capacity
        };
        let (builder, memory) = if self.series_blocked {
            RangeIndexBuilder::new_with_memory(capacity, false, true, &self.memory)?
        } else {
            RangeIndexBuilder::new_with_memory(capacity, true, false, &self.memory)?
        };
        self.series_index_builder = Some(builder);
        self.series_index_memory = Some(memory);
        self.series_values_done = 0;
        self.series_merge_done = 0;
        self.block_min = f64::INFINITY;
        self.block_max = f64::NEG_INFINITY;
        self.block_finite = 0;
        Ok(())
    }

    fn series_revision(&self, series_index: usize) -> Result<f64, JsError> {
        let series = &self.model_ref()?.series[series_index];
        if let Some(id) = &series.indicator {
            let mut scope = self.memory.scope();
            let lookup = id
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            return self
                .indicators_ref()?
                .entry(&JsValue::String(lookup))
                .map(|entry| entry.revision())
                .ok_or_else(|| ordinary_error("Missing indicator"));
        }
        Ok(series.values_revision.unwrap_or_else(|| {
            self.data
                .as_ref()
                .expect("indices have data")
                .store()
                .version()
        }))
    }

    fn finish_series_index(&mut self) -> Result<(), JsError> {
        let length = self.spec()?.length;
        let capacity = self.spec()?.plan.capacity;
        let leaves = if self.series_blocked {
            length.div_ceil(SERIES_BLOCK_SIZE)
        } else {
            length
        };
        let tree = self
            .series_index_builder
            .take()
            .expect("indices own builder")
            .finish(leaves)?;
        let index_memory = self
            .series_index_memory
            .take()
            .expect("indices own builder memory");
        let prebuilt = if self.series_blocked {
            NativePrebuiltSeriesCache::Block {
                index: BlockRangeIndex::from_owned_tree(length, capacity, SERIES_BLOCK_SIZE, tree)?,
            }
        } else {
            NativePrebuiltSeriesCache::Flat { tree, length }
        };
        let mut id_scope = self.memory.scope();
        let id = self.model_ref()?.series[self.index_series]
            .id
            .try_clone_scoped(&mut id_scope)
            .map_err(|failure| failure.into_js_error())?;
        let revision = self.series_revision(self.index_series)?;
        let store = self.data.as_ref().expect("indices have data").store();
        self.series_caches
            .as_mut()
            .expect("indices have caches")
            .install_prebuilt_with_memory(&id, store, prebuilt, index_memory)?;
        let series =
            &mut self.model.as_mut().expect("indices have model").series[self.index_series];
        series.revision = Some(revision);
        series.dirty_from = f64::INFINITY;
        series.range_index_ready = true;
        self.series_values_done = 0;
        self.series_merge_done = 0;
        self.series_blocked = false;
        Ok(())
    }

    fn install_workspace(&mut self, host: &dyn Host) -> Result<(), JsError> {
        let mut drawing_scope = self.memory.scope();
        let drawings_value = required(document_record(self.spec()?)?, "drawings")?
            .try_clone_scoped(&mut drawing_scope)
            .map_err(|failure| failure.into_js_error())?;
        let drawing_bytes = stringify_json_scoped(
            &drawings_value,
            JsonMode::Standard,
            self.dialect,
            &mut drawing_scope,
        )
        .map_err(|failure| failure.into_js_error())?;
        let drawing_text = JsString::try_from_str(
            std::str::from_utf8(&drawing_bytes).expect("drawing JSON writer emits UTF-8"),
            &mut drawing_scope,
        )
        .map_err(|failure| failure.into_js_error())?;
        let model = self.model.as_ref().expect("install has model");
        let validate_panel =
            |panel: &JsString| Ok(model.panels.iter().any(|candidate| candidate.id == *panel));
        let drawing_memory = self.memory.clone();
        let validate_binding = |drawing: &crate::drawing_types::Drawing| {
            let mut scope = drawing_memory.scope();
            let value = drawing.to_value_scoped(&mut scope)?;
            model.validate_drawing_binding(&value, false)
        };
        let drawings = self.drawings.as_mut().expect("install has drawings");
        let config = drawings.config();
        let (items, items_memory) = load_drawing_document_with_memory(
            &drawing_text,
            DrawingDocumentLimits {
                max_drawings: config.max_drawings,
                max_points: config.max_points,
                max_document_chars: config.max_document_chars,
            },
            self.dialect,
            &DrawingDocumentContext {
                validate_panel: Some(&validate_panel),
                validate_binding: Some(&validate_binding),
                style_decoder: None,
            },
            false,
            &self.memory,
        )?;
        let frame = DrawingFrame::try_from_vec(items, items_memory)?;
        drawings.install_workspace_frame(frame)?;

        let context = WorkspaceContext {
            host,
            model: self.model.as_ref().expect("install has model"),
            store: self.data.as_ref().expect("install has data").store(),
            indicators: self.indicators.as_ref().expect("install has indicators"),
            drawings: self.drawings.as_ref().expect("install has drawings"),
            symbol: self.symbol.as_ref().map(|symbol| WorkspaceSymbol {
                symbol: &symbol.symbol,
                provider: symbol.provider.as_ref(),
                adjustment_version: symbol.adjustment_version.as_ref(),
            }),
            symbol_formatters: self.symbol_formatters,
            interaction: WorkspaceInteraction::default(),
            dialect: self.dialect,
        };
        let (saved, saved_memory) =
            save_workspace_with_memory(&context, &self.spec()?.binding, None, &self.memory)?;
        let parsed = read_workspace_document_with_memory(
            &JsValue::String(saved),
            host,
            self.dialect,
            &self.memory,
        )?;
        if !same_value(parsed.value(), self.spec()?.document.value()) {
            return Err(type_error("Native workspace canonical restore mismatch"));
        }
        drop((parsed, saved_memory));
        Ok(())
    }

    fn active(&self) -> Result<(), JsError> {
        if self.closed {
            Err(ordinary_error("Native workspace target closed"))
        } else {
            Ok(())
        }
    }

    fn spec(&self) -> Result<&NativeWorkspaceSpec, JsError> {
        self.spec
            .as_ref()
            .ok_or_else(|| ordinary_error("Native workspace target closed"))
    }

    fn model_ref(&self) -> Result<&ModelState, JsError> {
        self.model
            .as_ref()
            .ok_or_else(|| ordinary_error("Native workspace target closed"))
    }

    fn indicators_ref(&self) -> Result<&IndicatorEngine, JsError> {
        self.indicators
            .as_ref()
            .ok_or_else(|| ordinary_error("Native workspace target closed"))
    }
}

fn series_values_for<'a>(
    model: &'a ModelState,
    indicators: &'a IndicatorEngine,
    data: &'a ModelDataState,
    memory: &MemoryContext,
    series_index: usize,
) -> Result<&'a [f64], JsError> {
    let series = &model.series[series_index];
    if let Some(id) = &series.indicator {
        let mut scope = memory.scope();
        let lookup = id
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let entry = indicators
            .entry(&JsValue::String(lookup))
            .ok_or_else(|| ordinary_error("Missing indicator"))?;
        let output = match &series.output {
            Some(output) => {
                scope
                    .try_grow(output.len_utf16().saturating_mul(3))
                    .map_err(|failure| failure.into_js_error())?;
                Cow::Owned(output.to_string_lossy())
            }
            None => Cow::Borrowed(entry.definition().outputs[0]),
        };
        return entry
            .output_capacity(&output)
            .ok_or_else(|| ordinary_error("Missing indicator output"));
    }
    if let Some(values) = &series.values {
        return Ok(values);
    }
    let source = match series.source_value() {
        Some(JsValue::String(value)) => Some(value),
        _ => None,
    };
    let columns = data.store().columns();
    Ok(if source.is_some_and(|value| text_eq(value, "time")) {
        &columns.time
    } else if source.is_some_and(|value| text_eq(value, "open")) {
        &columns.open
    } else if source.is_some_and(|value| text_eq(value, "high")) {
        &columns.high
    } else if source.is_some_and(|value| text_eq(value, "low")) {
        &columns.low
    } else if source.is_some_and(|value| text_eq(value, "volume")) {
        &columns.volume
    } else {
        &columns.close
    })
}

fn validate_indicator_layout(engine: &IndicatorEngine, study: &JsObject) -> Result<(), JsError> {
    let id = required(study, "id")?;
    let entry = engine
        .entry(id)
        .expect("indicator definition was installed");
    if !same_value(entry.params(), required(study, "params")?) {
        return Err(type_error("Native workspace target factory binding"));
    }
    let expected_outputs = array(required(study, "outputs")?, "Indicator outputs array")?;
    if expected_outputs.len() != entry.definition().outputs.len()
        || expected_outputs
            .iter()
            .zip(entry.definition().outputs)
            .any(|(expected, actual)| {
                !matches!(expected, JsValue::String(value) if text_eq(value, actual))
            })
    {
        return Err(type_error("Native workspace target factory binding"));
    }
    let offsets = record(required(study, "plotOffsets")?, "Indicator offsets object")?;
    if entry.definition().outputs.iter().any(|output| {
        let expected = get(offsets, output).and_then(|value| match value {
            JsValue::Number(value) => Some(*value),
            _ => None,
        });
        let actual = entry.definition().effective_plot_offset(output);
        expected.unwrap_or(0.0).to_bits() != actual.to_bits()
            || expected.is_none() && actual.to_bits() != 0.0f64.to_bits()
    }) {
        return Err(type_error("Native workspace target factory binding"));
    }
    Ok(())
}

fn progress(
    phase: &'static str,
    done: usize,
    total: usize,
    complete: bool,
) -> NativeWorkspaceTargetProgress {
    NativeWorkspaceTargetProgress {
        phase,
        done,
        total,
        complete,
    }
}

fn document_record(spec: &NativeWorkspaceSpec) -> Result<&JsObject, JsError> {
    record(spec.document.value(), "Workspace: object required")
}

fn document_array<'a>(spec: &'a NativeWorkspaceSpec, name: &str) -> Result<&'a [JsValue], JsError> {
    array(
        required(document_record(spec)?, name)?,
        "Workspace array required",
    )
}

fn model_from_document(
    spec: &NativeWorkspaceSpec,
    store: &crate::data::BarStore,
) -> Result<ModelState, JsError> {
    let mut scope = store.memory_context().scope();
    let document = document_record(spec)?;
    let chart = record(required(document, "chart")?, "Workspace: object required")?;
    let view = record(required(chart, "view")?, "Workspace: object required")?;
    let from = match required(view, "from")? {
        JsValue::Number(value) => *value,
        _ => return Err(range_error("Visible range")),
    };
    let to = match required(view, "to")? {
        JsValue::Number(value) => *value,
        _ => return Err(range_error("Visible range")),
    };
    scope
        .try_grow(6 * (std::mem::size_of::<(JsString, JsValue)>() + 64))
        .map_err(|failure| failure.into_js_error())?;
    let options = object([
        (
            "panels",
            required(chart, "panels")?
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        (
            "axes",
            required(chart, "axes")?
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        (
            "theme",
            required(chart, "theme")?
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        ("visibleBars", JsValue::Number(js_max(&[to - from, 1.0]))),
        (
            "axisWidth",
            required(chart, "axisWidth")?
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        (
            "precision",
            required(chart, "precision")?
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    ]);
    let mut model = ModelState::new(store, &options)?;
    model.publish_view_replacement(
        VisibleRange { from, to },
        matches!(required(chart, "follow")?, JsValue::Bool(true)),
    );
    Ok(model)
}

fn symbol_from_document(
    spec: &NativeWorkspaceSpec,
    host: &dyn Host,
    memory: &MemoryContext,
) -> Result<(Option<NativeWorkspaceSymbol>, MemoryGroup), JsError> {
    let chart = record(
        required(document_record(spec)?, "chart")?,
        "Workspace: object required",
    )?;
    let value = required(chart, "symbol")?;
    if matches!(value, JsValue::Null) {
        return Ok((None, MemoryGroup::empty(memory.clone())));
    }
    let mut scope = memory.scope();
    let value = record(value, "Workspace symbol: object required")?;
    let mut string = |name| match required(value, name)? {
        JsValue::String(value) => value
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error()),
        _ => Err(type_error("Invalid symbol metadata")),
    };
    let adjustment = match string("adjustment")?.to_string_lossy().as_str() {
        "raw" => Adjustment::Raw,
        "split" => Adjustment::Split,
        "total-return" => Adjustment::TotalReturn,
        _ => return Err(type_error("Invalid symbol metadata")),
    };
    let price_decimals = match required(value, "priceDecimals")? {
        JsValue::Number(value) => *value as u32,
        _ => return Err(type_error("Invalid symbol metadata")),
    };
    let tick_size = match required(value, "tickSize")? {
        JsValue::Number(value) => *value,
        _ => return Err(type_error("Invalid symbol metadata")),
    };
    let symbol = crate::markets::validate_symbol(
        host,
        Symbol {
            id: string("id")?,
            exchange: string("exchange")?,
            timezone: string("timezone")?,
            currency: string("currency")?,
            volume_unit: string("volumeUnit")?,
            price_decimals,
            tick_size,
            adjustment,
        },
    )?;
    let symbol = NativeWorkspaceSymbol {
        symbol,
        provider: match get(value, "provider") {
            Some(JsValue::String(value)) => Some(
                value
                    .try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            _ => None,
        },
        adjustment_version: match get(value, "adjustmentVersion") {
            Some(JsValue::String(value)) => Some(
                value
                    .try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            _ => None,
        },
    };
    let bytes = usize::try_from(scope.requested_bytes())
        .map_err(|_| memory.allocation_failure().into_js_error())?;
    let group = scope
        .split_persistent(bytes)
        .map_err(|failure| failure.into_js_error())?;
    Ok((Some(symbol), group))
}

fn document_symbol_formatters(spec: &NativeWorkspaceSpec) -> Result<bool, JsError> {
    let chart = record(
        required(document_record(spec)?, "chart")?,
        "Workspace: object required",
    )?;
    Ok(matches!(get(chart, "formatters"), Some(JsValue::String(value)) if text_eq(value, "symbol")))
}

fn same_value(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => left.to_bits() == right.to_bits(),
        (JsValue::String(left), JsValue::String(right)) => left == right,
        (JsValue::Array(left), JsValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_value(left, right))
        }
        (JsValue::Object(left), JsValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|right| same_value(value, right))
                })
        }
        _ => false,
    }
}
