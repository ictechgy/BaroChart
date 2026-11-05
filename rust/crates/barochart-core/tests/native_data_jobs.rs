use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::ingestion::IngestionOwner;
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::native_data_jobs::{
    NativeCorrectionSource, NativeCorrectionTarget, NativeJobProgress, NativePrepareSource,
    NativePrepareTarget, NativePreparedCore,
};
use barochart_core::range_index::RangeIndexBuilder;
use barochart_core::series_cache::SeriesCaches;
use barochart_core::series_cache::{NativePrebuiltSeriesCache, SeriesCacheBufferView};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

const ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-data-jobs.leaf.jsonl");

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
    for (name, item) in entries {
        value.insert(JsString::from_str(name), item.clone());
    }
    JsValue::Object(value)
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

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number: {value:?}")
    };
    *value
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

fn oracle_case(id: &str) -> JsValue {
    ORACLE
        .lines()
        .skip(1)
        .map(parse)
        .find(|row| string(field(row, "id")) == id)
        .unwrap()
}

fn fixture_with_length(
    length: usize,
) -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    let mut data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
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
    let owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let options = object(&[
        (
            "panels",
            JsValue::Array(vec![
                object(&[
                    ("id", text("price")),
                    ("weight", JsValue::Number(3.0)),
                    ("label", text("P")),
                ]),
                object(&[("id", text("lower")), ("weight", JsValue::Number(1.0))]),
            ]),
        ),
        ("visibleBars", JsValue::Number(5.0)),
    ]);
    let mut model = ModelState::new(owner.data().store(), &options).unwrap();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            owner.data().store(),
            &NoZones,
            &text("ema"),
            &text("ema"),
            &object(&[("period", JsValue::Number(3.0))]),
        )
        .unwrap();
    let entry = engine.entry(&text("ema")).unwrap();
    let projection = [IndicatorProjection {
        id: entry.id(),
        definition: entry.definition(),
    }];
    let context = ModelContext {
        store: owner.data().store(),
        indicators: &projection,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    model
        .add_series(
            &object(&[
                ("id", text("price")),
                ("type", text("candles")),
                ("panel", text("price")),
            ]),
            &context,
        )
        .unwrap();
    model
        .add_series(
            &object(&[
                ("id", text("ema-line")),
                ("type", text("line")),
                ("panel", text("price")),
                ("indicator", text("ema")),
                ("color", text("#f0b755")),
            ]),
            &context,
        )
        .unwrap();
    (owner, model, engine, SeriesCaches::new())
}

fn fixture() -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    fixture_with_length(8)
}

fn fixture_with_cache() -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    let (owner, mut model, engine, mut caches) = fixture();
    let entry = engine.entry(&text("ema")).unwrap();
    let values = entry.output_capacity("value").unwrap();
    let series = model
        .series
        .iter_mut()
        .find(|series| series.id == JsString::from_str("ema-line"))
        .unwrap();
    caches
        .query_series(
            &series.id,
            true,
            &mut series.revision,
            &mut series.dirty_from,
            &mut series.range_index_ready,
            owner.data().store(),
            &owner.data().store().data_identity(),
            values,
            entry.revision(),
            entry.computed_from().unwrap_or(0) as f64,
            entry
                .computed_until()
                .unwrap_or(owner.data().store().length()),
            0,
            owner.data().store().length(),
        )
        .unwrap();
    (owner, model, engine, caches)
}

