//! 브라우저 actor가 쓰는 복합 layout frame의 capture와 원자 게시다.
//!
//! Frame은 capture 당시 `source`와 사용자가 편집할 `target`을 함께 가진다. 적용할 때 live
//! metadata를 다시 capture해 `source`와 exact 비교하므로 host가 오래된 frame을 게시할 수 없다.
//! 외부 values와 indicator output은 frame에 넣지 않는다.

#![forbid(unsafe_code)]

use std::mem::size_of;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryFailure, MemoryScope};
use barochart_js::string::JsString;

use crate::contracts::{RESOURCE_LIMITS, identifier, option_record};
use crate::indicator_helpers::exact_state_equal;
use crate::model_state::{ModelContext, ModelState};

/// 웹 layout frame schema다.
pub const WEB_LAYOUT_SCHEMA: &str = "aster.web-wasm.layout-frame";
/// 웹 layout frame schema version이다.
pub const WEB_LAYOUT_VERSION: u32 = 1;

const FRAME_KEYS: &[&str] = &["schema", "version", "source", "target"];
const STATE_KEYS: &[&str] = &[
    "panelOrder",
    "panels",
    "axes",
    "placements",
    "generatedPanels",
    "generatedAxes",
    "series",
];
const PLACEMENT_KEYS: &[&str] = &["seriesId", "indicatorId", "panelId", "axisId"];
const GENERATED_PANEL_KEYS: &[&str] = &["id", "options"];
const GENERATED_AXIS_KEYS: &[&str] = &["id", "panel", "options"];
const PANEL_PORTABLE_KEYS: &[&str] = &[
    "id",
    "weight",
    "label",
    "scale",
    "inverted",
    "padding",
    "range",
    "base",
    "precision",
    "axisVisible",
    "axisSide",
];
const PANEL_OPTION_KEYS: &[&str] = &[
    "weight",
    "label",
    "scale",
    "inverted",
    "padding",
    "range",
    "base",
    "precision",
    "axisVisible",
    "axisSide",
];
const AXIS_PORTABLE_KEYS: &[&str] = &[
    "id",
    "panel",
    "side",
    "scale",
    "inverted",
    "padding",
    "range",
    "base",
    "precision",
    "tickFormat",
    "prefix",
    "suffix",
    "label",
    "visible",
    "width",
];
const AXIS_OPTION_KEYS: &[&str] = &[
    "side",
    "scale",
    "inverted",
    "padding",
    "range",
    "base",
    "precision",
    "tickFormat",
    "prefix",
    "suffix",
    "label",
    "visible",
    "width",
];

/// 한 번에 게시한 layout 변경 요약이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayoutApplyReceipt {
    /// 추가·교체·제거한 panel 수다.
    pub panels_changed: usize,
    /// 추가·교체·제거한 axis 수다.
    pub axes_changed: usize,
    /// metadata가 달라진 series 수다.
    pub placements_changed: usize,
    /// panel painter 순서가 달라졌는지 여부다.
    pub order_changed: bool,
}

trait ScopedVec {
    fn scoped_vec<T>(&mut self, capacity: usize) -> Result<Vec<T>, MemoryFailure>;
}

impl ScopedVec for MemoryScope {
    fn scoped_vec<T>(&mut self, capacity: usize) -> Result<Vec<T>, MemoryFailure> {
        self.try_grow(
            capacity
                .checked_mul(size_of::<T>())
                .ok_or_else(|| self.allocation_failure())?,
        )?;
        let mut values = Vec::new();
        values
            .try_reserve_exact(capacity)
            .map_err(|_| self.allocation_failure())?;
        Ok(values)
    }
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}
fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}
fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}
fn stale_error(message: &str) -> JsError {
    JsError::new("StaleSourceError", key(message))
}
fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", key(message))
}

fn object<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

fn field<'a>(value: &'a JsObject, name: &str) -> Result<&'a JsValue, JsError> {
    value
        .get(&key(name))
        .ok_or_else(|| type_error("Layout frame field"))
}

fn exact_keys(value: &JsObject, allowed: &[&str]) -> Result<(), JsError> {
    if value.len() != allowed.len()
        || allowed.iter().any(|name| value.get(&key(name)).is_none())
        || value.iter().any(|(name, _)| {
            !allowed
                .iter()
                .any(|allowed| name.as_units().iter().copied().eq(allowed.encode_utf16()))
        })
    {
        return Err(type_error("Layout frame fields"));
    }
    Ok(())
}

