//! ChartModel의 순수 configuration/view/panel/axis/series 상태와 검증 계약이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use std::collections::HashSet;
use std::mem::size_of;
use std::sync::Arc;

use barochart_js::memory::{MemoryContext, MemoryFailure, MemoryGroup, MemoryScope};
use barochart_js::num::{NumberDialect, js_max, js_min, same_value};
use barochart_js::string::JsString;

use crate::coercion::{js_add_number_scoped, js_to_number_scoped};
use crate::contracts::{
    AXIS_KEYS, PANEL_KEYS, RESOURCE_LIMITS, SERIES_KEYS, THEME_KEYS, bounded_text, identifier,
    js_to_string_scoped, option_record, ordered_record, portable_style_scoped,
};
use crate::data::{BarStore, ChangeKind, DataChange};
use crate::indicator_types::IndicatorDefinition;

const DEFAULT_THEME: [(&str, &str); 7] = [
    ("background", "#0c1320"),
    ("grid", "#1d2a3a"),
    ("text", "#8093ad"),
    ("up", "#35d2ab"),
    ("down", "#fa6c7c"),
    ("crosshair", "#b9c9de"),
    ("font", "12px monospace"),
];
const FRAME_THEME_REFERENCE_KEYS: [&str; 6] = ["background", "grid", "text", "up", "down", "font"];

/// 호출 시점의 실제 indicator definition projection이다.
#[derive(Clone, Copy)]
pub struct IndicatorProjection<'a> {
    /// entry id다.
    pub id: &'a JsString,
    /// 실제 immutable definition이다.
    pub definition: &'a IndicatorDefinition,
}

/// 현재 drawing/history/transaction이 참조하는 model binding이다.
#[derive(Clone, Copy, Default)]
pub struct DrawingUsage<'a> {
    /// active transaction 여부다.
    pub transaction_active: bool,
    /// current/undo/redo가 참조하는 panel id다.
    pub panels: &'a [JsString],
    /// current/undo/redo/transaction이 참조하는 axis id다.
    pub axes: &'a [JsString],
    /// 현재 controller target이 참조하는 panel id다.
    pub controller_panel: Option<&'a JsString>,
    /// 현재 controller target이 참조하는 axis id다.
    pub controller_axis: Option<&'a JsString>,
}

/// 실제 InteractionController에서 추출한 mutation guard다.
#[derive(Clone, Copy, Debug, Default)]
pub struct InteractionGuard {
    /// gesture가 있는지 여부다.
    pub gesture_active: bool,
    /// active pointer 수다.
    pub pointer_count: usize,
}

/// 모델 호출이 빌리는 실제 외부 상태다. 어떤 borrow도 모델에 저장하지 않는다.
#[derive(Clone, Copy)]
pub struct ModelContext<'a> {
    /// 실제 현재 store다.
    pub store: &'a BarStore,
    /// 실제 indicator entry projection들이다.
    pub indicators: &'a [IndicatorProjection<'a>],
    /// 실제 drawing usage다.
    pub drawings: DrawingUsage<'a>,
    /// 실제 interaction guard다.
    pub interaction: InteractionGuard,
}

impl<'a> ModelContext<'a> {
    /// 외부 binding이 없는 기본 context다.
    pub fn plain(store: &'a BarStore) -> Self {
        Self {
            store,
            indicators: &[],
            drawings: DrawingUsage::default(),
            interaction: InteractionGuard::default(),
        }
    }

    fn indicator(&self, id: &JsString) -> Option<&'a IndicatorDefinition> {
        self.indicators
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.definition)
    }
}

/// model visible range다.
#[derive(Clone, Copy, Debug)]
pub struct VisibleRange {
    /// 왼쪽 fractional index다.
    pub from: f64,
    /// 오른쪽 fractional index다.
    pub to: f64,
}

/// 검증과 파생 계산을 끝내고 아직 게시하지 않은 view 교체 후보다.
///
/// 새 object identity까지 후보가 소유하므로 reply admission 뒤의 publication은 할당하지 않는다.
pub struct PreparedView {
    view: VisibleRange,
    follow: bool,
    identity: Arc<()>,
}

/// Store reset의 derived view publication에 필요한 identity를 reply admission 전에 보유한다.
pub struct PreparedStoreChangePublication {
    reset_view_identity: Arc<()>,
}

/// 검증·정규화한 panel record다.
#[derive(Clone, Debug)]
pub struct Panel {
    record: JsValue,
    /// id다.
    pub id: JsString,
    /// layout weight다.
    pub weight: f64,
    /// scale 이름이다.
    pub scale: JsString,
    /// 반전 여부다.
    pub inverted: bool,
    /// padding이다.
    pub padding: f64,
    /// axis strip 표시 여부다.
    pub axis_visible: bool,
    /// axis strip 방향이다.
    pub axis_side: JsString,
}

impl Panel {
    /// source key order의 record 복사본이다.
    pub fn to_js_value(&self) -> JsValue {
        self.record.clone()
    }

    /// source key order record를 scoped fallible allocation으로 복제한다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, MemoryFailure> {
        self.record.try_clone_scoped(scope)
    }

    /// Core 내부 scoped projection이 source key order record를 allocation 없이 빌린다.
    pub(crate) fn raw_record(&self) -> &JsValue {
        &self.record
    }
}

/// 검증·정규화한 independent axis record다.
#[derive(Clone, Debug)]
pub struct Axis {
    record: JsValue,
    /// id다.
    pub id: JsString,
    /// 소속 panel id다.
    pub panel: JsString,
    /// 좌우 side다.
    pub side: JsString,
    /// 표시 여부다.
    pub visible: bool,
    /// strip width다.
    pub width: Option<f64>,
}

impl Axis {
    /// source key order의 record 복사본이다.
    pub fn to_js_value(&self) -> JsValue {
        self.record.clone()
    }

    /// source key order record를 scoped fallible allocation으로 복제한다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, MemoryFailure> {
        self.record.try_clone_scoped(scope)
    }

    /// Core 내부 scoped projection이 source key order record를 allocation 없이 빌린다.
    pub(crate) fn raw_record(&self) -> &JsValue {
        &self.record
    }
}

/// renderer series 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeriesKind {
    /// Candles.
    Candles,
    /// OHLC.
    Ohlc,
    /// Line.
    Line,
    /// Area.
    Area,
    /// Histogram.
    Histogram,
}

/// 검증·정규화한 series와 계산 cache metadata다.
#[derive(Debug)]
pub struct Series {
    record: JsValue,
    /// id다.
    pub id: JsString,
    /// panel id다.
    pub panel: JsString,
    /// optional axis id다.
    pub axis_id: Option<JsString>,
    /// series 종류다.
    pub kind: SeriesKind,
    /// optional indicator id다.
    pub indicator: Option<JsString>,
    /// optional named output이다.
    pub output: Option<JsString>,
    /// plot offset f64다.
    pub offset: f64,
    /// visible false 여부를 포함한 표시 상태다.
    pub visible: bool,
    /// 외부 aligned values 소유 복사다.
    pub values: Option<Vec<f64>>,
    /// 이 Series의 외부 값 교체 revision이다.
    pub values_revision: Option<f64>,
    /// range cache를 다시 만들 첫 index다.
    pub dirty_from: f64,
    /// 계산 revision cache다.
    pub revision: Option<f64>,
    /// range index가 설치됐는지 나타내는 metadata다.
    pub range_index_ready: bool,
    metadata_memory: MemoryGroup,
    values_memory: MemoryGroup,
}

impl Series {
    /// 값 배열을 포함하지 않는 원본 metadata를 할당 없이 빌린다.
    pub(crate) fn raw_record_ref(&self) -> &JsValue {
        &self.record
    }

    /// runtime cache와 borrowed external values를 제외한 source key order record다.
    pub fn to_js_value(&self) -> JsValue {
        self.raw_record_without_values()
    }

    /// External values를 물질화하지 않고 portable record를 scoped fallible allocation으로 복제한다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, MemoryFailure> {
        let mut value = self.record.try_clone_scoped(scope)?;
        if let JsValue::Object(record) = &mut value {
            let values_key = JsString::try_from_str("values", scope)?;
            record.remove(&values_key);
        }
        Ok(value)
    }

    /// Root runtime이 typed attachment identity를 연결할 때 쓰는 내부 record 복사다.
    pub fn raw_record(&self) -> JsValue {
        self.record.clone()
    }

    /// 큰 external values 배열을 복제하지 않는 metadata-only record다.
    pub fn raw_record_without_values(&self) -> JsValue {
        let JsValue::Object(record) = &self.record else {
            return self.record.clone();
        };
        let values_key = JsString::from_str("values");
        let mut output = JsObject::new();
        for (name, value) in record.iter() {
            if name != &values_key {
                output.insert(name.clone(), value.clone());
            }
        }
        JsValue::Object(output)
    }

    /// setSeries cache 판정이 큰 record를 복제하지 않고 source scalar를 읽는 seam이다.
    pub fn source_value(&self) -> Option<&JsValue> {
        let JsValue::Object(record) = &self.record else {
            return None;
        };
        record.get(&JsString::from_str("source"))
    }

    /// 이 series metadata record와 공개 scalar 복사본의 requested bytes다.
    pub fn metadata_accounted_bytes(&self) -> u64 {
        self.metadata_memory.requested_bytes()
    }

    /// 외부 values `Vec`의 실제 capacity에 대응하는 requested bytes다.
    pub fn values_accounted_bytes(&self) -> u64 {
        self.values_memory.requested_bytes()
    }

    /// Metadata-only replacement 후보가 기존 values와 lease를 복제 없이 이동해 받는다.
    pub fn transfer_values_from(&mut self, source: &mut Self) {
        debug_assert!(self.values.is_none());
        debug_assert_eq!(self.values_memory.requested_bytes(), 0);
        debug_assert!(
            self.values_memory
                .context()
                .shares_account(source.values_memory.context())
        );
        self.values = source.values.take();
        let empty = MemoryGroup::empty(source.values_memory.context().clone());
        self.values_memory = std::mem::replace(&mut source.values_memory, empty);
    }
}

/// Panel 제거 뒤 Root controller가 처리할 instruction이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanelRemoval {
    /// drawing target이 이 panel을 가리키면 지워야 한다.
    pub clear_controller_target: bool,
}

/// Axis 제거 뒤 Root controller가 처리할 instruction이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AxisRemoval {
    /// drawing target이 이 axis를 가리키면 지워야 한다.
    pub clear_controller_target: bool,
}

/// Indicator placement 결과다.
#[derive(Clone, Debug)]
pub struct PlacementReceipt {
    /// 변경한 bound series 수다.
    pub changed: usize,
    /// 대상 panel이다.
    pub panel: JsString,
    /// 대상 axis다.
    pub axis_id: Option<JsString>,
    /// source series 순서의 모든 bound id다.
    pub bound_ids: Vec<JsString>,
}

/// ChartModel이 직접 소유하는 순수 상태다.
#[derive(Debug)]
pub struct ModelState {
    identity: Arc<()>,
    containers_identity: Arc<()>,
    theme_identity: Arc<()>,
    view_identity: Arc<()>,
    values_reference_identity: Arc<()>,
    theme_value_identities: [Option<Arc<()>>; FRAME_THEME_REFERENCE_KEYS.len()],
    theme: JsValue,
    /// panel painter 순서다.
    pub panels: Vec<Panel>,
    /// independent axes다.
    pub axes: Vec<Axis>,
    /// series painter 순서다.
    pub series: Vec<Series>,
    /// 현재 visible range다.
    pub view: VisibleRange,
    /// live-follow 여부다.
    pub follow: bool,
    /// 기본 axis width다.
    pub axis_width: f64,
    /// 기본 가격 precision이다.
    pub precision: u8,
    series_values_revision: Option<f64>,
    topology_memory: MemoryGroup,
    panels_memory: MemoryGroup,
    axes_memory: MemoryGroup,
    series_memory: MemoryGroup,
}

/// Study 게시 전에 확보하는 추가 series container 후보다.
pub(crate) struct PreparedSeriesAppend {
    series: Vec<Series>,
    memory: MemoryGroup,
    previous_length: usize,
    additional: usize,
}

/// Series 교체/제거 publication이 사용할 preallocated identity들이다.
pub struct PreparedSeriesPublication {
    containers_identity: Arc<()>,
    values_reference_identity: Option<Arc<()>>,
}

#[derive(Clone)]
struct WorkspaceSeriesScalar {
    revision: Option<u64>,
    dirty_from: u64,
}

/// Workspace source가 JS `sourceRefs`의 model object/container/scalar identity를 보존하는 token이다.
pub struct ModelWorkspaceCaptureToken {
    identity: Arc<()>,
    containers_identity: Arc<()>,
    theme_identity: Arc<()>,
    view_identity: Arc<()>,
    axis_width: u64,
    precision: u8,
    view_from: u64,
    view_to: u64,
    follow: bool,
    series: Vec<WorkspaceSeriesScalar>,
}

