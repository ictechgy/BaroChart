package android.util;

/** Test-only logging sink for production methods outside the exercised path. */
public final class Log {
    private Log() {}
    public static int w(String tag,String message,Throwable error){return 0;}
}
