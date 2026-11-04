//! 소유 Float64 OHLCV 열, 원자적 저장소 변경과 batch transaction이다.

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;
use std::sync::Arc;

use crate::batch_options::BatchOptions;
use crate::contracts::RESOURCE_LIMITS;
use crate::range_index::RangeIndex;

const INITIAL_CAPACITY: usize = 16;
const BYTES_PER_CAPACITY: usize = 96;

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

/// OHLCV 한 행이다. 모든 값은 JS Number와 같은 binary64다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bar {
    /// UTC epoch 밀리초다.
    pub time: f64,
    /// 시가다.
    pub open: f64,
    /// 고가다.
    pub high: f64,
    /// 저가다.
    pub low: f64,
    /// 종가다.
    pub close: f64,
    /// 거래량이다.
    pub volume: f64,
}

impl Bar {
    fn same_value(&self, other: &Self) -> bool {
        self.time.to_bits() == other.time.to_bits()
            && self.open.to_bits() == other.open.to_bits()
            && self.high.to_bits() == other.high.to_bits()
            && self.low.to_bits() == other.low.to_bits()
            && self.close.to_bits() == other.close.to_bits()
            && self.volume.to_bits() == other.volume.to_bits()
    }
}

/// 행을 JS 검증 순서로 검사한다.
pub fn validate_bar(bar: &Bar, previous: f64) -> Result<(), JsError> {
    if ![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err(type_error("Every OHLCV field must be finite"));
    }
    if bar.time.fract() != 0.0
        || bar.time.abs() > 8_640_000_000_000_000.0
        || bar.time.abs() > 9_007_199_254_740_991.0
    {
        return Err(range_error(
            "Time must be an exact UTC millisecond integer in the Date range",
        ));
    }
    if bar.time <= previous {
        return Err(range_error("Times must be strictly increasing"));
    }
    let lower = if bar.open < bar.close {
        bar.open
    } else {
        bar.close
    };
    let upper = if bar.open > bar.close {
        bar.open
    } else {
        bar.close
    };
    if bar.volume < 0.0 || bar.low > lower || bar.high < upper || bar.low > bar.high {
        return Err(range_error("Invalid OHLCV envelope"));
    }
    Ok(())
}

/// plain JS 숫자 배열에서 관찰 가능한 원소 종류다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PlainNumber {
    /// Number 원소다.
    Number(f64),
    /// Number가 아닌 원소다.
    Invalid,
}

