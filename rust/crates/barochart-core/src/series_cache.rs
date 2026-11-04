//! 렌더러 시리즈별 비소유 구간 인덱스 캐시다.
//!
//! 원본 값은 `ModelState`, `BarStore`, `IndicatorEngine`가 계속 소유한다. 캐시는 기존
//! 평면/블록 요약 트리만 보관하며, 각 조회와 갱신마다 현재 원본 슬라이스를 빌린다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::num::js_min;
use barochart_js::string::JsString;

use crate::block_range::BlockRangeIndex;
use crate::data::{BarStore, DataIdentity};
use crate::model_state::Series;
use crate::range_index::{RangeIndex, RangeQuery};

/// 이 크기 이상인 시리즈에는 기존 32개 값 단위 블록 트리를 쓴다.
pub const SERIES_BLOCK_THRESHOLD: usize = 65_536;
/// 블록 리프 하나가 요약하는 원본 값의 개수다.
pub const SERIES_BLOCK_SIZE: usize = 32;

/// 시리즈 캐시가 사용하는 저장 방식이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeriesCacheKind {
    /// 작은 시리즈를 위한 직접 finite-count 트리다.
    Flat,
    /// 큰 시리즈를 위한 비소유 32개 값 단위 블록 트리다.
    Block,
}

/// 장면 계층과 대조 테스트에서 읽는 캐시 메타데이터다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeriesCacheInfo {
    /// 평면 또는 블록 트리 방식이다.
    pub kind: SeriesCacheKind,
    /// 캐시가 나타내는 논리 원본 용량이다.
    pub size: usize,
    /// 캐시가 나타내는 원본 값의 개수다.
    pub length: usize,
    /// 블록 너비다. 평면 트리에서는 `None`이다.
    pub block_size: Option<usize>,
    /// 결측 구간 조회에 필요한 유한값 개수 집계가 있는지 나타낸다.
    pub finite_counts: bool,
    /// 요약 트리가 사용하는 바이트 수다.
    pub bytes: usize,
}

enum CachedIndex {
    Flat(RangeIndex),
    Block(BlockRangeIndex),
}

impl CachedIndex {
    fn kind(&self) -> SeriesCacheKind {
        match self {
            Self::Flat(_) => SeriesCacheKind::Flat,
            Self::Block(_) => SeriesCacheKind::Block,
        }
    }

    fn size(&self) -> usize {
        match self {
            Self::Flat(index) => index.size(),
            Self::Block(index) => index.size(),
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Self::Flat(index) => index.bytes(),
            Self::Block(index) => index.bytes(),
        }
    }

    fn query(&self, values: &[f64], from: usize, to: usize) -> Result<RangeQuery, JsError> {
        match self {
            Self::Flat(index) => index.query(from, to),
            Self::Block(index) => index.query(values, from, to),
        }
    }

    fn has_gaps(&self, values: &[f64], from: usize, to: usize) -> Result<bool, JsError> {
        match self {
            Self::Flat(index) => Ok(index.has_gaps(from, to)?),
            Self::Block(index) => index.has_gaps(values, from, to),
        }
    }

    fn finite_count(&self, values: &[f64], from: usize, to: usize) -> Result<usize, JsError> {
        match self {
            Self::Flat(index) => index.finite_count(from, to),
            Self::Block(index) => index.finite_count(values, from, to),
        }
    }

    fn update_range(
        &mut self,
        values: &[f64],
        start: usize,
        computed_until: usize,
    ) -> Result<(), JsError> {
        match self {
            Self::Flat(index) => {
                for position in start..computed_until {
                    let value = *values.get(position).unwrap_or(&f64::NAN);
                    index.update(position, value, value, 0.0)?;
                }
            }
            Self::Block(index) => {
                if computed_until > start {
                    index.update(values, computed_until - 1)?;
                    let block_size = index.block_size();
                    let mut position = start;
                    while position < computed_until {
                        index.update(values, position)?;
                        position = position.saturating_add(block_size);
                    }
                }
            }
        }
        Ok(())
    }
}

struct SeriesCache {
    id: JsString,
    identity: Option<DataIdentity>,
    index: Option<CachedIndex>,
    length: usize,
}

/// 시리즈 식별자로 조회하는 한 차트 소유의 가변 캐시 모음이다.
#[derive(Default)]
pub struct SeriesCaches {
    entries: Vec<SeriesCache>,
}

impl SeriesCaches {
    /// 차트별 빈 캐시 모음을 만든다.
    pub fn new() -> Self {
        Self::default()
    }

    /// 연결된 시리즈 캐시의 개수다.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 연결된 시리즈 캐시가 없는지 본다.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 현재 모델에서 제거된 시리즈의 캐시를 버린다.
    pub fn retain_series(&mut self, series: &[Series]) {
        self.entries
            .retain(|entry| series.iter().any(|candidate| candidate.id == entry.id));
    }

