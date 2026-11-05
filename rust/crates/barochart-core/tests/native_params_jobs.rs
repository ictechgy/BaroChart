use barochart_core::checkpoint_codec::safe_checkpoint_stringify_with;
use barochart_core::data::seeded_columns;
use barochart_core::data::{ColumnInputs, ModelDataState, NumericColumn, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::ingestion::IngestionOwner;
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::native_params_jobs::{
    NativeParamsProgress, NativeParamsSource, NativeParamsTarget,
};
use barochart_core::series_cache::SeriesCaches;
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

const ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-params-jobs.leaf.jsonl");
const FIELDS: [&str; 6] = ["time", "open", "high", "low", "close", "volume"];

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

fn metadata_text(row: &JsValue) -> JsString {
    let raw = decode_wire(field(row, "metadata"));
    JsString::from_utf16(
        String::from_utf8(stringify_json(&raw, JsonMode::Standard))
            .unwrap()
            .encode_utf16()
            .collect(),
    )
}

fn progress_value(rows: &[NativeParamsProgress]) -> JsValue {
    JsValue::Array(rows.iter().map(NativeParamsProgress::to_js_value).collect())
}

fn source_fixture() -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    let mut data = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let columns = seeded_columns(8, 42).unwrap();
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
            Some(8),
        )
        .unwrap();
    let owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let mut model =
        ModelState::new(owner.data().store(), &JsValue::Object(JsObject::new())).unwrap();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let id = JsValue::String(JsString::from_str("ema"));
    let name = JsValue::String(JsString::from_str("ema"));
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(3.0));
    engine
        .add(
            owner.data().store(),
            &NoZones,
            &id,
            &name,
            &JsValue::Object(params),
        )
        .unwrap();
    let entry = engine.entry(&id).unwrap();
    let projections = [IndicatorProjection {
        id: entry.id(),
        definition: entry.definition(),
    }];
    let context = ModelContext {
        store: owner.data().store(),
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    let mut series = JsObject::new();
    for (key, value) in [
        ("id", JsValue::String(JsString::from_str("ema-line"))),
        ("type", JsValue::String(JsString::from_str("line"))),
        ("panel", JsValue::String(JsString::from_str("price"))),
        ("indicator", id),
    ] {
        series.insert(JsString::from_str(key), value);
    }
    model
        .add_series(&JsValue::Object(series), &context)
        .unwrap();
    (owner, model, engine, SeriesCaches::new())
}

fn accounted_source_fixture(
    memory: MemoryContext,
) -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    accounted_source_fixture_with_count(memory, 8)
}

fn accounted_source_fixture_with_count(
    memory: MemoryContext,
    count: usize,
) -> (IngestionOwner, ModelState, IndicatorEngine, SeriesCaches) {
    let mut data =
        ModelDataState::new_with_memory(StoreOptions::default(), Vec::new(), memory.clone())
            .unwrap();
    let columns = seeded_columns(count, 42).unwrap();
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
            Some(count),
        )
        .unwrap();
    let owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let mut model =
        ModelState::new(owner.data().store(), &JsValue::Object(JsObject::new())).unwrap();
    let mut engine =
        IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), memory.clone())
            .unwrap();
    let id = JsValue::String(JsString::from_str("ema"));
    let name = JsValue::String(JsString::from_str("ema"));
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(3.0));
    engine
        .add(
            owner.data().store(),
            &NoZones,
            &id,
            &name,
            &JsValue::Object(params),
        )
        .unwrap();
    let entry = engine.entry(&id).unwrap();
    let projections = [IndicatorProjection {
        id: entry.id(),
        definition: entry.definition(),
    }];
    let context = ModelContext {
        store: owner.data().store(),
        indicators: &projections,
        drawings: Default::default(),
        interaction: Default::default(),
    };
    let mut series = JsObject::new();
    for (key, value) in [
        ("id", JsValue::String(JsString::from_str("ema-line"))),
        ("type", JsValue::String(JsString::from_str("line"))),
        ("panel", JsValue::String(JsString::from_str("price"))),
        ("indicator", id),
    ] {
        series.insert(JsString::from_str(key), value);
    }
    model
        .add_series(&JsValue::Object(series), &context)
        .unwrap();
    (owner, model, engine, SeriesCaches::new_with_memory(memory))
}

