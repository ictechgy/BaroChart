use barochart_core::interaction;
use barochart_core::{
    Host, HostError, data, drawing_geometry, drawings, indicator_engine, model_state, scene,
    scene_parts, series_cache,
};

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use data::{Bar, ModelDataState, StoreOptions};
use drawing_geometry::DrawingGeometryCache;
use drawings::DrawingStore;
use indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use interaction::{
    InteractionContext, InteractionInvalidation, InteractionKeyModifiers, OwnedInteractionState,
};
use model_state::{ModelContext, ModelState};
use series_cache::SeriesCaches;

const INTERACTION_FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-model/interaction-oracle.jsonl");

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

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
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

#[test]
fn pan_cancel_restores_the_owned_view_and_pointer_map() {
    let host = NoZones;
    let bars = (0..20).map(bar).collect();
    let data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
    let store = data.store();
    let options = parse(r#"{"panels":[{"id":"price","weight":1}],"visibleBars":20}"#);
    let mut model = ModelState::new(store, &options).unwrap();
    model
        .add_series(
            &parse(r#"{"id":"bars","type":"candles","panel":"price"}"#),
            &ModelContext::plain(store),
        )
        .unwrap();
    model
        .set_visible_range(store, &JsValue::Number(0.0), &JsValue::Number(10.0))
        .unwrap();
    let original = (model.view.from, model.view.to, model.follow);
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
    let mut caches = SeriesCaches::new();
    let mut geometry_cache = DrawingGeometryCache::new(32);
    let mut controller = OwnedInteractionState::new();
    let mut context = InteractionContext {
        model: &mut model,
        store: data.store(),
        indicators: &mut indicators,
        drawings: &mut drawings,
        series_caches: &mut caches,
        geometry_cache: &mut geometry_cache,
        host: &host,
        width: 894.0,
        height: 446.0,
    };
    let layout = context.layout().unwrap();
    let panel = &layout.panels[0];
    let x = panel.left + 0.5 * (panel.right - panel.left);
    let y = panel.top + 0.5 * (panel.bottom - panel.top);
    let down = controller.down(&mut context, text("1"), x, y, 8.0).unwrap();
    assert_eq!(down.invalidations, vec![InteractionInvalidation::Drawings]);
    controller
        .move_pointer(&mut context, &text("1"), x + 20.0, y)
        .unwrap();
    assert_ne!(
        (context.model.view.from, context.model.view.to),
        (original.0, original.1)
    );
    controller.cancel(&mut context, true, false).unwrap();
    assert_eq!(
        (
            context.model.view.from,
            context.model.view.to,
            context.model.follow
        ),
        original
    );
    assert_eq!(controller.pointer_count(), 0);
    assert_eq!(controller.gesture_kind(), None);
}

fn wire_object(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in entries {
        object.insert(JsString::from_str(name), value);
    }
    JsValue::Object(object)
}

fn wire_field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    let JsValue::Object(object) = value else {
        return None;
    };
    object.get(&JsString::from_str(name))
}

fn wire_array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(values) = value else {
        panic!("array required: {value:?}");
    };
    values
}

fn wire_number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required: {value:?}");
    };
    *value
}

fn wire_text(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string required: {value:?}");
    };
    value.to_string_lossy()
}

fn decode_oracle(value: &JsValue) -> JsValue {
    let JsValue::Object(object) = value else {
        return match value {
            JsValue::Array(values) => JsValue::Array(values.iter().map(decode_oracle).collect()),
            other => other.clone(),
        };
    };
    if let Some(JsValue::String(hex)) = object.get(&JsString::from_str("$f64")) {
        let bits = u64::from_str_radix(&hex.to_string_lossy(), 16).unwrap();
        return JsValue::Number(f64::from_bits(bits));
    }
    if matches!(
        object.get(&JsString::from_str("$undefined")),
        Some(JsValue::Bool(true))
    ) {
        return JsValue::Undefined;
    }
    if let Some(JsValue::Array(entries)) = object.get(&JsString::from_str("$object")) {
        let mut decoded = JsObject::new();
        for entry in entries {
            let pair = wire_array(entry);
            let name = match pair.first() {
                Some(JsValue::String(name)) => name.clone(),
                _ => panic!("oracle object key required"),
            };
            decoded.insert(name, decode_oracle(&pair[1]));
        }
        return JsValue::Object(decoded);
    }
    if let Some(JsValue::Array(values)) = object.get(&JsString::from_str("$f64array")) {
        return JsValue::Array(values.iter().map(decode_oracle).collect());
    }
    let mut decoded = JsObject::new();
    for (name, value) in object.iter() {
        decoded.insert(name.clone(), decode_oracle(value));
    }
    JsValue::Object(decoded)
}

