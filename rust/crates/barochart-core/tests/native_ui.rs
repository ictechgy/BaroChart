use barochart_core::chart_api::ChartApi;
use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::interaction::OwnedInteractionState;
use barochart_core::native_chart::NativeChart;
use barochart_core::native_runtime::{NativeRuntime, RuntimeContext};
use barochart_core::native_ui::NativeUiCapture;
use barochart_core::{Engine, Host, HostError, NativeSizeState};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::{NumberDialect, js_max};
use barochart_js::string::JsString;

const UI_ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-ui.leaf.jsonl");

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

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item.clone());
    }
    JsValue::Object(value)
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value
        .get(&key(name))
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
        if let Some(JsValue::String(bits)) = encoded.get(&key("$f64")) {
            return JsValue::Number(f64::from_bits(
                u64::from_str_radix(&bits.to_string_lossy(), 16).unwrap(),
            ));
        }
        if encoded.get(&key("$undefined")).is_some() {
            return JsValue::Undefined;
        }
        if let Some(JsValue::Array(entries)) = encoded.get(&key("$object")) {
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

fn oracle(id: &str) -> JsValue {
    UI_ORACLE
        .lines()
        .skip(1)
        .map(parse)
        .find(|row| matches!(field(row, "id"), JsValue::String(value) if value == &key(id)))
        .map(|row| decode_wire(&row))
        .unwrap()
}

fn assert_wire(actual: &JsValue, expected: &JsValue) {
    assert_eq!(
        stringify_json(actual, JsonMode::Lossless),
        stringify_json(expected, JsonMode::Lossless)
    );
}

fn error_value(error: barochart_js::error::JsError) -> JsValue {
    object(&[
        ("name", text(error.name)),
        ("message", JsValue::String(error.message)),
        ("code", error.code.map_or(JsValue::Null, |code| text(&code))),
    ])
}

fn chart(length: usize) -> NativeChart {
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
    NativeChart::new(data, &JsValue::Null, NumberDialect::Ecma, &NoZones).unwrap()
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
    NativeChart::new(data, &JsValue::Null, NumberDialect::Ecma, &NoZones).unwrap()
}

fn size() -> NativeSizeState {
    let mut engine = Engine::new(Box::new(NoZones));
    engine
        .set_native_size(&JsValue::Number(1200.0), &JsValue::Number(700.0))
        .unwrap();
    engine.native_size().unwrap().clone()
}

fn call(chart: &mut NativeChart, operation: &str, args: &[JsValue]) -> JsValue {
    ChartApi::new(chart, &NoZones)
        .dispatch(&key(operation), args)
        .unwrap()
}

fn configured_chart() -> (NativeChart, OwnedInteractionState, NativeSizeState) {
    let mut chart = chart(8);
    let first = chart.data().store().at(1).unwrap();
    let second = chart.data().store().at(6).unwrap();
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
    call(
        &mut chart,
        "editDrawing",
        &[
            text("d"),
            object(&[(
                "points",
                JsValue::Array(vec![
                    object(&[
                        ("time", JsValue::Number(first.time)),
                        ("price", JsValue::Number(first.close + 1.0)),
                    ]),
                    object(&[
                        ("time", JsValue::Number(second.time)),
                        ("price", JsValue::Number(second.close + 1.0)),
                    ]),
                ]),
            )]),
        ],
    );
    call(&mut chart, "undo", &[]);
    call(&mut chart, "selectDrawing", &[text("d")]);
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
    call(
        &mut chart,
        "setVisibleRange",
        &[JsValue::Number(1.0), JsValue::Number(6.0)],
    );
    let input = OwnedInteractionState::from_native_ui(
        key("trendline"),
        text("hello"),
        Some(object(&[("panel", text("price"))])),
        Some((240.0, 140.0)),
    );
    (chart, input, size())
}

fn runtime_call(
    runtime: &mut NativeRuntime,
    chart: &mut NativeChart,
    input: &OwnedInteractionState,
    size: &NativeSizeState,
    serial: &mut f64,
    name: &str,
    args: &[JsValue],
) -> barochart_core::native_runtime::NativeRuntimeResult {
    runtime
        .call(
            &key(name),
            args,
            RuntimeContext {
                chart: Some(chart),
                input: Some(input),
                size: Some(size),
                host: &NoZones,
                next_store_serial: serial,
            },
        )
        .unwrap()
}

fn empty_call(
    runtime: &mut NativeRuntime,
    serial: &mut f64,
    name: &str,
    args: &[JsValue],
) -> barochart_core::native_runtime::NativeRuntimeResult {
    runtime
        .call(
            &key(name),
            args,
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: serial,
            },
        )
        .unwrap()
}

