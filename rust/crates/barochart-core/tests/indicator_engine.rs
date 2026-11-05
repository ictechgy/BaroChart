use barochart_core::indicator_engine;

use barochart_core::batch_options::BatchOptions;
use barochart_core::checkpoint_codec::{safe_checkpoint_parse, safe_checkpoint_stringify};
use barochart_core::data::seeded_columns;
use barochart_core::data::{Bar, BatchEvent, DataChange, ModelDataState, StoreOptions};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::string::JsString;
use std::collections::BTreeMap;

use indicator_engine::{
    CalculationStep, IndicatorEngine, IndicatorEngineOptions, IndicatorEntryView,
};

const ENGINE_FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-indicators/engine-oracle.jsonl");

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

fn bar(index: usize, open: f64, close: f64, volume: f64) -> Bar {
    Bar {
        time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
        open,
        high: if open > close { open } else { close } + 1.0,
        low: if open < close { open } else { close } - 1.0,
        close,
        volume,
    }
}

fn flat_bar(index: usize, value: f64, volume: f64) -> Bar {
    Bar {
        time: 1_700_000_000_000.0 + index as f64 * 60_000.0,
        open: value,
        high: value,
        low: value,
        close: value,
        volume,
    }
}

fn store(bars: Vec<Bar>) -> ModelDataState {
    ModelDataState::new(StoreOptions::default(), bars).unwrap()
}

fn change<T>(committed: barochart_core::data::Committed<T>) -> DataChange {
    committed.change.expect("mutation change")
}

fn entry<'a>(engine: &'a IndicatorEngine, id: &str) -> IndicatorEntryView<'a> {
    engine.entry(&text(id)).expect("entry")
}

fn parse(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    object(value)
        .get(&JsString::from_str(name))
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn string(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string: {value:?}")
    };
    value.to_string_lossy()
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number: {value:?}")
    };
    *value
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array: {value:?}")
    };
    value
}

fn same_number(left: f64, right: f64) -> bool {
    left.is_nan() && right.is_nan() || left.to_bits() == right.to_bits()
}

