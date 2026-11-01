package kr.coden.barochart;

import androidx.annotation.NonNull;

/** Drawing tools. {@link #SELECT} picks and edits existing drawings; the others create drawings. */
public enum DrawingTool {
    /** Picks and edits existing drawings; creates nothing. */ SELECT("select"), /** Trend line between two points. */ TRENDLINE("trendline"), /** Horizontal price line. */ HORIZONTAL("horizontal"), /** Fibonacci retracement. */ FIBONACCI("fibonacci"), /** Rectangle. */ RECTANGLE("rectangle"),
    /** Ellipse. */ ELLIPSE("ellipse"), /** Text label. */ TEXT("text"), /** Ray from one point through another. */ RAY("ray"), /** Line through two points, extended in both directions. */ EXTENDED_LINE("extendedline"), /** Channel of parallel lines. */ CHANNEL("channel"),
    /** Fibonacci extension. */ FIB_EXTENSION("fibextension"), /** Fibonacci fan. */ FIB_FAN("fibfan"), /** Fibonacci time zones. */ FIB_TIME_ZONES("fibtimezones"), /** Freehand stroke. */ FREEHAND("freehand"),
    /** Measures the distance between two points. */ MEASUREMENT("measurement"), /** Long position annotation showing entry, stop and target. */ LONG_POSITION("longposition"), /** Short position annotation showing entry, stop and target. */ SHORT_POSITION("shortposition");

    private final String wireName;
    DrawingTool(String wireName) { this.wireName = wireName; }
    /**
     * The chart core name.
     * @return the tool name used by the chart core
     */
    @NonNull public String wireName() { return wireName; }
}
