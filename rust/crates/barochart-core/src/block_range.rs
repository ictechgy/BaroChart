//! 큰 값 배열의 원본을 복사하지 않고 32개 단위 요약 tree만 소유하는 구간 인덱스다.

use barochart_js::error::JsError;
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

use crate::range_index::{RangeIndex, RangeQuery};

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

/// caller 소유 값 slice를 각 연산 동안만 빌리고 block 요약만 보관한다.
pub struct BlockRangeIndex {
    size: usize,
    length: usize,
    block_size: usize,
    tree: RangeIndex,
}

impl BlockRangeIndex {
    /// 논리 길이와 capacity를 block tree로 요약한다. 값 원본은 보관하거나 복사하지 않는다.
    pub fn new(
        length: usize,
        values: &[f64],
        capacity: usize,
        block_size: usize,
    ) -> Result<Self, JsError> {
        if block_size == 0 || length > capacity || values.len() < length {
            return Err(range_error("Block source length"));
        }
        let count = length.div_ceil(block_size);
        let blocks = capacity.div_ceil(block_size);
        let mut low = Vec::with_capacity(count);
        let mut high = Vec::with_capacity(count);
        let mut finite = Vec::with_capacity(count);
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
        let tree = RangeIndex::new(count, &low, &high, Some(&finite), blocks, false)?;
        Ok(Self {
            size: capacity,
            length,
            block_size,
            tree,
        })
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
