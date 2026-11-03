use barochart_js::json::{JsValue, JsonMode, parse_json_utf16};

use barochart_core::batch_options;

use batch_options::{BatchOptions, snapshot_batch_options};

fn value(text: &str) -> JsValue {
    parse_json_utf16(&text.encode_utf16().collect::<Vec<_>>(), JsonMode::Lossless).unwrap()
}

fn message(result: Result<impl std::fmt::Debug, barochart_js::error::JsError>) -> String {
    result.unwrap_err().message.to_string_lossy()
}

#[test]
fn snapshots_store_limits_and_boolean_without_coercion() {
    let empty = BatchOptions::empty();
    assert!(empty.max_bars.is_none() && empty.max_store_bytes.is_none());
    let options = snapshot_batch_options(
        &value(r#"{"maxBars":16,"maxStoreBytes":1536,"skipUnchanged":true}"#),
        true,
    )
    .unwrap();
    assert_eq!(options.max_bars_number(), Some(16.0));
    assert_eq!(options.max_store_bytes_number(), Some(1536.0));
    assert_eq!(options.skip_unchanged, Some(true));

    let public = snapshot_batch_options(&value(r#"{"skipUnchanged":false}"#), false).unwrap();
    assert_eq!(public.skip_unchanged, Some(false));
    assert!(public.max_bars.is_none());
}

#[test]
fn max_budget_values_remain_raw_until_post_event_budget_validation() {
    let options = snapshot_batch_options(
        &value(r#"{"maxBars":"late-error","maxStoreBytes":null}"#),
        true,
    )
    .unwrap();
    assert!(matches!(options.max_bars, Some(JsValue::String(_))));
    assert!(matches!(options.max_store_bytes, Some(JsValue::Null)));
    assert_eq!(options.max_bars_number(), None);
}

#[test]
fn shape_and_field_errors_match_the_js_snapshot_boundary() {
    for invalid in [
        JsValue::Null,
        JsValue::Array(Vec::new()),
        JsValue::Number(1.0),
    ] {
        assert_eq!(
            message(snapshot_batch_options(&invalid, true)),
            "Data batch options plain data record required"
        );
    }
    assert_eq!(
        message(snapshot_batch_options(&value(r#"{"extra":1}"#), true)),
        "Data batch options unsupported field or accessor data property"
    );
    assert_eq!(
        message(snapshot_batch_options(&value(r#"{"maxBars":16}"#), false)),
        "Data batch options unsupported field or accessor data property"
    );
}

#[test]
fn skip_unchanged_requires_a_boolean_when_present() {
    for text in [
        r#"{"skipUnchanged":null}"#,
        r#"{"skipUnchanged":0}"#,
        r#"{"skipUnchanged":"false"}"#,
    ] {
        assert_eq!(
            message(snapshot_batch_options(&value(text), true)),
            "Data batch skipUnchanged must be boolean"
        );
    }
    assert_eq!(
        snapshot_batch_options(&value("{}"), true)
            .unwrap()
            .skip_unchanged,
        None
    );
}
