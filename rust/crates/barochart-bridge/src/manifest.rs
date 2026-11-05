//! JS 번들의 초기 100개 함수 이름과 단계별 구현 상태다.

use super::{
    FunctionEntry, FunctionStatus, native_command, native_data_event, native_echo,
    native_ingestion_command, native_init, native_set_data, native_unchanged, reject_source,
};

/// 함수 조회와 supports가 함께 쓰는 단일 표다.
pub static FUNCTIONS: &[FunctionEntry] = &[
    FunctionEntry {
        name: "nativeAccessibility",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::accessibility),
    },
    FunctionEntry {
        name: "nativeAccessibilityText",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::accessibility_text),
    },
    FunctionEntry {
        name: "nativeAddPanel",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::add_panel),
    },
    FunctionEntry {
        name: "nativeAddSeries",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::add_series),
    },
    FunctionEntry {
        name: "nativeAnalysisDemo",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAnalysisReload",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeApplyUnchangedDataEvents",
        status: FunctionStatus::Implemented,
        handler: Some(native_unchanged),
    },
    FunctionEntry {
        name: "nativeAsyncBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_begin),
    },
    FunctionEntry {
        name: "nativeAsyncBuffer",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_async_buffer),
    },
    FunctionEntry {
        name: "nativeAsyncCheck",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_check),
    },
    FunctionEntry {
        name: "nativeAsyncCheckpoint",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_checkpoint),
    },
    FunctionEntry {
        name: "nativeAsyncCheckpointImport",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_checkpoint_import),
    },
    FunctionEntry {
        name: "nativeAsyncCreate",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_create),
    },
    FunctionEntry {
        name: "nativeAsyncFinish",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_finish),
    },
    FunctionEntry {
        name: "nativeAsyncRelease",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_release),
    },
    FunctionEntry {
        name: "nativeAsyncStart",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_start),
    },
    FunctionEntry {
        name: "nativeAsyncStep",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_step),
    },
    FunctionEntry {
        name: "nativeAsyncTargetBuffer",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_target_buffer),
    },
    FunctionEntry {
        name: "nativeAsyncUI",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUIBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_u_i_begin),
    },
    FunctionEntry {
        name: "nativeAsyncUICheck",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_u_i_check),
    },
    FunctionEntry {
        name: "nativeAsyncUIImportBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_u_i_import_begin),
    },
    FunctionEntry {
        name: "nativeAsyncUIImportChunk",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_u_i_import_chunk),
    },
    FunctionEntry {
        name: "nativeAsyncUIImportEnd",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_u_i_import_end),
    },
    FunctionEntry {
        name: "nativeAsyncUINext",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_async_u_i_next),
    },
    FunctionEntry {
        name: "nativeAxesSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeBenchmarkDigest",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::benchmark_digest),
    },
    FunctionEntry {
        name: "nativeBenchmarkEvent",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::benchmark_event),
    },
    FunctionEntry {
        name: "nativeCommand",
        status: FunctionStatus::Implemented,
        handler: Some(native_command),
    },
    FunctionEntry {
        name: "nativeComparisonAction",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeComparisonDemo",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeComparisonReadout",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeDataAsyncBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_data_async_begin),
    },
    FunctionEntry {
        name: "nativeDataEvent",
        status: FunctionStatus::Implemented,
        handler: Some(native_data_event),
    },
    FunctionEntry {
        name: "nativeDataExploration",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::data_exploration),
    },
    FunctionEntry {
        name: "nativeDataIngestionCommand",
        status: FunctionStatus::Implemented,
        handler: Some(native_ingestion_command),
    },
    FunctionEntry {
        name: "nativeEcho",
        status: FunctionStatus::Implemented,
        handler: Some(native_echo),
    },
    FunctionEntry {
        name: "nativeExtendedSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeFit",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::fit),
    },
    FunctionEntry {
        name: "nativeGestureKind",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::gesture_kind),
    },
    FunctionEntry {
        name: "nativeHardeningSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeHoverExit",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::hover_exit),
    },
    FunctionEntry {
        name: "nativeIndicator",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::indicator),
    },
    FunctionEntry {
        name: "nativeIndicatorBuffer",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_indicator_buffer),
    },
    FunctionEntry {
        name: "nativeInit",
        status: FunctionStatus::Implemented,
        handler: Some(native_init),
    },
    FunctionEntry {
        name: "nativeInspect",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::inspect),
    },
    FunctionEntry {
        name: "nativeKey",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::key),
    },
    FunctionEntry {
        name: "nativeLoad",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::load),
    },
    FunctionEntry {
        name: "nativeParamsSourceAbort",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_abort),
    },
    FunctionEntry {
        name: "nativeParamsSourceArmWrite",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_arm_write),
    },
    FunctionEntry {
        name: "nativeParamsSourceBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_begin),
    },
    FunctionEntry {
        name: "nativeParamsSourceCheck",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_check),
    },
    FunctionEntry {
        name: "nativeParamsSourceCheckpoint",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_checkpoint),
    },
    FunctionEntry {
        name: "nativeParamsSourcePrepare",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_prepare),
    },
    FunctionEntry {
        name: "nativeParamsSourcePublish",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_publish),
    },
    FunctionEntry {
        name: "nativeParamsSourceReceive",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_receive),
    },
    FunctionEntry {
        name: "nativeParamsSourceStatus",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_status),
    },
    FunctionEntry {
        name: "nativeParamsSourceStep",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_step),
    },
    FunctionEntry {
        name: "nativeParamsSourceValidate",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_source_validate),
    },
    FunctionEntry {
        name: "nativeParamsTargetCheckpoint",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_target_checkpoint),
    },
    FunctionEntry {
        name: "nativeParamsTargetCreate",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_target_create),
    },
    FunctionEntry {
        name: "nativeParamsTargetDescriptor",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_target_descriptor),
    },
    FunctionEntry {
        name: "nativeParamsTargetDispose",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetStart",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_target_start),
    },
    FunctionEntry {
        name: "nativeParamsTargetStep",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_params_target_step),
    },
    FunctionEntry {
        name: "nativePointer",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::pointer),
    },
    FunctionEntry {
        name: "nativePreflightWorkspace",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::preflight_workspace),
    },
    FunctionEntry {
        name: "nativePrepareBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_prepare_begin),
    },
    FunctionEntry {
        name: "nativePrepareCreate",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_prepare_create),
    },
    FunctionEntry {
        name: "nativePublicationOrderSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeRegisterIndicatorSource",
        status: FunctionStatus::Reject,
        handler: Some(reject_source),
    },
    FunctionEntry {
        name: "nativeReleaseDataIngestion",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_release_data_ingestion),
    },
    FunctionEntry {
        name: "nativeReleaseFrameCache",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::release_frame_cache),
    },
    FunctionEntry {
        name: "nativeReleaseFrameCaches",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::release_frame_caches),
    },
    FunctionEntry {
        name: "nativeRemoveSeries",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::remove_series),
    },
    FunctionEntry {
        name: "nativeRenderFrameJSON",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::render_frame_json),
    },
    FunctionEntry {
        name: "nativeResize",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::resize),
    },
    FunctionEntry {
        name: "nativeSave",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::save),
    },
    FunctionEntry {
        name: "nativeSaveWorkspace",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::save_workspace),
    },
    FunctionEntry {
        name: "nativeSceneJSON",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::scene_json),
    },
    FunctionEntry {
        name: "nativeScenePacket",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_scene_packet),
    },
    FunctionEntry {
        name: "nativeSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeSetData",
        status: FunctionStatus::Implemented,
        handler: Some(native_set_data),
    },
    FunctionEntry {
        name: "nativeSetPanel",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::set_panel),
    },
    FunctionEntry {
        name: "nativeStudyVerification",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeTheme",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::theme),
    },
    FunctionEntry {
        name: "nativeThemeFont",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::theme_font),
    },
    FunctionEntry {
        name: "nativeTool",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::tool),
    },
    FunctionEntry {
        name: "nativeView",
        status: FunctionStatus::Implemented,
        handler: Some(super::chart_handlers::view),
    },
    FunctionEntry {
        name: "nativeWheel",
        status: FunctionStatus::Implemented,
        handler: Some(super::input_handlers::wheel),
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceAbort",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_source_abort),
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceBegin",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_source_begin),
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceBuffer",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceCheck",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_source_check),
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceDispose",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceFinish",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_source_finish),
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceStep",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_source_step),
    },
    FunctionEntry {
        name: "nativeWorkspaceTargetCreate",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_target_create),
    },
    FunctionEntry {
        name: "nativeWorkspaceTargetDispose",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceTargetFinish",
        status: FunctionStatus::Implemented,
        handler: Some(super::native_jobs_handlers::native_workspace_target_finish),
    },
];
