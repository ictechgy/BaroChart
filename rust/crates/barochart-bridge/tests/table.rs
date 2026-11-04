use barochart_bridge::{FUNCTIONS, FunctionStatus, call, supports};
use barochart_core::{Engine, Host, HostError};
use barochart_js::json::JsValue;
use barochart_js::string::JsString;

struct EmptyHost;
impl Host for EmptyHost {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }
    fn log(&self, _: i32, _: &str) {}
}

fn engine() -> Engine {
    Engine::new(Box::new(EmptyHost))
}

#[test]
fn the_table_covers_every_defined_name_without_claiming_pending_handlers() {
    assert_eq!(FUNCTIONS.len(), 100);
    for pair in FUNCTIONS.windows(2) {
        assert!(pair[0].name < pair[1].name);
    }
    for entry in FUNCTIONS {
        assert!(supports(entry.name));
        assert_eq!(
            entry.handler.is_some(),
            entry.status == FunctionStatus::Implemented
                || entry.name == "nativeRegisterIndicatorSource"
        );
    }
    assert!(supports("nativeCommand"));
    assert!(supports("nativeSceneJSON"));
    for name in ["", "missing", "NativeInit"] {
        assert!(!supports(name));
    }
}

#[test]
fn unavailable_names_have_the_documented_error() {
    let error = call(&mut engine(), "nativeSceneJSON", &[]).unwrap_err();
    assert_eq!(error.name, "UnavailableError");
    assert_eq!(
        error.message,
        JsString::from_str("nativeSceneJSON is not available in the Rust backend")
    );
    assert_eq!(error.code, None);
}

#[test]
fn custom_source_is_rejected_before_any_model_or_argument_validation() {
    let error = call(&mut engine(), "nativeRegisterIndicatorSource", &[]).unwrap_err();
    assert_eq!(error.name, "UnavailableError");
    assert_eq!(
        error.message,
        JsString::from_str("Indicator source registration requires the javaScript backend")
    );
    assert_eq!(error.code.as_deref(), Some("JAVASCRIPT_BACKEND_REQUIRED"));
}

#[test]
fn cleanup_accepts_vacant_slots_and_keeps_registration_validation() {
    let mut engine = engine();
    for name in [
        "nativeReleaseFrameCache",
        "nativeReleaseFrameCaches",
        "nativeAsyncRelease",
    ] {
        assert!(matches!(
            call(&mut engine, name, &[]),
            Ok(JsValue::Bool(true))
        ));
    }
    for (name, message) in [
        ("nativeWorkspaceSourceAbort", "Workspace registration"),
        ("nativeParamsSourceAbort", "Params registration"),
        ("nativeParamsSourceStatus", "Params registration"),
    ] {
        let value = call(&mut engine, name, &[JsValue::Number(1.0)]).unwrap();
        if name == "nativeWorkspaceSourceAbort" {
            assert!(matches!(value, JsValue::Bool(false)));
        } else {
            assert!(matches!(value, JsValue::Null));
        }
        for args in [
            vec![],
            vec![JsValue::Number(-0.0)],
            vec![JsValue::Number(9_007_199_254_740_992.0)],
            vec![JsValue::String(JsString::from_str("1"))],
        ] {
            let error = call(&mut engine, name, &args).unwrap_err();
            assert_eq!(error.name, "RangeError");
            assert_eq!(error.message, JsString::from_str(message));
        }
    }
}

#[test]
fn echo_keeps_missing_and_negative_zero_values() {
    assert!(matches!(
        call(&mut engine(), "nativeEcho", &[]),
        Ok(JsValue::Undefined)
    ));
    let JsValue::Number(value) =
        call(&mut engine(), "nativeEcho", &[JsValue::Number(-0.0)]).unwrap()
    else {
        panic!("number expected")
    };
    assert_eq!(value.to_bits(), (-0.0_f64).to_bits());
}

fn value(text: &str) -> JsValue {
    barochart_js::json::parse_json(text.as_bytes(), barochart_js::json::JsonMode::Lossless).unwrap()
}

