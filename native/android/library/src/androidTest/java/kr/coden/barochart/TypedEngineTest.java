package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** 타입 엔진 API를 실제 JNI/QuickJS에서 실행한다. Swift TypedEngineTests와 같은 시나리오·기대값이다. */
@RunWith(AndroidJUnit4.class)
public class TypedEngineTest {
    private static final double START = 1_700_000_000_000.0;
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    private interface MainBody { void run() throws Exception; }

    /** 메인 스레드에서 실행하고, 그 안의 실패를 테스트 스레드로 다시 던진다 */
    private void onMain(MainBody body) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { try { body.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    /** 1분봉 count개(종가 102부터 1씩). 앞 4개는 README 예제와 같다 */
    private static List<Bar> bars(int count) {
        List<Bar> out = new ArrayList<>();
        for (int i = 0; i < count; i++) { double close = 102 + i; out.add(new Bar(START + i * 60_000.0, close - 2, close + 1, close - 3, close, 500 + i * 100)); }
        return out;
    }

    private BaroChartEngine engineWithBars(int count) {
        BaroChartEngine engine = BaroChartEngine.create(context, EngineOptions.defaults());
        engine.setBars(bars(count));
        return engine;
    }

    private static BaroChartException.Code code(Runnable body) {
        try { body.run(); } catch (BaroChartException error) { return error.getCode(); }
        return null;
    }

    private static int storedBars(BaroChartEngine engine) throws Exception { return ((JSONObject) engine.command("inspect")).getInt("storedBars"); }

    @Test public void defaultOptionsCreateUnlabeledCandlesOnly() {
        onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(context, EngineOptions.defaults());
            try {
                JSONObject state = (JSONObject) engine.command("inspect");
                JSONArray panels = state.getJSONArray("panels"), series = state.getJSONArray("series");
                assertEquals(1, panels.length());
                assertEquals("price", panels.getJSONObject(0).getString("id"));
                assertFalse(panels.getJSONObject(0).has("label"));
                assertEquals(1, series.length());
                assertEquals("candles", series.getJSONObject(0).getString("type"));
            } finally { engine.close(); }
        });
    }

