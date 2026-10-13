package dev.aster.charts;

import android.app.Instrumentation;
import android.content.ComponentCallbacks2;
import android.os.*;
import android.widget.LinearLayout;
import org.json.*;
import java.io.*;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Real attached View idle windows: no input, invalidate, manual draw, or retry timer. */
public final class HoverIdleVerification {
    private final HoverActivity activity;
    private final Instrumentation instrumentation;
    private final ArrayList<AsterEngine> engines=new ArrayList<>();
    private final ArrayList<AsterChartView> views=new ArrayList<>();
    private final long[][] counts=new long[3][3];
    private final JSONArray checks=new JSONArray(),rows=new JSONArray();
    private LinearLayout layout;
    private long single;
    private interface Action {void run() throws Exception;}
    private HoverIdleVerification(HoverActivity activity,Instrumentation instrumentation){this.activity=activity;this.instrumentation=instrumentation;}
    private void main(Action action) throws Exception {Throwable[] failure={null};instrumentation.runOnMainSync(()->{try{action.run();}catch(Throwable error){failure[0]=error;}});if(failure[0]!=null)throw new AssertionError(failure[0]);}
    private void require(boolean pass,String message){if(!pass)throw new AssertionError(message);checks.put(message);}
    private void settle() throws Exception {instrumentation.waitForIdleSync();Thread.sleep(200);}
    private void setup() throws Exception {
        main(()->{
            AsterChartView.setSharedCacheBudgetBytes(64L*1024*1024);
            layout=new LinearLayout(activity);layout.setOrientation(LinearLayout.VERTICAL);activity.setContentView(layout);
            for(int i=0;i<3;i++){
                AsterEngine engine=new AsterEngine(activity,4096,new JSONObject().put("visibleBars",200).put("panels",new JSONArray().put(new JSONObject().put("id","price"))).put("series",new JSONArray().put(new JSONObject().put("id","line").put("type","line").put("panel","price").put("source","close"))));
                engines.add(engine);AsterChartView view=new AsterChartView(activity,engine);views.add(view);final int index=i;
                view.setDrawProbe(timing->{counts[index][0]++;if(timing.baseChanged)counts[index][1]++;if(timing.cacheUsed)counts[index][2]++;});
                layout.addView(view,new LinearLayout.LayoutParams(-1,0,1));
            }
        });settle();main(()->{
            int width=views.get(0).getWidth(),height=views.get(0).getHeight();single=4L*width*height;
            require(width>0&&height>0,"three charts have actual attached viewports");
            for(AsterChartView view:views){require(view.isAttachedToWindow()&&view.getWidth()==width&&view.getHeight()==height,"three equal attached View sizes");require(view.lastError==null&&view.renderCacheMetrics().getLong("ownedBitmapBytes")==single,"initial cache owns one full base bitmap");}
            AsterChartView.setSharedCacheBudgetBytes(3*single);
        });
    }
    private JSONObject window(String name,Action transition) throws Exception {
        CountDownLatch ended=new CountDownLatch(1);JSONObject[] row={null};Throwable[] failure={null};
        main(()->{
            for(long[] count:counts)java.util.Arrays.fill(count,0);JSONObject before=AsterChartView.sharedCacheMetrics();
            if(transition!=null)transition.run();long start=System.nanoTime();activity.beginMeasurement();
            Handler timer=new Handler(Looper.getMainLooper());timer.postDelayed(new Runnable(){public void run(){long remaining=800000000L-(System.nanoTime()-start);if(remaining>0){timer.postDelayed(this,(remaining+999999L)/1000000L);return;}try{
                JSONArray captured=new JSONArray(),state=new JSONArray();for(int i=0;i<views.size();i++){captured.put(new JSONObject().put("draws",counts[i][0]).put("baseRebuilds",counts[i][1]).put("cached",counts[i][2]));state.put(views.get(i).renderCacheMetrics());}
                JSONObject pool=AsterChartView.sharedCacheMetrics();row[0]=new JSONObject().put("stage",name).put("requestedDurationMs",800).put("durationMs",(System.nanoTime()-start)/1e6).put("counts",captured).put("views",state).put("poolBefore",before).put("pool",pool).put("evictionDelta",pool.getLong("evictions")-before.getLong("evictions")).put("framework",activity.endMeasurement());rows.put(row[0]);
            }catch(Throwable error){failure[0]=error;}finally{ended.countDown();}}},800);
        });
        if(!ended.await(10,TimeUnit.SECONDS))throw new AssertionError("Idle window timed out");if(failure[0]!=null)throw new AssertionError(failure[0]);return row[0];
    }
    private void bounded(JSONObject row) throws Exception {
        JSONArray captured=row.getJSONArray("counts");long draws=0,rebuilds=0;for(int i=0;i<captured.length();i++){draws+=captured.getJSONObject(i).getLong("draws");rebuilds+=captured.getJSONObject(i).getLong("baseRebuilds");}
        require(draws<=6,row.getString("stage")+": at most two transition draws per View during actual800ms idle");
        require(rebuilds<=3,row.getString("stage")+": at most one transition base rebuild per View");
        for(int i=0;i<captured.length();i++)require(captured.getJSONObject(i).getLong("draws")<=2&&captured.getJSONObject(i).getLong("baseRebuilds")<=1,row.getString("stage")+": View"+i+" respects transition draw/rebuild bound");
        require(row.getLong("evictionDelta")<=3,row.getString("stage")+": bounded transition evictions");
    }
    private void quiet(JSONObject row) throws Exception {
        for(int i=0;i<3;i++){JSONObject captured=row.getJSONArray("counts").getJSONObject(i);require(captured.getLong("draws")==0&&captured.getLong("baseRebuilds")==0,row.getString("stage")+": View"+i+" has zero idle draw/rebuild");}
        require(row.getLong("evictionDelta")==0,row.getString("stage")+": zero idle evictions");
    }
    private void cachedAlive(String name) throws Exception {main(()->{for(int i=0;i<views.size();i++)if(!views.get(i).renderCacheMetrics().getBoolean("engineClosed"))require(views.get(i).lastError==null&&views.get(i).renderCacheMetrics().getLong("ownedBitmapBytes")>0,name+": live View"+i+" cache recovers");});}
    private void invalidateAlive(){for(AsterChartView view:views)try{if(!view.renderCacheMetrics().getBoolean("engineClosed"))view.invalidate();}catch(JSONException error){throw new RuntimeException(error);}}
    private void run() throws Exception {
        setup();quiet(window("three bitmaps fit",null));
        JSONObject constrained=window("one bitmap for three idle Views",()->AsterChartView.setSharedCacheBudgetBytes(single));bounded(constrained);
        require(constrained.getJSONObject("pool").getLong("generation")==constrained.getJSONObject("poolBefore").getLong("generation")+1,"budget shrink changes policy generation once despite evictions");
        require(constrained.getJSONObject("pool").getLong("ownershipGeneration")>constrained.getJSONObject("poolBefore").getLong("ownershipGeneration"),"bitmap eviction changes ownership generation separately");
        require(constrained.getJSONObject("pool").getLong("ownedBitmapBytes")<=single,"constrained pool stays within one bitmap budget");quiet(window("constrained settled beyond500ms retry deadline",null));
        bounded(window("budget expansion recovery",()->{AsterChartView.setSharedCacheBudgetBytes(3*single);invalidateAlive();}));cachedAlive("budget expansion");quiet(window("expanded settled",null));
        JSONObject pressure=window("registered memory pressure callback",()->AsterBitmapCachePool.INSTANCE.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW));bounded(pressure);require(pressure.getJSONObject("pool").getLong("generation")==pressure.getJSONObject("poolBefore").getLong("generation")+1,"pressure changes policy generation once despite releases");require(pressure.getJSONObject("pool").getLong("ownedBitmapBytes")==0,"pressure drops all owned bitmaps without timer-driven retry");quiet(window("pressure settled beyond500ms retry deadline",null));
        bounded(window("real redraw after pressure cooldown",this::invalidateAlive));cachedAlive("pressure next real redraw");
        final long[] policy={0};main(()->policy[0]=AsterChartView.sharedCacheMetrics().getLong("generation"));
        bounded(window("resize recovery",()->{LinearLayout.LayoutParams a=(LinearLayout.LayoutParams)views.get(0).getLayoutParams(),b=(LinearLayout.LayoutParams)views.get(1).getLayoutParams();a.weight=.8f;b.weight=1.2f;views.get(0).setLayoutParams(a);views.get(1).setLayoutParams(b);}));cachedAlive("resize");main(()->require(AsterChartView.sharedCacheMetrics().getLong("generation")==policy[0],"resize ownership changes preserve budget/pressure generation"));
        bounded(window("detach releases ownership",()->layout.removeView(views.get(0))));main(()->require(AsterChartView.sharedCacheMetrics().getLong("generation")==policy[0],"detach release preserves budget/pressure generation"));
        bounded(window("reattach after cooldown",()->layout.addView(views.get(0),new LinearLayout.LayoutParams(-1,0,1))));cachedAlive("reattach");
        bounded(window("engine close releases ownership",()->engines.get(1).close()));main(()->{require(views.get(1).renderCacheMetrics().getBoolean("engineClosed"),"closed View remains marked closed");require(views.get(1).renderCacheMetrics().getLong("ownedBitmapBytes")==0,"engine close releases bitmap");require(AsterChartView.sharedCacheMetrics().getLong("generation")==policy[0],"engine close release preserves budget/pressure generation");});
        JSONObject denied=window("zero budget failure fallback",()->{AsterChartView.setSharedCacheBudgetBytes(0);invalidateAlive();});bounded(denied);main(()->{for(AsterChartView view:views)if(!view.renderCacheMetrics().getBoolean("engineClosed")){require(view.lastError==null,"budget failure preserves direct rendering");require(view.renderCacheMetrics().getLong("ownedBitmapBytes")==0&&!view.renderCacheMetrics().getBoolean("frameCacheCreated"),"failure releases bitmap and frame token");}});quiet(window("failure settled",null));
        bounded(window("failure recovery after budget expansion",()->{AsterChartView.setSharedCacheBudgetBytes(4*single);invalidateAlive();}));cachedAlive("failure recovery");quiet(window("final recovered settled",null));
    }
    public static JSONObject run(HoverActivity activity,Instrumentation instrumentation) throws Exception {
        HoverIdleVerification fixture=new HoverIdleVerification(activity,instrumentation);JSONObject report=new JSONObject().put("passed",false).put("checks",fixture.checks).put("rows",fixture.rows).put("physicalDevice",false).put("androidAPI",Build.VERSION.SDK_INT).put("model",Build.MODEL).put("barsPerChart",4096).put("charts",3).put("series","one source:close line per chart").put("scope","Actual framework onDraw for attached Views. Each idle window800ms has no input, invalidate, manual View.draw, or retry timer. A main Handler heartbeat and end-window callback do not invalidate Views. Explicit transitions/redraws occur only before each idle window.");
        try{fixture.run();report.put("passed",true);}catch(Throwable failure){StringWriter trace=new StringWriter();failure.printStackTrace(new PrintWriter(trace));report.put("error",failure.toString()).put("stack",trace.toString());}
        finally{fixture.main(()->{for(AsterChartView view:fixture.views)view.setDrawProbe(null);for(AsterEngine engine:fixture.engines)engine.close();activity.engine.close();report.put("cleanupPool",AsterChartView.sharedCacheMetrics()).put("oneBitmapBudget",fixture.single);AsterChartView.setSharedCacheBudgetBytes(64L*1024*1024);});}
        return report;
    }
}
