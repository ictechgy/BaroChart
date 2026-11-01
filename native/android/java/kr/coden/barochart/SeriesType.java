package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Series renderers supported by the chart core. */
public enum SeriesType {
    /** Candlesticks. */ CANDLES("candles"), /** OHLC bars. */ OHLC("ohlc"), /** Line. */ LINE("line"), /** Filled area. */ AREA("area"), /** Histogram bars, for example volume. */ HISTOGRAM("histogram");

    private final String wireName;
    SeriesType(String wireName) { this.wireName = wireName; }
    /**
     * The chart core name.
     * @return the renderer name used by the chart core
     */
    @NonNull public String wireName() { return wireName; }
}
