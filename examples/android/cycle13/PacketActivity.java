package dev.aster.charts;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Functional tests use a real attached View. Timing comparisons use another fixture. */
public final class PacketActivity extends Activity {
    AsterEngine engine;AsterChartView chart;JSONObject result;volatile boolean complete;int submitted,inputCount;
    private final Handler handler=new Handler(Looper.getMainLooper());private final JSONArray checks=new JSONArray();
    private int phase;private long failures,recoveryPackets;private JSONObject identity;private boolean rasterizing;
    private void check(boolean value,String label){if(!value)throw new AssertionError(label);checks.put(label);}
    @Override public void onCreate(Bundle state){super.onCreate(state);try{
        try(InputStream in=getAssets().open("packet-identity.json")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] bytes=new byte[4096];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);identity=new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));}
        JSONObject decoder=PacketVerification.decoder(),pixels=PacketVerification.pixels(this);check(decoder.getBoolean("passed"),"Decoder bounds suite");check(pixels.getBoolean("passed"),"Opcode pixel suite");
        result=new JSONObject().put("schema","aster.cycle13.android-packet").put("runId",getIntent().getStringExtra("runId")).put("buildIdentity",identity).put("decoder",decoder).put("pixels",pixels).put("physicalDevice",false);
        engine=new AsterEngine(this,512,new JSONObject().put("panels",new JSONArray().put(new JSONObject().put("id","price").put("weight",3)).put(new JSONObject().put("id","volume").put("weight",1))));
        engine.addSeries(new JSONObject().put("id","area").put("type","area").put("panel","price").put("source","close").put("fill","#ff000066"));engine.addSeries(new JSONObject().put("id","volume").put("type","histogram").put("panel","volume").put("source","volume"));
        jniGuards();chart=new AsterChartView(this,engine);chart.setDrawProbe(timing->{submitted++;if(!complete&&!rasterizing)handler.post(()->{try{advance();}catch(Throwable error){fail(error);}});});
        LinearLayout content=new LinearLayout(this);content.addView(chart,new LinearLayout.LayoutParams(-1,-1));setContentView(content);
    }catch(Throwable error){fail(error);}}
    private void jniGuards()throws Exception {
        for(String mode:new String[]{"float32","missing-numbers","missing-metadata","metadata-type","metadata-budget","number-budget","record","nonfinite","throw"}){engine.invoke("nativePacketFixtureMode",mode);boolean rejected=false;try{engine.scenePacket("scene",null,320,240,false);}catch(IllegalStateException|IllegalArgumentException|org.json.JSONException expected){rejected=true;}check(rejected,"Genuine JNI rejects "+mode);}
        engine.invoke("nativePacketFixtureMode","offset");AsterEngine.ScenePacket offset=engine.scenePacket("scene",null,320,240,false);check(offset.commandCount>0,"Genuine JNI intrinsic F64 view byte offset copied");
        engine.invoke("nativePacketFixtureMode","unicode");AsterEngine.ScenePacket unicode=engine.scenePacket("scene",null,320,240,false);check(unicode.strings[unicode.strings.length-1].equals("A\u0000\n\"한글 😀\ud800"),"Genuine JNI escaped dictionary Unicode/NUL/lone-surrogate parity");engine.invoke("nativePacketFixtureMode","ok");
        engine.scenePacket("frame","fixture-empty-frame",320,240,true);AsterEngine.ScenePacket empty=engine.scenePacket("frame","fixture-empty-frame",320,240,false);check(empty.numbers.length==0&&empty.layerCounts[0]==-1&&empty.layerCounts[1]==-1&&empty.layerCounts[2]==0,"Genuine JNI cached second frame owns double0 with omitted base/drawings and empty hover");engine.releaseFrameCache("fixture-empty-frame");
    }
    private void advance()throws Exception {
        JSONObject metrics=chart.renderCacheMetrics();
        if(phase==0){if(submitted<2){chart.invalidate();return;}check(chart.lastError==null&&metrics.getLong("packetFrames")>=2&&metrics.getLong("packetFailures")==0,"Attached cached typed frames");check(metrics.getLong("cacheHits")>=1,"Cached unchanged base omitted safely");rasterParity();failures=metrics.getLong("packetFailures");phase=1;engine.invoke("nativePacketFixtureMode","record");engine.setTheme(new JSONObject().put("grid","#264653"));return;}
        if(phase==1){check(chart.lastError==null&&metrics.getLong("packetFailures")==failures+1&&metrics.getLong("legacyFrames")>0,"Malformed cached packet explicitly falls back");check(metrics.getString("packetFailure").length()>0,"Fallback preserves diagnostic reason");rasterParity();recoveryPackets=chart.renderCacheMetrics().getLong("packetFrames");phase=2;engine.invoke("nativePacketFixtureMode","ok");handler.postDelayed(()->chart.invalidate(),600);return;}
        if(phase==2){if(metrics.getLong("packetFrames")<=recoveryPackets)return;check(chart.lastError==null&&metrics.getLong("packetFailures")==failures+1,"Typed route recovers after failure cooldown");rasterParity();phase=3;handler.post(()->{try{advance();}catch(Throwable error){fail(error);}});return;}
        if(phase==3&&inputCount>=2){check(chart.lastError==null,"Real framework touch accepted by typed attached View");result.put("cache",chart.renderCacheMetrics());phase=4;chart.setRenderCacheEnabled(false);return;}
        if(phase==4){check(chart.lastError==null&&!chart.isRenderCacheEnabled()&&chart.renderCacheMetrics().getLong("ownedBitmapBytes")==0,"Separate noncached typed View owns no bitmaps");rasterParity();result.put("direct",chart.renderCacheMetrics()).put("inputCount",inputCount).put("drawCount",submitted);chart.setDrawProbe(null);engine.close();check(chart.renderCacheMetrics().getLong("ownedBitmapBytes")==0,"Closed attached View owns no bitmaps");AsterEngine witness=new AsterEngine(this,0);try{JSONObject ledger=witness.runtimeMetrics();check(ledger.getLong("processLiveNativeHandles")==1,"Source/JNI fixtures closed; only empty witness remains");result.put("runtimeBeforeWitnessClose",ledger);}finally{witness.close();}result.put("checks",checks).put("passed",true);complete=true;}
    }
    private void rasterParity()throws Exception {
        int w=chart.getWidth(),h=chart.getHeight();Bitmap actual=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888),reference=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);rasterizing=true;try{
            chart.draw(new Canvas(actual));Canvas canvas=new Canvas(reference);float density=getResources().getDisplayMetrics().density;canvas.scale(density,density);chart.render(canvas,engine.scene(Math.max(100,w/density),Math.max(80,h/density)));int[] a=new int[w*h],b=new int[a.length];actual.getPixels(a,0,w,0,0,w,h);reference.getPixels(b,0,w,0,0,w,h);check(Arrays.equals(a,b),"Attached frame/public JSONObject software raster exact phase"+phase);
        }finally{rasterizing=false;actual.recycle();reference.recycle();}
    }
    @Override public boolean dispatchTouchEvent(MotionEvent event){if(event.isFromSource(android.view.InputDevice.SOURCE_TOUCHSCREEN))inputCount++;return super.dispatchTouchEvent(event);}
    void fail(Throwable error){try{if(result==null)result=new JSONObject();result.put("passed",false).put("error",error.toString()).put("checks",checks).put("phase",phase);}catch(org.json.JSONException reporting){android.util.Log.e("AsterPacket","Report",reporting);}complete=true;if(chart!=null)chart.setDrawProbe(null);if(engine!=null)engine.close();}
    @Override protected void onDestroy(){handler.removeCallbacksAndMessages(null);if(chart!=null)chart.setDrawProbe(null);if(engine!=null)engine.close();super.onDestroy();}
}
