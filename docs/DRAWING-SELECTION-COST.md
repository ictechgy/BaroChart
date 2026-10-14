# Drawing selection metadata cost

This change removes redundant source validation and temporary whole-source metadata copies. It does **not** make every query faster or establish browser frame-rate/input-latency improvements.

## Work and ownership

Every source row still receives the existing own-data, immutable-record, metadata and duplicate-ID checks, including rows outside the requested page. Select, clear and refresh now validate once and build their returned snapshot from that checked source, with no intervening user callback. Previously they validated twice. Snapshot alone remains one full validation pass.

The scan constructs at most 32 page metadata records and retains live matches only for the at-most-128 selected IDs, plus an optional requested target. It no longer constructs n metadata records, n pair arrays and a full n-entry live Map for a page query. The duplicate-ID Set and Reflect.ownKeys array still scale O(n); this is not a constant-memory operation or an allocation-byte/GC measurement. There is no persistent metadata cache or new trust in mutable items-array identity.

Instrumented 1,000/10,000-drawing regressions confirm n ID descriptor reads for select/clear/refresh, versus 2n previously, and temporary live Maps no larger than 128. These counters instrument work, not browser performance or total heap allocation. Full stale counts, off-page invalid rows, return snapshots after selection changes and existing getter-free rejection remain covered.

## Matched Node timing

Baseline: `ae35897`. Node 24.19.0, separate processes, AB then BA for each source size; case order reversed in BA. Each case has 3 warmups and 15 timed samples. Fixture loading and initial 128 selections are outside timing. P95 uses nearest rank and equals the observed maximum with 15 samples. All 16 corresponding result snapshot SHA256 digests match. The harness and raw samples are retained separately in development verification records; they are not included in this public checkout.

Results are limited, noisy samples. The 10k first-page AB median and both page-query AB tail samples regress; these are retained below. Baseline BA also has large outliers. Their causes were not profiled, so they are not attributed to GC or system load. The adoption basis is eliminated duplicated work and copied metadata, with observed selection/refresh improvements, not universal query speed.

| Drawings | Order | Operation | Median baseline→candidate ms | P95/max baseline→candidate ms |
|---:|:---:|---|---:|---:|
| 1000 | AB | pageFirst | 0.799 → 0.616 | 2.162 → 1.398 |
| 1000 | AB | pageLast | 1.062 → 1.004 | 2.286 → 1.382 |
| 1000 | AB | select | 2.008 → 0.855 | 4.150 → 1.584 |
| 1000 | AB | refresh | 2.071 → 0.859 | 3.416 → 1.354 |
| 1000 | BA | refresh | 1.667 → 0.916 | 2.798 → 2.373 |
| 1000 | BA | select | 1.766 → 0.802 | 3.262 → 1.319 |
| 1000 | BA | pageLast | 1.016 → 0.755 | 3.041 → 1.420 |
| 1000 | BA | pageFirst | 0.738 → 0.650 | 1.577 → 1.104 |
| 10000 | AB | pageFirst | 10.887 → 23.495 | 19.968 → 34.251 |
| 10000 | AB | pageLast | 12.266 → 11.360 | 17.742 → 30.592 |
| 10000 | AB | select | 19.415 → 9.973 | 26.509 → 19.215 |
| 10000 | AB | refresh | 21.462 → 9.991 | 28.389 → 22.515 |
| 10000 | BA | refresh | 22.222 → 11.083 | 44.627 → 29.373 |
| 10000 | BA | select | 31.452 → 12.206 | 491.197 → 16.044 |
| 10000 | BA | pageLast | 23.876 → 9.705 | 230.300 → 14.101 |
| 10000 | BA | pageFirst | 14.993 → 10.081 | 185.232 → 15.007 |

## Remaining panel costs

This commit changes only the DOM-free selection implementation. Panel event handling still performs another snapshot for rendering and writes visible row text. In the prior panel, even two hover-only invalidations caused 64 row text writes and 2 count writes while only one RAF was queued in the test-only DOM. No drawing-change revision/cache contract has been added here. Raw mutable-array identity alone would be insufficient to skip explicit validation.

Disposal clears chart/API/model/selected-drawing references and listeners. Holding the destroyed panel handle can still hold its bounded detached UI subtree (157 elements for the tested 32-row panel); this is not evidence of retaining the full drawing store, and no browser GC/heap claim is made. Actual browser/AT behavior remains unverified.
