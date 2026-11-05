use barochart_bridge::{call, read_f64, write_f64};
use barochart_core::{Engine, Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle, oom_style_from_error};
use barochart_js::string::JsString;

struct UtcHost;

impl Host for UtcHost {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        (name == &JsString::from_str("UTC"))
            .then(|| name.clone())
            .ok_or(HostError)
    }

    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Ok(0)
    }

    fn log(&self, _: i32, _: &str) {}
}

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(JsString::from_str(name), item);
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

fn nominal_heap_bytes(value: &JsValue) -> usize {
    match value {
        JsValue::String(value) => value.len_utf16() * std::mem::size_of::<u16>(),
        JsValue::Array(values) => {
            values.len() * std::mem::size_of::<JsValue>()
                + values.iter().map(nominal_heap_bytes).sum::<usize>()
        }
        JsValue::Object(value) => {
            let entries = value.len() * std::mem::size_of::<(JsString, JsValue)>();
            let lookup = if value.len() > 8 {
                value.len() * std::mem::size_of::<(JsString, usize)>()
            } else {
                0
            };
            entries
                + lookup
                + value
                    .iter()
                    .map(|(name, value)| {
                        name.len_utf16() * std::mem::size_of::<u16>() + nominal_heap_bytes(value)
                    })
                    .sum::<usize>()
        }
        JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => 0,
    }
}

fn symbol_string_heap_bytes(value: &JsValue) -> usize {
    ["id", "exchange", "timezone", "currency", "volumeUnit"]
        .into_iter()
        .map(|name| match field(value, name) {
            JsValue::String(value) => value.len_utf16() * std::mem::size_of::<u16>(),
            value => panic!("symbol string {name}: {value:?}"),
        })
        .sum()
}

fn symbol(id: &str, extra: Option<JsValue>) -> JsValue {
    let mut entries = vec![
        ("id", text(id)),
        ("exchange", text("XNAS")),
        ("timezone", text("UTC")),
        ("currency", text("USD")),
        ("volumeUnit", text("shares")),
        ("priceDecimals", JsValue::Number(2.0)),
        ("tickSize", JsValue::Number(0.01)),
        ("adjustment", text("raw")),
    ];
    if let Some(extra) = extra {
        entries.push(("zzUnboundedExtra", extra));
    }
    object(entries)
}

fn init(account: &std::sync::Arc<MemoryAccount>) -> Engine {
    let mut engine = Engine::new(Box::new(UtcHost));
    engine
        .set_memory_context(MemoryContext::accounted(account))
        .unwrap();
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(0.0), object([])],
    )
    .unwrap();
    engine
}

fn empty_engine(account: &std::sync::Arc<MemoryAccount>) -> Engine {
    let mut engine = Engine::new(Box::new(UtcHost));
    engine
        .set_memory_context(MemoryContext::accounted(account))
        .unwrap();
    engine
}

fn parse_runtime_json(value: &JsValue) -> JsValue {
    let JsValue::String(value) = value else {
        panic!("runtime JSON string: {value:?}")
    };
    parse_json(value.to_string_lossy().as_bytes(), JsonMode::Standard).unwrap()
}

fn complete(value: &JsValue) -> bool {
    matches!(
        field(&parse_runtime_json(value), "complete"),
        JsValue::Bool(true)
    )
}

fn set_symbol(
    engine: &mut Engine,
    value: JsValue,
) -> Result<JsValue, barochart_js::error::JsError> {
    call(
        engine,
        "nativeCommand",
        &[text("setSymbol"), JsValue::Array(vec![value])],
    )
}

