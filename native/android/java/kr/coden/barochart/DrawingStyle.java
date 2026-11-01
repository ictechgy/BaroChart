package kr.coden.barochart;

import androidx.annotation.Nullable;

/** Portable drawing style. Colors are CSS hex strings such as {@code #f0b755}; {@code null} keeps the core default. */
public final class DrawingStyle {
    /**
     * {@code color} is the line color, {@code fill} the fill color and {@code font} the CSS-style font for text, such
     * as {@code 12px monospace}. {@code null} keeps the core default.
     */
    @Nullable public final String color, fill, font;
    /** Line width, or {@code null} to keep the core default. */
    @Nullable public final Double width;

    /**
     * Creates a style.
     * @param color line color as a CSS hex string, or {@code null}
     * @param fill fill color as a CSS hex string, or {@code null}
     * @param width line width, or {@code null}
     * @param font CSS-style font, or {@code null}
     */
    public DrawingStyle(@Nullable String color, @Nullable String fill, @Nullable Double width, @Nullable String font) {
        this.color = color; this.fill = fill; this.width = width; this.font = font;
    }
}
