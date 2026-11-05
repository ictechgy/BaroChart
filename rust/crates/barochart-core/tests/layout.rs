use barochart_core::{layout, series_cache};

use barochart_core::{Host, HostError, data, indicator_engine, model_state};

use barochart_js::error::JsError;
use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_utf16, stringify_json_with,
};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::JsString;
use data::{Bar, ModelDataState, StoreOptions};
use indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use layout::{Layout, LayoutAxis, create_layout, create_layout_with_memory};
use model_state::{
    DrawingUsage, IndicatorProjection, InteractionGuard, ModelContext, ModelState, Series,
};
use series_cache::SeriesCaches;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::collections::HashMap;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::path::PathBuf;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::process::Command;

const FIXTURE: &str = include_str!("../../../../test/fixtures/rust-model/layout-oracle.jsonl");
const SCHEMA: &str = "aster.rust-model-layout";
const ORACLE_COMMIT: &str = "cbc4b296cfdba25f597f04d1aea238f221019bce";

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

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(object) = value else {
        panic!("object required: {value:?}")
    };
    object
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    object(value)
        .get(&key(name))
        .unwrap_or_else(|| panic!("missing fixture field {name}"))
}

fn optional_field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    object(value).get(&key(name))
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

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(values) = value else {
        panic!("array required: {value:?}")
    };
    values
}

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
}

fn decode_number(value: &JsValue) -> Option<f64> {
    let JsValue::Object(object) = value else {
        return None;
    };
    if object.len() != 1 {
        return None;
    }
    let marker = object.get(&key("$f64"))?;
    let JsValue::String(marker) = marker else {
        return None;
    };
    match marker.to_string_lossy().as_str() {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        "-0" => Some(-0.0),
        bits => Some(f64::from_bits(u64::from_str_radix(bits, 16).unwrap())),
    }
}

fn decode(value: &JsValue) -> JsValue {
    if let Some(number) = decode_number(value) {
        return JsValue::Number(number);
    }
    match value {
        JsValue::Array(values) => JsValue::Array(values.iter().map(decode).collect()),
        JsValue::Object(object) => {
            let mut result = JsObject::new();
            for (name, value) in object.iter() {
                result.insert(name.clone(), decode(value));
            }
            JsValue::Object(result)
        }
        _ => value.clone(),
    }
}

fn encode(value: &JsValue) -> JsValue {
    match value {
        JsValue::Number(number) => {
            let marker = if number.is_nan() {
                "NaN".to_owned()
            } else if *number == f64::INFINITY {
                "Infinity".to_owned()
            } else if *number == f64::NEG_INFINITY {
                "-Infinity".to_owned()
            } else if *number == 0.0 && number.is_sign_negative() {
                "-0".to_owned()
            } else {
                format!("{:016x}", number.to_bits())
            };
            let mut object = JsObject::new();
            object.insert(key("$f64"), JsValue::String(JsString::from_str(&marker)));
            JsValue::Object(object)
        }
        JsValue::Array(values) => JsValue::Array(values.iter().map(encode).collect()),
        JsValue::Object(object) => {
            let mut result = JsObject::new();
            for (name, value) in object.iter() {
                result.insert(name.clone(), encode(value));
            }
            JsValue::Object(result)
        }
        _ => value.clone(),
    }
}

fn fixture_rows() -> Vec<JsValue> {
    FIXTURE
        .lines()
        .filter(|line| !line.is_empty())
        .map(parse)
        .collect()
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
struct NativeLayoutOutput {
    expected: Option<String>,
    error: Option<(String, JsString)>,
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn native_layout_outputs(rows: &[JsValue]) -> HashMap<String, NativeLayoutOutput> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let helper = root.join("test/fixtures/rust-model/generate-layout-native-quickjs.mjs");
    let fixture = root.join("test/fixtures/rust-model/layout-oracle.jsonl");
    let node = std::env::var_os("BAROCHART_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(&root)
        .arg(&helper)
        .arg(&fixture)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "NoNode: cannot run native QuickJS layout oracle with {:?}: {error}; set BAROCHART_NODE to Node 22",
                node
            )
        });
    assert!(
        output.status.success(),
        "native QuickJS layout oracle failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );

    let mut result = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
    {
        let row = parse(line);
        let scenario = string(field(&row, "scenarioId")).to_string_lossy();
        let expected = match field(&row, "expectedNativeQuickJs") {
            JsValue::Null => None,
            JsValue::String(value) => Some(value.to_string_lossy()),
            value => panic!(
                "{scenario}: native QuickJS expected output must be string/null, got {value:?}"
            ),
        };
        let error = match field(&row, "errorNativeQuickJs") {
            JsValue::Null => None,
            value => Some((
                string(field(value, "name")).to_string_lossy(),
                string(field(value, "message")).clone(),
            )),
        };
        assert!(
            result
                .insert(scenario.clone(), NativeLayoutOutput { expected, error })
                .is_none(),
            "native QuickJS layout oracle duplicated {scenario}"
        );
    }
    assert_eq!(
        result.len(),
        rows.len(),
        "native QuickJS layout oracle result count"
    );
    for row in rows {
        let scenario = string(field(row, "scenarioId")).to_string_lossy();
        let native = result
            .get(&scenario)
            .unwrap_or_else(|| panic!("native QuickJS layout oracle missed {scenario}"));
        let fixture_has_error = !matches!(field(row, "error"), JsValue::Null);
        assert_eq!(
            native.error.is_some(),
            fixture_has_error,
            "native QuickJS layout oracle outcome changed for {scenario}"
        );
    }
    result
}

