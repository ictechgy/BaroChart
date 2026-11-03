//! VWAP·Pivots의 legacy/advanced 계산과 portable session calendar adapter다.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

use barochart_js::date::days_from_civil;
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

use crate::Host;
use crate::checkpoint_codec::safe_checkpoint_parse;
use crate::contracts::option_record;
use crate::data::Bar;
use crate::indicator_helpers::CheckpointFieldOrder;
use crate::indicator_params::{
    IndicatorParamValue, OrderedIndicatorParams, validate_indicator_params,
};
use crate::indicator_registry::metadata_for_program;
use crate::indicator_types::{
    CreatedIndicator, IndicatorDefinition, IndicatorOutputRow, IndicatorProgram,
    IndicatorProvenance,
};
use crate::markets::{
    CalendarProvider, SessionWindowInput, market_date, shift_date, zoned_epoch, zoned_parts,
};

const CALENDAR_LIMIT: usize = 65_536;
const VWAP_LEGACY_FIELDS: [&str; 3] = ["session", "pv", "v"];
const VWAP_ADVANCED_FIELDS: [&str; 6] = ["session", "count", "pv", "v", "mean", "m2"];
const PIVOTS_LEGACY_FIELDS: [&str; 5] = ["session", "high", "low", "close", "levels"];
const PIVOTS_ADVANCED_FIELDS: [&str; 6] = ["session", "count", "high", "low", "close", "levels"];
const VWAP_VALUE: [&str; 1] = ["value"];
const VWAP_BANDS: [&str; 5] = ["value", "upper", "lower", "deviation", "volume"];
const PIVOT_OUTPUTS: [&str; 5] = ["pivot", "r1", "s1", "r2", "s2"];

/// Portable 달력의 한 지역 세션 창이다.
#[derive(Clone, Debug)]
pub struct PortableWindow {
    open: String,
    close: String,
    kind: JsString,
}

/// canonical portable calendar를 `markets::CalendarProvider`로 노출하는 typed adapter다.
#[derive(Clone, Debug)]
pub struct PortableCalendarProvider {
    timezone: JsString,
    weekdays: Vec<u8>,
    windows: Vec<PortableWindow>,
    exceptions: BTreeMap<String, Vec<PortableWindow>>,
    ambiguity: String,
}

impl CalendarProvider for PortableCalendarProvider {
    fn windows(&mut self, date: &str) -> Result<Vec<SessionWindowInput>, JsError> {
        let windows = if let Some(windows) = self.exceptions.get(date) {
            windows
        } else if self.weekdays.contains(&weekday(date)?) {
            &self.windows
        } else {
            return Ok(Vec::new());
        };
        Ok(windows
            .iter()
            .map(|window| SessionWindowInput {
                open: window.open.clone(),
                close: window.close.clone(),
                kind: window.kind.clone(),
            })
            .collect())
    }
}

#[derive(Clone, Debug)]
struct ResolvedSession {
    date: String,
    kind: JsString,
    open: f64,
    close: f64,
}

/// Portable ambiguity를 적용하는 leaf 전용 session cache다.
#[derive(Clone, Debug)]
struct PortableSessionCalendar {
    provider: PortableCalendarProvider,
    sessions: VecDeque<(String, Arc<[ResolvedSession]>)>,
}

impl PortableSessionCalendar {
    fn new(provider: PortableCalendarProvider) -> Self {
        Self {
            provider,
            sessions: VecDeque::new(),
        }
    }

    fn sessions(&mut self, host: &dyn Host, date: &str) -> Result<Arc<[ResolvedSession]>, JsError> {
        if let Some((_, sessions)) = self.sessions.iter().find(|(key, _)| key == date) {
            return Ok(Arc::clone(sessions));
        }
        let inputs = self.provider.windows(date)?;
        let mut resolved = Vec::with_capacity(inputs.len());
        let mut previous_close = None;
        for input in inputs {
            let open_minutes = clock_minutes(&input.open)?;
            let close_minutes = clock_minutes(&input.close)?;
            let close_date = if close_minutes <= open_minutes {
                shift_date(date, 1.0)?
            } else {
                date.to_owned()
            };
            let open = zoned_epoch(
                host,
                date,
                &input.open,
                &self.provider.timezone,
                &self.provider.ambiguity,
            )?;
            let close = zoned_epoch(
                host,
                &close_date,
                &input.close,
                &self.provider.timezone,
                &self.provider.ambiguity,
            )?;
            if close <= open || previous_close.is_some_and(|previous| open < previous) {
                return Err(range_error("Ordered nonoverlapping sessions required"));
            }
            previous_close = Some(close);
            resolved.push(ResolvedSession {
                date: date.to_owned(),
                kind: input.kind,
                open,
                close,
            });
        }
        let resolved: Arc<[ResolvedSession]> = resolved.into();
        self.sessions
            .push_back((date.to_owned(), Arc::clone(&resolved)));
        if self.sessions.len() > 512 {
            self.sessions.pop_front();
        }
        Ok(resolved)
    }

