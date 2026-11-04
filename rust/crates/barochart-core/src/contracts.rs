//! JS 원본 `src/core/contracts.mjs`와 같은 코어 공통 한도 및 값 검증기다.
//!
//! 브리지와 같은 무손실 `JsValue` 모델을 받는다. 문자열과 키는 ASCII 문법 검사가 필요할 때까지 WTF-16으로
//! 유지하며, 정렬은 UTF-8/Unicode 스칼라 순서가 아닌 `JsString`의 UTF-16 순서를 쓴다.

use std::collections::HashSet;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, js_round, number_to_string_with};
use barochart_js::string::{JsString, is_js_whitespace};

/// `src/core/contracts.mjs`의 `RESOURCE_LIMITS`와 같은 코어 공통 한도다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceLimits {
    /// 저장할 수 있는 막대의 최대 수.
    pub max_bars: u64,
    /// 캔버스 한 변의 최대 길이.
    pub max_canvas_dimension: u64,
    /// 캔버스의 최대 픽셀 수.
    pub max_canvas_pixels: u64,
    /// 드로잉의 최대 수.
    pub max_drawings: u64,
    /// 드로잉 점의 최대 수.
    pub max_drawing_points: u64,
    /// JSON 문서의 최대 UTF-16 코드 단위 길이.
    pub max_document_chars: u64,
    /// 보관할 드로잉 이력의 최대 바이트 수.
    pub max_history_bytes: u64,
    /// 차트 패널의 최대 수.
    pub max_panels: u64,
    /// 축의 최대 수.
    pub max_axes: u64,
    /// 시리즈의 최대 수.
    pub max_series: u64,
    /// 지표의 최대 수.
    pub max_indicators: u64,
}

/// JS 코어와 같은 값을 가진 공통 한도다.
pub const RESOURCE_LIMITS: ResourceLimits = ResourceLimits {
    max_bars: 4_194_304,
    max_canvas_dimension: 16_384,
    max_canvas_pixels: 33_554_432,
    max_drawings: 10_000,
    max_drawing_points: 200_000,
    max_document_chars: 8_388_608,
    max_history_bytes: 33_554_432,
    max_panels: 32,
    max_axes: 64,
    max_series: 256,
    max_indicators: 128,
};

/// 패널 레코드 직렬화·검증 순서.
pub const PANEL_KEYS: &[&str] = &[
    "id",
    "weight",
    "label",
    "scale",
    "inverted",
    "padding",
    "range",
    "base",
    "precision",
    "formatter",
    "axisVisible",
    "axisSide",
];
/// 축 레코드 직렬화·검증 순서.
pub const AXIS_KEYS: &[&str] = &[
    "id",
    "panel",
    "side",
    "scale",
    "inverted",
    "padding",
    "range",
    "base",
    "precision",
    "tickFormat",
    "prefix",
    "suffix",
    "label",
    "visible",
    "width",
    "formatter",
];
/// 시리즈 레코드 직렬화·검증 순서.
pub const SERIES_KEYS: &[&str] = &[
    "id",
    "type",
    "panel",
    "source",
    "values",
    "indicator",
    "output",
    "color",
    "fill",
    "width",
    "baseline",
    "offset",
    "upColor",
    "downColor",
    "visible",
    "axisId",
    "symbolId",
    "label",
];
/// 테마 레코드 직렬화·검증 순서.
pub const THEME_KEYS: &[&str] = &[
    "background",
    "grid",
    "text",
    "up",
    "down",
    "crosshair",
    "font",
];
/// 심볼 레코드 직렬화·검증 순서.
pub const SYMBOL_KEYS: &[&str] = &[
    "id",
    "exchange",
    "timezone",
    "currency",
    "volumeUnit",
    "priceDecimals",
    "tickSize",
    "adjustment",
    "provider",
    "adjustmentVersion",
];
/// M0a에서 정규화한 드로잉 레코드 직렬화 순서.
pub const DRAWING_RECORD_KEYS: &[&str] = &[
    "id", "panel", "locked", "style", "type", "points", "text", "visible", "axisId", "seriesId",
];
/// M0a에서 정규화한 드로잉 스타일 직렬화 순서.
pub const DRAWING_STYLE_KEYS: &[&str] = &["color", "width", "fill", "font"];
/// 드로잉 앵커 직렬화 순서.
pub const DRAWING_ANCHOR_KEYS: &[&str] = &["time", "price"];