#[test]
fn direct_and_streamed_ui_capture_match_exact_node22_strings() {
    let expected = oracle("capture");
    let (chart, input, size) = configured_chart();
    let direct = NativeUiCapture::direct(&chart, &input, &size, None, NumberDialect::Ecma).unwrap();
    assert_eq!(direct.to_string_lossy(), string(field(&expected, "direct")));

    let mut capture =
        NativeUiCapture::new(&chart, &input, &size, None, NumberDialect::Ecma).unwrap();
    assert_eq!(
        capture.header_json().to_string_lossy(),
        string(field(&expected, "header"))
    );
    let mut chunks = Vec::new();
    loop {
        let text = capture.next_chunk().unwrap().to_string_lossy();
        let complete = matches!(field(&parse(&text), "complete"), JsValue::Bool(true));
        chunks.push(text);
        if complete {
            break;
        }
    }
    assert_eq!(
        chunks,
        array(field(&expected, "chunks"))
            .iter()
            .map(string)
            .collect::<Vec<_>>()
    );
    capture.check(&chart, &input, &size).unwrap();
    let changed = OwnedInteractionState::from_native_ui(
        key("select"),
        text("hello"),
        Some(object(&[("panel", text("price"))])),
        Some((240.0, 140.0)),
    );
    let error = capture.check(&chart, &changed, &size).unwrap_err();
    assert_eq!(error.name, "Error");
    assert_eq!(
        error.message.to_string_lossy(),
        "Async stale: UI changed during transfer"
    );
}

#[test]
fn ui_capture_omits_an_unset_symbol() {
    let chart = chart(8);
    let input = OwnedInteractionState::new();
    let size = size();
    let direct =
        NativeUiCapture::direct(&chart, &input, &size, None, NumberDialect::Ecma).expect("capture");
    let state = parse(&direct.to_string_lossy());
    let JsValue::Object(state) = &state else {
        panic!("UI capture must be an object")
    };

    assert!(state.get(&key("symbol")).is_none());
}

