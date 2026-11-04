//! 큰 값 배열의 원본을 복사하지 않고 32개 단위 요약 tree만 소유하는 구간 인덱스다.

use barochart_js::error::JsError;
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

use crate::range_index::{RangeIndex, RangeIndexBufferView, RangeQuery};

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

/// caller 소유 값 slice를 각 연산 동안만 빌리고 block 요약만 보관한다.
pub struct BlockRangeIndex {
    size: usize,
    length: usize,
    block_size: usize,
    tree: RangeIndex,
}

impl BlockRangeIndex {
    /// 원본 값을 복사하지 않고 현재 block 요약 tree를 빌린다.
    pub fn buffer_view(&self) -> RangeIndexBufferView<'_> {
        self.tree.buffer_view()
    }

    /// Native async target이 검증된 block summary tree를 재복사 없이 채택한다.
    pub fn from_native_tree(
        size: usize,
        length: usize,
        block_size: usize,
        tree: RangeIndex,
    ) -> Result<Self, JsError> {
        if block_size != 32 || size == 0 || !size.is_power_of_two() || length > size {
            return Err(type_error("Async block index"));
        }
        let mut expected_tree_size = 1usize;
        while expected_tree_size < size.div_ceil(block_size) {
            expected_tree_size *= 2;
        }
        let view = tree.buffer_view();
        if view.size != expected_tree_size || view.finite_counts || view.sum.is_none() {
            return Err(type_error("Async block tree"));
        }
        tree.validate_native_count_tree(block_size)?;
        Ok(Self {
            size,
            length,
            block_size,
            tree,
        })
    }

    /// Trusted bounded builder가 완성한 summary tree를 O(1)로 채택한다.
    ///
    /// Untrusted async import의 leaf/aggregate 검사는 [`Self::from_native_tree`]가 맡고,
    /// 이 경계는 같은 프로세스 안에서 이미 q-work 검증을 끝낸 allocation만 받는다.
    pub fn from_owned_tree(
        length: usize,
        capacity: usize,
        block_size: usize,
        tree: RangeIndex,
    ) -> Result<Self, JsError> {
        if block_size != 32 || capacity == 0 || !capacity.is_power_of_two() || length > capacity {
            return Err(range_error("Block source length"));
        }
        let mut expected_tree_size = 1usize;
        while expected_tree_size < capacity.div_ceil(block_size) {
            expected_tree_size *= 2;
        }
        let view = tree.buffer_view();
        if view.size != expected_tree_size || view.finite_counts || view.sum.is_none() {
            return Err(range_error("Block tree role/size"));
        }
        Ok(Self {
            size: capacity,
            length,
            block_size,
            tree,
        })
    }

    /// 논리 길이와 capacity를 block tree로 요약한다. 값 원본은 보관하거나 복사하지 않는다.
    pub fn new(
        length: usize,
        values: &[f64],
        capacity: usize,
        block_size: usize,
    ) -> Result<Self, JsError> {
        Self::new_with_memory(
            length,
            values,
            capacity,
            block_size,
            &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
        .map(|(index, _)| index)
    }

    /// Block scratch와 최종 tree를 explicit context에서 fallible allocation한다.
    pub fn new_with_memory(
        length: usize,
        values: &[f64],
        capacity: usize,
        block_size: usize,
        memory: &MemoryContext,
    ) -> Result<(Self, MemoryGroup), JsError> {
        if block_size == 0 || length > capacity || values.len() < length {
            return Err(range_error("Block source length"));
        }
        let count = length.div_ceil(block_size);
        let blocks = capacity.div_ceil(block_size);
        let (mut low, mut scratch) = memory
            .try_vec_capacity(count)
            .map_err(|failure| failure.into_js_error())?;
        let (mut high, high_group) = memory
            .try_vec_capacity(count)
            .map_err(|failure| failure.into_js_error())?;
        scratch
            .absorb(high_group)
            .map_err(|failure| failure.into_js_error())?;
        let (mut finite, finite_group) = memory
            .try_vec_capacity(count)
            .map_err(|failure| failure.into_js_error())?;
        scratch
            .absorb(finite_group)
            .map_err(|failure| failure.into_js_error())?;
        for block in 0..count {
            let query = scan(
                values,
                length,
                block * block_size,
                (block + 1) * block_size,
                true,
            );
            low.push(query.min);
            high.push(query.max);
            finite.push(query.sum);
        }
        let (tree, tree_group) =
            RangeIndex::new_with_memory(count, &low, &high, Some(&finite), blocks, false, memory)?;
        drop((low, high, finite, scratch));
        Ok((
            Self {
                size: capacity,
                length,
                block_size,
                tree,
            },
            tree_group,
        ))
    }

    /// 원본 capacity다.
    pub fn size(&self) -> usize {
        self.size
    }

    /// 현재 논리 길이다.
    pub fn length(&self) -> usize {
        self.length
    }

    /// block당 값 수다.
    pub fn block_size(&self) -> usize {
        self.block_size
    }

    /// 요약 tree가 소유한 바이트 수다.
    pub fn bytes(&self) -> usize {
        self.tree.bytes()
    }

    /// Summary tree를 explicit context에 fallible하게 복제한다.
    pub fn try_clone_with_memory(
        &self,
        memory: &MemoryContext,
    ) -> Result<(Self, MemoryGroup), JsError> {
        let (tree, group) = self.tree.try_clone_with_memory(memory)?;
        Ok((
            Self {
                size: self.size,
                length: self.length,
                block_size: self.block_size,
                tree,
            },
            group,
        ))
    }

    /// 반열린 범위를 first/last 부분 scan과 중간 dyadic query로 읽는다.
    pub fn query(&self, values: &[f64], from: usize, to: usize) -> Result<RangeQuery, JsError> {
        self.bounds(values, from, to)?;
        if to <= from {
            return Ok(RangeQuery {
                min: f64::INFINITY,
                max: f64::NEG_INFINITY,
                sum: 0.0,
            });
        }
        let first = from.div_ceil(self.block_size);
        let last = to / self.block_size;
        if first >= last {
            return Ok(scan(values, self.length, from, to, false));
        }
        let left = scan(values, self.length, from, first * self.block_size, false);
        let right = scan(values, self.length, last * self.block_size, to, false);
        let middle = self.tree.query(first, last)?;
        Ok(RangeQuery {
            min: js_min(&[left.min, middle.min, right.min]),
            max: js_max(&[left.max, middle.max, right.max]),
            sum: 0.0,
        })
    }

    /// 범위의 유한 값 수다.
    pub fn finite_count(&self, values: &[f64], from: usize, to: usize) -> Result<usize, JsError> {
        self.bounds(values, from, to)?;
        let first = from.div_ceil(self.block_size);
        let last = to / self.block_size;
        if first >= last {
            return Ok(scan_count(values, self.length, from, to));
        }
        let left = scan_count(values, self.length, from, first * self.block_size);
        let middle = self.tree.sum_range(first, last)? as usize;
        let right = scan_count(values, self.length, last * self.block_size, to);
        Ok(left + middle + right)
    }

    /// 범위에 비유한 값이나 논리 tail이 있는지 본다.
    pub fn has_gaps(&self, values: &[f64], from: usize, to: usize) -> Result<bool, JsError> {
        Ok(self.finite_count(values, from, to)? != to - from)
    }

    /// caller가 값을 바꾼 뒤 해당 block 요약을 다시 계산한다.
    pub fn update(&mut self, values: &[f64], index: usize) -> Result<(), JsError> {
        if index >= self.size {
            return Err(range_error("Block update bounds"));
        }
        if index >= values.len() {
            return Err(range_error("Block source length"));
        }
        self.length = std::cmp::max(self.length, index + 1);
        let block = index / self.block_size;
        let query = scan(
            values,
            self.length,
            block * self.block_size,
            (block + 1) * self.block_size,
            true,
        );
        self.tree.update(block, query.min, query.max, query.sum)
    }

    fn bounds(&self, values: &[f64], from: usize, to: usize) -> Result<(), JsError> {
        if to < from || to > self.size {
            return Err(range_error("Block index bounds"));
        }
        if values.len() < std::cmp::min(self.length, to) {
            return Err(range_error("Block source length"));
        }
        Ok(())
    }
}

fn scan(values: &[f64], length: usize, from: usize, to: usize, count_finite: bool) -> RangeQuery {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut count = 0usize;
    for value in values
        .iter()
        .take(std::cmp::min(to, length))
        .skip(from)
        .copied()
    {
        if value.is_finite() {
            if value < min {
                min = value;
            }
            if value > max {
                max = value;
            }
            if count_finite {
                count += 1;
            }
        }
    }
    RangeQuery {
        min,
        max,
        sum: count as f64,
    }
}

fn scan_count(values: &[f64], length: usize, from: usize, to: usize) -> usize {
    values
        .iter()
        .take(std::cmp::min(to, length))
        .skip(from)
        .filter(|value| value.is_finite())
        .count()
}
