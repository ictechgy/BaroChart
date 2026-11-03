//! 정적 linked pressure module과 JS-only module 거부 계약을 제공한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

use crate::contracts::{identifier, option_record};
use crate::indicator_registry::{IndicatorRegistry, PRESSURE_DESCRIPTOR};
use crate::indicator_types::{IndicatorModuleDescriptor, IndicatorProgram};

const DESCRIPTOR_KEYS: &[&str] = &["id", "version", "stateVersion", "exportName", "causal"];
const MODULE_ID: &str = "aster.volume-direction";
const MODULE_VERSION: u32 = 1;
const PRESSURE_NAME: &str = "aster.volume-direction@1/pressure";
const JS_BACKEND_REQUIRED: &str = "JAVASCRIPT_BACKEND_REQUIRED";
const UNSUPPORTED_INDICATOR_MODULE: &str = "UNSUPPORTED_INDICATOR_MODULE";

/// 문서의 linked module을 검사할 surface다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleDocumentSurface {
    /// `aster.studies` 입력이다.
    Studies,
    /// workspace 입력이다.
    Workspace,
}

/// 정적으로 알려진 pressure descriptor를 반환한다.
pub fn pressure_descriptor() -> &'static IndicatorModuleDescriptor {
    &PRESSURE_DESCRIPTOR
}

/// Pressure descriptor를 JS 문서 키 순서의 값으로 복사한다.
pub fn pressure_descriptor_value() -> JsValue {
    descriptor_value(&PRESSURE_DESCRIPTOR)
}

/// 정적 module `aster.volume-direction@1`을 기존 registry에 idempotent하게 등록한다.
///
/// ID 검사 뒤 version을 검사한다. 지원하지 않는 요청에서는 registry를 변경하지 않는다.
pub fn register_indicator_module(
    registry: &mut IndicatorRegistry,
    id: &JsValue,
    version: &JsValue,
) -> Result<Vec<JsString>, JsError> {
    let id = module_token(id, "id")?;
    let version = module_integer(version)?;
    if id == JsString::from_str(MODULE_ID) && version == u64::from(MODULE_VERSION) {
        return Ok(registry
            .register_volume_direction_v1()
            .iter()
            .map(|name| JsString::from_str(name))
            .collect());
    }
    Err(unsupported_indicator_module(&module_key(&id, version)))
}

/// JS `validateIndicatorModuleBinding`에 대응하는 Rust linked binding 검사다.
pub fn validate_indicator_module_binding(
    name: &JsString,
    descriptor: Option<&JsValue>,
) -> Result<Option<&'static IndicatorModuleDescriptor>, JsError> {
    let descriptor = descriptor.filter(|value| !matches!(value, JsValue::Undefined));
    let Some(expected) = expected_descriptor(name) else {
        if descriptor.is_some() {
            return Err(type_error("Indicator module descriptor binding"));
        }
        return Ok(None);
    };
    let undefined = JsValue::Undefined;
    let value = descriptor.unwrap_or(&undefined);
    validate_descriptor_record(value)?;
    if !descriptor_matches(value, expected) {
        return Err(type_error("Indicator module descriptor binding"));
    }
    Ok(Some(expected))
}

/// JSON 문서의 custom module descriptor가 JS bundle에서 linkable인지 판정한다.
///
/// 입력이 잘못됐거나 module이 Rust registry에 있으면 오류를 던지지 않고 거짓을 반환한다.
pub fn is_linkable_custom(name: &JsString, descriptor: Option<&JsValue>) -> bool {
    if name.len_utf16() > 128 || is_rust_registry_name(name) {
        return false;
    }
    let Some(value) = descriptor else {
        return false;
    };
    let Some(record) = object(value) else {
        return false;
    };
    if record.len() != DESCRIPTOR_KEYS.len()
        || record.iter().any(|(field, _)| {
            !DESCRIPTOR_KEYS
                .iter()
                .any(|allowed| field == &key_for(allowed))
        })
    {
        return false;
    }
    let (Some(id), Some(version), Some(state_version), Some(export_name)) = (
        string_field(record, "id"),
        number_field(record, "version"),
        number_field(record, "stateVersion"),
        string_field(record, "exportName"),
    ) else {
        return false;
    };
    if !matches!(record.get(&key_for("causal")), Some(JsValue::Bool(true)))
        || !valid_module_token(&id, "id")
        || !valid_module_token(&export_name, "export name")
        || !valid_module_integer(version)
        || !valid_module_integer(state_version)
    {
        return false;
    }
    let module = module_key(&id, version as u64);
    if module == JsString::from_str("aster.volume-direction@1") {
        return false;
    }
    concat(&[&module, &key_for("/"), &export_name]) == *name
}

