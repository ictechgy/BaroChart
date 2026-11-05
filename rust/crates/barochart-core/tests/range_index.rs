use barochart_core::range_index;
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};

use range_index::{RangeIndex, RangeIndexBuilder, RangeQuery};

fn bits(value: f64) -> u64 {
    value.to_bits()
}

#[test]
fn constructor_and_queries_follow_js_dyadic_merge_order() {
    let low = [3.0, -0.0, f64::NAN, 7.0, 2.0];
    let high = [4.0, 0.0, f64::INFINITY, 8.0, 6.0];
    let volume = [1.0, 2.0, 3.0, 4.0, 5.0];
    let index = RangeIndex::new(5, &low, &high, Some(&volume), 8, false).unwrap();
    assert_eq!(index.size(), 8);
    assert!(!index.finite_counts());
    assert_eq!(index.bytes(), 8 * 2 * 3 * 8);
    assert_eq!(index.root_sum(), Some(15.0));
    assert_eq!(
        index.query(0, 5).unwrap(),
        RangeQuery {
            min: -0.0,
            max: 8.0,
            sum: 15.0
        }
    );
    assert_eq!(bits(index.query(1, 2).unwrap().min), bits(-0.0));
    assert_eq!(bits(index.query(1, 2).unwrap().max), bits(0.0));
    assert_eq!(
        index.query(2, 3).unwrap(),
        RangeQuery {
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            sum: 3.0
        }
    );
    assert_eq!(
        index.query(3, 3).unwrap(),
        RangeQuery {
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            sum: 0.0
        }
    );
}

#[test]
fn finite_count_index_ignores_nonfinite_values_and_reports_gaps() {
    let values = [1.0, 2.0, f64::NAN, 4.0, f64::INFINITY, -0.0];
    let index = RangeIndex::new(6, &values, &values, None, 8, true).unwrap();
    assert_eq!(index.finite_count(0, 6).unwrap(), 4);
    assert!(index.has_gaps(0, 6).unwrap());
    assert!(!index.has_gaps(0, 2).unwrap());
    assert_eq!(index.query(0, 6).unwrap().sum, 0.0);
}

#[test]
fn update_validates_full_scalar_fold_before_mutating() {
    let a = 2f64.powi(969);
    let volume = [f64::MAX, 0.0, a, 0.0];
    let values = [1.0; 4];
    let mut index = RangeIndex::new(3, &values, &values, Some(&volume), 4, false).unwrap();
    let before = index.clone();
    let error = index.update(3, 1.0, 1.0, a).unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Volume sum overflow");
    assert_eq!(index, before);
}

#[test]
fn update_preserves_negative_zero_and_bounds_errors_leave_tree_unchanged() {
    let values = [1.0, 2.0];
    let volume = [1.0, 2.0];
    let mut index = RangeIndex::new(2, &values, &values, Some(&volume), 2, false).unwrap();
    index.update(1, -0.0, 0.0, -0.0).unwrap();
    assert_eq!(bits(index.leaf_min(1)), bits(-0.0));
    assert_eq!(bits(index.leaf_max(1)), bits(0.0));
    assert_eq!(bits(index.leaf_sum(1).unwrap()), bits(-0.0));
    let before = index.clone();
    assert!(index.update(2, 0.0, 0.0, 0.0).is_err());
    assert!(index.query(2, 1).is_err());
    assert_eq!(index, before);
}

#[test]
fn constructor_rejects_role_shape_and_root_overflow() {
    let values = [1.0, 2.0];
    let volume = [f64::MAX, f64::MAX];
    assert!(RangeIndex::new(2, &values, &values, Some(&volume), 2, true).is_err());
    let error = RangeIndex::new(2, &values, &values, Some(&volume), 2, false).unwrap_err();
    assert_eq!(error.message.to_string_lossy(), "Volume sum overflow");
    assert!(RangeIndex::new(3, &values, &values, None, 4, false).is_err());
}

#[test]
fn validated_tree_copy_preserves_target_storage_role_and_values() {
    let values = [1.0, 2.0];
    let volume = [3.0, 4.0];
    let mut target = RangeIndex::new(2, &values, &values, Some(&volume), 4, false).unwrap();
    let mut source = target.clone();
    source.update(1, -0.0, 9.0, 7.0).unwrap();
    target.copy_tree_from(&source).unwrap();
    assert_eq!(target, source);
    let counts = RangeIndex::new(2, &values, &values, None, 4, true).unwrap();
    assert!(target.copy_tree_from(&counts).is_err());
}

#[test]
fn seeded_queries_match_bounded_bruteforce_for_more_than_one_thousand_ranges() {
    let length = 257;
    let mut low = vec![0.0; length];
    let mut high = vec![0.0; length];
    let mut volume = vec![0.0; length];
    let mut state = 21u32;
    for index in 0..length {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        low[index] = f64::from(state % 10_000) - 5_000.0;
        high[index] = low[index] + f64::from(state % 17);
        volume[index] = f64::from(state % 31);
    }
    let index = RangeIndex::new(length, &low, &high, Some(&volume), 512, false).unwrap();
    for _ in 0..1_500 {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let from = state as usize % (length + 1);
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let to = from + state as usize % (length - from + 1);
        let actual = index.query(from, to).unwrap();
        let expected_min = low[from..to]
            .iter()
            .copied()
            .fold(
                f64::INFINITY,
                |current, value| if value < current { value } else { current },
            );
        let expected_max =
            high[from..to]
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, |current, value| {
                    if value > current { value } else { current }
                });
        assert_eq!((actual.min, actual.max), (expected_min, expected_max));
        assert_eq!(actual.sum, volume[from..to].iter().sum::<f64>());
    }
}

