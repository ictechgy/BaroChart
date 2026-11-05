use barochart_core::{contracts, drawing_document, drawing_types, drawings};

use std::sync::Arc;

use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use drawing_document::DrawingDocumentContext;
use drawings::{DrawingStore, DrawingStoreConfig};

fn doc(drawing_rows: &str, version: u8) -> JsString {
    JsString::from_str(&format!(
        "{{\"schema\":\"aster.drawings\",\"version\":{version},\"drawings\":[{drawing_rows}]}}"
    ))
}

fn new_store(max_document_chars: usize) -> DrawingStore {
    DrawingStore::new(
        DrawingStoreConfig {
            max_document_chars,
            ..DrawingStoreConfig::default()
        },
        NumberDialect::Ecma,
    )
    .unwrap()
}

fn horizontal(id: &str, tail: &str) -> String {
    format!(
        "{{\"id\":\"{id}\",\"type\":\"horizontal\",\"panel\":\"price\",\"points\":[{{\"time\":1.25,\"price\":-0}}]{tail}}}"
    )
}

#[test]
fn v1_to_v4_load_and_save_use_minimal_version_and_canonical_keys() {
    let rows = [
        horizontal("v1", ""),
        horizontal("v2", ",\"axisId\":\"A\",\"seriesId\":\"S\""),
        "{\"id\":\"v3\",\"type\":\"longposition\",\"panel\":\"price\",\"points\":[{\"time\":1,\"price\":10},{\"time\":1,\"price\":9},{\"time\":1,\"price\":12},{\"time\":2,\"price\":10}]}".to_string(),
        horizontal("v4", ",\"visible\":false"),
    ];
    let versions = [1, 2, 3, 4];
    for (row, version) in rows.iter().zip(versions) {
        let mut store = new_store(8_388_608);
        store
            .load(&doc(row, version), &DrawingDocumentContext::default())
            .unwrap();
        let saved = store.save().unwrap();
        let expected_version = match version {
            1 => 1,
            2 => 2,
            3 => 3,
            4 => 4,
            _ => unreachable!(),
        };
        assert!(
            saved
                .to_string_lossy()
                .contains(&format!("\"version\":{expected_version}"))
        );
        let mut receiver = new_store(8_388_608);
        receiver
            .load(&saved, &DrawingDocumentContext::default())
            .unwrap();
        assert_eq!(receiver.save().unwrap(), saved);
    }

    let mut legacy = new_store(8_388_608);
    legacy
        .load(
            &doc(&horizontal("v4-empty", ""), 4),
            &DrawingDocumentContext::default(),
        )
        .unwrap();
    assert_eq!(
        legacy.save().unwrap(),
        JsString::from_str(
            "{\"schema\":\"aster.drawings\",\"version\":1,\"drawings\":[{\"id\":\"v4-empty\",\"panel\":\"price\",\"type\":\"horizontal\",\"points\":[{\"time\":1.25,\"price\":0}]}]}"
        )
    );
}

