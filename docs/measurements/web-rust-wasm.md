# Web Rust/WASM performance evidence

Measured 2026-11-05T19:10:14.677Z with Chrome/156.0.8078.80 and v22.20.0. JavaScript remains the default. This report records the implemented optional backend; it does not establish superiority or physical display FPS.

- Workload: seeded OHLCV (42), three indicators, six series, 1200×700 CSS px, DPR 1.
- Each cold row uses a fresh Chrome profile. Each warm renderer case uses 10 warmup and 100 measured samples; 3 rotated repeats.
- WASM: 3320094 raw / 1044284 gzip / 782677 Brotli bytes.
- Exact gates: representative raw/EMA/Bollinger/RSI values and view state at every size; scene statistics and mutation results are checked outside their measured intervals. Full six-field OHLCV validation for 10,000 bars runs once after all warm timing and memory snapshots.
- Memory: Rust engine accounting and linear memory are available. Worker RSS and candidate-only peak memory are unavailable. No forced GC was used.
- Environment: Chrome profiles were isolated, but OS scheduling and unrelated host background load were not controlled. This is an SDK pipeline benchmark, not main-demo navigation or actual display measurement.

| Cold repeat | Bars | Backend | total ready ms | prepare ms | first render ms |
|---:|---:|---|---:|---:|---:|
| 1 | 10,000 | javascript | 55.50 | 7.70 | 10.30 |
| 1 | 10,000 | rust-wasm | 97.10 | 39.60 | 8.40 |
| 1 | 100,000 | rust-wasm | 135.30 | 72.40 | 8.10 |
| 1 | 100,000 | javascript | 79.40 | 27.40 | 12.50 |
| 1 | 1,000,000 | javascript | 239.90 | 162.50 | 18.10 |
| 1 | 1,000,000 | rust-wasm | 507.20 | 424.10 | 8.00 |
| 2 | 1,000,000 | rust-wasm | 499.60 | 421.80 | 8.00 |
| 2 | 1,000,000 | javascript | 241.10 | 159.30 | 18.50 |
| 2 | 100,000 | javascript | 76.00 | 27.00 | 12.90 |
| 2 | 100,000 | rust-wasm | 135.20 | 71.70 | 8.80 |
| 2 | 10,000 | rust-wasm | 100.70 | 38.30 | 8.50 |
| 2 | 10,000 | javascript | 51.00 | 8.20 | 10.80 |
| 3 | 100,000 | javascript | 83.60 | 26.40 | 12.10 |
| 3 | 100,000 | rust-wasm | 128.90 | 70.50 | 8.40 |
| 3 | 10,000 | rust-wasm | 98.80 | 38.70 | 8.30 |
| 3 | 10,000 | javascript | 50.10 | 7.70 | 10.80 |
| 3 | 1,000,000 | javascript | 238.30 | 161.20 | 17.90 |
| 3 | 1,000,000 | rust-wasm | 514.50 | 425.90 | 8.60 |

| Warm repeat | Bars | Backend | Renderer | completion p50 ms | completion p95 ms | input→render p50 ms | input→render p95 ms |
|---:|---:|---|---|---:|---:|---:|---:|
| 1 | 10,000 | javascript | canvas | 0.20 | 0.40 | 15.80 | 18.00 |
| 1 | 10,000 | rust-wasm | canvas | 0.80 | 1.30 | 20.60 | 23.00 |
| 1 | 10,000 | javascript | webgl2 | 0.30 | 0.40 | 18.10 | 19.50 |
| 1 | 10,000 | rust-wasm | webgl2 | 0.70 | 0.90 | 18.40 | 23.00 |
| 1 | 100,000 | javascript | canvas | 0.20 | 0.30 | 18.50 | 19.30 |
| 1 | 100,000 | rust-wasm | canvas | 0.70 | 1.30 | 20.60 | 22.70 |
| 1 | 100,000 | javascript | webgl2 | 0.30 | 0.50 | 16.90 | 18.80 |
| 1 | 100,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.40 | 20.60 |
| 1 | 1,000,000 | javascript | canvas | 0.20 | 0.30 | 16.90 | 18.40 |
| 1 | 1,000,000 | rust-wasm | canvas | 0.80 | 1.30 | 18.20 | 20.30 |
| 1 | 1,000,000 | javascript | webgl2 | 0.30 | 0.40 | 18.20 | 19.20 |
| 1 | 1,000,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.90 | 21.20 |
| 2 | 1,000,000 | javascript | webgl2 | 0.20 | 0.40 | 17.00 | 18.80 |
| 2 | 1,000,000 | rust-wasm | webgl2 | 0.70 | 0.80 | 19.80 | 22.60 |
| 2 | 1,000,000 | javascript | canvas | 0.20 | 0.30 | 17.00 | 18.60 |
| 2 | 1,000,000 | rust-wasm | canvas | 0.80 | 1.40 | 19.40 | 21.70 |
| 2 | 100,000 | javascript | webgl2 | 0.20 | 0.30 | 17.00 | 18.70 |
| 2 | 100,000 | rust-wasm | webgl2 | 0.70 | 0.90 | 19.70 | 22.00 |
| 2 | 100,000 | javascript | canvas | 0.30 | 0.40 | 16.90 | 22.40 |
| 2 | 100,000 | rust-wasm | canvas | 0.80 | 1.40 | 19.40 | 25.30 |
| 2 | 10,000 | javascript | webgl2 | 0.20 | 0.30 | 16.70 | 22.90 |
| 2 | 10,000 | rust-wasm | webgl2 | 0.70 | 0.80 | 18.50 | 24.30 |
| 2 | 10,000 | javascript | canvas | 0.20 | 0.30 | 15.80 | 22.50 |
| 2 | 10,000 | rust-wasm | canvas | 0.90 | 1.40 | 18.60 | 24.60 |
| 3 | 100,000 | javascript | canvas | 0.10 | 0.30 | 16.80 | 23.60 |
| 3 | 100,000 | rust-wasm | canvas | 0.70 | 1.20 | 17.40 | 25.70 |
| 3 | 100,000 | javascript | webgl2 | 0.30 | 0.40 | 16.80 | 24.10 |
| 3 | 100,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 16.80 | 25.60 |
| 3 | 10,000 | javascript | canvas | 0.20 | 0.40 | 16.70 | 24.80 |
| 3 | 10,000 | rust-wasm | canvas | 0.70 | 1.30 | 18.30 | 26.60 |
| 3 | 10,000 | javascript | webgl2 | 0.30 | 0.40 | 16.70 | 22.90 |
| 3 | 10,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.20 | 25.40 |
| 3 | 1,000,000 | javascript | canvas | 0.20 | 0.20 | 16.00 | 23.20 |
| 3 | 1,000,000 | rust-wasm | canvas | 0.70 | 1.30 | 18.60 | 25.30 |
| 3 | 1,000,000 | javascript | webgl2 | 0.20 | 0.30 | 16.80 | 23.40 |
| 3 | 1,000,000 | rust-wasm | webgl2 | 0.80 | 1.00 | 18.90 | 24.70 |

Completion differs by architecture: JavaScript is synchronous scene plus renderer submission; Rust is Worker RPC plus packet decode and renderer submission. See the JSON report for fetch/compile/actor initialization, transport, stream, parameter-update, memory, long-task, order, and resource-lifetime evidence.
