//! Native frame의 base/drawing/layout 재사용과 hover-only 갱신을 관리한다.
//!
//! Root Engine은 token namespace와 lifecycle을 소유한다. 이 leaf는 token 하나의 최신 layer만
//! 보관하며 packet 경로가 빌릴 수 있는 command slice를 깊은 복사 없이 노출한다.

#![forbid(unsafe_code)]

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::string::JsString;

use crate::Host;
use crate::data::DataIdentity;
use crate::drawing_types::Drawing;
use crate::indicator_engine::IndicatorRenderEntryToken;
use crate::layout::Layout;
use crate::model_state::{ModelState, SeriesValuesReferenceToken, ThemeValueReferenceToken};
use crate::native_chart::{NativeChart, NativeFormatterIdentityToken};
use crate::scene::{OwnedScene, ResolvedCrosshair};
use crate::scene_parts::OwnedSceneCommands;

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}

/// Base/drawing/hover layer가 공유하는 immutable scene metadata다.
pub struct FrameMetadata {
    width: f64,
    height: f64,
    background: JsValue,
    layout: JsValue,
    base_stats: JsValue,
    memory: MemoryGroup,
}

impl FrameMetadata {
    fn from_owned_scene(scene: OwnedScene) -> Result<(Arc<Self>, Arc<OwnedCommands>), JsError> {
        let (mut scene, memory) = scene.into_parts();
        let JsValue::Object(scene) = &mut scene else {
            return Err(type_error("Native frame scene object"));
        };
        let width = match scene.remove(&key("width")) {
            Some(JsValue::Number(value)) => value,
            _ => return Err(type_error("Native frame scene width")),
        };
        let height = match scene.remove(&key("height")) {
            Some(JsValue::Number(value)) => value,
            _ => return Err(type_error("Native frame scene height")),
        };
        let background = scene
            .remove(&key("background"))
            .ok_or_else(|| type_error("Native frame scene background"))?;
        let mut commands = scene
            .remove(&key("commands"))
            .ok_or_else(|| type_error("Native frame scene commands"))?;
        let commands = match &mut commands {
            JsValue::Array(commands) => std::mem::take(commands),
            _ => return Err(type_error("Native frame scene commands")),
        };
        let layout = scene
            .remove(&key("layout"))
            .ok_or_else(|| type_error("Native frame scene layout"))?;
        let base_stats = scene
            .remove(&key("stats"))
            .ok_or_else(|| type_error("Native frame scene stats"))?;
        if scene.iter().next().is_some() {
            return Err(type_error("Native frame scene fields"));
        }
        Ok((
            Arc::new(Self {
                width,
                height,
                background,
                layout,
                base_stats,
                memory,
            }),
            Arc::new(OwnedCommands {
                values: commands,
                _memory: None,
            }),
        ))
    }

    /// CSS width다.
    pub fn width(&self) -> f64 {
        self.width
    }

    /// CSS height다.
    pub fn height(&self) -> f64 {
        self.height
    }

    /// opaque background 값이다.
    pub fn background(&self) -> &JsValue {
        &self.background
    }

    /// renderer-visible layout wire다.
    pub fn layout_value(&self) -> &JsValue {
        &self.layout
    }

    /// base layer 자체의 stats다.
    pub fn base_stats(&self) -> &JsValue {
        &self.base_stats
    }

    /// base scene metadata와 command DOM이 공유하는 requested bytes다.
    pub fn requested_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }
}

struct OwnedCommands {
    values: Vec<JsValue>,
    _memory: Option<MemoryGroup>,
}

/// Metadata를 공유하고 command allocation을 Arc로 소유하는 한 layer다.
pub struct FrameLayer {
    metadata: Arc<FrameMetadata>,
    commands: Arc<OwnedCommands>,
}

