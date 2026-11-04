//! 키 순서를 보존하는 JS 값과 손으로 쓴 JSON 파서·writer(설계 §6.4, §7.1~7.2, 이식 지도 §3.1.3).
//!
//! serde·serde_json은 쓰지 않는다. 기본 동작이 `JSON.parse`·`JSON.stringify`와 다르기 때문이다: 중복 키,
//! `1e400`, 단독 서로게이트, 재귀 한도(128), 객체 키 순서, `-0`과 비유한 수(설계 §7.2).
//!
//! - `JsValue`: `undefined`를 포함한 JS 값. 수는 -0·NaN·±Infinity를, 문자열은 단독 서로게이트를 담는다.
//! - `JsObject`: JS 자기 키 순서(배열 인덱스 키 오름차순, 나머지는 삽입 순서)를 지키는 객체.
//! - `parse_json`(UTF-8 바이트)·`parse_json_utf16`(JS 문자열의 WTF-16 코드 단위)·`stringify_json`: 반복 구현이라
//!   중첩 깊이와 무관하게 스레드 스택을 일정하게 쓴다.
//!   값의 해제·복제도 반복이다(`value` 모듈 참고).
//! - `JsonMode::Lossless`는 iOS 결과 인코딩과 호출 추적이 쓰는 JSON 상위 집합이다(설계 §4.2, M0 계획 Task 5의 BCJSON).

mod object;
mod parse;
mod value;
mod write;

pub use object::JsObject;
pub use parse::{
    JsonFailure, parse_json, parse_json_scoped, parse_json_utf16, parse_json_utf16_scoped,
    parse_json_utf16_with, parse_json_with,
};
pub use value::JsValue;
pub use write::{stringify_json, stringify_json_scoped, stringify_json_with};

/// JSON 문법 선택.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonMode {
    /// 표준 JSON(RFC 8259). 파서는 `JSON.parse`, writer는 `JSON.stringify`와 같다(Android 결과 인코딩)
    Standard,
    /// 무손실 JSON 상위 집합(BCJSON, M0 계획 Task 5와 같은 문법, `F64` 토큰 제외).
    /// `NaN`, `Infinity`, `-Infinity`, `-0`, `undefined`를 그대로 오간다(iOS 결과 인코딩, 호출 추적)
    Lossless,
}
