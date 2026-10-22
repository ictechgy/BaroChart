# Portable workspace metadata

`saveWorkspace(chartAPI, datasetBinding)` (core/root) and
`prepareWorkspaceAsync(store, text, options)` (root/worker) preserve a chart's
portable configuration across a fresh model. This first slice excludes the source
OHLCV dataset. It requires the host to supply the exact intended BarStore and an
independent dataset binding. It is not full application/session persistence.

```js
import {saveWorkspace, prepareWorkspaceAsync, ChartAPI} from 'barochart';
const datasetBinding = {
  key: 'provider/venue/symbol/1m/session-v1',
  revision: 'feed-revision-42',
  adjustmentVersion: 'corporate-actions-7',
  priceUnit: 'USD',
  adjustment: 'split',
};
const text = saveWorkspace(currentChartAPI, datasetBinding);
const controller = new AbortController();
const readyModel = await prepareWorkspaceAsync(sourceStore, text, {
  datasetBinding, signal: controller.signal, timeoutMs: 30000,
});
// The host mounts readyModel, then tears down its old chart when that succeeds.
// If mounting is abandoned or fails, call readyModel.dispose().
const portableAgain = saveWorkspace(new ChartAPI(readyModel), datasetBinding);
```

The default uses a real dedicated module Worker. Custom modules must be statically
linked, with identical id/version/stateVersion/export and output layout, into both
the owner and Worker entry. `workerFactory(url)` can provide a trusted dedicated
Worker adapter; it cannot serialize a callback factory or execute source from a
workspace. Missing module bindings reject before publication. Core-only synchronous
restore and native host restore facades are not supplied in this slice.

## What is saved

- All panels, independent axes, theme, series visibility/style/order and bindings.
- All indicator definitions/primitive parameters, including hidden indicators,
  ordered output schema and effective default plot offsets. Parameter `-0` retains
  its sign through the numeric codec.
- Symbol metadata, precision, axis width, exact index-based view and follow state.
  Optional `provider` and `adjustmentVersion` strings are preserved when present;
  each must be nonempty and at most128 UTF-16 code units in a workspace. Undefined
  optional fields are omitted on save. Required-only symbol documents remain valid.
  Symbol `adjustmentVersion` is independent of the required dataset binding field;
  it does not replace that assertion or introduce an equality check between them.
  `setSymbol`'s known formatter pair is recreated first, then the saved precision
  override/view/follow are restored. The current known pair uses fixed decimal
  price formatting and the symbol timezone; there are no hidden locale/options
  objects to infer. A model with no formatter pair remains without one.
- Committed drawing objects and exact finite time/price coordinates, including
  fractional/offscreen/market-closure anchors, plus panel/axis/series bindings.
  There is no nearest-bar snapping or implicit session/timeframe conversion.

No source bars, calculated output arrays, checkpoints, undo/redo history,
selection, tool, crosshair, pointer/gesture state, pending ingestion queue, arbitrary
external `series.values`, custom formatter callbacks or executable code are saved.
External values/custom formatters and active pointer/drawing gestures reject export.
A live renderer may support CSS that the portable color/font codec does not; that
configuration rejects export instead of silently changing live styles.

## Dataset identity is explicit, not a fingerprint

All five dataset fields are required nonempty strings, at most128 UTF-16 code
units; adjustment is `raw`, `split` or `total-return`. All must match the separately
supplied restore binding exactly. Symbol currency and adjustment, when present,
must match priceUnit/adjustment. The host should put provider, venue, symbol,
timeframe and session/calendar identity into its key/revision scheme and advance
revision/adjustmentVersion when data or adjustment semantics change.

Source length and first/last UTC millisecond timestamps are checked as additional
assertions; an empty source uses explicit null endpoints. Equal length/endpoints
can hide different interior OHLCV values. These fields do not authenticate data,
prove receipt time, reproduce historical revisions or establish point-in-time
backtest correctness. They cannot protect against a host that reuses an incorrect
revision. The view uses source indices; the strict supplied dataset assertion is
what makes it meaningful, rather than a silent time-based remapping.

## Ownership, cancellation and publication

