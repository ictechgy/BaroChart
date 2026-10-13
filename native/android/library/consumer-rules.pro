# JNI resolves these class/method names from native code. Keep only this bridge.
-keep class dev.aster.charts.AsterEngine {
    native <methods>;
    public static java.lang.String zonedParts(long, java.lang.String);
}
-keep class dev.aster.charts.AsterColumns {
    native <methods>;
}
