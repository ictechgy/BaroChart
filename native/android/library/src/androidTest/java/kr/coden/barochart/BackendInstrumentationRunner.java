package kr.coden.barochart;

import android.util.Log;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.AndroidJUnitRunner;
import java.util.Locale;

/** Runs the unchanged shared SDK tests with an explicitly selected constructor default. */
public final class BackendInstrumentationRunner extends AndroidJUnitRunner {
    private static final String TAG = "BaroChartBackendSuite";

    @Override public void onStart() {
        String backend = InstrumentationRegistry.getArguments().getString("suiteBackend");
        EngineBackend expected = null;
        if (backend != null) {
            switch (backend) {
                case "javascript": expected = EngineBackend.JAVASCRIPT; break;
                case "rust": expected = EngineBackend.RUST; break;
                default: throw new IllegalArgumentException("Unknown shared test backend");
            }
            BaroChartEngine.setDefaultBackend(expected);
        }
        EngineBackend actual = BaroChartEngine.getDefaultBackend();
        if (expected != null && actual != expected) throw new IllegalStateException("Shared suite backend selection failed");
        Log.i(TAG, "suiteBackend=" + actual.name().toLowerCase(Locale.ROOT) + (expected == null ? " (default)" : " (requested)"));
        super.onStart();
    }
}
