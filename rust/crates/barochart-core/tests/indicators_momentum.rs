use barochart_core::{data, indicator_helpers, indicator_types, indicators_momentum};

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json_utf16, stringify_json};
use data::Bar;
use indicator_helpers::exact_state_equal;
use indicator_types::IndicatorProgram;
use indicators_momentum::{MomentumState, create};

fn params(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn bars() -> Vec<Bar> {
    [10.0, 11.0, 9.0, 12.0, 8.0, 13.0, 7.0, 14.0]
        .into_iter()
        .enumerate()
        .map(|(index, close)| Bar {
            time: index as f64,
            open: close - 0.25,
            high: close + 1.0 + if index % 2 == 0 { 0.0 } else { 0.5 },
            low: close - 1.0 - (index % 3) as f64 * 0.25,
            close,
            volume: if index == 4 { 0.0 } else { index as f64 + 1.0 },
        })
        .collect()
}

fn cases() -> [(IndicatorProgram, &'static str); 14] {
    [
        (IndicatorProgram::Rsi, r#"{"period":3}"#),
        (IndicatorProgram::Atr, r#"{"period":3}"#),
        (IndicatorProgram::Donchian, r#"{"period":3}"#),
        (IndicatorProgram::Aroon, r#"{"period":3}"#),
        (
            IndicatorProgram::Stochastic,
            r#"{"period":3,"smoothK":2,"smoothD":2}"#,
        ),
        (IndicatorProgram::Roc, r#"{"period":3}"#),
        (IndicatorProgram::WilliamsR, r#"{"period":3}"#),
        (IndicatorProgram::Cci, r#"{"period":3}"#),
        (IndicatorProgram::Adx, r#"{"period":3}"#),
        (
            IndicatorProgram::Keltner,
            r#"{"period":3,"atrPeriod":2,"multiplier":2}"#,
        ),
        (
            IndicatorProgram::Supertrend,
            r#"{"period":3,"multiplier":2}"#,
        ),
        (
            IndicatorProgram::Ichimoku,
            r#"{"conversion":2,"base":3,"span":4,"displacement":-0}"#,
        ),
        (
            IndicatorProgram::StochRsi,
            r#"{"period":3,"stochPeriod":3,"smoothK":2,"smoothD":2}"#,
        ),
        (IndicatorProgram::ParabolicSar, r#"{"step":0.02,"max":0.2}"#),
    ]
}

fn run(program: IndicatorProgram, text: &str) -> (MomentumState, Vec<Vec<f64>>) {
    let mut created = create(program, &params(text)).unwrap();
    let rows = bars()
        .iter()
        .enumerate()
        .map(|(index, bar)| created.state.step(bar, index).unwrap().as_slice().to_vec())
        .collect();
    (created.state, rows)
}

fn same_number(left: f64, right: f64) -> bool {
    left.to_bits() == right.to_bits() || left.is_nan() && right.is_nan()
}

#[test]
fn all_fourteen_factories_keep_output_order_params_and_offsets() {
    for (program, text) in cases() {
        let created = create(program, &params(text)).unwrap();
        assert_eq!(created.definition.program, program);
        assert_eq!(created.definition.outputs.len(), created.state.output_len());
    }

    let input = params(r#"{"displacement":-0,"unknown":7}"#);
    let created = create(IndicatorProgram::Ichimoku, &input).unwrap();
    assert_eq!(created.definition.params.number("unknown"), Some(7.0));
    assert!(
        created
            .definition
            .effective_plot_offset("spanA")
            .is_sign_negative()
    );
    assert!(
        created
            .definition
            .effective_plot_offset("spanB")
            .is_sign_negative()
    );
    assert_eq!(
        created.definition.effective_plot_offset("chikou").to_bits(),
        0.0f64.to_bits()
    );
}

#[test]
fn cold_fold_last_rows_match_the_node22_oracle_bits() {
    let expected: [(IndicatorProgram, &[f64]); 14] = [
        (IndicatorProgram::Rsi, &[64.21219319081553]),
        (IndicatorProgram::Atr, &[6.5288065843621395]),
        (IndicatorProgram::Donchian, &[10.75, 15.5, 6.0]),
        (
            IndicatorProgram::Aroon,
            &[100.0, 66.66666666666667, 33.33333333333333],
        ),
        (
            IndicatorProgram::Stochastic,
            &[47.98761609907121, 47.09627484270449],
        ),
        (IndicatorProgram::Roc, &[75.0]),
        (IndicatorProgram::WilliamsR, &[-15.789473684210526]),
        (IndicatorProgram::Cci, &[62.42038216560509]),
        (
            IndicatorProgram::Adx,
            &[30.811931102960262, 55.39568345323742, 27.213012198936507],
        ),
        (
            IndicatorProgram::Keltner,
            &[11.5625, 26.30859375, -3.18359375],
        ),
        (IndicatorProgram::Supertrend, &[5.583333333333334, 1.0]),
        (
            IndicatorProgram::Ichimoku,
            &[10.75, 10.75, 10.75, 10.75, 14.0],
        ),
        (
            IndicatorProgram::StochRsi,
            &[50.41393476191309, 50.736722664605054],
        ),
        (IndicatorProgram::ParabolicSar, &[6.0, 1.0]),
    ];
    for ((program, text), (_, expected)) in cases().into_iter().zip(expected) {
        let (_, rows) = run(program, text);
        let actual = rows.last().unwrap();
        assert_eq!(actual.len(), expected.len(), "{} arity", program.name());
        for (actual, expected) in actual.iter().zip(expected) {
            assert!(
                same_number(*actual, *expected),
                "{}: {:016x} != {:016x}",
                program.name(),
                actual.to_bits(),
                expected.to_bits()
            );
        }
    }
}

#[test]
fn checked_in_oracle_fixture_has_metadata_and_matches_encoded_trees() {
    let fixture = include_str!("../../../../test/fixtures/rust-indicators/momentum-cold.jsonl");
    let lines: Vec<_> = fixture.lines().collect();
    assert_eq!(lines.len(), 15);
    let header = params(lines[0]);
    assert_eq!(
        string_field(&header, "schema"),
        "barochart.rust-indicator-oracle"
    );
    assert_eq!(
        string_field(&header, "oracleCommit"),
        "bf851d9fda8547180207de165c46ff8dc7c09b1b"
    );
    assert_eq!(
        string_field(&header, "bundleSha256"),
        "007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512"
    );
    for ((program, text), line) in cases().into_iter().zip(&lines[1..]) {
        let row = params(line);
        assert_eq!(string_field(&row, "program"), program.name());
        let (state, outputs) = run(program, text);
        assert_eq!(
            lossless(&state.snapshot()),
            string_field(&row, "snapshotLossless")
        );
        let bits = string_array_field(&row, "lastBits");
        assert_eq!(bits.len(), outputs.last().unwrap().len());
        for (value, expected) in outputs.last().unwrap().iter().zip(bits) {
            if expected == "NaN" {
                assert!(value.is_nan());
            } else {
                assert_eq!(value.to_bits(), u64::from_str_radix(&expected, 16).unwrap());
            }
        }
    }
}

#[test]
fn every_sequential_output_matches_the_checked_in_object_is_oracle() {
    let fixture = include_str!("../../../../test/fixtures/rust-indicators/momentum-rows.jsonl");
    let lines: Vec<_> = fixture.lines().collect();
    assert_eq!(lines.len(), 15);
    for ((program, text), line) in cases().into_iter().zip(&lines[1..]) {
        let expected = rows_bits_field(&params(line), "rowsBits");
        let (_, actual) = run(program, text);
        assert_eq!(actual.len(), expected.len());
        for (row_index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
            assert_eq!(actual.len(), expected.len());
            for (value, bits) in actual.iter().zip(expected) {
                match bits {
                    Some(bits) => {
                        assert_eq!(value.to_bits(), bits, "{} row {row_index}", program.name())
                    }
                    None => assert!(value.is_nan(), "{} row {row_index} NaN", program.name()),
                }
            }
        }
    }
}

#[test]
fn initial_snapshots_and_first_step_field_insertion_match_source() {
    let expected = [
        (IndicatorProgram::Rsi, r#"{"previous":NaN}"#),
        (IndicatorProgram::Atr, r#"{"previous":NaN}"#),
        (IndicatorProgram::Donchian, "{}"),
        (IndicatorProgram::Aroon, "{}"),
        (IndicatorProgram::Stochastic, "{}"),
        (IndicatorProgram::Roc, r#"{"a":[],"head":0}"#),
        (IndicatorProgram::WilliamsR, "{}"),
        (IndicatorProgram::Cci, "{}"),
        (IndicatorProgram::Adx, r#"{"previous":null}"#),
        (IndicatorProgram::Keltner, r#"{"previous":NaN}"#),
        (
            IndicatorProgram::Supertrend,
            r#"{"previous":NaN,"upper":NaN,"lower":NaN,"direction":1}"#,
        ),
        (IndicatorProgram::Ichimoku, "{}"),
        (IndicatorProgram::StochRsi, r#"{"previous":NaN,"valid":0}"#),
        (
            IndicatorProgram::ParabolicSar,
            r#"{"previous":null,"older":null,"sar":NaN,"ep":NaN,"af":0.02,"direction":1}"#,
        ),
    ];
    for ((program, text), (_, expected)) in cases().into_iter().zip(expected) {
        let mut created = create(program, &params(text)).unwrap();
        assert_eq!(
            lossless(&created.state.snapshot()),
            expected,
            "{} initial",
            program.name()
        );
        created.state.step(&bars()[0], 0).unwrap();
        let after = lossless(&created.state.snapshot());
        if program == IndicatorProgram::StochRsi {
            assert!(after.starts_with(r#"{"previous":10,"valid":0,"k":"#));
            assert!(after.contains(r#","d":{"a":[],"head":0,"sum":0}"#));
        }
    }
}

#[test]
fn snapshots_restore_reordered_top_keys_and_resume_with_exact_output() {
    let next = Bar {
        time: 8.0,
        open: 14.0,
        high: 17.0,
        low: 13.0,
        close: 16.0,
        volume: 9.0,
    };
    for (program, text) in cases() {
        let (mut original, _) = run(program, text);
        let snapshot = original.snapshot();
        let reversed = reverse_object(&snapshot);
        let mut restored = create(program, &params(text)).unwrap().state;
        restored.restore(&reversed).unwrap();
        assert!(exact_state_equal(&restored.snapshot(), &reversed));
        assert_eq!(
            lossless(&restored.snapshot()),
            lossless(&reversed),
            "{} recursive checkpoint key order",
            program.name()
        );
        let actual = restored.step(&next, 8).unwrap();
        let expected = original.step(&next, 8).unwrap();
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.as_slice().iter().zip(expected.as_slice()) {
            assert!(
                same_number(*actual, *expected),
                "{} restore",
                program.name()
            );
        }
    }
}

#[test]
fn extreme_snapshots_compact_expired_prefix_and_sar_reverses() {
    let mut donchian = create(IndicatorProgram::Donchian, &params(r#"{"period":3}"#))
        .unwrap()
        .state;
    for index in 0..320 {
        let value = if index % 2 == 0 {
            index as f64
        } else {
            -(index as f64)
        };
        donchian
            .step(
                &Bar {
                    time: index as f64,
                    open: value,
                    high: value + 1.0,
                    low: value - 1.0,
                    close: value,
                    volume: 1.0,
                },
                index,
            )
            .unwrap();
    }
    let snapshot = lossless(&donchian.snapshot());
    assert!(snapshot.contains(r#""head":0"#));

    let (_, rows) = run(IndicatorProgram::ParabolicSar, r#"{"step":0.02,"max":0.2}"#);
    assert_eq!(rows[1], vec![9.0, 1.0]);
    assert_eq!(rows[2], vec![12.5, -1.0]);
    assert_eq!(rows[3], vec![7.5, 1.0]);
}

#[test]
fn aroon_ties_keep_latest_index_and_expire_at_the_exact_boundary() {
    let mut state = create(IndicatorProgram::Aroon, &params(r#"{"period":3}"#))
        .unwrap()
        .state;
    for index in 0..4 {
        let zero = if index % 2 == 0 { -0.0 } else { 0.0 };
        let row = state
            .step(
                &Bar {
                    time: index as f64,
                    open: zero,
                    high: zero,
                    low: zero,
                    close: zero,
                    volume: 0.0,
                },
                index,
            )
            .unwrap();
        if index == 3 {
            assert_eq!(row.as_slice(), &[100.0, 100.0, 0.0]);
        }
    }
    let snapshot = lossless(&state.snapshot());
    assert!(snapshot.contains(r#""a":[[3,0]],"head":0"#));
}

#[test]
fn restore_preserves_negative_zero_heads_counters_and_entry_indices() {
    let mut roc = create(IndicatorProgram::Roc, &params(r#"{"period":3}"#))
        .unwrap()
        .state;
    roc.restore(&params(r#"{"head":-0,"a":[1,2,3]}"#)).unwrap();
    let roc_snapshot = roc.snapshot();
    assert!(lossless(&roc_snapshot).contains(r#""head":-0"#));

    let mut stoch = create(
        IndicatorProgram::StochRsi,
        &params(r#"{"period":3,"stochPeriod":3,"smoothK":2,"smoothD":2}"#),
    )
    .unwrap()
    .state;
    stoch
        .restore(&params(
            r#"{"previous":1,"valid":-0,"k":{"a":[],"head":-0,"sum":-0},"d":{"a":[],"head":0,"sum":0}}"#,
        ))
        .unwrap();
    let snapshot = lossless(&stoch.snapshot());
    assert!(snapshot.contains(r#""valid":-0"#));
    assert!(snapshot.contains(r#""head":-0,"sum":-0"#));

    let mut donchian = create(IndicatorProgram::Donchian, &params(r#"{"period":3}"#))
        .unwrap()
        .state;
    donchian
        .restore(&params(
            r#"{"h":{"a":[[-0,1]],"head":-0},"l":{"a":[[-0,-0]],"head":0}}"#,
        ))
        .unwrap();
    assert!(lossless(&donchian.snapshot()).contains(r#"[-0,1]"#));
}

#[test]
fn factory_validation_order_and_source_specific_errors_are_exact() {
    for (program, text, message) in [
        (
            IndicatorProgram::Rsi,
            r#"{"period":0}"#,
            "Period must be 1..10000",
        ),
        (
            IndicatorProgram::Stochastic,
            r#"{"period":3,"smoothK":0}"#,
            "Period must be 1..10000",
        ),
        (
            IndicatorProgram::Keltner,
            r#"{"period":3,"atrPeriod":2,"multiplier":-1}"#,
            "Multiplier",
        ),
        (
            IndicatorProgram::Supertrend,
            r#"{"period":3,"multiplier":0}"#,
            "Multiplier",
        ),
        (
            IndicatorProgram::Ichimoku,
            r#"{"conversion":2,"base":3,"span":4,"displacement":-1}"#,
            "Displacement",
        ),
        (
            IndicatorProgram::ParabolicSar,
            r#"{"step":0.3,"max":0.2}"#,
            "SAR acceleration",
        ),
    ] {
        let error = create(program, &params(text)).unwrap_err();
        assert_eq!(error.message.to_string_lossy(), message);
    }
    let common = create(IndicatorProgram::Rsi, &params(r#"{"period":null}"#)).unwrap_err();
    assert_eq!(
        common.message.to_string_lossy(),
        "Indicator parameter values"
    );
}

#[test]
fn hot_steps_do_not_reject_infinity_that_the_engine_owns_later() {
    let mut created = create(IndicatorProgram::Cci, &params(r#"{"period":1}"#)).unwrap();
    let huge = Bar {
        time: 0.0,
        open: f64::MAX,
        high: f64::MAX,
        low: f64::MAX,
        close: f64::MAX,
        volume: 0.0,
    };
    let _ = created.state.step(&huge, 0).unwrap();
}

#[test]
fn signed_zero_subnormal_and_max_value_corpus_matches_js_bits() {
    let configs = [
        (IndicatorProgram::Rsi, r#"{"period":1}"#),
        (IndicatorProgram::Atr, r#"{"period":1}"#),
        (IndicatorProgram::Donchian, r#"{"period":1}"#),
        (IndicatorProgram::Aroon, r#"{"period":1}"#),
        (
            IndicatorProgram::Stochastic,
            r#"{"period":1,"smoothK":1,"smoothD":1}"#,
        ),
        (IndicatorProgram::Roc, r#"{"period":1}"#),
        (IndicatorProgram::WilliamsR, r#"{"period":1}"#),
        (IndicatorProgram::Cci, r#"{"period":1}"#),
        (IndicatorProgram::Adx, r#"{"period":1}"#),
        (
            IndicatorProgram::Keltner,
            r#"{"period":1,"atrPeriod":1,"multiplier":0}"#,
        ),
        (
            IndicatorProgram::Supertrend,
            r#"{"period":1,"multiplier":1}"#,
        ),
        (
            IndicatorProgram::Ichimoku,
            r#"{"conversion":1,"base":1,"span":1,"displacement":0}"#,
        ),
        (
            IndicatorProgram::StochRsi,
            r#"{"period":1,"stochPeriod":1,"smoothK":1,"smoothD":1}"#,
        ),
        (IndicatorProgram::ParabolicSar, r#"{"step":0.02,"max":0.2}"#),
    ];
    let expected: [&[Option<u64>]; 14] = [
        &[Some(0x4059000000000000)],
        &[Some(0x7fefffffffffffff)],
        &[
            Some(0x7fdfffffffffffff),
            Some(0x7fefffffffffffff),
            Some(0x0000000000000000),
        ],
        &[
            Some(0x4059000000000000),
            Some(0x0000000000000000),
            Some(0x4059000000000000),
        ],
        &[None, None],
        &[Some(0x4210be08cec27e1d)],
        &[Some(0x8000000000000000)],
        &[None],
        &[None, Some(0x7ff0000000000000), Some(0x0000000000000000)],
        &[
            Some(0x7fefffffffffffff),
            Some(0x7fefffffffffffff),
            Some(0x7fefffffffffffff),
        ],
        &[Some(0xfe47e43c8800759c), Some(0x3ff0000000000000)],
        &[
            Some(0x7fdfffffffffffff),
            Some(0x7fdfffffffffffff),
            Some(0x7fdfffffffffffff),
            Some(0x7fdfffffffffffff),
            Some(0x7fefffffffffffff),
        ],
        &[Some(0x4049000000000000), Some(0x4049000000000000)],
        &[Some(0xfe37e43c8800759c), Some(0x3ff0000000000000)],
    ];
    let minimum = f64::from_bits(1);
    let edge = [
        Bar {
            time: 0.0,
            open: -0.0,
            high: 0.0,
            low: -0.0,
            close: -0.0,
            volume: -0.0,
        },
        Bar {
            time: 1.0,
            open: 0.0,
            high: minimum,
            low: -minimum,
            close: minimum,
            volume: 0.0,
        },
        Bar {
            time: 2.0,
            open: minimum,
            high: 1.0,
            low: -1.0,
            close: -minimum,
            volume: 1.0,
        },
        Bar {
            time: 3.0,
            open: -1.0,
            high: 1e300,
            low: -1e300,
            close: 1e300,
            volume: 0.0,
        },
        Bar {
            time: 4.0,
            open: 1e300,
            high: f64::MAX,
            low: 0.0,
            close: f64::MAX,
            volume: 1.0,
        },
    ];
    for ((program, config_text), expected) in configs.into_iter().zip(expected) {
        let mut state = create(program, &params(config_text)).unwrap().state;
        let mut row = None;
        for (index, bar) in edge.iter().enumerate() {
            row = Some(state.step(bar, index).unwrap());
        }
        for (actual, expected) in row.unwrap().as_slice().iter().zip(expected) {
            match expected {
                Some(bits) => assert_eq!(actual.to_bits(), *bits, "{} edge", program.name()),
                None => assert!(actual.is_nan(), "{} edge NaN", program.name()),
            }
        }
    }
}

fn lossless(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Lossless)).unwrap()
}

fn reverse_object(value: &JsValue) -> JsValue {
    if let JsValue::Array(values) = value {
        return JsValue::Array(values.iter().map(reverse_object).collect());
    }
    let JsValue::Object(object) = value else {
        return value.clone();
    };
    let extreme = matches!(
        object.get(&barochart_js::string::JsString::from_str("a")),
        Some(JsValue::Array(values)) if values.first().is_none_or(|value| matches!(value, JsValue::Array(_)))
    ) && object
        .get(&barochart_js::string::JsString::from_str("head"))
        .is_some()
        && object.len() == 2;
    let entries: Vec<_> = object
        .iter()
        .map(|(key, value)| (key.clone(), reverse_object(value)))
        .collect();
    let mut reversed = JsObject::new();
    if extreme {
        for (key, value) in entries {
            reversed.insert(key, value);
        }
    } else {
        for (key, value) in entries.into_iter().rev() {
            reversed.insert(key, value);
        }
    }
    JsValue::Object(reversed)
}

fn string_field(value: &JsValue, key: &str) -> String {
    let JsValue::Object(object) = value else {
        panic!("fixture object")
    };
    let Some(JsValue::String(value)) = object.get(&barochart_js::string::JsString::from_str(key))
    else {
        panic!("fixture string {key}")
    };
    value.to_string_lossy()
}

fn string_array_field(value: &JsValue, key: &str) -> Vec<String> {
    let JsValue::Object(object) = value else {
        panic!("fixture object")
    };
    let Some(JsValue::Array(values)) = object.get(&barochart_js::string::JsString::from_str(key))
    else {
        panic!("fixture array {key}")
    };
    values
        .iter()
        .map(|value| {
            let JsValue::String(value) = value else {
                panic!("fixture string array")
            };
            value.to_string_lossy()
        })
        .collect()
}

fn rows_bits_field(value: &JsValue, key: &str) -> Vec<Vec<Option<u64>>> {
    let JsValue::Object(object) = value else {
        panic!("fixture object")
    };
    let Some(JsValue::Array(rows)) = object.get(&barochart_js::string::JsString::from_str(key))
    else {
        panic!("fixture rows {key}")
    };
    rows.iter()
        .map(|row| {
            let JsValue::Array(values) = row else {
                panic!("fixture row")
            };
            values
                .iter()
                .map(|value| match value {
                    JsValue::Null => None,
                    JsValue::String(value) => {
                        Some(u64::from_str_radix(&value.to_string_lossy(), 16).unwrap())
                    }
                    _ => panic!("fixture bits"),
                })
                .collect()
        })
        .collect()
}
