use barochart_core::{drawing_edit, drawing_types, drawings};

use std::sync::Arc;

use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawing_edit::{
    DrawingAxisBinding, DrawingBindingContext, DrawingEditContext, DrawingInvalidation,
    DrawingPanelBinding, DrawingSeriesBinding, delete_drawings, duplicate_drawings,
    set_drawings_style, set_drawings_visibility, translate_drawings,
};
use drawings::{DrawingStore, DrawingStoreConfig};

fn key(name: &str) -> JsString {
    JsString::from_str(name)
}

fn text(value: &str) -> JsValue {
    JsValue::String(key(value))
}

fn record(fields: &[(&str, JsValue)]) -> JsValue {
    let mut object = JsObject::new();
    for (field, value) in fields {
        object.insert(key(field), value.clone());
    }
    JsValue::Object(object)
}

fn point(time: f64, price: f64) -> JsValue {
    record(&[
        ("time", JsValue::Number(time)),
        ("price", JsValue::Number(price)),
    ])
}

fn horizontal(id: &str, time: f64, price: f64) -> JsValue {
    record(&[
        ("id", text(id)),
        ("type", text("horizontal")),
        ("panel", text("price")),
        ("points", JsValue::Array(vec![point(time, price)])),
    ])
}

fn position(id: &str, entry: f64, stop: f64, target: f64, end_time: f64) -> JsValue {
    record(&[
        ("id", text(id)),
        ("type", text("longposition")),
        ("panel", text("price")),
        (
            "points",
            JsValue::Array(vec![
                point(10.0, entry),
                point(10.0, stop),
                point(10.0, target),
                point(end_time, entry),
            ]),
        ),
    ])
}

fn string_array(values: &[&str]) -> JsValue {
    JsValue::Array(values.iter().map(|value| text(value)).collect())
}

fn bindings<'a>(
    panels: &'a [DrawingPanelBinding],
    axes: &'a [DrawingAxisBinding],
    series: &'a [DrawingSeriesBinding],
) -> DrawingBindingContext<'a> {
    DrawingBindingContext {
        panels,
        axes,
        series,
    }
}

#[test]
fn group_translation_is_prepared_atomically_and_preserves_source_z_order() {
    let panels = [DrawingPanelBinding { id: key("price") }];
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    store.add(&horizontal("a", 10.0, 2.0)).unwrap();
    store.add(&horizontal("b", 20.0, 5.0)).unwrap();
    let context_bindings = bindings(&panels, &[], &[]);
    let mut context = DrawingEditContext {
        bindings: Some(context_bindings),
        ..DrawingEditContext::default()
    };
    let receipt = translate_drawings(
        &mut store,
        &string_array(&["b", "a"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(1.5)),
            ("deltaPrice", JsValue::Number(-2.0)),
        ]),
        &mut context,
    )
    .unwrap();
    assert_eq!(receipt.changed, 2);
    assert_eq!(
        store.items()[0].points[0],
        drawing_types::DrawingPoint {
            time: 11.5,
            price: 0.0
        }
    );
    assert_eq!(
        store.items()[1].points[0],
        drawing_types::DrawingPoint {
            time: 21.5,
            price: 3.0
        }
    );
    assert_eq!(store.undo_stack().len(), 3);
    assert!(store.undo().unwrap());
    assert_eq!(store.items()[0].points[0].price, 2.0);
    assert!(store.redo().unwrap());
    assert_eq!(store.items()[0].points[0].price, 0.0);
}

#[test]
fn duplicate_options_precede_gesture_and_duplicates_follow_store_order() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    store.add(&horizontal("first", 10.0, 1.0)).unwrap();
    store.add(&horizontal("second", 20.0, 2.0)).unwrap();
    let mut gesture = DrawingEditContext {
        active_gesture: true,
        ..DrawingEditContext::default()
    };
    let malformed = record(&[
        ("deltaTimeMs", JsValue::Number(0.0)),
        ("extra", JsValue::Bool(true)),
    ]);
    assert_eq!(
        duplicate_drawings(
            &mut store,
            &string_array(&["first"]),
            &malformed,
            &mut gesture
        )
        .unwrap_err()
        .message,
        key("Drawing group edit fields")
    );
    let before = store.items().to_vec();
    assert_eq!(store.items().len(), 2);

    let mut context = DrawingEditContext::default();
    let result = duplicate_drawings(
        &mut store,
        &string_array(&["second", "first"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(0.0)),
            ("deltaPrice", JsValue::Number(0.0)),
        ]),
        &mut context,
    )
    .unwrap();
    assert_eq!(result.changed, 2);
    let created = result.created.as_ref().unwrap();
    assert_eq!(created[0].source_id, key("first"));
    assert_eq!(created[1].source_id, key("second"));
    assert_eq!(store.items()[2].id, key("drawing-1"));
    assert_eq!(store.items()[3].id, key("drawing-2"));
    assert_eq!(store.items()[2].locked, Some(false));
    assert!(Arc::ptr_eq(&before[0].points, &store.items()[2].points));
    assert_eq!(store.selected(), Some(&key("second")));
}

