//! 렌더러 시리즈별 비소유 구간 인덱스 캐시다.
//!
//! 원본 값은 `ModelState`, `BarStore`, `IndicatorEngine`가 계속 소유한다. 캐시는 기존
//! 평면/블록 요약 트리만 보관하며, 각 조회와 갱신마다 현재 원본 슬라이스를 빌린다.

#![forbid(unsafe_code)]

use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::{MemoryContext, MemoryGroup, OomStyle};
use barochart_js::num::js_min;
use barochart_js::string::JsString;

use crate::block_range::BlockRangeIndex;
use crate::data::{BarStore, DataIdentity};
use crate::model_state::{ModelState, Series, SeriesKind};
use crate::range_index::{RangeIndex, RangeIndexBufferView, RangeQuery};

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

/// Native source 전송이 실제 flat/block 캐시를 복사 없이 읽는 뷰다.
pub enum SeriesCacheBufferView<'a> {
    /// 평면 finite-count tree다.
    Flat {
        /// 현재 tree다.
        tree: RangeIndexBufferView<'a>,
    },
    /// 블록 요약 tree와 원본 배열 메타데이터다.
    Block {
        /// 원본 capacity다.
        size: usize,
        /// 논리 길이다.
        length: usize,
        /// block 너비다.
        block_size: usize,
        /// 현재 요약 tree다.
        tree: RangeIndexBufferView<'a>,
    },
}

/// Native async target이 소유 buffer를 넘기는 cache payload다.
pub enum NativeSeriesCacheSnapshot {
    /// 작은 series의 flat finite-count tree다.
    Flat {
        /// 대상 series id다.
        id: JsString,
        /// exact transferred tree다.
        tree: RangeIndex,
    },
    /// 큰 series의 block summary tree다.
    Block {
        /// 대상 series id다.
        id: JsString,
        /// exact transferred block index다.
        index: BlockRangeIndex,
    },
}

/// 같은 런타임의 bounded builder가 이미 검증한 cache allocation이다.
pub enum NativePrebuiltSeriesCache {
    /// flat finite-count tree와 논리 원본 길이다.
    Flat { tree: RangeIndex, length: usize },
    /// block summary index다.
    Block { index: BlockRangeIndex },
}

impl NativeSeriesCacheSnapshot {
    fn id(&self) -> &JsString {
        match self {
            Self::Flat { id, .. } | Self::Block { id, .. } => id,
        }
    }
}

struct NativeSeriesBinding {
    address: usize,
    id: JsString,
    panel: JsString,
    axis_id: Option<JsString>,
    indicator: Option<JsString>,
    output: Option<JsString>,
    values: Option<(usize, usize)>,
}

/// Empty target cache/model/store에 대해 detached validation을 끝낸 restore stage다.
pub struct NativeSeriesCacheRestoreStage {
    owner_identity: Arc<()>,
    entries_identity: Arc<()>,
    store: DataIdentity,
    store_version_bits: u64,
    store_capacity: usize,
    model: Vec<NativeSeriesBinding>,
    entries: Vec<SeriesCache>,
    ready_ids: Vec<JsString>,
    memory: MemoryGroup,
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
    index_identity: Arc<()>,
    length: usize,
}

/// 시리즈 식별자로 조회하는 한 차트 소유의 가변 캐시 모음이다.
pub struct SeriesCaches {
    entries: Vec<SeriesCache>,
    owner_identity: Arc<()>,
    entries_identity: Arc<()>,
    memory: MemoryGroup,
}

struct SeriesCacheCaptureEntry {
    id: JsString,
    index_identity: Arc<()>,
    has_index: bool,
}

/// Workspace/native source가 호출 사이 cache container/index 교체를 검출하는 opaque token이다.
pub struct SeriesCachesCaptureToken {
    owner_identity: Arc<()>,
    entries_identity: Arc<()>,
    entries: Vec<SeriesCacheCaptureEntry>,
}

/// Series 제거 뒤 cache container identity를 reply admission 전에 준비한다.
pub struct PreparedSeriesCacheRemoval {
    entries_identity: Option<Arc<()>>,
}

impl Default for SeriesCaches {
    fn default() -> Self {
        Self::new_with_memory(MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized))
    }
}

impl SeriesCaches {
    /// explicit engine memory context에 연결한 빈 캐시 owner다.
    pub fn new_with_memory(context: MemoryContext) -> Self {
        Self {
            entries: Vec::new(),
            owner_identity: Arc::new(()),
            entries_identity: Arc::new(()),
            memory: MemoryGroup::empty(context),
        }
    }
    /// 현재 ordered cache/index identity를 잡는다. Tree 제자리 갱신은 token을 바꾸지 않는다.
    pub fn capture_token(&self) -> SeriesCachesCaptureToken {
        SeriesCachesCaptureToken {
            owner_identity: Arc::clone(&self.owner_identity),
            entries_identity: Arc::clone(&self.entries_identity),
            entries: self
                .entries
                .iter()
                .map(|entry| SeriesCacheCaptureEntry {
                    id: entry.id.clone(),
                    index_identity: Arc::clone(&entry.index_identity),
                    has_index: entry.index.is_some(),
                })
                .collect(),
        }
    }

