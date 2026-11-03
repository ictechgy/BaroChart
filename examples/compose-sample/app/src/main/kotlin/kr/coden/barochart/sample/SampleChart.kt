package kr.coden.barochart.sample

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kr.coden.barochart.Adjustment
import kr.coden.barochart.Bar
import kr.coden.barochart.BaroChartEngine
import kr.coden.barochart.BaroChartException
import kr.coden.barochart.ChartPoint
import kr.coden.barochart.DataEvent
import kr.coden.barochart.DatasetBinding
import kr.coden.barochart.Drawing
import kr.coden.barochart.DrawingTool
import kr.coden.barochart.EngineOptions
import kr.coden.barochart.Indicator
import kr.coden.barochart.Panel
import kr.coden.barochart.PriceSource
import kr.coden.barochart.Series
import kr.coden.barochart.SeriesType
import kr.coden.barochart.Theme

/**
 * 샘플 화면의 상태와 차트 엔진을 소유한다(메인 스레드 전용).
 *
 * [SampleChartOwner]가 구성 변경 동안 보존하며 소유자가 끝날 때 [close]한다.
 */
class SampleChart(context: Context) {
    /** Compose BaroChart에 넘기는 엔진(이 객체가 소유) */
    val engine: BaroChartEngine = BaroChartEngine.create(context, layout())
    /** 화면 상단 상태 문구(계측 테스트가 읽는다) */
    var status by mutableStateOf("Ready")
        private set
    /** 마지막 오류. null이 아니면 배너로 보여 준다 */
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var isStreaming by mutableStateOf(true)
    var isDark by mutableStateOf(true)
        private set

    private val bars = syntheticBars(240).toMutableList()
    private var savedWorkspace: String? = null
    private var tick = 0
    private var dataRevision by mutableIntStateOf(0)
    val streamSummary: String get() = "Bars ${bars.size} · Updates $dataRevision"
    private val binding: DatasetBinding get() = DatasetBinding("SAMPLE:SYNTH", dataRevision.toString(), "raw", "USD", Adjustment.RAW)

    init {
        engine.setBars(bars)
        engine.addIndicator(Indicator.ema(20), "ema20")
        engine.addSeries(Series.builder("ema20-line", SeriesType.LINE).indicator("ema20").color("#f0b755").build())
        engine.addIndicator(Indicator.rsi(14), "rsi14")
        engine.addSeries(Series.builder("rsi14-line", SeriesType.LINE).panel("rsi").indicator("rsi14").color("#a78bfa").build())
        engine.fit()
    }

    /** 마지막 봉 근처에 수평선을 긋는다 */
    fun addHorizontalLine() = perform("Line added") {
        val last = bars.last()
        engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, listOf(ChartPoint(last.time, last.close))).text("Level").build())
    }

    /** 현재 차트 설정·지표·드로잉을 작업공간 문서로 저장한다 */
    fun save(): Boolean {
        isStreaming = false
        return perform("Saved") { savedWorkspace = engine.saveWorkspace(binding) }
    }

    /** 저장한 작업공간을 복원한다. 저장 뒤 봉이 추가됐다면 코어가 거부하고 오류 배너가 뜬다 */
    fun restore() {
        isStreaming = false
        val document = savedWorkspace ?: run { errorMessage = "Save a workspace first."; return }
        try {
            engine.restoreWorkspace(document, binding) { error ->
                if (error == null) { status = "Restored"; errorMessage = null } else report(error)
            }
        } catch (error: BaroChartException) {
            report(error)
        }
    }

    /** 다크/라이트 테마를 바꾼다 */
    fun toggleTheme() {
        isDark = !isDark
        perform(if (isDark) "Dark" else "Light") { engine.setTheme(if (isDark) Theme.DARK else Theme.LIGHT) }
    }

    /** 뷰가 전달한 그리기 오류를 배너로 보여 준다 */
    fun report(error: BaroChartException) { errorMessage = "${error.message} ${error.recovery}" }

    /** 1초마다 현재 봉을 갱신하고 15번째마다 새 봉을 추가한다(합성 데이터) */
    fun streamTick() {
        if (!isStreaming) return
        tick += 1
        val last = bars.last()
        val drift = sin(tick / 3.0) * 0.4
        if (tick % 15 == 0) {
            val next = Bar(last.time + 60_000, last.close, last.close + 0.6, last.close - 0.6, last.close + drift, 900.0)
            if (perform(status) { engine.apply(DataEvent.append(next)) }) { bars.add(next); dataRevision++ }
        } else {
            val close = last.close + drift
            val updated = Bar(last.time, last.open, max(last.high, close), min(last.low, close), close, last.volume + 10)
            if (perform(status) { engine.apply(DataEvent.update(updated)) }) { bars[bars.lastIndex] = updated; dataRevision++ }
        }
    }

    /** 소유 ViewModel의 최종 정리에서 엔진을 닫는다. */
    fun close() = engine.close()

    /** 엔진 호출을 실행하고 성공 문구 또는 오류 배너를 갱신한다. 성공하면 true */
    private inline fun perform(success: String, body: () -> Unit): Boolean = try {
        body(); status = success; errorMessage = null; true
    } catch (error: BaroChartException) {
        report(error); false
    }

    private companion object {
        /** 가격(캔들+EMA) · 거래량 · RSI 세 패널 구성 */
        fun layout() = EngineOptions(
            listOf(Panel("price", 3.0), Panel("volume", 1.0), Panel("rsi", 1.0)),
            listOf(Series.builder("price", SeriesType.CANDLES).build(),
                Series.builder("volume", SeriesType.HISTOGRAM).panel("volume").source(PriceSource.VOLUME).color("#397e8c").build()),
            null,
        )

        /** 결정적 합성 1분봉(실제 시세 아님) */
        fun syntheticBars(count: Int): List<Bar> {
            var close = 100.0
            return (0 until count).map { i ->
                val open = close
                close = open + sin(i / 7.0) * 0.8 + cos(i / 3.0) * 0.3
                Bar(1_700_000_000_000.0 + i * 60_000.0, open, max(open, close) + 0.5, min(open, close) - 0.5, close, 500.0 + (i % 17) * 40)
            }
        }
    }
}

/** Keeps the engine and in-memory analysis across activity configuration changes. */
class SampleChartOwner(application: Application) : AndroidViewModel(application) {
    val chart = SampleChart(application)
    override fun onCleared() { chart.close() }
}
