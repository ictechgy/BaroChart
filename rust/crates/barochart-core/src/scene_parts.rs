//! Pure renderer-neutral scene helpers shared by full scenes and later frame layers.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
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
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    format_axis_value_scoped(input, value, dialect, &mut scope)
        .expect("unaccounted axis label allocation failed")
}

/// 축 값을 호출 수명 scope에 fallible UTF-16으로 만든다.
pub fn format_axis_value_scoped(
    input: AxisFormatInput<'_>,
    value: f64,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
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
        return JsString::try_from_str(&format_price(value, symbol, dialect), scope)
            .map_err(|failure| failure.into_js_error());
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
    let length = input.prefix.map_or(0, JsString::len_utf16)
        + number.encode_utf16().count()
        + usize::from(input.scale == AxisScaleKind::Percent)
        + input.suffix.map_or(0, JsString::len_utf16);
    let mut units = try_vec_capacity(length, scope)?;
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
    Ok(JsString::from_utf16(units))
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

    /// 모델 theme 필드를 caller scope에 fallible하게 복제한다.
    pub fn from_model_scoped(model: &ModelState, scope: &mut MemoryScope) -> Result<Self, JsError> {
        Self::from_value_scoped(model.theme(), scope)
    }

    /// theme record 필드를 caller scope에 fallible하게 복제한다.
    pub fn from_value_scoped(value: &JsValue, scope: &mut MemoryScope) -> Result<Self, JsError> {
        let JsValue::Object(theme) = value else {
            return Err(type_error("Scene theme object required"));
        };
        Ok(Self {
            background: theme_field_scoped(theme, "background", scope)?,
            grid: theme_field_scoped(theme, "grid", scope)?,
            text: theme_field_scoped(theme, "text", scope)?,
            up: theme_field_scoped(theme, "up", scope)?,
            down: theme_field_scoped(theme, "down", scope)?,
            crosshair: theme_field_scoped(theme, "crosshair", scope)?,
            font: theme_field_scoped(theme, "font", scope)?,
        })
    }
}

/// 한 scene layer command Vec와 그 DOM allocation lease다.
pub struct OwnedSceneCommands {
    commands: Vec<JsValue>,
    memory: MemoryGroup,
}

impl OwnedSceneCommands {
    pub(crate) fn from_parts(commands: Vec<JsValue>, memory: MemoryGroup) -> Self {
        Self { commands, memory }
    }

    /// 같은 caller scope에서 만든 theme/commands allocation을 retained layer로 옮긴다.
    pub fn from_scoped(commands: Vec<JsValue>, scope: &mut MemoryScope) -> Result<Self, JsError> {
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        let memory = scope
            .split_persistent(requested)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self { commands, memory })
    }

    /// 실제 command slice다.
    pub fn as_slice(&self) -> &[JsValue] {
        &self.commands
    }

    /// command Vec와 DOM payload가 보유한 requested bytes다.
    pub fn requested_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }

    /// payload와 lease를 함께 상위 owner로 이동한다.
    pub fn into_parts(self) -> (Vec<JsValue>, MemoryGroup) {
        (self.commands, self.memory)
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
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    let mut temporary = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    create_drawing_commands_internal(input, &mut scope, &mut temporary)
}

/// drawing layer를 지정한 엔진 account에 연결한 owned payload로 만든다.
pub fn create_drawing_commands_with_memory<P: DrawingProjection>(
    input: DrawingCommandInput<'_, P>,
    memory: &MemoryContext,
) -> Result<OwnedSceneCommands, JsError> {
    let mut scope = memory.scope();
    let mut temporary = memory.scope();
    let commands = create_drawing_commands_internal(input, &mut scope, &mut temporary)?;
    OwnedSceneCommands::from_scoped(commands, &mut scope)
}