/// `loadStudies`와 workspace reader에 각각 맞는 module 거부·검증 순서를 적용한다.
///
/// 반환된 descriptor는 문서가 Pressure를 참조할 때만 존재한다. Workspace의 descriptor
/// 없는 unknown name은 staging 단계에서 factory 조회가 처리하므로 통과시킨다.
pub fn resolve_document_module(
    name: &JsString,
    descriptor: Option<&JsValue>,
    surface: ModuleDocumentSurface,
) -> Result<Option<&'static IndicatorModuleDescriptor>, JsError> {
    let descriptor = descriptor.filter(|value| !matches!(value, JsValue::Undefined));
    if let Some(expected) = expected_descriptor(name) {
        match surface {
            ModuleDocumentSurface::Workspace => {
                validate_indicator_module_binding(name, descriptor)?;
            }
            ModuleDocumentSurface::Studies => {
                if !descriptor.is_some_and(|value| descriptor_matches(value, expected)) {
                    return Err(type_error("Study module version/codec mismatch"));
                }
            }
        }
        return Ok(Some(expected));
    }

    if is_builtin_name(name) {
        match surface {
            ModuleDocumentSurface::Studies if descriptor.is_some() => {
                return Err(type_error("Study module version/codec mismatch"));
            }
            ModuleDocumentSurface::Workspace if descriptor.is_some() => {
                return Err(type_error("Indicator module descriptor binding"));
            }
            _ => return Ok(None),
        }
    }

    if is_linkable_custom(name, descriptor) {
        return Err(unavailable_linked_module_error(name));
    }
    match surface {
        ModuleDocumentSurface::Studies => Err(unsupported_indicator_module(name)),
        ModuleDocumentSurface::Workspace if descriptor.is_none() => Ok(None),
        ModuleDocumentSurface::Workspace => Err(type_error("Indicator module descriptor binding")),
    }
}

/// `nativeRegisterIndicatorSource`의 Rust unavailable stub 오류다.
pub fn unavailable_indicator_source_error() -> JsError {
    unavailable_error("Indicator source registration requires the javaScript backend")
}

/// Linkable custom module 문서가 요구하는 JS backend 오류다.
pub fn unavailable_linked_module_error(name: &JsString) -> JsError {
    let prefix = JsString::from_str("Indicator module requires the javaScript backend: ");
    unavailable_error_value(concat(&[&prefix, name]))
}

/// Builtin 또는 등록된 linked factory가 아닌 indicator의 UIE 오류다.
pub fn unsupported_indicator_module(name: &JsString) -> JsError {
    let prefix = JsString::from_str("Unsupported indicator module: ");
    let shortened = name.slice(0, Some(128));
    let suffix = JsString::from_str("; requires a canonical builtin or linked factory");
    let mut error = JsError::new(
        "UnsupportedIndicatorError",
        concat(&[&prefix, &shortened, &suffix]),
    );
    error.code = Some(UNSUPPORTED_INDICATOR_MODULE.to_owned());
    error
}

fn expected_descriptor(name: &JsString) -> Option<&'static IndicatorModuleDescriptor> {
    (name == &JsString::from_str(PRESSURE_NAME)).then_some(&PRESSURE_DESCRIPTOR)
}

fn is_rust_registry_name(name: &JsString) -> bool {
    IndicatorProgram::ALL
        .iter()
        .any(|program| name == &JsString::from_str(program.name()))
}

