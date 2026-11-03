package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.test.ext.junit.runners.AndroidJUnit4;
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

    /** 호출이 정확히 typed UNAVAILABLE인지 확인한다. */
    private static void assertUnavailable(String label, Body body) {
        try {
            body.run();
            fail(label + " must stay unavailable in the M1 Rust backend");
        } catch (RuntimeException error) {
            BaroChartException typed = typed(error);
            assertEquals(label, BaroChartException.Code.UNAVAILABLE, typed.getCode());
            assertTrue(label, typed.getMessage().contains(label) || typed.getMessage().contains("nativeScenePacket"));
        } catch (Exception error) {
            throw new AssertionError(label, error);
        }
    }

    @Test public void rustCreatesWithoutAssetAndRunsOnlyNativeInit() {
        requireRust();
        TestSupport.onMain(() -> {
            BaroChartEngine engine = engine();
            try {
                assertEquals(7.0, ((Number) engine.invoke("nativeInit", 7, JSONObject.NULL)).doubleValue(), 0.0);
                JSONObject metrics = engine.runtimeMetrics();
                assertTrue(metrics.getLong("requestedLiveBytes") >= 1);
                assertTrue(metrics.getLong("requestedPeakBytes") >= metrics.getLong("requestedLiveBytes"));
                assertTrue(metrics.getString("scope").startsWith("Rust engine"));
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
                for (String name : new String[]{"nativeCommand", "nativeSceneJSON", "nativeAsyncBuffer", "nativeScenePacket"}) {
                    assertUnavailable(name, () -> engine.invoke(name));
                }
                assertUnavailable("nativeScenePacket", () -> engine.scenePacket("scene", null, 320, 240, false));
                assertUnavailable("nativeIndicatorBuffer", () -> engine.indicatorBytes("missing", "value", 0, 1));
                java.lang.reflect.Field field=BaroChartEngine.class.getDeclaredField("handle");field.setAccessible(true);long handle=field.getLong(engine);
                BaroChartColumns columns=BaroChartColumns.copyOf(new double[]{0},new double[]{1},new double[]{1},new double[]{1},new double[]{1},new double[]{1});
                assertUnavailable("nativeAsyncTargetBuffer", () -> columns.copyInto(handle,0,0,1));
            } finally {
                engine.close();
            }
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
                BaroChartEngine.create(TestSupport.context(),EngineOptions.defaults());
                fail("Rust-only artifact must reject JavaScript creation");
            } catch (RuntimeException error) {
                BaroChartException typed=typed(error);
                assertEquals(BaroChartException.Code.UNAVAILABLE,typed.getCode());
                assertTrue(typed.getMessage(),typed.getMessage().contains("javaScript backend is not included"));
            }
        });
    }
}
