//! JS `Number` 의미: `Number::toString`, `toFixed`/`toPrecision`/`toExponential`,
//! `Math.round`/`max`/`min`/`sign`, `ToInt32`/`ToUint32`, `Object.is`
//! (설계 §6.4, 이식 지도 §3.1.1·§5).
//!
//! - `Number::toString`은 ryu-js(=1.0.3)로 쓴다. V8·JSC와 대조해 불일치가 없었다. Rust std의 최단 자릿수는
//!   동률에서 V8과 다르고, `Display`는 `1e21`을 정수로, `1e-7`을 `0.0000001`로 쓴다.
//! - 오라클은 같은 기기의 JS 백엔드다(설계 §6.1). QuickJS 2026-06-04(Android)는 정규수 2의 거듭제곱 54개 지수
//!   (부호 포함 108값)에서 최단이 아닌 17자리를 쓰므로(`NumberDialect` 참고), Android 빌드는 그 규칙을 따른다.
//!   방언은 `NumberDialect::PLATFORM`(Android는 QuickJS, 그 밖은 ECMA-262)이 정하고, `_with` 함수로 고를 수 있다.
//! - 자릿수를 정하는 세 포맷은 `{:.766e}`로 얻은 정확한 십진 전개를 잘라, 버린 첫 자리가 5 이상이면
//!   절댓값을 올린다. 전개가 정확하므로 이것이 ECMA-262의 '두 후보가 같으면 큰 쪽' 규칙이다.
//!   Rust `{:.N}`은 동률을 짝수 쪽으로 보내고 `-0.00`을 내므로 쓰지 않는다.
//! - 범위 밖 자릿수(`digits > 100` 등)는 호출자(코어)가 JS의 RangeError 문구로 막는다.
//!   이 모듈은 `debug_assert!`만 둔다. release에서는 범위 밖 값도 패닉 없이 처리하지만 결과 문자열은
//!   정하지 않으며, 결과 길이(메모리)는 자릿수에 비례한다.

/// ToInt32·ToUint32의 모듈로 2^32
const TWO_POW_32: f64 = 4_294_967_296.0;

/// `toFixed`가 `Number::toString`으로 넘어가는 경계 10^21(ECMA-262 `Number.prototype.toFixed` 10단계)
const FIXED_NOTATION_LIMIT: f64 = 1e21;

/// `toFixed`·`toExponential` 자릿수와 `toPrecision` 유효 숫자의 상한. 넘으면 JS는 RangeError를 던진다
const MAX_DIGITS: u32 = 100;

/// `toPrecision`이 고정 표기를 쓰는 가장 작은 지수. 이보다 작으면 지수 표기다(`e < -6`)
const MIN_FIXED_EXPONENT: i64 = -6;

/// -0의 비트. `Math.max`/`min`은 +0과 -0을 가른다
const NEGATIVE_ZERO_BITS: u64 = 0x8000_0000_0000_0000;

/// QuickJS `js_dtoa`(FORMAT_FREE, 10진)가 처음 시험하는 자릿수. 17자리면 어떤 f64도 왕복한다(`dtoa_max_digits_table`)
const QUICKJS_MAX_DIGITS: usize = 17;

/// f64 가수(52비트) 마스크
const MANTISSA_MASK: u64 = (1 << 52) - 1;

/// `Number::toString`이 고정 표기를 쓰는 소수점 위치 n의 상한(ECMA-262 Number::toString: `n ≤ 21`)
const TO_STRING_MAX_POINT: i64 = 21;

/// `Number::toString`이 `0.000…` 표기를 쓰는 소수점 위치 n의 하한(이보다 커야 한다: `-6 < n`)
const TO_STRING_MIN_POINT: i64 = -6;

