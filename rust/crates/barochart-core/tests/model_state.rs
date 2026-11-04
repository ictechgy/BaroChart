use barochart_core::model_state;

use barochart_core::data::{Bar, ModelDataState, StoreOptions};
use barochart_core::indicator_params::validate_indicator_params;
use barochart_core::indicator_types::{
    IndicatorDefinition, IndicatorProgram, IndicatorProvenance, PlotOffset,
};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::string::JsString;
use model_state::{
    DrawingUsage, IndicatorProjection, InteractionGuard, ModelContext, ModelState, PlacementReceipt,
};

const FIXTURE: &str = include_str!("../../../../test/fixtures/rust-model/model-oracle.jsonl");
const SMA_OUTPUTS: [&str; 1] = ["value"];
const ICHIMOKU_OUTPUTS: [&str; 5] = ["tenkan", "kijun", "spanA", "spanB", "chikou"];

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
}

fn fixture_rows() -> Vec<JsValue> {
    FIXTURE.lines().map(parse).collect()
}

fn object(value: &JsValue) -> &JsObject {
    let JsValue::Object(value) = value else {
        panic!("object required: {value:?}")
    };
    value
}

fn get<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    object(value)
        .get(&JsString::from_str(key))
        .unwrap_or_else(|| panic!("missing {key}: {value:?}"))
}

fn array(value: &JsValue) -> &[JsValue] {
    let JsValue::Array(value) = value else {
        panic!("array required: {value:?}")
    };
    value
}

fn text(value: &JsValue) -> String {
    let JsValue::String(value) = value else {
        panic!("string required: {value:?}")
    };
    value.to_string_lossy()
}

fn number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required: {value:?}")
    };
    *value
}

fn f64_hex(value: f64) -> String {
    let bits = if value.is_nan() {
        f64::NAN.to_bits()
    } else {
        value.to_bits()
    };
    format!("{bits:016x}")
}

fn from_hex(value: &JsValue) -> f64 {
    f64::from_bits(u64::from_str_radix(&text(value), 16).unwrap())
}

fn tagged(key: &str, value: JsValue) -> JsValue {
    object_value([(key, value)])
}

fn decode_wire(value: &JsValue) -> JsValue {
    let JsValue::Object(encoded) = value else {
        return match value {
            JsValue::Array(values) => JsValue::Array(values.iter().map(decode_wire).collect()),
            _ => value.clone(),
        };
    };
    if encoded.len() == 1 {
        if let Some(bits) = encoded.get(&JsString::from_str("$f64")) {
            return JsValue::Number(from_hex(bits));
        }
        if encoded.get(&JsString::from_str("$undefined")).is_some() {
            return JsValue::Undefined;
        }
        if let Some(values) = encoded.get(&JsString::from_str("$f64array")) {
            return JsValue::Array(
                array(values)
                    .iter()
                    .map(|value| JsValue::Number(from_hex(value)))
                    .collect(),
            );
        }
        if let Some(entries) = encoded.get(&JsString::from_str("$object")) {
            let mut output = JsObject::new();
            for entry in array(entries) {
                let entry = array(entry);
                output.insert(JsString::from_str(&text(&entry[0])), decode_wire(&entry[1]));
            }
            return JsValue::Object(output);
        }
    }
    let mut output = JsObject::new();
    for (key, child) in encoded.iter() {
        output.insert(key.clone(), decode_wire(child));
    }
    JsValue::Object(output)
}

fn encode_wire(value: &JsValue) -> JsValue {
    match value {
        JsValue::Number(value) => tagged(
            "$f64",
            JsValue::String(JsString::from_str(&f64_hex(*value))),
        ),
        JsValue::Undefined => tagged("$undefined", JsValue::Bool(true)),
        JsValue::Array(values) => JsValue::Array(values.iter().map(encode_wire).collect()),
        JsValue::Object(value) => tagged(
            "$object",
            JsValue::Array(
                value
                    .iter()
                    .map(|(key, child)| {
                        JsValue::Array(vec![JsValue::String(key.clone()), encode_wire(child)])
                    })
                    .collect(),
            ),
        ),
        _ => value.clone(),
    }
}

