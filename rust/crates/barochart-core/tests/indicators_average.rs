use barochart_core::indicators_average;

use std::collections::HashSet;

use barochart_core::data::Bar;
use barochart_core::indicator_helpers::exact_state_equal;
use barochart_core::indicator_types::{IndicatorProgram, IndicatorProvenance};
use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_utf16, stringify_json,
};
use barochart_js::string::JsString;
use indicators_average::create;

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-indicators/average-oracle.jsonl");

fn parse(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
}

fn lossless(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object required: {value:?}")
    };
    value
}

fn get<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    object(value)
        .get(&JsString::from_str(key))
        .unwrap_or_else(|| panic!("missing {key}"))
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array required: {value:?}")
    };
    value
}

fn string(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string required: {value:?}")
    };
    value.to_string_lossy()
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required: {value:?}")
    };
    *value
}

fn f64_hex(value: f64) -> String {
    let bits = if value.is_nan() {
        f64::NAN.to_bits()
    } else {
        value.to_bits()
    };
    format!("{bits:016x}")
}

fn from_hex(value: &JsValue) -> f64 {
    f64::from_bits(u64::from_str_radix(&string(value), 16).unwrap())
}

fn decode_wire(value: &JsValue) -> JsValue {
    let JsValue::Object(encoded) = value else {
        return match value {
            JsValue::Array(values) => JsValue::Array(values.iter().map(decode_wire).collect()),
            _ => value.clone(),
        };
    };
    if encoded.len() == 1 {
        if let Some(bits) = encoded.get(&JsString::from_str("$f64")) {
            return JsValue::Number(from_hex(bits));
        }
        if encoded.get(&JsString::from_str("$undefined")).is_some() {
            return JsValue::Undefined;
        }
        if let Some(entries) = encoded.get(&JsString::from_str("$object")) {
            let mut output = JsObject::new();
            for entry in array(entries) {
                let entry = array(entry);
                assert_eq!(entry.len(), 2);
                output.insert(
                    JsString::from_str(&string(&entry[0])),
                    decode_wire(&entry[1]),
                );
            }
            return JsValue::Object(output);
        }
    }
    let mut output = JsObject::new();
    for (key, child) in encoded.iter() {
        output.insert(key.clone(), decode_wire(child));
    }
    JsValue::Object(output)
}

fn encode_wire(value: &JsValue) -> JsValue {
    match value {
        JsValue::Number(value) => tagged(
            "$f64",
            JsValue::String(JsString::from_str(&f64_hex(*value))),
        ),
        JsValue::Undefined => tagged("$undefined", JsValue::Bool(true)),
        JsValue::Array(values) => JsValue::Array(values.iter().map(encode_wire).collect()),
        JsValue::Object(value) => tagged(
            "$object",
            JsValue::Array(
                value
                    .iter()
                    .map(|(key, child)| {
                        JsValue::Array(vec![JsValue::String(key.clone()), encode_wire(child)])
                    })
                    .collect(),
            ),
        ),
        _ => value.clone(),
    }
}

fn tagged(key: &str, value: JsValue) -> JsValue {
    let mut object = JsObject::new();
    object.insert(JsString::from_str(key), value);
    JsValue::Object(object)
}

fn json(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Standard)).unwrap()
}

fn program(name: &str) -> IndicatorProgram {
    match name {
        "sma" => IndicatorProgram::Sma,
        "vwma" => IndicatorProgram::Vwma,
        "ema" => IndicatorProgram::Ema,
        "wma" => IndicatorProgram::Wma,
        "macd" => IndicatorProgram::Macd,
        "bollinger" => IndicatorProgram::Bollinger,
        "dema" => IndicatorProgram::Dema,
        "tema" => IndicatorProgram::Tema,
        "hma" => IndicatorProgram::Hma,
        "trix" => IndicatorProgram::Trix,
        "ppo" => IndicatorProgram::Ppo,
        _ => panic!("unknown average program {name}"),
    }
}

fn bar(value: &JsValue) -> Bar {
    let values = array(value);
    assert_eq!(values.len(), 6);
    Bar {
        time: from_hex(&values[0]),
        open: from_hex(&values[1]),
        high: from_hex(&values[2]),
        low: from_hex(&values[3]),
        close: from_hex(&values[4]),
        volume: from_hex(&values[5]),
    }
}

fn assert_wire(actual: &JsValue, encoded_expected: &JsValue, context: &str) {
    let expected = decode_wire(encoded_expected);
    assert!(
        exact_state_equal(actual, &expected),
        "semantic state mismatch: {context}\nactual={actual:?}\nexpected={expected:?}"
    );
    assert_eq!(
        json(&encode_wire(actual)),
        json(&encode_wire(&expected)),
        "wire order mismatch: {context}"
    );
}