const RESERVED_RECORD_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];
const COLOR_NAMES: &[(&str, &str)] = &[
    ("black", "#000000"),
    ("silver", "#c0c0c0"),
    ("gray", "#808080"),
    ("white", "#ffffff"),
    ("maroon", "#800000"),
    ("red", "#ff0000"),
    ("purple", "#800080"),
    ("fuchsia", "#ff00ff"),
    ("green", "#008000"),
    ("lime", "#00ff00"),
    ("olive", "#808000"),
    ("yellow", "#ffff00"),
    ("navy", "#000080"),
    ("blue", "#0000ff"),
    ("teal", "#008080"),
    ("aqua", "#00ffff"),
    ("transparent", "#00000000"),
];

fn type_error(message: impl AsRef<str>) -> JsError {
    JsError::new("TypeError", JsString::from_str(message.as_ref()))
}

fn range_error(message: impl AsRef<str>) -> JsError {
    JsError::new("RangeError", JsString::from_str(message.as_ref()))
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(object) => Some(object),
        _ => None,
    }
}

fn is_reserved(key: &JsString) -> bool {
    RESERVED_RECORD_KEYS
        .iter()
        .any(|reserved| key.as_units().iter().copied().eq(reserved.encode_utf16()))
}

fn contains(allowed: &[&str], key: &JsString) -> bool {
    allowed
        .iter()
        .any(|candidate| key.as_units().iter().copied().eq(candidate.encode_utf16()))
}

fn text_with_units(prefix: &str, middle: &JsString, suffix: &str) -> JsString {
    let mut units = Vec::with_capacity(prefix.len() + middle.len_utf16() + suffix.len());
    units.extend(prefix.encode_utf16());
    units.extend_from_slice(middle.as_units());
    units.extend(suffix.encode_utf16());
    JsString::from_utf16(units)
}

/// M0a 정규 검증 순서로 키를 돌려준다. 허용 키가 먼저 나오고 나머지 문자열 키는 UTF-16 순으로 정렬한다.
pub fn canonical_keys(value: &JsValue, allowed: &[&str]) -> Result<Vec<JsString>, JsError> {
    let object = object(value).ok_or_else(|| type_error("Object required"))?;
    let present: HashSet<&JsString> = object.iter().map(|(key, _)| key).collect();
    let mut output = Vec::with_capacity(present.len());
    let mut placed = HashSet::with_capacity(present.len());
    for allowed_key in allowed {
        let key = JsString::from_str(allowed_key);
        if present.contains(&key) && placed.insert(key.clone()) {
            output.push(key);
        }
    }
    let mut remaining: Vec<JsString> = object
        .iter()
        .map(|(key, _)| key.clone())
        .filter(|key| !placed.contains(key))
        .collect();
    remaining.sort_unstable();
    output.extend(remaining);
    Ok(output)
}

/// 지정한 키를 먼저 두고 나머지 문자열 키는 UTF-16 순으로 정렬한 복사본을 돌려준다.
pub fn ordered_record(value: &JsValue, keys: &[&str]) -> Result<JsValue, JsError> {
    let source = object(value).ok_or_else(|| type_error("Object required"))?;
    let canonical = canonical_keys(value, keys)?;
    let mut output = JsObject::new();
    for key in canonical {
        if let Some(value) = source.get(&key) {
            output.insert(key, value.clone());
        }
    }
    Ok(JsValue::Object(output))
}

/// 옵션 값을 검증하고 원본 값을 바꾸지 않는다.
pub fn option_record(value: &JsValue, keys: &[&str], label: &str) -> Result<(), JsError> {
    let Some(object) = object(value) else {
        return Err(type_error(format!("{label}: object required")));
    };
    let offending = object
        .iter()
        .map(|(key, _)| key)
        .filter(|key| is_reserved(key) || !contains(keys, key))
        .min();
    if let Some(key) = offending {
        return Err(JsError::new(
            "TypeError",
            text_with_units(
                &format!("{label}: unsupported field "),
                &key.slice(0, Some(64)),
                "",
            ),
        ));
    }
    Ok(())
}

