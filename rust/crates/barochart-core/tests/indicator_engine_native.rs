use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::indicator_engine::{IndicatorEngine, IndicatorEngineOptions};
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

const START: f64 = 1_700_000_000_000.0;

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

fn data() -> ModelDataState {
    ModelDataState::new(
        StoreOptions::default(),
        (0..40)
            .map(|index| {
                let close = 100.0 + (index % 7) as f64;
                Bar {
                    time: START + index as f64 * 60_000.0,
                    open: close - 1.0,
                    high: close + 2.0,
                    low: close - 2.0,
                    close,
                    volume: (index + 1) as f64,
                }
            })
            .collect(),
    )
    .unwrap()
}

fn params(period: f64) -> JsValue {
    let mut value = JsObject::new();
    value.insert(JsString::from_str("period"), JsValue::Number(period));
    JsValue::Object(value)
}

fn engine(period: f64, data: &ModelDataState, host: &dyn Host) -> IndicatorEngine {
    let mut engine = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    engine
        .add(
            data.store(),
            host,
            &JsValue::String(JsString::from_str("ema")),
            &JsValue::String(JsString::from_str("ema")),
            &params(period),
        )
        .unwrap();
    engine
}

#[test]
fn native_capture_and_restore_move_exact_arrays_checkpoints_and_metadata() {
    let host = NoZones;
    let source_data = data();
    let source = engine(5.0, &source_data, &host);
    let (source_token, snapshots) = source.capture_native_entries(source_data.store());
    assert!(source.validate_native_capture(source_data.store(), &source_token));
    assert_eq!(snapshots.len(), 1);
    let expected_bits = snapshots[0].arrays[0]
        .iter()
        .map(|value| value.to_bits())
        .collect::<Vec<_>>();
    let expected_keys = snapshots[0].checkpoints.keys().copied().collect::<Vec<_>>();
    let expected_metadata = (
        snapshots[0].revision.to_bits(),
        snapshots[0].dirty,
        snapshots[0].dirty_to,
        snapshots[0].invalidated,
        snapshots[0].length,
        snapshots[0].computed_from,
        snapshots[0].computed_until,
        snapshots[0].prepared_version.map(f64::to_bits),
    );
    let allocation = snapshots[0].arrays[0].as_ptr();

    let target_data = data();
    let mut target = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let before = target.capture_entries();
    let stage = target
        .stage_native_restore(target_data.store(), snapshots)
        .unwrap();
    assert!(target.is_empty());
    target
        .publish_native_restore(target_data.store(), stage)
        .unwrap();
    assert!(!target.validate_capture(&before));
    let restored = target
        .entry(&JsValue::String(JsString::from_str("ema")))
        .unwrap();
    let values = restored.output_capacity("value").unwrap();
    assert_eq!(values.as_ptr(), allocation);
    assert_eq!(
        values
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        expected_bits
    );
    assert_eq!(restored.checkpoint_keys(), expected_keys);
    assert_eq!(
        (
            restored.revision().to_bits(),
            restored.dirty(),
            restored.dirty_to(),
            restored.invalidated(),
            restored.length(),
            restored.computed_from(),
            restored.computed_until(),
            restored.prepared_version().map(f64::to_bits),
        ),
        expected_metadata
    );
}

#[test]
fn native_restore_rejects_infinite_output_without_mutating_target() {
    let host = NoZones;
    let source_data = data();
    let source = engine(5.0, &source_data, &host);
    let (_, mut snapshots) = source.capture_native_entries(source_data.store());
    snapshots[0].arrays[0][0] = f64::INFINITY;
    let target_data = data();
    let target = IndicatorEngine::new(IndicatorEngineOptions::default()).unwrap();
    let error = match target.stage_native_restore(target_data.store(), snapshots) {
        Ok(_) => panic!("infinite output unexpectedly accepted"),
        Err(error) => error,
    };
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message.to_string_lossy(),
        "Native indicator output finite/NaN"
    );
    assert!(target.is_empty());
}

#[test]
fn native_replacement_keeps_slot_and_moves_candidate_allocation() {
    let host = NoZones;
    let target_data = data();
    let mut target = engine(5.0, &target_data, &host);
    let candidate_data = data();
    let candidate_engine = engine(13.0, &candidate_data, &host);
    let (_, mut snapshots) = candidate_engine.capture_native_entries(candidate_data.store());
    let candidate = snapshots.remove(0);
    let allocation = candidate.arrays[0].as_ptr();
    let before_ids = target.entry_ids();
    let before = target.capture_entries();
    let stage = target
        .stage_native_replacement(
            target_data.store(),
            &JsValue::String(JsString::from_str("ema")),
            candidate,
        )
        .unwrap();
    let receipt = target
        .publish_native_replacement(target_data.store(), stage)
        .unwrap();
    assert_eq!(target.entry_ids(), before_ids);
    assert!(!target.validate_capture(&before));
    assert_eq!(receipt.id, JsString::from_str("ema"));
    let JsValue::Object(ref receipt_params) = receipt.params else {
        panic!("params object required")
    };
    assert!(matches!(
        receipt_params.get(&JsString::from_str("period")),
        Some(JsValue::Number(13.0))
    ));
    assert_eq!(
        target
            .entry(&JsValue::String(JsString::from_str("ema")))
            .unwrap()
            .output_capacity("value")
            .unwrap()
            .as_ptr(),
        allocation
    );
}