fn encode_wire(value: &JsValue) -> JsValue {
    match value {
        JsValue::Undefined => wire_object([("$undefined", JsValue::Bool(true))]),
        JsValue::Null | JsValue::Bool(_) | JsValue::String(_) => value.clone(),
        JsValue::Number(number) => {
            let bits = if number.is_nan() {
                f64::NAN.to_bits()
            } else {
                number.to_bits()
            };
            wire_object([(
                "$f64",
                JsValue::String(JsString::from_str(&format!("{bits:016x}"))),
            )])
        }
        JsValue::Array(values) => JsValue::Array(values.iter().map(encode_wire).collect()),
        JsValue::Object(values) => wire_object([(
            "$object",
            JsValue::Array(
                values
                    .iter()
                    .map(|(name, value)| {
                        JsValue::Array(vec![JsValue::String(name.clone()), encode_wire(value)])
                    })
                    .collect(),
            ),
        )]),
    }
}

fn wire_json(value: &JsValue) -> String {
    String::from_utf8(stringify_json(&encode_wire(value), JsonMode::Standard)).unwrap()
}

fn first_wire_diff(path: &str, actual: &JsValue, expected: &JsValue) -> Option<String> {
    match (actual, expected) {
        (JsValue::Array(actual), JsValue::Array(expected)) => {
            if actual.len() != expected.len() {
                return Some(format!(
                    "{path}.length: {} != {}",
                    actual.len(),
                    expected.len()
                ));
            }
            actual
                .iter()
                .zip(expected)
                .enumerate()
                .find_map(|(index, (a, e))| first_wire_diff(&format!("{path}[{index}]"), a, e))
        }
        (JsValue::Object(actual), JsValue::Object(expected)) => {
            if actual.len() != expected.len() {
                return Some(format!(
                    "{path}.keys: {} != {}",
                    actual.len(),
                    expected.len()
                ));
            }
            actual
                .iter()
                .zip(expected.iter())
                .find_map(|((a_key, a), (e_key, e))| {
                    if a_key != e_key {
                        Some(format!("{path}.key-order: {a_key:?} != {e_key:?}"))
                    } else {
                        first_wire_diff(&format!("{path}.{}", a_key.to_string_lossy()), a, e)
                    }
                })
        }
        _ if wire_json(actual) == wire_json(expected) => None,
        _ => Some(format!(
            "{path}: actual={} expected={}",
            wire_json(actual),
            wire_json(expected)
        )),
    }
}

fn without_viewport(value: &JsValue) -> JsValue {
    let JsValue::Object(fields) = value else {
        return value.clone();
    };
    let mut portable = JsObject::new();
    for (name, value) in fields.iter() {
        if name == &JsString::from_str("gesture") {
            let JsValue::Object(gesture) = value else {
                portable.insert(name.clone(), value.clone());
                continue;
            };
            let mut portable_gesture = JsObject::new();
            for (field, child) in gesture.iter() {
                if field == &JsString::from_str("viewport") {
                    continue;
                }
                if field == &JsString::from_str("projection") {
                    let JsValue::Array(values) = child else {
                        panic!("drawing projection array required");
                    };
                    let mut values = values.clone();
                    values[11] = JsValue::String(JsString::from_str("<store-identity>"));
                    portable_gesture.insert(field.clone(), JsValue::Array(values));
                } else {
                    portable_gesture.insert(field.clone(), child.clone());
                }
            }
            portable.insert(name.clone(), JsValue::Object(portable_gesture));
        } else if name == &JsString::from_str("crosshairPointer") {
            let JsValue::Object(pointer) = value else {
                portable.insert(name.clone(), value.clone());
                continue;
            };
            let mut portable_pointer = JsObject::new();
            for (field, child) in pointer.iter() {
                if field != &JsString::from_str("identity") {
                    portable_pointer.insert(field.clone(), child.clone());
                }
            }
            portable.insert(name.clone(), JsValue::Object(portable_pointer));
        } else {
            portable.insert(name.clone(), value.clone());
        }
    }
    JsValue::Object(portable)
}