fn expected_layout_error(
    row: &JsValue,
    #[cfg(all(target_os = "linux", target_env = "gnu"))] native_quickjs: &HashMap<
        String,
        NativeLayoutOutput,
    >,
) -> (String, JsString) {
    #[cfg(target_arch = "wasm32")]
    {
        let expected = field(row, "error");
        (
            string(field(expected, "name")).to_string_lossy(),
            string(field(expected, "message")).clone(),
        )
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let expected = optional_field(row, "errorJsc").unwrap_or_else(|| field(row, "error"));
        (
            string(field(expected, "name")).to_string_lossy(),
            string(field(expected, "message")).clone(),
        )
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        let scenario = string(field(row, "scenarioId")).to_string_lossy();
        native_quickjs
            .get(&scenario)
            .and_then(|output| output.error.as_ref())
            .map(|(name, message)| (name.clone(), message.clone()))
            .unwrap_or_else(|| panic!("native QuickJS layout oracle has no error for {scenario}"))
    }
    #[cfg(all(
        not(target_arch = "wasm32"),
        not(any(target_os = "macos", target_os = "ios")),
        not(all(target_os = "linux", target_env = "gnu"))
    ))]
    {
        panic!("unsupported native layout oracle target; use Apple JSC or Linux GNU QuickJS")
    }
}

fn expected_layout_text(
    row: &JsValue,
    #[cfg(all(target_os = "linux", target_env = "gnu"))] native_quickjs: &HashMap<
        String,
        NativeLayoutOutput,
    >,
) -> String {
    #[cfg(target_arch = "wasm32")]
    {
        string(field(row, "expected")).to_string_lossy()
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        optional_field(row, "expectedJsc")
            .map(string)
            .unwrap_or_else(|| string(field(row, "expected")))
            .to_string_lossy()
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        let scenario = string(field(row, "scenarioId")).to_string_lossy();
        native_quickjs
            .get(&scenario)
            .and_then(|output| output.expected.as_ref())
            .cloned()
            .unwrap_or_else(|| panic!("native QuickJS layout oracle has no output for {scenario}"))
    }
    #[cfg(all(
        not(target_arch = "wasm32"),
        not(any(target_os = "macos", target_os = "ios")),
        not(all(target_os = "linux", target_env = "gnu"))
    ))]
    {
        panic!("unsupported native layout oracle target; use Apple JSC or Linux GNU QuickJS")
    }
}

fn number_array(value: &JsValue) -> Vec<f64> {
    array(value).iter().map(number).collect()
}

fn bar_from_value(value: &JsValue) -> Bar {
    Bar {
        time: number(field(value, "time")),
        open: number(field(value, "open")),
        high: number(field(value, "high")),
        low: number(field(value, "low")),
        close: number(field(value, "close")),
        volume: number(field(value, "volume")),
    }
}

fn bars_from_array(value: &JsValue) -> Vec<Bar> {
    array(value).iter().map(bar_from_value).collect()
}

fn bars_for_data(value: &JsValue) -> Vec<Bar> {
    if let Some(bars) = optional_field(value, "bars") {
        return bars_from_array(bars);
    }
    let length = number(field(value, "barCount")) as usize;
    let seed = number(field(value, "seed")) as u32;
    let columns = data::seeded_columns(length, seed).unwrap();
    (0..length)
        .map(|index| Bar {
            time: columns.time[index],
            open: columns.open[index],
            high: columns.high[index],
            low: columns.low[index],
            close: columns.close[index],
            volume: columns.volume[index],
        })
        .collect()
}

