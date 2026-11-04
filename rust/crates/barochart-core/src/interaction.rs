//! 소유 포인터 상태, 드로잉 편집 제스처, 뷰 조작을 처리한다.

#![forbid(unsafe_code)]

use std::borrow::Borrow;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::math::{js_exp, js_hypot};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::{NumberDialect, js_max, js_min, same_value};
use barochart_js::string::JsString;

use crate::Host;
use crate::contracts::{identifier, js_to_number_scoped, option_record};
use crate::crosshair_snap::{
    CrosshairCursor, CrosshairResolution, CrosshairSnapMode, CrosshairSnapOptions,
    CrosshairSnapTarget, crosshair_snap_options, resolve_crosshair, resolve_crosshair_snapshot,
};
use crate::data::{BarStore, DataIdentity};
use crate::drawing_geometry::DrawingGeometryCache;
use crate::drawing_hit_test::{DrawingHitTestCache, drawing_hit_test};
use crate::drawing_types::{DrawingPoint, DrawingType};
use crate::drawing_validation::DRAWING_TYPES;
use crate::drawings::{DrawingSnapshot, DrawingStore, PreparedDrawingCancel};
use crate::layout::Layout;
use crate::model_state::{ModelState, PreparedView, VisibleRange};
use crate::position_drawing::{is_position_drawing, position_metrics_for_parts};
use crate::series_cache::SeriesCaches;
use crate::workspace::{js_string_heap_bytes, js_value_heap_bytes};

fn memory_error(error: barochart_js::memory::MemoryFailure) -> JsError {
    error.into_js_error()
}

fn scoped_vec<T>(length: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = length
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(length)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(values)
}

fn persistent_text(
    value: &JsString,
    memory: &MemoryContext,
) -> Result<(JsString, MemoryGroup), JsError> {
    let mut scope = memory.scope();
    let value = value.try_clone_scoped(&mut scope).map_err(memory_error)?;
    let group = scope
        .split_persistent(js_string_heap_bytes(&value))
        .map_err(memory_error)?;
    Ok((value, group))
}

fn persistent_value(
    value: &JsValue,
    memory: &MemoryContext,
) -> Result<(JsValue, MemoryGroup), JsError> {
    let mut scope = memory.scope();
    let value = value.try_clone_scoped(&mut scope).map_err(memory_error)?;
    let group = scope
        .split_persistent(js_value_heap_bytes(&value))
        .map_err(memory_error)?;
    Ok((value, group))
}

fn clone_snap_options_scoped(
    value: &CrosshairSnapOptions,
    scope: &mut MemoryScope,
) -> Result<CrosshairSnapOptions, JsError> {
    let target = value
        .target
        .as_ref()
        .map(|target| {
            Ok(CrosshairSnapTarget {
                panel: target.panel.try_clone_scoped(scope).map_err(memory_error)?,
                axis_id: target
                    .axis_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                    .transpose()?,
                series_id: target
                    .series_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                    .transpose()?,
            })
        })
        .transpose()?;
    Ok(CrosshairSnapOptions {
        mode: value.mode,
        target,
    })
}

fn snap_options_heap_bytes(value: &CrosshairSnapOptions) -> usize {
    value.target.as_ref().map_or(0, |target| {
        js_string_heap_bytes(&target.panel)
            .saturating_add(target.axis_id.as_ref().map_or(0, js_string_heap_bytes))
            .saturating_add(target.series_id.as_ref().map_or(0, js_string_heap_bytes))
    })
}

fn crosshair_snap_value(
    value: &CrosshairSnapOptions,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mode = match value.mode {
        CrosshairSnapMode::Free => "free",
        CrosshairSnapMode::Close => "close",
        CrosshairSnapMode::Ohlc => "ohlc",
    };
    let target = value
        .target
        .as_ref()
        .map(|target| {
            Ok(object_value([
                (
                    "panel",
                    JsValue::String(target.panel.try_clone_scoped(scope).map_err(memory_error)?),
                ),
                (
                    "axisId",
                    target
                        .axis_id
                        .as_ref()
                        .map(|value| value.try_clone_scoped(scope).map(JsValue::String))
                        .transpose()
                        .map_err(memory_error)?
                        .unwrap_or(JsValue::Null),
                ),
                (
                    "seriesId",
                    target
                        .series_id
                        .as_ref()
                        .map(|value| value.try_clone_scoped(scope).map(JsValue::String))
                        .transpose()
                        .map_err(memory_error)?
                        .unwrap_or(JsValue::Null),
                ),
            ]))
        })
        .transpose()?
        .unwrap_or(JsValue::Null);
    Ok(object_value([
        (
            "mode",
            JsValue::String(JsString::try_from_str(mode, scope).map_err(memory_error)?),
        ),
        ("target", target),
    ]))
}

fn persistent_snap_options(
    value: &CrosshairSnapOptions,
    memory: &MemoryContext,
) -> Result<(CrosshairSnapOptions, MemoryGroup), JsError> {
    let mut scope = memory.scope();
    let value = clone_snap_options_scoped(value, &mut scope)?;
    let memory = scope
        .split_persistent(snap_options_heap_bytes(&value))
        .map_err(memory_error)?;
    Ok((value, memory))
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn object(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
}

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    object(value)?.get(&key(name))
}

fn text_value(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

fn ascii_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn js_map_key_equal(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::String(left), JsValue::String(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => {
            left == right || left.is_nan() && right.is_nan()
        }
        // Each native JSON call materializes a fresh object/array. Never treat equal structure
        // as the same JavaScript Map object key.
        (JsValue::Object(_) | JsValue::Array(_), JsValue::Object(_) | JsValue::Array(_)) => false,
        _ => false,
    }
}

/// Typed invalidation effect corresponding to one controller `invalidate` call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteractionInvalidation {
    /// Default invalidation for controls, selection, or a complete update.
    Default,
    /// Hover layer only.
    Hover,
    /// Drawing geometry layer.
    Drawings,
    /// Full chart view/scene.
    All,
}

/// Modifier keys captured by the host for one keyboard interaction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InteractionKeyModifiers {
    /// Control/command modifier.
    pub ctrl: bool,
    /// Shift modifier.
    pub shift: bool,
}

impl InteractionInvalidation {
    fn as_js(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Hover => "hover",
            Self::Drawings => "drawings",
            Self::All => "all",
        }
    }
}

/// Effects returned by one interaction call. The runtime performs invalidation explicitly.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InteractionEffects {
    /// Invalidations in the order requested by the source controller.
    pub invalidations: Vec<InteractionInvalidation>,
}

impl InteractionEffects {
    fn prepared(memory: &MemoryContext) -> Result<Self, JsError> {
        let mut invalidations = Vec::new();
        invalidations
            .try_reserve_exact(1)
            .map_err(|_| memory.allocation_failure().into_js_error())?;
        Ok(Self { invalidations })
    }

    fn invalidate(&mut self, kind: InteractionInvalidation) {
        self.invalidations.push(kind);
    }

    /// Ordered invalidation names as a JS array.
    pub fn to_js_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_js_value_scoped(&mut scope)
            .expect("unaccounted interaction effect allocation")
    }

    /// invalidation 이름 배열을 호출 scope에 선계상해 만든다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut values = scoped_vec(self.invalidations.len(), scope)?;
        for kind in &self.invalidations {
            values.push(JsValue::String(
                JsString::try_from_str(kind.as_js(), scope).map_err(memory_error)?,
            ));
        }
        Ok(JsValue::Array(values))
    }
}

/// 검증과 retention을 끝내고 외부 reply gate를 기다리는 interaction mutation 후보다.
///
/// 아래 publication 메서드가 이 값을 소비한다. 최종 owned reply를 승인하기 전에 문자열,
/// 레코드, memory group, invalidation 한 칸을 모두 확보한다.
pub enum PreparedInteraction {
    /// 변경은 없지만 effect slot까지 미리 확보한 검증 완료 후보다.
    Noop { effects: InteractionEffects },
    /// `setText`/legacy text tool value.
    Text {
        value: JsValue,
        memory: MemoryGroup,
        effects: InteractionEffects,
    },
    /// Drawing tool name and its retained string.
    Tool {
        value: JsString,
        memory: MemoryGroup,
        effects: InteractionEffects,
    },
    /// Normalized drawing target and source identity.
    DrawingTarget {
        value: Option<JsValue>,
        memory: MemoryGroup,
        identity: Option<Arc<()>>,
        effects: InteractionEffects,
    },
    /// Validated drawing magnet settings.
    DrawingMagnet {
        value: DrawingMagnetOptions,
        effects: InteractionEffects,
    },
    /// Validated snap settings and optional pointer-owned request replacement.
    CrosshairSnap {
        value: CrosshairSnapOptions,
        memory: MemoryGroup,
        request: Option<(CrosshairSnapOptions, MemoryGroup)>,
        effects: InteractionEffects,
    },
    /// Wheel view candidate prepared through the existing model staging seam.
    Wheel {
        view: PreparedView,
        effects: InteractionEffects,
    },
    /// Reply admission 전에 준비한 controller/drawing transaction 취소다.
    Cancel {
        drawings: Option<PreparedDrawingCancel>,
        restore_view: Option<(VisibleRange, bool)>,
        effects: InteractionEffects,
    },
}

/// Model publication gate 전에 retain한 raw drawing-target 교체 후보다.
///
/// `PreparedInteraction::DrawingTarget`과 달리 현재 interaction을 검증하거나 취소하지 않는다.
/// Model binding을 동시에 게시하고 controller slot만 채택할 때 사용한다.
pub struct PreparedDrawingTarget {
    value: Option<JsValue>,
    memory: MemoryGroup,
    identity: Option<Arc<()>>,
}

/// Borrowed actual owners needed during one interaction call.
pub struct InteractionContext<'a> {
    /// Mutable chart configuration and visible range.
    pub model: &'a mut ModelState,
    /// Current data owner.
    pub store: &'a BarStore,
    /// Actual per-chart indicator computation state.
    pub indicators: &'a mut crate::indicator_engine::IndicatorEngine,
    /// Actual transactional drawing owner.
    pub drawings: &'a mut DrawingStore,
    /// Per-chart, non-owning series range indexes.
    pub series_caches: &'a mut SeriesCaches,
    /// Per-chart weak drawing geometry cache shared with scene generation.
    pub geometry_cache: &'a mut DrawingGeometryCache,
    /// Actual host callbacks used by layout and indicator computation.
    pub host: &'a dyn Host,
    /// Current CSS pixel width.
    pub width: f64,
    /// Current CSS pixel height.
    pub height: f64,
}

impl InteractionContext<'_> {
    /// Creates an owned layout with the current chart dimensions and actual owners.
    pub fn layout(&mut self) -> Result<Layout, JsError> {
        crate::layout::create_layout(
            self.model,
            self.store,
            self.indicators,
            self.host,
            self.series_caches,
            self.width,
            self.height,
        )
    }
}

/// Coordinates stored in the insertion-ordered pointer map.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerPosition {
    /// Current pointer x coordinate.
    pub x: f64,
    /// Current pointer y coordinate.
    pub y: f64,
}

/// Runtime source가 호출 사이 controller own-data identity를 검증하는 token이다.
pub struct InteractionSourceOwnerToken {
    source_identity: Arc<()>,
    pointers_identity: Arc<()>,
    tool: JsString,
    text: JsValue,
    drawing_target_identity: Option<Arc<()>>,
    crosshair_identity: Option<u64>,
    gesture_active: bool,
    pointer_count: usize,
    _memory: MemoryGroup,
}

fn source_scalar_same(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => same_value(*left, *right),
        (JsValue::String(left), JsValue::String(right)) => left == right,
        _ => false,
    }
}

fn same_optional_identity(left: Option<&Arc<()>>, right: Option<&Arc<()>>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => Arc::ptr_eq(left, right),
        _ => false,
    }
}

