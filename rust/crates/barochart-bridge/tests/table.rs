use barochart_bridge::{FUNCTIONS, call, supports};
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
fn the_table_is_the_only_supports_source_and_only_init_is_ready() {
    assert_eq!(FUNCTIONS.len(), 1);
    assert_eq!(FUNCTIONS[0].0, "nativeInit");
    assert!(supports("nativeInit"));
    for name in ["nativeCommand", "nativeSceneJSON", "", "missing"] {
        assert!(!supports(name));
    }
}

#[test]
fn unavailable_names_have_the_documented_error() {
    let error = call(&mut engine(), "nativeCommand", &[]).unwrap_err();
    assert_eq!(error.name, "UnavailableError");
    assert_eq!(
        error.message,
        JsString::from_str("nativeCommand is not available in the Rust backend yet")
    );
    assert_eq!(error.code, None);
}

#[test]
fn prototype_init_returns_a_validated_count_without_pretending_to_build_a_model() {
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
