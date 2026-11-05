//! WASM 웹 actor의 복합 layout capture와 원자 적용을 연결한다.

#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_core::native_chart::NativeInteractionContext;
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;

use crate::reply_policy::FixedReply;

static UNDEFINED: JsValue = JsValue::Undefined;

fn argument(args: &[JsValue], index: usize) -> &JsValue {
    args.get(index).unwrap_or(&UNDEFINED)
}

fn reference() -> JsError {
    JsError::new(
        "ReferenceError",
        JsString::from_str("nativeModel is not defined"),
    )
}

fn target_field(value: Option<&JsValue>, name: &str) -> Option<JsString> {
    let JsValue::Object(record) = value? else {
        return None;
    };
    match record.get(&JsString::from_str(name)) {
        Some(JsValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn drawing_series(
    chart: &barochart_core::native_chart::NativeChart,
    scope: &mut MemoryScope,
) -> Result<Vec<(JsString, JsString, Option<JsString>)>, JsError> {
    let drawings = chart.drawings();
    let count = drawings
        .items()
        .iter()
        .chain(drawings.undo_stack().iter().flat_map(|frame| frame.iter()))
        .chain(drawings.redo_stack().iter().flat_map(|frame| frame.iter()))
        .chain(
            drawings
                .transaction()
                .into_iter()
                .flat_map(|frame| frame.iter()),
        )
        .filter(|drawing| drawing.series_id.is_some())
        .count();
    scope
        .try_grow(
            count.saturating_mul(std::mem::size_of::<(JsString, JsString, Option<JsString>)>()),
        )
        .map_err(|failure| failure.into_js_error())?;
    let mut result = Vec::new();
    result
        .try_reserve_exact(count)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for drawing in drawings
        .items()
        .iter()
        .chain(drawings.undo_stack().iter().flat_map(|frame| frame.iter()))
        .chain(drawings.redo_stack().iter().flat_map(|frame| frame.iter()))
        .chain(
            drawings
                .transaction()
                .into_iter()
                .flat_map(|frame| frame.iter()),
        )
    {
        let Some(series_id) = &drawing.series_id else {
            continue;
        };
        result.push((
            series_id
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            drawing
                .panel
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?,
            drawing
                .axis_id
                .as_ref()
                .map(|axis| axis.try_clone_scoped(scope))
                .transpose()
                .map_err(|failure| failure.into_js_error())?,
        ));
    }
    Ok(result)
}

/// `web.layoutCapture`와 `web.applyLayoutFrame`을 실제 chart/controller에 분기한다.
pub(crate) fn call(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    if name == "web.layoutCapture" {
        let chart = engine.chart().ok_or_else(reference)?;
        return barochart_core::web_layout::capture_layout_frame(
            chart.model(),
            argument(args, 0),
            argument(args, 1),
            scope,
        );
    }
    if name != "web.applyLayoutFrame" {
        return Err(JsError::new(
            "UnavailableError",
            JsString::from_str("Unknown web layout operation"),
        ));
    }
    let (chart, input, _, _, _) = engine.command_parts_mut().ok_or_else(reference)?;
    let drawing_series = drawing_series(chart, scope)?;
    let target = input.drawing_target();
    let target_panel = target_field(target, "panel");
    let target_axis = target_field(target, "axisId");
    let interaction = NativeInteractionContext {
        gesture_active: input.gesture_kind().is_some(),
        pointer_count: input.pointer_count(),
        target_panel: target_panel.as_ref(),
        target_axis: target_axis.as_ref(),
    };
    chart.with_model_context(interaction, |model, context| {
        barochart_core::web_layout::apply_layout_frame(
            model,
            argument(args, 0),
            context,
            &drawing_series,
            scope,
            &mut |_| admit_reply(FixedReply::Undefined),
        )
    })?;
    Ok(JsValue::Undefined)
}

#[cfg(test)]
mod tests {
    use super::call as web_call;
    use crate::call as bridge_call;
    use crate::reply_policy::FixedReply;
    use barochart_core::indicator_helpers::exact_state_equal;
    use barochart_core::{Engine, Host, HostError};
    use barochart_js::json::JsValue;
    use barochart_js::string::JsString;

    struct EmptyHost;
    impl Host for EmptyHost {
        fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
            Err(HostError)
        }
        fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
            Err(HostError)
        }
        fn log(&self, _: i32, _: &str) {}
    }

    fn field_mut<'a>(value: &'a mut JsValue, name: &str) -> &'a mut JsValue {
        let JsValue::Object(record) = value else {
            panic!("object required")
        };
        record
            .get_mut(&JsString::from_str(name))
            .unwrap_or_else(|| panic!("missing {name}"))
    }

    #[test]
    fn denied_fixed_reply_admission_precedes_layout_publication() {
        let mut engine = Engine::new(Box::new(EmptyHost));
        bridge_call(
            &mut engine,
            "nativeInit",
            &[JsValue::Number(0.0), JsValue::Null],
        )
        .unwrap();
        let memory = engine.memory_context().clone();
        let mut capture_scope = memory.scope();
        let mut frame = web_call(
            &mut engine,
            "web.layoutCapture",
            &[JsValue::Array(Vec::new()), JsValue::Array(Vec::new())],
            &mut capture_scope,
            &mut |_| Ok(()),
        )
        .unwrap();
        let JsValue::Array(panels) = field_mut(field_mut(&mut frame, "target"), "panels") else {
            panic!("panels array")
        };
        *field_mut(&mut panels[0], "weight") = JsValue::Number(2.0);
        let before = engine.chart().unwrap().model().snapshot();
        let mut apply_scope = memory.scope();
        let mut admitted = None;
        let error = web_call(
            &mut engine,
            "web.applyLayoutFrame",
            &[frame],
            &mut apply_scope,
            &mut |reply| {
                admitted = Some(reply);
                Err(memory.allocation_failure().into_js_error())
            },
        )
        .unwrap_err();
        assert_eq!(admitted, Some(FixedReply::Undefined));
        assert!(barochart_js::memory::oom_style_from_error(&error).is_some());
        assert!(exact_state_equal(
            &before,
            &engine.chart().unwrap().model().snapshot()
        ));
    }
}
