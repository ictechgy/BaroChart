//! canonical 지표 이름·파라미터 선언 순서·출력 순서를 고정한 정적 registry다.

#![forbid(unsafe_code)]

use barochart_js::string::JsString;

use crate::indicator_types::{IndicatorModuleDescriptor, IndicatorProgram, IndicatorProvenance};

/// 정적 registry 한 행의 cold metadata다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndicatorMetadata {
    /// 실행 program이다.
    pub program: IndicatorProgram,
    /// canonical 이름이다.
    pub name: &'static str,
    /// 팩토리가 선언한 raw parameter 순서다.
    pub parameter_order: &'static [&'static str],
    /// 기본 팩토리 출력 이름 순서다. Advanced VWAP처럼 params에 따라 달라지는 최종 shape는
    /// leaf가 반환하는 `IndicatorDefinition.outputs`가 정본이다.
    pub outputs: &'static [&'static str],
    /// builtin/linked 출처다.
    pub provenance: IndicatorProvenance,
}

/// 정적 linked pressure descriptor다.
pub static PRESSURE_DESCRIPTOR: IndicatorModuleDescriptor = IndicatorModuleDescriptor {
    id: "aster.volume-direction",
    version: 1,
    state_version: 1,
    export_name: "pressure",
    causal: true,
};

const BUILTIN_COUNT: usize = 35;
const PRESSURE_NAMES: [&str; 1] = ["aster.volume-direction@1/pressure"];

static METADATA: [IndicatorMetadata; 36] = [
    metadata(IndicatorProgram::Sma, &["period", "source"], &["value"]),
    metadata(IndicatorProgram::Vwma, &["period"], &["value"]),
    metadata(IndicatorProgram::Ema, &["period", "source"], &["value"]),
    metadata(IndicatorProgram::Wma, &["period"], &["value"]),
    metadata(IndicatorProgram::Rsi, &["period"], &["value"]),
    metadata(IndicatorProgram::Atr, &["period"], &["value"]),
    metadata(
        IndicatorProgram::Macd,
        &["fast", "slow", "signal"],
        &["macd", "signal", "histogram"],
    ),
    metadata(
        IndicatorProgram::Bollinger,
        &["period", "deviation"],
        &["middle", "upper", "lower"],
    ),
    metadata(
        IndicatorProgram::Donchian,
        &["period"],
        &["middle", "upper", "lower"],
    ),
    metadata(
        IndicatorProgram::Aroon,
        &["period"],
        &["up", "down", "oscillator"],
    ),
    metadata(
        IndicatorProgram::Stochastic,
        &["period", "smoothK", "smoothD"],
        &["k", "d"],
    ),
    metadata(IndicatorProgram::Roc, &["period"], &["value"]),
    metadata(IndicatorProgram::WilliamsR, &["period"], &["value"]),
    metadata(IndicatorProgram::Cci, &["period"], &["value"]),
    metadata(IndicatorProgram::Obv, &[], &["value"]),
    metadata(
        IndicatorProgram::Vwap,
        &[
            "calendar",
            "anchorTime",
            "sessionMs",
            "kinds",
            "source",
            "deviation",
        ],
        &["value"],
    ),
    metadata(IndicatorProgram::Mfi, &["period"], &["value"]),
    metadata(IndicatorProgram::Cmf, &["period"], &["value"]),
    metadata(
        IndicatorProgram::Adx,
        &["period"],
        &["adx", "plusDI", "minusDI"],
    ),
    metadata(IndicatorProgram::Dema, &["period"], &["value"]),
    metadata(IndicatorProgram::Tema, &["period"], &["value"]),
    metadata(IndicatorProgram::Hma, &["period"], &["value"]),
    metadata(
        IndicatorProgram::Keltner,
        &["period", "atrPeriod", "multiplier"],
        &["middle", "upper", "lower"],
    ),
    metadata(
        IndicatorProgram::Supertrend,
        &["period", "multiplier"],
        &["value", "direction"],
    ),
    metadata(
        IndicatorProgram::Ichimoku,
        &["conversion", "base", "span", "displacement"],
        &["tenkan", "kijun", "spanA", "spanB", "chikou"],
    ),
    metadata(IndicatorProgram::Trix, &["period"], &["value"]),
    metadata(
        IndicatorProgram::Ppo,
        &["fast", "slow", "signal"],
        &["ppo", "signal", "histogram"],
    ),
    metadata(
        IndicatorProgram::StochRsi,
        &["period", "stochPeriod", "smoothK", "smoothD"],
        &["k", "d"],
    ),
    metadata(IndicatorProgram::Adl, &[], &["value"]),
    metadata(IndicatorProgram::Chaikin, &["fast", "slow"], &["value"]),
    metadata(IndicatorProgram::ForceIndex, &["period"], &["value"]),
    metadata(
        IndicatorProgram::VolumeOscillator,
        &["fast", "slow"],
        &["value"],
    ),
    metadata(IndicatorProgram::Vortex, &["period"], &["plus", "minus"]),
    metadata(
        IndicatorProgram::Pivots,
        &["calendar", "anchorTime", "sessionMs", "kinds"],
        &["pivot", "r1", "s1", "r2", "s2"],
    ),
    metadata(
        IndicatorProgram::ParabolicSar,
        &["step", "max"],
        &["value", "direction"],
    ),
    IndicatorMetadata {
        program: IndicatorProgram::Pressure,
        name: "aster.volume-direction@1/pressure",
        parameter_order: &["factor", "shift"],
        outputs: &["signed", "cumulative"],
        provenance: IndicatorProvenance::Linked(&PRESSURE_DESCRIPTOR),
    },
];