    /// 같은 owner/container/order/index object인지 검사한다.
    pub fn validate_capture(&self, token: &SeriesCachesCaptureToken) -> bool {
        Arc::ptr_eq(&self.owner_identity, &token.owner_identity)
            && Arc::ptr_eq(&self.entries_identity, &token.entries_identity)
            && self.entries.len() == token.entries.len()
            && self
                .entries
                .iter()
                .zip(&token.entries)
                .all(|(entry, expected)| {
                    entry.id == expected.id
                        && Arc::ptr_eq(&entry.index_identity, &expected.index_identity)
                        && entry.index.is_some() == expected.has_index
                })
    }

    /// 이미 존재하는 실제 cache tree만 빌린다. 캐시를 만들거나 갱신하지 않는다.
    pub fn buffer_view(&self, id: &JsString) -> Option<SeriesCacheBufferView<'_>> {
        let entry = self.entries.iter().find(|entry| &entry.id == id)?;
        match entry.index.as_ref()? {
            CachedIndex::Flat(tree) => Some(SeriesCacheBufferView::Flat {
                tree: tree.buffer_view(),
            }),
            CachedIndex::Block(index) => Some(SeriesCacheBufferView::Block {
                size: index.size(),
                length: index.length(),
                block_size: index.block_size(),
                tree: index.buffer_view(),
            }),
        }
    }

    /// Native async target의 exact transferred cache 배열을 detached validation한다.
    pub fn stage_native_restore(
        &self,
        model: &ModelState,
        store: &BarStore,
        snapshots: Vec<NativeSeriesCacheSnapshot>,
    ) -> Result<NativeSeriesCacheRestoreStage, JsError> {
        if !self.entries.is_empty() {
            return Err(type_error("Async series cache target must be empty"));
        }
        let bindings = native_series_bindings(model);
        let mut previous = None;
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(snapshots.len())
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        let mut ready_ids = Vec::new();
        ready_ids
            .try_reserve_exact(snapshots.len())
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        for snapshot in snapshots {
            let id = snapshot.id().clone();
            let Some(position) = model.series.iter().position(|series| series.id == id) else {
                return Err(type_error("Async series cache binding"));
            };
            if previous.is_some_and(|previous| position <= previous) {
                return Err(type_error("Async series cache order"));
            }
            previous = Some(position);
            let series = &model.series[position];
            if !native_cache_eligible(series) {
                return Err(type_error("Async series cache role"));
            }
            let length = series.values.as_ref().map_or(store.length(), Vec::len);
            let index = match snapshot {
                NativeSeriesCacheSnapshot::Flat { tree, .. } => {
                    let view = tree.buffer_view();
                    if view.size != store.capacity()
                        || !view.finite_counts
                        || view.sum.is_none()
                        || length >= SERIES_BLOCK_THRESHOLD
                    {
                        return Err(type_error("Async finite-count cache marker"));
                    }
                    tree.validate_native_count_tree(1)?;
                    CachedIndex::Flat(tree)
                }
                NativeSeriesCacheSnapshot::Block { index, .. } => {
                    let view = index.buffer_view();
                    if index.size() != store.capacity()
                        || index.length() != length
                        || index.block_size() != SERIES_BLOCK_SIZE
                        || view.finite_counts
                        || view.sum.is_none()
                        || length < SERIES_BLOCK_THRESHOLD
                    {
                        return Err(type_error("Async block index"));
                    }
                    CachedIndex::Block(index)
                }
            };
            entries.push(SeriesCache {
                id: id.clone(),
                identity: Some(store.data_identity()),
                index: Some(index),
                index_identity: Arc::new(()),
                length,
            });
            ready_ids.push(id);
        }
        let bytes = entries
            .iter()
            .filter_map(|entry| entry.index.as_ref())
            .map(CachedIndex::bytes)
            .sum();
        let memory = self
            .memory
            .context()
            .reserve_group(bytes)
            .map_err(|failure| failure.into_js_error())?;
        Ok(NativeSeriesCacheRestoreStage {
            owner_identity: Arc::clone(&self.owner_identity),
            entries_identity: Arc::clone(&self.entries_identity),
            store: store.data_identity(),
            store_version_bits: store.version().to_bits(),
            store_capacity: store.capacity(),
            model: bindings,
            entries,
            ready_ids,
            memory,
        })
    }

    /// Target model/store identity를 다시 확인한 뒤 cache allocations를 O(1) 이동한다.
    pub fn publish_native_restore(
        &mut self,
        model: &mut ModelState,
        store: &BarStore,
        stage: NativeSeriesCacheRestoreStage,
    ) -> Result<(), JsError> {
        if !Arc::ptr_eq(&self.owner_identity, &stage.owner_identity)
            || !Arc::ptr_eq(&self.entries_identity, &stage.entries_identity)
            || !self.entries.is_empty()
            || !stage.store.matches(&store.data_identity())
            || stage.store_version_bits != store.version().to_bits()
            || stage.store_capacity != store.capacity()
            || !native_series_bindings_match(&stage.model, model)
        {
            return Err(stale_error("Async series cache owner or source changed"));
        }
        for id in &stage.ready_ids {
            let series = model
                .series
                .iter_mut()
                .find(|series| &series.id == id)
                .expect("validated native series binding retains id");
            series.range_index_ready = true;
        }
        self.entries = stage.entries;
        self.entries_identity = Arc::new(());
        self.memory = stage.memory;
        Ok(())
    }

    /// Trusted prepare/workspace builder가 만든 cache를 재조회·재생성 없이 O(1) 설치한다.
    pub fn install_prebuilt(
        &mut self,
        id: &JsString,
        store: &BarStore,
        prebuilt: NativePrebuiltSeriesCache,
    ) -> Result<(), JsError> {
        let bytes = match &prebuilt {
            NativePrebuiltSeriesCache::Flat { tree, .. } => tree.bytes(),
            NativePrebuiltSeriesCache::Block { index } => index.bytes(),
        };
        let memory = self
            .memory
            .context()
            .reserve_group(bytes)
            .map_err(|failure| failure.into_js_error())?;
        self.install_prebuilt_with_memory(id, store, prebuilt, memory)
    }

    /// 이미 과금된 prepare/job cache payload를 재청구 없이 설치한다.
    pub fn install_prebuilt_with_memory(
        &mut self,
        id: &JsString,
        store: &BarStore,
        prebuilt: NativePrebuiltSeriesCache,
        memory: MemoryGroup,
    ) -> Result<(), JsError> {
        if self.entries.iter().any(|entry| &entry.id == id) {
            return Err(type_error("Duplicate series cache"));
        }
        let (index, length) = match prebuilt {
            NativePrebuiltSeriesCache::Flat { tree, length } => {
                let view = tree.buffer_view();
                if length > store.capacity()
                    || view.size != store.capacity()
                    || !view.finite_counts
                    || view.sum.is_none()
                {
                    return Err(type_error("Prebuilt flat cache role/size"));
                }
                (CachedIndex::Flat(tree), length)
            }
            NativePrebuiltSeriesCache::Block { index } => {
                if index.size() != store.capacity()
                    || index.length() > store.capacity()
                    || index.block_size() != SERIES_BLOCK_SIZE
                {
                    return Err(type_error("Prebuilt block cache role/size"));
                }
                let length = index.length();
                (CachedIndex::Block(index), length)
            }
        };
        if memory.requested_bytes() != index.bytes() as u64 {
            return Err(type_error("Prebuilt series cache memory"));
        }
        self.entries
            .try_reserve(1)
            .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
        self.memory
            .absorb(memory)
            .map_err(|failure| failure.into_js_error())?;
        self.entries.push(SeriesCache {
            id: id.clone(),
            identity: Some(store.data_identity()),
            index: Some(index),
            index_identity: Arc::new(()),
            length,
        });
        self.entries_identity = Arc::new(());
        Ok(())
    }

    /// 차트별 빈 캐시 모음을 만든다.
    pub fn new() -> Self {
        Self::default()
    }

    /// persistent tree payload가 선택한 memory context다.
    pub fn memory_context(&self) -> &MemoryContext {
        self.memory.context()
    }

    /// persistent tree payload의 account bytes다.
    pub fn accounted_bytes(&self) -> u64 {
        self.memory.requested_bytes()
    }

    fn owned_bytes(&self) -> usize {
        self.entries
            .iter()
            .filter_map(|entry| entry.index.as_ref())
            .map(CachedIndex::bytes)
            .sum()
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
        let before = self.entries.len();
        self.entries
            .retain(|entry| series.iter().any(|candidate| candidate.id == entry.id));
        if self.entries.len() != before {
            self.entries_identity = Arc::new(());
            self.memory
                .try_resize(self.owned_bytes())
                .expect("series cache memory shrink");
        }
    }

    /// 제거할 series id들로 cache identity 교체 필요 여부를 미리 계산한다.
    pub fn prepare_remove_ids(&self, ids: &[JsString]) -> PreparedSeriesCacheRemoval {
        PreparedSeriesCacheRemoval {
            entries_identity: self
                .entries
                .iter()
                .any(|entry| ids.iter().any(|id| id == &entry.id))
                .then(|| Arc::new(())),
        }
    }

    /// Prepared identity로 지정 series cache들을 allocation 없이 제거한다.
    pub fn publish_remove_ids(&mut self, ids: &[JsString], prepared: PreparedSeriesCacheRemoval) {
        self.entries
            .retain(|entry| !ids.iter().any(|id| id == &entry.id));
        if let Some(identity) = prepared.entries_identity {
            self.entries_identity = identity;
            self.memory
                .try_resize(self.owned_bytes())
                .expect("series cache memory shrink");
        }
    }

    /// 한 series의 cache object를 제거하고 source capture identity를 회전한다.
    pub fn remove(&mut self, id: &JsString) -> bool {
        let before = self.entries.len();
        self.entries.retain(|entry| &entry.id != id);
        let changed = self.entries.len() != before;
        if changed {
            self.entries_identity = Arc::new(());
            self.memory
                .try_resize(self.owned_bytes())
                .expect("series cache memory shrink");
        }
        changed
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
                self.entries
                    .try_reserve(1)
                    .map_err(|_| self.memory.context().allocation_failure().into_js_error())?;
                self.entries.push(SeriesCache {
                    id: series_id.clone(),
                    identity: None,
                    index: None,
                    index_identity: Arc::new(()),
                    length: 0,
                });
                self.entries_identity = Arc::new(());
                self.entries.len() - 1
            }
        };
        let memory = &mut self.memory;
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
                let old_bytes = entry.index.as_ref().map_or(0, CachedIndex::bytes);
                let context = memory.context().clone();
                let (next, next_memory) = if blocked {
                    let (index, group) = BlockRangeIndex::new_with_memory(
                        values.len(),
                        values,
                        store.capacity(),
                        SERIES_BLOCK_SIZE,
                        &context,
                    )?;
                    (CachedIndex::Block(index), group)
                } else {
                    let (index, group) = RangeIndex::new_with_memory(
                        values.len(),
                        values,
                        values,
                        None,
                        store.capacity(),
                        true,
                        &context,
                    )?;
                    (CachedIndex::Flat(index), group)
                };
                memory
                    .absorb(next_memory)
                    .map_err(|failure| failure.into_js_error())?;
                let final_bytes = memory
                    .requested_bytes()
                    .checked_sub(old_bytes as u64)
                    .ok_or_else(|| type_error("Series cache memory"))?;
                entry.index = Some(next);
                memory
                    .try_resize(final_bytes as usize)
                    .map_err(|failure| failure.into_js_error())?;
                entry.index_identity = Arc::new(());
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