/// 숫자 텍스트 변환에 따르는 JS 엔진 방언(`Number::toString` 자릿수와 JSON 숫자 파싱).
///
/// 설계 §6.1은 같은 기기의 JS 백엔드를 오라클로 정한다(iOS는 JSC, Android는 QuickJS). 숫자 쓰기의 차이는 다음과 같다.
/// QuickJS 2026-06-04의 `js_dtoa`(FORMAT_FREE)는 17자리에서 시작해 자릿수를 하나씩 줄이며 가장 가까운(RNDN) 후보
/// 하나만 왕복 검사하고, 처음 실패한 곳에서 멈춘다(`native/android/quickjs/dtoa.c` `js_dtoa`). IEEE 반올림 구간이
/// 비대칭인 정규수 2의 거듭제곱(가수 0, 지수 필드 2 이상)에서는 가장 가까운 후보가 아래쪽의 좁은 반 구간 밖으로
/// 나가 검사가 실패할 수 있다. 그래서 2,045개 가운데 54개 지수(부호 포함 108값)에서 최단(13~16자리)이 아닌
/// 17자리를 쓴다(`2 ** -24` → `5.9604644775390625e-8`, V8·JSC는 `5.960464477539063e-8`, 2026-11-02 실측).
/// 숫자 쓰기에서 그 밖의 수는 두 방언이 같다. 구간이 대칭이면 가장 가까운 후보가 최단 후보와 같기 때문이다.
///
/// `String(x)`, 템플릿 문자열, `JSON.stringify`, `toExponential()`, `toPrecision(undefined)`, `|x| ≥ 1e21`의
/// `toFixed`가 이 자릿수를 쓴다. JSON 텍스트 길이가 문서 한도와 undo 가중치를 정하므로(설계 §6.4) Android에서도
/// 바이트가 같아야 한다.
/// JSON 숫자 읽기는 QuickJS가 십진 가수의 첫 38자리만 반올림에 쓴다. `json::parse_json_with`도 이 방언을 받는다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumberDialect {
    /// ECMA-262: 최단 숫자 표기(V8, JSC; ryu-js), JSON 숫자는 정확한 반올림
    Ecma,
    /// QuickJS 2026-06-04: 일부 2의 거듭제곱은 17자리로 쓰고, JSON 숫자는 십진 가수 38자리까지만 읽는다
    QuickJs,
}

impl NumberDialect {
    /// 이 빌드의 같은 기기 JS 백엔드 방언: Android는 QuickJS, 그 밖(iOS·macOS의 JSC, wasm32 하네스의 V8)은 ECMA-262.
    ///
    /// 방언 인자가 없는 함수(`number_to_string`, `to_fixed`, `to_exponential`, `json::stringify_json`)가 쓴다.
    /// 다른 방언은 대조 하네스(`bc-conformance`)와 테스트가 `_with` 함수로 고른다.
    pub const PLATFORM: NumberDialect = if cfg!(target_os = "android") {
        NumberDialect::QuickJs
    } else {
        NumberDialect::Ecma
    };
}

/// 십진 자릿수와 지수. 값은 `d0.d1d2… × 10^exponent`다.
struct Decimal {
    /// 앞에서부터의 십진 자릿수(ASCII). 0이 아닌 수에서는 첫 자리가 0이 아니다
    digits: Vec<u8>,
    /// 첫 자리의 십진 지수
    exponent: i64,
}

/// ECMA-262 `Number::toString(x, 10)`. JS의 `String(x)`, 템플릿 문자열, `JSON.stringify`의 숫자와 같다.
///
/// 이 빌드의 방언(`NumberDialect::PLATFORM`)을 쓴다. 다른 방언은 `number_to_string_with`로 고른다.
/// - 최단 왕복 자릿수를 쓰고, `|x| >= 1e21` 또는 `|x| < 1e-6`이면 지수 표기(`1e+21`, `1.5e-7`)다.
/// - `-0`은 `"0"`, NaN은 `"NaN"`, 무한대는 `"Infinity"`/`"-Infinity"`다.
pub fn number_to_string(x: f64) -> String {
    number_to_string_with(x, NumberDialect::PLATFORM)
}

/// `Number::toString(x, 10)`을 주어진 방언으로 쓴다.
///
/// - `x`: 쓸 수
/// - `dialect`: ECMA-262(V8·JSC) 또는 QuickJS. QuickJS는 정규수 2의 거듭제곱에서만 다를 수 있다(`NumberDialect`)
/// - 반환: JS 문자열과 같은 텍스트
pub fn number_to_string_with(x: f64, dialect: NumberDialect) -> String {
    if dialect == NumberDialect::QuickJs && has_asymmetric_rounding_interval(x) {
        let mut text = sign_prefix(x);
        push_to_string_layout(&mut text, &quickjs_shortest_decimal(x.abs()));
        return text;
    }
    ryu_js::Buffer::new().format(x).to_owned()
}

