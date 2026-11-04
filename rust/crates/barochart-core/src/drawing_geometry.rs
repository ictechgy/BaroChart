//! Renderer-neutral drawing geometry shared by scene generation and later M5 hit testing.

#![forbid(unsafe_code)]

use std::collections::VecDeque;
use std::ops::Deref;
use std::sync::{Arc, Weak};

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
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
    _key_memory: MemoryGroup,
    commands: Arc<OwnedDrawingGeometry>,
}

/// 캐시와 소비자가 Arc로 공유하는 한 drawing command payload다.
pub struct OwnedDrawingGeometry {
    commands: Vec<JsValue>,
    memory: MemoryGroup,
}

impl OwnedDrawingGeometry {
    /// command Vec와 DOM payload가 보유한 requested bytes다.
    pub fn requested_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }
}

impl Deref for OwnedDrawingGeometry {
    type Target = [JsValue];

    fn deref(&self) -> &Self::Target {
        &self.commands
    }
}

/// Per-chart bounded geometry cache. Dead drawing identities never match a later allocation.
pub struct DrawingGeometryCache {
    capacity: usize,
    entries: VecDeque<CacheEntry>,
    _entries_memory: MemoryGroup,
    memory: MemoryContext,
}

impl DrawingGeometryCache {
    pub fn new(capacity: usize) -> Self {
        Self::new_with_memory(
            capacity,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
        .expect("unaccounted drawing cache allocation failed")
    }

    /// 지정한 엔진 account에서 cache entry capacity를 allocation 전에 예약한다.
    pub fn new_with_memory(capacity: usize, memory: MemoryContext) -> Result<Self, JsError> {
        Ok(Self {
            capacity,
            entries: VecDeque::new(),
            _entries_memory: MemoryGroup::empty(memory.clone()),
            memory,
        })
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

    fn get(
        &mut self,
        drawing: &Arc<Drawing>,
        geometry_key: &JsString,
    ) -> Option<Arc<OwnedDrawingGeometry>> {
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
        commands: Arc<OwnedDrawingGeometry>,
    ) -> Result<(), JsError> {
        if self.capacity == 0 || geometry_key.as_units().is_empty() {
            return Ok(());
        }
        let mut scope = self.memory.scope();
        let geometry_key = geometry_key
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| self.memory.allocation_failure().into_js_error())?;
        let key_memory = scope
            .split_persistent(requested)
            .map_err(|failure| failure.into_js_error())?;
        self.purge_dead();
        while self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.ensure_entry_capacity()?;
        self.entries.push_back(CacheEntry {
            drawing: Arc::downgrade(drawing),
            geometry_key,
            _key_memory: key_memory,
            commands,
        });
        Ok(())
    }

    fn ensure_entry_capacity(&mut self) -> Result<(), JsError> {
        if self.entries.len() < self.entries.capacity() || self.entries.len() >= self.capacity {
            return Ok(());
        }
        let current = self.entries.capacity();
        let target = if current == 0 {
            1
        } else {
            std::cmp::min(current.saturating_mul(2), self.capacity)
        };
        let bytes = target
            .checked_mul(std::mem::size_of::<CacheEntry>())
            .ok_or_else(|| self.memory.allocation_failure().into_js_error())?;
        let mut next_memory = self
            .memory
            .reserve_group(bytes)
            .map_err(|failure| failure.into_js_error())?;
        let mut next = VecDeque::new();
        next.try_reserve_exact(target)
            .map_err(|_| self.memory.allocation_failure().into_js_error())?;
        let actual = next
            .capacity()
            .checked_mul(std::mem::size_of::<CacheEntry>())
            .ok_or_else(|| self.memory.allocation_failure().into_js_error())?;
        next_memory
            .try_resize(actual)
            .map_err(|failure| failure.into_js_error())?;
        next.append(&mut self.entries);
        self.entries = next;
        self._entries_memory = next_memory;
        Ok(())
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
) -> Result<Arc<OwnedDrawingGeometry>, JsError> {
    let key = layout.geometry_key();
    if !key.as_units().is_empty()
        && let Some(commands) = cache.get(drawing, key)
    {
        return Ok(commands);
    }
    let mut scope = cache.memory.scope();
    let mut temporary = cache.memory.scope();
    let commands = calculate_geometry_internal(
        drawing,
        model,
        current_view,
        current_store,
        layout,
        dialect,
        &mut scope,
        &mut temporary,
    )?;
    let requested = usize::try_from(scope.requested_bytes())
        .map_err(|_| cache.memory.allocation_failure().into_js_error())?;
    let memory = scope
        .split_persistent(requested)
        .map_err(|failure| failure.into_js_error())?;
    let commands = Arc::new(OwnedDrawingGeometry { commands, memory });
    cache.insert(drawing, key, Arc::clone(&commands))?;
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
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    let mut temporary = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    calculate_geometry_internal(
        drawing,
        model,
        current_view,
        current_store,
        layout,
        dialect,
        &mut scope,
        &mut temporary,
    )
}

/// Exact display-list projection을 scoped fallible allocation으로 만든다.
pub fn calculate_geometry_scoped<P: DrawingProjection>(
    drawing: &Drawing,
    model: &ModelState,
    current_view: VisibleRange,
    current_store: &BarStore,
    layout: &P,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Vec<JsValue>, JsError> {
    let mut temporary = MemoryScope::unaccounted(scope.allocation_failure().style());
    calculate_geometry_internal(
        drawing,
        model,
        current_view,
        current_store,
        layout,
        dialect,
        scope,
        &mut temporary,
    )
}

#[allow(clippy::too_many_arguments)]
fn calculate_geometry_internal<P: DrawingProjection>(
    drawing: &Drawing,
    model: &ModelState,
    current_view: VisibleRange,
    current_store: &BarStore,
    layout: &P,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
    temporary: &mut MemoryScope,
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
    let mut points = try_vec_capacity(drawing.points.len(), temporary)?;
    for point in drawing.points.iter() {
        points.push(layout.to_screen(
            current_view,
            current_store,
            point.time,
            point.price,
            &drawing.panel,
            drawing.axis_id.as_ref(),
        ));
    }
    if points
        .iter()
        .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Ok(Vec::new());
    }
    let a = points[0];
    let b = points.get(1).copied().unwrap_or(a);
    let c = points.get(2).copied().unwrap_or(b);
    let color = match drawing
        .style
        .as_ref()
        .and_then(|style| style.color.as_ref())
    {
        Some(color) => try_clone_string(color, temporary)?,
        None => JsString::try_from_str("#f5b85a", temporary)
            .map_err(|failure| failure.into_js_error())?,
    };
    let width = drawing
        .style
        .as_ref()
        .and_then(|style| style.width)
        .unwrap_or(1.5);
    let clip = [
        axis.left(),
        axis.top(),
        axis.right() - axis.left(),
        axis.bottom() - axis.top(),
    ];
    let mut commands = Vec::new();

    if drawing.kind.is_position() {
        let metrics = position_metrics_for(drawing)?;
        let extent = points[3];
        let target_fill = match drawing.style.as_ref().and_then(|style| style.fill.as_ref()) {
            Some(fill) => JsValue::String(try_clone_string(fill, scope)?),
            None => text("#26a69a44", scope)?,
        };
        for (level, fill) in [(b, text("#ef535044", scope)?), (c, target_fill)] {
            let command = position_box(
                BoxCommand {
                    x: a.x,
                    y: js_min(&[a.y, level.y]),
                    width: extent.x - a.x,
                    height: (a.y - level.y).abs(),
                    fill,
                    color: &color,
                    stroke: width,
                    clip: &clip,
                },
                scope,
            )?;
            push_command(&mut commands, command, scope)?;
        }
        push_line(
            &mut commands,
            f64_vec(&[a.x, a.y, extent.x, a.y], temporary)?,
            &color,
            width,
            &clip,
            None,
            scope,
        )?;
        let direction = if metrics.direction == "long" {
            "Long"
        } else {
            "Short"
        };
        for command in [
            text_command(
                a.x + 4.0,
                a.y - 4.0,
                &format!(
                    "{direction} entry {} · R/R {}",
                    number_to_string_with(metrics.entry, dialect),
                    to_precision(metrics.ratio, 6)
                ),
                &color,
                &clip,
                scope,
            )?,
            text_command(
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
                scope,
            )?,
            text_command(
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
                scope,
            )?,
        ] {
            push_command(&mut commands, command, scope)?;
        }
        return Ok(commands);
    }

    match drawing.kind {
        DrawingType::Horizontal => push_line(
            &mut commands,
            f64_vec(&[axis.left(), a.y, axis.right(), a.y], temporary)?,
            &color,
            width,
            &clip,
            None,
            scope,
        )?,
        DrawingType::Trendline | DrawingType::Measurement => {
            push_line(
                &mut commands,
                f64_vec(&[a.x, a.y, b.x, b.y], temporary)?,
                &color,
                width,
                &clip,
                None,
                scope,
            )?;
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
                let command = text_command(
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
                    scope,
                )?;
                push_command(&mut commands, command, scope)?;
            }
        }
        DrawingType::Ray | DrawingType::ExtendedLine => push_line(
            &mut commands,
            extended_segment(a, b, axis, drawing.kind == DrawingType::Ray, temporary)?,
            &color,
            width,
            &clip,
            None,
            scope,
        )?,
        DrawingType::Channel => {
            push_line(
                &mut commands,
                extended_segment(a, b, axis, false, temporary)?,
                &color,
                width,
                &clip,
                None,
                scope,
            )?;
            let parallel = ScreenPoint {
                x: c.x + b.x - a.x,
                y: c.y + b.y - a.y,
            };
            push_line(
                &mut commands,
                extended_segment(c, parallel, axis, false, temporary)?,
                &color,
                width,
                &clip,
                None,
                scope,
            )?;
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
                extended_segment(middle, middle_end, axis, false, temporary)?,
                &color,
                width,
                &clip,
                Some([4.0, 4.0]),
                scope,
            )?;
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
                    f64_vec(
                        &[
                            a.x,
                            y,
                            if drawing.kind == DrawingType::FibExtension {
                                axis.right()
                            } else {
                                b.x
                            },
                            y,
                        ],
                        temporary,
                    )?,
                    &color,
                    width,
                    &clip,
                    None,
                    scope,
                )?;
                let command = text_command(
                    js_min(&[a.x, b.x]) + 4.0,
                    y - 3.0,
                    &format!("{}%", to_fixed_with(ratio * 100.0, 1, dialect)),
                    &color,
                    &clip,
                    scope,
                )?;
                push_command(&mut commands, command, scope)?;
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
                        extended_segment(a, target, axis, true, temporary)?,
                        &color,
                        width,
                        &clip,
                        None,
                        scope,
                    )?;
                }
            }
            let command = text_command(a.x, a.y - 8.0, "38.2 / 50 / 61.8", &color, &clip, scope)?;
            push_command(&mut commands, command, scope)?;
        }
        DrawingType::FibTimezones => {
            for ratio in [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0] {
                let x = a.x + (b.x - a.x) * ratio;
                push_line(
                    &mut commands,
                    f64_vec(&[x, axis.top(), x, axis.bottom()], temporary)?,
                    &color,
                    width,
                    &clip,
                    None,
                    scope,
                )?;
                let command = text_command(
                    x + 3.0,
                    axis.top() + 28.0,
                    &number_to_string_with(ratio, dialect),
                    &color,
                    &clip,
                    scope,
                )?;
                push_command(&mut commands, command, scope)?;
            }
        }
        DrawingType::Freehand => {
            let coordinate_count = points.len().saturating_sub(1).saturating_mul(4);
            let mut coordinates = try_vec_capacity(coordinate_count, temporary)?;
            for pair in points.windows(2) {
                coordinates.extend([pair[0].x, pair[0].y, pair[1].x, pair[1].y]);
            }
            push_line(
                &mut commands,
                coordinates,
                &color,
                width,
                &clip,
                None,
                scope,
            )?;
        }
        DrawingType::Text => {
            let value = match drawing.text.as_ref() {
                Some(value) => try_clone_string(value, scope)?,
                None => JsString::try_from_str("Note", scope)
                    .map_err(|failure| failure.into_js_error())?,
            };
            let command = text_command_js(a.x, a.y, value, &color, &clip, scope)?;
            push_command(&mut commands, command, scope)?;
        }
        DrawingType::Rectangle | DrawingType::Ellipse => {
            let command = shape_command(
                ShapeCommand {
                    kind: drawing.kind,
                    x: js_min(&[a.x, b.x]),
                    y: js_min(&[a.y, b.y]),
                    width: (a.x - b.x).abs(),
                    height: (a.y - b.y).abs(),
                    color: &color,
                    stroke: width,
                    fill: drawing.style.as_ref().and_then(|style| style.fill.as_ref()),
                    clip: &clip,
                },
                scope,
            )?;
            push_command(&mut commands, command, scope)?;
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
    scope: &mut MemoryScope,
) -> Result<Vec<f64>, JsError> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if dx == 0.0 && dy == 0.0 {
        return Ok(Vec::new());
    }
    let mut low = if ray { 0.0 } else { f64::NEG_INFINITY };
    let mut high = f64::INFINITY;
    for (origin, delta, min, max) in [
        (start.x, dx, axis.left(), axis.right()),
        (start.y, dy, axis.top(), axis.bottom()),
    ] {
        if delta == 0.0 {
            if origin < min || origin > max {
                return Ok(Vec::new());
            }
        } else {
            let first = (min - origin) / delta;
            let second = (max - origin) / delta;
            low = js_max(&[low, js_min(&[first, second])]);
            high = js_min(&[high, js_max(&[first, second])]);
        }
    }
    if low <= high {
        f64_vec(
            &[
                start.x + dx * low,
                start.y + dy * low,
                start.x + dx * high,
                start.y + dy * high,
            ],
            scope,
        )
    } else {
        Ok(Vec::new())
    }
}

