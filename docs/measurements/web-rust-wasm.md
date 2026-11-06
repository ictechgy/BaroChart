# Web Rust/WASM performance evidence

Measured 2026-11-06T18:35:30.708Z with Chrome/156.0.8078.80 and v22.20.0. JavaScript remains the default. This report records the implemented optional backend; it does not establish superiority or physical display FPS.

- Workload: seeded OHLCV (42), three indicators, six series, 1200×700 CSS px, DPR 1.
- Each cold row uses a fresh Chrome profile. Each warm renderer case uses 10 warmup and 100 measured samples; 3 rotated repeats.
- WASM: 3325956 raw / 1046003 gzip / 783587 Brotli bytes.
- Exact gates: representative raw/EMA/Bollinger/RSI values and view state at every size; scene statistics and mutation results are checked outside their measured intervals. Full six-field OHLCV validation for 10,000 bars runs once after all warm timing and memory snapshots.
- Memory: Rust engine accounting and linear memory are available. Worker RSS and candidate-only peak memory are unavailable. No forced GC was used.
- Environment: Chrome profiles were isolated, but OS scheduling and unrelated host background load were not controlled. This is an SDK pipeline benchmark, not main-demo navigation or actual display measurement.

| Cold repeat | Bars | Backend | total ready ms | prepare ms | first render ms |
|---:|---:|---|---:|---:|---:|
| 1 | 10,000 | javascript | 75.90 | 13.30 | 25.70 |
| 1 | 10,000 | rust-wasm | 115.80 | 40.40 | 9.20 |
| 1 | 100,000 | rust-wasm | 132.80 | 71.80 | 8.30 |
| 1 | 100,000 | javascript | 76.70 | 29.40 | 13.00 |
| 1 | 1,000,000 | javascript | 245.50 | 170.00 | 18.50 |
| 1 | 1,000,000 | rust-wasm | 506.70 | 428.50 | 8.20 |
| 2 | 1,000,000 | rust-wasm | 512.90 | 426.40 | 8.00 |
| 2 | 1,000,000 | javascript | 237.30 | 160.70 | 18.80 |
| 2 | 100,000 | javascript | 90.70 | 27.90 | 12.10 |
| 2 | 100,000 | rust-wasm | 128.50 | 71.30 | 8.30 |
| 2 | 10,000 | rust-wasm | 96.20 | 38.50 | 8.80 |
| 2 | 10,000 | javascript | 64.60 | 8.70 | 20.30 |
| 3 | 100,000 | javascript | 78.30 | 27.00 | 12.40 |
| 3 | 100,000 | rust-wasm | 142.20 | 71.30 | 8.30 |
| 3 | 10,000 | rust-wasm | 107.90 | 42.10 | 8.80 |
| 3 | 10,000 | javascript | 51.50 | 8.80 | 15.00 |
| 3 | 1,000,000 | javascript | 256.60 | 174.00 | 19.30 |
| 3 | 1,000,000 | rust-wasm | 515.60 | 426.40 | 8.30 |

| Warm repeat | Bars | Backend | Renderer | completion p50 ms | completion p95 ms | input→render p50 ms | input→render p95 ms |
|---:|---:|---|---|---:|---:|---:|---:|
| 1 | 10,000 | javascript | canvas | 0.20 | 0.40 | 16.80 | 18.80 |
| 1 | 10,000 | rust-wasm | canvas | 0.80 | 1.30 | 19.50 | 22.20 |
| 1 | 10,000 | javascript | webgl2 | 0.30 | 0.40 | 16.90 | 19.00 |
| 1 | 10,000 | rust-wasm | webgl2 | 0.80 | 0.90 | 18.60 | 21.40 |
| 1 | 100,000 | javascript | canvas | 0.30 | 0.50 | 17.00 | 20.50 |
| 1 | 100,000 | rust-wasm | canvas | 0.70 | 1.50 | 19.20 | 21.90 |
| 1 | 100,000 | javascript | webgl2 | 0.30 | 0.40 | 16.90 | 18.80 |
| 1 | 100,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 19.30 | 22.00 |
| 1 | 1,000,000 | javascript | canvas | 0.20 | 0.70 | 17.00 | 18.50 |
| 1 | 1,000,000 | rust-wasm | canvas | 0.70 | 1.30 | 19.00 | 21.60 |
| 1 | 1,000,000 | javascript | webgl2 | 0.30 | 0.40 | 18.10 | 22.60 |
| 1 | 1,000,000 | rust-wasm | webgl2 | 0.80 | 1.10 | 18.30 | 23.10 |
| 2 | 1,000,000 | javascript | webgl2 | 0.20 | 0.40 | 16.30 | 23.20 |
| 2 | 1,000,000 | rust-wasm | webgl2 | 0.70 | 0.90 | 18.60 | 25.10 |
| 2 | 1,000,000 | javascript | canvas | 0.20 | 0.30 | 15.40 | 22.90 |
| 2 | 1,000,000 | rust-wasm | canvas | 0.80 | 1.50 | 17.60 | 25.70 |
| 2 | 100,000 | javascript | webgl2 | 0.20 | 0.30 | 17.00 | 23.60 |
| 2 | 100,000 | rust-wasm | webgl2 | 0.80 | 0.90 | 16.90 | 25.30 |
| 2 | 100,000 | javascript | canvas | 0.20 | 0.50 | 17.90 | 24.00 |
| 2 | 100,000 | rust-wasm | canvas | 0.80 | 1.40 | 17.50 | 26.30 |
| 2 | 10,000 | javascript | webgl2 | 0.20 | 0.40 | 16.00 | 24.10 |
| 2 | 10,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 17.70 | 25.60 |
| 2 | 10,000 | javascript | canvas | 0.20 | 0.30 | 17.00 | 22.00 |
| 2 | 10,000 | rust-wasm | canvas | 0.80 | 1.40 | 19.10 | 26.10 |
| 3 | 100,000 | javascript | canvas | 0.20 | 0.20 | 16.20 | 22.70 |
| 3 | 100,000 | rust-wasm | canvas | 0.80 | 1.30 | 18.90 | 24.30 |
| 3 | 100,000 | javascript | webgl2 | 0.30 | 0.60 | 16.80 | 23.70 |
| 3 | 100,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.60 | 25.10 |
| 3 | 10,000 | javascript | canvas | 0.20 | 0.40 | 16.50 | 22.00 |
| 3 | 10,000 | rust-wasm | canvas | 0.70 | 1.20 | 18.50 | 24.20 |
| 3 | 10,000 | javascript | webgl2 | 0.30 | 0.40 | 16.90 | 22.60 |
| 3 | 10,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.90 | 24.40 |
| 3 | 1,000,000 | javascript | canvas | 0.20 | 0.30 | 16.40 | 22.70 |
| 3 | 1,000,000 | rust-wasm | canvas | 0.80 | 1.40 | 18.60 | 23.80 |
| 3 | 1,000,000 | javascript | webgl2 | 0.30 | 0.40 | 16.50 | 22.10 |
| 3 | 1,000,000 | rust-wasm | webgl2 | 0.70 | 1.00 | 18.70 | 23.90 |

Completion differs by architecture: JavaScript is synchronous scene plus renderer submission; Rust is Worker RPC plus packet decode and renderer submission. See the JSON report for fetch/compile/actor initialization, transport, stream, parameter-update, memory, long-task, order, and resource-lifetime evidence.
