//! 웹 actor의 params source/target 단계 호출을 동일한 Rust runtime에 연결한다.

#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;

/// 알려진 `web.params*` 단계면 runtime 결과를 돌려준다.
pub(crate) fn call(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Option<Result<JsValue, JsError>> {
    let known = matches!(
        name,
        "web.paramsSourceBegin"
            | "web.paramsSourceStep"
            | "web.paramsSourceCheck"
            | "web.paramsSourceReceive"
            | "web.paramsSourceArmWrite"
            | "web.paramsSourceCheckpoint"
            | "web.paramsSourceValidate"
            | "web.paramsSourcePrepare"
            | "web.paramsSourcePublish"
            | "web.paramsSourceStatus"
            | "web.paramsSourceAbort"
    );
    known.then(|| engine.native_runtime_call_scoped(&JsString::from_str(name), args, scope))
}
