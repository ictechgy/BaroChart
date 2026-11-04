use barochart_core::batch_options::BatchOptions;
use barochart_core::data::{Bar, BatchEvent, DataEvent, ModelDataState, StoreOptions};
use barochart_js::error::JsError;
use barochart_js::string::JsString;

fn bar(time: f64, close: f64) -> Bar {
    Bar {
        time,
        open: close,
        high: close + 1.0,
        low: close - 1.0,
        close,
        volume: 1.0,
    }
}

#[test]
fn reset_admission_denial_keeps_store_identity_and_columns_unchanged() {
    let mut data = ModelDataState::new(StoreOptions::default(), vec![bar(1.0, 10.0)]).unwrap();
    let before = data.store().data_identity();
    let before_columns = data.store().columns().clone();
    let before_version = data.store().version();
    let mut called = 0;
    let mut gate = || {
        called += 1;
        Err(JsError::new(
            "InternalError",
            JsString::from_str("out of memory"),
        ))
    };
    let error = data
        .store_mut()
        .set_data_with_reply_gate(vec![bar(2.0, 20.0)], &mut gate)
        .expect_err("reply admission denial");
    assert_eq!(error.name, "InternalError");
    assert_eq!(called, 1);
    let after = data.store().data_identity();
    assert!(before.same_store(&after));
    assert!(before.same_columns(&after));
    assert_eq!(data.store().columns(), &before_columns);
    assert_eq!(data.store().version(), before_version);
}

#[test]
fn event_batch_admission_publishes_once_after_the_complete_candidate() {
    let mut data = ModelDataState::new(
        StoreOptions::default(),
        vec![bar(1.0, 10.0), bar(2.0, 11.0)],
    )
    .unwrap();
    let before = data.store().data_identity();
    let mut called = 0;
    let mut gate = || {
        called += 1;
        Ok(())
    };
    let committed = data
        .store_mut()
        .apply_event_with_reply_gate(
            DataEvent::Batch(vec![BatchEvent::Append(bar(3.0, 12.0))]),
            &BatchOptions::empty(),
            &mut gate,
        )
        .unwrap();
    assert_eq!(called, 1);
    assert_eq!(data.store().length(), 3);
    assert_eq!(
        committed.change.unwrap().kind,
        barochart_core::data::ChangeKind::Batch
    );
    let after = data.store().data_identity();
    assert!(before.same_store(&after));
    assert!(!before.same_columns(&after));
}
