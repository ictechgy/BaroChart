//! Renderer command를 native v1 metadata와 연속 F64 배열로 포장한다.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::mem::size_of;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryFailure, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, number_to_string_with};
use barochart_js::string::JsString;

const NUMBER_LIMIT: usize = 8_388_608;
const METADATA_LIMIT: usize = 1_048_576;
const COMMAND_LIMIT: usize = 65_536;
const STRING_LIMIT: usize = 65_536;
static UNDEFINED: JsValue = JsValue::Undefined;
static DEFAULT_FONT: &str = "12px monospace";
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// Host가 소유해 해제하는 command transport payload다.
pub struct NativeCommandPacket {
    /// 표준 JSON metadata text다.
    pub metadata: JsString,
    /// header, dash, geometry 순서의 원래 binary64 값이다.
    pub numbers: Vec<f64>,
    memory: MemoryGroup,
}

impl NativeCommandPacket {
    /// metadata UTF-16과 F64 payload가 보유한 requested capacity bytes다.
    pub fn requested_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }
}

/// source scene/frame transport의 명시적 옵션이다.
pub struct NativePacketOptions<'a> {
    /// scene 또는 frame이다.
    pub mode: &'a JsValue,
    /// CSS pixel 폭이다.
    pub width: &'a JsValue,
    /// CSS pixel 높이다.
    pub height: &'a JsValue,
    /// background 원시 값이다.
    pub background: &'a JsValue,
    /// scene stats 원시 값이다.
    pub stats: &'a JsValue,
}

fn key(s: &str) -> JsString {
    JsString::from_str(s)
}

fn error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, key(message))
}

fn type_error(message: &str) -> JsError {
    error("TypeError", message)
}

fn range_error(message: &str) -> JsError {
    error("RangeError", message)
}

fn ascii_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    match value {
        JsValue::Object(value) => value
            .iter()
            .find_map(|(key, value)| ascii_eq(key, name).then_some(value))
            .unwrap_or(&UNDEFINED),
        _ => &UNDEFINED,
    }
}

fn nullish(value: &JsValue) -> bool {
    matches!(value, JsValue::Null | JsValue::Undefined)
}

fn string_is(value: &JsValue, expected: &str) -> bool {
    matches!(value, JsValue::String(value) if ascii_eq(value, expected))
}

fn finite(value: &JsValue, label: &str) -> Result<f64, JsError> {
    match value {
        JsValue::Number(value) if value.is_finite() => Ok(*value),
        _ => Err(type_error(&format!("Native packet finite {label}"))),
    }
}

fn array<'a>(value: &'a JsValue, label: &str) -> Result<&'a [JsValue], JsError> {
    match value {
        JsValue::Array(value) => Ok(value),
        _ => Err(type_error(&format!("Native packet {label} array"))),
    }
}

#[derive(Clone, Copy)]
enum PacketString<'a> {
    Borrowed(&'a JsString),
    DefaultFont,
}

impl PacketString<'_> {
    fn utf8_lossy_len(self) -> usize {
        match self {
            Self::Borrowed(value) => utf8_lossy_len(value),
            Self::DefaultFont => DEFAULT_FONT.len(),
        }
    }
}

#[derive(Default)]
struct Strings<'a> {
    values: Vec<PacketString<'a>>,
    ids: HashMap<&'a JsString, usize>,
    default_font_index: Option<usize>,
    bytes: usize,
}

impl<'a> Strings<'a> {
    fn put(&mut self, value: &'a JsValue, scope: &mut MemoryScope) -> Result<f64, JsError> {
        let JsValue::String(value) = value else {
            return Err(type_error("Native packet string"));
        };
        self.put_value(PacketString::Borrowed(value), scope)
    }

    fn put_default_font(&mut self, scope: &mut MemoryScope) -> Result<f64, JsError> {
        self.put_value(PacketString::DefaultFont, scope)
    }

