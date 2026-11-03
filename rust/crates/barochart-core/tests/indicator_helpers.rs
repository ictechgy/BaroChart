use barochart_core::indicator_helpers;

use barochart_core::data::Bar;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16, stringify_json};
use barochart_js::string::JsString;
use indicator_helpers::{
    CheckpointFieldOrder, EXTREME_WIRE_KEYS, ExtremeQueue, RING_WIRE_KEYS, Ring,
    SMOOTHER_WIRE_KEYS, Smoother, VWMA_WIRE_KEYS, VwmaAccumulator, canonical_checkpoint,
    ema_recover, exact_state_equal, extreme, rebase_bollinger, rebase_roll, roll, sma_roll, smooth,
    true_range, vwma_accumulate, vwma_step,
};

#[test]
fn optional_helper_order_tracks_lazy_creation_and_imported_key_order() {
    let fields = ["e", "r"];
    let mut order = CheckpointFieldOrder::empty();
    let empty = order.ordered_present_object(&[("e", None), ("r", None)]);
    assert!(matches!(empty, JsValue::Object(ref object) if object.is_empty()));
    order.touch(1);
    let only_r = order.ordered_present_object(&[("e", None), ("r", Some(JsValue::Number(2.0)))]);
    let partial = CheckpointFieldOrder::capture_present(&only_r, &fields).unwrap();
    assert_eq!(partial.indices(), &[1]);
    order.touch(0);
    order.touch(1);
    let snapshot = order.ordered_present_object(&[
        ("e", Some(JsValue::Number(1.0))),
        ("r", Some(JsValue::Number(2.0))),
    ]);
    let JsValue::Object(object) = &snapshot else {
        panic!("object required")
    };
    assert_eq!(
        object
            .iter()
            .map(|(key, _)| key.to_string_lossy())
            .collect::<Vec<_>>(),
        ["r", "e"]
    );
    let imported = CheckpointFieldOrder::capture_present(&snapshot, &fields).unwrap();
    assert_eq!(imported.indices(), &[1, 0]);
    assert!(CheckpointFieldOrder::capture_present(&snapshot, &["e"]).is_none());
}

fn bar(close: f64, volume: f64) -> Bar {
    Bar {
        time: 0.0,
        open: close,
        high: close,
        low: close,
        close,
        volume,
    }
}

fn value(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn text(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Lossless)).unwrap()
}

#[test]
fn raw_roll_wrap_reset_and_sma_recovery_remain_distinct() {
    let mut raw = None;
    assert!(raw.is_none());
    assert!(roll(&mut raw, 1.0, 3).is_nan());
    assert!(roll(&mut raw, 2.0, 3).is_nan());
    assert_eq!(roll(&mut raw, 3.0, 3), 2.0);
    assert_eq!(roll(&mut raw, 4.0, 3), 3.0);
    let raw_state = raw.as_ref().unwrap();
    assert_eq!(raw_state.values, [4.0, 2.0, 3.0]);
    assert_eq!(raw_state.head, 1.0);
    assert_eq!(raw_state.sum, 9.0);
    assert_eq!(
        text(&raw_state.to_wire()),
        r#"{"a":[4,2,3],"head":1,"sum":9}"#
    );

    let mut raw_cancellation = None;
    assert!(roll(&mut raw_cancellation, 1e16, 2).is_nan());
    assert_eq!(roll(&mut raw_cancellation, 1.0, 2), 5e15);
    assert_eq!(roll(&mut raw_cancellation, 2.0, 2), 1.0);

    let mut sma = None;
    assert!(sma_roll(&mut sma, 1e16, 2).is_nan());
    assert_eq!(sma_roll(&mut sma, 1.0, 2), 5e15);
    assert_eq!(sma_roll(&mut sma, 2.0, 2), 1.5);
    assert_eq!(sma.as_ref().unwrap().sum, 3.0);

    let mut raw_overflow = None;
    assert!(roll(&mut raw_overflow, f64::MAX, 2).is_nan());
    assert!(roll(&mut raw_overflow, f64::MAX, 2).is_infinite());
    let mut sma_overflow = None;
    assert!(sma_roll(&mut sma_overflow, f64::MAX, 2).is_nan());
    assert!(sma_roll(&mut sma_overflow, f64::MAX, 2).is_nan());
    assert!(sma_overflow.as_ref().unwrap().sum.is_infinite());

    let mut raw_one = None;
    let mut sma_one = None;
    assert_eq!(roll(&mut raw_one, -0.0, 1).to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        sma_roll(&mut sma_one, -0.0, 1).to_bits(),
        (-0.0_f64).to_bits()
    );

    assert!(roll(&mut raw, f64::NAN, 3).is_nan());
    let reset = raw.as_ref().unwrap();
    assert!(reset.values.is_empty());
    assert_eq!(reset.head, 0.0);
    assert_eq!(reset.sum.to_bits(), 0.0_f64.to_bits());
}

