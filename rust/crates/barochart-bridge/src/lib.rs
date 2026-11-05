//! 네이티브 함수 표와 단계별 핸들러를 연결한다.
#![forbid(unsafe_code)]

use barochart_core::Engine;
use barochart_core::data::{ColumnInputs, NumericColumn, seeded_columns_with_memory};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::memory::MemoryScope;
use barochart_js::string::JsString;

/// 배타적으로 빌린 엔진에서 동작하는 네이티브 브리지 핸들러다.
pub type Handler = fn(&mut Engine, &[JsValue]) -> Result<JsValue, JsError>;

/// 현재 단계의 함수 구현 상태다. 알려진 이름은 미구현이어도 supports에서 참이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FunctionStatus {
    /// 실행 가능한 핸들러가 있다. Init의 모델 상태는 후속 통합에서 완성한다.
    Implemented,
    /// JS 전용 또는 이식 대상 밖의 테스트·데모다.
    Reject,
    /// 이후 이식 단계에 구현할 안정 표면이다.
    Pending,
}

/// 단일 함수 표의 한 항목이다.
pub struct FunctionEntry {
    /// 정확한 전역 함수 이름이다.
    pub name: &'static str,
    /// 현재 구현 상태다.
    pub status: FunctionStatus,
    /// 구현 또는 명시적 거절을 담당하는 함수다.
    pub handler: Option<Handler>,
}

pub mod bulk;
mod bulk_handlers;
mod chart_handlers;
mod command_table;
mod commands;
mod data_handlers;
mod input_handlers;
mod manifest;
mod native_jobs_handlers;
pub mod reply_policy;
pub use bulk_handlers::{call_bulk, call_bulk_with_reply_admission};
use commands::{native_command, native_ingestion_command, native_unchanged};
use data_handlers::{native_data_event, native_set_data};
pub use manifest::FUNCTIONS;
use reply_policy::FixedReply;

/// 번들에 정의된 이름인지 돌려준다. 실행 준비 여부는 별도 상태다.
pub fn supports(name: &str) -> bool {
    FUNCTIONS
        .binary_search_by_key(&name, |entry| entry.name)
        .is_ok()
}

/// 구현한 함수를 부르거나 단계적 백엔드의 사용 불가 오류를 돌려준다.
pub fn call(engine: &mut Engine, name: &str, args: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    call_scoped(engine, name, args, &mut scope)
}

/// 반환 payload가 직렬화될 때까지 호출자 scope에 allocation lease를 유지한다.
pub fn call_scoped(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    call_scoped_with_reply_admission(engine, name, args, scope, &mut |_| Ok(()))
}

