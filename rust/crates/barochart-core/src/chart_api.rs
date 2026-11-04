//! 65개 `ChartAPI.dispatch` 명령을 네이티브 합성 소유자에 연결한다.

#![forbid(unsafe_code)]

use std::mem::size_of;

use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::{MemoryContext, MemoryGroup, MemoryScope};
use barochart_js::string::JsString;

use crate::Host;
use crate::compaction::{self, CompactionContext, CompactionError};
use crate::contracts::{SYMBOL_KEYS, option_record, portable_style_scoped};
use crate::data::{BatchReceipt, DataEventValue};
use crate::data_explorer::{
    self, DataAtRequest, DataQueryResult, DataQuerySeries, DataQueryStatus, ExplorerSymbol,
};
use crate::data_input::{
    DataInputError, DataInputMode, NullishBase, apply_data_event_input,
    set_columns_input_with_reply_gate, set_data_input_with_reply_gate,
};
use crate::drawing_document::DrawingDocumentContext;
use crate::drawing_edit::{
    self, DrawingAxisBinding, DrawingBindingContext, DrawingEditContext, DrawingPanelBinding,
    DrawingSeriesBinding,
};
use crate::drawing_validation::copy_drawing_value_scoped;
use crate::drawings::{DrawingSnapshot, DrawingStore};
use crate::indicator_engine::IndicatorPublishReceipt;
use crate::indicator_modules;
use crate::indicator_params_update;
use crate::indicator_query::{self, IndicatorQueryOptions};
use crate::indicator_registry::IndicatorRegistry;
use crate::ingestion::{ApplyDataError, IngestionError};
use crate::interaction::{InteractionContext, OwnedInteractionState};
use crate::markets::{self, Adjustment, Symbol};
use crate::model_state::{ModelContext, Series};
use crate::native_chart::{
    NativeChart, NativeInteractionContext, api_series_options_scoped, numeric_values_with_memory,
};
use crate::study_setup;

macro_rules! chart_operations {
    ($( $variant:ident => ($name:literal, $arity:literal) ),+ $(,)?) => {
        /// JS `COMMANDS`와 같은 source 순서의 명령이다.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum ChartOperation { $( $variant ),+ }

        impl ChartOperation {
            /// 실제 JS Set insertion 순서의 65개 명령이다.
            pub const ALL: &'static [Self] = &[$( Self::$variant ),+];

            /// 공개 명령 문자열이다.
            pub const fn name(self) -> &'static str {
                match self { $( Self::$variant => $name ),+ }
            }

            /// dispatch가 허용하는 최대 argument 수다. 부족한 인자는 undefined다.
            pub const fn max_arity(self) -> usize {
                match self { $( Self::$variant => $arity ),+ }
            }

            /// UTF-16 명령 이름을 정확히 찾는다.
            pub fn parse(name: &JsString) -> Option<Self> {
                Self::ALL.iter().copied().find(|operation| {
                    name.as_units().iter().copied().eq(operation.name().encode_utf16())
                })
            }
        }
    };
}

chart_operations! {
    CompactData => ("compactData", 1),
    SetData => ("setData", 1),
    SetColumns => ("setColumns", 2),
    ApplyDataEvent => ("applyDataEvent", 1),
    ApplyDataEvents => ("applyDataEvents", 1),
    ConfigureDataIngestion => ("configureDataIngestion", 1),
    EnqueueDataEvents => ("enqueueDataEvents", 1),
    DrainDataEvents => ("drainDataEvents", 1),
    PauseDataIngestion => ("pauseDataIngestion", 0),
    ResumeDataIngestion => ("resumeDataIngestion", 0),
    CancelDataEvents => ("cancelDataEvents", 0),
    DataIngestionStats => ("dataIngestionStats", 0),
    SaveDataIngestion => ("saveDataIngestion", 0),
    LoadDataIngestion => ("loadDataIngestion", 1),
    AddPanel => ("addPanel", 1),
    SetPanel => ("setPanel", 2),
    SetPanelOrder => ("setPanelOrder", 1),
    RemovePanel => ("removePanel", 1),
    AddAxis => ("addAxis", 1),
    SetAxis => ("setAxis", 2),
    RemoveAxis => ("removeAxis", 1),
    SetDrawingTarget => ("setDrawingTarget", 1),
    SetDrawingMagnet => ("setDrawingMagnet", 1),
    SetCrosshairSnap => ("setCrosshairSnap", 1),
    CrosshairSnapshot => ("crosshairSnapshot", 2),
    CrosshairValues => ("crosshairValues", 2),
    DataAt => ("dataAt", 2),
    AddSeries => ("addSeries", 1),
    SetSeries => ("setSeries", 2),
    SetSeriesValues => ("setSeriesValues", 2),
    RemoveSeries => ("removeSeries", 1),
    AddIndicator => ("addIndicator", 3),
    SetIndicatorParams => ("setIndicatorParams", 2),
    SetIndicatorPlacement => ("setIndicatorPlacement", 2),
    RemoveIndicator => ("removeIndicator", 1),
    IndicatorValues => ("indicatorValues", 2),
    IndicatorValueAt => ("indicatorValueAt", 4),
    RegisterIndicatorModule => ("registerIndicatorModule", 2),
    SaveStudies => ("saveStudies", 0),
    LoadStudies => ("loadStudies", 1),
    AddDrawing => ("addDrawing", 1),
    PositionMetrics => ("positionMetrics", 1),
    EditDrawing => ("editDrawing", 2),
    TranslateDrawings => ("translateDrawings", 2),
    SetDrawingsStyle => ("setDrawingsStyle", 2),
    SetDrawingVisibility => ("setDrawingVisibility", 2),
    SetDrawingsVisibility => ("setDrawingsVisibility", 2),
    DuplicateDrawing => ("duplicateDrawing", 2),
    DuplicateDrawings => ("duplicateDrawings", 2),
    DeleteDrawings => ("deleteDrawings", 1),
    DeleteDrawing => ("deleteDrawing", 1),
    SelectDrawing => ("selectDrawing", 1),
    SaveDrawings => ("saveDrawings", 0),
    LoadDrawings => ("loadDrawings", 1),
    Undo => ("undo", 0),
    Redo => ("redo", 0),
    SetTool => ("setTool", 1),
    SetText => ("setText", 1),
    SetTheme => ("setTheme", 1),
    SetSymbol => ("setSymbol", 1),
    SetVisibleRange => ("setVisibleRange", 2),
    Fit => ("fit", 0),
    Zoom => ("zoom", 2),
    Pan => ("pan", 1),
    Inspect => ("inspect", 0),
}

/// 현재 facade가 명령을 실행하는 단계다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartOperationStatus {
    /// 현재 data/model/indicator/drawing/layout 코어에 연결됐다.
    Implemented,
    /// M5 interaction owner 없이는 상태를 만들 수 없어 명시적으로 거절한다.
    InteractionPending,
}

impl ChartOperation {
    /// 성공 stub 없이 실제 구현 또는 명시적 단계 거절을 분류한다.
    pub const fn status(self) -> ChartOperationStatus {
        match self {
            Self::SetDrawingTarget
            | Self::SetDrawingMagnet
            | Self::SetCrosshairSnap
            | Self::CrosshairSnapshot
            | Self::CrosshairValues
            | Self::SetTool
            | Self::SetText => ChartOperationStatus::InteractionPending,
            _ => ChartOperationStatus::Implemented,
        }
    }
}

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (name, item) in entries {
        value.insert(key(name), item);
    }
    JsValue::Object(value)
}

fn memory_error(error: barochart_js::memory::MemoryFailure) -> JsError {
    error.into_js_error()
}

fn scoped_vec<T>(capacity: usize, scope: &mut MemoryScope) -> Result<Vec<T>, JsError> {
    let bytes = capacity
        .checked_mul(size_of::<T>())
        .ok_or_else(|| scope.allocation_failure().into_js_error())?;
    scope.try_grow(bytes).map_err(memory_error)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|_| scope.allocation_failure().into_js_error())?;
    Ok(output)
}

