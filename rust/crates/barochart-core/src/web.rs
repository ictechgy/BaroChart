//! 브라우저 actor를 위한 WASM 전용 읽기 전용 표시·메타데이터 조회다.
//!
//! 열 값이나 지표 출력 배열은 노출하지 않는다. 큰 payload는 전용 typed F64/packet ABI를
//! 사용하며, 이 모듈의 모든 값은 실제 `NativeChart`에서 caller scope로 만든다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;

use crate::indicator_registry::IndicatorMetadata;
use crate::native_chart::NativeChart;

const SCHEMA: &str = "aster.web-wasm.presentation";
const VERSION: f64 = 1.0;

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn number(value: f64) -> JsValue {
    JsValue::Number(value)
}

fn boolean(value: bool) -> JsValue {
    JsValue::Bool(value)
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", key(message))
}

fn object(
    entries: impl IntoIterator<Item = (JsString, JsValue)>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(|error| error.into_js_error())
}

fn entries<const N: usize>(
    values: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    object(
        values.into_iter().map(|(name, value)| (key(name), value)),
        scope,
    )
}

fn scoped_values(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<JsValue>, JsError> {
    let bytes = capacity
        .checked_mul(std::mem::size_of::<JsValue>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

fn array(values: Vec<JsValue>) -> JsValue {
    JsValue::Array(values)
}

fn array_from_values(values: Vec<JsValue>) -> JsValue {
    array(values)
}

fn plot_offsets_value(
    offsets: &[crate::indicator_types::PlotOffset],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let bytes = offsets
        .len()
        .checked_mul(std::mem::size_of::<(JsString, JsValue)>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|error| error.into_js_error())?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(offsets.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for offset in offsets {
        let name =
            JsString::try_from_str(offset.output, scope).map_err(|error| error.into_js_error())?;
        values.push((name, number(offset.value)));
    }
    object(values, scope)
}

fn clone_value(value: &JsValue, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    value
        .try_clone_scoped(scope)
        .map_err(|error| error.into_js_error())
}

fn optional_text(value: Option<&JsString>, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    value.map_or(Ok(JsValue::Null), |value| {
        value
            .try_clone_scoped(scope)
            .map(JsValue::String)
            .map_err(|error| error.into_js_error())
    })
}

fn object_field<'a>(value: Option<&'a JsValue>, name: &str) -> Option<&'a JsValue> {
    match value {
        Some(JsValue::Object(object)) => object.get(&key(name)),
        _ => None,
    }
}

fn mark_layout_reference(
    value: Option<&JsValue>,
    panels: &[crate::model_state::Panel],
    axes: &[crate::model_state::Axis],
    panel_marks: &mut [bool],
    axis_marks: &mut [bool],
) {
    if let Some(JsValue::String(panel)) = object_field(value, "panel")
        && let Some(index) = panels.iter().position(|candidate| candidate.id == *panel)
    {
        panel_marks[index] = true;
    }
    if let Some(JsValue::String(axis)) = object_field(value, "axisId")
        && let Some(index) = axes.iter().position(|candidate| candidate.id == *axis)
    {
        axis_marks[index] = true;
    }
}

fn mark_drawing_reference(
    drawing: &crate::drawing_types::Drawing,
    panels: &[crate::model_state::Panel],
    axes: &[crate::model_state::Axis],
    panel_marks: &mut [bool],
    axis_marks: &mut [bool],
) {
    if let Some(index) = panels
        .iter()
        .position(|candidate| candidate.id == drawing.panel)
    {
        panel_marks[index] = true;
    }
    if let Some(axis) = drawing.axis_id.as_ref()
        && let Some(index) = axes.iter().position(|candidate| candidate.id == *axis)
    {
        axis_marks[index] = true;
    }
}

/// 드로잉 현재/undo/redo/transaction과 controller target이 참조하는 패널·축 ID다.
/// 큰 도형 문서나 포인트를 복사하지 않고, layout undo가 보호해야 할 리소스만 반환한다.
pub fn layout_references(
    chart: Option<&NativeChart>,
    input: Option<&crate::interaction::OwnedInteractionState>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let chart = require_chart(chart)?;
    let model = chart.model();
    let drawings = chart.drawings();
    let panels = &model.panels;
    let axes = &model.axes;
    let panel_bytes = panels.len();
    let axis_bytes = axes.len();
    scope
        .try_grow(
            panel_bytes
                .checked_add(axis_bytes)
                .ok_or_else(|| scope.allocation_failure().into_js_error())?,
        )
        .map_err(|failure| failure.into_js_error())?;
    let mut panel_marks = Vec::new();
    let mut axis_marks = Vec::new();
    panel_marks
        .try_reserve_exact(panels.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    axis_marks
        .try_reserve_exact(axes.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    panel_marks.resize(panels.len(), false);
    axis_marks.resize(axes.len(), false);

    let mut mark_frame = |frame: &[std::sync::Arc<crate::drawing_types::Drawing>]| {
        for drawing in frame {
            mark_drawing_reference(drawing, panels, axes, &mut panel_marks, &mut axis_marks);
        }
    };
    mark_frame(drawings.items());
    for frame in drawings.undo_stack() {
        mark_frame(frame);
    }
    for frame in drawings.redo_stack() {
        mark_frame(frame);
    }
    if let Some(frame) = drawings.transaction() {
        mark_frame(frame);
    }
    if let Some(input) = input {
        mark_layout_reference(
            input.drawing_target(),
            panels,
            axes,
            &mut panel_marks,
            &mut axis_marks,
        );
    }

    let mut panel_values =
        scoped_values(panel_marks.iter().filter(|marked| **marked).count(), scope)?;
    for (index, marked) in panel_marks.iter().enumerate() {
        if *marked {
            panel_values.push(JsValue::String(
                panels[index]
                    .id
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ));
        }
    }
    let mut axis_values =
        scoped_values(axis_marks.iter().filter(|marked| **marked).count(), scope)?;
    for (index, marked) in axis_marks.iter().enumerate() {
        if *marked {
            axis_values.push(JsValue::String(
                axes[index]
                    .id
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ));
        }
    }
    entries(
        [
            ("schema", text("aster.web-wasm.layout-references")),
            ("version", number(VERSION)),
            ("panels", array_from_values(panel_values)),
            ("axes", array_from_values(axis_values)),
        ],
        scope,
    )
}

fn require_chart(chart: Option<&NativeChart>) -> Result<&NativeChart, JsError> {
    chart.ok_or_else(|| ordinary_error("Native model is not initialized"))
}

/// 버전이 붙은 웹 실행 가능 조회 namespace 메타데이터다.
pub fn capabilities(scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    entries(
        [
            ("schema", text("aster.web-wasm.capabilities")),
            ("version", number(VERSION)),
            ("abiVersion", number(1.0)),
            ("transfer", text("f64-le")),
            ("packetVersion", number(1.0)),
            ("maxTransfer", number(262_144.0)),
            ("implemented", {
                let mut values = scoped_values(33, scope)?;
                values.extend([
                    text("web.presentationState"),
                    text("web.configuration"),
                    text("web.drawingsState"),
                    text("web.indicatorCatalog"),
                    text("web.capabilities"),
                    text("web.layoutCapture"),
                    text("web.applyLayoutFrame"),
                    text("web.layoutReferences"),
                    text("web.paramsSourceBegin"),
                    text("web.paramsSourceStep"),
                    text("web.paramsSourceCheck"),
                    text("web.paramsSourceReceive"),
                    text("web.paramsSourceArmWrite"),
                    text("web.paramsSourceCheckpoint"),
                    text("web.paramsSourceValidate"),
                    text("web.paramsSourcePrepare"),
                    text("web.paramsSourcePublish"),
                    text("web.paramsSourceStatus"),
                    text("web.paramsSourceAbort"),
                    text("web.migrationSourceBegin"),
                    text("web.migrationSourceStep"),
                    text("web.migrationSourceUiBegin"),
                    text("web.migrationSourceUiNext"),
                    text("web.migrationSourceCheck"),
                    text("web.migrationSourceFinish"),
                    text("web.migrationSourceAbort"),
                    text("web.migrationTargetCreate"),
                    text("web.migrationTargetStart"),
                    text("web.migrationTargetStep"),
                    text("web.migrationTargetUiBegin"),
                    text("web.migrationTargetUiChunk"),
                    text("web.migrationTargetUiFinish"),
                    text("web.migrationTargetAbort"),
                ]);
                array_from_values(values)
            }),
            ("unavailable", array_from_values(scoped_values(0, scope)?)),
            ("typedReads", {
                let mut values = scoped_values(1, scope)?;
                values.push(text("web.dataColumn"));
                array_from_values(values)
            }),
        ],
        scope,
    )
}

/// 소유 store의 한 열을 typed F64 ABI가 복사할 수 있도록 빌린다.
/// 인자는 `[field, start, count, expectedStoreVersion]`이며 열 자체는 반환하지 않는다.
pub fn data_column<'a>(chart: &'a NativeChart, args: &[JsValue]) -> Result<&'a [f64], JsError> {
    if args.len() != 4 {
        return Err(JsError::new("TypeError", key("Data column arguments")));
    }
    let field = match &args[0] {
        JsValue::String(value) => value.as_units(),
        _ => return Err(JsError::new("TypeError", key("Data column name"))),
    };
    let field_name = |expected: &str| field.iter().copied().eq(expected.encode_utf16());
    let value_number = |value: &JsValue| match value {
        JsValue::Number(value) => *value,
        _ => f64::NAN,
    };
    let start_value = value_number(&args[1]);
    let count_value = value_number(&args[2]);
    let expected_version = value_number(&args[3]);
    let valid_index = |value: f64| {
        value.is_finite()
            && value.fract() == 0.0
            && (0.0..=9_007_199_254_740_991.0).contains(&value)
    };
    if !valid_index(start_value) || !valid_index(count_value) || count_value > 262_144.0 {
        return Err(JsError::new("RangeError", key("Data column range")));
    }
    let store = chart.data().store();
    if !expected_version.is_finite() || expected_version.to_bits() != store.version().to_bits() {
        return Err(JsError::new("Error", key("Stale data version")));
    }
    let start = start_value as usize;
    let count = count_value as usize;
    let end = start
        .checked_add(count)
        .ok_or_else(|| JsError::new("RangeError", key("Data column range")))?;
    if end > store.length() {
        return Err(JsError::new("RangeError", key("Data column range")));
    }
    let columns = store.columns();
    let values = if field_name("time") {
        &columns.time
    } else if field_name("open") {
        &columns.open
    } else if field_name("high") {
        &columns.high
    } else if field_name("low") {
        &columns.low
    } else if field_name("close") {
        &columns.close
    } else if field_name("volume") {
        &columns.volume
    } else {
        return Err(JsError::new("TypeError", key("Unknown data column")));
    };
    Ok(&values[start..end])
}

/// 열·지표 배열 없이 반환하는 제한된 hot-path 상태다.
pub fn presentation_state(
    chart: Option<&NativeChart>,
    input: Option<&crate::interaction::OwnedInteractionState>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let chart = require_chart(chart)?;
    let store = chart.data().store();
    let model = chart.model();
    let drawings = chart.drawings();
    entries(
        [
            ("schema", text(SCHEMA)),
            ("version", number(VERSION)),
            (
                "data",
                entries(
                    [
                        ("length", number(store.length() as f64)),
                        ("capacity", number(store.capacity() as f64)),
                        ("version", number(store.version())),
                        ("timeVersion", number(store.time_version())),
                    ],
                    scope,
                )?,
            ),
            (
                "view",
                entries(
                    [
                        ("from", number(model.view.from)),
                        ("to", number(model.view.to)),
                        ("follow", boolean(model.follow)),
                    ],
                    scope,
                )?,
            ),
            (
                "configuration",
                entries(
                    [
                        ("panels", number(model.panels.len() as f64)),
                        ("axes", number(model.axes.len() as f64)),
                        ("series", number(model.series.len() as f64)),
                        ("indicators", number(chart.indicators().len() as f64)),
                    ],
                    scope,
                )?,
            ),
            (
                "drawings",
                entries(
                    [
                        ("count", number(drawings.items().len() as f64)),
                        ("selected", optional_text(drawings.selected(), scope)?),
                        ("canUndo", boolean(!drawings.undo_stack().is_empty())),
                        ("canRedo", boolean(!drawings.redo_stack().is_empty())),
                        ("transaction", boolean(drawings.transaction().is_some())),
                        ("serial", number(drawings.serial() as f64)),
                    ],
                    scope,
                )?,
            ),
            ("interaction", interaction_state(input, scope)?),
        ],
        scope,
    )
}

/// 외부 값을 제외한 cold 모델 메타데이터다.
pub fn configuration(
    chart: Option<&NativeChart>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let chart = require_chart(chart)?;
    let model = chart.model();
    let panels = {
        let mut values = scoped_values(model.panels.len(), scope)?;
        for panel in &model.panels {
            values.push(
                panel
                    .to_js_value_scoped(scope)
                    .map_err(|error| error.into_js_error())?,
            );
        }
        array_from_values(values)
    };
    let axes = {
        let mut values = scoped_values(model.axes.len(), scope)?;
        for axis in &model.axes {
            values.push(
                axis.to_js_value_scoped(scope)
                    .map_err(|error| error.into_js_error())?,
            );
        }
        array_from_values(values)
    };
    let series = {
        let mut values = scoped_values(model.series.len(), scope)?;
        for series in &model.series {
            values.push(
                series
                    .to_js_value_scoped(scope)
                    .map_err(|error| error.into_js_error())?,
            );
        }
        array_from_values(values)
    };
    let symbol = chart
        .symbol_record()
        .map_or(Ok(JsValue::Null), |value| clone_value(value, scope))?;
    let theme = clone_value(model.theme(), scope)?;
    let indicators = {
        let engine = chart.indicators();
        let mut rows = scoped_values(engine.len(), scope)?;
        for id in engine.entry_ids_iter() {
            let entry = engine.entry_by_id(id).expect("live indicator entry");
            let definition = entry.definition();
            let mut outputs = scoped_values(definition.outputs.len(), scope)?;
            for output in definition.outputs {
                outputs.push(JsValue::String(
                    JsString::try_from_str(output, scope).map_err(|error| error.into_js_error())?,
                ));
            }
            let offsets = plot_offsets_value(&definition.plot_offsets, scope)?;
            rows.push(entries(
                [
                    ("id", optional_text(Some(entry.id()), scope)?),
                    ("name", optional_text(Some(entry.name()), scope)?),
                    ("params", clone_value(entry.params(), scope)?),
                    ("outputs", array_from_values(outputs)),
                    ("plotOffsets", offsets),
                ],
                scope,
            )?);
        }
        array_from_values(rows)
    };
    entries(
        [
            ("schema", text("aster.web-wasm.configuration")),
            ("version", number(VERSION)),
            ("panels", panels),
            ("axes", axes),
            ("series", series),
            ("indicators", indicators),
            ("symbol", symbol),
            ("theme", theme),
            ("axisWidth", number(model.axis_width)),
            ("precision", number(model.precision as f64)),
        ],
        scope,
    )
}

/// 전체 undo/redo frame 없이 현재 도형과 제한된 이력 메타데이터를 반환한다.
pub fn drawings_state(
    chart: Option<&NativeChart>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let chart = require_chart(chart)?;
    let drawings = chart.drawings();
    let items = {
        let mut values = scoped_values(drawings.items().len(), scope)?;
        for drawing in drawings.items() {
            values.push(drawing.to_value_scoped(scope)?);
        }
        array_from_values(values)
    };
    entries(
        [
            ("schema", text("aster.web-wasm.drawings")),
            ("version", number(VERSION)),
            ("items", items),
            ("selected", optional_text(drawings.selected(), scope)?),
            ("canUndo", boolean(!drawings.undo_stack().is_empty())),
            ("canRedo", boolean(!drawings.redo_stack().is_empty())),
            ("undoCount", number(drawings.undo_stack().len() as f64)),
            ("redoCount", number(drawings.redo_stack().len() as f64)),
            ("serial", number(drawings.serial() as f64)),
            ("transaction", boolean(drawings.transaction().is_some())),
        ],
        scope,
    )
}

fn metadata_value(
    metadata: &IndicatorMetadata,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut params = scoped_values(metadata.parameter_order.len(), scope)?;
    params.extend(metadata.parameter_order.iter().map(|value| text(value)));
    let params = array_from_values(params);
    let mut outputs = scoped_values(metadata.outputs.len(), scope)?;
    outputs.extend(metadata.outputs.iter().map(|value| text(value)));
    let outputs = array_from_values(outputs);
    entries(
        [
            ("name", text(metadata.name)),
            ("params", params),
            ("outputs", outputs),
            (
                "provenance",
                text(match metadata.provenance {
                    crate::indicator_types::IndicatorProvenance::Builtin => "builtin",
                    crate::indicator_types::IndicatorProvenance::Linked(_) => "linked",
                }),
            ),
        ],
        scope,
    )
}

/// registry에 기반한 cold catalog다. 정적 선언만 반환한다.
pub fn indicator_catalog(
    chart: Option<&NativeChart>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let chart = require_chart(chart)?;
    let entries = {
        let mut values = scoped_values(chart.indicators().registry_len(), scope)?;
        for metadata in chart.indicators().registry().entries() {
            values.push(metadata_value(metadata, scope)?);
        }
        array_from_values(values)
    };
    object(
        [
            (key("schema"), text("aster.web-wasm.indicator-catalog")),
            (key("version"), number(VERSION)),
            (
                key("count"),
                number(chart.indicators().registry_len() as f64),
            ),
            (key("entries"), entries),
        ],
        scope,
    )
}

fn interaction_state(
    input: Option<&crate::interaction::OwnedInteractionState>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let Some(input) = input else {
        return entries([("available", boolean(false))], scope);
    };
    let tool = input
        .tool()
        .try_clone_scoped(scope)
        .map_err(|error| error.into_js_error())?;
    let text_value = input
        .text()
        .try_clone_scoped(scope)
        .map_err(|error| error.into_js_error())?;
    let target = input.drawing_target().map_or(Ok(JsValue::Null), |value| {
        value
            .try_clone_scoped(scope)
            .map_err(|error| error.into_js_error())
    })?;
    let crosshair = match input.crosshair_value() {
        Some((x, y)) => entries([("x", number(x)), ("y", number(y))], scope)?,
        None => JsValue::Null,
    };
    let gesture_kind = match input.gesture_kind() {
        Some(value) => text(value),
        None => JsValue::Null,
    };
    let drawing_magnet = input.drawing_magnet();
    entries(
        [
            ("available", boolean(true)),
            ("tool", JsValue::String(tool)),
            ("text", text_value),
            ("gestureKind", gesture_kind),
            ("pointerCount", number(input.pointer_count() as f64)),
            ("crosshair", crosshair),
            ("drawingMagnet", drawing_magnet),
            ("crosshairSnap", input.crosshair_snap_scoped(scope)?),
            ("drawingTarget", target),
        ],
        scope,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle, oom_style_from_error};

    #[test]
    fn plot_offset_keys_are_admitted_by_the_caller_scope_before_allocation() {
        let offsets = [crate::indicator_types::PlotOffset {
            output: "senkouA",
            value: 26.0,
        }];
        let bytes = std::mem::size_of::<(JsString, JsValue)>() as u64;
        let account = MemoryAccount::new(bytes, OomStyle::InternalErrorLowercase);
        {
            let mut scope = MemoryContext::accounted(&account).scope();
            let error = plot_offsets_value(&offsets, &mut scope).unwrap_err();
            assert!(oom_style_from_error(&error).is_some());
            assert!(account.snapshot().requested_peak_bytes <= bytes);
        }
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        let mut scope = MemoryScope::unaccounted(OomStyle::InternalErrorLowercase);
        let value = plot_offsets_value(&offsets, &mut scope).unwrap();
        let JsValue::Object(ref value) = value else {
            panic!("plot offset object");
        };
        assert!(
            matches!(value.get(&key("senkouA")), Some(JsValue::Number(value)) if *value == 26.0)
        );
    }
}
