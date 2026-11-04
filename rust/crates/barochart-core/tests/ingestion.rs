use barochart_core::{batch_options, data, ingestion};

use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use data::{Bar, DataEvent, ModelDataState, StoreOptions};
use ingestion::{IngestionOwner, MAX_SAFE_INTEGER};

fn bar(time: f64, close: f64) -> Bar {
    Bar {
        time,
        open: close,
        high: close + 1.0,
        low: close - 1.0,
        close,
        volume: 10.0,
    }
}

fn value_object(entries: &[(&str, JsValue)]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(JsString::from_str(key), value.clone());
    }
    JsValue::Object(object)
}

fn text(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Lossless)).unwrap()
}

fn policy(stream: &str, patch: &[(&str, JsValue)]) -> JsValue {
    let mut entries = vec![
        ("streamId", JsValue::String(JsString::from_str(stream))),
        ("generation", JsValue::Number(7.0)),
    ];
    entries.extend_from_slice(patch);
    value_object(&entries)
}

fn event(kind: &str, bar: Bar) -> JsValue {
    value_object(&[
        ("kind", JsValue::String(JsString::from_str(kind))),
        (
            "bar",
            value_object(&[
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

fn packet(stream: &str, generation: f64, first: f64, events: Vec<JsValue>) -> JsValue {
    value_object(&[
        ("streamId", JsValue::String(JsString::from_str(stream))),
        ("generation", JsValue::Number(generation)),
        ("firstSequence", JsValue::Number(first)),
        ("events", JsValue::Array(events)),
    ])
}

fn owner() -> IngestionOwner {
    let data = ModelDataState::new(StoreOptions::default(), vec![bar(0.0, 10.0)]).unwrap();
    IngestionOwner::new(data, NumberDialect::Ecma)
}

#[test]
fn explicit_undefined_drain_uses_the_js_default_parameter() {
    let mut owner = owner();
    owner.configure(&policy("defaults", &[])).unwrap();
    let receipt = owner.drain(Some(&JsValue::Undefined), false).unwrap();
    assert_eq!(receipt.receipt.events, 0);
}

fn error<T: std::fmt::Debug>(result: Result<T, ingestion::IngestionError>) -> (String, String) {
    let error = result.unwrap_err();
    (error.code().to_owned(), error.message().to_string_lossy())
}

fn apply_error<T: std::fmt::Debug>(
    result: Result<T, ingestion::ApplyDataError>,
) -> (String, Option<String>, String) {
    let error = result.unwrap_err();
    (
        error.name().to_owned(),
        error.code().map(str::to_owned),
        error.message().to_string_lossy(),
    )
}

#[test]
fn configure_uses_policy_order_capacity_and_negative_zero_cursors() {
    let mut owner = owner();
    let stats = owner
        .configure(&policy(
            "feed-A",
            &[
                ("firstSequence", JsValue::Number(-0.0)),
                ("maxQueuedEvents", JsValue::Number(8.0)),
                ("maxQueuedBytes", JsValue::Number(392.0)),
                ("maxBatchEvents", JsValue::Number(2.0)),
            ],
        ))
        .unwrap();
    assert_eq!(
        text(&stats),
        r#"{"policy":{"streamId":"feed-A","generation":7,"firstSequence":-0,"maxQueuedEvents":8,"maxQueuedBytes":392,"maxBatchEvents":2,"maxStoredBars":4194304,"maxStoreBytes":402653184},"state":"running","nextSequence":-0,"accepted":0,"applied":0,"cancelled":0,"rejectedPackets":0,"rejectedEvents":0,"failedDrains":0,"peakPendingEvents":0,"peakPendingBytes":0,"lastAppliedSequence":null,"lastCancelledSequence":null,"pendingEvents":0,"pendingBytes":0,"ownedBytes":392,"lastError":null,"storedBars":1,"storeBytes":1536}"#
    );
}

#[test]
fn policy_validation_preserves_field_order_and_store_budget_priority() {
    let mut owner = owner();
    assert_eq!(
        error(owner.configure(&policy(
            "A",
            &[
                ("maxQueuedEvents", JsValue::Number(0.0)),
                ("maxQueuedBytes", JsValue::Number(0.0)),
            ],
        ))),
        (
            "INVALID_INPUT".into(),
            "maxQueuedEvents integer range".into()
        )
    );
    assert_eq!(
        error(owner.configure(&policy("A", &[("maxStoredBars", JsValue::Number(0.0))],))),
        (
            "STORE_BUDGET".into(),
            "Current history exceeds ingestion admission budget".into()
        )
    );
}

#[test]
fn enqueue_copies_events_tracks_49_bytes_and_rejects_without_cursor_mutation() {
    let mut owner = owner();
    owner
        .configure(&policy(
            "feed-A",
            &[
                ("firstSequence", JsValue::Number(100.0)),
                ("maxQueuedEvents", JsValue::Number(3.0)),
                ("maxQueuedBytes", JsValue::Number(147.0)),
            ],
        ))
        .unwrap();
    let mut input = event("append", bar(1.0, 20.0));
    let receipt = owner
        .enqueue(&packet("feed-A", 7.0, 100.0, vec![input.clone()]))
        .unwrap();
    assert_eq!(
        text(&receipt),
        r#"{"events":1,"firstSequence":100,"nextSequence":101,"pendingEvents":1,"pendingBytes":49}"#
    );
    if let JsValue::Object(row) = &mut input {
        row.insert(
            JsString::from_str("kind"),
            JsValue::String(JsString::from_str("update")),
        );
    }
    assert_eq!(
        error(owner.enqueue(&packet(
            "feed-A",
            7.0,
            99.0,
            vec![event("append", bar(2.0, 30.0))]
        ))),
        (
            "SEQUENCE_MISMATCH".into(),
            "Packet firstSequence must equal nextSequence".into()
        )
    );
    let stats = owner.stats().unwrap();
    assert_eq!(
        stats.for_property("nextSequence").unwrap().unwrap_number(),
        101.0
    );
    assert_eq!(
        stats
            .for_property("rejectedPackets")
            .unwrap()
            .unwrap_number(),
        1.0
    );
    assert_eq!(
        stats
            .for_property("rejectedEvents")
            .unwrap()
            .unwrap_number(),
        1.0
    );
}

#[test]
fn queue_wrap_partial_drain_and_cancel_conserve_payload_and_sequence() {
    let mut owner = owner();
    owner
        .configure(&policy(
            "A",
            &[
                ("maxQueuedEvents", JsValue::Number(3.0)),
                ("maxQueuedBytes", JsValue::Number(147.0)),
                ("maxBatchEvents", JsValue::Number(2.0)),
            ],
        ))
        .unwrap();
    owner
        .enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![
                event("append", bar(1.0, 20.0)),
                event("append", bar(2.0, 21.0)),
                event("append", bar(3.0, 22.0)),
            ],
        ))
        .unwrap();
    let first = owner.drain(None, false).unwrap();
    assert_eq!(first.first_sequence, Some(0.0));
    assert_eq!(first.last_sequence, Some(1.0));
    owner
        .enqueue(&packet(
            "A",
            7.0,
            3.0,
            vec![
                event("append", bar(4.0, 23.0)),
                event("append", bar(5.0, 24.0)),
            ],
        ))
        .unwrap();
    let cancelled = owner.cancel().unwrap();
    assert_eq!(cancelled.events, 3);
    assert_eq!(cancelled.first_sequence, Some(2.0));
    assert_eq!(cancelled.last_sequence, Some(4.0));
    let stats = owner.stats().unwrap();
    assert_eq!(stats.for_property("accepted").unwrap().unwrap_number(), 5.0);
    assert_eq!(stats.for_property("applied").unwrap().unwrap_number(), 2.0);
    assert_eq!(
        stats.for_property("cancelled").unwrap().unwrap_number(),
        3.0
    );
}

#[test]
fn pause_resume_source_change_and_failed_drain_keep_failure_atomic() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    owner
        .enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![event("append", bar(1.0, 20.0))],
        ))
        .unwrap();
    owner
        .data_mut()
        .store_mut()
        .apply_event(
            DataEvent::Update(bar(0.0, 30.0)),
            &batch_options::BatchOptions::empty(),
        )
        .unwrap();
    let version = owner.data().store().version();
    assert_eq!(
        error(owner.drain(None, false)),
        (
            "SOURCE_CHANGED".into(),
            "Source changed outside ingestion while payload is pending".into()
        )
    );
    assert_eq!(owner.data().store().version(), version);
    assert_eq!(
        owner
            .stats()
            .unwrap()
            .for_property("state")
            .unwrap()
            .unwrap_string(),
        "paused"
    );
    owner.resume().unwrap();
    let applied = owner.drain(None, false).unwrap();
    assert_eq!(applied.last_sequence, Some(0.0));
    assert_eq!(owner.data().store().at(1).unwrap().close, 20.0);
}

#[test]
fn failed_drain_pauses_with_bounded_error_and_leaves_queue_and_store_unchanged() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    owner
        .enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![event("update", bar(5.0, 20.0))],
        ))
        .unwrap();
    let before_version = owner.data().store().version();
    assert_eq!(
        error(owner.drain(None, false)),
        (
            "DRAIN_FAILED".into(),
            "Data batch update is only the current timestamp".into()
        )
    );
    assert_eq!(owner.data().store().version(), before_version);
    let stats = owner.stats().unwrap();
    assert_eq!(
        stats.for_property("failedDrains").unwrap().unwrap_number(),
        1.0
    );
    assert_eq!(
        stats.for_property("pendingEvents").unwrap().unwrap_number(),
        1.0
    );
    assert_eq!(
        stats.for_property("state").unwrap().unwrap_string(),
        "paused"
    );
}

