//! JSON 커널(`json`) 고정 벡터: `JSON.parse`·`JSON.stringify` 의미(Standard)와 무손실 모드(Lossless).
//!
//! Standard 기대값은 같은 입력을 V8(Node 22.20.0), JSC(macOS 시스템 `jsc`), QuickJS(`native/android/quickjs`
//! 2026-06-04)의 `JSON.parse`·`JSON.stringify`로 계산해 세 엔진이 모두 같은 값을 낸 것만 넣었다(2026-11-02 실측).
//! 엔진마다 다른 경우는 해당 테스트에 적었다(깊은 중첩, 38자리를 넘는 숫자). 오류는 이름(`SyntaxError`)만
//! 계약이다(이식 지도 D8). Lossless는 M0 계획 Task 5의 BCJSON 문법에서 `F64` 토큰을 뺀 것이다.

use barochart_js::json::{
    JsObject, JsValue, JsonFailure, JsonMode, parse_json, parse_json_scoped, parse_json_utf16,
    parse_json_utf16_with, parse_json_with, stringify_json, stringify_json_scoped,
    stringify_json_with,
};
use barochart_js::memory::{MemoryAccount, MemoryContext, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

#[test]
fn owned_payload_moves_back_to_scope_without_a_second_peak_and_utf8_is_fallible() {
    let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    {
        let group = context.reserve_group(600).unwrap();
        let mut scope = context.scope();
        scope.try_grow(400).unwrap();
        let before = account.snapshot();
        scope.absorb_persistent(group).unwrap();
        assert_eq!(scope.requested_bytes(), 1_000);
        assert_eq!(account.snapshot(), before);
        let value = JsString::from_utf16(vec![b'a' as u16, 0xd800, 0xd83d, 0xde00]);
        assert_eq!(
            value.try_to_string_lossy_scoped(&mut scope).unwrap(),
            "a�😀"
        );
        assert_eq!(scope.requested_bytes(), 1_008);
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
    let denied = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&denied);
    assert!(
        JsString::from_str("가")
            .try_to_string_lossy_scoped(&mut scope)
            .is_err()
    );
    assert_eq!(denied.snapshot().requested_live_bytes, 0);
}

#[test]
fn scoped_entry_builder_keeps_js_key_order_duplicates_and_releases_oom() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&account);
        let entries = [
            (JsString::from_str("b"), JsValue::Bool(true)),
            (JsString::from_str("2"), JsValue::Number(2.0)),
            (JsString::from_str("1"), JsValue::Number(1.0)),
            (JsString::from_str("b"), JsValue::Undefined),
        ];
        let value = JsObject::try_from_entries_scoped(entries, &mut scope).unwrap();
        assert_eq!(
            stringify_json(&JsValue::Object(value), JsonMode::Lossless),
            br#"{"1":1,"2":2,"b":undefined}"#
        );
        assert!(account.snapshot().requested_live_bytes > 0);
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&account);
        assert!(
            JsObject::try_from_entries_scoped(
                [(JsString::from_str("a"), JsValue::Number(1.0))],
                &mut scope
            )
            .is_err()
        );
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

/// 텍스트를 파싱한다. 실패하면 입력과 오류를 보여 주며 멈춘다.
///
/// - `text`: JSON 텍스트
/// - `mode`: 문법(Standard 또는 Lossless)
/// - 반환: 파싱한 값
#[track_caller]
fn parse(text: &str, mode: JsonMode) -> JsValue {
    match parse_json(text.as_bytes(), mode) {
        Ok(value) => value,
        Err(error) => panic!("{mode:?} parse of {text:?} threw {error:?}"),
    }
}

/// 값을 JSON 텍스트로 쓴다. writer는 늘 올바른 UTF-8을 내야 한다.
///
/// - `value`: 쓸 값
/// - `mode`: 문법(Standard 또는 Lossless)
/// - 반환: JSON 텍스트
#[track_caller]
fn stringify(value: &JsValue, mode: JsonMode) -> String {
    match String::from_utf8(stringify_json(value, mode)) {
        Ok(text) => text,
        Err(error) => panic!("{mode:?} writer emitted invalid UTF-8: {error}"),
    }
}

/// `JSON.stringify(JSON.parse(text))`
///
/// - `text`: JSON 텍스트
/// - 반환: 다시 쓴 텍스트
#[track_caller]
fn round_trip(text: &str) -> String {
    stringify(&parse(text, JsonMode::Standard), JsonMode::Standard)
}

/// 무손실 모드로 파싱한 뒤 다시 쓴다.
///
/// - `text`: BCJSON 텍스트
/// - 반환: 다시 쓴 텍스트
#[track_caller]
fn lossless_round_trip(text: &str) -> String {
    stringify(&parse(text, JsonMode::Lossless), JsonMode::Lossless)
}

/// 입력이 SyntaxError로 거절되는지 단언한다.
///
/// - `text`: 입력 바이트
/// - `mode`: 문법
#[track_caller]
fn assert_syntax_error(text: &[u8], mode: JsonMode) {
    let shown = String::from_utf8_lossy(text);
    match parse_json(text, mode) {
        Ok(value) => panic!("{mode:?} parse of {shown:?} should throw SyntaxError, got {value:?}"),
        Err(error) => assert_eq!(
            error.name, "SyntaxError",
            "{mode:?} parse of {shown:?}: {error:?}"
        ),
    }
}

/// 값이 숫자인지 확인하고 꺼낸다.
///
/// - `value`: 살펴볼 값
/// - 반환: 숫자
#[track_caller]
fn number(value: &JsValue) -> f64 {
    match value {
        JsValue::Number(number) => *number,
        other => panic!("expected a number, got {other:?}"),
    }
}

/// 값이 객체인지 확인하고 빌려 온다.
///
/// - `value`: 살펴볼 값
/// - 반환: 객체
#[track_caller]
fn object(value: &JsValue) -> &JsObject {
    match value {
        JsValue::Object(object) => object,
        other => panic!("expected an object, got {other:?}"),
    }
}

/// 값이 배열인지 확인하고 빌려 온다.
///
/// - `value`: 살펴볼 값
/// - 반환: 원소들
#[track_caller]
fn array(value: &JsValue) -> &[JsValue] {
    match value {
        JsValue::Array(items) => items,
        other => panic!("expected an array, got {other:?}"),
    }
}

/// 값이 문자열인지 확인하고 코드 단위를 빌려 온다.
///
/// - `value`: 살펴볼 값
/// - 반환: UTF-16 코드 단위
#[track_caller]
fn string_units(value: &JsValue) -> &[u16] {
    match value {
        JsValue::String(text) => text.as_units(),
        other => panic!("expected a string, got {other:?}"),
    }
}

/// UTF-8 리터럴을 커널 문자열로 바꾼다.
///
/// - `text`: 바꿀 문자열
/// - 반환: 커널 문자열
fn key(text: &str) -> JsString {
    JsString::from_str(text)
}

