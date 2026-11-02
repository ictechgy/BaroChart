//! 숫자 커널(`num`, `math`) 고정 벡터.
//!
//! 기대값은 같은 JS 식을 V8(Node 22.20.0), JSC(macOS 시스템 `jsc`), QuickJS(`native/android/quickjs`
//! 2026-06-04)에서 계산해 세 엔진이 모두 같은 값을 낸 것만 넣었다(2026-11-02 실측, 223식 전부 일치).
//! 실패 문구의 JS 식이 그 원본이다. JS 식으로 만들 수 없는 NaN 페이로드 사례 하나만 ECMA-262 SameValue
//! 정의로 정했다. 대량 대조는 Task 4의 대조 하네스가 맡는다.
//!
//! 이 파일도 `scripts/rust/check-bans.mjs`가 커널 규칙으로 검사한다. 그래서 Rust의 정밀도 형식으로
//! 기대값을 만들지 않고, 문자열을 그대로 적는다.

use barochart_js::math::{js_exp, js_hypot, js_log};
use barochart_js::num::{
    js_max, js_min, js_round, js_sign, number_to_string, same_value, to_exponential, to_fixed,
    to_int32, to_precision, to_uint32,
};

/// 두 f64가 `Object.is` 기준으로 같은지 단언한다. +0과 -0을 가르고, NaN끼리는 같다고 본다.
///
/// 시험 대상인 `same_value`로 판정하지 않으려고 비트를 직접 비교한다.
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

/// 2의 거듭제곱을 비트로 정확하게 만든다. 정규수 범위(-1022..=1023)만 받는다.
///
/// `powi`의 구현 방식에 기대지 않고 2^84 같은 큰 경계값을 정확히 적으려고 쓴다.
///
/// - `exponent`: 2의 지수
/// - 반환: 2^exponent
fn power_of_two(exponent: i32) -> f64 {
    assert!(
        (-1022..=1023).contains(&exponent),
        "normal exponent required, got {exponent}"
    );
    let biased = u64::try_from(exponent + 1023).expect("biased exponent is positive");
    f64::from_bits(biased << 52)
}