Preparation returns a **new** ChartModel sharing the caller's real BarStore.
Existing chart/model/store objects are never replaced, disposed or rewritten.
The new model owns its entries/checkpoints/drawings/caches and two internal source
subscriptions. Disposing either model leaves the other and the source alive.
Caller-owned and held old arrays are neither detached nor reused as scratch.

Actual managed source version, columns, length and capacity are guarded from capture
through final publication. An update/append/correction/reset/prepend during the job
rejects with StaleSourceError; no automatic retry occurs. Direct raw column writes
or accessor/Proxy rewrites of SDK internals are unsupported. A continuously
updating feed may need a host-controlled stable revision window.

Preabort rejects before document/binding access or Worker construction. A monotonic
0..120000ms timeout (default30000) covers snapshot, calculation, validation and
cleanup. Worker termination and listener removal occur before the final callback-free
source check and return publication. Late packets are ignored. Unpublished candidates
are disposed on every failure, cancellation or timeout. A cancellation after successful
publication cannot revoke the model; the caller must dispose it if unwanted.

Progress has snapshot/compute/validate phases. Validate progress sums all entries
and is monotonic within that phase. Progress callback exceptions are isolated;
a callback-triggered abort or managed mutation is still checked. No callback or
await occurs between the final source guard and publication. Host mounting and old
chart teardown are separate responsibilities; a failed host UI operation is not
an SDK-controlled rollback transaction.

The packet validation establishes structure/bindings/ownership, not arithmetic
attestation of an untrusted Worker. Worker modules and custom indicator factories
remain trusted application code. Ordinary documents are untrusted data.

## Bounded document and calculation costs

- Strict schema `aster.workspace`, version1. Unknown fields/versions, duplicate ids,
  dangling panel/axis/series references and module/layout mismatches reject.
- Both writer and reader cap documents at2,097,152 UTF-16 code units and4,194,304
  UTF-8 bytes, with depth32/nodes250000. An escape-aware pre-serialization snapshot
  bounds scalar cost; count limits can reject a document below the text ceiling.
  Accessors, functions, toJSON, custom prototypes, sparse/extra-property arrays,
  reserved prototype keys and invalid Unicode reject without invoking getters.
  Undefined optional SDK fields are omitted by the writer; explicit undefined in
  required data rejects. Null remains null and has field-specific validation.
  Reader parses and validates the writer's final copied document using the same rules.
- Existing maxima:32 panels,64 axes,256 series,128 indicators,10000 drawings,
  200000 drawing points. Text/node limits further constrain these maxima.
- All jobs share2 active Workers and512MiB in-flight reservation, with256MiB per job.
  Workspace logical reservation is `48*N +16*C*O +160MiB +16*(K+1)*I`, where N is
  source length, C actual power-of-two capacity, O total output count across all
  indicators, I indicator count, and K is zero for empty data or floor(N/256)+1.
  This includes a single owned source, transmitted/validated output copies,
  aggregate checkpoint/transient allowance and32MiB metadata/text-copy allowance.
- Encoded checkpoint bytes across **all** indicators total at most32MiB, each
  record at most256KiB, block size256. The Worker enforces remaining aggregate
  capacity during encoding. Owner checks aggregate size before copying entries;
  shared/aliased/oversized backing buffers across entries are rejected.
- The reservation is not a process RSS/GC guarantee. Existing caller charts/data,
  trusted indicator JS state and runtime overhead are outside it. More outputs or
  larger retained capacity can reject a workload even when its bar count is legal.

This is real Worker computation, but bounded JSON parsing, symbol timezone
validation, individual allocations/GC and individual trusted callbacks are not
preemptible. Cooperative1ms/8-unit owner scheduling is a target, not a maximum
blocking bound. Large document save/parse remains synchronous owner work.

## Validation scope

Node tests exercise actual worker_threads transport, all16 drawing tool anchors,
canonical save/restore/save and complete scene parity, own-key static-module outputs,
negative zero, hidden studies, incremental update/append/correction against a fresh
oracle, shared-store disposal, stale/cancel/deadline cleanup and hostile packets.
Native JavaScript bundle generation/VM tests do not certify native facade/device
execution. Browser Worker/mounting, rendering and physical interaction remain
unmeasured in this cloud environment. See CLOUD-VALIDATION.md for measured costs.

