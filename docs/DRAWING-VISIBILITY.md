# Drawing visibility

Drawings accept optional `visible: boolean`. An absent value means visible.
Hidden drawings retain their anchors, binding, style, lock, IDs, order and history,
but produce no drawing commands, selection handles, hit targets or pointer cursor
selection. Canvas PageUp/PageDown skips them. Stale hidden canvas selection is
cleared before keyboard nudge/delete. Hiding the selected drawing clears its
canvas selection; showing it does not automatically select it. Adding a hidden
drawing does not replace an existing visible selection. Undo/redo/load clear
canvas selection; cancel cannot restore a hidden selected handle. Async UI
restoration rejects a selected-hidden state.

```js
const receipt = chart.api.setDrawingVisibility('note', false);
chart.api.setDrawingsVisibility(['note', 'position'], true);
// {changed: number, invalidationFailed: boolean}
```

Both setters use the existing atomic group planner: 1–128 distinct existing IDs,
one undo unit, preflight of the complete candidate set and prior history budget,
and no partial change on invalid input. The single setter is the same planner
with one ID. Both reject any active controller gesture or shared-model drawing
transaction, including an otherwise no-op request. They do not cancel another
controller's gesture. Mixed or orphan bindings are allowed; visibility performs
no layout, bar or indicator query. A committed change invalidates `drawings`;
prepared scene bases remain reusable. A later dirty frame may still calculate
studies under the existing lifecycle.

Visibility is presentation state, independent of locking. Locked drawings can
be hidden/shown, and `editDrawing(id, {visible: false})` is permitted. A patch
mixing visibility with geometry/style on a locked drawing still rejects. The
ordinary edit API retains its existing owned-gesture cancellation behavior;
use the dedicated visibility setters for no-active-transaction group semantics.
Unlock/lock can be combined with visibility using the ordinary edit API.

For the dedicated visibility setters, setting absent/true to true is an effective no-op: it does not materialize a
`visible` field, replace objects, create history or notify. False to true retains
an explicit `visible: true`. A changed record retains its immutable point/style
references. An explicit `addDrawing`/`editDrawing` visibility field is stored under the ordinary edit semantics, including true on an absent field. No-op selections and unrelated records retain identity. Hidden rows
count toward drawing, point, document and history limits; the existing document-character limit is checked at save/load. Translation, styling,
delete/undo, worker preparation and workspace restoration preserve visibility.
`positionMetrics` can still inspect a hidden position drawing.

`invalidationFailed: true` means storage committed but its redraw callback
failed. It is not a rollback; do not repeat the command as recovery. Native Swift
and Java engine wrappers forward both commands and validate their changed-count
receipts (single 0–1, batch 0–128) before notifying observers. Native SDK execution
has not been run for this addition.

## Versioned persistence

Any explicit visibility boolean requires `aster.drawings` version **4**, including
explicit true. Old versions 1–3 reject that field rather than silently dropping
it. Older readers reject version 4. Documents with no explicit visibility retain
the existing minimal version and bytes: unbound legacy drawings use v1, bindings
v2, and position drawings v3. v4 includes the existing bindings and four-anchor
position contracts; it does not change them. Workspace envelope version remains
1 with an embedded drawing document at the required version. Direct/segmented UI
preparation and native-workspace JavaScript normalization preserve the field.

There is no automatic lossy downgrade. Exporting for an old reader requires an
explicit application decision to remove visibility and accept the resulting
visible drawings. Hidden data is still included in exported documents.

## Drawing panel

The opt-in [drawing panel](DRAWING-PANEL.md) has a `Hide drawing <ID>` or
`Show drawing <ID>` button on each row, with textual hidden/locked markers.
Separate checkboxes can select hidden and locked rows across pages. `Hide
selected` / `Show selected` act on that explicit group, at most 128 IDs. A changed
batch clears its prior group selection; a no-op preserves it. A changed row action
removes only that row from the prior group selection, preserving unrelated IDs.
Neither action overwrites a newer synchronous callback selection.

The DOM-free controller exposes `setVisibility(boolean)` for its group and
`setRowVisibility(snapshotRow, boolean)` for a row returned by that same
controller. Rows are identity-bound handles: copying a row is not valid, changing
its exposed metadata cannot retarget it, and an external edit/reload/same-ID
replacement makes it stale. A stale action rejects before mutation. Snapshot
handles use weak opaque identity tokens rather than retaining drawing anchors or
the controller. This is structural ownership, not a measured heap/GC guarantee.

Focus remains on a retained row button as its Show/Hide label changes. A removed
row or a focused button about to become disabled hands focus to Refresh drawings,
subject to existing ownership/reentry guards. All output uses textContent.
The [demo](../examples/web/drawing-groups.html) starts with one hidden locked row.

## Validation boundary

Maintained Node tests cover all 16 drawing types, locked/unlocked presentation,
atomic group limits, stale selection, history, versioned preparation, cache
identity, real CanvasChart routing with a modeled DOM/no-op Canvas, and panel
identity/focus/listener ownership. Four intentional bridge mutations must fail
specific assertions for schema, geometry, hit testing and selected-handle leaks;
raw diagnostics are emitted by the test reporter. These checks do not establish
real browser pixels/default actions, accessibility-tree or screen-reader behavior,
FPS, mobile UI, or native SDK execution. No nested groups, timeframe visibility,
workspace templates or global hide-all setting are introduced.
