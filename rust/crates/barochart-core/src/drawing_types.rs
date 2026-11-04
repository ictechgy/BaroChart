//! 드로잉 리프 타입이다. 변경 불가능한 레코드는 스냅샷과 이력에서 공유한다.

use std::mem::size_of;
use std::ops::Deref;
use std::sync::Arc;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope, OomStyle};
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
    /// `time`, `price` 정규 키 순서로 fallible 직렬화한다.
    pub fn to_value_scoped(self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let entries = [
            (
                JsString::try_from_str("time", scope).map_err(memory_error)?,
                JsValue::Number(self.time),
            ),
            (
                JsString::try_from_str("price", scope).map_err(memory_error)?,
                JsValue::Number(self.price),
            ),
        ];
        JsObject::try_from_entries_scoped(entries, scope)
            .map(JsValue::Object)
            .map_err(memory_error)
    }

    /// 기존 테스트와 비회계 도구가 쓰는 정규 직렬화 wrapper다.
    pub fn to_value(self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_value_scoped(&mut scope)
            .expect("unaccounted drawing point serialization")
    }
}

/// 실제 앵커 `Vec`와 requested-byte lease를 함께 공유하는 불변 소유자다.
#[derive(Debug)]
pub struct DrawingPoints {
    values: Vec<DrawingPoint>,
    _memory: MemoryGroup,
}

impl DrawingPoints {
    /// 이미 fallible allocation한 앵커 벡터와 lease를 한 `Arc` 소유자로 채택한다.
    pub fn try_from_vec(
        values: Vec<DrawingPoint>,
        mut memory: MemoryGroup,
    ) -> Result<Arc<Self>, JsError> {
        let vector_bytes = values
            .capacity()
            .checked_mul(size_of::<DrawingPoint>())
            .ok_or_else(|| memory.context().allocation_failure().into_js_error())?;
        let bytes = size_of::<Self>()
            .checked_add(vector_bytes)
            .ok_or_else(|| memory.context().allocation_failure().into_js_error())?;
        memory.try_resize(bytes).map_err(memory_error)?;
        Ok(Arc::new(Self {
            values,
            _memory: memory,
        }))
    }

    /// 기존 테스트가 소유 앵커를 만드는 비회계 wrapper다.
    pub fn from_vec_unaccounted(values: Vec<DrawingPoint>) -> Arc<Self> {
        let context = MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized);
        Self::try_from_vec(values, MemoryGroup::empty(context))
            .expect("unaccounted drawing points allocation")
    }
}

impl Deref for DrawingPoints {
    type Target = [DrawingPoint];

    fn deref(&self) -> &Self::Target {
        &self.values
    }
}

impl AsRef<[DrawingPoint]> for DrawingPoints {
    fn as_ref(&self) -> &[DrawingPoint] {
        &self.values
    }
}

impl PartialEq for DrawingPoints {
    fn eq(&self, other: &Self) -> bool {
        self.values == other.values
    }
}

/// 검증된 불변 드로잉 스타일이다. 다른 필드를 바꿀 때 공유할 수 있다.
#[derive(Debug)]
pub struct DrawingStyle {
    /// 이식 가능한 선 색상이다.
    pub color: Option<JsString>,
    /// 선 너비다.
    pub width: Option<f64>,
    /// 이식 가능한 채움 색상이다.
    pub fill: Option<JsString>,
    /// 이식 가능한 글꼴이다.
    pub font: Option<JsString>,
    _memory: MemoryGroup,
}

impl DrawingStyle {
    /// 검증된 문자열을 지정한 엔진 account로 복제해 불변 스타일을 만든다.
    pub(crate) fn try_from_borrowed(
        color: Option<&JsString>,
        width: Option<f64>,
        fill: Option<&JsString>,
        font: Option<&JsString>,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let mut scope = memory.scope();
        scope.try_grow(size_of::<Self>()).map_err(memory_error)?;
        let color = clone_optional_text(color, &mut scope)?;
        let fill = clone_optional_text(fill, &mut scope)?;
        let font = clone_optional_text(font, &mut scope)?;
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        let memory = scope.split_persistent(requested).map_err(memory_error)?;
        Ok(Self {
            color,
            width,
            fill,
            font,
            _memory: memory,
        })
    }