fn series_values<'a>(
    series: &'a Series,
    store: &'a data::BarStore,
    indicators: &'a IndicatorEngine,
) -> Option<&'a [f64]> {
    if let Some(values) = &series.values {
        return Some(values);
    }
    if let Some(indicator) = &series.indicator {
        let entry = indicators.entry(&JsValue::String(indicator.clone()))?;
        let output = series
            .output
            .as_ref()
            .map(JsString::to_string_lossy)
            .unwrap_or_else(|| entry.definition().outputs[0].to_owned());
        return entry
            .output_capacity(&output)
            .map(|values| &values[..store.length()]);
    }
    let source = match optional_field(&series.raw_record(), "source") {
        Some(JsValue::String(value)) => value.to_string_lossy(),
        _ => "close".to_owned(),
    };
    let columns = store.columns();
    let values = match source.as_str() {
        "time" => &columns.time,
        "open" => &columns.open,
        "high" => &columns.high,
        "low" => &columns.low,
        "volume" => &columns.volume,
        _ => &columns.close,
    };
    Some(&values[..store.length()])
}

fn object_value(entries: impl IntoIterator<Item = (String, JsValue)>) -> JsValue {
    let mut result = JsObject::new();
    for (name, value) in entries {
        result.insert(JsString::from_str(&name), value);
    }
    JsValue::Object(result)
}

fn js_object(entries: &[(&str, JsValue)]) -> JsValue {
    let mut result = JsObject::new();
    for (name, value) in entries {
        result.insert(key(name), value.clone());
    }
    JsValue::Object(result)
}

fn axis_tag(axis: Option<&LayoutAxis>) -> JsValue {
    let Some(axis) = axis else {
        return JsValue::Null;
    };
    let mut fields = vec![("id".to_owned(), JsValue::String(axis.id.clone()))];
    if let Some(JsValue::String(panel)) = optional_field(&axis.config, "panel") {
        fields.push(("panel".to_owned(), JsValue::String(panel.clone())));
    }
    fields.extend([
        (
            "axisId".to_owned(),
            axis.axis_id.clone().map_or(JsValue::Null, JsValue::String),
        ),
        ("scale".to_owned(), JsValue::String(axis.scale_name.clone())),
        ("side".to_owned(), JsValue::String(axis.side.clone())),
        ("visible".to_owned(), JsValue::Bool(axis.visible)),
    ]);
    object_value(fields)
}

