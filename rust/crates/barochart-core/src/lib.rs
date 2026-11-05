//! Rust 네이티브 차트의 데이터·지표·모델·장면 처리 코어다.
#![forbid(unsafe_code)]

/// 배치 한도 옵션을 검증한다.
pub mod batch_options;
/// 빌린 열의 블록 집계를 다룬다.
pub mod block_range;
/// 체크포인트의 무손실 문서 코덱을 다룬다.
pub mod checkpoint_codec;
/// JS와 같은 코어 공통 한도와 값 계약을 다룬다.
pub mod contracts;
/// OHLCV 데이터와 원자적 변경을 다룬다.
pub mod data;
/// 순서를 고정한 구간 집계를 다룬다.
pub mod range_index;

/// 지표별 checkpoint 상태의 의미를 검증한다.
pub mod indicator_checkpoint;
/// 35 builtin과 pressure 계산을 typed dispatch로 연결한다.
pub mod indicator_dispatch;
/// 지표의 rolling·smoothing·checkpoint 공통 연산을 다룬다.
pub mod indicator_helpers;
/// 정적 linked module과 문서 binding을 다룬다.
pub mod indicator_modules;
/// 지표 파라미터의 값과 키 순서를 검증한다.
pub mod indicator_params;
/// 정적 지표 이름과 provenance 메타데이터를 다룬다.
pub mod indicator_registry;
/// 지표 정의와 고정 출력 행 타입을 다룬다.
pub mod indicator_types;
/// 평균 계열 지표의 계산 상태다.
pub mod indicators_average;
/// 모멘텀과 범위 계열 지표의 계산 상태다.
pub mod indicators_momentum;
/// 거래량 계열 지표의 계산 상태다.
pub mod indicators_volume;
/// 시장 시각과 세션 달력을 다룬다.
pub mod markets;
/// 네이티브 staging checkpoint의 byte ledger를 다룬다.
pub mod native_checkpoints;
/// 세션 VWAP와 Pivots 계산을 다룬다.
pub mod session_studies;
/// 정적 pressure 지표를 다룬다.
pub mod trusted_studies;

/// 검증된 코어 처리 모듈을 연결한다.
pub mod axis_scale;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod coercion;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod data_input;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod indicator_engine;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod indicator_query;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod ingestion;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod labels;
/// 검증된 코어 처리 모듈을 연결한다.
pub mod model_state;

/// 드로잉 상태와 검증을 연결한다.
pub mod drawing_document;
/// 드로잉 상태와 검증을 연결한다.
pub mod drawing_edit;
/// 드로잉 상태와 검증을 연결한다.
pub mod drawing_types;
/// 드로잉 상태와 검증을 연결한다.
pub mod drawing_validation;
/// 드로잉 상태와 검증을 연결한다.
pub mod drawings;
/// 드로잉 상태와 검증을 연결한다.
pub mod position_drawing;

/// 지표 params의 동기 교체를 staging한다.
pub mod indicator_params_update;
/// Study 문서의 원자 저장·추가 로드를 다룬다.
pub mod study_setup;

/// 실제 코어 모듈을 연결한다.
pub mod layout;

/// 실제 코어 모듈을 연결한다.
pub mod series_cache;

/// 실제 코어 모듈을 연결한다.
pub mod data_explorer;

/// 실제 코어 모듈을 연결한다.
pub mod compaction;

/// 실제 장면 처리 모듈을 연결한다.
pub mod drawing_geometry;

/// 실제 장면 처리 모듈을 연결한다.
pub mod scene_parts;

/// 실제 장면 처리 모듈을 연결한다.
pub mod scene;

/// 명령의 검증과 차트 상태 변경을 연결한다.
pub mod chart_api;
/// Renderer별 base/drawing/hover layer와 layout을 재사용한다.
pub mod frame_cache;
/// 저장 봉을 keyboard로 선택하는 DOM 없는 상태를 다룬다.
pub mod keyboard_explorer;
/// 네이티브 차트의 합성 소유자를 다룬다.
pub mod native_chart;
/// 네이티브 command packet의 문자열과 F64 전송을 다룬다.
pub mod native_packet;
/// Crosshair가 가리키는 실제 데이터와 axis readout을 다룬다.
pub mod readout;

/// 네이티브 상태 처리 모듈을 연결한다.
pub mod crosshair_snap;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod drawing_hit_test;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod interaction;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod native_data_jobs;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod native_params_jobs;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod native_workspace;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod native_workspace_source;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod native_workspace_target;
/// 네이티브 상태 처리 모듈을 연결한다.
pub mod workspace;

/// 비동기 native namespace의 slot과 수명을 소유한다.
pub mod native_runtime;
/// Native UI 캡처와 분할 전송·복원을 다룬다.
pub mod native_ui;

/// 웹 actor의 제한된 표시·메타데이터 조회다.
#[cfg(any(target_arch = "wasm32", test))]
pub mod web;
pub mod web_layout;

use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use data::{ModelDataState, StoreOptions};
use ingestion::IngestionOwner;
use native_chart::NativeChart;

/// Native global size object의 값과 교체 identity를 보존한다.
#[derive(Clone)]
pub struct NativeSizeState {
    payload: std::sync::Arc<NativeSizePayload>,
}

struct NativeSizePayload {
    width: JsValue,
    height: JsValue,
    _memory: MemoryGroup,
}
impl NativeSizeState {
    /// 원시 width 값이다.
    pub fn width(&self) -> &JsValue {
        &self.payload.width
    }
    /// 원시 height 값이다.
    pub fn height(&self) -> &JsValue {
        &self.payload.height
    }
    /// 값이 같아도 global size object 교체를 구분한다.
    pub fn same_identity(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.payload, &other.payload)
    }
}

