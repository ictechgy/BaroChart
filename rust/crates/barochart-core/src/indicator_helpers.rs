//! 지표 leaf가 공유하는 JS 평가 순서 그대로의 rolling helper와 checkpoint 정규화다.

#![forbid(unsafe_code)]

use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::js_max;
use barochart_js::string::JsString;

use crate::data::Bar;

/// Raw ring snapshot 필드 순서다.
pub const RING_WIRE_KEYS: &[&str] = &["a", "head", "sum"];
/// Smoother snapshot 필드 순서다.
pub const SMOOTHER_WIRE_KEYS: &[&str] = &["count", "sum", "value"];
/// Extreme queue canonical snapshot 필드 순서다.
pub const EXTREME_WIRE_KEYS: &[&str] = &["a", "head"];
/// Compensated VWMA snapshot 필드 순서다.
pub const VWMA_WIRE_KEYS: &[&str] = &["a", "head", "sums", "invalid", "positive"];

/// Typed state가 imported checkpoint의 허용된 object key 순서를 잃지 않게 하는 cold metadata다.
/// 값이나 `JsValue`는 보관하지 않고 canonical field index만 둔다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointFieldOrder {
    order: Vec<usize>,
}

impl CheckpointFieldOrder {
    /// 아직 생성된 필드가 없는 JS state의 키 순서다.
    pub fn empty() -> Self {
        Self { order: Vec::new() }
    }

    /// 선택 필드가 있는 imported state의 실제 삽입 순서를 보존한다.
    pub fn capture_present(value: &JsValue, allowed: &[&str]) -> Option<Self> {
        let JsValue::Object(object) = value else {
            return None;
        };
        let mut order = Vec::with_capacity(object.len());
        for (key, _) in object.iter() {
            let index = allowed
                .iter()
                .position(|candidate| text_eq(key, candidate))?;
            if order.contains(&index) {
                return None;
            }
            order.push(index);
        }
        Some(Self { order })
    }

    /// JS가 처음 helper 필드를 만들 때만 그 키를 끝에 추가한다.
    pub fn touch(&mut self, canonical_index: usize) {
        if !self.order.contains(&canonical_index) {
            self.order.push(canonical_index);
        }
    }

    /// 존재하는 선택 필드만 현재 키 순서대로 직렬화한다.
    pub fn ordered_present_object(&self, fields: &[(&str, Option<JsValue>)]) -> JsValue {
        debug_assert_eq!(
            self.order.len(),
            fields.iter().filter(|(_, value)| value.is_some()).count()
        );
        let mut output = JsObject::new();
        for index in &self.order {
            if let Some((key, Some(value))) = fields.get(*index) {
                output.insert(JsString::from_str(key), value.clone());
            }
        }
        JsValue::Object(output)
    }

    /// 새 JS state가 만드는 source insertion order다.
    pub fn source(field_count: usize) -> Self {
        Self {
            order: (0..field_count).collect(),
        }
    }

    /// 검증된 imported object에서 허용 필드의 실제 key 순서를 잡는다.
    pub fn capture(value: &JsValue, allowed: &[&str]) -> Option<Self> {
        let JsValue::Object(object) = value else {
            return None;
        };
        if object.len() != allowed.len() {
            return None;
        }
        let mut seen = vec![false; allowed.len()];
        let mut order = Vec::with_capacity(allowed.len());
        for (key, _) in object.iter() {
            let index = allowed.iter().position(|allowed| text_eq(key, allowed))?;
            if seen[index] {
                return None;
            }
            seen[index] = true;
            order.push(index);
        }
        seen.into_iter()
            .all(|present| present)
            .then_some(Self { order })
    }

    /// canonical field 배열의 값을 잡아 둔 imported/source 순서로 객체에 넣는다.
    pub fn ordered_object(&self, fields: &[(&str, JsValue)]) -> JsValue {
        debug_assert_eq!(self.order.len(), fields.len());
        let mut output = JsObject::new();
        for index in &self.order {
            let (key, value) = &fields[*index];
            output.insert(JsString::from_str(key), value.clone());
        }
        JsValue::Object(output)
    }

