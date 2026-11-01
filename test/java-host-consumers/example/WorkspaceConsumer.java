package example;

import kr.coden.barochart.BaroChartEngine;
import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Compile-only application API usage. Never loads or runs the JNI-backed Engine. */
public final class WorkspaceConsumer {
    private WorkspaceConsumer() {}
    public static JSONObject unchangedBatch(BaroChartEngine engine, JSONArray events) throws JSONException {return engine.applyDataEvents(events,true);}
    public static JSONObject explore(BaroChartEngine engine) throws JSONException {
        engine.setDataExploration(true);
        engine.navigateDataExploration("ArrowLeft");
        engine.refreshDataExploration();
        JSONObject result=engine.readDataExploration();
        engine.setDataExploration(false);
        return result;
    }

    public static BaroChartEngine.WorkspaceJob restore(BaroChartEngine engine, String document,
            JSONObject binding, BaroChartEngine.AsyncListener listener) throws JSONException {
        return engine.restoreWorkspaceAsync(document, binding,
            new BaroChartEngine.AsyncOptions(30000, 4096), listener);
    }
    public static BaroChartEngine.WorkspaceJob restoreWithDefaults(BaroChartEngine engine,
            String document, JSONObject binding, BaroChartEngine.AsyncListener listener) throws JSONException {
        return engine.restoreWorkspaceAsync(document, binding, listener);
    }
    public static JSONObject readData(BaroChartEngine engine) throws JSONException {
        JSONObject query=new JSONObject().put("index",0);
        JSONObject latest=engine.dataAt(query);
        return latest==null?null:engine.dataAt(query,new JSONObject().put("asOfIndex",0));
    }
    public static JSONObject compact(BaroChartEngine engine) throws JSONException {
        JSONObject options=new JSONObject().put("keepLastBars",1000).put("studyHistory","restart").put("maxPeakStoreBytes",2000000);
        return engine.compactData(options);
    }
    public static JSONObject translate(BaroChartEngine engine) throws JSONException {
        return engine.translateDrawings(new JSONArray(new String[]{"trend", "level"}), .5, 2.0);
    }
    public static JSONObject delete(BaroChartEngine engine) throws JSONException {
        return engine.deleteDrawings(new JSONArray(new String[]{"trend", "level"}));
    }
    public static String cancelAndInspect(BaroChartEngine.WorkspaceJob job) {
        job.cancel();
        return job.cleanupPending() ? job.pendingFailure() : null;
    }
    public static JSONObject style(BaroChartEngine engine) throws JSONException {
        return engine.setDrawingsStyle(new JSONArray(new String[]{"trend"}),new JSONObject().put("color","#abc"));
    }
    public static BaroChartEngine.ParamsJob changeParams(BaroChartEngine engine,BaroChartEngine.AsyncListener listener)throws JSONException {
        return engine.setIndicatorParamsAsync("ema",new JSONObject().put("period",20),new BaroChartEngine.AsyncOptions(30000,4096),listener);
    }
    public static BaroChartEngine.ParamsJob changeParamsDefault(BaroChartEngine engine,BaroChartEngine.AsyncListener listener)throws JSONException {
        return engine.setIndicatorParamsAsync("ema",new JSONObject().put("period",20),listener);
    }
    public static String paramsCleanupOnOwner(BaroChartEngine.ParamsJob job){job.retryCleanup();return job.commitOutcome();}
}
