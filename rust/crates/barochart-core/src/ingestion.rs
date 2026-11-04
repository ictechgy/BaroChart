//! 모델 소유 sequenced OHLCV 수집 queue와 저장/복원 봉투다.
//!
//! 이 모듈에는 timer나 host callback이 없다. [`IngestionOwner`]는 store commit과 원장 commit을 끝낸 뒤
//! [`DataChange`]를 호출자에게 돌려주며, Engine 통합자는 그 다음에 listener를 발행한다.

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryFailure, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::batch_options::BatchOptions;
use crate::checkpoint_codec::{
    safe_checkpoint_parse_scoped, safe_checkpoint_stringify_scoped, safe_checkpoint_stringify_with,
};
use crate::contracts::identifier;
use crate::data::{
    Bar, BatchEvent, BatchReceipt, Committed, DataChange, DataIdentity, ModelDataState,
};

/// JS `Number.MAX_SAFE_INTEGER`다.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const INGESTION_BYTES: usize = 49;
const MAX_EVENTS: usize = 4_096;
const DEFAULT_STORE_BYTES: usize = 402_653_184;
const POLICY_KEYS: &[&str] = &[
    "streamId",
    "generation",
    "firstSequence",
    "maxQueuedEvents",
    "maxQueuedBytes",
    "maxBatchEvents",
    "maxStoredBars",
    "maxStoreBytes",
];
const COUNTER_KEYS: &[&str] = &[
    "accepted",
    "applied",
    "cancelled",
    "rejectedPackets",
    "rejectedEvents",
    "failedDrains",
    "peakPendingEvents",
    "peakPendingBytes",
    "lastAppliedSequence",
    "lastCancelledSequence",
];

/// 수집 queue의 안정 오류다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IngestionError {
    name: &'static str,
    code: String,
    message: JsString,
}

/// typed batch가 돌려주는 수집 오류 또는 store 원본 오류다.
#[derive(Debug)]
pub enum ApplyDataError {
    /// snapshot/stream/alignment 오류다.
    Ingestion(IngestionError),
    /// store 검증의 원래 TypeError/RangeError다.
    Store(JsError),
}

impl ApplyDataError {
    /// 오류 이름이다.
    pub fn name(&self) -> &str {
        match self {
            Self::Ingestion(error) => error.name(),
            Self::Store(error) => error.name,
        }
    }

    /// IngestionError일 때만 안정 code가 있다.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Ingestion(error) => Some(error.code()),
            Self::Store(_) => None,
        }
    }

    /// 오류 문구다.
    pub fn message(&self) -> &JsString {
        match self {
            Self::Ingestion(error) => error.message(),
            Self::Store(error) => &error.message,
        }
    }
}

impl IngestionError {
    fn new(code: &str, message: impl AsRef<str>) -> Self {
        Self {
            name: "IngestionError",
            code: code.to_owned(),
            message: JsString::from_str(message.as_ref()),
        }
    }

    fn with_message(code: &str, message: JsString) -> Self {
        Self {
            name: "IngestionError",
            code: code.to_owned(),
            message,
        }
    }

    fn from_js_error(error: JsError) -> Self {
        Self {
            name: error.name,
            code: error.code.unwrap_or_default(),
            message: bounded_message(&error.message),
        }
    }

    fn from_memory_failure(failure: MemoryFailure) -> Self {
        Self::from_js_error(failure.into_js_error())
    }

    /// JS 오류 이름이다. 일반 ingestion 오류는 `IngestionError`이고, resource OOM은
    /// backend에 맞는 `InternalError` 또는 `RangeError`를 유지한다.
    pub fn name(&self) -> &str {
        self.name
    }

    /// 안정 오류 코드다.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// UTF-16 오류 문구다.
    pub fn message(&self) -> &JsString {
        &self.message
    }

    /// JS 경계가 그대로 전달할 오류다. reserved OOM code도 보존한다.
    pub fn into_js_error(self) -> JsError {
        let mut error = JsError::new(self.name, self.message);
        if !self.code.is_empty() {
            error.code = Some(self.code);
        }
        error
    }
}

fn js_error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, JsString::from_str(message))
}

fn bounded_message(message: &JsString) -> JsString {
    message.slice(0, Some(256))
}

fn ingestion_from_js(code: &str, error: JsError) -> IngestionError {
    if error.code.as_deref().is_some_and(|code| {
        code == barochart_js::memory::OOM_LIMIT_CODE
            || code == barochart_js::memory::OOM_SYSTEM_CODE
    }) {
        IngestionError::from_js_error(error)
    } else {
        IngestionError::with_message(code, bounded_message(&error.message))
    }
}

fn key_is(key: &JsString, expected: &str) -> bool {
    key.as_units() == expected.encode_utf16().collect::<Vec<_>>()
}

fn string_is(value: &JsString, expected: &str) -> bool {
    key_is(value, expected)
}

fn record<'a>(
    value: &'a JsValue,
    keys: &[&str],
    label: &str,
    code: &str,
) -> Result<&'a JsObject, IngestionError> {
    let JsValue::Object(object) = value else {
        return Err(IngestionError::new(
            code,
            format!("{label} object required"),
        ));
    };
    for (key, _) in object.iter() {
        if !keys.iter().any(|expected| key_is(key, expected)) {
            return Err(IngestionError::new(
                code,
                format!("{label} unsupported field"),
            ));
        }
    }
    Ok(object)
}

fn property<'a>(object: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    object.get(&JsString::from_str(key))
}

fn nullish<'a>(value: Option<&'a JsValue>, fallback: &'a JsValue) -> &'a JsValue {
    match value {
        None | Some(JsValue::Null | JsValue::Undefined) => fallback,
        Some(value) => value,
    }
}

fn integer(value: &JsValue, from: f64, to: f64, label: &str) -> Result<f64, IngestionError> {
    let JsValue::Number(value) = value else {
        return Err(IngestionError::new(
            "INVALID_INPUT",
            format!("{label} integer range"),
        ));
    };
    if !value.is_finite() || value.fract() != 0.0 || *value < from || *value > to {
        return Err(IngestionError::new(
            "INVALID_INPUT",
            format!("{label} integer range"),
        ));
    }
    Ok(*value)
}

fn integer_document(
    value: &JsValue,
    from: f64,
    to: f64,
    label: &str,
) -> Result<f64, IngestionError> {
    integer(value, from, to, label)
        .map_err(|error| IngestionError::with_message("INVALID_INPUT", error.message))
}

fn value_number(value: f64) -> JsValue {
    JsValue::Number(value)
}

fn value_string(value: impl AsRef<str>) -> JsValue {
    JsValue::String(JsString::from_str(value.as_ref()))
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut value = JsObject::new();
    for (key, child) in entries {
        value.insert(JsString::from_str(key), child);
    }
    JsValue::Object(value)
}

/// 수집 정책이다. 필드 순서가 저장 문서 순서다.
#[derive(Clone, Debug, PartialEq)]
pub struct IngestionPolicy {
    /// stream 식별자다.
    pub stream_id: JsString,
    /// producer 세대다.
    pub generation: f64,
    /// 최초 sequence다.
    pub first_sequence: f64,
    /// queue event 한도다.
    pub max_queued_events: usize,
    /// queue 논리 바이트 한도다.
    pub max_queued_bytes: usize,
    /// drain event 한도다.
    pub max_batch_events: usize,
    /// store 행 한도다.
    pub max_stored_bars: usize,
    /// store capacity 논리 바이트 한도다.
    pub max_store_bytes: usize,
}

impl IngestionPolicy {
    fn to_value(&self) -> JsValue {
        object([
            ("streamId", JsValue::String(self.stream_id.clone())),
            ("generation", value_number(self.generation)),
            ("firstSequence", value_number(self.first_sequence)),
            (
                "maxQueuedEvents",
                value_number(self.max_queued_events as f64),
            ),
            ("maxQueuedBytes", value_number(self.max_queued_bytes as f64)),
            ("maxBatchEvents", value_number(self.max_batch_events as f64)),
            ("maxStoredBars", value_number(self.max_stored_bars as f64)),
            ("maxStoreBytes", value_number(self.max_store_bytes as f64)),
        ])
    }
}

fn parse_policy(
    data: &ModelDataState,
    input: &JsValue,
    allow_budget_mismatch: bool,
    store_max_bars: usize,
) -> Result<IngestionPolicy, IngestionError> {
    parse_policy_bounds(
        data.store().length(),
        data.store().bytes(),
        input,
        allow_budget_mismatch,
        store_max_bars,
    )
}

