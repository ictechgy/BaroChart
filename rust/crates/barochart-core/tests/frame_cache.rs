pub use barochart_core::{Host, HostError};
pub use barochart_core::{
    axis_scale, batch_options, block_range, checkpoint_codec, coercion, compaction, contracts,
    data, data_explorer, data_input, drawing_document, drawing_edit, drawing_geometry,
    drawing_types, drawing_validation, drawings, indicator_checkpoint, indicator_dispatch,
    indicator_engine, indicator_helpers, indicator_modules, indicator_params,
    indicator_params_update, indicator_query, indicator_registry, indicator_types,
    indicators_average, indicators_momentum, indicators_volume, ingestion, labels, layout, markets,
    model_state, native_checkpoints, position_drawing, range_index, scene, scene_parts,
    series_cache, session_studies, study_setup, trusted_studies,
};
use std::sync::Arc;

use barochart_core::chart_api;
use barochart_core::frame_cache;
use barochart_core::native_chart;

use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::native_packet::{
    NativePacketLayerView, NativePacketOptions, pack_native_layers_with_memory,
};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use chart_api::ChartApi;
use frame_cache::{NativeFrame, NativeFrameCache, NativeFrameInput};
use native_chart::NativeChart;

const ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-frame.leaf.jsonl");

struct NoZones;

impl Host for NoZones {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        if name == &JsString::from_str("UTC") {
            Ok(name.clone())
        } else {
            Err(HostError)
        }
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Ok(0)
    }
    fn log(&self, _: i32, _: &str) {}
}

fn chart(length: usize) -> NativeChart {
    chart_with_memory(
        length,
        MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

fn chart_with_memory(length: usize, memory: MemoryContext) -> NativeChart {
    let mut data =
        ModelDataState::new_with_memory(StoreOptions::default(), Vec::new(), memory).unwrap();
    let columns = seeded_columns(length, 42).unwrap();
    data.store_mut()
        .set_columns(
            &ColumnInputs {
                time: NumericColumn::F64(&columns.time),
                open: NumericColumn::F64(&columns.open),
                high: NumericColumn::F64(&columns.high),
                low: NumericColumn::F64(&columns.low),
                close: NumericColumn::F64(&columns.close),
                volume: NumericColumn::F64(&columns.volume),
            },
            Some(length),
        )
        .unwrap();
    let mut options = JsObject::new();
    options.insert(
        JsString::from_str("series"),
        JsValue::Array(vec![{
            let mut series = JsObject::new();
            series.insert(
                JsString::from_str("id"),
                JsValue::String(JsString::from_str("price")),
            );
            series.insert(
                JsString::from_str("type"),
                JsValue::String(JsString::from_str("candles")),
            );
            series.insert(
                JsString::from_str("panel"),
                JsValue::String(JsString::from_str("price")),
            );
            JsValue::Object(series)
        }]),
    );
    NativeChart::new(
        data,
        &JsValue::Object(options),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap()
}

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(JsString::from_str(name), item.clone());
    }
    JsValue::Object(value)
}

fn call(chart: &mut NativeChart, operation: &str, args: &[JsValue]) -> JsValue {
    ChartApi::new(chart, &NoZones)
        .dispatch(&JsString::from_str(operation), args)
        .unwrap()
}

fn frame_chart() -> NativeChart {
    let mut chart = chart(16);
    call(
        &mut chart,
        "addIndicator",
        &[
            text("ema"),
            text("ema"),
            object(&[("period", JsValue::Number(3.0))]),
        ],
    );
    call(
        &mut chart,
        "addSeries",
        &[object(&[
            ("id", text("ema-line")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("ema")),
        ])],
    );
    call(
        &mut chart,
        "addSeries",
        &[object(&[
            ("id", text("external")),
            ("type", text("line")),
            ("panel", text("price")),
            (
                "values",
                JsValue::Array(
                    (0..16)
                        .map(|index| JsValue::Number(200.0 + index as f64))
                        .collect(),
                ),
            ),
            ("color", text("#abcdef")),
        ])],
    );
    let first = chart.data().store().at(2).unwrap();
    let second = chart.data().store().at(12).unwrap();
    call(
        &mut chart,
        "addDrawing",
        &[object(&[
            ("id", text("d")),
            ("type", text("trendline")),
            ("panel", text("price")),
            (
                "points",
                JsValue::Array(vec![
                    object(&[
                        ("time", JsValue::Number(first.time)),
                        ("price", JsValue::Number(first.close)),
                    ]),
                    object(&[
                        ("time", JsValue::Number(second.time)),
                        ("price", JsValue::Number(second.close)),
                    ]),
                ]),
            ),
        ])],
    );
    call(&mut chart, "selectDrawing", &[JsValue::Null]);
    chart
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value
        .get(&JsString::from_str(name))
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array: {value:?}")
    };
    value
}

