use barochart_core::data::{ModelDataState, StoreOptions};
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
