use barochart_core::chart_api::ChartApi;
use barochart_core::crosshair_snap::{
    CrosshairCursor, crosshair_snap_options, resolve_crosshair_snapshot,
};
use barochart_core::data::{
    ColumnInputs, ModelDataState, NumericColumn, StoreOptions, seeded_columns,
};
use barochart_core::native_chart::NativeChart;
use barochart_core::readout::crosshair_values_at;
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;
struct NoZones;
impl Host for NoZones {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }
    fn log(&self, _: i32, _: &str) {}
}
fn parse(s: &str) -> JsValue {
    parse_json(s.as_bytes(), JsonMode::Standard).unwrap()
}
fn field<'a>(v: &'a JsValue, k: &str) -> &'a JsValue {
    let JsValue::Object(v) = v else {
        panic!("object")
    };
    v.get(&JsString::from_str(k)).unwrap()
}
fn string_value(v: &JsValue) -> String {
    let JsValue::String(v) = v else {
        panic!("string")
    };
    v.to_string_lossy()
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
fn actual_source_crosshair_readout_matches_bits_axes_gaps_and_offsets() {
    for line in include_str!("../../../../test/fixtures/rust-core-vectors/readout.leaf.jsonl")
        .lines()
        .skip(1)
    {
        let row = parse(line);
        let options = field(&row, "options");
        let mode = field(&row, "mode");
        let mut data = ModelDataState::new(StoreOptions::default(), vec![]).unwrap();
        let c = seeded_columns(8, 42).unwrap();
        data.store_mut()
            .set_columns(
                &ColumnInputs {
                    time: NumericColumn::F64(&c.time),
                    open: NumericColumn::F64(&c.open),
                    high: NumericColumn::F64(&c.high),
                    low: NumericColumn::F64(&c.low),
                    close: NumericColumn::F64(&c.close),
                    volume: NumericColumn::F64(&c.volume),
                },
                Some(8),
            )
            .unwrap();
        let mut chart = NativeChart::new(data, options, NumberDialect::Ecma, &NoZones).unwrap();
        let mut api = ChartApi::new(&mut chart, &NoZones);
        api.dispatch(
            &JsString::from_str("addIndicator"),
            &[parse("\"ema\""), parse("\"ema\""), parse("{\"period\":2}")],
        )
        .unwrap();
        api.dispatch(
            &JsString::from_str("addSeries"),
            &[parse(
                "{\"id\":\"ema-line\",\"type\":\"line\",\"panel\":\"price\",\"indicator\":\"ema\"}",
            )],
        )
        .unwrap();
        api.dispatch(
            &JsString::from_str("setVisibleRange"),
            &[JsValue::Number(-0.5), JsValue::Number(7.5)],
        )
        .unwrap();
        let layout = chart.create_layout(&NoZones, 400.0, 300.0).unwrap();
        let mut snap = JsObject::new();
        snap.insert(JsString::from_str("mode"), mode.clone());
        let options = crosshair_snap_options(chart.model(), &JsValue::Object(snap)).unwrap();
        let cursor = CrosshairCursor {
            x: 100.0,
            y: 120.0,
            request: Some(options),
            identity: 1,
        };
        let resolution =
            resolve_crosshair_snapshot(chart.model(), chart.data().store(), &layout, Some(&cursor));
        let values =
            crosshair_values_at(&mut chart, &NoZones, &layout, resolution.as_ref()).unwrap();
        let snapshot = resolution
            .as_ref()
            .map_or(JsValue::Null, |r| r.to_js_value());
        let summary = barochart_core::readout::accessibility(
            &chart,
            &barochart_core::interaction::OwnedInteractionState::new(),
            values.clone(),
        )
        .unwrap();
        let android =
            barochart_core::readout::accessibility_text(&summary, &parse("\"android\"")).unwrap();
        let uikit =
            barochart_core::readout::accessibility_text(&summary, &parse("\"uikit\"")).unwrap();
        let mut actual = JsObject::new();
        actual.insert(JsString::from_str("snapshot"), snapshot);
        actual.insert(JsString::from_str("values"), values);
        actual.insert(JsString::from_str("accessibility"), summary);
        actual.insert(JsString::from_str("android"), JsValue::String(android));
        actual.insert(JsString::from_str("uikit"), JsValue::String(uikit));
        assert_eq!(
            stringify_json(&JsValue::Object(actual), JsonMode::Lossless),
            stringify_json(&decode_wire(field(&row, "result")), JsonMode::Lossless),
            "{}",
            string_value(mode)
        );
    }
}
