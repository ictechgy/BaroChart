//! ChartModel의 순수 configuration/view/panel/axis/series 상태와 검증 계약이다.

#![forbid(unsafe_code)]

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use std::collections::HashSet;

use barochart_js::num::{NumberDialect, js_max, js_min, same_value};
use barochart_js::string::JsString;

use crate::coercion::{js_add_number_with, js_to_number_with};
use crate::contracts::{
    AXIS_KEYS, PANEL_KEYS, RESOURCE_LIMITS, SERIES_KEYS, THEME_KEYS, bounded_text, identifier,
    js_to_string_with, option_record, ordered_record,
};
use crate::data::{BarStore, ChangeKind, DataChange};
use crate::indicator_types::IndicatorDefinition;

const DEFAULT_THEME: [(&str, &str); 7] = [
    ("background", "#0c1320"),
    ("grid", "#1d2a3a"),
    ("text", "#8093ad"),
    ("up", "#35d2ab"),
    ("down", "#fa6c7c"),
    ("crosshair", "#b9c9de"),
    ("font", "12px monospace"),
];

/// 호출 시점의 실제 indicator definition projection이다.
#[derive(Clone, Copy)]
pub struct IndicatorProjection<'a> {
    /// entry id다.
    pub id: &'a JsString,
    /// 실제 immutable definition이다.
    pub definition: &'a IndicatorDefinition,
}

/// 현재 drawing/history/transaction이 참조하는 model binding이다.
#[derive(Clone, Copy, Default)]
pub struct DrawingUsage<'a> {
    /// active transaction 여부다.
    pub transaction_active: bool,
    /// current/undo/redo가 참조하는 panel id다.
    pub panels: &'a [JsString],
    /// current/undo/redo/transaction이 참조하는 axis id다.
    pub axes: &'a [JsString],
    /// 현재 controller target이 참조하는 panel id다.
    pub controller_panel: Option<&'a JsString>,
    /// 현재 controller target이 참조하는 axis id다.
    pub controller_axis: Option<&'a JsString>,
}

/// 실제 InteractionController에서 추출한 mutation guard다.
#[derive(Clone, Copy, Debug, Default)]
pub struct InteractionGuard {
    /// gesture가 있는지 여부다.
    pub gesture_active: bool,
    /// active pointer 수다.
    pub pointer_count: usize,
}

/// 모델 호출이 빌리는 실제 외부 상태다. 어떤 borrow도 모델에 저장하지 않는다.
#[derive(Clone, Copy)]
pub struct ModelContext<'a> {
    /// 실제 현재 store다.
    pub store: &'a BarStore,
    /// 실제 indicator entry projection들이다.
    pub indicators: &'a [IndicatorProjection<'a>],
    /// 실제 drawing usage다.
    pub drawings: DrawingUsage<'a>,
    /// 실제 interaction guard다.
    pub interaction: InteractionGuard,
}

impl<'a> ModelContext<'a> {
    /// 외부 binding이 없는 기본 context다.
    pub fn plain(store: &'a BarStore) -> Self {
        Self {
            store,
            indicators: &[],
            drawings: DrawingUsage::default(),
            interaction: InteractionGuard::default(),
        }
    }

    fn indicator(&self, id: &JsString) -> Option<&'a IndicatorDefinition> {
        self.indicators
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.definition)
    }
}

/// model visible range다.
#[derive(Clone, Copy, Debug)]
pub struct VisibleRange {
    /// 왼쪽 fractional index다.
    pub from: f64,
    /// 오른쪽 fractional index다.
    pub to: f64,
}

/// 검증·정규화한 panel record다.
#[derive(Clone, Debug)]
pub struct Panel {
    record: JsValue,
    /// id다.
    pub id: JsString,
    /// layout weight다.
    pub weight: f64,
    /// scale 이름이다.
    pub scale: JsString,
    /// 반전 여부다.
    pub inverted: bool,
    /// padding이다.
    pub padding: f64,
    /// axis strip 표시 여부다.
    pub axis_visible: bool,
    /// axis strip 방향이다.
    pub axis_side: JsString,
}

impl Panel {
    /// source key order의 record 복사본이다.
    pub fn to_js_value(&self) -> JsValue {
        self.record.clone()
    }
}

/// 검증·정규화한 independent axis record다.
#[derive(Clone, Debug)]
pub struct Axis {
    record: JsValue,
    /// id다.
    pub id: JsString,
    /// 소속 panel id다.
    pub panel: JsString,
    /// 좌우 side다.
    pub side: JsString,
    /// 표시 여부다.
    pub visible: bool,
    /// strip width다.
    pub width: Option<f64>,
}

impl Axis {
    /// source key order의 record 복사본이다.
    pub fn to_js_value(&self) -> JsValue {
        self.record.clone()
    }
}

/// renderer series 종류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeriesKind {
    /// Candles.
    Candles,
    /// OHLC.
    Ohlc,
    /// Line.
    Line,
    /// Area.
    Area,
    /// Histogram.
    Histogram,
}

/// 검증·정규화한 series와 계산 cache metadata다.
#[derive(Clone, Debug)]
pub struct Series {
    record: JsValue,
    /// id다.
    pub id: JsString,
    /// panel id다.
    pub panel: JsString,
    /// optional axis id다.
    pub axis_id: Option<JsString>,
    /// series 종류다.
    pub kind: SeriesKind,
    /// optional indicator id다.
    pub indicator: Option<JsString>,
    /// optional named output이다.
    pub output: Option<JsString>,
    /// plot offset f64다.
    pub offset: f64,
    /// visible false 여부를 포함한 표시 상태다.
    pub visible: bool,
    /// 외부 aligned values 소유 복사다.
    pub values: Option<Vec<f64>>,
    /// 이 Series의 외부 값 교체 revision이다.
    pub values_revision: Option<f64>,
    /// range cache를 다시 만들 첫 index다.
    pub dirty_from: f64,
    /// 계산 revision cache다.
    pub revision: Option<f64>,
    /// range index가 설치됐는지 나타내는 metadata다.
    pub range_index_ready: bool,
}

impl Series {
    /// runtime cache와 borrowed external values를 제외한 source key order record다.
    pub fn to_js_value(&self) -> JsValue {
        let mut value = self.record.clone();
        if let JsValue::Object(record) = &mut value {
            record.remove(&JsString::from_str("values"));
        }
        value
    }

    /// Root runtime이 typed attachment identity를 연결할 때 쓰는 내부 record 복사다.
    pub fn raw_record(&self) -> JsValue {
        self.record.clone()
    }
}

/// Panel 제거 뒤 Root controller가 처리할 instruction이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanelRemoval {
    /// drawing target이 이 panel을 가리키면 지워야 한다.
    pub clear_controller_target: bool,
}

