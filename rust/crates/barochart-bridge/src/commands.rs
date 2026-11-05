//! 데이터 command와 ingestion 봉투를 같은 엔진 소유자에 전달한다.

use barochart_core::Engine;
use barochart_core::chart_api::ChartApi;
use barochart_core::ingestion::{ApplyDataError, IngestionError};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;

use super::command_table::COMMAND_ARITIES;
use super::data_handlers::missing_native_api;
use super::reply_policy::FixedReply;

fn text(value: &JsValue, expected: &str) -> bool {
    matches!(value,JsValue::String(value) if value.as_units().iter().copied().eq(expected.encode_utf16()))
}
fn error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
fn ingestion_error(error: IngestionError) -> JsError {
    error.into_js_error()
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
pub(crate) fn dispatch(
    engine: &mut Engine,
    operation: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    dispatch_with_reply_admission(engine, operation, args, scope, &mut |_| Ok(()))
}

pub(crate) fn dispatch_with_reply_admission(
    engine: &mut Engine,
    operation: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    if let Some(result) =
        super::input_handlers::command_with_reply_admission(engine, operation, args, admit_reply)
    {
        return result;
    }
    let (chart, input, host, width, height) =
        engine.command_parts_mut().ok_or_else(missing_native_api)?;
    ChartApi::with_controller(chart, input, host, width, height)
        .dispatch_scoped_with_fixed_reply_admission(
            &JsString::from_str(operation),
            args,
            scope,
            &mut || admit_reply(FixedReply::Null),
        )
}

pub(crate) fn native_command(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    native_command_scoped(engine, args, &mut scope)
}

pub(crate) fn native_command_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    native_command_scoped_with_reply_admission(engine, args, scope, &mut |_| Ok(()))
}

pub(crate) fn native_command_scoped_with_reply_admission(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    if engine.chart().is_none() {
        return Err(missing_native_api());
    }
    let (operation, arity) =
        operation(args.first()).ok_or_else(|| error("Unknown chart command or argument list"))?;
    let arguments = arguments(args.get(1))?;
    if arguments.len() > arity {
        return Err(error("Chart command argument count"));
    }
    dispatch_with_reply_admission(engine, operation, arguments, scope, admit_reply)
}

pub(crate) fn native_ingestion_command(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    native_ingestion_command_scoped(engine, args, &mut scope)
}

pub(crate) fn native_ingestion_command_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let (operation, arity) = operation(args.first())
        .filter(|(name, _)| ingestion_op(name))
        .ok_or_else(|| error("Unknown ingestion command"))?;
    let result = (|| {
        if engine.chart().is_none() {
            return Err(missing_native_api());
        }
        let arguments = arguments(args.get(1))?;
        if arguments.len() > arity {
            return Err(error("Chart command argument count"));
        }
        dispatch(engine, operation, arguments, scope)
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
    let chart = engine
        .chart_mut()
        .ok_or_else(|| error("Native batch own data required"))?;
    let external_values = chart
        .model()
        .series
        .iter()
        .any(|series| series.values.is_some());
    let committed = chart
        .ingestion_owner_mut()
        .native_apply_unchanged_data_events_committed(
            args.first().unwrap_or(&JsValue::Undefined),
            external_values,
        )
        .map_err(apply_error)?;
    Ok(chart.commit_data_change(committed))
}
