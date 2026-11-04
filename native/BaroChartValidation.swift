import Foundation

/// Validation-only backend constructor. This SPI is for the repository's A/B sample and is not a public default selector.
@_spi(BaroChartValidation)
public enum BaroChartValidation {
    public static func makeEngine(options: BaroChartEngineOptions, backend: String) throws -> BaroChartEngine {
        switch backend {
        case "javascript": return try BaroChartEngine(options: options.lowLevel, runtimeBackend: .javaScript)
        case "rust": return try BaroChartEngine(options: options.lowLevel, runtimeBackend: .rust)
        default: throw NSError(domain: "BaroChartValidation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown validation backend"])
        }
    }

    public static func actualBackend(for engine: BaroChartEngine) throws -> String {
        switch try engine.validationRuntimeBackend() {
        case .javaScript: return "javascript"
        case .rust: return "rust"
        }
    }
}
