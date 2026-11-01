package kr.coden.barochart;

import static kr.coden.barochart.TestSupport.context;
import static kr.coden.barochart.TestSupport.onMain;
import static kr.coden.barochart.TestSupport.twoPanelEngine;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.res.Configuration;
import android.widget.FrameLayout;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 한 엔진을 여러 뷰가 보여 줄 때의 시스템 글꼴 배율 소유권 계약(Swift와 공통).
 * 엔진마다 { 소유 뷰, 기준 글꼴, 적용 글꼴 } 기록 하나를 두고, 나중에 켠 뷰가 소유권을 넘겨받되 배율은 원래 기준에서 한 번만 적용한다.
 */
@RunWith(AndroidJUnit4.class)
public class BaroChartViewFontScaleTest {
    /** 코어 기본 테마 글꼴과 fontScale 2.0에서 기대하는 글꼴 */
    private static final String BASE = "12px monospace", SCALED = "24px monospace";

    /** fontScale이 2.0인 컨텍스트. 뷰는 이 컨텍스트의 리소스 구성으로 배율을 읽는다 */
    private static Context scaledContext(Context source) {
        Configuration configuration = new Configuration(source.getResources().getConfiguration());
        configuration.fontScale = 2.0f;
        return source.createConfigurationContext(configuration);
    }

    private static String themeFont(BaroChartEngine engine) throws Exception { return (String) engine.invoke("nativeThemeFont"); }

    @Test public void latestViewTakesOverWithoutDoubleScaling() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                assertEquals(BASE, themeFont(engine));
                Context scaled = scaledContext(context());
                BaroChartView first = new BaroChartView(scaled, engine), second = new BaroChartView(scaled, engine);
                first.setSystemFontScaleEnabled(true);
                assertEquals(SCALED, themeFont(engine));
                second.setSystemFontScaleEnabled(true);
                assertEquals("The scale must be applied once from the original base", SCALED, themeFont(engine));
                assertTrue(first.isSystemFontScaleEnabled());
                assertTrue(second.isSystemFontScaleEnabled());
                first.dispose();
                assertEquals("A former owner must not restore the font", SCALED, themeFont(engine));
                second.dispose();
                assertEquals("The owner restores the base font", BASE, themeFont(engine));
            } finally { engine.close(); }
        });
    }

    @Test public void formerOwnerDisableAndDetachKeepFontUntilOwnerLeaves() throws Exception {
        try (ActivityScenario<TestHostActivity> scenario = ActivityScenario.launch(TestHostActivity.class)) {
            AtomicReference<TestHostActivity> host = new AtomicReference<>();
            scenario.onActivity(host::set);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            onMain(() -> {
                BaroChartEngine engine = twoPanelEngine(30);
                try {
                    Context scaled = scaledContext(host.get());
                    BaroChartView first = new BaroChartView(scaled, engine), second = new BaroChartView(scaled, engine);
                    FrameLayout container = host.get().container();
                    container.addView(first);
                    container.addView(second);
                    first.setSystemFontScaleEnabled(true);
                    second.setSystemFontScaleEnabled(true);
                    // 소유자가 아닌 뷰는 엔진 변경 알림을 받아도 배율을 다시 적용하지 않는다(배율이 겹치지 않는다)
                    engine.fit();
                    assertEquals(SCALED, themeFont(engine));
                    first.setSystemFontScaleEnabled(false);
                    assertFalse(first.isSystemFontScaleEnabled());
                    assertEquals("Disabling a former owner keeps the font", SCALED, themeFont(engine));
                    container.removeView(first);
                    assertEquals("Detaching a former owner keeps the font", SCALED, themeFont(engine));
                    container.removeView(second);
                    assertEquals("Detaching the owner restores the base font", BASE, themeFont(engine));
                    // 다시 붙이면 켜 둔 배율을 다시 적용하고, 소유자가 끄면 기준 글꼴로 돌아간다
                    container.addView(second);
                    assertEquals(SCALED, themeFont(engine));
                    second.setSystemFontScaleEnabled(false);
                    assertEquals(BASE, themeFont(engine));
                    container.removeView(second);
                } finally { engine.close(); }
            });
        }
    }

    @Test public void takeoverAfterAppFontChangeScalesTheNewFont() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                Context scaled = scaledContext(context());
                BaroChartView first = new BaroChartView(scaled, engine), second = new BaroChartView(scaled, engine);
                first.setSystemFontScaleEnabled(true);
                assertEquals(SCALED, themeFont(engine));
                // 앱이 글꼴을 바꾸면 그 글꼴이 새 기준이 된다(창에 붙지 않은 first는 변경을 듣지 않는다)
                engine.setTheme(new JSONObject().put("font", "16px serif"));
                second.setSystemFontScaleEnabled(true);
                assertEquals("32px serif", themeFont(engine));
                second.dispose();
                assertEquals("16px serif", themeFont(engine));
                first.dispose();
                assertEquals("16px serif", themeFont(engine));
            } finally { engine.close(); }
        });
    }
}