    /// 시리즈 캐시를 다시 만들거나 갱신하고 요청 범위의 집계값을 돌려준다.
    ///
    /// `computed_from`/`computed_until`은 지표 계산이 커밋한 구간이다. 일반 저장소 시리즈는
    /// 무한대 표식을 포함한 dirty 시작점과 현재 저장소 길이를 사용한다. 값 슬라이스는 이
    /// 호출 동안만 빌리고 캐시에 보관하지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub fn query_series(
        &mut self,
        series_id: &JsString,
        indicator: bool,
        revision_cache: &mut Option<f64>,
        dirty_from: &mut f64,
        range_index_ready: &mut bool,
        store: &BarStore,
        identity: &DataIdentity,
        values: &[f64],
        revision: f64,
        computed_from: f64,
        computed_until: usize,
        from: usize,
        to: usize,
    ) -> Result<RangeQuery, JsError> {
        let blocked = values.len() >= SERIES_BLOCK_THRESHOLD;
        let entry_index = match self.entries.iter().position(|entry| entry.id == *series_id) {
            Some(index) => index,
            None => {
                self.entries.push(SeriesCache {
                    id: series_id.clone(),
                    identity: None,
                    index: None,
                    length: 0,
                });
                self.entries.len() - 1
            }
        };
        let entry = &mut self.entries[entry_index];
        let identity_changed = entry
            .identity
            .as_ref()
            .is_none_or(|previous| !previous.matches(identity));
        let policy_changed = entry
            .index
            .as_ref()
            .is_some_and(|index| (index.kind() == SeriesCacheKind::Block) != blocked);
        let capacity_changed = entry
            .index
            .as_ref()
            .is_some_and(|index| index.size() != store.capacity());
        let dirty = *dirty_from < f64::INFINITY;
        let revision_changed = *revision_cache != Some(revision);
        if dirty
            || revision_changed
            || identity_changed
            || !*range_index_ready
            || entry.index.is_none()
            || policy_changed
            || capacity_changed
        {
            let start_value = js_min(&[*dirty_from, computed_from]);
            let start = if start_value.is_finite() && start_value >= 0.0 {
                start_value.floor() as usize
            } else {
                usize::MAX
            };
            let rebuild = identity_changed
                || entry.index.is_none()
                || policy_changed
                || capacity_changed
                || indicator && revision_cache.is_some_and(|old| revision > old + 1.0)
                || computed_until.saturating_sub(start) > values.len() / 4;
            if rebuild {
                entry.index = Some(if blocked {
                    CachedIndex::Block(BlockRangeIndex::new(
                        values.len(),
                        values,
                        store.capacity(),
                        SERIES_BLOCK_SIZE,
                    )?)
                } else {
                    CachedIndex::Flat(RangeIndex::new(
                        values.len(),
                        values,
                        values,
                        None,
                        store.capacity(),
                        true,
                    )?)
                });
            } else {
                entry
                    .index
                    .as_mut()
                    .expect("dirty series cache has an index")
                    .update_range(values, start, computed_until)?;
            }
            *revision_cache = Some(revision);
            *dirty_from = f64::INFINITY;
            *range_index_ready = true;
            entry.identity = Some(identity.clone());
        }
        entry.length = values.len();
        entry
            .index
            .as_ref()
            .expect("series cache was installed")
            .query(values, from, to)
    }

    /// 원본 값을 노출하거나 복사하지 않고 공개 캐시 메타데이터를 읽는다.
    pub fn info(&self, id: &JsString) -> Option<SeriesCacheInfo> {
        let entry = self.entries.iter().find(|entry| entry.id == *id)?;
        let index = entry.index.as_ref()?;
        Some(SeriesCacheInfo {
            kind: index.kind(),
            size: index.size(),
            length: entry.length,
            block_size: match index {
                CachedIndex::Flat(_) => None,
                CachedIndex::Block(index) => Some(index.block_size()),
            },
            finite_counts: true,
            bytes: index.bytes(),
        })
    }

    /// 현재 비소유 값 슬라이스로 준비된 트리를 조회한다.
    pub fn query(
        &self,
        id: &JsString,
        values: &[f64],
        from: usize,
        to: usize,
    ) -> Result<RangeQuery, JsError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .and_then(|entry| entry.index.as_ref())
            .ok_or_else(|| range_error("Missing series cache"))?;
        entry.query(values, from, to)
    }

    /// 캐시 트리를 다시 만들지 않고 평면/블록 트리에서 유한값 수를 센다.
    pub fn finite_count(
        &self,
        id: &JsString,
        values: &[f64],
        from: usize,
        to: usize,
    ) -> Result<usize, JsError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .and_then(|entry| entry.index.as_ref())
            .ok_or_else(|| range_error("Missing series cache"))?;
        entry.finite_count(values, from, to)
    }

    /// 준비된 트리와 원본 슬라이스에서 결측 또는 비유한 값이 있는지 확인한다.
    pub fn has_gaps(
        &self,
        id: &JsString,
        values: &[f64],
        from: usize,
        to: usize,
    ) -> Result<bool, JsError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .and_then(|entry| entry.index.as_ref())
            .ok_or_else(|| range_error("Missing series cache"))?;
        entry.has_gaps(values, from, to)
    }
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
