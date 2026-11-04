use barochart_core::chart_api::ChartApi;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::drawings::DrawingStore;
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::ingestion::IngestionOwner;
use barochart_core::interaction::OwnedInteractionState;
use barochart_core::model_state::{ModelContext, ModelState};
use barochart_core::native_chart::{NativeChart, NativeChartParts};
use barochart_core::native_data_jobs::NativePreparedCore;
use barochart_core::native_ui::{NativeUiCapture, NativeUiFinishMode, finish_direct};
use barochart_core::series_cache::SeriesCaches;
use barochart_core::{Engine, Host, HostError, NativeSizeState};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

struct NoZones;

impl Host for NoZones {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }

    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Ok(0)
    }

    fn log(&self, _: i32, _: &str) {}
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut output = JsObject::new();
    for (name, value) in entries {
        output.insert(key(name), value);
    }
    JsValue::Object(output)
}

fn bars() -> Vec<Bar> {
    vec![
        Bar {
            time: 1.0,
            open: 1.0,
            high: 2.0,
            low: 0.5,
            close: 1.5,
            volume: 10.0,
        },
        Bar {
            time: 2.0,
            open: 2.0,
            high: 3.0,
            low: 1.5,
            close: 2.5,
            volume: 20.0,
        },
    ]
}

fn empty_chart() -> NativeChart {
    let data = ModelDataState::new(StoreOptions::default(), bars()).unwrap();
    NativeChart::new(
        data,
        &JsValue::Object(JsObject::new()),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap()
}

fn size() -> NativeSizeState {
    let mut engine = Engine::new(Box::new(NoZones));
    engine
        .set_native_size(&JsValue::Number(800.0), &JsValue::Number(600.0))
        .unwrap();
    engine.native_size().unwrap().clone()
}

fn add_external_series(
    model: &mut ModelState,
    store: &barochart_core::data::BarStore,
    label: &str,
) {
    for (id, values) in [("a", vec![1.0, 2.0]), ("b", vec![10.0, 20.0])] {
        model
            .add_series_with_values(
                &object([
                    ("id", text(id)),
                    ("type", text("line")),
                    ("panel", text("price")),
                    ("label", text(&format!("{label}-{id}"))),
                ]),
                values,
                &ModelContext::plain(store),
            )
            .unwrap();
    }
}

fn model_parts(label: &str) -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    let data = ModelDataState::new(StoreOptions::default(), bars()).unwrap();
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    add_external_series(&mut model, data.store(), label);
    let owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    (owner, model, indicators, SeriesCaches::new())
}

fn source_chart(label: &str) -> NativeChart {
    let (owner, model, indicators, series_caches) = model_parts(label);
    let memory = owner.data().store().memory_context().clone();
    NativeChart::from_parts(NativeChartParts {
        ingestion: owner,
        model,
        indicators,
        drawings: DrawingStore::with_defaults(NumberDialect::Ecma),
        series_caches,
        symbol: None,
        symbol_record: None,
        symbol_formatters: false,
        symbol_memory: MemoryGroup::empty(memory),
        dialect: NumberDialect::Ecma,
    })
    .unwrap()
}

fn target_core(label: &str) -> NativePreparedCore {
    let (owner, mut model, indicators, caches) = model_parts(label);
    model.series[0].revision = Some(11.0);
    model.series[0].dirty_from = 1.0;
    model.series[0].range_index_ready = true;
    model.series[0].values_revision = Some(21.0);
    model.series[1].revision = Some(12.0);
    model.series[1].dirty_from = 2.0;
    model.series[1].range_index_ready = false;
    model.series[1].values_revision = Some(22.0);
    NativePreparedCore {
        owner,
        model,
        indicators,
        caches,
        prepared_input: JsValue::Undefined,
    }
}

fn string_field(value: &JsValue, name: &str) -> JsString {
    let JsValue::Object(value) = value else {
        panic!("object required: {value:?}")
    };
    let Some(JsValue::String(value)) = value.get(&key(name)) else {
        panic!("string field {name} required")
    };
    value.clone()
}

#[test]
fn reordered_native_ui_series_patches_publish_by_id_and_keep_external_owners() {
    let source = source_chart("new");
    let input = OwnedInteractionState::new();
    let direct =
        NativeUiCapture::direct(&source, &input, &size(), None, NumberDialect::Ecma).unwrap();
    let mut state = parse_json_utf16(direct.as_units(), JsonMode::Standard).unwrap();
    let JsValue::Object(state_record) = &mut state else {
        panic!("UI state object")
    };
    let Some(JsValue::Array(series)) = state_record.get_mut(&key("series")) else {
        panic!("UI series array")
    };
    series.swap(0, 1);
    let text = String::from_utf8(stringify_json(&state, JsonMode::Standard)).unwrap();

    let core = target_core("old");
    let pointers = [
        core.model.series[0].values.as_ref().unwrap().as_ptr(),
        core.model.series[1].values.as_ref().unwrap().as_ptr(),
    ];
    let accounted = [
        core.model.series[0].values_accounted_bytes(),
        core.model.series[1].values_accounted_bytes(),
    ];
    let publication = finish_direct(
        core,
        &key(&text),
        NativeUiFinishMode::Prepare,
        &NoZones,
        NumberDialect::Ecma,
    )
    .unwrap();
    let series = &publication.chart.model().series;

    assert_eq!(series[0].id, key("a"));
    assert_eq!(series[1].id, key("b"));
    assert_eq!(string_field(&series[0].raw_record(), "label"), key("new-a"));
    assert_eq!(string_field(&series[1].raw_record(), "label"), key("new-b"));
    assert_eq!(series[0].values.as_ref().unwrap().as_ptr(), pointers[0]);
    assert_eq!(series[1].values.as_ref().unwrap().as_ptr(), pointers[1]);
    assert_eq!(series[0].values_accounted_bytes(), accounted[0]);
    assert_eq!(series[1].values_accounted_bytes(), accounted[1]);
    assert_eq!(series[0].revision, Some(11.0));
    assert_eq!(series[1].revision, Some(12.0));
    assert_eq!(series[0].dirty_from, 1.0);
    assert_eq!(series[1].dirty_from, 2.0);
    assert!(series[0].range_index_ready);
    assert!(!series[1].range_index_ready);
    assert_eq!(series[0].values_revision, Some(21.0));
    assert_eq!(series[1].values_revision, Some(22.0));
}