#[derive(Debug)]
struct PointerEntry {
    id: JsValue,
    position: PointerPosition,
    _memory: MemoryGroup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DrawingMagnetMode {
    Off,
    Weak,
    Strong,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawingMagnetOptions {
    mode: DrawingMagnetMode,
    radius_px: f64,
}

impl Default for DrawingMagnetOptions {
    fn default() -> Self {
        Self {
            mode: DrawingMagnetMode::Off,
            radius_px: 8.0,
        }
    }
}

impl DrawingMagnetOptions {
    fn to_js_value(self) -> JsValue {
        let mode = match self.mode {
            DrawingMagnetMode::Off => "off",
            DrawingMagnetMode::Weak => "weak",
            DrawingMagnetMode::Strong => "strong",
        };
        object_value([
            ("mode", JsValue::String(JsString::from_str(mode))),
            ("radiusPx", JsValue::Number(self.radius_px)),
        ])
    }
}

#[derive(Clone, Debug)]
struct ViewportSnapshot {
    data_identity: DataIdentity,
    serial: f64,
    time_version: f64,
    view: VisibleRange,
    follow: bool,
}

#[derive(Clone, Debug)]
struct DrawingProjectionSnapshot {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    min: f64,
    max: f64,
    scale: JsString,
    inverted: bool,
    base: f64,
    view_from: f64,
    view_to: f64,
    serial: f64,
    time_version: f64,
}

fn clone_projection_scoped(
    value: &DrawingProjectionSnapshot,
    scope: &mut MemoryScope,
) -> Result<DrawingProjectionSnapshot, JsError> {
    Ok(DrawingProjectionSnapshot {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        min: value.min,
        max: value.max,
        scale: value.scale.try_clone_scoped(scope).map_err(memory_error)?,
        inverted: value.inverted,
        base: value.base,
        view_from: value.view_from,
        view_to: value.view_to,
        serial: value.serial,
        time_version: value.time_version,
    })
}

#[derive(Debug)]
enum Gesture {
    Wait {
        stale_viewport: bool,
    },
    Pan {
        start_x: f64,
        view: VisibleRange,
        follow: bool,
        pixel_width: f64,
        viewport: ViewportSnapshot,
    },
    Pinch {
        distance: f64,
        view: VisibleRange,
        follow: bool,
        midpoint: f64,
        viewport: ViewportSnapshot,
    },
    Create {
        transaction: DrawingSnapshot,
        id: JsString,
        panel: JsString,
        axis_id: Option<JsString>,
        series_id: Option<JsString>,
        kind: DrawingType,
        projection: DrawingProjectionSnapshot,
        last_x: f64,
        last_y: f64,
        moved: bool,
    },
    Edit {
        transaction: DrawingSnapshot,
        id: JsString,
        handle: i32,
        start_x: f64,
        start_y: f64,
        screen_points: Vec<crate::layout::ScreenPoint>,
        points: Vec<DrawingPoint>,
        panel: JsString,
        axis_id: Option<JsString>,
        series_id: Option<JsString>,
        kind: DrawingType,
        projection: DrawingProjectionSnapshot,
    },
}

impl Gesture {
    fn kind(&self) -> &'static str {
        match self {
            Self::Wait { .. } => "wait",
            Self::Pan { .. } => "pan",
            Self::Pinch { .. } => "pinch",
            Self::Create { .. } => "create",
            Self::Edit { .. } => "edit",
        }
    }

    fn transaction(&self) -> Option<&DrawingSnapshot> {
        match self {
            Self::Create { transaction, .. } | Self::Edit { transaction, .. } => Some(transaction),
            _ => None,
        }
    }

    fn viewport(&self) -> Option<&ViewportSnapshot> {
        match self {
            Self::Pan { viewport, .. } | Self::Pinch { viewport, .. } => Some(viewport),
            _ => None,
        }
    }

    fn original_view(&self) -> Option<(VisibleRange, bool)> {
        match self {
            Self::Pan { view, follow, .. } | Self::Pinch { view, follow, .. } => {
                Some((*view, *follow))
            }
            _ => None,
        }
    }

    fn try_clone_scoped(&self, scope: &mut MemoryScope) -> Result<Self, JsError> {
        Ok(match self {
            Self::Wait { stale_viewport } => Self::Wait {
                stale_viewport: *stale_viewport,
            },
            Self::Pan {
                start_x,
                view,
                follow,
                pixel_width,
                viewport,
            } => Self::Pan {
                start_x: *start_x,
                view: *view,
                follow: *follow,
                pixel_width: *pixel_width,
                viewport: viewport.clone(),
            },
            Self::Pinch {
                distance,
                view,
                follow,
                midpoint,
                viewport,
            } => Self::Pinch {
                distance: *distance,
                view: *view,
                follow: *follow,
                midpoint: *midpoint,
                viewport: viewport.clone(),
            },
            Self::Create {
                transaction,
                id,
                panel,
                axis_id,
                series_id,
                kind,
                projection: source_projection,
                last_x,
                last_y,
                moved,
            } => Self::Create {
                transaction: Arc::clone(transaction),
                id: id.try_clone_scoped(scope).map_err(memory_error)?,
                panel: panel.try_clone_scoped(scope).map_err(memory_error)?,
                axis_id: axis_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                    .transpose()?,
                series_id: series_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                    .transpose()?,
                kind: *kind,
                projection: clone_projection_scoped(source_projection, scope)?,
                last_x: *last_x,
                last_y: *last_y,
                moved: *moved,
            },
            Self::Edit {
                transaction,
                id,
                handle,
                start_x,
                start_y,
                screen_points,
                points,
                panel,
                axis_id,
                series_id,
                kind,
                projection: source_projection,
            } => {
                let mut retained_screen = scoped_vec(screen_points.len(), scope)?;
                retained_screen.extend_from_slice(screen_points);
                let mut retained_points = scoped_vec(points.len(), scope)?;
                retained_points.extend_from_slice(points);
                Self::Edit {
                    transaction: Arc::clone(transaction),
                    id: id.try_clone_scoped(scope).map_err(memory_error)?,
                    handle: *handle,
                    start_x: *start_x,
                    start_y: *start_y,
                    screen_points: retained_screen,
                    points: retained_points,
                    panel: panel.try_clone_scoped(scope).map_err(memory_error)?,
                    axis_id: axis_id
                        .as_ref()
                        .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                        .transpose()?,
                    series_id: series_id
                        .as_ref()
                        .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                        .transpose()?,
                    kind: *kind,
                    projection: clone_projection_scoped(source_projection, scope)?,
                }
            }
        })
    }
}

/// Controller state owned independently of any model/store borrow.
pub struct OwnedInteractionState {
    memory: MemoryContext,
    source_identity: Arc<()>,
    pointers_identity: Arc<()>,
    tool: JsString,
    tool_memory: MemoryGroup,
    text: JsValue,
    text_memory: MemoryGroup,
    drawing_target: Option<JsValue>,
    drawing_target_memory: MemoryGroup,
    drawing_target_identity: Option<Arc<()>>,
    drawing_magnet: DrawingMagnetOptions,
    crosshair_snap: CrosshairSnapOptions,
    crosshair_snap_memory: MemoryGroup,
    pointers: Vec<PointerEntry>,
    _pointers_memory: MemoryGroup,
    gesture: Option<Gesture>,
    gesture_memory: MemoryGroup,
    crosshair: Option<CrosshairCursor>,
    crosshair_memory: MemoryGroup,
    crosshair_visible: bool,
    crosshair_pointer_owned: bool,
    next_crosshair_identity: u64,
    hit_cache: DrawingHitTestCache,
    retired: bool,
}

impl Default for OwnedInteractionState {
    fn default() -> Self {
        Self::new()
    }
}

impl OwnedInteractionState {
    /// Creates the source controller defaults without retaining a model or callback.
    pub fn new() -> Self {
        Self::new_with_memory(MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized))
            .expect("valid unaccounted interaction defaults")
    }

    /// 기본 controller 값을 지정 엔진 memory context에 보관한다.
    pub fn new_with_memory(memory: MemoryContext) -> Result<Self, JsError> {
        let (tool, tool_memory) = persistent_text(&JsString::from_str("select"), &memory)?;
        let (text, text_memory) =
            persistent_value(&JsValue::String(JsString::from_str("Note")), &memory)?;
        let (pointers, pointers_memory) = memory.try_vec_capacity(2).map_err(memory_error)?;
        Ok(Self {
            memory: memory.clone(),
            tool,
            tool_memory,
            source_identity: Arc::new(()),
            pointers_identity: Arc::new(()),
            text,
            text_memory,
            drawing_target: None,
            drawing_target_memory: MemoryGroup::empty(memory.clone()),
            drawing_target_identity: None,
            drawing_magnet: DrawingMagnetOptions::default(),
            crosshair_snap: CrosshairSnapOptions::default(),
            crosshair_snap_memory: MemoryGroup::empty(memory.clone()),
            pointers,
            _pointers_memory: pointers_memory,
            gesture: None,
            gesture_memory: MemoryGroup::empty(memory.clone()),
            crosshair: None,
            crosshair_memory: MemoryGroup::empty(memory.clone()),
            crosshair_visible: false,
            crosshair_pointer_owned: false,
            next_crosshair_identity: 0,
            hit_cache: DrawingHitTestCache::new_with_memory(memory.clone()),
            retired: false,
        })
    }

    /// 이 controller가 persistent/temporary allocation에 쓰는 엔진 context다.
    pub fn memory_context(&self) -> &MemoryContext {
        &self.memory
    }

    /// Number of currently retained pointer ids.
    pub fn pointer_count(&self) -> usize {
        self.pointers.len()
    }

