//! Async data/prepare 작업의 최신 UI state를 bounded header/chunk로 옮긴다.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, same_value};
use barochart_js::string::JsString;

use crate::Host;
use crate::chart_api::ChartApi;
use crate::checkpoint_codec::{safe_checkpoint_parse_scoped, safe_checkpoint_stringify_scoped};
use crate::contracts::{
    AXIS_KEYS, PANEL_KEYS, RESOURCE_LIMITS, SERIES_KEYS, THEME_KEYS, identifier, option_record,
    portable_style_scoped,
};
use crate::drawing_types::Drawing;
use crate::drawing_validation::canonical_drawing_scoped;
use crate::drawings::{DrawingFrame, DrawingSnapshot, DrawingSnapshotList, DrawingStore};
use crate::indicator_modules::pressure_descriptor_value;
use crate::indicator_types::IndicatorProvenance;
use crate::interaction::OwnedInteractionState;
use crate::model_state::{
    DrawingUsage, IndicatorProjection, InteractionGuard, ModelContext, NativeUiModelStage,
    VisibleRange,
};
use crate::native_chart::{NativeChart, NativeChartParts};
use crate::native_data_jobs::NativePreparedCore;
use crate::workspace::{js_string_heap_bytes, js_value_heap_bytes};
use crate::{NativeSizeState, ingestion::IngestionError};

const UI_DIRECT_CHARS: usize = 8_388_608;
const UI_CHUNK_CHARS: usize = 262_144;
const UI_CHUNK_UTF8: usize = 1_048_576;
const UI_CHUNK_NODES: usize = 250_000;
const UI_CHUNK_REFS: usize = 64;
const UI_CHUNK_POINTS: usize = 2_048;

type DrawingFrames = Vec<Vec<Arc<Drawing>>>;

fn scoped_vec<T>(length: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = length
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(length)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

fn clone_js_slice_scoped(
    values: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<Vec<JsValue>, JsError> {
    let mut output = scoped_vec(values.len(), scope)?;
    for value in values {
        output.push(
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
    }
    Ok(output)
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item);
    }
    JsValue::Object(value)
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", key(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", key(message))
}

fn ingestion_error(error: IngestionError) -> JsError {
    error.into_js_error()
}

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn required<'a>(value: &'a JsValue, name: &str, message: &str) -> Result<&'a JsValue, JsError> {
    field(value, name).ok_or_else(|| type_error(message))
}

fn array<'a>(value: &'a JsValue, message: &str) -> Result<&'a [JsValue], JsError> {
    match value {
        JsValue::Array(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

fn string_scoped(
    value: &JsValue,
    message: &str,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    match value {
        JsValue::String(value) => value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error()),
        _ => Err(type_error(message)),
    }
}

fn exact_usize(value: &JsValue, maximum: usize, message: &str) -> Result<usize, JsError> {
    match value {
        JsValue::Number(value)
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= 0.0
                && *value <= maximum as f64 =>
        {
            Ok(*value as usize)
        }
        _ => Err(range_error(message)),
    }
}

fn drawing_serial(value: &JsValue) -> Result<u64, JsError> {
    match value {
        JsValue::Number(value)
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= 0.0
                && *value <= 9_007_199_254_740_991.0 =>
        {
            Ok(*value as u64)
        }
        _ => Err(range_error("Async drawing serial")),
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

fn validate_symbol_shape(value: &JsValue) -> Result<(), JsError> {
    let JsValue::Object(symbol) = value else {
        return Err(type_error("Invalid symbol metadata"));
    };
    let required_text = |name: &str| matches!(symbol.get(&key(name)), Some(JsValue::String(value)) if !value.as_units().is_empty());
    let decimals = matches!(
        symbol.get(&key("priceDecimals")),
        Some(JsValue::Number(value))
            if value.is_finite() && value.fract() == 0.0 && (0.0..=18.0).contains(value)
    );
    let tick = matches!(
        symbol.get(&key("tickSize")),
        Some(JsValue::Number(value)) if value.is_finite() && *value > 0.0
    );
    let adjustment = matches!(
        symbol.get(&key("adjustment")),
        Some(JsValue::String(value))
            if ["raw", "split", "total-return"]
                .iter()
                .any(|candidate| value == &key(candidate))
    );
    if ["id", "exchange", "timezone", "currency", "volumeUnit"]
        .iter()
        .all(|name| required_text(name))
        && decimals
        && tick
        && adjustment
    {
        Ok(())
    } else {
        Err(type_error("Invalid symbol metadata"))
    }
}

fn deep_same(left: &JsValue, right: &JsValue) -> bool {
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
                    .all(|(left, right)| deep_same(left, right))
        }
        (JsValue::Object(left), JsValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(name, value)| {
                    right.get(name).is_some_and(|right| deep_same(value, right))
                })
        }
        _ => false,
    }
}

fn omit_undefined_scoped(value: &JsValue, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    match value {
        JsValue::Array(values) => {
            let mut output = scoped_vec(values.len(), scope)?;
            for value in values {
                output.push(omit_undefined_scoped(value, scope)?);
            }
            Ok(JsValue::Array(output))
        }
        JsValue::Object(values) => {
            let mut entries = scoped_vec(values.len(), scope)?;
            for (name, value) in values.iter() {
                if !matches!(value, JsValue::Undefined) {
                    entries.push((
                        name.try_clone_scoped(scope)
                            .map_err(|failure| failure.into_js_error())?,
                        omit_undefined_scoped(value, scope)?,
                    ));
                }
            }
            Ok(JsValue::Object(
                JsObject::try_from_entries_scoped(entries, scope)
                    .map_err(|failure| failure.into_js_error())?,
            ))
        }
        value => value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error()),
    }
}

fn utf8_bytes(value: &JsString) -> usize {
    let units = value.as_units();
    let mut bytes = 0usize;
    let mut index = 0usize;
    while index < units.len() {
        let unit = units[index];
        if unit < 0x80 {
            bytes += 1;
        } else if unit < 0x800 {
            bytes += 2;
        } else if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            bytes += 4;
            index += 1;
        } else {
            bytes += 3;
        }
        index += 1;
    }
    bytes
}

