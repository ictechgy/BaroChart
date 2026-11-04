//! 공개 batch 옵션을 getter 실행 없이 소유 복사하는 계약이다.

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::string::JsString;

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn key_is(key: &JsString, expected: &str) -> bool {
    key.as_units() == expected.encode_utf16().collect::<Vec<_>>()
}

/// snapshot된 batch 옵션이다. 예산 값은 event snapshot 뒤에 검증하도록 원시 JS 값을 유지한다.
#[derive(Clone, Debug)]
pub struct BatchOptions {
    /// 저장 행 예산 원문이다.
    pub max_bars: Option<JsValue>,
    /// 저장 바이트 예산 원문이다.
    pub max_store_bytes: Option<JsValue>,
    /// 최종 값이 동일할 때 publication을 생략할지 여부다.
    pub skip_unchanged: Option<bool>,
}

impl BatchOptions {
    /// 키가 없는 기본 옵션 snapshot을 만든다.
    pub fn empty() -> Self {
        Self {
            max_bars: None,
            max_store_bytes: None,
            skip_unchanged: None,
        }
    }

    /// `maxBars`가 숫자일 때 값을 돌려준다.
    pub fn max_bars_number(&self) -> Option<f64> {
        match self.max_bars.as_ref() {
            Some(JsValue::Number(value)) => Some(*value),
            _ => None,
        }
    }

    /// `maxStoreBytes`가 숫자일 때 값을 돌려준다.
    pub fn max_store_bytes_number(&self) -> Option<f64> {
        match self.max_store_bytes.as_ref() {
            Some(JsValue::Number(value)) => Some(*value),
            _ => None,
        }
    }
}

/// JS `snapshotDataBatchOptions`처럼 허용 키의 원시 값만 복제한다.
pub fn snapshot_batch_options(
    value: &JsValue,
    store_limits: bool,
) -> Result<BatchOptions, JsError> {
    let JsValue::Object(object) = value else {
        return Err(type_error("Data batch options plain data record required"));
    };
    let mut max_bars = None;
    let mut max_store_bytes = None;
    let mut skip_unchanged = None;
    for (key, value) in object.iter() {
        if store_limits && key_is(key, "maxBars") {
            max_bars = Some(value.clone());
        } else if store_limits && key_is(key, "maxStoreBytes") {
            max_store_bytes = Some(value.clone());
        } else if key_is(key, "skipUnchanged") {
            match value {
                JsValue::Undefined => {}
                JsValue::Bool(value) => skip_unchanged = Some(*value),
                _ => return Err(type_error("Data batch skipUnchanged must be boolean")),
            }
        } else {
            return Err(type_error(
                "Data batch options unsupported field or accessor data property",
            ));
        }
    }
    Ok(BatchOptions {
        max_bars,
        max_store_bytes,
        skip_unchanged,
    })
}
