package dev.aster.charts;

import android.app.Activity;
import android.content.*;
import android.content.res.Configuration;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.util.*;

/** Attached native View fixture. Input comes from UiAutomation, not dispatchTouchEvent. */
public final class MobileUXActivity extends Activity {
    static volatile MobileUXActivity latest;
    static int creations,destroys;
    AsterEngine engine; AsterChartView chart; ScrollView scroll;
    volatile Throwable failure;
    final JSONArray events=new JSONArray(),draws=new JSONArray();
    int clicks,interceptTrue,interceptFalse;
    boolean collecting;
    volatile MobileUXProfile.Sample profileSample;
    @Override public boolean dispatchGenericMotionEvent(MotionEvent event){MobileUXProfile.Sample sample=profileSample;boolean match=sample!=null&&sample.eventTime==event.getEventTime();long before=System.nanoTime();try{return super.dispatchGenericMotionEvent(event);}finally{if(match)sample.dispatchNanos=System.nanoTime()-before;}}
    @Override public void onCreate(Bundle state){super.onCreate(state);latest=this;creations++;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);setRequestedOrientation(getIntent().getIntExtra("orientation",android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        try {
            JSONObject options=new JSONObject().put("visibleBars",200).put("panels",new JSONArray()
                .put(new JSONObject().put("id","price").put("label","PRIMARY OHLCV").put("weight",3))
                .put(new JSONObject().put("id","volume").put("label","VOLUME").put("weight",1)))
                .put("axes",new JSONArray().put(new JSONObject().put("id","B").put("panel","price").put("side","left").put("label","OTHER PRICE").put("prefix","B ").put("range",new JSONArray(new int[]{0,3000}))))
                .put("series",new JSONArray().put(new JSONObject().put("id","close").put("panel","price").put("type","line").put("source","close"))
                    .put(new JSONObject().put("id","volume").put("panel","volume").put("type","histogram").put("source","volume")));
            if(getIntent().getBooleanExtra("profile",false)){JSONArray lines=new JSONArray();for(int i=0;i<getIntent().getIntExtra("lines",1);i++)lines.put(new JSONObject().put("id","line"+i).put("type","line").put("panel","price").put("source","close").put("color",i%2==0?"#3abbd2":"#ecb65b"));options=new JSONObject().put("visibleBars",200).put("panels",new JSONArray().put(new JSONObject().put("id","price"))).put("series",lines);}
            engine=new AsterEngine(this,getIntent().getBooleanExtra("profile",false)?100000:4096,options);
            if(state!=null){if(state.containsKey("drawings"))engine.loadDrawings(state.getString("drawings"));if(state.containsKey("from"))engine.invoke("nativeView",state.getDouble("from"),state.getDouble("to"));}
            Configuration config=new Configuration(getResources().getConfiguration());config.fontScale=getIntent().getFloatExtra("fontScale",1f);
            Context viewContext=createConfigurationContext(config);
            chart=new AsterChartView(viewContext,engine);chart.setId(0x415354);chart.setOnClickListener(v->clicks++);
            chart.setOnTouchListener((view,event)->{try{events.put(new JSONObject().put("action",event.getActionMasked()).put("count",event.getPointerCount()).put("source",event.getSource()).put("tool",event.getToolType(0)).put("time",event.getEventTime()).put("x",event.getX()).put("y",event.getY()));}catch(JSONException e){failure=e;}return false;});
            installDrawProbe();
            scroll=new ScrollView(this){@Override public void requestDisallowInterceptTouchEvent(boolean disallow){if(disallow)interceptTrue++;else interceptFalse++;super.requestDisallowInterceptTouchEvent(disallow);}};
            scroll.setFillViewport(false);LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);
            TextView intro=new TextView(this);intro.setText("Aster native chart · scroll parent");content.addView(intro,new LinearLayout.LayoutParams(-1,dp(36)));
            int requested=getIntent().getIntExtra("chartHeight",440);int available=Math.max(160,getResources().getConfiguration().screenHeightDp-64);int chartWidth=getIntent().getIntExtra("chartWidth",0);content.addView(chart,new LinearLayout.LayoutParams(chartWidth>0?dp(chartWidth):-1,dp(Math.min(requested,available))));
            TextView rest=new TextView(this);rest.setText("Scroll content below the chart");content.addView(rest,new LinearLayout.LayoutParams(-1,dp(900)));scroll.addView(content);setContentView(scroll);
        }catch(Throwable error){failure=error;}
    }
    void installDrawProbe(){chart.setDrawProbe(t->{if(collecting)try{draws.put(new JSONObject().put("onDrawMs",(t.submitNanos-t.startNanos)/1e6).put("jniMs",t.scene.jniNanos/1e6).put("parseMs",(t.scene.envelopeParseNanos+t.scene.bodyParseNanos)/1e6).put("canvasMs",t.canvasNanos/1e6).put("baseChanged",t.baseChanged).put("cacheUsed",t.cacheUsed));}catch(JSONException e){failure=e;}});}
    int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    JSONObject inspect() throws JSONException{return (JSONObject)engine.command("inspect");}
    @Override protected void onSaveInstanceState(Bundle state){try{JSONObject i=inspect();if(i.isNull("gesture"))state.putString("drawings",engine.saveDrawings());JSONObject v=i.getJSONObject("view");state.putDouble("from",v.getDouble("from"));state.putDouble("to",v.getDouble("to"));}catch(Exception error){failure=error;}super.onSaveInstanceState(state);}
    @Override protected void onDestroy(){if(chart!=null){chart.setDrawProbe(null);chart.setOnTouchListener(null);chart.setOnClickListener(null);}if(engine!=null)engine.close();destroys++;super.onDestroy();}
}
