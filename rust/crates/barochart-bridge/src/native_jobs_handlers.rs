//! 같은 Engine native runtime의 실제 job 봉투를 호출한다.
use barochart_core::Engine;
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::string::JsString;
pub(crate) fn native_async_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncBegin"), args)
}
pub(crate) fn native_prepare_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativePrepareBegin"), args)
}
pub(crate) fn native_data_async_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeDataAsyncBegin"), args)
}
pub(crate) fn native_release_data_ingestion(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeReleaseDataIngestion"), args)
}
pub(crate) fn native_prepare_create(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativePrepareCreate"), args)
}
pub(crate) fn native_workspace_target_create(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceTargetCreate"), args)
}
pub(crate) fn native_workspace_target_finish(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceTargetFinish"), args)
}
pub(crate) fn native_workspace_source_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceSourceBegin"), args)
}
pub(crate) fn native_workspace_source_step(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceSourceStep"), args)
}
pub(crate) fn native_workspace_source_check(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceSourceCheck"), args)
}
pub(crate) fn native_workspace_source_finish(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceSourceFinish"), args)
}
pub(crate) fn native_workspace_source_abort(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeWorkspaceSourceAbort"), args)
}
pub(crate) fn native_async_check(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncCheck"), args)
}
pub(crate) fn native_async_checkpoint(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncCheckpoint"), args)
}
pub(crate) fn native_async_u_i_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncUIBegin"), args)
}
pub(crate) fn native_async_u_i_next(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncUINext"), args)
}
pub(crate) fn native_async_u_i_check(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncUICheck"), args)
}
pub(crate) fn native_async_release(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncRelease"), args)
}
pub(crate) fn native_async_create(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncCreate"), args)
}
pub(crate) fn native_async_checkpoint_import(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncCheckpointImport"), args)
}
pub(crate) fn native_async_start(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncStart"), args)
}
pub(crate) fn native_async_step(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncStep"), args)
}
pub(crate) fn native_async_u_i_import_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncUIImportBegin"), args)
}
pub(crate) fn native_async_u_i_import_chunk(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncUIImportChunk"), args)
}
pub(crate) fn native_async_u_i_import_end(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncUIImportEnd"), args)
}
pub(crate) fn native_async_finish(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeAsyncFinish"), args)
}
pub(crate) fn native_params_source_begin(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceBegin"), args)
}
pub(crate) fn native_params_source_step(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceStep"), args)
}
pub(crate) fn native_params_source_check(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceCheck"), args)
}
pub(crate) fn native_params_source_receive(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceReceive"), args)
}
pub(crate) fn native_params_source_arm_write(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceArmWrite"), args)
}
pub(crate) fn native_params_source_checkpoint(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceCheckpoint"), args)
}
pub(crate) fn native_params_source_validate(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceValidate"), args)
}
pub(crate) fn native_params_source_prepare(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourcePrepare"), args)
}
pub(crate) fn native_params_source_publish(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourcePublish"), args)
}
pub(crate) fn native_params_source_status(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceStatus"), args)
}
pub(crate) fn native_params_source_abort(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsSourceAbort"), args)
}
pub(crate) fn native_params_target_create(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsTargetCreate"), args)
}
pub(crate) fn native_params_target_start(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsTargetStart"), args)
}
pub(crate) fn native_params_target_step(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsTargetStep"), args)
}
pub(crate) fn native_params_target_descriptor(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsTargetDescriptor"), args)
}
pub(crate) fn native_params_target_checkpoint(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.native_runtime_call(&JsString::from_str("nativeParamsTargetCheckpoint"), args)
}
