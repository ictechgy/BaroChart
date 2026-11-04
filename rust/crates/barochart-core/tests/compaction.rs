use barochart_core::{compaction, indicator_helpers};

use barochart_core::checkpoint_codec::safe_checkpoint_stringify;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::ingestion::IngestionOwner;
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use compaction::{CompactionContext, compact_data};
use indicator_helpers::exact_state_equal;

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/explorer-compaction.leaf.jsonl");

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
fn record(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (key, item) in entries {
        value.insert(JsString::from_str(key), item.clone());
    }
    JsValue::Object(value)
}
fn parse(value: &str) -> JsValue {
    parse_json(value.as_bytes(), JsonMode::Standard).unwrap()
}
fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object")
    };
    value
}
fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array")
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
fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number")
    };
    *value
}
fn bars(length: usize) -> Vec<Bar> {
    (0..length)
        .map(|index| Bar {
            time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
            open: index as f64 + 10.0,
            high: index as f64 + 12.0,
            low: index as f64 + 9.0,
            close: index as f64 + 11.0,
            volume: index as f64 + 1.0,
        })
        .collect()
}
fn owner(length: usize) -> IngestionOwner {
    IngestionOwner::new(
        ModelDataState::new(StoreOptions::default(), bars(length)).unwrap(),
        NumberDialect::Ecma,
    )
}
fn options(keep: usize) -> JsValue {
    record(&[
        ("keepLastBars", JsValue::Number(keep as f64)),
        ("studyHistory", text("restart")),
    ])
}
fn policy(stream: &str) -> JsValue {
    record(&[
        ("streamId", text(stream)),
        ("generation", JsValue::Number(7.0)),
        ("firstSequence", JsValue::Number(-0.0)),
        ("maxQueuedEvents", JsValue::Number(8.0)),
        ("maxQueuedBytes", JsValue::Number(392.0)),
        ("maxBatchEvents", JsValue::Number(8.0)),
    ])
}
fn event(kind: &str, bar: Bar) -> JsValue {
    record(&[
        ("kind", text(kind)),
        (
            "bar",
            record(&[
                ("time", JsValue::Number(bar.time)),
                ("open", JsValue::Number(bar.open)),
                ("high", JsValue::Number(bar.high)),
                ("low", JsValue::Number(bar.low)),
                ("close", JsValue::Number(bar.close)),
                ("volume", JsValue::Number(bar.volume)),
            ]),
        ),
    ])
}
fn packet(events: Vec<JsValue>) -> JsValue {
    record(&[
        ("streamId", text("feed")),
        ("generation", JsValue::Number(7.0)),
        ("firstSequence", JsValue::Number(-0.0)),
        ("events", JsValue::Array(events)),
    ])
}
fn setup(length: usize) -> (NoZones, IngestionOwner, IndicatorEngine, ModelState) {
    let host = NoZones;
    let owner = owner(length);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            owner.data().store(),
            &host,
            &text("s"),
            &text("sma"),
            &record(&[("period", JsValue::Number(5.0))]),
        )
        .unwrap();
    let mut model = ModelState::new(owner.data().store(), &record(&[])).unwrap();
    let entry = engine.entry(&text("s")).unwrap();
    let projections = [IndicatorProjection {
        id: entry.id(),
        definition: entry.definition(),
    }];
    let context = ModelContext {
        store: owner.data().store(),
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    model
        .add_series(
            &record(&[
                ("id", text("line")),
                ("type", text("line")),
                ("panel", text("price")),
                ("indicator", text("s")),
                ("offset", JsValue::Number(2.0)),
            ]),
            &context,
        )
        .unwrap();
    model.series[0].range_index_ready = true;
    model.series[0].revision = Some(1.0);
    model.series[0].dirty_from = 7.0;
    (host, owner, engine, model)
}

#[test]
fn compaction_preserves_store_owner_and_atomically_restarts_derived_state() {
    let (_host, mut owner, mut engine, mut model) = setup(40);
    let before = owner.data().store().data_identity();
    let version = owner.data().store().version();
    let time_version = owner.data().store().time_version();
    let revision = engine.entry(&text("s")).unwrap().revision();
    let result = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(12),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap();
    let store = owner.data().store();
    assert!(before.same_store(&store.data_identity()));
    assert!(!before.same_columns(&store.data_identity()));
    assert_eq!(result.receipt.removed, 28);
    assert_eq!(result.receipt.length, 12);
    assert_eq!(result.receipt.capacity, 16);
    assert_eq!(store.version(), version + 1.0);
    assert_eq!(store.time_version(), time_version + 1.0);
    assert!(result.clear_crosshair);
    let entry = engine.entry(&text("s")).unwrap();
    assert_eq!(entry.revision(), revision);
    assert_eq!(entry.dirty(), 0);
    assert_eq!(entry.dirty_to(), Some(12));
    assert!(entry.invalidated());
    assert_eq!(entry.length(), 0);
    assert!(entry.output_capacity("value").is_none());
    assert!(!model.series[0].range_index_ready);
    assert_eq!(model.series[0].revision, None);
    assert_eq!(model.series[0].dirty_from, 0.0);
    assert!(exact_state_equal(
        &result.change.unwrap().to_js_value(),
        &record(&[
            ("from", JsValue::Number(0.0)),
            ("kind", text("compact")),
            ("version", JsValue::Number(version + 1.0)),
            ("removed", JsValue::Number(28.0)),
            ("studyHistory", text("restart"))
        ])
    ));
    let mut invalidation = result.receipt;
    invalidation.mark_invalidation_failed();
    let invalidation_wire = invalidation.to_js_value();
    let JsValue::Object(wire) = &invalidation_wire else {
        panic!("receipt")
    };
    assert!(matches!(
        wire.get(&JsString::from_str("invalidationFailed")),
        Some(JsValue::Bool(true))
    ));
}

