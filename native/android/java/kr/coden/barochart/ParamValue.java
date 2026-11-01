package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Objects;

/** An indicator parameter value: a number, text or flag. */
public final class ParamValue {
    private final Object value;

    private ParamValue(Object value) { this.value = value; }

    /**
     * A numeric parameter. Integer periods are numbers too.
     * @param value the number
     * @return a numeric parameter value
     */
    @NonNull public static ParamValue number(double value) { return new ParamValue(value); }
    /**
     * A text parameter such as a source column name.
     * @param value the text
     * @return a text parameter value
     */
    @NonNull public static ParamValue text(@NonNull String value) { return new ParamValue(Objects.requireNonNull(value, "value")); }
    /**
     * A boolean parameter.
     * @param value the flag
     * @return a boolean parameter value
     */
    @NonNull public static ParamValue flag(boolean value) { return new ParamValue(value); }

    /**
     * The boxed value passed to the chart core (Double, String or Boolean).
     * @return the Double, String or Boolean value
     */
    @NonNull public Object value() { return value; }

    @Override public boolean equals(Object other) { return other instanceof ParamValue && value.equals(((ParamValue) other).value); }
    @Override public int hashCode() { return value.hashCode(); }
    @Override public String toString() { return String.valueOf(value); }
}
