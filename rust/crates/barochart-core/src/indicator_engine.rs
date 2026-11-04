//! 지표 entry의 lazy invalidation, checkpoint 재생과 중단 가능한 계산을 관리한다.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::contracts::{RESOURCE_LIMITS, identifier, js_to_string_with};
use crate::data::{BarStore, ChangeKind, DataChange, DataIdentity};
use crate::indicator_dispatch::{self, IndicatorState};
use crate::indicator_helpers::{canonical_checkpoint, exact_state_equal};
use crate::indicator_params::validate_indicator_params;
use crate::indicator_registry::IndicatorRegistry;
use crate::indicator_types::{CreatedIndicator, IndicatorDefinition, IndicatorProgram};

const DEFAULT_CHECKPOINT_SIZE: usize = 256;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 268_435_456;
const MAX_OUTPUT_BYTES: usize = 536_870_912;
const DEFAULT_CALCULATION_CHUNK: f64 = 4_096.0;
const MAX_CALCULATION_CHUNK: f64 = 65_536.0;
const MAX_CALCULATION_DEPTH: usize = 32;

fn error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, JsString::from_str(message))
}

fn ordinary_error(message: &str) -> JsError {
    error("Error", message)
}

fn type_error(message: &str) -> JsError {
    error("TypeError", message)
}

fn range_error(message: &str) -> JsError {
    error("RangeError", message)
}

fn calculation_error(name: &'static str, message: &str) -> JsError {
    error(name, message)
}

fn value_message(prefix: &str, value: &JsValue) -> Result<JsError, JsError> {
    let value = js_to_string_with(value, NumberDialect::PLATFORM)?;
    let mut message = prefix.encode_utf16().collect::<Vec<_>>();
    message.extend_from_slice(value.as_units());
    Ok(JsError::new("Error", JsString::from_utf16(message)))
}

/// 계산 checkpoint 간격과 전체 출력 capacity 예산이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndicatorEngineOptions {
    /// checkpoint block 크기다.
    pub checkpoint_size: usize,
    /// 모든 entry를 현재 store capacity로 키울 때의 최대 출력 바이트다.
    pub max_output_bytes: usize,
}

impl Default for IndicatorEngineOptions {
    fn default() -> Self {
        Self {
            checkpoint_size: DEFAULT_CHECKPOINT_SIZE,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }
}

enum IndicatorPrototype {
    Average(Box<crate::indicators_average::AverageState>),
    Momentum(Box<crate::indicators_momentum::MomentumState>),
    Session(Box<crate::session_studies::SessionState>),
    Recreate {
        program: IndicatorProgram,
        first: Option<IndicatorState>,
    },
}

impl IndicatorPrototype {
    fn new(state: IndicatorState, program: IndicatorProgram) -> Self {
        match state {
            IndicatorState::Average(state) => Self::Average(state),
            IndicatorState::Momentum(state) => Self::Momentum(state),
            IndicatorState::Session(state) => Self::Session(state),
            state @ (IndicatorState::Volume(_) | IndicatorState::Pressure(_)) => Self::Recreate {
                program,
                first: Some(state),
            },
        }
    }

    fn fresh(&mut self, params: &JsValue, host: &dyn Host) -> Result<IndicatorState, JsError> {
        Ok(match self {
            Self::Average(state) => IndicatorState::Average(Box::new((**state).clone())),
            Self::Momentum(state) => IndicatorState::Momentum(Box::new((**state).clone())),
            Self::Session(state) => IndicatorState::Session(Box::new((**state).clone())),
            Self::Recreate { program, first } => match first.take() {
                Some(state) => state,
                None => indicator_dispatch::create(*program, params, host)?.state,
            },
        })
    }
}

struct IndicatorEntry {
    identity: Arc<u8>,
    id: JsString,
    name: JsString,
    definition: IndicatorDefinition,
    params: JsValue,
    prototype: IndicatorPrototype,
    dirty: usize,
    dirty_to: Option<usize>,
    invalidated: bool,
    length: usize,
    arrays: Vec<Vec<f64>>,
    arrays_epoch: u64,
    checkpoints: BTreeMap<usize, JsValue>,
    checkpoints_epoch: u64,
    revision: f64,
    computed_from: Option<usize>,
    computed_until: Option<usize>,
    prepared_version: Option<f64>,
    generation: Option<Arc<u8>>,
    running: Option<Arc<u8>>,
}

/// 모델과 bridge가 entry를 바꾸지 않고 읽는 view다.
#[derive(Clone, Copy)]
pub struct IndicatorEntryView<'a> {
    entry: &'a IndicatorEntry,
}

impl std::fmt::Debug for IndicatorEntryView<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IndicatorEntryView")
            .field("id", &self.entry.id)
            .field("name", &self.entry.name)
            .field("dirty", &self.entry.dirty)
            .field("revision", &self.entry.revision)
            .finish()
    }
}

impl<'a> IndicatorEntryView<'a> {
    /// entry id다.
    pub fn id(self) -> &'a JsString {
        &self.entry.id
    }

    /// canonical program 이름이다.
    pub fn name(self) -> &'a JsString {
        &self.entry.name
    }

    /// immutable definition이다.
    pub fn definition(self) -> &'a IndicatorDefinition {
        &self.entry.definition
    }

    /// source 선언 순서로 정리된 raw params 객체다.
    pub fn params(self) -> &'a JsValue {
        &self.entry.params
    }

    /// 다음 계산 시작 후보다.
    pub fn dirty(self) -> usize {
        self.entry.dirty
    }

    /// 수렴을 시작할 수 있는 마지막 변경 경계다.
    pub fn dirty_to(self) -> Option<usize> {
        self.entry.dirty_to
    }

    /// suffix 재사용이 금지됐는지 본다.
    pub fn invalidated(self) -> bool {
        self.entry.invalidated
    }

    /// 마지막 clean 계산 길이다.
    pub fn length(self) -> usize {
        self.entry.length
    }

    /// clean revision이다.
    pub fn revision(self) -> f64 {
        self.entry.revision
    }

    /// 마지막 계산 시작 경계다.
    pub fn computed_from(self) -> Option<usize> {
        self.entry.computed_from
    }

    /// 수렴 또는 전체 계산 종료 경계다.
    pub fn computed_until(self) -> Option<usize> {
        self.entry.computed_until
    }

    /// restore publication이 현재 store version을 이미 준비했으면 그 값이다.
    pub fn prepared_version(self) -> Option<f64> {
        self.entry.prepared_version
    }

    /// 현재 checkpoint index를 오름차순으로 복사한다.
    pub fn checkpoint_keys(self) -> Vec<usize> {
        self.entry.checkpoints.keys().copied().collect()
    }

    /// checkpoint wire state를 key order 그대로 빌린다.
    pub fn checkpoint(self, index: usize) -> Option<&'a JsValue> {
        self.entry.checkpoints.get(&index)
    }

    /// capacity 전체 출력 버퍼를 읽는다. 실패 중 부분 write 검증에도 쓴다.
    pub fn output_capacity(self, output: &str) -> Option<&'a [f64]> {
        self.entry
            .definition
            .outputs
            .iter()
            .position(|candidate| *candidate == output)
            .and_then(|index| self.entry.arrays.get(index))
            .map(Vec::as_slice)
    }
}

