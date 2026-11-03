//! Native restore/params staging에서만 쓰는 크기 제한 checkpoint 저장소다.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::num::number_to_string;
use barochart_js::string::JsString;

use crate::checkpoint_codec::{safe_checkpoint_parse, safe_checkpoint_stringify};
use crate::indicator_checkpoint::validate_checkpoint_state;
use crate::indicator_params::OrderedIndicatorParams;
use crate::indicator_types::IndicatorProgram;

/// 한 checkpoint record의 UTF-16 JSON 바이트 상한이다.
pub const NATIVE_CHECKPOINT_RECORD_BYTES: usize = 262_144;
/// 한 staging ledger가 과금할 수 있는 UTF-16 JSON 바이트 상한이다.
pub const NATIVE_CHECKPOINT_TOTAL_BYTES: usize = 33_554_432;

const NATIVE_CHECKPOINT_MAX_INDEX: usize = 4_194_304;
const NATIVE_CHECKPOINT_MAX_DEPTH: usize = 32;
const NATIVE_CHECKPOINT_MAX_NODES: usize = 250_000;
const NATIVE_CHECKPOINT_MAX_ARRAY: usize = 65_535;

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn reserved_key(value: &JsString) -> bool {
    [
        "__proto__",
        "prototype",
        "constructor",
        "toJSON",
        "$asterNumber",
    ]
    .into_iter()
    .any(|reserved| text_eq(value, reserved))
}

/// record 직렬화의 정확한 크기와 보수적인 논리 크기다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeCheckpointFootprint {
    /// `safeCheckpointStringify(state).length * 2`와 같은 값이다.
    pub encoded_bytes: usize,
    /// root를 포함한 값 node 수다.
    pub nodes: usize,
    /// encoded bytes에 node당 32바이트를 더한 admission 추정치다.
    pub logical_bytes: usize,
}

struct FootprintCounter {
    units: usize,
    nodes: usize,
}

impl FootprintCounter {
    fn add_units(&mut self, units: usize) -> Result<(), JsError> {
        self.units = self
            .units
            .checked_add(units)
            .ok_or_else(|| range_error("Native checkpoint record byte limit"))?;
        if self.units > NATIVE_CHECKPOINT_RECORD_BYTES / 2 {
            return Err(range_error("Native checkpoint record byte limit"));
        }
        Ok(())
    }

    fn add_string(&mut self, value: &JsString) -> Result<(), JsError> {
        self.add_units(2)?;
        let units = value.as_units();
        let mut index = 0usize;
        while index < units.len() {
            match units[index] {
                34 | 92 | 8 | 9 | 10 | 12 | 13 => {
                    self.add_units(2)?;
                    index += 1;
                }
                0..=31 => {
                    self.add_units(6)?;
                    index += 1;
                }
                0xd800..=0xdbff => {
                    if index + 1 >= units.len() || !(0xdc00..=0xdfff).contains(&units[index + 1]) {
                        return Err(type_error("Native checkpoint Unicode"));
                    }
                    self.add_units(2)?;
                    index += 2;
                }
                0xdc00..=0xdfff => {
                    return Err(type_error("Native checkpoint Unicode"));
                }
                _ => {
                    self.add_units(1)?;
                    index += 1;
                }
            }
        }
        Ok(())
    }

    fn add_marker(&mut self, marker: &str) -> Result<(), JsError> {
        self.add_units(2)?;
        self.add_string(&JsString::from_str("$asterNumber"))?;
        self.add_units(1)?;
        self.add_string(&JsString::from_str(marker))
    }

    fn walk(&mut self, value: &JsValue, depth: usize) -> Result<(), JsError> {
        self.nodes += 1;
        if self.nodes > NATIVE_CHECKPOINT_MAX_NODES || depth > NATIVE_CHECKPOINT_MAX_DEPTH {
            return Err(range_error("Native checkpoint state limit"));
        }
        match value {
            JsValue::Undefined => Err(type_error("Native checkpoint plain state")),
            JsValue::Null => self.add_units(4),
            JsValue::Bool(true) => self.add_units(4),
            JsValue::Bool(false) => self.add_units(5),
            JsValue::Number(value) => {
                if value.is_nan() {
                    self.add_marker("NaN")
                } else if *value == f64::INFINITY {
                    self.add_marker("Infinity")
                } else if *value == f64::NEG_INFINITY {
                    self.add_marker("-Infinity")
                } else if *value == 0.0 && value.is_sign_negative() {
                    self.add_marker("-0")
                } else {
                    self.add_units(number_to_string(*value).encode_utf16().count())
                }
            }
            JsValue::String(value) => self.add_string(value),
            JsValue::Array(values) => {
                if values.len() > NATIVE_CHECKPOINT_MAX_ARRAY {
                    return Err(range_error("Native checkpoint record byte limit"));
                }
                self.add_units(2)?;
                for (index, value) in values.iter().enumerate() {
                    if index != 0 {
                        self.add_units(1)?;
                    }
                    self.walk(value, depth + 1)?;
                }
                Ok(())
            }
            JsValue::Object(object) => {
                self.add_units(2)?;
                for (index, (name, value)) in object.iter().enumerate() {
                    if reserved_key(name) {
                        return Err(type_error("Native checkpoint reserved key"));
                    }
                    if index != 0 {
                        self.add_units(1)?;
                    }
                    self.add_string(name)?;
                    self.add_units(1)?;
                    self.walk(value, depth + 1)?;
                }
                Ok(())
            }
        }
    }
}

