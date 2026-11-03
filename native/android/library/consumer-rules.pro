# JNI resolves these class/method names from native code. Keep only this bridge.
-keep class kr.coden.barochart.BaroChartEngine {
    native <methods>;
    public static java.lang.String zonedParts(long, java.lang.String);
    static java.lang.String zoneResolve(java.lang.String);
    static int zoneOffsetSeconds(long, java.lang.String);
    static java.lang.String rustErrorMessage(int, java.lang.String);
}
-keep class kr.coden.barochart.BaroChartColumns {
    native <methods>;
}