/// 문자열을 trim하지 않고 UTF-16 길이와 빈 문자열 허용 여부를 검사한다.
pub fn bounded_text<'a>(
    value: &'a JsValue,
    max: usize,
    label: &str,
    empty: bool,
) -> Result<&'a JsString, JsError> {
    let JsValue::String(text) = value else {
        return Err(type_error(format!("{label}: string limit {max}")));
    };
    if text.len_utf16() > max || !empty && text.as_units().is_empty() {
        return Err(type_error(format!("{label}: string limit {max}")));
    }
    Ok(text)
}

/// JavaScript `Number.isSafeInteger` 규칙으로 검사한다. 음의 0은 그대로 돌려준다.
pub fn size_limit(value: &JsValue, max: u64, label: &str) -> Result<f64, JsError> {
    let JsValue::Number(value) = value else {
        return Err(range_error(format!("{label}: limit {max}")));
    };
    if !value.is_finite()
        || value.fract() != 0.0
        || *value < 0.0
        || *value > max as f64
        || value.abs() > 9_007_199_254_740_991.0
    {
        return Err(range_error(format!("{label}: limit {max}")));
    }
    Ok(*value)
}

/// 길이가 제한된 식별자를 검사하고 예약된 객체 키 세 개를 거부한다.
pub fn identifier<'a>(value: &'a JsValue, label: &str) -> Result<&'a JsString, JsError> {
    let text = bounded_text(value, 128, label, false)?;
    if is_reserved(text) {
        return Err(type_error(format!("{label}: reserved identifier")));
    }
    Ok(text)
}

fn ascii(text: &JsString) -> Option<String> {
    text.as_units()
        .iter()
        .map(|unit| u8::try_from(*unit).ok().filter(u8::is_ascii))
        .collect::<Option<Vec<_>>>()
        .map(|bytes| String::from_utf8(bytes).expect("ASCII bytes are valid UTF-8"))
}

fn hex_value(unit: u16) -> Option<u8> {
    if (0x30..=0x39).contains(&unit) {
        Some((unit - 0x30) as u8)
    } else if (0x61..=0x66).contains(&unit) {
        Some((unit - 0x61 + 10) as u8)
    } else if (0x41..=0x46).contains(&unit) {
        Some((unit - 0x41 + 10) as u8)
    } else {
        None
    }
}

fn parse_decimal(units: &[u16]) -> Option<f64> {
    if units.is_empty() {
        return None;
    }
    let mut dot = false;
    let mut before = 0;
    let mut after = 0;
    for unit in units {
        if *unit == b'.' as u16 && !dot {
            dot = true;
        } else if (0x30..=0x39).contains(unit) {
            if dot {
                after += 1;
            } else {
                before += 1;
            }
        } else {
            return None;
        }
    }
    if before + after == 0 || dot && after == 0 {
        return None;
    }
    let text = String::from_utf8(
        units
            .iter()
            .map(|unit| u8::try_from(*unit).ok())
            .collect::<Option<Vec<_>>>()?,
    )
    .ok()?;
    text.parse::<f64>().ok()
}

fn color_error() -> JsError {
    range_error("Portable color: hex, comma RGB/RGBA or basic named color required")
}

fn from_rgba(red: f64, green: f64, blue: f64, alpha: f64) -> Result<JsString, JsError> {
    let channels = [red, green, blue, alpha * 255.0];
    if channels[..3]
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 255.0)
        || !alpha.is_finite()
        || !(0.0..=1.0).contains(&alpha)
    {
        return Err(color_error());
    }
    let mut output = String::from("#");
    for value in channels {
        let byte = js_round(value) as u8;
        output.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        output.push(char::from_digit((byte & 15) as u32, 16).unwrap());
    }
    Ok(JsString::from_str(&output))
}

fn css_number(part: &JsString) -> Option<(f64, bool)> {
    let trimmed = JsString::trim(part);
    let units = trimmed.as_units();
    let percent = units.last() == Some(&(b'%' as u16));
    let number_units = if percent {
        &units[..units.len() - 1]
    } else {
        units
    };
    Some((parse_decimal(number_units)?, percent))
}

