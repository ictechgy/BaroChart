//! 네이티브 런타임이 게시하는 단일 차트 합성 소유자다.
//!
//! 브리지는 store serial과 seed-42 열을 먼저 준비한다. 이 모듈은 그 후보를 한 번만
//! [`IngestionOwner`]로 감싸고 model/indicator/drawing/cache를 같은 수명에 연결한다.

#![forbid(unsafe_code)]

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::contracts::{RESOURCE_LIMITS, portable_color, portable_font};
use crate::data::{BarStore, Committed, DataChange, ModelDataState};
use crate::drawing_geometry::DrawingGeometryCache;
use crate::drawings::DrawingStore;
use crate::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use crate::ingestion::IngestionOwner;
use crate::layout::{Layout, create_layout_with_memory};
use crate::markets::Symbol;
use crate::model_state::{
    DrawingUsage, IndicatorProjection, InteractionGuard, ModelContext, ModelState,
    PreparedStoreChangePublication, Series, SeriesKind,
};
use crate::scene::{
    CachedSeriesRange, ResolvedCrosshair, SceneInput, SeriesRangeView, SeriesRenderInput,
};
use crate::scene_parts::{self, SceneTheme};
use crate::series_cache::SeriesCaches;

const SERIES_COLORS: &[&str] = &["color", "fill", "upColor", "downColor"];

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item);
    }
    JsValue::Object(value)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}

fn nullish(
    value: Option<&JsValue>,
    default: JsValue,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    match value {
        None | Some(JsValue::Null | JsValue::Undefined) => Ok(default),
        Some(value) => value
            .try_clone_scoped(scope)
            .map_err(|error| error.into_js_error()),
    }
}

fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => false,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Bool(true) | JsValue::Object(_) | JsValue::Array(_) => true,
    }
}

fn legacy_panels() -> JsValue {
    JsValue::Array(vec![
        object([
            ("id", text("price")),
            ("weight", JsValue::Number(3.0)),
            ("label", text("ASTER · NATIVE")),
        ]),
        object([
            ("id", text("volume")),
            ("weight", JsValue::Number(1.0)),
            ("label", text("VOLUME")),
        ]),
    ])
}

fn typed_panels() -> JsValue {
    JsValue::Array(vec![object([
        ("id", text("price")),
        ("weight", JsValue::Number(3.0)),
    ])])
}

fn model_options(
    options: Option<&JsObject>,
    legacy: bool,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut value = JsObject::new();
    let source = |name| options.and_then(|options| options.get(&key(name)));
    value.insert(
        key("axes"),
        nullish(source("axes"), JsValue::Array(Vec::new()), scope)?,
    );
    value.insert(
        key("panels"),
        nullish(
            source("panels"),
            if legacy {
                legacy_panels()
            } else {
                typed_panels()
            },
            scope,
        )?,
    );
    value.insert(
        key("visibleBars"),
        nullish(source("visibleBars"), JsValue::Number(200.0), scope)?,
    );
    value.insert(
        key("axisWidth"),
        nullish(source("axisWidth"), JsValue::Number(82.0), scope)?,
    );
    value.insert(
        key("precision"),
        nullish(source("precision"), JsValue::Number(2.0), scope)?,
    );
    Ok(JsValue::Object(value))
}

pub(crate) fn numeric_values_with_memory(
    value: &JsValue,
    memory: &MemoryContext,
) -> Result<(Vec<f64>, MemoryGroup), JsError> {
    let JsValue::Array(values) = &value else {
        return Err(type_error("Values must be Float64Array or a JSON array"));
    };
    // Source values()는 모든 scalar를 먼저 검증한 뒤 Float64Array를 만든다.
    for value in values {
        if !matches!(value, JsValue::Null)
            && !matches!(value, JsValue::Number(number) if number.is_finite())
        {
            return Err(type_error("Finite numbers or null gaps required"));
        }
    }
    let (mut output, group) = memory
        .try_vec_capacity(values.len())
        .map_err(|error| error.into_js_error())?;
    for value in values {
        match value {
            JsValue::Null => output.push(f64::NAN),
            JsValue::Number(value) if value.is_finite() => output.push(*value),
            _ => unreachable!("validated numeric snapshot"),
        }
    }
    Ok((output, group))
}

/// ChartAPI add/setSeries가 공유하는 portable style과 owned values snapshot이다.
pub(crate) struct ApiSeriesOptions {
    pub normalized: JsValue,
    pub values: Option<(Vec<f64>, MemoryGroup)>,
}

