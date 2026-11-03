//! `bc-conformance`: JS 의미 커널(`barochart-js`)을 JS 엔진과 대조하는 개발 전용 계산기(M1 계획 Task 4).
//!
//! 표준입력의 JSONL 작업을 한 줄씩 커널로 계산해, 같은 순서의 JSONL 결과 `{"r":"<결과>"}`를 표준출력에 쓴다.
//! 숫자를 문자열로 쓰는 연산은 QuickJS 방언(`NumberDialect::QuickJs`, Android 빌드의 규칙)으로도 계산해, 결과가
//! 다르면 `{"r":"<ECMA 결과>","q":"<QuickJS 결과>"}`로 쓴다. 하네스는 `r`을 V8·JSC와, `q`(없으면 `r`)를
//! QuickJS와 비교한다(설계 §6.1: 같은 기기 JS 백엔드가 오라클, 리뷰 C1·C3).
//! 작업을 만들고 결과를 V8·JSC·QuickJS의 기대값과 비교하는 쪽은 `scripts/rust/conformance.mjs`다.
//! 작업 줄도 커널의 JSON 파서로 읽는다(serde를 쓰지 않는다, 설계 §7.2).
//!
//! 작업 필드(형식의 정본은 `scripts/rust/conformance.mjs`의 머리 주석이다):
//! - `op`: 연산 이름(`OPERATIONS` 표)
//! - `x`, `y`, `t`: IEEE-754 비트를 16진 16자리(빅엔디언)로 쓴 수. NaN 페이로드도 그대로 옮긴다
//! - `xs`, `args`: 그런 16진 비트의 배열
//! - `d`, `p`, `start`, `end`, `unit`, `year`, `month`, `day`, `days`: 정수(JSON 수)
//! - `text`: UTF-8 바이트의 16진, `units`: UTF-16 코드 단위마다 16진 네 자리(단독 서로게이트도 담는다)
//!
//! 결과는 JS 쪽 오라클과 같은 정규 문자열이다. 수 결과는 NaN이면 `NaN`, 아니면 16진 비트다(설계 §6.2의 NaN 정규화).
//! 문자열·JSON 결과는 16진이고, 오류는 `E:<이름>`이다.
//!
//! 사용법: `bc-conformance < tasks.jsonl > results.jsonl`, `bc-conformance --unicode-version`(std의 유니코드 판)
//! 종료 코드: 0 성공, 2 잘못된 인자·작업 또는 입출력 실패(표준오류에 줄 번호와 원인을 쓴다)

#![forbid(unsafe_code)]

use std::io::{self, BufRead, BufWriter, Write};
use std::ops::RangeInclusive;
use std::process::ExitCode;

use barochart_js::date::{
    civil_from_days, date_utc, days_from_civil, parse_iso_clock, parse_iso_date, time_clip,
    to_iso_string,
};
use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_utf16_with, parse_json_with,
    stringify_json, stringify_json_with,
};
use barochart_js::num::{
    NumberDialect, js_max, js_min, js_round, js_sign, number_to_string_with, same_value,
    to_exponential_with, to_fixed_with, to_int32, to_precision, to_uint32,
};
use barochart_js::string::{JsString, is_js_whitespace};

/// 사용법(잘못된 인자일 때 보인다)
const USAGE: &str =
    "usage: bc-conformance < tasks.jsonl > results.jsonl, or bc-conformance --unicode-version";

/// JSON 수로 정확히 나타나는 정수의 절댓값 상한(2^53)
const MAX_EXACT_INTEGER: i64 = 9_007_199_254_740_992;

/// `toFixed`·`toExponential` 자릿수와 `toPrecision` 유효 숫자의 상한. 넘는 값은 커널이 아니라 호출자(코어)가 막는다
const MAX_DIGITS: i64 = 100;

/// 소문자 16진 숫자
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// 작업 하나의 결과: 정규 결과 문자열, 또는 작업이 잘못됐다는 이유
type Outcome = Result<String, String>;

