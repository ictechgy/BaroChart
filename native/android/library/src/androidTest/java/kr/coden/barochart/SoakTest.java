package kr.coden.barochart;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Debug;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 장시간 안정성(G5): 스트리밍 중 메모리(PSS)가 평탄하고, 엔진·뷰 생성/해제를 반복해도 누수가 없어야 한다.
 * 기본 실행은 짧게(약 12초) 돈다. 30분 soak는 instrumentation 인자 soakMinutes=30으로 실행한다
 * (scripts/run-native-soak.mjs). 판정은 soak 모드(15분 이상)에서만 적용한다. 보고서는 logcat에 남긴다.
 */
@RunWith(AndroidJUnit4.class)
public class SoakTest {
    private static final String TAG = "BaroChartSoak";
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final double minutes = Double.parseDouble(InstrumentationRegistry.getArguments().getString("soakMinutes", "0.2"));
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

    private void report(String name, JSONObject report) {
        try { report.put("runId", runId).put("backend", backend); }
        catch (org.json.JSONException error) { throw new IllegalStateException("Soak report metadata failed", error); }
        Log.i(TAG, "BAROCHART_SOAK_REPORT " + name + " " + report);
    }

    @Test public void streamingSoak() throws Exception {
        List<Bar> data = new ArrayList<>(bars(10_000));
        AtomicReference<BaroChartEngine> engineRef = new AtomicReference<>();
        AtomicReference<BaroChartView> viewRef = new AtomicReference<>();
        onMain(() -> {
            BaroChartEngine engine = BaroChartValidation.create(context, EngineOptions.defaults(), backend);
            engine.setBars(data);
            engine.addIndicator(Indicator.ema(20), "ema");
            engine.addSeries(Series.builder("ema-line", SeriesType.LINE).indicator("ema").build());
            BaroChartView view = new BaroChartView(context, engine);
            view.layout(0, 0, 390, 320);
            engineRef.set(engine); viewRef.set(view);
        });
        Bitmap target = Bitmap.createBitmap(390, 320, Bitmap.Config.ARGB_8888);
        long started = System.nanoTime(), deadline = started + (long) (minutes * 60e9), sampleEvery = (long) ((minutes >= 15 ? 60 : 2) * 1e9);
        long nextSample = started;
        JSONArray samples = new JSONArray();
        int[] ticks = {0};
        while (System.nanoTime() < deadline) {
            ticks[0]++;
            onMain(() -> streamTick(engineRef.get(), viewRef.get(), data, ticks[0], target));
            if (System.nanoTime() >= nextSample) {
                samples.put(new JSONObject().put("seconds", (System.nanoTime() - started) / 1e9).put("pssKiB", Debug.getPss())
                    .put("runtimeRequestedBytes", engineRef.get().runtimeMetrics().optLong("requestedLiveBytes", -1)));
                nextSample = System.nanoTime() + sampleEvery;
            }
            Thread.sleep(100);
        }
        onMain(() -> engineRef.get().close());
        JSONObject verdict = streamingVerdict(samples, ticks[0]);
        report("android-streaming-soak", verdict);
        if (minutes >= 15) assertTrue(verdict.toString(), verdict.getBoolean("passed"));
        assertTrue("view must not record a draw error: " + viewRef.get().getLastError(), viewRef.get().getLastError() == null);
    }

    /** 0.1초마다 현재 봉 갱신, 10틱마다 추가, 600틱마다 보존 창 압축, 매 틱 그리기 */
    private static void streamTick(BaroChartEngine engine, BaroChartView view, List<Bar> data, int tick, Bitmap target) {
        Bar last = data.get(data.size() - 1);
        if (tick % 10 == 0) {
            Bar next = new Bar(last.time + 60_000, last.close, last.close + 0.5, last.close - 0.5, last.close, 600);
            engine.apply(DataEvent.append(next)); data.add(next);
        } else {
            double close = last.close + Math.sin(tick / 7.0) * 0.2;
            Bar updated = new Bar(last.time, last.open, Math.max(last.high, close), Math.min(last.low, close), close, last.volume + 1);
            engine.apply(DataEvent.update(updated)); data.set(data.size() - 1, updated);
        }
        if (tick % 600 == 0) {
            try { engine.compactData(new JSONObject().put("keepLastBars", 10_000).put("studyHistory", "restart")); }
            catch (org.json.JSONException error) { throw new IllegalStateException("Compaction request failed", error); }
            List<Bar> kept = new ArrayList<>(data.subList(data.size() - 10_000, data.size()));
            data.clear(); data.addAll(kept);
        }
        view.draw(new Canvas(target));
    }

    /** 워밍업 5분 뒤 10분 구간마다 PSS 증가율이 5% 이하인지 판정한다 */
    private JSONObject streamingVerdict(JSONArray samples, int ticks) throws Exception {
        List<double[]> warm = new ArrayList<>();
        for (int i = 0; i < samples.length(); i++) { JSONObject s = samples.getJSONObject(i); if (s.getDouble("seconds") >= 300) warm.add(new double[]{s.getDouble("seconds"), s.getDouble("pssKiB")}); }
        JSONArray windows = new JSONArray();
        boolean allFlat = true;
        int start = 0;
        while (start < warm.size()) {
            int end = -1;
            for (int j = start; j < warm.size(); j++) if (warm.get(j)[0] - warm.get(start)[0] >= 600) { end = j; break; }
            if (end < 0) break;
            double growth = (warm.get(end)[1] - warm.get(start)[1]) / Math.max(1, warm.get(start)[1]) * 100;
            allFlat &= growth <= 5;
            windows.put(new JSONObject().put("fromSeconds", warm.get(start)[0]).put("toSeconds", warm.get(end)[0]).put("growthPercent", growth));
            start = end;
        }
        return new JSONObject().put("minutes", minutes).put("ticks", ticks).put("samples", samples).put("windows", windows)
            .put("passed", allFlat && windows.length() > 0).put("rule", "after 5 min warm-up, PSS growth <= 5% per 10-min window");
    }

