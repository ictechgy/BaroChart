package dev.aster.charts;

import org.json.JSONException;
import org.json.JSONObject;

/** Executes only the production layout receipt decoder; it never creates an Engine. */
public final class LayoutReceiptTest {
    private static int scenarios;
    private static int checks;

    private LayoutReceiptTest() {}

    private static void check(boolean condition, String scenario, String message) {
        checks++;
        if (!condition) throw new AssertionError(scenario + ": " + message);
    }

    private static void acceptedPanelOrder(String name, Object result, boolean expected) throws JSONException {
        check(AsterEngine.LayoutReceipt.panelOrder(result) == expected, name, "changed flag");
        scenarios++;
        System.out.println("PASS " + name);
    }

    private static void rejectedPanelOrder(String name, Object result, String message) {
        try {
            AsterEngine.LayoutReceipt.panelOrder(result);
            throw new AssertionError(name + ": malformed panel order receipt was accepted");
        } catch (JSONException error) {
            check(error.getClass() == JSONException.class, name, "checked receipt exception type");
            check(message.equals(error.getMessage()), name, "receipt validation diagnostic");
        }
        scenarios++;
        System.out.println("PASS " + name);
    }

    private static void acceptedPlacement(String name, Object result, boolean expected) throws JSONException {
        check(AsterEngine.LayoutReceipt.indicatorPlacement(((JSONObject) result).get("changed")) == expected, name, "changed flag");
        scenarios++;
        System.out.println("PASS " + name);
    }

    private static void rejectedPlacement(String name, Object result, String message) {
        try {
            AsterEngine.LayoutReceipt.indicatorPlacement(((JSONObject) result).get("changed"));
            throw new AssertionError(name + ": malformed placement receipt was accepted");
        } catch (JSONException error) {
            check(error.getClass() == JSONException.class, name, "checked receipt exception type");
            check(message.equals(error.getMessage()), name, "receipt validation diagnostic");
        }
        scenarios++;
        System.out.println("PASS " + name);
    }

    private static JSONObject placement(Object changed) throws JSONException {
        return new JSONObject().put("changed", changed);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 0) throw new IllegalArgumentException("No arguments expected");

        acceptedPanelOrder("panel-order-false", Boolean.FALSE, false);
        acceptedPanelOrder("panel-order-true", Boolean.TRUE, true);
        String panelType = "Panel order receipt must be boolean";
        rejectedPanelOrder("panel-order-null", null, panelType);
        rejectedPanelOrder("panel-order-number", Integer.valueOf(1), panelType);
        rejectedPanelOrder("panel-order-string", "true", panelType);

        acceptedPlacement("placement-zero", placement(Integer.valueOf(0)), false);
        acceptedPlacement("placement-one", placement(Long.valueOf(1L)), true);
        acceptedPlacement("placement-upper-bound", placement(Integer.valueOf(256)), true);
        acceptedPlacement("placement-double-upper-bound", placement(Double.valueOf(256.0)), true);

        String numeric = "Indicator placement changed must be numeric";
        rejectedPlacement("placement-missing", new JSONObject(), "No value for changed");
        rejectedPlacement("placement-null", placement(null), numeric);
        rejectedPlacement("placement-boolean", placement(Boolean.FALSE), numeric);
        rejectedPlacement("placement-string", placement("256"), numeric);

        String range = "Indicator placement changed integer range";
        rejectedPlacement("placement-negative", placement(Integer.valueOf(-1)), range);
        rejectedPlacement("placement-fraction", placement(Double.valueOf(0.5)), range);
        rejectedPlacement("placement-upper-bound-plus-one", placement(Integer.valueOf(257)), range);
        rejectedPlacement("placement-infinity", placement(Double.POSITIVE_INFINITY), range);
        rejectedPlacement("placement-nan", placement(Double.NaN), range);
        rejectedPlacement("placement-subnormal", placement(Double.MIN_VALUE), range);

        System.out.println("RESULT scenarios=" + scenarios + " checks=" + checks + " scope=layout-notification-receipt-decoder");
    }
}
