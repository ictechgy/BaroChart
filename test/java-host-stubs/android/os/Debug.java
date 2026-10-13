package android.os;

/** Test-only compile signature. Does not fabricate memory statistics. */
public final class Debug {
    private Debug() { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public static void getMemoryInfo(MemoryInfo info) { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public static class MemoryInfo {
        public MemoryInfo() { throw new UnsupportedOperationException("Compile-only Android stub"); }
        public int getTotalPss() { throw new UnsupportedOperationException("Compile-only Android stub"); }
    }
}
