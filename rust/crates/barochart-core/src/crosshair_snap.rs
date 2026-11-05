//! Pointer-owned crosshair snap requests and prepared-layout OHLC resolution.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

use crate::contracts::{identifier, option_record};
use crate::data::BarStore;
use crate::layout::Layout;
use crate::model_state::{ModelState, SeriesKind};
use crate::scene::ResolvedCrosshair;

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(object) => Some(object),
        _ => None,
    }
}

fn field<'a>(object: &'a JsObject, name: &str) -> Option<&'a JsValue> {
    object.get(&key(name))
}

fn ascii_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

/// Requested crosshair selection mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrosshairSnapMode {
    /// Preserve pointer coordinates without OHLC snapping.
    Free,
    /// Snap to the visible close of the nearest candidate bar.
    Close,
    /// Snap to the nearest visible OHLC field of the nearest candidate bar.
    Ohlc,
}

impl CrosshairSnapMode {
    fn as_js(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Close => "close",
            Self::Ohlc => "ohlc",
        }
    }
}

/// Validated panel/axis/series binding used by crosshair snapping.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrosshairSnapTarget {
    /// Target panel.
    pub panel: JsString,
    /// Optional bound axis id; `None` selects the panel's base axis.
    pub axis_id: Option<JsString>,
    /// Optional required OHLC series id.
    pub series_id: Option<JsString>,
}

/// Crosshair snap settings stored by one interaction controller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrosshairSnapOptions {
    /// Close-only, OHLC, or free cursor mode.
    pub mode: CrosshairSnapMode,
    /// Optional explicit target. Without one, resolution uses the hovered panel.
    pub target: Option<CrosshairSnapTarget>,
}

impl Default for CrosshairSnapOptions {
    fn default() -> Self {
        Self {
            mode: CrosshairSnapMode::Free,
            target: None,
        }
    }
}

impl CrosshairSnapOptions {
    /// Preserves source property order and null-normalizes optional target bindings.
    pub fn to_js_value(&self) -> JsValue {
        let mut object = JsObject::new();
        object.insert(
            key("mode"),
            JsValue::String(JsString::from_str(self.mode.as_js())),
        );
        let target = self.target.as_ref().map_or(JsValue::Null, |target| {
            let mut object = JsObject::new();
            object.insert(key("panel"), JsValue::String(target.panel.clone()));
            object.insert(
                key("axisId"),
                target
                    .axis_id
                    .clone()
                    .map_or(JsValue::Null, JsValue::String),
            );
            object.insert(
                key("seriesId"),
                target
                    .series_id
                    .clone()
                    .map_or(JsValue::Null, JsValue::String),
            );
            JsValue::Object(object)
        });
        object.insert(key("target"), target);
        JsValue::Object(object)
    }
}

/// Raw pointer coordinates with the snap request captured when the pointer moved.
#[derive(Clone, Debug, PartialEq)]
pub struct CrosshairCursor {
    /// Current raw pointer x coordinate.
    pub x: f64,
    /// Current raw pointer y coordinate.
    pub y: f64,
    /// Request associated with this exact pointer cursor, if it remains owned.
    pub request: Option<CrosshairSnapOptions>,
    /// Controller-local opaque identity corresponding to the JS WeakMap key.
    pub identity: u64,
}

/// Full resolved crosshair snapshot before projecting to the scene DTO.
#[derive(Clone, Debug, PartialEq)]
pub struct CrosshairResolution {
    /// Mode associated with the current pointer request.
    pub mode: CrosshairSnapMode,
    /// Raw pointer coordinates.
    pub raw: [f64; 2],
    /// Resolved pointer coordinates.
    pub resolved: [f64; 2],
    /// Hovered panel id.
    pub panel: JsString,
    /// Whether a bar/field was selected.
    pub snapped: bool,
    /// Source result reason.
    pub reason: &'static str,
    /// Selected raw store index.
    pub index: Option<usize>,
    /// Selected raw bar time.
    pub time: Option<f64>,
    /// Selected raw OHLC field name.
    pub field: Option<JsString>,
    /// Selected raw price.
    pub price: Option<f64>,
    /// Selected series axis id.
    pub axis_id: Option<JsString>,
    /// Selected OHLC series id.
    pub series_id: Option<JsString>,
    /// Store version used for the selection.
    pub store_version: Option<f64>,
}