/// 연산 구현. 숫자를 문자열로 쓰는 연산만 방언을 받는다.
#[derive(Clone, Copy)]
enum Operation {
    /// 방언과 무관한 연산
    Plain(fn(&JsObject) -> Outcome),
    /// 숫자를 문자열로 쓰는 연산(`Number::toString`의 방언이 결과를 바꿀 수 있다)
    Formatting(fn(&JsObject, NumberDialect) -> Outcome),
}

/// 작업 하나의 결과 줄: ECMA(V8·JSC) 결과와, 다르면 QuickJS 방언 결과
struct Results {
    /// ECMA-262 방언 결과(`r`)
    ecma: String,
    /// QuickJS 방언 결과가 ECMA와 다를 때만 그 값(`q`)
    quickjs: Option<String>,
}

/// 연산 이름 → 구현. `scripts/rust/conformance.mjs`의 `SUITE_OPS`와 같은 이름을 쓴다.
const OPERATIONS: &[(&str, Operation)] = &[
    ("toString", Operation::Formatting(op_to_string)),
    ("toFixed", Operation::Formatting(op_to_fixed)),
    ("toPrecision", Operation::Plain(op_to_precision)),
    ("toExponential", Operation::Formatting(op_to_exponential)),
    ("round", Operation::Plain(op_round)),
    ("sign", Operation::Plain(op_sign)),
    ("max", Operation::Plain(op_max)),
    ("min", Operation::Plain(op_min)),
    ("toInt32", Operation::Plain(op_to_int32)),
    ("toUint32", Operation::Plain(op_to_uint32)),
    ("objectIs", Operation::Plain(op_object_is)),
    ("json", Operation::Formatting(op_json)),
    ("jsonLossless", Operation::Formatting(op_json_lossless)),
    ("jsonUnits", Operation::Formatting(op_json_units)),
    ("trim", Operation::Plain(op_trim)),
    ("toLowerCase", Operation::Plain(op_to_lower_case)),
    ("slice", Operation::Plain(op_slice)),
    ("length", Operation::Plain(op_length)),
    ("isWhitespace", Operation::Plain(op_is_whitespace)),
    ("quote", Operation::Plain(op_quote)),
    ("dateUtc", Operation::Plain(op_date_utc)),
    ("timeClip", Operation::Plain(op_time_clip)),
    ("toISOString", Operation::Plain(op_to_iso_string)),
    ("daysFromCivil", Operation::Plain(op_days_from_civil)),
    ("civilFromDays", Operation::Plain(op_civil_from_days)),
    ("parseIsoDate", Operation::Plain(op_parse_iso_date)),
    ("parseIsoClock", Operation::Plain(op_parse_iso_clock)),
];

/// 인자가 없으면 작업을 계산하고, `--unicode-version`이면 std의 유니코드 판을 쓴다.
///
/// 하네스는 유니코드 판을 Node의 판과 견줘, 새 판에서 생긴 대소문자 대응이 엔진 차이인지 가른다.
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => stream(),
        [flag] if flag == "--unicode-version" => {
            let (major, minor, update) = char::UNICODE_VERSION;
            println!("{major}.{minor}.{update}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("bc-conformance: unexpected arguments {args:?}; {USAGE}");
            ExitCode::from(2)
        }
    }
}

/// 표준입력의 작업을 모두 계산해 표준출력에 쓴다. 실패하면 원인을 표준오류에 쓰고 2로 끝난다.
fn stream() -> ExitCode {
    let output = BufWriter::new(io::stdout().lock());
    match run(io::stdin().lock(), output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("bc-conformance: {message}");
            ExitCode::from(2)
        }
    }
}

/// 작업 줄을 끝까지 읽어 결과 줄을 같은 순서로 쓴다.
///
/// - `input`: JSONL 작업
/// - `output`: JSONL 결과를 쓸 곳
/// - 반환: 잘못된 작업이나 입출력 실패면 줄 번호를 담은 이유
fn run(input: impl BufRead, mut output: impl Write) -> Result<(), String> {
    for (index, line) in input.split(b'\n').enumerate() {
        let number = index + 1;
        let line = line.map_err(|error| format!("cannot read task line {number}: {error}"))?;
        let result = evaluate_line(&line).map_err(|reason| {
            format!("task line {number}: {reason}; tasks come from scripts/rust/conformance.mjs, so check that both sides use the same task format")
        })?;
        write_result(&mut output, &result)
            .map_err(|error| format!("cannot write result {number}: {error}"))?;
    }
    output
        .flush()
        .map_err(|error| format!("cannot flush the results: {error}"))
}

