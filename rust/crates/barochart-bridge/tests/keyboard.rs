use barochart_bridge::call;
use barochart_core::{Engine, Host, HostError};
use barochart_js::json::{JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::string::JsString;
struct NoZones;
impl Host for NoZones {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }
    fn log(&self, _: i32, _: &str) {}
}
fn field<'a>(v: &'a JsValue, k: &str) -> &'a JsValue {
    let JsValue::Object(v) = v else {
        panic!("object")
    };
    v.get(&JsString::from_str(k)).unwrap()
}
fn text(v: &JsValue) -> String {
    let JsValue::String(v) = v else {
        panic!("string")
    };
    v.to_string_lossy()
}
#[test]
fn actual_source_keyboard_selection_navigation_read_and_errors_match() {
    let mut engine = Engine::new(Box::new(NoZones));
    for line in
        include_str!("../../../../test/fixtures/rust-core-vectors/native-keyboard.leaf.jsonl")
            .lines()
            .skip(1)
    {
        let row = parse_json(line.as_bytes(), JsonMode::Standard).unwrap();
        let name = text(field(&row, "name"));
        let JsValue::Array(args) = field(&row, "args") else {
            panic!("args")
        };
        let result = call(&mut engine, &name, args);
        let JsValue::Object(record) = &row else {
            unreachable!()
        };
        if let Some(error) = record.get(&JsString::from_str("error")) {
            let actual = result.unwrap_err();
            assert_eq!(actual.name, text(field(error, "name")));
            assert_eq!(
                actual.message.to_string_lossy(),
                text(field(error, "message"))
            );
        } else {
            let actual = result.unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(
                stringify_json(&actual, JsonMode::Standard),
                stringify_json(field(&row, "result"), JsonMode::Standard),
                "{name}"
            );
        }
    }
}