    /// canonical field index 순서를 진단·테스트용으로 빌린다.
    pub fn indices(&self) -> &[usize] {
        &self.order
    }
}

/// raw rolling FIFO 상태다. Wire 키 순서는 `a, head, sum`이다.
#[derive(Clone, Debug)]
pub struct Ring {
    /// 물리 ring 배열이다.
    pub values: Vec<f64>,
    /// 다음 교체 위치인 검증된 JS integer다. Imported `-0`를 산술 대입 전까지 보존한다.
    pub head: f64,
    /// raw 덧셈 순서의 합이다.
    pub sum: f64,
    wire_order: CheckpointFieldOrder,
}

impl Default for Ring {
    fn default() -> Self {
        Self {
            values: Vec::new(),
            head: 0.0,
            sum: 0.0,
            wire_order: CheckpointFieldOrder::source(RING_WIRE_KEYS.len()),
        }
    }
}

impl Ring {
    /// 테스트·복원 staging에서 물리 값을 지정하되 source key 순서를 쓴다.
    pub fn from_parts(values: Vec<f64>, head: f64, sum: f64) -> Self {
        Self {
            values,
            head,
            sum,
            wire_order: CheckpointFieldOrder::source(RING_WIRE_KEYS.len()),
        }
    }

    /// 검증된 imported ring의 key 순서를 보존한다.
    pub fn capture_wire_order(&mut self, wire: &JsValue) -> bool {
        let Some(order) = CheckpointFieldOrder::capture(wire, RING_WIRE_KEYS) else {
            return false;
        };
        self.wire_order = order;
        true
    }

    /// 현재 물리 배열과 head를 바꾸지 않은 wire snapshot을 만든다.
    pub fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_object(&[
            (
                "a",
                JsValue::Array(self.values.iter().copied().map(JsValue::Number).collect()),
            ),
            ("head", JsValue::Number(self.head)),
            ("sum", JsValue::Number(self.sum)),
        ])
    }
}

/// source `roll`의 raw FIFO 덧셈/교체 순서를 그대로 실행한다.
pub fn roll(state: &mut Option<Ring>, value: f64, period: usize) -> f64 {
    debug_assert!(period > 0);
    let ring = state.get_or_insert_with(Ring::default);
    if !value.is_finite() {
        ring.values.clear();
        ring.head = 0.0;
        ring.sum = 0.0;
        return f64::NAN;
    }
    if ring.values.len() < period {
        ring.values.push(value);
        ring.sum += value;
    } else {
        let head = persisted_index(ring.head);
        ring.sum += value - ring.values[head];
        ring.values[head] = value;
        ring.head = (ring.head + 1.0) % period as f64;
    }
    if ring.values.len() == period {
        ring.sum / period as f64
    } else {
        f64::NAN
    }
}

/// 물리 ring을 FIFO 순서로 다시 더해 오래된 rounding error를 버린다.
pub fn rebase_roll(ring: &mut Ring) -> f64 {
    let mut sum = 0.0;
    for offset in 0..ring.values.len() {
        let index = (ring.head + offset as f64) % ring.values.len() as f64;
        sum += ring.values[persisted_index(index)];
    }
    ring.sum = sum;
    sum
}