### Cloud Node absolute-cost observations

Three isolated fresh processes per condition, Node24.19.0, October13,2026; no
concurrent own builds/benchmarks. These are absolute costs, not comparison against
another product or a previous workspace API. Full raw values/source/harness hashes
are in `benchmarks/results/cycle24-node-workspace/` in the evidence checkpoint.

| Condition | Document chars | Save ms median [range] | Prepare wall ms median [range] | Run-max2ms timer gap median [range] | Timer p95 median |
|---|---:|---:|---:|---:|---:|
|100k bars, EMA+RSI|1421|5.38[4.31–6.53]|253.28[249.28–366.70]|4.46[3.51–12.52]|3.03|
|1m bars, EMA+RSI|1424|4.69[4.62–5.03]|923.57[918.72–944.38]|4.22[4.14–7.26]|2.81|
|1000 drawings, empty source|250967|79.98[77.74–84.32]|196.04[183.39–200.00]|42.34[37.76–42.37]|2.34|
|5000 drawings, empty source|1273633|393.98[364.34–395.75]|468.55[460.26–532.77]|154.15[150.60–173.50]|2.39|

1m EMA+RSI phase medians: owner preflight2.21ms, source snapshot101.29ms,
Worker startup/compute/transport569.82ms, validation/model install/termination
248.06ms. Outputs match the original full oracle byte-for-byte; source data is not
inside the1424-character document. New-model typed outputs total16,777,216bytes;
encoded checkpoints735,784bytes plus62,520bytes indices/offsets, with zero decoded
checkpoint-cache records after validation. The logical reservation is249,451,648
bytes. Caller source columns retain50,331,648bytes both before and after model
disposal. Listener counts4→2→0 and job/reserved counters return to zero; this is
reachable logical ownership evidence, not an RSS peak or long-term leak proof.

**Large metadata still blocks the owner.** Separate parse+validate medians are
31.08ms for1000 drawings and148.90ms for5000. Preparation preflight medians are
39.02/150.54ms, while the final validate/install/cleanup segment is7.90/6.93ms.
The latter includes awaited Worker termination and is not isolated drawing-copy
CPU. The Worker also parses/validates its request; the async name does not move
initial owner parsing off-thread. The save API is synchronous and can block for
hundreds of milliseconds. Do not call large workspace save/restore directly on a
latency-sensitive input handler assuming it is cheap. Plan an explicit host loading
state/stable source revision; off-thread document preprocessing is not currently a
provided SDK API. Cancellation cannot preempt the one bounded parser call.

Timer samples are labelled with the phase when the callback runs and may span an
earlier phase; a long first gap labelled compute can include initial owner parsing.
The explicit preflight timestamps and separate parse probe are more informative
than attributing such a gap solely to Worker CPU. Node timer gaps are an event-loop
proxy, not measured browser responsiveness, physical FPS or a latency guarantee.

### Direct validation of owned drawing metadata

A subsequent narrow change reuses the unchanged structural drawing validator on
workspace-owned snapshots. It removes the validation-only DrawingStore JSON import
and per-drawing JSON copies. Actual DrawingStore add/edit/load copying, committed
history, selection, gesture and public document behavior stay unchanged. Workspace
writer still validates the final serialized document; duplicate-key/numeric/depth /
Unicode/byte/ownership checks are retained.

Five baseline/candidate pairs per size (20 fresh processes), alternating execution
order, same frozen harness and exact document SHA/anchor oracles:

| Drawings | Save median ms [baseline→candidate ranges] | Parse median ms | Prepare wall median ms | Run-max gap median ms | p95 gap median ms |
|---|---|---|---|---|---|
|1000|72.49→64.22 [68.98–79.50→56.37–66.90]|31.55→23.57|189.03→170.47|39.22→34.20|2.31→2.33|
|5000|361.60→251.91 [340.51–378.72→242.66–260.23]|145.82→121.93|444.69→344.05|153.89→106.80|2.24→2.34|

