package dev.aster.consumer

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import dev.aster.charts.AsterChartView
import dev.aster.charts.AsterColumns
import dev.aster.charts.AsterEngine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.sin

private object ConsumerRun {
    val checks = JSONArray()
    val jobs = JSONArray()
    val jobContracts = JSONArray()
    val scenarios = JSONArray()
    val completed = mutableSetOf<String>()
    val oracles = JSONObject()
    val closed = JSONObject()
    val lifecycle = JSONArray()
    var stage = "initial"
    var generations = 0
    var terminalCount = 0
    var progressCount = 0
    @Volatile var finished = false
    @Volatile var failure: String? = null
}

/** Independent app package. Imports only the AAR's public Java API. */
class ConsumerActivity : Activity() {
    private lateinit var engine: AsterEngine
    private lateinit var chart: AsterChartView
    private val handler = Handler(Looper.getMainLooper())
    private val generation = ++ConsumerRun.generations
    private var savedDrawings = ""
    private var expectedClose = DoubleArray(512)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        try {
            engine = AsterEngine(this, 0)
            chart = AsterChartView(this, engine)
            setContentView(chart)
            ConsumerRun.lifecycle.put("create:$generation")
            if (intent.getBooleanExtra("sdk-self-test", false)) {
                if (ConsumerRun.stage == "recreating") handler.postDelayed({ replacement() }, 200)
                else handler.postDelayed({ prepare() }, 200)
            }
        } catch (error: Throwable) { fail(error) }
    }

    private fun check(value: Boolean, reason: String) {
        if (!value) throw AssertionError(reason)
        ConsumerRun.checks.put(reason)
    }
    private fun complete(id: String) {
        if (!ConsumerRun.completed.add(id)) throw AssertionError("duplicate completed scenario: $id")
        ConsumerRun.scenarios.put(id)
    }
    private fun contract(): JSONObject = JSONObject().put("schema", "aster.kotlin-consumer").put("version", 1)
        .put("complete", ConsumerRun.stage == "complete").put("baseline", JSONObject()
            .put("scenarios", ConsumerRun.scenarios).put("jobs", ConsumerRun.jobContracts)
            .put("oracles", ConsumerRun.oracles).put("closed", ConsumerRun.closed)).put("study", StudyContract.report())
    private fun fixture(): Array<DoubleArray> = Array(6) { slot ->
        DoubleArray(512) { index ->
            val price = 100.0 + index * 0.025
            when (slot) {
                0 -> 1700000000000.0 + index * 60000.0
                1 -> price
                2 -> price + 2
                3 -> price - 2
                4 -> price + sin(index * 0.1)
                else -> 1000.0 + index
            }
        }
    }
    private fun columns(raw: Array<DoubleArray>): JSONObject = JSONObject().apply {
        arrayOf("time", "open", "high", "low", "close", "volume").forEachIndexed { slot, name ->
            put(name, JSONArray().apply { raw[slot].forEach { put(it) } })
        }
    }
    private fun state(): JSONObject = engine.command("inspect") as JSONObject
    private fun smaReference(phase: String) {
        val actual = engine.command("indicatorValues", "consumer-sma", "value") as JSONArray
        check(actual.length() == 512, "public indicator output has all512 logical values")
        for (index in 0 until 512) {
            if (index < 13) check(actual.isNull(index), "SMA warmup[$index] is a gap")
            else {
                var sum = 0.0
                for (input in index - 13..index) sum += expectedClose[input]
                check(abs(actual.getDouble(index) - sum / 14) < 1e-9, "independent14-bar SMA[$index]")
            }
        }
        ConsumerRun.oracles.put(phase + "Sma", JSONObject().put("length", 512).put("warmup", 13).put("values", 499))
        complete("$phase-sma-full-vector")
    }
    private fun prepare() {
        StudyContract.run(this, { prepareBaseline() }, { error -> fail(error) })
    }
    private fun prepareBaseline() {
        try {
            check(getString(dev.aster.charts.R.string.aster_sdk_version).isNotBlank(), "public AAR version resource resolves")
            check(assets.open("licenses/QUICKJS-LICENSE.txt").bufferedReader().use { it.readText() }.contains("Permission is hereby granted"), "packaged QuickJS license accessible")
            check(assets.open("licenses/LICENSE.txt").bufferedReader().use { it.readText() }.contains("Apache License"), "Apache-2.0 product license accessible")
            complete("resources")
            val raw = fixture()
            engine.setColumns(columns(raw))
            check(state().getInt("storedBars") == 512, "external OHLCV loaded through public setColumns")
            complete("external-columns")
            check(!chart.isSystemFontScaleEnabled, "public system fontScale opt-in defaults off")
            val originalFont = state().getJSONObject("theme").getString("font")
            chart.setSystemFontScaleEnabled(true)
            check(chart.isSystemFontScaleEnabled, "public fontScale opt-in enables through AAR")
            chart.setSystemFontScaleEnabled(false)
            check(!chart.isSystemFontScaleEnabled && state().getJSONObject("theme").getString("font") == originalFont, "public fontScale disable restores caller base font")
            complete("font-scale")
            engine.addIndicator("consumer-sma", "sma", JSONObject().put("period", 14))
            val drawing = engine.addDrawing(JSONObject().put("type", "trendline").put("points", JSONArray()
                .put(JSONObject().put("time", raw[0][20]).put("price", 101.0))
                .put(JSONObject().put("time", raw[0][40]).put("price", 102.0))))
            engine.editDrawing(drawing, JSONObject().put("text", "Kotlin SDK 🚀"))
            engine.selectDrawing(drawing)
            chart.setTool("select")
            savedDrawings = engine.saveDrawings()
            check(savedDrawings.contains("Kotlin SDK"), "public drawing add/edit/select/save")
            engine.undo(); engine.redo()
            check(engine.saveDrawings() == savedDrawings, "public undo/redo preserves drawing anchors")
            complete("drawing-history")
            raw[4].indices.forEach { raw[4][it] += 0.3 }
            expectedClose = raw[4].clone()
            val owned = AsterColumns.copyOf(raw[0], raw[1], raw[2], raw[3], raw[4], raw[5])
            val job = engine.prepareColumnsAsync(owned, 128, AsterEngine.AsyncOptions(30000, 64), listener("prepare") { result ->
                check(result.succeeded(), "owned-column prepare succeeds via AAR")
                check(result.metrics.getLong("immutableInputBytes") == 512L * 6 * 8, "public async result preserves owned-input metrics")
                check(state().getJSONObject("lastBar").getDouble("close") == expectedClose[511], "caller mutation does not affect owned prepare")
                check(engine.saveDrawings() == savedDrawings, "async prepare preserves drawing document")
                complete("prepare-owned-input")
                smaReference("prepare")
                correction()
            })
            check(job != null, "public AsyncJob handle returned")
            raw[4][511] = 900.0
        } catch (error: Throwable) { fail(error) }
    }
    private fun listener(name: String, done: (AsterEngine.AsyncResult) -> Unit): AsterEngine.AsyncListener {
        val evidence = JSONObject().put("id", name).put("terminalCount", 0).put("progressCallbacks", 0)
            .put("ownerValid", true).put("orderValid", true)
        ConsumerRun.jobContracts.put(evidence)
        return object : AsterEngine.AsyncListener {
            private var delivered = false
            private fun callbackOrder(): Boolean {
                val owner = Looper.myLooper() == Looper.getMainLooper()
                val ordered = !delivered && !ConsumerRun.finished
                evidence.put("ownerValid", evidence.getBoolean("ownerValid") && owner)
                evidence.put("orderValid", evidence.getBoolean("orderValid") && ordered)
                return owner && ordered
            }
            override fun onProgress(progress: AsterEngine.AsyncProgress) {
                try {
                    if (!callbackOrder()) throw AssertionError("$name progress on owner before terminal")
                    ConsumerRun.progressCount++
                    evidence.put("progressCallbacks", evidence.getInt("progressCallbacks") + 1)
                } catch (error: Throwable) { fail(error) }
            }
            override fun onComplete(result: AsterEngine.AsyncResult) {
                try {
                    evidence.put("terminalCount", evidence.getInt("terminalCount") + 1).put("status", result.status)
                    check(callbackOrder(), "$name exactly one owner terminal")
                    delivered = true
                    ConsumerRun.terminalCount++
                    ConsumerRun.jobs.put(result.toJSON())
                    done(result)
                } catch (error: Throwable) { fail(error) }
            }
        }
    }
    private fun correction() {
        val bar = JSONObject(state().getJSONObject("lastBar").toString())
        expectedClose[511] += 0.2
        bar.put("close", expectedClose[511])
        engine.applyDataEventAsync(JSONObject().put("kind", "correction").put("bar", bar), listener("correction") { result ->
            check(result.succeeded(), "external historical correction succeeds through public async API")
            complete("correction-success")
            smaReference("correction")
            val cancelled = engine.prepareSeededAsync(1024, 42, 128, listener("cancel") { terminal ->
                check(terminal.status == "cancelled", "public cancellation terminates once")
                check(state().getJSONObject("lastBar").getDouble("close") == expectedClose[511], "cancellation preserves external corrected source")
                check(engine.saveDrawings() == savedDrawings, "cancellation preserves saved anchors")
                complete("cancel-source-and-drawings")
                handler.postDelayed({ renderAndWait() }, 200)
            })
            cancelled.cancel()
        })
    }
    private fun renderAndWait() {
        try {
            check(chart.isAttachedToWindow && chart.width > 0 && chart.height > 0, "public View attached and measured")
            val bitmap = Bitmap.createBitmap(chart.width, chart.height, Bitmap.Config.ARGB_8888)
            try {
                chart.draw(Canvas(bitmap))
                check(chart.lastError == null, "public Canvas View renders without engine/JNI errors")
                var changed = 0
                val background = bitmap.getPixel(0, 0)
                for (y in 0 until bitmap.height step 17) for (x in 0 until bitmap.width step 17) if (bitmap.getPixel(x, y) != background) changed++
                check(changed > 20, "offscreen public View draw has chart foreground pixels")
            } finally { bitmap.recycle() }
            check(chart.renderCacheMetrics().getLong("ownedBitmapBytes") > 0, "consumer View owns admitted render cache")
            complete("view-render-and-cache")
            ConsumerRun.stage = "await-background"
            write("kotlin-consumer-ready.json", JSONObject().put("stage", ConsumerRun.stage).put("generation", generation))
        } catch (error: Throwable) { fail(error) }
    }
    override fun onResume() {
        super.onResume()
        ConsumerRun.lifecycle.put("resume:$generation")
        lifecycleMarker()
        if (ConsumerRun.stage == "await-background" && ConsumerRun.lifecycle.toString().contains("stop:1")) {
            complete("background-resume")
            ConsumerRun.stage = "closing"
            handler.postDelayed({ closeAndRecreate() }, 100)
        }
    }
    override fun onPause() { ConsumerRun.lifecycle.put("pause:$generation"); super.onPause(); lifecycleMarker() }
    override fun onStop() { ConsumerRun.lifecycle.put("stop:$generation"); super.onStop(); lifecycleMarker() }
    private fun lifecycleMarker() {
        if (intent.getBooleanExtra("sdk-self-test", false)) write("kotlin-consumer-lifecycle.json", JSONObject().put("stage", ConsumerRun.stage).put("events", ConsumerRun.lifecycle))
    }
    private fun closeAndRecreate() {
        try {
            check(ConsumerRun.terminalCount == 3, "prepare/correction/cancel have exactly three terminals")
            engine.close(); engine.close()
            check(chart.renderCacheMetrics().getBoolean("engineClosed") && chart.renderCacheMetrics().getLong("ownedBitmapBytes") == 0L, "public close releases attached View cache")
            var rejected = false
            try { engine.command("inspect") } catch (_: IllegalStateException) { rejected = true }
            check(rejected, "public closed engine rejects commands")
            ConsumerRun.closed.put("cacheBytes", chart.renderCacheMetrics().getLong("ownedBitmapBytes"))
                .put("engineClosed", chart.renderCacheMetrics().getBoolean("engineClosed")).put("commandsRejected", rejected)
            complete("close-cache-and-rejection")
            ConsumerRun.stage = "recreating"
            recreate()
        } catch (error: Throwable) { fail(error) }
    }
    private fun replacement() {
        try {
            check(generation == 2 && ConsumerRun.lifecycle.toString().contains("destroy:1"), "real Activity recreation destroys previous owner")
            complete("activity-recreate")
            val metrics = engine.runtimeMetrics()
            check(metrics.getLong("processLiveNativeHandles") == 1L, "replacement engine is the only live source/worker JNI handle")
            engine.close(); engine.close()
            ConsumerRun.closed.put("replacementClosed", true)
            complete("replacement-native-ledger-and-close")
            ConsumerRun.stage = "complete"
            ConsumerRun.finished = true
            write("kotlin-consumer-validation.json", JSONObject().put("passed", ConsumerRun.checks.length() + StudyContract.checks.length()).put("baselinePassed", ConsumerRun.checks.length()).put("studyPassed", StudyContract.checks.length()).put("studyChecks", StudyContract.checks).put("studyJobs", StudyContract.jobs).put("studyTerminals", StudyContract.terminals).put("studyProgressCallbacks", StudyContract.progress).put("failed", false)
                .put("checks", ConsumerRun.checks).put("jobs", ConsumerRun.jobs).put("lifecycle", ConsumerRun.lifecycle).put("consumerContract", contract())
                .put("activityGenerations", ConsumerRun.generations).put("terminals", ConsumerRun.terminalCount).put("progressCallbacks", ConsumerRun.progressCount)
                .put("nativeHandleLedgerBeforeReplacementClose", metrics).put("api", Build.VERSION.SDK_INT).put("package", packageName)
                .put("sdkVersion", getString(dev.aster.charts.R.string.aster_sdk_version)).put("physicalDevice", false)
                .put("scope", "Independent Kotlin app consumes local AAR public API; baseline512 OHLCV/SMA/drawing/async/lifecycle checks separately counted; added typed module/save/load/as-of/read-only/error-atomicity and3 isolated module jobs; offscreen Canvas foreground pixels. No display FPS, input latency or universal memory/GC claim."))
        } catch (error: Throwable) { fail(error) }
    }
    override fun onDestroy() {
        StudyContract.close()
        handler.removeCallbacksAndMessages(null)
        if (::engine.isInitialized) engine.close()
        ConsumerRun.lifecycle.put("destroy:$generation")
        super.onDestroy()
    }
    private fun fail(error: Throwable) {
        synchronized(ConsumerRun) {
            ConsumerRun.failure = ConsumerRun.failure ?: error.toString()
            ConsumerRun.finished = true
        }
        write("kotlin-consumer-validation.json", JSONObject().put("failed", true).put("error", error.toString()).put("consumerContract", contract()).put("checks", ConsumerRun.checks).put("studyChecks", StudyContract.checks).put("studyJobs", StudyContract.jobs).put("studyTerminals", StudyContract.terminals).put("lifecycle", ConsumerRun.lifecycle))
    }
    private fun write(name: String, report: JSONObject) {
        synchronized(ConsumerRun) {
            // A callback violation remains failed even if an already queued
            // completion tries to publish a stale success report afterwards.
            if (name == "kotlin-consumer-validation.json" && ConsumerRun.failure != null) {
                report.put("failed", true).put("error", ConsumerRun.failure)
            }
            openFileOutput(name, MODE_PRIVATE).use { it.write(report.toString(2).toByteArray(Charsets.UTF_8)) }
        }
    }
}
