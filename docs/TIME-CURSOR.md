# Linked time cursors (web preview)

`TimeCursorGroup` links the stored bar-open time selected by a pointer or keyboard across up to eight `CanvasChart` instances (including `GPUChart`). Mapping and publication do not calculate studies or call `dataAt`. **The resulting ordinary redraw can calculate cold/dirty studies; disabling layer caching rebuilds scenes. This is not a low-latency guarantee for large dirty charts.** Actual browser focus, GPU pixels and assistive-technology behavior have not been verified for this preview.

```js
import {CanvasChart, TimeCursorGroup} from 'barochart/canvas';
// Create leftChart/rightChart as usual, with their own model/store/view.
const cursors = new TimeCursorGroup({match: 'at-or-before'});
const leaveLeft = cursors.add(leftChart);
const leaveRight = cursors.add(rightChart);
// Inspect without computing values:
console.log(rightChart.timeCursor);
// Later:
leaveLeft(); leaveRight(); cursors.dispose();
```

Choose the policy explicitly:

- `exact`: only an equal stored timestamp matches.
- `at-or-before`: choose the last stored timestamp less than or equal to the requested timestamp. Before the first bar is unmatched. Across a market gap the matched bar can be much older; inspect both `requestedTime` and `matchedTime`.

Times are exact UTC integer milliseconds at **bar open**. Different chart intervals are mapped by their open timestamps, not by interval overlap. A match is not evidence that a higher-timeframe bar was confirmed, historically available, or free of look-ahead/revision effects. No price, y coordinate, viewport, drawing or underlying keyboard selection is copied. Price crosshairs remain local. The dotted vertical overlay is transient and is not part of saved studies/workspaces.

## Ownership and interaction

Each chart and each model may belong to only one group. Repeated or cross-group joins, two charts sharing a model, and a ninth member are rejected. Separate models may share a store. `add` returns an idempotent detach function. Dispose the group when the containing workspace is removed; destroying a chart also detaches it. Renderer fallback keeps chart membership but discards the old pointer projection; detached canvas events cannot publish.

Pointer publication requires an already rendered layout matching the current source version, view and canvas dimensions, and a pointer inside a plot panel. A cold/stale layout suppresses publication until a normal render; synchronization never calls `createLayout` merely to map a pointer. Keyboard exploration publishes the already selected timestamp; Enter retains its existing explicit potentially expensive value-read behavior.

The latest valid source wins. A pointer-leave only clears its own still-current pointer selection; it cannot erase a later keyboard selection or another chart's cursor. Exiting keyboard exploration similarly clears only that source's current keyboard selection. Receiving/remapping does not broadcast. Reentrant newer selections supersede an old broadcast before it reaches another target. Synchronous nested publications/clears have a per-group depth limit of 16; this is not preemption of arbitrary host callbacks.

Store and view changes re-map the original requested timestamp. A missing/empty target or offscreen match draws no overlay and never pans automatically. Source removal clears its current group cursor. Detach/dispose removes only group-owned overlay state, without restoring stale local crosshair or keyboard state.

## Read-only state

`chart.timeCursor` is `null` or a detached snapshot containing `requestedTime`, `matchedTime`, `index`, `status`, `kind` and `generation`. Status is `matched`, `unmatched`, `empty`, or `offscreen`. Visibility is finalized when drawing the overlay; before the next frame a match may still be offscreen. No formatter callback or indicator query is invoked by reading this snapshot. Direct mutation of internal chart/model/store objects, prototypes or source columns is outside this API contract; use existing validated data/display methods.

No additional store subscriptions or unbounded event queue are installed. Each group retains at most eight memberships and one current request. Normal chart rendering and host-held references remain subject to their existing memory/lifecycle contracts.

## Validation scope

Node tests cover literal timestamp oracles, empty/gapped/differently sampled stores, source changes, group bounds, stale projection, reentrant selection and teardown, and rendered scene-command coordinates in a fake DOM. They distinguish zero study work during publication from ordinary study work in a later dirty frame, including `layerCaching:false`. These tests do not establish browser input-to-paint latency, focus correctness, screen-reader behavior, or mobile SDK support.

Run `npm run demo` and open `/examples/web/linked-cursors.html` for the two-chart synthetic sample. The policy selector and disconnect button demonstrate explicit group ownership. This sample is provided for host/browser evaluation; its actual browser appearance and focus behavior remain unverified here.

### Small Node cost probe

`node benchmarks/time-cursor.mjs 100000 8` measures only warmed DOM-free mapping and callback publication. On Node 24.19.0, one serial 1,000-event sample per condition produced:

| Source rows / charts | Sum of measured calls | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 / 2 | 209.533 ms | 0.002708 ms | 0.043376 ms | 0.795003 ms | 141.608 ms |
| 100,000 / 8 | 162.565 ms | 0.004648 ms | 0.119717 ms | 0.847997 ms | 128.483 ms |

The large isolated delays have no established cause; the smaller workload was not consistently faster in this tiny sample. These figures do not establish scaling, a latency bound, or comparative superiority. All event/target timestamps matched the independent integer-interval oracle, no indicator query was invoked, and group membership/store listener counts returned to zero. This last check is explicit ownership/subscription cleanup, not measured garbage collection or RSS release. Real CanvasChart invalidation, frame rendering, browser input-to-paint and screen-reader behavior are excluded.

For this implementation snapshot, the complete Node suite passed 2,657/2,657 tests (zero failures/skips), 366 ESM modules parsed, strict TypeScript 5.9.3 checks passed, and an offline installed npm-consumer check passed. A missing temporary compiler cache initially blocked the last two checks; the pinned compiler was recovered from the official npm registry and matched to the existing lockfile integrity before successful reruns. The generated native core bundle is unchanged by this web-only feature.