#[test]
fn duplicate_skips_generated_id_collisions_and_translates_bound_copies() {
    let panels = [DrawingPanelBinding { id: key("price") }];
    let axes = [DrawingAxisBinding {
        id: key("A"),
        panel: key("price"),
    }];
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    store.add(&horizontal("drawing-1", 1.0, 1.0)).unwrap();
    let source = record(&[
        ("id", text("source")),
        ("type", text("horizontal")),
        ("panel", text("price")),
        ("axisId", text("A")),
        ("locked", JsValue::Bool(true)),
        ("points", JsValue::Array(vec![point(5.0, 7.0)])),
    ]);
    store.add(&source).unwrap();
    let mut context = DrawingEditContext {
        bindings: Some(bindings(&panels, &axes, &[])),
        ..DrawingEditContext::default()
    };
    let receipt = duplicate_drawings(
        &mut store,
        &string_array(&["source"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(0.5)),
            ("deltaPrice", JsValue::Number(-2.0)),
        ]),
        &mut context,
    )
    .unwrap();
    assert_eq!(receipt.changed, 1);
    assert_eq!(receipt.created.as_ref().unwrap()[0].id, key("drawing-2"));
    assert_eq!(
        store.items()[2].points[0],
        drawing_types::DrawingPoint {
            time: 5.5,
            price: 5.0
        }
    );
    assert_eq!(store.items()[2].axis_id, Some(key("A")));
    assert_eq!(store.items()[2].locked, Some(false));
}

#[test]
fn style_visibility_and_delete_share_unmodified_fields_and_keep_failure_atomicity() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    store.add(&horizontal("a", 10.0, 2.0)).unwrap();
    store.add(&horizontal("b", 20.0, 5.0)).unwrap();
    store.select(Some(&key("a"))).unwrap();
    let anchors = store.items()[0].points.clone();
    let mut context = DrawingEditContext::default();
    let receipt = set_drawings_style(
        &mut store,
        &string_array(&["a"]),
        &record(&[("color", text("red"))]),
        &mut context,
    )
    .unwrap();
    assert_eq!(receipt.changed, 1);
    assert_eq!(
        store.items()[0].style.as_ref().unwrap().color,
        Some(key("#ff0000ff"))
    );
    assert!(Arc::ptr_eq(&anchors, &store.items()[0].points));

    let locked = store.edit(&key("a"), &record(&[("locked", JsValue::Bool(true))]));
    assert!(locked.is_ok());
    let before = store.snapshot();
    let before_undo = store.undo_stack().to_vec();
    let result = delete_drawings(&mut store, &string_array(&["a", "b"]), &mut context);
    assert_eq!(result.unwrap_err().message, key("Drawing is locked"));
    assert!(
        before
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(store.undo_stack().len(), before_undo.len());

    let receipt = set_drawings_visibility(
        &mut store,
        &string_array(&["a"]),
        &JsValue::Bool(false),
        &mut context,
    )
    .unwrap();
    assert_eq!(receipt.changed, 1);
    assert_eq!(store.selected(), None);
    assert_eq!(store.items()[0].visible, Some(false));
    assert_eq!(store.items()[0].locked, Some(true));

    store
        .edit(&key("a"), &record(&[("locked", JsValue::Bool(false))]))
        .unwrap();
    store.select(Some(&key("b"))).unwrap();
    let receipt = delete_drawings(&mut store, &string_array(&["b"]), &mut context).unwrap();
    assert_eq!(receipt.changed, 1);
    assert_eq!(receipt.created, None);
    assert_eq!(store.items().len(), 1);
    assert_eq!(store.items()[0].id, key("a"));
    assert_eq!(store.selected(), None);
}

