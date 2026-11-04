use barochart_core::data_input;

use barochart_core::data::{
    Bar, BarStore, BatchReceipt, Committed, DataEventValue, ModelDataState, StoreOptions,
};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::string::JsString;
use data_input::{
    DataInputError, DataInputMode, NullishBase, apply_data_event_input, apply_data_events_input,
    set_columns_input, set_data_input,
};

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/data-input.leaf.jsonl");

fn parse(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
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
fn mode(value: &JsValue) -> DataInputMode {
    match string(value).as_str() {
        "legacy" => DataInputMode::LegacyStore,
        "api" => DataInputMode::ApiFacade,
        _ => panic!("mode"),
    }
}

fn fixture_bar(value: &JsValue) -> Bar {
    Bar {
        time: number(get(value, "time")),
        open: number(get(value, "open")),
        high: number(get(value, "high")),
        low: number(get(value, "low")),
        close: number(get(value, "close")),
        volume: number(get(value, "volume")),
    }
}
fn fixture_bars(value: &JsValue) -> Vec<Bar> {
    array(value).iter().map(fixture_bar).collect()
}

fn new_store(initial: &JsValue) -> BarStore {
    ModelDataState::new(
        StoreOptions {
            max_bars: 16,
            ..StoreOptions::default()
        },
        fixture_bars(initial),
    )
    .unwrap()
    .store()
    .clone()
}

fn state(store: &BarStore) -> JsValue {
    let mut columns = JsObject::new();
    for (key, values) in [
        ("time", &store.columns().time),
        ("open", &store.columns().open),
        ("high", &store.columns().high),
        ("low", &store.columns().low),
        ("close", &store.columns().close),
        ("volume", &store.columns().volume),
    ] {
        columns.insert(
            JsString::from_str(key),
            JsValue::Array(values.iter().copied().map(JsValue::Number).collect()),
        );
    }
    object_value([
        ("length", JsValue::Number(store.length() as f64)),
        ("capacity", JsValue::Number(store.capacity() as f64)),
        ("version", JsValue::Number(store.version())),
        ("timeVersion", JsValue::Number(store.time_version())),
        ("bytes", JsValue::Number(store.bytes() as f64)),
        ("columns", JsValue::Object(columns)),
    ])
}

fn object_value<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(JsString::from_str(key), value);
    }
    JsValue::Object(object)
}

fn receipt_wire(receipt: &BatchReceipt) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in [
        ("events", receipt.events),
        ("appended", receipt.appended),
        ("from", receipt.from),
        ("to", receipt.to),
    ] {
        object.insert(JsString::from_str(key), JsValue::Number(value as f64));
    }
    object.insert(
        JsString::from_str("version"),
        JsValue::Number(receipt.version),
    );
    for (key, value) in [
        ("length", receipt.length),
        ("capacity", receipt.capacity),
        ("bytes", receipt.bytes),
    ] {
        object.insert(JsString::from_str(key), JsValue::Number(value as f64));
    }
    if let Some(value) = receipt.unchanged {
        object.insert(JsString::from_str("unchanged"), JsValue::Bool(value));
    }
    JsValue::Object(object)
}

fn execute(
    store: &mut BarStore,
    operation: &str,
    args: &[JsValue],
    mode: DataInputMode,
) -> Result<Committed<DataEventValue>, DataInputError> {
    match operation {
        "setData" => set_data_input(store, &args[0], mode),
        "setColumns" => set_columns_input(store, &args[0], args.get(1), mode),
        "applyDataEvent" => apply_data_event_input(store, &args[0], mode),
        "applyDataEvents" => apply_data_events_input(store, &args[0], args.get(1), mode),
        _ => panic!("operation {operation}"),
    }
}

fn compare_error(actual: DataInputError, expected: &JsValue, id: &str) {
    match string(get(expected, "kind")).as_str() {
        "js" => {
            let DataInputError::Js(actual) = actual else {
                panic!("expected js {id}")
            };
            assert_eq!(actual.name, string(get(expected, "name")), "{id}");
            assert_eq!(
                actual.message.to_string_lossy(),
                string(get(expected, "message")),
                "{id}"
            );
            let code = get(expected, "code");
            match code {
                JsValue::Null => assert!(actual.code.is_none(), "{id}"),
                _ => assert_eq!(actual.code.as_deref(), Some(string(code).as_str()), "{id}"),
            }
        }
        "nullish-property" => {
            let DataInputError::NullishPropertyAccess {
                base,
                property,
                expression,
            } = actual
            else {
                panic!("expected nullish {id}")
            };
            assert_eq!(
                base,
                match string(get(expected, "base")).as_str() {
                    "null" => NullishBase::Null,
                    "undefined" => NullishBase::Undefined,
                    _ => panic!("base"),
                }
            );
            assert_eq!(property, string(get(expected, "property")));
            assert_eq!(expression, string(get(expected, "expression")));
            assert_eq!(string(get(get(expected, "v8"), "name")), "TypeError");
        }
        _ => panic!("error kind"),
    }
}