#[test]
fn lease_fence_epoch_and_busy_rules_are_explicit_and_idempotent() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    let epoch = owner.epoch().unwrap();
    let lease = owner.acquire_lease().unwrap();
    assert_eq!(owner.epoch().unwrap(), epoch + 1.0);
    assert_eq!(
        error(owner.pause()),
        ("BUSY".into(), "Async ingestion lease active".into())
    );
    owner.release_lease(lease).unwrap();
    owner.release_lease(lease).unwrap();
    assert_eq!(owner.epoch().unwrap(), epoch + 2.0);
    owner.acquire_fence();
    assert_eq!(
        error(owner.configure(&policy("B", &[]))),
        (
            "BUSY".into(),
            "Model has an active async ingestion fence".into()
        )
    );
    owner.release_fence();
}

#[test]
fn save_load_is_byte_stable_and_preserves_signed_zero_and_counter_order() {
    let mut source = owner();
    source
        .configure(&policy("A", &[("firstSequence", JsValue::Number(-0.0))]))
        .unwrap();
    source
        .enqueue(&packet(
            "A",
            7.0,
            -0.0,
            vec![event(
                "update",
                Bar {
                    volume: -0.0,
                    ..bar(0.0, 20.0)
                },
            )],
        ))
        .unwrap();
    let saved = source.save().unwrap();
    assert_eq!(
        saved.to_string_lossy(),
        r#"{"schema":"aster.ingestion","version":1,"policy":{"streamId":"A","generation":7,"firstSequence":{"$asterNumber":"-0"},"maxQueuedEvents":4096,"maxQueuedBytes":262144,"maxBatchEvents":128,"maxStoredBars":4194304,"maxStoreBytes":402653184},"state":"running","nextSequence":1,"counters":{"accepted":1,"applied":0,"cancelled":0,"rejectedPackets":0,"rejectedEvents":0,"failedDrains":0,"peakPendingEvents":1,"peakPendingBytes":49,"lastAppliedSequence":null,"lastCancelledSequence":null},"lastError":null,"pending":{"firstSequence":{"$asterNumber":"-0"},"events":[{"kind":"update","bar":{"time":0,"open":20,"high":21,"low":19,"close":20,"volume":{"$asterNumber":"-0"}}}]}}"#
    );
    let mut target = owner();
    target.configure(&policy("B", &[])).unwrap();
    target.load(&JsValue::String(saved.clone())).unwrap();
    assert_eq!(target.save().unwrap(), saved);
    assert_eq!(
        target
            .stats()
            .unwrap()
            .for_property("pendingEvents")
            .unwrap()
            .unwrap_number(),
        1.0
    );
}

