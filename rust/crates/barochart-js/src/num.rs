//! JS `Number` 의미: `Number::toString`, `toFixed`/`toPrecision`/`toExponential`,
//! `Math.round`/`max`/`min`/`sign`, `ToInt32`/`ToUint32`, `Object.is`
//! (설계 §6.4, 이식 지도 §3.1.1·§5).
//!
//! - `Number::toString`은 ryu-js(=1.0.3)로 쓴다. V8과 대조해 불일치가 없었다. Rust std의 최단 자릿수는
//!   동률에서 V8과 다르고, `Display`는 `1e21`을 정수로, `1e-7`을 `0.0000001`로 쓴다.
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

/// 십진 자릿수와 지수. 값은 `d0.d1d2… × 10^exponent`다.
struct Decimal {
    /// 앞에서부터의 십진 자릿수(ASCII). 0이 아닌 수에서는 첫 자리가 0이 아니다
    digits: Vec<u8>,
    /// 첫 자리의 십진 지수
    exponent: i64,
}

/// ECMA-262 `Number::toString(x, 10)`. JS의 `String(x)`, 템플릿 문자열, `JSON.stringify`의 숫자와 같다.
///
/// - 최단 왕복 자릿수를 쓰고, `|x| >= 1e21` 또는 `|x| < 1e-6`이면 지수 표기(`1e+21`, `1.5e-7`)다.
/// - `-0`은 `"0"`, NaN은 `"NaN"`, 무한대는 `"Infinity"`/`"-Infinity"`다.
pub fn number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_owned()
}

/// ECMA-262 `Number.prototype.toFixed(digits)`.
///
/// - `digits`는 0..=100이다. JS는 이 범위를 비유한 수 검사보다 먼저 보므로 `(NaN).toFixed(101)`도
///   RangeError다. 호출자는 x와 무관하게 범위를 먼저 막는다.
/// - 비유한 수와 `|x| >= 1e21`은 `number_to_string(x)`다.
/// - 그 밖에는 `n / 10^digits - x`가 0에 가장 가까운 정수 n을 고르고, 둘이면 큰 n을 고른다
///   (`0.125` → `"0.13"`, `2.5` → `"3"`). 부호는 `x < 0`일 때만 붙는다(`-0` → `"0.00"`, `-1e-10` → `"-0.00"`).
pub fn to_fixed(x: f64, digits: u32) -> String {
    debug_assert!(
        digits <= MAX_DIGITS,
        "toFixed digits {digits} is outside 0..=100; the caller must throw RangeError first"
    );
    if !x.is_finite() || x.abs() >= FIXED_NOTATION_LIMIT {
        return number_to_string(x);
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
pub fn to_exponential(x: f64, digits: Option<u32>) -> String {
    if !x.is_finite() {
        return number_to_string(x);
    }
    debug_assert!(
        digits.is_none_or(|count| count <= MAX_DIGITS),
        "toExponential digits {digits:?} is outside 0..=100; the caller must throw RangeError first"
    );
    let decimal = match digits {
        Some(count) => rounded_or_zero(x, count as usize + 1),
        None if x == 0.0 => zero_decimal(1),
        None => shortest_decimal(x.abs()),
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
    let mut kept: Vec<u8> = (0..length).map(|index| digit_at(digits, index)).collect();
    if digit_at(digits, length) < b'5' {
        return (kept, false);
    }
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

/// 0이 아닌 유한한 크기의 최단 왕복 자릿수와 지수를 얻는다(`number_to_string`과 같은 자릿수).
///
/// ryu-js 출력(`123.456`, `0.001234`, `1.5e-7`, `123456789012345680000`)에서 숫자만 모은 뒤,
/// 앞의 0은 지수에 반영하고 뒤의 0(큰 정수의 자리 채움)은 버린다.
/// ECMA-262 `toExponential(undefined)`의 n은 10으로 나누어떨어지지 않는다.
/// - `magnitude`: 0보다 큰 유한한 수
fn shortest_decimal(magnitude: f64) -> Decimal {
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