    /// 값이 없는 임시 스타일을 account allocation 없이 만든다.
    pub(crate) fn empty(memory: &MemoryContext) -> Self {
        Self {
            color: None,
            width: None,
            fill: None,
            font: None,
            _memory: MemoryGroup::empty(memory.clone()),
        }
    }

    /// 스타일 필드를 정규 순서로 fallible 직렬화한다.
    pub fn to_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut entries = scoped_entries(4, scope)?;
        if let Some(color) = &self.color {
            entries.push((
                JsString::try_from_str("color", scope).map_err(memory_error)?,
                JsValue::String(color.try_clone_scoped(scope).map_err(memory_error)?),
            ));
        }
        if let Some(width) = self.width {
            entries.push((
                JsString::try_from_str("width", scope).map_err(memory_error)?,
                JsValue::Number(width),
            ));
        }
        if let Some(fill) = &self.fill {
            entries.push((
                JsString::try_from_str("fill", scope).map_err(memory_error)?,
                JsValue::String(fill.try_clone_scoped(scope).map_err(memory_error)?),
            ));
        }
        if let Some(font) = &self.font {
            entries.push((
                JsString::try_from_str("font", scope).map_err(memory_error)?,
                JsValue::String(font.try_clone_scoped(scope).map_err(memory_error)?),
            ));
        }
        JsObject::try_from_entries_scoped(entries, scope)
            .map(JsValue::Object)
            .map_err(memory_error)
    }

    /// 기존 테스트와 비회계 도구가 쓰는 정규 직렬화 wrapper다.
    pub fn to_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_value_scoped(&mut scope)
            .expect("unaccounted drawing style serialization")
    }
}

impl PartialEq for DrawingStyle {
    fn eq(&self, other: &Self) -> bool {
        self.color == other.color
            && self.width == other.width
            && self.fill == other.fill
            && self.font == other.font
    }
}

// 공개 문자열 필드만 밖으로 이동해 lease보다 오래 살 수 없게 한다.
impl Drop for DrawingStyle {
    fn drop(&mut self) {}
}

/// 검증된 불변 드로잉 레코드다. 앵커와 스타일의 lease도 공유 소유권에 맞춰 한 번만 유지한다.
#[derive(Debug)]
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
    pub points: Arc<DrawingPoints>,
    /// 선택적인 드로잉 주석 문자열이다.
    pub text: Option<JsString>,
    /// 명시적으로 저장된 표시 상태다.
    pub visible: Option<bool>,
    /// 선택적인 축 바인딩이다. JSON 복사 때 null 바인딩은 생략한다.
    pub axis_id: Option<JsString>,
    /// 선택적인 시리즈 바인딩이다. JSON 복사 때 null 바인딩은 생략한다.
    pub series_id: Option<JsString>,
    _memory: MemoryGroup,
}

/// 검증된 드로잉 메타데이터를 복제하기 위한 빌더 입력이다.
pub(crate) struct DrawingParts<'a> {
    pub id: &'a JsString,
    pub panel: &'a JsString,
    pub locked: Option<bool>,
    pub style: Option<Arc<DrawingStyle>>,
    pub kind: DrawingType,
    pub points: Arc<DrawingPoints>,
    pub text: Option<&'a JsString>,
    pub visible: Option<bool>,
    pub axis_id: Option<&'a JsString>,
    pub series_id: Option<&'a JsString>,
}

impl Drawing {
    /// 이 레코드 metadata lease가 연결된 엔진 context다.
    pub(crate) fn memory_context(&self) -> &MemoryContext {
        self._memory.context()
    }

