use barochart_core::chart_api::ChartApi;
use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::interaction::OwnedInteractionState;
use barochart_core::native_chart::NativeChart;
use barochart_core::native_data_jobs::{
    NativePrepareSource, NativePrepareTarget, NativePreparedCore,
};
use barochart_core::native_ui::{NativeUiCapture, NativeUiFinishMode, NativeUiImport};
use barochart_core::{Host, HostError, NativeSizeState};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

struct NoZones;

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut output = JsObject::new();
    for (name, value) in entries {
        output.insert(JsString::from_str(name), value);
    }
    JsValue::Object(output)
}

impl Host for NoZones {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        if name == &JsString::from_str("UTC") {
            Ok(name.clone())
        } else {
            Err(HostError)
        }
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Ok(0)
    }
    fn log(&self, _: i32, _: &str) {}
}

fn chart(length: usize) -> NativeChart {
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
    NativeChart::new(data, &JsValue::Null, NumberDialect::Ecma, &NoZones).unwrap()
}

fn size() -> NativeSizeState {
    let mut engine = barochart_core::Engine::new(Box::new(NoZones));
    engine
        .set_native_size(&JsValue::Number(800.0), &JsValue::Number(500.0))
        .unwrap();
    engine.native_size().unwrap().clone()
}

fn prepared_core(chart: &NativeChart, count: usize) -> NativePreparedCore {
    let request = object([
        ("kind", JsValue::String(JsString::from_str("seeded"))),
        ("count", JsValue::Number(count as f64)),
        ("seed", JsValue::Number(42.0)),
        ("visibleBars", JsValue::Number(count as f64)),
    ]);
    let source = NativePrepareSource::capture(
        chart.ingestion_owner(),
        chart.model(),
        chart.indicators(),
        chart.series_caches(),
        &request,
        NumberDialect::Ecma,
    )
    .unwrap();
    let mut target =
        NativePrepareTarget::new(source.metadata_json(), NumberDialect::Ecma, &NoZones).unwrap();
    target.start(1.0).unwrap();
    while !target.step(4_096.0, &NoZones).unwrap().complete {}
    target.take_prepared().unwrap()
}

fn mutate_header_state(header: &JsString, mutate: impl FnOnce(&mut JsObject)) -> JsString {
    let mut document = parse_json(header.to_string_lossy().as_bytes(), JsonMode::Standard).unwrap();
    {
        let JsValue::Object(header) = &mut document else {
            unreachable!()
        };
        let JsValue::Object(state) = header.get_mut(&JsString::from_str("state")).unwrap() else {
            unreachable!()
        };
        mutate(state);
    }
    JsString::from_str(&String::from_utf8(stringify_json(&document, JsonMode::Standard)).unwrap())
}

fn migration_mode(
    core: &NativePreparedCore,
    canonical_symbol: Option<JsValue>,
) -> NativeUiFinishMode {
    NativeUiFinishMode::migration(
        canonical_symbol,
        MemoryGroup::empty(core.owner.data().store().memory_context().clone()),
    )
}

fn set_symbol(chart: &mut NativeChart) -> JsValue {
    let symbol = object([
        ("id", JsValue::String(JsString::from_str("BTC"))),
        ("exchange", JsValue::String(JsString::from_str("DEMO"))),
        ("timezone", JsValue::String(JsString::from_str("UTC"))),
        ("currency", JsValue::String(JsString::from_str("USD"))),
        ("volumeUnit", JsValue::String(JsString::from_str("BTC"))),
        ("priceDecimals", JsValue::Number(2.0)),
        ("tickSize", JsValue::Number(0.01)),
        ("adjustment", JsValue::String(JsString::from_str("raw"))),
    ]);
    ChartApi::new(chart, &NoZones)
        .dispatch(
            &JsString::from_str("setSymbol"),
            std::slice::from_ref(&symbol),
        )
        .unwrap();
    chart.symbol_record().cloned().unwrap()
}

