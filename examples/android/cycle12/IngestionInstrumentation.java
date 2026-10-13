package dev.aster.charts;
import android.app.Instrumentation;import android.os.Bundle;import org.json.*;import java.io.*;

/** Functional SDK regression entry, separate from external ADB system input run. */
public final class IngestionInstrumentation extends Instrumentation {
    private String mode;
    @Override public void onCreate(Bundle args){super.onCreate(args);mode=args==null?"sdk":args.getString("mode","sdk");start();}
    @Override public void onStart(){runOnMainSync(()->{try{if(mode.equals("timezone"))done(new TimezoneVerification().run(getTargetContext()));else new IngestionVerification().run(getTargetContext(),this::done);}catch(Exception error){throw new IllegalStateException(error);}});}
    private void done(JSONObject report){try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getFilesDir(),mode+"-functional.json"))){out.write(report.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}catch(IOException error){throw new IllegalStateException(error);}Bundle result=new Bundle();result.putString("report",report.toString());finish(report.optBoolean("passed")?0:1,result);}
}
