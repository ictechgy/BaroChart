package kr.coden.barochart;

import androidx.annotation.Nullable;

/** An indicator value read at a bar index. {@code null} fields mean the value is not available yet. */
public final class IndicatorValue {
    @Nullable public final Double value, sourceTime;
    @Nullable public final Integer sourceIndex;

    public IndicatorValue(@Nullable Double value, @Nullable Integer sourceIndex, @Nullable Double sourceTime) {
        this.value = value; this.sourceIndex = sourceIndex; this.sourceTime = sourceTime;
    }
}