impl CrosshairResolution {
    /// Projects the resolved pointer into the immutable scene boundary DTO.
    pub fn to_scene_crosshair(&self) -> ResolvedCrosshair {
        ResolvedCrosshair {
            x: self.resolved[0],
            y: self.resolved[1],
            panel: self.panel.clone(),
            snapped: self.snapped,
            axis_id: self.axis_id.clone(),
            price: self.price,
        }
    }

    /// Converts the full selection metadata to the source result record.
    pub fn to_js_value(&self) -> JsValue {
        let mut raw = JsObject::new();
        raw.insert(key("x"), JsValue::Number(self.raw[0]));
        raw.insert(key("y"), JsValue::Number(self.raw[1]));
        let mut resolved = JsObject::new();
        resolved.insert(key("x"), JsValue::Number(self.resolved[0]));
        resolved.insert(key("y"), JsValue::Number(self.resolved[1]));
        let mut result = JsObject::new();
        result.insert(
            key("mode"),
            JsValue::String(JsString::from_str(self.mode.as_js())),
        );
        result.insert(key("raw"), JsValue::Object(raw));
        result.insert(key("resolved"), JsValue::Object(resolved));
        result.insert(key("panel"), JsValue::String(self.panel.clone()));
        result.insert(key("snapped"), JsValue::Bool(self.snapped));
        result.insert(
            key("reason"),
            JsValue::String(JsString::from_str(self.reason)),
        );
        result.insert(
            key("index"),
            self.index
                .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
        );
        result.insert(
            key("time"),
            self.time.map_or(JsValue::Null, JsValue::Number),
        );
        result.insert(
            key("field"),
            self.field.clone().map_or(JsValue::Null, JsValue::String),
        );
        result.insert(
            key("price"),
            self.price.map_or(JsValue::Null, JsValue::Number),
        );
        result.insert(
            key("axisId"),
            self.axis_id.clone().map_or(JsValue::Null, JsValue::String),
        );
        result.insert(
            key("seriesId"),
            self.series_id
                .clone()
                .map_or(JsValue::Null, JsValue::String),
        );
        result.insert(
            key("storeVersion"),
            self.store_version.map_or(JsValue::Null, JsValue::Number),
        );
        JsValue::Object(result)
    }

    /// Projects the result into the exact DTO consumed by the scene leaf.
    pub fn to_scene(&self) -> ResolvedCrosshair {
        ResolvedCrosshair {
            x: self.resolved[0],
            y: self.resolved[1],
            panel: self.panel.clone(),
            snapped: self.snapped,
            axis_id: self.axis_id.clone(),
            price: self.price,
        }
    }
}

/// Validates snap settings, infers a series axis where the source does, then validates bindings.
pub fn crosshair_snap_options(
    model: &ModelState,
    options: &JsValue,
) -> Result<CrosshairSnapOptions, JsError> {
    option_record(options, &["mode", "target"], "Crosshair snap")?;
    let record = object(options).ok_or_else(|| type_error("Crosshair snap: object required"))?;
    let mode = match field(record, "mode") {
        Some(JsValue::String(value)) if ascii_eq(value, "free") => CrosshairSnapMode::Free,
        Some(JsValue::String(value)) if ascii_eq(value, "close") => CrosshairSnapMode::Close,
        Some(JsValue::String(value)) if ascii_eq(value, "ohlc") => CrosshairSnapMode::Ohlc,
        _ => {
            return Err(type_error(
                "Crosshair snap mode: free, close or ohlc required",
            ));
        }
    };
    let target = match field(record, "target") {
        None | Some(JsValue::Null | JsValue::Undefined) => None,
        Some(value) => Some(parse_target(model, value)?),
    };
    Ok(CrosshairSnapOptions { mode, target })
}