fn json(value: &JsValue) -> String {
    String::from_utf8(stringify_json(value, JsonMode::Standard)).unwrap()
}

fn assert_wire(actual: &JsValue, expected: &JsValue, context: &str) {
    assert_eq!(json(&encode_wire(actual)), json(expected), "{context}");
}

fn object_value<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(JsString::from_str(key), value);
    }
    JsValue::Object(object)
}

fn view_value(model: &ModelState) -> JsValue {
    object_value([
        ("from", JsValue::Number(model.view.from)),
        ("to", JsValue::Number(model.view.to)),
    ])
}

fn receipt_value(receipt: PlacementReceipt) -> JsValue {
    object_value([
        ("changed", JsValue::Number(receipt.changed as f64)),
        ("panel", JsValue::String(receipt.panel)),
        (
            "axisId",
            receipt.axis_id.map_or(JsValue::Null, JsValue::String),
        ),
        (
            "boundIds",
            JsValue::Array(receipt.bound_ids.into_iter().map(JsValue::String).collect()),
        ),
    ])
}

fn success(value: JsValue) -> JsValue {
    object_value([("ok", value)])
}

fn failure(error: JsError) -> JsValue {
    object_value([(
        "error",
        object_value([
            ("name", JsValue::String(JsString::from_str(error.name))),
            ("message", JsValue::String(error.message)),
        ]),
    )])
}

fn capture(result: Result<JsValue, JsError>) -> JsValue {
    match result {
        Ok(value) => success(value),
        Err(error) => failure(error),
    }
}

fn empty_data() -> ModelDataState {
    ModelDataState::new(StoreOptions::default(), Vec::new()).unwrap()
}

