package kr.coden.barochart;

import static kr.coden.barochart.TestSupport.START;
import static kr.coden.barochart.TestSupport.bars;
import static kr.coden.barochart.TestSupport.code;
import static kr.coden.barochart.TestSupport.context;
import static kr.coden.barochart.TestSupport.onMain;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 코어 호출 추적(BCJSON) 기록 훅 테스트(M0 Task 7, 설계 §6.5-1·§7.3).
 * BaroChartEngine.setTraceDirectoryForTesting으로 켜면 createRuntime이 만드는 런타임마다 runtime-&lt;n&gt;.jsonl 하나에
 * JNI call 한 번이 한 줄로 남는다. 끄면 아무 파일도 만들지 않는다.
 */
@RunWith(AndroidJUnit4.class)
public class TraceRecorderTest {
    /**
     * 이 이름의 계측 인자가 있으면 추적을 앱 files 디렉터리 아래 그 이름의 하위 디렉터리에 남기고 지우지 않는다.
     * 리팩터링 전후에 같은 시나리오의 추적을 꺼내 바이트 단위로 비교할 때 쓴다(am instrument -e barochartTraceOutput before).
     */
    private static final String KEPT_OUTPUT_ARGUMENT = "barochartTraceOutput";
    /** 테스트가 끝나면 지울 임시 디렉터리 */
    private final List<File> temporaryRoots = new ArrayList<>();

    /** 비동기 작업을 시작하는 본문. 완료 콜백을 받을 리스너를 넘겨받는다. */
    private interface AsyncStart { void start(BaroChartEngine.AsyncListener listener) throws Exception; }

    /**
     * 테스트마다 추적을 끄고 임시 디렉터리를 지운다. 테스트가 중간에 실패해도 다음 테스트에 추적이 켜진 채로 남지 않게 한다.
     * @throws IOException 임시 파일을 지우지 못한 경우
     */
    @After public void turnTracingOffAndCleanUp() throws IOException {
        BaroChartEngine.setTraceDirectoryForTesting(null);
        for (File root : temporaryRoots) deleteRecursively(root);
    }

