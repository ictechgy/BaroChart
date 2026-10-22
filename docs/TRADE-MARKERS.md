# External trade-ID annotations (web)

```js
import {attachTradeMarkers} from 'barochart/canvas';
const markers = attachTradeMarkers(emptyOverlay, chart, {
  label: 'My trade annotations',
  markers: [{id:'fill-1', tradeID:'host-trade-42', time:1700000000000,
    price:101.5, panel:'price', axisId:null, side:'buy', label:'Entry'}],
  onSelect(marker) { hostShowTrade(marker.tradeID, marker.id); }
});
markers.snapshot(); // frozen per-marker status and CSS center, not an order receipt
markers.setMarkers(nextHostRecords); // replaces the complete list after validation
markers.refresh(); // uses only a current, successfully committed chart projection
// markers.destroy(); // also called by chart.destroy()
```

## Host and placement boundary

This optional CanvasChart/root helper has one binding per chart/container. It owns
its generated DOM only. The host must provide a dedicated empty overlay whose CSS
origin and dimensions **exactly match the chart canvas**. The demo uses a borderless,
unpadded positioned chart host and absolute `inset:0` overlay with `pointer-events:none`.
Do not add independent padding, borders, offsets or transforms without maintaining
that same coordinate space. The helper does not measure/correct arbitrary docking.

The host owns trade identity, data acquisition, source/instrument matching, revision
policy, persistence, reconciliation, journal/navigation UI and callback actions.
Clear/replace records when instrument, price units or source meaning changes.
Matching timestamps and prices do **not** prove dataset identity. A same-instrument
reset/correction can reproject the existing records; no guessed instrument detection
or sticky reset gate is added. No broker execution, trade history fetch, order/fill
tracking, PnL, account access, server, autoscale contribution or drawing history exists.

## Admission and projection

- Maximum 256 records. IDs are unique nonempty strings up to 128 UTF-16 units;
  ordinary reserved-ID restrictions apply. Opaque nonempty `tradeID` values may
  repeat across distinct marker IDs. Labels allow up to 128 units, including empty.
  All metadata is scalar-Unicode plain data, with no getters, symbols, hidden/extra
  fields, sparse arrays or executable content. Invalid replacement keeps prior records.
- Required fields are id, tradeID, exact safe-integer UTC-millisecond time (Date range),
  finite raw price and panel. axisId defaults to null (panel's default price domain);
  side is null, buy or sell; label defaults to empty. Normalized records/list snapshots
  are detached and frozen. No HTML is parsed or color/style callback evaluated.
- Time matches a stored bar-open timestamp **exactly** by binary search. A timestamp
  between bars or in a session gap is `unmatched`, never interpolated or snapped.
  Unknown panel or panel-specific axis is `unbound`. Log price <=0, nonfinite mapped
  coordinates or a center outside that panel are `offscreen`. Only `visible` markers
  have finite x/y CSS coordinates; all other coordinates are null.
- Independent, percent/base and inverted axis projection uses the same committed
  layout as the chart. A hidden axis strip does not hide its price domain. Marker
  centers use the captured logical viewport, not a mutable layout closure. Buttons
  are clipped to their panel, so edges may be cut off. Overlapping markers are not
  clustered or collision-resolved. DOM/tab order groups by panel and insertion/visibility
  history; it is not a global host-record or chronological order guarantee.

## Freshness, accessibility and lifecycle

Non-hover chart state changes hide the overlay before the next paint. Source updates,
viewport/axis/series changes, resize and fallback require a successfully committed
render before projection becomes selectable again. A private optional render
certificate checks source identity/version/columns, viewport, size, captured layout
configuration, managed external-series revisions and study identities. Nested or
invalidated/failed rendering cannot certify an obsolete projection. No extra model,
full-source copy or extra render loop is created; no capture occurs when unattached.
Direct model changes must still be followed by chart invalidation/draw for timely
visual updates. Managed identity/revision differences also block stale selection;
raw mutation of columns, study internals or configuration objects is unsupported.

`snapshot()` reports `unrendered` when no current certificate is available.
Callbacks receive only the current immutable marker record. Stale detached controls
and recursive selection dispatch are ignored. The callback may replace markers or
destroy the helper; it is synchronous, and thrown host errors follow event dispatch.
The helper never follows the callback with a trade action.

The group and each marker have accessible names; labels use textContent. With an
onSelect callback, native buttons support keyboard activation. Without a callback,
buttons are disabled read-only annotations. Hiding/removing a focused annotation
moves focus to the live canvas; terminal teardown respects newer/outside focus.
Handlers are removed on explicit or chart destruction. The host can remount afterward.

The customization demo has an unchecked synthetic-marker toggle and ID-only status
callback. Marker records/presence are not part of workspace, UI preferences or replay
session serialization. Tests execute actual helpers/drawNow with modeled DOM and a
no-op renderer, not real CSS alignment, browser focus/touch, screen readers, GPU,
native SDK/device runtime or visual acceptance. Bounds are not FPS/latency claims.