#[test]
fn params_capture_metadata_oom_is_accounted_and_does_not_orphan_the_source_lease() {
    let probe_account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let probe_context = MemoryContext::accounted(&probe_account);
    let (mut probe_owner, probe_model, probe_engine, probe_caches) =
        accounted_source_fixture_with_count(probe_context, 4_096);
    let probe_baseline = probe_account.snapshot().requested_live_bytes;
    let mut probe_lease = probe_owner.acquire_async_lease().unwrap();
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(5.0));
    let probe_source = NativeParamsSource::capture(
        &probe_owner,
        &probe_lease,
        &probe_model,
        &probe_engine,
        &probe_caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(params.clone()),
        7.0,
        1.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let probe_peak = probe_account.snapshot().requested_peak_bytes;
    drop(probe_source);
    assert!(probe_owner.release_async_lease(&mut probe_lease));
    drop((probe_owner, probe_model, probe_engine, probe_caches));
    assert_eq!(probe_account.snapshot().requested_live_bytes, 0);
    let capture_bytes = probe_peak.saturating_sub(probe_baseline);
    assert!(capture_bytes > 1_024);

    let limit = probe_baseline + capture_bytes / 2;
    let limited_account = MemoryAccount::new(limit, OomStyle::RangeErrorCapitalized);
    let limited_context = MemoryContext::accounted(&limited_account);
    let (mut owner, model, engine, caches) =
        accounted_source_fixture_with_count(limited_context, 4_096);
    assert!(limited_account.snapshot().requested_live_bytes <= limit);
    let mut lease = owner.acquire_async_lease().unwrap();
    let error = match NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(params),
        7.0,
        1.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    ) {
        Ok(_) => panic!("limited params capture unexpectedly succeeded"),
        Err(error) => error,
    };
    assert!(
        error
            .message
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("memory")
    );
    assert!(owner.validate_async_lease(&lease));
    assert!(owner.release_async_lease(&mut lease));
    let mut second = owner.acquire_async_lease().unwrap();
    assert!(owner.validate_async_lease(&second));
    assert!(owner.release_async_lease(&mut second));
    assert!(
        engine
            .entry(&JsValue::String(JsString::from_str("ema")))
            .is_some()
    );
}

fn params_state(model: &ModelState, engine: &IndicatorEngine) -> JsValue {
    let entry = engine
        .entry(&JsValue::String(JsString::from_str("ema")))
        .unwrap();
    let store_length = entry.length();
    let arrays = JsValue::Array(
        entry
            .definition()
            .outputs
            .iter()
            .map(|output| {
                JsValue::Array(
                    entry.output_capacity(output).unwrap()[..store_length]
                        .iter()
                        .copied()
                        .map(JsValue::Number)
                        .collect(),
                )
            })
            .collect(),
    );
    let series = JsValue::Array(
        model
            .series
            .iter()
            .map(|series| {
                let mut value = JsObject::new();
                value.insert(JsString::from_str("id"), JsValue::String(series.id.clone()));
                value.insert(
                    JsString::from_str("revision"),
                    series.revision.map_or(JsValue::Null, JsValue::Number),
                );
                value.insert(
                    JsString::from_str("dirtyFrom"),
                    JsValue::Number(series.dirty_from),
                );
                value.insert(
                    JsString::from_str("hasIndex"),
                    JsValue::Bool(series.range_index_ready),
                );
                JsValue::Object(value)
            })
            .collect(),
    );
    let mut value = JsObject::new();
    value.insert(JsString::from_str("params"), entry.params().clone());
    value.insert(
        JsString::from_str("revision"),
        JsValue::Number(entry.revision()),
    );
    value.insert(
        JsString::from_str("dirty"),
        JsValue::Number(entry.dirty() as f64),
    );
    value.insert(
        JsString::from_str("dirtyTo"),
        entry
            .dirty_to()
            .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
    );
    value.insert(
        JsString::from_str("invalidated"),
        JsValue::Bool(entry.invalidated()),
    );
    value.insert(
        JsString::from_str("length"),
        JsValue::Number(entry.length() as f64),
    );
    value.insert(
        JsString::from_str("computedFrom"),
        entry
            .computed_from()
            .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
    );
    value.insert(
        JsString::from_str("computedUntil"),
        entry
            .computed_until()
            .map_or(JsValue::Null, |value| JsValue::Number(value as f64)),
    );
    value.insert(
        JsString::from_str("checkpointKeys"),
        JsValue::Array(
            entry
                .checkpoint_keys()
                .into_iter()
                .map(|value| JsValue::Number(value as f64))
                .collect(),
        ),
    );
    value.insert(JsString::from_str("arrays"), arrays);
    value.insert(JsString::from_str("series"), series);
    JsValue::Object(value)
}

