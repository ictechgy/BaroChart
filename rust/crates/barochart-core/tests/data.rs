use barochart_core::batch_options;
use barochart_core::data;

use batch_options::BatchOptions;
use data::{
    Bar, BatchEvent, ChangeKind, ColumnInputs, DataEvent, DataEventValue, ModelDataState,
    NumericColumn, PlainNumber, ResetData, StoreOptions, seeded_columns, validate_bar,
};

const T: f64 = 1_700_000_000_000.0;

fn bar(time: f64, close: f64, volume: f64) -> Bar {
    Bar {
        time,
        open: close,
        high: close,
        low: close,
        close,
        volume,
    }
}

fn rows(state: &ModelDataState) -> Vec<Bar> {
    (0..state.store().length())
        .map(|index| state.store().at(index).unwrap())
        .collect()
}

fn bits(values: &[f64]) -> Vec<u64> {
    values.iter().map(|value| value.to_bits()).collect()
}

#[test]
fn validate_bar_preserves_signed_zero_and_error_order() {
    let negative = bar(1.0, -0.0, -0.0);
    validate_bar(&negative, f64::NEG_INFINITY).unwrap();
    assert!(negative.close.is_sign_negative());
    assert!(negative.volume.is_sign_negative());

    let mut invalid = negative;
    invalid.time = f64::NAN;
    invalid.high = -1.0;
    let error = validate_bar(&invalid, f64::NEG_INFINITY).unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message.to_string_lossy(),
        "Every OHLCV field must be finite"
    );

    let duplicate_zero = Bar {
        time: 0.0,
        ..negative
    };
    assert_eq!(
        validate_bar(&duplicate_zero, -0.0)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Times must be strictly increasing"
    );
    let invalid_time_and_envelope = Bar {
        time: 1.5,
        open: 3.0,
        high: 1.0,
        low: 2.0,
        close: 3.0,
        volume: -1.0,
    };
    assert_eq!(
        validate_bar(&invalid_time_and_envelope, f64::NEG_INFINITY)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Time must be an exact UTC millisecond integer in the Date range"
    );
    let invalid_chronology_and_envelope = Bar {
        time: 1.0,
        ..invalid_time_and_envelope
    };
    assert_eq!(
        validate_bar(&invalid_chronology_and_envelope, 1.0)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Times must be strictly increasing"
    );
}

#[test]
fn store_capacity_versions_bytes_and_serial_are_owner_scoped() {
    let input = (0..17)
        .map(|index| bar(T + index as f64 * 60_000.0, index as f64, 1.0))
        .collect();
    let mut first = ModelDataState::new(StoreOptions::default(), input).unwrap();
    assert_eq!(first.store().serial(), 1.0);
    assert_eq!(first.store().length(), 17);
    assert_eq!(first.store().capacity(), 32);
    assert_eq!(first.store().version(), 1.0);
    assert_eq!(first.store().time_version(), 1.0);
    assert_eq!(first.store().bytes(), 96 * 32);
    assert_eq!(first.store().columns().time.len(), 32);
    assert_eq!(first.store().index().size(), 32);
    assert_eq!(first.take_serial(), 2.0);
    assert_eq!(first.take_serial(), 3.0);

    let second = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    assert_eq!(
        second.store().serial(),
        1.0,
        "another engine owner starts its own serial"
    );
}

#[test]
fn set_data_is_atomic_and_empty_reset_still_publishes_one_change() {
    let mut state = ModelDataState::new(StoreOptions::default(), vec![bar(T, 1.0, 2.0)]).unwrap();
    let before = state.store().clone();
    let invalid = vec![bar(T + 60_000.0, 2.0, 1.0), bar(T, 3.0, 1.0)];
    assert!(state.store_mut().set_data(invalid).is_err());
    assert_eq!(state.store(), &before);

    let committed = state.store_mut().set_data(Vec::new()).unwrap();
    let change = committed.change.unwrap();
    assert_eq!(change.kind, ChangeKind::Reset);
    assert_eq!(change.version, 2.0);
    assert_eq!(state.store().time_version(), 2.0);
    assert_eq!(state.store().capacity(), 16);
}

