package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** 호스트 직렬화와 JNI 파싱 전에 인자 배열을 포함한 깊이 64를 검사한다(M0c). */
@RunWith(AndroidJUnit4.class)
public class ArgumentDepthTest {
    private interface Action {void run() throws Exception;}

    private static Object nested(int depth) throws Exception {
        Object value = 0;
        for (int i = 1; i < depth; i++) value = new JSONArray().put(value);
        return value;
    }

    private static void rejectsDepth(Action action) throws Exception {
        rejects(action, "Native argument depth limit");
    }

    private static void rejects(Action action, String message) throws Exception {
        try {action.run();fail("Expected argument depth rejection");}
        catch (RuntimeException error) {
            BaroChartException wrapped = BaroChartException.wrap(error);
            assertEquals(BaroChartException.Code.INVALID_ARGUMENT, wrapped.getCode());
            assertEquals(message, wrapped.getMessage());
        }
    }

    private static String rawCall(BaroChartEngine engine, String arguments) throws Exception {
        Field handle = BaroChartEngine.class.getDeclaredField("handle");handle.setAccessible(true);
        Method call = BaroChartEngine.class.getDeclaredMethod("call", long.class, String.class, String.class);call.setAccessible(true);
        try {return (String) call.invoke(null, handle.getLong(engine), "nativeEcho", arguments);}
        catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof RuntimeException) throw (RuntimeException) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw new AssertionError("Unexpected JNI exception", cause);
        }
    }

    private static String arrayText(int depth) {
        StringBuilder text = new StringBuilder(depth * 2 + 1);
        for (int i = 0; i < depth; i++) text.append('[');
        text.append('0');
        for (int i = 0; i < depth; i++) text.append(']');
        return text.toString();
    }

    @Test public void hostArgumentsAccept64Reject65() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                assertTrue(engine.invoke("nativeEcho", nested(64)) instanceof JSONArray);
                rejectsDepth(() -> engine.invoke("nativeEcho", nested(65)));
                assertEquals(7, ((Number) engine.invoke("nativeEcho", 7)).intValue());
            } finally {engine.close();}
        });
    }

    @Test public void JNIRejectsVeryDeepTextBeforeQuickJSParsingAndKeepsRuntimeAlive() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                assertEquals(arrayText(63), rawCall(engine, arrayText(64)));
                rejectsDepth(() -> rawCall(engine, arrayText(65)));
                rejectsDepth(() -> rawCall(engine, arrayText(100000)));
                assertEquals("\"[{}]\\\"\"", rawCall(engine, "[\"[{}]\\\"\"]"));
                assertEquals("7", rawCall(engine, "[7]"));
            } finally {engine.close();}
        });
    }

    @Test public void cyclesAndJavaCollectionsRejectBeforeRecursiveJSONEncoding() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            JSONArray array = new JSONArray();array.put(array);
            JSONObject object = new JSONObject();object.put("self", object);
            List<Object> list = new ArrayList<>();list.add(list);
            try {
                rejectsDepth(() -> engine.invoke("nativeEcho", array));
                rejectsDepth(() -> engine.invoke("nativeEcho", object));
                rejectsDepth(() -> engine.invoke("nativeEcho", list));
                Object value = 0;
                for (int i = 1; i < 65; i++) {List<Object> next = new ArrayList<>();next.add(value);value = next;}
                Object deepList = value;
                rejectsDepth(() -> engine.invoke("nativeEcho", deepList));
            } finally {list.clear();object.remove("self");array.remove(0);engine.close();}
        });
    }

    @Test public void sharedReferenceHeightIsCheckedAtEveryDepth() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                Object subtree = 0;
                for (int i = 0; i < 10; i++) subtree = new JSONArray().put(subtree);
                JSONArray shared = (JSONArray) subtree;
                Object deeper = shared;
                for (int i = 0; i < 52; i++) deeper = new JSONArray().put(deeper);
                JSONArray root = new JSONArray().put(shared).put(deeper);
                assertTrue(engine.invoke("nativeEcho", root) instanceof JSONArray);
                JSONArray over = new JSONArray().put(shared).put(new JSONArray().put(deeper));
                rejectsDepth(() -> engine.invoke("nativeEcho", over));
                assertTrue(engine.invoke("nativeEcho", shared) instanceof JSONArray);
            } finally {engine.close();}
        });
    }

    @Test public void coreDocumentDepthErrorsAreInvalidArgumentAndLeaveDrawingsUntouched() {
        TestSupport.onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(TestSupport.context(), EngineOptions.defaults());
            try {
                Object saved = engine.invoke("nativeCommand", "saveDrawings", new JSONArray());
                for (int depth : new int[]{33, 100000}) {
                    String text = arrayText(depth);
                    rejects(() -> engine.invoke("nativeCommand", "loadDrawings", new JSONArray().put(text)), "Drawing document depth limit");
                    rejects(() -> engine.invoke("nativeAsyncBegin", text), "Native data event document depth limit");
                    rejects(() -> engine.invoke("nativePrepareBegin", text), "Native prepare document depth limit");
                }
                assertEquals(saved, engine.invoke("nativeCommand", "saveDrawings", new JSONArray()));
            } finally {engine.close();}
        });
    }
}
