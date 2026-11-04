//! Renderer-neutral scene display-list generation over a completed real layout.

#![forbid(unsafe_code)]

use barochart_js::date::to_iso_string;
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::{JsString, is_js_whitespace};

use crate::Host;
use crate::axis_scale::AxisScaleKind;
use crate::contracts::{js_to_string_scoped, portable_color};
use crate::data::{AggregateBar, BarStore};
use crate::drawing_geometry::{DrawingAxisView, DrawingGeometryCache, DrawingProjection};
use crate::drawings::DrawingStore;
use crate::labels::{LabelCommandInput, label_metrics_scoped, label_width};
use crate::layout::{Layout, LayoutAxis, LayoutPanel};
use crate::markets::{Symbol, zoned_parts};
use crate::model_state::{ModelState, Series, SeriesKind, VisibleRange};
use crate::range_index::{RangeIndex, RangeQuery};
use crate::scene_parts::{
    AxisFormatInput, AxisTickFormat, DrawingCommandInput, OwnedSceneCommands, SceneTheme,
    aggregate_volume_series, create_drawing_commands_scoped, format_axis_value_scoped,
};
use crate::series_cache::SeriesCaches;

/// Scene-visible immutable axis fields from the real layout.
pub trait SceneAxisView: DrawingAxisView {
    fn id(&self) -> &JsString;
    fn axis_id(&self) -> Option<&JsString>;
    fn visible(&self) -> bool;
    fn label(&self) -> Option<&JsString>;
    fn precision(&self) -> Option<u32>;
    fn tick_format(&self) -> AxisTickFormat;
    fn prefix(&self) -> Option<&JsString>;
    fn suffix(&self) -> Option<&JsString>;
    fn scale_kind(&self) -> AxisScaleKind;
    fn axis_left(&self) -> f64;
    fn axis_right(&self) -> f64;
}

/// Scene-visible panel fields from the real layout.
pub trait ScenePanelView {
    type Axis: SceneAxisView;
    fn id(&self) -> &JsString;
    fn left(&self) -> f64;
    fn right(&self) -> f64;
    fn top(&self) -> f64;
    fn bottom(&self) -> f64;
    fn axes(&self) -> &[Self::Axis];
}

/// Real layout boundary used by scene generation. Live view/store arguments stay explicit.
pub trait SceneProjection: DrawingProjection
where
    Self::Axis: SceneAxisView,
{
    type Panel: ScenePanelView<Axis = Self::Axis>;
    fn panels(&self) -> &[Self::Panel];
    fn axis(&self, panel_id: &JsString, axis_id: Option<&JsString>) -> Option<&Self::Axis>;
    fn x(&self, current_view: VisibleRange, index: f64) -> f64;
    fn source_from(&self) -> f64;
    fn source_to(&self) -> f64;
    fn to_js_value(&self) -> JsValue;
    fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        self.to_js_value()
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())
    }
}

impl DrawingAxisView for LayoutAxis {
    fn left(&self) -> f64 {
        self.left
    }
    fn right(&self) -> f64 {
        self.right
    }
    fn top(&self) -> f64 {
        self.top
    }
    fn bottom(&self) -> f64 {
        self.bottom
    }
    fn scale(&self) -> &crate::axis_scale::AxisScale {
        &self.scale
    }
}

impl SceneAxisView for LayoutAxis {
    fn id(&self) -> &JsString {
        &self.id
    }
    fn axis_id(&self) -> Option<&JsString> {
        self.axis_id.as_ref()
    }
    fn visible(&self) -> bool {
        self.visible
    }
    fn label(&self) -> Option<&JsString> {
        self.label.as_ref()
    }
    fn precision(&self) -> Option<u32> {
        self.precision.map(u32::from)
    }
    fn tick_format(&self) -> AxisTickFormat {
        if self
            .tick_format
            .as_ref()
            .is_some_and(|value| text_eq(value, "scientific"))
        {
            AxisTickFormat::Scientific
        } else {
            AxisTickFormat::Fixed
        }
    }
    fn prefix(&self) -> Option<&JsString> {
        self.prefix.as_ref()
    }
    fn suffix(&self) -> Option<&JsString> {
        self.suffix.as_ref()
    }
    fn scale_kind(&self) -> AxisScaleKind {
        if text_eq(&self.scale_name, "log") {
            AxisScaleKind::Log
        } else if text_eq(&self.scale_name, "percent") {
            AxisScaleKind::Percent
        } else {
            AxisScaleKind::Linear
        }
    }
    fn axis_left(&self) -> f64 {
        self.axis_left
    }
    fn axis_right(&self) -> f64 {
        self.axis_right
    }
}

impl ScenePanelView for LayoutPanel {
    type Axis = LayoutAxis;
    fn id(&self) -> &JsString {
        &self.id
    }
    fn left(&self) -> f64 {
        self.left
    }
    fn right(&self) -> f64 {
        self.right
    }
    fn top(&self) -> f64 {
        self.top
    }
    fn bottom(&self) -> f64 {
        self.bottom
    }
    fn axes(&self) -> &[Self::Axis] {
        &self.axes
    }
}

impl DrawingProjection for Layout {
    type Axis = LayoutAxis;
    fn geometry_key(&self) -> &JsString {
        Layout::geometry_key(self)
    }
    fn geometry_font(&self) -> &JsValue {
        Layout::geometry_font(self)
    }
    fn drawing_axis(
        &self,
        model: &ModelState,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
        series_id: Option<&JsString>,
    ) -> Option<&Self::Axis> {
        Layout::drawing_axis(self, model, panel_id, axis_id, series_id)
    }
    fn to_screen(
        &self,
        view: VisibleRange,
        store: &BarStore,
        time: f64,
        price: f64,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
    ) -> crate::drawing_geometry::ScreenPoint {
        let point = Layout::to_screen(self, view, store, time, price, panel_id, axis_id);
        crate::drawing_geometry::ScreenPoint {
            x: point.x,
            y: point.y,
        }
    }
    fn index(&self, view: VisibleRange, screen_x: f64) -> f64 {
        Layout::index(self, view, screen_x)
    }
}

impl SceneProjection for Layout {
    type Panel = LayoutPanel;
    fn panels(&self) -> &[Self::Panel] {
        &self.panels
    }
    fn axis(&self, panel_id: &JsString, axis_id: Option<&JsString>) -> Option<&Self::Axis> {
        Layout::axis(self, panel_id, axis_id)
    }
    fn x(&self, view: VisibleRange, index: f64) -> f64 {
        Layout::x(self, view, index)
    }
    fn source_from(&self) -> f64 {
        self.from
    }
    fn source_to(&self) -> f64 {
        self.to
    }
    fn to_js_value(&self) -> JsValue {
        Layout::to_js_value(self)
    }
    fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        Layout::to_js_value_scoped(self, scope)
    }
}

/// Range query surface already prepared by per-chart `SeriesCaches`.
pub trait SeriesRangeView {
    fn query(&self, start: usize, end: usize) -> Result<RangeQuery, JsError>;
    fn finite_count(&self, start: usize, end: usize) -> Result<usize, JsError>;
    fn has_gaps(&self, start: usize, end: usize) -> Result<bool, JsError>;
}

impl SeriesRangeView for RangeIndex {
    fn query(&self, start: usize, end: usize) -> Result<RangeQuery, JsError> {
        RangeIndex::query(self, start, end)
    }
    fn finite_count(&self, start: usize, end: usize) -> Result<usize, JsError> {
        RangeIndex::finite_count(self, start, end)
    }
    fn has_gaps(&self, start: usize, end: usize) -> Result<bool, JsError> {
        RangeIndex::has_gaps(self, start, end)
    }
}