/// host에서 인정한 숫자 배열/typed-array 입력 종류다.
#[derive(Clone, Copy)]
pub enum NumericColumn<'a> {
    /// plain 숫자 배열이다.
    Plain(&'a [PlainNumber]),
    /// Float64Array다.
    F64(&'a [f64]),
    /// Float32Array다.
    F32(&'a [f32]),
    /// Int32Array다.
    I32(&'a [i32]),
    /// Uint32Array다.
    U32(&'a [u32]),
    /// Int16Array다.
    I16(&'a [i16]),
    /// Uint16Array다.
    U16(&'a [u16]),
    /// Int8Array다.
    I8(&'a [i8]),
    /// Uint8Array다.
    U8(&'a [u8]),
    /// Uint8ClampedArray다.
    U8Clamped(&'a [u8]),
    /// BigInt/DataView/알 수 없는 typed input이다.
    Unsupported,
    /// 빠진 열이다.
    Missing,
}

impl NumericColumn<'_> {
    fn admitted_len(&self) -> Option<usize> {
        match self {
            Self::Plain(values) => Some(values.len()),
            Self::F64(values) => Some(values.len()),
            Self::F32(values) => Some(values.len()),
            Self::I32(values) => Some(values.len()),
            Self::U32(values) => Some(values.len()),
            Self::I16(values) => Some(values.len()),
            Self::U16(values) => Some(values.len()),
            Self::I8(values) => Some(values.len()),
            Self::U8(values) | Self::U8Clamped(values) => Some(values.len()),
            Self::Unsupported | Self::Missing => None,
        }
    }

    fn copy_into(&self, target: &mut [f64], length: usize) -> Result<(), JsError> {
        match self {
            Self::Plain(values) => {
                for (target, value) in target.iter_mut().zip(&values[..length]) {
                    *target = match value {
                        PlainNumber::Number(value) if value.is_finite() => *value,
                        _ => return Err(type_error("Numeric column values required")),
                    };
                }
            }
            Self::F64(values) => target[..length].copy_from_slice(&values[..length]),
            Self::F32(values) => copy_cast(target, &values[..length], |value| f64::from(*value)),
            Self::I32(values) => copy_cast(target, &values[..length], |value| f64::from(*value)),
            Self::U32(values) => copy_cast(target, &values[..length], |value| f64::from(*value)),
            Self::I16(values) => copy_cast(target, &values[..length], |value| f64::from(*value)),
            Self::U16(values) => copy_cast(target, &values[..length], |value| f64::from(*value)),
            Self::I8(values) => copy_cast(target, &values[..length], |value| f64::from(*value)),
            Self::U8(values) | Self::U8Clamped(values) => {
                copy_cast(target, &values[..length], |value| f64::from(*value));
            }
            Self::Unsupported | Self::Missing => {
                return Err(type_error("Numeric column arrays required"));
            }
        }
        Ok(())
    }
}

fn copy_cast<T>(target: &mut [f64], source: &[T], cast: impl Fn(&T) -> f64) {
    for (target, value) in target.iter_mut().zip(source) {
        *target = cast(value);
    }
}

/// 여섯 입력 열이다.
pub struct ColumnInputs<'a> {
    /// time 입력이다.
    pub time: NumericColumn<'a>,
    /// open 입력이다.
    pub open: NumericColumn<'a>,
    /// high 입력이다.
    pub high: NumericColumn<'a>,
    /// low 입력이다.
    pub low: NumericColumn<'a>,
    /// close 입력이다.
    pub close: NumericColumn<'a>,
    /// volume 입력이다.
    pub volume: NumericColumn<'a>,
}

impl ColumnInputs<'_> {
    fn all(&self) -> [&NumericColumn<'_>; 6] {
        [
            &self.time,
            &self.open,
            &self.high,
            &self.low,
            &self.close,
            &self.volume,
        ]
    }
}

/// 저장소가 소유하는 여섯 Float64 열이다.
#[derive(Clone, Debug, PartialEq)]
pub struct Columns {
    /// time 열이다.
    pub time: Vec<f64>,
    /// open 열이다.
    pub open: Vec<f64>,
    /// high 열이다.
    pub high: Vec<f64>,
    /// low 열이다.
    pub low: Vec<f64>,
    /// close 열이다.
    pub close: Vec<f64>,
    /// volume 열이다.
    pub volume: Vec<f64>,
}

impl Columns {
    fn zeroed(capacity: usize) -> Self {
        Self {
            time: vec![0.0; capacity],
            open: vec![0.0; capacity],
            high: vec![0.0; capacity],
            low: vec![0.0; capacity],
            close: vec![0.0; capacity],
            volume: vec![0.0; capacity],
        }
    }

    fn bar(&self, index: usize) -> Bar {
        Bar {
            time: self.time[index],
            open: self.open[index],
            high: self.high[index],
            low: self.low[index],
            close: self.close[index],
            volume: self.volume[index],
        }
    }

    fn write(&mut self, index: usize, bar: Bar) {
        self.time[index] = bar.time;
        self.open[index] = bar.open;
        self.high[index] = bar.high;
        self.low[index] = bar.low;
        self.close[index] = bar.close;
        self.volume[index] = bar.volume;
    }
}

/// 저장소 생성 옵션이다.
#[derive(Clone, Copy, Debug)]
pub struct StoreOptions {
    /// 한 봉의 가상 밀리초 간격이다.
    pub timeframe_ms: f64,
    /// 빈 저장소의 시간 원점이다.
    pub time_origin: f64,
    /// 최대 행 수다.
    pub max_bars: usize,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            timeframe_ms: 60_000.0,
            time_origin: 0.0,
            max_bars: RESOURCE_LIMITS.max_bars as usize,
        }
    }
}

/// 모델 invalidation 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    /// 전체 교체다.
    Reset,
    /// 끝 추가다.
    Append,
    /// 같은 시각 교체다.
    Update,
    /// 앞쪽 추가다.
    Prepend,
    /// 원자적 batch다.
    Batch,
}

/// 커밋 뒤 원장·listener에 전달할 불변 변경 정보다.
#[derive(Clone, Debug, PartialEq)]
pub struct DataChange {
    /// 첫 변경 index다.
    pub from: usize,
    /// 반열린 마지막 index다.
    pub to: usize,
    /// 변경 종류다.
    pub kind: ChangeKind,
    /// 커밋된 store version이다.
    pub version: f64,
    /// append/prepend 행 수다.
    pub added: Option<usize>,
    /// added 자기 키의 존재 여부다. 열 reset은 존재하면서 값이 undefined다.
    pub added_present: bool,
    /// batch append 수다.
    pub appended: Option<usize>,
}

impl DataChange {
    /// JS listener change의 자기 키 존재와 순서를 그대로 보존한다.
    pub fn to_js_value(&self) -> JsValue {
        let kind = match self.kind {
            ChangeKind::Reset => "reset",
            ChangeKind::Append => "append",
            ChangeKind::Update => "update",
            ChangeKind::Prepend => "prepend",
            ChangeKind::Batch => "batch",
        };
        let mut record = JsObject::new();
        record.insert(
            JsString::from_str("from"),
            JsValue::Number(self.from as f64),
        );
        record.insert(
            JsString::from_str("kind"),
            JsValue::String(JsString::from_str(kind)),
        );
        record.insert(JsString::from_str("version"), JsValue::Number(self.version));
        if self.added_present {
            record.insert(
                JsString::from_str("added"),
                self.added
                    .map_or(JsValue::Undefined, |value| JsValue::Number(value as f64)),
            );
        }
        if let Some(appended) = self.appended {
            record.insert(
                JsString::from_str("appended"),
                JsValue::Number(appended as f64),
            );
            record.insert(JsString::from_str("to"), JsValue::Number(self.to as f64));
        }
        JsValue::Object(record)
    }
}

/// 저장소 커밋 결과와 이후 publication 정보를 분리한다.
#[derive(Clone, Debug, PartialEq)]
pub struct Committed<T> {
    /// 호출 결과다.
    pub value: T,
    /// 원장 뒤에 발행할 변경이다. no-op이면 없다.
    pub change: Option<DataChange>,
}

/// 원자적 batch가 받는 event다. 브리지 shape snapshot 뒤의 소유 값이다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BatchEvent {
    /// 새 마지막 봉이다.
    Append(Bar),
    /// 현재 마지막 봉 교체다.
    Update(Bar),
    /// 기존 시각 보정이다.
    Correction(Bar),
}

/// reset payload다.
#[derive(Clone, Debug, PartialEq)]
pub enum ResetData {
    /// 행 배열 전체 교체다.
    Bars(Vec<Bar>),
    /// 이미 소유 복사된 열과 논리 길이다.
    Columns { columns: Columns, length: usize },
}

/// 공개 저장소 event 여섯 종류다.
#[derive(Clone, Debug, PartialEq)]
pub enum DataEvent {
    /// 전체 데이터 교체다.
    Reset(ResetData),
    /// 끝 추가다.
    Append(Bar),
    /// 현재 봉 교체다.
    Update(Bar),
    /// 기존 시각 보정이다.
    Correction(Bar),
    /// 앞쪽 이력 추가다.
    Prepend(Vec<Bar>),
    /// 순서가 있는 원자적 batch다.
    Batch(Vec<BatchEvent>),
}

/// 단일 data event의 반환값이다.
#[derive(Clone, Debug, PartialEq)]
pub enum DataEventValue {
    /// JS undefined/null에 해당하는 값 없는 성공이다.
    None,
    /// append된 index다.
    Index(usize),
    /// batch 영수증이다.
    Batch(BatchReceipt),
}

/// batch 영수증이다. 필드 순서는 JS key 순서와 같다.
#[derive(Clone, Debug, PartialEq)]
pub struct BatchReceipt {
    /// event 수다.
    pub events: usize,
    /// append 수다.
    pub appended: usize,
    /// 첫 변경 index다.
    pub from: usize,
    /// 반열린 마지막 index다.
    pub to: usize,
    /// 결과 version이다.
    pub version: f64,
    /// 결과 길이다.
    pub length: usize,
    /// 결과 capacity다.
    pub capacity: usize,
    /// 결과 논리 소유 바이트다.
    pub bytes: usize,
    /// skipUnchanged를 요청했을 때만 값이 있다.
    pub unchanged: Option<bool>,
}

impl BatchReceipt {
    /// source 영수증의 키 순서와 선택적 unchanged 키 존재를 보존한다.
    pub fn to_js_value(&self) -> JsValue {
        let mut record = JsObject::new();
        for (key, value) in [
            ("events", self.events as f64),
            ("appended", self.appended as f64),
            ("from", self.from as f64),
            ("to", self.to as f64),
            ("version", self.version),
            ("length", self.length as f64),
            ("capacity", self.capacity as f64),
            ("bytes", self.bytes as f64),
        ] {
            record.insert(JsString::from_str(key), JsValue::Number(value));
        }
        if let Some(unchanged) = self.unchanged {
            record.insert(JsString::from_str("unchanged"), JsValue::Bool(unchanged));
        }
        JsValue::Object(record)
    }
}

/// 화면 집계 한 bucket이다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AggregateBar {
    /// 시작 index다.
    pub start: usize,
    /// 반열린 마지막 index다.
    pub end: usize,
    /// 중앙 fractional index다.
    pub index: f64,
    /// 첫 시각이다.
    pub time: f64,
    /// 첫 시가다.
    pub open: f64,
    /// 구간 고가다.
    pub high: f64,
    /// 구간 저가다.
    pub low: f64,
    /// 마지막 종가다.
    pub close: f64,
    /// 구간 거래량 합이다.
    pub volume: f64,
}

/// 한 모델이 소유하는 OHLCV 저장소다. listener는 이 타입 밖에서 [`DataChange`]를 받아 호출한다.
#[derive(Debug, PartialEq)]
pub struct BarStore {
    owner_identity: Arc<()>,
    columns_identity: Arc<()>,
    serial: f64,
    length: usize,
    capacity: usize,
    max_bars: usize,
    timeframe_ms: f64,
    time_origin: f64,
    version: f64,
    time_version: f64,
    columns: Columns,
    index: RangeIndex,
}

/// 계산 task가 보유해 allocator 주소 재사용과 무관하게 source를 식별하는 토큰이다.
#[derive(Clone, Debug)]
pub struct DataIdentity {
    owner: Arc<()>,
    columns: Arc<()>,
}

impl DataIdentity {
    /// 동일한 store 객체인가 확인한다. 스레드 간 순차 이동은 identity를 바꾸지 않는다.
    pub fn same_store(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner, &other.owner)
    }
    /// 동일한 열 소유 묶음인가 확인한다. 값의 제자리 수정은 identity를 바꾸지 않는다.
    pub fn same_columns(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.columns, &other.columns)
    }
    /// store와 열 identity가 모두 같은지 확인한다.
    pub fn matches(&self, other: &Self) -> bool {
        self.same_store(other) && self.same_columns(other)
    }
}

