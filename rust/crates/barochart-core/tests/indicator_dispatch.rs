use barochart_core::data::Bar;
use barochart_core::indicator_dispatch::create;
use barochart_core::indicator_helpers::exact_state_equal;
use barochart_core::indicator_types::IndicatorProgram;
use barochart_core::{Host, HostError};
use barochart_js::json::{JsObject, JsValue};
use barochart_js::string::JsString;

struct NoNamedZones;
impl Host for NoNamedZones {
    fn zone_resolve(&self, _: &JsString) -> Result<JsString, HostError> {
        Err(HostError)
    }
    fn zone_offset_seconds(&self, _: &JsString, _: f64) -> Result<i32, HostError> {
        Err(HostError)
    }
    fn log(&self, _: i32, _: &str) {}
}

#[test]
fn every_program_dispatches_to_its_definition_and_restores_before_the_next_step() {
    let host = NoNamedZones;
    let raw = JsValue::Object(JsObject::new());
    for program in IndicatorProgram::ALL {
        let mut first = create(program, &raw, &host).unwrap();
        assert_eq!(first.definition.program, program);
        let bar = Bar {
            time: 1_700_000_000_000.0,
            open: 1.0,
            high: 2.0,
            low: 0.0,
            close: 1.0,
            volume: 1.0,
        };
        let row = first.state.step(&host, &bar, 0).unwrap();
        assert_eq!(row.len(), first.definition.outputs.len());
        let wire = first.state.snapshot();
        let mut second = create(program, &raw, &host).unwrap();
        second.state.restore(&wire).unwrap();
        assert!(exact_state_equal(&wire, &second.state.snapshot()));
        let next = Bar {
            time: bar.time + 60_000.0,
            close: 2.0,
            ..bar
        };
        let expected = first.state.step(&host, &next, 1).unwrap();
        let actual = second.state.step(&host, &next, 1).unwrap();
        for (expected, actual) in expected.as_slice().iter().zip(actual.as_slice()) {
            assert!(
                expected.to_bits() == actual.to_bits() || expected.is_nan() && actual.is_nan(),
                "{}",
                program.name()
            );
        }
    }
}
