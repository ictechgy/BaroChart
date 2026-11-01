package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** A streaming or correction event applied to the primary OHLCV series. Create one with the static factories. */
public final class DataEvent {
    /** Event kinds, matching the chart core. */
    public enum Kind { RESET, APPEND, UPDATE, CORRECTION, PREPEND, BATCH }

    @NonNull public final Kind kind;
    /** The bar for APPEND, UPDATE and CORRECTION; {@code null} otherwise. */
    @Nullable public final Bar bar;
    /** Bars for RESET and PREPEND; empty otherwise. */
    @NonNull public final List<Bar> bars;
    /** Events for BATCH; empty otherwise. */
    @NonNull public final List<DataEvent> events;

    private DataEvent(Kind kind, Bar bar, List<Bar> bars, List<DataEvent> events) {
        this.kind = kind; this.bar = bar;
        this.bars = Collections.unmodifiableList(new ArrayList<>(bars));
        this.events = Collections.unmodifiableList(new ArrayList<>(events));
    }

    /** Replaces every bar. */
    @NonNull public static DataEvent reset(@NonNull List<Bar> bars) { return new DataEvent(Kind.RESET, null, Objects.requireNonNull(bars, "bars"), Collections.<DataEvent>emptyList()); }
    /** Adds a bar later than the last bar. */
    @NonNull public static DataEvent append(@NonNull Bar bar) { return single(Kind.APPEND, bar); }
    /** Replaces the current (last) bar; its time must equal the last bar's time. */
    @NonNull public static DataEvent update(@NonNull Bar bar) { return single(Kind.UPDATE, bar); }
    /** Replaces an existing bar with the same time. */
    @NonNull public static DataEvent correction(@NonNull Bar bar) { return single(Kind.CORRECTION, bar); }
    /** Adds older bars before the first bar. */
    @NonNull public static DataEvent prepend(@NonNull List<Bar> bars) { return new DataEvent(Kind.PREPEND, null, Objects.requireNonNull(bars, "bars"), Collections.<DataEvent>emptyList()); }
    /** Applies events in order as one batch. */
    @NonNull public static DataEvent batch(@NonNull List<DataEvent> events) { return new DataEvent(Kind.BATCH, null, Collections.<Bar>emptyList(), Objects.requireNonNull(events, "events")); }

    private static DataEvent single(Kind kind, Bar bar) { return new DataEvent(kind, Objects.requireNonNull(bar, "bar"), Collections.<Bar>emptyList(), Collections.<DataEvent>emptyList()); }
}