fn scoped_object<const N: usize>(
    entries: [(&str, JsValue); N],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut owned = scoped_vec(N, scope)?;
    for (name, value) in entries {
        owned.push((
            JsString::try_from_str(name, scope).map_err(memory_error)?,
            value,
        ));
    }
    JsObject::try_from_entries_scoped(owned, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

fn merge_objects_scoped(
    base: &JsObject,
    patch: &JsObject,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut entries = scoped_vec(base.len().saturating_add(patch.len()), scope)?;
    for (name, value) in base.iter().chain(patch.iter()) {
        entries.push((
            name.try_clone_scoped(scope).map_err(memory_error)?,
            value.try_clone_scoped(scope).map_err(memory_error)?,
        ));
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

fn push_scoped_entry(
    entries: &mut Vec<(JsString, JsValue)>,
    name: &str,
    value: JsValue,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    entries.push((
        JsString::try_from_str(name, scope).map_err(memory_error)?,
        value,
    ));
    Ok(())
}

fn push_cloned_entry(
    entries: &mut Vec<(JsString, JsValue)>,
    name: &JsString,
    value: &JsValue,
    scope: &mut MemoryScope,
) -> Result<(), JsError> {
    entries.push((
        name.try_clone_scoped(scope).map_err(memory_error)?,
        value.try_clone_scoped(scope).map_err(memory_error)?,
    ));
    Ok(())
}

fn symbol_record_scoped(
    source: &JsObject,
    memory: &MemoryContext,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut scratch = memory.scope();
    let mut extra_names = scoped_vec(source.len(), &mut scratch)?;
    for (name, _) in source.iter() {
        if !SYMBOL_KEYS.iter().any(|expected| is_text(name, expected)) {
            extra_names.push(name);
        }
    }
    extra_names.sort_unstable();

    let mut entries = scoped_vec(source.len(), &mut scratch)?;
    for expected in SYMBOL_KEYS {
        if let Some((name, value)) = source.iter().find(|(name, _)| is_text(name, expected)) {
            push_cloned_entry(&mut entries, name, value, scope)?;
        }
    }
    for name in extra_names {
        let value = source.get(name).expect("symbol extra key came from source");
        push_cloned_entry(&mut entries, name, value, scope)?;
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

fn inspect_series_value(series: &Series, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    let JsValue::Object(record) = series.raw_record_ref() else {
        return series
            .raw_record_ref()
            .try_clone_scoped(scope)
            .map_err(memory_error);
    };
    let mut entries = scoped_vec(record.len().saturating_add(1), scope)?;
    for (name, value) in record.iter() {
        if is_text(name, "values") {
            continue;
        }
        entries.push((
            name.try_clone_scoped(scope).map_err(memory_error)?,
            value.try_clone_scoped(scope).map_err(memory_error)?,
        ));
    }
    if let Some(values) = &series.values {
        push_scoped_entry(
            &mut entries,
            "valueCount",
            JsValue::Number(values.len() as f64),
            scope,
        )?;
    }
    JsObject::try_from_entries_scoped(entries, scope)
        .map(JsValue::Object)
        .map_err(memory_error)
}

fn optional_text_scoped(
    value: Option<&JsString>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    value
        .map(|value| {
            value
                .try_clone_scoped(scope)
                .map(JsValue::String)
                .map_err(memory_error)
        })
        .transpose()
        .map(|value| value.unwrap_or(JsValue::Null))
}

fn query_status_text(status: DataQueryStatus) -> &'static str {
    match status {
        DataQueryStatus::OutsideSource => "outside-source",
        DataQueryStatus::AfterCutoff => "after-cutoff",
        DataQueryStatus::UnsupportedCausality => "unsupported-causality",
        DataQueryStatus::UnsupportedCache => "unsupported-cache",
        DataQueryStatus::Pending => "pending",
        DataQueryStatus::Value => "value",
        DataQueryStatus::NonFinite => "non-finite",
    }
}

fn data_query_series_value(
    value: &DataQuerySeries,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    scoped_object(
        [
            (
                "id",
                JsValue::String(value.id.try_clone_scoped(scope).map_err(memory_error)?),
            ),
            (
                "label",
                JsValue::String(value.label.try_clone_scoped(scope).map_err(memory_error)?),
            ),
            (
                "panel",
                JsValue::String(value.panel.try_clone_scoped(scope).map_err(memory_error)?),
            ),
            (
                "axisId",
                optional_text_scoped(value.axis_id.as_ref(), scope)?,
            ),
            (
                "symbolId",
                optional_text_scoped(value.symbol_id.as_ref(), scope)?,
            ),
            ("visible", JsValue::Bool(value.visible)),
            (
                "type",
                JsValue::String(
                    value
                        .series_type
                        .try_clone_scoped(scope)
                        .map_err(memory_error)?,
                ),
            ),
            (
                "kind",
                JsValue::String(value.kind.try_clone_scoped(scope).map_err(memory_error)?),
            ),
            (
                "causality",
                JsValue::String(
                    value
                        .causality
                        .try_clone_scoped(scope)
                        .map_err(memory_error)?,
                ),
            ),
            ("offset", JsValue::Number(value.offset)),
            (
                "source",
                optional_text_scoped(value.source.as_ref(), scope)?,
            ),
            (
                "indicator",
                optional_text_scoped(value.indicator.as_ref(), scope)?,
            ),
            (
                "output",
                optional_text_scoped(value.output.as_ref(), scope)?,
            ),
            ("value", value.value.map_or(JsValue::Null, JsValue::Number)),
            (
                "sourceIndex",
                value.source_index.map_or(JsValue::Null, JsValue::Number),
            ),
            (
                "sourceTime",
                value.source_time.map_or(JsValue::Null, JsValue::Number),
            ),
            (
                "status",
                JsValue::String(
                    JsString::try_from_str(query_status_text(value.status), scope)
                        .map_err(memory_error)?,
                ),
            ),
        ],
        scope,
    )
}

fn data_query_result_value(
    value: &DataQueryResult,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let symbol = value
        .symbol
        .as_ref()
        .map(|symbol| {
            scoped_object(
                [
                    (
                        "id",
                        JsValue::String(symbol.id.try_clone_scoped(scope).map_err(memory_error)?),
                    ),
                    (
                        "currency",
                        JsValue::String(
                            symbol
                                .currency
                                .try_clone_scoped(scope)
                                .map_err(memory_error)?,
                        ),
                    ),
                    (
                        "volumeUnit",
                        JsValue::String(
                            symbol
                                .volume_unit
                                .try_clone_scoped(scope)
                                .map_err(memory_error)?,
                        ),
                    ),
                ],
                scope,
            )
        })
        .transpose()?
        .unwrap_or(JsValue::Null);
    let bar = scoped_object(
        [
            ("time", JsValue::Number(value.bar.time)),
            ("open", JsValue::Number(value.bar.open)),
            ("high", JsValue::Number(value.bar.high)),
            ("low", JsValue::Number(value.bar.low)),
            ("close", JsValue::Number(value.bar.close)),
            ("volume", JsValue::Number(value.bar.volume)),
        ],
        scope,
    )?;
    let primary = scoped_object([("symbol", symbol), ("bar", bar)], scope)?;
    let mut series = scoped_vec(value.series.len(), scope)?;
    for row in &value.series {
        series.push(data_query_series_value(row, scope)?);
    }
    scoped_object(
        [
            ("index", JsValue::Number(value.index)),
            ("time", JsValue::Number(value.time)),
            ("asOfIndex", JsValue::Number(value.as_of_index)),
            ("storeVersion", JsValue::Number(value.store_version)),
            ("primary", primary),
            ("series", JsValue::Array(series)),
        ],
        scope,
    )
}

fn type_error(message: &str) -> JsError {
    JsError::new("TypeError", key(message))
}

fn ordinary_error(message: &str) -> JsError {
    JsError::new("Error", key(message))
}

fn range_error(message: &str) -> JsError {
    JsError::new("RangeError", key(message))
}

fn unavailable(operation: ChartOperation) -> JsError {
    JsError::new(
        "UnavailableError",
        key(&format!(
            "{} is pending the Rust interaction owner",
            operation.name()
        )),
    )
}

static UNDEFINED_ARGUMENT: JsValue = JsValue::Undefined;

fn argument(args: &[JsValue], index: usize) -> &JsValue {
    args.get(index).unwrap_or(&UNDEFINED_ARGUMENT)
}

fn property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(value) => value.get(&key(name)),
        _ => None,
    }
}

fn string(value: &JsValue) -> Option<&JsString> {
    match value {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

fn is_text(value: &JsString, expected: &str) -> bool {
    value.as_units().iter().copied().eq(expected.encode_utf16())
}

fn data_input_error(error: DataInputError) -> JsError {
    match error {
        DataInputError::Js(error) => error,
        DataInputError::NullishPropertyAccess {
            base,
            property,
            expression,
        } => {
            let _ = (property, expression);
            #[cfg(target_os = "android")]
            let message = format!(
                "cannot read property '{}' of {}",
                property,
                match base {
                    NullishBase::Null => "null",
                    NullishBase::Undefined => "undefined",
                }
            );
            #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
            let message = format!(
                "{} is not an object (evaluating '{}')",
                match base {
                    NullishBase::Null => "null",
                    NullishBase::Undefined => "undefined",
                },
                expression
            );
            #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
            let message = format!(
                "Cannot read properties of {} (reading '{}')",
                match base {
                    NullishBase::Null => "null",
                    NullishBase::Undefined => "undefined",
                },
                property
            );
            JsError::new("TypeError", key(&message))
        }
    }
}

fn ingestion_error(error: IngestionError) -> JsError {
    error.into_js_error()
}

fn apply_data_error(error: ApplyDataError) -> JsError {
    let name = match error.name() {
        "TypeError" => "TypeError",
        "RangeError" => "RangeError",
        "IngestionError" => "IngestionError",
        "StaleSourceError" => "StaleSourceError",
        _ => "Error",
    };
    let mut output = JsError::new(name, error.message().clone());
    output.code = error.code().map(str::to_owned);
    output
}

fn compaction_error(error: CompactionError) -> JsError {
    let name = match error.name() {
        "TypeError" => "TypeError",
        "RangeError" => "RangeError",
        "IngestionError" => "IngestionError",
        "StaleSourceError" => "StaleSourceError",
        _ => "Error",
    };
    let mut output = JsError::new(name, error.message().clone());
    output.code = error.code().map(str::to_owned);
    output
}

fn data_event_value(value: DataEventValue) -> JsValue {
    match value {
        DataEventValue::None => JsValue::Null,
        DataEventValue::Index(index) => JsValue::Number(index as f64),
        DataEventValue::Batch(receipt) => receipt.to_js_value(),
    }
}

fn receipt_value(
    receipt: &IndicatorPublishReceipt,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut offset_entries = scoped_vec(receipt.plot_offsets.len(), scope)?;
    for (name, value) in &receipt.plot_offsets {
        offset_entries.push((
            name.try_clone_scoped(scope).map_err(memory_error)?,
            JsValue::Number(*value),
        ));
    }
    let offsets = JsObject::try_from_entries_scoped(offset_entries, scope).map_err(memory_error)?;
    let mut outputs = scoped_vec(receipt.outputs.len(), scope)?;
    for name in &receipt.outputs {
        outputs.push(JsValue::String(
            name.try_clone_scoped(scope).map_err(memory_error)?,
        ));
    }
    scoped_object(
        [
            ("outputs", JsValue::Array(outputs)),
            ("plotOffsets", JsValue::Object(offsets)),
        ],
        scope,
    )
}

fn indicator_read_receipt(
    read: crate::indicator_engine::IndicatorRead<'_>,
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let mut offset_entries = scoped_vec(read.output_names().len(), scope)?;
    for output in read.output_names() {
        let value = read.definition().effective_plot_offset(output);
        if read
            .definition()
            .plot_offsets
            .iter()
            .any(|candidate| candidate.output == *output)
        {
            offset_entries.push((
                JsString::try_from_str(output, scope).map_err(memory_error)?,
                JsValue::Number(value),
            ));
        }
    }
    let offsets = JsObject::try_from_entries_scoped(offset_entries, scope).map_err(memory_error)?;
    let mut outputs = scoped_vec(read.output_names().len(), scope)?;
    for name in read.output_names() {
        outputs.push(JsValue::String(
            JsString::try_from_str(name, scope).map_err(memory_error)?,
        ));
    }
    scoped_object(
        [
            ("outputs", JsValue::Array(outputs)),
            ("plotOffsets", JsValue::Object(offsets)),
        ],
        scope,
    )
}

fn batch_kind(value: &JsValue) -> bool {
    property(value, "kind")
        .and_then(string)
        .is_some_and(|value| is_text(value, "batch"))
}

fn same_source(left: Option<&JsValue>, right: Option<&JsValue>) -> bool {
    match (left, right) {
        (None, None) | (Some(JsValue::Undefined), None) | (None, Some(JsValue::Undefined)) => true,
        (Some(JsValue::String(left)), Some(JsValue::String(right))) => left == right,
        _ => false,
    }
}

fn same_values(left: Option<&[f64]>, right: Option<&[f64]>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(|(left, right)| {
                    left.to_bits() == right.to_bits() || left.is_nan() && right.is_nan()
                })
        }
        _ => false,
    }
}

enum SeriesValuesStage {
    KeepExisting,
    Replace((Vec<f64>, MemoryGroup)),
    Clear,
}

struct OwnedDrawingBindings {
    panels: Vec<DrawingPanelBinding>,
    axes: Vec<DrawingAxisBinding>,
    series: Vec<DrawingSeriesBinding>,
}

/// 한 dispatch 동안 Root가 고정해 주는 controller snapshot이다.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChartApiContext<'a> {
    /// model leaf가 검사할 interaction 상태다.
    pub interaction: NativeInteractionContext<'a>,
    /// 현재 drawing target의 host-owned ordered record다.
    pub drawing_target: Option<&'a JsValue>,
    /// 현재 tool 이름이다.
    pub tool: Option<&'a JsString>,
    /// 현재 gesture kind다.
    pub gesture_kind: Option<&'a JsString>,
}

#[derive(Clone, Debug, Default)]
struct OwnedChartApiContext {
    gesture_active: bool,
    pointer_count: usize,
    target_panel: Option<JsString>,
    target_axis: Option<JsString>,
    drawing_target: Option<JsValue>,
    tool: Option<JsString>,
    gesture_kind: Option<JsString>,
}

impl OwnedChartApiContext {
    fn from_borrowed(context: ChartApiContext<'_>) -> Self {
        Self {
            gesture_active: context.interaction.gesture_active,
            pointer_count: context.interaction.pointer_count,
            target_panel: context.interaction.target_panel.cloned(),
            target_axis: context.interaction.target_axis.cloned(),
            drawing_target: context.drawing_target.cloned(),
            tool: context.tool.cloned(),
            gesture_kind: context.gesture_kind.cloned(),
        }
    }

    fn from_controller(controller: &OwnedInteractionState) -> Self {
        let drawing_target = controller.drawing_target().cloned();
        let target_field = |name: &str| {
            let JsValue::Object(target) = drawing_target.as_ref()? else {
                return None;
            };
            match target.get(&key(name)) {
                Some(JsValue::String(value)) => Some(value.clone()),
                _ => None,
            }
        };
        Self {
            gesture_active: controller.gesture_kind().is_some(),
            pointer_count: controller.pointer_count(),
            target_panel: target_field("panel"),
            target_axis: target_field("axisId"),
            drawing_target,
            tool: Some(controller.tool().clone()),
            gesture_kind: controller.gesture_kind().map(JsString::from_str),
        }
    }

    fn interaction(&self) -> NativeInteractionContext<'_> {
        NativeInteractionContext {
            gesture_active: self.gesture_active,
            pointer_count: self.pointer_count,
            target_panel: self.target_panel.as_ref(),
            target_axis: self.target_axis.as_ref(),
        }
    }
}

/// 실제 [`NativeChart`]를 빌려 65개 명령을 실행하는 짧은 facade다.
pub struct ChartApi<'a> {
    chart: &'a mut NativeChart,
    controller: Option<&'a mut OwnedInteractionState>,
    host: &'a dyn Host,
    context: OwnedChartApiContext,
    width: f64,
    height: f64,
}

