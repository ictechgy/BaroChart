//! JS 날짜 의미: `Date.UTC`, TimeClip, `Date.prototype.toISOString`, 그레고리력 변환, M0 시간대 계약 v1의 엄격 파서
//! (이식 지도 §3.5.3, §5 규칙 10·32, M0 계획 Task 2).
//!
//! - 시각 값은 1970-01-01T00:00:00Z부터의 밀리초(f64 정수)이고 범위는 ±8.64e15(±1억 일)다.
//! - `Date.UTC`는 ECMA-262 MakeDay·MakeTime·MakeDate·TimeClip을 식 모양 그대로 옮긴다. 곱셈과 덧셈은
//!   명세 순서대로 왼쪽부터 하고 FMA를 쓰지 않는다(이식 지도 §3.1.1).
//! - 그레고리력은 proleptic(1582년 이전에도 같은 규칙)이고 0년이 있다(1년 전이 0년, 그 전이 -1년).
//! - 엄격 파서는 `Date.parse`를 쓰지 않는다. 엔진마다 `2026-02-30`을 다르게 다루기 때문이다(JSC는 NaN,
//!   V8·QuickJS는 3월 2일로 넘긴다). 코어의 `zonedEpoch`·`shiftDate`가 이 파서와 `date_utc`를 쓴다.

/// 하루의 밀리초
const MS_PER_DAY: f64 = 86_400_000.0;

/// 한 시간의 밀리초
const MS_PER_HOUR: f64 = 3_600_000.0;

/// 일 분의 밀리초
const MS_PER_MINUTE: f64 = 60_000.0;

/// 일 초의 밀리초
const MS_PER_SECOND: f64 = 1_000.0;

/// 시각 값의 절댓값 상한(ECMA-262 TimeClip): 1억 일
const MAX_TIME_VALUE: f64 = 8.64e15;

/// 시각 값 범위가 걸치는 가장 이른 연도(-271821-04-20)
const MIN_TIME_YEAR: f64 = -271_821.0;

/// 시각 값 범위가 걸치는 가장 늦은 연도(+275760-09-13)
const MAX_TIME_YEAR: f64 = 275_760.0;

/// 0000-03-01부터 1970-01-01까지의 일수(3월에 시작하는 해로 세는 그레고리력 변환의 기준점)
const DAYS_FROM_MARCH_ZERO_TO_EPOCH: i128 = 719_468;

/// 그레고리력 400년 주기의 일수
const DAYS_PER_ERA: i128 = 146_097;

/// `toISOString`이 4자리로 쓰는 연도 범위의 끝(0~9999년)
const MAX_FOUR_DIGIT_YEAR: i64 = 9999;

/// M0 시간대 계약 v1이 받는 연도 범위
const CONTRACT_YEARS: std::ops::RangeInclusive<u32> = 1000..=9999;

/// ECMA-262 TimeClip(`new Date(ms).getTime()`).
///
/// 비유한 수와 `|ms| > 8.64e15`는 NaN이다. 나머지는 0 쪽으로 버린 정수이고, -0은 +0이 된다(`new Date(-0.5)`는 0).
pub fn time_clip(ms: f64) -> f64 {
    if !ms.is_finite() || ms.abs() > MAX_TIME_VALUE {
        return f64::NAN;
    }
    to_integer(ms)
}

/// 그레고리력 날짜를 1970-01-01부터의 일수로 바꾼다(Howard Hinnant의 `days_from_civil`).
///
/// - `month`·`day`는 `Date.UTC`처럼 넘친 만큼 이어서 센다: 13월은 다음 해 1월, 0월은 전해 12월,
///   0일은 전달의 마지막 날, 2월 30일은 3월 1일 또는 2일이다.
/// - 계산은 128비트로 하므로 넘치지 않는다. 결과가 i64를 넘는 극단적인 연도(약 ±2.5e16년 밖)만 i64 끝값에 붙는다.
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    // 넘친 달을 연도로 옮긴다(month 0 → 전해 12월)
    let month_index = i128::from(month) - 1;
    let year = i128::from(year) + month_index.div_euclid(12);
    let month = month_index.rem_euclid(12) + 1;
    // 3월에 시작하는 해로 센다. 그러면 윤일(2월 29일)이 해의 끝에 와서 식이 단순해진다
    let march_year = if month <= 2 { year - 1 } else { year };
    let era = march_year.div_euclid(400);
    let year_of_era = march_year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + i128::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * DAYS_PER_ERA + day_of_era - DAYS_FROM_MARCH_ZERO_TO_EPOCH;
    i64::try_from(days).unwrap_or(if days < 0 { i64::MIN } else { i64::MAX })
}

