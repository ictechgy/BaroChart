package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** An indicator definition: kind plus parameters. Omitted parameters use the chart core defaults. */
public final class Indicator {
    @NonNull public final IndicatorKind kind;
    @NonNull public final Map<String, ParamValue> params;

    public Indicator(@NonNull IndicatorKind kind, @NonNull Map<String, ParamValue> params) {
        this.kind = Objects.requireNonNull(kind, "kind");
        this.params = Collections.unmodifiableMap(new LinkedHashMap<>(Objects.requireNonNull(params, "params")));
    }

    /** An indicator with core default parameters. */
    public Indicator(@NonNull IndicatorKind kind) { this(kind, Collections.<String, ParamValue>emptyMap()); }

    /** Simple moving average. */
    @NonNull public static Indicator sma(int period) { return period(IndicatorKind.SMA, period); }
    /** Exponential moving average. */
    @NonNull public static Indicator ema(int period) { return period(IndicatorKind.EMA, period); }
    /** Relative strength index. */
    @NonNull public static Indicator rsi(int period) { return period(IndicatorKind.RSI, period); }

    /** MACD with fast, slow and signal periods. */
    @NonNull public static Indicator macd(int fast, int slow, int signal) {
        Map<String, ParamValue> params = new LinkedHashMap<>();
        params.put("fast", ParamValue.number(fast)); params.put("slow", ParamValue.number(slow)); params.put("signal", ParamValue.number(signal));
        return new Indicator(IndicatorKind.MACD, params);
    }

    /** Bollinger Bands; {@code deviation} is the standard-deviation multiplier. */
    @NonNull public static Indicator bollinger(int period, double deviation) {
        Map<String, ParamValue> params = new LinkedHashMap<>();
        params.put("period", ParamValue.number(period)); params.put("deviation", ParamValue.number(deviation));
        return new Indicator(IndicatorKind.BOLLINGER, params);
    }

    /** Session VWAP with core defaults. */
    @NonNull public static Indicator vwap() { return new Indicator(IndicatorKind.VWAP); }

    private static Indicator period(IndicatorKind kind, int period) {
        return new Indicator(kind, Collections.singletonMap("period", ParamValue.number(period)));
    }
}