/// 작업 줄 하나(JSON 객체)를 읽어 계산한다.
///
/// - `line`: 작업 줄의 바이트
fn evaluate_line(line: &[u8]) -> Result<Results, String> {
    let task = parse_json(line, JsonMode::Standard)
        .map_err(|error| format!("the task is not JSON ({error})"))?;
    match &task {
        JsValue::Object(object) => evaluate(object),
        _ => Err(String::from("the task must be a JSON object")),
    }
}

/// 작업의 `op`로 연산을 찾아 계산한다. 숫자를 쓰는 연산은 두 방언으로 계산한다.
///
/// - `task`: 작업 객체
fn evaluate(task: &JsObject) -> Result<Results, String> {
    let op = text_field(task, "op")?;
    let &(_, operation) = OPERATIONS
        .iter()
        .find(|(name, _)| *name == op)
        .ok_or_else(|| format!("unknown op {op:?}"))?;
    match operation {
        Operation::Plain(compute) => Ok(Results {
            ecma: compute(task)?,
            quickjs: None,
        }),
        Operation::Formatting(compute) => {
            let ecma = compute(task, NumberDialect::Ecma)?;
            let quickjs = compute(task, NumberDialect::QuickJs)?;
            Ok(Results {
                quickjs: (quickjs != ecma).then_some(quickjs),
                ecma,
            })
        }
    }
}

/// 결과 줄 `{"r":"<결과>"}` 또는 `{"r":"<ECMA 결과>","q":"<QuickJS 결과>"}`를 쓴다. 문자열은 커널 writer로
/// 이스케이프한다.
///
/// - `output`: 결과를 쓸 곳
/// - `results`: 정규 결과 문자열들
fn write_result(output: &mut impl Write, results: &Results) -> io::Result<()> {
    let quote = |text: &str| {
        stringify_json(
            &JsValue::String(JsString::from_str(text)),
            JsonMode::Standard,
        )
    };
    output.write_all(b"{\"r\":")?;
    output.write_all(&quote(&results.ecma))?;
    if let Some(quickjs) = &results.quickjs {
        output.write_all(b",\"q\":")?;
        output.write_all(&quote(quickjs))?;
    }
    output.write_all(b"}\n")
}

/// `Number::toString(x)`
fn op_to_string(task: &JsObject, dialect: NumberDialect) -> Outcome {
    Ok(number_to_string_with(bits_field(task, "x")?, dialect))
}

/// `x.toFixed(d)`
fn op_to_fixed(task: &JsObject, dialect: NumberDialect) -> Outcome {
    let digits = ranged_field(task, "d", 0..=MAX_DIGITS)?;
    Ok(to_fixed_with(bits_field(task, "x")?, digits, dialect))
}

/// `x.toPrecision(p)`
fn op_to_precision(task: &JsObject) -> Outcome {
    let precision = ranged_field(task, "p", 1..=MAX_DIGITS)?;
    Ok(to_precision(bits_field(task, "x")?, precision))
}

/// `x.toExponential(d)`. `d`가 없으면 JS의 undefined(최단 자릿수)다.
fn op_to_exponential(task: &JsObject, dialect: NumberDialect) -> Outcome {
    let digits = task
        .get(&JsString::from_str("d"))
        .map(|_| ranged_field(task, "d", 0..=MAX_DIGITS))
        .transpose()?;
    Ok(to_exponential_with(bits_field(task, "x")?, digits, dialect))
}

/// `Math.round(x)`
fn op_round(task: &JsObject) -> Outcome {
    Ok(canonical_number(js_round(bits_field(task, "x")?)))
}

