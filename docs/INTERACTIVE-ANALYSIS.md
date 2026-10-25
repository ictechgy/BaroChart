# Interactive analysis in the main demo

The main demo now combines indicator discovery with a live OHLCV and study-value readout. It uses the existing data model and rendering pipeline; adding the readout does not replace data, change the viewport or add a second pointer-render loop.

## Find a study

Search all 35 built-in indicators by abbreviation, English name or Korean name, then optionally filter by trend, momentum, volatility or volume. Search terms can appear in any order. The native selector retains a matching choice; an empty result disables Add. Escape clears the query while keeping focus in the input, and IME composition is allowed to finish before filtering. Adding a study still uses asynchronous preparation and the existing cancellation/ownership rules.

Search and category choices are local controls. They do not add layout-history commands or change the saved chart until a study is actually added.

## Read a bar

The header shows one selected stored bar and its OHLCV values. The selection priority is:

1. An active keyboard exploration selection, matched by its exact stored timestamp.
2. A pointer over a current, already prepared chart layout, including the configured pointer snap mode.
3. The latest stored bar.

A pointer outside the plot or beyond stored history falls back to the explicitly labeled latest bar. A missing keyboard selection stays missing. The readout does not invent a future bar or silently clamp one into existence. Times use the chart symbol's timezone, with a bounded UTC fallback.

Visible line, area and histogram series appear below the primary OHLCV values, including each displayed study output and aligned external series. Candle/OHLC rows are omitted from that list because the primary header already gives their OHLC values. Hidden series disappear, existing visible row nodes remain stable, and removed rows are released. Titles retain the unrounded raw value while visible text stays compact, preserving signed zero and small nonzero values.

The display calls [cached `dataAt`](DATA-EXPLORER.md#cached-interactive-reads) once per refresh. It does not compute indicators, build a layout, invoke chart formatters or invalidate the renderer. All 35 unmodified built-in indicators support automatic values. Incomplete built-in caches show **계산 대기** instead of an old number; warmup and missing observations show **—**. Custom, linked or altered studies show **자동 조회 미지원**; the existing explicit calculating API and keyboard Enter read remain available for those studies. Ordinary rendering or an explicit calculating read makes completed built-in values available.

The readout follows model/renderer replacement and WebGL-to-Canvas fallback, and detaches on terminal page teardown. It uses `aria-live="off"` to avoid announcing every pointer move; the existing keyboard exploration live region remains the explicit announcement path.

## Reproduce the checks

```sh
node --test test/indicator-picker.test.mjs test/live-readout.test.mjs \
  test/data-explorer-cached.test.mjs test/data-explorer-cached-native.test.mjs
npm run test:indicator-layout:browser
node --expose-gc benchmarks/cached-readout.mjs 1000000 8 /tmp/readout-1m-8.json
node --expose-gc benchmarks/cached-readout.mjs 1000000 32 /tmp/readout-1m-32.json
```

The scalar benchmark alternates warmed calculating/cached queries and checks exact snapshot equality. A separate dirty-cache lane requires positioned pending values and zero lazy calculations, with unchanged source and output storage. Pending availability is a different result contract from full calculation and is never reported as its speedup. Timing samples include normal garbage-collection tails; setup and independent arithmetic checks are outside the query timer. Results include environment, source hashes and all acceptance-target outcomes.

A 2026-10-26 local pilot on Apple M4 Pro / macOS arm64 / Node 22.20.0 recorded the following p95 query times over 1,000,000 bars, 200 warmups and 2,000 samples per lane:

| EMA studies | Exact warm calculating read | Exact warm cached read | Dirty cached availability |
| --- | ---: | ---: | ---: |
| 8 | 0.112 ms | 0.067 ms | 0.056 ms, pending |
| 32 | 0.871 ms | 0.207 ms | 0.192 ms, pending |

The two exact warm lanes returned identical scalar snapshots; cached p95 was about 40% and 76% lower in these two cases. Raw [8-study](measurements/cached-readout-20261026-1m-8.json) and [32-study](measurements/cached-readout-20261026-1m-32.json) reports retain source hashes, tails, counters and acceptance outcomes. This is one host-specific pilot, not a device-independent bound or a competitor comparison.

The browser regression exercises 300 pointer-render cycles over 100,000 bars and 32 studies, checks zero lazy study calls/base redraws, and keeps buffers, drawings, viewport and keyed rows intact. It also checks keyboard selection, real DOM event delivery, canvas replacement and 320/390/1280px layouts. When `WEBGL_lose_context` is available it executes real context loss; otherwise its report explicitly identifies the narrower explicit-fallback path. These are browser and CPU-query checks, not physical-device touch, screen-reader, display-latency or FPS measurements.

## Competitive quality gates

The product target is a chart that is easier to analyze and predictably responsive with host-owned data. No claim of overall superiority to TradingView or SciChart follows from these checks. A comparative result needs exact product/version, allowed runtime access, equal data and visible work, browser/device, warmup/sample order, and separate CPU/render/display endpoints. Vendored Lightweight Charts is a distinct product from TradingView's complete charting products.

The next bounded improvements should be accepted by task completion and measurements:

- Bring the existing drawing object manager into the main analysis workflow: locate, hide, lock, duplicate and batch-edit drawings without losing selection or history.
- Compose saved multi-chart analysis from the existing linked-time/cursor and workspace APIs, preserving independent symbol/data ownership.
- Record real React 18/19 mount, streaming, unmount and SSR behavior, then actual Apple/Android SDK/device runs. Modeled tests cannot close these runtime gates.
- Compare reproducible large-data append/correction/pan/hover workloads against accessible competitor runtimes. Retain failed and inconclusive measurements as well as wins.

These items remain future acceptance gates; the current change delivers search and the bounded live readout.