#[test]
fn correction_source_metadata_buffers_and_checkpoints_match_node22() {
    let (owner, model, engine, caches) = fixture();
    let source_bar = owner.data().store().at(2).unwrap();
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(source_bar.time)),
                ("open", JsValue::Number(source_bar.open)),
                (
                    "high",
                    JsValue::Number(js_max(&[source_bar.high, source_bar.close + 1.0])),
                ),
                ("low", JsValue::Number(source_bar.low)),
                ("close", JsValue::Number(source_bar.close + 1.0)),
                ("volume", JsValue::Number(-0.0)),
            ]),
        ),
    ]);
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &event,
        NumberDialect::Ecma,
    )
    .unwrap();
    let expected = decode_wire(&oracle_case("correction"));
    let metadata_raw = parse_json(
        &source.metadata_json().to_string_lossy().into_bytes(),
        JsonMode::Standard,
    )
    .unwrap();
    assert_eq!(
        lossless(&metadata_raw),
        lossless(field(&expected, "metadata")),
        "metadata"
    );
    let buffers = array(field(&expected, "buffers"));
    assert_eq!(source.buffer_descriptors().len(), buffers.len());
    assert_eq!(
        source
            .buffer(&owner, &model, &engine, &caches, 0.0, 0.0, 1.0)
            .unwrap()
            .as_ptr(),
        engine
            .entry(&text("ema"))
            .unwrap()
            .output_capacity("value")
            .unwrap()
            .as_ptr(),
        "indicator source slot is borrowed, not cloned"
    );
    assert_eq!(
        source
            .buffer(&owner, &model, &engine, &caches, 1.0, 0.0, 1.0)
            .unwrap()
            .as_ptr(),
        owner.data().store().columns().time.as_ptr(),
        "store source slot is borrowed, not cloned"
    );
    for (slot, expected) in buffers.iter().enumerate() {
        let values = array(field(expected, "values"));
        let actual = source
            .buffer(
                &owner,
                &model,
                &engine,
                &caches,
                slot as f64,
                0.0,
                values.len() as f64,
            )
            .unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            values
                .iter()
                .map(|value| number(value).to_bits())
                .collect::<Vec<_>>(),
            "buffer {slot}"
        );
    }
    let checkpoints = array(field(&expected, "checkpoints"));
    assert_eq!(source.checkpoint_descriptors().len(), checkpoints.len());
    for (entry, expected) in checkpoints.iter().enumerate() {
        let keys = array(field(expected, "keys"));
        if keys.is_empty() {
            continue;
        }
        let text = source
            .checkpoint(
                &owner,
                &model,
                &engine,
                &caches,
                entry as f64,
                0.0,
                keys.len() as f64,
            )
            .unwrap();
        let actual = parse_json(&text.to_string_lossy().into_bytes(), JsonMode::Standard).unwrap();
        assert_eq!(
            lossless(&actual),
            lossless(&array(field(expected, "chunks"))[0]),
            "checkpoint {entry}"
        );
    }
}

#[test]
fn correction_source_rejects_bad_slice_and_stale_store() {
    let (mut owner, model, engine, caches) = fixture();
    let mut bar = owner.data().store().at(0).unwrap();
    bar.volume = 2.0;
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(bar.time)),
                ("open", JsValue::Number(bar.open)),
                ("high", JsValue::Number(bar.high)),
                ("low", JsValue::Number(bar.low)),
                ("close", JsValue::Number(bar.close)),
                ("volume", JsValue::Number(bar.volume)),
            ]),
        ),
    ]);
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &event,
        NumberDialect::Ecma,
    )
    .unwrap();
    assert_eq!(
        source
            .buffer(&owner, &model, &engine, &caches, 0.0, 0.0, 262_145.0)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Async buffer slice"
    );
    owner.data_mut().store_mut().update(0, bar).unwrap();
    assert_eq!(
        source
            .check(&owner, &model, &engine, &caches)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Async stale: data/configuration/revision changed"
    );
}

#[test]
fn prepare_source_seeded_and_columns_metadata_match_node22() {
    for (id, request) in [
        (
            "prepare-seeded",
            object(&[
                ("kind", text("seeded")),
                ("count", JsValue::Number(8.0)),
                ("seed", JsValue::Number(42.0)),
                ("visibleBars", JsValue::Number(5.0)),
            ]),
        ),
        (
            "prepare-columns",
            object(&[
                ("kind", text("columns")),
                ("length", JsValue::Number(4.0)),
                ("seed", JsValue::Number(7.0)),
                ("visibleBars", JsValue::Number(3.0)),
            ]),
        ),
    ] {
        let (owner, model, engine, caches) = fixture_with_length(0);
        let source = NativePrepareSource::capture(
            &owner,
            &model,
            &engine,
            &caches,
            &request,
            NumberDialect::Ecma,
        )
        .unwrap();
        let metadata_raw = parse_json(
            &source.metadata_json().to_string_lossy().into_bytes(),
            JsonMode::Standard,
        )
        .unwrap();
        let expected = decode_wire(&oracle_case(id));
        assert_eq!(
            lossless(&metadata_raw),
            lossless(field(&expected, "metadata")),
            "{id}"
        );
        source.check(&owner, &model, &engine, &caches).unwrap();
    }
}