fn string(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string: {value:?}")
    };
    value.to_string_lossy()
}

fn parse(value: &str) -> JsValue {
    parse_json(value.as_bytes(), JsonMode::Standard).unwrap()
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
            let mut result = JsObject::new();
            for entry in entries {
                let entry = array(entry);
                let JsValue::String(name) = &entry[0] else {
                    panic!("entry name")
                };
                result.insert(name.clone(), decode_wire(&entry[1]));
            }
            return JsValue::Object(result);
        }
    }
    let mut result = JsObject::new();
    for (name, child) in encoded.iter() {
        result.insert(name.clone(), decode_wire(child));
    }
    JsValue::Object(result)
}

fn lossless(value: &JsValue) -> Vec<u8> {
    stringify_json(value, JsonMode::Lossless)
}

fn json_round_trip(value: &JsValue) -> JsValue {
    parse_json(
        &stringify_json(value, JsonMode::Standard),
        JsonMode::Standard,
    )
    .unwrap()
}

fn assert_wire(actual: &JsValue, expected: &JsValue, label: &str) {
    // nativeRenderFrameJSON compares after JSON.stringify, which omits undefined object fields.
    let actual = lossless(&json_round_trip(actual));
    let expected = lossless(expected);
    if actual != expected {
        let at = actual
            .iter()
            .zip(&expected)
            .position(|(left, right)| left != right)
            .unwrap_or(std::cmp::min(actual.len(), expected.len()));
        let from = at.saturating_sub(120);
        let actual_to = std::cmp::min(actual.len(), at + 240);
        let expected_to = std::cmp::min(expected.len(), at + 240);
        panic!(
            "{label} differs at {at}\nactual: {}\nexpected: {}",
            String::from_utf8_lossy(&actual[from..actual_to]),
            String::from_utf8_lossy(&expected[from..expected_to])
        );
    }
}

fn oracle_frames() -> Vec<(String, JsValue, JsValue)> {
    ORACLE
        .lines()
        .skip(1)
        .map(parse)
        .map(|row| {
            let result = decode_wire(field(&row, "result"));
            (
                string(field(&row, "id")),
                field(&result, "json").clone(),
                field(&result, "packet").clone(),
            )
        })
        .collect()
}

fn optional_field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value.get(&JsString::from_str(name))
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number: {value:?}")
    };
    *value
}

fn command_numbers(value: &JsValue, name: &str) -> Vec<f64> {
    array(field(value, name)).iter().map(number).collect()
}

fn nullish(value: Option<&JsValue>) -> bool {
    matches!(value, None | Some(JsValue::Null | JsValue::Undefined))
}

fn packet_string(strings: &mut Vec<JsString>, value: &JsValue) -> f64 {
    let JsValue::String(value) = value else {
        panic!("packet string: {value:?}")
    };
    if let Some(index) = strings.iter().position(|item| item == value) {
        return index as f64;
    }
    strings.push(value.clone());
    (strings.len() - 1) as f64
}

