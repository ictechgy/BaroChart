//! 시장 시각·시간대·세션 달력 계약이다.
//!
//! 시간대 데이터베이스를 코어에 넣지 않고 [`Host`]의 이름 해석과 시점별 오프셋을 빌린다.
//! 고정 오프셋은 코어가 직접 계산하며, 날짜·시각 산술은 `barochart-js`의 ECMA 날짜 원시 연산을 쓴다.

use std::collections::VecDeque;
use std::sync::Arc;

use barochart_js::date::{
    date_utc, days_from_civil, parse_iso_clock, parse_iso_date, time_clip, to_iso_string,
};
use barochart_js::error::JsError;
use barochart_js::num::{NumberDialect, to_fixed_with};
use barochart_js::string::JsString;

use crate::Host;

const MARKET_TIME_MIN: f64 = -30_610_310_400_000.0;
const MARKET_TIME_MAX: f64 = 253_402_387_199_999.0;
const MS_PER_HOUR: f64 = 3_600_000.0;
const MS_PER_DAY: f64 = 86_400_000.0;

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn unsupported_zone(zone: &JsString) -> JsError {
    let prefix = "Unsupported time zone: ";
    let mut units = Vec::with_capacity(prefix.encode_utf16().count() + 64);
    units.extend(prefix.encode_utf16());
    units.extend(zone.as_units().iter().copied().take(64));
    JsError::new("RangeError", JsString::from_utf16(units))
}

/// 시간대가 적용된 그레고리력 성분이다. 키/필드 순서는 JS 계약과 같다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZonedParts {
    /// 4자리 지원 연도다.
    pub year: String,
    /// 2자리 월이다.
    pub month: String,
    /// 2자리 일이다.
    pub day: String,
    /// 2자리 시다.
    pub hour: String,
    /// 2자리 분이다.
    pub minute: String,
    /// 2자리 초다.
    pub second: String,
}

impl ZonedParts {
    /// 테스트·직렬화 순서대로 문자열 조각을 돌려준다.
    pub fn as_array(&self) -> [&str; 6] {
        [
            &self.year,
            &self.month,
            &self.day,
            &self.hour,
            &self.minute,
            &self.second,
        ]
    }

    fn local_epoch(&self) -> f64 {
        date_utc(
            self.year.parse().unwrap_or(f64::NAN),
            self.month.parse::<f64>().unwrap_or(f64::NAN) - 1.0,
            self.day.parse().unwrap_or(f64::NAN),
            self.hour.parse().unwrap_or(f64::NAN),
            self.minute.parse().unwrap_or(f64::NAN),
            self.second.parse().unwrap_or(f64::NAN),
            0.0,
        )
    }

    fn wall_clock(&self) -> String {
        format!(
            "{}-{}-{}T{}:{}:{}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

fn parts_from_local_epoch(local_epoch: f64) -> Result<ZonedParts, JsError> {
    let Some(iso) = to_iso_string(local_epoch) else {
        return Err(range_error("Time zone conversion year out of range"));
    };
    let bytes = iso.as_bytes();
    if bytes.len() < 19 || !bytes[0].is_ascii_digit() {
        return Err(range_error("Time zone conversion year out of range"));
    }
    let year = iso[0..4].parse::<u32>().unwrap_or(0);
    if !(1000..=9999).contains(&year) {
        return Err(range_error("Time zone conversion year out of range"));
    }
    Ok(ZonedParts {
        year: iso[0..4].to_owned(),
        month: iso[5..7].to_owned(),
        day: iso[8..10].to_owned(),
        hour: iso[11..13].to_owned(),
        minute: iso[14..16].to_owned(),
        second: iso[17..19].to_owned(),
    })
}

fn ascii_lower(unit: u16) -> u16 {
    if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
        unit + u16::from(b'a' - b'A')
    } else {
        unit
    }
}

fn is_zone_char(unit: u16, first: bool) -> bool {
    is_ascii_alpha(unit) || !first && (is_ascii_digit(unit) || matches!(unit, 0x5f | 0x2b | 0x2d))
}

fn is_ascii_alpha(unit: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&unit)
        || (u16::from(b'a')..=u16::from(b'z')).contains(&unit)
}

fn is_ascii_digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

fn valid_named_zone(zone: &JsString) -> bool {
    let units = zone.as_units();
    let mut segment_start = true;
    for (index, &unit) in units.iter().enumerate() {
        if unit == u16::from(b'/') {
            if segment_start {
                return false;
            }
            segment_start = true;
        } else if !is_zone_char(unit, index == 0) {
            return false;
        } else {
            segment_start = false;
        }
    }
    !segment_start
}

fn host_only_zone(zone: &JsString) -> bool {
    let lower: Vec<u16> = zone.as_units().iter().copied().map(ascii_lower).collect();
    let z = [u16::from(b'z')];
    let ut = [u16::from(b'u'), u16::from(b't')];
    if lower == z || lower == ut {
        return true;
    }
    for prefix in [b"utc".as_slice(), b"gmt".as_slice(), b"ut".as_slice()] {
        if lower.len() > prefix.len()
            && lower[..prefix.len()]
                .iter()
                .copied()
                .eq(prefix.iter().copied().map(u16::from))
            && matches!(lower[prefix.len()], 0x2b | 0x2d)
        {
            return true;
        }
    }
    false
}

fn fixed_offset_minutes(zone: &JsString) -> Option<i32> {
    let [sign, h1, h2, colon, m1, m2] = *zone.as_units() else {
        return None;
    };
    if !matches!(sign, 0x2b | 0x2d)
        || colon != 0x3a
        || !is_ascii_digit(h1)
        || !is_ascii_digit(h2)
        || !is_ascii_digit(m1)
        || !is_ascii_digit(m2)
    {
        return None;
    }
    let hour = i32::from((h1 - 0x30) * 10 + h2 - 0x30);
    let minute = i32::from((m1 - 0x30) * 10 + m2 - 0x30);
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour * 60 + minute) * if sign == 0x2d { -1 } else { 1 })
}