pub(crate) fn api_series_options_scoped(
    options: &JsValue,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<ApiSeriesOptions, JsError> {
    let count = match options {
        JsValue::Object(record) => record.len(),
        JsValue::Array(values) => values.len(),
        JsValue::String(value) => value.len_utf16(),
        _ => 0,
    };
    let (mut entries, _entries_memory) = memory
        .try_vec_capacity(count)
        .map_err(|error| error.into_js_error())?;
    let values_key = key("values");
    let mut push = |name: &JsString, value: &JsValue| -> Result<(), JsError> {
        if name == &values_key && !matches!(value, JsValue::Null | JsValue::Undefined) {
            return Ok(());
        }
        let name = name
            .try_clone_scoped(scope)
            .map_err(|error| error.into_js_error())?;
        entries.push((
            name,
            value
                .try_clone_scoped(scope)
                .map_err(|error| error.into_js_error())?,
        ));
        Ok(())
    };
    match options {
        JsValue::Object(record) => {
            for (name, value) in record.iter() {
                push(name, value)?;
            }
        }
        JsValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                push(&key(&index.to_string()), value)?;
            }
        }
        JsValue::String(value) => {
            for (index, unit) in value.as_units().iter().enumerate() {
                push(
                    &key(&index.to_string()),
                    &JsValue::String(JsString::from_utf16(vec![*unit])),
                )?;
            }
        }
        _ => {}
    }
    let mut record =
        JsObject::try_from_entries_scoped(entries, scope).map_err(|error| error.into_js_error())?;
    for name in SERIES_COLORS {
        let name = key(name);
        if let Some(value) = record.get(&name)
            && !matches!(value, JsValue::Undefined)
            && !(name == key("fill") && matches!(value, JsValue::Null))
        {
            let color = portable_color(value)?;
            record.insert(name, JsValue::String(color));
        }
    }
    if let Some(font) = record.get(&key("font"))
        && !matches!(font, JsValue::Undefined)
    {
        let font = portable_font(font)?;
        record.insert(key("font"), JsValue::String(font));
    }
    let values = match property_value(options, "values") {
        None | Some(JsValue::Null | JsValue::Undefined) => None,
        Some(value) => Some(numeric_values_with_memory(value, memory)?),
    };
    Ok(ApiSeriesOptions {
        normalized: JsValue::Object(record),
        values,
    })
}

/// Root interaction owner가 model 검증에 주입하는 짧은 snapshot이다.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeInteractionContext<'a> {
    /// 활성 gesture 여부다.
    pub gesture_active: bool,
    /// 활성 pointer 수다.
    pub pointer_count: usize,
    /// 현재 drawing target panel이다.
    pub target_panel: Option<&'a JsString>,
    /// 현재 drawing target axis다.
    pub target_axis: Option<&'a JsString>,
}

/// 게시 가능한 네이티브 차트 상태 전체다.
pub struct NativeChart {
    identity: Arc<()>,
    pub(crate) ingestion: IngestionOwner,
    pub(crate) model: ModelState,
    pub(crate) indicators: IndicatorEngine,
    pub(crate) drawings: DrawingStore,
    pub(crate) series_caches: SeriesCaches,
    pub(crate) drawing_cache: DrawingGeometryCache,
    pub(crate) symbol: Option<Symbol>,
    pub(crate) symbol_record: Option<JsValue>,
    pub(crate) symbol_formatters: bool,
    symbol_memory: MemoryGroup,
    formatter_identity: Arc<()>,
    pub(crate) dialect: NumberDialect,
    retained_memory: MemoryGroup,
}

/// Frame static key가 portable price/time formatter pair identity를 보존하는 token이다.
pub struct NativeFormatterIdentityToken {
    identity: Arc<()>,
}

/// `setSymbol` 검증/retention과 formatter identity allocation을 끝낸 publication 후보다.
pub(crate) struct PreparedSymbolPublication {
    symbol: Symbol,
    record: JsValue,
    memory: MemoryGroup,
    formatter_identity: Arc<()>,
}

/// Runtime source row가 nativeModel object 교체를 구분하는 token이다.
pub struct NativeChartIdentityToken {
    identity: Arc<()>,
}

/// 이미 검증·계산된 owner들을 재생성 없이 한 차트로 채택하는 publication parts다.
pub struct NativeChartParts {
    pub ingestion: IngestionOwner,
    pub model: ModelState,
    pub indicators: IndicatorEngine,
    pub drawings: DrawingStore,
    pub series_caches: SeriesCaches,
    pub symbol: Option<Symbol>,
    pub symbol_record: Option<JsValue>,
    pub symbol_formatters: bool,
    /// `symbol`과 원본 ordered record의 실제 retained allocation lease다.
    pub symbol_memory: MemoryGroup,
    pub dialect: NumberDialect,
}

