//! JS 오류 값(설계 §4.7, 이식 지도 §3.1.5).
//!
//! 코어가 던지는 오류는 JS 백엔드와 `name`·`message`·`code`가 바이트 단위로 같아야 한다(설계 §6.2).
//! 메시지는 사용자 입력을 `slice`로 잘라 담기도 하므로(서로게이트 쌍이 갈릴 수 있다) WTF-16 문자열이다.
//! FFI는 세 필드를 그대로 넘기고, 플랫폼 글루가 `Name: message`를 만들어 기존 오류 분류기에 넘긴다.

use std::fmt;

use crate::string::JsString;

/// JS 오류. `name`은 `TypeError`·`RangeError`·`SyntaxError`·`Error`·`IngestionError` 같은 생성자 이름이고,
/// `code`는 `IngestionError`처럼 문자열 코드를 가진 오류에만 있다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsError {
    /// 오류 이름(JS `error.name`)
    pub name: &'static str,
    /// 오류 메시지(JS `error.message`). JS 원문과 코드 단위까지 같아야 한다
    pub message: JsString,
    /// 오류 코드(JS `error.code`). 없으면 `None`
    pub code: Option<String>,
}

impl JsError {
    /// 코드가 없는 오류를 만든다.
    ///
    /// - `name`: 오류 이름(예: `"SyntaxError"`)
    /// - `message`: JS 원문과 같은 메시지
    pub fn new(name: &'static str, message: JsString) -> Self {
        Self {
            name,
            message,
            code: None,
        }
    }
}

/// `Error.prototype.toString`과 같은 모양으로 보인다(진단용): 둘 다 있으면 `name: message`, 하나가 비면 다른 하나.
/// 단독 서로게이트는 U+FFFD로 바뀐다.
impl fmt::Display for JsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = self.message.to_string_lossy();
        match (self.name.is_empty(), message.is_empty()) {
            (_, true) => formatter.write_str(self.name),
            (true, false) => formatter.write_str(&message),
            (false, false) => write!(formatter, "{}: {message}", self.name),
        }
    }
}

impl std::error::Error for JsError {}

#[cfg(test)]
mod tests {
    use super::JsError;
    use crate::string::JsString;

    /// 진단 문자열은 `Error.prototype.toString` 규칙을 따른다(`String(new TypeError('x'))` → `TypeError: x`).
    #[test]
    fn display_follows_error_prototype_to_string() {
        let typed = JsError::new("TypeError", JsString::from_str("Invalid symbol metadata"));
        assert_eq!(typed.to_string(), "TypeError: Invalid symbol metadata");
        assert_eq!(
            JsError::new("RangeError", JsString::default()).to_string(),
            "RangeError"
        );
        assert_eq!(
            JsError::new("", JsString::from_str("bare")).to_string(),
            "bare"
        );
        let lone = JsError::new("Error", JsString::from_utf16(vec![0x61, 0xD800]));
        assert_eq!(lone.to_string(), "Error: a\u{FFFD}");
        assert_eq!(typed.code, None);
    }
}