fn rgb_function(color: &JsString) -> Option<JsString> {
    let value = ascii(color)?;
    let body = if value.starts_with("rgba(") && value.ends_with(')') {
        &value[5..value.len() - 1]
    } else if value.starts_with("rgb(") && value.ends_with(')') {
        &value[4..value.len() - 1]
    } else {
        return None;
    };
    let parts: Vec<JsString> = body.split(',').map(JsString::from_str).collect();
    if !matches!(parts.len(), 3 | 4) {
        return None;
    }
    let mut values = Vec::with_capacity(parts.len());
    for part in &parts {
        let (number, percent) = css_number(part)?;
        values.push((number, percent));
    }
    let channel = |index: usize| {
        let (number, percent) = values[index];
        number * if percent { 2.55 } else { 1.0 }
    };
    let alpha = if parts.len() == 4 {
        let (number, percent) = values[3];
        number * if percent { 0.01 } else { 1.0 }
    } else {
        1.0
    };
    from_rgba(channel(0), channel(1), channel(2), alpha).ok()
}

/// 지원하는 이식 색상 표기를 소문자 `#rrggbbaa`로 바꾼다.
pub fn portable_color(value: &JsValue) -> Result<JsString, JsError> {
    let JsValue::String(text) = value else {
        return Err(type_error("Color string required"));
    };
    bounded_text(value, 128, "Color", false)?;
    let mut color = JsString::trim(text).to_lowercase();
    if let Some(source) = ascii(&color)
        && let Some((_, replacement)) = COLOR_NAMES.iter().find(|(name, _)| *name == source)
    {
        color = JsString::from_str(replacement);
    }
    if let Some(units) = color.as_units().strip_prefix(&[b'#' as u16])
        && matches!(units.len(), 3 | 4)
        && units.iter().all(|unit| hex_value(*unit).is_some())
    {
        let expanded: Vec<u16> = units.iter().flat_map(|unit| [*unit, *unit]).collect();
        color = JsString::from_utf16([vec![b'#' as u16], expanded].concat());
    }
    let units = color.as_units();
    if (units.len() == 7 || units.len() == 9)
        && units[0] == b'#' as u16
        && units[1..].iter().all(|unit| hex_value(*unit).is_some())
    {
        if units.len() == 9 {
            return Ok(color);
        }
        let mut output = color.as_units().to_vec();
        output.extend("ff".encode_utf16());
        return Ok(JsString::from_utf16(output));
    }
    rgb_function(&color).ok_or_else(color_error)
}

fn is_ascii_word(unit: u16) -> bool {
    (b'a' as u16..=b'z' as u16).contains(&unit)
        || (b'A' as u16..=b'Z' as u16).contains(&unit)
        || (b'0' as u16..=b'9' as u16).contains(&unit)
        || unit == b'_' as u16
}

