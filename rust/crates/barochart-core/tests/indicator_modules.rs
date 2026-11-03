use barochart_core::{indicator_modules, indicator_registry, indicator_types};

use barochart_core::indicator_registry::{IndicatorRegistry, PRESSURE_DESCRIPTOR};
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json};
use barochart_js::string::JsString;
use indicator_modules::{
    ModuleDocumentSurface, is_linkable_custom, pressure_descriptor_value,
    register_indicator_module, resolve_document_module, unavailable_indicator_source_error,
    validate_indicator_module_binding,
};

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

#[test]
fn explicit_undefined_descriptor_matches_an_absent_descriptor() {
    let name = key("sma");
    assert_eq!(
        validate_indicator_module_binding(&name, Some(&JsValue::Undefined)).unwrap(),
        None
    );
    for surface in [
        ModuleDocumentSurface::Studies,
        ModuleDocumentSurface::Workspace,
    ] {
        assert_eq!(
            resolve_document_module(&name, Some(&JsValue::Undefined), surface).unwrap(),
            None
        );
    }
}

fn descriptor(
    id: &str,
    version: f64,
    state_version: f64,
    export_name: &str,
    causal: bool,
) -> JsValue {
    let mut value = JsObject::new();
    value.insert(key("id"), JsValue::String(key(id)));
    value.insert(key("version"), JsValue::Number(version));
    value.insert(key("stateVersion"), JsValue::Number(state_version));
    value.insert(key("exportName"), JsValue::String(key(export_name)));
    value.insert(key("causal"), JsValue::Bool(causal));
    JsValue::Object(value)
}

fn module_error(
    result: Result<Vec<JsString>, barochart_js::error::JsError>,
) -> barochart_js::error::JsError {
    result.err().unwrap()
}

#[test]
fn metadata_registry_has_builtin_rows_then_registers_pressure_idempotently() {
    let mut registry = IndicatorRegistry::new();
    assert_eq!(registry.len(), 35);
    assert!(
        registry
            .lookup(&key("aster.volume-direction@1/pressure"))
            .is_none()
    );
    assert!(registry.lookup(&key("obv")).is_some());

    let names = register_indicator_module(
        &mut registry,
        &JsValue::String(key("aster.volume-direction")),
        &JsValue::Number(1.0),
    )
    .unwrap();
    assert_eq!(names, [key("aster.volume-direction@1/pressure")]);
    assert_eq!(registry.len(), 36);
    assert_eq!(
        registry.lookup(&key("aster.volume-direction@1/pressure")),
        Some(indicator_registry::metadata_for_program(
            indicator_types::IndicatorProgram::Pressure,
        ))
    );
    assert_eq!(
        register_indicator_module(
            &mut registry,
            &JsValue::String(key("aster.volume-direction")),
            &JsValue::Number(1.0),
        )
        .unwrap(),
        names
    );
    assert_eq!(registry.len(), 36);
}

#[test]
fn registration_errors_validate_id_then_version_and_never_change_registry() {
    let mut registry = IndicatorRegistry::new();
    let error = module_error(register_indicator_module(
        &mut registry,
        &JsValue::String(key("bad/id")),
        &JsValue::Number(0.0),
    ));
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, key("Indicator module id"));
    assert_eq!(registry.len(), 35);

    let error = module_error(register_indicator_module(
        &mut registry,
        &JsValue::String(key("aster.volume-direction")),
        &JsValue::Number(1.5),
    ));
    assert_eq!(error.message, key("Indicator module version"));
    assert_eq!(registry.len(), 35);

    let error = module_error(register_indicator_module(
        &mut registry,
        &JsValue::String(key("aster.volume-direction")),
        &JsValue::Number(2.0),
    ));
    assert_eq!(error.name, "UnsupportedIndicatorError");
    assert_eq!(
        error.message,
        key(
            "Unsupported indicator module: aster.volume-direction@2; requires a canonical builtin or linked factory"
        )
    );
    assert_eq!(error.code.as_deref(), Some("UNSUPPORTED_INDICATOR_MODULE"));
    assert_eq!(registry.len(), 35);
    assert!(
        registry
            .lookup(&key("aster.volume-direction@1/pressure"))
            .is_none()
    );
}

