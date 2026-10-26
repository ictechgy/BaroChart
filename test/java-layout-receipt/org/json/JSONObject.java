package org.json;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Small test-only object used to exercise the production layout receipt decoder. */
public class JSONObject {
    public static final Object NULL = new Object();
    private final Map<String, Object> values = new HashMap<>();

    public JSONObject() {}
    public JSONObject(String text) throws JSONException { throw new JSONException("Parsing is unavailable in this fixture"); }
    public Object get(String name) throws JSONException {
        if (!values.containsKey(name)) throw new JSONException("No value for " + name);
        return values.get(name);
    }
    public String getString(String name) throws JSONException { return (String) get(name); }
    public JSONObject getJSONObject(String name) throws JSONException { return (JSONObject) get(name); }
    public JSONArray getJSONArray(String name) throws JSONException { return (JSONArray) get(name); }
    public int getInt(String name) throws JSONException { return ((Number) get(name)).intValue(); }
    public long getLong(String name) throws JSONException { return ((Number) get(name)).longValue(); }
    public boolean getBoolean(String name) throws JSONException { return ((Boolean) get(name)).booleanValue(); }
    public int optInt(String name, int fallback) {
        Object value = values.get(name);
        return value instanceof Number ? ((Number) value).intValue() : fallback;
    }
    public boolean has(String name) { return values.containsKey(name); }
    public int length() { return values.size(); }
    public Iterator<String> keys() { return values.keySet().iterator(); }
    public JSONObject put(String name, Object value) throws JSONException { values.put(name, value); return this; }
    public JSONObject put(String name, boolean value) throws JSONException { return put(name, Boolean.valueOf(value)); }
    public JSONObject put(String name, int value) throws JSONException { return put(name, Integer.valueOf(value)); }
    public JSONObject put(String name, long value) throws JSONException { return put(name, Long.valueOf(value)); }
    public JSONObject put(String name, double value) throws JSONException { return put(name, Double.valueOf(value)); }
    @Override public String toString() { return values.toString(); }
}