    /// Current gesture kind, if a pointer gesture is active.
    pub fn gesture_kind(&self) -> Option<&'static str> {
        self.gesture.as_ref().map(Gesture::kind)
    }

    /// 활성 create/edit gesture가 소유한 drawing id다.
    pub fn gesture_drawing_id(&self) -> Option<&JsString> {
        match self.gesture.as_ref() {
            Some(Gesture::Create { id, .. } | Gesture::Edit { id, .. }) => Some(id),
            _ => None,
        }
    }

    /// Current tool name.
    pub fn tool(&self) -> &JsString {
        &self.tool
    }

    /// Current text-tool value, preserved as a JS value.
    pub fn text(&self) -> &JsValue {
        &self.text
    }

    /// Current raw drawing-target record.
    pub fn drawing_target(&self) -> Option<&JsValue> {
        self.drawing_target.as_ref()
    }

    /// Model 검증을 마친 target을 외부 reply gate 전에 retain한다.
    pub fn prepare_drawing_target_publication(
        &self,
        target: Option<&JsValue>,
    ) -> Result<PreparedDrawingTarget, JsError> {
        self.ensure_active()?;
        let (target, target_memory) = target
            .as_ref()
            .map(|target| persistent_value(target, &self.memory))
            .transpose()?
            .map_or_else(
                || (None, MemoryGroup::empty(self.memory.clone())),
                |(target, memory)| (Some(target), memory),
            );
        let identity = target.as_ref().map(|_| Arc::new(()));
        Ok(PreparedDrawingTarget {
            value: target,
            memory: target_memory,
            identity,
        })
    }

    /// Retain한 target slot을 model 재검증·취소·allocation 없이 게시한다.
    pub fn publish_prepared_drawing_target_raw(
        &mut self,
        prepared: PreparedDrawingTarget,
    ) -> Result<(), JsError> {
        self.ensure_active()?;
        self.drawing_target = prepared.value;
        self.drawing_target_memory = prepared.memory;
        self.drawing_target_identity = prepared.identity;
        Ok(())
    }

    /// Model publication 뒤 이미 검증된 target을 gesture 취소 없이 raw slot에 게시한다.
    pub fn publish_drawing_target(&mut self, target: Option<JsValue>) -> Result<(), JsError> {
        let prepared = self.prepare_drawing_target_publication(target.as_ref())?;
        self.publish_prepared_drawing_target_raw(prepared)
    }

    /// Async UI snapshot이 보존하는 raw model crosshair 값이다.
    pub fn crosshair_value(&self) -> Option<(f64, f64)> {
        self.crosshair
            .as_ref()
            .filter(|_| self.crosshair_visible)
            .map(|cursor| (cursor.x, cursor.y))
    }

    /// Hover exit처럼 raw cursor/WeakMap 대응 metadata는 유지하고 표시만 숨긴다.
    pub fn hide_crosshair(&mut self) -> Result<(), JsError> {
        self.ensure_active()?;
        self.crosshair_visible = false;
        Ok(())
    }

    /// Current magnet settings as a source-compatible JS value.
    pub fn drawing_magnet(&self) -> JsValue {
        self.drawing_magnet.to_js_value()
    }

    /// Current snap settings as a source-compatible JS value.
    pub fn crosshair_snap(&self) -> JsValue {
        self.crosshair_snap.to_js_value()
    }

    /// snap 설정 출력의 문자열과 컨테이너를 호출 scope에 계상한다.
    pub fn crosshair_snap_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        crosshair_snap_value(&self.crosshair_snap, scope)
    }

    /// Ordered pointer entries as id/position pairs.
    pub fn pointers(&self) -> Vec<(JsValue, PointerPosition)> {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.pointers_scoped(&mut scope)
            .expect("unaccounted pointer snapshot allocation")
    }

    /// pointer ID를 깊게 복제하며 snapshot allocation을 호출 scope에 계상한다.
    pub fn pointers_scoped(
        &self,
        scope: &mut MemoryScope,
    ) -> Result<Vec<(JsValue, PointerPosition)>, JsError> {
        let mut pointers = scoped_vec(self.pointers.len(), scope)?;
        for entry in &self.pointers {
            pointers.push((
                entry.id.try_clone_scoped(scope).map_err(memory_error)?,
                entry.position,
            ));
        }
        Ok(pointers)
    }

    /// Reply admission 전에 text drawing 도구의 후속 text 값을 소유한다.
    pub fn prepare_set_text(&self, value: &JsValue) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        let (value, memory) = persistent_value(value, &self.memory)?;
        Ok(PreparedInteraction::Text {
            value,
            memory,
            effects: InteractionEffects::prepared(&self.memory)?,
        })
    }

    /// 준비한 text 값을 fallible allocation 없이 게시한다.
    pub fn publish_prepared_text(
        &mut self,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let PreparedInteraction::Text {
            value,
            memory,
            mut effects,
        } = prepared
        else {
            return Err(ordinary_error("Interaction preparation kind"));
        };
        self.text = value;
        self.text_memory = memory;
        if notify {
            effects.invalidate(InteractionInvalidation::Default);
        }
        Ok(effects)
    }

    /// Owns a text value for subsequent text-drawing tools.
    pub fn set_text(&mut self, value: &JsValue) -> Result<(), JsError> {
        let prepared = self.prepare_set_text(value)?;
        self.publish_prepared_text(prepared, false).map(|_| ())
    }

    /// 검증된 async UI state에서 callback/model borrow 없이 fresh controller를 만든다.
    pub fn from_native_ui(
        tool: JsString,
        text: JsValue,
        drawing_target: Option<JsValue>,
        crosshair: Option<(f64, f64)>,
    ) -> Self {
        Self::from_native_ui_with_memory(
            tool,
            text,
            drawing_target,
            crosshair,
            MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
        .expect("valid unaccounted native UI interaction state")
    }

    /// 검증된 native UI 값을 지정 엔진 account에 깊게 복제해 fresh controller를 만든다.
    pub fn from_native_ui_with_memory(
        tool: JsString,
        text: JsValue,
        drawing_target: Option<JsValue>,
        crosshair: Option<(f64, f64)>,
        memory: MemoryContext,
    ) -> Result<Self, JsError> {
        let (retained_tool, tool_memory) = persistent_text(&tool, &memory)?;
        let (retained_text, text_memory) = persistent_value(&text, &memory)?;
        let (retained_target, drawing_target_memory) = drawing_target
            .as_ref()
            .map(|target| persistent_value(target, &memory))
            .transpose()?
            .map_or_else(
                || (None, MemoryGroup::empty(memory.clone())),
                |(target, group)| (Some(target), group),
            );
        let (pointers, pointers_memory) = memory.try_vec_capacity(2).map_err(memory_error)?;
        let mut state = Self {
            memory: memory.clone(),
            source_identity: Arc::new(()),
            pointers_identity: Arc::new(()),
            tool: retained_tool,
            tool_memory,
            text: retained_text,
            text_memory,
            drawing_target: retained_target,
            drawing_target_memory,
            drawing_target_identity: drawing_target.as_ref().map(|_| Arc::new(())),
            drawing_magnet: DrawingMagnetOptions::default(),
            crosshair_snap: CrosshairSnapOptions::default(),
            crosshair_snap_memory: MemoryGroup::empty(memory.clone()),
            pointers,
            _pointers_memory: pointers_memory,
            gesture: None,
            gesture_memory: MemoryGroup::empty(memory.clone()),
            crosshair: None,
            crosshair_memory: MemoryGroup::empty(memory.clone()),
            crosshair_visible: false,
            crosshair_pointer_owned: false,
            next_crosshair_identity: 0,
            hit_cache: DrawingHitTestCache::new_with_memory(memory.clone()),
            retired: false,
        };
        if let Some((x, y)) = crosshair {
            state.next_crosshair_identity = 1;
            state.crosshair_visible = true;
            state.crosshair = Some(CrosshairCursor {
                x,
                y,
                request: None,
                identity: 1,
            });
        }
        Ok(state)
    }

    /// Async/workspace/params source가 controller own-data identity를 보존하는 token이다.
    pub fn capture_source_owner(&self) -> Result<InteractionSourceOwnerToken, JsError> {
        self.ensure_active()?;
        if self.gesture.is_some() || !self.pointers.is_empty() {
            return Err(ordinary_error("Native source active gesture"));
        }
        let mut scope = self.memory.scope();
        let tool = self
            .tool
            .try_clone_scoped(&mut scope)
            .map_err(memory_error)?;
        let text = self
            .text
            .try_clone_scoped(&mut scope)
            .map_err(memory_error)?;
        let bytes = js_string_heap_bytes(&tool).saturating_add(js_value_heap_bytes(&text));
        let memory = scope.split_persistent(bytes).map_err(memory_error)?;
        Ok(InteractionSourceOwnerToken {
            source_identity: Arc::clone(&self.source_identity),
            pointers_identity: Arc::clone(&self.pointers_identity),
            tool,
            text,
            drawing_target_identity: self.drawing_target_identity.clone(),
            crosshair_identity: self.crosshair.as_ref().map(|cursor| cursor.identity),
            gesture_active: false,
            pointer_count: 0,
            _memory: memory,
        })
    }

    /// Capture 뒤 sourceRefs에 포함된 controller slot만 그대로인지 검사한다.
    /// Magnet/snap 설정은 source 계약에 없으므로 의도적으로 제외한다.
    pub fn validate_source_owner(&self, token: &InteractionSourceOwnerToken) -> bool {
        !self.retired
            && Arc::ptr_eq(&self.source_identity, &token.source_identity)
            && Arc::ptr_eq(&self.pointers_identity, &token.pointers_identity)
            && self.tool == token.tool
            && source_scalar_same(&self.text, &token.text)
            && same_optional_identity(
                self.drawing_target_identity.as_ref(),
                token.drawing_target_identity.as_ref(),
            )
            && self.crosshair.as_ref().map(|cursor| cursor.identity) == token.crosshair_identity
            && self.gesture.is_some() == token.gesture_active
            && self.pointers.len() == token.pointer_count
    }

    /// Bridge owner guard가 controller object 교체만 구분한다.
    pub fn validate_source_controller(&self, token: &InteractionSourceOwnerToken) -> bool {
        !self.retired && Arc::ptr_eq(&self.source_identity, &token.source_identity)
    }

    /// Ordered owned state snapshot for runtime/bridge inspection.
    pub fn to_js_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_js_value_scoped(&mut scope)
            .expect("unaccounted interaction snapshot allocation")
    }

    /// controller snapshot의 가변 payload를 호출 scope에 선계상해 만든다.
    pub fn to_js_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut pointers = scoped_vec(self.pointers.len(), scope)?;
        for entry in &self.pointers {
            let mut pair = scoped_vec(2, scope)?;
            pair.push(entry.id.try_clone_scoped(scope).map_err(memory_error)?);
            pair.push(object_value([
                ("x", JsValue::Number(entry.position.x)),
                ("y", JsValue::Number(entry.position.y)),
            ]));
            pointers.push(JsValue::Array(pair));
        }
        let crosshair = self
            .crosshair
            .as_ref()
            .filter(|_| self.crosshair_visible)
            .map_or(JsValue::Null, |cursor| {
                object_value([
                    ("x", JsValue::Number(cursor.x)),
                    ("y", JsValue::Number(cursor.y)),
                ])
            });
        let pointer_request = self
            .crosshair
            .as_ref()
            .filter(|cursor| self.crosshair_pointer_owned && cursor.request.is_some())
            .map_or(JsValue::Null, |cursor| {
                object_value([
                    ("x", JsValue::Number(cursor.x)),
                    ("y", JsValue::Number(cursor.y)),
                    ("identity", JsValue::Number(cursor.identity as f64)),
                ])
            });
        Ok(object_value([
            (
                "tool",
                JsValue::String(self.tool.try_clone_scoped(scope).map_err(memory_error)?),
            ),
            (
                "text",
                self.text.try_clone_scoped(scope).map_err(memory_error)?,
            ),
            (
                "drawingTarget",
                self.drawing_target
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                    .transpose()?
                    .unwrap_or(JsValue::Null),
            ),
            ("drawingMagnet", self.drawing_magnet.to_js_value()),
            (
                "crosshairSnap",
                crosshair_snap_value(&self.crosshair_snap, scope)?,
            ),
            ("pointers", JsValue::Array(pointers)),
            (
                "gesture",
                self.gesture
                    .as_ref()
                    .map(|gesture| gesture_value(gesture, scope))
                    .transpose()?
                    .unwrap_or(JsValue::Null),
            ),
            ("crosshair", crosshair),
            ("crosshairPointer", pointer_request),
        ]))
    }

    fn ensure_active(&self) -> Result<(), JsError> {
        if self.retired {
            Err(ordinary_error("Chart disposed"))
        } else {
            Ok(())
        }
    }

    fn pointer_index(&self, id: &JsValue) -> Option<usize> {
        self.pointers
            .iter()
            .position(|pointer| js_map_key_equal(&pointer.id, id))
    }

    fn prepare_pointer(&self, id: &JsValue) -> Result<Option<(JsValue, MemoryGroup)>, JsError> {
        let normalized;
        let lookup = match id {
            JsValue::Number(number) if number.to_bits() == (-0.0_f64).to_bits() => {
                normalized = JsValue::Number(0.0);
                &normalized
            }
            id => id,
        };
        if self.pointer_index(lookup).is_some() {
            Ok(None)
        } else {
            persistent_value(lookup, &self.memory).map(Some)
        }
    }

    fn set_pointer(
        &mut self,
        id: &JsValue,
        position: PointerPosition,
        prepared: Option<(JsValue, MemoryGroup)>,
    ) {
        if let Some(index) = self.pointer_index(id) {
            self.pointers[index].position = position;
        } else if let Some((id, memory)) = prepared {
            self.pointers.push(PointerEntry {
                id,
                position,
                _memory: memory,
            });
        }
    }

    fn remove_pointer(&mut self, id: &JsValue) -> bool {
        let Some(index) = self.pointer_index(id) else {
            return false;
        };
        self.pointers.remove(index);
        true
    }

    fn capture_crosshair(
        &mut self,
        x: f64,
        y: f64,
        request: CrosshairSnapOptions,
        memory: MemoryGroup,
    ) {
        self.next_crosshair_identity = self.next_crosshair_identity.saturating_add(1);
        self.crosshair_visible = true;
        self.crosshair_pointer_owned = true;
        self.crosshair = Some(CrosshairCursor {
            x,
            y,
            request: Some(request),
            identity: self.next_crosshair_identity,
        });
        self.crosshair_memory = memory;
    }

    fn update_crosshair_request(&mut self, request: Option<(CrosshairSnapOptions, MemoryGroup)>) {
        if self.crosshair_visible
            && self.crosshair_pointer_owned
            && let Some(cursor) = self.crosshair.as_mut()
            && cursor.request.is_some()
            && let Some((request, memory)) = request
        {
            cursor.request = Some(request);
            self.crosshair_memory = memory;
        }
    }

    fn release_pointer_crosshair(&mut self) {
        self.crosshair_pointer_owned = false;
        if let Some(cursor) = self.crosshair.as_mut() {
            cursor.request = None;
        }
        self.crosshair_memory = MemoryGroup::empty(self.memory.clone());
    }

    fn replace_gesture(&mut self, gesture: Option<Gesture>, memory: MemoryGroup) {
        self.gesture = gesture;
        self.gesture_memory = memory;
    }

    fn clear_gesture(&mut self) {
        self.replace_gesture(None, MemoryGroup::empty(self.memory.clone()));
    }

    /// Reply admission 전에 drawing tool을 검증하고 retain한다.
    pub fn prepare_set_tool(&self, tool: &JsValue) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        let Some(tool_name) = text_value(tool) else {
            return Err(ordinary_error("Unknown drawing tool"));
        };
        if !ascii_eq(tool_name, "select")
            && !DRAWING_TYPES.iter().any(|candidate| {
                tool_name
                    .as_units()
                    .iter()
                    .copied()
                    .eq(candidate.encode_utf16())
            })
        {
            return Err(ordinary_error("Unknown drawing tool"));
        }
        let (tool, tool_memory) = persistent_text(tool_name, &self.memory)?;
        Ok(PreparedInteraction::Tool {
            value: tool,
            memory: tool_memory,
            effects: InteractionEffects::prepared(&self.memory)?,
        })
    }

    /// 외부 reply gate 뒤 준비한 drawing tool을 게시한다.
    pub fn publish_prepared_tool(
        &mut self,
        context: &mut InteractionContext<'_>,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let cancel = self.prepare_cancel(context, false, false)?;
        let _ = self.publish_prepared_cancel(context, cancel)?;
        self.publish_prepared_tool_after_cancel(prepared, notify)
    }

    /// Caller가 prepared cancel을 먼저 게시한 뒤 tool 값만 allocation 없이 교체한다.
    pub fn publish_prepared_tool_after_cancel(
        &mut self,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let PreparedInteraction::Tool {
            value,
            memory,
            mut effects,
        } = prepared
        else {
            return Err(ordinary_error("Interaction preparation kind"));
        };
        self.tool = value;
        self.tool_memory = memory;
        if notify {
            effects.invalidate(InteractionInvalidation::Default);
        }
        Ok(effects)
    }

    /// Changes the active drawing tool.
    pub fn set_tool(
        &mut self,
        context: &mut InteractionContext<'_>,
        tool: &JsValue,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let prepared = self.prepare_set_tool(tool)?;
        self.publish_prepared_tool(context, prepared, notify)
    }

    /// Reply admission 전에 optional 기본 drawing binding을 검증하고 retain한다.
    pub fn prepare_set_drawing_target(
        &self,
        context: &mut InteractionContext<'_>,
        target: &JsValue,
    ) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        let next = if matches!(target, JsValue::Null) {
            None
        } else {
            option_record(target, &["panel", "axisId", "seriesId"], "Drawing target")?;
            let input =
                object(target).ok_or_else(|| type_error("Drawing target: object required"))?;
            let default_panel = JsValue::String(JsString::from_str("price"));
            let panel = input.get(&key("panel")).unwrap_or(&default_panel);
            identifier(panel, "Drawing target panel")?;
            let series_id = input.get(&key("seriesId"));
            let mut inferred_axis: Option<Option<&JsString>> = None;
            let axis_id = input.get(&key("axisId"));
            if let Some(JsValue::String(series_id)) = series_id
                && matches!(axis_id, None | Some(JsValue::Undefined))
                && let Some(series) = context
                    .model
                    .series
                    .iter()
                    .find(|item| item.id == *series_id)
            {
                inferred_axis = Some(series.axis_id.as_ref());
            }
            let mut scope = self.memory.scope();
            let mut entries = scoped_vec(3, &mut scope)?;
            entries.push((
                key("panel"),
                panel.try_clone_scoped(&mut scope).map_err(memory_error)?,
            ));
            if let Some(inferred_axis) = inferred_axis {
                entries.push((
                    key("axisId"),
                    inferred_axis
                        .map(|axis| {
                            axis.try_clone_scoped(&mut scope)
                                .map(JsValue::String)
                                .map_err(memory_error)
                        })
                        .transpose()?
                        .unwrap_or(JsValue::Null),
                ));
            } else if let Some(axis_id) = axis_id {
                entries.push((
                    key("axisId"),
                    axis_id.try_clone_scoped(&mut scope).map_err(memory_error)?,
                ));
            }
            if let Some(series_id) = series_id {
                entries.push((
                    key("seriesId"),
                    series_id
                        .try_clone_scoped(&mut scope)
                        .map_err(memory_error)?,
                ));
            }
            let next = JsValue::Object(
                JsObject::try_from_entries_scoped(entries, &mut scope).map_err(memory_error)?,
            );
            context.model.validate_drawing_binding(&next, false)?;
            let memory = scope
                .split_persistent(js_value_heap_bytes(&next))
                .map_err(memory_error)?;
            Some((next, memory))
        };
        let (next, next_memory) = next.map_or_else(
            || (None, MemoryGroup::empty(self.memory.clone())),
            |(next, memory)| (Some(next), memory),
        );
        let identity = next.as_ref().map(|_| Arc::new(()));
        Ok(PreparedInteraction::DrawingTarget {
            value: next,
            memory: next_memory,
            identity,
            effects: InteractionEffects::prepared(&self.memory)?,
        })
    }

    /// 외부 reply gate 뒤 준비한 drawing target을 게시한다.
    pub fn publish_prepared_drawing_target(
        &mut self,
        context: &mut InteractionContext<'_>,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let cancel = self.prepare_cancel(context, false, false)?;
        let _ = self.publish_prepared_cancel(context, cancel)?;
        self.publish_prepared_drawing_target_after_cancel(prepared, notify)
    }

    /// Caller가 prepared cancel을 먼저 게시한 뒤 target 값만 allocation 없이 교체한다.
    pub fn publish_prepared_drawing_target_after_cancel(
        &mut self,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let PreparedInteraction::DrawingTarget {
            value,
            memory,
            identity,
            mut effects,
        } = prepared
        else {
            return Err(ordinary_error("Interaction preparation kind"));
        };
        self.drawing_target = value;
        self.drawing_target_memory = memory;
        self.drawing_target_identity = identity;
        if notify {
            effects.invalidate(InteractionInvalidation::Default);
        }
        Ok(effects)
    }

    /// Sets the optional default drawing binding after model validation.
    pub fn set_drawing_target(
        &mut self,
        context: &mut InteractionContext<'_>,
        target: &JsValue,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let prepared = self.prepare_set_drawing_target(context, target)?;
        self.publish_prepared_drawing_target(context, prepared, notify)
    }

    /// Reply admission 전에 pointer magnet 설정을 검증한다.
    pub fn prepare_set_drawing_magnet(
        &self,
        options: &JsValue,
    ) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        option_record(options, &["mode", "radiusPx"], "Drawing magnet")?;
        let record =
            object(options).ok_or_else(|| type_error("Drawing magnet: object required"))?;
        let mode = match record.get(&key("mode")) {
            Some(JsValue::String(value)) if ascii_eq(value, "off") => DrawingMagnetMode::Off,
            Some(JsValue::String(value)) if ascii_eq(value, "weak") => DrawingMagnetMode::Weak,
            Some(JsValue::String(value)) if ascii_eq(value, "strong") => DrawingMagnetMode::Strong,
            _ => {
                return Err(type_error(
                    "Drawing magnet mode: off, weak or strong required",
                ));
            }
        };
        let radius_px = match record.get(&key("radiusPx")) {
            None | Some(JsValue::Undefined) => 8.0,
            Some(JsValue::Number(radius)) => *radius,
            _ => f64::NAN,
        };
        if !radius_px.is_finite() || !(1.0..=32.0).contains(&radius_px) {
            return Err(range_error(
                "Drawing magnet radius must be 1..32 logical pixels",
            ));
        }
        let next = DrawingMagnetOptions { mode, radius_px };
        if next == self.drawing_magnet {
            return Ok(PreparedInteraction::Noop {
                effects: InteractionEffects::prepared(&self.memory)?,
            });
        }
        Ok(PreparedInteraction::DrawingMagnet {
            value: next,
            effects: InteractionEffects::prepared(&self.memory)?,
        })
    }

    /// 외부 reply gate 뒤 pointer magnet 설정을 게시한다.
    pub fn publish_prepared_drawing_magnet(
        &mut self,
        context: &mut InteractionContext<'_>,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let cancel = self.prepare_cancel(context, false, true)?;
        let _ = self.publish_prepared_cancel(context, cancel)?;
        self.publish_prepared_drawing_magnet_after_cancel(prepared, notify)
    }

    /// Caller가 prepared owned-drawing cancel을 먼저 게시한 뒤 magnet만 교체한다.
    pub fn publish_prepared_drawing_magnet_after_cancel(
        &mut self,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let (value, mut effects) = match prepared {
            PreparedInteraction::DrawingMagnet { value, effects } => (value, effects),
            PreparedInteraction::Noop { effects } => return Ok(effects),
            _ => return Err(ordinary_error("Interaction preparation kind")),
        };
        self.drawing_magnet = value;
        if notify {
            effects.invalidate(InteractionInvalidation::Default);
        }
        Ok(effects)
    }

    /// Updates pointer magnet settings with the source validation order and atomicity.
    pub fn set_drawing_magnet(
        &mut self,
        context: &mut InteractionContext<'_>,
        options: &JsValue,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let prepared = self.prepare_set_drawing_magnet(options)?;
        self.publish_prepared_drawing_magnet(context, prepared, notify)
    }

    /// Reply admission 전에 pointer-owned crosshair snap option을 검증하고 retain한다.
    pub fn prepare_set_crosshair_snap(
        &self,
        context: &InteractionContext<'_>,
        options: &JsValue,
    ) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        let next = crosshair_snap_options(context.model, options)?;
        if next == self.crosshair_snap {
            return Ok(PreparedInteraction::Noop {
                effects: InteractionEffects::prepared(&self.memory)?,
            });
        }
        let (next, next_memory) = persistent_snap_options(&next, &self.memory)?;
        let request = self
            .crosshair
            .as_ref()
            .is_some_and(|cursor| {
                self.crosshair_visible && self.crosshair_pointer_owned && cursor.request.is_some()
            })
            .then(|| persistent_snap_options(&next, &self.memory))
            .transpose()?;
        Ok(PreparedInteraction::CrosshairSnap {
            value: next,
            memory: next_memory,
            request,
            effects: InteractionEffects::prepared(&self.memory)?,
        })
    }

    /// 외부 reply gate 뒤 새 allocation 없이 snap option을 게시한다.
    pub fn publish_prepared_crosshair_snap(
        &mut self,
        prepared: PreparedInteraction,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let (value, memory, request, mut effects) = match prepared {
            PreparedInteraction::CrosshairSnap {
                value,
                memory,
                request,
                effects,
            } => (value, memory, request, effects),
            PreparedInteraction::Noop { effects } => return Ok(effects),
            _ => return Err(ordinary_error("Interaction preparation kind")),
        };
        self.crosshair_snap = value;
        self.crosshair_snap_memory = memory;
        self.update_crosshair_request(request);
        if notify {
            effects.invalidate(InteractionInvalidation::Hover);
        }
        Ok(effects)
    }

    /// Updates pointer-owned crosshair snap options without cancelling drawing work.
    pub fn set_crosshair_snap(
        &mut self,
        context: &mut InteractionContext<'_>,
        options: &JsValue,
        notify: bool,
    ) -> Result<InteractionEffects, JsError> {
        let prepared = self.prepare_set_crosshair_snap(context, options)?;
        self.publish_prepared_crosshair_snap(prepared, notify)
    }

    /// Releases pointer-specific snap metadata while retaining the raw cursor coordinates.
    pub fn release_crosshair(&mut self) -> Result<(), JsError> {
        self.ensure_active()?;
        self.release_pointer_crosshair();
        Ok(())
    }

    /// Resolves the current crosshair against an already prepared layout.
    pub fn resolve_crosshair(
        &self,
        context: &InteractionContext<'_>,
        layout: &Layout,
    ) -> Option<crate::scene::ResolvedCrosshair> {
        resolve_crosshair(
            context.model,
            context.store,
            layout,
            self.crosshair.as_ref().filter(|_| self.crosshair_visible),
        )
    }

    /// Public crosshairSnapshot API가 쓰는 full portable resolution이다.
    pub fn resolve_crosshair_snapshot(
        &self,
        context: &InteractionContext<'_>,
        layout: &Layout,
    ) -> Option<CrosshairResolution> {
        resolve_crosshair_snapshot(
            context.model,
            context.store,
            layout,
            self.crosshair.as_ref().filter(|_| self.crosshair_visible),
        )
    }

    /// Cancels drawing/view work and clears all currently-owned pointer ids.
    pub fn cancel(
        &mut self,
        context: &mut InteractionContext<'_>,
        notify: bool,
        owned_drawings_only: bool,
    ) -> Result<InteractionEffects, JsError> {
        let prepared = self.prepare_cancel(context, notify, owned_drawings_only)?;
        self.publish_prepared_cancel(context, prepared)
    }

    /// Controller/drawing cancel의 identity와 effect capacity를 reply admission 전에 준비한다.
    pub fn prepare_cancel(
        &self,
        context: &InteractionContext<'_>,
        notify: bool,
        owned_drawings_only: bool,
    ) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        let owned_transaction = self
            .gesture
            .as_ref()
            .and_then(Gesture::transaction)
            .is_some_and(|transaction| transaction_matches(context.drawings, transaction));
        let drawings = (!owned_drawings_only || owned_transaction)
            .then(|| context.drawings.prepare_cancel())
            .flatten();
        let restore_view = if let Some(gesture) = self.gesture.as_ref()
            && let (Some(viewport), Some((view, follow))) =
                (gesture.viewport(), gesture.original_view())
            && viewport_current(context, viewport)
        {
            Some((view, follow))
        } else {
            None
        };
        let mut effects = InteractionEffects::prepared(&self.memory)?;
        if notify {
            effects.invalidate(InteractionInvalidation::Default);
        }
        Ok(PreparedInteraction::Cancel {
            drawings,
            restore_view,
            effects,
        })
    }

    /// Prepared cancel을 allocation 없이 게시한다.
    pub fn publish_prepared_cancel(
        &mut self,
        context: &mut InteractionContext<'_>,
        prepared: PreparedInteraction,
    ) -> Result<InteractionEffects, JsError> {
        self.publish_prepared_cancel_parts(context.model, context.drawings, prepared)
    }

    /// DrawingStore publication callback이 전체 context 재빌림 없이 prepared cancel을 게시한다.
    pub fn publish_prepared_cancel_parts(
        &mut self,
        model: &mut ModelState,
        drawings: &mut DrawingStore,
        prepared: PreparedInteraction,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let PreparedInteraction::Cancel {
            drawings: prepared_drawings,
            restore_view,
            effects,
        } = prepared
        else {
            return Err(ordinary_error("Interaction preparation kind"));
        };
        if let Some(prepared) = prepared_drawings {
            drawings.publish_prepared_cancel(prepared);
        }
        if let Some((view, follow)) = restore_view {
            model.view = view;
            model.follow = follow;
        }
        self.clear_gesture();
        self.pointers.clear();
        Ok(effects)
    }

    /// Applies one pointer-down event using the actual layout and drawing store.
    pub fn down(
        &mut self,
        context: &mut InteractionContext<'_>,
        pointer_id: impl Borrow<JsValue>,
        x: f64,
        y: f64,
        hit_tolerance: f64,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let pointer_id = pointer_id.borrow();
        if !hit_tolerance.is_finite() || !(1.0..=32.0).contains(&hit_tolerance) {
            return Err(range_error(
                "Pointer hit tolerance must be 1..32 logical pixels",
            ));
        }
        if !x.is_finite() || !y.is_finite() {
            return Ok(InteractionEffects::default());
        }
        if self.pointers.len() >= 2 && self.pointer_index(pointer_id).is_none() {
            return Ok(InteractionEffects::default());
        }
        let prepared_pointer = self.prepare_pointer(pointer_id)?;
        self.stop_stale_viewport(context);
        self.set_pointer(pointer_id, PointerPosition { x, y }, prepared_pointer);
        if matches!(
            self.gesture,
            Some(Gesture::Wait {
                stale_viewport: true
            })
        ) {
            return Ok(default_invalidation());
        }
        if self.pointers.len() == 2 {
            if let Some(transaction) = self
                .gesture
                .as_ref()
                .and_then(Gesture::transaction)
                .filter(|transaction| transaction_matches(context.drawings, transaction))
            {
                let _ = transaction;
                context.drawings.cancel();
            }
            if self.stop_stale_viewport(context) {
                return Ok(default_invalidation());
            }
            let first = self.pointers[0].position;
            let second = self.pointers[1].position;
            let distance = js_hypot(second.x - first.x, second.y - first.y);
            self.replace_gesture(
                Some(Gesture::Pinch {
                    distance: if distance == 0.0 { 1.0 } else { distance },
                    view: context.model.view,
                    follow: context.model.follow,
                    midpoint: (first.x + second.x) / 2.0,
                    viewport: viewport_snapshot(context),
                }),
                MemoryGroup::empty(self.memory.clone()),
            );
            return Ok(default_invalidation());
        }
        if self.pointers.len() > 2 {
            return Ok(InteractionEffects::default());
        }

        let layout = context.layout()?;
        let panel = layout.panels.iter().find(|panel| {
            y >= panel.top && y <= panel.bottom && x >= panel.left && x <= panel.right
        });
        let Some(panel) = panel else {
            self.clear_gesture();
            return Ok(InteractionEffects::default());
        };
        if !ascii_eq(&self.tool, "select") {
            return self.begin_drawing(context, &layout, &panel.id, x, y);
        }

        let hit = drawing_hit_test(
            context.drawings,
            context.model,
            &layout,
            context.model.view,
            context.store,
            &mut self.hit_cache,
            context.geometry_cache,
            x,
            y,
            hit_tolerance,
            NumberDialect::PLATFORM,
        )?;
        let selected = hit.as_ref().map(|hit| &hit.id);
        if let Some(hit) = hit.as_ref().filter(|hit| !hit.locked) {
            let Some(drawing) = context
                .drawings
                .items()
                .iter()
                .find(|drawing| drawing.id == hit.id)
                .cloned()
            else {
                context.drawings.select(selected)?;
                self.replace_gesture(
                    Some(Gesture::Pan {
                        start_x: x,
                        view: context.model.view,
                        follow: context.model.follow,
                        pixel_width: panel.right - panel.left,
                        viewport: viewport_snapshot(context),
                    }),
                    MemoryGroup::empty(self.memory.clone()),
                );
                let mut effects = InteractionEffects::default();
                effects.invalidate(InteractionInvalidation::Drawings);
                return Ok(effects);
            };
            let mut gesture_scope = self.memory.scope();
            let mut screen_points = scoped_vec(drawing.points.len(), &mut gesture_scope)?;
            for point in drawing.points.iter() {
                screen_points.push(layout.to_screen(
                    context.model.view,
                    context.store,
                    point.time,
                    point.price,
                    &panel.id,
                    drawing.axis_id.as_ref(),
                ));
            }
            let mut points = scoped_vec(drawing.points.len(), &mut gesture_scope)?;
            points.extend_from_slice(&drawing.points);
            let id = hit
                .id
                .try_clone_scoped(&mut gesture_scope)
                .map_err(memory_error)?;
            let retained_panel = panel
                .id
                .try_clone_scoped(&mut gesture_scope)
                .map_err(memory_error)?;
            let axis_id = drawing
                .axis_id
                .as_ref()
                .map(|value| {
                    value
                        .try_clone_scoped(&mut gesture_scope)
                        .map_err(memory_error)
                })
                .transpose()?;
            let series_id = drawing
                .series_id
                .as_ref()
                .map(|value| {
                    value
                        .try_clone_scoped(&mut gesture_scope)
                        .map_err(memory_error)
                })
                .transpose()?;
            let projection = drawing_projection_snapshot(
                &layout,
                context.model,
                context.store,
                &panel.id,
                drawing.axis_id.as_ref(),
                &mut gesture_scope,
            )?
            .expect("hit drawing has a projected axis");
            let gesture_bytes = usize::try_from(gesture_scope.requested_bytes())
                .map_err(|_| self.memory.allocation_failure().into_js_error())?;
            let gesture_memory = gesture_scope
                .split_persistent(gesture_bytes)
                .map_err(memory_error)?;
            context.drawings.select(selected)?;
            context.drawings.begin()?;
            let transaction = context
                .drawings
                .transaction()
                .expect("begin installs a drawing transaction")
                .clone();
            self.replace_gesture(
                Some(Gesture::Edit {
                    transaction,
                    id,
                    handle: hit.handle,
                    start_x: x,
                    start_y: y,
                    screen_points,
                    points,
                    panel: retained_panel,
                    axis_id,
                    series_id,
                    kind: drawing.kind,
                    projection,
                }),
                gesture_memory,
            );
        } else {
            context.drawings.select(selected)?;
            self.replace_gesture(
                Some(Gesture::Pan {
                    start_x: x,
                    view: context.model.view,
                    follow: context.model.follow,
                    pixel_width: panel.right - panel.left,
                    viewport: viewport_snapshot(context),
                }),
                MemoryGroup::empty(self.memory.clone()),
            );
        }
        let mut effects = InteractionEffects::default();
        effects.invalidate(InteractionInvalidation::Drawings);
        Ok(effects)
    }

    /// Applies one pointer-move event, including hover-only cursor updates.
    pub fn move_pointer(
        &mut self,
        context: &mut InteractionContext<'_>,
        pointer_id: &JsValue,
        x: f64,
        y: f64,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        if !x.is_finite() || !y.is_finite() {
            return Ok(InteractionEffects::default());
        }
        let (request, request_memory) =
            persistent_snap_options(&self.crosshair_snap, &self.memory)?;
        if self.stop_stale_drawing(context) {
            return Ok(drawing_invalidation());
        }
        self.stop_stale_viewport(context);
        self.capture_crosshair(x, y, request, request_memory);
        let Some(pointer_index) = self.pointer_index(pointer_id) else {
            return Ok(hover_invalidation());
        };
        self.pointers[pointer_index].position = PointerPosition { x, y };
        let mut gesture_scope = self.memory.scope();
        let Some(gesture) = self
            .gesture
            .as_ref()
            .map(|gesture| gesture.try_clone_scoped(&mut gesture_scope))
            .transpose()?
        else {
            return Ok(InteractionEffects::default());
        };
        match gesture {
            Gesture::Wait { .. } => {}
            Gesture::Pan {
                start_x,
                view,
                pixel_width,
                ..
            } => {
                let delta = (start_x - x) / pixel_width * (view.to - view.from);
                context.model.set_visible_range(
                    context.store,
                    &JsValue::Number(view.from + delta),
                    &JsValue::Number(view.to + delta),
                )?;
            }
            Gesture::Pinch {
                distance,
                view,
                midpoint,
                ..
            } => {
                if self.pointers.len() != 2 {
                    return Ok(InteractionEffects::default());
                }
                let first = self.pointers[0].position;
                let second = self.pointers[1].position;
                let layout = context.layout()?;
                if !matches!(self.gesture, Some(Gesture::Pinch { .. })) {
                    return Ok(InteractionEffects::default());
                }
                if self.stop_stale_viewport(context) {
                    return Ok(default_invalidation());
                }
                let panel = layout.panels.first().expect("models have a base panel");
                let span = view.to - view.from;
                let current_distance = js_hypot(second.x - first.x, second.y - first.y);
                let factor = distance
                    / if current_distance == 0.0 {
                        1.0
                    } else {
                        current_distance
                    };
                let anchor = js_max(&[
                    0.0,
                    js_min(&[1.0, (midpoint - panel.left) / (panel.right - panel.left)]),
                ]);
                let at = view.from + span * anchor;
                let delta = ((first.x + second.x) / 2.0 - midpoint) / (panel.right - panel.left)
                    * span
                    * factor;
                let next_from = at - span * factor * anchor - delta;
                let next_to = at + span * factor * (1.0 - anchor) - delta;
                context.model.set_visible_range(
                    context.store,
                    &JsValue::Number(next_from),
                    &JsValue::Number(next_to),
                )?;
            }
            Gesture::Create { .. } | Gesture::Edit { .. } => {
                self.move_drawing(context, &gesture, x, y, &mut gesture_scope)?;
            }
        }
        if let Some(viewport) = self.gesture.as_mut().and_then(gesture_viewport_mut) {
            *viewport = viewport_snapshot(context);
        }
        Ok(match gesture {
            Gesture::Pan { .. } | Gesture::Pinch { .. } => all_invalidation(),
            _ => drawing_invalidation(),
        })
    }

    fn begin_drawing(
        &mut self,
        context: &mut InteractionContext<'_>,
        layout: &Layout,
        panel: &JsString,
        x: f64,
        y: f64,
    ) -> Result<InteractionEffects, JsError> {
        let mut call_scope = self.memory.scope();
        let default_target = object_value([(
            "panel",
            JsValue::String(
                panel
                    .try_clone_scoped(&mut call_scope)
                    .map_err(memory_error)?,
            ),
        )]);
        let target = self.drawing_target.as_ref().unwrap_or(&default_target);
        let target_panel = match field(target, "panel") {
            Some(JsValue::String(panel)) => panel,
            _ => return Err(type_error("Drawing target panel required")),
        };
        if target_panel != panel {
            return Ok(InteractionEffects::default());
        }
        context.model.validate_drawing_binding(target, false)?;
        let axis_id = optional_string(field(target, "axisId"), &mut call_scope)?;
        let series_id = optional_string(field(target, "seriesId"), &mut call_scope)?;
        let kind =
            DrawingType::parse(&self.tool).ok_or_else(|| ordinary_error("Unknown drawing tool"))?;
        let free = layout.from_screen(
            context.model.view,
            context.store,
            x,
            y,
            panel,
            axis_id.as_ref(),
        )?;
        let free = DrawingPoint {
            time: free.time,
            price: free.price,
        };
        let (point, snapped) = self.magnet_drawing_point(
            context,
            layout,
            panel,
            axis_id.as_ref(),
            series_id.as_ref(),
            kind,
            x,
            y,
            free,
            &mut call_scope,
        )?;
        let points = if is_position_drawing(kind) {
            let Some(points) = initial_position_points(
                kind,
                point,
                context,
                layout,
                panel,
                axis_id.as_ref(),
                &mut call_scope,
            )?
            else {
                return Ok(InteractionEffects::default());
            };
            points
        } else {
            let count = drawing_point_count(kind);
            let mut points = scoped_vec(count, &mut call_scope)?;
            points.resize(count, point);
            points
        };
        if is_position_drawing(kind) && !position_points_valid(kind, &points) {
            return Ok(InteractionEffects::default());
        }

        let mut entries = scoped_vec(8, &mut call_scope)?;
        entries.push((
            key("type"),
            JsValue::String(
                self.tool
                    .try_clone_scoped(&mut call_scope)
                    .map_err(memory_error)?,
            ),
        ));
        if let Some(target) = object(target) {
            for (name, value) in target.iter() {
                entries.push((
                    name.try_clone_scoped(&mut call_scope)
                        .map_err(memory_error)?,
                    value
                        .try_clone_scoped(&mut call_scope)
                        .map_err(memory_error)?,
                ));
            }
        }
        entries.push((
            key("panel"),
            JsValue::String(
                panel
                    .try_clone_scoped(&mut call_scope)
                    .map_err(memory_error)?,
            ),
        ));
        let mut point_values = scoped_vec(points.len(), &mut call_scope)?;
        for point in &points {
            point_values.push(point.to_value_scoped(&mut call_scope)?);
        }
        entries.push((key("points"), JsValue::Array(point_values)));
        if kind == DrawingType::Text {
            entries.push((
                key("text"),
                self.text
                    .try_clone_scoped(&mut call_scope)
                    .map_err(memory_error)?,
            ));
        }
        let record =
            JsObject::try_from_entries_scoped(entries, &mut call_scope).map_err(memory_error)?;
        let projection = drawing_projection_snapshot(
            layout,
            context.model,
            context.store,
            panel,
            axis_id.as_ref(),
            &mut call_scope,
        )?
        .ok_or_else(|| ordinary_error("Missing axis"))?;
        context.drawings.begin()?;
        let transaction = context
            .drawings
            .transaction()
            .expect("begin installs a drawing transaction")
            .clone();
        let id = match context.drawings.add(&JsValue::Object(record)) {
            Ok(id) => id,
            Err(error) => {
                if transaction_matches(context.drawings, &transaction) {
                    context.drawings.cancel();
                }
                return Err(error);
            }
        };
        let prepared = (|| {
            let mut gesture_scope = self.memory.scope();
            let id = id
                .try_clone_scoped(&mut gesture_scope)
                .map_err(memory_error)?;
            let panel = panel
                .try_clone_scoped(&mut gesture_scope)
                .map_err(memory_error)?;
            let axis_id = axis_id
                .as_ref()
                .map(|value| {
                    value
                        .try_clone_scoped(&mut gesture_scope)
                        .map_err(memory_error)
                })
                .transpose()?;
            let series_id = series_id
                .as_ref()
                .map(|value| {
                    value
                        .try_clone_scoped(&mut gesture_scope)
                        .map_err(memory_error)
                })
                .transpose()?;
            let projection = clone_projection_scoped(&projection, &mut gesture_scope)?;
            let bytes = usize::try_from(gesture_scope.requested_bytes())
                .map_err(|_| self.memory.allocation_failure().into_js_error())?;
            let memory = gesture_scope
                .split_persistent(bytes)
                .map_err(memory_error)?;
            Ok::<_, JsError>((id, panel, axis_id, series_id, projection, memory))
        })();
        let (id, panel, axis_id, series_id, projection, gesture_memory) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                if transaction_matches(context.drawings, &transaction) {
                    context.drawings.cancel();
                }
                return Err(error);
            }
        };
        let _ = snapped;
        self.replace_gesture(
            Some(Gesture::Create {
                transaction,
                id,
                panel,
                axis_id,
                series_id,
                kind,
                projection,
                last_x: x,
                last_y: y,
                moved: false,
            }),
            gesture_memory,
        );
        Ok(drawing_invalidation())
    }

    #[allow(clippy::too_many_arguments)]
    fn magnet_drawing_point(
        &self,
        context: &InteractionContext<'_>,
        layout: &Layout,
        panel: &JsString,
        axis_id: Option<&JsString>,
        series_id: Option<&JsString>,
        kind: DrawingType,
        x: f64,
        y: f64,
        free: DrawingPoint,
        scope: &mut MemoryScope,
    ) -> Result<(DrawingPoint, bool), JsError> {
        if self.drawing_magnet.mode == DrawingMagnetMode::Off || kind == DrawingType::Freehand {
            return Ok((free, false));
        }
        let target = crate::crosshair_snap::CrosshairSnapTarget {
            panel: panel.try_clone_scoped(scope).map_err(memory_error)?,
            axis_id: axis_id
                .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                .transpose()?,
            series_id: series_id
                .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                .transpose()?,
        };
        let fields = ["open", "high", "low", "close"];
        let Some(nearest) = crate::crosshair_snap::nearest_visible_ohlc(
            context.model,
            context.store,
            layout,
            x,
            y,
            &target,
            &fields,
        ) else {
            return Ok((free, false));
        };
        if self.drawing_magnet.mode == DrawingMagnetMode::Weak
            && js_hypot(nearest.x - x, nearest.y - y) > self.drawing_magnet.radius_px
        {
            return Ok((free, false));
        }
        Ok((
            DrawingPoint {
                time: nearest.time,
                price: nearest.price,
            },
            true,
        ))
    }

    fn move_drawing(
        &mut self,
        context: &mut InteractionContext<'_>,
        gesture: &Gesture,
        x: f64,
        y: f64,
        scope: &mut MemoryScope,
    ) -> Result<Option<InteractionEffects>, JsError> {
        let (
            id,
            handle,
            start_x,
            start_y,
            screen_points,
            original_points,
            panel,
            axis_id,
            series_id,
            kind,
            original_projection,
        ) = match gesture {
            Gesture::Create {
                id,
                panel,
                axis_id,
                series_id,
                kind,
                projection,
                ..
            } => (
                id,
                -1,
                0.0,
                0.0,
                &[][..],
                &[][..],
                panel,
                axis_id.as_ref(),
                series_id.as_ref(),
                *kind,
                projection,
            ),
            Gesture::Edit {
                id,
                handle,
                start_x,
                start_y,
                screen_points,
                points,
                panel,
                axis_id,
                series_id,
                kind,
                projection,
                ..
            } => (
                id,
                *handle,
                *start_x,
                *start_y,
                screen_points.as_slice(),
                points.as_slice(),
                panel,
                axis_id.as_ref(),
                series_id.as_ref(),
                *kind,
                projection,
            ),
            _ => return Ok(None),
        };
        let layout = context.layout()?;
        if self.stop_stale_drawing(context) {
            return Ok(Some(drawing_invalidation()));
        }
        let Some(drawing) = context
            .drawings
            .items()
            .iter()
            .find(|drawing| drawing.id == *id)
            .cloned()
        else {
            return Ok(Some(self.cancel(context, true, false)?));
        };
        if drawing.locked == Some(true)
            || drawing.visible == Some(false)
            || context.drawings.transaction().is_none()
            || drawing.panel != *panel
            || drawing.axis_id.as_ref() != axis_id
            || drawing.series_id.as_ref() != series_id
            || drawing.kind != kind
            || layout
                .drawing_axis(context.model, panel, axis_id, series_id)
                .is_none()
        {
            return Ok(Some(self.cancel(context, true, false)?));
        }
        let Some(current_projection) = drawing_projection_snapshot(
            &layout,
            context.model,
            context.store,
            panel,
            axis_id,
            scope,
        )?
        else {
            return Ok(Some(self.cancel(context, true, false)?));
        };
        if !same_drawing_projection(original_projection, &current_projection) {
            return Ok(Some(self.cancel(context, true, false)?));
        }
        let free_screen =
            layout.from_screen(context.model.view, context.store, x, y, panel, axis_id)?;
        let free_point = DrawingPoint {
            time: free_screen.time,
            price: free_screen.price,
        };
        let (point, snapped) = if matches!(gesture, Gesture::Create { .. }) || handle >= 0 {
            self.magnet_drawing_point(
                context, &layout, panel, axis_id, series_id, kind, x, y, free_point, scope,
            )?
        } else {
            (free_point, false)
        };
        let (points, update_freehand) = match gesture {
            Gesture::Create {
                moved,
                last_x,
                last_y,
                ..
            } => {
                if kind.is_position() {
                    let mut points = scoped_vec(drawing.points.len(), scope)?;
                    points.extend_from_slice(&drawing.points);
                    points[2].price = point.price;
                    points[3].time = point.time;
                    if !position_points_valid(kind, &points)
                        || !all_screen_points_finite(&layout, context, panel, axis_id, &points)
                    {
                        return Ok(Some(hover_invalidation()));
                    }
                    (points, false)
                } else if kind == DrawingType::Freehand {
                    if js_hypot(x - *last_x, y - *last_y) < 1.0 || drawing.points.len() >= 2_048 {
                        return Ok(Some(InteractionEffects::default()));
                    }
                    let points = if *moved {
                        let mut points = scoped_vec(drawing.points.len() + 1, scope)?;
                        points.extend_from_slice(&drawing.points);
                        points.push(point);
                        points
                    } else {
                        let mut points = scoped_vec(2, scope)?;
                        points.extend([drawing.points[0], point]);
                        points
                    };
                    (points, true)
                } else {
                    let count = drawing_point_count(kind);
                    let mut points = scoped_vec(count, scope)?;
                    if drawing.points.len() == 1 {
                        points.push(point);
                    } else {
                        points.extend([drawing.points[0], point]);
                    }
                    if drawing_point_count(kind) == 3 {
                        let anchor = if snapped {
                            layout.to_screen(
                                context.model.view,
                                context.store,
                                point.time,
                                point.price,
                                panel,
                                axis_id,
                            )
                        } else {
                            crate::layout::ScreenPoint { x, y }
                        };
                        let third = layout.from_screen(
                            context.model.view,
                            context.store,
                            anchor.x,
                            anchor.y + 40.0,
                            panel,
                            axis_id,
                        )?;
                        points.push(DrawingPoint {
                            time: third.time,
                            price: third.price,
                        });
                    }
                    (points, false)
                }
            }
            Gesture::Edit { .. } if kind.is_position() && handle >= 0 => {
                let points =
                    position_handle_points(original_points, handle as usize, point, scope)?;
                if !position_points_valid(kind, &points)
                    || !all_screen_points_finite(&layout, context, panel, axis_id, &points)
                {
                    return Ok(Some(hover_invalidation()));
                }
                (points, false)
            }
            Gesture::Edit { .. } if handle < 0 => {
                let mut points = scoped_vec(original_points.len(), scope)?;
                for (point, screen) in original_points.iter().zip(screen_points) {
                    let moved = layout.from_screen(
                        context.model.view,
                        context.store,
                        screen.x + x - start_x,
                        screen.y + y - start_y,
                        panel,
                        axis_id,
                    )?;
                    let _ = point;
                    points.push(DrawingPoint {
                        time: moved.time,
                        price: moved.price,
                    });
                }
                (points, false)
            }
            Gesture::Edit { .. } => {
                let mut points = scoped_vec(original_points.len(), scope)?;
                points.extend(original_points.iter().enumerate().map(|(index, original)| {
                    if index == handle as usize {
                        point
                    } else {
                        *original
                    }
                }));
                (points, false)
            }
            _ => return Ok(None),
        };
        if kind.is_position() && !position_points_valid(kind, &points) {
            return Ok(Some(hover_invalidation()));
        }
        let patch = patch_points(&points, scope)?;
        context.drawings.edit(id, &patch)?;
        if update_freehand
            && let Some(Gesture::Create {
                moved,
                last_x,
                last_y,
                ..
            }) = self.gesture.as_mut()
        {
            *moved = true;
            *last_x = x;
            *last_y = y;
        }
        Ok(None)
    }

    fn stop_stale_viewport(&mut self, context: &InteractionContext<'_>) -> bool {
        let stale = self
            .gesture
            .as_ref()
            .and_then(Gesture::viewport)
            .is_some_and(|viewport| !viewport_current(context, viewport));
        if stale {
            if self.pointers.is_empty() {
                self.clear_gesture();
            } else {
                self.replace_gesture(
                    Some(Gesture::Wait {
                        stale_viewport: true,
                    }),
                    MemoryGroup::empty(self.memory.clone()),
                );
            }
        }
        stale
    }

    fn stop_stale_drawing(&mut self, context: &InteractionContext<'_>) -> bool {
        let stale = self
            .gesture
            .as_ref()
            .and_then(Gesture::transaction)
            .is_some_and(|transaction| !transaction_matches(context.drawings, transaction));
        if stale {
            self.clear_gesture();
            self.pointers.clear();
        }
        stale
    }

    /// Applies one pointer-up event and commits only the currently-owned drawing transaction.
    pub fn up(
        &mut self,
        context: &mut InteractionContext<'_>,
        pointer_id: &JsValue,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        if self.stop_stale_drawing(context) {
            return Ok(drawing_invalidation());
        }
        self.stop_stale_viewport(context);
        if self.pointer_index(pointer_id).is_none() {
            return Ok(InteractionEffects::default());
        }
        if matches!(
            self.gesture,
            Some(Gesture::Create { .. } | Gesture::Edit { .. })
        ) {
            context.drawings.commit()?;
            self.remove_pointer(pointer_id);
            self.clear_gesture();
            return Ok(default_invalidation());
        }
        self.remove_pointer(pointer_id);
        match self.gesture.as_ref() {
            Some(Gesture::Wait {
                stale_viewport: true,
            }) => {
                if self.pointers.is_empty() {
                    self.clear_gesture();
                }
            }
            Some(Gesture::Pinch { .. }) => {
                if self.pointers.is_empty() {
                    self.clear_gesture();
                } else {
                    self.replace_gesture(
                        Some(Gesture::Wait {
                            stale_viewport: false,
                        }),
                        MemoryGroup::empty(self.memory.clone()),
                    );
                }
            }
            _ => self.clear_gesture(),
        }
        Ok(default_invalidation())
    }

    /// Reply admission 전에 wheel의 ToNumber/layout/zoom 작업을 stage한다.
    pub fn prepare_wheel(
        &self,
        context: &mut InteractionContext<'_>,
        delta: &JsValue,
        screen_x: &JsValue,
    ) -> Result<PreparedInteraction, JsError> {
        self.ensure_active()?;
        if self.gesture.is_some() {
            return Ok(PreparedInteraction::Noop {
                effects: InteractionEffects::prepared(&self.memory)?,
            });
        }
        let mut scope = self.memory.scope();
        let delta = js_to_number_scoped(delta, NumberDialect::PLATFORM, &mut scope)?;
        let screen_x = js_to_number_scoped(screen_x, NumberDialect::PLATFORM, &mut scope)?;
        let layout = context.layout()?;
        let panel = layout.panels.first().expect("models have a base panel");
        let factor = js_exp(js_max(&[-1.0, js_min(&[1.0, delta * 0.001])]));
        let anchor = (screen_x - panel.left) / (panel.right - panel.left);
        let view = context.model.prepare_zoom(
            context.store,
            &JsValue::Number(factor),
            Some(&JsValue::Number(anchor)),
        )?;
        Ok(PreparedInteraction::Wheel {
            view,
            effects: InteractionEffects::prepared(&self.memory)?,
        })
    }

    /// 준비한 wheel view를 fallible allocation 없이 게시한다.
    pub fn publish_prepared_wheel(
        &mut self,
        context: &mut InteractionContext<'_>,
        prepared: PreparedInteraction,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let (view, mut effects) = match prepared {
            PreparedInteraction::Wheel { view, effects } => (view, effects),
            PreparedInteraction::Noop { effects } => return Ok(effects),
            _ => return Err(ordinary_error("Interaction preparation kind")),
        };
        context.model.publish_prepared_view(view);
        effects.invalidate(InteractionInvalidation::Default);
        Ok(effects)
    }

    /// Zooms at the pointer x coordinate with source ToNumber and Math.exp semantics.
    pub fn wheel(
        &mut self,
        context: &mut InteractionContext<'_>,
        delta: &JsValue,
        screen_x: &JsValue,
    ) -> Result<InteractionEffects, JsError> {
        let prepared = self.prepare_wheel(context, delta, screen_x)?;
        self.publish_prepared_wheel(context, prepared)
    }

    /// Applies the source keyboard shortcuts in their original branch order.
    pub fn key(
        &mut self,
        context: &mut InteractionContext<'_>,
        key_value: &JsString,
        modifiers: InteractionKeyModifiers,
    ) -> Result<InteractionEffects, JsError> {
        self.ensure_active()?;
        let mut scope = self.memory.scope();
        if context.drawings.items().iter().any(|drawing| {
            context.drawings.selected() == Some(&drawing.id) && drawing.visible == Some(false)
        }) {
            context.drawings.select(None)?;
        }
        let key_z = ascii_eq_ignore_case(key_value, "z");
        let key_y = ascii_eq_ignore_case(key_value, "y");
        let undo = modifiers.ctrl && key_z && !modifiers.shift;
        let redo = modifiers.ctrl && (key_y || key_z && modifiers.shift);
        let deleting = ascii_eq(key_value, "Delete") || ascii_eq(key_value, "Backspace");
        let mut effects = InteractionEffects::default();
        if ascii_eq(key_value, "Escape") {
            effects
                .invalidations
                .extend(self.cancel(context, true, false)?.invalidations);
            context.drawings.select(None)?;
            self.crosshair_visible = false;
        } else if ascii_eq(key_value, "PageUp") || ascii_eq(key_value, "PageDown") {
            effects
                .invalidations
                .extend(self.cancel(context, true, false)?.invalidations);
            let mut visible = scoped_vec(context.drawings.items().len(), &mut scope)?;
            visible.extend(
                context
                    .drawings
                    .items()
                    .iter()
                    .filter(|drawing| drawing.visible != Some(false))
                    .map(|drawing| &drawing.id),
            );
            if !visible.is_empty() {
                let at = context
                    .drawings
                    .selected()
                    .and_then(|selected| visible.iter().position(|id| *id == selected));
                let next = if let Some(at) = at {
                    if ascii_eq(key_value, "PageUp") {
                        (at + visible.len() - 1) % visible.len()
                    } else {
                        (at + 1) % visible.len()
                    }
                } else if ascii_eq(key_value, "PageUp") {
                    visible.len() - 1
                } else {
                    0
                };
                let next = visible[next]
                    .try_clone_scoped(&mut scope)
                    .map_err(memory_error)?;
                drop(visible);
                context.drawings.select(Some(&next))?;
            }
        } else if is_arrow_key(key_value) {
            if self.gesture.is_some() {
                effects
                    .invalidations
                    .extend(self.cancel(context, true, false)?.invalidations);
            }
            let drawing = context.drawings.selected().and_then(|id| {
                context
                    .drawings
                    .items()
                    .iter()
                    .find(|drawing| drawing.id == *id)
                    .cloned()
            });
            if let Some(drawing) = &drawing
                && !modifiers.ctrl
                && drawing.locked != Some(true)
            {
                let editable = context
                    .layout()?
                    .drawing_axis(
                        context.model,
                        &drawing.panel,
                        drawing.axis_id.as_ref(),
                        drawing.series_id.as_ref(),
                    )
                    .is_some();
                if editable {
                    let layout = context.layout()?;
                    let step = if modifiers.shift { 10.0 } else { 1.0 };
                    let dx = if ascii_eq(key_value, "ArrowLeft") {
                        -step
                    } else if ascii_eq(key_value, "ArrowRight") {
                        step
                    } else {
                        0.0
                    };
                    let dy = if ascii_eq(key_value, "ArrowUp") {
                        -step
                    } else if ascii_eq(key_value, "ArrowDown") {
                        step
                    } else {
                        0.0
                    };
                    let mut points = scoped_vec(drawing.points.len(), &mut scope)?;
                    for point in drawing.points.iter() {
                        let screen = layout.to_screen(
                            context.model.view,
                            context.store,
                            point.time,
                            point.price,
                            &drawing.panel,
                            drawing.axis_id.as_ref(),
                        );
                        let point = layout
                            .from_screen(
                                context.model.view,
                                context.store,
                                screen.x + dx,
                                screen.y + dy,
                                &drawing.panel,
                                drawing.axis_id.as_ref(),
                            )
                            .map(|point| DrawingPoint {
                                time: point.time,
                                price: point.price,
                            })?;
                        points.push(point);
                    }
                    if !drawing.kind.is_position()
                        || position_points_valid(drawing.kind, &points)
                            && all_screen_points_finite(
                                &layout,
                                context,
                                &drawing.panel,
                                drawing.axis_id.as_ref(),
                                &points,
                            )
                    {
                        let patch = patch_points(&points, &mut scope)?;
                        context.drawings.edit(&drawing.id, &patch)?;
                    }
                }
            } else if drawing.is_none() || modifiers.ctrl {
                if ascii_eq(key_value, "ArrowLeft") || ascii_eq(key_value, "ArrowRight") {
                    let direction = if ascii_eq(key_value, "ArrowLeft") {
                        -1.0
                    } else {
                        1.0
                    };
                    context.model.pan(
                        context.store,
                        &JsValue::Number(
                            direction * (context.model.view.to - context.model.view.from) * 0.1,
                        ),
                    )?;
                } else {
                    let factor = if ascii_eq(key_value, "ArrowUp") {
                        0.9
                    } else {
                        1.1
                    };
                    context
                        .model
                        .zoom(context.store, &JsValue::Number(factor), None)?;
                }
            }
        } else if ["+", "=", "-", "_"]
            .iter()
            .any(|candidate| ascii_eq(key_value, candidate))
        {
            let factor = if ascii_eq(key_value, "+") || ascii_eq(key_value, "=") {
                0.8
            } else {
                1.25
            };
            context
                .model
                .zoom(context.store, &JsValue::Number(factor), None)?;
        } else if ascii_eq(key_value, "Home") {
            context.model.fit(context.store);
        } else if ascii_eq(key_value, "End") {
            context.model.set_visible_range(
                context.store,
                &JsValue::Number(context.store.length() as f64 - 200.5),
                &JsValue::Number(context.store.length() as f64 - 0.5),
            )?;
        } else if undo || redo || deleting {
            let active = self.gesture.is_some();
            let selected = context
                .drawings
                .selected()
                .map(|value| value.try_clone_scoped(&mut scope).map_err(memory_error))
                .transpose()?;
            if active {
                effects
                    .invalidations
                    .extend(self.cancel(context, true, false)?.invalidations);
            }
            if undo && !active {
                context.drawings.undo()?;
            } else if redo {
                context.drawings.redo()?;
            } else if deleting && let Some(selected) = selected {
                context.drawings.remove(&selected)?;
            }
        }
        effects.invalidate(InteractionInvalidation::Default);
        Ok(effects)
    }

    /// Retires this state and releases only work it still owns.
    pub fn retire(&mut self, context: &mut InteractionContext<'_>) -> bool {
        if self.retired {
            return false;
        }
        self.retired = true;
        self.release_pointer_crosshair();
        if let Some(transaction) = self
            .gesture
            .as_ref()
            .and_then(Gesture::transaction)
            .filter(|transaction| transaction_matches(context.drawings, transaction))
        {
            let _ = transaction;
            context.drawings.cancel();
        }
        if let Some(gesture) = self.gesture.as_ref()
            && let (Some(viewport), Some((view, follow))) =
                (gesture.viewport(), gesture.original_view())
            && viewport_current(context, viewport)
        {
            context.model.view = view;
            context.model.follow = follow;
        }
        self.clear_gesture();
        self.pointers.clear();
        true
    }
}

