package dev.aster.charts;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** UiAutomation injects through the Android input dispatcher, not View dispatch. */
public final class PacketInstrumentation extends Instrumentation {
    private String file,runId;
    @Override public void onCreate(Bundle args){file=args.getString("report","packet-functional.json");runId=args.getString("runId",UUID.randomUUID().toString());start();}
    private static MotionEvent touch(long down,long when,int action,float x,float y){MotionEvent.PointerProperties p=new MotionEvent.PointerProperties();p.id=0;p.toolType=MotionEvent.TOOL_TYPE_FINGER;MotionEvent.PointerCoords c=new MotionEvent.PointerCoords();c.x=x;c.y=y;c.pressure=1;c.size=1;return MotionEvent.obtain(down,when,action,1,new MotionEvent.PointerProperties[]{p},new MotionEvent.PointerCoords[]{c},0,0,1,1,0,0,InputDevice.SOURCE_TOUCHSCREEN,0);}
    @Override public void onStart(){PacketActivity activity=null;Bundle result=new Bundle();try{
        Intent intent=new Intent(getTargetContext(),PacketActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("runId",runId);activity=(PacketActivity)startActivitySync(intent);PacketActivity owned=activity;long deadline=SystemClock.uptimeMillis()+30000;boolean injected=false;
        while(!activity.complete&&SystemClock.uptimeMillis()<deadline){if(!injected){int[] location=new int[2];runOnMainSync(()->{if(owned.chart!=null)owned.chart.getLocationOnScreen(location);});if(owned.chart!=null&&owned.chart.getWidth()>0){long now=SystemClock.uptimeMillis();float x=location[0]+owned.chart.getWidth()*.4f,y=location[1]+owned.chart.getHeight()*.4f;MotionEvent down=touch(now,now,MotionEvent.ACTION_DOWN,x,y),up=touch(now,now+20,MotionEvent.ACTION_UP,x,y);try{if(!getUiAutomation().injectInputEvent(down,true)||!getUiAutomation().injectInputEvent(up,true))throw new AssertionError("Android system input injection failed");injected=true;}finally{down.recycle();up.recycle();}}}SystemClock.sleep(50);}
        if(!activity.complete)runOnMainSync(()->owned.fail(new AssertionError("Functional deadline")));byte[] bytes=activity.result.toString().getBytes(StandardCharsets.UTF_8);try(FileOutputStream out=getTargetContext().openFileOutput(file,0)){out.write(bytes);}result.putString("report",file);result.putString("runId",runId);finish(activity.result.optBoolean("passed")?-1:0,result);
    }catch(Throwable error){result.putString("error",error.toString());finish(0,result);}finally{if(activity!=null){PacketActivity owned=activity;runOnMainSync(owned::finish);}}}
}