/// clean 계산 결과를 entry storage에서 빌린 view다.
#[derive(Clone, Copy, Debug)]
pub struct IndicatorRead<'a> {
    entry: IndicatorEntryView<'a>,
    length: usize,
}

impl<'a> IndicatorRead<'a> {
    /// immutable definition이다.
    pub fn definition(self) -> &'a IndicatorDefinition {
        self.entry.definition()
    }

    /// source output 순서의 이름이다.
    pub fn output_names(self) -> &'static [&'static str] {
        self.entry.entry.definition.outputs
    }

    /// 이름으로 논리 길이만큼의 raw f64 출력 slice를 찾는다.
    pub fn output(self, output: &str) -> Option<&'a [f64]> {
        self.entry
            .output_capacity(output)
            .map(|values| &values[..self.length])
    }

    /// source output index로 논리 길이 slice를 빌린다.
    pub fn output_at(self, index: usize) -> Option<&'a [f64]> {
        self.entry
            .entry
            .arrays
            .get(index)
            .map(|values| &values[..self.length])
    }

    /// clean revision이다.
    pub fn revision(self) -> f64 {
        self.entry.revision()
    }

    /// 이번 clean 계산의 시작 경계다.
    pub fn computed_from(self) -> usize {
        self.entry.computed_from().unwrap_or(0)
    }

    /// 이번 clean 계산의 종료/수렴 경계다.
    pub fn computed_until(self) -> usize {
        self.entry.computed_until().unwrap_or(self.length)
    }

    /// 논리 출력 길이다.
    pub fn len(self) -> usize {
        self.length
    }

    /// 출력이 비었는지 본다.
    pub fn is_empty(self) -> bool {
        self.length == 0
    }
}

/// Staging과 publish가 공유하는 indicator metadata 영수증이다.
#[derive(Clone, Debug)]
pub struct IndicatorPublishReceipt {
    /// 대상 entry id다.
    pub id: JsString,
    /// canonical program 이름이다.
    pub name: JsString,
    /// factory 선언 순서로 정리한 raw params다.
    pub params: JsValue,
    /// 출력 이름 순서다.
    pub outputs: Vec<JsString>,
    /// 실제 own plot offset 필드 순서다.
    pub plot_offsets: Vec<(JsString, f64)>,
    /// false면 same-params no-op라 entry identity를 바꾸지 않는다.
    pub changed: bool,
}

impl IndicatorPublishReceipt {
    fn from_entry(entry: &IndicatorEntry, changed: bool) -> Self {
        Self {
            id: entry.id.clone(),
            name: entry.name.clone(),
            params: entry.params.clone(),
            outputs: entry
                .definition
                .outputs
                .iter()
                .map(|output| JsString::from_str(output))
                .collect(),
            plot_offsets: entry
                .definition
                .plot_offsets
                .iter()
                .map(|offset| (JsString::from_str(offset.output), offset.value))
                .collect(),
            changed,
        }
    }
}

/// Study series staging이 새 definition만 빌리는 view다.
#[derive(Clone, Copy)]
pub struct IndicatorStageEntryView<'a> {
    /// candidate id다.
    pub id: &'a JsString,
    /// 계산과 binding 검증을 끝낸 definition이다.
    pub definition: &'a IndicatorDefinition,
}

struct EngineEntrySnapshot {
    id: JsString,
    identity: Arc<u8>,
}

/// Compaction 전후 같은 entry order/identity를 보장하는 restart plan이다.
pub struct IndicatorRestartPlan {
    engine_identity: Arc<u8>,
    entries: Vec<EngineEntrySnapshot>,
}

enum StagedIndicatorOperation {
    Add {
        entry: IndicatorEntry,
        receipt: IndicatorPublishReceipt,
    },
    Replace {
        previous: Arc<u8>,
        entry: IndicatorEntry,
        receipt: IndicatorPublishReceipt,
    },
    Noop {
        receipt: IndicatorPublishReceipt,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IndicatorStagePurpose {
    Unknown,
    Studies,
    Params,
}

impl StagedIndicatorOperation {
    fn id(&self) -> &JsString {
        match self {
            Self::Add { receipt, .. } | Self::Replace { receipt, .. } | Self::Noop { receipt } => {
                &receipt.id
            }
        }
    }

    fn receipt(&self) -> &IndicatorPublishReceipt {
        match self {
            Self::Add { receipt, .. } | Self::Replace { receipt, .. } | Self::Noop { receipt } => {
                receipt
            }
        }
    }
}

/// 실제 engine entry를 건드리지 않고 계산 후보를 소유하는 transaction이다.
pub struct IndicatorEngineStage {
    engine_identity: Arc<u8>,
    source: SourceFingerprint,
    entries: Vec<EngineEntrySnapshot>,
    registry_names: Vec<&'static str>,
    projected_entries: usize,
    projected_outputs: usize,
    purpose: IndicatorStagePurpose,
    operations: Vec<StagedIndicatorOperation>,
}

impl IndicatorEngineStage {
    /// 빈 study 문서도 study surface stale 문구를 유지한다.
    pub fn mark_studies(&mut self) {
        self.purpose = IndicatorStagePurpose::Studies;
    }

    /// stage 호출 순서의 영수증을 빌린다.
    pub fn receipts(&self) -> impl Iterator<Item = &IndicatorPublishReceipt> {
        self.operations
            .iter()
            .map(StagedIndicatorOperation::receipt)
    }

    /// 새 계산 후보만 doc 순서로 순회한다. no-op은 definition이 바뀌지 않아 제외한다.
    pub fn candidates(&self) -> impl Iterator<Item = IndicatorStageEntryView<'_>> {
        self.operations
            .iter()
            .filter_map(|operation| match operation {
                StagedIndicatorOperation::Add { entry, .. }
                | StagedIndicatorOperation::Replace { entry, .. } => {
                    Some(IndicatorStageEntryView {
                        id: &entry.id,
                        definition: &entry.definition,
                    })
                }
                StagedIndicatorOperation::Noop { .. } => None,
            })
    }
}

/// 한 generator step의 결과다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CalculationStep {
    /// chunk 경계에서 running을 놓고 중단했다.
    Yield {
        /// 이번 generation의 재생 시작 경계다.
        from: usize,
        /// 지금까지 처리한 반열린 경계다.
        to: usize,
        /// 시작할 때 고정한 source 길이다.
        total: usize,
    },
    /// clean metadata를 게시하고 끝났다.
    Complete {
        /// 게시한 revision이다.
        revision: f64,
        /// 재생 시작 경계다.
        computed_from: usize,
        /// 계산 또는 수렴 종료 경계다.
        computed_until: usize,
    },
    /// 이미 완료됐거나 오류로 닫힌 generator다.
    Exhausted,
}

