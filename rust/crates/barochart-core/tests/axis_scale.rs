use barochart_core::axis_scale;

use barochart_core::indicator_helpers;

use axis_scale::{AxisScale, AxisScaleInput, AxisScaleKind};
use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_utf16, stringify_json_with,
};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::collections::HashMap;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::path::PathBuf;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::process::Command;

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

fn expected_output_text(
    row: &JsValue,
    #[cfg(all(target_os = "linux", target_env = "gnu"))] native_quickjs: &HashMap<String, String>,
) -> String {
    // WASM은 V8 값을 주입하고, Apple native는 같은 기기의 JSC를 쓴다.
    #[cfg(target_arch = "wasm32")]
    {
        string(field(row, "expected")).to_string_lossy()
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if let JsValue::Object(object) = row
            && let Some(JsValue::String(value)) = object.get(&key("expectedJsc"))
        {
            return value.to_string_lossy();
        }
        string(field(row, "expected")).to_string_lossy()
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        let input = parse_json_utf16(string(field(row, "input")).as_units(), JsonMode::Standard)
            .unwrap_or_else(|error| panic!("native QuickJS input is invalid: {error}"));
        if matches!(field(&input, "scale"), JsValue::String(value) if value == &key("log")) {
            let scenario = string(field(row, "scenarioId")).to_string_lossy();
            return native_quickjs
                .get(&scenario)
                .unwrap_or_else(|| panic!("native QuickJS oracle missed {scenario}"))
                .clone();
        }
        string(field(row, "expected")).to_string_lossy()
    }
    #[cfg(all(
        not(target_arch = "wasm32"),
        not(any(target_os = "macos", target_os = "ios")),
        not(all(target_os = "linux", target_env = "gnu"))
    ))]
    {
        panic!("unsupported native axis oracle target; use Apple JSC or Linux GNU QuickJS")
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn native_quickjs_outputs(rows: &[JsValue]) -> HashMap<String, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let helper = root.join("test/fixtures/rust-model/generate-scales-labels-native-quickjs.mjs");
    let fixture = root.join("test/fixtures/rust-model/scales-labels-oracle.jsonl");
    let node = std::env::var_os("BAROCHART_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(&root)
        .arg(&helper)
        .arg(&fixture)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "NoNode: cannot run native QuickJS axis oracle with {:?}: {error}; set BAROCHART_NODE to Node v22.20.0",
                node
            )
        });
    assert!(
        output.status.success(),
        "native QuickJS axis oracle failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );

    let mut result = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
    {
        let row = parse_json(line.as_bytes(), JsonMode::Standard)
            .unwrap_or_else(|error| panic!("native QuickJS oracle emitted invalid JSON: {error}"));
        let scenario = string(field(&row, "scenarioId")).to_string_lossy();
        let expected = string(field(&row, "expectedNativeQuickJs")).to_string_lossy();
        assert!(
            result.insert(scenario.clone(), expected).is_none(),
            "native QuickJS oracle duplicated {scenario}"
        );
    }

    let expected_scenarios: Vec<String> = rows
        .iter()
        .filter(|row| matches!(field(row, "error"), JsValue::Null))
        .map(|row| string(field(row, "scenarioId")).to_string_lossy())
        .collect();
    assert_eq!(
        result.len(),
        expected_scenarios.len(),
        "native QuickJS oracle result count"
    );
    for scenario in expected_scenarios {
        assert!(
            result.contains_key(&scenario),
            "native QuickJS oracle missed {scenario}"
        );
    }
    result
}

