package kr.coden.barochart;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 테스트·디버그 전용 코어 호출 추적(설계 §6.5-1, §7.3, M0 Task 7). 공개 API가 아니다.
 * BaroChartEngine.setTraceDirectoryForTesting으로 디렉터리를 정한 동안 createRuntime이 만드는 런타임마다
 * &lt;디렉터리&gt;/runtime-&lt;n&gt;.jsonl 하나에 JNI call 한 번을 BCJSON 한 줄로 쓴다.
 * <ul>
 * <li>정상 반환: {"fn":…,"args":[…],"ok":…}</li>
 * <li>코어 오류: {"fn":…,"args":[…],"err":{"name":…,"message":…}}</li>
 * </ul>
 * Android 인자와 결과는 이미 JSON 글자다(인자는 org.json, 결과는 QuickJS JSON.stringify). 그래서 글자를 그대로 옮기고,
 * 이 추적에는 BCJSON의 표준 JSON 부분만 나온다(NaN·undefined·F64 토큰이 없다, 설계 §4.2 표준 모드). 인자 글자는 JNI가
 * 같은 규칙(UTF-8, 단독 서로게이트는 '?')으로 코어에 넘기는 바이트와 같게 파일에 쓰인다.
 * 오류는 JNI가 넘기는 'Name: message' 글자를 첫 ': '에서 나눈 것이다. JNI는 code를 넘기지 않으므로 code는 쓰지 않는다.
 * 한 줄로 담을 수 없는 일(Float64Array 타입 전송, JS 오류 이름이 없는 JNI 전송 오류, JSON이 아닌 결과)을 만나면 그 런타임의
 * 기록을 멈추고 옆 파일 &lt;이름&gt;.meta.json에 자리와 이유를 남긴다(Node·Swift 기록기와 같은 모양). 그래서 추적은 언제나
 * 실제 호출의 충실한 앞부분이다. 꺼져 있으면 호출 경로는 volatile 필드 하나만 읽고 돌아가며 파일을 만들지 않는다.
 * 기록기 자신의 실패(파일 쓰기 등)는 엔진 호출을 실패시키지 않고 failuresForTesting에 남긴다.
 */
final class BaroChartTrace {
    /** 지금 켜진 추적 세션. null이면 꺼져 있다. 작업 스레드도 읽으므로 volatile이다. */
    private static volatile Session session;
    /** 마지막으로 디렉터리를 정한 뒤 파일을 쓰지 못한 이유들(개발자용). BaroChartTrace.class로 지킨다. */
    private static final List<String> failures = new ArrayList<>();
    /** 타입 전송에서 멈출 때 남기는 이유. Float64Array 복사는 JSON 줄이 아니라 JNI가 직접 옮긴다. */
    static final String TYPED_TRANSFER = "typed transfer: Float64Array copies are not recorded on Android";

    private BaroChartTrace() {}

    /**
     * 추적 디렉터리를 정한다. 새 디렉터리를 정하면 런타임 번호와 실패 목록을 비운다. null이면 끈다.
     * 끄거나 바꾸면 이전 세션의 모든 런타임 기록을 그 자리에서 닫는다. 그래서 해제된 런타임 주소를 나중에 다른 런타임이
     * 다시 써도 이전 파일에 섞이지 않고, 끈 뒤에는 어떤 파일도 쓰지 않는다.
     * @param directory 추적 디렉터리, 끄려면 null
     */
    static void setDirectory(File directory) {
        Session previous;
        synchronized (BaroChartTrace.class) {
            previous = session;
            session = directory == null ? null : new Session(directory);
            if (directory != null) failures.clear();
        }
        if (previous != null) previous.close();
    }

    /**
     * 마지막으로 디렉터리를 정한 뒤 기록기가 파일을 쓰지 못한 이유들. 비어 있어야 추적이 완전하다.
     * @return 실패 문구 사본
     */
    static List<String> failuresForTesting() {
        synchronized (BaroChartTrace.class) { return new ArrayList<>(failures); }
    }

    /**
     * 새로 만든 런타임에 추적 파일을 붙인다. 런타임을 만든 직후 한 번 부른다(createRuntime). 꺼져 있으면 아무것도 하지 않는다.
     * @param runtime JNI create가 돌려준 핸들
     */
    static void runtimeCreated(long runtime) {
        Session current = session;
        if (current != null) current.attach(runtime);
    }

    /**
     * 런타임의 기록기를 찾는다.
     * @param runtime 런타임 핸들
     * @return 기록기. 꺼져 있거나 이 세션에서 만든 런타임이 아니면 null
     */
    static Recorder recorder(long runtime) {
        Session current = session;
        return current == null ? null : current.recorders.get(runtime);
    }

