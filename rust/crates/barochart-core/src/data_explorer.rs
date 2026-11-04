//! Layout과 무관한 bounded semantic data query다.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryFailure, MemoryGroup, MemoryScope};
use barochart_js::string::JsString;

use crate::Host;
use crate::contracts::{RESOURCE_LIMITS, identifier};
use crate::data::{Bar, BarStore, DataIdentity, validate_bar};
use crate::indicator_engine::IndicatorEngine;
use crate::indicator_helpers::exact_state_equal;
use crate::model_state::{ModelState, Series, SeriesKind};

fn key(name: &str) -> JsString {
    JsString::from_str(name)
}
fn error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, JsString::from_str(message))
}
fn type_error(message: &str) -> JsError {
    error("TypeError", message)
}
fn range_error(message: &str) -> JsError {
    error("RangeError", message)
}
fn memory_error(error: MemoryFailure) -> JsError {
    error.into_js_error()
}
fn stale_error() -> JsError {
    error(
        "StaleSourceError",
        "Data query source or display configuration changed",
    )
}
fn value_string(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}
fn nullable_string(value: Option<&JsString>) -> JsValue {
    value.map_or(JsValue::Null, |value| JsValue::String(value.clone()))
}
fn nullable_number(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::Number)
}
fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item);
    }
    JsValue::Object(value)
}
fn property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}
fn text_property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsString> {
    match property(value, name) {
        Some(JsValue::String(value)) => Some(value),
        _ => None,
    }
}
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}
fn scoped_vec<T>(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = capacity
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}
fn scoped_hash_set<T>(capacity: usize, scope: &mut MemoryScope) -> Result<HashSet<T>, JsError>
where
    T: Eq + std::hash::Hash,
{
    let bytes = capacity
        .checked_mul(std::mem::size_of::<T>().saturating_add(16))
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = HashSet::new();
    values
        .try_reserve(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

/// Root symbol metadata projection이다.
#[derive(Clone, Debug)]
pub struct ExplorerSymbol {
    /// 기본 symbol id다.
    pub id: JsString,
    /// 표시 통화다.
    pub currency: JsString,
    /// 거래량 단위다.
    pub volume_unit: JsString,
}

/// 한 series query 상태다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataQueryStatus {
    /// plot offset 뒤 source가 저장 범위 밖이다.
    OutsideSource,
    /// source가 as-of cutoff 뒤다.
    AfterCutoff,
    /// historical query가 비정규 causal study를 가리킨다.
    UnsupportedCausality,
    /// cached mode가 linked study를 가리킨다.
    UnsupportedCache,
    /// clean whole-capacity cache가 아직 없다.
    Pending,
    /// 유한 값이다.
    Value,
    /// NaN gap이다.
    NonFinite,
}
impl DataQueryStatus {
    fn text(self) -> &'static str {
        match self {
            Self::OutsideSource => "outside-source",
            Self::AfterCutoff => "after-cutoff",
            Self::UnsupportedCausality => "unsupported-causality",
            Self::UnsupportedCache => "unsupported-cache",
            Self::Pending => "pending",
            Self::Value => "value",
            Self::NonFinite => "non-finite",
        }
    }
}

