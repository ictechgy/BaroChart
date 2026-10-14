package dev.aster.charts;

/** Shared logical admission for workspace and entry-only parameter jobs.
 * Unknown descriptor stages reserve a slot only; neither this nor known-byte
 * admission is an RSS bound on idle engines or external retained references. */
final class NativeJobBudget {
    static final long MAX_BYTES=805306368L;
    private static int jobs;
    private static long bytes;
    static final class Lease {private boolean released;private long bytes;private boolean admitted;private Lease(){}}
    private NativeJobBudget(){}
    static synchronized Lease reserve(){if(jobs>=2)throw new IllegalStateException("Native inflight job limit");Lease result=new Lease();jobs++;return result;}
    static synchronized void admit(Lease lease,long amount){if(lease==null||lease.released||lease.admitted)throw new IllegalStateException("Native reservation state");if(amount<1||amount>MAX_BYTES-bytes)throw new IllegalStateException("Native inflight byte limit");bytes+=amount;lease.bytes=amount;lease.admitted=true;}
    static synchronized void release(Lease lease){if(lease==null||lease.released)return;lease.released=true;bytes-=lease.bytes;jobs--;}
    static synchronized long[] snapshot(){return new long[]{jobs,bytes};}
}