fn assert_output(actual: &[f64], expected: &JsValue, context: &str) {
    let expected = array(expected);
    assert_eq!(actual.len(), expected.len(), "output arity: {context}");
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        let expected = from_hex(expected);
        if expected.is_nan() {
            assert!(actual.is_nan(), "NaN output {index}: {context}");
        } else {
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "output {index}: {context}"
            );
        }
    }
}

#[test]
fn checked_in_js_oracle_matches_all_average_outputs_snapshots_and_orders() {
    let mut lines = FIXTURE.lines();
    let header = parse(lines.next().unwrap());
    assert_eq!(
        string(get(&header, "schema")),
        "barochart.rust-indicators.average-oracle"
    );
    assert_eq!(number(get(&header, "version")), 1.0);
    assert_eq!(
        string(get(&header, "oracleCommit")),
        "bf851d9fda8547180207de165c46ff8dc7c09b1b"
    );
    assert_eq!(
        string(get(&header, "bundleSHA256")),
        "007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512"
    );
    assert_eq!(string(get(&header, "node")), "v22.20.0");

    let mut programs = HashSet::new();
    let mut cases = 0;
    let mut compared_frames = 0;
    for line in lines {
        let fixture = parse(line);
        let id = string(get(&fixture, "id"));
        let name = string(get(&fixture, "program"));
        let program = program(&name);
        programs.insert(program);
        let params = decode_wire(get(&fixture, "params"));
        let mut created =
            create(program, &params).unwrap_or_else(|error| panic!("create {id}: {error}"));
        assert_eq!(created.definition.program, program);
        assert_eq!(created.definition.provenance, IndicatorProvenance::Builtin);
        assert_wire(
            &created.definition.params.to_js_value(),
            get(&fixture, "params"),
            &format!("{id} params"),
        );
        let expected_outputs: Vec<String> =
            array(get(&fixture, "outputs")).iter().map(string).collect();
        assert_eq!(created.definition.outputs, expected_outputs);
        let mut offsets = JsObject::new();
        for offset in &created.definition.plot_offsets {
            offsets.insert(
                JsString::from_str(offset.output),
                JsValue::Number(offset.value),
            );
        }
        assert_wire(
            &JsValue::Object(offsets),
            get(&fixture, "plotOffsets"),
            &format!("{id} offsets"),
        );

        if !matches!(get(&fixture, "restore"), JsValue::Null) {
            let restored = decode_wire(get(&fixture, "restore"));
            created
                .state
                .restore(&restored)
                .unwrap_or_else(|error| panic!("restore {id}: {error}"));
        }
        let frames = array(get(&fixture, "frames"));
        assert_wire(
            &created.state.snapshot(),
            get(&frames[0], "snapshot"),
            &format!("{id} initial"),
        );
        let start = number(get(&fixture, "startIndex")) as usize;
        let bars = array(get(&fixture, "bars"));
        assert_eq!(frames.len(), bars.len() + 1, "frame count {id}");
        for (offset, encoded_bar) in bars.iter().enumerate() {
            let index = start + offset;
            assert_eq!(number(get(&frames[offset + 1], "index")) as usize, index);
            let output = created
                .state
                .step(&bar(encoded_bar), index)
                .unwrap_or_else(|error| panic!("step {id}/{index}: {error}"));
            assert_output(
                output.as_slice(),
                get(&frames[offset + 1], "output"),
                &format!("{id}/{index}"),
            );
            assert_wire(
                &created.state.snapshot(),
                get(&frames[offset + 1], "snapshot"),
                &format!("{id}/{index}"),
            );
            compared_frames += 1;
        }
        cases += 1;
    }
    assert_eq!(cases, 20);
    assert_eq!(programs.len(), 11);
    assert_eq!(compared_frames, 93);
}

fn error(program: IndicatorProgram, params: &str) -> String {
    create(program, &lossless(params)).unwrap_err().to_string()
}

