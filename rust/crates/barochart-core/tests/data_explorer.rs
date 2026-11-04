use barochart_core::data_explorer;

use barochart_core::checkpoint_codec::safe_checkpoint_stringify;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::string::JsString;

use data_explorer::{DataQueryStatus, ExplorerSymbol, data_at};

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/explorer-compaction.leaf.jsonl");

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
fn record(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (key, item) in entries {
        value.insert(JsString::from_str(key), item.clone());
    }
    JsValue::Object(value)
}
fn parse(value: &str) -> JsValue {
    parse_json(value.as_bytes(), JsonMode::Standard).unwrap()
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
fn data() -> ModelDataState {
    ModelDataState::new(
        StoreOptions::default(),
        (0..4)
            .map(|index| Bar {
                time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
                open: index as f64 + 10.0,
                high: index as f64 + 12.0,
                low: index as f64 + 9.0,
                close: index as f64 + 11.0,
                volume: index as f64 + 1.0,
            })
            .collect(),
    )
    .unwrap()
}
fn setup() -> (NoZones, ModelDataState, IndicatorEngine, ModelState) {
    let host = NoZones;
    let data = data();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("ema"),
            &text("ema"),
            &record(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("pressure"),
            &text("aster.volume-direction@1/pressure"),
            &record(&[("shift", JsValue::Number(1.0))]),
        )
        .unwrap();
    let mut model = ModelState::new(data.store(), &record(&[])).unwrap();
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
        store: data.store(),
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    model
        .add_series(
            &record(&[
                ("id", text("close")),
                ("type", text("line")),
                ("panel", text("price")),
                ("source", text("close")),
            ]),
            &context,
        )
        .unwrap();
    model
        .add_series(
            &record(&[
                ("id", text("ema-line")),
                ("type", text("line")),
                ("panel", text("price")),
                ("indicator", text("ema")),
                ("output", text("value")),
            ]),
            &context,
        )
        .unwrap();
    model
        .add_series(
            &record(&[
                ("id", text("pressure-line")),
                ("type", text("line")),
                ("panel", text("price")),
                ("indicator", text("pressure")),
                ("output", text("cumulative")),
                ("offset", JsValue::Number(1.0)),
            ]),
            &context,
        )
        .unwrap();
    model
        .add_series_with_values(
            &record(&[
                ("id", text("external")),
                ("type", text("line")),
                ("panel", text("price")),
                ("symbolId", text("OTHER")),
                ("visible", JsValue::Bool(false)),
            ]),
            vec![20.0, 21.0, 22.0, 23.0],
            &context,
        )
        .unwrap();
    (host, data, engine, model)
}

#[test]
fn calculate_query_preserves_negative_zero_and_returns_all_visible_kinds() {
    let (host, data, mut engine, model) = setup();
    let result = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(-0.0))]),
        &record(&[]),
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.index.to_bits(), (-0.0f64).to_bits());
    assert_eq!(result.as_of_index, 3.0);
    assert_eq!(result.series.len(), 3);
    assert_eq!(result.series[0].value, Some(11.0));
    assert_eq!(
        result.series[0].source_index.unwrap().to_bits(),
        (-0.0f64).to_bits()
    );
    assert_eq!(result.series[0].status, DataQueryStatus::Value);
    assert!(result.series[1].value.is_none());
    assert_eq!(result.series[2].status, DataQueryStatus::OutsideSource);
    let cutoff = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(-0.0))]),
        &record(&[("asOfIndex", JsValue::Number(-0.0))]),
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(cutoff.as_of_index.to_bits(), (-0.0f64).to_bits());
}

#[test]
fn cached_mode_is_pure_until_a_calculate_query_commits_the_whole_cache() {
    let (host, mut data, mut engine, mut model) = setup();
    let bar = data.store().at(0).unwrap();
    let change = data.store_mut().update(0, bar).unwrap().change.unwrap();
    engine.apply_change(data.store(), &change);
    model.on_store_change(data.store(), &change);
    let before = engine.entry(&text("ema")).unwrap().revision();
    let cached = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(1.0))]),
        &record(&[("indicatorMode", text("cached"))]),
        None,
    )
    .unwrap()
    .unwrap();
    let ema = cached
        .series
        .iter()
        .find(|row| row.id == JsString::from_str("ema-line"))
        .unwrap();
    assert_eq!(ema.status, DataQueryStatus::Pending);
    assert_eq!(engine.entry(&text("ema")).unwrap().revision(), before);
    data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(1.0))]),
        &record(&[]),
        None,
    )
    .unwrap();
    assert_eq!(engine.entry(&text("ema")).unwrap().revision(), before + 1.0);
}