impl Clone for BarStore {
    fn clone(&self) -> Self {
        Self {
            owner_identity: Arc::new(()),
            columns_identity: Arc::new(()),
            serial: self.serial,
            length: self.length,
            capacity: self.capacity,
            max_bars: self.max_bars,
            timeframe_ms: self.timeframe_ms,
            time_origin: self.time_origin,
            version: self.version,
            time_version: self.time_version,
            columns: self.columns.clone(),
            index: self.index.clone(),
        }
    }
}

impl BarStore {
    fn new(serial: f64, options: StoreOptions, bars: Vec<Bar>) -> Result<Self, JsError> {
        if !options.timeframe_ms.is_finite()
            || options.timeframe_ms <= 0.0
            || !options.time_origin.is_finite()
        {
            return Err(range_error(
                "Virtual timeframe/origin or listener error callback",
            ));
        }
        if options.max_bars > RESOURCE_LIMITS.max_bars as usize {
            return Err(range_error(&format!(
                "Bar limit: limit {}",
                RESOURCE_LIMITS.max_bars
            )));
        }
        let columns = Columns::zeroed(INITIAL_CAPACITY);
        let index = RangeIndex::new(0, &[], &[], Some(&[]), INITIAL_CAPACITY, false)?;
        let mut store = Self {
            owner_identity: Arc::new(()),
            columns_identity: Arc::new(()),
            serial,
            length: 0,
            capacity: INITIAL_CAPACITY,
            max_bars: options.max_bars,
            timeframe_ms: options.timeframe_ms,
            time_origin: options.time_origin,
            version: 0.0,
            time_version: 0.0,
            columns,
            index,
        };
        store.set_data(bars)?;
        Ok(store)
    }