/// Read-only adapter over one prepared per-chart `SeriesCaches` entry.
pub struct CachedSeriesRange<'a> {
    pub caches: &'a SeriesCaches,
    pub series_id: &'a JsString,
    pub values: &'a [f64],
}

impl SeriesRangeView for CachedSeriesRange<'_> {
    fn query(&self, start: usize, end: usize) -> Result<RangeQuery, JsError> {
        self.caches.query(self.series_id, self.values, start, end)
    }
    fn finite_count(&self, start: usize, end: usize) -> Result<usize, JsError> {
        self.caches
            .finite_count(self.series_id, self.values, start, end)
    }
    fn has_gaps(&self, start: usize, end: usize) -> Result<bool, JsError> {
        self.caches
            .has_gaps(self.series_id, self.values, start, end)
    }
}

/// One model series and its post-calculation borrowed value/index projection.
pub struct SeriesRenderInput<'a> {
    pub series: &'a Series,
    pub values: Option<&'a [f64]>,
    pub range: Option<&'a dyn SeriesRangeView>,
}

/// M5 resolves snapping; scene rendering consumes only this immutable result.
#[derive(Clone, Debug)]
pub struct ResolvedCrosshair {
    pub x: f64,
    pub y: f64,
    pub panel: JsString,
    pub snapped: bool,
    pub axis_id: Option<JsString>,
    pub price: Option<f64>,
}

/// Complete short-lived inputs for one scene build.
pub struct SceneInput<'a, P: SceneProjection>
where
    P::Axis: SceneAxisView,
{
    pub model: &'a ModelState,
    pub store: &'a BarStore,
    pub layout: &'a P,
    pub series: &'a [SeriesRenderInput<'a>],
    pub theme: &'a SceneTheme,
    pub symbol: Option<&'a Symbol>,
    pub host: &'a dyn Host,
    pub drawings: Option<&'a DrawingStore>,
    pub drawing_cache: &'a mut DrawingGeometryCache,
    pub resolved_crosshair: Option<&'a ResolvedCrosshair>,
    pub width: f64,
    pub height: f64,
    pub include_drawings: bool,
    pub include_crosshair: bool,
    pub dialect: NumberDialect,
}

/// Retained scene DOM과 그 allocation lease다.
pub struct OwnedScene {
    value: JsValue,
    memory: MemoryGroup,
}

impl OwnedScene {
    pub(crate) fn from_parts(value: JsValue, memory: MemoryGroup) -> Self {
        Self { value, memory }
    }

    /// 이미 같은 scope에서 만든 scene과 모든 선행 clone의 lease를 retained owner로 옮긴다.
    pub fn from_scoped(value: JsValue, scope: &mut MemoryScope) -> Result<Self, JsError> {
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        let memory = scope
            .split_persistent(requested)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self { value, memory })
    }

    /// scene DOM을 빌린다.
    pub fn value(&self) -> &JsValue {
        &self.value
    }

    /// scene DOM과 lease를 상위 cache owner로 함께 이동한다.
    pub fn into_parts(self) -> (JsValue, MemoryGroup) {
        (self.value, self.memory)
    }

    /// scene DOM이 보유한 requested bytes다.
    pub fn requested_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }

    /// 별도 owned layer의 command allocation을 복제 없이 이 scene에 합친다.
    pub fn append_commands(&mut self, overlay: OwnedSceneCommands) -> Result<(), JsError> {
        let context = self.memory.context().clone();
        let (mut overlay, overlay_memory) = overlay.into_parts();
        let JsValue::Object(scene) = &mut self.value else {
            return Err(type_error("Owned scene object required"));
        };
        let Some(JsValue::Array(commands)) = scene.get_mut(&key("commands")) else {
            return Err(type_error("Owned scene commands required"));
        };
        let total = commands
            .len()
            .checked_add(overlay.len())
            .ok_or_else(|| context.allocation_failure().into_js_error())?;
        let old_capacity_bytes = commands
            .capacity()
            .checked_mul(std::mem::size_of::<JsValue>())
            .ok_or_else(|| context.allocation_failure().into_js_error())?;
        let overlay_capacity_bytes = overlay
            .capacity()
            .checked_mul(std::mem::size_of::<JsValue>())
            .ok_or_else(|| context.allocation_failure().into_js_error())?;
        if !context.shares_account(overlay_memory.context()) {
            return Err(context.allocation_failure().into_js_error());
        }
        let (mut merged, merged_memory) = context
            .try_vec_capacity(total)
            .map_err(|failure| failure.into_js_error())?;
        let final_requested = usize::try_from(self.memory.requested_bytes())
            .ok()
            .and_then(|scene| {
                usize::try_from(overlay_memory.requested_bytes())
                    .ok()
                    .and_then(|overlay| scene.checked_add(overlay))
            })
            .and_then(|both| {
                usize::try_from(merged_memory.requested_bytes())
                    .ok()
                    .and_then(|merged| both.checked_add(merged))
            })
            .and_then(|all| all.checked_sub(old_capacity_bytes))
            .and_then(|remaining| remaining.checked_sub(overlay_capacity_bytes))
            .ok_or_else(|| context.allocation_failure().into_js_error())?;

        // 이후에는 실패 가능한 연산이 없다. 두 source Vec와 lease를 한 publication으로 이동한다.
        merged.append(commands);
        merged.append(&mut overlay);
        self.memory
            .absorb(overlay_memory)
            .expect("validated scene layer account");
        self.memory
            .absorb(merged_memory)
            .expect("new command Vec uses the scene account");
        let command_count = merged.len();
        *commands = merged;
        self.memory
            .try_resize(final_requested)
            .expect("scene publication only shrinks retired Vec capacity");
        if let Some(JsValue::Object(stats)) = scene.get_mut(&key("stats"))
            && let Some(slot) = stats.get_mut(&key("commandCount"))
        {
            *slot = JsValue::Number(command_count as f64);
        }
        Ok(())
    }
}

/// Builds an ordered scene object after layout and lazy series caches are ready.
pub fn build_scene<P>(input: SceneInput<'_, P>) -> Result<JsValue, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    build_scene_scoped(input, &mut scope)
}

/// 지정한 엔진 account에 scene DOM과 lease를 함께 만든다.
pub fn build_scene_with_memory<P>(
    input: SceneInput<'_, P>,
    memory: &MemoryContext,
) -> Result<OwnedScene, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut scope = memory.scope();
    let mut temporary = memory.scope();
    let value = build_scene_internal(input, &mut scope, &mut temporary)?;
    OwnedScene::from_scoped(value, &mut scope)
}

/// 호출자가 serialization 또는 cache publication까지 유지하는 scope로 scene DOM을 만든다.
pub fn build_scene_scoped<P>(
    input: SceneInput<'_, P>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut temporary = MemoryScope::unaccounted(scope.allocation_failure().style());
    build_scene_internal(input, scope, &mut temporary)
}

/// caller output scope와 같은 엔진의 별도 temporary scope로 scene DOM을 만든다.
pub fn build_scene_scoped_with_memory<P>(
    input: SceneInput<'_, P>,
    scope: &mut MemoryScope,
    memory: &MemoryContext,
) -> Result<JsValue, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut temporary = memory.scope();
    build_scene_internal(input, scope, &mut temporary)
}