fn kind_name(kind: model_state::SeriesKind) -> &'static str {
    match kind {
        model_state::SeriesKind::Candles => "candles",
        model_state::SeriesKind::Ohlc => "ohlc",
        model_state::SeriesKind::Line => "line",
        model_state::SeriesKind::Area => "area",
        model_state::SeriesKind::Histogram => "histogram",
    }
}

fn scene_snapshot(
    controller: &OwnedInteractionState,
    context: &mut InteractionContext<'_>,
    width: f64,
    height: f64,
) -> JsValue {
    let layout = context.layout().unwrap();
    let resolved_crosshair = controller.resolve_crosshair(context, &layout);
    let theme = scene_parts::SceneTheme::from_model(context.model).unwrap();
    let series: Vec<_> = context
        .model
        .series
        .iter()
        .map(|series| scene::SeriesRenderInput {
            series,
            values: None,
            range: None,
        })
        .collect();
    let scene = scene::build_scene(scene::SceneInput {
        model: context.model,
        store: context.store,
        layout: &layout,
        series: &series,
        theme: &theme,
        symbol: None,
        host: context.host,
        drawings: Some(context.drawings),
        drawing_cache: context.geometry_cache,
        resolved_crosshair: resolved_crosshair.as_ref(),
        width,
        height,
        include_drawings: true,
        include_crosshair: true,
        dialect: NumberDialect::PLATFORM,
    })
    .unwrap();
    let mut scene_object = match &scene {
        JsValue::Object(scene_object) => scene_object.clone(),
        _ => panic!("scene object required"),
    };
    let layout_key = JsString::from_str("layout");
    let mut scene_layout = match scene_object.get(&layout_key) {
        Some(JsValue::Object(scene_layout)) => scene_layout.clone(),
        _ => panic!("scene layout object required"),
    };
    let geometry_key = JsString::from_str("geometryKey");
    let key_text = match scene_layout.get(&geometry_key) {
        Some(JsValue::String(key_text)) => key_text.to_string_lossy(),
        _ => panic!("scene geometry key required"),
    };
    let mut geometry: JsValue = parse(&key_text);
    let JsValue::Array(parts) = &mut geometry else {
        panic!("scene geometry key array required");
    };
    parts[4] = JsValue::String(JsString::from_str("<store-identity>"));
    let geometry_text = String::from_utf8(stringify_json(&geometry, JsonMode::Standard)).unwrap();
    scene_layout.insert(
        geometry_key,
        JsValue::String(JsString::from_str(&geometry_text)),
    );
    scene_object.insert(layout_key, JsValue::Object(scene_layout));
    JsValue::Object(scene_object)
}