fn layout_queries(
    layout: &Layout,
    model: &ModelState,
    store: &data::BarStore,
    queries: &JsValue,
) -> JsValue {
    let x: Vec<_> = number_array(field(queries, "xIndices"))
        .into_iter()
        .map(|index| JsValue::Number(layout.x(model.view, index)))
        .collect();
    let index: Vec<_> = number_array(field(queries, "screenFractions"))
        .into_iter()
        .map(|fraction| {
            let panel = &layout.panels[0];
            let sx = panel.left + fraction * (panel.right - panel.left);
            JsValue::Number(layout.index(model.view, sx))
        })
        .collect();
    let axes = array(field(queries, "axes"))
        .iter()
        .map(|request| {
            let panel = string(field(request, "panel")).clone();
            let axis_id = match optional_field(request, "axisId") {
                Some(JsValue::String(value)) => Some(value.clone()),
                _ => None,
            };
            let axis = layout.axis(&panel, axis_id.as_ref());
            if let Some(axis) = axis {
                assert_eq!(axis.panel_id, panel);
                let prices = number_array(field(request, "prices"));
                let fractions = number_array(field(request, "screenFractions"));
                let y = prices
                    .iter()
                    .map(|value| JsValue::Number(axis.y(*value)))
                    .collect();
                let transform = prices
                    .iter()
                    .map(|value| JsValue::Number(axis.transform(*value)))
                    .collect();
                let inverse = prices
                    .iter()
                    .map(|value| JsValue::Number(axis.inverse(axis.transform(*value))))
                    .collect();
                let price = fractions
                    .iter()
                    .map(|fraction| {
                        JsValue::Number(axis.price(axis.top + fraction * (axis.bottom - axis.top)))
                    })
                    .collect();
                js_object(&[
                    ("panel", JsValue::String(panel)),
                    ("axisId", axis_id.map_or(JsValue::Null, JsValue::String)),
                    ("axis", axis_tag(Some(axis))),
                    ("y", JsValue::Array(y)),
                    ("transform", JsValue::Array(transform)),
                    ("inverse", JsValue::Array(inverse)),
                    ("price", JsValue::Array(price)),
                ])
            } else {
                js_object(&[
                    ("panel", JsValue::String(panel)),
                    ("axisId", axis_id.map_or(JsValue::Null, JsValue::String)),
                    ("axis", JsValue::Null),
                ])
            }
        })
        .collect();
    let points = array(field(queries, "points"))
        .iter()
        .map(|point| {
            let panel = string(field(point, "panel")).clone();
            let axis_id = match optional_field(point, "axisId") {
                Some(JsValue::String(value)) => Some(value.clone()),
                _ => None,
            };
            let screen = layout.to_screen(
                model.view,
                store,
                number(field(point, "time")),
                number(field(point, "price")),
                &panel,
                axis_id.as_ref(),
            );
            js_object(&[
                ("panel", JsValue::String(panel)),
                ("axisId", axis_id.map_or(JsValue::Null, JsValue::String)),
                (
                    "value",
                    js_object(&[
                        ("x", JsValue::Number(screen.x)),
                        ("y", JsValue::Number(screen.y)),
                    ]),
                ),
            ])
        })
        .collect();
    let from_screen = array(field(queries, "fromScreen"))
        .iter()
        .map(|point| {
            let panel_id = string(field(point, "panel"));
            let axis_id = match optional_field(point, "axisId") {
                Some(JsValue::String(value)) => Some(value),
                _ => None,
            };
            let panel = layout
                .panels
                .iter()
                .find(|candidate| candidate.id == *panel_id)
                .unwrap();
            let axis = layout.axis(panel_id, axis_id);
            let sy = axis.map_or_else(
                || panel.top + number(field(point, "yFraction")) * (panel.bottom - panel.top),
                |axis| axis.top + number(field(point, "yFraction")) * (axis.bottom - axis.top),
            );
            let sx = panel.left + number(field(point, "xFraction")) * (panel.right - panel.left);
            let result = layout.from_screen(model.view, store, sx, sy, panel_id, axis_id);
            let value = match result {
                Ok(point) => js_object(&[
                    ("time", JsValue::Number(point.time)),
                    ("price", JsValue::Number(point.price)),
                ]),
                Err(error) => js_object(&[
                    ("name", JsValue::String(JsString::from_str(error.name))),
                    ("message", JsValue::String(error.message)),
                ]),
            };
            js_object(&[
                ("panel", JsValue::String(panel_id.clone())),
                (
                    "axisId",
                    axis_id.cloned().map_or(JsValue::Null, JsValue::String),
                ),
                ("value", value),
            ])
        })
        .collect();
    let drawings = array(field(queries, "drawings"))
        .iter()
        .map(|drawing| {
            let panel = string(field(drawing, "panel"));
            let axis_id = match optional_field(drawing, "axisId") {
                Some(JsValue::String(value)) => Some(value),
                _ => None,
            };
            let series_id = match optional_field(drawing, "seriesId") {
                Some(JsValue::String(value)) => Some(value),
                _ => None,
            };
            let axis = layout.drawing_axis(model, panel, axis_id, series_id);
            js_object(&[
                ("panel", JsValue::String(panel.clone())),
                (
                    "axisId",
                    axis_id.cloned().map_or(JsValue::Null, JsValue::String),
                ),
                (
                    "seriesId",
                    series_id.cloned().map_or(JsValue::Null, JsValue::String),
                ),
                ("axis", axis_tag(axis)),
            ])
        })
        .collect();
    js_object(&[
        ("x", JsValue::Array(x)),
        ("index", JsValue::Array(index)),
        ("axes", JsValue::Array(axes)),
        ("points", JsValue::Array(points)),
        ("fromScreen", JsValue::Array(from_screen)),
        ("drawings", JsValue::Array(drawings)),
    ])
}

fn cache_snapshot(
    model: &ModelState,
    store: &data::BarStore,
    indicators: &IndicatorEngine,
    caches: &SeriesCaches,
) -> JsValue {
    let from = js_max(&[model.view.from.floor(), 0.0]) as usize;
    let to = js_min(&[
        js_max(&[(model.view.to + 1.0).ceil(), from as f64]),
        store.length() as f64,
    ]) as usize;
    JsValue::Array(
        model
            .series
            .iter()
            .map(|series| {
                let info = caches.info(&series.id);
                let range_index = if let Some(info) = info {
                    let values = series_values(series, store, indicators).unwrap_or(&[]);
                    let gaps = caches
                        .has_gaps(&series.id, values, from, to)
                        .expect("cache query range is within the current store");
                    js_object(&[
                        (
                            "kind",
                            JsValue::String(JsString::from_str(match info.kind {
                                series_cache::SeriesCacheKind::Flat => "RangeIndex",
                                series_cache::SeriesCacheKind::Block => "BlockRangeIndex",
                            })),
                        ),
                        ("size", JsValue::Number(info.size as f64)),
                        ("length", JsValue::Number(info.length as f64)),
                        (
                            "blockSize",
                            info.block_size
                                .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
                        ),
                        ("finiteCounts", JsValue::Bool(info.finite_counts)),
                        ("bytes", JsValue::Number(info.bytes as f64)),
                        ("hasGaps", JsValue::Bool(gaps)),
                    ])
                } else {
                    JsValue::Null
                };
                let mut fields = vec![
                    ("id".to_owned(), JsValue::String(series.id.clone())),
                    ("dirtyFrom".to_owned(), JsValue::Number(series.dirty_from)),
                ];
                if let Some(revision) = series.revision {
                    fields.push(("revision".to_owned(), JsValue::Number(revision)));
                }
                fields.push(("rangeIndex".to_owned(), range_index));
                object_value(fields)
            })
            .collect(),
    )
}

