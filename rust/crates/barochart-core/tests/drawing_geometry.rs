use barochart_core::{axis_scale, drawing_geometry};

use std::sync::Arc;

use axis_scale::{AxisScale, AxisScaleInput, AxisScaleKind};
use barochart_core::data::{BarStore, ModelDataState, StoreOptions};
use barochart_core::drawing_validation::validate_drawing;
use barochart_core::model_state::{ModelState, VisibleRange};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawing_geometry::{
    DrawingAxisView, DrawingGeometryCache, DrawingProjection, ScreenPoint, drawing_geometry,
};

const FIXTURE: &str = include_str!("../../../../test/fixtures/rust-model/scene-oracle.jsonl");

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object required: {value:?}")
    };
    value
}

fn get<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    object(value)
        .get(&JsString::from_str(key))
        .unwrap_or_else(|| panic!("missing {key}: {value:?}"))
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array required: {value:?}")
    };
    value
}

fn text(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string required: {value:?}")
    };
    value.to_string_lossy()
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required: {value:?}")
    };
    *value
}

fn f64_hex(value: f64) -> String {
    let bits = if value.is_nan() {
        f64::NAN.to_bits()
    } else {
        value.to_bits()
    };
    format!("{bits:016x}")
}

fn from_hex(value: &JsValue) -> f64 {
    f64::from_bits(u64::from_str_radix(&text(value), 16).unwrap())
}

fn tagged(key: &str, value: JsValue) -> JsValue {
    let mut object = JsObject::new();
    object.insert(JsString::from_str(key), value);
    JsValue::Object(object)
}

fn decode_wire(value: &JsValue) -> JsValue {
    let JsValue::Object(encoded) = value else {
        return match value {
            JsValue::Array(values) => JsValue::Array(values.iter().map(decode_wire).collect()),
            _ => value.clone(),
        };
    };
    if encoded.len() == 1 {
        if let Some(bits) = encoded.get(&JsString::from_str("$f64")) {
            return JsValue::Number(from_hex(bits));
        }
        if encoded.get(&JsString::from_str("$undefined")).is_some() {
            return JsValue::Undefined;
        }
        if let Some(entries) = encoded.get(&JsString::from_str("$object")) {
            let mut output = JsObject::new();
            for entry in array(entries) {
                let entry = array(entry);
                output.insert(JsString::from_str(&text(&entry[0])), decode_wire(&entry[1]));
            }
            return JsValue::Object(output);
        }
    }
    let mut output = JsObject::new();
    for (key, child) in encoded.iter() {
        output.insert(key.clone(), decode_wire(child));
    }
    JsValue::Object(output)
}

fn encode_wire(value: &JsValue) -> JsValue {
    match value {
        JsValue::Number(value) => tagged(
            "$f64",
            JsValue::String(JsString::from_str(&f64_hex(*value))),
        ),
        JsValue::Undefined => tagged("$undefined", JsValue::Bool(true)),
        JsValue::Array(values) => JsValue::Array(values.iter().map(encode_wire).collect()),
        JsValue::Object(value) => tagged(
            "$object",
            JsValue::Array(
                value
                    .iter()
                    .map(|(key, child)| {
                        JsValue::Array(vec![JsValue::String(key.clone()), encode_wire(child)])
                    })
                    .collect(),
            ),
        ),
        _ => value.clone(),
    }
}

fn json(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Standard)).unwrap()
}

fn expected_commands(row: &JsValue) -> &JsValue {
    #[cfg(target_vendor = "apple")]
    if let Some(expected) = object(row).get(&JsString::from_str("expectedJsc")) {
        return expected;
    }
    get(row, "expectedV8")
}

struct TestAxis {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    scale: AxisScale,
}

impl DrawingAxisView for TestAxis {
    fn left(&self) -> f64 {
        self.left
    }
    fn right(&self) -> f64 {
        self.right
    }
    fn top(&self) -> f64 {
        self.top
    }
    fn bottom(&self) -> f64 {
        self.bottom
    }
    fn scale(&self) -> &AxisScale {
        &self.scale
    }
}

struct TestLayout {
    key: JsString,
    font: JsValue,
    axis: TestAxis,
    missing_axis: bool,
}

impl DrawingProjection for TestLayout {
    type Axis = TestAxis;

    fn geometry_key(&self) -> &JsString {
        &self.key
    }

    fn geometry_font(&self) -> &JsValue {
        &self.font
    }

