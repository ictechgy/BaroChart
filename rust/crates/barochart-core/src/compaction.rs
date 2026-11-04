//! 같은 Store owner를 유지하며 앞 history와 모든 derived cache를 원자적으로 재시작한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

use crate::contracts::RESOURCE_LIMITS;
use crate::data::{DataChange, StoreCompactionReceipt};
use crate::indicator_engine::IndicatorEngine;
use crate::indicator_helpers::exact_state_equal;
use crate::ingestion::{
    IngestionCompactionError, IngestionError, IngestionOwner, PendingDataPolicy,
};
use crate::model_state::{ModelState, VisibleRange};

const MAX_PEAK_BYTES: usize = 192 * RESOURCE_LIMITS.max_bars as usize;

fn key(name: &str) -> JsString {
    JsString::from_str(name)
}
fn js_error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, JsString::from_str(message))
}
fn type_error(message: &str) -> JsError {
    js_error("TypeError", message)
}
fn range_error(message: &str) -> JsError {
    js_error("RangeError", message)
}
fn ordinary_error(message: &str) -> JsError {
    js_error("Error", message)
}
fn stale_error() -> JsError {
    js_error("StaleSourceError", "Compaction owner or source changed")
}
fn value_string(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}
fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item);
    }
    JsValue::Object(value)
}
fn property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// Root 실제 owner/interaction/drawing 상태에서 만든 guard DTO다.
#[derive(Clone, Copy, Debug)]
pub struct CompactionContext {
    /// 실제 store owner가 model+engine 하나뿐인지 Root가 확인한 값이다.
    pub exclusive_owner: bool,
    /// controller gesture가 활성 상태인지다.
    pub active_gesture: bool,
    /// drawing transaction이 활성 상태인지다.
    pub drawing_transaction: bool,
}

/// Source error class와 ingestion fence BUSY를 구분한 compaction 오류다.
#[derive(Debug)]
pub enum CompactionError {
    Js(JsError),
    Ingestion(IngestionError),
}
impl CompactionError {
    /// JS 오류 이름이다.
    pub fn name(&self) -> &str {
        match self {
            Self::Js(error) => error.name,
            Self::Ingestion(_) => "IngestionError",
        }
    }
    /// IngestionError일 때만 안정 code가 있다.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Js(_) => None,
            Self::Ingestion(error) => Some(error.code()),
        }
    }
    /// UTF-16 오류 문구다.
    pub fn message(&self) -> &JsString {
        match self {
            Self::Js(error) => &error.message,
            Self::Ingestion(error) => error.message(),
        }
    }
}
impl From<JsError> for CompactionError {
    fn from(value: JsError) -> Self {
        Self::Js(value)
    }
}
impl From<IngestionCompactionError> for CompactionError {
    fn from(value: IngestionCompactionError) -> Self {
        match value {
            IngestionCompactionError::Busy(error) => Self::Ingestion(error),
            IngestionCompactionError::State(error) => Self::Js(error),
        }
    }
}

/// Public compactData receipt다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompactionReceipt {
    /// 제거한 앞 행 수다.
    pub removed: usize,
    /// 남긴 행 수다.
    pub length: usize,
    /// 새 power-of-two capacity다.
    pub capacity: usize,
    /// 새 store logical bytes다.
    pub bytes: usize,
    /// 이전 store logical bytes다.
    pub previous_bytes: usize,
    /// old+new source가 동시에 존재한 peak bytes다.
    pub peak_source_bytes: usize,
    /// 남은 첫 timestamp다.
    pub first_retained_time: f64,
    /// 게시된 store version이다.
    pub version: f64,
    /// 게시된 time version이다.
    pub time_version: f64,
    /// Root invalidation callback이 commit 뒤 실패했는지다.
    pub invalidation_failed: bool,
}
impl CompactionReceipt {
    fn from_store(value: StoreCompactionReceipt) -> Self {
        Self {
            removed: value.removed,
            length: value.length,
            capacity: value.capacity,
            bytes: value.bytes,
            previous_bytes: value.previous_bytes,
            peak_source_bytes: value.peak_source_bytes,
            first_retained_time: value.first_retained_time,
            version: value.version,
            time_version: value.time_version,
            invalidation_failed: false,
        }
    }
    /// Root invalidation callback 실패를 rollback 없이 기록한다.
    pub fn mark_invalidation_failed(&mut self) {
        self.invalidation_failed = true
    }
    /// JS receipt key 순서의 값을 만든다.
    pub fn to_js_value(self) -> JsValue {
        object([
            ("removed", JsValue::Number(self.removed as f64)),
            ("length", JsValue::Number(self.length as f64)),
            ("capacity", JsValue::Number(self.capacity as f64)),
            ("bytes", JsValue::Number(self.bytes as f64)),
            ("previousBytes", JsValue::Number(self.previous_bytes as f64)),
            (
                "peakSourceBytes",
                JsValue::Number(self.peak_source_bytes as f64),
            ),
            (
                "firstRetainedTime",
                JsValue::Number(self.first_retained_time),
            ),
            ("version", JsValue::Number(self.version)),
            ("timeVersion", JsValue::Number(self.time_version)),
            ("studyHistory", value_string("restart")),
            (
                "invalidationFailed",
                JsValue::Bool(self.invalidation_failed),
            ),
        ])
    }
}

