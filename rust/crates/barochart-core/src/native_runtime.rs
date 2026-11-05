//! Per-engine native async/workspace/params/UI global protocol owner.

#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
mod web_migration;

use std::sync::{Arc, Mutex, MutexGuard};

use barochart_js::error::JsError;
use barochart_js::json::{
    JsObject, JsValue, JsonFailure, JsonMode, parse_json_utf16_scoped, stringify_json_scoped,
};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::NativeSizeState;
use crate::contracts::assert_json_text_depth_with_scoped;
use crate::data::DataIdentity;
use crate::ingestion::{AsyncIngestionLease, IngestionError, IngestionOwner};
use crate::interaction::{InteractionSourceOwnerToken, OwnedInteractionState};
use crate::markets::Adjustment;
use crate::native_chart::{
    NativeChart, NativeChartIdentityToken, NativeChartParts, NativeFormatterIdentityToken,
};
use crate::native_data_jobs::{
    NativeCorrectionSource, NativeCorrectionTarget, NativePrepareSource, NativePrepareTarget,
    NativePreparedCore,
};
use crate::native_params_jobs::{NativeParamsSource, NativeParamsTarget};
use crate::native_ui::{
    NativeUiCapture, NativeUiFinishMode, NativeUiImport, PreparedPublication, finish_direct,
};
use crate::native_workspace::NativeWorkspaceSize;
use crate::native_workspace_source::NativeWorkspaceSource;
use crate::native_workspace_target::{
    NativeWorkspaceSymbol, NativeWorkspaceTarget, RestoredWorkspace,
};
use crate::workspace::{
    WorkspaceContext, WorkspaceInteraction, WorkspaceSymbol, js_string_heap_bytes,
    js_value_heap_bytes,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEFAULT_MAX_BYTES: f64 = 805_306_368.0;

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

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", key(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", key(message))
}

fn stale_error(message: &str) -> JsError {
    JsError::new("StaleSourceError", key(message))
}

fn ingestion_error(error: IngestionError) -> JsError {
    error.into_js_error()
}

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn argument(args: &[JsValue], index: usize) -> &JsValue {
    static UNDEFINED: JsValue = JsValue::Undefined;
    args.get(index).unwrap_or(&UNDEFINED)
}

fn number(value: &JsValue) -> Option<f64> {
    match value {
        JsValue::Number(value) => Some(*value),
        _ => None,
    }
}

fn exact_u64(value: &JsValue) -> Option<u64> {
    let value = number(value)?;
    (value.is_finite() && value.fract() == 0.0 && value >= 0.0 && value <= MAX_SAFE_INTEGER as f64)
        .then_some(value as u64)
}

fn exact_usize(value: &JsValue) -> Option<usize> {
    exact_u64(value).and_then(|value| usize::try_from(value).ok())
}

fn string_scoped(
    value: &JsValue,
    message: &str,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    match value {
        JsValue::String(value) => value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error()),
        _ => Err(type_error(message)),
    }
}

fn json_text_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let bytes = stringify_json_scoped(value, JsonMode::Standard, dialect, scope)
        .map_err(|failure| failure.into_js_error())?;
    let text = std::str::from_utf8(&bytes).expect("runtime JSON writer emits UTF-8");
    JsString::try_from_str(text, scope).map_err(|failure| failure.into_js_error())
}

fn parse_entry_json_scoped(
    value: &JsValue,
    depth_message: &str,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let text = assert_json_text_depth_with_scoped(value, 32, depth_message, dialect, scope)?;
    match parse_json_utf16_scoped(text.as_units(), JsonMode::Standard, dialect, scope) {
        Ok(value) => Ok(value),
        Err(JsonFailure::Syntax(error)) => Err(error),
        Err(JsonFailure::Memory(failure)) => Err(failure.into_js_error()),
    }
}

/// One-call-only borrows supplied by Root Engine.
pub struct RuntimeContext<'a> {
    pub chart: Option<&'a mut NativeChart>,
    pub input: Option<&'a OwnedInteractionState>,
    pub size: Option<&'a NativeSizeState>,
    pub host: &'a dyn Host,
    pub next_store_serial: &'a mut f64,
}

/// Generic global-call result plus an optional same-call publication directive.
pub struct NativeRuntimeResult {
    pub value: JsValue,
    pub publication: Option<PreparedPublication>,
    pub output_memory: Option<MemoryGroup>,
}

impl NativeRuntimeResult {
    fn value_with_memory(value: JsValue, memory: MemoryGroup) -> Self {
        Self {
            value,
            publication: None,
            output_memory: Some(memory),
        }
    }
    fn value(value: JsValue) -> Self {
        Self {
            value,
            publication: None,
            output_memory: None,
        }
    }

    fn publication(value: JsValue, publication: PreparedPublication) -> Self {
        debug_assert!(
            publication.input.is_some(),
            "runtime result cannot expose an unfinished UI publication"
        );
        Self {
            value,
            publication: Some(publication),
            output_memory: None,
        }
    }
}

struct ParamsStatusRow {
    registration: u64,
    ticket: u64,
    status: &'static str,
    receipt: Option<JsValue>,
    _receipt_memory: MemoryGroup,
}

impl ParamsStatusRow {
    fn to_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut output = JsObject::new();
        output.insert(
            key("registration"),
            JsValue::Number(self.registration as f64),
        );
        output.insert(key("ticket"), JsValue::Number(self.ticket as f64));
        output.insert(key("status"), text(self.status));
        if let Some(receipt) = &self.receipt {
            output.insert(
                key("receipt"),
                receipt
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            );
        }
        Ok(JsValue::Object(output))
    }
}

struct ParamsLedgerState {
    mark: u64,
    rows: [Option<ParamsStatusRow>; 4],
    active: Option<u64>,
    poisoned: bool,
    memory: MemoryContext,
}

impl Default for ParamsLedgerState {
    fn default() -> Self {
        Self {
            mark: 0,
            rows: std::array::from_fn(|_| None),
            active: None,
            poisoned: false,
            memory: MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        }
    }
}

/// FFI가 CoreState 밖에 보관해 poisoned cleanup whitelist를 답하는 durable ledger다.
#[derive(Clone, Default)]
pub struct NativeParamsStatusLedger {
    state: Arc<Mutex<ParamsLedgerState>>,
}