    /** 계획의 타입 API 세션: 줄 수와 fn 순서가 코어 호출과 같고, 코어가 거절한 setSymbol은 코어 오류 레코드로 남는다. */
    @Test public void typedSessionWritesOneLinePerCoreCallInOrder() throws Exception {
        File directory = traceDirectory("typed-session");
        BaroChartEngine.setTraceDirectoryForTesting(directory);
        onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(context(), EngineOptions.defaults());
            try {
                engine.setBars(bars(4, 0));
                assertEquals("drawing-1", engine.addDrawing(Drawing.builder(DrawingTool.HORIZONTAL, Collections.singletonList(new ChartPoint(START, 103))).build()));
                assertTrue(engine.saveDrawings().contains("\"schema\":\"aster.drawings\""));
                // priceDecimals 검사는 코어 validateSymbol에서 시간대보다 먼저 일어난다(호스트 Java 검사가 아니다)
                assertEquals(BaroChartException.Code.INVALID_ARGUMENT, code(() -> engine.setSymbol(Symbol.builder("AAPL", "XNAS", "UTC", "USD", -1, 0.01).build())));
            } finally { engine.close(); }
        });
        BaroChartEngine.setTraceDirectoryForTesting(null);
        assertEquals(Collections.emptyList(), BaroChartTrace.failuresForTesting());
        assertEquals(Collections.singletonList("runtime-1.jsonl"), names(directory));
        List<String> lines = lines(directory, "runtime-1.jsonl");
        assertEquals(Arrays.asList("nativeInit", "nativeCommand", "nativeCommand", "nativeSave", "nativeCommand"), functions(lines));
        for (int i = 0; i < 4; i++) assertTrue(lines.get(i), new JSONObject(lines.get(i)).has("ok"));
        // 인자는 JNI가 받은 JSON 글자 그대로다
        assertTrue(lines.get(1), lines.get(1).startsWith("{\"fn\":\"nativeCommand\",\"args\":[\"setData\",[[{"));
        assertTrue(lines.get(2), lines.get(2).endsWith(",\"ok\":\"drawing-1\"}"));
        // Android 코어 오류는 JNI의 'Name: message'를 나눈 name·message만 담는다(code는 JNI가 넘기지 않는다)
        assertTrue(lines.get(4), lines.get(4).startsWith("{\"fn\":\"nativeCommand\",\"args\":[\"setSymbol\",[{"));
        assertTrue(lines.get(4), lines.get(4).endsWith(",\"err\":{\"name\":\"TypeError\",\"message\":\"Invalid symbol metadata\"}}"));
    }

    /** 켜지 않았거나 끈 뒤에는 파일을 만들지 않는다. 켜 둔 동안 만든 런타임도 끈 뒤의 호출은 쓰지 않는다. */
    @Test public void tracingOffWritesNoFiles() throws Exception {
        File never = traceDirectory("off");
        BaroChartEngine.setTraceDirectoryForTesting(never);
        BaroChartEngine.setTraceDirectoryForTesting(null);
        onMain(() -> {
            BaroChartEngine engine = BaroChartEngine.create(context(), EngineOptions.defaults());
            try {
                engine.setBars(bars(4, 0));
                engine.saveDrawings();
            } finally { engine.close(); }
        });
        assertFalse("Tracing off must not create the directory", never.exists());

        File turnedOff = traceDirectory("turned-off");
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        BaroChartEngine.setTraceDirectoryForTesting(turnedOff);
        onMain(() -> engine.set(BaroChartEngine.create(context(), EngineOptions.defaults())));
        BaroChartEngine.setTraceDirectoryForTesting(null);
        try {
            onMain(() -> {
                engine.get().setBars(bars(4, 0));
                engine.get().saveDrawings();
            });
        } finally { onMain(() -> engine.get().close()); }
        assertEquals(Collections.singletonList("runtime-1.jsonl"), names(turnedOff));
        assertEquals(Collections.singletonList("nativeInit"), functions(lines(turnedOff, "runtime-1.jsonl")));
    }

    /**
     * 런타임을 만드는 네 곳(엔진 생성자, 작업공간 복원·params·비동기 준비 대상)이 모두 createRuntime을 거쳐 각자 추적 파일을 받는다.
     * 대상 런타임은 작업 스레드에서 만들어진다. Float64Array 복사(타입 전송)는 기록하지 않으므로 그 런타임의 추적은 그 자리에서 멈춘다.
     */
    @Test public void everyRuntimeCreationSiteGetsItsOwnTrace() throws Exception {
        File directory = traceDirectory("creation-sites");
        DatasetBinding binding = new DatasetBinding("SYNTH:US", "1", "raw", "USD", Adjustment.RAW);
        AtomicReference<BaroChartEngine> engine = new AtomicReference<>();
        AtomicReference<String> document = new AtomicReference<>();
        BaroChartEngine.setTraceDirectoryForTesting(directory);
        try {
            onMain(() -> {
                engine.set(BaroChartEngine.create(context(), EngineOptions.defaults()));
                engine.get().setBars(bars(32, 0));
                engine.get().addIndicator(Indicator.ema(3), "ema3");
                document.set(engine.get().saveWorkspace(binding));
            });
            assertSucceeded("workspace restore", awaitResult(listener -> engine.get().restoreWorkspaceAsync(document.get(), LowLevelJson.binding(binding), listener)));
            assertSucceeded("indicator params", awaitResult(listener -> engine.get().setIndicatorParamsAsync("ema3", new JSONObject().put("period", 5), listener)));
            assertSucceeded("seeded prepare", awaitResult(listener -> engine.get().prepareSeededAsync(64, 7, 32, listener)));
            onMain(() -> assertEquals(64, TestSupport.storedBars(engine.get())));
        } finally {
            if (engine.get() != null) onMain(() -> engine.get().close());
            BaroChartEngine.setTraceDirectoryForTesting(null);
        }
        assertEquals(Collections.emptyList(), BaroChartTrace.failuresForTesting());
        assertEquals(Arrays.asList("runtime-1.jsonl", "runtime-1.meta.json", "runtime-2.jsonl", "runtime-2.meta.json",
            "runtime-3.jsonl", "runtime-3.meta.json", "runtime-4.jsonl"), names(directory));
        // runtime-1: 엔진 생성자. 복원 원본으로서 열 버퍼를 읽는 자리(타입 전송)에서 멈춘다
        assertEquals("nativeInit", functions(lines(directory, "runtime-1.jsonl")).get(0));
        assertStoppedAtTypedTransfer(directory, "runtime-1", "nativeAsyncBuffer");
        // runtime-2: 복원 대상(작업 스레드에서 생성). 커밋되면 엔진의 런타임이 된다
        assertEquals("nativeWorkspaceTargetCreate", functions(lines(directory, "runtime-2.jsonl")).get(0));
        assertStoppedAtTypedTransfer(directory, "runtime-2", "nativeAsyncTargetBuffer");
        // runtime-3: params 대상
        assertEquals("nativeParamsTargetCreate", functions(lines(directory, "runtime-3.jsonl")).get(0));
        assertStoppedAtTypedTransfer(directory, "runtime-3", "nativeAsyncTargetBuffer");
        // runtime-4: 시드 준비 대상. 타입 전송이 없어 끝까지 기록되고, 커밋 뒤의 엔진 호출(inspect)도 이 파일에 남는다
        List<String> prepared = functions(lines(directory, "runtime-4.jsonl"));
        assertEquals("nativePrepareCreate", prepared.get(0));
        assertTrue(prepared.toString(), prepared.containsAll(Arrays.asList("nativeAsyncStart", "nativeAsyncStep", "nativeAsyncUIImportBegin", "nativeAsyncUIImportEnd")));
        assertEquals(Arrays.asList("nativeAsyncFinish", "nativeCommand"), prepared.subList(prepared.size() - 2, prepared.size()));
    }

    /**
     * 시나리오 추적 디렉터리를 정한다. 계측 인자 {@value #KEPT_OUTPUT_ARGUMENT}가 있으면 앱 files 아래에 남기고, 없으면 캐시 아래
     * 새 임시 디렉터리를 쓰고 테스트 뒤 지운다. 디렉터리 자체는 만들지 않는다(추적기가 런타임을 만들 때 만든다).
     * @param scenario 시나리오 이름(하위 디렉터리 이름)
     * @return 아직 없는 디렉터리 경로
     * @throws IOException 이전 실행이 남긴 같은 이름의 디렉터리를 지우지 못한 경우
     */
    private File traceDirectory(String scenario) throws IOException {
        String kept = InstrumentationRegistry.getArguments().getString(KEPT_OUTPUT_ARGUMENT);
        File root;
        if (kept != null) root = new File(context().getFilesDir(), kept);
        else {
            root = new File(context().getCacheDir(), "barochart-trace-test-" + UUID.randomUUID());
            temporaryRoots.add(root);
        }
        File directory = new File(root, scenario);
        deleteRecursively(directory);
        return directory;
    }

    /**
     * 메인 스레드에서 비동기 작업을 시작하고 완료 결과를 기다린다.
     * @param start 리스너를 받아 작업을 시작하는 본문
     * @return 완료 결과
     * @throws Exception 시작 실패나 대기 중단
     */
    private static BaroChartEngine.AsyncResult awaitResult(AsyncStart start) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<BaroChartEngine.AsyncResult> result = new AtomicReference<>();
        onMain(() -> start.start(outcome -> { result.set(outcome); done.countDown(); }));
        assertTrue("Async completion must arrive", done.await(60, TimeUnit.SECONDS));
        return result.get();
    }

    /**
     * 비동기 결과가 성공인지 확인한다. 실패하면 상태와 오류를 메시지에 담는다.
     * @param label 작업 이름
     * @param result 완료 결과
     */
    private static void assertSucceeded(String label, BaroChartEngine.AsyncResult result) {
        assertTrue(label + ": " + result.status + " " + result.error, result.succeeded());
    }

    /**
     * 런타임 추적이 타입 전송 자리에서 멈췄는지 확인한다. 옆 파일의 줄 번호는 기록된 줄 수 + 1이다.
     * @param directory 추적 디렉터리
     * @param runtime 런타임 파일 이름(확장자 없이)
     * @param function 멈춘 자리의 코어 함수
     * @throws Exception 파일 읽기 실패
     */
    private static void assertStoppedAtTypedTransfer(File directory, String runtime, String function) throws Exception {
        JSONObject stopped = new JSONObject(new String(Files.readAllBytes(new File(directory, runtime + ".meta.json").toPath()), StandardCharsets.UTF_8)).getJSONObject("stopped");
        assertEquals(runtime, function, stopped.getString("fn"));
        assertTrue(runtime + " " + stopped, stopped.getString("reason").startsWith("typed transfer"));
        assertEquals(runtime, lines(directory, runtime + ".jsonl").size() + 1, stopped.getInt("line"));
    }

    /**
     * 디렉터리의 파일 이름을 정렬해 돌려준다.
     * @param directory 대상 디렉터리
     * @return 파일 이름 목록. 디렉터리가 없으면 빈 목록
     */
    private static List<String> names(File directory) {
        String[] names = directory.list();
        List<String> sorted = names == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(names));
        Collections.sort(sorted);
        return sorted;
    }

    /**
     * 추적 파일의 줄들(UTF-8).
     * @param directory 추적 디렉터리
     * @param name 파일 이름
     * @return 줄 목록
     * @throws IOException 파일 읽기 실패
     */
    private static List<String> lines(File directory, String name) throws IOException {
        return Files.readAllLines(new File(directory, name).toPath(), StandardCharsets.UTF_8);
    }

    /**
     * 호출 줄들의 fn 값.
     * @param lines 추적 줄 목록
     * @return 줄 순서대로의 함수 이름
     * @throws Exception JSON이 아닌 줄
     */
    private static List<String> functions(List<String> lines) throws Exception {
        List<String> functions = new ArrayList<>();
        for (String line : lines) functions.add(new JSONObject(line).getString("fn"));
        return functions;
    }

    /**
     * 파일이나 디렉터리를 지운다. 없으면 아무것도 하지 않는다.
     * @param file 지울 경로
     * @throws IOException 지우지 못한 경우(경로를 메시지에 담는다)
     */
    private static void deleteRecursively(File file) throws IOException {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        if (file.exists() && !file.delete()) throw new IOException("Could not delete trace test file " + file.getAbsolutePath() + "; remove it manually and rerun");
    }
}