#[test]
fn prebuilt_series_cache_adopts_tree_and_preserves_queries() {
    let (owner, mut model, engine, mut caches) = fixture();
    let values = engine
        .entry(&text("ema"))
        .unwrap()
        .output_capacity("value")
        .unwrap();
    let mut builder = RangeIndexBuilder::new(owner.data().store().capacity(), true, false).unwrap();
    for (index, value) in values
        .iter()
        .take(owner.data().store().length())
        .enumerate()
    {
        builder.leaf(index, *value, *value, 0.0).unwrap();
    }
    for position in (1..owner.data().store().capacity()).rev() {
        builder.merge(position).unwrap();
    }
    let before = builder.buffer_view();
    let pointers = (
        before.min.as_ptr(),
        before.max.as_ptr(),
        before.sum.unwrap().as_ptr(),
    );
    let tree = builder.finish(owner.data().store().length()).unwrap();
    caches
        .install_prebuilt(
            &JsString::from_str("ema-line"),
            owner.data().store(),
            NativePrebuiltSeriesCache::Flat {
                tree,
                length: owner.data().store().length(),
            },
        )
        .unwrap();
    let SeriesCacheBufferView::Flat { tree } =
        caches.buffer_view(&JsString::from_str("ema-line")).unwrap()
    else {
        panic!("flat cache")
    };
    assert_eq!(
        pointers,
        (
            tree.min.as_ptr(),
            tree.max.as_ptr(),
            tree.sum.unwrap().as_ptr()
        )
    );
    let query = caches
        .query(
            &JsString::from_str("ema-line"),
            values,
            0,
            owner.data().store().length(),
        )
        .unwrap();
    let finite = values
        .iter()
        .take(owner.data().store().length())
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    assert_eq!(query.min, js_min(&finite));
    assert_eq!(query.max, js_max(&finite));
    assert_eq!(
        caches
            .finite_count(
                &JsString::from_str("ema-line"),
                values,
                0,
                owner.data().store().length()
            )
            .unwrap(),
        finite.len()
    );
    let series = model
        .series
        .iter_mut()
        .find(|series| series.id == JsString::from_str("ema-line"))
        .unwrap();
    series.revision = Some(1.0);
    series.dirty_from = f64::INFINITY;
    series.range_index_ready = true;
    let token = caches.capture_token();
    series.dirty_from = 2.0;
    caches
        .query_series(
            &series.id,
            true,
            &mut series.revision,
            &mut series.dirty_from,
            &mut series.range_index_ready,
            owner.data().store(),
            &owner.data().store().data_identity(),
            values,
            1.0,
            2.0,
            3,
            0,
            owner.data().store().length(),
        )
        .unwrap();
    assert!(
        caches.validate_capture(&token),
        "in-place update keeps identity"
    );
    series.dirty_from = 0.0;
    caches
        .query_series(
            &series.id,
            true,
            &mut series.revision,
            &mut series.dirty_from,
            &mut series.range_index_ready,
            owner.data().store(),
            &owner.data().store().data_identity(),
            values,
            3.0,
            0.0,
            owner.data().store().length(),
            0,
            owner.data().store().length(),
        )
        .unwrap();
    assert!(
        !caches.validate_capture(&token),
        "rebuild rotates index identity"
    );
    assert_eq!(model.series.len(), 2);
}

