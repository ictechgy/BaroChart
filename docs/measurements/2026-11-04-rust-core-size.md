# Rust M1 scaffold size measurement — 2026-11-04

Source/profile identity and every artifact SHA are in [`rust-core-size.json`](rust-core-size.json). The measured frozen source commit is `d5b43f1da824fe83657577f06954d7daaca40669`, and the exact linked source-set hash is `e8b92a683714910821b4f52488f858dad22d633d08615ccca0197ad173fbd4ae`. All artifacts were rebuilt offline in isolated `artifacts/rust-size` directories; historic Task 7/8 outputs were not reused because they had no durable build-time source/profile hash.

## Android linked `.so` bytes

| ABI | Rust profile | JS-only | Rust-only | dual | linked Rust delta (`dual - JS`) | budget remaining |
|---|---|---:|---:|---:|---:|---:|
| arm64-v8a | `s`, unwind (shipping) | 1,055,616 | 1,429,688 | 2,468,536 | 1,412,920 | 677,192 |
| arm64-v8a | `3`, unwind | 1,055,616 | 1,344,360 | 2,383,256 | 1,327,640 | 762,472 |
| arm64-v8a | `s`, abort (comparison only) | 1,055,616 | 1,413,544 | 2,452,408 | 1,396,792 | 693,320 |
| arm64-v8a | `3`, abort (comparison only) | 1,055,616 | 1,332,568 | 2,371,480 | 1,315,864 | 774,248 |
| x86_64 | `s`, unwind (shipping) | 1,115,400 | 1,448,144 | 2,550,016 | 1,434,616 | 595,712 |
| x86_64 | `3`, unwind | 1,115,400 | 1,382,336 | 2,484,304 | 1,368,904 | 661,424 |
| x86_64 | `s`, abort (comparison only) | 1,115,400 | 1,432,304 | 2,534,192 | 1,418,792 | 611,536 |
| x86_64 | `3`, abort (comparison only) | 1,115,400 | 1,371,968 | 2,473,936 | 1,358,536 | 671,792 |

All sixteen Rust-linked Android artifacts and both JS baselines had 16 KiB PT_LOAD alignment. The shipping `s`/unwind scaffold is below the 3,145,728-byte ABI budget on both ABIs. `panic=abort` is not shippable because it defeats the required `catch_unwind` poison boundary; its rows are size comparisons only. On this scaffold, opt-level `3` happened to link smaller than `s`; this is an observed result, not a future-code rule.

## iOS link contribution

An unsigned arm64 iOS 15 minimum executable was linked twice with identical `-Os -dead_strip` flags:

| Binary | File bytes | `__TEXT` bytes |
|---|---:|---:|
| empty baseline | 32,944 | 32,768 |
| creates a Rust engine and calls `nativeInit` through the FFI | 542,608 | 393,216 |
| delta | **509,664** | **360,448** |

The Rust static archive itself was 19,064,888 bytes, demonstrating why archive size is not app contribution. This is a link-only executable delta, not a signed IPA, install-size, App Store thinning, or system-framework measurement.

## Full-port scenarios, not bounds

The authoritative scope is a reader estimate of about 37,850 Rust physical lines: 27,850 stable-surface lines plus Tier A net-new ≈10,000. It is not a measured implementation size.

- Using the measured scaffold contribution as the actual current point and the design's 2.5 MiB Rust contribution as an independent scenario gives dual totals of 3,677,056 bytes (arm64, 531,328 over budget) and 3,736,840 bytes (x86_64, 591,112 over budget).
- The 2.5 MiB scenario is neither an upper bound nor a probability interval; a complete implementation may be smaller or larger.
- The old Task 9 bytes/LOC calculation is retained only as a labeled naive diagnostic. It divides the linked scaffold delta by the 4,572 physical `.rs` lines under `src/` in the four linked shipping crates (tests/tools excluded, all cfg branches included), then multiplies by 37,850. It produces implausible dual totals of 12,752,690 and 12,992,088 bytes because fixed std/allocator/FFI overhead dominates the scaffold. It must not be used as a growth law or artifact decision.

The actual scaffold is within budget. The full-port artifact choice remains an owner decision after later milestones provide real linked code, not a conclusion from either scenario.
