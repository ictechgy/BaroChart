# Atomic indicator parameter replacement

Private0.2.13 source API. This removes the need to delete an indicator and its
series merely to change a period, source, session calendar or VWAP anchor.
It is an additive usability feature, not a claim of a unique commercial feature.

```js
// Same registered indicator name and ID; replace the whole parameter record.
const metadata = chart.api.setIndicatorParams('ema20', {period:50, source:'close'});
// metadata: {outputs:['value'], plotOffsets:{}}
```

## Contract

- Existing ID is required. `params` is a full replacement of number/string
  primitives, not a merge. Omitting an old optional parameter restores the
  factory's default behavior. Caller records are detached.
- Same registered factory/name. Compute a complete candidate from current
  OHLCV, validate it, build result metadata, recheck owner/source/configuration,
  then publish one entry. Invalid parameters, failed calculations and changed
  owner callbacks reject without publishing the candidate. Caller callback
  side effects are retained, not rolled back.
- Preserve existing series objects, style, axis/panel, labels, visible state,
  current offsets, drawing bindings/history/active gesture, viewport and source
  store version. Only dependent derived range caches are released. Separately
  held old outputs/indexes remain valid and unmodified.
- Output names/order and effective own plot offsets must stay identical.
  A change such as Ichimoku `displacement` is explicitly rejected. Existing
  serialized series do not record whether their numeric offset was a default
  or user override, so silently shifting some/all series would be ambiguous.
  Use an explicit remove/reconfigure workflow for these changes.
- Same primitive keys/values (Object.is, independent of key insertion order)
  are a no-op: preserve the entry and caches. +0 and -0 are distinct. The API
  invalidates once after successful completion, including a no-op; staging
  failure does not notify. An application invalidation callback runs after
  commit, as for existing ChartAPI setters; its own thrown error cannot undo
  an already committed change.
- Temporary calculation includes the other active outputs when checking the
  existing engine output budget, but excludes the retired target from the new
  committed-output total. Old and candidate target vectors coexist during
  staging; this is not a total-process memory cap. Temporary subscriptions are
  always released.
- Entry identity is included in web/native owner configuration keys. Old async
  results cannot overwrite a newer replacement, even if a custom factory uses
  one singleton definition and params only change0→−0. This is stale-publication
  prevention, not immediate interruption of a running worker.

Custom factories remain trusted application code. A factory that changes the
requested parameter record is rejected. No arbitrary-code sandbox is added.

## Integration

The method is in ChartAPI, JSON dispatch and TypeScript declarations. Source
Swift/Java forwarding methods are included:

```swift
try engine.setIndicatorParams("ema20", ["period": 50])
```
```java
engine.setIndicatorParams("ema20", new JSONObject().put("period", 50));
```

Those native wrappers have not been newly compiled/run in this Linux cloud.
Preserved older AARs do not contain this addition. Node VM checks generated
native JavaScript dispatch only; this is not JavaScriptCore/QuickJS/SDK testing.

The existing analysis demo's VWAP session/anchor control now uses this API
instead of removing/recreating its three series. Its actual helper is Node-
checked against a fresh oracle while preserving custom styling and annotations.
The changed browser interaction has not received new visual QA.

## Measured synchronous cost and limits

This version calculates synchronously and can block its calling UI thread.
For large histories, apply settings at an appropriate host-controlled moment;
there is no async parameter-edit API in this change.

10 serialized fresh-process runs, Node24.19.0 Linux, alternating100k/1m rows,
5runs each. Every process first warms12updates on4096rows. One EMA20→50 change
with an untouched RSI14 control and existing range caches:

| Rows | Update median (min–max) | Later index rebuild median | New output vector |
| --- | --- | --- | --- |
| 100,000 | 9.73ms (7.98–10.37) | 1.01ms | 1MiB |
| 1,000,000 | 93.15ms (87.96–97.94) | 6.98ms | 8MiB |

The update measurement excludes initial setup, subsequent index reconstruction
and rendering. New vectors use the store's power-of-two capacity. Both old/new
vectors exist until commit/collection; held caller views extend old lifetime.
Checkpoint/JS heap and total process peak are not represented by vector bytes.
Raw process memory snapshots are preserved but GC variation makes them
unsuitable as a peak estimate (some100k deltas are negative). No speedup over
an equivalent prior API, renderer FPS, physical latency or native performance
is claimed.

Each run verifies every EMA output against an independent scalar oracle,
unchanged source SHA and retained old output SHA, and identical control entry/
index. Raw files and a checked manifest are under
`benchmarks/results/cycle18-node-params/` in the companion evidence package.
Reproduce one run: `node --expose-gc benchmarks/indicator-params.mjs 100000 /tmp/params-100k.json`.

## Next priority

An asynchronous settings-update path is a high-priority follow-up for large
histories, potentially reusing existing staged engine preparation and atomic
publication. It is not implemented here; do not describe this synchronous API
as a background operation.
