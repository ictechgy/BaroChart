package kr.coden.barochart;

import static kr.coden.barochart.TestSupport.START;
import static kr.coden.barochart.TestSupport.bars;
import static kr.coden.barochart.TestSupport.code;
import static kr.coden.barochart.TestSupport.inspect;
import static kr.coden.barochart.TestSupport.onMain;
import static kr.coden.barochart.TestSupport.storedBars;
import static kr.coden.barochart.TestSupport.twoPanelEngine;
import static org.junit.Assert.assertEquals;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 오류 분류 계약. 표는 Swift TypedEngineCoverageTests.testClassifierTableMatchesAndroid와 같은 행을 쓴다.
 * 코어가 던지는 문자열이 JNI를 거쳐 IllegalStateException 메시지로 오므로, 표도 같은 예외 형태로 분류한다.
 */
@RunWith(AndroidJUnit4.class)
public class BaroChartExceptionTest {
    /** 표 한 행: 코어 원문, 기대 코드, 접두어를 뗀 기대 메시지 */
    private static final class Row {
        final String raw, message;
        final BaroChartException.Code code;
        Row(String raw, BaroChartException.Code code, String message) { this.raw = raw; this.code = code; this.message = message; }
    }

    /** Swift 표와 같은 행(순서도 같다) */
    private static final List<Row> TABLE = Arrays.asList(
        new Row("TypeError: Bar time must be finite", BaroChartException.Code.INVALID_ARGUMENT, "Bar time must be finite"),
        new Row("RangeError: Invalid OHLCV envelope", BaroChartException.Code.INVALID_ARGUMENT, "Invalid OHLCV envelope"),
        new Row("RangeError: Drawings: limit 512", BaroChartException.Code.BUDGET_EXCEEDED, "Drawings: limit 512"),
        new Row("IngestionError: Every OHLCV field must be finite", BaroChartException.Code.INVALID_ARGUMENT, "Every OHLCV field must be finite"),
        new Row("IngestionError: Packet exceeds queued event/typed-byte budget", BaroChartException.Code.BUDGET_EXCEEDED, "Packet exceeds queued event/typed-byte budget"),
        new Row("Error: Chart disposed", BaroChartException.Code.ENGINE_CLOSED, "Chart disposed"),
        new Row("Error: existing panel required", BaroChartException.Code.JAVASCRIPT, "existing panel required"),
        new Row("SyntaxError: JSON Parse error: Unexpected identifier \"not\"", BaroChartException.Code.INVALID_ARGUMENT, "JSON Parse error: Unexpected identifier \"not\""));

    @Test public void classifierTableMatchesSwift() {
        for (Row row : TABLE) {
            BaroChartException error = BaroChartException.wrap(new IllegalStateException(row.raw));
            assertEquals(row.raw, row.code, error.getCode());
            assertEquals(row.raw, row.message, error.getMessage());
        }
    }

    @Test public void batchWithInvalidEnvelopeIsInvalidArgumentAndChangesNothing() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                Bar next = bars(1, 4).get(0);
                // 고가가 저가보다 낮아 OHLC 범위가 깨진 봉: 코어는 일괄 이벤트 안에서 IngestionError로 거부한다
                Bar broken = new Bar(next.time + 60_000, 10, 5, 9, 7, 1);
                String before = inspect(engine).getJSONObject("lastBar").toString();
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT,
                    code(() -> engine.apply(DataEvent.batch(Arrays.asList(DataEvent.append(next), DataEvent.append(broken))))));
                assertEquals(4, storedBars(engine));
                assertEquals(before, inspect(engine).getJSONObject("lastBar").toString());
            } finally { engine.close(); }
        });
    }

    @Test public void setBarsWithNaNCloseIsInvalidArgumentAndKeepsData() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                List<Bar> data = bars(5, 0);
                data.set(4, new Bar(data.get(4).time, 1, 2, 0.5, Double.NaN, 1));
                JSONObject before = inspect(engine).getJSONObject("lastBar");
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.setBars(data)));
                assertEquals(4, storedBars(engine));
                JSONObject after = inspect(engine).getJSONObject("lastBar");
                assertEquals(before.toString(), after.toString());
                assertEquals(START + 3 * 60_000, after.getDouble("time"), 0);
            } finally { engine.close(); }
        });
    }

    @Test public void malformedDrawingDocumentIsInvalidArgument() {
        onMain(() -> {
            BaroChartEngine engine = twoPanelEngine(4);
            try {
                String before = engine.saveDrawings();
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.loadDrawings("not json")));
                assertEquals(before, engine.saveDrawings());
            } finally { engine.close(); }
        });
    }
}
