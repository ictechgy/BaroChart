# Linked stored-time view ranges

`TimeRangeGroup` is an opt-in web controller for up to eight CanvasChart/GPUChart instances. It copies an absolute UTC **bar-open center range**, not source indices, pixels, prices, drawings or data. Mapping/publication performs no study calculation; the ordinary redraw can still calculate cold/dirty studies. This feature has Node/controller tests, not a new browser, GPU pixel, screen-reader or native SDK verification run.

```js
import {TimeRangeGroup} from 'barochart';
const group = new TimeRangeGroup({mode:'view', missing:'clip'});
const leaveA = group.add(chartA, {publish:true, receive:true});
const leaveB = group.add(chartB, {publish:true, receive:true});
group.syncFrom(chartA); // Explicit initial alignment; joining alone does not move a view.
console.log(group.status(chartB));
// Cleanup: leaveA(); leaveB(); or group.dispose(). Chart destroy detaches automatically.
```

Run `npm run demo` and open the [two-interval example](../examples/web/linked-ranges.html). Pan/zoom either chart, use an explicit sync button, or disconnect.

Both policy keys and both role booleans are required. Both roles false is rejected. One group per chart/model is allowed independently of TimeCursorGroup. A publisher's own view/follow is never changed by its publication. Receive-only charts cannot publish automatically or through syncFrom. Publication-only charts are never mutated as receivers. Detaching does not restore old view coordinates or follow state.

## Precise range semantics

For a source view `[fromIndex,toIndex]`, take stored centers from `max(0,ceil(fromIndex))` through `min(length-1,floor(toIndex))`, inclusive. The first and last stored bar-open timestamps become the requested closed time range. Partial edge bars whose centers are outside the view are not included. No fractional-index/time interpolation across market gaps is performed. Empty/no-real-center source views do not publish. Future plot-offset space and unloaded padding do not invent timestamps; the receipt reports `trimmed` when the source view extends outside the stored half-bar extent.

A receiver uses lower_bound(start) through upper_bound(end)-1. Only stored opens inside the closed range match. Internal gaps are not missing loaded extent; zero matches leave the view unchanged even with `missing:'clip'`. A single center (`start===end`) is valid. Its requested index range is center±0.5, then the existing model minimum-ten-bar span and bounds apply. These constraints can expand/shift the view beyond the requested times; this is not exact continuous time-axis alignment.

- `missing:'clip'`: intersect with loaded stored opens. No automatic fetch or nearest-bar jump.
- `missing:'reject'`: a receiver whose first/last loaded open does not cover both endpoints reports `insufficient` without changing its view. Other eligible receivers can apply. This does not require every internal timestamp to exist.
- Invalid structure, owner, options or unwritable target fields reject the entire operation before any view publication. Data insufficiency is a per-receiver result, not this structural error.

The receiver status separates requestedTimeRange, inclusive matchedSourceIndices, effectiveIndices after constraints, effectiveStoredTimes (centers actually visible), padding in index/bar units, expanded, clipped, applied, status and stale. `applied` describes the last operation, not a guarantee that the view is still current. Applied receivers get `follow=false` so a pinned historical request does not implicitly chase live data. The source follow setting is preserved. Prices/axes and source data remain unchanged.

## Events and data changes

`manual` publishes only through syncFrom. `view` observes actual view-coordinate changes during the existing CanvasChart invalidate path, including gestures and programmatic ChartAPI pan/zoom/setVisibleRange. Direct model edits become observable on the next invalidate; they are not magically watched. Hover/resize with identical coordinates does not publish. Receiver baselines are updated before their redraw invalidation, preventing rebroadcast loops.

Source/store identity, version, columns or length changes are checked before view changes. Their automatic follow/prepend/clamp view movement refreshes the baseline and marks prior results stale without publishing. The next independent view change or explicit syncFrom interprets the new data. Receiver data changes similarly mark its result stale and do not broadcast its automatic movement. No data retry, automatic loading or unbounded auto-pan is performed. Metadata is based on current corrected data, not point-in-time historical availability or higher-timeframe confirmation.

All eligible view/follow/status/baseline updates occur before any notification. Observer reentry can start a newer generation, change ownership, remove/destroy members or change source data; old notifications stop or skip stale recipients and never roll back already-published views. Notification failures are isolated in a bounded 16-record diagnostic list (generation and error category; no retained Error objects). Automatic synchronization failures also go there; explicit pre-publication errors throw. Reentry depth is limited to16.

Owned data properties and ordinary non-shared Float64 columns are required. BarStore's supported sorted timestamp contract applies; direct column mutation, Proxy traps and replaced global intrinsics are not a sandboxed extension contract. Lookups use binary searches, bounded membership and existing series metadata. No cached arbitrary history or copied OHLCV is retained.