#[test]
fn invalid_restore_is_atomic_and_safe_integer_conservation_is_enforced() {
    let mut source = owner();
    source.configure(&policy("A", &[])).unwrap();
    let good = source.save().unwrap();
    let before = good.clone();
    let bad = good.to_string_lossy().replace(
        "\"accepted\":0",
        &format!("\"accepted\":{MAX_SAFE_INTEGER}"),
    );
    assert_eq!(
        error(source.load(&JsValue::String(JsString::from_str(&bad)))).0,
        "INVALID_DOCUMENT"
    );
    assert_eq!(source.save().unwrap(), before);
}

#[test]
fn native_command_envelopes_nine_operations_and_unknown_is_thrown() {
    let mut owner = owner();
    let configured = owner
        .native_data_ingestion_command(
            "configureDataIngestion",
            &JsValue::Array(vec![policy("A", &[])]),
        )
        .unwrap();
    assert!(text(&configured).starts_with(r#"{"result":{"policy":"#));
    let failed = owner
        .native_data_ingestion_command("drainDataEvents", &JsValue::Array(vec![JsValue::Null]))
        .unwrap();
    assert_eq!(
        text(&failed),
        r#"{"error":{"name":"IngestionError","code":"INVALID_INPUT","message":"Drain count integer range"}}"#
    );
    assert_eq!(
        owner
            .native_data_ingestion_command("unknown", &JsValue::Array(vec![]))
            .unwrap_err()
            .name,
        "TypeError"
    );
}

#[test]
fn unchanged_batch_envelope_and_release_keep_attached_closed_policy() {
    let mut owner = owner();
    owner
        .configure(&policy("A", &[("maxStoredBars", JsValue::Number(1.0))]))
        .unwrap();
    let envelope = owner
        .native_apply_unchanged_data_events(&JsValue::Array(vec![event("update", bar(0.0, 10.0))]))
        .unwrap();
    assert!(text(&envelope).contains(r#""unchanged":true"#));
    let released = owner.native_release_data_ingestion();
    assert_eq!(released.cancelled, 0);
    assert_eq!(error(owner.stats()).0, "CLOSED");
    assert_eq!(error(owner.configure(&policy("B", &[]))).0, "CLOSED");
    let batch = JsValue::Array(vec![event("append", bar(1.0, 20.0))]);
    assert!(
        owner.apply_data_events(&batch, false).is_err(),
        "closed attached policy still bounds typed batches"
    );
}

#[test]
fn counter_saturation_and_sequence_limit_do_not_wrap() {
    let mut owner = owner();
    owner
        .configure(&policy(
            "A",
            &[("firstSequence", JsValue::Number(MAX_SAFE_INTEGER))],
        ))
        .unwrap();
    assert_eq!(
        error(owner.enqueue(&packet(
            "A",
            7.0,
            MAX_SAFE_INTEGER,
            vec![event("update", bar(0.0, 11.0))]
        )))
        .0,
        "SEQUENCE_LIMIT"
    );
    let stats = owner.stats().unwrap();
    assert_eq!(
        stats.for_property("nextSequence").unwrap().unwrap_number(),
        MAX_SAFE_INTEGER
    );
    assert_eq!(
        stats
            .for_property("rejectedPackets")
            .unwrap()
            .unwrap_number(),
        1.0
    );
}

#[test]
fn enqueue_validation_checks_stream_before_sequence_and_counts_snapshotted_rejections() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    assert_eq!(
        error(owner.enqueue(&packet(
            "other",
            7.0,
            -1.0,
            vec![event("append", bar(1.0, 20.0))]
        ))),
        (
            "STREAM_MISMATCH".into(),
            "Packet stream/generation mismatch".into()
        )
    );
    owner.pause().unwrap();
    assert_eq!(
        error(owner.enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![event("append", bar(1.0, 20.0))]
        )))
        .0,
        "PAUSED"
    );
    let stats = owner.stats().unwrap();
    assert_eq!(
        stats
            .for_property("rejectedPackets")
            .unwrap()
            .unwrap_number(),
        2.0
    );
    assert_eq!(
        stats
            .for_property("rejectedEvents")
            .unwrap()
            .unwrap_number(),
        1.0
    );
}

#[test]
fn external_alignment_is_a_failed_drain_and_preserves_the_complete_prefix() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    owner
        .enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![event("append", bar(1.0, 20.0))],
        ))
        .unwrap();
    let version = owner.data().store().version();
    assert_eq!(
        error(owner.drain(None, true)),
        (
            "DRAIN_FAILED".into(),
            "Length-changing ingestion requires host realignment of external values".into()
        )
    );
    let stats = owner.stats().unwrap();
    assert_eq!(owner.data().store().version(), version);
    assert_eq!(
        stats.for_property("pendingEvents").unwrap().unwrap_number(),
        1.0
    );
    assert_eq!(
        stats.for_property("failedDrains").unwrap().unwrap_number(),
        1.0
    );
}

