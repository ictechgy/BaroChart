use barochart_core::indicator_params;

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16, stringify_json};
use barochart_js::string::JsString;
use indicator_params::{IndicatorParamValue, validate_indicator_params, validate_period};

fn value(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn error(value: &JsValue) -> String {
    validate_indicator_params(value).unwrap_err().to_string()
}

fn text(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Lossless)).unwrap()
}

#[test]
fn generic_validation_accepts_only_finite_numbers_and_bounded_strings() {
    let params = validate_indicator_params(&value(
        r#"{"period":20,"source":"unknown-source","negativeZero":-0,"calendar":"x"}"#,
    ))
    .unwrap();
    assert_eq!(params.number("period"), Some(20.0));
    assert_eq!(
        params.string("source").unwrap().to_string_lossy(),
        "unknown-source"
    );
    assert_eq!(
        params.number("negativeZero").unwrap().to_bits(),
        (-0.0_f64).to_bits()
    );
    assert!(params.get("missing").is_none());

    for invalid in ["null", "true", "1"] {
        assert_eq!(error(&value(invalid)), "TypeError: Indicator params");
    }
    assert_eq!(
        error(&value("[]")),
        "TypeError: Indicator params: object required"
    );
    for invalid in [
        r#"{"x":NaN}"#,
        r#"{"x":Infinity}"#,
        r#"{"x":null}"#,
        r#"{"x":true}"#,
        r#"{"x":[]}"#,
        r#"{"x":{}}"#,
    ] {
        assert_eq!(
            error(&value(invalid)),
            "TypeError: Indicator parameter values"
        );
    }
}

#[test]
fn count_reserved_keys_and_utf16_string_limits_match_the_js_validator() {
    let mut many = JsObject::new();
    for index in 0..33 {
        many.insert(
            JsString::from_str(&format!("k{index}")),
            JsValue::Number(index as f64),
        );
    }
    assert_eq!(
        error(&JsValue::Object(many)),
        "TypeError: Indicator parameter count"
    );
    assert_eq!(
        error(&value(r#"{"constructor":1,"__proto__":2}"#)),
        "TypeError: Indicator params: unsupported field __proto__"
    );

    let mut calendar = JsObject::new();
    calendar.insert(
        JsString::from_str("calendar"),
        JsValue::String(JsString::from_utf16(vec![0xd800; 65_536])),
    );
    validate_indicator_params(&JsValue::Object(calendar)).unwrap();

    let mut oversized_calendar = JsObject::new();
    oversized_calendar.insert(
        JsString::from_str("calendar"),
        JsValue::String(JsString::from_utf16(vec![0xd800; 65_537])),
    );
    assert_eq!(
        error(&JsValue::Object(oversized_calendar)),
        "TypeError: Indicator parameter values"
    );

    let mut ordinary = JsObject::new();
    ordinary.insert(
        JsString::from_str("source"),
        JsValue::String(JsString::from_str(&"x".repeat(257))),
    );
    assert_eq!(
        error(&JsValue::Object(ordinary)),
        "TypeError: Indicator parameter values"
    );
}

#[test]
fn ordered_copy_keeps_unknown_values_and_js_key_order_without_defaults() {
    let original =
        value(r#"{"z":1,"source":"mystery","period":-0,"alpha":"a","10":"ten","2":"two"}"#);
    let params = validate_indicator_params(&original).unwrap();
    let ordered = params.ordered_copy(&["period", "source"]).unwrap();
    let keys: Vec<String> = ordered
        .iter()
        .map(|(key, _)| key.to_string_lossy())
        .collect();
    assert_eq!(keys, ["2", "10", "period", "source", "alpha", "z"]);
    assert_eq!(ordered.len(), 6);
    assert_eq!(
        ordered.number("period").unwrap().to_bits(),
        (-0.0_f64).to_bits()
    );
    assert!(matches!(
        ordered.get("alpha"),
        Some(IndicatorParamValue::String(_))
    ));
    assert_eq!(
        text(&original),
        r#"{"2":"two","10":"ten","z":1,"source":"mystery","period":-0,"alpha":"a"}"#
    );
    assert_eq!(
        text(&ordered.to_js_value()),
        r#"{"2":"two","10":"ten","period":-0,"source":"mystery","alpha":"a","z":1}"#
    );

    let empty = validate_indicator_params(&value("{}")).unwrap();
    assert!(!empty.contains("period"));
    assert_eq!(
        text(
            &empty
                .ordered_copy(&["period", "source"])
                .unwrap()
                .to_js_value()
        ),
        "{}"
    );
}

#[test]
fn params_object_equality_uses_object_is_but_ignores_key_order() {
    let left = validate_indicator_params(&value(r#"{"a":NaN,"b":-0}"#)).unwrap_err();
    assert_eq!(left.to_string(), "TypeError: Indicator parameter values");

    let left = validate_indicator_params(&value(r#"{"a":1,"b":-0}"#)).unwrap();
    let reordered = validate_indicator_params(&value(r#"{"b":-0,"a":1}"#)).unwrap();
    let plus_zero = validate_indicator_params(&value(r#"{"b":0,"a":1}"#)).unwrap();
    assert!(left.object_is_equal(&reordered));
    assert!(!left.object_is_equal(&plus_zero));
}

#[test]
fn period_validation_is_factory_opt_in_and_does_not_touch_generic_params() {
    assert_eq!(validate_period(1.0).unwrap(), 1);
    assert_eq!(validate_period(10_000.0).unwrap(), 10_000);
    for invalid in [-0.0, 0.0, 1.5, 10_001.0, f64::NAN, f64::INFINITY] {
        assert_eq!(
            validate_period(invalid).unwrap_err().to_string(),
            "RangeError: Period must be 1..10000"
        );
    }
    assert!(validate_indicator_params(&value(r#"{"period":"later","unknown":7}"#)).is_ok());
}
