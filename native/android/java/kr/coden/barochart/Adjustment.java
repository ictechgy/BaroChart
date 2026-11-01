package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Price adjustment basis of a data source. */
public enum Adjustment {
    RAW("raw"), SPLIT("split"), TOTAL_RETURN("total-return");

    private final String wireName;
    Adjustment(String wireName) { this.wireName = wireName; }
    /** The chart core name. */
    @NonNull public String wireName() { return wireName; }
}
