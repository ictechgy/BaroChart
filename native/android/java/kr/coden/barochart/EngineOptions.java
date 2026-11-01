package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** Initial chart layout for {@code new BaroChartEngine(context, options)}. */
public final class EngineOptions {
    /** The panels to create. */
    @NonNull public final List<Panel> panels;
    /** The series to create. */
    @NonNull public final List<Series> series;
    /** The initial theme, or {@code null} for the core dark theme. */
    @Nullable public final Theme theme;

    /**
     * Creates options. The lists are copied.
     * @param panels the panels to create
     * @param series the series to create
     * @param theme the initial theme, or {@code null} for the core dark theme
     */
    public EngineOptions(@NonNull List<Panel> panels, @NonNull List<Series> series, @Nullable Theme theme) {
        this.panels = Collections.unmodifiableList(new ArrayList<>(Objects.requireNonNull(panels, "panels")));
        this.series = Collections.unmodifiableList(new ArrayList<>(Objects.requireNonNull(series, "series")));
        this.theme = theme;
    }

    /**
     * One unlabeled {@code price} panel with a {@code price} candlestick series and the core dark theme.
     * @return the default options
     */
    @NonNull public static EngineOptions defaults() {
        return new EngineOptions(Collections.singletonList(new Panel("price", 3)), Collections.singletonList(Series.builder("price", SeriesType.CANDLES).build()), null);
    }
}