#[test]
fn params_target_matches_node22_progress_descriptor_outputs_and_checkpoints() {
    let expected = decode_wire(&oracle_case("changed"));
    let mut target = NativeParamsTarget::new(
        &metadata_text(&oracle_case("changed")),
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let columns = seeded_columns(8, 42).unwrap();
    for (slot, name) in FIELDS.iter().enumerate() {
        let values = match *name {
            "time" => &columns.time,
            "open" => &columns.open,
            "high" => &columns.high,
            "low" => &columns.low,
            "close" => &columns.close,
            "volume" => &columns.volume,
            _ => unreachable!(),
        };
        target
            .target(slot as f64, 0.0, 8.0)
            .unwrap()
            .copy_from_slice(values);
    }
    target.start().unwrap();
    let mut progress = Vec::new();
    loop {
        let row = target.step(2.0, &NoZones).unwrap();
        let complete = row.complete;
        progress.push(row);
        if complete {
            break;
        }
    }
    assert_eq!(
        lossless(&progress_value(&progress)),
        lossless(field(&expected, "steps")),
        "progress"
    );
    assert_eq!(
        lossless(&target.descriptor().unwrap()),
        lossless(field(&expected, "descriptor")),
        "descriptor"
    );
    for (slot, values) in array(field(&expected, "outputs")).iter().enumerate() {
        let values = array(values);
        let actual = target
            .output_buffer(slot as f64, 0.0, values.len() as f64)
            .unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            values
                .iter()
                .map(|value| number(value).to_bits())
                .collect::<Vec<_>>()
        );
    }
    for (ordinal, expected) in array(field(&expected, "checkpoints")).iter().enumerate() {
        let actual = target.checkpoint(ordinal as f64).unwrap();
        assert_eq!(actual.index as f64, number(field(expected, "index")));
        assert_eq!(
            actual.text.to_string_lossy(),
            string(field(expected, "text"))
        );
    }
}

#[test]
fn params_target_rejects_incomplete_and_nonsequential_input() {
    let row = oracle_case("changed");
    let mut target =
        NativeParamsTarget::new(&metadata_text(&row), NumberDialect::Ecma, &NoZones).unwrap();
    assert_eq!(
        target.start().unwrap_err().message.to_string_lossy(),
        "Native params incomplete input"
    );
    assert_eq!(
        target
            .target(0.0, 1.0, 1.0)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Native params input slice"
    );
}