    fn at(
        &mut self,
        host: &dyn Host,
        time: f64,
        kinds: &[JsString],
    ) -> Result<Option<ResolvedSession>, JsError> {
        let date = market_date(host, time, &self.provider.timezone)?;
        let previous = self.sessions(host, &shift_date(&date, -1.0)?)?;
        let current = self.sessions(host, &date)?;
        if previous
            .last()
            .zip(current.first())
            .is_some_and(|(left, right)| left.close > right.open)
        {
            return Err(range_error("Overlapping adjacent session dates"));
        }
        Ok(previous
            .iter()
            .chain(current.iter())
            .find(|session| {
                time >= session.open
                    && time < session.close
                    && kinds.iter().any(|kind| kind == &session.kind)
            })
            .cloned())
    }
}

#[derive(Clone, Debug)]
enum SessionKey {
    Null,
    Number(f64),
    Text(String),
}

impl SessionKey {
    fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Number(left), Self::Number(right)) => left == right,
            (Self::Text(left), Self::Text(right)) => left == right,
            _ => false,
        }
    }

    fn to_wire(&self) -> JsValue {
        match self {
            Self::Null => JsValue::Null,
            Self::Number(value) => JsValue::Number(*value),
            Self::Text(value) => JsValue::String(JsString::from_str(value)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum PriceSource {
    Hlc3,
    Close,
    Hl2,
    Ohlc4,
}

#[derive(Clone, Debug)]
struct SessionSelector {
    calendar: Option<PortableSessionCalendar>,
    anchor: Option<f64>,
    session_ms: f64,
    kinds: Vec<JsString>,
    memo: VecDeque<(u64, Option<SessionKey>)>,
}

impl SessionSelector {
    fn select(&mut self, host: &dyn Host, time: f64) -> Result<Option<SessionKey>, JsError> {
        if self.calendar.is_some() && safe_time(time) {
            let key = if time == 0.0 { 0 } else { time.to_bits() };
            if let Some(index) = self
                .memo
                .iter()
                .position(|(candidate, _)| *candidate == key)
            {
                let (_, result) = self.memo.remove(index).expect("memo index exists");
                self.memo.push_back((key, result.clone()));
                return Ok(result);
            }
            let result = self.select_uncached(host, time)?;
            self.memo.push_back((key, result.clone()));
            if self.memo.len() > 512 {
                self.memo.pop_front();
            }
            return Ok(result);
        }
        self.select_uncached(host, time)
    }

    fn select_uncached(
        &mut self,
        host: &dyn Host,
        time: f64,
    ) -> Result<Option<SessionKey>, JsError> {
        if self.anchor.is_some_and(|anchor| time < anchor) {
            return Ok(None);
        }
        let session = match self.calendar.as_mut() {
            Some(calendar) => match calendar.at(host, time, &self.kinds)? {
                Some(session) => Some(session),
                None => return Ok(None),
            },
            None => None,
        };
        if let Some(anchor) = self.anchor {
            return Ok(Some(SessionKey::Number(anchor)));
        }
        if let Some(session) = session {
            return Ok(Some(SessionKey::Text(session.date)));
        }
        let bucket = (time / self.session_ms).floor();
        if !bucket.is_finite() {
            return Err(range_error("Session bucket overflow"));
        }
        Ok(Some(SessionKey::Number(bucket)))
    }
}

#[derive(Clone, Debug)]
pub struct LegacyVwapState {
    session_ms: f64,
    session: f64,
    pv: f64,
    volume: f64,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
pub struct AdvancedVwapState {
    selector: SessionSelector,
    source: PriceSource,
    deviation: Option<f64>,
    session: SessionKey,
    count: f64,
    pv: f64,
    volume: f64,
    mean: f64,
    m2: f64,
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
pub struct LegacyPivotsState {
    session_ms: f64,
    session: f64,
    high: f64,
    low: f64,
    close: f64,
    levels: [f64; 5],
    order: CheckpointFieldOrder,
}

#[derive(Clone, Debug)]
pub struct AdvancedPivotsState {
    selector: SessionSelector,
    session: SessionKey,
    count: f64,
    high: Option<f64>,
    low: Option<f64>,
    close: Option<f64>,
    levels: [f64; 5],
    order: CheckpointFieldOrder,
}

/// Session leaf가 소유하는 legacy/advanced VWAP·Pivots state다.
#[derive(Clone, Debug)]
pub enum SessionState {
    /// sessionMs-only legacy VWAP다.
    VwapLegacy(LegacyVwapState),
    /// Calendar/anchor/source/deviation advanced VWAP다.
    VwapAdvanced(AdvancedVwapState),
    /// sessionMs-only legacy Pivots다.
    PivotsLegacy(LegacyPivotsState),
    /// Calendar/kinds advanced Pivots다.
    PivotsAdvanced(AdvancedPivotsState),
}

#[derive(Clone, Debug)]
struct SessionConfig {
    calendar: Option<PortableCalendarProvider>,
    anchor: Option<f64>,
    session_ms: f64,
    kinds: Vec<JsString>,
    source: PriceSource,
    deviation: Option<f64>,
    advanced: bool,
}

/// Generic params와 portable calendar를 검증하고 session study를 만든다.
pub fn create(
    program: IndicatorProgram,
    params: &JsValue,
    host: &dyn Host,
) -> Result<CreatedIndicator<SessionState>, JsError> {
    let validated = validate_indicator_params(params)?;
    let config = session_config(&validated, program, host)?;
    let (outputs, state): (&'static [&'static str], SessionState) = match program {
        IndicatorProgram::Vwap if !config.advanced => (
            &VWAP_VALUE,
            SessionState::VwapLegacy(LegacyVwapState {
                session_ms: config.session_ms,
                session: f64::NAN,
                pv: 0.0,
                volume: 0.0,
                order: CheckpointFieldOrder::source(VWAP_LEGACY_FIELDS.len()),
            }),
        ),
        IndicatorProgram::Vwap => {
            let bands = config.deviation.is_some();
            let outputs: &'static [&'static str] = if bands { &VWAP_BANDS } else { &VWAP_VALUE };
            (
                outputs,
                SessionState::VwapAdvanced(AdvancedVwapState {
                    selector: selector(&config),
                    source: config.source,
                    deviation: config.deviation,
                    session: SessionKey::Null,
                    count: 0.0,
                    pv: 0.0,
                    volume: 0.0,
                    mean: 0.0,
                    m2: 0.0,
                    order: CheckpointFieldOrder::source(VWAP_ADVANCED_FIELDS.len()),
                }),
            )
        }
        IndicatorProgram::Pivots if !config.advanced => (
            &PIVOT_OUTPUTS,
            SessionState::PivotsLegacy(LegacyPivotsState {
                session_ms: config.session_ms,
                session: f64::NAN,
                high: f64::NAN,
                low: f64::NAN,
                close: f64::NAN,
                levels: [f64::NAN; 5],
                order: CheckpointFieldOrder::source(PIVOTS_LEGACY_FIELDS.len()),
            }),
        ),
        IndicatorProgram::Pivots => (
            &PIVOT_OUTPUTS,
            SessionState::PivotsAdvanced(AdvancedPivotsState {
                selector: selector(&config),
                session: SessionKey::Null,
                count: 0.0,
                high: None,
                low: None,
                close: None,
                levels: [f64::NAN; 5],
                order: CheckpointFieldOrder::source(PIVOTS_ADVANCED_FIELDS.len()),
            }),
        ),
        _ => return Err(type_error("Session indicator program")),
    };
    let metadata = metadata_for_program(program);
    let params = validated.ordered_copy(metadata.parameter_order)?;
    let definition = IndicatorDefinition::new(
        program,
        params,
        outputs,
        Vec::new(),
        IndicatorProvenance::Builtin,
    )?;
    Ok(CreatedIndicator { definition, state })
}

fn selector(config: &SessionConfig) -> SessionSelector {
    SessionSelector {
        calendar: config
            .calendar
            .as_ref()
            .cloned()
            .map(PortableSessionCalendar::new),
        anchor: config.anchor,
        session_ms: config.session_ms,
        kinds: config.kinds.clone(),
        memo: VecDeque::new(),
    }
}

impl SessionState {
    /// 한 봉을 실제 Host 시간대와 session 설정으로 계산한다.
    pub fn step(
        &mut self,
        host: &dyn Host,
        bar: &Bar,
        _index: usize,
    ) -> Result<IndicatorOutputRow, JsError> {
        match self {
            Self::VwapLegacy(state) => Ok(vwap_legacy_step(state, bar)),
            Self::VwapAdvanced(state) => vwap_advanced_step(state, host, bar),
            Self::PivotsLegacy(state) => Ok(pivots_legacy_step(state, bar)),
            Self::PivotsAdvanced(state) => pivots_advanced_step(state, host, bar),
        }
    }

    /// 현재 financial state를 원래 key 순서로 복사한다.
    pub fn snapshot(&self) -> JsValue {
        match self {
            Self::VwapLegacy(state) => state.order.ordered_object(&[
                ("session", JsValue::Number(state.session)),
                ("pv", JsValue::Number(state.pv)),
                ("v", JsValue::Number(state.volume)),
            ]),
            Self::VwapAdvanced(state) => state.order.ordered_object(&[
                ("session", state.session.to_wire()),
                ("count", JsValue::Number(state.count)),
                ("pv", JsValue::Number(state.pv)),
                ("v", JsValue::Number(state.volume)),
                ("mean", JsValue::Number(state.mean)),
                ("m2", JsValue::Number(state.m2)),
            ]),
            Self::PivotsLegacy(state) => state.order.ordered_object(&[
                ("session", JsValue::Number(state.session)),
                ("high", JsValue::Number(state.high)),
                ("low", JsValue::Number(state.low)),
                ("close", JsValue::Number(state.close)),
                ("levels", levels_wire(&state.levels)),
            ]),
            Self::PivotsAdvanced(state) => state.order.ordered_object(&[
                ("session", state.session.to_wire()),
                ("count", JsValue::Number(state.count)),
                ("high", option_number(state.high)),
                ("low", option_number(state.low)),
                ("close", option_number(state.close)),
                ("levels", levels_wire(&state.levels)),
            ]),
        }
    }

    /// 의미 검증이 끝난 wire를 financial state로 원자 변환한다. Config와 cache는 유지한다.
    pub fn restore(&mut self, wire: &JsValue) -> Result<(), JsError> {
        match self {
            Self::VwapLegacy(state) => {
                let object = exact_object(wire, &VWAP_LEGACY_FIELDS)?;
                let next = (
                    number(required(object, "session")?)?,
                    number(required(object, "pv")?)?,
                    number(required(object, "v")?)?,
                    CheckpointFieldOrder::capture(wire, &VWAP_LEGACY_FIELDS)
                        .ok_or_else(checkpoint_error)?,
                );
                state.session = next.0;
                state.pv = next.1;
                state.volume = next.2;
                state.order = next.3;
            }
            Self::VwapAdvanced(state) => {
                let object = exact_object(wire, &VWAP_ADVANCED_FIELDS)?;
                let next = (
                    session_key(required(object, "session")?)?,
                    number(required(object, "count")?)?,
                    number(required(object, "pv")?)?,
                    number(required(object, "v")?)?,
                    number(required(object, "mean")?)?,
                    number(required(object, "m2")?)?,
                    CheckpointFieldOrder::capture(wire, &VWAP_ADVANCED_FIELDS)
                        .ok_or_else(checkpoint_error)?,
                );
                state.session = next.0;
                state.count = next.1;
                state.pv = next.2;
                state.volume = next.3;
                state.mean = next.4;
                state.m2 = next.5;
                state.order = next.6;
            }
            Self::PivotsLegacy(state) => {
                let object = exact_object(wire, &PIVOTS_LEGACY_FIELDS)?;
                let next = (
                    number(required(object, "session")?)?,
                    number(required(object, "high")?)?,
                    number(required(object, "low")?)?,
                    number(required(object, "close")?)?,
                    levels(required(object, "levels")?)?,
                    CheckpointFieldOrder::capture(wire, &PIVOTS_LEGACY_FIELDS)
                        .ok_or_else(checkpoint_error)?,
                );
                state.session = next.0;
                state.high = next.1;
                state.low = next.2;
                state.close = next.3;
                state.levels = next.4;
                state.order = next.5;
            }
            Self::PivotsAdvanced(state) => {
                let object = exact_object(wire, &PIVOTS_ADVANCED_FIELDS)?;
                let next = (
                    session_key(required(object, "session")?)?,
                    number(required(object, "count")?)?,
                    nullable_number(required(object, "high")?)?,
                    nullable_number(required(object, "low")?)?,
                    nullable_number(required(object, "close")?)?,
                    levels(required(object, "levels")?)?,
                    CheckpointFieldOrder::capture(wire, &PIVOTS_ADVANCED_FIELDS)
                        .ok_or_else(checkpoint_error)?,
                );
                state.session = next.0;
                state.count = next.1;
                state.high = next.2;
                state.low = next.3;
                state.close = next.4;
                state.levels = next.5;
                state.order = next.6;
            }
        }
        Ok(())
    }
}

fn vwap_legacy_step(state: &mut LegacyVwapState, bar: &Bar) -> IndicatorOutputRow {
    let session = (bar.time / state.session_ms).floor();
    if state.session != session {
        state.session = session;
        state.pv = 0.0;
        state.volume = 0.0;
    }
    state.pv += (bar.high + bar.low + bar.close) / 3.0 * bar.volume;
    state.volume += bar.volume;
    IndicatorOutputRow::one(if state.volume == 0.0 {
        f64::NAN
    } else {
        state.pv / state.volume
    })
}

fn vwap_advanced_step(
    state: &mut AdvancedVwapState,
    host: &dyn Host,
    bar: &Bar,
) -> Result<IndicatorOutputRow, JsError> {
    let Some(session) = state.selector.select(host, bar.time)? else {
        return Ok(if state.deviation.is_some() {
            IndicatorOutputRow::five(f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN)
        } else {
            IndicatorOutputRow::one(f64::NAN)
        });
    };
    let same = state.session.same(&session);
    let previous_count = if same { state.count } else { 0.0 };
    let previous_pv = if same { state.pv } else { 0.0 };
    let previous_volume = if same { state.volume } else { 0.0 };
    let previous_mean = if same { state.mean } else { 0.0 };
    let previous_m2 = if same { state.m2 } else { 0.0 };
    let price = session_price(bar, state.source);
    let volume = previous_volume + bar.volume;
    let pv = previous_pv + price * bar.volume;
    finite(&[price, bar.volume, volume, pv])?;
    if bar.volume < 0.0 {
        return Err(range_error("Session volume"));
    }
    let mean = if bar.volume == 0.0 {
        previous_mean
    } else if previous_volume == 0.0 {
        price
    } else {
        previous_mean + (price - previous_mean) * (bar.volume / volume)
    };
    let m2 = if bar.volume == 0.0 || previous_volume == 0.0 {
        previous_m2
    } else {
        previous_m2 + bar.volume * (price - previous_mean) * (price - mean)
    };
    finite(&[mean, m2])?;
    if m2 < 0.0 {
        return Err(range_error("Session variance"));
    }
    let value = if volume == 0.0 { f64::NAN } else { pv / volume };
    let sigma = if volume == 0.0 {
        f64::NAN
    } else {
        (m2 / volume).sqrt()
    };
    let multiplier = state.deviation.unwrap_or(f64::NAN);
    let upper = value + multiplier * sigma;
    let lower = value - multiplier * sigma;
    if volume > 0.0 {
        if state.deviation.is_some() {
            finite(&[value, sigma, upper, lower])?;
        } else {
            finite(&[value])?;
        }
    }
    state.session = session;
    state.count = previous_count + 1.0;
    state.pv = pv;
    state.volume = volume;
    state.mean = mean;
    state.m2 = m2;
    Ok(if state.deviation.is_some() {
        IndicatorOutputRow::five(value, upper, lower, sigma, volume)
    } else {
        IndicatorOutputRow::one(value)
    })
}

fn pivots_legacy_step(state: &mut LegacyPivotsState, bar: &Bar) -> IndicatorOutputRow {
    let session = (bar.time / state.session_ms).floor();
    if session != state.session {
        if state.close.is_finite() {
            state.levels = pivot_levels(state.high, state.low, state.close);
        }
        state.session = session;
        state.high = bar.high;
        state.low = bar.low;
    } else {
        state.high = js_max(&[state.high, bar.high]);
        state.low = js_min(&[state.low, bar.low]);
    }
    state.close = bar.close;
    IndicatorOutputRow::five(
        state.levels[0],
        state.levels[1],
        state.levels[2],
        state.levels[3],
        state.levels[4],
    )
}

fn pivots_advanced_step(
    state: &mut AdvancedPivotsState,
    host: &dyn Host,
    bar: &Bar,
) -> Result<IndicatorOutputRow, JsError> {
    let Some(session) = state.selector.select(host, bar.time)? else {
        return Ok(IndicatorOutputRow::five(
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
        ));
    };
    finite(&[bar.high, bar.low, bar.close])?;
    if bar.low > bar.high || bar.close < bar.low || bar.close > bar.high {
        return Err(range_error("Session OHLC"));
    }
    let same = state.session.same(&session);
    if !same {
        let levels = if state.count != 0.0 {
            let levels = pivot_levels(
                state.high.expect("counted pivots have high"),
                state.low.expect("counted pivots have low"),
                state.close.expect("counted pivots have close"),
            );
            finite(&levels)?;
            levels
        } else {
            state.levels
        };
        state.session = session;
        state.count = 1.0;
        state.high = Some(bar.high);
        state.low = Some(bar.low);
        state.close = Some(bar.close);
        state.levels = levels;
    } else {
        state.count += 1.0;
        state.high = Some(js_max(&[
            state.high.expect("same session has high"),
            bar.high,
        ]));
        state.low = Some(js_min(&[state.low.expect("same session has low"), bar.low]));
        state.close = Some(bar.close);
    }
    Ok(IndicatorOutputRow::five(
        state.levels[0],
        state.levels[1],
        state.levels[2],
        state.levels[3],
        state.levels[4],
    ))
}

fn session_config(
    params: &OrderedIndicatorParams,
    program: IndicatorProgram,
    host: &dyn Host,
) -> Result<SessionConfig, JsError> {
    let calendar = match params.get("calendar") {
        Some(IndicatorParamValue::String(text)) => Some(parse_calendar(text, host)?),
        Some(IndicatorParamValue::Number(_)) => {
            return Err(type_error("Session calendar string limit"));
        }
        None => None,
    };
    let anchor_present = params.contains("anchorTime");
    if params.contains("sessionMs") && (calendar.is_some() || anchor_present) {
        return Err(type_error("sessionMs conflicts with calendar/anchorTime"));
    }
    let anchor = if anchor_present {
        let value = param_number(params, "anchorTime", f64::NAN);
        if program != IndicatorProgram::Vwap || !safe_time(value) {
            return Err(range_error("VWAP anchor UTC milliseconds"));
        }
        Some(value)
    } else {
        None
    };
    let session_ms = param_number(params, "sessionMs", 86_400_000.0);
    if !session_ms.is_finite() || session_ms <= 0.0 {
        return Err(range_error("Session duration"));
    }
    let kinds = match params.get("kinds") {
        Some(value) => {
            if calendar.is_none() {
                return Err(type_error("Session kinds require calendar"));
            }
            parse_kinds(value)?
        }
        None => vec![JsString::from_str("regular")],
    };
    let source = match params.get("source") {
        None => PriceSource::Hlc3,
        Some(IndicatorParamValue::String(value)) if program == IndicatorProgram::Vwap => {
            match value.to_string_lossy().as_str() {
                "hlc3" => PriceSource::Hlc3,
                "close" => PriceSource::Close,
                "hl2" => PriceSource::Hl2,
                "ohlc4" => PriceSource::Ohlc4,
                _ => return Err(type_error("VWAP source")),
            }
        }
        Some(_) if program == IndicatorProgram::Vwap => return Err(type_error("VWAP source")),
        Some(_) => PriceSource::Hlc3,
    };
    let deviation = if program == IndicatorProgram::Vwap && params.contains("deviation") {
        let value = param_number(params, "deviation", f64::NAN);
        if !value.is_finite() || value < 0.0 {
            return Err(range_error("VWAP deviation multiplier"));
        }
        Some(value)
    } else {
        None
    };
    let advanced = calendar.is_some()
        || anchor.is_some()
        || params.contains("kinds")
        || program == IndicatorProgram::Vwap
            && (params.contains("source") || params.contains("deviation"));
    Ok(SessionConfig {
        calendar,
        anchor,
        session_ms,
        kinds,
        source,
        deviation,
        advanced,
    })
}

fn parse_calendar(text: &JsString, host: &dyn Host) -> Result<PortableCalendarProvider, JsError> {
    session_text(text, CALENDAR_LIMIT, "Session calendar")?;
    if utf8_length(text)? > CALENDAR_LIMIT {
        return Err(range_error("Session calendar 64KiB limit"));
    }
    let parsed = safe_checkpoint_parse(&JsValue::String(text.clone()))?;
    option_record(
        &parsed,
        &["timezone", "weekdays", "windows", "exceptions", "ambiguity"],
        "Session options",
    )?;
    let object = factory_object(&parsed, "Session options")?;
    for required in ["timezone", "weekdays", "windows"] {
        if object.get(&JsString::from_str(required)).is_none() {
            return Err(type_error(&format!("Session options missing {required}")));
        }
    }
    let timezone = session_string(required(object, "timezone")?, 128, "Session timezone")?;
    zoned_parts(host, 0.0, &timezone)?;
    let mut weekdays = parse_weekdays(required(object, "weekdays")?)?;
    weekdays.sort_unstable();
    let windows = parse_windows(required(object, "windows")?)?;
    let mut exceptions = BTreeMap::new();
    if let Some(value) = object.get(&JsString::from_str("exceptions")) {
        let exception_object = factory_object(value, "Session exceptions")?;
        reject_reserved(exception_object, "Session exceptions")?;
        if exception_object.len() > 512 {
            return Err(range_error("Session exception limit 512"));
        }
        let mut dates: Vec<JsString> = exception_object
            .iter()
            .map(|(key, _)| key.clone())
            .collect();
        dates.sort_unstable();
        for date in dates {
            session_text(&date, 10, "Session date")?;
            let date_text = date.to_string_lossy();
            session_date(&date_text)?;
            exceptions.insert(
                date_text,
                parse_windows(exception_object.get(&date).expect("exception key exists"))?,
            );
        }
    }
    let ambiguity = match object.get(&JsString::from_str("ambiguity")) {
        None => "earlier".to_owned(),
        Some(JsValue::String(value)) => {
            let value = value.to_string_lossy();
            if !matches!(value.as_str(), "earlier" | "later" | "reject") {
                return Err(type_error("Session ambiguity earlier/later/reject"));
            }
            value
        }
        Some(_) => return Err(type_error("Session ambiguity earlier/later/reject")),
    };
    let provider = PortableCalendarProvider {
        timezone,
        weekdays,
        windows,
        exceptions,
        ambiguity,
    };
    if canonical_calendar_bytes(&provider) > CALENDAR_LIMIT {
        return Err(range_error("Session calendar 64KiB limit"));
    }
    Ok(provider)
}

fn parse_weekdays(value: &JsValue) -> Result<Vec<u8>, JsError> {
    let JsValue::Array(values) = value else {
        return Err(type_error("Session weekdays array limit"));
    };
    if values.len() > 7 {
        return Err(type_error("Session weekdays array limit"));
    }
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let JsValue::Number(value) = value else {
            return Err(type_error("Unique weekdays 0..6 required"));
        };
        if !value.is_finite() || value.fract() != 0.0 || !(0.0..=6.0).contains(value) {
            return Err(type_error("Unique weekdays 0..6 required"));
        }
        let value = *value as u8;
        if result.contains(&value) {
            return Err(type_error("Unique weekdays 0..6 required"));
        }
        result.push(value);
    }
    Ok(result)
}

fn parse_windows(value: &JsValue) -> Result<Vec<PortableWindow>, JsError> {
    let JsValue::Array(values) = value else {
        return Err(type_error("Session windows array limit"));
    };
    if values.len() > 16 {
        return Err(type_error("Session windows array limit"));
    }
    let mut previous_close = i32::MIN;
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        option_record(value, &["open", "close", "kind"], "Session window")?;
        let object = factory_object(value, "Session window")?;
        for required in ["open", "close"] {
            if object.get(&JsString::from_str(required)).is_none() {
                return Err(type_error(&format!("Session window missing {required}")));
            }
        }
        let (open_text, open_minutes) = session_clock(required(object, "open")?)?;
        let (close_text, close_clock) = session_clock(required(object, "close")?)?;
        let close_minutes = if close_clock <= open_minutes {
            close_clock + 1_440
        } else {
            close_clock
        };
        let kind = match object.get(&JsString::from_str("kind")) {
            None => JsString::from_str("regular"),
            Some(value) => session_string(value, 128, "Session kind")?,
        };
        if kind.as_units().contains(&u16::from(b',')) || JsString::trim(&kind) != kind {
            return Err(type_error("Session kind without comma/outer whitespace"));
        }
        if open_minutes < previous_close {
            return Err(range_error("Ordered nonoverlapping session windows"));
        }
        previous_close = close_minutes;
        result.push(PortableWindow {
            open: open_text,
            close: close_text,
            kind,
        });
    }
    Ok(result)
}

fn parse_kinds(value: &IndicatorParamValue) -> Result<Vec<JsString>, JsError> {
    let IndicatorParamValue::String(value) = value else {
        return Err(type_error("Session kinds string limit"));
    };
    session_text(value, 2_048, "Session kinds")?;
    let value = value.to_string_lossy();
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for kind in value.split(',') {
        let kind = JsString::from_str(kind);
        if kind.as_units().is_empty()
            || kind.len_utf16() > 128
            || JsString::trim(&kind) != kind
            || !seen.insert(kind.clone())
        {
            return Err(type_error("Unique comma-separated session kinds"));
        }
        result.push(kind);
    }
    if result.len() > 16 {
        return Err(type_error("Unique comma-separated session kinds"));
    }
    Ok(result)
}

fn canonical_calendar_bytes(provider: &PortableCalendarProvider) -> usize {
    let mut root = JsObject::new();
    root.insert(
        JsString::from_str("timezone"),
        JsValue::String(provider.timezone.clone()),
    );
    root.insert(
        JsString::from_str("weekdays"),
        JsValue::Array(
            provider
                .weekdays
                .iter()
                .map(|value| JsValue::Number(f64::from(*value)))
                .collect(),
        ),
    );
    root.insert(
        JsString::from_str("windows"),
        windows_wire(&provider.windows),
    );
    let mut exceptions = JsObject::new();
    for (date, windows) in &provider.exceptions {
        exceptions.insert(JsString::from_str(date), windows_wire(windows));
    }
    root.insert(
        JsString::from_str("exceptions"),
        JsValue::Object(exceptions),
    );
    root.insert(
        JsString::from_str("ambiguity"),
        JsValue::String(JsString::from_str(&provider.ambiguity)),
    );
    stringify_json(&JsValue::Object(root), JsonMode::Standard).len()
}

fn windows_wire(windows: &[PortableWindow]) -> JsValue {
    JsValue::Array(
        windows
            .iter()
            .map(|window| {
                let mut object = JsObject::new();
                object.insert(
                    JsString::from_str("open"),
                    JsValue::String(JsString::from_str(&window.open)),
                );
                object.insert(
                    JsString::from_str("close"),
                    JsValue::String(JsString::from_str(&window.close)),
                );
                object.insert(
                    JsString::from_str("kind"),
                    JsValue::String(window.kind.clone()),
                );
                JsValue::Object(object)
            })
            .collect(),
    )
}

fn session_price(bar: &Bar, source: PriceSource) -> f64 {
    match source {
        PriceSource::Close => bar.close,
        PriceSource::Hl2 => (bar.high + bar.low) / 2.0,
        PriceSource::Ohlc4 => (bar.open + bar.high + bar.low + bar.close) / 4.0,
        PriceSource::Hlc3 => (bar.high + bar.low + bar.close) / 3.0,
    }
}

fn pivot_levels(high: f64, low: f64, close: f64) -> [f64; 5] {
    let pivot = (high + low + close) / 3.0;
    [
        pivot,
        2.0 * pivot - low,
        2.0 * pivot - high,
        pivot + high - low,
        pivot - high + low,
    ]
}

fn finite(values: &[f64]) -> Result<(), JsError> {
    if values.iter().any(|value| !value.is_finite()) {
        Err(range_error("Session study numeric overflow"))
    } else {
        Ok(())
    }
}

fn levels_wire(levels: &[f64; 5]) -> JsValue {
    JsValue::Array(levels.iter().copied().map(JsValue::Number).collect())
}

fn levels(value: &JsValue) -> Result<[f64; 5], JsError> {
    let JsValue::Array(values) = value else {
        return Err(checkpoint_error());
    };
    if values.len() != 5 {
        return Err(checkpoint_error());
    }
    let mut result = [0.0; 5];
    for (target, value) in result.iter_mut().zip(values) {
        *target = number(value)?;
    }
    Ok(result)
}

fn session_key(value: &JsValue) -> Result<SessionKey, JsError> {
    match value {
        JsValue::Null => Ok(SessionKey::Null),
        JsValue::Number(value) => Ok(SessionKey::Number(*value)),
        JsValue::String(value) => Ok(SessionKey::Text(value.to_string_lossy())),
        _ => Err(checkpoint_error()),
    }
}

fn option_number(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::Number)
}

