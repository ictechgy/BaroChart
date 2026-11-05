//! 지표 entry의 lazy invalidation, checkpoint 재생과 중단 가능한 계산을 관리한다.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::mem::size_of;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::contracts::{RESOURCE_LIMITS, identifier, js_to_string_scoped};
use crate::data::{BarStore, ChangeKind, DataChange, DataIdentity};
use crate::indicator_checkpoint::validate_checkpoint_state;
use crate::indicator_dispatch::{self, IndicatorState};
use crate::indicator_helpers::{canonical_checkpoint, exact_state_equal};
use crate::indicator_params::validate_indicator_params;
use crate::indicator_registry::IndicatorRegistry;
use crate::indicator_types::{CreatedIndicator, IndicatorDefinition, IndicatorProgram};
use crate::native_checkpoints::native_checkpoint_footprint;

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

fn value_message(
    prefix: &str,
    value: &JsValue,
    scope: &mut MemoryScope,
) -> Result<JsError, JsError> {
    let value = js_to_string_scoped(value, NumberDialect::PLATFORM, scope)?;
    let length = prefix
        .encode_utf16()
        .count()
        .checked_add(value.len_utf16())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    let bytes = length
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut message = Vec::new();
    message
        .try_reserve_exact(length)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    message.extend(prefix.encode_utf16());
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

impl Clone for IndicatorPrototype {
    fn clone(&self) -> Self {
        match self {
            Self::Average(state) => Self::Average(Box::new((**state).clone())),
            Self::Momentum(state) => Self::Momentum(Box::new((**state).clone())),
            Self::Session(state) => Self::Session(Box::new((**state).clone())),
            // Volume/pressure factories are deterministic from the validated definition.
            // A published entry has already consumed `first`; a detached clone recreates
            // the state lazily on its next calculation instead of copying hot state.
            Self::Recreate { program, .. } => Self::Recreate {
                program: *program,
                first: None,
            },
        }
    }
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
    definition_identity: Arc<u8>,
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
    checkpoints: CheckpointTable,
    checkpoints_epoch: u64,
    revision: f64,
    computed_from: Option<usize>,
    computed_until: Option<usize>,
    prepared_version: Option<f64>,
    generation: Option<Arc<u8>>,
    running: Option<Arc<u8>>,
}

#[derive(Default)]
struct CheckpointTable {
    entries: Vec<(usize, JsValue)>,
}

impl CheckpointTable {
    fn from_btree(source: BTreeMap<usize, JsValue>) -> Self {
        Self {
            entries: source.into_iter().collect(),
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn keys(&self) -> impl Iterator<Item = &usize> {
        self.entries.iter().map(|(index, _)| index)
    }

    fn values(&self) -> impl Iterator<Item = &JsValue> {
        self.entries.iter().map(|(_, value)| value)
    }

    fn iter(&self) -> impl Iterator<Item = (&usize, &JsValue)> {
        self.entries.iter().map(|(index, value)| (index, value))
    }

    fn get(&self, index: &usize) -> Option<&JsValue> {
        self.position(*index)
            .ok()
            .map(|position| &self.entries[position].1)
    }

    fn first_key_value(&self) -> Option<(&usize, &JsValue)> {
        self.entries.first().map(|(index, value)| (index, value))
    }

    fn next_after(&self, after: usize) -> Option<(&usize, &JsValue)> {
        let position = self.entries.partition_point(|(index, _)| *index <= after);
        self.entries
            .get(position)
            .map(|(index, value)| (index, value))
    }

    fn keys_after(&self, after: usize) -> impl Iterator<Item = usize> + '_ {
        let position = self.entries.partition_point(|(index, _)| *index <= after);
        self.entries[position..].iter().map(|(index, _)| *index)
    }

    fn insert(&mut self, index: usize, value: JsValue) -> Option<JsValue> {
        match self.position(index) {
            Ok(position) => Some(std::mem::replace(&mut self.entries[position].1, value)),
            Err(position) => {
                self.entries.insert(position, (index, value));
                None
            }
        }
    }

    fn remove(&mut self, index: &usize) -> Option<JsValue> {
        self.position(*index)
            .ok()
            .map(|position| self.entries.remove(position).1)
    }

    fn clear(&mut self) {
        self.entries = Vec::new();
    }

    fn slot_bytes(&self) -> usize {
        self.entries
            .capacity()
            .saturating_mul(size_of::<(usize, JsValue)>())
    }

    fn ensure_insert_capacity(&mut self, memory: &mut MemoryGroup) -> Result<(), JsError> {
        if self.entries.len() < self.entries.capacity() {
            return Ok(());
        }
        let old_bytes = self.slot_bytes();
        let mut candidate = memory
            .context()
            .reserve_group(size_of::<(usize, JsValue)>())
            .map_err(|failure| failure.into_js_error())?;
        self.entries
            .try_reserve_exact(1)
            .map_err(|_| memory.context().allocation_failure().into_js_error())?;
        let added = self
            .slot_bytes()
            .checked_sub(old_bytes)
            .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
        candidate
            .try_resize(added)
            .map_err(|failure| failure.into_js_error())?;
        memory
            .absorb(candidate)
            .map_err(|failure| failure.into_js_error())
    }

    fn position(&self, index: usize) -> Result<usize, usize> {
        self.entries
            .binary_search_by_key(&index, |(record_index, _)| *record_index)
    }
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

    /// 현재 ordinary checkpoint record 수다.
    pub fn checkpoint_len(self) -> usize {
        self.entry.checkpoints.len()
    }

    /// 주어진 key 뒤의 다음 checkpoint를 allocation 없이 빌린다.
    pub fn checkpoint_next(self, after: Option<usize>) -> Option<(usize, &'a JsValue)> {
        match after {
            Some(after) => self
                .entry
                .checkpoints
                .next_after(after)
                .map(|(index, value)| (*index, value)),
            None => self
                .entry
                .checkpoints
                .first_key_value()
                .map(|(index, value)| (*index, value)),
        }
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

struct EngineEntryCapture {
    id: JsString,
    identity: Arc<u8>,
    dirty: usize,
    dirty_to: Option<usize>,
    invalidated: bool,
    length: usize,
    revision_bits: u64,
    arrays_epoch: u64,
    arrays_len: usize,
    checkpoints_epoch: u64,
    checkpoints_len: usize,
}

/// Workspace source가 호출 사이에 borrow나 raw address를 보관하지 않고 실제
/// engine/entry container와 entry metadata의 교체를 검증하는 Arc token이다.
pub struct EngineEntryCaptureToken {
    engine_identity: Arc<u8>,
    entries_identity: Arc<u8>,
    entries: Vec<EngineEntryCapture>,
    _memory: MemoryGroup,
}

/// Native async/params 전송이 보존해야 하는 한 entry의 실제 typed payload다.
/// 생성은 engine capture를 통해서만 이뤄지며 private prototype은 이후 계산 의미를 보존한다.
pub struct NativeIndicatorEntrySnapshot {
    pub id: JsString,
    pub name: JsString,
    pub definition: IndicatorDefinition,
    pub params: JsValue,
    pub arrays: Vec<Vec<f64>>,
    pub checkpoints: BTreeMap<usize, JsValue>,
    pub revision: f64,
    pub dirty: usize,
    pub dirty_to: Option<usize>,
    pub invalidated: bool,
    pub length: usize,
    pub computed_from: Option<usize>,
    pub computed_until: Option<usize>,
    pub prepared_version: Option<f64>,
    prototype: IndicatorPrototype,
    captured_definition: IndicatorDefinition,
    captured_params: JsValue,
}

struct NativeStoreCapture {
    identity: DataIdentity,
    serial_bits: u64,
    version_bits: u64,
    time_version_bits: u64,
    length: usize,
    capacity: usize,
}

impl NativeStoreCapture {
    fn capture(store: &BarStore) -> Self {
        Self {
            identity: store.data_identity(),
            serial_bits: store.serial().to_bits(),
            version_bits: store.version().to_bits(),
            time_version_bits: store.time_version().to_bits(),
            length: store.length(),
            capacity: store.capacity(),
        }
    }

    fn matches(&self, store: &BarStore) -> bool {
        self.identity.matches(&store.data_identity())
            && self.serial_bits == store.serial().to_bits()
            && self.version_bits == store.version().to_bits()
            && self.time_version_bits == store.time_version().to_bits()
            && self.length == store.length()
            && self.capacity == store.capacity()
    }
}

/// Source store/engine/registry/options와 entry order/metadata를 묶은 native capture token이다.
pub struct NativeIndicatorCaptureToken {
    engine: EngineEntryCaptureToken,
    store: NativeStoreCapture,
    registry_len: usize,
    checkpoint_size: usize,
    max_output_bytes: usize,
}

/// Frame key가 bound entry와 definition object identity만 보존하는 opaque token이다.
pub struct IndicatorRenderEntryToken {
    engine_identity: Arc<u8>,
    id: JsString,
    entry_identity: Arc<u8>,
    definition_identity: Arc<u8>,
}

/// Empty target engine에 대해 검증된 detached all-entry restore 후보다.
pub struct NativeIndicatorRestoreStage {
    engine_identity: Arc<u8>,
    entries_identity: Arc<u8>,
    store: NativeStoreCapture,
    registry_names: Vec<&'static str>,
    checkpoint_size: usize,
    max_output_bytes: usize,
    entries: Vec<IndicatorEntry>,
    memory: MemoryGroup,
}

/// 기존 entry 하나의 identity와 검증된 detached replacement를 묶는다.
pub struct NativeIndicatorReplacementStage {
    engine_identity: Arc<u8>,
    entries_identity: Arc<u8>,
    store: NativeStoreCapture,
    previous_identity: Arc<u8>,
    candidate: IndicatorEntry,
    memory: MemoryGroup,
    receipt: IndicatorPublishReceipt,
}

/// Compaction 전후 같은 entry order/identity를 보장하는 restart plan이다.
pub struct IndicatorRestartPlan {
    engine_identity: Arc<u8>,
    entries: Vec<EngineEntrySnapshot>,
}

enum StagedIndicatorOperation {
    Add {
        entry: IndicatorEntry,
        memory: MemoryGroup,
        receipt: IndicatorPublishReceipt,
    },
    Replace {
        previous: Arc<u8>,
        entry: IndicatorEntry,
        memory: MemoryGroup,
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
    entries_identity: Arc<u8>,
    memory: MemoryGroup,
}

impl IndicatorEngine {
    /// 옵션을 검증하고 35 builtin과 정적 pressure가 등록된 runtime을 만든다.
    pub fn new(options: IndicatorEngineOptions) -> Result<Self, JsError> {
        Self::new_with_memory(
            options,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
    }

    /// explicit engine memory context에 연결한 indicator runtime을 만든다.
    pub fn new_with_memory(
        options: IndicatorEngineOptions,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
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
            entries_identity: Arc::new(0),
            memory: MemoryGroup::empty(memory),
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

    /// persistent output/checkpoint payload가 선택한 memory context다.
    pub fn memory_context(&self) -> &MemoryContext {
        self.memory.context()
    }

    /// persistent output/checkpoint account bytes다.
    pub fn accounted_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }

    /// runtime registry 이름을 source 순서로 복사한다.
    pub fn registry_names(&self) -> Vec<&'static str> {
        self.registry.entries().map(|entry| entry.name).collect()
    }

    /// entry id를 JS Map insertion 순서로 복사한다.
    pub fn entry_ids(&self) -> Vec<JsString> {
        self.entries.iter().map(|entry| entry.id.clone()).collect()
    }

    /// 내부 문서 builder가 entry id를 JS Map insertion 순서로 빌린다.
    pub(crate) fn entry_ids_iter(&self) -> impl Iterator<Item = &JsString> {
        self.entries.iter().map(|entry| &entry.id)
    }

    /// read-only entry view를 찾는다. Map key처럼 비문자 값은 일치하지 않는다.
    pub fn entry(&self, id: &JsValue) -> Option<IndicatorEntryView<'_>> {
        self.entry_index(id).map(|index| IndicatorEntryView {
            entry: &self.entries[index],
        })
    }

    /// 내부 native job이 새 key allocation 없이 현재 entry를 찾는다.
    pub(crate) fn entry_by_id(&self, id: &JsString) -> Option<IndicatorEntryView<'_>> {
        self.find_id(id).map(|index| IndicatorEntryView {
            entry: &self.entries[index],
        })
    }

    /// 현재 bound entry/definition identity를 frame key용 token으로 잡는다.
    pub fn capture_render_entry(&self, id: &JsString) -> Option<IndicatorRenderEntryToken> {
        let index = self.find_id(id)?;
        let entry = &self.entries[index];
        Some(IndicatorRenderEntryToken {
            engine_identity: Arc::clone(&self.identity),
            id: id.clone(),
            entry_identity: Arc::clone(&entry.identity),
            definition_identity: Arc::clone(&entry.definition_identity),
        })
    }

    /// Token이 아직 같은 engine의 같은 entry/definition object를 가리키는지 본다.
    pub fn validate_render_entry(&self, token: &IndicatorRenderEntryToken) -> bool {
        if !Arc::ptr_eq(&self.identity, &token.engine_identity) {
            return false;
        }
        let Some(index) = self.find_id(&token.id) else {
            return false;
        };
        let entry = &self.entries[index];
        Arc::ptr_eq(&entry.identity, &token.entry_identity)
            && Arc::ptr_eq(&entry.definition_identity, &token.definition_identity)
    }

    /// Workspace `sourceRefs`가 관찰하는 engine/container/entry와 scalar metadata를 고정한다.
    /// 출력 typed-array의 제자리 값 변경은 의도적으로 token에 포함하지 않는다.
    pub fn capture_entries(&self) -> EngineEntryCaptureToken {
        EngineEntryCaptureToken {
            engine_identity: Arc::clone(&self.identity),
            entries_identity: Arc::clone(&self.entries_identity),
            entries: self
                .entries
                .iter()
                .map(|entry| EngineEntryCapture {
                    id: entry.id.clone(),
                    identity: Arc::clone(&entry.identity),
                    dirty: entry.dirty,
                    dirty_to: entry.dirty_to,
                    invalidated: entry.invalidated,
                    length: entry.length,
                    revision_bits: entry.revision.to_bits(),
                    arrays_epoch: entry.arrays_epoch,
                    arrays_len: entry.arrays.len(),
                    checkpoints_epoch: entry.checkpoints_epoch,
                    checkpoints_len: entry.checkpoints.len(),
                })
                .collect(),
            _memory: MemoryGroup::empty(self.memory.context().clone()),
        }
    }

    /// Native job fingerprint용 entry token을 엔진 account에 먼저 예약해 capture한다.
    pub fn capture_entries_accounted(&self) -> Result<EngineEntryCaptureToken, JsError> {
        let memory = self.memory.context().clone();
        let (mut entries, mut group) = memory
            .try_vec_capacity(self.entries.len())
            .map_err(|failure| failure.into_js_error())?;
        let mut scope = memory.scope();
        for entry in &self.entries {
            entries.push(EngineEntryCapture {
                id: entry
                    .id
                    .try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?,
                identity: Arc::clone(&entry.identity),
                dirty: entry.dirty,
                dirty_to: entry.dirty_to,
                invalidated: entry.invalidated,
                length: entry.length,
                revision_bits: entry.revision.to_bits(),
                arrays_epoch: entry.arrays_epoch,
                arrays_len: entry.arrays.len(),
                checkpoints_epoch: entry.checkpoints_epoch,
                checkpoints_len: entry.checkpoints.len(),
            });
        }
        let bytes = usize::try_from(scope.requested_bytes())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        let strings = scope
            .split_persistent(bytes)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(strings)
            .map_err(|failure| failure.into_js_error())?;
        Ok(EngineEntryCaptureToken {
            engine_identity: Arc::clone(&self.identity),
            entries_identity: Arc::clone(&self.entries_identity),
            entries,
            _memory: group,
        })
    }

    /// Capture 뒤 container/entry 교체나 sourceRefs scalar 변경이 없었는지 확인한다.
    pub fn validate_capture(&self, token: &EngineEntryCaptureToken) -> bool {
        Arc::ptr_eq(&self.identity, &token.engine_identity)
            && Arc::ptr_eq(&self.entries_identity, &token.entries_identity)
            && self.entries.len() == token.entries.len()
            && self
                .entries
                .iter()
                .zip(&token.entries)
                .all(|(entry, expected)| {
                    entry.id == expected.id
                        && Arc::ptr_eq(&entry.identity, &expected.identity)
                        && entry.dirty == expected.dirty
                        && entry.dirty_to == expected.dirty_to
                        && entry.invalidated == expected.invalidated
                        && entry.length == expected.length
                        && entry.revision.to_bits() == expected.revision_bits
                        && entry.arrays_epoch == expected.arrays_epoch
                        && entry.arrays.len() == expected.arrays_len
                        && entry.checkpoints_epoch == expected.checkpoints_epoch
                        && entry.checkpoints.len() == expected.checkpoints_len
                })
    }

    /// 큰 출력·checkpoint를 복제하지 않고 source identity와 metadata만 캡처한다.
    pub fn capture_native_token(&self, store: &BarStore) -> NativeIndicatorCaptureToken {
        NativeIndicatorCaptureToken {
            engine: self.capture_entries(),
            store: NativeStoreCapture::capture(store),
            registry_len: self.registry.len(),
            checkpoint_size: self.options.checkpoint_size,
            max_output_bytes: self.options.max_output_bytes,
        }
    }

    /// Native params fingerprint를 엔진 account에 예약해 capture한다.
    pub fn capture_native_token_accounted(
        &self,
        store: &BarStore,
    ) -> Result<NativeIndicatorCaptureToken, JsError> {
        Ok(NativeIndicatorCaptureToken {
            engine: self.capture_entries_accounted()?,
            store: NativeStoreCapture::capture(store),
            registry_len: self.registry.len(),
            checkpoint_size: self.options.checkpoint_size,
            max_output_bytes: self.options.max_output_bytes,
        })
    }

    /// 실제 entry payload를 insertion order로 소유 복사하고 source token을 함께 만든다.
    pub fn capture_native_entries(
        &self,
        store: &BarStore,
    ) -> (
        NativeIndicatorCaptureToken,
        Vec<NativeIndicatorEntrySnapshot>,
    ) {
        let token = self.capture_native_token(store);
        let entries = self
            .entries
            .iter()
            .map(|entry| NativeIndicatorEntrySnapshot {
                id: entry.id.clone(),
                name: entry.name.clone(),
                definition: entry.definition.clone(),
                params: entry.params.clone(),
                arrays: entry.arrays.clone(),
                checkpoints: entry
                    .checkpoints
                    .iter()
                    .map(|(index, state)| (*index, state.clone()))
                    .collect(),
                revision: entry.revision,
                dirty: entry.dirty,
                dirty_to: entry.dirty_to,
                invalidated: entry.invalidated,
                length: entry.length,
                computed_from: entry.computed_from,
                computed_until: entry.computed_until,
                prepared_version: entry.prepared_version,
                prototype: entry.prototype.clone(),
                captured_definition: entry.definition.clone(),
                captured_params: entry.params.clone(),
            })
            .collect();
        (token, entries)
    }

    /// Native job 전송용 entry payload를 fallible clone하고 job group과 함께 돌려준다.
    pub fn capture_native_entries_with_memory(
        &self,
        store: &BarStore,
        memory: &MemoryContext,
    ) -> Result<
        (
            NativeIndicatorCaptureToken,
            Vec<NativeIndicatorEntrySnapshot>,
            MemoryGroup,
        ),
        JsError,
    > {
        let token = self.capture_native_token_accounted(store)?;
        let (mut entries, mut group) = memory
            .try_vec_capacity(self.entries.len())
            .map_err(|failure| failure.into_js_error())?;
        let mut scope: MemoryScope = memory.scope();
        for entry in &self.entries {
            let id = entry
                .id
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            let name = entry
                .name
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            let params = entry
                .params
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            let captured_params = entry
                .params
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?;
            let mut arrays = Vec::new();
            let array_slots = entry
                .arrays
                .len()
                .checked_mul(size_of::<Vec<f64>>())
                .ok_or_else(|| memory.allocation_failure().into_js_error())?;
            scope
                .try_grow(array_slots)
                .map_err(|failure| failure.into_js_error())?;
            arrays
                .try_reserve_exact(entry.arrays.len())
                .map_err(|_| memory.allocation_failure().into_js_error())?;
            for output in &entry.arrays {
                let (values, values_memory) = memory
                    .try_clone_slice(output)
                    .map_err(|failure| failure.into_js_error())?;
                group
                    .absorb(values_memory)
                    .map_err(|failure| failure.into_js_error())?;
                arrays.push(values);
            }
            let mut checkpoints = BTreeMap::new();
            for (index, state) in entry.checkpoints.iter() {
                let node_bytes = size_of::<(usize, JsValue)>().saturating_add(16);
                scope
                    .try_grow(node_bytes)
                    .map_err(|failure| failure.into_js_error())?;
                checkpoints.insert(
                    *index,
                    state
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?,
                );
            }
            entries.push(NativeIndicatorEntrySnapshot {
                id,
                name,
                definition: entry.definition.clone(),
                params,
                arrays,
                checkpoints,
                revision: entry.revision,
                dirty: entry.dirty,
                dirty_to: entry.dirty_to,
                invalidated: entry.invalidated,
                length: entry.length,
                computed_from: entry.computed_from,
                computed_until: entry.computed_until,
                prepared_version: entry.prepared_version,
                prototype: entry.prototype.clone(),
                captured_definition: entry.definition.clone(),
                captured_params,
            });
        }
        let temporary_bytes = usize::try_from(scope.requested_bytes())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        let persistent = scope
            .split_persistent(temporary_bytes)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(persistent)
            .map_err(|failure| failure.into_js_error())?;
        Ok((token, entries, group))
    }

    /// Native capture 뒤 source store/engine/registry/options가 그대로인지 확인한다.
    pub fn validate_native_capture(
        &self,
        store: &BarStore,
        token: &NativeIndicatorCaptureToken,
    ) -> bool {
        self.validate_capture(&token.engine)
            && token.store.matches(store)
            && self.registry.len() == token.registry_len
            && self.options.checkpoint_size == token.checkpoint_size
            && self.options.max_output_bytes == token.max_output_bytes
    }

    /// Empty target engine에 all-entry payload를 검증하되 live state는 바꾸지 않는다.
    pub fn stage_native_restore(
        &self,
        store: &BarStore,
        entries: Vec<NativeIndicatorEntrySnapshot>,
    ) -> Result<NativeIndicatorRestoreStage, JsError> {
        self.stage_native_restore_inner(store, entries, None)
    }

    /// Native job이 이미 과금한 all-entry payload group을 재청구 없이 stage로 이동한다.
    pub fn stage_native_restore_with_memory(
        &self,
        store: &BarStore,
        entries: Vec<NativeIndicatorEntrySnapshot>,
        memory: MemoryGroup,
    ) -> Result<NativeIndicatorRestoreStage, JsError> {
        self.stage_native_restore_inner(store, entries, Some(memory))
    }

    fn stage_native_restore_inner(
        &self,
        store: &BarStore,
        entries: Vec<NativeIndicatorEntrySnapshot>,
        memory: Option<MemoryGroup>,
    ) -> Result<NativeIndicatorRestoreStage, JsError> {
        if !self.entries.is_empty() {
            return Err(ordinary_error(
                "Native indicator restore target must be empty",
            ));
        }
        if entries.len() > RESOURCE_LIMITS.max_indicators as usize {
            return Err(range_error("Indicator limit"));
        }
        let mut seen = Vec::new();
        seen.try_reserve_exact(entries.len())
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        let mut output_count = 0usize;
        let mut staged = Vec::new();
        staged
            .try_reserve_exact(entries.len())
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        for snapshot in entries {
            if seen.iter().any(|id| id == &snapshot.id) {
                return Err(ordinary_error("Duplicate indicator id"));
            }
            seen.push(snapshot.id.clone());
            output_count = output_count
                .checked_add(snapshot.definition.outputs.len())
                .ok_or_else(|| range_error("Indicator output byte limit"))?;
            self.validate_native_snapshot(store, &snapshot)?;
            staged.push(Self::entry_from_native_snapshot(snapshot));
        }
        self.check_staged_output_budget(output_count, store.capacity())?;
        let bytes = staged.iter().map(persistent_bytes).sum::<usize>();
        let memory = match memory {
            Some(mut memory)
                if self.memory.context().shares_account(memory.context())
                    && memory.requested_bytes() >= bytes as u64 =>
            {
                memory
                    .split(bytes)
                    .map_err(|failure| failure.into_js_error())?
            }
            Some(_) => return Err(type_error("Native indicator memory")),
            None => self
                .memory
                .context()
                .reserve_group(bytes)
                .map_err(|failure| failure.into_js_error())?,
        };
        Ok(NativeIndicatorRestoreStage {
            engine_identity: Arc::clone(&self.identity),
            entries_identity: Arc::clone(&self.entries_identity),
            store: NativeStoreCapture::capture(store),
            registry_names: self.registry_names(),
            checkpoint_size: self.options.checkpoint_size,
            max_output_bytes: self.options.max_output_bytes,
            entries: staged,
            memory,
        })
    }

    /// Target engine/store를 다시 확인한 뒤 모든 entry를 한 번에 게시한다.
    pub fn publish_native_restore(
        &mut self,
        store: &BarStore,
        stage: NativeIndicatorRestoreStage,
    ) -> Result<(), JsError> {
        if !Arc::ptr_eq(&self.identity, &stage.engine_identity)
            || !Arc::ptr_eq(&self.entries_identity, &stage.entries_identity)
            || !self.entries.is_empty()
            || !stage.store.matches(store)
            || self.registry_names() != stage.registry_names
            || self.options.checkpoint_size != stage.checkpoint_size
            || self.options.max_output_bytes != stage.max_output_bytes
        {
            return Err(calculation_error(
                "StaleSourceError",
                "Native indicator restore owner or source changed",
            ));
        }
        self.entries = stage.entries;
        self.memory = stage.memory;
        self.entries_identity = Arc::new(0);
        Ok(())
    }

    /// 한 entry replacement payload를 detached validation하고 이전 identity에 묶는다.
    pub fn stage_native_replacement(
        &self,
        store: &BarStore,
        id: &JsValue,
        candidate: NativeIndicatorEntrySnapshot,
    ) -> Result<NativeIndicatorReplacementStage, JsError> {
        let Some(index) = self.entry_index(id) else {
            return Err(ordinary_error("Missing indicator"));
        };
        let current = &self.entries[index];
        if candidate.id != current.id
            || candidate.name != current.name
            || candidate.definition.program != current.definition.program
            || candidate.definition.outputs != current.definition.outputs
            || candidate.definition.outputs.iter().any(|output| {
                candidate.definition.effective_plot_offset(output).to_bits()
                    != current.definition.effective_plot_offset(output).to_bits()
            })
        {
            return Err(type_error("Native indicator replacement definition"));
        }
        self.validate_native_snapshot(store, &candidate)?;
        let candidate = Self::entry_from_native_snapshot(candidate);
        let memory = self
            .memory
            .context()
            .reserve_group(persistent_bytes(&candidate))
            .map_err(|failure| failure.into_js_error())?;
        let receipt = IndicatorPublishReceipt::from_entry(&candidate, true);
        Ok(NativeIndicatorReplacementStage {
            engine_identity: Arc::clone(&self.identity),
            entries_identity: Arc::clone(&self.entries_identity),
            store: NativeStoreCapture::capture(store),
            previous_identity: Arc::clone(&current.identity),
            candidate,
            memory,
            receipt,
        })
    }

    /// 같은 slot의 entry identity가 유지된 경우에만 replacement를 원자 교체한다.
    pub fn publish_native_replacement(
        &mut self,
        store: &BarStore,
        stage: NativeIndicatorReplacementStage,
    ) -> Result<IndicatorPublishReceipt, JsError> {
        if !Arc::ptr_eq(&self.identity, &stage.engine_identity)
            || !Arc::ptr_eq(&self.entries_identity, &stage.entries_identity)
            || !stage.store.matches(store)
        {
            return Err(calculation_error(
                "StaleSourceError",
                "Native indicator replacement owner or source changed",
            ));
        }
        let Some(index) = self
            .entries
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.identity, &stage.previous_identity))
        else {
            return Err(calculation_error(
                "StaleSourceError",
                "Native indicator replacement owner or source changed",
            ));
        };
        let old_bytes = persistent_bytes(&self.entries[index]);
        self.memory
            .absorb(stage.memory)
            .map_err(|failure| failure.into_js_error())?;
        let final_bytes = self
            .memory
            .requested_bytes()
            .checked_sub(old_bytes as u64)
            .ok_or_else(|| type_error("Indicator memory"))?;
        self.entries[index] = stage.candidate;
        self.memory
            .try_resize(final_bytes as usize)
            .map_err(|failure| failure.into_js_error())?;
        Ok(stage.receipt)
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
        self.memory
            .try_resize(0)
            .map_err(|failure| failure.into_js_error())?;
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
        let mut scope = MemoryScope::unaccounted(self.memory_context().oom_style());
        self.stage_add_scoped(stage, store, host, id, name, params, &mut scope)
    }

    /// caller scope에서 동적 unknown-name 오류 payload를 유지하며 additive entry를 staging한다.
    #[allow(clippy::too_many_arguments)]
    pub fn stage_add_scoped(
        &self,
        stage: &mut IndicatorEngineStage,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        name: &JsValue,
        params: &JsValue,
        scope: &mut MemoryScope,
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
            return Err(value_message("Unknown indicator: ", name, scope)?);
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
        let memory = self.compute_staged_entry(
            stage,
            store,
            host,
            &mut entry,
            "Study setup stale: owner changed during staging",
        )?;
        let receipt = IndicatorPublishReceipt::from_entry(&entry, true);
        stage.operations.push(StagedIndicatorOperation::Add {
            entry,
            memory,
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
        let memory = self.compute_staged_entry(
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
            memory,
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
        let mut receipts = Vec::new();
        receipts
            .try_reserve_exact(stage.operations.len())
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        let additions = stage
            .operations
            .iter()
            .filter(|operation| matches!(operation, StagedIndicatorOperation::Add { .. }))
            .count();
        self.entries
            .try_reserve(additions)
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        for operation in stage.operations {
            match operation {
                StagedIndicatorOperation::Add {
                    entry,
                    memory,
                    receipt,
                } => {
                    self.memory
                        .absorb(memory)
                        .map_err(|failure| failure.into_js_error())?;
                    self.entries.push(entry);
                    receipts.push(receipt);
                }
                StagedIndicatorOperation::Replace {
                    previous,
                    entry,
                    memory,
                    receipt,
                } => {
                    let index = self
                        .entries
                        .iter()
                        .position(|current| Arc::ptr_eq(&current.identity, &previous))
                        .expect("stage guard retained replacement entry");
                    let old_bytes = persistent_bytes(&self.entries[index]);
                    self.memory
                        .absorb(memory)
                        .map_err(|failure| failure.into_js_error())?;
                    let final_bytes = self
                        .memory
                        .requested_bytes()
                        .checked_sub(old_bytes as u64)
                        .ok_or_else(|| type_error("Indicator memory"))?;
                    self.entries[index] = entry;
                    self.memory
                        .try_resize(final_bytes as usize)
                        .map_err(|failure| failure.into_js_error())?;
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
        let mut scope = MemoryScope::unaccounted(self.memory_context().oom_style());
        self.add_scoped(store, host, id, name, params, &mut scope)
    }

    /// caller scope에서 동적 unknown-name 오류 payload를 유지하며 entry를 eager 추가한다.
    pub fn add_scoped<'a>(
        &'a mut self,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        name: &JsValue,
        params: &JsValue,
        scope: &mut MemoryScope,
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
            return Err(value_message("Unknown indicator: ", name, scope)?);
        };
        let created = indicator_dispatch::create(metadata.program, params, host)?;
        let definition = created.definition;
        let params = definition.params.to_js_value();
        let entry_identity = Arc::new(0);
        let prototype = IndicatorPrototype::new(created.state, definition.program);
        self.entries.push(IndicatorEntry {
            identity: Arc::clone(&entry_identity),
            definition_identity: Arc::new(0),
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
            checkpoints: CheckpointTable::default(),
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
                let old_bytes = persistent_bytes(&self.entries[index]);
                self.entries.remove(index);
                let final_bytes = self
                    .memory
                    .requested_bytes()
                    .saturating_sub(old_bytes as u64);
                self.memory
                    .try_resize(final_bytes as usize)
                    .map_err(|failure| failure.into_js_error())?;
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
        let old_bytes = persistent_bytes(&self.entries[index]);
        self.entries.remove(index);
        let final_bytes = self
            .memory
            .requested_bytes()
            .saturating_sub(old_bytes as u64);
        self.memory
            .try_resize(final_bytes as usize)
            .expect("indicator memory shrink");
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
        let bytes = checkpoints.values().try_fold(0usize, |total, state| {
            total
                .checked_add(native_checkpoint_footprint(state)?.logical_bytes)
                .ok_or_else(|| type_error("Indicator checkpoint memory"))
        })?;
        let memory = self
            .memory
            .context()
            .reserve_group(bytes)
            .map_err(|failure| failure.into_js_error())?;
        self.install_checkpoints_with_memory(id, checkpoints, prepared_version, memory)
    }

    /// Native staging이 이미 과금한 checkpoint payload를 재청구 없이 설치한다.
    pub fn install_checkpoints_with_memory(
        &mut self,
        id: &JsValue,
        checkpoints: BTreeMap<usize, JsValue>,
        prepared_version: Option<f64>,
        mut memory: MemoryGroup,
    ) -> Result<(), JsError> {
        let Some(index) = self.entry_index(id) else {
            return Err(ordinary_error("Missing indicator"));
        };
        let state_bytes = checkpoints.values().try_fold(0usize, |total, state| {
            total
                .checked_add(native_checkpoint_footprint(state)?.logical_bytes)
                .ok_or_else(|| type_error("Indicator checkpoint memory"))
        })?;
        if memory.requested_bytes() != state_bytes as u64 {
            return Err(type_error("Indicator checkpoint memory"));
        }
        let (mut checkpoint_entries, slot_memory) = memory
            .context()
            .try_vec_capacity(checkpoints.len())
            .map_err(|failure| failure.into_js_error())?;
        checkpoint_entries.extend(checkpoints);
        memory
            .absorb(slot_memory)
            .map_err(|failure| failure.into_js_error())?;
        let checkpoints = CheckpointTable {
            entries: checkpoint_entries,
        };
        let expected = state_bytes
            .checked_add(checkpoints.slot_bytes())
            .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
        if memory.requested_bytes() != expected as u64 {
            return Err(type_error("Indicator checkpoint memory"));
        }
        let old_bytes = checkpoint_bytes(&self.entries[index]);
        self.memory
            .absorb(memory)
            .map_err(|failure| failure.into_js_error())?;
        let final_bytes = self
            .memory
            .requested_bytes()
            .checked_sub(old_bytes as u64)
            .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
        self.entries[index].checkpoints = checkpoints;
        self.memory
            .try_resize(final_bytes as usize)
            .map_err(|failure| failure.into_js_error())?;
        self.entries[index].checkpoints_epoch =
            self.entries[index].checkpoints_epoch.wrapping_add(1);
        self.entries[index].prepared_version = prepared_version;
        Ok(())
    }

    /// Native checkpoint map의 fallible sorted entries/group을 변환 allocation 없이 설치한다.
    pub fn install_checkpoint_entries_with_memory(
        &mut self,
        id: &JsValue,
        checkpoints: Vec<(usize, JsValue)>,
        prepared_version: Option<f64>,
        memory: MemoryGroup,
    ) -> Result<(), JsError> {
        let Some(index) = self.entry_index(id) else {
            return Err(ordinary_error("Missing indicator"));
        };
        if checkpoints.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
            return Err(type_error("Indicator checkpoint order"));
        }
        let state_bytes = checkpoints.iter().try_fold(0usize, |total, (_, state)| {
            total
                .checked_add(native_checkpoint_footprint(state)?.logical_bytes)
                .ok_or_else(|| type_error("Indicator checkpoint memory"))
        })?;
        let slot_bytes = checkpoints
            .capacity()
            .checked_mul(size_of::<(usize, JsValue)>())
            .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
        let expected = state_bytes
            .checked_add(slot_bytes)
            .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
        if memory.requested_bytes() != expected as u64 {
            return Err(type_error("Indicator checkpoint memory"));
        }
        let old_bytes = checkpoint_bytes(&self.entries[index]);
        self.memory
            .absorb(memory)
            .map_err(|failure| failure.into_js_error())?;
        let final_bytes = self
            .memory
            .requested_bytes()
            .checked_sub(old_bytes as u64)
            .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
        self.entries[index].checkpoints = CheckpointTable {
            entries: checkpoints,
        };
        self.memory
            .try_resize(final_bytes as usize)
            .map_err(|failure| failure.into_js_error())?;
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
        let clearing = matches!(change.kind, ChangeKind::Reset | ChangeKind::Prepend);
        let removed_checkpoint_bytes = if clearing {
            self.entries.iter().map(checkpoint_bytes).sum::<usize>()
        } else {
            0
        };
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
        if removed_checkpoint_bytes != 0 {
            let final_bytes = self
                .memory
                .requested_bytes()
                .saturating_sub(removed_checkpoint_bytes as u64);
            self.memory
                .try_resize(final_bytes as usize)
                .expect("indicator checkpoint memory shrink");
        }
    }

    /// 계산 generator를 끝까지 drain하고 clean view를 빌린다.
    pub fn get<'a>(
        &'a mut self,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
    ) -> Result<IndicatorRead<'a>, JsError> {
        let mut scope = MemoryScope::unaccounted(self.memory_context().oom_style());
        self.get_scoped(store, host, id, &mut scope)
    }

    /// caller scope에서 동적 missing-id 오류 payload를 유지하며 clean output view를 빌린다.
    pub fn get_scoped<'a>(
        &'a mut self,
        store: &BarStore,
        host: &dyn Host,
        id: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<IndicatorRead<'a>, JsError> {
        if self.entry_index(id).is_none() {
            return Err(value_message("Missing indicator: ", id, scope)?);
        }
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

    fn validate_native_snapshot(
        &self,
        store: &BarStore,
        snapshot: &NativeIndicatorEntrySnapshot,
    ) -> Result<(), JsError> {
        identifier(&JsValue::String(snapshot.id.clone()), "Indicator id")?;
        if !definition_same(&snapshot.definition, &snapshot.captured_definition)
            || !exact_state_equal(&snapshot.params, &snapshot.captured_params)
        {
            return Err(type_error("Native indicator snapshot definition changed"));
        }
        let Some(metadata) = self.registry.lookup(&snapshot.name) else {
            return Err(type_error("Native indicator registry binding"));
        };
        if metadata.program != snapshot.definition.program
            || metadata.provenance != snapshot.definition.provenance
            || !snapshot
                .name
                .as_units()
                .iter()
                .copied()
                .eq(metadata.name.encode_utf16())
        {
            return Err(type_error("Native indicator registry binding"));
        }
        let params = validate_indicator_params(&snapshot.params)?;
        if !exact_state_equal(
            &params.to_js_value(),
            &snapshot.definition.params.to_js_value(),
        ) {
            return Err(type_error("Native indicator params binding"));
        }
        if snapshot.arrays.len() != snapshot.definition.outputs.len()
            || snapshot
                .arrays
                .iter()
                .any(|values| values.len() != store.capacity())
        {
            return Err(type_error("Native indicator output capacity"));
        }
        if snapshot
            .arrays
            .iter()
            .flatten()
            .any(|value| value.is_infinite())
        {
            return Err(type_error("Native indicator output finite/NaN"));
        }
        if !snapshot.revision.is_finite()
            || snapshot.revision.fract() != 0.0
            || snapshot.revision < 0.0
            || snapshot.length > store.length()
            || snapshot.dirty > store.length()
            || snapshot
                .dirty_to
                .is_some_and(|value| value > store.length())
            || snapshot
                .computed_from
                .is_some_and(|value| value > store.length())
            || snapshot
                .computed_until
                .is_some_and(|value| value > store.length())
            || snapshot
                .prepared_version
                .is_some_and(|value| !value.is_finite() || value.fract() != 0.0 || value < 0.0)
        {
            return Err(type_error("Native indicator entry metadata"));
        }
        for (index, state) in &snapshot.checkpoints {
            if *index > store.length() || !index.is_multiple_of(self.options.checkpoint_size) {
                return Err(type_error("Native indicator checkpoint boundary"));
            }
            validate_checkpoint_state(
                snapshot.definition.program,
                &snapshot.definition.params,
                state,
                *index as f64,
            )?;
        }
        Ok(())
    }

    fn entry_from_native_snapshot(snapshot: NativeIndicatorEntrySnapshot) -> IndicatorEntry {
        IndicatorEntry {
            identity: Arc::new(0),
            definition_identity: Arc::new(0),
            id: snapshot.id,
            name: snapshot.name,
            definition: snapshot.definition,
            params: snapshot.params,
            prototype: snapshot.prototype,
            dirty: snapshot.dirty,
            dirty_to: snapshot.dirty_to,
            invalidated: snapshot.invalidated,
            length: snapshot.length,
            arrays: snapshot.arrays,
            arrays_epoch: 1,
            checkpoints: CheckpointTable::from_btree(snapshot.checkpoints),
            checkpoints_epoch: 1,
            revision: snapshot.revision,
            computed_from: snapshot.computed_from,
            computed_until: snapshot.computed_until,
            prepared_version: snapshot.prepared_version,
            generation: None,
            running: None,
        }
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
            definition_identity: Arc::new(0),
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
            checkpoints: CheckpointTable::default(),
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
    ) -> Result<MemoryGroup, JsError> {
        let capacity = store.capacity();
        let (arrays, mut memory) = allocate_output_arrays(
            entry.definition.outputs.len(),
            capacity,
            self.memory.context(),
        )?;
        entry.arrays = arrays;
        entry.arrays_epoch = 1;
        let length = store.length();
        if length == 0 {
            return Ok(memory);
        }
        let params = entry.params.clone();
        let mut state = entry.prototype.fresh(&params, host)?;
        self.ensure_stage_current(stage, store, stale_message)?;
        let block = self.options.checkpoint_size;
        for index in 0..length {
            if index.is_multiple_of(block) {
                stage_checkpoint(entry, &mut memory, index, state.snapshot())?;
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
            stage_checkpoint(entry, &mut memory, length, state.snapshot())?;
        }
        self.ensure_stage_current(stage, store, stale_message)?;
        entry.dirty = length;
        entry.dirty_to = Some(0);
        entry.invalidated = false;
        entry.length = length;
        entry.revision = 1.0;
        entry.computed_from = Some(0);
        entry.computed_until = Some(length);
        Ok(memory)
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
            let mut scope = self.memory_context().scope();
            return Err(value_message("Missing indicator: ", &id, &mut scope)?);
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
            let (mut next, next_memory) = allocate_output_arrays(
                self.entries[entry_index].definition.outputs.len(),
                capacity,
                self.memory.context(),
            )?;
            let old = &self.entries[entry_index].arrays;
            for (output, values) in next.iter_mut().enumerate() {
                if let Some(previous) = old.get(output) {
                    let count = std::cmp::min(capacity, previous.len());
                    values[..count].copy_from_slice(&previous[..count]);
                }
            }
            self.check_pending(&entry_identity, &token, &source, store)?;
            let old_bytes = output_bytes(&self.entries[entry_index]);
            self.memory
                .absorb(next_memory)
                .map_err(|failure| failure.into_js_error())?;
            let final_bytes = self
                .memory
                .requested_bytes()
                .checked_sub(old_bytes as u64)
                .ok_or_else(|| type_error("Indicator memory"))?;
            self.entries[entry_index].arrays = next;
            self.memory
                .try_resize(final_bytes as usize)
                .map_err(|failure| failure.into_js_error())?;
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
                stage_checkpoint(
                    &mut self.entries[entry_index],
                    &mut self.memory,
                    index,
                    state,
                )?;
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
                stage_checkpoint(
                    &mut self.entries[entry_index],
                    &mut self.memory,
                    active.total,
                    state,
                )?;
                self.check_active(active, store)?;
            }
            let stale = self.entries[entry_index]
                .checkpoints
                .keys_after(active.total)
                .collect::<Vec<_>>();
            let mut removed_bytes = 0usize;
            for index in stale {
                self.check_active(active, store)?;
                removed_bytes = removed_bytes.saturating_add(
                    self.entries[entry_index]
                        .checkpoints
                        .get(&index)
                        .map(native_checkpoint_footprint)
                        .transpose()?
                        .map_or(0, |footprint| footprint.logical_bytes),
                );
                self.entries[entry_index].checkpoints.remove(&index);
            }
            if removed_bytes != 0 {
                let final_bytes = self
                    .memory
                    .requested_bytes()
                    .checked_sub(removed_bytes as u64)
                    .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
                self.memory
                    .try_resize(final_bytes as usize)
                    .map_err(|failure| failure.into_js_error())?;
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

fn definition_same(left: &IndicatorDefinition, right: &IndicatorDefinition) -> bool {
    left.program == right.program
        && left.provenance == right.provenance
        && left.outputs == right.outputs
        && exact_state_equal(&left.params.to_js_value(), &right.params.to_js_value())
        && left.plot_offsets.len() == right.plot_offsets.len()
        && left
            .plot_offsets
            .iter()
            .zip(&right.plot_offsets)
            .all(|(left, right)| {
                left.output == right.output && left.value.to_bits() == right.value.to_bits()
            })
}

fn stale_error() -> JsError {
    calculation_error(
        "StaleSourceError",
        "Stale indicator calculation: source changed or owner replaced, removed, or disposed",
    )
}

fn output_bytes(entry: &IndicatorEntry) -> usize {
    entry
        .arrays
        .iter()
        .map(|values| values.capacity().saturating_mul(8))
        .sum()
}

fn checkpoint_bytes(entry: &IndicatorEntry) -> usize {
    entry.checkpoints.slot_bytes()
        + entry
            .checkpoints
            .values()
            .map(|state| {
                native_checkpoint_footprint(state)
                    .expect("validated indicator checkpoint footprint")
                    .logical_bytes
            })
            .sum::<usize>()
}

fn persistent_bytes(entry: &IndicatorEntry) -> usize {
    output_bytes(entry).saturating_add(checkpoint_bytes(entry))
}

fn stage_checkpoint(
    entry: &mut IndicatorEntry,
    memory: &mut MemoryGroup,
    index: usize,
    state: JsValue,
) -> Result<(), JsError> {
    let new_bytes = native_checkpoint_footprint(&state)?.logical_bytes;
    let old_bytes = entry
        .checkpoints
        .get(&index)
        .map(native_checkpoint_footprint)
        .transpose()?
        .map_or(0, |footprint| footprint.logical_bytes);
    let candidate = memory
        .context()
        .reserve_group(new_bytes)
        .map_err(|failure| failure.into_js_error())?;
    if entry.checkpoints.get(&index).is_none() {
        entry.checkpoints.ensure_insert_capacity(memory)?;
    }
    memory
        .absorb(candidate)
        .map_err(|failure| failure.into_js_error())?;
    entry.checkpoints.insert(index, state);
    let final_bytes = memory
        .requested_bytes()
        .checked_sub(old_bytes as u64)
        .ok_or_else(|| type_error("Indicator checkpoint memory"))?;
    memory
        .try_resize(final_bytes as usize)
        .map_err(|failure| failure.into_js_error())
}

fn allocate_output_arrays(
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
        let (values, values_memory) = memory
            .try_vec_filled(capacity, f64::NAN)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(values_memory)
            .map_err(|failure| failure.into_js_error())?;
        arrays.push(values);
    }
    Ok((arrays, group))
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
