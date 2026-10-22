# Style-only drawing presets

`DrawingStylePresets` is an opt-in, host-owned registry exported from `barochart`
and `barochart/core`. A preset is a nonempty portable **partial style patch**.
It records only supplied `color`, `fill`, `width` and `font` keys. Applying it
leaves every unrecorded target field unchanged; it does not restore defaults or
clear fields. The registry never stores a chart, drawing geometry, text,
bindings, lock/visibility state, executable content, URLs to fetch, or callbacks.

```js
import {DrawingStylePresets, attachDrawingPanel} from 'barochart';
const presets = new DrawingStylePresets();
presets.set('Emphasis', {color: '#3366cc', width: 3});
presets.capture(chart.api, 'my-line', 'Saved line');
const result = presets.apply(chart.api, ['line-a', 'line-b'], 'Emphasis');
const panel = attachDrawingPanel(container, chart, {stylePresets: presets});
const json = presets.save();               // host chooses whether/where to save
presets.load(json, {replace: true});        // merge; matching names only
panel.refresh();                          // after external registry changes
```

## API and limits

- `set(name, patch, {replace?: boolean})`, `capture(api, id, name, options)` and
  `remove(name)` return frozen `{changed: 0|1}` receipts. `load(text, options)`
  returns frozen `{changed: number}` counting changed names, not style fields.
- `get(name)` returns an immutable `{name, style}` record or `undefined`.
  `list()` returns a frozen array in insertion order. Replacing a name retains
  its position; an equivalent explicit replacement retains its exact record
  identity. Removing then re-adding appends it. No returned data can mutate the
  registry. Each registry is independent; hosts may explicitly share one.
- Names are case-sensitive. Raw names have at most 128 UTF-16 code units;
  `trim()` runs before lookup/collision/duplicate checks. Canonical names contain
  1–64 UTF-16 code units. C0/C1 control characters are rejected even at the raw
  edges. `__proto__`, `constructor` and `prototype` are reserved. No Unicode
  normalization or locale-based case folding is performed. A private `Map`
  stores entries, not object-property lookup.
- At most 64 presets. A standalone document is at most 65,536 UTF-16 code units;
  admission checks both the input and the final serialized merged registry.
  Validation and serialization are bounded by registry content, not constant time.
- Style rules are the same normalizer as `setDrawingsStyle`: portable basic named,
  hex or comma RGB/RGBA colors (input strings ≤128 code units), finite width
  0.1–50, and portable 4–96px fonts (≤256 code units). Colors normalize to RGBA
  hex. CSS variables, URL colors, empty patches, null/undefined values, unknown
  keys, accessors, symbols and non-enumerable fields are rejected. No renderer
  defaults are captured. A drawing created through ordinary creation may
  already have materialized default style keys; those are stored keys.
- Capture requires one existing immutable stored drawing and a live managed
  model/store, with no active gesture or drawing transaction. Hidden, locked and
  orphan-bound sources can be captured without changing them. Missing/empty or
  nonportable stored styles fail without changing the registry. Capture and
  registry-only operations do not query indicators or produce chart history.

## Apply, history and ownership

`apply(api, ids, name)` delegates to the existing atomic `setDrawingsStyle`
planner and returns frozen `{changed, invalidationFailed}`. IDs are an explicit
1–128 element, unique list; all selected rows must exist and be unlocked.
Mixed/orphan bindings and hidden rows can receive styles. No geometry, source
binding, visibility, lock state, drawing order, canvas selection or ID changes.
An active gesture/transaction, invalid row, resource/history failure or locked
row rejects the whole batch. A real change produces one undo unit; a no-op
preserves history and object identity. Normal canvas Undo/Redo affects drawings,
not this host-owned preset registry.

The existing style API uses general chart invalidation. A subsequent frame can
refresh the base and query visible studies even with caching enabled; this is
not a zero-compute redraw promise. Pointer/crosshair coordinates and keyboard
exploration time/index/series remain intact; active exploration enters its
existing `changed` phase. Applying does not publish a new pointer time to a
`TimeCursorGroup`. Fresh snapshot queries retain their usual layout cost.

If a redraw callback fails after publication, `invalidationFailed: true` reports
a committed edit. Do not repeat it as though it rolled back. Reentrant chart
callbacks may replace models, change selection, remove presets or dispose the
panel; the caller receives the completed operation's receipt. A registry has no
ownership of chart lifetime and no automatic attachment to a replacement API.

## Optional panel

Pass `{stylePresets: presets}` to `attachDrawingPanel`. The controls have sibling
labels for a name, saved-preset selector and explicit Replace checkbox:

- Capture selected style requires exactly one group checkbox selection and
  retains it. Capture uses its actual stored fields, independent of the manual
  style checkboxes. Replacing an existing name requires the Replace checkbox.
- Apply style preset uses all selected IDs across pages and clears only the
  successfully changed prior group selection, preserving newer reentrant
  selection. A locked target rejects the entire apply; its style can still be
  captured. A no-op retains selection.
- Delete style preset changes only the registry, leaving all drawings and
  checkbox selection intact.

The panel remembers each preset's identity, including absence for a typed new
name. External same-name replacement/removal cannot silently affect an Apply,
Delete or Capture/Replace action before refresh. Drawing selection uses the
existing immutable row identity checks. A selector change alone does not accept
new registry identities. Call `panel.refresh()` after external changes; there
is no registry subscription, localStorage, network sync, system clipboard,
automatic save, default-style mutation or workspace persistence. Destroying the
panel removes its listeners but leaves the host-owned registry available.
Panels without this option retain their previous controls and metadata scan cost.

## Separate persistence and native boundary

```json
{"schema":"barochart.drawing-style-presets","version":1,"presets":[{"name":"Emphasis","style":{"color":"#3366ccff","width":3}}]}
```

This new standalone format uses the current BaroChart namespace. Existing
`aster.drawings` and workspace schemas are unchanged. Import is a strict,
fully validated atomic **merge**, including an empty list. It never erases
unmentioned names. Existing name collisions require explicit `replace: true`,
even for equivalent patches; canonical duplicate names within an input always
fail. Replacement means per-name overwrite, not clearing the registry. Drawing
and workspace documents do not contain the preset registry.

The DOM-free class is present in the generated native JavaScript core. Native
hosts can read an exported preset patch and pass it to their existing
`setDrawingsStyle` facade. This release adds no Swift/Java preset-store API or
native preset UI; no such parity is claimed. Preset documents contain only data
and never run scripts or load external resources.

## Evidence boundary and reference

Checked-in tests cover strict bounds/fields, normalized collisions, capture and
merge atomicity, immutable identity, locked/hidden sources, one-undo apply,
selection and panel reentry/disposal, plus actual CanvasChart JavaScript with a
deterministic DOM and no-op Canvas. Node VM checks exercise canonical and shipped
native JavaScript and four deliberate mutations with specific assertion failures.
These are not browser raster, accessibility-tree, assistive-technology, Mac,
Swift, Java, JNI or native SDK execution results. Those checks remain unrun.

TradingView's [drawing templates documentation](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/#templates)
and [same-type batch-template workflow](https://www.tradingview.com/blog/en/templates-for-same-type-drawings-33205/)
were behavior references only. This slice deliberately uses the four style keys
already common to BaroChart's batch style API; it is not a full tool template
system. No vendor code or assets were copied.
