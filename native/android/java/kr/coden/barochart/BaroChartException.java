package kr.coden.barochart;

import java.util.concurrent.CancellationException;
import java.util.regex.Pattern;
import org.json.JSONException;

/**
 * The single error type thrown by the BaroChart typed API and reported by chart views.
 *
 * <p>Low-level JSON APIs keep their original exceptions; typed methods convert them with
 * {@link #wrap(Throwable)} so an app can handle every failure through one type. The message
 * states the cause and {@link #getRecovery()} suggests what to do next. Codes match the
 * Swift {@code BaroChartError.Code} cases.</p>
 */
public final class BaroChartException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    /** Stable failure categories, shared with the Swift SDK. */
    public enum Code {
        /** The engine is already closed. */ ENGINE_CLOSED("Create a new BaroChartEngine; a closed engine cannot be reused."),
        /** The engine was used from a thread other than its owner. */ WRONG_THREAD("Call the engine from the thread that created it; engines attached to a view must be created on the main thread."),
        /** An argument or the current chart state is not valid for the operation. */ INVALID_ARGUMENT("Check the value against the documented range and current chart state, then retry."),
        /** The chart core rejected the operation. */ JAVASCRIPT("The chart core rejected the operation; check the message and the operation order."),
        /** The view could not produce a valid scene, for example before it has a size. */ INVALID_SCENE("Lay out the view with a positive size and redraw."),
        /** A data, request or resource budget was exceeded. */ BUDGET_EXCEEDED("Reduce the data or request size, or raise the documented resource budget."),
        /** The operation was cancelled or timed out. */ CANCELLED("The operation was cancelled or timed out; retry if the result is still needed."),
        /** Cleanup from an earlier job is still pending. */ CLEANUP_PENDING("Wait for the pending cleanup to finish or retry cleanup before starting another job."),
        /** The engine cannot run the operation right now. */ UNAVAILABLE("The engine cannot run this now; retry after the active job finishes or recreate the engine.");

        private final String defaultRecovery;
        Code(String defaultRecovery) { this.defaultRecovery = defaultRecovery; }
        /**
         * Standard advice for this category.
         * @return the advice text
         */
        public String defaultRecovery() { return defaultRecovery; }
    }

    /** Failure category. */
    private final Code code;
    /** Suggested next step. */
    private final String recovery;

    /**
     * Creates an exception.
     * @param code failure category
     * @param message cause, in English
     * @param recovery suggested next step; {@code null} uses the code's default advice
     * @param cause low-level exception this one was converted from, or {@code null}
     */
    public BaroChartException(Code code, String message, String recovery, Throwable cause) {
        super(message, cause);
        if (code == null) throw new IllegalArgumentException("BaroChartException code is required");
        this.code = code;
        this.recovery = recovery != null ? recovery : code.defaultRecovery();
    }

    /**
     * Failure category.
     * @return the failure category
     */
    public Code getCode() { return code; }

    /**
     * Suggested next step, in English.
     * @return the recovery advice
     */
    public String getRecovery() { return recovery; }

    @Override public String toString() { return "BaroChartException." + code + ": " + getMessage() + " — " + recovery; }

    /** 저수준 예외를 공통 예외로 바꾼다. 이미 BaroChartException이면 그대로 돌려준다. */
    static BaroChartException wrap(Throwable error) {
        if (error instanceof BaroChartException) return (BaroChartException) error;
        String raw = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        Code code = classify(error, raw);
        return new BaroChartException(code, withoutScriptPrefix(raw), null, error);
    }

    /** 코어 IngestionError 메시지 중 자원 한도 초과를 뜻하는 낱말(Swift와 같은 패턴, 대소문자 무시) */
    private static final Pattern INGESTION_BUDGET = Pattern.compile("(?i)budget|limit|full");

    /** 예외 종류와 메시지로 코드를 고른다(Swift BaroChartError.classify와 같은 규칙) */
    private static Code classify(Throwable error, String message) {
        if (error instanceof BaroChartEngine.IngestionException) return message.matches("(?s).*(budget|limit|full).*") ? Code.BUDGET_EXCEEDED : Code.INVALID_ARGUMENT;
        if (error instanceof CancellationException || error instanceof InterruptedException) return Code.CANCELLED;
        if (error instanceof JSONException || error instanceof IllegalArgumentException) return Code.INVALID_ARGUMENT;
        // TypeError는 형식 검증, SyntaxError는 loadDrawings 등에 넘긴 깨진 JSON이라 둘 다 잘못된 인수다
        if (message.startsWith("TypeError: ") || message.startsWith("SyntaxError: ")) return Code.INVALID_ARGUMENT;
        if (message.startsWith("RangeError: ")) return message.matches("(?is).*(: limit \\d+$|budget|exceeds).*") ? Code.BUDGET_EXCEEDED : Code.INVALID_ARGUMENT;
        // DataEvent.batch의 잘못된 봉은 코어 IngestionError로 온다. 예산 문구만 자원 한도, 나머지는 잘못된 입력이다
        if (message.startsWith("IngestionError: ")) return INGESTION_BUDGET.matcher(withoutScriptPrefix(message)).find() ? Code.BUDGET_EXCEEDED : Code.INVALID_ARGUMENT;
        // 코어 모델이 이미 정리된 경우: 앱 입장에서는 닫힌 엔진과 같다
        if (message.equals("Error: Chart disposed")) return Code.ENGINE_CLOSED;
        if (message.startsWith("Error: ")) return Code.JAVASCRIPT;
        return classifyHostMessage(message);
    }

    /** JS가 아닌 호스트(Java) 메시지 분류 */
    private static Code classifyHostMessage(String message) {
        if (message.equals("Engine closed") || message.equals("Chart engine closed") || message.equals("Engine closing")) return Code.ENGINE_CLOSED;
        if (message.contains("owning thread") || message.contains("main thread") || message.contains("main/UI owner")) return Code.WRONG_THREAD;
        if (message.toLowerCase(java.util.Locale.ROOT).contains("cancel")) return Code.CANCELLED;
        if (message.contains("cleanup")) return Code.CLEANUP_PENDING;
        if (message.contains("budget")) return Code.BUDGET_EXCEEDED;
        return Code.UNAVAILABLE;
    }

    /** "TypeError: x" 같은 JS 예외 접두어를 떼어 원인 문장만 남긴다 */
    private static String withoutScriptPrefix(String message) {
        for (String prefix : new String[]{"TypeError: ", "RangeError: ", "SyntaxError: ", "IngestionError: ", "Error: "}) {
            if (message.startsWith(prefix)) return message.substring(prefix.length());
        }
        return message;
    }
}
