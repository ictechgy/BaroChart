# Native opt-in unchanged batches (experimental)

Swift and Java provide additive typed overloads for hosts receiving repeated cumulative candle snapshots:

```swift
let receipt = try engine.applyDataEvents(events, skipUnchanged: true)
```

```java
JSONObject receipt = engine.applyDataEvents(events, true);
```

The existing one-argument methods and `false` overload preserve the legacy command, error and notification path. The new `true` path calls a dedicated endpoint using the bundle's initially captured canonical `ChartAPI.applyDataEvents`. It intentionally does not invoke application overrides of that API method. Generic JSON command arity remains one; use the typed overload for this feature. Queue/drain sequence accounting and `applyDataEvent` batch behavior are unchanged.

The [core batch contract](INGESTION.md#동일한-직접-배치의-선택적-게시-생략) remains authoritative: all events, intermediate values, capacity limits and sum arithmetic are validated first. No append and exact `Object.is` equality of all final replaced OHLCV values permits `unchanged:true`. Signed zeros differ; invalid/overflow intermediate states still reject, and stale feed snapshots are not automatically identified. Volume is replaced, not accumulated. Validation/staging costs remain; this is no measured latency claim.

On successful unchanged execution, original API/model/store/columns/index identities, store version, receipt fields and host owner/revision must agree before host notification is skipped. A changed success notifies once. If another host mutation changed revision during the call, notification is retained even for an unchanged batch. The result is the core receipt; its `from/to` describe requested rows, not a changed-row count.

A true-path bridge/receipt failure can occur after data was committed. For safety, the same still-open host owner receives a conservative notification, then the original error is returned. A notification error in Java is suppressed onto the original failure. Closed engines or replaced host contexts/handles do not notify a new host owner. If trusted JavaScript replaces only the API/model inside the same runtime, the stale operation can still conservatively notify that unchanged host owner so its UI rereads current state; this does not reapply the batch to the new model. **Do not automatically retry on response failure or assume rollback.** Even an input rejection may conservatively notify on this new path. False/default behavior is unchanged.

Calls remain synchronous on the engine owner thread. Swift holds the original creator retirement lease and ends its JavaScript autoreleasepool before lease release and host notifications. These guards do not sandbox arbitrary trusted in-process JavaScript or prove honest behavior of application-replaced store internals.

## Validation limits

Generated JavaScript VM fixtures check no-op/changed semantics, signed zero, intermediate failure, source identity, strict receipt fields and legacy dispatch. The production Java nested decoder is executed with isolated compile-only Android/JSON signatures; Engine/JNI and actual JSON containers are not executed by that harness. Swift lifecycle and decoder paths have source-level checks. Actual Android SDK/JNI, Swift compilation/JSC/ARC, device behavior and timing remain unverified for this addition.

The shared standalone fixture can be checked with `node scripts/test-quickjs-cloud.mjs --native-controls` using a local C compiler and the existing vendored QuickJS source. It exercises the JavaScript bridge, not the platform facade or accessibility integration; see [validation scope](PUBLIC-VALIDATION.md).

An opt-in [iOS/Android example panel](NATIVE-CONTROLS-DEMO.md) demonstrates explicit actions; its actual platform UI remains unverified.