/// `Math.sign(x)`
fn op_sign(task: &JsObject) -> Outcome {
    Ok(canonical_number(js_sign(bits_field(task, "x")?)))
}

/// `Math.max(...xs)`
fn op_max(task: &JsObject) -> Outcome {
    Ok(canonical_number(js_max(&bits_array_field(task, "xs")?)))
}

/// `Math.min(...xs)`
fn op_min(task: &JsObject) -> Outcome {
    Ok(canonical_number(js_min(&bits_array_field(task, "xs")?)))
}

/// `x | 0`
fn op_to_int32(task: &JsObject) -> Outcome {
    Ok(to_int32(bits_field(task, "x")?).to_string())
}

/// `x >>> 0`
fn op_to_uint32(task: &JsObject) -> Outcome {
    Ok(to_uint32(bits_field(task, "x")?).to_string())
}

/// `Object.is(x, y)`
fn op_object_is(task: &JsObject) -> Outcome {
    Ok(same_value(bits_field(task, "x")?, bits_field(task, "y")?).to_string())
}

/// `JSON.stringify(JSON.parse(text))`. 파싱 오류는 `E:SyntaxError`다.
fn op_json(task: &JsObject, dialect: NumberDialect) -> Outcome {
    let text = hex_bytes_field(task, "text")?;
    Ok(match parse_json_with(&text, JsonMode::Standard, dialect) {
        Ok(value) => hex_of_bytes(&stringify_json_with(&value, JsonMode::Standard, dialect)),
        Err(error) => format!("E:{}", error.name),
    })
}

/// JS 문자열(UTF-16 코드 단위, 원문 단독 서로게이트 허용)에 `JSON.parse` 뒤 `JSON.stringify`. 파싱 오류는 `E:SyntaxError`다.
fn op_json_units(task: &JsObject, dialect: NumberDialect) -> Outcome {
    let text = units_field(task, "units")?;
    Ok(
        match parse_json_utf16_with(text.as_units(), JsonMode::Standard, dialect) {
            Ok(value) => hex_of_bytes(&stringify_json_with(&value, JsonMode::Standard, dialect)),
            Err(error) => format!("E:{}", error.name),
        },
    )
}

/// 무손실(BCJSON) 텍스트를 읽어 표준 JSON과 무손실 텍스트로 다시 쓴다: `<표준 16진>,<무손실 16진>`.
fn op_json_lossless(task: &JsObject, dialect: NumberDialect) -> Outcome {
    let text = hex_bytes_field(task, "text")?;
    Ok(match parse_json_with(&text, JsonMode::Lossless, dialect) {
        Ok(value) => format!(
            "{},{}",
            hex_of_bytes(&stringify_json_with(&value, JsonMode::Standard, dialect)),
            hex_of_bytes(&stringify_json_with(&value, JsonMode::Lossless, dialect))
        ),
        Err(error) => format!("E:{}", error.name),
    })
}

/// `String.prototype.trim`
fn op_trim(task: &JsObject) -> Outcome {
    Ok(hex_of_units(
        JsString::trim(&units_field(task, "units")?).as_units(),
    ))
}

/// `String.prototype.toLowerCase`
fn op_to_lower_case(task: &JsObject) -> Outcome {
    Ok(hex_of_units(
        units_field(task, "units")?.to_lowercase().as_units(),
    ))
}

/// `s.slice(start, end)`. `end`가 없으면 JS의 undefined(끝까지)다.
fn op_slice(task: &JsObject) -> Outcome {
    let text = units_field(task, "units")?;
    let start = ranged_field(task, "start", -MAX_EXACT_INTEGER..=MAX_EXACT_INTEGER)?;
    let end = task
        .get(&JsString::from_str("end"))
        .map(|_| ranged_field(task, "end", -MAX_EXACT_INTEGER..=MAX_EXACT_INTEGER))
        .transpose()?;
    Ok(hex_of_units(text.slice(start, end).as_units()))
}

/// `s.length`
fn op_length(task: &JsObject) -> Outcome {
    Ok(units_field(task, "units")?.len_utf16().to_string())
}

