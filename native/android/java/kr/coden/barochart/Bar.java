package kr.coden.barochart;

/** One OHLCV bar. {@code time} is UTC epoch milliseconds. */
public final class Bar {
    public final double time, open, high, low, close, volume;

    public Bar(double time, double open, double high, double low, double close, double volume) {
        this.time = time; this.open = open; this.high = high; this.low = low; this.close = close; this.volume = volume;
    }

    @Override public boolean equals(Object other) {
        if (!(other instanceof Bar)) return false;
        Bar o = (Bar) other;
        return Double.compare(time, o.time) == 0 && Double.compare(open, o.open) == 0 && Double.compare(high, o.high) == 0
            && Double.compare(low, o.low) == 0 && Double.compare(close, o.close) == 0 && Double.compare(volume, o.volume) == 0;
    }

    @Override public int hashCode() { return java.util.Arrays.hashCode(new double[]{time, open, high, low, close, volume}); }

    @Override public String toString() { return "Bar(time=" + time + ", open=" + open + ", high=" + high + ", low=" + low + ", close=" + close + ", volume=" + volume + ")"; }
}