#[test]
fn factory_validation_order_unknown_params_and_numeric_sources_match_js() {
    assert_eq!(
        error(IndicatorProgram::Rsi, "null"),
        "TypeError: Indicator params"
    );
    assert_eq!(
        error(IndicatorProgram::Rsi, "{}"),
        "TypeError: Average indicator program"
    );
    assert_eq!(
        error(IndicatorProgram::Sma, r#"{"period":"2"}"#),
        "RangeError: Period must be 1..10000"
    );
    assert_eq!(
        error(IndicatorProgram::Macd, r#"{"fast":3,"slow":2,"signal":1}"#),
        "RangeError: MACD fast < slow"
    );
    assert_eq!(
        error(
            IndicatorProgram::Bollinger,
            r#"{"period":2,"deviation":"2"}"#
        ),
        "RangeError: Deviation"
    );
    assert_eq!(
        error(IndicatorProgram::Ppo, r#"{"fast":3,"slow":2,"signal":1}"#),
        "RangeError: Fast < slow"
    );

    let params = lossless(r#"{"zeta":7,"source":123,"period":2,"alpha":"kept"}"#);
    let mut created = create(IndicatorProgram::Sma, &params).unwrap();
    assert_eq!(
        json(&encode_wire(&created.definition.params.to_js_value())),
        json(&encode_wire(&lossless(
            r#"{"period":2,"source":123,"alpha":"kept","zeta":7}"#
        )))
    );
    let output = created
        .state
        .step(
            &Bar {
                time: 1.0,
                open: 1.0,
                high: 1.0,
                low: 1.0,
                close: 1.0,
                volume: 1.0,
            },
            0,
        )
        .unwrap();
    assert!(output.as_slice()[0].is_nan());
}

#[test]
fn restore_rejects_structural_errors_atomically_but_accepts_reordered_valid_wire() {
    let mut created = create(IndicatorProgram::Sma, &lossless(r#"{"period":3}"#)).unwrap();
    let before = json(&encode_wire(&created.state.snapshot()));
    for invalid in ["null", r#"{"unknown":1}"#, r#"{"r":{"a":[],"head":0}}"#] {
        let error = created.state.restore(&lossless(invalid)).unwrap_err();
        assert_eq!(error.to_string(), "TypeError: Average indicator checkpoint");
        assert_eq!(json(&encode_wire(&created.state.snapshot())), before);
    }
    let reordered = lossless(r#"{"r":{"sum":2,"head":-0,"a":[1,1]}}"#);
    created.state.restore(&reordered).unwrap();
    assert_eq!(
        json(&encode_wire(&created.state.snapshot())),
        json(&encode_wire(&reordered))
    );
}

#[test]
fn every_average_variant_round_trips_its_typed_snapshot_and_keeps_config() {
    let cases = [
        (IndicatorProgram::Sma, r#"{"period":3}"#),
        (IndicatorProgram::Vwma, r#"{"period":3}"#),
        (IndicatorProgram::Ema, r#"{"period":3}"#),
        (IndicatorProgram::Wma, r#"{"period":3}"#),
        (IndicatorProgram::Macd, r#"{"fast":2,"slow":3,"signal":2}"#),
        (IndicatorProgram::Bollinger, r#"{"period":3,"deviation":2}"#),
        (IndicatorProgram::Dema, r#"{"period":2}"#),
        (IndicatorProgram::Tema, r#"{"period":2}"#),
        (IndicatorProgram::Hma, r#"{"period":4}"#),
        (IndicatorProgram::Trix, r#"{"period":2}"#),
        (IndicatorProgram::Ppo, r#"{"fast":2,"slow":3,"signal":2}"#),
    ];
    for (program, params) in cases {
        let params = lossless(params);
        let mut source = create(program, &params).unwrap();
        for index in 0..3 {
            source
                .state
                .step(
                    &Bar {
                        time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
                        open: index as f64 + 1.0,
                        high: index as f64 + 1.0,
                        low: index as f64 + 1.0,
                        close: index as f64 + 1.0,
                        volume: index as f64,
                    },
                    index,
                )
                .unwrap();
        }
        let snapshot = source.state.snapshot();
        let mut restored = create(program, &params).unwrap();
        restored.state.restore(&snapshot).unwrap();
        assert_eq!(
            json(&encode_wire(&restored.state.snapshot())),
            json(&encode_wire(&snapshot)),
            "snapshot {program:?}"
        );
        let next = Bar {
            time: 1_700_000_180_000.0,
            open: 4.0,
            high: 4.0,
            low: 4.0,
            close: 4.0,
            volume: 3.0,
        };
        let source_output = source.state.step(&next, 3).unwrap();
        let restored_output = restored.state.step(&next, 3).unwrap();
        assert_eq!(source_output.len(), restored_output.len());
        for (left, right) in source_output
            .as_slice()
            .iter()
            .zip(restored_output.as_slice())
        {
            assert!(
                left.is_nan() && right.is_nan() || left.to_bits() == right.to_bits(),
                "output after restore {program:?}: {left:?} != {right:?}"
            );
        }
        assert_eq!(
            json(&encode_wire(&restored.state.snapshot())),
            json(&encode_wire(&source.state.snapshot())),
            "continued snapshot {program:?}"
        );
    }
}