fn reserve_walk_stack(
    stack: &mut Vec<&JsValue>,
    additional: usize,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    let needed = stack
        .len()
        .checked_add(additional)
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    if needed <= stack.capacity() {
        return Ok(());
    }
    let added_capacity = needed - stack.capacity();
    let bytes = added_capacity
        .checked_mul(std::mem::size_of::<&JsValue>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope
        .try_grow(bytes)
        .map_err(|failure| failure.into_js_error())?;
    stack
        .try_reserve_exact(needed - stack.len())
        .map_err(|_| scope.allocation_failure().into_js_error())
}

/// 임의 C ABI JSON tree의 nominal retained payload를 재귀 없이 계산한다.
pub(crate) fn js_value_heap_bytes_scoped(
    value: &JsValue,
    scope: &mut MemoryScope,
) -> Result<usize, JsError> {
    let mut stack = Vec::new();
    reserve_walk_stack(&mut stack, 1, scope)?;
    stack.push(value);
    let mut bytes = 0usize;
    while let Some(value) = stack.pop() {
        match value {
            JsValue::String(value) => {
                bytes = bytes
                    .checked_add(
                        value
                            .len_utf16()
                            .checked_mul(std::mem::size_of::<u16>())
                            .ok_or_else(|| scope.allocation_failure().into_js_error())?,
                    )
                    .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            }
            JsValue::Array(values) => {
                bytes = bytes
                    .checked_add(
                        values
                            .len()
                            .checked_mul(std::mem::size_of::<JsValue>())
                            .ok_or_else(|| scope.allocation_failure().into_js_error())?,
                    )
                    .ok_or_else(|| scope.allocation_failure().into_js_error())?;
                reserve_walk_stack(&mut stack, values.len(), scope)?;
                stack.extend(values);
            }
            JsValue::Object(object) => {
                let entries = object
                    .len()
                    .checked_mul(std::mem::size_of::<(JsString, JsValue)>())
                    .ok_or_else(|| scope.allocation_failure().into_js_error())?;
                let lookup = if object.len() > 8 {
                    object
                        .len()
                        .checked_mul(std::mem::size_of::<(JsString, usize)>())
                        .ok_or_else(|| scope.allocation_failure().into_js_error())?
                } else {
                    0
                };
                bytes = bytes
                    .checked_add(entries)
                    .and_then(|bytes| bytes.checked_add(lookup))
                    .ok_or_else(|| scope.allocation_failure().into_js_error())?;
                reserve_walk_stack(&mut stack, object.len(), scope)?;
                for (key, value) in object.iter() {
                    bytes = bytes
                        .checked_add(
                            key.len_utf16()
                                .checked_mul(std::mem::size_of::<u16>())
                                .ok_or_else(|| scope.allocation_failure().into_js_error())?,
                        )
                        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
                    stack.push(value);
                }
            }
            JsValue::Undefined | JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) => {}
        }
    }
    Ok(bytes)
}

/// 호스트 콜백이 실패했음을 나타내는 불투명 오류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostError;

/// 엔진이 소유하며 현재 소유 스레드에서 부르는 호스트 서비스다.
/// 구현은 엔진이 다른 스레드로 옮겨가도 유효해야 한다.
pub trait Host: Send {
    /// 허용된 시간대 이름을 표준 이름으로 해석한다.
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError>;
    /// 유한한 epoch 밀리초에서의 시간대 오프셋을 초 단위로 돌려준다.
    fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError>;
    /// 사용자 페이로드를 노출하지 않는 개발자 진단을 남긴다.
    fn log(&self, level: i32, message: &str);
}

fn script_reference(name: &str) -> JsError {
    #[cfg(target_os = "android")]
    let message = format!("'{name}' is not defined");
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let message = format!("Can't find variable: {name}");
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let message = format!("{name} is not defined");
    JsError::new("ReferenceError", JsString::from_str(&message))
}

struct LatestLayout {
    layout: std::sync::Arc<layout::Layout>,
    owner: data::DataIdentity,
}

/// 호스트와 게시된 차트의 네이티브 수명을 소유한다.
/// `Send`이지만 호스트가 `Sync`일 필요는 없으므로 의도적으로 `Sync`가 아니다.
pub struct Engine {
    host: Box<dyn Host>,
    memory: MemoryContext,
    chart: Option<NativeChart>,
    next_store_serial: f64,
    size: Option<NativeSizeState>,
    input: Option<interaction::OwnedInteractionState>,
    frame_caches: std::collections::BTreeMap<JsString, frame_cache::NativeFrameCache>,
    latest_layout: Option<LatestLayout>,
    runtime: Box<native_runtime::NativeRuntime>,
    explorer: Option<keyboard_explorer::NativeKeyboardExplorer>,
}

impl Engine {
    /// 엔진 수명 동안 호스트 서비스의 소유권을 받는다.
    pub fn new(host: Box<dyn Host>) -> Self {
        Self {
            host,
            memory: MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
            chart: None,
            next_store_serial: 1.0,
            size: None,
            input: None,
            frame_caches: std::collections::BTreeMap::new(),
            latest_layout: None,
            runtime: Box::new(native_runtime::NativeRuntime::new()),
            explorer: None,
        }
    }

    /// 차트가 생성되기 전에 엔진별 allocation account를 설치한다.
    pub fn set_memory_context(&mut self, memory: MemoryContext) -> Result<(), JsError> {
        if self.chart.is_some() {
            return Err(JsError::new(
                "Error",
                JsString::from_str("Engine memory context already active"),
            ));
        }
        self.runtime.set_memory_context(memory.clone())?;
        self.memory = memory;
        Ok(())
    }

