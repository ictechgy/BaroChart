use barochart_core::chart_api::ChartApi;
use barochart_core::coercion::{js_add_number_scoped, js_to_number_scoped};
use barochart_core::contracts::portable_style_scoped;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::drawing_geometry::DrawingGeometryCache;
use barochart_core::drawings::DrawingStore;
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::interaction::{InteractionContext, OwnedInteractionState};
use barochart_core::model_state::ModelState;
use barochart_core::native_chart::NativeChart;
use barochart_core::series_cache::SeriesCaches;
use barochart_core::{Engine, Host, HostError};
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

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item);
    }
    JsValue::Object(value)
}

fn chart_with_memory(account: &std::sync::Arc<MemoryAccount>) -> NativeChart {
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(account),
    )
    .unwrap();
    NativeChart::new(
        data,
        &JsValue::Object(JsObject::new()),
        NumberDialect::PLATFORM,
        &NoZones,
    )
    .unwrap()
}

fn reserve_all_but(
    account: &std::sync::Arc<MemoryAccount>,
    limit: u64,
    remaining: u64,
) -> barochart_js::memory::MemoryLease {
    let live = account.snapshot().requested_live_bytes;
    account.reserve(limit - live - remaining).unwrap()
}

#[test]
fn scoped_number_coercion_preserves_bits_wtf16_and_to_primitive_errors() {
    for dialect in [NumberDialect::Ecma, NumberDialect::QuickJs] {
        for input in [
            text("  -0  "),
            text("0009007199254740993"),
            text("0x20000000000001"),
            JsValue::String(JsString::from_utf16(vec![0xd800])),
            JsValue::Array(vec![text("1.25")]),
        ] {
            let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
            let scoped = js_to_number_scoped(&input, dialect, &mut scope).unwrap();
            let legacy = barochart_core::coercion::js_to_number_with(&input, dialect).unwrap();
            assert_eq!(scoped.to_bits(), legacy.to_bits(), "input: {input:?}");
        }

        let offending = object([("toString", JsValue::Null)]);
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        let scoped = js_to_number_scoped(&offending, dialect, &mut scope).unwrap_err();
        let legacy = barochart_core::coercion::js_to_number_with(&offending, dialect).unwrap_err();
        assert_eq!(scoped.name, legacy.name);
        assert_eq!(scoped.message, legacy.message);
    }
}

