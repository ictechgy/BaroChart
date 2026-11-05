use barochart_core::labels;

use barochart_core::indicator_helpers;

use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_utf16, stringify_json_with,
};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use labels::{
    LabelCommandInput, LabelMetrics, fit_label, label_command, label_metrics, label_width,
    panel_title,
};

const FIXTURES: &str =
    include_str!("../../../../test/fixtures/rust-model/scales-labels-oracle.jsonl");

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(object) = value else {
        panic!("fixture record required")
    };
    object
        .get(&key(name))
        .unwrap_or_else(|| panic!("missing fixture field {name}"))
}

fn string(value: &JsValue) -> &JsString {
    let JsValue::String(value) = value else {
        panic!("fixture string required")
    };
    value
}

fn decode_number(value: &JsValue) -> Option<f64> {
    let JsValue::Object(object) = value else {
        return None;
    };
    if object.len() != 1 {
        return None;
    }
    let JsValue::String(marker) = object.get(&key("$f64"))? else {
        return None;
    };
    match marker.to_string_lossy().as_str() {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        "-0" => Some(-0.0),
        bits => Some(f64::from_bits(u64::from_str_radix(bits, 16).unwrap())),
    }
}

fn decode(value: &JsValue) -> JsValue {
    if let Some(number) = decode_number(value) {
        return JsValue::Number(number);
    }
    match value {
        JsValue::Array(values) => JsValue::Array(values.iter().map(decode).collect()),
        JsValue::Object(object) => {
            let mut result = JsObject::new();
            for (name, value) in object.iter() {
                result.insert(name.clone(), decode(value));
            }
            JsValue::Object(result)
        }
        _ => value.clone(),
    }
}

fn encode(value: &JsValue) -> JsValue {
    match value {
        JsValue::Number(number) => {
            let marker = if number.is_nan() {
                "NaN".to_owned()
            } else if *number == f64::INFINITY {
                "Infinity".to_owned()
            } else if *number == f64::NEG_INFINITY {
                "-Infinity".to_owned()
            } else if *number == 0.0 && number.is_sign_negative() {
                "-0".to_owned()
            } else {
                format!("{:016x}", number.to_bits())
            };
            let mut object = JsObject::new();
            object.insert(key("$f64"), JsValue::String(JsString::from_str(&marker)));
            JsValue::Object(object)
        }
        JsValue::Array(values) => JsValue::Array(values.iter().map(encode).collect()),
        JsValue::Object(object) => {
            let mut result = JsObject::new();
            for (name, value) in object.iter() {
                result.insert(name.clone(), encode(value));
            }
            JsValue::Object(result)
        }
        _ => value.clone(),
    }
}

fn rows() -> Vec<JsValue> {
    FIXTURES
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| parse_json(line.as_bytes(), JsonMode::Standard).unwrap())
        .filter(|row| matches!(field(row, "kind"), JsValue::String(kind) if kind != &key("axis")))
        .collect()
}

fn parse_json_string(value: &JsValue, name: &str) -> JsValue {
    let text = string(field(value, name));
    decode(&parse_json_utf16(text.as_units(), JsonMode::Standard).unwrap())
}

fn metrics_from_value(value: &JsValue) -> LabelMetrics {
    let number = |field_name| match field(value, field_name) {
        JsValue::Number(number) => *number,
        _ => panic!("metric number required"),
    };
    LabelMetrics {
        size: number("size"),
        ascent: number("ascent"),
        descent: number("descent"),
        height: number("height"),
    }
}

fn actual_for(row: &JsValue) -> JsValue {
    let kind = string(field(row, "kind")).to_string_lossy();
    let input = parse_json_string(row, "input");
    match kind.as_str() {
        "labelMetrics" => label_metrics(field(&input, "font"), NumberDialect::Ecma)
            .map(|metrics| metrics.to_value())
            .unwrap(),
        "labelWidth" => {
            let value = string(field(&input, "value"));
            let metrics = metrics_from_value(field(&input, "metrics"));
            JsValue::Number(label_width(value, metrics))
        }
        "fitLabel" => {
            let width = match field(&input, "maxWidth") {
                JsValue::Number(value) => *value,
                _ => panic!("maxWidth required"),
            };
            let metrics = label_metrics(field(&input, "font"), NumberDialect::Ecma).unwrap();
            fit_label(field(&input, "value"), width, metrics, NumberDialect::Ecma)
                .unwrap()
                .map_or(JsValue::Null, |fit| fit.to_value())
        }
        "labelCommand" => {
            let number = |name| match field(&input, name) {
                JsValue::Number(value) => *value,
                _ => panic!("command coordinate required"),
            };
            label_command(
                LabelCommandInput {
                    value: field(&input, "value"),
                    x: number("x"),
                    y: number("y"),
                    max_width: number("maxWidth"),
                    font: field(&input, "font"),
                    color: field(&input, "color"),
                    clip: field(&input, "clip"),
                    metadata: Some(field(&input, "metadata")),
                },
                NumberDialect::Ecma,
            )
            .unwrap()
        }
        "panelTitle" => {
            let panel = field(&input, "panel");
            let JsValue::Array(series) = field(&input, "series") else {
                panic!("series list required")
            };
            JsValue::String(panel_title(panel, series, NumberDialect::Ecma).unwrap())
        }
        _ => panic!("unknown label vector kind {kind}"),
    }
}

#[test]
fn label_vectors_match_utf16_regex_width_fit_command_and_title_wire_order() {
    let rows = rows();
    assert_eq!(rows.len(), 32);
    for row in rows {
        assert_eq!(
            string(field(&row, "schema")),
            &key("aster.rust-model-scales-labels")
        );
        let actual = actual_for(&row);
        let actual_text = String::from_utf8(stringify_json_with(
            &encode(&actual),
            JsonMode::Standard,
            NumberDialect::Ecma,
        ))
        .unwrap();
        assert_eq!(
            actual_text,
            string(field(&row, "expected")).to_string_lossy(),
            "{}",
            string(field(&row, "scenarioId")).to_string_lossy()
        );
        let expected = parse_json_string(&row, "expected");
        assert!(indicator_helpers::exact_state_equal(&actual, &expected));
    }
}