fn pack_frame(frame: &NativeFrame<'_>) -> JsValue {
    let mut strings = Vec::new();
    let mut numbers = Vec::new();
    let layers = [
        frame.base_changed.then_some(frame.base.commands()),
        frame.drawings_changed.then_some(frame.drawings.commands()),
        Some(frame.hover.commands()),
    ];
    let mut layer_metadata = Vec::with_capacity(layers.len());
    for commands in layers {
        let Some(commands) = commands else {
            layer_metadata.push(JsValue::Null);
            continue;
        };
        layer_metadata.push(object(&[(
            "commands",
            JsValue::Number(commands.len() as f64),
        )]));
        for command in commands {
            let op = match string(field(command, "op")).as_str() {
                "lines" => 1.0,
                "rects" => 2.0,
                "path" => 3.0,
                "box" => 4.0,
                "ellipse" => 5.0,
                "text" => 6.0,
                other => panic!("unsupported packet operation {other}"),
            };
            let color = packet_string(&mut strings, field(command, "color"));
            let stroke = match optional_field(command, "width") {
                value if nullish(value) => 1.0,
                Some(value) => number(value),
                None => unreachable!(),
            };
            let clip = match optional_field(command, "clip") {
                value if nullish(value) => None,
                Some(value) => Some(array(value).iter().map(number).collect::<Vec<_>>()),
                None => unreachable!(),
            };
            let dash = match optional_field(command, "dash") {
                value if nullish(value) => Vec::new(),
                Some(value) => array(value).iter().map(number).collect(),
                None => unreachable!(),
            };
            let fill = match optional_field(command, "fill") {
                value if nullish(value) => -1.0,
                Some(value) => packet_string(&mut strings, value),
                None => unreachable!(),
            };
            let baseline = if op == 3.0 && fill != -1.0 {
                number(field(command, "baseline"))
            } else {
                0.0
            };
            let (text_index, font_index) = if op == 6.0 {
                let text_index = packet_string(&mut strings, field(command, "text"));
                let font_index = match optional_field(command, "font") {
                    value if nullish(value) => packet_string(&mut strings, &text("12px monospace")),
                    Some(value) => packet_string(&mut strings, value),
                    None => unreachable!(),
                };
                (text_index, font_index)
            } else {
                (-1.0, -1.0)
            };
            let geometry = if op <= 2.0 {
                command_numbers(command, "coords")
            } else if op == 3.0 {
                command_numbers(command, "points")
            } else if op <= 5.0 {
                ["x", "y", "w", "h"]
                    .into_iter()
                    .map(|name| number(field(command, name)))
                    .collect()
            } else {
                ["x", "y"]
                    .into_iter()
                    .map(|name| number(field(command, name)))
                    .collect()
            };
            let record_length = 15 + dash.len() + geometry.len();
            numbers.extend([
                op,
                record_length as f64,
                color,
                stroke,
                if clip.is_some() { 1.0 } else { 0.0 },
            ]);
            numbers.extend(clip.as_deref().unwrap_or(&[0.0; 4]));
            numbers.extend([
                dash.len() as f64,
                fill,
                baseline,
                text_index,
                font_index,
                geometry.len() as f64,
            ]);
            numbers.extend(dash);
            numbers.extend(geometry);
        }
    }
    object(&[
        (
            "metadata",
            object(&[
                ("schema", text("aster.native.commands")),
                ("version", JsValue::Number(1.0)),
                ("mode", text("frame")),
                ("width", JsValue::Number(frame.base.metadata().width())),
                ("height", JsValue::Number(frame.base.metadata().height())),
                ("background", frame.base.metadata().background().clone()),
                ("stats", frame.stats.clone()),
                (
                    "strings",
                    JsValue::Array(strings.into_iter().map(JsValue::String).collect()),
                ),
                ("layers", JsValue::Array(layer_metadata)),
            ]),
        ),
        (
            "numbers",
            JsValue::Array(numbers.into_iter().map(JsValue::Number).collect()),
        ),
    ])
}