    /// 같은 runtime의 detached owner도 사용하는 allocation account다.
    pub fn memory_context(&self) -> &MemoryContext {
        &self.memory
    }

    /// 현재 네이티브 모델이 소유한 데이터 상태다. 초기화 전에는 없다.
    pub fn data_state(&self) -> Option<&ModelDataState> {
        self.chart.as_ref().map(NativeChart::data)
    }

    /// 현재 네이티브 모델 데이터의 배타적 빌림이다.
    pub fn data_state_mut(&mut self) -> Option<&mut ModelDataState> {
        self.chart.as_mut().map(NativeChart::data_mut)
    }

    /// nativeInit의 빈 BarStore를 만든다. 뒤의 count/options 실패에도 serial은 소비된다.
    pub fn stage_empty_data(&mut self) -> Result<ModelDataState, JsError> {
        let serial = self.next_store_serial;
        self.next_store_serial += 1.0;
        ModelDataState::with_serial_and_memory(
            serial,
            StoreOptions::default(),
            Vec::new(),
            self.memory.clone(),
        )
    }

    /// global nativeSize의 현재 값이다. 처음 nativeInit/resize 전에는 없다.
    pub fn native_size(&self) -> Option<&NativeSizeState> {
        self.size.as_ref()
    }

    fn stage_native_size(
        &self,
        width: &JsValue,
        height: &JsValue,
    ) -> Result<NativeSizeState, JsError> {
        let mut walk_scope = self.memory.scope();
        let retained_bytes = js_value_heap_bytes_scoped(width, &mut walk_scope)?
            .checked_add(js_value_heap_bytes_scoped(height, &mut walk_scope)?)
            .ok_or_else(|| self.memory.allocation_failure().into_js_error())?;
        drop(walk_scope);

        let mut clone_scope = self.memory.scope();
        let width = width
            .try_clone_scoped(&mut clone_scope)
            .map_err(|failure| failure.into_js_error())?;
        let height = height
            .try_clone_scoped(&mut clone_scope)
            .map_err(|failure| failure.into_js_error())?;
        let memory = clone_scope
            .split_persistent(retained_bytes)
            .map_err(|failure| failure.into_js_error())?;
        Ok(NativeSizeState {
            payload: std::sync::Arc::new(NativeSizePayload {
                width,
                height,
                _memory: memory,
            }),
        })
    }

    /// 원본과 같이 매 호출 새 size object identity를 만들고 후보가 완성된 뒤 게시한다.
    pub fn set_native_size(&mut self, width: &JsValue, height: &JsValue) -> Result<(), JsError> {
        self.set_native_size_with_reply_gate(width, height, &mut || Ok(()))
    }