    fn put_value(
        &mut self,
        value: PacketString<'a>,
        scope: &mut MemoryScope,
    ) -> Result<f64, JsError> {
        let existing = match value {
            PacketString::Borrowed(value) => self.ids.get(value).copied().or_else(|| {
                if ascii_eq(value, DEFAULT_FONT) {
                    self.default_font_index
                } else {
                    None
                }
            }),
            PacketString::DefaultFont => self.default_font_index,
        };
        if let Some(index) = existing {
            return Ok(index as f64);
        }
        if self.values.len() >= STRING_LIMIT {
            return Err(range_error("Native packet string limit"));
        }
        self.bytes = self
            .bytes
            .checked_add(value.utf8_lossy_len())
            .ok_or_else(|| range_error("Native packet metadata byte limit"))?;
        if self.bytes > METADATA_LIMIT {
            return Err(range_error("Native packet metadata byte limit"));
        }
        let index = self.values.len();
        try_push_temporary(&mut self.values, value, scope)?;
        match value {
            PacketString::Borrowed(value) => {
                let node_bytes = size_of::<(&JsString, usize)>().saturating_add(16);
                scope
                    .try_grow(node_bytes)
                    .map_err(|failure| failure.into_js_error())?;
                self.ids
                    .try_reserve(1)
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                self.ids.insert(value, index);
                if ascii_eq(value, DEFAULT_FONT) {
                    self.default_font_index = Some(index);
                }
            }
            PacketString::DefaultFont => self.default_font_index = Some(index),
        }
        Ok(index as f64)
    }
}