/// 1970-01-01부터의 일수를 그레고리력 날짜 `(연, 월, 일)`로 바꾼다(Howard Hinnant의 `civil_from_days`).
///
/// 모든 i64 일수를 받는다. 월은 1..=12, 일은 그 달의 실제 날짜다. `days_from_civil`의 역이다.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = i128::from(days) + DAYS_FROM_MARCH_ZERO_TO_EPOCH;
    let era = shifted.div_euclid(DAYS_PER_ERA);
    let day_of_era = shifted - era * DAYS_PER_ERA;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = if march_month < 10 {
        march_month + 3
    } else {
        march_month - 9
    };
    let year = year_of_era + era * 400 + i128::from(month <= 2);
    // |days| <= 2^63이면 |year| < 2.6e16이라 i64에 들어간다. 월(1..=12)과 일(1..=31)은 u32에 들어간다
    (
        i64::try_from(year).unwrap_or(if year < 0 { i64::MIN } else { i64::MAX }),
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

/// ECMA-262 `Date.UTC(year, month0, day, hour, minute, second, ms)`(인자 일곱 개를 모두 준 경우).
///
/// - 각 인자를 0 쪽으로 버리고, 버린 연도가 0~99면 1900을 더한다(`Date.UTC(99, 0)`은 1999년).
/// - 달과 날은 넘친 만큼 이어서 센다. 시·분·초·밀리초는 명세 순서 `((h·3600000 + m·60000) + s·1000) + ms`로 더한다.
/// - 결과는 TimeClip을 거친다. 비유한 인자나 범위 밖 결과는 NaN이다.
/// - 달을 연도로 접은 연도가 시각 값 범위(-271821~275760년) 밖이면 NaN이다. QuickJS와 같은 규칙이다
///   (V8은 연도 ±1,000,000까지, JSC는 더 넓게 계산해 큰 시간 보정으로 범위 안에 돌아오는 병적인 입력에서
///   값을 낸다. 2026-11-02 실측). 코어는 연도 1000~9999만 넘기므로 이 차이가 드러나지 않는다.
pub fn date_utc(
    year: f64,
    month0: f64,
    day: f64,
    hour: f64,
    minute: f64,
    second: f64,
    ms: f64,
) -> f64 {
    let day_number = make_day(make_full_year(year), month0, day);
    time_clip(make_date(day_number, make_time(hour, minute, second, ms)))
}

/// ECMA-262 `Date.prototype.toISOString()`. `new Date(ms).toISOString()`과 같다.
///
/// - `ms`는 먼저 TimeClip을 거친다(`-1.5` → `-1` → `1969-12-31T23:59:59.999Z`).
/// - 0~9999년은 `YYYY`, 그 밖은 부호와 6자리(`+275760`, `-000001`)다.
/// - 범위 밖이나 NaN이면 JS는 RangeError를 던진다. 문구가 엔진마다 다르므로(이식 지도 §4.13) `None`을 돌려주고
///   호출자가 오류를 정한다.
pub fn to_iso_string(ms: f64) -> Option<String> {
    let time = time_clip(ms);
    if time.is_nan() {
        return None;
    }
    // TimeClip 결과는 ±8.64e15 안의 정수라 i64로 정확히 바뀐다
    let time = time as i64;
    let ms_per_day = MS_PER_DAY as i64;
    let (year, month, day) = civil_from_days(time.div_euclid(ms_per_day));
    let ms_of_day = time.rem_euclid(ms_per_day);
    let hour = ms_of_day / 3_600_000;
    let minute = ms_of_day / 60_000 % 60;
    let second = ms_of_day / 1_000 % 60;
    let millisecond = ms_of_day % 1_000;
    let year_text = if (0..=MAX_FOUR_DIGIT_YEAR).contains(&year) {
        format!("{year:04}")
    } else {
        let sign = if year < 0 { '-' } else { '+' };
        format!("{sign}{:06}", year.unsigned_abs())
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z"
    ))
}

/// M0 시간대 계약 v1의 날짜 파서: `^(\d{4})-(\d{2})-(\d{2})$`, 연도 1000~9999, 월 1~12, 일은 그 달의 실제 날짜.
///
/// `\d`는 ASCII 숫자만이다(비유니코드 정규식). 맞지 않으면 `None`이고, 호출자가 계약의 TypeError 문구를 낸다.
/// - 반환: `(연, 월, 일)`
pub fn parse_iso_date(s: &str) -> Option<(i32, u32, u32)> {
    let &[y1, y2, y3, y4, b'-', m1, m2, b'-', d1, d2] = s.as_bytes() else {
        return None;
    };
    let year = decimal(&[y1, y2, y3, y4])?;
    let month = decimal(&[m1, m2])?;
    let day = decimal(&[d1, d2])?;
    if !CONTRACT_YEARS.contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    if day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some((i32::try_from(year).ok()?, month, day))
}