#[test]
fn translation_binding_and_date_overflow_leave_frames_history_and_serial_unchanged() {
    let panels = [DrawingPanelBinding { id: key("price") }];
    let axes = [DrawingAxisBinding {
        id: key("A"),
        panel: key("price"),
    }];
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let base_position = position("p", 10.0, 9.0, 12.0, 20.0);
    let mut bound_position = match &base_position {
        JsValue::Object(value) => value.clone(),
        _ => unreachable!(),
    };
    bound_position.insert(JsString::from_str("axisId"), text("B"));
    store.add(&JsValue::Object(bound_position)).unwrap();
    let mut context = DrawingEditContext {
        bindings: Some(bindings(&panels, &axes, &[])),
        ..DrawingEditContext::default()
    };
    let id = string_array(&["p"]);
    let before = store.snapshot();
    let undo = store.undo_stack().to_vec();
    let serial = store.serial();
    let error = translate_drawings(
        &mut store,
        &id,
        &record(&[
            ("deltaTimeMs", JsValue::Number(1.0)),
            ("deltaPrice", JsValue::Number(0.0)),
        ]),
        &mut context,
    )
    .unwrap_err();
    assert_eq!(error.message, key("Missing or mismatched drawing binding"));
    assert!(
        before
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(store.undo_stack().len(), undo.len());
    assert_eq!(store.serial(), serial);

    let mut date_store = DrawingStore::with_defaults(NumberDialect::Ecma);
    date_store
        .add(&position("edge", 10.0, 9.0, 12.0, 8_639_999_999_999_999.0))
        .unwrap();
    let panels = [DrawingPanelBinding { id: key("price") }];
    let mut context = DrawingEditContext {
        bindings: Some(bindings(&panels, &[], &[])),
        ..DrawingEditContext::default()
    };
    let before = date_store.snapshot();
    let error = translate_drawings(
        &mut date_store,
        &string_array(&["edge"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(2.0)),
            ("deltaPrice", JsValue::Number(0.0)),
        ]),
        &mut context,
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        key("Anchor time/price must be finite and within Date range")
    );
    assert!(
        before
            .iter()
            .zip(date_store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
}

#[test]
fn missing_late_ids_and_group_budgets_do_not_publish_earlier_staged_records() {
    let panels = [DrawingPanelBinding { id: key("price") }];
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    store.add(&horizontal("first", 10.0, 1.0)).unwrap();
    store.add(&horizontal("second", 20.0, 2.0)).unwrap();
    let mut context = DrawingEditContext {
        bindings: Some(bindings(&panels, &[], &[])),
        ..DrawingEditContext::default()
    };
    let before = store.snapshot();
    let history = store.undo_stack().to_vec();
    let error = translate_drawings(
        &mut store,
        &string_array(&["first", "missing"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(1.0)),
            ("deltaPrice", JsValue::Number(1.0)),
        ]),
        &mut context,
    )
    .unwrap_err();
    assert_eq!(error.message, key("Missing drawing"));
    assert!(
        before
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(store.undo_stack().len(), history.len());

    let mut limited = DrawingStore::new(
        DrawingStoreConfig {
            max_drawings: 1,
            ..DrawingStoreConfig::default()
        },
        NumberDialect::Ecma,
    )
    .unwrap();
    limited.add(&horizontal("only", 10.0, 1.0)).unwrap();
    let before = limited.snapshot();
    let mut no_binding_context = DrawingEditContext::default();
    assert_eq!(
        duplicate_drawings(
            &mut limited,
            &string_array(&["only"]),
            &record(&[
                ("deltaTimeMs", JsValue::Number(0.0)),
                ("deltaPrice", JsValue::Number(0.0))
            ]),
            &mut no_binding_context,
        )
        .unwrap_err()
        .message,
        key("Drawing duplication resource limit")
    );
    assert!(
        before
            .iter()
            .zip(limited.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(limited.serial(), 0);
}

#[test]
fn group_edit_budget_error_is_distinct_from_silent_ordinary_history_trim() {
    let mut store = DrawingStore::new(
        DrawingStoreConfig {
            history_bytes: 0,
            ..DrawingStoreConfig::default()
        },
        NumberDialect::Ecma,
    )
    .unwrap();
    let id = store.add(&horizontal("a", 10.0, 1.0)).unwrap();
    store.edit(&id, &record(&[("text", text("kept"))])).unwrap();
    assert!(
        store.undo_stack().is_empty(),
        "ordinary trim silently drops oversized history"
    );
    let before = store.snapshot();
    let panels = [DrawingPanelBinding { id: key("price") }];
    let mut context = DrawingEditContext {
        bindings: Some(bindings(&panels, &[], &[])),
        ..DrawingEditContext::default()
    };
    let err = translate_drawings(
        &mut store,
        &string_array(&["a"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(1.0)),
            ("deltaPrice", JsValue::Number(0.0)),
        ]),
        &mut context,
    )
    .unwrap_err();
    assert_eq!(
        err.message,
        key("Drawing group edit undo snapshot exceeds historyBytes")
    );
    assert!(
        before
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(store.undo_stack().len(), 0);
}

#[test]
fn invalidation_failure_is_reported_after_successful_commit() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    store.add(&horizontal("a", 10.0, 1.0)).unwrap();
    let panels = [DrawingPanelBinding { id: key("price") }];
    let mut invalidations = Vec::new();
    let mut invalidate = |kind| {
        invalidations.push(kind);
        Err(barochart_js::error::JsError::new("Error", key("renderer")))
    };
    let mut context = DrawingEditContext {
        bindings: Some(bindings(&panels, &[], &[])),
        invalidate: Some(&mut invalidate),
        ..DrawingEditContext::default()
    };
    let receipt = duplicate_drawings(
        &mut store,
        &string_array(&["a"]),
        &record(&[
            ("deltaTimeMs", JsValue::Number(0.0)),
            ("deltaPrice", JsValue::Number(0.0)),
        ]),
        &mut context,
    )
    .unwrap();
    assert!(receipt.invalidation_failed);
    assert_eq!(store.items().len(), 2);
    assert_eq!(store.undo_stack().len(), 2);
    assert_eq!(invalidations, vec![DrawingInvalidation::Drawings]);
}