    /**
     * 생성·해제 누수 판정. 끝점 두 개를 비교하지 않고 최소제곱 기울기로 회당 증가를 추정한다.
     * 작은 메모리 기준값에서는 측정 잡음이 5% 기준보다 커서 끝점 비교가 잡음을 판정하기 때문이다(iOS와 같은 규칙).
     * @param samples {회차, PSS KiB} 표본(워밍업 뒤 25회마다)
     * @param cycles 투영할 회수(워밍업 뒤 측정 회수)
     * @return 회당 기울기, 기준값(앞 3표본 평균), 투영 증가율(%), 통과 여부(투영 증가 5% 이하)
     */
    static JSONObject leakVerdict(double[][] samples, int cycles) throws Exception {
        double meanCycle = 0, meanPss = 0, covariance = 0, variance = 0, baseline = 0;
        for (double[] sample : samples) { meanCycle += sample[0] / samples.length; meanPss += sample[1] / samples.length; }
        for (double[] sample : samples) { covariance += (sample[0] - meanCycle) * (sample[1] - meanPss); variance += (sample[0] - meanCycle) * (sample[0] - meanCycle); }
        int head = Math.min(3, samples.length);
        for (int i = 0; i < head; i++) baseline += samples[i][1] / head;
        double slope = variance > 0 ? covariance / variance : 0, projected = slope * cycles / Math.max(1, baseline) * 100;
        return new JSONObject().put("slopePssKiBPerCycle", slope).put("baselinePssKiB", baseline).put("projectedGrowthPercent", projected)
            .put("passed", projected <= 5).put("rule", "least-squares PSS slope over samples every 25 cycles after warm-up, projected over the measured cycles, <= 5% of baseline");
    }

    /** 판정 자체의 검증: ±2MB 잡음만 있는 평탄한 계열은 통과하고, 회당 8KB씩 느는 계열(450회에 약 15%)은 실패해야 한다 */
    @Test public void leakVerdictIgnoresNoiseButCatchesSlope() throws Exception {
        double[][] noisy = new double[19][], leaking = new double[19][];
        for (int i = 0; i < 19; i++) {
            double cycle = 50 + i * 25;
            noisy[i] = new double[] {cycle, 24_000 + (i % 2 == 0 ? 2_000 : -2_000)};
            leaking[i] = new double[] {cycle, 24_000 + (cycle - 50) * 8};
        }
        assertTrue(leakVerdict(noisy, 450).getBoolean("passed"));
        assertTrue(!leakVerdict(leaking, 450).getBoolean("passed"));
    }

    @Test public void createDisposeCycles() throws Exception {
        int cycles = minutes >= 15 ? 500 : 40, warmup = minutes >= 15 ? 50 : 10;
        List<double[]> samples = new ArrayList<>();
        List<double[]> requestedSamples = new ArrayList<>();
        Bitmap target = Bitmap.createBitmap(320, 240, Bitmap.Config.ARGB_8888);
        List<Bar> data = Collections.unmodifiableList(bars(200));
        for (int cycle = 0; cycle < cycles; cycle++) {
            final int currentCycle = cycle;
            if (cycle >= warmup && (cycle - warmup) % 25 == 0) samples.add(new double[] {cycle, Debug.getPss()});
            onMain(() -> {
                BaroChartEngine engine = BaroChartValidation.create(context, EngineOptions.defaults(), backend);
                engine.setBars(data);
                BaroChartView view = new BaroChartView(context, engine);
                view.layout(0, 0, 320, 240);
                view.draw(new Canvas(target));
                if (currentCycle >= warmup && (currentCycle - warmup) % 25 == 0)
                    requestedSamples.add(new double[] {currentCycle, engine.runtimeMetrics().optLong("requestedLiveBytes", -1)});
                engine.close();
            });
        }
        Runtime.getRuntime().gc();
        samples.add(new double[] {cycles, Debug.getPss()});
        JSONObject verdict = leakVerdict(samples.toArray(new double[0][]), cycles - warmup).put("cycles", cycles).put("warmupCycles", warmup);
        JSONArray series = new JSONArray();
        for (double[] sample : samples) series.put(new JSONObject().put("cycle", sample[0]).put("pssKiB", sample[1]));
        verdict.put("samples", series);
        JSONArray requested = new JSONArray();
        for (double[] sample : requestedSamples) requested.put(new JSONObject().put("cycle", sample[0]).put("requestedRuntimeBytes", sample[1]));
        verdict.put("requestedRuntimeAllocationSamples", requested).put("memoryAccounting", "requested runtime bytes are reported separately from process PSS");
        report("android-create-dispose", verdict);
        if (minutes >= 15) assertTrue(verdict.toString(), verdict.getBoolean("passed"));
    }
}