fn nullable_number(value: &JsValue) -> Result<Option<f64>, JsError> {
    match value {
        JsValue::Null => Ok(None),
        JsValue::Number(value) => Ok(Some(*value)),
        _ => Err(checkpoint_error()),
    }
}

fn exact_object<'a>(value: &'a JsValue, fields: &[&str]) -> Result<&'a JsObject, JsError> {
    let object = checkpoint_object(value)?;
    if object.len() != fields.len()
        || object
            .iter()
            .any(|(key, _)| !fields.iter().any(|field| text_eq(key, field)))
    {
        return Err(checkpoint_error());
    }
    Ok(object)
}

fn factory_object<'a>(value: &'a JsValue, label: &str) -> Result<&'a JsObject, JsError> {
    let JsValue::Object(value) = value else {
        return Err(type_error(&format!("{label}: object required")));
    };
    Ok(value)
}

fn checkpoint_object(value: &JsValue) -> Result<&JsObject, JsError> {
    let JsValue::Object(value) = value else {
        return Err(checkpoint_error());
    };
    Ok(value)
}

fn required<'a>(object: &'a JsObject, key: &str) -> Result<&'a JsValue, JsError> {
    object
        .get(&JsString::from_str(key))
        .ok_or_else(checkpoint_error)
}

fn number(value: &JsValue) -> Result<f64, JsError> {
    let JsValue::Number(value) = value else {
        return Err(checkpoint_error());
    };
    Ok(*value)
}

