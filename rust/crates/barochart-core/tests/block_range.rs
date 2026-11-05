use barochart_core::block_range;
use barochart_core::range_index;
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};

use block_range::BlockRangeIndex;
use range_index::{RangeIndexBuilder, RangeQuery};

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

#[test]
fn owned_block_tree_adoption_is_o1_and_matches_fresh_queries() {
    let capacity = 128usize;
    let length = 67usize;
    let values = (0..length)
        .map(|index| {
            if index % 5 == 0 {
                f64::NAN
            } else {
                index as f64
            }
        })
        .collect::<Vec<_>>();
    let mut builder = RangeIndexBuilder::new(capacity / 32, false, true).unwrap();
    for block in 0..length.div_ceil(32) {
        let finite = values
            .iter()
            .skip(block * 32)
            .take(32)
            .copied()
            .filter(|value| value.is_finite())
            .collect::<Vec<_>>();
        let min = barochart_js::num::js_min(&finite);
        let max = barochart_js::num::js_max(&finite);
        builder.leaf(block, min, max, finite.len() as f64).unwrap();
    }
    for position in (1..capacity / 32).rev() {
        builder.merge(position).unwrap();
    }
    let before = builder.buffer_view();
    let pointers = (
        before.min.as_ptr(),
        before.max.as_ptr(),
        before.sum.unwrap().as_ptr(),
    );
    let tree = builder.finish(length.div_ceil(32)).unwrap();
    let adopted = BlockRangeIndex::from_owned_tree(length, capacity, 32, tree).unwrap();
    let after = adopted.buffer_view();
    assert_eq!(
        pointers,
        (
            after.min.as_ptr(),
            after.max.as_ptr(),
            after.sum.unwrap().as_ptr()
        )
    );
    let fresh = BlockRangeIndex::new(length, &values, capacity, 32).unwrap();
    for (from, to) in [(0, 67), (3, 64), (31, 66), (64, 128)] {
        assert_eq!(
            adopted.query(&values, from, to).unwrap(),
            fresh.query(&values, from, to).unwrap()
        );
        assert_eq!(
            adopted.finite_count(&values, from, to).unwrap(),
            fresh.finite_count(&values, from, to).unwrap()
        );
    }
}

#[test]
fn accounted_block_builder_releases_scratch_and_retains_only_summary_tree() {
    let values = (0..67).map(|value| value as f64).collect::<Vec<_>>();
    let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let (index, group) = BlockRangeIndex::new_with_memory(67, &values, 128, 32, &context).unwrap();
    assert_eq!(group.requested_bytes(), index.bytes() as u64);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        index.bytes() as u64
    );
    assert!(
        account.snapshot().requested_peak_bytes > account.snapshot().requested_live_bytes,
        "temporary low/high/count scratch must overlap the final tree"
    );
    drop((index, group));
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