fn prepared_state(core: &NativePreparedCore) -> JsValue {
    let store = core.owner.data().store();
    let columns = store.columns();
    let mut store_columns = JsObject::new();
    for (name, values) in [
        ("time", &columns.time),
        ("open", &columns.open),
        ("high", &columns.high),
        ("low", &columns.low),
        ("close", &columns.close),
        ("volume", &columns.volume),
    ] {
        store_columns.insert(
            JsString::from_str(name),
            JsValue::Array(
                values[..store.length()]
                    .iter()
                    .copied()
                    .map(JsValue::Number)
                    .collect(),
            ),
        );
    }
    let store_value = object(&[
        ("length", JsValue::Number(store.length() as f64)),
        ("capacity", JsValue::Number(store.capacity() as f64)),
        ("maxBars", JsValue::Number(store.max_bars() as f64)),
        (
            "timeframeMs",
            JsValue::Number(store.store_options().timeframe_ms),
        ),
        (
            "timeOrigin",
            JsValue::Number(store.store_options().time_origin),
        ),
        ("version", JsValue::Number(store.version())),
        ("timeVersion", JsValue::Number(store.time_version())),
        ("columns", JsValue::Object(store_columns)),
    ]);
    let indicators = core
        .indicators
        .entry_ids()
        .into_iter()
        .map(|id| {
            let entry = core.indicators.entry(&JsValue::String(id.clone())).unwrap();
            let definition = entry.definition();
            let mut offsets = JsObject::new();
            for offset in &definition.plot_offsets {
                offsets.insert(
                    JsString::from_str(offset.output),
                    JsValue::Number(offset.value),
                );
            }
            object(&[
                ("id", JsValue::String(id)),
                ("name", JsValue::String(entry.name().clone())),
                ("params", entry.params().clone()),
                (
                    "outputs",
                    JsValue::Array(definition.outputs.iter().map(|name| text(name)).collect()),
                ),
                ("plotOffsets", JsValue::Object(offsets)),
                ("revision", JsValue::Number(entry.revision())),
                ("dirty", JsValue::Number(entry.dirty() as f64)),
                (
                    "dirtyTo",
                    entry
                        .dirty_to()
                        .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
                ),
                ("invalidated", JsValue::Bool(entry.invalidated())),
                ("length", JsValue::Number(entry.length() as f64)),
                (
                    "computedFrom",
                    entry
                        .computed_from()
                        .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
                ),
                (
                    "computedUntil",
                    entry
                        .computed_until()
                        .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
                ),
                (
                    "checkpointKeys",
                    JsValue::Array(
                        entry
                            .checkpoint_keys()
                            .into_iter()
                            .map(|value| JsValue::Number(value as f64))
                            .collect(),
                    ),
                ),
                (
                    "arrays",
                    JsValue::Array(
                        definition
                            .outputs
                            .iter()
                            .map(|output| {
                                JsValue::Array(
                                    entry.output_capacity(output).unwrap()[..store.length()]
                                        .iter()
                                        .copied()
                                        .map(JsValue::Number)
                                        .collect(),
                                )
                            })
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    let series = core
        .model
        .series
        .iter()
        .map(|series| {
            let value = series.to_js_value();
            let mut record = match &value {
                JsValue::Object(value) => value.clone(),
                _ => unreachable!(),
            };
            record.insert(
                JsString::from_str("dirtyFrom"),
                JsValue::Number(series.dirty_from),
            );
            if let Some(revision) = series.revision {
                record.insert(JsString::from_str("revision"), JsValue::Number(revision));
            } else if matches!(core.prepared_input, JsValue::Undefined) {
                record.insert(JsString::from_str("revision"), JsValue::Undefined);
            }
            JsValue::Object(record)
        })
        .collect();
    object(&[
        ("store", store_value),
        (
            "view",
            object(&[
                ("from", JsValue::Number(core.model.view.from)),
                ("to", JsValue::Number(core.model.view.to)),
            ]),
        ),
        ("follow", JsValue::Bool(core.model.follow)),
        ("theme", core.model.theme().clone()),
        (
            "panels",
            JsValue::Array(
                core.model
                    .panels
                    .iter()
                    .map(|panel| panel.to_js_value())
                    .collect(),
            ),
        ),
        (
            "axes",
            JsValue::Array(
                core.model
                    .axes
                    .iter()
                    .map(|axis| axis.to_js_value())
                    .collect(),
            ),
        ),
        ("series", JsValue::Array(series)),
        ("indicators", JsValue::Array(indicators)),
    ])
}

fn progress_value(rows: &[NativeJobProgress]) -> JsValue {
    JsValue::Array(rows.iter().map(NativeJobProgress::to_js_value).collect())
}

#[test]
fn prepare_targets_match_node22_progress_and_ready_state() {
    for (id, request, chunk) in [
        (
            "prepare-seeded",
            object(&[
                ("kind", text("seeded")),
                ("count", JsValue::Number(8.0)),
                ("seed", JsValue::Number(42.0)),
                ("visibleBars", JsValue::Number(5.0)),
            ]),
            2.0,
        ),
        (
            "prepare-columns",
            object(&[
                ("kind", text("columns")),
                ("length", JsValue::Number(4.0)),
                ("seed", JsValue::Number(7.0)),
                ("visibleBars", JsValue::Number(3.0)),
            ]),
            1.0,
        ),
    ] {
        let (owner, model, engine, caches) = fixture_with_length(0);
        let source = NativePrepareSource::capture(
            &owner,
            &model,
            &engine,
            &caches,
            &request,
            NumberDialect::Ecma,
        )
        .unwrap();
        let mut target =
            NativePrepareTarget::new(source.metadata_json(), NumberDialect::Ecma, &NoZones)
                .unwrap();
        if id == "prepare-columns" {
            let columns = seeded_columns(4, 7).unwrap();
            for (slot, values) in [
                &columns.time,
                &columns.open,
                &columns.high,
                &columns.low,
                &columns.close,
                &columns.volume,
            ]
            .into_iter()
            .enumerate()
            {
                target
                    .target(slot as f64, 0.0, 2.0)
                    .unwrap()
                    .copy_from_slice(&values[..2]);
                target
                    .target(slot as f64, 2.0, 2.0)
                    .unwrap()
                    .copy_from_slice(&values[2..4]);
            }
        }
        target.start(1.0).unwrap();
        let mut progress = Vec::new();
        for _ in 0..1_000 {
            let row = target.step(chunk, &NoZones).unwrap();
            let done = row.complete;
            progress.push(row);
            if done {
                break;
            }
        }
        let expected = decode_wire(&oracle_case(id));
        assert_eq!(
            lossless(&progress_value(&progress)),
            lossless(field(&expected, "steps")),
            "{id} progress"
        );
        let core = target.take_prepared().unwrap();
        assert_eq!(
            lossless(&prepared_state(&core)),
            lossless(field(&expected, "ready")),
            "{id} ready"
        );
    }
}

#[test]
fn correction_target_matches_node22_progress_and_ready_state() {
    let (owner, model, engine, caches) = fixture();
    let source_bar = owner.data().store().at(2).unwrap();
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(source_bar.time)),
                ("open", JsValue::Number(source_bar.open)),
                (
                    "high",
                    JsValue::Number(js_max(&[source_bar.high, source_bar.close + 1.0])),
                ),
                ("low", JsValue::Number(source_bar.low)),
                ("close", JsValue::Number(source_bar.close + 1.0)),
                ("volume", JsValue::Number(-0.0)),
            ]),
        ),
    ]);
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &event,
        NumberDialect::Ecma,
    )
    .unwrap();
    let mut target =
        NativeCorrectionTarget::new(source.metadata_json(), NumberDialect::Ecma, &NoZones).unwrap();
    for descriptor in source.buffer_descriptors() {
        let mut offset = 0usize;
        while offset < descriptor.length {
            let count = std::cmp::min(3, descriptor.length - offset);
            let values = source
                .buffer(
                    &owner,
                    &model,
                    &engine,
                    &caches,
                    descriptor.slot as f64,
                    offset as f64,
                    count as f64,
                )
                .unwrap();
            target
                .target(descriptor.slot as f64, offset as f64, count as f64)
                .unwrap()
                .copy_from_slice(values);
            offset += count;
        }
    }
    for descriptor in source.checkpoint_descriptors() {
        let mut offset = 0usize;
        while offset < descriptor.total {
            let count = std::cmp::min(descriptor.max_rows, descriptor.total - offset);
            let text = source
                .checkpoint(
                    &owner,
                    &model,
                    &engine,
                    &caches,
                    descriptor.entry as f64,
                    offset as f64,
                    count as f64,
                )
                .unwrap();
            target.checkpoint(descriptor.entry as f64, &text).unwrap();
            offset += count;
        }
    }
    target.start(1.0).unwrap();
    let mut progress = Vec::new();
    for _ in 0..1_000 {
        let row = target.step(2.0, &NoZones).unwrap();
        let done = row.complete;
        progress.push(row);
        if done {
            break;
        }
    }
    let expected = decode_wire(&oracle_case("correction"));
    assert_eq!(
        lossless(&progress_value(&progress)),
        lossless(field(&expected, "steps")),
        "correction progress"
    );
    let core = target.take_prepared().unwrap();
    assert_eq!(
        lossless(&prepared_state(&core)),
        lossless(field(&expected, "ready")),
        "correction ready"
    );
}

