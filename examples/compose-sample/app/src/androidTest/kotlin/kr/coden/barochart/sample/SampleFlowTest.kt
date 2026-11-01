package kr.coden.barochart.sample

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

    /** 상태 문구가 기대값인지(대기 조건용). 다르면 false */
    private fun statusIs(text: String): Boolean =
        runCatching { compose.onNodeWithTag("sample-status").assertTextEquals(text) }.isSuccess
}
