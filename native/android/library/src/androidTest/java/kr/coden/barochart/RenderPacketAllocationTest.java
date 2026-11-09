package kr.coden.barochart;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.HardwareRenderer;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Picture;
import android.graphics.RenderNode;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.PixelFormat;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Debug;
import android.os.SystemClock;
import android.util.Log;
import android.view.Surface;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Arrays;
import java.nio.ByteBuffer;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Typed Canvas packet pixel and allocation regression fixture. */
@RunWith(AndroidJUnit4.class)
public final class RenderPacketAllocationTest {
    private static final String TAG = "BaroChartRenderPacket";
    private static final int WIDTH = 256;
    private static final int HEIGHT = 160;
    private static final java.util.regex.Pattern FONT = java.util.regex.Pattern.compile(
        "^((?:(?:bold|italic|normal)\\s+)*)([0-9]+(?:\\.[0-9]+)?)px\\s+(.+)$");

    private static final class Fixture {
        final BaroChartEngine.ScenePacket packet;
        final BaroChartView view;
        Fixture(BaroChartEngine.ScenePacket packet, BaroChartView view) { this.packet = packet; this.view = view; }
    }

    private static Fixture fixture() throws Exception {
        JSONArray strings = new JSONArray()
            .put("#ff0000ff").put("#008000ff").put("#0000ffff").put("#ffa500ff")
            .put("#800080ff").put("#ffffffff").put("12px monospace").put("typed");
        JSONObject metadata = new JSONObject()
            .put("schema", "aster.native.commands").put("version", 1).put("mode", "frame")
            .put("width", WIDTH).put("height", HEIGHT).put("background", "#ffffffff")
            .put("strings", strings)
            .put("layers", new JSONArray().put(new JSONObject().put("commands", 2))
                .put(new JSONObject().put("commands", 2)).put(new JSONObject().put("commands", 3)))
            .put("stats", new JSONObject());
        double[] numbers = concat(
            command(1, 0, 3, 1, 1, -1, -1, new double[] {8, 8, 116, 8, 116, 8, 116, 56}),
            command(2, 1, 2, 0, 0, -1, -1, new double[] {18, 20, 24, 18, 54, 20, 26, 18}),
            command(3, 2, 4, 0, 0, -1, -1, new double[] {22, 108, 66, 78, 108, 108}),
            command(1, 3, -1, 0, 0, -1, -1, new double[] {134, 68, 222, 68}),
            command(4, 0, 3, 0, 0, -1, -1, new double[] {132, 18, 36, 28}),
            command(5, 1, 2, 0, 0, -1, -1, new double[] {184, 18, 34, 28}),
            command(6, 2, -1, 0, 0, 7, 6, new double[] {136, 112}));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        return new Fixture(new BaroChartEngine.ScenePacket(metadata.toString(), numbers),
            new BaroChartView(context, null));
    }

    /** Larger prebuilt stream so Path/RectF churn remains visible beside packet preparation. */
    private static Fixture allocationFixture() throws Exception {
        JSONArray strings = new JSONArray().put("#ff0000ff").put("#008000ff")
            .put("12px monospace").put("typed");
        final int commandCount = 96;
        JSONObject metadata = new JSONObject()
            .put("schema", "aster.native.commands").put("version", 1).put("mode", "scene")
            .put("width", WIDTH).put("height", HEIGHT).put("background", "#ffffffff")
            .put("strings", strings)
            .put("layers", new JSONArray().put(new JSONObject().put("commands", commandCount)))
            .put("stats", new JSONObject());
        double[][] rows = new double[commandCount][];
        for (int i = 0; i < commandCount; i++) {
            float x = 4 + (i % 16) * 15, y = 4 + (i / 16) * 24;
            switch (i % 6) {
                case 0: rows[i] = command(4, 0, 1, 0, 0, -1, -1, new double[] {x, y, 10, 12}); break;
                case 1: rows[i] = command(5, 1, 0, 0, 0, -1, -1, new double[] {x, y, 10, 12}); break;
                case 2: rows[i] = command(6, 0, -1, 0, 0, 3, 2, new double[] {x, y + 12}); break;
                case 3: rows[i] = command(1, 1, -1, 0, 0, -1, -1, new double[] {x, y, x + 10, y + 12}); break;
                case 4: rows[i] = command(2, 0, -1, 0, 0, -1, -1, new double[] {x, y, 8, 8}); break;
                default: rows[i] = command(3, 1, -1, 0, 0, -1, -1, new double[] {x, y + 12, x + 5, y, x + 10, y + 12}); break;
            }
        }
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        return new Fixture(new BaroChartEngine.ScenePacket(metadata.toString(), concat(rows)),
            new BaroChartView(context, null));
    }

