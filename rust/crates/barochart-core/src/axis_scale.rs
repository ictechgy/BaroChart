//! 이진64 가격 축의 범위, 변환, 화면 투영, 역투영이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::math::{js_exp, js_log};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

const F64_MAX: f64 = f64::MAX;
const F32_MAX: f64 = 3.4028234663852886e38;

/// 축 값 변환 방식이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxisScaleKind {
    /// 원시 가격을 그대로 쓰는 선형 축이다.
    Linear,
    /// 자연로그를 쓰는 로그 축이다.
    Log,
    /// 기준값 대비 백분율 변화 축이다.
    Percent,
}

/// JS `axisRange`의 범위·투영 단계에 전달하는 불변 입력이다.
///
/// 호출자는 현재 표시 중인 모델 시리즈에서 집계한 범위를 전달한다. `source_min`과
/// `source_max`에는 히스토그램·영역 계열의 기준선도 이미 반영한다. `zero_baseline`은
/// 그 계열의 0 기준선이 원래 데이터 범위에 포함되었음을 나타낸다.
#[derive(Clone, Copy, Debug)]
pub struct AxisScaleInput {
    /// 모델 데이터와 시리즈 기준선을 집계한 뒤의 표시 최솟값이다.
    pub source_min: f64,
    /// 모델 데이터와 시리즈 기준선을 집계한 뒤의 표시 최댓값이다.
    pub source_max: f64,
    /// 선형, 로그, 백분율 중 축 투영 방식이다.
    pub scale: AxisScaleKind,
    /// 양쪽에 적용할 대칭 여백 비율이다.
    pub padding: f64,
    /// 선택적 명시 원시 범위다.
    pub range: Option<[f64; 2]>,
    /// 선택적 백분율 기준값이다.
    pub base: Option<f64>,
    /// `base`가 없을 때 백분율 기준값으로 쓰는 첫 저장 종가다.
    pub first_close: Option<f64>,
    /// 표시 데이터에 0 기준선이 포함되는 히스토그램·영역 계열이 있는지 나타낸다.
    pub zero_baseline: bool,
    /// 참이면 최솟값을 화면 위쪽, 최댓값을 아래쪽에 배치한다.
    pub inverted: bool,
    /// 화면 위쪽 픽셀 좌표다.
    pub top: f64,
    /// 화면 아래쪽 픽셀 좌표다.
    pub bottom: f64,
}

/// 계산된 축 변환과 안정적인 보간에 필요한 값이다.
#[derive(Clone, Copy, Debug)]
pub struct AxisScale {
    /// 최종 원시 최솟값이다.
    pub min: f64,
    /// 최종 원시 최댓값이다.
    pub max: f64,
    /// 실제 백분율 기준값이다. JS는 백분율이 아닌 축에서도 이 값을 노출한다.
    pub base: f64,
    /// 화면 위쪽 픽셀 좌표다.
    pub top: f64,
    /// 화면 아래쪽 픽셀 좌표다.
    pub bottom: f64,
    /// 변환된 최솟값이다.
    pub lo: f64,
    /// 변환된 최댓값이다.
    pub hi: f64,
    scale: AxisScaleKind,
    inverted: bool,
    direct: bool,
    delta: f64,
    delta_error: f64,
    magnitude: f64,
    scaled_lo: f64,
    scaled_hi: f64,
    origin: f64,
    extent: f64,
    scaled_origin: f64,
    scaled_extent: f64,
}

