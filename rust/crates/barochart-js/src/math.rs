//! 엔진마다 결과가 다른 수학 함수: `Math.log`, `Math.exp`, `Math.hypot`(설계 §6.3, 이식 지도 §3.1.1·D5).
//!
//! - 기기 빌드는 플랫폼 libm(std `f64::ln`/`exp`/`hypot`)을 쓴다. 같은 기기의 JS 백엔드인 iOS JSC와
//!   Android QuickJS가 libm을 쓰므로 비트가 같아진다(macOS JSC `Math.hypot`은 20만 건 모두 C `hypot`과 같았고,
//!   QuickJS는 소스상 C `hypot`·`exp`·`log`를 부른다).
//! - wasm32 하네스 빌드는 호스트가 주는 V8 `Math.log`/`exp`/`hypot`을 import(`env.js_log`, `env.js_exp`,
//!   `env.js_hypot`)로 부른다. V8 `Math.hypot`은 크기를 맞춘 뒤 Kahan 보정 합을 써서 libm과 다른 값을 낸다.
//!   import로 받으면 Node 오라클과의 차이에서 엔진 수학 차이가 빠지고 로직 차이만 남는다.
//! - 이 함수들의 정확한 경계값에 기대는 판정은 피한다(이식 지도 D5).

/// 기기 빌드의 구현: std가 부르는 플랫폼 libm
#[cfg(not(target_arch = "wasm32"))]
mod platform {
    /// libm `log`
    pub(super) fn js_log(x: f64) -> f64 {
        x.ln()
    }

    /// libm `exp`
    pub(super) fn js_exp(x: f64) -> f64 {
        x.exp()
    }

    /// libm `hypot`
    pub(super) fn js_hypot(a: f64, b: f64) -> f64 {
        a.hypot(b)
    }
}

/// wasm32 대조 하네스의 호스트 수학 함수 포인터를 설치한다.
///
/// 기기 빌드에는 영향이 없으며 계속 플랫폼 libm을 쓴다.
#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub fn install_wasm_math(
    log: fn(f64) -> f64,
    exp: fn(f64) -> f64,
    hypot: fn(f64, f64) -> f64,
) -> bool {
    platform::install_wasm_math(log, exp, hypot)
}

/// wasm32 하네스 빌드의 구현: FFI 계층에서 설치한 V8 수학 함수 포인터다.
/// 외부 import와 unsafe 호출은 `barochart-ffi`에만 둔다.
#[cfg(target_arch = "wasm32")]
mod platform {
    use std::sync::OnceLock;

    #[derive(Clone, Copy)]
    struct WasmMathFns {
        log: fn(f64) -> f64,
        exp: fn(f64) -> f64,
        hypot: fn(f64, f64) -> f64,
    }

    static WASM_MATH: OnceLock<WasmMathFns> = OnceLock::new();

    /// 안전한 호스트 수학 함수를 한 번 설치하며, 같은 함수의 재설치만 허용한다.
    #[doc(hidden)]
    pub fn install_wasm_math(
        log: fn(f64) -> f64,
        exp: fn(f64) -> f64,
        hypot: fn(f64, f64) -> f64,
    ) -> bool {
        let functions = WasmMathFns { log, exp, hypot };
        match WASM_MATH.set(functions) {
            Ok(()) => true,
            Err(_) => WASM_MATH.get().is_some_and(|installed| {
                std::ptr::fn_addr_eq(installed.log, log)
                    && std::ptr::fn_addr_eq(installed.exp, exp)
                    && std::ptr::fn_addr_eq(installed.hypot, hypot)
            }),
        }
    }

    fn functions() -> &'static WasmMathFns {
        WASM_MATH
            .get()
            .expect("WASM math host functions must be installed before use")
    }

    pub(super) fn js_log(x: f64) -> f64 {
        (functions().log)(x)
    }
    pub(super) fn js_exp(x: f64) -> f64 {
        (functions().exp)(x)
    }
    pub(super) fn js_hypot(a: f64, b: f64) -> f64 {
        (functions().hypot)(a, b)
    }
}

/// `Math.log(x)`(자연로그). 기기는 플랫폼 libm, wasm32는 호스트 import다.
///
/// 로그 축(`model.mjs:317`)과 휠 확대(`interaction.mjs:127`)가 쓴다.
pub fn js_log(x: f64) -> f64 {
    platform::js_log(x)
}

/// `Math.exp(x)`. 기기는 플랫폼 libm, wasm32는 호스트 import다.
///
/// 로그 축(`model.mjs:317`)과 휠 확대(`interaction.mjs:127`)가 쓴다.
pub fn js_exp(x: f64) -> f64 {
    platform::js_exp(x)
}

/// `Math.hypot(a, b)`(인자 두 개). 기기는 플랫폼 libm `hypot`, wasm32는 호스트 import다.
///
/// 핀치, 자석, 적중 판정, 자유곡선(`interaction.mjs:40,67,93,105`, `drawings.mjs:46,105,120`)이 쓴다.
/// 인자 하나 이상이 ±Infinity면 NaN이 섞여도 +Infinity다(C99 부록 F와 ECMA-262가 같다).
pub fn js_hypot(a: f64, b: f64) -> f64 {
    platform::js_hypot(a, b)
}
