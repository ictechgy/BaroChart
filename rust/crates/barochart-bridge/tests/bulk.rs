use std::fmt::Write;
use std::time::Instant;

use barochart_bridge::bulk::{
    BulkCall, BulkDecode, BulkFailure, BulkLength, BulkRoute, decode_bulk_call,
};
use barochart_js::json::{
    JsObject, JsValue, JsonMode, parse_json, parse_json_with, stringify_json,
};
use barochart_js::memory::{MemoryAccount, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

const NODE_FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/native-bulk.leaf.jsonl");

fn decode(
    function: &str,
    text: &[u8],
    mode: JsonMode,
    scope: &mut MemoryScope,
) -> Result<Option<BulkDecode>, BulkFailure> {
    decode_bulk_call(function, text, mode, NumberDialect::Ecma, scope)
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object required")
    };
    value
}

fn get<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    object(value)
        .get(&JsString::from_str(key))
        .unwrap_or_else(|| panic!("missing {key}"))
}

fn string(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string required")
    };
    value.to_string_lossy()
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required")
    };
    *value
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array required")
    };
    value
}

#[test]
fn legacy_set_data_decodes_escaped_duplicate_keys_and_ignores_extras() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let text = br#"[[{"ti\u006de":0,"time":1,"open":2,"high":4,"low":1,"close":3,"volume":5,"extra":{"deep":[1,2,3]}}],{"ignored":true}]"#;
    let decoded = decode("nativeSetData", text, JsonMode::Standard, &mut scope)
        .unwrap()
        .expect("eligible legacy setData");
    let BulkDecode::Call(BulkCall::SetData { route, columns }) = decoded else {
        panic!("setData call required")
    };
    assert_eq!(route, BulkRoute::LegacySetData);
    assert_eq!(columns.time, [1.0]);
    assert_eq!(columns.open, [2.0]);
    assert_eq!(columns.high, [4.0]);
    assert_eq!(columns.low, [1.0]);
    assert_eq!(columns.close, [3.0]);
    assert_eq!(columns.volume, [5.0]);
}

#[test]
fn command_set_columns_keeps_full_arrays_null_gaps_and_last_duplicate() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let text = br#"["set\u0043olumns",[{"ti\u006de":[1,2,99],"open":[2,3,99],"high":[4,5,99],"low":[1,2,99],"close":[999],"close":[3,4,null],"volume":[5,6,99],"ignored":{"x":1}},2],"outer-extra"]"#;
    let decoded = decode("nativeCommand", text, JsonMode::Standard, &mut scope)
        .unwrap()
        .expect("eligible command setColumns");
    let BulkDecode::Call(BulkCall::SetColumns { columns, length }) = decoded else {
        panic!("setColumns call required")
    };
    assert_eq!(length, BulkLength::Number(2.0));
    assert_eq!(columns.time, [1.0, 2.0, 99.0]);
    assert_eq!(columns.close[..2], [3.0, 4.0]);
    assert!(columns.close[2].is_nan());
    assert_eq!(columns.volume, [5.0, 6.0, 99.0]);
}

#[test]
fn set_columns_field_validation_precedes_later_column_reservation_oom() {
    let tail = std::iter::repeat_n("0", 128).collect::<Vec<_>>().join(",");
    let text = format!(
        "[\"setColumns\",[{{\"time\":[1e400],\"open\":[{tail}],\"high\":[{tail}],\"low\":[{tail}],\"close\":[{tail}],\"volume\":[{tail}]}},1]]"
    );
    let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let decoded = decode(
        "nativeCommand",
        text.as_bytes(),
        JsonMode::Standard,
        &mut scope,
    )
    .unwrap()
    .unwrap();
    let BulkDecode::DeferredError { error, .. } = decoded else {
        panic!("time-column validation error must precede later reserves")
    };
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message.to_string_lossy(),
        "Finite numbers or null gaps required"
    );
}

