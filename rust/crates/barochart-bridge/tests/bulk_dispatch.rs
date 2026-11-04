use barochart_bridge::bulk::{BulkDecode, decode_bulk_call};
use barochart_bridge::{call, call_bulk};
use barochart_core::{Engine, Host, HostError};
use barochart_js::error::JsError;
use barochart_js::json::{JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

struct EmptyHost;
impl Host for EmptyHost {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }
    fn log(&self, _: i32, _: &str) {}
}

fn engine() -> Engine {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(&mut engine, "nativeInit", &[JsValue::Number(8.0)]).unwrap();
    engine
}

fn decode(name: &str, text: &str, scope: &mut MemoryScope) -> BulkDecode {
    decode_bulk_call(
        name,
        text.as_bytes(),
        JsonMode::Standard,
        NumberDialect::PLATFORM,
        scope,
    )
    .unwrap()
    .expect("eligible typed call")
}

fn outcome(result: Result<JsValue, JsError>) -> Result<Vec<u8>, JsError> {
    result.map(|value| stringify_json(&value, JsonMode::Lossless))
}

#[test]
fn typed_commit_matches_generic_results_publication_and_failed_validation() {
    let mut typed = engine();
    let mut generic = engine();
    let cases = [
        (
            "nativeSetData",
            r#"[[{"time":1,"open":2,"high":4,"low":1,"close":3,"volume":5},{"time":2,"open":3,"high":5,"low":2,"close":4,"volume":6}]]"#,
        ),
        (
            "nativeCommand",
            r#"["setData",[[{"time":10,"open":2,"high":4,"low":1,"close":3,"volume":5}]]]"#,
        ),
        (
            "nativeCommand",
            r#"["setColumns",[{"time":[20,21,999],"open":[2,3,999],"high":[4,5,999],"low":[1,2,999],"close":[3,4,null],"volume":[5,6,999]},2]]"#,
        ),
        (
            "nativeCommand",
            r#"["setColumns",[{"time":[30],"open":[2],"high":[4],"low":[1],"close":[3],"volume":[5]},-1]]"#,
        ),
        (
            "nativeCommand",
            r#"["setColumns",[{"time":[30,31],"open":[2],"high":[4,5],"low":[1,2],"close":[3,4],"volume":[5,6]},2]]"#,
        ),
        (
            "nativeCommand",
            r#"["setData",[[{"time":40,"open":2,"high":1,"low":4,"close":3,"volume":5}]]]"#,
        ),
        ("nativeCommand", r#"["setData",[[],1]]"#),
    ];
    for (name, text) in cases {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        let staged = decode(name, text, &mut scope);
        let JsValue::Array(ref args) = parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
        else {
            panic!("args")
        };
        assert_eq!(
            outcome(call_bulk(&mut typed, staged)),
            outcome(call(&mut generic, name, args)),
            "{text}"
        );
        let args = [JsValue::String(JsString::from_str("inspect"))];
        assert_eq!(
            outcome(call(&mut typed, "nativeCommand", &args)),
            outcome(call(&mut generic, "nativeCommand", &args)),
            "inspect after {text}"
        );
        let args = [JsValue::Number(400.0), JsValue::Number(300.0)];
        assert_eq!(
            outcome(call(&mut typed, "nativeSceneJSON", &args)),
            outcome(call(&mut generic, "nativeSceneJSON", &args)),
            "scene after {text}"
        );
    }
}

#[test]
fn receiver_errors_precede_deferred_data_errors_without_creating_state() {
    for (name, text) in [
        (
            "nativeSetData",
            r#"[[{"time":1,"open":2,"high":1,"low":4,"close":3,"volume":5}]]"#,
        ),
        ("nativeCommand", r#"["setData",[[],1]]"#),
        (
            "nativeCommand",
            r#"["setColumns",[{"time":[1],"open":[null],"high":[2],"low":[0],"close":[1],"volume":[1]},-1]]"#,
        ),
    ] {
        let mut typed = Engine::new(Box::new(EmptyHost));
        let mut generic = Engine::new(Box::new(EmptyHost));
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        let staged = decode(name, text, &mut scope);
        let JsValue::Array(ref args) = parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
        else {
            panic!("args")
        };
        assert_eq!(
            outcome(call_bulk(&mut typed, staged)),
            outcome(call(&mut generic, name, args)),
            "{text}"
        );
        assert!(typed.chart().is_none());
    }
}
