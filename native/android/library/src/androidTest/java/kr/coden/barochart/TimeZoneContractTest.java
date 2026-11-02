package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 시간대 계약 v1(설계 §7.4-2, M0 Task 2)을 실제 JNI/QuickJS와 java.time 호스트에서 확인한다.
 * 이름 문법, 지원 연도(1000~9999), 오류 문구는 코어가 정하므로 java.time만 받던 이름(Z, UTC+9, UT)은 호스트를 부르기 전에
 * 거절되고, 호스트의 연도 표기('0999')도 코어가 걸러야 한다. Swift TimeZoneContractTests와 같은 시나리오·기대값이다.
 */
@RunWith(AndroidJUnit4.class)
public class TimeZoneContractTest {
    /** 1000-01-01T00:00:00Z(UTC epoch ms): 지원 연도 첫날의 UTC 자정 */
    private static final double YEAR_1000 = -30_610_224_000_000.0;
    /** 9999-12-31T23:59:00Z(UTC epoch ms): 지원 연도 마지막 날의 마지막 분 */
    private static final double YEAR_9999_LAST_MINUTE = 253_402_300_740_000.0;

    /**
     * 시간대만 바꾼 심볼. 나머지 필드는 계약과 무관한 고정값이다.
     * @param timezone 시간대 이름
     * @return 심볼
     */
    private static Symbol symbol(String timezone) { return Symbol.builder("TZ", "TEST", timezone, "USD", 2, 0.01).build(); }

    /**
     * 1분봉 10개를 start부터 넣은 엔진을 만든다(타입 API, 기본 옵션은 캔들 하나). 메인 스레드에서 부른다.
     * @param start 첫 봉 시각(UTC epoch ms)
     * @return 새 엔진(호출자가 닫는다)
     */
    private static BaroChartEngine engine(double start) {
        BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 10; i++) bars.add(new Bar(start + i * 60_000.0, 100, 101, 99, 100.5, 10));
        engine.setBars(bars);
        return engine;
    }

    /**
     * 400×300 장면의 시간축 라벨(role이 time-tick인 명령의 fullText)을 돌려준다.
     * @param engine 대상 엔진
     * @return 라벨 목록
     * @throws Exception 코어 호출이나 JSON 해석 실패
     */
    private static List<String> timeLabels(BaroChartEngine engine) throws Exception {
        JSONArray commands = engine.scene(400, 300).getJSONArray("commands");
        List<String> labels = new ArrayList<>();
        for (int i = 0; i < commands.length(); i++) {
            JSONObject command = commands.getJSONObject(i);
            if ("time-tick".equals(command.optString("role"))) labels.add(command.getString("fullText"));
        }
        return labels;
    }

    /**
     * 장면 생성이 연도 범위 오류로 실패하는지 확인한다. 저수준 장면 API의 원래 예외를 타입 오류로 바꿔 본다.
     * @param engine 대상 엔진
     * @param reason 실패하지 않을 때 보일 설명
     * @throws Exception 연도 오류가 아닌 JSON 해석 실패
     */
    private static void assertYearOutOfRange(BaroChartEngine engine, String reason) throws Exception {
        try {
            timeLabels(engine);
            fail(reason);
        } catch (RuntimeException error) {
            BaroChartException typed = BaroChartException.wrap(error);
            assertEquals(BaroChartException.Code.INVALID_ARGUMENT, typed.getCode());
            assertEquals("Time zone conversion year out of range", typed.getMessage());
        }
    }

    @Test
    public void hostOnlyZonesAreInvalidArgumentWithCoreMessage() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                for (String zone : new String[]{"Z", "UTC+9", "UT"}) {
                    // java.time 자체는 이 이름들을 받는다. 거절은 호스트를 부르기 전 코어 문법에서 일어나야 한다
                    assertEquals(zone, 6, new JSONArray(BaroChartEngine.zonedParts(0, zone)).length());
                    try {
                        engine.setSymbol(symbol(zone));
                        fail("'" + zone + "' is a java.time-only name and must be rejected by the core");
                    } catch (BaroChartException expected) {
                        assertEquals(zone, BaroChartException.Code.INVALID_ARGUMENT, expected.getCode());
                        assertTrue(expected.getMessage(), expected.getMessage().contains("Unsupported time zone: " + zone));
                    }
                }
            } finally {
                engine.close();
            }
        });
    }

    @Test
    public void lowercaseIanaNameAndFixedOffsetAreAccepted() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                engine.setSymbol(symbol("asia/seoul"));
                engine.setSymbol(symbol("+09:00"));
            } finally {
                engine.close();
            }
        });
    }

    @Test
    public void timeLabelsAtSupportedYearEdgesMatchAcrossHosts() {
        TestSupport.onMain(() -> {
            BaroChartEngine early = engine(YEAR_1000);
            try {
                early.setSymbol(symbol("Etc/GMT-14"));
                List<String> labels = timeLabels(early);
                assertFalse(labels.isEmpty());
                for (String label : labels) assertTrue(labels.toString(), label.startsWith("1000-01-01 "));
                // java.time은 999년을 '0999'로 쓴다. 코어가 지원 연도 밖으로 거절해야 iOS('999')와 같아진다
                early.setSymbol(symbol("Etc/GMT+12"));
                assertYearOutOfRange(early, "local year 999 must be rejected");
            } finally {
                early.close();
            }
            BaroChartEngine late = engine(YEAR_9999_LAST_MINUTE - 9 * 60_000.0);
            try {
                late.setSymbol(symbol("Etc/GMT+12"));
                List<String> labels = timeLabels(late);
                assertFalse(labels.isEmpty());
                for (String label : labels) assertTrue(labels.toString(), label.startsWith("9999-12-31 "));
                late.setSymbol(symbol("Etc/GMT-14"));
                assertYearOutOfRange(late, "local year 10000 must be rejected");
            } finally {
                late.close();
            }
        });
    }
}