#[test]
fn node22_compaction_receipt_store_entries_series_and_view_match() {
    let expected = parse(FIXTURE.lines().nth(4).unwrap());
    let host = NoZones;
    let mut owner = owner(40);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            owner.data().store(),
            &host,
            &text("ema"),
            &text("ema"),
            &record(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();
    engine
        .add(
            owner.data().store(),
            &host,
            &text("pressure"),
            &text("aster.volume-direction@1/pressure"),
            &record(&[("shift", JsValue::Number(1.0))]),
        )
        .unwrap();
    let mut model = ModelState::new(owner.data().store(), &record(&[])).unwrap();
    let ids = engine.entry_ids();
    let projections = ids
        .iter()
        .map(|id| {
            let entry = engine.entry(&JsValue::String(id.clone())).unwrap();
            IndicatorProjection {
                id: entry.id(),
                definition: entry.definition(),
            }
        })
        .collect::<Vec<_>>();
    let context = ModelContext {
        store: owner.data().store(),
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    for options in [
        record(&[
            ("id", text("close")),
            ("type", text("line")),
            ("panel", text("price")),
            ("source", text("close")),
        ]),
        record(&[
            ("id", text("ema-line")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("ema")),
            ("output", text("value")),
        ]),
        record(&[
            ("id", text("pressure-line")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("pressure")),
            ("output", text("cumulative")),
            ("offset", JsValue::Number(1.0)),
        ]),
    ] {
        model.add_series(&options, &context).unwrap();
    }
    model.series[0].range_index_ready = true;
    model.series[0].revision = Some(9.0);
    model.series[0].dirty_from = 7.0;
    let result = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(12),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&result.receipt.to_js_value())
            .unwrap()
            .to_string_lossy(),
        string(field(&expected, "receiptLossless"))
    );
    let after = field(&expected, "after");
    let expected_store = field(after, "store");
    assert_eq!(
        owner.data().store().length(),
        number(field(expected_store, "length")) as usize
    );
    assert_eq!(
        owner.data().store().capacity(),
        number(field(expected_store, "capacity")) as usize
    );
    for name in ["time", "open", "high", "low", "close", "volume"] {
        let actual = match name {
            "time" => &owner.data().store().columns().time,
            "open" => &owner.data().store().columns().open,
            "high" => &owner.data().store().columns().high,
            "low" => &owner.data().store().columns().low,
            "close" => &owner.data().store().columns().close,
            "volume" => &owner.data().store().columns().volume,
            _ => unreachable!(),
        };
        assert_eq!(
            safe_checkpoint_stringify(&JsValue::Array(
                actual.iter().copied().map(JsValue::Number).collect()
            ))
            .unwrap()
            .to_string_lossy(),
            string(field(field(expected_store, "columns"), name))
        );
    }
    for expected_entry in array(field(after, "entries")) {
        let id = string(field(expected_entry, "id"));
        let entry = engine.entry(&text(&id)).unwrap();
        assert_eq!(entry.revision(), number(field(expected_entry, "revision")));
        assert_eq!(
            entry.dirty(),
            number(field(expected_entry, "dirty")) as usize
        );
        assert_eq!(
            entry.dirty_to(),
            Some(number(field(expected_entry, "dirtyTo")) as usize)
        );
        assert!(entry.invalidated());
        assert_eq!(entry.length(), 0);
        assert!(entry.checkpoint_keys().is_empty());
    }
    let expected_view = field(after, "view");
    assert_eq!(
        model.view.from.to_bits(),
        number(field(expected_view, "from")).to_bits()
    );
    assert_eq!(
        model.view.to.to_bits(),
        number(field(expected_view, "to")).to_bits()
    );
}

#[test]
fn keep_at_least_length_is_noop_before_owner_and_interaction_guards() {
    let (_host, mut owner, mut engine, mut model) = setup(8);
    owner.configure(&policy("feed")).unwrap();
    let identity = owner.data().store().data_identity();
    let version = owner.data().store().version();
    let mut guard_calls = 0;
    let mut guard = || {
        guard_calls += 1;
        Ok(())
    };
    let result = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(8),
        CompactionContext {
            exclusive_owner: false,
            active_gesture: true,
            drawing_transaction: true,
        },
        Some(&mut guard),
    )
    .unwrap();
    assert_eq!(result.receipt.removed, 0);
    assert!(identity.matches(&owner.data().store().data_identity()));
    assert_eq!(owner.data().store().version(), version);
    assert_eq!(guard_calls, 1);
}