fn object_value(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in entries {
        object.insert(key(name), value);
    }
    JsValue::Object(object)
}

fn default_invalidation() -> InteractionEffects {
    InteractionEffects {
        invalidations: vec![InteractionInvalidation::Default],
    }
}

fn drawing_invalidation() -> InteractionEffects {
    InteractionEffects {
        invalidations: vec![InteractionInvalidation::Drawings],
    }
}

fn hover_invalidation() -> InteractionEffects {
    InteractionEffects {
        invalidations: vec![InteractionInvalidation::Hover],
    }
}

fn all_invalidation() -> InteractionEffects {
    InteractionEffects {
        invalidations: vec![InteractionInvalidation::All],
    }
}

fn viewport_snapshot(context: &InteractionContext<'_>) -> ViewportSnapshot {
    ViewportSnapshot {
        data_identity: context.store.data_identity(),
        serial: context.store.serial(),
        time_version: context.store.time_version(),
        view: context.model.view,
        follow: context.model.follow,
    }
}

fn viewport_current(context: &InteractionContext<'_>, snapshot: &ViewportSnapshot) -> bool {
    snapshot
        .data_identity
        .same_store(&context.store.data_identity())
        && same_value(snapshot.serial, context.store.serial())
        && same_value(snapshot.time_version, context.store.time_version())
        && same_value(snapshot.view.from, context.model.view.from)
        && same_value(snapshot.view.to, context.model.view.to)
        && snapshot.follow == context.model.follow
}

