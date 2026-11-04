//! Binary64 price-axis range, transform, projection, and inverse projection.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::math::{js_exp, js_log};
use barochart_js::num::{js_max, js_min};
use barochart_js::string::JsString;

const F64_MAX: f64 = f64::MAX;
const F32_MAX: f64 = 3.4028234663852886e38;

/// Axis transform kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxisScaleKind {
    /// Raw linear prices.
    Linear,
    /// Natural logarithm.
    Log,
    /// Percent change from a base.
    Percent,
}

/// Immutable inputs to the projection portion of JS `axisRange`.
///
/// The caller supplies bounds aggregated from the visible model series. `zero_baseline` is true
/// when a histogram/area includes baseline zero; `source_min`/`source_max` already include that
/// baseline, matching the point where JS captures its original domain.
#[derive(Clone, Copy, Debug)]
pub struct AxisScaleInput {
    /// Visible raw minimum after model aggregation and series baselines.
    pub source_min: f64,
    /// Visible raw maximum after model aggregation and series baselines.
    pub source_max: f64,
    /// Linear, logarithmic, or percentage projection.
    pub scale: AxisScaleKind,
    /// Symmetric padding fraction.
    pub padding: f64,
    /// Optional explicit raw range.
    pub range: Option<[f64; 2]>,
    /// Optional explicit percentage base.
    pub base: Option<f64>,
    /// First stored close, used as the percentage base when `base` is absent.
    pub first_close: Option<f64>,
    /// Whether visible histogram/area data includes baseline zero.
    pub zero_baseline: bool,
    /// Whether low maps to the bottom instead of the top.
    pub inverted: bool,
    /// Top pixel coordinate.
    pub top: f64,
    /// Bottom pixel coordinate.
    pub bottom: f64,
}

/// Computed axis transform and the values needed for stable interpolation.
#[derive(Clone, Copy, Debug)]
pub struct AxisScale {
    /// Final raw lower bound.
    pub min: f64,
    /// Final raw upper bound.
    pub max: f64,
    /// Effective percentage base (also exposed by JS for non-percent axes).
    pub base: f64,
    /// Top pixel coordinate.
    pub top: f64,
    /// Bottom pixel coordinate.
    pub bottom: f64,
    /// Transformed lower bound.
    pub lo: f64,
    /// Transformed upper bound.
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
    /// Applies JS axis range and projection math to a pure domain/configuration DTO.
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

        // TwoDiff retains the low part of hi-lo for inverse interpolation across zero,
        // without double-rounding subnormal weighted endpoint products.
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

    /// Transforms a raw price using the configured JS math function.
    pub fn transform(&self, value: f64) -> f64 {
        transform_value(self.scale, value, self.base)
    }

    /// Inverts a transformed value using the configured JS math function.
    pub fn inverse(&self, value: f64) -> f64 {
        inverse_value(self.scale, value, self.base)
    }

    /// Projects a raw price to screen Y, returning NaN outside finite F32 bounds.
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

    /// Inverts a screen Y coordinate to a raw price with compensated interpolation.
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