#[test]
fn descriptor_shape_and_pressure_binding_match_the_static_linked_descriptor() {
    let pressure_descriptor = pressure_descriptor_value();
    assert_eq!(
        String::from_utf8(stringify_json(&pressure_descriptor, JsonMode::Standard)).unwrap(),
        r#"{"id":"aster.volume-direction","version":1,"stateVersion":1,"exportName":"pressure","causal":true}"#
    );
    assert!(std::ptr::eq(
        validate_indicator_module_binding(
            &key("aster.volume-direction@1/pressure"),
            Some(&pressure_descriptor),
        )
        .unwrap()
        .unwrap(),
        &PRESSURE_DESCRIPTOR
    ));
    assert_eq!(
        validate_indicator_module_binding(&key("sma"), None).unwrap(),
        None
    );
    assert_eq!(
        validate_indicator_module_binding(&key("sma"), Some(&pressure_descriptor))
            .unwrap_err()
            .message,
        key("Indicator module descriptor binding")
    );
    assert_eq!(
        validate_indicator_module_binding(&key("aster.volume-direction@1/pressure"), None)
            .unwrap_err()
            .message,
        key("Indicator module descriptor: object required")
    );

    let mut unsupported = match &pressure_descriptor {
        JsValue::Object(value) => value.clone(),
        _ => unreachable!(),
    };
    unsupported.insert(key("extra"), JsValue::Bool(true));
    assert_eq!(
        validate_indicator_module_binding(
            &key("aster.volume-direction@1/pressure"),
            Some(&JsValue::Object(unsupported))
        )
        .unwrap_err()
        .message,
        key("Indicator module descriptor: unsupported field extra")
    );
    let wrong = descriptor("aster.volume-direction", 1.0, 9.0, "pressure", true);
    assert_eq!(
        validate_indicator_module_binding(&key("aster.volume-direction@1/pressure"), Some(&wrong))
            .unwrap_err()
            .message,
        key("Indicator module descriptor binding")
    );
}

#[test]
fn linkable_predicate_and_document_surfaces_use_distinct_exact_rejections() {
    let custom = descriptor("test.native-workspace", 1.0, 9.0, "pair", true);
    let custom_name = key("test.native-workspace@1/pair");
    assert!(is_linkable_custom(&custom_name, Some(&custom)));
    assert!(!is_linkable_custom(&key("sma"), Some(&custom)));
    assert!(!is_linkable_custom(
        &key("test.native-workspace@1/pair"),
        Some(&descriptor(
            "test.native-workspace",
            1.0,
            9.0,
            "other",
            true
        ))
    ));
    assert!(!is_linkable_custom(
        &key("test.native-workspace@1/pair"),
        Some(&descriptor(
            "test.native-workspace",
            1.0,
            9.0,
            "pair",
            false
        ))
    ));
    assert!(!is_linkable_custom(
        &key("aster.volume-direction@1/other"),
        Some(&descriptor(
            "aster.volume-direction",
            1.0,
            1.0,
            "other",
            true
        ))
    ));
    assert!(is_linkable_custom(
        &key("aster.volume-direction@2/pressure"),
        Some(&descriptor(
            "aster.volume-direction",
            2.0,
            9.0,
            "pressure",
            true
        ))
    ));

    for surface in [
        ModuleDocumentSurface::Studies,
        ModuleDocumentSurface::Workspace,
    ] {
        let error = resolve_document_module(&custom_name, Some(&custom), surface).unwrap_err();
        assert_eq!(error.name, "UnavailableError");
        assert_eq!(
            error.message,
            key("Indicator module requires the javaScript backend: test.native-workspace@1/pair")
        );
        assert_eq!(error.code.as_deref(), Some("JAVASCRIPT_BACKEND_REQUIRED"));
    }
    assert!(
        resolve_document_module(
            &key("unregistered.name"),
            None,
            ModuleDocumentSurface::Workspace
        )
        .unwrap()
        .is_none()
    );
    let error = resolve_document_module(
        &key("unregistered.name"),
        None,
        ModuleDocumentSurface::Studies,
    )
    .unwrap_err();
    assert_eq!(error.name, "UnsupportedIndicatorError");
    assert_eq!(error.code.as_deref(), Some("UNSUPPORTED_INDICATOR_MODULE"));

    assert!(
        resolve_document_module(
            &key("aster.volume-direction@1/pressure"),
            Some(&pressure_descriptor_value()),
            ModuleDocumentSurface::Studies,
        )
        .unwrap()
        .is_some()
    );
    assert_eq!(
        resolve_document_module(
            &key("aster.volume-direction@1/pressure"),
            Some(&custom),
            ModuleDocumentSurface::Studies,
        )
        .unwrap_err()
        .message,
        key("Study module version/codec mismatch")
    );
    assert_eq!(
        resolve_document_module(
            &key("aster.volume-direction@1/pressure"),
            None,
            ModuleDocumentSurface::Studies,
        )
        .unwrap_err()
        .message,
        key("Study module version/codec mismatch")
    );
    let malformed = descriptor("test.native-workspace", 1.0, 9.0, "pair", false);
    assert_eq!(
        resolve_document_module(
            &custom_name,
            Some(&malformed),
            ModuleDocumentSurface::Studies,
        )
        .unwrap_err()
        .name,
        "UnsupportedIndicatorError"
    );
}

#[test]
fn js_only_source_registration_error_matches_tier_a() {
    let error = unavailable_indicator_source_error();
    assert_eq!(error.name, "UnavailableError");
    assert_eq!(
        error.message,
        key("Indicator source registration requires the javaScript backend")
    );
    assert_eq!(error.code.as_deref(), Some("JAVASCRIPT_BACKEND_REQUIRED"));
}
