package kr.coden.barochart;

import static kr.coden.barochart.TestSupport.bars;
import static kr.coden.barochart.TestSupport.context;
import static kr.coden.barochart.TestSupport.onMain;
import static kr.coden.barochart.TestSupport.storedBars;
import static kr.coden.barochart.TestSupport.twoPanelEngine;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * BaroChartView 수명주기: dispose() 계약(항목 4)과 닫힌 엔진으로 창에 붙을 때 크래시하지 않는 계약(항목 5).
 * 구독은 창에 붙어야 생기므로 실제 액티비티 창의 컨테이너에 뷰를 붙여 확인한다.
 */
@RunWith(AndroidJUnit4.class)
public class BaroChartViewLifecycleTest {
    private static final int WIDTH = 400, HEIGHT = 300;

    /** 창에 붙은 테스트 액티비티를 받는 본문 */
    private interface HostBody { void run(TestHostActivity host) throws Exception; }

    /**
     * 테스트 액티비티를 띄우고 첫 프레임까지 기다린 뒤 본문을 실행한다. 끝나면 액티비티를 닫는다.
     * 컨테이너가 이미 창에 붙어 있어야 addView 안에서 onAttachedToWindow가 동기적으로 불린다.
     */
    private static void withHost(HostBody body) throws Exception {
        try (ActivityScenario<TestHostActivity> scenario = ActivityScenario.launch(TestHostActivity.class)) {
            AtomicReference<TestHostActivity> host = new AtomicReference<>();
            scenario.onActivity(host::set);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            onMain(() -> assertTrue("The host container must already be attached", host.get().container().isAttachedToWindow()));
            body.run(host.get());
        }
    }

    /** 뷰를 창의 컨테이너에 붙이고 즉시 크기를 정한다(다음 레이아웃 패스를 기다리지 않는다) */
    private static BaroChartView attach(TestHostActivity host, BaroChartEngine engine) {
        BaroChartView view = new BaroChartView(host, engine);
        host.container().addView(view, new FrameLayout.LayoutParams(WIDTH, HEIGHT));
        view.layout(0, 0, WIDTH, HEIGHT);
        return view;
    }

    /** 비트맵 캔버스에 강제로 그린다. View.draw는 dirty 플래그를 지우므로 이후 무효화를 isDirty()로 볼 수 있다. */
    private static void draw(BaroChartView view) {
        view.draw(new Canvas(Bitmap.createBitmap(Math.max(1, view.getWidth()), Math.max(1, view.getHeight()), Bitmap.Config.ARGB_8888)));
    }