#[test]
fn correction_cache_payload_matches_node22_and_is_adopted_by_target() {
    let (owner, model, engine, caches) = fixture_with_cache();
    let source_bar = owner.data().store().at(2).unwrap();
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(source_bar.time)),
                ("open", JsValue::Number(source_bar.open)),
                (
                    "high",
                    JsValue::Number(js_max(&[source_bar.high, source_bar.close + 1.0])),
                ),
                ("low", JsValue::Number(source_bar.low)),
                ("close", JsValue::Number(source_bar.close + 1.0)),
                ("volume", JsValue::Number(-0.0)),
            ]),
        ),
    ]);
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &event,
        NumberDialect::Ecma,
    )
    .unwrap();
    let expected = decode_wire(&oracle_case("correction-cache"));
    let metadata_raw = parse_json(
        &source.metadata_json().to_string_lossy().into_bytes(),
        JsonMode::Standard,
    )
    .unwrap();
    assert_eq!(
        lossless(&metadata_raw),
        lossless(field(&expected, "metadata")),
        "cache metadata"
    );
    let mut target =
        NativeCorrectionTarget::new(source.metadata_json(), NumberDialect::Ecma, &NoZones).unwrap();
    for descriptor in source.buffer_descriptors() {
        let values = source
            .buffer(
                &owner,
                &model,
                &engine,
                &caches,
                descriptor.slot as f64,
                0.0,
                descriptor.length as f64,
            )
            .unwrap();
        target
            .target(descriptor.slot as f64, 0.0, descriptor.length as f64)
            .unwrap()
            .copy_from_slice(values);
    }
    for descriptor in source.checkpoint_descriptors() {
        if descriptor.total > 0 {
            let text = source
                .checkpoint(
                    &owner,
                    &model,
                    &engine,
                    &caches,
                    descriptor.entry as f64,
                    0.0,
                    descriptor.total as f64,
                )
                .unwrap();
            target.checkpoint(descriptor.entry as f64, &text).unwrap();
        }
    }
    target.start(1.0).unwrap();
    let mut progress = Vec::new();
    loop {
        let row = target.step(2.0, &NoZones).unwrap();
        let done = row.complete;
        progress.push(row);
        if done {
            break;
        }
    }
    assert_eq!(
        lossless(&progress_value(&progress)),
        lossless(field(&expected, "steps")),
        "cache progress"
    );
    let core = target.take_prepared().unwrap();
    assert_eq!(
        lossless(&prepared_state(&core)),
        lossless(field(&expected, "ready")),
        "cache ready"
    );
    assert!(
        core.caches
            .buffer_view(&JsString::from_str("ema-line"))
            .is_some()
    );
}

