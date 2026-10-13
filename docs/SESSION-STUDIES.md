# Session analysis and causal queries (0.2.11)

The existing 35 builtins remain (including Aroon and VWMA). VWAP and pivots gain optional session configuration; their default UTC `sessionMs=86400000` behavior, outputs and accumulation order are preserved. The 14 drawing types remain. An anchored VWAP is a study parameter, not a new drawing type.

```js
import {portableSessionCalendar} from 'barochart/core';
const calendar=portableSessionCalendar({
  timezone:'America/New_York', weekdays:[1,2,3,4,5],
  windows:[{open:'09:30',close:'16:00',kind:'regular'}],
  exceptions:{'2026-11-27':[{open:'09:30',close:'13:00'}]}
});
chart.api.addIndicator('ny-vwap','vwap',{calendar,source:'close',deviation:2});
chart.api.addSeries({id:'vw',type:'line',panel:'price',indicator:'ny-vwap',output:'value'});
```

`calendar` is bounded JSON text, also accepted from ordinary `JSON.stringify`. It is normalized internally with strict keys and duplicate-key rejection. `weekdays` uses UTC Gregorian weekday numbers for the **local trading date**, Sunday=0. Host-provided date exceptions override weekly windows, including `[]` for closure. They are examples/configuration, not a verified exchange holiday feed. Limits: 16 windows/date, 512 exceptions and 64KiB UTF-8 text; parsed configuration cache 16 entries and per-study day cache 512 entries. Windows are `[open,close)`, ordered and nonoverlapping across adjacent dates. A close clock at/before open is overnight, attributed to its starting date. `ambiguity` is `earlier` by default, optionally `later`/`reject`; nonexistent local times reject. Platform timezone databases may differ.

`kinds:'regular,extended'` selects included session kinds; default `regular`. Multiple selected windows of a local date share one accumulator: lunch breaks produce NaN gaps without resetting. The next observed trading date resets. Outside-session bars do not alter study state.

VWAP supports `hlc3` (default), `close`, `hl2`, `ohlc4`. Explicit `anchorTime` is an integer UTC millisecond timestamp: accumulation begins at the first included bar at/after it and continues across dates; an optional calendar filters inclusion. An explicit `sessionMs` conflicts with calendar/anchor. Without `deviation`, the sole output remains `value`. With a nonnegative multiplier, outputs are `value,upper,lower,deviation,volume`:

* `value = Σ(price × volume) / Σ(volume)`.
* `deviation = sqrt(Σ(volume × (price−weighted mean)²) / Σ(volume))`, updated online; `upper/lower = value ± multiplier × deviation`.
* `volume` is cumulative included OHLCV volume since the current date/anchor. Before positive volume, prices/deviation are NaN and volume is 0. A later zero-volume bar leaves weighted statistics unchanged. Numeric overflow rejects visibly; no saturation or invented finite value is used.

These bands describe **input-price volume-weighted population variance** under Aster's contract. TradingView's public [VWAP description](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/) documents anchor and band choices but does not establish bitwise equivalence to this recurrence. Its [anchored VWAP tool](https://www.tradingview.com/support/solutions/43000669764-anchored-vwap-drawing-tool/) is a drawing workflow; Aster supplies an explicit study anchor.

Calendar pivots retain five outputs `pivot,r1,s1,r2,s2`, calculated from the previous **observed selected trading-date** H/L/last close. The first observed date outputs NaN. Missing history is not reconstructed or assumed to cover a complete official trading session. These are not all formulas or levels described by [Pivot Points Standard](https://www.tradingview.com/support/solutions/43000521824-pivot-points-standard/).

```js
chart.api.indicatorValueAt('cloud','chikou',10,{mode:'plot',asOfIndex:10});
// For displacement=26: {value:null,sourceIndex:null,sourceTime:null}.
```

`mode:'raw'` (default) interprets `index` as the source index. `plot` maps it through the output's built-in plot offset, independently of a series' explicit display offset. `asOfIndex` defaults to the last current bar and is bounded −1..last. A safe-integer index may be negative/forward; an unavailable mapping or a source after `asOfIndex` returns three nulls. Known warm-up gaps retain known source index/time with null value. Forward display positions can return an already-observed source. Existing crosshair readings retain hindsight display semantics. No MTF alignment/confirmation or forecasting is added. Builtins and linked causal modules are supported; naked/source-string factories reject this query. Trusted module authors remain responsible for causal calculations; this is not a sandbox for arbitrary application code.

[Volume profile documentation](https://www.tradingview.com/support/solutions/43000502040-volume-profile-indicators-basic-concepts/) explains lower-timeframe inputs and price bins. OHLCV session totals and the included close-direction volume proxy do not reconstruct bid/ask delta or an exact price-bin profile. VolumeProfile, MTF series, pairwise band fill, Pine execution and full-chart persistence remain outside this change.

Runnable web example: `/examples/web/analysis.html`. Independent two-pass/prefix/DST/checkpoint fixtures: `test/session-studies.test.mjs` and `test/indicator-asof-oracle.test.mjs`; actual Chrome/Worker workflow: `node test/analysis-browser.mjs`.
