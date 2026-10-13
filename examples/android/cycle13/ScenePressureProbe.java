package dev.aster.charts;
import android.os.*;import android.view.*;import org.json.*;import java.util.*;import java.io.*;

/** Test-only activity input capture + existing production View draw endpoint. */
final class ScenePressureProbe {
    final JSONArray inputs=new JSONArray(),memory=new JSONArray(),lifecycle=new JSONArray();
    final ArrayDeque<JSONObject> pending=new ArrayDeque<>();
    final Stats heartbeat=new Stats(),draw=new Stats(),enqueue=new Stats(),drain=new Stats(),inputAge=new Stats(),inputSubmit=new Stats(),frameTotal=new Stats();
    final Stats sceneJNI=new Stats(),envelopeParse=new Stats(),bodyParse=new Stats(),canvas=new Stats(),accessibility=new Stats(),bitmap=new Stats(),directHistorySync=new Stats();
    final Stats metadataParse=new Stats(),numericValidation=new Stats(),paintPreparation=new Stats();
    final HashMap<String,java.lang.reflect.Field> packetFields=new HashMap<>();
    private java.lang.reflect.Field preparationField;
    long packetNumericBytes,packetMetadataChars,packetCommands,packetStrings,jsonDraws,typedDraws;
    long frameMetricsDropped;
    long inputCount,drawCount,unmatched,sampleDrops,lastBeat;boolean measuring,foreground=true;
    static final class Stats {
        long count;double total,max;final long[] buckets=new long[1025];
        void add(double ms){if(!Double.isFinite(ms)||ms<0)return;count++;total+=ms;max=Math.max(max,ms);buckets[Math.min(1024,(int)Math.floor(ms*4))]++;}
        double quantile(double fraction){long target=(long)Math.ceil(count*fraction),n=0;for(int i=0;i<buckets.length;i++){n+=buckets[i];if(n>=target)return i/4d;}return max;}
        JSONObject json()throws JSONException{return new JSONObject().put("count",count).put("meanMs",count==0?JSONObject.NULL:total/count).put("p50LowerBinMs",count==0?JSONObject.NULL:quantile(.5)).put("p95LowerBinMs",count==0?JSONObject.NULL:quantile(.95)).put("maxMs",max).put("quantileMethod","all samples in0.25ms bins, overflowbin>=256ms; max exact");}
    }
    ScenePressureProbe(){for(String name:new String[]{"transport","metadataParseNanos","numericValidationNanos","numericBytes","commandCount","stringCount"})try{java.lang.reflect.Field field=AsterEngine.SceneTiming.class.getDeclaredField(name);field.setAccessible(true);packetFields.put(name,field);}catch(NoSuchFieldException absent){/* Frozen legacy SDK has no typed counters. */}try{preparationField=AsterChartView.DrawTiming.class.getDeclaredField("packetPreparationNanos");preparationField.setAccessible(true);}catch(NoSuchFieldException absent){/* Frozen legacy SDK. */}}
    private long number(AsterEngine.SceneTiming scene,String name){java.lang.reflect.Field field=packetFields.get(name);if(field==null)return 0;try{return ((Number)field.get(scene)).longValue();}catch(IllegalAccessException error){throw new AssertionError(error);}}
    private String transport(AsterEngine.SceneTiming scene){java.lang.reflect.Field field=packetFields.get("transport");if(field==null)return "json";try{return (String)field.get(scene);}catch(IllegalAccessException error){throw new AssertionError(error);}}
    private long preparation(AsterChartView.DrawTiming timing){if(preparationField==null)return 0;try{return preparationField.getLong(timing);}catch(IllegalAccessException error){throw new AssertionError(error);}}
    JSONObject capture(MotionEvent event)throws JSONException {
        if(!measuring||!event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN))return null;
        long nano=System.nanoTime(),uptime=SystemClock.uptimeMillis();JSONObject row=new JSONObject().put("ordinal",++inputCount).put("action",event.getActionMasked()).put("source",event.getSource()).put("tool",event.getToolType(0)).put("deviceEventUptimeMs",event.getEventTime()).put("captureUptimeMs",uptime).put("captureNanos",nano).put("x",event.getRawX()).put("y",event.getRawY());
        if(pending.size()==512){pending.removeFirst();sampleDrops++;}pending.addLast(row);return row;
    }
    void dispatch(JSONObject row,long began)throws JSONException {if(row!=null)row.put("dispatchCpuMs",(System.nanoTime()-began)/1e6);}
    void submitted(AsterChartView.DrawTiming timing,long revision)throws JSONException {
        if(!measuring)return;drawCount++;draw.add((timing.submitNanos-timing.startNanos)/1e6);sceneJNI.add(timing.scene.jniNanos/1e6);envelopeParse.add(timing.scene.envelopeParseNanos/1e6);bodyParse.add(timing.scene.bodyParseNanos/1e6);canvas.add(timing.canvasNanos/1e6);accessibility.add(timing.accessibilityNanos/1e6);bitmap.add(timing.bitmapCopyNanos/1e6);
        String route=transport(timing.scene);if(route.equals("f64"))typedDraws++;else jsonDraws++;metadataParse.add(number(timing.scene,"metadataParseNanos")/1e6);numericValidation.add(number(timing.scene,"numericValidationNanos")/1e6);paintPreparation.add(preparation(timing)/1e6);packetNumericBytes+=number(timing.scene,"numericBytes");packetMetadataChars+=timing.scene.jsonChars;packetCommands+=number(timing.scene,"commandCount");packetStrings+=number(timing.scene,"stringCount");
        while(!pending.isEmpty()){
            JSONObject row=pending.removeFirst();long captured=row.getLong("captureNanos");if(timing.startNanos<captured){pending.addFirst(row);break;}
            double age=row.getLong("captureUptimeMs")-row.getLong("deviceEventUptimeMs"),after=(timing.submitNanos-captured)/1e6;inputAge.add(age);inputSubmit.add(age+after);
            row.put("submitNanos",timing.submitNanos).put("captureToCpuSubmitMs",after).put("inputToCaptureMs",age).put("inputToCpuSubmitEstimateMs",age+after).put("deviceClockQuantumMs",1).put("renderedRevision",revision).put("sceneJNI",timing.scene.jniNanos/1e6).put("envelopeParse",timing.scene.envelopeParseNanos/1e6).put("bodyParse",timing.scene.bodyParseNanos/1e6).put("canvas",timing.canvasNanos/1e6).put("accessibility",timing.accessibilityNanos/1e6).put("bitmapCopy",timing.bitmapCopyNanos/1e6).put("baseChanged",timing.baseChanged).put("transport",route);
            if(inputs.length()<24000)inputs.put(row);else sampleDrops++;
        }
    }
    void beat(){long now=System.nanoTime();if(lastBeat!=0&&foreground)heartbeat.add((now-lastBeat)/1e6);lastBeat=now;}
    void end(){if(measuring){beat();measuring=false;unmatched+=pending.size();pending.clear();}}
    void event(String kind)throws JSONException {lifecycle.put(new JSONObject().put("kind",kind).put("uptimeMs",SystemClock.uptimeMillis()));foreground=!(kind.equals("pause")||kind.equals("stop"));}
    static long rss(){try(BufferedReader in=new BufferedReader(new FileReader("/proc/self/status"))){String line;while((line=in.readLine())!=null)if(line.startsWith("VmRSS:"))return Long.parseLong(line.substring(6).trim().split("\\s+")[0]);}catch(IOException|NumberFormatException ignored){}return -1;}
    JSONObject json()throws JSONException{return new JSONObject().put("inputCount",inputCount).put("drawCount",drawCount).put("rawInputRows",inputs).put("inputSampleDrops",sampleDrops).put("unmatchedInputRowsAtEnd",unmatched).put("inputAge",inputAge.json()).put("inputToCpuSubmitEstimate",inputSubmit.json()).put("heartbeatForeground",heartbeat.json()).put("onDraw",draw.json()).put("sceneJNI",sceneJNI.json()).put("envelopeParse",envelopeParse.json()).put("bodyParse",bodyParse.json()).put("canvas",canvas.json()).put("accessibility",accessibility.json()).put("bitmapCopy",bitmap.json()).put("metadataParse",metadataParse.json()).put("numericValidation",numericValidation.json()).put("paintPreparation",paintPreparation.json()).put("transportCounts",new JSONObject().put("json",jsonDraws).put("f64",typedDraws)).put("packetTransferredNumericBytes",packetNumericBytes).put("packetMetadataChars",packetMetadataChars).put("packetCommands",packetCommands).put("packetStrings",packetStrings).put("enqueueOwner",enqueue.json()).put("drainOwner",drain.json()).put("directHistorySyncFallback",directHistorySync.json()).put("windowFrameMetricsTotal",frameTotal.json()).put("windowFrameMetricsDroppedReports",frameMetricsDropped).put("frameMetricsScope","Android Window TOTAL_DURATION on emulator, separate from CPU Canvas submit; no physical presentation/FPS inference").put("memory",memory).put("lifecycle",lifecycle).put("boundary","ADB shell input eventTime device uptime(ms) -> Activity dispatch -> default production View -> first subsequent onDraw CPU Canvas submit. Host ADB roundtrip and physical presentation are separate/unmeasured. Same new diagnostic fixture in legacy/typed paths; old900 raw is preserved separately.");}
}