/// ECMA-262 `Number.prototype.toFixed(digits)`.
///
/// - `digits`는 0..=100이다. JS는 이 범위를 비유한 수 검사보다 먼저 보므로 `(NaN).toFixed(101)`도
///   RangeError다. 호출자는 x와 무관하게 범위를 먼저 막는다.
/// - 비유한 수와 `|x| >= 1e21`은 `number_to_string(x)`다.
/// - 그 밖에는 `n / 10^digits - x`가 0에 가장 가까운 정수 n을 고르고, 둘이면 큰 n을 고른다
///   (`0.125` → `"0.13"`, `2.5` → `"3"`). 부호는 `x < 0`일 때만 붙는다(`-0` → `"0.00"`, `-1e-10` → `"-0.00"`).
/// - 이 빌드의 방언을 쓴다(`|x| >= 1e21`의 `number_to_string`). 다른 방언은 `to_fixed_with`로 고른다.
pub fn to_fixed(x: f64, digits: u32) -> String {
    to_fixed_with(x, digits, NumberDialect::PLATFORM)
}

/// `Number.prototype.toFixed(digits)`를 주어진 방언으로 쓴다. 방언은 `|x| >= 1e21`(`Number::toString`)에서만 뜻이 있다.
///
/// - `x`: 쓸 수
/// - `digits`: 0..=100
/// - `dialect`: `Number::toString`의 방언
/// - 반환: JS 문자열과 같은 텍스트
pub fn to_fixed_with(x: f64, digits: u32, dialect: NumberDialect) -> String {
    debug_assert!(
        digits <= MAX_DIGITS,
        "toFixed digits {digits} is outside 0..=100; the caller must throw RangeError first"
    );
    if !x.is_finite() || x.abs() >= FIXED_NOTATION_LIMIT {
        return number_to_string_with(x, dialect);
    }
    let mut text = sign_prefix(x);
    push_fixed(
        &mut text,
        &scaled_integer_digits(x.abs(), digits),
        digits as usize,
    );
    text
}

/// ECMA-262 `Number.prototype.toPrecision(precision)`(precision이 undefined가 아닐 때).
///
/// - `precision`은 1..=100이다. JS는 비유한 수를 범위 검사보다 먼저 돌려주므로 `(NaN).toPrecision(0)`은
///   `"NaN"`이다. precision이 undefined면 호출자가 `number_to_string`을 쓴다.
/// - 유효 숫자 p자리로 반올림한 뒤(동률은 큰 쪽), 올림을 반영한 지수 e가 `e < -6 || e >= p`면
///   지수 표기, 아니면 고정 표기다(`99.99`를 2자리로 → `"1.0e+2"`). `±0`은 부호 없이 `"0.000…"`이다.
pub fn to_precision(x: f64, precision: u32) -> String {
    if !x.is_finite() {
        return number_to_string(x);
    }
    debug_assert!(
        (1..=MAX_DIGITS).contains(&precision),
        "toPrecision precision {precision} is outside 1..=100; the caller must throw RangeError first"
    );
    let decimal = rounded_or_zero(x, precision as usize);
    let mut text = sign_prefix(x);
    if decimal.exponent < MIN_FIXED_EXPONENT || decimal.exponent >= i64::from(precision) {
        push_exponential(&mut text, &decimal);
    } else {
        push_positional(&mut text, &decimal);
    }
    text
}

/// ECMA-262 `Number.prototype.toExponential(digits)`.
///
/// - `digits`는 `Some(0..=100)` 또는 `None`(undefined)이다. JS는 비유한 수를 범위 검사보다 먼저 돌려준다.
/// - `Some(f)`는 유효 숫자 f+1자리로 반올림하고(동률은 큰 쪽), `None`은 `number_to_string`과 같은
///   최단 왕복 자릿수를 쓴다.
/// - 지수 부호는 늘 쓴다(`0.00e+0`, `1.23e+2`). `±0`에는 부호를 붙이지 않는다.
/// - 이 빌드의 방언을 쓴다(`None`의 최단 자릿수). 다른 방언은 `to_exponential_with`로 고른다.
pub fn to_exponential(x: f64, digits: Option<u32>) -> String {
    to_exponential_with(x, digits, NumberDialect::PLATFORM)
}

/// `Number.prototype.toExponential(digits)`를 주어진 방언으로 쓴다. 방언은 `None`(최단 자릿수)에서만 뜻이 있다.
///
/// - `x`: 쓸 수
/// - `digits`: `Some(0..=100)` 또는 `None`(undefined)
/// - `dialect`: 최단 자릿수의 방언
/// - 반환: JS 문자열과 같은 텍스트
pub fn to_exponential_with(x: f64, digits: Option<u32>, dialect: NumberDialect) -> String {
    if !x.is_finite() {
        return number_to_string_with(x, dialect);
    }
    debug_assert!(
        digits.is_none_or(|count| count <= MAX_DIGITS),
        "toExponential digits {digits:?} is outside 0..=100; the caller must throw RangeError first"
    );
    let decimal = match digits {
        Some(count) => rounded_or_zero(x, count as usize + 1),
        None if x == 0.0 => zero_decimal(1),
        None => shortest_decimal(x.abs(), dialect),
    };
    let mut text = sign_prefix(x);
    push_exponential(&mut text, &decimal);
    text
}

