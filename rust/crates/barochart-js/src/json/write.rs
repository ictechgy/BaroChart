//! JSON writer. `JSON.stringify` 의미(Standard)와 무손실 상위 집합(Lossless)을 쓴다(이식 지도 §3.1.3, §5 규칙 1).
//!
//! - 압축 형식(공백 없음), 키는 JS 자기 키 순서다.
//! - 문자열 이스케이프는 `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, 나머지 C0는 소문자 `\u00xx`, 단독 서로게이트는
//!   소문자 `\udxxx`다. `/`, DEL, U+2028/2029, 비ASCII는 원문 UTF-8로 쓴다(V8·JSC·QuickJS가 같다). 그래서 출력은
//!   늘 올바른 UTF-8이다.
//! - 유한한 수는 `Number::toString`(`num::number_to_string_with`)으로 쓴다. 방언은 `stringify_json`이 이 빌드의
//!   방언(`NumberDialect::PLATFORM`, Android는 QuickJS)이고, `stringify_json_with`로 고른다.
//! - Standard: `-0`은 `0`, 비유한 수는 `null`, 객체 안의 `undefined`는 키째 빠지고 배열 안의 `undefined`는 `null`이다.
//! - Lossless(BCJSON): `NaN`, `Infinity`, `-Infinity`, `-0`, `undefined`를 토큰으로 남긴다.
//! - 재귀하지 않는다. 순회 상태를 힙 스택에 쌓으므로 깊이와 무관하게 스레드 스택을 일정하게 쓴다.
//!   JS 엔진은 깊이 수천~수만에서 스택 오류를 내지만(엔진마다 다르다) 이 writer는 성공한다.

use std::mem::size_of;
use std::slice;

use super::object::{JsObject, ObjectIter};
use super::{JsValue, JsonMode};
use crate::memory::{MemoryFailure, MemoryScope, OomStyle};
use crate::num::{NumberDialect, number_to_string_with};
use crate::string::JsString;

/// 소문자 16진 숫자(`\uXXXX` 이스케이프는 소문자다)
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// `JSON.stringify(value)`(Standard) 또는 무손실 텍스트(Lossless)를 UTF-8 바이트로 쓴다.
///
/// 최상위 `undefined`: JS `JSON.stringify(undefined)`는 텍스트 없이 undefined를 돌려준다. 바이트를 돌려주는 이 함수는
/// 표준 결과 인코딩(설계 §4.2, Android `aster_jni.c:60`이 undefined를 null로 바꾼 뒤 stringify하는 것)과 같게
/// `null`을 쓴다. 텍스트가 없다는 사실이 필요한 호출자는 먼저 `JsValue::Undefined`인지 본다. Lossless는 `undefined`다.
/// 숫자는 이 빌드의 방언(`NumberDialect::PLATFORM`)으로 쓴다. 다른 방언은 `stringify_json_with`로 고른다.
/// - `value`: 쓸 값
/// - `mode`: 문법
/// - 반환: UTF-8 JSON 텍스트
pub fn stringify_json(value: &JsValue, mode: JsonMode) -> Vec<u8> {
    stringify_json_with(value, mode, NumberDialect::PLATFORM)
}

/// `stringify_json`과 같되 숫자를 주어진 방언으로 쓴다(QuickJS는 정규수 2의 거듭제곱 54개 지수에서 17자리).
///
/// - `value`: 쓸 값
/// - `mode`: 문법
/// - `dialect`: `Number::toString`의 방언
/// - 반환: UTF-8 JSON 텍스트
pub fn stringify_json_with(value: &JsValue, mode: JsonMode, dialect: NumberDialect) -> Vec<u8> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    stringify_json_scoped(value, mode, dialect, &mut scope)
        .expect("unaccounted JSON serialization allocation failed")
}

/// `stringify_json_with`과 같은 결과를 내되 output과 반복 frame 성장을 scope에 예약한다.
///
/// - `value`: 쓸 값
/// - `mode`: 문법
/// - `dialect`: `Number::toString`의 방언
/// - `scope`: 호출 수명 temporary memory account
/// - 반환: UTF-8 JSON 텍스트 또는 allocation/account 실패
pub fn stringify_json_scoped(
    value: &JsValue,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Vec<u8>, MemoryFailure> {
    let mut out = Vec::new();
    write_tree(&mut out, Style { mode, dialect }, value, scope)?;
    Ok(out)
}

/// 쓰기 방식: 문법과 숫자 방언
#[derive(Clone, Copy)]
struct Style {
    /// 문법(Standard 또는 Lossless)
    mode: JsonMode,
    /// `Number::toString`의 방언
    dialect: NumberDialect,
}

/// 객체 하나를 무손실 텍스트로 쓴다(`JsObject`의 Debug용).
///
/// - `object`: 쓸 객체
/// - 반환: UTF-8 BCJSON 텍스트
pub(crate) fn object_to_lossless(object: &JsObject) -> Vec<u8> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    object_to_lossless_scoped(object, &mut scope)
        .expect("unaccounted JSON object serialization allocation failed")
}