impl FrameLayer {
    /// Full base scene에서 command 배열을 move해 base layer를 만든다.
    pub fn from_base_scene(scene: JsValue) -> Result<Self, JsError> {
        let memory =
            MemoryGroup::empty(MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized));
        let (metadata, commands) =
            FrameMetadata::from_owned_scene(OwnedScene::from_parts(scene, memory))?;
        Ok(Self { metadata, commands })
    }

    /// Accounted full scene을 move해 base layer를 만든다.
    pub fn from_owned_base_scene(scene: OwnedScene) -> Result<Self, JsError> {
        let (metadata, commands) = FrameMetadata::from_owned_scene(scene)?;
        Ok(Self { metadata, commands })
    }

    /// 기존 base metadata를 공유하는 drawing/hover layer다.
    pub fn from_commands(metadata: Arc<FrameMetadata>, commands: Vec<JsValue>) -> Self {
        Self {
            metadata,
            commands: Arc::new(OwnedCommands {
                values: commands,
                _memory: None,
            }),
        }
    }

    /// Accounted command payload를 기존 metadata와 공유하는 layer로 만든다.
    pub fn from_owned_commands(metadata: Arc<FrameMetadata>, commands: OwnedSceneCommands) -> Self {
        let (values, memory) = commands.into_parts();
        Self {
            metadata,
            commands: Arc::new(OwnedCommands {
                values,
                _memory: Some(memory),
            }),
        }
    }

    /// 공유 metadata다.
    pub fn metadata(&self) -> &Arc<FrameMetadata> {
        &self.metadata
    }

    /// Packet encoder가 직접 빌리는 command slice다.
    pub fn commands(&self) -> &[JsValue] {
        &self.commands.values
    }

    /// JSON transport가 요청됐을 때만 layer tree를 materialize한다.
    pub fn to_js_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_js_value_scoped(&mut scope)
            .expect("unaccounted frame layer allocation failed")
    }

    /// JSON transport DOM을 caller scope에 fallible하게 materialize한다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut commands = try_vec_capacity(self.commands.values.len(), scope)?;
        for command in &self.commands.values {
            commands.push(clone_value(command, scope)?);
        }
        scoped_object(
            [
                ("width", JsValue::Number(self.metadata.width)),
                ("height", JsValue::Number(self.metadata.height)),
                ("background", clone_value(&self.metadata.background, scope)?),
                ("commands", JsValue::Array(commands)),
                ("layout", clone_value(&self.metadata.layout, scope)?),
                ("stats", clone_value(&self.metadata.base_stats, scope)?),
            ],
            scope,
        )
    }
}

struct OwnedFrameValue {
    value: JsValue,
    _memory: MemoryGroup,
}

fn stats_with_command_count(
    stats: &JsValue,
    command_count: usize,
    memory: &MemoryContext,
) -> Result<OwnedFrameValue, JsError> {
    let JsValue::Object(stats) = stats else {
        return Err(type_error("Native frame scene stats"));
    };
    let mut scope = memory.scope();
    let mut entries = try_vec_capacity(stats.len().saturating_add(1), &mut scope)?;
    for (name, value) in stats.iter() {
        entries.push((
            try_clone_string(name, &mut scope)?,
            clone_value(value, &mut scope)?,
        ));
    }
    entries.push((
        try_string("commandCount", &mut scope)?,
        JsValue::Number(command_count as f64),
    ));
    let value = JsObject::try_from_entries_scoped(entries, &mut scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())?;
    let requested = usize::try_from(scope.requested_bytes())
        .map_err(|_| memory.allocation_failure().into_js_error())?;
    let memory = scope
        .split_persistent(requested)
        .map_err(|failure| failure.into_js_error())?;
    Ok(OwnedFrameValue {
        value,
        _memory: memory,
    })
}

/// 한 frame call 동안 cache가 빌려주는 실제 layers/layout이다.
pub struct NativeFrame<'a> {
    pub base_changed: bool,
    pub drawings_changed: bool,
    pub base: &'a FrameLayer,
    pub drawings: &'a FrameLayer,
    pub hover: &'a FrameLayer,
    pub layout: &'a Layout,
    layout_owner: &'a Arc<Layout>,
    pub stats: &'a JsValue,
}