fn build_scene_internal<P>(
    input: SceneInput<'_, P>,
    scope: &mut MemoryScope,
    temporary: &mut MemoryScope,
) -> Result<JsValue, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let SceneInput {
        model,
        store,
        layout,
        series,
        theme,
        symbol,
        host,
        drawings,
        drawing_cache,
        resolved_crosshair,
        width,
        height,
        include_drawings,
        include_crosshair,
        dialect,
    } = input;
    let mut commands = Vec::new();
    if store.length() == 0 {
        let command = object(
            [
                ("op", text("text", scope)?),
                ("x", JsValue::Number(js_max(&[12.0, width / 2.0 - 60.0]))),
                ("y", JsValue::Number(height / 2.0)),
                ("text", text("No data", scope)?),
                ("color", clone_value(&theme.text, scope)?),
                ("font", clone_value(&theme.font, scope)?),
            ],
            scope,
        )?;
        push_command(&mut commands, command, scope)?;
        return scene_value(
            width,
            height,
            theme,
            commands,
            layout.to_js_value_scoped(scope)?,
            SceneStats {
                stored_bars: 0,
                visible_source_bars: 0.0,
                rendered_candle_buckets: 0,
            },
            scope,
        );
    }

    let first_panel = layout
        .panels()
        .first()
        .ok_or_else(|| type_error("Scene layout panel required"))?;
    let bucket_width = ((first_panel.right() - first_panel.left()) / 3.0).floor();
    let max_buckets = js_max(&[1.0, bucket_width]) as usize;
    let buckets = aggregate_scoped(
        store,
        layout.source_from(),
        layout.source_to(),
        max_buckets,
        temporary,
    )?;
    let metrics = label_metrics_scoped(&theme.font, dialect, temporary)?;
    let series_context = SeriesRenderContext {
        view: model.view,
        store,
        layout,
        buckets: &buckets,
        theme,
    };
    for panel in layout.panels() {
        let clip = numbers(
            &[
                panel.left(),
                panel.top(),
                panel.right() - panel.left(),
                panel.bottom() - panel.top(),
            ],
            scope,
        )?;
        let raw_ticks = ((panel.bottom() - panel.top()) / 40.0).floor();
        let price_ticks = js_max(&[1.0, js_min(&[4.0, raw_ticks])]) as usize;
        let grid_values = price_ticks
            .saturating_add(1)
            .saturating_add(6)
            .saturating_mul(4);
        let mut grid = try_vec_capacity(grid_values, temporary)?;
        for index in 0..=price_ticks {
            let y =
                panel.top() + index as f64 * (panel.bottom() - panel.top()) / price_ticks as f64;
            grid.extend([panel.left(), y, panel.right(), y]);
        }
        for index in 0..=5 {
            let x = panel.left() + (panel.right() - panel.left()) * index as f64 / 5.0;
            grid.extend([x, panel.top(), x, panel.bottom()]);
        }
        push_line(
            &mut commands,
            grid,
            clone_value(&theme.grid, scope)?,
            1.0,
            JsValue::Null,
            JsValue::Null,
            scope,
        )?;

        for axis in panel.axes().iter().filter(|axis| axis.visible()) {
            let axis_clip = numbers(
                &[
                    axis.axis_left(),
                    panel.top(),
                    axis.axis_right() - axis.axis_left(),
                    panel.bottom() - panel.top(),
                ],
                scope,
            )?;
            let x = axis.axis_left() + 4.0;
            let max_width = axis.axis_right() - x - 4.0;
            let has_title = axis
                .label()
                .is_some_and(|label| !label.as_units().is_empty())
                && panel.bottom() - panel.top() >= metrics.height * 2.0 + 12.0;
            let mut label_top = panel.top() + 4.0;
            if has_title {
                let metadata = axis_metadata("axis-title", panel.id(), axis.axis_id(), scope)?;
                push_label(
                    &mut commands,
                    LabelSpec {
                        value: axis.label().expect("title label exists"),
                        x,
                        y: label_top + metrics.ascent,
                        max_width,
                        font: &theme.font,
                        color: &theme.text,
                        clip: &axis_clip,
                        metadata: &metadata,
                        dialect,
                    },
                    scope,
                )?;
                label_top += metrics.height + 4.0;
            }
            let space = panel.bottom() - 4.0 - label_top;
            let count = js_max(&[
                0.0,
                js_min(&[5.0, ((space + 4.0) / (metrics.height + 4.0)).floor()]),
            ]) as usize;
            for index in 0..count {
                let top = label_top
                    + if count == 1 {
                        (space - metrics.height) / 2.0
                    } else {
                        index as f64 * (space - metrics.height) / (count - 1) as f64
                    };
                let y = top + metrics.ascent;
                let at = js_max(&[
                    panel.top(),
                    js_min(&[panel.bottom(), top + metrics.height / 2.0]),
                ]);
                let value = format_axis_value_scoped(
                    axis_format(axis, model.precision as u32, symbol),
                    axis.scale().price(at),
                    dialect,
                    temporary,
                )?;
                let metadata = axis_metadata("price-tick", panel.id(), axis.axis_id(), scope)?;
                push_label(
                    &mut commands,
                    LabelSpec {
                        value: &value,
                        x,
                        y,
                        max_width,
                        font: &theme.font,
                        color: &theme.text,
                        clip: &axis_clip,
                        metadata: &metadata,
                        dialect,
                    },
                    scope,
                )?;
            }
        }

        for entry in series
            .iter()
            .filter(|entry| entry.series.panel == *panel.id() && entry.series.visible)
        {
            let Some(axis) = layout.axis(panel.id(), entry.series.axis_id.as_ref()) else {
                continue;
            };
            render_series(
                &mut commands,
                entry,
                axis,
                panel,
                &series_context,
                scope,
                temporary,
            )?;
        }

        if panel.bottom() - panel.top() >= metrics.height + 8.0 {
            let panel_value = model
                .panels
                .iter()
                .find(|candidate| candidate.id == *panel.id())
                .map(|panel| {
                    panel
                        .to_js_value_scoped(temporary)
                        .map_err(|failure| failure.into_js_error())
                })
                .transpose()?
                .ok_or_else(|| type_error("Scene panel model required"))?;
            let mut series_values = try_vec_capacity(model.series.len(), temporary)?;
            for series in &model.series {
                series_values.push(
                    series
                        .to_js_value_scoped(temporary)
                        .map_err(|failure| failure.into_js_error())?,
                );
            }
            let title = panel_title_scoped(&panel_value, &series_values, dialect, temporary)?;
            let metadata = object(
                [
                    ("role", text("panel-title", scope)?),
                    (
                        "panelId",
                        JsValue::String(try_clone_string(panel.id(), scope)?),
                    ),
                ],
                scope,
            )?;
            let command = label_command_scoped(
                LabelCommandInput {
                    value: &JsValue::String(title),
                    x: panel.left() + 4.0,
                    y: panel.top() + 4.0 + metrics.ascent,
                    max_width: panel.right() - panel.left() - 8.0,
                    font: &theme.font,
                    color: &theme.text,
                    clip: &clip,
                    metadata: Some(&metadata),
                },
                dialect,
                scope,
            )?;
            if let JsValue::Object(command_record) = &command {
                let bounds = array_field(command_record, "labelBounds")?;
                let background = clone_value(&theme.background, scope)?;
                let command_background = clone_value(&theme.background, scope)?;
                let clip_value = clone_value(&clip, scope)?;
                let box_command = object(
                    [
                        ("op", text("box", scope)?),
                        ("x", JsValue::Number(panel.left())),
                        ("y", JsValue::Number(panel.top())),
                        ("w", JsValue::Number(number_at(bounds, 2)? + 8.0)),
                        ("h", JsValue::Number(metrics.height + 8.0)),
                        ("fill", background),
                        ("color", command_background),
                        ("width", JsValue::Number(0.0)),
                        ("clip", clip_value),
                    ],
                    scope,
                )?;
                push_command(&mut commands, box_command, scope)?;
                push_command(&mut commands, command, scope)?;
            }
        }
    }

    render_time_labels(
        &mut commands,
        TimeLabelContext {
            layout,
            view: model.view,
            store,
            theme,
            host,
            symbol,
            height,
            metrics,
            dialect,
        },
        scope,
        temporary,
    )?;
    if include_drawings && let Some(drawings) = drawings {
        let overlay = create_drawing_commands_scoped(
            DrawingCommandInput {
                model,
                store,
                drawings,
                current_view: model.view,
                layout,
                cache: drawing_cache,
                theme,
                dialect,
            },
            scope,
        )?;
        append_commands(&mut commands, overlay, scope)?;
    }
    if include_crosshair {
        let overlay = create_resolved_crosshair_commands_scoped(
            layout,
            resolved_crosshair,
            theme,
            model.precision as u32,
            symbol,
            dialect,
            scope,
        )?;
        append_commands(&mut commands, overlay, scope)?;
    }
    scene_value(
        width,
        height,
        theme,
        commands,
        layout.to_js_value_scoped(scope)?,
        SceneStats {
            stored_bars: store.length(),
            visible_source_bars: layout.source_to() - layout.source_from(),
            rendered_candle_buckets: buckets.len(),
        },
        scope,
    )
}