    private static MotionEvent touchDown() {
        long now = SystemClock.uptimeMillis();
        return MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 100, 100, 0);
    }

    private static MotionEvent mouseHover() {
        long now = SystemClock.uptimeMillis();
        MotionEvent hover = MotionEvent.obtain(now, now, MotionEvent.ACTION_HOVER_MOVE, 120, 120, 0);
        hover.setSource(InputDevice.SOURCE_MOUSE);
        return hover;
    }

    /** 코어로 가는 모든 입력 경로(터치·키·hover·접근성)를 한 번씩 보낸다 */
    private static void sendEveryInput(BaroChartView view, List<Boolean> handled) {
        MotionEvent down = touchDown(), hover = mouseHover();
        try {
            handled.add(view.onTouchEvent(down));
            handled.add(view.onKeyDown(KeyEvent.KEYCODE_DPAD_LEFT, new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT)));
            view.onHoverEvent(hover);
            handled.add(view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null));
            handled.add(view.performAccessibilityAction(BaroChartView.ACTION_ZOOM_IN, null));
            handled.add(view.performAccessibilityAction(BaroChartView.ACTION_CLEAR_CROSSHAIR, null));
        } finally { down.recycle(); hover.recycle(); }
    }

    // ---------------------------------------------------------------------------------------
    // 항목 4: dispose()
    // ---------------------------------------------------------------------------------------

    @Test public void disposeStopsInvalidationAndDrawing() throws Exception {
        withHost(host -> onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(30);
            try {
                BaroChartView view = attach(host, engine);
                int[] submitted = {0};
                view.setDrawProbe(timing -> submitted[0]++);
                draw(view);
                assertEquals("Sanity: an attached view draws the engine", 1, submitted[0]);
                assertFalse(view.isDirty());
                engine.fit();
                assertTrue("Sanity: engine changes invalidate an attached view", view.isDirty());
                assertFalse(view.isDisposed());

                view.dispose();
                assertTrue(view.isDisposed());
                draw(view);
                long rendered = view.renderedRevision;
                assertFalse(view.isDirty());
                engine.setBars(bars(30, 1));
                engine.fit();
                assertFalse("Engine mutations must not invalidate a disposed view", view.isDirty());
                draw(view);
                assertEquals("A disposed view must not draw the engine", 1, submitted[0]);
                assertEquals(rendered, view.renderedRevision);
                host.container().removeView(view);
            } finally { engine.close(); }
        }));
    }

    @Test public void disposeReleasesBitmapCaches() throws Exception {
        withHost(host -> onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(30);
            try {
                BaroChartView view = attach(host, engine);
                draw(view);
                assertTrue("Sanity: an attached view caches bitmaps " + view.renderCacheMetrics(), view.renderCacheMetrics().getLong("ownedBitmapBytes") > 0);
                view.dispose();
                assertEquals(0, view.renderCacheMetrics().getLong("ownedBitmapBytes"));
                assertFalse(view.renderCacheMetrics().getBoolean("frameCacheCreated"));
                draw(view);
                assertEquals("Drawing a disposed view must not rebuild caches", 0, view.renderCacheMetrics().getLong("ownedBitmapBytes"));
                host.container().removeView(view);
            } finally { engine.close(); }
        }));
    }

    @Test public void disposedViewIgnoresInput() throws Exception {
        withHost(host -> onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(30);
            try {
                engine.setVisibleRange(new VisibleRange(5, 25));
                BaroChartView view = attach(host, engine);
                int[] interactions = {0};
                List<BaroChartException> errors = new ArrayList<>();
                view.setOnInteractionListener(() -> interactions[0]++);
                view.setOnChartErrorListener(errors::add);
                view.dispose();
                long revision = engine.revision();
                VisibleRange before = engine.visibleRange();

                List<Boolean> handled = new ArrayList<>();
                sendEveryInput(view, handled);
                assertEquals("A disposed view must not consume input: touch, key, scroll, zoom, clear", Collections.nCopies(5, Boolean.FALSE), handled);
                AccessibilityNodeInfo info = view.createAccessibilityNodeInfo();
                assertFalse(info.isScrollable());
                for (AccessibilityNodeInfo.AccessibilityAction action : info.getActionList())
                    assertTrue("Unexpected chart action " + action, action.getId() != BaroChartView.ACTION_ZOOM_IN && action.getId() != BaroChartView.ACTION_ZOOM_OUT);

                assertEquals(0, interactions[0]);
                assertEquals(revision, engine.revision());
                assertEquals(before.from, engine.visibleRange().from, 1e-9);
                assertEquals(before.to, engine.visibleRange().to, 1e-9);
                assertNull("Input must not create a crosshair", engine.crosshair(WIDTH, HEIGHT));
                assertEquals(Collections.emptyList(), errors);
                host.container().removeView(view);
            } finally { engine.close(); }
        }));
    }

    @Test public void disposedViewNeverTouchesEngineAgain() throws Exception {
        withHost(host -> onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(30);
            BaroChartView view = attach(host, engine);
            List<BaroChartException> errors = new ArrayList<>();
            view.setOnChartErrorListener(errors::add);
            draw(view);
            view.dispose();
            // 이후 뷰가 엔진을 한 번이라도 만지면 닫힌 엔진이 ENGINE_CLOSED를 리스너로 보낸다
            engine.close();
            draw(view);
            sendEveryInput(view, new ArrayList<Boolean>());
            view.createAccessibilityNodeInfo();
            view.layout(0, 0, WIDTH / 2, HEIGHT / 2);
            view.onConfigurationChanged(host.getResources().getConfiguration());
            view.setRenderCacheEnabled(false);
            host.container().removeView(view);
            host.container().addView(view);
            host.container().removeView(view);
            view.dispose();
            assertEquals("A disposed view must never call the engine again", Collections.emptyList(), errors);
            assertNull(view.getLastError());
        }));
    }

    @Test public void disposeKeepsEngineUsableAndIsIdempotent() throws Exception {
        withHost(host -> onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(30);
            try {
                BaroChartView view = attach(host, engine);
                draw(view);
                view.dispose();
                view.dispose();
                assertTrue(view.isDisposed());
                assertFalse("dispose never closes the engine", engine.isClosed());
                engine.setBars(bars(10, 0));
                engine.fit();
                assertEquals(10, storedBars(engine));
                // 같은 엔진을 새 뷰가 이어서 그릴 수 있다
                BaroChartView next = attach(host, engine);
                draw(next);
                assertNull(next.getLastError());
                assertEquals(engine.revision(), next.renderedRevision);
                host.container().removeView(view);
                host.container().removeView(next);
            } finally { engine.close(); }
        }));
    }

    @Test public void disposeAfterEngineCloseIsSilent() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(30);
            BaroChartView view = new BaroChartView(context(), engine);
            view.layout(0, 0, WIDTH, HEIGHT);
            List<BaroChartException> errors = new ArrayList<>();
            view.setOnChartErrorListener(errors::add);
            draw(view);
            engine.close();
            view.dispose();
            assertTrue(view.isDisposed());
            assertEquals("Disposing after the engine closed must not report errors", Collections.emptyList(), errors);
        });
    }

    // ---------------------------------------------------------------------------------------
    // 항목 5: 닫힌 엔진으로 창에 붙기
    // ---------------------------------------------------------------------------------------

    @Test public void attachWithClosedEngineReportsInsteadOfCrashing() throws Exception {
        withHost(host -> onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            engine.close();
            BaroChartView view = new BaroChartView(host, engine);
            List<BaroChartException> errors = new ArrayList<>();
            view.setOnChartErrorListener(errors::add);
            host.container().addView(view, new FrameLayout.LayoutParams(WIDTH, HEIGHT));
            assertTrue(view.isAttachedToWindow());
            assertFalse("The listener must receive the attach failure", errors.isEmpty());
            assertEquals(BaroChartException.Code.ENGINE_CLOSED, errors.get(0).getCode());
            // 붙은 뒤에도 비활성으로 남는다: 입력을 받지 않고, 떼어도 크래시하지 않는다
            MotionEvent down = touchDown();
            try { assertFalse(view.onTouchEvent(down)); } finally { down.recycle(); }
            host.container().removeView(view);
            assertFalse(view.isAttachedToWindow());
        }));
        // 다음 프레임 콜백에서도 터지지 않는지 메인 루퍼가 한 번 비워질 때까지 기다린다
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    @Test public void attachWithEngineOwnedByAnotherThreadReportsWrongThread() throws Exception {
        ExecutorService owner = Executors.newSingleThreadExecutor();
        try {
            BaroChartEngine engine = owner.submit(() -> twoPanelEngine(4)).get(30, TimeUnit.SECONDS);
            try {
                withHost(host -> onMain(() -> {
                    BaroChartView view = new BaroChartView(host, engine);
                    List<BaroChartException> errors = new ArrayList<>();
                    view.setOnChartErrorListener(errors::add);
                    host.container().addView(view, new FrameLayout.LayoutParams(WIDTH, HEIGHT));
                    assertFalse("The listener must receive the attach failure", errors.isEmpty());
                    assertEquals(BaroChartException.Code.WRONG_THREAD, errors.get(0).getCode());
                    host.container().removeView(view);
                }));
            } finally { owner.submit(engine::close).get(30, TimeUnit.SECONDS); }
        } finally { owner.shutdownNow(); }
    }
}