/// Commit 결과와 Root 후속 instruction이다.
#[derive(Clone, Debug)]
pub struct CompactionOutcome {
    /// public receipt다.
    pub receipt: CompactionReceipt,
    /// Root listener에 commit 뒤 전달할 compact change다. no-op이면 없다.
    pub change: Option<DataChange>,
    /// Root crosshair를 commit 구간에서 지우라는 instruction이다.
    pub clear_crosshair: bool,
    /// Root invalidation callback을 한 번 호출하라는 instruction이다.
    pub request_invalidation: bool,
}

struct Options {
    keep: usize,
    max_peak: usize,
    pending: PendingDataPolicy,
}
fn parse_options(value: &JsValue) -> Result<Options, JsError> {
    let JsValue::Object(value) = value else {
        return Err(type_error("Compaction options plain data compactionRecord"));
    };
    if value.iter().any(|(name, _)| {
        ![
            "keepLastBars",
            "studyHistory",
            "maxPeakStoreBytes",
            "pendingData",
        ]
        .iter()
        .any(|allowed| name.as_units().iter().copied().eq(allowed.encode_utf16()))
    }) {
        return Err(type_error("Compaction options own data properties"));
    }
    let keep = match value.get(&key("keepLastBars")) {
        Some(JsValue::Number(value))
            if safe_integer(*value)
                && *value >= 1.0
                && *value <= RESOURCE_LIMITS.max_bars as f64 =>
        {
            *value as usize
        }
        _ => {
            return Err(range_error(
                "Positive keepLastBars and studyHistory restart required",
            ));
        }
    };
    if !matches!(value.get(&key("studyHistory")),Some(JsValue::String(value))if value==&JsString::from_str("restart"))
    {
        return Err(range_error(
            "Positive keepLastBars and studyHistory restart required",
        ));
    }
    let pending = match value.get(&key("pendingData")) {
        None | Some(JsValue::Undefined) => PendingDataPolicy::Reject,
        Some(JsValue::String(value)) if value == &JsString::from_str("reject") => {
            PendingDataPolicy::Reject
        }
        Some(JsValue::String(value)) if value == &JsString::from_str("preserve-retained") => {
            PendingDataPolicy::PreserveRetained
        }
        _ => return Err(type_error("Compaction pendingData policy")),
    };
    let max_peak = match value.get(&key("maxPeakStoreBytes")) {
        None | Some(JsValue::Undefined) => MAX_PEAK_BYTES,
        Some(JsValue::Number(value))
            if safe_integer(*value) && *value >= 0.0 && *value <= MAX_PEAK_BYTES as f64 =>
        {
            *value as usize
        }
        _ => return Err(range_error("Compaction source peak byte limit")),
    };
    Ok(Options {
        keep,
        max_peak,
        pending,
    })
}

struct SeriesGuard {
    identity: usize,
    wire: JsValue,
    values: Option<(usize, usize)>,
}