fn transaction_matches(store: &DrawingStore, snapshot: &DrawingSnapshot) -> bool {
    store
        .transaction()
        .is_some_and(|current| Arc::ptr_eq(current, snapshot))
}

fn gesture_viewport_mut(gesture: &mut Gesture) -> Option<&mut ViewportSnapshot> {
    match gesture {
        Gesture::Pan { viewport, .. } | Gesture::Pinch { viewport, .. } => Some(viewport),
        _ => None,
    }
}

fn drawing_projection_snapshot(
    layout: &Layout,
    model: &ModelState,
    store: &BarStore,
    panel_id: &JsString,
    axis_id: Option<&JsString>,
    scope: &mut MemoryScope,
) -> Result<Option<DrawingProjectionSnapshot>, JsError> {
    let Some(axis) = layout.axis(panel_id, axis_id) else {
        return Ok(None);
    };
    Ok(Some(DrawingProjectionSnapshot {
        left: axis.left,
        right: axis.right,
        top: axis.top,
        bottom: axis.bottom,
        min: axis.min,
        max: axis.max,
        scale: axis
            .scale_name
            .try_clone_scoped(scope)
            .map_err(memory_error)?,
        inverted: matches!(field(&axis.config, "inverted"), Some(JsValue::Bool(true))),
        base: axis.base,
        view_from: model.view.from,
        view_to: model.view.to,
        serial: store.serial(),
        time_version: store.time_version(),
    }))
}