fn model_snapshot(context: &InteractionContext<'_>) -> JsValue {
    let series = context
        .model
        .series
        .iter()
        .map(|series| {
            wire_object([
                ("id", JsValue::String(series.id.clone())),
                (
                    "type",
                    JsValue::String(JsString::from_str(kind_name(series.kind))),
                ),
                ("panel", JsValue::String(series.panel.clone())),
            ])
        })
        .collect();
    let drawings = context
        .drawings
        .items()
        .iter()
        .map(|drawing| {
            wire_object([
                ("id", JsValue::String(drawing.id.clone())),
                (
                    "type",
                    JsValue::String(JsString::from_str(drawing.kind.as_js())),
                ),
                ("panel", JsValue::String(drawing.panel.clone())),
                (
                    "points",
                    JsValue::Array(
                        drawing
                            .points
                            .iter()
                            .map(|point| point.to_value())
                            .collect(),
                    ),
                ),
                ("locked", JsValue::Bool(drawing.locked == Some(true))),
                ("visible", JsValue::Bool(drawing.visible != Some(false))),
                (
                    "axisId",
                    drawing
                        .axis_id
                        .clone()
                        .map_or(JsValue::Null, JsValue::String),
                ),
                (
                    "seriesId",
                    drawing
                        .series_id
                        .clone()
                        .map_or(JsValue::Null, JsValue::String),
                ),
            ])
        })
        .collect();
    wire_object([
        (
            "view",
            wire_object([
                ("from", JsValue::Number(context.model.view.from)),
                ("to", JsValue::Number(context.model.view.to)),
            ]),
        ),
        ("follow", JsValue::Bool(context.model.follow)),
        (
            "selected",
            context
                .drawings
                .selected()
                .cloned()
                .map_or(JsValue::Null, JsValue::String),
        ),
        ("series", JsValue::Array(series)),
        ("drawings", JsValue::Array(drawings)),
    ])
}

fn dispatch(
    controller: &mut OwnedInteractionState,
    context: &mut InteractionContext<'_>,
    event: &JsValue,
) -> Result<interaction::InteractionEffects, JsError> {
    let kind = wire_text(wire_field(event, "kind").expect("event kind"));
    match kind.as_str() {
        "down" => controller.down(
            context,
            wire_field(event, "id").expect("pointer id").clone(),
            wire_number(wire_field(event, "x").expect("pointer x")),
            wire_number(wire_field(event, "y").expect("pointer y")),
            wire_field(event, "hitTolerance").map_or(8.0, wire_number),
        ),
        "move" => controller.move_pointer(
            context,
            wire_field(event, "id").expect("pointer id"),
            wire_number(wire_field(event, "x").expect("pointer x")),
            wire_number(wire_field(event, "y").expect("pointer y")),
        ),
        "up" => controller.up(context, wire_field(event, "id").expect("pointer id")),
        "cancel" => controller.cancel(context, true, false),
        "wheel" => controller.wheel(
            context,
            wire_field(event, "delta").expect("wheel delta"),
            wire_field(event, "x").expect("wheel x"),
        ),
        "key" => controller.key(
            context,
            match wire_field(event, "key") {
                Some(JsValue::String(key)) => key,
                _ => panic!("keyboard key required"),
            },
            InteractionKeyModifiers {
                ctrl: matches!(wire_field(event, "ctrl"), Some(JsValue::Bool(true))),
                shift: matches!(wire_field(event, "shift"), Some(JsValue::Bool(true))),
            },
        ),
        "setTool" => controller.set_tool(
            context,
            wire_field(event, "tool").expect("tool value"),
            !matches!(wire_field(event, "notify"), Some(JsValue::Bool(false))),
        ),
        "setTarget" => controller.set_drawing_target(
            context,
            wire_field(event, "target").expect("target value"),
            !matches!(wire_field(event, "notify"), Some(JsValue::Bool(false))),
        ),
        "setMagnet" => controller.set_drawing_magnet(
            context,
            wire_field(event, "options").expect("magnet options"),
            !matches!(wire_field(event, "notify"), Some(JsValue::Bool(false))),
        ),
        "releaseCrosshair" => controller
            .release_crosshair()
            .map(|()| interaction::InteractionEffects::default()),
        "setSnap" => controller.set_crosshair_snap(
            context,
            wire_field(event, "options").expect("snap options"),
            !matches!(wire_field(event, "notify"), Some(JsValue::Bool(false))),
        ),
        _ => panic!("unsupported fixture event: {kind}"),
    }
}