impl NativeFrame<'_> {
    /// Engine latest-layout가 기존 cache allocation을 그대로 보유한다.
    pub fn retain_layout(&self) -> Arc<Layout> {
        Arc::clone(self.layout_owner)
    }

    /// nativeRenderFrameJSON의 null-layer protocol을 materialize한다.
    pub fn to_js_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_js_value_scoped(&mut scope)
            .expect("unaccounted native frame allocation failed")
    }

    /// nativeRenderFrameJSON DOM을 caller scope에 fallible하게 materialize한다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        scoped_object(
            [
                ("width", JsValue::Number(self.base.metadata.width)),
                ("height", JsValue::Number(self.base.metadata.height)),
                (
                    "background",
                    clone_value(&self.base.metadata.background, scope)?,
                ),
                (
                    "base",
                    if self.base_changed {
                        self.base.to_js_value_scoped(scope)?
                    } else {
                        JsValue::Null
                    },
                ),
                (
                    "drawings",
                    if self.drawings_changed {
                        self.drawings.to_js_value_scoped(scope)?
                    } else {
                        JsValue::Null
                    },
                ),
                ("hover", self.hover.to_js_value_scoped(scope)?),
                ("stats", clone_value(self.stats, scope)?),
            ],
            scope,
        )
    }
}

pub type FrameCrosshairResolver<'a> =
    dyn FnMut(&mut NativeChart, &Layout) -> Result<Option<ResolvedCrosshair>, JsError> + 'a;

pub struct NativeFrameInput<'a> {
    pub chart: &'a mut NativeChart,
    pub host: &'a dyn Host,
    pub width: f64,
    pub height: f64,
    pub force_base: bool,
    pub resolve_crosshair: &'a mut FrameCrosshairResolver<'a>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum StaticScalar {
    Undefined,
    Null,
    Bool(bool),
    Number(u64),
    Nan,
    String(JsString),
    Reference,
}

impl StaticScalar {
    fn capture_scoped(value: Option<&JsValue>, scope: &mut MemoryScope) -> Result<Self, JsError> {
        match value {
            None | Some(JsValue::Undefined) => Ok(Self::Undefined),
            Some(JsValue::Null) => Ok(Self::Null),
            Some(JsValue::Bool(value)) => Ok(Self::Bool(*value)),
            Some(JsValue::Number(value)) if value.is_nan() => Ok(Self::Nan),
            Some(JsValue::Number(value)) => Ok(Self::Number(value.to_bits())),
            Some(JsValue::String(value)) => Ok(Self::String(try_clone_string(value, scope)?)),
            Some(JsValue::Array(_) | JsValue::Object(_)) => Ok(Self::Reference),
        }
    }
}

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn range_fields(value: &JsValue, scope: &mut MemoryScope) -> Result<[StaticScalar; 2], JsError> {
    match field(value, "range") {
        Some(JsValue::Array(values)) => Ok([
            StaticScalar::capture_scoped(values.first(), scope)?,
            StaticScalar::capture_scoped(values.get(1), scope)?,
        ]),
        _ => Ok([StaticScalar::Undefined, StaticScalar::Undefined]),
    }
}

struct ThemeStaticValue {
    key: &'static str,
    scalar: StaticScalar,
    reference: Option<ThemeValueReferenceToken>,
}

impl ThemeStaticValue {
    fn capture(
        model: &ModelState,
        name: &'static str,
        scope: &mut MemoryScope,
    ) -> Result<Self, JsError> {
        Ok(Self {
            key: name,
            scalar: StaticScalar::capture_scoped(field(model.theme(), name), scope)?,
            reference: model.capture_theme_value_reference(name),
        })
    }

