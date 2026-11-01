package kr.coden.barochart;

import androidx.annotation.Nullable;

/** Receives the result of {@code restoreWorkspace} once, on the main thread. */
public interface RestoreCallback {
    /** @param error {@code null} on success; otherwise the failure (for example {@code CANCELLED}) */
    void onComplete(@Nullable BaroChartException error);
}
