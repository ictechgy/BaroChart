# Manual bar replay (core and web example)

`BarReplay` reveals an immutable snapshot of host-supplied OHLCV data one prefix at a time. It is an isolated, synchronous manual session. `start()` enables subsequent `step()` calls; it does not start a timer, promise, subscription or automatic playback. There are no orders, fills, fees, leverage, position sizing, PnL or strategy recommendations.

```js
import {BarReplay, renderCanvas} from 'barochart';
const replay = new BarReplay(bars, {
  initialCount: 64, visibleBars: 200, volume: true,
  indicators: [{id: 'ema20', kind: 'ema', period: 20}],
});
replay.start();
replay.step();                         // reveal one additional complete bar
renderCanvas(ctx, replay.frame(800, 480));
replay.seek(32);                       // reveal exactly the first 32 bars; pause
replay.reset();                        // return to initialCount (64); pause
replay.dispose();
```

The import is also available from `barochart/core`; `renderCanvas` is available from `barochart/canvas`. The generated native JavaScript resource includes the class, verified in Node VM. This feature adds no Swift/Java replay facade or native replay UI, and no native SDK execution is claimed.

## Ownership and future-data boundary

Construction validates and copies the entire source into private Float64 columns. The caller's rows are neither frozen nor modified; later caller changes, including corrections/appends, cannot change this session. There is no API to append, correct, subscribe to feeds, replace source, or obtain the private model/store/engine. To use a changed dataset, dispose the session and explicitly create another. Existing live charts, queued ingestion, drawings/history and shared models are never wrapped or silently replaced.

Every **changed revealed count** stages a fresh store containing only that prefix, a fresh engine with canonical SMA/EMA/RSI factories, and a fresh model. Forward `step()` can reuse an owned terminal study checkpoint and copied prior output prefix to compute only its added bars. Other count changes calculate studies cold. Every candidate validates its studies and a finite 800×480 frame before committing. On staging failure, count, pause state, generation and the previous model remain unchanged. Backward seek does not retain future checkpoints. Cold calculations use an endpoint-sized checkpoint interval. Forward reuse chooses an interval dividing the old/new counts, so both boundaries are exact; at most 257 transient checkpoints per study are created for the maximum 256-bar step, then only the terminal checkpoint is retained. The per-engine indicator output budget is 2 MiB (4×65,536×8 bytes). These are not whole-session memory or latency bounds: source, old/new staging models, indexes, renderer commands and temporary copies also require memory.

Current `barAt`, `indicatorValues`, `frame` and snapshot `lastTime` expose only revealed data. `total` deliberately discloses source length, never the next timestamp or next OHLCV. Snapshot/receipt/bar records are frozen copies; study buffers and deep frame data are owned detached copies, with no functions, layout closures or mutable model references. Study warmup NaNs remain in `Float64Array` outputs; numeric frame fields must be finite. Previously returned data remains in the caller's possession after rewind/disposal. Replay cannot erase prior knowledge or hide the caller's own full source.

The replay-local seed helper checks canonical definition/registry identity, period-only parameters, one value output, clean old length/dirty state, output capacity, one terminal checkpoint and output budget. It copies each reused state and output vector into the candidate; the active model is never updated and rolled back. If any study is ineligible for reuse, the whole candidate follows the existing cold calculation path. In particular, finite extreme RSI inputs can legitimately carry an internal infinite smoothing state while producing public NaN; serialized-checkpoint admission is stricter, so those endpoints fall back cold rather than changing v78 numerical acceptance. Actual candidate allocation/calculation/frame failures still reject atomically. These guards depend on the managed IndicatorEngine record shape and are deliberately confined to one replay helper with exact-prefix and failure tests.

Only explicit canonical studies are admitted. No arbitrary factory, external series, precomputed values, inherited drawing/history, panel configuration, fixed range or callback may encode hidden future information. Cold-prefix-versus-fresh-model comparisons are equivalence checks; independent literal/analytical checks separately cover prefix admission and selected calculations.

## Source and configuration

