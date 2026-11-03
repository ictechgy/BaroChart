# Rust M1b external review — 2026-11-04

GLM 9건과 DeepSeek 9건의 비어 있지 않은 답변을 현재 코드·회귀 테스트로 판정했다. GLM은 provider만 확인됐고 실제 model ID는 노출되지 않았다. DeepSeek receipt는 `deepseek-v4-pro`다. Qwen은 첫 보호 실행기의 로컬 setup이 실패해 모델이 시작되지 않았으며 답변도 없다. 나머지 Qwen 패킷은 시도하지 않았고 인증·격리 설정을 바꾸지 않았다.

선택한 52개 파일은 immutable `397ed63...171c525` diff이며 rebase 뒤 `cd4c9f3`와 byte-equal이었다. GLM 패킷 03의 phone-pattern 1건, 05의 secret-value-pattern 3건 redaction은 그대로 유지했다. 보호된 `packet-ask-safe`와 기존 safecode pure 경로를 사용했으며 답변은 실행하지 않는 검토 자료로만 취급했다. 원본/질문/receipt/SHA는 로컬 `barochart-reviews/m1b/codex-20261104/`에 보존한다.

## 최종 조치

| 항목 | 조치와 근거 |
| --- | --- |
| A1 SwiftPM 경로 | env unset만 JS-only다. 설정한 경로는 symlink를 해석한 패키지 내부 실존 XCFramework directory여야 하며 누락·외부·잘못된 형식이면 명확히 실패한다. 실제 manifest subprocess 4개가 통과했다. |
| A2 BUSY | transient busy를 기존 host `.busy`/`.unavailable`로 바꾸고 CLOSED/POISONED의 engineClosed를 유지했다. 잘못된 분류를 RED로 재현한 뒤 status adapter 및 전체 Rust-enabled Swift82개가 통과했다. |
| A3 독립 시나리오 | measured가 prior보다 커도 독립 2.5MiB 시나리오를 바꾸지 않는다. 직접 반례 회귀를 추가했다. 실제 측정 행의 값은 변하지 않았다. |
| A4/A5 M2 의존·typed kind | store `apply_data_event`는 Task2 통합으로 옮기고 Node22가 제공하지 않는 Float16 fixture를 요구하지 않는다. 다른 플랫폼의 실제 지원은 별도 metadata/검사 대상이다. |
| A6 LOC 분모 | 0·음수·비정수·비유한 line count를 명시적으로 거절해 진단 필드가 JSON null로 바뀌지 않게 했다. |
| 추가 Root 계획 점검 | nativeInit 반환은 무조건0이 아닌 실제 store.length이며 실제 data leaf 파일명과 계획을 맞췄다. |

수정 후 전체 Node **5953/5953(skip0)**, manifest **4/4**, Swift JS **67/67**·Rust **82/82** 및 두 release 경고0를 확인했다. Native Rust85/WASM4/C ABI/Android 기존 통과는 변경되지 않은 입력의 증거를 재사용한다. 새 SwiftPM/Swift 실행 증거는 M1b 통합 보고서와 로컬 `artifacts/task6-parent/`에 있다. M1b scaffold를 chart parity나 속도 비교로 해석하지 않는다.

다음은 수정 전 소스 `581860f`에 대한 상세 판정과 현 범위의 잔여 의무다. A1–A6의 역사적 발견은 위 조치로 해소됐다.

## Confirmed actionable findings

