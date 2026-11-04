//! Portable `aster.studies` 문서의 저장과 additive atomic load다.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::hash::Hash;
use std::mem::size_of;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::checkpoint_codec::{safe_checkpoint_parse_scoped, safe_checkpoint_stringify_scoped};
use crate::contracts::{
    RESOURCE_LIMITS, js_to_string_scoped, option_record, portable_style_scoped,
};
use crate::data::BarStore;
use crate::indicator_engine::IndicatorEngine;
use crate::indicator_helpers::exact_state_equal;
use crate::indicator_modules::{
    ModuleDocumentSurface, pressure_descriptor, resolve_document_module,
};
use crate::indicator_params::validate_indicator_params;
use crate::model_state::{IndicatorProjection, ModelContext, ModelState, Series};

const STUDY_KEYS: &[&str] = &["schema", "version", "indicators", "series"];
const DEFINITION_KEYS: &[&str] = &["id", "name", "params", "module"];
const STYLE_COLORS: &[&str] = &["color", "fill", "upColor", "downColor"];
const STUDY_SERIES_KEYS: &[&str] = &[
    "id",
    "type",
    "panel",
    "source",
    "indicator",
    "output",
    "color",
    "fill",
    "width",
    "baseline",
    "offset",
    "upColor",
    "downColor",
    "visible",
    "axisId",
    "symbolId",
    "label",
];

/// additive load가 게시한 행 수다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StudyLoadReceipt {
    /// 새 indicator 수다.
    pub indicators: usize,
    /// 새 bound series 수다.
    pub series: usize,
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

fn object<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(value) => Ok(value),
        _ => Err(type_error(message)),
    }
}

