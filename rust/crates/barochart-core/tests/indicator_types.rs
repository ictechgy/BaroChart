use barochart_core::indicator_params;
use barochart_core::indicator_types;

use barochart_core::data::Bar;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;
use indicator_params::{IndicatorParamValue, validate_indicator_params};
use indicator_types::{
    BarField, CreatedIndicator, IndicatorDefinition, IndicatorModuleDescriptor, IndicatorOutputRow,
    IndicatorProgram, IndicatorProvenance, PlotOffset,
};

fn empty_params() -> indicator_params::OrderedIndicatorParams {
    validate_indicator_params(&JsValue::Object(JsObject::new())).unwrap()
}

fn bar() -> Bar {
    Bar {
        time: 1.0,
        open: 2.0,
        high: 4.0,
        low: 1.0,
        close: -0.0,
        volume: 5.0,
    }
}

#[test]
fn program_names_are_the_fixed_35_builtins_plus_pressure() {
    assert_eq!(IndicatorProgram::ALL.len(), 36);
    assert_eq!(IndicatorProgram::ALL[0], IndicatorProgram::Sma);
    assert_eq!(IndicatorProgram::ALL[34], IndicatorProgram::ParabolicSar);
    assert_eq!(IndicatorProgram::ALL[35], IndicatorProgram::Pressure);
    assert_eq!(IndicatorProgram::WilliamsR.name(), "williamsR");
    assert_eq!(IndicatorProgram::StochRsi.name(), "stochRSI");
    assert_eq!(
        IndicatorProgram::Pressure.name(),
        "aster.volume-direction@1/pressure"
    );
    assert!(IndicatorProgram::ParabolicSar.is_builtin());
    assert!(!IndicatorProgram::Pressure.is_builtin());
}

#[test]
fn output_row_is_fixed_capacity_and_preserves_number_bits() {
    let values = IndicatorOutputRow::five(-0.0, f64::NAN, 1.0, f64::INFINITY, -1.0);
    assert_eq!(values.len(), 5);
    assert_eq!(values.as_slice()[0].to_bits(), (-0.0_f64).to_bits());
    assert!(values.as_slice()[1].is_nan());
    assert_eq!(values.as_slice()[3], f64::INFINITY);
    assert_eq!(std::mem::size_of::<IndicatorOutputRow>(), 48);

    assert_eq!(IndicatorOutputRow::one(7.0).as_slice(), [7.0]);
    assert_eq!(IndicatorOutputRow::two(7.0, 8.0).as_slice(), [7.0, 8.0]);
    assert_eq!(IndicatorOutputRow::three(1.0, 2.0, 3.0).len(), 3);
    assert_eq!(IndicatorOutputRow::four(1.0, 2.0, 3.0, 4.0).len(), 4);
}

#[test]
fn definition_keeps_ordered_params_f64_offsets_and_provenance() {
    static PRESSURE: IndicatorModuleDescriptor = IndicatorModuleDescriptor {
        id: "aster.volume-direction",
        version: 1,
        state_version: 1,
        export_name: "pressure",
        causal: true,
    };
    let definition = IndicatorDefinition::new(
        IndicatorProgram::Pressure,
        empty_params(),
        &["signed", "cumulative"],
        vec![
            PlotOffset {
                output: "signed",
                value: -0.0,
            },
            PlotOffset {
                output: "cumulative",
                value: -0.0,
            },
        ],
        IndicatorProvenance::Linked(&PRESSURE),
    )
    .unwrap();
    assert_eq!(definition.outputs, ["signed", "cumulative"]);
    assert_eq!(
        definition.plot_offsets[0].value.to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(
        definition.effective_plot_offset("signed").to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(
        definition.effective_plot_offset("missing").to_bits(),
        0.0_f64.to_bits()
    );
    assert_eq!(
        definition.provenance,
        IndicatorProvenance::Linked(&PRESSURE)
    );

    let created = CreatedIndicator {
        definition,
        state: 17_u8,
    };
    assert_eq!(created.state, 17);
    assert_eq!(created.definition.program, IndicatorProgram::Pressure);

    let ichimoku = IndicatorDefinition::new(
        IndicatorProgram::Ichimoku,
        empty_params(),
        &["tenkan", "kijun", "spanA", "spanB", "chikou"],
        vec![
            PlotOffset {
                output: "spanA",
                value: 0.0,
            },
            PlotOffset {
                output: "spanB",
                value: 0.0,
            },
            PlotOffset {
                output: "chikou",
                value: -0.0,
            },
        ],
        IndicatorProvenance::Builtin,
    )
    .unwrap();
    assert_eq!(
        ichimoku.effective_plot_offset("chikou").to_bits(),
        (-0.0_f64).to_bits()
    );
}

#[test]
fn definition_rejects_invalid_layout_without_coercing_offsets() {
    let duplicate = IndicatorDefinition::new(
        IndicatorProgram::Sma,
        empty_params(),
        &["value", "value"],
        Vec::new(),
        IndicatorProvenance::Builtin,
    )
    .unwrap_err();
    assert_eq!(
        duplicate.to_string(),
        "TypeError: Invalid indicator definition"
    );

    let fractional = IndicatorDefinition::new(
        IndicatorProgram::Sma,
        empty_params(),
        &["value"],
        vec![PlotOffset {
            output: "value",
            value: 0.5,
        }],
        IndicatorProvenance::Builtin,
    )
    .unwrap_err();
    assert_eq!(
        fractional.to_string(),
        "TypeError: Invalid indicator definition"
    );

    let wrong_provenance = IndicatorDefinition::new(
        IndicatorProgram::Pressure,
        empty_params(),
        &["signed", "cumulative"],
        Vec::new(),
        IndicatorProvenance::Builtin,
    )
    .unwrap_err();
    assert_eq!(
        wrong_provenance.to_string(),
        "TypeError: Invalid indicator definition"
    );
}

#[test]
fn bar_field_is_typed_and_unknown_sources_produce_a_gap() {
    let bar = bar();
    assert_eq!(
        BarField::from_name(&JsString::from_str("time")),
        BarField::Time
    );
    assert_eq!(
        BarField::from_name(&JsString::from_str("close")),
        BarField::Close
    );
    assert_eq!(BarField::Close.read(&bar).to_bits(), (-0.0_f64).to_bits());
    assert_eq!(BarField::Volume.read(&bar), 5.0);
    assert_eq!(
        BarField::from_name(&JsString::from_str("unknown-source")),
        BarField::Unknown
    );
    assert_eq!(
        BarField::from_param(&IndicatorParamValue::Number(123.0)),
        BarField::Unknown
    );
    let mut numeric_source = JsObject::new();
    numeric_source.insert(JsString::from_str("source"), JsValue::Number(123.0));
    let numeric_source = validate_indicator_params(&JsValue::Object(numeric_source)).unwrap();
    assert_eq!(
        BarField::from_param(numeric_source.get("source").unwrap()),
        BarField::Unknown
    );
    assert_eq!(
        BarField::from_param(&IndicatorParamValue::String(JsString::from_str("close"))),
        BarField::Close
    );
    assert!(BarField::Unknown.read(&bar).is_nan());
}
