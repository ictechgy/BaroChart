use barochart_bridge::call;
use barochart_core::chart_api::ChartOperation;
use barochart_core::{Engine, Host, HostError};
use barochart_js::json::{JsValue, JsonMode, parse_json};
use barochart_js::string::JsString;

const NODE_ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-controller.leaf.jsonl");

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

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
}

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(value) = value else {
        panic!("object")
    };
    value.get(&JsString::from_str(name)).unwrap()
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number")
    };
    *value
}

fn decode_wire(value: &JsValue) -> JsValue {
    let JsValue::Object(encoded) = value else {
        return match value {
            JsValue::Array(values) => JsValue::Array(values.iter().map(decode_wire).collect()),
            _ => value.clone(),
        };
    };
    if encoded.len() == 1 {
        if let Some(JsValue::String(bits)) = encoded.get(&JsString::from_str("$f64")) {
            return JsValue::Number(f64::from_bits(
                u64::from_str_radix(&bits.to_string_lossy(), 16).unwrap(),
            ));
        }
        if encoded.get(&JsString::from_str("$undefined")).is_some() {
            return JsValue::Undefined;
        }
        if let Some(JsValue::Array(entries)) = encoded.get(&JsString::from_str("$object")) {
            let mut output = barochart_js::json::JsObject::new();
            for entry in entries {
                let JsValue::Array(entry) = entry else {
                    panic!("entry")
                };
                let JsValue::String(name) = &entry[0] else {
                    panic!("name")
                };
                output.insert(name.clone(), decode_wire(&entry[1]));
            }
            return JsValue::Object(output);
        }
    }
    let mut output = barochart_js::json::JsObject::new();
    for (name, child) in encoded.iter() {
        output.insert(name.clone(), decode_wire(child));
    }
    JsValue::Object(output)
}

fn oracle_case(id: &str) -> JsValue {
    NODE_ORACLE
        .lines()
        .skip(1)
        .map(parse)
        .find(|row| matches!(field(row, "id"), JsValue::String(value) if value == &JsString::from_str(id)))
        .map(|row| decode_wire(field(&row, "result")))
        .unwrap()
}