    /// 기존 단위 테스트가 완성된 parts로 드로잉을 만드는 비회계 wrapper다.
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts_unaccounted(
        id: &JsString,
        panel: &JsString,
        locked: Option<bool>,
        style: Option<Arc<DrawingStyle>>,
        kind: DrawingType,
        points: Arc<DrawingPoints>,
        text: Option<&JsString>,
        visible: Option<bool>,
        axis_id: Option<&JsString>,
        series_id: Option<&JsString>,
    ) -> Self {
        Self::try_from_parts(
            DrawingParts {
                id,
                panel,
                locked,
                style,
                kind,
                points,
                text,
                visible,
                axis_id,
                series_id,
            },
            &MemoryContext::unaccounted(OomStyle::RangeErrorCapitalized),
        )
        .expect("unaccounted drawing construction")
    }

    /// 빌린 메타데이터를 지정 엔진 account에 fallible 복제해 불변 레코드를 만든다.
    pub(crate) fn try_from_parts(
        parts: DrawingParts<'_>,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        let mut scope = memory.scope();
        scope.try_grow(size_of::<Self>()).map_err(memory_error)?;
        let id = parts
            .id
            .try_clone_scoped(&mut scope)
            .map_err(memory_error)?;
        let panel = parts
            .panel
            .try_clone_scoped(&mut scope)
            .map_err(memory_error)?;
        let text = clone_optional_text(parts.text, &mut scope)?;
        let axis_id = clone_optional_text(parts.axis_id, &mut scope)?;
        let series_id = clone_optional_text(parts.series_id, &mut scope)?;
        let requested = usize::try_from(scope.requested_bytes())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        let owner_memory = scope.split_persistent(requested).map_err(memory_error)?;
        Ok(Self {
            id,
            panel,
            locked: parts.locked,
            style: parts.style,
            kind: parts.kind,
            points: parts.points,
            text,
            visible: parts.visible,
            axis_id,
            series_id,
            _memory: owner_memory,
        })
    }

    /// 기존 레코드의 메타데이터를 fallible 복제하고 points/style 공유 소유권을 유지한다.
    pub(crate) fn try_clone_with_memory(&self, memory: &MemoryContext) -> Result<Self, JsError> {
        Self::try_from_parts(
            DrawingParts {
                id: &self.id,
                panel: &self.panel,
                locked: self.locked,
                style: self.style.clone(),
                kind: self.kind,
                points: self.points.clone(),
                text: self.text.as_ref(),
                visible: self.visible,
                axis_id: self.axis_id.as_ref(),
                series_id: self.series_id.as_ref(),
            },
            memory,
        )
    }

    /// 새 ID를 쓰되 points/style 공유 소유권을 유지한 복제 레코드를 만든다.
    pub(crate) fn try_clone_with_id(
        &self,
        id: &JsString,
        memory: &MemoryContext,
    ) -> Result<Self, JsError> {
        Self::try_from_parts(
            DrawingParts {
                id,
                panel: &self.panel,
                locked: self.locked,
                style: self.style.clone(),
                kind: self.kind,
                points: self.points.clone(),
                text: self.text.as_ref(),
                visible: self.visible,
                axis_id: self.axis_id.as_ref(),
                series_id: self.series_id.as_ref(),
            },
            memory,
        )
    }

