package kr.coden.barochart.compose

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
            assertFalse("Compose release must not close the app-owned engine", engine!!.isClosed)
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
}
