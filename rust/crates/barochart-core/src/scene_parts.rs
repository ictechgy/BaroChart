//! Pure renderer-neutral scene helpers shared by full scenes and later frame layers.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::{NumberDialect, to_exponential_with, to_fixed_with};
use barochart_js::string::JsString;

use crate::axis_scale::{AxisScale, AxisScaleKind};
use crate::data::BarStore;
use crate::drawing_geometry::{
    DrawingAxisView, DrawingGeometryCache, DrawingProjection, drawing_geometry,
};
use crate::drawings::DrawingStore;
use crate::markets::{Symbol, format_price};
use crate::model_state::{ModelState, Series, SeriesKind, VisibleRange};

/// Native-supported axis tick formatting modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxisTickFormat {
    Fixed,
    Scientific,
}

/// Axis formatting input after layout resolved its immutable configuration.
pub struct AxisFormatInput<'a> {
    pub id: &'a JsString,
    pub axis_id: Option<&'a JsString>,
    pub scale: AxisScaleKind,
    pub precision: Option<u32>,
    pub model_precision: u32,
    pub tick_format: AxisTickFormat,
    pub prefix: Option<&'a JsString>,
    pub suffix: Option<&'a JsString>,
    pub projection: &'a AxisScale,
    pub symbol: Option<&'a Symbol>,
}

/// Formats a standard native axis. JavaScript callback formatters are deliberately not modeled.
pub fn format_axis_value(
    input: AxisFormatInput<'_>,
    value: f64,
    dialect: NumberDialect,
) -> JsString {
    let precision = input
        .precision
        .unwrap_or(if input.scale == AxisScaleKind::Percent {
            2
        } else {
            input.model_precision
        });
    if input.axis_id.is_none()
        && input.scale != AxisScaleKind::Percent
        && text_eq(input.id, "price")
        && let Some(symbol) = input.symbol
    {
        return JsString::from_str(&format_price(value, symbol, dialect));
    }
    let number = if input.scale == AxisScaleKind::Percent {
        input.projection.transform(value)
    } else {
        value
    };
    let number = match input.tick_format {
        AxisTickFormat::Fixed => to_fixed_with(number, precision, dialect),
        AxisTickFormat::Scientific => to_exponential_with(number, Some(precision), dialect),
    };
    let mut units = Vec::new();
    if let Some(prefix) = input.prefix {
        units.extend_from_slice(prefix.as_units());
    }
    units.extend(number.encode_utf16());
    if input.scale == AxisScaleKind::Percent {
        units.push(b'%' as u16);
    }
    if let Some(suffix) = input.suffix {
        units.extend_from_slice(suffix.as_units());
    }
    JsString::from_utf16(units)
}

/// Pure inputs to the volume-bucket shortcut.
#[derive(Clone, Copy, Debug)]
pub struct AggregateVolumeInput {
    pub kind: SeriesKind,
    pub source_is_volume: bool,
    pub has_values: bool,
    pub has_indicator: bool,
    pub offset: f64,
    pub baseline: f64,
}

pub fn aggregate_volume_input(input: AggregateVolumeInput) -> bool {
    input.kind == SeriesKind::Histogram
        && input.source_is_volume
        && !input.has_values
        && !input.has_indicator
        && input.offset == 0.0
        && input.baseline == 0.0
}

pub fn aggregate_volume_series(series: &Series) -> bool {
    let record = series.raw_record();
    let JsValue::Object(record) = &record else {
        unreachable!("normalized series record is an object")
    };
    let source_is_volume = record
        .get(&key("source"))
        .is_some_and(|source| matches!(source, JsValue::String(value) if text_eq(value, "volume")));
    let baseline = match record.get(&key("baseline")) {
        None | Some(JsValue::Undefined | JsValue::Null) => 0.0,
        Some(JsValue::Number(value)) => *value,
        Some(_) => f64::NAN,
    };
    aggregate_volume_input(AggregateVolumeInput {
        kind: series.kind,
        source_is_volume,
        has_values: series.values.is_some(),
        has_indicator: series.indicator.is_some(),
        offset: series.offset,
        baseline,
    })
}

/// Ordered theme values consumed by scene commands.
#[derive(Clone, Debug)]
pub struct SceneTheme {
    pub background: JsValue,
    pub grid: JsValue,
    pub text: JsValue,
    pub up: JsValue,
    pub down: JsValue,
    pub crosshair: JsValue,
    pub font: JsValue,
}

impl SceneTheme {
    pub fn from_model(model: &ModelState) -> Result<Self, JsError> {
        Self::from_value(model.theme())
    }

