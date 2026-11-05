use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::interaction::OwnedInteractionState;
use barochart_core::native_chart::NativeChart;
use barochart_core::native_ui::{NativeUiCapture, NativeUiImport};
use barochart_core::{Host, HostError, NativeSizeState};
use barochart_js::json::{JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

struct NoZones;

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