| ID | Source | Severity | Verdict and evidence | Minimum remediation |
| --- | --- | --- | --- | --- |
| A1 | GLM/DeepSeek 03, GLM/DeepSeek 05 | P2 reliability/tests | **Confirmed.** `Package.swift:5-13` silently omits Rust when `BAROCHART_RUST_XCFRAMEWORK` is set to a missing path. A real framework copied outside the package root fails `swift package dump-package` with `path expected to be relative to package root`; the missing path succeeds with no `BaroChartCoreRust` target. This can turn an intended Rust validation run into JS-only or make the advertised local path unusable. Evidence: `artifacts/task6-parent/adjudication-package-{external,missing}.*`. | Resolve symlinks, require the supplied path to exist and be a descendant of the package root, and fail the manifest with an actionable message otherwise. Add subprocess tests for valid in-tree, missing, and external paths. |
| A2 | GLM/DeepSeek 03 | P2 correctness/reliability | **Confirmed, currently latent.** `native/BaroChartRustCoreRuntime.swift:333-351` maps `BC_BUSY`, `BC_CLOSED`, and `BC_POISONED` to the same `Error: Chart disposed`, so BUSY becomes typed `engineClosed`. Android maps status 5 to `Rust core busy` and design §4.4 defines BUSY as a reentry/concurrency error. The release scaffold's `nativeInit` cannot currently trigger it, but the adapter would misclassify the first callback-backed operation. | Map `BC_BUSY` to the stable busy/unavailable host error separately; retain disposed mapping only for CLOSED/POISONED. Add a focused adapter-status test or debug reentry integration test. |
| A3 | DeepSeek/GLM 08 | P2 correctness | **Confirmed.** `scripts/rust/measure-size.mjs:37-49` labels the design prior as an independent 2.5 MiB scenario but replaces it with `max(measured, prior)`. A direct probe with a 4,000,000-byte measured delta reports the design prior as 4,000,000, erasing the independent scenario. | Store `designPriorScenario` exactly as `designPriorRustBytes`; report measured and design-prior scenarios independently. Add a test where measured exceeds the prior. |
| A4 | GLM 09, DeepSeek 09 | P2 plan/integration | **Confirmed.** `docs/superpowers/plans/2026-11-02-rust-core-m2.md:113-117` declares markets a Task-0-only independent lane while assigning `apply_data_event`, which requires Task-2 `BarStore`/`DataEvent`. The markets worker had to defer this exact function. | Move `apply_data_event` to Task 2 or make it an explicit post-Task-2 markets integration step. |
| A5 | GLM 09 | P3 plan/tests | **Confirmed.** M2 Task 2 requires a `Float16Array` fixture, but pinned Node 22 reports `typeof Float16Array === "undefined"`; no current JS oracle value can be extracted. | Record the measured unsupported result and omit/reject Float16 explicitly until the pinned oracle exposes it. Do not fabricate a conversion fixture. |
| A6 | DeepSeek 08 | P3 diagnostics | **Confirmed hardening.** `naiveLocDiagnostic` divides by zero when no source lines are found; JSON serialization turns Infinity/NaN fields into `null`, and `validateReport` does not reject them. Direct probe reproduced the null report fields. | Reject a zero/nonfinite line count and validate all diagnostic numbers as finite. |

## Deferred integration obligations, not M1b defects

| IDs | Source | Disposition |
| --- | --- | --- |
| D1 | GLM 01/04, DeepSeek 04: `bc_write_f64`, Android packet/indicator args | **M6 typed transport.** M1b deliberately supports only `nativeInit`; all named typed/packet operations return `BC_UNAVAILABLE`. Before enabling them, `bc_write_f64` must consume the input slice and Android must forward packet/indicator arguments. M1c independently confirmed the minimum Swift read/write overrides and real target write seam. |
| D2 | GLM 04: `rust_memory` f64 capacity units and parsing | **M6 memory accounting.** Current release scaffold has no live f64 transport; its diagnostic is explicitly a shell counter. When typed buffers ship, element capacity must be converted to bytes and per-engine accounting must replace global debug counters. |
| D3 | Packet 03/architect: Rust F64 trace recording | **M6 trace transport.** Current functions are unavailable; direct F64 recording needs a backend-neutral byte route when enabled. |
| D4 | GLM 06: historical second-level timezone offset | **M2 markets/platform gate.** The M1 WASM probes use modern instants. Full markets vectors must compare Node Intl, Foundation, and java.time at named transitions, including any historical second offsets in scope. |
| D5 | Packet 02 minor coverage gaps | **Later handler coverage.** Native offset callback and allocation-failure packet paths become material when real functions use them. Current debug/WASM probes prove callback and allocation mechanics; no chart parity is claimed. |

## Rejected or already-resolved findings

### Packet 02 — ABI contract tests