    private static double[] command(int op, int color, int fill, int clip, int dashPairs,
                                    int text, int font, double[] args) {
        double[] dash = dashPairs == 0 ? new double[0] : new double[] {6, 3};
        int length = BaroChartEngine.ScenePacket.HEADER + dash.length + args.length;
        double[] out = new double[length];
        out[0] = op; out[1] = length; out[2] = color; out[3] = 2; out[4] = clip;
        // The clipped command deliberately loses part of its line at x=100.
        out[5] = 0; out[6] = 0;
        out[7] = clip == 0 ? WIDTH : 100; out[8] = HEIGHT; out[9] = dash.length;
        out[10] = fill; out[11] = 112; out[12] = text; out[13] = font; out[14] = args.length;
        System.arraycopy(dash, 0, out, BaroChartEngine.ScenePacket.HEADER, dash.length);
        System.arraycopy(args, 0, out, BaroChartEngine.ScenePacket.HEADER + dash.length, args.length);
        return out;
    }

    private static double[] concat(double[]... rows) {
        int length = 0; for (double[] row : rows) length += row.length;
        double[] result = new double[length]; int cursor = 0;
        for (double[] row : rows) { System.arraycopy(row, 0, result, cursor, row.length); cursor += row.length; }
        return result;
    }

    private static int color(String value) {
        if (value.matches("#[0-9a-fA-F]{8}")) value = "#" + value.substring(7, 9) + value.substring(1, 7);
        return android.graphics.Color.parseColor(value);
    }

    /** Allocation-equivalent frozen preparation, matching BaroChartView.preparePacket. */
    private static final class ReferenceFontSpec {
        final Typeface typeface;
        final float size;
        ReferenceFontSpec(Typeface typeface, float size) { this.typeface = typeface; this.size = size; }
    }

    private static final class ReferencePrepared {
        final BaroChartEngine.ScenePacket packet;
        final int background;
        final int[] colors;
        final ReferenceFontSpec[] fonts;
        final DashPathEffect[] dashes;
        ReferencePrepared(BaroChartEngine.ScenePacket packet, int background, int[] colors,
                          ReferenceFontSpec[] fonts, DashPathEffect[] dashes) {
            this.packet = packet; this.background = background; this.colors = colors;
            this.fonts = fonts; this.dashes = dashes;
        }
    }

    private static ReferenceFontSpec referenceFont(String value) {
        java.util.regex.Matcher matcher = FONT.matcher(value);
        if (!matcher.matches()) return new ReferenceFontSpec(Typeface.MONOSPACE, 12);
        String prefix = matcher.group(1);
        String family = matcher.group(3).split(",")[0].trim().replace("\"", "").replace("'", "");
        int style = (prefix.contains("bold") ? Typeface.BOLD : 0)
            | (prefix.contains("italic") ? Typeface.ITALIC : 0);
        return new ReferenceFontSpec(Typeface.create(family, style), Float.parseFloat(matcher.group(2)));
    }

