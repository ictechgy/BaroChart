package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** A drawing to add or the fields to change. {@code tool} must not be {@link DrawingTool#SELECT}. */
public final class Drawing {
    /**
     * {@code id} is the drawing id; {@code null} lets the core generate one. {@code text} is the drawing text, or
     * {@code null} when unset.
     */
    @Nullable public final String id, text;
    /** The drawing tool; never {@link DrawingTool#SELECT}. */
    @NonNull public final DrawingTool tool;
    /** Anchor points in data coordinates (unmodifiable). */
    @NonNull public final List<ChartPoint> points;
    /** Id of the panel the drawing belongs to; {@code price} by default. */
    @NonNull public final String panel;
    /** Style overrides, or {@code null} to keep the core defaults. */
    @Nullable public final DrawingStyle style;
    /**
     * {@code locked} and {@code visible} flags. {@code null} leaves the core default when adding a drawing and keeps
     * the current value when updating one.
     */
    @Nullable public final Boolean locked, visible;

    private Drawing(Builder b) {
        id = b.id; tool = b.tool; points = Collections.unmodifiableList(new ArrayList<>(b.points)); panel = b.panel;
        style = b.style; text = b.text; locked = b.locked; visible = b.visible;
    }

    /**
     * Starts a drawing on the {@code price} panel.
     * @param tool the drawing tool; not {@link DrawingTool#SELECT} when the drawing is added
     * @param points anchor points in data coordinates
     * @return a builder for the drawing
     */
    @NonNull public static Builder builder(@NonNull DrawingTool tool, @NonNull List<ChartPoint> points) { return new Builder(tool, points); }

    /** Builder for {@link Drawing}. */
    public static final class Builder {
        private final DrawingTool tool; private final List<ChartPoint> points;
        private String id, text, panel = "price"; private DrawingStyle style; private Boolean locked, visible;

        private Builder(DrawingTool tool, List<ChartPoint> points) { this.tool = Objects.requireNonNull(tool, "tool"); this.points = Objects.requireNonNull(points, "points"); }
        /**
         * Optional stable id; the core generates one when omitted.
         * @param value the drawing id, or {@code null} for a generated one
         * @return this builder
         */
        @NonNull public Builder id(@Nullable String value) { id = value; return this; }
        /**
         * Sets the panel the drawing belongs to.
         * @param value panel id
         * @return this builder
         */
        @NonNull public Builder panel(@NonNull String value) { panel = Objects.requireNonNull(value, "panel"); return this; }
        /**
         * Sets the drawing style.
         * @param value the style, or {@code null} to keep the core defaults
         * @return this builder
         */
        @NonNull public Builder style(@Nullable DrawingStyle value) { style = value; return this; }
        /**
         * Sets the drawing text.
         * @param value the text, or {@code null} for none
         * @return this builder
         */
        @NonNull public Builder text(@Nullable String value) { text = value; return this; }
        /**
         * Sets whether the drawing is locked.
         * @param value the lock state, or {@code null} to leave it unspecified
         * @return this builder
         */
        @NonNull public Builder locked(@Nullable Boolean value) { locked = value; return this; }
        /**
         * Sets whether the drawing is visible.
         * @param value the visibility, or {@code null} to leave it unspecified
         * @return this builder
         */
        @NonNull public Builder visible(@Nullable Boolean value) { visible = value; return this; }
        /**
         * Builds the drawing.
         * @return the drawing
         */
        @NonNull public Drawing build() { return new Drawing(this); }
    }
}