/// Frame static-state가 external values object identity만 비교하는 opaque token이다.
#[derive(Clone)]
pub struct SeriesValuesReferenceToken {
    identity: Arc<()>,
}

/// Frame base가 raw legacy theme object/array의 Object.is identity를 비교하는 token이다.
pub struct ThemeValueReferenceToken {
    key_index: usize,
    identity: Arc<()>,
}

/// Detached async UI validation이 만든 callback-free model publication 후보다.
pub(crate) struct NativeUiModelStage {
    model: ModelState,
    drawing_target: Option<JsValue>,
}

impl NativeUiModelStage {
    pub(crate) fn drawing_target(&self) -> Option<&JsValue> {
        self.drawing_target.as_ref()
    }

    pub(crate) fn validate_drawing_binding(&self, drawing: &JsValue) -> Result<bool, JsError> {
        self.model.validate_drawing_binding(drawing, true)
    }
}

impl ModelState {
    /// 실제 store 길이와 constructor options로 model state를 만든다.
    pub fn new(store: &BarStore, options: &JsValue) -> Result<Self, JsError> {
        let object = model_options(options)?;
        let panels = defaulted_property(&object, "panels", default_panels);
        let axes = defaulted_property(&object, "axes", empty_array);
        let visible_bars = default_number(property(&object, "visibleBars"), 200.0);
        let axis_width = default_number(property(&object, "axisWidth"), 82.0);
        let precision = default_number(property(&object, "precision"), 2.0);
        let panel_count = match &panels {
            JsValue::Array(values) => values.len(),
            _ => 0,
        };
        if panel_count == 0
            || !axis_width.is_finite()
            || axis_width < 20.0
            || !visible_bars.is_finite()
            || visible_bars < 1.0
            || !precision.is_finite()
            || precision.fract() != 0.0
            || !(0.0..=18.0).contains(&precision)
        {
            return Err(range_error("Panels, width, visible bars or precision"));
        }
        let theme_input = defaulted_property(&object, "theme", empty_object);
        let theme = theme(&theme_input)?;
        let theme_value_identities = theme_value_reference_identities(&theme);
        let memory = store.memory_context().clone();
        let topology_memory = memory
            .reserve_group(js_value_heap_bytes(&theme))
            .map_err(|failure| failure.into_js_error())?;
        let mut model = Self {
            identity: Arc::new(()),
            containers_identity: Arc::new(()),
            theme_identity: Arc::new(()),
            view_identity: Arc::new(()),
            values_reference_identity: Arc::new(()),
            theme_value_identities,
            theme,
            panels: Vec::new(),
            axes: Vec::new(),
            series: Vec::new(),
            axis_width,
            precision: precision as u8,
            view: VisibleRange {
                from: js_max(&[-0.5, store.length() as f64 - visible_bars - 0.5]),
                to: js_max(&[visible_bars - 0.5, store.length() as f64 - 0.5]),
            },
            follow: true,
            series_values_revision: None,
            topology_memory,
            panels_memory: MemoryGroup::empty(memory.clone()),
            axes_memory: MemoryGroup::empty(memory.clone()),
            series_memory: MemoryGroup::empty(memory),
        };
        let JsValue::Array(panels) = &panels else {
            return Err(range_error("Panels, width, visible bars or precision"));
        };
        let context = ModelContext::plain(store);
        for panel in panels {
            model.add_panel(panel, &context)?;
        }
        let JsValue::Array(axes) = &axes else {
            return Err(type_error("Axes array required"));
        };
        for axis in axes {
            model.add_axis(axis, &context)?;
        }
        Ok(model)
    }

    /// Store에서 상속한 엔진별 memory context다.
    pub fn memory_context(&self) -> &MemoryContext {
        self.topology_memory.context()
    }

    /// Model topology, record, external values가 현재 보유한 requested bytes다.
    pub fn accounted_bytes(&self) -> u64 {
        self.topology_memory
            .requested_bytes()
            .saturating_add(self.panels_memory.requested_bytes())
            .saturating_add(self.axes_memory.requested_bytes())
            .saturating_add(self.series_memory.requested_bytes())
            .saturating_add(
                self.series
                    .iter()
                    .map(|series| {
                        series
                            .metadata_accounted_bytes()
                            .saturating_add(series.values_accounted_bytes())
                    })
                    .sum::<u64>(),
            )
    }

    /// 모든 외부 series values의 실제 capacity requested bytes 합이다.
    pub fn external_values_accounted_bytes(&self) -> u64 {
        self.series.iter().map(Series::values_accounted_bytes).sum()
    }

    /// arbitrary legacy theme를 ordered JsValue로 복사한다.
    pub fn theme(&self) -> &JsValue {
        &self.theme
    }

    /// Workspace source가 model/config identity와 sourceRefs scalar를 고정한다.
    pub fn capture_workspace_state(&self) -> ModelWorkspaceCaptureToken {
        ModelWorkspaceCaptureToken {
            identity: Arc::clone(&self.identity),
            containers_identity: Arc::clone(&self.containers_identity),
            theme_identity: Arc::clone(&self.theme_identity),
            view_identity: Arc::clone(&self.view_identity),
            axis_width: self.axis_width.to_bits(),
            precision: self.precision,
            view_from: self.view.from.to_bits(),
            view_to: self.view.to.to_bits(),
            follow: self.follow,
            series: self
                .series
                .iter()
                .map(|series| WorkspaceSeriesScalar {
                    revision: series.revision.map(f64::to_bits),
                    dirty_from: series.dirty_from.to_bits(),
                })
                .collect(),
        }
    }

    /// Capture 뒤 object/container 교체와 sourceRefs scalar가 그대로인지 본다.
    pub fn validate_workspace_state(&self, token: &ModelWorkspaceCaptureToken) -> bool {
        Arc::ptr_eq(&self.identity, &token.identity)
            && Arc::ptr_eq(&self.containers_identity, &token.containers_identity)
            && Arc::ptr_eq(&self.theme_identity, &token.theme_identity)
            && Arc::ptr_eq(&self.view_identity, &token.view_identity)
            && self.axis_width.to_bits() == token.axis_width
            && self.precision == token.precision
            && self.view.from.to_bits() == token.view_from
            && self.view.to.to_bits() == token.view_to
            && self.follow == token.follow
            && self.series.len() == token.series.len()
            && self
                .series
                .iter()
                .zip(&token.series)
                .all(|(series, expected)| {
                    series.revision.map(f64::to_bits) == expected.revision
                        && series.dirty_from.to_bits() == expected.dirty_from
                })
    }

    /// Root ChartAPI가 검증한 replacement candidate를 같은 slot에 게시한다.
    pub fn publish_series_replacement(&mut self, index: usize, series: Series) {
        let prepared = self.prepare_series_publication(false);
        self.publish_prepared_series_replacement(index, series, prepared);
    }

    /// Reply admission 전 series container/reference identity를 준비한다.
    pub fn prepare_series_publication(&self, replaces_values: bool) -> PreparedSeriesPublication {
        PreparedSeriesPublication {
            containers_identity: Arc::new(()),
            values_reference_identity: replaces_values.then(|| Arc::new(())),
        }
    }

    /// Prepared identity와 series 후보를 추가 allocation 없이 게시한다.
    pub fn publish_prepared_series_replacement(
        &mut self,
        index: usize,
        series: Series,
        prepared: PreparedSeriesPublication,
    ) {
        self.series[index] = series;
        self.containers_identity = prepared.containers_identity;
        if let Some(identity) = prepared.values_reference_identity {
            self.values_reference_identity = identity;
        }
    }

    /// Prepared identity로 id가 같은 Series를 allocation 없이 제거한다.
    pub fn publish_prepared_series_removal(
        &mut self,
        id: &JsValue,
        prepared: PreparedSeriesPublication,
    ) {
        if let Some(id) = string_value(id) {
            self.series.retain(|series| series.id != *id);
        }
        self.containers_identity = prepared.containers_identity;
    }

    /// Prepared identity로 indicator에 결합된 모든 Series를 allocation 없이 제거한다.
    pub fn publish_prepared_indicator_series_removal(
        &mut self,
        id: &JsValue,
        prepared: PreparedSeriesPublication,
    ) {
        self.series.retain(|series| {
            series
                .indicator
                .as_ref()
                .is_none_or(|bound| !matches!(id, JsValue::String(id) if bound == id))
        });
        self.containers_identity = prepared.containers_identity;
    }

    /// Frame build가 external values object identity를 고정한다.
    pub fn capture_series_values_reference(&self) -> SeriesValuesReferenceToken {
        SeriesValuesReferenceToken {
            identity: Arc::clone(&self.values_reference_identity),
        }
    }

    /// External values typed-array reference가 capture 뒤 교체되지 않았는지 본다.
    pub fn validate_series_values_reference(&self, token: &SeriesValuesReferenceToken) -> bool {
        Arc::ptr_eq(&self.values_reference_identity, &token.identity)
    }

    /// Root setSeries가 새 values attachment를 게시한 경우에만 호출한다.
    pub fn mark_series_values_replaced(&mut self) {
        self.values_reference_identity = Arc::new(());
    }

    /// Engine publish/owner guard 전에 새 container capacity를 확보한다.
    pub(crate) fn prepare_series_append(
        &self,
        additional: usize,
    ) -> Result<Option<PreparedSeriesAppend>, JsError> {
        if additional == 0 {
            return Ok(None);
        }
        let length = self
            .series
            .len()
            .checked_add(additional)
            .ok_or_else(|| range_error("Series limit"))?;
        if length > RESOURCE_LIMITS.max_series as usize {
            return Err(range_error("Series limit"));
        }
        let (series, memory) = self
            .memory_context()
            .try_vec_capacity(length)
            .map_err(|error| error.into_js_error())?;
        Ok(Some(PreparedSeriesAppend {
            series,
            memory,
            previous_length: self.series.len(),
            additional,
        }))
    }

    /// 검증이 끝난 추가 series와 기존 값을 재할당 없이 한 번에 이동한다.
    pub(crate) fn publish_series_append(
        &mut self,
        mut prepared: PreparedSeriesAppend,
        additions: Vec<Series>,
    ) {
        assert_eq!(
            self.series.len(),
            prepared.previous_length,
            "prepared series owner changed"
        );
        assert_eq!(
            additions.len(),
            prepared.additional,
            "prepared series count"
        );
        prepared.series.append(&mut self.series);
        prepared.series.extend(additions);
        self.series = prepared.series;
        self.series_memory = prepared.memory;
        self.rotate_containers_identity();
    }

    /// Frame base 대상 theme property가 object/array일 때만 Object.is token을 만든다.
    pub fn capture_theme_value_reference(&self, key: &str) -> Option<ThemeValueReferenceToken> {
        let key_index = FRAME_THEME_REFERENCE_KEYS
            .iter()
            .position(|candidate| *candidate == key)?;
        Some(ThemeValueReferenceToken {
            key_index,
            identity: Arc::clone(self.theme_value_identities[key_index].as_ref()?),
        })
    }

    /// 같은 key가 여전히 같은 raw object/array를 가리키는지 본다.
    pub fn validate_theme_value_reference(
        &self,
        key: &str,
        token: &ThemeValueReferenceToken,
    ) -> bool {
        FRAME_THEME_REFERENCE_KEYS.get(token.key_index) == Some(&key)
            && self.theme_value_identities[token.key_index]
                .as_ref()
                .is_some_and(|identity| Arc::ptr_eq(identity, &token.identity))
    }

    /// Workspace/interaction/compaction이 새 view object를 게시하는 공통 hook이다.
    pub fn publish_view_replacement(&mut self, view: VisibleRange, follow: bool) {
        self.view = view;
        self.follow = follow;
        self.view_identity = Arc::new(());
    }

    /// Reply admission 전에 완성한 view 후보를 추가 할당 없이 게시한다.
    pub fn publish_prepared_view(&mut self, prepared: PreparedView) {
        self.view = prepared.view;
        self.follow = prepared.follow;
        self.view_identity = prepared.identity;
    }

    /// 고정 reply data mutation이 store publication 전에 derived reset view identity를 준비한다.
    pub fn prepare_store_change_publication(&self) -> PreparedStoreChangePublication {
        PreparedStoreChangePublication {
            reset_view_identity: Arc::new(()),
        }
    }

