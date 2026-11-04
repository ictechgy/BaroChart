//! DOM을 만들지 않고 큰 OHLCV JSON 호출을 typed 열로 staging한다.
//!
//! 이 모듈은 decode만 하며 엔진 상태를 읽거나 바꾸지 않는다. 호출자는 전체 문법 검사가 끝난 뒤 receiver/namespace
//! gate를 먼저 확인하고, 그 다음 [`BulkDecode::DeferredError`]를 내거나 [`BulkDecode::Call`]을 commit해야 한다.

use std::mem::size_of;
use std::ops::Range;

use barochart_core::contracts::RESOURCE_LIMITS;
use barochart_core::data::Columns;
use barochart_js::error::JsError;
use barochart_js::json::{JsValue, JsonFailure, JsonMode, parse_json_scoped};
use barochart_js::memory::{MemoryFailure, MemoryScope};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

const FIELDS: [&str; 6] = ["time", "open", "high", "low", "close", "volume"];
const FIXED_TEXT_UNITS: usize = 32;

/// Generic bridge dispatch와 구분되는 typed bulk 경로다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkRoute {
    /// `nativeSetData(args[0])`; 뒤의 outer args는 source처럼 무시한다.
    LegacySetData,
    /// `nativeCommand("setData", args)`의 API facade 경로다.
    CommandSetData,
    /// `nativeCommand("setColumns", args)`의 API facade 경로다.
    CommandSetColumns,
}

/// API `setColumns`의 선택적 length다. 실제 store별 상한 검사는 receiver gate 뒤 commit이 맡는다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BulkLength {
    /// 인자가 빠졌거나 Lossless `undefined`다. time 열 길이를 쓴다.
    Missing,
    /// 원문 JSON number다. 정수·범위 검사는 live store의 maxBars로 지연한다.
    Number(f64),
}

/// receiver gate 뒤에 commit할 side-effect-free typed 호출이다.
#[derive(Debug)]
pub enum BulkCall {
    /// 여섯 열의 길이는 모두 같고 원문 bar 배열 길이다.
    SetData {
        /// legacy 또는 command API 경로다.
        route: BulkRoute,
        /// 원문 row를 columnar f64로 옮긴 소유 staging이다.
        columns: Columns,
    },
    /// API setColumns는 각 source tail을 모두 snapshot하므로 열 길이가 서로 다를 수 있다.
    SetColumns {
        /// 여섯 전체 JSON 배열의 소유 staging이다. `null`은 NaN gap이다.
        columns: Columns,
        /// 명시 length 또는 time 열 추론이다.
        length: BulkLength,
    },
}

/// 문법 검사가 끝난 eligible 호출의 결과다.
#[derive(Debug)]
pub enum BulkDecode {
    /// receiver/namespace gate 뒤 commit할 호출이다.
    Call(BulkCall),
    /// receiver/namespace gate가 성공한 뒤에만 내보낼 validation 오류다.
    DeferredError {
        /// 오류가 속한 route다.
        route: BulkRoute,
        /// 기존 bridge/core와 같은 JS 오류다.
        error: JsError,
    },
}

/// typed decoder 자체의 transport 실패다. Data 오류는 receiver 우선순위 때문에 [`BulkDecode`]에 들어간다.
#[derive(Debug)]
pub enum BulkFailure {
    /// UTF-8 JSON/BCJSON 문법 오류다. FFI는 `BC_INVALID`로 바꾼다.
    Syntax {
        /// 처음 확인한 잘못된 byte 위치다.
        position: usize,
    },
    /// account limit 또는 system allocation 실패다.
    Memory(MemoryFailure),
}

impl From<MemoryFailure> for BulkFailure {
    fn from(value: MemoryFailure) -> Self {
        Self::Memory(value)
    }
}

