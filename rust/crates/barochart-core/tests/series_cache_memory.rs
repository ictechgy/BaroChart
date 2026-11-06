use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::series_cache::SeriesCaches;
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::string::JsString;

#[test]
fn cache_rebuild_and_remove_charge_only_owned_tree_and_failure_is_atomic() {
    let store = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let values = vec![1.0; store.store().capacity()];
    let id = JsString::from_str("price");

    let limited = MemoryAccount::new(767, OomStyle::InternalErrorLowercase);
    let mut denied = SeriesCaches::new_with_memory(MemoryContext::accounted(&limited));
    let mut revision = None;
    let mut dirty = f64::INFINITY;
    let mut ready = false;
    let error = denied
        .query_series(
            &id,
            false,
            &mut revision,
            &mut dirty,
            &mut ready,
            store.store(),
            &store.store().data_identity(),
            &values,
            0.0,
            0.0,
            values.len(),
            0,
            values.len(),
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(denied.accounted_bytes(), 0);
    assert_eq!(limited.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let mut caches = SeriesCaches::new_with_memory(MemoryContext::accounted(&account));
    let mut revision = None;
    let mut dirty = f64::INFINITY;
    let mut ready = false;
    caches
        .query_series(
            &id,
            false,
            &mut revision,
            &mut dirty,
            &mut ready,
            store.store(),
            &store.store().data_identity(),
            &values,
            0.0,
            0.0,
            values.len(),
            0,
            values.len(),
        )
        .unwrap();
    assert_eq!(caches.accounted_bytes(), 768);
    assert_eq!(account.snapshot().requested_live_bytes, 768);
    assert!(caches.remove(&id));
    assert_eq!(caches.accounted_bytes(), 0);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn negative_dirty_offsets_rebuild_stale_extrema_like_javascript() {
    for next_dirty in [-1.0, -0.5, f64::NEG_INFINITY] {
        let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
        let store = data.store();
        let identity = store.data_identity();
        let mut values = vec![1.0; store.capacity()];
        values[7] = 100.0;
        let id = JsString::from_str("external");
        let mut caches = SeriesCaches::new();
        let mut revision = None;
        let mut dirty = f64::INFINITY;
        let mut ready = false;
        caches
            .query_series(
                &id,
                false,
                &mut revision,
                &mut dirty,
                &mut ready,
                store,
                &identity,
                &values,
                0.0,
                0.0,
                values.len(),
                0,
                values.len(),
            )
            .unwrap();
        values[7] = 2.0;
        dirty = next_dirty;
        let range = caches
            .query_series(
                &id,
                false,
                &mut revision,
                &mut dirty,
                &mut ready,
                store,
                &identity,
                &values,
                1.0,
                0.0,
                values.len(),
                0,
                values.len(),
            )
            .unwrap();
        assert_eq!(range.max, 2.0, "negative dirty offset {next_dirty}");
        assert_eq!(dirty, f64::INFINITY);
        assert_eq!(revision, Some(1.0));
    }
}

#[test]
fn negative_dirty_offset_in_small_incremental_window_errors_without_marking_cache_clean() {
    let bars = (0..1024)
        .map(|index| Bar {
            time: index as f64 + 1.0,
            open: 1.0,
            high: 1.0,
            low: 1.0,
            close: 1.0,
            volume: 0.0,
        })
        .collect();
    let data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
    let store = data.store();
    let identity = store.data_identity();
    let mut values = vec![1.0; store.capacity()];
    let id = JsString::from_str("external");
    let mut caches = SeriesCaches::new();
    let mut revision = None;
    let mut dirty = f64::INFINITY;
    let mut ready = false;
    caches
        .query_series(
            &id,
            false,
            &mut revision,
            &mut dirty,
            &mut ready,
            store,
            &identity,
            &values,
            0.0,
            0.0,
            values.len(),
            0,
            4,
        )
        .unwrap();

    values[0] = 9.0;
    dirty = -1.0;
    let error = caches
        .query_series(
            &id,
            false,
            &mut revision,
            &mut dirty,
            &mut ready,
            store,
            &identity,
            &values,
            1.0,
            -1.0,
            4,
            0,
            4,
        )
        .unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_eq!(error.message.to_string_lossy(), "Index update bounds");
    assert_eq!(dirty, -1.0);
    assert_eq!(revision, Some(0.0));
    assert!(ready);
    assert_eq!(caches.query(&id, &values, 0, 4).unwrap().max, 1.0);

    dirty = 0.0;
    let range = caches
        .query_series(
            &id,
            false,
            &mut revision,
            &mut dirty,
            &mut ready,
            store,
            &identity,
            &values,
            1.0,
            0.0,
            4,
            0,
            4,
        )
        .unwrap();
    assert_eq!(range.max, 9.0);
    assert_eq!(dirty, f64::INFINITY);
    assert_eq!(revision, Some(1.0));
}