    private static ReferencePrepared prepareReference(BaroChartEngine.ScenePacket packet) {
        int[] colors = new int[packet.strings.length];
        boolean[] parsed = new boolean[colors.length];
        ReferenceFontSpec[] fonts = new ReferenceFontSpec[colors.length];
        DashPathEffect[] dashes = new DashPathEffect[packet.commandCount];
        double[] numbers = packet.numbers;
        int background = color(packet.background);
        for (int i = 0; i < packet.commandCount; i++) {
            int at = packet.commandStarts[i], op = (int) numbers[at];
            int primary = (int) numbers[at + 2], fill = (int) numbers[at + 10];
            if (!parsed[primary]) { colors[primary] = color(packet.strings[primary]); parsed[primary] = true; }
            if (fill >= 0 && (op == 3 || op == 4 || op == 5) && !parsed[fill]) {
                colors[fill] = color(packet.strings[fill]); parsed[fill] = true;
            }
            if (op == 6) {
                int id = (int) numbers[at + 13];
                if (fonts[id] == null) fonts[id] = referenceFont(packet.strings[id]);
            }
            int dash = (int) numbers[at + 9];
            if (dash > 0) {
                float[] intervals = new float[dash];
                for (int j = 0; j < dash; j++) intervals[j] = (float) numbers[at + BaroChartEngine.ScenePacket.HEADER + j];
                dashes[i] = new DashPathEffect(intervals, 0);
            }
        }
        return new ReferencePrepared(packet, background, colors, fonts, dashes);
    }

    /** Frozen pre-optimization behavior: a fresh Path and RectF are used per command. */
    private static void referenceRender(Canvas canvas, BaroChartEngine.ScenePacket packet,
                                        int layer, boolean clear) {
        referenceRender(canvas, packet, layer, clear, new Paint(Paint.ANTI_ALIAS_FLAG));
    }

    /** Same frozen renderer with caller-owned Paint for fair repeated allocation sampling. */
    private static void referenceRender(Canvas canvas, BaroChartEngine.ScenePacket packet,
                                        int layer, boolean clear, Paint paint) {
        if (clear) canvas.drawColor(color(packet.background), android.graphics.PorterDuff.Mode.SRC);
        double[] a = packet.numbers;
        int end = packet.layerStarts[layer] + packet.layerCounts[layer];
        for (int j = packet.layerStarts[layer]; j < end; j++) {
            int h = packet.commandStarts[j], op = (int) a[h], dashCount = (int) a[h + 9];
            int start = h + BaroChartEngine.ScenePacket.HEADER + dashCount;
            int count = (int) a[h + 14], fill = (int) a[h + 10];
            canvas.save();
            try {
                if (a[h + 4] == 1) canvas.clipRect((float) a[h + 5], (float) a[h + 6],
                    (float) (a[h + 5] + a[h + 7]), (float) (a[h + 6] + a[h + 8]));
                paint.setColor(color(packet.strings[(int) a[h + 2]]));
                paint.setStrokeWidth((float) a[h + 3]);
                paint.setStyle(Paint.Style.STROKE);
                if (dashCount != 0) {
                    float[] intervals = new float[dashCount];
                    for (int i = 0; i < dashCount; i++) intervals[i] = (float) a[h + BaroChartEngine.ScenePacket.HEADER + i];
                    paint.setPathEffect(new DashPathEffect(intervals, 0));
                } else paint.setPathEffect(null);
                Path path = new Path();
                if (op == 1) {
                    for (int i = start; i < start + count; i += 4) {
                        path.moveTo((float) a[i], (float) a[i + 1]);
                        path.lineTo((float) a[i + 2], (float) a[i + 3]);
                    }
                    canvas.drawPath(path, paint);
                } else if (op == 2) {
                    paint.setStyle(Paint.Style.FILL);
                    for (int i = start; i < start + count; i += 4) {
                        path.addRect((float) a[i], (float) a[i + 1],
                            (float) (a[i] + a[i + 2]), (float) (a[i + 1] + a[i + 3]), Path.Direction.CW);
                    }
                    canvas.drawPath(path, paint);
                } else if (op == 3 && count >= 2) {
                    path.moveTo((float) a[start], (float) a[start + 1]);
                    for (int i = start + 2; i < start + count; i += 2) path.lineTo((float) a[i], (float) a[i + 1]);
                    canvas.drawPath(path, paint);
                    if (fill >= 0) {
                        paint.setStyle(Paint.Style.FILL); paint.setColor(color(packet.strings[fill]));
                        path.lineTo((float) a[start + count - 2], (float) a[h + 11]);
                        path.lineTo((float) a[start], (float) a[h + 11]); path.close(); canvas.drawPath(path, paint);
                    }
                } else if (op == 4 || op == 5) {
                    RectF rect = new RectF((float) a[start], (float) a[start + 1],
                        (float) (a[start] + a[start + 2]), (float) (a[start + 1] + a[start + 3]));
                    if (fill >= 0) {
                        paint.setStyle(Paint.Style.FILL); paint.setColor(color(packet.strings[fill]));
                        if (op == 4) canvas.drawRect(rect, paint); else canvas.drawOval(rect, paint);
                    }
                    paint.setStyle(Paint.Style.STROKE); paint.setColor(color(packet.strings[(int) a[h + 2]]));
                    if (op == 4) canvas.drawRect(rect, paint); else canvas.drawOval(rect, paint);
                } else if (op == 6) {
                    paint.setStyle(Paint.Style.FILL);
                    java.util.regex.Matcher matcher = FONT.matcher(packet.strings[(int) a[h + 13]]);
                    if (matcher.matches()) {
                        String prefix = matcher.group(1);
                        String family = matcher.group(3).split(",")[0].trim().replace("\"", "").replace("'", "");
                        int style = (prefix.contains("bold") ? Typeface.BOLD : 0)
                            | (prefix.contains("italic") ? Typeface.ITALIC : 0);
                        paint.setTypeface(Typeface.create(family, style));
                        paint.setTextSize(Float.parseFloat(matcher.group(2)));
                    } else {
                        paint.setTypeface(Typeface.MONOSPACE); paint.setTextSize(12);
                    }
                    canvas.drawText(packet.strings[(int) a[h + 12]], (float) a[start], (float) a[start + 1], paint);
                }
            } finally { canvas.restore(); }
        }
    }