/// 코드 단위 하나가 JS 공백인지(`String.fromCharCode(unit).trim() === ''`)
fn op_is_whitespace(task: &JsObject) -> Outcome {
    Ok(is_js_whitespace(ranged_field(task, "unit", 0..=0xFFFF)?).to_string())
}

/// `JSON.stringify(s)`
fn op_quote(task: &JsObject) -> Outcome {
    let text = JsValue::String(units_field(task, "units")?);
    Ok(hex_of_bytes(&stringify_json(&text, JsonMode::Standard)))
}

/// `Date.UTC(year, month0, day, hour, minute, second, ms)`
fn op_date_utc(task: &JsObject) -> Outcome {
    let args = bits_array_field(task, "args")?;
    let &[year, month, day, hour, minute, second, ms] = args.as_slice() else {
        return Err(format!(
            "field \"args\" must hold 7 numbers, found {}",
            args.len()
        ));
    };
    Ok(canonical_number(date_utc(
        year, month, day, hour, minute, second, ms,
    )))
}

/// `new Date(t).getTime()`(TimeClip)
fn op_time_clip(task: &JsObject) -> Outcome {
    Ok(canonical_number(time_clip(bits_field(task, "t")?)))
}

/// `new Date(t).toISOString()`. 범위 밖은 JS가 던지는 `E:RangeError`다.
fn op_to_iso_string(task: &JsObject) -> Outcome {
    Ok(to_iso_string(bits_field(task, "t")?).unwrap_or_else(|| String::from("E:RangeError")))
}

/// 그레고리력 날짜 → 1970-01-01부터의 일수
fn op_days_from_civil(task: &JsObject) -> Outcome {
    let year = integer_field(task, "year")?;
    let month = ranged_field(task, "month", 0..=i64::from(u32::MAX))?;
    let day = ranged_field(task, "day", 0..=i64::from(u32::MAX))?;
    Ok(days_from_civil(year, month, day).to_string())
}

/// 1970-01-01부터의 일수 → `연,월,일`
fn op_civil_from_days(task: &JsObject) -> Outcome {
    let (year, month, day) = civil_from_days(integer_field(task, "days")?);
    Ok(format!("{year},{month},{day}"))
}

/// M0 시간대 계약의 날짜 파서 → `연,월,일` 또는 `none`
fn op_parse_iso_date(task: &JsObject) -> Outcome {
    let text = utf8_field(task, "text")?;
    Ok(parse_iso_date(&text).map_or_else(
        || String::from("none"),
        |(year, month, day)| format!("{year},{month},{day}"),
    ))
}

/// M0 시간대 계약의 시각 파서 → `시,분,초` 또는 `none`
fn op_parse_iso_clock(task: &JsObject) -> Outcome {
    let text = utf8_field(task, "text")?;
    Ok(parse_iso_clock(&text).map_or_else(
        || String::from("none"),
        |(hour, minute, second)| format!("{hour},{minute},{second}"),
    ))
}

/// 필드 값을 찾는다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn field<'a>(task: &'a JsObject, name: &str) -> Result<&'a JsValue, String> {
    task.get(&JsString::from_str(name))
        .ok_or_else(|| format!("missing field {name:?}"))
}

/// 문자열 필드를 읽는다(필드는 ASCII라 손실이 없다).
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn text_field(task: &JsObject, name: &str) -> Result<String, String> {
    match field(task, name)? {
        JsValue::String(text) => Ok(text.to_string_lossy()),
        _ => Err(format!("field {name:?} must be a string")),
    }
}

/// 16진 비트 필드를 수로 읽는다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn bits_field(task: &JsObject, name: &str) -> Result<f64, String> {
    bits_value(field(task, name)?).ok_or_else(|| format!("field {name:?} must be 16 hex digits"))
}

/// 16진 비트 배열 필드를 수 배열로 읽는다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn bits_array_field(task: &JsObject, name: &str) -> Result<Vec<f64>, String> {
    let invalid = || format!("field {name:?} must be an array of 16 hex digit strings");
    match field(task, name)? {
        JsValue::Array(items) => items
            .iter()
            .map(|item| bits_value(item).ok_or_else(invalid))
            .collect(),
        _ => Err(invalid()),
    }
}

