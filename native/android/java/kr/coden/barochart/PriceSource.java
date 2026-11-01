package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Primary-series column read by a general series. */
public enum PriceSource {
    OPEN("open"), HIGH("high"), LOW("low"), CLOSE("close"), VOLUME("volume");

    private final String wireName;
    PriceSource(String wireName) { this.wireName = wireName; }
    /** The chart core name. */
    @NonNull public String wireName() { return wireName; }
}