/// Fixed-reply mutator가 operation-local validation/staging 뒤 owned output admission을 요청한다.
///
/// Census에서 `Staged`인 경로만 callback을 호출한다. 가변 응답, Params durable receipt, lazy read와
/// 아직 `Uncovered`인 fixed mutator의 source 순서는 기존 그대로다.
pub fn call_scoped_with_reply_admission(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
    admit_reply: &mut dyn FnMut(FixedReply) -> Result<(), JsError>,
) -> Result<JsValue, JsError> {
    let implemented = FUNCTIONS
        .binary_search_by_key(&name, |entry| entry.name)
        .ok()
        .is_some_and(|index| FUNCTIONS[index].status == FunctionStatus::Implemented);
    if implemented {
        if let Some(result) =
            input_handlers::call_scoped_with_reply_admission(name, engine, args, scope, admit_reply)
        {
            return result;
        }
        if let Some(result) = chart_handlers::legacy_scoped_with_reply_admission(
            name,
            engine,
            args,
            scope,
            admit_reply,
        ) {
            return result;
        }
        match name {
            "nativeInit" => return native_init_scoped(engine, args, scope),
            "nativeSetData" => {
                return data_handlers::native_set_data_with_reply_gate(engine, args, &mut || {
                    admit_reply(FixedReply::Undefined)
                });
            }
            "nativeDataEvent" => {
                return data_handlers::native_data_event_with_reply_gate(engine, args, &mut || {
                    admit_reply(FixedReply::Undefined)
                });
            }
            "nativeResize" => {
                engine.set_native_size_with_reply_gate(
                    args.first().unwrap_or(&JsValue::Undefined),
                    args.get(1).unwrap_or(&JsValue::Undefined),
                    &mut || admit_reply(FixedReply::Undefined),
                )?;
                return Ok(JsValue::Undefined);
            }
            "nativeIndicator" => {
                return engine.add_legacy_indicator_scoped(
                    args.first().unwrap_or(&JsValue::Undefined),
                    args.get(1).unwrap_or(&JsValue::Undefined),
                    args.get(2).unwrap_or(&JsValue::Undefined),
                    args.get(3).unwrap_or(&JsValue::Undefined),
                    scope,
                );
            }
            "nativeAddSeries" => {
                return engine
                    .chart_mut()
                    .ok_or_else(data_handlers::missing_native_model)?
                    .add_legacy_series_scoped(args.first().unwrap_or(&JsValue::Undefined), scope)
                    .map(JsValue::String);
            }
            "nativeCommand" => {
                return commands::native_command_scoped_with_reply_admission(
                    engine,
                    args,
                    scope,
                    admit_reply,
                );
            }
            "nativeDataIngestionCommand" => {
                return commands::native_ingestion_command_scoped(engine, args, scope);
            }
            "nativeSave" => {
                let (text, memory) = engine
                    .chart()
                    .ok_or_else(data_handlers::missing_drawings)?
                    .drawings()
                    .save_with_memory()?;
                scope
                    .absorb_persistent(memory)
                    .map_err(|error| error.into_js_error())?;
                return Ok(JsValue::String(text));
            }
            "nativeSaveWorkspace" => {
                return engine
                    .save_workspace_scoped(args.first().unwrap_or(&JsValue::Undefined), scope)
                    .map(JsValue::String);
            }
            "nativePreflightWorkspace" => {
                return engine.preflight_workspace_scoped(
                    args.first().unwrap_or(&JsValue::Undefined),
                    args.get(1).unwrap_or(&JsValue::Undefined),
                    scope,
                );
            }
            "nativeSceneJSON" => return chart_handlers::scene_json_scoped(engine, args, scope),
            "nativeRenderFrameJSON" => {
                return chart_handlers::render_frame_json_scoped(engine, args, scope);
            }
            "nativeScenePacket" => return scene_packet_scoped(engine, args, scope),
            "nativeThemeFont" => {
                let chart = engine
                    .chart()
                    .ok_or_else(data_handlers::missing_native_model)?;
                let JsValue::Object(theme) = chart.model().theme() else {
                    unreachable!("model theme")
                };
                return theme
                    .get(&JsString::from_str("font"))
                    .unwrap_or(&JsValue::Undefined)
                    .try_clone_scoped(scope)
                    .map_err(|error| error.into_js_error());
            }
            "nativeIndicatorBuffer" | "nativeAsyncBuffer" | "nativeAsyncTargetBuffer" => {
                let values = read_f64_scoped(engine, name, args, scope)?;
                return float64_object_scoped(values, scope);
            }
            _ => {}
        }
        if name.starts_with("nativeAsync")
            || name.starts_with("nativePrepare")
            || name.starts_with("nativeParams")
            || name.starts_with("nativeWorkspace")
            || matches!(name, "nativeDataAsyncBegin" | "nativeReleaseDataIngestion")
        {
            return engine.native_runtime_call_scoped(&JsString::from_str(name), args, scope);
        }
    }
    match FUNCTIONS
        .binary_search_by_key(&name, |entry| entry.name)
        .ok()
        .and_then(|index| FUNCTIONS[index].handler)
    {
        Some(handler) => handler(engine, args),
        None => Err(JsError::new(
            "UnavailableError",
            JsString::from_str(&format!("{name} is not available in the Rust backend")),
        )),
    }
}

/// typed native F64 반환을 같은 엔진 호출 동안 빌린다. JSON 숫자 재직렬화가 없다.
pub fn read_f64<'a>(
    engine: &'a mut Engine,
    name: &str,
    args: &[JsValue],
) -> Result<&'a [f64], JsError> {
    let mut scope = engine.memory_context().scope();
    read_f64_scoped(engine, name, args, &mut scope)
}

/// Typed 결과 또는 그 앞선 일반 호출의 temporary allocation을 호출 수명에 유지한다.
pub fn read_f64_scoped<'a>(
    engine: &'a mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<&'a [f64], JsError> {
    if name == "nativeAsyncBuffer" {
        return engine.native_async_buffer(args);
    }
    if name == "nativeAsyncTargetBuffer" {
        return engine.native_target_buffer(args).map(|value| &*value);
    }
    if name == "nativeIndicatorBuffer" {
        let (chart, host) = engine.chart_and_host_mut().ok_or_else(|| {
            JsError::new("RangeError", JsString::from_str("Native indicator slice"))
        })?;
        let number = |index| match args.get(index) {
            Some(JsValue::Number(value)) => *value,
            _ => f64::NAN,
        };
        return chart.indicator_buffer_scoped(
            args.first().unwrap_or(&JsValue::Undefined),
            args.get(1).unwrap_or(&JsValue::Undefined),
            number(2),
            number(3),
            host,
            scope,
        );
    }
    call_scoped(engine, name, args, scope)?;
    Err(JsError::new(
        "TypeError",
        JsString::from_str("Float64Array result required"),
    ))
}

