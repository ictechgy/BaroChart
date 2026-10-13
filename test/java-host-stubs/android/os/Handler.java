package android.os;

/** Test-only compile signature. Never executes or silently drops callbacks. */
public class Handler {
    public Handler(Looper looper) { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public final boolean post(Runnable task) { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public final boolean postDelayed(Runnable task, long delayMillis) { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public final void removeCallbacksAndMessages(Object token) { throw new UnsupportedOperationException("Compile-only Android stub"); }
}
