package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** 타입 API의 enum 원시값·테마 프리셋이 코어 어휘(vocabulary.json)와 같은지, 저수준 변환이 정확한지 확인한다. */
@RunWith(AndroidJUnit4.class)
public class TypesParityTest {
    private JSONObject vocabulary() throws Exception {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("vocabulary.json")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    private static Set<String> strings(JSONArray array) throws Exception {
        Set<String> out = new HashSet<>();
        for (int i = 0; i < array.length(); i++) out.add(array.getString(i));
        return out;
    }

    @Test public void indicatorKindsMatchCore() throws Exception {
        Set<String> names = new HashSet<>();
        for (IndicatorKind kind : IndicatorKind.values()) names.add(kind.wireName());
        assertEquals(strings(vocabulary().getJSONArray("indicators")), names);
        assertEquals(35, IndicatorKind.values().length);
    }

    @Test public void drawingToolsMatchCore() throws Exception {
        Set<String> names = new HashSet<>();
        for (DrawingTool tool : DrawingTool.values()) if (tool != DrawingTool.SELECT) names.add(tool.wireName());
        assertEquals(strings(vocabulary().getJSONArray("drawings")), names);
        assertEquals(16, names.size());
    }

    @Test public void seriesTypesMatchCore() throws Exception {
        List<String> names = new ArrayList<>();
        for (SeriesType type : SeriesType.values()) names.add(type.wireName());
        JSONArray expected = vocabulary().getJSONArray("seriesTypes");
        List<String> core = new ArrayList<>();
        for (int i = 0; i < expected.length(); i++) core.add(expected.getString(i));
        assertEquals(core, names);
    }

    @Test public void themePresetsMatchCore() throws Exception {
        JSONObject vocabulary = vocabulary();
        assertEquals(vocabulary.getJSONObject("darkTheme").toString(), sorted(LowLevelJson.theme(Theme.DARK)).toString());
        assertEquals(vocabulary.getJSONObject("lightTheme").toString(), sorted(LowLevelJson.theme(Theme.LIGHT)).toString());
    }

    /** 비교를 위해 vocabulary와 같은 키 순서(코어 정의 순서)로 다시 만든다 */
    private static JSONObject sorted(JSONObject value) throws Exception {
        JSONObject out = new JSONObject();
        for (String key : Arrays.asList("background", "grid", "text", "up", "down", "crosshair", "font")) out.put(key, value.get(key));
        return out;
    }

    @Test public void seriesLowLevelOmitsNullFields() throws Exception {
        JSONObject json = LowLevelJson.series(Series.builder("e", SeriesType.LINE).build());
        assertEquals(3, json.length());
        assertEquals("e", json.getString("id"));
        assertEquals("line", json.getString("type"));
        assertEquals("price", json.getString("panel"));
    }

    @Test public void dataEventKinds() throws Exception {
        Bar bar = new Bar(1, 1, 1, 1, 1, 1);
        List<String> kinds = new ArrayList<>();
        for (DataEvent event : Arrays.asList(DataEvent.reset(Collections.singletonList(bar)), DataEvent.append(bar), DataEvent.update(bar),
                DataEvent.correction(bar), DataEvent.prepend(Collections.singletonList(bar)), DataEvent.batch(Collections.singletonList(DataEvent.append(bar)))))
            kinds.add(LowLevelJson.event(event).getString("kind"));
        assertEquals(Arrays.asList("reset", "append", "update", "correction", "prepend", "batch"), kinds);
        assertEquals("append", LowLevelJson.event(DataEvent.batch(Collections.singletonList(DataEvent.append(bar)))).getJSONArray("events").getJSONObject(0).getString("kind"));
    }

    @Test public void indicatorConveniencesUseCoreParameterNames() {
        Map<String, ParamValue> macd = new HashMap<>();
        macd.put("fast", ParamValue.number(12)); macd.put("slow", ParamValue.number(26)); macd.put("signal", ParamValue.number(9));
        assertEquals(macd, Indicator.macd(12, 26, 9).params);
        Map<String, ParamValue> bollinger = new HashMap<>();
        bollinger.put("period", ParamValue.number(20)); bollinger.put("deviation", ParamValue.number(2));
        assertEquals(bollinger, Indicator.bollinger(20, 2).params);
        assertEquals(IndicatorKind.EMA, Indicator.ema(3).kind);
        assertEquals(0, Indicator.vwap().params.size());
    }

    @Test public void drawingAndBindingLowLevel() throws Exception {
        JSONObject drawing = LowLevelJson.drawing(Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(10, 101))).text("Level").build());
        assertEquals("horizontal", drawing.getString("type"));
        assertEquals(10, drawing.getJSONArray("points").getJSONObject(0).getDouble("time"), 0);
        assertFalse(drawing.has("id"));
        JSONObject binding = LowLevelJson.binding(new DatasetBinding("k", "1", "a", "USD", Adjustment.TOTAL_RETURN));
        assertEquals("total-return", binding.getString("adjustment"));
    }
}
