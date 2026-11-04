use barochart_core::{drawing_document, drawings};

use std::sync::Arc;

use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawings::{DrawingStore, DrawingStoreConfig};

fn key(value: &str) -> JsString {
    JsString::from_str(value)
}

fn record(fields: &[(&str, JsValue)]) -> JsValue {
    let mut object = JsObject::new();
    for (field, value) in fields {
        object.insert(key(field), value.clone());
    }
    JsValue::Object(object)
}

fn horizontal(id: &str, time: f64, price: f64, text: Option<&str>) -> JsValue {
    let point = record(&[
        ("time", JsValue::Number(time)),
        ("price", JsValue::Number(price)),
    ]);
    let mut fields = vec![
        ("id", JsValue::String(key(id))),
        ("type", JsValue::String(key("horizontal"))),
        ("panel", JsValue::String(key("price"))),
        ("points", JsValue::Array(vec![point])),
    ];
    if let Some(text) = text {
        fields.push(("text", JsValue::String(key(text))));
    }
    record(&fields)
}

fn make_store(config: DrawingStoreConfig) -> DrawingStore {
    DrawingStore::new(config, NumberDialect::Ecma).unwrap()
}

#[test]
fn add_edit_remove_select_and_auto_transactions_preserve_immutable_identity_rules() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let id = store
        .add(&horizontal("d", 1.25, -0.0, Some("memo")))
        .unwrap();
    assert_eq!(id, key("d"));
    assert_eq!(store.selected(), Some(&id));
    let before = store.items()[0].clone();
    let points = before.points.clone();
    let style = before.style.clone();
    let history = store.undo_stack().len();

    store
        .edit(&id, &record(&[("text", JsValue::String(key("edited")))]))
        .unwrap();
    assert_eq!(store.undo_stack().len(), history + 1);
    assert!(!Arc::ptr_eq(&before, &store.items()[0]));
    assert!(Arc::ptr_eq(&points, &store.items()[0].points));
    assert!(Arc::ptr_eq(
        style.as_ref().unwrap(),
        store.items()[0].style.as_ref().unwrap()
    ));
    let edited = store.items()[0].clone();
    assert!(store.undo().unwrap());
    assert!(Arc::ptr_eq(&before, &store.items()[0]));
    assert!(store.redo().unwrap());
    assert!(Arc::ptr_eq(&edited, &store.items()[0]));

    let after_redo = store.items()[0].clone();
    let before_noop_history = store.undo_stack().len();
    let before_noop_redo = store.redo_stack().len();
    store
        .edit(&id, &record(&[("text", JsValue::String(key("edited")))]))
        .unwrap();
    assert!(Arc::ptr_eq(&after_redo, &store.items()[0]));
    assert_eq!(store.undo_stack().len(), before_noop_history);
    assert_eq!(store.redo_stack().len(), before_noop_redo);

    store.select(Some(&id)).unwrap();
    store
        .edit(&id, &record(&[("locked", JsValue::Bool(true))]))
        .unwrap();
    let locked = store.snapshot();
    assert!(!store.remove(&id).unwrap());
    assert!(
        locked
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert!(!store.remove(&key("missing")).unwrap());
    store
        .edit(&id, &record(&[("locked", JsValue::Bool(false))]))
        .unwrap();
    assert!(store.remove(&id).unwrap());
    assert!(store.items().is_empty());
    assert_eq!(store.selected(), None);
}

#[test]
fn no_op_edit_canonical_fallback_uses_key_order_but_keeps_record_identity() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let mut initial_style = JsObject::new();
    initial_style.insert(key("color"), JsValue::String(key("#ffffff")));
    initial_style.insert(key("width"), JsValue::Number(2.0));
    let id = store
        .add(&record(&[
            ("id", JsValue::String(key("stable"))),
            ("type", JsValue::String(key("horizontal"))),
            ("panel", JsValue::String(key("price"))),
            (
                "points",
                JsValue::Array(vec![record(&[
                    ("time", JsValue::Number(1.0)),
                    ("price", JsValue::Number(2.0)),
                ])]),
            ),
            ("style", JsValue::Object(initial_style)),
        ]))
        .unwrap();
    let before = store.items()[0].clone();
    let history = store.undo_stack().len();
    let mut reordered_style = JsObject::new();
    reordered_style.insert(key("width"), JsValue::Number(2.0));
    reordered_style.insert(key("color"), JsValue::String(key("#ffffff")));
    store
        .edit(&id, &record(&[("style", JsValue::Object(reordered_style))]))
        .unwrap();
    assert!(Arc::ptr_eq(&before, &store.items()[0]));
    assert_eq!(store.undo_stack().len(), history);
}