    /// 모델 소유자가 부여한 geometry serial이다.
    pub fn serial(&self) -> f64 {
        self.serial
    }
    /// 현재 source의 보유 identity를 돌려준다.
    pub fn data_identity(&self) -> DataIdentity {
        DataIdentity {
            owner: Arc::clone(&self.owner_identity),
            columns: Arc::clone(&self.columns_identity),
        }
    }
    /// 논리 행 수다.
    pub fn length(&self) -> usize {
        self.length
    }
    /// 열 capacity다.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
    /// 이 store의 구성에서 허용한 최대 행 수다.
    pub fn max_bars(&self) -> usize {
        self.max_bars
    }
    /// store version이다.
    pub fn version(&self) -> f64 {
        self.version
    }
    /// 시각 배치 version이다.
    pub fn time_version(&self) -> f64 {
        self.time_version
    }
    /// 여섯 열과 raw range tree의 소유 바이트다.
    pub fn bytes(&self) -> usize {
        self.capacity * BYTES_PER_CAPACITY
    }
    /// 열을 빌린다.
    pub fn columns(&self) -> &Columns {
        &self.columns
    }
    /// volume/price range index를 빌린다.
    pub fn index(&self) -> &RangeIndex {
        &self.index
    }

    /// 모든 행을 소유 snapshot한 뒤 한 번 교체한다.
    pub fn set_data(&mut self, bars: Vec<Bar>) -> Result<Committed<()>, JsError> {
        let length = bars.len();
        if length > self.max_bars {
            return Err(range_error(&format!("Bar count: limit {}", self.max_bars)));
        }
        let capacity = capacity_for(length);
        let mut columns = Columns::zeroed(capacity);
        let mut previous = f64::NEG_INFINITY;
        for (index, bar) in bars.into_iter().enumerate() {
            validate_bar(&bar, previous)?;
            previous = bar.time;
            columns.write(index, bar);
        }
        let index = RangeIndex::new(
            length,
            &columns.low,
            &columns.high,
            Some(&columns.volume),
            capacity,
            false,
        )?;
        self.commit_replacement(columns, index, length, capacity, ChangeKind::Reset, None)
    }

    /// 인정된 숫자 열을 모두 검증한 뒤 소유 Float64 열로 교체한다.
    pub fn set_columns(
        &mut self,
        input: &ColumnInputs<'_>,
        length: Option<usize>,
    ) -> Result<Committed<()>, JsError> {
        let length = match length {
            Some(length) => length,
            None => input
                .time
                .admitted_len()
                .ok_or_else(|| range_error(&format!("Bar count: limit {}", self.max_bars)))?,
        };
        if length > self.max_bars {
            return Err(range_error(&format!("Bar count: limit {}", self.max_bars)));
        }
        let sources = input.all();
        if sources
            .iter()
            .any(|source| source.admitted_len().is_none_or(|size| size < length))
        {
            return Err(type_error("Numeric column arrays required"));
        }
        let capacity = capacity_for(length);
        let mut columns = Columns::zeroed(capacity);
        for (source, target) in sources.into_iter().zip([
            &mut columns.time,
            &mut columns.open,
            &mut columns.high,
            &mut columns.low,
            &mut columns.close,
            &mut columns.volume,
        ]) {
            source.copy_into(target, length)?;
        }
        validate_columns(&columns, length)?;
        let index = RangeIndex::new(
            length,
            &columns.low,
            &columns.high,
            Some(&columns.volume),
            capacity,
            false,
        )?;
        let mut committed =
            self.commit_replacement(columns, index, length, capacity, ChangeKind::Reset, None)?;
        if let Some(change) = committed.change.as_mut() {
            change.added_present = true;
        }
        Ok(committed)
    }