fn indicator_snapshot(model: &JsValue, indicators: &IndicatorEngine) -> JsValue {
    let indicator_ids = optional_field(model, "indicators").map_or(&[][..], array);
    JsValue::Array(
        indicator_ids
            .iter()
            .map(|indicator| {
                let id = string(field(indicator, "id")).clone();
                let entry = indicators
                    .entry(&JsValue::String(id.clone()))
                    .expect("fixture indicator exists");
                let mut fields = vec![
                    ("id".to_owned(), JsValue::String(id)),
                    ("revision".to_owned(), JsValue::Number(entry.revision())),
                    ("dirty".to_owned(), JsValue::Number(entry.dirty() as f64)),
                ];
                if let Some(value) = entry.dirty_to() {
                    fields.push(("dirtyTo".to_owned(), JsValue::Number(value as f64)));
                }
                fields.push(("length".to_owned(), JsValue::Number(entry.length() as f64)));
                if let Some(value) = entry.computed_from() {
                    fields.push(("computedFrom".to_owned(), JsValue::Number(value as f64)));
                }
                if let Some(value) = entry.computed_until() {
                    fields.push(("computedUntil".to_owned(), JsValue::Number(value as f64)));
                }
                object_value(fields)
            })
            .collect(),
    )
}

fn layout_state(
    layout: &Layout,
    model: &mut ModelState,
    store: &data::BarStore,
    indicators: &mut IndicatorEngine,
    host: &dyn Host,
    caches: &mut SeriesCaches,
    input: &JsValue,
) -> JsValue {
    let state = js_object(&[
        ("layout", layout.to_js_value()),
        (
            "derived",
            js_object(&[
                ("leftStrip", JsValue::Number(layout.left_strip)),
                ("rightStrip", JsValue::Number(layout.right_strip)),
                ("stripFactor", JsValue::Number(layout.strip_factor)),
                ("footer", JsValue::Number(layout.footer)),
                ("plotLeft", JsValue::Number(layout.plot_left)),
                ("plotRight", JsValue::Number(layout.plot_right)),
                ("caches", cache_snapshot(model, store, indicators, caches)),
                ("indicators", indicator_snapshot(input, indicators)),
                (
                    "queries",
                    layout_queries(layout, model, store, field(input, "queries")),
                ),
            ]),
        ),
    ]);
    let _ = host;
    state
}

fn set_series_options(
    model: &mut ModelState,
    store: &data::BarStore,
    indicators: &mut IndicatorEngine,
    host: &dyn Host,
    input: &JsValue,
) -> Result<(), JsError> {
    let ids: Vec<JsString> = optional_field(input, "indicators")
        .map_or(&[][..], array)
        .iter()
        .map(|indicator| string(field(indicator, "id")).clone())
        .collect();
    let projections: Vec<IndicatorProjection<'_>> = ids
        .iter()
        .map(|id| {
            let definition = indicators
                .entry(&JsValue::String(id.clone()))
                .expect("fixture indicator exists")
                .definition();
            IndicatorProjection { id, definition }
        })
        .collect();
    let context = ModelContext {
        store,
        indicators: &projections,
        drawings: DrawingUsage::default(),
        interaction: InteractionGuard::default(),
    };
    for series in array(field(input, "series")) {
        if let Some(values) = optional_field(series, "values") {
            let values = array(values)
                .iter()
                .map(|value| match value {
                    JsValue::Number(value) => *value,
                    JsValue::String(value) if value == &key("NaN") => f64::NAN,
                    JsValue::String(value) if value == &key("Infinity") => f64::INFINITY,
                    JsValue::String(value) if value == &key("-Infinity") => f64::NEG_INFINITY,
                    _ => panic!("fixture external value must be numeric"),
                })
                .collect();
            model.add_series_with_values(series, values, &context)?;
        } else {
            model.add_series(series, &context)?;
        }
    }
    let _ = indicators;
    let _ = host;
    Ok(())
}