impl AxisScale {
    /// 순수 범위·설정 DTO에 JS 축 범위와 투영 규칙을 적용한다.
    pub fn new(input: AxisScaleInput) -> Result<Self, JsError> {
        let source_min = input.source_min;
        let source_max = input.source_max;
        let mut min = source_min;
        let mut max = source_max;

        if !min.is_finite() || !max.is_finite() {
            (min, max) = match input.scale {
                AxisScaleKind::Log => (1.0, 10.0),
                AxisScaleKind::Linear | AxisScaleKind::Percent => (0.0, 1.0),
            };
        }
        if input.scale == AxisScaleKind::Log && min.is_finite() && min <= 0.0 {
            return Err(range_error(
                "Log scale requires strictly positive visible data",
            ));
        }

        if let Some(range) = input.range {
            min = range[0];
            max = range[1];
        } else {
            let baseline = min == 0.0 && input.zero_baseline;
            let padding = if max == min {
                let expanded = max.abs() * 0.01;
                (if expanded == 0.0 { 1.0 } else { expanded }) * input.padding
            } else {
                max * input.padding - min * input.padding
            };
            min = js_max(&[-F64_MAX, min - padding]);
            max = js_min(&[F64_MAX, max + padding]);
            if baseline {
                min = 0.0;
            }
        }

        if min == max {
            let expanded = min.abs() * 1e-12;
            let delta = if expanded == 0.0 { 1.0 } else { expanded };
            min = js_max(&[-F64_MAX, min - delta]);
            max = js_min(&[F64_MAX, max + delta]);
        }
        if input.scale == AxisScaleKind::Log && min <= 0.0 {
            return Err(range_error(
                "Log scale requires a strictly positive visible range (adjust padding/range)",
            ));
        }

        let base = input
            .base
            .unwrap_or_else(|| input.first_close.unwrap_or(1.0));
        if input.scale == AxisScaleKind::Percent && base == 0.0 {
            return Err(range_error("Percent base cannot be zero"));
        }

        let lo = transform_value(input.scale, min, base);
        let hi = transform_value(input.scale, max, base);
        if !lo.is_finite() || !hi.is_finite() {
            return Err(range_error("Axis transform overflow"));
        }

        let delta = hi - lo;
        let direct = delta.is_finite() && delta != 0.0;
        let raw_magnitude = js_max(&[lo.abs(), hi.abs()]);
        let magnitude = if raw_magnitude == 0.0 {
            1.0
        } else {
            raw_magnitude
        };
        let scaled_lo = lo / magnitude;
        let scaled_hi = hi / magnitude;
        let span = scaled_hi - scaled_lo;
        if !direct && (!span.is_finite() || span == 0.0) {
            return Err(range_error("Axis transform has no representable span"));
        }

        // TwoDiff로 hi-lo의 낮은 부분을 보존해 0을 가로지르는 역보간에서
        // 부분 정상수 끝점 곱의 이중 반올림을 피한다.
        let virtual_lo = if direct { hi - delta } else { 0.0 };
        let delta_error = if direct {
            (hi - (delta + virtual_lo)) + (virtual_lo - lo)
        } else {
            0.0
        };
        let (origin, extent, scaled_origin, scaled_extent) = if input.inverted {
            (lo, delta, scaled_lo, span)
        } else {
            (hi, -delta, scaled_hi, -span)
        };
        let axis = Self {
            min,
            max,
            base,
            top: input.top,
            bottom: input.bottom,
            lo,
            hi,
            scale: input.scale,
            inverted: input.inverted,
            direct,
            delta,
            delta_error,
            magnitude,
            scaled_lo,
            scaled_hi,
            origin,
            extent,
            scaled_origin,
            scaled_extent,
        };

        if source_min.is_finite()
            && (!f32_projection_is_finite(axis.y(source_min))
                || !f32_projection_is_finite(axis.y(source_max)))
        {
            return Err(range_error("Axis projection overflow for visible values"));
        }
        Ok(axis)
    }

    /// 설정된 JS 수학 함수를 사용해 원시 가격을 변환한다.
    pub fn transform(&self, value: f64) -> f64 {
        transform_value(self.scale, value, self.base)
    }

    /// 설정된 JS 수학 함수를 사용해 변환된 값을 되돌린다.
    pub fn inverse(&self, value: f64) -> f64 {
        inverse_value(self.scale, value, self.base)
    }

    /// 원시 가격을 화면 Y 좌표로 투영한다. 유한한 F32 범위를 벗어나면 NaN을 돌려준다.
    pub fn y(&self, value: f64) -> f64 {
        let mapped = self.transform(value);
        let difference = mapped - self.origin;
        let fraction = if self.direct {
            if difference.is_finite() {
                difference / self.extent
            } else {
                (mapped / self.magnitude - self.scaled_origin) / self.scaled_extent
            }
        } else {
            (mapped / self.magnitude - self.scaled_origin) / self.scaled_extent
        };
        let coordinate = self.top + fraction * (self.bottom - self.top);
        if (-F32_MAX..=F32_MAX).contains(&coordinate) {
            coordinate
        } else {
            f64::NAN
        }
    }

    /// 보정 보간으로 화면 Y 좌표를 원시 가격으로 역투영한다.
    pub fn price(&self, screen_y: f64) -> f64 {
        let fraction = (screen_y - self.top) / (self.bottom - self.top);
        let fraction = if self.inverted {
            fraction
        } else {
            1.0 - fraction
        };
        let mut value = if self.direct {
            if fraction <= 0.5 {
                self.lo + fraction * self.delta
            } else {
                self.hi - (1.0 - fraction) * self.delta
            }
        } else {
            f64::NAN
        };
        if self.direct && self.delta_error != 0.0 {
            value += if fraction <= 0.5 {
                fraction * self.delta_error
            } else {
                -(1.0 - fraction) * self.delta_error
            };
        }
        if !value.is_finite() {
            value =
                ((1.0 - fraction) * self.scaled_lo + fraction * self.scaled_hi) * self.magnitude;
        }
        self.inverse(value)
    }
}

fn transform_value(scale: AxisScaleKind, value: f64, base: f64) -> f64 {
    match scale {
        AxisScaleKind::Linear => value,
        AxisScaleKind::Log => js_log(value),
        AxisScaleKind::Percent => (value / base - 1.0) * 100.0,
    }
}

fn inverse_value(scale: AxisScaleKind, value: f64, base: f64) -> f64 {
    match scale {
        AxisScaleKind::Linear => value,
        AxisScaleKind::Log => js_exp(value),
        AxisScaleKind::Percent => (value / 100.0 + 1.0) * base,
    }
}

fn f32_projection_is_finite(value: f64) -> bool {
    (value as f32).is_finite()
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