#[test]
fn ui_capture_and_direct_text_hold_only_live_accounted_payloads() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let chart = chart_with_memory(8, memory);
    let input = OwnedInteractionState::new();
    let size = size();
    let baseline = account.snapshot().requested_live_bytes;

    let direct =
        NativeUiCapture::direct_with_memory(&chart, &input, &size, None, NumberDialect::Ecma)
            .unwrap();
    let (text, direct_memory) = direct.into_parts();
    assert!(!text.as_units().is_empty());
    assert!(direct_memory.requested_bytes() > 0);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        baseline + direct_memory.requested_bytes()
    );
    drop((text, direct_memory));
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    let mut capture =
        NativeUiCapture::new(&chart, &input, &size, None, NumberDialect::Ecma).unwrap();
    assert!(capture.accounted_bytes() > 0);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        baseline + capture.accounted_bytes()
    );
    while !capture.complete() {
        let _ = capture.next_chunk().unwrap();
    }
    assert_eq!(
        account.snapshot().requested_live_bytes,
        baseline + capture.accounted_bytes()
    );
    drop(capture);
    assert_eq!(account.snapshot().requested_live_bytes, baseline);
    drop(chart);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ui_capture_quota_failure_is_atomic() {
    let probe_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let probe_memory = MemoryContext::accounted(&probe_account);
    let probe_chart = chart_with_memory(8, probe_memory);
    let input = OwnedInteractionState::new();
    let size = size();
    let probe_baseline = probe_account.snapshot().requested_live_bytes;
    let chart_peak = probe_account.snapshot().requested_peak_bytes;
    let probe =
        NativeUiCapture::new(&probe_chart, &input, &size, None, NumberDialect::Ecma).unwrap();
    let denied_limit = probe_account
        .snapshot()
        .requested_peak_bytes
        .saturating_sub(1);
    assert!(denied_limit >= chart_peak);
    assert!(probe_account.snapshot().requested_live_bytes > probe_baseline);
    drop((probe, probe_chart));
    assert_eq!(probe_account.snapshot().requested_live_bytes, 0);

    let denied_account = MemoryAccount::new(denied_limit, OomStyle::InternalErrorLowercase);
    let denied_memory = MemoryContext::accounted(&denied_account);
    let chart = chart_with_memory(8, denied_memory);
    let baseline = denied_account.snapshot().requested_live_bytes;
    let error = match NativeUiCapture::new(&chart, &input, &size, None, NumberDialect::Ecma) {
        Ok(_) => panic!("capture below the measured peak was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.name, "InternalError");
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert_eq!(denied_account.snapshot().requested_live_bytes, baseline);
    drop(chart);
    assert_eq!(denied_account.snapshot().requested_live_bytes, 0);
}

#[test]
fn prepare_publication_restores_the_generated_follow_view() {
    let publication = prepare_follow_publication(None);
    assert_eq!(publication.chart.model().view.from, 9.5);
    assert_eq!(publication.chart.model().view.to, 39.5);
    assert!(publication.chart.model().follow);
}

#[test]
fn ui_import_preserves_a_drawing_serial_above_the_wasm32_address_range() {
    let serial = 9_007_199_254_740_991u64;
    let publication = prepare_follow_publication(Some(serial));
    assert_eq!(publication.chart.drawings().serial(), serial);
}

fn prepare_follow_publication(
    serial: Option<u64>,
) -> barochart_core::native_ui::PreparedPublication {
    let mut source_chart = chart(64);
    let source_input = OwnedInteractionState::new();
    let source_size = size();
    let mut source_runtime = NativeRuntime::new();
    let mut source_serial = 2.0;
    let begin = runtime_call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":40,\"seed\":42,\"visibleBars\":30}",
        )],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();

    let mut target_runtime = NativeRuntime::new();
    let mut target_serial = 1.0;
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativePrepareCreate",
        &[field(&begin, "metadataJSON").clone()],
    );
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncStart",
        &[],
    );
    loop {
        let progress = empty_call(
            &mut target_runtime,
            &mut target_serial,
            "nativeAsyncStep",
            &[JsValue::Number(4_096.0)],
        )
        .value;
        if matches!(
            field(&parse(&string(&progress)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
    }

    let header = runtime_call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    let header = if let Some(serial) = serial {
        let original = string(&header);
        assert!(original.contains("\"serial\":0"));
        text(&original.replacen("\"serial\":0", &format!("\"serial\":{serial}"), 1))
    } else {
        header
    };
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    loop {
        let chunk = runtime_call(
            &mut source_runtime,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .value;
        if matches!(
            field(&parse(&string(&chunk)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
        empty_call(
            &mut target_runtime,
            &mut target_serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncUIImportEnd",
        &[],
    );
    let result = empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncFinish",
        &[],
    );
    result.publication.expect("prepare publication")
}

fn ready_prepare_ui_transfer(
    memory: Option<MemoryContext>,
) -> (NativeRuntime, f64, JsValue, Vec<JsValue>, JsValue) {
    let (mut source_chart, source_input, source_size) = configured_chart();
    let mut source = NativeRuntime::new();
    let mut source_serial = 2.0;
    let begin = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":8,\"seed\":42,\"visibleBars\":6}",
        )],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();
    let mut target = memory.map_or_else(NativeRuntime::new, NativeRuntime::new_with_memory);
    let mut target_serial = 1.0;
    empty_call(
        &mut target,
        &mut target_serial,
        "nativePrepareCreate",
        &[field(&begin, "metadataJSON").clone()],
    );
    empty_call(&mut target, &mut target_serial, "nativeAsyncStart", &[]);
    loop {
        let progress = empty_call(
            &mut target,
            &mut target_serial,
            "nativeAsyncStep",
            &[JsValue::Number(4_096.0)],
        )
        .value;
        if matches!(
            field(&parse(&string(&progress)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
    }
    let direct = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUI",
        std::slice::from_ref(&ticket),
    )
    .value;
    let header = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    let mut chunks = Vec::new();
    loop {
        let chunk = runtime_call(
            &mut source,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .value;
        if matches!(
            field(&parse(&string(&chunk)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
        chunks.push(chunk);
    }
    (target, target_serial, header, chunks, direct)
}

fn header_with_drawing_field(header: &JsValue, name: &str, value: JsValue) -> JsValue {
    let mut header = parse(&string(header));
    let JsValue::Object(header_record) = &mut header else {
        unreachable!()
    };
    let JsValue::Object(state) = header_record.get_mut(&key("state")).unwrap() else {
        unreachable!()
    };
    let JsValue::Object(drawings) = state.get_mut(&key("drawings")).unwrap() else {
        unreachable!()
    };
    drawings.insert(key(name), value);
    text(&String::from_utf8(stringify_json(&header, JsonMode::Standard)).unwrap())
}

fn header_with_symbol_field(header: &JsValue, name: &str, value: JsValue) -> JsValue {
    let mut header = parse(&string(header));
    let JsValue::Object(header_record) = &mut header else {
        unreachable!()
    };
    let JsValue::Object(state) = header_record.get_mut(&key("state")).unwrap() else {
        unreachable!()
    };
    let JsValue::Object(symbol) = state.get_mut(&key("symbol")).unwrap() else {
        unreachable!()
    };
    symbol.insert(key(name), value);
    text(&String::from_utf8(stringify_json(&header, JsonMode::Standard)).unwrap())
}

fn direct_with_symbol_field(direct: &JsValue, name: &str, value: JsValue) -> JsValue {
    let mut direct = parse(&string(direct));
    let JsValue::Object(state) = &mut direct else {
        unreachable!()
    };
    let JsValue::Object(symbol) = state.get_mut(&key("symbol")).unwrap() else {
        unreachable!()
    };
    symbol.insert(key(name), value);
    text(&String::from_utf8(stringify_json(&direct, JsonMode::Standard)).unwrap())
}

fn header_with_state_field(header: &JsValue, name: &str, value: JsValue) -> JsValue {
    let mut header = parse(&string(header));
    let JsValue::Object(header_record) = &mut header else {
        unreachable!()
    };
    let JsValue::Object(state) = header_record.get_mut(&key("state")).unwrap() else {
        unreachable!()
    };
    state.insert(key(name), value);
    text(&String::from_utf8(stringify_json(&header, JsonMode::Standard)).unwrap())
}

#[test]
fn streamed_ui_import_returns_the_exact_atomic_publication() {
    let expected = oracle("import");
    let (mut source_chart, source_input, source_size) = configured_chart();
    let mut source_runtime = NativeRuntime::new();
    let mut source_serial = 2.0;
    let bar = source_chart.data().store().at(2).unwrap();
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(bar.time)),
                ("open", JsValue::Number(bar.open)),
                (
                    "high",
                    JsValue::Number(js_max(&[bar.high, bar.close + 1.0])),
                ),
                ("low", JsValue::Number(bar.low)),
                ("close", JsValue::Number(bar.close + 1.0)),
                ("volume", JsValue::Number(bar.volume)),
            ]),
        ),
    ]);
    let event_text =
        JsString::from_str(&String::from_utf8(stringify_json(&event, JsonMode::Standard)).unwrap());
    let begin = runtime_call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncBegin",
        &[JsValue::String(event_text)],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();

    let mut target_runtime = NativeRuntime::new();
    let mut target_serial = 1.0;
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncCreate",
        &[field(&begin, "metadataJSON").clone()],
    );
    for descriptor in array(field(&begin, "buffers")) {
        let slot = field(descriptor, "slot").clone();
        let length = field(descriptor, "length").clone();
        let length_number = match &length {
            JsValue::Number(value) => *value as usize,
            _ => unreachable!(),
        };
        for offset in (0..length_number).step_by(3) {
            let count = std::cmp::min(3, length_number - offset);
            let values = source_runtime
                .read_f64(
                    RuntimeContext {
                        chart: Some(&mut source_chart),
                        input: Some(&source_input),
                        size: Some(&source_size),
                        host: &NoZones,
                        next_store_serial: &mut source_serial,
                    },
                    &ticket,
                    &slot,
                    &JsValue::Number(offset as f64),
                    &JsValue::Number(count as f64),
                )
                .unwrap()
                .to_vec();
            target_runtime
                .target_f64(
                    RuntimeContext {
                        chart: None,
                        input: None,
                        size: None,
                        host: &NoZones,
                        next_store_serial: &mut target_serial,
                    },
                    &slot,
                    &JsValue::Number(offset as f64),
                    &JsValue::Number(count as f64),
                )
                .unwrap()
                .copy_from_slice(&values);
        }
    }
    for descriptor in array(field(&begin, "checkpoints")) {
        let entry = field(descriptor, "entry").clone();
        let total = match field(descriptor, "total") {
            JsValue::Number(value) => *value as usize,
            _ => unreachable!(),
        };
        let max_rows = match field(descriptor, "maxRows") {
            JsValue::Number(value) => *value as usize,
            _ => unreachable!(),
        };
        for offset in (0..total).step_by(max_rows) {
            let count = std::cmp::min(max_rows, total - offset);
            let checkpoint = runtime_call(
                &mut source_runtime,
                &mut source_chart,
                &source_input,
                &source_size,
                &mut source_serial,
                "nativeAsyncCheckpoint",
                &[
                    ticket.clone(),
                    entry.clone(),
                    JsValue::Number(offset as f64),
                    JsValue::Number(count as f64),
                ],
            )
            .value;
            empty_call(
                &mut target_runtime,
                &mut target_serial,
                "nativeAsyncCheckpointImport",
                &[entry.clone(), checkpoint],
            );
        }
    }
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncStart",
        &[],
    );
    loop {
        let value = empty_call(
            &mut target_runtime,
            &mut target_serial,
            "nativeAsyncStep",
            &[JsValue::Number(2.0)],
        )
        .value;
        if matches!(
            field(&parse(&string(&value)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
    }

    let header = runtime_call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncUIImportBegin",
        std::slice::from_ref(&header),
    );
    loop {
        let chunk = runtime_call(
            &mut source_runtime,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .value;
        let parsed = parse(&string(&chunk));
        if matches!(field(&parsed, "complete"), JsValue::Bool(true)) {
            break;
        }
        empty_call(
            &mut target_runtime,
            &mut target_serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncUIImportEnd",
        &[],
    );
    let result = empty_call(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncFinish",
        &[],
    );
    let publication = result.publication.expect("publication");
    let chart = publication.chart;
    let input = publication.input.expect("finalized UI input");
    let inspect = object(&[
        (
            "view",
            object(&[
                ("from", JsValue::Number(chart.model().view.from)),
                ("to", JsValue::Number(chart.model().view.to)),
            ]),
        ),
        (
            "drawings",
            JsValue::Array(
                chart
                    .drawings()
                    .items()
                    .iter()
                    .map(|drawing| drawing.to_value())
                    .collect(),
            ),
        ),
        (
            "storedBars",
            JsValue::Number(chart.data().store().length() as f64),
        ),
        ("tool", JsValue::String(input.tool().clone())),
        ("pointers", JsValue::Number(input.pointer_count() as f64)),
        ("gesture", input.gesture_kind().map_or(JsValue::Null, text)),
    ]);
    let crosshair = input.crosshair_value().map_or(JsValue::Null, |(x, y)| {
        object(&[("x", JsValue::Number(x)), ("y", JsValue::Number(y))])
    });
    let drawings = object(&[
        (
            "items",
            JsValue::Array(
                chart
                    .drawings()
                    .items()
                    .iter()
                    .map(|drawing| drawing.to_value())
                    .collect(),
            ),
        ),
        (
            "undo",
            JsValue::Array(
                chart
                    .drawings()
                    .undo_stack()
                    .iter()
                    .map(|frame| {
                        JsValue::Array(frame.iter().map(|drawing| drawing.to_value()).collect())
                    })
                    .collect(),
            ),
        ),
        (
            "redo",
            JsValue::Array(
                chart
                    .drawings()
                    .redo_stack()
                    .iter()
                    .map(|frame| {
                        JsValue::Array(frame.iter().map(|drawing| drawing.to_value()).collect())
                    })
                    .collect(),
            ),
        ),
        (
            "selected",
            chart
                .drawings()
                .selected()
                .cloned()
                .map_or(JsValue::Null, JsValue::String),
        ),
        ("serial", JsValue::Number(chart.drawings().serial() as f64)),
    ]);
    let state = object(&[
        ("inspect", inspect),
        (
            "view",
            object(&[
                ("from", JsValue::Number(chart.model().view.from)),
                ("to", JsValue::Number(chart.model().view.to)),
            ]),
        ),
        ("follow", JsValue::Bool(chart.model().follow)),
        ("crosshair", crosshair),
        ("theme", chart.model().theme().clone()),
        (
            "symbol",
            chart.symbol_record().cloned().unwrap_or(JsValue::Null),
        ),
        ("tool", JsValue::String(input.tool().clone())),
        ("text", input.text().clone()),
        (
            "drawingTarget",
            input.drawing_target().cloned().unwrap_or(JsValue::Null),
        ),
        (
            "size",
            object(&[("width", publication.width), ("height", publication.height)]),
        ),
        ("drawings", drawings),
    ]);
    assert_wire(&state, field(&expected, "state"));
}

#[test]
fn ui_wrapper_failure_order_matches_node22() {
    let expected = oracle("failures");
    let (mut chart, input, size) = configured_chart();
    let mut source = NativeRuntime::new();
    let mut source_serial = 2.0;
    let bar = chart.data().store().at(2).unwrap();
    let event = object(&[
        ("kind", text("correction")),
        (
            "bar",
            object(&[
                ("time", JsValue::Number(bar.time)),
                ("open", JsValue::Number(bar.open)),
                (
                    "high",
                    JsValue::Number(js_max(&[bar.high, bar.close + 1.0])),
                ),
                ("low", JsValue::Number(bar.low)),
                ("close", JsValue::Number(bar.close + 1.0)),
                ("volume", JsValue::Number(bar.volume)),
            ]),
        ),
    ]);
    let event_text =
        JsString::from_str(&String::from_utf8(stringify_json(&event, JsonMode::Standard)).unwrap());
    let begin = runtime_call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeAsyncBegin",
        &[JsValue::String(event_text)],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();
    let missing = source
        .call(
            &key("nativeAsyncUINext"),
            std::slice::from_ref(&ticket),
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut source_serial,
            },
        )
        .err()
        .unwrap();
    assert_wire(&error_value(missing), field(&expected, "missingSource"));

    let mut target = NativeRuntime::new();
    let mut target_serial = 1.0;
    let missing = target
        .call(
            &key("nativeAsyncUIImportChunk"),
            &[text("{}")],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_wire(&error_value(missing), field(&expected, "targetMissing"));
    let unavailable = target
        .call(
            &key("nativeAsyncUIImportBegin"),
            &[text("{}")],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_wire(
        &error_value(unavailable),
        field(&expected, "targetUnavailable"),
    );
    empty_call(
        &mut target,
        &mut target_serial,
        "nativeAsyncCreate",
        &[field(&begin, "metadataJSON").clone()],
    );
    let bad = target
        .call(
            &key("nativeAsyncUIImportBegin"),
            &[text("{}")],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_wire(&error_value(bad), field(&expected, "badHeader"));
    let header = runtime_call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    empty_call(
        &mut target,
        &mut target_serial,
        "nativeAsyncUIImportBegin",
        std::slice::from_ref(&header),
    );
    let duplicate = target
        .call(
            &key("nativeAsyncUIImportBegin"),
            std::slice::from_ref(&header),
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_wire(&error_value(duplicate), field(&expected, "duplicateBegin"));
    let incomplete = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_wire(&error_value(incomplete), field(&expected, "incomplete"));
}

#[test]
fn ui_import_streams_before_ready_and_preserves_source_chunk_effects() {
    let (mut source_chart, source_input, source_size) = configured_chart();
    let mut source = NativeRuntime::new();
    let mut source_serial = 2.0;
    let begin = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":8,\"seed\":42,\"visibleBars\":6}",
        )],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();

    let mut target = NativeRuntime::new();
    let mut target_serial = 1.0;
    empty_call(
        &mut target,
        &mut target_serial,
        "nativePrepareCreate",
        &[field(&begin, "metadataJSON").clone()],
    );
    let header = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    empty_call(
        &mut target,
        &mut target_serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );

    let incomplete = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(
        incomplete.message.to_string_lossy(),
        "Async UI incomplete transfer"
    );

    let chunk = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUINext",
        std::slice::from_ref(&ticket),
    )
    .value;
    let original = parse(&string(&chunk));
    assert!(matches!(field(&original, "complete"), JsValue::Bool(false)));

    let mut bad_panel = original.clone();
    let JsValue::Object(packet) = &mut bad_panel else {
        unreachable!()
    };
    let JsValue::Array(records) = packet.get_mut(&key("records")).unwrap() else {
        unreachable!()
    };
    let JsValue::Object(record) = &mut records[0] else {
        unreachable!()
    };
    let JsValue::Object(drawing) = record.get_mut(&key("drawing")).unwrap() else {
        unreachable!()
    };
    drawing.insert(key("panel"), text("missing"));
    let bad_panel =
        text(&String::from_utf8(stringify_json(&bad_panel, JsonMode::Standard)).unwrap());
    let error = target
        .call(
            &key("nativeAsyncUIImportChunk"),
            &[bad_panel],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.message.to_string_lossy(), "Missing drawing panel");

    let mut partial = original.clone();
    let JsValue::Object(packet) = &mut partial else {
        unreachable!()
    };
    let JsValue::Array(records) = packet.get_mut(&key("records")).unwrap() else {
        unreachable!()
    };
    records.push(object(&[
        ("slot", JsValue::Number(1.0)),
        ("drawing", object(&[])),
    ]));
    let partial = text(&String::from_utf8(stringify_json(&partial, JsonMode::Standard)).unwrap());
    target
        .call(
            &key("nativeAsyncUIImportChunk"),
            &[partial],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();

    let original_retry =
        text(&String::from_utf8(stringify_json(&original, JsonMode::Standard)).unwrap());
    let error = target
        .call(
            &key("nativeAsyncUIImportChunk"),
            &[original_retry],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.message.to_string_lossy(), "Async UI record slot");

    let mut corrected = original;
    let JsValue::Object(packet) = &mut corrected else {
        unreachable!()
    };
    packet.insert(key("records"), JsValue::Array(Vec::new()));
    let corrected =
        text(&String::from_utf8(stringify_json(&corrected, JsonMode::Standard)).unwrap());
    empty_call(
        &mut target,
        &mut target_serial,
        "nativeAsyncUIImportChunk",
        &[corrected],
    );
    loop {
        let chunk = runtime_call(
            &mut source,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .value;
        if matches!(
            field(&parse(&string(&chunk)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
        empty_call(
            &mut target,
            &mut target_serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }

    let not_ready = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(
        not_ready.message.to_string_lossy(),
        "Async result not ready"
    );

    empty_call(&mut target, &mut target_serial, "nativeAsyncStart", &[]);
    loop {
        let progress = empty_call(
            &mut target,
            &mut target_serial,
            "nativeAsyncStep",
            &[JsValue::Number(4_096.0)],
        )
        .value;
        if matches!(
            field(&parse(&string(&progress)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
    }
    empty_call(
        &mut target,
        &mut target_serial,
        "nativeAsyncUIImportEnd",
        &[],
    );
    let publication = empty_call(&mut target, &mut target_serial, "nativeAsyncFinish", &[])
        .publication
        .expect("retry End publishes the prepared UI");
    assert_eq!(publication.chart.drawings().items().len(), 1);
}

#[test]
fn ui_import_rejects_serial_at_begin_and_consumes_a_success_once() {
    let (mut target, mut serial, header, chunks, _direct) = ready_prepare_ui_transfer(None);
    let invalid =
        header_with_drawing_field(&header, "serial", JsValue::Number(9_007_199_254_740_992.0));
    let error = target
        .call(
            &key("nativeAsyncUIImportBegin"),
            &[invalid],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.name, "RangeError");
    assert_eq!(error.message.to_string_lossy(), "Async drawing serial");

    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    for chunk in chunks {
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    empty_call(&mut target, &mut serial, "nativeAsyncUIImportEnd", &[]);
    let consumed = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(
        consumed.message.to_string_lossy(),
        "Async UI target missing"
    );
    let result = empty_call(&mut target, &mut serial, "nativeAsyncFinish", &[]);
    assert!(result.publication.is_some());
}

#[test]
fn ui_import_selection_error_is_identical_and_retryable() {
    let (mut target, mut serial, header, chunks, direct) = ready_prepare_ui_transfer(None);
    let header = header_with_drawing_field(&header, "selected", text("missing"));
    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    for chunk in chunks {
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    let mut errors = Vec::new();
    for _ in 0..2 {
        let error = target
            .call(
                &key("nativeAsyncUIImportEnd"),
                &[],
                RuntimeContext {
                    chart: None,
                    input: None,
                    size: None,
                    host: &NoZones,
                    next_store_serial: &mut serial,
                },
            )
            .err()
            .unwrap();
        errors.push(error_value(error));
    }
    assert_wire(&errors[0], &errors[1]);
    assert!(
        matches!(field(&errors[0], "name"), JsValue::String(value) if value == &key("TypeError"))
    );
    assert!(
        matches!(field(&errors[0], "message"), JsValue::String(value) if value == &key("Async selection"))
    );
    let result = empty_call(&mut target, &mut serial, "nativeAsyncFinish", &[direct]);
    assert!(result.publication.is_some());
}

#[test]
fn ui_import_finish_oom_retries_after_quota_is_freed() {
    const LIMIT: u64 = 64 * 1024 * 1024;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let (mut target, mut serial, header, chunks, _direct) = ready_prepare_ui_transfer(Some(memory));
    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    for chunk in chunks {
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    let remaining = LIMIT - account.snapshot().requested_live_bytes;
    let filler = account.reserve(remaining).unwrap();
    let error = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(filler);

    empty_call(&mut target, &mut serial, "nativeAsyncUIImportEnd", &[]);
    let result = empty_call(&mut target, &mut serial, "nativeAsyncFinish", &[]);
    let publication = result.publication.expect("OOM retry publication");
    drop((publication, target));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ui_finish_host_setup_oom_retries_after_quota_is_freed() {
    const LIMIT: u64 = 64 * 1024 * 1024;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let (mut target, mut serial, header, chunks, _direct) = ready_prepare_ui_transfer(Some(memory));
    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    for chunk in chunks {
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    empty_call(&mut target, &mut serial, "nativeAsyncUIImportEnd", &[]);

    let remaining = LIMIT - account.snapshot().requested_live_bytes;
    let filler = account.reserve(remaining).unwrap();
    let error = target
        .call(
            &key("nativeAsyncFinish"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(filler);

    let result = empty_call(&mut target, &mut serial, "nativeAsyncFinish", &[]);
    let publication = result
        .publication
        .expect("host setup OOM retry publication");
    drop((publication, target));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ui_import_attach_oom_keeps_the_taken_core_for_end_retry() {
    const LIMIT: u64 = 64 * 1024 * 1024;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let (mut source_chart, source_input, source_size) = configured_chart();
    let mut source = NativeRuntime::new();
    let mut source_serial = 2.0;
    let begin = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":8,\"seed\":42,\"visibleBars\":6}",
        )],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();
    let mut target = NativeRuntime::new_with_memory(memory);
    let mut serial = 1.0;
    empty_call(
        &mut target,
        &mut serial,
        "nativePrepareCreate",
        &[field(&begin, "metadataJSON").clone()],
    );
    let header = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    loop {
        let chunk = runtime_call(
            &mut source,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .value;
        if matches!(
            field(&parse(&string(&chunk)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    let not_ready = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(
        not_ready.message.to_string_lossy(),
        "Async result not ready"
    );
    empty_call(&mut target, &mut serial, "nativeAsyncStart", &[]);
    loop {
        let progress = empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncStep",
            &[JsValue::Number(4_096.0)],
        )
        .value;
        if matches!(
            field(&parse(&string(&progress)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
    }

    let remaining = LIMIT - account.snapshot().requested_live_bytes;
    let filler = account.reserve(remaining).unwrap();
    let error = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    drop(filler);

    empty_call(&mut target, &mut serial, "nativeAsyncUIImportEnd", &[]);
    let result = empty_call(&mut target, &mut serial, "nativeAsyncFinish", &[]);
    let publication = result.publication.expect("attach retry publication");
    drop((publication, target));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ui_import_defers_host_symbol_failure_from_end_to_finish_retry() {
    let expected = oracle("host-phase");
    let (mut target, mut serial, header, chunks, _direct) = ready_prepare_ui_transfer(None);
    let header = header_with_symbol_field(&header, "timezone", text("America/New_York"));
    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    for chunk in chunks {
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    let import_end = empty_call(&mut target, &mut serial, "nativeAsyncUIImportEnd", &[]).value;
    assert_wire(&import_end, field(&expected, "importEnd"));
    let mut errors = Vec::new();
    for _ in 0..2 {
        let error = target
            .call(
                &key("nativeAsyncFinish"),
                &[],
                RuntimeContext {
                    chart: None,
                    input: None,
                    size: None,
                    host: &NoZones,
                    next_store_serial: &mut serial,
                },
            )
            .err()
            .unwrap();
        errors.push(error_value(error));
    }
    assert_wire(&errors[0], &errors[1]);
    assert_wire(&errors[0], field(&expected, "firstFinish"));
    assert_wire(&errors[1], field(&expected, "secondFinish"));
}

#[test]
fn ui_import_matches_finish_phase_for_tool_text_and_drawing_target() {
    for (field_name, value, expected_name, expected_message) in [
        (
            "tool",
            text("missing-tool"),
            "Error",
            "Unknown drawing tool",
        ),
        (
            "text",
            JsValue::Number(1.0),
            "TypeError",
            "Drawing text, at most 2000 characters",
        ),
    ] {
        let (mut target, mut serial, header, chunks, _direct) = ready_prepare_ui_transfer(None);
        let header = header_with_state_field(&header, field_name, value);
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportBegin",
            &[header],
        );
        for chunk in chunks {
            empty_call(
                &mut target,
                &mut serial,
                "nativeAsyncUIImportChunk",
                &[chunk],
            );
        }
        empty_call(&mut target, &mut serial, "nativeAsyncUIImportEnd", &[]);
        let error = target
            .call(
                &key("nativeAsyncFinish"),
                &[],
                RuntimeContext {
                    chart: None,
                    input: None,
                    size: None,
                    host: &NoZones,
                    next_store_serial: &mut serial,
                },
            )
            .err()
            .unwrap();
        assert_eq!(error.name, expected_name);
        assert_eq!(error.message.to_string_lossy(), expected_message);
    }

    let (mut target, mut serial, header, chunks, _direct) = ready_prepare_ui_transfer(None);
    let header = header_with_state_field(
        &header,
        "drawingTarget",
        object(&[("panel", text("missing"))]),
    );
    empty_call(
        &mut target,
        &mut serial,
        "nativeAsyncUIImportBegin",
        &[header],
    );
    for chunk in chunks {
        empty_call(
            &mut target,
            &mut serial,
            "nativeAsyncUIImportChunk",
            &[chunk],
        );
    }
    let error = target
        .call(
            &key("nativeAsyncUIImportEnd"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.message.to_string_lossy(), "Missing drawing panel");
}

#[test]
fn direct_finish_host_failure_is_not_promoted_to_imported_ui_retry_state() {
    let (mut target, mut serial, _header, _chunks, direct) = ready_prepare_ui_transfer(None);
    let direct = direct_with_symbol_field(&direct, "timezone", text("America/New_York"));
    let first = target
        .call(
            &key("nativeAsyncFinish"),
            std::slice::from_ref(&direct),
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(
        first.message.to_string_lossy(),
        "Unsupported time zone: America/New_York"
    );
    let second = target
        .call(
            &key("nativeAsyncFinish"),
            &[direct],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
        )
        .err()
        .unwrap();
    assert_eq!(second.message.to_string_lossy(), "Async result not ready");
}

#[test]
fn finish_host_failure_keeps_the_engine_global_chart_unpublished() {
    let (mut source_chart, source_input, source_size) = configured_chart();
    let mut source = NativeRuntime::new();
    let mut source_serial = 2.0;
    let begin = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":8,\"seed\":42,\"visibleBars\":6}",
        )],
    )
    .value;
    let begin = parse(&string(&begin));
    let ticket = field(&begin, "ticket").clone();
    let header = runtime_call(
        &mut source,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .value;
    let header = header_with_symbol_field(&header, "timezone", text("America/New_York"));
    let mut chunks = Vec::new();
    loop {
        let chunk = runtime_call(
            &mut source,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .value;
        if matches!(
            field(&parse(&string(&chunk)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
        chunks.push(chunk);
    }

    let mut target = Engine::new(Box::new(NoZones));
    target.install_chart(chart(4)).unwrap();
    let old_identity = target.chart().unwrap().capture_identity();
    target
        .native_runtime_call(
            &key("nativePrepareCreate"),
            std::slice::from_ref(field(&begin, "metadataJSON")),
        )
        .unwrap();
    target
        .native_runtime_call(&key("nativeAsyncStart"), &[])
        .unwrap();
    loop {
        let progress = target
            .native_runtime_call(&key("nativeAsyncStep"), &[JsValue::Number(4_096.0)])
            .unwrap();
        if matches!(
            field(&parse(&string(&progress)), "complete"),
            JsValue::Bool(true)
        ) {
            break;
        }
    }
    target
        .native_runtime_call(&key("nativeAsyncUIImportBegin"), &[header])
        .unwrap();
    for chunk in chunks {
        target
            .native_runtime_call(&key("nativeAsyncUIImportChunk"), &[chunk])
            .unwrap();
    }
    target
        .native_runtime_call(&key("nativeAsyncUIImportEnd"), &[])
        .unwrap();
    for _ in 0..2 {
        let error = target
            .native_runtime_call(&key("nativeAsyncFinish"), &[])
            .unwrap_err();
        assert_eq!(
            error.message.to_string_lossy(),
            "Unsupported time zone: America/New_York"
        );
        let old = target.chart().expect("old global chart remains live");
        assert!(old.validate_identity(&old_identity));
        assert_eq!(old.data().store().length(), 4);
    }
}