impl<'a> ChartApi<'a> {
    /// controller가 아직 없는 core-only facade다.
    pub fn new(chart: &'a mut NativeChart, host: &'a dyn Host) -> Self {
        Self {
            chart,
            controller: None,
            host,
            context: OwnedChartApiContext::default(),
            width: f64::NAN,
            height: f64::NAN,
        }
    }

    /// Root가 실제 controller snapshot을 전달하는 facade다.
    pub fn with_context(
        chart: &'a mut NativeChart,
        host: &'a dyn Host,
        context: ChartApiContext<'a>,
    ) -> Self {
        Self {
            chart,
            controller: None,
            host,
            context: OwnedChartApiContext::from_borrowed(context),
            width: f64::NAN,
            height: f64::NAN,
        }
    }

    /// 실제 controller와 차트 소유자를 같은 dispatch 동안 빌리는 mutation facade다.
    pub fn with_controller(
        chart: &'a mut NativeChart,
        controller: &'a mut OwnedInteractionState,
        host: &'a dyn Host,
        width: f64,
        height: f64,
    ) -> Self {
        let context = OwnedChartApiContext::from_controller(controller);
        Self {
            chart,
            controller: Some(controller),
            host,
            context,
            width,
            height,
        }
    }

    /// 현재 실제 차트다.
    pub fn chart(&self) -> &NativeChart {
        self.chart
    }

    /// 현재 실제 차트의 배타적 빌림이다.
    pub fn chart_mut(&mut self) -> &mut NativeChart {
        self.chart
    }

    /// JS dispatch의 unknown/arity/nullish 결과 정책을 적용한다.
    pub fn dispatch(&mut self, operation: &JsString, args: &[JsValue]) -> Result<JsValue, JsError> {
        let mut scope = self.chart.ingestion.data().store().memory_context().scope();
        self.dispatch_scoped(operation, args, &mut scope)
    }

    /// JS dispatch 결과 payload를 caller가 보유한 scope에서 allocation한다.
    pub fn dispatch_scoped(
        &mut self,
        operation: &JsString,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        self.dispatch_scoped_with_fixed_reply_admission(operation, args, scope, &mut || Ok(()))
    }

    /// 고정 `null` reply를 갖는 staged operation이 마지막 publication 직전에 admission을 요청한다.
    ///
    /// 현재 이 hook은 detached view 후보가 있는 navigation 네 operation에만 적용된다. 다른 command의
    /// reply-order 분류와 coverage는 bridge census가 별도로 추적한다.
    pub fn dispatch_scoped_with_fixed_reply_admission(
        &mut self,
        operation: &JsString,
        args: &[JsValue],
        scope: &mut MemoryScope,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let Some(operation) = ChartOperation::parse(operation) else {
            return Err(type_error("Unknown chart command or argument list"));
        };
        if args.len() > operation.max_arity() {
            return Err(type_error("Chart command argument count"));
        }
        self.execute(operation, args, scope, admit_fixed_reply)
            .map(|value| match value {
                JsValue::Undefined | JsValue::Null => JsValue::Null,
                value => value,
            })
    }

