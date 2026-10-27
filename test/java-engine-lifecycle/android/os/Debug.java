package android.os;

/** Compile-only signatures for production methods outside this lifecycle fixture. */
public final class Debug {
    private Debug() {}
    public static void getMemoryInfo(MemoryInfo info){if(info==null)throw new IllegalArgumentException("MemoryInfo required");}
    public static final class MemoryInfo {
        public MemoryInfo() {}
        public int getTotalPss(){return 0;}
    }
}
