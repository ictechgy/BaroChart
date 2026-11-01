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
 * When the composable leaves the composition the underlying [BaroChartView] is disposed with
 * [BaroChartView.dispose], so the same engine can be shown again by a new view. Passing a different
 * engine disposes the old view and creates a new one for the new engine.
 * Create the engine on the main thread, for example in a `ViewModel`, and close it when that owner is cleared.
 *
 * ```kotlin
 * BaroChart(
 *     engine = viewModel.engine,
 *     modifier = Modifier.fillMaxWidth().height(320.dp),
 *     onError = viewModel::report,
 *     configure = { view -> view.setSystemFontScaleEnabled(true) },
 * )
 * ```
 *
 * @param engine An engine owned by the app on the main thread.
 * @param modifier Layout modifier for the chart.
 * @param onInteraction Called after touch, key or hover input changes the chart.
 * @param onError Called for failures that cannot be thrown, such as drawing a closed engine.
 * @param configure Called on the main thread exactly once for each newly created [BaroChartView], right after it is
 *   created and before it is attached; it runs again only when a new view is created, for example after [engine]
 *   changes, and not on recomposition. Use it for view options such as
 *   [BaroChartView.setSystemFontScaleEnabled] or [BaroChartView.setRenderCacheEnabled]. Do not set the error or
 *   interaction listeners here, because [onError] and [onInteraction] replace them. An exception it throws propagates
 *   to the composition.
 */
@Composable
fun BaroChart(
    engine: BaroChartEngine,
    modifier: Modifier = Modifier,
    onInteraction: (() -> Unit)? = null,
    onError: ((BaroChartException) -> Unit)? = null,
    configure: (BaroChartView) -> Unit = {},
) {
    BaroChartInternal(engine, modifier, onInteraction, onError, configure, onViewCreated = null)
}

/** 테스트가 생성된 뷰를 받을 수 있도록 onViewCreated를 더한 본체(같은 모듈 테스트에서만 보인다) */
@Composable
internal fun BaroChartInternal(
    engine: BaroChartEngine,
    modifier: Modifier = Modifier,
    onInteraction: (() -> Unit)? = null,
    onError: ((BaroChartException) -> Unit)? = null,
    configure: (BaroChartView) -> Unit = {},
    onViewCreated: ((BaroChartView) -> Unit)? = null,
) {
    // 엔진이 바뀌면 key가 바뀌어 이전 뷰는 해제되고 새 엔진의 뷰가 만들어진다
    key(engine) {
        AndroidView(
            // factory는 뷰를 만들 때 한 번만 불리므로 configure도 재구성마다가 아니라 새 뷰마다 한 번 실행된다
            factory = { context -> BaroChartView(context, engine).also { view -> configure(view); onViewCreated?.invoke(view) } },
            modifier = modifier,
            update = { view -> view.bindCallbacks(onInteraction, onError) },
            // 콜백을 먼저 끊고 뷰를 영구 해제한다. 엔진은 앱 소유라 닫지 않는다
            onRelease = { view -> view.bindCallbacks(null, null); view.dispose() },
        )
    }
}

/** Compose 람다를 뷰 리스너로 연결한다(null이면 해제) */
private fun BaroChartView.bindCallbacks(onInteraction: (() -> Unit)?, onError: ((BaroChartException) -> Unit)?) {
    setOnInteractionListener(onInteraction?.let { callback -> Runnable { callback() } })
    setOnChartErrorListener(onError?.let { callback -> OnChartErrorListener { error -> callback(error) } })
}
