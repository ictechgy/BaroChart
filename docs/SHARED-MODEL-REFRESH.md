# One-authority shared-model refresh recipe

Two `CanvasChart` instances can render the **same `ChartModel` object**. They
already share drawings, selection, undo/redo, the single drawing transaction,
series, symbol configuration, view and raw crosshair. A drawing API or controller
mutation normally invalidates its own chart only. Siblings can therefore retain
an old drawing frame until explicitly invalidated. BarStore's automatic data
notifications are a separate path; there is no DrawingStore committed-change
subscription.

This is host wiring using existing APIs, not a new drawing synchronization API.
Use one interactive authority and display-only mirrors. Do not use independent
models merely because they have equal symbol IDs: one model here owns the exact
source, units, bindings and history. There are no copies, receive-side undo
entries, broadcasts, device connections or independent timeframe promises.

## Construct views with one input authority

```js
import {CanvasChart} from 'barochart/canvas';
// model, authorityHost and mirrorHost are supplied/owned by this host.
const authority = new CanvasChart(authorityHost, model);
const mirror = new CanvasChart(mirrorHost, model, {interactive: false});
mirror.canvas.tabIndex = -1;
mirror.canvas.setAttribute('aria-label', 'Read-only shared chart mirror');
```

Give both host elements explicit nonzero dimensions. Only the authority gets
input bindings and application drawing controls. `interactive:false` disables
CanvasChart input listeners; it is not access control and does not remove the
mirror's API/controller. The host must not invoke those mutation APIs as a second
authority. The mirror is removed from sequential keyboard focus above; no screen
reader or physical browser accessibility validation is claimed by this recipe.

## Manual post-command refresh

For hosts that only mutate through explicit commands, invalidate each mirror
following the command. Use `finally` if an application callback can throw after
the model commit. Invalidating after an admission failure is harmless; an
invalidation or paint failure does not roll back an already committed command.

```js
try {
  authority.api.addDrawing({
    id: 'reference', type: 'horizontal', points: [{time: knownTime, price: 100}],
  });
} finally {
  mirror.invalidate();
}
```

Do the same after edit, hide/show, duplicate, group operations, load, undo and
redo. This manual pattern alone does **not** catch pointer previews or cancellation.
For custom input adapters, `InteractionController(model, size, invalidate)` and
`ChartAPI(model, {controller, invalidate})` accept an invalidate callback at
construction; that host-owned callback can refresh all its views. CanvasChart's
existing controller callback is already installed. Do not replace or monkeypatch
it to attach a listener.

## Optional one-way DOM invalidation relay

The current Canvas renderer emits a bubbling `aster:state` DOM event when it is
invalidated; the existing drawing panel consumes that event too. It is generic:
hover, preview, cancellation, view/configuration and drawing operations can all
emit it. It has **no commit, drawing ID, revision or invalidation-kind payload**.
This example depends on that existing web event, not on a new core subscription.

Use the retained host element, and compare against the authority's **current**
public `canvas` on every event. Canvas fallback can replace the canvas. Do not
capture an old canvas or read undeclared renderer container/model fields. A
mirror's own invalidation also emits an event, so the exact target check and
one-way direction are essential, even if the hosts are nested.

<!-- shared-refresh-listener -->
```js
const refreshMirror = event => {
  if (event.target === authority.canvas) mirror.invalidate();
};
authorityHost.addEventListener('aster:state', refreshMirror);
mirror.invalidate(); // bring an already-mounted mirror up to date
const stopMirroring = () => {
  authorityHost.removeEventListener('aster:state', refreshMirror);
};
```

Plain `invalidate()` is deliberately used: view, theme and cursor are shared as
well as drawings. It can re-evaluate studies/base layers; no drawing-only cost or
zero-study-query guarantee is made. Scheduled redraws coalesce through the
existing renderer RAF. This relay does not copy drawings or call any mutation
API, so preview/commit/cancel and undo/redo use the original single history.
Do not reflect mirror events back to the authority. If extending to many mirrors,
handle redraw errors so one failing view does not prevent refreshing the rest;
report uncertainty and explicitly refresh/recreate failed views rather than
claiming that a model mutation rolled back.

## Teardown and fallback

Stop relaying **before** removing either view. If the authority is destroyed
while drawing, its own preview may be canceled after it stops emitting events.
Explicitly refresh a surviving mirror after teardown:

<!-- shared-refresh-teardown -->
```js
stopMirroring();
try {
  authority.destroy(); // default disposeModel:false; the mirror still uses model
} finally {
  mirror.invalidate();
}
// Later, when the host no longer needs any view:
mirror.destroy();
model.dispose();
```

Do not call `destroy({disposeModel:true})` while another view uses the model.
Detach relays and application input/control listeners before disposal. A new
renderer/replacement host needs a new explicit relay. Fallback of the authority
keeps the host listener and reads its new canvas; renderer fallback retains its
existing gesture ownership rules. For a host-owned controller separate from
CanvasChart, explicitly cancel its owned gesture before retiring that adapter.

Shared view coordinates are logical bar indices, not independent time windows.
The raw crosshair is shared screen `{x,y}`; different-sized views do not
necessarily show the same time/price under that coordinate. This is not semantic
cursor synchronization. Use the separately documented [time cursor](TIME-CURSOR.md)
and [time range](TIME-RANGE.md) groups with **independent models** when that is the
required ownership model; those groups cannot be attached twice to this same
model to create independent views.

## Why automatic independent-model copying is deferred

Drawing documents contain panel/axis/series IDs and UTC/raw-price anchors, but no
symbol, currency, adjustment-version or timeframe provenance. Matching IDs can
still refer to different units. Different stored timelines interpolate anchors
and bar-count tools differently. `saveDrawings()` rejects active transactions;
`loadDrawings()` replaces the target document and adds target history. Repeating
loads is neither an echo-free receive operation nor a shared undo stack.

An explicit host-directed committed transfer must independently verify symbol,
currency/price unit, adjustment version, data/timeframe policy and every binding,
and accept replacement/history behavior. Drawing JSON alone cannot certify
these conditions. No automatic cross-model/cross-symbol/cross-device drawing
synchronization is added by this recipe.

## Validation boundary

`test/shared-model-refresh-doc.test.mjs` executes the literal relay/teardown
snippets using real core/CanvasChart classes in a deterministic Node DOM/RAF and
no-op Canvas host. It checks stale-frame reproduction, preview/commit/cancel,
undo/redo, current-canvas fallback, no echo, cleanup and single-history behavior.
These are source/scene/lifecycle checks. Actual DOM event propagation, trusted
pointer input, GPU context loss, pixels, accessibility and FPS still need real
browser validation; none is claimed here.
