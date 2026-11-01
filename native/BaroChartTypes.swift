import Foundation

// Value types for the BaroChart typed API. Raw values match the chart core vocabulary exactly;
// `Tests/BaroChartTests/TypesParityTests.swift` fails if the core gains or renames an entry.
// Each type converts itself to the low-level dictionary the engine bridge already accepts, so
// the typed API never duplicates chart behavior.

/// A streaming or correction event applied to the primary OHLCV series.
public indirect enum BaroChartDataEvent: Equatable, Sendable {
    /// Replaces every bar.
    case reset([BaroChartBar])
    /// Adds a bar later than the last bar.
    case append(BaroChartBar)
    /// Replaces the current (last) bar; its time must equal the last bar's time.
    case update(BaroChartBar)
    /// Replaces an existing bar with the same time.
    case correction(BaroChartBar)
    /// Adds older bars before the first bar.
    case prepend([BaroChartBar])
    /// Applies events in order as one batch.
    case batch([BaroChartDataEvent])
}

/// Series renderers supported by the core.
public enum BaroChartSeriesType: String, CaseIterable, Sendable { case candles, ohlc, line, area, histogram }

/// Primary-series column used by a general series.
public enum BaroChartPriceSource: String, CaseIterable, Sendable { case open, high, low, close, volume }

/// A series on a panel. Candles/OHLC read the primary OHLCV; other types read a source column or an indicator output.
public struct BaroChartSeries: Equatable, Sendable {
    public var id: String
    public var type: BaroChartSeriesType
    public var panel: String
    public var source: BaroChartPriceSource?
    public var indicator: String?
    public var output: String?
    public var color: String?
    public var width: Double?
    public var visible: Bool?
    public var label: String?

    public init(id: String, type: BaroChartSeriesType, panel: String = "price", source: BaroChartPriceSource? = nil,
                indicator: String? = nil, output: String? = nil, color: String? = nil, width: Double? = nil,
                visible: Bool? = nil, label: String? = nil) {
        self.id = id; self.type = type; self.panel = panel; self.source = source; self.indicator = indicator
        self.output = output; self.color = color; self.width = width; self.visible = visible; self.label = label
    }
}

/// The 35 built-in indicators. Raw values are the core indicator names.
public enum BaroChartIndicatorKind: String, CaseIterable, Sendable {
    case sma, vwma, ema, wma, rsi, atr, macd, bollinger, donchian, aroon, stochastic, roc, williamsR, cci, obv, vwap,
         mfi, cmf, adx, dema, tema, hma, keltner, supertrend, ichimoku, trix, ppo, stochRSI, adl, chaikin, forceIndex,
         volumeOscillator, vortex, pivots, parabolicSAR
}

/// An indicator parameter value. Integer and floating-point literals both become numbers.
public enum BaroChartParamValue: Equatable, Sendable, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
                                 ExpressibleByStringLiteral, ExpressibleByBooleanLiteral {
    case number(Double), text(String), flag(Bool)
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .text(value) }
    public init(booleanLiteral value: Bool) { self = .flag(value) }
}

/// An indicator definition: kind plus parameters. Omitted parameters use the core defaults.
public struct BaroChartIndicator: Equatable, Sendable {
    public var kind: BaroChartIndicatorKind
    public var params: [String: BaroChartParamValue]

    public init(_ kind: BaroChartIndicatorKind, params: [String: BaroChartParamValue] = [:]) { self.kind = kind; self.params = params }

    /// Simple moving average.
    public static func sma(period: Int) -> Self { Self(.sma, params: ["period": .number(Double(period))]) }
    /// Exponential moving average.
    public static func ema(period: Int) -> Self { Self(.ema, params: ["period": .number(Double(period))]) }
    /// Relative strength index.
    public static func rsi(period: Int) -> Self { Self(.rsi, params: ["period": .number(Double(period))]) }
    /// MACD with fast, slow and signal periods.
    public static func macd(fast: Int, slow: Int, signal: Int) -> Self {
        Self(.macd, params: ["fast": .number(Double(fast)), "slow": .number(Double(slow)), "signal": .number(Double(signal))])
    }
    /// Bollinger Bands; `deviation` is the standard-deviation multiplier.
    public static func bollinger(period: Int, deviation: Double) -> Self {
        Self(.bollinger, params: ["period": .number(Double(period)), "deviation": .number(deviation)])
    }
    /// Session VWAP with core defaults.
    public static func vwap() -> Self { Self(.vwap) }
}

