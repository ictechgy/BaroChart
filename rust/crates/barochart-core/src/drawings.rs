//! 드로잉 저장소, 불변 스냅샷, 문서 저장, undo/redo 이력을 관리한다.

use std::mem::size_of;
use std::ops::Deref;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{
    JsObject, JsValue, JsonFailure, JsonMode, parse_json_scoped, stringify_json_scoped,
};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use crate::contracts::{RESOURCE_LIMITS, size_limit};
use crate::drawing_document::{
    DrawingDocumentContext, DrawingDocumentLimits, enforce_drawing_budget,
    load_drawing_document_with_memory, save_drawing_document, save_drawing_document_with_memory,
};
use crate::drawing_types::Drawing;
use crate::drawing_validation::{
    canonical_drawing_value_scoped, canonicalize_drawing_value_scoped, copy_drawing_value_scoped,
    option_record_scoped, validate_drawing_with_memory,
};
use crate::position_drawing::{PositionMetrics, position_metrics_for};

/// 드로잉 저장소에 적용하는 자원·이력 한도다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawingStoreConfig {
    /// 보관할 undo/redo 스냅샷의 최대 수다.
    pub history_limit: usize,
    /// 한 현재 프레임에 저장할 최대 드로잉 수다.
    pub max_drawings: usize,
    /// 한 현재 프레임에 저장할 최대 앵커 수다.
    pub max_points: usize,
    /// 드로잉 문서의 최대 UTF-16 길이다.
    pub max_document_chars: usize,
    /// 이력 회계에 보관할 최대 바이트 수다.
    pub history_bytes: usize,
}

impl Default for DrawingStoreConfig {
    fn default() -> Self {
        Self {
            history_limit: 100,
            max_drawings: RESOURCE_LIMITS.max_drawings as usize,
            max_points: RESOURCE_LIMITS.max_drawing_points as usize,
            max_document_chars: RESOURCE_LIMITS.max_document_chars as usize,
            history_bytes: RESOURCE_LIMITS.max_history_bytes as usize,
        }
    }
}

/// pointer `Vec`와 그 lease를 한 번만 소유하는 불변 드로잉 프레임이다.
#[derive(Debug)]
pub struct DrawingFrame {
    items: Vec<Arc<Drawing>>,
    _memory: MemoryGroup,
}

impl DrawingFrame {
    /// 이미 fallible allocation한 pointer 벡터와 lease를 `Arc` 프레임으로 채택한다.
    pub fn try_from_vec(
        items: Vec<Arc<Drawing>>,
        mut memory: MemoryGroup,
    ) -> Result<Arc<Self>, JsError> {
        if items
            .iter()
            .any(|drawing| !memory.context().shares_account(drawing.memory_context()))
        {
            return Err(type_error("Drawing frame memory context"));
        }
        let vector_bytes = items
            .capacity()
            .checked_mul(size_of::<Arc<Drawing>>())
            .ok_or_else(|| memory.context().allocation_failure().into_js_error())?;
        let bytes = size_of::<Self>()
            .checked_add(vector_bytes)
            .ok_or_else(|| memory.context().allocation_failure().into_js_error())?;
        memory.try_resize(bytes).map_err(memory_error)?;
        Ok(Arc::new(Self {
            items,
            _memory: memory,
        }))
    }

    /// 이 frame pointer lease가 연결된 엔진 context다.
    pub(crate) fn memory_context(&self) -> &MemoryContext {
        self._memory.context()
    }

    /// slice의 `Arc<Drawing>` pointer만 지정 account에 fallible 복제한다.
    pub fn try_clone_slice(
        items: &[Arc<Drawing>],
        memory: &MemoryContext,
    ) -> Result<Arc<Self>, JsError> {
        let (items, group) = memory.try_clone_slice(items).map_err(memory_error)?;
        Self::try_from_vec(items, group)
    }
}

impl Deref for DrawingFrame {
    type Target = [Arc<Drawing>];

    fn deref(&self) -> &Self::Target {
        &self.items
    }
}

impl AsRef<[Arc<Drawing>]> for DrawingFrame {
    fn as_ref(&self) -> &[Arc<Drawing>] {
        &self.items
    }
}

/// 불변 스냅샷과 공유하는 드로잉 프레임이다.
pub type DrawingSnapshot = Arc<DrawingFrame>;

/// undo/redo pointer 벡터와 lease를 함께 이동하는 실제 컨테이너다.
#[derive(Debug)]
pub struct DrawingSnapshotList {
    frames: Vec<DrawingSnapshot>,
    memory: MemoryGroup,
}

impl DrawingSnapshotList {
    /// 이미 fallible allocation한 snapshot pointer 벡터와 lease를 채택한다.
    pub fn try_from_vec(
        frames: Vec<DrawingSnapshot>,
        mut memory: MemoryGroup,
    ) -> Result<Self, JsError> {
        if frames
            .iter()
            .any(|frame| !memory.context().shares_account(frame.memory_context()))
        {
            return Err(type_error("Drawing history memory context"));
        }
        let bytes = frames
            .capacity()
            .checked_mul(size_of::<DrawingSnapshot>())
            .ok_or_else(|| memory.context().allocation_failure().into_js_error())?;
        memory.try_resize(bytes).map_err(memory_error)?;
        Ok(Self { frames, memory })
    }

    fn empty(memory: &MemoryContext) -> Self {
        Self {
            frames: Vec::new(),
            memory: MemoryGroup::empty(memory.clone()),
        }
    }

    fn try_clone_with_extra(
        &self,
        extra: Option<DrawingSnapshot>,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let length = self
            .frames
            .len()
            .checked_add(usize::from(extra.is_some()))
            .ok_or_else(|| memory.allocation_failure().into_js_error())?;
        let (mut frames, group) = memory.try_vec_capacity(length).map_err(memory_error)?;
        frames.extend(self.frames.iter().cloned());
        frames.extend(extra);
        Self::try_from_vec(frames, group)
    }

    fn try_clone_prefix(&self, length: usize, memory: &MemoryContext) -> Result<Self, JsError> {
        let (frames, group) = memory
            .try_clone_slice(&self.frames[..length])
            .map_err(memory_error)?;
        Self::try_from_vec(frames, group)
    }

    fn remove_first(&mut self) -> Option<DrawingSnapshot> {
        (!self.frames.is_empty()).then(|| self.frames.remove(0))
    }

    fn memory_context(&self) -> &MemoryContext {
        self.memory.context()
    }
}

impl Deref for DrawingSnapshotList {
    type Target = [DrawingSnapshot];

    fn deref(&self) -> &Self::Target {
        &self.frames
    }
}