    /// Async UI topology/presentation을 detached 후보로 전부 검증한다.
    /// External values와 계산/cache metadata는 복사하지 않고 live series에 남긴다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn stage_native_ui(
        &self,
        store: &BarStore,
        panels: &JsValue,
        axes: &JsValue,
        theme: &JsValue,
        series_patches: &[JsValue],
        view: VisibleRange,
        follow: bool,
        axis_width: f64,
        precision: u8,
        drawing_target: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<NativeUiModelStage, JsError> {
        let mut options = JsObject::new();
        options.insert(JsString::from_str("panels"), panels.clone());
        options.insert(JsString::from_str("axes"), axes.clone());
        options.insert(JsString::from_str("theme"), theme.clone());
        options.insert(JsString::from_str("axisWidth"), JsValue::Number(axis_width));
        options.insert(
            JsString::from_str("precision"),
            JsValue::Number(f64::from(precision)),
        );
        options.insert(
            JsString::from_str("visibleBars"),
            JsValue::Number(js_max(&[view.to - view.from, 1.0])),
        );
        let candidate = ModelState::new(store, &JsValue::Object(options))?;
        if series_patches.len() != self.series.len() {
            return Err(type_error("Async UI collections"));
        }
        let (mut seen, _seen_memory) = candidate
            .memory_context()
            .try_vec_capacity(series_patches.len())
            .map_err(|failure| failure.into_js_error())?;
        let (mut series, series_memory) = candidate
            .memory_context()
            .try_vec_capacity(series_patches.len())
            .map_err(|failure| failure.into_js_error())?;
        for patch in series_patches {
            option_record(
                patch,
                &SERIES_KEYS
                    .iter()
                    .copied()
                    .filter(|key| !matches!(*key, "values" | "indicator" | "output" | "source"))
                    .collect::<Vec<_>>(),
                "Async series patch",
            )?;
            let patch_record = object_ref(patch, "Series: object required")?;
            let id = identifier_field(patch_record, "id", "Series id")?;
            let current = self
                .series
                .iter()
                .find(|series| series.id == id)
                .ok_or_else(|| error("Async stale: series binding"))?;
            if seen.iter().any(|seen: &JsString| seen == &id) {
                return Err(error("Async stale: series binding"));
            }
            let kind = property_or_undefined(patch_record, "type");
            let panel = property_or_undefined(patch_record, "panel");
            let current_record = current.raw_record();
            let JsValue::Object(current_record_object) = &current_record else {
                unreachable!("series record")
            };
            if !same_js_value(kind, property_or_undefined(current_record_object, "type"))
                || !same_js_value(panel, property_or_undefined(current_record_object, "panel"))
            {
                return Err(error("Async stale: series binding"));
            }
            let merged = merged_record(&current_record, patch, SERIES_KEYS)?;
            let normalized = normalize_series_inner(
                &merged,
                None,
                None,
                current.values.is_some(),
                &candidate,
                context,
                None,
            )?;
            seen.push(id);
            series.push(normalized);
        }
        // Source는 입력 patch를 id Map에 모은 뒤 live painter 순서로 다시 조립한다.
        // 검증은 위에서 입력 순서대로 끝내고, allocation 없는 정렬만 게시 후보에 적용한다.
        series.sort_unstable_by_key(|next| {
            self.series
                .iter()
                .position(|current| current.id == next.id)
                .expect("validated async patch references a live series")
        });
        let mut candidate = candidate;
        candidate.series = series;
        candidate.series_memory = series_memory;
        let drawing_target = if matches!(drawing_target, JsValue::Null | JsValue::Undefined) {
            None
        } else {
            option_record(
                drawing_target,
                &["panel", "axisId", "seriesId"],
                "Async drawing target",
            )?;
            let target = ordered_record(drawing_target, &["panel", "axisId", "seriesId"])?;
            candidate.validate_drawing_binding(&target, true)?;
            let target_record = object_ref(&target, "Drawing binding object required")?;
            let panel = string_value(property_or_undefined(target_record, "panel"));
            let series_id = optional_string(property_or_undefined(target_record, "seriesId"));
            let axis_id = optional_string(property_or_undefined(target_record, "axisId"));
            let linked =
                series_id.and_then(|id| candidate.series.iter().find(|series| &series.id == id));
            if series_id.is_some()
                && linked.is_none_or(|series| {
                    Some(&series.panel) != panel || series.axis_id.as_ref() != axis_id
                })
            {
                None
            } else {
                candidate.validate_drawing_binding(&target, false)?;
                Some(target)
            }
        };
        candidate.publish_view_replacement(view, follow);
        Ok(NativeUiModelStage {
            model: candidate,
            drawing_target,
        })
    }

    /// 검증된 UI 후보를 실패 없는 구간에서 게시하고 source identity hooks를 회전한다.
    pub(crate) fn publish_native_ui(&mut self, stage: NativeUiModelStage) {
        let mut staged = stage.model;
        debug_assert_eq!(self.series.len(), staged.series.len());
        for (current, next) in self.series.iter_mut().zip(staged.series.drain(..)) {
            current.record = next.record;
            current.id = next.id;
            current.panel = next.panel;
            current.axis_id = next.axis_id;
            current.kind = next.kind;
            current.indicator = next.indicator;
            current.output = next.output;
            current.offset = next.offset;
            current.visible = next.visible;
            current.metadata_memory = next.metadata_memory;
        }
        self.panels = staged.panels;
        self.panels_memory = staged.panels_memory;
        self.axes = staged.axes;
        self.axes_memory = staged.axes_memory;
        self.theme = staged.theme;
        self.topology_memory = staged.topology_memory;
        self.axis_width = staged.axis_width;
        self.precision = staged.precision;
        self.rotate_containers_identity();
        self.theme_identity = Arc::new(());
        self.theme_value_identities = theme_value_reference_identities(&self.theme);
        self.publish_view_replacement(staged.view, staged.follow);
    }

    fn rotate_containers_identity(&mut self) {
        self.containers_identity = Arc::new(());
    }

    fn prepare_theme_value_references(
        &self,
        patch: &JsValue,
    ) -> [Option<Arc<()>>; FRAME_THEME_REFERENCE_KEYS.len()] {
        let mut identities = self.theme_value_identities.clone();
        let JsValue::Object(patch) = patch else {
            return identities;
        };
        for (index, key) in FRAME_THEME_REFERENCE_KEYS.iter().enumerate() {
            if let Some(value) = patch.get(&JsString::from_str(key)) {
                identities[index] =
                    matches!(value, JsValue::Object(_) | JsValue::Array(_)).then(|| Arc::new(()));
            }
        }
        identities
    }

    /// ChartAPI.setTheme의 portable style snapshot을 검증 뒤 원자 merge한다.
    pub fn set_theme_api(&mut self, patch: &JsValue) -> Result<(), JsError> {
        self.set_theme_api_with_admission(patch, &mut || Ok(()))
    }

    /// Portable theme 후보와 reference identity를 완성한 뒤 reply admission 직후 게시한다.
    pub fn set_theme_api_with_admission(
        &mut self,
        patch: &JsValue,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        option_record(patch, THEME_KEYS, "Theme")?;
        let mut scope = self.memory_context().scope();
        let normalized = portable_style_scoped(
            patch,
            &["background", "grid", "text", "up", "down", "crosshair"],
            false,
            &mut scope,
        )?;
        let theme = merged_theme_record_scoped(&self.theme, &normalized, &mut scope)?;
        let old_theme_bytes = js_value_heap_bytes(&self.theme);
        let candidate_theme_bytes = js_value_heap_bytes(&theme);
        let candidate_memory = scope
            .split_persistent(candidate_theme_bytes)
            .map_err(|failure| failure.into_js_error())?;
        let theme_value_identities = self.prepare_theme_value_references(&normalized);
        let theme_identity = Arc::new(());
        before_publish()?;
        let old_theme_memory = self
            .topology_memory
            .split(old_theme_bytes)
            .expect("theme bytes are part of model topology");
        self.topology_memory
            .absorb(candidate_memory)
            .expect("candidate theme uses the model account");
        self.theme = theme;
        self.theme_value_identities = theme_value_identities;
        self.theme_identity = theme_identity;
        drop(old_theme_memory);
        Ok(())
    }

    /// legacy nativeTheme의 object-spread 의미를 별도 경계로 유지한다.
    pub fn set_theme_legacy(&mut self, patch: &JsValue) -> Result<(), JsError> {
        self.set_theme_legacy_with_admission(patch, &mut || Ok(()))
    }