fn apply_mutation(
    mutation: &JsValue,
    state: &mut ModelDataState,
    model: &mut ModelState,
    indicators: &mut IndicatorEngine,
    host: &dyn Host,
) -> Result<(), JsError> {
    match string(field(mutation, "kind")).to_string_lossy().as_str() {
        "pan" => model.pan(
            state.store(),
            &JsValue::Number(number(field(mutation, "delta"))),
        ),
        "visibility" => {
            let id = string(field(mutation, "seriesId"));
            let series = model
                .series
                .iter_mut()
                .find(|series| series.id == *id)
                .unwrap();
            series.visible = matches!(field(mutation, "visible"), JsValue::Bool(true));
            Ok(())
        }
        "update-close" => {
            let index = number(field(mutation, "index")) as usize;
            let bar = state.store().at(index)?;
            let close = bar.close + number(field(mutation, "delta"));
            let open = if bar.open >= close { bar.open } else { close };
            let high = if bar.high >= close { bar.high } else { close };
            let low = if bar.low <= close { bar.low } else { close };
            let change = state
                .store_mut()
                .update(
                    index,
                    Bar {
                        time: bar.time,
                        open,
                        high,
                        low,
                        close,
                        volume: bar.volume,
                    },
                )?
                .change;
            if let Some(change) = change {
                let store = state.store();
                indicators.apply_change(store, &change);
                model.on_store_change(store, &change);
            }
            Ok(())
        }
        "set-data" => {
            let change = state
                .store_mut()
                .set_data(bars_from_array(field(mutation, "bars")))?
                .change;
            if let Some(change) = change {
                let store = state.store();
                indicators.apply_change(store, &change);
                model.on_store_change(store, &change);
            }
            Ok(())
        }
        _ => {
            let _ = host;
            panic!("unknown fixture mutation")
        }
    }
}

fn run_fixture_row(
    row: &JsValue,
    state: &mut ModelDataState,
    host: &dyn Host,
) -> Result<JsValue, JsError> {
    let input = decode(
        &parse_json_utf16(string(field(row, "input")).as_units(), JsonMode::Standard).unwrap(),
    );
    state
        .store_mut()
        .set_data(bars_for_data(field(&input, "data")))?;
    let store = state.store();
    let mut model = ModelState::new(store, field(&input, "model"))?;
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default())?;
    if let Some(indicator_rows) = optional_field(&input, "indicators") {
        for indicator in array(indicator_rows) {
            let _ = indicators.add(
                store,
                host,
                field(indicator, "id"),
                field(indicator, "name"),
                optional_field(indicator, "params").unwrap_or(&JsValue::Undefined),
            )?;
        }
    }
    set_series_options(&mut model, store, &mut indicators, host, &input)?;
    if let JsValue::Array(view) = field(&input, "view") {
        model.set_visible_range(store, &view[0], &view[1])?;
    }
    let width = number(field(field(&input, "size"), "width"));
    let height = number(field(field(&input, "size"), "height"));
    let mut caches = SeriesCaches::new();
    let mut layout = create_layout(
        &mut model,
        store,
        &mut indicators,
        host,
        &mut caches,
        width,
        height,
    )?;
    assert_eq!(layout.geometry_key(), &layout.geometry_key);
    if string(field(row, "scenarioId")) == &key("multi-axis-320-large-font") {
        assert_eq!(
            string(layout.geometry_font()).to_string_lossy(),
            "320px monospace"
        );
        let axis = layout.axis(&key("price"), Some(&key("return"))).unwrap();
        assert_eq!(axis.width, 48.0);
        assert_eq!(
            axis.label
                .as_ref()
                .map(JsString::to_string_lossy)
                .as_deref(),
            Some("Return")
        );
        assert_eq!(axis.precision, Some(4));
        assert_eq!(
            axis.tick_format
                .as_ref()
                .map(JsString::to_string_lossy)
                .as_deref(),
            Some("scientific")
        );
        assert_eq!(
            axis.prefix
                .as_ref()
                .map(JsString::to_string_lossy)
                .as_deref(),
            Some("~")
        );
        assert_eq!(
            axis.suffix
                .as_ref()
                .map(JsString::to_string_lossy)
                .as_deref(),
            Some("%")
        );
    }
    let mut steps = vec![js_object(&[
        ("kind", JsValue::String(key("initial"))),
        (
            "state",
            layout_state(
                &layout,
                &mut model,
                store,
                &mut indicators,
                host,
                &mut caches,
                &input,
            ),
        ),
    ])];
    for mutation in array(field(&input, "mutations")) {
        apply_mutation(mutation, state, &mut model, &mut indicators, host)?;
        let old_state = layout_state(
            &layout,
            &mut model,
            state.store(),
            &mut indicators,
            host,
            &mut caches,
            &input,
        );
        let refresh = matches!(field(mutation, "refresh"), JsValue::Bool(true));
        let refreshed = if refresh {
            layout = create_layout(
                &mut model,
                state.store(),
                &mut indicators,
                host,
                &mut caches,
                width,
                height,
            )?;
            layout_state(
                &layout,
                &mut model,
                state.store(),
                &mut indicators,
                host,
                &mut caches,
                &input,
            )
        } else {
            JsValue::Null
        };
        steps.push(js_object(&[
            ("kind", field(mutation, "kind").clone()),
            ("oldLayout", old_state),
            ("refreshed", refreshed),
        ]));
    }
    Ok(js_object(&[("steps", JsValue::Array(steps))]))
}

