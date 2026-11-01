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
        /** The series {@code id}, its display {@code label} and the id of the {@code panel} it is drawn on. */
        @NonNull public final String id, label, panel;
        /** The series value at the crosshair, or {@code null} when it is not available. */
        @Nullable public final Double value;
        /**
         * Creates a series value.
         * @param id series id
         * @param label display label
         * @param panel id of the panel the series is drawn on
         * @param value value at the crosshair, or {@code null} when not available
         */
        public SeriesValue(@NonNull String id, @NonNull String label, @NonNull String panel, @Nullable Double value) { this.id = id; this.label = label; this.panel = panel; this.value = value; }
    }

    /** Bar index under the crosshair. */
    public final int index;
    /** Time under the crosshair, UTC epoch milliseconds. */
    public final double time;
    /** The primary-series bar under the crosshair, or {@code null} when there is none. */
    @Nullable public final Bar bar;
    /** Visible series values at the crosshair (unmodifiable). */
    @NonNull public final List<SeriesValue> series;

    /**
     * Creates crosshair values. The series list is copied.
     * @param index bar index under the crosshair
     * @param time time under the crosshair, UTC epoch milliseconds
     * @param bar primary-series bar, or {@code null}
     * @param series visible series values
     */
    public CrosshairValues(int index, double time, @Nullable Bar bar, @NonNull List<SeriesValue> series) {
        this.index = index; this.time = time; this.bar = bar; this.series = Collections.unmodifiableList(new ArrayList<>(series));
    }
}