fn string_value(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

fn name_for_module(value: &JsValue, scope: &mut MemoryScope) -> Result<JsString, JsError> {
    js_to_string_scoped(value, NumberDialect::PLATFORM, scope)
}

fn memory_error(error: barochart_js::memory::MemoryFailure) -> JsError {
    error.into_js_error()
}

fn scoped_vec<T>(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(output)
}

fn scoped_set<T: Eq + Hash>(
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<HashSet<T>, JsError> {
    let requested = capacity
        .checked_mul(size_of::<T>().saturating_add(size_of::<usize>()))
        .and_then(|bytes| bytes.checked_mul(2))
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(requested).map_err(memory_error)?;
    let mut output = HashSet::new();
    output
        .try_reserve(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(output)
}

fn scoped_object<const N: usize>(
    entries: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut owned = scoped_vec(N, scope)?;
    for (name, value) in entries {
        owned.push((
            JsString::try_from_str(name, scope).map_err(memory_error)?,
            value,
        ));
    }
    JsObject::try_from_entries_scoped(owned, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

fn pressure_descriptor_value_scoped(scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let descriptor = pressure_descriptor();
    scoped_object(
        [
            (
                "id",
                JsValue::String(
                    JsString::try_from_str(descriptor.id, scope).map_err(memory_error)?,
                ),
            ),
            ("version", JsValue::Number(descriptor.version as f64)),
            (
                "stateVersion",
                JsValue::Number(descriptor.state_version as f64),
            ),
            (
                "exportName",
                JsValue::String(
                    JsString::try_from_str(descriptor.export_name, scope).map_err(memory_error)?,
                ),
            ),
            ("causal", JsValue::Bool(descriptor.causal)),
        ],
        scope,
    )
}

fn definition_record_scoped(
    id: &JsString,
    name: &JsString,
    params: &JsValue,
    module: Option<JsValue>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut entries = scoped_vec(4, scope)?;
    entries.push((
        JsString::try_from_str("id", scope).map_err(memory_error)?,
        JsValue::String(id.try_clone_scoped(scope).map_err(memory_error)?),
    ));
    entries.push((
        JsString::try_from_str("name", scope).map_err(memory_error)?,
        JsValue::String(name.try_clone_scoped(scope).map_err(memory_error)?),
    ));
    entries.push((
        JsString::try_from_str("params", scope).map_err(memory_error)?,
        params.try_clone_scoped(scope).map_err(memory_error)?,
    ));
    if let Some(module) = module {
        entries.push((
            JsString::try_from_str("module", scope).map_err(memory_error)?,
            module,
        ));
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

/// 현재 fixed registry entry와 indicator-bound series만 portable 문서로 쓴다.
pub fn save_study_setup(engine: &IndicatorEngine, model: &ModelState) -> Result<JsString, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    save_study_setup_scoped(engine, model, &mut scope)
}

/// 현재 fixed registry entry와 indicator-bound series를 caller scope에서 문서로 쓴다.
pub fn save_study_setup_scoped(
    engine: &IndicatorEngine,
    model: &ModelState,
    scope: &mut MemoryScope,
) -> Result<JsString, JsError> {
    let mut indicators = scoped_vec(engine.len(), scope)?;
    for id in engine.entry_ids_iter() {
        let id_value = JsValue::String(id.try_clone_scoped(scope).map_err(memory_error)?);
        let entry = engine
            .entry(&id_value)
            .expect("entry id snapshot is current");
        validate_indicator_params(entry.params())?;
        let module = if entry
            .name()
            .as_units()
            .iter()
            .copied()
            .eq("aster.volume-direction@1/pressure".encode_utf16())
        {
            Some(pressure_descriptor_value_scoped(scope)?)
        } else {
            None
        };
        indicators.push(definition_record_scoped(
            id,
            entry.name(),
            entry.params(),
            module,
            scope,
        )?);
    }

    let mut series = scoped_vec(model.series.len(), scope)?;
    for value in &model.series {
        if value.indicator.is_none() {
            continue;
        }
        let record = value.to_js_value_scoped(scope).map_err(memory_error)?;
        portable_style_scoped(&record, STYLE_COLORS, true, scope)?;
        series.push(record);
    }
    let document = scoped_object(
        [
            (
                "schema",
                JsValue::String(
                    JsString::try_from_str("aster.studies", scope).map_err(memory_error)?,
                ),
            ),
            ("version", JsValue::Number(1.0)),
            ("indicators", JsValue::Array(indicators)),
            ("series", JsValue::Array(series)),
        ],
        scope,
    )?;
    safe_checkpoint_stringify_scoped(&document, NumberDialect::PLATFORM, scope)
}

/// 문서 전체를 계산·binding staging한 뒤 engine과 series를 additive하게 게시한다.
pub fn load_study_setup(
    engine: &mut IndicatorEngine,
    model: &mut ModelState,
    store: &BarStore,
    host: &dyn Host,
    text: &JsValue,
    owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
) -> Result<StudyLoadReceipt, JsError> {
    let mut scope = store.memory_context().scope();
    load_study_setup_scoped(engine, model, store, host, text, owner_guard, &mut scope)
}

/// 문서 전체를 caller scope에서 계산·binding staging한 뒤 additive하게 게시한다.
pub fn load_study_setup_scoped(
    engine: &mut IndicatorEngine,
    model: &mut ModelState,
    store: &BarStore,
    host: &dyn Host,
    text: &JsValue,
    mut owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
    scope: &mut MemoryScope,
) -> Result<StudyLoadReceipt, JsError> {
    let document = safe_checkpoint_parse_scoped(text, NumberDialect::PLATFORM, scope)?;
    option_record(&document, STUDY_KEYS, "Study setup")?;
    let document = object(&document, "Study setup: object required")?;
    let indicators_key = JsString::try_from_str("indicators", scope).map_err(memory_error)?;
    let series_key = JsString::try_from_str("series", scope).map_err(memory_error)?;
    let schema_key = JsString::try_from_str("schema", scope).map_err(memory_error)?;
    let version_key = JsString::try_from_str("version", scope).map_err(memory_error)?;
    let indicators = document.get(&indicators_key);
    let series = document.get(&series_key);
    let schema_valid = matches!(document.get(&schema_key), Some(JsValue::String(value)) if value.as_units().iter().copied().eq("aster.studies".encode_utf16()));
    let version_valid = matches!(document.get(&version_key), Some(JsValue::Number(1.0)));
    let (Some(JsValue::Array(indicators)), Some(JsValue::Array(series))) = (indicators, series)
    else {
        return Err(type_error("Study setup schema/count"));
    };
    if !schema_valid
        || !version_valid
        || indicators.len() > RESOURCE_LIMITS.max_indicators as usize
        || series.len() > RESOURCE_LIMITS.max_series as usize
    {
        return Err(type_error("Study setup schema/count"));
    }
    if engine.len() + indicators.len() > RESOURCE_LIMITS.max_indicators as usize
        || model.series.len() + series.len() > RESOURCE_LIMITS.max_series as usize
    {
        return Err(range_error("Study setup capacity"));
    }

    let model_snapshot = ModelConfigurationSnapshot::capture(model, scope)?;
    let mut stage = engine.begin_stage(store);
    stage.mark_studies();
    let mut imported = scoped_set(indicators.len(), scope)?;
    let id_key = JsString::try_from_str("id", scope).map_err(memory_error)?;
    let name_key = JsString::try_from_str("name", scope).map_err(memory_error)?;
    let params_key = JsString::try_from_str("params", scope).map_err(memory_error)?;
    let module_key = JsString::try_from_str("module", scope).map_err(memory_error)?;
    for definition in indicators {
        option_record(definition, DEFINITION_KEYS, "Study definition")?;
        let definition = object(definition, "Study definition: object required")?;
        let undefined = JsValue::Undefined;
        let id = definition.get(&id_key).unwrap_or(&undefined);
        let name = definition.get(&name_key).unwrap_or(&undefined);
        let params = definition.get(&params_key).unwrap_or(&undefined);
        validate_indicator_params(params)?;
        if string_value(id).is_some_and(|id| imported.contains(id)) || engine.entry(id).is_some() {
            return Err(ordinary_error("Duplicate study id"));
        }
        if let Some(id) = string_value(id) {
            imported.insert(id.try_clone_scoped(scope).map_err(memory_error)?);
        }
        let descriptor = definition.get(&module_key);
        let module_name = name_for_module(name, scope)?;
        resolve_document_module(&module_name, descriptor, ModuleDocumentSurface::Studies)?;
        engine.stage_add_scoped(&mut stage, store, host, id, name, params, scope)?;
    }

    let mut projections = scoped_vec(indicators.len(), scope)?;
    projections.extend(stage.candidates().map(|candidate| IndicatorProjection {
        id: candidate.id,
        definition: candidate.definition,
    }));
    let context = ModelContext {
        store,
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    let mut series_ids = scoped_set(model.series.len().saturating_add(series.len()), scope)?;
    for existing in &model.series {
        series_ids.insert(existing.id.try_clone_scoped(scope).map_err(memory_error)?);
    }
    let mut added = scoped_vec::<Series>(series.len(), scope)?;
    let indicator_key = JsString::try_from_str("indicator", scope).map_err(memory_error)?;
    for value in series {
        option_record(value, STUDY_SERIES_KEYS, "Study series")?;
        let record = object(value, "Study series: object required")?;
        let indicator = record.get(&indicator_key);
        if !matches!(indicator, Some(JsValue::String(id)) if imported.contains(id)) {
            return Err(ordinary_error(
                "Study series requires an imported indicator",
            ));
        }
        if matches!(record.get(&id_key), Some(JsValue::String(id)) if series_ids.contains(id)) {
            return Err(ordinary_error("Duplicate study series id"));
        }
        let portable = portable_style_scoped(value, STYLE_COLORS, true, scope)?;
        let normalized = model.normalized_series_scoped(&portable, &context, scope)?;
        if !series_ids.insert(
            normalized
                .id
                .try_clone_scoped(scope)
                .map_err(memory_error)?,
        ) {
            return Err(ordinary_error("Duplicate study series id"));
        }
        added.push(normalized);
    }

    let prepared = model.prepare_series_append(added.len())?;
    if !model_snapshot.matches(model, scope)? {
        return Err(ordinary_error(
            "Study setup stale: owner changed during staging",
        ));
    }
    if let Some(guard) = owner_guard.as_mut() {
        (*guard)()?;
    }
    if !model_snapshot.matches(model, scope)? {
        return Err(ordinary_error(
            "Study setup stale: owner changed during staging",
        ));
    }
    let indicator_count = stage.receipts().filter(|receipt| receipt.changed).count();
    engine.publish_stage(store, stage)?;
    let series_count = added.len();
    if let Some(prepared) = prepared {
        model.publish_series_append(prepared, added);
    }
    Ok(StudyLoadReceipt {
        indicators: indicator_count,
        series: series_count,
    })
}

struct ModelConfigurationSnapshot {
    series: Vec<usize>,
    value: JsValue,
}

impl ModelConfigurationSnapshot {
    fn capture(model: &ModelState, scope: &mut MemoryScope) -> Result<Self, JsError> {
        let mut series = scoped_vec(model.series.len(), scope)?;
        series.extend(
            model
                .series
                .iter()
                .map(|series| series as *const _ as usize),
        );
        Ok(Self {
            series,
            value: configuration_value(model, scope)?,
        })
    }

    fn matches(&self, model: &ModelState, scope: &mut MemoryScope) -> Result<bool, JsError> {
        if self.series.len() != model.series.len()
            || !self
                .series
                .iter()
                .zip(&model.series)
                .all(|(identity, series)| *identity == series as *const _ as usize)
        {
            return Ok(false);
        }
        Ok(exact_state_equal(
            &self.value,
            &configuration_value(model, scope)?,
        ))
    }
}

fn configuration_value(model: &ModelState, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let mut series = scoped_vec(model.series.len(), scope)?;
    for value in &model.series {
        series.push(value.to_js_value_scoped(scope).map_err(memory_error)?);
    }
    let mut panels = scoped_vec(model.panels.len(), scope)?;
    for value in &model.panels {
        panels.push(value.to_js_value_scoped(scope).map_err(memory_error)?);
    }
    let mut axes = scoped_vec(model.axes.len(), scope)?;
    for value in &model.axes {
        axes.push(value.to_js_value_scoped(scope).map_err(memory_error)?);
    }
    scoped_object(
        [
            ("series", JsValue::Array(series)),
            ("panels", JsValue::Array(panels)),
            ("axes", JsValue::Array(axes)),
            (
                "valuesRevision",
                model
                    .series_values_revision()
                    .map_or(JsValue::Number(0.0), JsValue::Number),
            ),
        ],
        scope,
    )
}
