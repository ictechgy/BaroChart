//! Rust 코어 뼈대(M1b Task 5). 실제 모델·저장소는 M2 이후에 이식한다.
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

use barochart_js::error::JsError;
use barochart_js::string::JsString;
use data::{ModelDataState, StoreOptions};

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

/// 내부 빈 엔진 뼈대다. 차트 상태는 후속 이식 단계에서 추가한다.
/// `Send`이지만 호스트가 `Sync`일 필요는 없으므로 의도적으로 `Sync`가 아니다.
pub struct Engine {
    host: Box<dyn Host>,
    data: Option<ModelDataState>,
    next_store_serial: f64,
}

impl Engine {
    /// 엔진 수명 동안 호스트 서비스의 소유권을 받는다.
    pub fn new(host: Box<dyn Host>) -> Self {
        Self {
            host,
            data: None,
            next_store_serial: 1.0,
        }
    }

    /// 현재 네이티브 모델이 소유한 데이터 상태다. 초기화 전에는 없다.
    pub fn data_state(&self) -> Option<&ModelDataState> {
        self.data.as_ref()
    }

    /// 현재 네이티브 모델 데이터의 배타적 빌림이다.
    pub fn data_state_mut(&mut self) -> Option<&mut ModelDataState> {
        self.data.as_mut()
    }

    /// nativeInit의 빈 BarStore를 만든다. 뒤의 count/options 실패에도 serial은 소비된다.
    pub fn stage_empty_data(&mut self) -> Result<ModelDataState, JsError> {
        let data = ModelDataState::with_serial(
            self.next_store_serial,
            StoreOptions::default(),
            Vec::new(),
        )?;
        self.next_store_serial += 1.0;
        Ok(data)
    }

    /// 검증을 마친 후보 데이터만 게시한다. 이전 상태는 이 시점까지 유지된다.
    pub fn install_data_state(&mut self, data: ModelDataState) {
        self.data = Some(data);
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
