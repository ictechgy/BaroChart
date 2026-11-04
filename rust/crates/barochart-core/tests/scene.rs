use barochart_core::{axis_scale, drawing_geometry, scene, scene_parts};

use axis_scale::{AxisScale, AxisScaleInput, AxisScaleKind};
use barochart_core::data::{Bar, BarStore, ModelDataState, StoreOptions};
use barochart_core::drawings::DrawingStore;
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::layout::create_layout;
use barochart_core::model_state::{ModelContext, ModelState, SeriesKind, VisibleRange};
use barochart_core::range_index::RangeIndex;
use barochart_core::series_cache::SeriesCaches;
pub use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawing_geometry::{DrawingAxisView, DrawingGeometryCache, DrawingProjection, ScreenPoint};
use scene::{
    CachedSeriesRange, ResolvedCrosshair, SceneAxisView, SceneInput, ScenePanelView,
    SceneProjection, SeriesRangeView, SeriesRenderInput, build_scene,
    create_resolved_crosshair_commands,
};
use scene_parts::{AxisTickFormat, SceneTheme};

#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
use std::path::PathBuf;
#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
use std::process::Command;

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
fn boolean(value: &JsValue) -> bool {
    let JsValue::Bool(value) = value else {
        panic!("bool required: {value:?}")
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
        if let Some(values) = encoded.get(&JsString::from_str("$f64array")) {
            return JsValue::Array(
                array(values)
                    .iter()
                    .map(|value| JsValue::Number(from_hex(value)))
                    .collect(),
            );
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

#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
fn native_scene_output() -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let helper = root.join("test/fixtures/rust-model/generate-scene-native.mjs");
    let fixture = root.join("test/fixtures/rust-model/scene-oracle.jsonl");
    let node = std::env::var_os("BAROCHART_NODE").unwrap_or_else(|| "node".into());
    let engine = if cfg!(target_vendor = "apple") {
        "jsc"
    } else {
        "quickjs"
    };
    let output = Command::new(&node)
        .current_dir(&root)
        .arg(&helper)
        .arg(&fixture)
        .arg(engine)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "NoNode: cannot run native {engine} scene oracle with {:?}: {error}; set BAROCHART_NODE to Node 22",
                node
            )
        });
    assert!(
        output.status.success(),
        "native {engine} scene oracle failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let output_text = String::from_utf8_lossy(&output.stdout);
    let mut output_rows = output_text
        .lines()
        .filter(|line| !line.is_empty())
        .map(parse);
    let row = output_rows
        .next()
        .unwrap_or_else(|| panic!("native {engine} scene oracle emitted no row"));
    assert!(
        output_rows.next().is_none(),
        "native {engine} scene oracle emitted more than one row"
    );
    assert_eq!(text(get(&row, "scenarioId")), "scene-log");
    text(get(&row, "expectedNative"))
}

fn expected_scene_value(
    row: &JsValue,
    #[cfg(not(target_arch = "wasm32"))] id: &str,
    #[cfg(target_arch = "wasm32")] _id: &str,
    #[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
    native_scene: &str,
) -> JsValue {
    #[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
    if id == "scene-log" {
        return decode_wire(&parse(native_scene));
    }
    #[cfg(all(
        not(target_arch = "wasm32"),
        not(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))
    ))]
    if id == "scene-log" {
        panic!("unsupported native scene oracle target; use Apple JSC or Linux GNU QuickJS");
    }
    decode_wire(get(row, "expectedV8"))
}

