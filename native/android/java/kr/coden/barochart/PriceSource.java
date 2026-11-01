package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Primary-series column read by a general series. */
public enum PriceSource {
    /** Opening prices. */ OPEN("open"), /** Highest prices. */ HIGH("high"), /** Lowest prices. */ LOW("low"), /** Closing prices. */ CLOSE("close"), /** Traded volumes. */ VOLUME("volume");

    private final String wireName;
    PriceSource(String wireName) { this.wireName = wireName; }
    /**
     * The chart core name.
     * @return the column name used by the chart core
     */
    @NonNull public String wireName() { return wireName; }
}
