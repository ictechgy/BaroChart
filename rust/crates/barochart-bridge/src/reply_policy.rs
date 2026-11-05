//! Source return order와 Rust owned reply admission coverage의 정적 census다.
//!
//! 이 표는 rollback 정책이 아니다. 각 operation이 source에서 고정 literal인지, 가변 결과인지,
//! commit 뒤 복구되는지, 또는 read 중 lazy publication을 하는지를 구분한다.

use barochart_js::json::{JsValue, JsonMode};

/// 이 census를 측정한 canonical source bundle SHA-256이다.
pub const SOURCE_BUNDLE_SHA256: &str =
    "007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512";

/// Source가 기존 intrinsic에서 돌려주는 고정 성공 literal이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixedReply {
    /// JavaScript `null`이다.
    Null,
    /// JavaScript `undefined`다. Standard JSON에서는 `null`, Lossless BCJSON에서는 `undefined`다.
    Undefined,
}

impl FixedReply {
    /// JSON mode에서 최종 ABI가 소유해야 하는 정확한 바이트다.
    pub const fn encoded(self, mode: JsonMode) -> &'static [u8] {
        match (self, mode) {
            (Self::Undefined, JsonMode::Lossless) => b"undefined",
            (Self::Null | Self::Undefined, _) => b"null",
        }
    }

    /// Handler 결과가 census literal과 일치하는지 allocation 없이 확인한다.
    pub const fn matches(self, value: &JsValue) -> bool {
        matches!(
            (self, value),
            (Self::Null, JsValue::Null) | (Self::Undefined, JsValue::Undefined)
        )
    }
}

/// 고정 reply mutator의 실제 publication admission 적용 여부다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixedReplyCoverage {
    /// 검증과 staging 뒤 실제 owned output을 확보한 다음에만 게시한다.
    Staged,
    /// 실제 reply를 첫 effect 전에 확보하되 이후 source-defined partial/lazy effect 순서를 보존한다.
    SourceOrdered,
}

/// Source-equivalent reply/publication 순서 분류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyOrder {
    /// 고정 intrinsic literal과 coverage 상태다.
    Fixed {
        /// 정확한 source literal이다.
        literal: FixedReply,
        /// 실제 admission coverage다.
        coverage: FixedReplyCoverage,
    },
    /// 가변 결과이며 source failure가 publication 전까지 원자적인 경로다.
    VariableAtomic,
    /// commit과 durable terminal receipt 뒤 응답 손실을 status로 복구하는 경로다.
    VariableRecoverable,
    /// commit/receipt/encode의 측정된 source 순서를 그대로 보존해야 하는 경로다.
    SourceOrdered,
    /// 읽기처럼 보이지만 계산/cache를 게시할 수 있는 경로다.
    ReadLazy,
    /// manifest가 명시적으로 거절하는 함수다.
    Unavailable,
}

/// 이름 하나의 정적 census 행이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplyPolicy {
    /// 함수 또는 command operation 이름이다.
    pub name: &'static str,
    /// Source-equivalent reply 순서다.
    pub order: ReplyOrder,
}

const fn fixed(
    name: &'static str,
    literal: FixedReply,
    coverage: FixedReplyCoverage,
) -> ReplyPolicy {
    ReplyPolicy {
        name,
        order: ReplyOrder::Fixed { literal, coverage },
    }
}

const fn policy(name: &'static str, order: ReplyOrder) -> ReplyPolicy {
    ReplyPolicy { name, order }
}