    /// Size 후보를 완성한 뒤 fixed reply admission 직후 allocation 없이 게시한다.
    pub fn set_native_size_with_reply_gate(
        &mut self,
        width: &JsValue,
        height: &JsValue,
        gate: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<(), JsError> {
        let candidate = self.stage_native_size(width, height)?;
        gate()?;
        self.size = Some(candidate);
        Ok(())
    }

    /// 현재 차트와 호스트를 같은 호출 동안 빌린다.
    pub fn chart_and_host_mut(&mut self) -> Option<(&mut NativeChart, &dyn Host)> {
        self.chart.as_mut().map(|chart| (chart, self.host.as_ref()))
    }

    /// Command가 mutation동안 controller의 짧은 snapshot을 고정한다.
    pub fn command_parts(
        &mut self,
    ) -> Option<(
        &mut NativeChart,
        &interaction::OwnedInteractionState,
        &dyn Host,
    )> {
        Some((
            self.chart.as_mut()?,
            self.input.as_ref()?,
            self.host.as_ref(),
        ))
    }

    /// Native API mutation이 동일 controller의 수명을 실제로 조정하도록 나눈 빌림이다.
    pub fn command_parts_mut(
        &mut self,
    ) -> Option<(
        &mut NativeChart,
        &mut interaction::OwnedInteractionState,
        &dyn Host,
        f64,
        f64,
    )> {
        let number = |value: Option<&JsValue>| match value {
            Some(JsValue::Number(v)) => *v,
            _ => f64::NAN,
        };
        let width = number(self.size.as_ref().map(NativeSizeState::width));
        let height = number(self.size.as_ref().map(NativeSizeState::height));
        Some((
            self.chart.as_mut()?,
            self.input.as_mut()?,
            self.host.as_ref(),
            width,
            height,
        ))
    }

    /// Legacy indicator helper는 entry를 먼저 추가한 뒤 output series를 차례로 게시한다.
    pub fn add_legacy_indicator(
        &mut self,
        id: &JsValue,
        name: &JsValue,
        params: &JsValue,
        panel: &JsValue,
    ) -> Result<JsValue, JsError> {
        let mut scope = self.memory_context().scope();
        self.add_legacy_indicator_scoped(id, name, params, panel, &mut scope)
    }

    /// caller scope에서 raw name/panel과 반환 배열을 유지하는 legacy indicator helper다.
    pub fn add_legacy_indicator_scoped(
        &mut self,
        id: &JsValue,
        name: &JsValue,
        params: &JsValue,
        panel: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let chart = self
            .chart
            .as_mut()
            .ok_or_else(|| script_reference("nativeModel"))?;
        let outputs = chart
            .indicators
            .add_scoped(
                chart.ingestion.data().store(),
                self.host.as_ref(),
                id,
                name,
                params,
                scope,
            )?
            .definition()
            .outputs
            .to_vec();
        let panel = if matches!(panel, JsValue::Undefined) {
            JsValue::String(
                JsString::try_from_str("price", scope)
                    .map_err(|failure| failure.into_js_error())?,
            )
        } else {
            panel
                .try_clone_scoped(scope)
                .map_err(|failure| failure.into_js_error())?
        };
        let id = match id {
            JsValue::String(id) => id,
            _ => unreachable!("add validated identifier"),
        };
        for output in &outputs {
            let length = id
                .len_utf16()
                .checked_add(1)
                .and_then(|length| length.checked_add(output.encode_utf16().count()))
                .ok_or_else(|| scope.allocation_failure().into_js_error())?;
            scope
                .try_grow(length.saturating_mul(std::mem::size_of::<u16>()))
                .map_err(|failure| failure.into_js_error())?;
            let mut units = Vec::new();
            units
                .try_reserve_exact(length)
                .map_err(|_| scope.allocation_failure().into_js_error())?;
            units.extend_from_slice(id.as_units());
            units.push(b'-' as u16);
            units.extend(output.encode_utf16());
            let options = barochart_js::json::JsObject::try_from_entries_scoped(
                [
                    (
                        JsString::try_from_str("id", scope)
                            .map_err(|failure| failure.into_js_error())?,
                        JsValue::String(JsString::from_utf16(units)),
                    ),
                    (
                        JsString::try_from_str("type", scope)
                            .map_err(|failure| failure.into_js_error())?,
                        JsValue::String(
                            JsString::try_from_str("line", scope)
                                .map_err(|failure| failure.into_js_error())?,
                        ),
                    ),
                    (
                        JsString::try_from_str("panel", scope)
                            .map_err(|failure| failure.into_js_error())?,
                        panel
                            .try_clone_scoped(scope)
                            .map_err(|failure| failure.into_js_error())?,
                    ),
                    (
                        JsString::try_from_str("indicator", scope)
                            .map_err(|failure| failure.into_js_error())?,
                        JsValue::String(
                            id.try_clone_scoped(scope)
                                .map_err(|failure| failure.into_js_error())?,
                        ),
                    ),
                    (
                        JsString::try_from_str("output", scope)
                            .map_err(|failure| failure.into_js_error())?,
                        JsValue::String(
                            JsString::try_from_str(output, scope)
                                .map_err(|failure| failure.into_js_error())?,
                        ),
                    ),
                ],
                scope,
            )
            .map_err(|failure| failure.into_js_error())?;
            chart.add_legacy_series_scoped(&JsValue::Object(options), scope)?;
        }
        let bytes = outputs
            .len()
            .checked_mul(std::mem::size_of::<JsValue>())
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        scope
            .try_grow(bytes)
            .map_err(|failure| failure.into_js_error())?;
        let mut result = Vec::new();
        result
            .try_reserve_exact(outputs.len())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        for output in outputs {
            result.push(JsValue::String(
                JsString::try_from_str(output, scope).map_err(|failure| failure.into_js_error())?,
            ));
        }
        Ok(JsValue::Array(result))
    }

    /// 현재 게시된 차트다.
    pub fn chart(&self) -> Option<&NativeChart> {
        self.chart.as_ref()
    }

    /// 현재 게시된 차트의 배타적 빌림이다.
    pub fn chart_mut(&mut self) -> Option<&mut NativeChart> {
        self.chart.as_mut()
    }

    /// 같은 store와 attached queue를 빌린다.
    pub fn ingestion_owner(&self) -> Option<&IngestionOwner> {
        self.chart.as_ref().map(NativeChart::ingestion_owner)
    }

    /// 같은 store와 attached queue의 배타적 빌림이다.
    pub fn ingestion_owner_mut(&mut self) -> Option<&mut IngestionOwner> {
        self.chart.as_mut().map(NativeChart::ingestion_owner_mut)
    }

    /// 아직 게시하지 않은 모델·지표·드로잉 후보를 검증한다.
    pub fn stage_chart(
        &self,
        data: ModelDataState,
        options: &JsValue,
    ) -> Result<NativeChart, JsError> {
        let memory = data.store().memory_context().clone();
        let mut scope = memory.scope();
        self.stage_chart_scoped(data, options, &mut scope)
    }

    /// caller scope에서 nativeInit options와 오류 payload를 유지하며 chart 후보를 만든다.
    pub fn stage_chart_scoped(
        &self,
        data: ModelDataState,
        options: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<NativeChart, JsError> {
        NativeChart::new_scoped(
            data,
            options,
            NumberDialect::PLATFORM,
            self.host.as_ref(),
            scope,
        )
    }

    /// 검증을 마친 후보만 게시하고 이전 queue를 닫는다.
    pub fn install_chart(&mut self, chart: NativeChart) -> Result<(), JsError> {
        let input = interaction::OwnedInteractionState::new_with_memory(
            chart.data().store().memory_context().clone(),
        )?;
        let size = self.stage_native_size(&JsValue::Number(1200.0), &JsValue::Number(700.0))?;
        self.publish_chart_with_input(chart, input);
        self.size = Some(size);
        Ok(())
    }

    fn publish_chart_with_input(
        &mut self,
        chart: NativeChart,
        input: interaction::OwnedInteractionState,
    ) {
        if let Some(old) = self.chart.as_mut() {
            old.ingestion_owner_mut().dispose();
        }
        self.chart = Some(chart);
        self.input = Some(input);
        self.explorer = None;
        self.latest_layout = None;
    }

    /// 현재 controller다. 차트 게시 전에는 없다.
    pub fn input(&self) -> Option<&interaction::OwnedInteractionState> {
        self.input.as_ref()
    }

    /// 같은 호출에서 실제 chart/context/controller를 함께 빌린다.
    pub fn with_interaction<R>(
        &mut self,
        operation: impl FnOnce(
            &mut interaction::OwnedInteractionState,
            &mut interaction::InteractionContext<'_>,
        ) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| script_reference("nativeInput"))?;
        let chart = self
            .chart
            .as_mut()
            .ok_or_else(|| script_reference("nativeModel"))?;
        let number = |value: Option<&JsValue>| match value {
            Some(JsValue::Number(value)) => *value,
            _ => f64::NAN,
        };
        let width = number(self.size.as_ref().map(NativeSizeState::width));
        let height = number(self.size.as_ref().map(NativeSizeState::height));
        let mut context = interaction::InteractionContext {
            model: &mut chart.model,
            store: chart.ingestion.data().store(),
            indicators: &mut chart.indicators,
            drawings: &mut chart.drawings,
            series_caches: &mut chart.series_caches,
            geometry_cache: &mut chart.drawing_cache,
            host: self.host.as_ref(),
            width,
            height,
        };
        operation(input, &mut context)
    }

    /// Scene JSON과 packet이 하나의 실제 layout과 controller 해석을 공유한다.
    pub fn build_scene(
        &mut self,
        width: &JsValue,
        height: &JsValue,
    ) -> Result<scene::OwnedScene, JsError> {
        self.set_native_size(width, height)?;
        let chart = self
            .chart
            .as_mut()
            .ok_or_else(|| script_reference("nativeModel"))?;
        let number = |v: &JsValue| match v {
            JsValue::Number(n) => *n,
            _ => f64::NAN,
        };
        let w = number(width);
        let h = number(height);
        let (layout, mut scene) = chart.build_frame_base(self.host.as_ref(), w, h)?;
        scene.append_commands(chart.build_frame_drawings(&layout)?)?;
        let resolved = resolve_native_crosshair(
            chart,
            self.input.as_ref(),
            self.host.as_ref(),
            w,
            h,
            &layout,
        );
        scene.append_commands(chart.build_frame_hover(&layout, resolved.as_ref())?)?;
        self.latest_layout = Some(LatestLayout {
            layout: std::sync::Arc::new(layout),
            owner: chart.data().store().data_identity(),
        });
        Ok(scene)
    }

    /// 현재 layout에 대한 full crosshair snapshot이다. nativeSize를 바꾸지 않는다.
    pub fn crosshair_snapshot(
        &mut self,
        width: &JsValue,
        height: &JsValue,
    ) -> Result<JsValue, JsError> {
        let chart = self
            .chart
            .as_mut()
            .ok_or_else(|| script_reference("nativeAPI"))?;
        let number = |v: &JsValue| match v {
            JsValue::Number(v) => *v,
            _ => f64::NAN,
        };
        let w = number(width);
        let h = number(height);
        let layout = chart.create_layout(self.host.as_ref(), w, h)?;
        Ok(resolve_native_crosshair_snapshot(
            chart,
            self.input.as_ref(),
            self.host.as_ref(),
            w,
            h,
            &layout,
        )
        .map_or(JsValue::Null, |v| v.to_js_value()))
    }

    /// 현재 owner·크기와 일치할 때 마지막 frame layout으로 semantic 값을 읽는다.
    pub fn crosshair_values(
        &mut self,
        width: &JsValue,
        height: &JsValue,
        use_latest: bool,
    ) -> Result<JsValue, JsError> {
        let cached = if use_latest && self.latest_layout().is_some() {
            self.latest_layout
                .as_ref()
                .map(|v| std::sync::Arc::clone(&v.layout))
        } else {
            None
        };
        let chart = self
            .chart
            .as_mut()
            .ok_or_else(|| script_reference("nativeAPI"))?;
        let number = |v: &JsValue| match v {
            JsValue::Number(v) => *v,
            _ => f64::NAN,
        };
        let w = number(width);
        let h = number(height);
        let layout = match cached {
            Some(layout) => layout,
            None => std::sync::Arc::new(chart.create_layout(self.host.as_ref(), w, h)?),
        };
        let resolution = resolve_native_crosshair_snapshot(
            chart,
            self.input.as_ref(),
            self.host.as_ref(),
            w,
            h,
            &layout,
        );
        readout::crosshair_values_at(chart, self.host.as_ref(), &layout, resolution.as_ref())
    }

    /// WeakMap에 해당하는 raw pointer 요청을 보존하고 hover 표시만 지운다.
    pub fn hover_exit(&mut self) -> Result<(), JsError> {
        self.input
            .as_mut()
            .ok_or_else(|| script_reference("nativeModel"))?
            .hide_crosshair()
    }

    /// 커서가 있을 때만 읽기 layout을 준비해 접근성 summary를 만든다.
    pub fn accessibility(&mut self, use_last: bool) -> Result<JsValue, JsError> {
        let size = self.size.clone();
        let undefined = JsValue::Undefined;
        let has_crosshair = self
            .input
            .as_ref()
            .is_some_and(|input| input.crosshair_value().is_some());
        let crosshair = if has_crosshair {
            let width = size
                .as_ref()
                .map(NativeSizeState::width)
                .unwrap_or(&undefined);
            let height = size
                .as_ref()
                .map(NativeSizeState::height)
                .unwrap_or(&undefined);
            self.crosshair_values(width, height, use_last)?
        } else {
            JsValue::Null
        };
        readout::accessibility(
            self.chart
                .as_ref()
                .ok_or_else(|| script_reference("nativeModel"))?,
            self.input
                .as_ref()
                .ok_or_else(|| script_reference("nativeInput"))?,
            crosshair,
        )
    }

    /// Renderer token마다 base/drawing/hover layer를 재사용한다.
    pub fn render_frame<'a>(
        &'a mut self,
        token: &JsValue,
        width: &JsValue,
        height: &JsValue,
        force: bool,
    ) -> Result<frame_cache::NativeFrame<'a>, JsError> {
        let token = match token {
            JsValue::String(token) if (1..=128).contains(&token.len_utf16()) => token.clone(),
            _ => {
                return Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Native frame token"),
                ));
            }
        };
        let size = self.stage_native_size(width, height)?;
        if !self.frame_caches.contains_key(&token) {
            if self.frame_caches.len() >= 64 {
                return Err(JsError::new(
                    "RangeError",
                    JsString::from_str("Native frame cache count"),
                ));
            }
            self.frame_caches.insert(
                token.clone(),
                frame_cache::NativeFrameCache::new_with_memory(self.memory.clone()),
            );
        }
        self.size = Some(size);
        let chart = self
            .chart
            .as_mut()
            .ok_or_else(|| script_reference("nativeModel"))?;
        let number = |v: &JsValue| match v {
            JsValue::Number(n) => *n,
            _ => f64::NAN,
        };
        let w = number(width);
        let h = number(height);
        let input = self.input.as_ref();
        let host = self.host.as_ref();
        let mut resolver = |chart: &mut NativeChart, layout: &layout::Layout| {
            Ok(resolve_native_crosshair(chart, input, host, w, h, layout))
        };
        let frame = self
            .frame_caches
            .get_mut(&token)
            .expect("inserted cache")
            .frame(frame_cache::NativeFrameInput {
                chart,
                host,
                width: w,
                height: h,
                force_base: force,
                resolve_crosshair: &mut resolver,
            })?;
        self.latest_layout = Some(LatestLayout {
            layout: frame.retain_layout(),
            owner: chart.data().store().data_identity(),
        });
        Ok(frame)
    }

    /// 같은 model과 현재 크기에 대응하는 마지막 실제 layout을 빌린다.
    pub fn latest_layout(&self) -> Option<&layout::Layout> {
        let latest = self.latest_layout.as_ref()?;
        let chart = self.chart.as_ref()?;
        let size = self.size.as_ref()?;
        if !latest
            .owner
            .same_store(&chart.data().store().data_identity())
        {
            return None;
        }
        if !matches!(size.width(),JsValue::Number(value) if *value==latest.layout.width)
            || !matches!(size.height(),JsValue::Number(value) if *value==latest.layout.height)
        {
            return None;
        }
        Some(latest.layout.as_ref())
    }

    /// 해당 token이 없어도 원본처럼 latest layout을 지운다.
    pub fn release_frame_cache(&mut self, token: &JsValue) {
        if let JsValue::String(token) = token {
            self.frame_caches.remove(token);
        }
        self.latest_layout = None;
    }

    /// 모든 renderer cache와 latest layout을 지운다.
    pub fn release_frame_caches(&mut self) {
        self.frame_caches.clear();
        self.latest_layout = None;
    }

    /// 같은 VM의 native job slot과 registration을 실행한다.
    pub fn native_runtime_call(
        &mut self,
        name: &JsString,
        args: &[JsValue],
    ) -> Result<JsValue, JsError> {
        let mut scope = self.memory.scope();
        self.native_runtime_call_scoped(name, args, &mut scope)
    }

    /// Runtime가 만든 반환 payload의 lease를 호출자의 serialization 수명으로 이동한다.
    pub fn native_runtime_call_scoped(
        &mut self,
        name: &JsString,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let context = native_runtime::RuntimeContext {
            chart: self.chart.as_mut(),
            input: self.input.as_ref(),
            size: self.size.as_ref(),
            host: self.host.as_ref(),
            next_store_serial: &mut self.next_store_serial,
        };
        let result = self.runtime.call_scoped(name, args, context, scope)?;
        if let Some(memory) = result.output_memory {
            scope
                .absorb_persistent(memory)
                .map_err(|error| error.into_js_error())?;
        }
        if let Some(mut publication) = result.publication {
            let size = self.stage_native_size(&publication.width, &publication.height)?;
            publication
                .chart
                .absorb_retained_memory(publication.memory)?;
            let input = publication
                .input
                .take()
                .expect("runtime publication finalizes controller state");
            self.publish_chart_with_input(publication.chart, input);
            self.size = Some(size);
        }
        Ok(result.value)
    }

    /// Poison 뒤에도 읽을 params 종단 ledger를 Core 밖으로 전달한다.
    pub fn params_status_ledger(&self) -> native_runtime::NativeParamsStatusLedger {
        self.runtime.params_ledger()
    }

    /// Source F64 slot을 같은 호출 동안만 빌린다.
    pub fn native_async_buffer<'a>(&'a mut self, args: &[JsValue]) -> Result<&'a [f64], JsError> {
        static UNDEFINED: JsValue = JsValue::Undefined;
        let arg = |i| args.get(i).unwrap_or(&UNDEFINED);
        let context = native_runtime::RuntimeContext {
            chart: self.chart.as_mut(),
            input: self.input.as_ref(),
            size: self.size.as_ref(),
            host: self.host.as_ref(),
            next_store_serial: &mut self.next_store_serial,
        };
        self.runtime
            .read_f64(context, arg(0), arg(1), arg(2), arg(3))
    }

    /// Target handout cursor를 한 번 진행하고 쓰기 slice를 빌린다.
    pub fn native_target_buffer<'a>(
        &'a mut self,
        args: &[JsValue],
    ) -> Result<&'a mut [f64], JsError> {
        static UNDEFINED: JsValue = JsValue::Undefined;
        let arg = |i| args.get(i).unwrap_or(&UNDEFINED);
        let context = native_runtime::RuntimeContext {
            chart: self.chart.as_mut(),
            input: self.input.as_ref(),
            size: self.size.as_ref(),
            host: self.host.as_ref(),
            next_store_serial: &mut self.next_store_serial,
        };
        self.runtime.target_f64(context, arg(0), arg(1), arg(2))
    }

    /// Native semantic exploration은 cursor나 viewport를 바꾸지 않는다.
    pub fn data_exploration(
        &mut self,
        action: &JsValue,
        argument: &JsValue,
    ) -> Result<JsValue, JsError> {
        let action = match action {
            JsValue::String(value)
                if ["setActive", "navigate", "refresh", "read"]
                    .iter()
                    .any(|s| value.as_units().iter().copied().eq(s.encode_utf16())) =>
            {
                value.to_string_lossy()
            }
            _ => {
                return Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Exploration action"),
                ));
            }
        };
        if action == "setActive" && !matches!(argument, JsValue::Bool(_)) {
            return Err(JsError::new(
                "TypeError",
                JsString::from_str("Exploration active boolean"),
            ));
        }
        if action == "navigate"
            && !matches!(argument,JsValue::String(value)if["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].iter().any(|s|value.as_units().iter().copied().eq(s.encode_utf16())))
        {
            return Err(JsError::new(
                "TypeError",
                JsString::from_str("Exploration navigation key"),
            ));
        }
        if matches!(action.as_str(), "refresh" | "read")
            && !matches!(argument, JsValue::Undefined | JsValue::Null)
        {
            return Err(JsError::new(
                "TypeError",
                JsString::from_str("Exploration action takes no argument"),
            ));
        }
        let chart = self.chart.as_mut().ok_or_else(|| {
            JsError::new(
                "TypeError",
                JsString::from_str("Exploration owner data property required"),
            )
        })?;
        if action == "setActive"
            && matches!(argument, JsValue::Bool(true))
            && self
                .input
                .as_ref()
                .is_some_and(|i| i.gesture_kind().is_some())
        {
            return Err(JsError::new(
                "Error",
                JsString::from_str("Exploration requires an idle gesture"),
            ));
        }
        self.explorer
            .get_or_insert_with(keyboard_explorer::NativeKeyboardExplorer::default)
            .call(chart, self.host.as_ref(), &action, argument)
    }

    fn workspace_context(&self) -> Result<workspace::WorkspaceContext<'_>, JsError> {
        let chart = self.chart.as_ref().ok_or_else(|| {
            JsError::new(
                "TypeError",
                JsString::from_str("Workspace native owner mismatch"),
            )
        })?;
        let field = |name: &str| -> Option<&JsString> {
            let JsValue::Object(record) = chart.symbol_record.as_ref()? else {
                return None;
            };
            match record.get(&JsString::from_str(name)) {
                Some(JsValue::String(value)) => Some(value),
                _ => None,
            }
        };
        Ok(workspace::WorkspaceContext {
            host: self.host.as_ref(),
            model: &chart.model,
            store: chart.ingestion.data().store(),
            indicators: &chart.indicators,
            drawings: &chart.drawings,
            symbol: chart
                .symbol
                .as_ref()
                .map(|symbol| workspace::WorkspaceSymbol {
                    symbol,
                    provider: field("provider"),
                    adjustment_version: field("adjustmentVersion"),
                }),
            symbol_formatters: chart.symbol.is_some(),
            interaction: workspace::WorkspaceInteraction {
                gesture_active: self
                    .input
                    .as_ref()
                    .is_some_and(|v| v.gesture_kind().is_some()),
                pointer_count: self.input.as_ref().map_or(0, |v| v.pointer_count()),
            },
            dialect: chart.dialect,
        })
    }

    /// 실제 native model의 canonical workspace를 저장한다.
    pub fn save_workspace(&self, binding: &JsValue) -> Result<JsString, JsError> {
        let mut scope = self.memory.scope();
        self.save_workspace_scoped(binding, &mut scope)
    }

    /// 저장 문서의 반환 lease를 호출자의 output 수명까지 유지한다.
    pub fn save_workspace_scoped(
        &self,
        binding: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsString, JsError> {
        let (text, memory) = workspace::save_workspace_with_memory(
            &self.workspace_context()?,
            binding,
            None,
            &self.memory,
        )?;
        scope
            .absorb_persistent(memory)
            .map_err(|error| error.into_js_error())?;
        Ok(text)
    }
    /// 실제 factory/definition으로 workspace를 게시 전에 검증한다.
    pub fn preflight_workspace(
        &self,
        text: &JsValue,
        binding: &JsValue,
    ) -> Result<JsValue, JsError> {
        let mut scope = self.memory.scope();
        self.preflight_workspace_scoped(text, binding, &mut scope)
    }

    /// 사전 점검 반환 tree의 lease를 직렬화 완료까지 유지한다.
    pub fn preflight_workspace_scoped(
        &self,
        text: &JsValue,
        binding: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let (value, memory) = workspace::preflight_workspace_with_memory(
            &self.workspace_context()?,
            text,
            binding,
            None,
            &self.memory,
        )?;
        scope
            .absorb_persistent(memory)
            .map_err(|error| error.into_js_error())?;
        Ok(value)
    }

    /// 기존 backend-neutral 벤치마크가 쓰는 실제 correction event다.
    pub fn benchmark_event(&self, index: &JsValue) -> Result<JsValue, JsError> {
        let chart = self
            .chart
            .as_ref()
            .ok_or_else(|| script_reference("nativeModel"))?;
        let index = match index {
            JsValue::Number(index)
                if index.is_finite()
                    && index.fract() == 0.0
                    && *index >= 0.0
                    && *index < (chart.data().store().length() as f64) =>
            {
                *index as usize
            }
            _ => return Err(JsError::new("RangeError", JsString::from_str("Bar index"))),
        };
        let mut bar = chart.data().store().at(index)?;
        bar.close = 1000.0;
        bar.high = barochart_js::num::js_max(&[bar.high, 1000.0]);
        bar.low = barochart_js::num::js_min(&[bar.low, 1000.0]);
        let mut record = barochart_js::json::JsObject::new();
        for (name, value) in [
            ("time", bar.time),
            ("open", bar.open),
            ("high", bar.high),
            ("low", bar.low),
            ("close", bar.close),
            ("volume", bar.volume),
        ] {
            record.insert(JsString::from_str(name), JsValue::Number(value));
        }
        let mut result = barochart_js::json::JsObject::new();
        result.insert(
            JsString::from_str("kind"),
            JsValue::String(JsString::from_str("correction")),
        );
        result.insert(JsString::from_str("bar"), JsValue::Object(record));
        Ok(JsValue::Object(result))
    }

    /// Scene 생성 전에 raw outputs를 source 순서로 해시한다.
    pub fn benchmark_digest(&mut self) -> Result<JsString, JsError> {
        let chart = self
            .chart
            .as_ref()
            .ok_or_else(|| script_reference("nativeModel"))?;
        let length = chart.data().store().length();
        let mut a = 2_166_136_261u32;
        let mut b = 2_246_822_519u32;
        let mut outputs = 0;
        for id in chart.indicators.entry_ids() {
            let value = JsValue::String(id);
            let entry = chart.indicators.entry(&value).expect("entry id");
            for output in entry.definition().outputs {
                let values = entry.output_capacity(output).expect("output");
                for number in values.iter().take(length) {
                    let bits = number.to_bits();
                    for word in [bits as u32, (bits >> 32) as u32] {
                        a = (a ^ word).wrapping_mul(16_777_619);
                        b = (b ^ word)
                            .wrapping_mul(3_266_489_917)
                            .wrapping_add(374_761_393);
                    }
                }
                outputs += 1;
            }
        }
        let scene = self.build_scene(&JsValue::Number(1200.0), &JsValue::Number(700.0))?;
        let JsValue::Object(scene) = scene.value() else {
            unreachable!("scene")
        };
        let chart = self.chart.as_ref().expect("livechart");
        let bar = chart.data().store().at(length
            .checked_sub(1)
            .ok_or_else(|| JsError::new("RangeError", JsString::from_str("Bar index")))?)?;
        let mut last = barochart_js::json::JsObject::new();
        for (name, value) in [
            ("time", bar.time),
            ("open", bar.open),
            ("high", bar.high),
            ("low", bar.low),
            ("close", bar.close),
            ("volume", bar.volume),
        ] {
            last.insert(JsString::from_str(name), JsValue::Number(value));
        }
        let mut result = barochart_js::json::JsObject::new();
        for (name, value) in [
            (
                "hashes",
                JsValue::Array(vec![JsValue::Number(a as f64), JsValue::Number(b as f64)]),
            ),
            ("outputs", JsValue::Number(outputs as f64)),
            ("length", JsValue::Number(length as f64)),
            (
                "layout",
                scene
                    .get(&JsString::from_str("layout"))
                    .expect("layout")
                    .clone(),
            ),
            ("last", JsValue::Object(last)),
        ] {
            result.insert(JsString::from_str(name), value);
        }
        Ok(JsString::from_str(
            std::str::from_utf8(&barochart_js::json::stringify_json(
                &JsValue::Object(result),
                barochart_js::json::JsonMode::Standard,
            ))
            .expect("JSON UTF-8"),
        ))
    }

    /// 호스트에게 시간대 표준 이름 해석을 요청한다.
    pub fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        self.host.zone_resolve(name)
    }

    /// 호스트에게 시간대 오프셋을 요청한다.
    pub fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError> {
        self.host.zone_offset_seconds(zone, epoch_ms)
    }

    /// 호스트 진단 로그를 남긴다.
    pub fn log(&self, level: i32, message: &str) {
        self.host.log(level, message);
    }
}

