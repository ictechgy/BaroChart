//! 기존 native controller 호출을 단일 Engine의 입력 소유자에 전달한다.
use super::chart_handlers::truthy;
use crate::reply_policy::FixedReply;
use barochart_core::Engine;
use barochart_core::interaction::InteractionKeyModifiers;
use barochart_core::interaction::PreparedInteraction;
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json_scoped};
use barochart_js::memory::{MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
static UNDEFINED: JsValue = JsValue::Undefined;
fn arg(args: &[JsValue], i: usize) -> &JsValue {
    args.get(i).unwrap_or(&UNDEFINED)
}
fn number(value: &JsValue) -> f64 {
    match value {
        JsValue::Number(value) => *value,
        _ => f64::NAN,
    }
}
fn text_is(value: &JsValue, s: &str) -> bool {
    matches!(value,JsValue::String(value) if value.as_units().iter().copied().eq(s.encode_utf16()))
}
fn reference(name: &str) -> JsError {
    #[cfg(target_os = "android")]
    let message = format!("'{name}' is not defined");
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let message = format!("Can't find variable: {name}");
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let message = format!("{name} is not defined");
    JsError::new("ReferenceError", JsString::from_str(&message))
}
pub(crate) fn pointer(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    pointer_with_reply_admission(engine, args, &mut |_| Ok(()))
}

fn pointer_with_reply_admission(
    engine: &mut Engine,
    args: &[JsValue],
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    if !["down", "move", "up", "cancel"]
        .iter()
        .any(|name| text_is(arg(args, 0), name))
    {
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Pointer operation"),
        ));
    }
    if text_is(arg(args, 0), "down") {
        let tolerance = if matches!(arg(args, 4), JsValue::Undefined) {
            8.0
        } else {
            number(arg(args, 4))
        };
        if !tolerance.is_finite() || !(1.0..=32.0).contains(&tolerance) {
            let error = JsError::new(
                "RangeError",
                JsString::from_str("Pointer hit tolerance must be 1..32 logical pixels"),
            );
            return engine.with_interaction(|input, context| {
                input.cancel(context, true, false)?;
                Err(error)
            });
        }
    }
    // Pointer는 source 내부에서 pointer/drawing/view 효과와 이후 layout 오류가 섞인다.
    // Known error cleanup 뒤, 성공 가능 호출은 실제 reply를 먼저 소유하고 나머지 source 순서를 보존한다.
    engine.with_interaction(|input, context| {
        admit_reply(FixedReply::Undefined)?;
        let result = if text_is(arg(args, 0), "cancel") {
            input.cancel(context, true, false)
        } else if text_is(arg(args, 0), "down") {
            let tolerance = if matches!(arg(args, 4), JsValue::Undefined) {
                8.0
            } else {
                number(arg(args, 4))
            };
            input.down(
                context,
                arg(args, 1),
                number(arg(args, 2)),
                number(arg(args, 3)),
                tolerance,
            )
        } else if text_is(arg(args, 0), "move") {
            input.move_pointer(
                context,
                arg(args, 1),
                number(arg(args, 2)),
                number(arg(args, 3)),
            )
        } else {
            input.up(context, arg(args, 1))
        };
        if let Err(error) = result {
            input.cancel(context, true, false)?;
            return Err(error);
        }
        Ok(JsValue::Undefined)
    })
}
pub(crate) fn tool(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    tool_with_reply_admission(engine, args, &mut |_| Ok(()))
}

fn tool_with_reply_admission(
    engine: &mut Engine,
    args: &[JsValue],
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    engine.with_interaction(|input, context| {
        let prepared = input.prepare_set_tool(arg(args, 0))?;
        let cancel = input.prepare_cancel(context, false, false)?;
        admit_reply(FixedReply::Undefined)?;
        input.publish_prepared_cancel(context, cancel)?;
        input.publish_prepared_tool_after_cancel(prepared, true)?;
        Ok(JsValue::Undefined)
    })
}
pub(crate) fn wheel(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    wheel_with_reply_admission(engine, args, &mut |_| Ok(()))
}

fn wheel_with_reply_admission(
    engine: &mut Engine,
    args: &[JsValue],
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    engine.with_interaction(|input, context| {
        let prepared = input.prepare_wheel(context, arg(args, 0), arg(args, 1))?;
        admit_reply(FixedReply::Undefined)?;
        input.publish_prepared_wheel(context, prepared)?;
        Ok(JsValue::Undefined)
    })
}
pub(crate) fn key(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    key_with_reply_admission(engine, args, &mut |_| Ok(()))
}

