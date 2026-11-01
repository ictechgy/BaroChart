package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.Objects;

/** A series on a panel. Candles/OHLC read the primary OHLCV; other types read a source column or an indicator output. */
public final class Series {
    @NonNull public final String id, panel;
    @NonNull public final SeriesType type;
    @Nullable public final PriceSource source;
    @Nullable public final String indicator, output, color, label;
    @Nullable public final Double width;
    @Nullable public final Boolean visible;

    private Series(Builder b) {
        id = b.id; type = b.type; panel = b.panel; source = b.source; indicator = b.indicator; output = b.output;
        color = b.color; width = b.width; visible = b.visible; label = b.label;
    }

    /** Starts a series on the {@code price} panel. */
    @NonNull public static Builder builder(@NonNull String id, @NonNull SeriesType type) { return new Builder(id, type); }

    /** Builder for {@link Series}. Unset optional fields use the core defaults. */
    public static final class Builder {
        private final String id; private final SeriesType type;
        private String panel = "price", indicator, output, color, label;
        private PriceSource source; private Double width; private Boolean visible;

        private Builder(String id, SeriesType type) { this.id = Objects.requireNonNull(id, "id"); this.type = Objects.requireNonNull(type, "type"); }
        @NonNull public Builder panel(@NonNull String value) { panel = Objects.requireNonNull(value, "panel"); return this; }
        @NonNull public Builder source(@Nullable PriceSource value) { source = value; return this; }
        /** Binds the series to an indicator id added with {@code addIndicator}. */
        @NonNull public Builder indicator(@Nullable String value) { indicator = value; return this; }
        @NonNull public Builder output(@Nullable String value) { output = value; return this; }
        @NonNull public Builder color(@Nullable String value) { color = value; return this; }
        @NonNull public Builder width(@Nullable Double value) { width = value; return this; }
        @NonNull public Builder visible(@Nullable Boolean value) { visible = value; return this; }
        @NonNull public Builder label(@Nullable String value) { label = value; return this; }
        @NonNull public Series build() { return new Series(this); }
    }
}