fn param_number(params: &OrderedIndicatorParams, key: &str, default: f64) -> f64 {
    match params.get(key) {
        None => default,
        Some(IndicatorParamValue::Number(value)) => *value,
        Some(IndicatorParamValue::String(_)) => f64::NAN,
    }
}

fn session_string(value: &JsValue, max: usize, label: &str) -> Result<JsString, JsError> {
    let JsValue::String(value) = value else {
        return Err(type_error(&format!("{label} string limit")));
    };
    session_text(value, max, label)?;
    Ok(value.clone())
}

fn session_text(value: &JsString, max: usize, label: &str) -> Result<(), JsError> {
    if value.as_units().is_empty() || value.len_utf16() > max {
        return Err(type_error(&format!("{label} string limit")));
    }
    utf8_length(value)?;
    Ok(())
}

fn utf8_length(value: &JsString) -> Result<usize, JsError> {
    let units = value.as_units();
    let mut bytes = 0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if (0xd800..=0xdbff).contains(&unit) {
            let Some(next) = units.get(index + 1) else {
                return Err(type_error("Session Unicode scalar"));
            };
            if !(0xdc00..=0xdfff).contains(next) {
                return Err(type_error("Session Unicode scalar"));
            }
            bytes += 4;
            index += 2;
        } else if (0xdc00..=0xdfff).contains(&unit) {
            return Err(type_error("Session Unicode scalar"));
        } else {
            bytes += if unit < 128 {
                1
            } else if unit < 2_048 {
                2
            } else {
                3
            };
            index += 1;
        }
    }
    Ok(bytes)
}

