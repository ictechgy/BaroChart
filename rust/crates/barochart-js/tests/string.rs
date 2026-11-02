//! 문자열 커널(`string`) 고정 벡터.
//!
//! 기대값은 같은 JS 식을 V8(Node 22.20.0), JSC(macOS 시스템 `jsc`), QuickJS(`native/android/quickjs`
//! 2026-06-04)에서 계산해 세 엔진이 모두 같은 값을 낸 것만 넣었다(2026-11-02 실측). 실패 문구의 JS 식이
//! 그 원본이다. 공백 표는 0..=0xFFFF 코드 단위 전부를 세 엔진의 `trim`과 정규식 `\s`로 조사한 결과다.
//! 대량 대조는 Task 4의 대조 하네스가 맡는다.

use barochart_js::string::{JsString, is_js_whitespace};

/// JS 공백 표. `String.prototype.trim`과 정규식 `\s`가 지우는 코드 단위 25개다.
///
/// U+FEFF는 들어 있고 U+0085·U+180E·U+200B는 없다. Rust `char::is_whitespace`는 U+0085를 공백으로 보고
/// U+FEFF를 공백으로 보지 않아 이 표와 다르다(설계 §6.4, 이식 지도 §3.1.2).
const JS_WHITESPACE: [u16; 25] = [
    0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
    0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
    0xFEFF,
];

/// UTF-8 리터럴을 커널 문자열로 바꾼다.
///
/// - `text`: 바꿀 문자열
/// - 반환: 같은 내용의 WTF-16 문자열
fn js(text: &str) -> JsString {
    JsString::from_str(text)
}

/// 코드 단위 목록으로 커널 문자열을 만든다. 단독 서로게이트를 적을 때 쓴다.
///
/// - `list`: UTF-16 코드 단위
/// - 반환: 그 코드 단위를 그대로 담은 문자열
fn units(list: &[u16]) -> JsString {
    JsString::from_utf16(list.to_vec())
}

/// `.length`는 UTF-16 코드 단위 수다. 보충 평면 문자 하나는 2다.
#[test]
fn length_counts_utf16_code_units() {
    assert_eq!(js("😀").len_utf16(), 2, "'😀'.length");
    assert_eq!(js("a").len_utf16(), 1, "'a'.length");
    assert_eq!(js("").len_utf16(), 0, "''.length");
    assert_eq!(
        js("a😀").as_units(),
        &[0x61, 0xD83D, 0xDE00],
        "'a😀'의 코드 단위"
    );
    assert_eq!(JsString::default(), js(""), "기본값은 빈 문자열");
}

/// `slice`는 코드 단위로 자르므로 서로게이트 쌍을 가를 수 있다(설계 §6.4, Review Focus 3).
#[test]
fn slice_splits_a_surrogate_pair() {
    let emoji = js("😀");
    assert_eq!(emoji.slice(0, Some(1)), units(&[0xD83D]), "'😀'.slice(0,1)");
    assert_eq!(emoji.slice(1, None), units(&[0xDE00]), "'😀'.slice(1)");
}

/// `String.prototype.slice`의 위치 규칙: 음수는 끝에서 세고, 범위를 넘으면 자르고, 시작이 끝 이상이면 빈 문자열이다.
#[test]
fn slice_follows_js_index_rules() {
    let text = js("abcdef");
    let cases: &[(isize, Option<isize>, &str, &str)] = &[
        (-2, None, "ef", "'abcdef'.slice(-2)"),
        (2, Some(-1), "cde", "'abcdef'.slice(2,-1)"),
        (4, Some(2), "", "'abcdef'.slice(4,2)"),
        (-100, Some(100), "abcdef", "'abcdef'.slice(-100,100)"),
        (6, None, "", "'abcdef'.slice(6)"),
        (0, Some(0), "", "'abcdef'.slice(0,0)"),
        (-1, Some(-3), "", "'abcdef'.slice(-1,-3)"),
        (7, None, "", "'abcdef'.slice(7)"),
        (-7, Some(2), "ab", "'abcdef'.slice(-7,2)"),
        (
            isize::MIN,
            Some(isize::MAX),
            "abcdef",
            "'abcdef'.slice(-1e300,1e300)",
        ),
        (isize::MAX, None, "", "'abcdef'.slice(1e300)"),
        (0, Some(isize::MIN), "", "'abcdef'.slice(0,-1e300)"),
    ];
    for &(start, end, expected, label) in cases {
        assert_eq!(text.slice(start, end), js(expected), "{label}");
    }
    assert_eq!(js("").slice(0, Some(1)), js(""), "''.slice(0,1)");
}