#[test]
fn params_source_target_import_publish_matches_node22() {
    let expected = decode_wire(&oracle_case("changed"));
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let (mut owner, mut model, mut engine, mut caches) =
        accounted_source_fixture(MemoryContext::accounted(&account));
    let mut lease = owner.acquire_async_lease().unwrap();
    let mut requested = JsObject::new();
    requested.insert(JsString::from_str("period"), JsValue::Number(5.0));
    let mut source = NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(requested),
        7.0,
        1.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let mut admission = Vec::new();
    loop {
        let row = source
            .step(&owner, &model, &engine, &caches, 8.0, 7.0)
            .unwrap();
        let complete = matches!(field(&row, "complete"), JsValue::Bool(true));
        admission.push(row);
        if complete {
            break;
        }
    }
    assert_eq!(
        lossless(&JsValue::Array(admission)),
        lossless(field(&expected, "admission"))
    );
    let metadata = source.metadata_json().unwrap().clone();
    let raw = parse_json(&metadata.to_string_lossy().into_bytes(), JsonMode::Standard).unwrap();
    assert_eq!(lossless(&raw), lossless(field(&expected, "metadata")));
    let mut target = NativeParamsTarget::new(&metadata, NumberDialect::Ecma, &NoZones).unwrap();
    for slot in 0..6 {
        let values = source
            .buffer(
                &owner,
                &model,
                &engine,
                &caches,
                slot as f64,
                0.0,
                owner.data().store().length() as f64,
                7.0,
            )
            .unwrap();
        target
            .target(slot as f64, 0.0, values.len() as f64)
            .unwrap()
            .copy_from_slice(values);
    }
    target.start().unwrap();
    let mut worker_progress = Vec::new();
    loop {
        let row = target.step(2.0, &NoZones).unwrap();
        let complete = row.complete;
        worker_progress.push(row);
        if complete {
            break;
        }
    }
    assert_eq!(
        lossless(&progress_value(&worker_progress)),
        lossless(field(&expected, "steps"))
    );
    let descriptor = target.descriptor().unwrap();
    let descriptor_text = safe_checkpoint_stringify_with(&descriptor, NumberDialect::Ecma).unwrap();
    source
        .receive(&owner, &model, &engine, &caches, &descriptor_text, 7.0)
        .unwrap();
    let outputs = array(field(&descriptor, "outputs"));
    for slot in 0..outputs.len() {
        let values = target
            .output_buffer(slot as f64, 0.0, owner.data().store().capacity() as f64)
            .unwrap();
        source
            .result_buffer(
                &owner,
                &model,
                &engine,
                &caches,
                slot as f64,
                0.0,
                values.len() as f64,
                7.0,
            )
            .unwrap()
            .copy_from_slice(values);
    }
    let checkpoint_count = number(field(&descriptor, "checkpointCount")) as usize;
    for ordinal in 0..checkpoint_count {
        let row = target.checkpoint(ordinal as f64).unwrap();
        source
            .checkpoint(
                &owner,
                &model,
                &engine,
                &caches,
                row.index as f64,
                &row.text,
                7.0,
            )
            .unwrap();
    }
    let mut validation = Vec::new();
    loop {
        let row = source
            .validate(&owner, &model, &engine, &caches, 4.0, 7.0)
            .unwrap();
        let complete = row.complete;
        validation.push(row);
        if complete {
            break;
        }
    }
    assert_eq!(
        lossless(&progress_value(&validation)),
        lossless(field(&expected, "validation"))
    );
    assert!(owner.release_async_lease(&mut lease));
    let before_prepare = account.snapshot();
    source
        .prepare(&owner, &model, &engine, &caches, 7.0)
        .unwrap();
    let after_prepare = account.snapshot();
    assert!(
        after_prepare.requested_live_bytes >= source.receipt_accounted_bytes(),
        "prepared receipt must remain charged until publish"
    );
    assert_eq!(
        after_prepare.requested_peak_bytes,
        std::cmp::max(
            before_prepare.requested_peak_bytes,
            after_prepare.requested_live_bytes - source.receipt_accounted_bytes()
                + source.receipt_build_bytes()
        ),
        "replacement payload moves without recharge and receipt scratch has an exact peak"
    );
    let (receipt, receipt_memory) = source
        .publish_accounted(&owner, &mut model, &mut engine, &mut caches, 7.0)
        .unwrap();
    assert!(receipt_memory.requested_bytes() > 0);
    assert_eq!(lossless(&receipt), lossless(field(&expected, "published")));
    assert_eq!(
        lossless(&params_state(&model, &engine)),
        lossless(field(&expected, "state"))
    );
    let before_drop = account.snapshot();
    assert!(before_drop.requested_live_bytes > 0);
    assert!(before_drop.requested_peak_bytes >= before_drop.requested_live_bytes);
    drop((
        receipt,
        receipt_memory,
        source,
        owner,
        model,
        engine,
        caches,
        target,
    ));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn params_noop_publishes_unchanged_without_worker_payload() {
    let expected = decode_wire(&oracle_case("noop"));
    let (mut owner, mut model, mut engine, mut caches) = source_fixture();
    let mut lease = owner.acquire_async_lease().unwrap();
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(3.0));
    let mut source = NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(params),
        9.0,
        2.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let step = source
        .step(&owner, &model, &engine, &caches, 8.0, 9.0)
        .unwrap();
    assert_eq!(lossless(&step), lossless(field(&expected, "step")));
    assert!(source.metadata_json().is_none());
    assert!(owner.release_async_lease(&mut lease));
    source
        .prepare(&owner, &model, &engine, &caches, 9.0)
        .unwrap();
    let receipt = source
        .publish(&owner, &mut model, &mut engine, &mut caches, 9.0)
        .unwrap();
    assert_eq!(lossless(&receipt), lossless(field(&expected, "published")));
    assert_eq!(
        lossless(&params_state(&model, &engine)),
        lossless(field(&expected, "state"))
    );
}