/// 이름 있는 시간대의 표준 이름을 ASCII 대소문자 무시 키로 최대 32개 보관한다.
///
/// 성공한 해석만 LRU로 갱신한다. 고정 오프셋과 문법에서 거절한 이름은 캐시에 들어가지 않는다.
#[derive(Default)]
pub struct TimeZoneCache {
    names: VecDeque<(Vec<u16>, JsString)>,
}

impl TimeZoneCache {
    /// 캐시에 든 표준 이름 수다.
    pub fn len(&self) -> usize {
        self.names.len()
    }

    /// 캐시가 비었는지 본다.
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    fn key(timezone: &JsString) -> Vec<u16> {
        timezone
            .as_units()
            .iter()
            .copied()
            .map(ascii_lower)
            .collect()
    }

    fn lookup(&self, timezone: &JsString) -> Option<JsString> {
        let key = Self::key(timezone);
        self.names
            .iter()
            .find(|(candidate, _)| candidate == &key)
            .map(|(_, canonical)| canonical.clone())
    }

    fn commit(&mut self, timezone: &JsString, canonical: JsString) {
        let key = Self::key(timezone);
        if let Some(index) = self
            .names
            .iter()
            .position(|(candidate, _)| candidate == &key)
        {
            self.names.remove(index);
        }
        self.names.push_back((key, canonical));
        if self.names.len() > 32 {
            self.names.pop_front();
        }
    }
}

/// UTC epoch 밀리초를 시간대의 지역 성분으로 바꾼다.
///
/// 이름·유한성·지원 범위를 코어에서 검사한다. 소수 밀리초는 TimeClip으로 0 쪽으로 자른 뒤에만
/// 호스트의 이름 해석과 오프셋 콜백으로 전달한다.
pub fn zoned_parts(host: &dyn Host, time: f64, timezone: &JsString) -> Result<ZonedParts, JsError> {
    zoned_parts_cached(host, time, timezone, &mut TimeZoneCache::default())
}

/// [`zoned_parts`]와 같지만 성공한 이름 해석을 제한된 호출자 소유 캐시에 재사용한다.
pub fn zoned_parts_cached(
    host: &dyn Host,
    time: f64,
    timezone: &JsString,
    cache: &mut TimeZoneCache,
) -> Result<ZonedParts, JsError> {
    if timezone.as_units().is_empty() || timezone.len_utf16() > 128 {
        return Err(type_error(
            "Timezone string, at most 128 characters required",
        ));
    }
    if !time.is_finite() {
        return Err(range_error("Time zone conversion requires a finite time"));
    }
    if !(MARKET_TIME_MIN..=MARKET_TIME_MAX).contains(&time) {
        return Err(range_error("Time zone conversion year out of range"));
    }
    let clipped = time_clip(time);
    let offset_seconds = if let Some(offset) = fixed_offset_minutes(timezone) {
        offset * 60
    } else {
        if !valid_named_zone(timezone) || host_only_zone(timezone) {
            return Err(unsupported_zone(timezone));
        }
        let canonical = match cache.lookup(timezone) {
            Some(canonical) => canonical,
            None => host
                .zone_resolve(timezone)
                .map_err(|_| unsupported_zone(timezone))?,
        };
        let offset = host
            .zone_offset_seconds(&canonical, clipped)
            .map_err(|_| unsupported_zone(timezone))?;
        cache.commit(timezone, canonical);
        offset
    };
    parts_from_local_epoch(clipped + f64::from(offset_seconds) * 1000.0)
}