- DeepSeek 02-1/7/8 and GLM 02-3/7 were packet-omission questions, not defects; the implementation, kernel sources, cbindgen tools, workspace edition 2024, and release gates were reviewed elsewhere and pass.
- GLM 02-1 float-pattern compilation is false: the cited test destructures values; Rust 1.98 CI and 85 workspace tests compile and pass.
- GLM 02-2 platform number differences are the explicit same-device `NumberDialect` contract (ECMA on Apple/V8, QuickJS on Android), not a shared-global-golden defect.
- DeepSeek 02-2/5 and GLM 02-4 status precedence are intentional and documented in the M1 plan: stale → busy → name UTF-8 → poison → flags/remaining input.
- DeepSeek 02-3 `bc_supports` is explicitly static capability metadata, not a health check.
- DeepSeek 02-4 and GLM 02-8 error bodies are documented: propagated THROW/UNAVAILABLE includes `code`; CLOSED/POISONED uses the fixed disposed body.
- DeepSeek 02-6 passes a forged but non-live output value; the safety precondition forbids a live owned buffer, and the function canonically overwrites the slot before use.
- DeepSeek 02-9 is false: `c-smoke.mjs` passes the committed header directory with `-I` and compiles/links/runs it.

### Packet 03 — iOS runtime

- `javaScriptContext` precondition failure is the approved O1 contract: only public raw context is unavailable; value-only contexts support returned JSValue APIs. Traced Rust returned/thrown paths pass end-to-end tests.
- `evaluateBundle` returning nil is intentional for Rust: no JS bundle is evaluated, and subsequent unported calls fail unavailable. It does not silently create chart state.
- Callback buffers are wrapped by Rust `OwnedBuf` and freed on every callback result path. `bc_engine_new` does not call timezone callbacks.
- End-to-end unavailable classification is covered by Rust engine `fit`/raw call tests; Rust-enabled Swift suite executes 80 tests, proving `canImport` did not compile them out.
- NSNumber conversion follows JavaScript Number semantics; BCJSON lossless means JS numeric kinds/signed zero/nonfinite values, not arbitrary Int64 precision beyond 2^53.
- The parser consumes Rust-generated BCJSON, whose number writer is strict; accepting an impossible `+5` output is not an external-input boundary.
- `traced` visibility widening is necessary for the Rust factory and creates one wrapper per factory path; no duplicate wrapper call exists.
- `UnavailableError` is absent from the current JS bundle and is the reserved cross-backend unavailable name.

### Packet 04 — Android runtime

- The timezone cache is synchronized in `BaroChartEngine.timezone`; the claimed concurrent LinkedHashMap corruption omitted that block.
- `bc_engine_new` copies `BcHost` by value; the stack table does not dangle.
- The Java engine enforces owner-thread use/close. FFI concurrent-free safety also keeps the host context alive through the final Arc lease; the wrapper does not currently free during an active callback.
- `rust_failure` is entered before JNI result allocations on failure paths; no concrete pending-exception path was shown.
- BuildConfig/CMake/Gradle propagation is present and three AAR configurations plus runtime tests pass.
- The double epoch range is far outside supported Date milliseconds; exact int64 boundary behavior is not observable through the specified time contract.
- A null bundle is the explicit Rust no-bundle contract.
- `runtimeCreated(0)` is not reached when the native creation call throws a pending JNI exception; Java evaluation completes abruptly before tracing.
- Current fixed error envelopes preserve disposed classification; BUSY semantics are tracked separately as A2.

### Packet 05 — packaging and CI

- Toolchain targets and NDK/CMake 29/3.22 are pinned and explicitly installed. Node setup precedes use in all native jobs. Latest PR run `41685905739` passed all five jobs after macOS rustup proxy fixes.
- `rustup toolchain install` without an argument reads the repository `rust-toolchain.toml`; two observed macOS failures were path/proxy dispatch issues and were fixed with `rustup which` links.
- CMake include paths are based on `CMAKE_CURRENT_LIST_DIR`; build staging does not change them.
- JS-only/Rust-only conditional tests intentionally use JUnit assumptions; actual matrices passed.
- Missing Intel iOS-simulator slice is an unstated platform limitation, not a failure on the supported arm64 Apple runner. It should be documented if Intel simulator support is promised later.
- Package path/missing behavior is the real finding A1; duplicate model reports map there.

### Packet 06 — WASM harness