/// Projects an already-resolved M5 crosshair result into hover commands.
pub fn create_resolved_crosshair_commands<P>(
    layout: &P,
    resolved: Option<&ResolvedCrosshair>,
    theme: &SceneTheme,
    model_precision: u32,
    symbol: Option<&Symbol>,
    dialect: NumberDialect,
) -> Result<Vec<JsValue>, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    let mut temporary = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    create_resolved_crosshair_commands_internal(
        layout,
        resolved,
        theme,
        model_precision,
        symbol,
        dialect,
        &mut scope,
        &mut temporary,
    )
}

/// hover layer를 지정한 엔진 account에 연결한 owned payload로 만든다.
pub fn create_resolved_crosshair_commands_with_memory<P>(
    layout: &P,
    resolved: Option<&ResolvedCrosshair>,
    theme: &SceneTheme,
    model_precision: u32,
    symbol: Option<&Symbol>,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<OwnedSceneCommands, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut scope = memory.scope();
    let mut temporary = memory.scope();
    let commands = create_resolved_crosshair_commands_internal(
        layout,
        resolved,
        theme,
        model_precision,
        symbol,
        dialect,
        &mut scope,
        &mut temporary,
    )?;
    let requested = usize::try_from(scope.requested_bytes())
        .map_err(|_| memory.allocation_failure().into_js_error())?;
    let memory = scope
        .split_persistent(requested)
        .map_err(|failure| failure.into_js_error())?;
    Ok(OwnedSceneCommands::from_parts(commands, memory))
}