    fn execute(
        &mut self,
        operation: ChartOperation,
        args: &[JsValue],
        scope: &mut MemoryScope,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        use ChartOperation::*;
        match operation {
            CompactData => self.compact_data(argument(args, 0)),
            SetData => self.set_data(argument(args, 0), admit_fixed_reply),
            SetColumns => self.set_columns(argument(args, 0), args.get(1), admit_fixed_reply),
            ApplyDataEvent => self.apply_data_event(argument(args, 0)),
            ApplyDataEvents => self.apply_data_events(argument(args, 0)),
            ConfigureDataIngestion => self
                .chart
                .ingestion
                .configure(argument(args, 0))
                .map_err(ingestion_error),
            EnqueueDataEvents => self
                .chart
                .ingestion
                .enqueue(argument(args, 0))
                .map_err(ingestion_error),
            DrainDataEvents => self.drain_data_events(args.first()),
            PauseDataIngestion => self.chart.ingestion.pause().map_err(ingestion_error),
            ResumeDataIngestion => self.chart.ingestion.resume().map_err(ingestion_error),
            CancelDataEvents => self
                .chart
                .ingestion
                .cancel()
                .map(|receipt| receipt.to_value())
                .map_err(ingestion_error),
            DataIngestionStats => self.chart.ingestion.stats().map_err(ingestion_error),
            SaveDataIngestion => self
                .chart
                .ingestion
                .save_scoped(scope)
                .map(JsValue::String)
                .map_err(ingestion_error),
            LoadDataIngestion => self
                .chart
                .ingestion
                .load(argument(args, 0))
                .map_err(ingestion_error),
            AddPanel => self.model_operation(|model, context| {
                model
                    .add_panel(argument(args, 0), context)
                    .map(JsValue::String)
            }),
            SetPanel => self.model_operation(|model, context| {
                model.set_panel_with_admission(
                    argument(args, 0),
                    argument(args, 1),
                    context,
                    admit_fixed_reply,
                )?;
                Ok(JsValue::Null)
            }),
            SetPanelOrder => self.model_operation(|model, context| {
                model
                    .set_panel_order(argument(args, 0), context)
                    .map(JsValue::Bool)
            }),
            RemovePanel => self.remove_panel(argument(args, 0), admit_fixed_reply),
            AddAxis => self.model_operation(|model, context| {
                model
                    .add_axis(argument(args, 0), context)
                    .map(JsValue::String)
            }),
            SetAxis => self.model_operation(|model, context| {
                model.set_axis_with_admission(
                    argument(args, 0),
                    argument(args, 1),
                    context,
                    admit_fixed_reply,
                )?;
                Ok(JsValue::Null)
            }),
            RemoveAxis => self.remove_axis(argument(args, 0), admit_fixed_reply),
            SetDrawingTarget => self.controller_operation(|controller, context| {
                controller
                    .set_drawing_target(context, argument(args, 0), false)
                    .map(|_| JsValue::Null)
            }),
            SetDrawingMagnet => self.controller_operation(|controller, context| {
                controller
                    .set_drawing_magnet(context, argument(args, 0), false)
                    .map(|_| JsValue::Null)
            }),
            SetCrosshairSnap => self.controller_operation(|controller, context| {
                controller
                    .set_crosshair_snap(context, argument(args, 0), false)
                    .map(|_| JsValue::Null)
            }),
            CrosshairSnapshot | CrosshairValues => Err(unavailable(operation)),
            SetTool => self.controller_operation(|controller, context| {
                controller
                    .set_tool(context, argument(args, 0), false)
                    .map(|_| JsValue::Null)
            }),
            SetText => self.set_text(argument(args, 0)),
            DataAt => self.data_at(argument(args, 0), argument(args, 1), scope),
            AddSeries => self
                .chart
                .add_series_api_scoped(argument(args, 0), scope)
                .map(JsValue::String),
            SetSeries => self.set_series(
                argument(args, 0),
                argument(args, 1),
                scope,
                admit_fixed_reply,
            ),
            SetSeriesValues => {
                let (values, memory) = numeric_values_with_memory(
                    argument(args, 1),
                    self.chart.ingestion.data().store().memory_context(),
                )?;
                self.chart
                    .model
                    .set_series_values_with_owned_values_and_admission(
                        argument(args, 0),
                        values,
                        memory,
                        self.chart.ingestion.data().store(),
                        admit_fixed_reply,
                    )?;
                Ok(JsValue::Null)
            }
            RemoveSeries => self.remove_series(argument(args, 0), admit_fixed_reply),
            AddIndicator => self.add_indicator(args, scope),
            SetIndicatorParams => self.set_indicator_params(args, scope),
            SetIndicatorPlacement => {
                self.set_indicator_placement(argument(args, 0), argument(args, 1))
            }
            RemoveIndicator => self.remove_indicator(argument(args, 0), admit_fixed_reply),
            IndicatorValues => self.indicator_values(argument(args, 0), args.get(1), scope),
            IndicatorValueAt => self.indicator_value_at(args, scope),
            RegisterIndicatorModule => self.register_indicator_module(args, scope),
            SaveStudies => study_setup::save_study_setup_scoped(
                &self.chart.indicators,
                &self.chart.model,
                scope,
            )
            .map(JsValue::String),
            LoadStudies => self.load_studies(argument(args, 0), scope),
            AddDrawing => self.add_drawing(argument(args, 0)),
            PositionMetrics => self.position_metrics(argument(args, 0), scope),
            EditDrawing => {
                self.edit_drawing(argument(args, 0), argument(args, 1), admit_fixed_reply)
            }
            TranslateDrawings => {
                self.group_drawing(operation, argument(args, 0), argument(args, 1), scope)
            }
            SetDrawingsStyle => {
                self.group_drawing(operation, argument(args, 0), argument(args, 1), scope)
            }
            SetDrawingVisibility => {
                let mut ids = scoped_vec(1, scope)?;
                ids.push(
                    argument(args, 0)
                        .try_clone_scoped(scope)
                        .map_err(memory_error)?,
                );
                self.group_drawing(
                    SetDrawingsVisibility,
                    &JsValue::Array(ids),
                    argument(args, 1),
                    scope,
                )
            }
            SetDrawingsVisibility => {
                self.group_drawing(operation, argument(args, 0), argument(args, 1), scope)
            }
            DuplicateDrawing => {
                let mut ids = scoped_vec(1, scope)?;
                ids.push(
                    argument(args, 0)
                        .try_clone_scoped(scope)
                        .map_err(memory_error)?,
                );
                self.group_drawing(
                    DuplicateDrawings,
                    &JsValue::Array(ids),
                    argument(args, 1),
                    scope,
                )
            }
            DuplicateDrawings => {
                self.group_drawing(operation, argument(args, 0), argument(args, 1), scope)
            }
            DeleteDrawings => {
                self.group_drawing(operation, argument(args, 0), &JsValue::Undefined, scope)
            }
            DeleteDrawing => self.delete_drawing(args.first()),
            SelectDrawing => self.select_drawing(argument(args, 0), admit_fixed_reply),
            SaveDrawings => {
                let (text, memory) = self.chart.drawings.save_with_memory()?;
                scope.absorb_persistent(memory).map_err(memory_error)?;
                Ok(JsValue::String(text))
            }
            LoadDrawings => self.load_drawings(argument(args, 0), admit_fixed_reply),
            Undo => self.undo_redo(false, admit_fixed_reply),
            Redo => self.undo_redo(true, admit_fixed_reply),
            SetTheme => {
                self.chart
                    .model
                    .set_theme_api_with_admission(argument(args, 0), admit_fixed_reply)?;
                Ok(JsValue::Null)
            }
            SetSymbol => self.set_symbol(argument(args, 0), admit_fixed_reply),
            SetVisibleRange => {
                let prepared = self.chart.model.prepare_visible_range(
                    self.chart.ingestion.data().store(),
                    argument(args, 0),
                    argument(args, 1),
                )?;
                admit_fixed_reply()?;
                self.chart.model.publish_prepared_view(prepared);
                Ok(JsValue::Null)
            }
            Fit => {
                let prepared = self
                    .chart
                    .model
                    .prepare_fit(self.chart.ingestion.data().store());
                admit_fixed_reply()?;
                self.chart.model.publish_prepared_view(prepared);
                Ok(JsValue::Null)
            }
            Zoom => {
                let prepared = self.chart.model.prepare_zoom(
                    self.chart.ingestion.data().store(),
                    argument(args, 0),
                    args.get(1),
                )?;
                admit_fixed_reply()?;
                self.chart.model.publish_prepared_view(prepared);
                Ok(JsValue::Null)
            }
            Pan => {
                let prepared = self
                    .chart
                    .model
                    .prepare_pan(self.chart.ingestion.data().store(), argument(args, 0))?;
                admit_fixed_reply()?;
                self.chart.model.publish_prepared_view(prepared);
                Ok(JsValue::Null)
            }
            Inspect => self.inspect(scope),
        }
    }

    fn model_operation<R>(
        &mut self,
        operation: impl FnOnce(
            &mut crate::model_state::ModelState,
            &ModelContext<'_>,
        ) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let interaction = self.context.interaction();
        self.chart.with_model_context(interaction, operation)
    }

    fn remove_panel(
        &mut self,
        id: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let interaction = self.context.interaction();
        let controller = &mut self.controller;
        let chart = &mut *self.chart;
        let mut prepared_target = None;
        let receipt = chart.with_model_context(interaction, |model, context| {
            let clear_target =
                matches!(id, JsValue::String(id) if context.drawings.controller_panel == Some(id));
            model.remove_panel_with_admission(id, context, &mut || {
                if clear_target {
                    prepared_target = controller
                        .as_deref()
                        .map(|controller| controller.prepare_drawing_target_publication(None))
                        .transpose()?;
                }
                admit_fixed_reply()
            })
        })?;
        if receipt.clear_controller_target {
            controller
                .as_deref_mut()
                .expect("controller target requires controller")
                .publish_prepared_drawing_target_raw(
                    prepared_target.expect("clear target prepared before panel publication"),
                )?;
        }
        Ok(JsValue::Null)
    }

    fn remove_axis(
        &mut self,
        id: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let interaction = self.context.interaction();
        let controller = &mut self.controller;
        let chart = &mut *self.chart;
        let mut prepared_target = None;
        let receipt = chart.with_model_context(interaction, |model, context| {
            let clear_target =
                matches!(id, JsValue::String(id) if context.drawings.controller_axis == Some(id));
            model.remove_axis_with_admission(id, context, &mut || {
                if clear_target {
                    prepared_target = controller
                        .as_deref()
                        .map(|controller| controller.prepare_drawing_target_publication(None))
                        .transpose()?;
                }
                admit_fixed_reply()
            })
        })?;
        if receipt.clear_controller_target {
            controller
                .as_deref_mut()
                .expect("controller target requires controller")
                .publish_prepared_drawing_target_raw(
                    prepared_target.expect("clear target prepared before axis publication"),
                )?;
        }
        Ok(JsValue::Null)
    }

    fn set_text(&mut self, value: &JsValue) -> Result<JsValue, JsError> {
        let JsValue::String(text) = value else {
            return Err(type_error("Drawing text, at most 2000 characters"));
        };
        if text.len_utf16() > 2_000 {
            return Err(type_error("Drawing text, at most 2000 characters"));
        }
        let controller = self
            .controller
            .as_deref_mut()
            .ok_or_else(|| ordinary_error("Interaction controller required"))?;
        controller.set_text(value)?;
        Ok(JsValue::Null)
    }

    fn controller_operation<R>(
        &mut self,
        operation: impl FnOnce(
            &mut OwnedInteractionState,
            &mut InteractionContext<'_>,
        ) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let controller = self
            .controller
            .as_deref_mut()
            .ok_or_else(|| ordinary_error("Interaction controller required"))?;
        let chart = &mut *self.chart;
        let mut context = InteractionContext {
            model: &mut chart.model,
            store: chart.ingestion.data().store(),
            indicators: &mut chart.indicators,
            drawings: &mut chart.drawings,
            series_caches: &mut chart.series_caches,
            geometry_cache: &mut chart.drawing_cache,
            host: self.host,
            width: self.width,
            height: self.height,
        };
        operation(controller, &mut context)
    }

    fn drawing_mutation<R>(
        &mut self,
        operation: impl FnOnce(
            &mut DrawingStore,
            &DrawingSnapshot,
            &mut dyn FnMut(&mut DrawingStore) -> Result<(), JsError>,
        ) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let baseline = self.drawing_mutation_baseline();
        self.drawing_mutation_from(baseline, operation)
    }

    fn drawing_mutation_baseline(&self) -> DrawingSnapshot {
        let interactive = self
            .controller
            .as_deref()
            .is_some_and(|controller| controller.gesture_kind().is_some());
        if interactive {
            self.chart
                .drawings
                .transaction()
                .cloned()
                .unwrap_or_else(|| self.chart.drawings.snapshot())
        } else {
            self.chart.drawings.snapshot()
        }
    }

    fn drawing_mutation_from<R>(
        &mut self,
        baseline: DrawingSnapshot,
        operation: impl FnOnce(
            &mut DrawingStore,
            &DrawingSnapshot,
            &mut dyn FnMut(&mut DrawingStore) -> Result<(), JsError>,
        ) -> Result<R, JsError>,
    ) -> Result<R, JsError> {
        let interactive = self
            .controller
            .as_deref()
            .is_some_and(|controller| controller.gesture_kind().is_some());
        if !interactive {
            return operation(&mut self.chart.drawings, &baseline, &mut |_| Ok(()));
        }

        let controller = self
            .controller
            .as_deref_mut()
            .expect("interactive snapshot has a controller");
        let chart = &mut *self.chart;
        let model = &mut chart.model;
        let store = chart.ingestion.data().store();
        let indicators = &mut chart.indicators;
        let drawings = &mut chart.drawings;
        let series_caches = &mut chart.series_caches;
        let geometry_cache = &mut chart.drawing_cache;
        let host = self.host;
        let width = self.width;
        let height = self.height;
        operation(drawings, &baseline, &mut |drawings| {
            let mut context = InteractionContext {
                model,
                store,
                indicators,
                drawings,
                series_caches,
                geometry_cache,
                host,
                width,
                height,
            };
            controller.cancel(&mut context, false, false)?;
            Ok(())
        })
    }

