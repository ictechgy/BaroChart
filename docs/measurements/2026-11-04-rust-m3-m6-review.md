# Native Rust M3–M6 review — 2026-11-04

Status: confirmed code defects are fixed. The updated source passed 634 Rust
tests, 14 mandatory WASM tests and 101 Swift tests. JavaScript remains the
default while physical-device rollout gates are completed.

The protected GLM review covered 13 explicit code-family packets, 2,184,176
bytes in total. Every offline preview passed with its redactions retained.
All 13 model sessions returned nonempty complete responses, exit 0. Their
starting shipping-source SHA-256 was
`ba35b38d1f2be9a58d94e491668981895ab20eb9365cdd8ef930c15f3ec16f64`.
Each claim was checked against code, authoritative JavaScript and existing
tests by the primary agent and independent local reviewers.

DeepSeek and Qwen were unavailable in this round: the host lacked the protected
MAIN supervisor/helper required by the installed review route. No provider was
launched and no confinement bypass was used. Prior M2 DeepSeek results are
documented in the [M2 review](2026-11-04-rust-m2-review.md).

## Confirmed findings

| Area | Defect | Verification and correction |
| --- | --- | --- |
| UI publication | Reordered series patches could pair one series ID with another series's external values. | Stage patches in live ID order; preserve values pointer, lease, revisions and cache state. Core regression passed. |
| Indicator removal | Missing-ID errors used lossy, unaccounted string conversion. | Use scoped JS ToString and WTF-16 concatenation. Number/null/array/surrogate and quota regressions passed. |
| Series update | `patch.id` could rename a series or duplicate another ID. | Force the original method ID before normalization; preserve values/cache/drawing target. Regression passed. |
| Drawing interaction | Projection-change cancellation lost its default invalidation. | Return cancellation effects. Regression failed with `Drawings`, then passed with `Default`. |
| Correction cache | A negative dirty offset became an unsigned sentinel and retained a stale extreme. | Compute the rebuild threshold in the JS floating-point domain. Regression failed with max 100 instead of 2, then passed for negative integer, fractional and infinite offsets. |
| Series validation | Primitive options and invalid-field/color combinations had the wrong first error. | Validate the Series record before style normalization; actual-bundle/WASM regression added. |
| Async buffer | A fresh or released source could panic and poison the engine. | Replace the unchecked source assumption with the ordinary stale error; verify unchanged destination and continued engine usability. |
| Async begin | Reply allocation could leave an ingestion fence without an owning capture row. | Publish the row before constructing the variable reply, matching Source. Reply failure retains the capture and lease for explicit release. |
| Params read | Typed reads omitted input/size/formatter owner staleness checks. | Apply complete owner/lease validation and failed-row cleanup. |
| Pending UI import | An import begun before target readiness could not advance or retry. | Retain accounted import state, validate chunks immediately and finish after readiness. |
| UI import finish | A failed finish consumed state and a retry could panic. | Validate serial at begin and preserve finish ownership until successful publication; retain Source retry and partial-chunk behavior. |

The runtime/UI checks include same-End retries, direct-Finish recovery, host
setup failure, publication ownership and the actual Source End/Finish error
phase. The source strings and series-ID behavior also have a direct Node/WASM differential
test in [rust-api-regressions.test.mjs](../../test/rust-api-regressions.test.mjs).

## Refuted and shared behavior

The review did not verify defects in timezone Unicode admission, fixed-size
memory-stat scratch, theme-font merging, canonical numeric key ordering,
scene color defaults, packet error ordering, detached study snapshots, removed
panel transaction guards, Swift typed-transfer forwarding, Rust error-code
sentinels, unchanged ingestion receipts, workspace capacity limits or frame-cache
failure effects. Their upstream validation or Source-defined behavior resolves
the reported premise.

Checkpoint depth counting and some forged snapshot metadata constraints are
shared with the authoritative JavaScript. The supported checkpoint schemas and
normal capture pipeline maintain their stronger invariants. A crafted low-level
`dirtyFrom: NaN` can retain a stale cache in both backends; changing that protocol
requires a joint JavaScript/Rust contract revision. The native-only negative
offset difference was corrected without changing the reference bundle.

## Rollout evidence

The pre-review baseline passed 615 Rust tests, 13 mandatory WASM tests including
real panic recovery, 5,966 Node tests and 101 Swift tests. The restored M2 JNI
ingestion regression passed on the owned Android emulator. These are baseline
results. The updated shipping-source SHA-256 is
`67512c06b9c639de4e284a3d61bd345779b5d4c3da2818a8244899a1f81fc583`.
Fresh four-slice Apple artifacts and the complete size matrix were rebuilt
from that source. The final Node suite passed 5,967 tests without skips; dual
shared Android suites passed 65 tests per backend. JS-only/Rust-only availability,
R8 and 16 KiB checks passed, with configuration-specific skips recorded.
[Physical iPhone XR A/B](2026-11-05-native-rust-ios-ab.md) passed both performance
budgets in Release. Device soak and manual acceptance are tracked separately.

The owner retained the dual artifact and approved a 5 MiB per-ABI SDK budget;
startup 500 ms and pan 16.7 ms thresholds are unchanged. See the
[size report](2026-11-04-rust-core-size.md). Real-device performance, soak and
manual accessibility acceptance remain separate platform gates.
