package kr.coden.barochart.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kr.coden.barochart.BaroChartEngine
import kr.coden.barochart.BaroChartException
import kr.coden.barochart.BaroChartView
import kr.coden.barochart.OnChartErrorListener

/**
 * Jetpack Compose chart. The app owns [engine] and passes it in; this composable never closes it.
 *
 * When the composable leaves the composition only the underlying [BaroChartView] is released, so the
 * same engine can be shown again. Passing a different engine creates a new view for it.
 * Create the engine on the main thread, for example in a `ViewModel`, and close it when that owner is cleared.
 *
 * ```kotlin
 * BaroChart(engine = viewModel.engine, modifier = Modifier.fillMaxWidth().height(320.dp), onError = viewModel::report)
 * ```
 *
 * @param engine An engine owned by the app on the main thread.
 * @param modifier Layout modifier for the chart.
 * @param onInteraction Called after touch, key or hover input changes the chart.
 * @param onError Called for failures that cannot be thrown, such as drawing a closed engine.
 */
@Composable
fun BaroChart(
    engine: BaroChartEngine,
    modifier: Modifier = Modifier,
    onInteraction: (() -> Unit)? = null,
    onError: ((BaroChartException) -> Unit)? = null,
) {
    BaroChartInternal(engine, modifier, onInteraction, onError, onViewCreated = null)
}

/** 테스트가 생성된 뷰를 받을 수 있도록 onViewCreated를 더한 본체(같은 모듈 테스트에서만 보인다) */
@Composable
internal fun BaroChartInternal(
    engine: BaroChartEngine,
    modifier: Modifier = Modifier,
    onInteraction: (() -> Unit)? = null,
    onError: ((BaroChartException) -> Unit)? = null,
    onViewCreated: ((BaroChartView) -> Unit)? = null,
) {
    // 엔진이 바뀌면 key가 바뀌어 이전 뷰는 해제되고 새 엔진의 뷰가 만들어진다
    key(engine) {
        AndroidView(
            factory = { context -> BaroChartView(context, engine).also { onViewCreated?.invoke(it) } },
            modifier = modifier,
            update = { view -> view.bindCallbacks(onInteraction, onError) },
            onRelease = { view -> view.bindCallbacks(null, null) },
        )
    }
}

/** Compose 람다를 뷰 리스너로 연결한다(null이면 해제) */
private fun BaroChartView.bindCallbacks(onInteraction: (() -> Unit)?, onError: ((BaroChartException) -> Unit)?) {
    setOnInteractionListener(onInteraction?.let { callback -> Runnable { callback() } })
    setOnChartErrorListener(onError?.let { callback -> OnChartErrorListener { error -> callback(error) } })
}
