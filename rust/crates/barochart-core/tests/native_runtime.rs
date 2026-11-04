use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::interaction::OwnedInteractionState;
use barochart_core::native_chart::NativeChart;
use barochart_core::native_runtime::{NativeRuntime, RuntimeContext};
use barochart_core::workspace::{WorkspaceContext, WorkspaceInteraction, save_workspace};
use barochart_core::{Engine, Host, HostError, NativeSizeState};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::{NumberDialect, js_max};
use barochart_js::string::JsString;

const RUNTIME_ORACLE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-runtime.leaf.jsonl");

#[test]
fn scoped_runtime_output_lease_lives_through_serialization_scope() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let mut runtime = NativeRuntime::new_with_memory(memory.clone());
    let mut scope = memory.scope();
    let mut serial = 1.0;
    let result = runtime
        .call_scoped(
            &key("nativeReleaseDataIngestion"),
            &[],
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &mut scope,
        )
        .unwrap();
    assert!(result.output_memory.is_none());
    assert_eq!(
        stringify_json(&result.value, JsonMode::Standard),
        br#"{"cancelled":0,"pendingEvents":0,"ownedBytes":0}"#
    );
    assert!(scope.requested_bytes() > 0);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        scope.requested_bytes()
    );
    drop((result, scope));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ingestion_release_on_an_uninitialized_runtime_is_empty_and_does_not_create_a_chart() {
    let mut engine = Engine::new(Box::new(NoZones));
    for _ in 0..2 {
        let released = engine
            .native_runtime_call(&key("nativeReleaseDataIngestion"), &[])
            .unwrap();
        assert_eq!(
            stringify_json(&released, JsonMode::Standard),
            br#"{"cancelled":0,"pendingEvents":0,"ownedBytes":0}"#
        );
        assert!(engine.chart().is_none());
    }
}

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

fn optional<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array: {value:?}")
    };
    value
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number: {value:?}")
    };
    *value
}

fn string(value: &JsValue) -> JsString {
    let JsValue::String(value) = value else {
        panic!("string: {value:?}")
    };
    value.clone()
}

fn parse(text: &JsString) -> JsValue {
    parse_json(
        &text
            .as_units()
            .iter()
            .flat_map(|unit| {
                char::from_u32(u32::from(*unit))
                    .unwrap()
                    .to_string()
                    .into_bytes()
            })
            .collect::<Vec<_>>(),
        JsonMode::Standard,
    )
    .unwrap()
}

