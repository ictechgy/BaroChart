package dev.aster.charts;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.*;
import android.view.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Same default View routing seam over frozen baseline/current Java and core. */
final class MobileUXProfile {
    static final class Sample {
        final long eventTime;long injected,capture,dispatchNanos;int action,source,tool;
        AsterChartView.DrawTiming draw;String error;final CountDownLatch done=new CountDownLatch(1);
        Sample(long time){eventTime=time;}
        JSONObject json()throws JSONException {return new JSONObject().put("action",action).put("source",source).put("tool",tool).put("injectToCaptureMs",(capture-injected)/1e6).put("captureToSubmitMs",(draw.submitNanos-capture)/1e6).put("injectToSubmitMs",(draw.submitNanos-injected)/1e6).put("genericMotionDispatchMs",dispatchNanos/1e6).put("onDrawMs",(draw.submitNanos-draw.startNanos)/1e6).put("sceneJNIMs",draw.scene.jniNanos/1e6).put("envelopeParseMs",draw.scene.envelopeParseNanos/1e6).put("bodyParseMs",draw.scene.bodyParseNanos/1e6).put("canvasMs",draw.canvasNanos/1e6).put("accessibilityMs",draw.accessibilityNanos/1e6).put("baseRasterMs",draw.baseRasterNanos/1e6).put("drawingRasterMs",draw.drawingRasterNanos/1e6).put("bitmapCopyMs",draw.bitmapCopyNanos/1e6).put("hoverMs",draw.hoverNanos/1e6).put("jsonChars",draw.scene.jsonChars).put("cacheUsed",draw.cacheUsed).put("baseChanged",draw.baseChanged);}
    }
    private static void main(Instrumentation ins,MobileUXInstrumentation.MainTask task){final Throwable[] error=new Throwable[1];ins.runOnMainSync(()->{try{task.run();}catch(Throwable e){error[0]=e;}});if(error[0]!=null)throw new AssertionError(error[0]);}
    private static JSONObject memory(MobileUXActivity a)throws Exception {Debug.MemoryInfo mem=new Debug.MemoryInfo();Debug.getMemoryInfo(mem);long rss=0;try(BufferedReader input=new BufferedReader(new FileReader("/proc/self/status"))){String line;while((line=input.readLine())!=null)if(line.startsWith("VmRSS:")){rss=Long.parseLong(line.substring(6).trim().split("\\s+")[0]);break;}}return new JSONObject().put("rssKiB",rss).put("pssKiB",mem.getTotalPss()).put("runtime",a.engine.runtimeMetrics()).put("cache",a.chart.renderCacheMetrics());}
    static JSONObject run(Instrumentation ins,Bundle args)throws Exception {
        int samples=Integer.parseInt(args.getString("samples","60"));if(samples<1||samples>600)throw new IllegalArgumentException("Profile sample count1..600");JSONArray cases=new JSONArray();MobileUXActivity a=null;
        try {for(int lines:new int[]{1,32}){
            a=(MobileUXActivity)ins.startActivitySync(new Intent(ins.getTargetContext(),MobileUXActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("profile",true).putExtra("lines",lines));ins.waitForIdleSync();SystemClock.sleep(350);if(a.failure!=null)throw new AssertionError(a.failure);final MobileUXActivity active=a;
            main(ins,()->{active.chart.setOnHoverListener((view,e)->{Sample s=active.profileSample;if(s!=null&&s.capture==0&&s.eventTime==e.getEventTime()){s.capture=System.nanoTime();s.action=e.getActionMasked();s.source=e.getSource();s.tool=e.getToolType(0);}return false;});active.chart.setDrawProbe(t->{Sample s=active.profileSample;if(s!=null&&s.capture>0&&s.draw==null){s.draw=t;s.error=active.chart.lastError;s.done.countDown();}});});
            HandlerThread frames=new HandlerThread("Aster mobile UX frame metrics");frames.start();final ArrayList<double[]> frameRows=new ArrayList<>();final boolean[] measuring={false};final int[] dropped={0};Window.OnFrameMetricsAvailableListener listener=(window,m,missed)->{synchronized(frameRows){if(measuring[0]){frameRows.add(new double[]{m.getMetric(FrameMetrics.TOTAL_DURATION)/1e6,m.getMetric(FrameMetrics.DRAW_DURATION)/1e6,m.getMetric(FrameMetrics.SYNC_DURATION)/1e6,m.getMetric(FrameMetrics.SWAP_BUFFERS_DURATION)/1e6});dropped[0]+=missed;}}};main(ins,()->active.getWindow().addOnFrameMetricsAvailableListener(listener,new Handler(frames.getLooper())));
            try{for(boolean full:new boolean[]{false,true}){
                main(ins,()->{active.engine.invoke("nativeView",full?0:99800,99999);active.chart.invalidate();});ins.waitForIdleSync();SystemClock.sleep(80);final int[] loc=new int[2],size=new int[2];main(ins,()->{active.chart.getLocationOnScreen(loc);size[0]=active.chart.getWidth();size[1]=active.chart.getHeight();});
                Handler heartbeat=new Handler(Looper.getMainLooper());final ArrayList<Double> gaps=new ArrayList<>();final long[] lastBeat={0};Runnable beat=new Runnable(){public void run(){long now=System.nanoTime();gaps.add((now-lastBeat[0])/1e6);lastBeat[0]=now;heartbeat.postDelayed(this,16);}};
                JSONArray rows=new JSONArray();final JSONObject[] before=new JSONObject[1],after=new JSONObject[1];
                try{for(int i=-15;i<samples;i++){
                    if(i==0)main(ins,()->{before[0]=memory(active);synchronized(frameRows){frameRows.clear();dropped[0]=0;measuring[0]=true;}lastBeat[0]=System.nanoTime();heartbeat.postDelayed(beat,16);});
                    Sample sample=new Sample(SystemClock.uptimeMillis());main(ins,()->active.profileSample=sample);MotionEvent.PointerProperties p=new MotionEvent.PointerProperties();p.id=0;p.toolType=MotionEvent.TOOL_TYPE_MOUSE;MotionEvent.PointerCoords c=new MotionEvent.PointerCoords();c.x=loc[0]+size[0]*(.15f+.55f*((i+15)%17)/16f);c.y=loc[1]+size[1]*(.3f+.2f*((i+15)%11)/10f);MotionEvent e=MotionEvent.obtain(sample.eventTime,sample.eventTime,MotionEvent.ACTION_HOVER_MOVE,1,new MotionEvent.PointerProperties[]{p},new MotionEvent.PointerCoords[]{c},0,0,1,1,0,0,InputDevice.SOURCE_MOUSE,0);sample.injected=System.nanoTime();boolean accepted;try{accepted=ins.getUiAutomation().injectInputEvent(e,true);}finally{e.recycle();}if(!accepted)throw new AssertionError("System hover input rejected");if(!sample.done.await(10,TimeUnit.SECONDS))throw new AssertionError("System hover did not submit frame");if(sample.error!=null)throw new AssertionError(sample.error);if(i>=0)rows.put(sample.json());main(ins,()->active.profileSample=null);
                }}finally{main(ins,()->{if(lastBeat[0]>0)gaps.add((System.nanoTime()-lastBeat[0])/1e6);heartbeat.removeCallbacks(beat);synchronized(frameRows){measuring[0]=false;}after[0]=memory(active);});}
                JSONArray metrics=new JSONArray();int missed;synchronized(frameRows){for(double[] row:frameRows)metrics.put(new JSONArray(row));missed=dropped[0];}cases.put(new JSONObject().put("bars",100000).put("seed",42).put("lines",lines).put("source","close").put("range",full?"full100000":"recent200").put("widthPx",size[0]).put("heightPx",size[1]).put("density",active.getResources().getDisplayMetrics().density).put("warmup",15).put("samples",rows).put("heartbeatGapsMs",new JSONArray(gaps)).put("frameMetrics",metrics).put("frameMetricDroppedReports",missed).put("memoryBefore",before[0]).put("memoryAfter",after[0]));
            }}finally{main(ins,()->{active.getWindow().removeOnFrameMetricsAvailableListener(listener);active.chart.setDrawProbe(null);active.chart.setOnHoverListener(null);});frames.quitSafely();frames.join(3000);if(frames.isAlive())throw new AssertionError("Frame metrics thread did not stop");}
            main(ins,active::finish);ins.waitForIdleSync();a=null;
        }}finally{if(a!=null){MobileUXActivity active=a;main(ins,active::finish);ins.waitForIdleSync();}}
        return new JSONObject().put("passed",true).put("cases",cases).put("inputPath","UiAutomation actual system mouse input -> default AsterChartView.onHoverEvent -> onDraw CPU Canvas submit").put("scope","15warm/60default samples, one input in flight; FrameMetrics/16ms handler heartbeat only measured interval incl final gap; JNI scene serialize+separate JSON parse; genericMotionDispatch includes pointer bridge/hierarchy, not exclusive JNI. Emulator only, no physical display FPS claim.").put("physicalDevice",false).put("api",Build.VERSION.SDK_INT);
    }
}
