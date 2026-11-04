//! 데이터 command와 ingestion 봉투를 같은 엔진 소유자에 전달한다.

use barochart_core::Engine;
use barochart_core::data_input::{
    DataInputMode, apply_data_event_input, set_columns_input, set_data_input,
};
use barochart_core::ingestion::{ApplyDataError, IngestionError, IngestionOwner};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

use super::command_table::COMMAND_ARITIES;
use super::data_handlers::{input_error, missing_native_api};

fn text(value: &JsValue, expected: &str) -> bool {
    matches!(value,JsValue::String(value) if value.as_units().iter().copied().eq(expected.encode_utf16()))
}
fn error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
fn ingestion_error(error: IngestionError) -> JsError {
    JsError {
        name: "IngestionError",
        message: error.message().clone(),
        code: Some(error.code().to_owned()),
    }
}
fn apply_error(error: ApplyDataError) -> JsError {
    match error {
        ApplyDataError::Store(error) => error,
        ApplyDataError::Ingestion(error) => ingestion_error(error),
    }
}
fn ingestion_op(operation: &str) -> bool {
    matches!(
        operation,
        "configureDataIngestion"
            | "enqueueDataEvents"
            | "drainDataEvents"
            | "pauseDataIngestion"
            | "resumeDataIngestion"
            | "cancelDataEvents"
            | "dataIngestionStats"
            | "saveDataIngestion"
            | "loadDataIngestion"
    )
}
fn operation(value: Option<&JsValue>) -> Option<(&'static str, usize)> {
    let value = value?;
    COMMAND_ARITIES
        .iter()
        .copied()
        .find(|(name, _)| text(value, name))
}
fn arguments(value: Option<&JsValue>) -> Result<&[JsValue], JsError> {
    match value {
        None | Some(JsValue::Undefined) => Ok(&[]),
        Some(JsValue::Array(args)) => Ok(args),
        _ => Err(error("Unknown chart command or argument list")),
    }
}
fn run_ingestion(
    owner: &mut IngestionOwner,
    operation: &str,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    let result = match operation {
        "configureDataIngestion" => owner.configure(args.first().unwrap_or(&JsValue::Undefined)),
        "enqueueDataEvents" => owner.enqueue(args.first().unwrap_or(&JsValue::Undefined)),
        "drainDataEvents" => owner
            .drain(args.first(), false)
            .map(|value| value.to_value()),
        "pauseDataIngestion" => owner.pause(),
        "resumeDataIngestion" => owner.resume(),
        "cancelDataEvents" => owner.cancel().map(|value| value.to_value()),
        "dataIngestionStats" => owner.stats(),
        "saveDataIngestion" => owner.save().map(JsValue::String),
        "loadDataIngestion" => owner.load(args.first().unwrap_or(&JsValue::Undefined)),
        _ => return Err(error("Unknown ingestion command")),
    };
    result.map_err(ingestion_error)
}
fn dispatch(
    owner: &mut IngestionOwner,
    operation: &str,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    if ingestion_op(operation) {
        return run_ingestion(owner, operation, args);
    }
    let undefined = JsValue::Undefined;
    let input = args.first().unwrap_or(&undefined);
    match operation {
        "setData" => {
            set_data_input(
                owner.data_mut().store_mut(),
                input,
                DataInputMode::ApiFacade,
            )
            .map_err(input_error)?;
            Ok(JsValue::Null)
        }
        "setColumns" => {
            set_columns_input(
                owner.data_mut().store_mut(),
                input,
                args.get(1),
                DataInputMode::ApiFacade,
            )
            .map_err(input_error)?;
            Ok(JsValue::Null)
        }
        "applyDataEvents" => owner
            .apply_data_events(input, false)
            .map(|value| value.value.to_js_value())
            .map_err(apply_error),
        "applyDataEvent" => {
            let batch = matches!(input,JsValue::Object(o) if o.get(&JsString::from_str("kind")).is_some_and(|kind|text(kind,"batch")));
            if batch {
                let JsValue::Object(object) = input else {
                    unreachable!()
                };
                owner
                    .apply_data_events(
                        object
                            .get(&JsString::from_str("events"))
                            .unwrap_or(&JsValue::Undefined),
                        false,
                    )
                    .map(|value| value.value.to_js_value())
                    .map_err(apply_error)
            } else {
                apply_data_event_input(
                    owner.data_mut().store_mut(),
                    input,
                    DataInputMode::ApiFacade,
                )
                .map_err(input_error)?;
                Ok(JsValue::Null)
            }
        }
        _ => Err(JsError::new(
            "UnavailableError",
            JsString::from_str("nativeCommand is not available in the Rust backend"),
        )),
    }
}

pub(crate) fn native_command(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let owner = engine
        .ingestion_owner_mut()
        .ok_or_else(missing_native_api)?;
    let (operation, arity) =
        operation(args.first()).ok_or_else(|| error("Unknown chart command or argument list"))?;
    let arguments = arguments(args.get(1))?;
    if arguments.len() > arity {
        return Err(error("Chart command argument count"));
    }
    dispatch(owner, operation, arguments)
}

pub(crate) fn native_ingestion_command(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    let (operation, arity) = operation(args.first())
        .filter(|(name, _)| ingestion_op(name))
        .ok_or_else(|| error("Unknown ingestion command"))?;
    let result = (|| {
        let owner = engine
            .ingestion_owner_mut()
            .ok_or_else(missing_native_api)?;
        let arguments = arguments(args.get(1))?;
        if arguments.len() > arity {
            return Err(error("Chart command argument count"));
        }
        run_ingestion(owner, operation, arguments)
    })();
    let mut envelope = JsObject::new();
    match result {
        Ok(result) => envelope.insert(JsString::from_str("result"), result),
        Err(error) => {
            let mut detail = JsObject::new();
            detail.insert(
                JsString::from_str("name"),
                JsValue::String(JsString::from_str("IngestionError")),
            );
            let code = error
                .code
                .as_deref()
                .filter(|_| error.name == "IngestionError")
                .unwrap_or(if operation == "loadDataIngestion" {
                    "INVALID_DOCUMENT"
                } else {
                    "INVALID_INPUT"
                });
            detail.insert(
                JsString::from_str("code"),
                JsValue::String(JsString::from_str(code)),
            );
            detail.insert(
                JsString::from_str("message"),
                JsValue::String(error.message.slice(0, Some(256))),
            );
            envelope.insert(JsString::from_str("error"), JsValue::Object(detail));
        }
    }
    Ok(JsValue::Object(envelope))
}

pub(crate) fn native_unchanged(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let owner = engine
        .ingestion_owner_mut()
        .ok_or_else(|| error("Native batch own data required"))?;
    owner
        .native_apply_unchanged_data_events(args.first().unwrap_or(&JsValue::Undefined))
        .map_err(apply_error)
}
