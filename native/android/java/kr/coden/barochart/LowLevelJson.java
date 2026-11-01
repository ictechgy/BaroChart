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

    static JSONObject drawing(Drawing d) throws JSONException {
        JSONArray points = new JSONArray();
        for (ChartPoint p : d.points) points.put(new JSONObject().put("time", p.time).put("price", p.price));
        JSONObject out = new JSONObject().put("type", d.tool.wireName()).put("panel", d.panel).put("points", points);
        if (d.style != null) out.put("style", new JSONObject().putOpt("color", d.style.color).putOpt("fill", d.style.fill).putOpt("width", d.style.width).putOpt("font", d.style.font));
        return out.putOpt("id", d.id).putOpt("text", d.text).putOpt("locked", d.locked).putOpt("visible", d.visible);
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