#[derive(Clone)]
struct SourceFingerprint {
    identity: DataIdentity,
    serial: f64,
    version: f64,
    length: usize,
    capacity: usize,
    columns: [usize; 6],
}

impl SourceFingerprint {
    fn capture(store: &BarStore) -> Self {
        let columns = store.columns();
        Self {
            identity: store.data_identity(),
            serial: store.serial(),
            version: store.version(),
            length: store.length(),
            capacity: store.capacity(),
            columns: [
                columns.time.as_ptr() as usize,
                columns.open.as_ptr() as usize,
                columns.high.as_ptr() as usize,
                columns.low.as_ptr() as usize,
                columns.close.as_ptr() as usize,
                columns.volume.as_ptr() as usize,
            ],
        }
    }

    fn matches(&self, store: &BarStore) -> bool {
        let current = Self::capture(store);
        self.identity.matches(&current.identity)
            && self.serial == current.serial
            && self.version == current.version
            && self.length == current.length
            && self.capacity == current.capacity
            && self.columns == current.columns
    }
}

struct ActiveCalculation {
    engine_identity: Arc<u8>,
    token: Arc<u8>,
    entry_identity: Arc<u8>,
    id: JsString,
    source: SourceFingerprint,
    arrays_epoch: u64,
    checkpoints_epoch: u64,
    start: usize,
    next: usize,
    total: usize,
    block: usize,
    chunk_size: usize,
    state: IndicatorState,
    reuse: bool,
    dirty_to: usize,
    revision: f64,
    computed_from: usize,
    computed_until: usize,
    calculated: bool,
}

enum CalculationState {
    Pending {
        engine_identity: Arc<u8>,
        id: JsValue,
        chunk_size: f64,
    },
    Active(Box<ActiveCalculation>),
    Returned,
    Exhausted,
}

/// engine을 빌리지 않고 yield 사이에 보관할 수 있는 독립 계산 token이다.
pub struct IndicatorCalculation {
    state: CalculationState,
}

