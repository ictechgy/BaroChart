use barochart_core::chart_api::{ChartApi, ChartApiContext, ChartOperation, ChartOperationStatus};
use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::native_chart::NativeChart;
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

const ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-chart.leaf.jsonl");

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

fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (key, item) in entries {
        value.insert(JsString::from_str(key), item.clone());
    }
    JsValue::Object(value)
}

fn field<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value
        .get(&JsString::from_str(key))
        .unwrap_or_else(|| panic!("missing {key}"))
}

fn optional<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value.get(&JsString::from_str(key))
}

fn string_value(value: &JsValue) -> String {
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
        if let Some(JsValue::Object(_)) = encoded.get(&JsString::from_str("$object")) {
            panic!("object entries must be an array")
        }
        if let Some(JsValue::Array(entries)) = encoded.get(&JsString::from_str("$object")) {
            let mut result = JsObject::new();
            for entry in entries {
                let JsValue::Array(entry) = entry else {
                    panic!("entry")
                };
                let JsValue::String(key) = &entry[0] else {
                    panic!("key")
                };
                result.insert(key.clone(), decode_wire(&entry[1]));
            }
            return JsValue::Object(result);
        }
    }
    let mut result = JsObject::new();
    for (key, child) in encoded.iter() {
        result.insert(key.clone(), decode_wire(child));
    }
    JsValue::Object(result)
}

fn lossless(value: &JsValue) -> Vec<u8> {
    stringify_json(value, JsonMode::Lossless)
}

fn oracle_case(id: &str) -> JsValue {
    ORACLE
        .lines()
        .skip(1)
        .map(parse)
        .find(|row| string_value(field(row, "id")) == id)
        .unwrap()
}

fn inspect_with_select(chart: &mut NativeChart) -> JsValue {
    let tool = JsString::from_str("select");
    ChartApi::with_context(
        chart,
        &NoZones,
        ChartApiContext {
            tool: Some(&tool),
            ..ChartApiContext::default()
        },
    )
    .dispatch(&JsString::from_str("inspect"), &[])
    .unwrap()
}

fn seeded_data(length: usize, serial: f64) -> ModelDataState {
    let mut data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    assert_eq!(
        serial, 1.0,
        "leaf constructor receives the caller-owned serial"
    );
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
    data
}

#[test]
fn null_and_undefined_build_the_real_legacy_composite() {
    for options in [JsValue::Null, JsValue::Undefined] {
        let chart =
            NativeChart::new(seeded_data(5, 1.0), &options, NumberDialect::Ecma, &NoZones).unwrap();
        assert_eq!(chart.data().store().length(), 5);
        assert_eq!(chart.model().panels.len(), 2);
        assert_eq!(
            string_value(field(&chart.model().panels[0].to_js_value(), "label")),
            "ASTER · NATIVE"
        );
        assert_eq!(
            string_value(field(&chart.model().panels[1].to_js_value(), "label")),
            "VOLUME"
        );
        assert_eq!(
            chart
                .model()
                .series
                .iter()
                .map(|series| series.id.to_string_lossy())
                .collect::<Vec<_>>(),
            ["price", "volume", "ema"]
        );
        let ema = chart.indicators().entry(&text("ema")).unwrap();
        assert!(matches!(ema.params(), JsValue::Object(params) if params.is_empty()));
        assert!(chart.series_caches().is_empty());
        assert!(chart.drawing_cache().is_empty());
    }
}

#[test]
fn object_options_use_api_theme_and_series_policy_after_model_construction() {
    let options = object(&[
        ("theme", object(&[("background", text("red"))])),
        (
            "series",
            JsValue::Array(vec![object(&[
                ("id", text("typed")),
                ("type", text("line")),
                ("panel", text("price")),
                ("color", text("blue")),
            ])]),
        ),
    ]);
    let chart =
        NativeChart::new(seeded_data(3, 1.0), &options, NumberDialect::Ecma, &NoZones).unwrap();
    assert_eq!(chart.model().panels.len(), 1);
    assert!(optional(&chart.model().panels[0].to_js_value(), "label").is_none());
    assert_eq!(
        string_value(field(chart.model().theme(), "background")),
        "#ff0000ff"
    );
    assert_eq!(chart.model().series.len(), 1);
    assert_eq!(
        string_value(field(&chart.model().series[0].to_js_value(), "color")),
        "#0000ffff"
    );
    assert!(chart.indicators().is_empty());
}

