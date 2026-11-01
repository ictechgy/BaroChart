package kr.coden.barochart;

import java.util.concurrent.CancellationException;
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
        ENGINE_CLOSED("Create a new BaroChartEngine; a closed engine cannot be reused."),
        WRONG_THREAD("Call the engine from the thread that created it; engines attached to a view must be created on the main thread."),
        INVALID_ARGUMENT("Check the value against the documented range and current chart state, then retry."),
        JAVASCRIPT("The chart core rejected the operation; check the message and the operation order."),
        INVALID_SCENE("Lay out the view with a positive size and redraw."),
        BUDGET_EXCEEDED("Reduce the data or request size, or raise the documented resource budget."),
        CANCELLED("The operation was cancelled or timed out; retry if the result is still needed."),
        CLEANUP_PENDING("Wait for the pending cleanup to finish or retry cleanup before starting another job."),
        UNAVAILABLE("The engine cannot run this now; retry after the active job finishes or recreate the engine.");

        private final String defaultRecovery;
        Code(String defaultRecovery) { this.defaultRecovery = defaultRecovery; }
        /** Standard advice for this category. */
        public String defaultRecovery() { return defaultRecovery; }
    }

    private final Code code;
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

    /** Failure category. */
    public Code getCode() { return code; }

    /** Suggested next step, in English. */
    public String getRecovery() { return recovery; }

    @Override public String toString() { return "BaroChartException." + code + ": " + getMessage() + " — " + recovery; }

    /** 저수준 예외를 공통 예외로 바꾼다. 이미 BaroChartException이면 그대로 돌려준다. */
    static BaroChartException wrap(Throwable error) {
        if (error instanceof BaroChartException) return (BaroChartException) error;
        String raw = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        Code code = classify(error, raw);
        return new BaroChartException(code, withoutScriptPrefix(raw), null, error);
    }

    /** 예외 종류와 메시지로 코드를 고른다(Swift BaroChartError.classify와 같은 규칙) */
    private static Code classify(Throwable error, String message) {
        if (error instanceof BaroChartEngine.IngestionException) return message.matches("(?s).*(budget|limit|full).*") ? Code.BUDGET_EXCEEDED : Code.INVALID_ARGUMENT;
        if (error instanceof CancellationException || error instanceof InterruptedException) return Code.CANCELLED;
        if (error instanceof JSONException || error instanceof IllegalArgumentException) return Code.INVALID_ARGUMENT;
        if (message.startsWith("TypeError: ")) return Code.INVALID_ARGUMENT;
        if (message.startsWith("RangeError: ")) return message.matches("(?is).*(: limit \\d+$|budget|exceeds).*") ? Code.BUDGET_EXCEEDED : Code.INVALID_ARGUMENT;
        if (message.startsWith("Error: ")) return Code.JAVASCRIPT;
        return classifyHostMessage(message);
    }

    /** JS가 아닌 호스트(Java) 메시지 분류 */
    private static Code classifyHostMessage(String message) {
        if (message.equals("Engine closed") || message.equals("Chart engine closed") || message.equals("Engine closing")) return Code.ENGINE_CLOSED;
        if (message.contains("owning thread") || message.contains("main thread") || message.contains("main/UI owner")) return Code.WRONG_THREAD;
        if (message.contains("cleanup")) return Code.CLEANUP_PENDING;
        if (message.contains("budget")) return Code.BUDGET_EXCEEDED;
        return Code.UNAVAILABLE;
    }

    /** "TypeError: x" 같은 JS 예외 접두어를 떼어 원인 문장만 남긴다 */
    private static String withoutScriptPrefix(String message) {
        for (String prefix : new String[]{"TypeError: ", "RangeError: ", "Error: "}) {
            if (message.startsWith(prefix)) return message.substring(prefix.length());
        }
        return message;
    }
}