    /// index의 행을 복사한다.
    pub fn at(&self, index: usize) -> Result<Bar, JsError> {
        if index >= self.length {
            return Err(range_error("Bar index"));
        }
        Ok(self.columns.bar(index))
    }

    /// 새 마지막 행을 원자적으로 붙인다.
    pub fn append(&mut self, bar: Bar) -> Result<Committed<usize>, JsError> {
        if self.length + 1 > self.max_bars {
            return Err(range_error(&format!("Bar count: limit {}", self.max_bars)));
        }
        validate_bar(
            &bar,
            if self.length == 0 {
                f64::NEG_INFINITY
            } else {
                self.columns.time[self.length - 1]
            },
        )?;
        if !(self.index.root_sum().unwrap_or(0.0) + bar.volume).is_finite() {
            return Err(range_error("Volume sum overflow"));
        }
        let index = self.length;
        if self.length == self.capacity {
            let mut staged = self.clone();
            staged.reserve_for(self.length + 1)?;
            staged.index.update(index, bar.low, bar.high, bar.volume)?;
            staged.columns.write(index, bar);
            staged.length += 1;
            staged.version += 1.0;
            staged.time_version += 1.0;
            self.adopt_staged(staged);
        } else {
            self.index.update(index, bar.low, bar.high, bar.volume)?;
            self.columns.write(index, bar);
            self.length += 1;
            self.version += 1.0;
            self.time_version += 1.0;
        }
        let change = self.change(index, self.length, ChangeKind::Append, None, None);
        Ok(Committed {
            value: index,
            change: Some(change),
        })
    }

    /// 기존 행을 같은 시각으로 원자 교체한다.
    pub fn update(&mut self, index: usize, bar: Bar) -> Result<Committed<()>, JsError> {
        if index >= self.length {
            return Err(range_error("Bar index"));
        }
        validate_bar(&bar, f64::NEG_INFINITY)?;
        if bar.time != self.columns.time[index] {
            return Err(range_error(
                "An edit cannot change time; reload to insert/reorder",
            ));
        }
        self.index.update(index, bar.low, bar.high, bar.volume)?;
        self.columns.write(index, bar);
        self.version += 1.0;
        let change = self.change(index, index + 1, ChangeKind::Update, None, None);
        Ok(Committed {
            value: (),
            change: Some(change),
        })
    }

    /// 더 이른 행을 한 번에 앞에 붙인다. 빈 입력은 no-op이다.
    pub fn prepend(&mut self, bars: Vec<Bar>) -> Result<Committed<()>, JsError> {
        if bars.is_empty() {
            return Ok(Committed {
                value: (),
                change: None,
            });
        }
        if bars.len() + self.length > self.max_bars {
            return Err(range_error(&format!("Bar count: limit {}", self.max_bars)));
        }
        if self.length != 0
            && bars
                .last()
                .is_some_and(|bar| bar.time >= self.columns.time[0])
        {
            return Err(range_error(
                "Prepend must precede existing history without overlap",
            ));
        }
        let added = bars.len();
        let mut combined = bars;
        combined.extend((0..self.length).map(|index| self.columns.bar(index)));
        let capacity = capacity_for(combined.len());
        let mut columns = Columns::zeroed(capacity);
        let mut previous = f64::NEG_INFINITY;
        for (position, bar) in combined.into_iter().enumerate() {
            validate_bar(&bar, previous)?;
            previous = bar.time;
            columns.write(position, bar);
        }
        let length = self.length + added;
        let index = RangeIndex::new(
            length,
            &columns.low,
            &columns.high,
            Some(&columns.volume),
            capacity,
            false,
        )?;
        self.commit_replacement(
            columns,
            index,
            length,
            capacity,
            ChangeKind::Prepend,
            Some(added),
        )
    }

    fn set_owned_columns(
        &mut self,
        source: Columns,
        length: usize,
    ) -> Result<Committed<()>, JsError> {
        if length > self.max_bars {
            return Err(range_error(&format!("Bar count: limit {}", self.max_bars)));
        }
        if [
            source.time.len(),
            source.open.len(),
            source.high.len(),
            source.low.len(),
            source.close.len(),
            source.volume.len(),
        ]
        .into_iter()
        .any(|source_length| source_length < length)
        {
            return Err(type_error("Numeric column arrays required"));
        }
        let capacity = capacity_for(length);
        let mut columns = Columns::zeroed(capacity);
        columns.time[..length].copy_from_slice(&source.time[..length]);
        columns.open[..length].copy_from_slice(&source.open[..length]);
        columns.high[..length].copy_from_slice(&source.high[..length]);
        columns.low[..length].copy_from_slice(&source.low[..length]);
        columns.close[..length].copy_from_slice(&source.close[..length]);
        columns.volume[..length].copy_from_slice(&source.volume[..length]);
        validate_columns(&columns, length)?;
        let index = RangeIndex::new(
            length,
            &columns.low,
            &columns.high,
            Some(&columns.volume),
            capacity,
            false,
        )?;
        let mut committed =
            self.commit_replacement(columns, index, length, capacity, ChangeKind::Reset, None)?;
        if let Some(change) = committed.change.as_mut() {
            change.added_present = true;
        }
        Ok(committed)
    }

