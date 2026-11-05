use barochart_core::study_setup;

use barochart_core::checkpoint_codec::safe_checkpoint_stringify;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::string::JsString;

use study_setup::{load_study_setup, save_study_setup};

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-indicators/study-setup-oracle.jsonl");
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
fn parse(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
}
fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object")
    };
    value
}
fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    object(value).get(&JsString::from_str(name)).unwrap()
}
fn string(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string")
    };
    value.to_string_lossy()
}
fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}
fn params(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (key, item) in entries {
        value.insert(JsString::from_str(key), item.clone());
    }
    JsValue::Object(value)
}
fn empty() -> JsValue {
    JsValue::Object(JsObject::new())
}
fn bars(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(index, close)| Bar {
            time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
            open: *close,
            high: *close + 1.0,
            low: *close - 1.0,
            close: *close,
            volume: index as f64 + 5.0,
        })
        .collect()
}
fn data(closes: &[f64]) -> ModelDataState {
    ModelDataState::new(StoreOptions::default(), bars(closes)).unwrap()
}
fn add_series(
    model: &mut ModelState,
    engine: &IndicatorEngine,
    store: &barochart_core::data::BarStore,
    options: JsValue,
) {
    let ids = engine.entry_ids();
    let projections = ids
        .iter()
        .map(|id| {
            let entry = engine.entry(&JsValue::String(id.clone())).unwrap();
            IndicatorProjection {
                id: entry.id(),
                definition: entry.definition(),
            }
        })
        .collect::<Vec<_>>();
    let context = ModelContext {
        store,
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    model.add_series(&options, &context).unwrap();
}
fn source_fixture(host: &dyn Host) -> (ModelDataState, IndicatorEngine, ModelState) {
    let data = data(&[10., 11., 11., 9., 12., 8., 13., 10.]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            host,
            &text("average"),
            &text("sma"),
            &params(&[
                ("unknown", JsValue::Number(-0.0)),
                ("period", JsValue::Number(3.0)),
            ]),
        )
        .unwrap();
    engine
        .add(
            data.store(),
            host,
            &text("pressure"),
            &text("aster.volume-direction@1/pressure"),
            &params(&[
                ("factor", JsValue::Number(0.5)),
                ("shift", JsValue::Number(-0.0)),
            ]),
        )
        .unwrap();
    let mut model = ModelState::new(data.store(), &empty()).unwrap();
    add_series(
        &mut model,
        &engine,
        data.store(),
        params(&[
            ("id", text("mean-line")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("average")),
            ("output", text("value")),
            ("color", text("#345678ff")),
            ("width", JsValue::Number(3.0)),
            ("visible", JsValue::Bool(false)),
            ("label", text("평균 🚀")),
        ]),
    );
    add_series(
        &mut model,
        &engine,
        data.store(),
        params(&[
            ("id", text("pressure-bars")),
            ("type", text("histogram")),
            ("panel", text("price")),
            ("indicator", text("pressure")),
            ("output", text("cumulative")),
            ("color", text("#abcdefff")),
            ("fill", text("#123456ff")),
            ("baseline", JsValue::Number(0.0)),
            ("offset", JsValue::Number(-0.0)),
        ]),
    );
    (data, engine, model)
}

fn definition(id: &str, name: &str, params_value: JsValue, module: Option<JsValue>) -> JsValue {
    let mut value = JsObject::new();
    value.insert(JsString::from_str("id"), text(id));
    value.insert(JsString::from_str("name"), text(name));
    value.insert(JsString::from_str("params"), params_value);
    if let Some(module) = module {
        value.insert(JsString::from_str("module"), module);
    }
    JsValue::Object(value)
}

fn document(indicators: Vec<JsValue>, series: Vec<JsValue>) -> JsValue {
    params(&[
        ("schema", text("aster.studies")),
        ("version", JsValue::Number(1.0)),
        ("indicators", JsValue::Array(indicators)),
        ("series", JsValue::Array(series)),
    ])
}

fn document_text(document: &JsValue) -> JsValue {
    JsValue::String(safe_checkpoint_stringify(document).unwrap())
}

fn imported_series(output: &str) -> JsValue {
    params(&[
        ("id", text("incoming-line")),
        ("type", text("line")),
        ("panel", text("price")),
        ("indicator", text("incoming")),
        ("output", text(output)),
    ])
}

#[test]
fn save_matches_node22_order_module_and_negative_zero_wire() {
    let host = NoZones;
    let (_data, engine, model) = source_fixture(&host);
    let row = parse(FIXTURE.lines().nth(1).unwrap());
    assert_eq!(
        save_study_setup(&engine, &model).unwrap().to_string_lossy(),
        string(field(&row, "text"))
    );
}

#[test]
fn additive_load_uses_target_data_and_preserves_existing_order() {
    let host = NoZones;
    let source_row = parse(FIXTURE.lines().nth(1).unwrap());
    let expected = parse(FIXTURE.lines().nth(2).unwrap());
    let data = data(&[30., 29., 33., 32., 35., 36., 31., 34.]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("existing"),
            &text("ema"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();
    let mut model = ModelState::new(data.store(), &empty()).unwrap();
    add_series(
        &mut model,
        &engine,
        data.store(),
        params(&[
            ("id", text("existing-line")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("existing")),
        ]),
    );
    let receipt = load_study_setup(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &text(&string(field(&source_row, "text"))),
        None,
    )
    .unwrap();
    assert_eq!((receipt.indicators, receipt.series), (2, 2));
    assert_eq!(
        save_study_setup(&engine, &model).unwrap().to_string_lossy(),
        string(field(&expected, "text"))
    );
    for id in ["average", "pressure"] {
        let expected_values = object(field(field(&expected, "values"), id));
        let read = engine.get(data.store(), &host, &text(id)).unwrap();
        for (name, encoded) in expected_values.iter() {
            let actual = read.output(&name.to_string_lossy()).unwrap();
            assert_eq!(
                safe_checkpoint_stringify(&JsValue::Array(
                    actual.iter().copied().map(JsValue::Number).collect()
                ))
                .unwrap()
                .to_string_lossy(),
                string(encoded)
            );
        }
    }
}

#[test]
fn load_multifaults_and_module_policy_reject_without_partial_publication() {
    let host = NoZones;
    let cases = [
        (
            "wrong-schema",
            params(&[
                ("schema", text("wrong")),
                ("version", JsValue::Number(1.0)),
                ("indicators", JsValue::Array(Vec::new())),
                ("series", JsValue::Array(Vec::new())),
            ]),
            "TypeError",
            "Study setup schema/count",
            None,
        ),
        (
            "duplicate",
            document(
                vec![
                    definition(
                        "incoming",
                        "sma",
                        params(&[("period", JsValue::Number(3.0))]),
                        None,
                    ),
                    definition(
                        "incoming",
                        "sma",
                        params(&[("period", JsValue::Number(3.0))]),
                        None,
                    ),
                ],
                Vec::new(),
            ),
            "Error",
            "Duplicate study id",
            None,
        ),
        (
            "missing-output",
            document(
                vec![definition(
                    "incoming",
                    "sma",
                    params(&[("period", JsValue::Number(3.0))]),
                    None,
                )],
                vec![imported_series("missing")],
            ),
            "Error",
            "Missing indicator output",
            None,
        ),
        (
            "builtin-module",
            document(
                vec![definition(
                    "incoming",
                    "sma",
                    params(&[]),
                    Some(params(&[
                        ("id", text("x")),
                        ("version", JsValue::Number(1.0)),
                        ("stateVersion", JsValue::Number(1.0)),
                        ("exportName", text("x")),
                        ("causal", JsValue::Bool(true)),
                    ])),
                )],
                Vec::new(),
            ),
            "TypeError",
            "Study module version/codec mismatch",
            None,
        ),
        (
            "unsupported",
            document(
                vec![definition(
                    "incoming",
                    "custom.missing@1/x",
                    params(&[]),
                    None,
                )],
                Vec::new(),
            ),
            "UnsupportedIndicatorError",
            "Unsupported indicator module: custom.missing@1/x; requires a canonical builtin or linked factory",
            Some("UNSUPPORTED_INDICATOR_MODULE"),
        ),
        (
            "linked-unavailable",
            document(
                vec![definition(
                    "incoming",
                    "custom.missing@1/x",
                    params(&[]),
                    Some(params(&[
                        ("id", text("custom.missing")),
                        ("version", JsValue::Number(1.0)),
                        ("stateVersion", JsValue::Number(1.0)),
                        ("exportName", text("x")),
                        ("causal", JsValue::Bool(true)),
                    ])),
                )],
                Vec::new(),
            ),
            "UnavailableError",
            "Indicator module requires the javaScript backend: custom.missing@1/x",
            Some("JAVASCRIPT_BACKEND_REQUIRED"),
        ),
    ];
    for (label, document, name, message, code) in cases {
        let data = data(&[10.0, 11.0]);
        let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
        let mut model = ModelState::new(data.store(), &empty()).unwrap();
        let error = load_study_setup(
            &mut engine,
            &mut model,
            data.store(),
            &host,
            &document_text(&document),
            None,
        )
        .unwrap_err();
        assert_eq!(error.name, name, "{label}");
        assert_eq!(error.message.to_string_lossy(), message, "{label}");
        assert_eq!(error.code.as_deref(), code, "{label}");
        assert_eq!(engine.len(), 0, "{label}");
        assert!(model.series.is_empty(), "{label}");
    }
}

#[test]
fn load_owner_guard_failure_discards_staged_entries_and_series() {
    let host = NoZones;
    let data = data(&[10.0, 11.0, 12.0]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut model = ModelState::new(data.store(), &empty()).unwrap();
    let document = document(
        vec![definition(
            "incoming",
            "sma",
            params(&[("period", JsValue::Number(2.0))]),
            None,
        )],
        vec![imported_series("value")],
    );
    let mut guard = || {
        Err(barochart_js::error::JsError::new(
            "Error",
            JsString::from_str("owner"),
        ))
    };
    let error = load_study_setup(
        &mut engine,
        &mut model,
        data.store(),
        &host,
        &document_text(&document),
        Some(&mut guard),
    )
    .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "owner");
    assert_eq!(engine.len(), 0);
    assert!(model.series.is_empty());
}

#[test]
fn save_rejects_nonportable_bound_style_without_mutating_state() {
    let host = NoZones;
    let data = data(&[10.0, 11.0]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    let mut model = ModelState::new(data.store(), &empty()).unwrap();
    add_series(
        &mut model,
        &engine,
        data.store(),
        params(&[
            ("id", text("bound")),
            ("type", text("line")),
            ("panel", text("price")),
            ("indicator", text("s")),
            ("color", text("hsl(0, 100%, 50%)")),
        ]),
    );
    let error = save_study_setup(&engine, &model).unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert!(error.message.to_string_lossy().contains("Portable color"));
    assert_eq!(engine.len(), 1);
    assert_eq!(model.series.len(), 1);
}