/// hover layer를 caller scope에 fallible하게 만든다.
pub fn create_resolved_crosshair_commands_scoped<P>(
    layout: &P,
    resolved: Option<&ResolvedCrosshair>,
    theme: &SceneTheme,
    model_precision: u32,
    symbol: Option<&Symbol>,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Vec<JsValue>, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let mut temporary = MemoryScope::unaccounted(scope.allocation_failure().style());
    create_resolved_crosshair_commands_internal(
        layout,
        resolved,
        theme,
        model_precision,
        symbol,
        dialect,
        scope,
        &mut temporary,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_resolved_crosshair_commands_internal<P>(
    layout: &P,
    resolved: Option<&ResolvedCrosshair>,
    theme: &SceneTheme,
    model_precision: u32,
    symbol: Option<&Symbol>,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
    temporary: &mut MemoryScope,
) -> Result<Vec<JsValue>, JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let Some(resolved) = resolved else {
        return Ok(Vec::new());
    };
    let Some(panel) = layout
        .panels()
        .iter()
        .find(|panel| panel.id() == &resolved.panel)
    else {
        return Ok(Vec::new());
    };
    let mut commands = Vec::new();
    for current in layout.panels() {
        push_line(
            &mut commands,
            f64_vec(
                &[resolved.x, current.top(), resolved.x, current.bottom()],
                temporary,
            )?,
            clone_value(&theme.crosshair, scope)?,
            1.0,
            JsValue::Null,
            numbers(&[4.0, 4.0], scope)?,
            scope,
        )?;
    }
    push_line(
        &mut commands,
        f64_vec(
            &[panel.left(), resolved.y, panel.right(), resolved.y],
            temporary,
        )?,
        clone_value(&theme.crosshair, scope)?,
        1.0,
        JsValue::Null,
        numbers(&[4.0, 4.0], scope)?,
        scope,
    )?;
    let metrics = label_metrics_scoped(&theme.font, dialect, temporary)?;
    let background = opaque_background(&theme.background, temporary)?;
    if panel.bottom() - panel.top() >= metrics.height + 8.0 {
        for axis in panel.axes().iter().filter(|axis| axis.visible()) {
            let clip = numbers(
                &[
                    axis.axis_left(),
                    panel.top(),
                    axis.axis_right() - axis.axis_left(),
                    panel.bottom() - panel.top(),
                ],
                scope,
            )?;
            let top = js_max(&[
                panel.top() + 4.0,
                js_min(&[
                    panel.bottom() - metrics.height - 4.0,
                    resolved.y - metrics.height / 2.0,
                ]),
            ]);
            let price = if resolved.snapped && resolved.axis_id.as_ref() == axis.axis_id() {
                resolved
                    .price
                    .ok_or_else(|| type_error("Resolved crosshair price required"))?
            } else {
                axis.scale().price(resolved.y)
            };
            let formatted = format_axis_value_scoped(
                axis_format(axis, model_precision, symbol),
                price,
                dialect,
                temporary,
            )?;
            let metadata = axis_metadata("crosshair-price", panel.id(), axis.axis_id(), scope)?;
            let label = label_command_scoped(
                LabelCommandInput {
                    value: &JsValue::String(formatted),
                    x: axis.axis_left() + 4.0,
                    y: top + metrics.ascent,
                    max_width: axis.axis_right() - axis.axis_left() - 8.0,
                    font: &theme.font,
                    color: &theme.crosshair,
                    clip: &clip,
                    metadata: Some(&metadata),
                },
                dialect,
                scope,
            )?;
            if !matches!(label, JsValue::Null) {
                let command = object(
                    [
                        ("op", text("box", scope)?),
                        ("x", JsValue::Number(axis.axis_left())),
                        ("y", JsValue::Number(top - 4.0)),
                        ("w", JsValue::Number(axis.axis_right() - axis.axis_left())),
                        ("h", JsValue::Number(metrics.height + 8.0)),
                        (
                            "fill",
                            JsValue::String(try_clone_string(&background, scope)?),
                        ),
                        (
                            "color",
                            JsValue::String(try_clone_string(&background, scope)?),
                        ),
                        ("width", JsValue::Number(0.0)),
                        ("clip", clone_value(&clip, scope)?),
                    ],
                    scope,
                )?;
                push_command(&mut commands, command, scope)?;
                push_command(&mut commands, label, scope)?;
            }
        }
    }
    Ok(commands)
}

struct SeriesRenderContext<'a, P: SceneProjection>
where
    P::Axis: SceneAxisView,
{
    view: VisibleRange,
    store: &'a BarStore,
    layout: &'a P,
    buckets: &'a [AggregateBar],
    theme: &'a SceneTheme,
}

fn render_series<P>(
    commands: &mut Vec<JsValue>,
    entry: &SeriesRenderInput<'_>,
    axis: &P::Axis,
    panel: &P::Panel,
    context: &SeriesRenderContext<'_, P>,
    scope: &mut MemoryScope,
    temporary: &mut MemoryScope,
) -> Result<(), JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let view = context.view;
    let store = context.store;
    let layout = context.layout;
    let buckets = context.buckets;
    let theme = context.theme;
    let series = entry.series;
    let record = series
        .to_js_value_scoped(temporary)
        .map_err(|failure| failure.into_js_error())?;
    let clip = numbers(
        &[
            panel.left(),
            panel.top(),
            panel.right() - panel.left(),
            panel.bottom() - panel.top(),
        ],
        scope,
    )?;
    let width = number_field(&record, "width").unwrap_or(1.0);
    if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc) {
        let line_values = buckets
            .len()
            .saturating_mul(if series.kind == SeriesKind::Ohlc {
                12
            } else {
                4
            });
        let rect_values = buckets.len().saturating_mul(4);
        let mut up_rects = try_vec_capacity(rect_values, temporary)?;
        let mut down_rects = try_vec_capacity(rect_values, temporary)?;
        let mut up_lines = try_vec_capacity(line_values, temporary)?;
        let mut down_lines = try_vec_capacity(line_values, temporary)?;
        for bucket in buckets {
            let x = layout.x(view, bucket.index);
            let candle_width = js_max(&[
                0.8,
                (layout.x(view, bucket.end as f64) - layout.x(view, bucket.start as f64)) * 0.72,
            ]);
            let up = bucket.close >= bucket.open;
            let lines = if up { &mut up_lines } else { &mut down_lines };
            lines.extend([
                x,
                axis.scale().y(bucket.high),
                x,
                axis.scale().y(bucket.low),
            ]);
            if series.kind == SeriesKind::Ohlc {
                lines.extend([
                    x - candle_width / 2.0,
                    axis.scale().y(bucket.open),
                    x,
                    axis.scale().y(bucket.open),
                    x,
                    axis.scale().y(bucket.close),
                    x + candle_width / 2.0,
                    axis.scale().y(bucket.close),
                ]);
            } else {
                let rectangles = if up { &mut up_rects } else { &mut down_rects };
                let open = axis.scale().y(bucket.open);
                let close = axis.scale().y(bucket.close);
                rectangles.extend([
                    x - candle_width / 2.0,
                    js_min(&[open, close]),
                    candle_width,
                    js_max(&[1.0, (open - close).abs()]),
                ]);
            }
        }
        let up_color = nullish_field(&record, "upColor")
            .unwrap_or(&theme.up)
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let down_color = nullish_field(&record, "downColor")
            .unwrap_or(&theme.down)
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        push_line(
            commands,
            up_lines,
            clone_value(&up_color, scope)?,
            width,
            clone_value(&clip, scope)?,
            JsValue::Null,
            scope,
        )?;
        push_line(
            commands,
            down_lines,
            clone_value(&down_color, scope)?,
            width,
            clone_value(&clip, scope)?,
            JsValue::Null,
            scope,
        )?;
        push_rects(
            commands,
            up_rects,
            up_color,
            clone_value(&clip, scope)?,
            scope,
        )?;
        push_rects(commands, down_rects, down_color, clip, scope)?;
        return Ok(());
    }
    if aggregate_volume_series(series) {
        let baseline = axis.scale().y(0.0);
        let mut rectangles = try_vec_capacity(buckets.len().saturating_mul(4), temporary)?;
        for bucket in buckets {
            let x = layout.x(view, bucket.index);
            let width = js_max(&[
                0.8,
                (layout.x(view, bucket.end as f64) - layout.x(view, bucket.start as f64)) * 0.72,
            ]);
            let value = axis.scale().y(bucket.volume);
            rectangles.extend([
                x - width / 2.0,
                js_min(&[baseline, value]),
                width,
                js_max(&[1.0, (baseline - value).abs()]),
            ]);
        }
        push_rects(
            commands,
            rectangles,
            match field(&record, "color") {
                Some(value) => clone_value(value, scope)?,
                None => JsValue::Undefined,
            },
            clip,
            scope,
        )?;
        return Ok(());
    }

    let values = entry
        .values
        .ok_or_else(|| type_error("Scene series values required"))?;
    let range = entry
        .range
        .ok_or_else(|| type_error("Scene series range index required"))?;
    let offset = series.offset;
    let start = clamp_floor(view.from - offset, store.length());
    let end = clamp_ceil(view.to + 1.0 - offset, store.length());
    let count = std::cmp::min(
        end.saturating_sub(start),
        std::cmp::max(1, (panel.right() - panel.left()).floor() as usize),
    );
    let gaps = range.has_gaps(start, end)?;
    let baseline = number_field(&record, "baseline").unwrap_or(0.0);
    let baseline_y = axis.scale().y(baseline);
    let color = match field(&record, "color") {
        Some(value) => clone_value(value, scope)?,
        None => JsValue::Undefined,
    };
    let fill = match nullish_field(&record, "fill") {
        Some(value) => clone_value(value, scope)?,
        None => text("#7898ff22", scope)?,
    };
    let visible_values = end.saturating_sub(start);
    let mut coordinates = try_vec_capacity(count.saturating_mul(4), temporary)?;
    let mut rectangles = try_vec_capacity(visible_values.saturating_mul(4), temporary)?;
    let mut paths = try_vec_capacity(count, temporary)?;
    let mut path = try_vec_capacity(visible_values.saturating_mul(2), temporary)?;
    for bucket in 0..count {
        let from = start + bucket * (end - start) / count;
        let to = start + (bucket + 1) * (end - start) / count;
        let value_end = std::cmp::min(to, values.len());
        let finite = if gaps {
            range.finite_count(from, value_end)?
        } else {
            value_end - from
        };
        if finite == 0 {
            flush_path(&mut path, &mut paths, &mut coordinates, temporary)?;
            continue;
        }
        if finite != value_end - from {
            let bar_width = js_max(&[
                1.0,
                (layout.x(view, from as f64 + 1.0) - layout.x(view, from as f64)).abs() * 0.8,
            ]);
            for (index, value) in values.iter().enumerate().take(value_end).skip(from) {
                if !value.is_finite() {
                    flush_path(&mut path, &mut paths, &mut coordinates, temporary)?;
                    continue;
                }
                let x = layout.x(view, index as f64 + offset);
                if series.kind == SeriesKind::Histogram {
                    histogram_rect(&mut rectangles, x, *value, bar_width, baseline_y, axis);
                } else {
                    path.extend([x, axis.scale().y(*value)]);
                }
            }
            continue;
        }
        let x = layout.x(view, (from + to - 1) as f64 / 2.0 + offset);
        let value = values[value_end - 1];
        if series.kind == SeriesKind::Histogram {
            histogram_rect(
                &mut rectangles,
                x,
                value,
                js_max(&[1.0, (panel.right() - panel.left()) / count as f64 * 0.8]),
                baseline_y,
                axis,
            );
        } else {
            path.extend([x, axis.scale().y(value)]);
            if to - from > 1 {
                let query = range.query(from, value_end)?;
                if query.max != query.min {
                    coordinates.extend([
                        x,
                        axis.scale().y(query.min),
                        x,
                        axis.scale().y(query.max),
                    ]);
                }
            }
        }
    }
    flush_path(&mut path, &mut paths, &mut coordinates, temporary)?;
    push_rects(
        commands,
        rectangles,
        clone_value(&color, scope)?,
        clone_value(&clip, scope)?,
        scope,
    )?;
    for points in paths {
        let command = object(
            [
                ("op", text("path", scope)?),
                ("points", numbers(&points, scope)?),
                ("color", clone_value(&color, scope)?),
                ("width", JsValue::Number(width)),
                (
                    "fill",
                    if series.kind == SeriesKind::Area {
                        clone_value(&fill, scope)?
                    } else {
                        JsValue::Null
                    },
                ),
                (
                    "baseline",
                    if series.kind == SeriesKind::Area {
                        JsValue::Number(baseline_y)
                    } else {
                        JsValue::Undefined
                    },
                ),
                ("clip", clone_value(&clip, scope)?),
            ],
            scope,
        )?;
        push_command(commands, command, scope)?;
    }
    push_line(
        commands,
        coordinates,
        color,
        width,
        clip,
        JsValue::Null,
        scope,
    )?;
    Ok(())
}

