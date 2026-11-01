package kr.coden.barochart;

/** A drawing anchor in data coordinates: UTC epoch milliseconds and price. */
public final class ChartPoint {
    /** {@code time} is UTC epoch milliseconds and {@code price} is the price at that time. */
    public final double time, price;

    /**
     * Creates an anchor point.
     * @param time UTC epoch milliseconds
     * @param price price
     */
    public ChartPoint(double time, double price) { this.time = time; this.price = price; }

    @Override public boolean equals(Object other) {
        return other instanceof ChartPoint && Double.compare(time, ((ChartPoint) other).time) == 0 && Double.compare(price, ((ChartPoint) other).price) == 0;
    }
    @Override public int hashCode() { return 31 * Double.hashCode(time) + Double.hashCode(price); }
}
