# Atomic drawing style patches

`api.setDrawingsStyle(ids, patch)` applies a partial stored style change to 1–128 explicit, distinct drawing IDs with one undo operation. It returns `{changed, invalidationFailed}`. `changed` counts drawings whose stored normalized style changed, not visibly changed pixels.

```js
const result = api.setDrawingsStyle(['support', 'target'], {color: '#36c', width: 2});
if (result.invalidationFailed) {
  // The stored edit succeeded. Arrange a redraw; do not assume rollback.
}
api.undo(); // one step restores both prior drawing objects
```

The nonempty patch permits only `color`, `fill`, `width`, and `font`. Every supplied value must be defined and non-null; this operation does not offer a reset/remove sentinel, including the `fill: null` accepted by some other style APIs. Colors use the existing portable hex/basic named/comma RGB(A) rules, width is finite 0.1–50 inclusive, and font uses the portable 4–96px font grammar. Arrays and records must have ordinary own data properties; accessors are rejected without evaluation. Arbitrary Proxies or replaced global intrinsics are not a sandbox boundary.

Only supplied fields are normalized and merged. Unprovided existing style values, including low-level renderer CSS colors outside the portable input grammar, are preserved. Coordinates, fractional times, text, bindings, locks, order, selected ID, and serial counter stay unchanged. Mixed panels, axes, series, and orphan bindings are allowed; this operation does not query their metadata or calculate studies.

A missing stored key is different from explicitly storing a renderer default. Reapplying equal normalized stored values is a no-op: changed 0, no undo/redo change, and no invalidation. IDs, locks, and active gestures/manual drawing transactions are still checked for a no-op. Empty IDs/patches, duplicate/missing/locked IDs, invalid fields, or insufficient undo budget reject the whole operation before publication. The full prior drawing snapshot must fit `historyBytes`, so successful changes retain an undo step. Existing undo/redo clears the current selection; it does not restore historical selection.

Style effects depend on the tool. Color applies to strokes or text; width does not size text glyphs. Fill affects rectangle/ellipse interiors. Font affects labels on text, measurement and Fibonacci tools; it does not add a label to a tool without one. A saved style field can therefore count as a change without changing a particular tool's pixels. Actual final scene text commands use the individual font, or the theme fallback.

Core publication is callback-free after final owner guards. One invalidation follows a real change. A synchronous invalidation exception is isolated as `invalidationFailed: true`; the mutation remains committed, so do not repeat it as if rolled back. Host callbacks or subsequent redraws may perform other work, including study calculation.

Swift `setDrawingsStyle(_:patch:)` and Java `setDrawingsStyle(JSONArray, JSONObject)` forward the common command. Their checked changed-count receipt skips native host notification at zero and notifies once for a positive count. Receipt conversion/transport failure after execution is not proof of rollback. Current cloud checks cover Node/native JavaScript, Java test-only compile signatures and decoder execution, and Swift source inspection. They do not establish Swift compilation, JavaScriptCore/Android/JNI/device behavior, font availability, browser visual rendering, or multi-selection UI behavior.

## Cloud validation record (2026-10-13)

- Serial Node: **3,256/3,256**, zero failures/skips; 391 ESM files parsed, strict TypeScript 5.9.3 and offline installed-package checks passed.
- Independent merge/atomicity oracle: 153/153 passed; the same tests fail at the explicit API-existence check on pre-feature commit `ac2147e`. Three integration tests cover final-scene font/save-load, the native bundle fixture and source-level host receipt wiring. Four additional source tests cover the new native deletion convenience methods.
- Actual standalone vendored QuickJS: three fixed style scenarios, plus normal/OOM/interrupt cleanup with final tracked allocation count and requested bytes zero. This is not a process RSS or mobile runtime leak measurement.
- Java: 36 generated classes compiled against test-only Android/JSON signatures, no diagnostics; the unchanged production `DrawingTranslationReceipt.changed` decoder used by both style and translation passed 65 scenarios/103 assertions. The outer Engine, Android/JNI and host notification callbacks were not executed. Swift source wiring was reviewed, without compilation/JSC execution.
- Independent final production review found no blocking issue. Mapping from stored styles to final scene commands is tested; browser/device font rendering and multi-selection UI remain unverified.