/// Drawing tools. `select` picks and edits existing drawings; the others create drawings.
public enum BaroChartDrawingTool: String, CaseIterable, Sendable {
    case select, trendline, horizontal, fibonacci, rectangle, ellipse, text, ray, extendedline, channel,
         fibextension, fibfan, fibtimezones, freehand, measurement, longposition, shortposition
}

/// A drawing anchor in data coordinates: UTC milliseconds and price.
public struct BaroChartPoint: Equatable, Sendable {
    public var time: Double
    public var price: Double
    public init(time: Double, price: Double) { self.time = time; self.price = price }
}

/// Portable drawing style. Colors are CSS hex strings such as `#f0b755`.
public struct BaroChartDrawingStyle: Equatable, Sendable {
    public var color: String?
    public var fill: String?
    public var width: Double?
    public var font: String?
    public init(color: String? = nil, fill: String? = nil, width: Double? = nil, font: String? = nil) {
        self.color = color; self.fill = fill; self.width = width; self.font = font
    }
}

/// A drawing to add or the fields to change. `tool` must not be `.select`.
public struct BaroChartDrawing: Equatable, Sendable {
    public var id: String?
    public var tool: BaroChartDrawingTool
    public var points: [BaroChartPoint]
    public var panel: String
    public var style: BaroChartDrawingStyle?
    public var text: String?
    public var locked: Bool?
    public var visible: Bool?

    public init(id: String? = nil, tool: BaroChartDrawingTool, points: [BaroChartPoint], panel: String = "price",
                style: BaroChartDrawingStyle? = nil, text: String? = nil, locked: Bool? = nil, visible: Bool? = nil) {
        self.id = id; self.tool = tool; self.points = points; self.panel = panel
        self.style = style; self.text = text; self.locked = locked; self.visible = visible
    }
}

/// Chart colors and font. Use `.dark` or `.light` and adjust fields as needed.
public struct BaroChartTheme: Equatable, Sendable {
    public var background: String, grid: String, text: String, up: String, down: String, crosshair: String
    /// CSS-style font such as `12px monospace`.
    public var font: String

    public init(background: String, grid: String, text: String, up: String, down: String, crosshair: String, font: String) {
        self.background = background; self.grid = grid; self.text = text; self.up = up
        self.down = down; self.crosshair = crosshair; self.font = font
    }

    /// The core dark theme.
    public static let dark = BaroChartTheme(background: "#0c1320", grid: "#1d2a3a", text: "#8093ad", up: "#35d2ab",
                                            down: "#fa6c7c", crosshair: "#b9c9de", font: "12px monospace")
    /// The core light theme.
    public static let light = BaroChartTheme(background: "#f8fafc", grid: "#dfe6ee", text: "#53657d", up: "#078d6d",
                                             down: "#df344b", crosshair: "#304158", font: "12px monospace")
}

/// Price adjustment basis of a data source.
public enum BaroChartAdjustment: String, CaseIterable, Sendable { case raw, split, totalReturn = "total-return" }

/// Instrument metadata used for price/time formatting.
public struct BaroChartSymbol: Equatable, Sendable {
    public var id: String, exchange: String, timezone: String, currency: String, volumeUnit: String
    public var priceDecimals: Int
    public var tickSize: Double
    public var adjustment: BaroChartAdjustment

    public init(id: String, exchange: String, timezone: String, currency: String, priceDecimals: Int,
                tickSize: Double, volumeUnit: String = "shares", adjustment: BaroChartAdjustment = .raw) {
        self.id = id; self.exchange = exchange; self.timezone = timezone; self.currency = currency
        self.priceDecimals = priceDecimals; self.tickSize = tickSize; self.volumeUnit = volumeUnit; self.adjustment = adjustment
    }
}

/// The host's assertion of which dataset a saved workspace belongs to. Restores reject a different binding.
public struct BaroChartDatasetBinding: Equatable, Sendable {
    public var key: String, revision: String, adjustmentVersion: String, priceUnit: String
    public var adjustment: BaroChartAdjustment

    public init(key: String, revision: String, adjustmentVersion: String, priceUnit: String, adjustment: BaroChartAdjustment) {
        self.key = key; self.revision = revision; self.adjustmentVersion = adjustmentVersion
        self.priceUnit = priceUnit; self.adjustment = adjustment
    }
}

/// Visible range in bar-index coordinates (the core view range).
public struct BaroChartVisibleRange: Equatable, Sendable {
    public var from: Double
    public var to: Double
    public init(from: Double, to: Double) { self.from = from; self.to = to }
}

