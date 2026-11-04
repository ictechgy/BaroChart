//! 소유 데이터 입력과 대상 JS 런타임의 원시 property 오류를 연결한다.

use barochart_core::Engine;
use barochart_core::data_input::{
    DataInputError, DataInputMode, NullishBase, apply_data_event_input, set_data_input,
};
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::string::JsString;

fn property_error(base: NullishBase, _property: &str, _expression: &str) -> JsError {
    let base = match base {
        NullishBase::Null => "null",
        NullishBase::Undefined => "undefined",
    };
    #[cfg(target_os = "android")]
    let message = format!("cannot read property '{_property}' of {base}");
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let message = format!("{base} is not an object (evaluating '{_expression}')");
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let message = format!("Cannot read properties of {base} (reading '{_property}')");
    JsError::new("TypeError", JsString::from_str(&message))
}

fn missing_store() -> JsError {
    property_error(
        NullishBase::Undefined,
        "store",
        "globalThis.nativeModel.store",
    )
}

pub(super) fn input_error(error: DataInputError) -> JsError {
    match error {
        DataInputError::Js(error) => error,
        DataInputError::NullishPropertyAccess {
            base,
            property,
            expression,
        } => property_error(base, property, expression),
    }
}

pub(super) fn missing_native_api() -> JsError {
    #[cfg(target_os = "android")]
    let message = "'nativeAPI' is not defined";
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let message = "Can't find variable: nativeAPI";
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let message = "nativeAPI is not defined";
    JsError::new("ReferenceError", JsString::from_str(message))
}

pub(crate) fn native_set_data(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let data = engine.data_state_mut().ok_or_else(missing_store)?;
    set_data_input(
        data.store_mut(),
        args.first().unwrap_or(&JsValue::Undefined),
        DataInputMode::LegacyStore,
    )
    .map_err(input_error)?;
    // M4가 같은 commit에 view/indicator/model 내부 invalidation을 연결한다.
    Ok(JsValue::Undefined)
}

pub(crate) fn native_data_event(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let data = engine.data_state_mut().ok_or_else(missing_store)?;
    apply_data_event_input(
        data.store_mut(),
        args.first().unwrap_or(&JsValue::Undefined),
        DataInputMode::LegacyStore,
    )
    .map_err(input_error)?;
    Ok(JsValue::Undefined)
}