    fn set_data(
        &mut self,
        input: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let mut publication = None;
        let committed = {
            let chart = &mut *self.chart;
            let model = &chart.model;
            let store = chart.ingestion.data_mut().store_mut();
            set_data_input_with_reply_gate(store, input, DataInputMode::ApiFacade, &mut || {
                publication = Some(model.prepare_store_change_publication());
                admit_fixed_reply()
            })
            .map_err(data_input_error)?
        };
        Ok(data_event_value(
            self.chart
                .commit_data_change_with_publication(committed, publication),
        ))
    }

    fn set_columns(
        &mut self,
        input: &JsValue,
        length: Option<&JsValue>,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let mut publication = None;
        let committed = {
            let chart = &mut *self.chart;
            let model = &chart.model;
            let store = chart.ingestion.data_mut().store_mut();
            set_columns_input_with_reply_gate(
                store,
                input,
                length,
                DataInputMode::ApiFacade,
                &mut || {
                    publication = Some(model.prepare_store_change_publication());
                    admit_fixed_reply()
                },
            )
            .map_err(data_input_error)?
        };
        Ok(data_event_value(
            self.chart
                .commit_data_change_with_publication(committed, publication),
        ))
    }

    fn apply_data_event(&mut self, input: &JsValue) -> Result<JsValue, JsError> {
        if batch_kind(input) {
            return self
                .apply_data_events(property(input, "events").unwrap_or(&JsValue::Undefined));
        }
        let committed = apply_data_event_input(
            self.chart.ingestion.data_mut().store_mut(),
            input,
            DataInputMode::ApiFacade,
        )
        .map_err(data_input_error)?;
        self.chart.commit_data_change(committed);
        Ok(JsValue::Null)
    }

    fn apply_data_events(&mut self, input: &JsValue) -> Result<JsValue, JsError> {
        let external = self
            .chart
            .model
            .series
            .iter()
            .any(|series| series.values.is_some());
        let committed = self
            .chart
            .ingestion
            .apply_data_events_with_external_values(input, false, external)
            .map_err(apply_data_error)?;
        let receipt: BatchReceipt = self.chart.commit_data_change(committed);
        Ok(receipt.to_js_value())
    }

    fn drain_data_events(&mut self, maximum: Option<&JsValue>) -> Result<JsValue, JsError> {
        let external = self
            .chart
            .model
            .series
            .iter()
            .any(|series| series.values.is_some());
        let receipt = self
            .chart
            .ingestion
            .drain(maximum, external)
            .map_err(ingestion_error)?;
        if let Some(change) = receipt.change.as_ref() {
            self.chart.publish_data_change(change);
        }
        Ok(receipt.to_value())
    }

    fn compact_data(&mut self, options: &JsValue) -> Result<JsValue, JsError> {
        let outcome = compaction::compact_data(
            &mut self.chart.ingestion,
            &mut self.chart.indicators,
            &mut self.chart.model,
            options,
            CompactionContext {
                exclusive_owner: true,
                active_gesture: self.context.gesture_active,
                drawing_transaction: self.chart.drawings.transaction().is_some(),
            },
            None,
        )
        .map_err(compaction_error)?;
        self.chart
            .series_caches
            .retain_series(&self.chart.model.series);
        Ok(outcome.receipt.to_js_value())
    }

    fn add_indicator(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let empty = JsValue::Object(JsObject::new());
        let params = match args.get(2) {
            None | Some(JsValue::Undefined) => &empty,
            Some(value) => value,
        };
        let read = self.chart.indicators.add_scoped(
            self.chart.ingestion.data().store(),
            self.host,
            argument(args, 0),
            argument(args, 1),
            params,
            scope,
        )?;
        indicator_read_receipt(read, scope)
    }

    fn set_indicator_params(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let receipt = indicator_params_update::set_indicator_params(
            &mut self.chart.indicators,
            &mut self.chart.model,
            self.chart.ingestion.data().store(),
            self.host,
            argument(args, 0),
            argument(args, 1),
            None,
        )?;
        receipt_value(&receipt, scope)
    }

    fn remove_indicator(
        &mut self,
        id: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        if self.chart.indicators.entry(id).is_none() {
            let suffix = string(id)
                .map(JsString::to_string_lossy)
                .unwrap_or_else(|| "undefined".to_owned());
            return Err(ordinary_error(&format!("Missing indicator: {suffix}")));
        }
        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let (mut removed, _removed_memory) = memory
            .try_vec_capacity(self.chart.model.series.len())
            .map_err(memory_error)?;
        for series in &self.chart.model.series {
            if series
                .indicator
                .as_ref()
                .is_some_and(|bound| matches!(id, JsValue::String(id) if bound == id))
            {
                removed.push(
                    series
                        .id
                        .try_clone_scoped(&mut temporary)
                        .map_err(memory_error)?,
                );
            }
        }
        let active_is_affected = self
            .controller
            .as_deref()
            .and_then(OwnedInteractionState::gesture_drawing_id)
            .and_then(|gesture_id| {
                self.chart
                    .drawings
                    .items()
                    .iter()
                    .find(|drawing| drawing.id == *gesture_id)
            })
            .and_then(|drawing| drawing.series_id.as_ref())
            .is_some_and(|series_id| removed.contains(series_id));
        let prepared_cancel = if active_is_affected {
            Some(self.controller_operation(|controller, context| {
                controller.prepare_cancel(context, false, false)
            })?)
        } else {
            None
        };
        let target_is_affected = self
            .controller
            .as_deref()
            .and_then(OwnedInteractionState::drawing_target)
            .and_then(|target| property(target, "seriesId"))
            .and_then(string)
            .is_some_and(|series_id| removed.contains(series_id));
        let prepared_target = if target_is_affected {
            Some(
                self.controller
                    .as_deref()
                    .expect("affected target requires controller")
                    .prepare_drawing_target_publication(None)?,
            )
        } else {
            None
        };
        let model_publication =
            (!removed.is_empty()).then(|| self.chart.model.prepare_series_publication(false));
        let cache_publication = self.chart.series_caches.prepare_remove_ids(&removed);
        admit_fixed_reply()?;
        if let Some(cancel) = prepared_cancel {
            self.controller_operation(|controller, context| {
                controller.publish_prepared_cancel(context, cancel)
            })?;
        }
        if let Some(target) = prepared_target {
            self.controller
                .as_deref_mut()
                .expect("prepared target requires controller")
                .publish_prepared_drawing_target_raw(target)?;
        }
        if let Some(publication) = model_publication {
            self.chart
                .model
                .publish_prepared_indicator_series_removal(id, publication);
        }
        self.chart.indicators.remove(id);
        self.chart
            .series_caches
            .publish_remove_ids(&removed, cache_publication);
        Ok(JsValue::Null)
    }

    fn indicator_values(
        &mut self,
        id: &JsValue,
        output: Option<&JsValue>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let values = indicator_query::indicator_values_scoped(
            &mut self.chart.indicators,
            self.chart.ingestion.data().store(),
            self.host,
            id,
            output,
            scope,
        )?;
        let mut output = scoped_vec(values.len(), scope)?;
        output.extend(values.iter().map(|value| {
            if value.is_finite() {
                JsValue::Number(*value)
            } else {
                JsValue::Null
            }
        }));
        Ok(JsValue::Array(output))
    }

    fn indicator_value_at(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let index = match argument(args, 2) {
            JsValue::Number(value) => *value,
            _ => return Err(range_error("Indicator query index/mode")),
        };
        let empty = JsValue::Object(JsObject::new());
        let options = match args.get(3) {
            None | Some(JsValue::Undefined) => &empty,
            Some(value) => value,
        };
        option_record(options, &["mode", "asOfIndex"], "Indicator query")?;
        let default_mode =
            JsValue::String(JsString::try_from_str("raw", scope).map_err(memory_error)?);
        let mode = property(options, "mode").unwrap_or(&default_mode);
        let as_of = match property(options, "asOfIndex") {
            None => JsValue::Number(self.chart.ingestion.data().store().length() as f64 - 1.0),
            Some(JsValue::Number(value)) => JsValue::Number(*value),
            Some(_) => JsValue::Undefined,
        };
        let options = IndicatorQueryOptions::validate(
            mode,
            as_of,
            self.chart.ingestion.data().store().length(),
        )?;
        let point = indicator_query::indicator_value_at_scoped(
            &mut self.chart.indicators,
            self.chart.ingestion.data().store(),
            self.host,
            argument(args, 0),
            args.get(1),
            index,
            options,
            scope,
        )?;
        scoped_object(
            [
                ("value", point.value.map_or(JsValue::Null, JsValue::Number)),
                (
                    "sourceIndex",
                    point.source_index.map_or(JsValue::Null, JsValue::Number),
                ),
                (
                    "sourceTime",
                    point.source_time.map_or(JsValue::Null, JsValue::Number),
                ),
            ],
            scope,
        )
    }

    fn register_indicator_module(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        // Runtime registry already contains the one statically linked module. Run the exact
        // descriptor validator against an equivalent fixed registry and retain idempotence.
        let mut registry = IndicatorRegistry::new();
        let names = indicator_modules::register_indicator_module(
            &mut registry,
            argument(args, 0),
            argument(args, 1),
        )?;
        let mut output = scoped_vec(names.len(), scope)?;
        for name in names {
            output.push(JsValue::String(
                name.try_clone_scoped(scope).map_err(memory_error)?,
            ));
        }
        Ok(JsValue::Array(output))
    }

    fn load_studies(
        &mut self,
        input: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let receipt = study_setup::load_study_setup_scoped(
            &mut self.chart.indicators,
            &mut self.chart.model,
            self.chart.ingestion.data().store(),
            self.host,
            input,
            None,
            scope,
        )?;
        scoped_object(
            [
                ("indicators", JsValue::Number(receipt.indicators as f64)),
                ("series", JsValue::Number(receipt.series as f64)),
            ],
            scope,
        )
    }

