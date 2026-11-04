use barochart_core::{axis_scale, drawing_geometry, scene_parts};

use axis_scale::{AxisScale, AxisScaleInput, AxisScaleKind};
use barochart_core::data::{BarStore, ModelDataState, StoreOptions};
use barochart_core::drawings::{DrawingStore, DrawingStoreConfig};
use barochart_core::markets::{Adjustment, Symbol};
use barochart_core::model_state::{ModelContext, ModelState, SeriesKind, VisibleRange};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawing_geometry::{DrawingAxisView, DrawingGeometryCache, DrawingProjection, ScreenPoint};
use scene_parts::{
    AggregateVolumeInput, AxisFormatInput, AxisTickFormat, DrawingCommandInput, SceneTheme,
    aggregate_volume_input, aggregate_volume_series, create_drawing_commands, format_axis_value,
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

fn optional<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    object(value).get(&JsString::from_str(key))
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

fn string(value: &JsValue) -> &JsString {
    let JsValue::String(value) = value else {
        panic!("string required: {value:?}")
    };
    value
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

fn rows(kind: &str) -> Vec<JsValue> {
    FIXTURE
        .lines()
        .map(parse)
        .filter(|row| optional(row, "kind").is_some_and(|value| text(value) == kind))
        .collect()
}

fn symbol(decimals: u32) -> Symbol {
    Symbol {
        id: JsString::from_str("TEST"),
        exchange: JsString::from_str("X"),
        timezone: JsString::from_str("+00:00"),
        currency: JsString::from_str("USD"),
        volume_unit: JsString::from_str("shares"),
        price_decimals: decimals,
        tick_size: 0.01,
        adjustment: Adjustment::Raw,
    }
}

#[test]
fn actual_js_axis_format_and_real_symbol_format_match() {
    for row in rows("format") {
        let id = text(get(&row, "id"));
        let input = decode_wire(get(&row, "input"));
        let axis = get(&input, "axis");
        let scale_kind = match text(get(axis, "scale")).as_str() {
            "linear" => AxisScaleKind::Linear,
            "percent" => AxisScaleKind::Percent,
            value => panic!("scale {value}"),
        };
        let base = optional(axis, "base").map(number).unwrap_or(100.0);
        let scale = AxisScale::new(AxisScaleInput {
            source_min: 50.0,
            source_max: 160.0,
            scale: scale_kind,
            padding: 0.0,
            range: Some([50.0, 160.0]),
            base: Some(base),
            first_close: Some(base),
            zero_baseline: false,
            inverted: false,
            top: 0.0,
            bottom: 100.0,
        })
        .unwrap();
        let symbol = optional(&input, "symbol")
            .filter(|value| !matches!(value, JsValue::Null))
            .map(|value| symbol(number(get(value, "priceDecimals")) as u32));
        let axis_id = optional(axis, "axisId").and_then(|value| match value {
            JsValue::String(value) => Some(value),
            _ => None,
        });
        let precision = optional(axis, "precision").map(|value| number(value) as u32);
        let prefix = optional(axis, "prefix").map(string);
        let suffix = optional(axis, "suffix").map(string);
        let formatted = format_axis_value(
            AxisFormatInput {
                id: string(get(axis, "id")),
                axis_id,
                scale: scale_kind,
                precision,
                model_precision: number(get(get(&input, "model"), "precision")) as u32,
                tick_format: if text(get(axis, "tickFormat")) == "scientific" {
                    AxisTickFormat::Scientific
                } else {
                    AxisTickFormat::Fixed
                },
                prefix,
                suffix,
                projection: &scale,
                symbol: symbol.as_ref(),
            },
            number(get(&input, "value")),
            NumberDialect::PLATFORM,
        );
        assert_eq!(
            formatted.to_string_lossy(),
            text(get(&row, "expected")),
            "{id}"
        );
    }
}

fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => false,
        Some(JsValue::Bool(value)) => *value,
        Some(JsValue::Number(value)) => *value != 0.0 && !value.is_nan(),
        Some(JsValue::String(value)) => !value.as_units().is_empty(),
        Some(JsValue::Array(_) | JsValue::Object(_)) => true,
    }
}