#[derive(Clone)]
struct TestAxis {
    id: JsString,
    axis_id: Option<JsString>,
    visible: bool,
    label: Option<JsString>,
    precision: Option<u32>,
    tick_format: AxisTickFormat,
    prefix: Option<JsString>,
    suffix: Option<JsString>,
    scale_kind: AxisScaleKind,
    scale: AxisScale,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    axis_left: f64,
    axis_right: f64,
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
impl SceneAxisView for TestAxis {
    fn id(&self) -> &JsString {
        &self.id
    }
    fn axis_id(&self) -> Option<&JsString> {
        self.axis_id.as_ref()
    }
    fn visible(&self) -> bool {
        self.visible
    }
    fn label(&self) -> Option<&JsString> {
        self.label.as_ref()
    }
    fn precision(&self) -> Option<u32> {
        self.precision
    }
    fn tick_format(&self) -> AxisTickFormat {
        self.tick_format
    }
    fn prefix(&self) -> Option<&JsString> {
        self.prefix.as_ref()
    }
    fn suffix(&self) -> Option<&JsString> {
        self.suffix.as_ref()
    }
    fn scale_kind(&self) -> AxisScaleKind {
        self.scale_kind
    }
    fn axis_left(&self) -> f64 {
        self.axis_left
    }
    fn axis_right(&self) -> f64 {
        self.axis_right
    }
}
#[derive(Clone)]
struct TestPanel {
    id: JsString,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    axes: Vec<TestAxis>,
}
impl ScenePanelView for TestPanel {
    type Axis = TestAxis;
    fn id(&self) -> &JsString {
        &self.id
    }
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
    fn axes(&self) -> &[Self::Axis] {
        &self.axes
    }
}
struct TestLayout {
    raw: JsValue,
    key: JsString,
    font: JsValue,
    from: f64,
    to: f64,
    panels: Vec<TestPanel>,
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
        model: &ModelState,
        panel: &JsString,
        axis: Option<&JsString>,
        series: Option<&JsString>,
    ) -> Option<&Self::Axis> {
        if let Some(series_id) = series {
            let series = model
                .series
                .iter()
                .find(|candidate| candidate.id == *series_id)?;
            if !series.visible || series.panel != *panel || series.axis_id.as_ref() != axis {
                return None;
            }
        }
        self.axis(panel, axis)
    }
    fn to_screen(
        &self,
        view: VisibleRange,
        store: &BarStore,
        time: f64,
        price: f64,
        panel: &JsString,
        axis: Option<&JsString>,
    ) -> ScreenPoint {
        let Some(axis) = self.axis(panel, axis) else {
            return ScreenPoint {
                x: f64::NAN,
                y: f64::NAN,
            };
        };
        ScreenPoint {
            x: self.x(view, store.index_at_time(time)),
            y: axis.scale.y(price),
        }
    }
    fn index(&self, view: VisibleRange, x: f64) -> f64 {
        let panel = &self.panels[0];
        view.from + (x - panel.left) / (panel.right - panel.left) * (view.to - view.from)
    }
}
impl SceneProjection for TestLayout {
    type Panel = TestPanel;
    fn panels(&self) -> &[Self::Panel] {
        &self.panels
    }
    fn axis(&self, panel: &JsString, axis: Option<&JsString>) -> Option<&Self::Axis> {
        self.panels
            .iter()
            .find(|candidate| candidate.id == *panel)?
            .axes
            .iter()
            .find(|candidate| candidate.axis_id.as_ref() == axis)
    }
    fn x(&self, view: VisibleRange, index: f64) -> f64 {
        let panel = &self.panels[0];
        panel.left + (index - view.from) / (view.to - view.from) * (panel.right - panel.left)
    }
    fn source_from(&self) -> f64 {
        self.from
    }
    fn source_to(&self) -> f64 {
        self.to
    }
    fn to_js_value(&self) -> JsValue {
        self.raw.clone()
    }
}
fn optional_string(value: &JsValue, key: &str) -> Option<JsString> {
    optional(value, key).and_then(|value| match value {
        JsValue::String(value) => Some(value.clone()),
        _ => None,
    })
}
fn axis_from_value(value: &JsValue, _panel_id: &JsString) -> TestAxis {
    let scale_kind = match text(get(value, "scale")).as_str() {
        "linear" => AxisScaleKind::Linear,
        "log" => AxisScaleKind::Log,
        "percent" => AxisScaleKind::Percent,
        value => panic!("scale {value}"),
    };
    let min = number(get(value, "min"));
    let max = number(get(value, "max"));
    let base = number(get(value, "base"));
    let top = number(get(value, "top"));
    let bottom = number(get(value, "bottom"));
    let scale = AxisScale::new(AxisScaleInput {
        source_min: min,
        source_max: max,
        scale: scale_kind,
        padding: 0.0,
        range: Some([min, max]),
        base: Some(base),
        first_close: Some(base),
        zero_baseline: false,
        inverted: boolean(get(value, "inverted")),
        top,
        bottom,
    })
    .unwrap();
    TestAxis {
        id: string(get(value, "id")).clone(),
        axis_id: optional_string(value, "axisId"),
        visible: boolean(get(value, "visible")),
        label: optional_string(value, "label"),
        precision: optional(value, "precision").map(|value| number(value) as u32),
        tick_format: if optional(value, "tickFormat")
            .is_some_and(|value| text(value) == "scientific")
        {
            AxisTickFormat::Scientific
        } else {
            AxisTickFormat::Fixed
        },
        prefix: optional_string(value, "prefix"),
        suffix: optional_string(value, "suffix"),
        scale_kind,
        scale,
        left: number(get(value, "left")),
        right: number(get(value, "right")),
        top,
        bottom,
        axis_left: number(get(value, "axisLeft")),
        axis_right: number(get(value, "axisRight")),
    }
}
fn layout_from_value(value: &JsValue) -> TestLayout {
    let panels = array(get(value, "panels"))
        .iter()
        .map(|panel| {
            let id = string(get(panel, "id")).clone();
            let axes = array(get(panel, "axes"))
                .iter()
                .map(|axis| axis_from_value(axis, &id))
                .collect();
            TestPanel {
                id,
                left: number(get(panel, "left")),
                right: number(get(panel, "right")),
                top: number(get(panel, "top")),
                bottom: number(get(panel, "bottom")),
                axes,
            }
        })
        .collect();
    TestLayout {
        raw: value.clone(),
        key: string(get(value, "geometryKey")).clone(),
        font: get(value, "geometryFont").clone(),
        from: number(get(value, "from")),
        to: number(get(value, "to")),
        panels,
    }
}
fn bar_from_value(value: &JsValue) -> Bar {
    Bar {
        time: number(get(value, "time")),
        open: number(get(value, "open")),
        high: number(get(value, "high")),
        low: number(get(value, "low")),
        close: number(get(value, "close")),
        volume: number(get(value, "volume")),
    }
}
fn remove_field(value: &mut JsValue, key: &str) -> Option<JsValue> {
    let JsValue::Object(value) = value else {
        return None;
    };
    value.remove(&JsString::from_str(key))
}
fn source_values<'a>(
    series: &'a barochart_core::model_state::Series,
    store: &'a BarStore,
) -> Option<&'a [f64]> {
    if let Some(values) = series.values.as_deref() {
        return Some(values);
    }
    let raw = series.raw_record();
    let source = optional(&raw, "source")
        .map(text)
        .unwrap_or_else(|| String::from("close"));
    Some(match source.as_str() {
        "time" => &store.columns().time[..store.length()],
        "open" => &store.columns().open[..store.length()],
        "high" => &store.columns().high[..store.length()],
        "low" => &store.columns().low[..store.length()],
        "close" => &store.columns().close[..store.length()],
        "volume" => &store.columns().volume[..store.length()],
        _ => return None,
    })
}