/// semantic query의 series 한 행이다.
#[derive(Clone, Debug)]
pub struct DataQuerySeries {
    /// series id다.
    pub id: JsString,
    /// 표시 label이다.
    pub label: JsString,
    /// panel id다.
    pub panel: JsString,
    /// optional axis id다.
    pub axis_id: Option<JsString>,
    /// 외부 또는 기본 symbol id다.
    pub symbol_id: Option<JsString>,
    /// 숨김 포함 여부를 반영한 visible 값이다.
    pub visible: bool,
    /// series renderer 종류다.
    pub series_type: JsString,
    /// source/external/indicator 종류다.
    pub kind: JsString,
    /// causality 분류다.
    pub causality: JsString,
    /// plot offset이다.
    pub offset: f64,
    /// 저장 열 이름이다.
    pub source: Option<JsString>,
    /// indicator id다.
    pub indicator: Option<JsString>,
    /// indicator output 이름이다.
    pub output: Option<JsString>,
    /// 유한 값 또는 null이다.
    pub value: Option<f64>,
    /// 실제 source index다. `-0`을 보존한다.
    pub source_index: Option<f64>,
    /// 실제 source UTC millisecond다.
    pub source_time: Option<f64>,
    /// query 상태다.
    pub status: DataQueryStatus,
}
impl DataQuerySeries {
    /// JS 공개 key 순서의 row를 만든다.
    pub fn to_js_value(&self) -> JsValue {
        object([
            ("id", JsValue::String(self.id.clone())),
            ("label", JsValue::String(self.label.clone())),
            ("panel", JsValue::String(self.panel.clone())),
            ("axisId", nullable_string(self.axis_id.as_ref())),
            ("symbolId", nullable_string(self.symbol_id.as_ref())),
            ("visible", JsValue::Bool(self.visible)),
            ("type", JsValue::String(self.series_type.clone())),
            ("kind", JsValue::String(self.kind.clone())),
            ("causality", JsValue::String(self.causality.clone())),
            ("offset", JsValue::Number(self.offset)),
            ("source", nullable_string(self.source.as_ref())),
            ("indicator", nullable_string(self.indicator.as_ref())),
            ("output", nullable_string(self.output.as_ref())),
            ("value", nullable_number(self.value)),
            ("sourceIndex", nullable_number(self.source_index)),
            ("sourceTime", nullable_number(self.source_time)),
            ("status", value_string(self.status.text())),
        ])
    }
}