#[test]
fn set_columns_accepts_plain_and_typed_numeric_kinds_with_owned_copy() {
    let times = [PlainNumber::Number(T), PlainNumber::Number(T + 60_000.0)];
    let open = [1.25f32, 2.5];
    let high = [2i32, 3];
    let low = [1u32, 2];
    let close = [1i16, 2];
    let volume = [0u8, 7];
    let input = ColumnInputs {
        time: NumericColumn::Plain(&times),
        open: NumericColumn::F32(&open),
        high: NumericColumn::I32(&high),
        low: NumericColumn::U32(&low),
        close: NumericColumn::I16(&close),
        volume: NumericColumn::U8Clamped(&volume),
    };
    let mut state = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    state.store_mut().set_columns(&input, None).unwrap();
    assert_eq!(
        state.store().at(0).unwrap(),
        Bar {
            time: T,
            open: 1.25,
            high: 2.0,
            low: 1.0,
            close: 1.0,
            volume: 0.0
        }
    );
    assert_eq!(state.store().at(1).unwrap().volume, 7.0);

    let mut owned = open;
    owned[0] = 99.0;
    assert_eq!(owned[0], 99.0);
    assert_eq!(
        state.store().at(0).unwrap().open,
        1.25,
        "column input is owned after commit"
    );

    let typed_time = [T, T + 60_000.0];
    let u16_values = [1u16, 2];
    let u8_values = [2u8, 3];
    let i8_values = [1i8, 2];
    let more = ColumnInputs {
        time: NumericColumn::F64(&typed_time),
        open: NumericColumn::U16(&u16_values),
        high: NumericColumn::U8(&u8_values),
        low: NumericColumn::I8(&i8_values),
        close: NumericColumn::U8(&u8_values),
        volume: NumericColumn::U8(&u8_values),
    };
    state.store_mut().set_columns(&more, Some(2)).unwrap();
    assert_eq!(state.store().at(0).unwrap().low, 1.0);
}

#[test]
fn set_columns_checks_all_shapes_before_plain_numeric_values() {
    let bad_time = [PlainNumber::Invalid];
    let good = [1.0f64];
    let input = ColumnInputs {
        time: NumericColumn::Plain(&bad_time),
        open: NumericColumn::F64(&good),
        high: NumericColumn::F64(&good),
        low: NumericColumn::F64(&good),
        close: NumericColumn::F64(&good),
        volume: NumericColumn::Unsupported,
    };
    let mut state = ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap();
    let error = state.store_mut().set_columns(&input, Some(1)).unwrap_err();
    assert_eq!(
        error.message.to_string_lossy(),
        "Numeric column arrays required"
    );
    assert_eq!(state.store().length(), 0);
    let missing = ColumnInputs {
        volume: NumericColumn::Missing,
        ..input
    };
    assert_eq!(
        state
            .store_mut()
            .set_columns(&missing, Some(1))
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Numeric column arrays required"
    );
}