fn parse_str(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
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
    RUNTIME_ORACLE
        .lines()
        .skip(1)
        .map(parse_str)
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

fn size(width: f64, height: f64) -> NativeSizeState {
    let mut engine = Engine::new(Box::new(NoZones));
    engine
        .set_native_size(&JsValue::Number(width), &JsValue::Number(height))
        .unwrap();
    engine.native_size().unwrap().clone()
}

fn call(
    runtime: &mut NativeRuntime,
    chart: &mut NativeChart,
    input: &OwnedInteractionState,
    size: &NativeSizeState,
    serial: &mut f64,
    name: &str,
    args: &[JsValue],
) -> Result<JsValue, barochart_js::error::JsError> {
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
        .map(|result| result.value)
}

fn call_empty(
    runtime: &mut NativeRuntime,
    serial: &mut f64,
    name: &str,
    args: &[JsValue],
) -> Result<barochart_core::native_runtime::NativeRuntimeResult, barochart_js::error::JsError> {
    runtime.call(
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
}

fn error_value(error: barochart_js::error::JsError) -> JsValue {
    object(&[
        ("name", text(error.name)),
        ("message", JsValue::String(error.message)),
        ("code", error.code.map_or(JsValue::Null, |code| text(&code))),
    ])
}

fn begin_summary(value: &JsValue) -> JsValue {
    let begin = parse(&string(value));
    let metadata = parse(&string(field(&begin, "metadataJSON")));
    object(&[
        ("ticket", field(&begin, "ticket").clone()),
        ("buffers", field(&begin, "buffers").clone()),
        ("checkpoints", field(&begin, "checkpoints").clone()),
        (
            "metadata",
            object(&[
                ("schema", field(&metadata, "schema").clone()),
                (
                    "protocol",
                    optional(&metadata, "protocol")
                        .cloned()
                        .unwrap_or(JsValue::Null),
                ),
                (
                    "event",
                    optional(&metadata, "event")
                        .cloned()
                        .unwrap_or(JsValue::Null),
                ),
                (
                    "request",
                    optional(&metadata, "request")
                        .cloned()
                        .unwrap_or(JsValue::Null),
                ),
                (
                    "bufferLengths",
                    optional(&metadata, "bufferLengths")
                        .cloned()
                        .unwrap_or(JsValue::Null),
                ),
            ]),
        ),
    ])
}

fn workspace_step_summary(value: &JsValue) -> JsValue {
    let metadata_schema = optional(value, "metadataJSON")
        .map(string)
        .map(|text| field(&parse(&text), "schema").clone())
        .unwrap_or(JsValue::Null);
    object(&[
        ("phase", field(value, "phase").clone()),
        ("complete", field(value, "complete").clone()),
        (
            "ticket",
            optional(value, "ticket").cloned().unwrap_or(JsValue::Null),
        ),
        (
            "registration",
            optional(value, "registration")
                .cloned()
                .unwrap_or(JsValue::Null),
        ),
        (
            "buffers",
            optional(value, "buffers").cloned().unwrap_or(JsValue::Null),
        ),
        (
            "checkpoints",
            optional(value, "checkpoints")
                .cloned()
                .unwrap_or(JsValue::Null),
        ),
        (
            "plan",
            optional(value, "plan").cloned().unwrap_or(JsValue::Null),
        ),
        ("metadataSchema", metadata_schema),
    ])
}

fn params_step_summary(value: &JsValue) -> JsValue {
    let metadata_schema = optional(value, "metadataJSON")
        .map(string)
        .map(|text| field(&parse(&text), "schema").clone())
        .unwrap_or(JsValue::Null);
    object(&[
        ("phase", field(value, "phase").clone()),
        ("complete", field(value, "complete").clone()),
        ("metadataSchema", metadata_schema),
        (
            "plan",
            optional(value, "plan").cloned().unwrap_or(JsValue::Null),
        ),
    ])
}

#[test]
fn shared_source_slots_routing_and_ledgers_match_node22() {
    let expected = oracle("source-routing");
    let mut chart = chart(16);
    let input = OwnedInteractionState::new();
    let size = size(1200.0, 700.0);
    let mut serial = 2.0;
    let mut runtime = NativeRuntime::new();

    let binding = object(&[
        ("key", text("dataset")),
        ("revision", text("r1")),
        ("adjustmentVersion", text("a1")),
        ("priceUnit", text("USD")),
        ("adjustment", text("raw")),
    ]);
    let workspace = WorkspaceContext {
        host: &NoZones,
        model: chart.model(),
        store: chart.data().store(),
        indicators: chart.indicators(),
        drawings: chart.drawings(),
        symbol: None,
        symbol_formatters: false,
        interaction: WorkspaceInteraction::default(),
        dialect: NumberDialect::Ecma,
    };
    let workspace_text = save_workspace(&workspace, &binding, None).unwrap();
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
    let event_json =
        JsString::from_str(&String::from_utf8(stringify_json(&event, JsonMode::Standard)).unwrap());
    let async_value = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeAsyncBegin",
        &[JsValue::String(event_json)],
    )
    .unwrap();
    let async_summary = begin_summary(&async_value);
    assert_wire(&async_summary, field(&expected, "asyncBegin"));
    let ticket = field(&async_summary, "ticket").clone();
    let slice = runtime
        .read_f64(
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &ticket,
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(4.0),
        )
        .unwrap();
    assert_wire(
        &JsValue::Array(slice.iter().copied().map(JsValue::Number).collect()),
        field(&expected, "asyncSlice"),
    );
    let busy = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativePrepareBegin",
        &[text("{\"kind\":\"seeded\",\"count\":2}")],
    )
    .unwrap_err();
    assert_wire(&error_value(busy), field(&expected, "sourceBusy"));
    assert!(matches!(
        call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeAsyncRelease",
            &[JsValue::Number(999.0)],
        )
        .unwrap(),
        JsValue::Bool(true)
    ));
    assert!(matches!(
        call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeAsyncCheck",
            std::slice::from_ref(&ticket),
        )
        .unwrap(),
        JsValue::Bool(true)
    ));
    call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeAsyncRelease",
        std::slice::from_ref(&ticket),
    )
    .unwrap();

    let prepare_value = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":4,\"seed\":7,\"visibleBars\":3}",
        )],
    )
    .unwrap();
    let prepare_summary = begin_summary(&prepare_value);
    assert_wire(&prepare_summary, field(&expected, "prepareBegin"));
    let prepare_ticket = field(&prepare_summary, "ticket").clone();
    let prepare_buffer_error = runtime
        .read_f64(
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &prepare_ticket,
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
        )
        .unwrap_err();
    assert_wire(
        &error_value(prepare_buffer_error),
        field(&expected, "prepareBufferError"),
    );
    call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeAsyncRelease",
        std::slice::from_ref(&prepare_ticket),
    )
    .unwrap();

    let workspace_begin = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeWorkspaceSourceBegin",
        &[
            JsValue::String(workspace_text.clone()),
            binding.clone(),
            JsValue::Number(3.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(5.0),
        ],
    )
    .unwrap();
    assert_wire(&workspace_begin, field(&expected, "workspaceBegin"));
    let workspace_ticket = field(&workspace_begin, "ticket").clone();
    let mut workspace_rows = Vec::new();
    loop {
        let row = call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeWorkspaceSourceStep",
            &[
                workspace_ticket.clone(),
                JsValue::Number(64.0),
                JsValue::Number(3.0),
            ],
        )
        .unwrap();
        let complete = matches!(field(&row, "complete"), JsValue::Bool(true));
        workspace_rows.push(workspace_step_summary(&row));
        if complete {
            break;
        }
    }
    assert_wire(
        &JsValue::Array(workspace_rows),
        field(&expected, "workspaceRows"),
    );
    let slice = runtime
        .read_f64(
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &workspace_ticket,
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(4.0),
        )
        .unwrap();
    assert_wire(
        &JsValue::Array(slice.iter().copied().map(JsValue::Number).collect()),
        field(&expected, "workspaceSlice"),
    );
    let wrong_abort = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeWorkspaceSourceAbort",
        &[JsValue::Number(4.0)],
    )
    .unwrap();
    assert_wire(&wrong_abort, field(&expected, "workspaceWrongAbort"));
    let aborted = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeWorkspaceSourceAbort",
        &[JsValue::Number(5.0)],
    )
    .unwrap();
    assert_wire(&aborted, field(&expected, "workspaceAbort"));
    let missing = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeWorkspaceSourceCheck",
        &[workspace_ticket, JsValue::Number(3.0)],
    )
    .unwrap_err();
    assert_wire(&error_value(missing), field(&expected, "workspaceMissing"));
    let registration_error = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeWorkspaceSourceBegin",
        &[
            JsValue::String(workspace_text),
            binding,
            JsValue::Number(3.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(5.0),
        ],
    )
    .unwrap_err();
    assert_wire(
        &error_value(registration_error),
        field(&expected, "workspaceRegistrationError"),
    );

    let params_begin = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(9.0))]),
            JsValue::Number(7.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(6.0),
        ],
    )
    .unwrap();
    assert_wire(&params_begin, field(&expected, "paramsBegin"));
    let params_ticket = field(&params_begin, "ticket").clone();
    let mut params_rows = Vec::new();
    loop {
        let row = call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeParamsSourceStep",
            &[
                params_ticket.clone(),
                JsValue::Number(64.0),
                JsValue::Number(7.0),
            ],
        )
        .unwrap();
        let complete = matches!(field(&row, "complete"), JsValue::Bool(true));
        params_rows.push(params_step_summary(&row));
        if complete {
            break;
        }
    }
    assert_wire(&JsValue::Array(params_rows), field(&expected, "paramsRows"));
    let slice = runtime
        .read_f64(
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &params_ticket,
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(4.0),
        )
        .unwrap();
    assert_wire(
        &JsValue::Array(slice.iter().copied().map(JsValue::Number).collect()),
        field(&expected, "paramsSlice"),
    );
    let unarmed = runtime
        .target_f64(
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(1.0),
        )
        .unwrap_err();
    assert_wire(&error_value(unarmed), field(&expected, "unarmedWrite"));
    let active = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceStatus",
        &[JsValue::Number(6.0)],
    )
    .unwrap();
    assert_wire(&active, field(&expected, "paramsActive"));
    let aborted = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceAbort",
        &[JsValue::Number(6.0)],
    )
    .unwrap();
    assert_wire(&aborted, field(&expected, "paramsAbort"));
    for registration in 7..=11 {
        call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeParamsSourceBegin",
            &[
                text("ema"),
                object(&[("period", JsValue::Number(9.0))]),
                JsValue::Number(7.0),
                JsValue::Number(805_306_368.0),
                JsValue::Number(registration as f64),
            ],
        )
        .unwrap();
        call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeParamsSourceAbort",
            &[JsValue::Number(registration as f64)],
        )
        .unwrap();
    }
    let terminal = (7..=12)
        .map(|registration| {
            call(
                &mut runtime,
                &mut chart,
                &input,
                &size,
                &mut serial,
                "nativeParamsSourceStatus",
                &[JsValue::Number(registration as f64)],
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_wire(
        &JsValue::Array(terminal),
        field(&expected, "terminalStatuses"),
    );
}

#[test]
fn source_owner_identity_and_input_scalar_staleness_match_node22() {
    let expected = oracle("owner-staleness");
    let mut chart = chart(16);
    let mut input = OwnedInteractionState::new();
    let size_a = size(1200.0, 700.0);
    let size_b = size(641.0, 361.0);
    let size_c = size(642.0, 362.0);
    let mut serial = 2.0;
    let mut runtime = NativeRuntime::new();
    let binding = object(&[
        ("key", text("dataset")),
        ("revision", text("r1")),
        ("adjustmentVersion", text("a1")),
        ("priceUnit", text("USD")),
        ("adjustment", text("raw")),
    ]);
    let workspace = WorkspaceContext {
        host: &NoZones,
        model: chart.model(),
        store: chart.data().store(),
        indicators: chart.indicators(),
        drawings: chart.drawings(),
        symbol: None,
        symbol_formatters: false,
        interaction: WorkspaceInteraction::default(),
        dialect: NumberDialect::Ecma,
    };
    let workspace_text = save_workspace(&workspace, &binding, None).unwrap();

    let first = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_a,
        &mut serial,
        "nativeWorkspaceSourceBegin",
        &[
            JsValue::String(workspace_text.clone()),
            binding.clone(),
            JsValue::Number(1.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    let error = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_b,
        &mut serial,
        "nativeWorkspaceSourceCheck",
        &[field(&first, "ticket").clone(), JsValue::Number(1.0)],
    )
    .unwrap_err();
    assert_wire(&error_value(error), field(&expected, "sizeStale"));
    let abort = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_b,
        &mut serial,
        "nativeWorkspaceSourceAbort",
        &[JsValue::Number(1.0)],
    )
    .unwrap();
    assert_wire(&abort, field(&expected, "sizeAbort"));

    let second = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_b,
        &mut serial,
        "nativeWorkspaceSourceBegin",
        &[
            JsValue::String(workspace_text),
            binding,
            JsValue::Number(2.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(2.0),
        ],
    )
    .unwrap();
    input.set_text(&text("changed")).unwrap();
    let error = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_b,
        &mut serial,
        "nativeWorkspaceSourceCheck",
        &[field(&second, "ticket").clone(), JsValue::Number(2.0)],
    )
    .unwrap_err();
    assert_wire(&error_value(error), field(&expected, "toolStale"));
    assert_wire(
        &call(
            &mut runtime,
            &mut chart,
            &input,
            &size_b,
            &mut serial,
            "nativeWorkspaceSourceAbort",
            &[JsValue::Number(2.0)],
        )
        .unwrap(),
        field(&expected, "toolAbort"),
    );

    // The oracle's active-pointer Begin consumes workspace registration/ticket 3 before
    // constructor rejection. An invalid document exercises the same wrapper counter point.
    let _ = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_b,
        &mut serial,
        "nativeWorkspaceSourceBegin",
        &[
            text("{}"),
            object(&[
                ("key", text("dataset")),
                ("revision", text("r1")),
                ("adjustmentVersion", text("a1")),
                ("priceUnit", text("USD")),
                ("adjustment", text("raw")),
            ]),
            JsValue::Number(3.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(3.0),
        ],
    )
    .unwrap_err();

    let params = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_b,
        &mut serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(9.0))]),
            JsValue::Number(4.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(4.0),
        ],
    )
    .unwrap();
    let error = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_c,
        &mut serial,
        "nativeParamsSourceCheck",
        &[field(&params, "ticket").clone(), JsValue::Number(4.0)],
    )
    .unwrap_err();
    assert_wire(&error_value(error), field(&expected, "paramsStale"));
    let status = call(
        &mut runtime,
        &mut chart,
        &input,
        &size_c,
        &mut serial,
        "nativeParamsSourceStatus",
        &[JsValue::Number(4.0)],
    )
    .unwrap();
    assert_wire(&status, field(&expected, "paramsStatus"));
}

