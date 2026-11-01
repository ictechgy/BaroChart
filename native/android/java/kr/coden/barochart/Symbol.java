package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Objects;

/** Instrument metadata used for price and time formatting. */
public final class Symbol {
    /**
     * {@code id} is the instrument id, {@code exchange} the exchange name, {@code timezone} the IANA time zone name,
     * {@code currency} the currency of the prices and {@code volumeUnit} the unit of the volume (for example {@code
     * shares}).
     */
    @NonNull public final String id, exchange, timezone, currency, volumeUnit;
    /** Number of decimal places used to format prices. */
    public final int priceDecimals;
    /** Minimum price increment. */
    public final double tickSize;
    /** The price adjustment basis. */
    @NonNull public final Adjustment adjustment;

    private Symbol(Builder b) {
        id = b.id; exchange = b.exchange; timezone = b.timezone; currency = b.currency; volumeUnit = b.volumeUnit;
        priceDecimals = b.priceDecimals; tickSize = b.tickSize; adjustment = b.adjustment;
    }

    /**
     * Starts a symbol. {@code timezone} is an IANA name such as {@code Asia/Seoul}.
     * @param id instrument id
     * @param exchange exchange name
     * @param timezone IANA time zone name of the exchange
     * @param currency currency of the prices
     * @param priceDecimals number of decimal places used to format prices
     * @param tickSize minimum price increment
     * @return a builder for the symbol
     */
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
        /**
         * Sets the unit of the volume.
         * @param value the volume unit
         * @return this builder
         */
        @NonNull public Builder volumeUnit(@NonNull String value) { volumeUnit = Objects.requireNonNull(value, "volumeUnit"); return this; }
        /**
         * Sets the price adjustment basis.
         * @param value the adjustment basis
         * @return this builder
         */
        @NonNull public Builder adjustment(@NonNull Adjustment value) { adjustment = Objects.requireNonNull(value, "adjustment"); return this; }
        /**
         * Builds the symbol.
         * @return the symbol
         */
        @NonNull public Symbol build() { return new Symbol(this); }
    }
}
