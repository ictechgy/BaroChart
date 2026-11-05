use barochart_core::data::{Bar, Columns, ModelDataState, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::indicator_types::IndicatorProgram;
use barochart_core::markets::{Adjustment, Symbol};
use barochart_core::model_state::{IndicatorProjection, ModelContext, ModelState};
use barochart_core::range_index::RangeIndex;
pub use barochart_core::{Host, HostError};
use barochart_core::{
    drawings, native_workspace, native_workspace_source, native_workspace_target, series_cache,
    workspace,
};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawings::{DrawingStore, DrawingStoreConfig};
use native_workspace::{NATIVE_WORKSPACE_RESTORE_BYTES, NativeWorkspaceSize};
use native_workspace_source::NativeWorkspaceSource;
use native_workspace_target::NativeWorkspaceTarget;
use series_cache::SeriesCaches;
use workspace::{
    WorkspaceContext, WorkspaceInteraction, WorkspaceSymbol, preflight_workspace,
    read_workspace_document, save_workspace, workspace_binding, workspace_snapshot,
};

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/workspace.leaf.jsonl");
const START: f64 = 1_700_000_000_000.0;

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
fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required: {value:?}")
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
fn bar(index: usize) -> Bar {
    let close = 100.0 + (index % 13) as f64;
    Bar {
        time: START + index as f64 * 60_000.0,
        open: close - 1.0,
        high: close + 2.0,
        low: close - 2.0,
        close,
        volume: (index + 1) as f64,
    }
}

struct FixtureHost;
impl Host for FixtureHost {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        match name.to_string_lossy().as_str() {
            "America/New_York" => Ok(name.clone()),
            _ => Err(HostError),
        }
    }
    fn zone_offset_seconds(&self, zone: &JsString, epoch: f64) -> Result<i32, HostError> {
        if zone.to_string_lossy() != "America/New_York" {
            return Err(HostError);
        };
        Ok(
            if (1_710_054_000_000.0..1_730_613_600_000.0).contains(&epoch) {
                -4
            } else {
                -5
            } * 3600,
        )
    }
    fn log(&self, _level: i32, _message: &str) {}
}