- Source: dense ordinary array, 0–65,536 rows. Each plain row has only own enumerable data properties `time`, `open`, `high`, `low`, `close`, `volume`. Accessors, holes, extra fields and extra array properties are rejected. UTC millisecond timestamps are integer, Date-representable and strictly increasing. OHLCV must satisfy the existing finite/envelope/nonnegative-volume contract. Ordinary row/array changes detected during capture reject construction. Hostile object proxies are not an isolation boundary.
- `initialCount`: integer 0–source length, default 0.
- `visibleBars`: integer 1–2,048, default 200. Each staged model displays a fixed trailing logical window; a short prefix leaves right-side whitespace. No automatic fit to all revealed history.
- `priceScale`: `linear` (default) or `log`; `inverted`: boolean, default false. Linear price padding is 8%. Log uses zero additive padding to keep a positive wide-range source positive; a revealed visible nonpositive range rejects the transition. Linear coordinates support signed prices. Existing Float64 numeric failures still reject staging; no claim of arbitrary numerical exactness is made.
- `volume`: boolean, default false; when true adds a separate source-volume panel.
- `theme`: existing portable theme fields/colors/fonts only. CSS URLs, callbacks and unsupported keys are rejected.
- `indicators`: at most four `{id, kind, period, color?}` records. Unique existing-contract identifiers, `kind: 'sma' | 'ema' | 'rsi'`, integer period 1–256. SMA/EMA share the price panel; each RSI has its own 0–100 panel. Default study color is `#7898ffff`. Registry replacement cannot substitute the canonical factories.

Unknown or explicitly null/undefined option fields are rejected. Configuration is fixed for the session; there are no global defaults or workspace/preset persistence changes.

## State, transitions and queries

`start`, `pause`, `step`, `seek` and `reset` return `{changed, state}`, a frozen receipt with a frozen snapshot. Snapshot fields are `count`, `total`, `initialCount`, `lastTime` (null at zero), `paused`, `ended` (`count === total`) and `generation`. Generation starts at zero and increments once only for a committed count or pause-state change. Invalid calls do not increment it.

- `start()`: enable manual stepping, including at zero for a nonempty source. At end, including an empty source, remain paused and return a no-op receipt.
- `pause()`: pause. Same-state calls are no-ops.
- `step(count = 1)`: integer 1–256. Requires enabled stepping unless already at end. Clamp to the end and pause there; valid steps at end are no-ops.
- `seek(revealedCount)`: integer 0–total, always pause. Seeking the current count does not rebuild; it can still change enabled stepping to paused.
- `reset()`: return to initialCount and pause, including a no-op when already there/paused.
- `barAt(index)`: only integer indices 0–count−1; returns the exact copied source OHLCV. Empty or unrevealed indices reject.
- `indicatorValues(id)`: only a configured study ID; returns a new `Float64Array` of exactly count values, including warmup NaNs.
- `frame(width, height)`: integer width 100–4,096, height 80–2,160. Detached `{width,height,background,commands,stats,axes}`; axes contain ID, numeric min/max, scale and inversion. No pointer, drawing, pan/zoom or interactive ChartAPI is exposed. A failed frame query does not change replay state.
- `dispose()`: idempotent; releases owned source/model. Later actions/queries throw. There is no timer or background work to await.

## Staging cost and CPU pilots

All methods are synchronous. Copying source is O(source length). Every changed count still copies/revalidates the prefix, rebuilds its store/range indexes and validates a scene. Eligible forward steps reuse study endpoints and evaluate only the added 1–256 bars, but output-prefix copying and index construction remain O(prefix); this is not constant-time playback. SMA numeric rebasing can add a period factor to study work, and the gcd=1 maximum step can create 257 temporary checkpoint snapshots per study. Seek/reset, zero-count initialization and ineligible reuse remain cold. EMA/RSI cold calculation is linear; cold SMA work can be O(prefix × study count × capped period). Source capture and backward seek are not claimed faster. The caps provide no hard wall-clock latency bound.