fn engine() -> Engine {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(
        &mut engine,
        "nativeInit",
        &[
            JsValue::Number(20.0),
            parse(r#"{"series":[{"id":"price","type":"candles","panel":"price"}]}"#),
        ],
    )
    .unwrap();
    call(
        &mut engine,
        "nativeResize",
        &[JsValue::Number(400.0), JsValue::Number(300.0)],
    )
    .unwrap();
    engine
}

fn command(
    engine: &mut Engine,
    operation: &str,
    args: Vec<JsValue>,
) -> Result<JsValue, barochart_js::error::JsError> {
    call(
        engine,
        "nativeCommand",
        &[text(operation), JsValue::Array(args)],
    )
}

fn pointer(
    engine: &mut Engine,
    kind: &str,
    id: f64,
    x: f64,
    y: f64,
) -> Result<JsValue, barochart_js::error::JsError> {
    call(
        engine,
        "nativePointer",
        &[
            text(kind),
            JsValue::Number(id),
            JsValue::Number(x),
            JsValue::Number(y),
        ],
    )
}

fn pointer_with_tolerance(
    engine: &mut Engine,
    kind: &str,
    id: f64,
    x: f64,
    y: f64,
    tolerance: f64,
) -> Result<JsValue, barochart_js::error::JsError> {
    call(
        engine,
        "nativePointer",
        &[
            text(kind),
            JsValue::Number(id),
            JsValue::Number(x),
            JsValue::Number(y),
            JsValue::Number(tolerance),
        ],
    )
}

fn first_drawing_screen(engine: &mut Engine) -> (f64, f64) {
    engine
        .with_interaction(|_, context| {
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
            Ok((point.x, point.y))
        })
        .unwrap()
}

fn add_bound_drawing(engine: &mut Engine, series_id: &str) {
    command(
        engine,
        "addDrawing",
        vec![parse(&format!(
            r#"{{"id":"d","type":"horizontal","panel":"price","seriesId":"{series_id}","points":[{{"time":1700000600000,"price":100}}]}}"#
        ))],
    )
    .unwrap();
}

fn start_edit(engine: &mut Engine, id: f64) {
    let (x, y) = first_drawing_screen(engine);
    assert!(x.is_finite() && y.is_finite(), "screen point: {x}, {y}");
    assert!(engine.chart().unwrap().drawings().selected().is_some());
    pointer(engine, "down", id, x, y).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    pointer(engine, "move", id, x, y + 24.0).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
}

#[test]
fn pointer_to_command_rejections_preserve_live_state_and_acceptance_uses_the_baseline() {
    let mut engine = engine();
    add_bound_drawing(&mut engine, "price");
    start_edit(&mut engine, 1.0);
    let dragged = engine.chart().unwrap().drawings().items()[0].points[0].price;
    assert_ne!(dragged, 100.0);

    assert!(
        command(
            &mut engine,
            "editDrawing",
            vec![text("missing"), parse(r#"{"locked":false}"#)],
        )
        .is_err()
    );
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        dragged
    );

    assert!(command(
        &mut engine,
        "addDrawing",
        vec![parse(r#"{"id":"d","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":100}]}"#)],
    )
    .is_err());
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);

    command(
        &mut engine,
        "editDrawing",
        vec![text("d"), parse(r#"{"style":{"color":"red"}}"#)],
    )
    .unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        100.0
    );

    start_edit(&mut engine, 5.0);
    command(
        &mut engine,
        "addDrawing",
        vec![parse(r#"{"id":"added","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":55}]}"#)],
    )
    .unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        100.0
    );
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);

    pointer(&mut engine, "move", 5.0, 0.0, 0.0).unwrap();
    pointer(&mut engine, "up", 5.0, 0.0, 0.0).unwrap();
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);
}

#[test]
fn pointer_kind_error_preserves_but_down_tolerance_error_runs_source_cancel() {
    let mut engine = engine();
    add_bound_drawing(&mut engine, "price");
    start_edit(&mut engine, 81.0);
    let dragged = engine.chart().unwrap().drawings().items()[0].points[0].price;
    assert_ne!(dragged, 100.0);

    assert!(pointer(&mut engine, "invalid", 82.0, 10.0, 10.0).is_err());
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        dragged
    );

    let error = pointer_with_tolerance(&mut engine, "down", 82.0, 10.0, 10.0, 0.0)
        .expect_err("invalid tolerance");
    assert_eq!(error.name, "RangeError");
    assert_eq!(
        error.message,
        JsString::from_str("Pointer hit tolerance must be 1..32 logical pixels")
    );
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert!(engine.chart().unwrap().drawings().transaction().is_none());
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        100.0
    );
}

#[test]
fn pointer_to_command_delete_and_selection_matrix_preserves_rejections() {
    let mut engine = engine();
    add_bound_drawing(&mut engine, "price");
    command(
        &mut engine,
        "addDrawing",
        vec![parse(r#"{"id":"locked","type":"horizontal","panel":"price","locked":true,"points":[{"time":1700000600000,"price":101}]}"#)],
    )
    .unwrap();
    command(
        &mut engine,
        "addDrawing",
        vec![parse(r#"{"id":"other","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":102}]}"#)],
    )
    .unwrap();
    command(&mut engine, "selectDrawing", vec![text("d")]).unwrap();
    start_edit(&mut engine, 6.0);
    assert!(matches!(
        command(&mut engine, "deleteDrawing", vec![text("locked")]).unwrap(),
        JsValue::Bool(false)
    ));
    assert!(command(&mut engine, "selectDrawing", vec![text("missing")]).is_err());
    assert_eq!(engine.input().unwrap().gesture_kind(), Some("edit"));
    assert_eq!(engine.input().unwrap().pointer_count(), 1);

    command(&mut engine, "selectDrawing", vec![text("other")]).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(
        engine.chart().unwrap().drawings().selected(),
        Some(&JsString::from_str("other"))
    );
    assert_eq!(
        engine.chart().unwrap().drawings().items()[0].points[0].price,
        100.0
    );

    start_edit(&mut engine, 7.0);
    assert!(matches!(
        command(&mut engine, "deleteDrawing", vec![text("other")]).unwrap(),
        JsValue::Bool(true)
    ));
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 2);
    assert!(
        engine
            .chart()
            .unwrap()
            .drawings()
            .items()
            .iter()
            .all(|drawing| drawing.id != JsString::from_str("other"))
    );
}

#[test]
fn active_create_delete_and_active_undo_follow_controller_key_semantics() {
    let mut engine = engine();
    command(
        &mut engine,
        "setDrawingTarget",
        vec![parse(r#"{"panel":"price","seriesId":"price"}"#)],
    )
    .unwrap();
    command(&mut engine, "setTool", vec![text("horizontal")]).unwrap();
    pointer(&mut engine, "down", 2.0, 100.0, 100.0).unwrap();
    let id = engine
        .input()
        .unwrap()
        .gesture_drawing_id()
        .unwrap()
        .clone();
    assert!(matches!(
        command(&mut engine, "deleteDrawing", vec![JsValue::String(id)]).unwrap(),
        JsValue::Bool(false)
    ));
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert!(engine.chart().unwrap().drawings().items().is_empty());

    command(&mut engine, "setTool", vec![text("select")]).unwrap();
    add_bound_drawing(&mut engine, "price");
    start_edit(&mut engine, 3.0);
    command(&mut engine, "undo", vec![]).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 1);
    command(&mut engine, "undo", vec![]).unwrap();
    assert!(engine.chart().unwrap().drawings().items().is_empty());
    command(&mut engine, "redo", vec![]).unwrap();
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 1);
}

#[test]
fn series_and_indicator_lifecycle_cleanup_crosses_the_same_command_boundary() {
    let mut engine = engine();
    command(
        &mut engine,
        "addSeries",
        vec![parse(r#"{"id":"line","type":"line","panel":"price"}"#)],
    )
    .unwrap();
    command(
        &mut engine,
        "setDrawingTarget",
        vec![parse(r#"{"panel":"price","seriesId":"line"}"#)],
    )
    .unwrap();
    add_bound_drawing(&mut engine, "line");
    start_edit(&mut engine, 4.0);
    command(&mut engine, "removeSeries", vec![text("line")]).unwrap();
    assert_eq!(engine.input().unwrap().gesture_kind(), None);
    assert_eq!(engine.input().unwrap().pointer_count(), 0);
    assert!(engine.input().unwrap().drawing_target().is_none());
    assert_eq!(engine.chart().unwrap().drawings().items().len(), 1);

    command(
        &mut engine,
        "addPanel",
        vec![parse(r#"{"id":"study","weight":1}"#)],
    )
    .unwrap();
    command(
        &mut engine,
        "addIndicator",
        vec![text("ema"), text("ema"), parse(r#"{"period":3}"#)],
    )
    .unwrap();
    command(
        &mut engine,
        "addSeries",
        vec![parse(
            r#"{"id":"ema-line","type":"line","panel":"price","indicator":"ema"}"#,
        )],
    )
    .unwrap();
    command(
        &mut engine,
        "setDrawingTarget",
        vec![parse(r#"{"panel":"price","seriesId":"ema-line"}"#)],
    )
    .unwrap();
    command(
        &mut engine,
        "setIndicatorPlacement",
        vec![text("ema"), parse(r#"{"panel":"study"}"#)],
    )
    .unwrap();
    let target = engine.input().unwrap().drawing_target().unwrap();
    let JsValue::Object(target) = target else {
        panic!("target")
    };
    assert!(matches!(
        target.get(&JsString::from_str("panel")),
        Some(JsValue::String(panel)) if panel == &JsString::from_str("study")
    ));
    command(&mut engine, "removeIndicator", vec![text("ema")]).unwrap();
    assert!(engine.input().unwrap().drawing_target().is_none());
    assert!(
        engine
            .chart()
            .unwrap()
            .model()
            .series
            .iter()
            .all(|series| series.id != JsString::from_str("ema-line"))
    );
}

#[test]
fn node22_oracle_and_command_metadata_are_pinned() {
    let rows = NODE_ORACLE.lines().map(parse).collect::<Vec<_>>();
    assert_eq!(rows.len(), 7);
    let JsValue::Object(header) = &rows[0] else {
        panic!("header")
    };
    assert!(matches!(
        header.get(&JsString::from_str("node")),
        Some(JsValue::String(node)) if node == &JsString::from_str("v22.20.0")
    ));
    let ids = rows[1..]
        .iter()
        .map(|row| {
            let JsValue::Object(row) = row else {
                panic!("row")
            };
            assert!(row.get(&JsString::from_str("result")).is_some());
            let Some(JsValue::String(id)) = row.get(&JsString::from_str("id")) else {
                panic!("id")
            };
            id.to_string_lossy()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "invalid-edit-preserves",
            "valid-edit-baseline",
            "add-during-edit-late-events",
            "create-delete",
            "active-inactive-undo-redo",
            "series-removal-cleanup",
        ]
    );
    assert_eq!(ChartOperation::ALL.len(), 65);
    assert_eq!(
        ChartOperation::ALL
            .iter()
            .map(|operation| operation.name())
            .collect::<Vec<_>>()
            .first(),
        Some(&"compactData")
    );
    assert_eq!(ChartOperation::ALL.last().unwrap().name(), "inspect");

    let invalid = oracle_case("invalid-edit-preserves");
    assert_eq!(number(field(field(&invalid, "before"), "effects")), 1.0);
    assert_eq!(number(field(field(&invalid, "after"), "effects")), 1.0);
    let valid = oracle_case("valid-edit-baseline");
    assert_eq!(number(field(field(&valid, "state"), "effects")), 2.0);
    assert_eq!(number(field(field(&valid, "state"), "anchor")), 100.0);
    assert_eq!(number(field(field(&valid, "state"), "undo")), 2.0);
    assert!(matches!(
        field(&valid, "color"),
        JsValue::String(color) if color == &JsString::from_str("#ff0000ff")
    ));
    let create = oracle_case("create-delete");
    assert_eq!(number(field(field(&create, "state"), "effects")), 3.0);
    let history = oracle_case("active-inactive-undo-redo");
    assert_eq!(number(field(field(&history, "active"), "effects")), 2.0);
    assert_eq!(number(field(field(&history, "undone"), "effects")), 3.0);
    assert_eq!(number(field(field(&history, "redone"), "effects")), 4.0);
}
