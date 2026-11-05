use barochart_core::session_studies;

use std::collections::HashSet;

use barochart_core::data::Bar;
use barochart_core::indicator_helpers::exact_state_equal;
use barochart_core::indicator_types::{IndicatorProgram, IndicatorProvenance};
use barochart_core::{Host, HostError};
use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_utf16, stringify_json,
};
use barochart_js::string::JsString;
use session_studies::create;

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-indicators/session-oracle.jsonl");
const NY_SPRING_2024: f64 = 1_710_054_000_000.0;
const NY_FALL_2024: f64 = 1_730_613_600_000.0;
const SANTIAGO_SPRING_2024: f64 = 1_725_768_000_000.0;

struct FixtureHost;

impl Host for FixtureHost {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        match name.to_string_lossy().as_str() {
            "America/New_York" | "America/Santiago" => Ok(name.clone()),
            _ => Err(HostError),
        }
    }

    fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError> {
        match zone.to_string_lossy().as_str() {
            "America/New_York" => Ok(if (NY_SPRING_2024..NY_FALL_2024).contains(&epoch_ms) {
                -4 * 3600
            } else {
                -5 * 3600
            }),
            "America/Santiago" => Ok(if epoch_ms >= SANTIAGO_SPRING_2024 {
                -3 * 3600
            } else {
                -4 * 3600
            }),
            _ => Err(HostError),
        }
    }

    fn log(&self, _level: i32, _message: &str) {}
}

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

fn tagged(key: &str, value: JsValue) -> JsValue {
    let mut object = JsObject::new();
    object.insert(JsString::from_str(key), value);
    JsValue::Object(object)
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

fn json(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Standard)).unwrap()
}
fn program(name: &str) -> IndicatorProgram {
    match name {
        "vwap" => IndicatorProgram::Vwap,
        "pivots" => IndicatorProgram::Pivots,
        _ => panic!("program {name}"),
    }
}
fn bar(value: &JsValue) -> Bar {
    let values = array(value);
    Bar {
        time: from_hex(&values[0]),
        open: from_hex(&values[1]),
        high: from_hex(&values[2]),
        low: from_hex(&values[3]),
        close: from_hex(&values[4]),
        volume: from_hex(&values[5]),
    }
}

fn assert_wire(actual: &JsValue, encoded: &JsValue, context: &str) {
    let expected = decode_wire(encoded);
    assert!(
        exact_state_equal(actual, &expected),
        "semantic {context}: {actual:?} != {expected:?}"
    );
    assert_eq!(
        json(&encode_wire(actual)),
        json(&encode_wire(&expected)),
        "order {context}"
    );
}
fn assert_output(actual: &[f64], expected: &JsValue, context: &str) {
    let expected = array(expected);
    assert_eq!(actual.len(), expected.len(), "arity {context}");
    for (left, right) in actual.iter().zip(expected) {
        let right = from_hex(right);
        assert!(
            right.is_nan() && left.is_nan() || left.to_bits() == right.to_bits(),
            "output {context}: {left:?} != {right:?}"
        );
    }
}