struct TimeLabelContext<'a, P: SceneProjection>
where
    P::Axis: SceneAxisView,
{
    layout: &'a P,
    view: VisibleRange,
    store: &'a BarStore,
    theme: &'a SceneTheme,
    host: &'a dyn Host,
    symbol: Option<&'a Symbol>,
    height: f64,
    metrics: crate::labels::LabelMetrics,
    dialect: NumberDialect,
}

fn render_time_labels<P>(
    commands: &mut Vec<JsValue>,
    context: TimeLabelContext<'_, P>,
    scope: &mut MemoryScope,
    temporary: &mut MemoryScope,
) -> Result<(), JsError>
where
    P: SceneProjection,
    P::Axis: SceneAxisView,
{
    let TimeLabelContext {
        layout,
        view,
        store,
        theme,
        host,
        symbol,
        height,
        metrics,
        dialect,
    } = context;
    let panel = &layout.panels()[0];
    let time_width = panel.right() - panel.left();
    let time_clip = [
        panel.left(),
        js_max(&[panel.bottom() + 4.0, height - metrics.height - 8.0]),
        time_width,
        js_min(&[metrics.height + 8.0, height - panel.bottom() - 4.0]),
    ];
    if time_clip[3] < metrics.height {
        return Ok(());
    }
    let value_at = |fraction: f64, scope: &mut MemoryScope| -> Result<JsString, JsError> {
        let index = view.from + (view.to - view.from) * fraction;
        let time = store.time_at_index(index);
        if let Some(symbol) = symbol {
            let parts = zoned_parts(host, time, &symbol.timezone)?;
            return JsString::try_from_str(
                &format!(
                    "{}-{}-{} {}:{}",
                    parts.year, parts.month, parts.day, parts.hour, parts.minute
                ),
                scope,
            )
            .map_err(|failure| failure.into_js_error());
        }
        let iso = to_iso_string(time).ok_or_else(|| range_error("Invalid time value"))?;
        JsString::try_from_str(&iso[5..16].replace('T', " "), scope)
            .map_err(|failure| failure.into_js_error())
    };
    let start = value_at(0.0, temporary)?;
    let end = value_at(1.0, temporary)?;
    let max_width = js_max(&[label_width(&start, metrics), label_width(&end, metrics)]);
    let count = js_max(&[
        1.0,
        js_min(&[5.0, ((time_width + 4.0) / (max_width + 4.0)).floor()]),
    ]) as usize;
    let baseline = height - 4.0 - metrics.descent;
    let mut last_right = f64::NEG_INFINITY;
    for index in 0..count {
        let fraction = if count == 1 {
            0.5
        } else {
            index as f64 / (count - 1) as f64
        };
        let value = value_at(fraction, temporary)?;
        let metadata = object([("role", text("time-tick", scope)?)], scope)?;
        let time_clip_value = numbers(&time_clip, scope)?;
        let command = label_command_scoped(
            LabelCommandInput {
                value: &JsValue::String(value),
                x: 0.0,
                y: baseline,
                max_width: time_width,
                font: &theme.font,
                color: &theme.text,
                clip: &time_clip_value,
                metadata: Some(&metadata),
            },
            dialect,
            scope,
        )?;
        let mut command = command;
        let JsValue::Object(record) = &mut command else {
            continue;
        };
        let source_bounds = array_field(record, "labelBounds")?;
        let mut bounds = try_vec_capacity(source_bounds.len(), scope)?;
        for value in source_bounds {
            bounds.push(clone_value(value, scope)?);
        }
        let label_width = number_at(&bounds, 2)?;
        let x = js_max(&[
            panel.left(),
            js_min(&[
                panel.right() - label_width,
                panel.left() + time_width * fraction - label_width / 2.0,
            ]),
        ]);
        if x < last_right + 4.0 {
            continue;
        }
        record.insert(key("x"), JsValue::Number(x));
        bounds[0] = JsValue::Number(x);
        record.insert(key("labelBounds"), JsValue::Array(bounds));
        push_command(commands, command, scope)?;
        last_right = x + label_width;
    }
    Ok(())
}

fn axis_format<'a, A: SceneAxisView>(
    axis: &'a A,
    model_precision: u32,
    symbol: Option<&'a Symbol>,
) -> AxisFormatInput<'a> {
    AxisFormatInput {
        id: axis.id(),
        axis_id: axis.axis_id(),
        scale: axis.scale_kind(),
        precision: axis.precision(),
        model_precision,
        tick_format: axis.tick_format(),
        prefix: axis.prefix(),
        suffix: axis.suffix(),
        projection: axis.scale(),
        symbol,
    }
}

fn axis_metadata(
    role: &str,
    panel: &JsString,
    axis: Option<&JsString>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    object(
        [
            ("role", text(role, scope)?),
            ("panelId", JsValue::String(try_clone_string(panel, scope)?)),
            (
                "axisId",
                match axis {
                    Some(axis) => JsValue::String(try_clone_string(axis, scope)?),
                    None => JsValue::Null,
                },
            ),
        ],
        scope,
    )
}

struct LabelSpec<'a> {
    value: &'a JsString,
    x: f64,
    y: f64,
    max_width: f64,
    font: &'a JsValue,
    color: &'a JsValue,
    clip: &'a JsValue,
    metadata: &'a JsValue,
    dialect: NumberDialect,
}

fn push_label(
    commands: &mut Vec<JsValue>,
    spec: LabelSpec<'_>,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let LabelSpec {
        value,
        x,
        y,
        max_width,
        font,
        color,
        clip,
        metadata,
        dialect,
    } = spec;
    let value = JsValue::String(try_clone_string(value, scope)?);
    let command = label_command_scoped(
        LabelCommandInput {
            value: &value,
            x,
            y,
            max_width,
            font,
            color,
            clip,
            metadata: Some(metadata),
        },
        dialect,
        scope,
    )?;
    if !matches!(command, JsValue::Null) {
        push_command(commands, command, scope)?;
    }
    Ok(())
}

