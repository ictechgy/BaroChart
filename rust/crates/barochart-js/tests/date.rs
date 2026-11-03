//! 날짜 커널(`date`) 고정 벡터: `Date.UTC`, TimeClip, `toISOString`, 그레고리력 변환, M0 시간대 계약 v1의 엄격 파서.
//!
//! `Date.UTC`·TimeClip·`toISOString` 기대값은 같은 JS 식을 V8(Node 22.20.0), JSC(macOS 시스템 `jsc`),
//! QuickJS(`native/android/quickjs` 2026-06-04)에서 계산해 세 엔진이 모두 같은 값을 낸 것만 넣었다(2026-11-02 실측).
//! 엔진마다 다른 한 경우는 해당 테스트에 적었다. 엄격 파서는 아직 JS 구현이 없어(M0 Task 2) 계약 문법
//! `^(\d{4})-(\d{2})-(\d{2})$`(연도 1000~9999, 실제 달력 날짜)과 `^(\d{2}):(\d{2})(?::(\d{2}))?$`(0~23시, 0~59분·초)를
//! 따른다.

use barochart_js::date::{
    civil_from_days, date_utc, days_from_civil, parse_iso_clock, parse_iso_date, time_clip,
    to_iso_string,
};

/// `parse_iso_date`의 결과: (연, 월, 일)
type IsoDate = (i32, u32, u32);

/// `parse_iso_clock`의 결과: (시, 분, 초)
type IsoClock = (u32, u32, u32);

/// 두 f64가 `Object.is` 기준으로 같은지 단언한다. +0과 -0을 가르고, NaN끼리는 같다고 본다.
///
/// - `actual`: 커널이 낸 값
/// - `expected`: JS 엔진이 낸 값
/// - `label`: 실패 문구에 넣을 원래 JS 식
#[track_caller]
fn assert_same(actual: f64, expected: f64, label: &str) {
    let same = (actual.is_nan() && expected.is_nan()) || actual.to_bits() == expected.to_bits();
    assert!(
        same,
        "{label}: expected {expected:?} (bits {:#018x}), got {actual:?} (bits {:#018x})",
        expected.to_bits(),
        actual.to_bits()
    );
}