#[test]
fn unchanged_frame_borrows_the_same_base_and_drawing_command_allocations() {
    let mut chart = chart(16);
    let mut cache = NativeFrameCache::new();
    let mut resolver = |_: &mut NativeChart, _: &layout::Layout| Ok(None);
    let (base, drawings) = {
        let frame = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut resolver,
            })
            .unwrap();
        assert!(frame.base_changed);
        assert!(frame.drawings_changed);
        (
            frame.base.commands().as_ptr(),
            frame.drawings.commands().as_ptr(),
        )
    };
    let frame = cache
        .frame(NativeFrameInput {
            chart: &mut chart,
            host: &NoZones,
            width: 640.0,
            height: 360.0,
            force_base: false,
            resolve_crosshair: &mut resolver,
        })
        .unwrap();
    assert!(!frame.base_changed);
    assert!(!frame.drawings_changed);
    assert_eq!(frame.base.commands().as_ptr(), base);
    assert_eq!(frame.drawings.commands().as_ptr(), drawings);
}

#[test]
fn accounted_frame_replacement_observes_old_plus_candidate_peak_and_releases() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let mut chart = chart_with_memory(16, context.clone());
    let chart_bytes = account.snapshot().requested_live_bytes;
    let mut cache = NativeFrameCache::new_with_memory(context);
    let mut resolver = |_: &mut NativeChart, _: &layout::Layout| Ok(None);

    let (first_base_bytes, retained_layout) = {
        let frame = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut resolver,
            })
            .unwrap();
        (
            frame.base.metadata().requested_bytes(),
            frame.retain_layout(),
        )
    };
    let first_live = account.snapshot().requested_live_bytes;
    assert!(first_base_bytes > 0);
    let retained_again = Arc::clone(&retained_layout);
    assert_eq!(account.snapshot().requested_live_bytes, first_live);
    drop(retained_again);
    drop(retained_layout);

    let second_base_bytes = {
        let frame = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: true,
                resolve_crosshair: &mut resolver,
            })
            .unwrap();
        frame.base.metadata().requested_bytes()
    };
    assert!(account.snapshot().requested_peak_bytes >= first_live + second_base_bytes);
    drop(cache);
    assert_eq!(account.snapshot().requested_live_bytes, chart_bytes);
    drop(chart);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn quota_failed_frame_candidate_preserves_the_old_cache() {
    let limit = 64 << 20;
    let account = MemoryAccount::new(limit, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let mut chart = chart_with_memory(16, context.clone());
    let mut cache = NativeFrameCache::new_with_memory(context);
    let mut resolver = |_: &mut NativeChart, _: &layout::Layout| Ok(None);
    let old_base = {
        let frame = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut resolver,
            })
            .unwrap();
        frame.base.commands().as_ptr()
    };
    let before_failure = account.snapshot().requested_live_bytes;
    let filler = account.reserve(limit - before_failure).unwrap();
    let error = match cache.frame(NativeFrameInput {
        chart: &mut chart,
        host: &NoZones,
        width: 640.0,
        height: 360.0,
        force_base: true,
        resolve_crosshair: &mut resolver,
    }) {
        Ok(_) => panic!("replacement must fail under the measured steady-state quota"),
        Err(error) => error,
    };
    assert_eq!(error.name, "InternalError");
    assert_eq!(error.message.to_string_lossy(), "out of memory");
    assert_eq!(account.snapshot().requested_live_bytes, limit);
    drop(filler);
    assert_eq!(account.snapshot().requested_live_bytes, before_failure);

    let frame = cache
        .frame(NativeFrameInput {
            chart: &mut chart,
            host: &NoZones,
            width: 640.0,
            height: 360.0,
            force_base: false,
            resolve_crosshair: &mut resolver,
        })
        .unwrap();
    assert!(!frame.base_changed);
    assert_eq!(frame.base.commands().as_ptr(), old_base);
}