Run `node benchmarks/bar-replay.mjs` for a reproducible small CPU pilot. It exercises 65,536 bars, four studies, 2,048 visible bars and volume, including SMA256 alternating ±1 cancellation. Each case has two discarded warmup iterations and ten measured construction/seek/rewind/step/frame iterations. Results retain all samples, min/max and nearest-rank p50/p95 (p95 is the maximum with ten samples), runtime/CPU, and distinguish constructor, prefix rebuild and 4,096×2,160 frame cost. No Canvas rasterization, browser event latency, display FPS, native timing or production performance threshold is measured.

Historical v78 cold-only cloud probes observed approximately 141 ms construction and a separate reviewer cancellation case approximately 156 ms cold rebuild. These synchronous stalls are meaningful, not performance targets or exhaustive worst cases. The v78 cold-only pilot on Node 24.19.0 / Linux x64 / AMD EPYC 9V74 observed SMA256 cancellation seek min 114.38 ms, p50 116.73 ms, p95/max 134.11 ms; its rewind p50 122.62 ms and step p50 119.45 ms. Construction across the six cases ranged 113.38–202.02 ms. These are ten-sample per-case CPU observations, not exhaustive worst cases. Full raw samples are retained with the private validation evidence; runtime/GC/machine/data shape can change results. Keep interactive sources small; for large datasets a host can design off-main-thread preparation and transfer detached frames/results. This slice provides no worker adapter, cancellation, progress updates or autoplay scheduler. A separate counterbalanced baseline/prototype experiment and the guarded-source rerun are retained with private evidence; forward-action CPU gains do not imply faster construction, backward seek, browser interaction or FPS.

### Paired forward-step experiment

A separate Node 24.19.0 / Linux x64 / AMD EPYC 9V74 experiment compared immutable v78, a rejected cold-input shortcut, and the adopted guarded forward implementation in the same process. Fourteen cases covered zero/four studies, step sizes 1/256, capacity growth, cancellation, and backward seek. Each of two rounds used two discarded warmups and twelve measured samples per case; six execution orders were balanced twice, and round two reversed case order. All 336 paired groups matched detached study output bytes and frame digests after the action. Positioning, source capture and starting the session were outside the timed action.

For ordinary four-study forward cases, adopted p50 values were approximately 3.6–4.5 ms versus 16.6–18.8 ms cold. SMA256 cancellation step(1) at a near-maximum prefix had the following measured action times (milliseconds):

| Round / implementation | min | p50 | p95 / max |
| --- | ---: | ---: | ---: |
| 1 / v78 cold | 114.03 | 129.59 | 140.90 |
| 1 / guarded forward | 3.34 | 3.59 | 11.90 |
| 2 / v78 cold | 112.19 | 115.75 | 124.06 |
| 2 / guarded forward | 3.28 | 3.82 | 12.35 |

Nearest-rank p95 is the maximum with twelve samples. The cancellation step(256) case with gcd=1 and 257 transient checkpoints had forward p50 12.94/11.55 ms versus cold 122.35/116.15 ms in the two rounds. Zero-study steps and backward seeks had no consistent gain. These are small paired CPU pilots, not distribution-wide statistics, exhaustive worst cases or a passed latency target. Full raw timings, source identities, correctness digests and the rejected strict-guard measurements are preserved with validation evidence. The final measured implementation uses cold fallback for legitimate extreme RSI endpoints; the earlier strict-guard variant is not shipped.

## Manual web example and failure behavior

With the local demo server, open `examples/web/bar-replay.html`. It uses 512 synthetic bars, initialCount 64, EMA20/RSI14, a single detached Canvas scene, and explicit Start/Next/Pause/Seek/Reset/Refresh controls. Enter in the count input seeks and pauses. Focus moves from a newly disabled control to the count input. There is no background timer and no interactive CanvasChart/model adapter.