/// ECMA-262 `Math.round(x)`: 가장 가까운 정수, 동률은 +∞ 쪽(`-2.5` → `-2`, `-0.4` → `-0`).
///
/// 이식 지도 §3.1.1의 모양 그대로다. `f64::round`(동률은 0에서 먼 쪽)와 `floor(x + 0.5)`
/// (`0.49999999999999994` → 1, `2^52 + 1` → `2^52 + 2`)는 JS와 다르다.
/// 1. NaN, ±Infinity, ±0은 그대로 돌려준다.
/// 2. `0 < x < 0.5`는 +0, `-0.5 <= x < 0`은 -0이다.
/// 3. 나머지는 `r = floor(x)`로 두고 `x - r >= 0.5`면 `r + 1`, 아니면 r이다. 이 범위에서 뺄셈은 정확하다.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// ECMA-262 `Math.max(...values)`: NaN이 하나라도 있으면 NaN, +0은 -0보다 크고, 빈 입력은 -Infinity다.
///
/// `f64::max`는 NaN을 버리고 0의 부호를 정하지 않으므로 쓰지 않는다.
pub fn js_max(values: &[f64]) -> f64 {
    let mut highest = f64::NEG_INFINITY;
    for &number in values {
        if number.is_nan() {
            return f64::NAN;
        }
        if number > highest || (number.to_bits() == 0 && highest.to_bits() == NEGATIVE_ZERO_BITS) {
            highest = number;
        }
    }
    highest
}

/// ECMA-262 `Math.min(...values)`: NaN이 하나라도 있으면 NaN, -0은 +0보다 작고, 빈 입력은 Infinity다.
///
/// `f64::min`은 NaN을 버리고 0의 부호를 정하지 않으므로 쓰지 않는다.
pub fn js_min(values: &[f64]) -> f64 {
    let mut lowest = f64::INFINITY;
    for &number in values {
        if number.is_nan() {
            return f64::NAN;
        }
        if number < lowest || (number.to_bits() == NEGATIVE_ZERO_BITS && lowest.to_bits() == 0) {
            lowest = number;
        }
    }
    lowest
}

/// ECMA-262 `Math.sign(x)`: NaN과 ±0은 그대로, 음수는 -1, 양수는 1이다.
///
/// `f64::signum`은 ±0에 ±1을 내므로 쓰지 않는다.
pub fn js_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x < 0.0 {
        -1.0
    } else {
        1.0
    }
}

/// ECMA-262 `ToInt32(x)`(`x | 0`): `to_uint32`와 같은 32비트를 부호 있는 정수로 읽는다.
///
/// `x as i32`는 범위 밖을 포화시키므로(2147483648 → `i32::MAX`) 쓰지 않는다.
pub fn to_int32(x: f64) -> i32 {
    to_uint32(x).cast_signed()
}

/// ECMA-262 `ToUint32(x)`(`x >>> 0`): 비유한 수와 ±0은 0, 그 밖에는 0 쪽으로 버린 정수를 2^32로 나눈 나머지다.
///
/// `x as u32`는 범위 밖을 포화시키므로(4294967296.5 → `u32::MAX`) 나머지를 직접 계산한다.
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    // f64 나머지(fmod)는 정확하고 결과는 (-2^32, 2^32)의 정수다. 음수에 2^32를 더해도 2^53 미만의 정수라 정확하다.
    let remainder = x.trunc() % TWO_POW_32;
    let wrapped = if remainder < 0.0 {
        remainder + TWO_POW_32
    } else {
        remainder
    };
    // 0 <= wrapped < 2^32인 정수라 변환이 정확하다(-0.0은 0이 된다)
    wrapped as u32
}

/// ECMA-262 `SameValue(a, b)`(`Object.is`): NaN끼리는 같고(페이로드와 무관), +0과 -0은 다르다.
///
/// NaN이 아니면 같은 수의 비트 표현은 하나뿐이라 비트가 같을 때만 같다.
pub fn same_value(a: f64, b: f64) -> bool {
    if a.is_nan() || b.is_nan() {
        return a.is_nan() && b.is_nan();
    }
    a.to_bits() == b.to_bits()
}