fn parse_policy_bounds(
    length: usize,
    bytes: usize,
    input: &JsValue,
    allow_budget_mismatch: bool,
    store_max_bars: usize,
) -> Result<IngestionPolicy, IngestionError> {
    let row = record(input, POLICY_KEYS, "Ingestion policy", "INVALID_INPUT")?;
    let undefined = JsValue::Undefined;
    let stream = property(row, "streamId").unwrap_or(&undefined);
    let stream_id = identifier(stream, "Stream id")
        .map_err(|error| ingestion_from_js("INVALID_INPUT", error))?
        .clone();
    let zero = JsValue::Number(0.0);
    let queued_events = JsValue::Number(4_096.0);
    let queued_bytes = JsValue::Number(262_144.0);
    let batch_events = JsValue::Number(128.0);
    let stored_bars = JsValue::Number(store_max_bars as f64);
    let store_bytes = JsValue::Number(DEFAULT_STORE_BYTES as f64);
    let generation = integer(
        property(row, "generation").unwrap_or(&JsValue::Undefined),
        0.0,
        MAX_SAFE_INTEGER,
        "generation",
    )?;
    let first_sequence = integer(
        nullish(property(row, "firstSequence"), &zero),
        0.0,
        MAX_SAFE_INTEGER,
        "firstSequence",
    )?;
    let max_queued_events = integer(
        nullish(property(row, "maxQueuedEvents"), &queued_events),
        1.0,
        4_096.0,
        "maxQueuedEvents",
    )? as usize;
    let max_queued_bytes = integer(
        nullish(property(row, "maxQueuedBytes"), &queued_bytes),
        49.0,
        16_777_216.0,
        "maxQueuedBytes",
    )? as usize;
    let max_batch_events = integer(
        nullish(property(row, "maxBatchEvents"), &batch_events),
        1.0,
        4_096.0,
        "maxBatchEvents",
    )? as usize;
    let max_stored_bars = integer(
        nullish(property(row, "maxStoredBars"), &stored_bars),
        0.0,
        store_max_bars as f64,
        "maxStoredBars",
    )? as usize;
    let max_store_bytes = integer(
        nullish(property(row, "maxStoreBytes"), &store_bytes),
        1_536.0,
        DEFAULT_STORE_BYTES as f64,
        "maxStoreBytes",
    )? as usize;
    if !allow_budget_mismatch && (length > max_stored_bars || bytes > max_store_bytes) {
        return Err(IngestionError::new(
            "STORE_BUDGET",
            "Current history exceeds ingestion admission budget",
        ));
    }
    Ok(IngestionPolicy {
        stream_id,
        generation,
        first_sequence,
        max_queued_events,
        max_queued_bytes,
        max_batch_events,
        max_stored_bars,
        max_store_bytes,
    })
}

/// queue가 소유하는 event 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IngestionKind {
    /// append다.
    Append,
    /// update다.
    Update,
    /// correction이다.
    Correction,
}

impl IngestionKind {
    fn text(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Update => "update",
            Self::Correction => "correction",
        }
    }

    fn index(self) -> u8 {
        match self {
            Self::Append => 0,
            Self::Update => 1,
            Self::Correction => 2,
        }
    }

    fn from_index(index: u8) -> Self {
        match index {
            0 => Self::Append,
            1 => Self::Update,
            _ => Self::Correction,
        }
    }
}

/// 소유 snapshot event다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IngestionEvent {
    /// event 종류다.
    pub kind: IngestionKind,
    /// 소유 OHLCV 값이다.
    pub bar: Bar,
}

fn parse_bar(value: &JsValue) -> Result<Bar, IngestionError> {
    let row = record(
        value,
        &["time", "open", "high", "low", "close", "volume"],
        "OHLCV",
        "INVALID_INPUT",
    )?;
    let number = |key: &str| match property(row, key) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(IngestionError::new(
            "INVALID_INPUT",
            "Every OHLCV field must be finite",
        )),
    };
    let bar = Bar {
        time: number("time")?,
        open: number("open")?,
        high: number("high")?,
        low: number("low")?,
        close: number("close")?,
        volume: number("volume")?,
    };
    crate::data::validate_bar(&bar, f64::NEG_INFINITY)
        .map_err(|error| ingestion_from_js("INVALID_INPUT", error))?;
    Ok(bar)
}

/// append/update/correction 배열을 getter 없는 소유 event로 snapshot한다.
pub fn snapshot_ingestion_events(input: &JsValue) -> Result<Vec<IngestionEvent>, IngestionError> {
    let memory = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
    snapshot_ingestion_events_with_memory(input, &memory).map(|(events, _)| events)
}

/// append/update/correction 배열을 fallible하게 소유 snapshot한다.
///
/// 반환된 [`MemoryGroup`]은 `events`가 실제로 소비되는 동안 함께 살아 있어야 한다.
pub fn snapshot_ingestion_events_with_memory(
    input: &JsValue,
    memory: &MemoryContext,
) -> Result<(Vec<IngestionEvent>, MemoryGroup), IngestionError> {
    let JsValue::Array(events) = input else {
        return Err(IngestionError::new(
            "INVALID_INPUT",
            "1–4096 ordered events required",
        ));
    };
    if events.is_empty() || events.len() > MAX_EVENTS {
        return Err(IngestionError::new(
            "INVALID_INPUT",
            "1–4096 ordered events required",
        ));
    }
    let (mut output, memory_group) = memory
        .try_vec_capacity(events.len())
        .map_err(IngestionError::from_memory_failure)?;
    for event in events {
        let row = record(event, &["kind", "bar"], "Event", "INVALID_INPUT")?;
        let kind = match property(row, "kind") {
            Some(JsValue::String(kind)) if string_is(kind, "append") => IngestionKind::Append,
            Some(JsValue::String(kind)) if string_is(kind, "update") => IngestionKind::Update,
            Some(JsValue::String(kind)) if string_is(kind, "correction") => {
                IngestionKind::Correction
            }
            _ => {
                return Err(IngestionError::new(
                    "INVALID_INPUT",
                    "Ordered append/update/correction required",
                ));
            }
        };
        let bar = parse_bar(property(row, "bar").unwrap_or(&JsValue::Undefined))?;
        output.push(IngestionEvent { kind, bar });
    }
    Ok((output, memory_group))
}

fn event_value(event: IngestionEvent) -> JsValue {
    object([
        ("kind", value_string(event.kind.text())),
        (
            "bar",
            object([
                ("time", value_number(event.bar.time)),
                ("open", value_number(event.bar.open)),
                ("high", value_number(event.bar.high)),
                ("low", value_number(event.bar.low)),
                ("close", value_number(event.bar.close)),
                ("volume", value_number(event.bar.volume)),
            ]),
        ),
    ])
}

