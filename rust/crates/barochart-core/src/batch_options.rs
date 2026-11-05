//! 공개 batch 옵션을 getter 실행 없이 소유 복사하는 계약이다.

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::string::JsString;

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn key_is(key: &JsString, expected: &str) -> bool {
    key.as_units().iter().copied().eq(expected.encode_utf16())
}

/// snapshot된 batch 옵션이다. 예산 값은 event snapshot 뒤에 검증하도록 원시 JS 값을 유지한다.
#[derive(Debug)]
pub struct BatchOptions {
    /// 저장 행 예산 원문이다.
    pub max_bars: Option<JsValue>,
    /// 저장 바이트 예산 원문이다.
    pub max_store_bytes: Option<JsValue>,
    /// 최종 값이 동일할 때 publication을 생략할지 여부다.
    pub skip_unchanged: Option<bool>,
    _memory: MemoryGroup,
}

impl BatchOptions {
    /// 키가 없는 기본 옵션 snapshot을 만든다.
    pub fn empty() -> Self {
        Self {
            max_bars: None,
            max_store_bytes: None,
            skip_unchanged: None,
            _memory: MemoryGroup::empty(MemoryContext::unaccounted(
                OomStyle::RangeErrorCapitalized,
            )),
        }
    }

    /// 이미 scalar로 만든 내부 예산 값으로 비회계 옵션을 조립한다.
    pub(crate) fn from_scalar_values(
        max_bars: Option<JsValue>,
        max_store_bytes: Option<JsValue>,
        skip_unchanged: Option<bool>,
    ) -> Self {
        debug_assert!(
            max_bars
                .as_ref()
                .is_none_or(|value| matches!(value, JsValue::Number(_)))
        );
        debug_assert!(
            max_store_bytes
                .as_ref()
                .is_none_or(|value| matches!(value, JsValue::Number(_)))
        );
        Self {
            max_bars,
            max_store_bytes,
            skip_unchanged,
            _memory: MemoryGroup::empty(MemoryContext::unaccounted(
                OomStyle::RangeErrorCapitalized,
            )),
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
    snapshot_batch_options_with_memory(
        value,
        store_limits,
        &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
    )
}

/// 허용 키와 boolean 오류를 먼저 확정한 뒤 원시 예산 값만 지정 account에 소유 복제한다.
pub fn snapshot_batch_options_with_memory(
    value: &JsValue,
    store_limits: bool,
    memory: &MemoryContext,
) -> Result<BatchOptions, JsError> {
    let JsValue::Object(object) = value else {
        return Err(type_error("Data batch options plain data record required"));
    };
    for (key, value) in object.iter() {
        if store_limits && (key_is(key, "maxBars") || key_is(key, "maxStoreBytes")) {
            continue;
        }
        if key_is(key, "skipUnchanged") {
            if !matches!(value, JsValue::Undefined | JsValue::Bool(_)) {
                return Err(type_error("Data batch skipUnchanged must be boolean"));
            }
            continue;
        }
        return Err(type_error(
            "Data batch options unsupported field or accessor data property",
        ));
    }

    let mut max_bars_source = None;
    let mut max_store_bytes_source = None;
    let mut skip_unchanged = None;
    for (key, value) in object.iter() {
        if store_limits && key_is(key, "maxBars") {
            max_bars_source = Some(value);
        } else if store_limits && key_is(key, "maxStoreBytes") {
            max_store_bytes_source = Some(value);
        } else if key_is(key, "skipUnchanged") {
            match value {
                JsValue::Undefined => {}
                JsValue::Bool(value) => skip_unchanged = Some(*value),
                _ => unreachable!("batch option shape was validated before allocation"),
            }
        }
    }

    let mut walk_scope = memory.scope();
    let max_bars_bytes = max_bars_source
        .map(|value| crate::js_value_heap_bytes_scoped(value, &mut walk_scope))
        .transpose()?
        .unwrap_or(0);
    let max_store_bytes_bytes = max_store_bytes_source
        .map(|value| crate::js_value_heap_bytes_scoped(value, &mut walk_scope))
        .transpose()?
        .unwrap_or(0);
    let retained_bytes = max_bars_bytes
        .checked_add(max_store_bytes_bytes)
        .ok_or_else(|| memory.allocation_failure().into_js_error())?;
    drop(walk_scope);

    let mut clone_scope = memory.scope();
    let max_bars = max_bars_source
        .map(|value| value.try_clone_scoped(&mut clone_scope))
        .transpose()
        .map_err(|failure| failure.into_js_error())?;
    let max_store_bytes = max_store_bytes_source
        .map(|value| value.try_clone_scoped(&mut clone_scope))
        .transpose()
        .map_err(|failure| failure.into_js_error())?;
    let memory = clone_scope
        .split_persistent(retained_bytes)
        .map_err(|failure| failure.into_js_error())?;
    Ok(BatchOptions {
        max_bars,
        max_store_bytes,
        skip_unchanged,
        _memory: memory,
    })
}