The purpose-built example helper allows one live binding per session/container. It borrows the session; destroying the view removes its controls/listeners but does not dispose the session. It hides old canvas/readout before actions and publishes only if generation still matches after painting, DOM/control updates and focus movement. Failed core transitions keep core state; painting failure **after successful transition does not roll the core back**. Stale output stays hidden and a status message directs Refresh. Reentrant actions cannot overwrite a newer generation. Hosts that change the borrowed session directly must call `view.refresh()` (and manage external failures); the helper is not a subscription adapter. Page teardown explicitly destroys the view and session; restored cached pages refresh.

Node core, modeled DOM/no-op Canvas, strict TypeScript and generated/shipped JavaScript checks are executed. Actual browser, keyboard/assistive-technology UX, native SDK and display performance validation remain unrun.

Behavior reference only: TradingView's official [Bar Replay overview](https://www.tradingview.com/support/solutions/43000712747-bar-replay-how-and-why-to-test-a-strategy-in-the-past/) and [manual-forward controls](https://www.tradingview.com/support/solutions/43000474024-how-do-i-turn-bar-replay-on/). No vendor code or assets are copied; this bounded API has its own semantics.

## Versioned sessions and bookmarks

```js
const binding = {key:'host-series', revision:'dataset-7', adjustmentVersion:'1',
  priceUnit:'USD', adjustment:'raw'};
replay.addBookmark({id:'review-1', label:'Check this point'}); // captures current count
replay.renameBookmark('review-1', 'Revisit'); // retains captured position
replay.bookmarks(); // frozen list of frozen {id,label,count}, insertion order
replay.seekBookmark('review-1'); // explicit seek, always paused
replay.removeBookmark('review-1'); // boolean; missing ID is false
const text = replay.saveSession(binding);
// Host supplies/validates its bars and independently resolves the expected binding.
const candidate = BarReplay.restoreSession(bars, text, {datasetBinding: binding});
// Mount candidate successfully, then retire the previous view/replay explicitly.
```

The separate `barochart.replay-session` version 1 document contains normalized
replay options, original reset count, current count, source total, the existing
five-field workspace dataset binding, and bookmarks. It does not contain bars,
source endpoint timestamps, study buffers, mutable model state, callbacks, timers,
order data, generation numbers or autoplay state. Restore returns a new **paused**
instance at generation zero. `reset()` still returns to the original initialCount.
The existing constructor, snapshot and manual stepping contracts are unchanged.

The host must supply all five binding fields independently; copying the document's
binding back as the expected identity defeats the check. Binding equality and equal
source length are not a content fingerprint and cannot detect an incorrect host
revision or modified interior OHLCV. Data acquisition, entitlement, revision policy,
file/localStorage/server persistence and cross-device synchronization stay host-owned.
This format does not replace the general chart workspace or web-UI preferences.

At most 128 bookmarks are retained. IDs and nonempty labels are scalar-Unicode
strings of at most 128 UTF-16 code units; IDs are unique and existing reserved-ID
rules apply. Creation accepts no arbitrary count/time/price; it captures the current
revealed count, including zero. Bookmarks retained after rewind may refer to previously
revealed later positions, but expose only their count and host label, not future
bars or timestamps. Metadata changes do not change the existing playback generation.
List/records are immutable snapshots. Rename does not recapture the current count.

Session reads reject text above 262,144 UTF-16 units before parsing, unknown/missing
fields, duplicate JSON keys, invalid Unicode/nonfinite/deep data, invalid options,
duplicate bookmarks, invalid counts, or mismatching host binding/source total.
Failed restore leaves existing instances unchanged; candidates that fail staging
are disposed. External metadata normalization is guarded against reentrant actions.

The manual web demo has bookmark add/rename/remove/seek and explicit local Save/Load.
It saves only metadata for its synthetic dataset and mounts a prepared paused
candidate, with no automatic restore or storage SDK in the core. Storage and paint
failures are reported; this is not a cross-tab synchronization or durable-storage
promise. Tests cover actual Node core and generated/shipped JavaScript in Node VM,
plus modeled DOM/no-op Canvas demo controls, not browser/native/assistive-tech parity.
