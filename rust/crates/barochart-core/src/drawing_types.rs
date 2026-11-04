//! 드로잉 리프 타입이다. 변경 불가능한 레코드는 스냅샷과 이력에서 공유한다.

use std::sync::Arc;

use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

/// 지원하는 드로잉 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawingType {
    Trendline,
    Horizontal,
    Fibonacci,
    Rectangle,
    Ellipse,
    Text,
    Ray,
    ExtendedLine,
    Channel,
    FibExtension,
    FibFan,
    FibTimezones,
    Freehand,
    Measurement,
    LongPosition,
    ShortPosition,
}

impl DrawingType {
    /// JS 드로잉 종류 문자열을 파싱한다.
    pub fn parse(value: &JsString) -> Option<Self> {
        Some(match String::from_utf16(value.as_units()).ok()?.as_str() {
            "trendline" => Self::Trendline,
            "horizontal" => Self::Horizontal,
            "fibonacci" => Self::Fibonacci,
            "rectangle" => Self::Rectangle,
            "ellipse" => Self::Ellipse,
            "text" => Self::Text,
            "ray" => Self::Ray,
            "extendedline" => Self::ExtendedLine,
            "channel" => Self::Channel,
            "fibextension" => Self::FibExtension,
            "fibfan" => Self::FibFan,
            "fibtimezones" => Self::FibTimezones,
            "freehand" => Self::Freehand,
            "measurement" => Self::Measurement,
            "longposition" => Self::LongPosition,
            "shortposition" => Self::ShortPosition,
            _ => return None,
        })
    }

    /// 이 드로잉 종류의 JS 문자열 표기를 반환한다.
    pub fn as_js(self) -> &'static str {
        match self {
            Self::Trendline => "trendline",
            Self::Horizontal => "horizontal",
            Self::Fibonacci => "fibonacci",
            Self::Rectangle => "rectangle",
            Self::Ellipse => "ellipse",
            Self::Text => "text",
            Self::Ray => "ray",
            Self::ExtendedLine => "extendedline",
            Self::Channel => "channel",
            Self::FibExtension => "fibextension",
            Self::FibFan => "fibfan",
            Self::FibTimezones => "fibtimezones",
            Self::Freehand => "freehand",
            Self::Measurement => "measurement",
            Self::LongPosition => "longposition",
            Self::ShortPosition => "shortposition",
        }
    }

    /// 포지션 주석 종류인지 반환한다.
    pub fn is_position(self) -> bool {
        matches!(self, Self::LongPosition | Self::ShortPosition)
    }
}

/// 검증된 시간·가격 앵커다.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawingPoint {
    /// UTC 기준 밀리초 시간이다.
    pub time: f64,
    /// 원시 가격이다.
    pub price: f64,
}

impl DrawingPoint {
    /// `time`, `price` 정규 키 순서로 직렬화한다.
    pub fn to_value(self) -> JsValue {
        let mut anchor = JsObject::new();
        anchor.insert(JsString::from_str("time"), JsValue::Number(self.time));
        anchor.insert(JsString::from_str("price"), JsValue::Number(self.price));
        JsValue::Object(anchor)
    }
}

/// 검증된 불변 드로잉 스타일이다. 다른 필드를 바꿀 때 공유할 수 있다.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawingStyle {
    /// 이식 가능한 선 색상이다.
    pub color: Option<JsString>,
    /// 선 너비다.
    pub width: Option<f64>,
    /// 이식 가능한 채움 색상이다.
    pub fill: Option<JsString>,
    /// 이식 가능한 글꼴이다.
    pub font: Option<JsString>,
}

impl DrawingStyle {
    /// 스타일 필드를 정규 순서로 직렬화한다.
    pub fn to_value(&self) -> JsValue {
        let mut style = JsObject::new();
        if let Some(color) = &self.color {
            style.insert(JsString::from_str("color"), JsValue::String(color.clone()));
        }
        if let Some(width) = self.width {
            style.insert(JsString::from_str("width"), JsValue::Number(width));
        }
        if let Some(fill) = &self.fill {
            style.insert(JsString::from_str("fill"), JsValue::String(fill.clone()));
        }
        if let Some(font) = &self.font {
            style.insert(JsString::from_str("font"), JsValue::String(font.clone()));
        }
        JsValue::Object(style)
    }
}

/// 검증된 불변 드로잉 레코드다. 앵커 슬라이스와 스타일은 수정 사이에 공유할 수 있다.
#[derive(Clone, Debug, PartialEq)]
pub struct Drawing {
    /// 고유 드로잉 식별자다.
    pub id: JsString,
    /// 패널 식별자다.
    pub panel: JsString,
    /// 명시적으로 저장된 잠금 상태다.
    pub locked: Option<bool>,
    /// 선택적인 불변 스타일이다.
    pub style: Option<Arc<DrawingStyle>>,
    /// 드로잉 종류다.
    pub kind: DrawingType,
    /// 불변 시간·가격 앵커다.
    pub points: Arc<[DrawingPoint]>,
    /// 선택적인 드로잉 주석 문자열이다.
    pub text: Option<JsString>,
    /// 명시적으로 저장된 표시 상태다.
    pub visible: Option<bool>,
    /// 선택적인 축 바인딩이다. JSON 복사 때 null 바인딩은 생략한다.
    pub axis_id: Option<JsString>,
    /// 선택적인 시리즈 바인딩이다. JSON 복사 때 null 바인딩은 생략한다.
    pub series_id: Option<JsString>,
}

impl Drawing {
    /// 드로잉 레코드를 정규 키 순서로 직렬화한다.
    pub fn to_value(&self) -> JsValue {
        let mut record = JsObject::new();
        record.insert(JsString::from_str("id"), JsValue::String(self.id.clone()));
        record.insert(
            JsString::from_str("panel"),
            JsValue::String(self.panel.clone()),
        );
        if let Some(locked) = self.locked {
            record.insert(JsString::from_str("locked"), JsValue::Bool(locked));
        }
        if let Some(style) = &self.style {
            record.insert(JsString::from_str("style"), style.to_value());
        }
        record.insert(
            JsString::from_str("type"),
            JsValue::String(JsString::from_str(self.kind.as_js())),
        );
        record.insert(
            JsString::from_str("points"),
            JsValue::Array(self.points.iter().map(|point| point.to_value()).collect()),
        );
        if let Some(text) = &self.text {
            record.insert(JsString::from_str("text"), JsValue::String(text.clone()));
        }
        if let Some(visible) = self.visible {
            record.insert(JsString::from_str("visible"), JsValue::Bool(visible));
        }
        if let Some(axis_id) = &self.axis_id {
            record.insert(
                JsString::from_str("axisId"),
                JsValue::String(axis_id.clone()),
            );
        }
        if let Some(series_id) = &self.series_id {
            record.insert(
                JsString::from_str("seriesId"),
                JsValue::String(series_id.clone()),
            );
        }
        JsValue::Object(record)
    }

    /// 문자열 길이를 JS UTF-16 코드 단위로 반환한다.
    pub fn text_len_utf16(&self) -> usize {
        self.text.as_ref().map_or(0, JsString::len_utf16)
    }
}
