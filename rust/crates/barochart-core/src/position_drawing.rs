//! 포지션 주석 앵커와 버전 드로잉 문서의 순수 계약이다.

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryScope, OomStyle};
use barochart_js::string::JsString;

use crate::drawing_types::{Drawing, DrawingPoint, DrawingType};

/// 불변 드로잉의 원시 가격 앵커에서 지표를 계산한다.
pub fn position_metrics_for(drawing: &Drawing) -> Result<PositionMetrics, JsError> {
    position_metrics_for_parts(drawing.kind, &drawing.points)
}

/// 앵커 네 개로 구성된 포지션 드로잉을 검증한 순수 결과다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PositionMetrics {
    /// 롱 또는 숏 방향이다.
    pub direction: &'static str,
    /// 공유 진입·시작 시각이다.
    pub start_time: f64,
    /// 양수 시간 범위의 끝이다.
    pub end_time: f64,
    /// 진입 가격이다.
    pub entry: f64,
    /// 손절 가격이다.
    pub stop: f64,
    /// 목표 가격이다.
    pub target: f64,
    /// 양수 원시 가격 위험이다.
    pub risk: f64,
    /// 양수 원시 가격 보상이다.
    pub reward: f64,
    /// 절대 진입 가격 기준 비율이다. 유한하지 않으면 null이다.
    pub risk_percent: Option<f64>,
    /// 절대 진입 가격 기준 비율이다. 유한하지 않으면 null이다.
    pub reward_percent: Option<f64>,
    /// 양수 보상/위험 비율이다.
    pub ratio: f64,
}

/// 드로잉 종류가 포지션 앵커 네 개를 사용하는지 반환한다.
pub fn is_position_drawing(kind: DrawingType) -> bool {
    kind.is_position()
}

/// 현재 드로잉 레코드에 필요한 최소 문서 버전을 반환한다.
pub fn drawing_document_version(drawings: &[Arc<Drawing>]) -> u8 {
    if drawings.iter().any(|drawing| drawing.visible.is_some()) {
        4
    } else if drawings.iter().any(|drawing| drawing.kind.is_position()) {
        3
    } else if drawings
        .iter()
        .any(|drawing| drawing.axis_id.is_some() || drawing.series_id.is_some())
    {
        2
    } else {
        1
    }
}

/// 드로잉의 기능을 문서 버전에서 표현할 수 있는지 확인한다.
pub fn validate_drawing_document_version(drawing: &Drawing, version: f64) -> Result<(), JsError> {
    if drawing.visible.is_some() && version < 4.0 {
        return Err(type_error("Drawing visibility requires document version 4"));
    }
    if drawing.kind.is_position() && version < 3.0 {
        return Err(type_error("Position drawings require document version 3"));
    }
    if version == 1.0 && (drawing.axis_id.is_some() || drawing.series_id.is_some()) {
        return Err(type_error("Bound drawings require document version 2"));
    }
    Ok(())
}

/// 종류와 검증된 앵커 슬라이스에서 지표를 계산한다.
pub fn position_metrics_for_parts(
    kind: DrawingType,
    points: &[DrawingPoint],
) -> Result<PositionMetrics, JsError> {
    let Some([entry, stop, target, extent]) = <&[DrawingPoint; 4]>::try_from(points).ok() else {
        return Err(type_error("Drawing anchors"));
    };
    let direction = if kind == DrawingType::LongPosition {
        "long"
    } else if kind == DrawingType::ShortPosition {
        "short"
    } else {
        return Err(type_error("Position drawing required"));
    };
    let sign = if direction == "long" { 1.0 } else { -1.0 };
    let risk = (entry.price - stop.price) * sign;
    let reward = (target.price - entry.price) * sign;
    let ratio = reward / risk;

    if stop.time != entry.time
        || target.time != entry.time
        || extent.price != entry.price
        || extent.time.partial_cmp(&entry.time) != Some(std::cmp::Ordering::Greater)
    {
        return Err(range_error(
            "Position anchors require shared start/entry and positive time extent",
        ));
    }
    if !(risk > 0.0 && reward > 0.0 && ratio > 0.0)
        || !risk.is_finite()
        || !reward.is_finite()
        || !ratio.is_finite()
    {
        return Err(range_error(
            "Position requires ordered entry/stop/target and finite positive risk, reward and ratio",
        ));
    }

    let percentage = |value: f64| {
        let result = value / entry.price.abs() * 100.0;
        result.is_finite().then_some(result)
    };

    Ok(PositionMetrics {
        direction,
        start_time: entry.time,
        end_time: extent.time,
        entry: entry.price,
        stop: stop.price,
        target: target.price,
        risk,
        reward,
        risk_percent: percentage(risk),
        reward_percent: percentage(reward),
        ratio,
    })
}

impl PositionMetrics {
    /// 브리지 공개 결과 순서로 지표를 caller scope에서 fallible 직렬화한다.
    pub fn to_value_scoped(self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let entries = [
            (
                JsString::try_from_str("direction", scope).map_err(memory_error)?,
                JsValue::String(
                    JsString::try_from_str(self.direction, scope).map_err(memory_error)?,
                ),
            ),
            (
                JsString::try_from_str("startTime", scope).map_err(memory_error)?,
                JsValue::Number(self.start_time),
            ),
            (
                JsString::try_from_str("endTime", scope).map_err(memory_error)?,
                JsValue::Number(self.end_time),
            ),
            (
                JsString::try_from_str("entry", scope).map_err(memory_error)?,
                JsValue::Number(self.entry),
            ),
            (
                JsString::try_from_str("stop", scope).map_err(memory_error)?,
                JsValue::Number(self.stop),
            ),
            (
                JsString::try_from_str("target", scope).map_err(memory_error)?,
                JsValue::Number(self.target),
            ),
            (
                JsString::try_from_str("risk", scope).map_err(memory_error)?,
                JsValue::Number(self.risk),
            ),
            (
                JsString::try_from_str("reward", scope).map_err(memory_error)?,
                JsValue::Number(self.reward),
            ),
            (
                JsString::try_from_str("riskPercent", scope).map_err(memory_error)?,
                self.risk_percent.map_or(JsValue::Null, JsValue::Number),
            ),
            (
                JsString::try_from_str("rewardPercent", scope).map_err(memory_error)?,
                self.reward_percent.map_or(JsValue::Null, JsValue::Number),
            ),
            (
                JsString::try_from_str("ratio", scope).map_err(memory_error)?,
                JsValue::Number(self.ratio),
            ),
        ];
        JsObject::try_from_entries_scoped(entries, scope)
            .map(JsValue::Object)
            .map_err(memory_error)
    }

    /// 기존 테스트와 비회계 도구가 쓰는 지표 직렬화 wrapper다.
    pub fn to_value(self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_value_scoped(&mut scope)
            .expect("unaccounted position metrics serialization")
    }
}

fn memory_error(failure: barochart_js::memory::MemoryFailure) -> JsError {
    failure.into_js_error()
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
