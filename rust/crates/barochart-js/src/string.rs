//! JS 문자열 의미: UTF-16 코드 단위로 세는 WTF-16 문자열과 JS 공백 표(설계 §6.4, 이식 지도 §3.1.2·§5).
//!
//! - JS 문자열은 UTF-16 코드 단위의 나열이라 단독 서로게이트를 담을 수 있다. JSON `\uD800` 이스케이프로
//!   들어오고, `slice`가 서로게이트 쌍을 가를 때도 생긴다(오류 문구를 64·256 단위로 자르는 곳). Rust `String`은
//!   이것을 담지 못하므로 코어 내부 문자열은 이 타입이다(이식 지도 D7).
//! - 길이 한도는 모두 코드 단위로 센다(`.length`). 바이트나 `char` 수가 아니다.
//! - `trim`은 JS 공백 표를 쓴다. Rust `str::trim`은 U+0085를 지우고 U+FEFF를 남겨 JS와 다르다.

use std::fmt;

/// WTF-16 문자열. 단독 서로게이트를 담을 수 있다(코어가 slice로 쌍을 가를 수 있으므로).
///
/// 비교·정렬은 코드 단위 사전순이라 JS의 `<`·`===`와 같다. Rust `str` 순서는 코드 포인트 순이라
/// 보충 평면 문자와 U+E000..=U+FFFF 사이에서 JS와 다르다.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct JsString(Vec<u16>);

impl JsString {
    /// UTF-8 문자열을 같은 내용의 UTF-16 코드 단위로 바꾼다.
    ///
    /// 실패하지 않는 변환이라 `Result`를 돌려주는 `FromStr`을 쓰지 않는다(계획의 인터페이스 이름 그대로).
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        Self(s.encode_utf16().collect())
    }

    /// UTF-16 코드 단위를 그대로 담는다. 단독 서로게이트도 검사 없이 받는다.
    pub fn from_utf16(units: Vec<u16>) -> Self {
        Self(units)
    }

    /// `String.prototype.length`: UTF-16 코드 단위 수
    pub fn len_utf16(&self) -> usize {
        self.0.len()
    }

    /// `String.prototype.slice(start, end)`. `end`가 `None`이면 JS의 undefined(끝까지)다.
    ///
    /// 음수 위치는 길이에 더해 끝에서 세고, 범위를 넘는 위치는 0이나 길이로 자른다. 시작이 끝 이상이면 빈 문자열이다.
    /// 코드 단위로 자르므로 서로게이트 쌍을 가를 수 있다(`'😀'.slice(0, 1)`은 단독 상위 서로게이트).
    pub fn slice(&self, start: isize, end: Option<isize>) -> JsString {
        let length = self.0.len();
        let from = relative_index(start, length);
        let to = end.map_or(length, |end| relative_index(end, length));
        match self.0.get(from..to) {
            Some(units) => Self(units.to_vec()),
            None => Self::default(),
        }
    }

    /// `String.prototype.trim`: 양끝의 JS 공백(`is_js_whitespace`)을 지운다.
    ///
    /// 공백 문자는 모두 BMP라 코드 단위로 보면 된다. 단독 서로게이트는 공백이 아니라 남는다.
    pub fn trim(&self) -> JsString {
        let start = self
            .0
            .iter()
            .position(|&unit| !is_js_whitespace(unit))
            .unwrap_or(self.0.len());
        let end = self
            .0
            .iter()
            .rposition(|&unit| !is_js_whitespace(unit))
            .map_or(start, |last| last + 1);
        match self.0.get(start..end) {
            Some(units) => Self(units.to_vec()),
            None => Self::default(),
        }
    }

    /// `String.prototype.toLowerCase`: 언어와 무관한 전체 유니코드 소문자 변환.
    ///
    /// 올바른 UTF-16 구간마다 `str::to_lowercase`를 쓴다. 확장 매핑(U+0130 → `i̇`)과 final sigma 규칙(`"ΑΣ"` → `"ας"`)이
    /// JS와 같다. 단독 서로게이트는 그대로 둔다. 단독 서로게이트는 대소문자도 대소문자 무시 문자도 아니라
    /// JS에서도 final sigma 문맥을 끊으므로, 구간을 나눠 변환해도 결과가 같다(V8·JSC·QuickJS 실측).
    pub fn to_lowercase(&self) -> JsString {
        let mut units = Vec::with_capacity(self.0.len());
        let mut run = String::new();
        for decoded in char::decode_utf16(self.0.iter().copied()) {
            match decoded {
                Ok(character) => run.push(character),
                Err(error) => {
                    push_lowercase_run(&mut units, &mut run);
                    units.push(error.unpaired_surrogate());
                }
            }
        }
        push_lowercase_run(&mut units, &mut run);
        Self(units)
    }

    /// 진단용 UTF-8 문자열. 단독 서로게이트는 U+FFFD로 바뀌므로 JS 값과 바이트가 같다고 보면 안 된다.
    ///
    /// `JSON.parse` 입력으로 쓰지 않는다. 단독 서로게이트가 든 문서의 결과가 JS와 달라진다(U+FFFD로 바뀌어
    /// 받아들이거나, 서로게이트를 거절해야 할 검증을 통과한다). JS 문자열의 JSON은
    /// `json::parse_json_utf16(text.as_units(), mode)`로 읽는다.
    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }

    /// UTF-16 코드 단위를 빌려준다.
    pub fn as_units(&self) -> &[u16] {
        &self.0
    }
}

/// Rust 문자열 이스케이프로 보이고, 단독 서로게이트는 `\u{d800}`처럼 적는다(진단용).
impl fmt::Debug for JsString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("\"")?;
        for decoded in char::decode_utf16(self.0.iter().copied()) {
            match decoded {
                Ok(character) => write!(formatter, "{}", character.escape_debug())?,
                Err(error) => write!(formatter, "\\u{{{:x}}}", error.unpaired_surrogate())?,
            }
        }
        formatter.write_str("\"")
    }
}

/// JS 공백인지 본다: ECMA-262의 WhiteSpace와 LineTerminator. `String.prototype.trim`과 정규식 `\s`가 쓰는 표다.
///
/// U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
/// U+0085(NEL)와 U+180E(유니코드 6.3부터 공백 아님)는 들어가지 않는다. Rust `char::is_whitespace`는
/// U+0085를 공백으로 보고 U+FEFF를 공백으로 보지 않는다.
pub fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

/// `slice`의 상대 위치를 실제 위치로 바꾼다(ECMA-262 `String.prototype.slice` 3~4단계).
///
/// - `index`: 음수면 끝에서 센다
/// - `length`: 문자열 길이(코드 단위)
/// - 반환: 0 이상 `length` 이하의 위치
fn relative_index(index: isize, length: usize) -> usize {
    if index < 0 {
        length.saturating_sub(index.unsigned_abs())
    } else {
        std::cmp::min(index.unsigned_abs(), length)
    }
}

/// 모아 둔 올바른 구간을 소문자로 바꿔 코드 단위 뒤에 붙이고 구간을 비운다.
///
/// - `units`: 결과 코드 단위
/// - `run`: 단독 서로게이트 사이의 올바른 구간
fn push_lowercase_run(units: &mut Vec<u16>, run: &mut String) {
    if !run.is_empty() {
        units.extend(run.to_lowercase().encode_utf16());
        run.clear();
    }
}