fn is_builtin_name(name: &JsString) -> bool {
    IndicatorProgram::ALL
        .iter()
        .any(|program| program.is_builtin() && name == &JsString::from_str(program.name()))
}

fn validate_descriptor_record(value: &JsValue) -> Result<&JsObject, JsError> {
    option_record(value, DESCRIPTOR_KEYS, "Indicator module descriptor")?;
    let record =
        object(value).ok_or_else(|| type_error("Indicator module descriptor: object required"))?;
    if record.len() != DESCRIPTOR_KEYS.len() {
        return Err(type_error("Indicator module descriptor binding"));
    }
    Ok(record)
}

fn descriptor_matches(value: &JsValue, expected: &IndicatorModuleDescriptor) -> bool {
    let Some(record) = object(value) else {
        return false;
    };
    record.len() == DESCRIPTOR_KEYS.len()
        && string_field(record, "id") == Some(JsString::from_str(expected.id))
        && number_field(record, "version") == Some(expected.version as f64)
        && number_field(record, "stateVersion") == Some(expected.state_version as f64)
        && string_field(record, "exportName") == Some(JsString::from_str(expected.export_name))
        && matches!(record.get(&key_for("causal")), Some(JsValue::Bool(value)) if *value == expected.causal)
}

fn descriptor_value(expected: &IndicatorModuleDescriptor) -> JsValue {
    let mut record = JsObject::new();
    record.insert(
        key_for("id"),
        JsValue::String(JsString::from_str(expected.id)),
    );
    record.insert(key_for("version"), JsValue::Number(expected.version as f64));
    record.insert(
        key_for("stateVersion"),
        JsValue::Number(expected.state_version as f64),
    );
    record.insert(
        key_for("exportName"),
        JsValue::String(JsString::from_str(expected.export_name)),
    );
    record.insert(key_for("causal"), JsValue::Bool(expected.causal));
    JsValue::Object(record)
}

fn module_token(value: &JsValue, label: &str) -> Result<JsString, JsError> {
    let token = identifier(value, label)?.clone();
    if token.as_units().contains(&(b'@' as u16)) || token.as_units().contains(&(b'/' as u16)) {
        return Err(type_error(&format!("Indicator module {label}")));
    }
    Ok(token)
}

fn valid_module_token(value: &JsString, label: &str) -> bool {
    module_token(&JsValue::String(value.clone()), label).is_ok()
}

fn module_integer(value: &JsValue) -> Result<u64, JsError> {
    let Some(value) = number(value) else {
        return Err(type_error("Indicator module version"));
    };
    if !valid_module_integer(value) {
        return Err(type_error("Indicator module version"));
    }
    Ok(value as u64)
}

fn valid_module_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&value)
}

fn module_key(id: &JsString, version: u64) -> JsString {
    concat(&[id, &key_for("@"), &JsString::from_str(&version.to_string())])
}

fn string_field(record: &JsObject, field: &str) -> Option<JsString> {
    match record.get(&key_for(field)) {
        Some(JsValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn number_field(record: &JsObject, field: &str) -> Option<f64> {
    match record.get(&key_for(field)) {
        Some(JsValue::Number(value)) => Some(*value),
        _ => None,
    }
}

fn number(value: &JsValue) -> Option<f64> {
    match value {
        JsValue::Number(value) => Some(*value),
        _ => None,
    }
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
}

fn concat(parts: &[&JsString]) -> JsString {
    let length = parts.iter().map(|part| part.len_utf16()).sum();
    let mut output = Vec::with_capacity(length);
    for part in parts {
        output.extend_from_slice(part.as_units());
    }
    JsString::from_utf16(output)
}

fn key_for(value: &str) -> JsString {
    JsString::from_str(value)
}

fn unavailable_error(message: &str) -> JsError {
    unavailable_error_value(JsString::from_str(message))
}

fn unavailable_error_value(message: JsString) -> JsError {
    let mut error = JsError::new("UnavailableError", message);
    error.code = Some(JS_BACKEND_REQUIRED.to_owned());
    error
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
