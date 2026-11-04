use barochart_core::drawing_types;

use barochart_js::json::{JsonMode, stringify_json};
use barochart_js::string::JsString;
use drawing_types::{DrawingPoint, DrawingType};

#[test]
fn parses_all_supported_types_and_keeps_position_kinds_distinct() {
    let expected = [
        ("trendline", DrawingType::Trendline),
        ("horizontal", DrawingType::Horizontal),
        ("fibonacci", DrawingType::Fibonacci),
        ("rectangle", DrawingType::Rectangle),
        ("ellipse", DrawingType::Ellipse),
        ("text", DrawingType::Text),
        ("ray", DrawingType::Ray),
        ("extendedline", DrawingType::ExtendedLine),
        ("channel", DrawingType::Channel),
        ("fibextension", DrawingType::FibExtension),
        ("fibfan", DrawingType::FibFan),
        ("fibtimezones", DrawingType::FibTimezones),
        ("freehand", DrawingType::Freehand),
        ("measurement", DrawingType::Measurement),
        ("longposition", DrawingType::LongPosition),
        ("shortposition", DrawingType::ShortPosition),
    ];
    for (text, kind) in expected {
        assert_eq!(DrawingType::parse(&JsString::from_str(text)), Some(kind));
        assert_eq!(kind.as_js(), text);
        assert_eq!(
            kind.is_position(),
            matches!(kind, DrawingType::LongPosition | DrawingType::ShortPosition)
        );
    }
    assert_eq!(
        DrawingType::parse(&JsString::from_str("LongPosition")),
        None
    );
    assert_eq!(
        DrawingType::parse(&JsString::from_utf16(vec![0xD800])),
        None
    );
}

#[test]
fn anchors_preserve_signed_zero_in_memory_and_use_time_price_key_order() {
    let value = DrawingPoint {
        time: -0.0,
        price: 2.5,
    }
    .to_value();
    assert!(matches!(value, barochart_js::json::JsValue::Object(_)));
    let text = String::from_utf8(stringify_json(&value, JsonMode::Lossless)).unwrap();
    assert_eq!(text, "{\"time\":-0,\"price\":2.5}");
}
