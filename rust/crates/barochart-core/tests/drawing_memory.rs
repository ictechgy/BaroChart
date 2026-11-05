use std::sync::Arc;

use barochart_core::drawings::{DrawingStore, DrawingStoreConfig};
use barochart_js::json::{JsValue, JsonMode, parse_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle, oom_style_from_error};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

fn drawing(id: &str, points: usize) -> JsValue {
    let kind = if points == 1 {
        "horizontal"
    } else {
        "freehand"
    };
    let anchors = (0..points)
        .map(|index| format!(r#"{{"time":{index},"price":{index}}}"#))
        .collect::<Vec<_>>()
        .join(",");
    parse_json(
        format!(
            r#"{{"id":"{id}","type":"{kind}","panel":"price","points":[{anchors}],"text":"persistent metadata"}}"#
        )
        .as_bytes(),
        JsonMode::Standard,
    )
    .unwrap()
}

fn accounted_store(limit: u64, config: DrawingStoreConfig) -> (Arc<MemoryAccount>, DrawingStore) {
    let account = MemoryAccount::new(limit, OomStyle::InternalErrorLowercase);
    let store = DrawingStore::new_with_memory(
        config,
        NumberDialect::Ecma,
        MemoryContext::accounted(&account),
    )
    .unwrap();
    (account, store)
}

#[test]
fn add_quota_failure_keeps_the_old_store_and_live_bytes() {
    let input = drawing("wide", 256);
    let (probe_account, mut probe) = accounted_store(0, DrawingStoreConfig::default());
    probe.add(&input).unwrap();
    let required_limit = probe_account.snapshot().requested_peak_bytes;
    assert!(required_limit > 1);
    drop(probe);
    assert_eq!(probe_account.snapshot().requested_live_bytes, 0);

    let (account, mut store) = accounted_store(required_limit - 1, DrawingStoreConfig::default());
    let before = account.snapshot().requested_live_bytes;
    let error = store.add(&input).unwrap_err();
    assert_eq!(
        oom_style_from_error(&error),
        Some(OomStyle::InternalErrorLowercase)
    );
    assert!(store.items().is_empty());
    assert!(store.undo_stack().is_empty());
    assert!(store.redo_stack().is_empty());
    assert!(store.transaction().is_none());
    assert_eq!(account.snapshot().requested_live_bytes, before);
}

#[test]
fn snapshots_and_transaction_baselines_share_one_frame_charge() {
    let (account, mut store) = accounted_store(0, DrawingStoreConfig::default());
    store.add(&drawing("a", 32)).unwrap();
    let before = account.snapshot().requested_live_bytes;

    let first = store.snapshot();
    let second = store.snapshot();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(account.snapshot().requested_live_bytes, before);

    store.begin().unwrap();
    assert!(Arc::ptr_eq(store.transaction().unwrap(), &first));
    assert_eq!(account.snapshot().requested_live_bytes, before);
    store.cancel();
    assert_eq!(account.snapshot().requested_live_bytes, before);
}

#[test]
fn transaction_cancel_releases_the_candidate_points_and_metadata() {
    let (account, mut store) = accounted_store(0, DrawingStoreConfig::default());
    store.add(&drawing("a", 128)).unwrap();
    let before = account.snapshot().requested_live_bytes;
    let original = store.items()[0].clone();

    store.begin().unwrap();
    let patch = parse_json(
        br#"{"points":[{"time":10,"price":10},{"time":11,"price":11}]}"#,
        JsonMode::Standard,
    )
    .unwrap();
    store.edit(&JsString::from_str("a"), &patch).unwrap();
    assert!(account.snapshot().requested_live_bytes > before);
    assert!(!Arc::ptr_eq(&original, &store.items()[0]));

    store.cancel();
    assert!(Arc::ptr_eq(&original, &store.items()[0]));
    assert_eq!(account.snapshot().requested_live_bytes, before);
}

#[test]
fn history_eviction_releases_unique_drawings_and_store_drop_reaches_zero() {
    let config = DrawingStoreConfig {
        history_limit: 1,
        ..DrawingStoreConfig::default()
    };
    let (account, mut store) = accounted_store(0, config);
    store.add(&drawing("a", 64)).unwrap();
    let first = Arc::downgrade(&store.items()[0]);
    store.add(&drawing("b", 64)).unwrap();
    store.remove(&JsString::from_str("a")).unwrap();
    store
        .edit(
            &JsString::from_str("b"),
            &parse_json(br#"{"visible":false}"#, JsonMode::Standard).unwrap(),
        )
        .unwrap();
    assert!(first.upgrade().is_none());
    assert!(account.snapshot().requested_live_bytes > 0);

    drop(store);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn undo_redo_reuses_drawing_and_frame_owners_without_growth_after_warmup() {
    let (account, mut store) = accounted_store(0, DrawingStoreConfig::default());
    store.add(&drawing("a", 128)).unwrap();
    store.add(&drawing("b", 128)).unwrap();
    let latest = store.snapshot();

    assert!(store.undo().unwrap());
    assert!(store.redo().unwrap());
    assert!(Arc::ptr_eq(&latest, &store.snapshot()));
    let warmed = account.snapshot().requested_live_bytes;

    for _ in 0..8 {
        assert!(store.undo().unwrap());
        assert!(store.redo().unwrap());
    }
    assert_eq!(account.snapshot().requested_live_bytes, warmed);
}

#[test]
fn scoped_drawing_output_is_temporary_and_input_proportional() {
    let (account, mut store) = accounted_store(0, DrawingStoreConfig::default());
    store.add(&drawing("a", 256)).unwrap();
    let retained = account.snapshot().requested_live_bytes;

    {
        let mut scope = store.memory_context().scope();
        let value = store.items()[0].to_value_scoped(&mut scope).unwrap();
        let JsValue::Object(record) = &value else {
            panic!("drawing output must be an object");
        };
        assert!(matches!(
            record.get(&JsString::from_str("points")),
            Some(JsValue::Array(points)) if points.len() == 256
        ));
        assert!(scope.requested_bytes() > 256 * std::mem::size_of::<JsValue>() as u64);
        assert!(account.snapshot().requested_live_bytes > retained);
    }

    assert_eq!(account.snapshot().requested_live_bytes, retained);
}
