//! Portable `aster.studies` 문서의 저장과 additive atomic load다.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::Host;
use crate::checkpoint_codec::{safe_checkpoint_parse, safe_checkpoint_stringify};
use crate::contracts::{
    RESOURCE_LIMITS, SERIES_KEYS, js_to_string_with, option_record, portable_style,
};
use crate::data::BarStore;
use crate::indicator_engine::IndicatorEngine;
use crate::indicator_modules::{
    ModuleDocumentSurface, pressure_descriptor_value, resolve_document_module,
};
use crate::indicator_params::validate_indicator_params;
use crate::indicator_params_update::ModelConfigurationSnapshot;
use crate::model_state::{IndicatorProjection, ModelContext, ModelState, Series};

const STUDY_KEYS: &[&str] = &["schema", "version", "indicators", "series"];
const DEFINITION_KEYS: &[&str] = &["id", "name", "params", "module"];
const STYLE_COLORS: &[&str] = &["color", "fill", "upColor", "downColor"];

/// additive load가 게시한 행 수다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StudyLoadReceipt {
    /// 새 indicator 수다.
    pub indicators: usize,
    /// 새 bound series 수다.
    pub series: usize,
}

fn key(name: &str) -> JsString {
    JsString::from_str(name)
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

fn name_for_module(value: &JsValue) -> Result<JsString, JsError> {
    match value {
        JsValue::String(value) => Ok(value.clone()),
        value => js_to_string_with(value, NumberDialect::PLATFORM),
    }
}

fn definition_record(
    id: &JsString,
    name: &JsString,
    params: &JsValue,
    module: Option<JsValue>,
) -> JsValue {
    let mut record = JsObject::new();
    record.insert(key("id"), JsValue::String(id.clone()));
    record.insert(key("name"), JsValue::String(name.clone()));
    record.insert(key("params"), params.clone());
    if let Some(module) = module {
        record.insert(key("module"), module);
    }
    JsValue::Object(record)
}

/// 현재 fixed registry entry와 indicator-bound series만 portable 문서로 쓴다.
pub fn save_study_setup(engine: &IndicatorEngine, model: &ModelState) -> Result<JsString, JsError> {
    let mut indicators = Vec::with_capacity(engine.len());
    for id in engine.entry_ids() {
        let id_value = JsValue::String(id.clone());
        let entry = engine
            .entry(&id_value)
            .expect("entry id snapshot is current");
        validate_indicator_params(entry.params())?;
        let module = if entry.name() == &JsString::from_str("aster.volume-direction@1/pressure") {
            Some(pressure_descriptor_value())
        } else {
            None
        };
        indicators.push(definition_record(&id, entry.name(), entry.params(), module));
    }

    let mut series = Vec::new();
    for value in &model.series {
        if value.indicator.is_none() {
            continue;
        }
        let record = value.to_js_value();
        portable_style(&record, STYLE_COLORS, true)?;
        series.push(record);
    }
    let mut document = JsObject::new();
    document.insert(
        key("schema"),
        JsValue::String(JsString::from_str("aster.studies")),
    );
    document.insert(key("version"), JsValue::Number(1.0));
    document.insert(key("indicators"), JsValue::Array(indicators));
    document.insert(key("series"), JsValue::Array(series));
    safe_checkpoint_stringify(&JsValue::Object(document))
}

/// 문서 전체를 계산·binding staging한 뒤 engine과 series를 additive하게 게시한다.
pub fn load_study_setup(
    engine: &mut IndicatorEngine,
    model: &mut ModelState,
    store: &BarStore,
    host: &dyn Host,
    text: &JsValue,
    mut owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
) -> Result<StudyLoadReceipt, JsError> {
    let document = safe_checkpoint_parse(text)?;
    option_record(&document, STUDY_KEYS, "Study setup")?;
    let document = object(&document, "Study setup: object required")?;
    let indicators = document.get(&key("indicators"));
    let series = document.get(&key("series"));
    let schema_valid = matches!(document.get(&key("schema")), Some(JsValue::String(value)) if value == &JsString::from_str("aster.studies"));
    let version_valid = matches!(document.get(&key("version")), Some(JsValue::Number(1.0)));
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

    let model_snapshot = ModelConfigurationSnapshot::capture(model);
    let mut stage = engine.begin_stage(store);
    stage.mark_studies();
    let mut imported = HashSet::with_capacity(indicators.len());
    for definition in indicators {
        option_record(definition, DEFINITION_KEYS, "Study definition")?;
        let definition = object(definition, "Study definition: object required")?;
        let undefined = JsValue::Undefined;
        let id = definition.get(&key("id")).unwrap_or(&undefined);
        let name = definition.get(&key("name")).unwrap_or(&undefined);
        let params = definition.get(&key("params")).unwrap_or(&undefined);
        validate_indicator_params(params)?;
        if string_value(id).is_some_and(|id| imported.contains(id)) || engine.entry(id).is_some() {
            return Err(ordinary_error("Duplicate study id"));
        }
        if let Some(id) = string_value(id) {
            imported.insert(id.clone());
        }
        let descriptor = definition.get(&key("module"));
        let module_name = name_for_module(name)?;
        resolve_document_module(&module_name, descriptor, ModuleDocumentSurface::Studies)?;
        engine.stage_add(&mut stage, store, host, id, name, params)?;
    }

    let projections = stage
        .candidates()
        .map(|candidate| IndicatorProjection {
            id: candidate.id,
            definition: candidate.definition,
        })
        .collect::<Vec<_>>();
    let context = ModelContext {
        store,
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    let mut series_ids = model
        .series
        .iter()
        .map(|series| series.id.clone())
        .collect::<HashSet<_>>();
    let mut added = Vec::<Series>::with_capacity(series.len());
    let allowed = SERIES_KEYS
        .iter()
        .copied()
        .filter(|field| *field != "values")
        .collect::<Vec<_>>();
    for value in series {
        option_record(value, &allowed, "Study series")?;
        let record = object(value, "Study series: object required")?;
        let indicator = record.get(&key("indicator"));
        if !matches!(indicator, Some(JsValue::String(id)) if imported.contains(id)) {
            return Err(ordinary_error(
                "Study series requires an imported indicator",
            ));
        }
        if matches!(record.get(&key("id")), Some(JsValue::String(id)) if series_ids.contains(id)) {
            return Err(ordinary_error("Duplicate study series id"));
        }
        let portable = portable_style(value, STYLE_COLORS, true)?;
        let normalized = model.normalized_series(&portable, &context)?;
        if !series_ids.insert(normalized.id.clone()) {
            return Err(ordinary_error("Duplicate study series id"));
        }
        added.push(normalized);
    }

    if !model_snapshot.matches(model) {
        return Err(ordinary_error(
            "Study setup stale: owner changed during staging",
        ));
    }
    if let Some(guard) = owner_guard.as_mut() {
        (*guard)()?;
    }
    let indicator_count = stage.receipts().filter(|receipt| receipt.changed).count();
    engine.publish_stage(store, stage)?;
    let series_count = added.len();
    let mut published = Vec::with_capacity(model.series.len() + added.len());
    published.append(&mut model.series);
    published.extend(added);
    model.series = published;
    Ok(StudyLoadReceipt {
        indicators: indicator_count,
        series: series_count,
    })
}