#[test]
fn actual_js_oracle_matches_session_outputs_errors_snapshots_and_order() {
    let host = FixtureHost;
    let mut lines = FIXTURE.lines();
    let header = parse(lines.next().unwrap());
    assert_eq!(
        string(get(&header, "oracleCommit")),
        "bf851d9fda8547180207de165c46ff8dc7c09b1b"
    );
    assert_eq!(string(get(&header, "tzdata")), "2025b");
    let mut cases = 0;
    let mut errors = 0;
    let mut programs = HashSet::new();
    let mut steps = 0;
    for line in lines {
        let row = parse(line);
        let id = string(get(&row, "id"));
        let p = program(&string(get(&row, "program")));
        programs.insert(p);
        let params = decode_wire(get(&row, "params"));
        if string(get(&row, "kind")) == "create-error" {
            let expected = get(&row, "error");
            let failure = create(p, &params, &host).unwrap_err();
            let expected_name = string(get(expected, "name"));
            assert_eq!(failure.name, expected_name, "{id}");
            if expected_name != "SyntaxError" {
                assert_eq!(
                    failure.message.to_string_lossy(),
                    string(get(expected, "message")),
                    "{id}"
                );
            }
            errors += 1;
            continue;
        }
        let mut created =
            create(p, &params, &host).unwrap_or_else(|error| panic!("create {id}: {error}"));
        let expected_outputs: Vec<String> =
            array(get(&row, "outputs")).iter().map(string).collect();
        assert_eq!(created.definition.outputs, expected_outputs);
        assert_eq!(created.definition.provenance, IndicatorProvenance::Builtin);
        assert_wire(
            &created.definition.params.to_js_value(),
            get(&row, "params"),
            &format!("{id} params"),
        );
        let mut offsets = JsObject::new();
        for offset in &created.definition.plot_offsets {
            offsets.insert(
                JsString::from_str(offset.output),
                JsValue::Number(offset.value),
            );
        }
        assert_wire(
            &JsValue::Object(offsets),
            get(&row, "plotOffsets"),
            &format!("{id} offsets"),
        );
        if !matches!(get(&row, "restore"), JsValue::Null) {
            created
                .state
                .restore(&decode_wire(get(&row, "restore")))
                .unwrap();
        }
        let frames = array(get(&row, "frames"));
        assert_wire(
            &created.state.snapshot(),
            get(&frames[0], "snapshot"),
            &format!("{id} initial"),
        );
        let bars = array(get(&row, "bars"));
        for (index, input) in bars.iter().enumerate() {
            let frame = &frames[index + 1];
            match object(frame).get(&JsString::from_str("error")) {
                Some(expected) => {
                    let before = created.state.snapshot();
                    let failure = created.state.step(&host, &bar(input), index).unwrap_err();
                    assert_eq!(failure.name, string(get(expected, "name")), "{id}");
                    assert_eq!(
                        failure.message.to_string_lossy(),
                        string(get(expected, "message")),
                        "{id}"
                    );
                    assert_wire(
                        &created.state.snapshot(),
                        get(frame, "snapshot"),
                        &format!("{id}/{index} error"),
                    );
                    assert!(
                        exact_state_equal(&before, &created.state.snapshot()),
                        "financial state changed on {id} error"
                    );
                    break;
                }
                None => {
                    let output = created.state.step(&host, &bar(input), index).unwrap();
                    assert_output(
                        output.as_slice(),
                        get(frame, "output"),
                        &format!("{id}/{index}"),
                    );
                    assert_wire(
                        &created.state.snapshot(),
                        get(frame, "snapshot"),
                        &format!("{id}/{index}"),
                    );
                    steps += 1;
                }
            }
        }
        cases += 1;
    }
    assert_eq!(cases, 16);
    assert_eq!(errors, 16);
    assert_eq!(programs.len(), 2);
    assert!(steps >= 25);
}

#[test]
fn restore_is_structural_atomic_and_preserves_factory_config() {
    let host = FixtureHost;
    for (program, params) in [
        (IndicatorProgram::Vwap, "{}"),
        (
            IndicatorProgram::Vwap,
            r#"{"source":"close","deviation":2}"#,
        ),
        (IndicatorProgram::Pivots, "{}"),
        (
            IndicatorProgram::Pivots,
            r#"{"calendar":"{\"timezone\":\"+00:00\",\"weekdays\":[1],\"windows\":[]}"}"#,
        ),
    ] {
        let params = lossless(params);
        let mut source = create(program, &params, &host).unwrap();
        let first = Bar {
            time: 1704067200000.0,
            open: 10.0,
            high: 12.0,
            low: 8.0,
            close: 11.0,
            volume: 2.0,
        };
        let _ = source.state.step(&host, &first, 0);
        let snapshot = source.state.snapshot();
        let mut restored = create(program, &params, &host).unwrap();
        restored.state.restore(&snapshot).unwrap();
        assert_eq!(
            json(&encode_wire(&restored.state.snapshot())),
            json(&encode_wire(&snapshot))
        );
        let invalid = JsValue::Null;
        let before = restored.state.snapshot();
        assert_eq!(
            restored.state.restore(&invalid).unwrap_err().to_string(),
            "TypeError: Session indicator checkpoint"
        );
        assert!(exact_state_equal(&before, &restored.state.snapshot()));
        let next = Bar {
            time: 1704070800000.0,
            open: 12.0,
            high: 14.0,
            low: 10.0,
            close: 13.0,
            volume: 3.0,
        };
        let left = source.state.step(&host, &next, 1).unwrap();
        let right = restored.state.step(&host, &next, 1).unwrap();
        assert_output(
            left.as_slice(),
            &JsValue::Array(
                right
                    .as_slice()
                    .iter()
                    .map(|value| JsValue::String(JsString::from_str(&f64_hex(*value))))
                    .collect(),
            ),
            "restore continuation",
        );
    }
}

#[test]
fn fixed_offsets_bypass_host_zone_callbacks_but_named_zones_require_them() {
    struct RejectHost;
    impl Host for RejectHost {
        fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
            Err(HostError)
        }
        fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
            Err(HostError)
        }
        fn log(&self, _: i32, _: &str) {}
    }
    let reject = RejectHost;
    let fixed =
        lossless(r#"{"calendar":"{\"timezone\":\"+09:00\",\"weekdays\":[1],\"windows\":[]}"}"#);
    assert!(create(IndicatorProgram::Vwap, &fixed, &reject).is_ok());
    let named = lossless(
        r#"{"calendar":"{\"timezone\":\"America/New_York\",\"weekdays\":[1],\"windows\":[]}"}"#,
    );
    let error = create(IndicatorProgram::Vwap, &named, &reject).unwrap_err();
    assert!(
        error
            .message
            .to_string_lossy()
            .starts_with("Unsupported time zone: ")
    );
}