fn parse_target(model: &ModelState, value: &JsValue) -> Result<CrosshairSnapTarget, JsError> {
    option_record(
        value,
        &["panel", "axisId", "seriesId"],
        "Crosshair snap target",
    )?;
    let record =
        object(value).ok_or_else(|| type_error("Crosshair snap target: object required"))?;
    let panel = identifier(
        field(record, "panel").unwrap_or(&JsValue::Undefined),
        "Crosshair snap panel",
    )?
    .clone();
    let mut axis_id = optional_identifier(record, "axisId", "Crosshair snap axis")?;
    let series_id = optional_identifier(record, "seriesId", "Crosshair snap series")?;
    if let Some(series_id) = series_id.as_ref()
        && field(record, "axisId").is_none_or(|value| matches!(value, JsValue::Undefined))
        && let Some(series) = model.series.iter().find(|series| series.id == *series_id)
    {
        axis_id = series.axis_id.clone();
    }
    let mut binding = JsObject::new();
    binding.insert(key("panel"), JsValue::String(panel.clone()));
    binding.insert(
        key("axisId"),
        axis_id.clone().map_or(JsValue::Null, JsValue::String),
    );
    binding.insert(
        key("seriesId"),
        series_id.clone().map_or(JsValue::Null, JsValue::String),
    );
    model.validate_drawing_binding(&JsValue::Object(binding), false)?;
    Ok(CrosshairSnapTarget {
        panel,
        axis_id,
        series_id,
    })
}

fn optional_identifier(
    record: &JsObject,
    name: &str,
    label: &str,
) -> Result<Option<JsString>, JsError> {
    match field(record, name) {
        None | Some(JsValue::Null | JsValue::Undefined) => Ok(None),
        Some(value) => Ok(Some(identifier(value, label)?.clone())),
    }
}

/// Resolves a pointer-owned cursor and returns its portable selection metadata.
pub fn resolve_crosshair_snapshot(
    model: &ModelState,
    store: &BarStore,
    layout: &Layout,
    cursor: Option<&CrosshairCursor>,
) -> Option<CrosshairResolution> {
    let cursor = cursor?;
    let x = cursor.x;
    let y = cursor.y;
    let panel = layout
        .panels
        .iter()
        .find(|panel| x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom)?;
    let mode = cursor
        .request
        .as_ref()
        .map_or(CrosshairSnapMode::Free, |request| request.mode);
    let mut result = CrosshairResolution {
        mode,
        raw: [x, y],
        resolved: [x, y],
        panel: panel.id.clone(),
        snapped: false,
        reason: if mode == CrosshairSnapMode::Free {
            "free"
        } else {
            "no-eligible"
        },
        index: None,
        time: None,
        field: None,
        price: None,
        axis_id: None,
        series_id: None,
        store_version: None,
    };
    if mode == CrosshairSnapMode::Free {
        return Some(result);
    }
    let request = cursor.request.as_ref()?;
    let default_target = CrosshairSnapTarget {
        panel: panel.id.clone(),
        axis_id: None,
        series_id: None,
    };
    let target = request.target.as_ref().unwrap_or(&default_target);
    if target.panel != panel.id {
        return Some(result);
    }
    let fields: &[&str] = if mode == CrosshairSnapMode::Close {
        &["close"]
    } else {
        &["open", "high", "low", "close"]
    };
    let snap = nearest_visible_ohlc(model, store, layout, x, y, target, fields)?;
    result.resolved = [snap.x, snap.y];
    result.snapped = true;
    result.reason = "snapped";
    result.index = Some(snap.index);
    result.time = Some(snap.time);
    result.field = Some(JsString::from_str(snap.field));
    result.price = Some(snap.price);
    result.axis_id = target.axis_id.clone();
    result.series_id = Some(snap.series_id);
    result.store_version = Some(store.version());
    Some(result)
}

/// Resolves a pointer-owned cursor directly into the scene boundary DTO.
pub fn resolve_crosshair(
    model: &ModelState,
    store: &BarStore,
    layout: &Layout,
    cursor: Option<&CrosshairCursor>,
) -> Option<ResolvedCrosshair> {
    resolve_crosshair_snapshot(model, store, layout, cursor)
        .map(|resolution| resolution.to_scene_crosshair())
}