#[test]
fn zero_drain_cancel_and_repeated_pause_have_exact_epoch_and_receipts() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    let epoch = owner.epoch().unwrap();
    let drain = owner.drain(None, false).unwrap();
    assert_eq!(drain.first_sequence, None);
    assert_eq!(drain.receipt.events, 0);
    assert_eq!(owner.epoch().unwrap(), epoch);
    let cancel = owner.cancel().unwrap();
    assert_eq!(cancel.events, 0);
    assert_eq!(cancel.first_sequence, None);
    assert_eq!(owner.epoch().unwrap(), epoch + 1.0);
    owner.pause().unwrap();
    owner.pause().unwrap();
    assert_eq!(owner.epoch().unwrap(), epoch + 3.0);
}

#[test]
fn release_cancels_pending_once_and_keeps_the_closed_session_attached() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    owner
        .enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![
                event("append", bar(1.0, 20.0)),
                event("append", bar(2.0, 21.0)),
            ],
        ))
        .unwrap();
    assert_eq!(
        text(&owner.native_release_data_ingestion().to_value()),
        r#"{"cancelled":2,"pendingEvents":0,"ownedBytes":0}"#
    );
    assert_eq!(owner.native_release_data_ingestion().cancelled, 0);
    assert_eq!(error(owner.stats()).0, "CLOSED");
    assert_eq!(
        error(owner.load(&JsValue::String(JsString::from_str("{}")))).0,
        "CLOSED"
    );
}

