//! 지표 계산 leaf들이 공유하는 고정 program, definition과 hot-loop 출력 타입이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::string::JsString;

use crate::data::Bar;
use crate::indicator_params::{IndicatorParamValue, OrderedIndicatorParams};

/// 35개 builtin과 정적 linked pressure를 구분하는 고정 program이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum IndicatorProgram {
    /// 단순 이동평균이다.
    Sma,
    /// 거래량 가중 이동평균이다.
    Vwma,
    /// 지수 이동평균이다.
    Ema,
    /// 선형 가중 이동평균이다.
    Wma,
    /// 상대강도지수다.
    Rsi,
    /// 평균 진폭 범위다.
    Atr,
    /// 이동평균 수렴·확산이다.
    Macd,
    /// 볼린저 밴드다.
    Bollinger,
    /// 돈치안 채널이다.
    Donchian,
    /// 아룬이다.
    Aroon,
    /// 스토캐스틱 오실레이터다.
    Stochastic,
    /// 변화율이다.
    Roc,
    /// 윌리엄스 %R이다.
    WilliamsR,
    /// 상품채널지수다.
    Cci,
    /// 누적거래량이다.
    Obv,
    /// 거래량 가중 평균가격이다.
    Vwap,
    /// 자금흐름지수다.
    Mfi,
    /// 차이킨 자금흐름이다.
    Cmf,
    /// 평균방향지수다.
    Adx,
    /// 이중 지수 이동평균이다.
    Dema,
    /// 삼중 지수 이동평균이다.
    Tema,
    /// 헐 이동평균이다.
    Hma,
    /// 켈트너 채널이다.
    Keltner,
    /// 슈퍼트렌드다.
    Supertrend,
    /// 일목균형표다.
    Ichimoku,
    /// TRIX다.
    Trix,
    /// 백분율 가격 오실레이터다.
    Ppo,
    /// 스토캐스틱 RSI다.
    StochRsi,
    /// 매집·분산선이다.
    Adl,
    /// 차이킨 오실레이터다.
    Chaikin,
    /// 포스 인덱스다.
    ForceIndex,
    /// 거래량 오실레이터다.
    VolumeOscillator,
    /// 보텍스다.
    Vortex,
    /// 세션 피벗이다.
    Pivots,
    /// 파라볼릭 SAR이다.
    ParabolicSar,
    /// 정적 linked `aster.volume-direction@1/pressure`다.
    Pressure,
}

impl IndicatorProgram {
    /// source registry 순서의 35개 builtin 뒤에 pressure를 둔 전체 목록이다.
    pub const ALL: [Self; 36] = [
        Self::Sma,
        Self::Vwma,
        Self::Ema,
        Self::Wma,
        Self::Rsi,
        Self::Atr,
        Self::Macd,
        Self::Bollinger,
        Self::Donchian,
        Self::Aroon,
        Self::Stochastic,
        Self::Roc,
        Self::WilliamsR,
        Self::Cci,
        Self::Obv,
        Self::Vwap,
        Self::Mfi,
        Self::Cmf,
        Self::Adx,
        Self::Dema,
        Self::Tema,
        Self::Hma,
        Self::Keltner,
        Self::Supertrend,
        Self::Ichimoku,
        Self::Trix,
        Self::Ppo,
        Self::StochRsi,
        Self::Adl,
        Self::Chaikin,
        Self::ForceIndex,
        Self::VolumeOscillator,
        Self::Vortex,
        Self::Pivots,
        Self::ParabolicSar,
        Self::Pressure,
    ];