#[test]
fn scalar_append_update_and_prepend_return_complete_invalidation_changes() {
    let mut state = ModelDataState::new(StoreOptions::default(), vec![bar(T, 1.0, 1.0)]).unwrap();
    let fixed_buffer = state.store().columns().time.as_ptr();
    let append = state
        .store_mut()
        .append(bar(T + 60_000.0, 2.0, 2.0))
        .unwrap();
    assert_eq!(append.value, 1);
    assert_eq!(append.change.as_ref().unwrap().kind, ChangeKind::Append);
    assert_eq!(append.change.as_ref().unwrap().from, 1);
    assert_eq!(append.change.as_ref().unwrap().to, 2);
    assert_eq!(state.store().time_version(), 2.0);
    assert_eq!(state.store().columns().time.as_ptr(), fixed_buffer);

    let update = state
        .store_mut()
        .update(1, bar(T + 60_000.0, 3.0, -0.0))
        .unwrap();
    assert_eq!(update.change.unwrap().kind, ChangeKind::Update);
    assert_eq!(state.store().time_version(), 2.0);
    assert_eq!(state.store().columns().time.as_ptr(), fixed_buffer);
    assert!(state.store().at(1).unwrap().volume.is_sign_negative());

    let no_op = state.store_mut().prepend(Vec::new()).unwrap();
    assert!(no_op.change.is_none());
    let prepend = state
        .store_mut()
        .prepend(vec![bar(T - 60_000.0, -0.0, 0.0)])
        .unwrap();
    assert_eq!(prepend.change.as_ref().unwrap().kind, ChangeKind::Prepend);
    assert_eq!(prepend.change.as_ref().unwrap().added, Some(1));
    assert_eq!(prepend.change.as_ref().unwrap().from, 0);
    assert_eq!(prepend.change.as_ref().unwrap().to, 3);
    assert_eq!(state.store().time_version(), 3.0);
}

#[test]
fn scalar_append_checks_actual_tree_fold_before_mutating_columns_or_versions() {
    let value = 2f64.powi(969);
    let mut state = ModelDataState::new(
        StoreOptions::default(),
        vec![
            bar(1.0, 1.0, f64::MAX),
            bar(2.0, 1.0, 0.0),
            bar(3.0, 1.0, value),
        ],
    )
    .unwrap();
    assert!((state.store().index().root_sum().unwrap() + value).is_finite());
    let before = state.store().clone();
    assert_eq!(
        state
            .store_mut()
            .append(bar(4.0, 1.0, value))
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Volume sum overflow"
    );
    assert_eq!(state.store(), &before);
}

#[test]
fn point_mapping_lower_bound_and_aggregation_match_irregular_times() {
    let bars = vec![
        bar(10.0, 1.0, 1.0),
        bar(20.0, 2.0, 2.0),
        bar(50.0, 3.0, 3.0),
    ];
    let state = ModelDataState::new(
        StoreOptions {
            timeframe_ms: 5.0,
            time_origin: 7.0,
            ..StoreOptions::default()
        },
        bars,
    )
    .unwrap();
    let store = state.store();
    assert_eq!(store.lower_bound(19.0), 1);
    assert_eq!(store.lower_bound(20.0), 1);
    assert_eq!(store.index_at_time(35.0), 1.5);
    assert_eq!(store.time_at_index(1.5), 35.0);
    let buckets = store.aggregate(-10.0, 99.0, 2).unwrap();
    assert_eq!(buckets.len(), 2);
    assert_eq!(
        (buckets[0].start, buckets[0].end, buckets[0].volume),
        (0, 1, 1.0)
    );
    assert_eq!(
        (
            buckets[1].start,
            buckets[1].end,
            buckets[1].high,
            buckets[1].volume
        ),
        (1, 3, 3.0, 5.0)
    );
    assert!(store.aggregate(f64::NAN, 2.0, 2).is_err());
}