#[test]
fn bridge_set_symbol_accounts_the_whole_ordered_record_and_releases_replacements() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut engine = init(&account);
    let baseline = account.snapshot().requested_live_bytes;
    let large = "x".repeat(256 * 1024);
    let extra = object([
        ("payload", text(&large)),
        ("nested", JsValue::Array(vec![text("tail")])),
    ]);

    let candidate = symbol("UNBOUNDED-ID", Some(extra));
    let expected_symbol_bytes =
        symbol_string_heap_bytes(&candidate) + nominal_heap_bytes(&candidate);
    set_symbol(&mut engine, candidate).unwrap();
    let large_live = account.snapshot().requested_live_bytes;
    assert_eq!(
        large_live - baseline,
        expected_symbol_bytes as u64,
        "only the actual Symbol strings and ordered raw record may stay charged"
    );
    let inspect = call(
        &mut engine,
        "nativeCommand",
        &[text("inspect"), JsValue::Array(Vec::new())],
    )
    .unwrap();
    let extra = field(field(&inspect, "symbol"), "zzUnboundedExtra");
    let JsValue::String(payload) = field(extra, "payload") else {
        panic!("payload string")
    };
    assert_eq!(payload.len_utf16(), large.len());

    set_symbol(&mut engine, symbol("S", None)).unwrap();
    let small_live = account.snapshot().requested_live_bytes;
    assert!(small_live > baseline);
    assert!(small_live < large_live);
    assert_eq!(
        engine.chart().unwrap().symbol().unwrap().id,
        JsString::from_str("S")
    );

    drop(engine);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn bridge_set_symbol_quota_failure_keeps_the_previous_symbol_and_formatter_identity() {
    let probe = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut probe_engine = init(&probe);
    set_symbol(&mut probe_engine, symbol("OLD", None)).unwrap();
    let probe_snapshot = probe.snapshot();
    drop(probe_engine);
    assert_eq!(probe.snapshot().requested_live_bytes, 0);

    let limit = std::cmp::max(
        probe_snapshot.requested_peak_bytes,
        probe_snapshot.requested_live_bytes,
    ) + 64 * 1024;
    let account = MemoryAccount::new(limit, OomStyle::InternalErrorLowercase);
    let mut engine = init(&account);
    set_symbol(&mut engine, symbol("OLD", None)).unwrap();

    for candidate in [
        symbol(&"I".repeat(256 * 1024), None),
        symbol(
            "NEW",
            Some(object([("tree", text(&"E".repeat(256 * 1024)))])),
        ),
    ] {
        let formatter = engine.chart().unwrap().capture_formatter_identity();
        let before = account.snapshot().requested_live_bytes;
        let error = set_symbol(&mut engine, candidate).unwrap_err();
        assert_eq!(
            oom_style_from_error(&error),
            Some(OomStyle::InternalErrorLowercase)
        );
        assert_eq!(account.snapshot().requested_live_bytes, before);
        let chart = engine.chart().unwrap();
        assert_eq!(chart.symbol().unwrap().id, JsString::from_str("OLD"));
        assert!(chart.validate_formatter_identity(&formatter));
        assert!(matches!(
            field(chart.symbol_record().unwrap(), "id"),
            JsValue::String(value) if value == &JsString::from_str("OLD")
        ));
    }

    drop(engine);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn bridge_set_symbol_keeps_source_validation_order_before_fallible_retention() {
    let probe = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut probe_engine = init(&probe);
    set_symbol(&mut probe_engine, symbol("OLD", None)).unwrap();
    let probe_snapshot = probe.snapshot();
    drop(probe_engine);

    let account = MemoryAccount::new(
        probe_snapshot.requested_peak_bytes + 64 * 1024,
        OomStyle::InternalErrorLowercase,
    );
    let mut engine = init(&account);
    set_symbol(&mut engine, symbol("OLD", None)).unwrap();
    let formatter = engine.chart().unwrap().capture_formatter_identity();
    let before = account.snapshot().requested_live_bytes;

    let invalid_metadata = object([
        ("id", text("")),
        ("exchange", text("XNAS")),
        ("timezone", text("Bad/Zone")),
        ("currency", text("USD")),
        ("volumeUnit", text("shares")),
        ("priceDecimals", JsValue::Number(-1.0)),
        ("tickSize", JsValue::Number(0.01)),
        ("adjustment", text("raw")),
    ]);
    let error = set_symbol(&mut engine, invalid_metadata).unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, JsString::from_str("Invalid symbol metadata"));

    let invalid_zone = object([
        ("id", text(&"I".repeat(256 * 1024))),
        ("exchange", text("XNAS")),
        ("timezone", text("Bad/Zone")),
        ("currency", text("USD")),
        ("volumeUnit", text("shares")),
        ("priceDecimals", JsValue::Number(2.0)),
        ("tickSize", JsValue::Number(0.01)),
        ("adjustment", text("raw")),
    ]);
    let error = set_symbol(&mut engine, invalid_zone).unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert!(
        error
            .message
            .to_string_lossy()
            .starts_with("Unsupported time zone: ")
    );
    assert_eq!(account.snapshot().requested_live_bytes, before);
    let chart = engine.chart().unwrap();
    assert_eq!(chart.symbol().unwrap().id, JsString::from_str("OLD"));
    assert!(chart.validate_formatter_identity(&formatter));

    drop(engine);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ui_restored_symbol_group_is_replaced_instead_of_staying_in_root_retained_memory() {
    let source_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut source = init(&source_account);
    call(
        &mut source,
        "nativeInit",
        &[JsValue::Number(8.0), object([])],
    )
    .unwrap();
    let large = "u".repeat(128 * 1024);
    set_symbol(
        &mut source,
        symbol("UI", Some(object([("payload", text(&large))]))),
    )
    .unwrap();
    let begin = call(
        &mut source,
        "nativePrepareBegin",
        &[text(
            "{\"kind\":\"seeded\",\"count\":8,\"seed\":42,\"visibleBars\":8}",
        )],
    )
    .unwrap();
    let begin_json = parse_runtime_json(&begin);
    let ticket = field(&begin_json, "ticket").clone();

    let target_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut target = empty_engine(&target_account);
    call(
        &mut target,
        "nativePrepareCreate",
        std::slice::from_ref(field(&begin_json, "metadataJSON")),
    )
    .unwrap();
    call(&mut target, "nativeAsyncStart", &[]).unwrap();
    loop {
        let progress = call(&mut target, "nativeAsyncStep", &[JsValue::Number(4_096.0)]).unwrap();
        if complete(&progress) {
            break;
        }
    }

    let header = call(
        &mut source,
        "nativeAsyncUIBegin",
        std::slice::from_ref(&ticket),
    )
    .unwrap();
    call(
        &mut target,
        "nativeAsyncUIImportBegin",
        std::slice::from_ref(&header),
    )
    .unwrap();
    loop {
        let chunk = call(
            &mut source,
            "nativeAsyncUINext",
            std::slice::from_ref(&ticket),
        )
        .unwrap();
        if complete(&chunk) {
            break;
        }
        call(
            &mut target,
            "nativeAsyncUIImportChunk",
            std::slice::from_ref(&chunk),
        )
        .unwrap();
    }
    call(&mut target, "nativeAsyncUIImportEnd", &[]).unwrap();
    call(&mut target, "nativeAsyncFinish", &[]).unwrap();
    let restored_extra = field(
        target.chart().unwrap().symbol_record().unwrap(),
        "zzUnboundedExtra",
    );
    let JsValue::String(restored_payload) = field(restored_extra, "payload") else {
        panic!("restored payload string")
    };
    assert_eq!(restored_payload.len_utf16(), large.len());

    let restored_live = target_account.snapshot().requested_live_bytes;
    set_symbol(&mut target, symbol("S", None)).unwrap();
    let replaced_live = target_account.snapshot().requested_live_bytes;
    assert!(
        restored_live >= replaced_live + (large.len() as u64 * 2),
        "the UI-restored raw record lease must leave with the replaced symbol"
    );
    set_symbol(&mut target, symbol("T", None)).unwrap();
    assert_eq!(
        target_account.snapshot().requested_live_bytes,
        replaced_live
    );

    drop(target);
    assert_eq!(target_account.snapshot().requested_live_bytes, 0);
    drop(source);
    assert_eq!(source_account.snapshot().requested_live_bytes, 0);
}

#[test]
fn workspace_restored_symbol_group_is_replaced_instead_of_staying_in_root_retained_memory() {
    let source_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut source = init(&source_account);
    call(
        &mut source,
        "nativeInit",
        &[JsValue::Number(8.0), object([])],
    )
    .unwrap();
    // Workspace 문서는 별도 공개 계약으로 symbol 문자열을 128 UTF-16 units로 제한한다.
    let large_id = "W".repeat(128);
    set_symbol(&mut source, symbol(&large_id, None)).unwrap();
    let binding = object([
        ("key", text("dataset")),
        ("revision", text("r1")),
        ("adjustmentVersion", text("a1")),
        ("priceUnit", text("USD")),
        ("adjustment", text("raw")),
    ]);
    let document = call(
        &mut source,
        "nativeSaveWorkspace",
        std::slice::from_ref(&binding),
    )
    .unwrap();
    let begin = call(
        &mut source,
        "nativeWorkspaceSourceBegin",
        &[
            document,
            binding,
            JsValue::Number(9.0),
            JsValue::Number(805_306_368.0),
            JsValue::Number(1.0),
        ],
    )
    .unwrap();
    let ticket = field(&begin, "ticket").clone();
    let ready = loop {
        let progress = call(
            &mut source,
            "nativeWorkspaceSourceStep",
            &[ticket.clone(), JsValue::Number(64.0), JsValue::Number(9.0)],
        )
        .unwrap();
        if matches!(field(&progress, "complete"), JsValue::Bool(true)) {
            break progress;
        }
    };

    let target_account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let mut target = empty_engine(&target_account);
    call(
        &mut target,
        "nativeWorkspaceTargetCreate",
        std::slice::from_ref(field(&ready, "metadataJSON")),
    )
    .unwrap();
    for slot in 0..6 {
        let args = [
            ticket.clone(),
            JsValue::Number(slot as f64),
            JsValue::Number(0.0),
            JsValue::Number(8.0),
        ];
        let values = read_f64(&mut source, "nativeAsyncBuffer", &args)
            .unwrap()
            .to_vec();
        write_f64(
            &mut target,
            "nativeAsyncTargetBuffer",
            &[
                JsValue::Number(slot as f64),
                JsValue::Number(0.0),
                JsValue::Number(8.0),
            ],
            &values,
            false,
        )
        .unwrap();
    }
    call(
        &mut source,
        "nativeWorkspaceSourceFinish",
        &[ticket, JsValue::Number(9.0)],
    )
    .unwrap();
    call(&mut target, "nativeAsyncStart", &[]).unwrap();
    loop {
        let progress = call(&mut target, "nativeAsyncStep", &[JsValue::Number(64.0)]).unwrap();
        if complete(&progress) {
            break;
        }
    }
    call(&mut target, "nativeWorkspaceTargetFinish", &[]).unwrap();
    assert_eq!(
        target.chart().unwrap().symbol().unwrap().id.len_utf16(),
        large_id.len()
    );

    let restored_live = target_account.snapshot().requested_live_bytes;
    set_symbol(&mut target, symbol("S", None)).unwrap();
    let replaced_live = target_account.snapshot().requested_live_bytes;
    assert!(
        restored_live >= replaced_live + (large_id.len() as u64 * 2),
        "the Workspace-restored Symbol lease must leave with the replaced symbol"
    );
    set_symbol(&mut target, symbol("T", None)).unwrap();
    assert_eq!(
        target_account.snapshot().requested_live_bytes,
        replaced_live
    );

    drop(target);
    assert_eq!(target_account.snapshot().requested_live_bytes, 0);
    drop(source);
    assert_eq!(source_account.snapshot().requested_live_bytes, 0);
}