    fn drawing_axis(
        &self,
        _current_model: &ModelState,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
        series_id: Option<&JsString>,
    ) -> Option<&Self::Axis> {
        (!self.missing_axis
            && panel_id == &JsString::from_str("price")
            && axis_id.is_none()
            && series_id.is_none())
        .then_some(&self.axis)
    }

    fn to_screen(
        &self,
        current_view: VisibleRange,
        _current_store: &BarStore,
        time: f64,
        price: f64,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
    ) -> ScreenPoint {
        if self.missing_axis || panel_id != &JsString::from_str("price") || axis_id.is_some() {
            return ScreenPoint {
                x: f64::NAN,
                y: f64::NAN,
            };
        }
        let index = time / 60_000.0;
        ScreenPoint {
            x: self.axis.left
                + (index - current_view.from) / (current_view.to - current_view.from)
                    * (self.axis.right - self.axis.left),
            y: self.axis.scale.y(price),
        }
    }

    fn index(&self, current_view: VisibleRange, screen_x: f64) -> f64 {
        current_view.from
            + (screen_x - self.axis.left) / (self.axis.right - self.axis.left)
                * (current_view.to - current_view.from)
    }
}

fn layout(row: &JsValue) -> (VisibleRange, TestLayout) {
    let spec = decode_wire(get(row, "layout"));
    let scale = match text(get(&spec, "scale")).as_str() {
        "linear" => AxisScaleKind::Linear,
        "log" => AxisScaleKind::Log,
        "percent" => AxisScaleKind::Percent,
        value => panic!("scale {value}"),
    };
    let left = number(get(&spec, "left"));
    let right = number(get(&spec, "right"));
    let top = number(get(&spec, "top"));
    let bottom = number(get(&spec, "bottom"));
    let min = number(get(&spec, "min"));
    let max = number(get(&spec, "max"));
    let base = number(get(&spec, "base"));
    let axis = AxisScale::new(AxisScaleInput {
        source_min: min,
        source_max: max,
        scale,
        padding: 0.0,
        range: Some([min, max]),
        base: Some(base),
        first_close: Some(base),
        zero_baseline: false,
        inverted: false,
        top,
        bottom,
    })
    .unwrap();
    (
        VisibleRange {
            from: number(get(&spec, "from")),
            to: number(get(&spec, "to")),
        },
        TestLayout {
            key: JsString::from_str(&text(get(row, "id"))),
            font: get(&spec, "font").clone(),
            axis: TestAxis {
                left,
                right,
                top,
                bottom,
                scale: axis,
            },
            missing_axis: text(get(row, "id")) == "drawing-unbound",
        },
    )
}

fn fixture_rows() -> Vec<JsValue> {
    FIXTURE.lines().map(parse).collect()
}

fn drawing_rows() -> Vec<JsValue> {
    FIXTURE
        .lines()
        .map(parse)
        .filter(|row| {
            object(row)
                .get(&JsString::from_str("kind"))
                .is_some_and(|value| text(value) == "drawing")
        })
        .collect()
}

#[test]
fn fixture_metadata_and_all_sixteen_types_are_present() {
    let rows = fixture_rows();
    let header = &rows[0];
    assert_eq!(
        text(get(header, "schema")),
        "barochart.rust-model.scene-oracle"
    );
    assert_eq!(text(get(header, "node")), "v22.20.0");
    let drawings = drawing_rows();
    assert_eq!(drawings.len(), 20);
    let kinds: Vec<String> = drawings
        .iter()
        .map(|row| {
            let input = decode_wire(get(row, "input"));
            text(get(&input, "type"))
        })
        .collect();
    for kind in barochart_core::drawing_validation::DRAWING_TYPES {
        assert!(kinds.iter().any(|candidate| candidate == kind), "{kind}");
    }
}

#[test]
fn actual_js_geometry_matches_commands_order_and_platform_log_math() {
    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let store = data.store();
    let model = ModelState::new(store, &JsValue::Undefined).unwrap();
    for row in drawing_rows() {
        let id = text(get(&row, "id"));
        let input = decode_wire(get(&row, "input"));
        let drawing = Arc::new(validate_drawing(&input).unwrap());
        let (view, layout) = layout(&row);
        let mut cache = DrawingGeometryCache::new(4);
        let first = drawing_geometry(
            &mut cache,
            &drawing,
            &model,
            view,
            store,
            &layout,
            NumberDialect::PLATFORM,
        )
        .unwrap();
        assert_eq!(
            json(&encode_wire(&JsValue::Array(
                first.iter().cloned().collect()
            ))),
            json(expected_commands(&row)),
            "{id}"
        );
        let second = drawing_geometry(
            &mut cache,
            &drawing,
            &model,
            view,
            store,
            &layout,
            NumberDialect::PLATFORM,
        )
        .unwrap();
        assert!(Arc::ptr_eq(&first, &second), "cache hit {id}");
    }
}