For1000 drawings, parse ranges28.95–35.75→20.69–27.82ms, wall187.14–193.59→
158.57–176.59ms, run-max gaps37.02–44.55→24.87–45.49ms. For5000 drawings,
parse133.87–164.86→120.72–135.81ms, wall428.37–447.86→331.58–363.66ms,
run-max gaps145.46–166.86→100.77–120.82ms. P95 ranges2.19–2.34→2.28–2.40ms
and2.23–2.32→2.25–2.54ms respectively. These small p95 regressions and the worse
1000-drawing maximum sample remain visible; this is not a universal latency win.
The owner still blocks for over100ms on the large document.

Twelve separate instrumented profiles (3 per size/version) support the mechanism,
not the comparative timing claim. At5000 drawings, save JSON.stringify calls fall
10003→1 and JSON.parse calls75045→65043; the latter still includes all per-key
parses needed for duplicate-key detection. DrawingStore.load2→0 removes roughly
90ms inclusive diagnostic cost. The remaining safe parser and workspace-owned
snapshot walks are untouched. Inclusive probe counters overlap and perturb timing.

Raw pairs, source/harness hashes, exact document digests and all diagnostic records
are preserved in `cycle25-node-workspace-document`. Sixteen added regressions
include two baseline-red copy-elimination checks plus direct validation boundaries;
all existing getter/history/canonical/lifetime contracts remain covered.

### Reuse of private parser-owned data

The next narrow change keeps the complete bounded workspace walk, but avoids
reallocating a second object tree for the fresh private result of safeCheckpointParse.
External workspaceSnapshot inputs still always receive a deep detached copy. No
caller option enables no-copy, and the internal mode is used only immediately
inside readWorkspaceDocument. Prototype/accessor/array-shape/Unicode/number/size /
depth/node checks, drawing validation and final writer-reader checks remain intact.

Five matched fresh-process pairs per size compare against the preceding drawing
copy-removal commit (17b332e), not against the original workspace implementation:

| Drawings | Save median ms [ranges] | Parse median ms [ranges] | Prepare wall median ms [ranges] | Run-max timer gap median ms [ranges] | p95 median ms |
|---|---|---|---|---|---|
|1000|59.51→63.65 [58.12–75.97→52.53–70.29]|23.79→17.01 [21.52–28.02→16.85–24.35]|166.67→153.06 [149.31–175.51→148.88–156.67]|35.53→25.13 [34.10–36.21→24.35–29.86]|2.37→2.47|
|5000|272.09→211.30 [241.50–341.89→203.25–245.57]|133.67→87.38 [117.59–138.81→84.11–104.78]|352.94→312.63 [342.85–365.65→292.40–357.00]|114.14→91.79 [108.90–126.45→91.42–111.44]|2.35→2.38|

The initial1000-drawing save median is about7% worse. An additional five pairs for
that condition (separate population, runs6–10) give save73.13→61.94ms with ranges
68.69–74.99→55.29–79.37ms; the initial direction does not reproduce. Parse medians
26.33→18.79ms, ranges21.65–31.27→15.73–41.96ms include a worse candidate maximum.
Prepare medians192.65→150.41ms [173.29–264.75→141.09–174.81]; maximum-gap medians
38.59→25.17ms [37.74–48.29→22.87–31.28]. P95 medians2.43→2.65ms worsen, with
ranges2.34–3.23→2.52–4.12ms. No population is silently pooled or sample dropped.

Both ordinary runs and12 separate instrumented probes retain the full duplicate-key
parser; the same canonical document SHA and exact anchors hold across every pair.
The workspace still performs a full validation traversal. Lower allocations do
not turn a bounded synchronous parser into a preemptible or guaranteed low-latency
operation. The large document still has roughly90ms owner preflight and can exceed
100ms timer gaps. No fixture-specific threshold or alternate validation policy was
introduced. Raw data lives in `cycle26-node-workspace-owned-parse`.

## Optional web UI composition

[Versioned UI preferences](WEB-UI-STATE.md) can be stored alongside this unchanged workspace text in one host-owned record. The UI codec does not extend workspace v1 or alter its dataset/source checks.
