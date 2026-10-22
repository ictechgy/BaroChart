# Bounded multi-chart core CPU baseline

Run explicitly with `node benchmarks/multi-chart-cpu.mjs /tmp/barochart-multi-chart-cpu.json`.
Importing the module does not execute the pilot. No browser, server, download or renderer is started.

## 2026-10-16 pilot

The cloud environment reported Node v24.19.0, Linux x64 and AMD EPYC 9V74 80-Core Processor. The harness is serial; this label does not imply exclusive access to the host or use of all cores.

Production source was `fcc5690bfd2e6a0bc4e3603eccb639e6fb43dc7b`; this harness/documentation follow-up changes no production module. All source-module and harness SHA-256 values matched before and after the run. This establishes endpoint equality, not detection of changes reverted between those checks.

The fixture uses independent ChartModels, candles plus EMA20, 200 visible bars, 1200×700 logical dimensions, and deterministic seed 42+chart index. Cases use 1/4/8 charts, each performing clean scene construction, current-tail update plus scene, or append plus scene. Each group has five warmups and ten retained samples, repeated three times with fresh fixtures in forward/reverse/forward order. Every mutation operation changes every chart once. Initial total 80k distributes exactly as 80k/20k/10k per chart; fixed-per-chart 10k grows total data from 10k to 40k to 80k. Fixed-total fixes initial stored bars, not the number of scene constructions or events. The three repetitions are one bounded pilot, not a broad confidence interval.

Timing covers synchronous store mutation (where applicable) and serial `buildScene` calls for the entire group. It excludes fixture construction, correctness oracles, output serialization and disposal. It does not include Canvas/WebGL command submission, physical paint, browser scheduling, GPU/FPS, SDK/device work or network feeds. No forced GC is used; pauses remain in the raw samples. Retained expected-data fixtures can influence allocation/GC conditions. Dividing group time by chart count gives an average-equivalent cost, not the latency distribution of individual charts.

All 54 cases passed, retaining 540 measured samples. Outside timing, 23,318,190 element comparisons checked full OHLCV and incremental EMA against a fresh implementation, and 702 direct scalar range scans checked extrema/counts. The final timed scene per chart was nonempty, had finite numeric command fields, and matched fresh scene commands at the same view. The fresh EMA/scene oracle shares implementation and is not an independent financial formula/pixel oracle. Clean cases retain source version, entry, output backing buffer/span and index identity. Column identity is checked where capacity does not grow. Every model was disposed with its public store listener count zero; this does not prove all references were collected or absence of long-term leaks.

The one-chart 80k case uses BlockRangeIndex while the split cases use RangeIndex. Capacity and actual index policy are recorded per chart. These policy and working-set differences prevent interpreting fixed-total results as chart-count overhead alone. Selected store bytes and full logical EMA output-view bytes are recorded; these exclude JS heap, index/checkpoint objects, transient peaks, workers, GPU memory and RSS.

### Group elapsed milliseconds

Nearest-rank quantiles over all 30 retained samples per condition. Every maximum and all repetitions are retained; no performance thresholds are asserted.

| Workload | Charts | Operation | p50 | p95 | Max |
| --- | ---: | --- | ---: | ---: | ---: |
| fixed-total | 1 | clean | 0.053 | 0.443 | 0.552 |
| fixed-total | 1 | update | 0.077 | 0.459 | 0.504 |
| fixed-total | 1 | append | 0.081 | 0.278 | 0.349 |
| fixed-total | 4 | clean | 0.219 | 0.430 | 0.436 |
| fixed-total | 4 | update | 0.336 | 0.808 | 4.398 |
| fixed-total | 4 | append | 0.288 | 0.478 | 0.479 |
| fixed-total | 8 | clean | 0.525 | 1.119 | 5.645 |
| fixed-total | 8 | update | 0.636 | 1.074 | 1.219 |
| fixed-total | 8 | append | 0.580 | 0.825 | 1.703 |
| fixed-per-chart | 1 | clean | 0.051 | 0.144 | 0.174 |
| fixed-per-chart | 1 | update | 0.062 | 0.159 | 0.168 |
| fixed-per-chart | 1 | append | 0.065 | 0.161 | 0.179 |
| fixed-per-chart | 4 | clean | 0.218 | 0.370 | 0.648 |
| fixed-per-chart | 4 | update | 0.268 | 0.414 | 0.546 |
| fixed-per-chart | 4 | append | 0.272 | 0.428 | 2.096 |
| fixed-per-chart | 8 | clean | 0.433 | 1.273 | 6.804 |
| fixed-per-chart | 8 | update | 0.506 | 0.794 | 0.905 |
| fixed-per-chart | 8 | append | 0.535 | 0.833 | 0.897 |

The baseline shows increasing group work and noticeable outliers, including 6.804 ms for eight-chart clean construction. It supplies no evidence to increase synchronization membership limits or claim a supported chart-count/FPS ceiling. No production optimization was selected from this pilot. Raw samples and initial harness-assumption failures are retained separately in private development verification records, not included in this public checkout.
