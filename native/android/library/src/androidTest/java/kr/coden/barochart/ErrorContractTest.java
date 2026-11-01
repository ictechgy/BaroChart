package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Android 뷰·엔진 오류 계약: 앱이 부르는 메서드는 던지고, 던질 수 없는 경로는 리스너로 전달한다. */
@RunWith(AndroidJUnit4.class)
public class ErrorContractTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    /** 메인 스레드에서 실행하고, 그 안에서 난 오류를 테스트 스레드로 다시 던진다 */
    private void onMain(ThrowingRunnable body) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { body.run(); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private interface ThrowingRunnable { void run() throws Exception; }

    @Test
    public void unknownToolThrowsTypedErrorInsteadOfSwallowing() {
        onMain(() -> {
            BaroChartEngine engine = new BaroChartEngine(context, 0);
            BaroChartView view = new BaroChartView(context, engine);
            try {
                view.setTool("bogus");
                fail("Unknown tool must throw");
            } catch (BaroChartException expected) {
                assertEquals(BaroChartException.Code.JAVASCRIPT, expected.getCode());
                assertTrue(expected.getMessage(), expected.getMessage().contains("Unknown drawing tool"));
                assertTrue(expected.getRecovery().length() > 0);
            } finally {
                engine.close();
            }
        });
    }

    @Test
    public void closedEngineMapsToEngineClosed() {
        onMain(() -> {
            BaroChartEngine engine = new BaroChartEngine(context, 0);
            engine.close();
            try {
                engine.fit();
                fail("Closed engine must reject commands");
            } catch (RuntimeException error) {
                assertEquals(BaroChartException.Code.ENGINE_CLOSED, BaroChartException.wrap(error).getCode());
            }
        });
    }

    @Test
    public void offOwnerThreadMapsToWrongThread() throws Exception {
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        onMain(() -> engine.set(new BaroChartEngine(context, 0)));
        try {
            engine.get().fit();
            fail("Off-owner call must be rejected");
        } catch (RuntimeException error) {
            assertEquals(BaroChartException.Code.WRONG_THREAD, BaroChartException.wrap(error).getCode());
        } finally {
            onMain(() -> engine.get().close());
        }
    }

    @Test
    public void drawFailureReachesListenerWithoutCrashing() {
        onMain(() -> {
            BaroChartEngine engine = new BaroChartEngine(context, 0);
            BaroChartView view = new BaroChartView(context, engine);
            view.layout(0, 0, 320, 240);
            List<BaroChartException> received = new ArrayList<>();
            view.setOnChartErrorListener(received::add);
            engine.close();
            view.draw(new Canvas(Bitmap.createBitmap(320, 240, Bitmap.Config.ARGB_8888)));
            assertEquals(1, received.size());
            assertEquals(BaroChartException.Code.ENGINE_CLOSED, received.get(0).getCode());
            assertNotNull(view.getLastError());
        });
    }
}