fn key_with_reply_admission(
    engine: &mut Engine,
    args: &[JsValue],
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    let control = truthy(arg(args, 1));
    let empty = JsString::from_str("");
    let key = match arg(args, 0) {
        JsValue::String(key) => Some(key),
        _ if !control => Some(&empty),
        _ => None,
    };
    if key.is_none() {
        return engine.with_interaction(|_, context| {
            if context.drawings.items().iter().any(|drawing| {
                context.drawings.selected() == Some(&drawing.id) && drawing.visible == Some(false)
            }) {
                context.drawings.select(None)?;
            }
            Err(JsError::new(
                "TypeError",
                JsString::from_str("key.toLowerCase is not a function"),
            ))
        });
    }
    // Known hidden-selection/type-error sequence 뒤, 성공 가능 key branch는 reply를 먼저 확보한다.
    engine.with_interaction(|input, context| {
        admit_reply(FixedReply::Undefined)?;
        let key = key.expect("malformed ctrl key returned before admission");
        input.key(
            context,
            key,
            InteractionKeyModifiers {
                ctrl: control,
                shift: truthy(arg(args, 2)),
            },
        )?;
        Ok(JsValue::Undefined)
    })
}
pub(crate) fn gesture_kind(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    gesture_kind_scoped(engine, &mut scope)
}
pub(crate) fn inspect(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
    inspect_scoped(engine, &mut scope)
}

fn gesture_kind_scoped(engine: &mut Engine, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    engine
        .input()
        .ok_or_else(|| reference("nativeInput"))?
        .gesture_kind()
        .map(|kind| {
            JsString::try_from_str(kind, scope)
                .map(JsValue::String)
                .map_err(|failure| failure.into_js_error())
        })
        .unwrap_or(Ok(JsValue::Null))
}

