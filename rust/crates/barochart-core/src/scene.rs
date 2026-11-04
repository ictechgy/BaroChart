//! Renderer-neutral scene display-list generation over a completed real layout.

#![forbid(unsafe_code)]

use barochart_js::date::to_iso_string;
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::JsString;

use crate::Host;
use crate::axis_scale::AxisScaleKind;
use crate::contracts::portable_color;
use crate::data::{AggregateBar, BarStore};
use crate::drawing_geometry::{DrawingAxisView, DrawingGeometryCache, DrawingProjection};
use crate::drawings::DrawingStore;
use crate::labels::{LabelCommandInput, label_command, label_metrics, label_width, panel_title};
use crate::layout::{Layout, LayoutAxis, LayoutPanel};
use crate::markets::{Symbol, zoned_parts};
use crate::model_state::{ModelState, Series, SeriesKind, VisibleRange};
use crate::range_index::{RangeIndex, RangeQuery};
use crate::scene_parts::{
    AxisFormatInput, AxisTickFormat, DrawingCommandInput, SceneTheme, aggregate_volume_series,
    create_drawing_commands, format_axis_value,
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

/// Builds an ordered scene object after layout and lazy series caches are ready.
pub fn build_scene<P>(input: SceneInput<'_, P>) -> Result<JsValue, JsError>
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
        commands.push(object([
            ("op", text("text")),
            ("x", JsValue::Number(js_max(&[12.0, width / 2.0 - 60.0]))),
            ("y", JsValue::Number(height / 2.0)),
            ("text", text("No data")),
            ("color", theme.text.clone()),
            ("font", theme.font.clone()),
        ]));
        return Ok(scene_value(
            width,
            height,
            theme,
            commands,
            layout.to_js_value(),
            SceneStats {
                stored_bars: 0,
                visible_source_bars: 0.0,
                rendered_candle_buckets: 0,
            },
        ));
    }

    let first_panel = layout
        .panels()
        .first()
        .ok_or_else(|| type_error("Scene layout panel required"))?;
    let bucket_width = ((first_panel.right() - first_panel.left()) / 3.0).floor();
    let max_buckets = js_max(&[1.0, bucket_width]) as usize;
    let buckets = store.aggregate(layout.source_from(), layout.source_to(), max_buckets)?;
    let metrics = label_metrics(&theme.font, dialect)?;
    let series_context = SeriesRenderContext {
        view: model.view,
        store,
        layout,
        buckets: &buckets,
        theme,
    };
    for panel in layout.panels() {
        let clip = numbers(&[
            panel.left(),
            panel.top(),
            panel.right() - panel.left(),
            panel.bottom() - panel.top(),
        ]);
        let mut grid = Vec::new();
        let raw_ticks = ((panel.bottom() - panel.top()) / 40.0).floor();
        let price_ticks = js_max(&[1.0, js_min(&[4.0, raw_ticks])]) as usize;
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
            theme.grid.clone(),
            1.0,
            JsValue::Null,
            JsValue::Null,
        );

        for axis in panel.axes().iter().filter(|axis| axis.visible()) {
            let axis_clip = numbers(&[
                axis.axis_left(),
                panel.top(),
                axis.axis_right() - axis.axis_left(),
                panel.bottom() - panel.top(),
            ]);
            let x = axis.axis_left() + 4.0;
            let max_width = axis.axis_right() - x - 4.0;
            let has_title = axis
                .label()
                .is_some_and(|label| !label.as_units().is_empty())
                && panel.bottom() - panel.top() >= metrics.height * 2.0 + 12.0;
            let mut label_top = panel.top() + 4.0;
            if has_title {
                let metadata = axis_metadata("axis-title", panel.id(), axis.axis_id());
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
                let value = format_axis_value(
                    axis_format(axis, model.precision as u32, symbol),
                    axis.scale().price(at),
                    dialect,
                );
                let metadata = axis_metadata("price-tick", panel.id(), axis.axis_id());
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
            render_series(&mut commands, entry, axis, panel, &series_context)?;
        }

        if panel.bottom() - panel.top() >= metrics.height + 8.0 {
            let panel_value = model
                .panels
                .iter()
                .find(|candidate| candidate.id == *panel.id())
                .map(|panel| panel.to_js_value())
                .ok_or_else(|| type_error("Scene panel model required"))?;
            let series_values: Vec<JsValue> =
                model.series.iter().map(Series::to_js_value).collect();
            let title = panel_title(&panel_value, &series_values, dialect)?;
            let metadata = object([
                ("role", text("panel-title")),
                ("panelId", JsValue::String(panel.id().clone())),
            ]);
            let command = label_command(
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
            )?;
            if let JsValue::Object(command_record) = &command {
                let bounds = array_field(command_record, "labelBounds")?;
                commands.push(object([
                    ("op", text("box")),
                    ("x", JsValue::Number(panel.left())),
                    ("y", JsValue::Number(panel.top())),
                    ("w", JsValue::Number(number_at(bounds, 2)? + 8.0)),
                    ("h", JsValue::Number(metrics.height + 8.0)),
                    ("fill", theme.background.clone()),
                    ("color", theme.background.clone()),
                    ("width", JsValue::Number(0.0)),
                    ("clip", clip.clone()),
                ]));
                commands.push(command);
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
    )?;
    if include_drawings && let Some(drawings) = drawings {
        commands.extend(create_drawing_commands(DrawingCommandInput {
            model,
            store,
            drawings,
            current_view: model.view,
            layout,
            cache: drawing_cache,
            theme,
            dialect,
        })?);
    }
    if include_crosshair {
        commands.extend(create_resolved_crosshair_commands(
            layout,
            resolved_crosshair,
            theme,
            model.precision as u32,
            symbol,
            dialect,
        )?);
    }
    Ok(scene_value(
        width,
        height,
        theme,
        commands,
        layout.to_js_value(),
        SceneStats {
            stored_bars: store.length(),
            visible_source_bars: layout.source_to() - layout.source_from(),
            rendered_candle_buckets: buckets.len(),
        },
    ))
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
            vec![resolved.x, current.top(), resolved.x, current.bottom()],
            theme.crosshair.clone(),
            1.0,
            JsValue::Null,
            numbers(&[4.0, 4.0]),
        );
    }
    push_line(
        &mut commands,
        vec![panel.left(), resolved.y, panel.right(), resolved.y],
        theme.crosshair.clone(),
        1.0,
        JsValue::Null,
        numbers(&[4.0, 4.0]),
    );
    let metrics = label_metrics(&theme.font, dialect)?;
    let background = opaque_background(&theme.background)?;
    if panel.bottom() - panel.top() >= metrics.height + 8.0 {
        for axis in panel.axes().iter().filter(|axis| axis.visible()) {
            let clip = numbers(&[
                axis.axis_left(),
                panel.top(),
                axis.axis_right() - axis.axis_left(),
                panel.bottom() - panel.top(),
            ]);
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
            let formatted =
                format_axis_value(axis_format(axis, model_precision, symbol), price, dialect);
            let metadata = axis_metadata("crosshair-price", panel.id(), axis.axis_id());
            let label = label_command(
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
            )?;
            if !matches!(label, JsValue::Null) {
                commands.push(object([
                    ("op", text("box")),
                    ("x", JsValue::Number(axis.axis_left())),
                    ("y", JsValue::Number(top - 4.0)),
                    ("w", JsValue::Number(axis.axis_right() - axis.axis_left())),
                    ("h", JsValue::Number(metrics.height + 8.0)),
                    ("fill", JsValue::String(background.clone())),
                    ("color", JsValue::String(background.clone())),
                    ("width", JsValue::Number(0.0)),
                    ("clip", clip.clone()),
                ]));
                commands.push(label);
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
    let record = series.raw_record();
    let clip = numbers(&[
        panel.left(),
        panel.top(),
        panel.right() - panel.left(),
        panel.bottom() - panel.top(),
    ]);
    let width = number_field(&record, "width").unwrap_or(1.0);
    if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc) {
        let mut up_rects = Vec::new();
        let mut down_rects = Vec::new();
        let mut up_lines = Vec::new();
        let mut down_lines = Vec::new();
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
            .clone();
        let down_color = nullish_field(&record, "downColor")
            .unwrap_or(&theme.down)
            .clone();
        push_line(
            commands,
            up_lines,
            up_color.clone(),
            width,
            clip.clone(),
            JsValue::Null,
        );
        push_line(
            commands,
            down_lines,
            down_color.clone(),
            width,
            clip.clone(),
            JsValue::Null,
        );
        push_rects(commands, up_rects, up_color, clip.clone());
        push_rects(commands, down_rects, down_color, clip);
        return Ok(());
    }
    if aggregate_volume_series(series) {
        let baseline = axis.scale().y(0.0);
        let mut rectangles = Vec::new();
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
            field(&record, "color")
                .cloned()
                .unwrap_or(JsValue::Undefined),
            clip,
        );
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
    let color = field(&record, "color")
        .cloned()
        .unwrap_or(JsValue::Undefined);
    let fill = nullish_field(&record, "fill")
        .cloned()
        .unwrap_or_else(|| text("#7898ff22"));
    let mut coordinates = Vec::new();
    let mut rectangles = Vec::new();
    let mut paths = Vec::new();
    let mut path = Vec::new();
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
            flush_path(&mut path, &mut paths, &mut coordinates);
            continue;
        }
        if finite != value_end - from {
            let bar_width = js_max(&[
                1.0,
                (layout.x(view, from as f64 + 1.0) - layout.x(view, from as f64)).abs() * 0.8,
            ]);
            for (index, value) in values.iter().enumerate().take(value_end).skip(from) {
                if !value.is_finite() {
                    flush_path(&mut path, &mut paths, &mut coordinates);
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
    flush_path(&mut path, &mut paths, &mut coordinates);
    push_rects(commands, rectangles, color.clone(), clip.clone());
    for points in paths {
        commands.push(object([
            ("op", text("path")),
            ("points", numbers(&points)),
            ("color", color.clone()),
            ("width", JsValue::Number(width)),
            (
                "fill",
                if series.kind == SeriesKind::Area {
                    fill.clone()
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
            ("clip", clip.clone()),
        ]));
    }
    push_line(commands, coordinates, color, width, clip, JsValue::Null);
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
    let value_at = |fraction: f64| -> Result<JsString, JsError> {
        let index = view.from + (view.to - view.from) * fraction;
        let time = store.time_at_index(index);
        if let Some(symbol) = symbol {
            let parts = zoned_parts(host, time, &symbol.timezone)?;
            return Ok(JsString::from_str(&format!(
                "{}-{}-{} {}:{}",
                parts.year, parts.month, parts.day, parts.hour, parts.minute
            )));
        }
        let iso = to_iso_string(time).ok_or_else(|| range_error("Invalid time value"))?;
        Ok(JsString::from_str(&iso[5..16].replace('T', " ")))
    };
    let start = value_at(0.0)?;
    let end = value_at(1.0)?;
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
        let value = value_at(fraction)?;
        let metadata = object([("role", text("time-tick"))]);
        let command = label_command(
            LabelCommandInput {
                value: &JsValue::String(value),
                x: 0.0,
                y: baseline,
                max_width: time_width,
                font: &theme.font,
                color: &theme.text,
                clip: &numbers(&time_clip),
                metadata: Some(&metadata),
            },
            dialect,
        )?;
        let mut command = command;
        let JsValue::Object(record) = &mut command else {
            continue;
        };
        let mut bounds = array_field(record, "labelBounds")?.to_vec();
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
        commands.push(command);
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

fn axis_metadata(role: &str, panel: &JsString, axis: Option<&JsString>) -> JsValue {
    object([
        ("role", text(role)),
        ("panelId", JsValue::String(panel.clone())),
        (
            "axisId",
            axis.map_or(JsValue::Null, |axis| JsValue::String(axis.clone())),
        ),
    ])
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

fn push_label(commands: &mut Vec<JsValue>, spec: LabelSpec<'_>) -> Result<(), JsError> {
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
    let command = label_command(
        LabelCommandInput {
            value: &JsValue::String(value.clone()),
            x,
            y,
            max_width,
            font,
            color,
            clip,
            metadata: Some(metadata),
        },
        dialect,
    )?;
    if !matches!(command, JsValue::Null) {
        commands.push(command);
    }
    Ok(())
}

fn flush_path(path: &mut Vec<f64>, paths: &mut Vec<Vec<f64>>, lines: &mut Vec<f64>) {
    if path.len() == 2 {
        lines.extend([path[0] - 0.25, path[1], path[0] + 0.25, path[1]]);
    } else if !path.is_empty() {
        paths.push(std::mem::take(path));
        return;
    }
    path.clear();
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
) {
    if coordinates.is_empty() {
        return;
    }
    commands.push(object([
        ("op", text("lines")),
        ("coords", numbers(&coordinates)),
        ("color", color),
        ("width", JsValue::Number(width)),
        ("clip", clip),
        ("dash", dash),
    ]));
}

fn push_rects(commands: &mut Vec<JsValue>, coordinates: Vec<f64>, color: JsValue, clip: JsValue) {
    if coordinates.is_empty() {
        return;
    }
    commands.push(object([
        ("op", text("rects")),
        ("coords", numbers(&coordinates)),
        ("color", color),
        ("clip", clip),
    ]));
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
) -> JsValue {
    let command_count = commands.len();
    object([
        ("width", JsValue::Number(width)),
        ("height", JsValue::Number(height)),
        ("background", theme.background.clone()),
        ("commands", JsValue::Array(commands)),
        ("layout", layout),
        (
            "stats",
            object([
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
            ]),
        ),
    ])
}

fn opaque_background(value: &JsValue) -> Result<JsString, JsError> {
    let color = portable_color(value)?;
    let mut units = color.as_units()[..7].to_vec();
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
        JsValue::Object(value) => value.get(&key(name)),
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
    match value.get(&key(name)) {
        Some(JsValue::Array(value)) => Ok(value),
        _ => Err(type_error("Scene label bounds required")),
    }
}

fn number_at(value: &[JsValue], index: usize) -> Result<f64, JsError> {
    match value.get(index) {
        Some(JsValue::Number(value)) => Ok(*value),
        _ => Err(type_error("Scene numeric field required")),
    }
}

fn numbers(values: &[f64]) -> JsValue {
    JsValue::Array(values.iter().copied().map(JsValue::Number).collect())
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (key, child) in entries {
        value.insert(JsString::from_str(key), child);
    }
    JsValue::Object(value)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
