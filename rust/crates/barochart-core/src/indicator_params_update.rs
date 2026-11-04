//! 실제 IndicatorEngine entry를 cold staging한 뒤 동기 params 교체를 원자 게시한다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

use crate::Host;
use crate::data::BarStore;
use crate::indicator_engine::{IndicatorEngine, IndicatorPublishReceipt};
use crate::indicator_helpers::exact_state_equal;
use crate::indicator_params::validate_indicator_params;
use crate::model_state::ModelState;

/// 동기 params 게시와 후속 async params 경로가 공유하는 typed 영수증이다.
pub type IndicatorParamsReceipt = IndicatorPublishReceipt;

pub(crate) struct ModelConfigurationSnapshot {
    series: Vec<usize>,
    value: JsValue,
}

impl ModelConfigurationSnapshot {
    pub(crate) fn capture(model: &ModelState) -> Self {
        Self {
            series: model
                .series
                .iter()
                .map(|series| series as *const _ as usize)
                .collect(),
            value: configuration_value(model),
        }
    }

    pub(crate) fn matches(&self, model: &ModelState) -> bool {
        self.series.len() == model.series.len()
            && self
                .series
                .iter()
                .zip(&model.series)
                .all(|(identity, series)| *identity == series as *const _ as usize)
            && exact_state_equal(&self.value, &configuration_value(model))
    }
}

fn configuration_value(model: &ModelState) -> JsValue {
    let mut value = JsObject::new();
    value.insert(
        JsString::from_str("series"),
        JsValue::Array(
            model
                .series
                .iter()
                .map(|series| series.to_js_value())
                .collect(),
        ),
    );
    value.insert(
        JsString::from_str("panels"),
        JsValue::Array(
            model
                .panels
                .iter()
                .map(|panel| panel.to_js_value())
                .collect(),
        ),
    );
    value.insert(
        JsString::from_str("axes"),
        JsValue::Array(model.axes.iter().map(|axis| axis.to_js_value()).collect()),
    );
    value.insert(
        JsString::from_str("valuesRevision"),
        model
            .series_values_revision()
            .map_or(JsValue::Number(0.0), JsValue::Number),
    );
    JsValue::Object(value)
}

fn stale(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

/// factory 검증·cold 계산·owner guard를 모두 통과한 뒤 같은 위치의 entry만 교체한다.
///
/// same-params 요청도 metadata와 owner guard를 확인하지만 entry와 bound-series cache는 바꾸지 않는다.
pub fn set_indicator_params(
    engine: &mut IndicatorEngine,
    model: &mut ModelState,
    store: &BarStore,
    host: &dyn Host,
    id: &JsValue,
    params: &JsValue,
    mut owner_guard: Option<&mut dyn FnMut() -> Result<(), JsError>>,
) -> Result<IndicatorParamsReceipt, JsError> {
    let requested = validate_indicator_params(params)?.to_js_value();
    validate_indicator_params(&requested)?;
    if engine.entry(id).is_none() {
        return Err(stale("Missing indicator"));
    }
    let model_snapshot = ModelConfigurationSnapshot::capture(model);
    let mut stage = engine.begin_stage(store);
    let receipt = engine.stage_replace(&mut stage, store, host, id, &requested)?;
    let phase = if receipt.changed {
        "Indicator params stale: owner changed during staging"
    } else {
        "Indicator params stale: owner changed during metadata"
    };
    if !model_snapshot.matches(model) {
        return Err(stale(phase));
    }
    if let Some(guard) = owner_guard.as_mut() {
        (*guard)()?;
    }
    let mut published = engine.publish_stage(store, stage)?;
    let published = published.pop().expect("one params staging receipt");
    if published.changed {
        let Some(id) = id_string(id) else {
            unreachable!("a staged replacement has a string id")
        };
        for series in &mut model.series {
            if series.indicator.as_ref() == Some(id) {
                series.range_index_ready = false;
                series.revision = None;
                series.dirty_from = 0.0;
            }
        }
    }
    Ok(published)
}

fn id_string(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}