/// UTC 시각의 시장 지역 날짜를 `YYYY-MM-DD`로 돌려준다.
pub fn market_date(host: &dyn Host, time: f64, timezone: &JsString) -> Result<String, JsError> {
    let parts = zoned_parts(host, time, timezone)?;
    Ok(format!("{}-{}-{}", parts.year, parts.month, parts.day))
}

fn market_date_cached(
    host: &dyn Host,
    time: f64,
    timezone: &JsString,
    cache: &mut TimeZoneCache,
) -> Result<String, JsError> {
    let parts = zoned_parts_cached(host, time, timezone, cache)?;
    Ok(format!("{}-{}-{}", parts.year, parts.month, parts.day))
}

/// 엄격한 ISO 날짜를 그레고리력의 날짜 수만큼 옮긴다.
pub fn shift_date(date: &str, days: f64) -> Result<String, JsError> {
    let Some((year, month, day)) = parse_iso_date(date) else {
        return Err(type_error("ISO date required"));
    };
    let noon = date_utc(
        f64::from(year),
        f64::from(month - 1),
        f64::from(day),
        12.0,
        0.0,
        0.0,
        0.0,
    );
    let shifted = time_clip(noon + days * MS_PER_DAY);
    let Some(iso) = to_iso_string(shifted) else {
        return Err(range_error("Time zone conversion year out of range"));
    };
    if iso
        .as_bytes()
        .first()
        .is_none_or(|byte| !byte.is_ascii_digit())
    {
        return Err(range_error("Time zone conversion year out of range"));
    }
    let year = iso[0..4].parse::<u32>().unwrap_or(0);
    if !(1000..=9999).contains(&year) {
        return Err(range_error("Time zone conversion year out of range"));
    }
    Ok(iso[0..10].to_owned())
}

/// 지역 날짜·벽시계를 UTC epoch 밀리초로 해석한다.
///
/// 반복 시각은 `later`이면 뒤 시각, `reject`이면 오류, 그 밖에는 앞 시각을 고른다. 존재하지 않는
/// 시각의 달력용 복구는 이 함수에 적용하지 않는다.
pub fn zoned_epoch(
    host: &dyn Host,
    date: &str,
    clock: &str,
    timezone: &JsString,
    ambiguity: &str,
) -> Result<f64, JsError> {
    zoned_epoch_cached(
        host,
        date,
        clock,
        timezone,
        ambiguity,
        &mut TimeZoneCache::default(),
    )
}

fn zoned_epoch_cached(
    host: &dyn Host,
    date: &str,
    clock: &str,
    timezone: &JsString,
    ambiguity: &str,
    cache: &mut TimeZoneCache,
) -> Result<f64, JsError> {
    let (Some((year, month, day)), Some((hour, minute, second))) =
        (parse_iso_date(date), parse_iso_clock(clock))
    else {
        return Err(type_error("ISO date and HH:mm[:ss] required"));
    };
    let naive = date_utc(
        f64::from(year),
        f64::from(month - 1),
        f64::from(day),
        f64::from(hour),
        f64::from(minute),
        f64::from(second),
        0.0,
    );
    let expected = format!(
        "{date}T{}",
        if clock.len() == 5 {
            format!("{clock}:00")
        } else {
            clock.to_owned()
        }
    );
    let mut offsets = Vec::with_capacity(3);
    for day_offset in [-1.0, 0.0, 1.0] {
        let sample = naive + day_offset * MS_PER_DAY;
        let offset = zoned_parts_cached(host, sample, timezone, cache)?.local_epoch() - sample;
        if !offsets.contains(&offset) {
            offsets.push(offset);
        }
    }
    let mut candidates = Vec::with_capacity(offsets.len());
    for offset in offsets {
        let candidate = naive - offset;
        if zoned_parts_cached(host, candidate, timezone, cache)?.wall_clock() == expected {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| left.total_cmp(right));
    if candidates.is_empty() {
        return Err(range_error("Nonexistent local time at DST boundary"));
    }
    if candidates.len() > 1 && ambiguity == "reject" {
        return Err(range_error("Ambiguous local time"));
    }
    Ok(if ambiguity == "later" {
        *candidates.last().unwrap_or(&candidates[0])
    } else {
        candidates[0]
    })
}

/// 가격 조정 방식이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adjustment {
    /// 원시 가격이다.
    Raw,
    /// 주식 분할 조정 가격이다.
    Split,
    /// 배당 포함 총수익 조정 가격이다.
    TotalReturn,
}