fn stringify(value: &JsValue) -> String {
    String::from_utf8(stringify_json_with(
        &encode(value),
        JsonMode::Standard,
        NumberDialect::PLATFORM,
    ))
    .unwrap()
}

fn first_difference(actual: &JsValue, expected: &JsValue, path: &str) -> Option<String> {
    match (actual, expected) {
        (JsValue::Array(actual), JsValue::Array(expected)) => {
            if actual.len() != expected.len() {
                return Some(format!(
                    "{path}: array length {} != {}",
                    actual.len(),
                    expected.len()
                ));
            }
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                if let Some(difference) =
                    first_difference(actual, expected, &format!("{path}[{index}]"))
                {
                    return Some(difference);
                }
            }
            None
        }
        (JsValue::Object(actual), JsValue::Object(expected)) => {
            let actual_keys: Vec<_> = actual.iter().map(|(key, _)| key.clone()).collect();
            let expected_keys: Vec<_> = expected.iter().map(|(key, _)| key.clone()).collect();
            if actual_keys != expected_keys {
                return Some(format!("{path}: object key order differs"));
            }
            for key in actual_keys {
                let actual = actual.get(&key).unwrap();
                let expected = expected.get(&key).unwrap();
                if let Some(difference) = first_difference(
                    actual,
                    expected,
                    &format!("{path}.{}", key.to_string_lossy()),
                ) {
                    return Some(difference);
                }
            }
            None
        }
        (JsValue::Number(actual), JsValue::Number(expected))
            if actual.to_bits() != expected.to_bits()
                && !(actual.is_nan() && expected.is_nan()) =>
        {
            Some(format!(
                "{path}: {:016x} != {:016x}",
                actual.to_bits(),
                expected.to_bits()
            ))
        }
        (JsValue::Number(actual), JsValue::Number(expected))
            if actual.to_bits() == expected.to_bits() || actual.is_nan() && expected.is_nan() =>
        {
            None
        }
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => None,
        (JsValue::Bool(actual), JsValue::Bool(expected)) if actual == expected => None,
        (JsValue::String(actual), JsValue::String(expected)) if actual == expected => None,
        _ => Some(format!("{path}: {actual:?} != {expected:?}")),
    }
}

#[test]
fn public_model_layout_matches_exact_geometry_cache_and_live_closure_fixtures() {
    let rows = fixture_rows();
    assert_eq!(rows.len(), 17);
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    let native_quickjs = native_layout_outputs(&rows);
    let host = NoZones;
    let mut state = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    for row in rows {
        assert_eq!(string(field(&row, "schema")), &key(SCHEMA));
        assert_eq!(string(field(&row, "oracleCommit")), &key(ORACLE_COMMIT));
        let expected_error = field(&row, "error");
        let result = run_fixture_row(&row, &mut state, &host);
        if !matches!(expected_error, JsValue::Null) {
            let error = result.err().unwrap_or_else(|| {
                panic!(
                    "{}: expected layout error",
                    string(field(&row, "scenarioId")).to_string_lossy()
                )
            });
            #[cfg(all(target_os = "linux", target_env = "gnu"))]
            let expected = expected_layout_error(&row, &native_quickjs);
            #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
            let expected = expected_layout_error(&row);
            assert_eq!(error.name, expected.0);
            assert_eq!(error.message, expected.1);
            continue;
        }
        let actual = result.unwrap_or_else(|error| {
            panic!(
                "{}: unexpected layout error {error}",
                string(field(&row, "scenarioId")).to_string_lossy()
            )
        });
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        let expected_text = expected_layout_text(&row, &native_quickjs);
        #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
        let expected_text = expected_layout_text(&row);
        let expected = decode(&parse_json(expected_text.as_bytes(), JsonMode::Standard).unwrap());
        if stringify(&actual) != expected_text {
            panic!(
                "{}: first difference: {}",
                string(field(&row, "scenarioId")).to_string_lossy(),
                first_difference(&actual, &expected, "$")
                    .unwrap_or_else(|| "wire ordering".to_owned())
            );
        }
        assert_eq!(
            stringify(&actual),
            expected_text,
            "{}: exact layout wire output/order",
            string(field(&row, "scenarioId")).to_string_lossy()
        );
        assert!(barochart_core::indicator_helpers::exact_state_equal(
            &actual, &expected
        ));
    }
}