    /// canonical registry 이름을 돌려준다.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Sma => "sma",
            Self::Vwma => "vwma",
            Self::Ema => "ema",
            Self::Wma => "wma",
            Self::Rsi => "rsi",
            Self::Atr => "atr",
            Self::Macd => "macd",
            Self::Bollinger => "bollinger",
            Self::Donchian => "donchian",
            Self::Aroon => "aroon",
            Self::Stochastic => "stochastic",
            Self::Roc => "roc",
            Self::WilliamsR => "williamsR",
            Self::Cci => "cci",
            Self::Obv => "obv",
            Self::Vwap => "vwap",
            Self::Mfi => "mfi",
            Self::Cmf => "cmf",
            Self::Adx => "adx",
            Self::Dema => "dema",
            Self::Tema => "tema",
            Self::Hma => "hma",
            Self::Keltner => "keltner",
            Self::Supertrend => "supertrend",
            Self::Ichimoku => "ichimoku",
            Self::Trix => "trix",
            Self::Ppo => "ppo",
            Self::StochRsi => "stochRSI",
            Self::Adl => "adl",
            Self::Chaikin => "chaikin",
            Self::ForceIndex => "forceIndex",
            Self::VolumeOscillator => "volumeOscillator",
            Self::Vortex => "vortex",
            Self::Pivots => "pivots",
            Self::ParabolicSar => "parabolicSAR",
            Self::Pressure => "aster.volume-direction@1/pressure",
        }
    }

    /// canonical builtin이면 참이다. Linked pressure는 거짓이다.
    pub const fn is_builtin(self) -> bool {
        !matches!(self, Self::Pressure)
    }
}

/// 문서에 쓰는 정적 linked module descriptor다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndicatorModuleDescriptor {
    /// module id다.
    pub id: &'static str,
    /// module version이다.
    pub version: u32,
    /// checkpoint state version이다.
    pub state_version: u32,
    /// export 이름이다.
    pub export_name: &'static str,
    /// causal descriptor다.
    pub causal: bool,
}

/// 지표 정의의 출처다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndicatorProvenance {
    /// canonical builtin이다.
    Builtin,
    /// 정적 linked module이다.
    Linked(&'static IndicatorModuleDescriptor),
}

/// 한 출력의 raw plot offset이다. `f64`라 `-0`을 보존한다.
#[derive(Clone, Copy, Debug)]
pub struct PlotOffset {
    /// 출력 이름이다.
    pub output: &'static str,
    /// raw offset이다.
    pub value: f64,
}

/// 계산 leaf가 만드는 immutable 정의다.
#[derive(Clone, Debug)]
pub struct IndicatorDefinition {
    /// 실행할 고정 program이다.
    pub program: IndicatorProgram,
    /// 선언 순서로 정리했지만 unknown 키도 남긴 raw params다.
    pub params: OrderedIndicatorParams,
    /// 출력 이름 순서다.
    pub outputs: &'static [&'static str],
    /// 실제로 존재하는 raw plot offset 필드 순서다.
    pub plot_offsets: Vec<PlotOffset>,
    /// builtin/linked 출처다.
    pub provenance: IndicatorProvenance,
}

impl IndicatorDefinition {
    /// host-visible definition shape를 검사해 만든다.
    pub fn new(
        program: IndicatorProgram,
        params: OrderedIndicatorParams,
        outputs: &'static [&'static str],
        plot_offsets: Vec<PlotOffset>,
        provenance: IndicatorProvenance,
    ) -> Result<Self, JsError> {
        let invalid_outputs = outputs.is_empty()
            || outputs.len() > 5
            || outputs.iter().any(|output| {
                output.is_empty()
                    || output.len() > 128
                    || ["__proto__", "constructor", "prototype"].contains(output)
            })
            || outputs
                .iter()
                .enumerate()
                .any(|(index, output)| outputs[..index].contains(output));
        let invalid_offsets = plot_offsets.len() > outputs.len()
            || plot_offsets.iter().enumerate().any(|(index, offset)| {
                !outputs.contains(&offset.output)
                    || !offset.value.is_finite()
                    || offset.value.fract() != 0.0
                    || offset.value.abs() > 10_000.0
                    || plot_offsets[..index]
                        .iter()
                        .any(|previous| previous.output == offset.output)
            });
        let invalid_provenance =
            program.is_builtin() != matches!(provenance, IndicatorProvenance::Builtin);
        if invalid_outputs || invalid_offsets || invalid_provenance {
            return Err(type_error("Invalid indicator definition"));
        }
        Ok(Self {
            program,
            params,
            outputs,
            plot_offsets,
            provenance,
        })
    }

    /// 없는 offset을 JS host의 effective +0으로 보아 돌려준다.
    pub fn effective_plot_offset(&self, output: &str) -> f64 {
        self.plot_offsets
            .iter()
            .find(|offset| offset.output == output)
            .map_or(0.0, |offset| offset.value)
    }
}

