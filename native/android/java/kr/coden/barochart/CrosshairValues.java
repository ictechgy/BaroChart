package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Values under the crosshair. */
public final class CrosshairValues {
    /** One visible series value at the crosshair. */
    public static final class SeriesValue {
        @NonNull public final String id, label, panel;
        @Nullable public final Double value;
        public SeriesValue(@NonNull String id, @NonNull String label, @NonNull String panel, @Nullable Double value) { this.id = id; this.label = label; this.panel = panel; this.value = value; }
    }

    public final int index;
    public final double time;
    @Nullable public final Bar bar;
    @NonNull public final List<SeriesValue> series;

    public CrosshairValues(int index, double time, @Nullable Bar bar, @NonNull List<SeriesValue> series) {
        this.index = index; this.time = time; this.bar = bar; this.series = Collections.unmodifiableList(new ArrayList<>(series));
    }
}