fn push_line(
    commands: &mut Vec<JsValue>,
    coordinates: Vec<f64>,
    color: &JsString,
    width: f64,
    clip: &[f64],
    dash: Option<[f64; 2]>,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if coordinates.is_empty() {
        return Ok(());
    }
    let dash = match dash {
        Some(values) => numbers(&values, scope)?,
        None => JsValue::Null,
    };
    let command = object(
        [
            ("op", text("lines", scope)?),
            ("coords", numbers(&coordinates, scope)?),
            ("color", JsValue::String(try_clone_string(color, scope)?)),
            ("width", JsValue::Number(width)),
            ("clip", numbers(clip, scope)?),
            ("dash", dash),
        ],
        scope,
    )?;
    push_command(commands, command, scope)
}

fn text_command(
    x: f64,
    y: f64,
    value: &str,
    color: &JsString,
    clip: &[f64],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let value = JsString::try_from_str(value, scope).map_err(|failure| failure.into_js_error())?;
    text_command_js(x, y, value, color, clip, scope)
}

fn text_command_js(
    x: f64,
    y: f64,
    value: JsString,
    color: &JsString,
    clip: &[f64],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    object(
        [
            ("op", text("text", scope)?),
            ("x", JsValue::Number(x)),
            ("y", JsValue::Number(y)),
            ("text", JsValue::String(value)),
            ("color", JsValue::String(try_clone_string(color, scope)?)),
            ("font", text("12px monospace", scope)?),
            ("clip", numbers(clip, scope)?),
        ],
        scope,
    )
}

