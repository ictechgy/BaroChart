//! Float64 최소·최대·합을 JS와 같은 순서로 병합하는 평면 구간 트리다.

use barochart_js::error::JsError;
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

const MAX_BARS: usize = 4_194_304;

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn min2(left: f64, right: f64) -> f64 {
    js_min(&[left, right])
}

fn max2(left: f64, right: f64) -> f64 {
    js_max(&[left, right])
}

fn allocate_index(
    size: usize,
    finite_counts: bool,
    with_sum: bool,
    memory: &MemoryContext,
) -> Result<(RangeIndex, MemoryGroup), JsError> {
    let length = size
        .checked_mul(2)
        .ok_or_else(|| range_error("Index capacity"))?;
    let (min, mut group) = memory
        .try_vec_filled(length, f64::INFINITY)
        .map_err(|failure| failure.into_js_error())?;
    let (max, max_group) = memory
        .try_vec_filled(length, f64::NEG_INFINITY)
        .map_err(|failure| failure.into_js_error())?;
    group
        .absorb(max_group)
        .map_err(|failure| failure.into_js_error())?;
    let sum = if with_sum || finite_counts {
        let (sum, sum_group) = memory
            .try_vec_filled(length, 0.0)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(sum_group)
            .map_err(|failure| failure.into_js_error())?;
        Some(sum)
    } else {
        None
    };
    Ok((
        RangeIndex {
            size,
            min,
            max,
            sum,
            finite_counts,
        },
        group,
    ))
}

/// 한 구간의 최소·최대·합이다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RangeQuery {
    /// 유한한 최솟값이며 없으면 양의 무한대다.
    pub min: f64,
    /// 유한한 최댓값이며 없으면 음의 무한대다.
    pub max: f64,
    /// volume 합이다. finite-count 역할의 외부 query에서는 0이다.
    pub sum: f64,
}

/// Native 전송이 현재 tree의 배열을 한 호출 동안 복사 없이 읽는 뷰다.
#[derive(Clone, Copy)]
pub struct RangeIndexBufferView<'a> {
    /// leaf capacity다.
    pub size: usize,
    /// 최소 tree 배열이다.
    pub min: &'a [f64],
    /// 최대 tree 배열이다.
    pub max: &'a [f64],
    /// volume 또는 finite-count tree 배열이다.
    pub sum: Option<&'a [f64]>,
    /// 합을 유한값 개수로 사용하는지 나타낸다.
    pub finite_counts: bool,
}

/// power-of-two leaf 배열을 쓰는 구간 인덱스다.
#[derive(Clone, Debug, PartialEq)]
pub struct RangeIndex {
    size: usize,
    min: Vec<f64>,
    max: Vec<f64>,
    sum: Option<Vec<f64>>,
    finite_counts: bool,
}

/// Prepare/workspace target이 큰 index를 bounded step으로 직접 구성하는 소유 builder다.
///
/// Leaf는 0부터, merge node는 `size - 1`부터 1까지 정확히 한 번씩 받아 전체 재계산 없이
/// 내부 allocation을 [`RangeIndex`]로 이동한다.
pub struct RangeIndexBuilder {
    index: RangeIndex,
    next_leaf: usize,
    next_merge: usize,
    merging: bool,
}

impl RangeIndexBuilder {
    /// 한 번만 tree allocation을 만든다.
    ///
    /// `with_sum`은 volume sum 역할이다. `finite_counts`는 별도 count sum 역할이므로 둘을
    /// 동시에 요청할 수 없다.
    pub fn new(capacity: usize, finite_counts: bool, with_sum: bool) -> Result<Self, JsError> {
        Self::new_with_memory(
            capacity,
            finite_counts,
            with_sum,
            &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
        .map(|(builder, _)| builder)
    }

    /// Tree payload를 explicit memory context에 fallible allocation하고 group과 함께 돌려준다.
    pub fn new_with_memory(
        capacity: usize,
        finite_counts: bool,
        with_sum: bool,
        memory: &MemoryContext,
    ) -> Result<(Self, MemoryGroup), JsError> {
        if capacity > MAX_BARS {
            return Err(range_error(&format!("Index capacity: limit {MAX_BARS}")));
        }
        if finite_counts && with_sum {
            return Err(type_error("Finite-count index cannot also sum volume"));
        }
        let mut size = 1usize;
        while size < capacity {
            size *= 2;
        }
        let (index, group) = allocate_index(size, finite_counts, with_sum, memory)?;
        Ok((
            Self {
                index,
                next_leaf: 0,
                next_merge: size.saturating_sub(1),
                merging: false,
            },
            group,
        ))
    }

    /// Target copy/검증과 allocation identity 테스트가 현재 builder 배열을 빌린다.
    pub fn buffer_view(&self) -> RangeIndexBufferView<'_> {
        self.index.buffer_view()
    }

