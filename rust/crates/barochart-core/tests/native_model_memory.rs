use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::model_state::{ModelContext, ModelState};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::string::JsString;

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(JsString::from_str(name), item.clone());
    }
    JsValue::Object(value)
}

fn series_options(id: &str) -> JsValue {
    object(&[
        ("id", text(id)),
        ("type", text("line")),
        ("panel", text("price")),
        ("source", JsValue::Undefined),
    ])
}

fn data_with_memory(account: &std::sync::Arc<MemoryAccount>, length: usize) -> ModelDataState {
    let bars = (0..length)
        .map(|index| Bar {
            time: index as f64 + 1.0,
            open: 10.0,
            high: 12.0,
            low: 8.0,
            close: 11.0,
            volume: 1.0,
        })
        .collect();
    ModelDataState::new_with_memory(
        StoreOptions::default(),
        bars,
        MemoryContext::accounted(account),
    )
    .unwrap()
}

#[test]
fn model_derives_store_context_and_accounts_actual_external_capacity() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let data = data_with_memory(&account, 2);
    let store_bytes = account.snapshot().requested_live_bytes;
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    assert!(
        model
            .memory_context()
            .shares_account(data.store().memory_context())
    );
    assert!(
        model.accounted_bytes() > 0,
        "model topology must be accounted"
    );
    assert_eq!(
        account.snapshot().requested_live_bytes,
        store_bytes + model.accounted_bytes()
    );

    let mut values = Vec::with_capacity(17);
    values.extend([1.0, 2.0]);
    let payload_bytes = values.capacity() * size_of::<f64>();
    model
        .add_series_with_values(
            &series_options("external"),
            values,
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    assert_eq!(
        model.series[0].values_accounted_bytes(),
        payload_bytes as u64
    );
    assert_eq!(
        model.external_values_accounted_bytes(),
        payload_bytes as u64
    );
    assert!(
        model.series[0]
            .source_value()
            .is_some_and(|value| { matches!(value, JsValue::Undefined) })
    );
    let raw = model.series[0].raw_record();
    let JsValue::Object(raw) = &raw else {
        panic!("series record")
    };
    assert!(
        !matches!(
            raw.get(&JsString::from_str("values")),
            Some(JsValue::Array(_))
        ),
        "the persistent metadata record must not duplicate f64 values as JsValue"
    );
    {
        let mut scope = model.memory_context().scope();
        let panel = model.panels[0].to_js_value_scoped(&mut scope).unwrap();
        let series = model.series[0].to_js_value_scoped(&mut scope).unwrap();
        assert_eq!(
            format!("{panel:?}"),
            format!("{:?}", model.panels[0].to_js_value())
        );
        assert_eq!(
            format!("{series:?}"),
            format!("{:?}", model.series[0].to_js_value())
        );
    }

    drop(model);
    assert_eq!(account.snapshot().requested_live_bytes, store_bytes);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn external_value_quota_failure_is_atomic_and_keeps_old_pointer_and_revisions() {
    const LIMIT: u64 = 1_000_000;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let data = data_with_memory(&account, 2);
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    model
        .add_series_with_values(
            &series_options("external"),
            vec![1.0, 2.0],
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let old_pointer = model.series[0].values.as_ref().unwrap().as_ptr();
    let old_record = format!("{:?}", model.series[0].raw_record());
    let old_model_revision = model.series_values_revision();
    let old_series_revision = model.series[0].values_revision;
    let live = account.snapshot().requested_live_bytes;
    let blocker = account.reserve(LIMIT - live - 8).unwrap();

    let mut candidate = Vec::with_capacity(64);
    candidate.extend([3.0, 4.0]);
    let error = model
        .set_series_values(&text("external"), candidate, data.store())
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(
        model.series[0].values.as_ref().unwrap().as_ptr(),
        old_pointer
    );
    assert_eq!(format!("{:?}", model.series[0].raw_record()), old_record);
    assert_eq!(model.series_values_revision(), old_model_revision);
    assert_eq!(model.series[0].values_revision, old_series_revision);

    drop(blocker);
    drop(model);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn already_accounted_values_transfer_without_a_second_payload_charge() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let data = data_with_memory(&account, 2);
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    let mut values = Vec::with_capacity(31);
    values.extend([5.0, 6.0]);
    let payload_bytes = values.capacity() * size_of::<f64>();
    let values_memory = data
        .store()
        .memory_context()
        .reserve_group(payload_bytes)
        .unwrap();
    let before = account.snapshot().requested_live_bytes;
    let before_model = model.accounted_bytes();

    model
        .add_series_with_owned_values(
            &series_options("adopted"),
            values,
            values_memory,
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    assert_eq!(
        model.series[0].values_accounted_bytes(),
        payload_bytes as u64
    );
    assert_eq!(
        model.external_values_accounted_bytes(),
        payload_bytes as u64
    );
    assert_eq!(
        account.snapshot().requested_live_bytes - before,
        model.accounted_bytes() - before_model - payload_bytes as u64,
        "adoption may add series metadata, but must not reserve the payload twice"
    );

    model.remove_series(&text("adopted"));
    assert_eq!(model.external_values_accounted_bytes(), 0);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        model.accounted_bytes() + data.store().accounted_bytes()
    );
    drop(model);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn owned_value_replacement_uses_transferred_group_after_scalar_validation() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let data = data_with_memory(&account, 2);
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    model
        .add_series_with_values(
            &series_options("external"),
            vec![1.0, 2.0],
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let old_bytes = model.series[0].values_accounted_bytes();
    let mut replacement = Vec::with_capacity(41);
    replacement.extend([3.0, 4.0]);
    let replacement_pointer = replacement.as_ptr();
    let replacement_bytes = replacement.capacity() * size_of::<f64>();
    let replacement_memory = model
        .memory_context()
        .reserve_group(replacement_bytes)
        .unwrap();
    let peak_input_live = account.snapshot().requested_live_bytes;
    model
        .set_series_values_with_owned_values(
            &text("external"),
            replacement,
            replacement_memory,
            data.store(),
        )
        .unwrap();
    assert_eq!(
        model.series[0].values.as_ref().unwrap().as_ptr(),
        replacement_pointer
    );
    assert_eq!(
        model.series[0].values_accounted_bytes(),
        replacement_bytes as u64
    );
    assert_eq!(
        account.snapshot().requested_live_bytes,
        peak_input_live - old_bytes,
        "the transferred candidate was already charged before publication"
    );

    let foreign = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let mut invalid = Vec::with_capacity(17);
    invalid.push(9.0);
    let invalid_memory = MemoryContext::accounted(&foreign)
        .reserve_group(invalid.capacity() * size_of::<f64>())
        .unwrap();
    let error = model
        .set_series_values_with_owned_values(
            &text("external"),
            invalid,
            invalid_memory,
            data.store(),
        )
        .unwrap_err();
    assert_eq!(
        error.message.to_string_lossy(),
        "Aligned values and existing series required",
        "alignment validation must precede memory-group validation"
    );
    assert_eq!(foreign.snapshot().requested_live_bytes, 0);

    drop(model);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn metadata_only_replacement_moves_values_and_lease_without_copying_f64() {
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let data = data_with_memory(&account, 0);
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    let values = Vec::with_capacity(65_536);
    model
        .add_series_with_values(
            &series_options("external"),
            values,
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let pointer = model.series[0].values.as_ref().unwrap().as_ptr();
    let payload_bytes = model.series[0].values_accounted_bytes();
    let mut replacement = model
        .normalized_series_for_replacement(
            &object(&[
                ("id", text("external")),
                ("type", text("line")),
                ("panel", text("price")),
                ("source", JsValue::Undefined),
                ("visible", JsValue::Bool(false)),
            ]),
            None,
            true,
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    replacement.transfer_values_from(&mut model.series[0]);
    assert_eq!(replacement.values.as_ref().unwrap().as_ptr(), pointer);
    assert_eq!(replacement.values_accounted_bytes(), payload_bytes);
    model.publish_series_replacement(0, replacement);
    assert_eq!(model.series[0].values.as_ref().unwrap().as_ptr(), pointer);
    assert_eq!(model.external_values_accounted_bytes(), payload_bytes);
    assert!(!model.series[0].visible);

    drop(model);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn legacy_theme_candidate_is_fallible_atomic_and_reconciles_topology_lease() {
    const LIMIT: u64 = 1_000_000;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let data = data_with_memory(&account, 0);
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    let before_theme = format!("{:?}", model.theme());
    let before_model = model.accounted_bytes();
    let live = account.snapshot().requested_live_bytes;
    let blocker = account.reserve(LIMIT - live - 8).unwrap();
    let patch = object(&[(
        "custom",
        JsValue::String(JsString::from_str(&"x".repeat(256))),
    )]);
    let error = model.set_theme_legacy(&patch).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(format!("{:?}", model.theme()), before_theme);
    assert_eq!(model.accounted_bytes(), before_model);

    drop(blocker);
    model.set_theme_legacy(&patch).unwrap();
    let JsValue::Object(theme) = model.theme() else {
        panic!("theme record")
    };
    assert!(theme.get(&JsString::from_str("custom")).is_some());
    assert_eq!(
        account.snapshot().requested_live_bytes,
        data.store().accounted_bytes() + model.accounted_bytes()
    );
    drop(model);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
