# Drawing admission and historical viewport safety

This bounded review addresses two reproducible defects on the v81 source
(`e83b6d2144d0f6114d029a748f1ba6bf58d29d2d`). It adds no persistence service,
automatic save, live-feed subscription, or cross-model synchronization.

## Saveable drawing imports

`DrawingStore.load` and `ChartAPI.loadDrawings` now admit both the input text and
the final normalized output envelope against the same `maxDocumentChars`.
The envelope uses the existing minimum required drawing version, 1–4.
The limit counts JavaScript UTF-16 code units. Numeric JSON canonicalization
and the public API's portable color normalization can increase this size.

Previously a valid 168-character import could become a 198-character stored
document under a 168-character cap: load replaced prior work, then immediate
save failed. The normalized size is now checked before the mutation.
Rejected imports retain drawing identities, selection, ID serial, undo/redo,
and the active-transaction policy. They do not emit API invalidation.
Exactly-at-limit output is accepted; a changed replacement still forms one undo
step. Loading an empty document into an empty store does not add history.
The input cap remains enforced even if a large input could normalize smaller.

The same limits and schema remain. Add/edit admission has not acquired a new
whole-document serialization pass; a later edit can still exceed the export
budget, and save reports that error. No truncation or silent removal occurs.
Trusted application callbacks remain responsible for their own side effects.

## Initial history versus backfill

- With existing data, prepend shifts both logical view endpoints by the number
  of added bars. Existing UTC anchors retain their viewport-relative horizontal position; span and follow
  flag stay unchanged (logical indices increase by the added count).
- With no existing bars and `follow=true`, the first nonempty prepend uses
  append's tail rule: `to = length + forwardOffset - 0.5`, preserving the prior
  span. `forwardOffset` retains its existing visible-series policy.
- With no existing bars and `follow=false`, retain the explicit logical range.
  A host intentionally viewing other whitespace must choose another range.
- Empty pages do not move the view. Invalid/overlapping pages reject without
  publishing a partial prefix. Reset continues to fit; corrections keep the
  current logical view. Later append follows only when follow is enabled.

The former unconditional shift put a first 30-bar page at `29.5..49.5` in a
20-bar view, leaving every actual candle center offscreen. The following view
is now `9.5..29.5`. Direct store/API admission, prepared web-worker publication,
and the shared native-JavaScript preparation finish path follow the same rule.
The prepared path uses the latest captured UI follow/range choice.

## Workspace and validation boundary

Workspace documents have a separate 2,097,152-character canonical codec budget,
explicit dataset binding, and detached candidate publication. This review found
no workspace defect requiring a production change. Existing rich roundtrip,
hidden-study/drawing, invalid binding, cancellation and stale-source tests remain
part of the related regression scope. See [Workspaces](WORKSPACES.md).

Maintained regression files:

- `drawing-save-limits.test.mjs`: versions 1–4, color/numeric expansion,
  exact/under-limit admission, selection/history/serial identity, one-step undo,
  transaction precedence and existing export bounds.
- `initial-prepend-view.test.mjs`: empty/small/large initial pages, follow on/off,
  forward offsets, unchanged nonempty UTC anchors/drawing coordinates, append,
  correction, reset, latest prepared UI, shared-store policy, empty/rejected pages.
- `persistence-view-bridge.test.mjs`: canonical and checked-in generated resource
  in Node VM, plus four deliberate mutations that fail specific assertions.

This is Node/core, worker-message/prepared-state and generated JavaScript
evidence. It does not establish actual browser paint, trusted input, native SDK
execution or FPS. The generated native resource is refreshed from the common
source; no platform-native behavior is inferred from source parity alone.
