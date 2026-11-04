//! 현재 모델, 저장소, 지표, 호스트로 렌더러 독립 레이아웃을 만든다.
//!
//! 소유 결과에는 패널·축의 기하와 스케일 투영을 보관한다. JS 클로저를 따르는 메서드는
//! 현재 뷰·모델·저장소를 인자로 받아, 오래된 레이아웃도 캡처한 기하를 유지하면서 최신
//! 모델 상태를 읽는다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json_with};
use barochart_js::num::{NumberDialect, js_max, js_min};
use barochart_js::string::JsString;

use crate::Host;
use crate::axis_scale::{AxisScale, AxisScaleInput, AxisScaleKind};
use crate::contracts::RESOURCE_LIMITS;
use crate::data::{BarStore, DataIdentity};
use crate::indicator_engine::{IndicatorEngine, IndicatorRead};
use crate::labels::label_metrics;
use crate::model_state::{ModelState, Panel, Series, SeriesKind, VisibleRange};
use crate::range_index::RangeQuery;
use crate::series_cache::SeriesCaches;

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn object_ref(value: &JsValue) -> Option<&JsObject> {
    match value {
        JsValue::Object(value) => Some(value),
        _ => None,
    }
}

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    object_ref(value)?.get(&JsString::from_str(name))
}