/// 결과 문자열을 부호로 시작한다. 부호는 `x < 0`일 때만 붙는다(-0에는 붙지 않는다).
///
/// - `x`: 포맷할 유한한 수
/// - 반환: `"-"` 또는 빈 문자열
fn sign_prefix(x: f64) -> String {
    if x < 0.0 {
        String::from("-")
    } else {
        String::new()
    }
}

/// 유효 숫자 `length`자리로 반올림한 십진 표현을 얻는다. `±0`은 0이 `length`개인 자릿수와 지수 0이다.
///
/// - `x`: 유한한 수(부호는 버린다)
/// - `length`: 남길 유효 숫자 수
fn rounded_or_zero(x: f64, length: usize) -> Decimal {
    if x == 0.0 {
        zero_decimal(length)
    } else {
        significant_decimal(x.abs(), length)
    }
}

/// 0을 자릿수 `length`개로 나타낸다(ECMA-262 `toPrecision` 9단계, `toExponential` 9단계).
///
/// - `length`: 0의 개수
fn zero_decimal(length: usize) -> Decimal {
    Decimal {
        digits: vec![b'0'; length],
        exponent: 0,
    }
}

/// 0이 아닌 유한한 크기를 유효 숫자 `length`자리로 반올림한다(동률은 큰 쪽).
///
/// 올림이 맨 앞을 넘으면(`9.99` → `10.0`) 자릿수를 `length`로 되돌리고 지수를 1 올린다.
/// - `magnitude`: 0보다 큰 유한한 수
/// - `length`: 남길 유효 숫자 수
fn significant_decimal(magnitude: f64, length: usize) -> Decimal {
    let exact = exact_decimal(magnitude);
    let (mut digits, carried) = round_half_up(&exact.digits, length);
    digits.truncate(length);
    Decimal {
        digits,
        exponent: exact.exponent + i64::from(carried),
    }
}

/// `round(magnitude × 10^fraction_digits)`의 십진 자릿수를 낸다. 동률은 큰 쪽이고, 0이면 빈 벡터다.
///
/// 정확한 전개에서 `10^-fraction_digits` 자리까지 남기고 그다음 자리로 반올림한다.
/// 올림이 맨 앞을 넘으면 자릿수가 하나 늘어난 정수가 된다(`999.9999`, 3자리 → `1000000`).
/// - `magnitude`: 0 이상 1e21 미만의 유한한 수
/// - `fraction_digits`: 소수부 자릿수
fn scaled_integer_digits(magnitude: f64, fraction_digits: u32) -> Vec<u8> {
    if magnitude == 0.0 {
        return Vec::new();
    }
    let exact = exact_decimal(magnitude);
    // 첫 자리(10^exponent)부터 10^-fraction_digits 자리까지의 자릿수. 음수면 값이 10^-(fraction_digits+1)보다 작아 0이다
    let kept_length = exact.exponent + i64::from(fraction_digits) + 1;
    match usize::try_from(kept_length) {
        Ok(length) => round_half_up(&exact.digits, length).0,
        Err(_) => Vec::new(),
    }
}

/// 정확한 자릿수의 앞 `length`자리를 남기고, 버린 첫 자리가 5 이상이면 남긴 자리를 1 올린다.
///
/// 전개가 정확하므로 버린 쪽이 `5000…`이면 정확한 동률이고, 올리는 쪽이 ECMA-262가 고르는 '큰 쪽'이다.
/// 전개보다 뒤의 자리는 0으로 본다.
/// - `digits`: 정확한 십진 자릿수(ASCII)
/// - `length`: 남길 자릿수
/// - 반환: 남긴 자릿수와, 올림이 맨 앞을 넘어 자릿수가 하나 늘었는지(`999` → `1000`)
fn round_half_up(digits: &[u8], length: usize) -> (Vec<u8>, bool) {
    let kept: Vec<u8> = (0..length).map(|index| digit_at(digits, index)).collect();
    if digit_at(digits, length) < b'5' {
        return (kept, false);
    }
    increment_digits(kept)
}