/// Manifest 100개 이름 전체의 reply-order census다. 이름 순서는 manifest와 같다.
pub static GLOBAL_REPLY_CENSUS: &[ReplyPolicy] = &[
    policy("nativeAccessibility", ReplyOrder::ReadLazy),
    policy("nativeAccessibilityText", ReplyOrder::ReadLazy),
    policy("nativeAddPanel", ReplyOrder::SourceOrdered),
    policy("nativeAddSeries", ReplyOrder::SourceOrdered),
    policy("nativeAnalysisDemo", ReplyOrder::Unavailable),
    policy("nativeAnalysisReload", ReplyOrder::Unavailable),
    policy("nativeApplyUnchangedDataEvents", ReplyOrder::SourceOrdered),
    policy("nativeAsyncBegin", ReplyOrder::SourceOrdered),
    policy("nativeAsyncBuffer", ReplyOrder::ReadLazy),
    policy("nativeAsyncCheck", ReplyOrder::SourceOrdered),
    policy("nativeAsyncCheckpoint", ReplyOrder::SourceOrdered),
    policy("nativeAsyncCheckpointImport", ReplyOrder::SourceOrdered),
    policy("nativeAsyncCreate", ReplyOrder::SourceOrdered),
    policy("nativeAsyncFinish", ReplyOrder::SourceOrdered),
    policy("nativeAsyncRelease", ReplyOrder::SourceOrdered),
    policy("nativeAsyncStart", ReplyOrder::SourceOrdered),
    policy("nativeAsyncStep", ReplyOrder::SourceOrdered),
    policy("nativeAsyncTargetBuffer", ReplyOrder::ReadLazy),
    policy("nativeAsyncUI", ReplyOrder::Unavailable),
    policy("nativeAsyncUIBegin", ReplyOrder::SourceOrdered),
    policy("nativeAsyncUICheck", ReplyOrder::SourceOrdered),
    policy("nativeAsyncUIImportBegin", ReplyOrder::SourceOrdered),
    policy("nativeAsyncUIImportChunk", ReplyOrder::SourceOrdered),
    policy("nativeAsyncUIImportEnd", ReplyOrder::SourceOrdered),
    policy("nativeAsyncUINext", ReplyOrder::SourceOrdered),
    policy("nativeAxesSelfTest", ReplyOrder::Unavailable),
    policy("nativeBenchmarkDigest", ReplyOrder::VariableAtomic),
    policy("nativeBenchmarkEvent", ReplyOrder::SourceOrdered),
    policy("nativeCommand", ReplyOrder::SourceOrdered),
    policy("nativeComparisonAction", ReplyOrder::Unavailable),
    policy("nativeComparisonDemo", ReplyOrder::Unavailable),
    policy("nativeComparisonReadout", ReplyOrder::Unavailable),
    policy("nativeDataAsyncBegin", ReplyOrder::SourceOrdered),
    fixed(
        "nativeDataEvent",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeDataExploration", ReplyOrder::ReadLazy),
    policy("nativeDataIngestionCommand", ReplyOrder::SourceOrdered),
    policy("nativeEcho", ReplyOrder::VariableAtomic),
    policy("nativeExtendedSelfTest", ReplyOrder::Unavailable),
    fixed(
        "nativeFit",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeGestureKind", ReplyOrder::VariableAtomic),
    policy("nativeHardeningSelfTest", ReplyOrder::Unavailable),
    policy("nativeHoverExit", ReplyOrder::SourceOrdered),
    policy("nativeIndicator", ReplyOrder::SourceOrdered),
    policy("nativeIndicatorBuffer", ReplyOrder::ReadLazy),
    policy("nativeInit", ReplyOrder::SourceOrdered),
    policy("nativeInspect", ReplyOrder::ReadLazy),
    fixed(
        "nativeKey",
        FixedReply::Undefined,
        FixedReplyCoverage::SourceOrdered,
    ),
    fixed(
        "nativeLoad",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeParamsSourceAbort", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourceArmWrite", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourceBegin", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourceCheck", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourceCheckpoint", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourcePrepare", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourcePublish", ReplyOrder::VariableRecoverable),
    policy("nativeParamsSourceReceive", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourceStatus", ReplyOrder::VariableRecoverable),
    policy("nativeParamsSourceStep", ReplyOrder::SourceOrdered),
    policy("nativeParamsSourceValidate", ReplyOrder::SourceOrdered),
    policy("nativeParamsTargetCheckpoint", ReplyOrder::SourceOrdered),
    policy("nativeParamsTargetCreate", ReplyOrder::SourceOrdered),
    policy("nativeParamsTargetDescriptor", ReplyOrder::SourceOrdered),
    policy("nativeParamsTargetDispose", ReplyOrder::Unavailable),
    policy("nativeParamsTargetStart", ReplyOrder::SourceOrdered),
    policy("nativeParamsTargetStep", ReplyOrder::SourceOrdered),
    fixed(
        "nativePointer",
        FixedReply::Undefined,
        FixedReplyCoverage::SourceOrdered,
    ),
    policy("nativePreflightWorkspace", ReplyOrder::VariableAtomic),
    policy("nativePrepareBegin", ReplyOrder::SourceOrdered),
    policy("nativePrepareCreate", ReplyOrder::SourceOrdered),
    policy("nativePublicationOrderSelfTest", ReplyOrder::Unavailable),
    policy("nativeRegisterIndicatorSource", ReplyOrder::Unavailable),
    policy("nativeReleaseDataIngestion", ReplyOrder::SourceOrdered),
    policy("nativeReleaseFrameCache", ReplyOrder::SourceOrdered),
    policy("nativeReleaseFrameCaches", ReplyOrder::SourceOrdered),
    fixed(
        "nativeRemoveSeries",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeRenderFrameJSON", ReplyOrder::ReadLazy),
    fixed(
        "nativeResize",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeSave", ReplyOrder::VariableAtomic),
    policy("nativeSaveWorkspace", ReplyOrder::VariableAtomic),
    policy("nativeSceneJSON", ReplyOrder::ReadLazy),
    policy("nativeScenePacket", ReplyOrder::ReadLazy),
    policy("nativeSelfTest", ReplyOrder::Unavailable),
    fixed(
        "nativeSetData",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    fixed(
        "nativeSetPanel",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeStudyVerification", ReplyOrder::Unavailable),
    fixed(
        "nativeTheme",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeThemeFont", ReplyOrder::VariableAtomic),
    fixed(
        "nativeTool",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    fixed(
        "nativeView",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    fixed(
        "nativeWheel",
        FixedReply::Undefined,
        FixedReplyCoverage::Staged,
    ),
    policy("nativeWorkspaceSourceAbort", ReplyOrder::SourceOrdered),
    policy("nativeWorkspaceSourceBegin", ReplyOrder::SourceOrdered),
    policy("nativeWorkspaceSourceBuffer", ReplyOrder::Unavailable),
    policy("nativeWorkspaceSourceCheck", ReplyOrder::SourceOrdered),
    policy("nativeWorkspaceSourceDispose", ReplyOrder::Unavailable),
    policy("nativeWorkspaceSourceFinish", ReplyOrder::SourceOrdered),
    policy("nativeWorkspaceSourceStep", ReplyOrder::SourceOrdered),
    policy("nativeWorkspaceTargetCreate", ReplyOrder::SourceOrdered),
    policy("nativeWorkspaceTargetDispose", ReplyOrder::Unavailable),
    policy("nativeWorkspaceTargetFinish", ReplyOrder::SourceOrdered),
];

/// `nativeCommand` 65개 operation 전체의 reply-order census다. 순서는 arity 표와 같다.
pub static COMMAND_REPLY_CENSUS: &[ReplyPolicy] = &[
    policy("compactData", ReplyOrder::SourceOrdered),
    fixed("setData", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("setColumns", FixedReply::Null, FixedReplyCoverage::Staged),
    policy("applyDataEvent", ReplyOrder::SourceOrdered),
    policy("applyDataEvents", ReplyOrder::SourceOrdered),
    policy("configureDataIngestion", ReplyOrder::SourceOrdered),
    policy("enqueueDataEvents", ReplyOrder::SourceOrdered),
    policy("drainDataEvents", ReplyOrder::SourceOrdered),
    policy("pauseDataIngestion", ReplyOrder::SourceOrdered),
    policy("resumeDataIngestion", ReplyOrder::SourceOrdered),
    policy("cancelDataEvents", ReplyOrder::SourceOrdered),
    policy("dataIngestionStats", ReplyOrder::VariableAtomic),
    policy("saveDataIngestion", ReplyOrder::VariableAtomic),
    policy("loadDataIngestion", ReplyOrder::SourceOrdered),
    policy("addPanel", ReplyOrder::SourceOrdered),
    fixed("setPanel", FixedReply::Null, FixedReplyCoverage::Staged),
    policy("setPanelOrder", ReplyOrder::SourceOrdered),
    fixed("removePanel", FixedReply::Null, FixedReplyCoverage::Staged),
    policy("addAxis", ReplyOrder::SourceOrdered),
    fixed("setAxis", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("removeAxis", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed(
        "setDrawingTarget",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    fixed(
        "setDrawingMagnet",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    fixed(
        "setCrosshairSnap",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    policy("crosshairSnapshot", ReplyOrder::ReadLazy),
    policy("crosshairValues", ReplyOrder::ReadLazy),
    policy("dataAt", ReplyOrder::ReadLazy),
    policy("addSeries", ReplyOrder::SourceOrdered),
    fixed("setSeries", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed(
        "setSeriesValues",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    fixed("removeSeries", FixedReply::Null, FixedReplyCoverage::Staged),
    policy("addIndicator", ReplyOrder::SourceOrdered),
    policy("setIndicatorParams", ReplyOrder::SourceOrdered),
    policy("setIndicatorPlacement", ReplyOrder::SourceOrdered),
    fixed(
        "removeIndicator",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    policy("indicatorValues", ReplyOrder::ReadLazy),
    policy("indicatorValueAt", ReplyOrder::ReadLazy),
    policy("registerIndicatorModule", ReplyOrder::SourceOrdered),
    policy("saveStudies", ReplyOrder::VariableAtomic),
    policy("loadStudies", ReplyOrder::SourceOrdered),
    policy("addDrawing", ReplyOrder::SourceOrdered),
    policy("positionMetrics", ReplyOrder::ReadLazy),
    fixed("editDrawing", FixedReply::Null, FixedReplyCoverage::Staged),
    policy("translateDrawings", ReplyOrder::SourceOrdered),
    policy("setDrawingsStyle", ReplyOrder::SourceOrdered),
    policy("setDrawingVisibility", ReplyOrder::SourceOrdered),
    policy("setDrawingsVisibility", ReplyOrder::SourceOrdered),
    policy("duplicateDrawing", ReplyOrder::SourceOrdered),
    policy("duplicateDrawings", ReplyOrder::SourceOrdered),
    policy("deleteDrawings", ReplyOrder::SourceOrdered),
    policy("deleteDrawing", ReplyOrder::SourceOrdered),
    fixed(
        "selectDrawing",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    policy("saveDrawings", ReplyOrder::VariableAtomic),
    fixed("loadDrawings", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("undo", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("redo", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("setTool", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("setText", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("setTheme", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("setSymbol", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed(
        "setVisibleRange",
        FixedReply::Null,
        FixedReplyCoverage::Staged,
    ),
    fixed("fit", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("zoom", FixedReply::Null, FixedReplyCoverage::Staged),
    fixed("pan", FixedReply::Null, FixedReplyCoverage::Staged),
    policy("inspect", ReplyOrder::VariableAtomic),
];

/// Global 함수 이름의 census 행을 찾는다. 정렬 표를 binary-search한다.
pub fn global_reply_policy(name: &str) -> Option<&'static ReplyPolicy> {
    GLOBAL_REPLY_CENSUS
        .binary_search_by_key(&name, |entry| entry.name)
        .ok()
        .map(|index| &GLOBAL_REPLY_CENSUS[index])
}

/// `nativeCommand` operation의 census 행을 찾는다. Source arity 순서의 작은 고정 표다.
pub fn command_reply_policy(name: &str) -> Option<&'static ReplyPolicy> {
    COMMAND_REPLY_CENSUS.iter().find(|entry| entry.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_table::COMMAND_ARITIES;
    use crate::{FUNCTIONS, FunctionStatus};

    #[test]
    fn source_hash_and_global_census_cover_the_manifest_without_unknowns() {
        assert_eq!(SOURCE_BUNDLE_SHA256.len(), 64);
        assert_eq!(GLOBAL_REPLY_CENSUS.len(), FUNCTIONS.len());
        assert!(
            GLOBAL_REPLY_CENSUS
                .windows(2)
                .all(|rows| rows[0].name < rows[1].name)
        );
        let implemented = FUNCTIONS
            .iter()
            .filter(|entry| entry.status == FunctionStatus::Implemented)
            .count();
        assert_eq!(implemented, 83);
        for (entry, reply) in FUNCTIONS.iter().zip(GLOBAL_REPLY_CENSUS) {
            assert_eq!(entry.name, reply.name);
            assert_eq!(
                reply.order == ReplyOrder::Unavailable,
                entry.status != FunctionStatus::Implemented,
                "{}",
                entry.name
            );
            assert_eq!(global_reply_policy(entry.name), Some(reply));
        }
        let staged = GLOBAL_REPLY_CENSUS
            .iter()
            .filter_map(|entry| match entry.order {
                ReplyOrder::Fixed {
                    coverage: FixedReplyCoverage::Staged,
                    ..
                } => Some(entry.name),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            staged,
            [
                "nativeDataEvent",
                "nativeFit",
                "nativeLoad",
                "nativeRemoveSeries",
                "nativeResize",
                "nativeSetData",
                "nativeSetPanel",
                "nativeTheme",
                "nativeTool",
                "nativeView",
                "nativeWheel",
            ]
        );
        let source_ordered = GLOBAL_REPLY_CENSUS
            .iter()
            .filter_map(|entry| match entry.order {
                ReplyOrder::Fixed {
                    coverage: FixedReplyCoverage::SourceOrdered,
                    ..
                } => Some(entry.name),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(source_ordered, ["nativeKey", "nativePointer"]);
    }

    #[test]
    fn command_census_covers_all_65_operations_and_every_fixed_reply_is_staged() {
        assert_eq!(COMMAND_REPLY_CENSUS.len(), 65);
        assert_eq!(COMMAND_REPLY_CENSUS.len(), COMMAND_ARITIES.len());
        for ((name, _), reply) in COMMAND_ARITIES.iter().zip(COMMAND_REPLY_CENSUS) {
            assert_eq!(*name, reply.name);
            assert_eq!(command_reply_policy(name), Some(reply));
        }
        let staged = COMMAND_REPLY_CENSUS
            .iter()
            .filter_map(|entry| match entry.order {
                ReplyOrder::Fixed {
                    coverage: FixedReplyCoverage::Staged,
                    ..
                } => Some(entry.name),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            staged,
            [
                "setData",
                "setColumns",
                "setPanel",
                "removePanel",
                "setAxis",
                "removeAxis",
                "setDrawingTarget",
                "setDrawingMagnet",
                "setCrosshairSnap",
                "setSeries",
                "setSeriesValues",
                "removeSeries",
                "removeIndicator",
                "editDrawing",
                "selectDrawing",
                "loadDrawings",
                "undo",
                "redo",
                "setTool",
                "setText",
                "setTheme",
                "setSymbol",
                "setVisibleRange",
                "fit",
                "zoom",
                "pan",
            ]
        );
        assert!(COMMAND_REPLY_CENSUS.iter().all(|entry| !matches!(
            entry.order,
            ReplyOrder::Fixed {
                coverage: FixedReplyCoverage::SourceOrdered,
                ..
            }
        )));
    }

    #[test]
    fn fixed_literals_encode_exact_standard_and_lossless_bytes() {
        assert_eq!(FixedReply::Null.encoded(JsonMode::Standard), b"null");
        assert_eq!(FixedReply::Null.encoded(JsonMode::Lossless), b"null");
        assert_eq!(FixedReply::Undefined.encoded(JsonMode::Standard), b"null");
        assert_eq!(
            FixedReply::Undefined.encoded(JsonMode::Lossless),
            b"undefined"
        );
    }
}