/// 문자열을 trim하고 이식 가능한 글꼴 문법 및 4..96px 크기를 검사한다.
pub fn portable_font(value: &JsValue) -> Result<JsString, JsError> {
    let text = bounded_text(value, 256, "Font", false)?;
    let trimmed = JsString::trim(text);
    let units = trimmed.as_units();
    let mut cursor = 0;
    loop {
        let matched = ["bold", "italic", "normal"].iter().find(|word| {
            let word_units: Vec<u16> = word.encode_utf16().collect();
            units.get(cursor..cursor + word_units.len()) == Some(word_units.as_slice())
                && units
                    .get(cursor + word_units.len())
                    .is_some_and(|unit| is_js_whitespace(*unit))
        });
        let Some(word) = matched else {
            break;
        };
        cursor += word.len();
        while units
            .get(cursor)
            .is_some_and(|unit| is_js_whitespace(*unit))
        {
            cursor += 1;
        }
    }
    let digits_start = cursor;
    while units
        .get(cursor)
        .is_some_and(|unit| (0x30..=0x39).contains(unit))
    {
        cursor += 1;
    }
    if cursor == digits_start {
        return Err(range_error("Font size limit: 4..96px"));
    }
    if units.get(cursor) == Some(&(b'.' as u16)) {
        cursor += 1;
        let fraction_start = cursor;
        while units
            .get(cursor)
            .is_some_and(|unit| (0x30..=0x39).contains(unit))
        {
            cursor += 1;
        }
        if cursor == fraction_start {
            return Err(range_error("Font size limit: 4..96px"));
        }
    }
    let size_units = &units[digits_start..cursor];
    let size = String::from_utf8(
        size_units
            .iter()
            .map(|unit| u8::try_from(*unit).ok())
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default(),
    )
    .ok()
    .and_then(|text| text.parse::<f64>().ok());
    let valid_px = units.get(cursor..cursor + 2) == Some(&[b'p' as u16, b'x' as u16]);
    if !valid_px {
        return Err(range_error("Font size limit: 4..96px"));
    }
    cursor += 2;
    let whitespace_start = cursor;
    while units
        .get(cursor)
        .is_some_and(|unit| is_js_whitespace(*unit))
    {
        cursor += 1;
    }
    if cursor == whitespace_start || cursor == units.len() {
        return Err(range_error("Font size limit: 4..96px"));
    }
    let family_valid = units[cursor..].iter().all(|unit| {
        is_ascii_word(*unit) || matches!(*unit, 0x20 | 0x2e | 0x22 | 0x27 | 0x2d | 0x2c)
    });
    if !family_valid || !size.is_some_and(|size| (4.0..=96.0).contains(&size)) {
        return Err(range_error("Font size limit: 4..96px"));
    }
    Ok(trimmed.clone())
}

fn scoped_vec_capacity<T>(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = capacity
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(output)
}

fn index_key_scoped(index: usize, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    let mut digits = [0_u8; 40];
    let mut cursor = digits.len();
    let mut value = index;
    loop {
        cursor -= 1;
        digits[cursor] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    let text = std::str::from_utf8(&digits[cursor..]).expect("decimal digits are UTF-8");
    JsString::try_from_str(text, scope).map_err(|failure| failure.into_js_error())
}

fn own_record_scoped(value: &JsValue, scope: &mut MemoryScope) -> Result<JsObject, JsError> {
    match value {
        JsValue::Object(_) => {
            let mut cloned = value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            let JsValue::Object(output) = &mut cloned else {
                unreachable!("object clone preserves its variant")
            };
            Ok(std::mem::take(output))
        }
        JsValue::Array(values) => {
            let mut entries = scoped_vec_capacity(values.len(), scope)?;
            for (index, value) in values.iter().enumerate() {
                entries.push((
                    index_key_scoped(index, scope)?,
                    value
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ));
            }
            JsObject::try_from_entries_scoped(entries, scope)
                .map_err(|failure| failure.into_js_error())
        }
        JsValue::String(value) => {
            let mut entries = scoped_vec_capacity(value.len_utf16(), scope)?;
            for (index, unit) in value.as_units().iter().enumerate() {
                let bytes = std::mem::size_of::<u16>();
                scope
                    .try_grow(bytes)
                    .map_err(|failure| failure.into_js_error())?;
                let mut units = Vec::new();
                units
                    .try_reserve_exact(1)
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                units.push(*unit);
                entries.push((
                    index_key_scoped(index, scope)?,
                    JsValue::String(JsString::from_utf16(units)),
                ));
            }
            JsObject::try_from_entries_scoped(entries, scope)
                .map_err(|failure| failure.into_js_error())
        }
        JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => {
            Ok(JsObject::new())
        }
    }
}

fn style_property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    let JsValue::Object(object) = value else {
        return None;
    };
    object.iter().find_map(|(key, value)| {
        key.as_units()
            .iter()
            .copied()
            .eq(name.encode_utf16())
            .then_some(value)
    })
}

