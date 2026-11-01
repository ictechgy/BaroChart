package kr.coden.barochart;

/**
 * Receives failures that a chart view cannot throw to the caller, such as drawing, touch input,
 * accessibility actions and font-scale updates. Called on the main thread.
 */
public interface OnChartErrorListener {
    /** @param error the failure, already converted to the common BaroChart error type */
    void onChartError(BaroChartException error);
}
