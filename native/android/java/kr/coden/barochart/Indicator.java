package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** An indicator definition: kind plus parameters. Omitted parameters use the chart core defaults. */
public final class Indicator {
    /** The indicator kind. */
    @NonNull public final IndicatorKind kind;
    /** Parameter values by core parameter name (unmodifiable). */
    @NonNull public final Map<String, ParamValue> params;

    /**
     * Creates an indicator definition. The map is copied.
     * @param kind the indicator kind
     * @param params parameter values by core parameter name; omitted parameters use the core defaults
     */
    public Indicator(@NonNull IndicatorKind kind, @NonNull Map<String, ParamValue> params) {
        this.kind = Objects.requireNonNull(kind, "kind");
        this.params = Collections.unmodifiableMap(new LinkedHashMap<>(Objects.requireNonNull(params, "params")));
    }

    /**
     * An indicator with core default parameters.
     * @param kind the indicator kind
     */
    public Indicator(@NonNull IndicatorKind kind) { this(kind, Collections.<String, ParamValue>emptyMap()); }

    /**
     * Simple moving average.
     * @param period number of bars in the averaging window
     * @return the indicator definition
     */
    @NonNull public static Indicator sma(int period) { return period(IndicatorKind.SMA, period); }
    /**
     * Exponential moving average.
     * @param period number of bars in the averaging window
     * @return the indicator definition
     */
    @NonNull public static Indicator ema(int period) { return period(IndicatorKind.EMA, period); }
    /**
     * Relative strength index.
     * @param period number of bars in the lookback window
     * @return the indicator definition
     */
    @NonNull public static Indicator rsi(int period) { return period(IndicatorKind.RSI, period); }

    /**
     * MACD with fast, slow and signal periods.
     * @param fast fast period
     * @param slow slow period
     * @param signal signal period
     * @return the indicator definition
     */
    @NonNull public static Indicator macd(int fast, int slow, int signal) {
        Map<String, ParamValue> params = new LinkedHashMap<>();
        params.put("fast", ParamValue.number(fast)); params.put("slow", ParamValue.number(slow)); params.put("signal", ParamValue.number(signal));
        return new Indicator(IndicatorKind.MACD, params);
    }

    /**
     * Bollinger Bands; {@code deviation} is the standard-deviation multiplier.
     * @param period number of bars in the averaging window
     * @param deviation standard-deviation multiplier for the bands
     * @return the indicator definition
     */
    @NonNull public static Indicator bollinger(int period, double deviation) {
        Map<String, ParamValue> params = new LinkedHashMap<>();
        params.put("period", ParamValue.number(period)); params.put("deviation", ParamValue.number(deviation));
        return new Indicator(IndicatorKind.BOLLINGER, params);
    }

    /**
     * Session VWAP with core defaults.
     * @return the indicator definition
     */
    @NonNull public static Indicator vwap() { return new Indicator(IndicatorKind.VWAP); }

    private static Indicator period(IndicatorKind kind, int period) {
        return new Indicator(kind, Collections.singletonMap("period", ParamValue.number(period)));
    }
}
