package kr.coden.barochart;

import androidx.annotation.Nullable;

/** An indicator value read at a bar index. {@code null} fields mean the value is not available yet. */
public final class IndicatorValue {
    /**
     * {@code value} is the indicator output. {@code sourceTime} is the UTC epoch milliseconds of the source bar the
     * value comes from, which can differ from the queried bar for indicators plotted with an offset. Both are {@code
     * null} when not available.
     */
    @Nullable public final Double value, sourceTime;
    /** Bar index of the source bar the value comes from, or {@code null} when not available. */
    @Nullable public final Integer sourceIndex;

    /**
     * Creates an indicator value.
     * @param value indicator output, or {@code null} when not available
     * @param sourceIndex source bar index, or {@code null}
     * @param sourceTime source bar time in UTC epoch milliseconds, or {@code null}
     */
    public IndicatorValue(@Nullable Double value, @Nullable Integer sourceIndex, @Nullable Double sourceTime) {
        this.value = value; this.sourceIndex = sourceIndex; this.sourceTime = sourceTime;
    }
}
