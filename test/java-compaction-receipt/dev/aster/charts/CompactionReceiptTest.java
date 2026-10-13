package dev.aster.charts;

import org.json.JSONException;

/** Executes only the production nested decoder. Never initializes the JNI-backed Engine. */
public final class CompactionReceiptTest {
    private static int scenarios;
    private static int checks;

    private CompactionReceiptTest() {}

    private static void check(boolean condition, String scenario, String message) {
        checks++;
        if (!condition) throw new AssertionError(scenario + ": " + message);
    }

    private static void accepted(String name, Object removed, boolean expected) throws JSONException {
        check(AsterEngine.CompactionReceipt.changed(removed) == expected, name, "changed flag");
        scenarios++;
        System.out.println("PASS " + name);
    }

    private static void rejected(String name, Object removed, String message) {
        try {
            AsterEngine.CompactionReceipt.changed(removed);
            throw new AssertionError(name + ": malformed removed count was accepted");
        } catch (JSONException error) {
            check(error.getClass() == JSONException.class, name, "checked receipt exception type");
            check(message.equals(error.getMessage()), name, "receipt validation diagnostic");
        }
        scenarios++;
        System.out.println("PASS " + name);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 0) throw new IllegalArgumentException("No arguments expected");
        // Box each number explicitly: Object[]/numeric conditional promotion could mask the type.
        accepted("integer-zero", Integer.valueOf(0), false);
        accepted("long-zero", Long.valueOf(0L), false);
        accepted("double-zero", Double.valueOf(0.0), false);
        accepted("double-negative-zero", Double.valueOf(-0.0), false);
        accepted("integer-one", Integer.valueOf(1), true);
        accepted("long-one", Long.valueOf(1L), true);
        accepted("double-one", Double.valueOf(1.0), true);
        accepted("integer-positive", Integer.valueOf(12345), true);
        accepted("long-positive", Long.valueOf(12345L), true);
        accepted("double-positive", Double.valueOf(12345.0), true);
        accepted("integer-upper-minus-one", Integer.valueOf(4194303), true);
        accepted("long-upper-minus-one", Long.valueOf(4194303L), true);
        accepted("double-upper-minus-one", Double.valueOf(4194303.0), true);
        accepted("integer-upper-bound", Integer.valueOf(4194304), true);
        accepted("long-upper-bound", Long.valueOf(4194304L), true);
        accepted("double-upper-bound", Double.valueOf(4194304.0), true);
        accepted("byte-zero", Byte.valueOf((byte) 0), false);
        accepted("byte-one", Byte.valueOf((byte) 1), true);
        accepted("short-zero", Short.valueOf((short) 0), false);
        accepted("short-one", Short.valueOf((short) 1), true);
        accepted("float-zero", Float.valueOf(0.0f), false);
        accepted("float-one", Float.valueOf(1.0f), true);
        accepted("float-upper-bound", Float.valueOf(4194304.0f), true);
        accepted("float-negative-zero", Float.valueOf(-0.0f), false);

        String numeric = "Compaction removed must be numeric";
        rejected("null", null, numeric);
        rejected("boolean-false", Boolean.FALSE, numeric);
        rejected("boolean-true", Boolean.TRUE, numeric);
        rejected("string-zero", "0", numeric);
        rejected("string-one", "1", numeric);
        rejected("string-maximum", "4194304", numeric);
        rejected("string-fraction", "0.5", numeric);
        rejected("object", new Object(), numeric);
        rejected("character", Character.valueOf('1'), numeric);
        rejected("array", new int[] {1}, numeric);

        String range = "Compaction removed integer range";
        rejected("integer-negative", Integer.valueOf(-1), range);
        rejected("long-negative", Long.valueOf(-1L), range);
        rejected("double-negative", Double.valueOf(-1.0), range);
        rejected("double-negative-fraction", Double.valueOf(-0.5), range);
        rejected("double-negative-subnormal", Double.valueOf(-Double.MIN_VALUE), range);
        rejected("integer-above-bound", Integer.valueOf(4194305), range);
        rejected("long-above-bound", Long.valueOf(4194305L), range);
        rejected("double-above-bound", Double.valueOf(4194305.0), range);
        rejected("long-maximum", Long.valueOf(Long.MAX_VALUE), range);
        rejected("long-minimum", Long.valueOf(Long.MIN_VALUE), range);
        rejected("integer-maximum", Integer.valueOf(Integer.MAX_VALUE), range);
        rejected("integer-minimum", Integer.valueOf(Integer.MIN_VALUE), range);
        rejected("double-maximum", Double.valueOf(Double.MAX_VALUE), range);
        rejected("double-nan", Double.valueOf(Double.NaN), range);
        rejected("double-positive-infinity", Double.valueOf(Double.POSITIVE_INFINITY), range);
        rejected("double-negative-infinity", Double.valueOf(Double.NEGATIVE_INFINITY), range);
        rejected("float-nan", Float.valueOf(Float.NaN), range);
        rejected("float-positive-infinity", Float.valueOf(Float.POSITIVE_INFINITY), range);
        rejected("float-negative-infinity", Float.valueOf(Float.NEGATIVE_INFINITY), range);
        rejected("double-half", Double.valueOf(0.5), range);
        rejected("double-one-and-half", Double.valueOf(1.5), range);
        rejected("double-upper-minus-half", Double.valueOf(4194303.5), range);
        rejected("double-upper-plus-half", Double.valueOf(4194304.5), range);
        rejected("double-positive-subnormal", Double.valueOf(Double.MIN_VALUE), range);
        System.out.println("RESULT scenarios=" + scenarios + " checks=" + checks + " scope=nested-receipt-decoder");
    }
}