/// 시장 심볼 메타데이터다.
#[derive(Clone, Debug, PartialEq)]
pub struct Symbol {
    /// 심볼 식별자다.
    pub id: JsString,
    /// 거래소 식별자다.
    pub exchange: JsString,
    /// 시간대다.
    pub timezone: JsString,
    /// 가격 통화다.
    pub currency: JsString,
    /// 거래량 단위다.
    pub volume_unit: JsString,
    /// 가격 소수 자릿수다.
    pub price_decimals: u32,
    /// 최소 호가 단위다.
    pub tick_size: f64,
    /// 조정 방식이다.
    pub adjustment: Adjustment,
}

/// 심볼 메타데이터를 검증하고 시간대가 호스트에서 해석되는지 확인한다.
pub fn validate_symbol(host: &dyn Host, symbol: Symbol) -> Result<Symbol, JsError> {
    if symbol.id.as_units().is_empty()
        || symbol.exchange.as_units().is_empty()
        || symbol.timezone.as_units().is_empty()
        || symbol.currency.as_units().is_empty()
        || symbol.volume_unit.as_units().is_empty()
        || symbol.price_decimals > 18
        || !symbol.tick_size.is_finite()
        || symbol.tick_size <= 0.0
    {
        return Err(type_error("Invalid symbol metadata"));
    }
    zoned_parts(host, 0.0, &symbol.timezone)?;
    Ok(symbol)
}

/// 심볼 자릿수와 플랫폼 숫자 방언으로 가격을 `toFixed` 형식으로 쓴다.
pub fn format_price(value: f64, symbol: &Symbol, dialect: NumberDialect) -> String {
    to_fixed_with(value, symbol.price_decimals, dialect)
}

/// 세션 공급자가 내는 벽시계 창이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionWindowInput {
    /// 여는 시각(`HH:mm` 또는 `HH:mm:ss`)이다.
    pub open: String,
    /// 닫는 시각(`HH:mm` 또는 `HH:mm:ss`)이다.
    pub close: String,
    /// 세션 종류다.
    pub kind: JsString,
}

impl SessionWindowInput {
    /// 세션 창 입력을 만든다.
    pub fn new(open: &str, close: &str, kind: &str) -> Self {
        Self {
            open: open.to_owned(),
            close: close.to_owned(),
            kind: JsString::from_str(kind),
        }
    }
}

/// 날짜별 세션 창 공급자다.
pub trait CalendarProvider {
    /// 지정한 지역 날짜의 세션 창을 제공한다.
    fn windows(&mut self, date: &str) -> Result<Vec<SessionWindowInput>, JsError>;
}

impl<F> CalendarProvider for F
where
    F: FnMut(&str) -> Result<Vec<SessionWindowInput>, JsError>,
{
    fn windows(&mut self, date: &str) -> Result<Vec<SessionWindowInput>, JsError> {
        self(date)
    }
}

/// UTC로 해석한 세션 창이다.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    /// 창의 지역 날짜다.
    pub date: String,
    /// 세션 종류다.
    pub kind: JsString,
    /// 포함되는 시작 UTC epoch 밀리초다.
    pub open: f64,
    /// 포함되지 않는 종료 UTC epoch 밀리초다.
    pub close: f64,
}

/// 달력 bucket의 시작과 소속 세션이다.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionBucket {
    /// bucket 시작 UTC epoch 밀리초다.
    pub time: f64,
    /// 실제 세션의 지역 날짜다.
    pub session_date: String,
    /// 실제 세션 종류다.
    pub kind: JsString,
}