/// Axis 제거 뒤 Root controller가 처리할 instruction이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AxisRemoval {
    /// drawing target이 이 axis를 가리키면 지워야 한다.
    pub clear_controller_target: bool,
}

/// Indicator placement 결과다.
#[derive(Clone, Debug)]
pub struct PlacementReceipt {
    /// 변경한 bound series 수다.
    pub changed: usize,
    /// 대상 panel이다.
    pub panel: JsString,
    /// 대상 axis다.
    pub axis_id: Option<JsString>,
    /// source series 순서의 모든 bound id다.
    pub bound_ids: Vec<JsString>,
}

/// ChartModel이 직접 소유하는 순수 상태다.
#[derive(Clone, Debug)]
pub struct ModelState {
    theme: JsValue,
    /// panel painter 순서다.
    pub panels: Vec<Panel>,
    /// independent axes다.
    pub axes: Vec<Axis>,
    /// series painter 순서다.
    pub series: Vec<Series>,
    /// 현재 visible range다.
    pub view: VisibleRange,
    /// live-follow 여부다.
    pub follow: bool,
    /// 기본 axis width다.
    pub axis_width: f64,
    /// 기본 가격 precision이다.
    pub precision: u8,
    series_values_revision: Option<f64>,
}

impl ModelState {
    /// 실제 store 길이와 constructor options로 model state를 만든다.
    pub fn new(store: &BarStore, options: &JsValue) -> Result<Self, JsError> {
        let object = model_options(options)?;
        let panels = defaulted_property(&object, "panels", default_panels);
        let axes = defaulted_property(&object, "axes", empty_array);
        let visible_bars = default_number(property(&object, "visibleBars"), 200.0);
        let axis_width = default_number(property(&object, "axisWidth"), 82.0);
        let precision = default_number(property(&object, "precision"), 2.0);
        let panel_count = match &panels {
            JsValue::Array(values) => values.len(),
            _ => 0,
        };
        if panel_count == 0
            || !axis_width.is_finite()
            || axis_width < 20.0
            || !visible_bars.is_finite()
            || visible_bars < 1.0
            || !precision.is_finite()
            || precision.fract() != 0.0
            || !(0.0..=18.0).contains(&precision)
        {
            return Err(range_error("Panels, width, visible bars or precision"));
        }
        let theme_input = defaulted_property(&object, "theme", empty_object);
        let theme = theme(&theme_input)?;
        let mut model = Self {
            theme,
            panels: Vec::new(),
            axes: Vec::new(),
            series: Vec::new(),
            axis_width,
            precision: precision as u8,
            view: VisibleRange {
                from: js_max(&[-0.5, store.length() as f64 - visible_bars - 0.5]),
                to: js_max(&[visible_bars - 0.5, store.length() as f64 - 0.5]),
            },
            follow: true,
            series_values_revision: None,
        };
        let JsValue::Array(panels) = &panels else {
            return Err(range_error("Panels, width, visible bars or precision"));
        };
        let context = ModelContext::plain(store);
        for panel in panels {
            model.add_panel(panel, &context)?;
        }
        let JsValue::Array(axes) = &axes else {
            return Err(type_error("Axes array required"));
        };
        for axis in axes {
            model.add_axis(axis, &context)?;
        }
        Ok(model)
    }

    /// arbitrary legacy theme를 ordered JsValue로 복사한다.
    pub fn theme(&self) -> &JsValue {
        &self.theme
    }

    /// Panel을 source validation 순서로 추가한다.
    pub fn add_panel(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        option_record(options, PANEL_KEYS, "Panel")?;
        let object = object_ref(options, "Panel: object required")?;
        let id = identifier_field(object, "id", "Panel id")?;
        if self.panels.len() >= RESOURCE_LIMITS.max_panels as usize {
            return Err(range_error("Panel limit"));
        }
        let weight = nullish_number(property(object, "weight"), 1.0);
        if self.panels.iter().any(|panel| panel.id == id) || !weight.is_finite() || weight <= 0.0 {
            return Err(error("Unique panel id and positive weight"));
        }
        let record = defaulted_record(
            &[
                ("weight", JsValue::Number(1.0)),
                ("scale", string("linear")),
                ("inverted", JsValue::Bool(false)),
                ("padding", JsValue::Number(0.08)),
            ],
            options,
            PANEL_KEYS,
        )?;
        let panel = validate_panel_record(&record)?;
        if context.drawings.transaction_active {
            return Err(error("Panel layout change during drawing transaction"));
        }
        let id = panel.id.clone();
        self.panels.push(panel);
        Ok(id)
    }

