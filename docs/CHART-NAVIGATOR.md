# Optional single-chart navigator

```js
import {attachChartNavigator} from 'barochart/canvas';
const navigator = attachChartNavigator(emptyElement, chart, {label: 'History range'});
console.log(navigator.snapshot()); // actual effective from/to/follow, not requested handles
navigator.refresh(); // also refreshed by this chart's non-hover state notifications
// navigator.destroy(); // idempotent, also called by chart.destroy()
```

The canvas/root helper adds native Start/End range inputs, Fit, a sampled-close
overview and a visible-range rectangle. It is opt-in, allows one binding per chart
and container, and creates no second ChartModel, subscriptions to a data vendor,
full-data copies, server requests or multi-chart synchronization group. The host owns
where the empty container is mounted and any custom presentation/localization.

## Range and overview contracts

- Changes use existing `ChartAPI.setVisibleRange`; Fit uses `ChartAPI.fit`.
  Core bounds, the minimum ten-logical-bar span and follow behavior are preserved.
  Snapshot/summary show the actual effective logical range. Handles are constrained
  to the current navigable extent, including visible forward plot offsets. A
  workspace range outside that extent is not silently rewritten by refresh.
- Empty sources disable all actions. Sources/forward extents of at most ten bars
  disable range handles; Fit still works when source bars exist. Whitespace and
  future plot offsets remain part of the core range contract.
- The overview reads at most 256 uniformly spaced **stored close values**, including
  endpoints, when source identity/version/extent changes. Pan/zoom reuses those
  points. This is a linear, index-spaced raw-close illustration, not OHLC aggregation,
  a min/max-preserving envelope, time-continuous spacing or the main axis's log/%
  projection. Unsampled spikes can be absent. It is not suitable as a full-resolution
  price readout. Extreme finite spans and flat prices produce finite coordinates.
- Input values update continuously through the native input event. Cancellation
  ends the local interaction; it does not undo already committed view changes.
  Range changes use ordinary API gesture/notification semantics, not drawing history.

## Source changes and ownership

Pointer/key input records the source store, column identity, managed version,
length and extent. Update/append/prepend/reset or offset changes invalidate that
active mapping. Later inputs in the same interaction are ignored and the controls
show the current effective view. End/restart the interaction to use the new mapping;
there is no hidden stale-index retry. A terminal event for another control, pointer, or unheld key
does not release the current mapping. Direct raw column writes are unsupported.

Listeners are attached to the chart container and accept only notifications from
its current canvas, so Canvas/GPU fallback does not strand the UI. Trusted internal
hover events do not trigger control reconciliation. Manual model changes that bypass
chart invalidation require `refresh()`. Stale controls, failed mounts, destruction,
and superseded DOM updates are guarded; teardown removes listeners and preserves
new outside focus. Disabled focused controls move focus to the navigator group.

The native inputs remain keyboard-accessible independently of the canvas's
`keyboardShortcuts` preference or `interactive:false` master switch, just like
optional toolbar controls. The group and overview have accessible names; errors
use a polite status region. The customization demo's unchecked toggle is the
discoverable example.

The navigator's presence, host placement and HTML are not serialized. The existing
workspace still saves the model's exact viewport/follow. This helper is web-only.
Tests execute real helper code with modeled DOM/SVG/events, not actual browser
range behavior, CSS, pointer capture, touch scrolling, screen readers or native UI.
No browser FPS or general performance claim follows from the sampling bound.