/// 세션 bucket 간격이다. 이름은 JS 입력 오류를 보존하려고 별도 값으로 받는다.
#[derive(Clone, Debug, PartialEq)]
pub enum CalendarInterval {
    /// 양의 유한 밀리초 간격이다.
    Milliseconds(f64),
    /// 지역 날짜 시작이다.
    Day,
    /// 월요일 지역 날짜 시작이다.
    Week,
    /// 지역 월 시작이다.
    Month,
    /// 지원 여부를 검사할 이름 입력이다.
    Named(JsString),
}

/// 날짜별 세션과 지역 날짜 anchor를 FIFO로 제한해 보관하는 달력이다.
pub struct SessionCalendar<P: CalendarProvider> {
    timezone: JsString,
    provider: P,
    max_cached_days: usize,
    sessions: VecDeque<(String, Arc<[Session]>)>,
    anchors: VecDeque<(String, f64)>,
    timezones: TimeZoneCache,
}

impl<P: CalendarProvider> SessionCalendar<P> {
    /// 공급자와 양의 캐시 크기를 검증해 달력을 만든다.
    pub fn new(
        host: &dyn Host,
        timezone: JsString,
        provider: P,
        max_cached_days: usize,
    ) -> Result<Self, JsError> {
        if max_cached_days == 0 {
            return Err(type_error(
                "Calendar provider and positive cache size required",
            ));
        }
        let mut timezones = TimeZoneCache::default();
        zoned_parts_cached(host, 0.0, &timezone, &mut timezones)?;
        Ok(Self {
            timezone,
            provider,
            max_cached_days,
            sessions: VecDeque::new(),
            anchors: VecDeque::new(),
            timezones,
        })
    }

    /// 테스트·호스트 통합에서 공급자 상태를 읽는다.
    pub fn provider(&self) -> &P {
        &self.provider
    }

    /// 세션과 anchor 캐시를 비운다.
    pub fn invalidate(&mut self) {
        self.sessions.clear();
        self.anchors.clear();
    }

    /// 날짜의 UTC 세션을 계산하고 같은 `Arc`를 FIFO 캐시에 보관한다.
    pub fn sessions(&mut self, host: &dyn Host, date: &str) -> Result<Arc<[Session]>, JsError> {
        if let Some((_, sessions)) = self.sessions.iter().find(|(key, _)| key == date) {
            return Ok(Arc::clone(sessions));
        }
        let inputs = self.provider.windows(date)?;
        let mut windows = Vec::with_capacity(inputs.len());
        let mut previous_close = None;
        for input in inputs {
            let open_clock = normalized_clock(&input.open)?;
            let close_clock = normalized_clock(&input.close)?;
            let close_date = if close_clock <= open_clock {
                shift_date(date, 1.0)?
            } else {
                date.to_owned()
            };
            let open = zoned_epoch_cached(
                host,
                date,
                &input.open,
                &self.timezone,
                "earlier",
                &mut self.timezones,
            )?;
            let close = zoned_epoch_cached(
                host,
                &close_date,
                &input.close,
                &self.timezone,
                "earlier",
                &mut self.timezones,
            )?;
            if close <= open || previous_close.is_some_and(|previous| open < previous) {
                return Err(range_error("Ordered nonoverlapping sessions required"));
            }
            previous_close = Some(close);
            windows.push(Session {
                date: date.to_owned(),
                kind: input.kind,
                open,
                close,
            });
        }
        let windows: Arc<[Session]> = windows.into();
        self.sessions
            .push_back((date.to_owned(), Arc::clone(&windows)));
        if self.sessions.len() > self.max_cached_days {
            self.sessions.pop_front();
        }
        Ok(windows)
    }

