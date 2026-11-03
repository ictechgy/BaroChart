use barochart_core::{indicator_helpers, indicator_params, indicator_types, native_checkpoints};

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16};
use barochart_js::string::JsString;
use indicator_helpers::exact_state_equal;
use indicator_params::validate_indicator_params;
use indicator_types::IndicatorProgram;
use native_checkpoints::{
    NATIVE_CHECKPOINT_RECORD_BYTES, NATIVE_CHECKPOINT_TOTAL_BYTES, NativeCheckpointBudget,
    NativeCheckpointMap, native_checkpoint_footprint,
};

fn value(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn ema_map(budget: NativeCheckpointBudget) -> NativeCheckpointMap {
    NativeCheckpointMap::new(
        IndicatorProgram::Ema,
        validate_indicator_params(&value(r#"{"period":20}"#)).unwrap(),
        budget,
        256,
    )
    .unwrap()
}

#[test]
fn exact_record_and_shared_total_budget_charge_replacements_atomically() {
    assert_eq!(NATIVE_CHECKPOINT_RECORD_BYTES, 262_144);
    assert_eq!(NATIVE_CHECKPOINT_TOTAL_BYTES, 33_554_432);
    let budget = NativeCheckpointBudget::new(1_024).unwrap();
    assert_eq!(budget.max_bytes(), 1_024);
    let mut first = ema_map(budget.clone());
    let mut second = ema_map(budget.clone());
    first.set(0.0, value("{}")).unwrap();
    second.set(0.0, value("{}")).unwrap();
    let used = budget.used_bytes();
    let before = first.get(0.0).unwrap().unwrap();
    let large = value(&format!(
        r#"{{"e":{{"count":20,"sum":0,"value":1}},"padding":"{}"}}"#,
        "x".repeat(2_000)
    ));
    assert!(first.set(256.0, large).is_err());
    assert_eq!(budget.used_bytes(), used);
    assert!(exact_state_equal(
        &first.get(0.0).unwrap().unwrap(),
        &before
    ));
    first.clear().unwrap();
    second.clear().unwrap();
    assert_eq!(budget.used_bytes(), 0);

    let tight = NativeCheckpointBudget::new(6).unwrap();
    let mut first = ema_map(tight.clone());
    let mut second = ema_map(tight.clone());
    first.set(0.0, value("{}")).unwrap();
    assert!(second.set(0.0, value("{}")).is_err());
    assert_eq!(tight.used_bytes(), 4);
}

#[test]
fn set_get_iteration_and_history_use_owned_sorted_records() {
    let budget = NativeCheckpointBudget::new(NATIVE_CHECKPOINT_TOTAL_BYTES).unwrap();
    let mut map = ema_map(budget.clone());
    let warm = value(r#"{"e":{"count":20,"sum":0,"value":1}}"#);
    map.set(512.0, warm.clone()).unwrap();
    map.set(0.0, value("{}")).unwrap();
    map.set(256.0, warm.clone()).unwrap();
    let before_delete = budget.used_bytes();
    assert!(map.delete(512.0).unwrap());
    assert!(budget.used_bytes() < before_delete);
    map.set(512.0, warm.clone()).unwrap();
    assert_eq!(map.keys().unwrap(), vec![0.0, 256.0, 512.0]);
    assert!(map.validate_history(512.0).is_ok());
    let mut detached = map.get(256.0).unwrap().unwrap();
    if let JsValue::Object(object) = &mut detached {
        object.insert(JsString::from_str("changed"), JsValue::Bool(true));
    }
    assert!(exact_state_equal(&map.get(256.0).unwrap().unwrap(), &warm));
    assert_eq!(budget.used_bytes(), map.encoded_bytes());
}

#[test]
fn invalid_index_or_state_never_changes_records_or_accounting() {
    let budget = NativeCheckpointBudget::new(4_096).unwrap();
    let mut map = ema_map(budget.clone());
    map.set(0.0, value("{}")).unwrap();
    let before = map.get(0.0).unwrap().unwrap();
    let bytes = budget.used_bytes();
    for index in [-1.0, 1.0, 255.0, 1.5, f64::NAN, 4_194_305.0] {
        assert!(map.set(index, value("{}")).is_err());
        assert!(exact_state_equal(&map.get(0.0).unwrap().unwrap(), &before));
        assert_eq!(budget.used_bytes(), bytes);
    }
    assert!(
        map.set(256.0, value(r#"{"e":{"count":1,"sum":0,"value":1}}"#))
            .is_err()
    );
    assert_eq!(map.size(), 1);
}

#[test]
fn publish_returns_ordinary_records_and_retires_the_bounded_ledger() {
    let budget = NativeCheckpointBudget::new(4_096).unwrap();
    let mut map = ema_map(budget.clone());
    map.set(0.0, value("{}")).unwrap();
    map.set(256.0, value(r#"{"e":{"count":20,"sum":0,"value":1}}"#))
        .unwrap();
    let ordinary = map.publish().unwrap();
    assert_eq!(ordinary.keys().copied().collect::<Vec<_>>(), vec![0, 256]);
    assert_eq!(budget.used_bytes(), 0);
    assert!(map.get(0.0).is_err());
    map.dispose().unwrap();
    assert_eq!(budget.used_bytes(), 0);
}

#[test]
fn footprint_counts_special_markers_utf16_and_nodes_without_mutating_state() {
    let mut object = JsObject::new();
    object.insert(
        JsString::from_str("한국 🚀"),
        JsValue::Array(vec![
            JsValue::Number(f64::NAN),
            JsValue::Number(f64::INFINITY),
            JsValue::Number(f64::NEG_INFINITY),
            JsValue::Number(-0.0),
            JsValue::Null,
            JsValue::Bool(true),
        ]),
    );
    let state = JsValue::Object(object);
    let before = state.clone();
    let footprint = native_checkpoint_footprint(&state).unwrap();
    assert_eq!(footprint.encoded_bytes, 246);
    assert_eq!(footprint.nodes, 8);
    assert_eq!(footprint.logical_bytes, 502);
    assert!(exact_state_equal(&state, &before));
    assert!(
        native_checkpoint_footprint(&JsValue::String(JsString::from_str(
            &"x".repeat(NATIVE_CHECKPOINT_RECORD_BYTES / 2)
        )))
        .is_err()
    );
}