fn missing_indicator(chart: &mut NativeChart, id: JsValue, scope: &mut MemoryScope) -> JsError {
    ChartApi::new(chart, &NoZones)
        .dispatch_scoped(&key("removeIndicator"), &[id], scope)
        .unwrap_err()
}

#[test]
fn remove_indicator_uses_scoped_exact_js_tostring_without_mutation() {
    let mut chart = empty_chart();
    let before_series = chart.model().series.len();
    let cases = [
        (JsValue::Number(5.0), key("Missing indicator: 5")),
        (JsValue::Null, key("Missing indicator: null")),
        (
            JsValue::Array(vec![JsValue::Number(1.0), JsValue::Undefined, text("x")]),
            key("Missing indicator: 1,,x"),
        ),
        (
            JsValue::String(JsString::from_utf16(vec![0xd800])),
            JsString::from_utf16(
                "Missing indicator: "
                    .encode_utf16()
                    .chain([0xd800])
                    .collect(),
            ),
        ),
    ];
    for (id, expected) in cases {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        let error = missing_indicator(&mut chart, id, &mut scope);
        assert_eq!(error.name, "Error");
        assert_eq!(error.message, expected);
        assert!(error.code.is_none());
        assert!(chart.indicators().is_empty());
        assert_eq!(chart.model().series.len(), before_series);
    }

    let account = MemoryAccount::new(128, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = missing_indicator(
        &mut chart,
        JsValue::String(key(&"x".repeat(1_048_576))),
        &mut scope,
    );
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert!(chart.indicators().is_empty());
    assert_eq!(chart.model().series.len(), before_series);
}

fn controller_dispatch(
    chart: &mut NativeChart,
    controller: &mut OwnedInteractionState,
    operation: &str,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    ChartApi::with_controller(chart, controller, &NoZones, 800.0, 600.0)
        .dispatch(&key(operation), args)
}

#[test]
fn set_series_ignores_every_patch_id_and_preserves_original_owner_state() {
    let mut chart = empty_chart();
    let mut controller = OwnedInteractionState::new();
    for (id, values) in [
        ("a", vec![JsValue::Number(1.0), JsValue::Number(2.0)]),
        ("b", vec![JsValue::Number(10.0), JsValue::Number(20.0)]),
    ] {
        controller_dispatch(
            &mut chart,
            &mut controller,
            "addSeries",
            &[object([
                ("id", text(id)),
                ("type", text("line")),
                ("panel", text("price")),
                ("label", text("old")),
                ("values", JsValue::Array(values)),
            ])],
        )
        .unwrap();
    }
    controller_dispatch(
        &mut chart,
        &mut controller,
        "setDrawingTarget",
        &[object([("panel", text("price")), ("seriesId", text("a"))])],
    )
    .unwrap();

    chart.model_mut().series[0].revision = Some(31.0);
    chart.model_mut().series[0].dirty_from = 1.0;
    chart.model_mut().series[0].range_index_ready = true;
    let pointer = chart.model().series[0].values.as_ref().unwrap().as_ptr();
    let values_revision = chart.model().series[0].values_revision;
    let accounted = chart.model().series[0].values_accounted_bytes();
    for (index, patch_id) in [
        text("fresh"),
        text("b"),
        JsValue::Number(7.0),
        JsValue::Null,
    ]
    .into_iter()
    .enumerate()
    {
        let label = format!("updated-{index}");
        controller_dispatch(
            &mut chart,
            &mut controller,
            "setSeries",
            &[
                text("a"),
                object([("id", patch_id), ("label", text(&label))]),
            ],
        )
        .unwrap();
        let series = &chart.model().series;
        assert_eq!(
            series.iter().map(|row| row.id.clone()).collect::<Vec<_>>(),
            [key("a"), key("b")]
        );
        assert_eq!(string_field(&series[0].raw_record(), "label"), key(&label));
        assert_eq!(series[0].values.as_ref().unwrap().as_ptr(), pointer);
        assert_eq!(series[0].values_revision, values_revision);
        assert_eq!(series[0].values_accounted_bytes(), accounted);
        assert_eq!(series[0].revision, Some(31.0));
        assert_eq!(series[0].dirty_from, 1.0);
        assert!(series[0].range_index_ready);
        let JsValue::Object(target) = controller.drawing_target().unwrap() else {
            panic!("drawing target object")
        };
        assert!(matches!(
            target.get(&key("seriesId")),
            Some(JsValue::String(id)) if id == &key("a")
        ));
    }
}