/// SMA에만 적용되는 cancellation/nonfinite 합 복구를 수행한다.
pub fn sma_roll(state: &mut Option<Ring>, value: f64, period: usize) -> f64 {
    debug_assert!(period > 0);
    let before = state.as_ref().map_or(0.0, |ring| ring.sum);
    let expired = state.as_ref().map_or(0.0, |ring| {
        if ring.values.len() == period {
            ring.values[persisted_index(ring.head)]
        } else {
            0.0
        }
    });
    let result = roll(state, value, period);
    if !value.is_finite() {
        return result;
    }
    let ring = state.as_mut().expect("roll creates a ring");
    if period == 1 {
        ring.sum = value;
        return value;
    }
    let difference = value - expired;
    let scale = js_max(&[before.abs(), expired.abs(), value.abs(), difference.abs()]);
    if !ring.sum.is_finite()
        || scale > 0.0 && ring.sum.abs() <= scale * f64::EPSILON * 4.0 * period as f64
    {
        rebase_roll(ring);
    }
    let mean = if ring.values.len() == period {
        ring.sum / period as f64
    } else {
        f64::NAN
    };
    if mean.is_finite() { mean } else { f64::NAN }
}

/// `smooth`의 count/sum/value 상태다. 초기 absence는 바깥 `Option`으로 구분한다.
#[derive(Clone, Debug)]
pub struct Smoother {
    /// seed에서 받은 값 수인 검증된 JS integer다. Imported `-0`를 `++` 전까지 보존한다.
    pub count: f64,
    /// seed raw 합이다.
    pub sum: f64,
    /// mature smoothing 값이다.
    pub value: f64,
    wire_order: CheckpointFieldOrder,
}

impl Default for Smoother {
    fn default() -> Self {
        Self {
            count: 0.0,
            sum: 0.0,
            value: f64::NAN,
            wire_order: CheckpointFieldOrder::source(SMOOTHER_WIRE_KEYS.len()),
        }
    }
}

impl Smoother {
    /// 테스트·복원 staging에서 값을 지정하되 source key 순서를 쓴다.
    pub fn from_parts(count: f64, sum: f64, value: f64) -> Self {
        Self {
            count,
            sum,
            value,
            wire_order: CheckpointFieldOrder::source(SMOOTHER_WIRE_KEYS.len()),
        }
    }

    /// 검증된 imported smoother의 key 순서를 보존한다.
    pub fn capture_wire_order(&mut self, wire: &JsValue) -> bool {
        let Some(order) = CheckpointFieldOrder::capture(wire, SMOOTHER_WIRE_KEYS) else {
            return false;
        };
        self.wire_order = order;
        true
    }

    /// live 값을 바꾸지 않은 wire snapshot을 만든다.
    pub fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_object(&[
            ("count", JsValue::Number(self.count)),
            ("sum", JsValue::Number(self.sum)),
            ("value", JsValue::Number(self.value)),
        ])
    }
}

/// 공통 smoother다. EMA 전용 recovery를 섞지 않는다.
pub fn smooth(state: &mut Option<Smoother>, value: f64, period: usize, alpha: f64) -> f64 {
    debug_assert!(period > 0);
    let smoother = state.get_or_insert_with(Smoother::default);
    if !value.is_finite() {
        *smoother = Smoother::default();
        return f64::NAN;
    }
    if smoother.count < period as f64 {
        smoother.count += 1.0;
        smoother.sum += value;
        if smoother.count == period as f64 {
            smoother.value = smoother.sum / period as f64;
        }
    } else {
        smoother.value += alpha * (value - smoother.value);
    }
    smoother.value
}