- `publish.workspace = true` inherits workspace `publish = false`; the harness cannot be published.
- Exact six-export/six-import census passed in both release/debug harness tests under Rust 1.98; linker-generated extra export speculation is false for the built artifact.
- `bc_engine_new` initializes output slots to canonical zero before every failure and the harness validates this contract.
- Math functions are installed in `bc_engine_new` before any Engine is published/called. Missing initialization would be an internal invariant trap, not an untrusted ordering path.
- `REQUIRE_WASM=1` intentionally converts a missing target/toolchain from skip to a hard CI failure; the current error includes the failed cargo/rustup prerequisite and CI passes.
- Exact-size WASM buffers require `len == cap` by implementation contract. Memory views are refreshed after growth/calls and allocation/release counts return to baseline.
- The Android emulator script's failure propagation depends on the pinned runner action. All three commands passed; adding explicit `set -e` is optional action hardening, not a proven current defect.

### Packet 07 — conformance diagnostics

- The startup probe is the minimized causal Node 26.5 reproduction, not a claim to detect every possible JSON engine bug. Corpus generation does not run `JSON.parse`, so the preflight's placement after `--emit-corpus` cannot taint emitted tasks.
- Conformance tasks are generated plain JSON data, so circular/BigInt diagnostic serialization is unreachable.
- Executable hashes are required evidence after the original runtime-identity gap; inability to read them should fail rather than silently downgrade identity.
- First-V8-JSON mismatch capture and same-process replay are bounded diagnostics only and never change the verdict. The report/document explains the replay's process state.
- The standalone fixture and CLI both reject the observed U+D800→U+005C change; minor predicate differences do not admit the known failure.

### Packet 08 — size measurement

- LTO fat/codegen-units 1 are pinned in the hashed workspace Cargo.toml. The four linked shipping crates currently have no build.rs and no `.cargo/config`; the source hash covers every current linked input plus Android C/CMake/QuickJS sources. Adding such a build input requires extending provenance.
- Recorded rustc matches the pinned compiler in both root and rust workspace on this host; four profile sizes differ as expected.
- Source-hash freshness failure is intentional: any linked-input change invalidates a measurement and requires remeasurement.
- The tool is intentionally macOS-only because one complete durable report requires both Android and iOS; all tool versions are configurable CLI inputs.
- Designated C initializers and stronger report/privacy schema checks are optional hardening. A3/A6 are the confirmed computation issues.

### Packet 09 — M1/M2 plans

- Raw `BcBuf` allocator provenance and unique free are an unsafe C caller contract, not a same-process security capability. Arbitrary C pointer misuse cannot be made generally safe by an ID registry.
- Test probes are debug-only; all distributed native artifacts use release, and release WASM proves probe names unavailable.
- Deferred host release is bounded by the admitted call's Arc lease. A call that never returns necessarily retains its call-owned resources; no orphaned registry entry is created.
- Engine creation rolls back before ownership is armed on failure. Registry insertion is the final nonfallible publication step.
- Concurrent free is serialized by registry removal; only one thread obtains the Arc, and release happens after the lock and last lease.
- Exactly 100 initial globals is an authoritative measured oracle fact in Tier-A §2.1, not an arbitrary target. A future bundle change must regenerate the manifest with source metadata.
- Position metrics are pure anchor arithmetic; geometry/layout is explicitly deferred.
- `$asterNumber` exactly matches `src/core/checkpoint-validation.mjs`.
- Admitted calls freed mid-call complete with their normal status/output under the documented lease model; caller still frees any returned buffer.
- `supports` changes in A0 are an intentional milestone evolution from the M1 one-function scaffold.
- A4/A5 are the confirmed planning defects.

## Gate disposition

위 A1–A6은 회귀 검증과 계획 수정으로 해소됐다. 최종 exact-head CI5 성공을 확인한 뒤 PR29를 ready/merge한다. 이 문서는 공개 바이너리·registry/tag 배포를 승인하지 않는다.

Residual obligations remain explicit: typed F64/packet arguments and direct-copy/trace routes before their handlers are enabled (M3 indicator, M4 scene/workspace, M6 async), per-engine memory accounting, WASM panic/EH poison, Intel simulator packaging if promised, complete native function/chart conformance, physical chart performance, and public artifact distribution.
