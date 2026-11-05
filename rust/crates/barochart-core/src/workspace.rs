//! Portable `aster.workspace` document validation, save, and native preflight.

#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, number_to_string_with, same_value};
use barochart_js::string::JsString;

use crate::Host;
use crate::checkpoint_codec::{safe_checkpoint_parse_scoped, safe_checkpoint_stringify_scoped};
use crate::contracts::{
    RESOURCE_LIMITS, SERIES_KEYS, THEME_KEYS, bounded_text, identifier, option_record,
    portable_style_scoped, size_limit,
};
use crate::data::{BarStore, ModelDataState, StoreOptions};
use crate::drawing_document::{DrawingDocumentLimits, enforce_drawing_budget};
use crate::drawing_validation::{validate_document_version, validate_drawing_with_memory};
use crate::drawings::DrawingStore;
use crate::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use crate::indicator_modules::{
    ModuleDocumentSurface, pressure_descriptor_value, resolve_document_module,
    unsupported_indicator_module,
};
use crate::indicator_params::validate_indicator_params;
use crate::markets::{Adjustment, Symbol, validate_symbol};
use crate::model_state::{ModelContext, ModelState};
use crate::position_drawing::drawing_document_version;

pub const WORKSPACE_CHARS: usize = 2_097_152;
pub const WORKSPACE_BYTES: usize = 4_194_304;
const WORKSPACE_KEYS: &[&str] = &[
    "schema",
    "version",
    "dataset",
    "source",
    "chart",
    "indicators",
    "series",
    "drawings",
];
const BINDING_KEYS: &[&str] = &[
    "key",
    "revision",
    "adjustmentVersion",
    "priceUnit",
    "adjustment",
];
const SYMBOL_KEYS: &[&str] = &[
    "id",
    "exchange",
    "timezone",
    "currency",
    "volumeUnit",
    "priceDecimals",
    "tickSize",
    "adjustment",
    "provider",
    "adjustmentVersion",
];
const REQUIRED_SYMBOL_KEYS: &[&str] = &[
    "id",
    "exchange",
    "timezone",
    "currency",
    "volumeUnit",
    "priceDecimals",
    "tickSize",
    "adjustment",
];

#[derive(Clone, Copy, Debug, Default)]
pub struct WorkspaceInteraction {
    pub gesture_active: bool,
    pub pointer_count: usize,
}

#[derive(Clone, Copy)]
pub struct WorkspaceSymbol<'a> {
    pub symbol: &'a Symbol,
    pub provider: Option<&'a JsString>,
    pub adjustment_version: Option<&'a JsString>,
}

pub struct WorkspaceContext<'a> {
    pub host: &'a dyn Host,
    pub model: &'a ModelState,
    pub store: &'a BarStore,
    pub indicators: &'a IndicatorEngine,
    pub drawings: &'a DrawingStore,
    pub symbol: Option<WorkspaceSymbol<'a>>,
    pub symbol_formatters: bool,
    pub interaction: WorkspaceInteraction,
    pub dialect: NumberDialect,
}

#[derive(Debug)]
pub struct ValidatedWorkspace {
    value: JsValue,
    _memory: MemoryGroup,
}

impl ValidatedWorkspace {
    pub fn value(&self) -> &JsValue {
        &self.value
    }
}

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

pub(crate) fn js_string_heap_bytes(value: &JsString) -> usize {
    value.len_utf16().saturating_mul(std::mem::size_of::<u16>())
}

pub(crate) fn js_value_heap_bytes(value: &JsValue) -> usize {
    match value {
        JsValue::String(value) => js_string_heap_bytes(value),
        JsValue::Array(values) => values
            .capacity()
            .saturating_mul(std::mem::size_of::<JsValue>())
            .saturating_add(values.iter().map(js_value_heap_bytes).sum()),
        JsValue::Object(object) => {
            let entries = object
                .len()
                .saturating_mul(std::mem::size_of::<(JsString, JsValue)>());
            let lookup = if object.len() > 8 {
                object
                    .len()
                    .saturating_mul(std::mem::size_of::<(JsString, usize)>())
            } else {
                0
            };
            entries.saturating_add(lookup).saturating_add(
                object
                    .iter()
                    .map(|(key, value)| {
                        js_string_heap_bytes(key).saturating_add(js_value_heap_bytes(value))
                    })
                    .sum(),
            )
        }
        JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => 0,
    }
}

struct WalkBudget {
    nodes: usize,
    chars: usize,
    bytes: usize,
    dialect: NumberDialect,
}

impl WalkBudget {
    fn cost(&mut self, chars: usize, bytes: usize) -> Result<(), JsError> {
        self.chars = self.chars.saturating_add(chars);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.chars > WORKSPACE_CHARS || self.bytes > WORKSPACE_BYTES {
            return Err(range_error("Workspace document limit"));
        }
        Ok(())
    }

    fn string(&mut self, value: &JsString) -> Result<(), JsError> {
        self.cost(2, 2)?;
        let units = value.as_units();
        let mut index = 0usize;
        while index < units.len() {
            let unit = units[index];
            match unit {
                0x22 | 0x5c => self.cost(2, 2)?,
                0x00..=0x1f => self.cost(6, 6)?,
                0x20..=0x7f => self.cost(1, 1)?,
                0x80..=0x7ff => self.cost(1, 2)?,
                0xd800..=0xdbff => {
                    let Some(next) = units.get(index + 1) else {
                        return Err(type_error("Workspace Unicode scalar"));
                    };
                    if !(0xdc00..=0xdfff).contains(next) {
                        return Err(type_error("Workspace Unicode scalar"));
                    }
                    self.cost(2, 4)?;
                    index += 1;
                }
                0xdc00..=0xdfff => return Err(type_error("Workspace Unicode scalar")),
                _ => self.cost(1, 3)?,
            }
            index += 1;
        }
        Ok(())
    }