fn dense_array<'a>(
    value: &'a JsValue,
    limit: usize,
    message: &str,
) -> Result<&'a [JsValue], JsError> {
    let JsValue::Array(values) = value else {
        return Err(type_error(message));
    };
    if values.len() > limit {
        return Err(range_error("Layout frame limit"));
    }
    Ok(values)
}

fn clone_id(value: &JsValue, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    identifier(value, "Layout id")?
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())
}

fn scoped_object(
    entries: Vec<(JsString, JsValue)>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(|failure| failure.into_js_error())
}

fn clone_options(
    value: &JsValue,
    allowed: &[&str],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let record = object(value, "Layout options object required")?;
    option_record(value, allowed, "Layout options")?;
    let mut entries = scope
        .scoped_vec(record.len())
        .map_err(|failure| failure.into_js_error())?;
    for (name, value) in record.iter() {
        entries.push((
            name.try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ));
    }
    scoped_object(entries, scope)
}

fn clone_ids(
    value: &JsValue,
    limit: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<JsString>, JsError> {
    let input = dense_array(value, limit, "Layout id dense array required")?;
    let mut output = scope
        .scoped_vec(input.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in input {
        let id = clone_id(value, scope)?;
        if output.iter().any(|candidate| candidate == &id) {
            return Err(type_error("Layout duplicate id"));
        }
        output.push(id);
    }
    Ok(output)
}

fn id_in(values: &[JsString], id: &JsString) -> bool {
    values.iter().any(|candidate| candidate == id)
}

fn clone_record_without(
    value: &JsValue,
    removed: &[&str],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let record = object(value, "Layout metadata object required")?;
    let mut entries = scope
        .scoped_vec(record.len())
        .map_err(|failure| failure.into_js_error())?;
    for (name, value) in record.iter() {
        if removed
            .iter()
            .any(|removed| name.as_units().iter().copied().eq(removed.encode_utf16()))
        {
            continue;
        }
        entries.push((
            name.try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ));
    }
    scoped_object(entries, scope)
}

fn generated_ids(
    value: &JsValue,
    limit: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<JsString>, JsError> {
    let values = dense_array(value, limit, "Generated resources")?;
    let mut ids = scope
        .scoped_vec(values.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in values {
        let id = clone_id(
            field(object(value, "Generated resource object required")?, "id")?,
            scope,
        )?;
        if ids.iter().any(|candidate| candidate == &id) {
            return Err(type_error("Duplicate generated resource"));
        }
        ids.push(id);
    }
    Ok(ids)
}

fn capture_state(
    model: &ModelState,
    generated_panels: &[JsString],
    generated_axes: &[JsString],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    for id in generated_panels {
        if !model.panels.iter().any(|panel| &panel.id == id) {
            return Err(stale_error("Generated panel is missing"));
        }
    }
    for id in generated_axes {
        if !model.axes.iter().any(|axis| &axis.id == id) {
            return Err(stale_error("Generated axis is missing"));
        }
    }
    let panel_order = {
        let mut values = scope
            .scoped_vec(model.panels.len())
            .map_err(|failure| failure.into_js_error())?;
        for panel in &model.panels {
            values.push(JsValue::String(
                panel
                    .id
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ));
        }
        JsValue::Array(values)
    };
    let panels = {
        let mut values = scope
            .scoped_vec(model.panels.len())
            .map_err(|failure| failure.into_js_error())?;
        for panel in &model.panels {
            values.push(clone_record_without(
                panel.raw_record(),
                &["formatter"],
                scope,
            )?);
        }
        JsValue::Array(values)
    };
    let axes = {
        let mut values = scope
            .scoped_vec(model.axes.len())
            .map_err(|failure| failure.into_js_error())?;
        for axis in &model.axes {
            values.push(clone_record_without(
                axis.raw_record(),
                &["formatter"],
                scope,
            )?);
        }
        JsValue::Array(values)
    };
    let placements = {
        let mut values = scope
            .scoped_vec(model.series.len())
            .map_err(|failure| failure.into_js_error())?;
        for series in &model.series {
            let Some(indicator) = &series.indicator else {
                continue;
            };
            let mut entries = scope
                .scoped_vec(4)
                .map_err(|failure| failure.into_js_error())?;
            entries.push((
                key("seriesId"),
                JsValue::String(
                    series
                        .id
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ));
            entries.push((
                key("indicatorId"),
                JsValue::String(
                    indicator
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ));
            entries.push((
                key("panelId"),
                JsValue::String(
                    series
                        .panel
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ));
            entries.push((
                key("axisId"),
                match &series.axis_id {
                    Some(axis) => JsValue::String(
                        axis.try_clone_scoped(scope)
                            .map_err(|failure| failure.into_js_error())?,
                    ),
                    None => JsValue::Null,
                },
            ));
            values.push(scoped_object(entries, scope)?);
        }
        JsValue::Array(values)
    };
    let generated_panel_values = {
        let mut values = scope
            .scoped_vec(generated_panels.len())
            .map_err(|failure| failure.into_js_error())?;
        for id in generated_panels {
            let panel = model
                .panels
                .iter()
                .find(|panel| &panel.id == id)
                .expect("generated panel checked");
            let mut entries = scope
                .scoped_vec(2)
                .map_err(|failure| failure.into_js_error())?;
            entries.push((
                key("id"),
                JsValue::String(
                    id.try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ));
            entries.push((
                key("options"),
                clone_record_without(panel.raw_record(), &["id", "formatter"], scope)?,
            ));
            values.push(scoped_object(entries, scope)?);
        }
        JsValue::Array(values)
    };
    let generated_axis_values = {
        let mut values = scope
            .scoped_vec(generated_axes.len())
            .map_err(|failure| failure.into_js_error())?;
        for id in generated_axes {
            let axis = model
                .axes
                .iter()
                .find(|axis| &axis.id == id)
                .expect("generated axis checked");
            let mut entries = scope
                .scoped_vec(3)
                .map_err(|failure| failure.into_js_error())?;
            entries.push((
                key("id"),
                JsValue::String(
                    id.try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ));
            entries.push((
                key("panel"),
                JsValue::String(
                    axis.panel
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
            ));
            entries.push((
                key("options"),
                clone_record_without(axis.raw_record(), &["id", "panel", "formatter"], scope)?,
            ));
            values.push(scoped_object(entries, scope)?);
        }
        JsValue::Array(values)
    };
    let series = {
        let mut values = scope
            .scoped_vec(model.series.len())
            .map_err(|failure| failure.into_js_error())?;
        for series in &model.series {
            values.push(
                series
                    .to_js_value_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            );
        }
        JsValue::Array(values)
    };
    let mut entries = scope
        .scoped_vec(STATE_KEYS.len())
        .map_err(|failure| failure.into_js_error())?;
    entries.push((key("panelOrder"), panel_order));
    entries.push((key("panels"), panels));
    entries.push((key("axes"), axes));
    entries.push((key("placements"), placements));
    entries.push((key("generatedPanels"), generated_panel_values));
    entries.push((key("generatedAxes"), generated_axis_values));
    entries.push((key("series"), series));
    scoped_object(entries, scope)
}

/// 현재 layout과 generated resource policy를 source/target frame으로 capture한다.
pub fn capture_layout_frame(
    model: &ModelState,
    generated_panel_ids: &JsValue,
    generated_axis_ids: &JsValue,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let panels = clone_ids(
        generated_panel_ids,
        RESOURCE_LIMITS.max_panels as usize,
        scope,
    )?;
    let axes = clone_ids(generated_axis_ids, RESOURCE_LIMITS.max_axes as usize, scope)?;
    let source = capture_state(model, &panels, &axes, scope)?;
    let target = source
        .try_clone_scoped(scope)
        .map_err(|failure| failure.into_js_error())?;
    let mut entries = scope
        .scoped_vec(FRAME_KEYS.len())
        .map_err(|failure| failure.into_js_error())?;
    entries.push((key("schema"), text(WEB_LAYOUT_SCHEMA)));
    entries.push((
        key("version"),
        JsValue::Number(f64::from(WEB_LAYOUT_VERSION)),
    ));
    entries.push((key("source"), source));
    entries.push((key("target"), target));
    scoped_object(entries, scope)
}

fn validated_frame(frame: &JsValue) -> Result<(&JsValue, &JsObject), JsError> {
    let frame = object(frame, "Layout frame object required")?;
    exact_keys(frame, FRAME_KEYS)?;
    if !matches!(field(frame, "schema")?, JsValue::String(value) if value.as_units().iter().copied().eq(WEB_LAYOUT_SCHEMA.encode_utf16()))
    {
        return Err(type_error("Layout frame schema"));
    }
    if !matches!(field(frame, "version")?, JsValue::Number(value) if *value == f64::from(WEB_LAYOUT_VERSION))
    {
        return Err(type_error("Layout frame version"));
    }
    let source_value = field(frame, "source")?;
    let source = object(source_value, "Layout source object required")?;
    let target = object(field(frame, "target")?, "Layout target object required")?;
    exact_keys(source, STATE_KEYS)?;
    exact_keys(target, STATE_KEYS)?;
    Ok((source_value, target))
}

fn target_resource<'a>(
    values: &'a [JsValue],
    id: &JsString,
) -> Result<Option<&'a JsObject>, JsError> {
    let mut result = None;
    for value in values {
        let record = object(value, "Generated resource object required")?;
        if identifier(field(record, "id")?, "Generated resource id")? == id {
            if result.is_some() {
                return Err(type_error("Duplicate generated resource"));
            }
            result = Some(record);
        }
    }
    Ok(result)
}

fn record_id(value: &JsValue) -> Option<&JsString> {
    let JsValue::Object(record) = value else {
        return None;
    };
    match record.get(&key("id")) {
        Some(JsValue::String(id)) => Some(id),
        _ => None,
    }
}

fn records_changed(source: &[JsValue], target: &[JsValue]) -> usize {
    let removed_or_changed = source
        .iter()
        .filter(|before| {
            let Some(id) = record_id(before) else {
                return true;
            };
            target
                .iter()
                .find(|after| record_id(after) == Some(id))
                .is_none_or(|after| !exact_state_equal(before, after))
        })
        .count();
    removed_or_changed
        + target
            .iter()
            .filter(|after| {
                record_id(after)
                    .is_none_or(|id| !source.iter().any(|before| record_id(before) == Some(id)))
            })
            .count()
}

/// 모든 후보를 검증·할당한 뒤 ModelState metadata를 한 번에 게시한다.
pub fn apply_layout_frame(
    model: &mut ModelState,
    frame: &JsValue,
    context: &ModelContext<'_>,
    drawing_series: &[(JsString, JsString, Option<JsString>)],
    scope: &mut MemoryScope,
    before_publish: &mut dyn FnMut(LayoutApplyReceipt) -> Result<(), JsError>,
) -> Result<LayoutApplyReceipt, JsError> {
    if context.interaction.gesture_active
        || context.interaction.pointer_count != 0
        || context.drawings.transaction_active
    {
        return Err(stale_error("Layout frame during active interaction"));
    }
    let (source, target) = validated_frame(frame)?;
    let source_record = object(source, "Layout source object required")?;
    let source_generated_panels = generated_ids(
        field(source_record, "generatedPanels")?,
        RESOURCE_LIMITS.max_panels as usize,
        scope,
    )?;
    let source_generated_axes = generated_ids(
        field(source_record, "generatedAxes")?,
        RESOURCE_LIMITS.max_axes as usize,
        scope,
    )?;
    let current = capture_state(
        model,
        &source_generated_panels,
        &source_generated_axes,
        scope,
    )?;
    if !exact_state_equal(&current, source) {
        return Err(stale_error("Layout frame source changed"));
    }

    let panel_order = clone_ids(
        field(target, "panelOrder")?,
        RESOURCE_LIMITS.max_panels as usize,
        scope,
    )?;
    if panel_order.is_empty() {
        return Err(type_error("Layout frame needs a panel"));
    }
    let target_panel_records = dense_array(
        field(target, "panels")?,
        RESOURCE_LIMITS.max_panels as usize,
        "Layout panels",
    )?;
    let target_axis_records = dense_array(
        field(target, "axes")?,
        RESOURCE_LIMITS.max_axes as usize,
        "Layout axes",
    )?;
    let target_panel_templates = dense_array(
        field(target, "generatedPanels")?,
        RESOURCE_LIMITS.max_panels as usize,
        "Generated panels",
    )?;
    let target_axis_templates = dense_array(
        field(target, "generatedAxes")?,
        RESOURCE_LIMITS.max_axes as usize,
        "Generated axes",
    )?;
    let target_series = dense_array(
        field(target, "series")?,
        RESOURCE_LIMITS.max_series as usize,
        "Layout series",
    )?;
    let placements = dense_array(
        field(target, "placements")?,
        RESOURCE_LIMITS.max_series as usize,
        "Layout placements",
    )?;
    if target_series.len() != model.series.len() {
        return Err(stale_error("Layout series changed"));
    }
    let target_generated_panels = generated_ids(
        field(target, "generatedPanels")?,
        RESOURCE_LIMITS.max_panels as usize,
        scope,
    )?;
    let target_generated_axes = generated_ids(
        field(target, "generatedAxes")?,
        RESOURCE_LIMITS.max_axes as usize,
        scope,
    )?;
    for id in &target_generated_panels {
        if model.panels.iter().any(|panel| &panel.id == id) && !id_in(&source_generated_panels, id)
        {
            return Err(stale_error("Layout generated panel policy changed"));
        }
    }
    for id in &target_generated_axes {
        if model.axes.iter().any(|axis| &axis.id == id) && !id_in(&source_generated_axes, id) {
            return Err(stale_error("Layout generated axis policy changed"));
        }
    }

    let mut target_panel_ids = scope
        .scoped_vec(target_panel_records.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in target_panel_records {
        option_record(value, PANEL_PORTABLE_KEYS, "Layout panel")?;
        let id = clone_id(
            field(object(value, "Layout panel object required")?, "id")?,
            scope,
        )?;
        if id_in(&target_panel_ids, &id) {
            return Err(type_error("Duplicate layout panel"));
        }
        target_panel_ids.push(id);
    }
    if panel_order.len() != target_panel_ids.len()
        || panel_order.iter().any(|id| !id_in(&target_panel_ids, id))
    {
        return Err(type_error("Panel order must contain every target panel"));
    }
    for id in &target_generated_panels {
        if !id_in(&target_panel_ids, id) {
            return Err(stale_error("Generated panel is not a target panel"));
        }
        let template = target_resource(target_panel_templates, id)?
            .ok_or_else(|| stale_error("Generated panel template is missing"))?;
        exact_keys(template, GENERATED_PANEL_KEYS)?;
        let options = clone_options(field(template, "options")?, PANEL_OPTION_KEYS, scope)?;
        let target = target_panel_records.iter().find(|value| matches!(value, JsValue::Object(record) if matches!(record.get(&key("id")), Some(JsValue::String(value)) if value == id))).expect("target panel id checked");
        let expected = clone_record_without(target, &["id", "formatter"], scope)?;
        if !exact_state_equal(&options, &expected) {
            return Err(stale_error("Generated panel template changed"));
        }
    }
    for id in &target_panel_ids {
        if !model.panels.iter().any(|panel| &panel.id == id) && !id_in(&target_generated_panels, id)
        {
            return Err(stale_error("Layout panel is missing"));
        }
    }
    let mut panels = scope
        .scoped_vec(panel_order.len())
        .map_err(|failure| failure.into_js_error())?;
    for id in &panel_order {
        let value = target_panel_records.iter().find(|value| matches!(value, JsValue::Object(record) if matches!(record.get(&key("id")), Some(JsValue::String(value)) if value == id))).expect("panel order checked");
        panels.push(
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
    }
    for panel in &model.panels {
        if !id_in(&panel_order, &panel.id) && !id_in(&source_generated_panels, &panel.id) {
            return Err(stale_error("Layout omits a retained panel"));
        }
    }

    let mut target_axis_ids = scope
        .scoped_vec(target_axis_records.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in target_axis_records {
        option_record(value, AXIS_PORTABLE_KEYS, "Layout axis")?;
        let id = clone_id(
            field(object(value, "Layout axis object required")?, "id")?,
            scope,
        )?;
        if id_in(&target_axis_ids, &id) {
            return Err(type_error("Duplicate layout axis"));
        }
        target_axis_ids.push(id);
    }
    for id in &target_generated_axes {
        if !id_in(&target_axis_ids, id) {
            return Err(stale_error("Generated axis is not a target axis"));
        }
        let template = target_resource(target_axis_templates, id)?
            .ok_or_else(|| stale_error("Generated axis template is missing"))?;
        exact_keys(template, GENERATED_AXIS_KEYS)?;
        let target = target_axis_records.iter().find(|value| matches!(value, JsValue::Object(record) if matches!(record.get(&key("id")), Some(JsValue::String(value)) if value == id))).expect("target axis id checked");
        let target_record = object(target, "Layout axis object required")?;
        if !exact_state_equal(field(template, "panel")?, field(target_record, "panel")?) {
            return Err(stale_error("Generated axis parent changed"));
        }
        let options = clone_options(field(template, "options")?, AXIS_OPTION_KEYS, scope)?;
        let expected = clone_record_without(target, &["id", "panel", "formatter"], scope)?;
        if !exact_state_equal(&options, &expected) {
            return Err(stale_error("Generated axis template changed"));
        }
    }
    for id in &target_axis_ids {
        if !model.axes.iter().any(|axis| &axis.id == id) && !id_in(&target_generated_axes, id) {
            return Err(stale_error("Layout axis is missing"));
        }
    }
    for axis in &model.axes {
        if !id_in(&target_axis_ids, &axis.id) && !id_in(&source_generated_axes, &axis.id) {
            return Err(stale_error("Layout omits a retained axis"));
        }
    }
    let mut axes = scope
        .scoped_vec(target_axis_records.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in target_axis_records {
        axes.push(
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
    }

    let mut series_records = scope
        .scoped_vec(target_series.len())
        .map_err(|failure| failure.into_js_error())?;
    let mut series_ids = scope
        .scoped_vec(target_series.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in target_series {
        let record = object(value, "Layout series object required")?;
        if record.get(&key("values")).is_some() {
            return Err(type_error("Layout series values are not portable"));
        }
        let id = clone_id(field(record, "id")?, scope)?;
        if id_in(&series_ids, &id) {
            return Err(type_error("Duplicate layout series"));
        }
        series_ids.push(id);
        series_records.push(
            value
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        );
    }
    for current in &model.series {
        if !id_in(&series_ids, &current.id) {
            return Err(stale_error("Layout omits a series"));
        }
    }
    let mut placed = scope
        .scoped_vec(placements.len())
        .map_err(|failure| failure.into_js_error())?;
    for value in placements {
        let record = object(value, "Layout placement object required")?;
        exact_keys(record, PLACEMENT_KEYS)?;
        let series_id = clone_id(field(record, "seriesId")?, scope)?;
        if id_in(&placed, &series_id) {
            return Err(type_error("Duplicate layout placement"));
        }
        placed.push(series_id.clone());
        let indicator = clone_id(field(record, "indicatorId")?, scope)?;
        let panel = clone_id(field(record, "panelId")?, scope)?;
        let axis = match field(record, "axisId")? {
            JsValue::Null => None,
            value => Some(clone_id(value, scope)?),
        };
        let series = series_records
            .iter()
            .find_map(|value| {
                let JsValue::Object(record) = value else {
                    return None;
                };
                matches!(record.get(&key("id")), Some(JsValue::String(id)) if id == &series_id)
                    .then_some(record)
            })
            .ok_or_else(|| stale_error("Layout placement series is missing"))?;
        let axis_mismatch = match (series.get(&key("axisId")), axis.as_ref()) {
            (None, None) | (Some(JsValue::Null), None) => false,
            (Some(JsValue::String(left)), Some(right)) if left == right => false,
            _ => true,
        };
        if !matches!(series.get(&key("indicator")), Some(JsValue::String(id)) if id == &indicator)
            || !matches!(series.get(&key("panel")), Some(JsValue::String(id)) if id == &panel)
            || axis_mismatch
        {
            return Err(stale_error("Layout placement binding changed"));
        }
    }
    for series in &model.series {
        if series.indicator.is_some() != id_in(&placed, &series.id) {
            return Err(stale_error("Layout indicator placement changed"));
        }
    }

    let panels_value = JsValue::Array(panels);
    let axes_value = JsValue::Array(axes);
    let stage = model.stage_web_layout(
        context.store,
        &panels_value,
        &axes_value,
        &series_records,
        drawing_series,
        context,
    )?;
    let order_changed = model
        .panels
        .iter()
        .map(|panel| &panel.id)
        .ne(panel_order.iter());
    let source_panel_records = dense_array(
        field(source_record, "panels")?,
        RESOURCE_LIMITS.max_panels as usize,
        "Layout panels",
    )?;
    let source_axis_records = dense_array(
        field(source_record, "axes")?,
        RESOURCE_LIMITS.max_axes as usize,
        "Layout axes",
    )?;
    let panels_changed = records_changed(source_panel_records, target_panel_records);
    let axes_changed = records_changed(source_axis_records, target_axis_records);
    let placements_changed = model
        .series
        .iter()
        .zip(&series_records)
        .filter(|(current, next)| !exact_state_equal(&current.to_js_value(), next))
        .count();
    let receipt = LayoutApplyReceipt {
        panels_changed,
        axes_changed,
        placements_changed,
        order_changed,
    };
    before_publish(receipt)?;
    model.publish_web_layout(stage);
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::{apply_layout_frame, capture_layout_frame};
    use crate::data::{ModelDataState, StoreOptions};
    use crate::model_state::{ModelContext, ModelState};
    use barochart_js::error::JsError;
    use barochart_js::json::{JsValue, JsonMode, stringify_json};
    use barochart_js::memory::{MemoryAccount, MemoryContext, MemoryScope, OomStyle};
    use barochart_js::string::JsString;

    fn model(account: &std::sync::Arc<MemoryAccount>) -> (ModelDataState, ModelState) {
        let data = ModelDataState::new_with_memory(
            StoreOptions::default(),
            Vec::new(),
            MemoryContext::accounted(account),
        )
        .unwrap();
        let model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
        (data, model)
    }

    #[test]
    fn allocation_denial_precedes_publication_and_keeps_source_usable() {
        let probe = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
        let (probe_data, probe_model) = model(&probe);
        let required = probe.snapshot().requested_peak_bytes;
        drop(probe_model);
        drop(probe_data);

        let limited = MemoryAccount::new(required, OomStyle::InternalErrorLowercase);
        let (data, mut model) = model(&limited);
        let before = stringify_json(&model.snapshot(), JsonMode::Standard);
        let mut frame_scope = MemoryScope::unaccounted(OomStyle::InternalErrorLowercase);
        let frame = capture_layout_frame(
            &model,
            &JsValue::Array(Vec::new()),
            &JsValue::Array(Vec::new()),
            &mut frame_scope,
        )
        .unwrap();
        let context = ModelContext::plain(data.store());
        let mut apply_scope = MemoryScope::unaccounted(OomStyle::InternalErrorLowercase);
        let mut admitted = false;
        let error = apply_layout_frame(
            &mut model,
            &frame,
            &context,
            &[],
            &mut apply_scope,
            &mut |_| {
                admitted = true;
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "InternalError");
        assert!(!admitted);
        assert_eq!(
            stringify_json(&model.snapshot(), JsonMode::Standard),
            before
        );
        assert!(model.validate_workspace_state(&model.capture_workspace_state()));
    }

    #[test]
    fn reply_admission_failure_precedes_layout_publication() {
        let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
        let (data, mut model) = model(&account);
        let before = stringify_json(&model.snapshot(), JsonMode::Standard);
        let mut frame_scope = MemoryScope::unaccounted(OomStyle::InternalErrorLowercase);
        let frame = capture_layout_frame(
            &model,
            &JsValue::Array(Vec::new()),
            &JsValue::Array(Vec::new()),
            &mut frame_scope,
        )
        .unwrap();
        let context = ModelContext::plain(data.store());
        let mut apply_scope = MemoryScope::unaccounted(OomStyle::InternalErrorLowercase);
        let error = apply_layout_frame(
            &mut model,
            &frame,
            &context,
            &[],
            &mut apply_scope,
            &mut |_| {
                Err(JsError::new(
                    "InternalError",
                    JsString::from_str("out of memory"),
                ))
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "InternalError");
        assert_eq!(
            stringify_json(&model.snapshot(), JsonMode::Standard),
            before
        );
    }
}
