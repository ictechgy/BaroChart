package dev.aster.charts;
import android.app.Instrumentation;import android.os.Bundle;

/** Pressure runs through the Activity and external Android input service. */
public final class ScenePressureInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle args){start();}
    @Override public void onStart(){Bundle failure=new Bundle();failure.putString("error","Use Activity/system-input runner; SDK/timezone have separate preserved runners");finish(0,failure);}
}