fn label_command_scoped(
    input: LabelCommandInput<'_>,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let metrics = label_metrics_scoped(input.font, dialect, scope)?;
    let Some(fit) = fit_label_scoped(input.value, input.max_width, metrics, scope)? else {
        return Ok(JsValue::Null);
    };
    let ScopedLabelFit {
        text: fitted_text,
        full_text,
        width: fitted_width,
    } = fit;
    let metadata_len = match input.metadata {
        Some(JsValue::Object(value)) => value.len(),
        _ => 0,
    };
    let mut entries = try_vec_capacity(9usize.saturating_add(metadata_len), scope)?;
    for (name, value) in [
        ("op", text("text", scope)?),
        ("x", JsValue::Number(input.x)),
        ("y", JsValue::Number(input.y)),
        ("text", JsValue::String(fitted_text)),
        ("fullText", JsValue::String(full_text)),
        ("font", clone_value(input.font, scope)?),
        ("color", clone_value(input.color, scope)?),
        ("clip", clone_value(input.clip, scope)?),
        (
            "labelBounds",
            numbers(
                &[
                    input.x,
                    input.y - metrics.ascent,
                    fitted_width,
                    metrics.height,
                ],
                scope,
            )?,
        ),
    ] {
        entries.push((try_string(name, scope)?, value));
    }
    if let Some(JsValue::Object(metadata)) = input.metadata {
        for (name, value) in metadata.iter() {
            entries.push((try_clone_string(name, scope)?, clone_value(value, scope)?));
        }
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())
}

struct ScopedLabelFit {
    text: JsString,
    full_text: JsString,
    width: f64,
}

fn fit_label_scoped(
    value: &JsValue,
    max_width: f64,
    metrics: crate::labels::LabelMetrics,
    scope: &mut MemoryScope,
) -> Result<Option<ScopedLabelFit>, JsError> {
    let JsValue::String(value) = value else {
        return Err(type_error("Scene label string required"));
    };
    let full_text = try_clone_string(value, scope)?;
    let mut single_units = try_vec_capacity(value.len_utf16(), scope)?;
    single_units.extend(value.as_units().iter().map(|unit| {
        if is_js_whitespace(*unit) {
            b' ' as u16
        } else {
            *unit
        }
    }));
    let single_line = JsString::from_utf16(single_units);
    if max_width <= 0.0 || max_width.is_nan() {
        return Ok(None);
    }
    let full_width = label_width(&single_line, metrics);
    if full_width <= max_width {
        return Ok(Some(ScopedLabelFit {
            text: single_line,
            full_text,
            width: full_width,
        }));
    }
    let ellipsis_width = 1.2 * metrics.size;
    if ellipsis_width > max_width {
        return Ok(None);
    }
    let units = single_line.as_units();
    let mut text_units = try_vec_capacity(units.len().saturating_add(1), scope)?;
    let mut width = 0.0;
    let mut cursor = 0usize;
    while cursor < units.len() {
        let first = units[cursor];
        let paired = (0xd800..=0xdbff).contains(&first)
            && units
                .get(cursor + 1)
                .is_some_and(|second| (0xdc00..=0xdfff).contains(second));
        let unit_width = if paired || first > 0x7f {
            1.2
        } else if matches!(first, 0x4d | 0x57 | 0x40 | 0x25) {
            0.98
        } else {
            0.74
        } * metrics.size;
        if width + unit_width + ellipsis_width > max_width {
            break;
        }
        text_units.push(first);
        cursor += 1;
        if paired {
            text_units.push(units[cursor]);
            cursor += 1;
        }
        width += unit_width;
    }
    text_units.push(0x2026);
    Ok(Some(ScopedLabelFit {
        text: JsString::from_utf16(text_units),
        full_text,
        width: width + ellipsis_width,
    }))
}

fn panel_title_scoped(
    panel: &JsValue,
    series: &[JsValue],
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let JsValue::Object(panel) = panel else {
        return Err(type_error("Panel title object required"));
    };
    let undefined = JsValue::Undefined;
    let panel_id = object_property(panel, "id").unwrap_or(&undefined);
    let title = panel
        .iter()
        .find_map(|(name, value)| text_eq(name, "label").then_some(value))
        .filter(|value| !matches!(value, JsValue::Undefined | JsValue::Null))
        .unwrap_or(panel_id);
    let mut length = joined_value_length(title, dialect, scope)?;
    let mut accepted = 0usize;
    for (index, value) in series.iter().enumerate() {
        let Some(candidate) = panel_title_candidate(value, panel_id)? else {
            continue;
        };
        let duplicate = series[..index].iter().try_fold(false, |found, previous| {
            if found {
                Ok(true)
            } else {
                Ok(panel_title_candidate(previous, panel_id)?
                    .is_some_and(|previous| same_value_zero(previous, candidate)))
            }
        })?;
        if duplicate {
            continue;
        }
        accepted += 1;
        let candidate_length = joined_value_length(candidate, dialect, scope)?;
        length = length
            .checked_add(3)
            .and_then(|length| length.checked_add(candidate_length))
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    }
    let mut units = try_vec_capacity(length, scope)?;
    append_joined_value(&mut units, title, dialect, scope)?;
    let mut emitted = 0usize;
    for (index, value) in series.iter().enumerate() {
        let Some(candidate) = panel_title_candidate(value, panel_id)? else {
            continue;
        };
        let duplicate = series[..index].iter().try_fold(false, |found, previous| {
            if found {
                Ok(true)
            } else {
                Ok(panel_title_candidate(previous, panel_id)?
                    .is_some_and(|previous| same_value_zero(previous, candidate)))
            }
        })?;
        if duplicate {
            continue;
        }
        units.extend(" · ".encode_utf16());
        append_joined_value(&mut units, candidate, dialect, scope)?;
        emitted += 1;
    }
    debug_assert_eq!(emitted, accepted);
    Ok(JsString::from_utf16(units))
}

fn panel_title_candidate<'a>(
    value: &'a JsValue,
    panel_id: &JsValue,
) -> Result<Option<&'a JsValue>, JsError> {
    let JsValue::Object(row) = value else {
        return Err(type_error("Panel title series object required"));
    };
    if !strict_equal(object_property(row, "panel"), Some(panel_id))
        || matches!(object_property(row, "visible"), Some(JsValue::Bool(false)))
    {
        return Ok(None);
    }
    let candidate = row
        .iter()
        .find_map(|(name, value)| text_eq(name, "label").then_some(value))
        .filter(|value| !matches!(value, JsValue::Undefined | JsValue::Null))
        .or_else(|| object_property(row, "indicator"));
    Ok(candidate.filter(|value| js_truthy(value)))
}

fn joined_value_length(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<usize, JsError> {
    match value {
        JsValue::Undefined | JsValue::Null => Ok(0),
        JsValue::String(value) => Ok(value.len_utf16()),
        JsValue::Bool(true) => Ok(4),
        JsValue::Bool(false) => Ok(5),
        JsValue::Number(value) => Ok(barochart_js::num::number_to_string_with(*value, dialect)
            .encode_utf16()
            .count()),
        JsValue::Array(_) | JsValue::Object(_) => {
            Ok(js_to_string_scoped(value, dialect, scope)?.len_utf16())
        }
    }
}

fn append_joined_value(
    output: &mut Vec<u16>,
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    match value {
        JsValue::Undefined | JsValue::Null => {}
        JsValue::String(value) => output.extend_from_slice(value.as_units()),
        JsValue::Bool(value) => output.extend(value.to_string().encode_utf16()),
        JsValue::Number(value) => {
            output.extend(barochart_js::num::number_to_string_with(*value, dialect).encode_utf16())
        }
        JsValue::Array(_) | JsValue::Object(_) => {
            output.extend_from_slice(js_to_string_scoped(value, dialect, scope)?.as_units());
        }
    }
    Ok(())
}

fn strict_equal(left: Option<&JsValue>, right: Option<&JsValue>) -> bool {
    let undefined = JsValue::Undefined;
    match (left.unwrap_or(&undefined), right.unwrap_or(&undefined)) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => {
            !left.is_nan() && !right.is_nan() && left == right
        }
        (JsValue::String(left), JsValue::String(right)) => left == right,
        _ => false,
    }
}