#[test]
fn documents_reject_downgrades_duplicates_depth_and_unknown_fields_atomically() {
    let long_position = "{\"id\":\"p\",\"type\":\"longposition\",\"panel\":\"price\",\"points\":[{\"time\":1,\"price\":10},{\"time\":1,\"price\":9},{\"time\":1,\"price\":12},{\"time\":2,\"price\":10}]}";
    let mut store = new_store(8_388_608);
    let id = store
        .add(
            &barochart_core::drawing_validation::validate_drawing(&parse_row(&horizontal(
                "kept", "",
            )))
            .unwrap()
            .to_value(),
        )
        .unwrap();
    store.select(Some(&id)).unwrap();
    let before = store.snapshot();
    let history = store.undo_stack().to_vec();
    let serial = store.serial();
    let downgraded = doc(long_position, 2);
    assert_eq!(
        store
            .load(&downgraded, &DrawingDocumentContext::default())
            .unwrap_err()
            .message,
        JsString::from_str("Position drawings require document version 3")
    );
    assert_eq!(
        store
            .load(
                &doc(
                    &format!("{},{}", horizontal("dup", ""), horizontal("dup", "")),
                    1
                ),
                &DrawingDocumentContext::default()
            )
            .unwrap_err()
            .message,
        JsString::from_str("Duplicate drawing ids")
    );
    assert_eq!(
        store.load(&JsString::from_str("{\"schema\":\"aster.drawings\",\"version\":1,\"drawings\":[{\"id\":\"d\",\"panel\":\"price\",\"type\":\"horizontal\",\"points\":[{\"time\":1,\"price\":1}],\"zeta\":1,\"alpha\":2}]}"), &DrawingDocumentContext::default()).unwrap_err().message,
        JsString::from_str("Drawing: unsupported field alpha")
    );
    let depth = format!(
        "{{\"schema\":\"aster.drawings\",\"version\":1,\"drawings\":[{}]}}",
        "[".repeat(33) + &"]".repeat(33)
    );
    assert_eq!(
        store
            .load(
                &JsString::from_str(&depth),
                &DrawingDocumentContext::default()
            )
            .unwrap_err()
            .message,
        JsString::from_str("Drawing document depth limit")
    );
    assert!(
        before
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert_eq!(store.undo_stack().len(), history.len());
    assert_eq!(store.serial(), serial);
    assert_eq!(store.selected(), Some(&id));
}

#[test]
fn utf16_document_budget_and_lone_surrogates_roundtrip_without_utf8_length_confusion() {
    let text = "{\"schema\":\"aster.drawings\",\"version\":1,\"drawings\":[{\"id\":\"s\",\"panel\":\"price\",\"type\":\"text\",\"points\":[{\"time\":1,\"price\":2}],\"text\":\"😀\\ud800\"}]}";
    let mut full = new_store(8_388_608);
    full.load(
        &JsString::from_str(text),
        &DrawingDocumentContext::default(),
    )
    .unwrap();
    let saved = full.save().unwrap();
    let char_count = saved.len_utf16();
    assert!(saved.to_string_lossy().len() > char_count);
    assert_eq!(full.items()[0].text.as_ref().unwrap().len_utf16(), 3);

    let mut exact = new_store(char_count);
    exact
        .load(
            &JsString::from_str(text),
            &DrawingDocumentContext::default(),
        )
        .unwrap();
    assert_eq!(exact.save().unwrap(), saved);
    let mut too_small = new_store(char_count - 1);
    let err = too_small
        .load(
            &JsString::from_str(text),
            &DrawingDocumentContext::default(),
        )
        .unwrap_err();
    assert_eq!(err.name, "TypeError");
    assert_eq!(
        err.message,
        JsString::from_str(&format!(
            "Drawing document: string limit {}",
            char_count - 1
        ))
    );
    assert!(too_small.items().is_empty());
}

#[test]
fn binding_panel_style_callbacks_run_in_contract_order_and_fail_without_publish() {
    let row = horizontal(
        "bound",
        ",\"axisId\":\"A\",\"seriesId\":\"S\",\"style\":{\"color\":\"red\"}",
    );
    let mut store = new_store(8_388_608);
    let order = std::cell::RefCell::new(Vec::new());
    let binding = |_: &drawing_types::Drawing| {
        order.borrow_mut().push("binding");
        Ok(true)
    };
    let panel = |_: &JsString| {
        order.borrow_mut().push("panel");
        Ok(true)
    };
    let decoder = |style: &barochart_js::json::JsValue| {
        order.borrow_mut().push("style");
        Ok(style.clone())
    };
    let context = DrawingDocumentContext {
        validate_binding: Some(&binding),
        validate_panel: Some(&panel),
        style_decoder: Some(&decoder),
    };
    store.load(&doc(&row, 2), &context).unwrap();
    assert_eq!(*order.borrow(), vec!["binding", "panel", "style"]);
    assert_eq!(store.items()[0].axis_id, Some(JsString::from_str("A")));

    let original = store.snapshot();
    let reject_binding = |_: &drawing_types::Drawing| Ok(false);
    let reject = DrawingDocumentContext {
        validate_binding: Some(&reject_binding),
        ..DrawingDocumentContext::default()
    };
    assert_eq!(
        store.load(&doc(&row, 2), &reject).unwrap_err().message,
        JsString::from_str("Invalid drawing binding")
    );
    assert!(
        original
            .iter()
            .zip(store.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
}

#[test]
fn style_decoder_expansion_is_charged_to_the_canonical_output_budget() {
    let input = doc(
        "{\"id\":\"color\",\"type\":\"horizontal\",\"panel\":\"price\",\"points\":[{\"time\":1.25,\"price\":-0}],\"style\":{\"color\":\"red\"}}",
        1,
    );
    let decode = |style: &barochart_js::json::JsValue| {
        contracts::portable_style(style, &["color", "fill"], true)
    };
    let context = DrawingDocumentContext {
        style_decoder: Some(&decode),
        ..DrawingDocumentContext::default()
    };
    let mut reference = new_store(8_388_608);
    reference.load(&input, &context).unwrap();
    let canonical = reference.save().unwrap();
    assert!(canonical.len_utf16() > input.len_utf16());
    assert_eq!(
        canonical,
        JsString::from_str(
            "{\"schema\":\"aster.drawings\",\"version\":1,\"drawings\":[{\"id\":\"color\",\"panel\":\"price\",\"style\":{\"color\":\"#ff0000ff\"},\"type\":\"horizontal\",\"points\":[{\"time\":1.25,\"price\":0}]}]}"
        )
    );

    let mut exact = new_store(canonical.len_utf16());
    exact.load(&input, &context).unwrap();
    assert_eq!(exact.save().unwrap(), canonical);

    let mut too_small = new_store(input.len_utf16());
    let error = too_small.load(&input, &context).unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(
        error.message,
        JsString::from_str(&format!(
            "Drawing document: string limit {}",
            input.len_utf16()
        ))
    );
    assert!(too_small.items().is_empty());
}

#[test]
fn transaction_error_precedes_canonical_size_and_load_undoes_as_one_identity_snapshot() {
    let source = new_store(8_388_608);
    let saved = source.save().unwrap();
    let mut receiver = new_store(saved.len_utf16());
    receiver.add(&parse_row(&horizontal("old", ""))).unwrap();
    receiver.begin().unwrap();
    receiver
        .add(&parse_row(&horizontal("pending", "")))
        .unwrap();
    let before = receiver.snapshot();
    let error = receiver
        .load(&saved, &DrawingDocumentContext::default())
        .unwrap_err();
    assert_eq!(
        error.message,
        JsString::from_str("Cannot load during a gesture")
    );
    assert!(
        before
            .iter()
            .zip(receiver.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    receiver.cancel();

    let before = receiver.snapshot();
    let history_len = receiver.undo_stack().len();
    receiver
        .load(&saved, &DrawingDocumentContext::default())
        .unwrap();
    assert_eq!(receiver.undo_stack().len(), history_len + 1);
    assert!(receiver.undo().unwrap());
    assert!(
        before
            .iter()
            .zip(receiver.items())
            .all(|(a, b)| Arc::ptr_eq(a, b))
    );
    assert!(receiver.redo().unwrap());
    assert_eq!(receiver.save().unwrap(), saved);
}

fn parse_row(row: &str) -> barochart_js::json::JsValue {
    barochart_js::json::parse_json(row.as_bytes(), barochart_js::json::JsonMode::Standard).unwrap()
}
