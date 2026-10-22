# Explicit-baseline relative comparison example

`examples/web/comparison.html` compares two synthetic host-supplied series on one shared linear percent-change axis. Start the existing demo server and open that page. Choose an exact UTC baseline and press **Apply baseline**. Each series uses its own raw observation at the same timestamp. Pan/zoom changes the viewport without changing the baseline. The table shows raw values, normalized values and gaps; the applied-baseline summary names both raw bases.

This is a tested example-local recipe, not a new core API, indicator, data feed or chart plugin. Existing `alignSeriesByTime`, general `series.values`, `setSeriesValues` and a linear panel are sufficient. The existing financial-coordinate example still uses one common raw-price base of 100 and retains its different meaning. Independent percent axes may each use a different base, but their separate automatic ranges do not constitute a shared relative-change domain.

## Pure helper and ownership

```js
import {normalizeComparisonSeries} from '../examples/web/comparison-values.mjs';
const result = normalizeComparisonSeries(
  [0, 60000, 120000],
  [{time:0,value:200}, {time:60000,value:220}, {time:120000,value:null}],
  {baselineTime:0},
);
// result.values: Float64Array [0, 10, NaN]
// result.rawValues: Float64Array [200, 220, NaN]
// result.baseline: {time:0, value:200}
model.addSeries({id:'comparison',type:'line',panel:'price',values:result.values});
// Use a shared LINEAR panel for already-normalized values, not another percent transform.
```

This import is a repository example path and is not an npm/package export. There is no new native facade, serialization format or workspace field.

Inputs follow the existing exact-alignment contract, with a smaller example cap of 65,536 reference timestamps and 65,536 source points per call. Reference input is an ordinary array or Float64Array; points are an array of `{time,value}` records. Times must be strictly increasing exact integer UTC milliseconds in the Date range, with no duplicates. Values are finite numbers or `null`/`NaN` gaps. Invalid off-reference points are still rejected by alignment. Strings and other coercible reference values are rejected before typed capture. As with the existing alignment helper, hostile proxies are not a security/isolation boundary.

The only option is an own enumerable data property `baselineTime`; extra keys, accessors and noninteger timestamps reject. That timestamp must occur exactly in **both** the reference timeline and the source, with a finite nonzero value. Missing/gapped/zero baselines reject instead of choosing a nearest or first available observation. Baseline lookup uses the same captured aligned vector that supplies every normalized value; input getters are not reread to find another base. The bounded source-point reference list also prevents input-array growth during capture from expanding the alignment loop.

The result record and its `{time,value}` baseline record are frozen. `alignment` is `exact-utc`; `transformation` is `signed-percent-change`. `rawValues` and `values` are separate owned, writable Float64Arrays, detached from source and from subsequent results. Raw readout uses the same capture as normalization. Metadata describes this calculation, not the source's exchange, adjustment history, currency or causality. Chart data exploration continues to describe these ordinary external values as host-aligned.

No original input is mutated, no model is read or changed by the helper, and no indicator is computed. Work is O(reference length + point count). Typed allocations across capture/alignment/transformation total at most 32N + 16M bytes; source-point references, objects, chart buffers and allocator/GC overhead are additional. Returned vectors occupy 16N bytes. This is a bounded synchronous example, not a latency or FPS guarantee.

## Numeric and data interpretation

For raw value `v` and signed nonzero base `b`, the mathematical transform is `(v − b) / b × 100`. Near the baseline it subtracts first to retain stored Float64 differences that separate division can lose. If subtraction overflows for opposite extreme signs, it uses `(v / b − 1) × 100`. A nonfinite final result rejects the whole helper call; NaN gaps alone are retained. A value exactly equal to its base emits positive zero. Signed negative bases are allowed without replacing the denominator by its absolute value. For example, −100 to −50 produces −50%. This mathematical percent change is not a financial-return definition for negative-price instruments.

These operations use stored binary64 values. They do not recover input decimal precision, promise universally correctly rounded real arithmetic, or add index-100 mode. The tests include adjacent stored prices, opposite near-maximum values, subnormal bases, signed bases and actual overflow.

No values are forward-filled, interpolated or placed on a union timeline. Reference positions without an exact observation stay gaps. Observations outside the reference are not displayed. The choice of reference timeline remains the host's decision. No currency conversion, dividend/split adjustment, exchange-session inference or market-data fetch occurs. Pre-baseline values use the explicitly selected later base retrospectively; this is not a causal/as-of indicator or a trading signal.

Prepending older observations does not move the anchor: call the helper again with the same timestamp, which must remain present. If the host corrects that baseline's raw value, recomputation deliberately uses the corrected base and reports it. Appending, resetting, cropping or correcting source data is not automatically subscribed; the host must realign/recompute and supply new values. This example does not alter the existing live-ingestion ownership contracts.

## Demo publication and validation

The demo owns its synthetic chart/model and destroys both with its listeners on teardown. It calculates all normalized series before invoking any setter. That is calculation preflight, **not** a transactional multi-series ChartAPI update. A later setter or paint failure may leave partially applied model values, so chart/table/summary remain concealed with an error message until a successful Apply. It does not claim rollback. The chart surface uses layout-preserving visibility concealment plus `aria-hidden`, so drawing while concealed retains the actual chart dimensions. Raw-table hiding may use `display:none`.

The baseline selector is a pending choice until Apply; the summary describes the last successfully published baseline. Ordinary select/button keyboard behavior is retained, without new global shortcuts or focus movement. The page never reads a system clipboard or fetches external data.

Maintained Node tests cover literal formulas, exact joins/gaps, capture/ownership, bounds, timestamp-preserving prepend, shared linear/inverted geometry, an actual hidden-study query trap, modeled Canvas sizing, partial setter/paint failure recovery, repeated/reentrant actions and teardown. Four intentional mutations must fail specific baseline/gap/narrow-price/type assertions and preserve their raw diagnostics. Actual browser, assistive-technology, native SDK and display performance validation remain unrun.