#[test]
fn target_busy_and_f64_priority_match_node22() {
    let expected = oracle("target-routing");

    let mut source_chart = chart(4);
    let source_input = OwnedInteractionState::new();
    let source_size = size(1200.0, 700.0);
    let mut source_serial = 2.0;
    let mut source_runtime = NativeRuntime::new();
    let begin = call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"columns\",\"length\":4,\"visibleBars\":3}",
        )],
    )
    .unwrap();
    let begin = parse(&string(&begin));
    let mut target_runtime = NativeRuntime::new();
    let mut target_serial = 1.0;
    let created = call_empty(
        &mut target_runtime,
        &mut target_serial,
        "nativePrepareCreate",
        &[field(&begin, "metadataJSON").clone()],
    )
    .unwrap()
    .value;
    assert_wire(&created, field(&expected, "prepareCreated"));
    let slice = target_runtime
        .target_f64(
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(2.0),
        )
        .unwrap();
    slice.copy_from_slice(&[1.0, 2.0]);
    assert_eq!(slice.len(), 2);
    let order = target_runtime
        .target_f64(
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut target_serial,
            },
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(1.0),
        )
        .unwrap_err();
    assert_wire(&error_value(order), field(&expected, "prepareOrder"));
    let busy = call_empty(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncCreate",
        &[field(&begin, "metadataJSON").clone()],
    )
    .err()
    .unwrap();
    assert_wire(&error_value(busy), field(&expected, "targetBusy"));

    let mut params_chart = chart(4);
    let params_input = OwnedInteractionState::new();
    let params_size = size(1200.0, 700.0);
    let mut params_source_serial = 2.0;
    let mut params_source = NativeRuntime::new();
    let params_begin = call(
        &mut params_source,
        &mut params_chart,
        &params_input,
        &params_size,
        &mut params_source_serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(3.0))]),
            JsValue::Number(5.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    let params_ticket = field(&params_begin, "ticket").clone();
    let admission = loop {
        let row = call(
            &mut params_source,
            &mut params_chart,
            &params_input,
            &params_size,
            &mut params_source_serial,
            "nativeParamsSourceStep",
            &[
                params_ticket.clone(),
                JsValue::Number(64.0),
                JsValue::Number(5.0),
            ],
        )
        .unwrap();
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break row;
        }
    };
    let metadata = parse(&string(field(&admission, "metadataJSON")));
    let length = number(field(&metadata, "length")) as usize;
    let mut params_target = NativeRuntime::new();
    let mut params_target_serial = 1.0;
    let created = call_empty(
        &mut params_target,
        &mut params_target_serial,
        "nativeParamsTargetCreate",
        &[field(&admission, "metadataJSON").clone()],
    )
    .unwrap()
    .value;
    assert_wire(&created, field(&expected, "paramsCreated"));
    for slot in 0..6 {
        let source = params_source
            .read_f64(
                RuntimeContext {
                    chart: Some(&mut params_chart),
                    input: Some(&params_input),
                    size: Some(&params_size),
                    host: &NoZones,
                    next_store_serial: &mut params_source_serial,
                },
                &params_ticket,
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(length as f64),
            )
            .unwrap()
            .to_vec();
        params_target
            .target_f64(
                RuntimeContext {
                    chart: None,
                    input: None,
                    size: None,
                    host: &NoZones,
                    next_store_serial: &mut params_target_serial,
                },
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(length as f64),
            )
            .unwrap()
            .copy_from_slice(&source);
    }
    let started = call_empty(
        &mut params_target,
        &mut params_target_serial,
        "nativeParamsTargetStart",
        &[],
    )
    .unwrap()
    .value;
    assert_wire(&started, field(&expected, "paramsStart"));
    let mut steps = Vec::new();
    loop {
        let row = call_empty(
            &mut params_target,
            &mut params_target_serial,
            "nativeParamsTargetStep",
            &[JsValue::Number(4.0)],
        )
        .unwrap()
        .value;
        let complete = matches!(field(&row, "complete"), JsValue::Bool(true));
        steps.push(row);
        if complete {
            break;
        }
    }
    assert_wire(&JsValue::Array(steps), field(&expected, "steps"));
    let output = params_target
        .read_f64(
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut params_target_serial,
            },
            &JsValue::Number(1.0),
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(2.0),
        )
        .unwrap();
    assert_wire(
        &JsValue::Array(output.iter().copied().map(JsValue::Number).collect()),
        field(&expected, "output"),
    );
    let wrong = params_target
        .read_f64(
            RuntimeContext {
                chart: None,
                input: None,
                size: None,
                host: &NoZones,
                next_store_serial: &mut params_target_serial,
            },
            &JsValue::Number(2.0),
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(1.0),
        )
        .unwrap_err();
    assert_wire(&error_value(wrong), field(&expected, "wrongRegistration"));
    let disposed = call_empty(
        &mut params_target,
        &mut params_target_serial,
        "nativeParamsTargetDispose",
        &[],
    )
    .unwrap()
    .value;
    assert_wire(&disposed, field(&expected, "paramsDisposed"));

    let mut live_chart = chart(0);
    let live_input = OwnedInteractionState::new();
    let live_size = size(1200.0, 700.0);
    let mut live_serial = 2.0;
    let mut live_runtime = NativeRuntime::new();
    let vacancy = call(
        &mut live_runtime,
        &mut live_chart,
        &live_input,
        &live_size,
        &mut live_serial,
        "nativeWorkspaceTargetCreate",
        &[text("{}")],
    )
    .unwrap_err();
    assert_wire(&error_value(vacancy), field(&expected, "workspaceVacancy"));
}

