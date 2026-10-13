package dev.aster.consumer;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Private test APK only: same-UID report extraction works with debuggable=false. */
public final class PacketConsumerInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle args){start();}
    private byte[] bytes(String name)throws Exception {try(InputStream in=getTargetContext().openFileInput(name)){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1)out.write(buf,0,n);return out.toByteArray();}catch(FileNotFoundException absent){return null;}}
    private JSONObject report(String name)throws Exception {byte[] data=bytes(name);return data==null?null:new JSONObject(new String(data,StandardCharsets.UTF_8));}
    @Override public void onStart(){Bundle output=new Bundle();try{
        for(String name:new String[]{"kotlin-consumer-validation.json","kotlin-consumer-ready.json","kotlin-consumer-lifecycle.json"})getTargetContext().deleteFile(name);
        Intent intent=new Intent().setClassName(getTargetContext(),"dev.aster.consumer.ConsumerActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("sdk-self-test",true);startActivitySync(intent);
        long deadline=SystemClock.uptimeMillis()+60000;boolean home=false,resumed=false;byte[] finalBytes=null;
        while(SystemClock.uptimeMillis()<deadline){JSONObject completed=report("kotlin-consumer-validation.json");if(completed!=null){finalBytes=bytes("kotlin-consumer-validation.json");break;}
            JSONObject ready=report("kotlin-consumer-ready.json"),lifecycle=report("kotlin-consumer-lifecycle.json");
            if(!home&&ready!=null&&"await-background".equals(ready.optString("stage"))){try(InputStream shell=new android.os.ParcelFileDescriptor.AutoCloseInputStream(getUiAutomation().executeShellCommand("input keyevent KEYCODE_HOME"))){byte[] drain=new byte[1024];while(shell.read(drain)!=-1){}}home=true;}
            if(home&&!resumed&&lifecycle!=null&&lifecycle.getJSONArray("events").toString().contains("stop:1")){Intent back=new Intent(intent).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT|Intent.FLAG_ACTIVITY_SINGLE_TOP);getTargetContext().startActivity(back);resumed=true;}
            SystemClock.sleep(50);
        }
        if(finalBytes==null)throw new AssertionError("Nondebuggable consumer lifecycle/report deadline");output.putString("packetReportBase64",Base64.encodeToString(finalBytes,Base64.NO_WRAP));output.putBoolean("actualHomeResume",home&&resumed);finish(-1,output);
    }catch(Throwable error){output.putString("error",error.toString());finish(0,output);}}
}
