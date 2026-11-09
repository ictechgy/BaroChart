package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.os.Debug;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real-runtime coverage for the typed bar serializer and its allocation contract. */
@RunWith(AndroidJUnit4.class)
public class BarsSerializationTest {
    private static final String TAG = "BaroChartBarsPerf";
    private static final int BAR_COUNT = 200;
    private static final int WARMUP_CALLS = 20;
    private static final int MEASURED_CALLS = 500;
    private final List<File> traceRoots = new ArrayList<>();

    @After public void disableTracing() {
        BaroChartEngine.setTraceDirectoryForTesting(null);
        for (File root : traceRoots) deleteRecursively(root);
        traceRoots.clear();
    }

    @Test public void setBarsWritesFiniteEdgeValuesThroughActualJni() throws Exception {
        File root = new File(TestSupport.context().getCacheDir(), "barochart-bars-wire-" + UUID.randomUUID());
        traceRoots.add(root);
        BaroChartEngine.setTraceDirectoryForTesting(root);
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                engine.setBars(edgeBars());
                assertEquals(3, TestSupport.storedBars(engine));
            } finally {
                engine.close();
            }
        });
        BaroChartEngine.setTraceDirectoryForTesting(null);

        List<String> lines = Files.readAllLines(new File(root, "runtime-1.jsonl").toPath(), StandardCharsets.UTF_8);
        assertEquals("nativeInit", new JSONObject(lines.get(0)).getString("fn"));
        JSONObject call = new JSONObject(lines.get(1));
        assertEquals("nativeCommand", call.getString("fn"));
        String trace = lines.get(1);
        int argsStart = trace.indexOf("\"args\":") + "\"args\":".length();
        int resultStart = trace.lastIndexOf(",\"ok\":");
        assertTrue(trace, argsStart >= "\"args\":".length() && resultStart > argsStart);
        JSONArray legacyArgs = new JSONArray().put("setData").put(new JSONArray().put(LowLevelJson.bars(edgeBars())));
        assertEquals("Legacy and typed setBars wire must match", legacyArgs.toString(), trace.substring(argsStart, resultStart));
        JSONArray args = call.getJSONArray("args");
        assertEquals("setData", args.getString(0));
        JSONArray rows = args.getJSONArray(1).getJSONArray(0);
        assertEquals(3, rows.length());
        assertTrue("Captured wire must preserve negative zero", trace.substring(argsStart, resultStart).contains("\"open\":-0"));
        assertTrue(lines.get(1), lines.get(1).contains("\"time\""));
    }

    @Test public void setBarsUsesAtLeastHalfTheJavaAllocationOfLegacyPath() throws Exception {
        List<Bar> data = benchmarkBars();
        TestSupport.onMain(() -> {
            BaroChartEngine optimized = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            BaroChartEngine legacy = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                for (int i = 0; i < WARMUP_CALLS; i++) {
                    optimized.setBars(data);
                    legacy.setData(LowLevelJson.bars(data));
                }
                long optimizedBytes = measureSetBars(optimized, data);
                long legacyBytes = measureLegacy(legacy, data);
                JSONObject result = new JSONObject().put("schema", "barochart.android-bars-allocation")
                    .put("runId", InstrumentationRegistry.getArguments().getString("runId", "missing-run-id"))
                    .put("barCount", BAR_COUNT).put("warmupCalls", WARMUP_CALLS).put("measuredCalls", MEASURED_CALLS)
                    .put("optimizedBytes", optimizedBytes).put("legacyBytes", legacyBytes)
                    .put("optimizedBytesPerCall", optimizedBytes / (double) MEASURED_CALLS)
                    .put("legacyBytesPerCall", legacyBytes / (double) MEASURED_CALLS)
                    .put("ratio", legacyBytes == 0 ? JSONObject.NULL : optimizedBytes / (double) legacyBytes)
                    .put("counter", "android.os.Debug.getRuntimeStat(art.gc.bytes-allocated)")
                    .put("scope", "ART managed Java cumulative allocation bytes, including JNI-created Java objects; native malloc/QuickJS/Rust allocations excluded");
                result.put("counterAdvanced", optimizedBytes > 0 && legacyBytes > 0)
                    .put("reductionPass", optimizedBytes * 2L <= legacyBytes);
                Log.i(TAG, "BAROCHART_BARS_ALLOCATION_REPORT " + result.getString("runId") + " " + result);
                assertEquals(BAR_COUNT, TestSupport.storedBars(optimized));
                assertEquals(BAR_COUNT, TestSupport.storedBars(legacy));
                assertTrue("ART allocation counter did not advance", optimizedBytes > 0 && legacyBytes > 0);
                assertTrue("setBars allocation reduction below 50%: " + result, optimizedBytes * 2L <= legacyBytes);
            } finally {
                optimized.close();
                legacy.close();
            }
        });
    }

    @Test public void malformedAndEmptyBarsNotifyExactlyOnceAndKeepStateOnError() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            AtomicInteger notifications = new AtomicInteger();
            engine.addChangeListener(() -> notifications.incrementAndGet());
            try {
                engine.setBars(Collections.singletonList(new Bar(TestSupport.START, 1, 2, 0, 1, 1)));
                assertEquals(1, notifications.get());
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, TestSupport.code(() -> engine.setBars(Collections.singletonList(
                    new Bar(TestSupport.START + 60_000, 1, 2, 0, Double.NaN, 1)))));
                assertEquals(1, notifications.get());
                assertEquals(1, TestSupport.storedBars(engine));
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, TestSupport.code(() -> engine.setBars(Collections.singletonList(
                    new Bar(TestSupport.START + 60_000, 1, 0, 2, 1, 1)))));
                assertEquals(1, notifications.get());
                engine.setBars(Collections.<Bar>emptyList());
                assertEquals(2, notifications.get());
                assertEquals(0, TestSupport.storedBars(engine));
            } finally {
                engine.close();
            }
        });
    }

    @Test public void barsUseOneIteratorWithoutSizeGetOrCloseAndPreservePrecheckOrder() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                AtomicInteger iteratorCalls = new AtomicInteger();
                List<Bar> one = new AbstractList<Bar>() {
                    @Override public int size() { throw new AssertionError("setBars must not call size"); }
                    @Override public Bar get(int index) { throw new AssertionError("setBars must not call get"); }
                    @Override public Iterator<Bar> iterator() {
                        iteratorCalls.incrementAndGet();
                        Iterator<Bar> iterator = new Iterator<Bar>() {
                            private boolean returned;
                            @Override public boolean hasNext() { return !returned; }
                            @Override public Bar next() { returned = true; return new Bar(TestSupport.START, 1, 2, 0, 1, 1); }
                            @Override public void remove() { throw new UnsupportedOperationException(); }
                        };
                        return iterator;
                    }
                };
                engine.setBars(one);
                assertEquals(1, iteratorCalls.get());
                assertEquals(1, TestSupport.storedBars(engine));

                List<Bar> reentrant = new AbstractList<Bar>() {
                    @Override public int size() { throw new AssertionError("setBars must not call size"); }
                    @Override public Bar get(int index) { throw new AssertionError("setBars must not call get"); }
                    @Override public Iterator<Bar> iterator() {
                        return new Iterator<Bar>() {
                            private boolean returned;
                            private boolean nested;
                            @Override public boolean hasNext() { return !returned; }
                            @Override public Bar next() {
                                if (!nested) {
                                    nested = true;
                                    engine.setBars(Collections.singletonList(new Bar(TestSupport.START + 60_000, 2, 3, 1, 2, 1)));
                                }
                                returned = true;
                                return new Bar(TestSupport.START + 120_000, 3, 4, 2, 3, 1);
                            }
                            @Override public void remove() { throw new UnsupportedOperationException(); }
                        };
                    }
                };
                engine.setBars(reentrant);
                assertEquals(1, TestSupport.storedBars(engine));
                assertEquals(TestSupport.START + 120_000, TestSupport.inspect(engine).getJSONObject("lastBar").getDouble("time"), 0);

                class CloseTrackingIterator implements Iterator<Bar>, AutoCloseable {
                    private boolean returned;
                    boolean closed;
                    @Override public boolean hasNext() { return !returned; }
                    @Override public Bar next() { returned = true; return new Bar(TestSupport.START, 1, 2, 0, 1, 1); }
                    @Override public void remove() { throw new UnsupportedOperationException(); }
                    @Override public void close() { closed = true; }
                }
                final CloseTrackingIterator[] closeTracking = new CloseTrackingIterator[1];
                List<Bar> closeProbe = new AbstractList<Bar>() {
                    @Override public int size() { throw new AssertionError("setBars must not call size"); }
                    @Override public Bar get(int index) { throw new AssertionError("setBars must not call get"); }
                    @Override public Iterator<Bar> iterator() {
                        closeTracking[0] = new CloseTrackingIterator();
                        return closeTracking[0];
                    }
                };
                engine.setBars(closeProbe);
                assertTrue("Enhanced-for must not close a user iterator", !closeTracking[0].closed);

                List<Bar> throwing = new AbstractList<Bar>() {
                    @Override public int size() { throw new AssertionError("setBars must not call size"); }
                    @Override public Bar get(int index) { throw new AssertionError("setBars must not call get"); }
                    @Override public Iterator<Bar> iterator() {
                        return new Iterator<Bar>() {
                            @Override public boolean hasNext() { throw new IllegalStateException("iterator boom"); }
                            @Override public Bar next() { throw new AssertionError("next must not run"); }
                            @Override public void remove() { throw new UnsupportedOperationException(); }
                        };
                    }
                };
                assertEquals(BaroChartException.Code.UNAVAILABLE, TestSupport.code(() -> engine.setBars(throwing)));
                assertEquals(BaroChartException.Code.UNAVAILABLE, TestSupport.code(() -> engine.setBars(Collections.singletonList(null))));

                engine.close();
                assertEquals(BaroChartException.Code.UNAVAILABLE, TestSupport.code(() -> engine.setBars(null)));
            } finally {
                engine.close();
            }
        });
    }

    @Test public void barsBufferIsLazyClearedBoundedAndReleasedOnClose() throws Exception {
        Field bufferField = BaroChartEngine.class.getDeclaredField("typedBarsBuffer");
        bufferField.setAccessible(true);
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                assertTrue("The reusable buffer must be lazy", bufferField.get(engine) == null);
                engine.setBars(Collections.singletonList(new Bar(TestSupport.START, 1, 2, 0, 1, 1)));
                Object smallBuffer = bufferField.get(engine);
                assertTrue("A small encode keeps a reusable buffer", smallBuffer instanceof StringBuilder);
                assertEquals(0, ((StringBuilder)smallBuffer).length());
                engine.setBars(TestSupport.bars(10_000, 0));
                assertTrue("Oversized buffers must be dropped", bufferField.get(engine) == null);
                engine.setBars(Collections.singletonList(new Bar(TestSupport.START, 1, 2, 0, 1, 1)));
                Object rebuilt = bufferField.get(engine);
                assertTrue(rebuilt instanceof StringBuilder);
                assertEquals(0, ((StringBuilder)rebuilt).length());
                engine.close();
                assertEquals(BaroChartException.Code.ENGINE_CLOSED, TestSupport.code(() -> engine.setBars(Collections.singletonList(
                    new Bar(TestSupport.START, 1, 2, 0, 1, 1)))));
                assertTrue("A closed-engine encode must not republish the buffer", bufferField.get(engine) == null);
            } finally {
                engine.close();
                assertTrue("Closing releases the reusable buffer", bufferField.get(engine) == null);
            }
        });
    }

    @Test public void closeDuringIteratorDoesNotLeaveNestedClosedEncodeBuffer() throws Exception {
        Field bufferField = BaroChartEngine.class.getDeclaredField("typedBarsBuffer");
        bufferField.setAccessible(true);
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                List<Bar> rows = new AbstractList<Bar>() {
                    @Override public int size() { throw new AssertionError("setBars must not call size"); }
                    @Override public Bar get(int index) { throw new AssertionError("setBars must not call get"); }
                    @Override public Iterator<Bar> iterator() {
                        return new Iterator<Bar>() {
                            private boolean returned;
                            @Override public boolean hasNext() { return !returned; }
                            @Override public Bar next() {
                                engine.close();
                                assertEquals(BaroChartException.Code.ENGINE_CLOSED, TestSupport.code(() -> engine.setBars(
                                    Collections.singletonList(new Bar(TestSupport.START, 1, 2, 0, 1, 1)))));
                                returned = true;
                                return new Bar(TestSupport.START, 1, 2, 0, 1, 1);
                            }
                            @Override public void remove() { throw new UnsupportedOperationException(); }
                        };
                    }
                };
                assertEquals(BaroChartException.Code.ENGINE_CLOSED, TestSupport.code(() -> engine.setBars(rows)));
                assertTrue("Close plus nested closed encode must release the buffer", bufferField.get(engine) == null);
            } finally {
                engine.close();
            }
        });
    }

    private static long measureSetBars(BaroChartEngine engine, List<Bar> data) {
        long before = runtimeAllocatedBytes();
        for (int i = 0; i < MEASURED_CALLS; i++) engine.setBars(data);
        return runtimeAllocatedBytes() - before;
    }

    private static long measureLegacy(BaroChartEngine engine, List<Bar> data) throws Exception {
        long before = runtimeAllocatedBytes();
        for (int i = 0; i < MEASURED_CALLS; i++) engine.setData(LowLevelJson.bars(data));
        return runtimeAllocatedBytes() - before;
    }

    private static long runtimeAllocatedBytes() {
        String raw = Debug.getRuntimeStat("art.gc.bytes-allocated");
        if (raw == null) throw new IllegalStateException("ART allocation counter unavailable");
        final long value;
        try {
            value = Long.parseLong(raw.trim());
        } catch (NumberFormatException error) {
            throw new IllegalStateException("ART allocation counter malformed", error);
        }
        if (value < 0) throw new IllegalStateException("ART allocation counter unavailable");
        return value;
    }

    private static List<Bar> edgeBars() {
        return Arrays.asList(
            new Bar(TestSupport.START, -0.0, 100.0, -0.0, 100.0, 1.0),
            new Bar(TestSupport.START + 60_000, Double.MIN_VALUE, Double.MIN_VALUE, Double.MIN_VALUE, Double.MIN_VALUE, Double.MIN_VALUE),
            new Bar(TestSupport.START + 120_000, Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE));
    }

    private static List<Bar> benchmarkBars() {
        List<Bar> out = new ArrayList<>(BAR_COUNT);
        for (int i = 0; i < BAR_COUNT; i++) {
            double close = 100 + Math.sin(i / 13.0) * 2;
            out.add(new Bar(TestSupport.START + i * 60_000.0, close - .4, close + .8, close - .9, close, 500 + i));
        }
        return Collections.unmodifiableList(out);
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        if (file.exists()) file.delete();
    }
}