    @Test public void candlesEmaFlow() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(4);
            try {
                engine.addIndicator(Indicator.ema(3), "ema3");
                engine.addSeries(Series.builder("ema3-line", SeriesType.LINE).indicator("ema3").color("#f0b755").build());
                engine.fit();
                IndicatorValue value = engine.indicatorValue("ema3", null, 3);
                // Node 코어로 같은 데이터를 계산한 EMA(3) 값
                assertEquals(104, value.value, 1e-9);
                assertEquals(Integer.valueOf(3), value.sourceIndex);
                assertEquals(START + 180_000, value.sourceTime, 0);
            } finally { engine.close(); }
        });
    }

    @Test public void updateMustTargetLastBar() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(4);
            try {
                String before = engine.saveDrawings();
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.update(new Bar(START, 1, 1, 1, 1, 1)))));
                assertEquals(before, engine.saveDrawings());
                assertEquals(4, storedBars(engine));
            } finally { engine.close(); }
        });
    }

    @Test public void resetRejectsUnsortedAndNaN() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(4);
            try {
                List<Bar> bars = bars(4);
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.reset(Arrays.asList(bars.get(1), bars.get(0))))));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.reset(Collections.singletonList(new Bar(START, Double.NaN, 1, 1, 1, 1))))));
                assertEquals(4, storedBars(engine));
            } finally { engine.close(); }
        });
    }

    @Test public void closedEngineThrows() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(4);
            engine.close();
            assertTrue(engine.isClosed());
            assertEquals(BaroChartException.Code.ENGINE_CLOSED, code(() -> engine.setBars(bars(4))));
            assertEquals(BaroChartException.Code.ENGINE_CLOSED, code(() -> engine.addSeries(Series.builder("x", SeriesType.LINE).build())));
            assertEquals(BaroChartException.Code.ENGINE_CLOSED, code(engine::fit));
        });
    }

    @Test public void wrongThreadThrows() {
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        onMain(() -> engine.set(engineWithBars(4)));
        try {
            assertEquals(BaroChartException.Code.WRONG_THREAD, code(() -> engine.get().setBars(bars(4))));
        } finally {
            onMain(() -> engine.get().close());
        }
    }

    @Test public void drawingRoundTrip() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(4);
            try {
                String id = engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(START + 60_000, 101))).build());
                assertTrue(engine.saveDrawings().contains("\"schema\":\"aster.drawings\""));
                assertEquals(1, engine.deleteDrawings(Collections.singletonList(id)));
                assertFalse(engine.saveDrawings().contains(id));
                engine.undo();
                assertTrue(engine.saveDrawings().contains(id));
            } finally { engine.close(); }
        });
    }

    @Test public void selectToolCannotBeDrawn() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(4);
            try {
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.addDrawing(Drawing.builder(DrawingTool.SELECT, Collections.<ChartPoint>emptyList()).build())));
                engine.setTool(DrawingTool.TRENDLINE);
            } finally { engine.close(); }
        });
    }

    @Test public void themeAndRange() {
        onMain(() -> {
            BaroChartEngine engine = engineWithBars(40);
            try {
                engine.setTheme(Theme.LIGHT);
                JSONObject theme = ((JSONObject) engine.command("inspect")).getJSONObject("theme");
                // 코어는 색을 #rrggbbaa로 정규화한다
                assertEquals(Theme.LIGHT.background + "ff", theme.getString("background"));
                assertEquals(Theme.LIGHT.font, theme.getString("font"));
                engine.setVisibleRange(new VisibleRange(5, 25));
                VisibleRange range = engine.visibleRange();
                assertEquals(5, range.from, 1e-9);
                assertEquals(25, range.to, 1e-9);
            } finally { engine.close(); }
        });
    }

    /** 메인 스레드에서 복원을 시작하고 콜백 결과를 기다린다 */
    private BaroChartException restore(BaroChartEngine target, String document, DatasetBinding binding, boolean cancelImmediately) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<BaroChartException> result = new AtomicReference<>();
        onMain(() -> {
            RestoreHandle handle = target.restoreWorkspace(document, binding, error -> { result.set(error); done.countDown(); });
            if (cancelImmediately) handle.cancel();
        });
        assertTrue("Restore callback must arrive", done.await(30, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void workspaceRoundTrip() throws Exception {
        DatasetBinding binding = new DatasetBinding("SYNTH:US", "1", "raw", "USD", Adjustment.RAW);
        AtomicReference<String> document = new AtomicReference<>();
        AtomicReference<BaroChartEngine> target = new AtomicReference<>();
        onMain(() -> {
            BaroChartEngine source = engineWithBars(4);
            try {
                source.addIndicator(Indicator.ema(3), "ema3");
                source.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(START, 103))).build());
                document.set(source.saveWorkspace(binding));
            } finally { source.close(); }
            target.set(engineWithBars(4));
        });
        try {
            assertNull(restore(target.get(), document.get(), binding, false));
            onMain(() -> assertEquals(document.get(), target.get().saveWorkspace(binding)));
        } finally { onMain(() -> target.get().close()); }
    }

    @Test public void restoreCancellation() throws Exception {
        DatasetBinding binding = new DatasetBinding("SYNTH:US", "1", "raw", "USD", Adjustment.RAW);
        AtomicReference<String> document = new AtomicReference<>();
        AtomicReference<BaroChartEngine> target = new AtomicReference<>();
        onMain(() -> {
            BaroChartEngine source = engineWithBars(4);
            try { document.set(source.saveWorkspace(binding)); } finally { source.close(); }
            target.set(engineWithBars(4));
        });
        try {
            BaroChartException error = restore(target.get(), document.get(), binding, true);
            assertNotNull("A cancelled restore must not report success", error);
            assertEquals(BaroChartException.Code.CANCELLED, error.getCode());
            onMain(() -> target.get().fit());
        } finally { onMain(() -> target.get().close()); }
    }

    @Test public void offOwnerCallsNeverCrash() {
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        onMain(() -> engine.set(engineWithBars(4)));
        try {
            for (Runnable call : Arrays.<Runnable>asList(engine.get()::fit, () -> engine.get().setTheme(Theme.DARK), () -> engine.get().visibleRange()))
                try { call.run(); fail("Off-owner call must throw"); } catch (BaroChartException expected) { assertEquals(BaroChartException.Code.WRONG_THREAD, expected.getCode()); }
        } finally { onMain(() -> engine.get().close()); }
    }
}