    /// Legacy theme 후보와 reference identity를 완성한 뒤 reply admission 직후 게시한다.
    pub fn set_theme_legacy_with_admission(
        &mut self,
        patch: &JsValue,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let mut scope = self.memory_context().scope();
        let mut candidate = self
            .theme
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let JsValue::Object(theme) = &mut candidate else {
            unreachable!("model theme is always an object")
        };
        match patch {
            JsValue::Object(patch) => {
                for (key, value) in patch.iter() {
                    reserve_legacy_theme_entry(&mut scope)?;
                    let key = key
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?;
                    let value = value
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?;
                    theme.insert(key, value);
                }
            }
            JsValue::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    reserve_legacy_theme_entry(&mut scope)?;
                    let key = JsString::try_from_str(&index.to_string(), &mut scope)
                        .map_err(|failure| failure.into_js_error())?;
                    let value = value
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?;
                    theme.insert(key, value);
                }
            }
            JsValue::String(value) => {
                for (index, unit) in value.as_units().iter().enumerate() {
                    reserve_legacy_theme_entry(&mut scope)?;
                    let key = JsString::try_from_str(&index.to_string(), &mut scope)
                        .map_err(|failure| failure.into_js_error())?;
                    scope
                        .try_grow(size_of::<u16>())
                        .map_err(|failure| failure.into_js_error())?;
                    let mut units = Vec::new();
                    units
                        .try_reserve_exact(1)
                        .map_err(|_| scope.allocation_failure().into_js_error())?;
                    units.push(*unit);
                    theme.insert(key, JsValue::String(JsString::from_utf16(units)));
                }
            }
            JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => {}
        }
        let old_theme_bytes = js_value_heap_bytes(&self.theme);
        let candidate_theme_bytes = js_value_heap_bytes(&candidate);
        let candidate_memory = scope
            .split_persistent(candidate_theme_bytes)
            .map_err(|failure| failure.into_js_error())?;
        let theme_value_identities = self.prepare_theme_value_references(patch);
        let theme_identity = Arc::new(());
        before_publish()?;
        let old_theme_memory = self
            .topology_memory
            .split(old_theme_bytes)
            .expect("theme bytes are part of model topology");
        self.topology_memory
            .absorb(candidate_memory)
            .expect("candidate theme uses the model account");
        self.theme = candidate;
        self.theme_value_identities = theme_value_identities;
        self.theme_identity = theme_identity;
        drop(old_theme_memory);
        Ok(())
    }

    /// Panel을 source validation 순서로 추가한다.
    pub fn add_panel(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        option_record(options, PANEL_KEYS, "Panel")?;
        let object = object_ref(options, "Panel: object required")?;
        let id = identifier_field(object, "id", "Panel id")?;
        if self.panels.len() >= RESOURCE_LIMITS.max_panels as usize {
            return Err(range_error("Panel limit"));
        }
        let weight = nullish_number(property(object, "weight"), 1.0);
        if self.panels.iter().any(|panel| panel.id == id) || !weight.is_finite() || weight <= 0.0 {
            return Err(error("Unique panel id and positive weight"));
        }
        let record = defaulted_record(
            &[
                ("weight", JsValue::Number(1.0)),
                ("scale", string("linear")),
                ("inverted", JsValue::Bool(false)),
                ("padding", JsValue::Number(0.08)),
            ],
            options,
            PANEL_KEYS,
        )?;
        let panel = validate_panel_record(&record)?;
        if context.drawings.transaction_active {
            return Err(error("Panel layout change during drawing transaction"));
        }
        let (panel, panel_memory) = retain_panel_with_memory(&panel, self.memory_context())?;
        let prepared =
            prepare_push_capacity(&self.panels, self.panels.capacity(), self.memory_context())?;
        let id = panel.id.clone();
        if let Some((mut next, memory)) = prepared {
            next.append(&mut self.panels);
            self.panels = next;
            self.panels_memory = memory;
        }
        self.panels.push(panel);
        self.topology_memory
            .absorb(panel_memory)
            .expect("panel metadata uses the model account");
        self.rotate_containers_identity();
        Ok(id)
    }

    /// 기존 Panel을 원자적으로 검증·교체한다.
    pub fn set_panel(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<(), JsError> {
        self.set_panel_with_admission(id, patch, context, &mut || Ok(()))
    }

    /// Panel 교체 후보와 새 identity를 완성한 뒤 외부 reply admission 직후 게시한다.
    pub fn set_panel_with_admission(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        context: &ModelContext<'_>,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let allowed: Vec<&str> = PANEL_KEYS
            .iter()
            .copied()
            .filter(|key| *key != "id")
            .collect();
        option_record(patch, &allowed, "Panel patch")?;
        let Some(index) =
            string_value(id).and_then(|id| self.panels.iter().position(|panel| panel.id == *id))
        else {
            return Err(error("Missing panel"));
        };
        let record = merged_record(&self.panels[index].record, patch, PANEL_KEYS)?;
        let next = validate_panel_record(&record)?;
        if context.drawings.transaction_active {
            let previous = &self.panels[index];
            let projection = record_fields_changed(
                &previous.record,
                &next.record,
                &[
                    "scale",
                    "inverted",
                    "padding",
                    "range",
                    "base",
                    "axisVisible",
                    "axisSide",
                ],
            );
            let weight = record_fields_changed(&previous.record, &next.record, &["weight"]);
            let mut panels = self.panels.clone();
            panels[index] = next.clone();
            let margins = axis_strip_widths(&self.panels, &self.axes, self.axis_width)
                != axis_strip_widths(&panels, &self.axes, self.axis_width);
            let drawing = context
                .drawings
                .panels
                .iter()
                .any(|panel| panel == &previous.id);
            if weight || margins || projection && drawing {
                return Err(error("Panel projection change during drawing transaction"));
            }
        }
        let (next, next_memory) = retain_panel_with_memory(&next, self.memory_context())?;
        let next_identity = Arc::new(());
        before_publish()?;
        let previous_memory = self
            .topology_memory
            .split(panel_heap_bytes(&self.panels[index]))
            .expect("panel bytes are part of model topology");
        self.topology_memory
            .absorb(next_memory)
            .expect("panel metadata uses the model account");
        self.panels[index] = next;
        drop(previous_memory);
        self.containers_identity = next_identity;
        Ok(())
    }

    /// 모든 현재 Panel id를 정확히 한 번 포함하는 새 painter 순서를 적용한다.
    pub fn set_panel_order(
        &mut self,
        ids: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<bool, JsError> {
        let JsValue::Array(ids) = ids else {
            return Err(type_error("Panel order dense array required"));
        };
        if ids.len() > RESOURCE_LIMITS.max_panels as usize {
            return Err(type_error("Panel order dense array required"));
        }
        if ids.len() != self.panels.len() {
            return Err(type_error(
                "Panel order must contain every current panel exactly once",
            ));
        }
        let mut seen = HashSet::with_capacity(ids.len());
        let mut order = Vec::with_capacity(ids.len());
        for value in ids {
            let id = identifier(value, "Panel order id")?.clone();
            if !seen.insert(id.clone()) {
                return Err(error(
                    "Panel order must contain every current panel exactly once",
                ));
            }
            let Some(index) = self.panels.iter().position(|panel| panel.id == id) else {
                return Err(error(
                    "Panel order must contain every current panel exactly once",
                ));
            };
            order.push(index);
        }
        let changed = order
            .iter()
            .enumerate()
            .any(|(position, index)| position != *index);
        reject_layout_interaction(context, true)?;
        if changed && context.drawings.transaction_active {
            return Err(error("Panel layout change during drawing transaction"));
        }
        if changed {
            for (position, value) in ids.iter().enumerate() {
                let id = identifier(value, "Panel order id")?;
                let current = self
                    .panels
                    .iter()
                    .position(|panel| &panel.id == id)
                    .expect("panel order was validated above");
                self.panels.swap(position, current);
            }
            self.rotate_containers_identity();
        }
        Ok(changed)
    }

    /// 참조되지 않는 Panel을 제거한다.
    pub fn remove_panel(
        &mut self,
        id: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<PanelRemoval, JsError> {
        self.remove_panel_with_admission(id, context, &mut || Ok(()))
    }

    /// Panel 제거 검증을 끝낸 뒤 외부 reply admission 직후 게시한다.
    pub fn remove_panel_with_admission(
        &mut self,
        id: &JsValue,
        context: &ModelContext<'_>,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<PanelRemoval, JsError> {
        let id = identifier(id, "Panel id")?.clone();
        reject_layout_interaction(context, true)?;
        let Some(index) = self.panels.iter().position(|panel| panel.id == id) else {
            return Err(error("Missing panel"));
        };
        if self.panels.len() == 1 {
            return Err(error("Cannot remove the last panel"));
        }
        if self.series.iter().any(|series| series.panel == id) {
            return Err(error("Panel is referenced by series"));
        }
        if self.axes.iter().any(|axis| axis.panel == id) {
            return Err(error("Panel is referenced by axis"));
        }
        if context.drawings.transaction_active {
            return Err(error(
                "Panel is referenced by an active drawing transaction",
            ));
        }
        if context.drawings.panels.iter().any(|panel| panel == &id) {
            return Err(error("Panel is referenced by drawing history"));
        }
        let next_identity = Arc::new(());
        let removal = PanelRemoval {
            clear_controller_target: context.drawings.controller_panel == Some(&id),
        };
        before_publish()?;
        let panel_memory = self
            .topology_memory
            .split(panel_heap_bytes(&self.panels[index]))
            .expect("panel bytes are part of model topology");
        self.panels.remove(index);
        drop(panel_memory);
        self.containers_identity = next_identity;
        Ok(removal)
    }

    /// independent Axis를 추가한다.
    pub fn add_axis(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        option_record(options, AXIS_KEYS, "Axis")?;
        let object = object_ref(options, "Axis: object required")?;
        if self.axes.len() >= RESOURCE_LIMITS.max_axes as usize {
            return Err(range_error("Axis limit"));
        }
        if let Some(id) = string_value(property_or_undefined(object, "id"))
            && self.axes.iter().any(|axis| axis.id == *id)
        {
            return Err(error("Duplicate axis"));
        }
        let record = defaulted_record(
            &[
                ("side", string("right")),
                ("scale", string("linear")),
                ("inverted", JsValue::Bool(false)),
                ("padding", JsValue::Number(0.08)),
                ("visible", JsValue::Bool(true)),
                ("tickFormat", string("fixed")),
            ],
            options,
            AXIS_KEYS,
        )?;
        let axis = validate_axis_record(&record, &self.panels)?;
        if context.drawings.transaction_active {
            let mut axes = self.axes.clone();
            axes.push(axis.clone());
            if axis_strip_widths(&self.panels, &self.axes, self.axis_width)
                != axis_strip_widths(&self.panels, &axes, self.axis_width)
            {
                return Err(error("Axis layout change during drawing transaction"));
            }
        }
        let (axis, axis_memory) = retain_axis_with_memory(&axis, self.memory_context())?;
        let prepared =
            prepare_push_capacity(&self.axes, self.axes.capacity(), self.memory_context())?;
        let id = axis.id.clone();
        if let Some((mut next, memory)) = prepared {
            next.append(&mut self.axes);
            self.axes = next;
            self.axes_memory = memory;
        }
        self.axes.push(axis);
        self.topology_memory
            .absorb(axis_memory)
            .expect("axis metadata uses the model account");
        self.rotate_containers_identity();
        Ok(id)
    }

    /// 기존 independent Axis를 원자적으로 교체한다.
    pub fn set_axis(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<(), JsError> {
        self.set_axis_with_admission(id, patch, context, &mut || Ok(()))
    }

    /// Axis 교체 후보와 새 identity를 완성한 뒤 외부 reply admission 직후 게시한다.
    pub fn set_axis_with_admission(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        context: &ModelContext<'_>,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let allowed: Vec<&str> = AXIS_KEYS
            .iter()
            .copied()
            .filter(|key| !matches!(*key, "id" | "panel"))
            .collect();
        option_record(patch, &allowed, "Axis patch")?;
        let Some(index) =
            string_value(id).and_then(|id| self.axes.iter().position(|axis| axis.id == *id))
        else {
            return Err(error("Missing axis"));
        };
        let record = merged_record(&self.axes[index].record, patch, AXIS_KEYS)?;
        let next = validate_axis_record(&record, &self.panels)?;
        if context.drawings.transaction_active {
            let previous = &self.axes[index];
            let mut axes = self.axes.clone();
            axes[index] = next.clone();
            let margins = axis_strip_widths(&self.panels, &self.axes, self.axis_width)
                != axis_strip_widths(&self.panels, &axes, self.axis_width);
            let projection = record_fields_changed(
                &previous.record,
                &next.record,
                &[
                    "scale", "inverted", "padding", "range", "base", "width", "side", "visible",
                ],
            );
            let drawing = context
                .drawings
                .axes
                .iter()
                .any(|axis| axis == &previous.id);
            if margins || projection && drawing {
                return Err(error("Axis projection change during drawing transaction"));
            }
        }
        let (next, next_memory) = retain_axis_with_memory(&next, self.memory_context())?;
        let next_identity = Arc::new(());
        before_publish()?;
        let previous_memory = self
            .topology_memory
            .split(axis_heap_bytes(&self.axes[index]))
            .expect("axis bytes are part of model topology");
        self.topology_memory
            .absorb(next_memory)
            .expect("axis metadata uses the model account");
        self.axes[index] = next;
        drop(previous_memory);
        self.containers_identity = next_identity;
        Ok(())
    }

    /// Series/drawing이 참조하지 않는 Axis를 제거한다. Unknown id는 JS처럼 no-op이다.
    pub fn remove_axis(
        &mut self,
        id: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<AxisRemoval, JsError> {
        self.remove_axis_with_admission(id, context, &mut || Ok(()))
    }

    /// Axis 제거 검증을 끝낸 뒤 외부 reply admission 직후 게시한다.
    pub fn remove_axis_with_admission(
        &mut self,
        id: &JsValue,
        context: &ModelContext<'_>,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<AxisRemoval, JsError> {
        let id = identifier(id, "Axis id")?.clone();
        if self
            .series
            .iter()
            .any(|series| series.axis_id.as_ref() == Some(&id))
            || context.drawings.axes.iter().any(|axis| axis == &id)
        {
            return Err(error(
                "Axis is referenced by series or drawing history/transaction",
            ));
        }
        let next: Vec<Axis> = self
            .axes
            .iter()
            .filter(|axis| axis.id != id)
            .cloned()
            .collect();
        let layout_change = axis_strip_widths(&self.panels, &self.axes, self.axis_width)
            != axis_strip_widths(&self.panels, &next, self.axis_width);
        if context.drawings.transaction_active && layout_change {
            return Err(error("Axis layout change during drawing transaction"));
        }
        reject_layout_interaction(context, layout_change)?;
        let next_identity = Arc::new(());
        let removal = AxisRemoval {
            clear_controller_target: context.drawings.controller_axis == Some(&id),
        };
        before_publish()?;
        let removed_bytes = self
            .axes
            .iter()
            .filter(|axis| axis.id == id)
            .map(axis_heap_bytes)
            .sum::<usize>();
        let removed_memory = self
            .topology_memory
            .split(removed_bytes)
            .expect("axis bytes are part of model topology");
        self.axes.retain(|axis| axis.id != id);
        drop(removed_memory);
        self.containers_identity = next_identity;
        Ok(removal)
    }

    /// Drawing target의 panel/axis/series binding을 현재 model에 대조한다.
    pub fn validate_drawing_binding(
        &self,
        drawing: &JsValue,
        allow_orphan_series: bool,
    ) -> Result<bool, JsError> {
        let object = object_ref(drawing, "Drawing binding object required")?;
        let panel_value = property_or_undefined(object, "panel");
        if !matches!(panel_value, JsValue::Undefined) {
            identifier(panel_value, "Drawing panel")?;
        }
        for (key, label) in [
            ("axisId", "Drawing axisId"),
            ("seriesId", "Drawing seriesId"),
        ] {
            let value = property_or_undefined(object, key);
            if !matches!(value, JsValue::Undefined | JsValue::Null) {
                identifier(value, label)?;
            }
        }
        let default_panel = JsString::from_str("price");
        let panel = match panel_value {
            JsValue::String(value) => value,
            JsValue::Undefined | JsValue::Null => &default_panel,
            _ => unreachable!("identifier rejected a defined non-string panel"),
        };
        if !self.panels.iter().any(|candidate| candidate.id == *panel) {
            return Err(error("Missing drawing panel"));
        }
        let axis = optional_string(property_or_undefined(object, "axisId"));
        if let Some(axis) = axis
            && !self.axes.iter().any(|candidate| {
                candidate.id == *axis
                    && matches!(panel_value, JsValue::String(value) if candidate.panel == *value)
            })
        {
            return Err(error("Missing drawing axis binding"));
        }
        if !allow_orphan_series
            && let Some(series_id) = optional_string(property_or_undefined(object, "seriesId"))
        {
            let bound_panel = string_value(panel_value);
            let valid = self.series.iter().any(|series| {
                series.id == *series_id
                    && bound_panel.is_some_and(|panel| series.panel == *panel)
                    && series.axis_id.as_ref() == axis
            });
            if !valid {
                return Err(error("Missing or mismatched drawing series binding"));
            }
        }
        Ok(true)
    }

    /// Indicator에 묶인 모든 Series의 panel/axis placement를 한 번에 바꾼다.
    pub fn set_indicator_placement(
        &mut self,
        id: &JsValue,
        placement: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<PlacementReceipt, JsError> {
        let id = identifier(id, "Indicator id")?.clone();
        if context.indicator(&id).is_none() {
            return Err(error("Missing indicator"));
        }
        let bound: Vec<usize> = self
            .series
            .iter()
            .enumerate()
            .filter_map(|(index, series)| (series.indicator.as_ref() == Some(&id)).then_some(index))
            .collect();
        if bound.is_empty() {
            return Err(error("Indicator has no bound series"));
        }
        let object = object_ref(placement, "Indicator placement record required")?;
        if object
            .iter()
            .any(|(key, _)| !text_is(key, "panel") && !text_is(key, "axisId"))
        {
            return Err(type_error("Indicator placement fields"));
        }
        if property(object, "panel").is_none() {
            return Err(type_error("Indicator placement panel required"));
        }
        let panel = identifier(
            property_or_undefined(object, "panel"),
            "Indicator placement panel",
        )?
        .clone();
        let axis_id = match property_or_undefined(object, "axisId") {
            JsValue::Undefined | JsValue::Null => None,
            value => Some(identifier(value, "Indicator placement axis")?.clone()),
        };
        if !self.panels.iter().any(|candidate| candidate.id == panel) {
            return Err(error("Missing placement panel"));
        }
        if let Some(axis_id) = &axis_id
            && !self
                .axes
                .iter()
                .any(|axis| axis.id == *axis_id && axis.panel == panel)
        {
            return Err(error("Missing placement axis"));
        }
        reject_layout_interaction(context, true)?;
        if context.drawings.transaction_active {
            // JS owner guard는 호출 시작부터 있던 transaction을 명시적 transaction
            // 검사보다 먼저 stale owner로 분류한다. 이 DTO는 call-entry snapshot이므로
            // 중간 reentry로 새 transaction이 생긴 별도 경로를 표현하지 않는다.
            return Err(stale_error("Indicator placement owner changed"));
        }
        let changed = bound
            .iter()
            .filter(|index| {
                let series = &self.series[**index];
                series.panel != panel || series.axis_id != axis_id
            })
            .count();
        let bound_ids = bound
            .iter()
            .map(|index| self.series[*index].id.clone())
            .collect();
        if changed > 0 {
            let (mut staged, _staged_memory) = self
                .memory_context()
                .try_vec_capacity(changed)
                .map_err(|failure| failure.into_js_error())?;
            for index in bound.iter().copied().filter(|index| {
                let series = &self.series[*index];
                series.panel != panel || series.axis_id != axis_id
            }) {
                let series = &self.series[index];
                let mut patch = JsObject::new();
                patch.insert(JsString::from_str("panel"), JsValue::String(panel.clone()));
                patch.insert(
                    JsString::from_str("axisId"),
                    axis_id
                        .as_ref()
                        .map_or(JsValue::Null, |axis| JsValue::String(axis.clone())),
                );
                let record = merged_record(&series.record, &JsValue::Object(patch), SERIES_KEYS)?;
                let bytes = series_parts_heap_bytes(
                    &record,
                    &series.id,
                    &panel,
                    axis_id.as_ref(),
                    series.indicator.as_ref(),
                    series.output.as_ref(),
                );
                let memory = self
                    .memory_context()
                    .reserve_group(bytes)
                    .map_err(|failure| failure.into_js_error())?;
                staged.push((index, record, memory));
            }
            for (index, record, memory) in staged {
                let series = &mut self.series[index];
                series.panel = panel.clone();
                series.axis_id = axis_id.clone();
                series.record = record;
                series.metadata_memory = memory;
            }
            self.rotate_containers_identity();
        }
        Ok(PlacementReceipt {
            changed,
            panel,
            axis_id,
            bound_ids,
        })
    }

    /// Series options를 검증·정규화하되 model에는 게시하지 않는다.
    pub fn normalized_series(
        &self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<Series, JsError> {
        normalize_series(options, None, None, self, context, None)
    }

    /// caller scope에서 동적 검증 오류 문자열까지 보유하며 Series 후보를 정규화한다.
    pub fn normalized_series_scoped(
        &self,
        options: &JsValue,
        context: &ModelContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<Series, JsError> {
        normalize_series(options, None, None, self, context, Some(scope))
    }

    /// ChartAPI.setSeries가 외부 values 소유 복사까지 포함한 후보를 게시 전에 검증한다.
    pub fn normalized_series_with_values(
        &self,
        options: &JsValue,
        values: Option<Vec<f64>>,
        context: &ModelContext<'_>,
    ) -> Result<Series, JsError> {
        normalize_series(options, values, None, self, context, None)
    }

    /// setSeries staging이 기존 allocation을 복사하지 않고 attachment 존재만 검증한다.
    pub fn normalized_series_for_replacement(
        &self,
        options: &JsValue,
        values: Option<Vec<f64>>,
        values_present: bool,
        context: &ModelContext<'_>,
    ) -> Result<Series, JsError> {
        normalize_series_inner(options, values, None, values_present, self, context, None)
    }

    /// 이미 과금된 replacement values 후보를 scalar 검증 뒤 lease와 함께 채택한다.
    pub fn normalized_series_for_owned_replacement(
        &self,
        options: &JsValue,
        values: Option<(Vec<f64>, MemoryGroup)>,
        values_present: bool,
        context: &ModelContext<'_>,
    ) -> Result<Series, JsError> {
        let (values, values_memory) = values.map_or((None, None), |(values, memory)| {
            (Some(values), Some(memory))
        });
        normalize_series_inner(
            options,
            values,
            values_memory,
            values_present,
            self,
            context,
            None,
        )
    }

    /// caller scope에서 동적 오류 payload를 유지하며 이미 과금된 values 후보를 검증한다.
    pub fn normalized_series_for_owned_replacement_scoped(
        &self,
        options: &JsValue,
        values: Option<(Vec<f64>, MemoryGroup)>,
        values_present: bool,
        context: &ModelContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<Series, JsError> {
        let (values, values_memory) = values.map_or((None, None), |(values, memory)| {
            (Some(values), Some(memory))
        });
        normalize_series_inner(
            options,
            values,
            values_memory,
            values_present,
            self,
            context,
            Some(scope),
        )
    }

    /// Series를 검증·정규화해 painter 순서 끝에 추가한다.
    pub fn add_series(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(options, None, None, context, None)
    }

    /// caller scope에서 동적 검증 오류 문자열을 유지하며 Series를 추가한다.
    pub fn add_series_scoped(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(options, None, None, context, Some(scope))
    }

    /// FFI가 별도 typed-F64 attachment로 받은 외부 값을 포함해 Series를 추가한다.
    pub fn add_series_with_values(
        &mut self,
        options: &JsValue,
        values: Vec<f64>,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(options, Some(values), None, context, None)
    }

    /// 이미 같은 엔진 account에 과금된 외부 values와 lease를 재예약 없이 Series로 옮긴다.
    pub fn add_series_with_owned_values(
        &mut self,
        options: &JsValue,
        values: Vec<f64>,
        values_memory: MemoryGroup,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(options, Some(values), Some(values_memory), context, None)
    }

    /// caller scope와 이미 과금된 values를 함께 써서 Series를 추가한다.
    pub fn add_series_with_owned_values_scoped(
        &mut self,
        options: &JsValue,
        values: Vec<f64>,
        values_memory: MemoryGroup,
        context: &ModelContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(
            options,
            Some(values),
            Some(values_memory),
            context,
            Some(scope),
        )
    }

    fn add_series_owned(
        &mut self,
        options: &JsValue,
        values: Option<Vec<f64>>,
        values_memory: Option<MemoryGroup>,
        context: &ModelContext<'_>,
        error_scope: Option<&mut MemoryScope>,
    ) -> Result<JsString, JsError> {
        let replaces_values = values.is_some();
        if self.series.len() >= RESOURCE_LIMITS.max_series as usize {
            return Err(range_error("Series limit"));
        }
        if let JsValue::Object(object) = options
            && let Some(id) = string_value(property_or_undefined(object, "id"))
            && self.series.iter().any(|series| series.id == *id)
        {
            return Err(error("Duplicate series"));
        }
        let series = normalize_series(options, values, values_memory, self, context, error_scope)?;
        let prepared =
            prepare_push_capacity(&self.series, self.series.capacity(), self.memory_context())?;
        let id = series.id.clone();
        if let Some((mut next, memory)) = prepared {
            next.append(&mut self.series);
            self.series = next;
            self.series_memory = memory;
        }
        self.series.push(series);
        self.rotate_containers_identity();
        if replaces_values {
            self.mark_series_values_replaced();
        }
        Ok(id)
    }

    /// id가 같은 Series를 제거한다. JS 저수준 메서드처럼 id 자체는 검증하지 않는다.
    pub fn remove_series(&mut self, id: &JsValue) {
        self.remove_series_with_admission(id, &mut || Ok(()))
            .expect("infallible default series removal admission");
    }

    /// Series 제거 대상과 새 container identity를 준비한 뒤 reply admission 직후 게시한다.
    pub fn remove_series_with_admission(
        &mut self,
        id: &JsValue,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let prepared = self.prepare_series_publication(false);
        before_publish()?;
        self.publish_prepared_series_removal(id, prepared);
        Ok(())
    }

    /// 일반 non-indicator Series의 aligned 외부 값을 소유 교체한다.
    pub fn set_series_values(
        &mut self,
        id: &JsValue,
        values: Vec<f64>,
        store: &BarStore,
    ) -> Result<(), JsError> {
        self.set_series_values_owned(id, values, None, store, &mut || Ok(()))
    }

    /// 이미 같은 엔진 account에 과금된 aligned values를 재예약 없이 교체 게시한다.
    pub fn set_series_values_with_owned_values(
        &mut self,
        id: &JsValue,
        values: Vec<f64>,
        values_memory: MemoryGroup,
        store: &BarStore,
    ) -> Result<(), JsError> {
        self.set_series_values_owned(id, values, Some(values_memory), store, &mut || Ok(()))
    }

    /// 과금된 external values 후보를 검증한 뒤 reply admission 직후 게시한다.
    pub fn set_series_values_with_owned_values_and_admission(
        &mut self,
        id: &JsValue,
        values: Vec<f64>,
        values_memory: MemoryGroup,
        store: &BarStore,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        self.set_series_values_owned(id, values, Some(values_memory), store, before_publish)
    }

    fn set_series_values_owned(
        &mut self,
        id: &JsValue,
        values: Vec<f64>,
        values_memory: Option<MemoryGroup>,
        store: &BarStore,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let memory = self.memory_context().clone();
        let Some(id) = string_value(id) else {
            return Err(type_error("Aligned values and existing series required"));
        };
        let Some(series) = self.series.iter_mut().find(|series| series.id == *id) else {
            return Err(type_error("Aligned values and existing series required"));
        };
        if values.len() != store.length() {
            return Err(type_error("Aligned values and existing series required"));
        }
        if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
            || series.indicator.is_some()
        {
            return Err(type_error(
                "External values require a general non-indicator series",
            ));
        }
        let values_memory = external_values_memory(&memory, values.capacity(), values_memory)?;
        let next_containers_identity = Arc::new(());
        let next_values_identity = Arc::new(());
        before_publish()?;
        series.values = Some(values);
        series.values_memory = values_memory;
        series.dirty_from = 0.0;
        series.revision = None;
        series.range_index_ready = false;
        series.values_revision = Some(series.values_revision.unwrap_or(0.0) + 1.0);
        self.series_values_revision = Some(self.series_values_revision.unwrap_or(0.0) + 1.0);
        self.containers_identity = next_containers_identity;
        self.values_reference_identity = next_values_identity;
        Ok(())
    }

    /// 외부 값 교체의 model-wide revision이다.
    pub fn series_values_revision(&self) -> Option<f64> {
        self.series_values_revision
    }

    /// Root store listener가 commit 뒤 전달하는 view/cache 효과를 적용한다.
    pub fn on_store_change(&mut self, store: &BarStore, change: &DataChange) {
        let prepared =
            (change.kind == ChangeKind::Reset).then(|| self.prepare_store_change_publication());
        self.on_store_change_with_publication(store, change, prepared);
    }

    /// Reply admission 전에 준비한 reset identity로 store-derived 효과를 allocation 없이 게시한다.
    pub fn on_store_change_with_publication(
        &mut self,
        store: &BarStore,
        change: &DataChange,
        prepared: Option<PreparedStoreChangePublication>,
    ) {
        if change.kind == ChangeKind::Compact {
            return;
        }
        if change.kind == ChangeKind::Prepend
            && change.added.is_some_and(|added| store.length() > added)
        {
            let added = change.added.unwrap_or(0) as f64;
            self.view.from += added;
            self.view.to += added;
        } else if change.kind == ChangeKind::Reset {
            let prepared = prepared.expect("fixed reset publication identity");
            let to = js_max(&[9.5, store.length() as f64 + self.forward_offset() - 0.5]);
            let view = self
                .prepare_visible_range_with_identity(
                    store,
                    &JsValue::Number(-0.5),
                    &JsValue::Number(to),
                    prepared.reset_view_identity,
                )
                .expect("fit creates a valid range");
            self.publish_prepared_view(view);
        }
        let appended = change.appended.unwrap_or(0);
        if (change.kind == ChangeKind::Append
            || change.kind == ChangeKind::Batch && appended > 0
            || change.kind == ChangeKind::Prepend
                && change
                    .added
                    .is_some_and(|added| added > 0 && store.length() == added))
            && self.follow
        {
            let span = self.view.to - self.view.from;
            self.view.to = store.length() as f64 + self.forward_offset() - 0.5;
            self.view.from = self.view.to - span;
        }
        for series in &mut self.series {
            series.dirty_from = js_min(&[series.dirty_from, change.from as f64]);
        }
    }

    /// 검증이 끝난 compaction series cache restart를 실패 없이 게시한다.
    pub fn publish_compaction_caches(&mut self) {
        for series in &mut self.series {
            series.range_index_ready = false;
            series.revision = None;
            series.dirty_from = 0.0;
        }
    }

    /// Store publication과 같은 commit 구간에서 compaction view를 설치한다.
    pub fn publish_compaction_view(&mut self, view: VisibleRange) {
        self.publish_view_replacement(view, self.follow);
    }

    /// visible series의 가장 큰 양수/음수 offset에 대해 JS Math.max 규칙을 쓴다.
    pub fn forward_offset(&self) -> f64 {
        let mut highest = 0.0;
        for offset in self
            .series
            .iter()
            .filter(|series| series.visible)
            .map(|series| series.offset)
        {
            highest = js_max(&[highest, offset]);
        }
        highest
    }

    /// visible range를 검증하고 clamp/follow/object identity를 detached 후보로 만든다.
    pub fn prepare_visible_range(
        &self,
        store: &BarStore,
        from: &JsValue,
        to: &JsValue,
    ) -> Result<PreparedView, JsError> {
        self.prepare_visible_range_with_identity(store, from, to, Arc::new(()))
    }

    fn prepare_visible_range_with_identity(
        &self,
        store: &BarStore,
        from: &JsValue,
        to: &JsValue,
        identity: Arc<()>,
    ) -> Result<PreparedView, JsError> {
        let (JsValue::Number(from), JsValue::Number(to)) = (from, to) else {
            return Err(range_error("Visible range"));
        };
        if !from.is_finite() || !to.is_finite() || to <= from {
            return Err(range_error("Visible range"));
        }
        let n = js_max(&[10.0, store.length() as f64 + self.forward_offset()]);
        let span = js_min(&[n, js_max(&[js_min(&[10.0, n]), to - from])]);
        let start = js_max(&[-0.5, js_min(&[n - 0.5 - span, *from])]);
        let view = VisibleRange {
            from: start,
            to: start + span,
        };
        let follow = (view.to - (store.length() as f64 + self.forward_offset() - 0.5)).abs() < 1.0;
        Ok(PreparedView {
            view,
            follow,
            identity,
        })
    }

    /// visible range 후보를 만든 뒤 즉시 게시하는 기존 Core API다.
    pub fn set_visible_range(
        &mut self,
        store: &BarStore,
        from: &JsValue,
        to: &JsValue,
    ) -> Result<(), JsError> {
        let prepared = self.prepare_visible_range(store, from, to)?;
        self.publish_prepared_view(prepared);
        Ok(())
    }

    /// 전체 store와 future offset을 맞춘 detached view 후보를 만든다.
    pub fn prepare_fit(&self, store: &BarStore) -> PreparedView {
        self.prepare_fit_with_store_publication(store, self.prepare_store_change_publication())
    }

    /// 미리 확보한 store-publication identity로 fit 후보를 추가 allocation 없이 만든다.
    pub fn prepare_fit_with_store_publication(
        &self,
        store: &BarStore,
        prepared: PreparedStoreChangePublication,
    ) -> PreparedView {
        let to = js_max(&[9.5, store.length() as f64 + self.forward_offset() - 0.5]);
        self.prepare_visible_range_with_identity(
            store,
            &JsValue::Number(-0.5),
            &JsValue::Number(to),
            prepared.reset_view_identity,
        )
        .expect("fit creates a valid range")
    }

    /// 전체 store와 future offset을 맞춘다.
    pub fn fit(&mut self, store: &BarStore) {
        let prepared = self.prepare_fit(store);
        self.publish_prepared_view(prepared);
    }

    /// factor와 JS Number-coerced anchor를 검증한 확대/축소 후보를 만든다.
    pub fn prepare_zoom(
        &self,
        store: &BarStore,
        factor: &JsValue,
        anchor: Option<&JsValue>,
    ) -> Result<PreparedView, JsError> {
        let JsValue::Number(factor) = factor else {
            return Err(range_error("Zoom factor"));
        };
        if !factor.is_finite() || *factor <= 0.0 {
            return Err(range_error("Zoom factor"));
        }
        let mut scope = self.memory_context().scope();
        let anchor = js_to_number_scoped(
            anchor.unwrap_or(&JsValue::Number(0.5)),
            NumberDialect::PLATFORM,
            &mut scope,
        )?;
        let anchor = js_max(&[0.0, js_min(&[1.0, anchor])]);
        let span = self.view.to - self.view.from;
        let at = self.view.from + span * anchor;
        let next = span * factor;
        self.prepare_visible_range(
            store,
            &JsValue::Number(at - next * anchor),
            &JsValue::Number(at + next * (1.0 - anchor)),
        )
    }

    /// factor와 anchor를 검증한 후보를 만든 뒤 즉시 게시하는 기존 Core API다.
    pub fn zoom(
        &mut self,
        store: &BarStore,
        factor: &JsValue,
        anchor: Option<&JsValue>,
    ) -> Result<(), JsError> {
        let prepared = self.prepare_zoom(store, factor, anchor)?;
        self.publish_prepared_view(prepared);
        Ok(())
    }

    /// JS `+` 의미에서 숫자로 남는 delta만 허용한 pan 후보를 만든다.
    pub fn prepare_pan(&self, store: &BarStore, delta: &JsValue) -> Result<PreparedView, JsError> {
        let mut scope = self.memory_context().scope();
        let from =
            js_add_number_scoped(self.view.from, delta, NumberDialect::PLATFORM, &mut scope)?;
        let to = js_add_number_scoped(self.view.to, delta, NumberDialect::PLATFORM, &mut scope)?;
        self.prepare_visible_range(store, &from, &to)
    }

    /// JS `+` 의미의 pan 후보를 만든 뒤 즉시 게시하는 기존 Core API다.
    pub fn pan(&mut self, store: &BarStore, delta: &JsValue) -> Result<(), JsError> {
        let prepared = self.prepare_pan(store, delta)?;
        self.publish_prepared_view(prepared);
        Ok(())
    }

    /// source key order의 모델 configuration snapshot이다.
    pub fn snapshot(&self) -> JsValue {
        object([
            (
                "view",
                object([
                    ("from", JsValue::Number(self.view.from)),
                    ("to", JsValue::Number(self.view.to)),
                ]),
            ),
            ("theme", self.theme.clone()),
            (
                "panels",
                JsValue::Array(self.panels.iter().map(Panel::to_js_value).collect()),
            ),
            (
                "axes",
                JsValue::Array(self.axes.iter().map(Axis::to_js_value).collect()),
            ),
            (
                "series",
                JsValue::Array(self.series.iter().map(Series::to_js_value).collect()),
            ),
            ("axisWidth", JsValue::Number(self.axis_width)),
            ("precision", JsValue::Number(f64::from(self.precision))),
            ("follow", JsValue::Bool(self.follow)),
        ])
    }
}

#[derive(Clone)]
struct PanelFields {
    weight: f64,
    scale: JsString,
    inverted: bool,
    padding: f64,
    axis_visible: bool,
    axis_side: JsString,
}

fn normalize_series(
    options: &JsValue,
    attached_values: Option<Vec<f64>>,
    attached_values_memory: Option<MemoryGroup>,
    model: &ModelState,
    context: &ModelContext<'_>,
    error_scope: Option<&mut MemoryScope>,
) -> Result<Series, JsError> {
    let values_present = attached_values.is_some();
    normalize_series_inner(
        options,
        attached_values,
        attached_values_memory,
        values_present,
        model,
        context,
        error_scope,
    )
}

fn normalize_series_inner(
    options: &JsValue,
    attached_values: Option<Vec<f64>>,
    attached_values_memory: Option<MemoryGroup>,
    attached_values_present: bool,
    model: &ModelState,
    context: &ModelContext<'_>,
    error_scope: Option<&mut MemoryScope>,
) -> Result<Series, JsError> {
    option_record(options, SERIES_KEYS, "Series")?;
    let object = object_ref(options, "Series: object required")?;
    let id = identifier_field(object, "id", "Series id")?;
    let panel = identifier_field(object, "panel", "Series panel")?;
    let axis_id = match property_or_undefined(object, "axisId") {
        JsValue::Undefined | JsValue::Null => None,
        value => {
            let axis = identifier(value, "Series axis")?.clone();
            if !model
                .axes
                .iter()
                .any(|candidate| candidate.id == axis && candidate.panel == panel)
            {
                return Err(error("Missing series axis in panel"));
            }
            Some(axis)
        }
    };
    let values_value = property_or_undefined(object, "values");
    let values_present = attached_values_present || truthy(values_value);
    let symbol_value = property_or_undefined(object, "symbolId");
    if !matches!(symbol_value, JsValue::Undefined) {
        identifier(symbol_value, "Series symbol")?;
        if !values_present {
            return Err(type_error(
                "symbolId belongs to externally aligned values; store/indicator series use primary symbol",
            ));
        }
    }
    let label = property_or_undefined(object, "label");
    if !matches!(label, JsValue::Undefined) {
        bounded_text(label, 256, "Series label", false)?;
    }
    for (key, label) in [
        ("color", "color"),
        ("fill", "fill"),
        ("upColor", "upColor"),
        ("downColor", "downColor"),
    ] {
        let value = property_or_undefined(object, key);
        if !matches!(value, JsValue::Undefined | JsValue::Null) {
            bounded_text(value, 128, label, false)?;
        }
    }
    let visible_value = property_or_undefined(object, "visible");
    let width_value = property_or_undefined(object, "width");
    let baseline_value = property_or_undefined(object, "baseline");
    let style_invalid = !matches!(visible_value, JsValue::Undefined | JsValue::Bool(_))
        || defined(width_value)
            && !matches!(width_value, JsValue::Number(value) if value.is_finite() && *value > 0.0 && *value <= 50.0)
        || defined(baseline_value)
            && !matches!(baseline_value, JsValue::Number(value) if value.is_finite());
    if style_invalid {
        return Err(type_error("Series style/visibility"));
    }
    if !model.panels.iter().any(|candidate| candidate.id == panel) {
        return Err(error("Unique series id and existing panel required"));
    }
    let type_value = property_or_undefined(object, "type");
    let kind_name = string_value(type_value);
    let primary_ohlc =
        kind_name.is_some_and(|kind| text_is(kind, "candles") || text_is(kind, "ohlc"));
    let indicator_value = property_or_undefined(object, "indicator");
    let indicator_present = truthy(indicator_value);
    let source_value = property_or_undefined(object, "source");
    if primary_ohlc
        && (indicator_present
            || values_present
            || defined(source_value)
            || !matches!(symbol_value, JsValue::Undefined))
    {
        return Err(type_error("Candles/OHLC use primary store OHLCV"));
    }
    let kind = match kind_name {
        Some(value) if text_is(value, "candles") => SeriesKind::Candles,
        Some(value) if text_is(value, "ohlc") => SeriesKind::Ohlc,
        Some(value) if text_is(value, "line") => SeriesKind::Line,
        Some(value) if text_is(value, "area") => SeriesKind::Area,
        Some(value) if text_is(value, "histogram") => SeriesKind::Histogram,
        _ => return Err(error("Unknown series type")),
    };
    if values_present && indicator_present {
        return Err(type_error(
            "Series chooses external values or indicator output",
        ));
    }
    let values = if let Some(values) = attached_values {
        if values.len() != context.store.length() {
            return Err(type_error("Values must be aligned Float64Array"));
        }
        Some(values)
    } else if attached_values_present {
        None
    } else if truthy(values_value) {
        return Err(type_error("Values must be aligned Float64Array"));
    } else {
        None
    };
    let (indicator, definition) = if indicator_present {
        let Some(indicator) = string_value(indicator_value) else {
            return Err(missing_indicator_error(
                indicator_value,
                context.store,
                error_scope,
            )?);
        };
        let Some(definition) = context.indicator(indicator) else {
            return Err(missing_indicator_error(
                indicator_value,
                context.store,
                error_scope,
            )?);
        };
        (Some(indicator.clone()), Some(definition))
    } else {
        (None, None)
    };
    if defined(source_value)
        && !string_value(source_value).is_some_and(|source| {
            ["time", "open", "high", "low", "close", "volume"]
                .iter()
                .any(|candidate| text_is(source, candidate))
        })
    {
        return Err(type_error("Series source"));
    }
    let output_value = property_or_undefined(object, "output");
    let output = if let Some(definition) = definition {
        if defined(output_value)
            && !string_value(output_value).is_some_and(|output| {
                definition
                    .outputs
                    .iter()
                    .any(|candidate| text_is(output, candidate))
            })
        {
            return Err(error("Missing indicator output"));
        }
        match string_value(output_value) {
            Some(output) if defined(output_value) => Some(output.clone()),
            _ => Some(JsString::from_str(definition.outputs[0])),
        }
    } else {
        None
    };
    let offset_value = property_or_undefined(object, "offset");
    let offset = if nullish(offset_value) {
        definition
            .zip(output.as_ref())
            .map_or(0.0, |(definition, output)| {
                definition
                    .plot_offsets
                    .iter()
                    .find(|candidate| text_is(output, candidate.output))
                    .map_or(0.0, |candidate| candidate.value)
            })
    } else {
        match offset_value {
            JsValue::Number(value) => *value,
            _ => f64::NAN,
        }
    };
    if !offset.is_finite()
        || offset.fract() != 0.0
        || offset.abs() > 10_000.0
        || matches!(kind, SeriesKind::Candles | SeriesKind::Ohlc) && offset != 0.0
    {
        return Err(range_error("Series plot offset"));
    }
    let default_width = if matches!(kind, SeriesKind::Candles | SeriesKind::Ohlc) {
        1.0
    } else {
        1.5
    };
    let mut normalized = defaulted_record(
        &[
            ("color", string("#7898ff")),
            ("width", JsValue::Number(default_width)),
        ],
        options,
        SERIES_KEYS,
    )?;
    let JsValue::Object(normalized_object) = &mut normalized else {
        unreachable!("defaulted record is an object")
    };
    if values.is_some() {
        normalized_object.remove(&JsString::from_str("values"));
    }
    normalized_object.insert(JsString::from_str("offset"), JsValue::Number(offset));
    normalized = ordered_record(&normalized, SERIES_KEYS)?;
    let memory = model.memory_context();
    let values_memory = if let Some(values) = &values {
        external_values_memory(memory, values.capacity(), attached_values_memory)?
    } else if attached_values_memory.is_some() {
        return Err(memory.allocation_failure().into_js_error());
    } else {
        MemoryGroup::empty(memory.clone())
    };
    let mut metadata_scope = memory.scope();
    let record = normalized
        .try_clone_scoped(&mut metadata_scope)
        .map_err(|failure| failure.into_js_error())?;
    let id = id
        .try_clone_scoped(&mut metadata_scope)
        .map_err(|failure| failure.into_js_error())?;
    let panel = panel
        .try_clone_scoped(&mut metadata_scope)
        .map_err(|failure| failure.into_js_error())?;
    let axis_id = axis_id
        .as_ref()
        .map(|value| value.try_clone_scoped(&mut metadata_scope))
        .transpose()
        .map_err(|failure| failure.into_js_error())?;
    let indicator = indicator
        .as_ref()
        .map(|value| value.try_clone_scoped(&mut metadata_scope))
        .transpose()
        .map_err(|failure| failure.into_js_error())?;
    let output = output
        .as_ref()
        .map(|value| value.try_clone_scoped(&mut metadata_scope))
        .transpose()
        .map_err(|failure| failure.into_js_error())?;
    let metadata_bytes = series_parts_heap_bytes(
        &record,
        &id,
        &panel,
        axis_id.as_ref(),
        indicator.as_ref(),
        output.as_ref(),
    );
    let metadata_memory = metadata_scope
        .split_persistent(metadata_bytes)
        .map_err(|failure| failure.into_js_error())?;
    Ok(Series {
        record,
        id,
        panel,
        axis_id,
        kind,
        indicator,
        output,
        offset,
        visible: !matches!(visible_value, JsValue::Bool(false)),
        values,
        values_revision: None,
        dirty_from: 0.0,
        revision: None,
        range_index_ready: false,
        metadata_memory,
        values_memory,
    })
}

fn validate_panel_record(record: &JsValue) -> Result<Panel, JsError> {
    let object = object_ref(record, "Panel: object required")?;
    let id = identifier_field(object, "id", "Panel id")?;
    let fields = validate_panel_fields(object)?;
    Ok(Panel {
        record: ordered_record(record, PANEL_KEYS)?,
        id,
        weight: fields.weight,
        scale: fields.scale,
        inverted: fields.inverted,
        padding: fields.padding,
        axis_visible: fields.axis_visible,
        axis_side: fields.axis_side,
    })
}

fn validate_panel_fields(object: &JsObject) -> Result<PanelFields, JsError> {
    let axis_visible = property_or_undefined(object, "axisVisible");
    let axis_side = property_or_undefined(object, "axisSide");
    if !matches!(axis_visible, JsValue::Undefined | JsValue::Bool(_))
        || defined(axis_side)
            && !string_value(axis_side)
                .is_some_and(|value| text_is(value, "left") || text_is(value, "right"))
    {
        return Err(type_error("Panel axis visibility/side"));
    }
    let inverted = property_or_undefined(object, "inverted");
    let label = property_or_undefined(object, "label");
    let formatter = property_or_undefined(object, "formatter");
    let range = property_or_undefined(object, "range");
    if !matches!(inverted, JsValue::Bool(_))
        || defined(label) && !matches!(label, JsValue::String(_))
        || defined(formatter)
        || truthy(range) && !matches!(range, JsValue::Array(values) if values.len() == 2)
    {
        return Err(type_error("Panel label, inverted, formatter or range"));
    }
    if defined(label) {
        bounded_text(label, 256, "Panel label", false)?;
    }
    let weight = number_or_nan(property_or_undefined(object, "weight"));
    let base = property_or_undefined(object, "base");
    let scale_value = property_or_undefined(object, "scale");
    let padding = number_or_nan(property_or_undefined(object, "padding"));
    let precision = property_or_undefined(object, "precision");
    let range_values = match range {
        JsValue::Array(values) if truthy(range) => Some(values.as_slice()),
        _ => None,
    };
    let numeric_range_invalid = range_values.is_some_and(|values| {
        let left = number_or_nan(&values[0]);
        let right = number_or_nan(&values[1]);
        !left.is_finite()
            || !right.is_finite()
            || left >= right
            || string_value(scale_value).is_some_and(|scale| text_is(scale, "log")) && left <= 0.0
    });
    let numeric_invalid = !weight.is_finite()
        || weight <= 0.0
        || defined(base) && !matches!(base, JsValue::Number(value) if value.is_finite())
        || !string_value(scale_value).is_some_and(|scale| {
            ["linear", "log", "percent"]
                .iter()
                .any(|candidate| text_is(scale, candidate))
        })
        || !padding.is_finite()
        || !(0.0..=1.0).contains(&padding)
        || defined(precision)
            && !matches!(precision, JsValue::Number(value) if value.is_finite() && value.fract() == 0.0 && (0.0..=18.0).contains(value))
        || numeric_range_invalid
        || string_value(scale_value).is_some_and(|scale| text_is(scale, "percent"))
            && matches!(base, JsValue::Number(value) if *value == 0.0);
    if numeric_invalid {
        return Err(range_error("Panel scale/range"));
    }
    let JsValue::Bool(inverted) = inverted else {
        unreachable!("inverted checked above")
    };
    Ok(PanelFields {
        weight,
        scale: string_value(scale_value)
            .expect("scale checked above")
            .clone(),
        inverted: *inverted,
        padding,
        axis_visible: !matches!(axis_visible, JsValue::Bool(false)),
        axis_side: match string_value(axis_side) {
            Some(value) if defined(axis_side) => value.clone(),
            _ => JsString::from_str("right"),
        },
    })
}

fn validate_axis_record(record: &JsValue, panels: &[Panel]) -> Result<Axis, JsError> {
    option_record(record, AXIS_KEYS, "Axis")?;
    let object = object_ref(record, "Axis: object required")?;
    let id = identifier_field(object, "id", "Axis id")?;
    let panel = identifier_field(object, "panel", "Axis panel")?;
    if !panels.iter().any(|candidate| candidate.id == panel) {
        return Err(error("Missing axis panel"));
    }
    let mut inherited = JsObject::new();
    for (key, value) in [
        ("weight", JsValue::Number(1.0)),
        ("scale", string("linear")),
        ("inverted", JsValue::Bool(false)),
        ("padding", JsValue::Number(0.08)),
    ] {
        inherited.insert(JsString::from_str(key), value);
    }
    for key in [
        "scale",
        "inverted",
        "padding",
        "range",
        "base",
        "precision",
        "formatter",
        "label",
    ] {
        let value = property_or_undefined(object, key);
        if defined(value) {
            inherited.insert(JsString::from_str(key), value.clone());
        }
    }
    validate_panel_fields(&inherited)?;
    let side = property_or_undefined(object, "side");
    let visible = property_or_undefined(object, "visible");
    let tick_format = property_or_undefined(object, "tickFormat");
    let width = property_or_undefined(object, "width");
    if !string_value(side).is_some_and(|value| text_is(value, "left") || text_is(value, "right"))
        || !matches!(visible, JsValue::Bool(_))
        || !string_value(tick_format)
            .is_some_and(|value| text_is(value, "fixed") || text_is(value, "scientific"))
        || defined(width)
            && !matches!(width, JsValue::Number(value) if value.is_finite() && (20.0..=256.0).contains(value))
    {
        return Err(type_error("Axis side/visibility/format/width"));
    }
    for (key, label) in [("prefix", "Axis prefix"), ("suffix", "Axis suffix")] {
        let value = property_or_undefined(object, key);
        if defined(value) {
            bounded_text(value, 64, label, true)?;
        }
    }
    let scale = property_or_undefined(object, "scale");
    let base = property_or_undefined(object, "base");
    if string_value(scale).is_some_and(|scale| text_is(scale, "percent"))
        && !matches!(base, JsValue::Number(value) if value.is_finite() && *value != 0.0)
    {
        return Err(range_error(
            "Independent percent axis requires an explicit nonzero base",
        ));
    }
    let JsValue::Bool(visible) = visible else {
        unreachable!("visible checked above")
    };
    Ok(Axis {
        record: ordered_record(record, AXIS_KEYS)?,
        id,
        panel,
        side: string_value(side).expect("side checked above").clone(),
        visible: *visible,
        width: match width {
            JsValue::Number(value) => Some(*value),
            _ => None,
        },
    })
}

fn model_options(options: &JsValue) -> Result<JsObject, JsError> {
    match options {
        JsValue::Object(object) => Ok(object.clone()),
        JsValue::Undefined | JsValue::Bool(_) | JsValue::Number(_) | JsValue::String(_) => {
            Ok(JsObject::new())
        }
        JsValue::Null => Err(type_error("Model options object required")),
        JsValue::Array(_) => Ok(JsObject::new()),
    }
}

fn theme_value_reference_identities(
    theme: &JsValue,
) -> [Option<Arc<()>>; FRAME_THEME_REFERENCE_KEYS.len()] {
    std::array::from_fn(|index| {
        let JsValue::Object(theme) = theme else {
            return None;
        };
        theme
            .get(&JsString::from_str(FRAME_THEME_REFERENCE_KEYS[index]))
            .is_some_and(|value| matches!(value, JsValue::Object(_) | JsValue::Array(_)))
            .then(|| Arc::new(()))
    })
}

fn theme(value: &JsValue) -> Result<JsValue, JsError> {
    option_record(value, THEME_KEYS, "Theme")?;
    let object = object_ref(value, "Theme: object required")?;
    for (_, value) in object.iter() {
        bounded_text(value, 256, "Theme value", false)?;
    }
    let defaults: Vec<(&str, JsValue)> = DEFAULT_THEME
        .iter()
        .map(|(key, value)| (*key, string(value)))
        .collect();
    defaulted_record(&defaults, value, THEME_KEYS)
}

fn js_string_heap_bytes(value: &JsString) -> usize {
    value.len_utf16().saturating_mul(size_of::<u16>())
}

fn reserve_legacy_theme_entry(scope: &mut MemoryScope) -> Result<(), JsError> {
    scope
        .try_grow(size_of::<(JsString, JsValue)>().saturating_add(size_of::<(JsString, usize)>()))
        .map_err(|failure| failure.into_js_error())
}

fn js_value_heap_bytes(value: &JsValue) -> usize {
    match value {
        JsValue::String(value) => js_string_heap_bytes(value),
        JsValue::Array(values) => values
            .capacity()
            .saturating_mul(size_of::<JsValue>())
            .saturating_add(values.iter().map(js_value_heap_bytes).sum()),
        JsValue::Object(object) => {
            let entries = object
                .len()
                .saturating_mul(size_of::<(JsString, JsValue)>());
            let lookup = if object.len() > 8 {
                object.len().saturating_mul(size_of::<(JsString, usize)>())
            } else {
                0
            };
            entries.saturating_add(lookup).saturating_add(
                object
                    .iter()
                    .map(|(key, value)| {
                        js_string_heap_bytes(key).saturating_add(js_value_heap_bytes(value))
                    })
                    .sum(),
            )
        }
        JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => 0,
    }
}

fn panel_heap_bytes(panel: &Panel) -> usize {
    js_value_heap_bytes(&panel.record)
        .saturating_add(js_string_heap_bytes(&panel.id))
        .saturating_add(js_string_heap_bytes(&panel.scale))
        .saturating_add(js_string_heap_bytes(&panel.axis_side))
}

fn retain_panel_with_memory(
    source: &Panel,
    memory: &MemoryContext,
) -> Result<(Panel, MemoryGroup), JsError> {
    let mut scope = memory.scope();
    let panel = Panel {
        record: source
            .record
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        id: source
            .id
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        weight: source.weight,
        scale: source
            .scale
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        inverted: source.inverted,
        padding: source.padding,
        axis_visible: source.axis_visible,
        axis_side: source
            .axis_side
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
    };
    let memory = scope
        .split_persistent(panel_heap_bytes(&panel))
        .map_err(|failure| failure.into_js_error())?;
    Ok((panel, memory))
}

fn axis_heap_bytes(axis: &Axis) -> usize {
    js_value_heap_bytes(&axis.record)
        .saturating_add(js_string_heap_bytes(&axis.id))
        .saturating_add(js_string_heap_bytes(&axis.panel))
        .saturating_add(js_string_heap_bytes(&axis.side))
}

fn retain_axis_with_memory(
    source: &Axis,
    memory: &MemoryContext,
) -> Result<(Axis, MemoryGroup), JsError> {
    let mut scope = memory.scope();
    let axis = Axis {
        record: source
            .record
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        id: source
            .id
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        panel: source
            .panel
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        side: source
            .side
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?,
        visible: source.visible,
        width: source.width,
    };
    let memory = scope
        .split_persistent(axis_heap_bytes(&axis))
        .map_err(|failure| failure.into_js_error())?;
    Ok((axis, memory))
}

fn series_parts_heap_bytes(
    record: &JsValue,
    id: &JsString,
    panel: &JsString,
    axis_id: Option<&JsString>,
    indicator: Option<&JsString>,
    output: Option<&JsString>,
) -> usize {
    js_value_heap_bytes(record)
        .saturating_add(js_string_heap_bytes(id))
        .saturating_add(js_string_heap_bytes(panel))
        .saturating_add(axis_id.map_or(0, js_string_heap_bytes))
        .saturating_add(indicator.map_or(0, js_string_heap_bytes))
        .saturating_add(output.map_or(0, js_string_heap_bytes))
}

fn external_values_memory(
    context: &MemoryContext,
    capacity: usize,
    memory: Option<MemoryGroup>,
) -> Result<MemoryGroup, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<f64>())
        .ok_or_else(|| context.allocation_failure().into_js_error())?;
    match memory {
        Some(memory)
            if context.shares_account(memory.context())
                && memory.requested_bytes() == bytes as u64 =>
        {
            Ok(memory)
        }
        Some(_) => Err(context.allocation_failure().into_js_error()),
        None => context
            .reserve_group(bytes)
            .map_err(|failure| failure.into_js_error()),
    }
}

fn prepare_push_capacity<T>(
    values: &[T],
    capacity: usize,
    memory: &MemoryContext,
) -> Result<Option<(Vec<T>, MemoryGroup)>, JsError> {
    if values.len() < capacity {
        return Ok(None);
    }
    let next = std::cmp::max(
        std::cmp::max(capacity, 1).saturating_mul(2),
        values.len() + 1,
    );
    memory
        .try_vec_capacity(next)
        .map(Some)
        .map_err(|failure| failure.into_js_error())
}

fn default_panels() -> JsValue {
    JsValue::Array(vec![object([
        ("id", string("price")),
        ("weight", JsValue::Number(3.0)),
    ])])
}

fn empty_array() -> JsValue {
    JsValue::Array(Vec::new())
}

fn empty_object() -> JsValue {
    JsValue::Object(JsObject::new())
}

fn defaulted_property(object: &JsObject, key: &str, default: impl FnOnce() -> JsValue) -> JsValue {
    match property(object, key) {
        None | Some(JsValue::Undefined) => default(),
        Some(value) => value.clone(),
    }
}

fn default_number(value: Option<&JsValue>, default: f64) -> f64 {
    match value {
        None | Some(JsValue::Undefined) => default,
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    }
}

fn nullish_number(value: Option<&JsValue>, default: f64) -> f64 {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => default,
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    }
}

fn defaulted_record(
    defaults: &[(&str, JsValue)],
    overlay: &JsValue,
    keys: &[&str],
) -> Result<JsValue, JsError> {
    let overlay = object_ref(overlay, "Object required")?;
    let mut output = JsObject::new();
    for (key, value) in defaults {
        output.insert(JsString::from_str(key), value.clone());
    }
    for (key, value) in overlay.iter() {
        output.insert(key.clone(), value.clone());
    }
    ordered_record(&JsValue::Object(output), keys)
}

fn merged_record(base: &JsValue, patch: &JsValue, keys: &[&str]) -> Result<JsValue, JsError> {
    let base = object_ref(base, "Object required")?;
    let patch = object_ref(patch, "Object required")?;
    let mut output = JsObject::new();
    for (key, value) in base.iter().chain(patch.iter()) {
        output.insert(key.clone(), value.clone());
    }
    ordered_record(&JsValue::Object(output), keys)
}

fn merged_theme_record_scoped(
    base: &JsValue,
    patch: &JsValue,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let base = object_ref(base, "Object required")?;
    let patch = object_ref(patch, "Object required")?;
    let bytes = THEME_KEYS
        .len()
        .checked_mul(size_of::<(JsString, JsValue)>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(THEME_KEYS.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for name in THEME_KEYS {
        let lookup = JsString::from_str(name);
        let Some(value) = patch.get(&lookup).or_else(|| base.get(&lookup)) else {
            continue;
        };
        entries.push((
            JsString::try_from_str(name, scope).map_err(|failure| failure.into_js_error())?,
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ));
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())
}

fn axis_strip_widths(panels: &[Panel], axes: &[Axis], axis_width: f64) -> (f64, f64) {
    let mut left = 0.0_f64;
    let mut right = 0.0_f64;
    for panel in panels {
        let (mut row_left, mut row_right) = (0.0, 0.0);
        if panel.axis_visible {
            if text_is(&panel.axis_side, "left") {
                row_left = axis_width;
            } else {
                row_right = axis_width;
            }
        }
        for axis in axes
            .iter()
            .filter(|axis| axis.panel == panel.id && axis.visible)
        {
            let width = axis.width.unwrap_or(axis_width);
            if text_is(&axis.side, "left") {
                row_left += width;
            } else {
                row_right += width;
            }
        }
        left = js_max(&[left, row_left]);
        right = js_max(&[right, row_right]);
    }
    (left, right)
}

fn reject_layout_interaction(context: &ModelContext<'_>, required: bool) -> Result<(), JsError> {
    if required && (context.interaction.gesture_active || context.interaction.pointer_count > 0) {
        return Err(error("Panel layout change during active gesture"));
    }
    Ok(())
}

fn record_fields_changed(left: &JsValue, right: &JsValue, keys: &[&str]) -> bool {
    let (JsValue::Object(left), JsValue::Object(right)) = (left, right) else {
        return true;
    };
    keys.iter().any(|key| {
        !same_js_value(
            property_or_undefined(left, key),
            property_or_undefined(right, key),
        )
    })
}

fn same_js_value(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => same_value(*left, *right),
        (JsValue::String(left), JsValue::String(right)) => left == right,
        (JsValue::Array(left), JsValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_js_value(left, right))
        }
        (JsValue::Object(left), JsValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right.iter())
                    .all(|((left_key, left), (right_key, right))| {
                        left_key == right_key && same_js_value(left, right)
                    })
        }
        _ => false,
    }
}

fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(value) => *value,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

fn nullish(value: &JsValue) -> bool {
    matches!(value, JsValue::Undefined | JsValue::Null)
}

fn defined(value: &JsValue) -> bool {
    !matches!(value, JsValue::Undefined)
}

fn number_or_nan(value: &JsValue) -> f64 {
    match value {
        JsValue::Number(value) => *value,
        _ => f64::NAN,
    }
}

fn object_ref<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(object) => Ok(object),
        _ => Err(type_error(message)),
    }
}

fn property<'a>(object: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    object.get(&JsString::from_str(key))
}

fn property_or_undefined<'a>(object: &'a JsObject, key: &str) -> &'a JsValue {
    static UNDEFINED: JsValue = JsValue::Undefined;
    property(object, key).unwrap_or(&UNDEFINED)
}