/// 한 엔진의 고정 registry 상태다. 임의 callback/factory를 저장하지 않는다.
#[derive(Clone, Debug, Default)]
pub struct IndicatorRegistry {
    pressure_registered: bool,
}

impl IndicatorRegistry {
    /// 35개 builtin만 등록된 registry를 만든다.
    pub const fn new() -> Self {
        Self {
            pressure_registered: false,
        }
    }

    /// 현재 등록 행 수다.
    pub const fn len(&self) -> usize {
        BUILTIN_COUNT + self.pressure_registered as usize
    }

    /// registry가 비었는지 본다. 고정 builtin 때문에 항상 거짓이다.
    pub const fn is_empty(&self) -> bool {
        false
    }

    /// source 순서로 등록 행을 순회한다. Pressure는 module 등록 뒤 마지막에 나타난다.
    pub fn entries(&self) -> impl DoubleEndedIterator<Item = &'static IndicatorMetadata> {
        METADATA[..BUILTIN_COUNT]
            .iter()
            .chain(self.pressure_registered.then_some(&METADATA[BUILTIN_COUNT]))
    }

    /// WTF-16 이름으로 등록된 행을 찾는다.
    pub fn lookup(&self, name: &JsString) -> Option<&'static IndicatorMetadata> {
        self.entries().find(|entry| text_eq(name, entry.name))
    }

    /// program이 현재 registry에 등록됐는지 본다.
    pub const fn is_registered(&self, program: IndicatorProgram) -> bool {
        program.is_builtin() || self.pressure_registered
    }

    /// 유일한 정적 module `aster.volume-direction@1`을 idempotent하게 등록한다.
    pub fn register_volume_direction_v1(&mut self) -> &'static [&'static str] {
        self.pressure_registered = true;
        &PRESSURE_NAMES
    }
}

/// program의 고정 metadata를 돌려준다. Pressure 등록 여부와 무관한 정적 조회다.
pub fn metadata_for_program(program: IndicatorProgram) -> &'static IndicatorMetadata {
    &METADATA[program as usize]
}

const fn metadata(
    program: IndicatorProgram,
    parameter_order: &'static [&'static str],
    outputs: &'static [&'static str],
) -> IndicatorMetadata {
    IndicatorMetadata {
        program,
        name: program.name(),
        parameter_order,
        outputs,
        provenance: IndicatorProvenance::Builtin,
    }
}

fn text_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}