fn resolve_native_crosshair(
    chart: &mut NativeChart,
    input: Option<&interaction::OwnedInteractionState>,
    host: &dyn Host,
    width: f64,
    height: f64,
    layout: &layout::Layout,
) -> Option<scene::ResolvedCrosshair> {
    let input = input?;
    let context = interaction::InteractionContext {
        model: &mut chart.model,
        store: chart.ingestion.data().store(),
        indicators: &mut chart.indicators,
        drawings: &mut chart.drawings,
        series_caches: &mut chart.series_caches,
        geometry_cache: &mut chart.drawing_cache,
        host,
        width,
        height,
    };
    input.resolve_crosshair(&context, layout)
}

fn resolve_native_crosshair_snapshot(
    chart: &mut NativeChart,
    input: Option<&interaction::OwnedInteractionState>,
    host: &dyn Host,
    width: f64,
    height: f64,
    layout: &layout::Layout,
) -> Option<crosshair_snap::CrosshairResolution> {
    let input = input?;
    let context = interaction::InteractionContext {
        model: &mut chart.model,
        store: chart.ingestion.data().store(),
        indicators: &mut chart.indicators,
        drawings: &mut chart.drawings,
        series_caches: &mut chart.series_caches,
        geometry_cache: &mut chart.drawing_cache,
        host,
        width,
        height,
    };
    input.resolve_crosshair_snapshot(&context, layout)
}