#[test]
fn historical_cutoff_allows_canonical_builtin_but_rejects_linked_causality() {
    let (host, data, mut engine, model) = setup();
    let result = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(1.0))]),
        &record(&[("asOfIndex", JsValue::Number(1.0))]),
        None,
    )
    .unwrap()
    .unwrap();
    let ema = result
        .series
        .iter()
        .find(|row| row.id == JsString::from_str("ema-line"))
        .unwrap();
    let pressure = result
        .series
        .iter()
        .find(|row| row.id == JsString::from_str("pressure-line"))
        .unwrap();
    assert_ne!(ema.status, DataQueryStatus::UnsupportedCausality);
    assert_eq!(pressure.status, DataQueryStatus::UnsupportedCausality);
}

#[test]
fn exact_and_at_or_before_time_selection_and_first_errors_match_source() {
    let (host, data, mut engine, model) = setup();
    let exact = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[
            ("time", JsValue::Number(1_700_000_060_000.0)),
            ("match", text("exact")),
        ]),
        &record(&[]),
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(exact.index, 1.0);
    let prior = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[
            ("time", JsValue::Number(1_700_000_090_000.0)),
            ("match", text("at-or-before")),
        ]),
        &record(&[]),
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(prior.index, 1.0);
    assert!(
        data_at(
            &model,
            &mut engine,
            data.store(),
            &host,
            &record(&[
                ("time", JsValue::Number(1_700_000_090_000.0)),
                ("match", text("exact")),
            ]),
            &record(&[]),
            None
        )
        .unwrap()
        .is_none()
    );
    let error = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[
            ("index", JsValue::Number(-1.0)),
            ("time", JsValue::Number(1_700_000_000_000.0)),
        ]),
        &record(&[("includeHidden", text("yes"))]),
        None,
    )
    .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Data query index");
}

#[test]
fn node22_explorer_results_match_lossless_wire_and_lazy_revision_sequence() {
    let rows = FIXTURE.lines().map(parse).collect::<Vec<_>>();
    assert_eq!(rows.len(), 7);
    let symbol = ExplorerSymbol {
        id: JsString::from_str("PRIMARY"),
        currency: JsString::from_str("USD"),
        volume_unit: JsString::from_str("shares"),
    };
    let (host, mut data, mut engine, mut model) = setup();
    let first = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(-0.0))]),
        &record(&[]),
        Some(&symbol),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&first.to_js_value())
            .unwrap()
            .to_string_lossy(),
        string(field(&rows[1], "resultLossless"))
    );
    let second = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[
            ("time", JsValue::Number(1_700_000_090_000.0)),
            ("match", text("at-or-before")),
        ]),
        &record(&[("includeHidden", JsValue::Bool(true))]),
        Some(&symbol),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&second.to_js_value())
            .unwrap()
            .to_string_lossy(),
        string(field(&rows[2], "resultLossless"))
    );
    let current = data.store().at(0).unwrap();
    let change = data.store_mut().update(0, current).unwrap().change.unwrap();
    engine.apply_change(data.store(), &change);
    model.on_store_change(data.store(), &change);
    let cached = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(1.0))]),
        &record(&[("indicatorMode", text("cached"))]),
        Some(&symbol),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&cached.to_js_value())
            .unwrap()
            .to_string_lossy(),
        string(field(&rows[3], "cachedLossless"))
    );
    let calculated = data_at(
        &model,
        &mut engine,
        data.store(),
        &host,
        &record(&[("index", JsValue::Number(1.0))]),
        &record(&[]),
        Some(&symbol),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        safe_checkpoint_stringify(&calculated.to_js_value())
            .unwrap()
            .to_string_lossy(),
        string(field(&rows[3], "calculatedLossless"))
    );
}
