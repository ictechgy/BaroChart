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

/// wasm32 하네스 빌드의 구현: 호스트(Node) import. 커널에서 `unsafe`를 허용하는 유일한 곳이다(lib.rs 참고).
///
/// 함수는 `safe`로 선언한다. f64를 받아 f64를 돌려주는 순수 함수라 호출하는 쪽이 지킬 조건이 없다.
#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod platform {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        /// 호스트의 `Math.log`
        pub(super) safe fn js_log(x: f64) -> f64;
        /// 호스트의 `Math.exp`
        pub(super) safe fn js_exp(x: f64) -> f64;
        /// 호스트의 `Math.hypot(a, b)`
        pub(super) safe fn js_hypot(a: f64, b: f64) -> f64;
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
