# VWMA validation

VWMA is the 35th built-in. It uses the explicit finite-precision policy in [INDICATORS.md](INDICATORS.md#vwma-추가-규약). In particular, product, total-volume or absolute-product overflow produces a gap even if a scaled mathematical weighted mean could be finite. No cross-product parity or performance superiority is claimed.

```js
api.addIndicator('weighted-close', 'vwma', {period: 20});
api.addSeries({id: 'weighted-close-line', type: 'line', panel: 'price',
  indicator: 'weighted-close', output: 'value', color: '#36b6c5'});
```

## Executed checks

Cloud Linux, Node 24.19.0:

- Full serial suite: **2,719 passed, 0 failed, 0 skipped**.
- Syntax: **374 ECMAScript modules**; strict TypeScript 5.9.3 and offline installed-package checks passed.
- **35 focused VWMA tests** include 24 independent window-oracle tests, six checkpoint/cancellation tests, four public/real-Worker integration tests and one native-bundle VM fixture test.
- The independent oracle recomputes raw window products and compensated sums without production helpers. Ordinary values also have a separate naive scan comparison. Analytical cases cover dominant volume/numerator retirement, signed cancellation, exact ±1/3 and ±0.2 residuals, period-one underflow, zero-volume gaps and finite/overflow boundaries.
- Mutation paths include append, same-bar update, history correction, prepend, reset, compaction restart and portable studies/workspace restoration. Actual Node Workers cover async parameter replacement and workspace restore. Source columns, bindings, held old outputs and shared-store ownership are checked.
- Checkpoint validation checks window length/head, product/volume values, counters, sums and compensation. Periodic or extreme-magnitude rebase states are checked exactly; other compensated representations use an explicit scale-dependent rounding allowance. Validation is structural/numerical consistency, not authentication of externally supplied history.
- An independently compiled vendored QuickJS host ran four fixed VWMA scenarios: native commands with raw-window oracle, parameter/history mutation, native prepared workspace/checkpoint ownership, and compact restart/cleanup. Runtime, OOM and interruption teardown all reported zero final tracked allocation bytes/count.

## Numerical recovery and limitations

Review found that ordinary rolling sums could lose small retained contributions after a dominant bar expired. A single compensation component also needs rebasing when large terms leave or nearly cancel. The final producer rebases for dominant retirement, excessive compensation relative to the current sum, large-magnitude/invalid state and every p updates. Tests retain the concrete regression cases; checkpoint validation was not relaxed to hide incorrect output.

Normal non-cancelling data has amortized O(1) per-bar aggregation and O(p) state. Extreme-magnitude or cancellation-heavy data can require O(p) work per bar. Checkpoint copying and dirty-history recomputation incur their existing additional costs. No wall-clock latency bound or new performance benchmark is claimed.

BarStore separately rejects source volume aggregates outside its accepted finite range. Direct definition tests exercise sum-overflow recovery beyond that accepted store envelope; they do not imply those inputs are accepted through ingestion.

Browser/assistive-technology pixels, Swift/JSC, Android/JNI, mobile SDK and physical-device execution remain unverified for this addition. Standalone QuickJS and Node Worker results do not close those gaps.