/// 계산 leaf가 definition과 자기 typed state를 함께 돌려주는 공통 묶음이다.
#[derive(Clone, Debug)]
pub struct CreatedIndicator<S> {
    /// immutable 정의다.
    pub definition: IndicatorDefinition,
    /// leaf가 소유하는 typed state다.
    pub state: S,
}

/// 매 봉 계산이 반환하는 최대 5개 고정 출력이다.
#[derive(Clone, Copy, Debug)]
pub struct IndicatorOutputRow {
    values: [f64; 5],
    len: u8,
}

impl IndicatorOutputRow {
    /// 출력 한 개를 만든다.
    pub const fn one(a: f64) -> Self {
        Self::new([a, 0.0, 0.0, 0.0, 0.0], 1)
    }

    /// 출력 두 개를 만든다.
    pub const fn two(a: f64, b: f64) -> Self {
        Self::new([a, b, 0.0, 0.0, 0.0], 2)
    }

    /// 출력 세 개를 만든다.
    pub const fn three(a: f64, b: f64, c: f64) -> Self {
        Self::new([a, b, c, 0.0, 0.0], 3)
    }

    /// 출력 네 개를 만든다.
    pub const fn four(a: f64, b: f64, c: f64, d: f64) -> Self {
        Self::new([a, b, c, d, 0.0], 4)
    }

    /// 출력 다섯 개를 만든다.
    pub const fn five(a: f64, b: f64, c: f64, d: f64, e: f64) -> Self {
        Self::new([a, b, c, d, e], 5)
    }

    /// 출력 개수다.
    pub const fn len(self) -> usize {
        self.len as usize
    }

    /// 출력이 비었는지 본다. 정상 정의는 항상 거짓이다.
    pub const fn is_empty(self) -> bool {
        self.len == 0
    }

    /// 유효한 출력 slice만 빌린다.
    pub fn as_slice(&self) -> &[f64] {
        &self.values[..self.len as usize]
    }

    const fn new(values: [f64; 5], len: u8) -> Self {
        Self { values, len }
    }
}

/// SMA/EMA의 source param을 hot loop용으로 해석한 열이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarField {
    /// UTC 시각 열이다.
    Time,
    /// 시가 열이다.
    Open,
    /// 고가 열이다.
    High,
    /// 저가 열이다.
    Low,
    /// 종가 열이다.
    Close,
    /// 거래량 열이다.
    Volume,
    /// 숫자 source나 알 수 없는 문자열이다. JS `bar[source]`의 undefined처럼 NaN gap을 낸다.
    Unknown,
}

impl BarField {
    /// 문자열 source를 알려진 열로 바꾼다. 알 수 없는 문자열을 거부하지 않는다.
    pub fn from_name(value: &JsString) -> Self {
        for (name, field) in [
            ("time", Self::Time),
            ("open", Self::Open),
            ("high", Self::High),
            ("low", Self::Low),
            ("close", Self::Close),
            ("volume", Self::Volume),
        ] {
            if value.as_units().iter().copied().eq(name.encode_utf16()) {
                return field;
            }
        }
        Self::Unknown
    }

    /// generic params가 허용한 Number/String 종류를 보존해 source를 해석한다.
    pub fn from_param(value: &IndicatorParamValue) -> Self {
        match value {
            IndicatorParamValue::String(value) => Self::from_name(value),
            IndicatorParamValue::Number(_) => Self::Unknown,
        }
    }

    /// 봉에서 열 값을 읽는다. Unknown은 JS undefined의 비유한 결과인 NaN이다.
    pub fn read(self, bar: &Bar) -> f64 {
        match self {
            Self::Time => bar.time,
            Self::Open => bar.open,
            Self::High => bar.high,
            Self::Low => bar.low,
            Self::Close => bar.close,
            Self::Volume => bar.volume,
            Self::Unknown => f64::NAN,
        }
    }
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}
