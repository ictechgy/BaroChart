//! Renderer-neutral drawing geometry shared by scene generation and later M5 hit testing.

#![forbid(unsafe_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Weak};

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::{
    NumberDialect, js_max, js_min, number_to_string_with, to_fixed_with, to_precision,
};
use barochart_js::string::JsString;

use crate::axis_scale::AxisScale;
use crate::data::BarStore;
use crate::drawing_types::{Drawing, DrawingType};
use crate::model_state::{ModelState, VisibleRange};
use crate::position_drawing::position_metrics_for;

/// Owned CSS-pixel point returned by a live layout projection.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// Read-only axis fields drawing geometry consumes from the real layout.
pub trait DrawingAxisView {
    fn left(&self) -> f64;
    fn right(&self) -> f64;
    fn top(&self) -> f64;
    fn bottom(&self) -> f64;
    fn scale(&self) -> &AxisScale;
}

/// Boundary implemented by the real Layout after its lazy series/cache work is complete.
pub trait DrawingProjection {
    type Axis: DrawingAxisView;

    fn geometry_key(&self) -> &JsString;
    fn geometry_font(&self) -> &JsValue;
    fn drawing_axis(
        &self,
        current_model: &ModelState,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
        series_id: Option<&JsString>,
    ) -> Option<&Self::Axis>;
    fn to_screen(
        &self,
        current_view: VisibleRange,
        current_store: &BarStore,
        time: f64,
        price: f64,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
    ) -> ScreenPoint;
    fn index(&self, current_view: VisibleRange, screen_x: f64) -> f64;
}

struct CacheEntry {
    drawing: Weak<Drawing>,
    geometry_key: JsString,
    commands: Arc<[JsValue]>,
}

/// Per-chart bounded geometry cache. Dead drawing identities never match a later allocation.
pub struct DrawingGeometryCache {
    capacity: usize,
    entries: VecDeque<CacheEntry>,
}

impl DrawingGeometryCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: VecDeque::with_capacity(capacity),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn purge_dead(&mut self) {
        self.entries
            .retain(|entry| entry.drawing.strong_count() > 0);
    }

    fn get(&mut self, drawing: &Arc<Drawing>, geometry_key: &JsString) -> Option<Arc<[JsValue]>> {
        self.purge_dead();
        let index = self.entries.iter().position(|entry| {
            entry.geometry_key == *geometry_key
                && entry
                    .drawing
                    .upgrade()
                    .is_some_and(|cached| Arc::ptr_eq(&cached, drawing))
        })?;
        let entry = self.entries.remove(index).expect("cache index exists");
        let commands = Arc::clone(&entry.commands);
        self.entries.push_back(entry);
        Some(commands)
    }

    fn insert(
        &mut self,
        drawing: &Arc<Drawing>,
        geometry_key: &JsString,
        commands: Arc<[JsValue]>,
    ) {
        if self.capacity == 0 || geometry_key.as_units().is_empty() {
            return;
        }
        self.purge_dead();
        while self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(CacheEntry {
            drawing: Arc::downgrade(drawing),
            geometry_key: geometry_key.clone(),
            commands,
        });
    }
}

/// Uses the chart-owned cache when the layout exposes a nonempty geometry key.
pub fn drawing_geometry<P: DrawingProjection>(
    cache: &mut DrawingGeometryCache,
    drawing: &Arc<Drawing>,
    model: &ModelState,
    current_view: VisibleRange,
    current_store: &BarStore,
    layout: &P,
    dialect: NumberDialect,
) -> Result<Arc<[JsValue]>, JsError> {
    let key = layout.geometry_key();
    if !key.as_units().is_empty()
        && let Some(commands) = cache.get(drawing, key)
    {
        return Ok(commands);
    }
    let commands: Arc<[JsValue]> =
        calculate_geometry(drawing, model, current_view, current_store, layout, dialect)?.into();
    cache.insert(drawing, key, Arc::clone(&commands));
    Ok(commands)
}

