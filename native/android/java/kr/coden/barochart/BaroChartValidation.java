package kr.coden.barochart;

import android.content.Context;

/** Validation-only factory for the repository's physical A/B sample. Do not use as a production backend selector. */
public final class BaroChartValidation {
    private BaroChartValidation() {}

    public static BaroChartEngine create(Context context, EngineOptions options, String backend) {
        final BaroChartEngine.RuntimeBackend selected;
        if ("javascript".equals(backend)) selected = BaroChartEngine.RuntimeBackend.JAVASCRIPT;
        else if ("rust".equals(backend)) selected = BaroChartEngine.RuntimeBackend.RUST;
        else throw new IllegalArgumentException("Unknown validation backend");
        return BaroChartEngine.create(context, options, selected);
    }
}