struct BoxCommand<'a> {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    fill: JsValue,
    color: &'a JsString,
    stroke: f64,
    clip: &'a [f64],
}

fn position_box(input: BoxCommand<'_>, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    object(
        [
            ("op", text("box", scope)?),
            ("x", JsValue::Number(input.x)),
            ("y", JsValue::Number(input.y)),
            ("w", JsValue::Number(input.width)),
            ("h", JsValue::Number(input.height)),
            ("fill", input.fill),
            (
                "color",
                JsValue::String(try_clone_string(input.color, scope)?),
            ),
            ("width", JsValue::Number(input.stroke)),
            ("clip", numbers(input.clip, scope)?),
        ],
        scope,
    )
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

fn shape_command(input: ShapeCommand<'_>, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let fill = match input.fill {
        Some(value) => JsValue::String(try_clone_string(value, scope)?),
        None => JsValue::Undefined,
    };
    object(
        [
            (
                "op",
                text(
                    if input.kind == DrawingType::Rectangle {
                        "box"
                    } else {
                        "ellipse"
                    },
                    scope,
                )?,
            ),
            ("x", JsValue::Number(input.x)),
            ("y", JsValue::Number(input.y)),
            ("w", JsValue::Number(input.width)),
            ("h", JsValue::Number(input.height)),
            (
                "color",
                JsValue::String(try_clone_string(input.color, scope)?),
            ),
            ("width", JsValue::Number(input.stroke)),
            ("fill", fill),
            ("clip", numbers(input.clip, scope)?),
        ],
        scope,
    )
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

fn text(value: &str, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    JsString::try_from_str(value, scope)
        .map(JsValue::String)
        .map_err(|failure| failure.into_js_error())
}

fn object<const N: usize>(
    entries: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut output = try_vec_capacity(N, scope)?;
    for (key, value) in entries {
        output.push((
            JsString::try_from_str(key, scope).map_err(|failure| failure.into_js_error())?,
            value,
        ));
    }
    JsObject::try_from_entries_scoped(output, scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())
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

fn try_clone_string(value: &JsString, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    value
        .try_clone_scoped(scope)
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