#[test]
fn cache_is_chart_owned_bounded_and_dead_identity_cannot_hit() {
    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let store = data.store();
    let model = ModelState::new(store, &JsValue::Undefined).unwrap();
    let mut cache = DrawingGeometryCache::new(2);
    assert!(cache.is_empty());
    let fixture_rows = drawing_rows();
    let mut first_result = None;
    let mut retained_drawings = Vec::new();
    for row in fixture_rows.iter().take(3) {
        let input = decode_wire(get(row, "input"));
        let drawing = Arc::new(validate_drawing(&input).unwrap());
        let (view, layout) = layout(row);
        let result = drawing_geometry(
            &mut cache,
            &drawing,
            &model,
            view,
            store,
            &layout,
            NumberDialect::PLATFORM,
        )
        .unwrap();
        if first_result.is_none() {
            first_result = Some(result);
        }
        retained_drawings.push(drawing);
        assert!(cache.len() <= 2);
    }
    assert_eq!(cache.len(), 2);
    let row = &fixture_rows[0];
    let replacement = Arc::new(validate_drawing(&decode_wire(get(row, "input"))).unwrap());
    let (view, layout) = layout(row);
    let result = drawing_geometry(
        &mut cache,
        &replacement,
        &model,
        view,
        store,
        &layout,
        NumberDialect::PLATFORM,
    )
    .unwrap();
    assert!(!Arc::ptr_eq(first_result.as_ref().unwrap(), &result));
}

#[test]
fn accounted_geometry_cache_hit_shares_one_payload_lease_and_drop_releases_all() {
    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let store = data.store();
    let model = ModelState::new(store, &JsValue::Undefined).unwrap();
    let rows = drawing_rows();
    let row = &rows[0];
    let drawing = Arc::new(validate_drawing(&decode_wire(get(row, "input"))).unwrap());
    let (view, layout) = layout(row);
    let account = MemoryAccount::new(8 << 20, OomStyle::InternalErrorLowercase);
    let mut cache =
        DrawingGeometryCache::new_with_memory(2, MemoryContext::accounted(&account)).unwrap();
    let empty_cache_bytes = account.snapshot().requested_live_bytes;
    assert_eq!(empty_cache_bytes, 0);

    let first = drawing_geometry(
        &mut cache,
        &drawing,
        &model,
        view,
        store,
        &layout,
        NumberDialect::PLATFORM,
    )
    .unwrap();
    assert!(first.requested_bytes() > 0);
    let after_miss = account.snapshot().requested_live_bytes;
    assert!(after_miss > empty_cache_bytes);
    let second = drawing_geometry(
        &mut cache,
        &drawing,
        &model,
        view,
        store,
        &layout,
        NumberDialect::PLATFORM,
    )
    .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(account.snapshot().requested_live_bytes, after_miss);

    drop(first);
    drop(second);
    assert_eq!(account.snapshot().requested_live_bytes, after_miss);
    drop(drawing);
    drop(cache);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn screen_projection_uses_explicit_current_view_and_store_arguments() {
    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let rows = drawing_rows();
    let row = &rows[0];
    let (_, layout) = layout(row);
    assert_eq!(text(layout.geometry_font()), "12px monospace");
    let first = layout.to_screen(
        VisibleRange {
            from: 0.0,
            to: 60.0,
        },
        data.store(),
        600_000.0,
        100.0,
        &JsString::from_str("price"),
        None,
    );
    let shifted = layout.to_screen(
        VisibleRange {
            from: 10.0,
            to: 70.0,
        },
        data.store(),
        600_000.0,
        100.0,
        &JsString::from_str("price"),
        None,
    );
    assert_ne!(first.x.to_bits(), shifted.x.to_bits());
    assert_eq!(
        layout.index(
            VisibleRange {
                from: 10.0,
                to: 70.0,
            },
            shifted.x,
        ),
        10.0
    );
}
