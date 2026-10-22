# Optional web UI / UX customization

The core theme, panel, axis, series and drawing APIs remain the source of chart state. This layer adds **optional HTML controls and web input preferences**, not a new settings engine. Nothing is mounted unless the host calls `attachChartToolbar`. Existing renderer defaults remain pointer/wheel/keyboard enabled with an 8-logical-pixel hit tolerance.

Open [`examples/web/customization.html`](../examples/web/customization.html) through the local demo server. The main demo links it and retains its original controls/layout. The separate demo provides:

- Dark/light presets, six chart colors and 10/12/14/16/20/24 px font choices.
- Tool visibility and ordering, preset tool lists, toolbar top/left/right placement and comfortable/compact density. Narrow screens place the toolbar above the chart.
- Explicit desktop/mobile input and toolbar presets (no device detection).
- Pointer/drag/pinch, wheel zoom and ordinary keyboard-shortcut enable switches, plus hit tolerance.
- Existing panel height ratios and primary price-axis left/right placement.

There is **no shortcut remapping, arbitrary panel docking/reordering/hiding, automatic persistence, trading control or native UI parity**. These demo settings reset on reload unless the user explicitly loads saved input/toolbar preferences. Drawing files do not contain them. See [versioned UI state](WEB-UI-STATE.md) for the new pure codec and host storage boundary. Existing workspace serialization still covers its existing chart configuration, not these new toolbar/input/chrome preferences.

## Host-facing toolbar

```js
import {CanvasChart, attachChartToolbar} from 'barochart/canvas';

const chart = new CanvasChart(chartElement, model);
const toolbar = attachChartToolbar(emptyControlsElement, chart, {
  label: 'Price chart tools',
  tools: ['select', 'trendline', 'horizontal', 'rectangle'],
  actions: ['fit', 'zoomIn', 'zoomOut', 'undo', 'redo'],
  orientation: 'horizontal',
  density: 'comfortable',
});

toolbar.setOptions({tools: ['select', 'horizontal'], density: 'compact'});
console.log(toolbar.snapshot());
toolbar.refresh(); // also refreshes automatically on this chart's aster:state
// toolbar.destroy(); // idempotent; also called by chart.destroy()
```

The container must be empty and unowned. At most one toolbar attaches to a live chart. The host owns its location and dimensions; the helper does not move surrounding panels. Tool IDs are `select` plus existing `DrawingType` IDs. Action IDs are exactly `fit`, `zoomIn`, `zoomOut`, `undo`, `redo`. Ordered lists reject unsupported or duplicate IDs; tools must include `select`, while actions may be empty. Unknown keys, accessors, invalid labels/orientation/density and invalid list values are rejected before changing options. Labels are 1–128 nonblank characters. `setOptions` merges a patch; lists replace the prior list. Snapshot records and lists are frozen.

Attaching a filtered toolbar or removing the current tool explicitly selects `select`, using the existing API and its cancellation behavior. This is an intentional tool command, not silent filtering of the chart's capabilities. Another programmatic tool command can still select a tool outside the displayed list; then no displayed tool is pressed until the host changes tool/options. Programmatic commands remain available when controls or canvas inputs are absent/disabled.

Native buttons use visible English names, titles, `aria-pressed` on tools, and actual disabled Undo/Redo state. Tab visits enabled buttons; this is a labeled group, not a roving-tabindex ARIA toolbar. Focus is retained when surviving controls reorder; removing or disabling the focused toolbar control moves focus to the group. The helper tracks its original chart/model ownership and ignores retired buttons. Raw store edits without chart invalidation require `refresh()`.

The helper does not parse HTML, add a stylesheet, or modify global CSS. It uses scoped classes and inherited CSS variables with explicit dark defaults:

| Variable | Purpose/default |
| --- | --- |
| `--barochart-ui-background` | Group background, `#0c1320` |
| `--barochart-ui-surface` | Button background, `#111d2e` |
| `--barochart-ui-text` | Button/group text, `#dfe8f4` |
| `--barochart-ui-border` | Button border, `#2b3950` |
| `--barochart-ui-selected-background` | Pressed tool background, `#18352f` |
| `--barochart-ui-selected-text` | Pressed tool text, `#7ce8ca` |
| `--barochart-ui-gap` | Control spacing, `6px` |
| `--barochart-ui-padding` | Group padding, `6px` |

Native focus styling remains intact. The demo additionally uses a scoped `--barochart-ui-focus` outline. Comfortable buttons have 44 px minimum height, compact buttons 32 px. Hosts are responsible for contrast, focus visibility, touch targets and accessible localized controls when restyling. CSS variables style HTML only; they are **not** accepted as portable canvas Theme colors. Use `chart.api.setTheme({background,grid,text,up,down,crosshair,font})` for chart appearance and existing series APIs for per-series colors.

## Independent web input preferences

```js
const chart = new CanvasChart(chartElement, model, {
  interaction: {pointer: true, wheelZoom: false, keyboardShortcuts: true,
    hitTolerancePx: 12},
});
chart.setInteractionOptions({wheelZoom: true});
const policy = chart.interactionOptions; // frozen current snapshot
```

