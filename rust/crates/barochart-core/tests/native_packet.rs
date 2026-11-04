use barochart_core::native_packet::{
    NativePacketOptions, pack_native_commands, pack_native_commands_with_memory,
};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
static UNDEFINED: JsValue = JsValue::Undefined;
fn field<'a>(v: &'a JsValue, k: &str) -> &'a JsValue {
    let JsValue::Object(o) = v else {
        panic!("object")
    };
    o.get(&JsString::from_str(k)).unwrap_or(&UNDEFINED)
}
fn string_value(v: &JsValue) -> String {
    let JsValue::String(s) = v else {
        panic!("string")
    };
    s.to_string_lossy()
}
fn decode_wire(value: &JsValue) -> JsValue {
    let JsValue::Object(encoded) = value else {
        return match value {
            JsValue::Array(values) => JsValue::Array(values.iter().map(decode_wire).collect()),
            _ => value.clone(),
        };
    };
    if encoded.len() == 1 {
        if let Some(JsValue::String(bits)) = encoded.get(&JsString::from_str("$f64")) {
            return JsValue::Number(f64::from_bits(
                u64::from_str_radix(&bits.to_string_lossy(), 16).unwrap(),
            ));
        }
        if encoded.get(&JsString::from_str("$undefined")).is_some() {
            return JsValue::Undefined;
        }
        if let Some(JsValue::Object(_)) = encoded.get(&JsString::from_str("$object")) {
            panic!("object entries must be an array")
        }
        if let Some(JsValue::Array(entries)) = encoded.get(&JsString::from_str("$object")) {
            let mut result = JsObject::new();
            for entry in entries {
                let JsValue::Array(entry) = entry else {
                    panic!("entry")
                };
                let JsValue::String(key) = &entry[0] else {
                    panic!("key")
                };
                result.insert(key.clone(), decode_wire(&entry[1]));
            }
            return JsValue::Object(result);
        }
    }
    let mut result = JsObject::new();
    for (key, child) in encoded.iter() {
        result.insert(key.clone(), decode_wire(child));
    }
    JsValue::Object(result)
}

#[test]
fn source_packet_fixture_preserves_metadata_bytes_f64_bits_and_first_error_order() {
    for line in include_str!("../../../../test/fixtures/rust-core-vectors/native-packet.leaf.jsonl")
        .lines()
        .skip(1)
    {
        let row = parse_json(line.as_bytes(), JsonMode::Standard).unwrap();
        let layers = decode_wire(field(&row, "layers"));
        let options = decode_wire(field(&row, "options"));
        let JsValue::Array(layers) = &layers else {
            panic!("layers")
        };
        let layers = layers
            .iter()
            .map(|layer| {
                if matches!(layer, JsValue::Null) {
                    None
                } else {
                    Some(layer)
                }
            })
            .collect::<Vec<_>>();
        let actual = pack_native_commands(
            &layers,
            NativePacketOptions {
                mode: field(&options, "mode"),
                width: field(&options, "width"),
                height: field(&options, "height"),
                background: field(&options, "background"),
                stats: field(&options, "stats"),
            },
            NumberDialect::Ecma,
        );
        let id = string_value(field(&row, "id"));
        if !matches!(field(&row, "error"), JsValue::Undefined) {
            let error = actual
                .err()
                .unwrap_or_else(|| panic!("expected error {id}"));
            assert_eq!(
                error.name,
                string_value(field(field(&row, "error"), "name")),
                "{id}"
            );
            assert_eq!(
                error.message.to_string_lossy(),
                string_value(field(field(&row, "error"), "message")),
                "{id}"
            );
        } else {
            let actual = actual.unwrap_or_else(|e| panic!("{id}: {e:?}"));
            assert_eq!(
                actual.metadata.to_string_lossy(),
                string_value(field(&row, "metadata")),
                "{id}"
            );
            let JsValue::Array(expected) = field(&row, "numbers") else {
                panic!("numbers")
            };
            assert_eq!(
                actual
                    .numbers
                    .iter()
                    .map(|v| format!("{:016x}", v.to_bits()))
                    .collect::<Vec<_>>(),
                expected.iter().map(string_value).collect::<Vec<_>>(),
                "{id}"
            );
        }
    }
}

fn one_line_layer() -> JsValue {
    let mut command = JsObject::new();
    command.insert(
        JsString::from_str("op"),
        JsValue::String(JsString::from_str("lines")),
    );
    command.insert(
        JsString::from_str("coords"),
        JsValue::Array(
            [1.0, 2.0, 3.0, 4.0]
                .into_iter()
                .map(JsValue::Number)
                .collect(),
        ),
    );
    command.insert(
        JsString::from_str("color"),
        JsValue::String(JsString::from_str("#123456")),
    );
    let mut layer = JsObject::new();
    layer.insert(
        JsString::from_str("commands"),
        JsValue::Array(vec![JsValue::Object(command)]),
    );
    JsValue::Object(layer)
}

fn packet_options<'a>(mode: &'a JsValue, background: &'a JsValue) -> NativePacketOptions<'a> {
    static WIDTH: JsValue = JsValue::Number(320.0);
    static HEIGHT: JsValue = JsValue::Number(180.0);
    NativePacketOptions {
        mode,
        width: &WIDTH,
        height: &HEIGHT,
        background,
        stats: background,
    }
}

#[test]
fn accounted_packet_owns_exact_payload_until_drop() {
    let layer = one_line_layer();
    let mode = JsValue::String(JsString::from_str("scene"));
    let background = JsValue::String(JsString::from_str("#000000"));
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let packet = pack_native_commands_with_memory(
        &[Some(&layer)],
        packet_options(&mode, &background),
        NumberDialect::Ecma,
        &context,
    )
    .unwrap();

    let expected = packet.metadata.len_utf16() * std::mem::size_of::<u16>()
        + packet.numbers.capacity() * std::mem::size_of::<f64>();
    assert_eq!(packet.requested_bytes(), expected as u64);
    assert_eq!(account.snapshot().requested_live_bytes, expected as u64);
    drop(packet);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn packet_quota_failure_has_host_oom_class_and_leaves_no_artifact() {
    let layer = one_line_layer();
    let mode = JsValue::String(JsString::from_str("scene"));
    let background = JsValue::String(JsString::from_str("#000000"));
    let account = MemoryAccount::new(8, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let error = match pack_native_commands_with_memory(
        &[Some(&layer)],
        packet_options(&mode, &background),
        NumberDialect::Ecma,
        &context,
    ) {
        Ok(_) => panic!("packet must not escape a denied account"),
        Err(error) => error,
    };

    assert_eq!(error.name, "InternalError");
    assert_eq!(error.message.to_string_lossy(), "out of memory");
    assert_eq!(account.snapshot().requested_live_bytes, 0);
    assert_eq!(account.snapshot().retained_output_bytes, 0);
}
