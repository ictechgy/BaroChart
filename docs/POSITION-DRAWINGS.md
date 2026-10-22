# Long/short risk-reward drawings

`longposition` and `shortposition` are chart annotations. They show entry, stop,
target, a horizontal time extent, two shaded zones, raw-price distances,
percentages and reward/risk. They do not place orders, detect fills, calculate
PnL, fees, leverage, position size, account balance or alerts.

```js
const id = chart.api.addDrawing({
  type: 'longposition', panel: 'price',
  points: [
    {time: startTime, price: 100}, // 0: entry/start
    {time: startTime, price: 95},  // 1: stop
    {time: startTime, price: 110}, // 2: target
    {time: endTime, price: 100},   // 3: extent/entry
  ],
});
const metrics = chart.api.positionMetrics(id);
// {direction:'long',startTime,endTime,entry:100,stop:95,target:110,
//  risk:5,reward:10,riskPercent:5,rewardPercent:10,ratio:2}
```

## Anchor and numeric contract

There are exactly four points, in the fixed order above. Points 0, 1 and 2 have
identical start times. Point 3 duplicates the entry price, with `endTime >
startTime`. All coordinates must be finite; times must fit the existing Date
range. No zero-width or backward extent is accepted.

Long requires `stop < entry < target`; short requires `target < entry < stop`.
Risk and reward are the positive raw-price distances from entry. `ratio` is
reward divided by risk. All three must be finite and strictly positive. No
arbitrary epsilon or market tick-size rounding is applied. A Float64 operation
that collapses distinct levels, overflows a distance or over/underflows the ratio
is rejected, including during group translation.

Percentages are `distance / abs(entry) * 100`, explicitly labeled “of |entry|”.
Zero entry and an unrepresentable percentage return `null` and display `n/a`.
Negative prices are accepted on suitable axes. Prices and metrics retain the
stored Float64 values, not decimal-exact financial arithmetic. Level labels use
round-trip number strings; distances, percentages and ratios use six significant
digits with scientific notation when needed, so a tiny accepted risk is not
formatted as zero.

`positionMetrics(id)` is a detached read-only scalar result. A missing ID or a
non-position drawing throws. It does not build layout, access source bars,
calculate indicators, invalidate, or notify native change observers. Dispatch
accepts one argument. Swift `positionMetrics(_:)` and Java `positionMetrics(id)`
forward to the same command and validate an object result.

## Pointer interaction

Select either tool in the web demo or call `setTool('longposition')` /
`setTool('shortposition')`. Pointer-down establishes entry/start. The default
stop and target use the target axis's prices 40 logical pixels above and below
the projected entry, ordered by raw price rather than screen orientation. The
initial end is 80 logical pixels to the right. A click can commit this valid
default. If these offsets cannot produce representable valid anchors, down is a
no-op with no drawing transaction/history entry.

Dragging during creation changes the target price and end time, keeping the
initial stop. Drag to the favorable raw-price side and right of the start. The
four selected handles have stable meanings:

- Entry/start: changes entry price and start time, propagates the shared start
  times and extent's entry copy; stop and target raw prices stay fixed.
- Stop: changes stop price only.
- Target: changes target price only.
- Extent/entry: changes end time only.

Invalid moves preserve the last valid preview and still repaint the crosshair.
Releasing commits the valid preview as one undo unit. Escape/cancel restores the
prior document. Locked drawings cannot be edited or deleted. Shared-controller
transaction ownership follows existing drawing rules.

Drawing magnet is independent and remains off by default. Entry and creation
use the full snapped OHLC anchor; stop/target handles consume its raw price only;
the extent handle consumes its time only. Thus a snapped candle time never
accidentally changes a stop/target's shared start. Existing axis/series eligibility,
weak/strong distances and tie rules apply. Invalid snapped candidates are rejected
rather than silently crossing entry.

Body dragging and keyboard nudging remain unsnapped screen-space translations.
On log axes a vertical translation scales all raw prices and distances; on linear
axes it adds a raw offset. The ideal uniform transforms preserve reward/risk,
subject to Float64 rounding. `translateDrawings` instead explicitly adds raw
`deltaTimeMs` and `deltaPrice`. All moves revalidate the complete candidate and
reject collapsed/overflowed coordinates atomically. Group style/deletion, locks,
selection, undo/redo and resource budgets use the existing drawing APIs.

## Geometry and axis binding

Both zones, three level boundaries and labels use the drawing's actual panel and
axis, including logarithmic, inverted, percentage and independent axes. Metrics
always use raw prices, never log or percentage display units. Existing explicit
`axisId` / `seriesId` binding behavior applies. Hidden/missing bindings or any
unprojectable level hide the entire drawing, including its selected handles and
hit target. Metrics and drawing geometry use stored annotation coordinates, not OHLC
lookups. Empty charts retain the existing “No data” scene behavior.

Risk shading is red (`#ef535044`); reward shading is green (`#26a69a44`) unless
`style.fill` overrides it. `style.color`, `width` and `font` affect outlines/labels.
“Long”/“Short”, “Stop”, “Target”, entry and metrics provide text distinctions in
addition to color. Geometry is clipped to the plot. The shaded interiors and
boundaries are body hit targets; selected handles retain priority. Labels may be
clipped in a narrow/offscreen extent and are not separate interaction targets.

## Serialization and compatibility

Documents containing either new type require `aster.drawings` version **3**.
Version 1/2 imports containing these types reject before publication. Old-only
saves still produce version 1 (unbound) or 2 (bound); readers accept all three.
Version 3 also supports all existing bound/unbound types.

The workspace envelope remains version 1 with embedded drawing version 3.
Workspace readers, worker restoration, monolithic/segmented async UI/history
transfer and native workspace target normalization preserve the new semantics.
Older readers reject version 3; there is no silent downgrade or forward-compatibility
claim. Export only legacy drawings if an older consumer is required.

## Validation boundary and reference

Tests cover analytical axis geometry and literal raw metrics, adjacent/subnormal
Float64 values, strict schema rejection, valid/invalid gestures and repaint,
magnet semantics, history/group/ownership composition, workspace and async
restoration, generated native-core execution in Node VM, and intentional faults.
Swift/Java facade checks are source-only. Actual browser input/Canvas raster,
Mac, iOS/Android SDK/device execution and physical frame-rate tests were not run.

Behavior reference: TradingView's [long and short position drawing tool guide](https://www.tradingview.com/support/solutions/43000475660-how-to-use-long-and-short-position-drawing-tools/).
This implementation uses its general entry/stop/target and distance/ratio concepts;
it does not copy code/assets or implement the guide's account/order simulations.

An explicit `visible` boolean raises the enclosing drawing document to v4; position-only drawings without this field still use v3. Hidden positions retain metrics and semantic anchors. See [drawing visibility](DRAWING-VISIBILITY.md).
