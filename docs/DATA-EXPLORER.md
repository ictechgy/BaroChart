# Bounded data explorer

`ChartAPI.dataAt(query, options?)` returns a layout-independent, owned scalar snapshot. It does not require a viewport, scene build, hover event or screen coordinates. The API itself is layout-independent. The opt-in web keyboard prototype in [KEYBOARD-EXPLORER.md](KEYBOARD-EXPLORER.md) adds selection and explicit value reads; actual browser/assistive-technology UX remains unverified.

```js
const api = new ChartAPI(model);
const currentPlot = api.dataAt({index: 120});
const exact = api.dataAt({time: requestedTime, match: 'exact'});
const previous = api.dataAt({time: requestedTime, match: 'at-or-before'});
// Explicit historical source-index cutoff:
const limited = api.dataAt({index: 120}, {asOfIndex: 120, includeHidden: true});
```

## Selection and time

Choose exactly one of `{index}` and `{time, match}`. Index is a nonnegative safe integer. Timestamp is an integer UTC millisecond within the JavaScript Date range; matching policy is mandatory. `exact` returns null for a gap; `at-or-before` selects the greatest stored timestamp no later than the requested timestamp. It never synthesizes a bar. Missing rows, empty data and selections after the cutoff return null.

Time is the stored `Bar.time`. For a host supplying bar-open timestamps it is the open, not the close. This API cannot infer duration, finalization, actual arrival time or MTF `availableAt`. Normalize external timestamp conventions before ingestion. Use confirmed-as-of resampling/alignment when its separate close-time contract is needed.

`asOfIndex` defaults to the current last stored index and accepts -1 (no eligible rows) through that index. A series' displayed row maps to `sourceIndex = index - offset`. The default returns the current chart's plotted value: a negative offset can show a later source row at an earlier displayed row. It is not a default no-lookahead query. Explicit cutoff rejects source indices beyond it with `after-cutoff`.

Cutoff restricts indices in the currently revised data. Historical corrections can change an earlier answer. Without actual arrival/revision histories this is not a point-in-time backtest guarantee.

## Result and causality metadata

A non-null result includes index, stored time, effective asOfIndex, storeVersion, primary OHLCV bar and symbol metadata, and series rows in configured order. Rows carry IDs, panel/axis binding, visibility, type, offset, source field or indicator/output, sourceIndex/sourceTime, scalar value and status. Candle/OHLC series use close as their scalar; the primary bar contains all six OHLCV fields. No display rounding, axis transform, formatter callback or currency conversion is applied. Core Float64 values preserve signed zero; JSON native transport follows JSON's signed-zero normalization.

`kind` separates source, indicator and external rows. `causality` explains the trust boundary:

- `stored-source`: a stored OHLCV column, restricted by source index.
- `host-aligned`: caller-provided aligned values. Cutoff restricts their source index only; the library cannot certify how, when or using which future information they were produced.
- `canonical-builtin`: an unmodified definition created by a canonical builtin factory, with the canonical registry binding still installed. The 33 current builtin raw outputs use current/prior source rows. Plot offsets are applied separately.
- `unverified-study`: custom, linked or altered definitions. With a past cutoff these return `unsupported-causality` without invoking lazy calculation. A custom module's causal declaration alone is not certification. The latest cutoff permits its current trusted output.

Definition provenance is private and follows the actual definition, not its registry name. Replacing the registry factory makes an existing builtin unsupported for historical queries; restoring the original factory restores eligibility only if the original definition's create function, output schema and offsets still match. Arbitrarily changing implementation state is unsupported.

Statuses are `value`, `non-finite` (NaN/warmup/Infinity mapped to null with source position retained), `outside-source`, `after-cutoff`, and `unsupported-causality`. The last three return null value/sourceIndex/sourceTime. No missing observation silently carries an earlier value.

## Bounds, ownership and lazy execution

Visible series are included by default; includeHidden opts in to hidden rows. The model limit is 256 series and overflow is rejected, never truncated. Metadata is bounded: 128-character IDs, 256-character labels, 64-character currency/volume units, 16-character series types, plus the existing 32-panel/64-axis/128-indicator contracts. Returned records and arrays are independent of the model; no column/output buffer is exposed.

This is a semantic read, not a side-effect-free computation: it does not notify, change viewport/hover, drain ingestion, alter drawings or modify the store. It may allocate or update lazy indicator caches and run trusted custom code. The existing indicator engine can calculate the entire dirty suffix, even beyond the requested cutoff. Later overflow or custom computation errors propagate; historical lookup does not truncate engine evaluation or suppress errors. A bounded response therefore does not bound CPU or indicator cache memory. Prefer warmed queries for interactive readouts and measure cold/dirty workloads separately.

Supported source/model/series/definition changes during trusted callbacks are checked before returning; mixed results fail with StaleSourceError. When a source changes during a lazy computation, a failed read resets only its still-owned in-flight entry to dirty-from-zero so the next read recomputes the revised data. Replaced/disposed entries are untouched; UI-only staleness does not force recomputation. The common IndicatorEngine now also guards direct get/calculate, scene and crosshair consumers; see [INDICATOR-REENTRY.md](INDICATOR-REENTRY.md). A simultaneous prepared worker is not committed by this read, and supported later publication is visible on subsequent calls. Ordinary reads may warm the old engine's caches while it waits. Shared stores remain owned by their hosts. Getter inputs, inherited options, shared typed buffers and missing own output keys are rejected without treating them as values. Direct column writes, arbitrary Proxy replacements and unsupported internal object mutation are outside managed consistency guarantees.

## Native facade and validation scope

Swift `dataAt(_:options:)` and Java `dataAt(JSONObject[, JSONObject])` expose the same read-only native command. A missing result maps to nil/null. The command does not trigger native invalidation. The standalone QuickJS/Node bridge tests execute common-core semantics; Java test-only signature compilation is not Android/JNI execution, and Swift source checks are not Swift/JSC compilation or runtime validation.

Reproduction, all cost conditions and validation limitations: DATA-EXPLORER-VALIDATION.md (not included in this source distribution).