/// 변경 가능한 드로잉 소유자다. 공개된 레코드와 이력 스냅샷은 모두 불변이다.
pub struct DrawingStore {
    identity: Arc<()>,
    containers_identity: Arc<()>,
    pub(crate) items: DrawingSnapshot,
    pub(crate) undo_stack: DrawingSnapshotList,
    pub(crate) redo_stack: DrawingSnapshotList,
    pub(crate) transaction: Option<DrawingSnapshot>,
    pub(crate) selected: Option<JsString>,
    selected_memory: MemoryGroup,
    pub(crate) serial: u64,
    pub(crate) config: DrawingStoreConfig,
    pub(crate) retained_history_bytes: usize,
    pub(crate) dialect: NumberDialect,
    memory: MemoryContext,
}

/// Workspace source가 drawing store/container identity와 sourceRefs scalar를 보존하는 token이다.
pub struct DrawingWorkspaceCaptureToken {
    identity: Arc<()>,
    containers_identity: Arc<()>,
    selected: Option<JsString>,
    _selected_memory: MemoryGroup,
    serial: u64,
    transaction_active: bool,
}

/// Reply admission 전에 준비한 frame/history publication이다.
struct PreparedDrawingPublication {
    items: DrawingSnapshot,
    undo: Option<DrawingSnapshotList>,
    redo: Option<DrawingSnapshotList>,
    transaction: Option<DrawingSnapshot>,
    retained_history_bytes: usize,
    containers_identity: Arc<()>,
    clear_selected: bool,
}

/// Interaction cancel이 reply admission 전에 준비하는 transaction 복원 후보다.
pub struct PreparedDrawingCancel {
    items: DrawingSnapshot,
    containers_identity: Arc<()>,
    clear_selected: bool,
}

impl DrawingStore {
    /// 현재 painter 순서의 불변 drawing 레코드를 할당 없이 빌린다.
    pub fn items(&self) -> &[Arc<Drawing>] {
        self.items.as_ref().as_ref()
    }