/// Exact `calculateGeometry` display-list projection without cache semantics.
pub fn calculate_geometry<P: DrawingProjection>(
    drawing: &Drawing,
    model: &ModelState,
    current_view: VisibleRange,
    current_store: &BarStore,
    layout: &P,
    dialect: NumberDialect,
) -> Result<Vec<JsValue>, JsError> {
    if drawing.visible == Some(false) {
        return Ok(Vec::new());
    }
    let Some(axis) = layout.drawing_axis(
        model,
        &drawing.panel,
        drawing.axis_id.as_ref(),
        drawing.series_id.as_ref(),
    ) else {
        return Ok(Vec::new());
    };
    let points: Vec<ScreenPoint> = drawing
        .points
        .iter()
        .map(|point| {
            layout.to_screen(
                current_view,
                current_store,
                point.time,
                point.price,
                &drawing.panel,
                drawing.axis_id.as_ref(),
            )
        })
        .collect();
    if points
        .iter()
        .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Ok(Vec::new());
    }
    let a = points[0];
    let b = points.get(1).copied().unwrap_or(a);
    let c = points.get(2).copied().unwrap_or(b);
    let color = drawing
        .style
        .as_ref()
        .and_then(|style| style.color.clone())
        .unwrap_or_else(|| JsString::from_str("#f5b85a"));
    let width = drawing
        .style
        .as_ref()
        .and_then(|style| style.width)
        .unwrap_or(1.5);
    let clip = vec![
        axis.left(),
        axis.top(),
        axis.right() - axis.left(),
        axis.bottom() - axis.top(),
    ];
    let mut commands = Vec::new();

    if drawing.kind.is_position() {
        let metrics = position_metrics_for(drawing)?;
        let extent = points[3];
        let target_fill = drawing
            .style
            .as_ref()
            .and_then(|style| style.fill.as_ref())
            .map(JsString::to_string_lossy)
            .unwrap_or_else(|| String::from("#26a69a44"));
        for (level, fill) in [(b, String::from("#ef535044")), (c, target_fill)] {
            commands.push(position_box(BoxCommand {
                x: a.x,
                y: js_min(&[a.y, level.y]),
                width: extent.x - a.x,
                height: (a.y - level.y).abs(),
                fill: &fill,
                color: &color,
                stroke: width,
                clip: &clip,
            }));
        }
        push_line(
            &mut commands,
            vec![a.x, a.y, extent.x, a.y],
            &color,
            width,
            &clip,
            None,
        );
        let direction = if metrics.direction == "long" {
            "Long"
        } else {
            "Short"
        };
        commands.push(text_command(
            a.x + 4.0,
            a.y - 4.0,
            &format!(
                "{direction} entry {} · R/R {}",
                number_to_string_with(metrics.entry, dialect),
                to_precision(metrics.ratio, 6)
            ),
            &color,
            &clip,
        ));
        commands.push(text_command(
            a.x + 4.0,
            b.y - 4.0,
            &format!(
                "Stop {} · Δ {} · {} of |entry|",
                number_to_string_with(metrics.stop, dialect),
                to_precision(metrics.risk, 6),
                percent_text(metrics.risk_percent)
            ),
            &color,
            &clip,
        ));
        commands.push(text_command(
            a.x + 4.0,
            c.y - 4.0,
            &format!(
                "Target {} · Δ {} · {} of |entry|",
                number_to_string_with(metrics.target, dialect),
                to_precision(metrics.reward, 6),
                percent_text(metrics.reward_percent)
            ),
            &color,
            &clip,
        ));
        return Ok(commands);
    }

    match drawing.kind {
        DrawingType::Horizontal => push_line(
            &mut commands,
            vec![axis.left(), a.y, axis.right(), a.y],
            &color,
            width,
            &clip,
            None,
        ),
        DrawingType::Trendline | DrawingType::Measurement => {
            push_line(
                &mut commands,
                vec![a.x, a.y, b.x, b.y],
                &color,
                width,
                &clip,
                None,
            );
            if drawing.kind == DrawingType::Measurement {
                let delta = drawing.points[1].price - drawing.points[0].price;
                let percent = if drawing.points[0].price == 0.0 {
                    String::from("n/a")
                } else {
                    format!(
                        "{}%",
                        to_fixed_with(delta / drawing.points[0].price * 100.0, 2, dialect)
                    )
                };
                let bars = layout.index(current_view, b.x) - layout.index(current_view, a.x);
                let seconds = (drawing.points[1].time - drawing.points[0].time) / 1_000.0;
                commands.push(text_command(
                    (a.x + b.x) / 2.0,
                    js_min(&[a.y, b.y]) - 8.0,
                    &format!(
                        "Δ {} ({percent}) · {} bars · {}s",
                        to_precision(delta, 6),
                        to_fixed_with(bars, 1, dialect),
                        to_fixed_with(seconds, 0, dialect)
                    ),
                    &color,
                    &clip,
                ));
            }
        }
        DrawingType::Ray | DrawingType::ExtendedLine => push_line(
            &mut commands,
            extended_segment(a, b, axis, drawing.kind == DrawingType::Ray),
            &color,
            width,
            &clip,
            None,
        ),
        DrawingType::Channel => {
            push_line(
                &mut commands,
                extended_segment(a, b, axis, false),
                &color,
                width,
                &clip,
                None,
            );
            let parallel = ScreenPoint {
                x: c.x + b.x - a.x,
                y: c.y + b.y - a.y,
            };
            push_line(
                &mut commands,
                extended_segment(c, parallel, axis, false),
                &color,
                width,
                &clip,
                None,
            );
            let middle = ScreenPoint {
                x: (a.x + c.x) / 2.0,
                y: (a.y + c.y) / 2.0,
            };
            let middle_end = ScreenPoint {
                x: middle.x + b.x - a.x,
                y: middle.y + b.y - a.y,
            };
            push_line(
                &mut commands,
                extended_segment(middle, middle_end, axis, false),
                &color,
                width,
                &clip,
                Some([4.0, 4.0]),
            );
        }
        DrawingType::Fibonacci | DrawingType::FibExtension => {
            let fibonacci = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
            let extension = [0.0, 0.618, 1.0, 1.272, 1.618, 2.618];
            let ratios: &[f64] = if drawing.kind == DrawingType::Fibonacci {
                &fibonacci
            } else {
                &extension
            };
            for ratio in ratios {
                let price = if drawing.kind == DrawingType::Fibonacci {
                    drawing.points[0].price
                        + (drawing.points[1].price - drawing.points[0].price) * ratio
                } else {
                    drawing.points[2].price
                        + (drawing.points[1].price - drawing.points[0].price) * ratio
                };
                let y = axis.scale().y(price);
                if !y.is_finite() {
                    continue;
                }
                push_line(
                    &mut commands,
                    vec![
                        a.x,
                        y,
                        if drawing.kind == DrawingType::FibExtension {
                            axis.right()
                        } else {
                            b.x
                        },
                        y,
                    ],
                    &color,
                    width,
                    &clip,
                    None,
                );
                commands.push(text_command(
                    js_min(&[a.x, b.x]) + 4.0,
                    y - 3.0,
                    &format!("{}%", to_fixed_with(ratio * 100.0, 1, dialect)),
                    &color,
                    &clip,
                ));
            }
        }
        DrawingType::FibFan => {
            for ratio in [0.382, 0.5, 0.618] {
                let target = ScreenPoint {
                    x: b.x,
                    y: axis.scale().y(drawing.points[0].price
                        + (drawing.points[1].price - drawing.points[0].price) * ratio),
                };
                if target.y.is_finite() {
                    push_line(
                        &mut commands,
                        extended_segment(a, target, axis, true),
                        &color,
                        width,
                        &clip,
                        None,
                    );
                }
            }
            commands.push(text_command(
                a.x,
                a.y - 8.0,
                "38.2 / 50 / 61.8",
                &color,
                &clip,
            ));
        }
        DrawingType::FibTimezones => {
            for ratio in [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0] {
                let x = a.x + (b.x - a.x) * ratio;
                push_line(
                    &mut commands,
                    vec![x, axis.top(), x, axis.bottom()],
                    &color,
                    width,
                    &clip,
                    None,
                );
                commands.push(text_command(
                    x + 3.0,
                    axis.top() + 28.0,
                    &number_to_string_with(ratio, dialect),
                    &color,
                    &clip,
                ));
            }
        }
        DrawingType::Freehand => {
            let mut coordinates = Vec::with_capacity(points.len().saturating_sub(1) * 4);
            for pair in points.windows(2) {
                coordinates.extend([pair[0].x, pair[0].y, pair[1].x, pair[1].y]);
            }
            push_line(&mut commands, coordinates, &color, width, &clip, None);
        }
        DrawingType::Text => {
            let value = drawing
                .text
                .as_ref()
                .map(JsString::to_string_lossy)
                .unwrap_or_else(|| String::from("Note"));
            commands.push(text_command(a.x, a.y, &value, &color, &clip));
        }
        DrawingType::Rectangle | DrawingType::Ellipse => {
            commands.push(shape_command(ShapeCommand {
                kind: drawing.kind,
                x: js_min(&[a.x, b.x]),
                y: js_min(&[a.y, b.y]),
                width: (a.x - b.x).abs(),
                height: (a.y - b.y).abs(),
                color: &color,
                stroke: width,
                fill: drawing.style.as_ref().and_then(|style| style.fill.as_ref()),
                clip: &clip,
            }));
        }
        DrawingType::LongPosition | DrawingType::ShortPosition => {
            unreachable!("position handled above")
        }
    }
    Ok(commands)
}