#[test]
fn migration_registration_binds_real_capture_header_and_workspace_identity() {
    let chart = chart(16);
    let input = OwnedInteractionState::new();
    let size = size();
    let capture = NativeUiCapture::new(&chart, &input, &size, None, NumberDialect::Ecma).unwrap();
    let metadata = JsString::from_str("workspace-metadata-41");
    let registration = capture.register_migration(41, 9, 7, &metadata).unwrap();
    assert!(registration.registration() > 0);
    assert_eq!(registration.workspace_ticket(), 41);
    assert_eq!(registration.workspace_registration(), 9);
    assert_eq!(registration.source_revision(), 7);
    capture
        .check_migration(&registration, &metadata, &chart, &input, &size)
        .unwrap();
    let changed_metadata = JsString::from_str("workspace-metadata-changed");
    let metadata_error = capture
        .check_migration(&registration, &changed_metadata, &chart, &input, &size)
        .unwrap_err();
    assert_eq!(
        metadata_error.message.to_string_lossy(),
        "Web UI migration workspace source changed"
    );
}

#[test]
fn migration_target_requires_exact_source_header_and_does_not_change_legacy_import() {
    let chart = chart(16);
    let input = OwnedInteractionState::new();
    let size = size();
    let capture = NativeUiCapture::new(&chart, &input, &size, None, NumberDialect::Ecma).unwrap();
    let metadata = JsString::from_str("workspace-metadata-3");
    let registration = capture.register_migration(3, 4, 5, &metadata).unwrap();
    let header = capture.header_json().clone();
    let memory = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
    let import = NativeUiImport::new_pending(&header, NumberDialect::Ecma, memory.clone()).unwrap();
    let mut scope = memory.scope();
    let description = registration.to_value_scoped(&mut scope).unwrap();
    let description_text = stringify_json(&description, JsonMode::Standard);
    let transported = parse_json(&description_text, JsonMode::Standard).unwrap();
    let target = import
        .register_migration_target(&transported, 3, 4, 5, &metadata)
        .unwrap();
    import
        .check_migration_target(&target, 3, 4, 5, &metadata)
        .unwrap();
    let changed_metadata = JsString::from_str("workspace-metadata-changed");
    let changed = import
        .check_migration_target(&target, 3, 4, 5, &changed_metadata)
        .unwrap_err();
    assert_eq!(
        changed.message.to_string_lossy(),
        "Web UI migration workspace target changed"
    );
    let wrong = capture.register_migration(3, 4, 6, &metadata).unwrap();
    let wrong_description = wrong.to_value_scoped(&mut scope).unwrap();
    let error = match import.register_migration_target(&wrong_description, 3, 4, 5, &metadata) {
        Ok(_) => panic!("mismatched migration target description was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.name, "Error");
    assert_eq!(
        error.message.to_string_lossy(),
        "Web UI migration target registration is stale"
    );
    // The legacy import remains usable after a failed migration proof check.
    NativeUiImport::validate_header(&header, NumberDialect::Ecma).unwrap();
}

#[test]
fn registration_rejects_uninitialized_zero_workspace_values() {
    let chart = chart(2);
    let capture = NativeUiCapture::new(
        &chart,
        &OwnedInteractionState::new(),
        &size(),
        None,
        NumberDialect::Ecma,
    )
    .unwrap();
    let metadata = JsString::from_str("workspace-metadata");
    assert!(capture.register_migration(0, 1, 1, &metadata).is_err());
    assert!(capture.register_migration(1, 0, 1, &metadata).is_err());
    assert!(capture.register_migration(1, 1, 0, &metadata).is_err());
}

#[test]
fn migration_requires_each_controller_field_when_attaching_the_prepared_core() {
    for case in [
        "missing drawingMagnet",
        "missing crosshairSnap",
        "missing both controls",
        "invalid drawingMagnet",
        "invalid crosshairSnap",
    ] {
        let chart = chart(16);
        let capture = NativeUiCapture::new_migration(
            &chart,
            &OwnedInteractionState::new(),
            &size(),
            NumberDialect::Ecma,
        )
        .unwrap();
        let header = mutate_header_state(capture.header_json(), |state| match case {
            "missing drawingMagnet" => {
                state.remove(&JsString::from_str("drawingMagnet"));
            }
            "missing crosshairSnap" => {
                state.remove(&JsString::from_str("crosshairSnap"));
            }
            "missing both controls" => {
                state.remove(&JsString::from_str("drawingMagnet"));
                state.remove(&JsString::from_str("crosshairSnap"));
            }
            "invalid drawingMagnet" => {
                state.insert(
                    JsString::from_str("drawingMagnet"),
                    object([("mode", JsValue::String(JsString::from_str("invalid")))]),
                );
            }
            "invalid crosshairSnap" => {
                state.insert(
                    JsString::from_str("crosshairSnap"),
                    object([("mode", JsValue::String(JsString::from_str("invalid")))]),
                );
            }
            _ => unreachable!(),
        });
        let core = prepared_core(&chart, 16);
        let mode = migration_mode(&core, None);
        let result = NativeUiImport::new(&header, core, mode, NumberDialect::Ecma);
        let error = match result {
            Ok(_) => panic!("migration accepted {case}"),
            Err(error) => error,
        };
        assert_eq!(error.name, "TypeError");
        if case.starts_with("missing") {
            assert_eq!(
                error.message.to_string_lossy(),
                "Backend migration controller state"
            );
        }
    }
}

#[test]
fn migration_requires_the_workspace_symbol_exactly_and_normalizes_only_nullish_absence() {
    for field in ["currency", "adjustment"] {
        let mut chart = chart(16);
        let canonical_symbol = set_symbol(&mut chart);
        let capture = NativeUiCapture::new_migration(
            &chart,
            &OwnedInteractionState::new(),
            &size(),
            NumberDialect::Ecma,
        )
        .unwrap();
        let header = mutate_header_state(capture.header_json(), |state| {
            let JsValue::Object(symbol) = state.get_mut(&JsString::from_str("symbol")).unwrap()
            else {
                unreachable!()
            };
            symbol.insert(
                JsString::from_str(field),
                JsValue::String(JsString::from_str(if field == "currency" {
                    "EUR"
                } else {
                    "split"
                })),
            );
        });
        let core = prepared_core(&chart, 16);
        let mode = migration_mode(&core, Some(canonical_symbol));
        let result = NativeUiImport::new(&header, core, mode, NumberDialect::Ecma);
        let error = match result {
            Ok(_) => panic!("migration accepted mismatched {field}"),
            Err(error) => error,
        };
        assert_eq!(error.name, "Error");
        assert_eq!(
            error.message.to_string_lossy(),
            "Backend migration symbol changed"
        );
    }

    let no_symbol_chart = chart(16);
    let capture = NativeUiCapture::new_migration(
        &no_symbol_chart,
        &OwnedInteractionState::new(),
        &size(),
        NumberDialect::Ecma,
    )
    .unwrap();
    for header in [
        capture.header_json().clone(),
        mutate_header_state(capture.header_json(), |state| {
            state.insert(JsString::from_str("symbol"), JsValue::Null);
        }),
    ] {
        let core = prepared_core(&no_symbol_chart, 16);
        let mode = migration_mode(&core, None);
        NativeUiImport::new(&header, core, mode, NumberDialect::Ecma)
            .unwrap_or_else(|error| panic!("nullish symbol was rejected: {error:?}"));
    }

    let mut chart = chart(16);
    let canonical_symbol = set_symbol(&mut chart);
    let capture = NativeUiCapture::new_migration(
        &chart,
        &OwnedInteractionState::new(),
        &size(),
        NumberDialect::Ecma,
    )
    .unwrap();
    let core = prepared_core(&chart, 16);
    let mode = migration_mode(&core, Some(canonical_symbol));
    NativeUiImport::new(capture.header_json(), core, mode, NumberDialect::Ecma)
        .unwrap_or_else(|error| panic!("exact symbol was rejected: {error:?}"));
}

#[test]
fn legacy_prepare_and_async_imports_keep_controller_fields_optional() {
    let chart = chart(16);
    let input = OwnedInteractionState::new();
    let core = prepared_core(&chart, 16);
    let capture = NativeUiCapture::new(
        &chart,
        &input,
        &size(),
        Some(&core.prepared_input),
        NumberDialect::Ecma,
    )
    .unwrap();
    NativeUiImport::new(
        capture.header_json(),
        core,
        NativeUiFinishMode::Prepare,
        NumberDialect::Ecma,
    )
    .unwrap_or_else(|error| panic!("legacy prepare controls became required: {error:?}"));

    let core = prepared_core(&chart, 16);
    let event_memory = MemoryGroup::empty(core.owner.data().store().memory_context().clone());
    let capture = NativeUiCapture::new(&chart, &input, &size(), None, NumberDialect::Ecma).unwrap();
    NativeUiImport::new(
        capture.header_json(),
        core,
        NativeUiFinishMode::Async {
            event: object([("kind", JsValue::String(JsString::from_str("append")))]),
            source_length: 16,
            memory: event_memory,
        },
        NumberDialect::Ecma,
    )
    .unwrap_or_else(|error| panic!("legacy async controls became required: {error:?}"));
}