    fn data_at(
        &mut self,
        query: &JsValue,
        options: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let empty = JsValue::Object(JsObject::new());
        let options = if matches!(options, JsValue::Undefined) {
            &empty
        } else {
            options
        };
        let symbol = self
            .chart
            .symbol
            .as_ref()
            .map(|symbol| {
                Ok(ExplorerSymbol {
                    id: symbol.id.try_clone_scoped(scope).map_err(memory_error)?,
                    currency: symbol
                        .currency
                        .try_clone_scoped(scope)
                        .map_err(memory_error)?,
                    volume_unit: symbol
                        .volume_unit
                        .try_clone_scoped(scope)
                        .map_err(memory_error)?,
                })
            })
            .transpose()?;
        data_explorer::data_at_scoped(
            &self.chart.model,
            &mut self.chart.indicators,
            self.chart.ingestion.data().store(),
            self.host,
            DataAtRequest {
                query,
                options,
                symbol: symbol.as_ref(),
            },
            scope,
        )
        .and_then(|value| {
            value
                .as_ref()
                .map(|value| data_query_result_value(value, scope))
                .transpose()
                .map(|value| value.unwrap_or(JsValue::Null))
        })
    }

    fn set_series(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        scope: &mut MemoryScope,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let Some(id) = string(id) else {
            return Err(ordinary_error("Missing series"));
        };
        let Some(index) = self
            .chart
            .model
            .series
            .iter()
            .position(|series| &series.id == id)
        else {
            return Err(ordinary_error("Missing series"));
        };
        let current_record = self.chart.model.series[index].raw_record_without_values();
        let current_panel = self.chart.model.series[index].panel.clone();
        let current_axis = self.chart.model.series[index].axis_id.clone();
        let current_indicator = self.chart.model.series[index].indicator.clone();
        let current_output = self.chart.model.series[index].output.clone();
        let current_source = self.chart.model.series[index].source_value().cloned();
        let current_values_present = self.chart.model.series[index].values.is_some();
        let current_values_revision = self.chart.model.series[index].values_revision;
        let current_range_index_ready = self.chart.model.series[index].range_index_ready;
        let current_revision = self.chart.model.series[index].revision;
        let current_dirty_from = self.chart.model.series[index].dirty_from;
        let patch_has_values = property(patch, "values").is_some();
        let patch_has_indicator = property(patch, "indicator").is_some();
        let patch_has_output = property(patch, "output").is_some();
        let snapshot = api_series_options_scoped(
            patch,
            self.chart.ingestion.data().store().memory_context(),
            scope,
        )?;
        let (normalized_patch, attached_patch) = (snapshot.normalized, snapshot.values);
        let mut merged_value = current_record;
        let JsValue::Object(merged) = &mut merged_value else {
            unreachable!("series record")
        };
        let JsValue::Object(patch_record) = &normalized_patch else {
            unreachable!("portable style record")
        };
        for (key, value) in patch_record.iter() {
            merged.insert(key.clone(), value.clone());
        }
        for nullable in ["indicator", "output", "values"] {
            if matches!(patch_record.get(&key(nullable)), Some(JsValue::Null)) {
                merged.remove(&key(nullable));
            }
        }
        if patch_has_indicator || patch_has_output {
            merged.insert(key("offset"), JsValue::Undefined);
        }
        merged.remove(&key("values"));
        let values = if !patch_has_values {
            SeriesValuesStage::KeepExisting
        } else if let Some(values) = attached_patch {
            SeriesValuesStage::Replace(values)
        } else {
            SeriesValuesStage::Clear
        };
        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut projection_scope = memory.scope();
        let (mut projections, _projections_memory) = memory
            .try_vec_capacity(self.chart.indicators.len())
            .map_err(memory_error)?;
        for id in self.chart.indicators.entry_ids_iter() {
            let lookup = JsValue::String(
                id.try_clone_scoped(&mut projection_scope)
                    .map_err(memory_error)?,
            );
            let entry = self
                .chart
                .indicators
                .entry(&lookup)
                .expect("entry id iterator is current");
            projections.push(crate::model_state::IndicatorProjection {
                id: entry.id(),
                definition: entry.definition(),
            });
        }
        let context = ModelContext {
            store: self.chart.ingestion.data().store(),
            indicators: &projections,
            drawings: Default::default(),
            interaction: Default::default(),
        };
        let keep_existing_values = matches!(&values, SeriesValuesStage::KeepExisting);
        let clear_values = matches!(&values, SeriesValuesStage::Clear);
        let (attached, values_present) = match values {
            SeriesValuesStage::KeepExisting => (None, current_values_present),
            SeriesValuesStage::Replace(values) => (Some(values), true),
            SeriesValuesStage::Clear => (None, false),
        };
        let mut next = self
            .chart
            .model
            .normalized_series_for_owned_replacement_scoped(
                &merged_value,
                attached,
                values_present,
                &context,
                scope,
            )?;
        let same_value_attachment = if keep_existing_values {
            true
        } else if clear_values {
            !current_values_present
        } else {
            same_values(
                self.chart.model.series[index].values.as_deref(),
                next.values.as_deref(),
            )
        };
        let same_data = same_value_attachment
            && current_indicator == next.indicator
            && current_output == next.output
            && same_source(current_source.as_ref(), next.source_value());
        if same_data {
            next.range_index_ready = current_range_index_ready;
            next.revision = current_revision;
            next.dirty_from = current_dirty_from;
            next.values_revision = current_values_revision;
        }
        let moved = current_panel != next.panel || current_axis != next.axis_id;
        let active_is_affected = moved
            && self
                .controller
                .as_deref()
                .and_then(OwnedInteractionState::gesture_drawing_id)
                .is_some_and(|gesture_id| {
                    self.chart.drawings.items().iter().any(|drawing| {
                        drawing.id == *gesture_id && drawing.series_id.as_ref() == Some(id)
                    })
                });
        let prepared_cancel = if active_is_affected {
            Some(self.controller_operation(|controller, context| {
                controller.prepare_cancel(context, false, false)
            })?)
        } else {
            None
        };

        let target = self
            .controller
            .as_deref()
            .and_then(OwnedInteractionState::drawing_target)
            .cloned();
        let target_needs_rebind = target.as_ref().is_some_and(|target| {
            property(target, "seriesId").and_then(string) == Some(id)
                && (property(target, "panel").and_then(string) != Some(&next.panel)
                    || property(target, "axisId").and_then(string) != next.axis_id.as_ref())
        });
        let next_panel = next.panel.clone();
        let next_axis = next.axis_id.clone();
        let new_values = patch_has_values && next.values.is_some();
        let series_publication = self.chart.model.prepare_series_publication(new_values);
        let prepared_target = if target_needs_rebind {
            let mut target = target.expect("target rebind requires a target");
            let JsValue::Object(record) = &mut target else {
                unreachable!("validated drawing target")
            };
            record.insert(key("panel"), JsValue::String(next_panel));
            record.insert(
                key("axisId"),
                next_axis.map_or(JsValue::Null, JsValue::String),
            );
            Some(
                self.controller
                    .as_deref()
                    .expect("target rebind requires controller")
                    .prepare_drawing_target_publication(Some(&target))?,
            )
        } else {
            None
        };
        admit_fixed_reply()?;
        if let Some(cancel) = prepared_cancel {
            self.controller_operation(|controller, context| {
                controller.publish_prepared_cancel(context, cancel)
            })?;
        }
        if keep_existing_values {
            next.transfer_values_from(&mut self.chart.model.series[index]);
        }
        self.chart
            .model
            .publish_prepared_series_replacement(index, next, series_publication);
        if let Some(target) = prepared_target {
            self.controller
                .as_deref_mut()
                .expect("prepared target requires controller")
                .publish_prepared_drawing_target_raw(target)?;
        }
        Ok(JsValue::Null)
    }

    fn remove_series(
        &mut self,
        id: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let id_string = string(id).cloned();
        let active_is_affected = id_string.as_ref().is_some_and(|id| {
            self.controller
                .as_deref()
                .and_then(OwnedInteractionState::gesture_drawing_id)
                .and_then(|gesture_id| {
                    self.chart
                        .drawings
                        .items()
                        .iter()
                        .find(|drawing| drawing.id == *gesture_id)
                })
                .and_then(|drawing| drawing.series_id.as_ref())
                == Some(id)
        });
        let prepared_cancel = if active_is_affected {
            Some(self.controller_operation(|controller, context| {
                controller.prepare_cancel(context, false, false)
            })?)
        } else {
            None
        };
        let target_is_affected = id_string.as_ref().is_some_and(|id| {
            self.controller
                .as_deref()
                .and_then(OwnedInteractionState::drawing_target)
                .and_then(|target| property(target, "seriesId"))
                .and_then(string)
                == Some(id)
        });
        let prepared_target = if target_is_affected {
            Some(
                self.controller
                    .as_deref()
                    .expect("affected target requires controller")
                    .prepare_drawing_target_publication(None)?,
            )
        } else {
            None
        };
        let model_publication = self.chart.model.prepare_series_publication(false);
        let cache_publication = id_string.as_ref().map(|id| {
            self.chart
                .series_caches
                .prepare_remove_ids(std::slice::from_ref(id))
        });
        admit_fixed_reply()?;
        if let Some(cancel) = prepared_cancel {
            self.controller_operation(|controller, context| {
                controller.publish_prepared_cancel(context, cancel)
            })?;
        }
        if let Some(target) = prepared_target {
            self.controller
                .as_deref_mut()
                .expect("prepared target requires controller")
                .publish_prepared_drawing_target_raw(target)?;
        }
        self.chart
            .model
            .publish_prepared_series_removal(id, model_publication);
        if let (Some(id), Some(prepared)) = (id_string.as_ref(), cache_publication) {
            self.chart
                .series_caches
                .publish_remove_ids(std::slice::from_ref(id), prepared);
        }
        Ok(JsValue::Null)
    }

    fn set_indicator_placement(
        &mut self,
        id: &JsValue,
        placement: &JsValue,
    ) -> Result<JsValue, JsError> {
        let target = self
            .controller
            .as_deref()
            .and_then(OwnedInteractionState::drawing_target)
            .cloned();
        let target_series = target
            .as_ref()
            .and_then(|target| property(target, "seriesId"))
            .and_then(string)
            .cloned();
        let receipt = self.model_operation(|model, context| {
            model.set_indicator_placement(id, placement, context)
        })?;
        if receipt.changed > 0
            && target_series
                .as_ref()
                .is_some_and(|id| receipt.bound_ids.contains(id))
            && let (Some(controller), Some(mut target)) = (self.controller.as_deref_mut(), target)
        {
            let JsValue::Object(record) = &mut target else {
                unreachable!("drawing target is an ordered record")
            };
            record.insert(key("panel"), JsValue::String(receipt.panel.clone()));
            record.insert(
                key("axisId"),
                receipt
                    .axis_id
                    .clone()
                    .map_or(JsValue::Null, JsValue::String),
            );
            controller.publish_drawing_target(Some(target))?;
        }
        Ok(object([(
            "changed",
            JsValue::Number(receipt.changed as f64),
        )]))
    }

