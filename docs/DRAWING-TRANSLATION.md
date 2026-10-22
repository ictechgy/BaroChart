# Atomic raw-coordinate drawing translation

`api.translateDrawings(ids, {deltaTimeMs, deltaPrice})` moves an explicit group of drawings in one undoable core operation. It does not add a multi-selection UI, pixel dragging or equal visual distances on logarithmic/percent axes.

Both finite deltas are required. Supply a dense plain array of 1–128 distinct drawing IDs. Options and array elements must be own data properties; accessors, sparse arrays, extra fields and custom array prototypes are rejected without invoking their getters. Arbitrary Proxy traps and modification of JavaScript intrinsics are outside the managed-owner contract.

All selected drawings must be unlocked, exist, and share the same `(panel, axisId ?? null, seriesId ?? null)` binding. That binding must still reference existing panel/axis/series metadata. Different series are rejected even on the same axis: raw price units cannot be inferred to be interchangeable. No layout, indicator or formatter computation is needed for this validation.

All 16 drawing types move by transforming every stored anchor:

- `time += deltaTimeMs`, preserving fractional timestamps and raw calendar gaps; no session snapping or nearest-bar conversion.
- `price += deltaPrice` in the bound axis's raw units; finite prices and timestamps within ±8,640,000,000,000,000 milliseconds are required.
- Position drawings additionally retain strict level ordering and positive extent; Float64 collapse/overflow rejects the entire group. See [position drawings](POSITION-DRAWINGS.md).
- Measurement and Fibonacci geometry remains derived from the translated anchors. Type, text, style, binding and selected ID remain unchanged.

An active controller gesture or manual drawing transaction rejects the call. This first version does not implicitly cancel either. Missing, locked, mixed-binding, malformed or overflowing candidates reject the entire group before publication. Validated zero deltas (including −0) and changes rounded away by Float64 are no-ops. Locked drawings still reject a zero-delta call. A no-op preserves undo, redo, selection and notification count.

## Undo and publication

The return value is `{changed, invalidationFailed}`. `changed` counts drawings with at least one actually changed coordinate, not selected IDs or anchors. Success adds exactly one undo snapshot, clears redo, retains unrelated drawing identities and leaves source bars/studies untouched. The previous complete drawing snapshot must fit `historyBytes`; otherwise the call rejects before moving anything. Older undo snapshots are trimmed to the configured history count/byte limits before publication.

Sizing and validation finish before callback-free installation. Overridden `begin`, `commit`, `trim`, `weight` and serializers are not called while publishing. Nonzero changes invoke the captured invalidation observer once. Its exception is isolated as `invalidationFailed: true`; the movement is already committed and must not be retried merely because notification failed. Observer reentry may subsequently change the chart; the returned receipt describes this operation, and no state is written after notification.

This is a synchronous, bounded core edit. Many freehand anchors or a large retained history can still block the caller while validating/copying and sizing snapshots. It is not a browser responsiveness or native SDK validation claim.

The notification count above belongs to the core `ChartAPI` observer. The native JavaScript command dispatcher is covered by VM and standalone QuickJS tests. A subsequent thin Swift/Java facade also inspects the strict numeric `changed` field (0..128) before host notification. Zero leaves the host revision unchanged; a positive count notifies once. It never falls back to another receipt field. Existing owner-thread/closed guards and UI-edit async behavior remain in place. Receipt conversion/transport failure after core execution does not prove rollback; inspect the chart before retrying. Java nested-decoder execution and stub typechecking, and Swift static source checks, do not establish real SDK/device execution.

## Executed validation

Cloud Linux/Node 24.19.0: **2,917 full-suite tests passed, 0 failed, 0 skipped**. The focused group contains **118 tests**. The independent 114-test oracle is green on this implementation and red on the preceding commit where the API is absent. It covers all 14 types, exact fractional-coordinate transforms, failure atomicity, undo/redo budget boundaries, selection and reference preservation, accessor rejection, binding checks without dirty indicator computation, and committed observer-error receipts.

Standalone vendored QuickJS executed three fixed scenarios: all fourteen types through the native command dispatcher with one undo; overflow/mixed-binding whole-operation rejection; no-op and observer-failure receipt semantics. Runtime, OOM and interruption cleanup reported zero final tracked live bytes and allocation count. These harness counters do not establish process RSS bounds, browser focus/visual behavior, or Swift/Android device execution. No comparative performance claim is made.

ECMAScript syntax validation covered **383 modules** and strict TypeScript 5.9.3 passed.

## Native receipt verification boundary

The thin host methods are `translateDrawings(ids, deltaTimeMs, deltaPrice)` in Java and `translateDrawings(_:deltaTimeMs:deltaPrice:)` in Swift. They use the ordinary checked command route and retain its owner-thread/closed-engine and async UI-edit policy. This is not a data-ingestion command or a replacement for its BUSY rules.

`node scripts/check-java-drawing-translation.mjs` executes the production nested Java count decoder with test-only JSON/Android signatures. `node scripts/check-java-host.mjs` additionally compiles a consuming call. Neither runner loads the JNI-backed engine. Node source tests inspect Swift forwarding, receipt bounds and notification branching; they do not compile Swift or execute JavaScriptCore. For either host, a receipt conversion failure after native execution can follow a committed move and must not trigger a blind retry.

The subsequent native-facade checkpoint passed **2,937 Node tests, 0 failures and 0 skips**, including **30 focused new/existing receipt tests**. The production Java nested decoder passed **65 fixed scenarios / 103 assertions**. Compiler-module verification produced **36 Java classes with zero diagnostics**, using source/target 8 and test-only Android/JSON signatures; Java SE 8 API compatibility is not thereby certified. Class-initialization tracing excludes initialization of the outer JNI-backed Engine or Android classes. JSON participation is limited to the test-only exception and opaque NULL sentinel, not parsing or container operations. Native observer counts remain source-checked, not runtime-tested on a device.

The native-facade checkpoint also passed parsing of **386 ECMAScript modules** and strict TypeScript 5.9.3.