#[test]
fn seeded_columns_match_checked_in_js_bits() {
    let columns = seeded_columns(3, 42).unwrap();
    assert_eq!(
        bits(&columns.time[..3]),
        vec![0x4278bcfe56800000, 0x4278bcfe65260000, 0x4278bcfe73cc0000]
    );
    assert_eq!(
        bits(&columns.open[..3]),
        vec![0x4059000000000000, 0x4058ed35e3f21100, 0x4058e3e440b88866]
    );
    assert_eq!(
        bits(&columns.close[..3]),
        vec![0x4058ed35e3f21100, 0x4058e3e440b88866, 0x405900d4b6336632]
    );
    assert_eq!(
        bits(&columns.high[..3]),
        vec![0x405903624df03333, 0x4058ee322d46ddcd, 0x405927065d4fffcc]
    );
    assert_eq!(
        bits(&columns.low[..3]),
        vec![0x4058d70afc3e0433, 0x4058d2b74c824866, 0x4058c320edc34866]
    );
    assert_eq!(
        bits(&columns.volume[..3]),
        vec![0x40a1fe0000000000, 0x4093e00000000000, 0x40b3b60000000000]
    );
    let seed21 = seeded_columns(3, 21).unwrap();
    assert_eq!(
        bits(&seed21.close[..3]),
        vec![0x4058ec95e1069100, 0x4058e396fc4feecc, 0x4058cc12c4a27fcc]
    );
    assert_eq!(
        bits(&seed21.volume[..3]),
        vec![0x40b19b0000000000, 0x40c1320000000000, 0x4093e80000000000]
    );
}

#[test]
fn mixed_batch_commits_once_then_allows_infallible_ledger_before_publication() {
    let mut state = ModelDataState::new(
        StoreOptions::default(),
        vec![bar(T, 10.0, 1.0), bar(T + 60_000.0, 20.0, 2.0)],
    )
    .unwrap();
    let version = state.store().version();
    let time_version = state.store().time_version();
    let fixed_buffer = state.store().columns().time.as_ptr();
    let events = vec![
        BatchEvent::Update(bar(T + 60_000.0, 21.0, 3.0)),
        BatchEvent::Append(bar(T + 120_000.0, 30.0, 4.0)),
        BatchEvent::Correction(bar(T, 11.0, 5.0)),
        BatchEvent::Update(bar(T + 120_000.0, 31.0, 6.0)),
    ];
    let committed = state
        .store_mut()
        .apply_events(&events, &BatchOptions::empty())
        .unwrap();
    assert_eq!(committed.value.events, 4);
    assert_eq!(committed.value.appended, 1);
    assert_eq!((committed.value.from, committed.value.to), (0, 3));
    assert_eq!(committed.value.version, version + 1.0);
    assert_eq!(state.store().version(), version + 1.0);
    assert_eq!(state.store().time_version(), time_version + 1.0);
    assert_eq!(
        state.store().columns().time.as_ptr(),
        fixed_buffer,
        "fixed-capacity batch preserves owned column buffers"
    );
    assert_eq!(
        rows(&state),
        vec![
            bar(T, 11.0, 5.0),
            bar(T + 60_000.0, 21.0, 3.0),
            bar(T + 120_000.0, 31.0, 6.0)
        ]
    );
    let change = committed.change.unwrap();
    assert_eq!(change.kind, ChangeKind::Batch);
    assert_eq!((change.appended, change.to), (Some(1), 3));
}

#[test]
fn failed_batch_preserves_store_and_skip_unchanged_returns_no_change() {
    let mut state = ModelDataState::new(
        StoreOptions::default(),
        vec![bar(T, 1.0, 0.0), bar(T + 1.0, 2.0, 0.0)],
    )
    .unwrap();
    let before = state.store().clone();
    let events = vec![
        BatchEvent::Correction(bar(T, 3.0, f64::MAX)),
        BatchEvent::Update(bar(T + 1.0, 4.0, f64::MAX)),
        BatchEvent::Update(bar(T + 1.0, 5.0, 0.0)),
    ];
    assert_eq!(
        state
            .store_mut()
            .apply_events(&events, &BatchOptions::empty())
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Volume sum overflow"
    );
    assert_eq!(state.store(), &before);

    let mut options = BatchOptions::empty();
    options.skip_unchanged = Some(true);
    let tail = state.store().at(1).unwrap();
    let unchanged = state
        .store_mut()
        .apply_events(&[BatchEvent::Update(tail)], &options)
        .unwrap();
    assert!(unchanged.value.unchanged == Some(true));
    assert!(unchanged.change.is_none());
    assert_eq!(state.store(), &before);
}