/// M0 시간대 계약 v1의 시각 파서: `^(\d{2}):(\d{2})(?::(\d{2}))?$`, 시 0~23, 분·초 0~59. 초가 없으면 0이다.
///
/// `24:00`과 소수 초는 받지 않는다. 맞지 않으면 `None`이다.
/// - 반환: `(시, 분, 초)`
pub fn parse_iso_clock(s: &str) -> Option<(u32, u32, u32)> {
    let (hour, minute, second) = match *s.as_bytes() {
        [h1, h2, b':', m1, m2] => (decimal(&[h1, h2])?, decimal(&[m1, m2])?, 0),
        [h1, h2, b':', m1, m2, b':', s1, s2] => (
            decimal(&[h1, h2])?,
            decimal(&[m1, m2])?,
            decimal(&[s1, s2])?,
        ),
        _ => return None,
    };
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some((hour, minute, second))
}

/// ECMA-262 ToIntegerOrInfinity의 유한한 경우: 0 쪽으로 버리고 -0을 +0으로 바꾼다(`+ 0.0`).
///
/// 호출자가 비유한 수를 먼저 거른다(NaN이면 NaN, ±Infinity면 그대로다).
fn to_integer(x: f64) -> f64 {
    x.trunc() + 0.0
}

/// ECMA-262 MakeFullYear: NaN은 NaN, 0 쪽으로 버린 값이 0~99면 1900을 더하고, 아니면 받은 값 그대로다.
///
/// - `year`: `Date.UTC`의 첫 인자
fn make_full_year(year: f64) -> f64 {
    if year.is_nan() {
        return f64::NAN;
    }
    let truncated = year.trunc() + 0.0;
    if (0.0..=99.0).contains(&truncated) {
        1900.0 + truncated
    } else {
        year
    }
}

/// ECMA-262 MakeDay(year, month, date): 그 해 그 달 1일의 일수에 `date - 1`을 더한다.
///
/// 달을 연도로 접는 식은 QuickJS와 같다: `ym = y + floor(m / 12)`, `mn = m mod 12`(음이 아닌 나머지).
/// `ym`이 시각 값 범위의 연도 밖이면 그런 날짜의 시각 값이 없으므로 NaN이다.
/// 마지막 덧셈은 명세 순서 `(day + dt) - 1`이다.
fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !(year.is_finite() && month.is_finite() && date.is_finite()) {
        return f64::NAN;
    }
    let year = to_integer(year);
    let month = to_integer(month);
    let date = to_integer(date);
    let folded_year = year + (month / 12.0).floor();
    if !(MIN_TIME_YEAR..=MAX_TIME_YEAR).contains(&folded_year) {
        return f64::NAN;
    }
    let month_in_year = month % 12.0;
    let month_in_year = if month_in_year < 0.0 {
        month_in_year + 12.0
    } else {
        month_in_year
    };
    // folded_year는 범위를 확인한 정수, month_in_year는 0..=11인 정수라 변환이 정확하다
    let first_day = days_from_civil(folded_year as i64, month_in_year as u32 + 1, 1);
    (first_day as f64 + date) - 1.0
}

/// ECMA-262 MakeTime(hour, min, sec, ms): 각 값을 0 쪽으로 버린 뒤 `((h·3600000 + m·60000) + s·1000) + ms`.
fn make_time(hour: f64, minute: f64, second: f64, ms: f64) -> f64 {
    if !(hour.is_finite() && minute.is_finite() && second.is_finite() && ms.is_finite()) {
        return f64::NAN;
    }
    let hours = to_integer(hour) * MS_PER_HOUR;
    let minutes = to_integer(minute) * MS_PER_MINUTE;
    let seconds = to_integer(second) * MS_PER_SECOND;
    ((hours + minutes) + seconds) + to_integer(ms)
}

/// ECMA-262 MakeDate(day, time): `day × 86400000 + time`. 비유한 값이면 NaN이다.
fn make_date(day: f64, time: f64) -> f64 {
    if !(day.is_finite() && time.is_finite()) {
        return f64::NAN;
    }
    let date = day * MS_PER_DAY + time;
    if date.is_finite() { date } else { f64::NAN }
}

/// 그 해 그 달의 날 수(그레고리력 윤년 규칙).
///
/// - `year`: 연도
/// - `month`: 1..=12
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// ASCII 십진 숫자열을 읽는다. 숫자가 아닌 바이트가 있으면 `None`이다.
///
/// - `digits`: 몇 자리의 바이트(4자리까지 쓰므로 넘치지 않는다)
fn decimal(digits: &[u8]) -> Option<u32> {
    digits.iter().try_fold(0_u32, |value, &digit| {
        digit
            .is_ascii_digit()
            .then(|| value * 10 + u32::from(digit - b'0'))
    })
}
