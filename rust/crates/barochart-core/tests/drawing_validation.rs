use barochart_core::drawing_validation;

use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json};
use barochart_js::string::JsString;
use drawing_validation::{canonical_drawing, canonical_drawing_value, validate_drawing};

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn point(time: f64, price: f64) -> JsValue {
    let mut value = JsObject::new();
    value.insert(JsString::from_str("price"), JsValue::Number(price));
    value.insert(JsString::from_str("time"), JsValue::Number(time));
    JsValue::Object(value)
}

fn drawing(kind: &str, points: Vec<JsValue>) -> JsValue {
    let mut value = JsObject::new();
    value.insert(JsString::from_str("type"), text(kind));
    value.insert(JsString::from_str("points"), JsValue::Array(points));
    value.insert(JsString::from_str("panel"), text("price"));
    value.insert(JsString::from_str("id"), text("d"));
    JsValue::Object(value)
}

fn into_object(mut value: JsValue) -> JsObject {
    match &mut value {
        JsValue::Object(value) => std::mem::take(value),
        _ => unreachable!(),
    }
}

#[test]
fn validated_records_serialize_in_canonical_record_style_and_anchor_order() {
    let mut value = into_object(drawing("trendline", vec![point(1.5, 2.0), point(3.5, 4.0)]));
    let mut style = JsObject::new();
    style.insert(JsString::from_str("font"), text("14px sans-serif"));
    style.insert(JsString::from_str("fill"), text("#abc"));
    style.insert(JsString::from_str("width"), JsValue::Number(2.0));
    style.insert(JsString::from_str("color"), text("gold"));
    value.insert(JsString::from_str("style"), JsValue::Object(style));
    value.insert(JsString::from_str("seriesId"), JsValue::Null);

    let validated = validate_drawing(&JsValue::Object(value.clone())).unwrap();
    let canonical = canonical_drawing_value(&validated);
    assert_eq!(
        String::from_utf8(stringify_json(&canonical, JsonMode::Standard)).unwrap(),
        r##"{"id":"d","panel":"price","style":{"color":"gold","width":2,"fill":"#abc","font":"14px sans-serif"},"type":"trendline","points":[{"time":1.5,"price":2},{"time":3.5,"price":4}]}"##
    );

    let copied = canonical_drawing(
        &JsValue::Object(value),
        barochart_js::num::NumberDialect::Ecma,
    )
    .unwrap();
    assert!(
        copied.series_id.is_none(),
        "null binding is removed by JSON copy"
    );
}

#[test]
fn validation_order_checks_position_and_anchor_contracts_before_presentation_fields() {
    let mut invalid_position = into_object(drawing(
        "longposition",
        vec![
            point(10.0, 50.0),
            point(11.0, 40.0),
            point(10.0, 70.0),
            point(20.0, 50.0),
        ],
    ));
    invalid_position.insert(JsString::from_str("visible"), text("yes"));
    invalid_position.insert(JsString::from_str("text"), text(&"x".repeat(2001)));
    invalid_position.insert(
        JsString::from_str("style"),
        JsValue::Object({
            let mut style = JsObject::new();
            style.insert(JsString::from_str("width"), JsValue::Number(0.0));
            style
        }),
    );
    let error = validate_drawing(&JsValue::Object(invalid_position)).unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_eq!(
        error.message,
        JsString::from_str("Position anchors require shared start/entry and positive time extent")
    );

    let mut invalid_anchor = into_object(drawing(
        "horizontal",
        vec![point(8_640_000_000_000_001.0, 1.0)],
    ));
    invalid_anchor.insert(JsString::from_str("visible"), text("yes"));
    let error = validate_drawing(&JsValue::Object(invalid_anchor)).unwrap_err();
    assert_eq!(
        error.message,
        JsString::from_str("Anchor time/price must be finite and within Date range")
    );
}

#[test]
fn drawing_types_anchors_styles_text_and_utf16_caps_match_the_js_contract() {
    assert_eq!(
        validate_drawing(&drawing("unknown", vec![point(1.0, 2.0), point(3.0, 4.0)]))
            .unwrap_err()
            .message,
        JsString::from_str("Drawing type")
    );
    assert_eq!(
        validate_drawing(&drawing("horizontal", vec![]))
            .unwrap_err()
            .message,
        JsString::from_str("Drawing anchors")
    );

    let mut too_long = into_object(drawing("text", vec![point(1.0, 2.0)]));
    too_long.insert(
        JsString::from_str("text"),
        JsValue::String(JsString::from_str(&"😀".repeat(1001))),
    );
    assert_eq!(
        validate_drawing(&JsValue::Object(too_long))
            .unwrap_err()
            .message,
        JsString::from_str("Drawing text: string limit 2000")
    );

    let mut bad_style = into_object(drawing("horizontal", vec![point(1.0, 2.0)]));
    bad_style.insert(
        JsString::from_str("style"),
        JsValue::Object({
            let mut style = JsObject::new();
            style.insert(JsString::from_str("width"), JsValue::Number(0.0));
            style
        }),
    );
    assert_eq!(
        validate_drawing(&JsValue::Object(bad_style))
            .unwrap_err()
            .message,
        JsString::from_str("Stroke width")
    );
}
