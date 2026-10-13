# Native workspace reads (private 0.2.13 checkpoint)

The read APIs described here export portable metadata and validates a document against
an existing engine. These read methods do **not** restore a native chart.
The separate Java restore source implementation and its unverified Android/JNI
boundary are described in JAVA-WORKSPACE-RESTORE.md. Java/Swift facade
source and generated JavaScript are included; new SDK compilation, JavaScriptCore,
QuickJS/JNI host integration and device execution have not been performed in the Linux environment.
Generated native bridge behavior is tested in Node VM and a small standalone
Linux QuickJS harness; see QUICKJS-CLOUD-VALIDATION.md.

## Owner-thread APIs

Swift:
```swift
let binding: [String: Any] = [
  "key": "feed:ASTER/1m", "revision": "r1", "adjustmentVersion": "raw-v1",
  "priceUnit": "USD", "adjustment": "raw"
]
let document = try engine.saveWorkspace(binding)
let receipt = try engine.preflightWorkspace(document, datasetBinding: binding)
// receipt["status"] == "validated-only"; receipt["restored"] == false
```

Java:
```java
JSONObject binding = new JSONObject()
    .put("key", "feed:ASTER/1m").put("revision", "r1")
    .put("adjustmentVersion", "raw-v1").put("priceUnit", "USD")
    .put("adjustment", "raw");
String document = engine.saveWorkspace(binding);
JSONObject receipt = engine.preflightWorkspace(document, binding);
```

Both calls use the existing owning-thread / closed-engine checks. They are
synchronous reads, directly invoking `nativeSaveWorkspace` and
`nativePreflightWorkspace`; they do not route through mutation notification,
advance UI revision, invalidate the view, reserve an async job or swap contexts.
Do not move an existing native engine to another thread to avoid blocking.
Large drawing documents still incur owner-thread parsing/serialization pauses;
there is no native asynchronous workspace API yet.

Save uses exactly the core [portable workspace](WORKSPACES.md) document. It excludes
OHLCV, executable functions, external series values, queues, crosshair, selection,
undo history and active gestures. Commit or cancel gestures/drawing transactions
before save. Preflight may inspect a document while a live gesture exists; it
neither cancels nor serializes that gesture. Neither operation computes dirty live
indicators or changes their buffers, caches, drawings, history or subscriptions.

## Validated-only receipt

```js
{
  schema: 'aster.workspace-preflight', version: 1,
  status: 'validated-only', restored: false,
  dataset: {key, revision, adjustmentVersion, priceUnit, adjustment},
  source: {length, firstTime, lastTime, version},
  counts: {panels, axes, series, indicators, outputs, drawings},
  projectedOutputBytes, outputByteLimit: 268435456,
  modules: [{id, version, stateVersion, exportName, causal}]
}
```

`source.version` is the local managed BarStore version at validation. Dataset
binding equality plus length/first/last timestamps is only the host's extent
assertion at that instant, not a content hash, provider identity authentication or
point-in-time data guarantee. Empty endpoints are null. Callers must maintain
correct dataset/revision/adjustment metadata; direct writes into source arrays are
unsupported and do not advance managed version.

The same bounded reader checks schema/version, plain data, duplicate/prototype
keys, Unicode, limits, panel/axis/series/drawing references and exact time/price
anchors. The document is limited to 2,097,152 UTF-16 code units and 4,194,304 UTF-8
bytes, 250,000 nodes and depth 32. Required static modules must already be linked
and registered at the exact version. Source-evaluated custom indicators are not
portable. A zero-capacity temporary engine invokes trusted canonical factories
to check requested params, ordered output schema and explicit plot offsets.
Factories must be pure; preflight never calls indicator create/step or generates
checkpoints. These module callbacks are trusted application code, not a sandbox.
They may throw or cause their own side effects; preflight detects managed source
or native owner replacement and rejects, but cannot undo arbitrary callback code.
Temporary metadata is released before the final owner/source checks.

`modules` deduplicates canonical study names and reports their descriptors.
`projectedOutputBytes = liveStore.capacity * totalDeclaredOutputs * 8`, including
hidden studies. The fixed 256 MiB limit is configuration admission only. No output
vectors are allocated at live capacity. A receipt does not prove that calculation
will succeed, certify checkpoint memory, reserve future memory, or authorize a
future restore after the source changes. Real calculation or later restore may
still reject due to module behavior, memory/checkpoint limits or stale state.
No raw source columns or executable code are returned.

## Verification boundary

Generated-bundle VM tests cover exact canonical save, output budget, linked module
version/layout, no live calculation, dirty-entry preservation, gesture behavior,
cleanup/reentry and source/native-owner stale rejection. Static source tests check
facade routing and existing owner/closed checks. They are not Swift/Java compiler
or native SDK-host tests. The separate standalone QuickJS check covers only the
vendored JavaScript engine, without JNI/JSC/Intl or device integration. Existing AAR binaries do not contain these new methods.
See [native feature roadmap](NATIVE-FEATURE-PARITY.md) for the remaining work.