fn clock_minutes(value: &str) -> Result<i32, JsError> {
    let [h1, h2, b':', m1, m2] = *value.as_bytes() else {
        return Err(type_error("Session HH:mm clock"));
    };
    if !h1.is_ascii_digit() || !h2.is_ascii_digit() || !m1.is_ascii_digit() || !m2.is_ascii_digit()
    {
        return Err(type_error("Session HH:mm clock"));
    }
    let hour = i32::from((h1 - b'0') * 10 + h2 - b'0');
    let minute = i32::from((m1 - b'0') * 10 + m2 - b'0');
    if hour > 23 || minute > 59 {
        return Err(type_error("Session HH:mm clock"));
    }
    Ok(hour * 60 + minute)
}

fn session_clock(value: &JsValue) -> Result<(String, i32), JsError> {
    let JsValue::String(value) = value else {
        return Err(type_error("Session HH:mm clock"));
    };
    let value = value.to_string_lossy();
    let minutes = clock_minutes(&value)?;
    Ok((value, minutes))
}

fn session_date(value: &str) -> Result<(), JsError> {
    let [y1, y2, y3, y4, b'-', m1, m2, b'-', d1, d2] = *value.as_bytes() else {
        return Err(type_error("Session ISO date"));
    };
    let digits = [y1, y2, y3, y4, m1, m2, d1, d2];
    if digits.iter().any(|digit| !digit.is_ascii_digit()) {
        return Err(type_error("Session ISO date"));
    }
    let year = i32::from(y1 - b'0') * 1_000
        + i32::from(y2 - b'0') * 100
        + i32::from(y3 - b'0') * 10
        + i32::from(y4 - b'0');
    let month = u32::from((m1 - b'0') * 10 + m2 - b'0');
    let day = u32::from((d1 - b'0') * 10 + d2 - b'0');
    if !(1..=12).contains(&month) || day == 0 || day > month_days(year, month) {
        return Err(type_error("Session ISO date"));
    }
    Ok(())
}