/// 객체 키 순서는 배열 인덱스 키(0..=4294967294, 앞자리 0 없음) 오름차순 다음 나머지 삽입 순서다.
#[test]
fn object_keys_put_array_indices_first() {
    let cases: &[(&str, &str)] = &[
        (
            r#"{"b":1,"2":2,"a":3,"1":4}"#,
            r#"{"1":4,"2":2,"b":1,"a":3}"#,
        ),
        (
            r#"{"4294967295":1,"4294967294":2,"01":3,"1":4,"-1":5,"1.5":6,"0":7,"-0":8,"00":9,"1e3":10," 1":11,"4294967296":12,"10":13,"9":14}"#,
            r#"{"0":7,"1":4,"9":14,"10":13,"4294967294":2,"4294967295":1,"01":3,"-1":5,"1.5":6,"-0":8,"00":9,"1e3":10," 1":11,"4294967296":12}"#,
        ),
        // 일반 키 뒤에 넣은 2^32-1과 앞자리 0 키는 삽입 순서 자리에 남는다(인덱스로 보면 앞으로 간다)
        (
            r#"{"a":1,"4294967295":2,"4294967294":3}"#,
            r#"{"4294967294":3,"a":1,"4294967295":2}"#,
        ),
        (r#"{"a":1,"01":2,"1":3}"#, r#"{"1":3,"a":1,"01":2}"#),
    ];
    for &(input, expected) in cases {
        assert_eq!(
            round_trip(input),
            expected,
            "JSON.stringify(JSON.parse({input:?}))"
        );
    }
}

/// 중복 키는 마지막 값이 이기고 자리는 처음 나온 곳을 지킨다.
#[test]
fn duplicate_keys_keep_the_last_value_at_the_first_position() {
    let cases: &[(&str, &str)] = &[
        (r#"{"a":1,"a":2}"#, r#"{"a":2}"#),
        (r#"{"a":1,"b":2,"a":3}"#, r#"{"a":3,"b":2}"#),
        (r#"{"5":1,"x":0,"5":2}"#, r#"{"5":2,"x":0}"#),
    ];
    for &(input, expected) in cases {
        assert_eq!(
            round_trip(input),
            expected,
            "JSON.stringify(JSON.parse({input:?}))"
        );
    }
}

/// `__proto__`는 프로토타입을 바꾸지 않는 평범한 자기 키다.
#[test]
fn proto_is_an_ordinary_key() {
    let value = parse(r#"{"__proto__":1}"#, JsonMode::Standard);
    let members = object(&value);
    assert_eq!(
        members.len(),
        1,
        "Object.keys(JSON.parse('{{\"__proto__\":1}}')).length"
    );
    assert_eq!(members.get(&key("__proto__")).map(number), Some(1.0));
    assert_eq!(round_trip(r#"{"__proto__":1}"#), r#"{"__proto__":1}"#);
    assert_eq!(
        round_trip(r#"{"__proto__":{"a":1},"b":2}"#),
        r#"{"__proto__":{"a":1},"b":2}"#
    );
}

/// 넘치는 수는 ±Infinity가 되고, Standard writer는 비유한 수를 null로 쓴다.
#[test]
fn overflowing_numbers_become_infinity() {
    assert_eq!(
        number(&parse("1e400", JsonMode::Standard)),
        f64::INFINITY,
        "JSON.parse('1e400')"
    );
    assert_eq!(
        number(&parse("-1e400", JsonMode::Standard)),
        f64::NEG_INFINITY,
        "JSON.parse('-1e400')"
    );
    assert_eq!(
        round_trip("1e400"),
        "null",
        "JSON.stringify(JSON.parse('1e400'))"
    );
    assert_eq!(
        round_trip("[1e400]"),
        "[null]",
        "JSON.stringify(JSON.parse('[1e400]'))"
    );
}

/// 단독 서로게이트 이스케이프는 그 코드 단위가 되고, writer는 소문자 `\udxxx`로 쓴다.
#[test]
fn lone_surrogate_escapes_round_trip() {
    assert_eq!(
        string_units(&parse(r#""\ud800""#, JsonMode::Standard)),
        &[0xD800]
    );
    assert_eq!(
        round_trip(r#""\ud800""#),
        r#""\ud800""#,
        r#"JSON.stringify(JSON.parse('"\\ud800"'))"#
    );
    assert_eq!(
        round_trip(r#""\uD800""#),
        r#""\ud800""#,
        r#"JSON.stringify(JSON.parse('"\\uD800"'))"#
    );
    assert_eq!(
        round_trip(r#""\ud83d\ude00""#),
        "\"😀\"",
        "짝이 맞는 이스케이프는 원문으로 쓴다"
    );
}

/// `-0`은 값에 남고, Standard writer는 `0`, Lossless writer는 `-0`으로 쓴다.
#[test]
fn negative_zero_is_kept() {
    let value = parse("-0", JsonMode::Standard);
    assert_eq!(
        number(&value).to_bits(),
        0x8000_0000_0000_0000,
        "Object.is(JSON.parse('-0'), -0)"
    );
    assert_eq!(
        stringify(&value, JsonMode::Standard),
        "0",
        "JSON.stringify(-0)"
    );
    assert_eq!(stringify(&value, JsonMode::Lossless), "-0");
    let mixed = parse("[-0,0,-0.0,-0e5]", JsonMode::Standard);
    assert_eq!(stringify(&mixed, JsonMode::Standard), "[0,0,0,0]");
    assert_eq!(stringify(&mixed, JsonMode::Lossless), "[-0,0,-0,-0]");
}

/// 숫자는 정확히 반올림한다(`str::parse::<f64>`). 넘치면 ±Infinity, 너무 작으면 ±0이다.
#[test]
fn numbers_are_correctly_rounded() {
    let long_fraction = format!("0.{}", "1".repeat(1000));
    let long_tie = format!("9007199254740993{}e-300", "0".repeat(300));
    let long_exponent = format!("1e{}1", "0".repeat(400));
    let tiny_exponent = format!("1e-{}", "9".repeat(30));
    let zero_huge_exponent = format!("0e{}", "9".repeat(30));
    let cases: &[(&str, u64)] = &[
        ("0.1", 0x3FB9_9999_9999_999A),
        ("1.7976931348623157e308", 0x7FEF_FFFF_FFFF_FFFF),
        ("1.7976931348623158e308", 0x7FEF_FFFF_FFFF_FFFF),
        ("1.7976931348623159e308", 0x7FF0_0000_0000_0000),
        ("2.2250738585072014e-308", 0x0010_0000_0000_0000),
        ("5e-324", 0x0000_0000_0000_0001),
        ("4.9406564584124654e-324", 0x0000_0000_0000_0001),
        ("2.4703282292062328e-324", 0x0000_0000_0000_0001),
        ("2.4703282292062327e-324", 0x0000_0000_0000_0000),
        ("1e-400", 0x0000_0000_0000_0000),
        ("-1e-400", 0x8000_0000_0000_0000),
        ("12345678901234567890", 0x43E5_6A95_319D_63E1),
        ("9007199254740993", 0x4340_0000_0000_0000),
        (&long_fraction, 0x3FBC_71C7_1C71_C71C),
        (&long_tie, 0x4340_0000_0000_0000),
        (&long_exponent, 0x4024_0000_0000_0000),
        (&tiny_exponent, 0x0000_0000_0000_0000),
        (&zero_huge_exponent, 0x0000_0000_0000_0000),
        ("-0e999999999999", 0x8000_0000_0000_0000),
    ];
    for &(input, bits) in cases {
        assert_eq!(
            number(&parse(input, JsonMode::Standard)).to_bits(),
            bits,
            "JSON.parse({input:?})"
        );
    }
    assert_eq!(
        round_trip("[1E5,1e+5,1e-5,1.5E+2,-0.0e-0,0e0,123.456e7]"),
        "[100000,100000,0.00001,150,0,0,1234560000]",
        "JSON.stringify(JSON.parse('[1E5,1e+5,1e-5,1.5E+2,-0.0e-0,0e0,123.456e7]'))"
    );
}

/// 유효 숫자 40자리를 넘는 입력도 정확히 반올림한다.
///
/// 2^53+1 바로 위(동률보다 아주 조금 큰 값)는 ECMA에서 2^53+2다. QuickJS의 다른 결과는 아래 방언 테스트로 검증한다.
#[test]
fn long_decimal_inputs_round_correctly() {
    let above_tie = format!("9007199254740993{}1e-301", "0".repeat(300));
    assert_eq!(
        number(
            &parse_json_with(
                above_tie.as_bytes(),
                JsonMode::Standard,
                NumberDialect::Ecma
            )
            .unwrap()
        )
        .to_bits(),
        0x4340_0000_0000_0001,
        "JSON.parse('9007199254740993' + '0'.repeat(300) + '1e-301')"
    );
}

/// JSON 숫자도 같은 기기의 JS를 따른다: QuickJS는 십진 가수의 첫 38자리만 반올림에 쓴다.
#[test]
fn long_decimal_parsing_follows_the_selected_engine_dialect() {
    let low = 9_007_199_254_740_992.0_f64;
    let high = 9_007_199_254_740_994.0_f64;
    let mut cases = vec![
        (format!("9007199254740993.{}1", "0".repeat(21)), high, high),
        (format!("9007199254740993.{}1", "0".repeat(22)), high, low),
        (
            format!("9007199254740993{}1e-301", "0".repeat(300)),
            high,
            low,
        ),
        (
            format!(
                "0.{}9007199254740993{}1e100016",
                "0".repeat(100_000),
                "0".repeat(22)
            ),
            high,
            low,
        ),
        (
            String::from("1.00000000000000011102230246251565404236316680908203125001"),
            f64::from_bits(1.0_f64.to_bits() + 1),
            1.0,
        ),
    ];
    let negatives: Vec<_> = cases
        .iter()
        .map(|(text, ecma, quickjs)| (format!("-{text}"), -*ecma, -*quickjs))
        .collect();
    cases.extend(negatives);
    for (text, ecma, quickjs) in cases {
        let units: Vec<_> = text.encode_utf16().collect();
        for mode in [JsonMode::Standard, JsonMode::Lossless] {
            for (dialect, expected) in [
                (NumberDialect::Ecma, ecma),
                (NumberDialect::QuickJs, quickjs),
            ] {
                let bytes = parse_json_with(text.as_bytes(), mode, dialect).unwrap();
                let utf16 = parse_json_utf16_with(&units, mode, dialect).unwrap();
                assert_eq!(
                    number(&bytes).to_bits(),
                    expected.to_bits(),
                    "{mode:?} {dialect:?}"
                );
                assert_eq!(
                    number(&utf16).to_bits(),
                    expected.to_bits(),
                    "UTF-16 {mode:?} {dialect:?}"
                );
            }
            let expected = if NumberDialect::PLATFORM == NumberDialect::QuickJs {
                quickjs
            } else {
                ecma
            };
            assert_eq!(
                number(&parse_json(text.as_bytes(), mode).unwrap()).to_bits(),
                expected.to_bits()
            );
            assert_eq!(
                number(&parse_json_utf16(&units, mode).unwrap()).to_bits(),
                expected.to_bits()
            );
        }
    }
}

/// 명시 지수가 아주 커도(앞의 0을 뺀 지수 숫자 6자리 이상) 자릿수가 지수를 상쇄하면 `JSON.parse`와 같은 값이다.
///
/// Rust `str::parse::<f64>`(dec2flt, 1.98.1)는 명시 지수를 누적하다 65536을 넘으면 남은 지수 숫자를 버린다.
/// 그래서 리터럴을 그대로 넘기면 `"0." + "0"×700000 + "1e700001"`이 0, `"1" + "0"×700000 + "e-700000"`이
/// Infinity였다. V8·JSC·QuickJS는 둘 다 1이다(2026-11-02 실측). 명시 지수 655359까지는 정확히 누적되고
/// 655360부터 틀렸다. 문서 한도(8,388,608자) 안에 드는 입력이다.
/// 넘침·밑넘침 경계 사례는 정규화한 경로(첫 유효 숫자의 지수 308·309·310, -324·-325·-326)를 지난다.
#[test]
fn huge_exponents_offset_by_digits_parse_like_json_parse() {
    let zeros = |count: usize| "0".repeat(count);
    let cases: Vec<(String, u64)> = vec![
        (
            format!("0.{}1e700001", zeros(700_000)),
            0x3FF0_0000_0000_0000,
        ),
        (
            format!("1{}e-700000", zeros(700_000)),
            0x3FF0_0000_0000_0000,
        ),
        (
            format!("-0.{}15e700001", zeros(700_000)),
            0xBFF8_0000_0000_0000,
        ),
        (
            format!("12345{}e-700004", zeros(700_000)),
            0x3FF3_C083_126E_978D,
        ),
        (
            format!("0.{}1e655359", zeros(655_358)),
            0x3FF0_0000_0000_0000,
        ),
        (
            format!("0.{}1e655360", zeros(655_359)),
            0x3FF0_0000_0000_0000,
        ),
        (
            format!("1{}e-655359", zeros(655_359)),
            0x3FF0_0000_0000_0000,
        ),
        (
            format!("1{}e-655360", zeros(655_360)),
            0x3FF0_0000_0000_0000,
        ),
        (
            format!("0.{}17976931348623157e100309", zeros(100_000)),
            0x7FEF_FFFF_FFFF_FFFF,
        ),
        (
            format!("0.{}17976931348623159e100309", zeros(100_000)),
            0x7FF0_0000_0000_0000,
        ),
        (
            format!("0.{}1e100310", zeros(100_000)),
            0x7FF0_0000_0000_0000,
        ),
        (
            format!("-0.{}1e100311", zeros(100_000)),
            0xFFF0_0000_0000_0000,
        ),
        (
            format!("24703282292062328{}e-100340", zeros(100_000)),
            0x0000_0000_0000_0001,
        ),
        (
            format!("24703282292062327{}e-100340", zeros(100_000)),
            0x0000_0000_0000_0000,
        ),
        (
            format!("1{}e-100325", zeros(100_000)),
            0x0000_0000_0000_0000,
        ),
        (
            format!("-1{}e-100326", zeros(100_000)),
            0x8000_0000_0000_0000,
        ),
        (String::from("1e1000000"), 0x7FF0_0000_0000_0000),
        (String::from("-1e+1000000"), 0xFFF0_0000_0000_0000),
        (String::from("1e-1000000"), 0x0000_0000_0000_0000),
        (String::from("-0.000e-1000000"), 0x8000_0000_0000_0000),
        (format!("1e{}100000", zeros(50)), 0x7FF0_0000_0000_0000),
        (format!("0e{}", "9".repeat(40)), 0x0000_0000_0000_0000),
    ];
    for (input, bits) in &cases {
        let shown = format!("{}…({} bytes)", &input[..input.len().min(24)], input.len());
        assert_eq!(
            number(&parse(input, JsonMode::Standard)).to_bits(),
            *bits,
            "JSON.parse({shown})"
        );
        assert_eq!(
            number(&parse(input, JsonMode::Lossless)).to_bits(),
            *bits,
            "Lossless parse({shown})"
        );
    }
}

/// JSON 공백은 SP·TAB·LF·CR뿐이다. VT·FF·NBSP·BOM·U+2028은 SyntaxError다.
#[test]
fn json_whitespace_is_space_tab_lf_cr_only() {
    assert_eq!(round_trip(" \t\n\r[ 1 , 2 ]\r\n\t "), "[1,2]");
    for prefix in ["\u{B}", "\u{C}", "\u{A0}", "\u{FEFF}", "\u{2028}"] {
        assert_syntax_error(format!("{prefix}[1]").as_bytes(), JsonMode::Standard);
        assert_syntax_error(format!("{prefix}[1]").as_bytes(), JsonMode::Lossless);
    }
}

/// 문법에 맞지 않는 입력은 두 모드 모두 SyntaxError다.
#[test]
fn malformed_text_is_a_syntax_error() {
    let inputs: &[&[u8]] = &[
        b"[1,]",
        b"{\"a\":1,}",
        b"01",
        b"-01",
        b"1.",
        b".5",
        b"+1",
        b"-",
        b"1e",
        b"1e+",
        b"1E-",
        b"1.e5",
        b"- 1",
        b"0x10",
        b"'a'",
        b"\"\x01\"",
        b"\"\t\"",
        b"\"\n\"",
        b"\"\\x\"",
        b"\"\\u12\"",
        b"\"\\u12g4\"",
        b"",
        b"  ",
        b"[",
        b"\"abc",
        b"{\"a\"}",
        b"{\"a\":}",
        b"{1:2}",
        b"{null:1}",
        b"[1 2]",
        b"true false",
        b"nul",
        b"tru",
        b"truex",
        b"True",
        b"/* c */ 1",
        b"[1]x",
        b"[1}",
        b"{\"a\":1]",
        b"[,1]",
        b"[1,,2]",
        b"{\"a\":1,\"b\"}",
    ];
    for input in inputs {
        assert_syntax_error(input, JsonMode::Standard);
        assert_syntax_error(input, JsonMode::Lossless);
    }
}

/// 무손실 토큰은 Standard 문법에 없다.
#[test]
fn lossless_tokens_are_rejected_in_standard_mode() {
    for input in [
        "NaN",
        "Infinity",
        "-Infinity",
        "undefined",
        "[undefined]",
        "-0e",
    ] {
        assert_syntax_error(input.as_bytes(), JsonMode::Standard);
    }
}

/// 무손실 모드는 NaN, ±Infinity, -0, undefined를 그대로 왕복한다(M0 BCJSON과 같다).
#[test]
fn lossless_round_trip_keeps_nan_negative_zero_infinity_and_undefined() {
    let cases = [
        "[NaN,-0,Infinity,undefined]",
        r#"[-Infinity,{"a":undefined,"b":NaN}]"#,
        "undefined",
        "-0",
        "NaN",
        r#"{"1":-0,"2":undefined,"z":Infinity}"#,
    ];
    for input in cases {
        assert_eq!(lossless_round_trip(input), input, "BCJSON 왕복 {input:?}");
    }
    let value = parse("[NaN,-0,Infinity,undefined]", JsonMode::Lossless);
    let items = array(&value);
    assert!(number(&items[0]).is_nan(), "NaN");
    assert_eq!(number(&items[1]).to_bits(), 0x8000_0000_0000_0000, "-0");
    assert_eq!(number(&items[2]), f64::INFINITY, "Infinity");
    assert!(matches!(items[3], JsValue::Undefined), "undefined");
}

/// 무손실 모드의 토큰은 정확한 철자만 받는다. `F64(…)` 토큰은 M1 범위 밖이라 거절한다.
#[test]
fn lossless_rejects_unknown_tokens() {
    let inputs = [
        "-NaN",
        "+Infinity",
        "Infinit",
        "nan",
        "infinity",
        "-undefined",
        "undefinedx",
        "NaN1",
        "[NaN,]",
        "F64(3,abcd)",
        "-Infinityx",
    ];
    for input in inputs {
        assert_syntax_error(input.as_bytes(), JsonMode::Lossless);
    }
}

/// 문자열 이스케이프는 `JSON.parse`와 같다. 원문 비ASCII·DEL·U+2028은 그대로 받는다.
#[test]
fn string_escapes_parse_like_json_parse() {
    let escaped = parse(
        r#""\"\\\/\b\f\n\r\t\u0000\u00E9\u00e9""#,
        JsonMode::Standard,
    );
    assert_eq!(
        string_units(&escaped),
        &[
            0x22, 0x5C, 0x2F, 0x08, 0x0C, 0x0A, 0x0D, 0x09, 0x00, 0xE9, 0xE9
        ],
        r#"JSON.parse('"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u00E9\\u00e9"')"#
    );
    let raw = parse("\"é€😀\u{2028}\u{7F}\"", JsonMode::Standard);
    assert_eq!(
        string_units(&raw),
        &[0xE9, 0x20AC, 0xD83D, 0xDE00, 0x2028, 0x7F]
    );
}

/// 올바르지 않은 UTF-8(잘린 다중 바이트, 과잉 인코딩, CESU 서로게이트, U+10FFFF 초과)은 SyntaxError다.
/// 단독 서로게이트는 `\uXXXX` 이스케이프로만 들어올 수 있다.
#[test]
fn invalid_utf8_is_a_syntax_error() {
    let inputs: &[&[u8]] = &[
        b"\"\xFF\"",
        b"\"\xC0\xAF\"",
        b"\"\xED\xA0\x80\"",
        b"\"\xE2\x82\"",
        b"\"\xF4\x90\x80\x80\"",
        b"[\xFF]",
        b"\"\xE2\x82",
    ];
    for input in inputs {
        assert_syntax_error(input, JsonMode::Standard);
        assert_syntax_error(input, JsonMode::Lossless);
    }
}

/// 자리표시 문자를 단독 서로게이트로 바꾼 UTF-16 코드 단위를 만든다(테스트 입력을 읽기 쉽게 적으려는 것).
///
/// U+E001 → 0xD83D(상위), U+E002 → 0xDE00(하위), U+E003 → 0xDC00(하위). 나머지는 그대로 UTF-16이다.
/// - `text`: 자리표시 문자를 쓴 문자열
/// - 반환: WTF-16 코드 단위
fn wtf16(text: &str) -> Vec<u16> {
    text.encode_utf16()
        .map(|unit| match unit {
            0xE001 => 0xD83D,
            0xE002 => 0xDE00,
            0xE003 => 0xDC00,
            other => other,
        })
        .collect()
}

/// 코드 단위 진입점(`parse_json_utf16`)은 JS 문자열에 `JSON.parse`를 한 것과 같다. 원문 단독 서로게이트도 다룬다.
///
/// 기대값은 같은 JS 문자열을 V8(Node 22.20.0), JSC(macOS 시스템 `jsc`), QuickJS 2026-06-04에서
/// `JSON.stringify(JSON.parse(text))`로 계산했고 17건 모두 세 엔진이 같았다(2026-11-02 실측). `None`은 SyntaxError다.
/// - 문자열 안의 원문 단독 서로게이트는 그 코드 단위다. 이스케이프와 이어지면 서로게이트 쌍이 된다.
/// - 문자열 밖(값 자리, 수 뒤)이나 역슬래시·`\u` 뒤의 원문 단독 서로게이트는 SyntaxError다.
/// - 바이트 진입점(`parse_json`)은 UTF-8만 받으므로 이 입력들을 손실 없이 나타낼 수 없다(리뷰 C5).
#[test]
fn utf16_input_keeps_raw_lone_surrogates_like_json_parse() {
    let cases: &[(&str, Option<&str>)] = &[
        ("{\"text\":\"\u{E001}\"}", Some(r#"{"text":"\ud83d"}"#)),
        ("\"\\\u{E001}\"", None),
        ("\"\\\\\u{E001}\"", Some(r#""\\\ud83d""#)),
        ("\u{E001}", None),
        ("\"\\u\u{E001}\"", None),
        ("[\u{E001}]", None),
        ("\"\u{E001}\\ude00\"", Some("\"\u{1F600}\"")),
        ("\"\\ud83d\u{E002}\"", Some("\"\u{1F600}\"")),
        ("{\"\u{E001}\":1}", Some(r#"{"\ud83d":1}"#)),
        ("\"\u{E001}\u{E002}\"", Some("\"\u{1F600}\"")),
        ("\"a\u{E003}b\"", Some(r#""a\udc00b""#)),
        ("\"\u{E002}\u{E001}\"", Some(r#""\ude00\ud83d""#)),
        ("[1\u{E001}]", None),
        ("\"\\uD8\u{E001}\"", None),
        ("\u{E001}1", None),
        (
            "{\"a\":{\"\u{E002}\":\"\u{E001}\"}}",
            Some(r#"{"a":{"\ude00":"\ud83d"}}"#),
        ),
        (
            "{\"\u{E001}\":\"\u{E002}\"}",
            Some(r#"{"\ud83d":"\ude00"}"#),
        ),
    ];
    for &(input, expected) in cases {
        let units = wtf16(input);
        let outcome = parse_json_utf16(&units, JsonMode::Standard);
        match (outcome, expected) {
            (Ok(value), Some(text)) => assert_eq!(
                stringify(&value, JsonMode::Standard),
                text,
                "JSON.stringify(JSON.parse({units:x?}))"
            ),
            (Err(error), None) => assert_eq!(error.name, "SyntaxError", "{units:x?}: {error:?}"),
            (outcome, expected) => {
                panic!("JSON.parse({units:x?}): expected {expected:?}, got {outcome:?}")
            }
        }
    }
}

/// 올바른 텍스트에서는 코드 단위 진입점과 바이트 진입점이 같은 값·같은 오류 이름을 낸다(두 모드 모두).
#[test]
fn utf16_and_utf8_entry_points_agree_on_well_formed_text() {
    let inputs = [
        "{\"b\":1,\"2\":[true,false,null],\"a\":\"é😀\\u2028\\ud800\",\"__proto__\":-0}",
        " [1e400, -1e-400, 0.1, 123456789012345678901234567890, \"\\\"\\\\\\/\\b\\f\\n\\r\\t\"] ",
        "[NaN,Infinity,-Infinity,undefined,-0]",
        "{\"a\":1,}",
        "[\"한글\u{3000}\", 1",
        "\"tab\tinside\"",
        "[01]",
        "\u{FEFF}[1]",
    ];
    for input in inputs {
        let units: Vec<u16> = input.encode_utf16().collect();
        for mode in [JsonMode::Standard, JsonMode::Lossless] {
            let from_units = parse_json_utf16(&units, mode);
            let from_bytes = parse_json(input.as_bytes(), mode);
            match (&from_units, &from_bytes) {
                (Ok(left), Ok(right)) => assert_eq!(
                    stringify(left, JsonMode::Lossless),
                    stringify(right, JsonMode::Lossless),
                    "{mode:?} {input:?}"
                ),
                (Err(left), Err(right)) => assert_eq!(left.name, right.name, "{mode:?} {input:?}"),
                _ => panic!("{mode:?} {input:?}: utf16 {from_units:?} vs utf8 {from_bytes:?}"),
            }
        }
    }
}

/// 코드 단위 진입점의 오류 위치는 코드 단위(JS 문자열 위치)다. 바이트 진입점은 바이트 위치다.
/// 무손실 모드와 원문 단독 서로게이트도 같은 파서로 읽는다.
#[test]
fn utf16_entry_point_reports_code_unit_positions_and_reads_lossless() {
    // x는 코드 단위로 8번째(😀가 두 단위), 바이트로 11번째(😀 4바이트, é 2바이트)다
    let text = "[\"\u{1F600}é\", x]";
    let units: Vec<u16> = text.encode_utf16().collect();
    let from_units = parse_json_utf16(&units, JsonMode::Standard).expect_err("x is not a value");
    assert!(
        from_units.message.to_string_lossy().starts_with("JSON: 8 "),
        "{from_units:?}"
    );
    let from_bytes = parse_json(text.as_bytes(), JsonMode::Standard).expect_err("x is not a value");
    assert!(
        from_bytes
            .message
            .to_string_lossy()
            .starts_with("JSON: 11 "),
        "{from_bytes:?}"
    );
    let nbsp = parse_json_utf16(&wtf16("[\u{A0}1]"), JsonMode::Standard).expect_err("NBSP");
    assert!(
        nbsp.message.to_string_lossy().contains("code unit 0x00a0"),
        "{nbsp:?}"
    );
    let lossless = parse_json_utf16(&wtf16("[NaN,\"\u{E001}\",-0]"), JsonMode::Lossless)
        .unwrap_or_else(|error| panic!("lossless parse failed: {error:?}"));
    assert_eq!(
        stringify(&lossless, JsonMode::Lossless),
        r#"[NaN,"\ud83d",-0]"#
    );
}

/// writer의 문자열 이스케이프는 `JSON.stringify`와 같다: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, 나머지 C0는
/// 소문자 `\u00xx`, 단독 서로게이트는 소문자 `\udxxx`, `/`·DEL·U+2028/2029·비ASCII는 원문이다.
#[test]
fn stringify_escapes_like_json_stringify() {
    let ascii: Vec<u16> = (0..0x80).collect();
    let expected_ascii = "\"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f !\\\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u{7F}\"";
    let ascii_value = JsValue::String(JsString::from_utf16(ascii));
    assert_eq!(
        stringify(&ascii_value, JsonMode::Standard),
        expected_ascii,
        "JSON.stringify(ASCII 0..0x7F)"
    );
    assert_eq!(
        stringify(&ascii_value, JsonMode::Lossless),
        expected_ascii,
        "Lossless 문자열 이스케이프"
    );
    let specials = JsValue::String(JsString::from_utf16(vec![
        0x2028, 0x2029, 0x7F, 0x2F, 0xE9, 0xD83D, 0xDE00, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xDC00,
        0xD800,
    ]));
    let expected_specials = "\"\u{2028}\u{2029}\u{7F}/é😀\\ud800\u{10FC00}\\udfff\\udc00\\ud800\"";
    assert_eq!(
        stringify(&specials, JsonMode::Standard),
        expected_specials,
        "JSON.stringify('\\u2028\\u2029\\u007f/\\u00e9\\uD83D\\uDE00\\uD800\\uDBFF\\uDC00\\uDFFF\\uDC00\\uD800')"
    );
}

/// 숫자는 `Number::toString`으로 쓰고, Standard는 비유한 수를 null로, -0을 0으로 쓴다.
#[test]
fn stringify_writes_numbers_like_js() {
    let numbers = [
        1e21,
        1e-7,
        0.1 + 0.2,
        -0.0,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        5e-324,
        123456789012345680000.0,
        1.5,
        -1e-7,
    ];
    let value = JsValue::Array(
        numbers
            .iter()
            .map(|&number| JsValue::Number(number))
            .collect(),
    );
    assert_eq!(
        stringify(&value, JsonMode::Standard),
        "[1e+21,1e-7,0.30000000000000004,0,null,null,null,5e-324,123456789012345680000,1.5,-1e-7]",
        "JSON.stringify([1e21, 1e-7, 0.1+0.2, -0, NaN, Infinity, -Infinity, 5e-324, 123456789012345680000, 1.5, -1e-7])"
    );
    assert_eq!(
        stringify(&value, JsonMode::Lossless),
        "[1e+21,1e-7,0.30000000000000004,-0,NaN,Infinity,-Infinity,5e-324,123456789012345680000,1.5,-1e-7]"
    );
    let flags = JsValue::Array(vec![
        JsValue::Bool(true),
        JsValue::Bool(false),
        JsValue::Null,
    ]);
    assert_eq!(stringify(&flags, JsonMode::Standard), "[true,false,null]");
}

/// 숫자는 방언대로 쓴다: QuickJS(Android 오라클)의 `JSON.stringify([2 ** -24])`는 17자리다(V8·JSC는 16자리).
///
/// JSON 텍스트 길이가 문서 한도와 undo 가중치를 정하므로(설계 §6.4) 1바이트 차이도 동작을 바꿀 수 있다(리뷰 C1).
/// 방언 인자가 없는 `stringify_json`은 이 빌드의 방언(`NumberDialect::PLATFORM`)을 쓴다.
#[test]
fn stringify_writes_numbers_in_the_given_dialect() {
    let value = JsValue::Array(vec![
        // 2 ** -24(비트 3e70000000000000)
        JsValue::Number(f64::from_bits(0x3E70_0000_0000_0000)),
        JsValue::Number(-0.0),
        JsValue::Number(1.5),
    ]);
    let written =
        |mode, dialect| match String::from_utf8(stringify_json_with(&value, mode, dialect)) {
            Ok(text) => text,
            Err(error) => panic!("{mode:?} {dialect:?} writer emitted invalid UTF-8: {error}"),
        };
    assert_eq!(
        written(JsonMode::Standard, NumberDialect::QuickJs),
        "[5.9604644775390625e-8,0,1.5]"
    );
    assert_eq!(
        written(JsonMode::Lossless, NumberDialect::QuickJs),
        "[5.9604644775390625e-8,-0,1.5]"
    );
    assert_eq!(
        written(JsonMode::Standard, NumberDialect::Ecma),
        "[5.960464477539063e-8,0,1.5]"
    );
    assert_eq!(
        stringify(&value, JsonMode::Standard),
        written(JsonMode::Standard, NumberDialect::PLATFORM)
    );
}

/// 객체 안의 undefined는 키째 빠지고 배열 안의 undefined는 null이 된다.
///
/// 최상위 undefined는 `JSON.stringify`가 텍스트 없이 undefined를 돌려주는 경우다. 커널은 바이트를 돌려주므로
/// 표준 결과 인코딩(설계 §4.2, `aster_jni.c:60`)처럼 `null`로 쓴다. Lossless는 `undefined` 토큰이다.
#[test]
fn stringify_drops_undefined_members_and_nulls_undefined_elements() {
    let mut members = JsObject::new();
    members.insert(key("a"), JsValue::Undefined);
    members.insert(key("b"), JsValue::Number(1.0));
    members.insert(key("c"), JsValue::Undefined);
    let value = JsValue::Array(vec![JsValue::Undefined, JsValue::Object(members)]);
    assert_eq!(
        stringify(&value, JsonMode::Standard),
        r#"[null,{"b":1}]"#,
        "JSON.stringify([undefined, {{a: undefined, b: 1, c: undefined}}])"
    );
    assert_eq!(
        stringify(&value, JsonMode::Lossless),
        r#"[undefined,{"a":undefined,"b":1,"c":undefined}]"#
    );
    assert_eq!(stringify(&JsValue::Undefined, JsonMode::Standard), "null");
    assert_eq!(
        stringify(&JsValue::Undefined, JsonMode::Lossless),
        "undefined"
    );
    let nested = parse(r#"{"a":[],"b":{},"c":[[]],"d":[{}]}"#, JsonMode::Standard);
    assert_eq!(
        stringify(&nested, JsonMode::Standard),
        r#"{"a":[],"b":{},"c":[[]],"d":[{}]}"#
    );
}

/// 대입 의미: 덮어쓰기는 자리를 지키고, 지운 뒤 다시 넣은 키는 끝으로 간다. undefined를 담은 키도 자리를 지킨다.
#[test]
fn object_assignment_semantics_match_js() {
    // var o = JSON.parse('{"a":1,"b":2,"c":3}'); delete o.a; o.a = 4; JSON.stringify(o)
    let mut value = parse(r#"{"a":1,"b":2,"c":3}"#, JsonMode::Standard);
    if let JsValue::Object(members) = &mut value {
        assert_eq!(members.remove(&key("a")).as_ref().map(number), Some(1.0));
        members.insert(key("a"), JsValue::Number(4.0));
    }
    assert_eq!(
        stringify(&value, JsonMode::Standard),
        r#"{"b":2,"c":3,"a":4}"#
    );

    // var o = JSON.parse('{"a":1,"b":2}'); o.a = 5
    let mut overwritten = parse(r#"{"a":1,"b":2}"#, JsonMode::Standard);
    if let JsValue::Object(members) = &mut overwritten {
        members.insert(key("a"), JsValue::Number(5.0));
    }
    assert_eq!(
        stringify(&overwritten, JsonMode::Standard),
        r#"{"a":5,"b":2}"#
    );

    // var o = JSON.parse('{"a":1,"b":2}'); o.a = undefined; o.c = 3; o.a = 9
    let mut kept = parse(r#"{"a":1,"b":2}"#, JsonMode::Standard);
    if let JsValue::Object(members) = &mut kept {
        members.insert(key("a"), JsValue::Undefined);
        members.insert(key("c"), JsValue::Number(3.0));
        assert_eq!(members.len(), 3, "undefined를 담은 키도 자기 키다");
        members.insert(key("a"), JsValue::Number(9.0));
    }
    assert_eq!(
        stringify(&kept, JsonMode::Standard),
        r#"{"a":9,"b":2,"c":3}"#
    );
}

/// `JsObject` API: 인덱스 키와 일반 키의 조회·삭제·길이·순회.
#[test]
fn object_api_tracks_js_semantics() {
    let mut members = JsObject::new();
    assert!(members.is_empty());
    for (name, value) in [
        ("b", 1.0),
        ("01", 2.0),
        ("1", 3.0),
        ("4294967295", 4.0),
        ("0", 5.0),
    ] {
        members.insert(key(name), JsValue::Number(value));
    }
    let order: Vec<String> = members
        .iter()
        .map(|(name, _)| name.to_string_lossy())
        .collect();
    assert_eq!(order, ["0", "1", "b", "01", "4294967295"]);
    assert_eq!(members.len(), 5);
    assert_eq!(members.get(&key("1")).map(number), Some(3.0));
    assert_eq!(
        members.get(&key("01")).map(number),
        Some(2.0),
        "'01'은 '1'과 다른 일반 키"
    );
    assert!(members.get(&key("2")).is_none());
    assert_eq!(members.remove(&key("1")).as_ref().map(number), Some(3.0));
    assert!(members.remove(&key("1")).is_none(), "두 번 지우면 None");
    assert_eq!(members.remove(&key("b")).as_ref().map(number), Some(1.0));
    let order: Vec<String> = members
        .iter()
        .map(|(name, _)| name.to_string_lossy())
        .collect();
    assert_eq!(order, ["0", "01", "4294967295"]);
    assert_eq!(members.len(), 3);
    assert!(!members.is_empty());
}

/// 단순 모델(삽입 순서 목록)을 JS 자기 키 순서로 늘어놓는다: 배열 인덱스 키 오름차순, 나머지는 삽입 순서.
///
/// - `model`: (키, 값) 목록. 덮어쓰기는 자리를 지키고 삭제는 항목을 뺀 상태다
/// - 반환: JS 순서의 (키, 값) 목록
fn js_key_order(model: &[(String, f64)]) -> Vec<(String, f64)> {
    let index_of = |name: &str| {
        name.parse::<u32>()
            .ok()
            .filter(|index| index.to_string() == name && *index < u32::MAX)
    };
    let mut ordered: Vec<(String, f64)> = model
        .iter()
        .filter(|(name, _)| index_of(name).is_some())
        .cloned()
        .collect();
    ordered.sort_by_key(|(name, _)| index_of(name));
    ordered.extend(
        model
            .iter()
            .filter(|(name, _)| index_of(name).is_none())
            .cloned(),
    );
    ordered
}

/// 객체의 (키, 값)을 순회 순서대로 모은다. 값은 숫자여야 한다.
///
/// - `members`: 객체
/// - 반환: (키, 값) 목록
fn numeric_entries(members: &JsObject) -> Vec<(String, f64)> {
    members
        .iter()
        .map(|(name, value)| (name.to_string_lossy(), number(value)))
        .collect()
}

/// 키가 많은 객체도 JS 순서와 마지막 값 규칙을 지킨다(조회 색인을 쓰는 경로). 단순 모델과 비교한다.
#[test]
fn large_objects_keep_js_order_and_last_value() {
    let mut model: Vec<(String, f64)> = Vec::new();
    let mut members = JsObject::new();
    let mut text = String::from("{");
    for step in 0..3000_u32 {
        // 세 번에 한 번은 흩어진 순서의 인덱스 키, 나머지는 중복이 섞인 일반 키
        let name = if step % 3 == 0 {
            (step * 7919 % 5000).to_string()
        } else {
            format!("k{}", step * 31 % 1500)
        };
        let value = f64::from(step);
        match model.iter_mut().find(|(existing, _)| *existing == name) {
            Some(entry) => entry.1 = value,
            None => model.push((name.clone(), value)),
        }
        members.insert(key(&name), JsValue::Number(value));
        if step > 0 {
            text.push(',');
        }
        text.push_str(&format!("\"{name}\":{step}"));
    }
    text.push('}');
    assert_eq!(
        numeric_entries(&members),
        js_key_order(&model),
        "insert 순서"
    );
    let parsed = parse(&text, JsonMode::Standard);
    assert_eq!(
        numeric_entries(object(&parsed)),
        js_key_order(&model),
        "JSON.parse 순서"
    );
    assert_eq!(object(&parsed).len(), model.len());

    for step in (0..3000_u32).step_by(7) {
        let name = format!("k{}", step * 31 % 1500);
        let expected = model
            .iter()
            .position(|(existing, _)| *existing == name)
            .map(|index| model.remove(index).1);
        assert_eq!(
            members.remove(&key(&name)).as_ref().map(number),
            expected,
            "delete o[{name:?}]"
        );
    }
    // k217은 step 7·1507에 넣고 위 삭제(step 7)로 지운 키다. 다시 넣으면 끝에 붙는다
    assert!(members.get(&key("k217")).is_none(), "k217은 지워진 상태");
    members.insert(key("k217"), JsValue::Number(-1.0));
    model.push((String::from("k217"), -1.0));
    assert_eq!(
        numeric_entries(&members),
        js_key_order(&model),
        "delete 뒤 순서"
    );
    assert_eq!(members.len(), model.len());
}

/// Untrusted wide objects use amortized collection plus one numeric-key sort. This regression uses
/// descending numeric keys (the worst order for sorted insertion) and 100k named keys, then checks
/// ordinary own-property order and duplicate replacement without serializing another wide buffer.
#[test]
fn scoped_parser_handles_100k_numeric_and_named_keys_without_quadratic_insertion() {
    const WIDTH: usize = 100_000;
    let mut text = String::new();
    text.try_reserve(WIDTH * 24).unwrap();
    text.push('{');
    for index in (0..WIDTH).rev() {
        if index + 1 != WIDTH {
            text.push(',');
        }
        text.push('"');
        text.push_str(&index.to_string());
        text.push_str("\":");
        text.push_str(&index.to_string());
    }
    for index in 0..WIDTH {
        text.push(',');
        text.push_str("\"k");
        text.push_str(&index.to_string());
        text.push_str("\":");
        text.push_str(&index.to_string());
    }
    text.push_str(",\"50000\":-1,\"k50000\":-2}");

    let account = MemoryAccount::new(512 * 1024 * 1024, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&account);
        let parsed = parse_json_scoped(
            text.as_bytes(),
            JsonMode::Standard,
            NumberDialect::Ecma,
            &mut scope,
        )
        .expect("wide object must parse under the counted scope");
        let members = object(&parsed);
        assert_eq!(members.len(), WIDTH * 2);
        assert_eq!(members.get(&key("50000")).map(number), Some(-1.0));
        assert_eq!(members.get(&key("k50000")).map(number), Some(-2.0));
        let mut entries = members.iter();
        assert_eq!(
            entries.next().map(|(name, _)| name.to_string_lossy()),
            Some("0".into())
        );
        assert_eq!(
            entries
                .nth(WIDTH - 2)
                .map(|(name, _)| name.to_string_lossy()),
            Some((WIDTH - 1).to_string())
        );
        assert_eq!(
            entries.next().map(|(name, _)| name.to_string_lossy()),
            Some("k0".into())
        );
        assert!(scope.requested_bytes() > text.len() as u64);
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

/// Parser, iterative clone, and writer all fail through the scoped memory channel before their
/// next wide grow, leave no account bytes live after the scope, and keep syntax distinct.
#[test]
fn scoped_json_paths_fail_deterministically_and_release_temporary_bytes() {
    let large = format!("[\"{}\"]", "x".repeat(4_096));

    let parse_account = MemoryAccount::new(512, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&parse_account);
        assert!(matches!(
            parse_json_scoped(
                large.as_bytes(),
                JsonMode::Standard,
                NumberDialect::Ecma,
                &mut scope
            ),
            Err(JsonFailure::Memory(_))
        ));
    }
    assert_eq!(parse_account.snapshot().requested_live_bytes, 0);

    let syntax_account = MemoryAccount::new(4_096, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&syntax_account);
        assert!(matches!(
            parse_json_scoped(b"[1,]", JsonMode::Standard, NumberDialect::Ecma, &mut scope),
            Err(JsonFailure::Syntax(_))
        ));
    }
    assert_eq!(syntax_account.snapshot().requested_live_bytes, 0);

    let value = parse(&large, JsonMode::Standard);
    let success_account = MemoryAccount::new(1024 * 1024, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&success_account);
        let copy = value.try_clone_scoped(&mut scope).unwrap();
        let encoded =
            stringify_json_scoped(&copy, JsonMode::Standard, NumberDialect::Ecma, &mut scope)
                .unwrap();
        assert_eq!(
            encoded,
            stringify_json_with(&value, JsonMode::Standard, NumberDialect::Ecma)
        );
    }
    assert_eq!(success_account.snapshot().requested_live_bytes, 0);

    let clone_account = MemoryAccount::new(512, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&clone_account);
        assert!(value.try_clone_scoped(&mut scope).is_err());
    }
    assert_eq!(clone_account.snapshot().requested_live_bytes, 0);

    let write_account = MemoryAccount::new(512, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&write_account);
        assert!(
            stringify_json_scoped(&value, JsonMode::Standard, NumberDialect::Ecma, &mut scope)
                .is_err()
        );
    }
    assert_eq!(write_account.snapshot().requested_live_bytes, 0);
}

/// 깊이 100,000 중첩도 스택 넘침 없이 파싱·쓰기·복제·해제한다(Review Focus 2).
///
/// 엔진마다 다르다(2026-11-02 실측). V8과 JSC는 깊이 100,000 `JSON.parse`가 되지만, 이 하네스의 QuickJS는
/// 깊이 10,000에서 `SyntaxError: stack overflow`를 낸다. `JSON.stringify`는 V8·QuickJS가 깊이 10,000에서,
/// JSC가 100,000에서 스택 오류를 낸다. 커널은 반복으로 구현하므로 모두 성공한다.
#[test]
fn deep_nesting_does_not_overflow_the_stack() {
    const DEPTH: usize = 100_000;
    let arrays = format!("{}{}", "[".repeat(DEPTH), "]".repeat(DEPTH));
    let value = parse(&arrays, JsonMode::Standard);
    let mut depth = 0;
    let mut current = &value;
    while let JsValue::Array(items) = current {
        depth += 1;
        match items.first() {
            Some(next) => current = next,
            None => break,
        }
    }
    assert_eq!(depth, DEPTH, "중첩 깊이");
    assert_eq!(stringify(&value, JsonMode::Standard), arrays);
    let copy = value.clone();
    drop(value);
    assert_eq!(stringify(&copy, JsonMode::Lossless), arrays);
    drop(copy);

    let objects = format!("{}1{}", r#"{"a":"#.repeat(DEPTH), "}".repeat(DEPTH));
    assert_eq!(round_trip(&objects), objects);
    assert_eq!(lossless_round_trip(&objects), objects);
    let unclosed = "[".repeat(DEPTH);
    assert_syntax_error(unclosed.as_bytes(), JsonMode::Standard);
}

/// 오류 문구는 엔진마다 다르므로 계약이 아니다(D8). 진단을 위해 모드 접두어와 바이트 위치를 담는다.
/// Lossless는 M0 BCJSON 형식(`BCJSON: <위치> <이유>`)이다.
#[test]
fn syntax_errors_name_the_mode_and_byte_offset() {
    let lossless = parse_json(b"[1,]", JsonMode::Lossless)
        .err()
        .map(|error| error.message.to_string_lossy());
    assert!(
        lossless
            .as_deref()
            .is_some_and(|message| message.starts_with("BCJSON: 3 ")),
        "{lossless:?}"
    );
    let standard = parse_json(b"[1,]", JsonMode::Standard)
        .err()
        .map(|error| error.message.to_string_lossy());
    assert!(
        standard
            .as_deref()
            .is_some_and(|message| message.starts_with("JSON: 3 ")),
        "{standard:?}"
    );
}

/// Debug 출력은 무손실 JSON 텍스트다(-0, NaN, undefined가 보인다).
#[test]
fn debug_shows_lossless_json() {
    let value = parse(r#"[1,"a",null,{"k":-0}]"#, JsonMode::Standard);
    assert_eq!(format!("{value:?}"), r#"[1,"a",null,{"k":-0}]"#);
    let members = object(&parse(r#"{"x":NaN,"y":undefined}"#, JsonMode::Lossless)).clone();
    assert_eq!(format!("{members:?}"), r#"{"x":NaN,"y":undefined}"#);
}