#[test]
fn workspace_target_finish_returns_owned_atomic_publication() {
    let mut source_chart = chart(8);
    let source_input = OwnedInteractionState::new();
    let source_size = size(1200.0, 700.0);
    let mut source_serial = 2.0;
    let mut source_runtime = NativeRuntime::new();
    let binding = object(&[
        ("key", text("dataset")),
        ("revision", text("r1")),
        ("adjustmentVersion", text("a1")),
        ("priceUnit", text("USD")),
        ("adjustment", text("raw")),
    ]);
    let workspace = WorkspaceContext {
        host: &NoZones,
        model: source_chart.model(),
        store: source_chart.data().store(),
        indicators: source_chart.indicators(),
        drawings: source_chart.drawings(),
        symbol: None,
        symbol_formatters: false,
        interaction: WorkspaceInteraction::default(),
        dialect: NumberDialect::Ecma,
    };
    let document = save_workspace(&workspace, &binding, None).unwrap();
    let begin = call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeWorkspaceSourceBegin",
        &[
            JsValue::String(document),
            binding,
            JsValue::Number(9.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    let ticket = field(&begin, "ticket").clone();
    let ready = loop {
        let row = call(
            &mut source_runtime,
            &mut source_chart,
            &source_input,
            &source_size,
            &mut source_serial,
            "nativeWorkspaceSourceStep",
            &[ticket.clone(), JsValue::Number(64.0), JsValue::Number(9.0)],
        )
        .unwrap();
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break row;
        }
    };
    let metadata = field(&ready, "metadataJSON").clone();
    let mut target_runtime = NativeRuntime::new();
    let mut target_serial = 1.0;
    assert!(matches!(
        call_empty(
            &mut target_runtime,
            &mut target_serial,
            "nativeWorkspaceTargetCreate",
            &[metadata],
        )
        .unwrap()
        .value,
        JsValue::Bool(true)
    ));
    for slot in 0..6 {
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
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(8.0),
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
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(8.0),
            )
            .unwrap()
            .copy_from_slice(&values);
    }
    let finish_source = call(
        &mut source_runtime,
        &mut source_chart,
        &source_input,
        &source_size,
        &mut source_serial,
        "nativeWorkspaceSourceFinish",
        &[ticket, JsValue::Number(9.0)],
    )
    .unwrap();
    assert!(
        matches!(field(&finish_source, "schema"), JsValue::String(value) if value == &key("aster.native-workspace-source-finished"))
    );
    call_empty(
        &mut target_runtime,
        &mut target_serial,
        "nativeAsyncStart",
        &[],
    )
    .unwrap();
    loop {
        let row = call_empty(
            &mut target_runtime,
            &mut target_serial,
            "nativeAsyncStep",
            &[JsValue::Number(8.0)],
        )
        .unwrap()
        .value;
        let row = parse(&string(&row));
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    let result = call_empty(
        &mut target_runtime,
        &mut target_serial,
        "nativeWorkspaceTargetFinish",
        &[],
    )
    .unwrap();
    assert!(
        matches!(field(&result.value, "status"), JsValue::String(value) if value == &key("target-ready"))
    );
    let publication = result.publication.expect("workspace publication");
    assert_eq!(publication.chart.data().store().length(), 8);
    assert_eq!(publication.chart.model().series.len(), 3);
    assert_eq!(publication.input.pointer_count(), 0);
    assert!(matches!(publication.width, JsValue::Number(1200.0)));
    assert!(matches!(publication.height, JsValue::Number(700.0)));
}

#[test]
fn params_publication_is_single_handoff_and_durable_in_status_ledger() {
    const LIMIT: u64 = 1_000_000;
    const OUTPUT_HEADROOM: u64 = 256;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let mut chart = chart_with_memory(8, memory.clone());
    let input = OwnedInteractionState::new_with_memory(memory.clone()).unwrap();
    let size = size(1200.0, 700.0);
    let mut source_serial = 2.0;
    let mut source = NativeRuntime::new_with_memory(memory.clone());
    let ledger = source.params_ledger();
    let begin = call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(3.0))]),
            JsValue::Number(12.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    let ticket = field(&begin, "ticket").clone();
    let admission = loop {
        let row = call(
            &mut source,
            &mut chart,
            &input,
            &size,
            &mut source_serial,
            "nativeParamsSourceStep",
            &[ticket.clone(), JsValue::Number(8.0), JsValue::Number(12.0)],
        )
        .unwrap();
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break row;
        }
    };
    let metadata = parse(&string(field(&admission, "metadataJSON")));
    let length = number(field(&metadata, "length")) as usize;
    let mut target = NativeRuntime::new();
    let mut target_serial = 1.0;
    call_empty(
        &mut target,
        &mut target_serial,
        "nativeParamsTargetCreate",
        &[field(&admission, "metadataJSON").clone()],
    )
    .unwrap();
    for slot in 0..6 {
        let values = source
            .read_f64(
                RuntimeContext {
                    chart: Some(&mut chart),
                    input: Some(&input),
                    size: Some(&size),
                    host: &NoZones,
                    next_store_serial: &mut source_serial,
                },
                &ticket,
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(length as f64),
            )
            .unwrap()
            .to_vec();
        target
            .target_f64(
                RuntimeContext {
                    chart: None,
                    input: None,
                    size: None,
                    host: &NoZones,
                    next_store_serial: &mut target_serial,
                },
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(length as f64),
            )
            .unwrap()
            .copy_from_slice(&values);
    }
    call_empty(
        &mut target,
        &mut target_serial,
        "nativeParamsTargetStart",
        &[],
    )
    .unwrap();
    loop {
        let row = call_empty(
            &mut target,
            &mut target_serial,
            "nativeParamsTargetStep",
            &[JsValue::Number(4.0)],
        )
        .unwrap()
        .value;
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    let descriptor_text = call_empty(
        &mut target,
        &mut target_serial,
        "nativeParamsTargetDescriptor",
        &[],
    )
    .unwrap()
    .value;
    let descriptor = parse(&string(&descriptor_text));
    call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeParamsSourceReceive",
        &[ticket.clone(), descriptor_text, JsValue::Number(12.0)],
    )
    .unwrap();
    let capacity = number(field(&descriptor, "capacity")) as usize;
    let outputs = array(field(&descriptor, "outputs")).len();
    for slot in 0..outputs {
        let values = target
            .read_f64(
                RuntimeContext {
                    chart: None,
                    input: None,
                    size: None,
                    host: &NoZones,
                    next_store_serial: &mut target_serial,
                },
                &JsValue::Number(1.0),
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(capacity as f64),
            )
            .unwrap()
            .to_vec();
        call(
            &mut source,
            &mut chart,
            &input,
            &size,
            &mut source_serial,
            "nativeParamsSourceArmWrite",
            &[
                ticket.clone(),
                JsValue::Number(slot as f64),
                JsValue::Number(0.0),
                JsValue::Number(capacity as f64),
                JsValue::Number(12.0),
            ],
        )
        .unwrap();
        source
            .target_f64(
                RuntimeContext {
                    chart: Some(&mut chart),
                    input: Some(&input),
                    size: Some(&size),
                    host: &NoZones,
                    next_store_serial: &mut source_serial,
                },
                &JsValue::Number(slot as f64),
                &JsValue::Number(0.0),
                &JsValue::Number(capacity as f64),
            )
            .unwrap()
            .copy_from_slice(&values);
    }
    let checkpoints = number(field(&descriptor, "checkpointCount")) as usize;
    for ordinal in 0..checkpoints {
        let row = call_empty(
            &mut target,
            &mut target_serial,
            "nativeParamsTargetCheckpoint",
            &[JsValue::Number(ordinal as f64)],
        )
        .unwrap()
        .value;
        call(
            &mut source,
            &mut chart,
            &input,
            &size,
            &mut source_serial,
            "nativeParamsSourceCheckpoint",
            &[
                ticket.clone(),
                field(&row, "index").clone(),
                field(&row, "text").clone(),
                JsValue::Number(12.0),
            ],
        )
        .unwrap();
    }
    loop {
        let row = call(
            &mut source,
            &mut chart,
            &input,
            &size,
            &mut source_serial,
            "nativeParamsSourceValidate",
            &[
                ticket.clone(),
                JsValue::Number(16_384.0),
                JsValue::Number(12.0),
            ],
        )
        .unwrap();
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    call_empty(
        &mut target,
        &mut target_serial,
        "nativeParamsTargetDispose",
        &[],
    )
    .unwrap();
    call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeParamsSourcePrepare",
        &[ticket.clone(), JsValue::Number(12.0)],
    )
    .unwrap();
    let filler = account
        .reserve(LIMIT - account.snapshot().requested_live_bytes - OUTPUT_HEADROOM)
        .unwrap();
    let mut publish_scope = memory.scope();
    let error = match source.call_scoped(
        &key("nativeParamsSourcePublish"),
        &[ticket, JsValue::Number(12.0)],
        RuntimeContext {
            chart: Some(&mut chart),
            input: Some(&input),
            size: Some(&size),
            host: &NoZones,
            next_store_serial: &mut source_serial,
        },
        &mut publish_scope,
    ) {
        Ok(_) => panic!("publish output unexpectedly fit the denied FFI scope"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_deref(), Some("__BAROCHART_OOM_LIMIT__"));
    assert!(
        matches!(chart.indicators().entry(&text("ema")).unwrap().params(), JsValue::Object(params) if matches!(params.get(&key("period")), Some(JsValue::Number(3.0))))
    );
    drop((publish_scope, filler));
    let published = call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeParamsSourceStatus",
        &[JsValue::Number(1.0)],
    )
    .unwrap();
    assert!(
        matches!(field(&published, "status"), JsValue::String(value) if value == &key("committed"))
    );
    let status = call(
        &mut source,
        &mut chart,
        &input,
        &size,
        &mut source_serial,
        "nativeParamsSourceStatus",
        &[JsValue::Number(1.0)],
    )
    .unwrap();
    assert_wire(&status, &published);
    assert!(
        matches!(chart.indicators().entry(&text("ema")).unwrap().params(), JsValue::Object(params) if matches!(params.get(&key("period")), Some(JsValue::Number(3.0))))
    );
    let with_receipt = account.snapshot().requested_live_bytes;
    assert!(with_receipt > 0);
    ledger.poison();
    let committed = ledger.status(&JsValue::Number(1.0)).unwrap();
    assert_wire(&committed, &published);

    for registration in 2..=5 {
        let begin = call(
            &mut source,
            &mut chart,
            &input,
            &size,
            &mut source_serial,
            "nativeParamsSourceBegin",
            &[
                text("ema"),
                object(&[("period", JsValue::Number(3.0))]),
                JsValue::Number(12.0),
                JsValue::Number(805_306_368.0),
                JsValue::Number(registration as f64),
            ],
        )
        .unwrap();
        assert!(matches!(field(&begin, "phase"), JsValue::String(_)));
        call(
            &mut source,
            &mut chart,
            &input,
            &size,
            &mut source_serial,
            "nativeParamsSourceAbort",
            &[JsValue::Number(registration as f64)],
        )
        .unwrap();
        if registration < 5 {
            assert_eq!(account.snapshot().requested_live_bytes, with_receipt);
        }
    }
    assert!(account.snapshot().requested_live_bytes < with_receipt);
    assert!(matches!(
        ledger.status(&JsValue::Number(1.0)).unwrap(),
        JsValue::Null
    ));
    drop((ledger, source, chart, input));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn params_ledger_answers_poison_cleanup_without_core_state() {
    let mut chart = chart(4);
    let input = OwnedInteractionState::new();
    let size = size(1200.0, 700.0);
    let mut serial = 2.0;
    let mut runtime = NativeRuntime::new();
    let ledger = runtime.params_ledger();
    call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(3.0))]),
            JsValue::Number(1.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    ledger.poison();
    let active = ledger.status(&JsValue::Number(1.0)).unwrap();
    assert!(matches!(field(&active, "status"), JsValue::String(value) if value == &key("failed")));
    let synthetic = ledger.status(&JsValue::Number(2.0)).unwrap();
    assert!(matches!(field(&synthetic, "ticket"), JsValue::Number(0.0)));
    assert!(
        matches!(field(&synthetic, "status"), JsValue::String(value) if value == &key("failed"))
    );
}