#[test]
fn scoped_number_left_addition_is_quota_bounded_and_keeps_string_semantics() {
    let account = MemoryAccount::new(64, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = js_add_number_scoped(
        -0.0,
        &text(&"x".repeat(1_024)),
        NumberDialect::Ecma,
        &mut scope,
    )
    .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(scope);
    assert_eq!(account.snapshot().requested_live_bytes, 0);

    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    let value = js_add_number_scoped(-0.0, &text("x"), NumberDialect::Ecma, &mut scope).unwrap();
    let JsValue::String(value) = &value else {
        panic!("number-left string addition must return a string")
    };
    assert_eq!(value, &key("0x"));
}

#[test]
fn portable_style_validates_scalars_before_scoped_snapshot_allocation() {
    let mut huge = JsObject::new();
    huge.insert(
        key("background"),
        JsValue::Array((0..4_096).map(|_| text("raw")).collect()),
    );
    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = portable_style_scoped(
        &JsValue::Object(huge),
        &["background", "grid", "text", "up", "down", "crosshair"],
        false,
        &mut scope,
    )
    .unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, key("Color string required"));
    assert_eq!(scope.requested_bytes(), 0);

    let raw = object([(
        "metadata",
        JsValue::Array((0..4_096).map(|_| text("raw")).collect()),
    )]);
    let account = MemoryAccount::new(128, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = portable_style_scoped(&raw, &["color"], false, &mut scope).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
}

#[test]
fn native_commands_reject_theme_and_pan_allocations_without_publication() {
    const LIMIT: u64 = 1_000_000;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let mut chart = chart_with_memory(&account);
    let before_theme = format!("{:?}", chart.model().theme());
    let before_view = chart.model().view;

    let blocker = reserve_all_but(&account, LIMIT, 64);
    let scalar_error = ChartApi::new(&mut chart, &NoZones)
        .dispatch(
            &key("setTheme"),
            &[object([(
                "background",
                JsValue::Array((0..4_096).map(|_| text("raw")).collect()),
            )])],
        )
        .unwrap_err();
    assert_eq!(scalar_error.name, "TypeError");
    assert_eq!(scalar_error.message, key("Color string required"));
    assert_eq!(format!("{:?}", chart.model().theme()), before_theme);

    let theme_error = ChartApi::new(&mut chart, &NoZones)
        .dispatch(&key("setTheme"), &[object([("background", text("red"))])])
        .unwrap_err();
    assert_eq!(theme_error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(format!("{:?}", chart.model().theme()), before_theme);
    drop(blocker);

    let blocker = reserve_all_but(&account, LIMIT, 64);
    let pan_error = ChartApi::new(&mut chart, &NoZones)
        .dispatch(&key("pan"), &[text(&"1".repeat(4_096))])
        .unwrap_err();
    assert_eq!(pan_error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(
        chart.model().view.from.to_bits(),
        before_view.from.to_bits()
    );
    assert_eq!(chart.model().view.to.to_bits(), before_view.to.to_bits());
    drop(blocker);
}

#[test]
fn successful_theme_replacement_keeps_only_the_published_topology_charge() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    model
        .set_theme_api(&object([
            ("background", text("red")),
            ("font", text("13px serif")),
        ]))
        .unwrap();
    assert_eq!(
        account.snapshot().requested_live_bytes,
        data.store().accounted_bytes() + model.accounted_bytes()
    );
    assert!(format!("{:?}", model.theme()).contains("#ff0000ff"));
    drop(model);
    drop(data);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn native_wheel_rejects_huge_numeric_text_before_layout_or_view_mutation() {
    const LIMIT: u64 = 1_000_000;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let mut controller =
        OwnedInteractionState::new_with_memory(MemoryContext::accounted(&account)).unwrap();
    let data = ModelDataState::new(
        StoreOptions::default(),
        vec![Bar {
            time: 1.0,
            open: 1.0,
            high: 2.0,
            low: 0.0,
            close: 1.0,
            volume: 1.0,
        }],
    )
    .unwrap();
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    let before = model.view;
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
    let mut series_caches = SeriesCaches::new();
    let mut geometry_cache = DrawingGeometryCache::new(4);
    let mut context = InteractionContext {
        model: &mut model,
        store: data.store(),
        indicators: &mut indicators,
        drawings: &mut drawings,
        series_caches: &mut series_caches,
        geometry_cache: &mut geometry_cache,
        host: &NoZones,
        width: 640.0,
        height: 360.0,
    };
    let blocker = reserve_all_but(&account, LIMIT, 64);
    let error = controller
        .wheel(
            &mut context,
            &text(&"1".repeat(4_096)),
            &JsValue::Number(320.0),
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(context.model.view.from.to_bits(), before.from.to_bits());
    assert_eq!(context.model.view.to.to_bits(), before.to.to_bits());
    drop(blocker);
}

#[test]
fn caller_scope_bounds_unbounded_indicator_and_series_error_inputs() {
    let mut chart = chart_with_memory(&MemoryAccount::new(0, OomStyle::InternalErrorLowercase));
    let caller = MemoryAccount::new(64, OomStyle::InternalErrorLowercase);
    let huge = text(&"missing".repeat(4_096));

    for (operation, args) in [
        (
            "addIndicator",
            vec![text("i"), huge.clone(), JsValue::Object(JsObject::new())],
        ),
        ("indicatorValues", vec![huge.clone(), JsValue::Undefined]),
        (
            "addSeries",
            vec![object([
                ("id", text("bad")),
                ("type", text("line")),
                ("panel", text("price")),
                ("indicator", huge.clone()),
            ])],
        ),
    ] {
        let mut scope = MemoryScope::new(&caller);
        let error = ChartApi::new(&mut chart, &NoZones)
            .dispatch_scoped(&key(operation), &args, &mut scope)
            .unwrap_err();
        assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
        drop(scope);
        assert_eq!(caller.snapshot().requested_live_bytes, 0);
    }
    assert!(chart.indicators().is_empty());
    assert!(chart.model().series.is_empty());

    ChartApi::new(&mut chart, &NoZones)
        .dispatch(
            &key("addSeries"),
            &[object([
                ("id", text("line")),
                ("type", text("line")),
                ("panel", text("price")),
                ("source", text("close")),
            ])],
        )
        .unwrap();
    let before = format!("{:?}", chart.model().series[0].raw_record());
    let mut scope = MemoryScope::new(&caller);
    let error = ChartApi::new(&mut chart, &NoZones)
        .dispatch_scoped(
            &key("setSeries"),
            &[
                text("line"),
                object([("indicator", text(&"missing".repeat(4_096)))]),
            ],
            &mut scope,
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(
        format!("{:?}", chart.model().series[0].raw_record()),
        before
    );
}

#[test]
fn scoped_native_indicator_seams_keep_raw_errors_in_the_root_scope() {
    let mut chart = chart_with_memory(&MemoryAccount::new(0, OomStyle::RangeErrorCapitalized));
    let caller = MemoryAccount::new(64, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&caller);
    let error = chart
        .indicator_buffer_scoped(
            &text(&"missing".repeat(4_096)),
            &text("value"),
            0.0,
            1.0,
            &NoZones,
            &mut scope,
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(scope);

    let mut engine = Engine::new(Box::new(NoZones));
    let data = engine.stage_empty_data().unwrap();
    let candidate = engine
        .stage_chart(data, &JsValue::Object(JsObject::new()))
        .unwrap();
    engine.install_chart(candidate).unwrap();
    let mut scope = MemoryScope::new(&caller);
    let error = engine
        .add_legacy_indicator_scoped(
            &text("i"),
            &text(&"missing".repeat(4_096)),
            &JsValue::Object(JsObject::new()),
            &JsValue::Undefined,
            &mut scope,
        )
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert!(engine.chart().unwrap().indicators().is_empty());

    let mut priority = MemoryScope::new(&MemoryAccount::new(1, OomStyle::InternalErrorLowercase));
    let error = engine
        .add_legacy_indicator_scoped(
            &text(&"i".repeat(129)),
            &text(&"missing".repeat(4_096)),
            &JsValue::Object(JsObject::new()),
            &JsValue::Undefined,
            &mut priority,
        )
        .unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(priority.requested_bytes(), 0);
}

#[test]
fn scoped_native_init_series_error_discards_candidate_and_keeps_live_chart() {
    let mut engine = Engine::new(Box::new(NoZones));
    let initial_data = engine.stage_empty_data().unwrap();
    let initial = engine
        .stage_chart(initial_data, &JsValue::Object(JsObject::new()))
        .unwrap();
    engine.install_chart(initial).unwrap();
    let identity = engine.chart().unwrap().capture_identity();

    let candidate_data = engine.stage_empty_data().unwrap();
    let options = object([(
        "series",
        JsValue::Array(vec![object([
            ("id", text("bad")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text(&"missing".repeat(4_096))),
        ])]),
    )]);
    let account = MemoryAccount::new(64, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = match engine.stage_chart_scoped(candidate_data, &options, &mut scope) {
        Ok(_) => panic!("oversized nativeInit candidate unexpectedly succeeded"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert!(engine.chart().unwrap().validate_identity(&identity));
    assert!(engine.chart().unwrap().model().series.is_empty());
}