fn ascii_eq(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn number_field(record: &JsValue, name: &str, default: f64) -> f64 {
    match field(record, name) {
        Some(JsValue::Number(value)) => *value,
        _ => default,
    }
}

fn bool_field(record: &JsValue, name: &str, default: bool) -> bool {
    match field(record, name) {
        Some(JsValue::Bool(value)) => *value,
        _ => default,
    }
}

fn option_number(record: &JsValue, name: &str) -> Option<f64> {
    match field(record, name) {
        Some(JsValue::Number(value)) => Some(*value),
        _ => None,
    }
}

fn option_range(record: &JsValue, name: &str) -> Option<[f64; 2]> {
    let Some(JsValue::Array(values)) = field(record, name) else {
        return None;
    };
    match values.as_slice() {
        [JsValue::Number(from), JsValue::Number(to)] => Some([*from, *to]),
        _ => None,
    }
}

fn scale_kind(name: &JsString) -> Result<AxisScaleKind, JsError> {
    if ascii_eq(name, "linear") {
        Ok(AxisScaleKind::Linear)
    } else if ascii_eq(name, "log") {
        Ok(AxisScaleKind::Log)
    } else if ascii_eq(name, "percent") {
        Ok(AxisScaleKind::Percent)
    } else {
        Err(range_error("Unknown axis scale"))
    }
}

#[derive(Clone)]
struct AxisConfig {
    record: JsValue,
    id: JsString,
    panel_id: JsString,
    axis_id: Option<JsString>,
    scale_name: JsString,
    scale: AxisScaleKind,
    inverted: bool,
    padding: f64,
    range: Option<[f64; 2]>,
    base: Option<f64>,
    side: JsString,
    visible: bool,
    width: f64,
}

impl AxisConfig {
    fn from_panel(panel: &Panel, axis_width: f64) -> Result<Self, JsError> {
        let mut record = panel.to_js_value();
        let JsValue::Object(object) = &mut record else {
            unreachable!("validated panel records are objects")
        };
        object.insert(JsString::from_str("axisId"), JsValue::Null);
        object.insert(
            JsString::from_str("side"),
            JsValue::String(panel.axis_side.clone()),
        );
        object.insert(
            JsString::from_str("visible"),
            JsValue::Bool(panel.axis_visible),
        );
        object.insert(JsString::from_str("width"), JsValue::Number(axis_width));
        Ok(Self {
            record,
            id: panel.id.clone(),
            panel_id: panel.id.clone(),
            axis_id: None,
            scale_name: panel.scale.clone(),
            scale: scale_kind(&panel.scale)?,
            inverted: panel.inverted,
            padding: panel.padding,
            range: option_range(&panel.to_js_value(), "range"),
            base: option_number(&panel.to_js_value(), "base"),
            side: panel.axis_side.clone(),
            visible: panel.axis_visible,
            width: axis_width,
        })
    }

    fn from_axis(axis: &crate::model_state::Axis, axis_width: f64) -> Result<Self, JsError> {
        let mut record = axis.to_js_value();
        let JsValue::Object(object) = &mut record else {
            unreachable!("validated axis records are objects")
        };
        object.insert(
            JsString::from_str("axisId"),
            JsValue::String(axis.id.clone()),
        );
        let width = axis.width.unwrap_or(axis_width);
        object.insert(JsString::from_str("width"), JsValue::Number(width));
        let scale_name = field(&record, "scale")
            .and_then(|value| match value {
                JsValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_else(|| JsString::from_str("linear"));
        let side = field(&record, "side")
            .and_then(|value| match value {
                JsValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_else(|| JsString::from_str("right"));
        Ok(Self {
            range: option_range(&record, "range"),
            base: option_number(&record, "base"),
            inverted: bool_field(&record, "inverted", false),
            padding: number_field(&record, "padding", 0.08),
            visible: axis.visible,
            record,
            id: axis.id.clone(),
            panel_id: axis.panel.clone(),
            axis_id: Some(axis.id.clone()),
            scale: scale_kind(&scale_name)?,
            scale_name,
            side,
            width,
        })
    }
}

/// 소유 축 투영과 표시 스트립 기하다.
#[derive(Clone, Debug)]
pub struct LayoutAxis {
    /// 소스 축 식별자다. 기본 축이면 패널 식별자다.
    pub id: JsString,
    /// 소속 패널이다.
    pub panel_id: JsString,
    /// 독립 축 식별자다. `None`이면 패널 기본 축이다.
    pub axis_id: Option<JsString>,
    /// 소스 스케일 이름이다.
    pub scale_name: JsString,
    /// 축 스트립이 놓이는 방향이다.
    pub side: JsString,
    /// 축 스트립 표시 여부다.
    pub visible: bool,
    /// 전역 너비 비율을 적용하기 전의 설정된 스트립 너비다.
    pub width: f64,
    /// 소스 키 순서를 보존한 전체 설정 레코드다.
    pub config: JsValue,
    /// 소스 설정에서 전달된 선택적 레이블이다.
    pub label: Option<JsString>,
    /// 축별로 지정한 선택적 가격 정밀도다.
    pub precision: Option<u8>,
    /// 고정/과학 표기 중 선택하는 틱 형식이다.
    pub tick_format: Option<JsString>,
    /// 형식화된 값 앞에 붙는 선택적 접두사다.
    pub prefix: Option<JsString>,
    /// 형식화된 값 뒤에 붙는 선택적 접미사다.
    pub suffix: Option<JsString>,
    /// 패널 축이 공유하는 플롯 영역의 왼쪽 경계다.
    pub left: f64,
    /// 플롯 영역의 오른쪽 경계다.
    pub right: f64,
    /// 패널 위쪽 경계다.
    pub top: f64,
    /// 패널 아래쪽 경계다.
    pub bottom: f64,
    /// 최종 원시 최솟값이다.
    pub min: f64,
    /// 최종 원시 최댓값이다.
    pub max: f64,
    /// 실제 백분율 기준값이다. 기본 축이면 첫 종가 또는 1이다.
    pub base: f64,
    /// 변환된 최솟값이다.
    pub lo: f64,
    /// 변환된 최댓값이다.
    pub hi: f64,
    /// 표시 스트립 왼쪽 경계다.
    pub axis_left: f64,
    /// 표시 스트립 오른쪽 경계다.
    pub axis_right: f64,
    /// 레이블 문자열이 시작하는 X 좌표다.
    pub text_x: f64,
    /// 레이아웃 생성 시점에 캡처한 가격 변환과 투영이다.
    pub scale: AxisScale,
    inverted: bool,
}

impl LayoutAxis {
    fn from_config(
        config: AxisConfig,
        axis: AxisScale,
        left: f64,
        right: f64,
        axis_left: f64,
        axis_right: f64,
        text_x: f64,
    ) -> Self {
        let label = text_value(&config.record, "label");
        let precision = option_number(&config.record, "precision").map(|value| value as u8);
        let tick_format = text_value(&config.record, "tickFormat");
        let prefix = text_value(&config.record, "prefix");
        let suffix = text_value(&config.record, "suffix");
        Self {
            id: config.id,
            panel_id: config.panel_id,
            axis_id: config.axis_id,
            scale_name: config.scale_name,
            side: config.side,
            visible: config.visible,
            width: config.width,
            label,
            precision,
            tick_format,
            prefix,
            suffix,
            left,
            right,
            top: axis.top,
            bottom: axis.bottom,
            min: axis.min,
            max: axis.max,
            base: axis.base,
            lo: axis.lo,
            hi: axis.hi,
            axis_left,
            axis_right,
            text_x,
            inverted: config.inverted,
            config: config.record,
            scale: axis,
        }
    }

    /// 캡처한 범위와 가격 스케일을 사용해 가격을 화면에 투영한다.
    pub fn y(&self, value: f64) -> f64 {
        self.scale.y(value)
    }

    /// 캡처한 범위와 스케일로 화면 좌표를 가격으로 역투영한다.
    pub fn price(&self, screen_y: f64) -> f64 {
        self.scale.price(screen_y)
    }

    /// 캡처한 축 변환으로 원시값을 변환한다.
    pub fn transform(&self, value: f64) -> f64 {
        self.scale.transform(value)
    }

    /// 캡처한 역변환을 적용한다.
    pub fn inverse(&self, value: f64) -> f64 {
        self.scale.inverse(value)
    }

    fn to_js_value(&self) -> JsValue {
        let mut value = self.config.clone();
        let JsValue::Object(result) = &mut value else {
            unreachable!("axis config records are objects")
        };
        result.insert(JsString::from_str("left"), JsValue::Number(self.left));
        result.insert(JsString::from_str("right"), JsValue::Number(self.right));
        result.insert(JsString::from_str("top"), JsValue::Number(self.top));
        result.insert(JsString::from_str("bottom"), JsValue::Number(self.bottom));
        result.insert(JsString::from_str("min"), JsValue::Number(self.min));
        result.insert(JsString::from_str("max"), JsValue::Number(self.max));
        result.insert(JsString::from_str("base"), JsValue::Number(self.base));
        result.insert(JsString::from_str("lo"), JsValue::Number(self.lo));
        result.insert(JsString::from_str("hi"), JsValue::Number(self.hi));
        result.insert(
            JsString::from_str("axisLeft"),
            JsValue::Number(self.axis_left),
        );
        result.insert(
            JsString::from_str("axisRight"),
            JsValue::Number(self.axis_right),
        );
        result.insert(JsString::from_str("textX"), JsValue::Number(self.text_x));
        value
    }
}

fn text_value(record: &JsValue, name: &str) -> Option<JsString> {
    match field(record, name) {
        Some(JsValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

/// 소유 패널 투영이다. 첫 축이 패널 기본 축이다.
#[derive(Clone, Debug)]
pub struct LayoutPanel {
    /// 패널 식별자다.
    pub id: JsString,
    /// 플롯 영역의 왼쪽 경계다.
    pub left: f64,
    /// 플롯 영역의 오른쪽 경계다.
    pub right: f64,
    /// 패널 위쪽 경계다.
    pub top: f64,
    /// 패널 아래쪽 경계다.
    pub bottom: f64,
    /// 패널 기본 축 다음에 모델 순서대로 독립 축을 둔다.
    pub axes: Vec<LayoutAxis>,
}

impl LayoutPanel {
    fn to_js_value(&self) -> JsValue {
        let mut result = self.axes[0].to_js_value();
        let JsValue::Object(object) = &mut result else {
            unreachable!("axis wire values are objects")
        };
        object.insert(
            JsString::from_str("axes"),
            JsValue::Array(self.axes.iter().map(LayoutAxis::to_js_value).collect()),
        );
        result
    }
}

/// `to_screen`이 돌려주는 픽셀 좌표다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenPoint {
    /// 가로 축에 투영한 분수형 저장 인덱스다.
    pub x: f64,
    /// 선택한 축에 투영한 원시 가격이다.
    pub y: f64,
}

/// `from_screen`이 돌려주는 시각과 가격이다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenPrice {
    /// 현재 저장소에서 투영한 봉 인덱스의 시각이다.
    pub time: f64,
    /// 캡처한 축으로 역투영한 가격이다.
    pub price: f64,
}

/// 차트 프레임 하나에 대한 완전한 소유 기하 스냅샷이다.
#[derive(Clone, Debug)]
pub struct Layout {
    /// 캡처한 기하와 데이터 출처 식별자를 나타내는 JSON 문자열 키다.
    pub geometry_key: JsString,
    /// 문자열로 한정하지 않고 보존한 원래 테마 글꼴 값이다.
    pub geometry_font: JsValue,
    /// CSS 픽셀 단위 레이아웃 너비다.
    pub width: f64,
    /// CSS 픽셀 단위 레이아웃 높이다.
    pub height: f64,
    /// 캡처한 첫 표시 저장 인덱스다.
    pub from: f64,
    /// 캡처한 마지막 표시 저장 인덱스의 배타 경계다.
    pub to: f64,
    /// 너비 비율을 적용하기 전 왼쪽 축 스트립의 최대 너비다.
    pub left_strip: f64,
    /// 너비 비율을 적용하기 전 오른쪽 축 스트립의 최대 너비다.
    pub right_strip: f64,
    /// 표시 스트립 전체에 적용하는 공통 너비 비율이다.
    pub strip_factor: f64,
    /// 레이블 영역으로 예약한 아래쪽 높이다.
    pub footer: f64,
    /// 플롯 영역의 왼쪽 경계다.
    pub plot_left: f64,
    /// 플롯 영역의 오른쪽 경계다.
    pub plot_right: f64,
    /// 화면에 그리는 순서의 패널 목록이다.
    pub panels: Vec<LayoutPanel>,
}

impl Layout {
    /// 패널과 선택적 독립 축 식별자로 캡처한 축을 찾는다.
    pub fn axis(&self, panel_id: &JsString, axis_id: Option<&JsString>) -> Option<&LayoutAxis> {
        self.panels
            .iter()
            .find(|panel| panel.id == *panel_id)?
            .axes
            .iter()
            .find(|axis| axis.axis_id.as_ref() == axis_id)
    }

    /// 현재 모델의 시리즈 바인딩과 캡처한 축 기하를 이용해 드로잉 축을 찾는다.
    pub fn drawing_axis(
        &self,
        current_model: &ModelState,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
        series_id: Option<&JsString>,
    ) -> Option<&LayoutAxis> {
        if let Some(series_id) = series_id {
            let series = current_model
                .series
                .iter()
                .find(|series| series.id == *series_id)?;
            if !series.visible || series.panel != *panel_id || series.axis_id.as_ref() != axis_id {
                return None;
            }
        }
        self.axis(panel_id, axis_id)
    }

    /// 현재 뷰와 캡처한 플롯 경계를 사용해 봉 인덱스를 화면 X 좌표로 바꾼다.
    pub fn x(&self, current_view: VisibleRange, index: f64) -> f64 {
        self.plot_left
            + (index - current_view.from) / (current_view.to - current_view.from)
                * (self.plot_right - self.plot_left)
    }

    /// 현재 뷰와 캡처한 플롯 경계를 사용해 화면 X 좌표를 봉 인덱스로 바꾼다.
    pub fn index(&self, current_view: VisibleRange, screen_x: f64) -> f64 {
        current_view.from
            + (screen_x - self.plot_left) / (self.plot_right - self.plot_left)
                * (current_view.to - current_view.from)
    }

    /// 현재 뷰·저장소와 캡처한 축 변환으로 시각·가격을 화면에 투영한다.
    pub fn to_screen(
        &self,
        current_view: VisibleRange,
        current_store: &BarStore,
        time: f64,
        price: f64,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
    ) -> ScreenPoint {
        let Some(axis) = self.axis(panel_id, axis_id) else {
            return ScreenPoint {
                x: f64::NAN,
                y: f64::NAN,
            };
        };
        ScreenPoint {
            x: self.x(current_view, current_store.index_at_time(time)),
            y: axis.scale.y(price),
        }
    }

    /// 현재 뷰·저장소와 캡처한 축 변환으로 화면 좌표를 시각·가격으로 역투영한다.
    #[allow(clippy::wrong_self_convention)] // JS layout exposes this method as `fromScreen`.
    pub fn from_screen(
        &self,
        current_view: VisibleRange,
        current_store: &BarStore,
        screen_x: f64,
        screen_y: f64,
        panel_id: &JsString,
        axis_id: Option<&JsString>,
    ) -> Result<ScreenPrice, JsError> {
        let Some(axis) = self.axis(panel_id, axis_id) else {
            return Err(ordinary_error("Missing axis"));
        };
        Ok(ScreenPrice {
            time: current_store.time_at_index(self.index(current_view, screen_x)),
            price: axis.scale.price(screen_y),
        })
    }

    /// 기하 캐시에서 사용하는 원래 키 문자열이다.
    pub fn geometry_key(&self) -> &JsString {
        &self.geometry_key
    }

    /// 기하 캐시에서 사용하는 원래의 미변환 테마 글꼴 값이다.
    pub fn geometry_font(&self) -> &JsValue {
        &self.geometry_font
    }

    /// JS 반환 레코드와 같은 삽입 순서의 직렬화 가능한 레이아웃 필드다.
    pub fn to_js_value(&self) -> JsValue {
        object_value([
            ("geometryKey", JsValue::String(self.geometry_key.clone())),
            ("geometryFont", self.geometry_font.clone()),
            ("width", JsValue::Number(self.width)),
            ("height", JsValue::Number(self.height)),
            (
                "panels",
                JsValue::Array(self.panels.iter().map(LayoutPanel::to_js_value).collect()),
            ),
            ("from", JsValue::Number(self.from)),
            ("to", JsValue::Number(self.to)),
        ])
    }
}

/// 실제 모델·저장소·지표·호스트 소유자와 차트별 캐시로 레이아웃을 만든다.
#[allow(clippy::too_many_arguments)]
pub fn create_layout(
    model: &mut ModelState,
    store: &BarStore,
    indicators: &mut IndicatorEngine,
    host: &dyn Host,
    caches: &mut SeriesCaches,
    width: f64,
    height: f64,
) -> Result<Layout, JsError> {
    if !width.is_finite()
        || !height.is_finite()
        || width < 100.0
        || height < 80.0
        || width > RESOURCE_LIMITS.max_canvas_dimension as f64
        || height > RESOURCE_LIMITS.max_canvas_dimension as f64
    {
        return Err(range_error("Chart needs at least 100 × 80 CSS pixels"));
    }

    caches.retain_series(&model.series);
    let configs: Vec<Vec<AxisConfig>> = model
        .panels
        .iter()
        .map(|panel| {
            let mut row = Vec::new();
            row.push(AxisConfig::from_panel(panel, model.axis_width)?);
            for axis in model.axes.iter().filter(|axis| axis.panel == panel.id) {
                row.push(AxisConfig::from_axis(axis, model.axis_width)?);
            }
            Ok(row)
        })
        .collect::<Result<_, JsError>>()?;
    let (left_strip, right_strip) = axis_strip_widths(model);
    let strip_factor = js_min(&[
        1.0,
        (width - 32.0)
            / if left_strip + right_strip == 0.0 {
                1.0
            } else {
                left_strip + right_strip
            },
    ]);
    let plot_left = 12.0 + left_strip * strip_factor;
    let plot_right = js_max(&[plot_left + 20.0, width - right_strip * strip_factor]);
    let max_weight = js_max(
        &model
            .panels
            .iter()
            .map(|panel| panel.weight)
            .collect::<Vec<_>>(),
    );
    let mut total_weight = 0.0;
    for panel in &model.panels {
        total_weight += panel.weight / max_weight;
    }
    let (from, to) = visible_indices(model.view, store.length());
    let font = field(model.theme(), "font")
        .cloned()
        .unwrap_or(JsValue::Undefined);
    let metrics = label_metrics(&font, NumberDialect::PLATFORM)?;
    let footer = js_min(&[
        height - 24.0,
        js_max(&[38.0, (metrics.height + 20.0).ceil()]),
    ]);
    let panel_space = height - footer;
    let mut top = 12.0;
    let panel_definitions = model.panels.clone();
    let mut panels = Vec::with_capacity(panel_definitions.len());
    for (panel_index, panel) in panel_definitions.iter().enumerate() {
        let row_height = panel_space * (panel.weight / max_weight / total_weight);
        let gap = js_min(&[8.0, row_height / 2.0]);
        let bottom = top + row_height - gap;
        let series_indices: Vec<usize> = model
            .series
            .iter()
            .enumerate()
            .filter(|(_, series)| series.panel == panel.id && series.visible)
            .map(|(index, _)| index)
            .collect();
        let mut left_cursor = plot_left;
        let mut right_cursor = plot_right;
        let mut axes = Vec::with_capacity(configs[panel_index].len());
        for config in configs[panel_index].iter().cloned() {
            let matching: Vec<usize> = series_indices
                .iter()
                .copied()
                .filter(|index| model.series[*index].axis_id == config.axis_id)
                .collect();
            let scale = axis_range(
                &config, model, &matching, store, indicators, host, caches, from, to, plot_left,
                plot_right, top, bottom,
            )?;
            let width = if config.visible {
                config.width * strip_factor
            } else {
                0.0
            };
            let (axis_left, axis_right, text_x) = if ascii_eq(&config.side, "left") {
                let axis_left = left_cursor - width;
                let axis_right = axis_left + width;
                left_cursor -= width;
                (axis_left, axis_right, axis_left + 4.0)
            } else {
                let axis_left = right_cursor;
                let axis_right = axis_left + width;
                right_cursor += width;
                (axis_left, axis_right, axis_left + 8.0)
            };
            axes.push(LayoutAxis::from_config(
                config, scale, plot_left, plot_right, axis_left, axis_right, text_x,
            ));
        }
        let first = axes.first().expect("every model panel has a base axis");
        panels.push(LayoutPanel {
            id: panel.id.clone(),
            left: first.left,
            right: first.right,
            top: first.top,
            bottom: first.bottom,
            axes,
        });
        top = bottom + gap;
    }
    let geometry_key = geometry_key(model, store, width, height, &panels)?;
    Ok(Layout {
        geometry_key,
        geometry_font: font,
        width,
        height,
        from: from as f64,
        to: to as f64,
        left_strip,
        right_strip,
        strip_factor,
        footer,
        plot_left,
        plot_right,
        panels,
    })
}

fn axis_strip_widths(model: &ModelState) -> (f64, f64) {
    let mut left = 0.0;
    let mut right = 0.0;
    for panel in &model.panels {
        let mut row_left = 0.0;
        let mut row_right = 0.0;
        if panel.axis_visible {
            if ascii_eq(&panel.axis_side, "left") {
                row_left = model.axis_width;
            } else {
                row_right = model.axis_width;
            }
        }
        for axis in model
            .axes
            .iter()
            .filter(|axis| axis.panel == panel.id && axis.visible)
        {
            let width = axis.width.unwrap_or(model.axis_width);
            if ascii_eq(&axis.side, "left") {
                row_left += width;
            } else {
                row_right += width;
            }
        }
        left = js_max(&[left, row_left]);
        right = js_max(&[right, row_right]);
    }
    (left, right)
}

fn visible_indices(view: VisibleRange, length: usize) -> (usize, usize) {
    let length = length as f64;
    let from = js_min(&[length, js_max(&[0.0, view.from.floor()])]);
    let to = js_max(&[from, js_min(&[length, (view.to + 1.0).ceil()])]);
    (from as usize, to as usize)
}

fn series_source(series: &Series) -> &'static str {
    match field(&series.raw_record(), "source") {
        Some(JsValue::String(value)) if ascii_eq(value, "time") => "time",
        Some(JsValue::String(value)) if ascii_eq(value, "open") => "open",
        Some(JsValue::String(value)) if ascii_eq(value, "high") => "high",
        Some(JsValue::String(value)) if ascii_eq(value, "low") => "low",
        Some(JsValue::String(value)) if ascii_eq(value, "volume") => "volume",
        _ => "close",
    }
}

fn series_baseline(series: &Series) -> f64 {
    number_field(&series.raw_record(), "baseline", 0.0)
}

fn aggregate_volume_series(series: &Series) -> bool {
    series.kind == SeriesKind::Histogram
        && series_source(series) == "volume"
        && series.values.is_none()
        && series.indicator.is_none()
        && series.offset == 0.0
        && series_baseline(series) == 0.0
}

fn index_range(series: &Series, view: VisibleRange, length: usize) -> (usize, usize) {
    let length = length as f64;
    let from = js_min(&[length, js_max(&[0.0, (view.from - series.offset).floor()])]);
    let to = js_max(&[
        from,
        js_min(&[length, (view.to + 1.0 - series.offset).ceil()]),
    ]);
    (from as usize, to as usize)
}

fn indicator_output_index(
    read: IndicatorRead<'_>,
    output: Option<&JsString>,
) -> Result<usize, JsError> {
    let Some(output) = output else {
        return Ok(0);
    };
    read.output_names()
        .iter()
        .position(|name| output.as_units().iter().copied().eq(name.encode_utf16()))
        .ok_or_else(|| ordinary_error("Missing indicator output"))
}

fn query_series(
    series: &mut Series,
    model_view: VisibleRange,
    store: &BarStore,
    indicators: &mut IndicatorEngine,
    host: &dyn Host,
    caches: &mut SeriesCaches,
) -> Result<RangeQuery, JsError> {
    let (from, to) = index_range(series, model_view, store.length());
    let identity: DataIdentity = store.data_identity();
    if let Some(indicator) = &series.indicator {
        let read = indicators.get(store, host, &JsValue::String(indicator.clone()))?;
        let output = indicator_output_index(read, series.output.as_ref())?;
        let values = read
            .output_at(output)
            .ok_or_else(|| ordinary_error("Missing indicator output"))?;
        let series_id = series.id.clone();
        let revision_cache = &mut series.revision;
        let dirty_from = &mut series.dirty_from;
        let range_index_ready = &mut series.range_index_ready;
        caches.query_series(
            &series_id,
            true,
            revision_cache,
            dirty_from,
            range_index_ready,
            store,
            &identity,
            values,
            read.revision(),
            read.computed_from() as f64,
            read.computed_until(),
            from,
            to,
        )
    } else if let Some(values) = series.values.as_deref() {
        let series_id = series.id.clone();
        let computed_from = series.dirty_from;
        let revision_cache = &mut series.revision;
        let dirty_from = &mut series.dirty_from;
        let range_index_ready = &mut series.range_index_ready;
        caches.query_series(
            &series_id,
            false,
            revision_cache,
            dirty_from,
            range_index_ready,
            store,
            &identity,
            values,
            store.version(),
            computed_from,
            store.length(),
            from,
            to,
        )
    } else {
        let columns = store.columns();
        let values = match series_source(series) {
            "time" => &columns.time,
            "open" => &columns.open,
            "high" => &columns.high,
            "low" => &columns.low,
            "volume" => &columns.volume,
            _ => &columns.close,
        };
        let series_id = series.id.clone();
        let computed_from = series.dirty_from;
        let revision_cache = &mut series.revision;
        let dirty_from = &mut series.dirty_from;
        let range_index_ready = &mut series.range_index_ready;
        caches.query_series(
            &series_id,
            false,
            revision_cache,
            dirty_from,
            range_index_ready,
            store,
            &identity,
            &values[..store.length()],
            store.version(),
            computed_from,
            store.length(),
            from,
            to,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn axis_range(
    config: &AxisConfig,
    model: &mut ModelState,
    series_indices: &[usize],
    store: &BarStore,
    indicators: &mut IndicatorEngine,
    host: &dyn Host,
    caches: &mut SeriesCaches,
    from: usize,
    to: usize,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> Result<AxisScale, JsError> {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for index in series_indices.iter().copied() {
        let series = &mut model.series[index];
        let query = if aggregate_volume_series(series) {
            let target = js_max(&[1.0, ((right - left) / 3.0).floor()]) as usize;
            let bars = store.aggregate(from as f64, to as f64, target)?;
            let mut volumes = Vec::with_capacity(bars.len() + 1);
            volumes.push(0.0);
            volumes.extend(bars.into_iter().map(|bar| bar.volume));
            RangeQuery {
                min: 0.0,
                max: js_max(&volumes),
                sum: 0.0,
            }
        } else if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc) {
            store.index().query(from, to)?
        } else {
            query_series(series, model.view, store, indicators, host, caches)?
        };
        min = js_min(&[min, query.min]);
        max = js_max(&[max, query.max]);
        if matches!(series.kind, SeriesKind::Histogram | SeriesKind::Area) {
            let baseline = series_baseline(series);
            min = js_min(&[min, baseline]);
            max = js_max(&[max, baseline]);
        }
    }
    let zero_baseline = min == 0.0
        && series_indices.iter().any(|index| {
            let series = &model.series[*index];
            matches!(series.kind, SeriesKind::Histogram | SeriesKind::Area)
                && series_baseline(series) == 0.0
        });
    let first_close = (store.length() > 0).then(|| store.columns().close[0]);
    let axis = AxisScale::new(AxisScaleInput {
        source_min: min,
        source_max: max,
        scale: config.scale,
        padding: config.padding,
        range: config.range,
        base: config.base,
        first_close,
        zero_baseline,
        inverted: config.inverted,
        top,
        bottom,
    })?;
    Ok(axis)
}

fn geometry_key(
    model: &ModelState,
    store: &BarStore,
    width: f64,
    height: f64,
    panels: &[LayoutPanel],
) -> Result<JsString, JsError> {
    let mut values = vec![
        JsValue::Number(width),
        JsValue::Number(height),
        JsValue::Number(model.view.from),
        JsValue::Number(model.view.to),
        JsValue::Number(store.serial()),
        JsValue::Number(store.time_version()),
    ];
    for panel in panels {
        for axis in &panel.axes {
            values.push(JsValue::Array(vec![
                JsValue::String(panel.id.clone()),
                axis.axis_id.clone().map_or(JsValue::Null, JsValue::String),
                JsValue::Number(axis.left),
                JsValue::Number(axis.right),
                JsValue::Number(axis.top),
                JsValue::Number(axis.bottom),
                JsValue::Number(axis.min),
                JsValue::Number(axis.max),
                JsValue::String(axis.scale_name.clone()),
                JsValue::Bool(axis.inverted),
                JsValue::Number(axis.base),
            ]));
        }
    }
    for series in &model.series {
        let raw = series.raw_record();
        let axis_id = actual_axis_id(&raw, series);
        let visible = actual_visible(&raw, series.visible);
        values.push(JsValue::Array(vec![
            JsValue::String(series.id.clone()),
            JsValue::String(series.panel.clone()),
            axis_id,
            visible,
        ]));
    }
    let serialized = stringify_json_with(
        &JsValue::Array(values),
        JsonMode::Standard,
        NumberDialect::PLATFORM,
    );
    let serialized = String::from_utf8(serialized)
        .map_err(|_| ordinary_error("Layout geometry key encoding failed"))?;
    Ok(JsString::from_str(&serialized))
}

fn actual_axis_id(record: &JsValue, series: &Series) -> JsValue {
    match (field(record, "axisId"), series.axis_id.as_ref()) {
        (Some(JsValue::String(value)), Some(current)) if value == current => {
            JsValue::String(value.clone())
        }
        (Some(JsValue::Null), None) => JsValue::Null,
        (Some(JsValue::Undefined), None) | (None, None) => JsValue::Undefined,
        (_, Some(current)) => JsValue::String(current.clone()),
        (_, None) => JsValue::Null,
    }
}

fn actual_visible(record: &JsValue, visible: bool) -> JsValue {
    match field(record, "visible") {
        Some(JsValue::Bool(original)) if *original == visible => JsValue::Bool(*original),
        Some(JsValue::Undefined) => {
            if visible {
                JsValue::Undefined
            } else {
                JsValue::Bool(false)
            }
        }
        None if visible => JsValue::Undefined,
        _ => JsValue::Bool(visible),
    }
}

fn object_value(entries: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (name, value) in entries {
        object.insert(JsString::from_str(name), value);
    }
    JsValue::Object(object)
}