fn percent_text(value: Option<f64>) -> String {
    value.map_or_else(
        || String::from("n/a"),
        |value| format!("{}%", to_precision(value, 6)),
    )
}

fn extended_segment<A: DrawingAxisView>(
    start: ScreenPoint,
    end: ScreenPoint,
    axis: &A,
    ray: bool,
) -> Vec<f64> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if dx == 0.0 && dy == 0.0 {
        return Vec::new();
    }
    let mut low = if ray { 0.0 } else { f64::NEG_INFINITY };
    let mut high = f64::INFINITY;
    for (origin, delta, min, max) in [
        (start.x, dx, axis.left(), axis.right()),
        (start.y, dy, axis.top(), axis.bottom()),
    ] {
        if delta == 0.0 {
            if origin < min || origin > max {
                return Vec::new();
            }
        } else {
            let first = (min - origin) / delta;
            let second = (max - origin) / delta;
            low = js_max(&[low, js_min(&[first, second])]);
            high = js_min(&[high, js_max(&[first, second])]);
        }
    }
    if low <= high {
        vec![
            start.x + dx * low,
            start.y + dy * low,
            start.x + dx * high,
            start.y + dy * high,
        ]
    } else {
        Vec::new()
    }
}

fn push_line(
    commands: &mut Vec<JsValue>,
    coordinates: Vec<f64>,
    color: &JsString,
    width: f64,
    clip: &[f64],
    dash: Option<[f64; 2]>,
) {
    if coordinates.is_empty() {
        return;
    }
    commands.push(object([
        ("op", text("lines")),
        ("coords", numbers(&coordinates)),
        ("color", JsValue::String(color.clone())),
        ("width", JsValue::Number(width)),
        ("clip", numbers(clip)),
        (
            "dash",
            dash.map_or(JsValue::Null, |values| numbers(&values)),
        ),
    ]));
}