    fn clone_value(
        &mut self,
        value: &JsValue,
        depth: usize,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        self.nodes = self.nodes.saturating_add(1);
        if self.nodes > 250_000 || depth > 32 {
            return Err(range_error("Workspace node/depth limit"));
        }
        match value {
            JsValue::Undefined => Err(type_error("Workspace portable data required")),
            JsValue::Null => {
                self.cost(4, 4)?;
                Ok(JsValue::Null)
            }
            JsValue::Bool(value) => {
                self.cost(if *value { 4 } else { 5 }, if *value { 4 } else { 5 })?;
                Ok(JsValue::Bool(*value))
            }
            JsValue::Number(value) => {
                if !value.is_finite() {
                    return Err(type_error("Workspace finite number"));
                }
                let length = if value.to_bits() == (-0.0_f64).to_bits() {
                    21
                } else {
                    number_to_string_with(*value, self.dialect).len()
                };
                self.cost(length, length)?;
                Ok(JsValue::Number(*value))
            }
            JsValue::String(value) => {
                self.string(value)?;
                Ok(JsValue::String(
                    value
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?,
                ))
            }
            JsValue::Array(values) => {
                if values.len() > 250_000 {
                    return Err(type_error("Workspace array shape"));
                }
                self.cost(2, 2)?;
                let bytes = values
                    .len()
                    .checked_mul(std::mem::size_of::<JsValue>())
                    .ok_or_else(|| scope.allocation_failure().into_js_error())?;
                scope
                    .try_grow(bytes)
                    .map_err(|failure| failure.into_js_error())?;
                let mut output = Vec::new();
                output
                    .try_reserve_exact(values.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                for value in values {
                    self.cost(1, 1)?;
                    output.push(self.clone_value(value, depth + 1, scope)?);
                }
                Ok(JsValue::Array(output))
            }
            JsValue::Object(values) => {
                self.cost(2, 2)?;
                let mut entries = Vec::new();
                let bytes = values
                    .len()
                    .checked_mul(std::mem::size_of::<(JsString, JsValue)>())
                    .ok_or_else(|| scope.allocation_failure().into_js_error())?;
                scope
                    .try_grow(bytes)
                    .map_err(|failure| failure.into_js_error())?;
                entries
                    .try_reserve_exact(values.len())
                    .map_err(|_| scope.allocation_failure().into_js_error())?;
                for (name, value) in values.iter() {
                    if ["__proto__", "constructor", "prototype", "toJSON"]
                        .iter()
                        .any(|reserved| text_eq(name, reserved))
                    {
                        return Err(type_error("Workspace reserved key"));
                    }
                    self.cost(1, 1)?;
                    self.string(name)?;
                    self.cost(1, 1)?;
                    entries.push((
                        name.try_clone_scoped(scope)
                            .map_err(|failure| failure.into_js_error())?,
                        self.clone_value(value, depth + 1, scope)?,
                    ));
                }
                Ok(JsValue::Object(
                    JsObject::try_from_entries_scoped(entries, scope)
                        .map_err(|failure| failure.into_js_error())?,
                ))
            }
        }
    }
}

pub fn workspace_snapshot(value: &JsValue, dialect: NumberDialect) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    workspace_snapshot_scoped(value, dialect, &mut scope)
}

/// Portable workspace tree를 scoped fallible allocation으로 깊게 복제한다.
pub fn workspace_snapshot_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    WalkBudget {
        nodes: 0,
        chars: 0,
        bytes: 0,
        dialect,
    }
    .clone_value(value, 0, scope)
}

pub fn workspace_binding(value: &JsValue, dialect: NumberDialect) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    workspace_binding_scoped(value, dialect, &mut scope)
}

/// Dataset binding을 canonical key order의 scoped fallible value로 만든다.
pub fn workspace_binding_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let binding = workspace_snapshot_scoped(value, dialect, scope)?;
    workspace_record(&binding, BINDING_KEYS, BINDING_KEYS)?;
    let record = object(&binding, "Workspace: object required")?;
    for field in BINDING_KEYS {
        bounded_text(
            required(record, field)?,
            128,
            &format!("Workspace dataset {field}"),
            false,
        )?;
    }
    let adjustment = string(required(record, "adjustment")?)?;
    if !["raw", "split", "total-return"]
        .iter()
        .any(|candidate| text_eq(adjustment, candidate))
    {
        return Err(type_error("Workspace adjustment"));
    }
    let mut entries = Vec::new();
    scope
        .try_grow(BINDING_KEYS.len() * std::mem::size_of::<(JsString, JsValue)>())
        .map_err(|failure| failure.into_js_error())?;
    entries
        .try_reserve_exact(BINDING_KEYS.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for name in BINDING_KEYS {
        entries.push((
            JsString::from_str(name),
            required(record, name)?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ));
    }
    Ok(JsValue::Object(
        JsObject::try_from_entries_scoped(entries, scope)
            .map_err(|failure| failure.into_js_error())?,
    ))
}

pub fn workspace_binding_same(left: &JsValue, right: &JsValue) -> bool {
    let (Some(left), Some(right)) = (object_opt(left), object_opt(right)) else {
        return false;
    };
    BINDING_KEYS.iter().all(
        |field| match (left.get(&key(field)), right.get(&key(field))) {
            (Some(JsValue::String(left)), Some(JsValue::String(right))) => left == right,
            _ => false,
        },
    )
}