    /**
     * JNI가 Float64Array를 직접 옮기기 직전에 부른다. 그 복사는 JSON 줄로 담을 수 없으므로 그 런타임의 기록을 멈춘다.
     * @param runtime 런타임 핸들
     * @param function JNI가 부르는 코어 함수(nativeAsyncBuffer 등)
     */
    static void typedTransfer(long runtime, String function) {
        Recorder recorder = recorder(runtime);
        if (recorder != null) recorder.stop(function, TYPED_TRANSFER);
    }

    /**
     * 기록기 자신의 실패를 남긴다. 추적 실패가 엔진 호출을 실패시키면 안 되므로 던지지 않는다.
     * @param message 원인과 경로를 담은 개발자용 문구
     */
    private static void recordFailure(String message) {
        synchronized (BaroChartTrace.class) { failures.add(message); }
    }

    /**
     * 문자열을 JSON.stringify와 같은 글자로 쓴다(짧은 이스케이프, 나머지 제어 문자와 단독 서로게이트는 \\u 16진 소문자).
     * @param text 쓸 문자열
     * @return 따옴표로 감싼 JSON 문자열
     */
    static String quoted(String text) {
        StringBuilder output = new StringBuilder(text.length() + 2).append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            String escape = shortEscape(c);
            if (escape != null) output.append(escape);
            else if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) output.append(c).append(text.charAt(++i));
            else if (c < 0x20 || Character.isSurrogate(c)) output.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
            else output.append(c);
        }
        return output.append('"').toString();
    }

    /**
     * JSON.stringify가 쓰는 짧은 이스케이프.
     * @param c 문자
     * @return 이스케이프 글자, 없으면 null
     */
    private static String shortEscape(char c) {
        switch (c) {
            case '"': return "\\\"";
            case '\\': return "\\\\";
            case '\b': return "\\b";
            case '\t': return "\\t";
            case '\n': return "\\n";
            case '\f': return "\\f";
            case '\r': return "\\r";
            default: return null;
        }
    }

    /**
     * JNI 오류 글자의 앞부분이 JS 오류 이름(식별자)인지 본다. 'TypeError: x'의 'TypeError' 같은 것이다.
     * @param message JNI 오류 글자
     * @param end 이름 끝(첫 ': ' 위치)
     * @return 식별자이면 true
     */
    private static boolean isErrorName(String message, int end) {
        if (end < 1) return false;
        for (int i = 0; i < end; i++) {
            char c = message.charAt(i);
            boolean letter = c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_' || c == '$';
            if (!letter && !(i > 0 && c >= '0' && c <= '9')) return false;
        }
        return true;
    }

    /** 디렉터리 하나에 대한 추적 세션. 런타임 번호와 런타임별 기록기를 담는다. */
    private static final class Session {
        /** 추적 파일을 쓸 디렉터리 */
        private final File directory;
        /** 이 세션에서 만든 런타임의 기록기(핸들 → 기록기). 작업 스레드도 읽는다. */
        private final ConcurrentHashMap<Long, Recorder> recorders = new ConcurrentHashMap<>();
        /** 마지막으로 붙인 런타임 번호. this로 지킨다. */
        private int runtimeCount;
        /** 세션을 닫았는지. this로 지킨다. 닫은 뒤에는 파일을 만들지 않는다. */
        private boolean closed;

        /**
         * 세션을 만든다. 디렉터리는 첫 런타임을 붙일 때 만든다.
         * @param directory 추적 디렉터리
         */
        Session(File directory) { this.directory = directory; }

        /**
         * 다음 번호의 추적 파일을 만들어 런타임에 붙인다. 같은 주소를 다시 쓰는 새 런타임이면 해제된 런타임의 기록기를 바꿔 끼운다.
         * @param runtime 새 런타임 핸들
         */
        synchronized void attach(long runtime) {
            if (closed) return;
            runtimeCount++;
            Recorder recorder = Recorder.create(new File(directory, "runtime-" + runtimeCount + ".jsonl"));
            if (recorder != null) recorders.put(runtime, recorder);
            else recorders.remove(runtime);
        }

        /** 세션을 닫고 모든 기록기를 닫는다. 이 함수가 돌아온 뒤에는 이 세션이 파일에 쓰지 않는다. */
        synchronized void close() {
            closed = true;
            for (Recorder recorder : recorders.values()) recorder.close();
            recorders.clear();
        }
    }

    /** 런타임 하나의 추적 파일. 소유 스레드와 작업 스레드가 차례로 쓸 수 있어 모든 메서드를 this로 동기화한다. */
    static final class Recorder {
        /** 추적 파일 경로 */
        private final File file;
        /** 쓴 줄 수 */
        private int lines;
        /** 기록을 멈췄는지(멈춘 뒤에는 쓰지 않는다) */
        private boolean stopped;
        /** 세션이 닫혔는지(닫힌 뒤에는 쓰지 않는다) */
        private boolean closed;

        /**
         * 기록기를 만든다. 파일은 create가 만든다.
         * @param file 추적 파일 경로
         */
        private Recorder(File file) { this.file = file; }

        /**
         * 추적 파일을 새로 만든다(있으면 비운다). 디렉터리가 없으면 만든다.
         * @param file runtime-&lt;n&gt;.jsonl 경로
         * @return 기록기. 만들지 못하면 null(실패는 failuresForTesting에 남는다)
         */
        static Recorder create(File file) {
            try {
                File parent = file.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    recordFailure("Trace directory could not be created at " + parent + "; check that its parent is writable");
                    return null;
                }
                try (FileOutputStream created = new FileOutputStream(file)) {
                    created.flush();
                }
                return new Recorder(file);
            } catch (IOException | SecurityException error) {
                recordFailure("Trace file could not be created at " + file + ": " + error);
                return null;
            }
        }

        /**
         * 정상 반환을 기록한다. 결과 글자가 JSON이 아니면(함수·심볼 결과의 'undefined', 빈 결과) 멈춘다.
         * @param function 전역 함수 이름
         * @param arguments JNI에 넘긴 인자 JSON 배열 글자
         * @param result JNI가 돌려준 결과 JSON 글자
         */
        synchronized void returned(String function, String arguments, String result) {
            if (stopped || closed) return;
            if (arguments == null) { stop(function, "argument: no JSON text"); return; }
            if (result == null || result.equals("undefined")) { stop(function, "result: no JSON text"); return; }
            append("{\"fn\":" + quoted(function) + ",\"args\":" + arguments + ",\"ok\":" + result + "}");
        }

        /**
         * JNI call이 던진 오류를 기록한다. 'Name: message' 꼴의 IllegalStateException만 코어 오류로 쓰고,
         * 그 밖의 것(인자 크기·개수처럼 코어 전에 막힌 전송 오류, 메모리 부족 등)은 코어 호출로 재현할 수 없으므로 멈춘다.
         * @param function 전역 함수 이름
         * @param arguments JNI에 넘긴 인자 JSON 배열 글자
         * @param error 던져진 오류
         */
        synchronized void threw(String function, String arguments, Throwable error) {
            if (stopped || closed) return;
            String message = error instanceof IllegalStateException ? error.getMessage() : null;
            int separator = message == null ? -1 : message.indexOf(": ");
            if (arguments == null || !isErrorName(message, separator)) {
                stop(function, "error: " + error.getClass().getSimpleName() + " without a JavaScript error name: " + error.getMessage());
                return;
            }
            append("{\"fn\":" + quoted(function) + ",\"args\":" + arguments + ",\"err\":{\"name\":" + quoted(message.substring(0, separator))
                + ",\"message\":" + quoted(message.substring(separator + 2)) + "}}");
        }

        /**
         * 기록을 멈추고 옆 파일 &lt;이름&gt;.meta.json에 멈춘 자리(다음 줄 번호)와 이유를 남긴다.
         * @param function 멈춘 호출의 함수 이름(없으면 null)
         * @param reason 멈춘 이유
         */
        synchronized void stop(String function, String reason) {
            if (stopped || closed) return;
            stopped = true;
            String name = file.getName();
            File meta = new File(file.getParentFile(), name.substring(0, name.length() - ".jsonl".length()) + ".meta.json");
            String text = "{\"stopped\":{\"line\":" + (lines + 1) + ",\"fn\":" + (function == null ? "null" : quoted(function)) + ",\"reason\":" + quoted(reason) + "}}\n";
            try (FileOutputStream output = new FileOutputStream(meta)) {
                output.write(text.getBytes(StandardCharsets.UTF_8));
            } catch (IOException | SecurityException failure) {
                recordFailure("Trace stop could not be recorded at " + meta + ": " + failure);
            }
        }

        /** 세션이 닫혔다. 이 뒤로는 줄도 옆 파일도 쓰지 않는다. */
        synchronized void close() { closed = true; }

        /**
         * 줄 하나를 덧붙인다. 테스트가 중간에 멈춰도 그때까지의 줄이 남도록 바로 쓴다. 실패하면 기록을 멈춘다.
         * @param line BCJSON 줄(줄바꿈 없음)
         */
        private void append(String line) {
            try (FileOutputStream output = new FileOutputStream(file, true)) {
                output.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                lines++;
            } catch (IOException | SecurityException failure) {
                recordFailure("Trace line could not be written to " + file + ": " + failure);
                stopped = true;
            }
        }
    }
}