#[test]
fn rebase_uses_fifo_order_and_smoother_canonicalization_does_not_mutate_live_state() {
    assert_eq!(RING_WIRE_KEYS, ["a", "head", "sum"]);
    assert_eq!(SMOOTHER_WIRE_KEYS, ["count", "sum", "value"]);
    assert_eq!(EXTREME_WIRE_KEYS, ["a", "head"]);
    assert_eq!(VWMA_WIRE_KEYS, ["a", "head", "sums", "invalid", "positive"]);
    let mut ring = Ring::from_parts(vec![4.0, 2.0, 3.0], 1.0, 2.0);
    assert_eq!(rebase_roll(&mut ring), 9.0);
    assert_eq!(ring.sum, 9.0);

    let mut state = None;
    assert!(smooth(&mut state, 1.0, 3, 0.5).is_nan());
    assert!(smooth(&mut state, 2.0, 3, 0.5).is_nan());
    assert_eq!(smooth(&mut state, 3.0, 3, 0.5), 2.0);
    let live = state.as_ref().unwrap();
    assert_eq!(live.sum, 6.0);
    assert_eq!(
        text(&canonical_checkpoint(&live.to_wire())),
        r#"{"count":3,"sum":0,"value":2}"#
    );
    assert_eq!(state.as_ref().unwrap().sum, 6.0);
    assert_eq!(smooth(&mut state, 5.0, 3, 0.5), 3.5);

    let mut generic_overflow = Some(Smoother::from_parts(2.0, 0.0, -f64::MAX));
    assert!(smooth(&mut generic_overflow, f64::MAX, 2, 0.5).is_infinite());
    let mut ema_overflow = Some(Smoother::from_parts(2.0, 0.0, -f64::MAX));
    assert_eq!(ema_recover(&mut ema_overflow, f64::MAX, 2, 0.5), 0.0);
    assert_eq!(
        ema_overflow.as_ref().unwrap().value.to_bits(),
        0.0_f64.to_bits()
    );

    let mut corrupt = Some(Smoother::from_parts(3.0, 0.0, f64::INFINITY));
    assert!(ema_recover(&mut corrupt, 5.0, 3, 0.5).is_nan());
    let corrupt = corrupt.unwrap();
    assert_eq!(corrupt.count, 1.0);
    assert_eq!(corrupt.sum, 5.0);
    assert!(corrupt.value.is_nan());

    let mut reset = None;
    assert!(smooth(&mut reset, f64::INFINITY, 3, 0.5).is_nan());
    let reset = reset.unwrap();
    assert_eq!(reset.count, 0.0);
    assert_eq!(reset.sum.to_bits(), 0.0_f64.to_bits());
    assert!(reset.value.is_nan());
}

