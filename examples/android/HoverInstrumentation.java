package dev.aster.charts;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.*;
import android.view.*;
import org.json.*;
import java.io.*;
import java.util.concurrent.TimeUnit;

/** System InputDispatcher injection through UiAutomation, never View.dispatch*. */
public final class HoverInstrumentation extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle arguments){super.onCreate(arguments);this.arguments=arguments;start();}
    @Override public void onStart(){JSONObject report=new JSONObject();HoverActivity activity=null;try{
        if("true".equals(arguments.getString("binding-test"))){activity=(HoverActivity)startActivitySync(new Intent(getTargetContext(),HoverActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("bars",0).putExtra("lines",1));waitForIdleSync();if(activity.failure!=null)throw new AssertionError(activity.failure);report=(JSONObject)Class.forName("dev.aster.charts.HoverBindingVerification").getMethod("run",HoverActivity.class,Instrumentation.class).invoke(null,activity,this);writeAndFinish(report,activity);return;}
        if("true".equals(arguments.getString("idle-test"))){activity=(HoverActivity)startActivitySync(new Intent(getTargetContext(),HoverActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("bars",4096).putExtra("lines",1));waitForIdleSync();if(activity.failure!=null)throw new AssertionError(activity.failure);report=(JSONObject)Class.forName("dev.aster.charts.HoverIdleVerification").getMethod("run",HoverActivity.class,Instrumentation.class).invoke(null,activity,this);writeAndFinish(report,activity);return;}
        if("true".equals(arguments.getString("cache-test"))){activity=(HoverActivity)startActivitySync(new Intent(getTargetContext(),HoverActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("bars",100000).putExtra("lines",1));waitForIdleSync();if(activity.failure!=null)throw new AssertionError(activity.failure);report=(JSONObject)Class.forName("dev.aster.charts.HoverCacheVerification").getMethod("run",HoverActivity.class,Instrumentation.class).invoke(null,activity,this);writeAndFinish(report,activity);return;}
        boolean smoke="true".equals(arguments.getString("smoke"));int samples=Integer.parseInt(arguments.getString("samples",smoke?"2":"60")),warmup=smoke?1:15;if(samples<1||samples>600)throw new IllegalArgumentException("samples1..600");JSONArray cases=new JSONArray();report.put("cases",cases);
        for(int lines:new int[]{1,32}){if(smoke&&lines==32)break;activity=(HoverActivity)startActivitySync(new Intent(getTargetContext(),HoverActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("bars",100000).putExtra("lines",lines));waitForIdleSync();if(activity.failure!=null)throw new AssertionError(activity.failure);final HoverActivity active=activity;
            for(boolean full:new boolean[]{false,true}){if(smoke&&full)break;runOnMainSync(()->{try{active.engine.invoke("nativeView",full?0:99800,99999);active.chart.invalidate();}catch(Exception e){active.failure=e;}});waitForIdleSync();if(active.failure!=null)throw new AssertionError(active.failure);
                final int[] location=new int[2],size=new int[2];runOnMainSync(()->{active.chart.getLocationOnScreen(location);size[0]=active.chart.getWidth();size[1]=active.chart.getHeight();});if(size[0]<100||size[1]<100)throw new AssertionError("No attached chart viewport");
                JSONArray rows=new JSONArray();final JSONObject[] memoryBefore=new JSONObject[1];for(int i=-warmup;i<samples;i++){
                    if(i==0){runOnMainSync(()->{try{memoryBefore[0]=active.memorySnapshot();}catch(Exception e){active.failure=e;}});if(active.failure!=null)throw new AssertionError(active.failure);runOnMainSync(active::beginMeasurement);}
                    long time=SystemClock.uptimeMillis();HoverActivity.Sample sample=new HoverActivity.Sample(time,System.nanoTime());runOnMainSync(()->active.pending=sample);
                    MotionEvent.PointerProperties property=new MotionEvent.PointerProperties();property.id=0;property.toolType=MotionEvent.TOOL_TYPE_MOUSE;MotionEvent.PointerCoords coords=new MotionEvent.PointerCoords();coords.x=location[0]+size[0]*(.15f+.55f*((i+warmup)%17)/16);coords.y=location[1]+size[1]*(.3f+.2f*((i+warmup)%11)/10);coords.pressure=0;coords.size=0;
                    // MOVE lets InputDispatcher synthesize ENTER when needed. Explicit ENTER
                    // after another instrumentation session is invalid if that device still hovers.
                    MotionEvent event=MotionEvent.obtain(time,time,MotionEvent.ACTION_HOVER_MOVE,1,new MotionEvent.PointerProperties[]{property},new MotionEvent.PointerCoords[]{coords},0,0,1,1,0,0,InputDevice.SOURCE_MOUSE,0);
                    boolean accepted;sample.injectNanos=System.nanoTime();try{accepted=getUiAutomation().injectInputEvent(event,true);}finally{event.recycle();}if(!accepted)throw new AssertionError("System injection rejected");if(!sample.submitted.await(10,TimeUnit.SECONDS))throw new AssertionError("Injected event did not reach chart and onDraw");if(sample.error!=null)throw new AssertionError(sample.error);if(sample.source!=InputDevice.SOURCE_MOUSE||sample.tool!=MotionEvent.TOOL_TYPE_MOUSE)throw new AssertionError("Wrong system event source/tool");if(i>=0)rows.put(sample.json());
                    runOnMainSync(()->active.pending=null);
                }
                final JSONObject[] metrics=new JSONObject[1];runOnMainSync(()->{try{metrics[0]=active.endMeasurement();}catch(JSONException e){active.failure=e;}});if(active.failure!=null)throw new AssertionError(active.failure);
                final JSONObject[] memoryAfter=new JSONObject[1];runOnMainSync(()->{try{memoryAfter[0]=active.memorySnapshot();}catch(Exception e){active.failure=e;}});if(active.failure!=null)throw new AssertionError(active.failure);
                cases.put(new JSONObject().put("lines",lines).put("range",full?"full100000":"recent200").put("bars",100000).put("seed",42).put("widthPx",size[0]).put("heightPx",size[1]).put("density",activity.getResources().getDisplayMetrics().density).put("warmup",warmup).put("samples",rows).put("systemInputAccepted",true).put("metrics",metrics[0]).put("memoryBefore",memoryBefore[0]).put("memoryAfter",memoryAfter[0]));
            }
            runOnMainSync(active::finish);waitForIdleSync();activity=null;
        }
        report.put("passed",true).put("physicalDevice",false).put("androidAPI",Build.VERSION.SDK_INT).put("model",Build.MODEL).put("abi",Build.SUPPORTED_ABIS[0]).put("cases",cases).put("inputPath","Instrumentation.UiAutomation.injectInputEvent -> system InputDispatcher -> View hover listener -> nativePointer -> invalidate -> onDraw Java Canvas command submission").put("scope","onDraw-end is CPU Canvas command submission, not physical display/presentation. JNI includes JS scene generation and JSON serialization; separate envelope/body parse; Canvas stages include recording or bitmap raster depending mode. One event in flight; setup and warmup excluded; heartbeat includes final gap; emulator SwiftShader only.");
    }catch(Throwable error){try{report.put("passed",false).put("error",error.toString());StringWriter trace=new StringWriter();error.printStackTrace(new PrintWriter(trace));report.put("stack",trace.toString());}catch(JSONException ignored){}}
        writeAndFinish(report,activity);
    }
    private void writeAndFinish(JSONObject report,HoverActivity activity){
        if(activity!=null){HoverActivity active=activity;runOnMainSync(active::finish);}String file=arguments.getString("report","android-hover.json");if(!file.matches("[a-zA-Z0-9_.-]+\\.json"))file="android-hover.json";
        try(FileOutputStream out=getTargetContext().openFileOutput(file,0)){out.write(report.toString(2).getBytes("UTF-8"));}catch(Exception e){throw new RuntimeException(e);}Bundle result=new Bundle();result.putString("report",file);result.putString("passed",String.valueOf(report.optBoolean("passed")));finish(report.optBoolean("passed")?0:1,result);
    }
}
