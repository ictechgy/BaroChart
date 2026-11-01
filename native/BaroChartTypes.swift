import Foundation

// Value types for the BaroChart typed API. Raw values match the chart core vocabulary exactly;
// `Tests/BaroChartTests/TypesParityTests.swift` fails if the core gains or renames an entry.
// Each type converts itself to the low-level dictionary the engine bridge already accepts, so
// the typed API never duplicates chart behavior.

/// A vertical chart panel. `weight` sets its share of the height relative to other panels.
public struct BaroChartPanel: Equatable, Sendable {
    /// Panel identifier. Series and drawings refer to it by this id.
    public var id: String
    /// Share of the chart height relative to the other panels; for example, `3` against `1` gives three times the height.
    public var weight: Double
    /// Optional label for the panel; `nil` leaves it unlabeled.
    public var label: String?
    /// Creates a panel. `weight` defaults to `1` and `label` to `nil`.
    public init(id: String, weight: Double = 1, label: String? = nil) { self.id = id; self.weight = weight; self.label = label }
}

/// Initial chart layout for `BaroChartEngine(options:)`.
///
/// The default is one unlabeled `price` panel with a `price` candlestick series and the core dark theme.
public struct BaroChartEngineOptions: Equatable, Sendable {
    /// Panels from top to bottom.
    public var panels: [BaroChartPanel]
    /// Series to create at startup; each refers to a panel by id.
    public var series: [BaroChartSeries]
    /// Initial theme, or `nil` for the core dark theme.
    public var theme: BaroChartTheme?

    /// Creates engine options. Each parameter defaults to the value described on ``BaroChartEngineOptions``.
    public init(panels: [BaroChartPanel] = [BaroChartPanel(id: "price", weight: 3)],
                series: [BaroChartSeries] = [BaroChartSeries(id: "price", type: .candles)],
                theme: BaroChartTheme? = nil) {
        self.panels = panels; self.series = series; self.theme = theme
    }
}

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
    /// Series identifier, unique within the chart.
    public var id: String
    /// Renderer used to draw the series.
    public var type: BaroChartSeriesType
    /// Id of the panel that shows the series.
    public var panel: String
    /// Primary-series column to plot for line, area and histogram series; `nil` for candles, OHLC or indicator-backed series.
    public var source: BaroChartPriceSource?
    /// Id of the indicator whose output this series plots, or `nil`.
    public var indicator: String?
    /// Name of the indicator output to plot; `nil` selects the indicator's default output.
    public var output: String?
    /// Series color as a CSS hex string, or `nil` for the core default.
    public var color: String?
    /// Line width in logical pixels, or `nil` for the core default.
    public var width: Double?
    /// Whether the series is shown; `nil` leaves the core default.
    public var visible: Bool?
    /// Display label used in readouts, or `nil` for the core default.
    public var label: String?

    /// Creates a series description. Only `id` and `type` are required; `panel` defaults to `price`.
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
    /// Creates a number value from an integer literal.
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    /// Creates a number value from a floating-point literal.
    public init(floatLiteral value: Double) { self = .number(value) }
    /// Creates a text value from a string literal.
    public init(stringLiteral value: String) { self = .text(value) }
    /// Creates a flag value from a Boolean literal.
    public init(booleanLiteral value: Bool) { self = .flag(value) }
}

/// An indicator definition: kind plus parameters. Omitted parameters use the core defaults.
public struct BaroChartIndicator: Equatable, Sendable {
    /// Which built-in indicator to compute.
    public var kind: BaroChartIndicatorKind
    /// Indicator parameters by core parameter name. Omitted names use the core defaults.
    public var params: [String: BaroChartParamValue]

    /// Creates an indicator definition from a kind and optional parameters.
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
    /// Bar time in UTC epoch milliseconds.
    public var time: Double
    /// Price in the chart's price units.
    public var price: Double
    /// Creates an anchor from a UTC epoch time in milliseconds and a price.
    public init(time: Double, price: Double) { self.time = time; self.price = price }
}

/// Portable drawing style. Colors are CSS hex strings such as `#f0b755`.
public struct BaroChartDrawingStyle: Equatable, Sendable {
    /// Stroke color as a CSS hex string, or `nil` for the core default.
    public var color: String?
    /// Fill color as a CSS hex string, or `nil` for the core default.
    public var fill: String?
    /// Stroke width in logical pixels, or `nil` for the core default.
    public var width: Double?
    /// CSS-style font such as `12px monospace` for text, or `nil` for the core default.
    public var font: String?
    /// Creates a style. Every field is optional; `nil` fields keep the core defaults.
    public init(color: String? = nil, fill: String? = nil, width: Double? = nil, font: String? = nil) {
        self.color = color; self.fill = fill; self.width = width; self.font = font
    }
}

