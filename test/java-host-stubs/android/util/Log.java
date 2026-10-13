package android.util;

/** Test-only compile signature. Does not impersonate the Android log service. */
public final class Log {
    private Log() { throw new UnsupportedOperationException("Compile-only Android stub"); }
    public static int w(String tag, String message, Throwable error) { throw new UnsupportedOperationException("Compile-only Android stub"); }
}