/// 공백 판정은 코드 단위 0..=0xFFFF 전부에서 JS 표와 같다(U+FEFF는 공백, U+0085·U+180E는 공백 아님).
#[test]
fn whitespace_table_matches_js_for_every_code_unit() {
    for unit in 0..=u16::MAX {
        assert_eq!(
            is_js_whitespace(unit),
            JS_WHITESPACE.contains(&unit),
            "String.fromCharCode(0x{unit:04X}).trim().length === 0"
        );
    }
}

/// `trim`은 JS 공백 표로 양끝을 지운다. 단독 서로게이트는 공백이 아니라 남는다.
#[test]
fn trim_uses_the_js_whitespace_table() {
    let cases: &[(JsString, JsString, &str)] = &[
        (
            js("\u{FEFF} a \u{85}"),
            js("a \u{85}"),
            "'\\uFEFF a \\u0085'.trim()",
        ),
        (js("\u{180E} a"), js("\u{180E} a"), "'\\u180E a'.trim()"),
        (
            units(&[0x20, 0xD800, 0x20]),
            units(&[0xD800]),
            "' \\uD800 '.trim()",
        ),
        (
            js(" \t\n\u{3000}\u{FEFF}"),
            js(""),
            "' \\t\\n\\u3000\\uFEFF'.trim()",
        ),
        (
            js("\u{A0}a\u{2028}b\u{A0}"),
            js("a\u{2028}b"),
            "'\\u00A0a\\u2028b\\u00A0'.trim()",
        ),
        (
            js("\u{200B}a\u{200B}"),
            js("\u{200B}a\u{200B}"),
            "'\\u200Ba\\u200B'.trim()",
        ),
        (js("\u{B}a\u{C}"), js("a"), "'\\u000Ba\\u000C'.trim()"),
        (js("abc"), js("abc"), "'abc'.trim()"),
    ];
    for (input, expected, label) in cases {
        assert_eq!(&input.trim(), expected, "{label}");
    }
}

