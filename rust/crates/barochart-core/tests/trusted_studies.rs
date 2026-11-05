use barochart_core::{checkpoint_codec, indicator_params, indicator_types, trusted_studies};

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use checkpoint_codec::{safe_checkpoint_parse_with, safe_checkpoint_stringify_with};
use trusted_studies::create_pressure;

const FIXTURES: &str =
    include_str!("../../../../test/fixtures/rust-indicators/linked-oracle.jsonl");

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(object) = value else {
        panic!("fixture record required")
    };
    object
        .get(&key(name))
        .unwrap_or_else(|| panic!("missing field {name}"))
}

fn string(value: &JsValue) -> &JsString {
    let JsValue::String(value) = value else {
        panic!("string fixture value required")
    };
    value
}

fn vector_rows() -> Vec<JsValue> {
    FIXTURES
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| parse_json(line.as_bytes(), JsonMode::Standard).unwrap())
        .collect()
}

fn safe_value(value: &JsString) -> JsValue {
    safe_checkpoint_parse_with(&JsValue::String(value.clone()), NumberDialect::Ecma).unwrap()
}

fn safe_text(value: &JsValue) -> String {
    safe_checkpoint_stringify_with(value, NumberDialect::Ecma)
        .unwrap()
        .to_string_lossy()
}

fn bars(value: &JsValue) -> Vec<barochart_core::data::Bar> {
    let JsValue::Array(values) = value else {
        panic!("bars array required")
    };
    values
        .iter()
        .map(|value| {
            let JsValue::String(text) = value else {
                panic!("bar wire text required")
            };
            let bar = safe_value(text);
            let number = |name| match field(&bar, name) {
                JsValue::Number(value) => *value,
                _ => panic!("bar number required: {name}"),
            };
            barochart_core::data::Bar {
                time: number("time"),
                open: number("open"),
                high: number("high"),
                low: number("low"),
                close: number("close"),
                volume: number("volume"),
            }
        })
        .collect()
}

fn output_text(output: indicator_types::IndicatorOutputRow) -> String {
    let value = JsValue::Array(
        output
            .as_slice()
            .iter()
            .copied()
            .map(JsValue::Number)
            .collect(),
    );
    safe_text(&value)
}

fn reorder_objects(value: &mut JsValue) {
    match value {
        JsValue::Array(values) => values.iter_mut().for_each(reorder_objects),
        JsValue::Object(object) => {
            let entries = object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            let mut reversed = JsObject::new();
            for (key, mut value) in entries.into_iter().rev() {
                reorder_objects(&mut value);
                reversed.insert(key, value);
            }
            *object = reversed;
        }
        _ => {}
    }
}

#[test]
fn checked_in_pressure_factory_vectors_match_output_snapshot_offsets_and_descriptor() {
    let rows = vector_rows();
    assert_eq!(rows.len(), 4);
    for row in rows {
        assert_eq!(
            string(field(&row, "schema")),
            &key("aster.rust-indicator-linked")
        );
        assert_eq!(string(field(&row, "oracleCommit")), &key("bf851d9"));
        assert_eq!(
            string(field(&row, "name")),
            &key("aster.volume-direction@1/pressure")
        );
        let params = safe_value(string(field(&row, "params")));
        let mut created = create_pressure(&params).unwrap();
        assert_eq!(created.definition.outputs, ["signed", "cumulative"]);
        assert_eq!(
            safe_text(&created.definition.params.to_js_value()),
            string(field(&row, "params")).to_string_lossy()
        );
        assert_eq!(
            safe_text(&safe_value(string(field(&row, "descriptor")))),
            r#"{"id":"aster.volume-direction","version":1,"stateVersion":1,"exportName":"pressure","causal":true}"#
        );
        assert_eq!(
            safe_text(&safe_value(string(field(&row, "plotOffsets")))),
            string(field(&row, "plotOffsets")).to_string_lossy()
        );

        let input_bars = bars(field(&row, "bars"));
        let outputs = match field(&row, "outputs") {
            JsValue::Array(values) => values
                .iter()
                .map(|value| string(value).to_string_lossy())
                .collect::<Vec<_>>(),
            _ => panic!("output array required"),
        };
        let snapshots = match field(&row, "snapshots") {
            JsValue::Array(values) => values
                .iter()
                .map(|value| string(value).to_string_lossy())
                .collect::<Vec<_>>(),
            _ => panic!("snapshot array required"),
        };
        assert_eq!(outputs.len(), input_bars.len());
        assert_eq!(snapshots.len(), input_bars.len() + 1);
        assert_eq!(safe_text(&created.state.snapshot()), snapshots[0]);
        for (index, (bar, expected)) in input_bars.iter().zip(&outputs).enumerate() {
            assert_eq!(
                output_text(created.state.step(bar, index).unwrap()),
                *expected,
                "{index}"
            );
            assert_eq!(
                safe_text(&created.state.snapshot()),
                snapshots[index + 1],
                "{index}"
            );
        }
    }
}

