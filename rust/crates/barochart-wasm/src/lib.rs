//! 최소 cdylib 연결부다. unsafe 메모리 접근과 ABI export는 모두 barochart-ffi에 둔다.
#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
#[used]
static KEEP_FFI_EXPORTS: fn() = barochart_ffi::wasm_link_anchor;
