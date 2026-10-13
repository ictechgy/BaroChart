package dev.aster.charts;

import android.content.Context;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** Seed42 current-sync/current-async measurements. Setup and digest excluded. */
final class AsyncBenchmark {
    private static final String[] NAMES={"sma","ema","bollinger","macd","donchian","stochastic","rsi","atr"};
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final JSONArray rows=new JSONArray();
    private Context context;private Consumer<JSONObject> completion;private AsterEngine working;
    private int count,position;private JSONObject current,syncDigest;private boolean finished=false;
    private Heartbeat activeHeartbeat;private MemorySampler activeMemory;
    void run(Context context,int count,Consumer<JSONObject> completion){this.context=context;this.count=count;this.completion=completion;if(count<512||count>1000000){finish(new IllegalArgumentException("Benchmark bars must be512..1000000"));return;}handler.post(this::nextPosition);}
    void cancel(){if(finished)return;finish(new IllegalStateException("Benchmark activity destroyed"));}
    private JSONObject options() throws JSONException {return new JSONObject().put("panels",new JSONArray().put(new JSONObject().put("id","price").put("weight",1))).put("series",new JSONArray().put(new JSONObject().put("id","price").put("type","candles").put("panel","price")));}
    private AsterEngine prepare() throws Exception {AsterEngine e=new AsterEngine(context,count,options());try{int outputs=0;for(String name:NAMES)outputs+=((JSONArray)e.invoke("nativeIndicator",name,name,new JSONObject(),"price")).length();if(outputs!=15)throw new AssertionError("Expected15 indicator outputs");e.scene(1200,700);return e;}catch(Throwable error){e.close();throw error;}}
    private JSONObject event(AsterEngine e,int index) throws JSONException {Object result=e.invoke("nativeBenchmarkEvent",index);return result instanceof String?new JSONObject((String)result):(JSONObject)result;}
    private JSONObject digest(AsterEngine e) throws JSONException {Object result=e.invoke("nativeBenchmarkDigest");return result instanceof String?new JSONObject((String)result):(JSONObject)result;}
    private String digestComparable(JSONObject digest) throws JSONException {JSONObject comparable=new JSONObject(digest.toString());AsyncVerification.normalizeGeometryKey(comparable.getJSONObject("layout"),null);return canonical(comparable);}
    private String canonical(Object value) throws JSONException {if(value instanceof JSONObject){JSONObject object=(JSONObject)value;ArrayList<String> keys=new ArrayList<>();Iterator<String> iterator=object.keys();while(iterator.hasNext())keys.add(iterator.next());Collections.sort(keys);StringBuilder text=new StringBuilder("{");for(String key:keys){if(text.length()>1)text.append(',');text.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key)));}return text.append('}').toString();}if(value instanceof JSONArray){JSONArray array=(JSONArray)value;StringBuilder text=new StringBuilder("[");for(int i=0;i<array.length();i++){if(i>0)text.append(',');text.append(canonical(array.get(i)));}return text.append(']').toString();}return value instanceof String?JSONObject.quote((String)value):String.valueOf(value);}
    private int index(){return position==0?0:position==1?count/2:count-1;}
    private String location(){return new String[]{"first","middle","tail"}[position];}
    private void nextPosition(){if(finished)return;if(position==3){finish(null);return;}try{
        long setup=System.nanoTime();working=prepare();current=new JSONObject().put("position",location()).put("index",index()).put("storedBars",count).put("syncSetupMs",(System.nanoTime()-setup)/1e6);
        JSONObject change=event(working,index());Heartbeat heartbeat=new Heartbeat();MemorySampler memory=new MemorySampler();activeHeartbeat=heartbeat;activeMemory=memory;memory.start();heartbeat.start();long started=System.nanoTime();
        working.applyDataEvent(change);working.scene(1200,700);double elapsed=(System.nanoTime()-started)/1e6;heartbeat.stop();memory.stop();
        current.put("sync",new JSONObject().put("elapsedApplyAndSceneMs",elapsed).put("ownerHeartbeat",heartbeat.report()).put("memory",memory.report()));syncDigest=digest(working);current.put("syncDigest",syncDigest);working.close();working=null;
        // Separate fresh context; previous synchronous allocation is released.
        handler.post(this::runAsync);
    }catch(Throwable error){finish(error);}}
    private void runAsync(){if(finished)return;try{
        long setup=System.nanoTime();working=prepare();current.put("asyncSetupMs",(System.nanoTime()-setup)/1e6);JSONObject change=event(working,index());final AsterEngine source=working;
        Heartbeat heartbeat=new Heartbeat();MemorySampler memory=new MemorySampler();activeHeartbeat=heartbeat;activeMemory=memory;memory.start();heartbeat.start();long started=System.nanoTime();
        source.applyDataEventAsync(change,new AsterEngine.AsyncOptions(120000,4096),new AsterEngine.AsyncListener(){
            @Override public void onComplete(AsterEngine.AsyncResult result){try{
                if(finished){heartbeat.stop();memory.stop();return;}if(result.succeeded())source.scene(1200,700);double elapsed=(System.nanoTime()-started)/1e6;heartbeat.stop();memory.stop();
                current.put("async",new JSONObject().put("elapsedApplyAndSceneMs",elapsed).put("ownerHeartbeat",heartbeat.report()).put("memory",memory.report()).put("job",result.toJSON()));
                if(!result.succeeded())throw new IllegalStateException("Async benchmark failed: "+result.status,result.error);
                JSONObject actual=digest(source);boolean parity=digestComparable(syncDigest).equals(digestComparable(actual));current.put("asyncDigest",actual).put("digestParity",parity).put("geometryKeyComparison","Only validated positive integer per-context store identity at index 4 normalized; original digests retained; timeVersion/all remaining key positions/layout exact");if(!parity)throw new AssertionError("Synchronous/asynchronous digest or layout mismatch at"+location());
                rows.put(current);source.close();working=null;position++;handler.post(AsyncBenchmark.this::nextPosition);
            }catch(Throwable error){heartbeat.stop();memory.stop();finish(error);}}
        });
    }catch(Throwable error){finish(error);}}
    private void finish(Throwable error){if(finished)return;finished=true;if(activeHeartbeat!=null)activeHeartbeat.stop();if(activeMemory!=null)activeMemory.stop();if(working!=null){working.close();working=null;}try{
        JSONObject report=new JSONObject().put("version","0.2.3").put("mode","current synchronous vs current optional asynchronous on same Android process/platform").put("seed",42).put("storedBars",count).put("indicators",new JSONArray(NAMES)).put("outputs",15).put("width",1200).put("height",700).put("samplesPerPosition",1).put("positions",rows).put("passed",error==null?rows.length():0).put("physicalDevice",false).put("androidAPI",android.os.Build.VERSION.SDK_INT).put("model",android.os.Build.MODEL).put("abi",android.os.Build.SUPPORTED_ABIS[0]).put("host","Android owner Handler + isolated QuickJS JNI; no WebView").put("method","fresh contexts for each mode/position; setup and output digest outside interval; event correction close1000/highmax(original,1000); apply plus ready scene inside interval; async timeout120s/step4096;16ms UI Handler heartbeat includes final interval;50ms background process-memory sampling including final sample; no p95 from a single sample").put("memoryScope","processPSS/RSS include VM, renderer/demo10k context, other application allocations and released pages; sampled peaks are lower bounds; job metrics distinguish requested QuickJS allocation peak and bounded copy buffers");
        if(error!=null)report.put("failed",true).put("error",error.toString()).put("incompletePosition",current==null?JSONObject.NULL:current);completion.accept(report);
    }catch(JSONException jsonError){throw new IllegalStateException(jsonError);}}
    private static final class Heartbeat {
        final Handler handler=new Handler(Looper.getMainLooper());long previous,maxGap;int beats;boolean stopped;
        final Runnable pulse=new Runnable(){@Override public void run(){if(stopped)return;long now=System.nanoTime();maxGap=Math.max(maxGap,now-previous);previous=now;beats++;handler.postDelayed(this,16);}};
        void start(){previous=System.nanoTime();handler.postDelayed(pulse,16);}
        void stop(){if(stopped)return;maxGap=Math.max(maxGap,System.nanoTime()-previous);stopped=true;handler.removeCallbacks(pulse);}
        JSONObject report() throws JSONException {return new JSONObject().put("intervalMs",16).put("callbacks",beats).put("maximumIntervalIncludingFinalMs",maxGap/1e6);}
    }
    private static final class MemorySampler {
        final AtomicLong pssPeak=new AtomicLong(),rssPeak=new AtomicLong();final AtomicInteger samples=new AtomicInteger();volatile boolean running;long pssBefore,rssBefore;Thread thread;
        void sample(boolean required){Debug.MemoryInfo info=new Debug.MemoryInfo();Debug.getMemoryInfo(info);long pss=info.getTotalPss(),rss=0;try(BufferedReader in=new BufferedReader(new FileReader("/proc/self/status"))){String line;while((line=in.readLine())!=null)if(line.startsWith("VmRSS:")){rss=Long.parseLong(line.substring(6).trim().split("\\s+")[0]);break;}}catch(IOException|NumberFormatException ignored){}
            synchronized(this){if(!required&&!running)return;maximum(pssPeak,pss);maximum(rssPeak,rss);samples.incrementAndGet();}}
        static void maximum(AtomicLong target,long value){long old;do{old=target.get();if(old>=value)return;}while(!target.compareAndSet(old,value));}
        void start(){sample(true);pssBefore=pssPeak.get();rssBefore=rssPeak.get();running=true;thread=new Thread(()->{while(running){try{Thread.sleep(50);}catch(InterruptedException stop){break;}if(running)sample(false);}},"Aster benchmark memory sampler");thread.start();}
        void stop(){synchronized(this){if(!running)return;running=false;}thread.interrupt();sample(true);}
        JSONObject report() throws JSONException {return new JSONObject().put("sampleIntervalMs",50).put("samples",samples.get()).put("processPssBeforeKiB",pssBefore).put("sampledProcessPssPeakKiB",pssPeak.get()).put("processRssBeforeKiB",rssBefore).put("sampledProcessRssPeakKiB",rssPeak.get()).put("rssAvailable",rssPeak.get()>0);}
    }
}
