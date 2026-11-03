//! 네이티브 함수 표와 단계별 핸들러를 연결한다.
#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

/// 배타적으로 빌린 엔진에서 동작하는 네이티브 브리지 핸들러다.
pub type Handler = fn(&mut Engine, &[JsValue]) -> Result<JsValue, JsError>;

/// 현재 단계의 함수 구현 상태다. 알려진 이름은 미구현이어도 supports에서 참이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FunctionStatus {
    /// 실행 가능한 핸들러가 있다. Init의 모델 상태는 후속 통합에서 완성한다.
    Implemented,
    /// JS 전용 또는 이식 대상 밖의 테스트·데모다.
    Reject,
    /// 이후 이식 단계에 구현할 안정 표면이다.
    Pending,
}

/// 단일 함수 표의 한 항목이다.
pub struct FunctionEntry {
    /// 정확한 전역 함수 이름이다.
    pub name: &'static str,
    /// 현재 구현 상태다.
    pub status: FunctionStatus,
    /// 구현 또는 명시적 거절을 담당하는 함수다.
    pub handler: Option<Handler>,
}

mod manifest;
pub use manifest::FUNCTIONS;

/// 번들에 정의된 이름인지 돌려준다. 실행 준비 여부는 별도 상태다.
pub fn supports(name: &str) -> bool {
    FUNCTIONS
        .binary_search_by_key(&name, |entry| entry.name)
        .is_ok()
}

/// 구현한 함수를 부르거나 단계적 백엔드의 사용 불가 오류를 돌려준다.
pub fn call(engine: &mut Engine, name: &str, args: &[JsValue]) -> Result<JsValue, JsError> {
    match FUNCTIONS
        .binary_search_by_key(&name, |entry| entry.name)
        .ok()
        .and_then(|index| FUNCTIONS[index].handler)
    {
        Some(handler) => handler(engine, args),
        None => Err(JsError::new(
            "UnavailableError",
            JsString::from_str(&format!("{name} is not available in the Rust backend")),
        )),
    }
}

fn reject_source(_: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let mut error = JsError::new(
        "UnavailableError",
        JsString::from_str("Indicator source registration requires the javaScript backend"),
    );
    error.code = Some("JAVASCRIPT_BACKEND_REQUIRED".to_owned());
    Err(error)
}

fn native_echo(_: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    Ok(args.first().cloned().unwrap_or(JsValue::Undefined))
}

fn release_true(_: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    Ok(JsValue::Bool(true))
}

// 실제 source 세션이 들어오기 전의 빈 슬롯 정리도 host의 실패 복구 경로에 필요하다.
fn release_ingestion(_: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let mut object = JsObject::new();
    for key in ["cancelled", "pendingEvents", "ownedBytes"] {
        object.insert(JsString::from_str(key), JsValue::Number(0.0));
    }
    Ok(JsValue::Object(object))
}

fn registration(args: &[JsValue], message: &str) -> Result<(), JsError> {
    match args.first() {
        Some(JsValue::Number(value))
            if value.is_finite()
                && value.fract() == 0.0
                && (1.0..=9_007_199_254_740_991.0).contains(value) =>
        {
            Ok(())
        }
        _ => Err(JsError::new("RangeError", JsString::from_str(message))),
    }
}

fn workspace_abort(_: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    registration(args, "Workspace registration")?;
    Ok(JsValue::Bool(false))
}

fn params_abort(_: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    registration(args, "Params registration")?;
    Ok(JsValue::Null)
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
