package android.os;

/** Test-only single-owner marker. No Android message loop is executed. */
public final class Looper {
    private static final Looper MAIN=new Looper();
    private Looper() {}
    public static Looper myLooper(){return MAIN;}
    public static Looper getMainLooper(){return MAIN;}
}