fn bars_from_fixture(value: &JsValue) -> Vec<Bar> {
    wire_array(value)
        .iter()
        .map(|value| Bar {
            time: wire_number(wire_field(value, "time").unwrap()),
            open: wire_number(wire_field(value, "open").unwrap()),
            high: wire_number(wire_field(value, "high").unwrap()),
            low: wire_number(wire_field(value, "low").unwrap()),
            close: wire_number(wire_field(value, "close").unwrap()),
            volume: wire_number(wire_field(value, "volume").unwrap()),
        })
        .collect()
}

fn run_oracle_case(case: &JsValue) {
    let id = wire_text(wire_field(case, "id").expect("case id"));
    let input = wire_field(case, "input").expect("case input");
    let width = wire_number(wire_field(input, "width").unwrap());
    let height = wire_number(wire_field(input, "height").unwrap());
    let data = ModelDataState::new(
        StoreOptions::default(),
        bars_from_fixture(wire_field(input, "bars").unwrap()),
    )
    .unwrap();
    let options = wire_field(input, "model").expect("model options");
    let mut model = ModelState::new(data.store(), options).unwrap();
    for series in wire_array(wire_field(input, "series").unwrap()) {
        model
            .add_series(series, &ModelContext::plain(data.store()))
            .unwrap();
    }
    let mut drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
    for drawing in wire_array(wire_field(input, "drawings").unwrap()) {
        drawings.add(drawing).unwrap();
    }
    if let Some(JsValue::String(selected)) = wire_field(input, "selected") {
        drawings.select(Some(selected)).unwrap();
    }
    let host = NoZones;
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut caches = SeriesCaches::new();
    let mut geometry_cache = DrawingGeometryCache::new(32);
    let mut controller = OwnedInteractionState::new();
    let mut context = InteractionContext {
        model: &mut model,
        store: data.store(),
        indicators: &mut indicators,
        drawings: &mut drawings,
        series_caches: &mut caches,
        geometry_cache: &mut geometry_cache,
        host: &host,
        width,
        height,
    };
    let events = wire_array(wire_field(input, "events").unwrap());
    let expected = wire_array(wire_field(case, "expected").unwrap());
    assert_eq!(events.len(), expected.len(), "case {id} step count");
    for (step, (event, expected)) in events.iter().zip(expected).enumerate() {
        let (effects, error) = match dispatch(&mut controller, &mut context, event) {
            Ok(effects) => (effects, None),
            Err(error) => (
                interaction::InteractionEffects::default(),
                Some(wire_object([
                    ("name", JsValue::String(JsString::from_str(error.name))),
                    ("message", JsValue::String(error.message)),
                ])),
            ),
        };
        let mut expected_event = match event {
            JsValue::Object(object) => object.clone(),
            _ => panic!("event object required"),
        };
        expected_event.insert(JsString::from_str("kind"), JsValue::Undefined);
        let mut actual = wire_object([
            ("event", JsValue::Object(expected_event)),
            ("invalidations", effects.to_js_value()),
            ("controller", without_viewport(&controller.to_js_value())),
            ("model", model_snapshot(&context)),
            (
                "scene",
                scene_snapshot(&controller, &mut context, width, height),
            ),
        ]);
        if let Some(error) = error {
            let JsValue::Object(fields) = &mut actual else {
                unreachable!("snapshot is an object")
            };
            fields.insert(JsString::from_str("error"), error);
        }
        if let Some(diff) = first_wire_diff("$", &actual, expected) {
            panic!("case {id} step {step}: {diff}");
        }
    }
}

#[test]
fn interaction_matches_pinned_node22_controller_and_scene_oracle() {
    let rows: Vec<_> = INTERACTION_FIXTURE
        .lines()
        .map(|line| decode_oracle(&parse(line)))
        .collect();
    let header = &rows[0];
    assert_eq!(
        wire_text(wire_field(header, "schema").unwrap()),
        "barochart.rust-model.interaction-oracle"
    );
    assert_eq!(rows.len(), 11);
    for case in &rows[1..] {
        run_oracle_case(case);
    }
}