fn serialized_nodes(value: &JsValue, scope: &mut MemoryScope) -> Result<usize, JsError> {
    let mut nodes = 0usize;
    let mut stack = scoped_vec(1, scope)?;
    stack.push(value);
    while let Some(value) = stack.pop() {
        nodes += 1;
        match value {
            JsValue::Number(value)
                if !value.is_finite() || value.is_sign_negative() && *value == 0.0 =>
            {
                nodes += 1;
            }
            JsValue::Array(values) => {
                scope
                    .try_grow(values.len() * std::mem::size_of::<&JsValue>())
                    .map_err(|failure| failure.into_js_error())?;
                stack
                    .try_reserve(values.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                stack.extend(values);
            }
            JsValue::Object(values) => {
                scope
                    .try_grow(values.len() * std::mem::size_of::<&JsValue>())
                    .map_err(|failure| failure.into_js_error())?;
                stack
                    .try_reserve(values.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                stack.extend(values.iter().map(|(_, value)| value));
            }
            _ => {}
        }
    }
    Ok(nodes)
}

fn bounded_string_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let text = safe_checkpoint_stringify_scoped(value, dialect, scope)?;
    if text.len_utf16() > UI_CHUNK_CHARS || utf8_bytes(&text) > UI_CHUNK_UTF8 {
        return Err(range_error("Async UI chunk text limit"));
    }
    Ok(text)
}

fn pick_scoped(
    value: &JsValue,
    keys: &[&str],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut entries = scoped_vec(keys.len(), scope)?;
    if let JsValue::Object(value) = value {
        for name in keys {
            if let Some(item) = value.get(&key(name))
                && !matches!(item, JsValue::Undefined)
            {
                entries.push((
                    key(name),
                    item.try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ));
            }
        }
    }
    Ok(JsValue::Object(
        JsObject::try_from_entries_scoped(entries, scope)
            .map_err(|failure| failure.into_js_error())?,
    ))
}

fn indicator_bindings(chart: &NativeChart, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let engine = chart.indicators();
    scope
        .try_grow(
            engine
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 256),
        )
        .map_err(|failure| failure.into_js_error())?;
    let ids = engine.entry_ids();
    let mut rows = scoped_vec(ids.len(), scope)?;
    for id in ids {
        let lookup = id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let Some(entry) = engine.entry(&JsValue::String(lookup)) else {
            continue;
        };
        let definition = entry.definition();
        scope
            .try_grow(8 * std::mem::size_of::<(JsString, JsValue)>() + 512)
            .map_err(|failure| failure.into_js_error())?;
        let mut row = JsObject::new();
        row.insert(key("id"), JsValue::String(id));
        row.insert(
            key("name"),
            JsValue::String(
                entry
                    .name()
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        );
        row.insert(
            key("params"),
            entry
                .params()
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
        if matches!(definition.provenance, IndicatorProvenance::Linked(_)) {
            scope
                .try_grow(1_024)
                .map_err(|failure| failure.into_js_error())?;
            row.insert(key("module"), pressure_descriptor_value());
        }
        let mut outputs = scoped_vec(definition.outputs.len(), scope)?;
        for output in definition.outputs {
            scope
                .try_grow(output.len().saturating_mul(2))
                .map_err(|failure| failure.into_js_error())?;
            outputs.push(text(output));
        }
        row.insert(key("outputs"), JsValue::Array(outputs));
        scope
            .try_grow(
                definition
                    .plot_offsets
                    .len()
                    .saturating_mul(std::mem::size_of::<(JsString, JsValue)>() + 64),
            )
            .map_err(|failure| failure.into_js_error())?;
        let mut offsets = JsObject::new();
        for offset in &definition.plot_offsets {
            offsets.insert(key(offset.output), JsValue::Number(offset.value));
        }
        row.insert(key("plotOffsets"), JsValue::Object(offsets));
        rows.push(JsValue::Object(row));
    }
    Ok(JsValue::Array(rows))
}

fn drawing_value_scoped(drawing: &Drawing, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    drawing.to_value_scoped(scope)
}

fn drawing_frame_value_scoped(
    frame: &[Arc<Drawing>],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut values = scoped_vec(frame.len(), scope)?;
    for drawing in frame {
        values.push(drawing_value_scoped(drawing, scope)?);
    }
    Ok(JsValue::Array(values))
}

fn ui_state(
    chart: &NativeChart,
    input: &OwnedInteractionState,
    size: &NativeSizeState,
    prepared_input: Option<&JsValue>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    if input.gesture_kind().is_some()
        || input.pointer_count() != 0
        || chart.drawings().transaction().is_some()
    {
        return Err(ordinary_error("Async stale: active gesture"));
    }
    scope
        .try_grow(24 * (std::mem::size_of::<(JsString, JsValue)>() + 64))
        .map_err(|failure| failure.into_js_error())?;
    let mut state = JsObject::new();
    if let Some(prepared_input) =
        prepared_input.filter(|value| !matches!(value, JsValue::Undefined))
    {
        state.insert(
            key("preparedInput"),
            prepared_input
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
    }
    match chart.ingestion_owner().save_scoped(scope) {
        Ok(value) => {
            state.insert(key("dataIngestion"), JsValue::String(value));
        }
        Err(error) if error.code() == "NOT_CONFIGURED" => {}
        Err(error) => return Err(ingestion_error(error)),
    }
    state.insert(key("bindings"), indicator_bindings(chart, scope)?);
    state.insert(
        key("view"),
        object([
            ("from", JsValue::Number(chart.model().view.from)),
            ("to", JsValue::Number(chart.model().view.to)),
        ]),
    );
    state.insert(key("follow"), JsValue::Bool(chart.model().follow));
    state.insert(
        key("crosshair"),
        input.crosshair_value().map_or(JsValue::Null, |(x, y)| {
            object([("x", JsValue::Number(x)), ("y", JsValue::Number(y))])
        }),
    );
    state.insert(
        key("theme"),
        chart
            .model()
            .theme()
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
    );
    let mut panels = scoped_vec(chart.model().panels.len(), scope)?;
    for panel in &chart.model().panels {
        scope
            .try_grow(2_048)
            .map_err(|failure| failure.into_js_error())?;
        panels.push(panel.to_js_value());
    }
    state.insert(key("panels"), JsValue::Array(panels));
    let mut axes = scoped_vec(chart.model().axes.len(), scope)?;
    for axis in &chart.model().axes {
        scope
            .try_grow(2_048)
            .map_err(|failure| failure.into_js_error())?;
        axes.push(axis.to_js_value());
    }
    state.insert(key("axes"), JsValue::Array(axes));
    state.insert(
        key("drawingTarget"),
        input
            .drawing_target()
            .map(|value| {
                value
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())
            })
            .transpose()?
            .unwrap_or(JsValue::Null),
    );
    let mut presentation_keys = scoped_vec(SERIES_KEYS.len(), scope)?;
    presentation_keys.extend(
        SERIES_KEYS
            .iter()
            .copied()
            .filter(|name| !matches!(*name, "values" | "indicator" | "output" | "source")),
    );
    let mut series_values = scoped_vec(chart.model().series.len(), scope)?;
    for series in &chart.model().series {
        let bytes = usize::try_from(series.metadata_accounted_bytes())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        scope
            .try_grow(bytes)
            .map_err(|failure| failure.into_js_error())?;
        let record = series.raw_record_without_values();
        series_values.push(pick_scoped(&record, &presentation_keys, scope)?);
    }
    state.insert(key("series"), JsValue::Array(series_values));
    state.insert(
        key("precision"),
        JsValue::Number(f64::from(chart.model().precision)),
    );
    state.insert(key("axisWidth"), JsValue::Number(chart.model().axis_width));
    if let Some(symbol) = chart.symbol_record() {
        state.insert(
            key("symbol"),
            symbol
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
    }
    let config = chart.drawings().config();
    let limits = object([
        ("historyLimit", JsValue::Number(config.history_limit as f64)),
        ("maxDrawings", JsValue::Number(config.max_drawings as f64)),
        ("maxPoints", JsValue::Number(config.max_points as f64)),
        (
            "maxDocumentChars",
            JsValue::Number(config.max_document_chars as f64),
        ),
        ("historyBytes", JsValue::Number(config.history_bytes as f64)),
    ]);
    let items = drawing_frame_value_scoped(chart.drawings().items(), scope)?;
    let mut undo = scoped_vec(chart.drawings().undo_stack().len(), scope)?;
    for frame in chart.drawings().undo_stack() {
        undo.push(drawing_frame_value_scoped(frame, scope)?);
    }
    let mut redo = scoped_vec(chart.drawings().redo_stack().len(), scope)?;
    for frame in chart.drawings().redo_stack() {
        redo.push(drawing_frame_value_scoped(frame, scope)?);
    }
    state.insert(
        key("drawings"),
        object([
            ("limits", limits),
            ("items", items),
            ("undo", JsValue::Array(undo)),
            ("redo", JsValue::Array(redo)),
            (
                "selected",
                chart
                    .drawings()
                    .selected()
                    .map(|value| {
                        value
                            .try_clone_scoped(scope)
                            .map(JsValue::String)
                            .map_err(|failure| failure.into_js_error())
                    })
                    .transpose()?
                    .unwrap_or(JsValue::Null),
            ),
            ("serial", JsValue::Number(chart.drawings().serial() as f64)),
        ]),
    );
    state.insert(
        key("tool"),
        JsValue::String(
            input
                .tool()
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    );
    state.insert(
        key("text"),
        input
            .text()
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
    );
    state.insert(
        key("size"),
        object([
            (
                "width",
                size.width()
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            (
                "height",
                size.height()
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        ]),
    );
    omit_undefined_scoped(&JsValue::Object(state), scope)
}

fn header_state(state: &JsValue, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let drawings = required(state, "drawings", "Async drawing state")?;
    let items = array(
        required(drawings, "items", "Async drawing state")?,
        "Async drawing state",
    )?;
    let undo = array(
        required(drawings, "undo", "Async drawing state")?,
        "Async drawing state",
    )?;
    let redo = array(
        required(drawings, "redo", "Async drawing state")?,
        "Async drawing state",
    )?;
    let mut frame_counts = scoped_vec(1 + undo.len() + redo.len(), scope)?;
    frame_counts.push(JsValue::Number(items.len() as f64));
    for frame in undo.iter().chain(redo) {
        frame_counts.push(JsValue::Number(
            array(frame, "Async drawing state")?.len() as f64
        ));
    }
    let drawing_header = object([
        (
            "limits",
            required(drawings, "limits", "Async drawing state")?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        ("frameCounts", JsValue::Array(frame_counts)),
        ("undoCount", JsValue::Number(undo.len() as f64)),
        ("redoCount", JsValue::Number(redo.len() as f64)),
        (
            "selected",
            required(drawings, "selected", "Async drawing state")?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        (
            "serial",
            required(drawings, "serial", "Async drawing state")?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    ]);
    let mut output = match state {
        JsValue::Object(_) => {
            let mut cloned = state
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            match &mut cloned {
                JsValue::Object(value) => std::mem::take(value),
                _ => unreachable!(),
            }
        }
        _ => return Err(type_error("Async UI state")),
    };
    output.insert(key("drawings"), drawing_header);
    Ok(object([
        ("schema", text("aster.async.ui")),
        ("protocol", JsValue::Number(1.0)),
        ("state", JsValue::Object(output)),
    ]))
}

fn drawing_frames(
    chart: &NativeChart,
    memory: &MemoryContext,
) -> Result<(DrawingFrames, MemoryGroup), JsError> {
    let count = 1 + chart.drawings().undo_stack().len() + chart.drawings().redo_stack().len();
    let (mut frames, mut group) = memory
        .try_vec_capacity(count)
        .map_err(|failure| failure.into_js_error())?;
    let (items, items_memory) = memory
        .try_clone_slice(chart.drawings().items())
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(items_memory)
        .map_err(|failure| failure.into_js_error())?;
    frames.push(items);
    for frame in chart
        .drawings()
        .undo_stack()
        .iter()
        .chain(chart.drawings().redo_stack())
    {
        let (frame, frame_memory) = memory
            .try_clone_slice(frame)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(frame_memory)
            .map_err(|failure| failure.into_js_error())?;
        frames.push(frame);
    }
    Ok((frames, group))
}

/// Source runtime의 streaming UI snapshot이다.
pub struct NativeUiCapture {
    prepared_input: Option<JsValue>,
    header_json: JsString,
    frames: Vec<Vec<Arc<Drawing>>>,
    frame: usize,
    offset: usize,
    slots: Vec<Arc<Drawing>>,
    last_complete: bool,
    dialect: NumberDialect,
    memory: MemoryGroup,
    chunk_memory: MemoryGroup,
}

/// UI JSON text와 직렬화 결과 수명 lease를 함께 소유한다.
pub struct AccountedUiText {
    text: JsString,
    memory: MemoryGroup,
}

impl AccountedUiText {
    /// Host 직렬화 전까지 빌릴 UI JSON text다.
    pub fn text(&self) -> &JsString {
        &self.text
    }

    /// Root output owner가 text와 group을 같은 수명으로 이동할 때 쓴다.
    pub fn into_parts(self) -> (JsString, MemoryGroup) {
        (self.text, self.memory)
    }
}

impl NativeUiCapture {
    pub fn new(
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
        prepared_input: Option<&JsValue>,
        dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        let context = chart
            .ingestion_owner()
            .data()
            .store()
            .memory_context()
            .clone();
        let mut scope = context.scope();
        let state = ui_state(chart, input, size, prepared_input, &mut scope)?;
        let header = header_state(&state, &mut scope)?;
        let temporary_header = bounded_string_scoped(&header, dialect, &mut scope)?;
        let mut retained_scope = context.scope();
        let header_json = temporary_header
            .try_clone_scoped(&mut retained_scope)
            .map_err(|failure| failure.into_js_error())?;
        let prepared_input = prepared_input
            .map(|value| {
                value
                    .try_clone_scoped(&mut retained_scope)
                    .map_err(|failure| failure.into_js_error())
            })
            .transpose()?;
        let (frames, frames_memory) = drawing_frames(chart, &context)?;
        let slot_capacity = frames.iter().map(Vec::len).sum();
        let (slots, slots_memory) = context
            .try_vec_capacity(slot_capacity)
            .map_err(|failure| failure.into_js_error())?;
        let bytes = js_string_heap_bytes(&header_json)
            .saturating_add(prepared_input.as_ref().map_or(0, js_value_heap_bytes));
        let mut memory = retained_scope
            .split_persistent(bytes)
            .map_err(|failure| failure.into_js_error())?;
        drop((state, header, temporary_header, scope));
        memory
            .absorb(frames_memory)
            .map_err(|failure| failure.into_js_error())?;
        memory
            .absorb(slots_memory)
            .map_err(|failure| failure.into_js_error())?;
        Ok(Self {
            prepared_input,
            header_json,
            frames,
            frame: 0,
            offset: 0,
            slots,
            last_complete: false,
            dialect,
            memory,
            chunk_memory: MemoryGroup::empty(context),
        })
    }

    pub fn direct(
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
        prepared_input: Option<&JsValue>,
        dialect: NumberDialect,
    ) -> Result<JsString, JsError> {
        Self::direct_with_memory(chart, input, size, prepared_input, dialect)
            .map(|value| value.into_parts().0)
    }

    /// Direct UI text와 source store account group을 caller에게 함께 이동한다.
    pub fn direct_with_memory(
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
        prepared_input: Option<&JsValue>,
        dialect: NumberDialect,
    ) -> Result<AccountedUiText, JsError> {
        let memory = chart.ingestion_owner().data().store().memory_context();
        let mut scope = memory.scope();
        let state = ui_state(chart, input, size, prepared_input, &mut scope)?;
        let temporary_text = direct_state_text_scoped(&state, dialect, &mut scope)?;
        let mut retained_scope = memory.scope();
        let text = temporary_text
            .try_clone_scoped(&mut retained_scope)
            .map_err(|failure| failure.into_js_error())?;
        let bytes = js_string_heap_bytes(&text);
        let memory = retained_scope
            .split_persistent(bytes)
            .map_err(|failure| failure.into_js_error())?;
        drop((state, temporary_text, scope));
        Ok(AccountedUiText { text, memory })
    }
}

#[cfg(test)]
fn direct_state_text(value: &JsValue, dialect: NumberDialect) -> Result<JsString, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    direct_state_text_scoped(value, dialect, &mut scope)
}

fn direct_state_text_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let text = safe_checkpoint_stringify_scoped(value, dialect, scope)?;
    if text.len_utf16() > UI_DIRECT_CHARS {
        return Err(range_error("Async UI state limit"));
    }
    Ok(text)
}

impl NativeUiCapture {
    pub fn header_json(&self) -> &JsString {
        &self.header_json
    }

    /// Header 반환 복사와 serialization 수명 group을 함께 만든다.
    pub fn header_json_accounted(&self) -> Result<AccountedUiText, JsError> {
        let context = self.memory.context();
        let mut scope = context.scope();
        let text = self
            .header_json
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let memory = scope
            .split_persistent(js_string_heap_bytes(&text))
            .map_err(|failure| failure.into_js_error())?;
        Ok(AccountedUiText { text, memory })
    }

    pub fn complete(&self) -> bool {
        self.last_complete
    }

    /// Header/frame/slot과 현재 반환 chunk가 실제로 보유한 requested bytes다.
    pub fn accounted_bytes(&self) -> u64 {
        self.memory
            .requested_bytes()
            .saturating_add(self.chunk_memory.requested_bytes())
    }

    pub fn check(
        &self,
        chart: &NativeChart,
        input: &OwnedInteractionState,
        size: &NativeSizeState,
    ) -> Result<(), JsError> {
        let context = self.memory.context().clone();
        let mut scope = context.scope();
        let state = ui_state(chart, input, size, self.prepared_input.as_ref(), &mut scope)?;
        let header = header_state(&state, &mut scope)?;
        let current_header = bounded_string_scoped(&header, self.dialect, &mut scope)?;
        let (frames, frames_memory) = drawing_frames(chart, &context)?;
        let same = same_drawing_frames(&self.frames, &frames);
        drop((frames, frames_memory));
        if current_header != self.header_json || !same {
            return Err(ordinary_error("Async stale: UI changed during transfer"));
        }
        Ok(())
    }

    pub fn next_chunk(&mut self) -> Result<JsString, JsError> {
        while self.frame < self.frames.len() && self.offset == self.frames[self.frame].len() {
            self.frame += 1;
            self.offset = 0;
        }
        if self.frame == self.frames.len() {
            self.last_complete = true;
            let context = self.memory.context().clone();
            let mut scope = context.scope();
            let text = JsString::try_from_str("{\"complete\":true}", &mut scope)
                .map_err(|failure| failure.into_js_error())?;
            let bytes = js_string_heap_bytes(&text);
            self.chunk_memory = scope
                .split_persistent(bytes)
                .map_err(|failure| failure.into_js_error())?;
            return Ok(text);
        }
        let context = self.memory.context().clone();
        let mut chunk_scope = context.scope();
        let items = &self.frames[self.frame];
        let start = self.offset;
        let mut refs = scoped_vec(UI_CHUNK_REFS, &mut chunk_scope)?;
        let mut records = scoped_vec(UI_CHUNK_REFS, &mut chunk_scope)?;
        let mut new_drawings = scoped_vec(UI_CHUNK_REFS, &mut chunk_scope)?;
        let mut points = 0usize;
        let mut at = start;
        while at < items.len() && refs.len() < UI_CHUNK_REFS {
            let drawing = &items[at];
            let existing = self
                .slots
                .iter()
                .position(|item| Arc::ptr_eq(item, drawing));
            let slot = existing.unwrap_or(self.slots.len() + records.len());
            let record = if existing.is_none() {
                let value = drawing_value_scoped(drawing, &mut chunk_scope)?;
                Some(object([
                    ("slot", JsValue::Number(slot as f64)),
                    ("drawing", value),
                ]))
            } else {
                None
            };
            refs.push(JsValue::Number(slot as f64));
            let added_record = record.is_some();
            if let Some(record) = record {
                records.push(record);
                new_drawings.push(Arc::clone(drawing));
                points += drawing.points.len();
            }
            let mut candidate_scope = context.scope();
            candidate_scope
                .try_grow(1_024)
                .map_err(|failure| failure.into_js_error())?;
            let packet = object([
                ("complete", JsValue::Bool(false)),
                ("frame", JsValue::Number(self.frame as f64)),
                ("offset", JsValue::Number(start as f64)),
                (
                    "refs",
                    JsValue::Array(clone_js_slice_scoped(&refs, &mut candidate_scope)?),
                ),
                (
                    "records",
                    JsValue::Array(clone_js_slice_scoped(&records, &mut candidate_scope)?),
                ),
            ]);
            let text =
                safe_checkpoint_stringify_scoped(&packet, self.dialect, &mut candidate_scope)?;
            let nodes = serialized_nodes(&packet, &mut candidate_scope)?;
            if text.len_utf16() > UI_CHUNK_CHARS
                || utf8_bytes(&text) > UI_CHUNK_UTF8
                || nodes > UI_CHUNK_NODES
                || points > UI_CHUNK_POINTS
            {
                refs.pop();
                if added_record {
                    records.pop();
                    new_drawings.pop();
                }
                if refs.is_empty() {
                    return Err(range_error("Async UI single record exceeds chunk budget"));
                }
                break;
            }
            at += 1;
        }
        for drawing in new_drawings {
            self.slots.push(drawing);
        }
        self.offset = at;
        chunk_scope
            .try_grow(1_024)
            .map_err(|failure| failure.into_js_error())?;
        let packet = object([
            ("complete", JsValue::Bool(false)),
            ("frame", JsValue::Number(self.frame as f64)),
            ("offset", JsValue::Number(start as f64)),
            ("refs", JsValue::Array(refs)),
            ("records", JsValue::Array(records)),
        ]);
        let temporary_text =
            safe_checkpoint_stringify_scoped(&packet, self.dialect, &mut chunk_scope)?;
        let mut result_scope = context.scope();
        let text = temporary_text
            .try_clone_scoped(&mut result_scope)
            .map_err(|failure| failure.into_js_error())?;
        let bytes = js_string_heap_bytes(&text);
        self.chunk_memory = result_scope
            .split_persistent(bytes)
            .map_err(|failure| failure.into_js_error())?;
        drop((packet, temporary_text, chunk_scope));
        Ok(text)
    }
}

fn same_drawing_frames(left: &[Vec<Arc<Drawing>>], right: &[Vec<Arc<Drawing>>]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| Arc::ptr_eq(left, right))
        })
}

/// UI finish 뒤 Root가 같은 call에서 게시하는 완성 후보다.
pub struct PreparedPublication {
    pub chart: NativeChart,
    pub input: Option<OwnedInteractionState>,
    pub width: JsValue,
    pub height: JsValue,
    pub memory: MemoryGroup,
    pending_host: Option<PendingUiHostState>,
}

struct PendingUiHostState {
    tool: JsValue,
    text: JsValue,
    drawing_target: Option<JsValue>,
    crosshair: Option<(f64, f64)>,
    symbol: JsValue,
    _memory: MemoryGroup,
}

impl PreparedPublication {
    pub(crate) fn ready(
        chart: NativeChart,
        input: OwnedInteractionState,
        width: JsValue,
        height: JsValue,
        memory: MemoryGroup,
    ) -> Self {
        Self {
            chart,
            input: Some(input),
            width,
            height,
            memory,
            pending_host: None,
        }
    }

    fn pending(
        chart: NativeChart,
        host_state: PendingUiHostState,
        width: JsValue,
        height: JsValue,
        memory: MemoryGroup,
    ) -> Self {
        Self {
            chart,
            input: None,
            width,
            height,
            memory,
            pending_host: Some(host_state),
        }
    }

    /// Source `nativeAsyncFinish` 순서로 fresh controller와 host symbol을 staging한다.
    pub(crate) fn finalize_host_state(&mut self, host: &dyn Host) -> Result<(), JsError> {
        let Some(pending) = self.pending_host.as_ref() else {
            debug_assert!(self.input.is_some(), "ready publication input");
            return Ok(());
        };
        let memory = self.chart.data().store().memory_context().clone();
        let mut input = OwnedInteractionState::from_native_ui_with_memory(
            key("select"),
            JsValue::String(JsString::default()),
            None,
            pending.crosshair,
            memory,
        )?;
        let width = match &self.width {
            JsValue::Number(value) => *value,
            _ => f64::NAN,
        };
        let height = match &self.height {
            JsValue::Number(value) => *value,
            _ => f64::NAN,
        };
        let mut api = ChartApi::with_controller(&mut self.chart, &mut input, host, width, height);
        api.dispatch(&key("setTool"), std::slice::from_ref(&pending.tool))?;
        api.dispatch(&key("setText"), std::slice::from_ref(&pending.text))?;
        let null_target = JsValue::Null;
        api.dispatch(
            &key("setDrawingTarget"),
            std::slice::from_ref(pending.drawing_target.as_ref().unwrap_or(&null_target)),
        )?;
        if js_truthy(&pending.symbol) {
            api.dispatch(&key("setSymbol"), std::slice::from_ref(&pending.symbol))?;
        }
        self.input = Some(input);
        self.pending_host = None;
        Ok(())
    }
}

/// Data target event가 UI view를 최종 보정하는 데 필요한 최소 정보다.
pub enum NativeUiFinishMode {
    Async {
        event: JsValue,
        source_length: usize,
        memory: MemoryGroup,
    },
    Prepare,
}

fn retain_finish_mode(
    mode: &NativeUiFinishMode,
    scope: &mut MemoryScope,
) -> Result<NativeUiFinishMode, JsError> {
    match mode {
        NativeUiFinishMode::Async {
            event,
            source_length,
            ..
        } => {
            let event = event
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            let memory = scope
                .split_persistent(js_value_heap_bytes(&event))
                .map_err(|failure| failure.into_js_error())?;
            Ok(NativeUiFinishMode::Async {
                event,
                source_length: *source_length,
                memory,
            })
        }
        NativeUiFinishMode::Prepare => Ok(NativeUiFinishMode::Prepare),
    }
}

struct ParsedUi {
    state: JsValue,
    stage: NativeUiModelStage,
    follow: bool,
    drawing_target: Option<JsValue>,
    tool: JsValue,
    text: JsValue,
    crosshair: Option<(f64, f64)>,
    symbol: JsValue,
    size: (JsValue, JsValue),
    ingestion: Option<JsString>,
}

fn retain_parsed_ui(parsed: ParsedUi, scope: &mut MemoryScope) -> Result<ParsedUi, JsError> {
    let ParsedUi {
        state,
        stage,
        follow,
        drawing_target,
        tool,
        text,
        crosshair,
        symbol,
        size,
        ingestion,
    } = parsed;
    Ok(ParsedUi {
        state: state
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        stage,
        follow,
        drawing_target: drawing_target
            .as_ref()
            .map(|value| {
                value
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())
            })
            .transpose()?,
        tool: tool
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        text: text
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        crosshair,
        symbol: symbol
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        size: (
            size.0
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            size.1
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        ingestion: ingestion
            .as_ref()
            .map(|value| {
                value
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())
            })
            .transpose()?,
    })
}

fn parsed_ui_heap_bytes(parsed: &ParsedUi) -> usize {
    js_value_heap_bytes(&parsed.state)
        .saturating_add(
            parsed
                .drawing_target
                .as_ref()
                .map_or(0, js_value_heap_bytes),
        )
        .saturating_add(js_value_heap_bytes(&parsed.tool))
        .saturating_add(js_value_heap_bytes(&parsed.text))
        .saturating_add(js_value_heap_bytes(&parsed.symbol))
        .saturating_add(js_value_heap_bytes(&parsed.size.0))
        .saturating_add(js_value_heap_bytes(&parsed.size.1))
        .saturating_add(parsed.ingestion.as_ref().map_or(0, js_string_heap_bytes))
}

fn parse_ui(
    core: &NativePreparedCore,
    value: &JsValue,
    mode: &NativeUiFinishMode,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<ParsedUi, JsError> {
    option_record(
        value,
        &[
            "preparedInput",
            "dataIngestion",
            "bindings",
            "view",
            "follow",
            "crosshair",
            "theme",
            "panels",
            "axes",
            "drawingTarget",
            "series",
            "precision",
            "axisWidth",
            "symbol",
            "drawings",
            "tool",
            "text",
            "size",
        ],
        "Async UI state",
    )?;
    match mode {
        NativeUiFinishMode::Prepare => {
            if !deep_same(
                field(value, "preparedInput").unwrap_or(&JsValue::Undefined),
                &core.prepared_input,
            ) {
                return Err(ordinary_error("Prepare stale: request/input binding"));
            }
        }
        NativeUiFinishMode::Async { .. } => {
            if field(value, "preparedInput").is_some() {
                return Err(type_error("Async unsupported preparation signature"));
            }
        }
    }
    let expected_bindings = bindings_from_parts(core, scope)?;
    if !deep_same(
        required(value, "bindings", "Async UI state")?,
        &expected_bindings,
    ) {
        return Err(ordinary_error("Async stale: indicator request binding"));
    }
    let view_value = required(value, "view", "Async view")?;
    option_record(view_value, &["from", "to"], "Async view")?;
    let (from, to) = match (field(view_value, "from"), field(view_value, "to")) {
        (Some(JsValue::Number(from)), Some(JsValue::Number(to)))
            if from.is_finite() && to.is_finite() && to > from =>
        {
            (*from, *to)
        }
        _ => return Err(type_error("Async view")),
    };
    let follow = match required(value, "follow", "Async view")? {
        JsValue::Bool(value) => *value,
        _ => return Err(type_error("Async view")),
    };
    let size = required(value, "size", "Async size")?;
    option_record(size, &["width", "height"], "Async size")?;
    let (width, height) = match (field(size, "width"), field(size, "height")) {
        (Some(JsValue::Number(width)), Some(JsValue::Number(height)))
            if width.is_finite()
                && (100.0..=RESOURCE_LIMITS.max_canvas_dimension as f64).contains(width)
                && height.is_finite()
                && (80.0..=RESOURCE_LIMITS.max_canvas_dimension as f64).contains(height) =>
        {
            (JsValue::Number(*width), JsValue::Number(*height))
        }
        _ => return Err(type_error("Async size")),
    };
    let crosshair = match required(value, "crosshair", "Async crosshair")? {
        JsValue::Null => None,
        crosshair => {
            option_record(crosshair, &["x", "y"], "Async crosshair")?;
            match (field(crosshair, "x"), field(crosshair, "y")) {
                (Some(JsValue::Number(x)), Some(JsValue::Number(y)))
                    if x.is_finite() && y.is_finite() =>
                {
                    Some((*x, *y))
                }
                _ => return Err(type_error("Async crosshair")),
            }
        }
    };
    let precision = exact_usize(
        required(value, "precision", "Async precision")?,
        18,
        "Async precision",
    )? as u8;
    let axis_width = match required(value, "axisWidth", "Async axis width")? {
        JsValue::Number(value) if value.is_finite() && *value >= 20.0 => *value,
        _ => return Err(type_error("Async axis width")),
    };
    let theme_value = required(value, "theme", "Async theme")?;
    option_record(theme_value, THEME_KEYS, "Async theme")?;
    let theme = portable_style_scoped(
        theme_value,
        &["background", "grid", "text", "up", "down", "crosshair"],
        true,
        scope,
    )?;
    let panels = required(value, "panels", "Async UI collections")?;
    let panel_values = array(panels, "Async UI collections")?;
    let series = required(value, "series", "Async UI collections")?;
    let series_values = array(series, "Async UI collections")?;
    if panel_values.is_empty()
        || panel_values.len() > 32
        || series_values.len() != core.model.series.len()
    {
        return Err(type_error("Async UI collections"));
    }
    for panel in panel_values {
        option_record(panel, PANEL_KEYS, "Async panel")?;
        if !matches!(field(panel, "formatter"), None | Some(JsValue::Undefined)) {
            return Err(type_error("Async unsupported panel formatter callback"));
        }
    }
    let axes = required(value, "axes", "Async UI axes")?;
    for axis in array(axes, "Async UI axes")? {
        option_record(axis, AXIS_KEYS, "Async axis")?;
        if !matches!(field(axis, "formatter"), None | Some(JsValue::Undefined)) {
            return Err(type_error("Async unsupported axis formatter callback"));
        }
    }
    let mut presentation_keys = scoped_vec(SERIES_KEYS.len(), scope)?;
    presentation_keys.extend(
        SERIES_KEYS
            .iter()
            .copied()
            .filter(|name| !matches!(*name, "values" | "indicator" | "output" | "source")),
    );
    let mut patches = scoped_vec(series_values.len(), scope)?;
    for patch in series_values {
        option_record(patch, &presentation_keys, "Async series patch")?;
        patches.push(portable_style_scoped(
            patch,
            &["color", "fill", "upColor", "downColor"],
            true,
            scope,
        )?);
    }
    scope
        .try_grow(
            core.indicators
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 256),
        )
        .map_err(|failure| failure.into_js_error())?;
    let ids = core.indicators.entry_ids();
    let mut projections = scoped_vec(ids.len(), scope)?;
    for id in ids {
        if let Some(entry) = core.indicators.entry(&JsValue::String(id)) {
            projections.push(IndicatorProjection {
                id: entry.id(),
                definition: entry.definition(),
            });
        }
    }
    let context = ModelContext {
        store: core.owner.data().store(),
        indicators: &projections,
        drawings: DrawingUsage::default(),
        interaction: InteractionGuard::default(),
    };
    let null_target = JsValue::Null;
    let drawing_target_value = field(value, "drawingTarget").unwrap_or(&null_target);
    let stage = core.model.stage_native_ui(
        core.owner.data().store(),
        panels,
        axes,
        &theme,
        &patches,
        VisibleRange { from, to },
        follow,
        axis_width,
        precision,
        drawing_target_value,
        &context,
    )?;
    let drawing_target = stage
        .drawing_target()
        .map(|value| {
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())
        })
        .transpose()?;
    let undefined = JsValue::Undefined;
    let tool = field(value, "tool")
        .unwrap_or(&undefined)
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())?;
    let text_value = field(value, "text")
        .unwrap_or(&undefined)
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())?;
    let symbol = field(value, "symbol")
        .map(|value| {
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())
        })
        .transpose()?
        .unwrap_or(JsValue::Null);
    if js_truthy(&symbol) {
        validate_symbol_shape(&symbol)?;
    }
    let ingestion = match field(value, "dataIngestion") {
        None | Some(JsValue::Undefined) => None,
        Some(value) => Some(string_scoped(value, "Ingestion document string", scope)?),
    };
    let _ = dialect;
    Ok(ParsedUi {
        state: value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        stage,
        follow,
        drawing_target,
        tool,
        text: text_value,
        crosshair,
        symbol,
        size: (width, height),
        ingestion,
    })
}

