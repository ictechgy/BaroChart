//! 35 builtin과 정적 pressure를 typed 상태로 묶는 단일 계산 dispatch다.

use barochart_js::error::JsError;
use barochart_js::json::JsValue;

use crate::Host;
use crate::data::Bar;
use crate::indicator_types::{CreatedIndicator, IndicatorOutputRow, IndicatorProgram};
use crate::indicators_average::{self, AverageState};
use crate::indicators_momentum::{self, MomentumState};
use crate::indicators_volume::{self, VolumeState};
use crate::session_studies::{self, SessionState};
use crate::trusted_studies::{self, PressureState};

/// Factory에서 한 번 할당하고 hot step에서는 새 컨테이너를 만들지 않는 계산 상태다.
pub enum IndicatorState {
    /// 평균 계열 11개다.
    Average(Box<AverageState>),
    /// 모멘텀·범위 계열 14개다.
    Momentum(Box<MomentumState>),
    /// 거래량 계열 8개다.
    Volume(Box<VolumeState>),
    /// 세션 VWAP와 Pivots다.
    Session(Box<SessionState>),
    /// 정적 linked pressure다.
    Pressure(Box<PressureState>),
}

fn wrap<S>(
    created: CreatedIndicator<S>,
    state: impl FnOnce(S) -> IndicatorState,
) -> CreatedIndicator<IndicatorState> {
    CreatedIndicator {
        definition: created.definition,
        state: state(created.state),
    }
}

/// Registry가 해석한 program의 실제 factory를 실행한다. 세션 검증은 여기서 Host를 받는다.
pub fn create(
    program: IndicatorProgram,
    params: &JsValue,
    host: &dyn Host,
) -> Result<CreatedIndicator<IndicatorState>, JsError> {
    use IndicatorProgram::*;
    Ok(match program {
        Sma | Vwma | Ema | Wma | Macd | Bollinger | Dema | Tema | Hma | Trix | Ppo => {
            wrap(indicators_average::create(program, params)?, |state| {
                IndicatorState::Average(Box::new(state))
            })
        }
        Rsi | Atr | Donchian | Aroon | Stochastic | Roc | WilliamsR | Cci | Adx | Keltner
        | Supertrend | Ichimoku | StochRsi | ParabolicSar => {
            wrap(indicators_momentum::create(program, params)?, |state| {
                IndicatorState::Momentum(Box::new(state))
            })
        }
        Obv | Mfi | Cmf | Adl | Chaikin | ForceIndex | VolumeOscillator | Vortex => {
            wrap(indicators_volume::create(program, params)?, |state| {
                IndicatorState::Volume(Box::new(state))
            })
        }
        Vwap | Pivots => wrap(session_studies::create(program, params, host)?, |state| {
            IndicatorState::Session(Box::new(state))
        }),
        Pressure => wrap(trusted_studies::create_pressure(params)?, |state| {
            IndicatorState::Pressure(Box::new(state))
        }),
    })
}

impl IndicatorState {
    /// 출력의 타입·유한성 게이트는 엔진이 순서대로 검사한다.
    pub fn step(
        &mut self,
        host: &dyn Host,
        bar: &Bar,
        index: usize,
    ) -> Result<IndicatorOutputRow, JsError> {
        match self {
            Self::Average(state) => state.step(bar, index),
            Self::Momentum(state) => state.step(bar, index),
            Self::Volume(state) => state.step(bar, index),
            Self::Session(state) => state.step(host, bar, index),
            Self::Pressure(state) => state.step(bar, index),
        }
    }

    /// 현재 상태를 각 factory의 snapshot 계약대로 복사한다.
    pub fn snapshot(&self) -> JsValue {
        match self {
            Self::Average(state) => state.snapshot(),
            Self::Momentum(state) => state.snapshot(),
            Self::Volume(state) => state.snapshot(),
            Self::Session(state) => state.snapshot(),
            Self::Pressure(state) => state.snapshot(),
        }
    }

    /// 의미 검증이 끝난 checkpoint를 factory 설정을 유지하며 복원한다.
    pub fn restore(&mut self, wire: &JsValue) -> Result<(), JsError> {
        match self {
            Self::Average(state) => state.restore(wire),
            Self::Momentum(state) => state.restore(wire),
            Self::Volume(state) => state.restore(wire),
            Self::Session(state) => state.restore(wire),
            Self::Pressure(state) => state.restore(wire),
        }
    }
}
