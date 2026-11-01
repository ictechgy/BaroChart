package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Objects;

/** The host's assertion of which dataset a saved workspace belongs to. Restores reject a different binding. */
public final class DatasetBinding {
    @NonNull public final String key, revision, adjustmentVersion, priceUnit;
    @NonNull public final Adjustment adjustment;

    public DatasetBinding(@NonNull String key, @NonNull String revision, @NonNull String adjustmentVersion, @NonNull String priceUnit, @NonNull Adjustment adjustment) {
        this.key = Objects.requireNonNull(key, "key"); this.revision = Objects.requireNonNull(revision, "revision");
        this.adjustmentVersion = Objects.requireNonNull(adjustmentVersion, "adjustmentVersion");
        this.priceUnit = Objects.requireNonNull(priceUnit, "priceUnit"); this.adjustment = Objects.requireNonNull(adjustment, "adjustment");
    }
}