fn validate_style_scalars(
    value: &JsValue,
    colors: &[&str],
    preserve_hex: bool,
) -> Result<(), JsError> {
    for key in colors {
        let Some(current) = style_property(value, key) else {
            continue;
        };
        if matches!(current, JsValue::Undefined)
            || *key == "fill" && matches!(current, JsValue::Null)
        {
            continue;
        }
        let keep_hex = preserve_hex
            && matches!(current, JsValue::String(color) if {
                let units = color.as_units();
                matches!(units.len(), 7 | 9)
                    && units[0] == b'#' as u16
                    && units[1..].iter().all(|unit| hex_value(*unit).is_some())
            });
        if !keep_hex {
            portable_color(current)?;
        }
    }
    if let Some(font) = style_property(value, "font")
        && !matches!(font, JsValue::Undefined)
    {
        portable_font(font)?;
    }
    Ok(())
}

/// 원본 객체 키 순서를 유지하면서 이식 가능한 스타일 필드를 정규화한다.
pub fn portable_style(
    value: &JsValue,
    colors: &[&str],
    preserve_hex: bool,
) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    portable_style_scoped(value, colors, preserve_hex, &mut scope)
}

/// 원본 key 순서와 scalar 오류 우선순위를 유지하며 스타일 snapshot을 scoped fallible allocation으로 만든다.
pub fn portable_style_scoped(
    value: &JsValue,
    colors: &[&str],
    preserve_hex: bool,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    // Source는 object spread 뒤 colors/font 순서로 scalar를 읽는다. 큰 raw record를
    // 복제하기 전에 같은 순서로 검증해 scalar 오류가 quota 오류보다 먼저 보이게 한다.
    validate_style_scalars(value, colors, preserve_hex)?;
    let mut output = own_record_scoped(value, scope)?;
    for key in colors {
        let property = JsString::from_str(key);
        let Some(current) = output.get(&property).cloned() else {
            continue;
        };
        if matches!(current, JsValue::Undefined)
            || *key == "fill" && matches!(current, JsValue::Null)
        {
            continue;
        }
        let keep_hex = preserve_hex
            && matches!(&current, JsValue::String(color) if {
                let units = color.as_units();
                matches!(units.len(), 7 | 9)
                    && units[0] == b'#' as u16
                    && units[1..].iter().all(|unit| hex_value(*unit).is_some())
            });
        if !keep_hex {
            output.insert(property, JsValue::String(portable_color(&current)?));
        }
    }
    let font = JsString::from_str("font");
    if let Some(value) = output.get(&font).cloned()
        && !matches!(value, JsValue::Undefined)
    {
        output.insert(font, JsValue::String(portable_font(&value)?));
    }
    Ok(JsValue::Object(output))
}

fn to_primitive_error() -> JsError {
    #[cfg(target_os = "android")]
    let message = "toPrimitive";
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let message = "No default value";
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let message = "Cannot convert object to primitive value";
    type_error(message)
}