    /// 다음 논리 leaf 하나를 기존 JS `leaf` 평가 순서로 쓴다.
    pub fn leaf(&mut self, index: usize, low: f64, high: f64, volume: f64) -> Result<(), JsError> {
        if self.merging || index != self.next_leaf || index >= self.index.size {
            return Err(range_error("Index builder leaf order"));
        }
        self.index.leaf(index, low, high, volume);
        self.next_leaf += 1;
        Ok(())
    }

    /// 다음 내부 node 하나를 `size - 1`에서 1로 내려가며 병합한다.
    pub fn merge(&mut self, position: usize) -> Result<(), JsError> {
        self.merging = true;
        if position == 0 || position != self.next_merge {
            return Err(range_error("Index builder merge order"));
        }
        self.index.merge(position);
        self.next_merge -= 1;
        Ok(())
    }

    /// 모든 요청 leaf와 모든 내부 node가 끝났는지 확인하고 allocation을 O(1) 이동한다.
    pub fn finish(self, length: usize) -> Result<RangeIndex, JsError> {
        if length > self.index.size || self.next_leaf != length || self.next_merge != 0 {
            return Err(range_error("Index builder incomplete"));
        }
        if self
            .index
            .sum
            .as_ref()
            .is_some_and(|values| !self.index.finite_counts && !values[1].is_finite())
        {
            return Err(range_error("Volume sum overflow"));
        }
        Ok(self.index)
    }
}