    fn drawing_options(
        &self,
        input: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        option_record(
            input,
            &[
                "id", "type", "panel", "points", "style", "text", "locked", "visible", "axisId",
                "seriesId",
            ],
            "Drawing",
        )?;
        let copied = copy_drawing_value_scoped(input, self.chart.dialect, scope)?;
        let JsValue::Object(value) = &copied else {
            return Err(type_error("Drawing: object required"));
        };
        let mut patch_entries = scoped_vec(2, scope)?;
        if let Some(style) = value.get(&key("style")) {
            option_record(style, &["color", "fill", "width", "font"], "Drawing style")?;
            let portable = portable_style_scoped(style, &["color", "fill"], false, scope)?;
            patch_entries.push((
                JsString::try_from_str("style", scope).map_err(memory_error)?,
                portable,
            ));
        }
        if value.get(&key("axisId")).is_none()
            && let Some(series_id) = value.get(&key("seriesId")).and_then(string)
            && let Some(series) = self
                .chart
                .model
                .series
                .iter()
                .find(|series| &series.id == series_id)
        {
            patch_entries.push((
                JsString::try_from_str("axisId", scope).map_err(memory_error)?,
                series
                    .axis_id
                    .as_ref()
                    .map(|axis| {
                        axis.try_clone_scoped(scope)
                            .map(JsValue::String)
                            .map_err(memory_error)
                    })
                    .transpose()?
                    .unwrap_or(JsValue::Null),
            ));
        }
        let patch =
            JsObject::try_from_entries_scoped(patch_entries, scope).map_err(memory_error)?;
        merge_objects_scoped(value, &patch, scope)
    }

    fn add_drawing(&mut self, input: &JsValue) -> Result<JsValue, JsError> {
        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let mut options = self.drawing_options(input, &mut temporary)?;
        if matches!(&options, JsValue::Object(record) if record.get(&key("panel")).is_none()) {
            let JsValue::Object(record) = &options else {
                unreachable!("drawing options are an object")
            };
            let panel_value = scoped_object(
                [(
                    "panel",
                    JsValue::String(
                        JsString::try_from_str("price", &mut temporary).map_err(memory_error)?,
                    ),
                )],
                &mut temporary,
            )?;
            let JsValue::Object(panel) = &panel_value else {
                unreachable!("scoped object")
            };
            options = merge_objects_scoped(record, panel, &mut temporary)?;
        }
        self.chart.model.validate_drawing_binding(&options, false)?;
        self.drawing_mutation(|drawings, baseline, before_mutation| {
            drawings
                .add_from_snapshot(&options, baseline, before_mutation)
                .map(JsValue::String)
        })
    }

    fn position_metrics(&self, id: &JsValue, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let Some(id) = string(id) else {
            return Err(type_error("Position drawing required"));
        };
        self.chart
            .drawings
            .position_metrics(id)
            .and_then(|value| value.to_value_scoped(scope))
    }

    fn edit_drawing(
        &mut self,
        id: &JsValue,
        patch: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let Some(id) = string(id) else {
            return Err(ordinary_error("Missing committed drawing"));
        };
        let baseline = self.drawing_mutation_baseline();
        let Some(previous) = baseline.iter().find(|drawing| &drawing.id == id) else {
            return Err(ordinary_error("Missing committed drawing"));
        };
        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let normalized = self.drawing_options(patch, &mut temporary)?;
        let candidate = previous.to_value_scoped(&mut temporary)?;
        let JsValue::Object(candidate_record) = &candidate else {
            unreachable!("drawing record")
        };
        let JsValue::Object(patch) = &normalized else {
            unreachable!("drawing patch")
        };
        let candidate = merge_objects_scoped(candidate_record, patch, &mut temporary)?;
        self.chart
            .model
            .validate_drawing_binding(&candidate, false)?;
        let prepared_cancel = if self
            .controller
            .as_deref()
            .is_some_and(|controller| controller.gesture_kind().is_some())
        {
            Some(self.controller_operation(|controller, context| {
                controller.prepare_cancel(context, false, false)
            })?)
        } else {
            None
        };
        let cancel_transaction = prepared_cancel.is_some();
        let controller = &mut self.controller;
        let model = &mut self.chart.model;
        let drawings = &mut self.chart.drawings;
        drawings.edit_from_snapshot_with_store_reply_gate(
            id,
            &normalized,
            &baseline,
            |drawings| {
                if let Some(cancel) = prepared_cancel {
                    controller
                        .as_deref_mut()
                        .expect("interactive edit requires controller")
                        .publish_prepared_cancel_parts(model, drawings, cancel)?;
                }
                Ok(())
            },
            cancel_transaction,
            &mut |_| admit_fixed_reply(),
        )?;
        Ok(JsValue::Null)
    }

    fn drawing_bindings(&self, scope: &mut MemoryScope) -> Result<OwnedDrawingBindings, JsError> {
        let mut panels = scoped_vec(self.chart.model.panels.len(), scope)?;
        for panel in &self.chart.model.panels {
            panels.push(DrawingPanelBinding {
                id: panel.id.try_clone_scoped(scope).map_err(memory_error)?,
            });
        }
        let mut axes = scoped_vec(self.chart.model.axes.len(), scope)?;
        for axis in &self.chart.model.axes {
            axes.push(DrawingAxisBinding {
                id: axis.id.try_clone_scoped(scope).map_err(memory_error)?,
                panel: axis.panel.try_clone_scoped(scope).map_err(memory_error)?,
            });
        }
        let mut series = scoped_vec(self.chart.model.series.len(), scope)?;
        for value in &self.chart.model.series {
            series.push(DrawingSeriesBinding {
                id: value.id.try_clone_scoped(scope).map_err(memory_error)?,
                panel: value.panel.try_clone_scoped(scope).map_err(memory_error)?,
                axis_id: value
                    .axis_id
                    .as_ref()
                    .map(|axis| axis.try_clone_scoped(scope).map_err(memory_error))
                    .transpose()?,
            });
        }
        Ok(OwnedDrawingBindings {
            panels,
            axes,
            series,
        })
    }

    fn group_drawing(
        &mut self,
        operation: ChartOperation,
        ids: &JsValue,
        value: &JsValue,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let bindings = self.drawing_bindings(&mut temporary)?;
        let bindings = DrawingBindingContext {
            panels: &bindings.panels,
            axes: &bindings.axes,
            series: &bindings.series,
        };
        let mut context = DrawingEditContext {
            active_gesture: self.context.gesture_active,
            bindings: Some(bindings),
            ..DrawingEditContext::default()
        };
        let receipt = match operation {
            ChartOperation::TranslateDrawings => {
                drawing_edit::translate_drawings(&mut self.chart.drawings, ids, value, &mut context)
            }
            ChartOperation::SetDrawingsStyle => {
                drawing_edit::set_drawings_style(&mut self.chart.drawings, ids, value, &mut context)
            }
            ChartOperation::SetDrawingsVisibility => drawing_edit::set_drawings_visibility(
                &mut self.chart.drawings,
                ids,
                value,
                &mut context,
            ),
            ChartOperation::DuplicateDrawings => {
                drawing_edit::duplicate_drawings(&mut self.chart.drawings, ids, value, &mut context)
            }
            ChartOperation::DeleteDrawings => {
                drawing_edit::delete_drawings(&mut self.chart.drawings, ids, &mut context)
            }
            _ => unreachable!("group operation"),
        }?;
        receipt.to_value_scoped(scope)
    }

    fn delete_drawing(&mut self, id: Option<&JsValue>) -> Result<JsValue, JsError> {
        let selected = self.chart.drawings.selected().cloned();
        let id = match id {
            None | Some(JsValue::Undefined) => selected.as_ref(),
            Some(JsValue::String(id)) => Some(id),
            Some(_) => None,
        };
        let baseline = self.drawing_mutation_baseline();
        if let Some(id) = id
            && self.controller.as_deref().is_some_and(|controller| {
                controller.gesture_kind() == Some("create")
                    && controller.gesture_drawing_id() == Some(id)
            })
            && !baseline.iter().any(|drawing| drawing.id == *id)
        {
            self.controller_operation(|controller, context| {
                controller.cancel(context, false, false)
            })?;
            return Ok(JsValue::Bool(false));
        }
        let removed = match id {
            Some(id) => {
                self.drawing_mutation_from(baseline, |drawings, baseline, before_mutation| {
                    drawings.remove_from_snapshot(id, baseline, before_mutation)
                })?
            }
            None => false,
        };
        Ok(JsValue::Bool(removed))
    }

    fn select_drawing(
        &mut self,
        id: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let next = match id {
            JsValue::Null => None,
            JsValue::String(id) => {
                if !self
                    .chart
                    .drawings
                    .items()
                    .iter()
                    .any(|drawing| drawing.id == *id && drawing.visible != Some(false))
                {
                    return Err(ordinary_error("Missing or hidden drawing"));
                }
                Some(id.clone())
            }
            _ => return Err(ordinary_error("Missing or hidden drawing")),
        };
        if self.chart.drawings.selected() == next.as_ref() {
            admit_fixed_reply()?;
            return Ok(JsValue::Null);
        }
        let mut prepared_cancel = if self.controller.is_some() {
            Some(self.controller_operation(|controller, context| {
                controller.prepare_cancel(context, false, false)
            })?)
        } else {
            None
        };
        let controller = &mut self.controller;
        let model = &mut self.chart.model;
        self.chart
            .drawings
            .select_with_store_reply_gate(next.as_ref(), &mut |drawings| {
                admit_fixed_reply()?;
                if let Some(cancel) = prepared_cancel.take() {
                    controller
                        .as_deref_mut()
                        .expect("prepared selection cancel requires controller")
                        .publish_prepared_cancel_parts(model, drawings, cancel)?;
                }
                Ok(())
            })?;
        Ok(JsValue::Null)
    }