#[test]
fn legacy_data_calls_change_real_store_and_fail_atomically() {
    let mut engine = engine();
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(0.0), value("{}")],
    )
    .unwrap();
    let bars = value(
        r#"[{"time":1000,"open":1,"high":2,"low":0,"close":1,"volume":1},{"time":2000,"open":2,"high":4,"low":1,"close":2,"volume":2}]"#,
    );
    assert!(matches!(
        call(&mut engine, "nativeSetData", &[bars]),
        Ok(JsValue::Undefined)
    ));
    let event = value(
        r#"{"kind":"update","bar":{"time":2000,"open":2,"high":4,"low":1,"close":3,"volume":2}}"#,
    );
    assert!(matches!(
        call(&mut engine, "nativeDataEvent", &[event]),
        Ok(JsValue::Undefined)
    ));
    assert_eq!(
        engine.data_state().unwrap().store().at(1).unwrap().close,
        3.0
    );
    let before = engine.data_state().unwrap().store().clone();
    let error = call(
        &mut engine,
        "nativeDataEvent",
        &[value(r#"{"kind":"append","bar":{"time":1000}}"#)],
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        JsString::from_str("Every OHLCV field must be finite")
    );
    assert_eq!(engine.data_state().unwrap().store(), &before);
}

#[test]
fn nullish_legacy_error_keeps_the_platform_expression() {
    let mut engine = engine();
    let missing = call(&mut engine, "nativeSetData", &[JsValue::Null]).unwrap_err();
    assert_eq!(missing.name, "TypeError");
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(1.0), value("{}")],
    )
    .unwrap();
    let error = call(
        &mut engine,
        "nativeDataEvent",
        &[value(r#"{"kind":"update","bar":null}"#)],
    )
    .unwrap_err();
    assert_eq!(error.name, "TypeError");
    #[cfg(target_vendor = "apple")]
    assert_eq!(
        error.message,
        JsString::from_str("null is not an object (evaluating 'event.bar.time')")
    );
    #[cfg(target_os = "android")]
    assert_eq!(
        error.message,
        JsString::from_str("cannot read property 'time' of null")
    );
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    assert_eq!(
        error.message,
        JsString::from_str("Cannot read properties of null (reading 'time')")
    );
}

#[test]
fn command_data_and_native_ingestion_envelopes_share_the_owned_store() {
    let mut engine = engine();
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(0.0), value("{}")],
    )
    .unwrap();
    let result = call(
        &mut engine,
        "nativeCommand",
        &[
            value(r#""setData""#),
            value(r#"[[{"time":1000,"open":1,"high":2,"low":0,"close":1,"volume":1}]]"#),
        ],
    )
    .unwrap();
    assert!(matches!(result, JsValue::Null));
    let result = call(
        &mut engine,
        "nativeDataIngestionCommand",
        &[
            value(r#""configureDataIngestion""#),
            value(r#"[{"streamId":"s","generation":1}]"#),
        ],
    )
    .unwrap();
    assert!(
        matches!(result,JsValue::Object(ref o) if o.get(&JsString::from_str("result")).is_some())
    );
    let packet = value(
        r#"[{"streamId":"s","generation":1,"firstSequence":0,"events":[{"kind":"append","bar":{"time":2000,"open":2,"high":3,"low":1,"close":2,"volume":1}}]}]"#,
    );
    call(
        &mut engine,
        "nativeDataIngestionCommand",
        &[value(r#""enqueueDataEvents""#), packet],
    )
    .unwrap();
    let result = call(
        &mut engine,
        "nativeDataIngestionCommand",
        &[
            value(r#""drainDataEvents""#),
            JsValue::Array(vec![JsValue::Undefined]),
        ],
    )
    .unwrap();
    assert!(
        matches!(result,JsValue::Object(ref o) if o.get(&JsString::from_str("result")).is_some())
    );
    assert_eq!(engine.data_state().unwrap().store().length(), 2);
    call(&mut engine, "nativeReleaseDataIngestion", &[]).unwrap();
    let result = call(
        &mut engine,
        "nativeDataIngestionCommand",
        &[value(r#""dataIngestionStats""#)],
    )
    .unwrap();
    assert!(
        matches!(result,JsValue::Object(ref o) if o.get(&JsString::from_str("error")).is_some())
    );
}

#[test]
fn init_returns_the_original_count_and_stages_owned_seeded_data() {
    let mut engine = engine();
    for count in [0.0_f64, -0.0, 1.0, 4_194_304.0] {
        let value = call(
            &mut engine,
            "nativeInit",
            &[JsValue::Number(count), JsValue::Null],
        )
        .unwrap();
        let JsValue::Number(actual) = &value else {
            panic!("number expected")
        };
        assert_eq!(actual.to_bits(), count.to_bits());
    }
    let value = call(&mut engine, "nativeInit", &[]).unwrap();
    assert!(matches!(&value, JsValue::Number(100_000.0)));
    for count in [-1.0, 0.5, 4_194_305.0, f64::NAN, f64::INFINITY] {
        let error = call(&mut engine, "nativeInit", &[JsValue::Number(count)]).unwrap_err();
        assert_eq!(error.name, "RangeError");
        assert_eq!(
            error.message,
            JsString::from_str("Synthetic bar count: limit 4194304")
        );
    }
    let error = call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(f64::NAN), JsValue::Bool(false)],
    )
    .unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, JsString::from_str("Chart options object"));
}

#[test]
fn init_owns_seed42_and_preserves_old_data_while_failed_staging_consumes_a_serial() {
    let mut engine = engine();
    assert!(engine.data_state().is_none());
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(3.0), JsValue::Null],
    )
    .unwrap();
    let data = engine.data_state().unwrap();
    let store = data.store();
    assert_eq!(
        (
            store.length(),
            store.capacity(),
            store.version(),
            store.time_version(),
            store.serial()
        ),
        (3, 16, 2.0, 2.0, 1.0)
    );
    let expected = barochart_core::data::seeded_columns(3, 42).unwrap();
    let columns = store.columns().clone();
    assert_eq!(&columns.time[..3], &expected.time);
    assert_eq!(&columns.open[..3], &expected.open);
    assert_eq!(&columns.high[..3], &expected.high);
    assert_eq!(&columns.low[..3], &expected.low);
    assert_eq!(&columns.close[..3], &expected.close);
    assert_eq!(&columns.volume[..3], &expected.volume);
    call(&mut engine, "nativeInit", &[JsValue::Number(f64::NAN)]).unwrap_err();
    assert_eq!(engine.data_state().unwrap().store().columns(), &columns);
    assert_eq!(engine.data_state().unwrap().store().serial(), 1.0);
    call(&mut engine, "nativeInit", &[JsValue::Number(-0.0)]).unwrap();
    assert_eq!(engine.data_state().unwrap().store().serial(), 3.0);
    call(
        &mut engine,
        "nativeInit",
        &[JsValue::Number(0.0), JsValue::Bool(false)],
    )
    .unwrap_err();
    call(&mut engine, "nativeInit", &[JsValue::Number(0.0)]).unwrap();
    assert_eq!(engine.data_state().unwrap().store().serial(), 4.0);

    let mut other = self::engine();
    call(&mut other, "nativeInit", &[JsValue::Number(0.0)]).unwrap();
    assert_eq!(other.data_state().unwrap().store().serial(), 1.0);
}

#[test]
fn engine_is_send_but_not_sync() {
    fn assert_send<T: Send>() {}
    assert_send::<Engine>();
    // Sync인 타입에는 두 구현이 생겨 추론이 모호해진다. !Sync이면 () 구현만 남는다.
    trait AmbiguousIfSync<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousIfSync<()> for T {}
    impl<T: ?Sized + Sync> AmbiguousIfSync<u8> for T {}
    let _ = <Engine as AmbiguousIfSync<_>>::check;
}
