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
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kr.coden.barochart.compose.BaroChart

/** BaroChart Compose sample. A ViewModel owns the engine across recreation. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val chart = ViewModelProvider(this)[SampleChartOwner::class.java].chart
        setContent { ChartScreen(chart, lifecycle) }
    }
}

@Composable
private fun ChartScreen(chart: SampleChart, lifecycle: Lifecycle) {
    LaunchedEffect(chart, lifecycle, chart.isStreaming) {
        if (!chart.isStreaming) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) { delay(1_000); chart.streamTick() }
        }
    }
    Column(
        Modifier.fillMaxSize().background(if (chart.isDark) Color(0xFF0C1320) else Color(0xFFF8FAFC)).safeDrawingPadding().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // 스트림 제어는 항상 보이게 두고 나머지 동작은 큰 글씨에서도 가로로 탐색한다.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SampleButton("Line", "sample-line", chart::addHorizontalLine)
                SampleButton("Save", "sample-save", chart::save)
                SampleButton("Restore", "sample-restore", chart::restore)
                SampleButton(if (chart.isDark) "Light" else "Dark", "sample-theme", chart::toggleTheme)
            }
            SampleButton(if (chart.isStreaming) "Pause" else "Live", "sample-stream") { chart.isStreaming = !chart.isStreaming }
        }
        Text(chart.status, color = if (chart.isDark) Color.White else Color.Black, modifier = Modifier.testTag("sample-status"))
        Text(chart.streamSummary, color = if (chart.isDark) Color.White else Color.Black, modifier = Modifier.testTag("sample-stream-summary"))
        chart.errorMessage?.let { message ->
            Text(message, color = Color.White, modifier = Modifier.fillMaxWidth().background(Color(0xD9B91C1C), RoundedCornerShape(8.dp)).padding(8.dp).testTag("sample-error"))
        }
        BaroChart(engine = chart.engine, modifier = Modifier.fillMaxWidth().weight(1f).testTag("sample-chart"), onError = chart::report, configure = { it.setSystemFontScaleEnabled(true) })
    }
}

@Composable
private fun SampleButton(label: String, tag: String, onClick: () -> Unit) {
    FilledTonalButton(onClick = onClick, modifier = Modifier.testTag(tag)) { Text(label) }
}