- Constructor and setter accept partial plain data records with only these four keys. Booleans are strict; `hitTolerancePx` must be finite and within 1–32 logical pixels. Fractional values are accepted. Setters merge; invalid patches leave prior state and gestures unchanged. Equivalent patches are no-ops.
- `pointer:false` stops hover, pan, drawing and pinch routing. It cancels only this controller's owned gesture, releases its pointer captures/cursor ownership, and sets canvas touch-action to `auto`. It does not cancel another controller's drawing transaction or erase its cursor. A stale pointer event cannot restart a disabled gesture.
- `wheelZoom:false` leaves wheel default behavior alone and does not exit keyboard data exploration.
- `keyboardShortcuts:false` disables ordinary chart navigation/edit shortcuts. It does **not** disable the separately configured, explicitly activated keyboard data explorer. Existing IME, modifier, target and focus guards remain.
- `interactive:false` is still the constructor's master binding switch. A later preference setter cannot install bindings it disabled. The canvas permits normal touch behavior when pointer routing is unavailable.
- Pointer policy is checked again after synchronous focus/exploration callbacks. A change during an event prevents its obsolete continuation. Pointer capture cleanup precedes linked-cursor notifications.
- The policy survives Canvas fallback/replacement. It is a preference, not a read-only/security boundary: API methods, native/core controllers and toolbar actions are not prohibited.

Preference state can commit before a synchronous host notification throws. As with existing chart APIs, a notification error is not proof of rollback; inspect current state before retrying. Reentrant callbacks may supersede an outer update. `refresh()` returns `null` if its render is superseded or ownership is lost. `setOptions()` returns the latest snapshot while ownership remains valid (possibly reflecting reentrant changes), or `null` after ownership loss.

## React

`AsterChart` applies `options.interaction` live without recreating the chart/model/canvas. Defined partial records are interpreted against the defaults, so removing a key from a defined record restores that key's default. Omitting `interaction` entirely leaves current imperative preferences alone and releases the previous comparison cache. Equivalent values do not cancel gestures. Invalid records use the same strict validation as direct hosts, without evaluating getters. Repeated identical rejected records are not reported again; correcting their descriptor/value or omitting and reintroducing them allows a new attempt.

## Main demo startup correction

The main Theme button previously dereferenced an absent model while initial asynchronous preparation was pending. Preferences and pressed/chrome state now update safely before a model exists; installation applies the latest preset. Known demo palette colors continue following light/dark presets after API color normalization; other explicitly supplied series colors remain unchanged. Light mode now has matching HTML chrome rules. Deliberate Cancel and v85 page-restoration policy are unchanged.

## Verification boundary

Maintained Node tests exercise actual web/helper/demo source with modeled DOM, queued RAF, synchronous callback reentrancy, state/history ownership, pointer-capture retirement, toolbar focus reconciliation, invalid options, theme startup, panel bindings, contrast pairs and exports/types. React coverage uses the actual adapter with a modeled hooks scheduler, **not** the React runtime or StrictMode/hydration. Pixel/computed-style layout, actual touch scrolling, real browser keyboard/focus, assistive technology, native/JNI and Mac execution remain unrun for this change. This is not accessibility certification, a performance result, or cross-platform parity evidence.

## Explicit mobile preset

`createChartUIPreset('mobile')` (canvas/root) returns a detached, deeply frozen UI configuration: pointer and ordinary keyboard shortcuts remain enabled, wheel zoom is disabled, hit tolerance is 24 logical CSS pixels, and the horizontal comfortable toolbar retains the basic four tools plus Fit/Undo/Redo. Comfortable buttons retain their existing 44px minimum height; this is not a claim that every styled target has a 44px minimum width. `createChartUIPreset('desktop')` returns the existing 8px/enabled input defaults and full default toolbar actions. Neither function mounts anything, changes defaults, reads a user agent, remaps shortcuts, or affects native hosts.

Pass the returned interaction record to a fresh CanvasChart and toolbar record to attachChartToolbar, or explicitly apply through the existing setters. The demo device selector is an action, not automatic responsive state; it resets to its prompt after applying. It rejects changes while an input gesture is active. Save the resolved values with saveChartUI, not just a preset name. A mobile preset does not override `interactive:false` or disable the independent keyboard explorer. Actual mobile scrolling, touch targets and screen readers remain unverified.

## Optional overlay slots

[Fixed corner slots](CHART-OVERLAYS.md) host application controls without HTML parsing, scene callbacks, arbitrary docking or changing chart data. They mount only when requested and retire with the chart. The demo toggle is off by default.

## Optional navigator

[The navigator](CHART-NAVIGATOR.md) adds native Start/End range controls, Fit and a bounded sampled-close overview for one chart. It is off by default, uses existing range/follow semantics and retires with the chart.

External host trade IDs can also use the optional [trade marker helper](TRADE-MARKERS.md). It is a separately owned price/time overlay, not a drawing or order.