/// 정확한 전개를 유효 숫자 `length`자리로 RNDN 반올림한다(동률은 마지막 자리가 짝수인 쪽). 뒤의 0은 지운다.
///
/// QuickJS FORMAT_FREE가 후보를 만드는 반올림이다(`mul_pow_round(..., JS_RNDN)`). 올림이 맨 앞을 넘으면
/// 지수를 1 올린다(`9.99…` → `1`).
/// - `exact`: 0이 아닌 수의 정확한 십진 전개
/// - `length`: 남길 유효 숫자 수(1 이상)
fn round_half_even(exact: &Decimal, length: usize) -> Decimal {
    let kept: Vec<u8> = (0..length)
        .map(|index| digit_at(&exact.digits, index))
        .collect();
    let next = digit_at(&exact.digits, length);
    let rest_is_zero = exact
        .digits
        .get(length + 1..)
        .is_none_or(|rest| rest.iter().all(|&digit| digit == b'0'));
    let last_is_odd = kept.last().is_some_and(|&digit| (digit - b'0') % 2 == 1);
    let round_up = next > b'5' || (next == b'5' && (!rest_is_zero || last_is_odd));
    let (mut digits, carried) = if round_up {
        increment_digits(kept)
    } else {
        (kept, false)
    };
    digits.truncate(length);
    while digits.len() > 1 && digits.last() == Some(&b'0') {
        digits.pop();
    }
    Decimal {
        digits,
        exponent: exact.exponent + i64::from(carried),
    }
}

/// 십진 자릿수를 1 올린다. 맨 앞을 넘으면 `1`을 앞에 붙인다(`999` → `1000`).
///
/// - `kept`: 올릴 자릿수(ASCII)
/// - 반환: 올린 자릿수와, 자릿수가 하나 늘었는지
fn increment_digits(mut kept: Vec<u8>) -> (Vec<u8>, bool) {
    for digit in kept.iter_mut().rev() {
        if *digit < b'9' {
            *digit += 1;
            return (kept, false);
        }
        *digit = b'0';
    }
    kept.insert(0, b'1');
    (kept, true)
}

/// 자릿수 배열의 `index`번째 자리. 정확한 전개 뒤의 자리는 0이다.
///
/// - `digits`: 십진 자릿수(ASCII)
/// - `index`: 0부터 세는 자리
fn digit_at(digits: &[u8], index: usize) -> u8 {
    digits.get(index).copied().unwrap_or(b'0')
}

/// 0이 아닌 유한한 크기의 정확한 십진 전개를 얻는다.
///
/// 유한한 f64의 정확한 십진 전개는 유효 숫자가 많아야 767자리(정규수 최솟값 부근)다. 그래서 첫 자리 뒤
/// 766자리를 쓰는 `{:.766e}`는 반올림 없이 정확하고, 남는 자리는 0으로 채워진다.
/// 출력은 `d.ddd…e-N` 또는 `d.ddd…eN`(양수 지수에 + 없음)이다.
/// - `magnitude`: 0보다 큰 유한한 수
fn exact_decimal(magnitude: f64) -> Decimal {
    let text = format!("{magnitude:.766e}");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text.as_str(), "0"));
    Decimal {
        digits: mantissa.bytes().filter(u8::is_ascii_digit).collect(),
        exponent: parse_exponent(exponent),
    }
}

/// 0이 아닌 유한한 크기의 최단 왕복 자릿수와 지수를 얻는다(`number_to_string_with`와 같은 자릿수).
///
/// ryu-js 출력(`123.456`, `0.001234`, `1.5e-7`, `123456789012345680000`)에서 숫자만 모은 뒤,
/// 앞의 0은 지수에 반영하고 뒤의 0(큰 정수의 자리 채움)은 버린다.
/// ECMA-262 `toExponential(undefined)`의 n은 10으로 나누어떨어지지 않는다.
/// QuickJS 방언의 정규수 2의 거듭제곱은 `quickjs_shortest_decimal`이다.
/// - `magnitude`: 0보다 큰 유한한 수
/// - `dialect`: 최단 자릿수의 방언
fn shortest_decimal(magnitude: f64, dialect: NumberDialect) -> Decimal {
    if dialect == NumberDialect::QuickJs && has_asymmetric_rounding_interval(magnitude) {
        return quickjs_shortest_decimal(magnitude);
    }
    let mut buffer = ryu_js::Buffer::new();
    let text = buffer.format_finite(magnitude);
    let (mantissa, suffix) = text
        .split_once('e')
        .map_or((text, 0), |(mantissa, exponent)| {
            (mantissa, parse_exponent(exponent))
        });
    let integer_length = mantissa.find('.').unwrap_or(mantissa.len());
    let mut digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    let leading_zeros = digits.iter().take_while(|&&digit| digit == b'0').count();
    digits.drain(..leading_zeros);
    while digits.last() == Some(&b'0') {
        digits.pop();
    }
    // 숫자열 전체를 0.ddd로 보면 지수는 정수부 길이 + 접미 지수다. 첫 자리 기준(d.dd)으로 1을 빼고, 앞의 0만큼 내린다
    Decimal {
        digits,
        exponent: integer_length as i64 - leading_zeros as i64 + suffix - 1,
    }
}

