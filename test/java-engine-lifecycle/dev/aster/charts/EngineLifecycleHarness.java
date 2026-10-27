package dev.aster.charts;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Handler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Executes production AsterEngine lifecycle code against test-only host fixtures. */
public final class EngineLifecycleHarness {
    static {System.loadLibrary("aster");}
    private static int checks;
    private static native void nativeReset();
    private static native void nativeFailFree(boolean value);
    private static native int nativeCreated();
    private static native int nativeFreed();
    private static native int nativeLive();
    private static native int nativeCommandCalls();
    private static native int nativeReleaseFrameCalls();

    private static final class FixtureContext extends Context {
        private final AssetManager assets;
        FixtureContext(){this(null);}
        FixtureContext(IOException closeFailure){assets=new AssetManager("fixture".getBytes(StandardCharsets.UTF_8),closeFailure);}
        @Override public AssetManager getAssets(){return assets;}
    }

    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static void pass(String name){System.out.println("PASS "+name);}

    private static void constructorErrorReleases() throws Exception {
        nativeReset();OutOfMemoryError original=new OutOfMemoryError("fixture serialization");JSONObject.failNextSerialization(original);Throwable caught=null;
        try{new AsterEngine(new FixtureContext(),1,new JSONObject());}catch(Throwable error){caught=error;}
        check(caught!=null,"constructor error missing");check(caught==original,"constructor replaced original error");
        check(nativeCreated()==1,"constructor create count");check(nativeFreed()==1,"constructor free count");check(nativeLive()==0,"constructor live count");
        pass("constructor-error-releases-handle");
    }

    private static void assetClosePrecedesHandleAcquisition() throws Exception {
        nativeReset();IOException original=new IOException("fixture asset close");Throwable caught=null;
        try{new AsterEngine(new FixtureContext(original),1,new JSONObject());}catch(Throwable error){caught=error;}
        check(caught!=null,"asset close error missing");check(caught==original,"asset close error replaced");
        check(nativeCreated()==0,"handle acquired before asset close");check(nativeFreed()==0,"unexpected free without acquisition");check(nativeLive()==0,"asset close live count");
        pass("asset-close-precedes-handle-acquisition");
    }

    private static void constructorCleanupFailureIsSuppressed() throws Exception {
        nativeReset();nativeFailFree(true);OutOfMemoryError original=new OutOfMemoryError("fixture serialization with cleanup failure");JSONObject.failNextSerialization(original);Throwable caught=null;
        try{new AsterEngine(new FixtureContext(),1,new JSONObject());}catch(Throwable error){caught=error;}finally{nativeFailFree(false);}
        check(caught!=null,"constructor cleanup error missing");check(caught==original,"cleanup replaced original error");
        Throwable[] suppressed=caught.getSuppressed();check(suppressed.length==1,"cleanup suppression count");check(suppressed[0] instanceof AssertionError,"cleanup suppression type");check("fixture free failure".equals(suppressed[0].getMessage()),"cleanup suppression message");
        check(nativeCreated()==1,"cleanup create count");check(nativeFreed()==1,"cleanup free count");check(nativeLive()==0,"cleanup live count");
        pass("constructor-cleanup-failure-suppressed");
    }

    private static void closingRejectsReentryAndAllowsCleanup() throws Exception {
        nativeReset();Handler.clearFixtureQueue();final AsterEngine engine=new AsterEngine(new FixtureContext(),1);final boolean[] completed={false},rejected={false},cleanup={false};
        final Runnable change=new Runnable(){@Override public void run(){}};
        final Runnable[] closing=new Runnable[1];closing[0]=new Runnable(){@Override public void run(){cleanup[0]=true;try{engine.releaseFrameCache("fixture-frame");}catch(Exception error){throw new AssertionError(error);}engine.removeChangeListener(change);engine.removeCloseListener(closing[0]);}};
        engine.addChangeListener(change);engine.addCloseListener(closing[0]);
        engine.setIndicatorParamsAsync("ema",new JSONObject(),new AsterEngine.AsyncListener(){
            @Override public void onComplete(AsterEngine.AsyncResult result){completed[0]=true;try{engine.command("inspect");}catch(IllegalStateException error){rejected[0]="Engine closing".equals(error.getMessage());}catch(Exception error){throw new AssertionError(error);}}
        });
        engine.close();Handler.clearFixtureQueue();
        check(completed[0],"params completion not delivered");check(rejected[0],"closing callback command was accepted");check(nativeCommandCalls()==0,"closing callback reached JNI");
        pass("close-reentrant-command-rejected");
        check(cleanup[0],"close cleanup listener not delivered");check(nativeReleaseFrameCalls()==1,"frame cleanup did not reach JNI");
        check(nativeCreated()==1,"close create count");check(nativeFreed()==1,"close free count");check(nativeLive()==0,"close live count");
        pass("close-owned-cleanup-allowed");
    }

    public static void main(String[] args) throws Exception {
        if(args.length!=0)throw new IllegalArgumentException("No arguments expected");
        assetClosePrecedesHandleAcquisition();constructorErrorReleases();constructorCleanupFailureIsSuppressed();closingRejectsReentryAndAllowsCleanup();
        System.out.println("RESULT scenarios=5 checks="+checks+" scope=production-java-facade-host-jni-stub");
    }
}
