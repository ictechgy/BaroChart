use barochart_core::Engine;
use barochart_core::chart_api::ChartApi;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::interaction::OwnedInteractionState;
use barochart_core::native_chart::NativeChart;
use barochart_core::{Host, HostError};
use barochart_js::json::{JsValue, JsonMode, parse_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

struct NoZones;

impl Host for NoZones {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }

    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }

    fn log(&self, _: i32, _: &str) {}
}

fn bar(index: usize) -> Bar {
    let close = 40.0 + index as f64;
    Bar {
        time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
        open: close,
        high: close + 4.0,
        low: close - 4.0,
        close,
        volume: 100.0,
    }
}

fn chart(host: &dyn Host) -> NativeChart {
    let data = ModelDataState::new(StoreOptions::default(), (0..20).map(bar).collect()).unwrap();
    NativeChart::new(
        data,
        &parse(r#"{"series":[{"id":"price","type":"candles","panel":"price"}]}"#),
        NumberDialect::PLATFORM,
        host,
    )
    .unwrap()
}

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
}

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn engine() -> Engine {
    engine_with_length(20)
}

fn engine_with_length(length: usize) -> Engine {
    let mut engine = Engine::new(Box::new(NoZones));
    let data =
        ModelDataState::new(StoreOptions::default(), (0..length).map(bar).collect()).unwrap();
    let chart = engine
        .stage_chart(
            data,
            &parse(r#"{"series":[{"id":"price","type":"candles","panel":"price"}]}"#),
        )
        .unwrap();
    engine.install_chart(chart).unwrap();
    engine
}

fn dispatch(
    engine: &mut Engine,
    operation: &str,
    args: &[JsValue],
) -> Result<JsValue, barochart_js::error::JsError> {
    let (chart, controller, host, width, height) = engine.command_parts_mut().unwrap();
    ChartApi::with_controller(chart, controller, host, width, height)
        .dispatch(&JsString::from_str(operation), args)
}

fn add_horizontal(engine: &mut Engine, id: &str, price: f64) {
    dispatch(
        engine,
        "addDrawing",
        &[parse(&format!(
            r#"{{"id":"{id}","type":"horizontal","panel":"price","seriesId":"price","points":[{{"time":1700000600000,"price":{price}}}]}}"#
        ))],
    )
    .unwrap();
}

fn start_edit(engine: &mut Engine, id: f64, dx: f64, dy: f64) {
    engine
        .with_interaction(|controller, context| {
            let drawing = context.drawings.items()[0].clone();
            let layout = context.layout()?;
            let point = layout.to_screen(
                context.model.view,
                context.store,
                drawing.points[0].time,
                drawing.points[0].price,
                &drawing.panel,
                drawing.axis_id.as_ref(),
            );
            controller.down(context, JsValue::Number(id), point.x, point.y, 8.0)?;
            controller.move_pointer(context, &JsValue::Number(id), point.x + dx, point.y + dy)?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn live_controller_facade_is_available_without_changing_readonly_constructors() {
    let host = NoZones;
    let mut chart = chart(&host);
    let mut controller = OwnedInteractionState::new();
    let api = ChartApi::with_controller(&mut chart, &mut controller, &host, 400.0, 300.0);
    assert_eq!(api.chart().data().store().length(), 20);
}

#[test]
fn rejected_api_drawing_mutations_preserve_the_live_edit_transaction() {
    let mut engine = engine();
    add_horizontal(&mut engine, "d", 50.0);
    start_edit(&mut engine, 7.0, 0.0, 24.0);
    let dragged = engine.chart().unwrap().drawings().items()[0].points[0].price;
    assert_ne!(dragged, 50.0);

    let error = dispatch(
        &mut engine,
        "editDrawing",
        &[text("missing"), parse(r#"{"style":{"color":"red"}}"#)],
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        JsString::from_str("Missing committed drawing")
    );
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
    assert!(engine.chart().unwrap().drawings().transaction().is_some());
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        dragged
    );

    assert!(
        dispatch(
            &mut engine,
            "addDrawing",
            &[parse(
                r#"{"id":"d","type":"horizontal","panel":"price","points":[{"time":1,"price":1}]}"#
            )],
        )
        .is_err()
    );
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        dragged
    );

    assert!(dispatch(&mut engine, "selectDrawing", &[text("missing")]).is_err());
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
}

#[test]
fn accepted_edit_cancels_to_the_baseline_then_creates_one_independent_undo_step() {
    let mut engine = engine();
    add_horizontal(&mut engine, "d", 50.0);
    let undo_before = engine.chart().unwrap().drawings().undo_stack().len();
    start_edit(&mut engine, 7.0, 0.0, 24.0);

    dispatch(
        &mut engine,
        "editDrawing",
        &[text("d"), parse(r#"{"style":{"color":"red"}}"#)],
    )
    .unwrap();
    let chart = engine.chart().unwrap();
    assert_eq!(chart.drawings().items()[0].points[0].price, 50.0);
    assert_eq!(chart.drawings().undo_stack().len(), undo_before + 1);
    assert!(chart.drawings().transaction().is_none());
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
}

#[test]
fn valid_noop_edit_still_cancels_but_locked_delete_does_not() {
    let mut engine = engine();
    add_horizontal(&mut engine, "d", 50.0);
    dispatch(
        &mut engine,
        "addDrawing",
        &[parse(r#"{"id":"locked","type":"horizontal","panel":"price","locked":true,"points":[{"time":1700000600000,"price":55}]}"#)],
    )
    .unwrap();
    dispatch(&mut engine, "selectDrawing", &[text("d")]).unwrap();
    start_edit(&mut engine, 7.0, 0.0, 24.0);
    assert!(matches!(
        dispatch(&mut engine, "deleteDrawing", &[text("locked")]).unwrap(),
        JsValue::Bool(false)
    ));
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);

    let undo_before = engine.chart().unwrap().drawings().undo_stack().len();
    dispatch(
        &mut engine,
        "editDrawing",
        &[text("d"), parse(r#"{"locked":false}"#)],
    )
    .unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert_eq!(
        engine.chart().unwrap().drawings().undo_stack().len(),
        undo_before
    );
}

#[test]
fn valid_selection_change_cancels_before_publishing_the_selection() {
    let mut engine = engine();
    add_horizontal(&mut engine, "d", 50.0);
    dispatch(
        &mut engine,
        "addDrawing",
        &[parse(r#"{"id":"other","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":55}]}"#)],
    )
    .unwrap();
    dispatch(&mut engine, "selectDrawing", &[text("d")]).unwrap();
    start_edit(&mut engine, 7.0, 0.0, 24.0);
    dispatch(&mut engine, "selectDrawing", &[text("other")]).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert_eq!(
        engine.chart().unwrap().drawings().selected(),
        Some(&JsString::from_str("other"))
    );
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        50.0
    );
}

#[test]
fn valid_delete_during_edit_uses_the_transaction_baseline() {
    let mut engine = engine();
    add_horizontal(&mut engine, "d", 50.0);
    dispatch(
        &mut engine,
        "addDrawing",
        &[parse(r#"{"id":"other","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":55}]}"#)],
    )
    .unwrap();
    dispatch(&mut engine, "selectDrawing", &[text("d")]).unwrap();
    start_edit(&mut engine, 7.0, 0.0, 24.0);
    assert!(matches!(
        dispatch(&mut engine, "deleteDrawing", &[text("other")]).unwrap(),
        JsValue::Bool(true)
    ));
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 1);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].id,
        JsString::from_str("d")
    );
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        50.0
    );
}

#[test]
fn deleting_the_uncommitted_create_id_cancels_and_returns_false() {
    let mut engine = engine();
    dispatch(
        &mut engine,
        "setDrawingTarget",
        &[parse(r#"{"panel":"price","seriesId":"price"}"#)],
    )
    .unwrap();
    dispatch(&mut engine, "setTool", &[text("horizontal")]).unwrap();
    engine
        .with_interaction(|controller, context| {
            let layout = context.layout()?;
            let panel = &layout.panels[0];
            controller.down(
                context,
                JsValue::Number(22.0),
                panel.left + 30.0,
                panel.top + 30.0,
                8.0,
            )?;
            Ok(())
        })
        .unwrap();
    let id = engine
        .input()
        .unwrap()
        .gesture_drawing_id()
        .unwrap()
        .clone();
    assert!(matches!(
        dispatch(&mut engine, "deleteDrawing", &[JsValue::String(id)]).unwrap(),
        JsValue::Bool(false)
    ));
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert!(engine.chart().unwrap().drawings().transaction().is_none());
    assert!(engine.chart().unwrap().drawings().items().is_empty());
}

#[test]
fn add_during_edit_survives_late_pointer_events_and_undo_during_drag_only_cancels() {
    let mut engine = engine();
    add_horizontal(&mut engine, "d", 50.0);
    start_edit(&mut engine, 7.0, 0.0, 24.0);
    dispatch(
        &mut engine,
        "addDrawing",
        &[parse(r#"{"id":"added","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":55}]}"#)],
    )
    .unwrap();
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);
    engine
        .with_interaction(|controller, context| {
            controller.move_pointer(context, &JsValue::Number(7.0), 1.0, 1.0)?;
            controller.up(context, &JsValue::Number(7.0))?;
            Ok(())
        })
        .unwrap();
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);

    start_edit(&mut engine, 8.0, 0.0, 24.0);
    dispatch(&mut engine, "undo", &[]).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);
    dispatch(&mut engine, "undo", &[]).unwrap();
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 1);
    dispatch(&mut engine, "redo", &[]).unwrap();
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);
}

#[test]
fn presentation_only_set_series_moves_the_existing_values_allocation() {
    const LENGTH: usize = 65_536;
    let mut engine = engine_with_length(LENGTH);
    let values = (0..LENGTH)
        .map(|index| JsValue::Number(index as f64))
        .collect();
    dispatch(
        &mut engine,
        "addSeries",
        &[parse(r#"{"id":"external","type":"line","panel":"price"}"#)],
    )
    .unwrap();
    dispatch(
        &mut engine,
        "setSeriesValues",
        &[text("external"), JsValue::Array(values)],
    )
    .unwrap();
    let pointer = engine.chart().unwrap().model().series[1]
        .values
        .as_ref()
        .unwrap()
        .as_ptr();
    dispatch(
        &mut engine,
        "setSeries",
        &[text("external"), parse(r#"{"color":"red","label":"x"}"#)],
    )
    .unwrap();
    assert_eq!(
        engine.chart().unwrap().model().series[1]
            .values
            .as_ref()
            .unwrap()
            .as_ptr(),
        pointer
    );
}

#[test]
fn set_series_rebinds_the_target_after_cancel_but_keeps_committed_drawing_binding() {
    let mut engine = engine();
    for axis in ["a", "b"] {
        dispatch(
            &mut engine,
            "addAxis",
            &[parse(&format!(
                r#"{{"id":"{axis}","panel":"price","side":"left","visible":false}}"#
            ))],
        )
        .unwrap();
    }
    dispatch(
        &mut engine,
        "addSeries",
        &[parse(
            r#"{"id":"line","type":"line","panel":"price","axisId":"a"}"#,
        )],
    )
    .unwrap();
    dispatch(
        &mut engine,
        "setDrawingTarget",
        &[parse(r#"{"panel":"price","axisId":"a","seriesId":"line"}"#)],
    )
    .unwrap();
    dispatch(
        &mut engine,
        "addDrawing",
        &[parse(r#"{"id":"bound","type":"horizontal","panel":"price","axisId":"a","seriesId":"line","points":[{"time":1700000600000,"price":50}]}"#)],
    )
    .unwrap();
    start_edit(&mut engine, 9.0, 0.0, 24.0);
    let dragged = engine.chart().unwrap().drawings().items()[0].points[0].price;
    assert!(
        dispatch(
            &mut engine,
            "setSeries",
            &[text("line"), parse(r#"{"axisId":"missing"}"#)],
        )
        .is_err()
    );
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        dragged
    );
    dispatch(
        &mut engine,
        "setSeries",
        &[text("line"), parse(r#"{"axisId":"b"}"#)],
    )
    .unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    let target = engine.input().unwrap().drawing_target().unwrap();
    let JsValue::Object(target) = target else {
        panic!("target")
    };
    assert!(matches!(
        target.get(&JsString::from_str("axisId")),
        Some(JsValue::String(axis)) if axis == &JsString::from_str("b")
    ));
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].axis_id,
        Some(JsString::from_str("a"))
    );
}

#[test]
fn hidden_axis_removal_clears_the_target_without_cancelling_an_unrelated_pan() {
    let mut engine = engine();
    dispatch(
        &mut engine,
        "addAxis",
        &[parse(
            r#"{"id":"hidden","panel":"price","side":"left","visible":false}"#,
        )],
    )
    .unwrap();
    dispatch(
        &mut engine,
        "setDrawingTarget",
        &[parse(r#"{"panel":"price","axisId":"hidden"}"#)],
    )
    .unwrap();
    engine
        .with_interaction(|controller, context| {
            let layout = context.layout()?;
            let panel = &layout.panels[0];
            controller.down(
                context,
                JsValue::Number(12.0),
                panel.left + 20.0,
                panel.top + 20.0,
                8.0,
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("pan"));
    dispatch(&mut engine, "removeAxis", &[text("hidden")]).unwrap();
    assert!(engine.input().unwrap().drawing_target().is_none());
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("pan"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
}

#[test]
fn panel_cleanup_raw_publication_rotates_the_controller_target_identity() {
    let mut engine = engine();
    dispatch(
        &mut engine,
        "addPanel",
        &[parse(r#"{"id":"temporary","weight":1}"#)],
    )
    .unwrap();
    dispatch(
        &mut engine,
        "setDrawingTarget",
        &[parse(r#"{"panel":"temporary"}"#)],
    )
    .unwrap();
    let token = engine.input().unwrap().capture_source_owner().unwrap();
    dispatch(&mut engine, "removePanel", &[text("temporary")]).unwrap();
    assert!(engine.input().unwrap().drawing_target().is_none());
    assert!(!engine.input().unwrap().validate_source_owner(&token));
}