#[test]
fn malformed_arm_write_fails_before_registration_and_drops_the_row() {
    let expected = oracle("params-arm-error");
    let mut chart = chart(4);
    let input = OwnedInteractionState::new();
    let size = size(1200.0, 700.0);
    let mut serial = 2.0;
    let mut runtime = NativeRuntime::new();
    let begin = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(3.0))]),
            JsValue::Number(1.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    let ticket = field(&begin, "ticket").clone();
    loop {
        let row = call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeParamsSourceStep",
            &[ticket.clone(), JsValue::Number(64.0), JsValue::Number(1.0)],
        )
        .unwrap();
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    let error = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceArmWrite",
        &[
            ticket,
            JsValue::Number(99.0),
            JsValue::Number(0.0),
            JsValue::Number(1.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap_err();
    assert_wire(&error_value(error), field(&expected, "invalid"));
    let status = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceStatus",
        &[JsValue::Number(1.0)],
    )
    .unwrap();
    assert_wire(&status, field(&expected, "status"));

    let second = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceBegin",
        &[
            text("ema"),
            object(&[("period", JsValue::Number(3.0))]),
            JsValue::Number(1.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(2.0),
        ],
    )
    .unwrap();
    let ticket = field(&second, "ticket").clone();
    loop {
        let row = call(
            &mut runtime,
            &mut chart,
            &input,
            &size,
            &mut serial,
            "nativeParamsSourceStep",
            &[ticket.clone(), JsValue::Number(64.0), JsValue::Number(1.0)],
        )
        .unwrap();
        if matches!(field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    let armed = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceArmWrite",
        &[
            ticket,
            JsValue::Number(0.0),
            JsValue::Number(0.0),
            JsValue::Number(1.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    assert_wire(&armed, field(&expected, "validArm"));
    let error = runtime
        .target_f64(
            RuntimeContext {
                chart: Some(&mut chart),
                input: Some(&input),
                size: Some(&size),
                host: &NoZones,
                next_store_serial: &mut serial,
            },
            &JsValue::Number(0.0),
            &JsValue::Number(0.0),
            &JsValue::Number(1.0),
        )
        .unwrap_err();
    assert_wire(&error_value(error), field(&expected, "invalidWrite"));
    let status = call(
        &mut runtime,
        &mut chart,
        &input,
        &size,
        &mut serial,
        "nativeParamsSourceStatus",
        &[JsValue::Number(2.0)],
    )
    .unwrap();
    assert_wire(&status, field(&expected, "status2"));
}