#[test]
fn falsey_theme_is_skipped_and_bad_series_rejects_the_whole_candidate() {
    let options = object(&[
        ("theme", JsValue::Bool(false)),
        ("series", JsValue::Array(Vec::new())),
    ]);
    let chart =
        NativeChart::new(seeded_data(0, 1.0), &options, NumberDialect::Ecma, &NoZones).unwrap();
    assert_eq!(
        string_value(field(chart.model().theme(), "background")),
        "#0c1320"
    );

    let bad = object(&[(
        "series",
        JsValue::Array(vec![object(&[
            ("id", text("bad")),
            ("type", text("line")),
            ("panel", text("missing")),
        ])]),
    )]);
    let error = NativeChart::new(seeded_data(0, 1.0), &bad, NumberDialect::Ecma, &NoZones)
        .err()
        .expect("candidate must fail");
    assert_eq!(error.name, "Error");
    assert_eq!(
        error.message.to_string_lossy(),
        "Unique series id and existing panel required"
    );
}

#[test]
fn command_metadata_is_the_exact_65_name_js_dispatch_surface() {
    assert_eq!(ChartOperation::ALL.len(), 65);
    let names = ChartOperation::ALL
        .iter()
        .map(|operation| operation.name())
        .collect::<Vec<_>>();
    assert_eq!(names.first(), Some(&"compactData"));
    assert_eq!(names.last(), Some(&"inspect"));
    assert_eq!(names.iter().filter(|name| **name == "setData").count(), 1);
    assert_eq!(
        ChartOperation::parse(&JsString::from_str("addIndicator"))
            .unwrap()
            .max_arity(),
        3
    );
    assert_eq!(
        ChartOperation::parse(&JsString::from_str("inspect"))
            .unwrap()
            .max_arity(),
        0
    );
    assert!(ChartOperation::parse(&JsString::from_str("registerIndicatorSource")).is_none());
    assert_eq!(
        ChartOperation::ALL
            .iter()
            .filter(|operation| operation.status() == ChartOperationStatus::InteractionPending)
            .count(),
        7
    );
}