fn bindings_from_parts(
    core: &NativePreparedCore,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let engine = &core.indicators;
    scope
        .try_grow(
            engine
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 256),
        )
        .map_err(|failure| failure.into_js_error())?;
    let ids = engine.entry_ids();
    let mut rows = scoped_vec(ids.len(), scope)?;
    for id in ids {
        let lookup = id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let Some(entry) = engine.entry(&JsValue::String(lookup)) else {
            continue;
        };
        scope
            .try_grow(8 * std::mem::size_of::<(JsString, JsValue)>() + 512)
            .map_err(|failure| failure.into_js_error())?;
        let mut row = JsObject::new();
        row.insert(key("id"), JsValue::String(id));
        row.insert(
            key("name"),
            JsValue::String(
                entry
                    .name()
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        );
        row.insert(
            key("params"),
            entry
                .params()
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
        if matches!(
            entry.definition().provenance,
            IndicatorProvenance::Linked(_)
        ) {
            scope
                .try_grow(1_024)
                .map_err(|failure| failure.into_js_error())?;
            row.insert(key("module"), pressure_descriptor_value());
        }
        let mut outputs = scoped_vec(entry.definition().outputs.len(), scope)?;
        for output in entry.definition().outputs {
            scope
                .try_grow(output.len().saturating_mul(2))
                .map_err(|failure| failure.into_js_error())?;
            outputs.push(text(output));
        }
        row.insert(key("outputs"), JsValue::Array(outputs));
        scope
            .try_grow(
                entry
                    .definition()
                    .plot_offsets
                    .len()
                    .saturating_mul(std::mem::size_of::<(JsString, JsValue)>() + 64),
            )
            .map_err(|failure| failure.into_js_error())?;
        let mut offsets = JsObject::new();
        for offset in &entry.definition().plot_offsets {
            offsets.insert(key(offset.output), JsValue::Number(offset.value));
        }
        row.insert(key("plotOffsets"), JsValue::Object(offsets));
        rows.push(JsValue::Object(row));
    }
    Ok(JsValue::Array(rows))
}

fn drawing_store_from_direct(
    parsed: &ParsedUi,
    dialect: NumberDialect,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<DrawingStore, JsError> {
    let drawings = required(&parsed.state, "drawings", "Async drawings")?;
    option_record(
        drawings,
        &["limits", "items", "undo", "redo", "selected", "serial"],
        "Async drawings",
    )?;
    let limits = required(drawings, "limits", "Async drawings")?;
    let mut store = DrawingStore::from_options_with_memory(limits, dialect, memory.clone())?;
    let drawing_memory = store.memory_context().clone();
    let history_count = array(
        required(drawings, "undo", "Async drawing history")?,
        "Async drawing history",
    )?
    .len()
        + array(
            required(drawings, "redo", "Async drawing history")?,
            "Async drawing history",
        )?
        .len()
        + 1;
    let mut memo: Vec<(JsString, DrawingSnapshot)> = scoped_vec(history_count, scope)?;
    let mut restore = |value: &JsValue| -> Result<DrawingSnapshot, JsError> {
        let key_text = safe_checkpoint_stringify_scoped(value, dialect, scope)?;
        if let Some((_, frame)) = memo.iter().find(|(key, _)| key == &key_text) {
            return Ok(Arc::clone(frame));
        }
        let frame = restore_frame(value, &parsed.stage, dialect, &drawing_memory, scope)?;
        memo.push((key_text, Arc::clone(&frame)));
        Ok(frame)
    };
    let items = restore(required(drawings, "items", "Async drawings")?)?;
    let undo_values = array(
        required(drawings, "undo", "Async drawing history")?,
        "Async drawing history",
    )?;
    let (mut undo, undo_memory) = memory
        .try_vec_capacity(undo_values.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in undo_values {
        undo.push(restore(value)?);
    }
    let undo = DrawingSnapshotList::try_from_vec(undo, undo_memory)?;
    let redo_values = array(
        required(drawings, "redo", "Async drawing history")?,
        "Async drawing history",
    )?;
    let (mut redo, redo_memory) = memory
        .try_vec_capacity(redo_values.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in redo_values {
        redo.push(restore(value)?);
    }
    let redo = DrawingSnapshotList::try_from_vec(redo, redo_memory)?;
    let selected = match required(drawings, "selected", "Async selection")? {
        JsValue::Null => None,
        JsValue::String(value) => Some(
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        _ => return Err(type_error("Async selection")),
    };
    let serial = drawing_serial(required(drawings, "serial", "Async drawing serial")?)?;
    store.install_native_ui_history(items, undo, redo, selected, serial)?;
    Ok(store)
}

fn restore_frame(
    value: &JsValue,
    stage: &NativeUiModelStage,
    dialect: NumberDialect,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<DrawingSnapshot, JsError> {
    let values = array(value, "Async drawing history")?;
    let mut ids = HashSet::new();
    scope
        .try_grow(
            values
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 32),
        )
        .map_err(|failure| failure.into_js_error())?;
    ids.try_reserve(values.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    let (mut frame, frame_memory) = memory
        .try_vec_capacity(values.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in values {
        let drawing = Arc::new(canonical_drawing_scoped(value, dialect, memory, scope)?);
        let id = drawing
            .id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        if !ids.insert(id) {
            return Err(type_error("Async duplicate drawing ids"));
        }
        stage.validate_drawing_binding(&drawing_value_scoped(&drawing, scope)?)?;
        frame.push(drawing);
    }
    DrawingFrame::try_from_vec(frame, frame_memory)
}

fn build_publication(
    mut core: NativePreparedCore,
    parsed: ParsedUi,
    drawings: DrawingStore,
    mode: NativeUiFinishMode,
    dialect: NumberDialect,
) -> Result<PreparedPublication, JsError> {
    let memory_context = core.owner.data().store().memory_context().clone();
    let host_state = prepare_pending_host_state(&parsed, &memory_context)?;
    if let Some(document) = parsed.ingestion.as_ref() {
        let mut load_scope = memory_context.scope();
        let document = document
            .try_clone_scoped(&mut load_scope)
            .map_err(|failure| failure.into_js_error())?;
        let stats = core
            .owner
            .load(&JsValue::String(document))
            .map_err(ingestion_error)?;
        if matches!(field(&stats, "pendingEvents"), Some(JsValue::Number(value)) if *value != 0.0) {
            core.owner.dispose();
            return Err(ordinary_error("Async ingestion payload must be empty"));
        }
    }
    let prepared_view = core.model.view;
    core.model.publish_native_ui(parsed.stage);
    apply_view_effect(
        &mut core.model,
        core.owner.data().store(),
        &mode,
        prepared_view,
        parsed.follow,
    );
    let chart = NativeChart::from_parts(NativeChartParts {
        ingestion: core.owner,
        model: core.model,
        indicators: core.indicators,
        drawings,
        series_caches: core.caches,
        symbol: None,
        symbol_record: None,
        symbol_formatters: false,
        symbol_memory: MemoryGroup::empty(memory_context.clone()),
        dialect,
    })?;
    let publication_memory = MemoryGroup::empty(memory_context.clone());
    Ok(PreparedPublication::pending(
        chart,
        host_state,
        parsed.size.0,
        parsed.size.1,
        publication_memory,
    ))
}

fn apply_view_effect(
    model: &mut crate::model_state::ModelState,
    store: &crate::data::BarStore,
    mode: &NativeUiFinishMode,
    prepared_view: VisibleRange,
    source_follow: bool,
) {
    if matches!(mode, NativeUiFinishMode::Prepare) {
        if source_follow {
            model.publish_view_replacement(prepared_view, true);
        }
        return;
    }
    let NativeUiFinishMode::Async {
        event,
        source_length,
        ..
    } = mode
    else {
        return;
    };
    let kind = field(event, "kind");
    if matches!(kind, Some(JsValue::String(value)) if value == &key("prepend"))
        && *source_length > 0
    {
        let added = field(event, "bars")
            .and_then(|value| match value {
                JsValue::Array(values) => Some(values.len()),
                _ => None,
            })
            .unwrap_or(0) as f64;
        model.publish_view_replacement(
            VisibleRange {
                from: model.view.from + added,
                to: model.view.to + added,
            },
            model.follow,
        );
    } else if matches!(kind, Some(JsValue::String(value)) if value == &key("reset")) {
        model.fit(store);
    } else {
        let appended = matches!(kind, Some(JsValue::String(value)) if value == &key("append"))
            || matches!(kind, Some(JsValue::String(value)) if value == &key("batch"))
                && field(event, "events").is_some_and(|events| {
                    matches!(events, JsValue::Array(events) if events.iter().any(|event| matches!(field(event, "kind"), Some(JsValue::String(value)) if value == &key("append"))))
                })
            || matches!(kind, Some(JsValue::String(value)) if value == &key("prepend"))
                && *source_length == 0
                && field(event, "bars").is_some_and(|bars| matches!(bars, JsValue::Array(values) if !values.is_empty()));
        if appended && model.follow {
            let span = model.view.to - model.view.from;
            let to = store.length() as f64 + model.forward_offset() - 0.5;
            model.publish_view_replacement(
                VisibleRange {
                    from: to - span,
                    to,
                },
                true,
            );
        }
    }
}

/// Direct UI document를 ready core에 적용한다.
pub fn finish_direct(
    core: NativePreparedCore,
    text: &JsString,
    mode: NativeUiFinishMode,
    _host: &dyn Host,
    dialect: NumberDialect,
) -> Result<PreparedPublication, JsError> {
    let memory = core.owner.data().store().memory_context().clone();
    let mut scope = memory.scope();
    let mode = retain_finish_mode(&mode, &mut scope)?;
    let parse_text = text
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let value = safe_checkpoint_parse_scoped(&JsValue::String(parse_text), dialect, &mut scope)?;
    let parsed = parse_ui(&core, &value, &mode, dialect, &mut scope)?;
    let drawings = drawing_store_from_direct(&parsed, dialect, &memory, &mut scope)?;
    let publication = build_publication(core, parsed, drawings, mode, dialect)?;
    drop((value, scope));
    Ok(publication)
}

/// Header/chunk UI target import다.
pub struct NativeUiImport {
    core: Option<NativePreparedCore>,
    parsed: Option<ParsedUi>,
    pending_state: Option<JsValue>,
    _pending_state_memory: MemoryGroup,
    mode: Option<NativeUiFinishMode>,
    store: DrawingStore,
    counts: Vec<usize>,
    frames: Vec<Vec<Arc<Drawing>>>,
    _frame_memory: Vec<MemoryGroup>,
    records: Vec<Arc<Drawing>>,
    used: HashSet<usize>,
    frame: usize,
    offset: usize,
    finished: bool,
    new_points: usize,
    new_text: usize,
    dialect: NumberDialect,
    memory: MemoryGroup,
    publication: Option<PendingUiPublication>,
}

struct PendingUiPublication {
    parts: Option<NativeChartParts>,
    chart: Option<NativeChart>,
    host_state: Option<PendingUiHostState>,
    width: JsValue,
    height: JsValue,
}

impl PendingUiPublication {
    fn resume(&mut self) -> Result<PreparedPublication, JsError> {
        if self.chart.is_none() {
            let parts = self.parts.take().expect("pending publication parts");
            match NativeChart::try_from_parts_recoverable(parts) {
                Ok(chart) => self.chart = Some(chart),
                Err((error, parts)) => {
                    self.parts = Some(parts);
                    return Err(error);
                }
            }
        }
        let chart = self.chart.take().expect("validated publication chart");
        let memory = chart.data().store().memory_context().clone();
        Ok(PreparedPublication::pending(
            chart,
            self.host_state.take().expect("pending host UI state"),
            std::mem::replace(&mut self.width, JsValue::Undefined),
            std::mem::replace(&mut self.height, JsValue::Undefined),
            MemoryGroup::empty(memory),
        ))
    }
}

impl NativeUiImport {
    /// Target core readiness보다 먼저 protocol/header 전체를 검사한다.
    pub fn validate_header(text: &JsString, dialect: NumberDialect) -> Result<(), JsError> {
        Self::validate_header_with_memory(
            text,
            dialect,
            &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
    }

    /// Header error priority를 유지하며 parser scratch를 explicit runtime account에 묶는다.
    pub fn validate_header_with_memory(
        text: &JsString,
        dialect: NumberDialect,
        memory: &MemoryContext,
    ) -> Result<(), JsError> {
        let mut scope = memory.scope();
        let parse_text = text
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let header =
            safe_checkpoint_parse_scoped(&JsValue::String(parse_text), dialect, &mut scope)?;
        option_record(&header, &["schema", "protocol", "state"], "Async UI header")?;
        if !matches!(field(&header, "schema"), Some(JsValue::String(value)) if value == &key("aster.async.ui"))
            || !matches!(field(&header, "protocol"), Some(JsValue::Number(1.0)))
            || !matches!(field(&header, "state"), Some(JsValue::Object(_)))
        {
            return Err(type_error("Async UI protocol"));
        }
        let state = required(&header, "state", "Async UI protocol")?;
        let drawings = required(state, "drawings", "Async drawing header")?;
        option_record(
            drawings,
            &[
                "limits",
                "frameCounts",
                "undoCount",
                "redoCount",
                "selected",
                "serial",
            ],
            "Async drawing header",
        )?;
        let store = DrawingStore::from_options_with_memory(
            required(drawings, "limits", "Async drawing limits")?,
            dialect,
            memory.clone(),
        )?;
        let undo_count = exact_usize(
            required(drawings, "undoCount", "Async undo count")?,
            store.config().history_limit,
            "Async undo count",
        )?;
        let redo_count = exact_usize(
            required(drawings, "redoCount", "Async redo count")?,
            store.config().history_limit,
            "Async redo count",
        )?;
        drawing_serial(required(drawings, "serial", "Async drawing serial")?)?;
        let count_values = array(
            required(drawings, "frameCounts", "Async UI frame counts")?,
            "Async UI frame counts",
        )?;
        if count_values.len() != 1 + undo_count + redo_count {
            return Err(type_error("Async UI frame counts"));
        }
        let mut references = 0usize;
        for value in count_values {
            references = references.saturating_add(exact_usize(
                value,
                store.config().max_drawings,
                "Async UI frame size",
            )?);
        }
        if references > store.config().max_drawings + store.config().history_bytes.saturating_div(8)
        {
            return Err(range_error("Async UI history reference budget"));
        }
        Ok(())
    }

    /// Ready core가 없어도 header와 chunk 상태를 explicit runtime account에 보존한다.
    pub fn new_pending(
        text: &JsString,
        dialect: NumberDialect,
        context: MemoryContext,
    ) -> Result<Self, JsError> {
        let mut scope = context.scope();
        let parse_text = text
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let header =
            safe_checkpoint_parse_scoped(&JsValue::String(parse_text), dialect, &mut scope)?;
        option_record(&header, &["schema", "protocol", "state"], "Async UI header")?;
        if !matches!(field(&header, "schema"), Some(JsValue::String(value)) if value == &key("aster.async.ui"))
            || !matches!(field(&header, "protocol"), Some(JsValue::Number(1.0)))
            || !matches!(field(&header, "state"), Some(JsValue::Object(_)))
        {
            return Err(type_error("Async UI protocol"));
        }
        let state = required(&header, "state", "Async UI protocol")?;
        let drawings = required(state, "drawings", "Async drawing header")?;
        option_record(
            drawings,
            &[
                "limits",
                "frameCounts",
                "undoCount",
                "redoCount",
                "selected",
                "serial",
            ],
            "Async drawing header",
        )?;
        let store = DrawingStore::from_options_with_memory(
            required(drawings, "limits", "Async drawing limits")?,
            dialect,
            context.clone(),
        )?;
        let undo_count = exact_usize(
            required(drawings, "undoCount", "Async undo count")?,
            store.config().history_limit,
            "Async undo count",
        )?;
        let redo_count = exact_usize(
            required(drawings, "redoCount", "Async redo count")?,
            store.config().history_limit,
            "Async redo count",
        )?;
        drawing_serial(required(drawings, "serial", "Async drawing serial")?)?;
        let count_values = array(
            required(drawings, "frameCounts", "Async UI frame counts")?,
            "Async UI frame counts",
        )?;
        if count_values.len() != 1 + undo_count + redo_count {
            return Err(type_error("Async UI frame counts"));
        }
        let (mut counts, mut memory) = context
            .try_vec_capacity(count_values.len())
            .map_err(|failure| failure.into_js_error())?;
        for value in count_values {
            counts.push(exact_usize(
                value,
                store.config().max_drawings,
                "Async UI frame size",
            )?);
        }
        let references = counts.iter().sum::<usize>();
        if references > store.config().max_drawings + store.config().history_bytes.saturating_div(8)
        {
            return Err(range_error("Async UI history reference budget"));
        }
        let (mut frames, frames_memory) = context
            .try_vec_capacity(counts.len())
            .map_err(|failure| failure.into_js_error())?;
        memory
            .absorb(frames_memory)
            .map_err(|failure| failure.into_js_error())?;
        let (mut frame_memory, frame_memory_slots) = context
            .try_vec_capacity(counts.len())
            .map_err(|failure| failure.into_js_error())?;
        memory
            .absorb(frame_memory_slots)
            .map_err(|failure| failure.into_js_error())?;
        for count in &counts {
            let (frame, group) = context
                .try_vec_capacity(*count)
                .map_err(|failure| failure.into_js_error())?;
            frames.push(frame);
            frame_memory.push(group);
        }
        let (records, records_memory) = context
            .try_vec_capacity(references)
            .map_err(|failure| failure.into_js_error())?;
        memory
            .absorb(records_memory)
            .map_err(|failure| failure.into_js_error())?;
        let mut used = HashSet::new();
        let used_memory = context
            .reserve_group(
                references.saturating_mul(std::mem::size_of::<usize>().saturating_add(32)),
            )
            .map_err(|failure| failure.into_js_error())?;
        used.try_reserve(references)
            .map_err(|_| context.allocation_failure().into_js_error())?;
        memory
            .absorb(used_memory)
            .map_err(|failure| failure.into_js_error())?;
        let mut retained_scope = context.scope();
        let pending_state = state
            .try_clone_scoped(&mut retained_scope)
            .map_err(|failure| failure.into_js_error())?;
        let state_bytes = js_value_heap_bytes(&pending_state);
        let pending_state_memory = retained_scope
            .split_persistent(state_bytes)
            .map_err(|failure| failure.into_js_error())?;
        drop((header, scope));
        Ok(Self {
            core: None,
            parsed: None,
            pending_state: Some(pending_state),
            _pending_state_memory: pending_state_memory,
            mode: None,
            store,
            frames,
            _frame_memory: frame_memory,
            counts,
            records,
            used,
            frame: 0,
            offset: 0,
            finished: false,
            new_points: 0,
            new_text: 0,
            dialect,
            memory,
            publication: None,
        })
    }

    pub fn new(
        text: &JsString,
        core: NativePreparedCore,
        mode: NativeUiFinishMode,
        dialect: NumberDialect,
    ) -> Result<Self, JsError> {
        let context = core.owner.data().store().memory_context().clone();
        let mut import = Self::new_pending(text, dialect, context)?;
        import.install_core(core, mode)?;
        Ok(import)
    }

    /// Ready target core를 한 번만 인수하고 core-dependent UI stage를 준비한다.
    pub fn install_core(
        &mut self,
        core: NativePreparedCore,
        mode: NativeUiFinishMode,
    ) -> Result<(), JsError> {
        if self.core.is_some() || self.mode.is_some() {
            return Err(ordinary_error("Async UI target unavailable"));
        }
        self.core = Some(core);
        self.mode = Some(mode);
        self.attach_core()
    }

    /// Attach OOM/validation 실패 뒤에도 core/state를 보존해 같은 End가 재시도할 수 있다.
    pub fn attach_core(&mut self) -> Result<(), JsError> {
        if self.parsed.is_some() {
            return Ok(());
        }
        let core = self
            .core
            .as_ref()
            .ok_or_else(|| ordinary_error("Async result not ready"))?;
        let mode = self
            .mode
            .as_ref()
            .ok_or_else(|| ordinary_error("Async result not ready"))?;
        let state = self
            .pending_state
            .as_ref()
            .ok_or_else(|| ordinary_error("Async result not ready"))?;
        let context = self.memory.context().clone();
        let mut scope = context.scope();
        let parsed = parse_ui(core, state, mode, self.dialect, &mut scope)?;
        for drawing in &self.records {
            parsed
                .stage
                .validate_drawing_binding(&drawing_value_scoped(drawing, &mut scope)?)?;
        }
        let parsed = retain_parsed_ui(parsed, &mut scope)?;
        let parse_bytes = parsed_ui_heap_bytes(&parsed);
        let parsed_memory = scope
            .split_persistent(parse_bytes)
            .map_err(|failure| failure.into_js_error())?;
        self.memory
            .absorb(parsed_memory)
            .map_err(|failure| failure.into_js_error())?;
        self.parsed = Some(parsed);
        self.pending_state = None;
        self._pending_state_memory = MemoryGroup::empty(context);
        Ok(())
    }

    /// Core-dependent stage가 준비됐는지 반환한다.
    pub fn attached(&self) -> bool {
        self.parsed.is_some() || self.publication.is_some()
    }

    /// Ready target core를 이미 UI import가 소유하는지 반환한다.
    pub fn core_installed(&self) -> bool {
        self.core.is_some()
    }

    /// 실패한 UI End 뒤 direct finish가 원래 ready core를 회수한다.
    pub fn take_core_for_direct(&mut self) -> Option<(NativePreparedCore, NativeUiFinishMode)> {
        if self.publication.is_some() {
            return None;
        }
        let core = self.core.take()?;
        let Some(mode) = self.mode.take() else {
            self.core = Some(core);
            return None;
        };
        Some((core, mode))
    }

    fn skip_empty(&mut self) -> Result<(), JsError> {
        while self.frame < self.counts.len() && self.offset == self.counts[self.frame] {
            let mut scope = self.memory.context().scope();
            let mut ids = HashSet::new();
            scope
                .try_grow(
                    self.frames[self.frame]
                        .len()
                        .saturating_mul(std::mem::size_of::<JsString>() + 32),
                )
                .map_err(|failure| failure.into_js_error())?;
            ids.try_reserve(self.frames[self.frame].len())
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            for drawing in &self.frames[self.frame] {
                let id = drawing
                    .id
                    .try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?;
                if !ids.insert(id) {
                    return Err(type_error("Async duplicate drawing ids"));
                }
            }
            self.store
                .validate_native_ui_frame(&self.frames[self.frame])?;
            self.frame += 1;
            self.offset = 0;
        }
        Ok(())
    }

    pub fn chunk(&mut self, text: &JsString) -> Result<(), JsError> {
        if self.finished {
            return Err(ordinary_error("Async UI import finished"));
        }
        if text.len_utf16() > UI_CHUNK_CHARS {
            return Err(range_error("Async UI chunk text"));
        }
        let context = self.memory.context().clone();
        let mut scope = context.scope();
        let parse_text = text
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let packet =
            safe_checkpoint_parse_scoped(&JsValue::String(parse_text), self.dialect, &mut scope)?;
        option_record(
            &packet,
            &["complete", "frame", "offset", "refs", "records"],
            "Async UI chunk",
        )?;
        self.skip_empty()?;
        let refs = array(
            required(&packet, "refs", "Async UI chunk order/offset")?,
            "Async UI chunk order/offset",
        )?;
        let records = array(
            required(&packet, "records", "Async UI chunk order/offset")?,
            "Async UI chunk order/offset",
        )?;
        if !matches!(field(&packet, "complete"), Some(JsValue::Bool(false)))
            || !matches!(field(&packet, "frame"), Some(JsValue::Number(value)) if *value == self.frame as f64)
            || !matches!(field(&packet, "offset"), Some(JsValue::Number(value)) if *value == self.offset as f64)
            || refs.is_empty()
            || refs.len() > UI_CHUNK_REFS
            || records.len() > UI_CHUNK_REFS
            || self.frame >= self.counts.len()
            || self.offset + refs.len() > self.counts[self.frame]
        {
            return Err(type_error("Async UI chunk order/offset"));
        }
        let mut points = 0usize;
        for row in records {
            option_record(row, &["slot", "drawing"], "Async UI record")?;
            let slot = exact_usize(
                required(row, "slot", "Async UI record slot")?,
                usize::MAX,
                "Async UI record slot",
            )?;
            if slot != self.records.len() {
                return Err(type_error("Async UI record slot"));
            }
            let value = required(row, "drawing", "Async UI record")?;
            let drawing = Arc::new(canonical_drawing_scoped(
                value,
                self.dialect,
                &context,
                &mut scope,
            )?);
            let drawing_value = drawing_value_scoped(&drawing, &mut scope)?;
            if let Some(parsed) = self.parsed.as_ref() {
                parsed.stage.validate_drawing_binding(&drawing_value)?;
            } else {
                validate_pending_drawing_binding(
                    self.pending_state.as_ref().expect("pending import state"),
                    &drawing_value,
                )?;
            }
            points = points.saturating_add(drawing.points.len());
            self.new_points = self.new_points.saturating_add(drawing.points.len());
            let text_units =
                safe_checkpoint_stringify_scoped(&drawing_value, self.dialect, &mut scope)?
                    .len_utf16();
            self.new_text = self.new_text.saturating_add(text_units);
            if points > UI_CHUNK_POINTS
                || self.new_points
                    > self
                        .store
                        .config()
                        .max_points
                        .saturating_add(self.store.config().history_bytes.saturating_div(32))
                || self.new_text
                    > self
                        .store
                        .config()
                        .max_points
                        .saturating_mul(96)
                        .saturating_add(self.store.config().max_drawings.saturating_mul(3072))
                        .saturating_add(self.store.config().history_bytes.saturating_div(2))
            {
                return Err(range_error("Async UI unique record budget"));
            }
            self.records.push(drawing);
        }
        let mut candidate_refs = scoped_vec(refs.len(), &mut scope)?;
        for reference in refs {
            let slot = exact_usize(
                reference,
                self.records.len().saturating_sub(1),
                "Async UI reference slot",
            )?;
            let Some(drawing) = self.records.get(slot) else {
                return Err(type_error("Async UI reference slot"));
            };
            self.used.insert(slot);
            candidate_refs.push(Arc::clone(drawing));
        }
        for drawing in candidate_refs {
            self.frames[self.frame].push(drawing);
            self.offset += 1;
        }
        Ok(())
    }

    /// Source finish와 같은 순서로 transfer completeness를 검사한다.
    pub fn validate_complete(&mut self) -> Result<(), JsError> {
        if self.finished {
            return Err(ordinary_error("Async UI import finished"));
        }
        self.skip_empty()?;
        if self.frame != self.frames.len() {
            return Err(ordinary_error("Async UI incomplete transfer"));
        }
        if self.used.len() != self.records.len() {
            return Err(type_error("Async UI unused record"));
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<PreparedPublication, JsError> {
        if self.publication.is_some() {
            return self.complete_publication();
        }
        self.validate_complete()?;
        self.attach_core()?;
        let parsed = self.parsed.as_ref().expect("attached import");
        let drawings = required(&parsed.state, "drawings", "Async drawing header")?;
        let undo_count = exact_usize(
            required(drawings, "undoCount", "Async undo count")?,
            self.store.config().history_limit,
            "Async undo count",
        )?;
        let context = self.memory.context().clone();
        let mut finish_scope = context.scope();
        let selected = match required(drawings, "selected", "Async selection")? {
            JsValue::Null => None,
            JsValue::String(value) => Some(
                value
                    .try_clone_scoped(&mut finish_scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
            _ => return Err(type_error("Async selection")),
        };
        let serial = drawing_serial(required(drawings, "serial", "Async drawing serial")?)?;
        let limits = required(drawings, "limits", "Async drawing limits")?;
        let mut store =
            DrawingStore::from_options_with_memory(limits, self.dialect, context.clone())?;
        let (mut undo, undo_memory) = context
            .try_vec_capacity(undo_count)
            .map_err(|failure| failure.into_js_error())?;
        let redo_count = self.frames.len().saturating_sub(1 + undo_count);
        let (mut redo, redo_memory) = context
            .try_vec_capacity(redo_count)
            .map_err(|failure| failure.into_js_error())?;
        let mut items = None;
        for (index, frame) in self.frames.iter().enumerate() {
            let snapshot = DrawingFrame::try_clone_slice(frame, &context)?;
            if index == 0 {
                items = Some(snapshot);
            } else if index <= undo_count {
                undo.push(snapshot);
            } else {
                redo.push(snapshot);
            }
        }
        let items = items.expect("UI import always has a current drawing frame");
        let undo = DrawingSnapshotList::try_from_vec(undo, undo_memory)?;
        let redo = DrawingSnapshotList::try_from_vec(redo, redo_memory)?;
        store.install_native_ui_history(items, undo, redo, selected, serial)?;
        let host_state = prepare_pending_host_state(parsed, &context)?;
        if let Some(document) = parsed.ingestion.as_ref() {
            let mut load_scope = context.scope();
            let document = document
                .try_clone_scoped(&mut load_scope)
                .map_err(|failure| failure.into_js_error())?;
            let stats = self
                .core
                .as_mut()
                .expect("attached import core")
                .owner
                .load(&JsValue::String(document))
                .map_err(ingestion_error)?;
            if matches!(field(&stats, "pendingEvents"), Some(JsValue::Number(value)) if *value != 0.0)
            {
                self.core
                    .as_mut()
                    .expect("attached import core")
                    .owner
                    .dispose();
                return Err(ordinary_error("Async ingestion payload must be empty"));
            }
        }
        let mut core = self.core.take().expect("active import");
        let parsed = self.parsed.take().expect("attached import");
        let mode = self.mode.take().expect("active import mode");
        let ParsedUi {
            state: _,
            stage,
            follow,
            drawing_target: _,
            tool: _,
            text: _,
            crosshair: _,
            symbol: _,
            size: (width, height),
            ingestion: _,
        } = parsed;
        let prepared_view = core.model.view;
        core.model.publish_native_ui(stage);
        apply_view_effect(
            &mut core.model,
            core.owner.data().store(),
            &mode,
            prepared_view,
            follow,
        );
        self.publication = Some(PendingUiPublication {
            parts: Some(NativeChartParts {
                ingestion: core.owner,
                model: core.model,
                indicators: core.indicators,
                drawings: store,
                series_caches: core.caches,
                symbol: None,
                symbol_record: None,
                symbol_formatters: false,
                symbol_memory: MemoryGroup::empty(context.clone()),
                dialect: self.dialect,
            }),
            chart: None,
            host_state: Some(host_state),
            width,
            height,
        });
        drop(finish_scope);
        self.complete_publication()
    }

    fn complete_publication(&mut self) -> Result<PreparedPublication, JsError> {
        let publication = self
            .publication
            .as_mut()
            .expect("pending UI publication")
            .resume()?;
        self.publication = None;
        let context = self.memory.context().clone();
        self.counts = Vec::new();
        self.frames = Vec::new();
        self._frame_memory = Vec::new();
        self.records = Vec::new();
        self.used = HashSet::new();
        self.pending_state = None;
        self._pending_state_memory = MemoryGroup::empty(context.clone());
        let empty = MemoryGroup::empty(context);
        self.memory = empty;
        self.finished = true;
        Ok(publication)
    }
}

fn prepare_pending_host_state(
    parsed: &ParsedUi,
    context: &MemoryContext,
) -> Result<PendingUiHostState, JsError> {
    let mut scope = context.scope();
    let tool = parsed
        .tool
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let text = parsed
        .text
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let drawing_target = parsed
        .drawing_target
        .as_ref()
        .map(|value| {
            value
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())
        })
        .transpose()?;
    let symbol = parsed
        .symbol
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let bytes = js_value_heap_bytes(&tool)
        .checked_add(js_value_heap_bytes(&text))
        .and_then(|bytes| bytes.checked_add(drawing_target.as_ref().map_or(0, js_value_heap_bytes)))
        .and_then(|bytes| bytes.checked_add(js_value_heap_bytes(&symbol)))
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    let memory = scope
        .split_persistent(bytes)
        .map_err(|failure| failure.into_js_error())?;
    Ok(PendingUiHostState {
        tool,
        text,
        drawing_target,
        crosshair: parsed.crosshair,
        symbol,
        _memory: memory,
    })
}

fn validate_pending_drawing_binding(state: &JsValue, drawing: &JsValue) -> Result<(), JsError> {
    let JsValue::Object(drawing) = drawing else {
        return Err(type_error("Drawing binding object required"));
    };
    let undefined = JsValue::Undefined;
    let panel_value = drawing.get(&key("panel")).unwrap_or(&undefined);
    if !matches!(panel_value, JsValue::Undefined) {
        identifier(panel_value, "Drawing panel")?;
    }
    for (name, label) in [
        ("axisId", "Drawing axisId"),
        ("seriesId", "Drawing seriesId"),
    ] {
        let value = drawing.get(&key(name)).unwrap_or(&undefined);
        if !matches!(value, JsValue::Undefined | JsValue::Null) {
            identifier(value, label)?;
        }
    }
    let default_panel = key("price");
    let panel = match panel_value {
        JsValue::String(value) => value,
        JsValue::Undefined => &default_panel,
        _ => unreachable!("identifier rejected a defined non-string panel"),
    };
    let panels = array(
        required(state, "panels", "Async UI collections")?,
        "Async UI collections",
    )?;
    if !panels
        .iter()
        .any(|candidate| matches!(field(candidate, "id"), Some(JsValue::String(id)) if id == panel))
    {
        return Err(ordinary_error("Missing drawing panel"));
    }
    let axis = match drawing.get(&key("axisId")).unwrap_or(&undefined) {
        JsValue::String(value) => Some(value),
        JsValue::Undefined | JsValue::Null => None,
        _ => unreachable!("identifier rejected axisId"),
    };
    if let Some(axis) = axis {
        let axes = array(required(state, "axes", "Async UI axes")?, "Async UI axes")?;
        let valid = axes.iter().any(|candidate| {
            matches!(field(candidate, "id"), Some(JsValue::String(id)) if id == axis)
                && matches!((field(candidate, "panel"), panel_value), (Some(JsValue::String(axis_panel)), JsValue::String(drawing_panel)) if axis_panel == drawing_panel)
        });
        if !valid {
            return Err(ordinary_error("Missing drawing axis binding"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{direct_state_text, key};
    use barochart_js::json::{JsObject, JsValue};
    use barochart_js::num::NumberDialect;
    use barochart_js::string::JsString;

    #[test]
    fn direct_ui_accepts_exactly_eight_mib_and_rejects_the_next_unit() {
        let value = |length| {
            let mut object = JsObject::new();
            object.insert(
                key("x"),
                JsValue::String(JsString::from_str(&"x".repeat(length))),
            );
            JsValue::Object(object)
        };
        let exact = direct_state_text(&value(8_388_600), NumberDialect::Ecma).unwrap();
        assert_eq!(exact.len_utf16(), 8_388_608);
        let error = direct_state_text(&value(8_388_601), NumberDialect::Ecma).unwrap_err();
        assert_eq!(error.name, "RangeError");
        assert_eq!(error.message.to_string_lossy(), "Checkpoint text limit");
    }
}
