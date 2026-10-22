# Explicit drawing selection controls (web preview)

`attachDrawingPanel(emptyContainer, chart, {label: 'Drawing controls'})` adds an opt-in external list of native checkboxes and buttons. It uses the existing atomic group style/delete/visibility/duplication APIs. This web control preview has Node/fake-DOM coverage and scoped Mac Chrome focus checks; broad visual layout, screen-reader behavior and mobile SDK UI are not certified. See [browser QA scope](PUBLIC-VALIDATION.md#scoped-mac-browser-qa-2026-10-14). The list scans bounded drawing metadata (up to the existing 10,000-drawing limit); paging bounds DOM rows rather than promising constant-time source lookup. Selection/list lookup performs no study computation; a subsequent chart redraw can still lazily calculate dirty studies.

```js
import {attachDrawingPanel} from 'barochart';
const panel = attachDrawingPanel(dedicatedEmptyElement, chart);
// On application teardown (chart.destroy also disposes its panel):
panel.destroy();
```

The [standalone example](../examples/web/drawing-groups.html) shows 36 drawings over two pages and explicit Undo/Redo controls. No new pointer drag, canvas selection overlay or canvas keyboard shortcut is added. Native checkbox and button keyboard behavior is retained: Tab is not trapped and no keydown/composition handler intercepts text entry, IME or modifier shortcuts. Labels and a bounded polite status region are provided, but their screen-reader/assistive-technology behavior remains unverified.

## Selection and actions

- At most 128 explicit IDs can be selected across pages of 32 rows. The count explains that Delete/Apply affects selected IDs on **all** pages. Locked and hidden drawings remain selectable and visibly marked. Style/delete batches containing a locked drawing reject; visibility can change locked drawings.
- Only checked style fields are submitted. A checked blank value is an error, not a reset. The four field rules are documented in [Atomic drawing style patches](DRAWING-STYLE.md).
- Successful style changes clear the prior selection. A normalized no-op preserves it. Successful deletion clears the prior selection. A synchronous callback that makes a newer selection, clears, replaces ownership or disposes the controller is not overwritten by the returning action.
- `invalidationFailed` means the edit committed but its notification failed. Do not repeat the edit as if it rolled back. Undo remains one existing core operation; undo/redo does not restore historical group selection.
- Selection retains exact drawing object identities. An external edit, undo, redo, reload or removal can make an ID stale even if its spelling reappears. Refresh drops stale entries. An action that discovers any stale entry rejects the entire action before refreshing; it does not silently apply to the remainder.
- Source price-data changes alone preserve drawing selection. Checkbox selection never replaces the canvas selection. Hiding its selected drawing clears `model.drawings.selected`; visibility rejects active gestures and leaves the future drawing target alone.

Selection is temporary UI state. It is not included in drawings/workspace serialization. Multiple panels on the same chart or occupied container are rejected. Chart/API/model ownership is fixed at attachment; after replacing the model, destroy and recreate the panel rather than reusing its controls. The panel owns only its created subtree, uses textContent rather than HTML injection, and removes its event listeners and source references at destruction. A later panel using the container is not owned by an earlier disposer. Direct host mutation that bypasses chart API invalidation needs an explicit `panel.refresh()`; action-time checks still reject stale selected objects.

A focused checkbox is reused while its row stays present. When a refresh removes its row, focus is directed to the explicit Refresh button. Page switches may do the same. This is the intended control policy, not proof of browser-specific focus event ordering.

## DOM-free controller

`new DrawingSelectionController(api)` exposes `select(id, boolean)`, `clear()`, `refresh()`, `snapshot({offset, limit})`, `applyStyle(patch)`, `duplicate({deltaTimeMs, deltaPrice})`, `setVisibility(boolean)`, `setRowVisibility(snapshotRow, boolean)`, `deleteSelected()` and idempotent `dispose()`. Snapshot is a fresh bounded row/ID description and does not prune selection; `staleCount` reports identity mismatches. Page offset is a nonnegative safe integer, limit is 1–32, and beyond-end pages are empty. The controller uses captured library ChartAPI group methods, not user-overridden method hooks. Ordinary own data source properties and managed immutable drawings are required; this is not a sandbox for arbitrary Proxy traps or modified global intrinsics.

## Validation record (2026-10-13)

All **169 `test/*.test.mjs` files** passed in **nine serial batches**, totaling **3,387/3,387 tests**, zero failures, skips or cancellations. The fixed file/hash manifest was checked for zero missing or duplicate files. This was a segmented completion, not a successful monolithic `npm test`: three earlier long execution sessions were interrupted before terminal results; their partial logs are preserved, and no pass/failure is inferred from those interruptions. No assertion or product timeout was weakened.

The new focused suite passed **131/131**: 84 DOM-free controller tests and 47 real-CanvasChart tests using a bubbling fake DOM and queued RAF. Existing keyboard/explorer regressions passed 78/78. All 396 ESM files parsed; strict TypeScript 5.9.3 and offline installed-package checks passed. Demo HTML local references and JavaScript wiring were checked statically. Independent review confirmed model/API ownership guards and focus-triggered callback state preservation.

These checks do not run actual browser native checkbox defaults, focus event ordering, rendering, assistive technology or mobile SDK UI. Drawing lookup tests stop before RAF and make no dirty-redraw latency guarantee. Selection and listener cleanup assertions are structural, not a measured long-term heap/GC claim.

For the subsequent metadata work reduction and all measured regressions/outliers, see [Drawing selection metadata cost](DRAWING-SELECTION-COST.md).

The style controls now use separate sibling labels for each checkbox and value input. Each implicit label contains exactly one labelable control, following the [HTML label content model](https://html.spec.whatwg.org/multipage/forms.html#the-label-element). The prior shared label contained both inputs. Accessible names and keyboard order are preserved; the structural fake-DOM regression does not establish actual browser or assistive-technology behavior.

## Repeated state notifications

The panel refreshes synchronously for matching `aster:state` events except dispatch-scoped, library-originated hover-only notifications. Those notifications still reach public listeners but do not rescan unchanged controls. Host-created or replayed events always refresh. Every actual refresh validates the full drawing source, including off-page rows; same-array edits are not hidden by an identity cache. Source validation remains O(n), and multiple non-hover events in one animation frame still repeat that work. Direct host mutations require `panel.refresh()` or a non-hover invalidation; hover alone is not a drawing-change notification.

Rendering compares the actual `checked`, `textContent` and `disabled` properties before assigning them. With visibility and duplication controls, an unchanged 32-row page avoids 105 assignments per refresh, at the cost of 105 property reads (row checkbox, metadata and Show/Hide label, plus count and eight disabled states). Actual host edits to these values are repaired on the next refresh. Matching text content does not promise normalization of arbitrary host-added child markup. Selection/style text inputs and live status announcements retain their existing behavior.

Property reads and writes are separated by ownership, render-generation and selection-generation checks. A comparison getter or setter that disposes/remounts the panel or starts a newer selection cannot continue writing the older render. Current getter errors remain errors; an error from an already-obsolete render is discarded. Only trusted hover-only refreshes are skipped; no source-revision cache or next-frame delay is introduced.

The original pre-visibility instrumentation at 1,000 and 10,000 drawings recorded 210 assignments across three unchanged baseline notifications versus zero assignments and 210 reads. The visibility checkpoint counted zero assignments and 312 reads across three unchanged notifications. The Duplicate selected checkpoint included the eighth disabled state and recorded zero assignments and 315 reads across three full refreshes. Current maintained tests record zero control-property reads/writes across three hover notifications, then 105 reads and zero writes for one explicit drawings refresh. This measures these explicit property operations, not total allocation, browser style/layout work, FPS or assistive-technology behavior. Existing focus, source-validation and lifecycle regressions remain required.

Structural callbacks also preserve the newer render. A retiring row is detached from the internal row map before its listener and DOM node are removed, so an after-removal callback that undoes the deletion builds a fresh interactive row instead of reusing a listener-free one. After removal, insertion or focus, a newer selection/render or replaced owner stops the old continuation. An error thrown after such reentry cannot overwrite newer action status; an error from the still-current operation remains observable. Failed removals retain the retired row object in a separate cleanup set (at most 32 rows, in addition to the current page). The next refresh retries that old node; in-flight removal is not recursively repeated. The row's listener stays removed, and a newer same-ID row or selection is never rolled back. Destroy clears cleanup references and detaches the owned root. Tests model callbacks after the DOM operation, including undo, remount and selection, plus a current removal error before mutation and subsequent recovery. This is not a sandbox for arbitrary DOM implementations or global intrinsic replacement.

When a currently focused panel button is about to become disabled, focus moves to the stable Refresh drawings button first. This applies to completed selection-clearing actions and page navigation reaching an endpoint. A still-enabled no-op or rejected action keeps its focus. If a host callback has already focused another element, the panel does not take that focus back. A focus callback that creates a new selection, render or owner stops the older disabling/status continuation.

This addresses a BODY-focus result observed in Mac Chrome 155.0.8059.79 after Apply/Delete. The regression models native disabling blur; the separate Mac Chrome retest passed 16 scenarios / 60 checks, including actual event ordering and subsequent Tab navigation; see [validation scope](PUBLIC-VALIDATION.md#scoped-mac-browser-qa-2026-10-14). It does not establish screen-reader behavior or resolve the independently reported, unconfirmed WebGL remount stall.

## Visibility additions (2026-10-18)

See [Drawing visibility](DRAWING-VISIBILITY.md) for per-row and cross-page Show/Hide, locked recovery, v4 persistence, opaque snapshot-row identity and no-op rules. The earlier Mac focus evidence above does not cover these new controls; their current validation is Node/model-only.

## Chart-local copies (2026-10-18)

`Duplicate selected` uses explicit time-ms and raw-price inputs, default 0/0 overlap. Copies preserve visibility and become unlocked. Successful current actions clear prior checkbox selection without selecting copies or jumping pages. See [drawing duplication](DRAWING-DUPLICATION.md) for ID allocation, ordering, limits and the unrun actual-platform boundary.