#[test]
fn monotonic_extreme_handles_ties_expiry_and_canonical_snapshot_without_live_mutation() {
    let mut maximum = None;
    assert!(extreme(&mut maximum, 1.0, 3, 0, true).is_nan());
    assert!(extreme(&mut maximum, 3.0, 3, 1, true).is_nan());
    assert_eq!(extreme(&mut maximum, 2.0, 3, 2, true), 3.0);
    assert_eq!(extreme(&mut maximum, 0.0, 3, 3, true), 3.0);
    assert_eq!(extreme(&mut maximum, -1.0, 3, 4, true), 2.0);
    let live_head = maximum.as_ref().unwrap().head;
    assert!(live_head > 0.0);
    assert_eq!(
        text(&maximum.as_ref().unwrap().canonical_snapshot()),
        r#"{"a":[[2,2],[3,0],[4,-1]],"head":0}"#
    );
    assert_eq!(maximum.as_ref().unwrap().head, live_head);

    let mut zeros = None;
    assert_eq!(
        extreme(&mut zeros, -0.0, 1, 0, true).to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(
        extreme(&mut zeros, 0.0, 1, 1, true).to_bits(),
        0.0_f64.to_bits()
    );
    assert_eq!(zeros.unwrap().entries.len(), 1);

    let mut minimum = None;
    assert!(extreme(&mut minimum, 3.0, 2, 0, false).is_nan());
    assert_eq!(extreme(&mut minimum, 1.0, 2, 1, false), 1.0);
    assert_eq!(extreme(&mut minimum, 2.0, 2, 2, false), 1.0);
    assert_eq!(extreme(&mut minimum, 4.0, 2, 3, false), 2.0);
    let mut minimum_zero = None;
    assert_eq!(
        extreme(&mut minimum_zero, 0.0, 1, 0, false).to_bits(),
        0.0_f64.to_bits()
    );
    assert_eq!(
        extreme(&mut minimum_zero, -0.0, 1, 1, false).to_bits(),
        (-0.0_f64).to_bits()
    );

    let mut compacted = None;
    for index in 0..260 {
        assert_eq!(
            extreme(&mut compacted, 1_000.0 - index as f64, 1, index, true),
            1_000.0 - index as f64
        );
    }
    let compacted = compacted.unwrap();
    assert!(compacted.head <= 256.0);
    assert!(compacted.entries.len() <= 4);
}

#[test]
fn compensated_vwma_recovers_zero_volume_overflow_and_dominant_expiry() {
    let mut ordinary = VwmaAccumulator::default();
    assert!(vwma_step(&mut ordinary, &bar(10.0, 1.0), 0, 2).is_nan());
    assert_eq!(vwma_step(&mut ordinary, &bar(20.0, 3.0), 1, 2), 17.5);

    let mut zero = VwmaAccumulator::default();
    assert!(vwma_step(&mut zero, &bar(10.0, 0.0), 0, 2).is_nan());
    assert!(vwma_step(&mut zero, &bar(20.0, 0.0), 1, 2).is_nan());
    assert_eq!(zero.sums, [[0.0, 0.0]; 3]);

    let mut dominant = VwmaAccumulator::default();
    assert!(vwma_step(&mut dominant, &bar(1e300, 1.0), 0, 2).is_nan());
    assert_eq!(vwma_step(&mut dominant, &bar(1.0, 1.0), 1, 2), 5e299);
    assert_eq!(vwma_step(&mut dominant, &bar(2.0, 1.0), 2, 2), 1.5);

    let mut overflow = VwmaAccumulator::default();
    assert!(vwma_step(&mut overflow, &bar(f64::MAX, 2.0), 0, 2).is_nan());
    assert!(vwma_step(&mut overflow, &bar(1.0, 1.0), 1, 2).is_nan());
    assert_eq!(vwma_step(&mut overflow, &bar(2.0, 1.0), 2, 2), 1.5);

    let empty = VwmaAccumulator::default();
    assert_eq!(
        text(&empty.to_wire()),
        r#"{"a":[],"head":0,"sums":[[0,0],[0,0],[0,0]],"invalid":0,"positive":0}"#
    );
    let mut subnormal = [0.0, 0.0];
    vwma_accumulate(&mut subnormal, f64::from_bits(1));
    assert_eq!(subnormal[0].to_bits(), 1);
    assert_eq!(subnormal[1].to_bits(), 0);

    let imported_wire =
        value(r#"{"positive":0,"invalid":0,"sums":[[0,0],[0,0],[0,0]],"head":0,"a":[]}"#);
    let mut imported = VwmaAccumulator::default();
    assert!(imported.capture_wire_order(&imported_wire));
    assert_eq!(text(&imported.to_wire()), text(&imported_wire));
}

#[test]
fn true_range_bollinger_rebase_and_wire_equality_follow_js_number_rules() {
    let row = Bar {
        time: 0.0,
        open: 10.0,
        high: 12.0,
        low: 8.0,
        close: 11.0,
        volume: 1.0,
    };
    assert_eq!(true_range(&row, 15.0), 7.0);
    assert_eq!(true_range(&row, f64::NAN), 4.0);
    assert_eq!(rebase_bollinger(&[4.0, 2.0, 3.0], 1.0), (3.0, 2.0));
    assert_eq!(rebase_bollinger(&[4.0, 2.0, 3.0], -0.0), (3.0, 2.0));

    let left = value(r#"{"a":NaN,"z":[-0,1]}"#);
    let right = value(r#"{"z":[-0,1],"a":NaN}"#);
    let plus = value(r#"{"z":[0,1],"a":NaN}"#);
    assert!(exact_state_equal(&left, &right));
    assert!(!exact_state_equal(&left, &plus));

    let mut payload_left = JsObject::new();
    payload_left.insert(
        JsString::from_str("n"),
        JsValue::Number(f64::from_bits(0x7ff8_0000_0000_0001)),
    );
    let mut payload_right = JsObject::new();
    payload_right.insert(
        JsString::from_str("n"),
        JsValue::Number(f64::from_bits(0x7ff8_0000_0000_0042)),
    );
    assert!(exact_state_equal(
        &JsValue::Object(payload_left),
        &JsValue::Object(payload_right)
    ));
}

#[test]
fn canonical_checkpoint_preserves_imported_order_except_for_extreme_queues() {
    let imported = value(r#"{"value":2,"sum":6,"count":3,"extra":7}"#);
    assert_eq!(
        text(&canonical_checkpoint(&imported)),
        r#"{"value":2,"sum":0,"count":3,"extra":7}"#
    );
    assert_eq!(
        text(&imported),
        r#"{"value":2,"sum":6,"count":3,"extra":7}"#
    );

    let extreme = value(r#"{"head":1,"a":[[0,1],[1,2],[2,3]]}"#);
    assert_eq!(
        text(&canonical_checkpoint(&extreme)),
        r#"{"a":[[1,2],[2,3]],"head":0}"#
    );
    assert_eq!(text(&extreme), r#"{"head":1,"a":[[0,1],[1,2],[2,3]]}"#);
    assert_eq!(text(&canonical_checkpoint(&value("{}"))), "{}");

    let ring_wire = value(r#"{"sum":9,"a":[4,2,3],"head":1}"#);
    let mut ring = Ring::from_parts(vec![4.0, 2.0, 3.0], 1.0, 9.0);
    assert!(ring.capture_wire_order(&ring_wire));
    assert_eq!(text(&ring.to_wire()), text(&ring_wire));

    let smoother_wire = value(r#"{"value":2,"count":3,"sum":6}"#);
    let mut smoother = Smoother::from_parts(3.0, 6.0, 2.0);
    assert!(smoother.capture_wire_order(&smoother_wire));
    assert_eq!(text(&smoother.to_wire()), text(&smoother_wire));
    assert_eq!(
        text(&canonical_checkpoint(&smoother.to_wire())),
        r#"{"value":2,"count":3,"sum":0}"#
    );

    let outer = value(r#"{"second":2,"first":1}"#);
    let order = CheckpointFieldOrder::capture(&outer, &["first", "second"]).unwrap();
    assert_eq!(order.indices(), [1, 0]);
    assert_eq!(
        text(&order.ordered_object(&[
            ("first", JsValue::Number(1.0)),
            ("second", JsValue::Number(2.0)),
        ])),
        text(&outer)
    );

    let queue = ExtremeQueue::default();
    assert_eq!(text(&queue.canonical_snapshot()), r#"{"a":[],"head":0}"#);
    assert_eq!(JsString::from_str("sum").to_string_lossy(), "sum");
}

#[test]
fn imported_negative_zero_counters_survive_until_the_js_assignment_that_changes_them() {
    let ring_wire = value(&format!(
        "{{\"a\":[{}],\"head\":-0,\"sum\":256}}",
        vec!["1"; 256].join(",")
    ));
    let mut ring = Some(Ring::from_parts(vec![1.0; 256], -0.0, 256.0));
    assert!(ring.as_mut().unwrap().capture_wire_order(&ring_wire));
    assert!(text(&ring.as_ref().unwrap().to_wire()).contains(r#""head":-0"#));
    assert!(roll(&mut ring, 2.0, 10_000).is_nan());
    assert!(text(&ring.as_ref().unwrap().to_wire()).contains(r#""head":-0"#));
    assert!(roll(&mut ring, f64::NAN, 10_000).is_nan());
    assert!(text(&ring.as_ref().unwrap().to_wire()).contains(r#""head":0"#));
    let mut full_ring = Some(Ring::from_parts(vec![1.0], -0.0, 1.0));
    assert_eq!(roll(&mut full_ring, 2.0, 1), 2.0);
    assert_eq!(
        full_ring.as_ref().unwrap().head.to_bits(),
        0.0_f64.to_bits()
    );

    let smoother_wire = value(r#"{"count":-0,"sum":0,"value":NaN}"#);
    let mut smoother = Some(Smoother::from_parts(-0.0, 0.0, f64::NAN));
    assert!(
        smoother
            .as_mut()
            .unwrap()
            .capture_wire_order(&smoother_wire)
    );
    assert!(text(&smoother.as_ref().unwrap().to_wire()).contains(r#""count":-0"#));
    assert!(smooth(&mut smoother, 3.0, 3, 0.5).is_nan());
    assert!(text(&smoother.as_ref().unwrap().to_wire()).contains(r#""count":1"#));
    assert!(smooth(&mut smoother, f64::NAN, 3, 0.5).is_nan());
    assert!(text(&smoother.as_ref().unwrap().to_wire()).contains(r#""count":0"#));

    let mut extreme_state = Some(ExtremeQueue::from_parts(
        vec![indicator_helpers::ExtremeEntry::from_parts(-0.0, 5.0)],
        -0.0,
    ));
    assert!(extreme(&mut extreme_state, 4.0, 3, 1, true).is_nan());
    assert_eq!(
        text(&extreme_state.as_ref().unwrap().canonical_snapshot()),
        r#"{"a":[[-0,5],[1,4]],"head":0}"#
    );
    assert!(text(&extreme_state.as_ref().unwrap().to_wire()).contains(r#""head":-0"#));
    assert_eq!(extreme(&mut extreme_state, 3.0, 3, 3, true), 4.0);
    assert_eq!(
        extreme_state.as_ref().unwrap().head.to_bits(),
        1.0_f64.to_bits()
    );

    let vwma_wire =
        value(r#"{"a":[],"head":-0,"sums":[[0,0],[0,0],[0,0]],"invalid":-0,"positive":-0}"#);
    let mut vwma = VwmaAccumulator::from_parts(Vec::new(), -0.0, [[0.0, 0.0]; 3], -0.0, -0.0);
    assert!(vwma.capture_wire_order(&vwma_wire));
    assert_eq!(text(&vwma.to_wire()), text(&vwma_wire));
    assert!(vwma_step(&mut vwma, &bar(2.0, 0.0), 0, 3).is_nan());
    let after = text(&vwma.to_wire());
    assert!(after.contains(r#""head":-0"#));
    assert!(after.contains(r#""invalid":0"#));
    assert!(after.contains(r#""positive":0"#));
    let mut full_vwma = VwmaAccumulator::from_parts(
        vec![[1.0, 1.0]],
        -0.0,
        [[1.0, 0.0], [1.0, 0.0], [1.0, 0.0]],
        0.0,
        1.0,
    );
    assert_eq!(vwma_step(&mut full_vwma, &bar(2.0, 1.0), 1, 1), 2.0);
    assert_eq!(full_vwma.head.to_bits(), 0.0_f64.to_bits());
}
