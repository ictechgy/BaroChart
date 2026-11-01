package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.Objects;

/**
 * The fields to change on an existing series, for {@link BaroChartEngine#updateSeries(String, SeriesPatch)}.
 *
 * <p>Only the fields set on the builder are sent; every unset field keeps its current value. For example a patch with
 * only {@code color} recolors an RSI line without moving it off its {@code rsi} panel. The series id and type cannot
 * change. Matches the Swift {@code BaroChartSeriesPatch}.</p>
 *
 * <pre>{@code
 * engine.updateSeries("rsi14-line", SeriesPatch.builder().color("#f0b755").build());
 * }</pre>
 */
public final class SeriesPatch {
    /** The new panel id, or {@code null} to keep the current panel. */
    @Nullable public final String panel;
    /** The new primary-series column, or {@code null} to keep the current one. */
    @Nullable public final PriceSource source;
    /**
     * {@code indicator} is the new bound indicator id, {@code output} the new indicator output, {@code color} the new
     * CSS hex line color and {@code label} the new display label. Each is {@code null} to keep the current value.
     */
    @Nullable public final String indicator, output, color, label;
    /** The new line width, or {@code null} to keep the current width. */
    @Nullable public final Double width;
    /** The new visibility, or {@code null} to keep the current visibility. */
    @Nullable public final Boolean visible;

    private SeriesPatch(Builder b) {
        panel = b.panel; source = b.source; indicator = b.indicator; output = b.output;
        color = b.color; width = b.width; visible = b.visible; label = b.label;
    }

    /**
     * Starts an empty patch; an empty patch changes nothing.
     * @return a builder with no fields set
     */
    @NonNull public static Builder builder() { return new Builder(); }

    /** Builder for {@link SeriesPatch}. Each setter marks its field as changed. */
    public static final class Builder {
        private String panel, indicator, output, color, label;
        private PriceSource source; private Double width; private Boolean visible;

        private Builder() {}
        /**
         * Moves the series to another panel.
         * @param value panel id
         * @return this builder
         */
        @NonNull public Builder panel(@NonNull String value) { panel = Objects.requireNonNull(value, "panel"); return this; }
        /**
         * Changes the primary-series column a general series reads.
         * @param value the column
         * @return this builder
         */
        @NonNull public Builder source(@NonNull PriceSource value) { source = Objects.requireNonNull(value, "source"); return this; }
        /**
         * Binds the series to another indicator id added with {@code addIndicator}.
         * @param value the indicator id
         * @return this builder
         */
        @NonNull public Builder indicator(@NonNull String value) { indicator = Objects.requireNonNull(value, "indicator"); return this; }
        /**
         * Changes the indicator output the series plots.
         * @param value the output name
         * @return this builder
         */
        @NonNull public Builder output(@NonNull String value) { output = Objects.requireNonNull(value, "output"); return this; }
        /**
         * Changes the line color.
         * @param value a CSS hex color such as {@code #f0b755}
         * @return this builder
         */
        @NonNull public Builder color(@NonNull String value) { color = Objects.requireNonNull(value, "color"); return this; }
        /**
         * Changes the line width.
         * @param value the width; the core accepts values above 0 and up to 50
         * @return this builder
         */
        @NonNull public Builder width(double value) { width = value; return this; }
        /**
         * Shows or hides the series.
         * @param value true to show the series, false to hide it
         * @return this builder
         */
        @NonNull public Builder visible(boolean value) { visible = value; return this; }
        /**
         * Changes the display label.
         * @param value the label, at most 256 characters
         * @return this builder
         */
        @NonNull public Builder label(@NonNull String value) { label = Objects.requireNonNull(value, "label"); return this; }
        /**
         * Builds the patch.
         * @return the patch
         */
        @NonNull public SeriesPatch build() { return new SeriesPatch(this); }
    }
}
