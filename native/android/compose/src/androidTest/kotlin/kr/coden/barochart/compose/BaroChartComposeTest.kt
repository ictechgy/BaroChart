package kr.coden.barochart.compose

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import kr.coden.barochart.Bar
import kr.coden.barochart.BaroChartEngine
import kr.coden.barochart.BaroChartException
import kr.coden.barochart.BaroChartView
import kr.coden.barochart.EngineOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Compose 래퍼는 사라질 때 뷰만 정리하고 엔진은 닫지 않으며, 재구성되면 같은 엔진을 그린다. */
@RunWith(AndroidJUnit4::class)
class BaroChartComposeTest {
    @get:Rule val compose = createComposeRule()

    private fun engine(): BaroChartEngine {
        val engine = BaroChartEngine.create(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext, EngineOptions.defaults())
        engine.setBars((0 until 30).map { Bar(1_700_000_000_000.0 + it * 60_000.0, 100.0, 102.0, 99.0, 101.0, 10.0) })
        return engine
    }

    /** 테스트 화면을 강제로 그려 renderedRevision·오류 리스너를 갱신한다 */
    private fun render(view: BaroChartView) {
        view.draw(Canvas(Bitmap.createBitmap(maxOf(1, view.width), maxOf(1, view.height), Bitmap.Config.ARGB_8888)))
    }

    @Test fun releaseDisposesViewNotEngine() {
        var engine: BaroChartEngine? = null
        compose.runOnUiThread { engine = engine() }
        var shown by mutableStateOf(true)
        var created: BaroChartView? = null
        compose.setContent { if (shown) BaroChartInternal(engine!!, onViewCreated = { created = it }) }
        compose.waitForIdle()
        val view = created
        assertNotNull(view)
        compose.runOnUiThread { shown = false }
        compose.waitForIdle()
        compose.runOnUiThread {
            assertFalse("Compose release must detach the chart view", view!!.isAttachedToWindow)
            assertTrue("Compose release must dispose the chart view", view.isDisposed)
            assertFalse("Compose release must not close the app-owned engine", engine!!.isClosed)
            // 엔진은 그대로 쓸 수 있어야 한다
            engine.fit()
            engine.close()
        }
    }

    @Test fun recompositionWithNewKeyRendersSameEngine() {
        var engine: BaroChartEngine? = null
        compose.runOnUiThread { engine = engine() }
        var generation by mutableIntStateOf(0)
        val views = mutableListOf<BaroChartView>()
        compose.setContent { key(generation) { BaroChartInternal(engine!!, onViewCreated = { views += it }) } }
        compose.waitForIdle()
        compose.runOnUiThread { generation = 1 }
        compose.waitForIdle()
        compose.runOnUiThread {
            assertEquals(2, views.size)
            assertNotSame(views[0], views[1])
            assertTrue("The replaced view must be disposed", views[0].isDisposed)
            assertFalse("The new view must stay live", views[1].isDisposed)
            render(views[1])
            assertTrue("A recreated view must render the same engine", views[1].renderedRevision > 0)
            engine!!.close()
        }
    }

    @Test fun onErrorDelivered() {
        var engine: BaroChartEngine? = null
        compose.runOnUiThread { engine = engine() }
        val errors = mutableListOf<BaroChartException>()
        var created: BaroChartView? = null
        compose.setContent { BaroChartInternal(engine!!, onError = { errors += it }, onViewCreated = { created = it }) }
        compose.waitForIdle()
        compose.runOnUiThread {
            engine!!.close()
            render(created!!)
            assertEquals(BaroChartException.Code.ENGINE_CLOSED, errors.firstOrNull()?.code)
        }
    }

    @Test fun configureRunsOncePerCreatedView() {
        var first: BaroChartEngine? = null
        var second: BaroChartEngine? = null
        compose.runOnUiThread { first = engine(); second = engine() }
        var current by mutableStateOf(first!!)
        var tick by mutableIntStateOf(0)
        var compositions = 0
        val configured = mutableListOf<BaroChartView>()
        compose.setContent {
            // tick이 바뀔 때마다 modifier가 달라져 BaroChart가 실제로 재구성된다
            val tag = "chart-$tick"
            SideEffect { compositions++ }
            BaroChart(engine = current, modifier = Modifier.testTag(tag), configure = { view ->
                configured += view
                view.setSystemFontScaleEnabled(true)
            })
        }
        compose.waitForIdle()
        repeat(3) {
            compose.runOnUiThread { tick++ }
            compose.waitForIdle()
        }
        compose.runOnUiThread {
            assertTrue("The content must recompose, saw $compositions compositions", compositions >= 4)
            assertEquals("configure must run once per created view, not on recomposition", 1, configured.size)
            assertSame(first, configured[0].engine)
            assertTrue("A setting applied in configure must be visible on the view", configured[0].isSystemFontScaleEnabled)
            current = second!!
        }
        compose.waitForIdle()
        compose.runOnUiThread {
            assertEquals("A new engine creates one new view, configured once", 2, configured.size)
            assertSame(second, configured[1].engine)
            assertTrue(configured[1].isSystemFontScaleEnabled)
            assertTrue("The view of the previous engine is disposed", configured[0].isDisposed)
            assertFalse(first!!.isClosed)
            first!!.close()
            second!!.close()
        }
    }

    /** 엔진의 현재 테마 글꼴 */
    private fun themeFont(engine: BaroChartEngine): String = engine.invoke("nativeThemeFont") as String

    @Test fun configureFontScaleSurvivesSameEngineRecreation() {
        var engine: BaroChartEngine? = null
        var scaled: Context? = null
        compose.runOnUiThread {
            engine = engine()
            // fontScale 2.0인 컨텍스트로 뷰를 만들어 배율이 한 번(×2)인지 두 번(×4)인지 구분한다
            val source = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
            scaled = source.createConfigurationContext(Configuration(source.resources.configuration).apply { fontScale = 2f })
            assertEquals("12px monospace", themeFont(engine!!))
        }
        var generation by mutableIntStateOf(0)
        var shown by mutableStateOf(true)
        val configured = mutableListOf<BaroChartView>()
        compose.setContent {
            CompositionLocalProvider(LocalContext provides scaled!!) {
                if (shown) key(generation) {
                    BaroChart(engine = engine!!, configure = { view -> configured += view; view.setSystemFontScaleEnabled(true) })
                }
            }
        }
        compose.waitForIdle()
        compose.runOnUiThread { assertEquals("24px monospace", themeFont(engine!!)) }
        compose.runOnUiThread { generation = 1 }
        compose.waitForIdle()
        compose.runOnUiThread {
            assertEquals(2, configured.size)
            assertTrue("The replaced view is disposed", configured[0].isDisposed)
            assertTrue(configured[1].isSystemFontScaleEnabled)
            assertEquals("Recreating the view must scale the font once", "24px monospace", themeFont(engine!!))
        }
        compose.runOnUiThread { shown = false }
        compose.waitForIdle()
        compose.runOnUiThread {
            assertTrue(configured[1].isDisposed)
            assertEquals("Removing the composable restores the base font", "12px monospace", themeFont(engine!!))
            engine!!.close()
        }
    }
}