/// EMA에만 허용된 overflow/corruption recovery를 수행한다.
pub fn ema_recover(state: &mut Option<Smoother>, value: f64, period: usize, alpha: f64) -> f64 {
    debug_assert!(period > 0);
    if period == 1 && value.is_finite() {
        let smoother = state.get_or_insert_with(Smoother::default);
        smoother.count = 1.0;
        smoother.sum = 0.0;
        smoother.value = if value == 0.0 { 0.0 } else { value };
        return smoother.value;
    }
    if value.is_finite()
        && let Some(smoother) = state.as_mut()
        && if smoother.count < period as f64 {
            !smoother.sum.is_finite()
        } else {
            !smoother.value.is_finite()
        }
    {
        *smoother = Smoother::default();
    }
    let before = state.as_ref().map_or(f64::NAN, |smoother| {
        if smoother.count >= period as f64 {
            smoother.value
        } else {
            f64::NAN
        }
    });
    let result = smooth(state, value, period, alpha);
    let smoother = state.as_mut().expect("smooth creates a smoother");
    if !value.is_finite() {
        return result;
    }
    if smoother.count >= period as f64 && !result.is_finite() && before.is_finite() {
        let recovered = (1.0 - alpha) * before + alpha * value;
        if recovered.is_finite() {
            smoother.value = recovered;
            return recovered;
        }
    }
    if smoother.count < period as f64 && !smoother.sum.is_finite()
        || smoother.count >= period as f64 && !smoother.value.is_finite()
    {
        smoother.count = 1.0;
        smoother.sum = value;
        smoother.value = if period == 1 { value } else { f64::NAN };
        return smoother.value;
    }
    result
}

/// monotonic extreme queue 한 항목이다.
#[derive(Clone, Copy, Debug)]
pub struct ExtremeEntry {
    /// 원본 봉 index인 검증된 JS integer다. Pair 안의 `-0`도 보존한다.
    pub index: f64,
    /// high/low 값이다.
    pub value: f64,
}

/// monotonic maximum/minimum queue다. 초기 absence는 바깥 `Option`으로 구분한다.
#[derive(Clone, Debug, Default)]
pub struct ExtremeQueue {
    /// 만료 항목을 포함할 수 있는 물리 배열이다.
    pub entries: Vec<ExtremeEntry>,
    /// 첫 live 항목 위치인 검증된 JS integer다. Canonical snapshot의 head만 새 `+0`다.
    pub head: f64,
}

impl ExtremeEntry {
    /// 검증된 checkpoint pair를 비트 손실 없이 만든다.
    pub fn from_parts(index: f64, value: f64) -> Self {
        Self { index, value }
    }
}

impl ExtremeQueue {
    /// 검증된 checkpoint queue를 비트 손실 없이 만든다.
    pub fn from_parts(entries: Vec<ExtremeEntry>, head: f64) -> Self {
        Self { entries, head }
    }

    /// live storage 그대로의 wire state를 만든다.
    pub fn to_wire(&self) -> JsValue {
        object([
            (
                "a",
                JsValue::Array(self.entries.iter().map(extreme_entry_wire).collect()),
            ),
            ("head", JsValue::Number(self.head)),
        ])
    }

    /// 만료 prefix를 복사에서만 버린 새 `{a, head:0}` snapshot을 만든다.
    pub fn canonical_snapshot(&self) -> JsValue {
        object([
            (
                "a",
                JsValue::Array(
                    self.entries[persisted_index(self.head)..]
                        .iter()
                        .map(extreme_entry_wire)
                        .collect(),
                ),
            ),
            ("head", JsValue::Number(0.0)),
        ])
    }
}

/// amortized O(1) rolling maximum/minimum을 계산한다.
pub fn extreme(
    state: &mut Option<ExtremeQueue>,
    value: f64,
    period: usize,
    index: usize,
    maximum: bool,
) -> f64 {
    debug_assert!(period > 0);
    let queue = state.get_or_insert_with(ExtremeQueue::default);
    while queue.entries.len() as f64 > queue.head
        && queue.entries.last().is_some_and(|entry| {
            if maximum {
                entry.value <= value
            } else {
                entry.value >= value
            }
        })
    {
        queue.entries.pop();
    }
    queue.entries.push(ExtremeEntry {
        index: index as f64,
        value,
    });
    let expired = index as f64 - period as f64;
    while queue
        .entries
        .get(persisted_index(queue.head))
        .is_some_and(|entry| entry.index <= expired)
    {
        queue.head += 1.0;
    }
    if queue.head > 256.0 {
        queue.entries = queue.entries[persisted_index(queue.head)..].to_vec();
        queue.head = 0.0;
    }
    if index >= period - 1 {
        queue.entries[persisted_index(queue.head)].value
    } else {
        f64::NAN
    }
}

