use barochart_core::coercion;

use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
use coercion::{js_add_number_with, js_to_number_with};

const FIXTURE: &str =
    include_str!("../../../../test/fixtures/rust-core-vectors/coercion.leaf.jsonl");

fn parse(text: &str) -> JsValue {
    parse_json(text.as_bytes(), JsonMode::Standard).unwrap()
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object: {value:?}")
    };
    value
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    object(value)
        .get(&JsString::from_str(name))
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn optional_field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    object(value).get(&JsString::from_str(name))
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array: {value:?}")
    };
    value
}

fn string(value: &JsValue) -> &JsString {
    let JsValue::String(value) = value else {
        panic!("string: {value:?}")
    };
    value
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number: {value:?}")
    };
    *value
}

fn units(value: &JsValue) -> Vec<u16> {
    array(value)
        .iter()
        .map(|value| number(value) as u16)
        .collect()
}

fn decode(value: &JsValue) -> JsValue {
    match value {
        JsValue::Null | JsValue::Bool(_) => value.clone(),
        JsValue::Object(encoded) if encoded.get(&JsString::from_str("$undefined")).is_some() => {
            JsValue::Undefined
        }
        JsValue::Object(encoded) if encoded.get(&JsString::from_str("$number")).is_some() => {
            let bits =
                string(encoded.get(&JsString::from_str("$number")).unwrap()).to_string_lossy();
            JsValue::Number(f64::from_bits(u64::from_str_radix(&bits, 16).unwrap()))
        }
        JsValue::Object(encoded) if encoded.get(&JsString::from_str("$string")).is_some() => {
            JsValue::String(JsString::from_utf16(units(
                encoded.get(&JsString::from_str("$string")).unwrap(),
            )))
        }
        JsValue::Object(encoded) if encoded.get(&JsString::from_str("$array")).is_some() => {
            JsValue::Array(
                array(encoded.get(&JsString::from_str("$array")).unwrap())
                    .iter()
                    .map(decode)
                    .collect(),
            )
        }
        JsValue::Object(encoded) if encoded.get(&JsString::from_str("$object")).is_some() => {
            let mut output = JsObject::new();
            for entry in array(encoded.get(&JsString::from_str("$object")).unwrap()) {
                let entry = array(entry);
                output.insert(JsString::from_utf16(units(&entry[0])), decode(&entry[1]));
            }
            JsValue::Object(output)
        }
        _ => panic!("encoded value: {value:?}"),
    }
}

fn expected_error_message(_node_message: &str) -> &str {
    #[cfg(target_os = "android")]
    let expected = "toPrimitive";
    #[cfg(all(not(target_os = "android"), target_vendor = "apple"))]
    let expected = "No default value";
    #[cfg(all(not(target_os = "android"), not(target_vendor = "apple")))]
    let expected = _node_message;
    expected
}

#[test]
fn node22_golden_matches_tonumber_and_numeric_left_addition() {
    let rows = FIXTURE.lines().map(parse).collect::<Vec<_>>();
    assert_eq!(rows.len(), 75);
    let metadata = field(&rows[0], "metadata");
    assert_eq!(
        string(field(metadata, "oracleCommit")).to_string_lossy(),
        "87598ca492e6a7273b60b629c0cf9f2456268853"
    );
    assert_eq!(
        string(field(metadata, "bundleSha256")).to_string_lossy(),
        "007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512"
    );
    assert_eq!(number(field(metadata, "seed")), 20_261_104.0);
    assert_eq!(
        string(field(field(metadata, "runtime"), "node")).to_string_lossy(),
        "v22.20.0"
    );
    for row in &rows[1..] {
        let suite = string(field(row, "suite")).to_string_lossy();
        let actual = if suite == "to-number" {
            js_to_number_with(&decode(field(row, "input")), NumberDialect::Ecma)
                .map(JsValue::Number)
        } else {
            js_add_number_with(
                number(&decode(field(row, "left"))),
                &decode(field(row, "right")),
                NumberDialect::Ecma,
            )
        };
        let expected = field(row, "expected");
        if let Some(expected) = optional_field(expected, "value") {
            let actual = actual.unwrap_or_else(|error| panic!("{row:?}: {error:?}"));
            let expected = decode(expected);
            match (&actual, &expected) {
                (JsValue::Number(actual), JsValue::Number(expected)) => {
                    assert_eq!(actual.to_bits(), expected.to_bits(), "{row:?}")
                }
                (JsValue::String(actual), JsValue::String(expected)) => {
                    assert_eq!(actual.as_units(), expected.as_units(), "{row:?}")
                }
                _ => panic!("result kind: {row:?}: {actual:?} != {expected:?}"),
            }
        } else {
            let expected = field(expected, "error");
            let error = actual.unwrap_err();
            assert_eq!(
                error.name,
                string(field(expected, "name")).to_string_lossy(),
                "{row:?}"
            );
            let node_message = string(field(expected, "message")).to_string_lossy();
            assert_eq!(
                error.message.to_string_lossy(),
                expected_error_message(&node_message),
                "{row:?}"
            );
        }
    }
}

#[test]
fn selected_decimal_dialect_changes_only_the_existing_parser_rounding() {
    let value = JsValue::String(JsString::from_str(&format!(
        "9007199254740993.{}1",
        "0".repeat(22)
    )));
    assert_eq!(
        js_to_number_with(&value, NumberDialect::Ecma)
            .unwrap()
            .to_bits(),
        9_007_199_254_740_994.0f64.to_bits()
    );
    assert_eq!(
        js_to_number_with(&value, NumberDialect::QuickJs)
            .unwrap()
            .to_bits(),
        9_007_199_254_740_992.0f64.to_bits()
    );

    let suffix = JsValue::String(JsString::from_str("x"));
    let power = f64::from_bits(0x3e70_0000_0000_0000);
    let ecma_value = js_add_number_with(power, &suffix, NumberDialect::Ecma).unwrap();
    let JsValue::String(ecma) = &ecma_value else {
        panic!("string result")
    };
    let quickjs_value = js_add_number_with(power, &suffix, NumberDialect::QuickJs).unwrap();
    let JsValue::String(quickjs) = &quickjs_value else {
        panic!("string result")
    };
    assert_eq!(ecma.to_string_lossy(), "5.960464477539063e-8x");
    assert_eq!(quickjs.to_string_lossy(), "5.9604644775390625e-8x");
}

#[test]
fn radix_rounding_uses_guard_sticky_and_ties_to_even() {
    for (literal, expected) in [
        (format!("0b1{}1", "0".repeat(52)), 9_007_199_254_740_992.0),
        (format!("0b1{}11", "0".repeat(51)), 9_007_199_254_740_996.0),
        (
            format!("0b1{}101", "0".repeat(51)),
            f64::from_bits(0x4350_0000_0000_0001),
        ),
    ] {
        let actual = js_to_number_with(
            &JsValue::String(JsString::from_str(&literal)),
            NumberDialect::Ecma,
        )
        .unwrap();
        assert_eq!(actual.to_bits(), expected.to_bits(), "{literal}");
    }
}
