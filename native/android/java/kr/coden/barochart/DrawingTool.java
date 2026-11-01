package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Drawing tools. {@link #SELECT} picks and edits existing drawings; the others create drawings. */
public enum DrawingTool {
    SELECT("select"), TRENDLINE("trendline"), HORIZONTAL("horizontal"), FIBONACCI("fibonacci"), RECTANGLE("rectangle"),
    ELLIPSE("ellipse"), TEXT("text"), RAY("ray"), EXTENDED_LINE("extendedline"), CHANNEL("channel"),
    FIB_EXTENSION("fibextension"), FIB_FAN("fibfan"), FIB_TIME_ZONES("fibtimezones"), FREEHAND("freehand"),
    MEASUREMENT("measurement"), LONG_POSITION("longposition"), SHORT_POSITION("shortposition");

    private final String wireName;
    DrawingTool(String wireName) { this.wireName = wireName; }
    /** The chart core name. */
    @NonNull public String wireName() { return wireName; }
}