/// An indicator value read at a bar index. `nil` fields mean the value is not available yet.
public struct BaroChartIndicatorValue: Equatable, Sendable {
    public var value: Double?
    public var sourceIndex: Int?
    public var sourceTime: Double?
    public init(value: Double?, sourceIndex: Int?, sourceTime: Double?) { self.value = value; self.sourceIndex = sourceIndex; self.sourceTime = sourceTime }
}

/// Values under the crosshair.
public struct BaroChartCrosshairValues: Equatable, Sendable {
    /// One visible series value at the crosshair.
    public struct SeriesValue: Equatable, Sendable {
        public var id: String, label: String, panel: String
        public var value: Double?
        public init(id: String, label: String, panel: String, value: Double?) { self.id = id; self.label = label; self.panel = panel; self.value = value }
    }
    public var index: Int
    public var time: Double
    public var bar: BaroChartBar?
    public var series: [SeriesValue]
    public init(index: Int, time: Double, bar: BaroChartBar?, series: [SeriesValue]) { self.index = index; self.time = time; self.bar = bar; self.series = series }
}

// MARK: - 저수준 딕셔너리 변환(엔진 브리지가 받는 형태). nil 필드는 키를 넣지 않아 코어 기본값을 쓴다.

/// 선택 필드를 nil이 아닐 때만 넣는다
private func put(_ dictionary: inout [String: Any], _ key: String, _ value: Any?) { if let value { dictionary[key] = value } }

extension BaroChartBar {
    var lowLevel: [String: Any] { ["time": time, "open": open, "high": high, "low": low, "close": close, "volume": volume] }
}

extension BaroChartDataEvent {
    var lowLevel: [String: Any] {
        switch self {
        case .reset(let bars): return ["kind": "reset", "bars": bars.map(\.lowLevel)]
        case .append(let bar): return ["kind": "append", "bar": bar.lowLevel]
        case .update(let bar): return ["kind": "update", "bar": bar.lowLevel]
        case .correction(let bar): return ["kind": "correction", "bar": bar.lowLevel]
        case .prepend(let bars): return ["kind": "prepend", "bars": bars.map(\.lowLevel)]
        case .batch(let events): return ["kind": "batch", "events": events.map(\.lowLevel)]
        }
    }
}

extension BaroChartSeries {
    var lowLevel: [String: Any] {
        var out: [String: Any] = ["id": id, "type": type.rawValue, "panel": panel]
        put(&out, "source", source?.rawValue); put(&out, "indicator", indicator); put(&out, "output", output)
        put(&out, "color", color); put(&out, "width", width); put(&out, "visible", visible); put(&out, "label", label)
        return out
    }
}

extension BaroChartParamValue {
    var lowLevel: Any {
        switch self { case .number(let value): return value; case .text(let value): return value; case .flag(let value): return value }
    }
}

extension BaroChartIndicator {
    var lowLevelParams: [String: Any] { params.mapValues(\.lowLevel) }
}

extension BaroChartDrawingStyle {
    var lowLevel: [String: Any] {
        var out: [String: Any] = [:]
        put(&out, "color", color); put(&out, "fill", fill); put(&out, "width", width); put(&out, "font", font)
        return out
    }
}

extension BaroChartDrawing {
    var lowLevel: [String: Any] {
        var out: [String: Any] = ["type": tool.rawValue, "panel": panel, "points": points.map { ["time": $0.time, "price": $0.price] }]
        put(&out, "id", id); put(&out, "style", style?.lowLevel); put(&out, "text", text)
        put(&out, "locked", locked); put(&out, "visible", visible)
        return out
    }
}

extension BaroChartTheme {
    var lowLevel: [String: Any] {
        ["background": background, "grid": grid, "text": text, "up": up, "down": down, "crosshair": crosshair, "font": font]
    }
}

extension BaroChartSymbol {
    var lowLevel: [String: Any] {
        ["id": id, "exchange": exchange, "timezone": timezone, "currency": currency, "volumeUnit": volumeUnit,
         "priceDecimals": priceDecimals, "tickSize": tickSize, "adjustment": adjustment.rawValue]
    }
}

extension BaroChartDatasetBinding {
    var lowLevel: [String: Any] {
        ["key": key, "revision": revision, "adjustmentVersion": adjustmentVersion, "priceUnit": priceUnit, "adjustment": adjustment.rawValue]
    }
}
