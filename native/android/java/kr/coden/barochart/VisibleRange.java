package kr.coden.barochart;

/** Visible range in bar-index coordinates (the chart core view range). */
public final class VisibleRange {
    /**
     * {@code from} and {@code to} are the edges of the visible range in bar-index coordinates; {@code to} is greater
     * than {@code from}.
     */
    public final double from, to;

    /**
     * Creates a range.
     * @param from first visible position, in bar-index coordinates
     * @param to last visible position, in bar-index coordinates; greater than {@code from}
     */
    public VisibleRange(double from, double to) { this.from = from; this.to = to; }

    @Override public boolean equals(Object other) {
        return other instanceof VisibleRange && Double.compare(from, ((VisibleRange) other).from) == 0 && Double.compare(to, ((VisibleRange) other).to) == 0;
    }
    @Override public int hashCode() { return 31 * Double.hashCode(from) + Double.hashCode(to); }
}
