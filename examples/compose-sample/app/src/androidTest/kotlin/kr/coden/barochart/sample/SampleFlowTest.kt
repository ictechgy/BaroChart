package kr.coden.barochart.sample

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 샘플 앱의 주요 흐름(차트 표시·드로잉·저장/복원·테마·오류 없음)을 실제 앱 프로세스에서 확인한다 */
@RunWith(AndroidJUnit4::class)
class SampleFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun mainFlow() {
        compose.onNodeWithTag("sample-chart").assertIsDisplayed()
        compose.onNodeWithTag("sample-stream").performClick() // 저장~복원 사이에 새 봉이 추가되지 않게 멈춘다
        compose.onNodeWithTag("sample-line").performClick()
        compose.onNodeWithTag("sample-status").assertTextEquals("Line added")
        compose.onNodeWithTag("sample-save").performClick()
        compose.onNodeWithTag("sample-status").assertTextEquals("Saved")
        compose.onNodeWithTag("sample-restore").performClick()
        compose.waitUntil(15_000) { statusIs("Restored") }
        compose.onNodeWithTag("sample-theme").performClick()
        compose.onNodeWithTag("sample-status").assertTextEquals("Light")
        compose.onNodeWithTag("sample-error").assertDoesNotExist()
    }

    @Test fun streamingStopsInBackgroundAndResumesWithTheSameIntent() {
        compose.waitUntil(10_000) { updates() > 0 }
        val before = modelUpdates()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.mainClock.advanceTimeBy(2_200) // Drive the effect clock while its lifecycle owner is stopped.
        org.junit.Assert.assertEquals("stopped owner must not mutate source data", before, modelUpdates())
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.onNodeWithTag("sample-theme").performClick() // Force a visible recomposition after the stopped window.
        compose.waitForIdle()
        org.junit.Assert.assertEquals("background must not consume synthetic feed updates", before, updates())
        compose.waitUntil(10_000) { updates() > before }
        compose.onNodeWithTag("sample-stream").performClick()
        val paused = updates()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.mainClock.advanceTimeBy(1_200)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitForIdle()
        org.junit.Assert.assertEquals(paused, updates())
        compose.onNodeWithTag("sample-stream").assertTextEquals("Live")
    }

    @Test fun activityRecreationRetainsTheAnalysisAndPausedIntent() {
        compose.onNodeWithTag("sample-stream").performClick()
        compose.onNodeWithTag("sample-line").performClick()
        compose.onNodeWithTag("sample-save").performClick()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("sample-chart").assertIsDisplayed()
        compose.onNodeWithTag("sample-stream").assertTextEquals("Live")
        compose.onNodeWithTag("sample-restore").performClick()
        compose.waitUntil(15_000) { statusIs("Restored") }
        compose.onNodeWithTag("sample-error").assertDoesNotExist()
    }

    @Test fun ownerKeepsTheEngineAcrossRecreationAndClosesItOnFinalDestroy() {
        lateinit var original: kr.coden.barochart.BaroChartEngine
        compose.activityRule.scenario.onActivity { original = ViewModelProvider(it)[SampleChartOwner::class.java].chart.engine }
        compose.activityRule.scenario.recreate()
        compose.activityRule.scenario.onActivity {
            org.junit.Assert.assertSame(original, ViewModelProvider(it)[SampleChartOwner::class.java].chart.engine)
            org.junit.Assert.assertFalse(original.isClosed)
        }
        compose.activityRule.scenario.close()
        org.junit.Assert.assertTrue(original.isClosed)
    }

    @Test fun savePausesTheStreamAndRestoresTheSameSource() {
        compose.waitUntil(10_000) { modelUpdates() > 0 }
        compose.onNodeWithTag("sample-save").performClick()
        compose.onNodeWithTag("sample-stream").assertTextEquals("Live")
        val saved = modelUpdates()
        compose.mainClock.advanceTimeBy(1_200)
        org.junit.Assert.assertEquals(saved, modelUpdates())
        compose.onNodeWithTag("sample-restore").performClick()
        compose.waitUntil(15_000) { statusIs("Restored") }
        compose.onNodeWithTag("sample-error").assertDoesNotExist()
    }

    @Test fun aChangedSourceCannotSilentlyReuseASavedDatasetRevision() {
        compose.onNodeWithTag("sample-stream").performClick()
        compose.onNodeWithTag("sample-save").performClick()
        val saved = modelUpdates()
        compose.onNodeWithTag("sample-stream").performClick()
        compose.waitUntil(10_000) { modelUpdates() > saved }
        compose.onNodeWithTag("sample-restore").performClick()
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithTag("sample-error").fetchSemanticsNode() }.isSuccess }
        compose.onNodeWithTag("sample-stream").assertTextEquals("Live")
        compose.onNodeWithTag("sample-error").assertIsDisplayed()
    }

    private fun modelUpdates(): Int {
        var value = -1
        compose.activityRule.scenario.onActivity {
            value = ViewModelProvider(it)[SampleChartOwner::class.java].chart.streamSummary.substringAfter("Updates ").toInt()
        }
        return value
    }

    private fun updates(): Int = compose.onNodeWithTag("sample-stream-summary").fetchSemanticsNode()
        .config[SemanticsProperties.Text].joinToString("") { it.text }.substringAfter("Updates ").toInt()

    /** 상태 문구가 기대값인지(대기 조건용). 다르면 false */
    private fun statusIs(text: String): Boolean =
        runCatching { compose.onNodeWithTag("sample-status").assertTextEquals(text) }.isSuccess
}