    /// 정렬된 time 열의 lower bound다.
    pub fn lower_bound(&self, time: f64) -> usize {
        let mut left = 0;
        let mut right = self.length;
        while left < right {
            let middle = (left + right) >> 1;
            if self.columns.time[middle] < time {
                left = middle + 1;
            } else {
                right = middle;
            }
        }
        left
    }

    /// epoch 밀리초를 fractional bar index로 바꾼다.
    pub fn index_at_time(&self, time: f64) -> f64 {
        if self.length < 2 {
            return (time
                - if self.length == 0 {
                    self.time_origin
                } else {
                    self.columns.time[0]
                })
                / self.timeframe_ms;
        }
        let found = self.lower_bound(time);
        let index = found.clamp(1, self.length - 1);
        index as f64 - 1.0
            + (time - self.columns.time[index - 1])
                / (self.columns.time[index] - self.columns.time[index - 1])
    }

    /// fractional bar index를 선형 보간한 epoch 밀리초로 바꾼다.
    pub fn time_at_index(&self, index: f64) -> f64 {
        if self.length < 2 {
            return (if self.length == 0 {
                self.time_origin
            } else {
                self.columns.time[0]
            }) + index * self.timeframe_ms;
        }
        let floor = index.floor();
        let position = if floor <= 0.0 {
            0
        } else if floor >= (self.length - 2) as f64 {
            self.length - 2
        } else {
            floor as usize
        };
        self.columns.time[position]
            + (index - position as f64)
                * (self.columns.time[position + 1] - self.columns.time[position])
    }

    /// 화면 bucket 수 이하로 OHLCV를 집계한다.
    pub fn aggregate(
        &self,
        start: f64,
        end: f64,
        max_buckets: usize,
    ) -> Result<Vec<AggregateBar>, JsError> {
        if max_buckets == 0 {
            return Err(range_error("Positive bucket count required"));
        }
        if start.is_nan() || end.is_nan() {
            return Err(range_error("Aggregate bounds must not be NaN"));
        }
        let start = clamp_floor(start, self.length);
        let end = clamp_ceil(end, self.length);
        if end <= start {
            return Ok(Vec::new());
        }
        let count = std::cmp::min(end - start, max_buckets);
        let mut output = Vec::with_capacity(count);
        for bucket in 0..count {
            // 최대 2^22봉의 곱은 2^44까지 커지므로 wasm32 usize 곱을 피한다.
            let from = start + (bucket as u64 * (end - start) as u64 / count as u64) as usize;
            let to = start + ((bucket + 1) as u64 * (end - start) as u64 / count as u64) as usize;
            let query = self.index.query(from, to)?;
            output.push(AggregateBar {
                start: from,
                end: to,
                index: (from + to - 1) as f64 / 2.0,
                time: self.columns.time[from],
                open: self.columns.open[from],
                high: query.max,
                low: query.min,
                close: self.columns.close[to - 1],
                volume: query.sum,
            });
        }
        Ok(output)
    }

    /// append/update/correction 배열을 전부 stage한 뒤 한 번 커밋한다.
    pub fn apply_events(
        &mut self,
        events: &[BatchEvent],
        options: &BatchOptions,
    ) -> Result<Committed<BatchReceipt>, JsError> {
        if events.is_empty() || events.len() > 4096 {
            return Err(range_error("Data batch event count must be 1..4096"));
        }
        for event in events {
            validate_bar(event.bar(), f64::NEG_INFINITY)?;
        }
        let max_bars = budget(
            options.max_bars.as_ref(),
            self.max_bars,
            self.max_bars,
            "bar",
        )?;
        let max_bytes = budget(
            options.max_store_bytes.as_ref(),
            RESOURCE_LIMITS.max_bars as usize * BYTES_PER_CAPACITY,
            RESOURCE_LIMITS.max_bars as usize * BYTES_PER_CAPACITY,
            "store byte",
        )?;
        let appended = events
            .iter()
            .filter(|event| matches!(event, BatchEvent::Append(_)))
            .count();
        let length = self.length + appended;
        if length > max_bars {
            return Err(range_error(&format!(
                "Data batch bar budget limit {max_bars}"
            )));
        }
        let mut final_capacity = self.capacity;
        while final_capacity < length {
            final_capacity *= 2;
        }
        if final_capacity * BYTES_PER_CAPACITY > max_bytes {
            return Err(range_error(&format!(
                "Data batch store byte budget limit {max_bytes}"
            )));
        }
        let mut staged = self.clone();
        let mut from = length;
        let mut to = 0;
        let mut touched = Vec::new();
        for event in events {
            let (index, bar) = match event {
                BatchEvent::Append(bar) => {
                    let index = staged.length;
                    staged.append_staged(*bar)?;
                    (index, *bar)
                }
                BatchEvent::Update(bar) => {
                    if staged.length == 0 || bar.time != staged.columns.time[staged.length - 1] {
                        return Err(range_error(
                            "Data batch update is only the current timestamp",
                        ));
                    }
                    let index = staged.length - 1;
                    staged.update_staged(index, *bar)?;
                    (index, *bar)
                }
                BatchEvent::Correction(bar) => {
                    let index = staged.lower_bound(bar.time);
                    if index == staged.length || staged.columns.time[index] != bar.time {
                        return Err(range_error(
                            "Data batch correction requires an existing timestamp",
                        ));
                    }
                    staged.update_staged(index, *bar)?;
                    (index, *bar)
                }
            };
            from = std::cmp::min(from, index);
            to = std::cmp::max(to, index + 1);
            touched.push((index, bar));
        }
        let unchanged = options.skip_unchanged == Some(true)
            && appended == 0
            && touched.iter().all(|(index, _)| {
                staged
                    .columns
                    .bar(*index)
                    .same_value(&self.columns.bar(*index))
            });
        if unchanged {
            return Ok(Committed {
                value: BatchReceipt {
                    events: events.len(),
                    appended,
                    from,
                    to,
                    version: self.version,
                    length,
                    capacity: self.capacity,
                    bytes: self.bytes(),
                    unchanged: Some(true),
                },
                change: None,
            });
        }
        staged.version = self.version + 1.0;
        if appended > 0 {
            staged.time_version = self.time_version + 1.0;
        }
        let receipt = BatchReceipt {
            events: events.len(),
            appended,
            from,
            to,
            version: staged.version,
            length,
            capacity: staged.capacity,
            bytes: staged.bytes(),
            unchanged: (options.skip_unchanged == Some(true)).then_some(false),
        };
        let change = staged.change(from, to, ChangeKind::Batch, None, Some(appended));
        if staged.capacity == self.capacity {
            self.index.copy_tree_from(&staged.index)?;
            let mut committed = vec![false; staged.length];
            for (index, _) in touched {
                if !committed[index] {
                    self.columns.write(index, staged.columns.bar(index));
                    committed[index] = true;
                }
            }
            self.length = staged.length;
            self.version = staged.version;
            self.time_version = staged.time_version;
        } else {
            self.adopt_staged(staged);
        }
        Ok(Committed {
            value: receipt,
            change: Some(change),
        })
    }