    /// 기존 Panel을 원자적으로 검증·교체한다.
    pub fn set_panel(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<(), JsError> {
        let allowed: Vec<&str> = PANEL_KEYS
            .iter()
            .copied()
            .filter(|key| *key != "id")
            .collect();
        option_record(patch, &allowed, "Panel patch")?;
        let Some(index) =
            string_value(id).and_then(|id| self.panels.iter().position(|panel| panel.id == *id))
        else {
            return Err(error("Missing panel"));
        };
        let record = merged_record(&self.panels[index].record, patch, PANEL_KEYS)?;
        let next = validate_panel_record(&record)?;
        if context.drawings.transaction_active {
            let previous = &self.panels[index];
            let projection = record_fields_changed(
                &previous.record,
                &next.record,
                &[
                    "scale",
                    "inverted",
                    "padding",
                    "range",
                    "base",
                    "axisVisible",
                    "axisSide",
                ],
            );
            let weight = record_fields_changed(&previous.record, &next.record, &["weight"]);
            let mut panels = self.panels.clone();
            panels[index] = next.clone();
            let margins = axis_strip_widths(&self.panels, &self.axes, self.axis_width)
                != axis_strip_widths(&panels, &self.axes, self.axis_width);
            let drawing = context
                .drawings
                .panels
                .iter()
                .any(|panel| panel == &previous.id);
            if weight || margins || projection && drawing {
                return Err(error("Panel projection change during drawing transaction"));
            }
        }
        self.panels[index] = next;
        Ok(())
    }

    /// 모든 현재 Panel id를 정확히 한 번 포함하는 새 painter 순서를 적용한다.
    pub fn set_panel_order(
        &mut self,
        ids: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<bool, JsError> {
        let JsValue::Array(ids) = ids else {
            return Err(type_error("Panel order dense array required"));
        };
        if ids.len() > RESOURCE_LIMITS.max_panels as usize {
            return Err(type_error("Panel order dense array required"));
        }
        if ids.len() != self.panels.len() {
            return Err(type_error(
                "Panel order must contain every current panel exactly once",
            ));
        }
        let mut seen = HashSet::with_capacity(ids.len());
        let mut order = Vec::with_capacity(ids.len());
        for value in ids {
            let id = identifier(value, "Panel order id")?.clone();
            if !seen.insert(id.clone()) {
                return Err(error(
                    "Panel order must contain every current panel exactly once",
                ));
            }
            let Some(index) = self.panels.iter().position(|panel| panel.id == id) else {
                return Err(error(
                    "Panel order must contain every current panel exactly once",
                ));
            };
            order.push(index);
        }
        let changed = order
            .iter()
            .enumerate()
            .any(|(position, index)| position != *index);
        reject_layout_interaction(context, true)?;
        if changed && context.drawings.transaction_active {
            return Err(error("Panel layout change during drawing transaction"));
        }
        if changed {
            let previous = self.panels.clone();
            self.panels = order
                .into_iter()
                .map(|index| previous[index].clone())
                .collect();
        }
        Ok(changed)
    }

    /// 참조되지 않는 Panel을 제거한다.
    pub fn remove_panel(
        &mut self,
        id: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<PanelRemoval, JsError> {
        let id = identifier(id, "Panel id")?.clone();
        reject_layout_interaction(context, true)?;
        let Some(index) = self.panels.iter().position(|panel| panel.id == id) else {
            return Err(error("Missing panel"));
        };
        if self.panels.len() == 1 {
            return Err(error("Cannot remove the last panel"));
        }
        if self.series.iter().any(|series| series.panel == id) {
            return Err(error("Panel is referenced by series"));
        }
        if self.axes.iter().any(|axis| axis.panel == id) {
            return Err(error("Panel is referenced by axis"));
        }
        if context.drawings.transaction_active {
            return Err(error(
                "Panel is referenced by an active drawing transaction",
            ));
        }
        if context.drawings.panels.iter().any(|panel| panel == &id) {
            return Err(error("Panel is referenced by drawing history"));
        }
        self.panels.remove(index);
        Ok(PanelRemoval {
            clear_controller_target: context.drawings.controller_panel == Some(&id),
        })
    }

    /// independent Axis를 추가한다.
    pub fn add_axis(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        option_record(options, AXIS_KEYS, "Axis")?;
        let object = object_ref(options, "Axis: object required")?;
        if self.axes.len() >= RESOURCE_LIMITS.max_axes as usize {
            return Err(range_error("Axis limit"));
        }
        if let Some(id) = string_value(property_or_undefined(object, "id"))
            && self.axes.iter().any(|axis| axis.id == *id)
        {
            return Err(error("Duplicate axis"));
        }
        let record = defaulted_record(
            &[
                ("side", string("right")),
                ("scale", string("linear")),
                ("inverted", JsValue::Bool(false)),
                ("padding", JsValue::Number(0.08)),
                ("visible", JsValue::Bool(true)),
                ("tickFormat", string("fixed")),
            ],
            options,
            AXIS_KEYS,
        )?;
        let axis = validate_axis_record(&record, &self.panels)?;
        if context.drawings.transaction_active {
            let mut axes = self.axes.clone();
            axes.push(axis.clone());
            if axis_strip_widths(&self.panels, &self.axes, self.axis_width)
                != axis_strip_widths(&self.panels, &axes, self.axis_width)
            {
                return Err(error("Axis layout change during drawing transaction"));
            }
        }
        let id = axis.id.clone();
        self.axes.push(axis);
        Ok(id)
    }

    /// 기존 independent Axis를 원자적으로 교체한다.
    pub fn set_axis(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<(), JsError> {
        let allowed: Vec<&str> = AXIS_KEYS
            .iter()
            .copied()
            .filter(|key| !matches!(*key, "id" | "panel"))
            .collect();
        option_record(patch, &allowed, "Axis patch")?;
        let Some(index) =
            string_value(id).and_then(|id| self.axes.iter().position(|axis| axis.id == *id))
        else {
            return Err(error("Missing axis"));
        };
        let record = merged_record(&self.axes[index].record, patch, AXIS_KEYS)?;
        let next = validate_axis_record(&record, &self.panels)?;
        if context.drawings.transaction_active {
            let previous = &self.axes[index];
            let mut axes = self.axes.clone();
            axes[index] = next.clone();
            let margins = axis_strip_widths(&self.panels, &self.axes, self.axis_width)
                != axis_strip_widths(&self.panels, &axes, self.axis_width);
            let projection = record_fields_changed(
                &previous.record,
                &next.record,
                &[
                    "scale", "inverted", "padding", "range", "base", "width", "side", "visible",
                ],
            );
            let drawing = context
                .drawings
                .axes
                .iter()
                .any(|axis| axis == &previous.id);
            if margins || projection && drawing {
                return Err(error("Axis projection change during drawing transaction"));
            }
        }
        self.axes[index] = next;
        Ok(())
    }

    /// Series/drawing이 참조하지 않는 Axis를 제거한다. Unknown id는 JS처럼 no-op이다.
    pub fn remove_axis(
        &mut self,
        id: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<AxisRemoval, JsError> {
        let id = identifier(id, "Axis id")?.clone();
        if self
            .series
            .iter()
            .any(|series| series.axis_id.as_ref() == Some(&id))
            || context.drawings.axes.iter().any(|axis| axis == &id)
        {
            return Err(error(
                "Axis is referenced by series or drawing history/transaction",
            ));
        }
        let next: Vec<Axis> = self
            .axes
            .iter()
            .filter(|axis| axis.id != id)
            .cloned()
            .collect();
        let layout_change = axis_strip_widths(&self.panels, &self.axes, self.axis_width)
            != axis_strip_widths(&self.panels, &next, self.axis_width);
        if context.drawings.transaction_active && layout_change {
            return Err(error("Axis layout change during drawing transaction"));
        }
        reject_layout_interaction(context, layout_change)?;
        self.axes = next;
        Ok(AxisRemoval {
            clear_controller_target: context.drawings.controller_axis == Some(&id),
        })
    }

    /// Drawing target의 panel/axis/series binding을 현재 model에 대조한다.
    pub fn validate_drawing_binding(
        &self,
        drawing: &JsValue,
        allow_orphan_series: bool,
    ) -> Result<bool, JsError> {
        let object = object_ref(drawing, "Drawing binding object required")?;
        let panel_value = property_or_undefined(object, "panel");
        if !matches!(panel_value, JsValue::Undefined) {
            identifier(panel_value, "Drawing panel")?;
        }
        for (key, label) in [
            ("axisId", "Drawing axisId"),
            ("seriesId", "Drawing seriesId"),
        ] {
            let value = property_or_undefined(object, key);
            if !matches!(value, JsValue::Undefined | JsValue::Null) {
                identifier(value, label)?;
            }
        }
        let default_panel = JsString::from_str("price");
        let panel = match panel_value {
            JsValue::String(value) => value,
            JsValue::Undefined | JsValue::Null => &default_panel,
            _ => unreachable!("identifier rejected a defined non-string panel"),
        };
        if !self.panels.iter().any(|candidate| candidate.id == *panel) {
            return Err(error("Missing drawing panel"));
        }
        let axis = optional_string(property_or_undefined(object, "axisId"));
        if let Some(axis) = axis
            && !self.axes.iter().any(|candidate| {
                candidate.id == *axis
                    && matches!(panel_value, JsValue::String(value) if candidate.panel == *value)
            })
        {
            return Err(error("Missing drawing axis binding"));
        }
        if !allow_orphan_series
            && let Some(series_id) = optional_string(property_or_undefined(object, "seriesId"))
        {
            let bound_panel = string_value(panel_value);
            let valid = self.series.iter().any(|series| {
                series.id == *series_id
                    && bound_panel.is_some_and(|panel| series.panel == *panel)
                    && series.axis_id.as_ref() == axis
            });
            if !valid {
                return Err(error("Missing or mismatched drawing series binding"));
            }
        }
        Ok(true)
    }

    /// Indicator에 묶인 모든 Series의 panel/axis placement를 한 번에 바꾼다.
    pub fn set_indicator_placement(
        &mut self,
        id: &JsValue,
        placement: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<PlacementReceipt, JsError> {
        let id = identifier(id, "Indicator id")?.clone();
        if context.indicator(&id).is_none() {
            return Err(error("Missing indicator"));
        }
        let bound: Vec<usize> = self
            .series
            .iter()
            .enumerate()
            .filter_map(|(index, series)| (series.indicator.as_ref() == Some(&id)).then_some(index))
            .collect();
        if bound.is_empty() {
            return Err(error("Indicator has no bound series"));
        }
        let object = object_ref(placement, "Indicator placement record required")?;
        if object
            .iter()
            .any(|(key, _)| !text_is(key, "panel") && !text_is(key, "axisId"))
        {
            return Err(type_error("Indicator placement fields"));
        }
        if property(object, "panel").is_none() {
            return Err(type_error("Indicator placement panel required"));
        }
        let panel = identifier(
            property_or_undefined(object, "panel"),
            "Indicator placement panel",
        )?
        .clone();
        let axis_id = match property_or_undefined(object, "axisId") {
            JsValue::Undefined | JsValue::Null => None,
            value => Some(identifier(value, "Indicator placement axis")?.clone()),
        };
        if !self.panels.iter().any(|candidate| candidate.id == panel) {
            return Err(error("Missing placement panel"));
        }
        if let Some(axis_id) = &axis_id
            && !self
                .axes
                .iter()
                .any(|axis| axis.id == *axis_id && axis.panel == panel)
        {
            return Err(error("Missing placement axis"));
        }
        reject_layout_interaction(context, true)?;
        if context.drawings.transaction_active {
            // JS owner guard는 호출 시작부터 있던 transaction을 명시적 transaction
            // 검사보다 먼저 stale owner로 분류한다. 이 DTO는 call-entry snapshot이므로
            // 중간 reentry로 새 transaction이 생긴 별도 경로를 표현하지 않는다.
            return Err(stale_error("Indicator placement owner changed"));
        }
        let changed = bound
            .iter()
            .filter(|index| {
                let series = &self.series[**index];
                series.panel != panel || series.axis_id != axis_id
            })
            .count();
        let bound_ids = bound
            .iter()
            .map(|index| self.series[*index].id.clone())
            .collect();
        if changed > 0 {
            for index in bound {
                let series = &mut self.series[index];
                series.panel = panel.clone();
                series.axis_id = axis_id.clone();
                let mut patch = JsObject::new();
                patch.insert(JsString::from_str("panel"), JsValue::String(panel.clone()));
                patch.insert(
                    JsString::from_str("axisId"),
                    axis_id
                        .as_ref()
                        .map_or(JsValue::Null, |axis| JsValue::String(axis.clone())),
                );
                series.record =
                    merged_record(&series.record, &JsValue::Object(patch), SERIES_KEYS)?;
            }
        }
        Ok(PlacementReceipt {
            changed,
            panel,
            axis_id,
            bound_ids,
        })
    }

    /// Series options를 검증·정규화하되 model에는 게시하지 않는다.
    pub fn normalized_series(
        &self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<Series, JsError> {
        normalize_series(options, None, self, context)
    }

    /// Series를 검증·정규화해 painter 순서 끝에 추가한다.
    pub fn add_series(
        &mut self,
        options: &JsValue,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(options, None, context)
    }

    /// FFI가 별도 typed-F64 attachment로 받은 외부 값을 포함해 Series를 추가한다.
    pub fn add_series_with_values(
        &mut self,
        options: &JsValue,
        values: Vec<f64>,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        self.add_series_owned(options, Some(values), context)
    }

    fn add_series_owned(
        &mut self,
        options: &JsValue,
        values: Option<Vec<f64>>,
        context: &ModelContext<'_>,
    ) -> Result<JsString, JsError> {
        if self.series.len() >= RESOURCE_LIMITS.max_series as usize {
            return Err(range_error("Series limit"));
        }
        if let JsValue::Object(object) = options
            && let Some(id) = string_value(property_or_undefined(object, "id"))
            && self.series.iter().any(|series| series.id == *id)
        {
            return Err(error("Duplicate series"));
        }
        let series = normalize_series(options, values, self, context)?;
        let id = series.id.clone();
        self.series.push(series);
        Ok(id)
    }

    /// id가 같은 Series를 제거한다. JS 저수준 메서드처럼 id 자체는 검증하지 않는다.
    pub fn remove_series(&mut self, id: &JsValue) {
        let Some(id) = string_value(id) else {
            return;
        };
        self.series.retain(|series| series.id != *id);
    }

    /// 일반 non-indicator Series의 aligned 외부 값을 소유 교체한다.
    pub fn set_series_values(
        &mut self,
        id: &JsValue,
        values: Vec<f64>,
        store: &BarStore,
    ) -> Result<(), JsError> {
        let Some(id) = string_value(id) else {
            return Err(type_error("Aligned values and existing series required"));
        };
        let Some(series) = self.series.iter_mut().find(|series| series.id == *id) else {
            return Err(type_error("Aligned values and existing series required"));
        };
        if values.len() != store.length() {
            return Err(type_error("Aligned values and existing series required"));
        }
        if matches!(series.kind, SeriesKind::Candles | SeriesKind::Ohlc)
            || series.indicator.is_some()
        {
            return Err(type_error(
                "External values require a general non-indicator series",
            ));
        }
        let mut patch = JsObject::new();
        patch.insert(
            JsString::from_str("values"),
            JsValue::Array(values.iter().copied().map(JsValue::Number).collect()),
        );
        series.record = merged_record(&series.record, &JsValue::Object(patch), SERIES_KEYS)?;
        series.values = Some(values);
        series.dirty_from = 0.0;
        series.revision = None;
        series.range_index_ready = false;
        series.values_revision = Some(series.values_revision.unwrap_or(0.0) + 1.0);
        self.series_values_revision = Some(self.series_values_revision.unwrap_or(0.0) + 1.0);
        Ok(())
    }

    /// 외부 값 교체의 model-wide revision이다.
    pub fn series_values_revision(&self) -> Option<f64> {
        self.series_values_revision
    }

    /// Root store listener가 commit 뒤 전달하는 view/cache 효과를 적용한다.
    pub fn on_store_change(&mut self, store: &BarStore, change: &DataChange) {
        if change.kind == ChangeKind::Compact {
            return;
        }
        if change.kind == ChangeKind::Prepend
            && change.added.is_some_and(|added| store.length() > added)
        {
            let added = change.added.unwrap_or(0) as f64;
            self.view.from += added;
            self.view.to += added;
        } else if change.kind == ChangeKind::Reset {
            self.fit(store);
        }
        let appended = change.appended.unwrap_or(0);
        if (change.kind == ChangeKind::Append
            || change.kind == ChangeKind::Batch && appended > 0
            || change.kind == ChangeKind::Prepend
                && change
                    .added
                    .is_some_and(|added| added > 0 && store.length() == added))
            && self.follow
        {
            let span = self.view.to - self.view.from;
            self.view.to = store.length() as f64 + self.forward_offset() - 0.5;
            self.view.from = self.view.to - span;
        }
        for series in &mut self.series {
            series.dirty_from = js_min(&[series.dirty_from, change.from as f64]);
        }
    }

    /// 검증이 끝난 compaction series cache restart를 실패 없이 게시한다.
    pub fn publish_compaction_caches(&mut self) {
        for series in &mut self.series {
            series.range_index_ready = false;
            series.revision = None;
            series.dirty_from = 0.0;
        }
    }

    /// Store publication과 같은 commit 구간에서 compaction view를 설치한다.
    pub fn publish_compaction_view(&mut self, view: VisibleRange) {
        self.view = view;
    }

    /// visible series의 가장 큰 양수/음수 offset에 대해 JS Math.max 규칙을 쓴다.
    pub fn forward_offset(&self) -> f64 {
        let mut offsets = Vec::with_capacity(self.series.len() + 1);
        offsets.push(0.0);
        offsets.extend(
            self.series
                .iter()
                .filter(|series| series.visible)
                .map(|series| series.offset),
        );
        js_max(&offsets)
    }

    /// visible range를 clamp하고 follow를 다시 계산한다.
    pub fn set_visible_range(
        &mut self,
        store: &BarStore,
        from: &JsValue,
        to: &JsValue,
    ) -> Result<(), JsError> {
        let (JsValue::Number(from), JsValue::Number(to)) = (from, to) else {
            return Err(range_error("Visible range"));
        };
        if !from.is_finite() || !to.is_finite() || to <= from {
            return Err(range_error("Visible range"));
        }
        let n = js_max(&[10.0, store.length() as f64 + self.forward_offset()]);
        let span = js_min(&[n, js_max(&[js_min(&[10.0, n]), to - from])]);
        let start = js_max(&[-0.5, js_min(&[n - 0.5 - span, *from])]);
        self.view = VisibleRange {
            from: start,
            to: start + span,
        };
        self.follow =
            (self.view.to - (store.length() as f64 + self.forward_offset() - 0.5)).abs() < 1.0;
        Ok(())
    }

    /// 전체 store와 future offset을 맞춘다.
    pub fn fit(&mut self, store: &BarStore) {
        let to = js_max(&[9.5, store.length() as f64 + self.forward_offset() - 0.5]);
        self.set_visible_range(store, &JsValue::Number(-0.5), &JsValue::Number(to))
            .expect("fit creates a valid range");
    }

    /// factor와 JS Number-coerced anchor로 확대/축소한다.
    pub fn zoom(
        &mut self,
        store: &BarStore,
        factor: &JsValue,
        anchor: Option<&JsValue>,
    ) -> Result<(), JsError> {
        let JsValue::Number(factor) = factor else {
            return Err(range_error("Zoom factor"));
        };
        if !factor.is_finite() || *factor <= 0.0 {
            return Err(range_error("Zoom factor"));
        }
        let anchor = js_to_number_with(
            anchor.unwrap_or(&JsValue::Number(0.5)),
            NumberDialect::PLATFORM,
        )?;
        let anchor = js_max(&[0.0, js_min(&[1.0, anchor])]);
        let span = self.view.to - self.view.from;
        let at = self.view.from + span * anchor;
        let next = span * factor;
        self.set_visible_range(
            store,
            &JsValue::Number(at - next * anchor),
            &JsValue::Number(at + next * (1.0 - anchor)),
        )
    }

    /// JS `+` 의미에서 숫자로 남는 delta만 pan에 허용한다.
    pub fn pan(&mut self, store: &BarStore, delta: &JsValue) -> Result<(), JsError> {
        let from = js_add_number_with(self.view.from, delta, NumberDialect::PLATFORM)?;
        let to = js_add_number_with(self.view.to, delta, NumberDialect::PLATFORM)?;
        self.set_visible_range(store, &from, &to)
    }

    /// source key order의 모델 configuration snapshot이다.
    pub fn snapshot(&self) -> JsValue {
        object([
            (
                "view",
                object([
                    ("from", JsValue::Number(self.view.from)),
                    ("to", JsValue::Number(self.view.to)),
                ]),
            ),
            ("theme", self.theme.clone()),
            (
                "panels",
                JsValue::Array(self.panels.iter().map(Panel::to_js_value).collect()),
            ),
            (
                "axes",
                JsValue::Array(self.axes.iter().map(Axis::to_js_value).collect()),
            ),
            (
                "series",
                JsValue::Array(self.series.iter().map(Series::to_js_value).collect()),
            ),
            ("axisWidth", JsValue::Number(self.axis_width)),
            ("precision", JsValue::Number(f64::from(self.precision))),
            ("follow", JsValue::Bool(self.follow)),
        ])
    }
}

#[derive(Clone)]
struct PanelFields {
    weight: f64,
    scale: JsString,
    inverted: bool,
    padding: f64,
    axis_visible: bool,
    axis_side: JsString,
}

fn normalize_series(
    options: &JsValue,
    attached_values: Option<Vec<f64>>,
    model: &ModelState,
    context: &ModelContext<'_>,
) -> Result<Series, JsError> {
    option_record(options, SERIES_KEYS, "Series")?;
    let object = object_ref(options, "Series: object required")?;
    let id = identifier_field(object, "id", "Series id")?;
    let panel = identifier_field(object, "panel", "Series panel")?;
    let axis_id = match property_or_undefined(object, "axisId") {
        JsValue::Undefined | JsValue::Null => None,
        value => {
            let axis = identifier(value, "Series axis")?.clone();
            if !model
                .axes
                .iter()
                .any(|candidate| candidate.id == axis && candidate.panel == panel)
            {
                return Err(error("Missing series axis in panel"));
            }
            Some(axis)
        }
    };
    let values_value = property_or_undefined(object, "values");
    let values_present = attached_values.is_some() || truthy(values_value);
    let symbol_value = property_or_undefined(object, "symbolId");
    if !matches!(symbol_value, JsValue::Undefined) {
        identifier(symbol_value, "Series symbol")?;
        if !values_present {
            return Err(type_error(
                "symbolId belongs to externally aligned values; store/indicator series use primary symbol",
            ));
        }
    }
    let label = property_or_undefined(object, "label");
    if !matches!(label, JsValue::Undefined) {
        bounded_text(label, 256, "Series label", false)?;
    }
    for (key, label) in [
        ("color", "color"),
        ("fill", "fill"),
        ("upColor", "upColor"),
        ("downColor", "downColor"),
    ] {
        let value = property_or_undefined(object, key);
        if !matches!(value, JsValue::Undefined | JsValue::Null) {
            bounded_text(value, 128, label, false)?;
        }
    }
    let visible_value = property_or_undefined(object, "visible");
    let width_value = property_or_undefined(object, "width");
    let baseline_value = property_or_undefined(object, "baseline");
    let style_invalid = !matches!(visible_value, JsValue::Undefined | JsValue::Bool(_))
        || defined(width_value)
            && !matches!(width_value, JsValue::Number(value) if value.is_finite() && *value > 0.0 && *value <= 50.0)
        || defined(baseline_value)
            && !matches!(baseline_value, JsValue::Number(value) if value.is_finite());
    if style_invalid {
        return Err(type_error("Series style/visibility"));
    }
    if !model.panels.iter().any(|candidate| candidate.id == panel) {
        return Err(error("Unique series id and existing panel required"));
    }
    let type_value = property_or_undefined(object, "type");
    let kind_name = string_value(type_value);
    let primary_ohlc =
        kind_name.is_some_and(|kind| text_is(kind, "candles") || text_is(kind, "ohlc"));
    let indicator_value = property_or_undefined(object, "indicator");
    let indicator_present = truthy(indicator_value);
    let source_value = property_or_undefined(object, "source");
    if primary_ohlc
        && (indicator_present
            || values_present
            || defined(source_value)
            || !matches!(symbol_value, JsValue::Undefined))
    {
        return Err(type_error("Candles/OHLC use primary store OHLCV"));
    }
    let kind = match kind_name {
        Some(value) if text_is(value, "candles") => SeriesKind::Candles,
        Some(value) if text_is(value, "ohlc") => SeriesKind::Ohlc,
        Some(value) if text_is(value, "line") => SeriesKind::Line,
        Some(value) if text_is(value, "area") => SeriesKind::Area,
        Some(value) if text_is(value, "histogram") => SeriesKind::Histogram,
        _ => return Err(error("Unknown series type")),
    };
    if values_present && indicator_present {
        return Err(type_error(
            "Series chooses external values or indicator output",
        ));
    }
    let values = if let Some(values) = attached_values {
        if values.len() != context.store.length() {
            return Err(type_error("Values must be aligned Float64Array"));
        }
        Some(values)
    } else if values_present {
        return Err(type_error("Values must be aligned Float64Array"));
    } else {
        None
    };
    let (indicator, definition) = if indicator_present {
        let Some(indicator) = string_value(indicator_value).cloned() else {
            let display = js_to_string_with(indicator_value, NumberDialect::PLATFORM)?;
            return Err(error(&format!(
                "Missing indicator: {}",
                display.to_string_lossy()
            )));
        };
        let Some(definition) = context.indicator(&indicator) else {
            return Err(error(&format!(
                "Missing indicator: {}",
                indicator.to_string_lossy()
            )));
        };
        (Some(indicator), Some(definition))
    } else {
        (None, None)
    };
    if defined(source_value)
        && !string_value(source_value).is_some_and(|source| {
            ["time", "open", "high", "low", "close", "volume"]
                .iter()
                .any(|candidate| text_is(source, candidate))
        })
    {
        return Err(type_error("Series source"));
    }
    let output_value = property_or_undefined(object, "output");
    let output = if let Some(definition) = definition {
        if defined(output_value)
            && !string_value(output_value).is_some_and(|output| {
                definition
                    .outputs
                    .iter()
                    .any(|candidate| text_is(output, candidate))
            })
        {
            return Err(error("Missing indicator output"));
        }
        match string_value(output_value) {
            Some(output) if defined(output_value) => Some(output.clone()),
            _ => Some(JsString::from_str(definition.outputs[0])),
        }
    } else {
        None
    };
    let offset_value = property_or_undefined(object, "offset");
    let offset = if nullish(offset_value) {
        definition
            .zip(output.as_ref())
            .map_or(0.0, |(definition, output)| {
                definition
                    .plot_offsets
                    .iter()
                    .find(|candidate| text_is(output, candidate.output))
                    .map_or(0.0, |candidate| candidate.value)
            })
    } else {
        match offset_value {
            JsValue::Number(value) => *value,
            _ => f64::NAN,
        }
    };
    if !offset.is_finite()
        || offset.fract() != 0.0
        || offset.abs() > 10_000.0
        || matches!(kind, SeriesKind::Candles | SeriesKind::Ohlc) && offset != 0.0
    {
        return Err(range_error("Series plot offset"));
    }
    let default_width = if matches!(kind, SeriesKind::Candles | SeriesKind::Ohlc) {
        1.0
    } else {
        1.5
    };
    let mut normalized = defaulted_record(
        &[
            ("color", string("#7898ff")),
            ("width", JsValue::Number(default_width)),
        ],
        options,
        SERIES_KEYS,
    )?;
    let JsValue::Object(normalized_object) = &mut normalized else {
        unreachable!("defaulted record is an object")
    };
    if let Some(values) = &values {
        normalized_object.insert(
            JsString::from_str("values"),
            JsValue::Array(values.iter().copied().map(JsValue::Number).collect()),
        );
    }
    normalized_object.insert(JsString::from_str("offset"), JsValue::Number(offset));
    normalized = ordered_record(&normalized, SERIES_KEYS)?;
    Ok(Series {
        record: normalized,
        id,
        panel,
        axis_id,
        kind,
        indicator,
        output,
        offset,
        visible: !matches!(visible_value, JsValue::Bool(false)),
        values,
        values_revision: None,
        dirty_from: 0.0,
        revision: None,
        range_index_ready: false,
    })
}

fn validate_panel_record(record: &JsValue) -> Result<Panel, JsError> {
    let object = object_ref(record, "Panel: object required")?;
    let id = identifier_field(object, "id", "Panel id")?;
    let fields = validate_panel_fields(object)?;
    Ok(Panel {
        record: ordered_record(record, PANEL_KEYS)?,
        id,
        weight: fields.weight,
        scale: fields.scale,
        inverted: fields.inverted,
        padding: fields.padding,
        axis_visible: fields.axis_visible,
        axis_side: fields.axis_side,
    })
}

fn validate_panel_fields(object: &JsObject) -> Result<PanelFields, JsError> {
    let axis_visible = property_or_undefined(object, "axisVisible");
    let axis_side = property_or_undefined(object, "axisSide");
    if !matches!(axis_visible, JsValue::Undefined | JsValue::Bool(_))
        || defined(axis_side)
            && !string_value(axis_side)
                .is_some_and(|value| text_is(value, "left") || text_is(value, "right"))
    {
        return Err(type_error("Panel axis visibility/side"));
    }
    let inverted = property_or_undefined(object, "inverted");
    let label = property_or_undefined(object, "label");
    let formatter = property_or_undefined(object, "formatter");
    let range = property_or_undefined(object, "range");
    if !matches!(inverted, JsValue::Bool(_))
        || defined(label) && !matches!(label, JsValue::String(_))
        || defined(formatter)
        || truthy(range) && !matches!(range, JsValue::Array(values) if values.len() == 2)
    {
        return Err(type_error("Panel label, inverted, formatter or range"));
    }
    if defined(label) {
        bounded_text(label, 256, "Panel label", false)?;
    }
    let weight = number_or_nan(property_or_undefined(object, "weight"));
    let base = property_or_undefined(object, "base");
    let scale_value = property_or_undefined(object, "scale");
    let padding = number_or_nan(property_or_undefined(object, "padding"));
    let precision = property_or_undefined(object, "precision");
    let range_values = match range {
        JsValue::Array(values) if truthy(range) => Some(values.as_slice()),
        _ => None,
    };
    let numeric_range_invalid = range_values.is_some_and(|values| {
        let left = number_or_nan(&values[0]);
        let right = number_or_nan(&values[1]);
        !left.is_finite()
            || !right.is_finite()
            || left >= right
            || string_value(scale_value).is_some_and(|scale| text_is(scale, "log")) && left <= 0.0
    });
    let numeric_invalid = !weight.is_finite()
        || weight <= 0.0
        || defined(base) && !matches!(base, JsValue::Number(value) if value.is_finite())
        || !string_value(scale_value).is_some_and(|scale| {
            ["linear", "log", "percent"]
                .iter()
                .any(|candidate| text_is(scale, candidate))
        })
        || !padding.is_finite()
        || !(0.0..=1.0).contains(&padding)
        || defined(precision)
            && !matches!(precision, JsValue::Number(value) if value.is_finite() && value.fract() == 0.0 && (0.0..=18.0).contains(value))
        || numeric_range_invalid
        || string_value(scale_value).is_some_and(|scale| text_is(scale, "percent"))
            && matches!(base, JsValue::Number(value) if *value == 0.0);
    if numeric_invalid {
        return Err(range_error("Panel scale/range"));
    }
    let JsValue::Bool(inverted) = inverted else {
        unreachable!("inverted checked above")
    };
    Ok(PanelFields {
        weight,
        scale: string_value(scale_value)
            .expect("scale checked above")
            .clone(),
        inverted: *inverted,
        padding,
        axis_visible: !matches!(axis_visible, JsValue::Bool(false)),
        axis_side: match string_value(axis_side) {
            Some(value) if defined(axis_side) => value.clone(),
            _ => JsString::from_str("right"),
        },
    })
}

fn validate_axis_record(record: &JsValue, panels: &[Panel]) -> Result<Axis, JsError> {
    option_record(record, AXIS_KEYS, "Axis")?;
    let object = object_ref(record, "Axis: object required")?;
    let id = identifier_field(object, "id", "Axis id")?;
    let panel = identifier_field(object, "panel", "Axis panel")?;
    if !panels.iter().any(|candidate| candidate.id == panel) {
        return Err(error("Missing axis panel"));
    }
    let mut inherited = JsObject::new();
    for (key, value) in [
        ("weight", JsValue::Number(1.0)),
        ("scale", string("linear")),
        ("inverted", JsValue::Bool(false)),
        ("padding", JsValue::Number(0.08)),
    ] {
        inherited.insert(JsString::from_str(key), value);
    }
    for key in [
        "scale",
        "inverted",
        "padding",
        "range",
        "base",
        "precision",
        "formatter",
        "label",
    ] {
        let value = property_or_undefined(object, key);
        if defined(value) {
            inherited.insert(JsString::from_str(key), value.clone());
        }
    }
    validate_panel_fields(&inherited)?;
    let side = property_or_undefined(object, "side");
    let visible = property_or_undefined(object, "visible");
    let tick_format = property_or_undefined(object, "tickFormat");
    let width = property_or_undefined(object, "width");
    if !string_value(side).is_some_and(|value| text_is(value, "left") || text_is(value, "right"))
        || !matches!(visible, JsValue::Bool(_))
        || !string_value(tick_format)
            .is_some_and(|value| text_is(value, "fixed") || text_is(value, "scientific"))
        || defined(width)
            && !matches!(width, JsValue::Number(value) if value.is_finite() && (20.0..=256.0).contains(value))
    {
        return Err(type_error("Axis side/visibility/format/width"));
    }
    for (key, label) in [("prefix", "Axis prefix"), ("suffix", "Axis suffix")] {
        let value = property_or_undefined(object, key);
        if defined(value) {
            bounded_text(value, 64, label, true)?;
        }
    }
    let scale = property_or_undefined(object, "scale");
    let base = property_or_undefined(object, "base");
    if string_value(scale).is_some_and(|scale| text_is(scale, "percent"))
        && !matches!(base, JsValue::Number(value) if value.is_finite() && *value != 0.0)
    {
        return Err(range_error(
            "Independent percent axis requires an explicit nonzero base",
        ));
    }
    let JsValue::Bool(visible) = visible else {
        unreachable!("visible checked above")
    };
    Ok(Axis {
        record: ordered_record(record, AXIS_KEYS)?,
        id,
        panel,
        side: string_value(side).expect("side checked above").clone(),
        visible: *visible,
        width: match width {
            JsValue::Number(value) => Some(*value),
            _ => None,
        },
    })
}

fn model_options(options: &JsValue) -> Result<JsObject, JsError> {
    match options {
        JsValue::Object(object) => Ok(object.clone()),
        JsValue::Undefined | JsValue::Bool(_) | JsValue::Number(_) | JsValue::String(_) => {
            Ok(JsObject::new())
        }
        JsValue::Null => Err(type_error("Model options object required")),
        JsValue::Array(_) => Ok(JsObject::new()),
    }
}

fn theme(value: &JsValue) -> Result<JsValue, JsError> {
    option_record(value, THEME_KEYS, "Theme")?;
    let object = object_ref(value, "Theme: object required")?;
    for (_, value) in object.iter() {
        bounded_text(value, 256, "Theme value", false)?;
    }
    let defaults: Vec<(&str, JsValue)> = DEFAULT_THEME
        .iter()
        .map(|(key, value)| (*key, string(value)))
        .collect();
    defaulted_record(&defaults, value, THEME_KEYS)
}

fn default_panels() -> JsValue {
    JsValue::Array(vec![object([
        ("id", string("price")),
        ("weight", JsValue::Number(3.0)),
    ])])
}

fn empty_array() -> JsValue {
    JsValue::Array(Vec::new())
}

fn empty_object() -> JsValue {
    JsValue::Object(JsObject::new())
}

fn defaulted_property(object: &JsObject, key: &str, default: impl FnOnce() -> JsValue) -> JsValue {
    match property(object, key) {
        None | Some(JsValue::Undefined) => default(),
        Some(value) => value.clone(),
    }
}

fn default_number(value: Option<&JsValue>, default: f64) -> f64 {
    match value {
        None | Some(JsValue::Undefined) => default,
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    }
}

fn nullish_number(value: Option<&JsValue>, default: f64) -> f64 {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => default,
        Some(JsValue::Number(value)) => *value,
        _ => f64::NAN,
    }
}

fn defaulted_record(
    defaults: &[(&str, JsValue)],
    overlay: &JsValue,
    keys: &[&str],
) -> Result<JsValue, JsError> {
    let overlay = object_ref(overlay, "Object required")?;
    let mut output = JsObject::new();
    for (key, value) in defaults {
        output.insert(JsString::from_str(key), value.clone());
    }
    for (key, value) in overlay.iter() {
        output.insert(key.clone(), value.clone());
    }
    ordered_record(&JsValue::Object(output), keys)
}

fn merged_record(base: &JsValue, patch: &JsValue, keys: &[&str]) -> Result<JsValue, JsError> {
    let base = object_ref(base, "Object required")?;
    let patch = object_ref(patch, "Object required")?;
    let mut output = JsObject::new();
    for (key, value) in base.iter().chain(patch.iter()) {
        output.insert(key.clone(), value.clone());
    }
    ordered_record(&JsValue::Object(output), keys)
}

fn axis_strip_widths(panels: &[Panel], axes: &[Axis], axis_width: f64) -> (f64, f64) {
    let mut left = 0.0_f64;
    let mut right = 0.0_f64;
    for panel in panels {
        let (mut row_left, mut row_right) = (0.0, 0.0);
        if panel.axis_visible {
            if text_is(&panel.axis_side, "left") {
                row_left = axis_width;
            } else {
                row_right = axis_width;
            }
        }
        for axis in axes
            .iter()
            .filter(|axis| axis.panel == panel.id && axis.visible)
        {
            let width = axis.width.unwrap_or(axis_width);
            if text_is(&axis.side, "left") {
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

fn reject_layout_interaction(context: &ModelContext<'_>, required: bool) -> Result<(), JsError> {
    if required && (context.interaction.gesture_active || context.interaction.pointer_count > 0) {
        return Err(error("Panel layout change during active gesture"));
    }
    Ok(())
}

fn record_fields_changed(left: &JsValue, right: &JsValue, keys: &[&str]) -> bool {
    let (JsValue::Object(left), JsValue::Object(right)) = (left, right) else {
        return true;
    };
    keys.iter().any(|key| {
        !same_js_value(
            property_or_undefined(left, key),
            property_or_undefined(right, key),
        )
    })
}

fn same_js_value(left: &JsValue, right: &JsValue) -> bool {
    match (left, right) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(left), JsValue::Bool(right)) => left == right,
        (JsValue::Number(left), JsValue::Number(right)) => same_value(*left, *right),
        (JsValue::String(left), JsValue::String(right)) => left == right,
        (JsValue::Array(left), JsValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_js_value(left, right))
        }
        (JsValue::Object(left), JsValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right.iter())
                    .all(|((left_key, left), (right_key, right))| {
                        left_key == right_key && same_js_value(left, right)
                    })
        }
        _ => false,
    }
}

fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(value) => *value,
        JsValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsValue::String(value) => !value.as_units().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

fn nullish(value: &JsValue) -> bool {
    matches!(value, JsValue::Undefined | JsValue::Null)
}

fn defined(value: &JsValue) -> bool {
    !matches!(value, JsValue::Undefined)
}

fn number_or_nan(value: &JsValue) -> f64 {
    match value {
        JsValue::Number(value) => *value,
        _ => f64::NAN,
    }
}

fn object_ref<'a>(value: &'a JsValue, message: &str) -> Result<&'a JsObject, JsError> {
    match value {
        JsValue::Object(object) => Ok(object),
        _ => Err(type_error(message)),
    }
}

fn property<'a>(object: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    object.get(&JsString::from_str(key))
}

fn property_or_undefined<'a>(object: &'a JsObject, key: &str) -> &'a JsValue {
    static UNDEFINED: JsValue = JsValue::Undefined;
    property(object, key).unwrap_or(&UNDEFINED)
}

fn identifier_field(object: &JsObject, key: &str, label: &str) -> Result<JsString, JsError> {
    Ok(identifier(property_or_undefined(object, key), label)?.clone())
}

fn string_value(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

fn optional_string(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        JsValue::Undefined | JsValue::Null => None,
        _ => None,
    }
}

fn text_is(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn string(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn object<const N: usize>(values: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in values {
        object.insert(JsString::from_str(key), value);
    }
    JsValue::Object(object)
}

fn error(message: &str) -> JsError {
    JsError::new("Error", JsString::from_str(message))
}

fn stale_error(message: &str) -> JsError {
    JsError::new("StaleSourceError", JsString::from_str(message))
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", JsString::from_str(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", JsString::from_str(message))
}