/// compensated VWMA의 FIFO와 세 합 상태다.
#[derive(Clone, Debug)]
pub struct VwmaAccumulator {
    /// `[close*volume, volume]` 물리 ring이다.
    pub values: Vec<[f64; 2]>,
    /// 다음 교체 위치인 검증된 JS integer다.
    pub head: f64,
    /// numerator, volume, absolute-product 각각의 `[sum, correction]`이다.
    pub sums: [[f64; 2]; 3],
    /// nonfinite product 수인 검증된 JS integer다.
    pub invalid: f64,
    /// 양의 volume 수인 검증된 JS integer다.
    pub positive: f64,
    wire_order: CheckpointFieldOrder,
}

impl Default for VwmaAccumulator {
    fn default() -> Self {
        Self {
            values: Vec::new(),
            head: 0.0,
            sums: [[0.0, 0.0]; 3],
            invalid: 0.0,
            positive: 0.0,
            wire_order: CheckpointFieldOrder::source(VWMA_WIRE_KEYS.len()),
        }
    }
}

impl VwmaAccumulator {
    /// 검증된 checkpoint 값을 비트 손실 없이 만든다.
    pub fn from_parts(
        values: Vec<[f64; 2]>,
        head: f64,
        sums: [[f64; 2]; 3],
        invalid: f64,
        positive: f64,
    ) -> Self {
        Self {
            values,
            head,
            sums,
            invalid,
            positive,
            wire_order: CheckpointFieldOrder::source(VWMA_WIRE_KEYS.len()),
        }
    }

    /// 검증된 imported VWMA state의 key 순서를 보존한다.
    pub fn capture_wire_order(&mut self, wire: &JsValue) -> bool {
        let Some(order) = CheckpointFieldOrder::capture(wire, VWMA_WIRE_KEYS) else {
            return false;
        };
        self.wire_order = order;
        true
    }

    /// 물리 FIFO와 보정 합을 JS 초기 state 필드 순서로 복사한다.
    pub fn to_wire(&self) -> JsValue {
        self.wire_order.ordered_object(&[
            (
                "a",
                JsValue::Array(
                    self.values
                        .iter()
                        .map(|pair| {
                            JsValue::Array(vec![JsValue::Number(pair[0]), JsValue::Number(pair[1])])
                        })
                        .collect(),
                ),
            ),
            ("head", JsValue::Number(self.head)),
            (
                "sums",
                JsValue::Array(
                    self.sums
                        .iter()
                        .map(|pair| {
                            JsValue::Array(vec![JsValue::Number(pair[0]), JsValue::Number(pair[1])])
                        })
                        .collect(),
                ),
            ),
            ("invalid", JsValue::Number(self.invalid)),
            ("positive", JsValue::Number(self.positive)),
        ])
    }
}

/// Neumaier 방식으로 한 보정 합을 갱신한다.
pub fn vwma_accumulate(pair: &mut [f64; 2], value: f64) {
    if !pair[0].is_finite() {
        return;
    }
    let previous = pair[0];
    let next = previous + value;
    let correction = pair[1]
        + if previous.abs() >= value.abs() {
            (previous - next) + value
        } else {
            (value - next) + previous
        };
    if !next.is_finite() || !correction.is_finite() || !(next + correction).is_finite() {
        pair[0] = f64::NAN;
        pair[1] = 0.0;
    } else {
        pair[0] = next;
        pair[1] = correction;
    }
}

/// 현재 FIFO를 원래 순서로 다시 더해 보정 합을 재구성한다.
pub fn vwma_rebase(state: &mut VwmaAccumulator) {
    state.sums = [[0.0, 0.0]; 3];
    for offset in 0..state.values.len() {
        let index = (state.head + offset as f64) % state.values.len() as f64;
        let pair = state.values[persisted_index(index)];
        vwma_contribution(state, pair, 1.0);
    }
}

