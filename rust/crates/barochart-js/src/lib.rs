//! BaroChart Rust 코어의 JS 의미 커널.
//!
//! 이식한 코어(`barochart-core`)가 JS 백엔드와 비트·바이트 단위로 같은 결과를 내도록,
//! ECMAScript 의미를 그대로 따르는 기본 연산을 이 크레이트 한곳에 모은다(설계 §6.4, 이식 지도 §3.1).
//!
//! - `num`: `Number#toString`, `toFixed`/`toPrecision`/`toExponential`,
//!   `Math.round`/`min`/`max`/`sign`, `ToInt32`/`ToUint32`, `Object.is`
//! - `math`: 엔진마다 다른 `Math.log`/`exp`/`hypot`(기기는 플랫폼 libm, wasm32는 호스트 import)
//! - `string`: UTF-16 코드 단위로 세는 WTF-16 문자열(`JsString`)과 JS 공백 표
//! - `json`: 키 순서를 보존하는 `JsValue`·`JsObject`와 손으로 쓴 파서·writer(무손실 모드 포함, 재귀 없음)
//! - `date`: `Date.UTC`, TimeClip, `toISOString`, 그레고리력 변환, M0 시간대 계약의 엄격한 ISO 파서
//! - `error`: JS 오류 값(`JsError`: 이름, 메시지, 코드)
//!
//! 이식 코드는 Rust 표준의 실수 포맷(`{:.N}`·`{:e}`)과 `f64::min`/`max`/`round`/`signum`,
//! `str::trim`, serde 대신 이 커널을 부른다. 이 규칙은 `scripts/rust/check-bans.mjs`가 CI에서 검사한다.
//!
//! `unsafe`: 기기 타깃(iOS·macOS·Android)에서는 `forbid`다. wasm32 하네스 빌드만 `deny`로 두고,
//! `math`의 호스트 import 블록 하나에서만 허용한다. Rust 2024에서 외부 함수 선언은 `unsafe extern`
//! 블록이어야 하고, `forbid`는 안쪽에서 다시 허용할 수 없기 때문이다. 출하 바이너리에는 이 블록이 들어가지 않는다.

#![cfg_attr(not(target_arch = "wasm32"), forbid(unsafe_code))]
#![cfg_attr(target_arch = "wasm32", deny(unsafe_code))]
#![warn(missing_docs)]

pub mod date;
pub mod error;
pub mod json;
pub mod math;
pub mod num;
pub mod string;
