package example;

import dev.aster.charts.AsterEngine;
import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Compile-only application API usage. Never loads or runs the JNI-backed Engine. */
public final class WorkspaceConsumer {
    private WorkspaceConsumer() {}
    public static AsterEngine.WorkspaceJob restore(AsterEngine engine, String document,
            JSONObject binding, AsterEngine.AsyncListener listener) throws JSONException {
        return engine.restoreWorkspaceAsync(document, binding,
            new AsterEngine.AsyncOptions(30000, 4096), listener);
    }
    public static AsterEngine.WorkspaceJob restoreWithDefaults(AsterEngine engine,
            String document, JSONObject binding, AsterEngine.AsyncListener listener) throws JSONException {
        return engine.restoreWorkspaceAsync(document, binding, listener);
    }
    public static JSONObject readData(AsterEngine engine) throws JSONException {
        JSONObject query=new JSONObject().put("index",0);
        JSONObject latest=engine.dataAt(query);
        return latest==null?null:engine.dataAt(query,new JSONObject().put("asOfIndex",0));
    }
    public static JSONObject compact(AsterEngine engine) throws JSONException {
        JSONObject options=new JSONObject().put("keepLastBars",1000).put("studyHistory","restart").put("maxPeakStoreBytes",2000000);
        return engine.compactData(options);
    }
    public static JSONObject translate(AsterEngine engine) throws JSONException {
        return engine.translateDrawings(new JSONArray(new String[]{"trend", "level"}), .5, 2.0);
    }
    public static JSONObject delete(AsterEngine engine) throws JSONException {
        return engine.deleteDrawings(new JSONArray(new String[]{"trend", "level"}));
    }
    public static String cancelAndInspect(AsterEngine.WorkspaceJob job) {
        job.cancel();
        return job.cleanupPending() ? job.pendingFailure() : null;
    }
    public static JSONObject style(AsterEngine engine) throws JSONException {
        return engine.setDrawingsStyle(new JSONArray(new String[]{"trend"}),new JSONObject().put("color","#abc"));
    }
}
