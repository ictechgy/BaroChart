# Explicit drawing selection controls (web preview)

`attachDrawingPanel(emptyContainer, chart, {label: 'Drawing controls'})` adds an opt-in external list of native checkboxes and buttons. It uses the existing atomic group style/delete APIs. This is a Node/fake-DOM-tested web control preview: actual browser focus, visual layout, screen-reader behavior and mobile SDK UI are not certified. The list scans bounded drawing metadata (up to the existing 10,000-drawing limit); paging bounds DOM rows rather than promising constant-time source lookup. Selection/list lookup performs no study computation; a subsequent chart redraw can still lazily calculate dirty studies.

```js
import {attachDrawingPanel} from 'barochart';
const panel = attachDrawingPanel(dedicatedEmptyElement, chart);
// On application teardown (chart.destroy also disposes its panel):
panel.destroy();
```

The [standalone example](../examples/web/drawing-groups.html) shows 36 drawings over two pages and explicit Undo/Redo controls. No new pointer drag, canvas selection overlay or canvas keyboard shortcut is added. Native checkbox and button keyboard behavior is retained: Tab is not trapped and no keydown/composition handler intercepts text entry, IME or modifier shortcuts. Labels and a bounded polite status region are provided, but their assistive-technology behavior requires real-browser testing.

## Selection and actions

- At most 128 explicit IDs can be selected across pages of 32 rows. The count explains that Delete/Apply affects selected IDs on **all** pages. Locked drawings remain selectable and visibly marked; attempting a batch containing one rejects the entire batch.
- Only checked style fields are submitted. A checked blank value is an error, not a reset. The four field rules are documented in [Atomic drawing style patches](DRAWING-STYLE.md).
- Successful style changes clear the prior selection. A normalized no-op preserves it. Successful deletion clears the prior selection. A synchronous callback that makes a newer selection, clears, replaces ownership or disposes the controller is not overwritten by the returning action.
- `invalidationFailed` means the edit committed but its notification failed. Do not repeat the edit as if it rolled back. Undo remains one existing core operation; undo/redo does not restore historical group selection.
- Selection retains exact drawing object identities. An external edit, undo, redo, reload or removal can make an ID stale even if its spelling reappears. Refresh drops stale entries. An action that discovers any stale entry rejects the entire action before refreshing; it does not silently apply to the remainder.
- Source price-data changes alone preserve drawing selection. The controller never alters the existing single `model.drawings.selected`, pointer gesture or future drawing target.

Selection is temporary UI state. It is not included in drawings/workspace serialization. Multiple panels on the same chart or occupied container are rejected. Chart/API/model ownership is fixed at attachment; after replacing the model, destroy and recreate the panel rather than reusing its controls. The panel owns only its created subtree, uses textContent rather than HTML injection, and removes its event listeners and source references at destruction. A later panel using the container is not owned by an earlier disposer. Direct host mutation that bypasses chart API invalidation needs an explicit `panel.refresh()`; action-time checks still reject stale selected objects.

A focused checkbox is reused while its row stays present. When a refresh removes its row, focus is directed to the explicit Refresh button. Page switches may do the same. This is the intended control policy, not proof of browser-specific focus event ordering.

## DOM-free controller

`new DrawingSelectionController(api)` exposes `select(id, boolean)`, `clear()`, `refresh()`, `snapshot({offset, limit})`, `applyStyle(patch)`, `deleteSelected()` and idempotent `dispose()`. Snapshot is a fresh bounded row/ID description and does not prune selection; `staleCount` reports identity mismatches. Page offset is a nonnegative safe integer, limit is 1–32, and beyond-end pages are empty. The controller uses captured library ChartAPI group methods, not user-overridden method hooks. Ordinary own data source properties and managed immutable drawings are required; this is not a sandbox for arbitrary Proxy traps or modified global intrinsics.

## Validation record (2026-10-13)

All **169 `test/*.test.mjs` files** passed in **nine serial batches**, totaling **3,387/3,387 tests**, zero failures, skips or cancellations. The fixed file/hash manifest was checked for zero missing or duplicate files. This was a segmented completion, not a successful monolithic `npm test`: three earlier long execution sessions were interrupted before terminal results; their partial logs are preserved, and no pass/failure is inferred from those interruptions. No assertion or product timeout was weakened.

The new focused suite passed **131/131**: 84 DOM-free controller tests and 47 real-CanvasChart tests using a bubbling fake DOM and queued RAF. Existing keyboard/explorer regressions passed 78/78. All 396 ESM files parsed; strict TypeScript 5.9.3 and offline installed-package checks passed. Demo HTML local references and JavaScript wiring were checked statically. Independent review confirmed model/API ownership guards and focus-triggered callback state preservation.

These checks do not run actual browser native checkbox defaults, focus event ordering, rendering, assistive technology or mobile SDK UI. Drawing lookup tests stop before RAF and make no dirty-redraw latency guarantee. Selection and listener cleanup assertions are structural, not a measured long-term heap/GC claim.

For the subsequent metadata work reduction and all measured regressions/outliers, see [Drawing selection metadata cost](DRAWING-SELECTION-COST.md).

The style controls now use separate sibling labels for each checkbox and value input. Each implicit label contains exactly one labelable control, following the [HTML label content model](https://html.spec.whatwg.org/multipage/forms.html#the-label-element). The prior shared label contained both inputs. Accessible names and keyboard order are preserved; the structural fake-DOM regression does not establish actual browser or assistive-technology behavior.