    fn matches(&self, model: &ModelState, current: &Self) -> bool {
        self.scalar == current.scalar
            && match &self.reference {
                Some(reference) => model.validate_theme_value_reference(self.key, reference),
                None => current.reference.is_none(),
            }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PanelStaticKey(Vec<StaticScalar>);

impl PanelStaticKey {
    fn capture(value: &JsValue, scope: &mut MemoryScope) -> Result<Self, JsError> {
        let range = range_fields(value, scope)?;
        let mut fields = try_vec_capacity(13, scope)?;
        for name in ["id", "weight", "scale", "inverted", "padding"] {
            fields.push(StaticScalar::capture_scoped(field(value, name), scope)?);
        }
        fields.extend(range);
        for name in [
            "base",
            "precision",
            "label",
            "formatter",
            "axisVisible",
            "axisSide",
        ] {
            fields.push(StaticScalar::capture_scoped(field(value, name), scope)?);
        }
        Ok(Self(fields))
    }
}

#[derive(Debug, PartialEq, Eq)]
struct AxisStaticKey(Vec<StaticScalar>);

impl AxisStaticKey {
    fn capture(value: &JsValue, scope: &mut MemoryScope) -> Result<Self, JsError> {
        let range = range_fields(value, scope)?;
        let mut fields = try_vec_capacity(17, scope)?;
        for name in ["id", "panel", "side", "scale", "inverted", "padding"] {
            fields.push(StaticScalar::capture_scoped(field(value, name), scope)?);
        }
        fields.extend(range);
        for name in [
            "base",
            "precision",
            "tickFormat",
            "prefix",
            "suffix",
            "label",
            "visible",
            "width",
            "formatter",
        ] {
            fields.push(StaticScalar::capture_scoped(field(value, name), scope)?);
        }
        Ok(Self(fields))
    }
}

struct EntryStaticKey {
    token: IndicatorRenderEntryToken,
    revision: u64,
    dirty: usize,
    length: usize,
}

struct SeriesStaticKey {
    fields: Vec<StaticScalar>,
    has_values: bool,
    entry: Option<EntryStaticKey>,
}

impl SeriesStaticKey {
    fn capture(
        chart: &NativeChart,
        index: usize,
        scope: &mut MemoryScope,
    ) -> Result<Self, JsError> {
        let series = &chart.model().series[index];
        let raw = series.raw_record_ref();
        let mut fields = try_vec_capacity(18, scope)?;
        for name in ["id", "type", "panel", "visible", "offset"] {
            fields.push(StaticScalar::capture_scoped(field(raw, name), scope)?);
        }
        for name in [
            "source",
            "indicator",
            "output",
            "color",
            "upColor",
            "downColor",
            "fill",
            "width",
            "baseline",
        ] {
            fields.push(StaticScalar::capture_scoped(field(raw, name), scope)?);
        }
        fields.push(StaticScalar::Number(series.dirty_from.to_bits()));
        for name in ["axisId", "symbolId", "label"] {
            fields.push(StaticScalar::capture_scoped(field(raw, name), scope)?);
        }
        let entry = match series.indicator.as_ref() {
            Some(id) => {
                let id_value = JsValue::String(try_clone_string(id, scope)?);
                chart.indicators().entry(&id_value).and_then(|view| {
                    Some(EntryStaticKey {
                        token: chart.indicators().capture_render_entry(id)?,
                        revision: view.revision().to_bits(),
                        dirty: view.dirty(),
                        length: view.length(),
                    })
                })
            }
            None => None,
        };
        Ok(Self {
            fields,
            has_values: series.values.is_some(),
            entry,
        })
    }

    fn matches(&self, chart: &NativeChart, current: &Self) -> bool {
        if self.fields != current.fields || self.has_values != current.has_values {
            return false;
        }
        match (&self.entry, &current.entry) {
            (None, None) => true,
            (Some(expected), Some(actual)) => {
                expected.revision == actual.revision
                    && expected.dirty == actual.dirty
                    && expected.length == actual.length
                    && chart.indicators().validate_render_entry(&expected.token)
            }
            _ => false,
        }
    }
}

struct FrameStaticKey {
    width: u64,
    height: u64,
    store: DataIdentity,
    version: u64,
    length: usize,
    time_version: u64,
    view_from: u64,
    view_to: u64,
    axis_width: u64,
    precision: u8,
    formatter: NativeFormatterIdentityToken,
    theme: Vec<ThemeStaticValue>,
    panels: Vec<PanelStaticKey>,
    axes: Vec<AxisStaticKey>,
    series_values: SeriesValuesReferenceToken,
    series: Vec<SeriesStaticKey>,
    _memory: MemoryGroup,
}

impl FrameStaticKey {
    fn capture(
        chart: &NativeChart,
        width: f64,
        height: f64,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let mut scope = memory.scope();
        let model = chart.model();
        let store = chart.data().store();
        let mut theme = try_vec_capacity(6, &mut scope)?;
        for name in ["background", "grid", "text", "up", "down", "font"] {
            theme.push(ThemeStaticValue::capture(model, name, &mut scope)?);
        }
        let mut panels = try_vec_capacity(model.panels.len(), &mut scope)?;
        for panel in &model.panels {
            panels.push(PanelStaticKey::capture(panel.raw_record(), &mut scope)?);
        }
        let mut axes = try_vec_capacity(model.axes.len(), &mut scope)?;
        for axis in &model.axes {
            axes.push(AxisStaticKey::capture(axis.raw_record(), &mut scope)?);
        }
        let mut series = try_vec_capacity(model.series.len(), &mut scope)?;
        for index in 0..model.series.len() {
            series.push(SeriesStaticKey::capture(chart, index, &mut scope)?);
        }
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        let key_memory = scope
            .split_persistent(requested)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self {
            width: width.to_bits(),
            height: height.to_bits(),
            store: store.data_identity(),
            version: store.version().to_bits(),
            length: store.length(),
            time_version: store.time_version().to_bits(),
            view_from: model.view.from.to_bits(),
            view_to: model.view.to.to_bits(),
            axis_width: model.axis_width.to_bits(),
            precision: model.precision,
            formatter: chart.capture_formatter_identity(),
            theme,
            panels,
            axes,
            series_values: model.capture_series_values_reference(),
            series,
            _memory: key_memory,
        })
    }

    fn matches(&self, chart: &NativeChart, current: &Self) -> bool {
        let model = chart.model();
        let store = chart.data().store();
        self.width == current.width
            && self.height == current.height
            // JS keys the store object itself. Column-owner replacement is observed through
            // store versions and must not become an extra identity dependency here.
            && self.store.same_store(&store.data_identity())
            && self.version == current.version
            && self.length == current.length
            && self.time_version == current.time_version
            && self.view_from == current.view_from
            && self.view_to == current.view_to
            && self.axis_width == current.axis_width
            && self.precision == current.precision
            && chart.validate_formatter_identity(&self.formatter)
            && self.theme.len() == current.theme.len()
            && self
                .theme
                .iter()
                .zip(&current.theme)
                .all(|(expected, actual)| expected.matches(model, actual))
            && self.panels == current.panels
            && self.axes == current.axes
            && model.validate_series_values_reference(&self.series_values)
            && self.series.len() == current.series.len()
            && self
                .series
                .iter()
                .zip(&current.series)
                .all(|(expected, actual)| expected.matches(chart, actual))
    }
}

struct DrawingStaticKey {
    items: Vec<Arc<Drawing>>,
    selected: Option<JsString>,
    _memory: MemoryGroup,
}

impl DrawingStaticKey {
    fn capture(chart: &NativeChart, memory: &MemoryContext) -> Result<Self, JsError> {
        let mut scope = memory.scope();
        let mut items = try_vec_capacity(chart.drawings().items().len(), &mut scope)?;
        items.extend(chart.drawings().items().iter().map(Arc::clone));
        let selected = chart
            .drawings()
            .selected()
            .map(|value| try_clone_string(value, &mut scope))
            .transpose()?;
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        let key_memory = scope
            .split_persistent(requested)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self {
            items,
            selected,
            _memory: key_memory,
        })
    }