fn identifier_field(object: &JsObject, key: &str, label: &str) -> Result<JsString, JsError> {
    Ok(identifier(property_or_undefined(object, key), label)?.clone())
}

fn string_value(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

fn optional_string(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        JsValue::Undefined | JsValue::Null => None,
        _ => None,
    }
}

fn text_is(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn string(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn object<const N: usize>(values: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in values {
        object.insert(JsString::from_str(key), value);
    }
    JsValue::Object(object)
}

fn error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn missing_indicator_error(
    value: &JsValue,
    store: &BarStore,
    scope: Option<&mut MemoryScope>,
) -> Result<JsError, JsError> {
    match scope {
        Some(scope) => missing_indicator_error_scoped(value, scope),
        None => {
            let mut scope = MemoryScope::unaccounted(store.memory_context().oom_style());
            missing_indicator_error_scoped(value, &mut scope)
        }
    }
}

fn missing_indicator_error_scoped(
    value: &JsValue,
    scope: &mut MemoryScope,
) -> Result<JsError, JsError> {
    let display = js_to_string_scoped(value, NumberDialect::PLATFORM, scope)?;
    let prefix = "Missing indicator: ";
    let length = prefix
        .encode_utf16()
        .count()
        .checked_add(display.len_utf16())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    let bytes = length
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut message = Vec::new();
    message
        .try_reserve_exact(length)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    message.extend(prefix.encode_utf16());
    message.extend_from_slice(display.as_units());
    Ok(JsError::new("Error", JsString::from_utf16(message)))
}

fn stale_error(message: &str) -> JsError {
    JsError::new("StaleSourceError", JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

#[cfg(test)]
mod native_ui_tests {
    use super::{ModelContext, ModelState};
    use crate::data::{Bar, ModelDataState, StoreOptions};
    use barochart_js::json::{JsObject, JsValue};
    use barochart_js::string::JsString;

    fn text(value: &str) -> JsValue {
        JsValue::String(JsString::from_str(value))
    }

    fn object(entries: &[(&str, JsValue)]) -> JsValue {
        let mut value = JsObject::new();
        for (name, item) in entries {
            value.insert(JsString::from_str(name), item.clone());
        }
        JsValue::Object(value)
    }

    #[test]
    fn native_ui_publish_preserves_external_value_allocation() {
        let bars = (0..3)
            .map(|index| Bar {
                time: index as f64 + 1.0,
                open: 10.0,
                high: 12.0,
                low: 8.0,
                close: 11.0,
                volume: 1.0,
            })
            .collect();
        let data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
        let store = data.store();
        let mut model = ModelState::new(store, &JsValue::Object(JsObject::new())).unwrap();
        model
            .add_series_with_values(
                &object(&[
                    ("id", text("external")),
                    ("type", text("line")),
                    ("panel", text("price")),
                ]),
                vec![1.0, 2.0, 3.0],
                &ModelContext::plain(store),
            )
            .unwrap();
        let pointer = model.series[0].values.as_ref().unwrap().as_ptr();
        let panels = JsValue::Array(
            model
                .panels
                .iter()
                .map(|panel| panel.to_js_value())
                .collect(),
        );
        let axes = JsValue::Array(model.axes.iter().map(|axis| axis.to_js_value()).collect());
        let patches = vec![model.series[0].to_js_value()];
        let stage = model
            .stage_native_ui(
                store,
                &panels,
                &axes,
                model.theme(),
                &patches,
                model.view,
                model.follow,
                model.axis_width,
                model.precision,
                &JsValue::Null,
                &ModelContext::plain(store),
            )
            .unwrap();
        model.publish_native_ui(stage);
        assert_eq!(model.series[0].values.as_ref().unwrap().as_ptr(), pointer);
    }
}
