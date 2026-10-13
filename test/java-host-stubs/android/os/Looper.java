package android.os;

/** Test-only compile signature. No queue, owner thread, or scheduling semantics. */
public final class Looper {
    private Looper() { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public static Looper myLooper() { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public static Looper getMainLooper() { throw new UnsupportedOperationException("Compile-only Android stub"); }
}