/// 16진 16자리 문자열 값을 IEEE-754 비트로 읽는다. 부호(`+`)나 다른 글자가 섞이면 `None`이다.
///
/// - `value`: 필드 값
fn bits_value(value: &JsValue) -> Option<f64> {
    let JsValue::String(text) = value else {
        return None;
    };
    let hex = text.to_string_lossy();
    if hex.len() != 16 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(&hex, 16).ok().map(f64::from_bits)
}

/// 정수 필드를 읽는다. JSON 수가 ±2^53 안의 정수여야 한다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn integer_field(task: &JsObject, name: &str) -> Result<i64, String> {
    let limit = MAX_EXACT_INTEGER as f64;
    match field(task, name)? {
        // ±2^53 안의 정수라 i64로 정확히 바뀐다
        JsValue::Number(number) if number.fract() == 0.0 && number.abs() <= limit => {
            Ok(*number as i64)
        }
        _ => Err(format!("field {name:?} must be an integer within ±2^53")),
    }
}

/// 범위를 확인한 정수 필드를 원하는 정수 타입으로 읽는다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
/// - `range`: 허용 범위
fn ranged_field<T: TryFrom<i64>>(
    task: &JsObject,
    name: &str,
    range: RangeInclusive<i64>,
) -> Result<T, String> {
    let value = integer_field(task, name)?;
    if !range.contains(&value) {
        return Err(format!(
            "field {name:?} = {value} is outside {}..={}",
            range.start(),
            range.end()
        ));
    }
    T::try_from(value).map_err(|_| format!("field {name:?} = {value} does not fit this platform"))
}

/// UTF-8 바이트를 16진으로 담은 필드를 읽는다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn hex_bytes_field(task: &JsObject, name: &str) -> Result<Vec<u8>, String> {
    let digits = decode_hex(&text_field(task, name)?, 2)
        .ok_or_else(|| format!("field {name:?} must be hex bytes"))?;
    Ok(digits.into_iter().map(|digit| digit as u8).collect())
}

/// UTF-8 바이트를 16진으로 담은 필드를 문자열로 읽는다. 올바른 UTF-8이어야 한다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn utf8_field(task: &JsObject, name: &str) -> Result<String, String> {
    String::from_utf8(hex_bytes_field(task, name)?)
        .map_err(|error| format!("field {name:?} is not UTF-8 ({error})"))
}

/// UTF-16 코드 단위를 단위마다 16진 네 자리로 담은 필드를 문자열로 읽는다.
///
/// - `task`: 작업 객체
/// - `name`: 필드 이름
fn units_field(task: &JsObject, name: &str) -> Result<JsString, String> {
    let digits = decode_hex(&text_field(task, name)?, 4)
        .ok_or_else(|| format!("field {name:?} must be hex UTF-16 code units"))?;
    Ok(JsString::from_utf16(
        digits.into_iter().map(|digit| digit as u16).collect(),
    ))
}

/// 16진 문자열을 `width`자리씩 읽는다. 길이가 맞지 않거나 16진이 아닌 글자가 있으면 `None`이다.
///
/// - `text`: 16진 문자열
/// - `width`: 값 하나의 자릿수(2 또는 4라 u32에 들어간다)
fn decode_hex(text: &str, width: usize) -> Option<Vec<u32>> {
    if !text.len().is_multiple_of(width) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    text.as_bytes()
        .chunks(width)
        .map(|chunk| {
            chunk.iter().try_fold(0_u32, |value, &digit| {
                char::from(digit)
                    .to_digit(16)
                    .map(|nibble| value * 16 + nibble)
            })
        })
        .collect()
}

/// 수 결과의 정규 문자열: NaN이면 `NaN`(페이로드와 무관), 아니면 16진 비트(-0은 `8000000000000000`).
///
/// - `value`: 수
fn canonical_number(value: f64) -> String {
    if value.is_nan() {
        String::from("NaN")
    } else {
        format!("{:016x}", value.to_bits())
    }
}