#[test]
fn big_prepare_keeps_generation_validation_index_and_cache_work_bounded() {
    let (owner, model, engine, caches) = fixture_with_length(0);
    let source = NativePrepareSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &object(&[
            ("kind", text("seeded")),
            ("count", JsValue::Number(8_193.0)),
            ("seed", JsValue::Number(42.0)),
            ("visibleBars", JsValue::Number(200.0)),
        ]),
        NumberDialect::Ecma,
    )
    .unwrap();
    let mut target =
        NativePrepareTarget::new(source.metadata_json(), NumberDialect::Ecma, &NoZones).unwrap();
    target.start(1.0).unwrap();
    let mut progress = Vec::new();
    loop {
        let row = target.step(4_096.0, &NoZones).unwrap();
        let done = row.complete;
        progress.push(row);
        if done {
            break;
        }
    }
    let expected = decode_wire(&oracle_case("prepare-big-progress"));
    assert_eq!(
        lossless(&progress_value(&progress)),
        lossless(field(&expected, "steps"))
    );
    let core = target.take_prepared().unwrap();
    let id = JsString::from_str("ema-line");
    let SeriesCacheBufferView::Flat { tree } = core.caches.buffer_view(&id).unwrap() else {
        panic!("8193 remains a flat cache")
    };
    let values = core
        .indicators
        .entry(&text("ema"))
        .unwrap()
        .output_capacity("value")
        .unwrap();
    let series = core
        .model
        .series
        .iter()
        .find(|series| series.id == id)
        .unwrap();
    let actual_cache = object(&[
        ("blocked", JsValue::Bool(false)),
        ("size", JsValue::Number(tree.size as f64)),
        (
            "finite",
            JsValue::Number(core.caches.finite_count(&id, values, 0, 8_193).unwrap() as f64),
        ),
        (
            "gaps",
            JsValue::Bool(core.caches.has_gaps(&id, values, 0, 8_193).unwrap()),
        ),
        (
            "revision",
            JsValue::Number(series.revision.expect("cache revision")),
        ),
        ("dirtyFrom", JsValue::Number(series.dirty_from)),
    ]);
    assert_eq!(lossless(&actual_cache), lossless(field(&expected, "cache")));
    let index_rows = progress
        .iter()
        .filter(|row| row.phase == "indices" && row.done == 1)
        .count();
    assert!(
        index_rows >= 5,
        "derived cache work must span bounded steps"
    );
}

