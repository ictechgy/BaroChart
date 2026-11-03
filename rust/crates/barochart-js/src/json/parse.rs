//! 손으로 쓴 JSON 파서. `JSON.parse` 의미(Standard)와 무손실 상위 집합(Lossless)을 읽는다(이식 지도 §3.1.3).
//!
//! - 원문은 두 형식이다. `parse_json`은 UTF-8 바이트(FFI 인자), `parse_json_utf16`은 JS 문자열과 같은 WTF-16 코드
//!   단위다. 코어가 JS 문자열 값(`JsString`)에 `JSON.parse`를 할 때는 코드 단위 진입점을 쓴다. 문자열 안의 원문
//!   단독 서로게이트는 UTF-8로 나타낼 수 없어 바이트 진입점으로는 JS와 같은 결과를 낼 수 없기 때문이다(이식 지도 D7).
//!   문법 문자는 모두 ASCII라 같은 파서가 두 형식을 읽고, 문자열 안의 원문 구간만 형식대로 옮긴다.
//! - 공백은 SP·TAB·LF·CR만 받는다(JS 공백 표가 아니다).
//! - 숫자는 문법을 먼저 확인한다. Ecma 방언은 `str::parse::<f64>`로 정확히 반올림하고, QuickJS 방언은 동봉 엔진처럼
//!   십진 가수의 첫 38자리만 남겨 반올림한다. 기본 방언은 `NumberDialect::PLATFORM`이다. `1e400`은 Infinity, `-0`은 -0이다.
//!   명시 지수가 크면(앞의 0을 뺀 숫자 6자리 이상) 리터럴을 그대로 넘기지 않는다. Rust 1.98.1 dec2flt는 명시 지수를
//!   65536 근처에서 포화시켜 `"0." + "0"×700000 + "1e700001"`을 0으로 읽었다(JS 엔진은 1). 그래서 첫 유효 숫자의
//!   지수를 포화 연산으로 직접 구해 넘침·밑넘침을 가르고, 그 사이 값은 정규화한 `d.ddd…e<지수>`로 읽는다.
//! - 문자열 이스케이프 `\uD800`은 단독 서로게이트로 받는다. 바이트 원문은 올바른 UTF-8이어야 하고, 코드 단위
//!   원문은 문자열 안의 단독 서로게이트도 그대로 받는다(문자열 밖이면 JS처럼 SyntaxError다).
//! - 중복 키는 마지막 값이 이기고 처음 자리를 지킨다(`JsObject::insert`). `__proto__`는 평범한 키다.
//! - 재귀하지 않는다. 만들고 있는 컨테이너를 힙 스택에 쌓으므로 깊이 100,000도 스레드 스택과 무관하다.
//! - 오류는 `SyntaxError`다. 문구는 엔진마다 다르므로 이름만 계약이다(이식 지도 D8). 진단을 위해
//!   `JSON: <위치> <이유>`(Lossless는 M0 BCJSON 형식 `BCJSON: <위치> <이유>`)로 쓴다. 위치는 원문 단위로 센다:
//!   바이트 진입점은 바이트 위치라 비ASCII 문자 뒤에서 JS 문자열 위치와 다르고, 코드 단위 진입점은 JS 문자열 위치다.

use std::borrow::Cow;
use std::ops::Range;

use super::{JsObject, JsValue, JsonMode};
use crate::error::JsError;
use crate::num::NumberDialect;
use crate::string::JsString;

/// 명시 지수(앞의 0을 뺀 숫자)가 이 자릿수 이상이면 리터럴을 `str::parse::<f64>`에 그대로 넘기지 않는다.
///
/// Rust 1.98.1 dec2flt는 명시 지수를 누적하다 65536을 넘으면 남은 숫자를 버린다. 655359까지는 정확하고
/// 655360부터 틀리므로, 그보다 작은 6자리부터 정규화 경로로 보낸다.
const LARGE_EXPONENT_DIGITS: usize = 6;

/// QuickJS 2026-06-04 `js_atod`의 십진 가수 한도(`dtoa.c` atod_max_digits_table[10 - 2]).
/// 뒤의 숫자는 sticky bit도 남기지 않고 버린다. 정확한 동률 바로 위 입력에서 ECMA와 결과가 다를 수 있다.
const QUICKJS_PARSE_DIGITS: usize = 38;