#[test]
fn batch_validates_rows_before_raw_budgets_and_rolls_back_budget_failures() {
    use barochart_js::json::JsValue;
    use barochart_js::string::JsString;

    let mut state = ModelDataState::new(StoreOptions::default(), vec![bar(T, 1.0, 1.0)]).unwrap();
    let before = state.store().clone();
    let mut options = BatchOptions::empty();
    options.max_bars = Some(JsValue::String(JsString::from_str("bad")));
    let invalid = Bar {
        close: f64::NAN,
        ..bar(T, 1.0, 1.0)
    };
    assert_eq!(
        state
            .store_mut()
            .apply_events(&[BatchEvent::Update(invalid)], &options)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Every OHLCV field must be finite"
    );
    assert_eq!(state.store(), &before);
    assert_eq!(
        state
            .store_mut()
            .apply_events(&[BatchEvent::Update(bar(T, 2.0, 2.0))], &options)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Data batch bar budget limit 4194304"
    );
    assert_eq!(state.store(), &before);

    options.max_bars = Some(JsValue::Number(1.0));
    assert!(
        state
            .store_mut()
            .apply_events(&[BatchEvent::Append(bar(T + 1.0, 2.0, 2.0))], &options)
            .is_err()
    );
    assert_eq!(state.store(), &before);

    let mut chronology = ModelDataState::new(
        StoreOptions::default(),
        vec![bar(T, 1.0, 1.0), bar(T + 2.0, 2.0, 2.0)],
    )
    .unwrap();
    let chronology_before = chronology.store().clone();
    assert_eq!(
        chronology
            .store_mut()
            .apply_events(
                &[BatchEvent::Append(bar(T + 1.0, 3.0, 3.0))],
                &BatchOptions::empty()
            )
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Times must be strictly increasing"
    );
    assert_eq!(chronology.store(), &chronology_before);
}

#[test]
fn six_data_event_kinds_route_to_the_same_store_contracts() {
    let mut state = ModelDataState::new(StoreOptions::default(), vec![bar(T, 1.0, 1.0)]).unwrap();
    let appended = state
        .store_mut()
        .apply_event(
            DataEvent::Append(bar(T + 1.0, 2.0, 2.0)),
            &BatchOptions::empty(),
        )
        .unwrap();
    assert_eq!(appended.value, DataEventValue::Index(1));
    state
        .store_mut()
        .apply_event(
            DataEvent::Update(bar(T + 1.0, 3.0, 3.0)),
            &BatchOptions::empty(),
        )
        .unwrap();
    state
        .store_mut()
        .apply_event(
            DataEvent::Correction(bar(T, 4.0, 4.0)),
            &BatchOptions::empty(),
        )
        .unwrap();
    state
        .store_mut()
        .apply_event(
            DataEvent::Prepend(vec![bar(T - 1.0, 0.0, 0.0)]),
            &BatchOptions::empty(),
        )
        .unwrap();
    let batch = state
        .store_mut()
        .apply_event(
            DataEvent::Batch(vec![BatchEvent::Update(bar(T + 1.0, 5.0, 5.0))]),
            &BatchOptions::empty(),
        )
        .unwrap();
    assert!(matches!(batch.value, DataEventValue::Batch(_)));
    state
        .store_mut()
        .apply_event(
            DataEvent::Reset(ResetData::Bars(vec![bar(T + 10.0, 8.0, 8.0)])),
            &BatchOptions::empty(),
        )
        .unwrap();
    assert_eq!(rows(&state), vec![bar(T + 10.0, 8.0, 8.0)]);

    let columns = seeded_columns(2, 21).unwrap();
    state
        .store_mut()
        .apply_event(
            DataEvent::Reset(ResetData::Columns { columns, length: 2 }),
            &BatchOptions::empty(),
        )
        .unwrap();
    assert_eq!(state.store().length(), 2);
}