#[test]
fn actual_js_aggregate_volume_predicate_matches_raw_inputs_and_series_wrapper() {
    for row in rows("aggregate") {
        let input = decode_wire(get(&row, "input"));
        let kind = match text(get(&input, "type")).as_str() {
            "histogram" => SeriesKind::Histogram,
            "line" => SeriesKind::Line,
            value => panic!("kind {value}"),
        };
        let raw = AggregateVolumeInput {
            kind,
            source_is_volume: optional(&input, "source")
                .is_some_and(|value| text(value) == "volume"),
            has_values: truthy(optional(&input, "values")),
            has_indicator: truthy(optional(&input, "indicator")),
            offset: optional(&input, "offset").map(number).unwrap_or(0.0),
            baseline: optional(&input, "baseline")
                .filter(|value| !matches!(value, JsValue::Null | JsValue::Undefined))
                .map(number)
                .unwrap_or(0.0),
        };
        let JsValue::Bool(expected) = get(&row, "expected") else {
            panic!("expected bool")
        };
        assert_eq!(
            aggregate_volume_input(raw),
            *expected,
            "{}",
            text(get(&row, "id"))
        );
    }

    let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    model
        .add_series(
            &parse(
                r##"{"id":"volume","type":"histogram","panel":"price","source":"volume","color":"#7898ff"}"##,
            ),
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    assert!(aggregate_volume_series(&model.series[0]));
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
        _model: &ModelState,
        panel: &JsString,
        axis: Option<&JsString>,
        series: Option<&JsString>,
    ) -> Option<&Self::Axis> {
        (panel == &JsString::from_str("price") && axis.is_none() && series.is_none())
            .then_some(&self.axis)
    }
    fn to_screen(
        &self,
        view: VisibleRange,
        _store: &BarStore,
        time: f64,
        price: f64,
        panel: &JsString,
        axis: Option<&JsString>,
    ) -> ScreenPoint {
        if panel != &JsString::from_str("price") || axis.is_some() {
            return ScreenPoint {
                x: f64::NAN,
                y: f64::NAN,
            };
        }
        let index = time / 60_000.0;
        ScreenPoint {
            x: self.axis.left
                + (index - view.from) / (view.to - view.from) * (self.axis.right - self.axis.left),
            y: self.axis.scale.y(price),
        }
    }
    fn index(&self, view: VisibleRange, x: f64) -> f64 {
        view.from
            + (x - self.axis.left) / (self.axis.right - self.axis.left) * (view.to - view.from)
    }
}

fn layout(row: &JsValue) -> (VisibleRange, TestLayout) {
    let spec = decode_wire(get(row, "layout"));
    let left = number(get(&spec, "left"));
    let right = number(get(&spec, "right"));
    let top = number(get(&spec, "top"));
    let bottom = number(get(&spec, "bottom"));
    let min = number(get(&spec, "min"));
    let max = number(get(&spec, "max"));
    let base = number(get(&spec, "base"));
    let scale = AxisScale::new(AxisScaleInput {
        source_min: min,
        source_max: max,
        scale: AxisScaleKind::Linear,
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
                scale,
            },
        },
    )
}

#[test]
fn actual_js_drawing_commands_match_z_order_font_decoration_and_selected_handles() {
    for row in rows("drawing-commands") {
        let inputs = decode_wire(get(&row, "inputs"));
        let theme_value = decode_wire(get(&row, "theme"));
        let theme = SceneTheme::from_value(&theme_value).unwrap();
        assert!(matches!(&theme.grid, JsValue::String(_)));
        assert!(matches!(&theme.up, JsValue::String(_)));
        assert!(matches!(&theme.down, JsValue::String(_)));
        assert!(matches!(&theme.crosshair, JsValue::String(_)));
        let mut drawings =
            DrawingStore::new(DrawingStoreConfig::default(), NumberDialect::PLATFORM).unwrap();
        for input in array(&inputs) {
            drawings.add(input).unwrap();
        }
        assert_eq!(
            drawings.selected().map(JsString::to_string_lossy),
            Some(text(get(&row, "selected")))
        );
        let data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
        let model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
        let default_theme = SceneTheme::from_model(&model).unwrap();
        assert!(matches!(&default_theme.background, JsValue::String(_)));
        let (view, layout) = layout(&row);
        assert_eq!(text(layout.geometry_font()), "12px monospace");
        let mut cache = DrawingGeometryCache::new(drawings.items().len() + 1);
        assert!(cache.is_empty());
        let commands = create_drawing_commands(DrawingCommandInput {
            model: &model,
            store: data.store(),
            drawings: &drawings,
            current_view: view,
            layout: &layout,
            cache: &mut cache,
            theme: &theme,
            dialect: NumberDialect::PLATFORM,
        })
        .unwrap();
        assert!(cache.len() <= drawings.items().len());
        assert_eq!(
            json(&encode_wire(&JsValue::Array(commands))),
            json(get(&row, "expectedV8")),
            "{}",
            text(get(&row, "id"))
        );
    }
}