pub fn read_workspace_document(
    text: &JsValue,
    host: &dyn Host,
) -> Result<ValidatedWorkspace, JsError> {
    read_workspace_document_with_memory(
        text,
        host,
        NumberDialect::PLATFORM,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

/// Workspace JSON parse, portable snapshot, validation과 retained tree를 한 account에 묶는다.
pub fn read_workspace_document_with_memory(
    text: &JsValue,
    host: &dyn Host,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<ValidatedWorkspace, JsError> {
    let text = bounded_text(text, WORKSPACE_CHARS, "Workspace document", true)?;
    let mut bytes = 0usize;
    let units = text.as_units();
    let mut index = 0usize;
    while index < units.len() {
        let unit = units[index];
        bytes = bytes.saturating_add(if unit < 128 {
            1
        } else if unit < 2_048 {
            2
        } else if (0xd800..=0xdbff).contains(&unit) {
            index += 1;
            4
        } else {
            3
        });
        if bytes > WORKSPACE_BYTES {
            return Err(range_error("Workspace document byte limit"));
        }
        index += 1;
    }
    let mut scope = memory.scope();
    let input = text
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let parsed = safe_checkpoint_parse_scoped(&JsValue::String(input), dialect, &mut scope)?;
    let parsed = workspace_snapshot_scoped(&parsed, dialect, &mut scope)?;
    validate_workspace_document_inner(&parsed, host, memory, &mut scope)?;
    let mut retained_scope = memory.scope();
    let value = parsed
        .try_clone_scoped(&mut retained_scope)
        .map_err(|failure| failure.into_js_error())?;
    let bytes = js_value_heap_bytes(&value);
    let document_memory = retained_scope
        .split_persistent(bytes)
        .map_err(|failure| failure.into_js_error())?;
    drop((parsed, scope));
    Ok(ValidatedWorkspace {
        value,
        _memory: document_memory,
    })
}

pub fn validate_workspace_document(
    value: &JsValue,
    host: &dyn Host,
) -> Result<ValidatedWorkspace, JsError> {
    validate_workspace_document_with_memory(
        value,
        host,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

/// 이미 파싱된 workspace 값을 explicit account에서 검증·복제해 소유한다.
pub fn validate_workspace_document_with_memory(
    value: &JsValue,
    host: &dyn Host,
    memory: &MemoryContext,
) -> Result<ValidatedWorkspace, JsError> {
    let mut scope = memory.scope();
    let value = workspace_snapshot_scoped(value, NumberDialect::PLATFORM, &mut scope)?;
    validate_workspace_document_inner(&value, host, memory, &mut scope)?;
    let mut retained_scope = memory.scope();
    let retained = value
        .try_clone_scoped(&mut retained_scope)
        .map_err(|failure| failure.into_js_error())?;
    let bytes = js_value_heap_bytes(&retained);
    let document_memory = retained_scope
        .split_persistent(bytes)
        .map_err(|failure| failure.into_js_error())?;
    drop((value, scope));
    Ok(ValidatedWorkspace {
        value: retained,
        _memory: document_memory,
    })
}

fn validate_workspace_document_inner(
    value: &JsValue,
    host: &dyn Host,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    workspace_record(value, WORKSPACE_KEYS, WORKSPACE_KEYS)?;
    let document = object(value, "Workspace: object required")?;
    if !matches!(required(document, "schema")?, JsValue::String(value) if text_eq(value, "aster.workspace"))
        || !matches!(required(document, "version")?, JsValue::Number(1.0))
    {
        return Err(type_error("Workspace schema/version"));
    }
    let dataset = workspace_binding_scoped(
        required(document, "dataset")?,
        NumberDialect::PLATFORM,
        scope,
    )?;
    let source = required_object(document, "source", "Workspace: object required")?;
    workspace_record(
        required(document, "source")?,
        &["length", "firstTime", "lastTime"],
        &["length", "firstTime", "lastTime"],
    )?;
    let length = size_limit(
        required(source, "length")?,
        RESOURCE_LIMITS.max_bars,
        "Workspace source length",
    )? as usize;
    validate_source_endpoints(source, length)?;

    let chart_value = required(document, "chart")?;
    workspace_record(
        chart_value,
        &[
            "panels",
            "axes",
            "theme",
            "symbol",
            "formatters",
            "precision",
            "axisWidth",
            "view",
            "follow",
        ],
        &[
            "panels",
            "axes",
            "theme",
            "symbol",
            "formatters",
            "precision",
            "axisWidth",
            "view",
            "follow",
        ],
    )?;
    let chart = object(chart_value, "Workspace: object required")?;
    let _panels = match required(chart, "panels")? {
        JsValue::Array(value) if !value.is_empty() && value.len() <= 32 => value,
        _ => return Err(type_error("Workspace chart configuration")),
    };
    let _axes = match required(chart, "axes")? {
        JsValue::Array(value) if value.len() <= 64 => value,
        _ => return Err(type_error("Workspace chart configuration")),
    };
    let precision = match required(chart, "precision")? {
        JsValue::Number(value)
            if value.is_finite() && value.fract() == 0.0 && (0.0..=18.0).contains(value) =>
        {
            *value
        }
        _ => return Err(type_error("Workspace chart configuration")),
    };
    let axis_width = match required(chart, "axisWidth")? {
        JsValue::Number(value) if value.is_finite() && *value >= 20.0 => *value,
        _ => return Err(type_error("Workspace chart configuration")),
    };
    if !matches!(required(chart, "follow")?, JsValue::Bool(_))
        || !matches!(required(chart, "formatters")?, JsValue::String(value) if text_eq(value, "default") || text_eq(value, "symbol"))
    {
        return Err(type_error("Workspace chart configuration"));
    }
    validate_view(required(chart, "view")?)?;
    let theme = required(chart, "theme")?;
    workspace_record(theme, THEME_KEYS, THEME_KEYS)?;
    portable_style_scoped(
        theme,
        &["background", "grid", "text", "up", "down", "crosshair"],
        true,
        scope,
    )?;
    let dataset_record = object(&dataset, "Workspace: object required")?;
    validate_workspace_symbol(
        required(chart, "symbol")?,
        required(chart, "formatters")?,
        dataset_record,
        host,
        scope,
    )?;

    let indicators = match required(document, "indicators")? {
        JsValue::Array(values) if values.len() <= RESOURCE_LIMITS.max_indicators as usize => values,
        _ => return Err(range_error("Workspace study/series limit")),
    };
    let series = match required(document, "series")? {
        JsValue::Array(values) if values.len() <= RESOURCE_LIMITS.max_series as usize => values,
        _ => return Err(range_error("Workspace study/series limit")),
    };
    let definitions = validate_indicator_records(indicators, scope)?;

    let empty =
        ModelDataState::new_with_memory(StoreOptions::default(), Vec::new(), memory.clone())?;
    let model_options = object_value([
        (
            "panels",
            required(chart, "panels")?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        (
            "axes",
            required(chart, "axes")?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        (
            "theme",
            theme
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        ("axisWidth", JsValue::Number(axis_width)),
        ("precision", JsValue::Number(precision)),
    ]);
    let mut facade = ModelState::new(empty.store(), &model_options)?;
    validate_workspace_series(series, &definitions, &mut facade, empty.store(), scope)?;
    validate_workspace_drawings(required(document, "drawings")?, &facade, memory, scope)?;
    Ok(())
}

pub fn save_workspace(
    context: &WorkspaceContext<'_>,
    binding: &JsValue,
    owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
) -> Result<JsString, JsError> {
    save_workspace_with_memory(
        context,
        binding,
        owner_guard,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
    .map(|(text, _)| text)
}

/// Canonical workspace text와 그 결과가 참조하는 allocation group을 함께 돌려준다.
pub fn save_workspace_with_memory(
    context: &WorkspaceContext<'_>,
    binding: &JsValue,
    mut owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
    memory: &MemoryContext,
) -> Result<(JsString, MemoryGroup), JsError> {
    if context.interaction.gesture_active
        || context.interaction.pointer_count > 0
        || context.drawings.transaction().is_some()
    {
        return Err(ordinary_error(
            "Commit or cancel gestures before saving workspace",
        ));
    }
    if context.symbol_formatters && context.symbol.is_none() {
        return Err(type_error("Workspace custom formatters unsupported"));
    }
    let mut scope = memory.scope();
    let binding = workspace_binding_scoped(binding, context.dialect, &mut scope)?;
    let columns = context.store.columns();
    let length = context.store.length();
    let mut indicators = scoped_vec(context.indicators.len(), &mut scope)?;
    scope
        .try_grow(
            context
                .indicators
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 256),
        )
        .map_err(|failure| failure.into_js_error())?;
    let ids = context.indicators.entry_ids();
    for id in ids {
        let lookup = id
            .try_clone_scoped(&mut scope)
            .map_err(|failure| failure.into_js_error())?;
        let entry = context
            .indicators
            .entry(&JsValue::String(lookup))
            .expect("entry id snapshot is current");
        scope
            .try_grow(8 * std::mem::size_of::<(JsString, JsValue)>() + 256)
            .map_err(|failure| failure.into_js_error())?;
        let mut record = JsObject::new();
        record.insert(key("id"), JsValue::String(id));
        record.insert(
            key("name"),
            JsValue::String(
                entry
                    .name()
                    .try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        );
        record.insert(
            key("params"),
            entry
                .params()
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        );
        if entry.name() == &JsString::from_str("aster.volume-direction@1/pressure") {
            scope
                .try_grow(1_024)
                .map_err(|failure| failure.into_js_error())?;
            record.insert(key("module"), pressure_descriptor_value());
        }
        let mut outputs = scoped_vec(entry.definition().outputs.len(), &mut scope)?;
        for output in entry.definition().outputs {
            scope
                .try_grow(output.len().saturating_mul(2))
                .map_err(|failure| failure.into_js_error())?;
            outputs.push(JsValue::String(JsString::from_str(output)));
        }
        record.insert(key("outputs"), JsValue::Array(outputs));
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
        record.insert(key("plotOffsets"), JsValue::Object(offsets));
        indicators.push(JsValue::Object(record));
    }
    let mut series = scoped_vec(context.model.series.len(), &mut scope)?;
    for item in &context.model.series {
        if item.values.is_some() {
            return Err(type_error("Workspace external values unsupported"));
        }
        let bytes = usize::try_from(item.metadata_accounted_bytes())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        scope
            .try_grow(bytes)
            .map_err(|failure| failure.into_js_error())?;
        series.push(item.to_js_value());
    }
    let mut panels = scoped_vec(context.model.panels.len(), &mut scope)?;
    for panel in &context.model.panels {
        scope
            .try_grow(2_048)
            .map_err(|failure| failure.into_js_error())?;
        panels.push(panel.to_js_value());
    }
    let mut axes = scoped_vec(context.model.axes.len(), &mut scope)?;
    for axis in &context.model.axes {
        scope
            .try_grow(2_048)
            .map_err(|failure| failure.into_js_error())?;
        axes.push(axis.to_js_value());
    }
    let symbol = if let Some(symbol) = context.symbol {
        let string_units = symbol.symbol.id.len_utf16()
            + symbol.symbol.exchange.len_utf16()
            + symbol.symbol.timezone.len_utf16()
            + symbol.symbol.currency.len_utf16()
            + symbol.symbol.volume_unit.len_utf16()
            + symbol.provider.map_or(0, JsString::len_utf16)
            + symbol.adjustment_version.map_or(0, JsString::len_utf16);
        scope
            .try_grow(string_units.saturating_mul(2).saturating_add(2_048))
            .map_err(|failure| failure.into_js_error())?;
        workspace_symbol_value_scoped(symbol, &mut scope)?
    } else {
        JsValue::Null
    };
    let chart = object_value([
        ("panels", JsValue::Array(panels)),
        ("axes", JsValue::Array(axes)),
        (
            "theme",
            context
                .model
                .theme()
                .try_clone_scoped(&mut scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
        ("symbol", symbol),
        (
            "formatters",
            JsValue::String(JsString::from_str(if context.symbol_formatters {
                "symbol"
            } else {
                "default"
            })),
        ),
        (
            "precision",
            JsValue::Number(f64::from(context.model.precision)),
        ),
        ("axisWidth", JsValue::Number(context.model.axis_width)),
        (
            "view",
            object_value([
                ("from", JsValue::Number(context.model.view.from)),
                ("to", JsValue::Number(context.model.view.to)),
            ]),
        ),
        ("follow", JsValue::Bool(context.model.follow)),
    ]);
    let drawings = context.drawings.items();
    let mut drawing_values = scoped_vec(drawings.len(), &mut scope)?;
    for drawing in drawings {
        drawing_values.push(drawing.to_value_scoped(&mut scope)?);
    }
    scope
        .try_grow(16_384)
        .map_err(|failure| failure.into_js_error())?;
    let document = object_value([
        ("schema", text("aster.workspace")),
        ("version", JsValue::Number(1.0)),
        ("dataset", binding),
        (
            "source",
            object_value([
                ("length", JsValue::Number(length as f64)),
                (
                    "firstTime",
                    if length == 0 {
                        JsValue::Null
                    } else {
                        JsValue::Number(columns.time[0])
                    },
                ),
                (
                    "lastTime",
                    if length == 0 {
                        JsValue::Null
                    } else {
                        JsValue::Number(columns.time[length - 1])
                    },
                ),
            ]),
        ),
        ("chart", chart),
        ("indicators", JsValue::Array(indicators)),
        ("series", JsValue::Array(series)),
        (
            "drawings",
            object_value([
                ("schema", text("aster.drawings")),
                (
                    "version",
                    JsValue::Number(f64::from(drawing_document_version(drawings))),
                ),
                ("drawings", JsValue::Array(drawing_values)),
            ]),
        ),
    ]);
    let document = workspace_snapshot_scoped(&document, context.dialect, &mut scope)?;
    let validated = validate_workspace_document_with_memory(&document, context.host, memory)?;
    drop(validated);
    let temporary_text = safe_checkpoint_stringify_scoped(&document, context.dialect, &mut scope)?;
    let roundtrip_text = temporary_text
        .try_clone_scoped(&mut scope)
        .map_err(|failure| failure.into_js_error())?;
    let roundtrip = read_workspace_document_with_memory(
        &JsValue::String(roundtrip_text),
        context.host,
        context.dialect,
        memory,
    )?;
    drop(roundtrip);
    if let Some(guard) = owner_guard.as_mut() {
        guard()?;
    }
    let mut retained_scope = memory.scope();
    let text = temporary_text
        .try_clone_scoped(&mut retained_scope)
        .map_err(|failure| failure.into_js_error())?;
    let memory = retained_scope
        .split_persistent(js_string_heap_bytes(&text))
        .map_err(|failure| failure.into_js_error())?;
    drop((document, temporary_text, scope));
    Ok((text, memory))
}

pub fn preflight_workspace(
    context: &WorkspaceContext<'_>,
    text_value: &JsValue,
    binding: &JsValue,
    owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
) -> Result<JsValue, JsError> {
    preflight_workspace_with_memory(
        context,
        text_value,
        binding,
        owner_guard,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
    .map(|(value, _)| value)
}

/// Workspace preflight receipt와 retained tree allocation group을 함께 돌려준다.
pub fn preflight_workspace_with_memory(
    context: &WorkspaceContext<'_>,
    text_value: &JsValue,
    binding: &JsValue,
    mut owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
    memory: &MemoryContext,
) -> Result<(JsValue, MemoryGroup), JsError> {
    validate_store_dimensions(context.store)?;
    let mut scope = memory.scope();
    let binding = workspace_binding_scoped(binding, context.dialect, &mut scope)?;
    let document =
        read_workspace_document_with_memory(text_value, context.host, context.dialect, memory)?;
    if let Some(guard) = owner_guard.as_mut() {
        guard()?;
    }
    let document_value = document.value();
    if !workspace_binding_same(required_value(document_value, "dataset")?, &binding) {
        return Err(type_error("Workspace dataset binding mismatch"));
    }
    validate_extent(required_value(document_value, "source")?, context.store)?;
    let empty =
        ModelDataState::new_with_memory(StoreOptions::default(), Vec::new(), memory.clone())?;
    let mut staging =
        IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), memory.clone())?;
    let mut outputs = 0usize;
    let indicators = array(required_value(document_value, "indicators")?)?;
    let (mut modules, result_memory) = memory
        .try_vec_capacity(indicators.len())
        .map_err(|failure| failure.into_js_error())?;
    let mut module_names = HashSet::new();
    scope
        .try_grow(
            indicators
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 32),
        )
        .map_err(|failure| failure.into_js_error())?;
    module_names
        .try_reserve(indicators.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for study in indicators {
        let record = object(study, "Workspace: object required")?;
        let id = required(record, "id")?;
        let name = required(record, "name")?;
        let params = required(record, "params")?;
        let JsValue::String(name_text) = name else {
            return Err(unsupported_indicator_module(&JsString::from_str(
                "undefined",
            )));
        };
        if !crate::indicator_types::IndicatorProgram::ALL
            .iter()
            .any(|program| name_text == &JsString::from_str(program.name()))
        {
            return Err(unsupported_indicator_module(name_text));
        }
        let _ = staging.add(empty.store(), context.host, id, name, params)?;
        let entry = staging
            .entry(id)
            .expect("staging add published the requested id");
        if !state_equal(entry.params(), params) {
            return Err(type_error("Workspace factory changed requested params"));
        }
        compare_output_layout(entry.definition(), record)?;
        outputs = outputs.saturating_add(entry.definition().outputs.len());
        if outputs
            .saturating_mul(context.store.capacity())
            .saturating_mul(8)
            > staging.max_output_bytes()
        {
            return Err(range_error("Workspace projected output byte limit"));
        }
        if let Some(module) = record.get(&key("module"))
            && let JsValue::String(name) = name
            && module_names.insert(
                name.try_clone_scoped(&mut scope)
                    .map_err(|failure| failure.into_js_error())?,
            )
        {
            modules.push(workspace_snapshot_scoped(
                module,
                context.dialect,
                &mut scope,
            )?);
        }
        if let Some(guard) = owner_guard.as_mut() {
            guard()?;
        }
    }
    let source = object(
        required_value(document_value, "source")?,
        "Workspace: object required",
    )?;
    let chart = object(
        required_value(document_value, "chart")?,
        "Workspace: object required",
    )?;
    let drawings = object(
        required_value(document_value, "drawings")?,
        "Workspace: object required",
    )?;
    let counts = object_value([
        (
            "panels",
            JsValue::Number(array(required(chart, "panels")?)?.len() as f64),
        ),
        (
            "axes",
            JsValue::Number(array(required(chart, "axes")?)?.len() as f64),
        ),
        (
            "series",
            JsValue::Number(array(required_value(document_value, "series")?)?.len() as f64),
        ),
        ("indicators", JsValue::Number(indicators.len() as f64)),
        ("outputs", JsValue::Number(outputs as f64)),
        (
            "drawings",
            JsValue::Number(array(required(drawings, "drawings")?)?.len() as f64),
        ),
    ]);
    if let Some(guard) = owner_guard.as_mut() {
        guard()?;
    }
    let receipt = object_value([
        ("schema", text("aster.workspace-preflight")),
        ("version", JsValue::Number(1.0)),
        ("status", text("validated-only")),
        ("restored", JsValue::Bool(false)),
        ("dataset", binding),
        (
            "source",
            object_value([
                (
                    "length",
                    required(source, "length")?
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
                (
                    "firstTime",
                    required(source, "firstTime")?
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
                (
                    "lastTime",
                    required(source, "lastTime")?
                        .try_clone_scoped(&mut scope)
                        .map_err(|failure| failure.into_js_error())?,
                ),
                ("version", JsValue::Number(context.store.version())),
            ]),
        ),
        ("counts", counts),
        (
            "projectedOutputBytes",
            JsValue::Number((outputs * context.store.capacity() * 8) as f64),
        ),
        (
            "outputByteLimit",
            JsValue::Number(staging.max_output_bytes() as f64),
        ),
        ("modules", JsValue::Array(modules)),
    ]);
    let mut retained_scope = memory.scope();
    let retained = receipt
        .try_clone_scoped(&mut retained_scope)
        .map_err(|failure| failure.into_js_error())?;
    let bytes = js_value_heap_bytes(&retained);
    let retained_memory = retained_scope
        .split_persistent(bytes)
        .map_err(|failure| failure.into_js_error())?;
    drop((receipt, result_memory, scope));
    Ok((retained, retained_memory))
}

#[derive(Clone)]
struct DocumentDefinition {
    outputs: Vec<JsString>,
    offsets: HashMap<JsString, f64>,
}

fn validate_indicator_records(
    indicators: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<HashMap<JsString, DocumentDefinition>, JsError> {
    let mut definitions = HashMap::new();
    scope
        .try_grow(
            indicators
                .len()
                .saturating_mul(std::mem::size_of::<(JsString, DocumentDefinition)>() + 32),
        )
        .map_err(|failure| failure.into_js_error())?;
    definitions
        .try_reserve(indicators.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for indicator in indicators {
        workspace_record(
            indicator,
            &["id", "name", "params", "module", "outputs", "plotOffsets"],
            &["id", "name", "params", "outputs", "plotOffsets"],
        )?;
        let record = object(indicator, "Workspace: object required")?;
        let id = identifier(required(record, "id")?, "Workspace indicator id")?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let name = identifier(required(record, "name")?, "Workspace indicator name")?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        if definitions.contains_key(&id) {
            return Err(type_error("Duplicate workspace indicator"));
        }
        validate_indicator_params(required(record, "params")?)?;
        resolve_document_module(
            &name,
            record.get(&key("module")),
            ModuleDocumentSurface::Workspace,
        )?;
        let outputs = match required(record, "outputs")? {
            JsValue::Array(values) if !values.is_empty() && values.len() <= 32 => values,
            _ => return Err(type_error("Workspace output schema")),
        };
        scope
            .try_grow(outputs.len() * std::mem::size_of::<JsString>())
            .map_err(|failure| failure.into_js_error())?;
        let mut output_names = Vec::new();
        output_names
            .try_reserve_exact(outputs.len())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        let mut unique = HashSet::new();
        scope
            .try_grow(
                outputs
                    .len()
                    .saturating_mul(std::mem::size_of::<JsString>() + 32),
            )
            .map_err(|failure| failure.into_js_error())?;
        unique
            .try_reserve(outputs.len())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        for output in outputs {
            let output = identifier(output, "Workspace output")?
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            let unique_output = output
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?;
            if !unique.insert(unique_output) {
                return Err(type_error("Workspace output schema"));
            }
            output_names.push(output);
        }
        let plot_offsets = required(record, "plotOffsets")?;
        scope
            .try_grow(
                output_names
                    .iter()
                    .map(|name| name.len_utf16().saturating_mul(3))
                    .sum::<usize>(),
            )
            .map_err(|failure| failure.into_js_error())?;
        let mut allowed = scoped_vec(output_names.len(), scope)?;
        for output in &output_names {
            allowed.push(output.to_string_lossy());
        }
        let mut allowed_refs = scoped_vec(allowed.len(), scope)?;
        allowed_refs.extend(allowed.iter().map(String::as_str));
        option_record(plot_offsets, &allowed_refs, "Workspace")?;
        let offsets = object(plot_offsets, "Workspace: object required")?;
        let mut typed_offsets = HashMap::new();
        scope
            .try_grow(
                offsets
                    .len()
                    .saturating_mul(std::mem::size_of::<(JsString, f64)>() + 32),
            )
            .map_err(|failure| failure.into_js_error())?;
        typed_offsets
            .try_reserve(offsets.len())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        for (output, offset) in offsets.iter() {
            let JsValue::Number(offset) = offset else {
                return Err(type_error("Workspace output offset"));
            };
            if !offset.is_finite() || offset.fract() != 0.0 || offset.abs() > 10_000.0 {
                return Err(type_error("Workspace output offset"));
            }
            typed_offsets.insert(
                output
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
                *offset,
            );
        }
        definitions.insert(
            id,
            DocumentDefinition {
                outputs: output_names,
                offsets: typed_offsets,
            },
        );
    }
    Ok(definitions)
}

fn validate_workspace_series(
    series: &[JsValue],
    definitions: &HashMap<JsString, DocumentDefinition>,
    model: &mut ModelState,
    store: &BarStore,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let mut allowed = scoped_vec(SERIES_KEYS.len(), scope)?;
    allowed.extend(
        SERIES_KEYS
            .iter()
            .copied()
            .filter(|field| *field != "values"),
    );
    for value in series {
        workspace_record(value, &allowed, &["id", "type", "panel"])?;
        scope
            .try_grow(4_096)
            .map_err(|failure| failure.into_js_error())?;
        portable_style_scoped(
            value,
            &["color", "fill", "upColor", "downColor"],
            true,
            scope,
        )?;
        let record = object(value, "Workspace: object required")?;
        let mut normalized = value
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let JsValue::Object(normalized_record) = &mut normalized else {
            unreachable!("workspace record is an object")
        };
        if let Some(indicator) = record.get(&key("indicator"))
            && !is_falsy(indicator)
        {
            if matches!(record.get(&key("type")), Some(JsValue::String(kind)) if text_eq(kind, "candles") || text_eq(kind, "ohlc"))
            {
                return Err(type_error("Candles/OHLC use primary store OHLCV"));
            }
            let JsValue::String(indicator) = indicator else {
                return Err(ordinary_error("Missing workspace indicator"));
            };
            let Some(definition) = definitions.get(indicator) else {
                return Err(ordinary_error("Missing workspace indicator"));
            };
            let output = match record.get(&key("output")) {
                None | Some(JsValue::Undefined | JsValue::Null) => definition.outputs[0]
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
                Some(JsValue::String(output))
                    if definition
                        .outputs
                        .iter()
                        .any(|candidate| candidate == output) =>
                {
                    output
                        .try_clone_scoped(scope)
                        .map_err(|failure| failure.into_js_error())?
                }
                _ => return Err(ordinary_error("Missing indicator output")),
            };
            let offset = match record.get(&key("offset")) {
                None | Some(JsValue::Undefined | JsValue::Null) => {
                    definition.offsets.get(&output).copied().unwrap_or(0.0)
                }
                Some(JsValue::Number(offset)) => *offset,
                _ => f64::NAN,
            };
            if !offset.is_finite() || offset.fract() != 0.0 || offset.abs() > 10_000.0 {
                return Err(range_error("Series plot offset"));
            }
            normalized_record.remove(&key("indicator"));
            normalized_record.remove(&key("output"));
            normalized_record.insert(key("offset"), JsValue::Number(offset));
        }
        model.add_series(&normalized, &ModelContext::plain(store))?;
    }
    Ok(())
}

fn validate_workspace_drawings(
    value: &JsValue,
    model: &ModelState,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    workspace_record(
        value,
        &["schema", "version", "drawings"],
        &["schema", "version", "drawings"],
    )?;
    let record = object(value, "Workspace: object required")?;
    let version = match required(record, "version")? {
        JsValue::Number(value) if matches!(*value, 1.0 | 2.0 | 3.0 | 4.0) => *value,
        _ => return Err(type_error("Workspace drawing schema")),
    };
    let drawings = match required(record, "drawings")? {
        JsValue::Array(drawings) => drawings,
        _ => return Err(type_error("Workspace drawing schema")),
    };
    if !matches!(required(record, "schema")?, JsValue::String(value) if text_eq(value, "aster.drawings"))
    {
        return Err(type_error("Workspace drawing schema"));
    }
    if drawings.len() > RESOURCE_LIMITS.max_drawings as usize {
        return Err(range_error("Workspace drawing count"));
    }
    scope
        .try_grow(
            drawings.len() * std::mem::size_of::<std::sync::Arc<crate::drawing_types::Drawing>>(),
        )
        .map_err(|failure| failure.into_js_error())?;
    let mut typed = Vec::new();
    typed
        .try_reserve_exact(drawings.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    let mut ids = HashSet::new();
    scope
        .try_grow(
            drawings
                .len()
                .saturating_mul(std::mem::size_of::<JsString>() + 32),
        )
        .map_err(|failure| failure.into_js_error())?;
    ids.try_reserve(drawings.len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for raw in drawings {
        let _allocation_mirror = raw
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let drawing = validate_drawing_with_memory(raw, memory)?;
        validate_document_version(&drawing, version)?;
        model.validate_drawing_binding(raw, false)?;
        if let Some(style) = object_opt(raw).and_then(|record| record.get(&key("style"))) {
            scope
                .try_grow(2_048)
                .map_err(|failure| failure.into_js_error())?;
            portable_style_scoped(style, &["color", "fill"], true, scope)?;
        }
        let id = drawing
            .id
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        if !ids.insert(id) {
            return Err(type_error("Duplicate drawing ids"));
        }
        scope
            .try_grow(std::mem::size_of::<crate::drawing_types::Drawing>())
            .map_err(|failure| failure.into_js_error())?;
        typed.push(std::sync::Arc::new(drawing));
    }
    enforce_drawing_budget(&typed, DrawingDocumentLimits::default())?;
    Ok(())
}

fn validate_source_endpoints(source: &JsObject, length: usize) -> Result<(), JsError> {
    let first = required(source, "firstTime")?;
    let last = required(source, "lastTime")?;
    if length == 0 {
        if !matches!(first, JsValue::Null) || !matches!(last, JsValue::Null) {
            return Err(type_error("Empty workspace endpoints"));
        }
        return Ok(());
    }
    let (JsValue::Number(first), JsValue::Number(last)) = (first, last) else {
        return Err(type_error("Workspace source endpoints"));
    };
    let valid = [*first, *last].iter().all(|value| {
        value.is_finite()
            && value.fract() == 0.0
            && value.abs() <= 8_640_000_000_000_000.0
            && value.abs() <= 9_007_199_254_740_991.0
    }) && last >= first
        && if length == 1 {
            first == last
        } else {
            first != last
        };
    if !valid {
        return Err(type_error("Workspace source endpoints"));
    }
    Ok(())
}

fn validate_view(value: &JsValue) -> Result<(), JsError> {
    workspace_record(value, &["from", "to"], &["from", "to"])?;
    let record = object(value, "Workspace: object required")?;
    let (JsValue::Number(from), JsValue::Number(to)) =
        (required(record, "from")?, required(record, "to")?)
    else {
        return Err(range_error("Workspace view"));
    };
    if !from.is_finite() || !to.is_finite() || to <= from {
        return Err(range_error("Workspace view"));
    }
    Ok(())
}

fn validate_workspace_symbol(
    value: &JsValue,
    formatters: &JsValue,
    dataset: &JsObject,
    host: &dyn Host,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    if matches!(value, JsValue::Null) {
        if matches!(formatters, JsValue::String(value) if text_eq(value, "symbol")) {
            return Err(type_error("Workspace symbol formatter metadata"));
        }
        return Ok(());
    }
    workspace_record(value, SYMBOL_KEYS, REQUIRED_SYMBOL_KEYS)?;
    let record = object(value, "Workspace: object required")?;
    for field in [
        "id",
        "exchange",
        "timezone",
        "currency",
        "volumeUnit",
        "provider",
        "adjustmentVersion",
    ] {
        if let Some(value) = record.get(&key(field)) {
            bounded_text(value, 128, "Workspace symbol", false)?;
        }
    }
    let symbol = symbol_from_record_scoped(record, scope)?;
    validate_symbol(host, symbol)?;
    if !state_equal(
        required(record, "currency")?,
        required(dataset, "priceUnit")?,
    ) || !state_equal(
        required(record, "adjustment")?,
        required(dataset, "adjustment")?,
    ) {
        return Err(type_error("Workspace symbol dataset units/adjustment"));
    }
    Ok(())
}

fn symbol_from_record_scoped(
    record: &JsObject,
    scope: &mut MemoryScope,
) -> Result<Symbol, JsError> {
    let adjustment = match string(required(record, "adjustment")?)? {
        value if text_eq(value, "raw") => Adjustment::Raw,
        value if text_eq(value, "split") => Adjustment::Split,
        value if text_eq(value, "total-return") => Adjustment::TotalReturn,
        _ => return Err(type_error("Invalid symbol metadata")),
    };
    let price_decimals = match required(record, "priceDecimals")? {
        JsValue::Number(value) if value.fract() == 0.0 && *value >= 0.0 && *value <= 18.0 => {
            *value as u32
        }
        _ => return Err(type_error("Invalid symbol metadata")),
    };
    let tick_size = match required(record, "tickSize")? {
        JsValue::Number(value) => *value,
        _ => return Err(type_error("Invalid symbol metadata")),
    };
    Ok(Symbol {
        id: string(required(record, "id")?)?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        exchange: string(required(record, "exchange")?)?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        timezone: string(required(record, "timezone")?)?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        currency: string(required(record, "currency")?)?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        volume_unit: string(required(record, "volumeUnit")?)?
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?,
        price_decimals,
        tick_size,
        adjustment,
    })
}

fn workspace_symbol_value_scoped(
    symbol: WorkspaceSymbol<'_>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let adjustment = match symbol.symbol.adjustment {
        Adjustment::Raw => "raw",
        Adjustment::Split => "split",
        Adjustment::TotalReturn => "total-return",
    };
    scope
        .try_grow(10 * (std::mem::size_of::<(JsString, JsValue)>() + 64))
        .map_err(|failure| failure.into_js_error())?;
    let mut value = JsObject::new();
    value.insert(
        key("id"),
        JsValue::String(
            symbol
                .symbol
                .id
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    );
    value.insert(
        key("exchange"),
        JsValue::String(
            symbol
                .symbol
                .exchange
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    );
    value.insert(
        key("timezone"),
        JsValue::String(
            symbol
                .symbol
                .timezone
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    );
    value.insert(
        key("currency"),
        JsValue::String(
            symbol
                .symbol
                .currency
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    );
    value.insert(
        key("volumeUnit"),
        JsValue::String(
            symbol
                .symbol
                .volume_unit
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
        ),
    );
    value.insert(
        key("priceDecimals"),
        JsValue::Number(f64::from(symbol.symbol.price_decimals)),
    );
    value.insert(key("tickSize"), JsValue::Number(symbol.symbol.tick_size));
    value.insert(key("adjustment"), text(adjustment));
    if let Some(provider) = symbol.provider {
        value.insert(
            key("provider"),
            JsValue::String(
                provider
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        );
    }
    if let Some(version) = symbol.adjustment_version {
        value.insert(
            key("adjustmentVersion"),
            JsValue::String(
                version
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        );
    }
    Ok(JsValue::Object(value))
}

fn validate_store_dimensions(store: &BarStore) -> Result<(), JsError> {
    let valid = store.length() <= RESOURCE_LIMITS.max_bars as usize
        && store.capacity() >= 16
        && store.capacity() >= store.length()
        && store.capacity() <= RESOURCE_LIMITS.max_bars as usize
        && store.capacity().is_power_of_two()
        && store.version().is_finite()
        && store.version().fract() == 0.0
        && store.version() >= 0.0
        && store.version() <= 9_007_199_254_740_991.0;
    if !valid {
        return Err(range_error("Workspace source dimensions/version"));
    }
    let columns = store.columns();
    if [
        columns.time.len(),
        columns.open.len(),
        columns.high.len(),
        columns.low.len(),
        columns.close.len(),
        columns.volume.len(),
    ]
    .iter()
    .any(|length| *length < store.length())
    {
        return Err(type_error("Workspace source columns"));
    }
    Ok(())
}

fn validate_extent(value: &JsValue, store: &BarStore) -> Result<(), JsError> {
    let source = object(value, "Workspace: object required")?;
    let expected_first = if store.length() == 0 {
        JsValue::Null
    } else {
        JsValue::Number(store.columns().time[0])
    };
    let expected_last = if store.length() == 0 {
        JsValue::Null
    } else {
        JsValue::Number(store.columns().time[store.length() - 1])
    };
    if !matches!(required(source, "length")?, JsValue::Number(value) if *value == store.length() as f64)
        || !state_equal(required(source, "firstTime")?, &expected_first)
        || !state_equal(required(source, "lastTime")?, &expected_last)
    {
        return Err(type_error("Workspace source extent mismatch"));
    }
    Ok(())
}

fn compare_output_layout(
    definition: &crate::indicator_types::IndicatorDefinition,
    record: &JsObject,
) -> Result<(), JsError> {
    let outputs = array(required(record, "outputs")?)?;
    if outputs.len() != definition.outputs.len()
        || outputs.iter().zip(definition.outputs).any(|(value, expected)| {
            !matches!(value, JsValue::String(value) if text_eq(value, expected))
        })
    {
        return Err(type_error("Workspace output schema/offset binding"));
    }
    let offsets = object(
        required(record, "plotOffsets")?,
        "Workspace: object required",
    )?;
    if offsets.len() != definition.plot_offsets.len() {
        return Err(type_error("Workspace output schema/offset binding"));
    }
    for expected in &definition.plot_offsets {
        if !matches!(offsets.get(&key(expected.output)), Some(JsValue::Number(value)) if same_value(*value, expected.value))
        {
            return Err(type_error("Workspace output schema/offset binding"));
        }
    }
    Ok(())
}

fn workspace_record(
    value: &JsValue,
    allowed: &[&str],
    required_fields: &[&str],
) -> Result<(), JsError> {
    option_record(value, allowed, "Workspace")?;
    let record = object(value, "Workspace: object required")?;
    if required_fields
        .iter()
        .any(|field| record.get(&key(field)).is_none())
    {
        return Err(type_error("Workspace missing field"));
    }
    Ok(())
}

fn state_equal(left: &JsValue, right: &JsValue) -> bool {
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
                    .all(|(left, right)| state_equal(left, right))
        }
        (JsValue::Object(left), JsValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, left)| right.get(key).is_some_and(|right| state_equal(left, right)))
        }
        _ => false,
    }
}

fn required_value<'a>(value: &'a JsValue, field: &str) -> Result<&'a JsValue, JsError> {
    required(object(value, "Workspace: object required")?, field)
}

fn required_object<'a>(
    value: &'a JsObject,
    field: &str,
    message: &str,
) -> Result<&'a JsObject, JsError> {
    object(required(value, field)?, message)
}

fn required<'a>(value: &'a JsObject, field: &str) -> Result<&'a JsValue, JsError> {
    value
        .get(&key(field))
        .ok_or_else(|| type_error("Workspace missing field"))
}

fn object<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

fn object_opt(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
}

fn array(value: &JsValue) -> Result<&[JsValue], JsError> {
    match value {
        JsValue::Array(value) => Ok(value),
        _ => Err(type_error("Workspace array required")),
    }
}

fn string(value: &JsValue) -> Result<&JsString, JsError> {
    match value {
        JsValue::String(value) => Ok(value),
        _ => Err(type_error("Workspace string required")),
    }
}

fn is_falsy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => true,
        JsValue::Bool(value) => !value,
        JsValue::Number(value) => *value == 0.0 || value.is_nan(),
        JsValue::String(value) => value.as_units().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => false,
    }
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

fn object_value<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, child) in entries {
        value.insert(key(name), child);
    }
    JsValue::Object(value)
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