#[test]
fn paused_retained_pending_fifo_survives_compaction_and_later_drain() {
    let (_host, mut owner, mut engine, mut model) = setup(40);
    owner.configure(&policy("feed")).unwrap();
    let correction = owner.data().store().at(30).unwrap();
    let last = owner.data().store().at(39).unwrap();
    let appended = Bar {
        time: last.time + 60_000.0,
        open: last.close,
        high: last.close + 2.0,
        low: last.close - 1.0,
        close: last.close + 1.0,
        volume: 5.0,
    };
    let updated = Bar {
        close: appended.close + 0.5,
        high: appended.high + 0.5,
        ..appended
    };
    owner
        .enqueue(&packet(vec![
            event("correction", correction),
            event("append", appended),
            event("update", updated),
        ]))
        .unwrap();
    owner.pause().unwrap();
    let saved = owner.save().unwrap();
    let result = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &record(&[
            ("keepLastBars", JsValue::Number(12.0)),
            ("studyHistory", text("restart")),
            ("pendingData", text("preserve-retained")),
        ]),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap();
    assert_eq!(result.receipt.removed, 28);
    assert_eq!(owner.save().unwrap(), saved);
    owner.resume().unwrap();
    let drained = owner.drain(None, false).unwrap();
    assert_eq!(drained.receipt.events, 3);
    assert_eq!(owner.data().store().length(), 13);
    assert_eq!(owner.data().store().at(12).unwrap().close, updated.close);
}

#[test]
fn async_fence_keeps_ingestion_error_name_and_busy_code() {
    let (_host, mut owner, mut engine, mut model) = setup(8);
    owner.acquire_fence();
    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(4),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(error.name(), "IngestionError");
    assert_eq!(error.code(), Some("BUSY"));
}

#[test]
fn preserve_pending_rejects_corrections_to_removed_timestamps() {
    let (_host, mut owner, mut engine, mut model) = setup(40);
    owner.configure(&policy("feed")).unwrap();
    let removed = owner.data().store().at(5).unwrap();
    owner
        .enqueue(&packet(vec![event("correction", removed)]))
        .unwrap();
    owner.pause().unwrap();
    let version = owner.data().store().version();
    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &record(&[
            ("keepLastBars", JsValue::Number(12.0)),
            ("studyHistory", text("restart")),
            ("pendingData", text("preserve-retained")),
        ]),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(error.name(), "Error");
    assert_eq!(
        error.message().to_string_lossy(),
        "Compaction pending correction requires retained timestamp"
    );
    assert_eq!(owner.data().store().version(), version);
}

#[test]
fn compaction_guard_and_budget_first_errors_leave_store_unchanged() {
    let (_host, mut owner, mut engine, mut model) = setup(40);
    let version = owner.data().store().version();
    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(12),
        CompactionContext {
            exclusive_owner: false,
            active_gesture: true,
            drawing_transaction: true,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(
        error.message().to_string_lossy(),
        "Compaction requires one exclusive live model and indicator engine"
    );
    assert_eq!(owner.data().store().version(), version);

    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(12),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: true,
            drawing_transaction: true,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(
        error.message().to_string_lossy(),
        "Compaction during drawing transaction"
    );
    assert_eq!(owner.data().store().version(), version);

    model.panels[0].scale = JsString::from_str("percent");
    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(12),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(
        error.message().to_string_lossy(),
        "Compaction percent panel requires an explicit base"
    );
    model.panels[0].scale = JsString::from_str("linear");

    owner.configure(&policy("feed")).unwrap();
    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &options(12),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(error.name(), "Error");
    assert_eq!(
        error.message().to_string_lossy(),
        "Compaction requires paused empty idle ingestion unless preserving retained pending data"
    );
    assert_eq!(owner.data().store().version(), version);
}

#[test]
fn peak_budget_rejects_before_allocating_or_restarting_state() {
    let (_host, mut owner, mut engine, mut model) = setup(40);
    let version = owner.data().store().version();
    let revision = engine.entry(&text("s")).unwrap().revision();
    let error = compact_data(
        &mut owner,
        &mut engine,
        &mut model,
        &record(&[
            ("keepLastBars", JsValue::Number(12.0)),
            ("studyHistory", text("restart")),
            ("maxPeakStoreBytes", JsValue::Number(0.0)),
        ]),
        CompactionContext {
            exclusive_owner: true,
            active_gesture: false,
            drawing_transaction: false,
        },
        None,
    )
    .unwrap_err();
    assert_eq!(error.name(), "RangeError");
    assert_eq!(
        error.message().to_string_lossy(),
        "Compaction source peak byte budget"
    );
    assert_eq!(owner.data().store().version(), version);
    assert_eq!(engine.entry(&text("s")).unwrap().revision(), revision);
    assert!(
        engine
            .entry(&text("s"))
            .unwrap()
            .output_capacity("value")
            .is_some()
    );
}