struct RenderFixture {
    data: ModelDataState,
    model: ModelState,
    symbol: Option<barochart_core::markets::Symbol>,
}
fn render_fixture(spec: &JsValue) -> RenderFixture {
    let bars = array(get(spec, "bars"))
        .iter()
        .map(bar_from_value)
        .collect();
    let data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
    let mut model = ModelState::new(data.store(), get(spec, "model")).unwrap();
    for value in array(get(spec, "series")) {
        let mut options = value.clone();
        if let Some(values) = remove_field(&mut options, "values") {
            let values = array(&values).iter().map(number).collect();
            model
                .add_series_with_values(&options, values, &ModelContext::plain(data.store()))
                .unwrap();
        } else {
            model
                .add_series(&options, &ModelContext::plain(data.store()))
                .unwrap();
        }
    }
    let symbol = optional(spec, "symbol")
        .filter(|value| !matches!(value, JsValue::Null | JsValue::Undefined))
        .map(|value| {
            let adjustment = match text(get(value, "adjustment")).as_str() {
                "split" => barochart_core::markets::Adjustment::Split,
                "total-return" => barochart_core::markets::Adjustment::TotalReturn,
                _ => barochart_core::markets::Adjustment::Raw,
            };
            barochart_core::markets::Symbol {
                id: string(get(value, "id")).clone(),
                exchange: string(get(value, "exchange")).clone(),
                timezone: string(get(value, "timezone")).clone(),
                currency: string(get(value, "currency")).clone(),
                volume_unit: string(get(value, "volumeUnit")).clone(),
                price_decimals: number(get(value, "priceDecimals")) as u32,
                tick_size: number(get(value, "tickSize")),
                adjustment,
            }
        });
    if let Some(symbol) = &symbol {
        model.precision = symbol.price_decimals as u8;
    }
    RenderFixture {
        data,
        model,
        symbol,
    }
}

const NY_SPRING_2024: f64 = 1_710_054_000_000.0;
const NY_FALL_2024: f64 = 1_730_613_600_000.0;
const SANTIAGO_SPRING_2024: f64 = 1_725_768_000_000.0;