impl IndicatorCalculation {
    /// generator의 다음 chunk를 실행한다.
    pub fn step(
        &mut self,
        engine: &mut IndicatorEngine,
        store: &BarStore,
        host: &dyn Host,
    ) -> Result<CalculationStep, JsError> {
        let state = std::mem::replace(&mut self.state, CalculationState::Exhausted);
        match state {
            CalculationState::Pending {
                engine_identity,
                id,
                chunk_size,
            } => match engine.start_calculation(&engine_identity, id, chunk_size, store, host) {
                Ok(StartCalculation::Immediate(step)) => {
                    self.state = CalculationState::Returned;
                    Ok(step)
                }
                Ok(StartCalculation::Active(mut active)) => {
                    let result = engine.run_active(&mut active, store, host);
                    match result {
                        Ok(step @ CalculationStep::Yield { .. }) => {
                            self.state = CalculationState::Active(active);
                            Ok(step)
                        }
                        Ok(step) => {
                            self.state = CalculationState::Returned;
                            Ok(step)
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            },
            CalculationState::Active(mut active) => {
                let result = engine.run_active(&mut active, store, host);
                match result {
                    Ok(step @ CalculationStep::Yield { .. }) => {
                        self.state = CalculationState::Active(active);
                        Ok(step)
                    }
                    Ok(step) => {
                        self.state = CalculationState::Returned;
                        Ok(step)
                    }
                    Err(error) => Err(error),
                }
            }
            CalculationState::Returned => {
                self.state = CalculationState::Exhausted;
                Ok(CalculationStep::Exhausted)
            }
            CalculationState::Exhausted => Ok(CalculationStep::Exhausted),
        }
    }
}

enum StartCalculation {
    Immediate(CalculationStep),
    Active(Box<ActiveCalculation>),
}

/// 한 model의 고정 registry와 insertion-ordered indicator entry를 소유한다.
pub struct IndicatorEngine {
    options: IndicatorEngineOptions,
    registry: IndicatorRegistry,
    entries: Vec<IndicatorEntry>,
    calculation_depth: usize,
    identity: Arc<u8>,
}

impl IndicatorEngine {
    /// 옵션을 검증하고 35 builtin과 정적 pressure가 등록된 runtime을 만든다.
    pub fn new(options: IndicatorEngineOptions) -> Result<Self, JsError> {
        if options.checkpoint_size == 0 {
            return Err(range_error("Checkpoint size"));
        }
        if options.max_output_bytes > MAX_OUTPUT_BYTES {
            return Err(range_error("Indicator output byte limit"));
        }
        let mut registry = IndicatorRegistry::new();
        registry.register_volume_direction_v1();
        Ok(Self {
            options,
            registry,
            entries: Vec::new(),
            calculation_depth: 0,
            identity: Arc::new(0),
        })
    }

    /// runtime registry 행 수다. 새 엔진은 pressure를 포함해 36이다.
    pub fn registry_len(&self) -> usize {
        self.registry.len()
    }

    /// 고정 runtime registry를 읽는다.
    pub fn registry(&self) -> &IndicatorRegistry {
        &self.registry
    }

    /// checkpoint block 크기다.
    pub fn checkpoint_size(&self) -> usize {
        self.options.checkpoint_size
    }

    /// 출력 capacity 예산이다.
    pub fn max_output_bytes(&self) -> usize {
        self.options.max_output_bytes
    }

    /// 현재 insertion-ordered entry 수다.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// entry가 비었는지 본다.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// runtime registry 이름을 source 순서로 복사한다.
    pub fn registry_names(&self) -> Vec<&'static str> {
        self.registry.entries().map(|entry| entry.name).collect()
    }

    /// entry id를 JS Map insertion 순서로 복사한다.
    pub fn entry_ids(&self) -> Vec<JsString> {
        self.entries.iter().map(|entry| entry.id.clone()).collect()
    }

    /// read-only entry view를 찾는다. Map key처럼 비문자 값은 일치하지 않는다.
    pub fn entry(&self, id: &JsValue) -> Option<IndicatorEntryView<'_>> {
        self.entry_index(id).map(|index| IndicatorEntryView {
            entry: &self.entries[index],
        })
    }

    /// 현재 실제 entry identity/order를 compaction restart용으로 캡처한다.
    pub fn prepare_restart(&self) -> IndicatorRestartPlan {
        IndicatorRestartPlan {
            engine_identity: Arc::clone(&self.identity),
            entries: self
                .entries
                .iter()
                .map(|entry| EngineEntrySnapshot {
                    id: entry.id.clone(),
                    identity: Arc::clone(&entry.identity),
                })
                .collect(),
        }
    }

    /// restart plan이 아직 같은 engine/entry 집합을 가리키는지 본다.
    pub fn validate_restart(&self, plan: &IndicatorRestartPlan) -> bool {
        Arc::ptr_eq(&self.identity, &plan.engine_identity)
            && self.entries.len() == plan.entries.len()
            && self
                .entries
                .iter()
                .zip(&plan.entries)
                .all(|(entry, expected)| {
                    entry.id == expected.id && Arc::ptr_eq(&entry.identity, &expected.identity)
                })
    }

    /// 검증된 실제 entry들을 revision은 유지한 채 cold restart 상태로 바꾼다.
    pub fn publish_restart(
        &mut self,
        plan: IndicatorRestartPlan,
        length: usize,
    ) -> Result<(), JsError> {
        if !self.validate_restart(&plan) {
            return Err(calculation_error(
                "StaleSourceError",
                "Compaction owner or source changed",
            ));
        }
        for entry in &mut self.entries {
            entry.checkpoints.clear();
            entry.checkpoints_epoch = entry.checkpoints_epoch.wrapping_add(1);
            entry.arrays.clear();
            entry.arrays_epoch = entry.arrays_epoch.wrapping_add(1);
            entry.dirty = 0;
            entry.dirty_to = Some(length);
            entry.invalidated = true;
            entry.length = 0;
            entry.computed_from = Some(0);
            entry.computed_until = Some(0);
            entry.prepared_version = None;
        }
        Ok(())
    }

    /// 현재 source/registry/entry identity를 고정한 빈 staging transaction을 만든다.
    pub fn begin_stage(&self, store: &BarStore) -> IndicatorEngineStage {
        IndicatorEngineStage {
            engine_identity: Arc::clone(&self.identity),
            source: SourceFingerprint::capture(store),
            entries: self
                .entries
                .iter()
                .map(|entry| EngineEntrySnapshot {
                    id: entry.id.clone(),
                    identity: Arc::clone(&entry.identity),
                })
                .collect(),
            registry_names: self.registry_names(),
            projected_entries: self.entries.len(),
            projected_outputs: self
                .entries
                .iter()
                .map(|entry| entry.definition.outputs.len())
                .sum(),
            purpose: IndicatorStagePurpose::Unknown,
            operations: Vec::new(),
        }
    }

    /// additive study entry를 live engine과 분리해 cold 계산한다.
    pub fn stage_add(
        &self,
        stage: &mut IndicatorEngineStage,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        name: &JsValue,
        params: &JsValue,
    ) -> Result<IndicatorPublishReceipt, JsError> {
        self.ensure_stage_current(
            stage,
            store,
            "Study setup stale: owner changed during staging",
        )?;
        stage.purpose = IndicatorStagePurpose::Studies;
        let id = identifier(id, "Indicator id")?.clone();
        validate_indicator_params(params)?;
        if stage.projected_entries >= RESOURCE_LIMITS.max_indicators as usize {
            return Err(range_error("Indicator limit"));
        }
        if stage.entries.iter().any(|entry| entry.id == id)
            || stage
                .operations
                .iter()
                .any(|operation| operation.id() == &id)
        {
            return Err(ordinary_error("Duplicate indicator id"));
        }
        let metadata = match name {
            JsValue::String(name) => self.registry.lookup(name),
            _ => None,
        };
        let Some(metadata) = metadata else {
            return Err(value_message("Unknown indicator: ", name)?);
        };
        let created = indicator_dispatch::create(metadata.program, params, host)?;
        self.ensure_stage_current(
            stage,
            store,
            "Study setup stale: owner changed during staging",
        )?;
        let next_outputs = stage
            .projected_outputs
            .checked_add(created.definition.outputs.len())
            .ok_or_else(|| range_error("Indicator output byte limit"))?;
        self.check_staged_output_budget(next_outputs, store.capacity())?;
        let mut entry = Self::entry_from_created(
            id,
            JsString::from_str(metadata.name),
            created,
            store.length(),
        );
        self.compute_staged_entry(
            stage,
            store,
            host,
            &mut entry,
            "Study setup stale: owner changed during staging",
        )?;
        let receipt = IndicatorPublishReceipt::from_entry(&entry, true);
        stage.operations.push(StagedIndicatorOperation::Add {
            entry,
            receipt: receipt.clone(),
        });
        stage.projected_entries += 1;
        stage.projected_outputs = next_outputs;
        Ok(receipt)
    }

    /// 같은 id의 params 후보를 cold 계산하고 schema/offset 호환성을 검사한다.
    pub fn stage_replace(
        &self,
        stage: &mut IndicatorEngineStage,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        params: &JsValue,
    ) -> Result<IndicatorPublishReceipt, JsError> {
        self.ensure_stage_current(
            stage,
            store,
            "Indicator params stale: owner changed during snapshot",
        )?;
        stage.purpose = IndicatorStagePurpose::Params;
        let Some(index) = self.entry_index(id) else {
            return Err(ordinary_error("Missing indicator"));
        };
        validate_indicator_params(params)?;
        let current = &self.entries[index];
        if stage
            .operations
            .iter()
            .any(|operation| operation.id() == &current.id)
        {
            return Err(ordinary_error(
                "Indicator params stale: owner changed during snapshot",
            ));
        }
        let requested = validate_indicator_params(params)?;
        if current.definition.params.object_is_equal(&requested) {
            let receipt = IndicatorPublishReceipt::from_entry(current, false);
            stage.operations.push(StagedIndicatorOperation::Noop {
                receipt: receipt.clone(),
            });
            return Ok(receipt);
        }
        let created = indicator_dispatch::create(current.definition.program, params, host)?;
        self.ensure_stage_current(
            stage,
            store,
            "Indicator params stale: owner changed during staging",
        )?;
        if !created.definition.params.object_is_equal(&requested) {
            return Err(type_error("Indicator factory changed requested params"));
        }
        if current.definition.outputs != created.definition.outputs {
            return Err(type_error(
                "Indicator parameter update cannot change output schema",
            ));
        }
        if current.definition.outputs.iter().any(|output| {
            current.definition.effective_plot_offset(output).to_bits()
                != created.definition.effective_plot_offset(output).to_bits()
        }) {
            return Err(type_error(
                "Indicator parameter update cannot change plot offsets",
            ));
        }
        self.check_staged_output_budget(stage.projected_outputs, store.capacity())?;
        let mut entry = Self::entry_from_created(
            current.id.clone(),
            current.name.clone(),
            created,
            store.length(),
        );
        self.compute_staged_entry(
            stage,
            store,
            host,
            &mut entry,
            "Indicator params stale: owner changed during staging",
        )?;
        let receipt = IndicatorPublishReceipt::from_entry(&entry, true);
        stage.operations.push(StagedIndicatorOperation::Replace {
            previous: Arc::clone(&current.identity),
            entry,
            receipt: receipt.clone(),
        });
        Ok(receipt)
    }

    /// 모든 guard를 다시 확인한 뒤 stage의 add/replace를 한 번에 게시한다.
    pub fn publish_stage(
        &mut self,
        store: &BarStore,
        stage: IndicatorEngineStage,
    ) -> Result<Vec<IndicatorPublishReceipt>, JsError> {
        let stale = match stage.purpose {
            IndicatorStagePurpose::Studies => "Study setup stale: owner changed during staging",
            IndicatorStagePurpose::Params
                if stage.operations.iter().all(|operation| {
                    matches!(operation, StagedIndicatorOperation::Noop { .. })
                }) =>
            {
                "Indicator params stale: owner changed during metadata"
            }
            IndicatorStagePurpose::Params | IndicatorStagePurpose::Unknown => {
                "Indicator params stale: owner changed during staging"
            }
        };
        self.ensure_stage_current(&stage, store, stale)?;
        let mut receipts = Vec::with_capacity(stage.operations.len());
        for operation in stage.operations {
            match operation {
                StagedIndicatorOperation::Add { entry, receipt } => {
                    self.entries.push(entry);
                    receipts.push(receipt);
                }
                StagedIndicatorOperation::Replace {
                    previous,
                    entry,
                    receipt,
                } => {
                    let index = self
                        .entries
                        .iter()
                        .position(|current| Arc::ptr_eq(&current.identity, &previous))
                        .expect("stage guard retained replacement entry");
                    self.entries[index] = entry;
                    receipts.push(receipt);
                }
                StagedIndicatorOperation::Noop { receipt } => receipts.push(receipt),
            }
        }
        Ok(receipts)
    }

    /// definition을 삽입한 뒤 eager get을 끝까지 실행한다. 실패하면 같은 entry만 제거한다.
    pub fn add<'a>(
        &'a mut self,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        name: &JsValue,
        params: &JsValue,
    ) -> Result<IndicatorRead<'a>, JsError> {
        let id = identifier(id, "Indicator id")?.clone();
        validate_indicator_params(params)?;
        if self.entries.len() >= RESOURCE_LIMITS.max_indicators as usize {
            return Err(range_error("Indicator limit"));
        }
        if self.find_id(&id).is_some() {
            return Err(ordinary_error("Duplicate indicator id"));
        }
        let metadata = match name {
            JsValue::String(name) => self.registry.lookup(name),
            _ => None,
        };
        let Some(metadata) = metadata else {
            return Err(value_message("Unknown indicator: ", name)?);
        };
        let created = indicator_dispatch::create(metadata.program, params, host)?;
        let definition = created.definition;
        let params = definition.params.to_js_value();
        let entry_identity = Arc::new(0);
        let prototype = IndicatorPrototype::new(created.state, definition.program);
        self.entries.push(IndicatorEntry {
            identity: Arc::clone(&entry_identity),
            id: id.clone(),
            name: JsString::from_str(metadata.name),
            definition,
            params,
            prototype,
            dirty: 0,
            dirty_to: Some(store.length()),
            invalidated: true,
            length: 0,
            arrays: Vec::new(),
            arrays_epoch: 0,
            checkpoints: BTreeMap::new(),
            checkpoints_epoch: 0,
            revision: 0.0,
            computed_from: None,
            computed_until: None,
            prepared_version: None,
            generation: None,
            running: None,
        });
        let id_value = JsValue::String(id.clone());
        if let Err(error) =
            self.run_to_completion(store, host, &id_value, DEFAULT_CALCULATION_CHUNK)
        {
            if let Some(index) = self.find_id(&id)
                && Arc::ptr_eq(&self.entries[index].identity, &entry_identity)
            {
                self.entries.remove(index);
            }
            return Err(error);
        }
        self.read(store, &id_value)
            .ok_or_else(|| ordinary_error("Missing indicator"))
    }

    /// entry 하나를 지운다. 비문자 id는 아무것도 지우지 않는다.
    pub fn remove(&mut self, id: &JsValue) -> bool {
        let Some(index) = self.entry_index(id) else {
            return false;
        };
        self.entries.remove(index);
        true
    }

    /// restore/params staging이 이미 검증한 ordinary checkpoint map을 원자 교체한다.
    /// bounded map은 publish로 ledger를 retire한 뒤에만 이 경계를 통과한다.
    pub fn install_checkpoints(
        &mut self,
        id: &JsValue,
        checkpoints: BTreeMap<usize, JsValue>,
        prepared_version: Option<f64>,
    ) -> Result<(), JsError> {
        let Some(index) = self.entry_index(id) else {
            return Err(ordinary_error("Missing indicator"));
        };
        self.entries[index].checkpoints = checkpoints;
        self.entries[index].checkpoints_epoch =
            self.entries[index].checkpoints_epoch.wrapping_add(1);
        self.entries[index].prepared_version = prepared_version;
        Ok(())
    }

    /// 커밋된 store change를 모든 entry에 lazy invalidation으로 반영한다.
    pub fn apply_change(&mut self, store: &BarStore, change: &DataChange) {
        if change.kind == ChangeKind::Compact {
            return;
        }
        for entry in &mut self.entries {
            if entry.prepared_version == Some(store.version()) {
                continue;
            }
            entry.dirty = std::cmp::min(entry.dirty, change.from);
            let dirty_to = match change.kind {
                ChangeKind::Update => change.from + 1,
                ChangeKind::Batch => change.to,
                _ => store.length(),
            };
            entry.dirty_to = Some(std::cmp::max(entry.dirty_to.unwrap_or(0), dirty_to));
            if change.kind != ChangeKind::Update
                && (change.kind != ChangeKind::Batch || change.appended.unwrap_or(0) > 0)
            {
                entry.invalidated = true;
            }
            if matches!(change.kind, ChangeKind::Reset | ChangeKind::Prepend) {
                entry.checkpoints.clear();
                entry.dirty = 0;
                entry.length = 0;
            }
        }
    }

    /// 계산 generator를 끝까지 drain하고 clean view를 빌린다.
    pub fn get<'a>(
        &'a mut self,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
    ) -> Result<IndicatorRead<'a>, JsError> {
        self.run_to_completion(store, host, id, DEFAULT_CALCULATION_CHUNK)?;
        self.read(store, id)
            .ok_or_else(|| ordinary_error("Missing indicator"))
    }

    /// 첫 step까지 입력 검사를 미루는 독립 계산 token을 만든다.
    pub fn calculate(&self, id: JsValue, chunk_size: f64) -> IndicatorCalculation {
        IndicatorCalculation {
            state: CalculationState::Pending {
                engine_identity: Arc::clone(&self.identity),
                id,
                chunk_size,
            },
        }
    }

    /// 모든 entry를 제거해 suspended task의 ownership 검사를 실패시킨다.
    pub fn dispose(&mut self) {
        self.entries.clear();
    }

    fn entry_from_created(
        id: JsString,
        name: JsString,
        created: CreatedIndicator<IndicatorState>,
        length: usize,
    ) -> IndicatorEntry {
        let definition = created.definition;
        let params = definition.params.to_js_value();
        let prototype = IndicatorPrototype::new(created.state, definition.program);
        IndicatorEntry {
            identity: Arc::new(0),
            id,
            name,
            definition,
            params,
            prototype,
            dirty: 0,
            dirty_to: Some(length),
            invalidated: true,
            length: 0,
            arrays: Vec::new(),
            arrays_epoch: 0,
            checkpoints: BTreeMap::new(),
            checkpoints_epoch: 0,
            revision: 0.0,
            computed_from: None,
            computed_until: None,
            prepared_version: None,
            generation: None,
            running: None,
        }
    }

    fn ensure_stage_current(
        &self,
        stage: &IndicatorEngineStage,
        store: &BarStore,
        message: &str,
    ) -> Result<(), JsError> {
        let entries_match = self.entries.len() == stage.entries.len()
            && self
                .entries
                .iter()
                .zip(&stage.entries)
                .all(|(current, expected)| {
                    current.id == expected.id && Arc::ptr_eq(&current.identity, &expected.identity)
                });
        if !Arc::ptr_eq(&self.identity, &stage.engine_identity)
            || !stage.source.matches(store)
            || self.registry_names() != stage.registry_names
            || !entries_match
        {
            return Err(ordinary_error(message));
        }
        Ok(())
    }

    fn check_staged_output_budget(&self, outputs: usize, capacity: usize) -> Result<(), JsError> {
        let bytes = outputs
            .checked_mul(capacity)
            .and_then(|value| value.checked_mul(8))
            .unwrap_or(usize::MAX);
        if bytes > self.options.max_output_bytes {
            return Err(range_error("Indicator output byte limit"));
        }
        Ok(())
    }

    fn compute_staged_entry(
        &self,
        stage: &IndicatorEngineStage,
        store: &BarStore,
        host: &dyn Host,
        entry: &mut IndicatorEntry,
        stale_message: &str,
    ) -> Result<(), JsError> {
        let capacity = store.capacity();
        entry.arrays = entry
            .definition
            .outputs
            .iter()
            .map(|_| vec![f64::NAN; capacity])
            .collect();
        entry.arrays_epoch = 1;
        let length = store.length();
        if length == 0 {
            return Ok(());
        }
        let params = entry.params.clone();
        let mut state = entry.prototype.fresh(&params, host)?;
        self.ensure_stage_current(stage, store, stale_message)?;
        let block = self.options.checkpoint_size;
        for index in 0..length {
            if index.is_multiple_of(block) {
                entry.checkpoints.insert(index, state.snapshot());
                self.ensure_stage_current(stage, store, stale_message)?;
            }
            let bar = store.at(index)?;
            let values = state.step(host, &bar, index)?;
            self.ensure_stage_current(stage, store, stale_message)?;
            if values.len() != entry.arrays.len() {
                return Err(type_error("Indicator output arity"));
            }
            for (output, value) in values.as_slice().iter().copied().enumerate() {
                if value.is_infinite() {
                    return Err(type_error("Output must be finite or NaN"));
                }
                entry.arrays[output][index] = value;
            }
        }
        if length.is_multiple_of(block) {
            entry.checkpoints.insert(length, state.snapshot());
        }
        self.ensure_stage_current(stage, store, stale_message)?;
        entry.dirty = length;
        entry.dirty_to = Some(0);
        entry.invalidated = false;
        entry.length = length;
        entry.revision = 1.0;
        entry.computed_from = Some(0);
        entry.computed_until = Some(length);
        Ok(())
    }

    fn find_id(&self, id: &JsString) -> Option<usize> {
        self.entries.iter().position(|entry| entry.id == *id)
    }

    fn entry_index(&self, id: &JsValue) -> Option<usize> {
        match id {
            JsValue::String(id) => self.find_id(id),
            _ => None,
        }
    }

    fn read<'a>(&'a self, store: &BarStore, id: &JsValue) -> Option<IndicatorRead<'a>> {
        let index = self.entry_index(id)?;
        Some(IndicatorRead {
            entry: IndicatorEntryView {
                entry: &self.entries[index],
            },
            length: store.length(),
        })
    }

    fn run_to_completion(
        &mut self,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        chunk_size: f64,
    ) -> Result<(), JsError> {
        let mut task = self.calculate(id.clone(), chunk_size);
        loop {
            match task.step(self, store, host)? {
                CalculationStep::Yield { .. } => {}
                CalculationStep::Complete { .. } | CalculationStep::Exhausted => return Ok(()),
            }
        }
    }

    fn projected_output_bytes(&self, capacity: usize) -> Option<usize> {
        self.entries.iter().try_fold(0usize, |total, entry| {
            entry
                .definition
                .outputs
                .len()
                .checked_mul(capacity)?
                .checked_mul(8)?
                .checked_add(total)
        })
    }

    fn acquire(&mut self, entry_index: usize, token: &Arc<u8>) -> Result<(), JsError> {
        if self.entries[entry_index].running.is_some() {
            return Err(calculation_error(
                "IndicatorBusyError",
                "Indicator calculation already running",
            ));
        }
        if self.calculation_depth >= MAX_CALCULATION_DEPTH {
            return Err(calculation_error(
                "IndicatorBusyError",
                "Indicator calculation nesting limit (32)",
            ));
        }
        self.entries[entry_index].running = Some(Arc::clone(token));
        self.calculation_depth += 1;
        Ok(())
    }

    fn release(&mut self, entry_identity: &Arc<u8>, token: &Arc<u8>) {
        let index = self
            .entries
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.identity, entry_identity));
        match index {
            Some(index)
                if self.entries[index]
                    .running
                    .as_ref()
                    .is_some_and(|running| Arc::ptr_eq(running, token)) =>
            {
                self.entries[index].running = None;
                self.calculation_depth = self.calculation_depth.saturating_sub(1);
            }
            // JS의 WeakMap running row는 entry가 Map에서 제거돼도 generator가
            // 참조하므로 finally에서 depth를 돌려준다. Rust는 entry 자체가 이미
            // drop됐으므로 성공한 acquire의 한 slot만 직접 환불한다.
            None => self.calculation_depth = self.calculation_depth.saturating_sub(1),
            Some(_) => {}
        }
    }

    fn start_calculation(
        &mut self,
        engine_identity: &Arc<u8>,
        id: JsValue,
        chunk_size: f64,
        store: &BarStore,
        host: &dyn Host,
    ) -> Result<StartCalculation, JsError> {
        if !Arc::ptr_eq(&self.identity, engine_identity) {
            return Err(stale_error());
        }
        if !chunk_size.is_finite()
            || chunk_size.fract() != 0.0
            || !(1.0..=MAX_CALCULATION_CHUNK).contains(&chunk_size)
        {
            return Err(range_error("Calculation chunk size"));
        }
        let Some(entry_index) = self.entry_index(&id) else {
            return Err(value_message("Missing indicator: ", &id)?);
        };
        if self.entries[entry_index].running.is_some() {
            return Err(calculation_error(
                "IndicatorBusyError",
                "Indicator calculation already running",
            ));
        }
        let token = Arc::new(0);
        self.acquire(entry_index, &token)?;
        self.entries[entry_index].generation = Some(Arc::clone(&token));
        let entry_identity = Arc::clone(&self.entries[entry_index].identity);
        let source = SourceFingerprint::capture(store);
        let engine_identity = Arc::clone(&self.identity);
        let result = self.prepare_calculation(
            entry_index,
            Arc::clone(&token),
            Arc::clone(&entry_identity),
            engine_identity,
            source,
            chunk_size as usize,
            store,
            host,
        );
        self.release(&entry_identity, &token);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_calculation(
        &mut self,
        entry_index: usize,
        token: Arc<u8>,
        entry_identity: Arc<u8>,
        engine_identity: Arc<u8>,
        source: SourceFingerprint,
        chunk_size: usize,
        store: &BarStore,
        host: &dyn Host,
    ) -> Result<StartCalculation, JsError> {
        let capacity = store.capacity();
        let needs_resize = self.entries[entry_index].arrays.is_empty()
            || self.entries[entry_index].arrays[0].len() != capacity;
        if needs_resize {
            let bytes = self.projected_output_bytes(capacity).unwrap_or(usize::MAX);
            self.check_pending(&entry_identity, &token, &source, store)?;
            if bytes > self.options.max_output_bytes {
                return Err(range_error("Indicator output byte limit"));
            }
            let old = &self.entries[entry_index].arrays;
            let mut next = Vec::with_capacity(self.entries[entry_index].definition.outputs.len());
            for output in 0..self.entries[entry_index].definition.outputs.len() {
                let mut values = vec![f64::NAN; capacity];
                if let Some(previous) = old.get(output) {
                    let count = std::cmp::min(capacity, previous.len());
                    values[..count].copy_from_slice(&previous[..count]);
                }
                next.push(values);
            }
            self.check_pending(&entry_identity, &token, &source, store)?;
            self.entries[entry_index].arrays = next;
            self.entries[entry_index].arrays_epoch =
                self.entries[entry_index].arrays_epoch.wrapping_add(1);
        }

        let total = store.length();
        let computed_from = self.entries[entry_index].computed_from.unwrap_or(0);
        let computed_until = self.entries[entry_index].computed_until.unwrap_or(total);
        let revision = self.entries[entry_index].revision;
        if self.entries[entry_index].dirty >= total {
            return Ok(StartCalculation::Immediate(CalculationStep::Complete {
                revision,
                computed_from,
                computed_until,
            }));
        }
        let block = self.options.checkpoint_size;
        let start = self.entries[entry_index].dirty / block * block;
        let pure_builtin = self.entries[entry_index].definition.program.is_builtin();
        let reuse = pure_builtin
            && !self.entries[entry_index].invalidated
            && self.entries[entry_index].length == total;
        let dirty_to = self.entries[entry_index].dirty_to.unwrap_or(total);
        self.entries[entry_index].invalidated = true;
        let params = self.entries[entry_index].params.clone();
        let mut state = self.entries[entry_index].prototype.fresh(&params, host)?;
        self.check_pending(&entry_identity, &token, &source, store)?;
        if start != 0 {
            let checkpoint = self.entries[entry_index]
                .checkpoints
                .get(&start)
                .cloned()
                .ok_or_else(|| ordinary_error("Missing checkpoint"))?;
            state.restore(&checkpoint)?;
            self.check_pending(&entry_identity, &token, &source, store)?;
        }
        Ok(StartCalculation::Active(Box::new(ActiveCalculation {
            engine_identity,
            token,
            entry_identity,
            id: self.entries[entry_index].id.clone(),
            source,
            arrays_epoch: self.entries[entry_index].arrays_epoch,
            checkpoints_epoch: self.entries[entry_index].checkpoints_epoch,
            start,
            next: start,
            total,
            block,
            chunk_size,
            state,
            reuse,
            dirty_to,
            revision,
            computed_from: start,
            computed_until,
            calculated: true,
        })))
    }

    fn check_pending(
        &self,
        entry_identity: &Arc<u8>,
        token: &Arc<u8>,
        source: &SourceFingerprint,
        store: &BarStore,
    ) -> Result<usize, JsError> {
        let Some(index) = self
            .entries
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.identity, entry_identity))
        else {
            return Err(stale_error());
        };
        if !self.entries[index]
            .generation
            .as_ref()
            .is_some_and(|generation| Arc::ptr_eq(generation, token))
            || !source.matches(store)
        {
            return Err(stale_error());
        }
        Ok(index)
    }

    fn check_active(&self, active: &ActiveCalculation, store: &BarStore) -> Result<usize, JsError> {
        if !Arc::ptr_eq(&self.identity, &active.engine_identity) {
            return Err(stale_error());
        }
        let Some(index) = self.entries.iter().position(|entry| {
            Arc::ptr_eq(&entry.identity, &active.entry_identity) && entry.id == active.id
        }) else {
            return Err(stale_error());
        };
        let entry = &self.entries[index];
        if !entry
            .generation
            .as_ref()
            .is_some_and(|generation| Arc::ptr_eq(generation, &active.token))
            || entry.arrays_epoch != active.arrays_epoch
            || entry.checkpoints_epoch != active.checkpoints_epoch
            || !active.source.matches(store)
        {
            return Err(stale_error());
        }
        Ok(index)
    }

    fn run_active(
        &mut self,
        active: &mut ActiveCalculation,
        store: &BarStore,
        host: &dyn Host,
    ) -> Result<CalculationStep, JsError> {
        let entry_index = match self.check_active(active, store) {
            Ok(index) => index,
            Err(error) => {
                self.mark_source_failure(active, store);
                return Err(error);
            }
        };
        self.acquire(entry_index, &active.token)?;
        let result = self.run_active_inner(active, store, host);
        self.release(&active.entry_identity, &active.token);
        if result.is_err() {
            self.mark_source_failure(active, store);
        }
        result
    }

    fn run_active_inner(
        &mut self,
        active: &mut ActiveCalculation,
        store: &BarStore,
        host: &dyn Host,
    ) -> Result<CalculationStep, JsError> {
        while active.next < active.total {
            let index = active.next;
            if index.is_multiple_of(active.block) {
                let state = active.state.snapshot();
                let entry_index = self.check_active(active, store)?;
                let old = self.entries[entry_index].checkpoints.get(&index).cloned();
                let converged = active.reuse
                    && index > active.start
                    && index >= active.dirty_to
                    && old
                        .as_ref()
                        .is_some_and(|old| exact_state_equal(&state, &canonical_checkpoint(old)));
                self.check_active(active, store)?;
                if converged {
                    active.computed_until = index;
                    return self.finish_active(active, store);
                }
                self.entries[entry_index].checkpoints.insert(index, state);
                self.check_active(active, store)?;
            }
            let bar = store.at(index)?;
            let values = active.state.step(host, &bar, index)?;
            let entry_index = self.check_active(active, store)?;
            if values.len() != self.entries[entry_index].arrays.len() {
                return Err(type_error("Indicator output arity"));
            }
            for (output, value) in values.as_slice().iter().copied().enumerate() {
                self.check_active(active, store)?;
                if value.is_infinite() {
                    return Err(type_error("Output must be finite or NaN"));
                }
                self.entries[entry_index].arrays[output][index] = value;
            }
            active.next += 1;
            if (active.next - active.start).is_multiple_of(active.chunk_size) {
                self.check_active(active, store)?;
                return Ok(CalculationStep::Yield {
                    from: active.start,
                    to: active.next,
                    total: active.total,
                });
            }
        }
        active.computed_until = active.total;
        self.finish_active(active, store)
    }

    fn finish_active(
        &mut self,
        active: &mut ActiveCalculation,
        store: &BarStore,
    ) -> Result<CalculationStep, JsError> {
        let entry_index = self.check_active(active, store)?;
        if active.computed_until == active.total {
            if active.total.is_multiple_of(active.block) {
                let state = active.state.snapshot();
                self.check_active(active, store)?;
                self.entries[entry_index]
                    .checkpoints
                    .insert(active.total, state);
                self.check_active(active, store)?;
            }
            let stale = self.entries[entry_index]
                .checkpoints
                .range((active.total + 1)..)
                .map(|(index, _)| *index)
                .collect::<Vec<_>>();
            for index in stale {
                self.check_active(active, store)?;
                self.entries[entry_index].checkpoints.remove(&index);
            }
        }
        let revision = active.revision + 1.0;
        self.check_active(active, store)?;
        if active.calculated {
            let entry = &mut self.entries[entry_index];
            entry.computed_from = Some(active.computed_from);
            entry.computed_until = Some(active.computed_until);
            entry.dirty = active.total;
            entry.dirty_to = Some(0);
            entry.invalidated = false;
            entry.length = active.total;
            entry.revision = revision;
        }
        Ok(CalculationStep::Complete {
            revision,
            computed_from: active.computed_from,
            computed_until: active.computed_until,
        })
    }

    fn mark_source_failure(&mut self, active: &ActiveCalculation, store: &BarStore) {
        if active.source.matches(store) {
            return;
        }
        if let Some(index) = self.entries.iter().position(|entry| {
            Arc::ptr_eq(&entry.identity, &active.entry_identity)
                && entry
                    .generation
                    .as_ref()
                    .is_some_and(|generation| Arc::ptr_eq(generation, &active.token))
        }) {
            self.entries[index].dirty = 0;
            self.entries[index].invalidated = true;
        }
    }
}