struct ChartFixture {
    data: ModelDataState,
    model: ModelState,
    engine: IndicatorEngine,
    drawings: DrawingStore,
    symbol: Option<Symbol>,
}
fn add_indicator(
    engine: &mut IndicatorEngine,
    store: &barochart_core::data::BarStore,
    host: &dyn Host,
    id: &str,
    name: &str,
    params: JsValue,
) {
    let _ = engine
        .add(
            store,
            host,
            &JsValue::String(JsString::from_str(id)),
            &JsValue::String(JsString::from_str(name)),
            &params,
        )
        .unwrap();
}
fn chart(kind: &str, host: &dyn Host) -> ChartFixture {
    let count = if kind.starts_with("empty-") { 0 } else { 40 };
    let data = ModelDataState::new(StoreOptions::default(), (0..count).map(bar).collect()).unwrap();
    let options = parse(
        r#"{"panels":[{"id":"price","weight":3},{"id":"osc","weight":1}],"axes":[{"id":"left","panel":"price","side":"left"}],"visibleBars":30}"#,
    );
    let mut model = ModelState::new(data.store(), &options).unwrap();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut drawings =
        DrawingStore::new(DrawingStoreConfig::default(), NumberDialect::PLATFORM).unwrap();
    model
        .add_series(
            &parse(r#"{"id":"candles","type":"candles","panel":"price"}"#),
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let mut symbol = None;
    if matches!(kind, "basic" | "pressure") {
        add_indicator(
            &mut engine,
            data.store(),
            host,
            "ema",
            "ema",
            parse(r#"{"period":5}"#),
        );
        let projections = engine
            .entry_ids()
            .into_iter()
            .map(|id| {
                let entry = engine.entry(&JsValue::String(id)).unwrap();
                IndicatorProjection {
                    id: entry.id(),
                    definition: entry.definition(),
                }
            })
            .collect::<Vec<_>>();
        let ctx = ModelContext {
            store: data.store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        model.add_series(&parse(r##"{"id":"ema-line","type":"line","panel":"price","axisId":"left","indicator":"ema","color":"#f0b755ff"}"##),&ctx).unwrap();
        for raw in [
            r#"{"id":"level","type":"horizontal","panel":"price","points":[{"time":1700000600000,"price":110}],"text":"Legacy 수평선"}"#,
            r#"{"id":"bound","type":"trendline","panel":"price","axisId":"left","points":[{"time":1700000000000,"price":100},{"time":1700001200000,"price":125}]}"#,
            r#"{"id":"position","type":"longposition","panel":"price","points":[{"time":1700000000000,"price":100},{"time":1700000000000,"price":90},{"time":1700000000000,"price":120},{"time":1700000600000,"price":100}]}"#,
            r#"{"id":"visible","type":"text","panel":"price","points":[{"time":1700000000000,"price":105}],"text":"visible","visible":false}"#,
        ] {
            drawings.add(&parse(raw)).unwrap();
        }
        symbol = Some(Symbol {
            id: JsString::from_str("ASTER"),
            exchange: JsString::from_str("TEST"),
            timezone: JsString::from_str("America/New_York"),
            currency: JsString::from_str("USD"),
            volume_unit: JsString::from_str("shares"),
            price_decimals: 2,
            tick_size: 0.01,
            adjustment: Adjustment::Raw,
        });
        model.precision = 4;
        model
            .set_visible_range(data.store(), &JsValue::Number(5.0), &JsValue::Number(35.0))
            .unwrap();
    }
    if kind == "pressure" {
        add_indicator(
            &mut engine,
            data.store(),
            host,
            "pressure",
            "aster.volume-direction@1/pressure",
            parse(r#"{"factor":0.75,"shift":-3}"#),
        );
        let projections = engine
            .entry_ids()
            .into_iter()
            .map(|id| {
                let entry = engine.entry(&JsValue::String(id)).unwrap();
                IndicatorProjection {
                    id: entry.id(),
                    definition: entry.definition(),
                }
            })
            .collect::<Vec<_>>();
        let ctx = ModelContext {
            store: data.store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        model.add_series(&parse(r#"{"id":"pressure-line","type":"line","panel":"osc","indicator":"pressure","output":"cumulative"}"#),&ctx).unwrap();
    }
    if kind == "all-builtins" {
        for program in IndicatorProgram::ALL
            .into_iter()
            .filter(|program| program.is_builtin())
        {
            add_indicator(
                &mut engine,
                data.store(),
                host,
                &format!("i{}", program as u8),
                program.name(),
                JsValue::Object(JsObject::new()),
            );
        }
    }
    ChartFixture {
        data,
        model,
        engine,
        drawings,
        symbol,
    }
}

fn plain_chart(count: usize, host: &dyn Host) -> ChartFixture {
    let data = ModelDataState::new(StoreOptions::default(), (0..count).map(bar).collect()).unwrap();
    let mut model = ModelState::new(
        data.store(),
        &parse(r#"{"panels":[{"id":"price"}],"visibleBars":30}"#),
    )
    .unwrap();
    model
        .add_series(
            &parse(r#"{"id":"candles","type":"candles","panel":"price"}"#),
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    model
        .add_series(
            &parse(r#"{"id":"close-line","type":"line","panel":"price","source":"close"}"#),
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    add_indicator(
        &mut engine,
        data.store(),
        host,
        "ema",
        "ema",
        parse(r#"{"period":5}"#),
    );
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
    model
        .add_series(
            &parse(r#"{"id":"ema-line","type":"line","panel":"price","indicator":"ema"}"#),
            &ModelContext {
                store: data.store(),
                indicators: &projections,
                drawings: Default::default(),
                interaction: Default::default(),
            },
        )
        .unwrap();
    ChartFixture {
        data,
        model,
        engine,
        drawings: DrawingStore::with_defaults(NumberDialect::PLATFORM),
        symbol: None,
    }
}
fn workspace_context<'a>(fixture: &'a ChartFixture, host: &'a dyn Host) -> WorkspaceContext<'a> {
    WorkspaceContext {
        host,
        model: &fixture.model,
        store: fixture.data.store(),
        indicators: &fixture.engine,
        drawings: &fixture.drawings,
        symbol: fixture.symbol.as_ref().map(|symbol| WorkspaceSymbol {
            symbol,
            provider: None,
            adjustment_version: None,
        }),
        symbol_formatters: fixture.symbol.is_some(),
        interaction: WorkspaceInteraction::default(),
        dialect: NumberDialect::PLATFORM,
    }
}

fn update_close_cache(fixture: &mut ChartFixture, caches: &mut SeriesCaches, dirty_from: f64) {
    let store = fixture.data.store();
    let identity = store.data_identity();
    let series = fixture
        .model
        .series
        .iter_mut()
        .find(|series| series.id == JsString::from_str("close-line"))
        .unwrap();
    series.dirty_from = dirty_from;
    caches
        .query_series(
            &series.id,
            false,
            &mut series.revision,
            &mut series.dirty_from,
            &mut series.range_index_ready,
            store,
            &identity,
            &store.columns().close[..store.length()],
            store.version(),
            dirty_from,
            store.length(),
            0,
            store.length(),
        )
        .unwrap();
}
fn source_state(fixture: &ChartFixture) -> (JsValue, f64, f64, usize, usize) {
    (
        fixture.model.snapshot(),
        fixture.data.store().version(),
        fixture.data.store().time_version(),
        fixture.engine.len(),
        fixture.drawings.items().len(),
    )
}

#[test]
fn actual_js_save_read_and_preflight_goldens_match_real_components() {
    let host = FixtureHost;
    for row in rows("save") {
        let id = text(get(&row, "id"));
        let fixture = chart(&text(get(&row, "chart")), &host);
        let before = source_state(&fixture);
        let context = workspace_context(&fixture, &host);
        let saved_text =
            save_workspace(&context, &decode_wire(get(&row, "binding")), None).unwrap();
        assert_eq!(
            saved_text.to_string_lossy(),
            text(get(&row, "expectedText")),
            "save {id}"
        );
        let parsed = read_workspace_document(&JsValue::String(saved_text.clone()), &host).unwrap();
        assert_eq!(
            json(&encode_wire(parsed.value())),
            json(get(&row, "expectedDoc")),
            "doc {id}"
        );
        let receipt = preflight_workspace(
            &context,
            &JsValue::String(saved_text),
            &decode_wire(get(&row, "binding")),
            None,
        )
        .unwrap();
        assert_eq!(
            json(&encode_wire(&receipt)),
            json(get(&row, "expectedPreflight")),
            "preflight {id}"
        );
        assert_eq!(
            json(&encode_wire(&fixture.model.snapshot())),
            json(&encode_wire(&before.0))
        );
        assert_eq!(
            (
                fixture.data.store().version(),
                fixture.data.store().time_version(),
                fixture.engine.len(),
                fixture.drawings.items().len()
            ),
            (before.1, before.2, before.3, before.4)
        );
    }
}

#[test]
fn actual_js_reader_accepts_legacy_reordered_markers_and_drawing_versions() {
    let host = FixtureHost;
    for row in rows("read") {
        let parsed = read_workspace_document(
            &JsValue::String(JsString::from_str(&text(get(&row, "text")))),
            &host,
        )
        .unwrap();
        assert_eq!(
            json(&encode_wire(parsed.value())),
            json(get(&row, "expected")),
            "{}",
            text(get(&row, "id"))
        );
    }
}

fn error_tuple(error: &barochart_js::error::JsError) -> JsValue {
    let mut value = JsObject::new();
    value.insert(
        JsString::from_str("name"),
        JsValue::String(JsString::from_str(error.name)),
    );
    value.insert(
        JsString::from_str("message"),
        JsValue::String(error.message.clone()),
    );
    if let Some(code) = &error.code {
        value.insert(
            JsString::from_str("code"),
            JsValue::String(JsString::from_str(code)),
        );
    }
    JsValue::Object(value)
}
fn read_error_input(input: &JsValue) -> JsValue {
    if let Some(text_value) = optional(input, "text") {
        return JsValue::String(JsString::from_str(&text(text_value)));
    }
    let directive = text(get(input, "directive"));
    let count = number(get(input, "count")) as usize;
    if directive == "spaces" {
        JsValue::String(JsString::from_str(&" ".repeat(count)))
    } else if directive == "wide" {
        JsValue::String(JsString::from_str(&"界".repeat(count)))
    } else {
        JsValue::String(JsString::from_str(&format!(
            "{{\"a\":{}0{}}}",
            "[".repeat(count),
            "]".repeat(count)
        )))
    }
}

#[test]
fn actual_js_read_errors_keep_exact_names_messages_codes_and_no_state() {
    let host = FixtureHost;
    for row in rows("read-error") {
        let input = read_error_input(get(&row, "input"));
        let error = read_workspace_document(&input, &host).unwrap_err();
        let expected = optional(&row, "expectedRust").unwrap_or_else(|| get(&row, "expected"));
        assert_eq!(
            json(&encode_wire(&error_tuple(&error))),
            json(&encode_wire(expected)),
            "{}",
            text(get(&row, "id"))
        );
    }
}

#[test]
fn actual_js_preflight_errors_are_exact_and_leave_live_components_unchanged() {
    let host = FixtureHost;
    for row in rows("preflight-error") {
        let fixture = chart("basic", &host);
        let before = source_state(&fixture);
        let context = workspace_context(&fixture, &host);
        let error = preflight_workspace(
            &context,
            &JsValue::String(JsString::from_str(&text(get(&row, "text")))),
            &decode_wire(get(&row, "binding")),
            None,
        )
        .unwrap_err();
        assert_eq!(
            json(&encode_wire(&error_tuple(&error))),
            json(&encode_wire(get(&row, "expected"))),
            "{}",
            text(get(&row, "id"))
        );
        assert_eq!(
            json(&encode_wire(&fixture.model.snapshot())),
            json(&encode_wire(&before.0))
        );
        assert_eq!(
            (
                fixture.data.store().version(),
                fixture.data.store().time_version(),
                fixture.engine.len(),
                fixture.drawings.items().len()
            ),
            (before.1, before.2, before.3, before.4)
        );
    }
}

#[test]
fn actual_js_workspace_snapshot_and_binding_preserve_bits_order_and_errors() {
    for row in rows("snapshot") {
        let input = decode_wire(get(&row, "input"));
        let result = match workspace_snapshot(&input, NumberDialect::PLATFORM) {
            Ok(value) => {
                let mut object = JsObject::new();
                object.insert(JsString::from_str("ok"), value);
                JsValue::Object(object)
            }
            Err(error) => {
                let mut object = JsObject::new();
                object.insert(JsString::from_str("error"), error_tuple(&error));
                JsValue::Object(object)
            }
        };
        assert_eq!(
            json(&encode_wire(&result)),
            json(get(&row, "expected")),
            "{}",
            text(get(&row, "id"))
        );
    }
    let shuffled = parse(
        r#"{"adjustment":"raw","priceUnit":"USD","revision":"r","key":"k","adjustmentVersion":"a"}"#,
    );
    assert_eq!(
        json(&encode_wire(
            &workspace_binding(&shuffled, NumberDialect::PLATFORM).unwrap()
        )),
        json(&encode_wire(&parse(
            r#"{"key":"k","revision":"r","adjustmentVersion":"a","priceUnit":"USD","adjustment":"raw"}"#
        )))
    );
}

fn source_for_row<'a>(
    row: &JsValue,
    fixture: &'a ChartFixture,
    host: &'a dyn Host,
) -> NativeWorkspaceSource {
    let size = get(row, "size");
    NativeWorkspaceSource::new(
        &workspace_context(fixture, host),
        &JsValue::String(JsString::from_str(&text(get(row, "document")))),
        &decode_wire(get(row, "binding")),
        NativeWorkspaceSize {
            width: number(get(size, "width")),
            height: number(get(size, "height")),
        },
        number(get(row, "revision")),
        number(get(row, "maxBytes")) as usize,
    )
    .unwrap()
}

#[test]
fn actual_js_workspace_source_admission_copy_and_finish_match() {
    let host = FixtureHost;
    for row in rows("source") {
        let fixture = chart(&text(get(&row, "chart")), &host);
        let context = workspace_context(&fixture, &host);
        let revision = number(get(&row, "revision"));
        let expected = decode_wire(get(&row, "expected"));
        let mut source = source_for_row(&row, &fixture, &host);
        let mut progress = Vec::new();
        loop {
            let step = source.step(&context, 8, revision).unwrap();
            progress.push(step.to_value());
            if step.complete {
                break;
            }
        }
        assert_eq!(
            json(&encode_wire(&JsValue::Array(progress))),
            json(&encode_wire(get(&expected, "progress")))
        );
        assert_eq!(
            json(&source.step(&context, 8, revision).unwrap().to_value()),
            r#"{"phase":"copy","complete":true}"#
        );
        assert_eq!(
            source.metadata_json().unwrap().to_string_lossy(),
            text(get(&expected, "metadataJSON"))
        );
        assert_eq!(
            json(&encode_wire(&source.plan().unwrap().to_value())),
            json(&encode_wire(get(&expected, "plan")))
        );

        let lengths = source.buffers().unwrap();
        let descriptors = JsValue::Array(
            lengths
                .iter()
                .enumerate()
                .map(|(slot, length)| {
                    let mut value = JsObject::new();
                    value.insert(JsString::from_str("slot"), JsValue::Number(slot as f64));
                    value.insert(
                        JsString::from_str("length"),
                        JsValue::Number(*length as f64),
                    );
                    JsValue::Object(value)
                })
                .collect(),
        );
        assert_eq!(
            json(&encode_wire(&descriptors)),
            json(&encode_wire(get(&expected, "buffers")))
        );

        let mut columns = Vec::new();
        for slot in 0..6 {
            let values = source
                .read_slice(&context, slot, 0, fixture.data.store().length(), revision)
                .unwrap()
                .to_vec();
            columns.push(JsValue::Array(
                values.into_iter().map(JsValue::Number).collect(),
            ));
        }
        assert_eq!(
            json(&encode_wire(&JsValue::Array(columns))),
            json(&encode_wire(get(&expected, "columns")))
        );
        let receipt = source.finish(&context, revision).unwrap();
        assert_eq!(
            json(&encode_wire(&receipt.to_value())),
            json(&encode_wire(get(&expected, "finish")))
        );
    }
}

#[test]
fn actual_js_workspace_source_errors_are_exact_and_abort_is_idempotent() {
    let host = FixtureHost;
    let source_row = rows("source").pop().unwrap();
    let revision = number(get(&source_row, "revision"));
    let expected = rows("source-error");
    let expected_error = |id: &str| {
        decode_wire(get(
            expected
                .iter()
                .find(|row| text(get(row, "id")) == id)
                .unwrap(),
            "expected",
        ))
    };

    let fixture = chart("basic", &host);
    let context = workspace_context(&fixture, &host);
    let mut source = source_for_row(&source_row, &fixture, &host);
    let error = source.step(&context, 0, revision).unwrap_err();
    assert_eq!(
        json(&encode_wire(&error_tuple(&error))),
        json(&encode_wire(&expected_error("step-zero")))
    );
    assert!(!source.abort());

    let mut source = source_for_row(&source_row, &fixture, &host);
    let error = source.read_slice(&context, 0, 0, 1, revision).unwrap_err();
    assert_eq!(
        json(&encode_wire(&error_tuple(&error))),
        json(&encode_wire(&expected_error("buffer-before-copy")))
    );

    let mut source = source_for_row(&source_row, &fixture, &host);
    while !source.step(&context, 64, revision).unwrap().complete {}
    let error = source.finish(&context, revision).unwrap_err();
    assert_eq!(
        json(&encode_wire(&error_tuple(&error))),
        json(&encode_wire(&expected_error("finish-incomplete")))
    );

    let mut fixture = chart("basic", &host);
    let mut source = source_for_row(&source_row, &fixture, &host);
    fixture
        .model
        .pan(fixture.data.store(), &JsValue::Number(1.0))
        .unwrap();
    let error = source
        .check(&workspace_context(&fixture, &host), revision)
        .unwrap_err();
    assert_eq!(
        json(&encode_wire(&error_tuple(&error))),
        json(&encode_wire(&expected_error("stale-view")))
    );
    assert!(source.abort());
    assert!(!source.abort());
    let error = source
        .check(&workspace_context(&fixture, &host), revision)
        .unwrap_err();
    assert_eq!(
        json(&encode_wire(&error_tuple(&error))),
        json(&encode_wire(&expected_error("closed")))
    );

    assert_eq!(NATIVE_WORKSPACE_RESTORE_BYTES, 805_306_368);
}

#[test]
fn actual_js_workspace_source_identity_replacements_and_roundtrip_match() {
    let host = FixtureHost;
    let source_row = rows("source").pop().unwrap();
    let revision = number(get(&source_row, "revision"));
    for row in rows("source-identity") {
        let mut fixture = chart("basic", &host);
        let source = source_for_row(&source_row, &fixture, &host);
        match text(get(&row, "id")).as_str() {
            "same-visible-range" => {
                let view = fixture.model.view;
                fixture
                    .model
                    .set_visible_range(
                        fixture.data.store(),
                        &JsValue::Number(view.from),
                        &JsValue::Number(view.to),
                    )
                    .unwrap();
            }
            "same-panel-record" => fixture
                .model
                .set_panel(
                    &JsValue::String(JsString::from_str("price")),
                    &JsValue::Object(JsObject::new()),
                    &ModelContext::plain(fixture.data.store()),
                )
                .unwrap(),
            "empty-theme-replacement" => fixture
                .model
                .set_theme_api(&JsValue::Object(JsObject::new()))
                .unwrap(),
            "selection-roundtrip" => {
                let selected = fixture.drawings.selected().cloned();
                fixture
                    .drawings
                    .select(Some(&JsString::from_str("level")))
                    .unwrap();
                fixture.drawings.select(selected.as_ref()).unwrap();
            }
            id => panic!("unknown source identity case {id}"),
        }
        let context = workspace_context(&fixture, &host);
        let actual = match source.check(&context, revision) {
            Ok(value) => {
                let mut result = JsObject::new();
                result.insert(JsString::from_str("ok"), JsValue::Bool(value));
                JsValue::Object(result)
            }
            Err(error) => {
                let mut result = JsObject::new();
                result.insert(JsString::from_str("error"), error_tuple(&error));
                JsValue::Object(result)
            }
        };
        assert_eq!(
            json(&encode_wire(&actual)),
            json(get(&row, "expected")),
            "{}",
            text(get(&row, "id"))
        );
    }
}

#[test]
fn workspace_source_cache_token_allows_in_place_tree_updates_and_rejects_rebuilds() {
    let host = FixtureHost;
    let mut fixture = plain_chart(40, &host);
    let mut caches = SeriesCaches::new();
    update_close_cache(&mut fixture, &mut caches, 0.0);
    let binding = parse(
        r#"{"key":"cache","revision":"r1","adjustmentVersion":"raw-v1","priceUnit":"USD","adjustment":"raw"}"#,
    );
    let context = workspace_context(&fixture, &host);
    let document = save_workspace(&context, &binding, None).unwrap();
    let revision = 23.0;
    let mut source = NativeWorkspaceSource::new_with_runtime_state(
        &context,
        Some(&caches),
        &JsValue::String(document.clone()),
        &binding,
        NativeWorkspaceSize {
            width: 640.0,
            height: 360.0,
        },
        revision,
        NATIVE_WORKSPACE_RESTORE_BYTES,
        None,
    )
    .unwrap();

    update_close_cache(&mut fixture, &mut caches, 39.0);
    assert!(
        source
            .check_with_series_caches(&workspace_context(&fixture, &host), &caches, revision)
            .unwrap()
    );
    update_close_cache(&mut fixture, &mut caches, 0.0);
    let error = source
        .check_with_series_caches(&workspace_context(&fixture, &host), &caches, revision)
        .unwrap_err();
    assert_eq!(error.name, "StaleSourceError");
    assert!(source.abort());

    let context = workspace_context(&fixture, &host);
    let mut source = NativeWorkspaceSource::new_with_runtime_state(
        &context,
        Some(&caches),
        &JsValue::String(document),
        &binding,
        NativeWorkspaceSize {
            width: 640.0,
            height: 360.0,
        },
        revision,
        NATIVE_WORKSPACE_RESTORE_BYTES,
        None,
    )
    .unwrap();
    while !source
        .step_with_series_caches(&context, &caches, 64, revision)
        .unwrap()
        .complete
    {}
    for slot in 0..6 {
        let _ = source
            .read_slice_with_series_caches(
                &context,
                &caches,
                slot,
                0,
                fixture.data.store().length(),
                revision,
            )
            .unwrap();
    }
    let receipt = source
        .finish_with_series_caches(&context, &caches, revision)
        .unwrap();
    let cache_bytes = caches
        .info(&JsString::from_str("close-line"))
        .unwrap()
        .bytes;
    assert_eq!(
        receipt.source_bytes,
        fixture.data.store().bytes() + fixture.data.store().capacity() * 8 + cache_bytes
    );
}

fn admitted_source<'a>(
    fixture: &'a ChartFixture,
    host: &'a dyn Host,
) -> (NativeWorkspaceSource, WorkspaceContext<'a>, f64) {
    let row = rows("source").pop().unwrap();
    let revision = number(get(&row, "revision"));
    let context = workspace_context(fixture, host);
    let mut source = source_for_row(&row, fixture, host);
    while !source.step(&context, 64, revision).unwrap().complete {}
    (source, context, revision)
}

#[test]
fn actual_js_workspace_target_copy_compute_finish_and_resave_match() {
    let host = FixtureHost;
    let fixture = chart("basic", &host);
    let binding = decode_wire(get(&rows("source").pop().unwrap(), "binding"));
    let (mut source, context, revision) = admitted_source(&fixture, &host);
    let mut target = NativeWorkspaceTarget::new(
        source.metadata_json().unwrap(),
        &host,
        NumberDialect::PLATFORM,
        1.0,
    )
    .unwrap();
    for slot in 0..6 {
        let values = source
            .read_slice(&context, slot, 0, fixture.data.store().length(), revision)
            .unwrap();
        target.write_slice(slot, 0, values).unwrap();
    }
    target.start().unwrap();
    let mut progress = Vec::new();
    loop {
        let step = target.step(&host, 64).unwrap();
        progress.push(step.to_value());
        if step.complete {
            break;
        }
    }
    let expected = decode_wire(get(&rows("target").pop().unwrap(), "expected"));
    assert_eq!(
        json(&encode_wire(&JsValue::Array(progress))),
        json(&encode_wire(get(&expected, "progress")))
    );
    let restored = target.finish().unwrap();
    assert_eq!(
        json(&encode_wire(&restored.plan.to_value())),
        json(&encode_wire(get(&expected, "plan")))
    );
    assert_eq!(
        (restored.size.width, restored.size.height),
        (
            number(get(get(&expected, "size"), "width")),
            number(get(get(&expected, "size"), "height"))
        )
    );
    let saved = save_workspace(
        &restored.workspace_context(&host, NumberDialect::PLATFORM),
        &binding,
        None,
    )
    .unwrap();
    assert_eq!(saved.to_string_lossy(), text(get(&expected, "saved")));
    let expected_store = get(&expected, "store");
    assert_eq!(
        (
            restored.data.store().length() as f64,
            restored.data.store().version(),
            restored.data.store().time_version(),
            restored.data.store().capacity() as f64
        ),
        (
            number(get(expected_store, "length")),
            number(get(expected_store, "version")),
            number(get(expected_store, "timeVersion")),
            number(get(expected_store, "capacity"))
        )
    );
    let counts = get(&expected, "counts");
    assert_eq!(
        restored.model.panels.len() as f64,
        number(get(counts, "panels"))
    );
    assert_eq!(
        restored.model.axes.len() as f64,
        number(get(counts, "axes"))
    );
    assert_eq!(
        restored.model.series.len() as f64,
        number(get(counts, "series"))
    );
    assert_eq!(
        restored.indicators.len() as f64,
        number(get(counts, "indicators"))
    );
    assert_eq!(
        restored.drawings.items().len() as f64,
        number(get(counts, "drawings"))
    );
    assert!(restored.drawings.undo_stack().is_empty());
    assert!(restored.drawings.redo_stack().is_empty());
    assert!(restored.drawings.selected().is_none());
    assert!(restored.drawings.transaction().is_none());
    assert_eq!(restored.drawings.serial(), 0);
    assert!(!restored.series_caches.is_empty());
    assert!(restored.ingestion_document.is_none());
    assert!(target.check().is_err());
}

#[test]
fn workspace_target_big_input_bounds_real_row_and_tree_work_per_step() {
    let host = FixtureHost;
    let fixture = plain_chart(8_193, &host);
    let context = workspace_context(&fixture, &host);
    let binding = parse(
        r#"{"key":"big","revision":"r1","adjustmentVersion":"raw-v1","priceUnit":"USD","adjustment":"raw"}"#,
    );
    let document = save_workspace(&context, &binding, None).unwrap();
    let revision = 19.0;
    let mut source = NativeWorkspaceSource::new(
        &context,
        &JsValue::String(document),
        &binding,
        NativeWorkspaceSize {
            width: 640.0,
            height: 360.0,
        },
        revision,
        NATIVE_WORKSPACE_RESTORE_BYTES,
    )
    .unwrap();
    while !source.step(&context, 64, revision).unwrap().complete {}
    let mut target = NativeWorkspaceTarget::new(
        source.metadata_json().unwrap(),
        &host,
        NumberDialect::PLATFORM,
        1.0,
    )
    .unwrap();
    for slot in 0..6 {
        let values = source
            .read_slice(&context, slot, 0, fixture.data.store().length(), revision)
            .unwrap();
        target.write_slice(slot, 0, values).unwrap();
    }
    target.start().unwrap();

    let quantum = 4_096usize;
    let expected = decode_wire(get(&rows("target-big").pop().unwrap(), "expected"));
    let mut progress = Vec::new();
    let mut validate_done = Vec::new();
    let mut index_done = Vec::new();
    let mut calculation_work = Vec::new();
    let mut derived_work = Vec::new();
    loop {
        let step = target.step(&host, quantum).unwrap();
        progress.push(step.to_value());
        match step.phase {
            "validate" => validate_done.push(step.done),
            "store-index" => index_done.push(step.done),
            "calculate" => calculation_work.push(target.last_step_work()),
            "indices" => derived_work.push(target.last_step_work()),
            _ => {}
        }
        if step.complete {
            break;
        }
    }
    assert_eq!(validate_done, vec![4_096, 8_192, 8_193]);
    assert_eq!(index_done, vec![4_096, 8_192, 12_288, 16_383]);
    assert_eq!(
        json(&encode_wire(&JsValue::Array(progress))),
        json(&encode_wire(get(&expected, "progress")))
    );
    for completed in [&validate_done, &index_done] {
        let mut previous = 0usize;
        for current in completed {
            assert!(*current > previous);
            assert!(*current - previous <= quantum);
            previous = *current;
        }
    }
    assert!(calculation_work.iter().all(|work| *work <= quantum));
    assert_eq!(calculation_work.iter().sum::<usize>(), 8_193);
    assert!(derived_work.iter().all(|work| *work <= quantum));
    assert_eq!(derived_work.iter().sum::<usize>(), 2 * (8_193 + 16_383));
    let restored = target.finish().unwrap();
    let query = restored
        .data
        .store()
        .index()
        .query(0, restored.data.store().length())
        .unwrap();
    assert_eq!(query.sum, (8_193.0 * 8_194.0) / 2.0);
    assert_eq!(restored.data.store().capacity(), 16_384);
    let close = &restored.data.store().columns().close[..8_193];
    assert_eq!(
        restored
            .series_caches
            .finite_count(&JsString::from_str("close-line"), close, 0, 8_193)
            .unwrap(),
        8_193
    );
    let ema = restored
        .indicators
        .entry(&JsValue::String(JsString::from_str("ema")))
        .unwrap()
        .output_capacity("value")
        .unwrap();
    assert_eq!(
        restored
            .series_caches
            .finite_count(&JsString::from_str("ema-line"), ema, 0, 8_193)
            .unwrap(),
        8_189
    );
}

#[test]
fn workspace_target_block_threshold_builds_real_summary_tree_in_bounded_steps() {
    let host = FixtureHost;
    let fixture = plain_chart(65_536, &host);
    let context = workspace_context(&fixture, &host);
    let binding = parse(
        r#"{"key":"block","revision":"r1","adjustmentVersion":"raw-v1","priceUnit":"USD","adjustment":"raw"}"#,
    );
    let document = save_workspace(&context, &binding, None).unwrap();
    let revision = 29.0;
    let mut source = NativeWorkspaceSource::new(
        &context,
        &JsValue::String(document),
        &binding,
        NativeWorkspaceSize {
            width: 640.0,
            height: 360.0,
        },
        revision,
        NATIVE_WORKSPACE_RESTORE_BYTES,
    )
    .unwrap();
    while !source.step(&context, 64, revision).unwrap().complete {}
    let mut target = NativeWorkspaceTarget::new(
        source.metadata_json().unwrap(),
        &host,
        NumberDialect::PLATFORM,
        1.0,
    )
    .unwrap();
    for slot in 0..6 {
        let values = source
            .read_slice(&context, slot, 0, fixture.data.store().length(), revision)
            .unwrap();
        target.write_slice(slot, 0, values).unwrap();
    }
    target.start().unwrap();
    let quantum = 4_096usize;
    let mut derived_work = 0usize;
    loop {
        let step = target.step(&host, quantum).unwrap();
        if step.phase == "indices" {
            assert!(target.last_step_work() <= quantum);
            derived_work += target.last_step_work();
        }
        if step.complete {
            break;
        }
    }
    assert_eq!(derived_work, 2 * (65_536 + 2_047));
    let restored = target.finish().unwrap();
    for id in ["close-line", "ema-line"] {
        let info = restored
            .series_caches
            .info(&JsString::from_str(id))
            .unwrap();
        assert_eq!(
            info.kind,
            barochart_core::series_cache::SeriesCacheKind::Block
        );
        assert_eq!(info.size, 65_536);
        assert_eq!(info.length, 65_536);
        assert_eq!(info.block_size, Some(32));
    }
    let close = &restored.data.store().columns().close[..65_536];
    assert_eq!(
        restored
            .series_caches
            .finite_count(&JsString::from_str("close-line"), close, 0, 65_536)
            .unwrap(),
        65_536
    );
}

#[test]
fn actual_js_workspace_target_errors_are_exact_and_abort_is_idempotent() {
    let host = FixtureHost;
    let fixture = chart("basic", &host);
    let (mut source, context, revision) = admitted_source(&fixture, &host);
    let metadata = source.metadata_json().unwrap().clone();
    let expected = rows("target-error");
    let expected_error = |id: &str| {
        decode_wire(get(
            expected
                .iter()
                .find(|row| text(get(row, "id")) == id)
                .unwrap(),
            "expected",
        ))
    };
    let assert_error = |error: &barochart_js::error::JsError, id: &str| {
        assert_eq!(
            json(&encode_wire(&error_tuple(error))),
            json(&encode_wire(&expected_error(id))),
            "{id}"
        );
    };

    let error = match NativeWorkspaceTarget::new(
        &JsString::from_str(r#"{"schema":"bad"}"#),
        &host,
        NumberDialect::PLATFORM,
        1.0,
    ) {
        Ok(_) => panic!("bad protocol accepted"),
        Err(error) => error,
    };
    assert_error(&error, "bad-protocol");

    let mut target =
        NativeWorkspaceTarget::new(&metadata, &host, NumberDialect::PLATFORM, 1.0).unwrap();
    let error = target.start().unwrap_err();
    assert_error(&error, "incomplete-start");
    assert!(!target.abort());

    let mut target =
        NativeWorkspaceTarget::new(&metadata, &host, NumberDialect::PLATFORM, 1.0).unwrap();
    let error = match target.finish() {
        Ok(_) => panic!("early finish accepted"),
        Err(error) => error,
    };
    assert_error(&error, "finish-early");

    let mut target =
        NativeWorkspaceTarget::new(&metadata, &host, NumberDialect::PLATFORM, 1.0).unwrap();
    let values = source
        .read_slice(&context, 0, 0, fixture.data.store().length(), revision)
        .unwrap();
    let error = target.write_slice(0, 1, values).unwrap_err();
    assert_error(&error, "copy-order");

    let mut target =
        NativeWorkspaceTarget::new(&metadata, &host, NumberDialect::PLATFORM, 1.0).unwrap();
    for slot in 0..6 {
        let columns = fixture.data.store().columns();
        let mut values = match slot {
            0 => columns.time[..fixture.data.store().length()].to_vec(),
            1 => columns.open[..fixture.data.store().length()].to_vec(),
            2 => columns.high[..fixture.data.store().length()].to_vec(),
            3 => columns.low[..fixture.data.store().length()].to_vec(),
            4 => columns.close[..fixture.data.store().length()].to_vec(),
            _ => columns.volume[..fixture.data.store().length()].to_vec(),
        };
        if slot == 0 {
            values[0] += 1.0;
        }
        target.write_slice(slot, 0, &values).unwrap();
    }
    target.start().unwrap();
    let error = loop {
        match target.step(&host, 64) {
            Ok(progress) if progress.complete => panic!("bad extent completed"),
            Ok(_) => continue,
            Err(error) => break error,
        }
    };
    assert_error(&error, "source-extent");
}

#[test]
fn workspace_source_uses_the_actual_store_account_and_abort_releases_capture_memory() {
    let host = FixtureHost;
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        (0..4).map(bar).collect(),
        memory.clone(),
    )
    .unwrap();
    let model = ModelState::new(data.store(), &parse(r#"{"panels":[{"id":"price"}]}"#)).unwrap();
    let engine =
        IndicatorEngine::new_with_memory(IndicatorEngineOptions::default(), memory.clone())
            .unwrap();
    let drawings =
        DrawingStore::with_defaults_and_memory(NumberDialect::PLATFORM, memory.clone()).unwrap();
    let caches = SeriesCaches::new_with_memory(memory.clone());
    let binding = parse(
        r#"{"key":"memory","revision":"r1","adjustmentVersion":"raw-v1","priceUnit":"USD","adjustment":"raw"}"#,
    );
    let context = WorkspaceContext {
        host: &host,
        model: &model,
        store: data.store(),
        indicators: &engine,
        drawings: &drawings,
        symbol: None,
        symbol_formatters: false,
        interaction: WorkspaceInteraction::default(),
        dialect: NumberDialect::PLATFORM,
    };
    let document = save_workspace(&context, &binding, None).unwrap();
    let baseline = account.snapshot().requested_live_bytes;
    let foreign_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let foreign_caches = SeriesCaches::new_with_memory(MemoryContext::accounted(&foreign_account));
    let error = match NativeWorkspaceSource::new_with_runtime_state(
        &context,
        Some(&foreign_caches),
        &JsValue::String(document.clone()),
        &binding,
        NativeWorkspaceSize {
            width: 640.0,
            height: 360.0,
        },
        1.0,
        NATIVE_WORKSPACE_RESTORE_BYTES,
        None,
    ) {
        Ok(_) => panic!("cross-account workspace source was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message.to_string_lossy(),
        "Native workspace source memory context"
    );
    assert_eq!(account.snapshot().requested_live_bytes, baseline);
    assert_eq!(foreign_account.snapshot().requested_live_bytes, 0);
    let mut source = NativeWorkspaceSource::new_with_runtime_state(
        &context,
        Some(&caches),
        &JsValue::String(document),
        &binding,
        NativeWorkspaceSize {
            width: 640.0,
            height: 360.0,
        },
        1.0,
        NATIVE_WORKSPACE_RESTORE_BYTES,
        None,
    )
    .unwrap();
    assert!(account.snapshot().requested_live_bytes > baseline);
    assert!(source.abort());
    assert_eq!(account.snapshot().requested_live_bytes, baseline);
    drop((source, caches, drawings, engine, model, data));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn workspace_target_quota_is_atomic_and_finished_groups_drop_to_zero() {
    let host = FixtureHost;
    let fixture = chart("basic", &host);
    let (mut source, context, revision) = admitted_source(&fixture, &host);
    let metadata = source.metadata_json().unwrap().clone();

    let invalid_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let invalid = match NativeWorkspaceTarget::new_with_memory(
        &metadata,
        &host,
        NumberDialect::PLATFORM,
        0.0,
        MemoryContext::accounted(&invalid_account),
    ) {
        Ok(_) => panic!("invalid store serial was accepted"),
        Err(error) => error,
    };
    assert_eq!(invalid.name, "RangeError");
    assert_eq!(invalid.message.to_string_lossy(), "Workspace store serial");
    assert_eq!(invalid_account.snapshot().requested_live_bytes, 0);

    let probe_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut probe = NativeWorkspaceTarget::new_with_memory(
        &metadata,
        &host,
        NumberDialect::PLATFORM,
        1.0,
        MemoryContext::accounted(&probe_account),
    )
    .unwrap();
    assert!(probe_account.snapshot().requested_live_bytes > 0);
    let denied_limit = probe_account
        .snapshot()
        .requested_peak_bytes
        .saturating_sub(1);
    assert!(probe.abort());
    assert_eq!(probe_account.snapshot().requested_live_bytes, 0);

    let denied_account = MemoryAccount::new(denied_limit, OomStyle::InternalErrorLowercase);
    let error = match NativeWorkspaceTarget::new_with_memory(
        &metadata,
        &host,
        NumberDialect::PLATFORM,
        1.0,
        MemoryContext::accounted(&denied_account),
    ) {
        Ok(_) => panic!("quota below the measured construction peak was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.name, "InternalError");
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(denied_account.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let mut target = NativeWorkspaceTarget::new_with_memory(
        &metadata,
        &host,
        NumberDialect::PLATFORM,
        1.0,
        memory.clone(),
    )
    .unwrap();
    for slot in 0..6 {
        let values = source
            .read_slice(&context, slot, 0, fixture.data.store().length(), revision)
            .unwrap();
        target.write_slice(slot, 0, values).unwrap();
    }
    target.start().unwrap();
    while !target.step(&host, 64).unwrap().complete {}
    let restored = target.finish().unwrap();
    assert!(
        restored
            .data
            .store()
            .memory_context()
            .shares_account(&memory)
    );
    assert!(restored.indicators.memory_context().shares_account(&memory));
    assert!(
        restored
            .series_caches
            .memory_context()
            .shares_account(&memory)
    );
    assert!(account.snapshot().requested_live_bytes > 0);
    drop((restored, target));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn workspace_owned_columns_keep_allocation_and_explicit_versions() {
    let capacity = 16;
    let mut columns = Columns {
        time: vec![0.0; capacity],
        open: vec![0.0; capacity],
        high: vec![0.0; capacity],
        low: vec![0.0; capacity],
        close: vec![0.0; capacity],
        volume: vec![0.0; capacity],
    };
    for index in 0..2 {
        let row = bar(index);
        columns.time[index] = row.time;
        columns.open[index] = row.open;
        columns.high[index] = row.high;
        columns.low[index] = row.low;
        columns.close[index] = row.close;
        columns.volume[index] = row.volume;
    }
    let pointers = [
        columns.time.as_ptr(),
        columns.open.as_ptr(),
        columns.high.as_ptr(),
        columns.low.as_ptr(),
        columns.close.as_ptr(),
        columns.volume.as_ptr(),
    ];
    let data =
        ModelDataState::from_workspace_columns(17.0, StoreOptions::default(), columns, 2, 8.0, 9.0)
            .unwrap();
    let store = data.store();
    assert_eq!(
        (store.serial(), store.version(), store.time_version()),
        (17.0, 8.0, 9.0)
    );
    assert_eq!((store.length(), store.capacity()), (2, capacity));
    assert_eq!(
        pointers,
        [
            store.columns().time.as_ptr(),
            store.columns().open.as_ptr(),
            store.columns().high.as_ptr(),
            store.columns().low.as_ptr(),
            store.columns().close.as_ptr(),
            store.columns().volume.as_ptr(),
        ]
    );
}

#[test]
fn native_snapshot_columns_preserve_spare_capacity_above_local_max_bars() {
    let capacity = 32;
    let mut columns = Columns {
        time: vec![0.0; capacity],
        open: vec![0.0; capacity],
        high: vec![0.0; capacity],
        low: vec![0.0; capacity],
        close: vec![0.0; capacity],
        volume: vec![0.0; capacity],
    };
    for index in 0..2 {
        let row = bar(index);
        columns.time[index] = row.time;
        columns.open[index] = row.open;
        columns.high[index] = row.high;
        columns.low[index] = row.low;
        columns.close[index] = row.close;
        columns.volume[index] = row.volume;
    }
    let time_pointer = columns.time.as_ptr();
    let data = ModelDataState::from_native_snapshot_columns(
        23.0,
        StoreOptions {
            max_bars: 2,
            ..StoreOptions::default()
        },
        columns,
        2,
        4.0,
        5.0,
    )
    .unwrap();
    assert_eq!(data.store().capacity(), capacity);
    assert_eq!(data.store().columns().time.as_ptr(), time_pointer);
    assert_eq!(
        (
            data.store().serial(),
            data.store().version(),
            data.store().time_version()
        ),
        (23.0, 4.0, 5.0)
    );
}

#[test]
fn validated_workspace_columns_adopt_prebuilt_tree_without_rescan_or_recopy() {
    let capacity = 16;
    let mut columns = Columns {
        time: vec![0.0; capacity],
        open: vec![0.0; capacity],
        high: vec![0.0; capacity],
        low: vec![0.0; capacity],
        close: vec![0.0; capacity],
        volume: vec![0.0; capacity],
    };
    for index in 0..2 {
        let row = bar(index);
        columns.time[index] = row.time;
        columns.open[index] = row.open;
        columns.high[index] = row.high;
        columns.low[index] = row.low;
        columns.close[index] = row.close;
        columns.volume[index] = row.volume;
    }
    let index = RangeIndex::new(
        2,
        &columns.low,
        &columns.high,
        Some(&columns.volume),
        capacity,
        false,
    )
    .unwrap();
    let time_pointer = columns.time.as_ptr();
    let data = ModelDataState::from_validated_workspace_columns(
        29.0,
        StoreOptions::default(),
        columns,
        index,
        2,
        11.0,
        12.0,
    )
    .unwrap();
    assert_eq!(data.store().columns().time.as_ptr(), time_pointer);
    assert_eq!(data.store().index().query(0, 2).unwrap().sum, 3.0);
    assert_eq!(
        (
            data.store().serial(),
            data.store().version(),
            data.store().time_version()
        ),
        (29.0, 11.0, 12.0)
    );
}

#[test]
fn validated_native_snapshot_adopts_spare_columns_and_tree_in_o1() {
    let capacity = 32;
    let mut columns = Columns {
        time: vec![0.0; capacity],
        open: vec![0.0; capacity],
        high: vec![0.0; capacity],
        low: vec![0.0; capacity],
        close: vec![0.0; capacity],
        volume: vec![0.0; capacity],
    };
    for index in 0..2 {
        let row = bar(index);
        columns.time[index] = row.time;
        columns.open[index] = row.open;
        columns.high[index] = row.high;
        columns.low[index] = row.low;
        columns.close[index] = row.close;
        columns.volume[index] = row.volume;
    }
    let index = RangeIndex::new(
        2,
        &columns.low,
        &columns.high,
        Some(&columns.volume),
        capacity,
        false,
    )
    .unwrap();
    let time_pointer = columns.time.as_ptr();
    let tree_pointer = index.buffer_view().min.as_ptr();
    let data = ModelDataState::from_validated_native_snapshot_columns(
        31.0,
        StoreOptions {
            max_bars: 2,
            ..StoreOptions::default()
        },
        columns,
        index,
        2,
        13.0,
        14.0,
    )
    .unwrap();
    assert_eq!(data.store().capacity(), capacity);
    assert_eq!(data.store().columns().time.as_ptr(), time_pointer);
    assert_eq!(
        data.store().index().buffer_view().min.as_ptr(),
        tree_pointer
    );
    assert_eq!(data.store().index().query(0, 2).unwrap().sum, 3.0);
}

#[test]
fn workspace_engine_capture_tracks_container_entry_and_scalar_changes() {
    let host = FixtureHost;
    let mut fixture = chart("basic", &host);
    let token = fixture.engine.capture_entries();
    assert!(fixture.engine.validate_capture(&token));

    add_indicator(
        &mut fixture.engine,
        fixture.data.store(),
        &host,
        "second",
        "sma",
        parse(r#"{"period":3}"#),
    );
    assert!(!fixture.engine.validate_capture(&token));

    let token = fixture.engine.capture_entries();
    fixture
        .engine
        .install_checkpoints(
            &JsValue::String(JsString::from_str("ema")),
            Default::default(),
            None,
        )
        .unwrap();
    assert!(!fixture.engine.validate_capture(&token));

    let token = fixture.engine.capture_entries();
    let committed = fixture.data.store_mut().append(bar(40)).unwrap();
    fixture
        .engine
        .apply_change(fixture.data.store(), committed.change.as_ref().unwrap());
    assert!(!fixture.engine.validate_capture(&token));
}

#[test]
fn workspace_model_capture_tracks_equal_value_object_replacements() {
    let host = FixtureHost;
    let mut fixture = chart("basic", &host);
    let token = fixture.model.capture_workspace_state();
    let view = fixture.model.view;
    fixture
        .model
        .set_visible_range(
            fixture.data.store(),
            &JsValue::Number(view.from),
            &JsValue::Number(view.to),
        )
        .unwrap();
    assert!(!fixture.model.validate_workspace_state(&token));

    let mut fixture = chart("basic", &host);
    let token = fixture.model.capture_workspace_state();
    fixture
        .model
        .set_panel(
            &JsValue::String(JsString::from_str("price")),
            &JsValue::Object(JsObject::new()),
            &ModelContext::plain(fixture.data.store()),
        )
        .unwrap();
    assert!(!fixture.model.validate_workspace_state(&token));

    let mut fixture = chart("basic", &host);
    let token = fixture.model.capture_workspace_state();
    fixture
        .model
        .set_theme_api(&JsValue::Object(JsObject::new()))
        .unwrap();
    assert!(!fixture.model.validate_workspace_state(&token));

    let mut fixture = chart("basic", &host);
    fixture
        .model
        .add_series_with_values(
            &parse(r#"{"id":"external","type":"line","panel":"price"}"#),
            vec![1.0; fixture.data.store().length()],
            &ModelContext::plain(fixture.data.store()),
        )
        .unwrap();
    let values_token = fixture.model.capture_series_values_reference();
    fixture
        .model
        .set_panel(
            &JsValue::String(JsString::from_str("price")),
            &JsValue::Object(JsObject::new()),
            &ModelContext::plain(fixture.data.store()),
        )
        .unwrap();
    assert!(
        fixture
            .model
            .validate_series_values_reference(&values_token)
    );
    fixture
        .model
        .set_series_values(
            &JsValue::String(JsString::from_str("external")),
            vec![1.0; fixture.data.store().length()],
            fixture.data.store(),
        )
        .unwrap();
    assert!(
        !fixture
            .model
            .validate_series_values_reference(&values_token)
    );

    let mut fixture = chart("basic", &host);
    let mut raw_font = JsObject::new();
    raw_font.insert(JsString::from_str("font"), JsValue::Object(JsObject::new()));
    fixture
        .model
        .set_theme_legacy(&JsValue::Object(raw_font.clone()))
        .unwrap();
    let font_token = fixture.model.capture_theme_value_reference("font").unwrap();
    fixture
        .model
        .set_theme_legacy(&JsValue::Object(JsObject::new()))
        .unwrap();
    assert!(
        fixture
            .model
            .validate_theme_value_reference("font", &font_token)
    );
    let mut other = JsObject::new();
    other.insert(
        JsString::from_str("background"),
        JsValue::String(JsString::from_str("raw")),
    );
    fixture
        .model
        .set_theme_legacy(&JsValue::Object(other))
        .unwrap();
    assert!(
        fixture
            .model
            .validate_theme_value_reference("font", &font_token)
    );
    fixture
        .model
        .set_theme_legacy(&JsValue::Object(raw_font))
        .unwrap();
    assert!(
        !fixture
            .model
            .validate_theme_value_reference("font", &font_token)
    );
}

#[test]
fn workspace_drawing_capture_uses_container_identity_and_final_scalars() {
    let host = FixtureHost;
    let mut fixture = chart("basic", &host);
    let selected = fixture.drawings.selected().cloned();
    let token = fixture.drawings.capture_workspace_state().unwrap();
    fixture
        .drawings
        .select(Some(&JsString::from_str("level")))
        .unwrap();
    fixture.drawings.select(selected.as_ref()).unwrap();
    assert!(fixture.drawings.validate_workspace_state(&token));

    let token = fixture.drawings.capture_workspace_state().unwrap();
    fixture.drawings.begin().unwrap();
    fixture.drawings.cancel();
    assert!(!fixture.drawings.validate_workspace_state(&token));
}