fn native_series_bindings(model: &ModelState) -> Vec<NativeSeriesBinding> {
    model
        .series
        .iter()
        .map(|series| NativeSeriesBinding {
            address: series as *const _ as usize,
            id: series.id.clone(),
            panel: series.panel.clone(),
            axis_id: series.axis_id.clone(),
            indicator: series.indicator.clone(),
            output: series.output.clone(),
            values: series
                .values
                .as_ref()
                .map(|values| (values.as_ptr() as usize, values.len())),
        })
        .collect()
}

fn native_series_bindings_match(expected: &[NativeSeriesBinding], model: &ModelState) -> bool {
    expected.len() == model.series.len()
        && expected
            .iter()
            .zip(&model.series)
            .all(|(expected, series)| {
                expected.address == series as *const _ as usize
                    && expected.id == series.id
                    && expected.panel == series.panel
                    && expected.axis_id == series.axis_id
                    && expected.indicator == series.indicator
                    && expected.output == series.output
                    && expected.values
                        == series
                            .values
                            .as_ref()
                            .map(|values| (values.as_ptr() as usize, values.len()))
            })
}

fn native_cache_eligible(series: &Series) -> bool {
    if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc) {
        return false;
    }
    let raw = series.raw_record();
    let source_volume = matches!(
        &raw,
        JsValue::Object(record)
            if matches!(record.get(&JsString::from_str("source")), Some(JsValue::String(value)) if value == &JsString::from_str("volume"))
    );
    let baseline_zero = match &raw {
        JsValue::Object(record) => match record.get(&JsString::from_str("baseline")) {
            None | Some(JsValue::Undefined | JsValue::Null) => true,
            Some(JsValue::Number(value)) => *value == 0.0,
            _ => false,
        },
        _ => false,
    };
    !(series.kind == SeriesKind::Histogram
        && source_volume
        && series.values.is_none()
        && series.indicator.is_none()
        && series.offset == 0.0
        && baseline_zero)
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn stale_error(message: &str) -> JsError {
    JsError::new("StaleSourceError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