/// 첫 유효 숫자의 십진 지수가 이보다 크면 값이 10^310 이상이라 늘 Infinity다(최댓값은 약 1.8e308)
const MAX_DECIMAL_EXPONENT: i64 = 309;

/// 첫 유효 숫자의 십진 지수가 이보다 작으면 값이 10^-325 미만이라 늘 0이다(최소 부분정규수의 절반은 약 2.47e-324)
const MIN_DECIMAL_EXPONENT: i64 = -325;

/// 문법을 확인한 수 리터럴의 구간들. 정규화 경로(`Parser::parse_normalized_number`)가 쓴다.
struct NumberParts {
    /// `-`로 시작했는지
    negative: bool,
    /// 정수부 숫자 구간
    integer: Range<usize>,
    /// 소수부 숫자 구간(소수부가 없으면 빈 구간)
    fraction: Range<usize>,
    /// 지수 부호가 `-`인지
    exponent_negative: bool,
    /// 지수 숫자 구간
    exponent: Range<usize>,
}

/// `JSON.parse(text)`(Standard) 또는 BCJSON 파싱(Lossless)을 UTF-8 바이트에 한다. 반복 구현이라 재귀가 없다.
///
/// FFI 인자처럼 호스트가 보낸 UTF-8 텍스트를 읽는다. 올바르지 않은 UTF-8(원문 단독 서로게이트를 WTF-8로 쓴 것 포함)은
/// SyntaxError다. JS 문자열 값에 `JSON.parse`를 하려면 `parse_json_utf16`을 쓴다.
/// Lossless는 M0 계획 Task 5의 BCJSON 문법이다: JSON에 값 토큰 `NaN`, `Infinity`, `-Infinity`, `undefined`를 더한다.
/// `F64(<길이>,<해시>)` 토큰은 타입 배열을 JSON에 싣지 않는 M1 범위 밖이라 받지 않는다.
/// - `text`: UTF-8 JSON 텍스트
/// - `mode`: 문법
/// - 반환: 값, 또는 `SyntaxError`(위치는 바이트 단위)
pub fn parse_json(text: &[u8], mode: JsonMode) -> Result<JsValue, JsError> {
    parse_json_with(text, mode, NumberDialect::PLATFORM)
}

/// 숫자 파싱 방언을 정해 UTF-8 JSON·BCJSON을 읽는다. 문법·오류·문자열 규칙은 `parse_json`과 같다.
///
/// - `text`: UTF-8 JSON 텍스트
/// - `mode`: 문법
/// - `dialect`: Ecma는 정확한 반올림, QuickJS는 동봉 엔진의 십진 38자리 한도
/// - 반환: 값, 또는 `SyntaxError`
pub fn parse_json_with(
    text: &[u8],
    mode: JsonMode,
    dialect: NumberDialect,
) -> Result<JsValue, JsError> {
    Parser::new(Utf8Source(text), mode, dialect).parse_document()
}

/// `JSON.parse(text)`(Standard) 또는 BCJSON 파싱(Lossless)을 JS 문자열(WTF-16 코드 단위)에 한다.
///
/// 코어가 `JsString`에 `JSON.parse`를 하는 곳(드로잉 문서 `load`, 체크포인트 복원 등)이 쓴다:
/// `parse_json_utf16(text.as_units(), mode)`. 문자열 안의 원문 단독 서로게이트는 그 코드 단위가 되고, 이어지는
/// 이스케이프와 서로게이트 쌍을 이룰 수도 있다(`"<D83D>\ude00"` → 😀). 문자열 밖의 단독 서로게이트는 SyntaxError다.
/// V8·JSC·QuickJS의 `JSON.parse`와 같다(tests/json.rs). `JsString::to_string_lossy`로 바꿔 `parse_json`에 넘기면
/// 단독 서로게이트가 U+FFFD로 바뀌어 결과가 달라진다.
/// - `text`: JSON 텍스트의 UTF-16 코드 단위(단독 서로게이트 허용)
/// - `mode`: 문법
/// - 반환: 값, 또는 `SyntaxError`(위치는 코드 단위, 곧 JS 문자열 위치)
pub fn parse_json_utf16(text: &[u16], mode: JsonMode) -> Result<JsValue, JsError> {
    parse_json_utf16_with(text, mode, NumberDialect::PLATFORM)
}

