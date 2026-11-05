use barochart_core::contracts::js_to_string_scoped;
use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::drawing_geometry::DrawingGeometryCache;
use barochart_core::drawings::DrawingStore;
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::interaction::{InteractionContext, OwnedInteractionState};
use barochart_core::model_state::{ModelState, VisibleRange};
use barochart_core::series_cache::SeriesCaches;
use barochart_core::{Host, HostError};

use barochart_js::json::JsValue;
use barochart_js::memory::{MemoryAccount, MemoryContext, MemoryScope, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

fn text(value: &str) -> JsValue {
    JsValue::String(JsString::from_str(value))
}

fn assert_text(value: &JsValue, expected: &str) {
    let JsValue::String(value) = value else {
        panic!("string required: {value:?}");
    };
    assert_eq!(value, &JsString::from_str(expected));
}

struct NoZones;

impl Host for NoZones {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }

    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }

    fn log(&self, _: i32, _: &str) {}
}

#[test]
fn retained_text_replacement_is_quota_atomic_and_releases_on_drop() {
    let account = MemoryAccount::new(512, OomStyle::RangeErrorCapitalized);
    let memory = MemoryContext::accounted(&account);
    let mut state = OwnedInteractionState::new_with_memory(memory).unwrap();
    let baseline = account.snapshot().requested_live_bytes;

    let oversized = text(&"x".repeat(512));
    let error = state.set_text(&oversized).unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_text(state.text(), "Note");
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    state.set_text(&text("replacement")).unwrap();
    assert_text(state.text(), "replacement");
    assert!(account.snapshot().requested_live_bytes > baseline);
    state.set_text(&text("x")).unwrap();
    assert_text(state.text(), "x");
    assert!(account.snapshot().requested_live_bytes <= baseline);

    drop(state);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn native_ui_constructor_owns_raw_values_in_the_selected_account() {
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let memory = MemoryContext::accounted(&account);
    let state = OwnedInteractionState::from_native_ui_with_memory(
        JsString::from_str("text"),
        text(&"n".repeat(257)),
        Some(text(&"t".repeat(513))),
        Some((12.0, 24.0)),
        memory,
    )
    .unwrap();
    assert!(account.snapshot().requested_live_bytes >= 1_500);
    assert_eq!(state.crosshair_value(), Some((12.0, 24.0)));
    drop(state);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn scoped_array_to_string_fails_before_growing_past_the_engine_quota() {
    let input = JsValue::Array((0..128).map(|_| text("abcdefgh")).collect());
    let account = MemoryAccount::new(128, OomStyle::InternalErrorLowercase);
    let mut scope = MemoryScope::new(&account);
    let error = js_to_string_scoped(&input, NumberDialect::PLATFORM, &mut scope).unwrap_err();
    assert_eq!(error.name, "InternalError");
    assert_eq!(error.message, JsString::from_str("out of memory"));
    drop(scope);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn oversized_pointer_id_fails_without_inserting_or_leaking_an_entry() {
    let account = MemoryAccount::new(1_024, OomStyle::RangeErrorCapitalized);
    let memory = MemoryContext::accounted(&account);
    let mut state = OwnedInteractionState::new_with_memory(memory).unwrap();
    let baseline = account.snapshot().requested_live_bytes;

    let data = ModelDataState::new(
        StoreOptions::default(),
        vec![Bar {
            time: 1_700_000_000_000.0,
            open: 1.0,
            high: 2.0,
            low: 0.0,
            close: 1.0,
            volume: 1.0,
        }],
    )
    .unwrap();
    let mut model = ModelState::new(data.store(), &JsValue::Undefined).unwrap();
    model.view = VisibleRange {
        from: -0.5,
        to: 0.5,
    };
    let mut indicators = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let mut drawings = DrawingStore::with_defaults(NumberDialect::PLATFORM);
    let mut series_caches = SeriesCaches::new();
    let mut geometry_cache = DrawingGeometryCache::new(4);
    let host = NoZones;
    let mut context = InteractionContext {
        model: &mut model,
        store: data.store(),
        indicators: &mut indicators,
        drawings: &mut drawings,
        series_caches: &mut series_caches,
        geometry_cache: &mut geometry_cache,
        host: &host,
        width: 640.0,
        height: 360.0,
    };

    let pointer = text(&"p".repeat(1_024));
    let error = state
        .down(&mut context, pointer, 10.0, 10.0, 8.0)
        .unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_eq!(state.pointer_count(), 0);
    assert_eq!(state.gesture_kind(), None);
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    drop(state);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn scoped_controller_snapshot_is_fallible_and_does_not_mutate_the_source() {
    let state_account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let mut state =
        OwnedInteractionState::new_with_memory(MemoryContext::accounted(&state_account)).unwrap();
    state.set_text(&text(&"memo".repeat(256))).unwrap();

    let output_account = MemoryAccount::new(128, OomStyle::InternalErrorLowercase);
    let mut output_scope = MemoryScope::new(&output_account);
    let error = state.to_js_value_scoped(&mut output_scope).unwrap_err();
    assert_eq!(error.name, "InternalError");
    assert_text(state.text(), &"memo".repeat(256));
    drop(output_scope);
    assert_eq!(output_account.snapshot().requested_live_bytes, 0);

    drop(state);
    assert_eq!(state_account.snapshot().requested_live_bytes, 0);
}

#[test]
fn source_owner_capture_keeps_its_own_lease_until_the_token_drops() {
    let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
    let state = OwnedInteractionState::from_native_ui_with_memory(
        JsString::from_str("text"),
        text(&"capture".repeat(128)),
        None,
        None,
        MemoryContext::accounted(&account),
    )
    .unwrap();
    let state_bytes = account.snapshot().requested_live_bytes;
    let token = state.capture_source_owner().unwrap();
    assert!(account.snapshot().requested_live_bytes > state_bytes);

    drop(state);
    assert!(account.snapshot().requested_live_bytes > 0);
    drop(token);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn published_target_replacement_swaps_its_lease_atomically() {
    let account = MemoryAccount::new(512, OomStyle::RangeErrorCapitalized);
    let mut state =
        OwnedInteractionState::new_with_memory(MemoryContext::accounted(&account)).unwrap();
    let baseline = account.snapshot().requested_live_bytes;

    let error = state
        .publish_drawing_target(Some(text(&"target".repeat(128))))
        .unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert!(state.drawing_target().is_none());
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    state.publish_drawing_target(Some(text("price"))).unwrap();
    assert!(account.snapshot().requested_live_bytes > baseline);
    state.publish_drawing_target(None).unwrap();
    assert_eq!(account.snapshot().requested_live_bytes, baseline);

    drop(state);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
