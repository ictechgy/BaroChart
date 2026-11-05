//! typed bulk staging을 실제 store와 derived owner에 한 번만 게시한다.

use barochart_core::Engine;
use barochart_core::data::{ColumnInputs, Columns, NumericColumn};
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::string::JsString;

use super::bulk::{BulkCall, BulkDecode, BulkLength, BulkRoute};
use super::data_handlers::{missing_native_api, missing_store};
use super::reply_policy::FixedReply;

/// 전체 문법 검사가 끝난 bulk 호출을 receiver gate 뒤 실제 owner에 commit한다.
///
/// 이 함수에 전달된 호출은 일반 JSON dispatch로 재시도하지 않는다. 호출자는 staging의
/// memory scope를 반환 시점까지 유지해야 한다.
pub fn call_bulk(engine: &mut Engine, decoded: BulkDecode) -> Result<JsValue, JsError> {
    call_bulk_with_reply_admission(engine, decoded, &mut |_| Ok(()))
}

/// Typed bulk validation/staging 뒤 fixed reply를 확보하고 store/derived owner를 게시한다.
pub fn call_bulk_with_reply_admission(
    engine: &mut Engine,
    decoded: BulkDecode,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    let route = match &decoded {
        BulkDecode::DeferredError { route, .. }
        | BulkDecode::Call(BulkCall::SetData { route, .. }) => *route,
        BulkDecode::Call(BulkCall::SetColumns { .. }) => BulkRoute::CommandSetColumns,
    };
    let chart = engine.chart_mut().ok_or_else(|| match route {
        BulkRoute::LegacySetData => missing_store(),
        _ => missing_native_api(),
    })?;
    let call = match decoded {
        BulkDecode::DeferredError { error, .. } => return Err(error),
        BulkDecode::Call(call) => call,
    };
    let (columns, length, is_set_data) = match call {
        BulkCall::SetData { columns, .. } => {
            let length = columns.time.len();
            (columns, Some(length), true)
        }
        BulkCall::SetColumns { columns, length } => {
            let max_bars = chart.data().store().max_bars();
            let length = match length {
                BulkLength::Missing => None,
                BulkLength::Number(value)
                    if value.is_finite()
                        && value.fract() == 0.0
                        && value >= 0.0
                        && value <= max_bars as f64 =>
                {
                    Some(value as usize)
                }
                BulkLength::Number(_) => {
                    return Err(JsError::new(
                        "RangeError",
                        JsString::from_str(&format!("Bar count: limit {max_bars}")),
                    ));
                }
            };
            (columns, length, false)
        }
    };
    let mut publication = None;
    let mut explicit_fit = None;
    let mut committed = {
        let (model, store) = chart.fixed_reply_data_parts();
        store.set_columns_with_reply_gate(&inputs(&columns), length, &mut || {
            publication = Some(model.prepare_store_change_publication());
            if route == BulkRoute::LegacySetData {
                explicit_fit = Some(model.prepare_store_change_publication());
            }
            admit_reply(if route == BulkRoute::LegacySetData {
                FixedReply::Undefined
            } else {
                FixedReply::Null
            })
        })?
    };
    if is_set_data && let Some(change) = &mut committed.change {
        change.added_present = false;
    }
    chart.commit_data_change_with_publication(committed, publication);
    if route == BulkRoute::LegacySetData {
        let fit = chart.model().prepare_fit_with_store_publication(
            chart.data().store(),
            explicit_fit.expect("legacy setData publishes a reset"),
        );
        chart.model_mut().publish_prepared_view(fit);
        Ok(JsValue::Undefined)
    } else {
        Ok(JsValue::Null)
    }
}

fn inputs(columns: &Columns) -> ColumnInputs<'_> {
    ColumnInputs {
        time: NumericColumn::F64(&columns.time),
        open: NumericColumn::F64(&columns.open),
        high: NumericColumn::F64(&columns.high),
        low: NumericColumn::F64(&columns.low),
        close: NumericColumn::F64(&columns.close),
        volume: NumericColumn::F64(&columns.volume),
    }
}