/// 큰 JSON 호출이 안전한 typed 경로면 decode하고, mutation 전 generic fallback이 필요하면 `None`을 돌려준다.
///
/// 전체 문서를 먼저 검사하므로 late syntax가 route/arity/data 오류보다 우선한다. `Some`을 돌려준 뒤에는 generic
/// fallback을 하면 안 된다. 반환된 열을 쓰는 동안 `scope`를 살려 temporary lease를 유지한다.
pub fn decode_bulk_call(
    function: &str,
    text: &[u8],
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Option<BulkDecode>, BulkFailure> {
    let document = validate_document(text, mode, scope)?;
    let Some(outer) = array_elements::<3>(text, document, mode, scope)? else {
        return Ok(None);
    };
    match function {
        "nativeSetData" => decode_set_data_route(
            text,
            outer.items[0].clone(),
            BulkRoute::LegacySetData,
            mode,
            dialect,
            scope,
        ),
        "nativeCommand" => decode_command(text, outer, mode, dialect, scope),
        _ => Ok(None),
    }
}

fn decode_command(
    text: &[u8],
    outer: ArrayElements<3>,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Option<BulkDecode>, BulkFailure> {
    let Some(operation_span) = outer.items[0].clone() else {
        return Ok(None);
    };
    let Some(operation) = fixed_string(text, operation_span) else {
        return Ok(None);
    };
    let (route, arity) = if operation.eq_ascii("setData") {
        (BulkRoute::CommandSetData, 1)
    } else if operation.eq_ascii("setColumns") {
        (BulkRoute::CommandSetColumns, 2)
    } else {
        // Events remain on the exact generic path until their strict batch/order contracts are
        // independently proven. This is an eligibility fallback before any mutation.
        return Ok(None);
    };
    let arguments = match outer.items[1].clone() {
        None => ArrayElements::<3>::empty(),
        Some(span) if token_is_undefined(text, &span, mode) => ArrayElements::<3>::empty(),
        Some(span) => match array_elements::<3>(text, span, mode, scope)? {
            Some(arguments) => arguments,
            None => {
                return Ok(Some(deferred(
                    route,
                    "TypeError",
                    "Unknown chart command or argument list",
                )));
            }
        },
    };
    if arguments.count > arity {
        return Ok(Some(deferred(
            route,
            "TypeError",
            "Chart command argument count",
        )));
    }
    match route {
        BulkRoute::CommandSetData => decode_set_data_route(
            text,
            arguments.items[0].clone(),
            route,
            mode,
            dialect,
            scope,
        ),
        BulkRoute::CommandSetColumns => decode_set_columns_route(
            text,
            arguments.items[0].clone(),
            arguments.items[1].clone(),
            mode,
            dialect,
            scope,
        ),
        BulkRoute::LegacySetData => unreachable!("command route"),
    }
}

fn decode_set_data_route(
    text: &[u8],
    bars: Option<Range<usize>>,
    route: BulkRoute,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Option<BulkDecode>, BulkFailure> {
    let Some(bars) = bars else {
        return Ok(Some(deferred(route, "TypeError", "OHLCV array required")));
    };
    let Some(count) = count_set_data(text, bars.clone(), mode, scope)? else {
        return Ok(None);
    };
    if count > RESOURCE_LIMITS.max_bars as usize {
        // Store maxBars can be smaller than the global cap, so the exact RangeError is live-state
        // dependent. The generic path retains that dynamic message without allocating typed data.
        return Ok(None);
    }
    let columns = parse_set_data(text, bars, count, mode, dialect, scope)?;
    Ok(Some(BulkDecode::Call(BulkCall::SetData { route, columns })))
}

fn decode_set_columns_route(
    text: &[u8],
    input: Option<Range<usize>>,
    length: Option<Range<usize>>,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Option<BulkDecode>, BulkFailure> {
    let Some(input) = input else {
        return Ok(None);
    };
    let Some(fields) = object_fields(text, input, mode, scope)? else {
        return Ok(None);
    };
    let mut counts = [0_usize; 6];
    for (index, field) in fields.iter().enumerate() {
        let Some(field) = field.clone() else {
            return Ok(None);
        };
        let Some(count) = count_column(text, field, mode, scope)? else {
            return Ok(None);
        };
        counts[index] = count;
    }
    let length = match length {
        None => BulkLength::Missing,
        Some(span) if token_is_undefined(text, &span, mode) => BulkLength::Missing,
        Some(span) if is_json_number(text, &span) => {
            BulkLength::Number(parse_number(text, span, mode, dialect, scope)?)
        }
        Some(_) => return Ok(None),
    };
    match parse_columns(text, &fields, counts, mode, dialect, scope)? {
        Ok(columns) => Ok(Some(BulkDecode::Call(BulkCall::SetColumns {
            columns,
            length,
        }))),
        Err(error) => Ok(Some(BulkDecode::DeferredError {
            route: BulkRoute::CommandSetColumns,
            error,
        })),
    }
}

fn deferred(route: BulkRoute, name: &'static str, message: &str) -> BulkDecode {
    BulkDecode::DeferredError {
        route,
        error: JsError::new(name, JsString::from_str(message)),
    }
}

fn count_set_data(
    text: &[u8],
    range: Range<usize>,
    mode: JsonMode,
    scope: &mut MemoryScope,
) -> Result<Option<usize>, BulkFailure> {
    let mut cursor = Cursor::at(text, range.start, mode);
    if !cursor.eat(b'[') {
        return Ok(None);
    }
    cursor.skip_whitespace();
    if cursor.eat(b']') {
        return Ok(Some(0));
    }
    let mut count = 0_usize;
    loop {
        let row = cursor.skip_value(scope)?;
        let Some(fields) = object_fields(text, row, mode, scope)? else {
            return Ok(None);
        };
        if fields.iter().any(|value| {
            value
                .as_ref()
                .is_none_or(|span| !is_json_number(text, span))
        }) {
            return Ok(None);
        }
        count = count
            .checked_add(1)
            .ok_or_else(|| scope.allocation_failure())?;
        cursor.skip_whitespace();
        if cursor.eat(b']') {
            return Ok(Some(count));
        }
        cursor.expect_byte(b',')?;
        cursor.skip_whitespace();
    }
}

fn parse_set_data(
    text: &[u8],
    range: Range<usize>,
    count: usize,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Columns, BulkFailure> {
    let mut columns = reserve_columns([count; 6], scope)?;
    let mut cursor = Cursor::at(text, range.start, mode);
    cursor.expect_byte(b'[')?;
    cursor.skip_whitespace();
    if cursor.eat(b']') {
        return Ok(columns);
    }
    loop {
        let row = cursor.skip_value(scope)?;
        let fields = object_fields(text, row, mode, scope)?.expect("eligible row object");
        let values = [
            parse_number(
                text,
                fields[0].clone().expect("eligible time"),
                mode,
                dialect,
                scope,
            )?,
            parse_number(
                text,
                fields[1].clone().expect("eligible open"),
                mode,
                dialect,
                scope,
            )?,
            parse_number(
                text,
                fields[2].clone().expect("eligible high"),
                mode,
                dialect,
                scope,
            )?,
            parse_number(
                text,
                fields[3].clone().expect("eligible low"),
                mode,
                dialect,
                scope,
            )?,
            parse_number(
                text,
                fields[4].clone().expect("eligible close"),
                mode,
                dialect,
                scope,
            )?,
            parse_number(
                text,
                fields[5].clone().expect("eligible volume"),
                mode,
                dialect,
                scope,
            )?,
        ];
        columns.time.push(values[0]);
        columns.open.push(values[1]);
        columns.high.push(values[2]);
        columns.low.push(values[3]);
        columns.close.push(values[4]);
        columns.volume.push(values[5]);
        cursor.skip_whitespace();
        if cursor.eat(b']') {
            return Ok(columns);
        }
        cursor.expect_byte(b',')?;
        cursor.skip_whitespace();
    }
}

fn count_column(
    text: &[u8],
    range: Range<usize>,
    mode: JsonMode,
    scope: &mut MemoryScope,
) -> Result<Option<usize>, BulkFailure> {
    let mut cursor = Cursor::at(text, range.start, mode);
    if !cursor.eat(b'[') {
        return Ok(None);
    }
    cursor.skip_whitespace();
    if cursor.eat(b']') {
        return Ok(Some(0));
    }
    let mut count = 0_usize;
    loop {
        let value = cursor.skip_value(scope)?;
        if !is_json_number(text, &value) && !token_is_null(text, &value) {
            return Ok(None);
        }
        count = count
            .checked_add(1)
            .ok_or_else(|| scope.allocation_failure())?;
        cursor.skip_whitespace();
        if cursor.eat(b']') {
            return Ok(Some(count));
        }
        cursor.expect_byte(b',')?;
        cursor.skip_whitespace();
    }
}

fn parse_columns(
    text: &[u8],
    fields: &[Option<Range<usize>>; 6],
    counts: [usize; 6],
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Result<Columns, JsError>, BulkFailure> {
    let time = match parse_column(
        text,
        fields[0].clone().expect("eligible time column"),
        counts[0],
        mode,
        dialect,
        scope,
    )? {
        Ok(values) => values,
        Err(error) => return Ok(Err(error)),
    };
    let open = match parse_column(
        text,
        fields[1].clone().expect("eligible open column"),
        counts[1],
        mode,
        dialect,
        scope,
    )? {
        Ok(values) => values,
        Err(error) => return Ok(Err(error)),
    };
    let high = match parse_column(
        text,
        fields[2].clone().expect("eligible high column"),
        counts[2],
        mode,
        dialect,
        scope,
    )? {
        Ok(values) => values,
        Err(error) => return Ok(Err(error)),
    };
    let low = match parse_column(
        text,
        fields[3].clone().expect("eligible low column"),
        counts[3],
        mode,
        dialect,
        scope,
    )? {
        Ok(values) => values,
        Err(error) => return Ok(Err(error)),
    };
    let close = match parse_column(
        text,
        fields[4].clone().expect("eligible close column"),
        counts[4],
        mode,
        dialect,
        scope,
    )? {
        Ok(values) => values,
        Err(error) => return Ok(Err(error)),
    };
    let volume = match parse_column(
        text,
        fields[5].clone().expect("eligible volume column"),
        counts[5],
        mode,
        dialect,
        scope,
    )? {
        Ok(values) => values,
        Err(error) => return Ok(Err(error)),
    };
    Ok(Ok(Columns {
        time,
        open,
        high,
        low,
        close,
        volume,
    }))
}

fn parse_column(
    text: &[u8],
    span: Range<usize>,
    count: usize,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Result<Vec<f64>, JsError>, BulkFailure> {
    let mut target = reserve_f64(count, scope)?;
    let mut cursor = Cursor::at(text, span.start, mode);
    cursor.expect_byte(b'[')?;
    cursor.skip_whitespace();
    if cursor.eat(b']') {
        return Ok(Ok(target));
    }
    loop {
        let value = cursor.skip_value(scope)?;
        if token_is_null(text, &value) {
            target.push(f64::NAN);
        } else {
            let value = parse_number(text, value, mode, dialect, scope)?;
            if !value.is_finite() {
                return Ok(Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Finite numbers or null gaps required"),
                )));
            }
            target.push(value);
        }
        cursor.skip_whitespace();
        if cursor.eat(b']') {
            return Ok(Ok(target));
        }
        cursor.expect_byte(b',')?;
        cursor.skip_whitespace();
    }
}

fn reserve_columns(counts: [usize; 6], scope: &mut MemoryScope) -> Result<Columns, BulkFailure> {
    Ok(Columns {
        time: reserve_f64(counts[0], scope)?,
        open: reserve_f64(counts[1], scope)?,
        high: reserve_f64(counts[2], scope)?,
        low: reserve_f64(counts[3], scope)?,
        close: reserve_f64(counts[4], scope)?,
        volume: reserve_f64(counts[5], scope)?,
    })
}

fn reserve_f64(count: usize, scope: &mut MemoryScope) -> Result<Vec<f64>, BulkFailure> {
    let bytes = count
        .checked_mul(size_of::<f64>())
        .ok_or_else(|| scope.allocation_failure())?;
    scope.try_grow(bytes)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| scope.allocation_failure())?;
    Ok(values)
}

fn parse_number(
    text: &[u8],
    range: Range<usize>,
    mode: JsonMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<f64, BulkFailure> {
    if let [digit @ b'0'..=b'9'] = &text[range.clone()] {
        return Ok(f64::from(*digit - b'0'));
    }
    match parse_json_scoped(&text[range.clone()], mode, dialect, scope) {
        Ok(JsValue::Number(value)) => Ok(value),
        Ok(_) => Err(BulkFailure::Syntax {
            position: range.start,
        }),
        Err(JsonFailure::Syntax(_)) => Err(BulkFailure::Syntax {
            position: range.start,
        }),
        Err(JsonFailure::Memory(failure)) => Err(BulkFailure::Memory(failure)),
    }
}

fn object_fields(
    text: &[u8],
    range: Range<usize>,
    mode: JsonMode,
    scope: &mut MemoryScope,
) -> Result<Option<[Option<Range<usize>>; 6]>, BulkFailure> {
    let mut cursor = Cursor::at(text, range.start, mode);
    if !cursor.eat(b'{') {
        return Ok(None);
    }
    let mut fields: [Option<Range<usize>>; 6] = std::array::from_fn(|_| None);
    cursor.skip_whitespace();
    if cursor.eat(b'}') {
        return Ok(Some(fields));
    }
    loop {
        let key = cursor.decode_fixed_string()?;
        cursor.skip_whitespace();
        cursor.expect_byte(b':')?;
        cursor.skip_whitespace();
        let value = cursor.skip_value(scope)?;
        if let Some(index) = FIELDS.iter().position(|field| key.eq_ascii(field)) {
            fields[index] = Some(value);
        }
        cursor.skip_whitespace();
        if cursor.eat(b'}') {
            return Ok(Some(fields));
        }
        cursor.expect_byte(b',')?;
        cursor.skip_whitespace();
    }
}

fn validate_document(
    text: &[u8],
    mode: JsonMode,
    scope: &mut MemoryScope,
) -> Result<Range<usize>, BulkFailure> {
    let mut cursor = Cursor::at(text, 0, mode);
    let value = cursor.skip_value(scope)?;
    cursor.skip_whitespace();
    if cursor.position != text.len() {
        return Err(cursor.syntax());
    }
    Ok(value)
}

struct ArrayElements<const N: usize> {
    count: usize,
    items: [Option<Range<usize>>; N],
}

impl<const N: usize> ArrayElements<N> {
    fn empty() -> Self {
        Self {
            count: 0,
            items: std::array::from_fn(|_| None),
        }
    }
}

fn array_elements<const N: usize>(
    text: &[u8],
    range: Range<usize>,
    mode: JsonMode,
    scope: &mut MemoryScope,
) -> Result<Option<ArrayElements<N>>, BulkFailure> {
    let mut cursor = Cursor::at(text, range.start, mode);
    if !cursor.eat(b'[') {
        return Ok(None);
    }
    let mut result = ArrayElements::empty();
    cursor.skip_whitespace();
    if cursor.eat(b']') {
        return Ok(Some(result));
    }
    loop {
        let value = cursor.skip_value(scope)?;
        if result.count < N {
            result.items[result.count] = Some(value);
        }
        result.count = result
            .count
            .checked_add(1)
            .ok_or_else(|| scope.allocation_failure())?;
        cursor.skip_whitespace();
        if cursor.eat(b']') {
            return Ok(Some(result));
        }
        cursor.expect_byte(b',')?;
        cursor.skip_whitespace();
    }
}

fn fixed_string(text: &[u8], range: Range<usize>) -> Option<FixedText> {
    let mut cursor = Cursor::at(text, range.start, JsonMode::Standard);
    let value = cursor.decode_fixed_string().ok()?;
    (cursor.position == range.end).then_some(value)
}

fn is_json_number(text: &[u8], range: &Range<usize>) -> bool {
    matches!(text.get(range.start), Some(b'-' | b'0'..=b'9'))
        && !text[range.clone()].starts_with(b"-Infinity")
}

fn token_is_null(text: &[u8], range: &Range<usize>) -> bool {
    text.get(range.clone()) == Some(b"null".as_slice())
}

fn token_is_undefined(text: &[u8], range: &Range<usize>, mode: JsonMode) -> bool {
    mode == JsonMode::Lossless && text.get(range.clone()) == Some(b"undefined".as_slice())
}

#[derive(Clone, Copy)]
enum Frame {
    Array(ArrayState),
    Object(ObjectState),
}

#[derive(Clone, Copy)]
enum ArrayState {
    FirstOrEnd,
    Value,
    CommaOrEnd,
}

#[derive(Clone, Copy)]
enum ObjectState {
    FirstKeyOrEnd,
    Key,
    Colon,
    Value,
    CommaOrEnd,
}

struct Cursor<'a> {
    text: &'a [u8],
    position: usize,
    mode: JsonMode,
}

impl<'a> Cursor<'a> {
    fn at(text: &'a [u8], position: usize, mode: JsonMode) -> Self {
        Self {
            text,
            position,
            mode,
        }
    }

    fn skip_value(&mut self, scope: &mut MemoryScope) -> Result<Range<usize>, BulkFailure> {
        self.skip_whitespace();
        let start = self.position;
        let mut stack = Vec::new();
        self.start_value(&mut stack, scope)?;
        while let Some(frame) = stack.last().copied() {
            match frame {
                Frame::Array(ArrayState::FirstOrEnd) => {
                    self.skip_whitespace();
                    if self.eat(b']') {
                        stack.pop();
                    } else {
                        *stack.last_mut().expect("array frame") =
                            Frame::Array(ArrayState::CommaOrEnd);
                        self.start_value(&mut stack, scope)?;
                    }
                }
                Frame::Array(ArrayState::Value) => {
                    self.skip_whitespace();
                    *stack.last_mut().expect("array frame") = Frame::Array(ArrayState::CommaOrEnd);
                    self.start_value(&mut stack, scope)?;
                }
                Frame::Array(ArrayState::CommaOrEnd) => {
                    self.skip_whitespace();
                    if self.eat(b',') {
                        *stack.last_mut().expect("array frame") = Frame::Array(ArrayState::Value);
                    } else if self.eat(b']') {
                        stack.pop();
                    } else {
                        return Err(self.syntax());
                    }
                }
                Frame::Object(ObjectState::FirstKeyOrEnd) => {
                    self.skip_whitespace();
                    if self.eat(b'}') {
                        stack.pop();
                    } else {
                        self.scan_string()?;
                        *stack.last_mut().expect("object frame") =
                            Frame::Object(ObjectState::Colon);
                    }
                }
                Frame::Object(ObjectState::Key) => {
                    self.skip_whitespace();
                    self.scan_string()?;
                    *stack.last_mut().expect("object frame") = Frame::Object(ObjectState::Colon);
                }
                Frame::Object(ObjectState::Colon) => {
                    self.skip_whitespace();
                    self.expect_byte(b':')?;
                    *stack.last_mut().expect("object frame") = Frame::Object(ObjectState::Value);
                }
                Frame::Object(ObjectState::Value) => {
                    self.skip_whitespace();
                    *stack.last_mut().expect("object frame") =
                        Frame::Object(ObjectState::CommaOrEnd);
                    self.start_value(&mut stack, scope)?;
                }
                Frame::Object(ObjectState::CommaOrEnd) => {
                    self.skip_whitespace();
                    if self.eat(b',') {
                        *stack.last_mut().expect("object frame") = Frame::Object(ObjectState::Key);
                    } else if self.eat(b'}') {
                        stack.pop();
                    } else {
                        return Err(self.syntax());
                    }
                }
            }
        }
        Ok(start..self.position)
    }

    fn start_value(
        &mut self,
        stack: &mut Vec<Frame>,
        scope: &mut MemoryScope,
    ) -> Result<(), BulkFailure> {
        match self.peek() {
            Some(b'[') => {
                self.position += 1;
                push_frame(stack, Frame::Array(ArrayState::FirstOrEnd), scope)
            }
            Some(b'{') => {
                self.position += 1;
                push_frame(stack, Frame::Object(ObjectState::FirstKeyOrEnd), scope)
            }
            Some(b'"') => self.scan_string().map(|_| ()),
            Some(b'-') if self.mode == JsonMode::Lossless && self.starts_with(b"-Infinity") => {
                self.consume_word(b"-Infinity")
            }
            Some(b'-' | b'0'..=b'9') => self.scan_number().map(|_| ()),
            Some(b't') => self.consume_word(b"true"),
            Some(b'f') => self.consume_word(b"false"),
            Some(b'n') => self.consume_word(b"null"),
            Some(b'N') if self.mode == JsonMode::Lossless => self.consume_word(b"NaN"),
            Some(b'I') if self.mode == JsonMode::Lossless => self.consume_word(b"Infinity"),
            Some(b'u') if self.mode == JsonMode::Lossless => self.consume_word(b"undefined"),
            _ => Err(self.syntax()),
        }
    }

    fn scan_number(&mut self) -> Result<Range<usize>, BulkFailure> {
        let start = self.position;
        self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => self.skip_digits(),
            _ => return Err(self.syntax()),
        }
        if self.eat(b'.') {
            if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                return Err(self.syntax());
            }
            self.skip_digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                return Err(self.syntax());
            }
            self.skip_digits();
        }
        Ok(start..self.position)
    }

    fn scan_string(&mut self) -> Result<Range<usize>, BulkFailure> {
        let start = self.position;
        self.decode_string(None)?;
        Ok(start..self.position)
    }

    fn decode_fixed_string(&mut self) -> Result<FixedText, BulkFailure> {
        let mut output = FixedText::new();
        self.decode_string(Some(&mut output))?;
        Ok(output)
    }

    fn decode_string(&mut self, mut output: Option<&mut FixedText>) -> Result<(), BulkFailure> {
        self.expect_byte(b'"')?;
        loop {
            let Some(byte) = self.peek() else {
                return Err(self.syntax());
            };
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(());
                }
                b'\\' => {
                    self.position += 1;
                    let Some(escape) = self.peek() else {
                        return Err(self.syntax());
                    };
                    self.position += 1;
                    let unit = match escape {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return Err(self.syntax()),
                    };
                    if let Some(output) = output.as_deref_mut() {
                        output.push(unit);
                    }
                }
                0x00..=0x1f => return Err(self.syntax()),
                0x20..=0x7f => {
                    self.position += 1;
                    if let Some(output) = output.as_deref_mut() {
                        output.push(u16::from(byte));
                    }
                }
                _ => {
                    let Some(width) = valid_utf8_width(self.text, self.position) else {
                        return Err(self.syntax());
                    };
                    let encoded = &self.text[self.position..self.position + width];
                    let character = std::str::from_utf8(encoded)
                        .ok()
                        .and_then(|text| text.chars().next())
                        .ok_or_else(|| self.syntax())?;
                    self.position += width;
                    if let Some(output) = output.as_deref_mut() {
                        let mut units = [0_u16; 2];
                        for unit in character.encode_utf16(&mut units) {
                            output.push(*unit);
                        }
                    }
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, BulkFailure> {
        let mut value = 0_u16;
        for _ in 0..4 {
            let Some(digit) = self.peek().and_then(hex_digit) else {
                return Err(self.syntax());
            };
            value = value * 16 + digit;
            self.position += 1;
        }
        Ok(value)
    }

    fn consume_word(&mut self, word: &[u8]) -> Result<(), BulkFailure> {
        if self.starts_with(word) {
            self.position += word.len();
            Ok(())
        } else {
            Err(self.syntax())
        }
    }

    fn expect_byte(&mut self, byte: u8) -> Result<(), BulkFailure> {
        if self.eat(byte) {
            Ok(())
        } else {
            Err(self.syntax())
        }
    }

    fn skip_digits(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.position += 1;
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn starts_with(&self, word: &[u8]) -> bool {
        self.text
            .get(self.position..)
            .is_some_and(|tail| tail.starts_with(word))
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.text.get(self.position).copied()
    }

    fn syntax(&self) -> BulkFailure {
        BulkFailure::Syntax {
            position: self.position,
        }
    }
}

fn push_frame(
    stack: &mut Vec<Frame>,
    frame: Frame,
    scope: &mut MemoryScope,
) -> Result<(), BulkFailure> {
    scope.try_grow(size_of::<Frame>())?;
    stack
        .try_reserve(1)
        .map_err(|_| scope.allocation_failure())?;
    stack.push(frame);
    Ok(())
}

struct FixedText {
    units: [u16; FIXED_TEXT_UNITS],
    length: usize,
    overflow: bool,
}

impl FixedText {
    fn new() -> Self {
        Self {
            units: [0; FIXED_TEXT_UNITS],
            length: 0,
            overflow: false,
        }
    }

    fn push(&mut self, unit: u16) {
        if self.length < self.units.len() {
            self.units[self.length] = unit;
        } else {
            self.overflow = true;
        }
        self.length = self.length.saturating_add(1);
    }

    fn eq_ascii(&self, expected: &str) -> bool {
        !self.overflow
            && self.length == expected.len()
            && self.units[..self.length]
                .iter()
                .copied()
                .eq(expected.bytes().map(u16::from))
    }
}

fn hex_digit(byte: u8) -> Option<u16> {
    match byte {
        b'0'..=b'9' => Some(u16::from(byte - b'0')),
        b'a'..=b'f' => Some(u16::from(byte - b'a' + 10)),
        b'A'..=b'F' => Some(u16::from(byte - b'A' + 10)),
        _ => None,
    }
}

fn valid_utf8_width(text: &[u8], position: usize) -> Option<usize> {
    let first = *text.get(position)?;
    let continuation = |offset: usize| {
        text.get(position + offset)
            .is_some_and(|byte| byte & 0xc0 == 0x80)
    };
    match first {
        0xc2..=0xdf if continuation(1) => Some(2),
        0xe0 if matches!(text.get(position + 1), Some(0xa0..=0xbf)) && continuation(2) => Some(3),
        0xe1..=0xec | 0xee..=0xef if continuation(1) && continuation(2) => Some(3),
        0xed if matches!(text.get(position + 1), Some(0x80..=0x9f)) && continuation(2) => Some(3),
        0xf0 if matches!(text.get(position + 1), Some(0x90..=0xbf))
            && continuation(2)
            && continuation(3) =>
        {
            Some(4)
        }
        0xf1..=0xf3 if continuation(1) && continuation(2) && continuation(3) => Some(4),
        0xf4 if matches!(text.get(position + 1), Some(0x80..=0x8f))
            && continuation(2)
            && continuation(3) =>
        {
            Some(4)
        }
        _ => None,
    }
}