    fn matches(&self, chart: &NativeChart) -> bool {
        self.selected.as_ref() == chart.drawings().selected()
            && self.items.len() == chart.drawings().items().len()
            && self
                .items
                .iter()
                .zip(chart.drawings().items())
                .all(|(expected, actual)| Arc::ptr_eq(expected, actual))
    }
}

/// Token 하나의 latest base/drawing/layout만 보관하는 cache다.
pub struct NativeFrameCache {
    memory: MemoryContext,
    base: Option<Arc<FrameLayer>>,
    drawings: Option<Arc<FrameLayer>>,
    hover: Option<FrameLayer>,
    layout: Option<Arc<Layout>>,
    key: Option<FrameStaticKey>,
    drawing_key: Option<DrawingStaticKey>,
    stats: Option<OwnedFrameValue>,
}

impl Default for NativeFrameCache {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeFrameCache {
    /// 빈 cache다.
    pub fn new() -> Self {
        Self::new_with_memory(MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized))
    }

    /// 지정한 엔진 account에 retained frame payload를 연결한 빈 cache다.
    pub fn new_with_memory(memory: MemoryContext) -> Self {
        Self {
            memory,
            base: None,
            drawings: None,
            hover: None,
            layout: None,
            key: None,
            drawing_key: None,
            stats: None,
        }
    }

    /// 이 cache의 persistent allocation context다.
    pub fn memory_context(&self) -> &MemoryContext {
        &self.memory
    }