enum Geometry<'a> {
    Array(&'a [JsValue]),
    Shape([&'a JsValue; 4]),
    Text([&'a JsValue; 2]),
}

impl Geometry<'_> {
    fn values(&self) -> &[JsValue] {
        match self {
            Self::Array(values) => values,
            _ => &[],
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Array(values) => values.len(),
            Self::Shape(_) => 4,
            Self::Text(_) => 2,
        }
    }

    fn append(&self, output: &mut Vec<f64>) -> Result<(), JsError> {
        match self {
            Self::Array(_) => {
                for value in self.values() {
                    output.push(finite(value, "geometry")?);
                }
            }
            Self::Shape(values) => {
                for value in values {
                    output.push(finite(value, "geometry")?);
                }
            }
            Self::Text(values) => {
                for value in values {
                    output.push(finite(value, "geometry")?);
                }
            }
        }
        Ok(())
    }
}

struct Record<'a> {
    header: [f64; 15],
    dash: &'a [JsValue],
    geometry: Geometry<'a>,
}

/// 캐시가 소유한 command 배열을 복제 없이 포장하는 layer 뷰다.
#[derive(Clone, Copy)]
pub enum NativePacketLayerView<'a> {
    /// 원본 형태의 commands object다.
    Value(&'a JsValue),
    /// 이미 생성된 실제 command slice다.
    Commands(&'a [JsValue]),
}

/// 원본 object layer를 기존 회계 없는 typed borrowed encoder에 전달한다.
pub fn pack_native_commands(
    layers: &[Option<&JsValue>],
    options: NativePacketOptions<'_>,
    dialect: NumberDialect,
) -> Result<NativeCommandPacket, JsError> {
    let memory = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
    pack_native_commands_with_memory(layers, options, dialect, &memory)
}

/// 원본 object layer를 지정한 엔진 account에 연결해 포장한다.
pub fn pack_native_commands_with_memory(
    layers: &[Option<&JsValue>],
    options: NativePacketOptions<'_>,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<NativeCommandPacket, JsError> {
    let mut scope = memory.scope();
    pack_native_commands_scoped(layers, options, dialect, memory, &mut scope)
}

/// 호출자가 serialization까지 유지하는 temporary scope를 재사용해 object layer를 포장한다.
pub fn pack_native_commands_scoped(
    layers: &[Option<&JsValue>],
    options: NativePacketOptions<'_>,
    dialect: NumberDialect,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<NativeCommandPacket, JsError> {
    let mut views = [None; 3];
    if layers.len() <= views.len() {
        for (target, source) in views.iter_mut().zip(layers) {
            *target = source.map(NativePacketLayerView::Value);
        }
        return pack_native_layers_scoped(&views[..layers.len()], options, dialect, memory, scope);
    }
    pack_native_layers_scoped(&[], options, dialect, memory, scope)
}

/// 원본 검증 순서로 각 layer를 기존 회계 없는 v1 transport에 모은다.
pub fn pack_native_layers(
    layers: &[Option<NativePacketLayerView<'_>>],
    options: NativePacketOptions<'_>,
    dialect: NumberDialect,
) -> Result<NativeCommandPacket, JsError> {
    let memory = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
    pack_native_layers_with_memory(layers, options, dialect, &memory)
}

/// 실제 layer slice를 복제하지 않고 지정한 엔진 account에 연결해 포장한다.
pub fn pack_native_layers_with_memory(
    layers: &[Option<NativePacketLayerView<'_>>],
    options: NativePacketOptions<'_>,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<NativeCommandPacket, JsError> {
    let mut scope = memory.scope();
    pack_native_layers_scoped(layers, options, dialect, memory, &mut scope)
}

/// 실제 layer slice와 호출 수명 temporary scope로 packet을 만든다.
///
/// 반환 packet은 metadata UTF-16과 F64 capacity lease를 직접 소유하며, `scope`는 검증 레코드와
/// bounded metadata writer의 temporary allocation을 serialization이 끝날 때까지 보유한다.
pub fn pack_native_layers_scoped<'a>(
    layers: &[Option<NativePacketLayerView<'a>>],
    options: NativePacketOptions<'_>,
    dialect: NumberDialect,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<NativeCommandPacket, JsError> {
    let scene = string_is(options.mode, "scene");
    let frame = string_is(options.mode, "frame");
    if (!scene && !frame)
        || layers.len() != if scene { 1 } else { 3 }
        || layers.last().is_none_or(Option::is_none)
    {
        return Err(type_error("Native packet mode/layers"));
    }
    let width = finite(options.width, "width")?;
    let height = finite(options.height, "height")?;
    if !matches!(options.background, JsValue::String(_)) {
        return Err(type_error("Native packet background string"));
    }

    let mut strings = Strings::default();
    let mut records = Vec::new();
    let mut total = 0usize;
    let mut command_count = 0usize;
    for layer in layers {
        let Some(layer) = layer else {
            continue;
        };
        let commands = commands_for_layer(*layer)?;
        command_count = command_count.saturating_add(commands.len());
        if command_count > COMMAND_LIMIT {
            return Err(range_error("Native packet command limit"));
        }
        for command in commands {
            let op = match field(command, "op") {
                value if string_is(value, "lines") => 1,
                value if string_is(value, "rects") => 2,
                value if string_is(value, "path") => 3,
                value if string_is(value, "box") => 4,
                value if string_is(value, "ellipse") => 5,
                value if string_is(value, "text") => 6,
                _ => return Err(type_error("Native packet unsupported operation")),
            };
            let color = strings.put(field(command, "color"), scope)?;
            let stroke = if nullish(field(command, "width")) {
                1.0
            } else {
                finite(field(command, "width"), "stroke")?
            };
            if stroke < 0.0 {
                return Err(range_error("Native packet stroke"));
            }
            let clip = if nullish(field(command, "clip")) {
                None
            } else {
                Some(array(field(command, "clip"), "clip")?)
            };
            if clip.is_some_and(|clip| clip.len() != 4) {
                return Err(type_error("Native packet clip arity"));
            }
            let mut clip_values = [0.0; 4];
            if let Some(clip) = clip {
                for (target, value) in clip_values.iter_mut().zip(clip) {
                    *target = finite(value, "clip")?;
                }
            }
            let dash = if nullish(field(command, "dash")) {
                &[][..]
            } else {
                let dash = array(field(command, "dash"), "dash")?;
                if dash.is_empty() || !dash.len().is_multiple_of(2) {
                    return Err(type_error("Native packet dash arity"));
                }
                dash
            };
            let fill = if nullish(field(command, "fill")) {
                -1.0
            } else {
                strings.put(field(command, "fill"), scope)?
            };
            let baseline = if op == 3 && fill != -1.0 {
                finite(field(command, "baseline"), "area baseline")?
            } else {
                0.0
            };
            let text = if op == 6 {
                strings.put(field(command, "text"), scope)?
            } else {
                -1.0
            };
            let font = if op == 6 {
                if nullish(field(command, "font")) {
                    strings.put_default_font(scope)?
                } else {
                    strings.put(field(command, "font"), scope)?
                }
            } else {
                -1.0
            };
            let geometry = match op {
                1 | 2 => Geometry::Array(array(field(command, "coords"), "coords")?),
                3 => Geometry::Array(array(field(command, "points"), "points")?),
                4 | 5 => Geometry::Shape([
                    field(command, "x"),
                    field(command, "y"),
                    field(command, "w"),
                    field(command, "h"),
                ]),
                _ => Geometry::Text([field(command, "x"), field(command, "y")]),
            };
            if (op <= 2 && !geometry.len().is_multiple_of(4))
                || (op == 3 && !geometry.len().is_multiple_of(2))
            {
                return Err(type_error("Native packet geometry arity"));
            }
            let record_length = 15usize
                .saturating_add(dash.len())
                .saturating_add(geometry.len());
            total = total.saturating_add(record_length);
            if total > NUMBER_LIMIT {
                return Err(range_error("Native packet number limit"));
            }
            try_push_temporary(
                &mut records,
                Record {
                    header: [
                        op as f64,
                        record_length as f64,
                        color,
                        stroke,
                        f64::from(clip.is_some()),
                        clip_values[0],
                        clip_values[1],
                        clip_values[2],
                        clip_values[3],
                        dash.len() as f64,
                        fill,
                        baseline,
                        text,
                        font,
                        geometry.len() as f64,
                    ],
                    dash,
                    geometry,
                },
                scope,
            )?;
        }
    }

    let metadata_bytes = write_metadata(
        layers,
        options,
        width,
        height,
        &strings.values,
        dialect,
        scope,
    )?;
    let metadata_text = std::str::from_utf8(&metadata_bytes)
        .map_err(|_| type_error("Native packet metadata encoding"))?;
    let metadata_length = metadata_text.encode_utf16().count();
    let (mut metadata_units, mut memory_group) = memory
        .try_vec_capacity::<u16>(metadata_length)
        .map_err(|failure| failure.into_js_error())?;
    metadata_units.extend(metadata_text.encode_utf16());
    let metadata = JsString::from_utf16(metadata_units);

    let (mut numbers, numbers_memory) = memory
        .try_vec_capacity::<f64>(total)
        .map_err(|failure| failure.into_js_error())?;
    memory_group
        .absorb(numbers_memory)
        .map_err(|failure| failure.into_js_error())?;
    for record in records {
        numbers.extend(record.header);
        for value in record.dash {
            let value = finite(value, "dash")?;
            if value <= 0.0 {
                return Err(range_error("Native packet positive dash"));
            }
            numbers.push(value);
        }
        record.geometry.append(&mut numbers)?;
    }
    if numbers.len() != total {
        return Err(type_error("Native packet geometry changed during encoding"));
    }
    Ok(NativeCommandPacket {
        metadata,
        numbers,
        memory: memory_group,
    })
}

fn commands_for_layer(layer: NativePacketLayerView<'_>) -> Result<&[JsValue], JsError> {
    match layer {
        NativePacketLayerView::Commands(commands) => Ok(commands),
        NativePacketLayerView::Value(value) => match field(value, "commands") {
            JsValue::Array(commands) => Ok(commands),
            _ => Err(type_error("Native packet commands array")),
        },
    }
}

fn try_push_temporary<T>(
    values: &mut Vec<T>,
    value: T,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if values.len() == values.capacity() {
        scope
            .try_grow(size_of::<T>())
            .map_err(|failure| failure.into_js_error())?;
        values
            .try_reserve_exact(1)
            .map_err(|_| scope.allocation_failure().into_js_error())?;
    }
    values.push(value);
    Ok(())
}

fn utf8_lossy_len(value: &JsString) -> usize {
    char::decode_utf16(value.as_units().iter().copied()).fold(0usize, |total, decoded| {
        total.saturating_add(decoded.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
    })
}

enum MetadataFailure {
    TooLarge,
    Memory(MemoryFailure),
}

impl MetadataFailure {
    fn into_js_error(self) -> JsError {
        match self {
            Self::TooLarge => range_error("Native packet metadata byte limit"),
            Self::Memory(failure) => failure.into_js_error(),
        }
    }
}

struct MetadataWriter<'a> {
    output: Vec<u8>,
    dialect: NumberDialect,
    scope: &'a mut MemoryScope,
}

impl<'a> MetadataWriter<'a> {
    fn new(dialect: NumberDialect, scope: &'a mut MemoryScope) -> Self {
        Self {
            output: Vec::new(),
            dialect,
            scope,
        }
    }

    fn finish(self) -> Vec<u8> {
        self.output
    }

    fn extend(&mut self, bytes: &[u8]) -> Result<(), MetadataFailure> {
        let next = self
            .output
            .len()
            .checked_add(bytes.len())
            .ok_or(MetadataFailure::TooLarge)?;
        if next > METADATA_LIMIT {
            return Err(MetadataFailure::TooLarge);
        }
        self.scope
            .try_grow(bytes.len())
            .map_err(MetadataFailure::Memory)?;
        self.output
            .try_reserve(bytes.len())
            .map_err(|_| MetadataFailure::Memory(self.scope.allocation_failure()))?;
        self.output.extend_from_slice(bytes);
        Ok(())
    }

    fn byte(&mut self, byte: u8) -> Result<(), MetadataFailure> {
        self.extend(&[byte])
    }

    fn number(&mut self, value: f64) -> Result<(), MetadataFailure> {
        if value.is_finite() {
            self.extend(number_to_string_with(value, self.dialect).as_bytes())
        } else {
            self.extend(b"null")
        }
    }

    fn string(&mut self, value: PacketString<'_>) -> Result<(), MetadataFailure> {
        match value {
            PacketString::Borrowed(value) => self.js_string(value),
            PacketString::DefaultFont => {
                self.byte(b'"')?;
                self.extend(DEFAULT_FONT.as_bytes())?;
                self.byte(b'"')
            }
        }
    }

    fn js_string(&mut self, value: &JsString) -> Result<(), MetadataFailure> {
        self.byte(b'"')?;
        for decoded in char::decode_utf16(value.as_units().iter().copied()) {
            match decoded {
                Ok(character) => self.character(character)?,
                Err(error) => self.unicode_escape(error.unpaired_surrogate())?,
            }
        }
        self.byte(b'"')
    }

    fn character(&mut self, character: char) -> Result<(), MetadataFailure> {
        match character {
            '"' => self.extend(b"\\\""),
            '\\' => self.extend(b"\\\\"),
            '\u{8}' => self.extend(b"\\b"),
            '\u{c}' => self.extend(b"\\f"),
            '\n' => self.extend(b"\\n"),
            '\r' => self.extend(b"\\r"),
            '\t' => self.extend(b"\\t"),
            '\u{0}'..='\u{1f}' => self.unicode_escape(character as u16),
            _ => {
                let mut bytes = [0; 4];
                self.extend(character.encode_utf8(&mut bytes).as_bytes())
            }
        }
    }

    fn unicode_escape(&mut self, unit: u16) -> Result<(), MetadataFailure> {
        let mut escape = [b'\\', b'u', 0, 0, 0, 0];
        for (slot, shift) in escape[2..].iter_mut().zip([12, 8, 4, 0]) {
            *slot = HEX_DIGITS[usize::from((unit >> shift) & 0xf)];
        }
        self.extend(&escape)
    }

    fn value(&mut self, value: &JsValue) -> Result<(), MetadataFailure> {
        enum Frame<'v> {
            Array(&'v [JsValue], usize),
            Object(&'v JsObject, usize, bool),
        }

        fn push_frame<'v>(
            stack: &mut Vec<Frame<'v>>,
            frame: Frame<'v>,
            scope: &mut MemoryScope,
        ) -> Result<(), MetadataFailure> {
            if stack.len() == stack.capacity() {
                scope
                    .try_grow(size_of::<Frame<'v>>())
                    .map_err(MetadataFailure::Memory)?;
                stack
                    .try_reserve_exact(1)
                    .map_err(|_| MetadataFailure::Memory(scope.allocation_failure()))?;
            }
            stack.push(frame);
            Ok(())
        }

        fn write_one<'v>(
            writer: &mut MetadataWriter<'_>,
            value: &'v JsValue,
            stack: &mut Vec<Frame<'v>>,
        ) -> Result<(), MetadataFailure> {
            match value {
                JsValue::Undefined | JsValue::Null => writer.extend(b"null"),
                JsValue::Bool(true) => writer.extend(b"true"),
                JsValue::Bool(false) => writer.extend(b"false"),
                JsValue::Number(value) => writer.number(*value),
                JsValue::String(value) => writer.js_string(value),
                JsValue::Array(values) => {
                    writer.byte(b'[')?;
                    push_frame(stack, Frame::Array(values, 0), writer.scope)
                }
                JsValue::Object(value) => {
                    writer.byte(b'{')?;
                    push_frame(stack, Frame::Object(value, 0, true), writer.scope)
                }
            }
        }

        let mut stack = Vec::new();
        write_one(self, value, &mut stack)?;
        while let Some(frame) = stack.last_mut() {
            let next = match frame {
                Frame::Array(values, index) => {
                    if let Some(value) = values.get(*index) {
                        if *index != 0 {
                            self.byte(b',')?;
                        }
                        *index += 1;
                        Some(value)
                    } else {
                        self.byte(b']')?;
                        None
                    }
                }
                Frame::Object(value, index, first) => {
                    let member = value
                        .iter()
                        .filter(|(_, value)| !matches!(value, JsValue::Undefined))
                        .nth(*index);
                    if let Some((key, value)) = member {
                        if !std::mem::replace(first, false) {
                            self.byte(b',')?;
                        }
                        *index += 1;
                        self.js_string(key)?;
                        self.byte(b':')?;
                        Some(value)
                    } else {
                        self.byte(b'}')?;
                        None
                    }
                }
            };
            if let Some(value) = next {
                write_one(self, value, &mut stack)?;
            } else {
                stack.pop();
            }
        }
        Ok(())
    }
}

fn write_metadata(
    layers: &[Option<NativePacketLayerView<'_>>],
    options: NativePacketOptions<'_>,
    width: f64,
    height: f64,
    strings: &[PacketString<'_>],
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Vec<u8>, JsError> {
    let mut writer = MetadataWriter::new(dialect, scope);
    let result = (|| -> Result<(), MetadataFailure> {
        writer.extend(b"{\"schema\":\"aster.native.commands\",\"version\":1,\"mode\":")?;
        writer.value(options.mode)?;
        writer.extend(b",\"width\":")?;
        writer.number(width)?;
        writer.extend(b",\"height\":")?;
        writer.number(height)?;
        writer.extend(b",\"background\":")?;
        writer.value(options.background)?;
        if !matches!(options.stats, JsValue::Undefined) {
            writer.extend(b",\"stats\":")?;
            writer.value(options.stats)?;
        }
        writer.extend(b",\"strings\":[")?;
        for (index, value) in strings.iter().copied().enumerate() {
            if index != 0 {
                writer.byte(b',')?;
            }
            writer.string(value)?;
        }
        writer.extend(b"],\"layers\":[")?;
        for (index, layer) in layers.iter().enumerate() {
            if index != 0 {
                writer.byte(b',')?;
            }
            match layer {
                Some(layer) => {
                    writer.extend(b"{\"commands\":")?;
                    let count = commands_for_layer(*layer)
                        .expect("packet layer commands were validated")
                        .len();
                    writer.number(count as f64)?;
                    writer.byte(b'}')?;
                }
                None => writer.extend(b"null")?,
            }
        }
        writer.extend(b"]}")
    })();
    result.map_err(MetadataFailure::into_js_error)?;
    Ok(writer.finish())
}
