//! BaroChart Rust 코어의 JS 의미 커널.
//!
//! 이식한 코어(`barochart-core`)가 JS 백엔드와 비트·바이트 단위로 같은 결과를 내도록,
//! ECMAScript 의미를 그대로 따르는 기본 연산을 이 크레이트 한곳에 모은다.
//! 앞으로 들어올 모듈은 다음과 같다(설계 §6.4, 이식 지도 §3.1).
//!
//! - `num`, `math`: `Number#toString`, `toFixed`/`toPrecision`/`toExponential`,
//!   `Math.round`/`min`/`max`/`sign`, 정수 변환, 엔진마다 다른 `log`/`exp`/`hypot`
//! - `string`: UTF-16 코드 단위로 세는 WTF-16 문자열과 JS 공백 표
//! - `json`: 키 순서를 보존하는 `JsValue`와 손으로 쓴 파서·writer(무손실 모드 포함)
//! - `date`, `error`: `Date.UTC`, `toISOString`, 엄격한 ISO 파서, 오류 값
//!
//! 이식 코드는 Rust 표준의 실수 포맷(`{:.N}`·`{:e}`)과 `f64::min`/`max`/`round`/`signum`,
//! `str::trim` 대신 이 커널을 부른다. 이 규칙은 `scripts/rust/check-bans.mjs`가 CI에서 검사한다.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