#[test]
fn actual_js_leaf_oracle_matches_state_errors_receipts_and_change_order() {
    let mut lines = FIXTURE.lines();
    let header = parse(lines.next().unwrap());
    assert_eq!(
        string(get(&header, "oracleCommit")),
        "87598ca492e6a7273b60b629c0cf9f2456268853"
    );
    let mut cases = 0;
    let mut nullish = 0;
    for line in lines {
        let row = parse(line);
        let id = string(get(&row, "id"));
        let mode = mode(get(&row, "mode"));
        let operation = string(get(&row, "operation"));
        let initial = decode_wire(get(&row, "initial"));
        let args = decode_wire(get(&row, "args"));
        let args = array(&args);
        let mut store = new_store(&initial);
        let result = execute(&mut store, &operation, args, mode);
        match get(&row, "error") {
            JsValue::Null => {
                let committed = result.unwrap_or_else(|error| panic!("{id}: {error:?}"));
                if let DataEventValue::Batch(receipt) = &committed.value {
                    assert_eq!(
                        json(&encode_wire(&receipt_wire(receipt))),
                        json(get(&row, "result")),
                        "receipt {id}"
                    );
                }
                let expected_changes = decode_wire(get(&row, "changes"));
                let actual_changes = committed
                    .change
                    .as_ref()
                    .map(|change| change.to_js_value())
                    .into_iter()
                    .collect::<Vec<_>>();
                assert_eq!(
                    json(&encode_wire(&JsValue::Array(actual_changes))),
                    json(&encode_wire(&expected_changes)),
                    "changes {id}"
                );
                if mode == DataInputMode::ApiFacade {
                    assert_eq!(
                        committed.change.is_some(),
                        number(get(&row, "invalidations")) != 0.0,
                        "invalidation {id}"
                    );
                }
            }
            expected => {
                let error = result.unwrap_err();
                if matches!(error, DataInputError::NullishPropertyAccess { .. }) {
                    nullish += 1;
                }
                compare_error(error, expected, &id);
                assert!(
                    array(&decode_wire(get(&row, "changes"))).is_empty(),
                    "failure change {id}"
                );
            }
        }
        assert_eq!(
            json(&encode_wire(&state(&store))),
            json(get(&row, "state")),
            "state {id}"
        );
        cases += 1;
    }
    assert_eq!(cases, 36);
    assert_eq!(nullish, 3);
}

#[test]
fn structured_nullish_error_keeps_platform_expression_without_text() {
    let mut store = new_store(&JsValue::Array(Vec::new()));
    let event = object_value([("kind", JsValue::String(JsString::from_str("correction")))]);
    let error = apply_data_event_input(&mut store, &event, DataInputMode::LegacyStore).unwrap_err();
    assert!(matches!(
        error,
        DataInputError::NullishPropertyAccess {
            base: NullishBase::Undefined,
            property: "time",
            expression: "event.bar.time"
        }
    ));
}

#[test]
fn committed_values_keep_the_existing_typed_store_contract() {
    let mut store = new_store(&JsValue::Array(Vec::new()));
    let append = decode_wire(&parse(
        r#"{"$object":[["kind","append"],["bar",{"$object":[["time",{"$f64":"3ff0000000000000"}],["open",{"$f64":"4000000000000000"}],["high",{"$f64":"4000000000000000"}],["low",{"$f64":"4000000000000000"}],["close",{"$f64":"4000000000000000"}],["volume",{"$f64":"3ff0000000000000"}]]}]]}"#,
    ));
    let committed =
        apply_data_event_input(&mut store, &append, DataInputMode::LegacyStore).unwrap();
    assert!(matches!(committed.value, DataEventValue::Index(0)));

    let reset = decode_wire(&parse(
        r#"[{"$object":[["time",{"$f64":"4000000000000000"}],["open",{"$f64":"4008000000000000"}],["high",{"$f64":"4008000000000000"}],["low",{"$f64":"4008000000000000"}],["close",{"$f64":"4008000000000000"}],["volume",{"$f64":"3ff0000000000000"}]]}]"#,
    ));
    let committed = set_data_input(&mut store, &reset, DataInputMode::ApiFacade).unwrap();
    assert!(matches!(committed.value, DataEventValue::None));
}