fn text_command(x: f64, y: f64, value: &str, color: &JsString, clip: &[f64]) -> JsValue {
    object([
        ("op", text("text")),
        ("x", JsValue::Number(x)),
        ("y", JsValue::Number(y)),
        ("text", text(value)),
        ("color", JsValue::String(color.clone())),
        ("font", text("12px monospace")),
        ("clip", numbers(clip)),
    ])
}

struct BoxCommand<'a> {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    fill: &'a str,
    color: &'a JsString,
    stroke: f64,
    clip: &'a [f64],
}

fn position_box(input: BoxCommand<'_>) -> JsValue {
    object([
        ("op", text("box")),
        ("x", JsValue::Number(input.x)),
        ("y", JsValue::Number(input.y)),
        ("w", JsValue::Number(input.width)),
        ("h", JsValue::Number(input.height)),
        ("fill", text(input.fill)),
        ("color", JsValue::String(input.color.clone())),
        ("width", JsValue::Number(input.stroke)),
        ("clip", numbers(input.clip)),
    ])
}

struct ShapeCommand<'a> {
    kind: DrawingType,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: &'a JsString,
    stroke: f64,
    fill: Option<&'a JsString>,
    clip: &'a [f64],
}

fn shape_command(input: ShapeCommand<'_>) -> JsValue {
    object([
        (
            "op",
            text(if input.kind == DrawingType::Rectangle {
                "box"
            } else {
                "ellipse"
            }),
        ),
        ("x", JsValue::Number(input.x)),
        ("y", JsValue::Number(input.y)),
        ("w", JsValue::Number(input.width)),
        ("h", JsValue::Number(input.height)),
        ("color", JsValue::String(input.color.clone())),
        ("width", JsValue::Number(input.stroke)),
        (
            "fill",
            input
                .fill
                .map_or(JsValue::Undefined, |value| JsValue::String(value.clone())),
        ),
        ("clip", numbers(input.clip)),
    ])
}

fn numbers(values: &[f64]) -> JsValue {
    JsValue::Array(values.iter().copied().map(JsValue::Number).collect())
}

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut output = JsObject::new();
    for (key, value) in entries {
        output.insert(JsString::from_str(key), value);
    }
    JsValue::Object(output)
}
