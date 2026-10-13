package dev.aster.charts;

/** Immutable snapshot of six caller arrays. No owned array reference escapes.
 * copyOf copies on its calling thread; construct off UI for large inputs.
 * Shape is checked here; OHLCV/time/finite validation runs in prepare worker.
 * Caller must not mutate source arrays concurrently with copyOf itself.
 */
public final class AsterColumns {
    public static final int MAX_BARS=4194304;
    private final double[][] columns;
    private final int length;
    private final long copyNanos;
    private AsterColumns(double[][] input){long start=System.nanoTime();if(input[0]==null)throw new IllegalArgumentException("Six columns required");length=input[0].length;if(length>MAX_BARS)throw new IllegalArgumentException("Column length limit");for(double[] c:input)if(c==null||c.length!=length)throw new IllegalArgumentException("Equal column lengths required");columns=new double[6][];for(int i=0;i<6;i++)columns[i]=input[i].clone();copyNanos=System.nanoTime()-start;}
    public static AsterColumns copyOf(double[] time,double[] open,double[] high,double[] low,double[] close,double[] volume){return new AsterColumns(new double[][]{time,open,high,low,close,volume});}
    public int length(){return length;}
    public long ownedBytes(){return length*48L;}
    public double copyMillis(){return copyNanos/1e6;}
    private static native void writeSlice(long target,int slot,int offset,int count,double[] values);
    void copyInto(long target,int slot,int offset,int count){if(slot<0||slot>=6||offset<0||count<1||count>262144||(long)offset+count>length)throw new IllegalArgumentException("Owned column slice bounds");writeSlice(target,slot,offset,count,columns[slot]);}
}