#[test]
fn hover_only_packet_borrows_cached_layers_without_copying_base_f64_records() {
    let mut chart = frame_chart();
    let mut cache = NativeFrameCache::new();
    let packet_account = MemoryAccount::new(8 << 20, OomStyle::InternalErrorLowercase);
    let packet_memory = MemoryContext::accounted(&packet_account);
    let mode = text("frame");
    let width = JsValue::Number(640.0);
    let height = JsValue::Number(360.0);
    let mut no_hover = |_: &mut NativeChart, _: &layout::Layout| Ok(None);
    let (base_ptr, initial_numbers) = {
        let frame = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut no_hover,
            })
            .unwrap();
        let packet = pack_native_layers_with_memory(
            &[
                Some(NativePacketLayerView::Commands(frame.base.commands())),
                Some(NativePacketLayerView::Commands(frame.drawings.commands())),
                Some(NativePacketLayerView::Commands(frame.hover.commands())),
            ],
            NativePacketOptions {
                mode: &mode,
                width: &width,
                height: &height,
                background: frame.base.metadata().background(),
                stats: frame.stats,
            },
            NumberDialect::Ecma,
            &packet_memory,
        )
        .unwrap();
        (frame.base.commands().as_ptr(), packet.numbers.len())
    };
    assert_eq!(packet_account.snapshot().requested_live_bytes, 0);

    let mut hover = |_: &mut NativeChart, layout: &layout::Layout| {
        let panel = &layout.panels[0];
        Ok(Some(scene::ResolvedCrosshair {
            x: (panel.left + panel.right) / 2.0,
            y: (panel.top + panel.bottom) / 2.0,
            panel: panel.id.clone(),
            snapped: false,
            axis_id: None,
            price: None,
        }))
    };
    let frame = cache
        .frame(NativeFrameInput {
            chart: &mut chart,
            host: &NoZones,
            width: 640.0,
            height: 360.0,
            force_base: false,
            resolve_crosshair: &mut hover,
        })
        .unwrap();
    assert!(!frame.base_changed);
    assert!(!frame.drawings_changed);
    assert_eq!(frame.base.commands().as_ptr(), base_ptr);
    let packet = pack_native_layers_with_memory(
        &[
            None,
            None,
            Some(NativePacketLayerView::Commands(frame.hover.commands())),
        ],
        NativePacketOptions {
            mode: &mode,
            width: &width,
            height: &height,
            background: frame.base.metadata().background(),
            stats: frame.stats,
        },
        NumberDialect::Ecma,
        &packet_memory,
    )
    .unwrap();
    assert!(!packet.numbers.is_empty());
    assert!(packet.numbers.len() < initial_numbers);
    assert_eq!(
        packet_account.snapshot().requested_live_bytes,
        packet.requested_bytes()
    );
    drop(packet);
    assert_eq!(packet_account.snapshot().requested_live_bytes, 0);
}

#[test]
fn unbound_indicator_insertions_do_not_invalidate_bound_entry_identity() {
    let mut chart = frame_chart();
    let mut cache = NativeFrameCache::new();
    let _ = render(&mut cache, &mut chart, None, false);

    // Force the engine's entry Vec to grow. JS observes only each bound entry and its
    // definition, not the whole indicator engine or unrelated Map entries.
    for index in 0..8 {
        call(
            &mut chart,
            "addIndicator",
            &[
                text(&format!("unused-{index}")),
                text("sma"),
                object(&[("period", JsValue::Number(2.0))]),
            ],
        );
    }

    let (frame, _) = render(&mut cache, &mut chart, None, false);
    assert!(matches!(field(&frame, "base"), JsValue::Null));
    assert!(matches!(field(&frame, "drawings"), JsValue::Null));
}

#[test]
fn resolver_static_state_mutation_invalidates_the_next_frame_base() {
    for mutation in ["series", "theme", "view"] {
        let mut chart = frame_chart();
        let mut cache = NativeFrameCache::new();
        let mut no_op = |_: &mut NativeChart, _: &layout::Layout| Ok(None);
        let initial = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut no_op,
            })
            .unwrap();
        assert!(initial.base_changed, "initial {mutation}");

        let mut mutate = |chart: &mut NativeChart, _: &layout::Layout| {
            match mutation {
                "series" => chart.model_mut().series[0].dirty_from = 1.0,
                "theme" => chart
                    .set_theme_legacy(&object(&[("grid", text("#123456"))]))
                    .unwrap(),
                "view" => chart.model_mut().view.from += 1.0,
                _ => unreachable!(),
            }
            Ok(None)
        };
        let reused = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut mutate,
            })
            .unwrap();
        assert!(!reused.base_changed, "resolver reuse {mutation}");

        let rebuilt = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut no_op,
            })
            .unwrap();
        assert!(rebuilt.base_changed, "resolver mutation {mutation}");

        let stable = cache
            .frame(NativeFrameInput {
                chart: &mut chart,
                host: &NoZones,
                width: 640.0,
                height: 360.0,
                force_base: false,
                resolve_crosshair: &mut no_op,
            })
            .unwrap();
        assert!(!stable.base_changed, "stable rebuild {mutation}");
    }
}

