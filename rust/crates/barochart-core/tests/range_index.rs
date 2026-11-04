use barochart_core::range_index;

use range_index::{RangeIndex, RangeQuery};

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
