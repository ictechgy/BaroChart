use barochart_core::{checkpoint_codec, indicator_helpers, indicators_volume};

use barochart_core::data::Bar;
use barochart_core::indicator_params::IndicatorParamValue;
use barochart_core::indicator_types::{IndicatorOutputRow, IndicatorProgram};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json_with};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use checkpoint_codec::{safe_checkpoint_parse_with, safe_checkpoint_stringify_with};
use indicators_volume::create;

const COLD: &str = include_str!("../../../../test/fixtures/rust-indicators/volume-cold.jsonl");
const EDGE: &str = include_str!("../../../../test/fixtures/rust-indicators/volume-edge.jsonl");

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(object) = value else {
        panic!("fixture row must be an object")
    };
    object
        .get(&JsString::from_str(name))
        .unwrap_or_else(|| panic!("missing fixture field {name}"))
}

fn string(value: &JsValue) -> &JsString {
    let JsValue::String(value) = value else {
        panic!("fixture field must be a string")
    };
    value
}

fn strings(value: &JsValue) -> Vec<JsString> {
    let JsValue::Array(values) = value else {
        panic!("fixture field must be an array")
    };
    values.iter().map(|value| string(value).clone()).collect()
}

fn safe_value(text: &JsString) -> JsValue {
    safe_checkpoint_parse_with(&JsValue::String(text.clone()), NumberDialect::Ecma).unwrap()
}

fn safe_text(value: &JsValue) -> String {
    safe_checkpoint_stringify_with(value, NumberDialect::Ecma)
        .unwrap()
        .to_string_lossy()
}

fn fixture_rows(text: &str) -> Vec<JsValue> {
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| parse_json(line.as_bytes(), JsonMode::Standard).unwrap())
        .collect()
}

