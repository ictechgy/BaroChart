package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Series renderers supported by the chart core. */
public enum SeriesType {
    CANDLES("candles"), OHLC("ohlc"), LINE("line"), AREA("area"), HISTOGRAM("histogram");

    private final String wireName;
    SeriesType(String wireName) { this.wireName = wireName; }
    /** The chart core name. */
    @NonNull public String wireName() { return wireName; }
}