struct FixtureHost;

impl Host for FixtureHost {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        match name.to_string_lossy().as_str() {
            "Asia/Seoul" | "America/New_York" | "America/Santiago" => Ok(name.clone()),
            _ => Err(HostError),
        }
    }

    fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError> {
        match zone.to_string_lossy().as_str() {
            "Asia/Seoul" => Ok(9 * 3_600),
            "America/New_York" => Ok(if (NY_SPRING_2024..NY_FALL_2024).contains(&epoch_ms) {
                -4
            } else {
                -5
            } * 3_600),
            "America/Santiago" => Ok(if epoch_ms >= SANTIAGO_SPRING_2024 {
                -3
            } else {
                -4
            } * 3_600),
            _ => Err(HostError),
        }
    }

    fn log(&self, _level: i32, _message: &str) {}
}

#[test]
fn actual_js_scene_commands_and_stats_match_renderer_neutral_build() {
    #[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
    let native_scene = native_scene_output();
    let host = FixtureHost;
    for row in rows("scene") {
        let id = text(get(&row, "id"));
        let spec = decode_wire(get(&row, "input"));
        let fixture = render_fixture(&spec);
        #[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
        let expected = expected_scene_value(&row, &id, &native_scene);
        #[cfg(not(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu"))))]
        let expected = expected_scene_value(&row, &id);
        let layout = layout_from_value(get(&expected, "layout"));
        let indexes: Vec<Option<RangeIndex>> = fixture
            .model
            .series
            .iter()
            .map(|series| {
                if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
                    || scene_parts::aggregate_volume_series(series)
                {
                    None
                } else {
                    let values = source_values(series, fixture.data.store()).unwrap();
                    Some(
                        RangeIndex::new(
                            values.len(),
                            values,
                            values,
                            None,
                            fixture.data.store().capacity(),
                            true,
                        )
                        .unwrap(),
                    )
                }
            })
            .collect();
        let series: Vec<SeriesRenderInput<'_>> = fixture
            .model
            .series
            .iter()
            .enumerate()
            .map(|(index, series)| SeriesRenderInput {
                series,
                values: source_values(series, fixture.data.store()),
                range: indexes[index]
                    .as_ref()
                    .map(|index| index as &dyn SeriesRangeView),
            })
            .collect();
        let theme = SceneTheme::from_model(&fixture.model).unwrap();
        let drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
        let mut cache = DrawingGeometryCache::new(16);
        assert!(cache.is_empty());
        assert!(matches!(layout.geometry_font(), JsValue::String(_)));
        let flags = get(&spec, "flags");
        let actual = build_scene(SceneInput {
            model: &fixture.model,
            store: fixture.data.store(),
            layout: &layout,
            series: &series,
            theme: &theme,
            symbol: fixture.symbol.as_ref(),
            host: &host,
            drawings: Some(&drawings),
            drawing_cache: &mut cache,
            resolved_crosshair: None,
            width: number(get(&spec, "width")),
            height: number(get(&spec, "height")),
            include_drawings: boolean(get(flags, "drawings")),
            include_crosshair: boolean(get(flags, "crosshair")),
            dialect: NumberDialect::PLATFORM,
        })
        .unwrap();
        assert!(cache.len() <= 16);
        assert_eq!(
            json(&encode_wire(&actual)),
            json(&encode_wire(&expected)),
            "{id}"
        );
    }
}

fn resolved(value: &JsValue) -> ResolvedCrosshair {
    ResolvedCrosshair {
        x: number(get(get(value, "resolved"), "x")),
        y: number(get(get(value, "resolved"), "y")),
        panel: string(get(value, "panel")).clone(),
        snapped: boolean(get(value, "snapped")),
        axis_id: optional_string(value, "axisId"),
        price: optional(value, "price").and_then(|value| match value {
            JsValue::Number(value) => Some(*value),
            _ => None,
        }),
    }
}

#[test]
fn actual_js_crosshair_commands_match_explicit_free_and_snapped_dtos() {
    for row in rows("crosshair") {
        let spec = decode_wire(get(&row, "input"));
        let fixture = render_fixture(&spec);
        let layout = layout_from_value(&decode_wire(get(&row, "layout")));
        let theme = SceneTheme::from_model(&fixture.model).unwrap();
        let resolved = resolved(&decode_wire(get(&row, "resolved")));
        let commands = create_resolved_crosshair_commands(
            &layout,
            Some(&resolved),
            &theme,
            fixture.model.precision as u32,
            None,
            NumberDialect::PLATFORM,
        )
        .unwrap();
        assert_eq!(
            json(&encode_wire(&JsValue::Array(commands))),
            json(get(&row, "expectedV8")),
            "{}",
            text(get(&row, "id"))
        );
    }
}

