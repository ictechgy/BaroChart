package kr.coden.barochart;

import static kr.coden.barochart.TestSupport.START;
import static kr.coden.barochart.TestSupport.bars;
import static kr.coden.barochart.TestSupport.code;
import static kr.coden.barochart.TestSupport.context;
import static kr.coden.barochart.TestSupport.inspect;
import static kr.coden.barochart.TestSupport.onMain;
import static kr.coden.barochart.TestSupport.storedBars;
import static kr.coden.barochart.TestSupport.twoPanelEngine;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 공개 타입 API 전 메서드의 정상·오류 경로(G3), 패치 타입, 닫힌 엔진·다른 스레드 표, 이름 변경 이전 저장본 복원을
 * 실제 JNI/QuickJS에서 확인한다. 시나리오는 Swift TypedEngineCoverageTests와 맞춘다.
 */
@RunWith(AndroidJUnit4.class)
public class TypedEngineCoverageTest {
    private static final DatasetBinding BINDING = new DatasetBinding("SYNTH:US", "1", "raw", "USD", Adjustment.RAW);

    /** 표의 한 행: 메서드 이름과 그 메서드를 한 번 부르는 본문 */
    private static final class Call {
        final String name;
        final Runnable body;
        Call(String name, Runnable body) { this.name = name; this.body = body; }
    }

    /**
     * inspect 결과에서 id가 같은 시리즈를 찾는다.
     * @return 시리즈, 없으면 {@code null}
     */
    private static JSONObject series(BaroChartEngine engine, String id) throws Exception {
        JSONArray rows = inspect(engine).getJSONArray("series");
        for (int i = 0; i < rows.length(); i++) if (id.equals(rows.getJSONObject(i).getString("id"))) return rows.getJSONObject(i);
        return null;
    }

    /**
     * 저장된 드로잉 문서에서 id가 같은 드로잉을 찾는다.
     * @return 드로잉, 없으면 {@code null}
     */
    private static JSONObject drawing(BaroChartEngine engine, String id) throws Exception {
        JSONArray rows = new JSONObject(engine.saveDrawings()).getJSONArray("drawings");
        for (int i = 0; i < rows.length(); i++) if (id.equals(rows.getJSONObject(i).getString("id"))) return rows.getJSONObject(i);
        return null;
    }

    private static Map<String, ParamValue> period(double value) { return Collections.singletonMap("period", ParamValue.number(value)); }

