use barochart_core::chart_api::ChartApi;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::data_input::{
    DataInputError, DataInputMode, apply_data_events_input, set_columns_input, set_data_input,
};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::model_state::ModelState;
use barochart_core::native_chart::NativeChart;
use barochart_core::study_setup::{load_study_setup_scoped, save_study_setup_scoped};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryAccount, MemoryContext, MemoryScope, OomStyle};
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

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut output = JsObject::new();
    for (name, value) in entries {
        output.insert(key(name), value);
    }
    JsValue::Object(output)
}

fn bars(length: usize) -> JsValue {
    JsValue::Array(
        (0..length)
            .map(|index| {
                let value = index as f64 + 1.0;
                object([
                    (
                        "time",
                        JsValue::Number(1_700_000_000_000.0 + index as f64 * 60_000.0),
                    ),
                    ("open", JsValue::Number(value)),
                    ("high", JsValue::Number(value + 1.0)),
                    ("low", JsValue::Number(value - 1.0)),
                    ("close", JsValue::Number(value)),
                    ("volume", JsValue::Number(value)),
                ])
            })
            .collect(),
    )
}

fn columns(length: usize) -> JsValue {
    let values = |offset: f64| {
        JsValue::Array(
            (0..length)
                .map(|index| JsValue::Number(index as f64 + offset))
                .collect(),
        )
    };
    object([
        ("time", values(1_700_000_000_000.0)),
        ("open", values(1.0)),
        ("high", values(2.0)),
        ("low", values(0.0)),
        ("close", values(1.0)),
        ("volume", values(1.0)),
    ])
}

fn typed_bars(length: usize) -> Vec<Bar> {
    (0..length)
        .map(|index| {
            let value = index as f64 + 1.0;
            Bar {
                time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
                open: value,
                high: value + 1.0,
                low: value - 1.0,
                close: value,
                volume: value,
            }
        })
        .collect()
}

fn assert_oom(error: DataInputError) {
    let DataInputError::Js(error) = error else {
        panic!("expected scoped allocation failure")
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
}

#[test]
fn raw_bar_and_column_snapshots_are_admitted_before_store_staging() {
    for input in [bars(16), columns(16)] {
        let account = MemoryAccount::new(3_072, OomStyle::InternalErrorLowercase);
        let mut state = ModelDataState::new_with_memory(
            StoreOptions::default(),
            Vec::new(),
            MemoryContext::accounted(&account),
        )
        .unwrap();
        let identity = state.store().data_identity();
        let error = if matches!(&input, JsValue::Array(_)) {
            set_data_input(state.store_mut(), &input, DataInputMode::ApiFacade).unwrap_err()
        } else {
            set_columns_input(state.store_mut(), &input, None, DataInputMode::ApiFacade)
                .unwrap_err()
        };
        assert_oom(error);
        assert!(identity.matches(&state.store().data_identity()));
        assert_eq!(state.store().length(), 0);
        assert_eq!(account.snapshot().requested_live_bytes, 1_536);
    }

    let account = MemoryAccount::new(3_130, OomStyle::InternalErrorLowercase);
    let mut state = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let mut rows = bars(1);
    let JsValue::Array(rows) = &mut rows else {
        unreachable!("bar fixture")
    };
    let bar = std::mem::take(&mut rows[0]);
    let events = JsValue::Array(vec![object([
        ("kind", JsValue::String(key("append"))),
        ("bar", bar),
    ])]);
    let identity = state.store().data_identity();
    let error = apply_data_events_input(state.store_mut(), &events, None, DataInputMode::ApiFacade)
        .unwrap_err();
    assert_oom(error);
    assert!(identity.matches(&state.store().data_identity()));
    assert_eq!(state.store().length(), 0);
    assert_eq!(account.snapshot().requested_live_bytes, 1_536);
}

#[test]
fn chart_dispatch_large_output_uses_the_callers_scope() {
    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let mut chart = NativeChart::new(
        data,
        &JsValue::Object(JsObject::new()),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = ChartApi::new(&mut chart, &NoZones)
        .dispatch_scoped(&key("inspect"), &[], &mut scope)
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(scope);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn indicator_values_and_saved_drawings_are_owned_by_the_call_scope() {
    let data = ModelDataState::new(StoreOptions::default(), typed_bars(16)).unwrap();
    let mut chart = NativeChart::new(
        data,
        &JsValue::Object(JsObject::new()),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    ChartApi::new(&mut chart, &NoZones)
        .dispatch(
            &key("addIndicator"),
            &[JsValue::String(key("i")), JsValue::String(key("sma"))],
        )
        .unwrap();
    let limited = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut output_scope = MemoryScope::new(&limited);
    let error = ChartApi::new(&mut chart, &NoZones)
        .dispatch_scoped(
            &key("indicatorValues"),
            &[JsValue::String(key("i"))],
            &mut output_scope,
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    let data_at_account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut data_at_scope = MemoryScope::new(&data_at_account);
    let error = ChartApi::new(&mut chart, &NoZones)
        .dispatch_scoped(
            &key("dataAt"),
            &[
                object([("index", JsValue::Number(0.0))]),
                JsValue::Object(JsObject::new()),
            ],
            &mut data_at_scope,
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));

    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let mut chart = NativeChart::new(
        data,
        &JsValue::Object(JsObject::new()),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let baseline = account.snapshot().requested_live_bytes;
    {
        let mut scope = MemoryScope::new(&account);
        let value = ChartApi::new(&mut chart, &NoZones)
            .dispatch_scoped(&key("saveDrawings"), &[], &mut scope)
            .unwrap();
        assert!(matches!(value, JsValue::String(_)));
        assert!(scope.requested_bytes() > 0);
        assert!(account.snapshot().requested_live_bytes > baseline);
    }
    assert_eq!(account.snapshot().requested_live_bytes, baseline);
}

#[test]
fn study_checkpoint_scopes_fail_atomically_and_release_temporary_memory() {
    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut model = ModelState::new(data.store(), &JsValue::Object(JsObject::new())).unwrap();
    let document = save_study_setup_scoped(
        &engine,
        &model,
        &mut MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized),
    )
    .unwrap();

    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&account);
        let error = save_study_setup_scoped(&engine, &model, &mut scope).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);

    {
        let mut scope = MemoryScope::new(&account);
        let error = load_study_setup_scoped(
            &mut engine,
            &mut model,
            data.store(),
            &NoZones,
            &JsValue::String(document),
            None,
            &mut scope,
        )
        .unwrap_err();
        assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    }
    assert_eq!(engine.len(), 0);
    assert!(model.series.is_empty());
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
