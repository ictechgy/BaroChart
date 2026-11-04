use barochart_core::indicator_params_update;

use barochart_core::checkpoint_codec::safe_checkpoint_stringify;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::string::JsString;

use indicator_params_update::set_indicator_params;

const STUDY_FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-indicators/study-setup-oracle.jsonl");

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

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn params(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (key, item) in entries {
        value.insert(JsString::from_str(key), item.clone());
    }
    JsValue::Object(value)
}

fn store(length: usize) -> ModelDataState {
    ModelDataState::new(
        StoreOptions::default(),
        (0..length)
            .map(|index| Bar {
                time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
                open: index as f64 + 1.0,
                high: index as f64 + 2.0,
                low: index as f64,
                close: index as f64 + 1.5,
                volume: index as f64 + 1.0,
            })
            .collect(),
    )
    .unwrap()
}

fn close_store(closes: &[f64]) -> ModelDataState {
    ModelDataState::new(
        StoreOptions::default(),
        closes
            .iter()
            .enumerate()
            .map(|(index, close)| Bar {
                time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
                open: *close,
                high: *close + 1.0,
                low: *close - 1.0,
                close: *close,
                volume: index as f64 + 5.0,
            })
            .collect(),
    )
    .unwrap()
}

fn parse(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object")
    };
    value
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    object(value).get(&JsString::from_str(name)).unwrap()
}

fn string(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string")
    };
    value.to_string_lossy()
}

fn receipt_wire(receipt: &barochart_core::indicator_engine::IndicatorPublishReceipt) -> JsValue {
    let mut offsets = JsObject::new();
    for (output, value) in &receipt.plot_offsets {
        offsets.insert(output.clone(), JsValue::Number(*value));
    }
    params(&[
        (
            "outputs",
            JsValue::Array(
                receipt
                    .outputs
                    .iter()
                    .cloned()
                    .map(JsValue::String)
                    .collect(),
            ),
        ),
        ("plotOffsets", JsValue::Object(offsets)),
    ])
}

fn empty_object() -> JsValue {
    JsValue::Object(JsObject::new())
}

