package dev.aster.ingestion.consumer

import android.app.Activity
import android.os.Bundle
import android.os.Looper
import android.widget.TextView
import dev.aster.charts.AsterEngine
import org.json.JSONArray
import org.json.JSONObject

/** Small independent AAR consumer of the named ingestion API. */
class ConsumerActivity : Activity() {
    private lateinit var engine: AsterEngine
    private val checks = JSONArray()
    private val scenarios = JSONArray()
    private val jobs = JSONArray()
    private var failed: String? = null
    private var terminals = 0
    private var progress = 0
    private var finished = false
    private var sourceClosed = false
    private var targetClosed = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "Independent Kotlin ingestion consumer" })
        try { runContract() } catch (error: Throwable) { fail(error) }
    }
    private fun check(value: Boolean, reason: String) {
        if (!value) throw AssertionError(reason)
        checks.put(reason)
    }
    private fun complete(id: String) { scenarios.put(id) }
    private fun bar(index: Int, close: Double): JSONObject = JSONObject().put("time", 1700000000000L + index * 60000L)
        .put("open", close).put("high", close + 1).put("low", close - 1).put("close", close).put("volume", index + 1)
    private fun event(kind: String, index: Int, close: Double): JSONObject = JSONObject().put("kind", kind).put("bar", bar(index, close))
    private fun packet(sequence: Int, events: JSONArray): JSONObject = JSONObject().put("streamId", "kotlin-feed")
        .put("generation", 3).put("firstSequence", sequence).put("events", events)
    private fun typedError(code: String, action: () -> Unit) {
        var caught: AsterEngine.IngestionException? = null
        try { action() } catch (error: AsterEngine.IngestionException) { caught = error }
        check(caught?.code == code, "typed IngestionException.code = $code")
    }
    private fun conservation(): JSONObject {
        val stats: JSONObject = engine.dataIngestionStats()
        check(stats.getInt("accepted") == stats.getInt("applied") + stats.getInt("cancelled") + stats.getInt("pendingEvents"), "accepted payload conservation")
        check(stats.getInt("pendingBytes") == 49 * stats.getInt("pendingEvents"), "logical pending F64 bytes")
        check(stats.getInt("nextSequence") == 100 + stats.getInt("accepted"), "accepted cursor conservation")
        return stats
    }
    private fun sma(expected: DoubleArray) {
        val values = engine.command("indicatorValues", "small-sma", "value") as JSONArray
        check(values.length() == 4 && values.isNull(0), "small full SMA2 length and warmup")
        for (i in 1..3) check(values.getDouble(i) == expected[i - 1], "small independent SMA2[$i]")
    }
    private fun runContract() {
        engine = AsterEngine(this, 0, JSONObject().put("series", JSONArray()))
        engine.setData(JSONArray().put(bar(0, 10.0)).put(bar(1, 11.0)).put(bar(2, 12.0)))
        engine.addIndicator("small-sma", "sma", JSONObject().put("period", 2))
        val policy = JSONObject().put("streamId", "kotlin-feed").put("generation", 3).put("firstSequence", 100)
            .put("maxQueuedEvents", 4).put("maxQueuedBytes", 196).put("maxBatchEvents", 2).put("maxStoredBars", 16).put("maxStoreBytes", 1536)
        val configured: JSONObject = engine.configureDataIngestion(policy)
        check(configured.getString("state") == "running" && configured.getInt("nextSequence") == 100 && configured.getInt("ownedBytes") == 196, "named typed configure admits fixed owned queue")
        complete("typed-configure")
        val submitted = packet(100, JSONArray().put(event("append", 3, 13.0)).put(event("correction", 1, 11.5)))
        val receipt: JSONObject = engine.enqueueDataEvents(submitted)
        check(receipt.getInt("events") == 2 && receipt.getInt("nextSequence") == 102, "typed enqueue exact receipt")
        submitted.getJSONArray("events").getJSONObject(0).getJSONObject("bar").put("close", 900.0).put("high", 901.0)
        val prefix: JSONObject = engine.drainDataEvents(1)
        check(prefix.getInt("firstSequence") == 100 && prefix.getInt("lastSequence") == 100 && prefix.getInt("events") == 1, "named drain(count) applies one prefix")
        check((engine.command("inspect") as JSONObject).getJSONObject("lastBar").getDouble("close") == 13.0, "submitted queue owns producer packet before mutation")
        check(conservation().getInt("pendingEvents") == 1, "one payload remains after prefix")
        complete("owned-prefix")
        check(engine.pauseDataIngestion().getString("state") == "paused", "named pause")
        typedError("PAUSED") { engine.enqueueDataEvents(packet(102, JSONArray().put(event("update", 3, 14.0)))) }
        check(engine.resumeDataIngestion().getString("state") == "running", "named resume")
        check(engine.drainDataEvents().getInt("lastSequence") == 101, "named default drain keeps sequence")
        sma(doubleArrayOf(10.75, 11.75, 12.5))
        complete("typed-pause-resume-drain")
        typedError("SEQUENCE_MISMATCH") { engine.enqueueDataEvents(packet(101, JSONArray().put(event("update", 3, 14.0)))) }
        engine.enqueueDataEvents(packet(102, JSONArray().put(event("update", 3, 14.0))))
        val cancelled: JSONObject = engine.cancelDataEvents()
        check(cancelled.getInt("events") == 1 && cancelled.getInt("firstSequence") == 102 && cancelled.getInt("lastSequence") == 102, "named cancel explicit range")
        check(conservation().getInt("cancelled") == 1, "cancel conserves accepted payload")
        complete("typed-errors-cancel")
        var notifications = 0
        engine.addChangeListener(Runnable { notifications++ })
        val revision = engine.revision(); val observed = notifications
        val saved: String = engine.saveDataIngestion()
        val stats: JSONObject = engine.dataIngestionStats()
        check(engine.revision() == revision && notifications == observed, "named stats/save preserve revision and observers")
        val receiver = AsterEngine(this, 0, JSONObject().put("series", JSONArray()))
        try {
            receiver.setData(JSONArray().put(bar(0, 10.0)).put(bar(1, 11.5)).put(bar(2, 12.0)).put(bar(3, 13.0)))
            val restored: JSONObject = receiver.loadDataIngestion(saved)
            check(restored.toString() == stats.toString() && receiver.saveDataIngestion() == saved, "named load restores policy/counters/cursor independently")
        } finally { receiver.close(); receiver.close(); targetClosed = true }
        complete("typed-readonly-save-load")
        val before = engine.saveDataIngestion()
        var delivered = false
        engine.applyDataEventAsync(event("correction", 2, 12.5), object : AsterEngine.AsyncListener {
            override fun onProgress(update: AsterEngine.AsyncProgress) {
                try {
                    if (delivered || finished || Looper.myLooper() != Looper.getMainLooper()) throw AssertionError("async progress owner/order")
                    progress++
                } catch (error: Throwable) { fail(error) }
            }
            override fun onComplete(result: AsterEngine.AsyncResult) {
                try {
                    check(!delivered && !finished && Looper.myLooper() == Looper.getMainLooper(), "async exactly one owner terminal")
                    delivered = true; terminals++; jobs.put(result.toJSON())
                    check(result.succeeded(), "actual isolated async correction succeeds")
                    check(engine.saveDataIngestion() == before && conservation().getInt("nextSequence") == 103, "async handoff retains configured policy/ledger/cursor")
                    sma(doubleArrayOf(10.75, 12.0, 12.75))
                    complete("async-policy-handoff")
                    engine.close(); engine.close(); sourceClosed = true; complete("close")
                    finished = true; write(false)
                } catch (error: Throwable) { fail(error) }
            }
        })
        check(engine.dataIngestionStats().getString("state") == "busy", "typed stats exposes native async lease")
        typedError("BUSY") { engine.enqueueDataEvents(packet(103, JSONArray().put(event("update", 3, 14.0)))) }
    }
    private fun fail(error: Throwable) {
        synchronized(this) { failed = failed ?: error.toString(); finished = true; write(true) }
    }
    private fun write(error: Boolean) {
        synchronized(this) {
            val report = JSONObject().put("schema", "aster.kotlin-ingestion-consumer").put("version", 1)
                .put("failed", error || failed != null).put("error", failed ?: JSONObject.NULL).put("passed", checks.length())
                .put("checks", checks).put("scenarios", scenarios).put("jobs", jobs).put("terminals", terminals).put("progressCallbacks", progress)
                .put("sourceClosed", sourceClosed).put("targetClosed", targetClosed).put("sdkVersion", getString(dev.aster.charts.R.string.aster_sdk_version))
            openFileOutput("ingestion-consumer-validation.json", MODE_PRIVATE).use { it.write(report.toString(2).toByteArray(Charsets.UTF_8)) }
        }
    }
    override fun onDestroy() { if (::engine.isInitialized) engine.close(); super.onDestroy() }
}