    fn undo_redo(
        &mut self,
        redo: bool,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let active = self
            .controller
            .as_deref()
            .is_some_and(|controller| controller.gesture_kind().is_some());
        let mut prepared_cancel = if active {
            Some(self.controller_operation(|controller, context| {
                controller.prepare_cancel(context, false, false)
            })?)
        } else {
            None
        };
        if active && !redo {
            admit_fixed_reply()?;
            let cancel = prepared_cancel.expect("active undo prepared cancel");
            self.controller_operation(|controller, context| {
                controller.publish_prepared_cancel(context, cancel)
            })?;
            return Ok(JsValue::Null);
        }
        let controller = &mut self.controller;
        let model = &mut self.chart.model;
        let mut gate = |drawings: &mut DrawingStore| {
            admit_fixed_reply()?;
            if let Some(cancel) = prepared_cancel.take() {
                controller
                    .as_deref_mut()
                    .expect("prepared history cancel requires controller")
                    .publish_prepared_cancel_parts(model, drawings, cancel)?;
            }
            Ok(())
        };
        if redo {
            self.chart.drawings.redo_with_store_reply_gate(&mut gate)?;
        } else {
            self.chart.drawings.undo_with_store_reply_gate(&mut gate)?;
        }
        Ok(JsValue::Null)
    }

    fn load_drawings(
        &mut self,
        input: &JsValue,
        admit_fixed_reply: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let JsValue::String(text) = input else {
            return Err(type_error("Drawing document string required"));
        };
        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut temporary = memory.scope();
        let (mut panels, _panels_memory) = memory
            .try_vec_capacity(self.chart.model.panels.len())
            .map_err(memory_error)?;
        for panel in &self.chart.model.panels {
            panels.push(
                panel
                    .id
                    .try_clone_scoped(&mut temporary)
                    .map_err(memory_error)?,
            );
        }
        let model = &self.chart.model;
        let validate_panel = |id: &JsString| Ok(panels.iter().any(|panel| panel == id));
        let validate_binding = |drawing: &crate::drawing_types::Drawing| {
            let mut validation_scope = memory.scope();
            model.validate_drawing_binding(&drawing.to_value_scoped(&mut validation_scope)?, false)
        };
        let style_scope = std::cell::RefCell::new(memory.scope());
        let style_decoder = |style: &JsValue| {
            portable_style_scoped(
                style,
                &["color", "fill"],
                true,
                &mut style_scope.borrow_mut(),
            )
        };
        self.chart.drawings.load_with_reply_gate(
            text,
            &DrawingDocumentContext {
                validate_panel: Some(&validate_panel),
                validate_binding: Some(&validate_binding),
                style_decoder: Some(&style_decoder),
            },
            admit_fixed_reply,
        )?;
        Ok(JsValue::Null)
    }

    fn set_symbol(
        &mut self,
        input: &JsValue,
        before_publish: &mut dyn FnMut() -> Result<(), JsError>,
    ) -> Result<JsValue, JsError> {
        let JsValue::Object(value) = input else {
            return Err(type_error("Invalid symbol metadata"));
        };
        let required = |name: &str| -> Result<&JsString, JsError> {
            match value.get(&key(name)) {
                Some(JsValue::String(value)) if !value.as_units().is_empty() => Ok(value),
                _ => Err(type_error("Invalid symbol metadata")),
            }
        };
        let id = required("id")?;
        let exchange = required("exchange")?;
        let timezone = required("timezone")?;
        let currency = required("currency")?;
        let volume_unit = required("volumeUnit")?;
        let price_decimals = match value.get(&key("priceDecimals")) {
            Some(JsValue::Number(value))
                if value.is_finite() && value.fract() == 0.0 && (0.0..=18.0).contains(value) =>
            {
                *value as u32
            }
            _ => return Err(type_error("Invalid symbol metadata")),
        };
        let tick_size = match value.get(&key("tickSize")) {
            Some(JsValue::Number(value)) if value.is_finite() && *value > 0.0 => *value,
            _ => return Err(type_error("Invalid symbol metadata")),
        };
        let adjustment = match value.get(&key("adjustment")).and_then(string) {
            Some(value) if is_text(value, "raw") => Adjustment::Raw,
            Some(value) if is_text(value, "split") => Adjustment::Split,
            Some(value) if is_text(value, "total-return") => Adjustment::TotalReturn,
            _ => return Err(type_error("Invalid symbol metadata")),
        };
        markets::zoned_parts(self.host, 0.0, timezone)?;

        let memory = self.chart.ingestion.data().store().memory_context().clone();
        let mut scope = memory.scope();
        let symbol = Symbol {
            id: id.try_clone_scoped(&mut scope).map_err(memory_error)?,
            exchange: exchange
                .try_clone_scoped(&mut scope)
                .map_err(memory_error)?,
            timezone: timezone
                .try_clone_scoped(&mut scope)
                .map_err(memory_error)?,
            currency: currency
                .try_clone_scoped(&mut scope)
                .map_err(memory_error)?,
            volume_unit: volume_unit
                .try_clone_scoped(&mut scope)
                .map_err(memory_error)?,
            price_decimals,
            tick_size,
            adjustment,
        };
        let record = symbol_record_scoped(value, &memory, &mut scope)?;
        let symbol_bytes = [
            &symbol.id,
            &symbol.exchange,
            &symbol.timezone,
            &symbol.currency,
            &symbol.volume_unit,
        ]
        .into_iter()
        .try_fold(0usize, |bytes, value| {
            bytes
                .checked_add(
                    value
                        .len_utf16()
                        .checked_mul(size_of::<u16>())
                        .ok_or_else(|| scope.allocation_failure().into_js_error())?,
                )
                .ok_or_else(|| scope.allocation_failure().into_js_error())
        })?;
        let mut walk_scope = memory.scope();
        let record_bytes = crate::js_value_heap_bytes_scoped(&record, &mut walk_scope)?;
        drop(walk_scope);
        let retained_bytes = symbol_bytes
            .checked_add(record_bytes)
            .ok_or_else(|| scope.allocation_failure().into_js_error())?;
        let symbol_memory = scope
            .split_persistent(retained_bytes)
            .map_err(memory_error)?;
        let prepared = self
            .chart
            .prepare_symbol_publication(symbol, record, symbol_memory);
        before_publish()?;
        self.chart.publish_symbol(prepared);
        Ok(JsValue::Null)
    }

    fn inspect(&self, scope: &mut MemoryScope) -> Result<JsValue, JsError> {
        let store = self.chart.ingestion.data().store();
        let last_bar = if store.length() == 0 {
            JsValue::Null
        } else {
            let bar = store.at(store.length() - 1).expect("last bar");
            scoped_object(
                [
                    ("time", JsValue::Number(bar.time)),
                    ("open", JsValue::Number(bar.open)),
                    ("high", JsValue::Number(bar.high)),
                    ("low", JsValue::Number(bar.low)),
                    ("close", JsValue::Number(bar.close)),
                    ("volume", JsValue::Number(bar.volume)),
                ],
                scope,
            )?
        };
        let mut series = scoped_vec(self.chart.model.series.len(), scope)?;
        for value in &self.chart.model.series {
            series.push(inspect_series_value(value, scope)?);
        }
        let mut panels = scoped_vec(self.chart.model.panels.len(), scope)?;
        for panel in &self.chart.model.panels {
            panels.push(panel.to_js_value_scoped(scope).map_err(memory_error)?);
        }
        let mut axes = scoped_vec(self.chart.model.axes.len(), scope)?;
        for axis in &self.chart.model.axes {
            axes.push(axis.to_js_value_scoped(scope).map_err(memory_error)?);
        }
        let mut drawings = scoped_vec(self.chart.drawings.items().len(), scope)?;
        for drawing in self.chart.drawings.items() {
            drawings.push(drawing.to_value_scoped(scope)?);
        }
        let view = scoped_object(
            [
                ("from", JsValue::Number(self.chart.model.view.from)),
                ("to", JsValue::Number(self.chart.model.view.to)),
            ],
            scope,
        )?;
        let mut entries = scoped_vec(16, scope)?;
        push_scoped_entry(&mut entries, "view", view, scope)?;
        push_scoped_entry(
            &mut entries,
            "theme",
            self.chart
                .model
                .theme()
                .try_clone_scoped(scope)
                .map_err(memory_error)?,
            scope,
        )?;
        push_scoped_entry(&mut entries, "panels", JsValue::Array(panels), scope)?;
        push_scoped_entry(&mut entries, "axes", JsValue::Array(axes), scope)?;
        push_scoped_entry(
            &mut entries,
            "drawingTarget",
            self.context
                .drawing_target
                .as_ref()
                .map(|value| value.try_clone_scoped(scope).map_err(memory_error))
                .transpose()?
                .unwrap_or(JsValue::Null),
            scope,
        )?;
        push_scoped_entry(&mut entries, "series", JsValue::Array(series), scope)?;
        if let Some(symbol) = &self.chart.symbol_record {
            push_scoped_entry(
                &mut entries,
                "symbol",
                symbol.try_clone_scoped(scope).map_err(memory_error)?,
                scope,
            )?;
        }
        push_scoped_entry(
            &mut entries,
            "storedBars",
            JsValue::Number(store.length() as f64),
            scope,
        )?;
        push_scoped_entry(&mut entries, "lastBar", last_bar, scope)?;
        push_scoped_entry(&mut entries, "drawings", JsValue::Array(drawings), scope)?;
        push_scoped_entry(
            &mut entries,
            "selected",
            self.chart
                .drawings
                .selected()
                .map(|value| {
                    value
                        .try_clone_scoped(scope)
                        .map(JsValue::String)
                        .map_err(memory_error)
                })
                .transpose()?
                .unwrap_or(JsValue::Null),
            scope,
        )?;
        push_scoped_entry(
            &mut entries,
            "tool",
            self.context
                .tool
                .as_ref()
                .map(|value| {
                    value
                        .try_clone_scoped(scope)
                        .map(JsValue::String)
                        .map_err(memory_error)
                })
                .transpose()?
                .unwrap_or(JsValue::Null),
            scope,
        )?;
        push_scoped_entry(
            &mut entries,
            "pointers",
            JsValue::Number(self.context.pointer_count as f64),
            scope,
        )?;
        push_scoped_entry(
            &mut entries,
            "gesture",
            self.context
                .gesture_kind
                .as_ref()
                .map(|value| {
                    value
                        .try_clone_scoped(scope)
                        .map(JsValue::String)
                        .map_err(memory_error)
                })
                .transpose()?
                .unwrap_or(JsValue::Null),
            scope,
        )?;
        JsObject::try_from_entries_scoped(entries, scope)
            .map(JsValue::Object)
            .map_err(memory_error)
    }
}
