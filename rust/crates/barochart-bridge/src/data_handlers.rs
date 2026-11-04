//! 소유 데이터 입력과 대상 JS 런타임의 원시 property 오류를 연결한다.

use barochart_core::Engine;
use barochart_core::data_input::{
    DataInputError, DataInputMode, NullishBase, apply_data_event_input_with_reply_gate,
    set_data_input_with_reply_gate,
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

pub(super) fn missing_store() -> JsError {
    property_error(
        NullishBase::Undefined,
        "store",
        "globalThis.nativeModel.store",
    )
}

pub(super) fn missing_drawings() -> JsError {
    property_error(
        NullishBase::Undefined,
        "drawings",
        "globalThis.nativeModel.drawings",
    )
}

pub(super) fn missing_native_model() -> JsError {
    #[cfg(target_os = "android")]
    let message = "'nativeModel' is not defined";
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let message = "Can't find variable: nativeModel";
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let message = "nativeModel is not defined";
    JsError::new("ReferenceError", JsString::from_str(message))
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
    native_set_data_with_reply_gate(engine, args, &mut || Ok(()))
}

pub(crate) fn native_set_data_with_reply_gate(
    engine: &mut Engine,
    args: &[JsValue],
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    let chart = engine.chart_mut().ok_or_else(missing_store)?;
    let mut publication = None;
    let mut explicit_fit = None;
    let committed = {
        let (model, store) = chart.fixed_reply_data_parts();
        set_data_input_with_reply_gate(
            store,
            args.first().unwrap_or(&JsValue::Undefined),
            DataInputMode::LegacyStore,
            &mut || {
                publication = Some(model.prepare_store_change_publication());
                explicit_fit = Some(model.prepare_store_change_publication());
                gate()
            },
        )
        .map_err(input_error)?
    };
    chart.commit_data_change_with_publication(committed, publication);
    let fit = chart.model().prepare_fit_with_store_publication(
        chart.data().store(),
        explicit_fit.expect("setData always publishes a reset"),
    );
    chart.model_mut().publish_prepared_view(fit);
    Ok(JsValue::Undefined)
}

pub(crate) fn native_data_event(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    native_data_event_with_reply_gate(engine, args, &mut || Ok(()))
}

pub(crate) fn native_data_event_with_reply_gate(
    engine: &mut Engine,
    args: &[JsValue],
    gate: &mut dyn FnMut() -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    let chart = engine.chart_mut().ok_or_else(missing_store)?;
    let mut publication = None;
    let committed = {
        let (model, store) = chart.fixed_reply_data_parts();
        apply_data_event_input_with_reply_gate(
            store,
            args.first().unwrap_or(&JsValue::Undefined),
            DataInputMode::LegacyStore,
            &mut || {
                publication = Some(model.prepare_store_change_publication());
                gate()
            },
        )
        .map_err(input_error)?
    };
    chart.commit_data_change_with_publication(committed, publication);
    Ok(JsValue::Undefined)
}