struct ModelPlan {
    series: Vec<SeriesGuard>,
    panels: Vec<JsValue>,
    axes: Vec<JsValue>,
    view: VisibleRange,
    follow: bool,
    next_view: VisibleRange,
}
impl ModelPlan {
    fn capture(model: &ModelState, keep: usize, removed: usize) -> Result<Self, JsError> {
        let series = model
            .series
            .iter()
            .map(|series| SeriesGuard {
                identity: series as *const _ as usize,
                wire: series.to_js_value(),
                values: series
                    .values
                    .as_ref()
                    .map(|values| (values.as_ptr() as usize, values.len())),
            })
            .collect::<Vec<_>>();
        if model.series.iter().any(|series| series.values.is_some()) {
            return Err(ordinary_error(
                "Compaction requires host realignment of external values",
            ));
        }
        for panel in &model.panels {
            if panel.scale == JsString::from_str("percent") {
                let value = panel.to_js_value();
                if property(&value, "base").is_none_or(|base| matches!(base, JsValue::Undefined)) {
                    return Err(ordinary_error(
                        "Compaction percent panel requires an explicit base",
                    ));
                }
            }
        }
        if !model.view.from.is_finite()
            || !model.view.to.is_finite()
            || model.view.to <= model.view.from
        {
            return Err(type_error("Compaction visible range"));
        }
        let span = model.view.to - model.view.from;
        let forward = model.forward_offset();
        let end = keep as f64 + forward - 0.5;
        let from = if model.follow {
            end - span
        } else {
            js_max(&[
                -0.5,
                js_min(&[end - span, model.view.from - removed as f64]),
            ])
        };
        Ok(Self {
            series,
            panels: model
                .panels
                .iter()
                .map(|panel| panel.to_js_value())
                .collect(),
            axes: model.axes.iter().map(|axis| axis.to_js_value()).collect(),
            view: model.view,
            follow: model.follow,
            next_view: VisibleRange {
                from,
                to: from + span,
            },
        })
    }
    fn matches(&self, model: &ModelState) -> bool {
        self.series.len() == model.series.len()
            && self
                .series
                .iter()
                .zip(&model.series)
                .all(|(expected, series)| {
                    expected.identity == series as *const _ as usize
                        && exact_state_equal(&expected.wire, &series.to_js_value())
                        && expected.values
                            == series
                                .values
                                .as_ref()
                                .map(|values| (values.as_ptr() as usize, values.len()))
                })
            && self.panels.len() == model.panels.len()
            && self
                .panels
                .iter()
                .zip(&model.panels)
                .all(|(wire, panel)| exact_state_equal(wire, &panel.to_js_value()))
            && self.axes.len() == model.axes.len()
            && self
                .axes
                .iter()
                .zip(&model.axes)
                .all(|(wire, axis)| exact_state_equal(wire, &axis.to_js_value()))
            && self.view.from.to_bits() == model.view.from.to_bits()
            && self.view.to.to_bits() == model.view.to.to_bits()
            && self.follow == model.follow
    }
}

/// 모든 validation/staging 뒤 source와 derived state를 한 commit 구간에 게시한다.
pub fn compact_data(
    owner: &mut IngestionOwner,
    engine: &mut IndicatorEngine,
    model: &mut ModelState,
    options: &JsValue,
    context: CompactionContext,
    mut owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
) -> Result<CompactionOutcome, CompactionError> {
    if let Some(guard) = owner_guard.as_mut() {
        (*guard)()?
    }
    let options = parse_options(options)?;
    let store = owner.data().store();
    if store.length() == 0 {
        return Err(range_error("Cannot compact an empty store").into());
    }
    let no_op = CompactionReceipt {
        removed: 0,
        length: store.length(),
        capacity: store.capacity(),
        bytes: store.bytes(),
        previous_bytes: store.bytes(),
        peak_source_bytes: store.bytes(),
        first_retained_time: store.columns().time[0],
        version: store.version(),
        time_version: store.time_version(),
        invalidation_failed: false,
    };
    if options.keep >= store.length() {
        return Ok(CompactionOutcome {
            receipt: no_op,
            change: None,
            clear_crosshair: false,
            request_invalidation: false,
        });
    }
    if !context.exclusive_owner {
        return Err(ordinary_error(
            "Compaction requires one exclusive live model and indicator engine",
        )
        .into());
    }
    owner
        .assert_compaction_idle_fence()
        .map_err(CompactionError::Ingestion)?;
    if context.drawing_transaction {
        return Err(ordinary_error("Compaction during drawing transaction").into());
    }
    if context.active_gesture {
        return Err(ordinary_error("Compaction during interaction gesture").into());
    }
    let removed = store.length() - options.keep;
    let model_plan = ModelPlan::capture(model, options.keep, removed)?;
    let ingestion_plan = owner.prepare_compaction(removed, options.pending)?;
    let restart = engine.prepare_restart();
    let store_candidate = owner
        .data()
        .store()
        .prepare_compaction(options.keep, options.max_peak)?;
    if let Some(guard) = owner_guard.as_mut() {
        (*guard)()?
    }
    if !model_plan.matches(model)
        || !engine.validate_restart(&restart)
        || !owner.validate_compaction(&ingestion_plan)
        || !owner.data().store().validate_compaction(&store_candidate)
    {
        return Err(stale_error().into());
    }
    engine
        .publish_restart(restart, options.keep)
        .expect("validated restart has no callback");
    model.publish_compaction_caches();
    let committed = owner
        .data_mut()
        .store_mut()
        .publish_compaction(store_candidate)
        .expect("validated store candidate has no callback");
    model.publish_compaction_view(model_plan.next_view);
    owner.publish_compaction_rebind(ingestion_plan);
    let change = committed.change.expect("compaction publishes one change");
    Ok(CompactionOutcome {
        receipt: CompactionReceipt::from_store(committed.value),
        change: Some(change),
        clear_crosshair: true,
        request_invalidation: true,
    })
}