#[test]
fn resolver_drawing_mutations_invalidate_the_next_drawing_layer() {
    for force_base in [false, true] {
        for mutation in ["remove", "select"] {
            let mut chart = frame_chart();
            let mut cache = NativeFrameCache::new();
            let mut no_op = |_: &mut NativeChart, _: &layout::Layout| Ok(None);
            let initial = cache
                .frame(NativeFrameInput {
                    chart: &mut chart,
                    host: &NoZones,
                    width: 640.0,
                    height: 360.0,
                    force_base: false,
                    resolve_crosshair: &mut no_op,
                })
                .unwrap();
            let initial_count = initial.drawings.commands().len();
            assert!(initial_count > 0);
            let mut mutate = |chart: &mut NativeChart, _: &layout::Layout| {
                let id = JsString::from_str("d");
                match mutation {
                    "remove" => {
                        assert!(chart.drawings_mut().remove(&id)?);
                    }
                    "select" => chart.drawings_mut().select(Some(&id))?,
                    _ => unreachable!(),
                }
                Ok(None)
            };
            let during = cache
                .frame(NativeFrameInput {
                    chart: &mut chart,
                    host: &NoZones,
                    width: 640.0,
                    height: 360.0,
                    force_base,
                    resolve_crosshair: &mut mutate,
                })
                .unwrap();
            assert_eq!(during.drawings.commands().len(), initial_count);
            let next = cache
                .frame(NativeFrameInput {
                    chart: &mut chart,
                    host: &NoZones,
                    width: 640.0,
                    height: 360.0,
                    force_base: false,
                    resolve_crosshair: &mut no_op,
                })
                .unwrap();
            assert!(!next.base_changed);
            assert!(next.drawings_changed, "{mutation}, force_base={force_base}");
            if mutation == "remove" {
                assert!(next.drawings.commands().is_empty());
            } else {
                assert!(next.drawings.commands().len() > initial_count);
            }
            let stable = cache
                .frame(NativeFrameInput {
                    chart: &mut chart,
                    host: &NoZones,
                    width: 640.0,
                    height: 360.0,
                    force_base: false,
                    resolve_crosshair: &mut no_op,
                })
                .unwrap();
            assert!(!stable.drawings_changed);
        }
    }
}

fn render(
    cache: &mut NativeFrameCache,
    chart: &mut NativeChart,
    cursor: Option<(f64, f64)>,
    force: bool,
) -> (JsValue, JsValue) {
    let mut resolver = move |_: &mut NativeChart, layout: &layout::Layout| {
        Ok(cursor.and_then(|(x, y)| {
            layout
                .panels
                .iter()
                .find(|panel| {
                    x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom
                })
                .map(|panel| scene::ResolvedCrosshair {
                    x,
                    y,
                    panel: panel.id.clone(),
                    snapped: false,
                    axis_id: None,
                    price: None,
                })
        }))
    };
    let frame = cache
        .frame(NativeFrameInput {
            chart,
            host: &NoZones,
            width: 640.0,
            height: 360.0,
            force_base: force,
            resolve_crosshair: &mut resolver,
        })
        .unwrap();
    let packet = pack_frame(&frame);
    (frame.to_js_value(), packet)
}

