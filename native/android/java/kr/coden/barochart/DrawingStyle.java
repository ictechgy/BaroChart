package kr.coden.barochart;

import androidx.annotation.Nullable;

/** Portable drawing style. Colors are CSS hex strings such as {@code #f0b755}; {@code null} keeps the core default. */
public final class DrawingStyle {
    @Nullable public final String color, fill, font;
    @Nullable public final Double width;

    public DrawingStyle(@Nullable String color, @Nullable String fill, @Nullable Double width, @Nullable String font) {
        this.color = color; this.fill = fill; this.width = width; this.font = font;
    }
}