fn seeded_bars(length: usize, seed: u32) -> Vec<Bar> {
    let columns = seeded_columns(length, seed).unwrap();
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

fn assert_sma_summary(
    engine: &mut IndicatorEngine,
    data: &ModelDataState,
    host: &dyn Host,
    row: &JsValue,
) {
    assert_eq!(data.store().version(), number(field(row, "storeVersion")));
    assert_eq!(
        data.store().length(),
        number(field(row, "storeLength")) as usize
    );
    let read = engine.get(data.store(), host, &text("sma")).unwrap();
    assert_eq!(read.revision(), number(field(row, "revision")));
    assert_eq!(
        read.computed_from(),
        number(field(row, "computedFrom")) as usize
    );
    assert_eq!(
        read.computed_until(),
        number(field(row, "computedUntil")) as usize
    );
    let samples = array(field(row, "sampleIndices"))
        .iter()
        .map(|value| number(value) as usize)
        .collect::<Vec<_>>();
    let encoded = object(field(row, "outputsLossless"))
        .get(&JsString::from_str("value"))
        .unwrap();
    let expected = safe_checkpoint_parse(&JsValue::String(match encoded {
        JsValue::String(value) => value.clone(),
        _ => panic!("encoded samples"),
    }))
    .unwrap();
    let expected = array(&expected).iter().map(number).collect::<Vec<_>>();
    let actual = read.output("value").unwrap();
    assert!(
        samples
            .into_iter()
            .map(|index| actual[index])
            .zip(expected)
            .all(|(left, right)| same_number(left, right))
    );
    let view = entry(engine, "sma");
    for checkpoint in array(field(row, "checkpoints")) {
        let index = number(field(checkpoint, "index")) as usize;
        assert_eq!(
            safe_checkpoint_stringify(view.checkpoint(index).unwrap())
                .unwrap()
                .to_string_lossy(),
            string(field(checkpoint, "stateLossless")),
            "sma@{index}"
        );
    }
}

#[test]
fn fresh_runtime_has_thirty_six_programs_and_pressure_add_is_eager() {
    let host = NoZones;
    let data = store(vec![bar(0, 1.0, 2.0, 5.0), bar(1, 2.0, 1.0, 7.0)]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    assert_eq!(engine.registry_len(), 36);
    assert_eq!(
        *engine.registry_names().last().unwrap(),
        "aster.volume-direction@1/pressure"
    );

    let read = engine
        .add(
            data.store(),
            &host,
            &text("p"),
            &text("aster.volume-direction@1/pressure"),
            &params(&[]),
        )
        .unwrap();
    assert_eq!(read.revision(), 1.0);
    assert_eq!(read.output("signed").unwrap(), &[0.0, -7.0]);
    assert_eq!(read.output("cumulative").unwrap(), &[0.0, -7.0]);
    assert_eq!(engine.entry_ids(), vec![JsString::from_str("p")]);
}

#[test]
fn all_thirty_six_cold_outputs_and_checkpoint_wires_match_node_oracle() {
    let host = NoZones;
    let lines = ENGINE_FIXTURE.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 42);
    let header = parse(lines[0]);
    assert_eq!(
        string(field(&header, "schema")),
        "barochart.rust-indicator-engine-oracle"
    );
    assert_eq!(string(field(field(&header, "runtime"), "node")), "v22.20.0");
    let data = store(seeded_bars(3, 77));
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();

    for line in &lines[1..37] {
        let row = parse(line);
        assert_eq!(string(field(&row, "scenario")), "cold-all");
        let name = string(field(&row, "name"));
        let id = format!("cold:{name}");
        let read = engine
            .add(data.store(), &host, &text(&id), &text(&name), &params(&[]))
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(read.revision(), number(field(&row, "revision")));
        assert_eq!(data.store().version(), number(field(&row, "storeVersion")));
        assert_eq!(
            read.computed_from(),
            number(field(&row, "computedFrom")) as usize
        );
        assert_eq!(
            read.computed_until(),
            number(field(&row, "computedUntil")) as usize
        );
        let expected_order = array(field(&row, "outputOrder"))
            .iter()
            .map(string)
            .collect::<Vec<_>>();
        assert_eq!(read.output_names(), expected_order.as_slice(), "{name}");
        let expected_offsets = object(field(&row, "plotOffsets"));
        assert_eq!(
            read.definition().plot_offsets.len(),
            expected_offsets.len(),
            "{name} plot offset presence"
        );
        for (output, expected) in expected_offsets.iter() {
            assert!(same_number(
                read.definition()
                    .effective_plot_offset(&output.to_string_lossy()),
                number(expected)
            ));
        }
        for (output, encoded) in object(field(&row, "outputsLossless")).iter() {
            let expected = safe_checkpoint_parse(&JsValue::String(match encoded {
                JsValue::String(value) => value.clone(),
                _ => panic!("encoded output"),
            }))
            .unwrap();
            let expected = array(&expected).iter().map(number).collect::<Vec<_>>();
            let actual = read
                .output(&output.to_string_lossy())
                .unwrap_or_else(|| panic!("{name}: {output:?}"));
            assert_eq!(actual.len(), expected.len());
            assert!(
                actual
                    .iter()
                    .copied()
                    .zip(expected)
                    .all(|(left, right)| same_number(left, right)),
                "{name}: {}",
                output.to_string_lossy()
            );
        }
        let view = entry(&engine, &id);
        let expected_checkpoints = array(field(&row, "checkpoints"));
        assert_eq!(view.checkpoint_keys().len(), expected_checkpoints.len());
        for checkpoint in expected_checkpoints {
            let index = number(field(checkpoint, "index")) as usize;
            assert_eq!(
                safe_checkpoint_stringify(view.checkpoint(index).unwrap())
                    .unwrap()
                    .to_string_lossy(),
                string(field(checkpoint, "stateLossless")),
                "{name}@{index}"
            );
        }
    }
}

#[test]
fn ten_thousand_incremental_appends_match_node_samples_and_checkpoint_wires() {
    let host = NoZones;
    let row = parse(ENGINE_FIXTURE.lines().nth(37).unwrap());
    assert_eq!(string(field(&row, "scenario")), "append-10000");
    let bars = seeded_bars(10_000, 91);
    let mut data = store(vec![bars[0]]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("ema"),
            &text("ema"),
            &params(&[("period", JsValue::Number(20.0))]),
        )
        .unwrap();
    for (index, bar) in bars.iter().copied().enumerate().skip(1) {
        let change = change(data.store_mut().append(bar).unwrap());
        engine.apply_change(data.store(), &change);
        engine.get(data.store(), &host, &text("ema")).unwrap();
        assert_eq!(data.store().length(), index + 1);
    }
    let read = engine.get(data.store(), &host, &text("ema")).unwrap();
    assert_eq!(read.revision(), number(field(&row, "revision")));
    assert_eq!(data.store().version(), number(field(&row, "storeVersion")));
    assert_eq!(
        read.computed_from(),
        number(field(&row, "computedFrom")) as usize
    );
    assert_eq!(
        read.computed_until(),
        number(field(&row, "computedUntil")) as usize
    );
    let samples = array(field(&row, "sampleIndices"))
        .iter()
        .map(|value| number(value) as usize)
        .collect::<Vec<_>>();
    let encoded = object(field(&row, "outputsLossless"))
        .get(&JsString::from_str("value"))
        .unwrap();
    let expected = safe_checkpoint_parse(&JsValue::String(match encoded {
        JsValue::String(value) => value.clone(),
        _ => panic!("encoded samples"),
    }))
    .unwrap();
    let expected = array(&expected).iter().map(number).collect::<Vec<_>>();
    let actual = read.output("value").unwrap();
    assert!(
        samples
            .into_iter()
            .map(|index| actual[index])
            .zip(expected)
            .all(|(left, right)| same_number(left, right))
    );

    let view = entry(&engine, "ema");
    for checkpoint in array(field(&row, "checkpoints")) {
        let index = number(field(checkpoint, "index")) as usize;
        assert_eq!(
            safe_checkpoint_stringify(view.checkpoint(index).unwrap())
                .unwrap()
                .to_string_lossy(),
            string(field(checkpoint, "stateLossless")),
            "ema@{index}"
        );
    }
}

#[test]
fn deep_update_prepend_reset_and_batch_match_node_oracle() {
    let host = NoZones;
    let mutation_rows = ENGINE_FIXTURE
        .lines()
        .skip(38)
        .map(parse)
        .collect::<Vec<_>>();
    assert_eq!(mutation_rows.len(), 4);
    let mut data = store(seeded_bars(600, 123));
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("sma"),
            &text("sma"),
            &params(&[("period", JsValue::Number(20.0))]),
        )
        .unwrap();

    let mut corrected = data.store().at(300).unwrap();
    corrected.close = (corrected.open + corrected.close) / 2.0;
    let update = change(data.store_mut().update(300, corrected).unwrap());
    engine.apply_change(data.store(), &update);
    assert_eq!(string(field(&mutation_rows[0], "phase")), "deep-update");
    assert_sma_summary(&mut engine, &data, &host, &mutation_rows[0]);

    let first = data.store().at(0).unwrap();
    let prepend = [
        Bar {
            time: first.time - 120_000.0,
            ..first
        },
        Bar {
            time: first.time - 60_000.0,
            ..first
        },
    ];
    let prepend_change = change(data.store_mut().prepend(prepend.to_vec()).unwrap());
    engine.apply_change(data.store(), &prepend_change);
    assert_eq!(string(field(&mutation_rows[1], "phase")), "prepend");
    assert_sma_summary(&mut engine, &data, &host, &mutation_rows[1]);

    let reset_change = change(data.store_mut().set_data(seeded_bars(40, 124)).unwrap());
    engine.apply_change(data.store(), &reset_change);
    assert_eq!(string(field(&mutation_rows[2], "phase")), "reset");
    assert_sma_summary(&mut engine, &data, &host, &mutation_rows[2]);

    let last = data.store().at(data.store().length() - 1).unwrap();
    let appended = Bar {
        time: last.time + 60_000.0,
        open: last.close,
        high: last.close + 1.0,
        low: last.close - 1.0,
        close: last.close + 0.25,
        volume: 321.0,
    };
    let updated = Bar {
        close: last.close + 0.5,
        ..appended
    };
    let mut correction = data.store().at(10).unwrap();
    correction.close = (correction.open + correction.close) / 2.0;
    let batch_change = change(
        data.store_mut()
            .apply_events(
                &[
                    BatchEvent::Append(appended),
                    BatchEvent::Update(updated),
                    BatchEvent::Correction(correction),
                ],
                &BatchOptions::empty(),
            )
            .unwrap(),
    );
    engine.apply_change(data.store(), &batch_change);
    assert_eq!(string(field(&mutation_rows[3], "phase")), "batch");
    assert_sma_summary(&mut engine, &data, &host, &mutation_rows[3]);
}

