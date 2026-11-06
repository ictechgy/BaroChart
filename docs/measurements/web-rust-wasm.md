# Web Rust/WASM performance evidence

Measured 2026-11-06T03:38:54.103Z with Chrome/156.0.8078.80 and v22.20.0. JavaScript remains the default. This report records the implemented optional backend; it does not establish superiority or physical display FPS.

- Workload: seeded OHLCV (42), three indicators, six series, 1200×700 CSS px, DPR 1.
- Each cold row uses a fresh Chrome profile. Each warm renderer case uses 10 warmup and 100 measured samples; 3 rotated repeats.
- WASM: 3324243 raw / 1045181 gzip / 783178 Brotli bytes.
- Exact gates: representative raw/EMA/Bollinger/RSI values and view state at every size; scene statistics and mutation results are checked outside their measured intervals. Full six-field OHLCV validation for 10,000 bars runs once after all warm timing and memory snapshots.
- Memory: Rust engine accounting and linear memory are available. Worker RSS and candidate-only peak memory are unavailable. No forced GC was used.
- Environment: Chrome profiles were isolated, but OS scheduling and unrelated host background load were not controlled. This is an SDK pipeline benchmark, not main-demo navigation or actual display measurement.

| Cold repeat | Bars | Backend | total ready ms | prepare ms | first render ms |
|---:|---:|---|---:|---:|---:|
| 1 | 10,000 | javascript | 115.50 | 9.00 | 32.10 |
| 1 | 10,000 | rust-wasm | 104.70 | 39.30 | 8.60 |
| 1 | 100,000 | rust-wasm | 135.90 | 71.70 | 8.50 |
| 1 | 100,000 | javascript | 77.30 | 27.00 | 12.70 |
| 1 | 1,000,000 | javascript | 240.80 | 164.90 | 18.10 |
| 1 | 1,000,000 | rust-wasm | 512.40 | 427.70 | 8.50 |
| 2 | 1,000,000 | rust-wasm | 521.60 | 434.70 | 8.10 |
| 2 | 1,000,000 | javascript | 237.90 | 157.60 | 18.20 |
| 2 | 100,000 | javascript | 88.90 | 27.80 | 13.00 |
| 2 | 100,000 | rust-wasm | 140.50 | 70.30 | 8.20 |
| 2 | 10,000 | rust-wasm | 101.60 | 40.70 | 8.90 |
| 2 | 10,000 | javascript | 62.50 | 8.90 | 12.80 |
| 3 | 100,000 | javascript | 83.90 | 29.00 | 13.10 |
| 3 | 100,000 | rust-wasm | 138.80 | 72.30 | 8.40 |
| 3 | 10,000 | rust-wasm | 101.90 | 39.80 | 8.50 |
| 3 | 10,000 | javascript | 56.10 | 8.20 | 20.20 |
| 3 | 1,000,000 | javascript | 224.00 | 158.50 | 18.30 |
| 3 | 1,000,000 | rust-wasm | 500.30 | 425.50 | 8.40 |

| Warm repeat | Bars | Backend | Renderer | completion p50 ms | completion p95 ms | input→render p50 ms | input→render p95 ms |
|---:|---:|---|---|---:|---:|---:|---:|
| 1 | 10,000 | javascript | canvas | 0.20 | 0.30 | 16.50 | 22.50 |
| 1 | 10,000 | rust-wasm | canvas | 0.80 | 1.40 | 18.70 | 23.80 |
| 1 | 10,000 | javascript | webgl2 | 0.30 | 0.50 | 17.40 | 22.50 |
| 1 | 10,000 | rust-wasm | webgl2 | 0.80 | 0.90 | 18.90 | 23.40 |
| 1 | 100,000 | javascript | canvas | 0.20 | 0.40 | 16.90 | 22.80 |
| 1 | 100,000 | rust-wasm | canvas | 0.70 | 1.30 | 19.30 | 23.90 |
| 1 | 100,000 | javascript | webgl2 | 0.30 | 0.50 | 16.70 | 22.40 |
| 1 | 100,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 20.20 | 26.10 |
| 1 | 1,000,000 | javascript | canvas | 0.20 | 0.30 | 16.20 | 21.20 |
| 1 | 1,000,000 | rust-wasm | canvas | 0.80 | 1.30 | 19.50 | 24.50 |
| 1 | 1,000,000 | javascript | webgl2 | 0.30 | 0.40 | 17.00 | 22.20 |
| 1 | 1,000,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 17.50 | 25.90 |
| 2 | 1,000,000 | javascript | webgl2 | 0.20 | 0.30 | 16.70 | 22.00 |
| 2 | 1,000,000 | rust-wasm | webgl2 | 0.70 | 0.90 | 18.70 | 24.40 |
| 2 | 1,000,000 | javascript | canvas | 0.20 | 0.40 | 16.10 | 22.40 |
| 2 | 1,000,000 | rust-wasm | canvas | 0.90 | 1.50 | 19.70 | 25.90 |
| 2 | 100,000 | javascript | webgl2 | 0.20 | 0.30 | 17.20 | 22.90 |
| 2 | 100,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.30 | 25.00 |
| 2 | 100,000 | javascript | canvas | 0.20 | 0.30 | 17.00 | 23.20 |
| 2 | 100,000 | rust-wasm | canvas | 0.80 | 1.40 | 18.90 | 26.20 |
| 2 | 10,000 | javascript | webgl2 | 0.20 | 0.40 | 16.70 | 23.00 |
| 2 | 10,000 | rust-wasm | webgl2 | 0.70 | 0.80 | 19.40 | 24.60 |
| 2 | 10,000 | javascript | canvas | 0.20 | 0.30 | 16.20 | 22.90 |
| 2 | 10,000 | rust-wasm | canvas | 0.80 | 1.40 | 19.40 | 24.60 |
| 3 | 100,000 | javascript | canvas | 0.10 | 0.30 | 16.00 | 20.90 |
| 3 | 100,000 | rust-wasm | canvas | 0.80 | 1.30 | 18.00 | 25.10 |
| 3 | 100,000 | javascript | webgl2 | 0.30 | 0.40 | 16.70 | 24.20 |
| 3 | 100,000 | rust-wasm | webgl2 | 0.80 | 0.90 | 20.00 | 23.50 |
| 3 | 10,000 | javascript | canvas | 0.20 | 0.30 | 16.30 | 21.70 |
| 3 | 10,000 | rust-wasm | canvas | 0.70 | 1.30 | 18.60 | 24.50 |
| 3 | 10,000 | javascript | webgl2 | 0.30 | 0.40 | 16.90 | 21.30 |
| 3 | 10,000 | rust-wasm | webgl2 | 0.80 | 0.90 | 18.00 | 22.20 |
| 3 | 1,000,000 | javascript | canvas | 0.20 | 0.20 | 17.00 | 20.60 |
| 3 | 1,000,000 | rust-wasm | canvas | 0.80 | 1.30 | 20.20 | 22.70 |
| 3 | 1,000,000 | javascript | webgl2 | 0.20 | 0.30 | 16.90 | 20.10 |
| 3 | 1,000,000 | rust-wasm | webgl2 | 0.80 | 1.10 | 19.50 | 23.50 |

Completion differs by architecture: JavaScript is synchronous scene plus renderer submission; Rust is Worker RPC plus packet decode and renderer submission. See the JSON report for fetch/compile/actor initialization, transport, stream, parameter-update, memory, long-task, order, and resource-lifetime evidence.