    /** Frozen render loop after one packet preparation, matching the old renderPrepared allocation shape. */
    private static void referencePreparedRender(Canvas canvas, ReferencePrepared prepared,
                                                int layer, boolean clear, Paint paint) {
        BaroChartEngine.ScenePacket packet = prepared.packet;
        if (clear) canvas.drawColor(prepared.background, android.graphics.PorterDuff.Mode.SRC);
        double[] a = packet.numbers;
        int end = packet.layerStarts[layer] + packet.layerCounts[layer];
        for (int j = packet.layerStarts[layer]; j < end; j++) {
            int h = packet.commandStarts[j], op = (int) a[h], dashCount = (int) a[h + 9];
            int start = h + BaroChartEngine.ScenePacket.HEADER + dashCount;
            int count = (int) a[h + 14], fill = (int) a[h + 10];
            canvas.save();
            try {
                if (a[h + 4] == 1) canvas.clipRect((float) a[h + 5], (float) a[h + 6],
                    (float) (a[h + 5] + a[h + 7]), (float) (a[h + 6] + a[h + 8]));
                paint.setColor(prepared.colors[(int) a[h + 2]]);
                paint.setStrokeWidth((float) a[h + 3]);
                paint.setStyle(Paint.Style.STROKE);
                paint.setPathEffect(prepared.dashes[j]);
                Path path = new Path();
                if (op == 1) {
                    for (int i = start; i < start + count; i += 4) {
                        path.moveTo((float) a[i], (float) a[i + 1]);
                        path.lineTo((float) a[i + 2], (float) a[i + 3]);
                    }
                    canvas.drawPath(path, paint);
                } else if (op == 2) {
                    paint.setStyle(Paint.Style.FILL);
                    for (int i = start; i < start + count; i += 4) {
                        path.addRect((float) a[i], (float) a[i + 1],
                            (float) (a[i] + a[i + 2]), (float) (a[i + 1] + a[i + 3]), Path.Direction.CW);
                    }
                    canvas.drawPath(path, paint);
                } else if (op == 3 && count >= 2) {
                    path.moveTo((float) a[start], (float) a[start + 1]);
                    for (int i = start + 2; i < start + count; i += 2) path.lineTo((float) a[i], (float) a[i + 1]);
                    canvas.drawPath(path, paint);
                    if (fill >= 0) {
                        paint.setStyle(Paint.Style.FILL); paint.setColor(prepared.colors[fill]);
                        path.lineTo((float) a[start + count - 2], (float) a[h + 11]);
                        path.lineTo((float) a[start], (float) a[h + 11]); path.close(); canvas.drawPath(path, paint);
                    }
                } else if (op == 4 || op == 5) {
                    RectF rect = new RectF((float) a[start], (float) a[start + 1],
                        (float) (a[start] + a[start + 2]), (float) (a[start + 1] + a[start + 3]));
                    if (fill >= 0) {
                        paint.setStyle(Paint.Style.FILL); paint.setColor(prepared.colors[fill]);
                        if (op == 4) canvas.drawRect(rect, paint); else canvas.drawOval(rect, paint);
                    }
                    paint.setStyle(Paint.Style.STROKE); paint.setColor(prepared.colors[(int) a[h + 2]]);
                    if (op == 4) canvas.drawRect(rect, paint); else canvas.drawOval(rect, paint);
                } else if (op == 6) {
                    ReferenceFontSpec font = prepared.fonts[(int) a[h + 13]];
                    paint.setStyle(Paint.Style.FILL); paint.setTypeface(font.typeface); paint.setTextSize(font.size);
                    canvas.drawText(packet.strings[(int) a[h + 12]], (float) a[start], (float) a[start + 1], paint);
                }
            } finally { canvas.restore(); }
        }
    }

