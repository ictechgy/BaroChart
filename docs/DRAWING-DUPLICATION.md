# Chart-local drawing duplication

```js
const receipt = chart.api.duplicateDrawing('entry', {
  deltaTimeMs: 0, deltaPrice: 0,
});
chart.api.duplicateDrawings(['entry', 'target'], {
  deltaTimeMs: 60_000, deltaPrice: 2.5,
});
// {changed: 2, created: [{sourceId: 'entry', id: 'drawing-1'}, ...],
//  invalidationFailed: false}
```

Both finite raw deltas are required, including for an overlapping copy. The
batch accepts 1–128 distinct existing IDs in a dense plain array. Extra option
keys, omitted deltas, non-finite values, sparse/custom arrays and accessor fields
reject before mutation. The single command uses the same planner with one ID.

Copies are appended after all current drawings, in the original source drawing
order (z-order), independent of request-ID order. The immutable receipt and
source/new-ID mapping explain the result. No geometry/model references are
returned. Originals keep their identity, order, coordinates, text, style, binding,
visibility and lock. Copies preserve those fields except that every new copy is
**unlocked**. Hidden copies stay hidden. Absent visibility/style fields remain
absent; no new serialization version is introduced. Existing v1–v4 selection is
based on the same stored fields as before.

## Raw coordinates and bindings

- Zero/zero explicitly overlaps the source. Signed zero and all stored coordinates
  are preserved without adding zero. Frozen point/style references may be shared.
  Mixed and orphan bindings are allowed because no new coordinate interpretation
  is needed; such copies may remain unrenderable until a binding exists.
- Any nonzero delta requires every source to share one identical live
  panel/axis/series binding, following [raw translation](DRAWING-TRANSLATION.md).
  A time-only offset still follows this rule. The command does not infer compatible
  price units across series or axes.
- Offsets apply to every stored point as `time + deltaTimeMs` and
  `price + deltaPrice`, preserving the unaffected component when its delta is zero.
  These are raw units, not pixels, bars, sessions, display percentages or ticks.
  Log/inverted/secondary axes do not change this arithmetic. Drawing magnet and
  crosshair settings are not consulted or changed.
- Resulting coordinates must be finite and within existing Date bounds. All type
  constraints remain enforced. In particular, four-anchor positions require
  synchronized start times/entry copies, positive extent, valid raw level ordering,
  and finite positive risk/reward/ratio. Float64 collapse/overflow rejects the
  whole batch. No decimal-exact arithmetic is promised.
- A finite nonzero delta that rounds away still creates a copy. Duplication has
  no successful no-op: a valid nonempty request always creates the requested rows.

## IDs, admission and one undo

Generated IDs use `drawing-N`, starting above the live store's safe nonnegative
integer serial and skipping every current collision. Allocation is local until
all candidates pass. A Set lookup loop makes at most current-count plus batch-count
attempts; it never scans an unbounded numeric interval. Safe-integer exhaustion
rejects the entire request without consuming a serial or ID.

Preflight checks the complete resulting drawing/point/text limits, the exact
serialized document-character count, and the prior full undo snapshot against
its history-byte budget. Document sizing traverses all stored content; this
explicit synchronous API is O(total content/history), not a constant-time or
pointer-motion operation. Older undo snapshots may be trimmed under existing
history limits, but the new operation retains one complete undo step.

Publication preserves original drawing identities, installs all copies and the
new serial together, clears redo, and adds exactly one undo. Undo removes the
whole batch; redo restores the same copy objects/IDs. Undo does not rewind the
live serial. Ordinary drawing/workspace documents do not persist issued-but-undone
IDs; a fresh reconstruction can reuse such an old ID while staying unique among
current rows. Async UI/history transfer does preserve the live serial.

Every active controller gesture or shared-model drawing transaction rejects the
command, even at zero offsets. Rejection preserves storage, serial, history,
canvas selection and notification state. No layout, source-bar or indicator
computation is needed. A committed copy invalidates the drawings layer; a cached
prepared base remains reusable. A later dirty frame retains the existing lazy
study-computation behavior.

The core leaves the existing canvas selected ID unchanged and does not select
new copies. `invalidationFailed` means the edit committed but the callback failed.
It is not rollback; do not blindly duplicate again. Synchronous observer reentry
may make a newer edit, and the returning command does not overwrite that state.

## Panel and native facades

The opt-in [drawing panel](DRAWING-PANEL.md) adds a `Duplicate selected` button
and two labeled raw-offset inputs. Both default visibly to `0`; blank values are
errors, not implicit defaults. Checkboxes can include locked/hidden drawings
across pages. A current successful action clears only its prior group selection,
without selecting copies or changing the current page. Newer callback selection,
replacement ownership or disposal is not overwritten. Existing disabled-button
focus policy moves focus to Refresh when needed. Hidden copies can be recovered
with their Show controls.

`DrawingSelectionController.duplicate(options)` follows those group-selection
rules. `ChartAPI`/TypeScript expose both single and batch commands. Swift and Java
engine facades accept explicit raw deltas and forward to the same command. Before
host notification they validate a positive integral changed count, the single/
batch bound, mapping array count, bounded unique string IDs/source IDs, and the
boolean notification-failure field. Receipt conversion failure after execution
can follow a committed copy and must not trigger a blind retry.

The [web demo](../examples/web/drawing-groups.html) exposes this chart-local flow.
No system clipboard access, copy/paste shortcut, cross-chart transfer, automatic
pixel offset, platform menu or template feature is added.

## Verification boundary

Node contracts cover all 16 drawing types, exact offsets, source order, unlocked/
hidden copies, bounded ID collisions/exhaustion, resource/history admission,
position collapse, schema compatibility, serialization, async UI restoration,
modelled Canvas caches and panel identity/focus/reentry. Four deliberate bridge
mutations must fail specific assertions and emit their raw diagnostics. Swift/
Java facade checks inspect source; generated native JavaScript executes in Node
VM. Actual browser/default-action/accessibility and native SDK/device runs remain
unrun for this feature. There are no FPS or heap/GC claims.
