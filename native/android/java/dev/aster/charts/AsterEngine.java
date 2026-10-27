package dev.aster.charts;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.Debug;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.Locale;

/** Native QuickJS/JNI host, owned by one thread. No WebView or browser. */
public final class AsterEngine implements AutoCloseable {
    static {System.loadLibrary("aster");}
    private long handle;
    private final String sourceBundle;
    private final Thread owner=Thread.currentThread();
    private final java.util.Set<Runnable> observers=new java.util.LinkedHashSet<>();
    private final java.util.Set<Runnable> closeObservers=new java.util.LinkedHashSet<>();
    private boolean closing=false;
    private WorkspaceJob activeWorkspace;
    private ParamsJob activeParams;
    private long revision=0;
    private int pendingNotifications=0;private boolean notifying=false;
    private final java.util.List<Throwable> observerErrors=new java.util.ArrayList<>();
    public java.util.function.Consumer<Throwable> onObserverError;
    private static native long create(String source);
    private static native String call(long handle,String name,String arguments);
    private static native Object[] packet(long handle,String mode,String token,double width,double height,boolean force);
    private static native void free(long handle);
    private static native byte[] readBuffer(long handle,long ticket,int slot,int offset,int count);
    private static native void writeBuffer(long handle,int slot,int offset,byte[] bytes);
    private static native long memoryUsed(long handle);
    private static native long memoryPeak(long handle);
    private static native long[] memoryStats(long handle);
    private static native byte[] indicatorSlice(long handle,String id,String output,int offset,int count);
    private AsyncJob activeJob;
    public AsterEngine(Context context,int count) throws IOException,JSONException {this(context,count,null);}
    public AsterEngine(Context context,int count,JSONObject options) throws IOException,JSONException {
        try(InputStream in=context.getAssets().open("aster-core.js")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int size;while((size=in.read(buffer))!=-1)out.write(buffer,0,size);sourceBundle=new String(out.toByteArray(),StandardCharsets.UTF_8);}
        handle=create(sourceBundle);
        try {invoke("nativeInit",count,options==null?JSONObject.NULL:options);}catch(JSONException|RuntimeException|Error error){long released=handle;handle=0;try{free(released);}catch(Throwable cleanup){if(cleanup!=error)error.addSuppressed(cleanup);}throw error;}
    }
    private void check(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Use the engine on its owning thread before close");if(activeWorkspace!=null&&activeWorkspace.job.pendingOwnerCleanup())activeWorkspace.job.resumeOwnerCleanup();if(activeParams!=null&&activeParams.job.pendingOwnerCleanup())activeParams.job.resumeOwnerCleanup();if(handle==0)throw new IllegalStateException("Use the engine on its owning thread before close");if(closing)throw new IllegalStateException("Engine closing");}
    private void checkCleanup(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Use the engine on its owning thread before close");if(!closing){if(activeWorkspace!=null&&activeWorkspace.job.pendingOwnerCleanup())activeWorkspace.job.resumeOwnerCleanup();if(activeParams!=null&&activeParams.job.pendingOwnerCleanup())activeParams.job.resumeOwnerCleanup();}if(handle==0)throw new IllegalStateException("Use the engine on its owning thread before close");}
    public Object invoke(String name,Object... args) throws JSONException {check();if(name==null||name.length()==0||name.length()>128||args.length>16)throw new IllegalArgumentException("Native function name/argument limit");return new JSONArray("["+call(handle,name,new JSONArray(args).toString())+"]").get(0);}
    static final class SceneTiming {
        final long jniNanos,envelopeParseNanos,bodyParseNanos;final int jsonChars;
        final String transport;final long metadataParseNanos,numericValidationNanos,numericBytes;final int commandCount,stringCount;
        SceneTiming(long jni,long envelope,long body,int chars){this(jni,envelope,body,chars,"json",0,0,0,0,0);}
        SceneTiming(long jni,long envelope,long body,int chars,String transport,long metadata,long validation,long bytes,int commands,int strings){jniNanos=jni;envelopeParseNanos=envelope;bodyParseNanos=body;jsonChars=chars;this.transport=transport;metadataParseNanos=metadata;numericValidationNanos=validation;numericBytes=bytes;commandCount=commands;stringCount=strings;}
    }
    /** Private, owned display packet. Neither model data nor borrowed QuickJS storage. */
    static final class ScenePacket {
        static final int MAX_NUMBERS=8388608,MAX_METADATA_BYTES=1048576,MAX_COMMANDS=65536,HEADER=15;
        final double[] numbers;final String[] strings;final int[] layerCounts,layerStarts,commandStarts;
        final int commandCount;final String mode,background;final double width,height;
        final JSONObject stats;final long metadataParseNanos,numericValidationNanos;
        ScenePacket(String metadata,double[] numbers)throws JSONException {
            if(metadata==null||numbers==null||metadata.length()>MAX_METADATA_BYTES||utf8Length(metadata)>MAX_METADATA_BYTES||numbers.length>MAX_NUMBERS)throw new IllegalArgumentException("Native packet byte budget");
            long start=System.nanoTime();JSONTokener tokener=new JSONTokener(metadata);Object parsed=tokener.nextValue();if(!(parsed instanceof JSONObject)||tokener.nextClean()!=0)throw new JSONException("Native packet JSON framing");JSONObject meta=(JSONObject)parsed;
            if(!"aster.native.commands".equals(meta.getString("schema"))||integer(meta.get("version"),1,1,"version")!=1)throw new JSONException("Native packet schema/version");
            mode=meta.getString("mode");if(!mode.equals("scene")&&!mode.equals("frame"))throw new JSONException("Native packet mode");
            width=finite(meta.get("width"),"width");height=finite(meta.get("height"),"height");if(width<=0||height<=0||width>16384||height>16384||width*height>33554432)throw new JSONException("Native packet extent");background=meta.getString("background");
            JSONArray table=meta.getJSONArray("strings");if(table.length()>MAX_COMMANDS)throw new JSONException("Native packet dictionary budget");strings=new String[table.length()];for(int i=0;i<strings.length;i++){Object text=table.get(i);if(!(text instanceof String))throw new JSONException("Native packet dictionary strings");strings[i]=(String)text;}
            JSONArray layers=meta.getJSONArray("layers");int count=mode.equals("scene")?1:3;if(layers.length()!=count)throw new JSONException("Native packet layer count");layerCounts=new int[count];layerStarts=new int[count];int commands=0;
            for(int i=0;i<count;i++){layerStarts[i]=commands;if(layers.isNull(i)){if(mode.equals("scene")||i==2)throw new JSONException("Native packet required layer omitted");layerCounts[i]=-1;}else{layerCounts[i]=integer(layers.getJSONObject(i).get("commands"),0,MAX_COMMANDS,"layer commands");if(layerCounts[i]>MAX_COMMANDS-commands)throw new JSONException("Native packet command budget");commands+=layerCounts[i];}}
            stats=meta.getJSONObject("stats");java.util.Iterator<String> keys=stats.keys();while(keys.hasNext()){Object value=stats.get(keys.next());if(value instanceof Number)finite(value,"stats");else if(!(value instanceof String)&&value!=JSONObject.NULL)throw new JSONException("Native packet scalar stats");}
            long afterMetadata=System.nanoTime();metadataParseNanos=afterMetadata-start;this.numbers=numbers;commandCount=commands;commandStarts=new int[commands];int cursor=0;
            for(int i=0;i<commands;i++){
                if(numbers.length-cursor<HEADER)throw new JSONException("Native packet truncated header");commandStarts[i]=cursor;
                int op=integer(numbers[cursor],1,6,"operation"),length=integer(numbers[cursor+1],HEADER,MAX_NUMBERS,"record length"),dash=integer(numbers[cursor+9],0,MAX_NUMBERS,"dash count"),args=integer(numbers[cursor+14],0,MAX_NUMBERS,"argument count");
                if((long)HEADER+dash+args!=length||length>numbers.length-cursor)throw new JSONException("Native packet record bounds");
                index(numbers[cursor+2],false,"color");if(numbers[cursor+3]<0)throw new JSONException("Native packet negative width");integer(numbers[cursor+4],0,1,"clip flag");
                index(numbers[cursor+10],true,"fill");int text=index(numbers[cursor+12],true,"text"),font=index(numbers[cursor+13],true,"font");
                if((op==1||op==2)&&args%4!=0||op==3&&args%2!=0||(op==4||op==5)&&args!=4||op==6&&args!=2)throw new JSONException("Native packet operation arity");
                if(op==6?(text<0||font<0):(text!=-1||font!=-1))throw new JSONException("Native packet text/font indices");
                if(dash!=0&&(dash<2||dash%2!=0))throw new JSONException("Native packet dash arity");
                for(int j=0;j<length;j++)if(!Double.isFinite(numbers[cursor+j]))throw new JSONException("Native packet nonfinite number");
                for(int j=0;j<dash;j++)if(numbers[cursor+HEADER+j]<=0)throw new JSONException("Native packet positive dash intervals");cursor+=length;
            }
            if(cursor!=numbers.length)throw new JSONException("Native packet trailing numeric data");numericValidationNanos=System.nanoTime()-afterMetadata;
        }
        private int index(double value,boolean optional,String label)throws JSONException {return integer(value,optional?-1:0,strings.length-1,label);}
        private static int integer(Object value,int min,int max,String label)throws JSONException {if(!(value instanceof Number))throw new JSONException("Native packet numeric "+label);return integer(((Number)value).doubleValue(),min,max,label);}
        private static int integer(double value,int min,int max,String label)throws JSONException {if(!Double.isFinite(value)||value!=Math.rint(value)||value<min||value>max)throw new JSONException("Native packet integer "+label);return (int)value;}
        private static double finite(Object value,String label)throws JSONException {if(!(value instanceof Number)||!Double.isFinite(((Number)value).doubleValue()))throw new JSONException("Native packet finite "+label);return ((Number)value).doubleValue();}
        private static long utf8Length(String text){long bytes=0;for(int i=0;i<text.length();i++){char c=text.charAt(i);if(c<128)bytes++;else if(c<2048)bytes+=2;else if(Character.isHighSurrogate(c)&&i+1<text.length()&&Character.isLowSurrogate(text.charAt(i+1))){bytes+=4;i++;}else bytes+=3;if(bytes>MAX_METADATA_BYTES)return bytes;}return bytes;}
    }
    private SceneTiming sceneTiming=new SceneTiming(0,0,0,0);
    SceneTiming sceneTiming(){check();return sceneTiming;}
    private JSONObject sceneJSON(String name,Object... args) throws JSONException {
        check();String arguments=new JSONArray(args).toString();long start=System.nanoTime();
        String returned=call(handle,name,arguments);long afterJNI=System.nanoTime();
        String body=(String)new JSONArray("["+returned+"]").get(0);long afterEnvelope=System.nanoTime();
        JSONObject scene=new JSONObject(body);long afterBody=System.nanoTime();
        sceneTiming=new SceneTiming(afterJNI-start,afterEnvelope-afterJNI,afterBody-afterEnvelope,body.length());return scene;
    }
    public JSONObject scene(double width,double height) throws JSONException {return sceneJSON("nativeSceneJSON",width,height);}
    JSONObject renderFrame(String token,double width,double height,boolean force) throws JSONException {return sceneJSON("nativeRenderFrameJSON",token,width,height,force);}
    ScenePacket scenePacket(String mode,String token,double width,double height,boolean force)throws JSONException {
        check();long start=System.nanoTime();Object[] transfer=packet(handle,mode,token,width,height,force);long afterJNI=System.nanoTime();
        if(transfer==null||transfer.length!=2||!(transfer[0] instanceof String)||!(transfer[1] instanceof double[]))throw new JSONException("Native packet transfer shape");
        ScenePacket result=new ScenePacket((String)transfer[0],(double[])transfer[1]);long afterJava=System.nanoTime();
        sceneTiming=new SceneTiming(afterJNI-start,0,afterJava-afterJNI,((String)transfer[0]).length(),"f64",result.metadataParseNanos,result.numericValidationNanos,result.numbers.length*8L,result.commandCount,result.strings.length);return result;
    }
    void releaseFrameCache(String token) throws JSONException {checkCleanup();invokeHandle(handle,"nativeReleaseFrameCache",token);}
    void addCloseListener(Runnable observer){check();closeObservers.add(observer);}
    void removeCloseListener(Runnable observer){if(Thread.currentThread()!=owner)throw new IllegalStateException("Remove close listener on owning thread");closeObservers.remove(observer);}
    /** Stable errors from the common model-owned ingestion session. */
    public static final class IngestionException extends IllegalStateException {
        private static final long serialVersionUID=1L;
        public final String code;
        public IngestionException(String code,String message){super(message);this.code=code;}
    }
    private static boolean ingestionCommand(String operation){if(operation==null)return false;switch(operation){
        case "configureDataIngestion":case "enqueueDataEvents":case "drainDataEvents":case "pauseDataIngestion":case "resumeDataIngestion":case "cancelDataEvents":case "dataIngestionStats":case "saveDataIngestion":case "loadDataIngestion":return true;
        default:return false;
    }}
    private static Object ingestionResult(JSONObject envelope) throws JSONException {
        if(envelope.has("error")){JSONObject error=envelope.getJSONObject("error");throw new IngestionException(error.getString("code"),error.getString("message"));}
        return envelope.get("result");
    }
    // This nested decoder can be tested without initializing the JNI-backed Engine.
    static final class CompactionReceipt {
        private CompactionReceipt() {}
        static boolean changed(Object removed) throws JSONException {
            if(!(removed instanceof Number))throw new JSONException("Compaction removed must be numeric");
            double value=((Number)removed).doubleValue();
            if(!Double.isFinite(value)||value!=Math.rint(value)||value<0||value>4194304)throw new JSONException("Compaction removed integer range");
            return value>0;
        }
    }
    // Separate from compaction: a group contains at most 128 changed drawings.
    static final class DrawingTranslationReceipt {
        private DrawingTranslationReceipt() {}
        static boolean changed(Object changed) throws JSONException {
            if(!(changed instanceof Number))throw new JSONException("Drawing translation changed must be numeric");
            double value=((Number)changed).doubleValue();
            if(!Double.isFinite(value)||value!=Math.rint(value)||value<0||value>128)throw new JSONException("Drawing translation changed integer range");
            return value>0;
        }
    }
    // Layout commands return either a strict Boolean or a bounded changed count.
    // Keep this decoder package-private so it can be checked without initializing
    // the JNI-backed Engine or adding another public API surface.
    static final class LayoutReceipt {
        private LayoutReceipt() {}
        static boolean panelOrder(Object result) throws JSONException {
            if(!(result instanceof Boolean))throw new JSONException("Panel order receipt must be boolean");
            return ((Boolean)result).booleanValue();
        }
        static boolean indicatorPlacement(Object result) throws JSONException {
            if(!(result instanceof Number))throw new JSONException("Indicator placement changed must be numeric");
            double value=((Number)result).doubleValue();
            if(!Double.isFinite(value)||value!=Math.rint(value)||value<0||value>256)throw new JSONException("Indicator placement changed integer range");
            return value>0;
        }
    }
    public Object command(String operation,Object... args) throws JSONException {
        check();Object result;
        // Cover the deferred begin gap as well as core's active ingestion lease.
        if("compactData".equals(operation)&&(activeJob!=null&&!activeJob.committed||activeWorkspace!=null||activeParams!=null))throw new IngestionException("BUSY","Compaction has an active asynchronous calculation");
        if(ingestionCommand(operation)){
            if((activeJob!=null&&!activeJob.committed||activeWorkspace!=null&&!activeWorkspace.job.committed()||activeParams!=null&&!activeParams.job.committed())&&!operation.equals("dataIngestionStats")&&!operation.equals("saveDataIngestion"))throw new IngestionException("BUSY","Data ingestion has an active asynchronous calculation");
            JSONObject envelope=(JSONObject)invoke("nativeDataIngestionCommand",operation,new JSONArray(args));
            result=ingestionResult(envelope);
        }else result=invoke("nativeCommand",operation,new JSONArray(args));
        if("compactData".equals(operation)){
            if(!(result instanceof JSONObject))throw new JSONException("Compaction receipt object required");
            if(CompactionReceipt.changed(((JSONObject)result).get("removed")))notifyChanges();
        }else if("translateDrawings".equals(operation)){
            if(!(result instanceof JSONObject))throw new JSONException("Drawing translation receipt object required");
            if(DrawingTranslationReceipt.changed(((JSONObject)result).get("changed")))notifyChanges();
        }else if("setDrawingsStyle".equals(operation)){
            if(!(result instanceof JSONObject))throw new JSONException("Drawing style receipt object required");
            if(DrawingTranslationReceipt.changed(((JSONObject)result).get("changed")))notifyChanges();
        }else if("setDrawingVisibility".equals(operation)||"setDrawingsVisibility".equals(operation)){
            if(!(result instanceof JSONObject))throw new JSONException("Drawing visibility receipt object required");
            Object value=((JSONObject)result).get("changed");boolean changed=DrawingTranslationReceipt.changed(value);
            if("setDrawingVisibility".equals(operation)&&((Number)value).doubleValue()>1)throw new JSONException("Single drawing visibility receipt range");
            if(changed)notifyChanges();
        }else if("duplicateDrawing".equals(operation)||"duplicateDrawings".equals(operation)){
            if(!(result instanceof JSONObject))throw new JSONException("Drawing duplication receipt object required");
            JSONObject receipt=(JSONObject)result;Object value=receipt.get("changed"),created=receipt.get("created");
            if(!DrawingTranslationReceipt.changed(value)||!(created instanceof JSONArray)||!(receipt.get("invalidationFailed") instanceof Boolean))throw new JSONException("Drawing duplication receipt shape");
            int count=((Number)value).intValue();if("duplicateDrawing".equals(operation)&&count!=1)throw new JSONException("Single drawing duplication receipt range");
            JSONArray rows=(JSONArray)created;if(rows.length()!=count)throw new JSONException("Drawing duplication receipt count");
            java.util.Set<String> sources=new java.util.HashSet<>(),ids=new java.util.HashSet<>();
            for(int i=0;i<count;i++){Object item=rows.get(i);if(!(item instanceof JSONObject))throw new JSONException("Drawing duplication row object");JSONObject row=(JSONObject)item;Object source=row.get("sourceId"),id=row.get("id");
                if(row.length()!=2||!(source instanceof String)||!(id instanceof String))throw new JSONException("Drawing duplication row fields");String a=(String)source,b=(String)id;
                if(a.isEmpty()||a.length()>128||b.isEmpty()||b.length()>128||a.equals(b)||!sources.add(a)||!ids.add(b))throw new JSONException("Drawing duplication row identifiers");}
            notifyChanges();
        }else if("setPanelOrder".equals(operation)){
            if(LayoutReceipt.panelOrder(result))notifyChanges();
        }else if("setIndicatorPlacement".equals(operation)){
            if(!(result instanceof JSONObject))throw new JSONException("Indicator placement receipt object required");
            if(LayoutReceipt.indicatorPlacement(((JSONObject)result).get("changed")))notifyChanges();
        }else if(!operation.equals("inspect")&&!operation.equals("indicatorValues")&&!operation.equals("saveDrawings")&&!operation.equals("positionMetrics")&&!operation.equals("crosshairValues")&&!operation.equals("crosshairSnapshot")&&!operation.equals("dataAt")&&!operation.equals("saveStudies")&&!operation.equals("indicatorValueAt")&&!operation.equals("dataIngestionStats")&&!operation.equals("saveDataIngestion"))notifyChanges();return result;
    }
    private void notifyChanges(){revision++;pendingNotifications++;if(notifying)return;notifying=true;observerErrors.clear();try{while(pendingNotifications>0){pendingNotifications--;for(Runnable observer:new java.util.ArrayList<>(observers)){try{observer.run();}catch(RuntimeException error){if(observerErrors.size()<32)observerErrors.add(error);try{if(onObserverError!=null)onObserverError.accept(error);}catch(RuntimeException reporting){if(observerErrors.size()<32)observerErrors.add(reporting);}}}}}finally{notifying=false;}}
    public java.util.List<Throwable> observerErrors(){check();return new java.util.ArrayList<>(observerErrors);}
    public long revision(){check();return revision;}
    public JSONObject runtimeMetrics() throws JSONException {check();long[] stats=memoryStats(handle);return new JSONObject().put("requestedLiveBytes",stats[0]).put("requestedPeakBytes",stats[1]).put("processLiveNativeHandles",stats[2]).put("processNativeHandlesCreated",stats[3]).put("processNativeHandlesFreed",stats[4]).put("scope","QuickJS requested bytes including aligned allocator headers; live handle counts include all engines and current isolated workers in this process");}
    byte[] indicatorBytes(String id,String output,int offset,int count){check();if(id==null||output==null||id.length()>128||output.length()>128||offset<0||count<1||count>262144)throw new IllegalArgumentException("Indicator byte slice limits");return indicatorSlice(handle,id,output,offset,count);}
    public void addChangeListener(Runnable observer){check();observers.add(observer);}
    public void removeChangeListener(Runnable observer){if(Thread.currentThread()!=owner)throw new IllegalStateException("Remove listener on owning thread");observers.remove(observer);}
    public void setData(JSONArray bars) throws JSONException {command("setData",bars);}
    public void setColumns(JSONObject columns) throws JSONException {command("setColumns",columns);}
    public void applyDataEvent(JSONObject event) throws JSONException {command("applyDataEvent",event);}
    /** Atomic, explicitly ordered burst; legacy scalar errors remain unchanged. */
    public JSONObject applyDataEvents(JSONArray events) throws JSONException {return (JSONObject)command("applyDataEvents",events);}
    static final class DataBatchReceipt {
        private DataBatchReceipt() {}
        static double integer(Object value,double max) throws JSONException {
            if(!(value instanceof Number))throw new JSONException("Data batch numeric receipt");
            double n=((Number)value).doubleValue();
            if(!Double.isFinite(n)||n!=Math.rint(n)||n<0||n>max)throw new JSONException("Data batch integer receipt");return n;
        }
        static boolean unchanged(Object schema,Object... v) throws JSONException {
            if(!"aster.native-data-batch".equals(schema)||v.length!=13||integer(v[0],1)!=1||!(v[3] instanceof Boolean)||!(v[4] instanceof Boolean)||!v[3].equals(v[4]))throw new JSONException("Data batch envelope");
            double before=integer(v[1],9007199254740991d),after=integer(v[2],9007199254740991d),events=integer(v[5],4096),appended=integer(v[6],4096),from=integer(v[7],4194304),to=integer(v[8],4194304),version=integer(v[9],9007199254740991d),length=integer(v[10],4194304),capacity=integer(v[11],4194304),bytes=integer(v[12],402653184);
            int cap=(int)capacity;boolean same=((Boolean)v[3]).booleanValue();
            if(events<1||appended>events||capacity<1||capacity<length||(cap&(cap-1))!=0||bytes!=96*capacity||from>=to||to>length||after<before||version<before||version>after||(same?(appended!=0||version!=before||after!=before):(version!=before+1)))throw new JSONException("Data batch inconsistent receipt");return same;
        }
    }
    /** Opt-in exact final-value deduplication. False preserves the legacy path.
     * A failed true-path response can follow commit: do not automatically retry.
     */
    public JSONObject applyDataEvents(JSONArray events,boolean skipUnchanged) throws JSONException {
        if(!skipUnchanged)return applyDataEvents(events);
        check();if(closing)throw new IllegalStateException("Engine closing");
        final long source=handle,beforeRevision=revision;final JSONObject receipt;final boolean unchanged;
        try {
            Object raw=invoke("nativeApplyUnchangedDataEvents",events);
            if(!(raw instanceof JSONObject))throw new JSONException("Data batch envelope object");
            JSONObject envelope=(JSONObject)raw;Object payload=envelope.get("receipt");
            if(!(payload instanceof JSONObject))throw new JSONException("Data batch receipt object");receipt=(JSONObject)payload;
            unchanged=DataBatchReceipt.unchanged(envelope.get("schema"),envelope.get("version"),envelope.get("beforeVersion"),envelope.get("afterVersion"),envelope.get("unchanged"),receipt.get("unchanged"),receipt.get("events"),receipt.get("appended"),receipt.get("from"),receipt.get("to"),receipt.get("version"),receipt.get("length"),receipt.get("capacity"),receipt.get("bytes"));
            if(closing||handle!=source)throw new IllegalStateException("Data batch owner changed");
        } catch(JSONException|RuntimeException|Error error) {
            if(!closing&&handle==source&&source!=0)try{notifyChanges();}catch(Throwable notification){if(notification!=error)error.addSuppressed(notification);}throw error;
        }
        if(!unchanged||revision!=beforeRevision)notifyChanges();return receipt;
    }
    /** Synchronous retained-window maintenance. Requires explicit studyHistory:"restart".
     * Pause/drain upstream first; large copies can block the owner thread.
     * A zero-removal receipt changes neither host revision nor notifications.
     * Transport/receipt failure after native execution does not prove rollback.
     */
    public JSONObject compactData(JSONObject options) throws JSONException {return (JSONObject)command("compactData",options);}
    /** Raw-coordinate group edit with one core undo. Zero changes do not notify.
     * Receipt/transport failure after execution does not imply rollback. */
    public JSONObject translateDrawings(JSONArray ids,double deltaTimeMs,double deltaPrice) throws JSONException {
        JSONObject options=new JSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice);
        return (JSONObject)command("translateDrawings",ids,options);
    }
    /** Partial portable style merge, one core undo; zero stored changes do not notify.
     * Receipt/transport failure after execution does not imply rollback. */
    public JSONObject setDrawingsStyle(JSONArray ids,JSONObject patch) throws JSONException {return (JSONObject)command("setDrawingsStyle",ids,patch);}
    /** Presentation-only visibility may change locked drawings. Active gestures reject. */
    public JSONObject setDrawingVisibility(String id,boolean visible) throws JSONException {return (JSONObject)command("setDrawingVisibility",id,visible);}
    public JSONObject setDrawingsVisibility(JSONArray ids,boolean visible) throws JSONException {return (JSONObject)command("setDrawingsVisibility",ids,visible);}
    /** Chart-local unlocked copies; explicit raw offsets and one atomic core undo. */
    public JSONObject duplicateDrawing(String id,double deltaTimeMs,double deltaPrice) throws JSONException {return (JSONObject)command("duplicateDrawing",id,new JSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice));}
    public JSONObject duplicateDrawings(JSONArray ids,double deltaTimeMs,double deltaPrice) throws JSONException {return (JSONObject)command("duplicateDrawings",ids,new JSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice));}
    /** Explicit group deletion with one core undo. Empty/missing/locked IDs reject. */
    public JSONObject deleteDrawings(JSONArray ids) throws JSONException {return (JSONObject)command("deleteDrawings",ids);}
    public JSONObject configureDataIngestion(JSONObject policy) throws JSONException {return (JSONObject)command("configureDataIngestion",policy);}
    public JSONObject enqueueDataEvents(JSONObject packet) throws JSONException {return (JSONObject)command("enqueueDataEvents",packet);}
    public JSONObject drainDataEvents() throws JSONException {return (JSONObject)command("drainDataEvents");}
    public JSONObject drainDataEvents(int maxEvents) throws JSONException {return (JSONObject)command("drainDataEvents",maxEvents);}
    public JSONObject pauseDataIngestion() throws JSONException {return (JSONObject)command("pauseDataIngestion");}
    public JSONObject resumeDataIngestion() throws JSONException {return (JSONObject)command("resumeDataIngestion");}
    public JSONObject cancelDataEvents() throws JSONException {return (JSONObject)command("cancelDataEvents");}
    public JSONObject dataIngestionStats() throws JSONException {return (JSONObject)command("dataIngestionStats");}
    public String saveDataIngestion() throws JSONException {return (String)command("saveDataIngestion");}
    public JSONObject loadDataIngestion(String text) throws JSONException {return (JSONObject)command("loadDataIngestion",text);}
    /** Layout-independent readout; null means no available selected row. */
    public JSONObject dataAt(JSONObject query) throws JSONException {return dataAt(query,new JSONObject());}
    public JSONObject dataAt(JSONObject query,JSONObject options) throws JSONException {
        Object result=command("dataAt",query,options);if(result==JSONObject.NULL)return null;
        if(!(result instanceof JSONObject))throw new JSONException("Data query object receipt");return (JSONObject)result;
    }
    /** Explicit exploration only: navigation never requests redraw or lazy values. */
    private JSONObject dataExploration(String action,Object argument) throws JSONException {
        check();if(closing)throw new IllegalStateException("Exploration engine closing");final long source=handle;
        Object result=invoke("nativeDataExploration",action,argument);
        check();if(closing||handle!=source)throw new IllegalStateException("Exploration engine changed");
        if(!(result instanceof JSONObject))throw new JSONException("Exploration object receipt");
        return (JSONObject)result;
    }
    public JSONObject setDataExploration(boolean active) throws JSONException {return dataExploration("setActive",active);}
    public JSONObject navigateDataExploration(String key) throws JSONException {return dataExploration("navigate",key);}
    public JSONObject refreshDataExploration() throws JSONException {return dataExploration("refresh",JSONObject.NULL);}
    /** May synchronously calculate every visible dirty indicator through dataAt. */
    public JSONObject readDataExploration() throws JSONException {return dataExploration("read",JSONObject.NULL);}
    public void addPanel(JSONObject options) throws JSONException {command("addPanel",options);}
    public void setPanel(String id,JSONObject patch) throws JSONException {command("setPanel",id,patch);}
    public void addSeries(JSONObject options) throws JSONException {command("addSeries",options);}
    public void setSeries(String id,JSONObject patch) throws JSONException {command("setSeries",id,patch);}
    public void setSeriesValues(String id,JSONArray values) throws JSONException {command("setSeriesValues",id,values);}
    public void removeSeries(String id) throws JSONException {command("removeSeries",id);}
    public JSONObject addIndicator(String id,String name,JSONObject params) throws JSONException {return (JSONObject)command("addIndicator",id,name,params);}
    public JSONObject setIndicatorParams(String id,JSONObject params) throws JSONException {return (JSONObject)command("setIndicatorParams",id,params);}
    public void removeIndicator(String id) throws JSONException {command("removeIndicator",id);}
    public void registerIndicatorSource(String name,String source) throws JSONException {invoke("nativeRegisterIndicatorSource",name,source);notifyChanges();}
    /** Registers application-linked exports; no source evaluation or URL loading. */
    public JSONArray registerIndicatorModule(String id,int version) throws JSONException {return (JSONArray)command("registerIndicatorModule",id,version);}
    /** Definitions and related series only; data/layout/drawing state are host-owned. */
    public String saveStudies() throws JSONException {return (String)command("saveStudies");}
    /** Bounded portable metadata only. Synchronous owner-thread read; no redraw/revision notification. */
    public String saveWorkspace(JSONObject datasetBinding) throws JSONException {
        Object result=invoke("nativeSaveWorkspace",datasetBinding);
        if(!(result instanceof String))throw new JSONException("Workspace document string required");
        return (String)result;
    }
    /** Validated-only metadata/source assertion. Does not calculate, restore, reserve a job or swap context. */
    public JSONObject preflightWorkspace(String document,JSONObject datasetBinding) throws JSONException {
        Object result=invoke("nativePreflightWorkspace",document,datasetBinding);
        if(!(result instanceof JSONObject))throw new JSONException("Workspace preflight receipt required");
        return (JSONObject)result;
    }

    /** Atomic additive merge; required panels/axes must exist, duplicate IDs reject. */
    public JSONObject loadStudies(String text) throws JSONException {return (JSONObject)command("loadStudies",text);}
    public JSONObject indicatorValueAt(String id,String output,int index) throws JSONException {return indicatorValueAt(id,output,index,null);}
    /** mode raw/plot; asOfIndex hides unavailable value/sourceIndex/sourceTime. */
    public JSONObject indicatorValueAt(String id,String output,int index,JSONObject options) throws JSONException {return (JSONObject)command("indicatorValueAt",id,output,index,options==null?new JSONObject():options);}
    public String addDrawing(JSONObject options) throws JSONException {return (String)command("addDrawing",options);}
    /** Raw annotation metrics only; no source or indicator calculation and no notification. */
    public JSONObject positionMetrics(String id) throws JSONException {
        Object result=command("positionMetrics",id);if(!(result instanceof JSONObject))throw new JSONException("Position metrics receipt");return (JSONObject)result;
    }
    public void editDrawing(String id,JSONObject patch) throws JSONException {command("editDrawing",id,patch);}
    public boolean deleteDrawing(String id) throws JSONException {return (Boolean)command("deleteDrawing",id);}
    public void selectDrawing(String id) throws JSONException {command("selectDrawing",id);}
    public void setTheme(JSONObject patch) throws JSONException {command("setTheme",patch);}
    public void setSymbol(JSONObject symbol) throws JSONException {command("setSymbol",symbol);}
    public void setCrosshairSnap(JSONObject options) throws JSONException {command("setCrosshairSnap",options);}
    /** Fresh layout may calculate dirty studies; read-only, no change notification. */
    public JSONObject crosshairSnapshot(double width,double height) throws JSONException {
        Object result=command("crosshairSnapshot",width,height);if(result==JSONObject.NULL)return null;
        if(!(result instanceof JSONObject))throw new JSONException("Crosshair snapshot object receipt");return (JSONObject)result;
    }
    public void setDrawingMagnet(JSONObject options) throws JSONException {command("setDrawingMagnet",options);}
    public void setTool(String tool) throws JSONException {command("setTool",tool);}
    public void setText(String text) throws JSONException {command("setText",text);}
    public void undo() throws JSONException {command("undo");}
    public void redo() throws JSONException {command("redo");}
    public void fit() throws JSONException {command("fit");}
    public String saveDrawings() throws JSONException {return (String)invoke("nativeSave");}
    public void loadDrawings(String text) throws JSONException {command("loadDrawings",text);}
    @Override public void close(){
        if(Thread.currentThread()!=owner)throw new IllegalStateException("Close on owning thread");if(closing)return;closing=true;
        Error cleanupFailure=null;
        try{if(activeParams!=null)activeParams.job.closeOnOwner();if(activeWorkspace!=null)activeWorkspace.job.closeOnOwner();if(handle!=0){try{if(activeJob!=null)activeJob.stopOnOwner("closed");java.util.ArrayList<Runnable> cleanup=new java.util.ArrayList<>(closeObservers);closeObservers.clear();for(Runnable observer:cleanup)try{observer.run();}catch(RuntimeException ignored){/* Cleanup isolation; native context is still released. */}catch(Error error){if(cleanupFailure==null)cleanupFailure=error;}}
            finally{long released=handle;ParamsJob paramsClosing=activeParams;if(paramsClosing!=null)paramsClosing.job.sourceFreeStartedOnOwner();handle=0;try{free(released);if(paramsClosing!=null)paramsClosing.job.sourceFreedOnOwner();}finally{if(activeWorkspace!=null)activeWorkspace.job.closeOnOwner();}}}if(cleanupFailure!=null)throw cleanupFailure;}
        finally{closeObservers.clear();observers.clear();observerErrors.clear();onObserverError=null;closing=false;}
    }

    /** Optional isolated calculation. Synchronous API behavior is unchanged. */
    public interface AsyncListener {
        default void onProgress(AsyncProgress progress) {}
        void onComplete(AsyncResult result);
    }
    public static final class AsyncOptions {
        public final long timeoutMillis;
        public final int maxBarsPerStep;
        public AsyncOptions(){this(30000,4096);}
        public AsyncOptions(long timeoutMillis,int maxBarsPerStep){if(timeoutMillis<1||timeoutMillis>600000||maxBarsPerStep<1||maxBarsPerStep>16384)throw new IllegalArgumentException("Async timeout/step limits");this.timeoutMillis=timeoutMillis;this.maxBarsPerStep=maxBarsPerStep;}
    }
    public static final class AsyncProgress {
        public final String phase;public final long done,total;
        private AsyncProgress(String phase,long done,long total){this.phase=phase;this.done=done;this.total=total;}
    }
    public static final class AsyncResult {
        public final String status;public final Throwable error;public final JSONObject metrics;
        private AsyncResult(String status,Throwable error,JSONObject metrics){this.status=status;this.error=error;this.metrics=metrics;}
        public boolean succeeded(){return status.equals("success");}
        public JSONObject toJSON() throws JSONException {JSONObject value=new JSONObject().put("status",status).put("metrics",metrics);if(error!=null)value.put("error",error.toString());return value;}
    }
    public AsyncJob applyDataEventAsync(JSONObject event,AsyncListener listener) throws JSONException {return applyDataEventAsync(event,new AsyncOptions(),listener);}
    public AsyncJob applyDataEventAsync(JSONObject event,AsyncOptions options,AsyncListener listener) throws JSONException {
        checkAsyncOwner();
        if(event==null||options==null||listener==null)throw new IllegalArgumentException("Async event, options and listener required");
        // Snapshot caller-owned JSON before any worker/callback can see it.
        String eventJSON=event.toString();if(eventJSON.length()>8*1024*1024)throw new IllegalArgumentException("Async event size limit");
        return beginAsync("correction",eventJSON,null,options,listener);
    }
    public AsyncJob prepareColumnsAsync(AsterColumns columns,int visibleBars,AsyncListener listener) throws JSONException {return prepareColumnsAsync(columns,visibleBars,new AsyncOptions(),listener);}
    public AsyncJob prepareColumnsAsync(AsterColumns columns,int visibleBars,AsyncOptions options,AsyncListener listener) throws JSONException {checkAsyncOwner();if(columns==null)throw new IllegalArgumentException("Owned columns required");visibleBars(visibleBars);return beginAsync("columns",new JSONObject().put("kind","columns").put("length",columns.length()).put("visibleBars",visibleBars).toString(),columns,options,listener);}
    public AsyncJob prepareSeededAsync(int count,int seed,int visibleBars,AsyncListener listener) throws JSONException {return prepareSeededAsync(count,seed,visibleBars,new AsyncOptions(),listener);}
    /** Seed int represents unsigned32 bits; generation is demo data, not a feed. */
    public AsyncJob prepareSeededAsync(int count,int seed,int visibleBars,AsyncOptions options,AsyncListener listener) throws JSONException {checkAsyncOwner();if(count<0||count>AsterColumns.MAX_BARS)throw new IllegalArgumentException("Synthetic bar count limit");visibleBars(visibleBars);return beginAsync("seeded",new JSONObject().put("kind","seeded").put("count",count).put("seed",Integer.toUnsignedLong(seed)).put("visibleBars",visibleBars).toString(),null,options,listener);}
    private void visibleBars(int visibleBars){if(visibleBars<1||visibleBars>AsterColumns.MAX_BARS)throw new IllegalArgumentException("Visible bar limit");}
    private void checkAsyncOwner(){check();if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Async calculation requires a main/UI owner engine");}
    private AsyncJob beginAsync(String kind,String request,AsterColumns columns,AsyncOptions options,AsyncListener listener) throws JSONException {
        checkAsyncOwner();if(options==null||listener==null)throw new IllegalArgumentException("Async options and listener required");
        if(activeWorkspace!=null||activeParams!=null)throw new IllegalStateException("Workspace or parameter update is active");
        Thread preceding=null;if(activeJob!=null){preceding=activeJob.blockingWorker();activeJob.stopOnOwner("superseded");}
        AsyncJob job=new AsyncJob(kind,request,columns,options,listener,preceding);activeJob=job;job.start();return job;
    }
    /** Workspace-only cancellation handle. Success replaces the internal runtime. */
    public static final class WorkspaceJob {private final WorkspaceRestoreJob job;private WorkspaceJob(WorkspaceRestoreJob job){this.job=job;}public void cancel(){job.cancel();}public boolean cleanupPending(){return job.pendingOwnerCleanup();}public String pendingFailure(){return job.pendingOwnerFailure();}}
    public WorkspaceJob restoreWorkspaceAsync(String document,JSONObject binding,AsyncListener listener)throws JSONException {return restoreWorkspaceAsync(document,binding,new AsyncOptions(),listener);}
    /** Owned document + explicit dataset binding; one active job, no implicit supersession. */
    public WorkspaceJob restoreWorkspaceAsync(String document,JSONObject binding,AsyncOptions options,AsyncListener listener)throws JSONException {
        checkAsyncOwner();if(activeJob!=null||activeWorkspace!=null||activeParams!=null)throw new IllegalStateException("Async restore busy");if(document==null||document.length()>2097152||binding==null||options==null||listener==null)throw new IllegalArgumentException("Workspace document/binding/options/listener required");
        final long sourceHandle=handle,sourceRevision=revision;final String bindingJSON=binding.toString();checkAsyncOwner();if(handle!=sourceHandle||revision!=sourceRevision||activeJob!=null||activeWorkspace!=null||activeParams!=null)throw new IllegalStateException("Workspace source stale during arguments");
        final Handler queue=new Handler(Looper.getMainLooper());final long registration=WorkspaceRestoreJob.nextRegistration();
        WorkspaceRestoreJob.Host host=new WorkspaceRestoreJob.Host(){
            private long expectedBytes;
            public void requireOwner(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Workspace owning thread required");}
            public long currentHandle(){return handle;}public long currentRevision(){return revision;}public boolean closed(){return handle==0||closing;}
            public boolean current(WorkspaceRestoreJob job){return activeWorkspace!=null&&activeWorkspace.job==job;}
            public boolean post(Runnable action){return queue.post(action);}public boolean postDelayed(Runnable action,long delay){return queue.postDelayed(action,delay);}
            public long beginSource(long h,String text,String bind,long r)throws JSONException {JSONObject value=(JSONObject)invokeHandle(h,"nativeWorkspaceSourceBegin",text,new JSONObject(bind),r,WorkspaceRestoreJob.MAX_BYTES,registration);if(workspaceInteger(value.get("registration"),1,9007199254740991L,"registration")!=registration)throw new JSONException("Workspace registration binding");return workspaceInteger(value.get("ticket"),1,9007199254740991L,"ticket");}
            public WorkspaceRestoreJob.Admission admitSource(long h,long ticket,int records,long r)throws JSONException {
                JSONObject value=(JSONObject)invokeHandle(h,"nativeWorkspaceSourceStep",ticket,records,r);Object flag=value.get("complete");if(!(flag instanceof Boolean))throw new JSONException("Workspace admission completion");long done=workspaceInteger(value.get("done"),0,9007199254740991L,"admission progress");
                if(!((Boolean)flag)){if(!"admission".equals(value.get("phase")))throw new JSONException("Workspace admission phase");return new WorkspaceRestoreJob.Admission(done,null);}
                if(!"copy".equals(value.get("phase"))||workspaceInteger(value.get("ticket"),1,9007199254740991L,"ticket")!=ticket||!(value.get("metadataJSON") instanceof String)||value.getJSONArray("checkpoints").length()!=0)throw new JSONException("Workspace descriptor binding");
                JSONArray buffers=value.getJSONArray("buffers");if(buffers.length()!=6)throw new JSONException("Workspace six source buffers");int length=-1;for(int i=0;i<6;i++){JSONObject b=buffers.getJSONObject(i);if(workspaceInteger(b.get("slot"),0,5,"slot")!=i)throw new JSONException("Workspace source slot order");int n=(int)workspaceInteger(b.get("length"),0,AsterColumns.MAX_BARS,"length");if(length>=0&&n!=length)throw new JSONException("Workspace source column lengths");length=n;}
                expectedBytes=workspaceInteger(value.getJSONObject("plan").get("totalBytes"),1,WorkspaceRestoreJob.MAX_BYTES,"logical bytes");return new WorkspaceRestoreJob.Admission(done,new WorkspaceRestoreJob.Descriptor(ticket,(String)value.get("metadataJSON"),length,expectedBytes));
            }
            public void checkSource(long h,long ticket,long r)throws JSONException {if(!Boolean.TRUE.equals(invokeHandle(h,"nativeWorkspaceSourceCheck",ticket,r)))throw new JSONException("Workspace source check");}
            public byte[] readSource(long h,long ticket,int slot,int offset,int count){return readBuffer(h,ticket,slot,offset,count);}
            public void finishSource(long h,long ticket,long r)throws JSONException {JSONObject value=(JSONObject)invokeHandle(h,"nativeWorkspaceSourceFinish",ticket,r);if(!"aster.native-workspace-source-finished".equals(value.get("schema"))||workspaceInteger(value.get("version"),1,1,"version")!=1||workspaceInteger(value.get("ticket"),1,9007199254740991L,"ticket")!=ticket||workspaceInteger(value.get("revision"),0,9007199254740991L,"revision")!=r)throw new JSONException("Workspace source finish binding");}
            public void releaseSource(long h,long ticket)throws JSONException {Object result=invokeHandle(h,"nativeWorkspaceSourceAbort",registration);if(!(result instanceof Boolean))throw new JSONException("Workspace abort receipt");}
            public long createTarget(String metadata)throws JSONException {long target=create(sourceBundle);try{if(!Boolean.TRUE.equals(invokeHandle(target,"nativeWorkspaceTargetCreate",metadata)))throw new JSONException("Workspace target create");return target;}catch(JSONException|RuntimeException|Error error){free(target);throw error;}}
            public void writeTarget(long h,int slot,int offset,byte[] bytes){writeBuffer(h,slot,offset,bytes);}
            public void startTarget(long h)throws JSONException {if(!Boolean.TRUE.equals(invokeHandle(h,"nativeAsyncStart")))throw new JSONException("Workspace target start");}
            public WorkspaceRestoreJob.Progress stepTarget(long h,int bars)throws JSONException {Object encoded=invokeHandle(h,"nativeAsyncStep",bars);if(!(encoded instanceof String))throw new JSONException("Workspace progress encoding");JSONObject p=new JSONObject((String)encoded);Object phase=p.get("phase"),complete=p.get("complete");if(!(phase instanceof String)||!(complete instanceof Boolean)||!java.util.Arrays.asList("validate","store-index","calculate","indices","workspace-checkpoints","workspace-ready").contains(phase)||((Boolean)complete)!=phase.equals("workspace-ready"))throw new JSONException("Workspace target phase");return new WorkspaceRestoreJob.Progress((String)phase,workspaceInteger(p.get("done"),0,9007199254740991L,"progress"),workspaceInteger(p.get("total"),0,9007199254740991L,"total"),(Boolean)complete);}
            public void finishTarget(long h)throws JSONException {JSONObject value=(JSONObject)invokeHandle(h,"nativeWorkspaceTargetFinish");if(!"aster.native-workspace-target-ready".equals(value.get("schema"))||workspaceInteger(value.get("version"),1,1,"version")!=1||!"target-ready".equals(value.get("status"))||!Boolean.FALSE.equals(value.get("hostPublished"))||workspaceInteger(value.getJSONObject("plan").get("totalBytes"),1,WorkspaceRestoreJob.MAX_BYTES,"logical bytes")!=expectedBytes)throw new JSONException("Workspace target finish binding");}
            public void free(long h){AsterEngine.free(h);}
            public void publish(WorkspaceRestoreJob job,long source,long target,long r){if(handle!=source||revision!=r||closed()||!current(job))throw new IllegalStateException("Workspace stale before publication");handle=target;}
            public void releaseReservation(WorkspaceRestoreJob job){if(current(job))activeWorkspace=null;}
            public void notifyObservers(){notifyChanges();}
            public void onProgress(String phase,long done,long total){listener.onProgress(new AsyncProgress(phase,done,total));}
            public void onComplete(String status,Throwable error,WorkspaceRestoreJob.Metrics m){try{JSONObject metrics=new JSONObject().put("kind","workspace").put("elapsedMs",m.elapsedNanos/1e6).put("copiedBytes",m.copiedBytes).put("logicalAdmissionBytes",m.logicalBytes).put("callbackErrors",m.callbackErrors).put("memoryPolicy","known chart state plus target logical reservation; not RSS");listener.onComplete(new AsyncResult(status,error,metrics));}catch(JSONException impossible){throw new IllegalStateException(impossible);}}
            public void onCallbackError(Throwable error){if(observerErrors.size()<32)observerErrors.add(error);try{if(onObserverError!=null)onObserverError.accept(error);}catch(Throwable reporting){if(observerErrors.size()<32)observerErrors.add(reporting);}}
        };
        WorkspaceRestoreJob state=new WorkspaceRestoreJob(host,document,bindingJSON,options.timeoutMillis,options.maxBarsPerStep);WorkspaceJob result=new WorkspaceJob(state);activeWorkspace=result;state.enqueueInitial();return result;
    }
    /** Cancellation/status handle for entry-only parameter updates. */
    public static final class ParamsJob {
        private final ParamsUpdateJob job;
        private ParamsJob(ParamsUpdateJob job){this.job=job;}
        public void cancel(){job.cancel();}
        public boolean cleanupPending(){return job.pendingOwnerCleanup();}
        public String commitOutcome(){return job.commitOutcome();}
        /** Retry only on the original owner thread; never retries an uncertain free. */
        public void retryCleanup(){job.resumeOwnerCleanup();}
    }
    public ParamsJob setIndicatorParamsAsync(String id,JSONObject params,AsyncListener listener)throws JSONException{return setIndicatorParamsAsync(id,params,new AsyncOptions(),listener);}
    /** Original runtime/store retained; linked portable indicator definitions only. */
    public ParamsJob setIndicatorParamsAsync(String id,JSONObject params,AsyncOptions options,AsyncListener listener)throws JSONException{
        checkAsyncOwner();if(activeJob!=null||activeWorkspace!=null||activeParams!=null)throw new IllegalStateException("Async params busy");
        if(id==null||id.length()>128||params==null||options==null||listener==null)throw new IllegalArgumentException("Params arguments required");
        final long sourceHandle=handle,sourceRevision=revision;final String text=params.toString();
        checkAsyncOwner();if(handle!=sourceHandle||revision!=sourceRevision||activeJob!=null||activeWorkspace!=null||activeParams!=null)throw new IllegalStateException("Params source stale during arguments");
        final Handler queue=new Handler(Looper.getMainLooper());final long registration=WorkspaceRestoreJob.nextRegistration();
        ParamsUpdateJob.Host host=new ParamsUpdateJob.Host(){
            public void requireOwner(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Params owning thread required");}
            public long currentHandle(){return handle;}public long currentRevision(){return revision;}public boolean closed(){return handle==0||closing;}
            public boolean current(ParamsUpdateJob job){return activeParams!=null&&activeParams.job==job;}
            public boolean post(Runnable action){return queue.post(action);}public boolean postDelayed(Runnable action,long millis){return queue.postDelayed(action,millis);}
            public long begin(long h,String id,String params,long r,long token)throws JSONException{JSONObject v=(JSONObject)invokeHandle(h,"nativeParamsSourceBegin",id,new JSONObject(params),r,NativeJobBudget.MAX_BYTES,token);if(workspaceInteger(v.get("registration"),1,9007199254740991L,"registration")!=token)throw new JSONException("Params begin registration");return workspaceInteger(v.get("ticket"),1,9007199254740991L,"ticket");}
            public ParamsUpdateJob.Descriptor admit(long h,long ticket,long r)throws JSONException{JSONObject v=(JSONObject)invokeHandle(h,"nativeParamsSourceStep",ticket,8,r);Object complete=v.get("complete");if(!(complete instanceof Boolean))throw new JSONException("Params admission completion");if(!((Boolean)complete))return null;if("noop".equals(v.get("phase")))return new ParamsUpdateJob.Descriptor(null,0,0,true);if(!"copy".equals(v.get("phase")))throw new JSONException("Params admission phase");Object metadata=v.get("metadataJSON");if(!(metadata instanceof String)||((String)metadata).length()>131072)throw new JSONException("Params metadata limit");JSONObject meta=new JSONObject((String)metadata);return new ParamsUpdateJob.Descriptor((String)metadata,(int)workspaceInteger(meta.get("length"),0,AsterColumns.MAX_BARS,"length"),workspaceInteger(v.getJSONObject("plan").get("totalBytes"),1,NativeJobBudget.MAX_BYTES,"logical bytes"),false);}
            public void checkSource(long h,long ticket,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceCheck",ticket,r));}
            public byte[] readSource(long h,long ticket,int slot,int offset,int count){return readBuffer(h,ticket,slot,offset,count);}
            public long createTarget(){return create(sourceBundle);}
            public void initializeTarget(long h,String metadata)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsTargetCreate",metadata));}
            public void writeTarget(long h,int slot,int offset,byte[] bytes){writeBuffer(h,slot,offset,bytes);}
            public void startTarget(long h)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsTargetStart"));}
            public boolean stepTarget(long h,int bars)throws JSONException{JSONObject p=(JSONObject)invokeHandle(h,"nativeParamsTargetStep",bars);Object phase=p.get("phase"),flag=p.get("complete");if(!(flag instanceof Boolean)||!java.util.Arrays.asList("validate","calculate","outputs","ready").contains(phase)||((Boolean)flag)!=phase.equals("ready"))throw new JSONException("Params target progress");long done=workspaceInteger(p.get("done"),0,9007199254740991L,"progress"),total=workspaceInteger(p.get("total"),0,9007199254740991L,"total");if(done>total)throw new JSONException("Params progress bounds");return (Boolean)flag;}
            public ParamsUpdateJob.Result result(long h)throws JSONException{Object text=invokeHandle(h,"nativeParamsTargetDescriptor");if(!(text instanceof String)||((String)text).length()>131072)throw new JSONException("Params result metadata");JSONObject v=new JSONObject((String)text);return new ParamsUpdateJob.Result((String)text,v.getJSONArray("outputs").length(),(int)workspaceInteger(v.get("capacity"),16,AsterColumns.MAX_BARS,"capacity"),(int)workspaceInteger(v.get("checkpointCount"),0,16385,"checkpoint count"));}
            public byte[] readResult(long h,long token,int slot,int offset,int count){return readBuffer(h,token,slot,offset,count);}
            public ParamsUpdateJob.Record checkpoint(long h,int ordinal)throws JSONException{JSONObject v=(JSONObject)invokeHandle(h,"nativeParamsTargetCheckpoint",ordinal);Object text=v.get("text");if(!(text instanceof String))throw new JSONException("Params checkpoint text");return new ParamsUpdateJob.Record((int)workspaceInteger(v.get("index"),0,AsterColumns.MAX_BARS,"checkpoint index"),(String)text);}
            public void freeTarget(long h){free(h);}
            public void receive(long h,long ticket,String text,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceReceive",ticket,text,r));}
            public void writeResult(long h,long ticket,int slot,int offset,byte[] bytes,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceArmWrite",ticket,slot,offset,bytes.length/8,r));writeBuffer(h,slot,offset,bytes);}
            public void importCheckpoint(long h,long ticket,ParamsUpdateJob.Record record,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceCheckpoint",ticket,record.index,record.text,r));}
            public boolean validate(long h,long ticket,int values,long r)throws JSONException{JSONObject p=(JSONObject)invokeHandle(h,"nativeParamsSourceValidate",ticket,values,r);Object flag=p.get("complete");if(!(flag instanceof Boolean))throw new JSONException("Params validation completion");return (Boolean)flag;}
            public void prepare(long h,long ticket,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourcePrepare",ticket,r));}
            public ParamsUpdateJob.Receipt publish(long h,long ticket,long r)throws JSONException{return paramsReceipt(invokeHandle(h,"nativeParamsSourcePublish",ticket,r),registration,id);}
            public ParamsUpdateJob.Receipt status(long h,long token)throws JSONException{return paramsReceipt(invokeHandle(h,"nativeParamsSourceStatus",token),token,id);}
            public ParamsUpdateJob.Receipt abort(long h,long token)throws JSONException{return paramsReceipt(invokeHandle(h,"nativeParamsSourceAbort",token),token,id);}
            public void releaseReservation(ParamsUpdateJob job){if(current(job))activeParams=null;}
            public void notifyObservers(){notifyChanges();}
            public void onProgress(String phase,long done,long total){listener.onProgress(new AsyncProgress(phase,done,total));}
            public void onComplete(String status,String outcome,String cleanup,Throwable error,long copied,long bytes,int callbackErrors){try{listener.onComplete(new AsyncResult(status,error,new JSONObject().put("kind","indicator-params").put("commitOutcome",outcome).put("cleanupState",cleanup).put("copiedBytes",copied).put("logicalAdmissionBytes",bytes).put("callbackErrors",callbackErrors)));}catch(JSONException impossible){throw new IllegalStateException(impossible);}}
            public void onCallbackError(Throwable error){if(observerErrors.size()<32)observerErrors.add(error);try{if(onObserverError!=null)onObserverError.accept(error);}catch(Throwable reporting){if(observerErrors.size()<32)observerErrors.add(reporting);}}
        };
        ParamsUpdateJob state=new ParamsUpdateJob(host,id,text,registration,options.timeoutMillis,options.maxBarsPerStep);ParamsJob result=new ParamsJob(state);activeParams=result;state.enqueueInitial();return result;
    }
    private static void paramsTrue(Object value)throws JSONException{if(!Boolean.TRUE.equals(value))throw new JSONException("Params acknowledgment");}
    private static ParamsUpdateJob.Receipt paramsReceipt(Object raw,long registration,String id)throws JSONException{
        if(raw==JSONObject.NULL)return new ParamsUpdateJob.Receipt("unknown",registration);
        if(!(raw instanceof JSONObject))throw new JSONException("Params status object");JSONObject value=(JSONObject)raw;
        if(workspaceInteger(value.get("registration"),1,9007199254740991L,"registration")!=registration)throw new JSONException("Params status registration");
        Object status=value.get("status");if(!(status instanceof String))throw new JSONException("Params status string");
        if(status.equals("committed")||status.equals("unchanged")){
            JSONObject receipt=value.getJSONObject("receipt");
            if(!"aster.native-params-published".equals(receipt.get("schema"))||workspaceInteger(receipt.get("version"),1,1,"version")!=1||workspaceInteger(receipt.get("registration"),1,9007199254740991L,"registration")!=registration||!status.equals(receipt.get("status"))||!id.equals(receipt.get("id")))throw new JSONException("Params publication receipt binding");
            JSONArray outputs=receipt.getJSONArray("outputs");if(outputs.length()<1||outputs.length()>32)throw new JSONException("Params publication outputs");java.util.HashSet<String> names=new java.util.HashSet<>();for(int i=0;i<outputs.length();i++){Object name=outputs.get(i);if(!(name instanceof String)||((String)name).isEmpty()||((String)name).length()>128||java.util.Arrays.asList("__proto__","constructor","prototype").contains(name)||!names.add((String)name))throw new JSONException("Params publication output name");}
            JSONObject offsets=receipt.getJSONObject("plotOffsets");java.util.Iterator<String> keys=offsets.keys();while(keys.hasNext()){String key=keys.next();if(!names.contains(key))throw new JSONException("Params publication offset output");workspaceInteger(offsets.get(key),-10000,10000,"plot offset");}
        }
        return new ParamsUpdateJob.Receipt((String)status,registration);
    }
    private static long workspaceInteger(Object value,long min,long max,String label)throws JSONException {if(!(value instanceof Number))throw new JSONException("Workspace numeric "+label);double n=((Number)value).doubleValue();if(!Double.isFinite(n)||n!=Math.rint(n)||n<min||n>max)throw new JSONException("Workspace integer "+label);return (long)n;}
    private static Object invokeHandle(long h,String function,Object... args) throws JSONException {return new JSONArray("["+call(h,function,new JSONArray(args).toString())+"]").get(0);}
    private static final class Transfer {
        final int slot,offset,entry,inputCount,uiKind;final byte[] bytes;final String rows;
        Transfer(int slot,int offset,byte[] bytes){this.slot=slot;this.offset=offset;this.bytes=bytes;entry=-1;rows=null;inputCount=0;uiKind=0;}
        Transfer(int slot,int offset,int inputCount){this.slot=slot;this.offset=offset;this.inputCount=inputCount;entry=-1;rows=null;bytes=null;uiKind=0;}
        Transfer(int entry,String rows){this.entry=entry;this.rows=rows;slot=-1;offset=0;bytes=null;inputCount=0;uiKind=0;}
        Transfer(String rows,int uiKind){this.rows=rows;this.uiKind=uiKind;slot=-1;offset=0;entry=-1;inputCount=0;bytes=null;}
        Transfer(){slot=-1;offset=0;entry=-1;bytes=null;rows=null;inputCount=0;uiKind=0;}
    }
    /** One job per engine. cancel() is thread-safe and never frees a running context. */
    public final class AsyncJob {
        private final Handler handler=new Handler(Looper.getMainLooper());
        private final AsyncOptions options;private AsyncListener listener;private String eventJSON;private final String kind;private AsterColumns inputColumns;
        private final long inputOwnedBytes;private final double inputCopyMillis;
        private Thread preceding;
        private final java.util.concurrent.ArrayBlockingQueue<Transfer> transfers=new java.util.concurrent.ArrayBlockingQueue<>(1);
        private final long started=System.nanoTime(),deadline;
        private volatile String stopped;private volatile Throwable failure;
        private boolean terminal=false,released=false,committed=false;private long ticket=-1;
        private JSONObject descriptor;private Thread worker;
        private int slotIndex=0,slotOffset=0,checkpointIndex=0,checkpointOffset=0;
        private volatile long copiedBytes=0,copyChunks=0,checkpointRows=0,checkpointChars=0;
        private volatile long intermediatePeakBytes=0,workerMemoryPeak=0,processPssPeakKiB=0;
        private long sourceMemory=0,ownerCopyNanos=0,ownerCopyMaxNanos=0,ownerCaptureNanos=0,uiSnapshotNanos=0,finishNanos=0;
        private long uiSnapshotMaxNanos=0,uiChunks=0,uiChars=0,uiUtf8Bytes=0;private volatile long uiImportNanos=0,uiReferences=0,uiTotalReferences=0;
        private long ownerCheckpointNanos=0,ownerCheckpointMaxNanos=0,ownerMemorySamplingNanos=0,processPssBaselineKiB=0;
        private volatile long createNanos=0,computeNanos=0,lastProgressNanos=0,inputWriteNanos=0,inputWriteMaxNanos=0;private volatile String lastProgressPhase="";
        private AsyncJob(String kind,String eventJSON,AsterColumns inputColumns,AsyncOptions options,AsyncListener listener,Thread preceding){this.kind=kind;this.eventJSON=eventJSON;this.inputColumns=inputColumns;inputOwnedBytes=inputColumns==null?0:inputColumns.ownedBytes();inputCopyMillis=inputColumns==null?0:inputColumns.copyMillis();this.options=options;this.listener=listener;this.preceding=preceding;deadline=started+options.timeoutMillis*1000000;}
        private Thread blockingWorker(){return worker!=null&&worker.isAlive()?worker:preceding!=null&&preceding.isAlive()?preceding:null;}
        public void cancel(){synchronized(this){if(committed||stopped!=null)return;stopped="cancelled";}handler.post(()->{if(!terminal){releaseOnOwner();transfers.offer(new Transfer());}});}
        private synchronized void stopOnce(String reason){if(!committed&&stopped==null)stopped=reason;}
        private void stopOnOwner(String reason){stopOnce(reason);releaseOnOwner();transfers.offer(new Transfer());}
        private void releaseOnOwner(){if(released)return;released=true;if(ticket>=0&&handle!=0){try{invokeHandle(handle,"nativeAsyncRelease",ticket);}catch(JSONException|RuntimeException releaseError){if(failure==null)failure=releaseError;}}}
        private void start(){try {
            long began=System.nanoTime();descriptor=new JSONObject((String)ingestionResult((JSONObject)invokeHandle(handle,"nativeDataAsyncBegin",kind,eventJSON)));ownerCaptureNanos=System.nanoTime()-began;
            ticket=descriptor.getLong("ticket");JSONArray buffers=descriptor.getJSONArray("buffers"),checkpoints=descriptor.getJSONArray("checkpoints");
            if(ticket<0||buffers.length()>2048||checkpoints.length()>128)throw new IllegalStateException("Async descriptor limits");
            for(int i=0;i<buffers.length();i++){JSONObject buffer=buffers.getJSONObject(i);if(buffer.getInt("slot")!=i||buffer.getLong("length")<0||buffer.getLong("length")>33554432)throw new IllegalStateException("Async buffer descriptor");}
            for(int i=0;i<checkpoints.length();i++){JSONObject checkpoint=checkpoints.getJSONObject(i);int maxRows=checkpoint.optInt("maxRows",64);if(checkpoint.getInt("entry")<0||checkpoint.getInt("total")<0||checkpoint.getInt("total")>4194304||maxRows<1||maxRows>64)throw new IllegalStateException("Async checkpoint descriptor");}
            sourceMemory=memoryUsed(handle);sampleProcess();
            startAfterPrevious();
        }catch(Throwable error){failure=error;stopOnce(classify(error));releaseOnOwner();handler.post(()->complete(stopped,error));}}
        private void startAfterPrevious(){if(stopRequested()){releaseOnOwner();complete(stopped,failure);return;}if(preceding!=null&&preceding.isAlive()){handler.postDelayed(this::startAfterPrevious,1);return;}worker=new Thread(this::runWorker,"Aster isolated calculation");worker.start();}
        private String classify(Throwable error){String text=String.valueOf(error.getMessage()).toLowerCase(Locale.ROOT);return text.contains("stale")?"stale":"failed";}
        private synchronized boolean stopRequested(){if(!committed&&stopped==null&&System.nanoTime()>=deadline)stopped="timedOut";return stopped!=null;}
        private void sampleProcess(){long began=System.nanoTime();Debug.MemoryInfo info=new Debug.MemoryInfo();Debug.getMemoryInfo(info);long pss=info.getTotalPss();if(processPssBaselineKiB==0)processPssBaselineKiB=pss;processPssPeakKiB=Math.max(processPssPeakKiB,pss);if(Thread.currentThread()==owner)ownerMemorySamplingNanos+=System.nanoTime()-began;}
        private void progress(String phase,long done,long total,boolean force){long now=System.nanoTime();if(!force&&phase.equals(lastProgressPhase)&&now-lastProgressNanos<40000000)return;lastProgressNanos=now;lastProgressPhase=phase;AsyncProgress value=new AsyncProgress(phase,done,total);handler.post(()->{if(!terminal&&stopped==null&&listener!=null)try{listener.onProgress(value);}catch(RuntimeException callbackError){android.util.Log.w("AsterAsync","Progress callback failed",callbackError);}});}
        private void captureNext(){if(terminal||stopRequested()||activeJob!=this||handle==0){stopOnce(handle==0?"closed":"superseded");releaseOnOwner();transfers.offer(new Transfer());return;}
            try {invokeHandle(handle,"nativeAsyncCheck",ticket);JSONArray buffers=descriptor.getJSONArray("buffers");
                if(kind.equals("columns")){
                    while(slotIndex<6){if(slotOffset==inputColumns.length()){slotIndex++;slotOffset=0;continue;}int count=Math.min(262144,inputColumns.length()-slotOffset);Transfer transfer=new Transfer(slotIndex,slotOffset,count);slotOffset+=count;if(!transfers.offer(transfer))throw new IllegalStateException("Prepare input backpressure");return;}
                    if(!transfers.offer(new Transfer()))throw new IllegalStateException("Prepare completion backpressure");return;
                }
                while(slotIndex<buffers.length()){
                    JSONObject buffer=buffers.getJSONObject(slotIndex);int length=buffer.getInt("length");if(slotOffset==length){slotIndex++;slotOffset=0;continue;}
                    int count=Math.min(262144,length-slotOffset);long began=System.nanoTime();byte[] bytes=readBuffer(handle,ticket,buffer.getInt("slot"),slotOffset,count);long elapsed=System.nanoTime()-began;ownerCopyNanos+=elapsed;ownerCopyMaxNanos=Math.max(ownerCopyMaxNanos,elapsed);
                    if(bytes==null||bytes.length!=count*8)throw new IllegalStateException("Async typed buffer copy length");
                    Transfer chunk=new Transfer(buffer.getInt("slot"),slotOffset,bytes);slotOffset+=count;copiedBytes+=bytes.length;copyChunks++;intermediatePeakBytes=Math.max(intermediatePeakBytes,bytes.length*2L);
                    if(!transfers.offer(chunk))throw new IllegalStateException("Async transfer backpressure");progress("capture",copiedBytes,totalBytes(),false);return;
                }
                JSONArray checkpoints=descriptor.getJSONArray("checkpoints");while(checkpointIndex<checkpoints.length()){
                    JSONObject entry=checkpoints.getJSONObject(checkpointIndex);int total=entry.getInt("total");if(checkpointOffset==total){checkpointIndex++;checkpointOffset=0;continue;}
                    int count=Math.min(entry.optInt("maxRows",64),total-checkpointOffset);long began=System.nanoTime();String rows=(String)invokeHandle(handle,"nativeAsyncCheckpoint",ticket,entry.getInt("entry"),checkpointOffset,count);long elapsed=System.nanoTime()-began;ownerCheckpointNanos+=elapsed;ownerCheckpointMaxNanos=Math.max(ownerCheckpointMaxNanos,elapsed);checkpointOffset+=count;checkpointRows+=count;checkpointChars+=rows.length();
                    if(!transfers.offer(new Transfer(entry.getInt("entry"),rows)))throw new IllegalStateException("Async checkpoint backpressure");progress("checkpoints",checkpointRows,totalCheckpoints(),false);return;
                }
                if(!transfers.offer(new Transfer()))throw new IllegalStateException("Async completion backpressure");
            }catch(Throwable error){failure=error;stopOnce(classify(error));releaseOnOwner();transfers.offer(new Transfer());}}
        private long totalBytes() throws JSONException {long n=0;JSONArray buffers=descriptor.getJSONArray("buffers");for(int i=0;i<buffers.length();i++)n+=buffers.getJSONObject(i).getLong("length")*8;return n;}
        private long totalCheckpoints() throws JSONException {long n=0;JSONArray list=descriptor.getJSONArray("checkpoints");for(int i=0;i<list.length();i++)n+=list.getJSONObject(i).getLong("total");return n;}
        private void captureUI(boolean begin){if(terminal||stopRequested()||activeJob!=this||handle==0){stopOnce(handle==0?"closed":"superseded");releaseOnOwner();transfers.offer(new Transfer());return;}try{long started=System.nanoTime();invokeHandle(handle,"nativeAsyncCheck",ticket);String json=(String)invokeHandle(handle,begin?"nativeAsyncUIBegin":"nativeAsyncUINext",ticket);if(json.length()>262144)throw new IllegalStateException("UI transfer character limit");int utf8Bytes=json.getBytes(StandardCharsets.UTF_8).length;if(utf8Bytes>1048576)throw new IllegalStateException("UI transfer UTF-8 limit");boolean complete=!begin&&json.equals("{\"complete\":true}");long elapsed=System.nanoTime()-started;uiSnapshotNanos+=elapsed;uiSnapshotMaxNanos=Math.max(uiSnapshotMaxNanos,elapsed);uiChunks++;uiChars+=json.length();uiUtf8Bytes+=utf8Bytes;if(!transfers.offer(new Transfer(json,begin?1:complete?3:2)))throw new IllegalStateException("UI transfer backpressure");progress("ui-capture",uiChunks,0,false);}catch(Throwable error){failure=error;stopOnce(classify(error));releaseOnOwner();transfers.offer(new Transfer());}}
        private void runWorker(){long prepared=0;boolean handedOff=false;try {
            if(stopRequested())return;long began=System.nanoTime();prepared=create(sourceBundle);invokeHandle(prepared,kind.equals("correction")?"nativeAsyncCreate":"nativePrepareCreate",descriptor.getString("metadataJSON"));createNanos=System.nanoTime()-began;workerMemoryPeak=memoryPeak(prepared);handler.post(this::captureNext);
            while(!stopRequested()){
                Transfer transfer=transfers.poll(50,java.util.concurrent.TimeUnit.MILLISECONDS);if(transfer==null)continue;if(stopRequested())break;
                if(transfer.inputCount>0){long copyStart=System.nanoTime();inputColumns.copyInto(prepared,transfer.slot,transfer.offset,transfer.inputCount);long elapsed=System.nanoTime()-copyStart;inputWriteNanos+=elapsed;inputWriteMaxNanos=Math.max(inputWriteMaxNanos,elapsed);copiedBytes+=transfer.inputCount*8L;copyChunks++;intermediatePeakBytes=Math.max(intermediatePeakBytes,transfer.inputCount*8L);progress("copy-input",copiedBytes,inputOwnedBytes,false);}
                else if(transfer.bytes!=null){writeBuffer(prepared,transfer.slot,transfer.offset,transfer.bytes);}
                else if(transfer.rows!=null){invokeHandle(prepared,"nativeAsyncCheckpointImport",transfer.entry,transfer.rows);}
                else break;
                workerMemoryPeak=Math.max(workerMemoryPeak,memoryPeak(prepared));transfer=null;handler.post(this::captureNext);
            }
            if(stopRequested())return;began=System.nanoTime();invokeHandle(prepared,"nativeAsyncStart");
            while(!stopRequested()){
                JSONObject step=new JSONObject((String)invokeHandle(prepared,"nativeAsyncStep",options.maxBarsPerStep));progress(step.getString("phase"),step.getLong("done"),step.getLong("total"),step.getBoolean("complete"));
                workerMemoryPeak=Math.max(workerMemoryPeak,memoryPeak(prepared));if(step.getBoolean("complete"))break;
            }
            computeNanos=System.nanoTime()-began;sampleProcess();if(stopRequested())return;
            boolean uiHeaderImported=false;handler.post(()->captureUI(true));while(!stopRequested()){
                Transfer ui=transfers.poll(50,java.util.concurrent.TimeUnit.MILLISECONDS);if(ui==null)continue;if(stopRequested())break;if(ui.uiKind==0)throw new IllegalStateException("UI transfer interrupted");long imported=System.nanoTime();
                if(ui.uiKind==1){if(uiHeaderImported)throw new IllegalStateException("Duplicate UI header");invokeHandle(prepared,"nativeAsyncUIImportBegin",ui.rows);JSONArray counts=new JSONObject(ui.rows).getJSONObject("state").getJSONObject("drawings").getJSONArray("frameCounts");long total=0;for(int i=0;i<counts.length();i++){double value=counts.getDouble(i);if(!Double.isFinite(value)||value<0||value!=Math.rint(value)||value>Integer.MAX_VALUE)throw new IllegalStateException("UI frame reference count");total=Math.addExact(total,(long)value);}uiTotalReferences=total;uiHeaderImported=true;}
                else if(ui.uiKind==2){if(!uiHeaderImported)throw new IllegalStateException("UI header required");JSONObject chunk=new JSONObject(ui.rows);JSONArray refs=chunk.getJSONArray("refs");if(!Boolean.FALSE.equals(chunk.get("complete"))||refs.length()<1||refs.length()>64||uiReferences>uiTotalReferences-refs.length())throw new IllegalStateException("UI reference progress bounds");invokeHandle(prepared,"nativeAsyncUIImportChunk",ui.rows);uiReferences+=refs.length();}
                else if(ui.uiKind==3){if(!uiHeaderImported||uiReferences!=uiTotalReferences||!ui.rows.equals("{\"complete\":true}"))throw new IllegalStateException("UI reference transfer incomplete");invokeHandle(prepared,"nativeAsyncUIImportEnd");}
                else throw new IllegalStateException("UI transfer kind");
                uiImportNanos+=System.nanoTime()-imported;progress("ui-copy",uiReferences,uiTotalReferences,ui.uiKind==3);workerMemoryPeak=Math.max(workerMemoryPeak,memoryPeak(prepared));if(ui.uiKind==3)break;ui=null;handler.post(()->captureUI(false));
            }
            if(stopRequested())return;
            final long handoff=prepared;prepared=0;handedOff=true;if(!handler.post(()->awaitWorkerThenCommit(handoff))){prepared=handoff;handedOff=false;throw new IllegalStateException("Async owner Handler unavailable");}
        }catch(Throwable error){failure=error;stopOnce(classify(error));
        }finally{if(prepared!=0)free(prepared);if(!handedOff&&stopped!=null){handler.post(()->{releaseOnOwner();complete(stopped,failure);});}}}
        private void awaitWorkerThenCommit(long prepared){if(worker.isAlive()){final long waiting=prepared;handler.postDelayed(()->awaitWorkerThenCommit(waiting),1);return;}
            try {if(stopRequested()||handle==0||activeJob!=this){stopOnce(handle==0?"closed":"superseded");return;}
                invokeHandle(handle,"nativeAsyncCheck",ticket);invokeHandle(handle,"nativeAsyncUICheck",ticket);long began=System.nanoTime();invokeHandle(prepared,"nativeAsyncFinish","");finishNanos=System.nanoTime()-began;
                long previous;
                // The same monitor linearizes a returned cancel() and publication.
                // Keep native release failure before publication; callbacks stay
                // outside this lock and old-runtime disposal happens afterwards.
                synchronized(this){
                    if(stopRequested()||handle==0||activeJob!=this){stopOnce(handle==0?"closed":"superseded");return;}
                    releaseOnOwner();if(failure!=null)throw new IllegalStateException("Async source release failed",failure);
                    previous=handle;handle=prepared;prepared=0;committed=true;
                }
                free(previous);sampleProcess();
                // A committed context cannot be rolled back by observer code.
                // Report success even if an observer throws a fatal Error.
                try{notifyChanges();}finally{complete("success",null);}
            }catch(Throwable error){failure=error;stopOnce(classify(error));
            }finally{if(prepared!=0)free(prepared);if(!terminal){releaseOnOwner();complete(stopped==null?"failed":stopped,failure);}}}
        private void complete(String status,Throwable error){if(terminal)return;terminal=true;releaseOnOwner();if(activeJob==this)activeJob=null;transfers.clear();inputColumns=null;
            try {JSONObject metrics=new JSONObject().put("kind",kind).put("immutableInputBytes",inputOwnedBytes).put("inputCopyMillisBeforeJob",inputCopyMillis).put("workerInputWriteTotalMs",inputWriteNanos/1e6).put("workerInputWriteMaxMs",inputWriteMaxNanos/1e6).put("elapsedMs",(System.nanoTime()-started)/1e6).put("copiedBytes",copiedBytes).put("copyChunks",copyChunks).put("checkpointRows",checkpointRows).put("checkpointChars",checkpointChars).put("ownerBeginMs",ownerCaptureNanos/1e6).put("ownerCopyTotalMs",ownerCopyNanos/1e6).put("ownerCopyMaxMs",ownerCopyMaxNanos/1e6).put("ownerCheckpointTotalMs",ownerCheckpointNanos/1e6).put("ownerCheckpointMaxMs",ownerCheckpointMaxNanos/1e6).put("ownerMemorySamplingMs",ownerMemorySamplingNanos/1e6).put("ownerUISnapshotMs",uiSnapshotNanos/1e6).put("ownerUISnapshotMaxMs",uiSnapshotMaxNanos/1e6).put("uiChunks",uiChunks).put("uiChars",uiChars).put("uiUtf8Bytes",uiUtf8Bytes).put("uiReferences",uiReferences).put("uiTotalReferences",uiTotalReferences).put("workerUIImportMs",uiImportNanos/1e6).put("ownerFinishMs",finishNanos/1e6).put("workerCreateMs",createNanos/1e6).put("workerComputeMs",computeNanos/1e6).put("sourceRuntimeMemoryBytes",sourceMemory).put("workerRuntimeMemoryPeakBytes",workerMemoryPeak).put("intermediateCopyPeakBytes",intermediatePeakBytes).put("processPssBaselineKiB",processPssBaselineKiB).put("sampledProcessPssPeakKiB",processPssPeakKiB).put("memorySampling","continuous QuickJS requested allocations plus aligned headers; process PSS begin and post-compute/commit; PSS peak sampled, not continuous RSS");
                try{listener.onComplete(new AsyncResult(status,error,metrics));}catch(RuntimeException callbackError){android.util.Log.w("AsterAsync","Completion callback failed",callbackError);}
            }catch(JSONException metricsError){throw new IllegalStateException(metricsError);}finally{listener=null;eventJSON=null;inputColumns=null;descriptor=null;worker=null;preceding=null;failure=null;handler.removeCallbacksAndMessages(null);}}
    }
    // A narrow bridge for the core's timezone formatToParts calls. This is not a
    // general Intl polyfill; Java's installed tzdb supplies IANA/DST conversion.
    private static final java.util.LinkedHashMap<String,ZoneId> TIMEZONES=new java.util.LinkedHashMap<>(32,0.75f,true);
    private static ZoneId timezone(String original){
        // Keep exact Java zone/offset behavior for unusual IDs without caching
        // unbounded keys. Invalid identifiers retain ZoneId's explicit error.
        if(original==null||original.length()>128)return ZoneId.of(original);
        // Intl zone identifiers fold ASCII case, not Unicode lookalikes.
        for(int i=0;i<original.length();i++)if(original.charAt(i)>127)return ZoneId.of(original);
        String key=original.toLowerCase(Locale.ROOT);
        synchronized(TIMEZONES){
            ZoneId cached=TIMEZONES.get(key);if(cached!=null)return cached;
            ZoneId zone;
            try{zone=ZoneId.of(original);}catch(DateTimeException invalid){
                String canonical=null;for(String id:ZoneId.getAvailableZoneIds())if(id.toLowerCase(Locale.ROOT).equals(key)){canonical=id;break;}
                if(canonical==null)throw invalid;zone=ZoneId.of(canonical);
            }
            TIMEZONES.put(key,zone);if(TIMEZONES.size()>32)TIMEZONES.remove(TIMEZONES.keySet().iterator().next());return zone;
        }
    }
    public static String zonedParts(long time,String timezone) throws JSONException {
        ZonedDateTime z=Instant.ofEpochMilli(time).atZone(timezone(timezone));
        String[] names={"year","month","day","hour","minute","second"};int[] values={z.getYear(),z.getMonthValue(),z.getDayOfMonth(),z.getHour(),z.getMinute(),z.getSecond()};JSONArray parts=new JSONArray();
        for(int i=0;i<names.length;i++)parts.put(new JSONObject().put("type",names[i]).put("value",String.format(Locale.ROOT,i==0?"%04d":"%02d",values[i])));return parts.toString();
    }
}
