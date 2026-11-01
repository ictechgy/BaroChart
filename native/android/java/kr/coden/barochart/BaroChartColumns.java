package kr.coden.barochart;

/** Immutable snapshot of six caller arrays. No owned array reference escapes.
 * copyOf copies on its calling thread; construct off UI for large inputs.
 * Shape is checked here; OHLCV/time/finite validation runs in prepare worker.
 * Caller must not mutate source arrays concurrently with copyOf itself.
 */
public final class BaroChartColumns {
    /** Maximum number of bars a snapshot can hold: 4,194,304. */
    public static final int MAX_BARS=4194304;
    private final double[][] columns;
    private final int length;
    private final long copyNanos;
    private BaroChartColumns(double[][] input){long start=System.nanoTime();if(input[0]==null)throw new IllegalArgumentException("Six columns required");length=input[0].length;if(length>MAX_BARS)throw new IllegalArgumentException("Column length limit");for(double[] c:input)if(c==null||c.length!=length)throw new IllegalArgumentException("Equal column lengths required");columns=new double[6][];for(int i=0;i<6;i++)columns[i]=input[i].clone();copyNanos=System.nanoTime()-start;}
    /**
     * Copies six equal-length arrays into an immutable snapshot. The arrays are read once, on the calling thread, and
     * are not retained.
     * @param time bar times, UTC epoch milliseconds
     * @param open opening prices
     * @param high highest prices
     * @param low lowest prices
     * @param close closing prices
     * @param volume traded volumes
     * @return a snapshot that owns its own copy of the data
     * @throws IllegalArgumentException if an array is {@code null}, the lengths differ or the length exceeds {@link
     *     #MAX_BARS}
     */
    public static BaroChartColumns copyOf(double[] time,double[] open,double[] high,double[] low,double[] close,double[] volume){return new BaroChartColumns(new double[][]{time,open,high,low,close,volume});}
    /**
     * Returns the number of bars in the snapshot.
     * @return the bar count
     */
    public int length(){return length;}
    /**
     * Returns the memory owned by the snapshot, estimated as 48 bytes per bar (six doubles).
     * @return the owned size in bytes
     */
    public long ownedBytes(){return length*48L;}
    /**
     * Returns how long the source arrays took to copy.
     * @return the copy time in milliseconds
     */
    public double copyMillis(){return copyNanos/1e6;}
    private static native void writeSlice(long target,int slot,int offset,int count,double[] values);
    void copyInto(long target,int slot,int offset,int count){if(slot<0||slot>=6||offset<0||count<1||count>262144||(long)offset+count>length)throw new IllegalArgumentException("Owned column slice bounds");writeSlice(target,slot,offset,count,columns[slot]);}
}