/// compensated VWMA 한 행을 계산한다.
pub fn vwma_step(state: &mut VwmaAccumulator, bar: &Bar, index: usize, period: usize) -> f64 {
    debug_assert!(period > 0);
    let large = vwma_large(state);
    let pair = [bar.close * bar.volume, bar.volume];
    let mut dominant = false;
    if state.values.len() == period {
        let head = persisted_index(state.head);
        let old = state.values[head];
        let numerator = state.sums[0][0] + state.sums[0][1];
        let volume = state.sums[1][0] + state.sums[1][1];
        dominant = old[0].abs() > 0.0 && old[0].abs() >= numerator.abs() / 2.0
            || old[1] > 0.0 && old[1] >= volume / 2.0;
        vwma_contribution(state, old, -1.0);
        state.invalid -= number_from_bool(!old[0].is_finite());
        state.positive -= number_from_bool(old[1] > 0.0);
        state.values[head] = pair;
        state.head = (state.head + 1.0) % period as f64;
    } else {
        state.values.push(pair);
    }
    vwma_contribution(state, pair, 1.0);
    state.invalid += number_from_bool(!pair[0].is_finite());
    state.positive += number_from_bool(pair[1] > 0.0);
    if state.positive == 0.0 {
        state.sums = [[0.0, 0.0]; 3];
    } else if dominant
        || large
        || vwma_large(state)
        || vwma_compensation_large(state, period)
        || (index + 1).is_multiple_of(period)
        || state.sums.iter().any(|sum| !(sum[0] + sum[1]).is_finite())
        || state.sums[1][0] + state.sums[1][1] <= 0.0
        || state.sums[2][0] + state.sums[2][1] < 0.0
    {
        vwma_rebase(state);
    }
    let numerator = state.sums[0][0] + state.sums[0][1];
    let volume = state.sums[1][0] + state.sums[1][1];
    let absolute = state.sums[2][0] + state.sums[2][1];
    if state.values.len() < period
        || state.invalid != 0.0
        || state.positive == 0.0
        || !numerator.is_finite()
        || !volume.is_finite()
        || !absolute.is_finite()
    {
        return f64::NAN;
    }
    let result = numerator / volume;
    if result.is_finite() { result } else { f64::NAN }
}

/// JS `trueRange`와 같은 평가 순서로 계산한다.
pub fn true_range(bar: &Bar, previous: f64) -> f64 {
    if previous.is_finite() {
        js_max(&[
            bar.high - bar.low,
            (bar.high - previous).abs(),
            (bar.low - previous).abs(),
        ])
    } else {
        bar.high - bar.low
    }
}

/// live Bollinger ring을 FIFO 순서로 Welford 재생한다.
pub fn rebase_bollinger(values: &[f64], head: f64) -> (f64, f64) {
    let mut mean = 0.0;
    let mut m2 = 0.0;
    for offset in 0..values.len() {
        let index = (head + offset as f64) % values.len() as f64;
        let value = values[persisted_index(index)];
        let count = (offset + 1) as f64;
        let delta = value - mean;
        mean += delta / count;
        m2 += delta * (value - mean);
    }
    (mean, m2)
}