/// 숫자 파싱 방언을 정해 WTF-16 JSON·BCJSON을 읽는다. 단독 서로게이트와 오류 위치는 `parse_json_utf16`과 같다.
///
/// - `text`: JSON 텍스트의 UTF-16 코드 단위
/// - `mode`: 문법
/// - `dialect`: 숫자를 읽는 엔진 방언
/// - 반환: 값, 또는 `SyntaxError`
pub fn parse_json_utf16_with(
    text: &[u16],
    mode: JsonMode,
    dialect: NumberDialect,
) -> Result<JsValue, JsError> {
    Parser::new(Utf16Source(text), mode, dialect).parse_document()
}

/// ASCII가 아닌 원문 단위를 문법 바이트로 볼 때 쓰는 값. 어느 문법 문자와도 같지 않고 0x20 이상이라
/// 문자열 원문 구간에 들어간다(그 구간은 `Source::push_run`이 원문 형식대로 옮긴다).
const NON_ASCII: u8 = 0x80;

/// 파서가 읽는 원문. 문법 문자는 모두 ASCII라 원문 단위를 ASCII 바이트로 보고 읽고, 문자열 안의 원문 구간만
/// 원문 형식대로 코드 단위로 옮긴다.
trait Source {
    /// 위치의 원문 단위를 문법 바이트로 본다: ASCII면 그 값, 아니면 0x80 이상(`NON_ASCII` 등), 끝을 넘으면 `None`
    ///
    /// - `position`: 원문 위치
    fn ascii_at(&self, position: usize) -> Option<u8>;

    /// 문자열 안 원문 구간 `[start, end)`(따옴표·역슬래시·C0 제어 문자가 없다)를 UTF-16 코드 단위로 옮긴다.
    ///
    /// - `range`: 원문 구간
    /// - `units`: 문자열 코드 단위
    /// - 반환: 원문이 잘못됐으면(올바르지 않은 UTF-8) 처음 잘못된 위치
    fn push_run(&self, range: Range<usize>, units: &mut Vec<u16>) -> Result<(), usize>;

    /// 문법을 확인한 수 리터럴 구간을 문자열로 빌려준다. ASCII가 아닌 단위가 있으면 `None`이다.
    ///
    /// - `range`: 원문 구간
    fn ascii_text(&self, range: Range<usize>) -> Option<Cow<'_, str>>;

    /// 진단용으로 위치의 원문 단위를 적는다(`byte 0xc2`, `code unit 0x00a0`).
    ///
    /// - `position`: 원문 위치(끝 안쪽)
    fn describe_unit(&self, position: usize) -> String;
}

/// UTF-8 바이트 원문(`parse_json`)
#[derive(Clone, Copy)]
struct Utf8Source<'a>(&'a [u8]);

impl Source for Utf8Source<'_> {
    fn ascii_at(&self, position: usize) -> Option<u8> {
        // ASCII가 아닌 바이트는 0x80 이상이라 어느 문법 문자와도 같지 않다
        self.0.get(position).copied()
    }

    fn push_run(&self, range: Range<usize>, units: &mut Vec<u16>) -> Result<(), usize> {
        let start = range.start;
        let bytes = self.0.get(range).ok_or(start)?;
        match std::str::from_utf8(bytes) {
            Ok(run) => {
                units.extend(run.encode_utf16());
                Ok(())
            }
            Err(error) => Err(start + error.valid_up_to()),
        }
    }

    fn ascii_text(&self, range: Range<usize>) -> Option<Cow<'_, str>> {
        let bytes = self.0.get(range)?;
        bytes
            .is_ascii()
            .then(|| std::str::from_utf8(bytes).ok().map(Cow::Borrowed))
            .flatten()
    }

    fn describe_unit(&self, position: usize) -> String {
        match self.0.get(position) {
            Some(byte) => format!("byte 0x{byte:02x}"),
            None => String::from("end of input"),
        }
    }
}

/// UTF-16 코드 단위 원문(`parse_json_utf16`). 문자열 안의 단독 서로게이트도 그대로 옮긴다.
#[derive(Clone, Copy)]
struct Utf16Source<'a>(&'a [u16]);