fn stale_error() -> JsError {
    calculation_error(
        "StaleSourceError",
        "Stale indicator calculation: source changed or owner replaced, removed, or disposed",
    )
}

#[cfg(test)]
mod nesting_tests {
    use super::*;
    use crate::HostError;
    use crate::data::{ModelDataState, StoreOptions};
    use barochart_js::json::{JsObject, JsValue};

    struct NoZones;

    impl Host for NoZones {
        fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
            Err(HostError)
        }

        fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
            Err(HostError)
        }

        fn log(&self, _: i32, _: &str) {}
    }

    #[test]
    fn thirty_second_nested_scope_is_allowed_and_thirty_third_rejects() {
        let host = NoZones;
        let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
        let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
        engine
            .add(
                data.store(),
                &host,
                &JsValue::String(JsString::from_str("s")),
                &JsValue::String(JsString::from_str("sma")),
                &JsValue::Object(JsObject::new()),
            )
            .unwrap();

        engine.calculation_depth = 31;
        let allowed = Arc::new(0);
        engine.acquire(0, &allowed).unwrap();
        assert_eq!(engine.calculation_depth, 32);
        let identity = Arc::clone(&engine.entries[0].identity);
        engine.release(&identity, &allowed);
        assert_eq!(engine.calculation_depth, 31);

        engine.calculation_depth = 32;
        let rejected = Arc::new(0);
        let error = engine.acquire(0, &rejected).unwrap_err();
        assert_eq!(error.name, "IndicatorBusyError");
        assert_eq!(
            error.message.to_string_lossy(),
            "Indicator calculation nesting limit (32)"
        );
        assert_eq!(engine.calculation_depth, 32);
    }
}