#[test]
fn series_cache_threshold_is_a_block_index_and_keeps_nonowning_queries() {
    let mut store = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let columns = data::seeded_columns(65_536, 0x5eed).unwrap();
    let bars: Vec<_> = (0..65_536)
        .map(|index| Bar {
            time: columns.time[index],
            open: columns.open[index],
            high: columns.high[index],
            low: columns.low[index],
            close: columns.close[index],
            volume: columns.volume[index],
        })
        .collect();
    store.store_mut().set_data(bars).unwrap();
    let host = NoZones;
    let mut model = ModelState::new(
        store.store(),
        &parse(r#"{"panels":[{"id":"price","weight":1}],"visibleBars":512}"#),
    )
    .unwrap();
    model
        .add_series(
            &parse(r#"{"id":"close-line","type":"line","panel":"price","source":"close"}"#),
            &ModelContext::plain(store.store()),
        )
        .unwrap();
    model
        .set_visible_range(
            store.store(),
            &JsValue::Number(65_024.0),
            &JsValue::Number(65_535.0),
        )
        .unwrap();
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut caches = SeriesCaches::new();
    assert!(caches.is_empty());
    let layout = create_layout(
        &mut model,
        store.store(),
        &mut indicators,
        &host,
        &mut caches,
        1_024.0,
        600.0,
    )
    .unwrap();
    let id = key("close-line");
    let info = caches.info(&id).unwrap();
    assert_eq!(caches.len(), 1);
    assert_eq!(info.kind, series_cache::SeriesCacheKind::Block);
    assert_eq!(info.block_size, Some(32));
    assert!(info.finite_counts);
    assert_eq!(layout.panels.len(), 1);
    assert_eq!(layout.panels[0].axes.len(), 1);
    let values = &store.store().columns().close[..store.store().length()];
    let query = caches.query(&id, values, 65_024, 65_536).unwrap();
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    for value in values[65_024..65_536]
        .iter()
        .copied()
        .filter(|value| value.is_finite())
    {
        if value < minimum {
            minimum = value;
        }
        if value > maximum {
            maximum = value;
        }
    }
    assert_eq!(query.min.to_bits(), minimum.to_bits());
    assert_eq!(query.max.to_bits(), maximum.to_bits());
    assert_eq!(
        caches.finite_count(&id, values, 65_024, 65_536).unwrap(),
        512
    );
    assert!(!caches.has_gaps(&id, values, 65_024, 65_536).unwrap());
}

#[test]
fn accounted_layout_arc_shares_one_lease_and_releases_on_last_owner() {
    let state = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let mut model = ModelState::new(state.store(), &parse("{}")).unwrap();
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut caches = SeriesCaches::new();
    let account = MemoryAccount::new(8 << 20, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);

    let layout = create_layout_with_memory(
        &mut model,
        state.store(),
        &mut indicators,
        &NoZones,
        &mut caches,
        640.0,
        360.0,
        &context,
    )
    .unwrap();
    assert!(layout.requested_bytes() > 0);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        layout.requested_bytes()
    );

    let layout = std::sync::Arc::new(layout);
    let retained = std::sync::Arc::clone(&layout);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        layout.requested_bytes()
    );
    drop(layout);
    assert!(account.snapshot().requested_live_bytes > 0);
    drop(retained);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn layout_quota_failure_releases_the_whole_candidate() {
    let state = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let mut model = ModelState::new(state.store(), &parse("{}")).unwrap();
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut caches = SeriesCaches::new();
    let account = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);

    let error = create_layout_with_memory(
        &mut model,
        state.store(),
        &mut indicators,
        &NoZones,
        &mut caches,
        640.0,
        360.0,
        &context,
    )
    .unwrap_err();
    assert_eq!(error.name, "InternalError");
    assert_eq!(error.message.to_string_lossy(), "out of memory");
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
