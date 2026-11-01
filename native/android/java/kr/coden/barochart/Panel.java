package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.Objects;

/** A vertical chart panel. {@code weight} sets its share of the height relative to other panels. */
public final class Panel {
    /** The panel id. */
    @NonNull public final String id;
    /** Share of the chart height relative to the other panels. */
    public final double weight;
    /** Display label, or {@code null} for none. */
    @Nullable public final String label;

    /**
     * Creates a panel.
     * @param id panel id
     * @param weight share of the chart height relative to the other panels
     * @param label display label, or {@code null} for none
     */
    public Panel(@NonNull String id, double weight, @Nullable String label) { this.id = Objects.requireNonNull(id, "id"); this.weight = weight; this.label = label; }
    /**
     * An unlabeled panel.
     * @param id panel id
     * @param weight share of the chart height relative to the other panels
     */
    public Panel(@NonNull String id, double weight) { this(id, weight, null); }
}
