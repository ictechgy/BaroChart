package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Price adjustment basis of a data source. */
public enum Adjustment {
    /** Prices as traded, with no adjustment. */ RAW("raw"), /** Prices adjusted for stock splits. */ SPLIT("split"), /** Total-return adjusted prices. */ TOTAL_RETURN("total-return");

    private final String wireName;
    Adjustment(String wireName) { this.wireName = wireName; }
    /**
     * The chart core name.
     * @return the adjustment name used by the chart core
     */
    @NonNull public String wireName() { return wireName; }
}