impl NativeChart {
    /// caller가 이미 serial을 소비하고 seed-42 열을 설치한 후보 data로 차트를 staging한다.
    /// 반환 성공 전에는 외부 live chart를 바꾸지 않는다.
    pub fn new(
        data: ModelDataState,
        options: &JsValue,
        dialect: NumberDialect,
        host: &dyn Host,
    ) -> Result<Self, JsError> {
        let memory = data.store().memory_context().clone();
        let mut scope = memory.scope();
        Self::new_scoped(data, options, dialect, host, &mut scope)
    }

    /// caller scope에서 nativeInit options와 동적 오류 payload를 staging 완료까지 유지한다.
    pub fn new_scoped(
        data: ModelDataState,
        options: &JsValue,
        dialect: NumberDialect,
        host: &dyn Host,
        scope: &mut MemoryScope,
    ) -> Result<Self, JsError> {
        let (legacy, options) = match options {
            JsValue::Null | JsValue::Undefined => (true, None),
            JsValue::Object(options) => (false, Some(options)),
            _ => return Err(type_error("Chart options object")),
        };
        let memory = data.store().memory_context().clone();
        let ingestion = IngestionOwner::new(data, dialect);
        // JS nativeInit은 theme/series를 ChartModel 생성자에 넘기지 않는다.
        let initial_options = model_options(options, legacy, scope)?;
        let model = ModelState::new(ingestion.data().store(), &initial_options)?;
        let indicators =
            IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), memory.clone())?;
        let drawings = DrawingStore::with_defaults_and_memory(dialect, memory.clone())?;
        let mut chart = Self {
            identity: Arc::new(()),
            ingestion,
            model,
            indicators,
            drawings,
            series_caches: SeriesCaches::new_with_memory(memory.clone()),
            drawing_cache: DrawingGeometryCache::new_with_memory(
                RESOURCE_LIMITS.max_drawings as usize,
                memory.clone(),
            )?,
            symbol: None,
            symbol_record: None,
            symbol_formatters: false,
            symbol_memory: MemoryGroup::empty(memory.clone()),
            formatter_identity: Arc::new(()),
            dialect,
            retained_memory: MemoryGroup::empty(memory.clone()),
        };
        if legacy {
            chart.add_legacy_series_scoped(
                &object([
                    ("id", text("price")),
                    ("type", text("candles")),
                    ("panel", text("price")),
                ]),
                scope,
            )?;
            chart.add_legacy_series_scoped(
                &object([
                    ("id", text("volume")),
                    ("type", text("histogram")),
                    ("panel", text("volume")),
                    ("source", text("volume")),
                    ("color", text("#397e8c")),
                ]),
                scope,
            )?;
            let (ingestion, indicators) = (&chart.ingestion, &mut chart.indicators);
            indicators.add_scoped(
                ingestion.data().store(),
                host,
                &text("ema"),
                &text("ema"),
                &JsValue::Object(JsObject::new()),
                scope,
            )?;
            chart.add_legacy_series_scoped(
                &object([
                    ("id", text("ema")),
                    ("type", text("line")),
                    ("panel", text("price")),
                    ("indicator", text("ema")),
                    ("color", text("#f0b755")),
                ]),
                scope,
            )?;
        } else if let Some(options) = options {
            if let Some(theme) = options.get(&key("theme"))
                && truthy(theme)
            {
                chart.set_theme_api(theme)?;
            }
            let series = match options.get(&key("series")) {
                None | Some(JsValue::Undefined | JsValue::Null) => &[][..],
                Some(JsValue::Array(series)) => series.as_slice(),
                Some(_) => return Err(type_error("Series options array required")),
            };
            for item in series {
                chart.add_series_api_scoped(item, scope)?;
            }
        }
        Ok(chart)
    }

    /// attached data state다.
    pub fn data(&self) -> &ModelDataState {
        self.ingestion.data()
    }

    /// attached data state의 배타적 빌림이다.
    pub fn data_mut(&mut self) -> &mut ModelDataState {
        self.ingestion.data_mut()
    }

    /// store와 queue를 함께 소유한 ingestion owner다.
    pub fn ingestion_owner(&self) -> &IngestionOwner {
        &self.ingestion
    }

    /// store와 queue를 함께 소유한 ingestion owner의 배타적 빌림이다.
    pub fn ingestion_owner_mut(&mut self) -> &mut IngestionOwner {
        &mut self.ingestion
    }

    /// 현재 model이다.
    pub fn model(&self) -> &ModelState {
        &self.model
    }

    /// 현재 model의 배타적 빌림이다.
    pub fn model_mut(&mut self) -> &mut ModelState {
        &mut self.model
    }

    /// Fixed-reply data staging이 immutable model identity와 mutable store candidate를 함께 빌린다.
    pub fn fixed_reply_data_parts(&mut self) -> (&ModelState, &mut BarStore) {
        (&self.model, self.ingestion.data_mut().store_mut())
    }

    /// 현재 indicator engine이다.
    pub fn indicators(&self) -> &IndicatorEngine {
        &self.indicators
    }

    /// 현재 indicator engine의 배타적 빌림이다.
    pub fn indicators_mut(&mut self) -> &mut IndicatorEngine {
        &mut self.indicators
    }

    /// 현재 drawing store다.
    pub fn drawings(&self) -> &DrawingStore {
        &self.drawings
    }

    /// 현재 drawing store의 배타적 빌림이다.
    pub fn drawings_mut(&mut self) -> &mut DrawingStore {
        &mut self.drawings
    }

    /// 차트별 series range caches다.
    pub fn series_caches(&self) -> &SeriesCaches {
        &self.series_caches
    }

    /// 차트별 series range caches의 배타적 빌림이다.
    pub fn series_caches_mut(&mut self) -> &mut SeriesCaches {
        &mut self.series_caches
    }

    /// 차트별 drawing geometry cache다.
    pub fn drawing_cache(&self) -> &DrawingGeometryCache {
        &self.drawing_cache
    }

    /// 차트별 drawing geometry cache의 배타적 빌림이다.
    pub fn drawing_cache_mut(&mut self) -> &mut DrawingGeometryCache {
        &mut self.drawing_cache
    }

    /// 현재 portable symbol이다.
    pub fn symbol(&self) -> Option<&Symbol> {
        self.symbol.as_ref()
    }

    /// inspect/workspace에 보존한 symbol record다.
    pub fn symbol_record(&self) -> Option<&JsValue> {
        self.symbol_record.as_ref()
    }

    /// 현재 nativeModel owner identity를 잡는다.
    pub fn capture_identity(&self) -> NativeChartIdentityToken {
        NativeChartIdentityToken {
            identity: Arc::clone(&self.identity),
        }
    }

    /// Capture 뒤에도 같은 nativeModel owner인지 본다.
    pub fn validate_identity(&self, token: &NativeChartIdentityToken) -> bool {
        Arc::ptr_eq(&self.identity, &token.identity)
    }

    /// 현재 symbol formatter pair가 설치됐는지 본다.
    pub fn symbol_formatters(&self) -> bool {
        self.symbol_formatters
    }

    /// 검증된 owner/모델/출력/cache/drawing을 O(1) publication 후보로 채택한다.
    pub fn from_parts(parts: NativeChartParts) -> Result<Self, JsError> {
        let memory = parts.ingestion.data().store().memory_context().clone();
        if !memory.shares_account(parts.symbol_memory.context()) {
            return Err(type_error("Native symbol memory context"));
        }
        let retained_memory = MemoryGroup::empty(memory.clone());
        Ok(Self {
            identity: Arc::new(()),
            ingestion: parts.ingestion,
            model: parts.model,
            indicators: parts.indicators,
            drawings: parts.drawings,
            series_caches: parts.series_caches,
            drawing_cache: DrawingGeometryCache::new_with_memory(
                RESOURCE_LIMITS.max_drawings as usize,
                memory,
            )?,
            symbol: parts.symbol,
            symbol_record: parts.symbol_record,
            symbol_formatters: parts.symbol_formatters,
            symbol_memory: parts.symbol_memory,
            formatter_identity: Arc::new(()),
            dialect: parts.dialect,
            retained_memory,
        })
    }

    /// 기존 owner 필드에 포함되지 않은 실제 retained payload의 lease를 이동한다.
    pub fn absorb_retained_memory(&mut self, memory: MemoryGroup) -> Result<(), JsError> {
        self.retained_memory
            .absorb(memory)
            .map_err(|error| error.into_js_error())
    }

    /// 현재 price/time formatter pair identity를 잡는다.
    pub fn capture_formatter_identity(&self) -> NativeFormatterIdentityToken {
        NativeFormatterIdentityToken {
            identity: Arc::clone(&self.formatter_identity),
        }
    }

    /// setSymbol 뒤 formatter pair가 교체되지 않았는지 본다.
    pub fn validate_formatter_identity(&self, token: &NativeFormatterIdentityToken) -> bool {
        Arc::ptr_eq(&self.formatter_identity, &token.identity)
    }

    /// 현재 수 방언이다.
    pub fn dialect(&self) -> NumberDialect {
        self.dialect
    }

    /// 검증이 끝난 symbol과 formatter identity를 reply admission 전 후보로 묶는다.
    pub(crate) fn prepare_symbol_publication(
        &self,
        symbol: Symbol,
        record: JsValue,
        memory: MemoryGroup,
    ) -> PreparedSymbolPublication {
        PreparedSymbolPublication {
            symbol,
            record,
            memory,
            formatter_identity: Arc::new(()),
        }
    }

    /// Prepared symbol 후보를 추가 allocation 없이 한 번에 게시한다.
    pub(crate) fn publish_symbol(&mut self, prepared: PreparedSymbolPublication) {
        self.model.precision = prepared.symbol.price_decimals as u8;
        self.symbol = Some(prepared.symbol);
        self.symbol_record = Some(prepared.record);
        self.symbol_formatters = true;
        self.formatter_identity = prepared.formatter_identity;
        self.symbol_memory = prepared.memory;
    }

    /// store/ingestion ledger commit 뒤 derived owner를 JS listener 순서로 무효화한다.
    pub fn commit_data_change<T>(&mut self, committed: Committed<T>) -> T {
        if let Some(change) = committed.change.as_ref() {
            self.publish_data_change(change);
        }
        committed.value
    }

    /// Fixed reply admission 전에 준비한 derived model publication으로 store commit을 마무리한다.
    pub fn commit_data_change_with_publication<T>(
        &mut self,
        committed: Committed<T>,
        prepared: Option<PreparedStoreChangePublication>,
    ) -> T {
        if let Some(change) = committed.change.as_ref() {
            self.indicators
                .apply_change(self.ingestion.data().store(), change);
            self.model.on_store_change_with_publication(
                self.ingestion.data().store(),
                change,
                prepared,
            );
        }
        committed.value
    }

    /// 이미 store/ledger가 게시한 변경을 indicator 다음 model 순서로 발행한다.
    pub fn publish_data_change(&mut self, change: &DataChange) {
        let store = self.ingestion.data().store();
        self.indicators.apply_change(store, change);
        self.model.on_store_change(store, change);
    }

    /// `nativeIndicatorBuffer`의 typed F64 copy seam이다.
    ///
    /// 지표 계산을 먼저 commit한 뒤 output/slice를 검사하므로 잘못된 slice가 실패해도 lazy
    /// 계산 효과는 남는다. 반환 borrow는 Root FFI가 같은 호출에서 복사하는 동안만 유효하다.
    pub fn indicator_buffer<'a>(
        &'a mut self,
        id: &JsValue,
        output: &JsValue,
        offset: f64,
        count: f64,
        host: &dyn Host,
    ) -> Result<&'a [f64], JsError> {
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut scope = memory.scope();
        self.indicator_buffer_scoped(id, output, offset, count, host, &mut scope)
    }

    /// caller scope에서 missing-id와 output coercion payload를 typed copy 완료까지 유지한다.
    #[allow(clippy::too_many_arguments)]
    pub fn indicator_buffer_scoped<'a>(
        &'a mut self,
        id: &JsValue,
        output: &JsValue,
        offset: f64,
        count: f64,
        host: &dyn Host,
        scope: &mut MemoryScope,
    ) -> Result<&'a [f64], JsError> {
        let read = self
            .indicators
            .get_scoped(self.ingestion.data().store(), host, id, scope)?;
        let output = crate::contracts::js_to_string_scoped(output, self.dialect, scope)?;
        let output_index = read.output_names().iter().position(|candidate| {
            output
                .as_units()
                .iter()
                .copied()
                .eq(candidate.encode_utf16())
        });
        let values = output_index.and_then(|index| read.output_at(index));
        let valid_integer = |value: f64| {
            value.is_finite()
                && value.fract() == 0.0
                && (0.0..=9_007_199_254_740_991.0).contains(&value)
        };
        if !valid_integer(offset)
            || !valid_integer(count)
            || count < 1.0
            || count > 262_144.0
            || values.is_none_or(|values| offset + count > values.len() as f64)
        {
            return Err(JsError::new("RangeError", key("Native indicator slice")));
        }
        let values = values.expect("validated output");
        Ok(&values[offset as usize..(offset + count) as usize])
    }

    /// legacy nativeSetData와 nativeFit이 현재 store에 view를 맞춘다.
    pub fn fit(&mut self) {
        self.model.fit(self.ingestion.data().store());
    }

    /// 실제 model/store/indicator와 차트별 range cache로 layout을 만든다.
    pub fn create_layout(
        &mut self,
        host: &dyn Host,
        width: f64,
        height: f64,
    ) -> Result<Layout, JsError> {
        create_layout_with_memory(
            &mut self.model,
            self.ingestion.data().store(),
            &mut self.indicators,
            host,
            &mut self.series_caches,
            width,
            height,
            self.ingestion.data().store().memory_context(),
        )
    }

    /// 실제 layout과 두 차트 cache를 소비해 renderer-neutral scene을 만든다.
    #[allow(clippy::too_many_arguments)]
    pub fn build_scene(
        &mut self,
        host: &dyn Host,
        width: f64,
        height: f64,
        resolved_crosshair: Option<&ResolvedCrosshair>,
        include_drawings: bool,
        include_crosshair: bool,
    ) -> Result<JsValue, JsError> {
        let layout = self.create_layout(host, width, height)?;
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut input_scope = memory.scope();
        let (mut indicator_ids, _ids_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        for series in &self.model.series {
            if series.visible
                && let Some(id) = &series.indicator
            {
                indicator_ids.push(
                    id.try_clone_scoped(&mut input_scope)
                        .map_err(|error| error.into_js_error())?,
                );
            }
        }
        for id in indicator_ids {
            self.indicators
                .get(self.ingestion.data().store(), host, &JsValue::String(id))?;
        }
        let store = self.ingestion.data().store();
        let (mut values, _values_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        for series in &self.model.series {
            values.push(series_values(series, store, &self.indicators)?);
        }
        let (mut ranges, _ranges_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        ranges.extend(self.model.series.iter().enumerate().map(|(index, series)| {
            if !series.visible
                || matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
                || scene_parts::aggregate_volume_series(series)
            {
                None
            } else {
                values[index].map(|values| CachedSeriesRange {
                    caches: &self.series_caches,
                    series_id: &series.id,
                    values,
                })
            }
        }));
        let (mut series, _series_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        series.extend(self.model.series.iter().enumerate().map(|(index, series)| {
            SeriesRenderInput {
                series,
                values: values[index],
                range: ranges[index]
                    .as_ref()
                    .map(|range| range as &dyn SeriesRangeView),
            }
        }));
        let theme = SceneTheme::from_model(&self.model)?;
        crate::scene::build_scene(SceneInput {
            model: &self.model,
            store,
            layout: &layout,
            series: &series,
            theme: &theme,
            symbol: self.symbol.as_ref().filter(|_| self.symbol_formatters),
            host,
            drawings: Some(&self.drawings),
            drawing_cache: &mut self.drawing_cache,
            resolved_crosshair,
            width,
            height,
            include_drawings,
            include_crosshair,
            dialect: self.dialect,
        })
    }

    /// Frame cache가 실제 layout과 drawing/crosshair 없는 base scene을 한 번에 만든다.
    pub fn build_frame_base(
        &mut self,
        host: &dyn Host,
        width: f64,
        height: f64,
    ) -> Result<(Layout, crate::scene::OwnedScene), JsError> {
        let layout = self.create_layout(host, width, height)?;
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut input_scope = memory.scope();
        let (mut indicator_ids, _ids_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        for series in &self.model.series {
            if series.visible
                && let Some(id) = &series.indicator
            {
                indicator_ids.push(
                    id.try_clone_scoped(&mut input_scope)
                        .map_err(|error| error.into_js_error())?,
                );
            }
        }
        for id in indicator_ids {
            self.indicators
                .get(self.ingestion.data().store(), host, &JsValue::String(id))?;
        }
        let store = self.ingestion.data().store();
        let (mut values, _values_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        for series in &self.model.series {
            values.push(series_values(series, store, &self.indicators)?);
        }
        let (mut ranges, _ranges_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        ranges.extend(self.model.series.iter().enumerate().map(|(index, series)| {
            if !series.visible
                || matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
                || scene_parts::aggregate_volume_series(series)
            {
                None
            } else {
                values[index].map(|values| CachedSeriesRange {
                    caches: &self.series_caches,
                    series_id: &series.id,
                    values,
                })
            }
        }));
        let (mut series, _series_memory) = memory
            .try_vec_capacity(self.model.series.len())
            .map_err(|error| error.into_js_error())?;
        series.extend(self.model.series.iter().enumerate().map(|(index, series)| {
            SeriesRenderInput {
                series,
                values: values[index],
                range: ranges[index]
                    .as_ref()
                    .map(|range| range as &dyn SeriesRangeView),
            }
        }));
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut theme_scope = memory.scope();
        let theme = SceneTheme::from_model_scoped(&self.model, &mut theme_scope)?;
        let scene = crate::scene::build_scene_with_memory(
            SceneInput {
                model: &self.model,
                store,
                layout: &layout,
                series: &series,
                theme: &theme,
                symbol: self.symbol.as_ref().filter(|_| self.symbol_formatters),
                host,
                drawings: None,
                drawing_cache: &mut self.drawing_cache,
                resolved_crosshair: None,
                width,
                height,
                include_drawings: false,
                include_crosshair: false,
                dialect: self.dialect,
            },
            &memory,
        )?;
        Ok((layout, scene))
    }

    /// Frame cache가 현재 drawing state를 이미 만든 layout에 투영한다.
    pub fn build_frame_drawings(
        &mut self,
        layout: &Layout,
    ) -> Result<crate::scene_parts::OwnedSceneCommands, JsError> {
        if self.ingestion.data().store().length() == 0 {
            return crate::scene_parts::OwnedSceneCommands::from_scoped(
                Vec::new(),
                &mut self.ingestion.data().store().memory_context().scope(),
            );
        }
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut theme_scope = memory.scope();
        let theme = SceneTheme::from_model_scoped(&self.model, &mut theme_scope)?;
        scene_parts::create_drawing_commands_with_memory(
            scene_parts::DrawingCommandInput {
                model: &self.model,
                store: self.ingestion.data().store(),
                drawings: &self.drawings,
                current_view: self.model.view,
                layout,
                cache: &mut self.drawing_cache,
                theme: &theme,
                dialect: self.dialect,
            },
            &memory,
        )
    }

    /// Frame cache가 이번 layout으로 resolve된 transient crosshair만 투영한다.
    pub fn build_frame_hover(
        &self,
        layout: &Layout,
        resolved: Option<&ResolvedCrosshair>,
    ) -> Result<crate::scene_parts::OwnedSceneCommands, JsError> {
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut theme_scope = memory.scope();
        let theme = SceneTheme::from_model_scoped(&self.model, &mut theme_scope)?;
        crate::scene::create_resolved_crosshair_commands_with_memory(
            layout,
            resolved,
            &theme,
            self.model.precision as u32,
            self.symbol.as_ref().filter(|_| self.symbol_formatters),
            self.dialect,
            &memory,
        )
    }

    /// API의 portable theme clone/merge 정책이다.
    pub fn set_theme_api(&mut self, patch: &JsValue) -> Result<(), JsError> {
        self.model.set_theme_api(patch)
    }

    /// legacy helper의 raw object-spread 정책이다.
    pub fn set_theme_legacy(&mut self, patch: &JsValue) -> Result<(), JsError> {
        self.model.set_theme_legacy(patch)
    }

    /// API series 정규화 뒤 실제 model에 추가한다.
    pub fn add_series_api(&mut self, options: &JsValue) -> Result<JsString, JsError> {
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut scope = memory.scope();
        self.add_series_api_scoped(options, &mut scope)
    }

    /// caller scope에서 portable metadata와 동적 오류 payload를 유지하며 API Series를 추가한다.
    pub fn add_series_api_scoped(
        &mut self,
        options: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        let snapshot = api_series_options_scoped(
            options,
            self.ingestion.data().store().memory_context(),
            scope,
        )?;
        self.add_series_scoped(snapshot.normalized, snapshot.values, scope)
    }

    /// legacy model-level addSeries 정책이다. 색상 문자열을 portable 변환하지 않는다.
    pub fn add_legacy_series(&mut self, options: &JsValue) -> Result<JsString, JsError> {
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut scope = memory.scope();
        self.add_legacy_series_scoped(options, &mut scope)
    }

    /// caller scope에서 raw legacy options와 동적 오류 payload를 유지하며 Series를 추가한다.
    pub fn add_legacy_series_scoped(
        &mut self,
        options: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        let options = options
            .try_clone_scoped(scope)
            .map_err(|error| error.into_js_error())?;
        self.add_series_scoped(options, None, scope)
    }

    /// 실제 indicator/drawing/controller snapshot으로 model leaf 하나를 호출한다.
    pub fn with_model_context<R>(
        &mut self,
        interaction: NativeInteractionContext<'_>,
        operation: impl FnOnce(&mut ModelState, &ModelContext<'_>) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let (mut projections, _projection_memory) = memory
            .try_vec_capacity(self.indicators.len())
            .map_err(|error| error.into_js_error())?;
        for id in self.indicators.entry_ids_iter() {
            let id = id
                .try_clone_scoped(&mut temporary)
                .map_err(|error| error.into_js_error())?;
            if let Some(entry) = self.indicators.entry(&JsValue::String(id)) {
                projections.push(IndicatorProjection {
                    id: entry.id(),
                    definition: entry.definition(),
                });
            }
        }
        let history = self
            .drawings
            .undo_stack()
            .iter()
            .chain(self.drawings.redo_stack());
        let panel_count = self
            .drawings
            .items()
            .len()
            .checked_add(history.clone().map(|frame| frame.len()).sum::<usize>())
            .ok_or_else(|| memory.allocation_failure().into_js_error())?;
        let axis_count = self
            .drawings
            .items()
            .iter()
            .chain(history.clone().flat_map(|frame| frame.iter()))
            .filter(|drawing| drawing.axis_id.is_some())
            .count()
            + self.drawings.transaction().map_or(0, |frame| {
                frame
                    .iter()
                    .filter(|drawing| drawing.axis_id.is_some())
                    .count()
            });
        let (mut panels, _panels_memory) = memory
            .try_vec_capacity(panel_count)
            .map_err(|error| error.into_js_error())?;
        let (mut axes, _axes_memory) = memory
            .try_vec_capacity(axis_count)
            .map_err(|error| error.into_js_error())?;
        let mut collect = |drawing: &crate::drawing_types::Drawing| -> Result<(), JsError> {
            panels.push(
                drawing
                    .panel
                    .try_clone_scoped(&mut temporary)
                    .map_err(|error| error.into_js_error())?,
            );
            if let Some(axis) = &drawing.axis_id {
                axes.push(
                    axis.try_clone_scoped(&mut temporary)
                        .map_err(|error| error.into_js_error())?,
                );
            }
            Ok(())
        };
        for drawing in self.drawings.items() {
            collect(drawing)?;
        }
        for frame in self
            .drawings
            .undo_stack()
            .iter()
            .chain(self.drawings.redo_stack())
        {
            for drawing in frame.iter() {
                collect(drawing)?;
            }
        }
        if let Some(frame) = self.drawings.transaction() {
            for drawing in frame.iter() {
                if let Some(axis) = &drawing.axis_id {
                    axes.push(
                        axis.try_clone_scoped(&mut temporary)
                            .map_err(|error| error.into_js_error())?,
                    );
                }
            }
        }
        let context = ModelContext {
            store: self.ingestion.data().store(),
            indicators: &projections,
            drawings: DrawingUsage {
                transaction_active: self.drawings.transaction().is_some(),
                panels: &panels,
                axes: &axes,
                controller_panel: interaction.target_panel,
                controller_axis: interaction.target_axis,
            },
            interaction: InteractionGuard {
                gesture_active: interaction.gesture_active,
                pointer_count: interaction.pointer_count,
            },
        };
        operation(&mut self.model, &context)
    }

    fn add_series_scoped(
        &mut self,
        options: JsValue,
        values: Option<(Vec<f64>, MemoryGroup)>,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        let memory = self.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let (mut projections, _projection_memory) = memory
            .try_vec_capacity(self.indicators.len())
            .map_err(|error| error.into_js_error())?;
        for id in self.indicators.entry_ids_iter() {
            let id = id
                .try_clone_scoped(&mut temporary)
                .map_err(|error| error.into_js_error())?;
            if let Some(entry) = self.indicators.entry(&JsValue::String(id)) {
                projections.push(IndicatorProjection {
                    id: entry.id(),
                    definition: entry.definition(),
                });
            }
        }
        let context = ModelContext {
            store: self.ingestion.data().store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        match values {
            Some((values, memory)) => self
                .model
                .add_series_with_owned_values_scoped(&options, values, memory, &context, scope),
            None => self.model.add_series_scoped(&options, &context, scope),
        }
    }
}

fn raw_source(series: &Series) -> &'static str {
    let raw = series.raw_record();
    match property_value(&raw, "source") {
        Some(JsValue::String(value)) if value == &key("time") => "time",
        Some(JsValue::String(value)) if value == &key("open") => "open",
        Some(JsValue::String(value)) if value == &key("high") => "high",
        Some(JsValue::String(value)) if value == &key("low") => "low",
        Some(JsValue::String(value)) if value == &key("volume") => "volume",
        _ => "close",
    }
}

fn property_value<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn series_values<'a>(
    series: &'a Series,
    store: &'a crate::data::BarStore,
    indicators: &'a IndicatorEngine,
) -> Result<Option<&'a [f64]>, JsError> {
    if !series.visible {
        return Ok(None);
    }
    if let Some(values) = series.values.as_deref() {
        return Ok(Some(values));
    }
    if let Some(indicator) = &series.indicator {
        let entry = indicators
            .entry(&JsValue::String(indicator.clone()))
            .ok_or_else(|| JsError::new("Error", key("Missing indicator")))?;
        let output = series
            .output
            .as_ref()
            .map(JsString::to_string_lossy)
            .unwrap_or_else(|| entry.definition().outputs[0].to_owned());
        let values = entry
            .output_capacity(&output)
            .ok_or_else(|| JsError::new("Error", key("Missing indicator output")))?;
        return Ok(Some(&values[..store.length()]));
    }
    let columns = store.columns();
    Ok(Some(match raw_source(series) {
        "time" => &columns.time[..store.length()],
        "open" => &columns.open[..store.length()],
        "high" => &columns.high[..store.length()],
        "low" => &columns.low[..store.length()],
        "volume" => &columns.volume[..store.length()],
        _ => &columns.close[..store.length()],
    }))
}
