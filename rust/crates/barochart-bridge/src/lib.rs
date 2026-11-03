//! 네이티브 함수 표 뼈대(M1b Task 5). 아직 내부 빈 엔진만 다룬다.
#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::string::JsString;

/// 배타적으로 빌린 엔진에서 동작하는 네이티브 브리지 핸들러다.
pub type Handler = fn(&mut Engine, &[JsValue]) -> Result<JsValue, JsError>;

/// 구현한 함수 표이며 supports()가 조회하는 유일한 원천이다.
pub static FUNCTIONS: &[(&str, Handler)] = &[("nativeInit", native_init)];

/// 현재 뼈대가 지정한 함수를 구현하는지 돌려준다.
pub fn supports(name: &str) -> bool {
    FUNCTIONS.iter().any(|(key, _)| *key == name)
}

/// 구현한 함수를 부르거나 단계적 백엔드의 사용 불가 오류를 돌려준다.
pub fn call(engine: &mut Engine, name: &str, args: &[JsValue]) -> Result<JsValue, JsError> {
    match FUNCTIONS.iter().find(|(key, _)| *key == name) {
        Some((_, handler)) => handler(engine, args),
        None => Err(JsError::new(
            "UnavailableError",
            JsString::from_str(&format!("{name} is not available in the Rust backend yet")),
        )),
    }
}

// M1b의 count 왕복 프로토타입이다. 초기 옵션/개수 오류 순서는 JS 진입점과 같게 두되 아직 모델은 만들지 않는다.
fn native_init(_: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    if let Some(options) = args.get(1)
        && !matches!(
            options,
            JsValue::Undefined | JsValue::Null | JsValue::Object(_)
        )
    {
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Chart options object"),
        ));
    }
    let count = match args.first() {
        None | Some(JsValue::Undefined) => 100_000.0,
        Some(JsValue::Number(value)) => *value,
        _ => return Err(count_error()),
    };
    if !count.is_finite() || !(0.0..=4_194_304.0).contains(&count) || count.fract() != 0.0 {
        return Err(count_error());
    }
    Ok(JsValue::Number(count))
}

fn count_error() -> JsError {
    JsError::new(
        "RangeError",
        JsString::from_str("Synthetic bar count: limit 4194304"),
    )
}
