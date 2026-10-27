package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** Primitive test container; not an Android org.json implementation. */
public class JSONObject {
    private static final class NullValue {
        @Override public String toString(){return "null";}
    }
    public static final Object NULL=new NullValue();
    private static Error nextSerializationError;
    private final Map<String,Object> values=new LinkedHashMap<String,Object>();

    public JSONObject() {}
    public JSONObject(String text) throws JSONException {
        if(text==null||!"{}".equals(text.trim()))throw new JSONException("Fixture parses only an empty object");
    }
    public static void failNextSerialization(Error error){nextSerializationError=error;}
    static String encode(Object value){
        if(value==null||value==NULL)return "null";
        if(value instanceof String)return '"'+escape((String)value)+'"';
        if(value instanceof Boolean||value instanceof Number)return value.toString();
        if(value instanceof JSONObject||value instanceof JSONArray)return value.toString();
        throw new IllegalArgumentException("Unsupported fixture JSON value");
    }
    private static String escape(String value){return value.replace("\\","\\\\").replace("\"","\\\"");}
    private void failSerializationIfRequested(){Error error=nextSerializationError;nextSerializationError=null;if(error!=null)throw error;}
    public Object get(String name) throws JSONException {if(!values.containsKey(name))throw new JSONException("Missing fixture key");return values.get(name);}
    public String getString(String name) throws JSONException {Object value=get(name);if(!(value instanceof String))throw new JSONException("Fixture string required");return (String)value;}
    public JSONObject getJSONObject(String name) throws JSONException {Object value=get(name);if(!(value instanceof JSONObject))throw new JSONException("Fixture object required");return (JSONObject)value;}
    public JSONArray getJSONArray(String name) throws JSONException {Object value=get(name);if(!(value instanceof JSONArray))throw new JSONException("Fixture array required");return (JSONArray)value;}
    public int getInt(String name) throws JSONException {Object value=get(name);if(!(value instanceof Number))throw new JSONException("Fixture number required");return ((Number)value).intValue();}
    public long getLong(String name) throws JSONException {Object value=get(name);if(!(value instanceof Number))throw new JSONException("Fixture number required");return ((Number)value).longValue();}
    public boolean getBoolean(String name) throws JSONException {Object value=get(name);if(!(value instanceof Boolean))throw new JSONException("Fixture boolean required");return ((Boolean)value).booleanValue();}
    public int optInt(String name,int fallback){Object value=values.get(name);return value instanceof Number?((Number)value).intValue():fallback;}
    public String optString(String name,String fallback){Object value=values.get(name);return value instanceof String?(String)value:fallback;}
    public boolean has(String name){return values.containsKey(name);}
    public int length(){return values.size();}
    public Iterator<String> keys(){return values.keySet().iterator();}
    public JSONObject put(String name,Object value) throws JSONException {if(name==null)throw new JSONException("Fixture key required");values.put(name,value);return this;}
    public JSONObject put(String name,boolean value) throws JSONException {return put(name,Boolean.valueOf(value));}
    public JSONObject put(String name,int value) throws JSONException {return put(name,Integer.valueOf(value));}
    public JSONObject put(String name,long value) throws JSONException {return put(name,Long.valueOf(value));}
    public JSONObject put(String name,double value) throws JSONException {return put(name,Double.valueOf(value));}
    @Override public String toString(){
        failSerializationIfRequested();StringBuilder result=new StringBuilder("{");boolean first=true;
        for(Map.Entry<String,Object> entry:values.entrySet()){if(!first)result.append(',');first=false;result.append(encode(entry.getKey())).append(':').append(encode(entry.getValue()));}
        return result.append('}').toString();
    }
}