/// Typed target writer의 공통 seam이다. 실제 target namespace는 job bridge가 결정한다.
pub fn write_f64(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    source: &[f64],
    capture_before: bool,
) -> Result<Option<Vec<f64>>, JsError> {
    if name != "nativeAsyncTargetBuffer" {
        call(engine, name, args)?;
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Float64Array result required"),
        ));
    }
    let mut before = Vec::new();
    if capture_before && before.try_reserve_exact(source.len()).is_err() {
        return Err(JsError::new(
            "RangeError",
            JsString::from_str("Out of memory"),
        ));
    }
    let target = engine.native_target_buffer(args)?;
    if target.len() != source.len() {
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Float64Array result required"),
        ));
    }
    if capture_before {
        before.extend_from_slice(target);
    }
    target.copy_from_slice(source);
    Ok(capture_before.then_some(before))
}

/// 한 번 빌린 target의 원래 slice를 callback에 노출한 뒤 입력을 복사한다.
/// Callback은 slice를 보관하지 않으며 FFI가 미리 확보한 output에 바로 복사할 수 있다.
pub fn write_f64_scoped(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    source: &[f64],
    scope: &mut MemoryScope,
    before: impl FnOnce(&[f64]) -> Result<(), JsError>,
) -> Result<(), JsError> {
    with_write_f64_target_scoped(engine, name, args, scope, |target| {
        if target.len() != source.len() {
            return Err(JsError::new(
                "TypeError",
                JsString::from_str("Float64Array result required"),
            ));
        }
        before(target)?;
        target.copy_from_slice(source);
        Ok(())
    })
}

/// Typed write target을 한 번 빌리고 caller가 그 실제 길이와 복사 여부를 결정하게 한다.
///
/// Host count/source 검증을 Core handout 뒤에 해야 하는 관찰 ABI가 사용한다. callback은 target을
/// 보관하지 않으며, legacy writer는 위의 wrapper에서 기존 length guard/copy 순서를 유지한다.
pub fn with_write_f64_target_scoped(
    engine: &mut Engine,
    name: &str,
    args: &[JsValue],
    scope: &mut MemoryScope,
    access: impl FnOnce(&mut [f64]) -> Result<(), JsError>,
) -> Result<(), JsError> {
    if name != "nativeAsyncTargetBuffer" {
        call_scoped(engine, name, args, scope)?;
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Float64Array result required"),
        ));
    }
    let target = engine.native_target_buffer(args)?;
    access(target)
}

fn native_async_buffer(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    float64_object(read_f64(engine, "nativeAsyncBuffer", args)?)
}
fn native_target_buffer(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    float64_object(read_f64(engine, "nativeAsyncTargetBuffer", args)?)
}
fn float64_object(values: &[f64]) -> Result<JsValue, JsError> {
    let mut scope = MemoryScope::unaccounted(barochart_js::memory::OomStyle::RangeErrorCapitalized);
    float64_object_scoped(values, &mut scope)
}
fn float64_object_scoped(values: &[f64], scope: &mut MemoryScope) -> Result<JsValue, JsError> {
    JsObject::try_from_indexed_values_scoped(values.iter().copied().map(JsValue::Number), scope)
        .map(JsValue::Object)
        .map_err(|error| error.into_js_error())
}

/// 실제 차트 장면을 native v1 owned packet으로 만든다.
pub fn packet(
    engine: &mut Engine,
    args: &[JsValue],
) -> Result<barochart_core::native_packet::NativeCommandPacket, JsError> {
    let mut scope = engine.memory_context().scope();
    packet_scoped(engine, args, &mut scope)
}