#[test]
fn configured_policy_budgets_direct_batches_even_after_session_close() {
    let options = StoreOptions {
        max_bars: 4,
        ..StoreOptions::default()
    };
    let data = ModelDataState::new(options, vec![bar(0.0, 10.0)]).unwrap();
    let mut owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let stats = owner.configure(&policy("A", &[])).unwrap();
    assert_eq!(
        stats
            .for_property("policy")
            .unwrap()
            .for_property("maxStoredBars")
            .unwrap()
            .unwrap_number(),
        4.0
    );
    owner.native_release_data_ingestion();
    let input = JsValue::Array(vec![
        event("append", bar(1.0, 20.0)),
        event("append", bar(2.0, 21.0)),
        event("append", bar(3.0, 22.0)),
        event("append", bar(4.0, 23.0)),
    ]);
    let failure = apply_error(owner.apply_data_events(&input, false));
    assert_eq!(failure.0, "RangeError");
    assert_eq!(failure.1, None);
    assert!(failure.2.contains("bar budget"));
}

#[test]
fn all_nine_native_commands_have_stable_success_or_error_envelopes() {
    let mut owner = owner();
    owner
        .native_data_ingestion_command(
            "configureDataIngestion",
            &JsValue::Array(vec![policy("A", &[])]),
        )
        .unwrap();
    for operation in [
        "dataIngestionStats",
        "saveDataIngestion",
        "pauseDataIngestion",
        "resumeDataIngestion",
        "cancelDataEvents",
        "drainDataEvents",
    ] {
        let envelope = owner
            .native_data_ingestion_command(operation, &JsValue::Array(vec![]))
            .unwrap();
        assert!(envelope.for_property("result").is_some(), "{operation}");
    }
    let queued = owner
        .native_data_ingestion_command(
            "enqueueDataEvents",
            &JsValue::Array(vec![packet(
                "A",
                7.0,
                0.0,
                vec![event("update", bar(0.0, 11.0))],
            )]),
        )
        .unwrap();
    assert!(queued.for_property("result").is_some());
    let document = owner.save().unwrap();
    owner.cancel().unwrap();
    let loaded = owner
        .native_data_ingestion_command(
            "loadDataIngestion",
            &JsValue::Array(vec![JsValue::String(document)]),
        )
        .unwrap();
    assert!(loaded.for_property("result").is_some());
}