fn same_drawing_projection(
    left: &DrawingProjectionSnapshot,
    right: &DrawingProjectionSnapshot,
) -> bool {
    same_value(left.left, right.left)
        && same_value(left.right, right.right)
        && same_value(left.top, right.top)
        && same_value(left.bottom, right.bottom)
        && same_value(left.min, right.min)
        && same_value(left.max, right.max)
        && left.scale == right.scale
        && left.inverted == right.inverted
        && same_value(left.base, right.base)
        && same_value(left.view_from, right.view_from)
        && same_value(left.view_to, right.view_to)
        && same_value(left.serial, right.serial)
        && same_value(left.time_version, right.time_version)
}

fn optional_string(
    value: Option<&JsValue>,
    scope: &mut MemoryScope,
) -> Result<Option<JsString>, JsError> {
    match value {
        Some(JsValue::String(value)) => value
            .try_clone_scoped(scope)
            .map(Some)
            .map_err(memory_error),
        _ => Ok(None),
    }
}

fn drawing_point_count(kind: DrawingType) -> usize {
    if kind.is_position() {
        4
    } else {
        match kind {
            DrawingType::Horizontal | DrawingType::Text => 1,
            DrawingType::Channel | DrawingType::FibExtension => 3,
            _ => 2,
        }
    }
}

