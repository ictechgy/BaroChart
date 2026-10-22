# Opt-in pointer crosshair snapping

```js
chart.api.setCrosshairSnap({mode: 'close'});
chart.api.setCrosshairSnap({mode: 'ohlc', target: {panel: 'price', seriesId: 'candles-B'}});
const snapshot = chart.api.crosshairSnapshot(width, height);
chart.api.setCrosshairSnap({mode: 'free'});
```

`InteractionController.setCrosshairSnap` exposes the same configuration. Swift
and Java engines expose `setCrosshairSnap` and `crosshairSnapshot`; UIKit and
Android views expose the setter. JSON command dispatch uses those method names.
The demo has a separate Free / Close / OHLC selector and retains its choice on
model rebuild and renderer replacement.

## Selection and financial domain

Free is the default and preserves the existing raw-pointer behavior. Close snaps
to the close of the nearest visible stored bar. OHLC chooses the nearest visible
bar by X, then its nearest on-screen open/high/low/close by Y. Exact X ties choose
the earlier source index; exact Y ties use open, high, low, close order. Selection
is bounded to two adjacent bar centers and at most four values, not a historical
search. Future/past whitespace inside the plot chooses the nearest visible
stored endpoint. It never invents a timestamp or searches another bar if all
eligible prices of the chosen bar are offscreen.

A null/omitted target means the hovered panel's primary axis. An explicit target
has `{panel, axisId?, seriesId?}`; missing `axisId` can be inferred from an explicit
series. It only applies while the pointer is in that panel. A visible zero-offset
primary-store candle/OHLC series must belong to that exact panel and axis. An
explicit series must itself qualify. Indicator, volume, externally aligned
value/symbol and shifted series cannot borrow another series's OHLC domain.
Secondary axes require their own qualifying OHLC binding. Hiding an axis label
strip does not hide its series. Unsupported but valid domains simply stay free.

Distances use the actual linear/log/percent/inverted axis projection. Raw source
price is retained exactly; the matching-axis readout and label bypass inverse
projection round trips. Other axes interpret the resolved screen Y in their own
units. Nonpositive visible data on a logarithmic axis keeps its existing explicit
layout error. Empty data, no visible stored center, missing/hidden/rebound series,
or fully clipped candidate prices produce an unsnapped result.

## Snapshot and existing contracts

`crosshairSnapshot(width, height)` returns null when there is no cursor or it is
outside every plot. Otherwise it returns detached data:

- `mode`, `raw: {x,y}`, `resolved: {x,y}`, active `panel`
- `snapped` and `reason`: `free`, `no-eligible`, or `snapped`
- `index`, exact source `time`, `field`, raw Float64 `price`, `axisId`, `seriesId`,
  `storeVersion` when snapped; all seven are null otherwise

Thus free fallback never mislabels an interpolated pointer value as source OHLC.
An inside-plot empty-data cursor yields `no-eligible` in enabled modes. Rendering,
legacy `crosshairValues` and this snapshot share one resolver. The legacy readout
keeps its exact keys (`index`, `time`, `primary`, `series`, `axes`); free mode keeps
its existing Math.round/time/readout behavior. Raw `model.crosshair` remains only
`{x,y}`. Direct host cursor assignment remains free. Local pointer intent is
weakly associated with its raw object and is not serialized into cursor JSON.

Resolution uses current source rows and current prepared geometry on every draw
or query. Corrections/reset/prepend, target changes and view changes do not retain
a stale captured price or index. Previous returned snapshots remain unchanged.

## Ownership, drawing tools and synchronization

Configuration is per controller, copied/frozen, and independent of drawing magnet.
Invalid settings reject before changing cursor, gesture, drawing transaction or
notifications. A mode/target change updates the current pointer only if this
controller still owns it. A shared model's last actual pointer event owns the
crosshair; another controller's setting or teardown cannot replace that intent.
Owner teardown releases its own snap intent but preserves the existing raw cursor
object. Settings never cancel a drawing gesture or magnetize drawing anchors.

TimeCursorGroup still transfers only UTC time, never raw price/field or a target
axis. Pointer publication consumes the same snapped index using the existing
validated last-rendered layout; it does not create a new layout. The receiver's
vertical time overlay never becomes a local pointer or a price snap. Changing a
snap setting or redrawing while stationary does not publish a new time: remote
charts retain the last actual pointer/keyboard publication until another event.
Dirty/stale layouts keep the existing publication guard.

Canvas keyboard exploration retains its own exact stored-time selection and
suppresses pointer updates while active. Navigation still does no value query;
Enter is the explicit read. Native exploration commands remain separate semantic
selection and do not change a pointer snapshot; native hosts retain their existing
input-arbitration responsibility. No workspace/drawing persistence is added;
a new controller starts Free. The demo reapplies its selected mode explicitly.

## Cost and validation boundary

The resolver given a prepared layout, pointer event capture, target eligibility,
and time publication perform no indicator queries. A warm cached hover rebuilds
only the overlay. `crosshairSnapshot(width,height)` explicitly creates a fresh
layout, like existing `crosshairValues`, and may synchronously calculate visible
dirty studies. Ordinary dirty/full redraws retain that cost too; this is not a
zero-cost readout or FPS claim.

`node --test test/crosshair-snap*.test.mjs` covers literal geometry, exact source
identity, snapshots, mutation controls, real native bridge in Node VM, modeled
Canvas cache/time/explorer routing, and source-only facade/demo wiring. Actual
browser trusted input/pixels, accessibility behavior, Mac/iOS/Android SDKs and
physical-device performance remain unrun.

## Research references

The [official Lightweight Charts CrosshairMode API](https://tradingview.github.io/lightweight-charts/docs/api/enumerations/CrosshairMode)
distinguishes free, close-based and OHLC-based crosshair modes. The earlier
[OHLC snapping feature request #1726](https://github.com/tradingview/lightweight-charts/issues/1726)
explains the use case. These informed the mode distinction; BaroChart's narrower
raw-OHLC eligibility, bounded selection, ownership and snapshot contracts above
are explicit local design choices, not a claim of TradingView API equivalence.