    /// reset/append/update/correction/prepend/batch event 하나를 적용한다.
    pub fn apply_event(
        &mut self,
        event: DataEvent,
        batch_options: &BatchOptions,
    ) -> Result<Committed<DataEventValue>, JsError> {
        match event {
            DataEvent::Reset(ResetData::Bars(bars)) => self
                .set_data(bars)
                .map(|result| result.map_value(DataEventValue::None)),
            DataEvent::Reset(ResetData::Columns { columns, length }) => self
                .set_owned_columns(columns, length)
                .map(|result| result.map_value(DataEventValue::None)),
            DataEvent::Append(bar) => self
                .append(bar)
                .map(|result| result.map_with(DataEventValue::Index)),
            DataEvent::Update(bar) => {
                if self.length == 0 || bar.time != self.columns.time[self.length - 1] {
                    return Err(range_error("Update is only the current bar"));
                }
                self.update(self.length - 1, bar)
                    .map(|result| result.map_value(DataEventValue::None))
            }
            DataEvent::Correction(bar) => {
                let index = self.lower_bound(bar.time);
                if index == self.length || self.columns.time[index] != bar.time {
                    return Err(range_error("Correction requires an existing timestamp"));
                }
                self.update(index, bar)
                    .map(|result| result.map_value(DataEventValue::None))
            }
            DataEvent::Prepend(bars) => self
                .prepend(bars)
                .map(|result| result.map_value(DataEventValue::None)),
            DataEvent::Batch(events) => self
                .apply_events(&events, batch_options)
                .map(|result| result.map_with(DataEventValue::Batch)),
        }
    }

    fn append_staged(&mut self, bar: Bar) -> Result<(), JsError> {
        validate_bar(
            &bar,
            if self.length == 0 {
                f64::NEG_INFINITY
            } else {
                self.columns.time[self.length - 1]
            },
        )?;
        if !(self.index.root_sum().unwrap_or(0.0) + bar.volume).is_finite() {
            return Err(range_error("Volume sum overflow"));
        }
        self.reserve_for(self.length + 1)?;
        self.index
            .update(self.length, bar.low, bar.high, bar.volume)?;
        self.columns.write(self.length, bar);
        self.length += 1;
        Ok(())
    }

    fn update_staged(&mut self, index: usize, bar: Bar) -> Result<(), JsError> {
        self.index.update(index, bar.low, bar.high, bar.volume)?;
        self.columns.write(index, bar);
        Ok(())
    }

    fn reserve_for(&mut self, required: usize) -> Result<(), JsError> {
        if required <= self.capacity {
            return Ok(());
        }
        let mut capacity = self.capacity;
        while capacity < required {
            capacity *= 2;
        }
        let mut columns = Columns::zeroed(capacity);
        columns.time[..self.length].copy_from_slice(&self.columns.time[..self.length]);
        columns.open[..self.length].copy_from_slice(&self.columns.open[..self.length]);
        columns.high[..self.length].copy_from_slice(&self.columns.high[..self.length]);
        columns.low[..self.length].copy_from_slice(&self.columns.low[..self.length]);
        columns.close[..self.length].copy_from_slice(&self.columns.close[..self.length]);
        columns.volume[..self.length].copy_from_slice(&self.columns.volume[..self.length]);
        let index = RangeIndex::new(
            self.length,
            &columns.low,
            &columns.high,
            Some(&columns.volume),
            capacity,
            false,
        )?;
        let columns_identity = Arc::new(());
        self.capacity = capacity;
        self.columns = columns;
        self.columns_identity = columns_identity;
        self.index = index;
        Ok(())
    }

