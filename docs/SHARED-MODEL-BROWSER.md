# Shared-model browser fixture

This bounded correctness fixture creates two Canvas charts over one model and
a third chart over a separate model. A fourth chart replaces the first after
detachment. All input data is synthetic and fixed at 64 initial bars plus one
append. No production module is replaced in the browser path.

## Run explicitly on an authorized browser-capable machine

```sh
npm run test:shared-model:browser
# Optional report destination:
node test/shared-model-browser.mjs --output artifacts/shared-model-browser.json
```

The command uses the existing installed-Chromium launcher, an owned temporary
profile and the existing loopback-only fixture server. It does not download a
browser, connect to an existing user tab, change sandbox flags or browser
security preferences, or publish anything. Importing the runner launches
nothing. Startup, navigation and result waits have bounded deadlines. Failure
to close the browser does not skip server cleanup, and unconfirmed cleanup
cannot produce a passing verdict.

## Assertions

- Separate chart canvases, caches, subscriptions and ResizeObservers coexist
  while the first two charts share exactly the same model.
- Current-bar updates, append and historical correction reach both shared
  charts. The independent model keeps its original OHLCV. Full source rows and
  last completed scene commands are checked after each update, including the
  frame's source-version/range binding to catch a stale sibling frame.
- Bidirectional `TimeRangeGroup` view synchronization uses one representative
  per model. Shared-model charts already share their viewport; this fixture
  explicitly invalidates the sibling after API view changes. It does not claim
  automatic shared-view redraw or expand the group's membership policy.
- Destroying the representative with a frame pending cancels its frame,
  detaches it from the group and releases its raster reservation, listeners,
  observer and canvas, while the sibling keeps its model and pending work.
- A replacement chart reuses that model, rejoins the group, synchronizes the
  range and renders a later correction. The retired chart stays released.
- Destroying the other shared chart preserves an active drawing owned by the
  replacement; that drawing commits exactly one undo entry.
- Chart destruction returns store subscriptions to their pre-chart baseline.
  Only explicit model disposal removes the remaining model/indicator
  subscriptions. Four retained chart references are inspected for resource
  release, and repeated destruction/disposal is exercised.

The fixture wraps RAF and ResizeObserver calls to track its own outstanding
resources and restores all original global descriptors even after assertion
failure. Its dedicated layer-cache budget is separate from application caches.
Settling requires two consecutive idle RAF fences, capped at 20 fences, so
initial ResizeObserver deliveries cannot outrun a fixed two-frame wait. A
browser-order modeled regression covers initial observer delivery and
per-callback microtasks; a perpetual-redraw control checks bounded failure.
The report validator requires every assertion in order, explicit zero cleanup
counters, both disposed models and all four retired-chart records. The runner
also rejects page exceptions, target crashes, console errors, external network
requests and missing cleanup evidence.

## Non-browser contract tests

```sh
node --test --test-concurrency=1 test/shared-model-browser.test.mjs
```

These tests run the same serialized fixture with the real core, chart,
controller, scene-cache and group code under a modeled DOM, Canvas and RAF.
Canvas calls are no-ops; this is not pixel or browser execution. Fake runner
transports are used only to check failure handling and cleanup sequencing.
Synthetic browser-shaped report copies are never measurement artifacts.

Intentional instance-local faults demonstrate detection of a stale sibling
frame, altered correction data, missing range publication, premature model
disposal, retained raster pixels, cancellation of another chart's drawing and
a replacement that never renders. Report mutation tests reject missing phases,
false assertions, nonzero or absent cleanup evidence and wrong execution
scope. A modeled report cannot qualify as actual-browser evidence.

## Validation boundary, 2026-10-18

Actual browser execution of this new fixture remains **unrun** and unverified.
Node contract tests do not establish browser behavior.

Even a future browser pass will cover programmatic Canvas/API/range/lifecycle
behavior only. This fixture performs no trusted mouse/touch/keyboard input,
screenshot/pixel comparison, WebGL/native/assistive-technology validation,
heap/VRAM leak measurement, sustained streaming qualification or FPS benchmark.
Resource counters and retained-object inspection are not proof of garbage
collection or a universal leak guarantee.
