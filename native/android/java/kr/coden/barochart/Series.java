package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.Objects;

/** A series on a panel. Candles/OHLC read the primary OHLCV; other types read a source column or an indicator output. */
public final class Series {
    /** The series id and the id of the panel it is drawn on. */
    @NonNull public final String id, panel;
    /** The series renderer. */
    @NonNull public final SeriesType type;
    /** The primary-series column a general series reads, or {@code null}. */
    @Nullable public final PriceSource source;
    /**
     * {@code indicator} is the id of the indicator the series is bound to, {@code output} the indicator output it
     * plots, {@code color} the CSS hex line color and {@code label} the display label. Each is {@code null} when
     * unset, which uses the core default.
     */
    @Nullable public final String indicator, output, color, label;
    /** Line width, or {@code null} for the core default. */
    @Nullable public final Double width;
    /** Whether the series is visible, or {@code null} for the core default. */
    @Nullable public final Boolean visible;

    private Series(Builder b) {
        id = b.id; type = b.type; panel = b.panel; source = b.source; indicator = b.indicator; output = b.output;
        color = b.color; width = b.width; visible = b.visible; label = b.label;
    }

    /**
     * Starts a series on the {@code price} panel.
     * @param id series id
     * @param type series renderer
     * @return a builder for the series
     */
    @NonNull public static Builder builder(@NonNull String id, @NonNull SeriesType type) { return new Builder(id, type); }

    /** Builder for {@link Series}. Unset optional fields use the core defaults. */
    public static final class Builder {
        private final String id; private final SeriesType type;
        private String panel = "price", indicator, output, color, label;
        private PriceSource source; private Double width; private Boolean visible;

        private Builder(String id, SeriesType type) { this.id = Objects.requireNonNull(id, "id"); this.type = Objects.requireNonNull(type, "type"); }
        /**
         * Sets the panel the series is drawn on.
         * @param value panel id
         * @return this builder
         */
        @NonNull public Builder panel(@NonNull String value) { panel = Objects.requireNonNull(value, "panel"); return this; }
        /**
         * Sets the primary-series column a general series reads.
         * @param value the column, or {@code null}
         * @return this builder
         */
        @NonNull public Builder source(@Nullable PriceSource value) { source = value; return this; }
        /**
         * Binds the series to an indicator id added with {@code addIndicator}.
         * @param value the indicator id, or {@code null}
         * @return this builder
         */
        @NonNull public Builder indicator(@Nullable String value) { indicator = value; return this; }
        /**
         * Sets the indicator output the series plots.
         * @param value the output name, or {@code null}
         * @return this builder
         */
        @NonNull public Builder output(@Nullable String value) { output = value; return this; }
        /**
         * Sets the line color.
         * @param value a CSS hex color, or {@code null} for the core default
         * @return this builder
         */
        @NonNull public Builder color(@Nullable String value) { color = value; return this; }
        /**
         * Sets the line width.
         * @param value the width, or {@code null} for the core default
         * @return this builder
         */
        @NonNull public Builder width(@Nullable Double value) { width = value; return this; }
        /**
         * Sets whether the series is visible.
         * @param value the visibility, or {@code null} for the core default
         * @return this builder
         */
        @NonNull public Builder visible(@Nullable Boolean value) { visible = value; return this; }
        /**
         * Sets the display label.
         * @param value the label, or {@code null} for the core default
         * @return this builder
         */
        @NonNull public Builder label(@Nullable String value) { label = value; return this; }
        /**
         * Builds the series.
         * @return the series
         */
        @NonNull public Series build() { return new Series(this); }
    }
}