fn inspect_scoped(engine: &mut Engine, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let chart = engine.chart().ok_or_else(|| reference("nativeModel"))?;
    let input = engine.input().ok_or_else(|| reference("nativeInput"))?;
    let mut view = JsObject::new();
    view.insert(
        JsString::from_str("from"),
        JsValue::Number(chart.model().view.from),
    );
    view.insert(
        JsString::from_str("to"),
        JsValue::Number(chart.model().view.to),
    );
    let drawing_bytes = chart
        .drawings()
        .items()
        .len()
        .checked_mul(std::mem::size_of::<JsValue>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(drawing_bytes)
        .map_err(|failure| failure.into_js_error())?;
    let mut drawings = Vec::new();
    drawings
        .try_reserve_exact(chart.drawings().items().len())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    for drawing in chart.drawings().items() {
        drawings.push(drawing.to_value_scoped(scope)?);
    }
    let mut output = JsObject::new();
    for (key, value) in [
        ("view", JsValue::Object(view)),
        ("drawings", JsValue::Array(drawings)),
        (
            "storedBars",
            JsValue::Number(chart.data().store().length() as f64),
        ),
        (
            "tool",
            JsValue::String(
                input
                    .tool()
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            ),
        ),
        ("pointers", JsValue::Number(input.pointer_count() as f64)),
        (
            "gesture",
            input
                .gesture_kind()
                .map(|kind| {
                    JsString::try_from_str(kind, scope)
                        .map(JsValue::String)
                        .map_err(|failure| failure.into_js_error())
                })
                .transpose()?
                .unwrap_or(JsValue::Null),
        ),
    ] {
        output.insert(JsString::from_str(key), value);
    }
    let bytes = stringify_json_scoped(
        &JsValue::Object(output),
        JsonMode::Standard,
        NumberDialect::PLATFORM,
        scope,
    )
    .map_err(|failure| failure.into_js_error())?;
    let text = std::str::from_utf8(&bytes).expect("JSON UTF-8");
    Ok(JsValue::String(
        JsString::try_from_str(text, scope).map_err(|failure| failure.into_js_error())?,
    ))
}

pub(super) fn call_scoped_with_reply_admission(
    name: &str,
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Option<Result<JsValue, JsError>> {
    Some(match name {
        "nativePointer" => pointer_with_reply_admission(engine, args, admit_reply),
        "nativeTool" => tool_with_reply_admission(engine, args, admit_reply),
        "nativeWheel" => wheel_with_reply_admission(engine, args, admit_reply),
        "nativeKey" => key_with_reply_admission(engine, args, admit_reply),
        "nativeGestureKind" => gesture_kind_scoped(engine, scope),
        "nativeInspect" => inspect_scoped(engine, scope),
        "nativeHoverExit" => hover_exit(engine, args),
        _ => return None,
    })
}

pub(crate) fn indicator(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine.add_legacy_indicator(arg(args, 0), arg(args, 1), arg(args, 2), arg(args, 3))
}

pub(super) fn command_with_reply_admission(
    engine: &mut Engine,
    operation: &str,
    args: &[JsValue],
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Option<Result<JsValue, JsError>> {
    if !matches!(
        operation,
        "setDrawingTarget"
            | "setDrawingMagnet"
            | "setCrosshairSnap"
            | "setTool"
            | "setText"
            | "crosshairSnapshot"
            | "crosshairValues"
    ) {
        return None;
    }
    if operation == "crosshairSnapshot" {
        return Some(engine.crosshair_snapshot(arg(args, 0), arg(args, 1)));
    }
    if operation == "crosshairValues" {
        return Some(engine.crosshair_values(arg(args, 0), arg(args, 1), false));
    }
    Some(engine.with_interaction(|input, context| {
        match operation {
            "setDrawingTarget" => {
                let prepared = input.prepare_set_drawing_target(context, arg(args, 0))?;
                let cancel = input.prepare_cancel(context, false, false)?;
                admit_reply(FixedReply::Null)?;
                input.publish_prepared_cancel(context, cancel)?;
                input.publish_prepared_drawing_target_after_cancel(prepared, false)?;
            }
            "setDrawingMagnet" => {
                let prepared = input.prepare_set_drawing_magnet(arg(args, 0))?;
                let cancel = if matches!(&prepared, PreparedInteraction::Noop { .. }) {
                    None
                } else {
                    Some(input.prepare_cancel(context, false, true)?)
                };
                admit_reply(FixedReply::Null)?;
                if let Some(cancel) = cancel {
                    input.publish_prepared_cancel(context, cancel)?;
                }
                input.publish_prepared_drawing_magnet_after_cancel(prepared, false)?;
            }
            "setCrosshairSnap" => {
                let prepared = input.prepare_set_crosshair_snap(context, arg(args, 0))?;
                admit_reply(FixedReply::Null)?;
                input.publish_prepared_crosshair_snap(prepared, false)?;
            }
            "setTool" => {
                let prepared = input.prepare_set_tool(arg(args, 0))?;
                let cancel = input.prepare_cancel(context, false, false)?;
                admit_reply(FixedReply::Null)?;
                input.publish_prepared_cancel(context, cancel)?;
                input.publish_prepared_tool_after_cancel(prepared, false)?;
            }
            _ => match arg(args, 0) {
                JsValue::String(value) if value.len_utf16() <= 2000 => {
                    let prepared = input.prepare_set_text(arg(args, 0))?;
                    admit_reply(FixedReply::Null)?;
                    input.publish_prepared_text(prepared, false)?;
                }
                _ => {
                    return Err(JsError::new(
                        "TypeError",
                        JsString::from_str("Drawing text, at most 2000 characters"),
                    ));
                }
            },
        };
        Ok(JsValue::Null)
    }))
}

pub(crate) fn hover_exit(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    engine.hover_exit()?;
    Ok(JsValue::Bool(true))
}

pub(crate) fn accessibility(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine.accessibility(matches!(arg(args, 0), JsValue::Bool(true)))
}
pub(crate) fn accessibility_text(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    let android = JsValue::String(JsString::from_str("android"));
    let platform = if matches!(arg(args, 1), JsValue::Undefined) {
        &android
    } else {
        arg(args, 1)
    };
    if !["android", "uikit"]
        .iter()
        .any(|name| text_is(platform, name))
    {
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Accessibility text platform"),
        ));
    }
    let use_last = if matches!(arg(args, 0), JsValue::Undefined) {
        true
    } else {
        matches!(arg(args, 0), JsValue::Bool(true))
    };
    let summary = engine.accessibility(use_last)?;
    barochart_core::readout::accessibility_text(&summary, platform).map(JsValue::String)
}