    /// 드로잉 레코드를 정규 키 순서로 fallible 직렬화한다.
    pub fn to_value_scoped(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let mut entries = scoped_entries(10, scope)?;
        entries.push((
            JsString::try_from_str("id", scope).map_err(memory_error)?,
            JsValue::String(self.id.try_clone_scoped(scope).map_err(memory_error)?),
        ));
        entries.push((
            JsString::try_from_str("panel", scope).map_err(memory_error)?,
            JsValue::String(self.panel.try_clone_scoped(scope).map_err(memory_error)?),
        ));
        if let Some(locked) = self.locked {
            entries.push((
                JsString::try_from_str("locked", scope).map_err(memory_error)?,
                JsValue::Bool(locked),
            ));
        }
        if let Some(style) = &self.style {
            entries.push((
                JsString::try_from_str("style", scope).map_err(memory_error)?,
                style.to_value_scoped(scope)?,
            ));
        }
        entries.push((
            JsString::try_from_str("type", scope).map_err(memory_error)?,
            JsValue::String(
                JsString::try_from_str(self.kind.as_js(), scope).map_err(memory_error)?,
            ),
        ));
        let points_lookup = JsString::try_from_str("points", scope).map_err(memory_error)?;
        entries.push((
            points_lookup
                .try_clone_scoped(scope)
                .map_err(memory_error)?,
            JsValue::Undefined,
        ));
        if let Some(text) = &self.text {
            entries.push((
                JsString::try_from_str("text", scope).map_err(memory_error)?,
                JsValue::String(text.try_clone_scoped(scope).map_err(memory_error)?),
            ));
        }
        if let Some(visible) = self.visible {
            entries.push((
                JsString::try_from_str("visible", scope).map_err(memory_error)?,
                JsValue::Bool(visible),
            ));
        }
        if let Some(axis_id) = &self.axis_id {
            entries.push((
                JsString::try_from_str("axisId", scope).map_err(memory_error)?,
                JsValue::String(axis_id.try_clone_scoped(scope).map_err(memory_error)?),
            ));
        }
        if let Some(series_id) = &self.series_id {
            entries.push((
                JsString::try_from_str("seriesId", scope).map_err(memory_error)?,
                JsValue::String(series_id.try_clone_scoped(scope).map_err(memory_error)?),
            ));
        }
        // 큰 points DOM을 만들기 전에 outer record allocation을 끝낸다.
        let mut record = JsObject::try_from_entries_scoped(entries, scope).map_err(memory_error)?;
        let point_bytes = self
            .points
            .len()
            .checked_mul(size_of::<JsValue>())
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        scope.try_grow(point_bytes).map_err(memory_error)?;
        let mut points = Vec::new();
        points
            .try_reserve_exact(self.points.len())
            .map_err(|_| scope.allocation_failure().into_js_error())?;
        for point in self.points.iter() {
            points.push(point.to_value_scoped(scope)?);
        }
        *record
            .get_mut(&points_lookup)
            .expect("drawing points placeholder exists") = JsValue::Array(points);
        Ok(JsValue::Object(record))
    }

    /// 기존 테스트와 비회계 도구가 쓰는 정규 직렬화 wrapper다.
    pub fn to_value(&self) -> JsValue {
        let mut scope = MemoryScope::unaccounted(OomStyle::RangeErrorCapitalized);
        self.to_value_scoped(&mut scope)
            .expect("unaccounted drawing serialization")
    }

    /// 문자열 길이를 JS UTF-16 코드 단위로 반환한다.
    pub fn text_len_utf16(&self) -> usize {
        self.text.as_ref().map_or(0, JsString::len_utf16)
    }
}

impl PartialEq for Drawing {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.panel == other.panel
            && self.locked == other.locked
            && self.style == other.style
            && self.kind == other.kind
            && self.points == other.points
            && self.text == other.text
            && self.visible == other.visible
            && self.axis_id == other.axis_id
            && self.series_id == other.series_id
    }
}

// 공개 metadata 필드만 밖으로 이동해 lease보다 오래 살 수 없게 한다.
impl Drop for Drawing {
    fn drop(&mut self) {}
}

fn clone_optional_text(
    value: Option<&JsString>,
    scope: &mut MemoryScope,
) -> Result<Option<JsString>, JsError> {
    value
        .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
        .transpose()
}

fn scoped_entries(
    capacity: usize,
    scope: &mut MemoryScope,
) -> Result<Vec<(JsString, JsValue)>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<(JsString, JsValue)>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(entries)
}

fn memory_error(failure: barochart_js::memory::MemoryFailure) -> JsError {
    failure.into_js_error()
}