/// semantic data snapshot이다.
#[derive(Debug)]
pub struct DataQueryResult {
    /// 선택 index다. explicit `-0`을 보존한다.
    pub index: f64,
    /// 선택 봉 시각이다.
    pub time: f64,
    /// as-of cutoff다. explicit `-0`을 보존한다.
    pub as_of_index: f64,
    /// 캡처한 store version이다.
    pub store_version: f64,
    /// optional 기본 symbol이다.
    pub symbol: Option<ExplorerSymbol>,
    /// 선택 OHLCV 봉이다.
    pub bar: Bar,
    /// 표시 대상 series 행들이다.
    pub series: Vec<DataQuerySeries>,
    _memory: MemoryGroup,
}
impl DataQueryResult {
    /// JS 공개 key 순서의 snapshot을 만든다.
    pub fn to_js_value(&self) -> JsValue {
        let symbol = self.symbol.as_ref().map_or(JsValue::Null, |symbol| {
            object([
                ("id", JsValue::String(symbol.id.clone())),
                ("currency", JsValue::String(symbol.currency.clone())),
                ("volumeUnit", JsValue::String(symbol.volume_unit.clone())),
            ])
        });
        let bar = object([
            ("time", JsValue::Number(self.bar.time)),
            ("open", JsValue::Number(self.bar.open)),
            ("high", JsValue::Number(self.bar.high)),
            ("low", JsValue::Number(self.bar.low)),
            ("close", JsValue::Number(self.bar.close)),
            ("volume", JsValue::Number(self.bar.volume)),
        ]);
        object([
            ("index", JsValue::Number(self.index)),
            ("time", JsValue::Number(self.time)),
            ("asOfIndex", JsValue::Number(self.as_of_index)),
            ("storeVersion", JsValue::Number(self.store_version)),
            ("primary", object([("symbol", symbol), ("bar", bar)])),
            (
                "series",
                JsValue::Array(
                    self.series
                        .iter()
                        .map(DataQuerySeries::to_js_value)
                        .collect(),
                ),
            ),
        ])
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IndicatorMode {
    Calculate,
    Cached,
}
struct QueryOptions {
    cutoff: f64,
    include_hidden: bool,
    mode: IndicatorMode,
}
enum Selection {
    Index(f64),
    Time { time: f64, at_or_before: bool },
}

fn record<'a>(value: &'a JsValue, allowed: &[&str], label: &str) -> Result<&'a JsObject, JsError> {
    let JsValue::Object(value) = value else {
        return Err(type_error(&format!("{label} plain record")));
    };
    if value.iter().any(|(name, _)| {
        !allowed
            .iter()
            .any(|allowed| name.as_units().iter().copied().eq(allowed.encode_utf16()))
    }) {
        return Err(type_error(&format!("{label} fields")));
    }
    Ok(value)
}
fn parse_selection(value: &JsValue) -> Result<Selection, JsError> {
    let value = record(value, &["index", "time", "match"], "Data selection")?;
    if let Some(index) = value.get(&key("index")) {
        let valid = value.len() == 1
            && matches!(index,JsValue::Number(index)if safe_integer(*index)&&*index>=0.0);
        if !valid {
            return Err(range_error("Data query index"));
        }
        let JsValue::Number(index) = index else {
            unreachable!()
        };
        return Ok(Selection::Index(*index));
    }
    let time = value.get(&key("time"));
    let mode = value.get(&key("match"));
    let valid = value.len() == 2
        && matches!(time,Some(JsValue::Number(time))if safe_integer(*time)&&time.abs()<=8_640_000_000_000_000.0)
        && matches!(mode,Some(JsValue::String(mode))if mode==&JsString::from_str("exact")||mode==&JsString::from_str("at-or-before"));
    if !valid {
        return Err(range_error("Data query time and explicit match"));
    }
    Ok(Selection::Time {
        time: match time.unwrap() {
            JsValue::Number(value) => *value,
            _ => unreachable!(),
        },
        at_or_before: matches!(mode,Some(JsValue::String(value))if value==&JsString::from_str("at-or-before")),
    })
}
fn parse_options(value: &JsValue, length: usize) -> Result<QueryOptions, JsError> {
    let value = record(
        value,
        &["asOfIndex", "includeHidden", "indicatorMode"],
        "Data query options",
    )?;
    if let Some(hidden) = value.get(&key("includeHidden"))
        && !matches!(hidden, JsValue::Bool(_))
    {
        return Err(type_error("Data query hidden flag"));
    }
    if let Some(mode) = value.get(&key("indicatorMode"))
        && !matches!(mode,JsValue::String(mode)if mode==&JsString::from_str("calculate")||mode==&JsString::from_str("cached"))
    {
        return Err(type_error("Data query indicator mode"));
    }
    let cutoff = match value.get(&key("asOfIndex")) {
        None => length as f64 - 1.0,
        Some(JsValue::Number(value))
            if safe_integer(*value) && *value >= -1.0 && *value < length as f64 =>
        {
            *value
        }
        _ => return Err(range_error("Data query cutoff")),
    };
    Ok(QueryOptions {
        cutoff,
        include_hidden: matches!(value.get(&key("includeHidden")), Some(JsValue::Bool(true))),
        mode: if matches!(value.get(&key("indicatorMode")),Some(JsValue::String(value))if value==&JsString::from_str("cached"))
        {
            IndicatorMode::Cached
        } else {
            IndicatorMode::Calculate
        },
    })
}

