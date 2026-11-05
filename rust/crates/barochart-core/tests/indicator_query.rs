use barochart_core::{indicator_engine, indicator_query};

use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

use indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use indicator_query::{
    IndicatorPoint, IndicatorQueryMode, IndicatorQueryOptions, indicator_value_at, indicator_values,
};

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
fn params(entries: &[(&str, JsValue)]) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in entries {
        object.insert(JsString::from_str(name), value.clone());
    }
    JsValue::Object(object)
}
fn bar(index: usize, close: f64, volume: f64) -> Bar {
    Bar {
        time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
        open: close,
        high: close + 1.0,
        low: close - 1.0,
        close,
        volume,
    }
}
fn store() -> ModelDataState {
    ModelDataState::new(
        StoreOptions::default(),
        vec![
            bar(0, 1.0, 2.0),
            bar(1, 2.0, 3.0),
            bar(2, 1.0, 5.0),
            bar(3, 3.0, 7.0),
        ],
    )
    .unwrap()
}

#[test]
fn raw_source_index_keeps_negative_zero_in_low_level_results() {
    let host = NoZones;
    let data = store();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("s"),
            &text("sma"),
            &params(&[("period", JsValue::Number(1.0))]),
        )
        .unwrap();
    let point = indicator_value_at(
        &mut engine,
        data.store(),
        &host,
        &text("s"),
        None,
        -0.0,
        IndicatorQueryOptions::raw(data.store().length()),
    )
    .unwrap();
    assert_eq!(point.source_index.unwrap().to_bits(), (-0.0_f64).to_bits());
}

#[test]
fn named_values_and_raw_plot_queries_use_the_same_clean_buffers() {
    let host = NoZones;
    let data = store();
    assert_eq!(
        IndicatorQueryOptions::raw(data.store().length()).as_of_index,
        3
    );
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("p"),
            &text("aster.volume-direction@1/pressure"),
            &params(&[("shift", JsValue::Number(2.0))]),
        )
        .unwrap();
    assert_eq!(
        indicator_values(
            &mut engine,
            data.store(),
            &host,
            &text("p"),
            Some(&text("signed"))
        )
        .unwrap(),
        &[0.0, 3.0, -5.0, 7.0]
    );
    let raw = indicator_value_at(
        &mut engine,
        data.store(),
        &host,
        &text("p"),
        Some(&text("signed")),
        3.0,
        IndicatorQueryOptions {
            mode: IndicatorQueryMode::Raw,
            as_of_index: 3,
        },
    )
    .unwrap();
    assert_eq!(
        raw,
        IndicatorPoint {
            value: Some(7.0),
            source_index: Some(3.0),
            source_time: Some(1_700_000_180_000.0)
        }
    );
    let plotted = indicator_value_at(
        &mut engine,
        data.store(),
        &host,
        &text("p"),
        Some(&text("signed")),
        3.0,
        IndicatorQueryOptions {
            mode: IndicatorQueryMode::Plot,
            as_of_index: 3,
        },
    )
    .unwrap();
    assert_eq!(plotted.source_index, Some(1.0));
    assert_eq!(plotted.value, Some(3.0));
}

#[test]
fn cutoff_out_of_range_and_nonfinite_values_return_explicit_null_shape() {
    let host = NoZones;
    let data = store();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("s"),
            &text("sma"),
            &params(&[("period", JsValue::Number(20.0))]),
        )
        .unwrap();
    let missing = IndicatorPoint {
        value: None,
        source_index: None,
        source_time: None,
    };
    assert_eq!(
        indicator_value_at(
            &mut engine,
            data.store(),
            &host,
            &text("s"),
            None,
            -1.0,
            IndicatorQueryOptions {
                mode: IndicatorQueryMode::Raw,
                as_of_index: 3
            }
        )
        .unwrap(),
        missing
    );
    assert_eq!(
        indicator_value_at(
            &mut engine,
            data.store(),
            &host,
            &text("s"),
            None,
            2.0,
            IndicatorQueryOptions {
                mode: IndicatorQueryMode::Raw,
                as_of_index: 1
            }
        )
        .unwrap(),
        missing
    );
    let nonfinite = indicator_value_at(
        &mut engine,
        data.store(),
        &host,
        &text("s"),
        None,
        1.0,
        IndicatorQueryOptions {
            mode: IndicatorQueryMode::Raw,
            as_of_index: 3,
        },
    )
    .unwrap();
    assert_eq!(nonfinite.value, None);
    assert_eq!(nonfinite.source_index, Some(1.0));
    assert_eq!(nonfinite.source_time, Some(1_700_000_060_000.0));
}

#[test]
fn validation_and_missing_output_order_match_the_public_query() {
    let host = NoZones;
    let data = store();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    for index in [f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
        let error = indicator_value_at(
            &mut engine,
            data.store(),
            &host,
            &text("missing"),
            None,
            index,
            IndicatorQueryOptions {
                mode: IndicatorQueryMode::Raw,
                as_of_index: 3,
            },
        )
        .unwrap_err();
        assert_eq!(error.name, "RangeError");
        assert_eq!(
            error.message.to_string_lossy(),
            "Indicator query index/mode"
        );
    }
    let error = indicator_values(
        &mut engine,
        data.store(),
        &host,
        &text("s"),
        Some(&JsValue::Number(-0.0)),
    )
    .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Missing indicator output");
    assert!(
        IndicatorQueryOptions::validate(&text("plot"), JsValue::Number(3.0), data.store().length())
            .is_ok()
    );
    assert!(
        IndicatorQueryOptions::validate(&text("nope"), JsValue::Number(3.0), data.store().length())
            .is_err()
    );
    let missing = indicator_value_at(
        &mut engine,
        data.store(),
        &host,
        &text("missing"),
        None,
        0.0,
        IndicatorQueryOptions::raw(data.store().length()),
    )
    .unwrap_err();
    assert_eq!(missing.message.to_string_lossy(), "Missing indicator");
}

#[test]
fn missing_named_output_still_commits_the_lazy_recalculation_first() {
    let host = NoZones;
    let mut data = store();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    let bar = data.store().at(0).unwrap();
    let change = data.store_mut().update(0, bar).unwrap().change.unwrap();
    engine.apply_change(data.store(), &change);
    assert_eq!(engine.entry(&text("s")).unwrap().revision(), 1.0);
    let error = indicator_values(
        &mut engine,
        data.store(),
        &host,
        &text("s"),
        Some(&text("missing")),
    )
    .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Missing indicator output");
    assert_eq!(engine.entry(&text("s")).unwrap().revision(), 2.0);
}
