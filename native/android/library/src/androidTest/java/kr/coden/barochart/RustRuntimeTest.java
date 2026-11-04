package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** M1 Rust 스캐폴드 런타임: nativeInit만 성공하고 나머지는 JS fallback 없이 UNAVAILABLE이다. */
@RunWith(AndroidJUnit4.class)
public class RustRuntimeTest {
    /** 예외를 던질 수 있는 Rust 스캐폴드 호출. */
    private interface Body { void run() throws Exception; }
    /** Rust 내부 선택 훅으로 엔진을 만든다. */
    private static BaroChartEngine engine() {
        return BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults(),
            BaroChartEngine.RuntimeBackend.RUST);
    }

    /** Rust backend이 포함된 구성에서만 런타임 테스트를 진행한다. */
    private static void requireRust() { Assume.assumeTrue(BuildConfig.BAROCHART_WITH_RUST); }

    /** 저수준 오류를 타입 분류기로 바꾼다. */
    private static BaroChartException typed(RuntimeException error) {
        return BaroChartException.wrap(error);
    }

    @Test public void explicitJavaScriptSurvivesRustDefaultAndBackendIsImmutable() {
        Assume.assumeTrue(BuildConfig.BAROCHART_WITH_QUICKJS);
        TestSupport.onMain(() -> {
            EngineBackend previous = BaroChartEngine.getDefaultBackend();
            try {
                BaroChartEngine.setDefaultBackend(EngineBackend.RUST);
                BaroChartEngine selected = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults(), EngineBackend.JAVASCRIPT);
                try {
                    assertEquals(EngineBackend.JAVASCRIPT, selected.backend());
                } finally {
                    selected.close();
                }
            } finally {
                BaroChartEngine.setDefaultBackend(previous);
            }
        });
    }

    @Test public void legacyConstructorSnapshotsRustDefault() {
        TestSupport.onMain(() -> {
            EngineBackend previous = BaroChartEngine.getDefaultBackend();
            try {
                BaroChartEngine.setDefaultBackend(EngineBackend.RUST);
                if (BuildConfig.BAROCHART_WITH_RUST) {
                    BaroChartEngine selected = new BaroChartEngine(TestSupport.context(), 0);
                    try { assertEquals(EngineBackend.RUST, selected.backend()); }
                    finally { selected.close(); }
                } else {
                    try {
                        new BaroChartEngine(TestSupport.context(), 0);
                        fail("Rust default must not fall back to JavaScript");
                    } catch (RuntimeException error) {
                        assertEquals(BaroChartException.Code.UNAVAILABLE, typed(error).getCode());
                    }
                }
            } finally {
                BaroChartEngine.setDefaultBackend(previous);
            }
        });
    }

    /** 호출이 정확히 typed UNAVAILABLE인지 확인한다. */
    private static void assertUnavailable(String label, Body body) {
        try {
            body.run();
            fail(label + " must stay unavailable in the Rust backend");
        } catch (RuntimeException error) {
            BaroChartException typed = typed(error);
            assertEquals(label, BaroChartException.Code.UNAVAILABLE, typed.getCode());
            String expected = label.equals("nativeRegisterIndicatorSource")
                ? "Indicator source registration requires the javaScript backend"
                : label + " is not available in the Rust backend";
            assertEquals(label, expected, typed.getMessage());
        } catch (Exception error) {
            throw new AssertionError(label, error);
        }
    }

    @Test public void rustCreatesWithoutAssetAndOwnsInitializedData() {
        requireRust();
        TestSupport.onMain(() -> {
            BaroChartEngine engine = engine();
            try {
                assertEquals(7.0, ((Number) engine.invoke("nativeInit", 7, JSONObject.NULL)).doubleValue(), 0.0);
                JSONObject metrics = engine.runtimeMetrics();
                assertTrue(metrics.getLong("requestedLiveBytes") >= 1);
                assertTrue(metrics.getLong("requestedPeakBytes") >= metrics.getLong("requestedLiveBytes"));
                assertEquals("Rust engine accounted requested bytes for owned payloads, call temporaries and FFI outputs; not allocator RSS; live handle counts include all engines of both backends and current isolated workers in this process",metrics.getString("scope"));
            } finally {
                engine.close();
            }
        });
    }

    @Test public void rustUnavailableNeverFallsBackToJavaScript() {
        requireRust();
        TestSupport.onMain(() -> {
            BaroChartEngine engine = engine();
            try {
                for (String name : new String[]{"nativeWorkspaceTargetDispose", "nativeWorkspaceSourceBuffer", "nativeWorkspaceSourceDispose",
                    "nativeAsyncUI", "nativeRegisterIndicatorSource", "nativeAnalysisDemo", "nativeAnalysisReload",
                    "nativeStudyVerification", "nativePublicationOrderSelfTest", "nativeSelfTest", "nativeExtendedSelfTest",
                    "nativeHardeningSelfTest", "nativeComparisonDemo", "nativeComparisonReadout", "nativeComparisonAction",
                    "nativeAxesSelfTest", "nativeParamsTargetDispose"}) {
                    assertUnavailable(name, () -> engine.invoke(name));
                }
            } finally {
                engine.close();
            }
        });
    }

    @Test public void rustTypedBarsIndicatorsAndScenePacketUseNativeCore() {
        requireRust();
        TestSupport.onMain(() -> {
            BaroChartEngine engine = engine();
            try {
                engine.setBars(TestSupport.bars(5, 0));
                engine.addIndicator(Indicator.sma(3), "sma3");
                byte[] raw = engine.indicatorBytes("sma3", "value", 0, 5);
                assertEquals(5 * Double.BYTES, raw.length);
                java.nio.DoubleBuffer values = ByteBuffer.wrap(raw).order(ByteOrder.nativeOrder()).asDoubleBuffer();
                assertTrue(Double.isNaN(values.get(0)));
                assertTrue(Double.isNaN(values.get(1)));
                assertEquals(103.0, values.get(2), 0.0);
                assertTrue(Double.isFinite(values.get(3)));
                BaroChartEngine.ScenePacket packet = engine.scenePacket("scene", null, 320, 240, false);
                assertTrue(packet.commandCount > 0);
                assertTrue(packet.numbers.length > 0);
            } finally {
                engine.close();
            }
        });
    }

    @Test public void unknownFunctionKeepsQuickJsHostText() {
        requireRust();
        TestSupport.onMain(() -> {
            BaroChartEngine engine = engine();
            try {
                engine.invoke("__not_a_native_function");
                fail("Unknown function must fail");
            } catch (IllegalStateException error) {
                assertEquals("TypeError: not a function", error.getMessage());
            } finally { engine.close(); }
        });
    }

    @Test public void unavailablePrefixWinsOverSubstringClassifiers() {
        BaroChartException error = typed(new IllegalStateException(
            "UnavailableError: Indicator module requires the javaScript backend: my.cancel-budget@1/x"));
        assertEquals(BaroChartException.Code.UNAVAILABLE, error.getCode());
        assertEquals("Indicator module requires the javaScript backend: my.cancel-budget@1/x", error.getMessage());
    }

    @Test public void rustClosedAndWrongThreadMatchJavaScriptHostErrors() throws Exception {
        requireRust();
        AtomicReference<BaroChartEngine> reference = new AtomicReference<>();
        TestSupport.onMain(() -> reference.set(engine()));
        try {
            reference.get().invoke("nativeInit");
            fail("Off-owner Rust call must fail");
        } catch (RuntimeException error) {
            assertEquals(BaroChartException.Code.WRONG_THREAD, typed(error).getCode());
        }
        TestSupport.onMain(() -> {
            reference.get().close();
            assertTrue(reference.get().isClosed());
            try {
                reference.get().invoke("nativeInit");
                fail("Closed Rust engine must fail");
            } catch (RuntimeException error) {
                assertEquals(BaroChartException.Code.ENGINE_CLOSED, typed(error).getCode());
            }
        });
    }

    @Test public void javaTimeCallbacksResolveCanonicalZonesAndOffsets() {
        assertEquals("Asia/Seoul", BaroChartEngine.zoneResolve("asia/seoul"));
        assertEquals(0, BaroChartEngine.zoneOffsetSeconds(0, "UTC"));
        assertEquals(9 * 60 * 60, BaroChartEngine.zoneOffsetSeconds(0, "Asia/Seoul"));
        assertFalse(BaroChartEngine.zoneResolve("UTC").isEmpty());
    }

    @Test public void malformedRustErrorEnvelopeUsesFixedStatusText() {
        assertEquals("Error: Chart disposed", BaroChartEngine.rustErrorMessage(3,"{private input"));
        assertEquals("Rust core busy", BaroChartEngine.rustErrorMessage(5,"null"));
        assertEquals("TypeError: Invalid Rust core transport", BaroChartEngine.rustErrorMessage(6,"not-json"));
        assertEquals("InternalError: out of memory", BaroChartEngine.rustErrorMessage(7,null));
        assertEquals("RangeError: Out of memory", BaroChartEngine.rustErrorMessage(8,null));
        assertEquals("Rust engine unavailable", BaroChartEngine.rustErrorMessage(2,null));
    }

    @Test public void missingRustBackendIsTypedUnavailable() {
        Assume.assumeFalse(BuildConfig.BAROCHART_WITH_RUST);
        TestSupport.onMain(() -> {
            try {
                engine();
                fail("JS-only artifact must reject Rust creation");
            } catch (RuntimeException error) {
                BaroChartException typed=typed(error);
                assertEquals(BaroChartException.Code.UNAVAILABLE,typed.getCode());
                assertTrue(typed.getMessage(),typed.getMessage().contains("rust backend is not included"));
            }
        });
    }

    @Test public void missingJavaScriptBackendIsTypedUnavailable() {
        Assume.assumeFalse(BuildConfig.BAROCHART_WITH_QUICKJS);
        TestSupport.onMain(() -> {
            try {
                BaroChartEngine.create(TestSupport.context(),EngineOptions.defaults(), BaroChartEngine.RuntimeBackend.JAVASCRIPT);
                fail("Rust-only artifact must reject JavaScript creation");
            } catch (RuntimeException error) {
                BaroChartException typed=typed(error);
                assertEquals(BaroChartException.Code.UNAVAILABLE,typed.getCode());
                assertTrue(typed.getMessage(),typed.getMessage().contains("javaScript backend is not included"));
            }
        });
    }

    @Test public void dataAndIngestionCommandsUseRealRustOwnedPayloads() {
        requireRust();
        TestSupport.onMain(() -> {
            BaroChartEngine engine = engine();
            try {
                engine.invoke("nativeInit", 0, new JSONObject());
                JSONObject bar = new JSONObject().put("time",1000).put("open",1).put("high",2).put("low",0).put("close",1).put("volume",1);
                engine.invoke("nativeCommand", "setData", new org.json.JSONArray().put(new org.json.JSONArray().put(bar)));
                JSONObject configured=(JSONObject)engine.invoke("nativeDataIngestionCommand","configureDataIngestion",new org.json.JSONArray().put(new JSONObject().put("streamId","native").put("generation",1)));
                assertEquals("native",configured.getJSONObject("result").getJSONObject("policy").getString("streamId"));
                JSONObject next=new JSONObject().put("time",2000).put("open",2).put("high",3).put("low",1).put("close",2).put("volume",1);
                JSONObject packet=new JSONObject().put("streamId","native").put("generation",1).put("firstSequence",0).put("events",new org.json.JSONArray().put(new JSONObject().put("kind","append").put("bar",next)));
                JSONObject enqueued=(JSONObject)engine.invoke("nativeDataIngestionCommand","enqueueDataEvents",new org.json.JSONArray().put(packet));
                assertEquals(1,enqueued.getJSONObject("result").getInt("pendingEvents"));
                JSONObject drained=(JSONObject)engine.invoke("nativeDataIngestionCommand","drainDataEvents");
                assertEquals(2,drained.getJSONObject("result").getInt("length"));
                engine.invoke("nativeReleaseDataIngestion");
                JSONObject closed=(JSONObject)engine.invoke("nativeDataIngestionCommand","dataIngestionStats");
                assertEquals("CLOSED",closed.getJSONObject("error").getString("code"));
            } finally {engine.close();}
        });
    }
}