fn position_points_valid(kind: DrawingType, points: &[DrawingPoint]) -> bool {
    if points.len() != 4
        || points.iter().any(|point| {
            !point.time.is_finite()
                || point.time.abs() > 8_640_000_000_000_000.0
                || !point.price.is_finite()
        })
    {
        return false;
    }
    position_metrics_for_parts(kind, points).is_ok()
}

fn initial_position_points(
    kind: DrawingType,
    point: DrawingPoint,
    context: &InteractionContext<'_>,
    layout: &Layout,
    panel: &JsString,
    axis_id: Option<&JsString>,
    scope: &mut MemoryScope,
) -> Result<Option<Vec<DrawingPoint>>, JsError> {
    let Some(axis) = layout.axis(panel, axis_id) else {
        return Ok(None);
    };
    let screen = layout.to_screen(
        context.model.view,
        context.store,
        point.time,
        point.price,
        panel,
        axis_id,
    );
    let first = axis.scale.price(screen.y - 40.0);
    let second = axis.scale.price(screen.y + 40.0);
    let low = js_min(&[first, second]);
    let high = js_max(&[first, second]);
    let is_long = kind == DrawingType::LongPosition;
    let extent = layout
        .from_screen(
            context.model.view,
            context.store,
            screen.x + 80.0,
            screen.y,
            panel,
            axis_id,
        )
        .ok();
    let Some(extent) = extent else {
        return Ok(None);
    };
    let mut points = scoped_vec(4, scope)?;
    points.extend([
        point,
        DrawingPoint {
            time: point.time,
            price: if is_long { low } else { high },
        },
        DrawingPoint {
            time: point.time,
            price: if is_long { high } else { low },
        },
        DrawingPoint {
            time: extent.time,
            price: point.price,
        },
    ]);
    Ok(position_points_valid(kind, &points).then_some(points))
}