#[test]
fn factor_shift_validation_follows_generic_parameter_validation_and_preserves_negative_zero() {
    for params in [
        parse_json(br#"{"factor":1.0001}"#, JsonMode::Standard).unwrap(),
        parse_json(br#"{"shift":10001}"#, JsonMode::Standard).unwrap(),
        parse_json(br#"{"factor":"1"}"#, JsonMode::Standard).unwrap(),
        parse_json(br#"{"shift":1.5}"#, JsonMode::Standard).unwrap(),
    ] {
        let error = create_pressure(&params).err().unwrap();
        assert_eq!(error.name, "RangeError");
        assert_eq!(error.message, key("Volume-direction factor/shift"));
    }

    let invalid_generic = JsValue::Object({
        let mut object = JsObject::new();
        object.insert(key("factor"), JsValue::Number(f64::INFINITY));
        object
    });
    let error = create_pressure(&invalid_generic).err().unwrap();
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, key("Indicator parameter values"));

    let params = parse_json(br#"{"factor":-0,"shift":-0,"extra":2}"#, JsonMode::Standard).unwrap();
    let created = create_pressure(&params).unwrap();
    assert_eq!(created.definition.plot_offsets.len(), 2);
    assert!(
        created
            .definition
            .plot_offsets
            .iter()
            .all(|offset| offset.value == 0.0 && offset.value.is_sign_negative())
    );
    assert!(
        matches!(created.definition.params.get("factor"), Some(indicator_params::IndicatorParamValue::Number(value)) if *value == 0.0 && value.is_sign_negative())
    );
    assert_eq!(
        stringify_json_with(
            &created.definition.params.to_js_value(),
            JsonMode::Standard,
            NumberDialect::Ecma
        ),
        br#"{"factor":0,"shift":0,"extra":2}"#
    );
}

#[test]
fn restore_is_atomic_and_preserves_wire_order_and_factory_factor() {
    let params = parse_json(br#"{"factor":0.5,"shift":-0}"#, JsonMode::Standard).unwrap();
    let mut source = create_pressure(&params).unwrap();
    let bars = bars(field(&vector_rows()[0], "bars"));
    for (index, bar) in bars.iter().take(3).enumerate() {
        source.state.step(bar, index).unwrap();
    }
    let mut wire = source.state.snapshot();
    reorder_objects(&mut wire);
    let wire_text = safe_text(&wire);
    let mut restored = create_pressure(&params).unwrap();
    restored.state.restore(&wire).unwrap();
    assert_eq!(safe_text(&restored.state.snapshot()), wire_text);
    let next = &bars[3];
    assert_eq!(
        output_text(restored.state.step(next, 3).unwrap()),
        output_text(source.state.step(next, 3).unwrap())
    );

    let before = restored.state.snapshot();
    let invalid = JsValue::Object({
        let mut object = JsObject::new();
        object.insert(key("previous"), JsValue::Number(4.0));
        object.insert(key("extra"), JsValue::Number(2.0));
        object
    });
    assert!(restored.state.restore(&invalid).is_err());
    assert_eq!(safe_text(&restored.state.snapshot()), safe_text(&before));
}