/// IEEE 반올림 구간이 비대칭인 수인지 본다: 가수가 0이고 지수 필드가 2 이상인 유한 정규수(±2^-1021..±2^1023).
///
/// 이런 수는 아래 이웃까지의 간격이 위 이웃까지의 절반이라 왕복하는 십진 구간이 x를 중심으로 대칭이 아니다.
/// 지수 필드 1(2^-1022)은 아래 이웃(가장 큰 부분정규수)과의 간격이 같아 대칭이다.
/// - `x`: 수
fn has_asymmetric_rounding_interval(x: f64) -> bool {
    let bits = x.to_bits();
    let exponent_field = (bits >> 52) & 0x7FF;
    bits & MANTISSA_MASK == 0 && (2..=2046).contains(&exponent_field)
}

/// QuickJS `js_dtoa`(FORMAT_FREE, 10진)가 고르는 자릿수와 지수를 얻는다.
///
/// 17자리 RNDN 후보(늘 왕복한다)에서 시작해, 지금 자릿수(뒤의 0을 지운 길이)보다 하나 짧은 RNDN 후보가 원래 수로
/// 되읽히면 받아들이고 계속 줄인다. 처음 되읽히지 않는 곳에서 멈추고 마지막으로 받아들인 후보를 쓴다. 왕복 검사는
/// 정확히 반올림하는 `str::parse::<f64>`다(QuickJS는 `mul_pow_round_to_d(..., JS_RNDN)`).
/// - `magnitude`: 0보다 큰 유한한 수
fn quickjs_shortest_decimal(magnitude: f64) -> Decimal {
    let exact = exact_decimal(magnitude);
    let mut found = round_half_even(&exact, QUICKJS_MAX_DIGITS);
    while found.digits.len() > 1 {
        let candidate = round_half_even(&exact, found.digits.len() - 1);
        if decimal_value(&candidate) != Some(magnitude) {
            break;
        }
        found = candidate;
    }
    found
}

/// 십진 자릿수와 지수가 나타내는 수를 정확히 반올림해 읽는다(왕복 검사용).
///
/// - `decimal`: 0이 아닌 자릿수와 지수(지수 절댓값은 400 미만이라 dec2flt의 지수 포화와 무관하다)
/// - 반환: 읽은 수. 텍스트가 깨졌으면 `None`(이 모듈이 만든 자릿수라 실제로는 없다)
fn decimal_value(decimal: &Decimal) -> Option<f64> {
    let mut text = String::with_capacity(decimal.digits.len() + 8);
    let (first, rest) = decimal
        .digits
        .split_at(std::cmp::min(1, decimal.digits.len()));
    push_point_separated(&mut text, first, rest);
    text.push('e');
    text.push_str(&decimal.exponent.to_string());
    text.parse::<f64>().ok()
}

/// `Number::toString`의 배치(ECMA-262 Number::toString 6~10단계)로 자릿수를 붙인다. 부호는 호출자가 붙인다.
///
/// 자릿수 개수를 k, 소수점 위치를 n(= 지수 + 1)이라 하면:
/// - `k ≤ n ≤ 21`: 자릿수 뒤에 0을 n−k개(`1152921504606847000`)
/// - `0 < n ≤ 21`: 앞 n자리 뒤에 소수점(`123.456`)
/// - `-6 < n ≤ 0`: `0.` 뒤에 0을 −n개, 그다음 자릿수(`0.000001234`)
/// - 그 밖: 지수 표기 `d.ddde±x`(`5.9604644775390625e-8`, `1e+21`)
/// - `text`: 결과 문자열
/// - `decimal`: 0이 아닌 수의 최단 자릿수(뒤의 0 없음)와 지수
fn push_to_string_layout(text: &mut String, decimal: &Decimal) {
    let count = i64::try_from(decimal.digits.len()).unwrap_or(i64::MAX);
    let point = decimal.exponent + 1;
    if count <= point && point <= TO_STRING_MAX_POINT {
        push_ascii(text, &decimal.digits);
        text.extend(std::iter::repeat_n(
            '0',
            usize::try_from(point - count).unwrap_or(0),
        ));
    } else if 0 < point && point <= TO_STRING_MAX_POINT {
        let split = usize::try_from(point).unwrap_or(0);
        let (integer_part, fraction_part) = decimal.digits.split_at(split);
        push_point_separated(text, integer_part, fraction_part);
    } else if TO_STRING_MIN_POINT < point && point <= 0 {
        text.push_str("0.");
        text.extend(std::iter::repeat_n(
            '0',
            usize::try_from(-point).unwrap_or(0),
        ));
        push_ascii(text, &decimal.digits);
    } else {
        push_exponential(text, decimal);
    }
}

