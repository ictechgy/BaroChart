package dev.aster.charts;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import org.json.*;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.util.*;
import java.util.function.Consumer;

/** Retained terminal handles and real Activity recreation; not a memory benchmark. */
final class RetentionVerification {
    private static RetentionVerification active;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final List<Record> records=new ArrayList<>();
    private final List<AsterEngine.AsyncJob> retainedJobs=new ArrayList<>();
    private final JSONArray checks=new JSONArray(),failures=new JSONArray();
    private Context application;
    private AsterEngine source;
    private WeakReference<Activity> originalActivity;
    private WeakReference<Object> errorCallback,errorCapture,errorThrowable;
    private int step=0,batchRemaining=0,gcAttempts=0,attachments=0;
    private boolean recreated=false,originalDestroyed=false,finished=false;
    private JSONObject handleLedger;

    static void attach(Activity activity){
        if(active==null){active=new RetentionVerification();active.application=activity.getApplicationContext();active.originalActivity=new WeakReference<>(activity);active.attachments=1;active.next();}
        else {active.attachments++;active.recreated=true;active.handler.postDelayed(active::collect,200);}
    }
    static void destroyed(Activity activity){if(active!=null&&active.originalActivity.get()==activity)active.originalDestroyed=true;}
    private void check(boolean value,String reason){(value?checks:failures).put(reason);}
    private static Object field(Object value,String name)throws Exception {Field field=value.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(value);}
    private static final class Record {
        final String name,expected;
        final Map<String,WeakReference<Object>> probes=new LinkedHashMap<>();
        AsterEngine.AsyncJob job;
        int terminals=0,progressAfterTerminal=0;
        boolean cancellationRequested=false;
        JSONObject result,terminalFields;
        Record(String name,String expected){this.name=name;this.expected=expected;}
        void probe(String name,Object value){if(value!=null)probes.put(name,new WeakReference<>(value));}
    }
    private static final class CapturedListener implements AsterEngine.AsyncListener {
        final RetentionVerification verification;
        final Record record;
        final Object capturedOwner;
        final boolean cancelDuringCopy,throwOnComplete;
        CapturedListener(RetentionVerification verification,Record record,Object capturedOwner,boolean cancelDuringCopy,boolean throwOnComplete){this.verification=verification;this.record=record;this.capturedOwner=capturedOwner;this.cancelDuringCopy=cancelDuringCopy;this.throwOnComplete=throwOnComplete;}
        @Override public void onProgress(AsterEngine.AsyncProgress progress){
            verification.check(Looper.myLooper()==Looper.getMainLooper(),record.name+": progress on owner");
            if(record.terminals!=0)record.progressAfterTerminal++;
            if(cancelDuringCopy&&progress.phase.equals("copy-input")&&!record.cancellationRequested){record.cancellationRequested=true;new Thread(record.job::cancel,"Aster retention cancellation").start();}
        }
        @Override public void onComplete(AsterEngine.AsyncResult result){
            verification.completed(record,result);
            if(throwOnComplete)throw new IllegalStateException("Expected retention fixture callback failure");
        }
    }
    private static final class CapturedError implements Consumer<Throwable> {
        final Object capture;
        CapturedError(Object capture){this.capture=capture;}
        @Override public void accept(Throwable error){}
    }
    private static final class CapturedException extends RuntimeException {
        final Object capture;
        CapturedException(Object capture){super("Expected retained observer error fixture");this.capture=capture;}
    }
    private Record begin(String name,String expected,boolean columns,boolean invalid,boolean cancelDuring,boolean callbackThrows,boolean activityCapture,AsterEngine.AsyncOptions options)throws Exception {
        Record record=new Record(name,expected);records.add(record);
        Object capture=activityCapture?originalActivity.get():new byte[65536];
        CapturedListener listener=new CapturedListener(this,record,capture,cancelDuring,callbackThrows);
        record.probe("listener",listener);record.probe("capturedOwner",capture);
        if(columns){
            int count=cancelDuring?65536:512;double[][] raw=PrepareVerification.fixture(count);if(invalid)raw[2][256]=-1;
            AsterColumns owned=AsterColumns.copyOf(raw[0],raw[1],raw[2],raw[3],raw[4],raw[5]);record.probe("inputColumns",owned);
            record.job=source.prepareColumnsAsync(owned,128,options,listener);
        }else {
            JSONObject event=(JSONObject)source.invoke("nativeBenchmarkEvent",256);
            // Accepted event metadata makes the retained serialized request visible.
            char[] padding=new char[32768];Arrays.fill(padding,'r');event.put("retentionFixture",new String(padding));
            if(invalid)event.getJSONObject("bar").put("high",-1);
            record.job=source.applyDataEventAsync(event,options,listener);
        }
        retainedJobs.add(record.job);
        for(String nameField:new String[]{"eventJSON","descriptor","worker","preceding"})record.probe(nameField,field(record.job,nameField));
        return record;
    }
    private void next(){if(finished)return;try {
        if(source==null)source=new AsterEngine(application,512);
        batchRemaining=1;
        AsterEngine.AsyncOptions normal=new AsterEngine.AsyncOptions(30000,64);
        switch(step++){
            case 0:begin("correction-success","success",false,false,false,false,true,normal);break;
            case 1:begin("columns-success","success",true,false,false,false,false,normal);break;
            case 2:begin("begin-failure","failed",false,true,false,false,false,normal);break;
            case 3:begin("worker-failure","failed",true,true,false,false,false,normal);break;
            case 4:begin("cancel-before-capture","cancelled",false,false,false,false,false,normal).job.cancel();break;
            case 5:begin("cancel-during-copy","cancelled",true,false,true,false,false,normal);break;
            case 6:begin("timeout","timedOut",true,false,false,false,false,new AsterEngine.AsyncOptions(1,1));break;
            case 7:batchRemaining=2;begin("superseded","superseded",false,false,false,false,false,normal);begin("replacement-success","success",false,false,false,false,false,normal);break;
            case 8:begin("throwing-completion","success",false,false,false,true,false,normal);break;
            case 9:
                begin("close-active","closed",true,false,false,false,false,normal);
                Object capture=new byte[65536];CapturedError callback=new CapturedError(capture);CapturedException error=new CapturedException(capture);
                errorCallback=new WeakReference<>(callback);errorCapture=new WeakReference<>(capture);errorThrowable=new WeakReference<>(error);
                source.onObserverError=callback;source.addChangeListener(()->{throw error;});source.setText("observer error before close");source.close();source.close();
                break;
            default:finishJobs();
        }
    }catch(Throwable error){fail(error);}}
    private void completed(Record record,AsterEngine.AsyncResult result){if(finished)return;try {
        record.terminals++;
        check(Looper.myLooper()==Looper.getMainLooper(),record.name+": completion on owner");
        check(result.status.equals(record.expected),record.name+": expected "+record.expected+", received "+result.status);
        check(result.metrics.has("elapsedMs")&&result.metrics.has("kind")&&result.metrics.getDouble("elapsedMs")>=0,record.name+": complete metrics visible to callback");
        if(record.name.equals("columns-success"))check(result.metrics.getLong("immutableInputBytes")==512L*6*8&&result.metrics.getLong("copiedBytes")==512L*6*8,"columns-success: input metrics survive cleanup");
        record.result=result.toJSON();
        if(--batchRemaining==0)handler.postDelayed(()->{inspectTerminalFields();next();},50);
    }catch(Throwable error){fail(error);}}
    private void inspectTerminalFields(){try {
        for(Record record:records){if(record.terminals==0||record.terminalFields!=null)continue;JSONObject fields=new JSONObject();
            for(String name:new String[]{"listener","eventJSON","inputColumns","descriptor","worker","preceding","failure"}){boolean empty=field(record.job,name)==null;fields.put(name,empty);check(empty,record.name+": terminal "+name+" cleared");}
            record.terminalFields=fields;
        }
    }catch(Throwable error){fail(error);}}
    private void finishJobs()throws Exception {
        inspectTerminalFields();
        check(source.onObserverError==null,"close clears observer error callback");
        check(((List<?>)field(source,"observerErrors")).isEmpty(),"close clears recorded observer errors");
        check(((Set<?>)field(source,"observers")).isEmpty(),"close clears observers");
        check(((Number)field(source,"handle")).longValue()==0,"retained closed owner has no native handle");
        // A live temporary inspector measures process handles independently of GC.
        AsterEngine inspector=new AsterEngine(application,0);try{handleLedger=inspector.runtimeMetrics();check(handleLedger.getLong("processLiveNativeHandles")==1,"all source and isolated native handles freed; temporary inspector alone remains");}finally{inspector.close();}
        check(retainedJobs.size()==11,"all eleven terminal job handles remain strongly retained");
        Activity activity=originalActivity.get();if(activity==null)throw new AssertionError("Original activity unavailable before recreation");activity.recreate();
        handler.postDelayed(()->{if(!recreated&&!finished)fail(new AssertionError("Activity recreation did not attach replacement"));},10000);
    }
    private boolean allCollected(){for(Record record:records)for(WeakReference<Object> probe:record.probes.values())if(probe.get()!=null)return false;return errorCallback.get()==null&&errorCapture.get()==null&&errorThrowable.get()==null&&originalActivity.get()==null;}
    private void collect(){if(finished)return;System.gc();System.runFinalization();gcAttempts++;
        if(!allCollected()&&gcAttempts<30){handler.postDelayed(this::collect,100);return;}
        try {
            check(recreated&&attachments==2&&originalDestroyed,"real Activity recreation replaced and destroyed original");
            check(originalActivity.get()==null,"original Activity callback capture collected with retained terminal handles");
            check(errorCallback.get()==null,"closed owner error callback collected");check(errorCapture.get()==null,"closed owner error capture collected");check(errorThrowable.get()==null,"closed owner recorded Throwable collected");
            JSONArray rows=new JSONArray();
            for(Record record:records){JSONObject weak=new JSONObject();for(Map.Entry<String,WeakReference<Object>> entry:record.probes.entrySet()){boolean cleared=entry.getValue().get()==null;weak.put(entry.getKey(),cleared);check(cleared,record.name+": weak "+entry.getKey()+" collected");}
                check(record.terminals==1,record.name+": exactly one terminal callback");check(record.progressAfterTerminal==0,record.name+": no progress after terminal");
                if(record.name.equals("cancel-during-copy"))check(record.cancellationRequested,"background cancellation requested after copy progress");
                rows.put(new JSONObject().put("name",record.name).put("expectedStatus",record.expected).put("terminalCount",record.terminals).put("progressAfterTerminal",record.progressAfterTerminal).put("terminalFieldsNull",record.terminalFields).put("weakCleared",weak).put("result",record.result));
            }
            write(new JSONObject().put("passed",checks.length()).put("failed",failures.length()!=0).put("checks",checks).put("failures",failures).put("rows",rows).put("retainedTerminalHandles",retainedJobs.size()).put("gcAttempts",gcAttempts).put("activityAttachments",attachments).put("originalActivityDestroyed",originalDestroyed).put("originalActivityCollected",originalActivity.get()==null).put("nativeHandles",handleLedger).put("api",Build.VERSION.SDK_INT).put("physicalDevice",false).put("scope","Actual Android retained terminal handles, eleven terminal deliveries, weak references plus private-field reachability, real Activity recreation; forced GC is an observation, not a universal collection guarantee. Nonstatic jobs intentionally retain their closed outer engine and Handler; AutoCloseable remains required."));
        }catch(Throwable error){fail(error);}
    }
    private void fail(Throwable error){if(finished)return;try{write(new JSONObject().put("failed",true).put("passed",0).put("error",error.toString()).put("checks",checks).put("failures",failures));}catch(JSONException jsonError){throw new IllegalStateException(jsonError);}}
    private void write(JSONObject report){finished=true;handler.removeCallbacksAndMessages(null);try(FileOutputStream output=application.openFileOutput("android-retention-validation.json",Context.MODE_PRIVATE)){output.write(report.toString(2).getBytes("UTF-8"));}catch(Exception error){throw new IllegalStateException(error);}}
}