struct SeriesSnapshot {
    identity: usize,
    wire: JsValue,
    values: Option<(usize, usize)>,
}
struct EntrySnapshot {
    id: JsString,
    definition: usize,
    name: JsString,
    params: JsValue,
}
struct ExplorerSnapshot {
    data: DataIdentity,
    version: f64,
    time_version: f64,
    length: usize,
    capacity: usize,
    series: Vec<SeriesSnapshot>,
    panels: Vec<JsValue>,
    axes: Vec<JsValue>,
    entries: Vec<EntrySnapshot>,
    registry: Vec<&'static str>,
}
impl ExplorerSnapshot {
    fn capture(
        model: &ModelState,
        engine: &IndicatorEngine,
        store: &BarStore,
        scope: &mut MemoryScope,
    ) -> Result<Self, JsError> {
        let mut series_snapshots = scoped_vec(model.series.len(), scope)?;
        for series in &model.series {
            series_snapshots.push(SeriesSnapshot {
                identity: series as *const _ as usize,
                wire: series.to_js_value_scoped(scope).map_err(memory_error)?,
                values: series
                    .values
                    .as_ref()
                    .map(|values| (values.as_ptr() as usize, values.len())),
            });
        }
        let mut panels = scoped_vec(model.panels.len(), scope)?;
        for panel in &model.panels {
            panels.push(panel.to_js_value_scoped(scope).map_err(memory_error)?);
        }
        let mut axes = scoped_vec(model.axes.len(), scope)?;
        for axis in &model.axes {
            axes.push(axis.to_js_value_scoped(scope).map_err(memory_error)?);
        }
        let mut entries = scoped_vec(engine.len(), scope)?;
        for id in engine.entry_ids_iter() {
            let lookup = JsValue::String(id.try_clone_scoped(scope).map_err(memory_error)?);
            let entry = engine.entry(&lookup).expect("entry iterator id");
            entries.push(EntrySnapshot {
                id: id.try_clone_scoped(scope).map_err(memory_error)?,
                definition: entry.definition() as *const _ as usize,
                name: entry.name().try_clone_scoped(scope).map_err(memory_error)?,
                params: entry
                    .params()
                    .try_clone_scoped(scope)
                    .map_err(memory_error)?,
            });
        }
        let mut registry = scoped_vec(engine.registry_len(), scope)?;
        registry.extend(engine.registry().entries().map(|entry| entry.name));
        Ok(Self {
            data: store.data_identity(),
            version: store.version(),
            time_version: store.time_version(),
            length: store.length(),
            capacity: store.capacity(),
            series: series_snapshots,
            panels,
            axes,
            entries,
            registry,
        })
    }
    fn matches(
        &self,
        model: &ModelState,
        engine: &IndicatorEngine,
        store: &BarStore,
        scope: &mut MemoryScope,
    ) -> Result<bool, JsError> {
        let fixed = self.data.matches(&store.data_identity())
            && self.version == store.version()
            && self.time_version == store.time_version()
            && self.length == store.length()
            && self.capacity == store.capacity()
            && self.series.len() == model.series.len()
            && self
                .series
                .iter()
                .zip(&model.series)
                .all(|(expected, series)| {
                    expected.identity == series as *const _ as usize
                        && exact_state_equal(&expected.wire, series.raw_record_ref())
                        && expected.values
                            == series
                                .values
                                .as_ref()
                                .map(|values| (values.as_ptr() as usize, values.len()))
                })
            && self.panels.len() == model.panels.len()
            && self
                .panels
                .iter()
                .zip(&model.panels)
                .all(|(expected, panel)| exact_state_equal(expected, panel.raw_record()))
            && self.axes.len() == model.axes.len()
            && self
                .axes
                .iter()
                .zip(&model.axes)
                .all(|(expected, axis)| exact_state_equal(expected, axis.raw_record()))
            && self
                .registry
                .iter()
                .copied()
                .eq(engine.registry().entries().map(|entry| entry.name))
            && self.entries.len() == engine.len();
        if !fixed {
            return Ok(false);
        }
        for expected in &self.entries {
            let id = expected.id.try_clone_scoped(scope).map_err(memory_error)?;
            let matches = engine.entry(&JsValue::String(id)).is_some_and(|entry| {
                entry.definition() as *const _ as usize == expected.definition
                    && entry.name() == &expected.name
                    && exact_state_equal(entry.params(), &expected.params)
            });
            if !matches {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn checked_text_scoped(
    value: &JsString,
    max: usize,
    label: &str,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    if value.len_utf16() > max || value.as_units().is_empty() {
        return Err(type_error(&format!("{label}: string limit {max}")));
    }
    value.try_clone_scoped(scope).map_err(memory_error)
}

fn validate_identifier_scoped(
    value: &JsString,
    label: &str,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let value = JsValue::String(value.try_clone_scoped(scope).map_err(memory_error)?);
    identifier(&value, label).map(|_| ())
}
fn series_type_scoped(kind: SeriesKind, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    JsString::try_from_str(
        match kind {
            SeriesKind::Candles => "candles",
            SeriesKind::Ohlc => "ohlc",
            SeriesKind::Line => "line",
            SeriesKind::Area => "area",
            SeriesKind::Histogram => "histogram",
        },
        scope,
    )
    .map_err(memory_error)
}
fn raw_source_scoped(series: &Series, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    match series.source_value() {
        Some(JsValue::String(value)) => value.try_clone_scoped(scope).map_err(memory_error),
        _ => JsString::try_from_str("close", scope).map_err(memory_error),
    }
}

fn string_heap_bytes(value: &JsString, memory: &MemoryContext) -> Result<usize, JsError> {
    value
        .len_utf16()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| memory.allocation_failure().into_js_error())
}

fn optional_string_heap_bytes(
    value: Option<&JsString>,
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    value.map_or(Ok(0), |value| string_heap_bytes(value, memory))
}

fn result_heap_bytes(
    symbol: Option<&ExplorerSymbol>,
    series: &[DataQuerySeries],
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut bytes = series
        .len()
        .checked_mul(std::mem::size_of::<DataQuerySeries>())
        .ok_or_else(|| memory.allocation_failure().into_js_error())?;
    let mut add = |value: usize| -> Result<(), JsError> {
        bytes = bytes
            .checked_add(value)
            .ok_or_else(|| memory.allocation_failure().into_js_error())?;
        Ok(())
    };
    if let Some(symbol) = symbol {
        add(string_heap_bytes(&symbol.id, memory)?)?;
        add(string_heap_bytes(&symbol.currency, memory)?)?;
        add(string_heap_bytes(&symbol.volume_unit, memory)?)?;
    }
    for row in series {
        add(string_heap_bytes(&row.id, memory)?)?;
        add(string_heap_bytes(&row.label, memory)?)?;
        add(string_heap_bytes(&row.panel, memory)?)?;
        add(optional_string_heap_bytes(row.axis_id.as_ref(), memory)?)?;
        add(optional_string_heap_bytes(row.symbol_id.as_ref(), memory)?)?;
        add(string_heap_bytes(&row.series_type, memory)?)?;
        add(string_heap_bytes(&row.kind, memory)?)?;
        add(string_heap_bytes(&row.causality, memory)?)?;
        add(optional_string_heap_bytes(row.source.as_ref(), memory)?)?;
        add(optional_string_heap_bytes(row.indicator.as_ref(), memory)?)?;
        add(optional_string_heap_bytes(row.output.as_ref(), memory)?)?;
    }
    Ok(bytes)
}

struct Pending {
    row: DataQuerySeries,
    source: Option<(usize, f64)>,
    indicator: Option<(JsString, usize)>,
    external: Option<usize>,
}

/// scoped semantic query의 외부 입력 묶음이다.
pub struct DataAtRequest<'a> {
    /// index/time 선택 record다.
    pub query: &'a JsValue,
    /// cutoff/visibility/mode 옵션 record다.
    pub options: &'a JsValue,
    /// optional 기본 symbol projection이다.
    pub symbol: Option<&'a ExplorerSymbol>,
}

/// 실제 Store/Model/IndicatorEngine을 대상으로 한 semantic query다.
pub fn data_at(
    model: &ModelState,
    engine: &mut IndicatorEngine,
    store: &BarStore,
    host: &dyn Host,
    query: &JsValue,
    options: &JsValue,
    symbol: Option<&ExplorerSymbol>,
) -> Result<Option<DataQueryResult>, JsError> {
    let mut scope = store.memory_context().scope();
    data_at_scoped(
        model,
        engine,
        store,
        host,
        DataAtRequest {
            query,
            options,
            symbol,
        },
        &mut scope,
    )
}

/// query scratch를 호출 scope에 계상하고 반환 DTO payload는 Store account에 보유한다.
pub fn data_at_scoped(
    model: &ModelState,
    engine: &mut IndicatorEngine,
    store: &BarStore,
    host: &dyn Host,
    request: DataAtRequest<'_>,
    scope: &mut MemoryScope,
) -> Result<Option<DataQueryResult>, JsError> {
    let selection = parse_selection(request.query)?;
    let options = parse_options(request.options, store.length())?;
    if store.length() > RESOURCE_LIMITS.max_bars as usize {
        return Err(range_error("Data query source length"));
    }
    if model.series.len() > RESOURCE_LIMITS.max_series as usize {
        return Err(range_error("Data query series limit/shape"));
    }
    if model.panels.len() > RESOURCE_LIMITS.max_panels as usize {
        return Err(range_error("Data query panels limit/shape"));
    }
    if model.axes.len() > RESOURCE_LIMITS.max_axes as usize {
        return Err(range_error("Data query axes limit/shape"));
    }
    let memory = store.memory_context().clone();
    let mut retained_scope = memory.scope();
    let symbol = request
        .symbol
        .map(|symbol| -> Result<ExplorerSymbol, JsError> {
            Ok(ExplorerSymbol {
                id: checked_text_scoped(&symbol.id, 128, "Symbol id", &mut retained_scope)?,
                currency: checked_text_scoped(
                    &symbol.currency,
                    64,
                    "Currency",
                    &mut retained_scope,
                )?,
                volume_unit: checked_text_scoped(
                    &symbol.volume_unit,
                    64,
                    "Volume unit",
                    &mut retained_scope,
                )?,
            })
        })
        .transpose()?;
    let snapshot = ExplorerSnapshot::capture(model, engine, store, scope)?;
    let (index, array_index) = match selection {
        Selection::Index(index) => (index, index as usize),
        Selection::Time { time, at_or_before } => {
            let found = store.lower_bound(time);
            if found < store.length() && store.columns().time[found] == time {
                (found as f64, found)
            } else if at_or_before && found > 0 {
                ((found - 1) as f64, found - 1)
            } else {
                (-1.0, usize::MAX)
            }
        }
    };
    if index < 0.0 || array_index >= store.length() || index > options.cutoff {
        if !snapshot.matches(model, engine, store, scope)? {
            return Err(stale_error());
        }
        return Ok(None);
    }
    let bar = store.at(array_index)?;
    validate_bar(&bar, f64::NEG_INFINITY)?;
    let mut pending = scoped_vec(model.series.len(), scope)?;
    for series in &model.series {
        if !series.visible && !options.include_hidden {
            continue;
        }
        validate_identifier_scoped(&series.id, "Series id", scope)?;
        validate_identifier_scoped(&series.panel, "Series panel", scope)?;
        if let Some(axis) = &series.axis_id {
            validate_identifier_scoped(axis, "Series axis", scope)?;
        }
        if !model.panels.iter().any(|panel| panel.id == series.panel)
            || series.axis_id.as_ref().is_some_and(|axis| {
                !model
                    .axes
                    .iter()
                    .any(|candidate| candidate.id == *axis && candidate.panel == series.panel)
            })
        {
            return Err(type_error("Data query series binding"));
        }
        if !safe_integer(series.offset) || series.offset.abs() > 10_000.0 {
            return Err(range_error("Data query series offset"));
        }
        let raw = series.raw_record_ref();
        let label = checked_text_scoped(
            text_property(raw, "label").unwrap_or(&series.id),
            256,
            "Series label",
            &mut retained_scope,
        )?;
        let source_index = index - series.offset;
        let (kind, causality) = if series.values.is_some() {
            ("external", "host-aligned")
        } else if series.indicator.is_some() {
            ("indicator", "unverified-study")
        } else {
            ("source", "stored-source")
        };
        if series
            .values
            .as_ref()
            .is_some_and(|values| values.len() < store.length())
        {
            return Err(type_error("Data query Float64 column length"));
        }
        let source = if kind == "source" {
            Some(raw_source_scoped(series, &mut retained_scope)?)
        } else {
            None
        };
        if source.as_ref().is_some_and(|source| {
            !["time", "open", "high", "low", "close", "volume"]
                .iter()
                .any(|name| source.as_units().iter().copied().eq(name.encode_utf16()))
        }) {
            return Err(type_error("Data query source field"));
        }
        let (output, indicator_binding) = if let Some(indicator) = &series.indicator {
            let lookup = JsValue::String(indicator.try_clone_scoped(scope).map_err(memory_error)?);
            let entry = engine
                .entry(&lookup)
                .ok_or_else(|| ordinary_missing("Missing indicator"))?;
            let output_index = entry
                .definition()
                .outputs
                .iter()
                .position(|candidate| {
                    series.output.as_ref().map_or_else(
                        || *candidate == entry.definition().outputs[0],
                        |output| {
                            output
                                .as_units()
                                .iter()
                                .copied()
                                .eq(candidate.encode_utf16())
                        },
                    )
                })
                .ok_or_else(|| ordinary_missing("Missing indicator output"))?;
            let output = match &series.output {
                Some(output) => output
                    .try_clone_scoped(&mut retained_scope)
                    .map_err(memory_error)?,
                None => JsString::try_from_str(entry.definition().outputs[0], &mut retained_scope)
                    .map_err(memory_error)?,
            };
            (
                Some(output),
                Some((
                    indicator.try_clone_scoped(scope).map_err(memory_error)?,
                    output_index,
                )),
            )
        } else {
            (
                series
                    .output
                    .as_ref()
                    .map(|output| output.try_clone_scoped(&mut retained_scope))
                    .transpose()
                    .map_err(memory_error)?,
                None,
            )
        };
        let mut row = DataQuerySeries {
            id: series
                .id
                .try_clone_scoped(&mut retained_scope)
                .map_err(memory_error)?,
            label,
            panel: series
                .panel
                .try_clone_scoped(&mut retained_scope)
                .map_err(memory_error)?,
            axis_id: series
                .axis_id
                .as_ref()
                .map(|axis| axis.try_clone_scoped(&mut retained_scope))
                .transpose()
                .map_err(memory_error)?,
            symbol_id: if kind == "external" {
                text_property(raw, "symbolId")
                    .map(|symbol| symbol.try_clone_scoped(&mut retained_scope))
                    .transpose()
                    .map_err(memory_error)?
            } else {
                symbol
                    .as_ref()
                    .map(|symbol| symbol.id.try_clone_scoped(&mut retained_scope))
                    .transpose()
                    .map_err(memory_error)?
            },
            visible: series.visible,
            series_type: series_type_scoped(series.kind, &mut retained_scope)?,
            kind: JsString::try_from_str(kind, &mut retained_scope).map_err(memory_error)?,
            causality: JsString::try_from_str(causality, &mut retained_scope)
                .map_err(memory_error)?,
            offset: series.offset,
            source,
            indicator: series
                .indicator
                .as_ref()
                .map(|indicator| indicator.try_clone_scoped(&mut retained_scope))
                .transpose()
                .map_err(memory_error)?,
            output,
            value: None,
            source_index: None,
            source_time: None,
            status: DataQueryStatus::OutsideSource,
        };
        let source = if source_index >= 0.0
            && source_index < store.length() as f64
            && safe_integer(source_index)
        {
            Some(source_index as usize)
        } else {
            None
        };
        if source.is_none() {
            pending.push(Pending {
                row,
                source: None,
                indicator: None,
                external: None,
            });
            continue;
        }
        let source_index_usize = source.unwrap();
        if source_index > options.cutoff {
            row.status = DataQueryStatus::AfterCutoff;
            pending.push(Pending {
                row,
                source: None,
                indicator: None,
                external: None,
            });
            continue;
        }
        if let Some((indicator, output_index)) = &indicator_binding {
            let lookup = JsValue::String(indicator.try_clone_scoped(scope).map_err(memory_error)?);
            let entry = engine.entry(&lookup).unwrap();
            let canonical = entry.definition().program.is_builtin();
            if canonical {
                row.causality = JsString::try_from_str("canonical-builtin", &mut retained_scope)
                    .map_err(memory_error)?;
            }
            if options.cutoff < store.length() as f64 - 1.0 && !canonical {
                row.status = DataQueryStatus::UnsupportedCausality;
                pending.push(Pending {
                    row,
                    source: None,
                    indicator: None,
                    external: None,
                });
                continue;
            }
            if options.mode == IndicatorMode::Cached && !canonical {
                row.status = DataQueryStatus::UnsupportedCache;
                row.source_index = Some(source_index);
                row.source_time = Some(store.columns().time[source_index_usize]);
                pending.push(Pending {
                    row,
                    source: None,
                    indicator: None,
                    external: None,
                });
                continue;
            }
            if options.mode == IndicatorMode::Cached {
                let ready = entry.dirty() == store.length()
                    && entry.dirty_to() == Some(0)
                    && !entry.invalidated()
                    && entry.length() == store.length()
                    && entry
                        .output_capacity(entry.definition().outputs[*output_index])
                        .is_some_and(|values| values.len() == store.capacity());
                if !ready {
                    row.status = DataQueryStatus::Pending;
                    row.source_index = Some(source_index);
                    row.source_time = Some(store.columns().time[source_index_usize]);
                    pending.push(Pending {
                        row,
                        source: None,
                        indicator: None,
                        external: None,
                    });
                    continue;
                }
            }
        }
        pending.push(Pending {
            row,
            source: Some((source_index_usize, source_index)),
            indicator: indicator_binding,
            external: series.values.as_ref().map(|_| {
                model
                    .series
                    .iter()
                    .position(|candidate| std::ptr::eq(candidate, series))
                    .unwrap()
            }),
        });
    }
    if !snapshot.matches(model, engine, store, scope)? {
        return Err(stale_error());
    }
    let indicator_count = pending
        .iter()
        .filter(|item| item.indicator.is_some())
        .count();
    let mut calculated = scoped_hash_set(indicator_count, scope)?;
    for item in &mut pending {
        let Some((source, source_value)) = item.source else {
            continue;
        };
        let value = if let Some((indicator, output_index)) = &item.indicator {
            if options.mode == IndicatorMode::Calculate && !calculated.contains(indicator) {
                let calculated_id = indicator.try_clone_scoped(scope).map_err(memory_error)?;
                calculated.insert(calculated_id);
                let lookup =
                    JsValue::String(indicator.try_clone_scoped(scope).map_err(memory_error)?);
                engine.get(store, host, &lookup)?;
                if !snapshot.matches(model, engine, store, scope)? {
                    return Err(stale_error());
                }
            }
            let lookup = JsValue::String(indicator.try_clone_scoped(scope).map_err(memory_error)?);
            let entry = engine.entry(&lookup).ok_or_else(stale_error)?;
            entry
                .output_capacity(entry.definition().outputs[*output_index])
                .unwrap()[source]
        } else if let Some(series_index) = item.external {
            model.series[series_index].values.as_ref().unwrap()[source]
        } else {
            let field = item.row.source.as_ref().unwrap();
            match field.to_string_lossy().as_str() {
                "time" => store.columns().time[source],
                "open" => store.columns().open[source],
                "high" => store.columns().high[source],
                "low" => store.columns().low[source],
                "close" => store.columns().close[source],
                "volume" => store.columns().volume[source],
                _ => unreachable!(),
            }
        };
        item.row.value = value.is_finite().then_some(value);
        item.row.source_index = Some(source_value);
        item.row.source_time = Some(store.columns().time[source]);
        item.row.status = if value.is_finite() {
            DataQueryStatus::Value
        } else {
            DataQueryStatus::NonFinite
        };
    }
    if !snapshot.matches(model, engine, store, scope)? {
        return Err(stale_error());
    }
    let mut series = scoped_vec(pending.len(), &mut retained_scope)?;
    series.extend(pending.into_iter().map(|item| item.row));
    let retained_bytes = result_heap_bytes(symbol.as_ref(), &series, &memory)?;
    let result_memory = retained_scope
        .split_persistent(retained_bytes)
        .map_err(memory_error)?;
    Ok(Some(DataQueryResult {
        index,
        time: bar.time,
        as_of_index: options.cutoff,
        store_version: snapshot.version,
        symbol,
        bar,
        series,
        _memory: result_memory,
    }))
}
fn ordinary_missing(message: &str) -> JsError {
    error("Error", message)
}