/// 포맷 출력의 지수 부분(`-7`, `21`, `+21`)을 읽는다.
///
/// 이 모듈의 포맷 함수 출력만 받으므로 실패하지 않는다. 실패하면 debug 빌드에서 멈춘다.
/// - `text`: 부호가 붙을 수 있는 십진 정수
fn parse_exponent(text: &str) -> i64 {
    let parsed = text.parse::<i64>();
    debug_assert!(parsed.is_ok(), "number formatter wrote exponent {text:?}");
    parsed.unwrap_or(0)
}

/// 정수 n의 자릿수에 소수점을 찍어 `toFixed` 11단계의 m을 붙인다. n = 0이면 `"0"`이다.
///
/// 소수부 자릿수보다 짧으면 앞에 0을 채워 정수부가 한 자리 이상 되게 한다(`5`, 2자리 → `0.05`).
/// - `text`: 결과 문자열
/// - `integer_digits`: n의 자릿수(빈 벡터는 0)
/// - `fraction_digits`: 소수부 자릿수
fn push_fixed(text: &mut String, integer_digits: &[u8], fraction_digits: usize) {
    let digits: &[u8] = if integer_digits.is_empty() {
        b"0"
    } else {
        integer_digits
    };
    if fraction_digits == 0 {
        push_ascii(text, digits);
        return;
    }
    let mut padded = vec![b'0'; (fraction_digits + 1).saturating_sub(digits.len())];
    padded.extend_from_slice(digits);
    let (integer_part, fraction_part) = padded.split_at(padded.len() - fraction_digits);
    push_point_separated(text, integer_part, fraction_part);
}

/// 고정 표기(`toPrecision` 11~13단계)를 붙인다. 지수 e가 `-6..p` 안에 있을 때만 부른다.
///
/// e ≥ 0이면 정수부 e+1자리 뒤에 소수점을 찍고(e = p-1이면 소수부가 없다),
/// e < 0이면 `0.` 뒤에 0을 `-(e+1)`개 쓰고 자릿수를 잇는다.
/// - `text`: 결과 문자열
/// - `decimal`: 반올림한 자릿수와 지수
fn push_positional(text: &mut String, decimal: &Decimal) {
    match usize::try_from(decimal.exponent) {
        Ok(exponent) => {
            let split = std::cmp::min(exponent.saturating_add(1), decimal.digits.len());
            let (integer_part, fraction_part) = decimal.digits.split_at(split);
            push_point_separated(text, integer_part, fraction_part);
        }
        Err(_) => {
            text.push_str("0.");
            text.extend(std::iter::repeat_n(
                '0',
                decimal.exponent.unsigned_abs() as usize - 1,
            ));
            push_ascii(text, &decimal.digits);
        }
    }
}

/// 지수 표기 `d.ddd e±N`을 붙인다. 지수 부호는 0이어도 쓰고(`e+0`), 자릿수가 하나면 소수점을 쓰지 않는다.
///
/// - `text`: 결과 문자열
/// - `decimal`: 반올림한 자릿수와 지수
fn push_exponential(text: &mut String, decimal: &Decimal) {
    let (first, rest) = decimal
        .digits
        .split_at(std::cmp::min(1, decimal.digits.len()));
    push_point_separated(text, first, rest);
    text.push('e');
    text.push(if decimal.exponent < 0 { '-' } else { '+' });
    text.push_str(&decimal.exponent.unsigned_abs().to_string());
}

/// 정수부와 소수부를 소수점으로 이어 붙인다. 소수부가 비면 소수점을 쓰지 않는다.
///
/// - `text`: 결과 문자열
/// - `integer_part`: 소수점 앞 자릿수(ASCII)
/// - `fraction_part`: 소수점 뒤 자릿수(ASCII)
fn push_point_separated(text: &mut String, integer_part: &[u8], fraction_part: &[u8]) {
    push_ascii(text, integer_part);
    if !fraction_part.is_empty() {
        text.push('.');
        push_ascii(text, fraction_part);
    }
}

/// ASCII 숫자열을 문자열 끝에 붙인다.
///
/// - `text`: 결과 문자열
/// - `digits`: ASCII 숫자들
fn push_ascii(text: &mut String, digits: &[u8]) {
    text.extend(digits.iter().map(|&digit| char::from(digit)));
}