    private static Drawing horizontal(double time, double price) {
        return Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(time, price))).build();
    }

    /** 패치 대상이 없으면 코어가 주는 대로 INVALID_ARGUMENT 또는 JAVASCRIPT여야 한다(크래시·UNAVAILABLE 금지) */
    private static void assertMissingTarget(String label, BaroChartException.Code observed) {
        assertTrue(label + " must throw BaroChartException INVALID_ARGUMENT or JAVASCRIPT, got " + observed,
            observed == BaroChartException.Code.INVALID_ARGUMENT || observed == BaroChartException.Code.JAVASCRIPT);
    }

    /**
     * 메인 스레드에서 복원을 시작하고 콜백 결과를 기다린다.
     * @return 콜백이 받은 오류, 성공이면 {@code null}
     */
    private static BaroChartException restore(BaroChartEngine target, String document, DatasetBinding binding) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<BaroChartException> result = new AtomicReference<>();
        onMain(() -> target.restoreWorkspace(document, binding, error -> { result.set(error); done.countDown(); }));
        assertTrue("Restore callback must arrive", done.await(30, TimeUnit.SECONDS));
        return result.get();
    }

    // ---------------------------------------------------------------------------------------
    // 항목 2: 다른 스레드의 close()
    // ---------------------------------------------------------------------------------------

    @Test public void closeFromOtherThreadThrowsWrongThread() throws Exception {
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        onMain(() -> engine.set(twoPanelEngine(4)));
        try {
            AtomicReference<Throwable> thrown = new AtomicReference<>();
            Thread worker = new Thread(() -> {
                try { engine.get().close(); } catch (Throwable error) { thrown.set(error); }
            }, "close-off-owner");
            worker.start();
            worker.join(10_000);
            assertTrue("close() off the owner thread must throw BaroChartException, got " + thrown.get(), thrown.get() instanceof BaroChartException);
            assertEquals(BaroChartException.Code.WRONG_THREAD, ((BaroChartException) thrown.get()).getCode());
            onMain(() -> {
                assertFalse("A rejected close must leave the engine open", engine.get().isClosed());
                assertEquals(4, storedBars(engine.get()));
            });
        } finally { onMain(() -> engine.get().close()); }
    }

    // ---------------------------------------------------------------------------------------
    // 항목 3: SeriesPatch·DrawingPatch
    // ---------------------------------------------------------------------------------------

    @Test public void seriesPatchChangesOnlyGivenFields() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                engine.addIndicator(Indicator.rsi(3), "rsi3");
                engine.addSeries(Series.builder("rsi-line", SeriesType.LINE).panel("rsi").indicator("rsi3").color("#123456").build());
                engine.updateSeries("rsi-line", SeriesPatch.builder().color("#abcdef").build());
                JSONObject patched = series(engine, "rsi-line");
                assertNotNull(patched);
                assertEquals("A color-only patch must keep the panel", "rsi", patched.getString("panel"));
                assertEquals("rsi3", patched.getString("indicator"));
                assertTrue(patched.getString("color"), patched.getString("color").startsWith("#abcdef"));
                // 설정한 필드는 그대로 반영된다(패널을 명시하면 옮겨진다)
                engine.updateSeries("rsi-line", SeriesPatch.builder().panel("price").visible(false).width(3).label("RSI").build());
                JSONObject moved = series(engine, "rsi-line");
                assertNotNull(moved);
                assertEquals("price", moved.getString("panel"));
                assertFalse(moved.getBoolean("visible"));
                assertEquals(3, moved.getDouble("width"), 0);
                assertEquals("RSI", moved.getString("label"));
                assertTrue("Unset fields keep their values", moved.getString("color").startsWith("#abcdef"));
            } finally { engine.close(); }
        });
    }

    @Test public void drawingPatchKeepsPointsAndPanel() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                String id = engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(START + 60_000, 103))).panel("rsi").build());
                engine.updateDrawing(id, DrawingPatch.builder().visible(false).build());
                JSONObject hidden = drawing(engine, id);
                assertNotNull(hidden);
                assertEquals("A visibility-only patch must keep the panel", "rsi", hidden.getString("panel"));
                assertFalse(hidden.getBoolean("visible"));
                JSONObject point = hidden.getJSONArray("points").getJSONObject(0);
                assertEquals(103, point.getDouble("price"), 0);
                assertEquals(START + 60_000, point.getDouble("time"), 0);
                // 스타일만 바꿔도 앵커를 다시 보내지 않고 패널·가시성이 유지된다
                engine.updateDrawing(id, DrawingPatch.builder().style(new DrawingStyle("#00ff00", null, 2.0, null)).build());
                JSONObject styled = drawing(engine, id);
                assertNotNull(styled);
                assertEquals("rsi", styled.getString("panel"));
                assertFalse(styled.getBoolean("visible"));
                assertEquals(1, styled.getJSONArray("points").length());
                assertEquals(103, styled.getJSONArray("points").getJSONObject(0).getDouble("price"), 0);
                assertTrue(styled.toString(), styled.getJSONObject("style").getString("color").startsWith("#00ff00"));
                // 앵커·텍스트·잠금도 설정했을 때만 바뀐다
                engine.updateDrawing(id, DrawingPatch.builder().points(Collections.singletonList(new ChartPoint(START + 120_000, 104))).text("level").locked(true).build());
                JSONObject moved = drawing(engine, id);
                assertNotNull(moved);
                assertEquals(104, moved.getJSONArray("points").getJSONObject(0).getDouble("price"), 0);
                assertEquals("level", moved.getString("text"));
                assertTrue(moved.getBoolean("locked"));
                assertEquals("rsi", moved.getString("panel"));
            } finally { engine.close(); }
        });
    }

    @Test public void patchingMissingIdThrowsTypedError() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                assertMissingTarget("updateSeries", code(() -> engine.updateSeries("missing", SeriesPatch.builder().color("#000000").build())));
                assertMissingTarget("updateDrawing", code(() -> engine.updateDrawing("missing", DrawingPatch.builder().visible(true).build())));
                assertEquals(4, storedBars(engine));
            } finally { engine.close(); }
        });
    }

    // ---------------------------------------------------------------------------------------
    // 항목 7: 메서드별 정상·오류 경로
    // ---------------------------------------------------------------------------------------

    @Test public void createRejectsInvalidOptions() {
        onMain(() -> {
            EngineOptions options = new EngineOptions(Collections.singletonList(new Panel("price", 3)),
                Collections.singletonList(Series.builder("line", SeriesType.LINE).panel("missing").build()), null);
            assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> BaroChartEngine.create(context(), options)));
            BaroChartEngine engine = BaroChartEngine.create(context(), EngineOptions.defaults());
            try { assertEquals(0, storedBars(engine)); } finally { engine.close(); }
        });
    }

    @Test public void appendCorrectionPrependAndBatch() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                engine.apply(DataEvent.append(bars(1, 4).get(0)));
                engine.apply(DataEvent.correction(new Bar(START + 60_000, 100, 110, 99, 108, 9)));
                engine.apply(DataEvent.prepend(Collections.singletonList(new Bar(START - 60_000, 99, 101, 98, 100, 1))));
                engine.apply(DataEvent.batch(Arrays.asList(DataEvent.append(bars(1, 5).get(0)), DataEvent.update(bars(1, 5).get(0)))));
                assertEquals(7, storedBars(engine));
                // 앞에 1개를 붙였으므로 고친 봉은 인덱스 2에 있다
                JSONObject corrected = engine.dataAt(new JSONObject().put("index", 2)).getJSONObject("primary").getJSONObject("bar");
                assertEquals(108, corrected.getDouble("close"), 0);
                assertEquals(START + 300_000, inspect(engine).getJSONObject("lastBar").getDouble("time"), 0);
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.append(bars(1, 0).get(0)))));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.prepend(Collections.singletonList(bars(1, 9).get(0))))));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.correction(new Bar(START + 30_000, 1, 1, 1, 1, 1)))));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.apply(DataEvent.batch(Collections.singletonList(DataEvent.append(bars(1, 0).get(0)))))));
                assertEquals(7, storedBars(engine));
            } finally { engine.close(); }
        });
    }

    @Test public void addAndRemoveSeries() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                engine.addSeries(Series.builder("close-line", SeriesType.LINE).source(PriceSource.CLOSE).build());
                assertNotNull(series(engine, "close-line"));
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.addSeries(Series.builder("close-line", SeriesType.LINE).build())));
                engine.removeSeries("close-line");
                assertNull(series(engine, "close-line"));
                // 코어의 removeSeries는 의도적으로 멱등이다: 없는 id는 오류가 아니다(오류 경로는 닫힌 엔진·다른 스레드 표)
                assertNull(code(() -> engine.removeSeries("close-line")));
                assertNotNull(series(engine, "price"));
            } finally { engine.close(); }
        });
    }

    @Test public void indicatorParamsValuesAndRemoval() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(20);
            try {
                engine.addIndicator(Indicator.ema(3), "ema");
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.addIndicator(Indicator.ema(3), "ema")));
                Double before = engine.indicatorValue("ema", null, 19).value;
                assertNotNull(before);
                engine.setIndicatorParams("ema", period(10));
                assertNotEquals(before, engine.indicatorValue("ema", null, 19).value);
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.setIndicatorParams("ema", period(-1))));
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.setIndicatorParams("missing", period(5))));
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.indicatorValue("missing", null, 0)));
                engine.removeIndicator("ema");
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.indicatorValue("ema", null, 0)));
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.removeIndicator("ema")));
            } finally { engine.close(); }
        });
    }

    @Test public void drawingSelectionUndoRedoAndLoad() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                String id = engine.addDrawing(horizontal(START, 103));
                assertEquals(BaroChartException.Code.JAVASCRIPT,
                    code(() -> engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(START, 103))).panel("missing").build())));
                engine.selectDrawing(id);
                assertEquals(id, inspect(engine).getString("selected"));
                engine.selectDrawing(null);
                assertTrue(inspect(engine).isNull("selected"));
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.selectDrawing("missing")));
                String saved = engine.saveDrawings();
                assertEquals(1, engine.deleteDrawings(Collections.singletonList(id)));
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(() -> engine.deleteDrawings(Collections.singletonList("missing"))));
                engine.undo();
                assertNotNull(drawing(engine, id));
                engine.redo();
                assertNull(drawing(engine, id));
                engine.loadDrawings(saved);
                assertNotNull(drawing(engine, id));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.loadDrawings("{}")));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.loadDrawings("not json")));
                assertNotNull("A rejected load keeps the drawings", drawing(engine, id));
            } finally { engine.close(); }
        });
    }

    @Test public void toolSelectionAndSaveDuringGesture() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                engine.setTool(DrawingTool.TRENDLINE);
                assertEquals("trendline", inspect(engine).getString("tool"));
                engine.invoke("nativePointer", "down", 1, 100, 200, 24);
                assertEquals("create", engine.invoke("nativeGestureKind"));
                // 진행 중인 제스처가 있으면 코어가 저장을 거부한다
                assertEquals(BaroChartException.Code.JAVASCRIPT, code(engine::saveDrawings));
                engine.invoke("nativePointer", "cancel", 0, 0, 0);
                assertTrue(engine.saveDrawings().contains("\"schema\":\"aster.drawings\""));
            } finally { engine.close(); }
        });
    }

    @Test public void symbolAndCrosshairValues() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                engine.setSymbol(Symbol.builder("AAPL", "XNAS", "America/New_York", "USD", 2, 0.01).build());
                assertEquals("AAPL", inspect(engine).getJSONObject("symbol").getString("id"));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.setSymbol(Symbol.builder("AAPL", "XNAS", "America/New_York", "USD", -1, 0.01).build())));
                assertEquals("AAPL", inspect(engine).getJSONObject("symbol").getString("id"));
                engine.fit();
                assertNull(engine.crosshair(1200, 700));
                // 봉이 적으면 기본 범위의 오른쪽은 데이터 밖이므로 왼쪽 첫 봉 근처를 가리킨다
                engine.invoke("nativePointer", "move", 0, 100, 200);
                CrosshairValues values = engine.crosshair(1200, 700);
                assertNotNull(values);
                assertTrue("index " + values.index, values.index >= 0 && values.index < 4);
                assertEquals(START + values.index * 60_000.0, values.time, 0);
                assertNotNull(values.bar);
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.crosshair(10, 10)));
            } finally { engine.close(); }
        });
    }

    @Test public void themeRangeAndFitErrors() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(40);
            try {
                Theme broken = new Theme("not-a-color", "#1d2a3a", "#8093ad", "#35d2ab", "#fa6c7c", "#b9c9de", "12px monospace");
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.setTheme(broken)));
                engine.setVisibleRange(new VisibleRange(5, 25));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.setVisibleRange(new VisibleRange(5, 5))));
                VisibleRange kept = engine.visibleRange();
                assertEquals("A rejected range keeps the current one", 5, kept.from, 1e-9);
                assertEquals(25, kept.to, 1e-9);
                engine.fit();
                VisibleRange fitted = engine.visibleRange();
                assertTrue("fit shows more than the 20-bar window: " + fitted.from + ".." + fitted.to, fitted.to - fitted.from > 20);
            } finally { engine.close(); }
        });
    }

    @Test public void saveWorkspaceRejectsInvalidBinding() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                assertTrue(engine.saveWorkspace(BINDING).contains("\"schema\":\"aster.workspace\""));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.saveWorkspace(new DatasetBinding("", "1", "raw", "USD", Adjustment.RAW))));
            } finally { engine.close(); }
        });
    }

    @Test public void restoreWorkspaceRejectsMismatchedBinding() throws Exception {
        AtomicReference<String> document = new AtomicReference<>();
        AtomicReference<BaroChartEngine> target = new AtomicReference<>();
        onMain(() -> {
            BaroChartEngine source = twoPanelEngine(4);
            try { document.set(source.saveWorkspace(BINDING)); } finally { source.close(); }
            target.set(twoPanelEngine(4));
        });
        try {
            BaroChartException error = restore(target.get(), document.get(), new DatasetBinding("OTHER", "1", "raw", "USD", Adjustment.RAW));
            assertNotNull("A mismatched binding must not restore", error);
            assertEquals(error.toString(), BaroChartException.Code.INVALID_ARGUMENT, error.getCode());
            onMain(() -> { target.get().fit(); assertEquals(4, storedBars(target.get())); });
        } finally { onMain(() -> target.get().close()); }
    }

    // ---------------------------------------------------------------------------------------
    // 항목 7: 모든 공개 타입 메서드 표(닫힌 엔진·다른 스레드)
    // ---------------------------------------------------------------------------------------

    /**
     * 공개 타입 메서드를 하나씩 부르는 표. 정적 create와 예외를 던지지 않는 isClosed는 뺀다.
     * close는 닫힌 엔진에서 멱등이므로 다른 스레드 표에만 넣는다.
     * @param restoreCallbacks restoreWorkspace 콜백이 불린 횟수(동기 거부라면 0이어야 한다)
     */
    private static List<Call> everyTypedCall(BaroChartEngine engine, AtomicInteger restoreCallbacks) {
        Bar bar = bars(1, 4).get(0);
        Symbol symbol = Symbol.builder("S", "X", "UTC", "USD", 2, 0.01).build();
        return new ArrayList<>(Arrays.asList(
            new Call("setBars", () -> engine.setBars(bars(4, 0))),
            new Call("apply", () -> engine.apply(DataEvent.append(bar))),
            new Call("addSeries", () -> engine.addSeries(Series.builder("s", SeriesType.LINE).build())),
            new Call("updateSeries", () -> engine.updateSeries("price", SeriesPatch.builder().color("#ffffff").build())),
            new Call("removeSeries", () -> engine.removeSeries("price")),
            new Call("addIndicator", () -> engine.addIndicator(Indicator.ema(3), "e")),
            new Call("setIndicatorParams", () -> engine.setIndicatorParams("e", period(4))),
            new Call("indicatorValue", () -> engine.indicatorValue("e", null, 0)),
            new Call("removeIndicator", () -> engine.removeIndicator("e")),
            new Call("setTool", () -> engine.setTool(DrawingTool.TRENDLINE)),
            new Call("addDrawing", () -> engine.addDrawing(horizontal(START, 1))),
            new Call("updateDrawing", () -> engine.updateDrawing("d", DrawingPatch.builder().visible(true).build())),
            new Call("deleteDrawings", () -> engine.deleteDrawings(Collections.singletonList("d"))),
            new Call("selectDrawing", () -> engine.selectDrawing(null)),
            new Call("undo", engine::undo),
            new Call("redo", engine::redo),
            new Call("saveDrawings", engine::saveDrawings),
            new Call("loadDrawings", () -> engine.loadDrawings("{}")),
            new Call("setTheme", () -> engine.setTheme(Theme.LIGHT)),
            new Call("setSymbol", () -> engine.setSymbol(symbol)),
            new Call("visibleRange", engine::visibleRange),
            new Call("setVisibleRange", () -> engine.setVisibleRange(new VisibleRange(0, 3))),
            new Call("fit", engine::fit),
            new Call("saveWorkspace", () -> engine.saveWorkspace(BINDING)),
            new Call("restoreWorkspace", () -> engine.restoreWorkspace("{}", BINDING, error -> restoreCallbacks.incrementAndGet())),
            new Call("crosshair", () -> engine.crosshair(400, 300))));
    }

    @Test public void everyTypedMethodRejectsClosedEngine() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            engine.close();
            assertTrue(engine.isClosed());
            AtomicInteger restoreCallbacks = new AtomicInteger();
            List<String> wrong = new ArrayList<>();
            for (Call call : everyTypedCall(engine, restoreCallbacks)) {
                BaroChartException.Code observed = code(call.body);
                if (observed != BaroChartException.Code.ENGINE_CLOSED) wrong.add(call.name + "=" + observed);
            }
            assertEquals("Every typed method on a closed engine must throw ENGINE_CLOSED", Collections.emptyList(), wrong);
            assertEquals(0, restoreCallbacks.get());
            engine.close();
            assertTrue("close is idempotent", engine.isClosed());
        });
    }

    @Test public void everyTypedMethodRejectsOtherThread() throws Exception {
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        onMain(() -> engine.set(twoPanelEngine(4)));
        try {
            AtomicInteger restoreCallbacks = new AtomicInteger();
            List<Call> calls = everyTypedCall(engine.get(), restoreCallbacks);
            calls.add(new Call("close", engine.get()::close));
            List<String> wrong = Collections.synchronizedList(new ArrayList<String>());
            AtomicReference<Throwable> crash = new AtomicReference<>();
            // 테스트 러너 스레드가 아닌, 명시적으로 만든 다른 스레드에서 부른다
            Thread worker = new Thread(() -> {
                for (Call call : calls) {
                    try {
                        BaroChartException.Code observed = code(call.body);
                        if (observed != BaroChartException.Code.WRONG_THREAD) wrong.add(call.name + "=" + observed);
                    } catch (Throwable error) {
                        crash.compareAndSet(null, new AssertionError(call.name + " threw a non-BaroChart error", error));
                    }
                }
            }, "typed-off-owner");
            worker.start();
            worker.join(30_000);
            assertFalse("Worker must finish", worker.isAlive());
            if (crash.get() != null) throw new AssertionError(crash.get());
            assertEquals("Every typed method off the owner thread must throw WRONG_THREAD", Collections.emptyList(), wrong);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertEquals(0, restoreCallbacks.get());
            onMain(() -> {
                assertFalse(engine.get().isClosed());
                assertEquals(4, storedBars(engine.get()));
                assertNotNull(series(engine.get(), "price"));
            });
        } finally { onMain(() -> engine.get().close()); }
    }

    // ---------------------------------------------------------------------------------------
    // 항목 8: 이름 변경 이전(aster.workspace v1) 저장본
    // ---------------------------------------------------------------------------------------

    /** androidTest 자산을 바이트 그대로 읽는다 */
    private static byte[] asset(String path) throws Exception {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(path)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }

    /** 첫 번째로 다른 바이트 위치와 주변 문맥을 사람이 읽을 수 있게 만든다 */
    private static String firstDifference(byte[] expected, byte[] actual) {
        int limit = Math.min(expected.length, actual.length), at = 0;
        while (at < limit && expected[at] == actual[at]) at++;
        if (at == limit && expected.length == actual.length) return "identical";
        int from = Math.max(0, at - 40);
        return "first difference at byte " + at + " (expected length " + expected.length + ", actual " + actual.length + ")\nexpected: …"
            + new String(expected, from, Math.min(expected.length, at + 40) - from, StandardCharsets.UTF_8) + "…\nactual:   …"
            + new String(actual, from, Math.min(actual.length, at + 40) - from, StandardCharsets.UTF_8) + "…";
    }

    @Test public void legacyWorkspaceRestoresAndResavesByteIdentically() throws Exception {
        byte[] fixture = asset("legacy/aster-workspace-v1.json");
        String document = new String(fixture, StandardCharsets.UTF_8);
        DatasetBinding binding = new DatasetBinding("legacy-rename", "1", "raw", "USD", Adjustment.RAW);
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        onMain(() -> {
            // test/fixtures/legacy/build-legacy-chart.mjs와 같은 40개 봉
            List<Bar> rows = new ArrayList<>();
            for (int i = 0; i < 40; i++) rows.add(new Bar(START + i * 60_000.0, 100 + i, 103 + i, 99 + i, 102 + i, 500 + i));
            BaroChartEngine created = BaroChartEngine.create(context(), EngineOptions.defaults());
            created.setBars(rows);
            engine.set(created);
        });
        try {
            BaroChartException error = restore(engine.get(), document, binding);
            assertNull("Legacy restore failed: " + error, error);
            AtomicReference<String> saved = new AtomicReference<>();
            onMain(() -> saved.set(engine.get().saveWorkspace(binding)));
            byte[] actual = saved.get().getBytes(StandardCharsets.UTF_8);
            assertArrayEquals(firstDifference(fixture, actual), fixture, actual);
        } finally { onMain(() -> engine.get().close()); }
    }
}