fn month_days(year: i32, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn weekday(date: &str) -> Result<u8, JsError> {
    session_date(date)?;
    let year = date[0..4]
        .parse::<i64>()
        .map_err(|_| type_error("Session ISO date"))?;
    let month = date[5..7]
        .parse::<u32>()
        .map_err(|_| type_error("Session ISO date"))?;
    let day = date[8..10]
        .parse::<u32>()
        .map_err(|_| type_error("Session ISO date"))?;
    Ok((days_from_civil(year, month, day) + 4).rem_euclid(7) as u8)
}

fn reject_reserved(object: &JsObject, label: &str) -> Result<(), JsError> {
    for key in object.iter().map(|(key, _)| key) {
        if ["__proto__", "constructor", "prototype"]
            .iter()
            .any(|reserved| text_eq(key, reserved))
        {
            return Err(type_error(&format!(
                "{label}: unsupported field {}",
                key.slice(0, Some(64)).to_string_lossy()
            )));
        }
    }
    Ok(())
}

fn safe_time(value: f64) -> bool {
    value.is_finite()
        && value.fract() == 0.0
        && value.abs() <= 8_640_000_000_000_000.0
        && value.abs() <= 9_007_199_254_740_991.0
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn checkpoint_error() -> JsError {
    type_error("Session indicator checkpoint")
}