    /// 기존 테스트가 쓰는 비회계 context에서 빈 저장소를 만든다.
    pub fn new(config: DrawingStoreConfig, dialect: NumberDialect) -> Result<Self, JsError> {
        Self::new_with_memory(
            config,
            dialect,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
    }

    /// 한도를 확인한 뒤 지정 엔진 memory context에 빈 저장소를 만든다.
    pub fn new_with_memory(
        config: DrawingStoreConfig,
        dialect: NumberDialect,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        validate_config(config)?;
        let items = DrawingFrame::try_clone_slice(&[], &memory)?;
        Ok(Self {
            identity: Arc::new(()),
            containers_identity: Arc::new(()),
            items,
            undo_stack: DrawingSnapshotList::empty(&memory),
            redo_stack: DrawingSnapshotList::empty(&memory),
            transaction: None,
            selected: None,
            selected_memory: MemoryGroup::empty(memory.clone()),
            serial: 0,
            config,
            retained_history_bytes: 0,
            dialect,
            memory,
        })
    }

    /// JS 기본값과 지정한 수 방언으로 빈 저장소를 만든다.
    pub fn with_defaults(dialect: NumberDialect) -> Self {
        Self::new(DrawingStoreConfig::default(), dialect).expect("valid drawing defaults")
    }

    /// JS 기본값과 explicit 엔진 memory context로 빈 저장소를 만든다.
    pub fn with_defaults_and_memory(
        dialect: NumberDialect,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        Self::new_with_memory(DrawingStoreConfig::default(), dialect, memory)
    }

    /// JS 생성자 옵션 레코드에서 저장소를 만든다.
    pub fn from_options(options: &JsValue, dialect: NumberDialect) -> Result<Self, JsError> {
        Self::from_options_with_memory(
            options,
            dialect,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
    }

    /// JS 생성자 옵션 레코드와 explicit 엔진 memory context에서 저장소를 만든다.
    pub fn from_options_with_memory(
        options: &JsValue,
        dialect: NumberDialect,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        let Some(options) = object(options) else {
            return Err(type_error("Drawing store options required"));
        };
        let defaults = DrawingStoreConfig::default();
        let history_limit = match options.get(&key("historyLimit")) {
            None | Some(JsValue::Undefined) => defaults.history_limit,
            Some(JsValue::Number(value))
                if value.is_finite()
                    && value.fract() == 0.0
                    && *value >= 1.0
                    && *value <= 10_000.0 =>
            {
                *value as usize
            }
            Some(_) => return Err(range_error("History limit 1..10000")),
        };
        let max_drawings = config_option(
            options,
            "maxDrawings",
            defaults.max_drawings as u64,
            defaults.max_drawings as u64,
        )? as usize;
        let max_points =
            config_option(options, "maxPoints", defaults.max_points as u64, 2_097_152)? as usize;
        let max_document_chars = config_option(
            options,
            "maxDocumentChars",
            RESOURCE_LIMITS.max_document_chars,
            RESOURCE_LIMITS.max_document_chars,
        )? as usize;
        let history_bytes = config_option(
            options,
            "historyBytes",
            RESOURCE_LIMITS.max_history_bytes,
            RESOURCE_LIMITS.max_history_bytes,
        )? as usize;
        Self::new_with_memory(
            DrawingStoreConfig {
                history_limit,
                max_drawings,
                max_points,
                max_document_chars,
                history_bytes,
            },
            dialect,
            memory,
        )
    }

    /// 현재 불변 드로잉 프레임을 allocation 없이 공유한다.
    pub fn snapshot(&self) -> DrawingSnapshot {
        Arc::clone(&self.items)
    }

    /// 이 저장소의 persistent/temporary allocation이 쓰는 엔진 context다.
    pub fn memory_context(&self) -> &MemoryContext {
        &self.memory
    }

    /// 설정된 저장소 한도를 반환한다.
    pub fn config(&self) -> DrawingStoreConfig {
        self.config
    }

    /// 현재 선택된 드로잉 ID를 반환한다.
    pub fn selected(&self) -> Option<&JsString> {
        self.selected.as_ref()
    }

    /// 내부 편집 게시가 선택 값과 그 lease를 함께 비운다.
    pub(crate) fn clear_selection(&mut self) {
        self.selected = None;
        self.selected_memory = MemoryGroup::empty(self.memory.clone());
    }

    /// 생성 ID에 사용하는 단조 증가 serial을 반환한다.
    pub fn serial(&self) -> u64 {
        self.serial
    }

    /// 활성 트랜잭션이 있으면 시작 시점의 불변 프레임을 반환한다.
    pub fn transaction(&self) -> Option<&DrawingSnapshot> {
        self.transaction.as_ref()
    }

    /// 오래된 순서부터 최근 순서대로 undo 프레임을 반환한다.
    pub fn undo_stack(&self) -> &[DrawingSnapshot] {
        &self.undo_stack.frames
    }

    /// 오래된 순서부터 최근 순서대로 redo 프레임을 반환한다.
    pub fn redo_stack(&self) -> &[DrawingSnapshot] {
        &self.redo_stack.frames
    }

    /// 보관 중인 이력 바이트 수를 반환한다.
    pub fn retained_history_bytes(&self) -> usize {
        self.retained_history_bytes
    }

    /// Workspace source가 drawing owner/container/scalar를 고정한다.
    pub fn capture_workspace_state(&self) -> Result<DrawingWorkspaceCaptureToken, JsError> {
        let selected = self
            .selected
            .as_ref()
            .map(|selected| clone_persistent_text(selected, &self.memory))
            .transpose()?;
        let (selected, selected_memory) = selected
            .map(|(selected, memory)| (Some(selected), memory))
            .unwrap_or_else(|| (None, MemoryGroup::empty(self.memory.clone())));
        Ok(DrawingWorkspaceCaptureToken {
            identity: Arc::clone(&self.identity),
            containers_identity: Arc::clone(&self.containers_identity),
            selected,
            _selected_memory: selected_memory,
            serial: self.serial,
            transaction_active: self.transaction.is_some(),
        })
    }

    /// Capture 뒤 sourceRefs가 관찰하는 drawing state가 그대로인지 본다.
    pub fn validate_workspace_state(&self, token: &DrawingWorkspaceCaptureToken) -> bool {
        Arc::ptr_eq(&self.identity, &token.identity)
            && Arc::ptr_eq(&self.containers_identity, &token.containers_identity)
            && self.selected == token.selected
            && self.serial == token.serial
            && self.transaction.is_some() == token.transaction_active
    }

    fn rotate_containers_identity(&mut self) {
        self.containers_identity = Arc::new(());
    }

    fn prepare_frame_publication(
        &self,
        items: DrawingSnapshot,
        clear_selected: bool,
    ) -> Result<PreparedDrawingPublication, JsError> {
        let transaction = self.transaction.clone();
        if transaction.is_some() {
            return Ok(PreparedDrawingPublication {
                items,
                undo: None,
                redo: None,
                transaction,
                retained_history_bytes: self.retained_history_bytes,
                containers_identity: Arc::new(()),
                clear_selected,
            });
        }
        let mut undo = self
            .undo_stack
            .try_clone_with_extra(Some(self.snapshot()), &self.memory)?;
        let mut redo = DrawingSnapshotList::empty(&self.memory);
        let retained = trim_history_candidates(
            &mut undo,
            &mut redo,
            self.config,
            self.dialect,
            &self.memory,
        )?;
        Ok(PreparedDrawingPublication {
            items,
            undo: Some(undo),
            redo: Some(redo),
            transaction: None,
            retained_history_bytes: retained,
            containers_identity: Arc::new(()),
            clear_selected,
        })
    }

    fn prepare_frame_publication_after_cancel(
        &self,
        items: DrawingSnapshot,
        clear_selected: bool,
    ) -> Result<PreparedDrawingPublication, JsError> {
        let baseline = self.transaction.clone().unwrap_or_else(|| self.snapshot());
        let mut undo = self
            .undo_stack
            .try_clone_with_extra(Some(baseline), &self.memory)?;
        let mut redo = DrawingSnapshotList::empty(&self.memory);
        let retained = trim_history_candidates(
            &mut undo,
            &mut redo,
            self.config,
            self.dialect,
            &self.memory,
        )?;
        Ok(PreparedDrawingPublication {
            items,
            undo: Some(undo),
            redo: Some(redo),
            transaction: None,
            retained_history_bytes: retained,
            containers_identity: Arc::new(()),
            clear_selected,
        })
    }

    fn publish_prepared_frame(&mut self, prepared: PreparedDrawingPublication) {
        self.items = prepared.items;
        if let Some(undo) = prepared.undo {
            self.undo_stack = undo;
        }
        if let Some(redo) = prepared.redo {
            self.redo_stack = redo;
        }
        self.transaction = prepared.transaction;
        self.retained_history_bytes = prepared.retained_history_bytes;
        self.containers_identity = prepared.containers_identity;
        if prepared.clear_selected {
            self.selected = None;
            self.selected_memory = MemoryGroup::empty(self.memory.clone());
        }
    }

    /// 현재 공유 프레임에서 드로잉 트랜잭션을 시작한다.
    pub fn begin(&mut self) -> Result<(), JsError> {
        if self.transaction.is_some() {
            return Err(error("Error", "A drawing transaction is already active"));
        }
        self.transaction = Some(self.snapshot());
        Ok(())
    }

    /// 길이나 드로잉 레코드 식별성이 바뀐 경우에만 트랜잭션을 fallible 커밋한다.
    pub fn commit(&mut self) -> Result<(), JsError> {
        let Some(before) = self.transaction.as_ref().cloned() else {
            return Ok(());
        };
        if !same_frame_identity(&before, &self.items) {
            let mut undo = self
                .undo_stack
                .try_clone_with_extra(Some(before), &self.memory)?;
            let mut redo = DrawingSnapshotList::empty(&self.memory);
            let retained = trim_history_candidates(
                &mut undo,
                &mut redo,
                self.config,
                self.dialect,
                &self.memory,
            )?;
            self.undo_stack = undo;
            self.redo_stack = redo;
            self.retained_history_bytes = retained;
        }
        self.transaction = None;
        Ok(())
    }

    /// 트랜잭션의 원래 프레임을 복원하고 숨겨지거나 삭제된 선택을 해제한다.
    pub fn cancel(&mut self) {
        let Some(prepared) = self.prepare_cancel() else {
            return;
        };
        self.publish_prepared_cancel(prepared);
    }

    /// 활성 transaction 복원과 새 container identity를 admission 전에 준비한다.
    pub fn prepare_cancel(&self) -> Option<PreparedDrawingCancel> {
        let before = self.transaction.as_ref()?.clone();
        let clear_selected = self.selected.as_ref().is_some_and(|selected| {
            !before
                .iter()
                .any(|drawing| drawing.id == *selected && drawing.visible != Some(false))
        });
        Some(PreparedDrawingCancel {
            items: before,
            containers_identity: Arc::new(()),
            clear_selected,
        })
    }

    /// 준비한 transaction 복원을 추가 allocation 없이 게시한다.
    pub fn publish_prepared_cancel(&mut self, prepared: PreparedDrawingCancel) {
        self.items = prepared.items;
        self.transaction = None;
        self.containers_identity = prepared.containers_identity;
        if prepared.clear_selected {
            self.selected = None;
            self.selected_memory = MemoryGroup::empty(self.memory.clone());
        }
    }

    /// JS와 같은 기본 레코드 및 생성 ID 정책을 적용해 드로잉을 추가한다.
    pub fn add(&mut self, input: &JsValue) -> Result<JsString, JsError> {
        let baseline = self.snapshot();
        self.add_from_snapshot(input, &baseline, |_| Ok(()))
    }

    /// 검증된 API call-entry 프레임을 기준으로 후보를 만든 뒤 mutation hook과 게시를 수행한다.
    pub(crate) fn add_from_snapshot(
        &mut self,
        input: &JsValue,
        baseline: &DrawingSnapshot,
        before_mutation: impl FnOnce(&mut Self) -> Result<(), JsError>,
    ) -> Result<JsString, JsError> {
        let mut scope = self.memory.scope();
        option_record_scoped(
            input,
            &[
                "id", "type", "panel", "points", "style", "text", "locked", "visible", "axisId",
                "seriesId",
            ],
            "Drawing",
            &mut scope,
        )?;
        let input_record = object(input).ok_or_else(|| type_error("Drawing: object required"))?;
        let mut serial = self.serial;
        let mut id = match input_record.get(&key("id")) {
            Some(value) if !js_falsy(value) => match value {
                JsValue::String(id) => id.try_clone_scoped(&mut scope).map_err(memory_error)?,
                _ => return Err(type_error("Drawing id: string limit 128")),
            },
            _ => loop {
                serial = serial
                    .checked_add(1)
                    .ok_or_else(|| range_error("Drawing serial limit"))?;
                let candidate = JsString::try_from_str(&format!("drawing-{serial}"), &mut scope)
                    .map_err(memory_error)?;
                if !baseline.iter().any(|drawing| drawing.id == candidate) {
                    break candidate;
                }
            },
        };

        let style = JsObject::try_from_entries_scoped(
            [
                (
                    JsString::try_from_str("color", &mut scope).map_err(memory_error)?,
                    JsValue::String(
                        JsString::try_from_str("#f5b85a", &mut scope).map_err(memory_error)?,
                    ),
                ),
                (
                    JsString::try_from_str("width", &mut scope).map_err(memory_error)?,
                    JsValue::Number(1.5),
                ),
            ],
            &mut scope,
        )
        .map_err(memory_error)?;
        let mut entries = scoped_entries(input_record.len().saturating_add(5), &mut scope)?;
        entries.push((
            JsString::try_from_str("id", &mut scope).map_err(memory_error)?,
            JsValue::String(id.try_clone_scoped(&mut scope).map_err(memory_error)?),
        ));
        entries.push((
            JsString::try_from_str("panel", &mut scope).map_err(memory_error)?,
            JsValue::String(JsString::try_from_str("price", &mut scope).map_err(memory_error)?),
        ));
        entries.push((
            JsString::try_from_str("locked", &mut scope).map_err(memory_error)?,
            JsValue::Bool(false),
        ));
        entries.push((
            JsString::try_from_str("style", &mut scope).map_err(memory_error)?,
            JsValue::Object(style),
        ));
        let mut points_source = None;
        let mut points_lookup = None;
        for (field, value) in input_record.iter() {
            let key = field.try_clone_scoped(&mut scope).map_err(memory_error)?;
            let value = if "points".encode_utf16().eq(field.as_units().iter().copied()) {
                points_source = Some(value);
                points_lookup = Some(key.try_clone_scoped(&mut scope).map_err(memory_error)?);
                JsValue::Undefined
            } else {
                value.try_clone_scoped(&mut scope).map_err(memory_error)?
            };
            entries.push((key, value));
        }
        entries.push((
            JsString::try_from_str("id", &mut scope).map_err(memory_error)?,
            JsValue::String(id.try_clone_scoped(&mut scope).map_err(memory_error)?),
        ));
        let mut raw =
            JsObject::try_from_entries_scoped(entries, &mut scope).map_err(memory_error)?;
        if let Some(points) = points_source {
            *raw.get_mut(
                points_lookup
                    .as_ref()
                    .expect("drawing points placeholder key exists"),
            )
            .expect("drawing points placeholder exists") =
                points.try_clone_scoped(&mut scope).map_err(memory_error)?;
        }
        let raw = JsValue::Object(raw);
        let drawing = Arc::new(crate::drawing_validation::canonical_drawing_scoped(
            &raw,
            self.dialect,
            &self.memory,
            &mut scope,
        )?);
        id = drawing.id.clone();
        if baseline.iter().any(|current| current.id == id) {
            return Err(error("Error", "Duplicate drawing id"));
        }
        let next = frame_with_extra(baseline, drawing.clone(), &self.memory)?;
        enforce_drawing_budget(&next, self.document_limits())?;
        let selected = if drawing.visible != Some(false) {
            Some(clone_persistent_text(&id, &self.memory)?)
        } else {
            None
        };
        before_mutation(self)?;
        self.publish_mutation(next, |store| {
            if let Some((selected, memory)) = selected {
                store.selected = Some(selected);
                store.selected_memory = memory;
            }
            store.serial = serial;
        })?;
        Ok(id)
    }

    /// 레코드 하나를 편집한다. 양쪽을 한 번씩 직렬화하고 필요하면 정규 키 순서로 다시 비교한다.
    pub fn edit(&mut self, id: &JsString, patch: &JsValue) -> Result<(), JsError> {
        self.edit_with_reply_gate(id, patch, &mut || Ok(()))
    }

    /// 레코드와 history 후보를 모두 준비한 뒤 고정 reply admission 직전에 게시한다.
    pub fn edit_with_reply_gate(
        &mut self,
        id: &JsString,
        patch: &JsValue,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let baseline = self.snapshot();
        self.edit_from_snapshot_with_reply_gate(id, patch, &baseline, |_| Ok(()), gate)
    }

    /// API call-entry frame에서 edit/history를 전부 준비한 뒤 reply admission 직전에 게시한다.
    pub(crate) fn edit_from_snapshot_with_reply_gate(
        &mut self,
        id: &JsString,
        patch: &JsValue,
        baseline: &DrawingSnapshot,
        before_mutation: impl FnOnce(&mut Self) -> Result<(), JsError>,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        self.edit_from_snapshot_with_store_reply_gate(
            id,
            patch,
            baseline,
            before_mutation,
            false,
            &mut |_| gate(),
        )
    }

    /// Edit/history 후보 뒤 DrawingStore를 빌려 복합 cancel/reply gate를 게시한다.
    pub(crate) fn edit_from_snapshot_with_store_reply_gate(
        &mut self,
        id: &JsString,
        patch: &JsValue,
        baseline: &DrawingSnapshot,
        before_mutation: impl FnOnce(&mut Self) -> Result<(), JsError>,
        cancel_transaction_before_publish: bool,
        gate: &mut dyn FnMut(&mut Self) -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let mut scope = self.memory.scope();
        option_record_scoped(
            patch,
            &[
                "type", "panel", "points", "style", "text", "locked", "visible", "axisId",
                "seriesId",
            ],
            "Drawing patch",
            &mut scope,
        )?;
        let patch = object(patch).ok_or_else(|| type_error("Drawing patch: object required"))?;
        let Some(index) = baseline.iter().position(|drawing| drawing.id == *id) else {
            return Err(error("Error", "Missing drawing"));
        };
        let previous = &baseline[index];
        if previous.locked == Some(true)
            && patch
                .iter()
                .any(|(field, _)| field != &key("locked") && field != &key("visible"))
        {
            return Err(error("Error", "Drawing is locked"));
        }

        let previous_value = canonical_drawing_value_scoped(previous, &mut scope)?;
        let previous_record = object(&previous_value).expect("drawing record serializes as object");
        let mut entries = scoped_entries(
            previous_record.len().saturating_add(patch.len()),
            &mut scope,
        )?;
        let mut points_source = None;
        let mut points_lookup = None;
        for (field, value) in previous_record.iter() {
            push_record_entry_deferred(
                &mut entries,
                field,
                value,
                &mut points_source,
                &mut points_lookup,
                &mut scope,
            )?;
        }
        for (field, value) in patch.iter() {
            push_record_entry_deferred(
                &mut entries,
                field,
                value,
                &mut points_source,
                &mut points_lookup,
                &mut scope,
            )?;
        }
        let mut next_record =
            JsObject::try_from_entries_scoped(entries, &mut scope).map_err(memory_error)?;
        if let Some(points) = points_source {
            *next_record
                .get_mut(
                    points_lookup
                        .as_ref()
                        .expect("drawing points placeholder key exists"),
                )
                .expect("drawing points placeholder exists") =
                points.try_clone_scoped(&mut scope).map_err(memory_error)?;
        }
        let next_value = JsValue::Object(next_record);
        let _next_validated = validate_drawing_with_memory(&next_value, &self.memory)?;
        drop(_next_validated);
        let previous_text = stringify_scoped(&previous_value, self.dialect, &mut scope)?;
        let next_text = stringify_scoped(&next_value, self.dialect, &mut scope)?;
        if previous_text == next_text {
            gate(self)?;
            before_mutation(self)?;
            return Ok(());
        }
        if utf16_len(&previous_text) == utf16_len(&next_text) {
            let parsed =
                parse_json_scoped(&next_text, JsonMode::Standard, self.dialect, &mut scope)
                    .map_err(json_failure)?;
            let canonical = canonicalize_drawing_value_scoped(&parsed, &mut scope)?;
            if previous_text == stringify_scoped(&canonical, self.dialect, &mut scope)? {
                gate(self)?;
                before_mutation(self)?;
                return Ok(());
            }
        }

        let copied = copy_drawing_value_scoped(&next_value, self.dialect, &mut scope)?;
        let canonical = canonicalize_drawing_value_scoped(&copied, &mut scope)?;
        let mut next_value = validate_drawing_with_memory(&canonical, &self.memory)?;
        if patch.get(&key("points")).is_none() {
            next_value.points = previous.points.clone();
        }
        if patch.get(&key("style")).is_none() {
            next_value.style = previous.style.clone();
        }
        let next = Arc::new(next_value);
        let changed = frame_with_replacement(baseline, index, next.clone(), &self.memory)?;
        enforce_drawing_budget(&changed, self.document_limits())?;
        let clear_selected = next.visible == Some(false) && self.selected.as_ref() == Some(id);
        let prepared = if cancel_transaction_before_publish {
            self.prepare_frame_publication_after_cancel(changed, clear_selected)?
        } else {
            self.prepare_frame_publication(changed, clear_selected)?
        };
        gate(self)?;
        before_mutation(self)?;
        self.publish_prepared_frame(prepared);
        Ok(())
    }

    /// 잠기지 않은 드로잉을 제거하고 해당 선택을 해제한다.
    pub fn remove(&mut self, id: &JsString) -> Result<bool, JsError> {
        let baseline = self.snapshot();
        self.remove_from_snapshot(id, &baseline, |_| Ok(()))
    }

    /// API call-entry 프레임에서 제거 가능성을 결정한 뒤 mutation hook과 게시를 수행한다.
    pub(crate) fn remove_from_snapshot(
        &mut self,
        id: &JsString,
        baseline: &DrawingSnapshot,
        before_mutation: impl FnOnce(&mut Self) -> Result<(), JsError>,
    ) -> Result<bool, JsError> {
        let Some(index) = baseline.iter().position(|drawing| drawing.id == *id) else {
            return Ok(false);
        };
        if baseline[index].locked == Some(true) {
            return Ok(false);
        }
        let next = frame_without_index(baseline, index, &self.memory)?;
        before_mutation(self)?;
        self.publish_mutation(next, |store| {
            if store.selected.as_ref() == Some(id) {
                store.selected = None;
                store.selected_memory = MemoryGroup::empty(store.memory.clone());
            }
        })?;
        Ok(true)
    }

    /// 표시 중인 드로잉을 선택하거나 선택을 해제한다.
    pub fn select(&mut self, id: Option<&JsString>) -> Result<(), JsError> {
        self.select_with_reply_gate(id, &mut || Ok(()))
    }

    /// 선택 값을 검증·소유한 뒤 고정 reply admission 직전에 게시한다.
    pub fn select_with_reply_gate(
        &mut self,
        id: Option<&JsString>,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        self.select_with_store_reply_gate(id, &mut |_| gate())
    }

    /// 선택 후보 뒤 DrawingStore를 빌려 복합 cancel/reply gate를 게시한다.
    pub(crate) fn select_with_store_reply_gate(
        &mut self,
        id: Option<&JsString>,
        gate: &mut dyn FnMut(&mut Self) -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        if let Some(id) = id
            && !self
                .items
                .iter()
                .any(|drawing| drawing.id == *id && drawing.visible != Some(false))
        {
            return Err(error("Error", "Missing or hidden drawing"));
        }
        let selected = id
            .map(|id| clone_persistent_text(id, &self.memory))
            .transpose()?;
        gate(self)?;
        match selected {
            Some((selected, memory)) => {
                self.selected = Some(selected);
                self.selected_memory = memory;
            }
            None => {
                self.selected = None;
                self.selected_memory = MemoryGroup::empty(self.memory.clone());
            }
        }
        Ok(())
    }

    /// 저장된 포지션 드로잉의 지표를 반환한다.
    pub fn position_metrics(&self, id: &JsString) -> Result<PositionMetrics, JsError> {
        let Some(drawing) = self.items.iter().find(|drawing| drawing.id == *id) else {
            return Err(type_error("Position drawing required"));
        };
        if !drawing.kind.is_position() {
            return Err(type_error("Position drawing required"));
        }
        position_metrics_for(drawing)
    }

    /// 현재 프레임을 최소 버전의 정규 문서로 저장한다.
    pub fn save(&self) -> Result<JsString, JsError> {
        save_drawing_document(
            &self.items,
            self.config.max_document_chars,
            self.dialect,
            self.transaction.is_some(),
        )
    }

    /// 현재 프레임 문서와 그 output lease를 explicit 엔진 account에서 만든다.
    pub fn save_with_memory(&self) -> Result<(JsString, MemoryGroup), JsError> {
        save_drawing_document_with_memory(
            &self.items,
            self.config.max_document_chars,
            self.dialect,
            self.transaction.is_some(),
            &self.memory,
        )
    }

    /// 전체 문서를 원자적으로 검증하고 불러온다.
    pub fn load(
        &mut self,
        text: &JsString,
        context: &DrawingDocumentContext<'_>,
    ) -> Result<(), JsError> {
        self.load_with_reply_gate(text, context, &mut || Ok(()))
    }

    /// 문서를 전부 검증·history stage한 뒤 고정 reply admission 직전에 게시한다.
    pub fn load_with_reply_gate(
        &mut self,
        text: &JsString,
        context: &DrawingDocumentContext<'_>,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        self.load_with_store_reply_gate(text, context, &mut |_| gate())
    }

    /// 문서/history 후보 뒤 DrawingStore를 빌려 복합 cancel/reply gate를 게시한다.
    pub(crate) fn load_with_store_reply_gate(
        &mut self,
        text: &JsString,
        context: &DrawingDocumentContext<'_>,
        gate: &mut dyn FnMut(&mut Self) -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let (drawings, memory) = load_drawing_document_with_memory(
            text,
            self.document_limits(),
            self.dialect,
            context,
            self.transaction.is_some(),
            &self.memory,
        )?;
        let drawings = DrawingFrame::try_from_vec(drawings, memory)?;
        let prepared = self.prepare_frame_publication(drawings, true)?;
        gate(self)?;
        self.publish_prepared_frame(prepared);
        Ok(())
    }

    /// Workspace target이 이미 문서 검증과 budget 검사를 마친 immutable items를
    /// 새 차트의 초기 drawing state로 설치한다. 실패 전에는 기존 상태를 건드리지 않는다.
    #[allow(dead_code)] // Root가 native_workspace_target module을 lib.rs에 연결하면 직접 사용된다.
    pub(crate) fn install_workspace_items(
        &mut self,
        drawings: Vec<Arc<Drawing>>,
    ) -> Result<(), JsError> {
        enforce_drawing_budget(&drawings, self.document_limits())?;
        let drawings = DrawingFrame::try_clone_slice(&drawings, &self.memory)?;
        self.install_workspace_frame(drawings)
    }

    /// Workspace target이 같은 account에서 만든 immutable frame을 재청구 없이 채택한다.
    pub(crate) fn install_workspace_frame(
        &mut self,
        drawings: DrawingSnapshot,
    ) -> Result<(), JsError> {
        if !self.memory.shares_account(drawings.memory_context()) {
            return Err(type_error("Workspace drawing memory context"));
        }
        enforce_drawing_budget(&drawings, self.document_limits())?;
        self.items = drawings;
        self.rotate_containers_identity();
        self.undo_stack = DrawingSnapshotList::empty(&self.memory);
        self.redo_stack = DrawingSnapshotList::empty(&self.memory);
        self.transaction = None;
        self.selected = None;
        self.selected_memory = MemoryGroup::empty(self.memory.clone());
        self.serial = 0;
        self.retained_history_bytes = 0;
        Ok(())
    }

    /// Detached async UI import가 검증한 immutable current/history frames를 한 번에 채택한다.
    pub(crate) fn install_native_ui_history(
        &mut self,
        items: DrawingSnapshot,
        undo: DrawingSnapshotList,
        redo: DrawingSnapshotList,
        selected: Option<JsString>,
        serial: u64,
    ) -> Result<(), JsError> {
        if !self.memory.shares_account(items.memory_context())
            || !self.memory.shares_account(undo.memory_context())
            || !self.memory.shares_account(redo.memory_context())
        {
            return Err(type_error("Async drawing memory context"));
        }
        if undo.len() > self.config.history_limit || redo.len() > self.config.history_limit {
            return Err(type_error("Async drawing history"));
        }
        enforce_drawing_budget(&items, self.document_limits())?;
        for frame in undo.iter().chain(redo.iter()) {
            enforce_drawing_budget(frame, self.document_limits())?;
        }
        let retained_history_bytes = history_weight(&undo, &redo, self.dialect, &self.memory)?;
        if retained_history_bytes > self.config.history_bytes {
            return Err(range_error("Async drawing history"));
        }
        if selected.as_ref().is_some_and(|selected| {
            !items
                .iter()
                .any(|drawing| drawing.id == *selected && drawing.visible != Some(false))
        }) {
            return Err(type_error("Async selection"));
        }
        let selected = selected
            .as_ref()
            .map(|selected| clone_persistent_text(selected, &self.memory))
            .transpose()?;
        self.items = items;
        self.undo_stack = undo;
        self.redo_stack = redo;
        self.transaction = None;
        match selected {
            Some((selected, memory)) => {
                self.selected = Some(selected);
                self.selected_memory = memory;
            }
            None => {
                self.selected = None;
                self.selected_memory = MemoryGroup::empty(self.memory.clone());
            }
        }
        self.serial = serial;
        self.retained_history_bytes = retained_history_bytes;
        self.rotate_containers_identity();
        Ok(())
    }

    /// Streaming UI import가 frame 경계를 넘기기 전에 current limits를 적용한다.
    pub(crate) fn validate_native_ui_frame(
        &self,
        frame: &[Arc<Drawing>],
    ) -> Result<usize, JsError> {
        enforce_drawing_budget(frame, self.document_limits())?;
        snapshot_weight(frame, self.dialect, &self.memory)
    }

    /// 가장 최근 undo 프레임을 fallible 복원하며 활성 제스처가 있으면 먼저 취소한다.
    pub fn undo(&mut self) -> Result<bool, JsError> {
        self.undo_with_reply_gate(&mut || Ok(()))
    }

    /// Undo 후보와 이력 회계를 전부 준비한 뒤 고정 reply admission 직전에 게시한다.
    pub fn undo_with_reply_gate(
        &mut self,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<bool, JsError> {
        self.undo_with_store_reply_gate(&mut |_| gate())
    }

    /// Undo 후보 뒤 DrawingStore를 빌려 복합 cancel/reply gate를 게시한다.
    pub(crate) fn undo_with_store_reply_gate(
        &mut self,
        gate: &mut dyn FnMut(&mut Self) -> Result<(), JsError>,
    ) -> Result<bool, JsError> {
        let Some(prepared) = self.prepare_history_step(false)? else {
            return Ok(false);
        };
        gate(self)?;
        self.publish_prepared_frame(prepared);
        Ok(true)
    }

    /// 가장 최근 redo 프레임을 fallible 복원하며 활성 제스처가 있으면 먼저 취소한다.
    pub fn redo(&mut self) -> Result<bool, JsError> {
        self.redo_with_reply_gate(&mut || Ok(()))
    }

    /// Redo 후보와 이력 회계를 전부 준비한 뒤 고정 reply admission 직전에 게시한다.
    pub fn redo_with_reply_gate(
        &mut self,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<bool, JsError> {
        self.redo_with_store_reply_gate(&mut |_| gate())
    }

    /// Redo 후보 뒤 DrawingStore를 빌려 복합 cancel/reply gate를 게시한다.
    pub(crate) fn redo_with_store_reply_gate(
        &mut self,
        gate: &mut dyn FnMut(&mut Self) -> Result<(), JsError>,
    ) -> Result<bool, JsError> {
        let Some(prepared) = self.prepare_history_step(true)? else {
            return Ok(false);
        };
        gate(self)?;
        self.publish_prepared_frame(prepared);
        Ok(true)
    }

    fn prepare_history_step(
        &self,
        redo: bool,
    ) -> Result<Option<PreparedDrawingPublication>, JsError> {
        let transaction = self.transaction.as_ref().cloned();
        let base_items = transaction.clone().unwrap_or_else(|| self.snapshot());
        let has_transaction = transaction.is_some();
        let target = if redo {
            self.redo_stack.last().cloned()
        } else {
            self.undo_stack.last().cloned()
        };
        if target.is_none() && !has_transaction {
            return Ok(None);
        }
        if target.is_none() {
            let clear_selected = self.selected.as_ref().is_some_and(|selected| {
                !base_items
                    .iter()
                    .any(|drawing| drawing.id == *selected && drawing.visible != Some(false))
            });
            return Ok(Some(PreparedDrawingPublication {
                items: base_items,
                undo: None,
                redo: None,
                transaction: None,
                retained_history_bytes: self.retained_history_bytes,
                containers_identity: Arc::new(()),
                clear_selected,
            }));
        }
        let target = target.expect("checked target");
        let (mut undo, mut redo_stack) = if redo {
            (
                self.undo_stack
                    .try_clone_with_extra(Some(base_items.clone()), &self.memory)?,
                self.redo_stack
                    .try_clone_prefix(self.redo_stack.len() - 1, &self.memory)?,
            )
        } else {
            (
                self.undo_stack
                    .try_clone_prefix(self.undo_stack.len() - 1, &self.memory)?,
                self.redo_stack
                    .try_clone_with_extra(Some(base_items.clone()), &self.memory)?,
            )
        };
        let retained = trim_history_candidates(
            &mut undo,
            &mut redo_stack,
            self.config,
            self.dialect,
            &self.memory,
        )?;
        Ok(Some(PreparedDrawingPublication {
            items: target,
            undo: Some(undo),
            redo: Some(redo_stack),
            transaction: None,
            retained_history_bytes: retained,
            containers_identity: Arc::new(()),
            clear_selected: true,
        }))
    }

    /// 준비한 immutable frame과 이력 후보를 모두 만든 뒤 한 번에 게시한다.
    pub(crate) fn publish_mutation(
        &mut self,
        items: DrawingSnapshot,
        operation: impl FnOnce(&mut Self),
    ) -> Result<(), JsError> {
        if self.transaction.is_some() {
            self.items = items;
            operation(self);
            self.rotate_containers_identity();
            return Ok(());
        }
        let mut undo = self
            .undo_stack
            .try_clone_with_extra(Some(self.snapshot()), &self.memory)?;
        let mut redo = DrawingSnapshotList::empty(&self.memory);
        let retained = trim_history_candidates(
            &mut undo,
            &mut redo,
            self.config,
            self.dialect,
            &self.memory,
        )?;
        self.items = items;
        self.undo_stack = undo;
        self.redo_stack = redo;
        self.retained_history_bytes = retained;
        operation(self);
        self.rotate_containers_identity();
        Ok(())
    }

    pub(crate) fn document_limits(&self) -> DrawingDocumentLimits {
        DrawingDocumentLimits {
            max_drawings: self.config.max_drawings,
            max_points: self.config.max_points,
            max_document_chars: self.config.max_document_chars,
        }
    }
}

fn validate_config(config: DrawingStoreConfig) -> Result<(), JsError> {
    if !(1..=10_000).contains(&config.history_limit) {
        return Err(range_error("History limit 1..10000"));
    }
    for (value, max, label) in [
        (config.max_drawings, 10_000, "maxDrawings"),
        (config.max_points, 2_097_152, "maxPoints"),
        (
            config.max_document_chars,
            RESOURCE_LIMITS.max_document_chars as usize,
            "maxDocumentChars",
        ),
        (
            config.history_bytes,
            RESOURCE_LIMITS.max_history_bytes as usize,
            "historyBytes",
        ),
    ] {
        if value > max {
            return Err(range_error(&format!("{label}: limit {max}")));
        }
    }
    Ok(())
}

fn config_option(
    options: &JsObject,
    field: &str,
    default: u64,
    maximum: u64,
) -> Result<u64, JsError> {
    let Some(value) = options.get(&key(field)) else {
        return Ok(default);
    };
    if matches!(value, JsValue::Undefined) {
        return Ok(default);
    }
    Ok(size_limit(value, maximum, field)? as u64)
}

fn same_frame_identity(previous: &[Arc<Drawing>], current: &[Arc<Drawing>]) -> bool {
    previous.len() == current.len()
        && previous
            .iter()
            .zip(current)
            .all(|(left, right)| Arc::ptr_eq(left, right))
}

fn frame_with_extra(
    baseline: &[Arc<Drawing>],
    drawing: Arc<Drawing>,
    memory: &MemoryContext,
) -> Result<DrawingSnapshot, JsError> {
    let length = baseline
        .len()
        .checked_add(1)
        .ok_or_else(|| memory.allocation_failure().into_js_error())?;
    let (mut items, group) = memory.try_vec_capacity(length).map_err(memory_error)?;
    items.extend(baseline.iter().cloned());
    items.push(drawing);
    DrawingFrame::try_from_vec(items, group)
}

fn frame_with_replacement(
    baseline: &[Arc<Drawing>],
    index: usize,
    drawing: Arc<Drawing>,
    memory: &MemoryContext,
) -> Result<DrawingSnapshot, JsError> {
    let (mut items, group) = memory.try_clone_slice(baseline).map_err(memory_error)?;
    items[index] = drawing;
    DrawingFrame::try_from_vec(items, group)
}

fn frame_without_index(
    baseline: &[Arc<Drawing>],
    index: usize,
    memory: &MemoryContext,
) -> Result<DrawingSnapshot, JsError> {
    let length = baseline.len() - 1;
    let (mut items, group) = memory.try_vec_capacity(length).map_err(memory_error)?;
    items.extend(baseline[..index].iter().cloned());
    items.extend(baseline[index + 1..].iter().cloned());
    DrawingFrame::try_from_vec(items, group)
}

fn snapshot_weight(
    snapshot: &[Arc<Drawing>],
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut bytes = snapshot.len().saturating_mul(8);
    for drawing in snapshot {
        let mut scope = memory.scope();
        let value = drawing.to_value_scoped(&mut scope)?;
        let text = stringify_scoped(&value, dialect, &mut scope)?;
        bytes = bytes.saturating_add(2usize.saturating_mul(utf16_len(&text)));
    }
    Ok(bytes)
}

fn history_weight(
    undo: &[DrawingSnapshot],
    redo: &[DrawingSnapshot],
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut bytes = 0usize;
    for snapshot in undo.iter().chain(redo) {
        bytes = bytes.saturating_add(snapshot_weight(snapshot, dialect, memory)?);
    }
    Ok(bytes)
}

fn trim_history_candidates(
    undo: &mut DrawingSnapshotList,
    redo: &mut DrawingSnapshotList,
    config: DrawingStoreConfig,
    dialect: NumberDialect,
    memory: &MemoryContext,
) -> Result<usize, JsError> {
    let mut bytes = history_weight(undo, redo, dialect, memory)?;
    while undo.len() > config.history_limit || bytes > config.history_bytes {
        let old = undo.remove_first().or_else(|| redo.remove_first());
        let Some(old) = old else {
            break;
        };
        bytes = bytes.saturating_sub(snapshot_weight(&old, dialect, memory)?);
    }
    Ok(bytes)
}

fn clone_persistent_text(
    value: &JsString,
    memory: &MemoryContext,
) -> Result<(JsString, MemoryGroup), JsError> {
    let mut scope = memory.scope();
    let value = value.try_clone_scoped(&mut scope).map_err(memory_error)?;
    let requested = usize::try_from(scope.requested_bytes())
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    let group = scope.split_persistent(requested).map_err(memory_error)?;
    Ok((value, group))
}

fn scoped_entries(
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<(JsString, JsValue)>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<(JsString, JsValue)>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(entries)
}

fn push_record_entry_deferred<'a>(
    entries: &mut Vec<(JsString, JsValue)>,
    field: &JsString,
    value: &'a JsValue,
    points_source: &mut Option<&'a JsValue>,
    points_lookup: &mut Option<JsString>,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let key = field.try_clone_scoped(scope).map_err(memory_error)?;
    let value = if "points".encode_utf16().eq(field.as_units().iter().copied()) {
        *points_source = Some(value);
        *points_lookup = Some(key.try_clone_scoped(scope).map_err(memory_error)?);
        JsValue::Undefined
    } else {
        value.try_clone_scoped(scope).map_err(memory_error)?
    };
    entries.push((key, value));
    Ok(())
}

fn stringify_scoped(
    value: &JsValue,
    dialect: NumberDialect,
    scope: &mut MemoryScope,
) -> Result<Vec<u8>, JsError> {
    stringify_json_scoped(value, JsonMode::Standard, dialect, scope).map_err(memory_error)
}

fn utf16_len(bytes: &[u8]) -> usize {
    std::str::from_utf8(bytes)
        .expect("JSON writer emits valid UTF-8")
        .encode_utf16()
        .count()
}

fn js_falsy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null | JsValue::Bool(false) => true,
        JsValue::Number(value) => *value == 0.0 || value.is_nan(),
        JsValue::String(value) => value.as_units().is_empty(),
        JsValue::Bool(true) | JsValue::Array(_) | JsValue::Object(_) => false,
    }
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn json_failure(failure: JsonFailure) -> JsError {
    match failure {
        JsonFailure::Syntax(error) => error,
        JsonFailure::Memory(failure) => failure.into_js_error(),
    }
}

fn memory_error(failure: barochart_js::memory::MemoryFailure) -> JsError {
    failure.into_js_error()
}

fn error(name: &'static str, message: &str) -> JsError {
    JsError::new(name, JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    error("TypeError", message)
}

fn range_error(message: &str) -> JsError {
    error("RangeError", message)
}

#[cfg(test)]
mod internal_tests {
    use super::{DrawingStore, NumberDialect};
    use barochart_js::json::{JsonMode, parse_json};
    use barochart_js::string::JsString;

    #[test]
    fn trim_removes_oldest_undo_before_the_oldest_redo_frame() {
        let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
        for id in ["a", "b"] {
            let input = format!(
                r#"{{"id":"{id}","type":"horizontal","panel":"price","points":[{{"time":1,"price":1}}]}}"#
            );
            store
                .add(&parse_json(input.as_bytes(), JsonMode::Standard).unwrap())
                .unwrap();
        }
        assert!(!store.undo_stack().is_empty());
        store.config.history_bytes = 0;
        assert!(store.undo().unwrap());
        assert_eq!(store.items().len(), 1);
        assert_eq!(store.items()[0].id, JsString::from_str("a"));
        assert!(store.undo_stack().is_empty());
        assert!(store.redo_stack().is_empty());
        assert_eq!(store.retained_history_bytes(), 0);
        assert!(!store.redo().unwrap());
    }
    #[test]
    fn workspace_drawing_install_is_atomic_and_resets_runtime_history() {
        let parse = |text: &str| parse_json(text.as_bytes(), JsonMode::Standard).unwrap();
        let mut store = DrawingStore::new(
            super::DrawingStoreConfig {
                max_drawings: 1,
                ..super::DrawingStoreConfig::default()
            },
            NumberDialect::PLATFORM,
        )
        .unwrap();
        store
        .add(&parse(
            r#"{"id":"old","type":"horizontal","panel":"price","points":[{"time":1,"price":1}]}"#,
        ))
        .unwrap();
        let before = store.items()[0].clone();
        let mut candidates = DrawingStore::with_defaults(NumberDialect::PLATFORM);
        for id in ["a", "b"] {
            candidates
            .add(&parse(&format!(
                r#"{{"id":"{id}","type":"horizontal","panel":"price","points":[{{"time":1,"price":1}}]}}"#
            )))
            .unwrap();
        }
        let error = store
            .install_workspace_items(candidates.items().to_vec())
            .unwrap_err();
        assert_eq!(error.name, "RangeError");
        assert_eq!(store.items().len(), 1);
        assert!(std::sync::Arc::ptr_eq(&store.items()[0], &before));
        assert_eq!(store.selected(), Some(&JsString::from_str("old")));
        assert!(!store.undo_stack().is_empty());

        store
            .install_workspace_items(vec![candidates.items()[0].clone()])
            .unwrap();
        assert_eq!(store.items()[0].id, JsString::from_str("a"));
        assert!(store.undo_stack().is_empty());
        assert!(store.redo_stack().is_empty());
        assert!(store.transaction().is_none());
        assert!(store.selected().is_none());
        assert_eq!(store.serial(), 0);
        assert_eq!(store.retained_history_bytes(), 0);
    }
}