/// `toLowerCase`는 전체 유니코드 소문자 변환이다. Kelvin 기호, final sigma, 확장 매핑(U+0130)을 따르고
/// 단독 서로게이트는 그대로 둔다. 단독 서로게이트는 final sigma 문맥을 끊는다(세 엔진 실측).
#[test]
fn to_lowercase_matches_js() {
    let cases: &[(JsString, JsString, &str)] = &[
        (
            js("blac\u{212A}"),
            js("black"),
            "'blac\\u212A'.toLowerCase()",
        ),
        (js("ΑΣ"), js("ας"), "'\\u0391\\u03A3'.toLowerCase()"),
        (
            units(&[0x391, 0x3A3, 0xD800]),
            units(&[0x3B1, 0x3C2, 0xD800]),
            "'\\u0391\\u03A3\\uD800'.toLowerCase()",
        ),
        (
            units(&[0xD800, 0x3A3]),
            units(&[0xD800, 0x3C3]),
            "'\\uD800\\u03A3'.toLowerCase()",
        ),
        (
            units(&[0x391, 0x3A3, 0xD800, 0x391]),
            units(&[0x3B1, 0x3C2, 0xD800, 0x3B1]),
            "'\\u0391\\u03A3\\uD800\\u0391'.toLowerCase()",
        ),
        (
            units(&[0x391, 0x3A3, 0xDC00]),
            units(&[0x3B1, 0x3C2, 0xDC00]),
            "'\\u0391\\u03A3\\uDC00'.toLowerCase()",
        ),
        (
            js("ΑΣΑ"),
            js("ασα"),
            "'\\u0391\\u03A3\\u0391'.toLowerCase()",
        ),
        (js("ΑΣ."), js("ας."), "'\\u0391\\u03A3.'.toLowerCase()"),
        (
            js("ΑΣ.Α"),
            js("ασ.α"),
            "'\\u0391\\u03A3.\\u0391'.toLowerCase()",
        ),
        (js("Σ"), js("σ"), "'\\u03A3'.toLowerCase()"),
        (
            js("ΑΣ Α"),
            js("ας α"),
            "'\\u0391\\u03A3 \\u0391'.toLowerCase()",
        ),
        (
            js("ΑΣ\u{AD}"),
            js("ας\u{AD}"),
            "'\\u0391\\u03A3\\u00AD'.toLowerCase()",
        ),
        (
            js("Α\u{AD}Σ"),
            js("α\u{AD}ς"),
            "'\\u0391\\u00AD\\u03A3'.toLowerCase()",
        ),
        (
            js("ΟΔΟΣ ΟΔΟΣ"),
            js("οδος οδος"),
            "'\\u039F\\u0394\\u039F\\u03A3 \\u039F\\u0394\\u039F\\u03A3'.toLowerCase()",
        ),
        (js("\u{130}"), js("i\u{307}"), "'\\u0130'.toLowerCase()"),
        (js("A😀B"), js("a😀b"), "'A\\uD83D\\uDE00B'.toLowerCase()"),
        (
            js("\u{10400}"),
            js("\u{10428}"),
            "'\\uD801\\uDC00'.toLowerCase()",
        ),
        (
            units(&[0xDC00, 0xD800]),
            units(&[0xDC00, 0xD800]),
            "'\\uDC00\\uD800'.toLowerCase()",
        ),
        (
            units(&[0xD800, 0xD801, 0xDC00]),
            units(&[0xD800, 0xD801, 0xDC28]),
            "'\\uD800\\uD801\\uDC00'.toLowerCase()",
        ),
        (
            js("Hello WORLD 123"),
            js("hello world 123"),
            "'Hello WORLD 123'.toLowerCase()",
        ),
    ];
    for (input, expected, label) in cases {
        assert_eq!(&input.to_lowercase(), expected, "{label}");
    }
}

/// 순서는 코드 단위 사전순이라 JS 비교 연산자와 같다. Rust `str` 순서(코드 포인트)와는 다르다.
#[test]
fn ordering_compares_code_units_like_js() {
    // JS: '｡' < '😀'는 false다(0xFF61 > 0xD83D). 코드 포인트로는 U+FF61 < U+1F600이다
    assert!(
        js("\u{FF61}") > js("😀"),
        "'\\uFF61' < '\\uD83D\\uDE00' === false"
    );
    assert!("\u{FF61}" < "😀", "Rust str은 코드 포인트 순서다");
    assert!(js("a") < js("b"), "'a' < 'b'");
}

/// 진단용 변환은 단독 서로게이트를 U+FFFD로 바꾼다.
#[test]
fn lossy_conversion_replaces_lone_surrogates() {
    assert_eq!(units(&[0x61, 0xD800, 0x62]).to_string_lossy(), "a\u{FFFD}b");
    assert_eq!(js("a😀").to_string_lossy(), "a😀");
}

/// Debug 출력은 Rust 문자열 이스케이프를 쓰고 단독 서로게이트를 `\u{d800}`으로 보인다.
#[test]
fn debug_escapes_lone_surrogates() {
    assert_eq!(
        format!("{:?}", units(&[0x61, 0xD800, 0x0A])),
        "\"a\\u{d800}\\n\""
    );
    assert_eq!(format!("{:?}", js("ας😀")), "\"ας😀\"");
}