#[test]
fn real_layout_and_series_cache_adapters_build_the_composite_scene() {
    let host = FixtureHost;
    let row = rows("scene")
        .into_iter()
        .find(|row| text(get(row, "id")) == "scene-composite")
        .unwrap();
    let spec = decode_wire(get(&row, "input"));
    let mut fixture = render_fixture(&spec);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut caches = SeriesCaches::new();
    let layout = create_layout(
        &mut fixture.model,
        fixture.data.store(),
        &mut engine,
        &host,
        &mut caches,
        number(get(&spec, "width")),
        number(get(&spec, "height")),
    )
    .unwrap();
    let mut expected_scene = decode_wire(get(&row, "expectedV8"));
    let actual_layout = layout.to_js_value();
    let actual_geometry_key = get(&actual_layout, "geometryKey").clone();
    let JsValue::Object(expected_scene_record) = &mut expected_scene else {
        panic!("scene object")
    };
    let Some(expected_layout) = expected_scene_record.get(&JsString::from_str("layout")) else {
        panic!("layout object")
    };
    let mut normalized_layout = expected_layout.clone();
    let JsValue::Object(normalized_layout_record) = &mut normalized_layout else {
        panic!("layout object")
    };
    normalized_layout_record.insert(JsString::from_str("geometryKey"), actual_geometry_key);
    expected_scene_record.insert(JsString::from_str("layout"), normalized_layout);
    assert_eq!(
        json(&encode_wire(&actual_layout)),
        json(&encode_wire(get(&expected_scene, "layout"))),
        "real layout adapter wire"
    );
    assert_eq!(
        json(&encode_wire(&SceneProjection::to_js_value(&layout))),
        json(&encode_wire(&layout.to_js_value()))
    );
    let current = fixture.model.view;
    let inherent = layout.to_screen(
        current,
        fixture.data.store(),
        fixture.data.store().columns().time[3],
        fixture.data.store().columns().close[3],
        &JsString::from_str("price"),
        None,
    );
    let adapted = DrawingProjection::to_screen(
        &layout,
        current,
        fixture.data.store(),
        fixture.data.store().columns().time[3],
        fixture.data.store().columns().close[3],
        &JsString::from_str("price"),
        None,
    );
    assert_eq!(inherent.x.to_bits(), adapted.x.to_bits());
    assert_eq!(inherent.y.to_bits(), adapted.y.to_bits());

    let values: Vec<Option<&[f64]>> = fixture
        .model
        .series
        .iter()
        .map(|series| source_values(series, fixture.data.store()))
        .collect();
    let ranges: Vec<Option<CachedSeriesRange<'_>>> = fixture
        .model
        .series
        .iter()
        .enumerate()
        .map(|(index, series)| {
            if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
                || scene_parts::aggregate_volume_series(series)
            {
                None
            } else {
                Some(CachedSeriesRange {
                    caches: &caches,
                    series_id: &series.id,
                    values: values[index].unwrap(),
                })
            }
        })
        .collect();
    let series: Vec<SeriesRenderInput<'_>> = fixture
        .model
        .series
        .iter()
        .enumerate()
        .map(|(index, series)| SeriesRenderInput {
            series,
            values: values[index],
            range: ranges[index]
                .as_ref()
                .map(|range| range as &dyn SeriesRangeView),
        })
        .collect();
    let theme = SceneTheme::from_model(&fixture.model).unwrap();
    let drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
    let mut drawing_cache = DrawingGeometryCache::new(16);
    let scene = build_scene(SceneInput {
        model: &fixture.model,
        store: fixture.data.store(),
        layout: &layout,
        series: &series,
        theme: &theme,
        symbol: None,
        host: &host,
        drawings: Some(&drawings),
        drawing_cache: &mut drawing_cache,
        resolved_crosshair: None,
        width: number(get(&spec, "width")),
        height: number(get(&spec, "height")),
        include_drawings: false,
        include_crosshair: false,
        dialect: NumberDialect::PLATFORM,
    })
    .unwrap();
    assert_eq!(
        json(&encode_wire(&scene)),
        json(&encode_wire(&expected_scene)),
        "real layout adapter scene"
    );
}
