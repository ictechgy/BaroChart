package kr.coden.barochart;

/** A drawing anchor in data coordinates: UTC epoch milliseconds and price. */
public final class ChartPoint {
    public final double time, price;

    public ChartPoint(double time, double price) { this.time = time; this.price = price; }

    @Override public boolean equals(Object other) {
        return other instanceof ChartPoint && Double.compare(time, ((ChartPoint) other).time) == 0 && Double.compare(price, ((ChartPoint) other).price) == 0;
    }
    @Override public int hashCode() { return 31 * Double.hashCode(time) + Double.hashCode(price); }
}
