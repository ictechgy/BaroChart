//! Renderer-independent drawing selection using the shared drawing geometry leaf.

#![forbid(unsafe_code)]

use std::sync::{Arc, Weak};

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::math::js_hypot;
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::JsString;

use crate::data::BarStore;
use crate::drawing_geometry::{DrawingGeometryCache, DrawingProjection, drawing_geometry};
use crate::drawing_types::{Drawing, DrawingType};
use crate::drawings::DrawingStore;
use crate::layout::Layout;
use crate::model_state::{ModelState, VisibleRange};

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn object_field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    let JsValue::Object(object) = value else {
        return None;
    };
    object.get(&JsString::from_str(name))
}

/// Selection result returned to the interaction state machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawingHit {
    /// Hit drawing identifier.
    pub id: JsString,
    /// Anchor handle, or `-1` for the drawing body.
    pub handle: i32,
    /// Whether the body hit is locked. Handle hits are always unlocked.
    pub locked: bool,
}

impl DrawingHit {
    /// Serializes the JS result shape; handle hits omit the body-only `locked` key.
    pub fn to_js_value(&self) -> JsValue {
        let mut result = JsObject::new();
        result.insert(JsString::from_str("id"), JsValue::String(self.id.clone()));
        result.insert(
            JsString::from_str("handle"),
            JsValue::Number(f64::from(self.handle)),
        );
        if self.handle < 0 {
            result.insert(JsString::from_str("locked"), JsValue::Bool(self.locked));
        }
        JsValue::Object(result)
    }
}

#[derive(Clone, Copy, Debug)]
struct DrawingBounds {
    time_min: f64,
    time_max: f64,
    price_min: f64,
    price_max: f64,
}

#[derive(Clone)]
struct BoundsEntry {
    drawing: Weak<Drawing>,
    bounds: DrawingBounds,
}

/// Weak-identity cache for immutable drawing domain bounds used by hit filtering.
pub struct DrawingHitTestCache {
    entries: Vec<BoundsEntry>,
    memory: MemoryGroup,
}

impl Default for DrawingHitTestCache {
    fn default() -> Self {
        Self::new()
    }
}

impl DrawingHitTestCache {
    /// Creates an empty drawing-bounds cache.
    pub fn new() -> Self {
        Self::new_with_memory(MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized))
    }

    /// 지정 엔진 memory context에 연결한 빈 drawing-bounds cache를 만든다.
    pub fn new_with_memory(memory: MemoryContext) -> Self {
        Self {
            entries: Vec::new(),
            memory: MemoryGroup::empty(memory),
        }
    }

    /// Number of currently live drawing identities in the cache.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn bounds(&mut self, drawing: &Arc<Drawing>) -> Result<DrawingBounds, JsError> {
        self.entries
            .retain(|entry| entry.drawing.strong_count() > 0);
        if let Some(entry) = self.entries.iter().find(|entry| {
            entry
                .drawing
                .upgrade()
                .is_some_and(|cached| Arc::ptr_eq(&cached, drawing))
        }) {
            return Ok(entry.bounds);
        }
        let mut bounds = DrawingBounds {
            time_min: f64::INFINITY,
            time_max: f64::NEG_INFINITY,
            price_min: f64::INFINITY,
            price_max: f64::NEG_INFINITY,
        };
        for point in drawing.points.iter() {
            bounds.time_min = js_min(&[bounds.time_min, point.time]);
            bounds.time_max = js_max(&[bounds.time_max, point.time]);
            bounds.price_min = js_min(&[bounds.price_min, point.price]);
            bounds.price_max = js_max(&[bounds.price_max, point.price]);
        }
        if self.entries.len() == self.entries.capacity() {
            let capacity = std::cmp::max(
                std::cmp::max(self.entries.len().saturating_add(1), 4),
                self.entries
                    .capacity()
                    .checked_mul(2)
                    .ok_or_else(|| self.memory.context().allocation_failure().into_js_error())?,
            );
            let (mut entries, memory) = self
                .memory
                .context()
                .try_vec_capacity(capacity)
                .map_err(|failure| failure.into_js_error())?;
            entries.extend(self.entries.iter().cloned());
            self.entries = entries;
            self.memory = memory;
        }
        self.entries.push(BoundsEntry {
            drawing: Arc::downgrade(drawing),
            bounds,
        });
        Ok(bounds)
    }
}