fn model_with_series(
    engine: &IndicatorEngine,
    data: &ModelDataState,
    indicator: &str,
    output: &str,
) -> ModelState {
    let mut model = ModelState::new(data.store(), &empty_object()).unwrap();
    let entry = engine.entry(&text(indicator)).unwrap();
    let projections = [IndicatorProjection {
        id: entry.id(),
        definition: entry.definition(),
    }];
    let context = ModelContext {
        store: data.store(),
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    let mut series = JsObject::new();
    for (key, value) in [
        ("id", text("line")),
        ("type", text("line")),
        ("panel", text("price")),
        ("indicator", text(indicator)),
        ("output", text(output)),
        ("color", text("#123456")),
    ] {
        series.insert(JsString::from_str(key), value);
    }
    model
        .add_series(&JsValue::Object(series), &context)
        .unwrap();
    model
}

fn js_error(message: &str) -> barochart_js::error::JsError {
    barochart_js::error::JsError::new("Error", JsString::from_str(message))
}

#[test]
fn real_engine_stage_keeps_live_entry_until_atomic_publish() {
    let host = NoZones;
    let data = store(40);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let before = engine.entry(&text("e")).unwrap();
    let old_output = before.output_capacity("value").unwrap().as_ptr();
    assert_eq!(before.definition().params.number("period"), Some(5.0));

    let mut stage = engine.begin_stage(data.store());
    let staged = engine
        .stage_replace(
            &mut stage,
            data.store(),
            &host,
            &text("e"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();
    assert!(staged.changed);
    let before_publish = engine.entry(&text("e")).unwrap();
    assert_eq!(
        before_publish.definition().params.number("period"),
        Some(5.0)
    );
    assert_eq!(
        before_publish.output_capacity("value").unwrap().as_ptr(),
        old_output
    );

    let receipts = engine.publish_stage(data.store(), stage).unwrap();
    assert_eq!(receipts.len(), 1);
    assert!(receipts[0].changed);
    let published = engine.entry(&text("e")).unwrap();
    assert_eq!(published.definition().params.number("period"), Some(2.0));
    assert_ne!(
        published.output_capacity("value").unwrap().as_ptr(),
        old_output
    );
}

#[test]
fn sync_params_publish_replaces_only_entry_and_invalidates_bound_series_cache() {
    let host = NoZones;
    let data = store(40);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let mut model = model_with_series(&engine, &data, "e", "value");
    model.series[0].range_index_ready = true;
    model.series[0].revision = Some(7.0);
    model.series[0].dirty_from = 13.0;
    let series_identity = &model.series[0] as *const _;
    let old_output = engine
        .entry(&text("e"))
        .unwrap()
        .output_capacity("value")
        .unwrap()
        .as_ptr();

    let receipt = set_indicator_params(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text("e"),
        &params(&[("period", JsValue::Number(2.0))]),
        None,
    )
    .unwrap();
    assert!(receipt.changed);
    assert_eq!(receipt.outputs, vec![JsString::from_str("value")]);
    let entry = engine.entry(&text("e")).unwrap();
    assert_eq!(entry.definition().params.number("period"), Some(2.0));
    assert_ne!(entry.output_capacity("value").unwrap().as_ptr(), old_output);
    assert_eq!(&model.series[0] as *const _, series_identity);
    assert!(!model.series[0].range_index_ready);
    assert_eq!(model.series[0].revision, None);
    assert_eq!(model.series[0].dirty_from, 0.0);
}

#[test]
fn successful_params_receipt_state_and_outputs_match_node22_oracle() {
    let host = NoZones;
    let row = parse(STUDY_FIXTURE.lines().nth(3).unwrap());
    let data = close_store(&[10.0, 11.0, 11.0, 9.0, 12.0, 8.0, 13.0, 10.0]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let held = engine
        .add(
            data.store(),
            &host,
            &text("ema"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap()
        .output("value")
        .unwrap()
        .to_vec();
    let mut model = model_with_series(&engine, &data, "ema", "value");
    let receipt = set_indicator_params(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text("ema"),
        &params(&[
            ("unknown", JsValue::Number(-0.0)),
            ("period", JsValue::Number(2.0)),
        ]),
        None,
    )
    .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&receipt_wire(&receipt))
            .unwrap()
            .to_string_lossy(),
        string(field(&row, "receiptLossless"))
    );
    assert_eq!(
        safe_checkpoint_stringify(&receipt.params)
            .unwrap()
            .to_string_lossy(),
        string(field(&row, "paramsLossless"))
    );
    assert_eq!(
        safe_checkpoint_stringify(&JsValue::Array(
            held.into_iter().map(JsValue::Number).collect()
        ))
        .unwrap()
        .to_string_lossy(),
        string(field(&row, "heldLossless"))
    );
    let actual = engine
        .get(data.store(), &host, &text("ema"))
        .unwrap()
        .output("value")
        .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&JsValue::Array(
            actual.iter().copied().map(JsValue::Number).collect()
        ))
        .unwrap()
        .to_string_lossy(),
        string(field(field(&row, "values"), "value"))
    );
}

#[test]
fn same_params_runs_guard_without_replacing_entry_or_caches() {
    let host = NoZones;
    let data = store(8);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let mut model = model_with_series(&engine, &data, "e", "value");
    model.series[0].range_index_ready = true;
    model.series[0].revision = Some(3.0);
    model.series[0].dirty_from = 4.0;
    let output = engine
        .entry(&text("e"))
        .unwrap()
        .output_capacity("value")
        .unwrap()
        .as_ptr();
    let mut calls = 0;
    let mut guard = || {
        calls += 1;
        Ok(())
    };
    let receipt = set_indicator_params(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text("e"),
        &params(&[("period", JsValue::Number(5.0))]),
        Some(&mut guard),
    )
    .unwrap();
    assert!(!receipt.changed);
    assert_eq!(calls, 1);
    assert_eq!(
        engine
            .entry(&text("e"))
            .unwrap()
            .output_capacity("value")
            .unwrap()
            .as_ptr(),
        output
    );
    assert!(model.series[0].range_index_ready);
    assert_eq!(model.series[0].revision, Some(3.0));
    assert_eq!(model.series[0].dirty_from, 4.0);
}

#[test]
fn owner_guard_failure_keeps_original_entry_and_series_cache() {
    let host = NoZones;
    let data = store(8);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let mut model = model_with_series(&engine, &data, "e", "value");
    model.series[0].range_index_ready = true;
    let output = engine
        .entry(&text("e"))
        .unwrap()
        .output_capacity("value")
        .unwrap()
        .as_ptr();
    let mut guard = || Err(js_error("owner guard"));
    let error = set_indicator_params(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text("e"),
        &params(&[("period", JsValue::Number(2.0))]),
        Some(&mut guard),
    )
    .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "owner guard");
    let entry = engine.entry(&text("e")).unwrap();
    assert_eq!(entry.definition().params.number("period"), Some(5.0));
    assert_eq!(entry.output_capacity("value").unwrap().as_ptr(), output);
    assert!(model.series[0].range_index_ready);
}

#[test]
fn schema_offset_and_compute_failures_leave_original_entries_untouched() {
    let host = NoZones;
    let data = store(8);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    for (id, name, params) in [
        ("v", "vwap", params(&[])),
        (
            "i",
            "ichimoku",
            params(&[("displacement", JsValue::Number(26.0))]),
        ),
        (
            "k",
            "keltner",
            params(&[
                ("period", JsValue::Number(1.0)),
                ("atrPeriod", JsValue::Number(1.0)),
                ("multiplier", JsValue::Number(1.0)),
            ]),
        ),
    ] {
        engine
            .add(data.store(), &host, &text(id), &text(name), &params)
            .unwrap();
    }
    let mut model = ModelState::new(data.store(), &empty_object()).unwrap();
    for (id, next, message) in [
        (
            "v",
            params(&[
                ("source", text("hlc3")),
                ("deviation", JsValue::Number(2.0)),
            ]),
            "Indicator parameter update cannot change output schema",
        ),
        (
            "i",
            params(&[("displacement", JsValue::Number(27.0))]),
            "Indicator parameter update cannot change plot offsets",
        ),
        (
            "k",
            params(&[
                ("period", JsValue::Number(1.0)),
                ("atrPeriod", JsValue::Number(1.0)),
                ("multiplier", JsValue::Number(f64::MAX)),
            ]),
            "Output must be finite or NaN",
        ),
    ] {
        let before = engine.entry(&text(id)).unwrap();
        let output = before
            .output_capacity(before.definition().outputs[0])
            .unwrap();
        let pointer = output.as_ptr();
        let values = output.to_vec();
        let error = set_indicator_params(
            &mut engine,
            &mut model,
            data.store(),
            &host,
            &text(id),
            &next,
            None,
        )
        .unwrap_err();
        assert_eq!(error.message.to_string_lossy(), message);
        let after = engine.entry(&text(id)).unwrap();
        let output = after
            .output_capacity(after.definition().outputs[0])
            .unwrap();
        assert_eq!(output.as_ptr(), pointer);
        assert!(output.iter().zip(values).all(|(left, right)| {
            left.to_bits() == right.to_bits() || left.is_nan() && right.is_nan()
        }));
    }
}

#[test]
fn ordered_unknown_params_and_negative_zero_survive_successful_replacement() {
    let host = NoZones;
    let data = store(8);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let mut model = ModelState::new(data.store(), &empty_object()).unwrap();
    let requested = params(&[
        ("unknown", JsValue::Number(-0.0)),
        ("period", JsValue::Number(2.0)),
    ]);
    let receipt = set_indicator_params(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text("e"),
        &requested,
        None,
    )
    .unwrap();
    let JsValue::Object(params) = &receipt.params else {
        panic!("params")
    };
    let keys = params
        .iter()
        .map(|(key, _)| key.to_string_lossy())
        .collect::<Vec<_>>();
    assert_eq!(keys, vec!["period", "unknown"]);
    let Some(JsValue::Number(unknown)) = params.get(&JsString::from_str("unknown")) else {
        panic!("unknown")
    };
    assert_eq!(unknown.to_bits(), (-0.0f64).to_bits());
}

#[test]
fn staged_replacement_rejects_source_change_before_publish() {
    let host = NoZones;
    let mut data = store(8);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let output = engine
        .entry(&text("e"))
        .unwrap()
        .output_capacity("value")
        .unwrap()
        .as_ptr();
    let mut stage = engine.begin_stage(data.store());
    engine
        .stage_replace(
            &mut stage,
            data.store(),
            &host,
            &text("e"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();
    let current = data.store().at(0).unwrap();
    data.store_mut().update(0, current).unwrap();
    let error = engine.publish_stage(data.store(), stage).unwrap_err();
    assert_eq!(
        error.message.to_string_lossy(),
        "Indicator params stale: owner changed during staging"
    );
    let entry = engine.entry(&text("e")).unwrap();
    assert_eq!(entry.definition().params.number("period"), Some(5.0));
    assert_eq!(entry.output_capacity("value").unwrap().as_ptr(), output);
}

#[test]
fn published_candidate_replays_next_append_like_a_fresh_engine() {
    let host = NoZones;
    let mut data = store(8);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let mut model = ModelState::new(data.store(), &empty_object()).unwrap();
    set_indicator_params(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text("e"),
        &params(&[("period", JsValue::Number(2.0))]),
        None,
    )
    .unwrap();
    let last = data.store().at(data.store().length() - 1).unwrap();
    let appended = Bar {
        time: last.time + 60_000.0,
        open: last.close,
        high: last.close + 1.0,
        low: last.close - 1.0,
        close: last.close + 0.5,
        volume: 9.0,
    };
    let change = data.store_mut().append(appended).unwrap().change.unwrap();
    engine.apply_change(data.store(), &change);
    let actual = engine
        .get(data.store(), &host, &text("e"))
        .unwrap()
        .output("value")
        .unwrap()
        .to_vec();
    let mut fresh = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let expected = fresh
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap()
        .output("value")
        .unwrap()
        .to_vec();
    assert!(actual.iter().zip(expected).all(|(left, right)| {
        left.to_bits() == right.to_bits() || left.is_nan() && right.is_nan()
    }));
}

#[test]
fn dropped_candidate_is_unpublished_and_success_uses_live_ordinary_checkpoints() {
    let host = NoZones;
    let mut data = store(300);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut discarded = engine.begin_stage(data.store());
    engine
        .stage_add(
            &mut discarded,
            data.store(),
            &host,
            &text("s"),
            &text("sma"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    assert_eq!(discarded.candidates().count(), 1);
    drop(discarded);
    assert_eq!(engine.len(), 0);

    let mut stage = engine.begin_stage(data.store());
    engine
        .stage_add(
            &mut stage,
            data.store(),
            &host,
            &text("s"),
            &text("sma"),
            &params(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    engine.publish_stage(data.store(), stage).unwrap();
    assert_eq!(
        engine.entry(&text("s")).unwrap().checkpoint_keys(),
        vec![0, 256]
    );
    let last = data.store().at(data.store().length() - 1).unwrap();
    let change = data
        .store_mut()
        .append(Bar {
            time: last.time + 60_000.0,
            open: last.close,
            high: last.close + 1.0,
            low: last.close - 1.0,
            close: last.close + 0.25,
            volume: 1.0,
        })
        .unwrap()
        .change
        .unwrap();
    engine.apply_change(data.store(), &change);
    engine.get(data.store(), &host, &text("s")).unwrap();
    assert_eq!(
        engine.entry(&text("s")).unwrap().checkpoint_keys(),
        vec![0, 256]
    );
}