fn object_to_lossless_scoped(
    object: &JsObject,
    scope: &mut MemoryScope,
) -> Result<Vec<u8>, MemoryFailure> {
    let mut out = Vec::new();
    push_byte(&mut out, b'{', scope)?;
    let mut stack = Vec::new();
    push_frame(
        &mut stack,
        WriteFrame::Object {
            entries: object.entries(),
            first: true,
        },
        scope,
    )?;
    let style = Style {
        mode: JsonMode::Lossless,
        dialect: NumberDialect::PLATFORM,
    };
    drain_frames(&mut out, style, &mut stack, scope)?;
    Ok(out)
}

/// 쓰고 있는 컨테이너 하나의 순회 상태
enum WriteFrame<'a> {
    /// 배열: 남은 원소와, 아직 원소를 하나도 쓰지 않았는지
    Array {
        /// 남은 원소
        items: slice::Iter<'a, JsValue>,
        /// 다음 원소가 첫 원소인지(쉼표를 쓸지)
        first: bool,
    },
    /// 객체: 남은 멤버와, 아직 멤버를 하나도 쓰지 않았는지
    Object {
        /// 남은 멤버(JS 키 순서)
        entries: ObjectIter<'a>,
        /// 다음 멤버가 첫 멤버인지(쉼표를 쓸지)
        first: bool,
    },
}

/// 값 하나와 그 안의 모든 값을 쓴다.
///
/// - `out`: 출력
/// - `style`: 문법과 숫자 방언
/// - `root`: 쓸 값
fn write_tree(
    out: &mut Vec<u8>,
    style: Style,
    root: &JsValue,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    let mut stack = Vec::new();
    write_value(out, style, root, &mut stack, scope)?;
    drain_frames(out, style, &mut stack, scope)
}

/// 스택이 빌 때까지 맨 위 컨테이너의 다음 원소·멤버를 쓰고, 끝나면 닫는다.
///
/// - `out`: 출력
/// - `style`: 문법과 숫자 방언
/// - `stack`: 쓰고 있는 컨테이너들(여는 괄호는 이미 썼다)
fn drain_frames<'a>(
    out: &mut Vec<u8>,
    style: Style,
    stack: &mut Vec<WriteFrame<'a>>,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    while let Some(frame) = stack.last_mut() {
        let next = match frame {
            WriteFrame::Array { items, first } => match items.next() {
                Some(item) => {
                    if !std::mem::replace(first, false) {
                        push_byte(out, b',', scope)?;
                    }
                    Some(item)
                }
                None => {
                    push_byte(out, b']', scope)?;
                    None
                }
            },
            WriteFrame::Object { entries, first } => {
                // Standard는 undefined를 담은 멤버를 키째 건너뛴다
                let member = entries.find(|(_, value)| {
                    style.mode == JsonMode::Lossless || !matches!(value, JsValue::Undefined)
                });
                match member {
                    Some((key, value)) => {
                        if !std::mem::replace(first, false) {
                            push_byte(out, b',', scope)?;
                        }
                        write_string(out, key, scope)?;
                        push_byte(out, b':', scope)?;
                        Some(value)
                    }
                    None => {
                        push_byte(out, b'}', scope)?;
                        None
                    }
                }
            }
        };
        match next {
            Some(value) => write_value(out, style, value, stack, scope)?,
            None => {
                stack.pop();
            }
        }
    }
    Ok(())
}

/// 값 하나를 쓴다. 배열·객체는 여는 괄호만 쓰고 순회 상태를 스택에 쌓는다.
///
/// 객체 멤버의 `undefined`(Standard)는 `drain_frames`가 미리 건너뛰므로, 여기 오는 Standard `undefined`는
/// 배열 원소이거나 최상위 값이고 둘 다 `null`로 쓴다.
/// - `out`: 출력
/// - `style`: 문법과 숫자 방언
/// - `value`: 쓸 값
/// - `stack`: 쓰고 있는 컨테이너들
fn write_value<'a>(
    out: &mut Vec<u8>,
    style: Style,
    value: &'a JsValue,
    stack: &mut Vec<WriteFrame<'a>>,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    match value {
        JsValue::Undefined => extend_bytes(
            out,
            match style.mode {
                JsonMode::Standard => b"null".as_slice(),
                JsonMode::Lossless => b"undefined".as_slice(),
            },
            scope,
        )?,
        JsValue::Null => extend_bytes(out, b"null", scope)?,
        JsValue::Bool(true) => extend_bytes(out, b"true", scope)?,
        JsValue::Bool(false) => extend_bytes(out, b"false", scope)?,
        JsValue::Number(number) => write_number(out, style, *number, scope)?,
        JsValue::String(text) => write_string(out, text, scope)?,
        JsValue::Array(items) => {
            push_byte(out, b'[', scope)?;
            push_frame(
                stack,
                WriteFrame::Array {
                    items: items.iter(),
                    first: true,
                },
                scope,
            )?;
        }
        JsValue::Object(object) => {
            push_byte(out, b'{', scope)?;
            push_frame(
                stack,
                WriteFrame::Object {
                    entries: object.entries(),
                    first: true,
                },
                scope,
            )?;
        }
    }
    Ok(())
}

