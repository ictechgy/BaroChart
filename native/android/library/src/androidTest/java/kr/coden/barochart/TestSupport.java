package kr.coden.barochart;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/**
 * 새 계측 테스트들이 함께 쓰는 도우미.
 * 메인 스레드 실행, 오류 코드 추출, Swift 테스트와 같은 결정적 봉 데이터를 한곳에 둬 플랫폼 간 시나리오가 어긋나지 않게 한다.
 */
final class TestSupport {
    /** 모든 봉 데이터의 시작 시각(UTC epoch ms). Swift 테스트와 같은 값이다. */
    static final double START = 1_700_000_000_000.0;

    private TestSupport() {}

    /** 예외를 던질 수 있는 메인 스레드 본문 */
    interface MainBody { void run() throws Exception; }

    /**
     * 본문을 메인 스레드에서 실행하고, 그 안의 실패를 테스트 스레드로 다시 던진다.
     * 메인 스레드에서 난 예외가 계측 프로세스를 죽이지 않고 테스트 실패로 보이게 하려는 것이다.
     * @param body 메인 스레드에서 실행할 본문
     */
    static void onMain(MainBody body) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { body.run(); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    /**
     * 본문이 던진 BaroChartException의 코드를 돌려준다. 다른 예외는 그대로 전파해 "크래시"로 실패하게 한다.
     * @param body 실행할 호출
     * @return 오류 코드, 던지지 않았으면 {@code null}
     */
    static BaroChartException.Code code(Runnable body) {
        try { body.run(); } catch (BaroChartException error) { return error.getCode(); }
        return null;
    }

    /** @return 계측 대상 컨텍스트(라이브러리 테스트 APK) */
    static Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }

    /**
     * 1분봉 count개. 종가는 102+i, 시가 종가-2, 고가 종가+1, 저가 종가-3, 거래량 500이다(Swift 테스트와 같은 값).
     * @param count 봉 개수
     * @param offset 첫 봉의 인덱스(시각과 가격이 함께 밀린다)
     * @return 시간순 봉 목록
     */
    static List<Bar> bars(int count, int offset) {
        List<Bar> out = new ArrayList<>();
        for (int k = 0; k < count; k++) {
            int i = offset + k;
            double close = 102 + i;
            out.add(new Bar(START + i * 60_000.0, close - 2, close + 1, close - 3, close, 500));
        }
        return out;
    }

    /**
     * price·rsi 두 패널과 price 캔들 시리즈를 가진 엔진. 패치가 시리즈·드로잉의 패널을 옮기지 않는지 보려면 두 번째 패널이 필요하다.
     * 호출한 스레드가 엔진 소유자가 되므로 메인 스레드에서 부른다.
     * @param count 미리 넣을 봉 개수
     * @return 새 엔진(호출자가 닫는다)
     */
    static BaroChartEngine twoPanelEngine(int count) {
        EngineOptions options = new EngineOptions(Arrays.asList(new Panel("price", 3), new Panel("rsi", 1)),
            java.util.Collections.singletonList(Series.builder("price", SeriesType.CANDLES).build()), null);
        BaroChartEngine engine = BaroChartEngine.create(context(), options);
        engine.setBars(bars(count, 0));
        return engine;
    }

    /**
     * 코어 상태 스냅샷(inspect).
     * @param engine 대상 엔진
     * @return inspect 결과
     * @throws Exception 코어 호출 실패
     */
    static JSONObject inspect(BaroChartEngine engine) throws Exception { return (JSONObject) engine.command("inspect"); }

    /**
     * 저장된 봉 개수.
     * @param engine 대상 엔진
     * @return storedBars
     * @throws Exception 코어 호출 실패
     */
    static int storedBars(BaroChartEngine engine) throws Exception { return inspect(engine).getInt("storedBars"); }
}