    /// 시각을 포함하는 첫 허용 세션을 찾는다.
    pub fn at(
        &mut self,
        host: &dyn Host,
        time: f64,
        kinds: &[JsString],
    ) -> Result<Option<Session>, JsError> {
        let date = market_date_cached(host, time, &self.timezone, &mut self.timezones)?;
        let previous_date = shift_date(&date, -1.0)?;
        let previous = self.sessions(host, &previous_date)?;
        let current = self.sessions(host, &date)?;
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

    /// 시각이 속한 세션의 밀리초 또는 지역 일·주·월 bucket을 구한다.
    pub fn bucket(
        &mut self,
        host: &dyn Host,
        time: f64,
        interval: &CalendarInterval,
        kinds: &[JsString],
    ) -> Result<Option<SessionBucket>, JsError> {
        let Some(session) = self.at(host, time, kinds)? else {
            return Ok(None);
        };
        let bucket_time = match interval {
            CalendarInterval::Milliseconds(interval) if interval.is_finite() && *interval > 0.0 => {
                session.open + ((time - session.open) / interval).floor() * interval
            }
            CalendarInterval::Day => self.local_date_anchor(host, &session.date)?,
            CalendarInterval::Week => {
                let (year, month, day) =
                    parse_iso_date(&session.date).ok_or_else(|| type_error("ISO date required"))?;
                let weekday = (days_from_civil(i64::from(year), month, day) + 4).rem_euclid(7);
                let monday = shift_date(
                    &session.date,
                    -f64::from((weekday + 6).rem_euclid(7) as i32),
                )?;
                self.local_date_anchor(host, &monday)?
            }
            CalendarInterval::Month => {
                let month = format!("{}-01", &session.date[..7]);
                self.local_date_anchor(host, &month)?
            }
            CalendarInterval::Named(name)
                if name.as_units() == "day".encode_utf16().collect::<Vec<_>>() =>
            {
                self.local_date_anchor(host, &session.date)?
            }
            CalendarInterval::Named(name)
                if name.as_units() == "week".encode_utf16().collect::<Vec<_>>() =>
            {
                let (year, month, day) =
                    parse_iso_date(&session.date).ok_or_else(|| type_error("ISO date required"))?;
                let weekday = (days_from_civil(i64::from(year), month, day) + 4).rem_euclid(7);
                let monday = shift_date(
                    &session.date,
                    -f64::from((weekday + 6).rem_euclid(7) as i32),
                )?;
                self.local_date_anchor(host, &monday)?
            }
            CalendarInterval::Named(name)
                if name.as_units() == "month".encode_utf16().collect::<Vec<_>>() =>
            {
                let month = format!("{}-01", &session.date[..7]);
                self.local_date_anchor(host, &month)?
            }
            _ => return Err(type_error("Interval is milliseconds/day/week/month")),
        };
        Ok(Some(SessionBucket {
            time: bucket_time,
            session_date: session.date,
            kind: session.kind,
        }))
    }

    /// 지역 날짜의 첫 실제 시각을 구한다. 자정이 없는 날짜만 ±48시간 탐색으로 복구한다.
    pub fn local_date_anchor(&mut self, host: &dyn Host, date: &str) -> Result<f64, JsError> {
        if let Some((_, anchor)) = self.anchors.iter().find(|(key, _)| key == date) {
            return Ok(*anchor);
        }
        let anchor = match zoned_epoch_cached(
            host,
            date,
            "00:00",
            &self.timezone,
            "earlier",
            &mut self.timezones,
        ) {
            Ok(anchor) => anchor,
            Err(error)
                if error.name == "RangeError"
                    && error.message.to_string_lossy()
                        == "Nonexistent local time at DST boundary" =>
            {
                self.scan_date_anchor(host, date)?
            }
            Err(error) => return Err(error),
        };
        self.anchors.push_back((date.to_owned(), anchor));
        if self.anchors.len() > self.max_cached_days {
            self.anchors.pop_front();
        }
        Ok(anchor)
    }

    fn scan_date_anchor(&mut self, host: &dyn Host, date: &str) -> Result<f64, JsError> {
        let Some((year, month, day)) = parse_iso_date(date) else {
            return Err(type_error("ISO date required"));
        };
        let naive = date_utc(
            f64::from(year),
            f64::from(month - 1),
            f64::from(day),
            0.0,
            0.0,
            0.0,
            0.0,
        );
        let timezone = self.timezone.clone();
        let mut before = naive - 48.0 * MS_PER_HOUR;
        let mut after = None;
        let mut time = before + MS_PER_HOUR;
        while time <= naive + 48.0 * MS_PER_HOUR {
            if market_date_cached(host, time, &timezone, &mut self.timezones)? == date {
                after = Some(time);
                break;
            }
            before = time;
            time += MS_PER_HOUR;
        }
        let Some(mut after) = after else {
            return Err(range_error(
                "Calendar period starts on a nonexistent local date",
            ));
        };
        while after - before > 1.0 {
            let middle = before + ((after - before) / 2.0).floor();
            if market_date_cached(host, middle, &timezone, &mut self.timezones)? == date {
                after = middle;
            } else {
                before = middle;
            }
        }
        Ok(after)
    }
}

fn normalized_clock(clock: &str) -> Result<String, JsError> {
    let Some((hour, minute, second)) = parse_iso_clock(clock) else {
        return Err(type_error("ISO date and HH:mm[:ss] required"));
    };
    Ok(format!("{hour:02}:{minute:02}:{second:02}"))
}
