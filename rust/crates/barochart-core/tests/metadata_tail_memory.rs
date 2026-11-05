use std::sync::Arc;

use barochart_core::batch_options::snapshot_batch_options_with_memory;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::data_explorer::{ExplorerSymbol, data_at};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::model_state::{ModelContext, ModelState};
use barochart_core::{Engine, Host, HostError};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
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

fn memory(limit: u64) -> (Arc<MemoryAccount>, MemoryContext) {
    let account = MemoryAccount::new(limit, OomStyle::RangeErrorCapitalized);
    let context = MemoryContext::accounted(&account);
    (account, context)
}

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn record(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in entries {
        object.insert(JsString::from_str(name), value);
    }
    JsValue::Object(object)
}

fn deep_array(depth: usize) -> JsValue {
    let mut value = JsValue::Number(1.0);
    for _ in 0..depth {
        value = JsValue::Array(vec![value]);
    }
    value
}

#[test]
fn native_size_clone_shares_one_charge_and_replacement_is_failure_atomic() {
    let (account, context) = memory(32);
    let mut engine = Engine::new(Box::new(NoZones));
    engine.set_memory_context(context).unwrap();

    engine
        .set_native_size(&text("12345678"), &JsValue::Number(1.0))
        .unwrap();
    let first = engine.native_size().unwrap().clone();
    let live = account.snapshot().requested_live_bytes;
    assert_eq!(live, 16);
    let shared = first.clone();
    assert_eq!(account.snapshot().requested_live_bytes, live);
    assert!(first.same_identity(&shared));

    let error = engine
        .set_native_size(&text("123456789"), &JsValue::Number(2.0))
        .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Out of memory");
    assert!(engine.native_size().unwrap().same_identity(&first));
    assert_eq!(account.snapshot().requested_live_bytes, live);

    drop(engine);
    assert_eq!(account.snapshot().requested_live_bytes, live);
    drop(shared);
    assert_eq!(account.snapshot().requested_live_bytes, live);
    drop(first);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn native_size_deep_and_wide_raw_values_only_retain_nominal_payload_bytes() {
    let depth = 4_096;
    let input = deep_array(depth);
    let (account, context) = memory(0);
    let mut engine = Engine::new(Box::new(NoZones));
    engine.set_memory_context(context).unwrap();
    engine.set_native_size(&input, &JsValue::Undefined).unwrap();

    let snapshot = account.snapshot();
    let expected = depth as u64 * std::mem::size_of::<JsValue>() as u64;
    assert_eq!(snapshot.requested_live_bytes, expected);
    assert!(snapshot.requested_peak_bytes > snapshot.requested_live_bytes);

    let mut wide = JsObject::new();
    let mut key_bytes = 0usize;
    for index in 0..1_024 {
        let key = JsString::from_str(&format!("wide-{index:04}"));
        key_bytes += key.len_utf16() * std::mem::size_of::<u16>();
        wide.insert(key, JsValue::Number(index as f64));
    }
    engine
        .set_native_size(&JsValue::Object(wide), &JsValue::Undefined)
        .unwrap();
    let wide_bytes = 1_024
        * (std::mem::size_of::<(JsString, JsValue)>() + std::mem::size_of::<(JsString, usize)>())
        + key_bytes;
    assert_eq!(account.snapshot().requested_live_bytes, wide_bytes as u64);

    drop(engine);
    drop(input);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn batch_snapshot_validates_the_whole_shape_before_cloning_and_releases_owned_values() {
    let (account, context) = memory(64);
    let invalid = record([
        ("maxBars", deep_array(256)),
        ("unsupported", JsValue::Number(1.0)),
    ]);
    let error = snapshot_batch_options_with_memory(&invalid, true, &context).unwrap_err();
    assert_eq!(
        error.message.to_string_lossy(),
        "Data batch options unsupported field or accessor data property"
    );
    assert_eq!(account.snapshot().requested_peak_bytes, 0);

    let options = snapshot_batch_options_with_memory(
        &record([("maxBars", text("late-error"))]),
        true,
        &context,
    )
    .unwrap();
    assert!(account.snapshot().requested_live_bytes > 0);
    assert!(matches!(options.max_bars, Some(JsValue::String(_))));
    drop(options);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn data_query_result_keeps_scoped_metadata_charged_until_the_dto_drops() {
    let host = NoZones;
    let (account, context) = memory(1 << 20);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        vec![Bar {
            time: 1_700_000_000_000.0,
            open: 10.0,
            high: 12.0,
            low: 9.0,
            close: 11.0,
            volume: 1.0,
        }],
        context.clone(),
    )
    .unwrap();
    let mut indicators =
        IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), context).unwrap();
    let mut model = ModelState::new(data.store(), &record([])).unwrap();
    model
        .add_series(
            &record([
                ("id", text("retained-series-id")),
                ("label", text("retained-series-label")),
                ("type", text("line")),
                ("panel", text("price")),
                ("source", text("close")),
            ]),
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let baseline = account.snapshot().requested_live_bytes;
    let result = data_at(
        &model,
        &mut indicators,
        data.store(),
        &host,
        &record([("index", JsValue::Number(0.0))]),
        &record([]),
        Some(&ExplorerSymbol {
            id: JsString::from_str("PRIMARY"),
            currency: JsString::from_str("USD"),
            volume_unit: JsString::from_str("shares"),
        }),
    )
    .unwrap()
    .unwrap();
    assert!(account.snapshot().requested_live_bytes > baseline);
    assert_eq!(result.series.len(), 1);
    drop(result);
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    let filler = account.reserve((1 << 20) - baseline - 1).unwrap();
    let error = data_at(
        &model,
        &mut indicators,
        data.store(),
        &host,
        &record([("index", JsValue::Number(0.0))]),
        &record([]),
        None,
    )
    .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Out of memory");
    assert_eq!(account.snapshot().requested_live_bytes, (1 << 20) - 1);
    drop(filler);
    assert_eq!(account.snapshot().requested_live_bytes, baseline);
}
