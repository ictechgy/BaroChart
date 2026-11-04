use barochart_core::{drawing_types, position_drawing};

use std::sync::Arc;

use barochart_js::json::{JsonMode, stringify_json};
use barochart_js::string::JsString;
use drawing_types::{Drawing, DrawingPoint, DrawingPoints, DrawingType};
use position_drawing::{
    drawing_document_version, position_metrics_for, validate_drawing_document_version,
};

fn position(kind: DrawingType, entry: f64, stop: f64, target: f64) -> Drawing {
    Drawing::from_parts_unaccounted(
        &JsString::from_str("p"),
        &JsString::from_str("price"),
        None,
        None,
        kind,
        DrawingPoints::from_vec_unaccounted(vec![
            DrawingPoint {
                time: 10.0,
                price: entry,
            },
            DrawingPoint {
                time: 10.0,
                price: stop,
            },
            DrawingPoint {
                time: 10.0,
                price: target,
            },
            DrawingPoint {
                time: 20.0,
                price: entry,
            },
        ]),
        None,
        None,
        None,
        None,
    )
}

#[test]
fn long_and_short_metrics_keep_raw_f64_arithmetic() {
    let long = position(DrawingType::LongPosition, 50.0, 40.0, 70.0);
    let metrics = position_metrics_for(&long).unwrap();
    assert_eq!(metrics.direction, "long");
    assert_eq!(
        (metrics.risk, metrics.reward, metrics.ratio),
        (10.0, 20.0, 2.0)
    );
    assert_eq!(
        (metrics.risk_percent, metrics.reward_percent),
        (Some(20.0), Some(40.0))
    );
    assert_eq!(
        String::from_utf8(stringify_json(&metrics.to_value(), JsonMode::Standard)).unwrap(),
        r#"{"direction":"long","startTime":10,"endTime":20,"entry":50,"stop":40,"target":70,"risk":10,"reward":20,"riskPercent":20,"rewardPercent":40,"ratio":2}"#
    );

    let short = position(DrawingType::ShortPosition, 50.0, 60.0, 30.0);
    let metrics = position_metrics_for(&short).unwrap();
    assert_eq!(metrics.direction, "short");
    assert_eq!(
        (metrics.risk, metrics.reward, metrics.ratio),
        (10.0, 20.0, 2.0)
    );
}

#[test]
fn percentages_are_null_when_division_overflows_and_subnormal_risk_is_valid() {
    let zero_entry = position(DrawingType::LongPosition, 0.0, -1.0, 2.0);
    let metrics = position_metrics_for(&zero_entry).unwrap();
    assert_eq!((metrics.risk_percent, metrics.reward_percent), (None, None));

    let tiny = f64::from_bits(1);
    let subnormal = position(DrawingType::LongPosition, 0.0, -tiny, tiny);
    let metrics = position_metrics_for(&subnormal).unwrap();
    assert_eq!(
        (metrics.risk, metrics.reward, metrics.ratio),
        (tiny, tiny, 1.0)
    );
    assert_eq!((metrics.risk_percent, metrics.reward_percent), (None, None));
}

#[test]
fn position_validation_reports_anchor_order_before_metric_order() {
    let mut mismatch = position(DrawingType::LongPosition, 50.0, 40.0, 70.0);
    let mut points = mismatch.points.to_vec();
    points[1].time = 11.0;
    mismatch.points = DrawingPoints::from_vec_unaccounted(points);
    let error = position_metrics_for(&mismatch).unwrap_err();
    assert_eq!(error.name, "RangeError");
    assert_eq!(
        error.message,
        JsString::from_str("Position anchors require shared start/entry and positive time extent")
    );

    let overflow = position(DrawingType::LongPosition, 1.0e308, -1.0e308, 1.1e308);
    let error = position_metrics_for(&overflow).unwrap_err();
    assert_eq!(
        error.message,
        JsString::from_str(
            "Position requires ordered entry/stop/target and finite positive risk, reward and ratio"
        )
    );
}

#[test]
fn ratio_overflow_and_underflow_fail_without_epsilon_tolerance() {
    let tiny = f64::from_bits(1);
    for drawing in [
        position(DrawingType::LongPosition, 0.0, -tiny, 1.0),
        position(DrawingType::LongPosition, 0.0, -1.0e308, tiny),
    ] {
        assert_eq!(
            position_metrics_for(&drawing).unwrap_err().name,
            "RangeError"
        );
    }
    let narrow = position(
        DrawingType::LongPosition,
        1.0 + f64::EPSILON,
        1.0,
        1.0 + 3.0 * f64::EPSILON,
    );
    let metrics = position_metrics_for(&narrow).unwrap();
    assert_eq!(
        (metrics.risk, metrics.reward, metrics.ratio),
        (f64::EPSILON, 2.0 * f64::EPSILON, 2.0)
    );
}

#[test]
fn document_versions_are_minimal_and_feature_checked() {
    let mut ordinary = position(DrawingType::Horizontal, 1.0, 0.0, 0.0);
    ordinary.points = DrawingPoints::from_vec_unaccounted(vec![DrawingPoint {
        time: 1.0,
        price: 2.0,
    }]);
    let cloned = |drawing: &Drawing| {
        Arc::new(barochart_core::drawing_validation::validate_drawing(&drawing.to_value()).unwrap())
    };
    assert_eq!(drawing_document_version(&[cloned(&ordinary)]), 1);
    ordinary.axis_id = Some(JsString::from_str("axis"));
    assert_eq!(drawing_document_version(&[cloned(&ordinary)]), 2);
    assert!(validate_drawing_document_version(&ordinary, 1.0).is_err());

    let mut position = position(DrawingType::LongPosition, 5.0, 4.0, 6.0);
    assert_eq!(drawing_document_version(&[cloned(&position)]), 3);
    assert!(validate_drawing_document_version(&position, 2.0).is_err());
    position.visible = Some(true);
    assert_eq!(drawing_document_version(&[cloned(&position)]), 4);
    assert!(validate_drawing_document_version(&position, 3.0).is_err());
    assert!(validate_drawing_document_version(&position, 4.0).is_ok());
}