fn fixture_bars(value: &JsValue) -> Vec<Bar> {
    let JsValue::Array(values) = value else {
        panic!("fixture bars must be an array")
    };
    values
        .iter()
        .map(|bar| {
            let decoded = safe_value(string(bar));
            let number = |field_name: &str| match field(&decoded, field_name) {
                JsValue::Number(value) => *value,
                _ => panic!("bar field {field_name} must be a number"),
            };
            Bar {
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

fn output_value(row: IndicatorOutputRow) -> JsValue {
    JsValue::Array(
        row.as_slice()
            .iter()
            .copied()
            .map(JsValue::Number)
            .collect(),
    )
}

fn assert_metadata(row: &JsValue) {
    assert_eq!(
        string(field(row, "schema")),
        &JsString::from_str("aster.rust-indicator-volume")
    );
    assert!(matches!(field(row, "schemaVersion"), JsValue::Number(value) if *value == 1.0));
    assert_eq!(
        string(field(row, "oracleCommit")),
        &JsString::from_str("bf851d9")
    );
    assert_eq!(
        string(field(row, "sourceSha256")),
        &JsString::from_str("31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790")
    );
    assert_eq!(
        string(field(row, "bundleSha256")),
        &JsString::from_str("007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512")
    );
    assert_eq!(
        string(field(row, "numberDialect")),
        &JsString::from_str("Ecma")
    );
}

fn assert_vector(row: &JsValue) {
    assert_metadata(row);
    let kind = string(field(row, "kind")).to_string_lossy();
    let params = safe_value(string(field(row, "params")));
    let prefix_bars = fixture_bars(field(row, "prefixBars"));
    let bars = fixture_bars(field(row, "bars"));
    let start_index = match field(row, "startIndex") {
        JsValue::Number(value) => *value as usize,
        _ => panic!("fixture startIndex must be a number"),
    };
    let outputs = strings(field(row, "outputs"));
    let snapshots = strings(field(row, "snapshots"));
    let names = strings(field(row, "outputNames"));
    assert_eq!(
        snapshots.len(),
        bars.len() + 1,
        "{kind}: initial plus per-step snapshots"
    );
    assert_eq!(outputs.len(), bars.len(), "{kind}: one output row per bar");

    let program = IndicatorProgram::ALL
        .into_iter()
        .find(|program| program.name() == kind)
        .unwrap_or_else(|| panic!("missing registered volume program {kind}"));
    let mut created = create(program, &params).unwrap_or_else(|error| panic!("{kind}: {error}"));
    assert_eq!(
        created
            .definition
            .outputs
            .iter()
            .map(|name| JsString::from_str(name))
            .collect::<Vec<_>>(),
        names,
        "{kind}: output declaration order"
    );
    for (index, bar) in prefix_bars.iter().enumerate() {
        created
            .state
            .step(bar, index)
            .unwrap_or_else(|error| panic!("{kind} prefix[{index}]: {error}"));
    }
    if !prefix_bars.is_empty() {
        let imported = safe_value(&snapshots[0]);
        created.state.restore(&imported).unwrap_or_else(|error| {
            panic!("{kind}: could not restore generated imported state: {error}")
        });
    }
    assert_eq!(
        safe_text(&created.state.snapshot()),
        snapshots[0].to_string_lossy(),
        "{kind}: initial snapshot text/order"
    );

    for (index, bar) in bars.iter().enumerate() {
        let output = created
            .state
            .step(bar, start_index + index)
            .unwrap_or_else(|error| panic!("{kind}[{index}]: {error}"));
        assert_eq!(
            safe_text(&output_value(output)),
            outputs[index].to_string_lossy(),
            "{kind}[{index}]: exact output"
        );
        let snapshot = created.state.snapshot();
        assert_eq!(
            safe_text(&snapshot),
            snapshots[index + 1].to_string_lossy(),
            "{kind}[{index}]: recursive snapshot key order and wire text"
        );
        let expected_state = safe_value(&snapshots[index + 1]);
        assert!(
            indicator_helpers::exact_state_equal(&snapshot, &expected_state),
            "{kind}[{index}]: Object.is state equality"
        );
    }
}

#[test]
fn checked_in_cold_factory_vectors_match_every_output_and_snapshot() {
    let rows = fixture_rows(COLD);
    assert_eq!(rows.len(), 16);
    for row in &rows {
        assert_vector(row);
    }
}

#[test]
fn checked_in_extreme_vectors_cover_zero_negative_subnormal_and_max_values() {
    let rows = fixture_rows(EDGE);
    assert_eq!(rows.len(), 9);
    for row in &rows {
        assert_vector(row);
    }
}

#[test]
fn factory_params_keep_unknowns_and_reorder_only_declared_known_keys() {
    let params = parse_json(br#"{"zeta":2,"period":1,"alpha":-0}"#, JsonMode::Standard).unwrap();
    let created = create(IndicatorProgram::Mfi, &params).unwrap();
    assert_eq!(
        stringify_json_with(
            &created.definition.params.to_js_value(),
            JsonMode::Standard,
            NumberDialect::Ecma,
        ),
        br#"{"period":1,"alpha":0,"zeta":2}"#
    );
    assert!(matches!(
        created.definition.params.get("alpha"),
        Some(IndicatorParamValue::Number(value)) if *value == 0.0 && value.is_sign_negative()
    ));
}

#[test]
fn factory_validation_follows_generic_values_then_specific_period_order() {
    let zero_period = parse_json(br#"{"period":0}"#, JsonMode::Standard).unwrap();
    let error = create(IndicatorProgram::Mfi, &zero_period).err().unwrap();
    assert_eq!(error.name, "RangeError");
    assert_eq!(error.message, JsString::from_str("Period must be 1..10000"));

    let crossed = parse_json(br#"{"fast":3,"slow":3}"#, JsonMode::Standard).unwrap();
    let error = create(IndicatorProgram::Chaikin, &crossed).err().unwrap();
    assert_eq!(error.name, "RangeError");
    assert_eq!(error.message, JsString::from_str("Fast < slow"));

    let nonfinite = JsValue::Object({
        let mut object = JsObject::new();
        object.insert(JsString::from_str("period"), JsValue::Number(f64::INFINITY));
        object
    });
    let error = create(IndicatorProgram::Mfi, &nonfinite).err().unwrap();
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message,
        JsString::from_str("Indicator parameter values")
    );
}

#[test]
fn restore_preserves_factory_periods_helper_order_and_negative_zero_counters() {
    let params = parse_json(br#"{"fast":2,"slow":3}"#, JsonMode::Standard).unwrap();
    let mut restored = create(IndicatorProgram::VolumeOscillator, &params)
        .unwrap()
        .state;
    let bars = fixture_bars(field(&fixture_rows(COLD)[0], "bars"));
    // rolling helper가 생성된 valid volume oscillator checkpoint를 만든다.
    let mut original = create(IndicatorProgram::VolumeOscillator, &params)
        .unwrap()
        .state;
    for (index, bar) in bars.iter().take(8).enumerate() {
        original.step(bar, index).unwrap();
    }
    let mut wire = original.snapshot();
    set_nested_number(&mut wire, &["f", "head"], -0.0);
    reorder_objects(&mut wire);
    restored.restore(&wire).unwrap();
    let snapshot = restored.snapshot();
    let text = safe_text(&snapshot);
    assert!(text.contains("\"head\":{\"$asterNumber\":\"-0\"}"));
    assert_eq!(
        text,
        safe_text(&wire),
        "restore keeps recursive imported key order"
    );

    let next = bars.get(8).unwrap();
    let expected = original.step(next, 8).unwrap();
    let actual = restored.step(next, 8).unwrap();
    assert_eq!(
        safe_text(&output_value(actual)),
        safe_text(&output_value(expected))
    );

    let chaikin_params = parse_json(br#"{"fast":2,"slow":3}"#, JsonMode::Standard).unwrap();
    let mut chaikin_source = create(IndicatorProgram::Chaikin, &chaikin_params)
        .unwrap()
        .state;
    chaikin_source.step(&bars[0], 0).unwrap();
    let mut smoother_wire = chaikin_source.snapshot();
    set_nested_number(&mut smoother_wire, &["f", "count"], -0.0);
    set_nested_number(&mut smoother_wire, &["f", "sum"], -0.0);
    reorder_objects(&mut smoother_wire);
    let mut chaikin_restored = create(IndicatorProgram::Chaikin, &chaikin_params)
        .unwrap()
        .state;
    chaikin_restored.restore(&smoother_wire).unwrap();
    assert_eq!(
        safe_text(&chaikin_restored.snapshot()),
        safe_text(&smoother_wire),
        "smoother count/sum preserve imported -0 and nested field order"
    );

    let vortex_params = parse_json(br#"{"period":2}"#, JsonMode::Standard).unwrap();
    let mut vortex_source = create(IndicatorProgram::Vortex, &vortex_params)
        .unwrap()
        .state;
    for (index, bar) in bars.iter().take(3).enumerate() {
        vortex_source.step(bar, index).unwrap();
    }
    let mut previous_wire = vortex_source.snapshot();
    reorder_objects(&mut previous_wire);
    let mut vortex_restored = create(IndicatorProgram::Vortex, &vortex_params)
        .unwrap()
        .state;
    vortex_restored.restore(&previous_wire).unwrap();
    assert_eq!(
        safe_text(&vortex_restored.snapshot()),
        safe_text(&previous_wire),
        "previous OHLC wire record retains imported key order"
    );
}

#[test]
fn checkpoint_restore_keeps_factory_parameters_for_every_volume_program() {
    for row in fixture_rows(COLD).into_iter().chain(fixture_rows(EDGE)) {
        let kind = string(field(&row, "kind")).to_string_lossy();
        let params = safe_value(string(field(&row, "params")));
        let bars = fixture_bars(field(&row, "bars"));
        if bars.len() < 3 {
            continue;
        }
        let program = IndicatorProgram::ALL
            .into_iter()
            .find(|program| program.name() == kind)
            .unwrap();
        let mut source = create(program, &params).unwrap().state;
        let mut restored = create(program, &params).unwrap().state;
        let split = 2;
        for (index, bar) in bars.iter().take(split).enumerate() {
            source.step(bar, index).unwrap();
        }
        let wire = source.snapshot();
        restored.restore(&wire).unwrap();
        assert_eq!(
            safe_text(&restored.snapshot()),
            safe_text(&wire),
            "{kind}: snapshot text after restore"
        );
        for (index, bar) in bars.iter().enumerate().skip(split) {
            let source_output = source.step(bar, index).unwrap();
            let restored_output = restored.step(bar, index).unwrap();
            assert_eq!(
                safe_text(&output_value(restored_output)),
                safe_text(&output_value(source_output)),
                "{kind}[{index}]: factory configuration after restore"
            );
            assert_eq!(
                safe_text(&restored.snapshot()),
                safe_text(&source.snapshot()),
                "{kind}[{index}]: state after restored step"
            );
        }
    }
}

fn set_nested_number(value: &mut JsValue, path: &[&str], number: f64) {
    let Some((first, rest)) = path.split_first() else {
        *value = JsValue::Number(number);
        return;
    };
    let JsValue::Object(object) = value else {
        panic!("nested field must be an object")
    };
    let child = object
        .get(&JsString::from_str(first))
        .cloned()
        .unwrap_or_else(|| panic!("missing nested field {first}"));
    let mut child = child;
    set_nested_number(&mut child, rest, number);
    object.insert(JsString::from_str(first), child);
}

fn reorder_objects(value: &mut JsValue) {
    match value {
        JsValue::Array(values) => values.iter_mut().for_each(reorder_objects),
        JsValue::Object(object) => {
            let entries: Vec<_> = object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
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
