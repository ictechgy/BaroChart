package org.json;

/** Compile-only signature for production methods outside this lifecycle fixture. */
public final class JSONTokener {
    public JSONTokener(String text){if(text==null)throw new IllegalArgumentException("Text required");}
    public Object nextValue() throws JSONException {throw new JSONException("Fixture tokener is not executed");}
    public char nextClean() throws JSONException {throw new JSONException("Fixture tokener is not executed");}
}
