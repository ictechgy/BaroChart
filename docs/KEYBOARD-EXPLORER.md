# Keyboard data exploration: first web prototype

This opt-in CanvasChart/GPUChart connection uses the existing dataAt API. It is
not a new chart renderer, native keyboard integration, or verified screen-reader
experience. Node fake-DOM tests can verify dispatch and lifetime contracts;
actual browser focus, visual layout and assistive-technology behavior still need
browser/device QA.

## Minimal integration

Provide two distinct, exclusively assigned host elements and optionally up to
four connected controls. The host owns their DOM placement and attributes:

```html
<button id="explore">Toggle data exploration</button>
<button id="read">Read selected values</button>
<div id="readout" aria-live="off"></div>
<div id="live" role="status" aria-live="polite" aria-atomic="true"></div>
```

```js
const chart = createChart(container, model, {
  dataExplorer: {readout, live, controls: [exploreButton, readButton]}
});
exploreButton.onclick = () => {
  chart.setDataExploration(!chart.dataExploration.active);
  chart.canvas.focus({preventScroll: true});
};
readButton.onclick = () => chart.readExploration(); // catch errors in real UI
```

Mode is OFF by default. Entering cancels any active drawing/pan gesture using
its existing rollback behavior. The initial selection is the last visible
stored bar, clamped to the actual data, and the first visible series. There is
no automatic pan or selection overlay in this slice; selection is stated in the
text readout, including for offscreen rows.

In mode, while the canvas has focus:
- Left/Right select the previous/next stored bar; Home/End select first/last.
- Up/Down select a visible series in configured order, across panels/axes.
- Enter explicitly reads current values; Escape turns mode off.
- Other keys do not fall through into drawing edit/delete/undo commands.
- Tab and modified/composing/already-handled/editor-target events are not consumed.

Outside mode the existing pan/zoom/drawing shortcuts are unchanged. Pointerdown
or wheel ends exploration before ordinary pointer interaction; hover does not
move the keyboard selection. Focus may move between the canvas and registered
controls, allowing mouse or Tab access to Read. On a received focusout event, leaving that area (including a null
relatedTarget or a disconnected destination control) ends exploration. Direct
DOM removal without a focusout event is not observed; hosts removing a focused
control should explicitly turn exploration off. Renderer fallback also
ends it; replacement canvas focus is not promised.

## Selection is cheap; reading may block

Navigation never calls dataAt. It tracks the stored timestamp and selected
series ID, with bounded metadata work and binary-search timestamp resolution.
Append/prepend/correction preserve the same stored time; reset preserves it only
if that exact time still exists. Missing/empty data is explicit, never silently
replaced by a neighboring bar; Home/End recover selection. Hidden/removed series
selection moves to the first remaining visible series.

Source/display invalidation marks the visible readout changed without lazy
indicator calculation or live-region announcements. A previously read value is
not presented as refreshed. Enter/Read is synchronous: dataAt can calculate an
entire cold/dirty suffix and can block for over a second on large workloads.
There is no fake async wrapper, automatic retry, or every-key/every-tick query.
Prefer prepared/warmed models and keep expensive explicit reads out of
latency-critical interactions until a real async query path is provided.

The query uses dataAt's latest stored-index cutoff. Negative plot offsets can
refer to a later source row. Text distinguishes selected stored time, series
source index/time, offset, status, panel and axis. It does not certify no-lookahead
or historical arrival-time correctness, change timestamp conventions, round
prices, or silently replace missing values. See DATA-EXPLORER.md.

## Output and lifetime

The adapter writes bounded textContent (at most 4096 UTF-16 code units), never
HTML, and announces only explicit user operations. A role=status element has
implicit polite/atomic semantics in [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/#status);
this does not prove actual speech output on any browser/AT combination. Hosts
may visually hide the live region without hiding it from accessibility APIs.

An owned scalar state is available as chart.dataExploration. aster:exploration
notifies connected hosts of published state. Failed/stale reads do not publish
old values as new. Destruction, mode exit and fallback during trusted calculation
invalidate the pending publication. Source/model consistency remains enforced by
dataAt. Arbitrary internal object mutations and uncooperative trusted callbacks
are outside the managed consistency contract.

Destroy and constructor failure detach control listeners and clear helper
references. Output nodes use ownership tokens: a newer chart may take them over,
and old teardown cannot erase the newer chart's output. Host nodes themselves
are not removed. The example uses a small adjacent readout rather than changing
canvas layout or introducing a large UI redesign.

## Frozen validation — 2026-10-13 UTC

- Full isolated serial suite: 2442/2442 passed, no failures/skips, 118.896 seconds.
- The total includes 28 DOM-free selector tests and 50 fake-DOM integration tests.
  Navigation/live invalidation invokes dataAt zero times; Enter/Read dispatch,
  exact timestamps/offsets, empty/missing/hidden series, focus-area routing,
  original errors/retry, fallback and callback-driven teardown are exercised.
- 405 ESM syntax, strict TypeScript5.9.3 (including new positive/negative API
  types), offline package and evidence validation passed. Final changed catch
  and regression file were explicitly syntax-checked again after the initial
  syntax traversal. Production canvas/helper hashes are recorded with raw logs.
- Fixed production Canvas SHA:
  6e05bcf68c156fe98b92b20ab3d62d1411caf89adaa54f2a7c6292b359ecdb6e.
  Selector SHA:
  0c0884f13329a2ab985d8343f86f8d5ddf942a9de5eeebf9c1ff19e123f1a563.
- Earlier prototype failures and their corrected regression runs are preserved.
  No browser/AT screenshot, speech output, native SDK run or UI latency claim is
  inferred from these tests. The native bundle did not change in this web unit.