/// 수를 쓴다. Standard는 비유한 수를 `null`로, Lossless는 `NaN`·`Infinity`·`-Infinity`·`-0` 토큰으로 쓴다.
///
/// - `out`: 출력
/// - `style`: 문법과 숫자 방언
/// - `number`: 쓸 수
fn write_number(
    out: &mut Vec<u8>,
    style: Style,
    number: f64,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    let token: &[u8] = match style.mode {
        JsonMode::Standard if !number.is_finite() => b"null",
        JsonMode::Lossless if number.is_nan() => b"NaN",
        JsonMode::Lossless if number == f64::INFINITY => b"Infinity",
        JsonMode::Lossless if number == f64::NEG_INFINITY => b"-Infinity",
        JsonMode::Lossless if number == 0.0 && number.is_sign_negative() => b"-0",
        _ => {
            // Number::toString은 -0을 "0"으로 쓴다(Standard의 -0 → 0)
            return extend_bytes(
                out,
                number_to_string_with(number, style.dialect).as_bytes(),
                scope,
            );
        }
    };
    extend_bytes(out, token, scope)
}

/// 문자열을 따옴표로 감싸 `JSON.stringify` 규칙대로 이스케이프해 쓴다.
///
/// - `out`: 출력
/// - `text`: 쓸 문자열(단독 서로게이트는 소문자 `\udxxx`)
fn write_string(
    out: &mut Vec<u8>,
    text: &JsString,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    push_byte(out, b'"', scope)?;
    for decoded in char::decode_utf16(text.as_units().iter().copied()) {
        match decoded {
            Ok(character) => write_character(out, character, scope)?,
            Err(error) => write_unicode_escape(out, error.unpaired_surrogate(), scope)?,
        }
    }
    push_byte(out, b'"', scope)
}

/// 문자 하나를 쓴다. 따옴표·역슬래시·C0 제어 문자만 이스케이프하고 나머지는 원문 UTF-8이다.
///
/// - `out`: 출력
/// - `character`: 쓸 문자
fn write_character(
    out: &mut Vec<u8>,
    character: char,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    match character {
        '"' => extend_bytes(out, b"\\\"", scope),
        '\\' => extend_bytes(out, b"\\\\", scope),
        '\u{8}' => extend_bytes(out, b"\\b", scope),
        '\u{C}' => extend_bytes(out, b"\\f", scope),
        '\n' => extend_bytes(out, b"\\n", scope),
        '\r' => extend_bytes(out, b"\\r", scope),
        '\t' => extend_bytes(out, b"\\t", scope),
        // C0 제어 문자는 0x1F 이하라 u16으로 줄여도 값이 같다
        '\u{0}'..='\u{1F}' => write_unicode_escape(out, character as u16, scope),
        _ => {
            let mut buffer = [0; 4];
            extend_bytes(out, character.encode_utf8(&mut buffer).as_bytes(), scope)
        }
    }
}

/// `\uXXXX`(소문자 16진)를 쓴다.
///
/// - `out`: 출력
/// - `unit`: UTF-16 코드 단위
fn write_unicode_escape(
    out: &mut Vec<u8>,
    unit: u16,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    let mut escape = [b'\\', b'u', 0, 0, 0, 0];
    for (slot, shift) in escape[2..].iter_mut().zip([12, 8, 4, 0]) {
        *slot = HEX_DIGITS[usize::from((unit >> shift) & 0xF)];
    }
    extend_bytes(out, &escape, scope)
}

fn push_byte(out: &mut Vec<u8>, byte: u8, scope: &mut MemoryScope) -> Result<(), MemoryFailure> {
    extend_bytes(out, &[byte], scope)
}

fn extend_bytes(
    out: &mut Vec<u8>,
    bytes: &[u8],
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    scope.try_grow(bytes.len())?;
    out.try_reserve(bytes.len())
        .map_err(|_| scope.allocation_failure())?;
    out.extend_from_slice(bytes);
    Ok(())
}

fn push_frame<'a>(
    stack: &mut Vec<WriteFrame<'a>>,
    frame: WriteFrame<'a>,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    scope.try_grow(size_of::<WriteFrame<'a>>())?;
    stack
        .try_reserve(1)
        .map_err(|_| scope.allocation_failure())?;
    stack.push(frame);
    Ok(())
}