fn decode_number(value: &JsValue) -> Option<f64> {
    let JsValue::Object(object) = value else {
        return None;
    };
    if object.len() != 1 {
        return None;
    }
    let marker = object.get(&key("$f64"))?;
    let JsValue::String(marker) = marker else {
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
        .filter(|row| matches!(field(row, "kind"), JsValue::String(kind) if kind == &key("axis")))
        .collect()
}

fn number(value: &JsValue) -> f64 {
    match value {
        JsValue::Number(value) => *value,
        _ => panic!("axis input numeric field required"),
    }
}

fn optional_number(value: &JsValue) -> Option<f64> {
    match value {
        JsValue::Null => None,
        JsValue::Number(value) => Some(*value),
        _ => panic!("axis input optional number required"),
    }
}

fn axis_input(value: &JsValue) -> (AxisScaleInput, Vec<f64>, Vec<f64>) {
    let scale = match string(field(value, "scale")).to_string_lossy().as_str() {
        "linear" => AxisScaleKind::Linear,
        "log" => AxisScaleKind::Log,
        "percent" => AxisScaleKind::Percent,
        _ => panic!("unknown axis scale"),
    };
    let range = match field(value, "range") {
        JsValue::Null => None,
        JsValue::Array(values) if values.len() == 2 => {
            Some([number(&values[0]), number(&values[1])])
        }
        _ => panic!("axis range must be null or a pair"),
    };
    let samples = match field(value, "samples") {
        JsValue::Array(values) => values.iter().map(number).collect(),
        _ => panic!("axis samples array required"),
    };
    let screen_samples = match field(value, "screen_samples") {
        JsValue::Array(values) => values.iter().map(number).collect(),
        _ => panic!("axis screen samples array required"),
    };
    (
        AxisScaleInput {
            source_min: number(field(value, "source_min")),
            source_max: number(field(value, "source_max")),
            scale,
            padding: number(field(value, "padding")),
            range,
            base: optional_number(field(value, "base")),
            first_close: optional_number(field(value, "first_close")),
            zero_baseline: matches!(field(value, "zero_baseline"), JsValue::Bool(true)),
            inverted: matches!(field(value, "inverted"), JsValue::Bool(true)),
            top: number(field(value, "top")),
            bottom: number(field(value, "bottom")),
        },
        samples,
        screen_samples,
    )
}

fn output_value(axis: &AxisScale, samples: &[f64], screen_samples: &[f64]) -> JsValue {
    let mut output = JsObject::new();
    output.insert(key("min"), JsValue::Number(axis.min));
    output.insert(key("max"), JsValue::Number(axis.max));
    output.insert(key("base"), JsValue::Number(axis.base));
    output.insert(key("top"), JsValue::Number(axis.top));
    output.insert(key("bottom"), JsValue::Number(axis.bottom));
    output.insert(key("lo"), JsValue::Number(axis.lo));
    output.insert(key("hi"), JsValue::Number(axis.hi));
    output.insert(
        key("y"),
        JsValue::Array(
            samples
                .iter()
                .map(|value| JsValue::Number(axis.y(*value)))
                .collect(),
        ),
    );
    output.insert(
        key("price"),
        JsValue::Array(
            screen_samples
                .iter()
                .map(|value| JsValue::Number(axis.price(*value)))
                .collect(),
        ),
    );
    output.insert(
        key("transform"),
        JsValue::Array(
            samples
                .iter()
                .map(|value| JsValue::Number(axis.transform(*value)))
                .collect(),
        ),
    );
    output.insert(
        key("inverse"),
        JsValue::Array(
            samples
                .iter()
                .map(|value| JsValue::Number(axis.inverse(axis.transform(*value))))
                .collect(),
        ),
    );
    JsValue::Object(output)
}

#[test]
fn public_layout_axis_vectors_match_binary64_outputs_and_errors() {
    let rows = rows();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    let native_quickjs = native_quickjs_outputs(&rows);
    assert_eq!(rows.len(), 17);
    for row in rows {
        assert_eq!(
            string(field(&row, "schema")),
            &key("aster.rust-model-scales-labels")
        );
        assert_eq!(
            string(field(&row, "oracleCommit")),
            &key("e0ab2f917a297a48f844cdae90d5877d768698fd")
        );
        let input = decode(
            &parse_json_utf16(string(field(&row, "input")).as_units(), JsonMode::Standard).unwrap(),
        );
        let (input, samples, screen_samples) = axis_input(&input);
        let expected_error = field(&row, "error");
        if !matches!(expected_error, JsValue::Null) {
            let result = AxisScale::new(input);
            assert!(
                result.is_err(),
                "{}: expected failure",
                string(field(&row, "scenarioId")).to_string_lossy()
            );
            let error = result.err().unwrap();
            assert_eq!(
                error.name,
                string(field(expected_error, "name")).to_string_lossy()
            );
            assert_eq!(
                error.message,
                string(field(expected_error, "message")).clone()
            );
            continue;
        }

        let axis = AxisScale::new(input).unwrap_or_else(|error| {
            panic!(
                "{}: unexpected axis error {error}",
                string(field(&row, "scenarioId")).to_string_lossy()
            )
        });
        let actual = encode(&output_value(&axis, &samples, &screen_samples));
        let actual_text = String::from_utf8(stringify_json_with(
            &actual,
            JsonMode::Standard,
            NumberDialect::Ecma,
        ))
        .unwrap();
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        let expected_text = expected_output_text(&row, &native_quickjs);
        #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
        let expected_text = expected_output_text(&row);
        assert_eq!(
            actual_text,
            expected_text,
            "{}: exact AxisScale wire output/order",
            string(field(&row, "scenarioId")).to_string_lossy()
        );
        let expected = decode(&parse_json(expected_text.as_bytes(), JsonMode::Standard).unwrap());
        assert!(indicator_helpers::exact_state_equal(
            &output_value(&axis, &samples, &screen_samples),
            &expected
        ));
    }
}

#[test]
fn axis_scale_reports_percent_zero_base_before_projection() {
    let error = AxisScale::new(AxisScaleInput {
        source_min: 1.0,
        source_max: 2.0,
        scale: AxisScaleKind::Percent,
        padding: 0.0,
        range: None,
        base: Some(0.0),
        first_close: Some(1.0),
        zero_baseline: false,
        inverted: false,
        top: 12.0,
        bottom: 466.0,
    })
    .err()
    .unwrap();
    assert_eq!(error.name, "RangeError");
    assert_eq!(
        error.message,
        JsString::from_str("Percent base cannot be zero")
    );
}