#[test]
fn bounded_builder_matches_constructor_and_moves_tree_allocations() {
    let low = [3.0, -0.0, f64::NAN, 7.0, 2.0];
    let high = [4.0, 0.0, f64::INFINITY, 8.0, 6.0];
    let volume = [1.0, 2.0, 3.0, 4.0, 5.0];
    let expected = RangeIndex::new(5, &low, &high, Some(&volume), 8, false).unwrap();
    let mut builder = RangeIndexBuilder::new(8, false, true).unwrap();
    for index in 0..5 {
        builder
            .leaf(index, low[index], high[index], volume[index])
            .unwrap();
    }
    for position in (1..8).rev() {
        builder.merge(position).unwrap();
    }
    let before = builder.buffer_view();
    let pointers = (
        before.min.as_ptr(),
        before.max.as_ptr(),
        before.sum.unwrap().as_ptr(),
    );
    let actual = builder.finish(5).unwrap();
    let after = actual.buffer_view();
    assert_eq!(actual, expected);
    assert_eq!(
        pointers,
        (
            after.min.as_ptr(),
            after.max.as_ptr(),
            after.sum.unwrap().as_ptr()
        )
    );
}

#[test]
fn bounded_builder_rejects_order_incomplete_role_and_root_overflow() {
    assert!(RangeIndexBuilder::new(8, true, true).is_err());
    let mut builder = RangeIndexBuilder::new(8, false, true).unwrap();
    assert!(builder.leaf(1, 1.0, 1.0, 1.0).is_err());
    builder.leaf(0, 1.0, 1.0, f64::MAX).unwrap();
    builder.leaf(1, 1.0, 1.0, f64::MAX).unwrap();
    assert!(builder.merge(6).is_err());
    for position in (1..8).rev() {
        builder.merge(position).unwrap();
    }
    assert_eq!(
        builder.finish(2).unwrap_err().message.to_string_lossy(),
        "Volume sum overflow"
    );

    let builder = RangeIndexBuilder::new(8, false, true).unwrap();
    assert_eq!(
        builder.finish(0).unwrap_err().message.to_string_lossy(),
        "Index builder incomplete"
    );
}

#[test]
fn native_buffer_adoption_preserves_allocations_and_validates_count_tree() {
    let values = [1.0, f64::NAN, -0.0];
    let source = RangeIndex::new(3, &values, &values, None, 4, true).unwrap();
    let source = source.buffer_view();
    let min = source.min.to_vec();
    let max = source.max.to_vec();
    let sum = source.sum.unwrap().to_vec();
    let pointers = (min.as_ptr(), max.as_ptr(), sum.as_ptr());
    let adopted = RangeIndex::from_native_buffers(4, min, max, Some(sum), true).unwrap();
    adopted.validate_native_count_tree(1).unwrap();
    let view = adopted.buffer_view();
    assert_eq!(
        pointers,
        (
            view.min.as_ptr(),
            view.max.as_ptr(),
            view.sum.unwrap().as_ptr()
        )
    );

    let mut corrupted = view.sum.unwrap().to_vec();
    corrupted[1] += 1.0;
    let corrupted = RangeIndex::from_native_buffers(
        4,
        view.min.to_vec(),
        view.max.to_vec(),
        Some(corrupted),
        true,
    )
    .unwrap();
    assert_eq!(
        corrupted
            .validate_native_count_tree(1)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Async finite-count cache aggregate"
    );
}

#[test]
fn accounted_constructor_and_clone_charge_actual_tree_capacity_and_release() {
    let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let values = [1.0, 2.0, 3.0];
    let volume = [4.0, 5.0, 6.0];
    let (index, group) =
        RangeIndex::new_with_memory(3, &values, &values, Some(&volume), 8, false, &context)
            .unwrap();
    assert_eq!(group.requested_bytes(), index.bytes() as u64);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        index.bytes() as u64
    );
    let (copy, copy_group) = index.try_clone_with_memory(&context).unwrap();
    assert_eq!(copy, index);
    assert_eq!(copy_group.requested_bytes(), copy.bytes() as u64);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        (index.bytes() + copy.bytes()) as u64
    );
    drop((copy, copy_group));
    assert_eq!(
        account.snapshot().requested_live_bytes,
        index.bytes() as u64
    );
    drop((index, group));
    assert_eq!(account.snapshot().requested_live_bytes, 0);

    let limited = MemoryAccount::new(383, OomStyle::InternalErrorLowercase);
    assert!(
        RangeIndex::new_with_memory(
            3,
            &values,
            &values,
            Some(&volume),
            8,
            false,
            &MemoryContext::accounted(&limited),
        )
        .is_err()
    );
    assert_eq!(limited.snapshot().requested_live_bytes, 0);
}
