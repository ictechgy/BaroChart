# Atomic drawing group deletion

`api.deleteDrawings(ids)` removes 1–128 explicitly named drawings with one undo unit. IDs must be unique strings in a dense plain array with own data elements. Empty/sparse/extra-property/custom-prototype arrays, accessors, duplicate/missing IDs and locked drawings reject the entire operation. Accessors are not invoked. Arbitrary Proxy traps and modified JavaScript intrinsics are outside the managed-owner contract.

An active controller gesture or manual `drawings.begin()` transaction rejects the call. It does not implicitly cancel either. Every selected drawing must be unlocked even when the other IDs are valid.

Unlike raw-coordinate translation, deletion accepts mixed panel/axis/series bindings and existing orphan bindings. There is no price-unit transformation or live binding lookup; panel/axis/series metadata, formatters and indicators are not queried. All 14 stored drawing types use the same deletion rule. This computation-free claim concerns validation/planning; a host invalidation observer or subsequent redraw may calculate dirty studies.

## Publication, selection and history

The return value is `{changed, invalidationFailed}`. A successful call has `changed === ids.length`; an empty list is an error, not a no-op. It keeps survivor identities/order and leaves serial, source data, studies and the controller's future drawing target unchanged.

If the current selected ID was deleted, selection becomes null; otherwise it remains unchanged. The selected slot must be writable only when this actual change is required. Undo restores the original drawing objects/order, and redo removes the same subset. As with existing undo/redo, both clear selection; they do not restore the prior selected ID.

The previous complete drawing snapshot must fit `historyBytes`, otherwise the entire call rejects before publication. Older undo snapshots are trimmed within the same history count/byte policy, and successful deletion clears redo. One undo snapshot retains the deleted objects, so deletion does not promise their immediate memory release.

All candidate, ownership, selection-writability and history checks complete before callback-free publication. No overridden history method or serializer is invoked while committing. Invalidation is called once after publication. If it throws, `invalidationFailed` is true and the deletion remains committed; do not retry merely because notification failed. Observer reentry may make further changes, and the original call never overwrites them afterward.

This is a synchronous core API, not a multi-selection UI or a frame-latency guarantee. Many anchors or a large history can still block while validating and sizing snapshots. The native JavaScript command dispatcher can use the same operation; real Swift/JSC/Android/JNI/device execution remains outside cloud verification.

## Executed validation

Cloud Linux/Node 24.19.0: **3,096 full-suite tests passed, 0 failed, 0 skipped**. The focused deletion/translation group has **277 tests**, including the unchanged 118-test translation group. The independent 156-test deletion oracle passes on the implementation and fails explicitly for the absent API on the previous commit. It covers all 14 types, filtering/order/identity, mixed/orphan bindings without metadata queries, strict input/owner validation, history budgets, nonwritable selection, undo/redo and observer reentry/disposal.

Standalone vendored QuickJS executed three fixed scenarios: fourteen-type deletion with exact undo identity; orphan deletion and nonwritable-selection atomicity; observer reentry/error with cleanup. Runtime, OOM and interruption cleanup all reported zero final tracked live bytes and allocation count. These counters do not establish a process RSS bound or browser/native SDK/device execution.

The checkpoint also passed parsing of **388 ECMAScript modules** and strict TypeScript 5.9.3.