fn same_value_zero(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => {
            left.is_nan() && right.is_nan() || left == right
        }
        (JsValue::String(left), JsValue::String(right)) => left == right,
        _ => false,
    }
}

fn js_truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => false,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Bool(true) | JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

fn flush_path(
    path: &mut Vec<f64>,
    paths: &mut Vec<Vec<f64>>,
    lines: &mut Vec<f64>,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if path.len() == 2 {
        lines.extend([path[0] - 0.25, path[1], path[0] + 0.25, path[1]]);
    } else if !path.is_empty() {
        let replacement = try_vec_capacity(path.capacity(), scope)?;
        paths.push(std::mem::replace(path, replacement));
        return Ok(());
    }
    path.clear();
    Ok(())
}

fn histogram_rect<A: SceneAxisView>(
    rectangles: &mut Vec<f64>,
    x: f64,
    value: f64,
    width: f64,
    baseline: f64,
    axis: &A,
) {
    let value = axis.scale().y(value);
    rectangles.extend([
        x - width / 2.0,
        js_min(&[baseline, value]),
        width,
        js_max(&[1.0, (baseline - value).abs()]),
    ]);
}

fn push_line(
    commands: &mut Vec<JsValue>,
    coordinates: Vec<f64>,
    color: JsValue,
    width: f64,
    clip: JsValue,
    dash: JsValue,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if coordinates.is_empty() {
        return Ok(());
    }
    let command = object(
        [
            ("op", text("lines", scope)?),
            ("coords", numbers(&coordinates, scope)?),
            ("color", color),
            ("width", JsValue::Number(width)),
            ("clip", clip),
            ("dash", dash),
        ],
        scope,
    )?;
    push_command(commands, command, scope)
}

fn push_rects(
    commands: &mut Vec<JsValue>,
    coordinates: Vec<f64>,
    color: JsValue,
    clip: JsValue,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if coordinates.is_empty() {
        return Ok(());
    }
    let command = object(
        [
            ("op", text("rects", scope)?),
            ("coords", numbers(&coordinates, scope)?),
            ("color", color),
            ("clip", clip),
        ],
        scope,
    )?;
    push_command(commands, command, scope)
}

struct SceneStats {
    stored_bars: usize,
    visible_source_bars: f64,
    rendered_candle_buckets: usize,
}

fn scene_value(
    width: f64,
    height: f64,
    theme: &SceneTheme,
    commands: Vec<JsValue>,
    layout: JsValue,
    stats: SceneStats,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let command_count = commands.len();
    let stats = object(
        [
            ("storedBars", JsValue::Number(stats.stored_bars as f64)),
            (
                "visibleSourceBars",
                JsValue::Number(stats.visible_source_bars),
            ),
            (
                "renderedCandleBuckets",
                JsValue::Number(stats.rendered_candle_buckets as f64),
            ),
            ("commandCount", JsValue::Number(command_count as f64)),
        ],
        scope,
    )?;
    object(
        [
            ("width", JsValue::Number(width)),
            ("height", JsValue::Number(height)),
            ("background", clone_value(&theme.background, scope)?),
            ("commands", JsValue::Array(commands)),
            ("layout", layout),
            ("stats", stats),
        ],
        scope,
    )
}

fn opaque_background(value: &JsValue, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    let color = portable_color(value)?;
    let mut units = try_vec_capacity(9, scope)?;
    units.extend_from_slice(&color.as_units()[..7]);
    units.extend("ff".encode_utf16());
    Ok(JsString::from_utf16(units))
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

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => object_property(value, name),
        _ => None,
    }
}

fn nullish_field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    field(value, name).filter(|value| !matches!(value, JsValue::Undefined | JsValue::Null))
}

fn number_field(value: &JsValue, name: &str) -> Option<f64> {
    match field(value, name) {
        Some(JsValue::Number(value)) => Some(*value),
        _ => None,
    }
}

fn array_field<'a>(value: &'a JsObject, name: &str) -> Result<&'a [JsValue], JsError> {
    match object_property(value, name) {
        Some(JsValue::Array(value)) => Ok(value),
        _ => Err(type_error("Scene label bounds required")),
    }
}

fn object_property<'a>(value: &'a JsObject, name: &str) -> Option<&'a JsValue> {
    value
        .iter()
        .find_map(|(key, value)| text_eq(key, name).then_some(value))
}

fn number_at(value: &[JsValue], index: usize) -> Result<f64, JsError> {
    match value.get(index) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(type_error("Scene numeric field required")),
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

fn f64_vec(values: &[f64], scope: &mut MemoryScope) -> Result<Vec<f64>, JsError> {
    let mut output = try_vec_capacity(values.len(), scope)?;
    output.extend_from_slice(values);
    Ok(output)
}

fn numbers(values: &[f64], scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let mut output = try_vec_capacity(values.len(), scope)?;
    output.extend(values.iter().copied().map(JsValue::Number));
    Ok(JsValue::Array(output))
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
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

fn text(value: &str, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    try_string(value, scope).map(JsValue::String)
}

fn object<const N: usize>(
    entries: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut value = try_vec_capacity(N, scope)?;
    for (key, child) in entries {
        value.push((try_string(key, scope)?, child));
    }
    JsObject::try_from_entries_scoped(value, scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())
}

fn push_command(
    commands: &mut Vec<JsValue>,
    command: JsValue,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if commands.len() == commands.capacity() {
        scope
            .try_grow(std::mem::size_of::<JsValue>())
            .map_err(|failure| failure.into_js_error())?;
        commands
            .try_reserve_exact(1)
            .map_err(|_| scope.allocation_failure().into_js_error())?;
    }
    commands.push(command);
    Ok(())
}

fn append_commands(
    commands: &mut Vec<JsValue>,
    mut next: Vec<JsValue>,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if commands.capacity().saturating_sub(commands.len()) < next.len() {
        let additional = next.len();
        let bytes = additional
            .checked_mul(std::mem::size_of::<JsValue>())
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        scope
            .try_grow(bytes)
            .map_err(|failure| failure.into_js_error())?;
        commands
            .try_reserve_exact(additional)
            .map_err(|_| scope.allocation_failure().into_js_error())?;
    }
    commands.append(&mut next);
    Ok(())
}

fn aggregate_scoped(
    store: &BarStore,
    start: f64,
    end: f64,
    max_buckets: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<AggregateBar>, JsError> {
    if max_buckets == 0 || start.is_nan() || end.is_nan() {
        return store.aggregate(start, end, max_buckets);
    }
    let from = clamp_floor(start, store.length());
    let to = clamp_ceil(end, store.length());
    let count = if to <= from {
        0
    } else {
        std::cmp::min(to - from, max_buckets)
    };
    let bytes = count
        .checked_mul(std::mem::size_of::<AggregateBar>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    store.aggregate(start, end, max_buckets)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
