use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::ingestion::IngestionOwner;
use barochart_core::model_state::ModelState;
use barochart_core::native_data_jobs::{
    NativeCorrectionSource, NativeCorrectionTarget, NativePrepareSource, NativePrepareTarget,
};
use barochart_core::series_cache::SeriesCaches;
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
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

fn fixture() -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    let length = 8;
    let mut data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let columns = seeded_columns(length, 42).unwrap();
    data.store_mut()
        .set_columns(
            &ColumnInputs {
                time: NumericColumn::F64(&columns.time),
                open: NumericColumn::F64(&columns.open),
                high: NumericColumn::F64(&columns.high),
                low: NumericColumn::F64(&columns.low),
                close: NumericColumn::F64(&columns.close),
                volume: NumericColumn::F64(&columns.volume),
            },
            Some(length),
        )
        .unwrap();
    let owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let model = ModelState::new(
        owner.data().store(),
        &object(&[
            (
                "panels",
                JsValue::Array(vec![object(&[
                    ("id", text("price")),
                    ("weight", JsValue::Number(1.0)),
                ])]),
            ),
            ("visibleBars", JsValue::Number(5.0)),
        ]),
    )
    .unwrap();
    let engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    (owner, model, engine, SeriesCaches::new())
}

fn correction_event(owner: &IngestionOwner) -> JsValue {
    let bar = owner.data().store().at(2).unwrap();
    object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(bar.time)),
                ("open", JsValue::Number(bar.open)),
                (
                    "high",
                    JsValue::Number(barochart_js::num::js_max(&[bar.high, bar.close + 1.0])),
                ),
                ("low", JsValue::Number(bar.low)),
                ("close", JsValue::Number(bar.close + 1.0)),
                ("volume", JsValue::Number(bar.volume)),
            ]),
        ),
    ])
}

#[test]
fn prepare_columns_reserve_before_allocation_and_drop_to_zero() {
    let (owner, model, engine, caches) = fixture();
    let request = object(&[("kind", text("seeded")), ("count", JsValue::Number(16.0))]);
    let source = NativePrepareSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &request,
        NumberDialect::Ecma,
    )
    .unwrap();
    let account = MemoryAccount::new(768, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let target = NativePrepareTarget::new_with_memory(
        source.metadata_json(),
        NumberDialect::Ecma,
        &NoZones,
        context,
    )
    .unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, 6 * 16 * 8);
    drop(target);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn prepare_candidate_denial_preserves_old_job_and_peak() {
    let (owner, model, engine, caches) = fixture();
    let request = object(&[("kind", text("seeded")), ("count", JsValue::Number(16.0))]);
    let source = NativePrepareSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &request,
        NumberDialect::Ecma,
    )
    .unwrap();
    let account = MemoryAccount::new(768, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let old = NativePrepareTarget::new_with_memory(
        source.metadata_json(),
        NumberDialect::Ecma,
        &NoZones,
        context.clone(),
    )
    .unwrap();
    let error = match NativePrepareTarget::new_with_memory(
        source.metadata_json(),
        NumberDialect::Ecma,
        &NoZones,
        context,
    ) {
        Ok(_) => panic!("candidate should exceed the account limit"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(account.snapshot().requested_live_bytes, 768);
    assert_eq!(account.snapshot().requested_peak_bytes, 768);
    drop(old);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn correction_transfer_moves_buffer_groups_without_a_second_charge() {
    let (owner, model, engine, caches) = fixture();
    let event = correction_event(&owner);
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &event,
        NumberDialect::Ecma,
    )
    .unwrap();
    // Six columns (6 * 16 * 8) plus the OHLCV tree (3 * 32 * 8).
    let payload_bytes = 6 * 16 * 8 + 3 * 32 * 8;
    let account = MemoryAccount::new(
        (payload_bytes + 8_192) as u64,
        OomStyle::InternalErrorLowercase,
    );
    let mut target = NativeCorrectionTarget::new_with_memory(
        source.metadata_json(),
        NumberDialect::Ecma,
        &NoZones,
        MemoryContext::accounted(&account),
    )
    .unwrap();
    for descriptor in source.buffer_descriptors() {
        let source_values = source
            .buffer(
                &owner,
                &model,
                &engine,
                &caches,
                descriptor.slot as f64,
                0.0,
                descriptor.length as f64,
            )
            .unwrap();
        target
            .target(descriptor.slot as f64, 0.0, descriptor.length as f64)
            .unwrap()
            .copy_from_slice(source_values);
    }
    assert_eq!(
        account.snapshot().requested_live_bytes,
        payload_bytes as u64
    );
    target.start(1.0).unwrap();
    target.step(1.0, &NoZones).unwrap();
    let core = target.take_prepared().unwrap();
    let owners = core.owner.data().store().accounted_bytes()
        + core.model.accounted_bytes()
        + core.indicators.accounted_bytes()
        + core.caches.accounted_bytes();
    assert_eq!(
        core.owner.data().store().accounted_bytes(),
        payload_bytes as u64
    );
    assert_eq!(account.snapshot().requested_live_bytes, owners);
    drop(core);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn invalid_metadata_wins_over_memory_denial_and_cancel_drops_buffers() {
    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let invalid = JsString::from_str("{}");
    let error = match NativePrepareTarget::new_with_memory(
        &invalid,
        NumberDialect::Ecma,
        &NoZones,
        MemoryContext::accounted(&account),
    ) {
        Ok(_) => panic!("invalid metadata should fail"),
        Err(error) => error,
    };
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message.to_string_lossy(), "Prepare protocol");
    assert_eq!(account.snapshot().requested_live_bytes, 0);

    let (owner, model, engine, caches) = fixture();
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &correction_event(&owner),
        NumberDialect::Ecma,
    )
    .unwrap();
    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let error = match NativeCorrectionTarget::new_with_memory(
        source.metadata_json(),
        NumberDialect::Ecma,
        &NoZones,
        MemoryContext::accounted(&account),
    ) {
        Ok(_) => panic!("correction buffers should exceed the account limit"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn correction_checkpoint_text_uses_caller_scope_and_denial_is_retryable() {
    let (owner, model, mut engine, caches) = fixture();
    engine
        .add(
            owner.data().store(),
            &NoZones,
            &text("ema"),
            &text("ema"),
            &object(&[("period", JsValue::Number(3.0))]),
        )
        .unwrap();
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &correction_event(&owner),
        NumberDialect::Ecma,
    )
    .unwrap();
    let descriptor = source
        .checkpoint_descriptors()
        .into_iter()
        .next()
        .expect("ema has a checkpoint descriptor");

    let denied = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut denied_scope = MemoryContext::accounted(&denied).scope();
    let error = source
        .checkpoint_scoped(
            &owner,
            &model,
            &engine,
            &caches,
            descriptor.entry as f64,
            0.0,
            1.0,
            &mut denied_scope,
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(denied_scope);
    assert_eq!(denied.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let mut scope = memory.scope();
    let text = source
        .checkpoint_scoped(
            &owner,
            &model,
            &engine,
            &caches,
            descriptor.entry as f64,
            0.0,
            1.0,
            &mut scope,
        )
        .unwrap();
    assert!(!text.as_units().is_empty());
    assert_eq!(
        account.snapshot().requested_live_bytes,
        scope.requested_bytes()
    );
    drop((text, scope));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