#[test]
fn data_commit_invalidates_indicator_then_model_and_reuses_the_single_store() {
    let mut chart = NativeChart::new(
        seeded_data(3, 1.0),
        &object(&[("series", JsValue::Array(Vec::new()))]),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let serial = chart.data().store().serial();
    let mut api = ChartApi::new(&mut chart, &NoZones);
    api.dispatch(
        &JsString::from_str("addIndicator"),
        &[
            text("mean"),
            text("ema"),
            object(&[("period", JsValue::Number(2.0))]),
        ],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("addSeries"),
        &[object(&[
            ("id", text("mean")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("mean")),
        ])],
    )
    .unwrap();
    let before = api
        .chart()
        .indicators()
        .entry(&text("mean"))
        .unwrap()
        .revision();
    let rows = JsValue::Array(vec![object(&[
        ("time", JsValue::Number(10.0)),
        ("open", JsValue::Number(1.0)),
        ("high", JsValue::Number(1.0)),
        ("low", JsValue::Number(1.0)),
        ("close", JsValue::Number(1.0)),
        ("volume", JsValue::Number(1.0)),
    ])]);
    assert!(matches!(
        api.dispatch(&JsString::from_str("setData"), &[rows])
            .unwrap(),
        JsValue::Null
    ));
    assert_eq!(api.chart().data().store().serial(), serial);
    assert_eq!(
        api.chart().model().view.from.to_bits(),
        (-0.5_f64).to_bits()
    );
    let entry = api.chart().indicators().entry(&text("mean")).unwrap();
    assert_eq!(entry.revision(), before);
    assert_eq!(entry.dirty(), 0);
    assert!(entry.invalidated());
}

#[test]
fn actual_node22_oracle_matches_init_inspect_byte_tree_snapshots() {
    let cases = [
        ("legacy-null", 5, JsValue::Null, true),
        ("legacy-undefined-default", 5, JsValue::Undefined, false),
        ("typed-empty-object", 0, object(&[]), false),
        (
            "typed-theme-series",
            3,
            object(&[
                ("theme", object(&[("background", text("red"))])),
                (
                    "series",
                    JsValue::Array(vec![object(&[
                        ("id", text("typed")),
                        ("type", text("line")),
                        ("panel", text("price")),
                        ("source", text("close")),
                        ("color", text("blue")),
                    ])]),
                ),
            ]),
            false,
        ),
    ];
    for (id, count, options, nested) in cases {
        let mut chart = NativeChart::new(
            seeded_data(count, 1.0),
            &options,
            NumberDialect::Ecma,
            &NoZones,
        )
        .unwrap();
        let actual = inspect_with_select(&mut chart);
        let row = oracle_case(id);
        let decoded = decode_wire(field(&row, "result"));
        let expected = if nested {
            field(&decoded, "inspect")
        } else {
            &decoded
        };
        assert_eq!(
            lossless(&actual),
            lossless(expected),
            "actual native bridge oracle mismatch: {id}"
        );
    }
}

#[test]
fn typed_indicator_buffer_commits_lazy_calculation_before_slice_validation() {
    let mut chart = NativeChart::new(
        seeded_data(5, 1.0),
        &object(&[("series", JsValue::Array(Vec::new()))]),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    ChartApi::new(&mut chart, &NoZones)
        .dispatch(
            &JsString::from_str("addIndicator"),
            &[
                text("mean"),
                text("ema"),
                object(&[("period", JsValue::Number(3.0))]),
            ],
        )
        .unwrap();
    let before = chart.indicators().entry(&text("mean")).unwrap().revision();
    let bar = object(&[
        ("time", JsValue::Number(1_700_000_300_000.0)),
        ("open", JsValue::Number(2.0)),
        ("high", JsValue::Number(2.0)),
        ("low", JsValue::Number(-0.0)),
        ("close", JsValue::Number(-0.0)),
        ("volume", JsValue::Number(2.0)),
    ]);
    ChartApi::new(&mut chart, &NoZones)
        .dispatch(
            &JsString::from_str("applyDataEvent"),
            &[object(&[("kind", text("append")), ("bar", bar)])],
        )
        .unwrap();
    assert_eq!(
        chart.indicators().entry(&text("mean")).unwrap().revision(),
        before
    );
    let error = chart
        .indicator_buffer(&text("mean"), &text("value"), 0.0, 0.0, &NoZones)
        .unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_eq!(error.message.to_string_lossy(), "Native indicator slice");
    assert!(chart.indicators().entry(&text("mean")).unwrap().revision() > before);
    let values = chart
        .indicator_buffer(&text("mean"), &text("value"), 0.0, 6.0, &NoZones)
        .unwrap();
    assert_eq!(values.len(), 6);
    assert!(values[0].is_nan());
}

#[test]
fn actual_node22_scene_uses_real_layout_and_chart_owned_caches() {
    let mut chart = NativeChart::new(
        seeded_data(5, 1.0),
        &JsValue::Null,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    assert!(chart.series_caches().is_empty());
    let actual = chart
        .build_scene(&NoZones, 400.0, 300.0, None, true, true)
        .unwrap();
    assert!(!chart.series_caches().is_empty());
    let expected = decode_wire(field(&oracle_case("legacy-scene"), "result"));
    assert_eq!(lossless(&actual), lossless(&expected));
}

#[test]
fn actual_node22_ingestion_oracle_keeps_ledger_before_model_publication() {
    let mut chart = NativeChart::new(
        seeded_data(1, 1.0),
        &object(&[("series", JsValue::Array(Vec::new()))]),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let tool = JsString::from_str("select");
    let mut api = ChartApi::with_context(
        &mut chart,
        &NoZones,
        ChartApiContext {
            tool: Some(&tool),
            ..ChartApiContext::default()
        },
    );
    api.dispatch(
        &JsString::from_str("configureDataIngestion"),
        &[object(&[
            ("streamId", text("feed")),
            ("generation", JsValue::Number(1.0)),
            ("firstSequence", JsValue::Number(0.0)),
            ("maxQueuedEvents", JsValue::Number(8.0)),
            ("maxQueuedBytes", JsValue::Number(392.0)),
            ("maxBatchEvents", JsValue::Number(8.0)),
        ])],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("enqueueDataEvents"),
        &[object(&[
            ("streamId", text("feed")),
            ("generation", JsValue::Number(1.0)),
            ("firstSequence", JsValue::Number(0.0)),
            (
                "events",
                JsValue::Array(vec![object(&[
                    ("kind", text("append")),
                    (
                        "bar",
                        object(&[
                            ("time", JsValue::Number(1_700_000_060_000.0)),
                            ("open", JsValue::Number(2.0)),
                            ("high", JsValue::Number(2.0)),
                            ("low", JsValue::Number(2.0)),
                            ("close", JsValue::Number(2.0)),
                            ("volume", JsValue::Number(2.0)),
                        ]),
                    ),
                ])]),
            ),
        ])],
    )
    .unwrap();
    let actual = object(&[
        (
            "drain",
            api.dispatch(
                &JsString::from_str("drainDataEvents"),
                &[JsValue::Number(1.0)],
            )
            .unwrap(),
        ),
        (
            "stats",
            api.dispatch(&JsString::from_str("dataIngestionStats"), &[])
                .unwrap(),
        ),
        (
            "inspect",
            api.dispatch(&JsString::from_str("inspect"), &[]).unwrap(),
        ),
    ]);
    let expected = decode_wire(field(&oracle_case("ingestion-drain-publication"), "result"));
    assert_eq!(lossless(&actual), lossless(&expected));
}

#[test]
fn actual_node22_set_series_nullish_policy_matches_api_not_legacy_mutation() {
    let mut chart = NativeChart::new(
        seeded_data(4, 1.0),
        &object(&[("series", JsValue::Array(Vec::new()))]),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let tool = JsString::from_str("select");
    let mut api = ChartApi::with_context(
        &mut chart,
        &NoZones,
        ChartApiContext {
            tool: Some(&tool),
            ..ChartApiContext::default()
        },
    );
    api.dispatch(
        &JsString::from_str("addIndicator"),
        &[
            text("mean"),
            text("ema"),
            object(&[("period", JsValue::Number(2.0))]),
        ],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("addSeries"),
        &[object(&[
            ("id", text("mean")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("mean")),
            ("output", text("value")),
        ])],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("setSeries"),
        &[
            text("mean"),
            object(&[
                ("output", JsValue::Null),
                ("indicator", JsValue::Null),
                ("source", text("close")),
            ]),
        ],
    )
    .unwrap();
    let actual = api.dispatch(&JsString::from_str("inspect"), &[]).unwrap();
    let expected = decode_wire(field(&oracle_case("set-series-nullish-binding"), "result"));
    assert_eq!(lossless(&actual), lossless(&expected));
}

#[test]
fn actual_node22_data_indicator_model_publication_matches_oracle() {
    let mut chart = NativeChart::new(
        seeded_data(3, 1.0),
        &object(&[("series", JsValue::Array(Vec::new()))]),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let tool = JsString::from_str("select");
    let mut api = ChartApi::with_context(
        &mut chart,
        &NoZones,
        ChartApiContext {
            tool: Some(&tool),
            ..ChartApiContext::default()
        },
    );
    api.dispatch(
        &JsString::from_str("addIndicator"),
        &[
            text("mean"),
            text("ema"),
            object(&[("period", JsValue::Number(2.0))]),
        ],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("addSeries"),
        &[object(&[
            ("id", text("mean")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("mean")),
        ])],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("setData"),
        &[JsValue::Array(vec![object(&[
            ("time", JsValue::Number(10.0)),
            ("open", JsValue::Number(1.0)),
            ("high", JsValue::Number(1.0)),
            ("low", JsValue::Number(1.0)),
            ("close", JsValue::Number(1.0)),
            ("volume", JsValue::Number(1.0)),
        ])])],
    )
    .unwrap();
    let actual = object(&[
        (
            "inspect",
            api.dispatch(&JsString::from_str("inspect"), &[]).unwrap(),
        ),
        (
            "values",
            api.dispatch(
                &JsString::from_str("indicatorValues"),
                &[text("mean"), text("value")],
            )
            .unwrap(),
        ),
    ]);
    let expected = decode_wire(field(
        &oracle_case("data-indicator-model-publication"),
        "result",
    ));
    assert_eq!(lossless(&actual), lossless(&expected));
}

#[test]
fn actual_node22_canonical_document_bytes_and_inspect_tree_match() {
    let mut chart = NativeChart::new(
        seeded_data(4, 1.0),
        &object(&[("series", JsValue::Array(Vec::new()))]),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let tool = JsString::from_str("select");
    let mut api = ChartApi::with_context(
        &mut chart,
        &NoZones,
        ChartApiContext {
            tool: Some(&tool),
            ..ChartApiContext::default()
        },
    );
    api.dispatch(
        &JsString::from_str("addIndicator"),
        &[
            text("mean"),
            text("ema"),
            object(&[("period", JsValue::Number(2.0))]),
        ],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("addSeries"),
        &[object(&[
            ("id", text("mean")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("mean")),
            ("color", text("red")),
        ])],
    )
    .unwrap();
    api.dispatch(
        &JsString::from_str("addDrawing"),
        &[object(&[
            ("id", text("d")),
            ("type", text("horizontal")),
            ("panel", text("price")),
            (
                "points",
                JsValue::Array(vec![object(&[
                    ("time", JsValue::Number(1_700_000_000_000.0)),
                    ("price", JsValue::Number(-0.0)),
                ])]),
            ),
            (
                "style",
                object(&[("color", text("blue")), ("width", JsValue::Number(2.0))]),
            ),
        ])],
    )
    .unwrap();
    let actual = object(&[
        (
            "studies",
            api.dispatch(&JsString::from_str("saveStudies"), &[])
                .unwrap(),
        ),
        (
            "drawings",
            api.dispatch(&JsString::from_str("saveDrawings"), &[])
                .unwrap(),
        ),
        (
            "inspect",
            api.dispatch(&JsString::from_str("inspect"), &[]).unwrap(),
        ),
    ]);
    let expected = decode_wire(field(&oracle_case("canonical-documents"), "result"));
    assert_eq!(lossless(&actual), lossless(&expected));
}
