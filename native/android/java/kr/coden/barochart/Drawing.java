package kr.coden.barochart;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** A drawing to add or the fields to change. {@code tool} must not be {@link DrawingTool#SELECT}. */
public final class Drawing {
    @Nullable public final String id, text;
    @NonNull public final DrawingTool tool;
    @NonNull public final List<ChartPoint> points;
    @NonNull public final String panel;
    @Nullable public final DrawingStyle style;
    @Nullable public final Boolean locked, visible;

    private Drawing(Builder b) {
        id = b.id; tool = b.tool; points = Collections.unmodifiableList(new ArrayList<>(b.points)); panel = b.panel;
        style = b.style; text = b.text; locked = b.locked; visible = b.visible;
    }

    /** Starts a drawing on the {@code price} panel. */
    @NonNull public static Builder builder(@NonNull DrawingTool tool, @NonNull List<ChartPoint> points) { return new Builder(tool, points); }

    /** Builder for {@link Drawing}. */
    public static final class Builder {
        private final DrawingTool tool; private final List<ChartPoint> points;
        private String id, text, panel = "price"; private DrawingStyle style; private Boolean locked, visible;

        private Builder(DrawingTool tool, List<ChartPoint> points) { this.tool = Objects.requireNonNull(tool, "tool"); this.points = Objects.requireNonNull(points, "points"); }
        /** Optional stable id; the core generates one when omitted. */
        @NonNull public Builder id(@Nullable String value) { id = value; return this; }
        @NonNull public Builder panel(@NonNull String value) { panel = Objects.requireNonNull(value, "panel"); return this; }
        @NonNull public Builder style(@Nullable DrawingStyle value) { style = value; return this; }
        @NonNull public Builder text(@Nullable String value) { text = value; return this; }
        @NonNull public Builder locked(@Nullable Boolean value) { locked = value; return this; }
        @NonNull public Builder visible(@Nullable Boolean value) { visible = value; return this; }
        @NonNull public Drawing build() { return new Drawing(this); }
    }
}