impl Source for Utf16Source<'_> {
    fn ascii_at(&self, position: usize) -> Option<u8> {
        self.0.get(position).map(|&unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii() => byte,
            _ => NON_ASCII,
        })
    }

    fn push_run(&self, range: Range<usize>, units: &mut Vec<u16>) -> Result<(), usize> {
        let start = range.start;
        units.extend_from_slice(self.0.get(range).ok_or(start)?);
        Ok(())
    }

    fn ascii_text(&self, range: Range<usize>) -> Option<Cow<'_, str>> {
        self.0
            .get(range)?
            .iter()
            .map(|&unit| u8::try_from(unit).ok().filter(u8::is_ascii).map(char::from))
            .collect::<Option<String>>()
            .map(Cow::Owned)
    }

    fn describe_unit(&self, position: usize) -> String {
        match self.0.get(position) {
            Some(unit) => format!("code unit 0x{unit:04x}"),
            None => String::from("end of input"),
        }
    }
}

/// 만들고 있는 컨테이너. 자식은 다 만든 뒤 붙이므로 프레임끼리는 서로를 품지 않는다.
enum Frame {
    /// 배열과 지금까지의 원소
    Array(Vec<JsValue>),
    /// 객체와, 값을 기다리는 멤버의 키
    Object {
        /// 지금까지의 멤버
        object: JsObject,
        /// 지금 읽는 값의 키
        key: JsString,
    },
}

/// 원소나 멤버 뒤에 온 구분자
enum Separator {
    /// `,`: 다음 원소·멤버가 이어진다
    Next,
    /// `]`·`}`: 컨테이너가 닫혔다
    Close,
}

/// 입력 위치를 들고 다니는 파서 상태
struct Parser<S: Source> {
    /// 원문(UTF-8 바이트 또는 UTF-16 코드 단위)
    source: S,
    /// 다음에 읽을 원문 위치(원문 단위)
    position: usize,
    /// 문법
    mode: JsonMode,
    /// 숫자 파싱 방언
    dialect: NumberDialect,
}

impl<S: Source> Parser<S> {
    /// 원문 처음에서 시작하는 파서
    ///
    /// - `source`: 원문
    /// - `mode`: 문법
    /// - `dialect`: 숫자 파싱 방언
    fn new(source: S, mode: JsonMode, dialect: NumberDialect) -> Self {
        Self {
            source,
            position: 0,
            mode,
            dialect,
        }
    }

    /// 문서 하나(앞뒤 공백 포함)를 읽는다. 값 뒤에 다른 글자가 있으면 오류다.
    fn parse_document(&mut self) -> Result<JsValue, JsError> {
        let mut stack: Vec<Frame> = Vec::new();
        loop {
            if let Some(value) = self.begin_value(&mut stack)?
                && let Some(root) = self.complete_value(&mut stack, value)?
            {
                return self.finish_document(root);
            }
        }
    }

    /// 다 만든 값을 부모에 붙이고, 닫는 괄호가 이어지면 부모도 값으로 만들어 위로 올린다.
    ///
    /// - `stack`: 만들고 있는 컨테이너들
    /// - `value`: 방금 다 만든 값
    /// - 반환: 최상위 값이 끝났으면 그 값, 다음 원소·멤버를 읽어야 하면 `None`
    fn complete_value(
        &mut self,
        stack: &mut Vec<Frame>,
        mut value: JsValue,
    ) -> Result<Option<JsValue>, JsError> {
        loop {
            let separator = match stack.last_mut() {
                None => return Ok(Some(value)),
                Some(Frame::Array(items)) => {
                    items.push(value);
                    self.separator(b']', "',' or ']' after an array element")?
                }
                Some(Frame::Object { object, key }) => {
                    object.insert(std::mem::take(key), value);
                    let separator = self.separator(b'}', "',' or '}' after an object member")?;
                    if let Separator::Next = separator {
                        *key = self.parse_key()?;
                    }
                    separator
                }
            };
            match separator {
                Separator::Next => return Ok(None),
                Separator::Close => value = close_frame(stack.pop()),
            }
        }
    }

