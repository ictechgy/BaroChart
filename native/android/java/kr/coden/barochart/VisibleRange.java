package kr.coden.barochart;

/** Visible range in bar-index coordinates (the chart core view range). */
public final class VisibleRange {
    public final double from, to;

    public VisibleRange(double from, double to) { this.from = from; this.to = to; }

    @Override public boolean equals(Object other) {
        return other instanceof VisibleRange && Double.compare(from, ((VisibleRange) other).from) == 0 && Double.compare(to, ((VisibleRange) other).to) == 0;
    }
    @Override public int hashCode() { return 31 * Double.hashCode(from) + Double.hashCode(to); }
}
