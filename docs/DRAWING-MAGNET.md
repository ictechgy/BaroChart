# Drawing magnet

`chart.api.setDrawingMagnet({mode: 'weak', radiusPx: 8})` enables a
per-controller pointer aid. The same method is available on
`InteractionController`, `ChartAPI.dispatch('setDrawingMagnet', [options])`,
Swift `AsterEngine.setDrawingMagnet([String: Any])`, Java
`AsterEngine.setDrawingMagnet(JSONObject)`, and the UIKit/Android view facades.
The web demo has an Off / Weak / Strong selector and retains its selected mode
when rebuilding the model or switching renderers.

## Modes and candidate selection

- **Off (default):** existing free-coordinate behavior.
- **Weak:** snap only if the Euclidean screen distance from pointer to candidate
  is at most `radiusPx`, default 8 logical pixels; finite values from 1 through
  32 inclusive are accepted. Radius is not a device-pixel or price-unit value.
- **Strong:** ignore radius, while retaining the eligibility and visibility
  requirements below. This does not search the entire dataset for a globally
  nearest 2D point.

The pointer must be inside the target plot. First select the nearest *visible
stored bar center* by X; an exact tie picks the earlier source index. Inspect
only that bar's open, high, low and close, projected through the target axis.
Choose the closest finite on-screen Y; exact ties use open, high, low, close
order. The candidate must also have an on-screen bar center. With no eligible
candidate the anchor retains its free position; another bar is not substituted.
For future/past whitespace inside the plot, Strong uses the nearest visible
stored endpoint, however far away. Weak still enforces its full 2D radius.

Persist the exact source timestamp and raw Float64 OHLC value, never a rounded,
interpolated, logarithmic or percentage display value. Log, percent, inverted,
and independent axes use their own screen projections. Existing rejection of
nonpositive visible data on logarithmic axes remains in force. Empty data,
a viewport containing no stored centers, or clipped-away OHLC values do not
produce a snap.

## Financial domain and interaction scope

A visible zero-offset primary-store `candles` or `ohlc` series must be bound to
this exact panel and axis. An unbound drawing may use such a series. If the
drawing has an explicit `seriesId`, that exact series must qualify: an indicator,
volume, external-value/symbol or offset series never borrows another series's
OHLC prices. Independent axes qualify only with their own raw OHLC binding.
The existing series API rejects nonzero offsets for candles/OHLC. Hiding an axis
label strip alone does not hide the series or disable its price domain.

Snapping applies to explicitly placed creation anchors and individually dragged
handles. Whole-body translations, keyboard nudges and freehand drawing/handle
editing stay unsnapped. An automatically generated third anchor remains 40
logical pixels below the second anchor, including when the second snapped; it
is not independently magnetized. Later explicit third-handle editing can snap.
No crosshair snapping, cursor indicator or modifier-key override is introduced.

## State and history

`controller.drawingMagnet` exposes a frozen `{mode, radiusPx}` value. The setter
copies options; unknown modes/fields and invalid radii reject before changing
state. Omitting radius resets it to 8. Reapplying identical values preserves an
active interaction. A changed configuration cancels this controller's owned
interaction; it cannot cancel a different controller's drawing transaction on
a shared model. Controllers sharing a model may use different modes.

A completed creation or handle edit remains one normal undo unit. Cancel/Escape
restores the original state. Magnet configuration is local interaction state,
not saved in drawing documents/workspaces; a new controller starts Off.
Programmatic drawing creation/edit/translation is unaffected.

## Validation boundary

`node --test test/drawing-magnet*.test.mjs` covers the real DOM-free controller,
literal screen geometry, native bridge execution in Node VM, generated resource
parity, facade/demo source wiring and deliberate mutation controls. Native facade
checks do not execute Swift/Java SDKs. Actual browser pointer input, visual UX,
Mac/iOS/Android runtime behavior and FPS measurements remain unrun.