impl RangeIndex {
    /// 실제 tree 배열의 불변 빌림이다. 소유 복사나 캐시 재생성을 하지 않는다.
    pub fn buffer_view(&self) -> RangeIndexBufferView<'_> {
        RangeIndexBufferView {
            size: self.size,
            min: &self.min,
            max: &self.max,
            sum: self.sum.as_deref(),
            finite_counts: self.finite_counts,
        }
    }

    /// Native async target이 이미 소유한 정확한 tree 배열을 재복사 없이 채택한다.
    /// 내용 검사는 source 프로토콜의 역할별 validator가 이어서 수행한다.
    pub fn from_native_buffers(
        size: usize,
        min: Vec<f64>,
        max: Vec<f64>,
        sum: Option<Vec<f64>>,
        finite_counts: bool,
    ) -> Result<Self, JsError> {
        if size == 0 || size > MAX_BARS || !size.is_power_of_two() {
            return Err(type_error("Async index size"));
        }
        let expected = size
            .checked_mul(2)
            .ok_or_else(|| type_error("Async index buffers"))?;
        if min.len() != expected
            || max.len() != expected
            || sum.as_ref().is_some_and(|sum| sum.len() != expected)
        {
            return Err(type_error("Async index buffers"));
        }
        Ok(Self {
            size,
            min,
            max,
            sum,
            finite_counts,
        })
    }

    /// JS `asyncRestoreTree(..., countLimit)`와 같은 leaf/aggregate count 검사를 한다.
    pub fn validate_native_count_tree(&self, count_limit: usize) -> Result<(), JsError> {
        let Some(sum) = &self.sum else {
            return Err(type_error("Async index buffers"));
        };
        for ((value, min), max) in sum[self.size..self.size * 2]
            .iter()
            .zip(&self.min[self.size..self.size * 2])
            .zip(&self.max[self.size..self.size * 2])
        {
            if !value.is_finite()
                || value.fract() != 0.0
                || *value < 0.0
                || *value > count_limit as f64
                || self.finite_counts && *value != f64::from(min.is_finite() && max.is_finite())
            {
                return Err(type_error("Async finite-count cache leaf"));
            }
        }
        for position in (1..self.size).rev() {
            if sum[position] != sum[position * 2] + sum[position * 2 + 1] {
                return Err(type_error("Async finite-count cache aggregate"));
            }
        }
        Ok(())
    }

    /// JS `RangeIndex`와 같은 tree를 만든다.
    pub fn new(
        length: usize,
        low: &[f64],
        high: &[f64],
        volume: Option<&[f64]>,
        capacity: usize,
        finite_counts: bool,
    ) -> Result<Self, JsError> {
        Self::new_with_memory(
            length,
            low,
            high,
            volume,
            capacity,
            finite_counts,
            &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
        .map(|(index, _)| index)
    }

    /// JS `RangeIndex`와 같은 tree를 explicit memory context에서 fallible하게 만든다.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_memory(
        length: usize,
        low: &[f64],
        high: &[f64],
        volume: Option<&[f64]>,
        capacity: usize,
        finite_counts: bool,
        memory: &MemoryContext,
    ) -> Result<(Self, MemoryGroup), JsError> {
        if capacity > MAX_BARS {
            return Err(range_error(&format!("Index capacity: limit {MAX_BARS}")));
        }
        if length > capacity {
            return Err(range_error(&format!("Index length: limit {capacity}")));
        }
        if finite_counts && volume.is_some() {
            return Err(type_error("Finite-count index cannot also sum volume"));
        }
        if low.len() < length
            || high.len() < length
            || volume.is_some_and(|values| values.len() < length)
        {
            return Err(range_error("Index input length"));
        }
        let mut size = 1;
        while size < capacity {
            size *= 2;
        }
        let (mut index, group) = allocate_index(size, finite_counts, volume.is_some(), memory)?;
        for position in 0..length {
            index.leaf(
                position,
                low[position],
                high[position],
                volume.map_or(0.0, |values| values[position]),
            );
        }
        for position in (1..size).rev() {
            index.merge(position);
        }
        if index
            .sum
            .as_ref()
            .is_some_and(|values| !values[1].is_finite())
        {
            return Err(range_error("Volume sum overflow"));
        }
        Ok((index, group))
    }

    /// leaf 용량인 power-of-two 크기다.
    pub fn size(&self) -> usize {
        self.size
    }

    /// 인덱스가 finite-count 역할인지 본다.
    pub fn finite_counts(&self) -> bool {
        self.finite_counts
    }

    /// 소유 tree 버퍼의 바이트 수다.
    pub fn bytes(&self) -> usize {
        (self.min.capacity() + self.max.capacity() + self.sum.as_ref().map_or(0, Vec::capacity)) * 8
    }

    /// 실제 tree buffers를 explicit context에 fallible하게 깊은 복제한다.
    pub fn try_clone_with_memory(
        &self,
        memory: &MemoryContext,
    ) -> Result<(Self, MemoryGroup), JsError> {
        let (min, mut group) = memory
            .try_clone_slice(&self.min)
            .map_err(|failure| failure.into_js_error())?;
        let (max, max_group) = memory
            .try_clone_slice(&self.max)
            .map_err(|failure| failure.into_js_error())?;
        group
            .absorb(max_group)
            .map_err(|failure| failure.into_js_error())?;
        let sum = match &self.sum {
            Some(source) => {
                let (sum, sum_group) = memory
                    .try_clone_slice(source)
                    .map_err(|failure| failure.into_js_error())?;
                group
                    .absorb(sum_group)
                    .map_err(|failure| failure.into_js_error())?;
                Some(sum)
            }
            None => None,
        };
        Ok((
            Self {
                size: self.size,
                min,
                max,
                sum,
                finite_counts: self.finite_counts,
            },
            group,
        ))
    }

    /// 한 leaf의 최소 비트를 관찰한다.
    pub fn leaf_min(&self, index: usize) -> f64 {
        self.min[self.size + index]
    }

    /// 한 leaf의 최대 비트를 관찰한다.
    pub fn leaf_max(&self, index: usize) -> f64 {
        self.max[self.size + index]
    }

    /// 한 leaf의 합 또는 count를 관찰한다.
    pub fn leaf_sum(&self, index: usize) -> Option<f64> {
        self.sum.as_ref().map(|sum| sum[self.size + index])
    }

    /// tree 전체의 합 또는 finite count다.
    pub fn root_sum(&self) -> Option<f64> {
        self.sum.as_ref().map(|sum| sum[1])
    }

    /// 같은 역할·크기의 검증된 tree 값을 기존 버퍼에 복사한다.
    pub fn copy_tree_from(&mut self, source: &Self) -> Result<(), JsError> {
        if self.size != source.size
            || self.finite_counts != source.finite_counts
            || self.min.len() != source.min.len()
            || self.max.len() != source.max.len()
            || self.sum.as_ref().map(Vec::len) != source.sum.as_ref().map(Vec::len)
        {
            return Err(type_error("Range index role/size mismatch"));
        }
        self.min.copy_from_slice(&source.min);
        self.max.copy_from_slice(&source.max);
        if let (Some(target), Some(source)) = (&mut self.sum, &source.sum) {
            target.copy_from_slice(source);
        }
        Ok(())
    }

    /// leaf를 교체한다. volume 인덱스는 실제 scalar merge 순서의 모든 중간 합을 먼저 확인한다.
    pub fn update(
        &mut self,
        index: usize,
        low: f64,
        high: f64,
        volume: f64,
    ) -> Result<(), JsError> {
        if index >= self.size {
            return Err(range_error("Index update bounds"));
        }
        if let Some(sums) = &self.sum
            && !self.finite_counts
        {
            if !volume.is_finite() || volume < 0.0 {
                return Err(range_error("Volume"));
            }
            let mut sum = volume;
            let mut position = self.size + index;
            while position > 1 {
                sum += sums[position ^ 1];
                if !sum.is_finite() {
                    return Err(range_error("Volume sum overflow"));
                }
                position >>= 1;
            }
        }
        self.leaf(index, low, high, volume);
        let mut position = (self.size + index) >> 1;
        while position != 0 {
            self.merge(position);
            position >>= 1;
        }
        Ok(())
    }

    /// 반열린 범위를 JS dyadic 방문 순서로 합친다.
    pub fn query(&self, start: usize, end: usize) -> Result<RangeQuery, JsError> {
        self.bounds(start, end, "Range index bounds")?;
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        let mut sum = 0.0;
        let mut left = start + self.size;
        let mut right = end + self.size;
        while left < right {
            if left & 1 != 0 {
                min = min2(min, self.min[left]);
                max = max2(max, self.max[left]);
                sum += self.sum.as_ref().map_or(0.0, |values| values[left]);
                left += 1;
            }
            if right & 1 != 0 {
                right -= 1;
                min = min2(min, self.min[right]);
                max = max2(max, self.max[right]);
                sum += self.sum.as_ref().map_or(0.0, |values| values[right]);
            }
            left >>= 1;
            right >>= 1;
        }
        Ok(RangeQuery {
            min,
            max,
            sum: if self.finite_counts { 0.0 } else { sum },
        })
    }

    /// finite-count tree의 유한 원소 수를 돌려준다.
    pub fn finite_count(&self, start: usize, end: usize) -> Result<usize, JsError> {
        if !self.finite_counts || self.sum.is_none() {
            return Err(type_error("Finite-count index required"));
        }
        Ok(self.sum_range(start, end)? as usize)
    }

    /// 범위에 비유한 값이 있는지 본다.
    pub fn has_gaps(&self, start: usize, end: usize) -> Result<bool, JsError> {
        Ok(self.finite_count(start, end)? != end - start)
    }

    /// 내부 block tree가 쓰는 합/count query다.
    pub fn sum_range(&self, start: usize, end: usize) -> Result<f64, JsError> {
        self.bounds(start, end, "Range index bounds")?;
        let mut sum = 0.0;
        let mut left = start + self.size;
        let mut right = end + self.size;
        while left < right {
            if left & 1 != 0 {
                sum += self.sum.as_ref().map_or(0.0, |values| values[left]);
                left += 1;
            }
            if right & 1 != 0 {
                right -= 1;
                sum += self.sum.as_ref().map_or(0.0, |values| values[right]);
            }
            left >>= 1;
            right >>= 1;
        }
        Ok(sum)
    }

    fn bounds(&self, start: usize, end: usize, message: &str) -> Result<(), JsError> {
        if end < start || end > self.size {
            return Err(range_error(message));
        }
        Ok(())
    }

    fn leaf(&mut self, index: usize, low: f64, high: f64, volume: f64) {
        let position = self.size + index;
        self.min[position] = if low.is_finite() { low } else { f64::INFINITY };
        self.max[position] = if high.is_finite() {
            high
        } else {
            f64::NEG_INFINITY
        };
        if let Some(sum) = &mut self.sum {
            sum[position] = if self.finite_counts {
                f64::from(low.is_finite() && high.is_finite())
            } else {
                volume
            };
        }
    }

    fn merge(&mut self, position: usize) {
        let left = position * 2;
        let right = left + 1;
        self.min[position] = min2(self.min[left], self.min[right]);
        self.max[position] = max2(self.max[left], self.max[right]);
        if let Some(sum) = &mut self.sum {
            sum[position] = sum[left] + sum[right];
        }
    }
}