fn batch_event(event: IngestionEvent) -> BatchEvent {
    match event.kind {
        IngestionKind::Append => BatchEvent::Append(event.bar),
        IngestionKind::Update => BatchEvent::Update(event.bar),
        IngestionKind::Correction => BatchEvent::Correction(event.bar),
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Counters {
    accepted: f64,
    applied: f64,
    cancelled: f64,
    rejected_packets: f64,
    rejected_events: f64,
    failed_drains: f64,
    peak_pending_events: f64,
    peak_pending_bytes: f64,
    last_applied_sequence: Option<f64>,
    last_cancelled_sequence: Option<f64>,
    order: Vec<&'static str>,
}

impl Default for Counters {
    fn default() -> Self {
        Self {
            accepted: 0.0,
            applied: 0.0,
            cancelled: 0.0,
            rejected_packets: 0.0,
            rejected_events: 0.0,
            failed_drains: 0.0,
            peak_pending_events: 0.0,
            peak_pending_bytes: 0.0,
            last_applied_sequence: None,
            last_cancelled_sequence: None,
            order: COUNTER_KEYS.to_vec(),
        }
    }
}

impl Counters {
    fn number(&self, key: &str) -> JsValue {
        match key {
            "accepted" => value_number(self.accepted),
            "applied" => value_number(self.applied),
            "cancelled" => value_number(self.cancelled),
            "rejectedPackets" => value_number(self.rejected_packets),
            "rejectedEvents" => value_number(self.rejected_events),
            "failedDrains" => value_number(self.failed_drains),
            "peakPendingEvents" => value_number(self.peak_pending_events),
            "peakPendingBytes" => value_number(self.peak_pending_bytes),
            "lastAppliedSequence" => self
                .last_applied_sequence
                .map_or(JsValue::Null, value_number),
            "lastCancelledSequence" => self
                .last_cancelled_sequence
                .map_or(JsValue::Null, value_number),
            _ => unreachable!("counter key"),
        }
    }

    fn to_value(&self) -> JsValue {
        let mut object = JsObject::new();
        for key in &self.order {
            object.insert(JsString::from_str(key), self.number(key));
        }
        JsValue::Object(object)
    }
}

#[derive(Clone, Debug, PartialEq)]
struct LastError {
    code: JsString,
    message: JsString,
    message_first: bool,
}

impl LastError {
    fn source_changed() -> Self {
        Self {
            code: JsString::from_str("SOURCE_CHANGED"),
            message: JsString::from_str(
                "Source changed outside ingestion while payload is pending",
            ),
            message_first: false,
        }
    }

    fn to_value(&self) -> JsValue {
        let pairs = if self.message_first {
            [
                ("message", JsValue::String(self.message.clone())),
                ("code", JsValue::String(self.code.clone())),
            ]
        } else {
            [
                ("code", JsValue::String(self.code.clone())),
                ("message", JsValue::String(self.message.clone())),
            ]
        };
        object(pairs)
    }
}

struct EventRing {
    time: Vec<f64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
    kinds: Vec<u8>,
    /// 여섯 f64 열과 kind 열의 실제 capacity를 한 번에 소유하는 회계 묶음이다.
    /// 선언 순서를 payload 뒤로 둬 drop 때 Vec가 먼저 해제되게 한다.
    #[allow(dead_code)]
    memory: MemoryGroup,
}

impl EventRing {
    fn new(capacity: usize, memory: &MemoryContext) -> Result<Self, MemoryFailure> {
        let (time, mut group) = memory.try_vec_filled(capacity, 0.0_f64)?;
        let (open, open_group) = memory.try_vec_filled(capacity, 0.0_f64)?;
        group.absorb(open_group)?;
        let (high, high_group) = memory.try_vec_filled(capacity, 0.0_f64)?;
        group.absorb(high_group)?;
        let (low, low_group) = memory.try_vec_filled(capacity, 0.0_f64)?;
        group.absorb(low_group)?;
        let (close, close_group) = memory.try_vec_filled(capacity, 0.0_f64)?;
        group.absorb(close_group)?;
        let (volume, volume_group) = memory.try_vec_filled(capacity, 0.0_f64)?;
        group.absorb(volume_group)?;
        let (kinds, kinds_group) = memory.try_vec_filled(capacity, 0_u8)?;
        group.absorb(kinds_group)?;
        Ok(Self {
            time,
            open,
            high,
            low,
            close,
            volume,
            kinds,
            memory: group,
        })
    }

    fn write(&mut self, index: usize, event: IngestionEvent) {
        self.time[index] = event.bar.time;
        self.open[index] = event.bar.open;
        self.high[index] = event.bar.high;
        self.low[index] = event.bar.low;
        self.close[index] = event.bar.close;
        self.volume[index] = event.bar.volume;
        self.kinds[index] = event.kind.index();
    }

    fn read(&self, index: usize) -> IngestionEvent {
        IngestionEvent {
            kind: IngestionKind::from_index(self.kinds[index]),
            bar: Bar {
                time: self.time[index],
                open: self.open[index],
                high: self.high[index],
                low: self.low[index],
                close: self.close[index],
                volume: self.volume[index],
            },
        }
    }
}

struct IngestionSession {
    policy: IngestionPolicy,
    source_serial: f64,
    source_version: f64,
    ring: Option<EventRing>,
    capacity: usize,
    head: usize,
    count: usize,
    next_sequence: f64,
    first_pending_sequence: f64,
    paused: bool,
    draining: bool,
    leased: bool,
    closed: bool,
    last_error: Option<LastError>,
    epoch: f64,
    counters: Counters,
    lease_serial: u64,
    active_lease: Option<u64>,
}

impl IngestionSession {
    fn new(data: &ModelDataState, policy: IngestionPolicy) -> Result<Self, IngestionError> {
        Self::new_with_source(
            data.store().serial(),
            data.store().version(),
            policy,
            data.store().memory_context(),
        )
    }

    fn new_with_source(
        serial: f64,
        version: f64,
        policy: IngestionPolicy,
        memory: &MemoryContext,
    ) -> Result<Self, IngestionError> {
        let capacity = std::cmp::min(
            policy.max_queued_events,
            policy.max_queued_bytes / INGESTION_BYTES,
        );
        let ring = EventRing::new(capacity, memory).map_err(IngestionError::from_memory_failure)?;
        Ok(Self {
            source_serial: serial,
            source_version: version,
            ring: Some(ring),
            capacity,
            head: 0,
            count: 0,
            next_sequence: policy.first_sequence,
            first_pending_sequence: policy.first_sequence,
            paused: false,
            draining: false,
            leased: false,
            closed: false,
            last_error: None,
            epoch: 0.0,
            counters: Counters::default(),
            lease_serial: 0,
            active_lease: None,
            policy,
        })
    }

    fn active(&self) -> Result<(), IngestionError> {
        if self.closed {
            Err(IngestionError::new(
                "CLOSED",
                "Ingestion session closed or replaced",
            ))
        } else {
            Ok(())
        }
    }

    fn idle(&self) -> Result<(), IngestionError> {
        self.active()?;
        if self.leased || self.draining {
            return Err(IngestionError::new(
                "BUSY",
                "Ingestion has an active async lease or drain",
            ));
        }
        Ok(())
    }

    fn changed(&self, data: &ModelDataState) -> bool {
        self.count > 0
            && (self.source_serial != data.store().serial()
                || self.source_version != data.store().version())
    }

    fn source(&mut self, data: &ModelDataState) -> Result<(), IngestionError> {
        self.active()?;
        if self.source_serial != data.store().serial()
            || self.source_version != data.store().version()
        {
            if self.count > 0 {
                self.paused = true;
                self.last_error = Some(LastError::source_changed());
                return Err(IngestionError::new(
                    "SOURCE_CHANGED",
                    "Source changed outside ingestion while payload is pending",
                ));
            }
            self.source_serial = data.store().serial();
            self.source_version = data.store().version();
        }
        Ok(())
    }

    fn prefix_with_memory(
        &self,
        count: usize,
        memory: &MemoryContext,
    ) -> Result<(Vec<IngestionEvent>, MemoryGroup), MemoryFailure> {
        let ring = self.ring.as_ref().expect("open session owns ring");
        let (mut events, group) = memory.try_vec_capacity(count)?;
        for offset in 0..count {
            events.push(ring.read((self.head + offset) % self.capacity));
        }
        Ok((events, group))
    }

    fn reject(&mut self, error: IngestionError, events: usize) -> IngestionError {
        if !self.closed {
            if self.counters.rejected_packets < MAX_SAFE_INTEGER {
                self.counters.rejected_packets += 1.0;
            }
            let rejected = self.counters.rejected_events + events as f64;
            self.counters.rejected_events = if rejected < MAX_SAFE_INTEGER {
                rejected
            } else {
                MAX_SAFE_INTEGER
            };
        }
        error
    }

    fn source_status(&self, data: &ModelDataState) -> (bool, Option<LastError>) {
        if self.changed(data) {
            (true, Some(LastError::source_changed()))
        } else {
            (self.paused, self.last_error.clone())
        }
    }

    fn dispose(&mut self) -> usize {
        if self.closed {
            return 0;
        }
        let cancelled = self.count;
        self.counters.cancelled += cancelled as f64;
        if cancelled > 0 {
            self.counters.last_cancelled_sequence =
                Some(self.first_pending_sequence + cancelled as f64 - 1.0);
        }
        self.count = 0;
        self.head = 0;
        self.first_pending_sequence = self.next_sequence;
        self.closed = true;
        self.leased = false;
        self.active_lease = None;
        self.ring = None;
        cancelled
    }
}

/// enqueue 영수증이다.
#[derive(Clone, Debug, PartialEq)]
pub struct EnqueueReceipt {
    /// event 수다.
    pub events: usize,
    /// packet 첫 sequence다.
    pub first_sequence: f64,
    /// 다음 sequence다.
    pub next_sequence: f64,
    /// queue event 수다.
    pub pending_events: usize,
    /// queue 논리 바이트다.
    pub pending_bytes: usize,
}

impl EnqueueReceipt {
    fn to_value(&self) -> JsValue {
        object([
            ("events", value_number(self.events as f64)),
            ("firstSequence", value_number(self.first_sequence)),
            ("nextSequence", value_number(self.next_sequence)),
            ("pendingEvents", value_number(self.pending_events as f64)),
            ("pendingBytes", value_number(self.pending_bytes as f64)),
        ])
    }
}

/// cancel 영수증이다.
#[derive(Clone, Debug, PartialEq)]
pub struct CancelReceipt {
    /// 취소 event 수다.
    pub events: usize,
    /// 첫 sequence다.
    pub first_sequence: Option<f64>,
    /// 마지막 sequence다.
    pub last_sequence: Option<f64>,
}

impl CancelReceipt {
    /// 네이티브 봉투와 generic command가 공유하는 source 순서의 영수증이다.
    pub fn to_value(&self) -> JsValue {
        object([
            ("events", value_number(self.events as f64)),
            (
                "firstSequence",
                self.first_sequence.map_or(JsValue::Null, value_number),
            ),
            (
                "lastSequence",
                self.last_sequence.map_or(JsValue::Null, value_number),
            ),
        ])
    }
}

/// drain 영수증과 publication 정보다.
#[derive(Clone, Debug, PartialEq)]
pub struct DrainReceipt {
    /// store batch 영수증이다.
    pub receipt: BatchReceipt,
    /// packet 첫 sequence다.
    pub first_sequence: Option<f64>,
    /// packet 마지막 sequence다.
    pub last_sequence: Option<f64>,
    /// ledger 뒤 발행할 store 변경이다.
    pub change: Option<DataChange>,
}

impl DrainReceipt {
    /// 네이티브 봉투와 generic command가 공유하는 source 순서의 영수증이다.
    pub fn to_value(&self) -> JsValue {
        let receipt = &self.receipt;
        object([
            ("events", value_number(receipt.events as f64)),
            ("appended", value_number(receipt.appended as f64)),
            ("from", value_number(receipt.from as f64)),
            ("to", value_number(receipt.to as f64)),
            ("version", value_number(receipt.version)),
            ("length", value_number(receipt.length as f64)),
            ("capacity", value_number(receipt.capacity as f64)),
            ("bytes", value_number(receipt.bytes as f64)),
            (
                "firstSequence",
                self.first_sequence.map_or(JsValue::Null, value_number),
            ),
            (
                "lastSequence",
                self.last_sequence.map_or(JsValue::Null, value_number),
            ),
        ])
    }
}

/// close 정리 영수증이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseReceipt {
    /// 취소한 event 수다.
    pub cancelled: usize,
}

/// Compaction pending queue 정책이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingDataPolicy {
    /// pending queue가 있으면 거부한다.
    Reject,
    /// 남은 timestamp를 참조하는 pending FIFO를 보존한다.
    PreserveRetained,
}

/// Compaction의 fence BUSY와 source의 일반 오류 class를 구분한다.
#[derive(Debug)]
pub enum IngestionCompactionError {
    /// async ingestion fence의 안정 BUSY 오류다.
    Busy(IngestionError),
    /// compaction source가 정한 일반 JS 오류 class다.
    State(JsError),
}

impl IngestionCompactionError {
    /// JS 오류 이름이다.
    pub fn name(&self) -> &str {
        match self {
            Self::Busy(error) => error.name(),
            Self::State(error) => error.name,
        }
    }
    /// IngestionError일 때만 안정 code가 있다.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Busy(error) => Some(error.code()),
            Self::State(_) => None,
        }
    }
    /// UTF-16 오류 문구다.
    pub fn message(&self) -> &JsString {
        match self {
            Self::Busy(error) => error.message(),
            Self::State(error) => &error.message,
        }
    }
}