/// Packet과 별개인 검증·문자열 임시 버퍼를 호출자의 scope에서 유지한다.
pub fn packet_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<barochart_core::native_packet::NativeCommandPacket, JsError> {
    use barochart_core::native_packet::{
        NativePacketLayerView, NativePacketOptions, pack_native_commands_scoped,
        pack_native_layers_scoped,
    };
    let memory = engine.memory_context().clone();
    let undefined = JsValue::Undefined;
    let arg = |i| args.get(i).unwrap_or(&undefined);
    if matches!(arg(0),JsValue::String(value) if value.as_units().iter().copied().eq("frame".encode_utf16()))
    {
        let frame = engine.render_frame(arg(1), arg(2), arg(3), chart_handlers::truthy(arg(4)))?;
        let layers = [
            frame
                .base_changed
                .then(|| NativePacketLayerView::Commands(frame.base.commands())),
            frame
                .drawings_changed
                .then(|| NativePacketLayerView::Commands(frame.drawings.commands())),
            Some(NativePacketLayerView::Commands(frame.hover.commands())),
        ];
        return pack_native_layers_scoped(
            &layers,
            NativePacketOptions {
                mode: arg(0),
                width: arg(2),
                height: arg(3),
                background: frame.base.metadata().background(),
                stats: frame.stats,
            },
            barochart_js::num::NumberDialect::PLATFORM,
            &memory,
            scope,
        );
    }
    if !matches!(arg(0),JsValue::String(value) if value.as_units().iter().copied().eq("scene".encode_utf16()))
    {
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Native packet mode"),
        ));
    }
    let scene = engine.build_scene(arg(2), arg(3))?;
    let JsValue::Object(record) = scene.value() else {
        unreachable!("scene object")
    };
    pack_native_commands_scoped(
        &[Some(scene.value())],
        NativePacketOptions {
            mode: arg(0),
            width: arg(2),
            height: arg(3),
            background: record
                .get(&JsString::from_str("background"))
                .unwrap_or(&undefined),
            stats: record
                .get(&JsString::from_str("stats"))
                .unwrap_or(&undefined),
        },
        barochart_js::num::NumberDialect::PLATFORM,
        &memory,
        scope,
    )
}

fn native_scene_packet(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    scene_packet_scoped(engine, args, &mut scope)
}
fn scene_packet_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let packet = packet_scoped(engine, args, scope)?;
    let metadata = packet
        .metadata
        .try_clone_scoped(scope)
        .map_err(|error| error.into_js_error())?;
    let numbers = float64_object_scoped(&packet.numbers, scope)?;
    JsObject::try_from_entries_scoped(
        [
            (
                JsString::try_from_str("metadata", scope).map_err(|error| error.into_js_error())?,
                JsValue::String(metadata),
            ),
            (
                JsString::try_from_str("numbers", scope).map_err(|error| error.into_js_error())?,
                numbers,
            ),
        ],
        scope,
    )
    .map(JsValue::Object)
    .map_err(|error| error.into_js_error())
}

fn native_indicator_buffer(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let values = read_f64(engine, "nativeIndicatorBuffer", args)?;
    let mut object = JsObject::new();
    for (index, value) in values.iter().enumerate() {
        object.insert(
            JsString::from_str(&index.to_string()),
            JsValue::Number(*value),
        );
    }
    Ok(JsValue::Object(object))
}

fn reject_source(_: &mut Engine, _: &[JsValue]) -> Result<JsValue, JsError> {
    let mut error = JsError::new(
        "UnavailableError",
        JsString::from_str("Indicator source registration requires the javaScript backend"),
    );
    error.code = Some("JAVASCRIPT_BACKEND_REQUIRED".to_owned());
    Err(error)
}

fn native_echo(_: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    Ok(args.first().cloned().unwrap_or(JsValue::Undefined))
}

// 데이터 후보만 이 단계에서 만든다. 전체 options/장면/지표 모델은 후속 단계에서 같은 후보에 연결한다.
fn native_init(engine: &mut Engine, args: &[JsValue]) -> Result<JsValue, JsError> {
    let mut scope = engine.memory_context().scope();
    native_init_scoped(engine, args, &mut scope)
}

fn native_init_scoped(
    engine: &mut Engine,
    args: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    if let Some(options) = args.get(1)
        && !matches!(
            options,
            JsValue::Undefined | JsValue::Null | JsValue::Object(_)
        )
    {
        return Err(JsError::new(
            "TypeError",
            JsString::from_str("Chart options object"),
        ));
    }
    let mut data = engine.stage_empty_data()?;
    let count = match args.first() {
        None | Some(JsValue::Undefined) => 100_000.0,
        Some(JsValue::Number(value)) => *value,
        _ => return Err(count_error()),
    };
    if !count.is_finite() || !(0.0..=4_194_304.0).contains(&count) || count.fract() != 0.0 {
        return Err(count_error());
    }
    let (columns, _columns_memory) =
        seeded_columns_with_memory(count as usize, 42, data.store().memory_context())?;
    data.store_mut().set_columns(
        &ColumnInputs {
            time: NumericColumn::F64(&columns.time),
            open: NumericColumn::F64(&columns.open),
            high: NumericColumn::F64(&columns.high),
            low: NumericColumn::F64(&columns.low),
            close: NumericColumn::F64(&columns.close),
            volume: NumericColumn::F64(&columns.volume),
        },
        Some(count as usize),
    )?;
    let candidate =
        engine.stage_chart_scoped(data, args.get(1).unwrap_or(&JsValue::Null), scope)?;
    engine.install_chart(candidate)?;
    Ok(JsValue::Number(count))
}

fn count_error() -> JsError {
    JsError::new(
        "RangeError",
        JsString::from_str("Synthetic bar count: limit 4194304"),
    )
}