impl NativeParamsStatusLedger {
    fn new_with_memory(memory: MemoryContext) -> Self {
        Self {
            state: Arc::new(Mutex::new(ParamsLedgerState {
                memory,
                ..ParamsLedgerState::default()
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ParamsLedgerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(&self, registration: u64, ticket: u64) {
        let mut state = self.lock();
        state.mark = registration;
        let row = ParamsStatusRow {
            registration,
            ticket,
            status: "active",
            receipt: None,
            _receipt_memory: MemoryGroup::empty(state.memory.clone()),
        };
        if let Some(slot) = state.rows.iter_mut().find(|slot| slot.is_none()) {
            *slot = Some(row);
        } else {
            for index in 0..state.rows.len() - 1 {
                state.rows[index] = state.rows[index + 1].take();
            }
            state.rows[3] = Some(row);
        }
        state.active = Some(registration);
    }

    fn terminal(&self, registration: u64, status: &'static str) {
        let mut state = self.lock();
        let memory = state.memory.clone();
        if let Some(row) = state
            .rows
            .iter_mut()
            .filter_map(Option::as_mut)
            .find(|row| row.registration == registration)
        {
            row.status = status;
            row.receipt = None;
            row._receipt_memory = MemoryGroup::empty(memory);
        }
        if state.active == Some(registration) {
            state.active = None;
        }
    }

    fn terminal_accounted(
        &self,
        registration: u64,
        status: &'static str,
        receipt: JsValue,
        receipt_memory: MemoryGroup,
    ) {
        let mut state = self.lock();
        if let Some(row) = state
            .rows
            .iter_mut()
            .filter_map(Option::as_mut)
            .find(|row| row.registration == registration)
        {
            row.status = status;
            row.receipt = Some(receipt);
            row._receipt_memory = receipt_memory;
        } else {
            for index in 0..state.rows.len() - 1 {
                state.rows[index] = state.rows[index + 1].take();
            }
            state.rows[3] = Some(ParamsStatusRow {
                registration,
                ticket: 0,
                status,
                receipt: Some(receipt),
                _receipt_memory: receipt_memory,
            });
        }
        if state.active == Some(registration) {
            state.active = None;
        }
    }

    /// Panic transition이 active row를 terminal failed로 만들고 core-free 답변을 활성화한다.
    pub fn poison(&self) {
        let mut state = self.lock();
        state.poisoned = true;
        let memory = state.memory.clone();
        if let Some(registration) = state.active.take()
            && let Some(row) = state
                .rows
                .iter_mut()
                .filter_map(Option::as_mut)
                .find(|row| row.registration == registration)
        {
            row.status = "failed";
            row.receipt = None;
            row._receipt_memory = MemoryGroup::empty(memory);
        }
    }

    /// Core 테스트가 쓰는 비회계 status wrapper다.
    pub fn status(&self, registration: &JsValue) -> Result<JsValue, JsError> {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.status_scoped(registration, &mut scope)
    }

    /// Poison cleanup status receipt를 caller FFI scope에 복제한다.
    pub fn status_scoped(
        &self,
        registration: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let registration = params_registration(registration)?;
        let state = self.lock();
        if let Some(row) = state
            .rows
            .iter()
            .filter_map(Option::as_ref)
            .find(|row| row.registration == registration)
        {
            return row.to_value_scoped(scope);
        }
        if state.poisoned && registration > state.mark {
            return ParamsStatusRow {
                registration,
                ticket: 0,
                status: "failed",
                receipt: None,
                _receipt_memory: MemoryGroup::empty(state.memory.clone()),
            }
            .to_value_scoped(scope);
        }
        Ok(JsValue::Null)
    }

    /// Poisoned CoreState 밖에서는 Abort도 terminal ledger 조회와 같은 답을 낸다.
    /// Core 테스트가 쓰는 비회계 abort wrapper다.
    pub fn abort(&self, registration: &JsValue) -> Result<JsValue, JsError> {
        self.status(registration)
    }

    /// Poison cleanup Abort 응답을 caller FFI scope에 복제한다.
    pub fn abort_scoped(
        &self,
        registration: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        self.status_scoped(registration, scope)
    }

    fn mark(&self) -> u64 {
        self.lock().mark
    }
}

fn params_registration(value: &JsValue) -> Result<u64, JsError> {
    exact_u64(value)
        .filter(|value| *value >= 1)
        .ok_or_else(|| range_error("Params registration"))
}

struct ChartOwnerToken {
    store: DataIdentity,
    chart: NativeChartIdentityToken,
}

impl ChartOwnerToken {
    fn capture(chart: &NativeChart) -> Self {
        Self {
            store: chart.data().store().data_identity(),
            chart: chart.capture_identity(),
        }
    }

    fn matches(&self, chart: &NativeChart) -> bool {
        self.store.same_store(&chart.data().store().data_identity())
            && chart.validate_identity(&self.chart)
    }
}

struct RuntimeOwnerToken {
    chart: ChartOwnerToken,
    formatter: NativeFormatterIdentityToken,
    input: InteractionSourceOwnerToken,
    size: NativeSizeState,
}

impl RuntimeOwnerToken {
    fn capture(
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
        active_message: &str,
    ) -> Result<Self, JsError> {
        if input.gesture_kind().is_some() || input.pointer_count() != 0 {
            return Err(ordinary_error(active_message));
        }
        Ok(Self {
            chart: ChartOwnerToken::capture(chart),
            formatter: chart.capture_formatter_identity(),
            input: input.capture_source_owner()?,
            size: size.clone(),
        })
    }

    fn matches_outer(
        &self,
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
    ) -> bool {
        self.chart.matches(chart)
            && input.validate_source_controller(&self.input)
            && size.same_identity(&self.size)
    }

    fn matches_source(&self, chart: &NativeChart, input: &OwnedInteractionState) -> bool {
        chart.validate_formatter_identity(&self.formatter)
            && input.validate_source_owner(&self.input)
    }

    #[cfg(target_arch = "wasm32")]
    fn matches_web_params_outer(&self, chart: &NativeChart, input: &OwnedInteractionState) -> bool {
        self.chart.matches(chart) && input.validate_source_controller(&self.input)
    }

    #[cfg(target_arch = "wasm32")]
    fn matches_web_params_source(&self, chart: &NativeChart) -> bool {
        chart.validate_formatter_identity(&self.formatter)
    }
}

enum AsyncSourceKind {
    Correction(NativeCorrectionSource),
    Prepare(NativePrepareSource),
}

struct AsyncSourceRow {
    ticket: u64,
    source: AsyncSourceKind,
    lease: AsyncIngestionLease,
    owner: ChartOwnerToken,
    ui: Option<NativeUiCapture>,
}

struct WorkspaceSourceRow {
    ticket: u64,
    registration: Option<u64>,
    revision: f64,
    source: NativeWorkspaceSource,
    lease: AsyncIngestionLease,
    owner: RuntimeOwnerToken,
}

#[derive(Clone, Copy)]
struct ParamsWriteArm {
    slot: f64,
    offset: f64,
    count: f64,
    revision: f64,
}

struct ParamsSourceRow {
    ticket: u64,
    registration: u64,
    revision: f64,
    source: NativeParamsSource,
    lease: Option<AsyncIngestionLease>,
    owner: RuntimeOwnerToken,
    arm: Option<ParamsWriteArm>,
    #[cfg(target_arch = "wasm32")]
    web: bool,
}

fn params_owner_matches_outer(
    owner: &RuntimeOwnerToken,
    chart: &NativeChart,
    input: &OwnedInteractionState,
    size: &NativeSizeState,
    web: bool,
) -> bool {
    #[cfg(target_arch = "wasm32")]
    if web {
        return owner.matches_web_params_outer(chart, input);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = web;
    owner.matches_outer(chart, input, size)
}

fn params_owner_matches_source(
    owner: &RuntimeOwnerToken,
    chart: &NativeChart,
    input: &OwnedInteractionState,
    web: bool,
) -> bool {
    #[cfg(target_arch = "wasm32")]
    if web {
        return owner.matches_web_params_source(chart);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = web;
    owner.matches_source(chart, input)
}

impl ParamsSourceRow {
    fn matches_outer(
        &self,
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
    ) -> bool {
        params_owner_matches_outer(
            &self.owner,
            chart,
            input,
            size,
            cfg!(target_arch = "wasm32") && self.web_mode(),
        )
    }

    fn matches_source(&self, chart: &NativeChart, input: &OwnedInteractionState) -> bool {
        params_owner_matches_source(
            &self.owner,
            chart,
            input,
            cfg!(target_arch = "wasm32") && self.web_mode(),
        )
    }

    fn web_mode(&self) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            self.web
        }
        #[cfg(not(target_arch = "wasm32"))]
        false
    }
}

struct ParamsTargetRow {
    registration: u64,
    target: NativeParamsTarget,
}

enum PreparedTarget {
    Correction {
        target: Box<NativeCorrectionTarget>,
        mode: NativeUiFinishMode,
    },
    Prepare(Box<NativePrepareTarget>),
    Workspace(Box<NativeWorkspaceTarget>),
}

impl PreparedTarget {
    fn target(&mut self, slot: f64, offset: f64, count: f64) -> Result<&mut [f64], JsError> {
        match self {
            Self::Correction { target, .. } => target.target(slot, offset, count),
            Self::Prepare(target) => target.target(slot, offset, count),
            Self::Workspace(target) => {
                let valid = |value: f64| {
                    value.is_finite()
                        && value.fract() == 0.0
                        && value >= 0.0
                        && value <= usize::MAX as f64
                };
                if !valid(slot) || !valid(offset) || !valid(count) {
                    return target.target_slice(usize::MAX, usize::MAX, 0);
                }
                target.target_slice(slot as usize, offset as usize, count as usize)
            }
        }
    }

    fn take_core(&mut self) -> Result<(NativePreparedCore, NativeUiFinishMode), JsError> {
        match self {
            Self::Correction { target, mode } => {
                let core = target.take_prepared()?;
                let mode = std::mem::replace(mode, NativeUiFinishMode::Prepare);
                Ok((core, mode))
            }
            Self::Prepare(target) => Ok((target.take_prepared()?, NativeUiFinishMode::Prepare)),
            Self::Workspace(_) => Err(ordinary_error("Workspace target does not import source UI")),
        }
    }
}

/// One runtime/context's complete M6 slot owner.
pub struct NativeRuntime {
    memory: MemoryContext,
    ticket: u64,
    workspace_registration: u64,
    async_source: Option<AsyncSourceRow>,
    workspace_source: Option<WorkspaceSourceRow>,
    params_source: Option<ParamsSourceRow>,
    prepared: Option<PreparedTarget>,
    params_target: Option<ParamsTargetRow>,
    ui_import: Option<Box<NativeUiImport>>,
    ui_prepared: Option<PreparedPublication>,
    prepare_creating: bool,
    workspace_creating: bool,
    params_creating: bool,
    params_ledger: NativeParamsStatusLedger,
    #[cfg(target_arch = "wasm32")]
    web_migration_source: Option<web_migration::WebMigrationSourceState>,
    #[cfg(target_arch = "wasm32")]
    web_migration_target: Option<web_migration::WebMigrationTargetState>,
}

impl Default for NativeRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeRuntime {
    pub fn new() -> Self {
        Self::new_with_memory(MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized))
    }

    /// Chart가 없는 isolated target도 같은 엔진 account에 연결한다.
    pub fn new_with_memory(memory: MemoryContext) -> Self {
        let params_ledger = NativeParamsStatusLedger::new_with_memory(memory.clone());
        Self {
            memory,
            ticket: 0,
            workspace_registration: 0,
            async_source: None,
            workspace_source: None,
            params_source: None,
            prepared: None,
            params_target: None,
            ui_import: None,
            ui_prepared: None,
            prepare_creating: false,
            workspace_creating: false,
            params_creating: false,
            params_ledger,
            #[cfg(target_arch = "wasm32")]
            web_migration_source: None,
            #[cfg(target_arch = "wasm32")]
            web_migration_target: None,
        }
    }

    /// 아직 작업을 만들지 않은 런타임의 allocation context를 설치한다.
    pub(crate) fn set_memory_context(&mut self, memory: MemoryContext) -> Result<(), JsError> {
        if self.source_busy()
            || self.target_busy(true)
            || self.ticket != 0
            || self.workspace_registration != 0
            || self.params_ledger.mark() != 0
        {
            return Err(ordinary_error("Engine memory context already active"));
        }
        {
            let mut ledger = self.params_ledger.lock();
            ledger.memory = memory.clone();
        }
        self.memory = memory;
        Ok(())
    }

    pub fn params_ledger(&self) -> NativeParamsStatusLedger {
        self.params_ledger.clone()
    }

    fn source_busy(&self) -> bool {
        self.async_source.is_some()
            || self.workspace_source.is_some()
            || self.params_source.is_some()
            || {
                #[cfg(target_arch = "wasm32")]
                {
                    self.web_migration_source.is_some()
                }
                #[cfg(not(target_arch = "wasm32"))]
                false
            }
    }

    fn target_busy(&self, include_ui: bool) -> bool {
        self.prepared.is_some()
            || self.prepare_creating
            || self.workspace_creating
            || self.params_target.is_some()
            || self.params_creating
            || include_ui && (self.ui_import.is_some() || self.ui_prepared.is_some())
            || {
                #[cfg(target_arch = "wasm32")]
                {
                    self.web_migration_target.is_some()
                }
                #[cfg(not(target_arch = "wasm32"))]
                false
            }
    }

    fn next_ticket_checked(&mut self, message: &str) -> Result<u64, JsError> {
        if self.ticket >= MAX_SAFE_INTEGER {
            return Err(range_error(message));
        }
        self.ticket += 1;
        Ok(self.ticket)
    }

    fn next_ticket_unchecked(&mut self) -> u64 {
        self.ticket = self.ticket.saturating_add(1);
        self.ticket
    }

    pub fn call(
        &mut self,
        name: &JsString,
        args: &[JsValue],
        context: RuntimeContext<'_>,
    ) -> Result<NativeRuntimeResult, JsError> {
        let mut scope = MemoryScope::unaccounted(self.memory.oom_style());
        self.call_inner(name, args, context, &mut scope)
    }

    /// 입력 scratch와 반환 payload를 caller의 FFI serialization scope에 연결한다.
    pub fn call_scoped(
        &mut self,
        name: &JsString,
        args: &[JsValue],
        context: RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<NativeRuntimeResult, JsError> {
        let mut result = self.call_inner(name, args, context, scope)?;
        if let Some(memory) = result.output_memory.take() {
            scope
                .absorb_persistent(memory)
                .map_err(|failure| failure.into_js_error())?;
        } else {
            result.value = result
                .value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
        }
        Ok(result)
    }

    fn call_inner(
        &mut self,
        name: &JsString,
        args: &[JsValue],
        mut context: RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<NativeRuntimeResult, JsError> {
        scope
            .try_grow(name.len_utf16().saturating_mul(3))
            .map_err(|failure| failure.into_js_error())?;
        let name = name.to_string_lossy();
        let value = match name.as_str() {
            #[cfg(target_arch = "wasm32")]
            name if name.starts_with("web.migration") => {
                return self.web_migration_call(name, args, &mut context, scope);
            }
            "nativeAsyncBegin" => self.async_begin(args, &mut context, false, scope)?,
            "nativePrepareBegin" => self.async_begin(args, &mut context, true, scope)?,
            "nativeDataAsyncBegin" => self.data_async_begin(args, &mut context, scope)?,
            "nativeReleaseDataIngestion" => {
                if let Some(chart) = context.chart.as_deref_mut() {
                    chart
                        .ingestion_owner_mut()
                        .native_release_data_ingestion()
                        .to_value()
                } else {
                    object([
                        ("cancelled", JsValue::Number(0.0)),
                        ("pendingEvents", JsValue::Number(0.0)),
                        ("ownedBytes", JsValue::Number(0.0)),
                    ])
                }
            }
            "nativePrepareCreate" => self.prepare_create(args, &mut context, scope)?,
            "nativeWorkspaceTargetCreate" => {
                self.workspace_target_create(args, &mut context, scope)?
            }
            "nativeWorkspaceTargetFinish" => {
                return self.workspace_target_finish(&mut context);
            }
            "nativeWorkspaceTargetDispose" => self.workspace_target_dispose(),
            "nativeWorkspaceSourceBegin" => {
                self.workspace_source_begin(args, &mut context, scope)?
            }
            "nativeWorkspaceSourceStep" => self.workspace_source_step(args, &mut context, scope)?,
            "nativeWorkspaceSourceCheck" => self.workspace_source_check(args, &mut context)?,
            "nativeWorkspaceSourceFinish" => self.workspace_source_finish(args, &mut context)?,
            "nativeWorkspaceSourceDispose" => self.workspace_source_dispose(args, &mut context)?,
            "nativeWorkspaceSourceAbort" => self.workspace_source_abort(args, &mut context)?,
            "nativeAsyncCheck" => self.async_check(args, &mut context)?,
            "nativeAsyncCheckpoint" => self.async_checkpoint(args, &mut context, scope)?,
            "nativeAsyncUI" => {
                let (value, memory) = self.async_ui(args, &mut context)?;
                return Ok(NativeRuntimeResult::value_with_memory(value, memory));
            }
            "nativeAsyncUIBegin" => {
                let (value, memory) = self.async_ui_begin(args, &mut context)?;
                return Ok(NativeRuntimeResult::value_with_memory(value, memory));
            }
            "nativeAsyncUINext" => self.async_ui_next(args, &mut context)?,
            "nativeAsyncUICheck" => self.async_ui_check(args, &mut context)?,
            "nativeAsyncRelease" => self.async_release(args, &mut context),
            "nativeAsyncCreate" => self.async_create(args, &mut context, scope)?,
            "nativeAsyncCheckpointImport" => self.async_checkpoint_import(args, scope)?,
            "nativeAsyncStart" => self.async_start(&mut context)?,
            "nativeAsyncStep" => self.async_step(args, &mut context, scope)?,
            "nativeAsyncUIImportBegin" => self.ui_import_begin(args, &mut context, scope)?,
            "nativeAsyncUIImportChunk" => self.ui_import_chunk(args, scope)?,
            "nativeAsyncUIImportEnd" => self.ui_import_end(&mut context)?,
            "nativeAsyncFinish" => return self.async_finish(args, &mut context, scope),
            "nativeParamsSourceBegin" => self.params_source_begin(args, &mut context, false)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceBegin" => self.params_source_begin(args, &mut context, true)?,
            "nativeParamsSourceStep" => self.params_source_step(args, &mut context, scope)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceStep" => self.params_source_step(args, &mut context, scope)?,
            "nativeParamsSourceCheck" => self.params_source_check(args, &mut context)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceCheck" => self.params_source_check(args, &mut context)?,
            "nativeParamsSourceReceive" => self.params_source_receive(args, &mut context, scope)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceReceive" => self.params_source_receive(args, &mut context, scope)?,
            "nativeParamsSourceArmWrite" => self.params_source_arm(args, &mut context)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceArmWrite" => self.params_source_arm(args, &mut context)?,
            "nativeParamsSourceCheckpoint" => {
                self.params_source_checkpoint(args, &mut context, scope)?
            }
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceCheckpoint" => {
                self.params_source_checkpoint(args, &mut context, scope)?
            }
            "nativeParamsSourceValidate" => self.params_source_validate(args, &mut context)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceValidate" => self.params_source_validate(args, &mut context)?,
            "nativeParamsSourcePrepare" => self.params_source_prepare(args, &mut context)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourcePrepare" => self.params_source_prepare(args, &mut context)?,
            "nativeParamsSourcePublish" => self.params_source_publish(args, &mut context, scope)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourcePublish" => self.params_source_publish(args, &mut context, scope)?,
            "nativeParamsSourceStatus" => {
                self.params_ledger.status_scoped(argument(args, 0), scope)?
            }
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceStatus" => {
                self.params_ledger.status_scoped(argument(args, 0), scope)?
            }
            "nativeParamsSourceAbort" => self.params_source_abort(args, &mut context, scope)?,
            #[cfg(target_arch = "wasm32")]
            "web.paramsSourceAbort" => self.params_source_abort(args, &mut context, scope)?,
            "nativeParamsTargetCreate" => self.params_target_create(args, &mut context, scope)?,
            "nativeParamsTargetStart" => self.params_target_start()?,
            "nativeParamsTargetStep" => self.params_target_step(args, &mut context)?,
            "nativeParamsTargetDescriptor" => self.params_target_descriptor(context.host, scope)?,
            "nativeParamsTargetCheckpoint" => self.params_target_checkpoint(args, scope)?,
            "nativeParamsTargetDispose" => self.params_target_dispose(),
            _ => return Err(type_error("Unknown native runtime function")),
        };
        Ok(NativeRuntimeResult::value(value))
    }

    fn async_begin(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        prepare: bool,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.source_busy() {
            return Err(ordinary_error("Async capture busy"));
        }
        let message = if prepare {
            "Native prepare document depth limit"
        } else {
            "Native data event document depth limit"
        };
        let request =
            parse_entry_json_scoped(argument(args, 0), message, NumberDialect::PLATFORM, scope)?;
        let chart = current_chart(context)?;
        let owner = ChartOwnerToken::capture(chart);
        let mut lease = chart
            .ingestion_owner_mut()
            .acquire_async_lease()
            .map_err(ingestion_error)?;
        let source = if prepare {
            NativePrepareSource::capture(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                &request,
                NumberDialect::PLATFORM,
            )
            .map(AsyncSourceKind::Prepare)
        } else {
            NativeCorrectionSource::capture(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                &request,
                NumberDialect::PLATFORM,
            )
            .map(AsyncSourceKind::Correction)
        };
        let source = match source {
            Ok(source) => source,
            Err(error) => {
                chart.ingestion_owner_mut().release_async_lease(&mut lease);
                return Err(error);
            }
        };
        if !owner.matches(chart) || !chart.ingestion_owner().validate_async_lease(&lease) {
            chart.ingestion_owner_mut().release_async_lease(&mut lease);
            return Err(ordinary_error(if prepare {
                "Prepare stale: data/configuration changed"
            } else {
                "Async stale: data/configuration/revision changed"
            }));
        }
        let ticket = self.next_ticket_unchecked();
        self.async_source = Some(AsyncSourceRow {
            ticket,
            source,
            lease,
            owner,
            ui: None,
        });
        let value = async_begin_value(
            ticket,
            &self
                .async_source
                .as_ref()
                .expect("installed async source")
                .source,
            scope,
        )?;
        Ok(JsValue::String(json_text_scoped(
            &value,
            NumberDialect::PLATFORM,
            scope,
        )?))
    }

    fn data_async_begin(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let kind = match argument(args, 0) {
            JsValue::String(value) => {
                scope
                    .try_grow(value.len_utf16().saturating_mul(3))
                    .map_err(|failure| failure.into_js_error())?;
                value.to_string_lossy()
            }
            _ => return Err(type_error("Unknown async begin kind")),
        };
        if !matches!(kind.as_str(), "correction" | "columns" | "seeded") {
            return Err(type_error("Unknown async begin kind"));
        }
        let request_args = args.get(1..).unwrap_or(&[]);
        match self.async_begin(request_args, context, kind != "correction", scope) {
            Ok(value) => Ok(object([("result", value)])),
            Err(error) if error.name == "IngestionError" => Ok(object([(
                "error",
                object([
                    ("name", text("IngestionError")),
                    (
                        "code",
                        error.code.as_deref().map_or(JsValue::Undefined, text),
                    ),
                    (
                        "message",
                        JsValue::String(error.message.slice(0, Some(256))),
                    ),
                ]),
            )])),
            Err(error) => Err(error),
        }
    }

    fn prepare_create(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.target_busy(false) {
            return Err(ordinary_error("Async target busy"));
        }
        let metadata = string_scoped(argument(args, 0), "Prepare metadata", scope)?;
        self.prepare_creating = true;
        let result = NativePrepareTarget::new_with_memory(
            &metadata,
            NumberDialect::PLATFORM,
            context.host,
            self.memory.clone(),
        );
        self.prepare_creating = false;
        self.prepared = Some(PreparedTarget::Prepare(Box::new(result?)));
        Ok(JsValue::Bool(true))
    }

    fn async_create(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.target_busy(false) {
            return Err(ordinary_error("Async target busy"));
        }
        let metadata = string_scoped(argument(args, 0), "Async metadata", scope)?;
        let parse_text = metadata
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let parsed = crate::checkpoint_codec::safe_checkpoint_parse_scoped(
            &JsValue::String(parse_text),
            NumberDialect::PLATFORM,
            scope,
        )?;
        let mut mode_scope = self.memory.scope();
        let event = field(&parsed, "event")
            .unwrap_or(&JsValue::Undefined)
            .try_clone_scoped(&mut mode_scope)
            .map_err(|failure| failure.into_js_error())?;
        let mode_memory = mode_scope
            .split_persistent(js_value_heap_bytes(&event))
            .map_err(|failure| failure.into_js_error())?;
        let source_length = field(&parsed, "store")
            .and_then(|store| field(store, "length"))
            .and_then(number)
            .unwrap_or(0.0) as usize;
        let target = NativeCorrectionTarget::new_with_memory(
            &metadata,
            NumberDialect::PLATFORM,
            context.host,
            self.memory.clone(),
        )?;
        self.prepared = Some(PreparedTarget::Correction {
            target: Box::new(target),
            mode: NativeUiFinishMode::Async {
                event,
                source_length,
                memory: mode_memory,
            },
        });
        Ok(JsValue::Bool(true))
    }

    fn workspace_target_create(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.target_busy(true) {
            return Err(ordinary_error("Async target busy"));
        }
        if context.chart.is_some() || context.input.is_some() || context.size.is_some() {
            return Err(ordinary_error(
                "Workspace target requires an isolated empty runtime",
            ));
        }
        let metadata = string_scoped(argument(args, 0), "Workspace metadata", scope)?;
        self.workspace_creating = true;
        let serial = *context.next_store_serial;
        let result = NativeWorkspaceTarget::new_with_memory(
            &metadata,
            context.host,
            NumberDialect::PLATFORM,
            serial,
            self.memory.clone(),
        );
        self.workspace_creating = false;
        let target = result?;
        *context.next_store_serial += 1.0;
        self.prepared = Some(PreparedTarget::Workspace(Box::new(target)));
        Ok(JsValue::Bool(true))
    }

    fn workspace_target_finish(
        &mut self,
        context: &mut RuntimeContext<'_>,
    ) -> Result<NativeRuntimeResult, JsError> {
        if context.chart.is_some() || context.input.is_some() || context.size.is_some() {
            return Err(ordinary_error(
                "Workspace target requires an isolated empty runtime",
            ));
        }
        let mut target = match self.prepared.take() {
            Some(PreparedTarget::Workspace(target)) => target,
            other => {
                self.prepared = other;
                return Err(ordinary_error("Workspace target missing"));
            }
        };
        let restored = target.finish()?;
        let plan = restored.plan.to_value();
        let publication = restored_publication(restored, NumberDialect::PLATFORM)?;
        Ok(NativeRuntimeResult::publication(
            object([
                ("schema", text("aster.native-workspace-target-ready")),
                ("version", JsValue::Number(1.0)),
                ("status", text("target-ready")),
                ("hostPublished", JsValue::Bool(false)),
                ("plan", plan),
            ]),
            publication,
        ))
    }

    fn workspace_target_dispose(&mut self) -> JsValue {
        if self.workspace_creating {
            self.workspace_creating = false;
            return JsValue::Bool(true);
        }
        let Some(PreparedTarget::Workspace(target)) = self.prepared.as_mut() else {
            return JsValue::Bool(false);
        };
        target.abort();
        self.prepared = None;
        JsValue::Bool(true)
    }

    fn workspace_source_begin(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.source_busy() {
            return Err(ordinary_error("Async capture busy"));
        }
        let registration = match argument(args, 4) {
            JsValue::Undefined => None,
            value => {
                let value = exact_u64(value)
                    .filter(|value| *value > self.workspace_registration)
                    .ok_or_else(|| range_error("Workspace registration must increase"))?;
                self.workspace_registration = value;
                Some(value)
            }
        };
        let next_ticket = self.next_ticket_checked("Workspace source ticket limit")?;
        let revision = number(argument(args, 2)).unwrap_or(f64::NAN);
        let max_bytes = match argument(args, 3) {
            JsValue::Undefined => DEFAULT_MAX_BYTES,
            value => number(value).unwrap_or(f64::NAN),
        };
        if !max_bytes.is_finite()
            || max_bytes.fract() != 0.0
            || !(1.0..=DEFAULT_MAX_BYTES).contains(&max_bytes)
        {
            return Err(range_error("Workspace source byte limit"));
        }
        let (chart, input, size, host) = current_parts(context)?;
        let owner =
            RuntimeOwnerToken::capture(chart, input, size, "Workspace source active gesture")?;
        let native_size = native_workspace_size(size)?;
        let mut lease = chart
            .ingestion_owner_mut()
            .acquire_async_lease()
            .map_err(ingestion_error)?;
        let ingestion_document = match chart.ingestion_owner().save_scoped(scope) {
            Ok(value) => Some(value),
            Err(error) if error.code() == "NOT_CONFIGURED" => None,
            Err(error) => {
                chart.ingestion_owner_mut().release_async_lease(&mut lease);
                return Err(ingestion_error(error));
            }
        };
        let source = with_workspace_context(chart, input, host, |workspace| {
            NativeWorkspaceSource::new_with_runtime_state(
                workspace,
                Some(chart.series_caches()),
                argument(args, 0),
                argument(args, 1),
                native_size,
                revision,
                max_bytes as usize,
                ingestion_document,
            )
        });
        let source = match source {
            Ok(source) => source,
            Err(error) => {
                chart.ingestion_owner_mut().release_async_lease(&mut lease);
                return Err(error);
            }
        };
        if !owner.matches_outer(chart, input, size)
            || !owner.matches_source(chart, input)
            || !chart.ingestion_owner().validate_async_lease(&lease)
        {
            chart.ingestion_owner_mut().release_async_lease(&mut lease);
            return Err(stale_error(
                "Workspace source stale: owner/data/configuration changed",
            ));
        }
        self.workspace_source = Some(WorkspaceSourceRow {
            ticket: next_ticket,
            registration,
            revision,
            source,
            lease,
            owner,
        });
        let mut output = JsObject::new();
        output.insert(key("ticket"), JsValue::Number(next_ticket as f64));
        output.insert(key("phase"), text("admission"));
        if let Some(registration) = registration {
            output.insert(key("registration"), JsValue::Number(registration as f64));
        }
        Ok(JsValue::Object(output))
    }

    fn workspace_row(&mut self, ticket: &JsValue) -> Result<&mut WorkspaceSourceRow, JsError> {
        let ticket = exact_u64(ticket)
            .ok_or_else(|| ordinary_error("Workspace source ticket missing/released"))?;
        self.workspace_source
            .as_mut()
            .filter(|row| row.ticket == ticket)
            .ok_or_else(|| ordinary_error("Workspace source ticket missing/released"))
    }

    fn workspace_source_step(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let max_records = exact_usize(argument(args, 1)).unwrap_or(0);
        let revision = number(argument(args, 2)).unwrap_or(f64::NAN);
        let result =
            self.workspace_operation(argument(args, 0), context, |row, chart, input, host| {
                with_workspace_context(chart, input, host, |workspace| {
                    row.source.step_with_series_caches(
                        workspace,
                        chart.series_caches(),
                        max_records,
                        revision,
                    )
                })
            });
        let progress = result?;
        let row = self.workspace_row(argument(args, 0))?;
        let mut value = match &progress.to_value() {
            JsValue::Object(value) => value.clone(),
            _ => unreachable!(),
        };
        if progress.complete {
            value.insert(key("ticket"), JsValue::Number(row.ticket as f64));
            if let Some((metadata, memory)) = row.source.metadata_json_accounted()? {
                scope
                    .absorb_persistent(memory)
                    .map_err(|failure| failure.into_js_error())?;
                value.insert(key("metadataJSON"), JsValue::String(metadata));
            }
            if let Some(plan) = row.source.plan() {
                value.insert(key("plan"), plan.to_value());
            }
            if let Some(lengths) = row.source.buffers() {
                let bytes = lengths.len() * std::mem::size_of::<JsValue>();
                scope
                    .try_grow(bytes)
                    .map_err(|failure| failure.into_js_error())?;
                let mut buffers = Vec::new();
                buffers
                    .try_reserve_exact(lengths.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                for (slot, length) in lengths.into_iter().enumerate() {
                    buffers.push(object([
                        ("slot", JsValue::Number(slot as f64)),
                        ("length", JsValue::Number(length as f64)),
                    ]));
                }
                value.insert(key("buffers"), JsValue::Array(buffers));
                value.insert(key("checkpoints"), JsValue::Array(Vec::new()));
            }
        }
        Ok(JsValue::Object(value))
    }

    fn workspace_source_check(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let revision = number(argument(args, 1)).unwrap_or(f64::NAN);
        self.workspace_operation(argument(args, 0), context, |row, chart, input, host| {
            with_workspace_context(chart, input, host, |workspace| {
                row.source
                    .check_with_series_caches(workspace, chart.series_caches(), revision)
            })
        })?;
        Ok(JsValue::Bool(true))
    }

    fn workspace_source_finish(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let ticket = exact_u64(argument(args, 0));
        let revision = number(argument(args, 1)).unwrap_or(f64::NAN);
        let mut row = self
            .workspace_source
            .take()
            .filter(|row| Some(row.ticket) == ticket)
            .ok_or_else(|| ordinary_error("Workspace source ticket missing/released"))?;
        let result = (|| {
            let (chart, input, size, host) = current_parts(context)?;
            if !row.owner.matches_outer(chart, input, size)
                || !chart.ingestion_owner().validate_async_lease(&row.lease)
            {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.owner.matches_source(chart, input) {
                return Err(stale_error(
                    "Workspace source stale: owner/data/configuration changed",
                ));
            }
            let receipt = with_workspace_context(chart, input, host, |workspace| {
                row.source
                    .finish_with_series_caches(workspace, chart.series_caches(), revision)
            })?;
            if !chart.ingestion_owner().validate_async_lease(&row.lease)
                || !chart
                    .ingestion_owner_mut()
                    .release_async_lease(&mut row.lease)
                || !row.owner.matches_outer(chart, input, size)
            {
                return Err(stale_error(
                    "Workspace source stale: owner/data/configuration changed",
                ));
            }
            let mut value = match &receipt.to_value() {
                JsValue::Object(value) => value.clone(),
                _ => unreachable!(),
            };
            value.insert(key("ticket"), JsValue::Number(row.ticket as f64));
            Ok(JsValue::Object(value))
        })();
        if result.is_err()
            && let Some(chart) = context.chart.as_deref_mut()
        {
            chart
                .ingestion_owner_mut()
                .release_async_lease(&mut row.lease);
        }
        result
    }

    fn workspace_source_dispose(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let ticket = exact_u64(argument(args, 0));
        if self
            .workspace_source
            .as_ref()
            .is_none_or(|row| Some(row.ticket) != ticket)
        {
            return Ok(JsValue::Bool(false));
        }
        self.drop_workspace_source(context, None);
        Ok(JsValue::Bool(true))
    }

    fn workspace_source_abort(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let registration = params_registration_like(argument(args, 0), "Workspace registration")?;
        if self
            .workspace_source
            .as_ref()
            .is_none_or(|row| row.registration != Some(registration))
        {
            return Ok(JsValue::Bool(false));
        }
        self.drop_workspace_source(context, None);
        Ok(JsValue::Bool(true))
    }

    fn workspace_operation<R>(
        &mut self,
        ticket: &JsValue,
        context: &mut RuntimeContext<'_>,
        operation: impl FnOnce(
            &mut WorkspaceSourceRow,
            &mut NativeChart,
            &OwnedInteractionState,
            &dyn Host,
        ) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let result = (|| {
            let row = self.workspace_row(ticket)?;
            let (chart, input, size, host) = current_parts(context)?;
            if !row.owner.matches_outer(chart, input, size)
                || !chart.ingestion_owner().validate_async_lease(&row.lease)
            {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.owner.matches_source(chart, input) {
                return Err(stale_error(
                    "Workspace source stale: owner/data/configuration changed",
                ));
            }
            let result = operation(row, chart, input, host)?;
            if !row.owner.matches_outer(chart, input, size)
                || !chart.ingestion_owner().validate_async_lease(&row.lease)
            {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.owner.matches_source(chart, input) {
                return Err(stale_error(
                    "Workspace source stale: owner/data/configuration changed",
                ));
            }
            Ok(result)
        })();
        if result.is_err() {
            self.drop_workspace_source(context, None);
        }
        result
    }

    fn drop_workspace_source(&mut self, context: &mut RuntimeContext<'_>, expected: Option<u64>) {
        let Some(mut row) = self.workspace_source.take() else {
            return;
        };
        if expected.is_some_and(|ticket| ticket != row.ticket) {
            self.workspace_source = Some(row);
            return;
        }
        row.source.abort();
        if let Some(chart) = context.chart.as_deref_mut() {
            chart
                .ingestion_owner_mut()
                .release_async_lease(&mut row.lease);
        }
    }

    fn async_check(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        self.check_async_source(argument(args, 0), context)?;
        Ok(JsValue::Bool(true))
    }

    fn async_checkpoint(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        self.check_async_source(argument(args, 0), context)?;
        let row = self.async_source.as_ref().expect("checked source");
        let AsyncSourceKind::Correction(source) = &row.source else {
            return Err(type_error(
                "nativeCapture(...).checkpoint is not a function",
            ));
        };
        let chart = current_chart(context)?;
        Ok(JsValue::String(source.checkpoint_scoped(
            chart.ingestion_owner(),
            chart.model(),
            chart.indicators(),
            chart.series_caches(),
            number(argument(args, 1)).unwrap_or(f64::NAN),
            number(argument(args, 2)).unwrap_or(f64::NAN),
            number(argument(args, 3)).unwrap_or(f64::NAN),
            scope,
        )?))
    }

    fn async_ui(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<(JsValue, MemoryGroup), JsError> {
        self.check_async_source(argument(args, 0), context)?;
        let mut prepared_scope = self.memory.scope();
        let prepared = self.async_prepared_input(&mut prepared_scope)?;
        let (chart, input, size, _) = current_parts(context)?;
        let (text, memory) = NativeUiCapture::direct_with_memory(
            chart,
            input,
            size,
            prepared.as_ref(),
            NumberDialect::PLATFORM,
        )?
        .into_parts();
        Ok((JsValue::String(text), memory))
    }

    fn async_ui_begin(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<(JsValue, MemoryGroup), JsError> {
        self.check_async_source(argument(args, 0), context)?;
        if self
            .async_source
            .as_ref()
            .is_some_and(|row| row.ui.is_some())
        {
            return Err(ordinary_error("Async UI capture busy"));
        }
        let mut prepared_scope = self.memory.scope();
        let prepared = self.async_prepared_input(&mut prepared_scope)?;
        let (chart, input, size, _) = current_parts(context)?;
        let capture = NativeUiCapture::new(
            chart,
            input,
            size,
            prepared.as_ref(),
            NumberDialect::PLATFORM,
        )?;
        let (header, memory) = capture.header_json_accounted()?.into_parts();
        self.async_source.as_mut().expect("checked source").ui = Some(capture);
        Ok((JsValue::String(header), memory))
    }

    fn async_ui_next(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        self.check_async_source(argument(args, 0), context)?;
        let capture = self
            .async_source
            .as_mut()
            .and_then(|row| row.ui.as_mut())
            .ok_or_else(|| ordinary_error("Async UI capture missing"))?;
        Ok(JsValue::String(capture.next_chunk()?))
    }

    fn async_ui_check(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        self.check_async_source(argument(args, 0), context)?;
        let capture = self
            .async_source
            .as_ref()
            .and_then(|row| row.ui.as_ref())
            .filter(|capture| capture.complete())
            .ok_or_else(|| ordinary_error("Async UI incomplete source transfer"))?;
        let (chart, input, size, _) = current_parts(context)?;
        capture.check(chart, input, size)?;
        Ok(JsValue::Bool(true))
    }

    fn async_release(&mut self, args: &[JsValue], context: &mut RuntimeContext<'_>) -> JsValue {
        let ticket = exact_u64(argument(args, 0));
        if self
            .workspace_source
            .as_ref()
            .is_some_and(|row| Some(row.ticket) == ticket)
        {
            self.drop_workspace_source(context, ticket);
        }
        if self
            .async_source
            .as_ref()
            .is_some_and(|row| Some(row.ticket) == ticket)
        {
            self.drop_async_source(context);
        }
        JsValue::Bool(true)
    }

    fn check_async_source(
        &self,
        ticket: &JsValue,
        context: &mut RuntimeContext<'_>,
    ) -> Result<(), JsError> {
        let ticket = exact_u64(ticket);
        let row = self
            .async_source
            .as_ref()
            .filter(|row| Some(row.ticket) == ticket)
            .ok_or_else(|| ordinary_error("Async stale: source replaced/released"))?;
        let chart = current_chart(context)?;
        if !row.owner.matches(chart) || !chart.ingestion_owner().validate_async_lease(&row.lease) {
            return Err(ordinary_error("Async stale: source replaced/released"));
        }
        match &row.source {
            AsyncSourceKind::Correction(source) => source.check(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
            ),
            AsyncSourceKind::Prepare(source) => source.check(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
            ),
        }
    }

    fn async_prepared_input(&self, scope: &mut MemoryScope) -> Result<Option<JsValue>, JsError> {
        self.async_source
            .as_ref()
            .and_then(|row| match &row.source {
                AsyncSourceKind::Correction(_) => None,
                AsyncSourceKind::Prepare(source) => Some(source.prepared_input()),
            })
            .map(|value| {
                value
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())
            })
            .transpose()
    }

    fn drop_async_source(&mut self, context: &mut RuntimeContext<'_>) {
        let Some(mut row) = self.async_source.take() else {
            return;
        };
        match &mut row.source {
            AsyncSourceKind::Correction(source) => source.dispose(),
            AsyncSourceKind::Prepare(source) => source.dispose(),
        }
        if let Some(chart) = context.chart.as_deref_mut() {
            chart
                .ingestion_owner_mut()
                .release_async_lease(&mut row.lease);
        }
    }

    fn async_checkpoint_import(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let Some(prepared) = self.prepared.as_mut() else {
            return Err(ordinary_error("Async target missing"));
        };
        let entry = number(argument(args, 0)).unwrap_or(f64::NAN);
        let text = string_scoped(argument(args, 1), "Async checkpoint rows", scope)?;
        match prepared {
            PreparedTarget::Correction { target, .. } => target.checkpoint(entry, &text)?,
            _ => {
                return Err(type_error(
                    "nativeAsyncPrepared.checkpoint is not a function",
                ));
            }
        }
        Ok(JsValue::Bool(true))
    }

    fn async_start(&mut self, context: &mut RuntimeContext<'_>) -> Result<JsValue, JsError> {
        let Some(prepared) = self.prepared.as_mut() else {
            return Err(ordinary_error("Async target missing"));
        };
        let serial = *context.next_store_serial;
        match prepared {
            PreparedTarget::Correction { target, .. } => {
                target.start(serial)?;
                *context.next_store_serial += 1.0;
            }
            PreparedTarget::Prepare(target) => {
                target.start(serial)?;
                *context.next_store_serial += 1.0;
            }
            PreparedTarget::Workspace(target) => target.start()?,
        }
        Ok(JsValue::Bool(true))
    }

    fn async_step(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let Some(prepared) = self.prepared.as_mut() else {
            return Err(ordinary_error("Async target missing"));
        };
        let max = number(argument(args, 0)).unwrap_or(4096.0);
        let value = match prepared {
            PreparedTarget::Correction { target, .. } => {
                target.step(max, context.host)?.to_js_value()
            }
            PreparedTarget::Prepare(target) => target.step(max, context.host)?.to_js_value(),
            PreparedTarget::Workspace(target) => {
                target.step(context.host, max as usize)?.to_value()
            }
        };
        Ok(JsValue::String(json_text_scoped(
            &value,
            NumberDialect::PLATFORM,
            scope,
        )?))
    }

    fn ui_import_begin(
        &mut self,
        args: &[JsValue],
        _context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if matches!(self.prepared, Some(PreparedTarget::Workspace(_))) {
            return Err(ordinary_error("Workspace target does not import source UI"));
        }
        if self.prepared.is_none() || self.ui_import.is_some() {
            return Err(ordinary_error("Async UI target unavailable"));
        }
        let text = string_scoped(argument(args, 0), "Async UI header", scope)?;
        let import =
            NativeUiImport::new_pending(&text, NumberDialect::PLATFORM, self.memory.clone())?;
        self.ui_import = Some(Box::new(import));
        Ok(JsValue::Bool(true))
    }

    fn ui_import_chunk(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let import = self
            .ui_import
            .as_mut()
            .ok_or_else(|| ordinary_error("Async UI target missing"))?;
        let text = string_scoped(argument(args, 0), "Async UI chunk text", scope)?;
        import.chunk(&text)?;
        Ok(JsValue::Bool(true))
    }

    fn ui_import_end(&mut self, _context: &mut RuntimeContext<'_>) -> Result<JsValue, JsError> {
        {
            let import = self
                .ui_import
                .as_mut()
                .ok_or_else(|| ordinary_error("Async UI target missing"))?;
            import.validate_complete()?;
        }
        let (attached, core_installed) = self
            .ui_import
            .as_ref()
            .map(|import| (import.attached(), import.core_installed()))
            .expect("checked UI import");
        if !attached && !core_installed {
            let prepared = self
                .prepared
                .as_mut()
                .ok_or_else(|| ordinary_error("Async target missing"))?;
            let (core, mode) = prepared.take_core()?;
            self.ui_import
                .as_mut()
                .expect("checked UI import")
                .install_core(core, mode)?;
        } else if !attached {
            self.ui_import
                .as_mut()
                .expect("checked UI import")
                .attach_core()?;
        }
        let publication = self
            .ui_import
            .as_mut()
            .expect("checked UI import")
            .finish()?;
        self.ui_prepared = Some(publication);
        self.ui_import = None;
        Ok(JsValue::Bool(true))
    }

    fn async_finish(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<NativeRuntimeResult, JsError> {
        let imported = self.ui_prepared.is_some();
        let mut publication = if let Some(publication) = self.ui_prepared.take() {
            publication
        } else {
            let Some(prepared) = self.prepared.as_mut() else {
                return Err(ordinary_error("Async target missing"));
            };
            let ready = prepared.take_core();
            let (core, mode) = match ready {
                Ok(ready) => ready,
                Err(error) if error.message.to_string_lossy() == "Async result not ready" => self
                    .ui_import
                    .as_mut()
                    .and_then(|import| import.take_core_for_direct())
                    .ok_or(error)?,
                Err(error) => return Err(error),
            };
            let text = string_scoped(argument(args, 0), "Async UI state", scope)?;
            finish_direct(core, &text, mode, context.host, NumberDialect::PLATFORM)?
        };
        if let Err(error) = publication.finalize_host_state(context.host) {
            if imported {
                self.ui_prepared = Some(publication);
            }
            return Err(error);
        }
        self.ui_import = None;
        self.prepared = None;
        Ok(NativeRuntimeResult::publication(
            JsValue::Bool(true),
            publication,
        ))
    }

    fn params_source_begin(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        web: bool,
    ) -> Result<JsValue, JsError> {
        let registration = params_registration(argument(args, 4))?;
        if self.source_busy() {
            return Err(ordinary_error("Async capture busy"));
        }
        if registration <= self.params_ledger.mark() {
            return Err(range_error("Params registration must increase"));
        }
        let ticket = self.next_ticket_checked("Params source ticket limit")?;
        let revision = number(argument(args, 2)).unwrap_or(f64::NAN);
        let max_bytes = match argument(args, 3) {
            JsValue::Undefined => DEFAULT_MAX_BYTES,
            value => number(value).unwrap_or(f64::NAN),
        };
        self.params_ledger.begin(registration, ticket);
        let result = (|| {
            let (chart, input, size, host) = current_parts(context)?;
            let owner =
                RuntimeOwnerToken::capture(chart, input, size, "Native params active gesture")?;
            let mut lease = chart
                .ingestion_owner_mut()
                .acquire_async_lease()
                .map_err(ingestion_error)?;
            #[cfg(target_arch = "wasm32")]
            let source = if web {
                NativeParamsSource::capture_web(
                    chart.ingestion_owner(),
                    &lease,
                    chart.model(),
                    chart.indicators(),
                    chart.series_caches(),
                    argument(args, 0),
                    argument(args, 1),
                    revision,
                    registration as f64,
                    max_bytes,
                    NumberDialect::PLATFORM,
                    host,
                )
            } else {
                NativeParamsSource::capture(
                    chart.ingestion_owner(),
                    &lease,
                    chart.model(),
                    chart.indicators(),
                    chart.series_caches(),
                    argument(args, 0),
                    argument(args, 1),
                    revision,
                    registration as f64,
                    max_bytes,
                    NumberDialect::PLATFORM,
                    host,
                )
            };
            #[cfg(not(target_arch = "wasm32"))]
            let source = NativeParamsSource::capture(
                chart.ingestion_owner(),
                &lease,
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                argument(args, 0),
                argument(args, 1),
                revision,
                registration as f64,
                max_bytes,
                NumberDialect::PLATFORM,
                host,
            );
            let source = match source {
                Ok(source) => source,
                Err(error) => {
                    chart.ingestion_owner_mut().release_async_lease(&mut lease);
                    return Err(error);
                }
            };
            if !params_owner_matches_outer(&owner, chart, input, size, web)
                || !params_owner_matches_source(&owner, chart, input, web)
                || !chart.ingestion_owner().validate_async_lease(&lease)
            {
                chart.ingestion_owner_mut().release_async_lease(&mut lease);
                return Err(stale_error("Native params stale: source/owner changed"));
            }
            self.params_source = Some(ParamsSourceRow {
                ticket,
                registration,
                revision,
                source,
                lease: Some(lease),
                owner,
                arm: None,
                #[cfg(target_arch = "wasm32")]
                web,
            });
            let phase = if self
                .params_source
                .as_ref()
                .and_then(|row| row.source.metadata_json())
                .is_some()
            {
                "admission"
            } else {
                "noop"
            };
            Ok(object([
                ("ticket", JsValue::Number(ticket as f64)),
                ("registration", JsValue::Number(registration as f64)),
                ("phase", text(phase)),
            ]))
        })();
        if result.is_err() {
            self.params_ledger.terminal(registration, "failed");
        }
        result
    }

    fn params_row(&mut self, ticket: &JsValue) -> Result<&mut ParamsSourceRow, JsError> {
        let ticket = exact_u64(ticket)
            .ok_or_else(|| ordinary_error("Params source ticket missing/released"))?;
        self.params_source
            .as_mut()
            .filter(|row| row.ticket == ticket)
            .ok_or_else(|| ordinary_error("Params source ticket missing/released"))
    }

    fn params_source_step(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        self.params_operation(argument(args, 0), context, |row, chart| {
            row.source.step_scoped(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                number(argument(args, 1)).unwrap_or(f64::NAN),
                number(argument(args, 2)).unwrap_or(f64::NAN),
                scope,
            )
        })
    }

    fn params_source_check(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        self.params_operation(argument(args, 0), context, |row, chart| {
            row.source.check(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                number(argument(args, 1)).unwrap_or(f64::NAN),
            )
        })?;
        Ok(JsValue::Bool(true))
    }

    fn params_source_receive(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let descriptor = string_scoped(argument(args, 1), "Native params result metadata", scope)?;
        self.params_operation(argument(args, 0), context, |row, chart| {
            row.source.receive(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                &descriptor,
                number(argument(args, 2)).unwrap_or(f64::NAN),
            )
        })?;
        Ok(JsValue::Bool(true))
    }

    fn params_source_arm(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        self.params_operation(argument(args, 0), context, |row, chart| {
            let revision = number(argument(args, 4)).unwrap_or(f64::NAN);
            row.source.check(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                revision,
            )?;
            if row.arm.is_some() {
                return Err(ordinary_error("Params write already armed"));
            }
            let slot = number(argument(args, 1)).unwrap_or(f64::NAN);
            let offset = number(argument(args, 2)).unwrap_or(f64::NAN);
            let count = number(argument(args, 3)).unwrap_or(f64::NAN);
            let (outputs, capacity) = row.source.result_shape();
            if !slot.is_finite()
                || slot.fract() != 0.0
                || slot < 0.0
                || slot >= outputs as f64
                || !offset.is_finite()
                || offset.fract() != 0.0
                || offset < 0.0
                || offset > MAX_SAFE_INTEGER as f64
                || !count.is_finite()
                || count.fract() != 0.0
                || !(1.0..=16_384.0).contains(&count)
                || offset + count > capacity as f64
            {
                return Err(range_error("Params result slice"));
            }
            row.arm = Some(ParamsWriteArm {
                slot,
                offset,
                count,
                revision,
            });
            Ok(())
        })?;
        Ok(JsValue::Bool(true))
    }

    fn params_source_checkpoint(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let text = string_scoped(
            argument(args, 2),
            "Native params result checkpoint record",
            scope,
        )?;
        self.params_operation(argument(args, 0), context, |row, chart| {
            row.source.checkpoint(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                number(argument(args, 1)).unwrap_or(f64::NAN),
                &text,
                number(argument(args, 3)).unwrap_or(f64::NAN),
            )
        })?;
        Ok(JsValue::Bool(true))
    }

    fn params_source_validate(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        Ok(self
            .params_operation(argument(args, 0), context, |row, chart| {
                row.source.validate(
                    chart.ingestion_owner(),
                    chart.model(),
                    chart.indicators(),
                    chart.series_caches(),
                    number(argument(args, 1)).unwrap_or(f64::NAN),
                    number(argument(args, 2)).unwrap_or(f64::NAN),
                )
            })?
            .to_js_value())
    }

    fn params_source_prepare(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let ticket = argument(args, 0).clone();
        let revision = number(argument(args, 1)).unwrap_or(f64::NAN);
        self.params_operation(&ticket, context, |row, chart| {
            if row.arm.is_some() {
                return Err(ordinary_error("Params unconsumed write"));
            }
            row.source.prepare(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                revision,
            )
        })?;
        let mut lease = self
            .params_source
            .as_mut()
            .and_then(|row| row.lease.take())
            .ok_or_else(|| ordinary_error("Native params stale ingestion release"))?;
        let (chart, input, size, _) = current_parts(context)?;
        let before_release = chart.ingestion_owner().validate_async_lease(&lease);
        let released = chart.ingestion_owner_mut().release_async_lease(&mut lease);
        let valid = before_release
            && released
            && self.params_source.as_ref().is_some_and(|row| {
                row.matches_outer(chart, input, size) && row.matches_source(chart, input)
            });
        if !valid {
            self.drop_params_source(context, "failed");
            return Err(ordinary_error("Native params stale ingestion release"));
        }
        Ok(JsValue::Bool(true))
    }

    fn params_source_publish(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let ticket = exact_u64(argument(args, 0));
        let revision = number(argument(args, 1)).unwrap_or(f64::NAN);
        let mut row = self
            .params_source
            .take()
            .filter(|row| Some(row.ticket) == ticket)
            .ok_or_else(|| ordinary_error("Params source ticket missing/released"))?;
        let mut committed_to_ledger = false;
        let result = (|| {
            let (chart, input, size, _) = current_parts(context)?;
            if !row.matches_outer(chart, input, size) {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.matches_source(chart, input) {
                return Err(stale_error("Native params stale: source/owner changed"));
            }
            let (receipt, receipt_memory) = {
                let owner = &chart.ingestion;
                let model = &mut chart.model;
                let engine = &mut chart.indicators;
                let caches = &mut chart.series_caches;
                row.source
                    .publish_accounted(owner, model, engine, caches, revision)?
            };
            if !row.matches_outer(chart, input, size) {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.matches_source(chart, input) {
                return Err(stale_error("Native params stale: source/owner changed"));
            }
            let status = match field(&receipt, "status") {
                Some(JsValue::String(value)) if value == &key("unchanged") => "unchanged",
                _ => "committed",
            };
            self.params_ledger.terminal_accounted(
                row.registration,
                status,
                receipt,
                receipt_memory,
            );
            committed_to_ledger = true;
            self.params_ledger
                .status_scoped(&JsValue::Number(row.registration as f64), scope)
        })();
        if result.is_err() {
            if let Some(mut lease) = row.lease.take()
                && let Some(chart) = context.chart.as_deref_mut()
            {
                chart.ingestion_owner_mut().release_async_lease(&mut lease);
            }
            if !committed_to_ledger {
                self.params_ledger.terminal(row.registration, "failed");
            }
        }
        result
    }

    fn params_source_abort(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let registration = params_registration(argument(args, 0))?;
        if self
            .params_source
            .as_ref()
            .is_some_and(|row| row.registration == registration)
        {
            self.drop_params_source(context, "aborted");
        }
        self.params_ledger.status_scoped(argument(args, 0), scope)
    }

    fn params_operation<R>(
        &mut self,
        ticket: &JsValue,
        context: &mut RuntimeContext<'_>,
        operation: impl FnOnce(&mut ParamsSourceRow, &mut NativeChart) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let result = (|| {
            let row = self.params_row(ticket)?;
            let (chart, input, size, _) = current_parts(context)?;
            if !row.matches_outer(chart, input, size)
                || row
                    .lease
                    .as_ref()
                    .is_some_and(|lease| !chart.ingestion_owner().validate_async_lease(lease))
            {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.matches_source(chart, input) {
                return Err(stale_error("Native params stale: source/owner changed"));
            }
            let result = operation(row, chart)?;
            if !row.matches_outer(chart, input, size) {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.matches_source(chart, input) {
                return Err(stale_error("Native params stale: source/owner changed"));
            }
            Ok(result)
        })();
        if result.is_err()
            && !matches!(
                result.as_ref().err().map(|error| error.message.to_string_lossy()),
                Some(message) if message == "Params source ticket missing/released"
                    || message == "Params result write not armed"
            )
        {
            self.drop_params_source(context, "failed");
        }
        result
    }

    fn drop_params_source(&mut self, context: &mut RuntimeContext<'_>, status: &'static str) {
        let Some(mut row) = self.params_source.take() else {
            return;
        };
        if let Some(mut lease) = row.lease.take()
            && let Some(chart) = context.chart.as_deref_mut()
        {
            chart.ingestion_owner_mut().release_async_lease(&mut lease);
        }
        self.params_ledger.terminal(row.registration, status);
    }

    fn params_target_create(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.target_busy(true) {
            return Err(ordinary_error("Async target busy"));
        }
        if context.chart.is_some() || context.input.is_some() || context.size.is_some() {
            return Err(ordinary_error(
                "Workspace target requires an isolated empty runtime",
            ));
        }
        let metadata = string_scoped(argument(args, 0), "Native params metadata", scope)?;
        self.params_creating = true;
        let result = NativeParamsTarget::new_with_memory(
            &metadata,
            NumberDialect::PLATFORM,
            context.host,
            self.memory.clone(),
        );
        self.params_creating = false;
        let target = result?;
        let parsed = crate::checkpoint_codec::safe_checkpoint_parse_scoped(
            &JsValue::String(metadata),
            NumberDialect::PLATFORM,
            scope,
        )?;
        let registration = field(&parsed, "registration")
            .and_then(exact_u64)
            .ok_or_else(|| type_error("Native params protocol"))?;
        self.params_target = Some(ParamsTargetRow {
            registration,
            target,
        });
        Ok(JsValue::Bool(true))
    }

    fn params_target_start(&mut self) -> Result<JsValue, JsError> {
        self.params_target
            .as_mut()
            .ok_or_else(|| ordinary_error("Params target missing"))?
            .target
            .start()?;
        Ok(JsValue::Bool(true))
    }

    fn params_target_step(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let target = self
            .params_target
            .as_mut()
            .ok_or_else(|| ordinary_error("Params target missing"))?;
        match target
            .target
            .step(number(argument(args, 0)).unwrap_or(f64::NAN), context.host)
        {
            Ok(progress) => Ok(progress.to_js_value()),
            Err(error) => {
                target.target.dispose();
                Err(error)
            }
        }
    }

    fn params_target_descriptor(
        &self,
        _host: &dyn Host,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let descriptor = self
            .params_target
            .as_ref()
            .ok_or_else(|| ordinary_error("Params target missing"))?
            .target
            .descriptor_scoped(scope)?;
        Ok(JsValue::String(
            crate::checkpoint_codec::safe_checkpoint_stringify_scoped(
                &descriptor,
                NumberDialect::PLATFORM,
                scope,
            )?,
        ))
    }

    fn params_target_checkpoint(
        &self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let row = self
            .params_target
            .as_ref()
            .ok_or_else(|| ordinary_error("Params target missing"))?
            .target
            .checkpoint_scoped(number(argument(args, 0)).unwrap_or(f64::NAN), scope)?;
        Ok(object([
            ("index", JsValue::Number(row.index as f64)),
            ("text", JsValue::String(row.text)),
        ]))
    }

    fn params_target_dispose(&mut self) -> JsValue {
        if self.params_creating {
            self.params_creating = false;
            return JsValue::Bool(true);
        }
        let Some(mut target) = self.params_target.take() else {
            return JsValue::Bool(false);
        };
        target.target.dispose();
        JsValue::Bool(true)
    }

    /// `nativeAsyncBuffer` exact priority routing. Returned slice is valid only for this call.
    pub fn read_f64<'a>(
        &'a mut self,
        context: RuntimeContext<'a>,
        ticket: &JsValue,
        slot: &JsValue,
        offset: &JsValue,
        count: &JsValue,
    ) -> Result<&'a [f64], JsError> {
        let ticket_number = number(ticket).unwrap_or(f64::NAN);
        let slot_number = number(slot).unwrap_or(f64::NAN);
        let offset_number = number(offset).unwrap_or(f64::NAN);
        let count_number = number(count).unwrap_or(f64::NAN);
        let RuntimeContext {
            mut chart,
            input,
            size,
            host,
            ..
        } = context;
        if self
            .params_source
            .as_ref()
            .is_some_and(|row| ticket_number == row.ticket as f64)
        {
            let preflight = match (chart.as_deref(), input, size) {
                (None, _, _) => Err(type_error("Workspace own data slot: nativeModel")),
                (_, None, _) => Err(type_error("Workspace own data slot: nativeInput")),
                (_, _, None) => Err(type_error("Workspace own data slot: nativeSize")),
                (Some(chart), Some(input), Some(size)) => {
                    let row = self.params_source.as_ref().expect("matched params source");
                    if !row.matches_outer(chart, input, size)
                        || row.lease.as_ref().is_some_and(|lease| {
                            !chart.ingestion_owner().validate_async_lease(lease)
                        })
                    {
                        Err(ordinary_error(
                            "Workspace source stale: native owner replaced",
                        ))
                    } else if !row.matches_source(chart, input) {
                        Err(stale_error("Native params stale: source/owner changed"))
                    } else {
                        row.source.check_buffer_slice(
                            chart.ingestion_owner(),
                            chart.model(),
                            chart.indicators(),
                            chart.series_caches(),
                            slot_number,
                            offset_number,
                            count_number,
                            row.revision,
                        )
                    }
                }
            };
            if let Err(error) = preflight {
                let mut row = self.params_source.take().expect("matched params source");
                if let Some(mut lease) = row.lease.take()
                    && let Some(chart) = chart.as_deref_mut()
                {
                    chart.ingestion_owner_mut().release_async_lease(&mut lease);
                }
                self.params_ledger.terminal(row.registration, "failed");
                return Err(error);
            }
            let chart = chart.expect("validated params chart");
            let row = self.params_source.as_mut().expect("matched params source");
            return row.source.buffer(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                slot_number,
                offset_number,
                count_number,
                row.revision,
            );
        }
        if let Some(target) = self.params_target.as_ref() {
            let registration =
                exact_u64(ticket).ok_or_else(|| ordinary_error("Params target registration"))?;
            if registration != target.registration {
                return Err(ordinary_error("Params target registration"));
            }
            return target
                .target
                .output_buffer(slot_number, offset_number, count_number);
        }
        if self
            .workspace_source
            .as_ref()
            .is_some_and(|row| ticket_number == row.ticket as f64)
        {
            let row = self.workspace_source.as_mut().expect("matched workspace");
            let chart = chart.ok_or_else(|| type_error("Workspace own data slot: nativeModel"))?;
            let input = input.ok_or_else(|| type_error("Workspace own data slot: nativeInput"))?;
            let size = size.ok_or_else(|| type_error("Workspace own data slot: nativeSize"))?;
            if !row.owner.matches_outer(chart, input, size)
                || !chart.ingestion_owner().validate_async_lease(&row.lease)
            {
                return Err(ordinary_error(
                    "Workspace source stale: native owner replaced",
                ));
            }
            if !row.owner.matches_source(chart, input) {
                return Err(stale_error(
                    "Workspace source stale: owner/data/configuration changed",
                ));
            }
            let revision = row.revision;
            let slot = exact_usize(slot).unwrap_or(usize::MAX);
            let offset = exact_usize(offset).unwrap_or(usize::MAX);
            let count = exact_usize(count).unwrap_or(usize::MAX);
            let preflight =
                workspace_check_read_slice(row, chart, input, host, slot, offset, count, revision);
            if let Err(error) = preflight {
                let mut row = self
                    .workspace_source
                    .take()
                    .expect("matched workspace source");
                chart
                    .ingestion_owner_mut()
                    .release_async_lease(&mut row.lease);
                return Err(error);
            }
            let row = self.workspace_source.as_mut().expect("matched workspace");
            return workspace_read_slice(row, chart, input, host, slot, offset, count, revision);
        }
        let row = self
            .async_source
            .as_ref()
            .ok_or_else(|| ordinary_error("Async stale: source replaced/released"))?;
        if Some(row.ticket) != exact_u64(ticket) {
            return Err(ordinary_error("Async stale: source replaced/released"));
        }
        let AsyncSourceKind::Correction(source) = &row.source else {
            return Err(type_error("nativeCapture(...).buffer is not a function"));
        };
        let chart = chart.ok_or_else(|| type_error("Workspace own data slot: nativeModel"))?;
        if !row.owner.matches(chart) || !chart.ingestion_owner().validate_async_lease(&row.lease) {
            return Err(ordinary_error("Async stale: source replaced/released"));
        }
        source.check(
            chart.ingestion_owner(),
            chart.model(),
            chart.indicators(),
            chart.series_caches(),
        )?;
        source.buffer(
            chart.ingestion_owner(),
            chart.model(),
            chart.indicators(),
            chart.series_caches(),
            slot_number,
            offset_number,
            count_number,
        )
    }

    /// `nativeAsyncTargetBuffer` exact priority routing. Handout consumes its arm/cursor once.
    pub fn target_f64<'a>(
        &'a mut self,
        mut context: RuntimeContext<'a>,
        slot: &JsValue,
        offset: &JsValue,
        count: &JsValue,
    ) -> Result<&'a mut [f64], JsError> {
        let slot = number(slot).unwrap_or(f64::NAN);
        let offset = number(offset).unwrap_or(f64::NAN);
        let count = number(count).unwrap_or(f64::NAN);
        if self.params_source.is_some() {
            let arm = self
                .params_source
                .as_mut()
                .and_then(|row| row.arm.take())
                .ok_or_else(|| ordinary_error("Params result write not armed"))?;
            if slot != arm.slot || offset != arm.offset || count != arm.count {
                self.drop_params_source(&mut context, "failed");
                return Err(range_error("Params armed slice mismatch"));
            }
            let preflight = {
                let (chart, input, size, _) = current_parts(&mut context)?;
                let row = self.params_source.as_ref().expect("armed params source");
                if !row.matches_outer(chart, input, size) {
                    Err(ordinary_error(
                        "Workspace source stale: native owner replaced",
                    ))
                } else if !row.matches_source(chart, input) {
                    Err(stale_error("Native params stale: source/owner changed"))
                } else {
                    row.source.check_result_slice(
                        chart.ingestion_owner(),
                        chart.model(),
                        chart.indicators(),
                        chart.series_caches(),
                        slot,
                        offset,
                        count,
                        arm.revision,
                    )
                }
            };
            if let Err(error) = preflight {
                self.drop_params_source(&mut context, "failed");
                return Err(error);
            }
            let row = self.params_source.as_mut().expect("armed params source");
            let chart = current_chart(&mut context)?;
            return row.source.result_buffer(
                chart.ingestion_owner(),
                chart.model(),
                chart.indicators(),
                chart.series_caches(),
                slot,
                offset,
                count,
                arm.revision,
            );
        }
        if let Some(target) = self.params_target.as_mut() {
            return target.target.target(slot, offset, count);
        }
        self.prepared
            .as_mut()
            .ok_or_else(|| ordinary_error("Async target missing"))?
            .target(slot, offset, count)
    }
}

fn current_chart<'a>(context: &'a mut RuntimeContext<'_>) -> Result<&'a mut NativeChart, JsError> {
    context
        .chart
        .as_deref_mut()
        .ok_or_else(|| type_error("Workspace own data slot: nativeModel"))
}

fn current_parts<'a>(
    context: &'a mut RuntimeContext<'_>,
) -> Result<
    (
        &'a mut NativeChart,
        &'a OwnedInteractionState,
        &'a NativeSizeState,
        &'a dyn Host,
    ),
    JsError,
> {
    let RuntimeContext {
        chart,
        input,
        size,
        host,
        ..
    } = context;
    Ok((
        chart
            .as_deref_mut()
            .ok_or_else(|| type_error("Workspace own data slot: nativeModel"))?,
        input
            .as_deref()
            .ok_or_else(|| type_error("Workspace own data slot: nativeInput"))?,
        size.as_deref()
            .ok_or_else(|| type_error("Workspace own data slot: nativeSize"))?,
        *host,
    ))
}

fn native_workspace_size(size: &NativeSizeState) -> Result<NativeWorkspaceSize, JsError> {
    match (size.width(), size.height()) {
        (JsValue::Number(width), JsValue::Number(height))
            if width.is_finite() && height.is_finite() =>
        {
            Ok(NativeWorkspaceSize {
                width: *width,
                height: *height,
            })
        }
        _ => Err(type_error("Workspace source size")),
    }
}

fn with_workspace_context<R>(
    chart: &NativeChart,
    input: &OwnedInteractionState,
    host: &dyn Host,
    operation: impl FnOnce(&WorkspaceContext<'_>) -> Result<R, JsError>,
) -> Result<R, JsError> {
    let provider = chart
        .symbol_record()
        .and_then(|record| field(record, "provider"))
        .and_then(|value| match value {
            JsValue::String(value) => Some(value),
            _ => None,
        });
    let adjustment_version = chart
        .symbol_record()
        .and_then(|record| field(record, "adjustmentVersion"))
        .and_then(|value| match value {
            JsValue::String(value) => Some(value),
            _ => None,
        });
    let workspace = WorkspaceContext {
        host,
        model: chart.model(),
        store: chart.data().store(),
        indicators: chart.indicators(),
        drawings: chart.drawings(),
        symbol: chart.symbol().map(|symbol| WorkspaceSymbol {
            symbol,
            provider,
            adjustment_version,
        }),
        symbol_formatters: chart.symbol_formatters(),
        interaction: WorkspaceInteraction {
            gesture_active: input.gesture_kind().is_some(),
            pointer_count: input.pointer_count(),
        },
        dialect: chart.dialect(),
    };
    operation(&workspace)
}

#[allow(clippy::too_many_arguments)]
fn workspace_read_slice<'a>(
    row: &mut WorkspaceSourceRow,
    chart: &'a NativeChart,
    input: &'a OwnedInteractionState,
    host: &'a dyn Host,
    slot: usize,
    offset: usize,
    count: usize,
    revision: f64,
) -> Result<&'a [f64], JsError> {
    let provider = chart
        .symbol_record()
        .and_then(|record| field(record, "provider"))
        .and_then(|value| match value {
            JsValue::String(value) => Some(value),
            _ => None,
        });
    let adjustment_version = chart
        .symbol_record()
        .and_then(|record| field(record, "adjustmentVersion"))
        .and_then(|value| match value {
            JsValue::String(value) => Some(value),
            _ => None,
        });
    let workspace = WorkspaceContext {
        host,
        model: chart.model(),
        store: chart.data().store(),
        indicators: chart.indicators(),
        drawings: chart.drawings(),
        symbol: chart.symbol().map(|symbol| WorkspaceSymbol {
            symbol,
            provider,
            adjustment_version,
        }),
        symbol_formatters: chart.symbol_formatters(),
        interaction: WorkspaceInteraction {
            gesture_active: input.gesture_kind().is_some(),
            pointer_count: input.pointer_count(),
        },
        dialect: chart.dialect(),
    };
    row.source.read_slice_with_series_caches(
        &workspace,
        chart.series_caches(),
        slot,
        offset,
        count,
        revision,
    )
}

#[allow(clippy::too_many_arguments)]
fn workspace_check_read_slice(
    row: &WorkspaceSourceRow,
    chart: &NativeChart,
    input: &OwnedInteractionState,
    host: &dyn Host,
    slot: usize,
    offset: usize,
    count: usize,
    revision: f64,
) -> Result<(), JsError> {
    with_workspace_context(chart, input, host, |workspace| {
        row.source.check_read_slice_with_series_caches(
            workspace,
            chart.series_caches(),
            slot,
            offset,
            count,
            revision,
        )
    })
}

fn async_begin_value(
    ticket: u64,
    source: &AsyncSourceKind,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let (metadata, buffers, checkpoints) = match source {
        AsyncSourceKind::Correction(source) => {
            let metadata = source
                .metadata_json()
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            let buffer_count = field(source.metadata(), "bufferLengths")
                .and_then(|value| match value {
                    JsValue::Array(values) => Some(values.len()),
                    _ => None,
                })
                .unwrap_or(0);
            scope
                .try_grow(buffer_count.saturating_mul(std::mem::size_of::<
                    crate::native_data_jobs::NativeBufferDescriptor,
                >()))
                .map_err(|failure| failure.into_js_error())?;
            let descriptors = source.buffer_descriptors();
            let mut buffers = Vec::new();
            scope
                .try_grow(descriptors.len() * std::mem::size_of::<JsValue>())
                .map_err(|failure| failure.into_js_error())?;
            buffers
                .try_reserve_exact(descriptors.len())
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            for descriptor in descriptors {
                buffers.push(object([
                    ("slot", JsValue::Number(descriptor.slot as f64)),
                    ("length", JsValue::Number(descriptor.length as f64)),
                ]));
            }
            let checkpoint_count = field(source.metadata(), "indicators")
                .and_then(|value| match value {
                    JsValue::Array(values) => Some(values.len()),
                    _ => None,
                })
                .unwrap_or(0);
            scope
                .try_grow(checkpoint_count.saturating_mul(std::mem::size_of::<
                    crate::native_data_jobs::NativeCheckpointDescriptor,
                >()))
                .map_err(|failure| failure.into_js_error())?;
            let descriptors = source.checkpoint_descriptors();
            let mut checkpoints = Vec::new();
            scope
                .try_grow(descriptors.len() * std::mem::size_of::<JsValue>())
                .map_err(|failure| failure.into_js_error())?;
            checkpoints
                .try_reserve_exact(descriptors.len())
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            for descriptor in descriptors {
                checkpoints.push(object([
                    ("entry", JsValue::Number(descriptor.entry as f64)),
                    ("total", JsValue::Number(descriptor.total as f64)),
                    ("maxRows", JsValue::Number(descriptor.max_rows as f64)),
                ]));
            }
            (metadata, buffers, checkpoints)
        }
        AsyncSourceKind::Prepare(source) => {
            let metadata = source
                .metadata_json()
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            (metadata, Vec::new(), Vec::new())
        }
    };
    Ok(object([
        ("ticket", JsValue::Number(ticket as f64)),
        ("metadataJSON", JsValue::String(metadata)),
        ("buffers", JsValue::Array(buffers)),
        ("checkpoints", JsValue::Array(checkpoints)),
    ]))
}

fn params_registration_like(value: &JsValue, message: &str) -> Result<u64, JsError> {
    exact_u64(value)
        .filter(|value| *value >= 1)
        .ok_or_else(|| range_error(message))
}

/// Poisoned/closed CoreState 없이 workspace cleanup whitelist를 답한다.
pub fn workspace_abort_without_core(registration: &JsValue) -> Result<JsValue, JsError> {
    params_registration_like(registration, "Workspace registration")?;
    Ok(JsValue::Bool(false))
}

fn restored_publication(
    restored: RestoredWorkspace,
    dialect: NumberDialect,
) -> Result<PreparedPublication, JsError> {
    let RestoredWorkspace {
        data,
        model,
        indicators,
        drawings,
        series_caches,
        symbol,
        symbol_formatters,
        ingestion_document,
        ingestion_memory,
        memory: mut symbol_memory,
        size,
        ..
    } = restored;
    let mut ingestion = IngestionOwner::new(data, dialect);
    if let Some(document) = ingestion_document {
        ingestion
            .load(&JsValue::String(document))
            .map_err(ingestion_error)?;
    }
    drop(ingestion_memory);
    let (symbol, symbol_record) = workspace_symbol_parts(symbol, &mut symbol_memory)?;
    let memory_context = ingestion.data().store().memory_context().clone();
    let chart = NativeChart::from_parts(NativeChartParts {
        ingestion,
        model,
        indicators,
        drawings,
        series_caches,
        symbol,
        symbol_record,
        symbol_formatters,
        symbol_memory,
        dialect,
    })?;
    let input =
        OwnedInteractionState::new_with_memory(chart.data().store().memory_context().clone())?;
    Ok(PreparedPublication::ready(
        chart,
        input,
        JsValue::Number(size.width),
        JsValue::Number(size.height),
        MemoryGroup::empty(memory_context),
    ))
}

fn workspace_symbol_parts(
    value: Option<NativeWorkspaceSymbol>,
    retained_memory: &mut MemoryGroup,
) -> Result<(Option<crate::markets::Symbol>, Option<JsValue>), JsError> {
    let Some(value) = value else {
        return Ok((None, None));
    };
    let symbol = value.symbol;
    let adjustment = match symbol.adjustment {
        Adjustment::Raw => "raw",
        Adjustment::Split => "split",
        Adjustment::TotalReturn => "total-return",
    };
    let symbol_bytes = js_string_heap_bytes(&symbol.id)
        .saturating_add(js_string_heap_bytes(&symbol.exchange))
        .saturating_add(js_string_heap_bytes(&symbol.timezone))
        .saturating_add(js_string_heap_bytes(&symbol.currency))
        .saturating_add(js_string_heap_bytes(&symbol.volume_unit))
        .saturating_add(value.provider.as_ref().map_or(0, js_string_heap_bytes))
        .saturating_add(
            value
                .adjustment_version
                .as_ref()
                .map_or(0, js_string_heap_bytes),
        );
    retained_memory
        .try_resize(symbol_bytes)
        .map_err(|failure| failure.into_js_error())?;
    let memory = retained_memory.context().clone();
    let mut scope = memory.scope();
    let capacity =
        8 + usize::from(value.provider.is_some()) + usize::from(value.adjustment_version.is_some());
    scope
        .try_grow(capacity * std::mem::size_of::<(JsString, JsValue)>())
        .map_err(|failure| failure.into_js_error())?;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    push_symbol_string(&mut entries, &mut scope, "id", &symbol.id)?;
    push_symbol_string(&mut entries, &mut scope, "exchange", &symbol.exchange)?;
    push_symbol_string(&mut entries, &mut scope, "timezone", &symbol.timezone)?;
    push_symbol_string(&mut entries, &mut scope, "currency", &symbol.currency)?;
    push_symbol_string(&mut entries, &mut scope, "volumeUnit", &symbol.volume_unit)?;
    entries.push((
        JsString::try_from_str("priceDecimals", &mut scope)
            .map_err(|failure| failure.into_js_error())?,
        JsValue::Number(f64::from(symbol.price_decimals)),
    ));
    entries.push((
        JsString::try_from_str("tickSize", &mut scope)
            .map_err(|failure| failure.into_js_error())?,
        JsValue::Number(symbol.tick_size),
    ));
    push_symbol_utf8(&mut entries, &mut scope, "adjustment", adjustment)?;
    if let Some(provider) = value.provider.as_ref() {
        push_symbol_string(&mut entries, &mut scope, "provider", provider)?;
    }
    if let Some(version) = value.adjustment_version.as_ref() {
        push_symbol_string(&mut entries, &mut scope, "adjustmentVersion", version)?;
    }
    let record = JsValue::Object(
        JsObject::try_from_entries_scoped(entries, &mut scope)
            .map_err(|failure| failure.into_js_error())?,
    );
    let record_memory = scope
        .split_persistent(js_value_heap_bytes(&record))
        .map_err(|failure| failure.into_js_error())?;
    retained_memory
        .absorb(record_memory)
        .map_err(|failure| failure.into_js_error())?;
    Ok((Some(symbol), Some(record)))
}

fn push_symbol_string(
    entries: &mut Vec<(JsString, JsValue)>,
    scope: &mut MemoryScope,
    name: &str,
    value: &JsString,
) -> Result<(), JsError> {
    entries.push((
        JsString::try_from_str(name, scope).map_err(|failure| failure.into_js_error())?,
        JsValue::String(
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    ));
    Ok(())
}

fn push_symbol_utf8(
    entries: &mut Vec<(JsString, JsValue)>,
    scope: &mut MemoryScope,
    name: &str,
    value: &str,
) -> Result<(), JsError> {
    entries.push((
        JsString::try_from_str(name, scope).map_err(|failure| failure.into_js_error())?,
        JsValue::String(
            JsString::try_from_str(value, scope).map_err(|failure| failure.into_js_error())?,
        ),
    ));
    Ok(())
}
