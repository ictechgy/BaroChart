use barochart_core::checkpoint_codec;

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use checkpoint_codec::{
    safe_checkpoint_parse_scoped, safe_checkpoint_parse_with as safe_checkpoint_parse,
    safe_checkpoint_stringify_scoped, safe_checkpoint_stringify_with as safe_checkpoint_stringify,
    safe_checkpoint_stringify_with,
};

fn value(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn text(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Lossless)).unwrap()
}

fn error<T: std::fmt::Debug>(result: Result<T, barochart_js::error::JsError>) -> (String, String) {
    let failure = result.unwrap_err();
    (failure.name.to_owned(), failure.message.to_string_lossy())
}

#[test]
fn checkpoint_stringify_tags_special_numbers_and_preserves_input_key_order() {
    let input = value(
        r#"{"negativeZero":-0,"nan":NaN,"positive":Infinity,"negative":-Infinity,"plain":1}"#,
    );
    assert_eq!(
        safe_checkpoint_stringify(&input, NumberDialect::Ecma)
            .unwrap()
            .to_string_lossy(),
        r#"{"negativeZero":{"$asterNumber":"-0"},"nan":{"$asterNumber":"NaN"},"positive":{"$asterNumber":"Infinity"},"negative":{"$asterNumber":"-Infinity"},"plain":1}"#
    );
}

