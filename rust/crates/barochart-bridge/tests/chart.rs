use barochart_bridge::call;
use barochart_core::{Engine, Host, HostError};
use barochart_js::json::{JsValue, JsonMode, parse_json};
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
fn value(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
}
fn text(text: &str) -> JsValue {
    JsValue::String(JsString::from_str(text))
}

#[test]
fn facade_single_events_return_null_and_batch_keeps_its_receipt() {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(0.0), value("{}")],
    )
    .unwrap();
    let events = [
        r#"{"kind":"append","bar":{"time":1,"open":2,"high":3,"low":1,"close":2,"volume":1}}"#,
        r#"{"kind":"update","bar":{"time":1,"open":3,"high":4,"low":2,"close":3,"volume":1}}"#,
        r#"{"kind":"correction","bar":{"time":1,"open":4,"high":5,"low":3,"close":4,"volume":1}}"#,
        r#"{"kind":"prepend","bars":[{"time":0,"open":1,"high":2,"low":0,"close":1,"volume":1}]}"#,
        r#"{"kind":"reset","bars":[{"time":5,"open":5,"high":6,"low":4,"close":5,"volume":1}]}"#,
    ];
    for event in events {
        let result = call(
            &mut engine,
            "nativeCommand",
            &[text("applyDataEvent"), JsValue::Array(vec![value(event)])],
        )
        .unwrap();
        assert!(matches!(result, JsValue::Null), "{event}: {result:?}");
    }
    let receipt = call(&mut engine, "nativeCommand", &[
        text("applyDataEvent"), value(r#"[{"kind":"batch","events":[{"kind":"append","bar":{"time":6,"open":6,"high":7,"low":5,"close":6,"volume":1}}]}]"#)
    ]).unwrap();
    let JsValue::Object(receipt) = &receipt else {
        panic!("batch receipt")
    };
    assert!(matches!(
        receipt.get(&JsString::from_str("events")),
        Some(JsValue::Number(1.0))
    ));
    assert_eq!(engine.data_state().unwrap().store().length(), 2);
}
#[test]
fn commands_and_scene_share_the_initialized_chart_and_real_indicator_engine() {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(
        &mut engine,
        "nativeInit",
        &[
            JsValue::Number(32.0),
            value(r#"{"series":[{"id":"price","type":"candles","panel":"price"}]}"#),
        ],
    )
    .unwrap();
    call(
        &mut engine,
        "nativeCommand",
        &[text("addIndicator"), value(r#"["e","ema",{"period":3}]"#)],
    )
    .unwrap();
    call(
        &mut engine,
        "nativeCommand",
        &[
            text("addSeries"),
            value(r#"[{"id":"e-line","type":"line","panel":"price","indicator":"e"}]"#),
        ],
    )
    .unwrap();
    let JsValue::String(ref scene) = call(
        &mut engine,
        "nativeSceneJSON",
        &[JsValue::Number(400.0), JsValue::Number(300.0)],
    )
    .unwrap() else {
        panic!("scene text")
    };
    let scene = scene.to_string_lossy();
    assert!(
        scene.contains("\"op\":\"rects\""),
        "missing renderer command"
    );
    assert!(
        scene.contains("\"op\":\"path\""),
        "missing renderer command"
    );
    let before = engine.data_state().unwrap().store().clone();
    assert!(
        call(
            &mut engine,
            "nativeInit",
            &[JsValue::Number(2.0), value(r#"{"axisWidth":-1}"#)]
        )
        .is_err()
    );
    assert_eq!(engine.data_state().unwrap().store(), &before);
    let JsValue::Object(ref inspect) =
        call(&mut engine, "nativeCommand", &[text("inspect")]).unwrap()
    else {
        panic!("inspect")
    };
    assert!(matches!(
        inspect.get(&JsString::from_str("storedBars")),
        Some(JsValue::Number(32.0))
    ));
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(value) = value else {
        panic!("object")
    };
    value.get(&JsString::from_str(name)).unwrap()
}
fn frame(engine: &mut Engine, token: &str) -> JsValue {
    let packet_value = call(
        engine,
        "nativeScenePacket",
        &[
            text("frame"),
            text(token),
            JsValue::Number(400.0),
            JsValue::Number(300.0),
            JsValue::Bool(false),
        ],
    )
    .unwrap();
    let JsValue::String(metadata) = field(&packet_value, "metadata") else {
        panic!("metadata")
    };
    value(&metadata.to_string_lossy())
}
#[test]
fn renderer_token_frames_reuse_base_and_drawing_and_resolve_real_hover() {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(
        &mut engine,
        "nativeInit",
        &[
            JsValue::Number(32.0),
            value(r#"{"series":[{"id":"price","type":"candles","panel":"price"}]}"#),
        ],
    )
    .unwrap();
    let first = frame(&mut engine, "view-a");
    let JsValue::Array(layers) = field(&first, "layers") else {
        panic!("layers")
    };
    assert!(matches!(layers[0], JsValue::Object(_)));
    assert!(matches!(layers[1], JsValue::Object(_)));
    let second = frame(&mut engine, "view-a");
    let JsValue::Array(layers) = field(&second, "layers") else {
        panic!("layers")
    };
    assert!(matches!(layers[0], JsValue::Null));
    assert!(matches!(layers[1], JsValue::Null));
    call(
        &mut engine,
        "nativePointer",
        &[
            text("move"),
            JsValue::Number(7.0),
            JsValue::Number(100.0),
            JsValue::Number(100.0),
        ],
    )
    .unwrap();
    let hover = frame(&mut engine, "view-a");
    let JsValue::Array(layers) = field(&hover, "layers") else {
        panic!("layers")
    };
    assert!(matches!(layers[0], JsValue::Null));
    assert!(matches!(layers[1], JsValue::Null));
    assert!(matches!(field(&layers[2],"commands"),JsValue::Number(value)if *value>0.0));
    let other = frame(&mut engine, "view-b");
    let JsValue::Array(layers) = field(&other, "layers") else {
        panic!("layers")
    };
    assert!(matches!(layers[0], JsValue::Object(_)));
    call(&mut engine, "nativeReleaseFrameCache", &[text("view-a")]).unwrap();
    let recreated = frame(&mut engine, "view-a");
    let JsValue::Array(layers) = field(&recreated, "layers") else {
        panic!("layers")
    };
    assert!(matches!(layers[0], JsValue::Object(_)));
}
#[test]
fn command_controller_context_and_source_renderer_token_limit_are_real() {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(0.0), value("{}")],
    )
    .unwrap();
    call(
        &mut engine,
        "nativeCommand",
        &[text("setTool"), value("[\"horizontal\"]")],
    )
    .unwrap();
    let inspect = call(&mut engine, "nativeCommand", &[text("inspect")]).unwrap();
    assert!(
        matches!(field(&inspect,"tool"),JsValue::String(value)if value==&JsString::from_str("horizontal"))
    );
    for i in 0..64 {
        let _ = frame(&mut engine, &format!("v{i}"));
    }
    let error = call(
        &mut engine,
        "nativeRenderFrameJSON",
        &[
            text("excess"),
            JsValue::Number(400.0),
            JsValue::Number(300.0),
        ],
    )
    .unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_eq!(
        error.message,
        JsString::from_str("Native frame cache count")
    );
    call(&mut engine, "nativeReleaseFrameCaches", &[]).unwrap();
    let _ = frame(&mut engine, "excess");
}

#[test]
fn crosshair_and_accessibility_reads_share_real_controller_and_layout() {
    let mut engine = Engine::new(Box::new(EmptyHost));
    call(&mut engine,"nativeInit",&[JsValue::Number(8.0),value(r#"{"axes":[{"id":"secondary","panel":"price","side":"left","range":[0,1000]}],"series":[{"id":"price","type":"candles","panel":"price"}]}"#)]).unwrap();
    call(
        &mut engine,
        "nativeCommand",
        &[text("setVisibleRange"), value("[-0.5,7.5]")],
    )
    .unwrap();
    call(
        &mut engine,
        "nativeResize",
        &[JsValue::Number(400.0), JsValue::Number(300.0)],
    )
    .unwrap();
    call(
        &mut engine,
        "nativePointer",
        &[
            text("move"),
            JsValue::Number(9.0),
            JsValue::Number(100.0),
            JsValue::Number(120.0),
        ],
    )
    .unwrap();
    let semantic = call(
        &mut engine,
        "nativeCommand",
        &[text("crosshairValues"), value("[400,300]")],
    )
    .unwrap();
    assert!(
        matches!(field(&semantic,"index"),JsValue::Number(value)if value.to_bits()==(-0.0f64).to_bits())
    );
    let summary = call(&mut engine, "nativeAccessibility", &[JsValue::Bool(false)]).unwrap();
    assert!(matches!(field(&summary, "bars"), JsValue::Number(8.0)));
    assert!(matches!(field(&summary, "crosshair"), JsValue::Object(_)));
    let uikit = call(
        &mut engine,
        "nativeAccessibilityText",
        &[JsValue::Bool(false), text("uikit")],
    )
    .unwrap();
    let JsValue::String(uikit) = &uikit else {
        panic!("text")
    };
    assert!(uikit.to_string_lossy().starts_with("8 bars;"));
    call(&mut engine, "nativeHoverExit", &[]).unwrap();
    let snapshot = call(
        &mut engine,
        "nativeCommand",
        &[text("crosshairSnapshot"), value("[400,300]")],
    )
    .unwrap();
    assert!(matches!(snapshot, JsValue::Null));
}