/// A drawing to add or the fields to change. `tool` must not be `.select`.
public struct BaroChartDrawing: Equatable, Sendable {
    /// Drawing identifier. `nil` when adding lets the core assign one; required to update.
    public var id: String?
    /// Drawing tool that defines the shape. Must not be `.select`.
    public var tool: BaroChartDrawingTool
    /// Anchors in data coordinates (UTC milliseconds and price). The number needed depends on the tool.
    public var points: [BaroChartPoint]
    /// Id of the panel that holds the drawing; defaults to `price`.
    public var panel: String
    /// Portable style, or `nil` for the core defaults.
    public var style: BaroChartDrawingStyle?
    /// Label text for tools that show text, or `nil`.
    public var text: String?
    /// Whether the drawing is locked against editing; `nil` leaves it unchanged or at the core default.
    public var locked: Bool?
    /// Whether the drawing is shown; `nil` leaves it unchanged or at the core default.
    public var visible: Bool?

    /// Creates a drawing description. `id`, `style`, `text`, `locked` and `visible` default to `nil`; `panel` defaults to `price`.
    public init(id: String? = nil, tool: BaroChartDrawingTool, points: [BaroChartPoint], panel: String = "price",
                style: BaroChartDrawingStyle? = nil, text: String? = nil, locked: Bool? = nil, visible: Bool? = nil) {
        self.id = id; self.tool = tool; self.points = points; self.panel = panel
        self.style = style; self.text = text; self.locked = locked; self.visible = visible
    }
}

/// Fields to change on an existing series. Only non-`nil` fields change; the series type cannot change.
///
/// A patch cannot reset a field to the core default: `nil` always means "keep the current value".
public struct BaroChartSeriesPatch: Equatable, Sendable {
    /// New panel id, or `nil` to keep the current panel.
    public var panel: String?
    /// New primary-series column, or `nil` to keep the current source.
    public var source: BaroChartPriceSource?
    /// New indicator id to plot, or `nil` to keep the current binding.
    public var indicator: String?
    /// New indicator output name, or `nil` to keep the current output.
    public var output: String?
    /// New CSS hex color, or `nil` to keep the current color.
    public var color: String?
    /// New line width in logical pixels, or `nil` to keep the current width.
    public var width: Double?
    /// New visibility, or `nil` to keep the current visibility.
    public var visible: Bool?
    /// New readout label, or `nil` to keep the current label.
    public var label: String?

    /// Creates a patch. Every field defaults to `nil` (unchanged).
    public init(panel: String? = nil, source: BaroChartPriceSource? = nil, indicator: String? = nil, output: String? = nil,
                color: String? = nil, width: Double? = nil, visible: Bool? = nil, label: String? = nil) {
        self.panel = panel; self.source = source; self.indicator = indicator; self.output = output
        self.color = color; self.width = width; self.visible = visible; self.label = label
    }
}

/// Fields to change on an existing drawing. Only non-`nil` fields change; the tool cannot change.
///
/// A patch cannot reset a field to the core default: `nil` always means "keep the current value".
public struct BaroChartDrawingPatch: Equatable, Sendable {
    /// New anchors in data coordinates, or `nil` to keep the current anchors.
    public var points: [BaroChartPoint]?
    /// New panel id, or `nil` to keep the current panel.
    public var panel: String?
    /// New portable style, or `nil` to keep the current style.
    public var style: BaroChartDrawingStyle?
    /// New label text, or `nil` to keep the current text.
    public var text: String?
    /// New lock state, or `nil` to keep the current state.
    public var locked: Bool?
    /// New visibility, or `nil` to keep the current visibility.
    public var visible: Bool?

    /// Creates a patch. Every field defaults to `nil` (unchanged).
    public init(points: [BaroChartPoint]? = nil, panel: String? = nil, style: BaroChartDrawingStyle? = nil,
                text: String? = nil, locked: Bool? = nil, visible: Bool? = nil) {
        self.points = points; self.panel = panel; self.style = style; self.text = text; self.locked = locked; self.visible = visible
    }
}

/// Chart colors and font. Use `.dark` or `.light` and adjust fields as needed.
public struct BaroChartTheme: Equatable, Sendable {
    /// Colors as CSS hex strings: `background`, `grid` lines, axis and label `text`, `up` and `down` candle colors, and the `crosshair`.
    public var background: String, grid: String, text: String, up: String, down: String, crosshair: String
    /// CSS-style font such as `12px monospace`.
    public var font: String

    /// Creates a theme from its colors and font.
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
    /// Instrument metadata: `id` is the symbol identifier, `exchange` the venue, `timezone` an IANA time zone name used for time labels, `currency` the price currency and `volumeUnit` the unit of volume (default `shares`).
    public var id: String, exchange: String, timezone: String, currency: String, volumeUnit: String
    /// Number of decimals used to format prices.
    public var priceDecimals: Int
    /// Minimum price increment.
    public var tickSize: Double
    /// Price adjustment basis of the data. Defaults to `.raw`.
    public var adjustment: BaroChartAdjustment

