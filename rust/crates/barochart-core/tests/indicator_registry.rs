use barochart_core::indicator_registry;
use barochart_core::indicator_types;

use barochart_js::string::JsString;
use indicator_registry::{IndicatorRegistry, metadata_for_program};
use indicator_types::{IndicatorProgram, IndicatorProvenance};

const BUILTINS: [&str; 35] = [
    "sma",
    "vwma",
    "ema",
    "wma",
    "rsi",
    "atr",
    "macd",
    "bollinger",
    "donchian",
    "aroon",
    "stochastic",
    "roc",
    "williamsR",
    "cci",
    "obv",
    "vwap",
    "mfi",
    "cmf",
    "adx",
    "dema",
    "tema",
    "hma",
    "keltner",
    "supertrend",
    "ichimoku",
    "trix",
    "ppo",
    "stochRSI",
    "adl",
    "chaikin",
    "forceIndex",
    "volumeOscillator",
    "vortex",
    "pivots",
    "parabolicSAR",
];

#[test]
fn initial_registry_is_exactly_the_35_source_ordered_builtins() {
    let registry = IndicatorRegistry::new();
    assert_eq!(registry.len(), 35);
    let names: Vec<&str> = registry.entries().map(|entry| entry.name).collect();
    assert_eq!(names, BUILTINS);
    for (index, entry) in registry.entries().enumerate() {
        assert_eq!(entry.program, IndicatorProgram::ALL[index]);
        assert_eq!(entry.provenance, IndicatorProvenance::Builtin);
        assert!(registry.is_registered(entry.program));
        assert_eq!(
            registry.lookup(&JsString::from_str(entry.name)),
            Some(entry)
        );
    }
    assert!(
        registry
            .lookup(&JsString::from_str("aster.volume-direction@1/pressure"))
            .is_none()
    );
    assert!(!registry.is_registered(IndicatorProgram::Pressure));
}

#[test]
fn default_output_orders_match_all_registry_rows() {
    let expected: [(&str, &[&str]); 35] = [
        ("sma", &["value"]),
        ("vwma", &["value"]),
        ("ema", &["value"]),
        ("wma", &["value"]),
        ("rsi", &["value"]),
        ("atr", &["value"]),
        ("macd", &["macd", "signal", "histogram"]),
        ("bollinger", &["middle", "upper", "lower"]),
        ("donchian", &["middle", "upper", "lower"]),
        ("aroon", &["up", "down", "oscillator"]),
        ("stochastic", &["k", "d"]),
        ("roc", &["value"]),
        ("williamsR", &["value"]),
        ("cci", &["value"]),
        ("obv", &["value"]),
        ("vwap", &["value"]),
        ("mfi", &["value"]),
        ("cmf", &["value"]),
        ("adx", &["adx", "plusDI", "minusDI"]),
        ("dema", &["value"]),
        ("tema", &["value"]),
        ("hma", &["value"]),
        ("keltner", &["middle", "upper", "lower"]),
        ("supertrend", &["value", "direction"]),
        ("ichimoku", &["tenkan", "kijun", "spanA", "spanB", "chikou"]),
        ("trix", &["value"]),
        ("ppo", &["ppo", "signal", "histogram"]),
        ("stochRSI", &["k", "d"]),
        ("adl", &["value"]),
        ("chaikin", &["value"]),
        ("forceIndex", &["value"]),
        ("volumeOscillator", &["value"]),
        ("vortex", &["plus", "minus"]),
        ("pivots", &["pivot", "r1", "s1", "r2", "s2"]),
        ("parabolicSAR", &["value", "direction"]),
    ];
    let registry = IndicatorRegistry::new();
    for ((name, outputs), metadata) in expected.into_iter().zip(registry.entries()) {
        assert_eq!(metadata.name, name);
        assert_eq!(metadata.outputs, outputs);
        assert!((1..=5).contains(&metadata.outputs.len()));
    }
}

#[test]
fn parameter_declaration_orders_match_factories_and_keep_empty_orders() {
    let expected: [(&str, &[&str]); 35] = [
        ("sma", &["period", "source"]),
        ("vwma", &["period"]),
        ("ema", &["period", "source"]),
        ("wma", &["period"]),
        ("rsi", &["period"]),
        ("atr", &["period"]),
        ("macd", &["fast", "slow", "signal"]),
        ("bollinger", &["period", "deviation"]),
        ("donchian", &["period"]),
        ("aroon", &["period"]),
        ("stochastic", &["period", "smoothK", "smoothD"]),
        ("roc", &["period"]),
        ("williamsR", &["period"]),
        ("cci", &["period"]),
        ("obv", &[]),
        (
            "vwap",
            &[
                "calendar",
                "anchorTime",
                "sessionMs",
                "kinds",
                "source",
                "deviation",
            ],
        ),
        ("mfi", &["period"]),
        ("cmf", &["period"]),
        ("adx", &["period"]),
        ("dema", &["period"]),
        ("tema", &["period"]),
        ("hma", &["period"]),
        ("keltner", &["period", "atrPeriod", "multiplier"]),
        ("supertrend", &["period", "multiplier"]),
        ("ichimoku", &["conversion", "base", "span", "displacement"]),
        ("trix", &["period"]),
        ("ppo", &["fast", "slow", "signal"]),
        ("stochRSI", &["period", "stochPeriod", "smoothK", "smoothD"]),
        ("adl", &[]),
        ("chaikin", &["fast", "slow"]),
        ("forceIndex", &["period"]),
        ("volumeOscillator", &["fast", "slow"]),
        ("vortex", &["period"]),
        ("pivots", &["calendar", "anchorTime", "sessionMs", "kinds"]),
        ("parabolicSAR", &["step", "max"]),
    ];
    let registry = IndicatorRegistry::new();
    for ((name, params), metadata) in expected.into_iter().zip(registry.entries()) {
        assert_eq!(metadata.name, name);
        assert_eq!(metadata.parameter_order, params);
    }
}

#[test]
fn pressure_appears_only_after_fixed_module_registration_and_is_idempotent() {
    let mut registry = IndicatorRegistry::new();
    assert_eq!(
        registry.register_volume_direction_v1(),
        ["aster.volume-direction@1/pressure"]
    );
    assert_eq!(registry.len(), 36);
    assert_eq!(
        registry.entries().last().unwrap().program,
        IndicatorProgram::Pressure
    );
    assert_eq!(
        registry.register_volume_direction_v1(),
        ["aster.volume-direction@1/pressure"]
    );
    assert_eq!(registry.len(), 36);

    let pressure = registry
        .lookup(&JsString::from_str("aster.volume-direction@1/pressure"))
        .unwrap();
    assert_eq!(pressure.outputs, ["signed", "cumulative"]);
    assert_eq!(pressure.parameter_order, ["factor", "shift"]);
    let IndicatorProvenance::Linked(descriptor) = pressure.provenance else {
        panic!("pressure must be linked")
    };
    assert_eq!(descriptor.id, "aster.volume-direction");
    assert_eq!(descriptor.version, 1);
    assert_eq!(descriptor.state_version, 1);
    assert_eq!(descriptor.export_name, "pressure");
    assert!(descriptor.causal);
    assert_eq!(metadata_for_program(IndicatorProgram::Pressure), pressure);
}