    private static Bitmap recordingRender(BaroChartView view, BaroChartEngine.ScenePacket packet,
                                          boolean reference) throws Exception {
        Bitmap result = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888);
        Picture picture = new Picture();
        Canvas recorded = picture.beginRecording(WIDTH, HEIGHT);
        boolean recordingOpen = true;
        Throwable recordingFailure = null;
        try {
            for (int layer = 0; layer < packet.layerCounts.length; layer++) {
                boolean clear = layer == 0;
                if (reference) referenceRender(recorded, packet, layer, clear);
                else view.renderPacket(recorded, packet, layer, clear);
            }
        } catch (Exception error) {
            recordingFailure = error;
            throw error;
        } catch (Error error) {
            recordingFailure = error;
            throw error;
        } finally {
            if (recordingOpen) {
                try { picture.endRecording(); }
                catch (Exception endError) { if (recordingFailure != null) recordingFailure.addSuppressed(endError); else throw endError; }
                catch (Error endError) { if (recordingFailure != null) recordingFailure.addSuppressed(endError); else throw endError; }
            }
        }
        picture.draw(new Canvas(result));
        return result;
    }

    private static final class HardwareUnavailable extends Exception {
        private static final long serialVersionUID = 1L;
        HardwareUnavailable(String message, Throwable cause) { super(message, cause); }
        HardwareUnavailable(String message) { super(message); }
    }

    /**
     * Records the complete packet into an API29+ RenderNode and reads the rendered RGBA image back from a
     * Surface-backed ImageReader. This is deliberately separate from Picture: Picture is a software replay
     * container and does not exercise HWUI display-list recording.
     */
    private static byte[] hardwareRender(BaroChartView view, BaroChartEngine.ScenePacket packet,
                                         boolean reference) throws Exception {
        if (Build.VERSION.SDK_INT < 29) throw new HardwareUnavailable("RenderNode requires API29");
        RenderNode node = null;
        ImageReader reader = null;
        Surface surface = null;
        HardwareRenderer renderer = null;
        Throwable primary = null;
        try {
            try {
                node = new RenderNode(TAG + (reference ? "-reference" : "-candidate"));
                node.setPosition(0, 0, WIDTH, HEIGHT);
            } catch (UnsupportedOperationException | IllegalStateException unavailable) {
                throw new HardwareUnavailable("RenderNode setup unavailable: " + unavailable, unavailable);
            }

            boolean recordingOpen = false;
            Throwable recordingFailure = null;
            try {
                Canvas recorded = node.beginRecording(WIDTH, HEIGHT);
                recordingOpen = true;
                for (int layer = 0; layer < packet.layerCounts.length; layer++) {
                    boolean clear = layer == 0;
                    if (reference) referenceRender(recorded, packet, layer, clear);
                    else view.renderPacket(recorded, packet, layer, clear);
                }
            } catch (Exception error) {
                recordingFailure = error;
                throw error;
            } catch (Error error) {
                recordingFailure = error;
                throw error;
            } finally {
                if (recordingOpen) {
                    try { node.endRecording(); }
                    catch (Exception endError) { if (recordingFailure != null) recordingFailure.addSuppressed(endError); else throw endError; }
                    catch (Error endError) { if (recordingFailure != null) recordingFailure.addSuppressed(endError); else throw endError; }
                }
            }

            try {
                reader = ImageReader.newInstance(WIDTH, HEIGHT, PixelFormat.RGBA_8888, 3);
                surface = reader.getSurface();
                if (surface == null || !surface.isValid()) throw new HardwareUnavailable("ImageReader surface invalid");
                renderer = new HardwareRenderer();
                renderer.setName(TAG);
                renderer.setSurface(surface);
                renderer.setContentRoot(node);
            } catch (UnsupportedOperationException | IllegalStateException unavailable) {
                throw new HardwareUnavailable("HWUI/ImageReader setup unavailable: " + unavailable, unavailable);
            }
            int status;
            try {
                status = renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw();
            } catch (UnsupportedOperationException | IllegalStateException unavailable) {
                throw new HardwareUnavailable("HWUI sync unavailable: " + unavailable, unavailable);
            }
            if (status != HardwareRenderer.SYNC_OK && status != HardwareRenderer.SYNC_REDRAW_REQUESTED) {
                throw new HardwareUnavailable("HardwareRenderer sync status=" + status);
            }
            Image image = null;
            Throwable imagePrimary = null;
            try {
                image = awaitImage(reader);
                if (image == null) throw new HardwareUnavailable("ImageReader produced no frame");
                return packedImageBytes(image);
            } catch (Exception error) {
                imagePrimary = error;
                throw error;
            } catch (Error error) {
                imagePrimary = error;
                throw error;
            } finally {
                if (image != null) {
                    try { image.close(); }
                    catch (Exception closeError) { if (imagePrimary != null) imagePrimary.addSuppressed(closeError); else throw closeError; }
                    catch (Error closeError) { if (imagePrimary != null) imagePrimary.addSuppressed(closeError); else throw closeError; }
                }
            }
        } catch (Exception error) {
            primary = error;
            throw error;
        } catch (Error error) {
            primary = error;
            throw error;
        } finally {
            Throwable cleanup = cleanupHardware(renderer, surface, reader, node);
            if (cleanup != null) {
                if (primary != null) primary.addSuppressed(cleanup);
                else if (cleanup instanceof Exception) throw (Exception) cleanup;
                else if (cleanup instanceof Error) throw (Error) cleanup;
                else throw new AssertionError(cleanup);
            }
        }
    }

    private static Throwable addCleanupFailure(Throwable first, Throwable next) {
        if (first == null) return next;
        first.addSuppressed(next);
        return first;
    }

    /** Attempts every release, returning the first cleanup failure with later failures suppressed. */
    private static Throwable cleanupHardware(HardwareRenderer renderer, Surface surface,
                                             ImageReader reader, RenderNode node) {
        Throwable failure = null;
        if (renderer != null) {
            try { renderer.setContentRoot(null); }
            catch (RuntimeException error) { failure = addCleanupFailure(failure, error); }
            catch (Error error) { failure = addCleanupFailure(failure, error); }
            try { renderer.setSurface(null); }
            catch (RuntimeException error) { failure = addCleanupFailure(failure, error); }
            catch (Error error) { failure = addCleanupFailure(failure, error); }
            try { renderer.destroy(); }
            catch (RuntimeException error) { failure = addCleanupFailure(failure, error); }
            catch (Error error) { failure = addCleanupFailure(failure, error); }
        }
        if (surface != null) {
            try { surface.release(); }
            catch (RuntimeException error) { failure = addCleanupFailure(failure, error); }
            catch (Error error) { failure = addCleanupFailure(failure, error); }
        }
        if (reader != null) {
            try { reader.close(); }
            catch (RuntimeException error) { failure = addCleanupFailure(failure, error); }
            catch (Error error) { failure = addCleanupFailure(failure, error); }
        }
        if (node != null) {
            try { node.discardDisplayList(); }
            catch (RuntimeException error) { failure = addCleanupFailure(failure, error); }
            catch (Error error) { failure = addCleanupFailure(failure, error); }
        }
        return failure;
    }

    private static Image awaitImage(ImageReader reader) {
        for (int attempt = 0; attempt < 100; attempt++) {
            Image image = reader.acquireLatestImage();
            if (image != null) return image;
            SystemClock.sleep(10);
        }
        return null;
    }

    private static byte[] packedImageBytes(Image image) throws HardwareUnavailable {
        Image.Plane[] planes = image.getPlanes();
        if (planes == null || planes.length != 1) throw new HardwareUnavailable("Expected one RGBA plane");
        Image.Plane plane = planes[0];
        int pixelStride = plane.getPixelStride(), rowStride = plane.getRowStride();
        if (pixelStride != 4 || rowStride < WIDTH * 4) throw new HardwareUnavailable("Unexpected RGBA stride");
        ByteBuffer buffer = plane.getBuffer().duplicate();
        int rowBytes = WIDTH * 4;
        byte[] packed = new byte[rowBytes * HEIGHT];
        int base = buffer.position();
        for (int row = 0; row < HEIGHT; row++) {
            int offset = base + row * rowStride;
            if (offset < 0 || offset + rowBytes > buffer.limit()) throw new HardwareUnavailable("RGBA buffer bounds");
            buffer.position(offset);
            buffer.get(packed, row * rowBytes, rowBytes);
        }
        return packed;
    }

    @Test public void typedPacketMatchesReferenceForAllOperationsAndLayers() throws Exception {
        Fixture fixture = fixture();
        Bitmap actual = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888);
        Bitmap expected = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888);
        Canvas actualCanvas = new Canvas(actual), expectedCanvas = new Canvas(expected);
        for (int layer = 0; layer < fixture.packet.layerCounts.length; layer++) {
            boolean clear = layer == 0;
            fixture.view.renderPacket(actualCanvas, fixture.packet, layer, clear);
            referenceRender(expectedCanvas, fixture.packet, layer, clear);
            assertBitmapEquals("layer " + layer, expected, actual);
        }
    }

    @Test public void typedPacketMatchesReferenceThroughPictureRecording() throws Exception {
        Fixture fixture = fixture();
        assertBitmapEquals("recording canvas", recordingRender(fixture.view, fixture.packet, true),
            recordingRender(fixture.view, fixture.packet, false));
    }

    @Test public void typedPacketMatchesReferenceThroughHardwareRenderNode() throws Exception {
        Assume.assumeTrue("RenderNode/HWUI requires API29+", Build.VERSION.SDK_INT >= 29);
        Fixture fixture = fixture();
        try {
            byte[] expected = hardwareRender(fixture.view, fixture.packet, true);
            byte[] actual = hardwareRender(fixture.view, fixture.packet, false);
            assertTrue("RenderNode RGBA pixels differ", Arrays.equals(expected, actual));
        } catch (HardwareUnavailable unavailable) {
            Log.i(TAG, "RenderNode hardware capture skipped: " + unavailable.getMessage());
            if (Build.VERSION.SDK_INT >= 36) {
                throw new AssertionError("API36+ must execute the RenderNode hardware comparison", unavailable);
            }
            Assume.assumeTrue("RenderNode/ImageReader unsupported: " + unavailable.getMessage(), false);
        }
    }

    @Test public void typedPacketAllocationComparisonIsRecorded() throws Exception {
        Fixture fixture = allocationFixture();
        Bitmap target = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(target);
        final int warmups = 20, iterations = 100, samples = 3;
        for (int i = 0; i < warmups; i++) fixture.view.renderPacket(canvas, fixture.packet, 0, true);
        Paint referencePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        for (int i = 0; i < warmups; i++) {
            ReferencePrepared prepared = prepareReference(fixture.packet);
            referencePreparedRender(canvas, prepared, 0, true, referencePaint);
        }
        long[] candidate = new long[samples], reference = new long[samples];
        for (int sample = 0; sample < samples; sample++) {
            long before = allocationBytes();
            for (int i = 0; i < iterations; i++) fixture.view.renderPacket(canvas, fixture.packet, 0, true);
            candidate[sample] = allocationBytes() - before;
            before = allocationBytes();
            for (int i = 0; i < iterations; i++) {
                ReferencePrepared prepared = prepareReference(fixture.packet);
                referencePreparedRender(canvas, prepared, 0, true, referencePaint);
            }
            reference[sample] = allocationBytes() - before;
            assertTrue("candidate ART allocation sample must advance", candidate[sample] > 0);
            assertTrue("reference ART allocation sample must advance", reference[sample] > 0);
        }
        JSONObject report = new JSONObject().put("schema", "barochart.android-render-allocation")
            .put("scope", "ART managed Java allocation for one prebuilt typed packet")
            .put("counter", "android.os.Debug.getRuntimeStat(art.gc.bytes-allocated)")
            .put("commandCount", fixture.packet.commandCount)
            .put("warmups", warmups).put("iterations", iterations).put("samples", samples)
            .put("implementationRole", "candidate=BaroChartView.renderPacket; frozenReference=old renderPrepared loop")
            .put("includes", "per-call preparePacket plus Java Canvas command rendering")
            .put("excludes", "ScenePacket construction, JNI, Rust/QuickJS, native heap, RSS/PSS, GPU retention")
            .put("artifactIdentity", "host must attach exact APK SHA-256 and BaroChartView.java SHA-256")
            .put("candidateBytes", new JSONArray(candidate)).put("frozenReferenceBytes", new JSONArray(reference));
        Log.i(TAG, report.toString());
    }

    private static long allocationBytes() {
        String value = Debug.getRuntimeStat("art.gc.bytes-allocated");
        if (value == null) throw new AssertionError("ART allocation counter unavailable");
        try {
            long result = Long.parseLong(value.trim());
            if (result < 0) throw new NumberFormatException("negative");
            return result;
        } catch (NumberFormatException error) { throw new AssertionError("ART allocation counter malformed", error); }
    }

    private static void assertBitmapEquals(String label, Bitmap expected, Bitmap actual) {
        assertEquals(label + " width", expected.getWidth(), actual.getWidth());
        assertEquals(label + " height", expected.getHeight(), actual.getHeight());
        int[] expectedPixels = new int[WIDTH * HEIGHT], actualPixels = new int[WIDTH * HEIGHT];
        expected.getPixels(expectedPixels, 0, WIDTH, 0, 0, WIDTH, HEIGHT);
        actual.getPixels(actualPixels, 0, WIDTH, 0, 0, WIDTH, HEIGHT);
        assertTrue(label + " pixels differ", Arrays.equals(expectedPixels, actualPixels));
    }
}
