//! JS 번들의 초기 100개 함수 이름과 단계별 구현 상태다.

use super::{
    FunctionEntry, FunctionStatus, native_command, native_data_event, native_echo,
    native_ingestion_command, native_init, native_set_data, native_unchanged, params_abort,
    reject_source, release_ingestion, release_true, workspace_abort,
};

/// 함수 조회와 supports가 함께 쓰는 단일 표다.
pub static FUNCTIONS: &[FunctionEntry] = &[
    FunctionEntry {
        name: "nativeAccessibility",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAccessibilityText",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAddPanel",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAddSeries",
        status: FunctionStatus::Pending,
        handler: None,
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
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncBuffer",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncCheck",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncCheckpoint",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncCheckpointImport",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncCreate",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncFinish",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncRelease",
        status: FunctionStatus::Implemented,
        handler: Some(release_true),
    },
    FunctionEntry {
        name: "nativeAsyncStart",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncStep",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncTargetBuffer",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUI",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUIBegin",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUICheck",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUIImportBegin",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUIImportChunk",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUIImportEnd",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAsyncUINext",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeAxesSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeBenchmarkDigest",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeBenchmarkEvent",
        status: FunctionStatus::Pending,
        handler: None,
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
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeDataEvent",
        status: FunctionStatus::Implemented,
        handler: Some(native_data_event),
    },
    FunctionEntry {
        name: "nativeDataExploration",
        status: FunctionStatus::Pending,
        handler: None,
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
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeGestureKind",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeHardeningSelfTest",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeHoverExit",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeIndicator",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeIndicatorBuffer",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeInit",
        status: FunctionStatus::Implemented,
        handler: Some(native_init),
    },
    FunctionEntry {
        name: "nativeInspect",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeKey",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeLoad",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceAbort",
        status: FunctionStatus::Implemented,
        handler: Some(params_abort),
    },
    FunctionEntry {
        name: "nativeParamsSourceArmWrite",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceBegin",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceCheck",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceCheckpoint",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourcePrepare",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourcePublish",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceReceive",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceStatus",
        status: FunctionStatus::Implemented,
        handler: Some(params_abort),
    },
    FunctionEntry {
        name: "nativeParamsSourceStep",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsSourceValidate",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetCheckpoint",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetCreate",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetDescriptor",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetDispose",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetStart",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeParamsTargetStep",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativePointer",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativePreflightWorkspace",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativePrepareBegin",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativePrepareCreate",
        status: FunctionStatus::Pending,
        handler: None,
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
        handler: Some(release_ingestion),
    },
    FunctionEntry {
        name: "nativeReleaseFrameCache",
        status: FunctionStatus::Implemented,
        handler: Some(release_true),
    },
    FunctionEntry {
        name: "nativeReleaseFrameCaches",
        status: FunctionStatus::Implemented,
        handler: Some(release_true),
    },
    FunctionEntry {
        name: "nativeRemoveSeries",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeRenderFrameJSON",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeResize",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeSave",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeSaveWorkspace",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeSceneJSON",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeScenePacket",
        status: FunctionStatus::Pending,
        handler: None,
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
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeStudyVerification",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeTheme",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeThemeFont",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeTool",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeView",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWheel",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceAbort",
        status: FunctionStatus::Implemented,
        handler: Some(workspace_abort),
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceBegin",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceBuffer",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceCheck",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceDispose",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceFinish",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceSourceStep",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceTargetCreate",
        status: FunctionStatus::Pending,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceTargetDispose",
        status: FunctionStatus::Reject,
        handler: None,
    },
    FunctionEntry {
        name: "nativeWorkspaceTargetFinish",
        status: FunctionStatus::Pending,
        handler: None,
    },
];
