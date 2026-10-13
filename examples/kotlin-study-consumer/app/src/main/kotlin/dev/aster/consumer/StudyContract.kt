package dev.aster.consumer

import android.content.Context
import android.os.Looper
import dev.aster.charts.AsterColumns
import dev.aster.charts.AsterEngine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.sign

/** Task-private typed Kotlin consumer; the SDK is supplied only by its AAR. */
internal object StudyContract {
    val checks = JSONArray()
    val jobs = JSONArray()
    private val jobContracts = JSONArray()
    private val scenarios = JSONArray()
    private val completed = mutableSetOf<String>()
    private val vectorCoverage = JSONObject()
    private var queryCount = 0
    private var sourceClosed = false
    private var targetClosed = false
    private var finished = false
    var terminals = 0
    var progress = 0
    private const val name = "aster.volume-direction@1/pressure"
    private var source: AsterEngine? = null

    private fun check(value: Boolean, reason: String) {
        if (!value) throw AssertionError(reason)
        checks.put(reason)
    }
    private fun complete(id: String) {
        if (!completed.add(id)) throw AssertionError("duplicate completed study scenario: $id")
        scenarios.put(id)
    }
    fun report(): JSONObject = JSONObject().put("scenarios", scenarios).put("jobs", jobContracts)
        .put("oracles", JSONObject().put("asOfQueries", queryCount).put("vectors", vectorCoverage))
        .put("sourceClosed", sourceClosed).put("targetClosed", targetClosed)
    private fun data(closes: DoubleArray): JSONArray = JSONArray().apply {
        closes.forEachIndexed { i, close -> put(JSONObject().put("time", 1700000000000L + i * 60000L)
            .put("open", close).put("high", close + 1).put("low", close - 1).put("close", close).put("volume", intArrayOf(5, 7, 8, 9)[i])) }
    }
    private fun state(engine: AsterEngine): JSONObject = engine.command("inspect") as JSONObject
    private fun vector(engine: AsterEngine, id: String, output: String, expected: DoubleArray, label: String) {
        val actual = engine.command("indicatorValues", id, output) as JSONArray
        check(actual.length() == expected.size, "$label vector length")
        expected.indices.forEach { check(actual.getDouble(it) == expected[it], "$label[$it] independent value") }
        vectorCoverage.put(label, expected.size)
    }
    private fun pressure(closes: DoubleArray, factor: Double): Pair<DoubleArray, DoubleArray> {
        val volume = intArrayOf(5, 7, 8, 9)
        val signed = DoubleArray(closes.size) { i -> if (i == 0) 0.0 else (closes[i] - closes[i - 1]).sign * volume[i] * factor }
        var total = 0.0
        val cumulative = DoubleArray(closes.size) { i -> total += signed[i]; total }
        return signed to cumulative
    }
    private fun query(engine: AsterEngine, id: String, output: String, index: Int, horizon: Int, shift: Int,
                      expected: DoubleArray, plot: Boolean, label: String) {
        val options = JSONObject().put("mode", if (plot) "plot" else "raw").put("asOfIndex", horizon)
        val result: JSONObject = engine.indicatorValueAt(id, output, index, options)
        val sourceIndex = index - if (plot) shift else 0
        if (sourceIndex < 0 || sourceIndex >= expected.size || sourceIndex > horizon) {
            check(result.isNull("value") && result.isNull("sourceIndex") && result.isNull("sourceTime"), "$label unavailable hides all metadata")
        } else {
            check(result.getDouble("value") == expected[sourceIndex] && result.getInt("sourceIndex") == sourceIndex &&
                result.getLong("sourceTime") == 1700000000000L + sourceIndex * 60000L, "$label available-prefix value and metadata")
        }
        queryCount++
    }
    private fun rejected(reason: String, action: () -> Unit): RuntimeException {
        var error: RuntimeException? = null
        try { action() } catch (caught: RuntimeException) { error = caught }
        check(error != null, reason)
        return requireNotNull(error)
    }
    private fun cloneForImport(saved: String): JSONObject {
        val doc = JSONObject(saved)
        val definitions = doc.getJSONArray("indicators")
        for (i in 0 until definitions.length()) {
            val row = definitions.getJSONObject(i); row.put("id", "incoming-" + row.getString("id"))
        }
        val series = doc.getJSONArray("series")
        for (i in 0 until series.length()) {
            val row = series.getJSONObject(i); row.put("id", "incoming-" + row.getString("id")); row.put("indicator", "incoming-" + row.getString("indicator"))
        }
        return doc
    }
    private fun atomicReject(target: AsterEngine, document: String, reason: String, notifications: () -> Int, noEvaluation: Boolean = false) {
        val beforeState = state(target).toString(); val beforeStudies = target.saveStudies()
        val revision = target.revision(); val beforeNotifications = notifications()
        val error = rejected(reason) { target.loadStudies(document) }
        if (noEvaluation) check(!error.message.orEmpty().contains("EVALUATED_UNTRUSTED_PAYLOAD"), "source-bearing study rejects before executing its throwing body")
        check(state(target).toString() == beforeState && target.saveStudies() == beforeStudies, "$reason preserves studies, series, data and layout")
        check(target.revision() == revision && notifications() == beforeNotifications, "$reason does not publish revision or observers")
    }
    fun run(context: Context, done: () -> Unit, failure: (Throwable) -> Unit) {
        var target: AsterEngine? = null
        try {
            val engine = AsterEngine(context, 0, JSONObject().put("series", JSONArray())); source = engine
            var notifications = 0
            engine.addChangeListener(Runnable { notifications++ })
            val original = doubleArrayOf(10.0, 11.0, 11.0, 9.0)
            engine.setData(data(original))
            val registered: JSONArray = engine.registerIndicatorModule("aster.volume-direction", 1)
            check(registered.length() == 1 && registered.getString(0) == name, "typed JSONArray resolves exact linked module export")
            complete("linked-module")
            engine.addIndicator("pressure", name, JSONObject().put("factor", 1).put("shift", 0))
            engine.addIndicator("forward", name, JSONObject().put("factor", .5).put("shift", 2))
            engine.addIndicator("backward", name, JSONObject().put("factor", .5).put("shift", -2))
            engine.addIndicator("cloud", "ichimoku", JSONObject().put("conversion", 2).put("base", 3).put("span", 4).put("displacement", 2))
            engine.addSeries(JSONObject().put("id", "pressure-line").put("type", "line").put("panel", "price").put("indicator", "pressure").put("output", "cumulative").put("color", "#123456").put("width", 3))
            engine.addSeries(JSONObject().put("id", "cloud-line").put("type", "line").put("panel", "price").put("indicator", "cloud").put("output", "spanA"))
            engine.addSeries(JSONObject().put("id", "external-unbound").put("type", "line").put("panel", "price").put("values", JSONArray().put(99).put(99).put(99).put(99)))
            vector(engine, "pressure", "signed", doubleArrayOf(0.0, 7.0, 0.0, -9.0), "sample signed")
            vector(engine, "pressure", "cumulative", doubleArrayOf(0.0, 7.0, 7.0, -2.0), "sample cumulative")
            complete("sample-vectors")
            val beforeRevision = engine.revision(); val beforeNotifications = notifications
            for ((id, shift) in listOf("pressure" to 0, "forward" to 2, "backward" to -2)) {
                val expected = pressure(original, if (id == "pressure") 1.0 else .5)
                for ((output, values) in listOf("signed" to expected.first, "cumulative" to expected.second))
                    for (horizon in -1..3) for (plot in listOf(false, true)) for (index in -3..6)
                        query(engine, id, output, index, horizon, shift, values, plot, "$id/$output/$index/$horizon/$plot")
            }
            complete("asof-matrix")
            val raw: JSONObject = engine.indicatorValueAt("pressure", "signed", 1)
            check(raw.getDouble("value") == 7.0 && raw.getInt("sourceIndex") == 1, "typed three-argument query defaults to raw/latest")
            val warmup = engine.indicatorValueAt("cloud", "spanB", 2, JSONObject().put("mode", "plot").put("asOfIndex", 0))
            check(warmup.isNull("value") && warmup.getInt("sourceIndex") == 0 && warmup.getLong("sourceTime") == 1700000000000L, "known Ichimoku warmup keeps source metadata")
            val future = engine.indicatorValueAt("cloud", "chikou", 0, JSONObject().put("mode", "plot").put("asOfIndex", 1))
            check(future.isNull("value") && future.isNull("sourceIndex") && future.isNull("sourceTime"), "negative Ichimoku offset cannot expose future source")
            val forward = engine.indicatorValueAt("cloud", "spanA", 5, JSONObject().put("mode", "plot"))
            check(forward.getDouble("value") == 10.0 && forward.getInt("sourceIndex") == 3, "positive cloud plot position beyond data maps to known source")
            complete("asof-defaults-and-cloud")
            val saved: String = engine.saveStudies(); val doc = JSONObject(saved)
            check(doc.getString("schema") == "aster.studies" && doc.getInt("version") == 1 && doc.length() == 4, "typed String saves study-only schema/version")
            check(doc.getJSONArray("indicators").length() == 4 && doc.getJSONArray("series").length() == 2, "save omits unbound external array series")
            val descriptor = doc.getJSONArray("indicators").getJSONObject(0).getJSONObject("module")
            check(descriptor.length() == 5 && descriptor.getString("id") == "aster.volume-direction" && descriptor.getInt("version") == 1 &&
                descriptor.getInt("stateVersion") == 1 && descriptor.getString("exportName") == "pressure" && descriptor.getBoolean("causal"), "module descriptor is exact linked identity and state codec")
            check(engine.revision() == beforeRevision && notifications == beforeNotifications, "query and save keep engine revision and observer count unchanged")
            complete("save-schema-descriptor-readonly")
            rejected("missing linked module version is explicitly unsupported") {
                try { engine.registerIndicatorModule("aster.volume-direction", 99) } catch (error: RuntimeException) {
                    check(error.message?.contains("Unsupported", ignoreCase = true) == true, "missing module version error names Unsupported")
                    throw error
                }
            }
            complete("unsupported-module-version")
            val receiver = AsterEngine(context, 0, JSONObject().put("series", JSONArray())); target = receiver
            var targetNotifications = 0; receiver.addChangeListener(Runnable { targetNotifications++ })
            val replacement = doubleArrayOf(20.0, 19.0, 22.0, 18.0); receiver.setData(data(replacement))
            receiver.addIndicator("existing", "sma", JSONObject().put("period", 2))
            receiver.addSeries(JSONObject().put("id", "existing-line").put("type", "line").put("panel", "price").put("indicator", "existing"))
            val drawings = receiver.saveDrawings(); val dataBefore = state(receiver).getJSONObject("lastBar").toString()
            val loadRevision = receiver.revision(); val loadNotifications = targetNotifications
            val counts: JSONObject = receiver.loadStudies(saved)
            check(counts.getInt("indicators") == 4 && counts.getInt("series") == 2, "typed JSONObject reports atomic additive merge counts")
            check(receiver.revision() == loadRevision + 1 && targetNotifications == loadNotifications + 1, "successful study merge publishes one owner notification")
            vector(receiver, "pressure", "signed", doubleArrayOf(0.0, -7.0, 8.0, -9.0), "target recomputed signed")
            vector(receiver, "pressure", "cumulative", doubleArrayOf(0.0, -7.0, 1.0, -8.0), "target recomputed cumulative")
            complete("load-merge-vectors")
            check(state(receiver).getJSONArray("series").getJSONObject(0).getString("id") == "existing-line", "merge preserves existing series order")
            check(state(receiver).getJSONObject("lastBar").toString() == dataBefore && receiver.saveDrawings() == drawings, "study import leaves target data and drawings owned by target")
            complete("load-target-preserved")
            atomicReject(receiver, saved, "duplicate imported IDs reject", { targetNotifications })
            complete("reject-duplicate")
            val missingPanel = cloneForImport(saved); missingPanel.getJSONArray("series").getJSONObject(1).put("panel", "missing")
            atomicReject(receiver, missingPanel.toString(), "late missing-panel import reject", { targetNotifications })
            complete("reject-panel")
            val wrongVersion = cloneForImport(saved); wrongVersion.getJSONArray("indicators").getJSONObject(0).getJSONObject("module").put("version", 99)
            atomicReject(receiver, wrongVersion.toString(), "module-version descriptor reject", { targetNotifications })
            complete("reject-module-version")
            val code = cloneForImport(saved); code.getJSONArray("indicators").getJSONObject(0).put("source", "(()=>{throw new Error('EVALUATED_UNTRUSTED_PAYLOAD')})()")
            atomicReject(receiver, code.toString(), "study payload cannot supply executable source", { targetNotifications }, true)
            complete("reject-executable-source")
            val url = cloneForImport(saved); url.getJSONArray("indicators").getJSONObject(0).put("url", "https://invalid.example/indicator.js")
            atomicReject(receiver, url.toString(), "study payload cannot request URL loading", { targetNotifications })
            complete("reject-url")
            receiver.close(); receiver.close(); targetClosed = true; target = null
            engine.removeSeries("external-unbound")
            val columns = Array(6) { slot -> DoubleArray(4) { index ->
                when (slot) { 0 -> 1700000000000.0 + index * 60000.0; 1 -> replacement[index]; 2 -> replacement[index] + 1; 3 -> replacement[index] - 1; 4 -> replacement[index]; else -> intArrayOf(5, 7, 8, 9)[index].toDouble() }
            } }
            val owned = AsterColumns.copyOf(columns[0], columns[1], columns[2], columns[3], columns[4], columns[5])
            engine.prepareColumnsAsync(owned, 128, AsterEngine.AsyncOptions(30000, 64), listener("module-prepare", failure) { result ->
                check(result.succeeded() && result.metrics.getLong("immutableInputBytes") == 192L, "AAR linked-module owned prepare succeeds and reports immutable bytes")
                vector(engine, "pressure", "cumulative", doubleArrayOf(0.0, -7.0, 1.0, -8.0), "prepared module cumulative")
                check(state(engine).getJSONObject("lastBar").getDouble("close") == 18.0, "owned module prepare ignores post-submit caller array mutation")
                complete("prepare-owned-vectors")
                val corrected = data(doubleArrayOf(20.0, 23.0, 22.0, 18.0)).getJSONObject(1)
                engine.applyDataEventAsync(JSONObject().put("kind", "correction").put("bar", corrected), listener("module-correction", failure) { correction ->
                    check(correction.succeeded(), "AAR module checkpoint restore and correction succeed")
                    vector(engine, "pressure", "signed", doubleArrayOf(0.0, 7.0, -8.0, -9.0), "corrected module signed")
                    vector(engine, "pressure", "cumulative", doubleArrayOf(0.0, 7.0, -1.0, -10.0), "corrected module cumulative")
                    complete("correction-vectors")
                    val current = engine.saveStudies(); val cancel = engine.prepareSeededAsync(1024, 42, 128, listener("module-cancel", failure) { cancelled ->
                        check(cancelled.status == "cancelled" && engine.saveStudies() == current, "module cancellation retains study definitions and source")
                        check(state(engine).getJSONObject("lastBar").getDouble("close") == 18.0 && terminals == 3, "three module jobs deliver once and cancel leaves corrected source")
                        complete("cancel-source-and-studies")
                        engine.close(); engine.close(); source = null; sourceClosed = true
                        complete("close"); finished = true
                        done()
                    }); cancel.cancel()
                })
            }); columns[4][3] = 900.0
        } catch (error: Throwable) { target?.close(); close(); failure(error) }
    }
    private fun listener(label: String, failure: (Throwable) -> Unit, done: (AsterEngine.AsyncResult) -> Unit): AsterEngine.AsyncListener {
        val evidence = JSONObject().put("id", label).put("terminalCount", 0).put("progressCallbacks", 0)
            .put("ownerValid", true).put("orderValid", true)
        jobContracts.put(evidence)
        return object : AsterEngine.AsyncListener {
            private var delivered = false
            private fun callbackOrder(): Boolean {
                val owner = Looper.myLooper() == Looper.getMainLooper()
                val ordered = !delivered && !finished
                evidence.put("ownerValid", evidence.getBoolean("ownerValid") && owner)
                evidence.put("orderValid", evidence.getBoolean("orderValid") && ordered)
                return owner && ordered
            }
            override fun onProgress(update: AsterEngine.AsyncProgress) {
                try {
                    if (!callbackOrder()) throw AssertionError("$label owner progress before terminal")
                    progress++
                    evidence.put("progressCallbacks", evidence.getInt("progressCallbacks") + 1)
                } catch (error: Throwable) {
                    failure(error)
                    if (Looper.myLooper() == Looper.getMainLooper()) close()
                }
            }
            override fun onComplete(result: AsterEngine.AsyncResult) {
                try {
                    evidence.put("terminalCount", evidence.getInt("terminalCount") + 1).put("status", result.status)
                    check(callbackOrder(), "$label exactly one owner terminal")
                    delivered = true; terminals++; jobs.put(result.toJSON()); done(result)
                } catch (error: Throwable) {
                    failure(error)
                    if (Looper.myLooper() == Looper.getMainLooper()) close()
                }
            }
        }
    }
    fun close() { source?.close(); source = null }
}
