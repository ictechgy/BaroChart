package kr.coden.barochart;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 클라우드에서 작성만 되고 실제 JNI/QuickJS에서 실행된 적 없던 최근 공개 Java API를 실행한다.
 *
 * <p>각 API를 정상 경로 1회와 실패 경로 1회씩 호출한다. 비동기 작업은 메인 루퍼 콜백으로
 * 이어지므로 단계별 메서드를 순서대로 연결한다. 데모 엔진과 섞이지 않도록 전용 엔진을 쓴다.
 * 결과 JSON의 {@code passed}는 통과 검사 수, {@code failed}는 실패 수이며 {@code checks}에 이름을 남긴다.</p>
 */
final class RecentAPIVerification {
    /** 결과 전달 콜백 */
    interface Done { void finished(JSONObject report); }

    private static final JSONObject BINDING = binding("r1");
    private final JSONArray checks = new JSONArray();
    private final JSONArray failures = new JSONArray();
    private final Handler main = new Handler(Looper.getMainLooper());
    private BaroChartEngine engine;
    private BaroChartEngine target;
    private Done done;

    /**
     * 검증을 시작한다. 메인 스레드에서 호출해야 한다.
     * @param context 엔진 생성용 컨텍스트
     * @param callback 모든 단계가 끝나면 한 번 호출된다
     */
    void run(Context context, Done callback) {
        done = callback;
        try {
            engine = new BaroChartEngine(context, 0);
            engine.setData(bars(64, 0));
            engine.addIndicator("recent-ema", "ema", new JSONObject().put("period", 3));
            compaction();
            drawingGroups();
            paramsAsync(context);
        } catch (Throwable error) {
            finish(error);
        }
    }

    /** 보존 창 압축: 정상 축소와 잘못된 옵션 거부 */
    private void compaction() throws JSONException {
        engine.compactData(new JSONObject().put("keepLastBars", 40).put("studyHistory", "restart"));
        require(storedBars(engine) == 40, "compactData keeps the newest 40 bars");
        expectThrow("compactData rejects a non-positive window",
            () -> engine.compactData(new JSONObject().put("keepLastBars", 0).put("studyHistory", "restart")));
    }

    /** 드로잉 묶음 이동·삭제: 정상 경로와 없는 ID 거부 */
    private void drawingGroups() throws JSONException {
        JSONObject point = new JSONObject().put("time", lastTime(engine) - 4 * 60000L).put("price", 101.0);
        String id = engine.addDrawing(new JSONObject().put("id", "recent-line").put("type", "horizontal").put("points", new JSONArray().put(point)));
        String before = engine.saveDrawings();
        engine.translateDrawings(new JSONArray().put(id), 0, 2);
        require(!engine.saveDrawings().equals(before), "translateDrawings moves the stored anchor");
        expectThrow("translateDrawings rejects a missing ID", () -> engine.translateDrawings(new JSONArray().put("missing"), 0, 1));
        engine.deleteDrawings(new JSONArray().put(id));
        require(!engine.saveDrawings().contains("recent-line"), "deleteDrawings removes the drawing");
        expectThrow("deleteDrawings rejects a missing ID", () -> engine.deleteDrawings(new JSONArray().put("missing")));
    }

    /** 비동기 지표 파라미터 변경: 커밋 성공 → 없는 지표 거부 → 작업공간 단계 */
    private void paramsAsync(Context context) throws JSONException {
        engine.setIndicatorParamsAsync("recent-ema", new JSONObject().put("period", 5), result -> step(() -> {
            require(result.succeeded(), "setIndicatorParamsAsync commits a new period");
            missingParams(context);
        }));
    }

    /** 없는 지표에 대한 비동기 파라미터 변경은 호출 시점이나 콜백에서 실패해야 한다 */
    private void missingParams(Context context) throws Exception {
        try {
            engine.setIndicatorParamsAsync("missing-study", new JSONObject().put("period", 5), result -> step(() -> {
                require(!result.succeeded(), "setIndicatorParamsAsync rejects a missing study");
                workspaceAsync(context);
            }));
        } catch (RuntimeException rejected) {
            require(true, "setIndicatorParamsAsync rejects a missing study");
            workspaceAsync(context);
        }
    }

    /** 비동기 작업공간 복원: 저장 → 새 엔진 복원 성공 */
    private void workspaceAsync(Context context) throws Exception {
        String document = engine.saveWorkspace(BINDING);
        target = new BaroChartEngine(context, 0);
        target.setData(bars(64, 24));
        target.restoreWorkspaceAsync(document, BINDING, result -> step(() -> {
            require(result.succeeded() && target.saveWorkspace(BINDING).equals(document), "restoreWorkspaceAsync reproduces the saved document");
            mismatchedWorkspace(document);
        }));
    }

    /** 바인딩이 다른 복원은 호출 시점이나 콜백에서 실패해야 한다 */
    private void mismatchedWorkspace(String document) throws JSONException {
        try {
            target.restoreWorkspaceAsync(document, binding("r2"), result -> step(() -> {
                require(!result.succeeded(), "restoreWorkspaceAsync rejects a mismatched binding");
                finish(null);
            }));
        } catch (RuntimeException rejected) {
            require(true, "restoreWorkspaceAsync rejects a mismatched binding");
            finish(null);
        }
    }

    /** 콜백 안에서 던진 오류도 보고서로 모은다 */
    private void step(ThrowingStep body) {
        try { body.run(); } catch (Throwable error) { finish(error); }
    }

    /** 모든 엔진을 닫고 보고서를 한 번 전달한다 */
    private void finish(Throwable error) {
        if (done == null) return;
        Done callback = done;
        done = null;
        if (error != null) failures.put(error.toString());
        if (target != null) target.close();
        if (engine != null) engine.close();
        try {
            callback.finished(new JSONObject().put("passed", checks.length()).put("failed", failures.length()).put("checks", checks).put("failures", failures));
        } catch (JSONException impossible) {
            throw new IllegalStateException("Recent API report serialization failed", impossible);
        }
    }

    private void require(boolean condition, String name) {
        if (!condition) throw new AssertionError(name);
        checks.put(name);
    }

    private void expectThrow(String name, ThrowingStep body) {
        try { body.run(); } catch (Throwable expected) { checks.put(name); return; }
        throw new AssertionError(name + " unexpectedly succeeded");
    }

    /** 람다에서 checked 예외를 허용하는 단계 */
    private interface ThrowingStep { void run() throws Exception; }

    private static int storedBars(BaroChartEngine value) throws JSONException {
        return ((JSONObject) value.command("inspect")).getInt("storedBars");
    }

    private static long lastTime(BaroChartEngine value) throws JSONException {
        return ((JSONObject) value.command("inspect")).getJSONObject("lastBar").getLong("time");
    }

    /** 1분 간격 합성 봉. from부터 count-from개를 만든다 */
    private static JSONArray bars(int count, int from) throws JSONException {
        JSONArray result = new JSONArray();
        for (int i = from; i < count; i++) {
            double close = 100 + i * 0.1;
            result.put(new JSONObject().put("time", 1700000000000L + i * 60000L).put("open", close).put("high", close + 1)
                .put("low", close - 1).put("close", close).put("volume", 10 + i));
        }
        return result;
    }

    private static JSONObject binding(String revision) {
        try {
            return new JSONObject().put("key", "SYNTH:US").put("revision", revision).put("adjustmentVersion", "a1")
                .put("priceUnit", "USD").put("adjustment", "raw");
        } catch (JSONException impossible) {
            throw new IllegalStateException("Binding construction failed", impossible);
        }
    }
}
