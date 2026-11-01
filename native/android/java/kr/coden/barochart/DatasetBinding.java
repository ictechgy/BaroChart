package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Objects;

/** The host's assertion of which dataset a saved workspace belongs to. Restores reject a different binding. */
public final class DatasetBinding {
    /**
     * Host-defined strings that identify the dataset: {@code key} names it (for example symbol and interval), {@code
     * revision} is its data revision, {@code adjustmentVersion} versions its price adjustment and {@code priceUnit}
     * is the unit of its prices (for example a currency code).
     */
    @NonNull public final String key, revision, adjustmentVersion, priceUnit;
    /** The price adjustment basis of the dataset. */
    @NonNull public final Adjustment adjustment;

    /**
     * Creates a binding.
     * @param key dataset key
     * @param revision dataset revision
     * @param adjustmentVersion version of the price adjustment
     * @param priceUnit unit of the prices
     * @param adjustment price adjustment basis
     */
    public DatasetBinding(@NonNull String key, @NonNull String revision, @NonNull String adjustmentVersion, @NonNull String priceUnit, @NonNull Adjustment adjustment) {
        this.key = Objects.requireNonNull(key, "key"); this.revision = Objects.requireNonNull(revision, "revision");
        this.adjustmentVersion = Objects.requireNonNull(adjustmentVersion, "adjustmentVersion");
        this.priceUnit = Objects.requireNonNull(priceUnit, "priceUnit"); this.adjustment = Objects.requireNonNull(adjustment, "adjustment");
    }
}