/// 직렬화하기 전에 native record의 정확한 UTF-16 크기를 잰다.
pub fn native_checkpoint_footprint(state: &JsValue) -> Result<NativeCheckpointFootprint, JsError> {
    let mut counter = FootprintCounter { units: 0, nodes: 0 };
    counter.walk(state, 0)?;
    let encoded_bytes = counter.units * 2;
    Ok(NativeCheckpointFootprint {
        encoded_bytes,
        nodes: counter.nodes,
        logical_bytes: encoded_bytes + counter.nodes * 32,
    })
}

fn native_checkpoint_text(state: &JsValue) -> Result<(JsString, usize), JsError> {
    let footprint = native_checkpoint_footprint(state)?;
    let text = safe_checkpoint_stringify(state)?;
    if text.len_utf16() * 2 != footprint.encoded_bytes {
        return Err(type_error("Native checkpoint serialization changed"));
    }
    Ok((text, footprint.encoded_bytes))
}

#[derive(Debug)]
struct Ledger {
    used: usize,
    limit: usize,
}

/// 여러 bounded map이 공유할 수 있는 원자적 byte ledger다.
#[derive(Clone, Debug)]
pub struct NativeCheckpointBudget {
    ledger: Arc<Mutex<Ledger>>,
}

impl NativeCheckpointBudget {
    /// 고정 상한의 빈 ledger를 만든다.
    pub fn new(max_bytes: usize) -> Result<Self, JsError> {
        if max_bytes > NATIVE_CHECKPOINT_TOTAL_BYTES {
            return Err(range_error("Native checkpoint total byte limit"));
        }
        Ok(Self {
            ledger: Arc::new(Mutex::new(Ledger {
                used: 0,
                limit: max_bytes,
            })),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Ledger> {
        self.ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn charge(&self, old_bytes: usize, new_bytes: usize) -> Result<(), JsError> {
        let mut ledger = self.lock();
        if old_bytes > ledger.used
            || new_bytes > ledger.limit
            || ledger.used - old_bytes > ledger.limit - new_bytes
        {
            return Err(range_error("Native checkpoint total byte limit"));
        }
        ledger.used = ledger.used - old_bytes + new_bytes;
        Ok(())
    }

    fn refund_drop(&self, bytes: usize) {
        let mut ledger = self.lock();
        ledger.used = ledger.used.saturating_sub(bytes);
    }

    /// 현재 공유 ledger에 과금된 byte 수다.
    pub fn used_bytes(&self) -> usize {
        self.lock().used
    }

    /// 생성 시 고정된 ledger 상한이다.
    pub fn max_bytes(&self) -> usize {
        self.lock().limit
    }
}

/// 검증된 JSON text를 오름차순 index로 보관하는 bounded staging map이다.
pub struct NativeCheckpointMap {
    program: IndicatorProgram,
    params: OrderedIndicatorParams,
    budget: NativeCheckpointBudget,
    block: usize,
    records: BTreeMap<usize, JsString>,
    encoded_bytes: usize,
    disposed: bool,
}

impl NativeCheckpointMap {
    /// indicator 문맥과 고정 checkpoint block을 묶은 빈 map을 만든다.
    pub fn new(
        program: IndicatorProgram,
        params: OrderedIndicatorParams,
        budget: NativeCheckpointBudget,
        block: usize,
    ) -> Result<Self, JsError> {
        if block == 0 || block > NATIVE_CHECKPOINT_MAX_INDEX {
            return Err(type_error("Native checkpoint context"));
        }
        Ok(Self {
            program,
            params,
            budget,
            block,
            records: BTreeMap::new(),
            encoded_bytes: 0,
            disposed: false,
        })
    }

    fn active(&self) -> Result<(), JsError> {
        if self.disposed {
            Err(ordinary_error("Native checkpoint disposed"))
        } else {
            Ok(())
        }
    }

    fn set_index(&self, index: f64) -> Result<usize, JsError> {
        if !index.is_finite()
            || index.fract() != 0.0
            || index < 0.0
            || index > NATIVE_CHECKPOINT_MAX_INDEX as f64
            || !(index as usize).is_multiple_of(self.block)
        {
            return Err(range_error("Native checkpoint index"));
        }
        Ok(index as usize)
    }

    fn lookup_index(index: f64) -> Option<usize> {
        (index.is_finite()
            && index.fract() == 0.0
            && index >= 0.0
            && index <= NATIVE_CHECKPOINT_MAX_INDEX as f64)
            .then_some(index as usize)
    }

    /// 검증과 전체 byte 과금을 모두 통과한 뒤에만 record 하나를 교체한다.
    pub fn set(&mut self, index: f64, state: JsValue) -> Result<(), JsError> {
        self.active()?;
        let index = self.set_index(index)?;
        let (text, new_bytes) = native_checkpoint_text(&state)?;
        let owned = safe_checkpoint_parse(&JsValue::String(text.clone()))?;
        let validated =
            validate_checkpoint_state(self.program, &self.params, &owned, index as f64)?;
        let (validated_text, validated_bytes) = native_checkpoint_text(&validated)?;
        if validated_text != text || validated_bytes != new_bytes {
            return Err(type_error("Native checkpoint validator mutated state"));
        }
        let old_bytes = self
            .records
            .get(&index)
            .map_or(0, |text| text.len_utf16() * 2);
        self.budget.charge(old_bytes, new_bytes)?;
        self.records.insert(index, text);
        self.encoded_bytes = self.encoded_bytes - old_bytes + new_bytes;
        Ok(())
    }

    /// 저장 text를 새 `JsValue`로 해독한다.
    pub fn get(&self, index: f64) -> Result<Option<JsValue>, JsError> {
        self.active()?;
        let Some(index) = Self::lookup_index(index) else {
            return Ok(None);
        };
        self.records
            .get(&index)
            .map(|text| safe_checkpoint_parse(&JsValue::String(text.clone())))
            .transpose()
    }

    /// index record가 있으면 ledger를 환불하고 지운다.
    pub fn delete(&mut self, index: f64) -> Result<bool, JsError> {
        self.active()?;
        let Some(index) = Self::lookup_index(index) else {
            return Ok(false);
        };
        let Some(text) = self.records.get(&index) else {
            return Ok(false);
        };
        let bytes = text.len_utf16() * 2;
        self.budget.charge(bytes, 0)?;
        self.records.remove(&index);
        self.encoded_bytes -= bytes;
        Ok(true)
    }

    /// 모든 record를 지우고 공유 ledger를 환불한다.
    pub fn clear(&mut self) -> Result<(), JsError> {
        self.active()?;
        self.budget.charge(self.encoded_bytes, 0)?;
        self.records.clear();
        self.encoded_bytes = 0;
        Ok(())
    }

    /// 오름차순 checkpoint index 사본이다.
    pub fn keys(&self) -> Result<Vec<f64>, JsError> {
        self.active()?;
        Ok(self.records.keys().map(|index| *index as f64).collect())
    }

    /// 0부터 `length`까지 block 경계가 빠짐없이 있고 각 record가 여전히 유효한지 검사한다.
    pub fn validate_history(&self, length: f64) -> Result<(), JsError> {
        self.active()?;
        if !length.is_finite()
            || length.fract() != 0.0
            || length < 0.0
            || length > NATIVE_CHECKPOINT_MAX_INDEX as f64
        {
            return Err(range_error("Native checkpoint history length"));
        }
        let length = length as usize;
        let expected = if length == 0 {
            0
        } else {
            length / self.block + 1
        };
        if self.records.len() != expected {
            return Err(type_error("Native checkpoint history count"));
        }
        for (ordinal, (index, text)) in self.records.iter().enumerate() {
            if *index != ordinal * self.block {
                return Err(type_error("Native checkpoint history boundary"));
            }
            let state = safe_checkpoint_parse(&JsValue::String(text.clone()))?;
            let validated =
                validate_checkpoint_state(self.program, &self.params, &state, *index as f64)?;
            let (validated_text, _) = native_checkpoint_text(&validated)?;
            if validated_text != *text {
                return Err(type_error("Native checkpoint validator mutated state"));
            }
        }
        Ok(())
    }

    /// 평범한 오름차순 map을 만든 뒤 staging map을 영구 retire한다.
    pub fn publish(&mut self) -> Result<BTreeMap<usize, JsValue>, JsError> {
        self.active()?;
        let mut ordinary = BTreeMap::new();
        for (index, text) in &self.records {
            ordinary.insert(
                *index,
                safe_checkpoint_parse(&JsValue::String(text.clone()))?,
            );
        }
        self.budget.charge(self.encoded_bytes, 0)?;
        self.records.clear();
        self.encoded_bytes = 0;
        self.disposed = true;
        Ok(ordinary)
    }

    /// staging map을 idempotent하게 retire하고 남은 과금을 환불한다.
    pub fn dispose(&mut self) -> Result<(), JsError> {
        if self.disposed {
            return Ok(());
        }
        self.budget.charge(self.encoded_bytes, 0)?;
        self.records.clear();
        self.encoded_bytes = 0;
        self.disposed = true;
        Ok(())
    }

    /// record 수다.
    pub fn size(&self) -> usize {
        self.records.len()
    }

    /// 이 map이 ledger에 과금한 UTF-16 JSON byte 수다.
    pub fn encoded_bytes(&self) -> usize {
        self.encoded_bytes
    }
}

impl Drop for NativeCheckpointMap {
    fn drop(&mut self) {
        if self.encoded_bytes != 0 {
            self.budget.refund_drop(self.encoded_bytes);
            self.encoded_bytes = 0;
        }
    }
}