fn position_handle_points(
    points: &[DrawingPoint],
    handle: usize,
    point: DrawingPoint,
    scope: &mut MemoryScope,
) -> Result<Vec<DrawingPoint>, JsError> {
    let mut next = scoped_vec(points.len(), scope)?;
    next.extend_from_slice(points);
    if handle >= next.len() {
        return Ok(next);
    }
    if handle == 0 {
        next[0] = point;
        next[1].time = point.time;
        next[2].time = point.time;
        next[3].price = point.price;
    } else if handle == 1 || handle == 2 {
        next[handle].price = point.price;
    } else if handle == 3 {
        next[3].time = point.time;
    }
    Ok(next)
}

fn all_screen_points_finite(
    layout: &Layout,
    context: &InteractionContext<'_>,
    panel: &JsString,
    axis_id: Option<&JsString>,
    points: &[DrawingPoint],
) -> bool {
    points.iter().all(|point| {
        let screen = layout.to_screen(
            context.model.view,
            context.store,
            point.time,
            point.price,
            panel,
            axis_id,
        );
        screen.x.is_finite() && screen.y.is_finite()
    })
}

fn patch_points(points: &[DrawingPoint], scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let mut values = scoped_vec(points.len(), scope)?;
    for point in points {
        values.push(point.to_value_scoped(scope)?);
    }
    Ok(object_value([("points", JsValue::Array(values))]))
}

fn ascii_eq_ignore_case(value: &JsString, expected: &str) -> bool {
    value.as_units().len() == expected.len()
        && value
            .as_units()
            .iter()
            .copied()
            .zip(expected.bytes())
            .all(|(actual, expected)| {
                actual == u16::from(expected) || actual == u16::from(expected.to_ascii_uppercase())
            })
}

fn is_arrow_key(value: &JsString) -> bool {
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
        .iter()
        .any(|candidate| ascii_eq(value, candidate))
}

fn gesture_value(gesture: &Gesture, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let mut object = JsObject::new();
    object.insert(
        key("kind"),
        JsValue::String(JsString::from_str(gesture.kind())),
    );
    match gesture {
        Gesture::Wait { stale_viewport } => {
            if *stale_viewport {
                object.insert(key("staleViewport"), JsValue::Bool(true));
            }
        }
        Gesture::Pan {
            start_x,
            view,
            follow,
            pixel_width,
            viewport,
        } => {
            object.insert(key("startX"), JsValue::Number(*start_x));
            object.insert(key("view"), view_value(*view));
            object.insert(key("follow"), JsValue::Bool(*follow));
            object.insert(key("pixelWidth"), JsValue::Number(*pixel_width));
            object.insert(key("viewport"), viewport_value(viewport));
        }
        Gesture::Pinch {
            distance,
            view,
            follow,
            midpoint,
            viewport,
        } => {
            object.insert(key("distance"), JsValue::Number(*distance));
            object.insert(key("view"), view_value(*view));
            object.insert(key("follow"), JsValue::Bool(*follow));
            object.insert(key("midpoint"), JsValue::Number(*midpoint));
            object.insert(key("viewport"), viewport_value(viewport));
        }
        Gesture::Create {
            transaction,
            id,
            panel,
            axis_id,
            series_id,
            kind,
            projection,
            last_x,
            last_y,
            moved,
        } => {
            object.insert(key("transaction"), snapshot_ids(transaction, scope)?);
            object.insert(
                key("id"),
                JsValue::String(id.try_clone_scoped(scope).map_err(memory_error)?),
            );
            object.insert(
                key("panel"),
                JsValue::String(panel.try_clone_scoped(scope).map_err(memory_error)?),
            );
            object.insert(
                key("axisId"),
                axis_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map(JsValue::String))
                    .transpose()
                    .map_err(memory_error)?
                    .unwrap_or(JsValue::Undefined),
            );
            object.insert(
                key("seriesId"),
                series_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map(JsValue::String))
                    .transpose()
                    .map_err(memory_error)?
                    .unwrap_or(JsValue::Undefined),
            );
            object.insert(
                key("type"),
                JsValue::String(JsString::from_str(kind.as_js())),
            );
            object.insert(key("projection"), projection_value(projection, scope)?);
            object.insert(key("lastX"), JsValue::Number(*last_x));
            object.insert(key("lastY"), JsValue::Number(*last_y));
            object.insert(key("moved"), JsValue::Bool(*moved));
        }
        Gesture::Edit {
            transaction,
            id,
            handle,
            start_x,
            start_y,
            screen_points,
            points,
            panel,
            axis_id,
            series_id,
            kind,
            projection,
        } => {
            object.insert(key("transaction"), snapshot_ids(transaction, scope)?);
            object.insert(
                key("id"),
                JsValue::String(id.try_clone_scoped(scope).map_err(memory_error)?),
            );
            object.insert(key("handle"), JsValue::Number(f64::from(*handle)));
            object.insert(key("startX"), JsValue::Number(*start_x));
            object.insert(key("startY"), JsValue::Number(*start_y));
            let mut screen_values = scoped_vec(screen_points.len(), scope)?;
            screen_values.extend(screen_points.iter().map(|point| {
                object_value([
                    ("x", JsValue::Number(point.x)),
                    ("y", JsValue::Number(point.y)),
                ])
            }));
            object.insert(key("screenPoints"), JsValue::Array(screen_values));
            let mut point_values = scoped_vec(points.len(), scope)?;
            for point in points {
                point_values.push(point.to_value_scoped(scope)?);
            }
            object.insert(key("points"), JsValue::Array(point_values));
            object.insert(
                key("panel"),
                JsValue::String(panel.try_clone_scoped(scope).map_err(memory_error)?),
            );
            object.insert(
                key("axisId"),
                axis_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map(JsValue::String))
                    .transpose()
                    .map_err(memory_error)?
                    .unwrap_or(JsValue::Undefined),
            );
            object.insert(
                key("seriesId"),
                series_id
                    .as_ref()
                    .map(|value| value.try_clone_scoped(scope).map(JsValue::String))
                    .transpose()
                    .map_err(memory_error)?
                    .unwrap_or(JsValue::Undefined),
            );
            object.insert(
                key("type"),
                JsValue::String(JsString::from_str(kind.as_js())),
            );
            object.insert(key("projection"), projection_value(projection, scope)?);
        }
    }
    Ok(JsValue::Object(object))
}

fn snapshot_ids(snapshot: &DrawingSnapshot, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let mut values = scoped_vec(snapshot.len(), scope)?;
    for drawing in snapshot.iter() {
        values.push(JsValue::String(
            drawing.id.try_clone_scoped(scope).map_err(memory_error)?,
        ));
    }
    Ok(JsValue::Array(values))
}

fn view_value(view: VisibleRange) -> JsValue {
    object_value([
        ("from", JsValue::Number(view.from)),
        ("to", JsValue::Number(view.to)),
    ])
}

fn viewport_value(viewport: &ViewportSnapshot) -> JsValue {
    object_value([
        ("identity", JsValue::Number(viewport.serial)),
        ("timeVersion", JsValue::Number(viewport.time_version)),
        ("from", JsValue::Number(viewport.view.from)),
        ("to", JsValue::Number(viewport.view.to)),
        ("follow", JsValue::Bool(viewport.follow)),
    ])
}

fn projection_value(
    projection: &DrawingProjectionSnapshot,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut values = scoped_vec(13, scope)?;
    values.extend([
        JsValue::Number(projection.left),
        JsValue::Number(projection.right),
        JsValue::Number(projection.top),
        JsValue::Number(projection.bottom),
        JsValue::Number(projection.min),
        JsValue::Number(projection.max),
        JsValue::String(
            projection
                .scale
                .try_clone_scoped(scope)
                .map_err(memory_error)?,
        ),
        JsValue::Bool(projection.inverted),
        JsValue::Number(projection.base),
        JsValue::Number(projection.view_from),
        JsValue::Number(projection.view_to),
        JsValue::Number(projection.serial),
        JsValue::Number(projection.time_version),
    ]);
    Ok(JsValue::Array(values))
}

#[cfg(test)]
mod prepared_reply_tests {
    use super::*;

    #[test]
    fn text_and_tool_preparation_do_not_publish_before_consumption() {
        let mut controller = OwnedInteractionState::new();
        let text = JsValue::String(JsString::from_str("prepared"));
        let prepared_text = controller.prepare_set_text(&text).unwrap();
        assert!(matches!(
            controller.text(),
            JsValue::String(value) if value == &JsString::from_str("Note")
        ));
        let _ = controller
            .publish_prepared_text(prepared_text, false)
            .unwrap();
        assert!(matches!(
            controller.text(),
            JsValue::String(value) if value == &JsString::from_str("prepared")
        ));

        let prepared_tool = controller
            .prepare_set_tool(&JsValue::String(JsString::from_str("trendline")))
            .unwrap();
        assert_eq!(controller.tool(), &JsString::from_str("select"));
        drop(prepared_tool);
        assert_eq!(controller.tool(), &JsString::from_str("select"));
    }

    #[test]
    fn equal_magnet_settings_prepare_as_noop_without_retention() {
        let controller = OwnedInteractionState::new();
        let magnet = JsValue::Object({
            let mut object = JsObject::new();
            object.insert(
                JsString::from_str("mode"),
                JsValue::String(JsString::from_str("off")),
            );
            object.insert(JsString::from_str("radiusPx"), JsValue::Number(8.0));
            object
        });
        assert!(matches!(
            controller.prepare_set_drawing_magnet(&magnet).unwrap(),
            PreparedInteraction::Noop { .. }
        ));
    }

    #[test]
    fn raw_target_publication_is_retained_before_gate_and_clear_is_allocation_free() {
        let mut controller = OwnedInteractionState::new();
        let target = JsValue::String(JsString::from_str("prepared-target"));
        let prepared = controller
            .prepare_drawing_target_publication(Some(&target))
            .unwrap();
        assert!(controller.drawing_target().is_none());
        controller
            .publish_prepared_drawing_target_raw(prepared)
            .unwrap();
        assert!(matches!(
            controller.drawing_target(),
            Some(JsValue::String(value)) if value == &JsString::from_str("prepared-target")
        ));

        let clear = controller.prepare_drawing_target_publication(None).unwrap();
        controller
            .publish_prepared_drawing_target_raw(clear)
            .unwrap();
        assert!(controller.drawing_target().is_none());
    }
}
