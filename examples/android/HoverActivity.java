package dev.aster.charts;

import android.app.Activity;
import android.os.*;
import android.view.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.CountDownLatch;

/** The same measurement adapter is compiled over pinned baseline and candidate sources. */
public final class HoverActivity extends Activity {
    AsterEngine engine;
    AsterChartView chart;
    volatile Throwable failure;
    volatile Sample pending;
    private volatile boolean measuring;
    private final Handler heartbeat=new Handler(Looper.getMainLooper());
    private long beatAt;
    final ArrayList<Double> heartbeatGaps=new ArrayList<>();
    private final Runnable beat=new Runnable(){public void run(){if(!measuring)return;long now=System.nanoTime();heartbeatGaps.add((now-beatAt)/1e6);beatAt=now;heartbeat.postDelayed(this,16);}};
    private HandlerThread frameThread;
    private Window.OnFrameMetricsAvailableListener frameListener;
    private final ArrayList<double[]> frameMetrics=new ArrayList<>();
    private int droppedFrameReports;
    static final class Sample {
        final long eventTime;long injectNanos;final CountDownLatch submitted=new CountDownLatch(1);
        long captureNanos,pointerNanos;int action,source,tool;float x,y;AsterChartView.DrawTiming draw;String error;
        Sample(long time,long injection){eventTime=time;injectNanos=injection;}
        JSONObject json() throws JSONException {
            return new JSONObject().put("eventTimeMs",eventTime).put("action",action).put("source",source).put("toolType",tool).put("x",x).put("y",y)
                .put("injectToCaptureMs",(captureNanos-injectNanos)/1e6).put("captureToSubmitMs",(draw.submitNanos-captureNanos)/1e6).put("injectToSubmitMs",(draw.submitNanos-injectNanos)/1e6)
                .put("pointerJNIEnvelopeMs",pointerNanos/1e6).put("onDrawMs",(draw.submitNanos-draw.startNanos)/1e6)
                .put("sceneJNISerializeMs",draw.scene.jniNanos/1e6).put("envelopeParseMs",draw.scene.envelopeParseNanos/1e6).put("sceneBodyParseMs",draw.scene.bodyParseNanos/1e6)
                .put("canvasRasterOrRecordMs",draw.canvasNanos/1e6).put("accessibilityMs",draw.accessibilityNanos/1e6).put("jsonChars",draw.scene.jsonChars)
                .put("baseRasterMs",draw.baseRasterNanos/1e6).put("drawingRasterMs",draw.drawingRasterNanos/1e6).put("bitmapCopyRecordMs",draw.bitmapCopyNanos/1e6).put("hoverRecordMs",draw.hoverNanos/1e6).put("cacheUsed",draw.cacheUsed).put("baseChanged",draw.baseChanged).put("drawingsChanged",draw.drawingsChanged);
        }
    }
    @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN|WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);try{
        int count=getIntent().getIntExtra("bars",100000),lines=getIntent().getIntExtra("lines",1);JSONArray series=new JSONArray();for(int i=0;i<lines;i++)series.put(new JSONObject().put("id","line"+i).put("type","line").put("panel","price").put("source","close").put("color",i%2==0?"#3abbd2":"#ecb65b"));
        engine=new AsterEngine(this,count,new JSONObject().put("visibleBars",200).put("panels",new JSONArray().put(new JSONObject().put("id","price"))).put("series",series));chart=new AsterChartView(this,engine);
        chart.setOnHoverListener((view,event)->{
            int action=event.getActionMasked();if(action!=MotionEvent.ACTION_HOVER_ENTER&&action!=MotionEvent.ACTION_HOVER_MOVE)return true;
            Sample sample=pending;boolean match=sample!=null&&sample.captureNanos==0&&sample.eventTime==event.getEventTime();
            if(match){sample.captureNanos=System.nanoTime();sample.action=action;sample.source=event.getSource();sample.tool=event.getToolType(0);sample.x=event.getX();sample.y=event.getY();}
            long before=System.nanoTime();float density=getResources().getDisplayMetrics().density;chart.fire("nativePointer","move",0,event.getX()/density,event.getY()/density);if(match)sample.pointerNanos=System.nanoTime()-before;return true;
        });chart.setDrawProbe(timing->{Sample sample=pending;if(sample!=null&&sample.captureNanos!=0&&sample.draw==null){sample.draw=timing;sample.error=chart.lastError;sample.submitted.countDown();}});setContentView(chart);
        frameThread=new HandlerThread("Aster frame metrics");frameThread.start();frameListener=(window,metrics,dropped)->{synchronized(frameMetrics){if(measuring){frameMetrics.add(new double[]{metrics.getMetric(FrameMetrics.TOTAL_DURATION)/1e6,metrics.getMetric(FrameMetrics.DRAW_DURATION)/1e6,metrics.getMetric(FrameMetrics.SYNC_DURATION)/1e6,metrics.getMetric(FrameMetrics.SWAP_BUFFERS_DURATION)/1e6});droppedFrameReports+=dropped;}}};getWindow().addOnFrameMetricsAvailableListener(frameListener,new Handler(frameThread.getLooper()));
    }catch(Throwable error){failure=error;}}
    void beginMeasurement(){synchronized(frameMetrics){frameMetrics.clear();droppedFrameReports=0;measuring=true;}heartbeatGaps.clear();beatAt=System.nanoTime();heartbeat.postDelayed(beat,16);}
    JSONObject endMeasurement() throws JSONException {long now=System.nanoTime();heartbeatGaps.add((now-beatAt)/1e6);heartbeat.removeCallbacks(beat);JSONArray frames=new JSONArray();int dropped;synchronized(frameMetrics){measuring=false;for(double[] row:frameMetrics)frames.put(new JSONArray(row));dropped=droppedFrameReports;}
        return new JSONObject().put("heartbeatGapsMs",new JSONArray(heartbeatGaps)).put("frameMetricsAvailable",true).put("frameMetricColumns",new JSONArray(new String[]{"totalMs","drawMs","syncMs","swapBuffersMs"})).put("frameMetrics",frames).put("frameMetricDroppedReports",dropped);
    }
    JSONObject memorySnapshot() throws Exception {Debug.MemoryInfo memory=new Debug.MemoryInfo();Debug.getMemoryInfo(memory);long rss=0;try(BufferedReader input=new BufferedReader(new FileReader("/proc/self/status"))){String line;while((line=input.readLine())!=null)if(line.startsWith("VmRSS:")){rss=Long.parseLong(line.substring(6).trim().split("\\s+")[0]);break;}}
        JSONObject value=new JSONObject().put("processPSSKiB",memory.getTotalPss()).put("processRSSKiB",rss).put("runtime",engine.runtimeMetrics());try{value.put("cache",AsterChartView.class.getMethod("renderCacheMetrics").invoke(chart)).put("sharedPool",AsterChartView.class.getMethod("sharedCacheMetrics").invoke(null));}catch(NoSuchMethodException baseline){value.put("cacheAvailable",false);}return value;
    }
    @Override protected void onDestroy(){heartbeat.removeCallbacksAndMessages(null);measuring=false;if(frameListener!=null)getWindow().removeOnFrameMetricsAvailableListener(frameListener);if(frameThread!=null)frameThread.quitSafely();if(chart!=null){chart.setDrawProbe(null);chart.setOnHoverListener(null);}if(engine!=null)engine.close();super.onDestroy();}
}