#[test]
fn noop_receipt_quota_failure_is_retryable_before_publish() {
    const LIMIT: u64 = 16_384;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let (mut owner, mut model, mut engine, mut caches) = accounted_source_fixture(context);
    let token = engine.capture_entries();
    let mut lease = owner.acquire_async_lease().unwrap();
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(3.0));
    let mut source = NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(params),
        9.0,
        1.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    assert!(owner.release_async_lease(&mut lease));
    let filler = account
        .reserve(LIMIT - account.snapshot().requested_live_bytes - 1)
        .unwrap();
    let error = source
        .prepare(&owner, &model, &engine, &caches, 9.0)
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert!(engine.validate_capture(&token));
    drop(filler);

    source
        .prepare(&owner, &model, &engine, &caches, 9.0)
        .unwrap();
    let (receipt, receipt_memory) = source
        .publish_accounted(&owner, &mut model, &mut engine, &mut caches, 9.0)
        .unwrap();
    assert!(
        matches!(field(&receipt, "status"), JsValue::String(value) if value == &JsString::from_str("unchanged"))
    );
    assert!(receipt_memory.requested_bytes() > 0);
    drop((
        receipt,
        receipt_memory,
        source,
        owner,
        model,
        engine,
        caches,
    ));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn params_source_rejects_nonsequential_copy_without_publication() {
    let expected = decode_wire(&oracle_case("failures"));
    let (mut owner, model, engine, caches) = source_fixture();
    let mut lease = owner.acquire_async_lease().unwrap();
    let before = lossless(&params_state(&model, &engine));
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(5.0));
    let mut source = NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(params),
        11.0,
        3.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    while !matches!(
        field(
            &source
                .step(&owner, &model, &engine, &caches, 8.0, 11.0)
                .unwrap(),
            "complete"
        ),
        JsValue::Bool(true)
    ) {}
    let error = source
        .buffer(&owner, &model, &engine, &caches, 0.0, 1.0, 1.0, 11.0)
        .unwrap_err();
    assert_eq!(
        error.message.to_string_lossy(),
        string(field(field(&expected, "sourceOrder"), "message"))
    );
    assert_eq!(before, lossless(&params_state(&model, &engine)));
    assert!(owner.release_async_lease(&mut lease));
}

#[test]
fn configured_ingestion_buffers_are_included_in_retained_plan() {
    let expected = decode_wire(&oracle_case("configured-admission"));
    let (mut owner, model, engine, caches) = source_fixture();
    let mut policy = JsObject::new();
    for (name, value) in [
        ("streamId", JsValue::String(JsString::from_str("feed"))),
        ("generation", JsValue::Number(1.0)),
        ("firstSequence", JsValue::Number(0.0)),
        ("maxQueuedEvents", JsValue::Number(8.0)),
        ("maxQueuedBytes", JsValue::Number(392.0)),
        ("maxBatchEvents", JsValue::Number(8.0)),
    ] {
        policy.insert(JsString::from_str(name), value);
    }
    owner.configure(&JsValue::Object(policy)).unwrap();
    let mut lease = owner.acquire_async_lease().unwrap();
    let mut params = JsObject::new();
    params.insert(JsString::from_str("period"), JsValue::Number(5.0));
    let mut source = NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(params),
        12.0,
        4.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let step = source
        .step(&owner, &model, &engine, &caches, 8.0, 12.0)
        .unwrap();
    assert_eq!(
        lossless(&JsValue::Array(vec![step])),
        lossless(field(&expected, "steps"))
    );
    assert!(owner.release_async_lease(&mut lease));
}

#[test]
fn params_capture_detects_equal_value_view_object_replacement() {
    let (mut owner, mut model, engine, caches) = source_fixture();
    model
        .set_visible_range(
            owner.data().store(),
            &JsValue::Number(0.0),
            &JsValue::Number(20.0),
        )
        .unwrap();
    let mut lease = owner.acquire_async_lease().unwrap();
    let mut requested = JsObject::new();
    requested.insert(JsString::from_str("period"), JsValue::Number(5.0));
    let source = NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(requested),
        7.0,
        1.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    )
    .unwrap();
    let view = model.view;
    model
        .set_visible_range(
            owner.data().store(),
            &JsValue::Number(view.from),
            &JsValue::Number(view.to),
        )
        .unwrap();
    let error = source
        .check(&owner, &model, &engine, &caches, 7.0)
        .unwrap_err();
    assert_eq!(error.name, "StaleSourceError");
    assert!(owner.release_async_lease(&mut lease));
}