/// `Date.UTC(y, m, d, h, min, s, ms)`: 0~99년은 1900년대, 인자는 0 쪽으로 버림, 달·날 넘침, TimeClip 범위
#[test]
fn date_utc_matches_js() {
    let two_pow_53 = 9_007_199_254_740_992.0_f64;
    let cases: &[([f64; 7], f64, &str)] = &[
        (
            [2026.0, 2.0, 9.0, 13.0, 30.0, 0.0, 0.0],
            1_773_063_000_000.0,
            "Date.UTC(2026,2,9,13,30,0,0)",
        ),
        (
            [99.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            915_148_800_000.0,
            "Date.UTC(99,0,1)",
        ),
        (
            [99.5, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            915_148_800_000.0,
            "Date.UTC(99.5,0,1)",
        ),
        (
            [-0.5, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            -2_208_988_800_000.0,
            "Date.UTC(-0.5,0,1)",
        ),
        (
            [100.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            -59_011_459_200_000.0,
            "Date.UTC(100,0,1)",
        ),
        (
            [-1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            -62_198_755_200_000.0,
            "Date.UTC(-1,0,1)",
        ),
        (
            [2026.0, 13.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            1_801_440_000_000.0,
            "Date.UTC(2026,13,1)",
        ),
        (
            [2026.0, -1.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            1_764_547_200_000.0,
            "Date.UTC(2026,-1,1)",
        ),
        (
            [2026.0, -13.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            1_733_011_200_000.0,
            "Date.UTC(2026,-13,1)",
        ),
        (
            [2026.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            1_767_139_200_000.0,
            "Date.UTC(2026,0,0)",
        ),
        (
            [2026.9, 1.9, 9.9, 13.9, 30.9, 0.9, 0.9],
            1_770_643_800_000.0,
            "Date.UTC(2026.9,1.9,9.9,13.9,30.9,0.9,0.9)",
        ),
        (
            [1970.0, 0.0, 1.0, 0.0, 0.0, 0.0, -0.9],
            0.0,
            "Date.UTC(1970,0,1,0,0,0,-0.9)",
        ),
        (
            [1970.0, 0.0, 1.0, 0.0, 0.0, 0.0, -1.5],
            -1.0,
            "Date.UTC(1970,0,1,0,0,0,-1.5)",
        ),
        (
            [1970.0, 0.0, 1.0, -0.0, -0.0, -0.0, -0.0],
            0.0,
            "Date.UTC(1970,0,1,-0,-0,-0,-0)",
        ),
        (
            [f64::NAN, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            f64::NAN,
            "Date.UTC(NaN,0,1)",
        ),
        (
            [2026.0, 0.0, 1.0, f64::INFINITY, 0.0, 0.0, 0.0],
            f64::NAN,
            "Date.UTC(2026,0,1,Infinity)",
        ),
        (
            [275_760.0, 8.0, 13.0, 0.0, 0.0, 0.0, 0.0],
            8.64e15,
            "Date.UTC(275760,8,13)",
        ),
        (
            [275_760.0, 8.0, 13.0, 0.0, 0.0, 0.0, 1.0],
            f64::NAN,
            "Date.UTC(275760,8,13,0,0,0,1)",
        ),
        (
            [-271_821.0, 3.0, 20.0, 0.0, 0.0, 0.0, 0.0],
            -8.64e15,
            "Date.UTC(-271821,3,20)",
        ),
        (
            [-271_821.0, 3.0, 19.0, 23.0, 59.0, 59.0, 999.0],
            f64::NAN,
            "Date.UTC(-271821,3,19,23,59,59,999)",
        ),
        (
            [275_760.0, 8.0, 14.0, -24.0, 0.0, 0.0, 0.0],
            8.64e15,
            "Date.UTC(275760,8,14,-24)",
        ),
        (
            [1970.0, 0.0, 1e9, -24e9, 0.0, 0.0, 0.0],
            -86_400_000.0,
            "Date.UTC(1970,0,1e9,-24e9)",
        ),
        (
            [300_000.0, -1_200_000.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            6_249_223_180_800_000.0,
            "Date.UTC(300000,-1200000,1)",
        ),
        (
            [200_000.0, -2_400_000.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            -62_167_219_200_000.0,
            "Date.UTC(200000,-2400000,1)",
        ),
        (
            [1e300, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            f64::NAN,
            "Date.UTC(1e300,0,1)",
        ),
        (
            [1970.0, 0.0, two_pow_53, 0.0, 0.0, 0.0, 0.0],
            f64::NAN,
            "Date.UTC(1970,0,9007199254740992)",
        ),
        (
            [
                1970.0,
                0.0,
                two_pow_53 + 2.0,
                -24.0 * two_pow_53,
                0.0,
                0.0,
                0.0,
            ],
            0.0,
            "Date.UTC(1970,0,9007199254740994,-24*9007199254740992)",
        ),
        (
            [1970.0, 0.0, 1.0, 1e12, 0.0, 0.0, -3.6e18],
            0.0,
            "Date.UTC(1970,0,1,1e12,0,0,-3.6e18)",
        ),
        (
            [2024.0, 1.0, 29.0, 0.0, 0.0, 0.0, 0.0],
            1_709_164_800_000.0,
            "Date.UTC(2024,1,29)",
        ),
        (
            [1000.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            -30_610_224_000_000.0,
            "Date.UTC(1000,0,1)",
        ),
        (
            [9999.0, 11.0, 31.0, 23.0, 59.0, 59.0, 999.0],
            253_402_300_799_999.0,
            "Date.UTC(9999,11,31,23,59,59,999)",
        ),
    ];
    for &([year, month, day, hour, minute, second, ms], expected, label) in cases {
        assert_same(
            date_utc(year, month, day, hour, minute, second, ms),
            expected,
            label,
        );
    }
}

/// 달을 연도로 접은 연도(ym)가 TimeClip 범위(-271821~275760년) 밖이면 시각으로 되돌아와도 NaN이다.
///
/// 엔진마다 다르다(2026-11-02 실측). QuickJS는 ym 범위를 보고 NaN을 낸다. V8은 연도 ±1,000,000과
/// 달 ±10,000,000 안이면 계산하고, JSC는 그보다 넓게 계산한다. 커널은 Android 오라클인 QuickJS 규칙을 따른다
/// (ECMA-262 MakeDay: 시각을 찾을 수 없으면 NaN). 코어는 연도 1000~9999만 넘기므로 차이가 보이지 않는다.
#[test]
fn date_utc_rejects_folded_years_outside_the_time_range() {
    let cases: &[([f64; 7], &str)] = &[
        (
            [275_761.0, 0.0, 1.0, -24_000.0, 0.0, 0.0, 0.0],
            "Date.UTC(275761,0,1,-24000): V8·JSC 8639923104000000",
        ),
        (
            [1_000_000.0, 0.0, 1.0, -8_760_000_000.0, 0.0, 0.0, 0.0],
            "Date.UTC(1000000,0,1,-8760000000): V8·JSC -41215219200000",
        ),
        (
            [
                1970.0,
                10_000_000.0,
                1.0,
                -7_304_849_999.707_807,
                0.0,
                0.0,
                0.0,
            ],
            "Date.UTC(1970,10000000,1,-7304849999.707807): V8·JSC -169200000",
        ),
    ];
    for &([year, month, day, hour, minute, second, ms], label) in cases {
        assert_same(
            date_utc(year, month, day, hour, minute, second, ms),
            f64::NAN,
            label,
        );
    }
}

/// `new Date(x).getTime()`: 비유한 수와 ±8.64e15 밖은 NaN, 나머지는 0 쪽으로 버리고 -0은 +0이다.
#[test]
fn time_clip_truncates_toward_zero_and_drops_negative_zero() {
    let cases: &[(f64, f64, &str)] = &[
        (-0.0, 0.0, "new Date(-0).getTime()"),
        (-0.5, 0.0, "new Date(-0.5).getTime()"),
        (-1.5, -1.0, "new Date(-1.5).getTime()"),
        (1.9, 1.0, "new Date(1.9).getTime()"),
        (8.64e15, 8.64e15, "new Date(8.64e15).getTime()"),
        (8.64e15 + 1.0, f64::NAN, "new Date(8.64e15+1).getTime()"),
        (-8.64e15, -8.64e15, "new Date(-8.64e15).getTime()"),
        (-8.64e15 - 1.0, f64::NAN, "new Date(-8.64e15-1).getTime()"),
        (f64::NAN, f64::NAN, "new Date(NaN).getTime()"),
        (f64::INFINITY, f64::NAN, "new Date(Infinity).getTime()"),
    ];
    for &(input, expected, label) in cases {
        assert_same(time_clip(input), expected, label);
    }
}

/// `new Date(x).toISOString()`: 0~9999년은 4자리, 그 밖은 부호와 6자리, 범위 밖은 RangeError(None)다.
#[test]
fn to_iso_string_matches_js() {
    let cases: &[(f64, Option<&str>, &str)] = &[
        (
            -62_198_755_200_000.0,
            Some("-000001-01-01T00:00:00.000Z"),
            "new Date(-62198755200000).toISOString()",
        ),
        (
            0.0,
            Some("1970-01-01T00:00:00.000Z"),
            "new Date(0).toISOString()",
        ),
        (
            -0.0,
            Some("1970-01-01T00:00:00.000Z"),
            "new Date(-0).toISOString()",
        ),
        (
            -0.5,
            Some("1970-01-01T00:00:00.000Z"),
            "new Date(-0.5).toISOString()",
        ),
        (
            -1.5,
            Some("1969-12-31T23:59:59.999Z"),
            "new Date(-1.5).toISOString()",
        ),
        (
            1.9,
            Some("1970-01-01T00:00:00.001Z"),
            "new Date(1.9).toISOString()",
        ),
        (
            8.64e15,
            Some("+275760-09-13T00:00:00.000Z"),
            "new Date(8.64e15).toISOString()",
        ),
        (
            -8.64e15,
            Some("-271821-04-20T00:00:00.000Z"),
            "new Date(-8.64e15).toISOString()",
        ),
        (
            253_402_300_799_999.0,
            Some("9999-12-31T23:59:59.999Z"),
            "new Date(253402300799999).toISOString()",
        ),
        (
            253_402_300_800_000.0,
            Some("+010000-01-01T00:00:00.000Z"),
            "new Date(253402300800000).toISOString()",
        ),
        (
            -62_167_219_200_000.0,
            Some("0000-01-01T00:00:00.000Z"),
            "new Date(-62167219200000).toISOString()",
        ),
        (
            -62_167_219_200_001.0,
            Some("-000001-12-31T23:59:59.999Z"),
            "new Date(-62167219200001).toISOString()",
        ),
        (
            1_773_063_000_000.0,
            Some("2026-03-09T13:30:00.000Z"),
            "new Date(1773063000000).toISOString()",
        ),
        (
            951_782_400_000.0,
            Some("2000-02-29T00:00:00.000Z"),
            "new Date(951782400000).toISOString()",
        ),
        (f64::NAN, None, "new Date(NaN).toISOString()"),
        (f64::INFINITY, None, "new Date(Infinity).toISOString()"),
        (f64::NEG_INFINITY, None, "new Date(-Infinity).toISOString()"),
        (8.64e15 + 1.0, None, "new Date(8.64e15+1).toISOString()"),
        (-8.64e15 - 1.0, None, "new Date(-8.64e15-1).toISOString()"),
    ];
    for &(input, expected, label) in cases {
        assert_eq!(to_iso_string(input).as_deref(), expected, "{label}");
    }
}

/// 그레고리력 날짜 ↔ 1970-01-01부터의 일수. 기대값은 `Date.UTC(y, m-1, d) / 86400000`이다(0~99년은
/// 1900년대 규칙을 피하려고 `setUTCFullYear`로 셌다).
#[test]
fn civil_conversions_match_js_day_numbers() {
    let cases: &[((i64, u32, u32), i64)] = &[
        ((1970, 1, 1), 0),
        ((1969, 12, 31), -1),
        ((2000, 3, 1), 11_017),
        ((2000, 2, 29), 11_016),
        ((1900, 3, 1), -25_508),
        ((1900, 2, 28), -25_509),
        ((-1, 1, 1), -719_893),
        ((0, 3, 1), -719_468),
        ((0, 2, 29), -719_469),
        ((0, 1, 1), -719_528),
        ((99, 12, 31), -683_004),
        ((4, 2, 29), -718_008),
        ((275_760, 9, 13), 100_000_000),
        ((-271_821, 4, 20), -100_000_000),
        ((2026, 3, 9), 20_521),
        ((1600, 1, 1), -135_140),
        ((-400, 3, 1), -865_565),
    ];
    for &((year, month, day), days) in cases {
        assert_eq!(
            days_from_civil(year, month, day),
            days,
            "days_from_civil({year}, {month}, {day})"
        );
        assert_eq!(
            civil_from_days(days),
            (year, month, day),
            "civil_from_days({days})"
        );
    }
}

/// 두 변환은 서로의 역이고, `civil_from_days`는 늘 실제 달력 날짜를 낸다(TimeClip 범위보다 넓게 훑는다).
#[test]
fn civil_conversions_round_trip() {
    for days in (-120_000_000_i64..=120_000_000).step_by(997) {
        let (year, month, day) = civil_from_days(days);
        assert!(
            (1..=12).contains(&month),
            "civil_from_days({days}) month {month}"
        );
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        assert!(
            (1..=length).contains(&day),
            "civil_from_days({days}) day {day}"
        );
        assert_eq!(days_from_civil(year, month, day), days, "왕복 {days}");
    }
    // 정수 범위 끝에서도 패닉 없이 계산한다(결과가 i64에 들어가는 연도)
    let (year, month, day) = civil_from_days(i64::MIN);
    assert_eq!(days_from_civil(year, month, day), i64::MIN);
    let (year, month, day) = civil_from_days(i64::MAX);
    assert_eq!(days_from_civil(year, month, day), i64::MAX);
}

/// 달과 날이 넘치면 `Date.UTC`처럼 이어서 센다: 13월은 다음 해 1월, 0월은 전해 12월, 0일은 전달 마지막 날이다.
#[test]
fn days_from_civil_rolls_over_like_date_utc() {
    assert_eq!(days_from_civil(2026, 13, 1), days_from_civil(2027, 1, 1));
    assert_eq!(days_from_civil(2026, 0, 1), days_from_civil(2025, 12, 1));
    assert_eq!(days_from_civil(2026, 1, 0), days_from_civil(2025, 12, 31));
    assert_eq!(days_from_civil(2026, 2, 29), days_from_civil(2026, 3, 1));
    assert_eq!(days_from_civil(2024, 2, 30), days_from_civil(2024, 3, 1));
    assert_eq!(days_from_civil(2026, 25, 1), days_from_civil(2028, 1, 1));
}

/// M0 시간대 계약 v1의 날짜 파서: `YYYY-MM-DD`, 연도 1000~9999, 실제 달력 날짜만 받는다.
#[test]
fn parse_iso_date_follows_the_time_zone_contract() {
    let cases: &[(&str, Option<IsoDate>)] = &[
        ("2024-02-29", Some((2024, 2, 29))),
        ("2026-02-30", None),
        ("0999-01-01", None),
        ("1000-01-01", Some((1000, 1, 1))),
        ("9999-12-31", Some((9999, 12, 31))),
        ("2000-02-29", Some((2000, 2, 29))),
        ("1900-02-29", None),
        ("2100-02-29", None),
        ("2026-04-30", Some((2026, 4, 30))),
        ("2026-04-31", None),
        ("2026-00-10", None),
        ("2026-13-01", None),
        ("2026-01-00", None),
        ("2026-1-01", None),
        ("2026-01-01 ", None),
        (" 2026-01-01", None),
        ("2026/01/01", None),
        ("+02026-01-01", None),
        ("１２３４-01-01", None),
        ("10000-01-01", None),
        ("", None),
        ("2026-01-01T00:00", None),
    ];
    for &(input, expected) in cases {
        assert_eq!(parse_iso_date(input), expected, "parse_iso_date({input:?})");
    }
}

/// M0 시간대 계약 v1의 시각 파서: `HH:mm` 또는 `HH:mm:ss`, 0~23시, 0~59분·초. 초가 없으면 0이다.
#[test]
fn parse_iso_clock_follows_the_time_zone_contract() {
    let cases: &[(&str, Option<IsoClock>)] = &[
        ("00:00", Some((0, 0, 0))),
        ("09:30", Some((9, 30, 0))),
        ("23:59:59", Some((23, 59, 59))),
        ("24:00", None),
        ("12:60", None),
        ("12:30:60", None),
        ("9:30", None),
        ("09:30:5", None),
        ("09:30:", None),
        ("09:30:00.000", None),
        ("09-30", None),
        ("", None),
        ("0930", None),
        ("09:3a", None),
        ("٠٩:٣٠", None),
    ];
    for &(input, expected) in cases {
        assert_eq!(
            parse_iso_clock(input),
            expected,
            "parse_iso_clock({input:?})"
        );
    }
}
