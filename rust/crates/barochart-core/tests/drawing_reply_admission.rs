use std::sync::Arc;

use barochart_core::drawing_document::DrawingDocumentContext;
use barochart_core::drawings::{DrawingSnapshot, DrawingStore};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

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

fn horizontal(id: &str, time: f64, price: f64) -> JsValue {
    record(&[
        ("id", JsValue::String(key(id))),
        ("type", JsValue::String(key("horizontal"))),
        ("panel", JsValue::String(key("price"))),
        (
            "points",
            JsValue::Array(vec![record(&[
                ("time", JsValue::Number(time)),
                ("price", JsValue::Number(price)),
            ])]),
        ),
    ])
}

struct State {
    token: barochart_core::drawings::DrawingWorkspaceCaptureToken,
    items: DrawingSnapshot,
    undo: Vec<DrawingSnapshot>,
    redo: Vec<DrawingSnapshot>,
    selected: Option<JsString>,
    serial: u64,
    retained: usize,
}

fn state(store: &DrawingStore) -> State {
    State {
        token: store.capture_workspace_state().unwrap(),
        items: store.snapshot(),
        undo: store.undo_stack().to_vec(),
        redo: store.redo_stack().to_vec(),
        selected: store.selected().cloned(),
        serial: store.serial(),
        retained: store.retained_history_bytes(),
    }
}

fn assert_unchanged(store: &DrawingStore, before: &State) {
    assert!(store.validate_workspace_state(&before.token));
    assert!(
        store
            .items()
            .iter()
            .zip(before.items.iter())
            .all(|(current, old)| Arc::ptr_eq(current, old))
    );
    assert_eq!(store.undo_stack().len(), before.undo.len());
    assert_eq!(store.redo_stack().len(), before.redo.len());
    assert!(
        store
            .undo_stack()
            .iter()
            .zip(&before.undo)
            .all(|(current, old)| Arc::ptr_eq(current, old))
    );
    assert!(
        store
            .redo_stack()
            .iter()
            .zip(&before.redo)
            .all(|(current, old)| Arc::ptr_eq(current, old))
    );
    assert_eq!(store.selected(), before.selected.as_ref());
    assert_eq!(store.serial(), before.serial);
    assert_eq!(store.retained_history_bytes(), before.retained);
}

fn denied() -> impl FnMut() -> Result<(), JsError> {
    || Err(JsError::new("InternalError", key("out of memory")))
}

#[test]
fn select_load_and_edit_denial_preserve_items_history_and_selection() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let id = store.add(&horizontal("d", 1.0, 2.0)).unwrap();
    let before = state(&store);
    let error = store
        .select_with_reply_gate(Some(&id), &mut denied())
        .expect_err("reply denial");
    assert_eq!(error.name, "InternalError");
    assert_unchanged(&store, &before);

    let mut source = DrawingStore::with_defaults(NumberDialect::Ecma);
    source.add(&horizontal("new", 2.0, 4.0)).unwrap();
    let document = source.save().unwrap();
    let before = state(&store);
    let error = store
        .load_with_reply_gate(&document, &DrawingDocumentContext::default(), &mut denied())
        .expect_err("reply denial");
    assert_eq!(error.name, "InternalError");
    assert_unchanged(&store, &before);

    let before = state(&store);
    let error = store
        .edit_with_reply_gate(
            &id,
            &record(&[("text", JsValue::String(key("edited")))]),
            &mut denied(),
        )
        .expect_err("reply denial");
    assert_eq!(error.name, "InternalError");
    assert_unchanged(&store, &before);
}

#[test]
fn undo_and_redo_denial_preserve_history_then_publish_once_when_admitted() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let id = store.add(&horizontal("d", 1.0, 2.0)).unwrap();
    store
        .edit(&id, &record(&[("text", JsValue::String(key("edited")))]))
        .unwrap();

    let before = state(&store);
    let error = store
        .undo_with_reply_gate(&mut denied())
        .expect_err("reply denial");
    assert_eq!(error.name, "InternalError");
    assert_unchanged(&store, &before);

    let mut calls = 0;
    assert!(
        store
            .undo_with_reply_gate(&mut || {
                calls += 1;
                Ok(())
            })
            .unwrap()
    );
    assert_eq!(calls, 1);
    let after_undo = state(&store);
    assert_eq!(store.items()[0].text.as_ref(), None);

    let error = store
        .redo_with_reply_gate(&mut denied())
        .expect_err("reply denial");
    assert_eq!(error.name, "InternalError");
    assert_unchanged(&store, &after_undo);

    let mut calls = 0;
    assert!(
        store
            .redo_with_reply_gate(&mut || {
                calls += 1;
                Ok(())
            })
            .unwrap()
    );
    assert_eq!(calls, 1);
    assert_eq!(store.items()[0].text.as_ref(), Some(&key("edited")));
}

#[test]
fn prepared_cancel_restores_transaction_without_post_gate_allocation() {
    let mut store = DrawingStore::with_defaults(NumberDialect::Ecma);
    let id = store.add(&horizontal("d", 1.0, 2.0)).unwrap();
    store.begin().unwrap();
    store
        .edit(&id, &record(&[("text", JsValue::String(key("tx")))]))
        .unwrap();
    let prepared = store.prepare_cancel().expect("active transaction");
    store.publish_prepared_cancel(prepared);
    assert!(!store.transaction().is_some());
    assert_eq!(store.items()[0].text.as_ref(), None);
}