#[test]
fn params_target_memory_quota_is_atomic_and_dispose_releases_moved_groups() {
    let metadata = metadata_text(&oracle_case("changed"));
    let limited = MemoryAccount::new(1_535, OomStyle::InternalErrorLowercase);
    let error = match NativeParamsTarget::new_with_memory(
        &metadata,
        NumberDialect::Ecma,
        &NoZones,
        MemoryContext::accounted(&limited),
    ) {
        Ok(_) => panic!("target allocation unexpectedly succeeded"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(limited.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut target = NativeParamsTarget::new_with_memory(
        &metadata,
        NumberDialect::Ecma,
        &NoZones,
        MemoryContext::accounted(&account),
    )
    .unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, 1_536);
    let columns = seeded_columns(8, 42).unwrap();
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
            .target(slot as f64, 0.0, values.len() as f64)
            .unwrap()
            .copy_from_slice(values);
    }
    target.start().unwrap();
    while !target.step(2.0, &NoZones).unwrap().complete {}
    let snapshot = account.snapshot();
    assert!(snapshot.requested_live_bytes > 1_536);
    assert!(snapshot.requested_peak_bytes < 3_072);
    target.dispose();
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn params_descriptor_and_checkpoint_results_use_caller_scope() {
    let metadata = metadata_text(&oracle_case("changed"));
    let target_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut target = NativeParamsTarget::new_with_memory(
        &metadata,
        NumberDialect::Ecma,
        &NoZones,
        MemoryContext::accounted(&target_account),
    )
    .unwrap();
    let columns = seeded_columns(8, 42).unwrap();
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
            .target(slot as f64, 0.0, values.len() as f64)
            .unwrap()
            .copy_from_slice(values);
    }
    target.start().unwrap();
    while !target.step(4.0, &NoZones).unwrap().complete {}

    let denied = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
    let mut denied_scope = MemoryContext::accounted(&denied).scope();
    let error = target.descriptor_scoped(&mut denied_scope).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(denied_scope);
    assert_eq!(denied.snapshot().requested_live_bytes, 0);

    let output = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let output_memory = MemoryContext::accounted(&output);
    let mut descriptor_scope = output_memory.scope();
    let descriptor = target.descriptor_scoped(&mut descriptor_scope).unwrap();
    assert!(matches!(field(&descriptor, "schema"), JsValue::String(_)));
    assert_eq!(
        output.snapshot().requested_live_bytes,
        descriptor_scope.requested_bytes()
    );
    drop((descriptor, descriptor_scope));
    assert_eq!(output.snapshot().requested_live_bytes, 0);

    let mut checkpoint_scope = output_memory.scope();
    let checkpoint = target
        .checkpoint_scoped(0.0, &mut checkpoint_scope)
        .unwrap();
    assert!(!checkpoint.text.as_units().is_empty());
    assert_eq!(
        output.snapshot().requested_live_bytes,
        checkpoint_scope.requested_bytes()
    );
    drop((checkpoint, checkpoint_scope));
    assert_eq!(output.snapshot().requested_live_bytes, 0);
    target.dispose();
    assert_eq!(target_account.snapshot().requested_live_bytes, 0);
}

#[test]
fn params_source_capture_denial_preserves_source_account_and_cross_account_groups_fail() {
    const LIMIT: u64 = 16_384;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let (mut owner, model, engine, caches) = accounted_source_fixture(context);
    let before_fixture = account.snapshot();
    let blocker = account
        .reserve(LIMIT - before_fixture.requested_live_bytes - 1)
        .unwrap();
    let before = account.snapshot();
    let mut lease = owner.acquire_async_lease().unwrap();
    let mut requested = JsObject::new();
    requested.insert(JsString::from_str("period"), JsValue::Number(5.0));
    let error = match NativeParamsSource::capture(
        &owner,
        &lease,
        &model,
        &engine,
        &caches,
        &JsValue::String(JsString::from_str("ema")),
        &JsValue::Object(requested),
        1.0,
        1.0,
        805_306_368.0,
        NumberDialect::Ecma,
        &NoZones,
    ) {
        Ok(_) => panic!("source capture unexpectedly succeeded"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(
        account.snapshot().requested_live_bytes,
        before.requested_live_bytes
    );
    assert!(owner.release_async_lease(&mut lease));
    drop(blocker);
    drop((owner, model, engine, caches));
    assert_eq!(account.snapshot().requested_live_bytes, 0);

    let first = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let second = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut left = MemoryContext::accounted(&first).reserve_group(64).unwrap();
    let right = MemoryContext::accounted(&second).reserve_group(32).unwrap();
    assert!(left.absorb(right).is_err());
    assert_eq!(first.snapshot().requested_live_bytes, 64);
    assert_eq!(second.snapshot().requested_live_bytes, 0);
    drop(left);
    assert_eq!(first.snapshot().requested_live_bytes, 0);
}
