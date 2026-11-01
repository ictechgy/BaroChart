package kr.coden.barochart.sample

import androidx.compose.ui.test.junit4.accessibility.enableAccessibilityChecks
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.tryPerformAccessibilityChecks
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 샘플 차트 화면에 Accessibility Test Framework 검사(설명·터치 영역·대비 등)를 실행한다(G7) */
@RunWith(AndroidJUnit4::class)
class AccessibilityTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun chartScreenPassesAccessibilityChecks() {
        compose.enableAccessibilityChecks()
        compose.onNodeWithTag("sample-stream").performClick() // 검사 중 화면이 바뀌지 않게 스트리밍을 멈춘다
        compose.onRoot().tryPerformAccessibilityChecks()
    }
}
