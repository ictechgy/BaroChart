use barochart_core::block_range;
use barochart_core::range_index;

use block_range::BlockRangeIndex;
use range_index::RangeQuery;

#[test]
fn block_index_borrows_values_and_matches_unaligned_scans() {
    let mut values = vec![9_999.0; 128];
    for (index, value) in values.iter_mut().take(67).enumerate() {
        *value = if index % 3 == 0 {
            f64::NAN
        } else {
            index as f64
        };
    }
    let mut index = BlockRangeIndex::new(67, &values, 128, 32).unwrap();
    assert_eq!(index.size(), 128);
    assert_eq!(index.block_size(), 32);
    for from in (0..=128).step_by(7) {
        for to in (from..=128).step_by(11) {
            let finite: Vec<f64> = values[std::cmp::min(from, 67)..std::cmp::min(to, 67)]
                .iter()
                .copied()
                .filter(|value| value.is_finite())
                .collect();
            let expected = RangeQuery {
                min: finite
                    .iter()
                    .copied()
                    .fold(
                        f64::INFINITY,
                        |current, value| {
                            if value < current { value } else { current }
                        },
                    ),
                max: finite
                    .iter()
                    .copied()
                    .fold(f64::NEG_INFINITY, |current, value| {
                        if value > current { value } else { current }
                    }),
                sum: 0.0,
            };
            assert_eq!(index.query(&values, from, to).unwrap(), expected);
            assert_eq!(index.finite_count(&values, from, to).unwrap(), finite.len());
            assert_eq!(
                index.has_gaps(&values, from, to).unwrap(),
                finite.len() != to - from
            );
        }
    }
    values[31] = 800.0;
    index.update(&values, 31).unwrap();
    assert_eq!(index.query(&values, 0, 64).unwrap().max, 800.0);
}

#[test]
fn capacity_tail_is_inactive_at_the_65536_boundary() {
    let mut values = vec![-1_234.0; 131_072];
    values[..65_537].fill(7.0);
    let mut index = BlockRangeIndex::new(65_537, &values, 131_072, 32).unwrap();
    assert_eq!(
        index.query(&values, 65_536, 65_538).unwrap(),
        RangeQuery {
            min: 7.0,
            max: 7.0,
            sum: 0.0
        }
    );
    for (from, to) in [(65_537, 65_538), (65_537, 65_570), (131_060, 131_072)] {
        assert_eq!(
            index.query(&values, from, to).unwrap(),
            RangeQuery {
                min: f64::INFINITY,
                max: f64::NEG_INFINITY,
                sum: 0.0
            }
        );
    }
    assert_eq!(index.finite_count(&values, 65_536, 65_538).unwrap(), 1);
    values[65_537] = 12.0;
    index.update(&values, 65_537).unwrap();
    assert_eq!(index.query(&values, 65_536, 65_539).unwrap().max, 12.0);
    assert_eq!(index.length(), 65_538);
}

#[test]
fn bounds_and_source_extent_fail_before_tree_mutation() {
    let values = vec![1.0; 64];
    let mut index = BlockRangeIndex::new(64, &values, 128, 32).unwrap();
    let bytes = index.bytes();
    assert!(index.query(&values, 2, 1).is_err());
    assert!(index.query(&values, 0, 129).is_err());
    assert!(
        index.update(&values, 64).is_err(),
        "borrowed source has no value at 64"
    );
    assert_eq!(index.bytes(), bytes);
    assert!(BlockRangeIndex::new(65, &values, 128, 32).is_err());
}
