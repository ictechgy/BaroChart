//! WASM actor의 workspace/UI migration namespace 연결부다.

#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;

/// 검증된 `web.migration*` 이름을 실제 engine runtime에 전달한다.
pub(crate) fn call(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    engine.native_runtime_call_scoped(&JsString::from_str(name), args, scope)
}
