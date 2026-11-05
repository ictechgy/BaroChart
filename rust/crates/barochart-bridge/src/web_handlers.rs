//! WebAssembly 전용 표시 조회와 비동기 작업의 namespace다.

#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::MemoryScope;

use crate::reply_policy::FixedReply;

/// 버전이 붙은 `web.*` 조회와 명시한 작업 alias를 분기한다.
pub(crate) fn call(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    if let Some(result) = super::web_params_handlers::call(engine, name, args, scope) {
        return result;
    }
    match name {
        "web.migrationSourceBegin"
        | "web.migrationSourceStep"
        | "web.migrationSourceUiBegin"
        | "web.migrationSourceUiNext"
        | "web.migrationSourceCheck"
        | "web.migrationSourceFinish"
        | "web.migrationSourceAbort"
        | "web.migrationTargetCreate"
        | "web.migrationTargetStart"
        | "web.migrationTargetStep"
        | "web.migrationTargetUiBegin"
        | "web.migrationTargetUiChunk"
        | "web.migrationTargetUiFinish"
        | "web.migrationTargetAbort" => {
            super::web_migration_handlers::call(engine, name, args, scope)
        }
        "web.layoutCapture" | "web.applyLayoutFrame" => {
            super::web_layout_handlers::call(engine, name, args, scope, admit_reply)
        }
        "web.capabilities" => barochart_core::web::capabilities(scope),
        "web.presentationState" => {
            barochart_core::web::presentation_state(engine.chart(), engine.input(), scope)
        }
        "web.configuration" => barochart_core::web::configuration(engine.chart(), scope),
        "web.drawingsState" => barochart_core::web::drawings_state(engine.chart(), scope),
        "web.indicatorCatalog" => barochart_core::web::indicator_catalog(engine.chart(), scope),
        "web.layoutReferences" => {
            barochart_core::web::layout_references(engine.chart(), engine.input(), scope)
        }
        _ => Err(JsError::new(
            "UnavailableError",
            barochart_js::string::JsString::from_str("Unknown web query"),
        )),
    }
}