#[test]
fn data_change_is_lazy_then_get_commits_exact_metadata() {
    let host = NoZones;
    let mut data = store(vec![bar(0, 1.0, 2.0, 5.0), bar(1, 2.0, 3.0, 7.0)]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("s"),
            &text("sma"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();
    assert_eq!(entry(&engine, "s").revision(), 1.0);

    let update = change(data.store_mut().append(bar(2, 3.0, 4.0, 11.0)).unwrap());
    engine.apply_change(data.store(), &update);
    let dirty = entry(&engine, "s");
    assert_eq!(dirty.dirty(), 2);
    assert_eq!(dirty.revision(), 1.0);
    assert!(dirty.invalidated());

    let read = engine.get(data.store(), &host, &text("s")).unwrap();
    assert_eq!(read.revision(), 2.0);
    assert_eq!(read.computed_from(), 0);
    assert_eq!(read.computed_until(), 3);
    assert_eq!(read.output("value").unwrap().len(), 3);
    let clean = entry(&engine, "s");
    assert_eq!(clean.dirty(), 3);
    assert_eq!(clean.dirty_to(), Some(0));
    assert!(!clean.invalidated());
    assert_eq!(clean.length(), 3);
}

#[test]
fn suspended_calculation_is_superseded_and_source_changes_are_stale() {
    let host = NoZones;
    let mut data = store((0..12).map(|index| bar(index, 1.0, 2.0, 1.0)).collect());
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();

    let update = change(data.store_mut().update(0, bar(0, 1.0, 1.5, 1.0)).unwrap());
    engine.apply_change(data.store(), &update);
    let mut old = engine.calculate(text("e"), 2.0);
    assert!(matches!(
        old.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Yield { to: 2, .. }
    ));
    let mut current = engine.calculate(text("e"), 4.0);
    assert!(matches!(
        current.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Yield { to: 4, .. }
    ));
    let error = old.step(&mut engine, data.store(), &host).unwrap_err();
    assert_eq!(error.name, "StaleSourceError");
    while !matches!(
        current.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Complete { .. } | CalculationStep::Exhausted
    ) {}

    let update = change(data.store_mut().update(1, bar(1, 1.0, 1.25, 1.0)).unwrap());
    engine.apply_change(data.store(), &update);
    let mut stale = engine.calculate(text("e"), 2.0);
    assert!(matches!(
        stale.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Yield { .. }
    ));
    let source_change = change(data.store_mut().append(bar(12, 1.0, 2.0, 1.0)).unwrap());
    engine.apply_change(data.store(), &source_change);
    let error = stale.step(&mut engine, data.store(), &host).unwrap_err();
    assert_eq!(error.name, "StaleSourceError");
    assert_eq!(entry(&engine, "e").dirty(), 0);
    assert!(entry(&engine, "e").invalidated());
}

#[test]
fn retained_source_identity_accepts_store_moves_and_rejects_cloned_store_objects() {
    let host = NoZones;
    let mut data = store((0..12).map(|index| bar(index, 1.0, 2.0, 1.0)).collect());
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("e"),
            &text("ema"),
            &params(&[("period", JsValue::Number(2.0))]),
        )
        .unwrap();

    let update = change(data.store_mut().update(0, bar(0, 1.0, 1.5, 1.0)).unwrap());
    engine.apply_change(data.store(), &update);
    let mut moved_task = engine.calculate(text("e"), 2.0);
    assert!(matches!(
        moved_task.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Yield { .. }
    ));
    let mut moved = Box::new(data);
    loop {
        if matches!(
            moved_task.step(&mut engine, moved.store(), &host).unwrap(),
            CalculationStep::Complete { .. } | CalculationStep::Exhausted
        ) {
            break;
        }
    }

    let update = change(moved.store_mut().update(1, bar(1, 1.0, 1.25, 1.0)).unwrap());
    engine.apply_change(moved.store(), &update);
    let mut cloned_task = engine.calculate(text("e"), 2.0);
    assert!(matches!(
        cloned_task.step(&mut engine, moved.store(), &host).unwrap(),
        CalculationStep::Yield { .. }
    ));
    let cloned = moved.store().clone();
    let error = cloned_task.step(&mut engine, &cloned, &host).unwrap_err();
    assert_eq!(error.name, "StaleSourceError");
}

#[test]
fn checkpoint_boundaries_and_output_budget_are_deterministic() {
    let host = NoZones;
    let data = store((0..513).map(|index| bar(index, 1.0, 2.0, 1.0)).collect());
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(data.store(), &host, &text("e"), &text("ema"), &params(&[]))
        .unwrap();
    assert_eq!(entry(&engine, "e").checkpoint_keys(), vec![0, 256, 512]);

    let mut limited = IndicatorEngine::new(IndicatorEngineOptions {
        checkpoint_size: 256,
        max_output_bytes: 0,
    })
    .unwrap();
    let error = limited
        .add(data.store(), &host, &text("x"), &text("sma"), &params(&[]))
        .unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert!(limited.entry(&text("x")).is_none());
}

#[test]
fn missing_restore_boundary_fails_before_suffix_writes_and_stays_dirty() {
    let host = NoZones;
    let mut data = store(
        (0..600)
            .map(|index| bar(index, 1.0, 2.0 + (index % 2) as f64, 1.0))
            .collect(),
    );
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    let initial = entry(&engine, "s");
    let mut missing = BTreeMap::new();
    missing.insert(0, initial.checkpoint(0).unwrap().clone());
    missing.insert(512, initial.checkpoint(512).unwrap().clone());
    engine
        .install_checkpoints(&text("s"), missing, None)
        .unwrap();
    let same = data.store().at(300).unwrap();
    let update = change(data.store_mut().update(300, same).unwrap());
    engine.apply_change(data.store(), &update);
    let error = engine.get(data.store(), &host, &text("s")).unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Missing checkpoint");
    let state = entry(&engine, "s");
    assert_eq!(state.revision(), 1.0);
    assert_eq!(state.dirty(), 300);
    assert!(state.invalidated());
}

#[test]
fn output_failure_keeps_prior_slots_but_not_clean_metadata_and_retries() {
    let host = NoZones;
    let mut data = store(vec![flat_bar(0, 1.0, 1.0)]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            &host,
            &text("k"),
            &text("keltner"),
            &params(&[
                ("period", JsValue::Number(1.0)),
                ("atrPeriod", JsValue::Number(1.0)),
                ("multiplier", JsValue::Number(f64::MAX)),
            ]),
        )
        .unwrap();
    let append = change(data.store_mut().append(bar(1, 1.0, 2.0, 1.0)).unwrap());
    engine.apply_change(data.store(), &append);

    for _ in 0..2 {
        let error = engine.get(data.store(), &host, &text("k")).unwrap_err();
        assert_eq!(error.name, "TypeError");
        assert_eq!(
            error.message.to_string_lossy(),
            "Output must be finite or NaN"
        );
        let state = entry(&engine, "k");
        assert_eq!(state.revision(), 1.0);
        assert_eq!(state.dirty(), 1);
        assert_eq!(state.length(), 1);
        assert!(state.output_capacity("middle").unwrap()[1].is_finite());
        assert!(state.output_capacity("upper").unwrap()[1].is_nan());
        assert!(state.output_capacity("lower").unwrap()[1].is_nan());
    }
}

#[test]
fn canonical_builtin_converges_but_linked_pressure_replays_the_full_suffix() {
    let host = NoZones;
    let mut data = store(
        (0..800)
            .map(|index| bar(index, 1.0, 2.0 + (index % 3) as f64, 1.0))
            .collect(),
    );
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
    engine
        .add(
            data.store(),
            &host,
            &text("p"),
            &text("aster.volume-direction@1/pressure"),
            &params(&[]),
        )
        .unwrap();

    let same = data.store().at(300).unwrap();
    let update = change(data.store_mut().update(300, same).unwrap());
    engine.apply_change(data.store(), &update);
    let sma = engine.get(data.store(), &host, &text("s")).unwrap();
    assert_eq!(sma.computed_from(), 256);
    assert_eq!(sma.computed_until(), 512);
    let pressure = engine.get(data.store(), &host, &text("p")).unwrap();
    assert_eq!(pressure.computed_from(), 256);
    assert_eq!(pressure.computed_until(), 800);
}

#[test]
fn capacity_growth_budget_failure_keeps_old_arrays_and_dirty_metadata() {
    let host = NoZones;
    let mut data = store(vec![bar(0, 1.0, 2.0, 1.0)]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions {
        checkpoint_size: 256,
        max_output_bytes: 128,
    })
    .unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    for index in 1..=16 {
        let append = change(data.store_mut().append(bar(index, 1.0, 2.0, 1.0)).unwrap());
        engine.apply_change(data.store(), &append);
    }
    assert_eq!(data.store().capacity(), 32);
    let before = entry(&engine, "s");
    assert_eq!(before.output_capacity("value").unwrap().len(), 16);
    let revision = before.revision();
    let error = engine.get(data.store(), &host, &text("s")).unwrap_err();
    assert_eq!(
        error.message.to_string_lossy(),
        "Indicator output byte limit"
    );
    let after = entry(&engine, "s");
    assert_eq!(after.output_capacity("value").unwrap().len(), 16);
    assert_eq!(after.revision(), revision);
    assert!(after.dirty() < data.store().length());
}

#[test]
fn calculation_validation_is_lazy_and_remove_or_dispose_stales_suspended_tasks() {
    let host = NoZones;
    let data = store((0..8).map(|index| bar(index, 1.0, 2.0, 1.0)).collect());
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    let mut invalid = engine.calculate(text("s"), 0.0);
    let error = invalid.step(&mut engine, data.store(), &host).unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Calculation chunk size");
    assert_eq!(
        invalid.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Exhausted
    );

    let mut wrong_owner = engine.calculate(text("s"), 1.0);
    let mut other = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let error = wrong_owner
        .step(&mut other, data.store(), &host)
        .unwrap_err();
    assert_eq!(error.name, "StaleSourceError");

    let update = DataChange {
        from: 0,
        to: data.store().length(),
        kind: barochart_core::data::ChangeKind::Update,
        version: data.store().version(),
        added: None,
        added_present: false,
        appended: None,
    };
    engine.apply_change(data.store(), &update);
    let mut task = engine.calculate(text("s"), 2.0);
    assert!(matches!(
        task.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Yield { .. }
    ));
    assert!(engine.remove(&text("s")));
    assert_eq!(
        task.step(&mut engine, data.store(), &host)
            .unwrap_err()
            .name,
        "StaleSourceError"
    );

    engine
        .add(data.store(), &host, &text("x"), &text("sma"), &params(&[]))
        .unwrap();
    let update = DataChange {
        from: 0,
        to: data.store().length(),
        kind: barochart_core::data::ChangeKind::Update,
        version: data.store().version(),
        added: None,
        added_present: false,
        appended: None,
    };
    engine.apply_change(data.store(), &update);
    let mut disposed = engine.calculate(text("x"), 2.0);
    assert!(matches!(
        disposed.step(&mut engine, data.store(), &host).unwrap(),
        CalculationStep::Yield { .. }
    ));
    engine.dispose();
    assert_eq!(
        disposed
            .step(&mut engine, data.store(), &host)
            .unwrap_err()
            .name,
        "StaleSourceError"
    );
}

#[test]
fn unknown_and_missing_value_messages_use_js_tostring_without_losing_wtf16() {
    let host = NoZones;
    let data = store(Vec::new());
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let error = engine
        .add(
            data.store(),
            &host,
            &text("x"),
            &JsValue::Number(-0.0),
            &params(&[]),
        )
        .unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Unknown indicator: 0");
    let mut missing = engine.calculate(
        JsValue::Array(vec![
            JsValue::Number(1.0),
            JsValue::Null,
            JsValue::String(JsString::from_utf16(vec![0xd800])),
        ]),
        1.0,
    );
    let error = missing.step(&mut engine, data.store(), &host).unwrap_err();
    let expected = "Missing indicator: 1,,"
        .encode_utf16()
        .chain([0xd800])
        .collect::<Vec<_>>();
    assert_eq!(error.message.as_units(), expected);
}

#[test]
fn unknown_source_nan_and_pressure_negative_zero_bits_survive_engine_storage() {
    let host = NoZones;
    let data = store(vec![flat_bar(0, 1.0, 2.0), flat_bar(1, 2.0, 3.0)]);
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let unknown = engine
        .add(
            data.store(),
            &host,
            &text("unknown"),
            &text("sma"),
            &params(&[
                ("period", JsValue::Number(1.0)),
                ("source", text("not-a-column")),
            ]),
        )
        .unwrap();
    assert!(
        unknown
            .output("value")
            .unwrap()
            .iter()
            .all(|value| value.is_nan())
    );

    let pressure = engine
        .add(
            data.store(),
            &host,
            &text("negative-zero"),
            &text("aster.volume-direction@1/pressure"),
            &params(&[
                ("factor", JsValue::Number(-0.0)),
                ("shift", JsValue::Number(-0.0)),
            ]),
        )
        .unwrap();
    assert_eq!(
        pressure.output("signed").unwrap()[1].to_bits(),
        (-0.0f64).to_bits()
    );
    assert_eq!(
        pressure
            .definition()
            .effective_plot_offset("signed")
            .to_bits(),
        (-0.0f64).to_bits()
    );
}

#[test]
fn indicator_output_capacity_is_accounted_and_denial_removes_detached_entry() {
    let data = store(seeded_bars(16, 42));
    let host = NoZones;
    let limited = MemoryAccount::new(127, OomStyle::InternalErrorLowercase);
    let mut denied = IndicatorEngine::new_with_memory(
        IndicatorEngineOptions::default(),
        MemoryContext::accounted(&limited),
    )
    .unwrap();
    let error = denied
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert!(denied.is_empty());
    assert_eq!(denied.accounted_bytes(), 0);
    assert_eq!(limited.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let mut engine = IndicatorEngine::new_with_memory(
        IndicatorEngineOptions::default(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    engine
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    assert_eq!(engine.accounted_bytes(), 228);
    assert_eq!(account.snapshot().requested_live_bytes, 228);
    assert!(engine.remove(&text("s")));
    assert_eq!(engine.accounted_bytes(), 0);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn native_capture_job_group_splits_into_target_without_recharging_payload() {
    let data = store(seeded_bars(16, 42));
    let host = NoZones;
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let context = MemoryContext::accounted(&account);
    let mut source =
        IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), context.clone())
            .unwrap();
    source
        .add(data.store(), &host, &text("s"), &text("sma"), &params(&[]))
        .unwrap();
    let source_bytes = source.accounted_bytes();
    let (token, snapshots, job_memory) = source
        .capture_native_entries_with_memory(data.store(), &context)
        .unwrap();
    assert!(source.validate_native_capture(data.store(), &token));
    assert!(job_memory.requested_bytes() >= source_bytes);
    assert!(account.snapshot().requested_live_bytes > source_bytes);
    let token_bytes =
        account.snapshot().requested_live_bytes - source_bytes - job_memory.requested_bytes();
    assert!(
        token_bytes > 0,
        "capture identity metadata owns a separate quota lease"
    );

    let mut target =
        IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), context).unwrap();
    let stage = target
        .stage_native_restore_with_memory(data.store(), snapshots, job_memory)
        .unwrap();
    assert_eq!(
        account.snapshot().requested_live_bytes,
        source_bytes * 2 + token_bytes
    );
    target.publish_native_restore(data.store(), stage).unwrap();
    assert_eq!(target.accounted_bytes(), source_bytes);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        source_bytes * 2 + token_bytes
    );
    drop(token);
    assert_eq!(account.snapshot().requested_live_bytes, source_bytes * 2);
    drop((source, target));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