/// Ingestion session/queue가 compaction 전 그대로인지 확인하는 plan이다.
pub struct IngestionCompactionPlan {
    session: bool,
    source_serial: f64,
    source_version: f64,
    epoch: f64,
    head: usize,
    count: usize,
    next_sequence: f64,
    first_pending_sequence: f64,
    paused: bool,
    draining: bool,
    leased: bool,
    closed: bool,
    events: Vec<IngestionEvent>,
    /// plan이 events를 보유하는 동안 유지하는 실제 scratch reservation이다.
    #[allow(dead_code)]
    events_memory: MemoryGroup,
    document: Option<JsString>,
}

impl ReleaseReceipt {
    /// native release 반환값이다.
    pub fn to_value(self) -> JsValue {
        object([
            ("cancelled", value_number(self.cancelled as f64)),
            ("pendingEvents", value_number(0.0)),
            ("ownedBytes", value_number(0.0)),
        ])
    }
}

/// Workspace metadata에 이미 검증된 store의 입장 조건이다. 실제 OHLCV를 만들지 않는다.
#[derive(Clone, Copy)]
pub struct IngestionStoreShape {
    /// 논리 행 수다.
    pub length: usize,
    /// 현재 power-of-two capacity다.
    pub capacity: usize,
    /// store의 행 한도다.
    pub max_bars: usize,
    /// 대상 store version이다.
    pub version: f64,
}

/// Source parser로 검증·정규화한 pending 없는 수집 문서다.
pub struct ValidatedWorkspaceIngestion {
    /// 동일 키 순서의 canonical 문서다.
    pub text: JsString,
    /// 여섯 열과 kind 배열의 ring capacity다.
    pub capacity: usize,
}

/// 검증된 async lease 동안만 빌리는 수집 ring의 실제 allocation slice다.
pub struct AsyncIngestionBufferView<'a> {
    /// time/open/high/low/close/volume 순서의 전체 capacity 열이다.
    pub columns: [&'a [f64]; 6],
    /// 전체 capacity의 event kind 배열이다.
    pub kinds: &'a [u8],
}

/// 한 model의 optional session lease와 필수 async fence를 함께 해제하는 token이다.
pub struct AsyncIngestionLease {
    owner: DataIdentity,
    session: Option<u64>,
    epoch: Option<u64>,
    released: bool,
}

/// 모델 data와 attached ingestion session의 leaf 소유자다.
pub struct IngestionOwner {
    data: ModelDataState,
    session: Option<IngestionSession>,
    fences: usize,
    disposed: bool,
    dialect: NumberDialect,
}

impl IngestionOwner {
    /// data owner를 만든다. session은 아직 구성되지 않았다.
    pub fn new(data: ModelDataState, dialect: NumberDialect) -> Self {
        Self {
            data,
            session: None,
            fences: 0,
            disposed: false,
            dialect,
        }
    }

    /// data를 읽는다.
    pub fn data(&self) -> &ModelDataState {
        &self.data
    }

    /// ingestion 밖 publication을 위해 data를 배타적으로 빌린다.
    pub fn data_mut(&mut self) -> &mut ModelDataState {
        &mut self.data
    }

    /// Compaction 전에 fence/session/pending FIFO 의미를 검사하고 snapshot한다.
    pub fn assert_compaction_idle_fence(&self) -> Result<(), IngestionError> {
        self.idle_fence()
    }

    /// Compaction 전에 session/pending FIFO 의미를 검사하고 snapshot한다.
    pub fn prepare_compaction(
        &self,
        removed: usize,
        policy: PendingDataPolicy,
    ) -> Result<IngestionCompactionPlan, IngestionCompactionError> {
        let Some(session) = self.session.as_ref() else {
            return Ok(IngestionCompactionPlan {
                session: false,
                source_serial: self.data.store().serial(),
                source_version: self.data.store().version(),
                epoch: 0.0,
                head: 0,
                count: 0,
                next_sequence: 0.0,
                first_pending_sequence: 0.0,
                paused: false,
                draining: false,
                leased: false,
                closed: false,
                events: Vec::new(),
                events_memory: MemoryGroup::empty(MemoryContext::unaccounted(
                    OomStyle::RangeErrorCapitalized,
                )),
                document: None,
            });
        };
        if session.closed
            || !session.paused
            || session.count > 0 && policy != PendingDataPolicy::PreserveRetained
            || session.draining
            || session.leased
        {
            return Err(IngestionCompactionError::State(js_error(
                "Error",
                "Compaction requires paused empty idle ingestion unless preserving retained pending data",
            )));
        }
        if policy == PendingDataPolicy::PreserveRetained
            && session.source_version != self.data.store().version()
        {
            return Err(IngestionCompactionError::State(js_error(
                "Error",
                "Compaction pending source version changed",
            )));
        }
        let memory = self.data.store().memory_context().clone();
        let (events, events_memory) = session
            .prefix_with_memory(session.count, &memory)
            .map_err(|failure| IngestionCompactionError::State(failure.into_js_error()))?;
        if policy == PendingDataPolicy::PreserveRetained {
            let store = self.data.store();
            let mut tail = store.columns().time[store.length() - 1];
            let (mut appended, appended_memory) = memory
                .try_vec_capacity(events.len())
                .map_err(|failure| IngestionCompactionError::State(failure.into_js_error()))?;
            for event in &events {
                crate::data::validate_bar(&event.bar, f64::NEG_INFINITY)
                    .map_err(IngestionCompactionError::State)?;
                match event.kind {
                    IngestionKind::Append => {
                        if event.bar.time <= tail {
                            return Err(IngestionCompactionError::State(js_error(
                                "Error",
                                "Compaction pending append must follow virtual tail",
                            )));
                        }
                        tail = event.bar.time;
                        appended.push(event.bar.time);
                    }
                    IngestionKind::Update => {
                        if event.bar.time != tail {
                            return Err(IngestionCompactionError::State(js_error(
                                "Error",
                                "Compaction pending update must match virtual tail",
                            )));
                        }
                    }
                    IngestionKind::Correction => {
                        let retained = store.columns().time[removed..store.length()]
                            .binary_search_by(|value| value.total_cmp(&event.bar.time))
                            .is_ok();
                        if !retained && !appended.contains(&event.bar.time) {
                            return Err(IngestionCompactionError::State(js_error(
                                "Error",
                                "Compaction pending correction requires retained timestamp",
                            )));
                        }
                    }
                }
            }
            drop(appended);
            drop(appended_memory);
        }
        Ok(IngestionCompactionPlan {
            session: true,
            source_serial: session.source_serial,
            source_version: session.source_version,
            epoch: session.epoch,
            head: session.head,
            count: session.count,
            next_sequence: session.next_sequence,
            first_pending_sequence: session.first_pending_sequence,
            paused: session.paused,
            draining: session.draining,
            leased: session.leased,
            closed: session.closed,
            events,
            events_memory,
            document: Some(self.save().map_err(IngestionCompactionError::Busy)?),
        })
    }

    /// Store commit 직전 ingestion snapshot이 그대로인지 확인한다.
    pub fn validate_compaction(&self, plan: &IngestionCompactionPlan) -> bool {
        match (plan.session, self.session.as_ref()) {
            (false, None) => true,
            (true, Some(session)) => {
                session.source_serial == plan.source_serial
                    && session.source_version == plan.source_version
                    && session.epoch == plan.epoch
                    && session.head == plan.head
                    && session.count == plan.count
                    && session.next_sequence == plan.next_sequence
                    && session.first_pending_sequence == plan.first_pending_sequence
                    && session.paused == plan.paused
                    && session.draining == plan.draining
                    && session.leased == plan.leased
                    && session.closed == plan.closed
                    && session
                        .prefix_with_memory(session.count, self.data.store().memory_context())
                        .ok()
                        .is_some_and(|(events, scratch)| {
                            let matches = events == plan.events;
                            drop(events);
                            drop(scratch);
                            matches
                        })
                    && self.save().ok().as_ref() == plan.document.as_ref()
            }
            _ => false,
        }
    }

    /// 검증된 session의 queue/counters를 그대로 두고 새 store 원장에 재결합한다.
    pub fn publish_compaction_rebind(&mut self, plan: IngestionCompactionPlan) {
        if !plan.session {
            return;
        }
        let serial = self.data.store().serial();
        let version = self.data.store().version();
        let session = self.session.as_mut().expect("validated compaction session");
        session.source_serial = serial;
        session.source_version = version;
        session.epoch = plan.epoch + 1.0;
    }

    fn configured(&self) -> Result<&IngestionSession, IngestionError> {
        self.session
            .as_ref()
            .ok_or_else(|| IngestionError::new("NOT_CONFIGURED", "Configure data ingestion first"))
    }

    fn configured_mut(&mut self) -> Result<&mut IngestionSession, IngestionError> {
        self.session
            .as_mut()
            .ok_or_else(|| IngestionError::new("NOT_CONFIGURED", "Configure data ingestion first"))
    }

    fn active_owner(&self) -> Result<(), IngestionError> {
        if self.disposed {
            Err(IngestionError::new("CLOSED", "Chart disposed"))
        } else {
            Ok(())
        }
    }

    fn idle_fence(&self) -> Result<(), IngestionError> {
        if self.fences > 0 {
            Err(IngestionError::new(
                "BUSY",
                "Model has an active async ingestion fence",
            ))
        } else {
            Ok(())
        }
    }

