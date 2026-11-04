//! Float64 최소·최대·합을 JS와 같은 순서로 병합하는 평면 구간 트리다.

use barochart_js::error::JsError;
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

/// power-of-two leaf 배열을 쓰는 구간 인덱스다.
#[derive(Clone, Debug, PartialEq)]
pub struct RangeIndex {
    size: usize,
    min: Vec<f64>,
    max: Vec<f64>,
    sum: Option<Vec<f64>>,
    finite_counts: bool,
}

impl RangeIndex {
    /// JS `RangeIndex`와 같은 tree를 만든다.
    pub fn new(
        length: usize,
        low: &[f64],
        high: &[f64],
        volume: Option<&[f64]>,
        capacity: usize,
        finite_counts: bool,
    ) -> Result<Self, JsError> {
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
        let mut index = Self {
            size,
            min: vec![f64::INFINITY; size * 2],
            max: vec![f64::NEG_INFINITY; size * 2],
            sum: (volume.is_some() || finite_counts).then(|| vec![0.0; size * 2]),
            finite_counts,
        };
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
        Ok(index)
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
        (self.min.len() + self.max.len() + self.sum.as_ref().map_or(0, Vec::len)) * 8
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