#[test]
fn checkpoint_parse_restores_exact_number_markers_including_at_root() {
    let parsed = safe_checkpoint_parse(
        &JsValue::String(JsString::from_str(r#"{"v":[{"$asterNumber":"NaN"},{"$asterNumber":"Infinity"},{"$asterNumber":"-Infinity"},{"$asterNumber":"-0"},0]}"#)),
        NumberDialect::Ecma,
    )
    .unwrap();
    let JsValue::Object(object) = &parsed else {
        panic!("expected object")
    };
    let JsValue::Array(values) = object.get(&JsString::from_str("v")).unwrap() else {
        panic!("expected array")
    };
    assert!(matches!(&values[0], JsValue::Number(value) if value.is_nan()));
    assert!(matches!(&values[1], JsValue::Number(value) if *value == f64::INFINITY));
    assert!(matches!(&values[2], JsValue::Number(value) if *value == f64::NEG_INFINITY));
    assert!(
        matches!(&values[3], JsValue::Number(value) if *value == 0.0 && value.is_sign_negative())
    );
    assert!(
        matches!(safe_checkpoint_parse(&JsValue::String(JsString::from_str(r#"{"$asterNumber":"-0"}"#)), NumberDialect::Ecma).unwrap(), JsValue::Number(value) if value == 0.0 && value.is_sign_negative())
    );
    assert_eq!(
        text(
            &safe_checkpoint_parse(
                &JsValue::String(JsString::from_str(r#"{"$asterNumber":"NaN"}"#)),
                NumberDialect::Ecma
            )
            .unwrap()
        ),
        "NaN"
    );
}

#[test]
fn checkpoint_parse_preserves_raw_finite_json_negative_zero_and_underflow() {
    let parsed = safe_checkpoint_parse(
        &JsValue::String(JsString::from_str(r#"[-0,1e-400,0.1]"#)),
        NumberDialect::Ecma,
    )
    .unwrap();
    let JsValue::Array(values) = &parsed else {
        panic!("expected array")
    };
    assert!(
        matches!(&values[0], JsValue::Number(value) if *value == 0.0 && value.is_sign_negative())
    );
    assert!(
        matches!(&values[1], JsValue::Number(value) if *value == 0.0 && !value.is_sign_negative())
    );
    assert_eq!(text(&values[2]), "0.1");
}

#[test]
fn checkpoint_codec_uses_the_requested_number_dialect_for_json_text() {
    let value = JsValue::Number(2.0_f64.powi(-24));
    assert_eq!(
        safe_checkpoint_stringify_with(&value, NumberDialect::Ecma)
            .unwrap()
            .to_string_lossy(),
        if NumberDialect::PLATFORM == NumberDialect::QuickJs {
            "5.9604644775390625e-8"
        } else {
            "5.960464477539063e-8"
        }
    );
    assert_eq!(
        safe_checkpoint_stringify_with(&value, NumberDialect::QuickJs)
            .unwrap()
            .to_string_lossy(),
        "5.9604644775390625e-8"
    );
    assert_eq!(
        safe_checkpoint_stringify(&value, NumberDialect::PLATFORM)
            .unwrap()
            .to_string_lossy(),
        "5.960464477539063e-8"
    );
    let tie = format!("9007199254740993.{}1", "0".repeat(22));
    let input = JsValue::String(JsString::from_str(&format!("[{tie}]")));
    let ecma = safe_checkpoint_parse(&input, NumberDialect::Ecma).unwrap();
    let quickjs = safe_checkpoint_parse(&input, NumberDialect::QuickJs).unwrap();
    assert!(
        matches!(&ecma, JsValue::Array(values) if matches!(&values[0], JsValue::Number(value) if value.to_bits() == 9_007_199_254_740_994.0_f64.to_bits()))
    );
    assert!(
        matches!(&quickjs, JsValue::Array(values) if matches!(&values[0], JsValue::Number(value) if value.to_bits() == 9_007_199_254_740_992.0_f64.to_bits()))
    );
}

#[test]
fn checkpoint_default_entrypoints_follow_the_platform_dialect() {
    let value = JsValue::Number(2.0_f64.powi(-24));
    assert_eq!(
        checkpoint_codec::safe_checkpoint_stringify(&value)
            .unwrap()
            .to_string_lossy(),
        "5.960464477539063e-8"
    );
    let parsed =
        checkpoint_codec::safe_checkpoint_parse(&JsValue::String(JsString::from_str("[-0]")))
            .unwrap();
    assert!(
        matches!(&parsed, JsValue::Array(items) if matches!(&items[0], JsValue::Number(number) if *number == 0.0 && number.is_sign_negative()))
    );
}

#[test]
fn checkpoint_parse_checks_text_type_and_size_before_scanning() {
    assert_eq!(
        error(safe_checkpoint_parse(&JsValue::Null, NumberDialect::Ecma)),
        ("RangeError".into(), "Checkpoint text limit".into())
    );
    let too_long = JsValue::String(JsString::from_utf16(vec![0x20; 8_388_609]));
    assert_eq!(
        error(safe_checkpoint_parse(&too_long, NumberDialect::Ecma)),
        ("RangeError".into(), "Checkpoint text limit".into())
    );
    assert_eq!(
        error(safe_checkpoint_stringify(
            &JsValue::String(JsString::from_utf16(vec![0x61; 8_388_609])),
            NumberDialect::Ecma
        )),
        ("RangeError".into(), "Checkpoint text limit".into())
    );
}

#[test]
fn checkpoint_raw_scan_rejects_duplicate_keys_depth_and_overflow_in_order() {
    for text in [r#"{"x":1,"x":2}"#, r#"{"x":"v","x":2}"#] {
        assert_eq!(
            error(safe_checkpoint_parse(
                &JsValue::String(JsString::from_str(text)),
                NumberDialect::Ecma
            )),
            ("TypeError".into(), "Checkpoint duplicate state key".into())
        );
    }
    let depth_32 = "[".repeat(32) + "0" + &"]".repeat(32);
    assert!(
        safe_checkpoint_parse(
            &JsValue::String(JsString::from_str(&depth_32)),
            NumberDialect::Ecma
        )
        .is_ok()
    );
    let depth_33 = "[".repeat(33) + "0" + &"]".repeat(33);
    assert_eq!(
        error(safe_checkpoint_parse(
            &JsValue::String(JsString::from_str(&depth_33)),
            NumberDialect::Ecma
        )),
        ("RangeError".into(), "Checkpoint depth limit".into())
    );
    for text in [r#"{"x":1e400}"#, "[-]", "[1.2.3]"] {
        assert_eq!(
            error(safe_checkpoint_parse(
                &JsValue::String(JsString::from_str(text)),
                NumberDialect::Ecma
            )),
            (
                "TypeError".into(),
                "Checkpoint untagged nonfinite number".into()
            )
        );
    }
    // JS JSON.parse syntax-error wording varies by engine; Tier-A fixes the error class, while the scanner errors above have exact messages.
    for text in ["01", "00.1", "1.", "1.e2"] {
        let failure = safe_checkpoint_parse(
            &JsValue::String(JsString::from_str(text)),
            NumberDialect::Ecma,
        )
        .unwrap_err();
        assert_eq!(
            failure.name, "SyntaxError",
            "{text} is finite to Number() but not valid JSON"
        );
    }
    let scanner_cases = [
        ("[-.5]", "SyntaxError", None),
        ("[-.0e99]", "SyntaxError", None),
        ("[-1.]", "SyntaxError", None),
        (
            "[-e1]",
            "TypeError",
            Some("Checkpoint untagged nonfinite number"),
        ),
        (
            "[1e+]",
            "TypeError",
            Some("Checkpoint untagged nonfinite number"),
        ),
        (
            "[1e400]",
            "TypeError",
            Some("Checkpoint untagged nonfinite number"),
        ),
        (
            "[1.2.3]",
            "TypeError",
            Some("Checkpoint untagged nonfinite number"),
        ),
        (
            r#"{"x":1,"x":1e400}"#,
            "TypeError",
            Some("Checkpoint duplicate state key"),
        ),
    ];
    for (source, expected_name, expected_message) in scanner_cases {
        let failure = safe_checkpoint_parse(
            &JsValue::String(JsString::from_str(source)),
            NumberDialect::Ecma,
        )
        .unwrap_err();
        assert_eq!(failure.name, expected_name, "{source}");
        if let Some(expected_message) = expected_message {
            assert_eq!(
                failure.message.to_string_lossy(),
                expected_message,
                "{source}"
            );
        }
    }
}

#[test]
fn checkpoint_parse_checks_exact_markers_then_node_and_unicode_budgets() {
    for text in [
        r#"{"$asterNumber":null}"#,
        r#"{"$asterNumber":"123"}"#,
        r#"{"$asterNumber":"NaN","other":1}"#,
    ] {
        assert_eq!(
            error(safe_checkpoint_parse(
                &JsValue::String(JsString::from_str(text)),
                NumberDialect::Ecma
            )),
            ("TypeError".into(), "Checkpoint number marker".into())
        );
    }
    let too_many_nodes = "[".to_owned() + &"0,".repeat(250_000) + "0]";
    assert_eq!(
        error(safe_checkpoint_parse(
            &JsValue::String(JsString::from_str(&too_many_nodes)),
            NumberDialect::Ecma
        )),
        ("RangeError".into(), "Checkpoint state limit".into())
    );
    let lone_surrogate = JsString::from_utf16(vec![0x22, 0xd800, 0x22]);
    assert_eq!(
        error(safe_checkpoint_parse(
            &JsValue::String(lone_surrogate),
            NumberDialect::Ecma
        )),
        ("TypeError".into(), "Checkpoint Unicode scalar".into())
    );
    let lone_key = JsString::from_utf16(vec![0x7b, 0x22, 0xd800, 0x22, 0x3a, 0x30, 0x7d]);
    assert_eq!(
        error(safe_checkpoint_parse(
            &JsValue::String(lone_key),
            NumberDialect::Ecma
        )),
        ("TypeError".into(), "Checkpoint Unicode scalar".into())
    );
}

#[test]
fn checkpoint_stringify_rejects_undefined_and_lone_surrogates() {
    assert_eq!(
        error(safe_checkpoint_stringify(
            &JsValue::Undefined,
            NumberDialect::Ecma
        )),
        ("TypeError".into(), "Checkpoint unsupported value".into())
    );
    assert_eq!(
        error(safe_checkpoint_stringify(
            &JsValue::String(JsString::from_utf16(vec![0xd800])),
            NumberDialect::Ecma
        )),
        ("TypeError".into(), "Checkpoint Unicode scalar".into())
    );
    let mut object = JsObject::new();
    object.insert(JsString::from_utf16(vec![0xd800]), JsValue::Null);
    assert_eq!(
        error(safe_checkpoint_stringify(
            &JsValue::Object(object),
            NumberDialect::Ecma
        )),
        ("TypeError".into(), "Checkpoint Unicode scalar".into())
    );
    let nested = JsValue::Array(vec![JsValue::Number(f64::NAN), JsValue::Undefined]);
    assert_eq!(
        error(safe_checkpoint_stringify(&nested, NumberDialect::Ecma)),
        ("TypeError".into(), "Checkpoint unsupported value".into())
    );
}

#[test]
fn scoped_checkpoint_codec_is_bit_equal_fallible_and_releases_temporaries() {
    let input = JsValue::Array(
        (0..1_000)
            .map(|index| {
                JsValue::Array(vec![
                    JsValue::Number(index as f64),
                    JsValue::Number(f64::NAN),
                    JsValue::String(JsString::from_str("checkpoint")),
                ])
            })
            .collect(),
    );
    let limited = MemoryAccount::new(512, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&limited);
        let error =
            safe_checkpoint_stringify_scoped(&input, NumberDialect::Ecma, &mut scope).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    }
    assert_eq!(limited.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(4 << 20, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&account);
        let encoded =
            safe_checkpoint_stringify_scoped(&input, NumberDialect::Ecma, &mut scope).unwrap();
        assert_eq!(
            encoded,
            safe_checkpoint_stringify(&input, NumberDialect::Ecma).unwrap()
        );
        let decoded = safe_checkpoint_parse_scoped(
            &JsValue::String(encoded),
            NumberDialect::Ecma,
            &mut scope,
        )
        .unwrap();
        assert_eq!(text(&decoded), text(&input));
        assert!(scope.requested_bytes() > 0);
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