/// Tests a pointer against visible drawings in reverse painter order.
#[allow(clippy::too_many_arguments)]
pub fn drawing_hit_test(
    store: &DrawingStore,
    model: &ModelState,
    layout: &Layout,
    current_view: VisibleRange,
    current_store: &BarStore,
    bounds_cache: &mut DrawingHitTestCache,
    geometry_cache: &mut DrawingGeometryCache,
    x: f64,
    y: f64,
    tolerance: f64,
    dialect: NumberDialect,
) -> Result<Option<DrawingHit>, JsError> {
    if !tolerance.is_finite() || !(1.0..=32.0).contains(&tolerance) {
        return Err(range_error(
            "Drawing hit tolerance must be 1..32 logical pixels",
        ));
    }
    let mut coercion_scope = store.memory_context().scope();
    let Some(panel) = layout
        .panels
        .iter()
        .find(|panel| y >= panel.top && y <= panel.bottom && x >= panel.left && x <= panel.right)
    else {
        return Ok(None);
    };
    let (mut ordered, _ordered_memory) = store
        .memory_context()
        .try_vec_capacity(store.items().len())
        .map_err(|failure| failure.into_js_error())?;
    ordered.extend(
        store
            .items()
            .iter()
            .rev()
            .filter(|drawing| drawing.visible != Some(false))
            .filter(|drawing| {
                !drawing.kind.is_position()
                    || drawing.points.iter().all(|point| {
                        let screen = layout.to_screen(
                            current_view,
                            current_store,
                            point.time,
                            point.price,
                            &drawing.panel,
                            drawing.axis_id.as_ref(),
                        );
                        screen.x.is_finite() && screen.y.is_finite()
                    })
            }),
    );

    if let Some(selected) = store.selected().and_then(|selected| {
        ordered
            .iter()
            .find(|drawing| drawing.id == *selected)
            .copied()
    }) && layout
        .drawing_axis(
            model,
            &selected.panel,
            selected.axis_id.as_ref(),
            selected.series_id.as_ref(),
        )
        .is_some()
        && selected.locked != Some(true)
        && selected.panel == panel.id
    {
        let mut handle = -1;
        let mut distance = f64::INFINITY;
        for (index, point) in selected.points.iter().enumerate() {
            let screen = layout.to_screen(
                current_view,
                current_store,
                point.time,
                point.price,
                &selected.panel,
                selected.axis_id.as_ref(),
            );
            let candidate = js_hypot(screen.x - x, screen.y - y);
            if candidate <= tolerance && candidate < distance {
                handle = index as i32;
                distance = candidate;
            }
        }
        if handle >= 0 {
            return Ok(Some(DrawingHit {
                id: selected.id.clone(),
                handle,
                locked: false,
            }));
        }
    }

    for drawing in ordered {
        let width = drawing
            .style
            .as_ref()
            .and_then(|style| style.width)
            .unwrap_or(1.5);
        let body_tolerance = if drawing.kind == DrawingType::Text {
            tolerance
        } else {
            js_max(&[tolerance, width / 2.0])
        };
        if layout
            .drawing_axis(
                model,
                &drawing.panel,
                drawing.axis_id.as_ref(),
                drawing.series_id.as_ref(),
            )
            .is_none()
            || drawing.panel != panel.id
            || !candidate_bounds(
                drawing,
                layout,
                current_view,
                current_store,
                bounds_cache,
                x,
                y,
                body_tolerance,
                dialect,
                &mut coercion_scope,
            )?
        {
            continue;
        }
        let point = |index: usize| {
            let anchor = drawing.points.get(index).unwrap_or(&drawing.points[0]);
            layout.to_screen(
                current_view,
                current_store,
                anchor.time,
                anchor.price,
                &drawing.panel,
                drawing.axis_id.as_ref(),
            )
        };
        let a = point(0);
        let b = point(1);
        let hit = match drawing.kind {
            DrawingType::LongPosition | DrawingType::ShortPosition => {
                let stop = point(1);
                let target = point(2);
                let extent = point(3);
                x >= a.x - body_tolerance
                    && x <= extent.x + body_tolerance
                    && y >= js_min(&[stop.y, target.y]) - body_tolerance
                    && y <= js_max(&[stop.y, target.y]) + body_tolerance
            }
            DrawingType::Horizontal => (y - a.y).abs() <= body_tolerance,
            DrawingType::Text => {
                let font = drawing_font(drawing, layout)?;
                let metrics = text_metrics(&font, dialect, &mut coercion_scope)?;
                let text = drawing.text.as_ref();
                let width = text.map_or(4, JsString::len_utf16) as f64 * metrics.size * 1.2;
                x >= a.x - tolerance
                    && x <= a.x + width + tolerance
                    && y >= a.y - metrics.ascent - tolerance
                    && y <= a.y + metrics.descent + tolerance
            }
            DrawingType::Rectangle => {
                let left = js_min(&[a.x, b.x]);
                let right = js_max(&[a.x, b.x]);
                let top = js_min(&[a.y, b.y]);
                let bottom = js_max(&[a.y, b.y]);
                x >= left - body_tolerance
                    && x <= right + body_tolerance
                    && y >= top - body_tolerance
                    && y <= bottom + body_tolerance
                    && [
                        (x - left).abs(),
                        (x - right).abs(),
                        (y - top).abs(),
                        (y - bottom).abs(),
                    ]
                    .into_iter()
                    .fold(f64::INFINITY, |minimum, value| js_min(&[minimum, value]))
                        <= body_tolerance
            }
            DrawingType::Ellipse => {
                let difference_x = b.x - a.x;
                let difference_y = b.y - a.y;
                let sum_x = a.x + b.x;
                let sum_y = a.y + b.y;
                let radius_x = if difference_x.is_finite() {
                    difference_x.abs() / 2.0
                } else {
                    (a.x / 2.0 - b.x / 2.0).abs()
                };
                let radius_y = if difference_y.is_finite() {
                    difference_y.abs() / 2.0
                } else {
                    (a.y / 2.0 - b.y / 2.0).abs()
                };
                if radius_x != 0.0 && radius_y != 0.0 {
                    let center_x = if sum_x.is_finite() {
                        sum_x / 2.0
                    } else {
                        a.x / 2.0 + b.x / 2.0
                    };
                    let center_y = if sum_y.is_finite() {
                        sum_y / 2.0
                    } else {
                        a.y / 2.0 + b.y / 2.0
                    };
                    ellipse_distance(x, y, center_x, center_y, radius_x, radius_y) <= body_tolerance
                } else if radius_x != 0.0 || radius_y != 0.0 {
                    segment_distance(x, y, a, b) <= body_tolerance
                } else {
                    false
                }
            }
            _ => {
                let commands = drawing_geometry(
                    geometry_cache,
                    drawing,
                    model,
                    current_view,
                    current_store,
                    layout,
                    dialect,
                )?;
                geometry_lines_hit(&commands, x, y, body_tolerance)
            }
        };
        if hit {
            return Ok(Some(DrawingHit {
                id: drawing.id.clone(),
                handle: -1,
                locked: drawing.locked == Some(true),
            }));
        }
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
fn candidate_bounds<P: DrawingProjection>(
    drawing: &Arc<Drawing>,
    layout: &P,
    current_view: VisibleRange,
    current_store: &BarStore,
    bounds_cache: &mut DrawingHitTestCache,
    x: f64,
    y: f64,
    tolerance: f64,
    dialect: NumberDialect,
    coercion_scope: &mut MemoryScope,
) -> Result<bool, JsError> {
    if !matches!(
        drawing.kind,
        DrawingType::Freehand
            | DrawingType::Trendline
            | DrawingType::Rectangle
            | DrawingType::Ellipse
            | DrawingType::Text
            | DrawingType::Measurement
    ) {
        return Ok(true);
    }
    let bounds = bounds_cache.bounds(drawing)?;
    let a = layout.to_screen(
        current_view,
        current_store,
        bounds.time_min,
        bounds.price_min,
        &drawing.panel,
        drawing.axis_id.as_ref(),
    );
    let b = layout.to_screen(
        current_view,
        current_store,
        bounds.time_max,
        bounds.price_max,
        &drawing.panel,
        drawing.axis_id.as_ref(),
    );
    let font = drawing_font(drawing, layout)?;
    let size = text_metrics(&font, dialect, coercion_scope)?.size;
    let text_width = if drawing.kind == DrawingType::Text {
        drawing.text.as_ref().map_or(4, JsString::len_utf16) as f64 * size * 1.2
    } else {
        0.0
    };
    let label_height = if matches!(drawing.kind, DrawingType::Text | DrawingType::Measurement) {
        size * 2.0
    } else {
        0.0
    };
    Ok(x >= js_min(&[a.x, b.x]) - tolerance
        && x <= js_max(&[a.x, b.x]) + tolerance + text_width
        && y >= js_min(&[a.y, b.y]) - tolerance - label_height
        && y <= js_max(&[a.y, b.y]) + tolerance + label_height)
}

fn drawing_font<P: DrawingProjection>(drawing: &Drawing, layout: &P) -> Result<JsString, JsError> {
    if let Some(font) = drawing.style.as_ref().and_then(|style| style.font.as_ref()) {
        return Ok(font.clone());
    }
    match layout.geometry_font() {
        JsValue::String(font) => Ok(font.clone()),
        _ => Err(type_error("font.match is not a function")),
    }
}

fn text_metrics(
    font: &JsString,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<crate::labels::LabelMetrics, JsError> {
    crate::labels::label_metrics_scoped(&JsValue::String(font.clone()), dialect, scope)
}

fn ellipse_distance(
    x: f64,
    y: f64,
    center_x: f64,
    center_y: f64,
    radius_x: f64,
    radius_y: f64,
) -> f64 {
    let offset_x = (x - center_x).abs();
    let offset_y = (y - center_y).abs();
    let x_major = radius_x >= radius_y;
    let major_radius = if x_major { radius_x } else { radius_y };
    let minor_radius = if x_major { radius_y } else { radius_x };
    let major_point = if x_major { offset_x } else { offset_y };
    let minor_point = if x_major { offset_y } else { offset_x };

    // An interior point on the major axis can be closest to either of two
    // symmetric off-axis points, rather than to the major endpoint.
    if minor_point == 0.0 {
        let threshold = major_radius - minor_radius * (minor_radius / major_radius);
        if major_point < threshold {
            let ratio = major_point / threshold;
            let closest_major = major_radius * ratio;
            let closest_minor = minor_radius * js_max(&[0.0, 1.0 - ratio * ratio]).sqrt();
            return js_hypot(major_point - closest_major, closest_minor);
        }
        return (major_point - major_radius).abs();
    }
    if major_point == 0.0 {
        return (minor_point - minor_radius).abs();
    }

    let normalized_major = major_point / major_radius;
    let normalized_minor = minor_point / minor_radius;
    let aspect = major_radius / minor_radius;
    let aspect_squared = js_min(&[aspect * aspect, f64::MAX]);
    let normalized_length = js_hypot(normalized_major, normalized_minor);
    if normalized_length == 1.0 {
        return 0.0;
    }

    let mut low = 0.0;
    let mut high;
    if normalized_length < 1.0 {
        // In minor-radius-squared units the unique Lagrange multiplier lies in
        // (normalized_minor - 1, 0) for every interior off-axis point.
        low = normalized_minor - 1.0;
        high = 0.0;
        for _ in 0..64 {
            let middle = (low + high) / 2.0;
            let major_term = normalized_major / (1.0 + middle / aspect_squared);
            let minor_term = normalized_minor / (1.0 + middle);
            if js_hypot(major_term, minor_term) > 1.0 {
                low = middle;
            } else {
                high = middle;
            }
        }
        let multiplier = (low + high) / 2.0;
        return js_hypot(
            major_point - major_point / (1.0 + multiplier / aspect_squared),
            minor_point - minor_point / (1.0 + multiplier),
        );
    }

    if normalized_major < 1.0 {
        // At this finite upper bound the minor term alone fills the remaining
        // unit-circle component; the major term only shrinks as s increases.
        high = normalized_minor / (1.0 - normalized_major * normalized_major).sqrt() - 1.0;
        for _ in 0..64 {
            let middle = (low + high) / 2.0;
            let major_term = normalized_major / (1.0 + middle / aspect_squared);
            let minor_term = normalized_minor / (1.0 + middle);
            if js_hypot(major_term, minor_term) > 1.0 {
                low = middle;
            } else {
                high = middle;
            }
        }
        let multiplier = (low + high) / 2.0;
        return js_hypot(
            major_point - major_point / (1.0 + multiplier / aspect_squared),
            minor_point - minor_point / (1.0 + multiplier),
        );
    }

    // Exterior points at or beyond the major endpoint use a major-radius
    // scaled multiplier, avoiding overflow at very high aspect ratios.
    let scaled_minor = normalized_minor / aspect_squared;
    high = js_hypot(normalized_major, scaled_minor);
    if !high.is_finite() {
        return f64::INFINITY;
    }
    for _ in 0..64 {
        let middle = (low + high) / 2.0;
        let major_term = normalized_major / (1.0 + middle);
        let minor_term = normalized_minor / (1.0 + aspect_squared * middle);
        if js_hypot(major_term, minor_term) > 1.0 {
            low = middle;
        } else {
            high = middle;
        }
    }
    let multiplier = (low + high) / 2.0;
    js_hypot(
        major_point - major_point / (1.0 + multiplier),
        minor_point - minor_point / (1.0 + aspect_squared * multiplier),
    )
}

fn segment_distance(
    x: f64,
    y: f64,
    a: crate::layout::ScreenPoint,
    b: crate::layout::ScreenPoint,
) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let denominator = dx * dx + dy * dy;
    let denominator = if denominator == 0.0 || denominator.is_nan() {
        1.0
    } else {
        denominator
    };
    let numerator = (x - a.x) * dx + (y - a.y) * dy;
    let t = js_max(&[0.0, js_min(&[1.0, numerator / denominator])]);
    js_hypot(x - a.x - t * dx, y - a.y - t * dy)
}

fn geometry_lines_hit(commands: &[JsValue], x: f64, y: f64, tolerance: f64) -> bool {
    for command in commands {
        if !matches!(object_field(command, "op"), Some(JsValue::String(op)) if op == &JsString::from_str("lines"))
        {
            continue;
        }
        let Some(JsValue::Array(coordinates)) = object_field(command, "coords") else {
            continue;
        };
        let (chunks, _) = coordinates.as_chunks::<4>();
        for [x1, y1, x2, y2] in chunks {
            let (
                JsValue::Number(x1),
                JsValue::Number(y1),
                JsValue::Number(x2),
                JsValue::Number(y2),
            ) = (x1, y1, x2, y2)
            else {
                continue;
            };
            if segment_distance(
                x,
                y,
                crate::layout::ScreenPoint { x: *x1, y: *y1 },
                crate::layout::ScreenPoint { x: *x2, y: *y2 },
            ) <= tolerance
            {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod hit_tests {
    use super::*;
    use std::f64::consts::PI;

    use barochart_js::json::{JsonMode, parse_json};

    use crate::data::{Bar, ModelDataState, StoreOptions};
    use crate::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
    use crate::model_state::ModelContext;
    use crate::series_cache::SeriesCaches;
    use crate::{Host, HostError};

    struct NoZones;

    impl Host for NoZones {
        fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
            Err(HostError)
        }

        fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
            Err(HostError)
        }

        fn log(&self, _: i32, _: &str) {}
    }

    fn parse(source: &str) -> JsValue {
        parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
    }

    fn bar(index: usize) -> Bar {
        let price = 100.0 + index as f64;
        Bar {
            time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
            open: price,
            high: price + 2.0,
            low: price - 2.0,
            close: price,
            volume: 100.0,
        }
    }

    fn drawing_value(a: crate::layout::ScreenPrice, b: crate::layout::ScreenPrice) -> JsValue {
        parse(&format!(
            r#"{{"type":"ellipse","panel":"price","points":[{{"time":{},"price":{}}},{{"time":{},"price":{}}}],"style":{{"width":1.5}}}}"#,
            a.time, a.price, b.time, b.price
        ))
    }

    // This is independent from the production Lagrange-multiplier solver. A
    // sampled distance is an upper bound, and half the maximum intervening arc
    // length bounds how much smaller the continuous minimum can be.
    fn sampled_distance_interval(
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
        x: f64,
        y: f64,
    ) -> (f64, f64) {
        const SAMPLES: usize = 1 << 18;
        let mut upper = f64::INFINITY;
        for index in 0..SAMPLES {
            let angle = 2.0 * PI * index as f64 / SAMPLES as f64;
            let (sine, cosine) = angle.sin_cos();
            upper = js_min(&[
                upper,
                js_hypot(
                    x - (center_x + radius_x * cosine),
                    y - (center_y + radius_y * sine),
                ),
            ]);
        }
        let gap = js_max(&[radius_x, radius_y]) * PI / SAMPLES as f64;
        (js_max(&[upper - gap, 0.0]), upper)
    }

    #[test]
    fn high_aspect_ellipse_hit_path_uses_euclidean_outline_distance() {
        let data =
            ModelDataState::new(StoreOptions::default(), (0..100).map(bar).collect()).unwrap();
        let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
        model
            .add_series(
                &parse(r#"{"id":"bars","type":"candles","panel":"price"}"#),
                &ModelContext::plain(data.store()),
            )
            .unwrap();
        let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
        let mut series_caches = SeriesCaches::new();
        let layout = crate::layout::create_layout(
            &mut model,
            data.store(),
            &mut indicators,
            &NoZones,
            &mut series_caches,
            1_200.0,
            700.0,
        )
        .unwrap();
        let panel = &layout.panels[0];
        let center_x = (panel.left + panel.right) / 2.0;
        let center_y = (panel.top + panel.bottom) / 2.0;

        for horizontal in [true, false] {
            let radius_x = if horizontal {
                (panel.right - panel.left) * 0.4
            } else {
                4.0
            };
            let radius_y = if horizontal {
                4.0
            } else {
                (panel.bottom - panel.top) * 0.4
            };
            let screen_a = (center_x - radius_x, center_y - radius_y);
            let screen_b = (center_x + radius_x, center_y + radius_y);
            let panel_id = &panel.id;
            let a = layout
                .from_screen(
                    model.view,
                    data.store(),
                    screen_a.0,
                    screen_a.1,
                    panel_id,
                    None,
                )
                .unwrap();
            let b = layout
                .from_screen(
                    model.view,
                    data.store(),
                    screen_b.0,
                    screen_b.1,
                    panel_id,
                    None,
                )
                .unwrap();
            let mut drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
            let id = drawings.add(&drawing_value(a, b)).unwrap();
            drawings.select(None).unwrap();
            let drawing = &drawings.items()[0];
            let projected_a = layout.to_screen(
                model.view,
                data.store(),
                drawing.points[0].time,
                drawing.points[0].price,
                panel_id,
                None,
            );
            let projected_b = layout.to_screen(
                model.view,
                data.store(),
                drawing.points[1].time,
                drawing.points[1].price,
                panel_id,
                None,
            );
            let actual_center_x = (projected_a.x + projected_b.x) / 2.0;
            let actual_center_y = (projected_a.y + projected_b.y) / 2.0;
            let actual_radius_x = (projected_b.x - projected_a.x).abs() / 2.0;
            let actual_radius_y = (projected_b.y - projected_a.y).abs() / 2.0;
            let (far_x, far_y, near_x, near_y) = if horizontal {
                (
                    actual_center_x + actual_radius_x * 0.9,
                    actual_center_y,
                    actual_center_x + actual_radius_x * 0.9,
                    actual_center_y + actual_radius_y * 0.4,
                )
            } else {
                (
                    actual_center_x,
                    actual_center_y + actual_radius_y * 0.9,
                    actual_center_x + actual_radius_x * 0.4,
                    actual_center_y + actual_radius_y * 0.9,
                )
            };
            let far_interval = sampled_distance_interval(
                actual_center_x,
                actual_center_y,
                actual_radius_x,
                actual_radius_y,
                far_x,
                far_y,
            );
            let near_interval = sampled_distance_interval(
                actual_center_x,
                actual_center_y,
                actual_radius_x,
                actual_radius_y,
                near_x,
                near_y,
            );
            assert!(far_interval.0 > 1.0, "far interval: {far_interval:?}");
            assert!(near_interval.1 < 1.0, "near interval: {near_interval:?}");

            let mut bounds_cache = DrawingHitTestCache::new();
            let mut geometry_cache = DrawingGeometryCache::new(32);
            assert_eq!(
                drawing_hit_test(
                    &drawings,
                    &model,
                    &layout,
                    model.view,
                    data.store(),
                    &mut bounds_cache,
                    &mut geometry_cache,
                    far_x,
                    far_y,
                    1.0,
                    NumberDialect::PLATFORM,
                )
                .unwrap(),
                None
            );
            assert_eq!(
                drawing_hit_test(
                    &drawings,
                    &model,
                    &layout,
                    model.view,
                    data.store(),
                    &mut bounds_cache,
                    &mut geometry_cache,
                    near_x,
                    near_y,
                    1.0,
                    NumberDialect::PLATFORM,
                )
                .unwrap()
                .map(|hit| hit.id),
                Some(id)
            );
        }
    }
}

#[cfg(test)]
mod memory_tests {
    use super::*;
    use crate::drawing_types::{DrawingPoint, DrawingPoints};
    use barochart_js::memory::{MemoryAccount, oom_style_from_error};

    fn drawing() -> Arc<Drawing> {
        Arc::new(Drawing::from_parts_unaccounted(
            &JsString::from_str("cached"),
            &JsString::from_str("price"),
            Some(false),
            None,
            DrawingType::Freehand,
            DrawingPoints::from_vec_unaccounted(vec![
                DrawingPoint {
                    time: 1.0,
                    price: 2.0,
                },
                DrawingPoint {
                    time: 3.0,
                    price: 4.0,
                },
            ]),
            None,
            Some(true),
            None,
            None,
        ))
    }

    #[test]
    fn cache_growth_is_fallible_atomic_and_releases_on_drop() {
        let denied = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
        let mut cache = DrawingHitTestCache::new_with_memory(MemoryContext::accounted(&denied));
        let error = cache.bounds(&drawing()).unwrap_err();
        assert_eq!(
            oom_style_from_error(&error),
            Some(OomStyle::InternalErrorLowercase)
        );
        assert!(cache.is_empty());
        assert_eq!(denied.snapshot().requested_live_bytes, 0);

        let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let mut cache = DrawingHitTestCache::new_with_memory(MemoryContext::accounted(&account));
        let drawing = drawing();
        let first = cache.bounds(&drawing).unwrap();
        let retained = account.snapshot().requested_live_bytes;
        assert!(retained > 0);
        assert_eq!(cache.bounds(&drawing).unwrap().time_min, first.time_min);
        assert_eq!(account.snapshot().requested_live_bytes, retained);
        drop(cache);
        assert_eq!(account.snapshot().requested_live_bytes, 0);
    }
}
