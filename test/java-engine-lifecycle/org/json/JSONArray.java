package org.json;

import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.List;

/** Primitive test container; parsing is limited to the JNI stub's scalar replies. */
public class JSONArray {
    private final List<Object> values=new ArrayList<Object>();
    public JSONArray() {}
    public JSONArray(Object array) throws JSONException {
        if(array==null||!array.getClass().isArray())throw new JSONException("Fixture array required");
        int length=Array.getLength(array);for(int i=0;i<length;i++)values.add(Array.get(array,i));
    }
    public JSONArray(String text) throws JSONException {
        if(text==null)throw new JSONException("Fixture text required");String value=text.trim();
        if(value.length()<2||value.charAt(0)!='['||value.charAt(value.length()-1)!=']')throw new JSONException("Fixture array framing");
        String item=value.substring(1,value.length()-1).trim();if(item.length()==0)return;
        if("true".equals(item))values.add(Boolean.TRUE);else if("false".equals(item))values.add(Boolean.FALSE);else if("null".equals(item))values.add(JSONObject.NULL);
        else if(item.length()>=2&&item.charAt(0)=='"'&&item.charAt(item.length()-1)=='"')values.add(item.substring(1,item.length()-1));
        else throw new JSONException("Fixture parses only scalar JNI replies");
    }
    public Object get(int index) throws JSONException {if(index<0||index>=values.size())throw new JSONException("Fixture index");return values.get(index);}
    public JSONObject getJSONObject(int index) throws JSONException {Object value=get(index);if(!(value instanceof JSONObject))throw new JSONException("Fixture object required");return (JSONObject)value;}
    public double getDouble(int index) throws JSONException {Object value=get(index);if(!(value instanceof Number))throw new JSONException("Fixture number required");return ((Number)value).doubleValue();}
    public int length(){return values.size();}
    public boolean isNull(int index){return index>=0&&index<values.size()&&values.get(index)==JSONObject.NULL;}
    public JSONArray put(Object value){values.add(value);return this;}
    @Override public String toString(){StringBuilder result=new StringBuilder("[");for(int i=0;i<values.size();i++){if(i>0)result.append(',');result.append(JSONObject.encode(values.get(i)));}return result.append(']').toString();}
}
