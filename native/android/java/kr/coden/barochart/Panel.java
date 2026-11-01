package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.Objects;

/** A vertical chart panel. {@code weight} sets its share of the height relative to other panels. */
public final class Panel {
    @NonNull public final String id;
    public final double weight;
    @Nullable public final String label;

    public Panel(@NonNull String id, double weight, @Nullable String label) { this.id = Objects.requireNonNull(id, "id"); this.weight = weight; this.label = label; }
    /** An unlabeled panel. */
    public Panel(@NonNull String id, double weight) { this(id, weight, null); }
}
