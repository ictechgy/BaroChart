package kr.coden.barochart.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kr.coden.barochart.compose.BaroChart

/** BaroChart Compose 샘플 화면. 엔진은 액티비티 수명주기에 맞춰 만들고 닫는다 */
class MainActivity : ComponentActivity() {
    private lateinit var chart: SampleChart

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        chart = SampleChart(this)
        setContent { ChartScreen(chart) }
    }

    override fun onDestroy() {
        chart.close()
        super.onDestroy()
    }
}

@Composable
private fun ChartScreen(chart: SampleChart) {
    // 스트리밍이 켜져 있는 동안만 1초마다 갱신한다
    LaunchedEffect(chart.isStreaming) {
        while (chart.isStreaming) { delay(1_000); chart.streamTick() }
    }
    Column(
        Modifier.fillMaxSize().background(if (chart.isDark) Color(0xFF0C1320) else Color(0xFFF8FAFC)).safeDrawingPadding().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // 좁은 화면에서도 버튼이 찌그러지지 않도록 가로 스크롤한다
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SampleButton("Line", "sample-line", chart::addHorizontalLine)
            SampleButton("Save", "sample-save", chart::save)
            SampleButton("Restore", "sample-restore", chart::restore)
            SampleButton(if (chart.isDark) "Light" else "Dark", "sample-theme", chart::toggleTheme)
            SampleButton(if (chart.isStreaming) "Pause" else "Live", "sample-stream") { chart.isStreaming = !chart.isStreaming }
        }
        Text(chart.status, color = if (chart.isDark) Color.White else Color.Black, modifier = Modifier.testTag("sample-status"))
        chart.errorMessage?.let { message ->
            Text(message, color = Color.White, modifier = Modifier.fillMaxWidth().background(Color(0xD9B91C1C), RoundedCornerShape(8.dp)).padding(8.dp).testTag("sample-error"))
        }
        BaroChart(engine = chart.engine, modifier = Modifier.fillMaxWidth().weight(1f).testTag("sample-chart"), onError = chart::report)
    }
}

@Composable
private fun SampleButton(label: String, tag: String, onClick: () -> Unit) {
    FilledTonalButton(onClick = onClick, modifier = Modifier.testTag(tag)) { Text(label) }
}
