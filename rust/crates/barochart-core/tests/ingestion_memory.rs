use barochart_core::data::{ModelDataState, StoreOptions};
use barochart_core::ingestion::IngestionOwner;
use barochart_js::json::{JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;

#[test]
fn ring_reconfiguration_reserves_old_and_candidate_and_releases_after_dispose() {
    let account = MemoryAccount::new(4_096, OomStyle::InternalErrorLowercase);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let base = account.snapshot().requested_live_bytes;
    let retained = account.reserve(4_096 - base - 4 * 49).unwrap();
    let baseline = account.snapshot().requested_live_bytes;
    let mut owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let input = parse_json(
        br#"{"streamId":"s","generation":1,"maxQueuedEvents":4,"maxQueuedBytes":196}"#,
        JsonMode::Standard,
    )
    .unwrap();
    owner.configure(&input).unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, baseline + 4 * 49);
    let before = stringify_json(&owner.stats().unwrap(), JsonMode::Standard);
    let candidate = parse_json(
        br#"{"streamId":"next","generation":2,"maxQueuedEvents":8,"maxQueuedBytes":392}"#,
        JsonMode::Standard,
    )
    .unwrap();
    let error = owner.configure(&candidate).unwrap_err();
    assert_eq!(error.name(), "InternalError");
    assert_eq!(
        stringify_json(&owner.stats().unwrap(), JsonMode::Standard),
        before
    );
    assert_eq!(account.snapshot().requested_live_bytes, baseline + 4 * 49);
    assert_eq!(owner.native_release_data_ingestion().cancelled, 0);
    assert_eq!(account.snapshot().requested_live_bytes, baseline);
    drop(retained);
    assert_eq!(account.snapshot().requested_live_bytes, base);
    std::thread::spawn(move || drop(owner)).join().unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn ingestion_command_envelope_keeps_the_sources_caught_resource_error_classification() {
    let account = MemoryAccount::new(4_096, OomStyle::InternalErrorLowercase);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let retained = account
        .reserve(4_096 - account.snapshot().requested_live_bytes)
        .unwrap();
    let mut owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let args = parse_json(
        br#"[{"streamId":"s","generation":1,"maxQueuedEvents":4,"maxQueuedBytes":196}]"#,
        JsonMode::Standard,
    )
    .unwrap();
    let result = owner
        .native_data_ingestion_command("configureDataIngestion", &args)
        .unwrap();
    assert_eq!(
        stringify_json(&result, JsonMode::Standard),
        br#"{"error":{"name":"IngestionError","code":"INVALID_INPUT","message":"out of memory"}}"#
    );
    drop(owner);
    drop(retained);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn accounted_ring_and_ingestion_scratch_release_after_actual_use() {
    let account = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let data = ModelDataState::new_with_memory(
        StoreOptions::default(),
        Vec::new(),
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let base = account.snapshot().requested_live_bytes;
    let mut owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let policy = parse_json(
        br#"{"streamId":"s","generation":1,"maxQueuedEvents":4,"maxQueuedBytes":196}"#,
        JsonMode::Standard,
    )
    .unwrap();
    owner.configure(&policy).unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, base + 4 * 49);

    let packet = parse_json(
        br#"{"streamId":"s","generation":1,"firstSequence":0,"events":[{"kind":"update","bar":{"time":0,"open":1,"high":2,"low":0,"close":1.5,"volume":3}}]}"#,
        JsonMode::Standard,
    )
    .unwrap();
    owner.enqueue(&packet).unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, base + 4 * 49);

    let saved = owner.save().unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, base + 4 * 49);
    owner.cancel().unwrap();
    owner
        .load(&JsValue::String(saved))
        .expect("restore ring candidate");
    assert_eq!(account.snapshot().requested_live_bytes, base + 4 * 49);
    assert!(account.snapshot().requested_peak_bytes >= base + 8 * 49);

    std::thread::spawn(move || drop(owner)).join().unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn save_result_group_lives_until_drop_and_quota_failure_keeps_session() {
    const LIMIT: u64 = 16_384;
    let account = MemoryAccount::new(LIMIT, OomStyle::InternalErrorLowercase);
    let memory = MemoryContext::accounted(&account);
    let data =
        ModelDataState::new_with_memory(StoreOptions::default(), Vec::new(), memory).unwrap();
    let mut owner = IngestionOwner::new(data, NumberDialect::Ecma);
    let policy = parse_json(
        br#"{"streamId":"s","generation":1,"maxQueuedEvents":4,"maxQueuedBytes":196}"#,
        JsonMode::Standard,
    )
    .unwrap();
    owner.configure(&policy).unwrap();
    let baseline = account.snapshot().requested_live_bytes;
    let (text, group) = owner.save_with_memory().unwrap();
    assert_eq!(group.requested_bytes(), (text.len_utf16() * 2) as u64);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        baseline + group.requested_bytes()
    );
    drop((text, group));
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    let filler = account
        .reserve(LIMIT - account.snapshot().requested_live_bytes - 1)
        .unwrap();
    let before = stringify_json(&owner.stats().unwrap(), JsonMode::Standard);
    let error = owner.save_with_memory().unwrap_err();
    assert_eq!(error.name(), "InternalError");
    assert_eq!(
        stringify_json(&owner.stats().unwrap(), JsonMode::Standard),
        before
    );
    assert_eq!(account.snapshot().requested_live_bytes, LIMIT - 1);
    drop(filler);
    owner.native_release_data_ingestion();
    drop(owner);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn replacement_oom_keeps_the_old_ring_and_reports_backend_error_name() {
    // The current store constructor briefly needs old+empty-candidate store bytes, so leave
    // that unrelated construction peak available while making the replacement ring fail.
    for (style, name, message) in [
        (
            OomStyle::InternalErrorLowercase,
            "InternalError",
            "out of memory",
        ),
        (
            OomStyle::RangeErrorCapitalized,
            "RangeError",
            "Out of memory",
        ),
    ] {
        let account = MemoryAccount::new(3_072, style);
        let data = ModelDataState::new_with_memory(
            StoreOptions::default(),
            Vec::new(),
            MemoryContext::accounted(&account),
        )
        .unwrap();
        let base = account.snapshot().requested_live_bytes;
        let mut owner = IngestionOwner::new(data, NumberDialect::Ecma);
        let initial = parse_json(
            br#"{"streamId":"s","generation":1,"maxQueuedEvents":4,"maxQueuedBytes":196}"#,
            JsonMode::Standard,
        )
        .unwrap();
        owner.configure(&initial).unwrap();
        let before = stringify_json(&owner.stats().unwrap(), JsonMode::Standard);
        let replacement = parse_json(
            br#"{"streamId":"next","generation":2,"maxQueuedEvents":64,"maxQueuedBytes":3136}"#,
            JsonMode::Standard,
        )
        .unwrap();
        let error = owner.configure(&replacement).unwrap_err();
        assert_eq!(error.name(), name);
        assert_eq!(error.message().to_string_lossy(), message);
        assert_eq!(
            stringify_json(&owner.stats().unwrap(), JsonMode::Standard),
            before
        );
        assert_eq!(account.snapshot().requested_live_bytes, base + 4 * 49);
        owner.native_release_data_ingestion();
        assert_eq!(account.snapshot().requested_live_bytes, base);
        drop(owner);
        assert_eq!(account.snapshot().requested_live_bytes, 0);
    }
}
