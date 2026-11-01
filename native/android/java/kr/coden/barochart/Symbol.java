package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Objects;

/** Instrument metadata used for price and time formatting. */
public final class Symbol {
    @NonNull public final String id, exchange, timezone, currency, volumeUnit;
    public final int priceDecimals;
    public final double tickSize;
    @NonNull public final Adjustment adjustment;

    private Symbol(Builder b) {
        id = b.id; exchange = b.exchange; timezone = b.timezone; currency = b.currency; volumeUnit = b.volumeUnit;
        priceDecimals = b.priceDecimals; tickSize = b.tickSize; adjustment = b.adjustment;
    }

    /** Starts a symbol. {@code timezone} is an IANA name such as {@code Asia/Seoul}. */
    @NonNull public static Builder builder(@NonNull String id, @NonNull String exchange, @NonNull String timezone, @NonNull String currency, int priceDecimals, double tickSize) {
        return new Builder(id, exchange, timezone, currency, priceDecimals, tickSize);
    }

    /** Builder for {@link Symbol}. Defaults: volume unit {@code shares}, adjustment {@link Adjustment#RAW}. */
    public static final class Builder {
        private final String id, exchange, timezone, currency; private final int priceDecimals; private final double tickSize;
        private String volumeUnit = "shares"; private Adjustment adjustment = Adjustment.RAW;

        private Builder(String id, String exchange, String timezone, String currency, int priceDecimals, double tickSize) {
            this.id = Objects.requireNonNull(id, "id"); this.exchange = Objects.requireNonNull(exchange, "exchange");
            this.timezone = Objects.requireNonNull(timezone, "timezone"); this.currency = Objects.requireNonNull(currency, "currency");
            this.priceDecimals = priceDecimals; this.tickSize = tickSize;
        }
        @NonNull public Builder volumeUnit(@NonNull String value) { volumeUnit = Objects.requireNonNull(value, "volumeUnit"); return this; }
        @NonNull public Builder adjustment(@NonNull Adjustment value) { adjustment = Objects.requireNonNull(value, "adjustment"); return this; }
        @NonNull public Symbol build() { return new Symbol(this); }
    }
}
