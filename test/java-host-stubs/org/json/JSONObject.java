package org.json;

import java.util.Iterator;

/** Test-only compile signatures. No parsing, serialization, or container behavior. */
public class JSONObject {
    // A type placeholder only. Android NULL equality/serialization is not implemented.
    public static final Object NULL = new Object();
    public JSONObject() { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject(String text) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public Object get(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public String getString(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject getJSONObject(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONArray getJSONArray(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public int getInt(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public long getLong(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public boolean getBoolean(String name) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public int optInt(String name, int fallback) { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public boolean has(String name) { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public int length() { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public Iterator<String> keys() { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject put(String name, Object value) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject put(String name, boolean value) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject put(String name, int value) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject put(String name, long value) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    public JSONObject put(String name, double value) throws JSONException { throw new UnsupportedOperationException("Compile-only org.json stub"); }
    @Override public String toString() { throw new UnsupportedOperationException("Compile-only org.json stub"); }
}
