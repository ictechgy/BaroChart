//! 게시된 차트의 legacy 네이티브 호출을 연결한다.
use super::data_handlers::{missing_native_api, missing_native_model};
use crate::reply_policy::FixedReply;
use barochart_core::Engine;
use barochart_core::chart_api::ChartApi;
use barochart_js::error::JsError;
use barochart_js::json::{JsValue, JsonMode};
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;
static UNDEFINED: JsValue = JsValue::Undefined;
fn argument(args: &[JsValue], i: usize) -> &JsValue {
    args.get(i).unwrap_or(&UNDEFINED)
}
fn prefix(args: &[JsValue], arity: usize) -> &[JsValue] {
    &args[..std::cmp::min(args.len(), arity)]
}

pub(crate) fn legacy_scoped_with_reply_admission(
    name: &str,
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Option<Result<JsValue, JsError>> {
    if name == "nativeLoad" {
        return Some(
            super::commands::dispatch_with_reply_admission(
                engine,
                "loadDrawings",
                prefix(args, 1),
                scope,
                &mut |_| admit_reply(FixedReply::Undefined),
            )
            .map(|_| JsValue::Undefined),
        );
    }
    if ![
        "nativeView",
        "nativeFit",
        "nativeAddPanel",
        "nativeSetPanel",
        "nativeRemoveSeries",
        "nativeTheme",
    ]
    .contains(&name)
    {
        return None;
    }
    Some((|| {
        let chart = engine.chart_mut().ok_or_else(missing_native_model)?;
        chart.with_model_context(
            barochart_core::native_chart::NativeInteractionContext::default(),
            |model, context| match name {
                "nativeView" => {
                    let prepared = model.prepare_visible_range(
                        context.store,
                        argument(args, 0),
                        argument(args, 1),
                    )?;
                    admit_reply(FixedReply::Undefined)?;
                    model.publish_prepared_view(prepared);
                    Ok(JsValue::Undefined)
                }
                "nativeFit" => {
                    let prepared = model.prepare_fit(context.store);
                    admit_reply(FixedReply::Undefined)?;
                    model.publish_prepared_view(prepared);
                    Ok(JsValue::Undefined)
                }
                "nativeAddPanel" => model
                    .add_panel(argument(args, 0), context)
                    .map(JsValue::String),
                "nativeSetPanel" => {
                    model.set_panel_with_admission(
                        argument(args, 0),
                        argument(args, 1),
                        context,
                        &mut || admit_reply(FixedReply::Undefined),
                    )?;
                    Ok(JsValue::Undefined)
                }
                "nativeRemoveSeries" => {
                    model.remove_series_with_admission(argument(args, 0), &mut || {
                        admit_reply(FixedReply::Undefined)
                    })?;
                    Ok(JsValue::Undefined)
                }
                "nativeTheme" => {
                    model.set_theme_legacy_with_admission(argument(args, 0), &mut || {
                        admit_reply(FixedReply::Undefined)
                    })?;
                    Ok(JsValue::Undefined)
                }
                _ => unreachable!("validated legacy name"),
            },
        )
    })())
}

pub(crate) fn scene_json(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    scene_json_scoped(engine, args, &mut scope)
}

pub(crate) fn scene_json_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let scene = engine.build_scene(argument(args, 0), argument(args, 1))?;
    json_text(scene.value(), scope)
}

fn json_text(value: &JsValue, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let encoded = barochart_js::json::stringify_json_scoped(
        value,
        JsonMode::Standard,
        barochart_js::num::NumberDialect::PLATFORM,
        scope,
    )
    .map_err(|error| error.into_js_error())?;
    JsString::try_from_str(std::str::from_utf8(&encoded).expect("JSON UTF-8"), scope)
        .map(JsValue::String)
        .map_err(|error| error.into_js_error())
}

pub(super) fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => false,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        _ => true,
    }
}

pub(crate) fn render_frame_json(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    render_frame_json_scoped(engine, args, &mut scope)
}