    /// Session이 없어도 model fence를 얻고, 있으면 동일 호출에서 session lease도 얻는다.
    pub fn acquire_async_lease(&mut self) -> Result<AsyncIngestionLease, IngestionError> {
        self.active_owner()?;
        let session = if self.session.is_some() {
            Some(self.acquire_lease()?)
        } else {
            None
        };
        self.acquire_fence();
        Ok(AsyncIngestionLease {
            owner: self.data.store().data_identity(),
            session,
            epoch: self.session.as_ref().map(|session| session.epoch.to_bits()),
            released: false,
        })
    }

    /// Params admission이 lease를 유지한 현재 ring bytes를 복제 없이 센다.
    pub fn async_buffer_view(
        &self,
        lease: &AsyncIngestionLease,
    ) -> Option<AsyncIngestionBufferView<'_>> {
        if !self.validate_async_lease(lease) {
            return None;
        }
        let ring = self.session.as_ref()?.ring.as_ref()?;
        Some(AsyncIngestionBufferView {
            columns: [
                &ring.time,
                &ring.open,
                &ring.high,
                &ring.low,
                &ring.close,
                &ring.volume,
            ],
            kinds: &ring.kinds,
        })
    }

    /// Source capture가 session lease/fence의 교체·해제·dispose를 관찰한다.
    /// Store columns/version 교체는 별도 data capture token이 검사한다.
    pub fn validate_async_lease(&self, lease: &AsyncIngestionLease) -> bool {
        if lease.released
            || self.disposed
            || self.fences == 0
            || !lease.owner.same_store(&self.data.store().data_identity())
        {
            return false;
        }
        match (lease.session, self.session.as_ref()) {
            (None, None) => true,
            (Some(token), Some(session)) => {
                session.active_lease == Some(token)
                    && session.leased
                    && !session.closed
                    && lease.epoch == Some(session.epoch.to_bits())
            }
            _ => false,
        }
    }

    /// Dispose 뒤에도 같은 model의 fence를 한 번만 해제한다. 다른 owner token은 소비하지 않는다.
    pub fn release_async_lease(&mut self, lease: &mut AsyncIngestionLease) -> bool {
        if lease.released || !lease.owner.same_store(&self.data.store().data_identity()) {
            return false;
        }
        if let (Some(token), Some(session)) = (lease.session, self.session.as_mut())
            && session.active_lease == Some(token)
        {
            session.active_lease = None;
            session.leased = false;
            session.epoch += 1.0;
        }
        self.release_fence();
        lease.released = true;
        true
    }

    /// async/prepare/workspace fence를 얻는다.
    pub fn acquire_fence(&mut self) {
        self.fences = self.fences.saturating_add(1);
    }

    /// fence 하나를 해제한다.
    pub fn release_fence(&mut self) {
        self.fences = self.fences.saturating_sub(1);
    }

    /// 정책을 검증해 새 session을 원자적으로 설치한다.
    pub fn configure(&mut self, input: &JsValue) -> Result<JsValue, IngestionError> {
        self.active_owner()?;
        self.idle_fence()?;
        if let Some(old) = self.session.as_ref() {
            old.idle()?;
            if old.count > 0 {
                return Err(IngestionError::new(
                    "PENDING_DATA",
                    "Drain or cancel pending data before reconfiguration",
                ));
            }
        }
        let store_max_bars = self.data.store().max_bars();
        let policy = parse_policy(&self.data, input, false, store_max_bars)?;
        let candidate = IngestionSession::new(&self.data, policy)?;
        self.session = Some(candidate);
        self.stats()
    }

    /// packet을 소유 queue에 복사한다.
    pub fn enqueue(&mut self, packet: &JsValue) -> Result<JsValue, IngestionError> {
        self.active_owner()?;
        let mut snapshotted = 0usize;
        let result = (|| {
            {
                let session = self.configured_mut()?;
                session.active()?;
                if session.leased {
                    return Err(IngestionError::new("BUSY", "Async ingestion lease active"));
                }
                if session.paused {
                    return Err(IngestionError::new("PAUSED", "Ingestion paused"));
                }
            }
            {
                let (session, data) = (self.session.as_mut().unwrap(), &self.data);
                session.source(data)?;
            }
            let row = record(
                packet,
                &["streamId", "generation", "firstSequence", "events"],
                "Packet",
                "INVALID_INPUT",
            )?;
            let memory = self.data.store().memory_context().clone();
            let (events, events_memory) = snapshot_ingestion_events_with_memory(
                property(row, "events").unwrap_or(&JsValue::Undefined),
                &memory,
            )?;
            snapshotted = events.len();
            let session = self.session.as_mut().unwrap();
            session.active()?;
            if session.leased {
                return Err(IngestionError::new("BUSY", "Async ingestion lease active"));
            }
            if session.paused {
                return Err(IngestionError::new("PAUSED", "Ingestion paused"));
            }
            session.source(&self.data)?;
            let stream_matches = matches!(property(row, "streamId"), Some(JsValue::String(value)) if value == &session.policy.stream_id);
            let generation_matches = matches!(property(row, "generation"), Some(JsValue::Number(value)) if *value == session.policy.generation);
            if !stream_matches || !generation_matches {
                return Err(IngestionError::new(
                    "STREAM_MISMATCH",
                    "Packet stream/generation mismatch",
                ));
            }
            let first_sequence = integer(
                property(row, "firstSequence").unwrap_or(&JsValue::Undefined),
                0.0,
                MAX_SAFE_INTEGER,
                "firstSequence",
            )?;
            if first_sequence != session.next_sequence {
                return Err(IngestionError::new(
                    "SEQUENCE_MISMATCH",
                    "Packet firstSequence must equal nextSequence",
                ));
            }
            if events.len() > session.capacity - session.count {
                return Err(IngestionError::new(
                    "QUEUE_BUDGET",
                    "Packet exceeds queued event/typed-byte budget",
                ));
            }
            if session.next_sequence > MAX_SAFE_INTEGER - events.len() as f64
                || session.counters.accepted > MAX_SAFE_INTEGER - events.len() as f64
            {
                return Err(IngestionError::new(
                    "SEQUENCE_LIMIT",
                    "Sequence/counter limit",
                ));
            }
            let first = session.next_sequence;
            let ring = session.ring.as_mut().expect("open session owns ring");
            for (offset, event) in events.iter().enumerate() {
                ring.write(
                    (session.head + session.count + offset) % session.capacity,
                    *event,
                );
            }
            let event_count = events.len();
            drop(events);
            drop(events_memory);
            if session.count == 0 {
                session.first_pending_sequence = first;
            }
            session.count += event_count;
            session.next_sequence += event_count as f64;
            session.counters.accepted += event_count as f64;
            session.epoch += 1.0;
            if session.count as f64 > session.counters.peak_pending_events {
                session.counters.peak_pending_events = session.count as f64;
            }
            session.counters.peak_pending_bytes =
                session.counters.peak_pending_events * INGESTION_BYTES as f64;
            Ok(EnqueueReceipt {
                events: event_count,
                first_sequence: first,
                next_sequence: session.next_sequence,
                pending_events: session.count,
                pending_bytes: session.count * INGESTION_BYTES,
            }
            .to_value())
        })();
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let Some(session) = self.session.as_mut()
                    && error.code != "CLOSED"
                {
                    return Err(session.reject(error, snapshotted));
                }
                Err(error)
            }
        }
    }

    /// queue 앞부분을 store에 원자적으로 적용하고 ledger를 커밋한다.
    pub fn drain(
        &mut self,
        max_events: Option<&JsValue>,
        external_values: bool,
    ) -> Result<DrainReceipt, IngestionError> {
        self.active_owner()?;
        {
            let session = self.configured()?;
            session.idle()?;
            if session.paused {
                return Err(IngestionError::new("PAUSED", "Ingestion paused"));
            }
        }
        {
            let (session, data) = (self.session.as_mut().unwrap(), &self.data);
            session.source(data)?;
        }
        let maximum = self.session.as_ref().unwrap().policy.max_batch_events;
        let requested = match max_events {
            None | Some(JsValue::Undefined) => maximum,
            Some(value) => integer(value, 1.0, maximum as f64, "Drain count")? as usize,
        };
        let session = self.session.as_mut().unwrap();
        if session.count == 0 {
            let store = self.data.store();
            return Ok(DrainReceipt {
                receipt: BatchReceipt {
                    events: 0,
                    appended: 0,
                    from: store.length(),
                    to: store.length(),
                    version: store.version(),
                    length: store.length(),
                    capacity: store.capacity(),
                    bytes: store.bytes(),
                    unchanged: None,
                },
                first_sequence: None,
                last_sequence: None,
                change: None,
            });
        }
        let count = std::cmp::min(requested, session.count);
        let memory = self.data.store().memory_context().clone();
        let (events, events_memory) = session
            .prefix_with_memory(count, &memory)
            .map_err(IngestionError::from_memory_failure)?;
        let first_sequence = session.first_pending_sequence;
        session.draining = true;
        let result = if external_values
            && events
                .iter()
                .any(|event| event.kind == IngestionKind::Append)
        {
            Err(IngestionError::new(
                "EXTERNAL_ALIGNMENT",
                "Length-changing ingestion requires host realignment of external values",
            ))
        } else {
            let options = BatchOptions::from_scalar_values(
                Some(value_number(session.policy.max_stored_bars as f64)),
                Some(value_number(session.policy.max_store_bytes as f64)),
                None,
            );
            match memory.try_vec_capacity(events.len()) {
                Err(error) => Err(IngestionError::from_memory_failure(error)),
                Ok((mut batch, batch_memory)) => {
                    for event in &events {
                        batch.push(batch_event(*event));
                    }
                    let result = self
                        .data
                        .store_mut()
                        .apply_events(&batch, &options)
                        .map_err(|error| ingestion_from_js("DRAIN_FAILED", error));
                    drop(batch);
                    drop(batch_memory);
                    result
                }
            }
        };
        drop(events);
        drop(events_memory);
        let session = self.session.as_mut().unwrap();
        session.draining = false;
        match result {
            Ok(Committed { value, change }) => {
                session.head = (session.head + count) % session.capacity;
                session.count -= count;
                session.first_pending_sequence += count as f64;
                session.counters.applied += count as f64;
                session.counters.last_applied_sequence = Some(first_sequence + count as f64 - 1.0);
                session.source_version = self.data.store().version();
                session.source_serial = self.data.store().serial();
                session.epoch += 1.0;
                Ok(DrainReceipt {
                    receipt: value,
                    first_sequence: Some(first_sequence),
                    last_sequence: Some(first_sequence + count as f64 - 1.0),
                    change,
                })
            }
            Err(error) => {
                if session.counters.failed_drains < MAX_SAFE_INTEGER {
                    session.counters.failed_drains += 1.0;
                }
                session.paused = true;
                session.last_error = Some(LastError {
                    code: JsString::from_str("DRAIN_FAILED"),
                    message: bounded_message(error.message()),
                    message_first: false,
                });
                if error.name() == "IngestionError" {
                    Err(IngestionError::with_message(
                        "DRAIN_FAILED",
                        bounded_message(error.message()),
                    ))
                } else {
                    Err(error)
                }
            }
        }
    }

    /// session을 일시정지한다. 반복 호출도 epoch를 올린다.
    pub fn pause(&mut self) -> Result<JsValue, IngestionError> {
        self.active_owner()?;
        let session = self.configured_mut()?;
        session.active()?;
        if session.leased {
            return Err(IngestionError::new("BUSY", "Async ingestion lease active"));
        }
        session.paused = true;
        session.epoch += 1.0;
        self.stats()
    }

    /// 외부 store 변경을 승인하고 session을 재개한다.
    pub fn resume(&mut self) -> Result<JsValue, IngestionError> {
        self.active_owner()?;
        let store_serial = self.data.store().serial();
        let store_version = self.data.store().version();
        let session = self.configured_mut()?;
        session.active()?;
        if session.leased {
            return Err(IngestionError::new("BUSY", "Async ingestion lease active"));
        }
        session.source_serial = store_serial;
        session.source_version = store_version;
        session.paused = false;
        session.last_error = None;
        session.epoch += 1.0;
        self.stats()
    }

    /// pending queue를 취소한다.
    pub fn cancel(&mut self) -> Result<CancelReceipt, IngestionError> {
        self.active_owner()?;
        let session = self.configured_mut()?;
        session.active()?;
        if session.leased {
            return Err(IngestionError::new("BUSY", "Async ingestion lease active"));
        }
        let events = session.count;
        let first_sequence = (events > 0).then_some(session.first_pending_sequence);
        let last_sequence = first_sequence.map(|first| first + events as f64 - 1.0);
        session.counters.cancelled += events as f64;
        if let Some(last) = last_sequence {
            session.counters.last_cancelled_sequence = Some(last);
        }
        session.count = 0;
        session.head = 0;
        session.first_pending_sequence = session.next_sequence;
        session.epoch += 1.0;
        Ok(CancelReceipt {
            events,
            first_sequence,
            last_sequence,
        })
    }

    fn stats_value(data: &ModelDataState, session: &IngestionSession) -> JsValue {
        let (paused, last_error) = session.source_status(data);
        let mut value = JsObject::new();
        value.insert(JsString::from_str("policy"), session.policy.to_value());
        value.insert(
            JsString::from_str("state"),
            value_string(if session.leased || session.draining {
                "busy"
            } else if paused {
                "paused"
            } else {
                "running"
            }),
        );
        value.insert(
            JsString::from_str("nextSequence"),
            value_number(session.next_sequence),
        );
        for key in &session.counters.order {
            value.insert(JsString::from_str(key), session.counters.number(key));
        }
        value.insert(
            JsString::from_str("pendingEvents"),
            value_number(session.count as f64),
        );
        value.insert(
            JsString::from_str("pendingBytes"),
            value_number((session.count * INGESTION_BYTES) as f64),
        );
        value.insert(
            JsString::from_str("ownedBytes"),
            value_number((session.capacity * INGESTION_BYTES) as f64),
        );
        value.insert(
            JsString::from_str("lastError"),
            last_error.map_or(JsValue::Null, |error| error.to_value()),
        );
        value.insert(
            JsString::from_str("storedBars"),
            value_number(data.store().length() as f64),
        );
        value.insert(
            JsString::from_str("storeBytes"),
            value_number(data.store().bytes() as f64),
        );
        JsValue::Object(value)
    }

    /// session 통계를 소유 값으로 돌려준다.
    pub fn stats(&self) -> Result<JsValue, IngestionError> {
        self.active_owner()?;
        let session = self.configured()?;
        session.active()?;
        Ok(Self::stats_value(&self.data, session))
    }

    /// session 문서를 canonical checkpoint JSON으로 저장한다.
    pub fn save(&self) -> Result<JsString, IngestionError> {
        let mut scope = MemoryScope::unaccounted(self.data.store().memory_context().oom_style());
        self.save_scoped(&mut scope)
    }

    /// Caller serialization scope에 canonical document 결과 allocation을 유지한다.
    pub fn save_scoped(&self, scope: &mut MemoryScope) -> Result<JsString, IngestionError> {
        self.active_owner()?;
        let session = self.configured()?;
        session.active()?;
        let (paused, last_error) = session.source_status(&self.data);
        let memory = self.data.store().memory_context().clone();
        let (document, payload_memory) =
            Self::session_document(session, paused, last_error, &memory)
                .map_err(IngestionError::from_memory_failure)?;
        let result = safe_checkpoint_stringify_scoped(&document, self.dialect, scope)
            .map_err(|error| ingestion_from_js("INVALID_INPUT", error));
        drop(document);
        drop(payload_memory);
        result
    }

    /// Canonical document와 exact UTF-16 result group을 함께 소유해 돌려준다.
    pub fn save_with_memory(&self) -> Result<(JsString, MemoryGroup), IngestionError> {
        let memory = self.data.store().memory_context();
        let mut scope = memory.scope();
        let text = self.save_scoped(&mut scope)?;
        let bytes = text.len_utf16().saturating_mul(std::mem::size_of::<u16>());
        let group = scope
            .split_persistent(bytes)
            .map_err(IngestionError::from_memory_failure)?;
        Ok((text, group))
    }

    fn session_document(
        session: &IngestionSession,
        paused: bool,
        last_error: Option<LastError>,
        memory: &MemoryContext,
    ) -> Result<(JsValue, MemoryGroup), MemoryFailure> {
        let (events, events_memory) = session.prefix_with_memory(session.count, memory)?;
        let (mut event_values, event_values_memory) = memory.try_vec_capacity(events.len())?;
        for event in &events {
            event_values.push(event_value(*event));
        }
        drop(events);
        drop(events_memory);
        let payload_memory = event_values_memory;
        // `payload_memory` is declared before `document`, so the document's Vec payload drops
        // first when this function returns or the caller explicitly releases both values.
        let document = object([
            ("schema", value_string("aster.ingestion")),
            ("version", value_number(1.0)),
            ("policy", session.policy.to_value()),
            (
                "state",
                value_string(if paused { "paused" } else { "running" }),
            ),
            ("nextSequence", value_number(session.next_sequence)),
            ("counters", session.counters.to_value()),
            (
                "lastError",
                last_error.map_or(JsValue::Null, |error| error.to_value()),
            ),
            (
                "pending",
                object([
                    (
                        "firstSequence",
                        value_number(session.first_pending_sequence),
                    ),
                    ("events", JsValue::Array(event_values)),
                ]),
            ),
        ]);
        Ok((document, payload_memory))
    }

    fn session_document_unaccounted(
        session: &IngestionSession,
        paused: bool,
        last_error: Option<LastError>,
    ) -> JsValue {
        let memory = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
        Self::session_document(session, paused, last_error, &memory)
            .expect("unaccounted ingestion document allocation")
            .0
    }

    /// TargetCreate가 실제 열을 할당·복사하기 전에 동일 parser로 수집 문서를 검증한다.
    pub fn validate_workspace_restore_document(
        shape: IngestionStoreShape,
        text: &JsValue,
        dialect: NumberDialect,
    ) -> Result<ValidatedWorkspaceIngestion, JsError> {
        if !matches!(text, JsValue::String(value) if value.len_utf16() <= 32768) {
            return Err(js_error(
                "RangeError",
                "Native workspace ingestion document limit",
            ));
        }
        let candidate = Self::restore_candidate_for_shape(shape, 0.0, text, dialect)
            .map_err(IngestionError::into_js_error)?;
        if candidate.count != 0 {
            return Err(js_error("TypeError", "Native workspace pending ingestion"));
        }
        let document = Self::session_document_unaccounted(
            &candidate,
            candidate.paused,
            candidate.last_error.clone(),
        );
        let text = safe_checkpoint_stringify_with(&document, dialect)?;
        Ok(ValidatedWorkspaceIngestion {
            text,
            capacity: candidate.capacity,
        })
    }

    fn restore_candidate(&self, text: &JsValue) -> Result<IngestionSession, IngestionError> {
        let store = self.data.store();
        Self::restore_candidate_for_shape_with_memory(
            IngestionStoreShape {
                length: store.length(),
                capacity: store.capacity(),
                max_bars: store.max_bars(),
                version: store.version(),
            },
            store.serial(),
            text,
            self.dialect,
            store.memory_context(),
        )
    }

    fn restore_candidate_for_shape(
        shape: IngestionStoreShape,
        serial: f64,
        text: &JsValue,
        dialect: NumberDialect,
    ) -> Result<IngestionSession, IngestionError> {
        let memory = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
        Self::restore_candidate_for_shape_with_memory(shape, serial, text, dialect, &memory)
    }

    fn restore_candidate_for_shape_with_memory(
        shape: IngestionStoreShape,
        serial: f64,
        text: &JsValue,
        dialect: NumberDialect,
        memory: &MemoryContext,
    ) -> Result<IngestionSession, IngestionError> {
        let mut scope = memory.scope();
        let parsed = safe_checkpoint_parse_scoped(text, dialect, &mut scope)
            .map_err(|error| ingestion_from_js("INVALID_DOCUMENT", error))?;
        let document = record(
            &parsed,
            &[
                "schema",
                "version",
                "policy",
                "state",
                "nextSequence",
                "counters",
                "lastError",
                "pending",
            ],
            "Ingestion document",
            "INVALID_INPUT",
        )?;
        let valid_schema = matches!(property(document, "schema"), Some(JsValue::String(value)) if string_is(value, "aster.ingestion"));
        let valid_version = matches!(property(document, "version"), Some(JsValue::Number(1.0)));
        let state = match property(document, "state") {
            Some(JsValue::String(value)) if string_is(value, "running") => false,
            Some(JsValue::String(value)) if string_is(value, "paused") => true,
            _ => {
                return Err(IngestionError::new(
                    "INVALID_DOCUMENT",
                    "Ingestion schema/version/state",
                ));
            }
        };
        if !valid_schema || !valid_version {
            return Err(IngestionError::new(
                "INVALID_DOCUMENT",
                "Ingestion schema/version/state",
            ));
        }
        let policy = parse_policy_bounds(
            shape.length,
            shape.capacity.saturating_mul(96),
            property(document, "policy").unwrap_or(&JsValue::Undefined),
            false,
            shape.max_bars,
        )?;
        let mut candidate =
            IngestionSession::new_with_source(serial, shape.version, policy, memory)?;
        let undefined_counters = JsValue::Undefined;
        let counters_value = property(document, "counters").unwrap_or(&undefined_counters);
        let counters_object = record(counters_value, COUNTER_KEYS, "Counters", "INVALID_INPUT")?;
        if counters_object.len() != COUNTER_KEYS.len()
            || COUNTER_KEYS
                .iter()
                .any(|key| property(counters_object, key).is_none())
        {
            return Err(IngestionError::new(
                "INVALID_INPUT",
                "Counters unsupported field",
            ));
        }
        let mut order = Vec::with_capacity(COUNTER_KEYS.len());
        for (key, _) in counters_object.iter() {
            order.push(
                *COUNTER_KEYS
                    .iter()
                    .find(|expected| key_is(key, expected))
                    .expect("validated counter key"),
            );
        }
        let counter = |key: &str| -> Result<f64, IngestionError> {
            integer_document(
                property(counters_object, key).unwrap_or(&JsValue::Undefined),
                0.0,
                MAX_SAFE_INTEGER,
                key,
            )
        };
        let nullable = |key: &str| -> Result<Option<f64>, IngestionError> {
            match property(counters_object, key) {
                Some(JsValue::Null) => Ok(None),
                Some(value) => integer_document(value, 0.0, MAX_SAFE_INTEGER, key).map(Some),
                None => Err(IngestionError::new(
                    "INVALID_INPUT",
                    "Counters unsupported field",
                )),
            }
        };
        let counters = Counters {
            accepted: counter("accepted")?,
            applied: counter("applied")?,
            cancelled: counter("cancelled")?,
            rejected_packets: counter("rejectedPackets")?,
            rejected_events: counter("rejectedEvents")?,
            failed_drains: counter("failedDrains")?,
            peak_pending_events: counter("peakPendingEvents")?,
            peak_pending_bytes: counter("peakPendingBytes")?,
            last_applied_sequence: nullable("lastAppliedSequence")?,
            last_cancelled_sequence: nullable("lastCancelledSequence")?,
            order,
        };
        let undefined_pending = JsValue::Undefined;
        let pending = record(
            property(document, "pending").unwrap_or(&undefined_pending),
            &["firstSequence", "events"],
            "Pending",
            "INVALID_INPUT",
        )?;
        let undefined_events = JsValue::Undefined;
        let pending_events_value = property(pending, "events").unwrap_or(&undefined_events);
        let JsValue::Array(pending_values) = pending_events_value else {
            return Err(IngestionError::new("INVALID_DOCUMENT", "Pending count"));
        };
        if pending_values.len() > candidate.capacity {
            return Err(IngestionError::new("INVALID_DOCUMENT", "Pending count"));
        }
        let (events, events_memory) = if pending_values.is_empty() {
            (Vec::new(), MemoryGroup::empty(memory.clone()))
        } else {
            snapshot_ingestion_events_with_memory(pending_events_value, memory)?
        };
        let next_sequence = integer_document(
            property(document, "nextSequence").unwrap_or(&JsValue::Undefined),
            0.0,
            MAX_SAFE_INTEGER,
            "Next sequence",
        )?;
        let first_pending = integer_document(
            property(pending, "firstSequence").unwrap_or(&JsValue::Undefined),
            0.0,
            MAX_SAFE_INTEGER,
            "Pending sequence",
        )?;
        if counters.accepted != counters.applied + counters.cancelled + events.len() as f64
            || candidate.policy.first_sequence + counters.accepted != next_sequence
            || first_pending + events.len() as f64 != next_sequence
            || counters.peak_pending_events < events.len() as f64
            || counters.peak_pending_events > candidate.capacity as f64
            || counters.peak_pending_bytes != counters.peak_pending_events * INGESTION_BYTES as f64
        {
            return Err(IngestionError::new(
                "INVALID_DOCUMENT",
                "Ingestion cursor/counter conservation",
            ));
        }
        for (count, cursor) in [
            (counters.applied, counters.last_applied_sequence),
            (counters.cancelled, counters.last_cancelled_sequence),
        ] {
            if (count == 0.0 && cursor.is_some())
                || (count > 0.0
                    && cursor.is_none_or(|cursor| {
                        cursor < candidate.policy.first_sequence + count - 1.0
                            || cursor >= first_pending
                    }))
            {
                return Err(IngestionError::new(
                    "INVALID_DOCUMENT",
                    "Ingestion completed cursor",
                ));
            }
        }
        let completed = counters.applied + counters.cancelled;
        let applied_cursor = counters.last_applied_sequence.unwrap_or(-1.0);
        let cancelled_cursor = counters.last_cancelled_sequence.unwrap_or(-1.0);
        let max_cursor = if applied_cursor > cancelled_cursor {
            applied_cursor
        } else {
            cancelled_cursor
        };
        if (completed > 0.0 && max_cursor != first_pending - 1.0)
            || (counters.applied > 0.0
                && counters.cancelled > 0.0
                && counters.last_applied_sequence == counters.last_cancelled_sequence)
            || (counters.accepted > 0.0 && counters.peak_pending_events == 0.0)
            || (counters.failed_drains > 0.0 && counters.accepted == 0.0)
            || (counters.rejected_packets == 0.0 && counters.rejected_events != 0.0)
            || counters.rejected_events > counters.rejected_packets * 4_096.0
        {
            return Err(IngestionError::new(
                "INVALID_DOCUMENT",
                "Ingestion history/counter bounds",
            ));
        }
        for cursor in [
            counters.last_applied_sequence,
            counters.last_cancelled_sequence,
        ] {
            if cursor.is_some_and(|cursor| {
                cursor < candidate.policy.first_sequence || cursor >= next_sequence
            }) {
                return Err(IngestionError::new(
                    "INVALID_DOCUMENT",
                    "Ingestion cursor/counter conservation",
                ));
            }
        }
        let last_error = match property(document, "lastError") {
            Some(JsValue::Null) => None,
            Some(value) => Some(parse_last_error(value)?),
            None => {
                return Err(IngestionError::new("INVALID_DOCUMENT", "Last error shape"));
            }
        };
        if !state && last_error.is_some() {
            return Err(IngestionError::new(
                "INVALID_DOCUMENT",
                "Running ingestion cannot retain a paused error",
            ));
        }
        let ring = candidate.ring.as_mut().expect("candidate owns ring");
        for (index, event) in events.iter().enumerate() {
            ring.write(index, *event);
        }
        let pending_count = events.len();
        drop(events);
        drop(events_memory);
        candidate.count = pending_count;
        candidate.first_pending_sequence = first_pending;
        candidate.next_sequence = next_sequence;
        candidate.counters = counters;
        candidate.paused = state;
        candidate.last_error = last_error;
        Ok(candidate)
    }

    /// 저장 문서를 원자적으로 복원한다.
    pub fn load(&mut self, text: &JsValue) -> Result<JsValue, IngestionError> {
        self.active_owner()?;
        self.idle_fence()?;
        if let Some(old) = self.session.as_ref() {
            old.idle()?;
            if old.count > 0 {
                return Err(IngestionError::new(
                    "PENDING_DATA",
                    "Cancel or drain pending data before restoration",
                ));
            }
        }
        let candidate = self.restore_candidate(text)?;
        self.session = Some(candidate);
        self.stats()
    }

    /// lease를 얻고 epoch를 올린다. 반환 token은 idempotent release에 쓴다.
    pub fn acquire_lease(&mut self) -> Result<u64, IngestionError> {
        self.active_owner()?;
        let session = self.configured_mut()?;
        session.idle()?;
        if session.count > 0 {
            return Err(IngestionError::new(
                "PENDING_DATA",
                "Drain or cancel pending data before async preparation",
            ));
        }
        session.lease_serial = session.lease_serial.wrapping_add(1);
        session.leased = true;
        session.epoch += 1.0;
        session.active_lease = Some(session.lease_serial);
        Ok(session.lease_serial)
    }

    /// token이 현재 lease면 한 번만 해제한다.
    pub fn release_lease(&mut self, token: u64) -> Result<(), IngestionError> {
        let session = self.configured_mut()?;
        if session.active_lease == Some(token) {
            session.active_lease = None;
            session.leased = false;
            session.epoch += 1.0;
        }
        Ok(())
    }

    /// 현재 epoch를 돌려준다.
    pub fn epoch(&self) -> Result<f64, IngestionError> {
        let session = self.configured()?;
        session.active()?;
        Ok(session.epoch)
    }

    /// typed batch를 수집 정책 예산과 함께 적용한다.
    pub fn apply_data_events(
        &mut self,
        input: &JsValue,
        skip_unchanged: bool,
    ) -> Result<Committed<BatchReceipt>, ApplyDataError> {
        self.apply_data_events_with_external_values(input, skip_unchanged, false)
    }

    /// 외부 series 값의 host realignment 여부까지 검사해 typed batch를 적용한다.
    pub fn apply_data_events_with_external_values(
        &mut self,
        input: &JsValue,
        skip_unchanged: bool,
        external_values: bool,
    ) -> Result<Committed<BatchReceipt>, ApplyDataError> {
        self.active_owner().map_err(ApplyDataError::Ingestion)?;
        let memory = self.data.store().memory_context().clone();
        let (events, events_memory) = snapshot_ingestion_events_with_memory(input, &memory)
            .map_err(ApplyDataError::Ingestion)?;
        if external_values
            && events
                .iter()
                .any(|event| event.kind == IngestionKind::Append)
        {
            drop(events);
            drop(events_memory);
            return Err(ApplyDataError::Ingestion(IngestionError::new(
                "EXTERNAL_ALIGNMENT",
                "Length-changing batches require host realignment of external values",
            )));
        }
        let (mut batch, batch_memory) = memory
            .try_vec_capacity(events.len())
            .map_err(IngestionError::from_memory_failure)
            .map_err(ApplyDataError::Ingestion)?;
        for event in &events {
            batch.push(batch_event(*event));
        }
        drop(events);
        drop(events_memory);
        let policy = self.session.as_ref().map(|session| session.policy.clone());
        let options = BatchOptions::from_scalar_values(
            policy
                .as_ref()
                .map(|policy| value_number(policy.max_stored_bars as f64)),
            policy
                .as_ref()
                .map(|policy| value_number(policy.max_store_bytes as f64)),
            Some(skip_unchanged),
        );
        let result = self
            .data
            .store_mut()
            .apply_events(&batch, &options)
            .map_err(ApplyDataError::Store);
        drop(batch);
        drop(batch_memory);
        result
    }

    /// unchanged batch host 봉투다.
    pub fn native_apply_unchanged_data_events(
        &mut self,
        input: &JsValue,
    ) -> Result<JsValue, ApplyDataError> {
        self.native_apply_unchanged_data_events_committed(input, false)
            .map(|committed| committed.value)
    }

    /// 원본 batch 영수증과 모델에 발행할 변경을 함께 돌려준다.
    pub fn native_apply_unchanged_data_events_committed(
        &mut self,
        input: &JsValue,
        external_values: bool,
    ) -> Result<Committed<JsValue>, ApplyDataError> {
        let before = self.data.store().version();
        let committed =
            self.apply_data_events_with_external_values(input, true, external_values)?;
        let receipt = &committed.value;
        let after = self.data.store().version();
        let receipt_value = object([
            ("events", value_number(receipt.events as f64)),
            ("appended", value_number(receipt.appended as f64)),
            ("from", value_number(receipt.from as f64)),
            ("to", value_number(receipt.to as f64)),
            ("version", value_number(receipt.version)),
            ("length", value_number(receipt.length as f64)),
            ("capacity", value_number(receipt.capacity as f64)),
            ("bytes", value_number(receipt.bytes as f64)),
            (
                "unchanged",
                JsValue::Bool(receipt.unchanged.unwrap_or(false)),
            ),
        ]);
        let value = object([
            ("schema", value_string("aster.native-data-batch")),
            ("version", value_number(1.0)),
            ("beforeVersion", value_number(before)),
            ("afterVersion", value_number(after)),
            (
                "unchanged",
                JsValue::Bool(receipt.unchanged.unwrap_or(false)),
            ),
            ("receipt", receipt_value),
        ]);
        Ok(Committed {
            value,
            change: committed.change,
        })
    }

    /// close 정리에서 session을 닫되 attached slot은 유지한다.
    pub fn native_release_data_ingestion(&mut self) -> ReleaseReceipt {
        let cancelled = self.session.as_mut().map_or(0, IngestionSession::dispose);
        ReleaseReceipt { cancelled }
    }

    /// native command 아홉 연산의 성공/오류 봉투를 만든다. unknown은 봉투 밖 TypeError다.
    pub fn native_data_ingestion_command(
        &mut self,
        operation: &str,
        args: &JsValue,
    ) -> Result<JsValue, JsError> {
        let arity = match operation {
            "configureDataIngestion"
            | "enqueueDataEvents"
            | "drainDataEvents"
            | "loadDataIngestion" => 1,
            "pauseDataIngestion"
            | "resumeDataIngestion"
            | "cancelDataEvents"
            | "dataIngestionStats"
            | "saveDataIngestion" => 0,
            _ => return Err(js_error("TypeError", "Unknown ingestion command")),
        };
        let result = (|| -> Result<JsValue, IngestionError> {
            let JsValue::Array(args) = args else {
                return Err(IngestionError::new(
                    if operation == "loadDataIngestion" {
                        "INVALID_DOCUMENT"
                    } else {
                        "INVALID_INPUT"
                    },
                    "Unknown chart command or argument list",
                ));
            };
            if args.len() > arity {
                return Err(IngestionError::new(
                    if operation == "loadDataIngestion" {
                        "INVALID_DOCUMENT"
                    } else {
                        "INVALID_INPUT"
                    },
                    "Chart command argument count",
                ));
            }
            match operation {
                "configureDataIngestion" => {
                    self.configure(args.first().unwrap_or(&JsValue::Undefined))
                }
                "enqueueDataEvents" => self.enqueue(args.first().unwrap_or(&JsValue::Undefined)),
                "drainDataEvents" => self
                    .drain(args.first(), false)
                    .map(|receipt| receipt.to_value()),
                "pauseDataIngestion" => self.pause(),
                "resumeDataIngestion" => self.resume(),
                "cancelDataEvents" => self.cancel().map(|receipt| receipt.to_value()),
                "dataIngestionStats" => self.stats(),
                "saveDataIngestion" => self.save().map(JsValue::String),
                "loadDataIngestion" => self.load(args.first().unwrap_or(&JsValue::Undefined)),
                _ => unreachable!(),
            }
        })();
        Ok(match result {
            Ok(result) => object([("result", result)]),
            Err(error) => {
                // Native command envelopes intentionally catch all source/resource errors.
                // Reserved OOM tags must not cross this caught boundary; direct Core callers
                // still receive them through `IngestionError::into_js_error`.
                let is_reserved_oom = matches!(
                    error.code(),
                    barochart_js::memory::OOM_LIMIT_CODE | barochart_js::memory::OOM_SYSTEM_CODE
                );
                let code = if error.name() == "IngestionError" && !is_reserved_oom {
                    error.code()
                } else if operation == "loadDataIngestion" {
                    "INVALID_DOCUMENT"
                } else {
                    "INVALID_INPUT"
                };
                object([(
                    "error",
                    object([
                        ("name", value_string("IngestionError")),
                        ("code", value_string(code)),
                        ("message", JsValue::String(bounded_message(error.message()))),
                    ]),
                )])
            }
        })
    }

    /// 모델을 닫는다. 이후 모든 owner 작업은 CLOSED다.
    pub fn dispose(&mut self) {
        self.native_release_data_ingestion();
        self.disposed = true;
    }
}

fn parse_last_error(value: &JsValue) -> Result<LastError, IngestionError> {
    let row = record(value, &["code", "message"], "Last error", "INVALID_INPUT")?;
    if row.len() != 2 {
        return Err(IngestionError::new("INVALID_DOCUMENT", "Last error shape"));
    }
    let code = match property(row, "code") {
        Some(JsValue::String(code)) => code.clone(),
        _ => return Err(IngestionError::new("INVALID_DOCUMENT", "Last error shape")),
    };
    let message = match property(row, "message") {
        Some(JsValue::String(message)) if message.len_utf16() <= 256 => message.clone(),
        _ => return Err(IngestionError::new("INVALID_DOCUMENT", "Last error shape")),
    };
    let code_text = code.to_string_lossy();
    if code_text.is_empty()
        || code_text.len() > 64
        || !code_text
            .bytes()
            .all(|byte| byte == b'_' || byte.is_ascii_uppercase())
    {
        return Err(IngestionError::new("INVALID_DOCUMENT", "Last error shape"));
    }
    let message_first = row
        .iter()
        .next()
        .is_some_and(|(key, _)| key_is(key, "message"));
    Ok(LastError {
        code,
        message,
        message_first,
    })
}