    /// 모든 retained layer/layout/key 참조를 놓는다.
    pub fn clear(&mut self) {
        self.base = None;
        self.drawings = None;
        self.hover = None;
        self.layout = None;
        self.key = None;
        self.drawing_key = None;
        self.stats = None;
    }

    /// 실제 base/drawing/layout cache와 transient resolver로 한 frame을 만든다.
    pub fn frame<'cache>(
        &'cache mut self,
        input: NativeFrameInput<'_>,
    ) -> Result<NativeFrame<'cache>, JsError> {
        let NativeFrameInput {
            chart,
            host,
            width,
            height,
            force_base,
            resolve_crosshair,
        } = input;
        let before = FrameStaticKey::capture(chart, width, height, &self.memory)?;
        let base_changed = force_base
            || self
                .key
                .as_ref()
                .is_none_or(|key| !key.matches(chart, &before));
        drop(before);
        let (base, layout) = if base_changed {
            let (layout, scene) = chart.build_frame_base(host, width, height)?;
            (
                Arc::new(FrameLayer::from_owned_base_scene(scene)?),
                Arc::new(layout),
            )
        } else {
            (
                Arc::clone(self.base.as_ref().expect("valid frame key has base")),
                Arc::clone(self.layout.as_ref().expect("valid frame key has layout")),
            )
        };
        let key = if base_changed {
            Some(FrameStaticKey::capture(chart, width, height, &self.memory)?)
        } else {
            None
        };
        let drawings_changed = base_changed
            || self
                .drawing_key
                .as_ref()
                .is_none_or(|key| !key.matches(chart));
        let drawings = if drawings_changed {
            Arc::new(FrameLayer::from_owned_commands(
                Arc::clone(base.metadata()),
                chart.build_frame_drawings(&layout)?,
            ))
        } else {
            Arc::clone(self.drawings.as_ref().expect("valid drawing key has layer"))
        };
        let drawing_key = if drawings_changed {
            Some(DrawingStaticKey::capture(chart, &self.memory)?)
        } else {
            None
        };
        let resolved = resolve_crosshair(chart, &layout)?;
        let hover = FrameLayer::from_owned_commands(
            Arc::clone(base.metadata()),
            chart.build_frame_hover(&layout, resolved.as_ref())?,
        );
        let command_count =
            base.commands().len() + drawings.commands().len() + hover.commands().len();
        let stats =
            stats_with_command_count(base.metadata().base_stats(), command_count, &self.memory)?;
        // JS commits only after every builder/resolver succeeds. A rebuilt base captures lazy
        // indicator/range work immediately after that build; a reused base keeps its prior key so
        // resolver mutation invalidates the next frame instead of relabeling stale base commands.
        self.base = Some(base);
        self.drawings = Some(drawings);
        self.hover = Some(hover);
        self.layout = Some(layout);
        if let Some(key) = key {
            self.key = Some(key);
        }
        if let Some(drawing_key) = drawing_key {
            self.drawing_key = Some(drawing_key);
        }
        self.stats = Some(stats);
        Ok(self.borrowed(base_changed, drawings_changed))
    }

    fn borrowed(&self, base_changed: bool, drawings_changed: bool) -> NativeFrame<'_> {
        NativeFrame {
            base_changed,
            drawings_changed,
            base: self.base.as_deref().expect("frame base committed"),
            drawings: self.drawings.as_deref().expect("frame drawings committed"),
            hover: self.hover.as_ref().expect("frame hover committed"),
            layout: self.layout.as_deref().expect("frame layout committed"),
            layout_owner: self.layout.as_ref().expect("frame layout committed"),
            stats: &self.stats.as_ref().expect("frame stats committed").value,
        }
    }
}

fn try_vec_capacity<T>(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
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

fn try_string(value: &str, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    JsString::try_from_str(value, scope).map_err(|failure| failure.into_js_error())
}

fn try_clone_string(value: &JsString, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    value
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())
}

fn clone_value(value: &JsValue, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    value
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())
}

fn scoped_object<const N: usize>(
    entries: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut output = try_vec_capacity(N, scope)?;
    for (name, value) in entries {
        output.push((try_string(name, scope)?, value));
    }
    JsObject::try_from_entries_scoped(output, scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())
}
