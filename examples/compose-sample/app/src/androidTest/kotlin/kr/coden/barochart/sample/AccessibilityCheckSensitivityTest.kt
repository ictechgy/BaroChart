package kr.coden.barochart.sample

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.accessibility.enableAccessibilityChecks
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.tryPerformAccessibilityChecks
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * AccessibilityTest의 대조군. 검사가 실제로 켜져 있지 않으면 샘플 화면 검사가 아무것도 보지 않고 통과하므로,
 * 설명 없는 10dp 클릭 영역(터치 영역·설명 위반)은 반드시 실패로 잡혀야 한다.
 */
@RunWith(AndroidJUnit4::class)
class AccessibilityCheckSensitivityTest {
    @get:Rule val compose = createComposeRule()

    @Test fun checksRejectTinyUnlabeledTarget() {
        compose.enableAccessibilityChecks()
        compose.setContent { Box(Modifier.size(10.dp).clickable {}) }
        val failure = runCatching { compose.onRoot().tryPerformAccessibilityChecks() }.exceptionOrNull()
        assertNotNull("ATF did not flag a 10 dp unlabeled clickable; the sample accessibility test could pass without checking", failure)
    }
}
