use barochart_core::contracts;

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use contracts::{
    RESOURCE_LIMITS, assert_json_text_depth, assert_json_text_depth_with, bounded_text,
    canonical_keys, identifier, option_record, ordered_record, portable_color, portable_font,
    portable_style, size_limit,
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
fn resource_limits_match_the_shared_core_contract() {
    assert_eq!(RESOURCE_LIMITS.max_bars, 4_194_304);
    assert_eq!(RESOURCE_LIMITS.max_canvas_dimension, 16_384);
    assert_eq!(RESOURCE_LIMITS.max_canvas_pixels, 33_554_432);
    assert_eq!(RESOURCE_LIMITS.max_drawings, 10_000);
    assert_eq!(RESOURCE_LIMITS.max_drawing_points, 200_000);
    assert_eq!(RESOURCE_LIMITS.max_document_chars, 8_388_608);
    assert_eq!(RESOURCE_LIMITS.max_history_bytes, 33_554_432);
    assert_eq!(RESOURCE_LIMITS.max_panels, 32);
    assert_eq!(RESOURCE_LIMITS.max_axes, 64);
    assert_eq!(RESOURCE_LIMITS.max_series, 256);
    assert_eq!(RESOURCE_LIMITS.max_indicators, 128);
}

#[test]
fn public_key_lists_match_the_document_wire_order() {
    assert_eq!(
        contracts::PANEL_KEYS,
        [
            "id",
            "weight",
            "label",
            "scale",
            "inverted",
            "padding",
            "range",
            "base",
            "precision",
            "formatter",
            "axisVisible",
            "axisSide"
        ]
    );
    assert_eq!(
        contracts::AXIS_KEYS,
        [
            "id",
            "panel",
            "side",
            "scale",
            "inverted",
            "padding",
            "range",
            "base",
            "precision",
            "tickFormat",
            "prefix",
            "suffix",
            "label",
            "visible",
            "width",
            "formatter"
        ]
    );
    assert_eq!(
        contracts::SERIES_KEYS,
        [
            "id",
            "type",
            "panel",
            "source",
            "values",
            "indicator",
            "output",
            "color",
            "fill",
            "width",
            "baseline",
            "offset",
            "upColor",
            "downColor",
            "visible",
            "axisId",
            "symbolId",
            "label"
        ]
    );
    assert_eq!(
        contracts::THEME_KEYS,
        [
            "background",
            "grid",
            "text",
            "up",
            "down",
            "crosshair",
            "font"
        ]
    );
    assert_eq!(
        contracts::SYMBOL_KEYS,
        [
            "id",
            "exchange",
            "timezone",
            "currency",
            "volumeUnit",
            "priceDecimals",
            "tickSize",
            "adjustment",
            "provider",
            "adjustmentVersion"
        ]
    );
    assert_eq!(
        contracts::DRAWING_RECORD_KEYS,
        [
            "id", "panel", "locked", "style", "type", "points", "text", "visible", "axisId",
            "seriesId"
        ]
    );
    assert_eq!(
        contracts::DRAWING_STYLE_KEYS,
        ["color", "width", "fill", "font"]
    );
    assert_eq!(contracts::DRAWING_ANCHOR_KEYS, ["time", "price"]);
}

#[test]
fn canonical_keys_use_allowlist_then_utf16_order_and_keep_reserved_keys_last() {
    let input = value(r#"{"zeta":1,"__proto__":4,"b":2,"Z":3,"a":null}"#);
    let keys = canonical_keys(&input, &["b", "a"]).unwrap();
    assert_eq!(
        keys,
        ["b", "a", "Z", "__proto__", "zeta"].map(JsString::from_str)
    );

    let order = value(r#"{"":1,"😀":2}"#);
    assert_eq!(
        canonical_keys(&order, &[]).unwrap(),
        ["😀", ""].map(JsString::from_str)
    );
}

#[test]
fn option_record_reports_first_canonical_offending_key_and_reserved_keys() {
    let input = value(r#"{"zeta":1,"__proto__":4,"b":2,"Z":3}"#);
    assert_eq!(
        error(option_record(&input, &["b", "a"], "Options")),
        ("TypeError".into(), "Options: unsupported field Z".into())
    );

    let reserved = value(r#"{"constructor":1}"#);
    assert_eq!(
        error(option_record(&reserved, &["constructor"], "Record")),
        (
            "TypeError".into(),
            "Record: unsupported field constructor".into()
        )
    );
    for invalid in [
        JsValue::Null,
        JsValue::Bool(false),
        JsValue::Array(Vec::new()),
    ] {
        assert_eq!(
            error(option_record(&invalid, &[], "Options")),
            ("TypeError".into(), "Options: object required".into())
        );
    }
}

#[test]
fn option_record_streams_wide_records_but_keeps_the_canonical_first_error() {
    let mut object = JsObject::new();
    for index in (0..4_096).rev() {
        object.insert(
            JsString::from_str(&format!("unknown-{index:04}")),
            JsValue::Number(index as f64),
        );
    }
    object.insert(JsString::from_str("allowed"), JsValue::Bool(true));
    assert_eq!(
        error(option_record(
            &JsValue::Object(object),
            &["allowed"],
            "Wide options"
        )),
        (
            "TypeError".into(),
            "Wide options: unsupported field unknown-0000".into()
        )
    );
}

#[test]
fn ordered_record_reorders_keys_without_changing_values_or_input() {
    let input = value(r#"{"zeta":1,"__proto__":4,"b":2,"a":null}"#);
    let output = ordered_record(&input, &["b", "a"]).unwrap();
    assert_eq!(text(&output), r#"{"b":2,"a":null,"__proto__":4,"zeta":1}"#);
    assert_eq!(text(&input), r#"{"zeta":1,"__proto__":4,"b":2,"a":null}"#);
}

#[test]
fn bounded_text_counts_wtf16_units_and_identifier_checks_reserved_names_after_length() {
    let emoji = JsValue::String(JsString::from_str("😀"));
    assert_eq!(
        bounded_text(&emoji, 2, "Text", false).unwrap().len_utf16(),
        2
    );
    assert_eq!(
        error(bounded_text(&emoji, 1, "Text", false)),
        ("TypeError".into(), "Text: string limit 1".into())
    );
    assert_eq!(
        error(bounded_text(
            &JsValue::String(JsString::default()),
            2,
            "Text",
            false
        )),
        ("TypeError".into(), "Text: string limit 2".into())
    );
    assert_eq!(
        bounded_text(&JsValue::String(JsString::default()), 2, "Text", true)
            .unwrap()
            .len_utf16(),
        0
    );

    assert_eq!(
        identifier(&JsValue::String(JsString::from_str("valid")), "Drawing id").unwrap(),
        &JsString::from_str("valid")
    );
    assert_eq!(
        error(identifier(
            &JsValue::String(JsString::from_str("__proto__")),
            "Drawing id"
        )),
        ("TypeError".into(), "Drawing id: reserved identifier".into())
    );
}

#[test]
fn size_limit_matches_safe_integer_and_preserves_negative_zero() {
    let negative_zero = JsValue::Number(-0.0);
    assert!(
        size_limit(&negative_zero, 10, "Size")
            .unwrap()
            .is_sign_negative()
    );
    assert_eq!(
        size_limit(&JsValue::Number(10.0), 10, "Size").unwrap(),
        10.0
    );
    for value in [
        f64::NAN,
        f64::INFINITY,
        1.5,
        -1.0,
        11.0,
        9_007_199_254_740_992.0,
    ] {
        assert_eq!(
            error(size_limit(&JsValue::Number(value), 10, "Size")),
            ("RangeError".into(), "Size: limit 10".into())
        );
    }
    assert_eq!(
        error(size_limit(
            &JsValue::String(JsString::from_str("10")),
            10,
            "Size"
        )),
        ("RangeError".into(), "Size: limit 10".into())
    );
}

#[test]
fn portable_color_matches_named_hex_rgb_and_rgba_vectors() {
    let vectors = [
        ("red", "#ff0000ff"),
        (" #AbC ", "#aabbccff"),
        ("#1234", "#11223344"),
        ("rgb(50%,0,0)", "#7f0000ff"),
        ("RGBA(255,0,0,.5)", "#ff000080"),
        ("rgb(1,2,3,0.5)", "#01020380"),
        ("rgba(0,0,0,0.002)", "#00000001"),
        ("rgba(0,0,0,0.001)", "#00000000"),
        ("\u{feff}red", "#ff0000ff"),
    ];
    for (source, expected) in vectors {
        assert_eq!(
            portable_color(&JsValue::String(JsString::from_str(source))).unwrap(),
            JsString::from_str(expected),
            "{source}"
        );
    }
    assert_eq!(
        error(portable_color(&JsValue::Null)),
        ("TypeError".into(), "Color string required".into())
    );
    assert_eq!(
        error(portable_color(&JsValue::String(JsString::from_str(
            "orange"
        )))),
        (
            "RangeError".into(),
            "Portable color: hex, comma RGB/RGBA or basic named color required".into()
        )
    );
    assert_eq!(
        error(portable_color(&JsValue::String(JsString::from_str(
            "rgb(255.4,0,0)"
        )))),
        (
            "RangeError".into(),
            "Portable color: hex, comma RGB/RGBA or basic named color required".into()
        )
    );
    assert_eq!(
        error(portable_color(&JsValue::String(JsString::from_str(
            "\u{85}red"
        )))),
        (
            "RangeError".into(),
            "Portable color: hex, comma RGB/RGBA or basic named color required".into()
        )
    );
}

#[test]
fn portable_font_matches_ascii_family_case_and_size_rules() {
    for source in [
        "12px Menlo",
        "bold italic 12.5px Menlo, monospace",
        "normal 96px A B",
    ] {
        assert_eq!(
            portable_font(&JsValue::String(JsString::from_str(source))).unwrap(),
            JsString::from_str(source)
        );
    }
    for source in [
        "Bold 12px Menlo",
        "3px Menlo",
        "97px Menlo",
        "12PX Menlo",
        "12px 한글",
    ] {
        assert_eq!(
            error(portable_font(&JsValue::String(JsString::from_str(source)))),
            ("RangeError".into(), "Font size limit: 4..96px".into()),
            "{source}"
        );
    }
}

#[test]
fn portable_style_keeps_null_fill_and_preserves_only_canonical_hex_when_requested() {
    let input = value(r##"{"font":"  12px Menlo  ","fill":null,"color":"#ABCDEF","width":2}"##);
    let style = portable_style(&input, &["color", "fill"], true).unwrap();
    assert_eq!(
        text(&style),
        r##"{"font":"12px Menlo","fill":null,"color":"#ABCDEF","width":2}"##
    );
    let normalized = portable_style(&input, &["color", "fill"], false).unwrap();
    assert_eq!(
        text(&normalized),
        r##"{"font":"12px Menlo","fill":null,"color":"#abcdefff","width":2}"##
    );
}

#[test]
fn json_text_depth_counts_containers_and_ignores_escaped_strings() {
    let exact = "[".repeat(32) + "0" + &"]".repeat(32);
    let too_deep = "[".repeat(33) + "0" + &"]".repeat(33);
    let text_value = JsValue::String(JsString::from_str(&exact));
    assert_eq!(
        assert_json_text_depth(&text_value, 32, "Text depth limit").unwrap(),
        JsString::from_str(&exact)
    );
    assert_eq!(
        error(assert_json_text_depth(
            &JsValue::String(JsString::from_str(&too_deep)),
            32,
            "Text depth limit"
        )),
        ("RangeError".into(), "Text depth limit".into())
    );
    let quoted = JsValue::String(JsString::from_str(r#"{"text":"\"[{]"}"#));
    assert_eq!(
        assert_json_text_depth(&quoted, 1, "Text depth limit").unwrap(),
        JsString::from_str(r#"{"text":"\"[{]"}"#)
    );
    let mismatched = JsValue::String(JsString::from_str("[}"));
    assert_eq!(
        assert_json_text_depth(&mismatched, 1, "Text depth limit").unwrap(),
        JsString::from_str("[}")
    );
    let coerced = JsValue::Array(vec![
        JsValue::Number(1.0),
        JsValue::Null,
        JsValue::Undefined,
        JsValue::Array(vec![JsValue::Number(2.0), JsValue::Null]),
    ]);
    assert_eq!(
        assert_json_text_depth(&coerced, 0, "Text depth limit").unwrap(),
        JsString::from_str("1,,,2,")
    );
}

#[test]
fn json_text_depth_propagates_object_to_string_shadowing_in_direct_and_array_coercion() {
    let object = value(r#"{"toString":1}"#);
    let nested = value(r#"[{"toString":1}]"#);
    for input in [&object, &nested] {
        let failure = assert_json_text_depth(input, 32, "Text depth limit").unwrap_err();
        assert_eq!(failure.name, "TypeError");
        assert_eq!(
            failure.message.to_string_lossy(),
            expected_to_primitive_message()
        );
    }

    for input in [
        value(r#"{"valueOf":1}"#),
        value("{}"),
        value("[{\"valueOf\":1}]"),
        value("[{}]"),
    ] {
        assert_eq!(
            assert_json_text_depth(&input, 1, "Text depth limit").unwrap(),
            JsString::from_str("[object Object]")
        );
    }
}

#[test]
fn json_text_depth_with_uses_the_selected_number_dialect_for_string_coercion() {
    let value = JsValue::Number(2.0_f64.powi(-24));
    assert_eq!(
        assert_json_text_depth_with(&value, 0, "Depth", NumberDialect::Ecma).unwrap(),
        JsString::from_str("5.960464477539063e-8")
    );
    assert_eq!(
        assert_json_text_depth_with(&value, 0, "Depth", NumberDialect::QuickJs).unwrap(),
        JsString::from_str("5.9604644775390625e-8")
    );
}

fn expected_to_primitive_message() -> &'static str {
    #[cfg(target_os = "android")]
    {
        "toPrimitive"
    }
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    {
        "No default value"
    }
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    {
        "Cannot convert object to primitive value"
    }
}