/// Snapshot 복사본만 canonicalize한다. 입력 live state는 바꾸지 않는다.
pub fn canonical_checkpoint(value: &JsValue) -> JsValue {
    match value {
        JsValue::Array(values) => JsValue::Array(values.iter().map(canonical_checkpoint).collect()),
        JsValue::Object(source) if is_extreme_wire(source) => {
            let JsValue::Array(entries) = source
                .get(&JsString::from_str("a"))
                .expect("extreme wire has a")
            else {
                unreachable!()
            };
            let JsValue::Number(head) = source
                .get(&JsString::from_str("head"))
                .expect("extreme wire has head")
            else {
                unreachable!()
            };
            let start = slice_start(*head, entries.len());
            object([
                (
                    "a",
                    JsValue::Array(entries[start..].iter().map(canonical_checkpoint).collect()),
                ),
                ("head", JsValue::Number(0.0)),
            ])
        }
        JsValue::Object(source) => {
            let mut output = JsObject::new();
            for (key, child) in source.iter() {
                output.insert(key.clone(), canonical_checkpoint(child));
            }
            if source.get(&JsString::from_str("count")).is_some()
                && source.get(&JsString::from_str("sum")).is_some()
                && matches!(
                    source.get(&JsString::from_str("value")),
                    Some(JsValue::Number(value)) if value.is_finite()
                )
            {
                output.insert(JsString::from_str("sum"), JsValue::Number(0.0));
            }
            JsValue::Object(output)
        }
        _ => value.clone(),
    }
}

/// 객체 key 순서는 무시하고 leaf 값은 JS `Object.is` 의미로 비교한다.
pub fn exact_state_equal(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => same_number(*left, *right),
        (JsValue::String(left), JsValue::String(right)) => left == right,
        (JsValue::Array(left), JsValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| exact_state_equal(left, right))
        }
        (JsValue::Object(left), JsValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| exact_state_equal(value, other))
                })
        }
        _ => false,
    }
}

fn vwma_contribution(state: &mut VwmaAccumulator, pair: [f64; 2], sign: f64) {
    let [product, volume] = pair;
    vwma_accumulate(&mut state.sums[1], sign * volume);
    if product.is_finite() {
        vwma_accumulate(&mut state.sums[0], sign * product);
        vwma_accumulate(&mut state.sums[2], sign * product.abs());
    }
}

fn vwma_large(state: &VwmaAccumulator) -> bool {
    [1_usize, 2].into_iter().any(|index| {
        let value = state.sums[index][0] + state.sums[index][1];
        !value.is_finite() || value >= f64::MAX / 4.0
    })
}

fn vwma_compensation_large(state: &VwmaAccumulator, period: usize) -> bool {
    state.sums.iter().any(|pair| {
        let scale = pair[0] + pair[1];
        let threshold = js_max(&[
            f64::from_bits(1) * 32.0 * period as f64,
            scale.abs() * f64::EPSILON * 32.0 * period as f64,
        ]);
        pair[1].abs() > threshold
    })
}

fn extreme_entry_wire(entry: &ExtremeEntry) -> JsValue {
    JsValue::Array(vec![
        JsValue::Number(entry.index),
        JsValue::Number(entry.value),
    ])
}

fn is_extreme_wire(object: &JsObject) -> bool {
    if object.len() != 2 {
        return false;
    }
    let Some(JsValue::Array(entries)) = object.get(&JsString::from_str("a")) else {
        return false;
    };
    let Some(JsValue::Number(head)) = object.get(&JsString::from_str("head")) else {
        return false;
    };
    head.is_finite()
        && head.fract() == 0.0
        && (entries.is_empty() || matches!(entries.first(), Some(JsValue::Array(_))))
}

fn slice_start(head: f64, len: usize) -> usize {
    if head < 0.0 {
        let magnitude = (-head) as usize;
        len.saturating_sub(magnitude)
    } else {
        <usize as Ord>::min(head as usize, len)
    }
}

fn same_number(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        true
    } else if left == 0.0 && right == 0.0 {
        left.to_bits() == right.to_bits()
    } else {
        left == right
    }
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut output = JsObject::new();
    for (key, value) in entries {
        output.insert(JsString::from_str(key), value);
    }
    JsValue::Object(output)
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn persisted_index(value: f64) -> usize {
    debug_assert!(value.is_finite() && value.fract() == 0.0 && value >= 0.0);
    value as usize
}

const fn number_from_bool(value: bool) -> f64 {
    if value { 1.0 } else { 0.0 }
}
