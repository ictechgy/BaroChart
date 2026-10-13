package org.json;

/** Test-only checked exception signature; not a JSON implementation. */
public class JSONException extends Exception {
    private static final long serialVersionUID = 1L;
    public JSONException(String message) { super(message); }
}