/// drawing layer를 caller scope에 allocation 전 예약하며 만든다.
pub fn create_drawing_commands_scoped<P: DrawingProjection>(
    input: DrawingCommandInput<'_, P>,
    scope: &mut MemoryScope,
) -> Result<Vec<JsValue>, JsError> {
    let mut temporary = MemoryScope::unaccounted(scope.allocation_failure().style());
    create_drawing_commands_internal(input, scope, &mut temporary)
}

fn create_drawing_commands_internal<P: DrawingProjection>(
    input: DrawingCommandInput<'_, P>,
    scope: &mut MemoryScope,
    temporary: &mut MemoryScope,
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
        let font = match drawing.style.as_ref().and_then(|style| style.font.as_ref()) {
            Some(font) => JsValue::String(
                font.try_clone_scoped(temporary)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            None => theme
                .font
                .try_clone_scoped(temporary)
                .map_err(|failure| failure.into_js_error())?,
        };
        for command in geometry.iter() {
            let mut command = command
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            if let JsValue::Object(record) = &mut command
                && matches!(record.get(&key("op")), Some(JsValue::String(value)) if text_eq(value, "text"))
            {
                let replacement = font
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?;
                let slot = record
                    .get_mut(&key("font"))
                    .expect("drawing text geometry has a font field");
                *slot = replacement;
            }
            push_command(&mut commands, command, scope)?;
        }
        if drawings.selected() == Some(&drawing.id) {
            let color = match drawing
                .style
                .as_ref()
                .and_then(|style| style.color.as_ref())
            {
                Some(color) => JsValue::String(
                    color
                        .try_clone_scoped(temporary)
                        .map_err(|failure| failure.into_js_error())?,
                ),
                None => text("#f5b85a", temporary)?,
            };
            let clip = numbers(
                &[
                    axis.left(),
                    axis.top(),
                    axis.right() - axis.left(),
                    axis.bottom() - axis.top(),
                ],
                temporary,
            )?;
            for point in drawing.points.iter() {
                let point = layout.to_screen(
                    current_view,
                    store,
                    point.time,
                    point.price,
                    &drawing.panel,
                    drawing.axis_id.as_ref(),
                );
                let command = object(
                    [
                        ("op", text("box", scope)?),
                        ("x", JsValue::Number(point.x - 4.0)),
                        ("y", JsValue::Number(point.y - 4.0)),
                        ("w", JsValue::Number(8.0)),
                        ("h", JsValue::Number(8.0)),
                        (
                            "fill",
                            if drawing.locked == Some(true) {
                                theme
                                    .text
                                    .try_clone_scoped(scope)
                                    .map_err(|failure| failure.into_js_error())?
                            } else {
                                theme
                                    .background
                                    .try_clone_scoped(scope)
                                    .map_err(|failure| failure.into_js_error())?
                            },
                        ),
                        (
                            "color",
                            color
                                .try_clone_scoped(scope)
                                .map_err(|failure| failure.into_js_error())?,
                        ),
                        ("width", JsValue::Number(1.0)),
                        (
                            "clip",
                            clip.try_clone_scoped(scope)
                                .map_err(|failure| failure.into_js_error())?,
                        ),
                    ],
                    scope,
                )?;
                push_command(&mut commands, command, scope)?;
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

fn theme_field_scoped(
    theme: &JsObject,
    name: &str,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    theme
        .get(&key(name))
        .ok_or_else(|| type_error("Scene theme field required"))?
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    JsString::try_from_str(value, scope)
        .map(JsValue::String)
        .map_err(|failure| failure.into_js_error())
}

fn numbers(values: &[f64], scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let mut output = try_vec_capacity(values.len(), scope)?;
    output.extend(values.iter().copied().map(JsValue::Number));
    Ok(JsValue::Array(output))
}

fn object<const N: usize>(
    entries: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut object = try_vec_capacity(N, scope)?;
    for (key, value) in entries {
        object.push((
            JsString::try_from_str(key, scope).map_err(|failure| failure.into_js_error())?,
            value,
        ));
    }
    JsObject::try_from_entries_scoped(object, scope)
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

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
