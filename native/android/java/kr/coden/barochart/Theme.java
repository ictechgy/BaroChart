package kr.coden.barochart;

import androidx.annotation.NonNull;
import java.util.Objects;

/** Chart colors (CSS hex) and a CSS-style font such as {@code 12px monospace}. Start from {@link #DARK} or {@link #LIGHT}. */
public final class Theme {
    /**
     * CSS hex colors for the chart background, grid lines, text, rising bars, falling bars and crosshair, and the
     * CSS-style font.
     */
    @NonNull public final String background, grid, text, up, down, crosshair, font;

    /**
     * Creates a theme.
     * @param background background color
     * @param grid grid line color
     * @param text text color
     * @param up color of rising bars
     * @param down color of falling bars
     * @param crosshair crosshair color
     * @param font CSS-style font such as {@code 12px monospace}
     */
    public Theme(@NonNull String background, @NonNull String grid, @NonNull String text, @NonNull String up, @NonNull String down, @NonNull String crosshair, @NonNull String font) {
        this.background = Objects.requireNonNull(background, "background"); this.grid = Objects.requireNonNull(grid, "grid");
        this.text = Objects.requireNonNull(text, "text"); this.up = Objects.requireNonNull(up, "up"); this.down = Objects.requireNonNull(down, "down");
        this.crosshair = Objects.requireNonNull(crosshair, "crosshair"); this.font = Objects.requireNonNull(font, "font");
    }

    /** The chart core dark theme. */
    public static final Theme DARK = new Theme("#0c1320", "#1d2a3a", "#8093ad", "#35d2ab", "#fa6c7c", "#b9c9de", "12px monospace");
    /** The chart core light theme. */
    public static final Theme LIGHT = new Theme("#f8fafc", "#dfe6ee", "#53657d", "#078d6d", "#df344b", "#304158", "12px monospace");
}