#[test]
fn generated_serial_survives_undo_cancel_and_document_load() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let first = store.add(&horizontal("", 1.0, 2.0, None)).unwrap();
    assert_eq!(first, key("drawing-1"));
    assert!(store.undo().unwrap());
    let second = store.add(&horizontal("", 2.0, 3.0, None)).unwrap();
    assert_eq!(second, key("drawing-2"));

    store.begin().unwrap();
    let third = store.add(&horizontal("", 3.0, 4.0, None)).unwrap();
    assert_eq!(third, key("drawing-3"));
    store.cancel();
    assert_eq!(store.serial(), 3, "cancel does not roll back generated IDs");
    assert!(store.items().iter().all(|drawing| drawing.id != third));

    let saved = store.save().unwrap();
    let serial = store.serial();
    store
        .load(&saved, &drawing_document::DrawingDocumentContext::default())
        .unwrap();
    assert_eq!(store.serial(), serial);
    let next = store.add(&horizontal("", 4.0, 5.0, None)).unwrap();
    assert_eq!(next, key("drawing-4"));
}

#[test]
fn history_weight_counts_two_utf16_units_per_json_character_and_ordinary_trim_drops_oversize() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let id = store.add(&horizontal("d", 1.0, 2.0, Some("😀"))).unwrap();
    store
        .edit(&id, &record(&[("text", JsValue::String(key("next")))]))
        .unwrap();
    let prior = store.undo_stack().last().unwrap();
    let json = stringify_json(&prior[0].to_value(), JsonMode::Standard);
    let units = std::str::from_utf8(&json).unwrap().encode_utf16().count();
    assert_eq!(store.retained_history_bytes(), 8 + units * 2);
    assert!(std::str::from_utf8(&json).unwrap().len() > units);

    let mut tiny = make_store(DrawingStoreConfig {
        history_limit: 1,
        history_bytes: 0,
        ..DrawingStoreConfig::default()
    });
    let id = tiny.add(&horizontal("tiny", 1.0, 2.0, None)).unwrap();
    tiny.edit(
        &id,
        &record(&[("text", JsValue::String(key("oversized snapshot")))]),
    )
    .unwrap();
    assert!(tiny.undo_stack().is_empty());
    assert_eq!(tiny.retained_history_bytes(), 0);
}

#[test]
fn options_validation_and_save_limits_keep_exact_type_and_range_errors() {
    let invalid = record(&[("historyLimit", JsValue::Number(0.0))]);
    assert_eq!(
        DrawingStore::from_options(&invalid, NumberDialect::Ecma)
            .err()
            .unwrap()
            .message,
        key("History limit 1..10000")
    );
    let invalid = record(&[("maxPoints", JsValue::Number(f64::INFINITY))]);
    assert_eq!(
        DrawingStore::from_options(&invalid, NumberDialect::Ecma)
            .err()
            .unwrap()
            .message,
        key("maxPoints: limit 2097152")
    );

    let empty = make_store(DrawingStoreConfig {
        max_document_chars: 1,
        ..DrawingStoreConfig::default()
    });
    let error = empty.save().unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, key("Drawing document: string limit 1"));
}

#[test]
fn position_metrics_query_is_pure_and_rejects_non_position_ids() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let id = store
        .add(&record(&[
            ("id", JsValue::String(key("position"))),
            ("type", JsValue::String(key("longposition"))),
            ("panel", JsValue::String(key("price"))),
            (
                "points",
                JsValue::Array(vec![
                    record(&[
                        ("time", JsValue::Number(1.0)),
                        ("price", JsValue::Number(50.0)),
                    ]),
                    record(&[
                        ("time", JsValue::Number(1.0)),
                        ("price", JsValue::Number(40.0)),
                    ]),
                    record(&[
                        ("time", JsValue::Number(1.0)),
                        ("price", JsValue::Number(70.0)),
                    ]),
                    record(&[
                        ("time", JsValue::Number(2.0)),
                        ("price", JsValue::Number(50.0)),
                    ]),
                ]),
            ),
        ]))
        .unwrap();
    let before_items = store.snapshot();
    let history = store.undo_stack().to_vec();
    let metrics = store.position_metrics(&id).unwrap();
    assert_eq!(
        (metrics.risk, metrics.reward, metrics.ratio),
        (10.0, 20.0, 2.0)
    );
    assert!(
        before_items
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(store.undo_stack().len(), history.len());

    let horizontal = store.add(&horizontal("plain", 1.0, 2.0, None)).unwrap();
    assert_eq!(
        store.position_metrics(&horizontal).unwrap_err().message,
        key("Position drawing required")
    );
}