/// `String(x)`: 지수 표기 경계(1e21, 1e-7), 큰 정수, -0, 부분정규수, 최단 자릿수, 비유한 수
#[test]
fn number_to_string_matches_js() {
    let cases: &[(f64, &str)] = &[
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (123456789012345680000.0, "123456789012345680000"),
        (-0.0, "0"),
        (5e-324, "5e-324"),
        (0.1 + 0.2, "0.30000000000000004"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (f64::NEG_INFINITY, "-Infinity"),
        (1e-6, "0.000001"),
        (1.5e-7, "1.5e-7"),
        (999999999999999900000.0, "999999999999999900000"),
        (1e20, "100000000000000000000"),
        (power_of_two(60), "1152921504606847000"),
        (-1.5, "-1.5"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (2.2250738585072014e-308, "2.2250738585072014e-308"),
        (123e-20, "1.23e-18"),
        (-1e21, "-1e+21"),
        (0.000001234, "0.000001234"),
        (100.0, "100"),
        (1.25, "1.25"),
        (-5e-324, "-5e-324"),
    ];
    for &(x, expected) in cases {
        assert_eq!(number_to_string(x), expected, "String({x:?})");
    }
}

/// `x.toFixed(d)`: 정확한 이진 값에서 동률이면 절댓값이 큰 쪽, 부호는 x < 0일 때만, |x| ≥ 1e21이면 `String(x)`
#[test]
fn to_fixed_matches_js() {
    let cases: &[(f64, u32, &str)] = &[
        (0.125, 2, "0.13"),
        (2.5, 0, "3"),
        (-2.5, 0, "-3"),
        (-0.0, 2, "0.00"),
        (-1e-10, 2, "-0.00"),
        (1.005, 2, "1.00"),
        (8.345, 2, "8.35"),
        (1e21, 2, "1e+21"),
        (0.5, 0, "1"),
        (-0.5, 0, "-1"),
        (1.45, 1, "1.4"),
        (999999999999999900000.0, 2, "999999999999999868928.00"),
        (-1e21, 2, "-1e+21"),
        (1.23e-10, 2, "0.00"),
        (0.000001, 7, "0.0000010"),
        (
            5e-324,
            100,
            concat!(
                "0.",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000"
            ),
        ),
        (123.456, 10, "123.4560000000"),
        (1.255, 2, "1.25"),
        (1.5, 0, "2"),
        (f64::NAN, 2, "NaN"),
        (f64::INFINITY, 2, "Infinity"),
        (f64::NEG_INFINITY, 2, "-Infinity"),
        (0.05, 1, "0.1"),
        (2.345, 2, "2.35"),
        (1e20, 2, "100000000000000000000.00"),
        (123.456, 0, "123"),
        (9.995, 2, "9.99"),
        (0.1, 20, "0.10000000000000000555"),
        (1.7976931348623157e308, 2, "1.7976931348623157e+308"),
        (0.0005, 3, "0.001"),
        (0.00049, 3, "0.000"),
        (0.0000000005, 9, "0.000000001"),
        (99.995, 2, "100.00"),
        (999.9999, 3, "1000.000"),
        (-999.9999, 3, "-1000.000"),
        (0.0, 0, "0"),
        (
            1.0,
            100,
            concat!(
                "1.",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000"
            ),
        ),
        (4503599627370497.0, 1, "4503599627370497.0"),
        (
            0.3,
            100,
            concat!(
                "0.",
                "2999999999",
                "9999998889",
                "7769753748",
                "4345957636",
                "8331909179",
                "6875000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000"
            ),
        ),
        (123456789012345680000.0, 0, "123456789012345683968"),
    ];
    for &(x, digits, expected) in cases {
        assert_eq!(to_fixed(x, digits), expected, "({x:?}).toFixed({digits})");
    }
}

/// `x.toPrecision(p)`: e < -6 또는 e ≥ p면 지수 표기, 같은 동률 규칙, 올림으로 바뀐 지수로 판정
#[test]
fn to_precision_matches_js() {
    let cases: &[(f64, u32, &str)] = &[
        (123456789012344.5, 15, "123456789012345"),
        (1.25, 2, "1.3"),
        (1.345678901234e-12, 15, "1.34567890123400e-12"),
        (1.5e21, 15, "1.50000000000000e+21"),
        (-0.0, 15, "0.00000000000000"),
        (0.000001234, 2, "0.0000012"),
        (0.0000001234, 2, "1.2e-7"),
        (123.0, 2, "1.2e+2"),
        (123.0, 3, "123"),
        (99.99, 3, "100"),
        (99.99, 2, "1.0e+2"),
        (9.5, 1, "1e+1"),
        (0.0, 1, "0"),
        (-1.5, 1, "-2"),
        (5e-324, 3, "4.94e-324"),
        (1.7976931348623157e308, 3, "1.80e+308"),
        (f64::NAN, 3, "NaN"),
        (f64::NEG_INFINITY, 3, "-Infinity"),
        (1e21, 1, "1e+21"),
        (
            123456.0,
            100,
            concat!(
                "123456.",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000"
            ),
        ),
        (
            0.1,
            100,
            concat!(
                "0.",
                "1000000000",
                "0000000555",
                "1115123125",
                "7827021181",
                "5834045410",
                "1562500000",
                "0000000000",
                "0000000000",
                "0000000000",
                "0000000000"
            ),
        ),
        (0.00000099999, 2, "0.0000010"),
        (999999.5, 6, "1.00000e+6"),
        (123.456, 4, "123.5"),
        (0.000123, 1, "0.0001"),
        (1e-7, 1, "1e-7"),
        (1e21, 22, "1000000000000000000000"),
        (1e21, 21, "1.00000000000000000000e+21"),
        (5e-7, 1, "5e-7"),
        (0.0000009999, 3, "0.00000100"),
    ];
    for &(x, precision, expected) in cases {
        assert_eq!(
            to_precision(x, precision),
            expected,
            "({x:?}).toPrecision({precision})"
        );
    }
}

/// `x.toExponential(d)`: 지수 부호는 늘 쓰고, `None`(undefined)이면 `String(x)`와 같은 최단 자릿수
#[test]
fn to_exponential_matches_js() {
    let cases: &[(f64, Option<u32>, &str)] = &[
        (0.0, Some(2), "0.00e+0"),
        (123.456, Some(2), "1.23e+2"),
        (0.0, None, "0e+0"),
        (-0.0, Some(2), "0.00e+0"),
        (1.5e-7, None, "1.5e-7"),
        (123456.0, None, "1.23456e+5"),
        (1.25, Some(1), "1.3e+0"),
        (-1.25, Some(1), "-1.3e+0"),
        (1e21, None, "1e+21"),
        (5e-324, None, "5e-324"),
        (5e-324, Some(2), "4.94e-324"),
        (9.995, Some(2), "9.99e+0"),
        (99.5, Some(1), "1.0e+2"),
        (f64::NAN, Some(2), "NaN"),
        (f64::INFINITY, None, "Infinity"),
        (0.1 + 0.2, None, "3.0000000000000004e-1"),
        (123.456, Some(0), "1e+2"),
        (
            1.7976931348623157e308,
            Some(20),
            "1.79769313486231570815e+308",
        ),
        (-0.0, None, "0e+0"),
        (1.0, None, "1e+0"),
        (10.0, None, "1e+1"),
        (123456789012345680000.0, None, "1.2345678901234568e+20"),
        (
            0.000001,
            Some(100),
            concat!(
                "9.",
                "9999999999",
                "9999954748",
                "1118258862",
                "5868561393",
                "8723690807",
                "8193664550",
                "7812500000",
                "0000000000",
                "0000000000",
                "0000000000",
                "e-7"
            ),
        ),
        (-1.5, None, "-1.5e+0"),
        (
            5e-324,
            Some(99),
            concat!(
                "4.",
                "9406564584",
                "1246544176",
                "5687928682",
                "2137236505",
                "9802614324",
                "7644255856",
                "8250067550",
                "7270208751",
                "8652998363",
                "616359924",
                "e-324"
            ),
        ),
    ];
    for &(x, digits, expected) in cases {
        assert_eq!(
            to_exponential(x, digits),
            expected,
            "({x:?}).toExponential({digits:?})"
        );
    }
}

/// `Math.round`: 동률은 +∞ 쪽, (-0.5, 0)과 -0.5는 -0, `floor(x + 0.5)`가 틀리는 두 값
#[test]
fn js_round_matches_js() {
    let cases: &[(f64, f64)] = &[
        (-2.5, -2.0),
        (-0.4, -0.0),
        (0.49999999999999994, 0.0),
        (4503599627370497.0, 4503599627370497.0),
        (2.5, 3.0),
        (-3.5, -3.0),
        (0.5, 1.0),
        (-0.5, -0.0),
        (f64::NAN, f64::NAN),
        (f64::INFINITY, f64::INFINITY),
        (f64::NEG_INFINITY, f64::NEG_INFINITY),
        (-0.0, -0.0),
        (1.5, 2.0),
        (-1.5, -1.0),
        (power_of_two(53), power_of_two(53)),
        (-4503599627370497.0, -4503599627370497.0),
        (0.5000000000000001, 1.0),
        (-0.5000000000000001, -1.0),
        (4503599627370495.5, 4503599627370496.0),
        (-4503599627370495.5, -4503599627370495.0),
        (5e-324, 0.0),
        (-5e-324, -0.0),
        (1.7976931348623157e308, 1.7976931348623157e308),
        (-0.49999999999999994, -0.0),
    ];
    for &(x, expected) in cases {
        assert_same(js_round(x), expected, &format!("Math.round({x:?})"));
    }
}

/// `Math.max`/`Math.min`: NaN 전파, -0 < +0, 빈 입력은 -Infinity/Infinity
#[test]
fn js_max_and_js_min_match_js() {
    let maximum_cases: &[(&[f64], f64)] = &[
        (&[f64::NAN, 1.0], f64::NAN),
        (&[-0.0, 0.0], 0.0),
        (&[0.0, -0.0], 0.0),
        (&[], f64::NEG_INFINITY),
        (&[-0.0, -0.0], -0.0),
        (&[1.0, f64::NAN, 3.0], f64::NAN),
        (&[1.0, 2.0, 3.0], 3.0),
        (&[f64::NEG_INFINITY], f64::NEG_INFINITY),
    ];
    for &(values, expected) in maximum_cases {
        assert_same(js_max(values), expected, &format!("Math.max({values:?})"));
    }
    let minimum_cases: &[(&[f64], f64)] = &[
        (&[f64::NAN, 1.0], f64::NAN),
        (&[-0.0, 0.0], -0.0),
        (&[0.0, -0.0], -0.0),
        (&[], f64::INFINITY),
        (&[0.0, 0.0], 0.0),
        (&[1.0, f64::NAN, 3.0], f64::NAN),
        (&[3.0, 2.0, 1.0], 1.0),
        (&[f64::INFINITY], f64::INFINITY),
    ];
    for &(values, expected) in minimum_cases {
        assert_same(js_min(values), expected, &format!("Math.min({values:?})"));
    }
}

/// `Math.sign`: ±0과 NaN은 그대로, 나머지는 ±1
#[test]
fn js_sign_matches_js() {
    let cases: &[(f64, f64)] = &[
        (-0.0, -0.0),
        (0.0, 0.0),
        (f64::NAN, f64::NAN),
        (-5.0, -1.0),
        (5.0, 1.0),
        (f64::NEG_INFINITY, -1.0),
        (5e-324, 1.0),
        (-5e-324, -1.0),
    ];
    for &(x, expected) in cases {
        assert_same(js_sign(x), expected, &format!("Math.sign({x:?})"));
    }
}

/// `x | 0`(ToInt32)와 `x >>> 0`(ToUint32): 버림 뒤 2^32 모듈로, 비유한 수와 ±0은 0
#[test]
fn to_int32_and_to_uint32_match_js() {
    let int32_cases: &[(f64, i32)] = &[
        (4294967296.5, 0),
        (2147483648.0, -2147483648),
        (f64::NAN, 0),
        (f64::INFINITY, 0),
        (f64::NEG_INFINITY, 0),
        (-0.0, 0),
        (-1.0, -1),
        (4294967295.0, -1),
        (-2147483649.0, 2147483647),
        (1e20, 1661992960),
        (-1.9, -1),
        (2.9, 2),
        (power_of_two(53) + 2.0, 2),
        (power_of_two(84), 0),
        (power_of_two(63), 0),
        (power_of_two(31) + 0.5, -2147483648),
        (-power_of_two(31), -2147483648),
        (-power_of_two(31) - 0.5, -2147483648),
        (1.7976931348623157e308, 0),
        (power_of_two(64) + power_of_two(12), 4096),
        (-power_of_two(64) - power_of_two(12), -4096),
        (power_of_two(83) + power_of_two(31), -2147483648),
    ];
    for &(x, expected) in int32_cases {
        assert_eq!(to_int32(x), expected, "({x:?}) | 0");
    }
    let uint32_cases: &[(f64, u32)] = &[
        (-1.0, 4294967295),
        (4294967296.0, 0),
        (f64::NAN, 0),
        (-0.5, 0),
        (power_of_two(32) + 5.0, 5),
        (-power_of_two(32) - 1.0, 4294967295),
        (2147483648.0, 2147483648),
        (4294967295.9, 4294967295),
        (-4294967295.0, 1),
        (1e20, 1661992960),
    ];
    for &(x, expected) in uint32_cases {
        assert_eq!(to_uint32(x), expected, "({x:?}) >>> 0");
    }
}

/// `Object.is`: NaN끼리는 같고(페이로드와 무관), +0과 -0은 다르다
#[test]
fn same_value_matches_object_is() {
    let other_nan = f64::from_bits(0x7ff8_0000_0000_0001);
    let cases: &[(f64, f64, bool)] = &[
        (f64::NAN, f64::NAN, true),
        (0.0, -0.0, false),
        (-0.0, -0.0, true),
        (1.0, 1.0, true),
        (f64::NAN, 1.0, false),
        (f64::INFINITY, f64::INFINITY, true),
        (f64::NAN, other_nan, true),
    ];
    for &(a, b, expected) in cases {
        assert_eq!(same_value(a, b), expected, "Object.is({a:?}, {b:?})");
    }
}

/// `Math.hypot`/`log`/`exp`의 특수값. 세 엔진과 C99 부록 F가 모두 같은 값이다
#[test]
fn engine_math_special_values_match_js() {
    let hypot_cases: &[(f64, f64, f64)] = &[
        (3.0, 4.0, 5.0),
        (f64::INFINITY, f64::NAN, f64::INFINITY),
        (f64::NAN, f64::INFINITY, f64::INFINITY),
        (f64::NAN, 1.0, f64::NAN),
        (-0.0, -0.0, 0.0),
        (-3.0, 0.0, 3.0),
    ];
    for &(a, b, expected) in hypot_cases {
        assert_same(
            js_hypot(a, b),
            expected,
            &format!("Math.hypot({a:?}, {b:?})"),
        );
    }
    let log_cases: &[(f64, f64)] = &[
        (1.0, 0.0),
        (-1.0, f64::NAN),
        (0.0, f64::NEG_INFINITY),
        (-0.0, f64::NEG_INFINITY),
        (f64::INFINITY, f64::INFINITY),
        (f64::NAN, f64::NAN),
    ];
    for &(x, expected) in log_cases {
        assert_same(js_log(x), expected, &format!("Math.log({x:?})"));
    }
    let exp_cases: &[(f64, f64)] = &[
        (0.0, 1.0),
        (-0.0, 1.0),
        (f64::NEG_INFINITY, 0.0),
        (f64::INFINITY, f64::INFINITY),
        (f64::NAN, f64::NAN),
        (710.0, f64::INFINITY),
        (-746.0, 0.0),
    ];
    for &(x, expected) in exp_cases {
        assert_same(js_exp(x), expected, &format!("Math.exp({x:?})"));
    }
}

/// 기기 빌드의 `js_log`/`js_exp`/`js_hypot`은 플랫폼 libm(std)과 비트가 같다(설계 §6.3).
/// 같은 기기의 JS 백엔드(JSC, QuickJS)가 libm을 쓰므로, 다른 구현으로 바꾸면 이 시험이 먼저 깨진다.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn engine_math_uses_platform_libm_on_devices() {
    let inputs: [f64; 10] = [
        0.1, 0.7, 1.5, 2.0, 3.25, 10.0, 123.456, 1e-300, 1e300, 5e-324,
    ];
    for &a in &inputs {
        assert_same(js_log(a), a.ln(), &format!("Math.log({a:?})"));
        assert_same(js_exp(a), a.exp(), &format!("Math.exp({a:?})"));
        for &b in &inputs {
            assert_same(
                js_hypot(a, b),
                a.hypot(b),
                &format!("Math.hypot({a:?}, {b:?})"),
            );
        }
    }
}
