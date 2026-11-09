package kr.coden.barochart;

import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 타입 API 값을 엔진 브리지가 받는 JSON으로 바꾼다. 동작은 저수준 API와 공유하고 여기서는 형태만 바꾼다.
 * null 선택 필드는 키를 넣지 않아 코어 기본값을 쓴다(JSONObject.putOpt).
 */
final class LowLevelJson {
    private LowLevelJson() {}

    static JSONObject bar(Bar b) throws JSONException {
        return new JSONObject().put("time", b.time).put("open", b.open).put("high", b.high).put("low", b.low).put("close", b.close).put("volume", b.volume);
    }

    static JSONArray bars(List<Bar> bars) throws JSONException {
        JSONArray out = new JSONArray();
        for (Bar b : bars) out.put(bar(b));
        return out;
    }

    /**
     * Encodes the fixed-shape command used by the typed bar API without building an intermediate JSON graph.
     * The legacy {@link #bars(List)} path remains available to the low-level and comparison APIs.
     */
    static String barsCommand(List<Bar> bars) throws JSONException {
        return barsCommand(bars, new StringBuilder());
    }

    /** Encodes into a caller-owned buffer; only fixed-shape typed-bar callers reuse one. */
    static String barsCommand(List<Bar> bars, StringBuilder out) throws JSONException {
        out.setLength(0);
        out.append("[\"setData\",[[");
        boolean first = true;
        for (Bar b : bars) {
            if (!first) out.append(',');
            first = false;
            out.append("{\"time\":").append(JSONObject.numberToString(b.time))
                .append(",\"open\":").append(JSONObject.numberToString(b.open))
                .append(",\"high\":").append(JSONObject.numberToString(b.high))
                .append(",\"low\":").append(JSONObject.numberToString(b.low))
                .append(",\"close\":").append(JSONObject.numberToString(b.close))
                .append(",\"volume\":").append(JSONObject.numberToString(b.volume)).append('}');
        }
        return out.append("]]]").toString();
    }

    static JSONObject event(DataEvent e) throws JSONException {
        JSONObject out = new JSONObject().put("kind", e.kind.name().toLowerCase(java.util.Locale.ROOT));
        if (e.bar != null) out.put("bar", bar(e.bar));
        if (e.kind == DataEvent.Kind.RESET || e.kind == DataEvent.Kind.PREPEND) out.put("bars", bars(e.bars));
        if (e.kind == DataEvent.Kind.BATCH) {
            JSONArray events = new JSONArray();
            for (DataEvent child : e.events) events.put(event(child));
            out.put("events", events);
        }
        return out;
    }

    static JSONObject series(Series s) throws JSONException {
        JSONObject out = new JSONObject().put("id", s.id).put("type", s.type.wireName()).put("panel", s.panel);
        if (s.source != null) out.put("source", s.source.wireName());
        return out.putOpt("indicator", s.indicator).putOpt("output", s.output).putOpt("color", s.color)
            .putOpt("width", s.width).putOpt("visible", s.visible).putOpt("label", s.label);
    }

    static JSONObject params(Map<String, ParamValue> params) throws JSONException {
        JSONObject out = new JSONObject();
        for (Map.Entry<String, ParamValue> entry : params.entrySet()) out.put(entry.getKey(), entry.getValue().value());
        return out;
    }

    /**
     * 시리즈 패치. 설정한 필드만 키로 넣어 코어가 나머지를 현재 값으로 유지하게 한다(id·type은 바꿀 수 없어 넣지 않는다).
     * panel을 항상 보내면 색만 바꿔도 시리즈가 price 패널로 옮겨지므로 기본값을 채우지 않는다.
     */
    static JSONObject seriesPatch(SeriesPatch p) throws JSONException {
        JSONObject out = new JSONObject().putOpt("panel", p.panel);
        if (p.source != null) out.put("source", p.source.wireName());
        return out.putOpt("indicator", p.indicator).putOpt("output", p.output).putOpt("color", p.color)
            .putOpt("width", p.width).putOpt("visible", p.visible).putOpt("label", p.label);
    }

    static JSONObject drawing(Drawing d) throws JSONException {
        JSONObject out = new JSONObject().put("type", d.tool.wireName()).put("panel", d.panel).put("points", points(d.points));
        if (d.style != null) out.put("style", style(d.style));
        return out.putOpt("id", d.id).putOpt("text", d.text).putOpt("locked", d.locked).putOpt("visible", d.visible);
    }

    /**
     * 드로잉 패치. 설정한 필드만 키로 넣는다. 코어 editDrawing은 현재 드로잉에 패치를 병합하므로
     * 스타일만 바꿀 때 앵커를 다시 보낼 필요가 없고, 도구(type)·id는 바꿀 수 없어 넣지 않는다.
     */
    static JSONObject drawingPatch(DrawingPatch p) throws JSONException {
        JSONObject out = new JSONObject();
        if (p.points != null) out.put("points", points(p.points));
        if (p.style != null) out.put("style", style(p.style));
        return out.putOpt("panel", p.panel).putOpt("text", p.text).putOpt("locked", p.locked).putOpt("visible", p.visible);
    }

    /** 앵커 목록을 코어의 {time, price} 배열로 바꾼다 */
    private static JSONArray points(List<ChartPoint> points) throws JSONException {
        JSONArray out = new JSONArray();
        for (ChartPoint p : points) out.put(new JSONObject().put("time", p.time).put("price", p.price));
        return out;
    }

    /** 드로잉 스타일. null 필드는 넣지 않아 코어 기본값을 쓴다 */
    private static JSONObject style(DrawingStyle s) throws JSONException {
        return new JSONObject().putOpt("color", s.color).putOpt("fill", s.fill).putOpt("width", s.width).putOpt("font", s.font);
    }

    static JSONObject theme(Theme t) throws JSONException {
        return new JSONObject().put("background", t.background).put("grid", t.grid).put("text", t.text).put("up", t.up)
            .put("down", t.down).put("crosshair", t.crosshair).put("font", t.font);
    }

    static JSONObject symbol(Symbol s) throws JSONException {
        return new JSONObject().put("id", s.id).put("exchange", s.exchange).put("timezone", s.timezone).put("currency", s.currency)
            .put("volumeUnit", s.volumeUnit).put("priceDecimals", s.priceDecimals).put("tickSize", s.tickSize).put("adjustment", s.adjustment.wireName());
    }

    static JSONObject binding(DatasetBinding b) throws JSONException {
        return new JSONObject().put("key", b.key).put("revision", b.revision).put("adjustmentVersion", b.adjustmentVersion)
            .put("priceUnit", b.priceUnit).put("adjustment", b.adjustment.wireName());
    }

    static JSONObject engineOptions(EngineOptions o) throws JSONException {
        JSONArray panels = new JSONArray(), series = new JSONArray();
        for (Panel p : o.panels) panels.put(new JSONObject().put("id", p.id).put("weight", p.weight).putOpt("label", p.label));
        for (Series s : o.series) series.put(series(s));
        JSONObject out = new JSONObject().put("panels", panels).put("series", series);
        if (o.theme != null) out.put("theme", theme(o.theme));
        return out;
    }
}