#[test]
fn late_syntax_error_wins_before_route_or_data_validation() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let invalid = br#"["setData",[[{"time":1}]],]"#;
    let Err(BulkFailure::Syntax { position }) =
        decode("nativeCommand", invalid, JsonMode::Standard, &mut scope)
    else {
        panic!("late syntax error required")
    };
    assert!(position >= invalid.len() - 2);
}

#[test]
fn command_arity_error_is_deferred_for_receiver_gate() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let decoded = decode(
        "nativeCommand",
        br#"["setData",[[],1]]"#,
        JsonMode::Standard,
        &mut scope,
    )
    .unwrap()
    .expect("recognized command");
    let BulkDecode::DeferredError { route, error } = decoded else {
        panic!("deferred arity error required")
    };
    assert_eq!(route, BulkRoute::CommandSetData);
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message.to_string_lossy(),
        "Chart command argument count"
    );
}

#[test]
fn unsupported_event_and_coercive_shapes_fall_back_before_mutation() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    assert!(
        decode(
            "nativeCommand",
            br#"["applyDataEvent",[{"kind":"append","bar":{"time":1}}]]"#,
            JsonMode::Standard,
            &mut scope,
        )
        .unwrap()
        .is_none()
    );
    assert!(
        decode(
            "nativeSetData",
            br#"[[{"time":"1","open":2,"high":3,"low":1,"close":2,"volume":4}]]"#,
            JsonMode::Standard,
            &mut scope,
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn typed_column_growth_is_scoped_fallible_and_releases_on_failure() {
    let text = format!(
        "[[{}]]",
        (0..128)
            .map(|index| format!(
                "{{\"time\":{index},\"open\":1,\"high\":2,\"low\":0,\"close\":1,\"volume\":1}}"
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    let account = MemoryAccount::new(256, OomStyle::InternalErrorLowercase);
    {
        let mut scope = MemoryScope::new(&account);
        let Err(BulkFailure::Memory(failure)) = decode(
            "nativeSetData",
            text.as_bytes(),
            JsonMode::Standard,
            &mut scope,
        ) else {
            panic!("scoped memory failure required")
        };
        assert_eq!(failure.style(), OomStyle::InternalErrorLowercase);
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn lossless_special_values_do_not_get_approximated_by_the_typed_lane() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let text = br#"[[{"time":1,"open":NaN,"high":2,"low":0,"close":1,"volume":1}]]"#;
    assert!(
        decode("nativeSetData", text, JsonMode::Lossless, &mut scope)
            .unwrap()
            .is_none()
    );

    // The generic fallback remains the source of the exact lossless behavior.
    let parsed = barochart_js::json::parse_json(text, JsonMode::Lossless).unwrap();
    assert!(!stringify_json(&parsed, JsonMode::Lossless).is_empty());
}

#[test]
fn syntax_pass_agrees_with_the_kernel_on_valid_invalid_and_utf8_corpus() {
    let cases: &[(&[u8], JsonMode)] = &[
        (b"null", JsonMode::Standard),
        (
            br#"[{"a":[1,-0,1e400,"x\uD800",true,false,null]}]"#,
            JsonMode::Standard,
        ),
        (r#"["한😀\u2028"]"#.as_bytes(), JsonMode::Standard),
        (b"[NaN,Infinity,-Infinity,undefined]", JsonMode::Lossless),
        (b"[1,]", JsonMode::Standard),
        (b"{\"a\":1,}", JsonMode::Standard),
        (b"[01]", JsonMode::Standard),
        (b"[1e+]", JsonMode::Standard),
        (b"[\"\\u12g4\"]", JsonMode::Standard),
        (b"[\"\xff\"]", JsonMode::Standard),
        (b"[NaN]", JsonMode::Standard),
        (b"[undefinedx]", JsonMode::Lossless),
        (b"[[[[[[0]]]]]] trailing", JsonMode::Standard),
    ];
    for &(text, mode) in cases {
        let kernel_valid = parse_json(text, mode).is_ok();
        let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let mut scope = MemoryScope::new(&account);
        let bulk = decode("not-a-bulk-function", text, mode, &mut scope);
        assert_eq!(
            !matches!(bulk, Err(BulkFailure::Syntax { .. })),
            kernel_valid,
            "mode={mode:?} text={:?}",
            String::from_utf8_lossy(text)
        );
    }
}

#[test]
fn numeric_values_use_the_selected_kernel_dialect_bit_exactly() {
    const NUMBER: &str = "1.00000000000000011102230246251565404236316680908203125001";
    let text = format!(
        "[[{{\"time\":1,\"open\":{NUMBER},\"high\":2,\"low\":0,\"close\":1,\"volume\":1}}]]"
    );
    let decode_open = |dialect| {
        let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
        let mut scope = MemoryScope::new(&account);
        let decoded = decode_bulk_call(
            "nativeSetData",
            text.as_bytes(),
            JsonMode::Standard,
            dialect,
            &mut scope,
        )
        .unwrap()
        .unwrap();
        let BulkDecode::Call(BulkCall::SetData { columns, .. }) = decoded else {
            panic!("setData")
        };
        columns.open[0].to_bits()
    };
    assert_eq!(
        decode_open(NumberDialect::Ecma),
        parse_json_with(NUMBER.as_bytes(), JsonMode::Standard, NumberDialect::Ecma,)
            .and_then(|value| match value {
                barochart_js::json::JsValue::Number(value) => Ok(value.to_bits()),
                _ => unreachable!(),
            })
            .unwrap()
    );
    assert_ne!(
        decode_open(NumberDialect::Ecma),
        decode_open(NumberDialect::QuickJs)
    );
}

#[test]
fn decoder_matches_current_node_source_fixture() {
    let mut lines = NODE_FIXTURE.lines();
    let header = parse_json(
        lines.next().expect("fixture header").as_bytes(),
        JsonMode::Standard,
    )
    .unwrap();
    assert_eq!(string(get(&header, "schema")), "barochart.native-bulk-leaf");
    let mut cases = 0;
    for line in lines {
        let row = parse_json(line.as_bytes(), JsonMode::Standard).unwrap();
        let id = string(get(&row, "id"));
        let function = string(get(&row, "function"));
        let text = string(get(&row, "text"));
        let outcome = string(get(&row, "outcome"));
        let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
        let mut scope = MemoryScope::new(&account);
        let decoded = decode(&function, text.as_bytes(), JsonMode::Standard, &mut scope);
        match outcome.as_str() {
            "syntax" => assert!(matches!(decoded, Err(BulkFailure::Syntax { .. })), "{id}"),
            "error" => {
                let BulkDecode::DeferredError { error, .. } =
                    decoded.unwrap().unwrap_or_else(|| panic!("fallback {id}"))
                else {
                    panic!("deferred error {id}")
                };
                let expected = get(&row, "error");
                assert_eq!(error.name, string(get(expected, "name")), "{id}");
                assert_eq!(
                    error.message.to_string_lossy(),
                    string(get(expected, "message")),
                    "{id}"
                );
            }
            "ok" => {
                let BulkDecode::Call(call) =
                    decoded.unwrap().unwrap_or_else(|| panic!("fallback {id}"))
                else {
                    panic!("call {id}")
                };
                let columns = match &call {
                    BulkCall::SetData { columns, .. } | BulkCall::SetColumns { columns, .. } => {
                        columns
                    }
                };
                let state = get(&row, "state");
                let length = number(get(state, "length")) as usize;
                let expected = get(state, "columns");
                for (name, actual) in [
                    ("time", &columns.time),
                    ("open", &columns.open),
                    ("high", &columns.high),
                    ("low", &columns.low),
                    ("close", &columns.close),
                    ("volume", &columns.volume),
                ] {
                    let expected: Vec<_> = array(get(expected, name)).iter().map(number).collect();
                    assert_eq!(&actual[..length], expected, "{id} {name}");
                }
            }
            _ => panic!("outcome {id}"),
        }
        cases += 1;
    }
    assert_eq!(cases, 5);
}

#[test]
#[ignore = "large Phase B acceptance: run explicitly"]
fn million_set_data_stages_six_columns_without_jsvalue_scalar_expansion() {
    const ROWS: usize = 1_000_000;
    let mut text = String::new();
    text.try_reserve(76 * ROWS).unwrap();
    text.push_str("[[");
    for index in 0..ROWS {
        if index != 0 {
            text.push(',');
        }
        write!(
            text,
            "{{\"time\":{index},\"open\":1,\"high\":2,\"low\":0,\"close\":1,\"volume\":1}}"
        )
        .unwrap();
    }
    text.push_str("]]");
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let started = Instant::now();
    {
        let mut scope = MemoryScope::new(&account);
        let decoded = decode(
            "nativeSetData",
            text.as_bytes(),
            JsonMode::Standard,
            &mut scope,
        )
        .unwrap()
        .unwrap();
        let BulkDecode::Call(BulkCall::SetData { columns, .. }) = decoded else {
            panic!("setData")
        };
        assert_eq!(columns.time.len(), ROWS);
        assert_eq!(columns.time[0], 0.0);
        assert_eq!(columns.time[ROWS - 1], (ROWS - 1) as f64);
        assert_eq!(columns.volume[ROWS - 1], 1.0);
        assert!(
            scope.requested_bytes() < 128 * 1024 * 1024,
            "{} bytes",
            scope.requested_bytes()
        );
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
    eprintln!(
        "1M setData: input={} bytes elapsed={:?} peak={} bytes",
        text.len(),
        started.elapsed(),
        account.snapshot().requested_peak_bytes
    );
}

#[test]
#[ignore = "large Phase B acceptance: run explicitly"]
fn two_million_set_columns_stages_12m_f64_without_jsvalue_scalar_expansion() {
    const ROWS: usize = 2_000_000;
    let mut text = String::new();
    text.try_reserve(2 * 6 * ROWS + 256).unwrap();
    text.push_str("[\"setColumns\",[{");
    for (field_index, field) in ["time", "open", "high", "low", "close", "volume"]
        .into_iter()
        .enumerate()
    {
        if field_index != 0 {
            text.push(',');
        }
        write!(text, "\"{field}\":[").unwrap();
        for index in 0..ROWS {
            if index != 0 {
                text.push(',');
            }
            text.push('0');
        }
        text.push(']');
    }
    write!(text, "}},{ROWS}]]").unwrap();
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let started = Instant::now();
    {
        let mut scope = MemoryScope::new(&account);
        let decoded = decode(
            "nativeCommand",
            text.as_bytes(),
            JsonMode::Standard,
            &mut scope,
        )
        .unwrap()
        .unwrap();
        let BulkDecode::Call(BulkCall::SetColumns { columns, length }) = decoded else {
            panic!("setColumns")
        };
        assert_eq!(length, BulkLength::Number(ROWS as f64));
        for column in [
            &columns.time,
            &columns.open,
            &columns.high,
            &columns.low,
            &columns.close,
            &columns.volume,
        ] {
            assert_eq!(column.len(), ROWS);
            assert_eq!(column[ROWS - 1], 0.0);
        }
        assert!(
            scope.requested_bytes() < 160 * 1024 * 1024,
            "{} bytes",
            scope.requested_bytes()
        );
    }
    assert_eq!(account.snapshot().requested_live_bytes, 0);
    eprintln!(
        "2M setColumns: input={} bytes elapsed={:?} peak={} bytes",
        text.len(),
        started.elapsed(),
        account.snapshot().requested_peak_bytes
    );
}
