package kr.coden.barochart;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.os.Debug;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 실기기 성능 측정(G6). 화면 표시 FPS가 아니라 기기 CPU에서 BaroChartView를 비트맵에 그리는 시간이다.
 * 결과는 logcat(BaroChartPerf)에 BAROCHART_DEVICE_BENCHMARK 줄로 남긴다(scripts/measure-native-device.mjs가 수집).
 */
@RunWith(AndroidJUnit4.class)
public class PerformanceTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final float density = context.getResources().getDisplayMetrics().density;
    private final int width = Math.round(390 * density), height = Math.round(320 * density);
    private final String backend = InstrumentationRegistry.getArguments().getString("backend", "javascript");
    private final String runId = InstrumentationRegistry.getArguments().getString("runId", "missing-run-id");

    private interface MainBody { void run() throws Exception; }

    private void onMain(MainBody body) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { try { body.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private static List<Bar> bars(int count) {
        List<Bar> out = new ArrayList<>();
        for (int i = 0; i < count; i++) { double close = 100 + Math.sin(i / 9.0) * 3; out.add(new Bar(1_700_000_000_000.0 + i * 60_000.0, close - 0.4, close + 0.8, close - 0.9, close, 500 + (i % 13) * 20)); }
        return out;
    }

    private static JSONObject summary(List<Double> values) throws Exception {
        List<Double> sorted = new ArrayList<>(values);
        Collections.sort(sorted);
        return new JSONObject().put("p50Ms", sorted.get((int) Math.ceil(sorted.size() * 0.50) - 1)).put("p95Ms", sorted.get(Math.min(sorted.size() - 1, (int) Math.ceil(sorted.size() * 0.95) - 1)))
            .put("maxMs", sorted.get(sorted.size() - 1)).put("runs", sorted.size());
    }

    @Test public void deviceBenchmark() throws Exception {
        List<Bar> data = bars(10_000);
        List<Double> startup = new ArrayList<>(), pan = new ArrayList<>();
        Bitmap target = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        AtomicReference<String> runtimeScope = new AtomicReference<>("");
        // 엔진 생성 → 1만 봉 설정 → 첫 프레임 렌더(12회, 앞 2회 워밍업 제외)
        for (int run = 0; run < 12; run++) {
            int index = run;
            onMain(() -> {
                long start = System.nanoTime();
                BaroChartEngine engine = BaroChartValidation.create(context, EngineOptions.defaults(), backend);
                engine.setBars(data);
                BaroChartView view = new BaroChartView(context, engine);
                view.layout(0, 0, width, height);
                view.draw(new Canvas(target));
                double elapsed = (System.nanoTime() - start) / 1e6;
                if (index >= 2) startup.add(elapsed);
                engine.close();
            });
        }
        // 1만 봉에서 보이는 범위를 120번 옮기며 프레임마다 렌더 시간
        AtomicReference<Long> pss = new AtomicReference<>(0L);
        AtomicReference<JSONObject> runtimeMemory = new AtomicReference<>(new JSONObject());
        onMain(() -> {
            BaroChartEngine engine = BaroChartValidation.create(context, EngineOptions.defaults(), backend);
            try {
                runtimeScope.set(engine.runtimeMetrics().getString("scope"));
                engine.setBars(data);
                engine.addIndicator(Indicator.ema(20), "ema");
                engine.addSeries(Series.builder("ema-line", SeriesType.LINE).indicator("ema").build());
                BaroChartView view = new BaroChartView(context, engine);
                view.layout(0, 0, width, height);
                engine.setVisibleRange(new VisibleRange(data.size() - 200, data.size()));
                view.draw(new Canvas(target));
                for (int warmup = 0; warmup < 2; warmup++) {
                    double from = data.size() - 206 - warmup * 3;
                    engine.setVisibleRange(new VisibleRange(from, from + 200));
                    view.draw(new Canvas(target));
                }
                for (int frame = 0; frame < 120; frame++) {
                    long start = System.nanoTime();
                    double from = data.size() - 200 - frame * 3;
                    engine.setVisibleRange(new VisibleRange(from, from + 200));
                    view.draw(new Canvas(target));
                    pan.add((System.nanoTime() - start) / 1e6);
                }
                runtimeMemory.set(engine.runtimeMetrics());
                pss.set(Debug.getPss());
            } finally { engine.close(); }
        });
        String actualBackend = runtimeScope.get().contains("Rust engine") ? "rust" : "javascript";
        assertTrue("requested backend " + backend + " did not match runtime scope", backend.equals(actualBackend));
        JSONObject report = new JSONObject().put("backend", actualBackend).put("backendVerified", true).put("runId", runId).put("percentileMethod", "nearest-rank")
            .put("fixtureId", "seeded-sine-bars-10k-ema20-v1")
            .put("device", Build.MANUFACTURER + " " + Build.MODEL).put("os", Build.VERSION.RELEASE).put("api", Build.VERSION.SDK_INT)
            .put("abi", Build.SUPPORTED_ABIS[0]).put("physicalDevice", !Build.FINGERPRINT.startsWith("generic")).put("density", density)
            .put("method", "BaroChartView.draw into a bitmap on the device CPU; not display FPS")
            .put("startup", summary(startup)).put("pan10k", summary(pan).put("pssMB", pss.get() / 1024.0)
                .put("runtimeMemory", runtimeMemory.get()).put("memoryAccounting", "runtime requested bytes are separate from process PSS"));
        Log.i("BaroChartPerf", "BAROCHART_DEVICE_BENCHMARK " + report);
        assertTrue(report.toString(), startup.size() == 10 && pan.size() == 120);
    }
}