pub(crate) fn render_frame_json_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let frame = engine.render_frame(
        argument(args, 0),
        argument(args, 1),
        argument(args, 2),
        truthy(argument(args, 3)),
    )?;
    let value = frame.to_js_value_scoped(scope)?;
    json_text(&value, scope)
}

pub(crate) fn release_frame_cache(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.release_frame_cache(argument(args, 0));
    Ok(JsValue::Bool(true))
}
pub(crate) fn release_frame_caches(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    engine.release_frame_caches();
    Ok(JsValue::Bool(true))
}

pub(crate) fn fit(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    engine.chart_mut().ok_or_else(missing_native_model)?.fit();
    Ok(JsValue::Undefined)
}
pub(crate) fn view(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let (chart, host) = engine
        .chart_and_host_mut()
        .ok_or_else(missing_native_model)?;
    ChartApi::new(chart, host).dispatch(&JsString::from_str("setVisibleRange"), prefix(args, 2))?;
    Ok(JsValue::Undefined)
}
pub(crate) fn theme(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine
        .chart_mut()
        .ok_or_else(missing_native_model)?
        .set_theme_legacy(argument(args, 0))?;
    Ok(JsValue::Undefined)
}
pub(crate) fn theme_font(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let chart = engine.chart().ok_or_else(missing_native_model)?;
    let JsValue::Object(theme) = chart.model().theme() else {
        unreachable!("model theme")
    };
    Ok(theme
        .get(&JsString::from_str("font"))
        .cloned()
        .unwrap_or(JsValue::Undefined))
}
pub(crate) fn add_panel(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let (chart, host) = engine
        .chart_and_host_mut()
        .ok_or_else(missing_native_model)?;
    ChartApi::new(chart, host).dispatch(&JsString::from_str("addPanel"), prefix(args, 1))
}
pub(crate) fn set_panel(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let (chart, host) = engine
        .chart_and_host_mut()
        .ok_or_else(missing_native_model)?;
    ChartApi::new(chart, host).dispatch(&JsString::from_str("setPanel"), prefix(args, 2))?;
    Ok(JsValue::Undefined)
}
pub(crate) fn add_series(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let chart = engine.chart_mut().ok_or_else(missing_native_model)?;
    chart
        .add_legacy_series(argument(args, 0))
        .map(JsValue::String)
}
pub(crate) fn remove_series(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let (chart, host) = engine
        .chart_and_host_mut()
        .ok_or_else(missing_native_model)?;
    ChartApi::new(chart, host).dispatch(&JsString::from_str("removeSeries"), prefix(args, 1))?;
    Ok(JsValue::Undefined)
}
pub(crate) fn save(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let (chart, host) = engine.chart_and_host_mut().ok_or_else(missing_native_api)?;
    ChartApi::new(chart, host).dispatch(&JsString::from_str("saveDrawings"), &[])
}
pub(crate) fn load(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let (chart, host) = engine.chart_and_host_mut().ok_or_else(missing_native_api)?;
    ChartApi::new(chart, host).dispatch(&JsString::from_str("loadDrawings"), prefix(args, 1))?;
    Ok(JsValue::Undefined)
}

pub(crate) fn resize(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine.set_native_size(argument(args, 0), argument(args, 1))?;
    Ok(JsValue::Undefined)
}

pub(crate) fn save_workspace(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine
        .save_workspace(argument(args, 0))
        .map(JsValue::String)
}
pub(crate) fn preflight_workspace(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<JsValue, JsError> {
    engine.preflight_workspace(argument(args, 0), argument(args, 1))
}
pub(crate) fn benchmark_event(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine.benchmark_event(argument(args, 0))
}
pub(crate) fn benchmark_digest(engine: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    engine.benchmark_digest().map(JsValue::String)
}

pub(crate) fn data_exploration(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    engine.data_exploration(argument(args, 0), argument(args, 1))
}