    pub fn from_value(value: &JsValue) -> Result<Self, JsError> {
        let JsValue::Object(theme) = value else {
            return Err(type_error("Scene theme object required"));
        };
        Ok(Self {
            background: theme_field(theme, "background")?,
            grid: theme_field(theme, "grid")?,
            text: theme_field(theme, "text")?,
            up: theme_field(theme, "up")?,
            down: theme_field(theme, "down")?,
            crosshair: theme_field(theme, "crosshair")?,
            font: theme_field(theme, "font")?,
        })
    }
}

/// Short-lived borrows needed to emit one drawing layer.
pub struct DrawingCommandInput<'a, P: DrawingProjection> {
    pub model: &'a ModelState,
    pub store: &'a BarStore,
    pub drawings: &'a DrawingStore,
    pub current_view: VisibleRange,
    pub layout: &'a P,
    pub cache: &'a mut DrawingGeometryCache,
    pub theme: &'a SceneTheme,
    pub dialect: NumberDialect,
}

/// Emits drawing commands in store z-order, then selected handles for each drawing.
pub fn create_drawing_commands<P: DrawingProjection>(
    input: DrawingCommandInput<'_, P>,
) -> Result<Vec<JsValue>, JsError> {
    let DrawingCommandInput {
        model,
        store,
        drawings,
        current_view,
        layout,
        cache,
        theme,
        dialect,
    } = input;
    let mut commands = Vec::new();
    for drawing in drawings.items() {
        if drawing.visible == Some(false) {
            continue;
        }
        let Some(axis) = layout.drawing_axis(
            model,
            &drawing.panel,
            drawing.axis_id.as_ref(),
            drawing.series_id.as_ref(),
        ) else {
            continue;
        };
        let checked_points = if drawing.kind.is_position() {
            drawing.points.len()
        } else {
            std::cmp::min(drawing.points.len(), 2)
        };
        let visible = drawing.points[..checked_points].iter().all(|point| {
            let point = layout.to_screen(
                current_view,
                store,
                point.time,
                point.price,
                &drawing.panel,
                drawing.axis_id.as_ref(),
            );
            point.x.is_finite() && point.y.is_finite()
        });
        if !visible {
            continue;
        }
        let geometry =
            drawing_geometry(cache, drawing, model, current_view, store, layout, dialect)?;
        let font = drawing
            .style
            .as_ref()
            .and_then(|style| style.font.as_ref())
            .map_or_else(|| theme.font.clone(), |font| JsValue::String(font.clone()));
        for command in geometry.iter() {
            let mut command = command.clone();
            if let JsValue::Object(record) = &mut command
                && matches!(record.get(&key("op")), Some(JsValue::String(value)) if text_eq(value, "text"))
            {
                record.insert(key("font"), font.clone());
            }
            commands.push(command);
        }
        if drawings.selected() == Some(&drawing.id) {
            let color = drawing
                .style
                .as_ref()
                .and_then(|style| style.color.as_ref())
                .map_or_else(
                    || JsValue::String(JsString::from_str("#f5b85a")),
                    |color| JsValue::String(color.clone()),
                );
            let clip = JsValue::Array(
                [
                    axis.left(),
                    axis.top(),
                    axis.right() - axis.left(),
                    axis.bottom() - axis.top(),
                ]
                .into_iter()
                .map(JsValue::Number)
                .collect(),
            );
            for point in drawing.points.iter() {
                let point = layout.to_screen(
                    current_view,
                    store,
                    point.time,
                    point.price,
                    &drawing.panel,
                    drawing.axis_id.as_ref(),
                );
                commands.push(object([
                    ("op", text("box")),
                    ("x", JsValue::Number(point.x - 4.0)),
                    ("y", JsValue::Number(point.y - 4.0)),
                    ("w", JsValue::Number(8.0)),
                    ("h", JsValue::Number(8.0)),
                    (
                        "fill",
                        if drawing.locked == Some(true) {
                            theme.text.clone()
                        } else {
                            theme.background.clone()
                        },
                    ),
                    ("color", color.clone()),
                    ("width", JsValue::Number(1.0)),
                    ("clip", clip.clone()),
                ]));
            }
        }
    }
    Ok(commands)
}

fn theme_field(theme: &JsObject, name: &str) -> Result<JsValue, JsError> {
    theme
        .get(&key(name))
        .cloned()
        .ok_or_else(|| type_error("Scene theme field required"))
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(JsString::from_str(key), value);
    }
    JsValue::Object(object)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