fn sma_definition() -> IndicatorDefinition {
    IndicatorDefinition::new(
        IndicatorProgram::Sma,
        validate_indicator_params(&parse(r#"{"period":2}"#)).unwrap(),
        &SMA_OUTPUTS,
        Vec::new(),
        IndicatorProvenance::Builtin,
    )
    .unwrap()
}

fn ichimoku_definition() -> IndicatorDefinition {
    IndicatorDefinition::new(
        IndicatorProgram::Ichimoku,
        validate_indicator_params(&parse(
            r#"{"conversion":2,"base":3,"span":4,"displacement":5}"#,
        ))
        .unwrap(),
        &ICHIMOKU_OUTPUTS,
        vec![
            PlotOffset {
                output: "spanA",
                value: 5.0,
            },
            PlotOffset {
                output: "spanB",
                value: 5.0,
            },
            PlotOffset {
                output: "chikou",
                value: -5.0,
            },
        ],
        IndicatorProvenance::Builtin,
    )
    .unwrap()
}

fn bar_from_value(value: &JsValue) -> Bar {
    Bar {
        time: number(get(value, "time")),
        open: number(get(value, "open")),
        high: number(get(value, "high")),
        low: number(get(value, "low")),
        close: number(get(value, "close")),
        volume: number(get(value, "volume")),
    }
}

fn bar_value(bar: Bar) -> JsValue {
    object_value([
        ("time", JsValue::Number(bar.time)),
        ("open", JsValue::Number(bar.open)),
        ("high", JsValue::Number(bar.high)),
        ("low", JsValue::Number(bar.low)),
        ("close", JsValue::Number(bar.close)),
        ("volume", JsValue::Number(bar.volume)),
    ])
}

fn generated_bar(time: f64) -> Bar {
    let close = time + 10.0;
    Bar {
        time,
        open: close - 1.0,
        high: close + 2.0,
        low: close - 2.0,
        close,
        volume: time.abs() + 1.0,
    }
}

#[test]
fn fixture_metadata_names_current_actual_sources_and_complete_case_counts() {
    let rows = fixture_rows();
    let header = &rows[0];
    assert_eq!(
        text(get(header, "schema")),
        "barochart.rust-model.model-oracle"
    );
    assert_eq!(number(get(header, "version")), 1.0);
    assert_eq!(
        text(get(header, "workspaceBase")),
        "cd68770fd736c5bf80793c3e4a46e36724cb12fe"
    );
    assert_eq!(text(get(header, "node")), "v22.20.0");
    assert_eq!(
        text(get(header, "modelSHA256")),
        "64bb1a0a042841a9386a6f8f500c0e5f96a952d4a09602f91e2f3ef333f356ad"
    );
    let counts = object(get(header, "caseCounts"));
    for (kind, expected) in [
        ("record", 2),
        ("validation", 44),
        ("guard", 8),
        ("view", 1),
        ("store", 1),
    ] {
        assert_eq!(
            rows.iter()
                .skip(1)
                .filter(|row| text(get(row, "kind")) == kind)
                .count(),
            expected,
            "{kind} rows"
        );
        assert_eq!(
            number(counts.get(&JsString::from_str(kind)).unwrap()) as usize,
            expected,
            "{kind} metadata"
        );
    }
}

#[test]
fn actual_js_record_oracle_matches_defaults_order_offsets_and_placement() {
    for row in fixture_rows()
        .into_iter()
        .filter(|row| text(get(row, "kind")) == "record")
    {
        let id = text(get(&row, "id"));
        let data = empty_data();
        let store = data.store();
        let actual = if id == "defaults" {
            let model = ModelState::new(store, &JsValue::Undefined).unwrap();
            object_value([
                ("snapshot", model.snapshot()),
                ("forwardOffset", JsValue::Number(model.forward_offset())),
            ])
        } else {
            let options = parse(
                r##"{"theme":{"font":"13px serif","background":"#ffffff"},"panels":[{"padding":0.2,"id":"price","weight":3},{"id":"lower"}]}"##,
            );
            let mut model = ModelState::new(store, &options).unwrap();
            let plain = ModelContext::plain(store);
            let axis = model
                .add_axis(
                    &parse(r#"{"panel":"lower","id":"lower-axis","side":"left"}"#),
                    &plain,
                )
                .unwrap();
            let definition = ichimoku_definition();
            let indicator_id = JsString::from_str("ichi");
            let projections = [IndicatorProjection {
                id: &indicator_id,
                definition: &definition,
            }];
            let context = ModelContext {
                store,
                indicators: &projections,
                drawings: DrawingUsage::default(),
                interaction: InteractionGuard::default(),
            };
            let indicator = model
                .add_series(
                    &parse(
                        r#"{"panel":"price","indicator":"ichi","output":"spanA","type":"line","id":"ichi-line"}"#,
                    ),
                    &context,
                )
                .unwrap();
            let line = model
                .add_series(
                    &parse(
                        r#"{"source":"close","offset":-0,"panel":"price","type":"line","id":"line"}"#,
                    ),
                    &context,
                )
                .unwrap();
            let placement = model
                .set_indicator_placement(
                    &parse(r#""ichi""#),
                    &parse(r#"{"panel":"lower","axisId":"lower-axis"}"#),
                    &context,
                )
                .unwrap();
            object_value([
                ("axis", JsValue::String(axis)),
                ("indicator", JsValue::String(indicator)),
                ("line", JsValue::String(line)),
                ("placement", receipt_value(placement)),
                ("forwardOffset", JsValue::Number(model.forward_offset())),
                ("snapshot", model.snapshot()),
            ])
        };
        assert_wire(&actual, get(&row, "expected"), &format!("record {id}"));
    }
}

fn invoke_validation(
    model: &mut ModelState,
    operation: &str,
    input: &JsValue,
    context: &ModelContext<'_>,
) -> Result<JsValue, JsError> {
    match operation {
        "addPanel" => model.add_panel(input, context).map(JsValue::String),
        "addAxis" => model.add_axis(input, context).map(JsValue::String),
        "addSeries" => model.add_series(input, context).map(JsValue::String),
        "setPanelOrder" => model.set_panel_order(input, context).map(JsValue::Bool),
        "placement" => model
            .set_indicator_placement(&parse(r#""study""#), input, context)
            .map(receipt_value),
        "setPanel" => model
            .set_panel(get(input, "id"), get(input, "patch"), context)
            .map(|()| JsValue::Undefined),
        "setAxis" => model
            .set_axis(get(input, "id"), get(input, "patch"), context)
            .map(|()| JsValue::Undefined),
        "removePanel" => model
            .remove_panel(input, context)
            .map(|_| JsValue::Undefined),
        "removeAxis" => model
            .remove_axis(input, context)
            .map(|_| JsValue::Undefined),
        "validateDrawingBinding" => model
            .validate_drawing_binding(input, false)
            .map(JsValue::Bool),
        _ => panic!("unknown validation operation {operation}"),
    }
}

#[test]
fn actual_js_validation_oracle_matches_first_errors_and_atomic_state() {
    let definition = sma_definition();
    let indicator_id = JsString::from_str("study");
    let projections = [IndicatorProjection {
        id: &indicator_id,
        definition: &definition,
    }];
    for row in fixture_rows()
        .into_iter()
        .filter(|row| text(get(row, "kind")) == "validation")
    {
        let id = text(get(&row, "id"));
        let operation = text(get(&row, "operation"));
        let setup = text(get(&row, "setup"));
        let input = decode_wire(get(&row, "input"));
        let data = empty_data();
        let store = data.store();
        let mut model = ModelState::new(store, &JsValue::Undefined).unwrap();
        if matches!(
            setup.as_str(),
            "panels" | "panel-series" | "panel-axis" | "axis-series" | "binding-series"
        ) {
            model
                .add_panel(&parse(r#"{"id":"lower"}"#), &ModelContext::plain(store))
                .unwrap();
        }
        let indicators = if matches!(setup.as_str(), "indicator" | "bound") {
            &projections[..]
        } else {
            &[]
        };
        let context = ModelContext {
            store,
            indicators,
            drawings: DrawingUsage::default(),
            interaction: InteractionGuard::default(),
        };
        if setup == "panel-series" {
            model
                .add_series(
                    &parse(r#"{"id":"line","type":"line","panel":"lower","source":"close"}"#),
                    &context,
                )
                .unwrap();
        }
        if setup == "panel-axis" {
            model
                .add_axis(&parse(r#"{"id":"axis","panel":"lower"}"#), &context)
                .unwrap();
        }
        if setup == "axis-series" {
            model
                .add_axis(&parse(r#"{"id":"axis","panel":"lower"}"#), &context)
                .unwrap();
            model
                .add_series(
                    &parse(
                        r#"{"id":"line","type":"line","panel":"lower","axisId":"axis","source":"close"}"#,
                    ),
                    &context,
                )
                .unwrap();
        }
        if setup == "binding-series" {
            model
                .add_series(
                    &parse(r#"{"id":"line","type":"line","panel":"price","source":"close"}"#),
                    &context,
                )
                .unwrap();
        }
        if setup == "bound" {
            model
                .add_series(
                    &parse(
                        r#"{"id":"study-line","type":"line","panel":"price","indicator":"study"}"#,
                    ),
                    &context,
                )
                .unwrap();
        }
        let before = model.snapshot();
        let result = capture(invoke_validation(&mut model, &operation, &input, &context));
        let after = model.snapshot();
        let actual = object_value([("before", before), ("result", result), ("after", after)]);
        assert_wire(&actual, get(&row, "expected"), &format!("validation {id}"));
    }
}

#[test]
fn actual_js_guard_oracle_matches_atomic_projection_and_interaction_rules() {
    let definition = sma_definition();
    let indicator_id = JsString::from_str("study");
    let projections = [IndicatorProjection {
        id: &indicator_id,
        definition: &definition,
    }];
    for row in fixture_rows()
        .into_iter()
        .filter(|row| text(get(row, "kind")) == "guard")
    {
        let id = text(get(&row, "id"));
        let data = empty_data();
        let store = data.store();
        let mut model = ModelState::new(store, &JsValue::Undefined).unwrap();
        if matches!(
            id.as_str(),
            "set-panel-transaction"
                | "panel-order-gesture"
                | "axis-layout-transaction"
                | "remove-axis-gesture"
                | "placement-gesture"
                | "placement-transaction"
                | "placement-success"
        ) {
            model
                .add_panel(&parse(r#"{"id":"lower"}"#), &ModelContext::plain(store))
                .unwrap();
        }
        if matches!(id.as_str(), "remove-axis-gesture" | "placement-success") {
            model
                .add_axis(
                    &parse(r#"{"id":"lower-axis","panel":"lower","side":"left"}"#),
                    &ModelContext::plain(store),
                )
                .unwrap();
        }
        let bound = matches!(
            id.as_str(),
            "placement-gesture" | "placement-transaction" | "placement-success"
        );
        let base_context = ModelContext {
            store,
            indicators: if bound { &projections } else { &[] },
            drawings: DrawingUsage::default(),
            interaction: InteractionGuard::default(),
        };
        if bound {
            model
                .add_series(
                    &parse(
                        r#"{"id":"study-line","type":"line","panel":"price","indicator":"study"}"#,
                    ),
                    &base_context,
                )
                .unwrap();
        }
        let drawing_panels = [JsString::from_str("lower")];
        let context = ModelContext {
            drawings: DrawingUsage {
                transaction_active: matches!(
                    id.as_str(),
                    "add-panel-transaction"
                        | "set-panel-transaction"
                        | "axis-layout-transaction"
                        | "placement-transaction"
                ),
                panels: if id == "set-panel-transaction" {
                    &drawing_panels
                } else {
                    &[]
                },
                ..DrawingUsage::default()
            },
            interaction: InteractionGuard {
                gesture_active: matches!(
                    id.as_str(),
                    "panel-order-gesture" | "remove-axis-gesture" | "placement-gesture"
                ),
                pointer_count: 0,
            },
            ..base_context
        };
        let before = model.snapshot();
        let result = capture(match id.as_str() {
            "add-panel-transaction" => model
                .add_panel(&parse(r#"{"id":"extra"}"#), &context)
                .map(JsValue::String),
            "set-panel-transaction" => model
                .set_panel(&parse(r#""lower""#), &parse(r#"{"scale":"log"}"#), &context)
                .map(|()| JsValue::Undefined),
            "panel-order-gesture" => model
                .set_panel_order(&parse(r#"["lower","price"]"#), &context)
                .map(JsValue::Bool),
            "axis-layout-transaction" => model
                .add_axis(
                    &parse(r#"{"id":"axis","panel":"lower","side":"left"}"#),
                    &context,
                )
                .map(JsValue::String),
            "remove-axis-gesture" => model
                .remove_axis(&parse(r#""lower-axis""#), &context)
                .map(|_| JsValue::Undefined),
            "placement-gesture" => model
                .set_indicator_placement(
                    &parse(r#""study""#),
                    &parse(r#"{"panel":"lower"}"#),
                    &context,
                )
                .map(receipt_value),
            "placement-transaction" => model
                .set_indicator_placement(
                    &parse(r#""study""#),
                    &parse(r#"{"panel":"lower"}"#),
                    &context,
                )
                .map(receipt_value),
            "placement-success" => model
                .set_indicator_placement(
                    &parse(r#""study""#),
                    &parse(r#"{"panel":"lower","axisId":"lower-axis"}"#),
                    &context,
                )
                .map(receipt_value),
            _ => panic!("unknown guard {id}"),
        });
        let after = model.snapshot();
        let actual = object_value([("before", before), ("result", result), ("after", after)]);
        assert_wire(&actual, get(&row, "expected"), &format!("guard {id}"));
    }
}

fn run_view_operation(
    model: &mut ModelState,
    store: &barochart_core::data::BarStore,
    operation: &JsValue,
) -> Result<JsValue, JsError> {
    match text(get(operation, "op")).as_str() {
        "set" => model
            .set_visible_range(store, get(operation, "from"), get(operation, "to"))
            .map(|()| JsValue::Undefined),
        "zoom" => model
            .zoom(
                store,
                get(operation, "factor"),
                Some(get(operation, "anchor")),
            )
            .map(|()| JsValue::Undefined),
        "pan" => model
            .pan(store, get(operation, "delta"))
            .map(|()| JsValue::Undefined),
        "fit" => {
            model.fit(store);
            Ok(JsValue::Undefined)
        }
        operation => panic!("unknown view operation {operation}"),
    }
}

#[test]
fn actual_js_view_oracle_matches_f64_bits_coercion_errors_and_atomicity() {
    let row = fixture_rows()
        .into_iter()
        .find(|row| text(get(row, "kind")) == "view")
        .unwrap();
    let bars_value = decode_wire(get(&row, "bars"));
    let bars: Vec<Bar> = array(&bars_value).iter().map(bar_from_value).collect();
    let data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
    let store = data.store();
    let mut model = ModelState::new(store, &parse(r#"{"visibleBars":12}"#)).unwrap();
    model
        .add_series(
            &parse(r#"{"id":"future","type":"line","panel":"price","source":"close","offset":3}"#),
            &ModelContext::plain(store),
        )
        .unwrap();
    let expected = decode_wire(get(&row, "expected"));
    let initial = object_value([
        ("view", view_value(&model)),
        ("follow", JsValue::Bool(model.follow)),
        ("forwardOffset", JsValue::Number(model.forward_offset())),
    ]);
    let mut frames = Vec::new();
    for expected_frame in array(get(&expected, "frames")) {
        let operation = get(expected_frame, "operation").clone();
        let result = capture(run_view_operation(&mut model, store, &operation));
        frames.push(object_value([
            ("operation", operation),
            ("result", result),
            ("view", view_value(&model)),
            ("follow", JsValue::Bool(model.follow)),
        ]));
    }
    let actual = object_value([("initial", initial), ("frames", JsValue::Array(frames))]);
    assert_wire(
        &actual,
        get(&row, "expected"),
        "deterministic view state machine",
    );
}

fn store_frame(operation: &str, result: JsValue, model: &ModelState) -> JsValue {
    object_value([
        ("operation", JsValue::String(JsString::from_str(operation))),
        ("result", result),
        ("view", view_value(model)),
        ("follow", JsValue::Bool(model.follow)),
    ])
}

#[test]
fn actual_js_store_oracle_matches_follow_unfollow_prepend_and_reset_effects() {
    let row = fixture_rows()
        .into_iter()
        .find(|row| text(get(row, "kind")) == "store")
        .unwrap();
    let expected = decode_wire(get(&row, "expected"));
    let bars: Vec<Bar> = array(get(&expected, "bars"))
        .iter()
        .map(bar_from_value)
        .collect();
    let original_bars = bars.clone();
    let mut data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
    let mut model = ModelState::new(data.store(), &parse(r#"{"visibleBars":5}"#)).unwrap();
    model
        .add_series(
            &parse(r#"{"id":"future","type":"line","panel":"price","source":"close","offset":3}"#),
            &ModelContext::plain(data.store()),
        )
        .unwrap();
    let mut frames = vec![store_frame("initial", JsValue::Null, &model)];

    let committed = data.store_mut().append(generated_bar(12.0)).unwrap();
    let index = committed.value;
    model.on_store_change(data.store(), committed.change.as_ref().unwrap());
    frames.push(store_frame(
        "append-follow",
        success(JsValue::Number(index as f64)),
        &model,
    ));

    let result = capture(
        model
            .set_visible_range(data.store(), &JsValue::Number(0.0), &JsValue::Number(10.0))
            .map(|()| JsValue::Undefined),
    );
    frames.push(store_frame("set-unfollow", result, &model));

    let committed = data.store_mut().append(generated_bar(13.0)).unwrap();
    let index = committed.value;
    model.on_store_change(data.store(), committed.change.as_ref().unwrap());
    frames.push(store_frame(
        "append-unfollow",
        success(JsValue::Number(index as f64)),
        &model,
    ));

    model.fit(data.store());
    frames.push(store_frame("fit", success(JsValue::Undefined), &model));

    let committed = data.store_mut().append(generated_bar(14.0)).unwrap();
    let index = committed.value;
    model.on_store_change(data.store(), committed.change.as_ref().unwrap());
    frames.push(store_frame(
        "append-follow-again",
        success(JsValue::Number(index as f64)),
        &model,
    ));

    let committed = data
        .store_mut()
        .prepend(vec![generated_bar(-2.0), generated_bar(-1.0)])
        .unwrap();
    model.on_store_change(data.store(), committed.change.as_ref().unwrap());
    frames.push(store_frame(
        "prepend-rebase",
        success(JsValue::Undefined),
        &model,
    ));

    let committed = data
        .store_mut()
        .set_data(vec![
            generated_bar(100.0),
            generated_bar(101.0),
            generated_bar(102.0),
        ])
        .unwrap();
    model.on_store_change(data.store(), committed.change.as_ref().unwrap());
    frames.push(store_frame(
        "reset-short",
        success(JsValue::Undefined),
        &model,
    ));

    let actual = object_value([
        (
            "bars",
            JsValue::Array(original_bars.into_iter().map(bar_value).collect()),
        ),
        ("frames", JsValue::Array(frames)),
        ("snapshot", model.snapshot()),
    ]);
    assert_wire(
        &actual,
        get(&row, "expected"),
        "store listener view effects",
    );
}

#[test]
fn typed_value_attachment_is_owned_revisioned_and_omitted_from_portable_wire() {
    let bars = vec![generated_bar(0.0), generated_bar(1.0)];
    let data = ModelDataState::new(StoreOptions::default(), bars).unwrap();
    let store = data.store();
    let mut model = ModelState::new(store, &JsValue::Undefined).unwrap();
    assert_eq!(object(model.theme()).len(), 7);
    assert_eq!(model.panels[0].weight, 3.0);
    assert_eq!(model.panels[0].scale.to_string_lossy(), "linear");
    assert!(!model.panels[0].inverted);
    assert_eq!(model.panels[0].padding, 0.08);
    model
        .add_series_with_values(
            &parse(r#"{"id":"external","type":"line","panel":"price"}"#),
            vec![f64::NAN, -0.0],
            &ModelContext::plain(store),
        )
        .unwrap();
    assert!(
        object(&model.series[0].to_js_value())
            .get(&JsString::from_str("values"))
            .is_none()
    );
    let raw = model.series[0].raw_record();
    let raw_values = array(get(&raw, "values"));
    assert!(number(&raw_values[0]).is_nan());
    assert_eq!(number(&raw_values[1]).to_bits(), (-0.0_f64).to_bits());
    assert_eq!(model.series_values_revision(), None);

    let before = model.snapshot();
    assert_eq!(
        model
            .set_series_values(&parse(r#""external""#), vec![1.0], store,)
            .unwrap_err()
            .message
            .to_string_lossy(),
        "Aligned values and existing series required"
    );
    assert_wire(
        &model.snapshot(),
        &encode_wire(&before),
        "failed typed value update",
    );

    model
        .set_series_values(&parse(r#""external""#), vec![-0.0, 2.0], store)
        .unwrap();
    assert_eq!(model.series_values_revision(), Some(1.0));
    assert_eq!(model.series[0].values_revision, Some(1.0));
    assert!(model.series[0].output.is_none());
    assert_eq!(model.series[0].dirty_from, 0.0);
    assert!(!model.series[0].range_index_ready);
    model.remove_series(&parse(r#""external""#));
    assert!(model.series.is_empty());
}

#[test]
fn successful_removals_return_controller_cleanup_instructions() {
    let data = empty_data();
    let store = data.store();
    let mut model = ModelState::new(store, &JsValue::Undefined).unwrap();
    let plain = ModelContext::plain(store);
    model
        .add_panel(&parse(r#"{"id":"lower"}"#), &plain)
        .unwrap();
    model
        .add_axis(&parse(r#"{"id":"lower-axis","panel":"lower"}"#), &plain)
        .unwrap();
    assert!(
        model
            .validate_drawing_binding(&parse(r#"{"panel":"lower","axisId":"lower-axis"}"#), false)
            .unwrap()
    );
    let lower = JsString::from_str("lower");
    let lower_axis = JsString::from_str("lower-axis");
    let axis_context = ModelContext {
        store,
        indicators: &[],
        drawings: DrawingUsage {
            controller_panel: Some(&lower),
            controller_axis: Some(&lower_axis),
            ..DrawingUsage::default()
        },
        interaction: InteractionGuard::default(),
    };
    let axis = model
        .remove_axis(&parse(r#""lower-axis""#), &axis_context)
        .unwrap();
    assert!(axis.clear_controller_target);
    let panel = model
        .remove_panel(&parse(r#""lower""#), &axis_context)
        .unwrap();
    assert!(panel.clear_controller_target);
    assert_eq!(model.panels.len(), 1);
    assert!(model.axes.is_empty());
}
