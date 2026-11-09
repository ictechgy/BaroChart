package kr.coden.barochart;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.Debug;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.Locale;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Objects;

/** Native QuickJS/Rust JNI host, owned by one thread. No WebView or browser. */
public final class BaroChartEngine implements AutoCloseable {
    static {System.loadLibrary("barochart");}
    private static final int MAX_TYPED_BARS_BUFFER_CHARS=65536;
    /** 내부 코어 선택 훅. 공개 API 기본값은 항상 JAVASCRIPT다. */
    enum RuntimeBackend { JAVASCRIPT, RUST }
    private static volatile EngineBackend defaultBackend = EngineBackend.JAVASCRIPT;
    /** Selects the backend used by legacy constructors. */
    public static void setDefaultBackend(@androidx.annotation.NonNull EngineBackend backend) { defaultBackend=Objects.requireNonNull(backend,"backend"); }
    /** Returns the backend used by legacy constructors. */
    @androidx.annotation.NonNull public static EngineBackend getDefaultBackend() { return defaultBackend; }
    private static RuntimeBackend runtimeBackend(@androidx.annotation.NonNull EngineBackend backend) {
        switch(Objects.requireNonNull(backend,"backend")) {case JAVASCRIPT:return RuntimeBackend.JAVASCRIPT;case RUST:return RuntimeBackend.RUST;default:throw new AssertionError(backend);}
    }
    private static EngineBackend publicBackend(RuntimeBackend backend) {return backend==RuntimeBackend.RUST?EngineBackend.RUST:EngineBackend.JAVASCRIPT;}
    private long handle;
    private final String sourceBundle;
    private final RuntimeBackend runtimeBackend;
    private final EngineBackend backend;
    private final Thread owner=Thread.currentThread();
    private StringBuilder typedBarsBuffer;
    private boolean encodingTypedBars;
    private final java.util.Set<Runnable> observers=new java.util.LinkedHashSet<>();
    private final java.util.Set<Runnable> closeObservers=new java.util.LinkedHashSet<>();
    private boolean closing=false;
    private WorkspaceJob activeWorkspace;
    private ParamsJob activeParams;
    private long revision=0;
    private int pendingNotifications=0;private boolean notifying=false;
    private final java.util.List<Throwable> observerErrors=new java.util.ArrayList<>();
    /**
     * Optional hook called with each exception thrown by a change listener or async callback; failures of the hook
     * itself are recorded too. Set to {@code null} to disable it. Cleared by {@link #close()}.
     */
    public java.util.function.Consumer<Throwable> onObserverError;
    private static native long create(String source);
    private static native long createRust();
    private static native String call(long handle,String name,String arguments);
    private static native Object[] packet(long handle,String mode,String token,double width,double height,boolean force);
    private static native void free(long handle);
    private static native byte[] readBuffer(long handle,long ticket,int slot,int offset,int count);
    private static native void writeBuffer(long handle,int slot,int offset,byte[] bytes);
    private static native long memoryUsed(long handle);
    private static native long memoryPeak(long handle);
    private static native long[] memoryStats(long handle);
    private static native byte[] indicatorSlice(long handle,String id,String output,int offset,int count);
    /**
     * 테스트 전용 추적 훅(package-private, 설계 §6.5-1·§7.3). 디렉터리를 정하면 그 뒤에 만드는 코어 런타임마다 그 디렉터리에
     * BCJSON 추적 파일 runtime-&lt;n&gt;.jsonl을 쓴다(n은 1부터, 정할 때마다 다시 센다). null(기본값)이면 끄고 아무 파일도 만들지 않는다.
     * 끄거나 바꾸면 이전에 만든 런타임의 기록도 그 자리에서 멈춘다.
     * @param directory 추적 디렉터리, 끄려면 null
     */
    static void setTraceDirectoryForTesting(File directory){BaroChartTrace.setDirectory(directory);}
    /**
     * 선택한 코어 런타임 하나를 만든다. JNI create/createRust를 부르는 곳은 이 함수 하나다: 엔진 생성자,
     * 작업공간 복원·params·비동기 준비 대상 생성(설계 §4.4). 격리 런타임도 원본과 같은 backend을 쓴다.
     * 추적이 켜져 있으면 새 런타임에 추적 파일을 붙인다.
     * @param bundle JavaScript 코어 번들 원문; Rust는 null
     * @param backend 생성할 코어 backend
     * @return 새 런타임 핸들(호출자가 free로 해제한다)
     */
    static long createRuntime(String bundle,RuntimeBackend backend){long runtime=backend==RuntimeBackend.RUST?createRust():create(bundle);BaroChartTrace.runtimeCreated(runtime);return runtime;}
    /**
     * 런타임의 전역 함수 하나를 JSON 인자 글자로 부른다. 코어를 JSON으로 부르는 JNI call은 모두 이 함수만 거친다.
     * 추적이 켜진 런타임이면 호출과 결과(또는 JNI가 던진 오류)를 한 줄로 남기고, 꺼져 있으면 JNI call을 그대로 부른다.
     * @param runtime 런타임 핸들
     * @param name 전역 함수 이름
     * @param arguments 인자 JSON 배열 글자
     * @return 결과 JSON 글자
     */
    private static String callRuntime(long runtime,String name,String arguments){
        BaroChartTrace.Recorder trace=BaroChartTrace.recorder(runtime);if(trace==null)return call(runtime,name,arguments);
        String result;try{result=call(runtime,name,arguments);}catch(RuntimeException|Error error){trace.threw(name,arguments,error);throw error;}
        trace.returned(name,arguments,result);return result;
    }
    /** 호스트 컨테이너 하나의 반복형 깊이 검사 프레임. */
    private static final class ArgumentFrame {
        final Object value;final Iterator<?> children;final int depth;int height=1;
        ArgumentFrame(Object value,Iterator<?> children,int depth){this.value=value;this.children=children;this.depth=depth;}
    }
    /** JSON으로 값 복사하는 컨테이너인지 본다. 사용자 equals/hashCode는 호출하지 않는다. */
    private static boolean argumentContainer(Object value){return value instanceof JSONObject||value instanceof JSONArray||value instanceof Map||value instanceof Collection||value!=null&&value.getClass().isArray();}
    /** 다음 자식만 읽어 폭이 큰 배열도 순회 스택에 전부 복사하지 않는다. */
    private static Iterator<?> argumentChildren(Object value){
        if(value instanceof JSONObject){JSONObject object=(JSONObject)value;Iterator<String> keys=object.keys();return new Iterator<Object>(){public boolean hasNext(){return keys.hasNext();}public Object next(){return object.opt(keys.next());}};}
        if(value instanceof JSONArray){JSONArray array=(JSONArray)value;return new Iterator<Object>(){int index;public boolean hasNext(){return index<array.length();}public Object next(){return array.opt(index++);}};}
        if(value instanceof Map)return ((Map<?,?>)value).values().iterator();
        if(value instanceof Collection)return ((Collection<?>)value).iterator();
        if(value.getClass().getComponentType().isPrimitive())return Collections.emptyIterator();
        return new Iterator<Object>(){int index;final int length=java.lang.reflect.Array.getLength(value);public boolean hasNext(){return index<length;}public Object next(){return java.lang.reflect.Array.get(value,index++);}};
    }
    /** JSONArray의 재귀 직렬화 전에 깊이를 제한한다. 인자 배열이 깊이 1이며 참조별 부분 트리 높이로 공유/순환도 처리한다. */
    private static void assertArgumentDepth(Object[] args){
        if(args==null)return; // null의 기존 JSONArray 오류는 직렬화 경로에 맡긴다.
        ArrayDeque<ArgumentFrame> frames=new ArrayDeque<>();frames.push(new ArgumentFrame(args,Arrays.asList(args).iterator(),1));
        IdentityHashMap<Object,Boolean> active=new IdentityHashMap<>();active.put(args,true);
        IdentityHashMap<Object,Integer> completed=new IdentityHashMap<>();
        while(!frames.isEmpty()){
            ArgumentFrame frame=frames.peek();
            if(!frame.children.hasNext()){
                frames.pop();active.remove(frame.value);completed.put(frame.value,frame.height);
                if(!frames.isEmpty())frames.peek().height=Math.max(frames.peek().height,frame.height+1);
                continue;
            }
            Object value=frame.children.next();if(!argumentContainer(value))continue;
            int depth=frame.depth+1;
            if(depth>64||active.containsKey(value))throw new IllegalStateException("SyntaxError: Native argument depth limit");
            Integer height=completed.get(value);
            if(height!=null){if(depth+height-1>64)throw new IllegalStateException("SyntaxError: Native argument depth limit");frame.height=Math.max(frame.height,height+1);continue;}
            active.put(value,true);frames.push(new ArgumentFrame(value,argumentChildren(value),depth));
        }
    }
    /** 검증한 인자를 기존 org.json 변환 규칙으로 감싼다. */
    private static JSONArray argumentsArray(Object[] args)throws JSONException{assertArgumentDepth(args);return new JSONArray(args);}
    /** JNI로 넘길 인자 JSON. 검사 뒤에 직렬화해 깊은 Java 컬렉션/순환이 먼저 스택을 넘지 않게 한다. */
    private static String argumentsJSON(Object[] args)throws JSONException{return argumentsArray(args).toString();}
    private AsyncJob activeJob;
    /**
     * Creates an engine with the labeled demonstration chart, owned by the calling thread. Prefer {@link
     * #create(Context, EngineOptions)} in apps.
     * @param context used to read the bundled core asset
     * @param count number of demonstration bars; 0 creates an engine without bars
     * @throws IOException if the bundled {@code aster-core.js} asset cannot be read
     * @throws JSONException if the core rejects the initialization
     */
    public BaroChartEngine(Context context,int count) throws IOException,JSONException {this(context,count,null,runtimeBackend(getDefaultBackend()));}
    /**
     * Creates an engine owned by the calling thread. Engines attached to a view must be created on the main thread.
     * @param context used to read the bundled core asset
     * @param count number of demonstration bars; 0 creates an engine without bars
     * @param options initial layout options as core JSON, or {@code null} for the default layout
     * @throws IOException if the bundled {@code aster-core.js} asset cannot be read
     * @throws JSONException if the core rejects the options
     */
    public BaroChartEngine(Context context,int count,JSONObject options) throws IOException,JSONException {this(context,count,options,runtimeBackend(getDefaultBackend()));}
    /** 테스트와 같은-backend 격리 런타임이 쓰는 내부 생성자다. */
    BaroChartEngine(Context context,int count,JSONObject options,RuntimeBackend backend) throws IOException,JSONException {
        if(backend==null)throw new IllegalArgumentException("Runtime backend required");runtimeBackend=backend;
        this.backend=publicBackend(backend);
        if(backend==RuntimeBackend.RUST&&!BuildConfig.BAROCHART_WITH_RUST)throw new IllegalStateException("UnavailableError: rust backend is not included in this build");
        if(backend==RuntimeBackend.JAVASCRIPT&&BuildConfig.BAROCHART_WITH_QUICKJS){try(InputStream in=context.getAssets().open("aster-core.js")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int size;while((size=in.read(buffer))!=-1)out.write(buffer,0,size);sourceBundle=new String(out.toByteArray(),StandardCharsets.UTF_8);}}
        else sourceBundle=null;
        handle=createRuntime(sourceBundle,backend);
        try {invoke("nativeInit",count,options==null?JSONObject.NULL:options);}catch(JSONException|RuntimeException|Error error){long released=handle;handle=0;try{free(released);}catch(Throwable cleanup){if(cleanup!=error)error.addSuppressed(cleanup);}throw error;}
    }
    private void check(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Use the engine on its owning thread before close");if(activeWorkspace!=null&&activeWorkspace.job.pendingOwnerCleanup())activeWorkspace.job.resumeOwnerCleanup();if(activeParams!=null&&activeParams.job.pendingOwnerCleanup())activeParams.job.resumeOwnerCleanup();if(handle==0)throw new IllegalStateException("Engine closed");if(closing)throw new IllegalStateException("Engine closing");}
    private void checkCleanup(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Use the engine on its owning thread before close");if(!closing){if(activeWorkspace!=null&&activeWorkspace.job.pendingOwnerCleanup())activeWorkspace.job.resumeOwnerCleanup();if(activeParams!=null&&activeParams.job.pendingOwnerCleanup())activeParams.job.resumeOwnerCleanup();}if(handle==0)throw new IllegalStateException("Engine closed");}
    /**
     * Calls a chart core function by name with JSON-encoded arguments. Advanced API that may change within 1.x. Call
     * on the engine's owner thread.
     * @param name core function name, 1 to 128 characters
     * @param args arguments, at most 16
     * @return the decoded JSON result
     * @throws JSONException if the arguments cannot be encoded or the core returns invalid JSON
     */
    public Object invoke(String name,Object... args) throws JSONException {check();if(name==null||name.length()==0||name.length()>128||args.length>16)throw new IllegalArgumentException("Native function name/argument limit");String arguments=argumentsJSON(args);check();return new JSONArray("["+callRuntime(handle,name,arguments)+"]").get(0);}
    /** Calls a native function with an already encoded fixed-shape argument array. */
    private Object invokeEncoded(String name,String arguments) throws JSONException {check();return new JSONArray("["+callRuntime(handle,name,arguments)+"]").get(0);}
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
        check();String arguments=argumentsJSON(args);long start=System.nanoTime();
        String returned=callRuntime(handle,name,arguments);long afterJNI=System.nanoTime();
        String body=(String)new JSONArray("["+returned+"]").get(0);long afterEnvelope=System.nanoTime();
        JSONObject scene=new JSONObject(body);long afterBody=System.nanoTime();
        sceneTiming=new SceneTiming(afterJNI-start,afterEnvelope-afterJNI,afterBody-afterEnvelope,body.length());return scene;
    }
    /**
     * Builds the current scene as JSON for a view of the given size. Advanced API that may change within 1.x. Call on
     * the engine's owner thread.
     * @param width view width
     * @param height view height
     * @return the scene JSON
     * @throws JSONException if the core fails or returns an invalid scene
     */
    public JSONObject scene(double width,double height) throws JSONException {return sceneJSON("nativeSceneJSON",width,height);}
    JSONObject renderFrame(String token,double width,double height,boolean force) throws JSONException {return sceneJSON("nativeRenderFrameJSON",token,width,height,force);}
    ScenePacket scenePacket(String mode,String token,double width,double height,boolean force)throws JSONException {
        check();BaroChartTrace.typedTransfer(handle,"nativeScenePacket");long start=System.nanoTime();Object[] transfer=packet(handle,mode,token,width,height,force);long afterJNI=System.nanoTime();
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
        /**
         * Stable error code from the core ingestion session, for example {@code BUSY} while an asynchronous
         * calculation is active.
         */
        public final String code;
        /**
         * Creates an ingestion error.
         * @param code stable error code
         * @param message description of the failure
         */
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
    /**
     * Runs a core command by name and notifies change listeners when the command changes the chart. Read-only
     * commands do not notify. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param operation core command name
     * @param args command arguments
     * @return the decoded command result
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public Object command(String operation,Object... args) throws JSONException {
        check();Object result;
        // Cover the deferred begin gap as well as core's active ingestion lease.
        if("compactData".equals(operation)&&(activeJob!=null&&!activeJob.committed||activeWorkspace!=null||activeParams!=null))throw new IngestionException("BUSY","Compaction has an active asynchronous calculation");
        if(ingestionCommand(operation)){
            if((activeJob!=null&&!activeJob.committed||activeWorkspace!=null&&!activeWorkspace.job.committed()||activeParams!=null&&!activeParams.job.committed())&&!operation.equals("dataIngestionStats")&&!operation.equals("saveDataIngestion"))throw new IngestionException("BUSY","Data ingestion has an active asynchronous calculation");
            JSONObject envelope=(JSONObject)invoke("nativeDataIngestionCommand",operation,argumentsArray(args));
            result=ingestionResult(envelope);
        }else result=invoke("nativeCommand",operation,argumentsArray(args));
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
    private void notifyChanges(){revision++;pendingNotifications++;if(notifying)return;notifying=true;observerErrors.clear();try{while(pendingNotifications>0){pendingNotifications--;for(Runnable observer:new java.util.ArrayList<>(observers)){try{observer.run();}catch(RuntimeException error){recordObserverFailure(error);}}}}finally{notifying=false;}}
    /** 관찰자 실패를 최대 32개까지 남기고 앱의 onObserverError 훅에 알린다(훅 실패도 기록) */
    private void recordObserverFailure(RuntimeException error){if(observerErrors.size()<32)observerErrors.add(error);try{if(onObserverError!=null)onObserverError.accept(error);}catch(RuntimeException reporting){if(observerErrors.size()<32)observerErrors.add(reporting);}}
    /**
     * Returns the failures recorded from change listeners and async callbacks, at most 32. The list is cleared when a
     * new notification round starts and on {@link #close()}. Call on the engine's owner thread.
     * @return a copy of the recorded failures
     */
    public java.util.List<Throwable> observerErrors(){check();return new java.util.ArrayList<>(observerErrors);}
    /**
     * Returns the host revision, which increases each time change listeners are notified. Read-only commands do not
     * change it. Call on the engine's owner thread.
     * @return the revision counter
     */
    public long revision(){check();return revision;}
    /**
     * Returns selected-core memory and shared native handle counters for diagnostics. Advanced API that may change within 1.x.
     * Call on the engine's owner thread.
     * @return the counters as JSON
     * @throws JSONException if the metrics cannot be encoded
     */
    public JSONObject runtimeMetrics() throws JSONException {check();long[] stats=memoryStats(handle);String scope=runtimeBackend==RuntimeBackend.RUST?"Rust engine accounted requested bytes for owned payloads, call temporaries and FFI outputs; not allocator RSS; live handle counts include all engines of both backends and current isolated workers in this process":"QuickJS requested bytes including aligned allocator headers; live handle counts include all engines and current isolated workers in this process";return new JSONObject().put("requestedLiveBytes",stats[0]).put("requestedPeakBytes",stats[1]).put("processLiveNativeHandles",stats[2]).put("processNativeHandlesCreated",stats[3]).put("processNativeHandlesFreed",stats[4]).put("scope",scope);}
    /** Returns this engine's immutable backend selection, even after close. */
    @androidx.annotation.NonNull public EngineBackend backend() { return backend; }
    byte[] indicatorBytes(String id,String output,int offset,int count){check();if(id==null||output==null||id.length()>128||output.length()>128||offset<0||count<1||count>262144)throw new IllegalArgumentException("Indicator byte slice limits");BaroChartTrace.typedTransfer(handle,"nativeIndicatorBuffer");return indicatorSlice(handle,id,output,offset,count);}
    /**
     * Registers a listener run after each chart change. A {@code RuntimeException} it throws is recorded in {@link
     * #observerErrors()} and does not stop other listeners. Call on the engine's owner thread.
     * @param observer the listener to add
     */
    public void addChangeListener(Runnable observer){check();observers.add(observer);}
    /**
     * Removes a change listener; unknown listeners are ignored. Call on the engine's owner thread.
     * @param observer the listener to remove
     */
    public void removeChangeListener(Runnable observer){if(Thread.currentThread()!=owner)throw new IllegalStateException("Remove listener on owning thread");observers.remove(observer);}
    /**
     * Replaces every bar from a JSON array of bar objects with {@code time}, {@code open}, {@code high}, {@code low},
     * {@code close} and {@code volume}. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param bars the bars as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setData(JSONArray bars) throws JSONException {command("setData",bars);}
    /**
     * Replaces every bar from column-oriented JSON. Advanced API that may change within 1.x. Call on the engine's
     * owner thread.
     * @param columns the bar columns as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setColumns(JSONObject columns) throws JSONException {command("setColumns",columns);}
    /**
     * Applies one data event given as JSON, with {@code kind} and the matching {@code bar}, {@code bars} or {@code
     * events}. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param event the event as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void applyDataEvent(JSONObject event) throws JSONException {command("applyDataEvent",event);}
    /**
     * Atomic, explicitly ordered burst; legacy scalar errors remain unchanged.
     * @param events the events as a JSON array, applied in order
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
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
    /**
     * Opt-in exact final-value deduplication. False preserves the legacy path.
     * A failed true-path response can follow commit: do not automatically retry.
     * @param events the events as a JSON array, applied in order
     * @param skipUnchanged true to skip publishing when the final values equal the current bars; false behaves like
     *     {@link #applyDataEvents(JSONArray)}
     * @return the core receipt as JSON; with {@code skipUnchanged} it has an {@code unchanged} flag
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
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
    /**
     * Synchronous retained-window maintenance. Requires explicit studyHistory:"restart".
     * Pause/drain upstream first; large copies can block the owner thread.
     * A zero-removal receipt changes neither host revision nor notifications.
     * Transport/receipt failure after native execution does not prove rollback.
     * @param options compaction options as JSON; {@code studyHistory} must be {@code restart}
     * @return the core receipt as JSON, with the number of removed bars in {@code removed}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject compactData(JSONObject options) throws JSONException {return (JSONObject)command("compactData",options);}
    /**
     * Raw-coordinate group edit with one core undo. Zero changes do not notify.
     * Receipt/transport failure after execution does not imply rollback.
     * @param ids ids of the drawings to move
     * @param deltaTimeMs time offset in milliseconds, added to every anchor
     * @param deltaPrice price offset, added to every anchor
     * @return the core receipt as JSON, with the number of changed drawings in {@code changed}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject translateDrawings(JSONArray ids,double deltaTimeMs,double deltaPrice) throws JSONException {
        JSONObject options=new JSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice);
        return (JSONObject)command("translateDrawings",ids,options);
    }
    /**
     * Partial portable style merge, one core undo; zero stored changes do not notify.
     * Receipt/transport failure after execution does not imply rollback.
     * @param ids ids of the drawings to restyle
     * @param patch style fields to merge, as JSON
     * @return the core receipt as JSON, with the number of changed drawings in {@code changed}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject setDrawingsStyle(JSONArray ids,JSONObject patch) throws JSONException {return (JSONObject)command("setDrawingsStyle",ids,patch);}
    /**
     * Presentation-only visibility may change locked drawings. Active gestures reject.
     * @param id id of the drawing
     * @param visible true to show the drawing, false to hide it
     * @return the core receipt as JSON, with the number of changed drawings in {@code changed}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject setDrawingVisibility(String id,boolean visible) throws JSONException {return (JSONObject)command("setDrawingVisibility",id,visible);}
    /**
     * Shows or hides several drawings at once; like {@link #setDrawingVisibility(String, boolean)} it is
     * presentation-only. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param ids ids of the drawings
     * @param visible true to show the drawings, false to hide them
     * @return the core receipt as JSON, with the number of changed drawings in {@code changed}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject setDrawingsVisibility(JSONArray ids,boolean visible) throws JSONException {return (JSONObject)command("setDrawingsVisibility",ids,visible);}
    /**
     * Chart-local unlocked copies; explicit raw offsets and one atomic core undo.
     * @param id id of the drawing to copy
     * @param deltaTimeMs time offset in milliseconds
     * @param deltaPrice price offset
     * @return the core receipt as JSON, with {@code changed} and the {@code created} source and new ids
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject duplicateDrawing(String id,double deltaTimeMs,double deltaPrice) throws JSONException {return (JSONObject)command("duplicateDrawing",id,new JSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice));}
    /**
     * Copies several drawings as unlocked chart-local drawings with explicit raw offsets and one atomic core undo.
     * Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param ids ids of the drawings to copy
     * @param deltaTimeMs time offset in milliseconds
     * @param deltaPrice price offset
     * @return the core receipt as JSON, with {@code changed} and the {@code created} source and new ids
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject duplicateDrawings(JSONArray ids,double deltaTimeMs,double deltaPrice) throws JSONException {return (JSONObject)command("duplicateDrawings",ids,new JSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice));}
    /**
     * Explicit group deletion with one core undo. Empty/missing/locked IDs reject.
     * @param ids ids of the drawings to delete
     * @return the core receipt as JSON, with the number of deleted drawings in {@code changed}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject deleteDrawings(JSONArray ids) throws JSONException {return (JSONObject)command("deleteDrawings",ids);}
    /**
     * Configures the core-owned data ingestion queue. Throws {@link IngestionException} for stable queue errors and
     * while an async calculation is active. Advanced API that may change within 1.x. Call on the engine's owner
     * thread.
     * @param policy queue policy as JSON, such as {@code streamId}, {@code generation}, {@code firstSequence} and the
     *     queue and store limits
     * @return the ingestion statistics as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject configureDataIngestion(JSONObject policy) throws JSONException {return (JSONObject)command("configureDataIngestion",policy);}
    /**
     * Adds an ordered packet of data events to the ingestion queue. Advanced API that may change within 1.x. Call on
     * the engine's owner thread.
     * @param packet the packet as JSON, with {@code streamId}, {@code generation}, {@code firstSequence} and {@code
     *     events}
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject enqueueDataEvents(JSONObject packet) throws JSONException {return (JSONObject)command("enqueueDataEvents",packet);}
    /**
     * Applies queued events, up to the configured batch size. The host chooses when to drain. Advanced API that may
     * change within 1.x. Call on the engine's owner thread.
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject drainDataEvents() throws JSONException {return (JSONObject)command("drainDataEvents");}
    /**
     * Applies up to {@code maxEvents} queued events. The host chooses when to drain. Advanced API that may change
     * within 1.x. Call on the engine's owner thread.
     * @param maxEvents maximum number of events to apply, at most the configured batch size
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject drainDataEvents(int maxEvents) throws JSONException {return (JSONObject)command("drainDataEvents",maxEvents);}
    /**
     * Pauses data ingestion. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @return the ingestion statistics as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject pauseDataIngestion() throws JSONException {return (JSONObject)command("pauseDataIngestion");}
    /**
     * Resumes paused data ingestion. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @return the ingestion statistics as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject resumeDataIngestion() throws JSONException {return (JSONObject)command("resumeDataIngestion");}
    /**
     * Discards the queued events that have not been applied. Advanced API that may change within 1.x. Call on the
     * engine's owner thread.
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject cancelDataEvents() throws JSONException {return (JSONObject)command("cancelDataEvents");}
    /**
     * Reads the ingestion queue statistics without changing the chart. Advanced API that may change within 1.x. Call
     * on the engine's owner thread.
     * @return the statistics as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject dataIngestionStats() throws JSONException {return (JSONObject)command("dataIngestionStats");}
    /**
     * Saves the ingestion session state as text. Advanced API that may change within 1.x. Call on the engine's owner
     * thread.
     * @return the saved state
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public String saveDataIngestion() throws JSONException {return (String)command("saveDataIngestion");}
    /**
     * Restores ingestion session state saved with {@link #saveDataIngestion()}. Advanced API that may change within
     * 1.x. Call on the engine's owner thread.
     * @param text the saved state
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject loadDataIngestion(String text) throws JSONException {return (JSONObject)command("loadDataIngestion",text);}
    /**
     * Layout-independent readout; null means no available selected row.
     * @param query the row to read, by {@code index} or {@code time}, as JSON
     * @return the readout as JSON, or {@code null} when no row is available
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject dataAt(JSONObject query) throws JSONException {return dataAt(query,new JSONObject());}
    /**
     * Reads the values at a bar; like {@link #dataAt(JSONObject)} with options. Advanced API that may change within
     * 1.x. Call on the engine's owner thread.
     * @param query the row to read, by {@code index} or {@code time}, as JSON
     * @param options read options as JSON, such as {@code asOfIndex} and {@code includeHidden}
     * @return the readout as JSON, or {@code null} when no row is available
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
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
    /**
     * Turns data exploration on or off; it is off by default. Advanced API that may change within 1.x. Call on the
     * engine's owner thread.
     * @param active true to enable exploration, false to disable it
     * @return the exploration state as JSON
     * @throws JSONException if the core rejects the request
     */
    public JSONObject setDataExploration(boolean active) throws JSONException {return dataExploration("setActive",active);}
    /**
     * Moves the exploration selection. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param key one of {@code ArrowLeft}, {@code ArrowRight}, {@code ArrowUp}, {@code ArrowDown}, {@code Home} or
     *     {@code End}
     * @return the exploration state as JSON
     * @throws JSONException if the core rejects the request
     */
    public JSONObject navigateDataExploration(String key) throws JSONException {return dataExploration("navigate",key);}
    /**
     * Reconciles the exploration selection with the stored bars and visible series, without reading values. Advanced
     * API that may change within 1.x. Call on the engine's owner thread.
     * @return the exploration state as JSON
     * @throws JSONException if the core rejects the request
     */
    public JSONObject refreshDataExploration() throws JSONException {return dataExploration("refresh",JSONObject.NULL);}
    /**
     * May synchronously calculate every visible dirty indicator through dataAt.
     * @return the exploration state as JSON, with the readout text
     * @throws JSONException if the core rejects the request
     */
    public JSONObject readDataExploration() throws JSONException {return dataExploration("read",JSONObject.NULL);}
    /**
     * Adds a panel from core options. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param options panel options as JSON, such as {@code id}, {@code weight} and {@code label}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void addPanel(JSONObject options) throws JSONException {command("addPanel",options);}
    /**
     * Changes a panel. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param id panel id
     * @param patch panel fields to change, as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setPanel(String id,JSONObject patch) throws JSONException {command("setPanel",id,patch);}
    /**
     * Adds a series from core options. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param options series options as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void addSeries(JSONObject options) throws JSONException {command("addSeries",options);}
    /**
     * Changes a series. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param id series id
     * @param patch series fields to change, as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setSeries(String id,JSONObject patch) throws JSONException {command("setSeries",id,patch);}
    /**
     * Sets externally supplied values for a series. Advanced API that may change within 1.x. Call on the engine's
     * owner thread.
     * @param id series id
     * @param values the values as a JSON array
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setSeriesValues(String id,JSONArray values) throws JSONException {command("setSeriesValues",id,values);}
    /**
     * Removes a series. Throws {@link BaroChartException}.
     * @param id series id
     */
    public void removeSeries(String id){typed(()->command("removeSeries",id));}
    /**
     * Adds an indicator under an id. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param id id for the indicator
     * @param name core indicator name, see {@link IndicatorKind#wireName()}
     * @param params parameters as JSON
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject addIndicator(String id,String name,JSONObject params) throws JSONException {return (JSONObject)command("addIndicator",id,name,params);}
    /**
     * Replaces indicator parameters synchronously. Advanced API that may change within 1.x. Call on the engine's
     * owner thread.
     * @param id indicator id
     * @param params parameters as JSON
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject setIndicatorParams(String id,JSONObject params) throws JSONException {return (JSONObject)command("setIndicatorParams",id,params);}
    /**
     * Removes an indicator. Throws {@link BaroChartException}.
     * @param id indicator id
     */
    public void removeIndicator(String id){typed(()->command("removeIndicator",id));}
    /**
     * Registers a custom indicator from source text and notifies change listeners. Pass only source you trust.
     * Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param name name for the indicator
     * @param source the indicator source
     * @throws JSONException if the core rejects the source
     */
    public void registerIndicatorSource(String name,String source) throws JSONException {invoke("nativeRegisterIndicatorSource",name,source);notifyChanges();}
    /**
     * Registers application-linked exports; no source evaluation or URL loading.
     * @param id module id
     * @param version module version
     * @return the registration result as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONArray registerIndicatorModule(String id,int version) throws JSONException {return (JSONArray)command("registerIndicatorModule",id,version);}
    /**
     * Definitions and related series only; data/layout/drawing state are host-owned.
     * @return the saved studies document as text
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public String saveStudies() throws JSONException {return (String)command("saveStudies");}
    /**
     * Bounded portable metadata only. Synchronous owner-thread read; no redraw/revision notification.
     * @param datasetBinding the dataset binding as JSON, with {@code key}, {@code revision}, {@code
     *     adjustmentVersion}, {@code priceUnit} and {@code adjustment}
     * @return the workspace document as text
     * @throws JSONException if the core cannot save the workspace
     */
    public String saveWorkspace(JSONObject datasetBinding) throws JSONException {
        Object result=invoke("nativeSaveWorkspace",datasetBinding);
        if(!(result instanceof String))throw new JSONException("Workspace document string required");
        return (String)result;
    }
    /**
     * Validated-only metadata/source assertion. Does not calculate, restore, reserve a job or swap context.
     * @param document a workspace document as text
     * @param datasetBinding the dataset binding as JSON
     * @return the preflight receipt as JSON
     * @throws JSONException if the document or binding is rejected
     */
    public JSONObject preflightWorkspace(String document,JSONObject datasetBinding) throws JSONException {
        Object result=invoke("nativePreflightWorkspace",document,datasetBinding);
        if(!(result instanceof JSONObject))throw new JSONException("Workspace preflight receipt required");
        return (JSONObject)result;
    }

    /**
     * Atomic additive merge; required panels/axes must exist, duplicate IDs reject.
     * @param text a document saved with {@link #saveStudies()}
     * @return the core receipt as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject loadStudies(String text) throws JSONException {return (JSONObject)command("loadStudies",text);}
    /**
     * Reads one indicator output at a bar index. Advanced API that may change within 1.x. Call on the engine's owner
     * thread.
     * @param id indicator id
     * @param output output name
     * @param index bar index
     * @return the value as JSON; unknown {@code value}, {@code sourceIndex} and {@code sourceTime} are {@code
     *     JSONObject.NULL}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject indicatorValueAt(String id,String output,int index) throws JSONException {return indicatorValueAt(id,output,index,null);}
    /**
     * mode raw/plot; asOfIndex hides unavailable value/sourceIndex/sourceTime.
     * @param id indicator id
     * @param output output name
     * @param index bar index
     * @param options read options as JSON, or {@code null} for none
     * @return the value as JSON; unknown {@code value}, {@code sourceIndex} and {@code sourceTime} are {@code
     *     JSONObject.NULL}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject indicatorValueAt(String id,String output,int index,JSONObject options) throws JSONException {return (JSONObject)command("indicatorValueAt",id,output,index,options==null?new JSONObject():options);}
    /**
     * Adds a drawing from core options. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param options drawing options as JSON
     * @return the id of the new drawing
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public String addDrawing(JSONObject options) throws JSONException {return (String)command("addDrawing",options);}
    /**
     * Raw annotation metrics only; no source or indicator calculation and no notification.
     * @param id id of a position drawing
     * @return the metrics as JSON
     * @throws JSONException if the core rejects the request
     */
    public JSONObject positionMetrics(String id) throws JSONException {
        Object result=command("positionMetrics",id);if(!(result instanceof JSONObject))throw new JSONException("Position metrics receipt");return (JSONObject)result;
    }
    /**
     * Changes a drawing. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param id drawing id
     * @param patch drawing fields to change, as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void editDrawing(String id,JSONObject patch) throws JSONException {command("editDrawing",id,patch);}
    /**
     * Deletes one drawing. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param id drawing id
     * @return {@code true} if a drawing was removed; {@code false} if no drawing matched
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public boolean deleteDrawing(String id) throws JSONException {return (Boolean)command("deleteDrawing",id);}
    /**
     * Selects a drawing by id, or clears the selection with {@code null}. Throws {@link BaroChartException}.
     * @param id drawing id, or {@code null} to clear the selection
     */
    public void selectDrawing(String id){typed(()->command("selectDrawing",id));}
    /**
     * Changes the chart theme. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param patch theme fields to change, as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setTheme(JSONObject patch) throws JSONException {command("setTheme",patch);}
    /**
     * Sets instrument metadata from JSON. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param symbol the symbol as JSON
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setSymbol(JSONObject symbol) throws JSONException {command("setSymbol",symbol);}
    /**
     * Configures pointer crosshair snapping. Advanced API that may change within 1.x. Call on the engine's owner
     * thread.
     * @param options snap options as JSON, such as {@code mode}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setCrosshairSnap(JSONObject options) throws JSONException {command("setCrosshairSnap",options);}
    /**
     * Fresh layout may calculate dirty studies; read-only, no change notification.
     * @param width view width
     * @param height view height
     * @return the snapshot as JSON, or {@code null} when there is no crosshair
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public JSONObject crosshairSnapshot(double width,double height) throws JSONException {
        Object result=command("crosshairSnapshot",width,height);if(result==JSONObject.NULL)return null;
        if(!(result instanceof JSONObject))throw new JSONException("Crosshair snapshot object receipt");return (JSONObject)result;
    }
    /**
     * Configures the drawing magnet. Advanced API that may change within 1.x. Call on the engine's owner thread.
     * @param options magnet options as JSON, such as {@code mode} and {@code radiusPx}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setDrawingMagnet(JSONObject options) throws JSONException {command("setDrawingMagnet",options);}
    /**
     * Selects the active tool by core name. Advanced API that may change within 1.x. Call on the engine's owner
     * thread.
     * @param tool tool name, see {@link DrawingTool#wireName()}
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setTool(String tool) throws JSONException {command("setTool",tool);}
    /**
     * Sets the drawing text the controller uses for text drawings. Advanced API that may change within 1.x. Call on
     * the engine's owner thread.
     * @param text the text, at most 2000 characters
     * @throws JSONException if the arguments cannot be encoded or the core rejects the command
     */
    public void setText(String text) throws JSONException {command("setText",text);}
    /** Undoes the last drawing change. Throws {@link BaroChartException}. */
    public void undo(){typed(()->command("undo"));}
    /** Redoes the last undone drawing change. Throws {@link BaroChartException}. */
    public void redo(){typed(()->command("redo"));}
    /** Fits all bars into view. Throws {@link BaroChartException}. */
    public void fit(){typed(()->command("fit"));}
    /**
     * Saves drawings as a portable {@code aster.drawings} document. Throws {@link BaroChartException}.
     * @return the {@code aster.drawings} document as text
     */
    public String saveDrawings(){return typedCall(()->(String)invoke("nativeSave"));}
    /**
     * Loads an {@code aster.drawings} document. Throws {@link BaroChartException}.
     * @param text an {@code aster.drawings} document
     */
    public void loadDrawings(String text){typed(()->command("loadDrawings",text));}
    /**
     * Closes the engine and frees its native runtime. Views stop drawing it and every later typed call throws {@code
     * ENGINE_CLOSED}. Calling it again does nothing.
     * @throws BaroChartException with {@code WRONG_THREAD} when called off the thread that created the engine; the
     *     engine then stays open
     */
    @Override public void close(){
        if(Thread.currentThread()!=owner)throw new BaroChartException(BaroChartException.Code.WRONG_THREAD,"Close the engine on the thread that created it.",null,null);if(closing)return;closing=true;
        Error cleanupFailure=null;
        try{if(activeParams!=null)activeParams.job.closeOnOwner();if(activeWorkspace!=null)activeWorkspace.job.closeOnOwner();if(handle!=0){try{if(activeJob!=null)activeJob.stopOnOwner("closed");java.util.ArrayList<Runnable> cleanup=new java.util.ArrayList<>(closeObservers);closeObservers.clear();for(Runnable observer:cleanup)try{observer.run();}catch(RuntimeException observerFailure){recordObserverFailure(observerFailure);}catch(Error error){if(cleanupFailure==null)cleanupFailure=error;}}
            finally{long released=handle;ParamsJob paramsClosing=activeParams;if(paramsClosing!=null)paramsClosing.job.sourceFreeStartedOnOwner();handle=0;try{free(released);if(paramsClosing!=null)paramsClosing.job.sourceFreedOnOwner();}finally{if(activeWorkspace!=null)activeWorkspace.job.closeOnOwner();}}}if(cleanupFailure!=null)throw cleanupFailure;}
        finally{typedBarsBuffer=null;encodingTypedBars=false;closeObservers.clear();observers.clear();observerErrors.clear();onObserverError=null;closing=false;}
    }

    /** Optional isolated calculation. Synchronous API behavior is unchanged. */
    public interface AsyncListener {
        /**
         * Reports progress; the default implementation ignores it. Called on the main thread.
         * @param progress the current progress
         */
        default void onProgress(AsyncProgress progress) {}
        /**
         * Receives the final result. Called once on the main thread.
         * @param result the outcome of the calculation
         */
        void onComplete(AsyncResult result);
    }
    /** Limits for an isolated calculation. */
    public static final class AsyncOptions {
        /** Timeout for the whole calculation in milliseconds. */
        public final long timeoutMillis;
        /** Maximum number of bars processed per calculation step. */
        public final int maxBarsPerStep;
        /** Creates options with a 30,000 ms timeout and 4,096 bars per step. */
        public AsyncOptions(){this(30000,4096);}
        /**
         * Creates options.
         * @param timeoutMillis timeout in milliseconds, 1 to 600000
         * @param maxBarsPerStep bars processed per step, 1 to 16384
         * @throws IllegalArgumentException if a value is out of range
         */
        public AsyncOptions(long timeoutMillis,int maxBarsPerStep){if(timeoutMillis<1||timeoutMillis>600000||maxBarsPerStep<1||maxBarsPerStep>16384)throw new IllegalArgumentException("Async timeout/step limits");this.timeoutMillis=timeoutMillis;this.maxBarsPerStep=maxBarsPerStep;}
    }
    /** Progress of an isolated calculation. */
    public static final class AsyncProgress {
        /** Name of the current phase. */ public final String phase;/** Units of work done so far and the total number expected. */ public final long done,total;
        private AsyncProgress(String phase,long done,long total){this.phase=phase;this.done=done;this.total=total;}
    }
    /** Final result of an isolated calculation. */
    public static final class AsyncResult {
        /** Outcome such as {@code success}, {@code cancelled}, {@code timedOut}, {@code stale}, {@code failed}, {@code closed} or {@code superseded}. */ public final String status;/** The failure, or {@code null}. */ public final Throwable error;/** Timing and size metrics of the calculation. */ public final JSONObject metrics;
        private AsyncResult(String status,Throwable error,JSONObject metrics){this.status=status;this.error=error;this.metrics=metrics;}
        /**
         * Tells whether the calculation succeeded.
         * @return true when {@link #status} is {@code success}
         */
        public boolean succeeded(){return status.equals("success");}
        /**
         * Converts the result to JSON with {@code status}, {@code metrics} and, on failure, {@code error}.
         * @return the result as JSON
         * @throws JSONException if the result cannot be encoded
         */
        public JSONObject toJSON() throws JSONException {JSONObject value=new JSONObject().put("status",status).put("metrics",metrics);if(error!=null)value.put("error",error.toString());return value;}
    }
    /**
     * Applies one data event (JSON) through the isolated async path with default options. Advanced API that may
     * change within 1.x. The engine must be owned by the main thread.
     * @param event the event as JSON
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the job
     * @throws JSONException if the request cannot be encoded
     */
    public AsyncJob applyDataEventAsync(JSONObject event,AsyncListener listener) throws JSONException {return applyDataEventAsync(event,new AsyncOptions(),listener);}
    /**
     * Applies one data event (JSON) through the isolated async path. Advanced API that may change within 1.x. The
     * engine must be owned by the main thread.
     * @param event the event as JSON
     * @param options timeout and step limits
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the job
     * @throws JSONException if the request cannot be encoded
     */
    public AsyncJob applyDataEventAsync(JSONObject event,AsyncOptions options,AsyncListener listener) throws JSONException {
        checkAsyncOwner();
        if(event==null||options==null||listener==null)throw new IllegalArgumentException("Async event, options and listener required");
        // Snapshot caller-owned JSON before any worker/callback can see it.
        String eventJSON=event.toString();if(eventJSON.length()>8*1024*1024)throw new IllegalArgumentException("Async event size limit");
        return beginAsync("correction",eventJSON,null,options,listener);
    }
    /**
     * Prepares bars from an immutable column snapshot on an isolated worker, with default options. Advanced API that
     * may change within 1.x. The engine must be owned by the main thread.
     * @param columns the bar columns
     * @param visibleBars number of bars to make visible
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the job
     * @throws JSONException if the request cannot be encoded
     */
    public AsyncJob prepareColumnsAsync(BaroChartColumns columns,int visibleBars,AsyncListener listener) throws JSONException {return prepareColumnsAsync(columns,visibleBars,new AsyncOptions(),listener);}
    /**
     * Prepares bars from an immutable column snapshot on an isolated worker. Advanced API that may change within 1.x.
     * The engine must be owned by the main thread.
     * @param columns the bar columns
     * @param visibleBars number of bars to make visible
     * @param options timeout and step limits
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the job
     * @throws JSONException if the request cannot be encoded
     */
    public AsyncJob prepareColumnsAsync(BaroChartColumns columns,int visibleBars,AsyncOptions options,AsyncListener listener) throws JSONException {checkAsyncOwner();if(columns==null)throw new IllegalArgumentException("Owned columns required");visibleBars(visibleBars);return beginAsync("columns",new JSONObject().put("kind","columns").put("length",columns.length()).put("visibleBars",visibleBars).toString(),columns,options,listener);}
    /**
     * Prepares generated demonstration bars on an isolated worker, with default options. Advanced API that may change
     * within 1.x. The engine must be owned by the main thread.
     * @param count number of bars to generate
     * @param seed generator seed
     * @param visibleBars number of bars to make visible
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the job
     * @throws JSONException if the request cannot be encoded
     */
    public AsyncJob prepareSeededAsync(int count,int seed,int visibleBars,AsyncListener listener) throws JSONException {return prepareSeededAsync(count,seed,visibleBars,new AsyncOptions(),listener);}
    /**
     * Seed int represents unsigned32 bits; generation is demo data, not a feed.
     * @param count number of bars to generate
     * @param seed generator seed, treated as unsigned 32 bits
     * @param visibleBars number of bars to make visible
     * @param options timeout and step limits
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the job
     * @throws JSONException if the request cannot be encoded
     */
    public AsyncJob prepareSeededAsync(int count,int seed,int visibleBars,AsyncOptions options,AsyncListener listener) throws JSONException {checkAsyncOwner();if(count<0||count>BaroChartColumns.MAX_BARS)throw new IllegalArgumentException("Synthetic bar count limit");visibleBars(visibleBars);return beginAsync("seeded",new JSONObject().put("kind","seeded").put("count",count).put("seed",Integer.toUnsignedLong(seed)).put("visibleBars",visibleBars).toString(),null,options,listener);}
    private void visibleBars(int visibleBars){if(visibleBars<1||visibleBars>BaroChartColumns.MAX_BARS)throw new IllegalArgumentException("Visible bar limit");}
    private void checkAsyncOwner(){check();if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Async calculation requires a main/UI owner engine");}
    private AsyncJob beginAsync(String kind,String request,BaroChartColumns columns,AsyncOptions options,AsyncListener listener) throws JSONException {
        checkAsyncOwner();if(options==null||listener==null)throw new IllegalArgumentException("Async options and listener required");
        if(activeWorkspace!=null||activeParams!=null)throw new IllegalStateException("Workspace or parameter update is active");
        Thread preceding=null;if(activeJob!=null){preceding=activeJob.blockingWorker();activeJob.stopOnOwner("superseded");}
        AsyncJob job=new AsyncJob(kind,request,columns,options,listener,preceding);activeJob=job;job.start();return job;
    }
    /** Workspace-only cancellation handle. Success replaces the internal runtime. */
    public static final class WorkspaceJob {private final WorkspaceRestoreJob job;private WorkspaceJob(WorkspaceRestoreJob job){this.job=job;}/** Requests cancellation of the restore. */ public void cancel(){job.cancel();}/**
     * Tells whether owner-thread cleanup is still pending.
     * @return true while cleanup is pending
     */ public boolean cleanupPending(){return job.pendingOwnerCleanup();}/**
     * Returns the status that left cleanup pending.
     * @return the status, or {@code null} when no cleanup is pending
     */ public String pendingFailure(){return job.pendingOwnerFailure();}}
    /**
     * Restores a workspace document without blocking, with default options. Advanced API that may change within 1.x.
     * The engine must be owned by the main thread.
     * @param document a workspace document as text
     * @param binding the dataset binding as JSON
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the restore
     * @throws JSONException if the request cannot be encoded
     */
    public WorkspaceJob restoreWorkspaceAsync(String document,JSONObject binding,AsyncListener listener)throws JSONException {return restoreWorkspaceAsync(document,binding,new AsyncOptions(),listener);}
    /**
     * Owned document + explicit dataset binding; one active job, no implicit supersession.
     * @param document a workspace document as text
     * @param binding the dataset binding as JSON
     * @param options timeout and step limits
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel the restore
     * @throws JSONException if the request cannot be encoded
     */
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
                JSONArray buffers=value.getJSONArray("buffers");if(buffers.length()!=6)throw new JSONException("Workspace six source buffers");int length=-1;for(int i=0;i<6;i++){JSONObject b=buffers.getJSONObject(i);if(workspaceInteger(b.get("slot"),0,5,"slot")!=i)throw new JSONException("Workspace source slot order");int n=(int)workspaceInteger(b.get("length"),0,BaroChartColumns.MAX_BARS,"length");if(length>=0&&n!=length)throw new JSONException("Workspace source column lengths");length=n;}
                expectedBytes=workspaceInteger(value.getJSONObject("plan").get("totalBytes"),1,WorkspaceRestoreJob.MAX_BYTES,"logical bytes");return new WorkspaceRestoreJob.Admission(done,new WorkspaceRestoreJob.Descriptor(ticket,(String)value.get("metadataJSON"),length,expectedBytes));
            }
            public void checkSource(long h,long ticket,long r)throws JSONException {if(!Boolean.TRUE.equals(invokeHandle(h,"nativeWorkspaceSourceCheck",ticket,r)))throw new JSONException("Workspace source check");}
            public byte[] readSource(long h,long ticket,int slot,int offset,int count){BaroChartTrace.typedTransfer(h,"nativeAsyncBuffer");return readBuffer(h,ticket,slot,offset,count);}
            public void finishSource(long h,long ticket,long r)throws JSONException {JSONObject value=(JSONObject)invokeHandle(h,"nativeWorkspaceSourceFinish",ticket,r);if(!"aster.native-workspace-source-finished".equals(value.get("schema"))||workspaceInteger(value.get("version"),1,1,"version")!=1||workspaceInteger(value.get("ticket"),1,9007199254740991L,"ticket")!=ticket||workspaceInteger(value.get("revision"),0,9007199254740991L,"revision")!=r)throw new JSONException("Workspace source finish binding");}
            public void releaseSource(long h,long ticket)throws JSONException {Object result=invokeHandle(h,"nativeWorkspaceSourceAbort",registration);if(!(result instanceof Boolean))throw new JSONException("Workspace abort receipt");}
            public long createTarget(String metadata)throws JSONException {long target=createRuntime(sourceBundle,runtimeBackend);try{if(!Boolean.TRUE.equals(invokeHandle(target,"nativeWorkspaceTargetCreate",metadata)))throw new JSONException("Workspace target create");return target;}catch(JSONException|RuntimeException|Error error){free(target);throw error;}}
            public void writeTarget(long h,int slot,int offset,byte[] bytes){BaroChartTrace.typedTransfer(h,"nativeAsyncTargetBuffer");writeBuffer(h,slot,offset,bytes);}
            public void startTarget(long h)throws JSONException {if(!Boolean.TRUE.equals(invokeHandle(h,"nativeAsyncStart")))throw new JSONException("Workspace target start");}
            public WorkspaceRestoreJob.Progress stepTarget(long h,int bars)throws JSONException {Object encoded=invokeHandle(h,"nativeAsyncStep",bars);if(!(encoded instanceof String))throw new JSONException("Workspace progress encoding");JSONObject p=new JSONObject((String)encoded);Object phase=p.get("phase"),complete=p.get("complete");if(!(phase instanceof String)||!(complete instanceof Boolean)||!java.util.Arrays.asList("validate","store-index","calculate","indices","workspace-checkpoints","workspace-ready").contains(phase)||((Boolean)complete)!=phase.equals("workspace-ready"))throw new JSONException("Workspace target phase");return new WorkspaceRestoreJob.Progress((String)phase,workspaceInteger(p.get("done"),0,9007199254740991L,"progress"),workspaceInteger(p.get("total"),0,9007199254740991L,"total"),(Boolean)complete);}
            public void finishTarget(long h)throws JSONException {JSONObject value=(JSONObject)invokeHandle(h,"nativeWorkspaceTargetFinish");if(!"aster.native-workspace-target-ready".equals(value.get("schema"))||workspaceInteger(value.get("version"),1,1,"version")!=1||!"target-ready".equals(value.get("status"))||!Boolean.FALSE.equals(value.get("hostPublished"))||workspaceInteger(value.getJSONObject("plan").get("totalBytes"),1,WorkspaceRestoreJob.MAX_BYTES,"logical bytes")!=expectedBytes)throw new JSONException("Workspace target finish binding");}
            public void free(long h){BaroChartEngine.free(h);}
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
        /** Requests cancellation of the parameter update. */
        public void cancel(){job.cancel();}
        /**
         * Tells whether cleanup is still pending.
         * @return true when owner-thread cleanup is pending
         */
        public boolean cleanupPending(){return job.pendingOwnerCleanup();}
        /**
         * Reports whether the update was committed.
         * @return the commit outcome, such as {@code committed}, {@code unchanged}, {@code notCommitted} or {@code
         *     unknown}
         */
        public String commitOutcome(){return job.commitOutcome();}
        /** Retry only on the original owner thread; never retries an uncertain free. */
        public void retryCleanup(){job.resumeOwnerCleanup();}
    }
    /**
     * Replaces indicator parameters through the isolated async path, with default options. Advanced API that may
     * change within 1.x. The engine must be owned by the main thread.
     * @param id indicator id
     * @param params parameters as JSON
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel or inspect the update
     * @throws JSONException if the request cannot be encoded
     */
    public ParamsJob setIndicatorParamsAsync(String id,JSONObject params,AsyncListener listener)throws JSONException{return setIndicatorParamsAsync(id,params,new AsyncOptions(),listener);}
    /**
     * Original runtime/store retained; linked portable indicator definitions only.
     * @param id indicator id
     * @param params parameters as JSON
     * @param options timeout and step limits
     * @param listener receives progress and the final result on the main thread
     * @return a handle that can cancel or inspect the update
     * @throws JSONException if the request cannot be encoded
     */
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
            public ParamsUpdateJob.Descriptor admit(long h,long ticket,long r)throws JSONException{JSONObject v=(JSONObject)invokeHandle(h,"nativeParamsSourceStep",ticket,8,r);Object complete=v.get("complete");if(!(complete instanceof Boolean))throw new JSONException("Params admission completion");if(!((Boolean)complete))return null;if("noop".equals(v.get("phase")))return new ParamsUpdateJob.Descriptor(null,0,0,true);if(!"copy".equals(v.get("phase")))throw new JSONException("Params admission phase");Object metadata=v.get("metadataJSON");if(!(metadata instanceof String)||((String)metadata).length()>131072)throw new JSONException("Params metadata limit");JSONObject meta=new JSONObject((String)metadata);return new ParamsUpdateJob.Descriptor((String)metadata,(int)workspaceInteger(meta.get("length"),0,BaroChartColumns.MAX_BARS,"length"),workspaceInteger(v.getJSONObject("plan").get("totalBytes"),1,NativeJobBudget.MAX_BYTES,"logical bytes"),false);}
            public void checkSource(long h,long ticket,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceCheck",ticket,r));}
            public byte[] readSource(long h,long ticket,int slot,int offset,int count){BaroChartTrace.typedTransfer(h,"nativeAsyncBuffer");return readBuffer(h,ticket,slot,offset,count);}
            public long createTarget(){return createRuntime(sourceBundle,runtimeBackend);}
            public void initializeTarget(long h,String metadata)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsTargetCreate",metadata));}
            public void writeTarget(long h,int slot,int offset,byte[] bytes){BaroChartTrace.typedTransfer(h,"nativeAsyncTargetBuffer");writeBuffer(h,slot,offset,bytes);}
            public void startTarget(long h)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsTargetStart"));}
            public boolean stepTarget(long h,int bars)throws JSONException{JSONObject p=(JSONObject)invokeHandle(h,"nativeParamsTargetStep",bars);Object phase=p.get("phase"),flag=p.get("complete");if(!(flag instanceof Boolean)||!java.util.Arrays.asList("validate","calculate","outputs","ready").contains(phase)||((Boolean)flag)!=phase.equals("ready"))throw new JSONException("Params target progress");long done=workspaceInteger(p.get("done"),0,9007199254740991L,"progress"),total=workspaceInteger(p.get("total"),0,9007199254740991L,"total");if(done>total)throw new JSONException("Params progress bounds");return (Boolean)flag;}
            public ParamsUpdateJob.Result result(long h)throws JSONException{Object text=invokeHandle(h,"nativeParamsTargetDescriptor");if(!(text instanceof String)||((String)text).length()>131072)throw new JSONException("Params result metadata");JSONObject v=new JSONObject((String)text);return new ParamsUpdateJob.Result((String)text,v.getJSONArray("outputs").length(),(int)workspaceInteger(v.get("capacity"),16,BaroChartColumns.MAX_BARS,"capacity"),(int)workspaceInteger(v.get("checkpointCount"),0,16385,"checkpoint count"));}
            public byte[] readResult(long h,long token,int slot,int offset,int count){BaroChartTrace.typedTransfer(h,"nativeAsyncBuffer");return readBuffer(h,token,slot,offset,count);}
            public ParamsUpdateJob.Record checkpoint(long h,int ordinal)throws JSONException{JSONObject v=(JSONObject)invokeHandle(h,"nativeParamsTargetCheckpoint",ordinal);Object text=v.get("text");if(!(text instanceof String))throw new JSONException("Params checkpoint text");return new ParamsUpdateJob.Record((int)workspaceInteger(v.get("index"),0,BaroChartColumns.MAX_BARS,"checkpoint index"),(String)text);}
            public void freeTarget(long h){free(h);}
            public void receive(long h,long ticket,String text,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceReceive",ticket,text,r));}
            public void writeResult(long h,long ticket,int slot,int offset,byte[] bytes,long r)throws JSONException{paramsTrue(invokeHandle(h,"nativeParamsSourceArmWrite",ticket,slot,offset,bytes.length/8,r));BaroChartTrace.typedTransfer(h,"nativeAsyncTargetBuffer");writeBuffer(h,slot,offset,bytes);}
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
    private static Object invokeHandle(long h,String function,Object... args) throws JSONException {return new JSONArray("["+callRuntime(h,function,argumentsJSON(args))+"]").get(0);}
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
        private final AsyncOptions options;private AsyncListener listener;private String eventJSON;private final String kind;private BaroChartColumns inputColumns;
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
        private AsyncJob(String kind,String eventJSON,BaroChartColumns inputColumns,AsyncOptions options,AsyncListener listener,Thread preceding){this.kind=kind;this.eventJSON=eventJSON;this.inputColumns=inputColumns;inputOwnedBytes=inputColumns==null?0:inputColumns.ownedBytes();inputCopyMillis=inputColumns==null?0:inputColumns.copyMillis();this.options=options;this.listener=listener;this.preceding=preceding;deadline=started+options.timeoutMillis*1000000;}
        private Thread blockingWorker(){return worker!=null&&worker.isAlive()?worker:preceding!=null&&preceding.isAlive()?preceding:null;}
        /** Requests cancellation; it has no effect once the result is committed. */
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
                    int count=Math.min(262144,length-slotOffset);BaroChartTrace.typedTransfer(handle,"nativeAsyncBuffer");long began=System.nanoTime();byte[] bytes=readBuffer(handle,ticket,buffer.getInt("slot"),slotOffset,count);long elapsed=System.nanoTime()-began;ownerCopyNanos+=elapsed;ownerCopyMaxNanos=Math.max(ownerCopyMaxNanos,elapsed);
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
            if(stopRequested())return;long began=System.nanoTime();prepared=createRuntime(sourceBundle,runtimeBackend);invokeHandle(prepared,kind.equals("correction")?"nativeAsyncCreate":"nativePrepareCreate",descriptor.getString("metadataJSON"));createNanos=System.nanoTime()-began;workerMemoryPeak=memoryPeak(prepared);handler.post(this::captureNext);
            while(!stopRequested()){
                Transfer transfer=transfers.poll(50,java.util.concurrent.TimeUnit.MILLISECONDS);if(transfer==null)continue;if(stopRequested())break;
                if(transfer.inputCount>0){BaroChartTrace.typedTransfer(prepared,"nativeAsyncTargetBuffer");long copyStart=System.nanoTime();inputColumns.copyInto(prepared,transfer.slot,transfer.offset,transfer.inputCount);long elapsed=System.nanoTime()-copyStart;inputWriteNanos+=elapsed;inputWriteMaxNanos=Math.max(inputWriteMaxNanos,elapsed);copiedBytes+=transfer.inputCount*8L;copyChunks++;intermediatePeakBytes=Math.max(intermediatePeakBytes,transfer.inputCount*8L);progress("copy-input",copiedBytes,inputOwnedBytes,false);}
                else if(transfer.bytes!=null){BaroChartTrace.typedTransfer(prepared,"nativeAsyncTargetBuffer");writeBuffer(prepared,transfer.slot,transfer.offset,transfer.bytes);}
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
    /** JNI Rust host callback: accepted zone name to java.time canonical identifier. */
    static String zoneResolve(String zone){return timezone(zone).getId();}
    /** JNI Rust host callback: offset seconds at a UTC epoch millisecond. */
    static int zoneOffsetSeconds(long epochMillis,String zone){return timezone(zone).getRules().getOffset(Instant.ofEpochMilli(epochMillis)).getTotalSeconds();}
    /** JNI Rust status/error envelope to the same Name: message text used by QuickJS. */
    static String rustErrorMessage(int status,String envelope){
        if(envelope!=null&&!envelope.isEmpty())try{JSONObject value=new JSONObject(envelope);String name=value.optString("name","Error"),message=value.optString("message","Rust core call failed");return name.isEmpty()?message:name+": "+message;}catch(JSONException invalidEnvelope){return rustStatusMessage(status);}
        return rustStatusMessage(status);
    }
    /** 깨진 전송 본문은 노출하지 않고 고정 상태 문구만 반환한다. */
    private static String rustStatusMessage(int status){
        switch(status){case 3:case 4:return "Error: Chart disposed";case 5:return "Rust core busy";case 6:return "TypeError: Invalid Rust core transport";case 7:return "InternalError: out of memory";case 8:return "RangeError: Out of memory";default:return "Rust engine unavailable";}
    }
    /**
     * Formats a time as year, month, day, hour, minute and second parts in a time zone, for the core's time zone
     * formatting.
     * @param time UTC epoch milliseconds
     * @param timezone IANA time zone name
     * @return the parts as a JSON array in text form
     * @throws JSONException if the parts cannot be encoded
     */
    public static String zonedParts(long time,String timezone) throws JSONException {
        ZonedDateTime z=Instant.ofEpochMilli(time).atZone(timezone(timezone));
        String[] names={"year","month","day","hour","minute","second"};int[] values={z.getYear(),z.getMonthValue(),z.getDayOfMonth(),z.getHour(),z.getMinute(),z.getSecond()};JSONArray parts=new JSONArray();
        for(int i=0;i<names.length;i++)parts.put(new JSONObject().put("type",names[i]).put("value",String.format(Locale.ROOT,i==0?"%04d":"%02d",values[i])));return parts.toString();
    }
    // ---------------------------------------------------------------------------------------
    // 타입 API: 모든 실패는 BaroChartException 하나로 던진다. 저수준 JSON API를 호출해 동작을 공유한다.
    // ---------------------------------------------------------------------------------------

    /** 예외를 던질 수 있는 타입 API 본문 */
    private interface TypedAction { void run() throws Exception; }
    /** 값을 돌려주는 타입 API 본문 */
    private interface TypedCall<T> { T run() throws Exception; }
    /** 본문의 모든 예외를 BaroChartException으로 바꿔 던진다 */
    private static void typed(TypedAction body){try{body.run();}catch(Exception error){throw BaroChartException.wrap(error);}}
    private static <T> T typedCall(TypedCall<T> body){try{return body.run();}catch(Exception error){throw BaroChartException.wrap(error);}}

    /**
     * Creates an engine with an explicit initial layout and no bars, owned by the calling thread.
     * Prefer this over {@code new BaroChartEngine(context, count)}, which builds a labeled demonstration chart.
     * Engines attached to a view must be created on the main thread.
     * @param context used to read the bundled core asset
     * @param options the initial layout
     * @return a new engine with no bars
     */
    @androidx.annotation.NonNull public static BaroChartEngine create(@androidx.annotation.NonNull Context context,@androidx.annotation.NonNull EngineOptions options){
        return create(context,options,getDefaultBackend());
    }
    /** Creates an engine with an explicit backend. */
    @androidx.annotation.NonNull public static BaroChartEngine create(@androidx.annotation.NonNull Context context,@androidx.annotation.NonNull EngineOptions options,@androidx.annotation.NonNull EngineBackend backend){
        return typedCall(()->new BaroChartEngine(context,0,LowLevelJson.engineOptions(options),runtimeBackend(backend)));
    }
    /** Package-private backend selection hook retained for validation and same-backend workers. */
    @androidx.annotation.NonNull static BaroChartEngine create(@androidx.annotation.NonNull Context context,@androidx.annotation.NonNull EngineOptions options,RuntimeBackend backend){
        return typedCall(()->new BaroChartEngine(context,0,LowLevelJson.engineOptions(options),backend));
    }
    /**
     * Replaces every bar of the primary series.
     * @param bars the complete new list of bars
     */
    public void setBars(@androidx.annotation.NonNull java.util.List<Bar> bars){typed(()->setBarsEncoded(bars));}
    /** Encodes before the owner/closed check to preserve the legacy typed conversion order. */
    private void setBarsEncoded(java.util.List<Bar> bars) throws JSONException {
        invokeEncoded("nativeCommand",encodeTypedBars(bars));
        notifyChanges();
    }
    /** Reuses only a bounded, owner-thread buffer; wrong-thread and reentrant user iterators get an isolated buffer. */
    private String encodeTypedBars(java.util.List<Bar> bars) throws JSONException {
        if (Thread.currentThread()!=owner || encodingTypedBars) return LowLevelJson.barsCommand(bars);
        boolean cacheable=handle!=0&&!closing;StringBuilder buffer;
        if(cacheable){buffer=typedBarsBuffer;if(buffer==null)buffer=new StringBuilder();typedBarsBuffer=buffer;}
        else{typedBarsBuffer=null;buffer=new StringBuilder();}
        encodingTypedBars=true;
        try { return LowLevelJson.barsCommand(bars,buffer); }
        finally { encodingTypedBars=false;buffer.setLength(0);if(handle==0||closing)typedBarsBuffer=null;else if(typedBarsBuffer==buffer&&buffer.capacity()>MAX_TYPED_BARS_BUFFER_CHARS)typedBarsBuffer=null; }
    }
    /**
     * Applies a streaming or correction event. Invalid events throw {@code INVALID_ARGUMENT} and leave data unchanged.
     * @param event the event to apply
     */
    public void apply(@androidx.annotation.NonNull DataEvent event){typed(()->applyDataEvent(LowLevelJson.event(event)));}
    /**
     * Adds a series.
     * @param series the series to add
     */
    public void addSeries(@androidx.annotation.NonNull Series series){typed(()->addSeries(LowLevelJson.series(series)));}
    /**
     * Changes only the fields set on {@code patch}; every unset field, including the panel, keeps its current value.
     * The series id and type cannot change. A missing id throws {@code JAVASCRIPT}.
     * @param id id of the series to change
     * @param patch the fields to change
     */
    public void updateSeries(@androidx.annotation.NonNull String id,@androidx.annotation.NonNull SeriesPatch patch){typed(()->setSeries(id,LowLevelJson.seriesPatch(patch)));}
    /**
     * Adds an indicator under {@code id}. Bind it to a series with {@code Series.builder(...).indicator(id)}.
     * @param indicator the indicator definition
     * @param id id for the indicator
     */
    public void addIndicator(@androidx.annotation.NonNull Indicator indicator,@androidx.annotation.NonNull String id){typed(()->addIndicator(id,indicator.kind.wireName(),LowLevelJson.params(indicator.params)));}
    /**
     * Replaces indicator parameters synchronously.
     * @param id indicator id
     * @param params new parameter values by core parameter name
     */
    public void setIndicatorParams(@androidx.annotation.NonNull String id,@androidx.annotation.NonNull java.util.Map<String,ParamValue> params){typed(()->setIndicatorParams(id,LowLevelJson.params(params)));}
    /**
     * Reads one indicator output at a bar index; {@code output} {@code null} means the first output.
     * @param id indicator id
     * @param output output name, or {@code null} for the first output
     * @param index bar index
     * @return the indicator value
     */
    @androidx.annotation.NonNull public IndicatorValue indicatorValue(@androidx.annotation.NonNull String id,@androidx.annotation.Nullable String output,int index){
        return typedCall(()->{JSONObject raw=indicatorValueAt(id,output,index);return new IndicatorValue(optDouble(raw,"value"),raw.isNull("sourceIndex")?null:raw.getInt("sourceIndex"),optDouble(raw,"sourceTime"));});
    }
    /**
     * Selects the active drawing tool for touch input.
     * @param tool the drawing tool
     */
    public void setTool(@androidx.annotation.NonNull DrawingTool tool){typed(()->setTool(tool.wireName()));}
    /**
     * Adds a drawing and returns its id. {@link DrawingTool#SELECT} is not a drawing and throws {@code INVALID_ARGUMENT}.
     * @param drawing the drawing to add
     * @return the id of the new drawing
     */
    @androidx.annotation.NonNull public String addDrawing(@androidx.annotation.NonNull Drawing drawing){
        if(drawing.tool==DrawingTool.SELECT)throw new BaroChartException(BaroChartException.Code.INVALID_ARGUMENT,"The select tool cannot create a drawing.","Use a drawing tool such as TRENDLINE or HORIZONTAL.",null);
        return typedCall(()->addDrawing(LowLevelJson.drawing(drawing)));
    }
    /**
     * Changes only the fields set on {@code patch}; unset anchors, panel, style, text, lock and visibility keep their
     * current values, so a style-only change does not need the anchors again. The tool cannot change. A missing id
     * throws {@code JAVASCRIPT}; a locked drawing accepts only lock and visibility changes.
     * @param id id of the drawing to change
     * @param patch the fields to change
     */
    public void updateDrawing(@androidx.annotation.NonNull String id,@androidx.annotation.NonNull DrawingPatch patch){typed(()->editDrawing(id,LowLevelJson.drawingPatch(patch)));}
    /**
     * Deletes drawings as one undo step and returns how many were removed. Missing or locked ids throw.
     * @param ids ids of the drawings to delete
     * @return the number of deleted drawings
     */
    public int deleteDrawings(@androidx.annotation.NonNull java.util.List<String> ids){return typedCall(()->deleteDrawings(new JSONArray(ids)).getInt("changed"));}
    /**
     * Applies a complete theme.
     * @param theme the theme
     */
    public void setTheme(@androidx.annotation.NonNull Theme theme){typed(()->setTheme(LowLevelJson.theme(theme)));}
    /**
     * Sets instrument metadata used for price and time formatting.
     * @param symbol the instrument metadata
     */
    public void setSymbol(@androidx.annotation.NonNull Symbol symbol){typed(()->setSymbol(LowLevelJson.symbol(symbol)));}
    /**
     * Current visible range in bar-index coordinates.
     * @return the visible range
     */
    @androidx.annotation.NonNull public VisibleRange visibleRange(){return typedCall(()->{JSONObject view=((JSONObject)command("inspect")).getJSONObject("view");return new VisibleRange(view.getDouble("from"),view.getDouble("to"));});}
    /**
     * Sets the visible range in bar-index coordinates; {@code to} must be greater than {@code from}.
     * @param range the new range
     */
    public void setVisibleRange(@androidx.annotation.NonNull VisibleRange range){typed(()->command("setVisibleRange",range.from,range.to));}
    /**
     * Saves chart settings, indicators, series and drawings as a portable {@code aster.workspace} document.
     * @param binding the dataset the workspace belongs to
     * @return the workspace document as text
     */
    @androidx.annotation.NonNull public String saveWorkspace(@androidx.annotation.NonNull DatasetBinding binding){return typedCall(()->saveWorkspace(LowLevelJson.binding(binding)));}
    /**
     * Restores a saved workspace onto this engine's current bars without blocking the main thread.
     * The engine must be main-thread owned and hold the same bars the document was saved with.
     * The callback runs once on the main thread with {@code null} on success. Cancelling reports {@code CANCELLED}.
     * @param document a workspace document from {@link #saveWorkspace(DatasetBinding)}
     * @param binding the dataset the document must belong to
     * @param callback receives the result once
     * @return a handle that can cancel the restore
     */
    @androidx.annotation.NonNull public RestoreHandle restoreWorkspace(@androidx.annotation.NonNull String document,@androidx.annotation.NonNull DatasetBinding binding,@androidx.annotation.NonNull RestoreCallback callback){
        WorkspaceJob job=typedCall(()->restoreWorkspaceAsync(document,LowLevelJson.binding(binding),result->callback.onComplete(restoreFailure(result))));
        return new RestoreHandle(job);
    }
    /**
     * Values under the crosshair for a view of the given size, or {@code null} when there is no crosshair.
     * @param width view width
     * @param height view height
     * @return the crosshair values, or {@code null} when there is no crosshair
     */
    @androidx.annotation.Nullable public CrosshairValues crosshair(double width,double height){
        return typedCall(()->{Object raw=command("crosshairValues",width,height);return raw instanceof JSONObject?crosshairValues((JSONObject)raw):null;});
    }
    /**
     * Whether {@link #close()} has completed. A closed engine rejects every call with {@code ENGINE_CLOSED}.
     * @return true when the engine is closed
     */
    public boolean isClosed(){return handle==0;}

    /** 비동기 결과를 콜백용 예외로 바꾼다(성공이면 null) */
    private static BaroChartException restoreFailure(AsyncResult result){
        if(result.succeeded())return null;
        // 취소되면 내부 정지 예외도 함께 오므로 상태를 먼저 본다
        if("cancelled".equals(result.status))return new BaroChartException(BaroChartException.Code.CANCELLED,"Workspace restore was cancelled.",null,result.error);
        if(result.error!=null)return BaroChartException.wrap(result.error);
        return new BaroChartException(BaroChartException.Code.UNAVAILABLE,"Workspace restore finished with status "+result.status+".",null,null);
    }
    private static Double optDouble(JSONObject raw,String key) throws JSONException {return raw.isNull(key)?null:raw.getDouble(key);}
    private static CrosshairValues crosshairValues(JSONObject raw) throws JSONException {
        JSONObject primary=raw.optJSONObject("primary"),bar=primary==null?null:primary.optJSONObject("bar");
        Bar value=bar==null?null:new Bar(bar.getDouble("time"),bar.getDouble("open"),bar.getDouble("high"),bar.getDouble("low"),bar.getDouble("close"),bar.getDouble("volume"));
        java.util.List<CrosshairValues.SeriesValue> series=new java.util.ArrayList<>();JSONArray rows=raw.optJSONArray("series");
        for(int i=0;rows!=null&&i<rows.length();i++){JSONObject row=rows.getJSONObject(i);series.add(new CrosshairValues.SeriesValue(row.optString("id"),row.optString("label"),row.optString("panel"),optDouble(row,"value")));}
        return new CrosshairValues(raw.getInt("index"),raw.getDouble("time"),value,series);
    }
}