    /// Creates instrument metadata. `volumeUnit` defaults to `shares` and `adjustment` to `.raw`.
    public init(id: String, exchange: String, timezone: String, currency: String, priceDecimals: Int,
                tickSize: Double, volumeUnit: String = "shares", adjustment: BaroChartAdjustment = .raw) {
        self.id = id; self.exchange = exchange; self.timezone = timezone; self.currency = currency
        self.priceDecimals = priceDecimals; self.tickSize = tickSize; self.volumeUnit = volumeUnit; self.adjustment = adjustment
    }
}

/// The host's assertion of which dataset a saved workspace belongs to. Restores reject a different binding.
public struct BaroChartDatasetBinding: Equatable, Sendable {
    /// Dataset identity the host asserts: `key` names the dataset, `revision` its data revision, `adjustmentVersion` the version of its price adjustment and `priceUnit` the unit of its prices.
    public var key: String, revision: String, adjustmentVersion: String, priceUnit: String
    /// Price adjustment basis of the dataset.
    public var adjustment: BaroChartAdjustment

    /// Creates a dataset binding from the host's identifiers for the dataset.
    public init(key: String, revision: String, adjustmentVersion: String, priceUnit: String, adjustment: BaroChartAdjustment) {
        self.key = key; self.revision = revision; self.adjustmentVersion = adjustmentVersion
        self.priceUnit = priceUnit; self.adjustment = adjustment
    }
}

/// Visible range in bar-index coordinates (the core view range).
public struct BaroChartVisibleRange: Equatable, Sendable {
    /// Lower bound, as a bar index.
    public var from: Double
    /// Upper bound, as a bar index. Must be greater than `from` when setting a range.
    public var to: Double
    /// Creates a visible range from bar-index bounds.
    public init(from: Double, to: Double) { self.from = from; self.to = to }
}

/// An indicator value read at a bar index. `nil` fields mean the value is not available yet.
public struct BaroChartIndicatorValue: Equatable, Sendable {
    /// Indicator value, or `nil` when not available yet.
    public var value: Double?
    /// Bar index the value was taken from, or `nil` when not available yet.
    public var sourceIndex: Int?
    /// Time of the source bar in UTC epoch milliseconds, or `nil` when not available yet.
    public var sourceTime: Double?
    /// Creates an indicator value. Pass `nil` for fields that are not available.
    public init(value: Double?, sourceIndex: Int?, sourceTime: Double?) { self.value = value; self.sourceIndex = sourceIndex; self.sourceTime = sourceTime }
}

/// Values under the crosshair.
public struct BaroChartCrosshairValues: Equatable, Sendable {
    /// One visible series value at the crosshair.
    public struct SeriesValue: Equatable, Sendable {
        /// Series identifier, display label and panel id, as set on the series.
        public var id: String, label: String, panel: String
        /// Series value at the crosshair, or `nil` when the series has none there.
        public var value: Double?
        /// Creates a series value.
        public init(id: String, label: String, panel: String, value: Double?) { self.id = id; self.label = label; self.panel = panel; self.value = value }
    }
    /// Bar index under the crosshair.
    public var index: Int
    /// Time of that bar in UTC epoch milliseconds.
    public var time: Double
    /// The bar under the crosshair, or `nil` when there is none.
    public var bar: BaroChartBar?
    /// Values of the visible series at the crosshair.
    public var series: [SeriesValue]
    /// Creates crosshair values.
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

extension BaroChartSeriesPatch {
    /// 설정한 필드만 담은 코어 setSeries 패치(nil은 보내지 않아 기존 값 유지)
    var lowLevel: [String: Any] {
        var out: [String: Any] = [:]
        put(&out, "panel", panel); put(&out, "source", source?.rawValue); put(&out, "indicator", indicator); put(&out, "output", output)
        put(&out, "color", color); put(&out, "width", width); put(&out, "visible", visible); put(&out, "label", label)
        return out
    }
}

extension BaroChartDrawingPatch {
    /// 설정한 필드만 담은 코어 editDrawing 패치(nil은 보내지 않아 기존 값 유지)
    var lowLevel: [String: Any] {
        var out: [String: Any] = [:]
        put(&out, "points", points?.map { ["time": $0.time, "price": $0.price] }); put(&out, "panel", panel)
        put(&out, "style", style?.lowLevel); put(&out, "text", text); put(&out, "locked", locked); put(&out, "visible", visible)
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

extension BaroChartPanel {
    var lowLevel: [String: Any] {
        var out: [String: Any] = ["id": id, "weight": weight]
        put(&out, "label", label)
        return out
    }
}

extension BaroChartEngineOptions {
    var lowLevel: [String: Any] {
        var out: [String: Any] = ["panels": panels.map(\.lowLevel), "series": series.map(\.lowLevel)]
        put(&out, "theme", theme?.lowLevel)
        return out
    }
}