#[test]
fn targets_reject_incomplete_and_nonsequential_input_without_source_mutation() {
    let (owner, model, engine, caches) = fixture();
    let before = (
        owner.data().store().version().to_bits(),
        owner.data().store().columns().close[..owner.data().store().length()]
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
    );
    let mut bar = owner.data().store().at(0).unwrap();
    bar.volume = 2.0;
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(bar.time)),
                ("open", JsValue::Number(bar.open)),
                ("high", JsValue::Number(bar.high)),
                ("low", JsValue::Number(bar.low)),
                ("close", JsValue::Number(bar.close)),
                ("volume", JsValue::Number(bar.volume)),
            ]),
        ),
    ]);
    let source = NativeCorrectionSource::capture(
        &owner,
        &model,
        &engine,
        &caches,
        &event,
        NumberDialect::Ecma,
    )
    .unwrap();
    let mut correction =
        NativeCorrectionTarget::new(source.metadata_json(), NumberDialect::Ecma, &NoZones).unwrap();
    assert_eq!(
        correction.start(1.0).unwrap_err().message.to_string_lossy(),
        "Async incomplete buffer capture"
    );
    assert_eq!(
        correction
            .target(0.0, 1.0, 1.0)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Async target slice"
    );

    let (empty_owner, empty_model, empty_engine, empty_caches) = fixture_with_length(0);
    let prepare_source = NativePrepareSource::capture(
        &empty_owner,
        &empty_model,
        &empty_engine,
        &empty_caches,
        &object(&[("kind", text("columns")), ("length", JsValue::Number(2.0))]),
        NumberDialect::Ecma,
    )
    .unwrap();
    let mut prepare = NativePrepareTarget::new(
        prepare_source.metadata_json(),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    assert_eq!(
        prepare.start(1.0).unwrap_err().message.to_string_lossy(),
        "Prepare incomplete input"
    );
    assert_eq!(
        prepare
            .target(0.0, 1.0, 1.0)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Prepare target slice"
    );
    source.check(&owner, &model, &engine, &caches).unwrap();
    assert_eq!(
        before,
        (
            owner.data().store().version().to_bits(),
            owner.data().store().columns().close[..owner.data().store().length()]
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>()
        )
    );
}