    fn commit_replacement(
        &mut self,
        columns: Columns,
        index: RangeIndex,
        length: usize,
        capacity: usize,
        kind: ChangeKind,
        added: Option<usize>,
    ) -> Result<Committed<()>, JsError> {
        let columns_identity = Arc::new(());
        self.columns = columns;
        self.columns_identity = columns_identity;
        self.index = index;
        self.length = length;
        self.capacity = capacity;
        self.version += 1.0;
        self.time_version += 1.0;
        let change = self.change(0, length, kind, added, None);
        Ok(Committed {
            value: (),
            change: Some(change),
        })
    }

    fn change(
        &self,
        from: usize,
        to: usize,
        kind: ChangeKind,
        added: Option<usize>,
        appended: Option<usize>,
    ) -> DataChange {
        DataChange {
            from,
            to,
            kind,
            version: self.version,
            added_present: added.is_some(),
            added,
            appended,
        }
    }

    // 동일 store의 원자 transaction은 owner를 유지하고 새 열 identity만 게시한다.
    fn adopt_staged(&mut self, mut staged: Self) {
        staged.owner_identity = Arc::clone(&self.owner_identity);
        *self = staged;
    }
}

impl BatchEvent {
    fn bar(&self) -> &Bar {
        match self {
            Self::Append(bar) | Self::Update(bar) | Self::Correction(bar) => bar,
        }
    }
}

impl<T> Committed<T> {
    fn map_value<U>(self, value: U) -> Committed<U> {
        Committed {
            value,
            change: self.change,
        }
    }

    fn map_with<U>(self, map: impl FnOnce(T) -> U) -> Committed<U> {
        Committed {
            value: map(self.value),
            change: self.change,
        }
    }
}

/// 현재 모델의 store를 소유한다. 네이티브 런타임의 serial 흐름은 Engine이 보존한다.
pub struct ModelDataState {
    store: BarStore,
}

impl ModelDataState {
    /// 첫 store를 serial 1로 만든다.
    pub fn new(options: StoreOptions, bars: Vec<Bar>) -> Result<Self, JsError> {
        Self::with_serial(1.0, options, bars)
    }

    /// 엔진이 소비한 store identity로 후보 상태를 만든다.
    pub(crate) fn with_serial(
        serial: f64,
        options: StoreOptions,
        bars: Vec<Bar>,
    ) -> Result<Self, JsError> {
        Ok(Self {
            store: BarStore::new(serial, options, bars)?,
        })
    }

    /// 현재 store를 빌린다.
    pub fn store(&self) -> &BarStore {
        &self.store
    }

    /// store를 배타적으로 빌린다. 향후 ingestion 필드는 별도 field borrow로 추가한다.
    pub fn store_mut(&mut self) -> &mut BarStore {
        &mut self.store
    }
}

/// 결정적 합성 열을 JS LCG와 같은 binary64 연산 순서로 만든다.
pub fn seeded_columns(length: usize, seed: u32) -> Result<Columns, JsError> {
    if length > RESOURCE_LIMITS.max_bars as usize {
        return Err(range_error(&format!(
            "Synthetic bar count: limit {}",
            RESOURCE_LIMITS.max_bars
        )));
    }
    let mut state = seed;
    let mut price = 100.0;
    let mut columns = Columns::zeroed(length);
    let mut random = || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(state) / 4_294_967_296.0
    };
    for index in 0..length {
        let open = price;
        let next = price + (random() - 0.497) * 1.2;
        price = if next > 0.1 { next } else { 0.1 };
        columns.time[index] = 1_700_000_000_000.0 + index as f64 * 60_000.0;
        columns.open[index] = open;
        columns.close[index] = price;
        let top = if open > price { open } else { price };
        let bottom = if open < price { open } else { price };
        columns.high[index] = top + random() * 0.6;
        let low = bottom - random() * 0.6;
        columns.low[index] = if low > 0.01 { low } else { 0.01 };
        columns.volume[index] = (100.0 + random() * 9_900.0).floor();
    }
    Ok(columns)
}

fn validate_columns(columns: &Columns, length: usize) -> Result<(), JsError> {
    let mut previous = f64::NEG_INFINITY;
    for index in 0..length {
        let bar = columns.bar(index);
        validate_bar(&bar, previous)?;
        previous = bar.time;
    }
    Ok(())
}

fn capacity_for(length: usize) -> usize {
    let mut capacity = INITIAL_CAPACITY;
    while capacity < length {
        capacity *= 2;
    }
    capacity
}

fn budget(
    value: Option<&JsValue>,
    default: usize,
    max: usize,
    label: &str,
) -> Result<usize, JsError> {
    let value = match value {
        None | Some(JsValue::Undefined) => return Ok(default),
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    };
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > max as f64 {
        return Err(range_error(&format!(
            "Data batch {label} budget limit {max}"
        )));
    }
    Ok(value as usize)
}

fn clamp_floor(value: f64, length: usize) -> usize {
    if value <= 0.0 {
        0
    } else if value >= length as f64 {
        length
    } else {
        value.floor() as usize
    }
}

fn clamp_ceil(value: f64, length: usize) -> usize {
    if value <= 0.0 {
        0
    } else if value >= length as f64 {
        length
    } else {
        value.ceil() as usize
    }
}