    /// 값 하나를 시작한다. 원시 값이나 빈 컨테이너면 다 만든 값을, 내용이 있는 컨테이너면 프레임을 쌓고 `None`을 돌려준다.
    ///
    /// - `stack`: 만들고 있는 컨테이너들
    fn begin_value(&mut self, stack: &mut Vec<Frame>) -> Result<Option<JsValue>, JsError> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'[') => {
                self.position += 1;
                self.skip_whitespace();
                if self.eat(b']') {
                    return Ok(Some(JsValue::Array(Vec::new())));
                }
                stack.push(Frame::Array(Vec::new()));
                Ok(None)
            }
            Some(b'{') => {
                self.position += 1;
                self.skip_whitespace();
                if self.eat(b'}') {
                    return Ok(Some(JsValue::Object(JsObject::new())));
                }
                let key = self.parse_key()?;
                stack.push(Frame::Object {
                    object: JsObject::new(),
                    key,
                });
                Ok(None)
            }
            _ => self.parse_scalar().map(Some),
        }
    }

    /// 최상위 값 뒤에는 공백만 올 수 있다.
    ///
    /// - `value`: 다 읽은 최상위 값
    fn finish_document(&mut self, value: JsValue) -> Result<JsValue, JsError> {
        self.skip_whitespace();
        match self.peek() {
            None => Ok(value),
            Some(_) => Err(self.unexpected("the end of input after the JSON value")),
        }
    }

    /// 원소·멤버 뒤의 `,` 또는 닫는 괄호를 읽는다.
    ///
    /// - `close`: 닫는 괄호(`]` 또는 `}`)
    /// - `expected`: 오류 문구에 쓸 기대 내용
    fn separator(&mut self, close: u8, expected: &str) -> Result<Separator, JsError> {
        self.skip_whitespace();
        if self.eat(b',') {
            Ok(Separator::Next)
        } else if self.eat(close) {
            Ok(Separator::Close)
        } else {
            Err(self.unexpected(expected))
        }
    }

    /// 객체 멤버의 키와 `:`를 읽는다.
    fn parse_key(&mut self) -> Result<JsString, JsError> {
        self.skip_whitespace();
        if self.peek() != Some(b'"') {
            return Err(self.unexpected("'\"' to start an object key"));
        }
        let key = self.parse_string()?;
        self.skip_whitespace();
        if !self.eat(b':') {
            return Err(self.unexpected("':' after an object key"));
        }
        Ok(key)
    }

    /// 원시 값(문자열, 수, 리터럴, Lossless 토큰)을 읽는다.
    fn parse_scalar(&mut self) -> Result<JsValue, JsError> {
        let lossless = self.mode == JsonMode::Lossless;
        match self.peek() {
            Some(b'"') => self.parse_string().map(JsValue::String),
            Some(b'-' | b'0'..=b'9') => self.parse_number().map(JsValue::Number),
            Some(b't') => self.parse_literal("true", JsValue::Bool(true)),
            Some(b'f') => self.parse_literal("false", JsValue::Bool(false)),
            Some(b'n') => self.parse_literal("null", JsValue::Null),
            Some(b'N') if lossless => self.parse_literal("NaN", JsValue::Number(f64::NAN)),
            Some(b'I') if lossless => {
                self.parse_literal("Infinity", JsValue::Number(f64::INFINITY))
            }
            Some(b'u') if lossless => self.parse_literal("undefined", JsValue::Undefined),
            _ => Err(self.unexpected("a JSON value")),
        }
    }

    /// 정해진 철자의 리터럴을 읽는다(`true`, `false`, `null`, Lossless의 `NaN`·`Infinity`·`undefined`).
    ///
    /// - `word`: 리터럴 철자
    /// - `value`: 맞으면 돌려줄 값
    fn parse_literal(&mut self, word: &str, value: JsValue) -> Result<JsValue, JsError> {
        if self.eat_word(word) {
            Ok(value)
        } else {
            Err(self.error(&format!("invalid literal; expected '{word}'")))
        }
    }

    /// 수를 읽는다: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, Lossless는 `-Infinity`도 받는다.
    ///
    /// 문법을 확인한 텍스트만 `str::parse::<f64>`에 넘긴다(Rust 파서는 `+1`, `.5`, `inf` 같은 JSON 밖 형식도 받으므로).
    /// 명시 지수가 크면(앞의 0을 뺀 숫자가 `LARGE_EXPONENT_DIGITS`자리 이상) 그대로 넘기지 않고
    /// `parse_normalized_number`로 정규화한다. dec2flt가 명시 지수를 65536 근처에서 포화시키기 때문이다.
    fn parse_number(&mut self) -> Result<f64, JsError> {
        let start = self.position;
        let negative = self.eat(b'-');
        if negative && self.mode == JsonMode::Lossless && self.peek() == Some(b'I') {
            return if self.eat_word("Infinity") {
                Ok(f64::NEG_INFINITY)
            } else {
                Err(self.error("invalid literal; expected '-Infinity'"))
            };
        }
        let integer_start = self.position;
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => self.skip_digits(),
            _ => return Err(self.unexpected("a digit")),
        }
        let integer = integer_start..self.position;
        let mut fraction = self.position..self.position;
        if self.eat(b'.') {
            let fraction_start = self.position;
            self.require_digits("a digit after '.'")?;
            fraction = fraction_start..self.position;
        }
        let mut exponent = None;
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            let exponent_negative = self.peek() == Some(b'-');
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            let exponent_start = self.position;
            self.require_digits("a digit in the exponent")?;
            exponent = Some((exponent_negative, exponent_start..self.position));
        }
        let large_exponent = exponent.as_ref().is_some_and(|(_, digits)| {
            self.significant_length(digits.clone()) >= LARGE_EXPONENT_DIGITS
        });
        let long_quickjs = self.dialect == NumberDialect::QuickJs
            && integer.len() + fraction.len() > QUICKJS_PARSE_DIGITS;
        if large_exponent || long_quickjs {
            let (exponent_negative, digits) =
                exponent.unwrap_or((false, self.position..self.position));
            let parts = NumberParts {
                negative,
                integer,
                fraction,
                exponent_negative,
                exponent: digits,
            };
            return self.parse_normalized_number(start, &parts);
        }
        // 문법을 확인한 ASCII라 문자열 변환과 f64 파싱은 실패하지 않는다. 실패하면 위치를 담아 SyntaxError로 알린다
        let literal = self
            .source
            .ascii_text(start..self.position)
            .ok_or_else(|| self.error_at(start, "number is not ASCII"))?;
        literal
            .parse::<f64>()
            .map_err(|_| self.error_at(start, "number does not parse as f64"))
    }

    /// 명시 지수가 크거나 QuickJS의 가수가 긴 수를 정규화해 읽는다.
    ///
    /// 정수부·소수부 숫자를 이은 열에서 처음과 마지막 유효 숫자(0이 아닌 숫자)를 찾고, 첫 유효 숫자의 십진 지수를
    /// 포화 연산으로 직접 구한다. 지수가 `MAX_DECIMAL_EXPONENT`보다 크면 ±Infinity, `MIN_DECIMAL_EXPONENT`보다
    /// 작으면 ±0이고, 그 사이면 `d.ddd…e<지수>`(지수 절댓값 326 미만)를 다시 만들어 `str::parse::<f64>`로 정확히
    /// 반올림한다. QuickJS 방언은 처음 38자리 뒤를 버린다. 유효 숫자가 없으면 부호 있는 0이다(`-0e999999` → -0).
    /// - `start`: 수가 시작한 위치(오류 위치)
    /// - `parts`: 문법을 확인한 수의 구간들
    fn parse_normalized_number(&self, start: usize, parts: &NumberParts) -> Result<f64, JsError> {
        let integer_length = parts.integer.len();
        let digit_at = |index: usize| {
            let position = if index < integer_length {
                parts.integer.start + index
            } else {
                parts.fraction.start + (index - integer_length)
            };
            self.source.ascii_at(position).unwrap_or(b'0')
        };
        let total = integer_length + parts.fraction.len();
        let first = (0..total).find(|&index| digit_at(index) != b'0');
        let last = (0..total).rev().find(|&index| digit_at(index) != b'0');
        let (Some(first), Some(last)) = (first, last) else {
            return Ok(if parts.negative { -0.0 } else { 0.0 });
        };
        let last = if self.dialect == NumberDialect::QuickJs {
            std::cmp::min(last, first.saturating_add(QUICKJS_PARSE_DIGITS - 1))
        } else {
            last
        };
        let explicit = parts.exponent.clone().fold(0_i64, |value, position| {
            // 문법을 확인한 십진 숫자라 b'0'을 빼도 0..=9다
            let digit = self
                .source
                .ascii_at(position)
                .map_or(0, |byte| byte.saturating_sub(b'0'));
            value.saturating_mul(10).saturating_add(i64::from(digit))
        });
        let explicit = if parts.exponent_negative {
            -explicit
        } else {
            explicit
        };
        // 첫 유효 숫자의 지수 = (정수부 자릿수 - 첫 유효 숫자 위치 - 1) + 명시 지수. 자릿수는 입력 길이라 i64에 든다
        let leading = saturating_i64(integer_length)
            .saturating_sub(saturating_i64(first))
            .saturating_sub(1)
            .saturating_add(explicit);
        let magnitude = if leading > MAX_DECIMAL_EXPONENT {
            f64::INFINITY
        } else if leading < MIN_DECIMAL_EXPONENT {
            0.0
        } else {
            let mut text = String::with_capacity(last - first + 8);
            text.push(char::from(digit_at(first)));
            if last > first {
                text.push('.');
                text.extend((first + 1..=last).map(|index| char::from(digit_at(index))));
            }
            text.push('e');
            text.push_str(&leading.to_string());
            text.parse::<f64>()
                .map_err(|_| self.error_at(start, "number does not parse as f64"))?
        };
        Ok(if parts.negative {
            -magnitude
        } else {
            magnitude
        })
    }

    /// 숫자 구간에서 앞의 0을 뺀 자릿수
    ///
    /// - `digits`: 십진 숫자만 든 구간
    fn significant_length(&self, digits: Range<usize>) -> usize {
        digits
            .skip_while(|&position| self.source.ascii_at(position) == Some(b'0'))
            .count()
    }

    /// 문자열을 읽는다. 여는 따옴표에 있을 때 부른다.
    ///
    /// 특수 단위(따옴표, 역슬래시, C0 제어 문자) 사이의 원문 구간을 한 번에 옮긴다(바이트 원문은 UTF-8로 검사한다).
    /// 특수 단위는 모두 ASCII라 다중 바이트 문자 안에 나타나지 않으므로 구간 경계가 문자를 가르지 않는다.
    fn parse_string(&mut self) -> Result<JsString, JsError> {
        self.position += 1;
        let mut units: Vec<u16> = Vec::new();
        loop {
            self.copy_raw_run(&mut units)?;
            match self.peek() {
                None => return Err(self.error("unterminated string; expected '\"'")),
                Some(b'"') => {
                    self.position += 1;
                    return Ok(JsString::from_utf16(units));
                }
                Some(b'\\') => self.parse_escape(&mut units)?,
                Some(control) => {
                    return Err(self.error(&format!(
                        "unescaped control character U+{control:04X} in a string; write it as \\u{control:04x}"
                    )));
                }
            }
        }
    }

    /// 다음 특수 단위(따옴표, 역슬래시, C0 제어 문자) 앞까지의 원문 구간을 코드 단위로 옮긴다.
    ///
    /// - `units`: 문자열 코드 단위
    fn copy_raw_run(&mut self, units: &mut Vec<u16>) -> Result<(), JsError> {
        let start = self.position;
        while let Some(byte) = self.peek() {
            if byte == b'"' || byte == b'\\' || byte < 0x20 {
                break;
            }
            self.position += 1;
        }
        self.source
            .push_run(start..self.position, units)
            .map_err(|invalid| {
                self.error_at(
                    invalid,
                    "invalid UTF-8 in a string; send UTF-8 bytes with lone surrogates written as \\uXXXX escapes, \
                     or pass the JS string's UTF-16 code units to parse_json_utf16",
                )
            })
    }

    /// 역슬래시 이스케이프 하나를 읽어 코드 단위를 붙인다. 역슬래시에 있을 때 부른다.
    ///
    /// - `units`: 문자열 코드 단위
    fn parse_escape(&mut self, units: &mut Vec<u16>) -> Result<(), JsError> {
        let escape_start = self.position;
        self.position += 1;
        let unit = match self.peek() {
            Some(b'"') => 0x22,
            Some(b'\\') => 0x5C,
            Some(b'/') => 0x2F,
            Some(b'b') => 0x08,
            Some(b'f') => 0x0C,
            Some(b'n') => 0x0A,
            Some(b'r') => 0x0D,
            Some(b't') => 0x09,
            Some(b'u') => {
                self.position += 1;
                units.push(self.parse_hex4(escape_start)?);
                return Ok(());
            }
            _ => {
                return Err(self.error_at(
                    escape_start,
                    "invalid escape; use one of \\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX",
                ));
            }
        };
        self.position += 1;
        units.push(unit);
        Ok(())
    }

    /// `\u` 뒤의 16진 숫자 네 개를 읽는다(대소문자 무관). 서로게이트도 검사 없이 그대로 받는다.
    ///
    /// - `escape_start`: 오류 위치로 쓸 역슬래시 위치
    fn parse_hex4(&mut self, escape_start: usize) -> Result<u16, JsError> {
        const REASON: &str = "invalid \\u escape; expected four hexadecimal digits";
        let mut unit: u16 = 0;
        for offset in 0..4 {
            // ASCII가 아닌 단위(NON_ASCII 등)는 16진 숫자가 아니라 여기서 걸린다
            let value = self
                .source
                .ascii_at(self.position + offset)
                .and_then(|digit| char::from(digit).to_digit(16));
            let Some(value) = value else {
                return Err(self.error_at(escape_start, REASON));
            };
            // to_digit(16)은 0..=15라 u16으로 줄여도 값이 같고, 네 자리라 0xFFFF를 넘지 않는다
            unit = unit * 16 + value as u16;
        }
        self.position += 4;
        Ok(unit)
    }

    /// 다음 단위들이 `word`와 같으면 소비한다.
    ///
    /// - `word`: ASCII 철자
    /// - 반환: 소비했으면 true
    fn eat_word(&mut self, word: &str) -> bool {
        let matched = word.bytes().enumerate().all(|(offset, expected)| {
            self.source.ascii_at(self.position + offset) == Some(expected)
        });
        if matched {
            self.position += word.len();
        }
        matched
    }

    /// 십진 숫자가 하나 이상 있어야 하는 자리를 읽는다.
    ///
    /// - `expected`: 숫자가 없을 때 오류 문구에 쓸 기대 내용
    fn require_digits(&mut self, expected: &str) -> Result<(), JsError> {
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            return Err(self.unexpected(expected));
        }
        self.skip_digits();
        Ok(())
    }

    /// 십진 숫자를 건너뛴다.
    fn skip_digits(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.position += 1;
        }
    }

    /// JSON 공백(SP·TAB·LF·CR)을 건너뛴다.
    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    /// 다음 단위가 ASCII `byte`면 소비한다.
    ///
    /// - 반환: 소비했으면 true
    fn eat(&mut self, byte: u8) -> bool {
        let matched = self.peek() == Some(byte);
        if matched {
            self.position += 1;
        }
        matched
    }

    /// 다음 단위를 문법 바이트로 본다(소비하지 않는다). ASCII가 아니면 0x80 이상이다.
    fn peek(&self) -> Option<u8> {
        self.source.ascii_at(self.position)
    }

    /// 지금 위치에서 예상하지 못한 입력을 만난 오류. 보이는 ASCII는 글자로, 나머지는 16진 원문 단위로 적는다.
    ///
    /// - `expected`: 그 자리에 와야 했던 내용
    fn unexpected(&self, expected: &str) -> JsError {
        let found = match self.peek() {
            None => String::from("end of input"),
            Some(byte) if byte.is_ascii_graphic() => format!("'{}'", char::from(byte)),
            Some(_) => self.source.describe_unit(self.position),
        };
        self.error(&format!("unexpected {found}; expected {expected}"))
    }

    /// 지금 위치의 `SyntaxError`
    ///
    /// - `reason`: 원인과 고칠 방향
    fn error(&self, reason: &str) -> JsError {
        self.error_at(self.position, reason)
    }

    /// 주어진 위치의 `SyntaxError`. 문구는 `JSON: <위치> <이유>` 또는 `BCJSON: <위치> <이유>`다.
    ///
    /// - `position`: 원문 위치(바이트 원문은 바이트, 코드 단위 원문은 코드 단위)
    /// - `reason`: 원인과 고칠 방향
    fn error_at(&self, position: usize, reason: &str) -> JsError {
        let prefix = match self.mode {
            JsonMode::Standard => "JSON",
            JsonMode::Lossless => "BCJSON",
        };
        JsError::new(
            "SyntaxError",
            JsString::from_str(&format!("{prefix}: {position} {reason}")),
        )
    }
}

/// 위치·길이(usize)를 i64로 바꾼다. 넘치면 `i64::MAX`에 붙인다(입력 길이라 실제로는 넘치지 않는다).
///
/// - `value`: 바꿀 값
fn saturating_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// 닫힌 프레임을 값으로 바꾼다.
///
/// - `frame`: 스택에서 꺼낸 프레임(호출하는 쪽이 방금 맨 위를 봤으므로 늘 있다)
fn close_frame(frame: Option<Frame>) -> JsValue {
    match frame {
        Some(Frame::Array(items)) => JsValue::Array(items),
        Some(Frame::Object { object, .. }) => JsValue::Object(object),
        None => JsValue::Undefined,
    }
}
