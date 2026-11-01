package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * The fields to change on an existing drawing, for {@link BaroChartEngine#updateDrawing(String, DrawingPatch)}.
 *
 * <p>Only the fields set on the builder are sent; every unset field keeps its current value. For example a patch with
 * only {@code visible(false)} hides a drawing without re-sending its anchors and without moving it to another panel.
 * The drawing id and tool cannot change. Matches the Swift {@code BaroChartDrawingPatch}.</p>
 *
 * <pre>{@code
 * engine.updateDrawing(lineId, DrawingPatch.builder().visible(false).build());
 * }</pre>
 */
public final class DrawingPatch {
    /** The new anchor points in data coordinates (unmodifiable), or {@code null} to keep the current anchors. */
    @Nullable public final List<ChartPoint> points;
    /**
     * {@code panel} is the new panel id and {@code text} the new drawing text. Each is {@code null} to keep the
     * current value.
     */
    @Nullable public final String panel, text;
    /** The new style, or {@code null} to keep the current style. A set style replaces the whole current style. */
    @Nullable public final DrawingStyle style;
    /** The new {@code locked} and {@code visible} flags; {@code null} keeps the current value. */
    @Nullable public final Boolean locked, visible;

    private DrawingPatch(Builder b) {
        points = b.points == null ? null : Collections.unmodifiableList(new ArrayList<>(b.points));
        panel = b.panel; style = b.style; text = b.text; locked = b.locked; visible = b.visible;
    }

    /**
     * Starts an empty patch; an empty patch changes nothing.
     * @return a builder with no fields set
     */
    @NonNull public static Builder builder() { return new Builder(); }

    /** Builder for {@link DrawingPatch}. Each setter marks its field as changed. */
    public static final class Builder {
        private List<ChartPoint> points;
        private String panel, text; private DrawingStyle style; private Boolean locked, visible;

        private Builder() {}
        /**
         * Replaces the anchor points. The list is copied when the patch is built.
         * @param value anchor points in data coordinates
         * @return this builder
         */
        @NonNull public Builder points(@NonNull List<ChartPoint> value) { points = Objects.requireNonNull(value, "points"); return this; }
        /**
         * Moves the drawing to another panel.
         * @param value panel id
         * @return this builder
         */
        @NonNull public Builder panel(@NonNull String value) { panel = Objects.requireNonNull(value, "panel"); return this; }
        /**
         * Replaces the drawing style. Style fields left {@code null} use the core defaults.
         * @param value the style
         * @return this builder
         */
        @NonNull public Builder style(@NonNull DrawingStyle value) { style = Objects.requireNonNull(value, "style"); return this; }
        /**
         * Changes the drawing text.
         * @param value the text
         * @return this builder
         */
        @NonNull public Builder text(@NonNull String value) { text = Objects.requireNonNull(value, "text"); return this; }
        /**
         * Locks or unlocks the drawing. A locked drawing accepts only {@code locked} and {@code visible} changes.
         * @param value true to lock the drawing
         * @return this builder
         */
        @NonNull public Builder locked(boolean value) { locked = value; return this; }
        /**
         * Shows or hides the drawing.
         * @param value true to show the drawing, false to hide it
         * @return this builder
         */
        @NonNull public Builder visible(boolean value) { visible = value; return this; }
        /**
         * Builds the patch.
         * @return the patch
         */
        @NonNull public DrawingPatch build() { return new DrawingPatch(this); }
    }
}