/// 바이트를 소문자 16진으로 쓴다.
///
/// - `bytes`: 바이트
fn hex_of_bytes(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        push_hex(&mut text, u32::from(byte), 2);
    }
    text
}

/// UTF-16 코드 단위를 단위마다 16진 네 자리로 쓴다.
///
/// - `units`: 코드 단위
fn hex_of_units(units: &[u16]) -> String {
    let mut text = String::with_capacity(units.len() * 4);
    for &unit in units {
        push_hex(&mut text, u32::from(unit), 4);
    }
    text
}

/// 값의 아래 `width` 니블을 소문자 16진으로 붙인다.
///
/// - `text`: 결과 문자열
/// - `value`: 값
/// - `width`: 자릿수
fn push_hex(text: &mut String, value: u32, width: u32) {
    for shift in (0..width).rev() {
        let nibble = (value >> (shift * 4)) & 0xF;
        text.push(char::from(HEX_DIGITS[nibble as usize]));
    }
}

#[cfg(test)]
mod tests {
    use super::run;

    /// 작업 줄들을 계산해 결과 줄 전체를 돌려준다.
    fn results(input: &str) -> Result<String, String> {
        let mut output = Vec::new();
        run(input.as_bytes(), &mut output)?;
        String::from_utf8(output).map_err(|error| error.to_string())
    }

    /// 작업마다 결과 줄 하나를 같은 순서로 쓰고, 수 결과는 NaN을 정규화한 16진 비트다.
    #[test]
    fn writes_one_canonical_result_line_per_task_in_order() {
        let input = concat!(
            "{\"op\":\"toFixed\",\"x\":\"3fc0000000000000\",\"d\":2}\n",
            "{\"op\":\"round\",\"x\":\"bfd999999999999a\"}\n",
            "{\"op\":\"round\",\"x\":\"7ff0000000000001\"}\n",
            "{\"op\":\"toExponential\",\"x\":\"0000000000000000\"}\n",
            "{\"op\":\"json\",\"text\":\"7b2262223a312c2231223a327d\"}\n",
            "{\"op\":\"slice\",\"units\":\"d83dde00\",\"start\":0,\"end\":1}\n",
            "{\"op\":\"parseIsoDate\",\"text\":\"323032362d30322d3330\"}\n",
            "{\"op\":\"jsonUnits\",\"units\":\"0022d83d005c007500640065003000300022\"}\n",
            "{\"op\":\"jsonUnits\",\"units\":\"007b0022d83d0022003a0031007d\"}\n",
            "{\"op\":\"jsonUnits\",\"units\":\"d83d\"}\n",
        );
        let expected = concat!(
            "{\"r\":\"0.13\"}\n",
            "{\"r\":\"8000000000000000\"}\n",
            "{\"r\":\"NaN\"}\n",
            "{\"r\":\"0e+0\"}\n",
            "{\"r\":\"7b2231223a322c2262223a317d\"}\n",
            "{\"r\":\"d83d\"}\n",
            "{\"r\":\"none\"}\n",
            "{\"r\":\"22f09f988022\"}\n",
            "{\"r\":\"7b225c7564383364223a317d\"}\n",
            "{\"r\":\"E:SyntaxError\"}\n",
        );
        assert_eq!(results(input), Ok(String::from(expected)));
    }

