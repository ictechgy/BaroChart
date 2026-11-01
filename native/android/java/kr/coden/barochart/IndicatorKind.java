package kr.coden.barochart;

import androidx.annotation.NonNull;

/** The 35 built-in indicators. {@link #wireName()} is the chart core indicator name. */
public enum IndicatorKind {
    SMA("sma"), VWMA("vwma"), EMA("ema"), WMA("wma"), RSI("rsi"), ATR("atr"), MACD("macd"), BOLLINGER("bollinger"),
    DONCHIAN("donchian"), AROON("aroon"), STOCHASTIC("stochastic"), ROC("roc"), WILLIAMS_R("williamsR"), CCI("cci"),
    OBV("obv"), VWAP("vwap"), MFI("mfi"), CMF("cmf"), ADX("adx"), DEMA("dema"), TEMA("tema"), HMA("hma"),
    KELTNER("keltner"), SUPERTREND("supertrend"), ICHIMOKU("ichimoku"), TRIX("trix"), PPO("ppo"), STOCH_RSI("stochRSI"),
    ADL("adl"), CHAIKIN("chaikin"), FORCE_INDEX("forceIndex"), VOLUME_OSCILLATOR("volumeOscillator"), VORTEX("vortex"),
    PIVOTS("pivots"), PARABOLIC_SAR("parabolicSAR");

    private final String wireName;
    IndicatorKind(String wireName) { this.wireName = wireName; }
    /** The chart core name. */
    @NonNull public String wireName() { return wireName; }
}
