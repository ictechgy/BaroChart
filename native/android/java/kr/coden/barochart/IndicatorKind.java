package kr.coden.barochart;

import androidx.annotation.NonNull;

/** The 35 built-in indicators. {@link #wireName()} is the chart core indicator name. */
public enum IndicatorKind {
    /** Simple moving average. */ SMA("sma"), /** Volume-weighted moving average. */ VWMA("vwma"), /** Exponential moving average. */ EMA("ema"), /** Weighted moving average. */ WMA("wma"), /** Relative strength index. */ RSI("rsi"), /** Average true range. */ ATR("atr"), /** Moving average convergence divergence. */ MACD("macd"), /** Bollinger Bands. */ BOLLINGER("bollinger"),
    /** Donchian channel. */ DONCHIAN("donchian"), /** Aroon. */ AROON("aroon"), /** Stochastic oscillator. */ STOCHASTIC("stochastic"), /** Rate of change. */ ROC("roc"), /** Williams %R. */ WILLIAMS_R("williamsR"), /** Commodity channel index. */ CCI("cci"),
    /** On-balance volume. */ OBV("obv"), /** Volume-weighted average price. */ VWAP("vwap"), /** Money flow index. */ MFI("mfi"), /** Chaikin money flow. */ CMF("cmf"), /** Average directional index. */ ADX("adx"), /** Double exponential moving average. */ DEMA("dema"), /** Triple exponential moving average. */ TEMA("tema"), /** Hull moving average. */ HMA("hma"),
    /** Keltner channel. */ KELTNER("keltner"), /** Supertrend. */ SUPERTREND("supertrend"), /** Ichimoku cloud. */ ICHIMOKU("ichimoku"), /** Triple exponential average rate of change. */ TRIX("trix"), /** Percentage price oscillator. */ PPO("ppo"), /** Stochastic RSI. */ STOCH_RSI("stochRSI"),
    /** Accumulation/distribution line. */ ADL("adl"), /** Chaikin oscillator. */ CHAIKIN("chaikin"), /** Force index. */ FORCE_INDEX("forceIndex"), /** Volume oscillator. */ VOLUME_OSCILLATOR("volumeOscillator"), /** Vortex indicator. */ VORTEX("vortex"),
    /** Classic pivot points. */ PIVOTS("pivots"), /** Parabolic SAR. */ PARABOLIC_SAR("parabolicSAR");

    private final String wireName;
    IndicatorKind(String wireName) { this.wireName = wireName; }
    /**
     * The chart core name.
     * @return the indicator name used by the chart core
     */
    @NonNull public String wireName() { return wireName; }
}