#[test]
fn node22_frame_sequence_matches_exact_layers_flags_and_command_bits() {
    let expected = oracle_frames();
    let mut chart = frame_chart();
    let mut primary = NativeFrameCache::new();
    let mut secondary = NativeFrameCache::new();
    let mut cursor = None;
    for (id, expected_json, expected_packet) in expected {
        match id.as_str() {
            "initial" | "unchanged" => {}
            "hover" => cursor = Some((240.0, 140.0)),
            "style" => {
                call(
                    &mut chart,
                    "setSeries",
                    &[text("price"), object(&[("color", text("#ff0000"))])],
                );
            }
            "view" => {
                call(
                    &mut chart,
                    "setVisibleRange",
                    &[JsValue::Number(2.5), JsValue::Number(12.5)],
                );
            }
            "data-lazy-build" => {
                let bar = chart.data().store().at(4).unwrap();
                call(
                    &mut chart,
                    "applyDataEvent",
                    &[object(&[
                        ("kind", text("correction")),
                        (
                            "bar",
                            object(&[
                                ("time", JsValue::Number(bar.time)),
                                ("open", JsValue::Number(bar.open)),
                                (
                                    "high",
                                    JsValue::Number(barochart_js::num::js_max(&[
                                        bar.high,
                                        bar.close + 1.0,
                                    ])),
                                ),
                                ("low", JsValue::Number(bar.low)),
                                ("close", JsValue::Number(bar.close + 1.0)),
                                ("volume", JsValue::Number(bar.volume)),
                            ]),
                        ),
                    ])],
                );
            }
            "lazy-indicator-stable" => {}
            "drawing-select" => {
                call(&mut chart, "selectDrawing", &[text("d")]);
            }
            "drawing-edit" => {
                let points = chart.drawings().items()[0]
                    .points
                    .iter()
                    .map(|point| {
                        object(&[
                            ("time", JsValue::Number(point.time)),
                            ("price", JsValue::Number(point.price + 1.0)),
                        ])
                    })
                    .collect();
                call(
                    &mut chart,
                    "editDrawing",
                    &[text("d"), object(&[("points", JsValue::Array(points))])],
                );
            }
            "drawing-undo" => {
                call(&mut chart, "undo", &[]);
            }
            "same-primitives-replacement" => {
                let view = chart.model().view;
                let panels = chart.model().panels.clone();
                chart.model_mut().view = view;
                chart.model_mut().panels = panels;
            }
            "second-view-initial" | "first-view-stable" => {}
            "raw-theme-object-same" => {
                let theme = chart.model().theme().clone();
                chart.set_theme_legacy(&theme).unwrap();
            }
            "raw-theme-value" => {
                chart
                    .set_theme_legacy(&object(&[("grid", text("#123456"))]))
                    .unwrap();
            }
            "equal-values-replacement" => {
                let values = chart
                    .model()
                    .series
                    .iter()
                    .find(|series| series.id == JsString::from_str("external"))
                    .unwrap()
                    .values
                    .as_ref()
                    .unwrap()
                    .iter()
                    .copied()
                    .map(JsValue::Number)
                    .collect();
                call(
                    &mut chart,
                    "setSeriesValues",
                    &[text("external"), JsValue::Array(values)],
                );
            }
            "symbol-setter" => {
                call(
                    &mut chart,
                    "setSymbol",
                    &[object(&[
                        ("id", text("BTC-USD")),
                        ("exchange", text("DEMO")),
                        ("timezone", text("UTC")),
                        ("currency", text("USD")),
                        ("volumeUnit", text("BTC")),
                        ("priceDecimals", JsValue::Number(2.0)),
                        ("tickSize", JsValue::Number(0.01)),
                        ("adjustment", text("raw")),
                    ])],
                );
            }
            "force" => {}
            other => panic!("unknown frame {other}"),
        }
        let (actual_json, actual_packet) = if id == "second-view-initial" {
            render(&mut secondary, &mut chart, cursor, false)
        } else {
            render(&mut primary, &mut chart, cursor, id == "force")
        };
        assert_wire(&actual_json, &expected_json, &format!("frame {id} JSON"));
        assert_wire(
            &actual_packet,
            &expected_packet,
            &format!("frame {id} packet"),
        );
    }
}
