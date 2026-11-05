use barochart_core::{checkpoint_codec, indicator_checkpoint, indicator_params, indicator_types};

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16};
use barochart_js::string::JsString;
use checkpoint_codec::{safe_checkpoint_parse, safe_checkpoint_stringify};
use indicator_checkpoint::validate_checkpoint_state;
use indicator_params::validate_indicator_params;
use indicator_types::IndicatorProgram;

fn value(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn parse_state(text: &str) -> JsValue {
    safe_checkpoint_parse(&JsValue::String(JsString::from_str(text))).unwrap()
}

fn program(name: &str) -> IndicatorProgram {
    IndicatorProgram::ALL
        .into_iter()
        .find(|program| program.name() == name)
        .unwrap()
}

fn empty_params() -> indicator_params::OrderedIndicatorParams {
    validate_indicator_params(&value("{}")).unwrap()
}

fn failure(
    program: IndicatorProgram,
    params: &JsValue,
    state: &JsValue,
    index: f64,
) -> (String, String) {
    let params = validate_indicator_params(params).unwrap();
    let error = validate_checkpoint_state(program, &params, state, index).unwrap_err();
    (error.name.into(), error.message.to_string_lossy())
}

#[test]
fn all_thirty_five_checked_in_warm_states_validate_without_wire_mutation() {
    let fixture = include_str!("../../../../test/fixtures/rust-indicators/checkpoint-oracle.jsonl");
    let lines: Vec<_> = fixture.lines().collect();
    assert_eq!(lines.len(), 36);
    for line in &lines[1..] {
        let row = value(line);
        let JsValue::Object(object) = &row else {
            panic!("row")
        };
        let Some(JsValue::String(name)) = object.get(&JsString::from_str("name")) else {
            panic!("name")
        };
        let Some(JsValue::Number(index)) = object.get(&JsString::from_str("index")) else {
            panic!("index")
        };
        let Some(JsValue::String(state)) = object.get(&JsString::from_str("stateLossless")) else {
            panic!("state")
        };
        let state = parse_state(&state.to_string_lossy());
        let before = safe_checkpoint_stringify(&state).unwrap();
        let validated = validate_checkpoint_state(
            program(&name.to_string_lossy()),
            &empty_params(),
            &state,
            *index,
        )
        .unwrap();
        assert_eq!(
            safe_checkpoint_stringify(&validated).unwrap(),
            before,
            "{}",
            name.to_string_lossy()
        );
    }
}

#[test]
fn index_and_common_params_fail_before_state_schema() {
    assert_eq!(
        failure(
            IndicatorProgram::Ema,
            &value(r#"{"period":0}"#),
            &value(r#"{"broken":true}"#),
            -1.0,
        ),
        ("TypeError".into(), "Checkpoint state integer".into())
    );
    let invalid_common = validate_indicator_params(&value(r#"{"period":null}"#)).unwrap_err();
    assert_eq!(
        invalid_common.message.to_string_lossy(),
        "Indicator parameter values"
    );
}

#[test]
fn initial_states_are_exact_and_sar_uses_step_defaulting() {
    assert!(
        validate_checkpoint_state(IndicatorProgram::Ema, &empty_params(), &value("{}"), 0.0)
            .is_ok()
    );
    assert_eq!(
        failure(
            IndicatorProgram::Ema,
            &value("{}"),
            &value(r#"{"e":{"count":0,"sum":0,"value":NaN}}"#),
            0.0,
        )
        .1,
        "Checkpoint state keys"
    );
    let sar_params = validate_indicator_params(&value(r#"{"step":-0}"#)).unwrap();
    let sar = value(r#"{"previous":null,"older":null,"sar":NaN,"ep":NaN,"af":-0,"direction":1}"#);
    assert!(
        validate_checkpoint_state(IndicatorProgram::ParabolicSar, &sar_params, &sar, -0.0).is_ok()
    );
}

#[test]
fn ring_smoother_extreme_and_pairing_first_errors_match_source() {
    for (state, expected) in [
        (
            r#"{"e":{"count":21,"sum":0,"value":1}}"#,
            "Checkpoint state integer",
        ),
        (
            r#"{"e":{"count":1,"sum":0,"value":1}}"#,
            "Checkpoint smoothing state",
        ),
        (
            r#"{"e":{"count":20,"sum":0,"value":Infinity}}"#,
            "Checkpoint smoothing state",
        ),
    ] {
        assert_eq!(
            failure(
                IndicatorProgram::Ema,
                &value(r#"{"period":20}"#),
                &value(state),
                256.0,
            )
            .1,
            expected
        );
    }
    assert_eq!(
        failure(
            IndicatorProgram::StochRsi,
            &value("{}"),
            &value(r#"{"previous":1,"valid":1,"h":{"a":[[0,50]],"head":0},"k":{"a":[],"head":0,"sum":0},"d":{"a":[],"head":0,"sum":0}}"#),
            256.0,
        )
        .1,
        "Checkpoint paired state"
    );
    assert_eq!(
        failure(
            IndicatorProgram::Donchian,
            &value(r#"{"period":3}"#),
            &value(r#"{"h":{"a":[[2,2],[1,3]],"head":0},"l":{"a":[[2,1]],"head":0}}"#),
            3.0,
        )
        .1,
        "Checkpoint extreme ordering"
    );
}

#[test]
fn pressure_module_schema_and_negative_zero_are_validated() {
    let params = validate_indicator_params(&value(r#"{"factor":-0,"shift":-0}"#)).unwrap();
    let initial = value(r#"{"previous":NaN,"cumulative":0}"#);
    assert!(validate_checkpoint_state(IndicatorProgram::Pressure, &params, &initial, 0.0).is_ok());
    let warm = value(r#"{"cumulative":-0,"previous":1}"#);
    assert!(validate_checkpoint_state(IndicatorProgram::Pressure, &params, &warm, 1.0).is_ok());
    let negative_zero = value(r#"{"previous":NaN,"cumulative":-0}"#);
    assert!(
        validate_checkpoint_state(
            IndicatorProgram::Pressure,
            &empty_params(),
            &negative_zero,
            0.0,
        )
        .is_ok()
    );
    assert_eq!(
        failure(
            IndicatorProgram::Pressure,
            &value("{}"),
            &value(r#"{"previous":NaN,"cumulative":NaN}"#),
            0.0,
        )
        .1,
        "Volume-direction checkpoint"
    );
}

#[test]
fn aroon_and_sar_specific_history_invariants_are_enforced() {
    let aroon = value(r#"{"h":{"a":[[1,3]],"head":0},"l":{"a":[[1,1]],"head":0}}"#);
    assert_eq!(
        failure(
            IndicatorProgram::Aroon,
            &value(r#"{"period":3}"#),
            &aroon,
            3.0,
        )
        .1,
        "Checkpoint Aroon latest bar"
    );
    let sar = value(
        r#"{"previous":{"high":3,"low":1,"close":2},"older":null,"sar":1,"ep":3,"af":0.02,"direction":1}"#,
    );
    assert_eq!(
        failure(IndicatorProgram::ParabolicSar, &value("{}"), &sar, 2.0,).1,
        "Checkpoint SAR history"
    );
}

#[test]
fn multi_fault_first_errors_follow_source_evaluation_order() {
    for (program, params, state, index, expected) in [
        (
            IndicatorProgram::Sma,
            r#"{"period":2}"#,
            r#"{"r":{"a":[1],"head":"0","sum":"bad"}}"#,
            1.0,
            "Checkpoint state integer",
        ),
        (
            IndicatorProgram::Ema,
            r#"{"period":2}"#,
            r#"{"e":{"count":"1","sum":"bad","value":NaN}}"#,
            1.0,
            "Checkpoint state integer",
        ),
        (
            IndicatorProgram::Donchian,
            r#"{"period":2}"#,
            r#"{"h":{"a":[[0,2]],"head":"0"},"l":{"a":[[0,1]],"head":0}}"#,
            1.0,
            "Checkpoint extreme queue head",
        ),
        (
            IndicatorProgram::Donchian,
            r#"{"period":2}"#,
            r#"{"h":{"a":[["0",2]],"head":0},"l":{"a":[[0,1]],"head":0}}"#,
            1.0,
            "Checkpoint state integer",
        ),
        (
            IndicatorProgram::Vwma,
            r#"{"period":2}"#,
            r#"{"a":[[NaN,Infinity]],"head":0,"sums":[],"invalid":0,"positive":0}"#,
            1.0,
            "Checkpoint VWMA product",
        ),
        (
            IndicatorProgram::Vwma,
            r#"{"period":2}"#,
            r#"{"a":[[1,1]],"head":0,"sums":[[Infinity,Infinity],[1,0],[1,0]],"invalid":0,"positive":1}"#,
            1.0,
            "Checkpoint output number",
        ),
        (
            IndicatorProgram::Supertrend,
            "{}",
            r#"{"previous":1,"upper":0,"lower":0,"direction":"1","a":{"count":1,"sum":1,"value":NaN}}"#,
            1.0,
            "Checkpoint direction",
        ),
        (
            IndicatorProgram::ParabolicSar,
            "{}",
            r#"{"previous":{"high":3,"low":1,"close":2},"older":null,"sar":1,"ep":3,"af":0.02,"direction":"1"}"#,
            1.0,
            "Checkpoint SAR state",
        ),
        (
            IndicatorProgram::Aroon,
            r#"{"period":0}"#,
            r#"{"broken":true}"#,
            0.0,
            "Checkpoint state integer",
        ),
    ] {
        assert_eq!(
            failure(program, &value(params), &value(state), index).1,
            expected
        );
    }
}

#[test]
fn advanced_session_states_keep_source_invariants_without_compaction() {
    let params = validate_indicator_params(&value(r#"{"source":"close"}"#)).unwrap();
    let initial = value(r#"{"session":null,"count":0,"pv":0,"v":0,"mean":0,"m2":0}"#);
    assert!(validate_checkpoint_state(IndicatorProgram::Vwap, &params, &initial, 0.0).is_ok());
    let warm = value(r#"{"session":1,"count":2,"pv":4,"v":2,"mean":2,"m2":0}"#);
    assert!(validate_checkpoint_state(IndicatorProgram::Vwap, &params, &warm, 3.0).is_ok());
    assert_eq!(
        failure(
            IndicatorProgram::Vwap,
            &value(r#"{"source":"close"}"#),
            &value(r#"{"session":1,"count":0,"pv":0,"v":0,"mean":0,"m2":0}"#),
            0.0,
        )
        .1,
        "Session checkpoint missing count"
    );

    let calendar = r#"{"timezone":"UTC","weekdays":[1],"windows":[{"open":"09:00","close":"17:00","kind":"regular"}],"exceptions":{},"ambiguity":"earlier"}"#;
    let mut raw_params = JsObject::new();
    raw_params.insert(
        JsString::from_str("calendar"),
        JsValue::String(JsString::from_str(calendar)),
    );
    let params = validate_indicator_params(&JsValue::Object(raw_params)).unwrap();
    let pivots = value(
        r#"{"session":"2023-01-02","count":1,"high":3,"low":1,"close":2,"levels":[2,3,1,4,0]}"#,
    );
    let before = safe_checkpoint_stringify(&pivots).unwrap();
    let validated =
        validate_checkpoint_state(IndicatorProgram::Pivots, &params, &pivots, 1.0).unwrap();
    assert_eq!(safe_checkpoint_stringify(&validated).unwrap(), before);
}

#[test]
fn session_parameter_errors_precede_checkpoint_state_errors() {
    for (program, params, expected_name, expected_message) in [
        (
            IndicatorProgram::Vwap,
            r#"{"sessionMs":0}"#,
            "RangeError",
            "Session duration",
        ),
        (
            IndicatorProgram::Vwap,
            r#"{"calendar":1}"#,
            "TypeError",
            "Session calendar string limit",
        ),
        (
            IndicatorProgram::Vwap,
            r#"{"sessionMs":1,"anchorTime":"bad"}"#,
            "TypeError",
            "sessionMs conflicts with calendar/anchorTime",
        ),
        (
            IndicatorProgram::Pivots,
            r#"{"anchorTime":0}"#,
            "RangeError",
            "VWAP anchor UTC milliseconds",
        ),
        (
            IndicatorProgram::Vwap,
            r#"{"source":1}"#,
            "TypeError",
            "VWAP source",
        ),
        (
            IndicatorProgram::Vwap,
            r#"{"deviation":"x"}"#,
            "RangeError",
            "VWAP deviation multiplier",
        ),
        (
            IndicatorProgram::Vwap,
            r#"{"kinds":"regular"}"#,
            "TypeError",
            "Session kinds require calendar",
        ),
    ] {
        assert_eq!(
            failure(program, &value(params), &value(r#"{"broken":true}"#), 1.0),
            (expected_name.to_owned(), expected_message.to_owned())
        );
    }
}