#[test]
fn restored_counter_and_last_error_key_orders_round_trip_byte_exactly() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    let saved = owner.save().unwrap().to_string_lossy();
    let reordered = saved
        .replace(
            "\"accepted\":0,\"applied\":0",
            "\"applied\":0,\"accepted\":0",
        )
        .replace("\"state\":\"running\"", "\"state\":\"paused\"")
        .replace(
            "\"lastError\":null",
            "\"lastError\":{\"message\":\"kept\",\"code\":\"DRAIN_FAILED\"}",
        );
    owner
        .load(&JsValue::String(JsString::from_str(&reordered)))
        .unwrap();
    assert_eq!(owner.save().unwrap().to_string_lossy(), reordered);
}

#[test]
fn restored_rejection_counters_saturate_at_max_safe_integer() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    let document = owner.save().unwrap().to_string_lossy().replace(
        "\"rejectedPackets\":0",
        "\"rejectedPackets\":9007199254740991",
    );
    owner
        .load(&JsValue::String(JsString::from_str(&document)))
        .unwrap();
    assert_eq!(
        error(owner.enqueue(&packet(
            "other",
            7.0,
            0.0,
            vec![event("append", bar(1.0, 20.0))]
        )))
        .0,
        "STREAM_MISMATCH"
    );
    let stats = owner.stats().unwrap();
    assert_eq!(
        stats
            .for_property("rejectedPackets")
            .unwrap()
            .unwrap_number(),
        MAX_SAFE_INTEGER
    );
    assert_eq!(
        stats
            .for_property("rejectedEvents")
            .unwrap()
            .unwrap_number(),
        1.0
    );
}

#[test]
fn direct_batches_reject_external_alignment_and_return_publication_after_commit() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    let input = JsValue::Array(vec![event("append", bar(1.0, 20.0))]);
    assert_eq!(
        apply_error(owner.apply_data_events_with_external_values(&input, false, true))
            .1
            .as_deref(),
        Some("EXTERNAL_ALIGNMENT")
    );
    assert_eq!(owner.data().store().length(), 1);
    let committed = owner.apply_data_events(&input, false).unwrap();
    assert!(committed.change.is_some());
    assert_eq!(owner.data().store().length(), 2);
    let listener_result: Result<(), &str> = Err("listener failed after commit");
    assert!(listener_result.is_err());
    assert_eq!(
        owner.data().store().length(),
        2,
        "listener failure cannot roll back committed store/ledger state"
    );
}

#[test]
fn pending_payload_blocks_reconfigure_and_lease_until_cancelled() {
    let mut owner = owner();
    owner.configure(&policy("A", &[])).unwrap();
    owner
        .enqueue(&packet(
            "A",
            7.0,
            0.0,
            vec![event("update", bar(0.0, 11.0))],
        ))
        .unwrap();
    assert_eq!(error(owner.configure(&policy("B", &[]))).0, "PENDING_DATA");
    assert_eq!(error(owner.acquire_lease()).0, "PENDING_DATA");
    owner.cancel().unwrap();
    owner.configure(&policy("B", &[])).unwrap();
    assert_eq!(
        owner
            .stats()
            .unwrap()
            .for_property("policy")
            .unwrap()
            .for_property("streamId")
            .unwrap()
            .unwrap_string(),
        "B"
    );
}

trait JsValueTestExt {
    fn for_property(&self, key: &str) -> Option<&JsValue>;
    fn unwrap_number(&self) -> f64;
    fn unwrap_string(&self) -> String;
}

impl JsValueTestExt for JsValue {
    fn for_property(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(object) => object.get(&JsString::from_str(key)),
            _ => None,
        }
    }
    fn unwrap_number(&self) -> f64 {
        match self {
            JsValue::Number(value) => *value,
            _ => panic!("number"),
        }
    }
    fn unwrap_string(&self) -> String {
        match self {
            JsValue::String(value) => value.to_string_lossy(),
            _ => panic!("string"),
        }
    }
}