/// Selects one nearest visible raw OHLC value on the requested axis.
pub fn nearest_visible_ohlc(
    model: &ModelState,
    store: &BarStore,
    layout: &Layout,
    x: f64,
    y: f64,
    target: &CrosshairSnapTarget,
    fields: &[&'static str],
) -> Option<NearestOhlc> {
    let axis = layout.axis(&target.panel, target.axis_id.as_ref())?;
    if store.length() == 0 || x < axis.left || x > axis.right || y < axis.top || y > axis.bottom {
        return None;
    }
    let eligible = |series: &&crate::model_state::Series| {
        series.visible
            && series.panel == target.panel
            && series.axis_id == target.axis_id
            && matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
            && series.offset == 0.0
            && series.indicator.is_none()
            && series.values.is_none()
            && !has_truthy_raw_source(series)
            && !has_truthy_symbol_id(series)
    };
    let series = if let Some(series_id) = target.series_id.as_ref() {
        model
            .series
            .iter()
            .find(|series| series.id == *series_id && eligible(series))?
    } else {
        model.series.iter().find(eligible)?
    };
    let first = js_max(&[0.0, model.view.from.ceil()]) as usize;
    let last = js_min(&[
        store.length().saturating_sub(1) as f64,
        model.view.to.floor(),
    ]);
    if first as f64 > last {
        return None;
    }
    let index = layout.index(model.view, x);
    if !index.is_finite() {
        return None;
    }
    let first = first as f64;
    let last = js_max(&[last, first]);
    let a = js_max(&[first, js_min(&[last, index.floor()])]) as usize;
    let b = js_max(&[first, js_min(&[last, index.ceil()])]) as usize;
    let ax = layout.x(model.view, a as f64);
    let bx = layout.x(model.view, b as f64);
    let at = if (x - ax).abs() <= (x - bx).abs() {
        a
    } else {
        b
    };
    let screen_x = layout.x(model.view, at as f64);
    if !screen_x.is_finite() || screen_x < axis.left || screen_x > axis.right {
        return None;
    }
    let columns = store.columns();
    let mut selected: Option<NearestOhlc> = None;
    let mut distance = f64::INFINITY;
    for field in fields {
        let value = match *field {
            "open" => columns.open[at],
            "high" => columns.high[at],
            "low" => columns.low[at],
            "close" => columns.close[at],
            _ => continue,
        };
        let screen_y = axis.scale.y(value);
        if !value.is_finite()
            || !screen_y.is_finite()
            || screen_y < axis.top
            || screen_y > axis.bottom
        {
            continue;
        }
        let candidate = (screen_y - y).abs();
        if candidate < distance {
            distance = candidate;
            selected = Some(NearestOhlc {
                index: at,
                time: columns.time[at],
                price: value,
                field,
                x: screen_x,
                y: screen_y,
                series_id: series.id.clone(),
            });
        }
    }
    selected
}

/// One raw OHLC sample selected by screen distance.
#[derive(Clone, Debug, PartialEq)]
pub struct NearestOhlc {
    /// Raw store index.
    pub index: usize,
    /// Source bar time.
    pub time: f64,
    /// Exact source OHLC price.
    pub price: f64,
    /// Selected OHLC field.
    pub field: &'static str,
    /// Screen x of the selected bar center.
    pub x: f64,
    /// Screen y of the selected raw price.
    pub y: f64,
    /// Selected source series id.
    pub series_id: JsString,
}

fn has_truthy_raw_source(series: &crate::model_state::Series) -> bool {
    let record = series.raw_record();
    let Some(source) = field(object(&record).unwrap(), "source") else {
        return false;
    };
    js_truthy(source)
}

fn has_truthy_symbol_id(series: &crate::model_state::Series) -> bool {
    let record = series.raw_record();
    let Some(symbol) = field(object(&record).unwrap(), "symbolId") else {
        return false;
    };
    js_truthy(symbol)
}

fn js_truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => false,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Bool(true) | JsValue::Array(_) | JsValue::Object(_) => true,
    }
}