/// JSON 값 경계에서 JS ToString(string hint)을 수행하며 모든 가변 버퍼를 호출 scope에 선계상한다.
pub fn js_to_string_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    enum Action<'a> {
        Value(&'a JsValue, bool),
        Array(&'a [JsValue], usize),
    }
    fn reserve<T>(
        values: &mut Vec<T>,
        additional: usize,
        scope: &mut MemoryScope,
    ) -> Result<(), JsError> {
        if additional <= values.capacity().saturating_sub(values.len()) {
            return Ok(());
        }
        let needed = values
            .len()
            .checked_add(additional)
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        let capacity = std::cmp::max(
            std::cmp::max(needed, values.capacity().saturating_mul(2)),
            4,
        );
        let additional_capacity = capacity.saturating_sub(values.capacity());
        let bytes = additional_capacity
            .checked_mul(std::mem::size_of::<T>())
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        scope
            .try_grow(bytes)
            .map_err(|failure| failure.into_js_error())?;
        values
            .try_reserve_exact(capacity.saturating_sub(values.len()))
            .map_err(|_| scope.allocation_failure().into_js_error())
    }
    fn push<T>(values: &mut Vec<T>, value: T, scope: &mut MemoryScope) -> Result<(), JsError> {
        reserve(values, 1, scope)?;
        values.push(value);
        Ok(())
    }
    fn extend(
        output: &mut Vec<u16>,
        units: impl IntoIterator<Item = u16>,
        length: usize,
        scope: &mut MemoryScope,
    ) -> Result<(), JsError> {
        reserve(output, length, scope)?;
        output.extend(units);
        Ok(())
    }

    let mut output = Vec::new();
    let mut stack = Vec::new();
    let to_string_key = JsString::from_str("toString");
    push(&mut stack, Action::Value(value, false), scope)?;
    while let Some(action) = stack.pop() {
        match action {
            Action::Array(values, index) => {
                let Some(value) = values.get(index) else {
                    continue;
                };
                if index != 0 {
                    push(&mut output, b',' as u16, scope)?;
                }
                push(&mut stack, Action::Array(values, index + 1), scope)?;
                push(&mut stack, Action::Value(value, true), scope)?;
            }
            Action::Value(value, in_array) => match value {
                JsValue::Undefined if in_array => {}
                JsValue::Undefined => extend(
                    &mut output,
                    "undefined".encode_utf16(),
                    "undefined".len(),
                    scope,
                )?,
                JsValue::Null if in_array => {}
                JsValue::Null => extend(&mut output, "null".encode_utf16(), "null".len(), scope)?,
                JsValue::Bool(value) => {
                    let text = if *value { "true" } else { "false" };
                    extend(&mut output, text.encode_utf16(), text.len(), scope)?;
                }
                JsValue::Number(value) => {
                    let text = number_to_string_with(*value, dialect);
                    let length = text.encode_utf16().count();
                    extend(&mut output, text.encode_utf16(), length, scope)?;
                }
                JsValue::String(value) => extend(
                    &mut output,
                    value.as_units().iter().copied(),
                    value.len_utf16(),
                    scope,
                )?,
                JsValue::Object(object) => {
                    if object.get(&to_string_key).is_some() {
                        return Err(to_primitive_error());
                    }
                    extend(
                        &mut output,
                        "[object Object]".encode_utf16(),
                        "[object Object]".len(),
                        scope,
                    )?;
                }
                JsValue::Array(values) => {
                    push(&mut stack, Action::Array(values, 0), scope)?;
                }
            },
        }
    }
    Ok(JsString::from_utf16(output))
}

/// 기존 호출자가 쓰는 비회계 호환 래퍼다.
pub fn js_to_string_with(value: &JsValue, dialect: NumberDialect) -> Result<JsString, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    js_to_string_scoped(value, dialect, &mut scope)
}

/// `ToNumber`가 만들 수 있는 문자열 정규화 버퍼를 먼저 계상한 뒤 기존 숫자 의미를 적용한다.
pub fn js_to_number_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<f64, JsError> {
    crate::coercion::js_to_number_scoped(value, dialect, scope)
}

/// 텍스트 값의 ToString을 한 번 수행한 뒤 파싱 없이 JSON 컨테이너 깊이를 검사한다.
pub fn assert_json_text_depth(
    value: &JsValue,
    limit: usize,
    message: &str,
) -> Result<JsString, JsError> {
    assert_json_text_depth_with(value, limit, message, NumberDialect::PLATFORM)
}

/// 지정한 수 방언으로 텍스트 값의 ToString을 한 번 수행하고 JSON 컨테이너 깊이를 검사한다.
pub fn assert_json_text_depth_with(
    value: &JsValue,
    limit: usize,
    message: &str,
    dialect: NumberDialect,
) -> Result<JsString, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    assert_json_text_depth_with_scoped(value, limit, message, dialect, &mut scope)
}

/// 지정한 수 방언으로 텍스트를 scoped `ToString`하고 JSON 컨테이너 깊이를 검사한다.
pub fn assert_json_text_depth_with_scoped(
    value: &JsValue,
    limit: usize,
    message: &str,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let text = js_to_string_scoped(value, dialect, scope)?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for unit in text.as_units() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *unit == b'\\' as u16 {
                escaped = true;
            } else if *unit == b'"' as u16 {
                in_string = false;
            }
        } else if *unit == b'"' as u16 {
            in_string = true;
        } else if *unit == b'{' as u16 || *unit == b'[' as u16 {
            depth = depth.saturating_add(1);
            if depth > limit {
                return Err(range_error(message));
            }
        } else if (*unit == b'}' as u16 || *unit == b']' as u16) && depth > 0 {
            depth -= 1;
        }
    }
    Ok(text)
}