    /// 숫자를 쓰는 연산은 QuickJS 방언 결과가 ECMA 결과와 다를 때만 `q`를 더한다(2 ** -24, 2 ** 89).
    #[test]
    fn adds_the_quickjs_dialect_result_only_when_it_differs() {
        let input = concat!(
            "{\"op\":\"toString\",\"x\":\"3e70000000000000\"}\n",
            "{\"op\":\"toString\",\"x\":\"3ff0000000000000\"}\n",
            "{\"op\":\"toFixed\",\"x\":\"4580000000000000\",\"d\":2}\n",
            "{\"op\":\"toExponential\",\"x\":\"3e70000000000000\"}\n",
            "{\"op\":\"toPrecision\",\"x\":\"3e70000000000000\",\"p\":3}\n",
            "{\"op\":\"json\",\"text\":\"5b352e39363034363434373735333930363235652d385d\"}\n",
        );
        let expected = concat!(
            "{\"r\":\"5.960464477539063e-8\",\"q\":\"5.9604644775390625e-8\"}\n",
            "{\"r\":\"1\"}\n",
            "{\"r\":\"6.189700196426902e+26\",\"q\":\"6.1897001964269014e+26\"}\n",
            "{\"r\":\"5.960464477539063e-8\",\"q\":\"5.9604644775390625e-8\"}\n",
            "{\"r\":\"5.96e-8\"}\n",
            "{\"r\":\"5b352e393630343634343737353339303633652d385d\",",
            "\"q\":\"5b352e39363034363434373735333930363235652d385d\"}\n",
        );
        assert_eq!(results(input), Ok(String::from(expected)));
    }

    /// JSON의 q 결과는 쓰기 방언뿐 아니라 QuickJS의 38자리 숫자 파싱도 반영한다.
    #[test]
    fn json_results_use_the_parsing_dialect_before_stringifying() {
        let text = format!("9007199254740993.{}1", "0".repeat(22));
        let ecma = super::hex_of_bytes(b"9007199254740994");
        let quickjs = super::hex_of_bytes(b"9007199254740992");
        for op in ["json", "jsonUnits", "jsonLossless"] {
            let (field, source) = if op == "jsonUnits" {
                (
                    "units",
                    super::hex_of_units(&text.encode_utf16().collect::<Vec<_>>()),
                )
            } else {
                ("text", super::hex_of_bytes(text.as_bytes()))
            };
            let (r, q) = if op == "jsonLossless" {
                (format!("{ecma},{ecma}"), format!("{quickjs},{quickjs}"))
            } else {
                (ecma.clone(), quickjs.clone())
            };
            let input = format!("{{\"op\":\"{op}\",\"{field}\":\"{source}\"}}\n");
            assert_eq!(
                results(&input),
                Ok(format!("{{\"r\":\"{r}\",\"q\":\"{q}\"}}\n")),
                "{op}"
            );
        }
    }

    /// 잘못된 작업은 줄 번호와 이유를 담아 거절한다(하네스와 형식이 어긋난 것을 조용히 넘기지 않는다).
    #[test]
    fn rejects_malformed_tasks_with_the_line_number_and_reason() {
        let ok = "{\"op\":\"length\",\"units\":\"0061\"}\n";
        for (task, reason) in [
            ("{\"op\":\"nope\"}", "unknown op"),
            (
                "{\"op\":\"toFixed\",\"x\":\"3fc0000000000000\"}",
                "missing field \"d\"",
            ),
            (
                "{\"op\":\"toFixed\",\"x\":\"3fc0\",\"d\":2}",
                "16 hex digits",
            ),
            (
                "{\"op\":\"toFixed\",\"x\":\"+fc0000000000000\",\"d\":2}",
                "16 hex digits",
            ),
            (
                "{\"op\":\"toFixed\",\"x\":\"3fc0000000000000\",\"d\":101}",
                "outside 0..=100",
            ),
            (
                "{\"op\":\"toPrecision\",\"x\":\"3fc0000000000000\",\"p\":0.5}",
                "integer",
            ),
            ("{\"op\":\"quote\",\"units\":\"006\"}", "hex UTF-16"),
            (
                "{\"op\":\"dateUtc\",\"args\":[\"0000000000000000\"]}",
                "7 numbers",
            ),
            ("{\"op\":\"parseIsoDate\",\"text\":\"ff\"}", "not UTF-8"),
            ("[1]", "JSON object"),
            ("{\"op\":", "not JSON"),
        ] {
            let outcome = results(&format!("{ok}{task}\n"));
            let message = outcome.expect_err(task);
            assert!(message.contains("task line 2"), "{task}: {message}");
            assert!(message.contains(reason), "{task}: {message}");
        }
    }
}
