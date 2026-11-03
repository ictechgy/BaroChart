# BaroChart Rust core porting map — tier A (advanced and low-level surface)

- Date: 2026-11-02
- Companion to the main map `2026-11-02-rust-core-porting-map.md`, cited below as "map §x". This document does not repeat what the main map already specifies correctly. It adds the tier-A surface that the owner moved into scope, and §6 lists what the main map got wrong.
- **Oracle:** the pre-M0 bundle at commit `11b467b` of `/Users/jinhongan/BaroChart-review-20261023`: `native/Resources/aster-core.js`, sha256 `c8fd7ae56c8eaf8bca40aec63434c214ead77d98d33041a7ee53ba4e46203e30`, 588,726 UTF-8 bytes (588,614 UTF-16 units). The worktree `/Users/jinhongan/BaroChart-rust-m1a` has the identical bundle and identical `src/`, `examples/` and `native/` trees (checked with `git diff 11b467b HEAD`). **Every `src/core`, bridge and host line reference below is a line of commit `11b467b`.**
- **Moving oracle.** The review directory is the working checkout of branch `feat/rust-m0a-oracle-normalization`. While this document was compiled it gained `f5c4dc8` (M0 Task 1, record key order; bundle sha256 `e818b1f5…`, 600,362 B) and `3c613ce` (M0 Task 2, time-zone contract; bundle `4b193274…`, 609,309 B). M0 Task 3 (D2 and the params publish fix) had not landed at 13:16 KST. Some readers measured from that directory after 12:28 KST; goldens that depend on M0 name their bundle. Tier-A sources that M0 has not touched: `async-state.mjs`, `async-ui.mjs`, `prepare-state.mjs`, `ingestion.mjs`, `data-explorer.mjs`, `compaction.mjs`, `native-checkpoints.mjs`, `native-params-import.mjs`, `native-params-target.mjs` and all `examples/native/*.mjs`. Changed by M0a: `contracts`, `drawing-validation`, `drawings`, `drawing-translation`, `drawing-style-patch`, `model`, `api`, `markets`, `indicators`, `interaction`, `workspace`, `native-params-source`, `native-workspace-target`, `bar-replay`.
- **Inputs:** twelve reader reports: async data jobs, indicator-params jobs, ingestion queue, exploration, advanced `nativeCommand` ops, public low-level surface, custom-indicator rejection, legacy/benchmark/demo globals, resource limits, lifetime and poison, M0 normalization, `nativeIndicatorBuffer`. Where readers disagreed, the source was re-read and the statement is marked **(checked)**.
- **Measurements:** node v22.20.0 `node:vm` on the oracle; the vendored QuickJS 2026-06-04 built into a host that mimics `aster_jni.c`; macOS 26.7.2 JavaScriptCore. Probe scripts are in `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/tier-a-<group>/` (session scratch; copy them into the test tree before it is cleaned). Groups: `async-data`, `params-async`, `ingestion-queue`, `exploration`, `advanced-ops`, `public-low-level-surface`, `custom-reject`, `legacy`, `resource-limits`, `lifetime-poison`, `m0-normalization`, `indicator-buffer`.

## Contents

1. Purpose and relation to the main map
2. Definitive scope
3. Protocols and areas
   - 3.0 Shared two-runtime machinery
   - 3.1 Async data jobs (correction, columns, seeded)
   - 3.2 Indicator-params jobs
   - 3.3 Ingestion queue, unchanged batch, release
   - 3.4 Data exploration (`dataAt`, `nativeDataExploration`)
   - 3.5 Tier-A `nativeCommand` ops not fully covered by the main map, and `pressure`
   - 3.6 Public low-level surface (census, transports, legacy, benchmark, `nativeIndicatorBuffer`)
   - 3.7 Custom JS indicator rejection contract
   - 3.8 Engine lifetime, CLOSED and POISONED
   - 3.9 Engine resource limits and the JNI layer
   - 3.10 Interaction with M0 normalization
4. Error catalog for this surface
5. Port order with differential checkpoints
6. Corrections to the main map (and to the design and plans)
7. Rust size estimate and top risks

---

## 1. Purpose and relation to the main map

### 1.1 The decision this document implements

On 2026-11-02 the owner decided (design §2 row 1) that the Rust backend reaches **full parity with every low-level API**: the async job protocols, the ingestion queue, data exploration and compaction, plus all 65 `nativeCommand` ops. Only custom JS indicators stay JS-only:
- `nativeRegisterIndicatorSource`, because it evaluates host JS with `Function` (`api.mjs:247-251`);
- build-time custom indicator modules (S:17-19 `modulePaths`).

The linked study `aster.volume-direction@1/pressure` is ported (D10, design §5.1).

Rust implements the same bridge global names, with the same arguments and the same results. Everything that main-map §1.4 put in tier J because it was "experimental" or "low-level" is now tier A. §2 is the definitive list. It supersedes map §1.4 and design §5.3; design §5.3 itself says the final list is fixed by this document.

### 1.2 Envelope-compatible async protocols

The Swift and Java job classes stay unchanged (design §4.6). Rust implements each two-runtime protocol **envelope-compatible**:
1. Every field that `native/BaroChartEngine.swift`, `BaroChartEngine.java`, `ParamsUpdateJob.java`, `WorkspaceRestoreJob.java` or `aster_jni.c` reads must match the JS core exactly: names, JS types, ranges, strings, and the error `(name, message, code)`. The order in which hosts call the functions is fixed by the hosts and must be accepted as is.
2. A payload that hosts only carry from a source runtime to a target runtime may use a Rust-internal format, because source and target always use the same backend.
3. Exception to rule 2: when an internal payload determines a **host-visible number** (a progress total, a byte plan admitted against the process budget, a metric, or a limit that fails a begin call), Rust must reproduce that number. In practice this means keeping the JS layout of the async snapshot buffer list and metadata value tree, the params checkpoint record texts, and the async UI chunker. The tables in §3 mark each payload *host-checked*, *host-visible number* or *internal*.

### 1.3 What the main map already covers

This document assumes: map §0 (conventions, error classes, tiers), §1.1 (execution model, shared ticket counter), §1.3.1 (dispatch), §3.1 (JS compatibility layer), §3.3 (checkpoint codec), §3.4.2, §3.4.6, §3.4.8, §3.4.10 (bar validation, setData/prepend, batch transaction, seeded columns, compaction core), §3.6 (ingestion snapshot, lease/fence, policy, save/restore), §3.7.6-3.7.12 (indicator engine, laziness, `calculate`, params validation, extreme-data throws), §3.8 (native checkpoint containers and the checkpoint-state validator), §3.9 (model, view state machine, series cache, layout), §3.10 (drawings and group edits), §3.11.6-3.11.8 (snap, frame caches, packet), §3.12 (interaction), §3.13 (facade, study setup, host notification rules), §3.14 (workspace document, preflight), §3.15 (restore pipeline, including the `PreparedData` target phases shared with prepare jobs), §3.16 (bridge details), §4 (errors), §5 (numeric rules), §6 (platform seams). Corrections to those sections are in §6.

### 1.4 Conventions

Inherited from map §0: path shorthands B, P, E, T, N, K, S; error classes; tier tags (A implement, J JS-only, T test/demo, X unreachable). Added shorthands:

| Tag | File |
|---|---|
| AS | `src/core/async-state.mjs` |
| AU | `src/core/async-ui.mjs` |
| PS | `src/core/prepare-state.mjs` |
| NPS, NPT, NPI | `src/core/native-params-source.mjs`, `native-params-target.mjs`, `native-params-import.mjs` |
| NWS, NWT | `src/core/native-workspace-source.mjs`, `native-workspace-target.mjs` |
| NC | `src/core/native-checkpoints.mjs` |
| DX | `src/core/data-explorer.mjs` |
| SW | `native/BaroChartEngine.swift` |
| JV | `native/android/java/kr/coden/barochart/BaroChartEngine.java` |
| JNI | `native/android/aster_jni.c` |

"Reach" columns use A (reachable from a host or JSON input), X (unreachable natively; keep the message only) and J (JS-only). Strings are quoted verbatim. Messages with a placeholder show it as `<…>`.

---

## 2. Definitive scope

### 2.1 Census of the bridge globals

The oracle defines exactly 100 `native*` function globals before `nativeInit` (measured; `nativeModel`, `nativeAPI`, `nativeInput` and `nativeSize` appear only after `nativeInit`).

| Group | Count | Rust |
|---|---|---|
| Called by shipped SDK code (Swift, Java, JNI) | 66 | implement 65; `nativeRegisterIndicatorSource` → `UnavailableError` |
| `nativeAccessibility` (called by `nativeAccessibilityText` B:102 and by runners) | 1 | implement |
| Legacy helpers | 15 | implement |
| Benchmark helpers | 2 | implement |
| Self-tests | 6 | not ported |
| Demos | 5 | not ported |
| Test-only lifecycle | 5 | not ported |
| **Total** | **100** | 83 implemented, 1 `UnavailableError`, 16 not ported |

`nativeWheel` is the only legacy name the SDK mentions; `BaroChartUIView.swift:218` compares the name and never calls it.

### 2.2 Must implement: bridge globals

| Globals | Area | Host callers | Spec |
|---|---|---|---|
| The 29 globals of map §1.2 (`nativeInit` … `nativeAsyncStep`: 28 SDK-called plus `nativeAccessibility`) | stable, view, restore | map §1.2 | map §3.15-3.16; async and params branches in §3.0 |
| `nativeAccessibility` (also a public global, not only a helper) | view helper | B:102; runners (`StudyVerification.java`, `mobileux/MobileUXInstrumentation.java`, `study-verification.swift`, `benchmarks/cycle10/*`, `cycle11-native-readout.swift`) | map §3.16.4 |
| `nativeDataIngestionCommand` | ingestion | SW:1622-1628, JV:217-220 (decoder JV:165-168) | §3.3 |
| `nativeApplyUnchangedDataEvents` | ingestion | SW:1716-1742 (from `applyDataEvents(_:skipUnchanged:true)` :1699), JV:339-353 | §3.3.6 |
| `nativeReleaseDataIngestion` (already in map §1.2) | ingestion | SW:1592 only | §3.3.7 |
| `nativeDataExploration` | exploration | SW:1814-1838 (public :1840-1846), JV:525-531 (public :539-560) | §3.4 |
| `nativePreflightWorkspace` | workspace | SW:1889-1891, JV:664-667 | map §3.14.6, §3.7 |
| `nativeIndicatorBuffer` | indicators | JNI:112-116 ← JV:276 `indicatorBytes` ← Android runners (**checked**: `IngestionVerification.java:54`, `PrepareVerification.java:24-25,32`, `AsyncVerification.java:71,116`, `cycle12/IngestionFeed.java:117,127`, `cycle13/ScenePressureFeed.java:125,135`, all in package `kr.coden.barochart`); iOS runners through `call()` (`examples/native/ingestion-verification.swift:44,164`, `examples/ios/cycle12/IngestionFeed.swift:96`) | §3.6.4 |
| `nativeAsyncBegin`, `nativePrepareBegin`, `nativeDataAsyncBegin`, `nativeAsyncCheck`, `nativeAsyncCheckpoint`, `nativeAsyncUIBegin`, `nativeAsyncUINext`, `nativeAsyncUICheck`, `nativeAsyncRelease`, plus the async branch of `nativeAsyncBuffer` | async source | SW:258, 275, 560, 581, 605, 617, 638, 644, 1558; JV:1131, 1133, 1147, 1154, 1161, 1168, 1199 | §3.1 |
| `nativeAsyncCreate`, `nativePrepareCreate`, `nativeAsyncCheckpointImport`, `nativeAsyncUIImportBegin`, `nativeAsyncUIImportChunk`, `nativeAsyncUIImportEnd`, `nativeAsyncFinish`, plus the async/prepare branches of `nativeAsyncTargetBuffer`, `nativeAsyncStart`, `nativeAsyncStep` | async target | SW:528, 543, 565, 584, 589, 593, 611, 624, 628, 639; JV:1170-1199 | §3.1 |
| `nativeParamsSourceBegin`, `…Step`, `…Check`, `…Receive`, `…ArmWrite`, `…Checkpoint`, `…Validate`, `…Prepare`, `…Publish`, `…Status`, `…Abort`, plus the params branches of `nativeAsyncBuffer` and `nativeAsyncTargetBuffer` | params source | SW:1008, 1010, 1157, 1175, 1185, 1232, 1268, 1278, 1280, 1291, 1296, 1308, 1319; JV:1054-1074 | §3.2 |
| `nativeParamsTargetCreate`, `…Start`, `…Step`, `…Descriptor`, `…Checkpoint`, plus the params-target branches of `nativeAsyncBuffer`/`nativeAsyncTargetBuffer` | params target | SW:1225, 1237, 1244, 1247, 1256, 1274, 1289; JV:1059-1065 | §3.2 |
| `nativeEcho`, `nativeIndicator`, `nativeView`, `nativeFit`, `nativeAddPanel`, `nativeSetPanel`, `nativeAddSeries`, `nativeRemoveSeries`, `nativeTheme`, `nativeInspect`, `nativeTool`, `nativeWheel`, `nativeLoad`, `nativeSetData`, `nativeDataEvent` | legacy | runners only | §3.6.2 |
| `nativeBenchmarkEvent`, `nativeBenchmarkDigest` | benchmark | runners only | §3.6.3 |

Why all legacy helpers are implemented: `nativeIndicator`, `nativeTheme` and `nativeAddSeries` are documented escape hatches (`docs/API-PARITY.md:46,56`, `docs/NATIVE.md:57`, **checked**), and `API-PARITY.md:56` promises that "Swift `call`, Java `invoke` and the existing `native*` functions are kept". Design §5.3 says every documented public low-level API goes into §5.1. The other twelve are one-line delegations to operations Rust needs anyway (the store-level `applyDataEvent` for `nativeDataEvent` is already required by the async target, AS:56), and backend-neutral runners call several of them (`nativeView` from 8 files, `nativeBenchmarkEvent` 8, `nativeBenchmarkDigest` 7, `nativeInspect`, `nativeTool`, `nativeWheel` 2 each, `nativeEcho`, `nativeDataEvent` 1 each). The premise that `nativeSetData`/`nativeDataEvent` "bypass the ingestion fence" is false: the API data commands do not check the fence either (`api.mjs:86`, `api.mjs:100`, **checked**). This reverses design §5.3 for `nativeSetData` and `nativeDataEvent` (§6.6).

### 2.3 Must implement: `nativeCommand` ops

All 65 ops of `api.mjs:65`. The ones the main map does not fully specify, with the section that completes them:

| Ops | Section |
|---|---|
| the 9 ingestion ops (`configureDataIngestion`, `enqueueDataEvents`, `drainDataEvents`, `pauseDataIngestion`, `resumeDataIngestion`, `cancelDataEvents`, `dataIngestionStats`, `saveDataIngestion`, `loadDataIngestion`) and `applyDataEvents` | §3.3 |
| `dataAt` | §3.4 |
| `compactData`, `setColumns`, `addPanel`, `setPanel`, `setPanelOrder`, `removePanel`, `addAxis`, `setAxis`, `removeAxis`, `setDrawingTarget`, `crosshairSnapshot`, `setSeriesValues`, `setIndicatorPlacement`, `indicatorValues`, `registerIndicatorModule`, `saveStudies`, `loadStudies`, `positionMetrics`, `translateDrawings`, `setDrawingsStyle`, `setDrawingVisibility`, `setDrawingsVisibility`, `duplicateDrawing`, `duplicateDrawings`, `deleteDrawing`, `saveDrawings`, `setText`, `pan` | §3.5 |
| linked study `aster.volume-direction@1/pressure` (via `addIndicator`, `setIndicatorParams`, `loadStudies`, restore) | §3.5.15 |

### 2.4 Must implement: host capabilities that are not globals

| Capability | Used by | Spec |
|---|---|---|
| F64 copy out (`bc_read_f64`) | async/workspace/params source reads, params target reads (`nativeAsyncBuffer`), indicator slices (`indicatorSlice`) | §3.0.5, §3.6.4 |
| F64 copy in (`bc_write_f64`) | target writes, the armed params result write, `BaroChartColumns.writeSlice` (JNI:106-111) | §3.0.5 |
| Packet (`bc_packet`) | Android views | map §3.11.8 |
| Empty engine (`bc_engine_new` without `nativeInit`) that accepts the target protocols and rejects live-only globals as JS does | workspace, async, prepare and params targets | §3.6.1 |
| `Send` hand-off of a target engine to the owner thread at publish | SW:639, 779; JV:995, 1207 | §3.0.5 |
| `bc_memory_stats` plus process handle counters shared by both backends | `memoryUsed`, `memoryPeak`, `memoryStats`, `runtimeMetrics()` | §3.9.4 |
| `bc_supports(name)`: true exactly for names in the Rust function table, reject stubs included | SW:1591-1592 (close), `BaroChartFrameRenderer.swift:67` | §3.6.1 |
| Errors as `{name, message, code}`; Android text in WTF-8 through the existing `fail()` | all | §3.9.3 |

### 2.5 `UnavailableError` on Rust

All of these are rejected before any state change. The class is a plain `Error` with `name:'UnavailableError'`.

| Item | Trigger | Exact error | Host callers | Reason |
|---|---|---|---|---|
| `nativeRegisterIndicatorSource` | any call, any arguments, open engine | `UnavailableError: Indicator source registration requires the javaScript backend`, code `JAVASCRIPT_BACKEND_REQUIRED` | SW:1906 `registerIndicatorSource`, JV:630; runners `examples/native/parity.swift:26-28,40`, `async.swift:153`, `prepare.swift:107`, `examples/android/APIVerification.java:58` | needs a JS engine |
| Documents that reference a **linkable** custom indicator module | `loadStudies` (at the `study-setup.mjs:63` position); `readWorkspaceDocument` (at the `workspace.mjs:41` position) inside `nativePreflightWorkspace`, `nativeWorkspaceSourceBegin`, `nativeWorkspaceTargetCreate` | `UnavailableError: Indicator module requires the javaScript backend: <name>`, same code | SW:1895, 1889, 713, 898; JV:676, 664, 977, 989 | module code is not in Rust; §3.7 defines "linkable" |
| Swift raw JS access: `context` | property read | `preconditionFailure` with a clear message (design §4.3) | apps; `Tests/BaroChartTests/EngineMemoryTests.swift:27` | no JS engine |
| Swift `call`/`command`/`addIndicator(_:_:_:)`/`setIndicatorParams(_:_:)` returning `JSValue` | call | open decision O1 (§2.8) | `docs/IOS-GUIDE.md:180`, XCTests | |

Build-time custom modules have no Rust slot at all. `registerIndicatorModule` for such an id gives the same `UnsupportedIndicatorError` that the standard JS bundle gives (§3.5.9); it is not an `UnavailableError`, because a bare id proves nothing about the module and the Kotlin consumer test expects the word `Unsupported` (`examples/kotlin-study-consumer/.../StudyContract.kt:142-147`).

### 2.6 Not ported

| Globals | Why | Callers | Rust response |
|---|---|---|---|
| `nativeSelfTest`, `nativeExtendedSelfTest`, `nativeHardeningSelfTest`, `nativePublicationOrderSelfTest`, `nativeStudyVerification`, `nativeAxesSelfTest` | They test JS internals. `nativeHardeningSelfTest` and `nativePublicationOrderSelfTest` depend on external store listeners and JS object-model defences that Rust does not have. | `examples/native/main.swift:36,43`, `examples/ios/App.swift:175-176`, `examples/ios/mobile-ux/MobileUXApp.swift:181`, `DemoActivity.java:114`, `APIVerification.java:28,71`, `StudyVerification.java:13`, `study-verification.swift:17`, `axis-verification.swift:38`, `cycle12/IngestionFeed.java:120`, `cycle13/ScenePressureFeed.java:128`, `mobileux/MobileUXInstrumentation.java:86` | `UnavailableError: <name> is not available in the Rust backend` (no code) before any state change. Their goldens stay oracles (map Appendix B). |
| `nativeAnalysisDemo`, `nativeAnalysisReload`, `nativeComparisonDemo`, `nativeComparisonReadout`, `nativeComparisonAction` | Scripted demo compositions of public ops; a host can rebuild them from public APIs. | `DemoActivity.java`, `APIVerification.java:29-40`, `StudyVerification.java:28`, `HoverBindingVerification.java:58`, `examples/ios/App.swift`, `examples/native/{main,axis-verification,transaction-verification,study-verification}.swift` | same |
| `nativeAsyncUI`, `nativeWorkspaceSourceBuffer`, `nativeWorkspaceSourceDispose`, `nativeWorkspaceTargetDispose`, `nativeParamsTargetDispose` | Test-only lifecycle; hosts free whole runtimes instead. | `test/native-*.test.mjs`, `test/fixtures` only | same; the WASM harness may expose them as harness-only hooks |

The legacy reader proposed rebuilding the five demos from public ops and writing Rust equivalents of four self-tests (same JSON and side effects). That is optional, not a parity requirement. Runners that use these globals are split or gated with the unavailable-expectation table (design §8.3; §3.7.5).

### 2.7 Names that are not among the 100

The JS backend behaves differently per platform, and Rust keeps that:
- Android: JNI `call` on an undefined global gives `TypeError: not a function` (QuickJS text, measured). The Rust branch of JNI `call` must produce the same string for a name that is not in the Rust table.
- iOS: the host gives `BaroChartLowLevelError.javaScript("Missing function: <name>")` (SW:1430-1431) before calling. On Rust, `callValue` uses `bc_supports` the same way.

The M1 plan's interim miss text `<name> is not available in the Rust backend yet` (`docs/superpowers/plans/2026-11-02-rust-core-m1.md:263`) is M1-only. The final table distinguishes "defined but not ported" (`UnavailableError`, no "yet") from "not defined" (the platform texts above).

### 2.8 Open decisions

| # | Decision | Recommendation |
|---|---|---|
| O1 | Swift `JSValue`-returning APIs on Rust. Design §4.3 and §11 make `call`/`command` throw `.unavailable` and add `callValue`/`commandValue`. That conflicts with `docs/IOS-GUIDE.md:180` (documents `command(_:_:)` as the low-level API), with XCTests (`TypedEngineTests.swift:43,59,69,118`, `TypedEngineCoverageTests.swift:35,161`, `DynamicTypeOwnershipTests.swift:25`) and with design §5.4 ("existing tests run unmodified on both backends"). | Keep `call`/`command` working on Rust by materializing results in one value-only `JSContext` per owner thread (measured ≈0.77 MB RSS per empty context). Build values with `JSON.parse` plus a reviver for NaN, ±Infinity, −0 and `undefined`; never with object literals or `JSValue(object:)` (the latter reorders keys). Only `context` stays unavailable. Either way, every internal SDK use of `context`/`JSValue` must move behind the backend-neutral runtime in M0, including `close()` (SW:1591-1592 reads `context`; on Rust that is a crash). |
| O2 | Preflight of a document that references a linkable custom module. Design §5.2 says preflight reports `requiredBackend: "javaScript"`. | Throw the §2.5 `UnavailableError` from preflight as well. This keeps the map §3.14.6 receipt bytes unchanged and gives one rejection path (Begin calls the same validator first). The alternative receipt shape is in §3.7.4. |
| O3 | `nativeTheme` stores arbitrary JSON values (no validation, B:142). | Implement faithfully with an ordered `Value` map as the theme (§3.6.2). Alternative, owner approval required: accept only string values for the `THEME_KEYS` and reject anything else with `UnavailableError`. |
| O4 | M0 Task 3 converts params-published and restored checkpoint maps to ordinary maps. | Land it; the M0 plan already includes params (`docs/superpowers/plans/2026-11-02-rust-core-m0.md:179-209`, **checked**). Without it, Rust must replicate per-entry ledgers (§3.10.2, about +450 lines). |
| O5 | Deep JSON: QuickJS overflows its 1 MiB stack budget where V8 and JSC parse iteratively, so error classes differ (§3.9.1). | M0c adds the iterative depth check (32) before the three bare `JSON.parse` sites (`drawings.mjs:39`, B:5, B:6), and a host argument check (64, including the outer argument array). Java checks before recursive encoding and JNI checks the actual UTF-8 text; Swift traverses value-bridged host containers without reading existing VM references. |
| O6 | Android `invoke('nativeIndicatorBuffer',…)` returns the index-keyed object `{"0":…}` (JS `JSON.stringify` of a `Float64Array`). Design §4.2 says typed arrays never ride in JSON. | Allow that encoding in standard mode for results that are `Float64Array`s, and in lossless mode use the same index-keyed object with lossless number tokens. |
| O7 | Java strings that name QuickJS: `runtimeMetrics().scope` (JV:275) and `AsyncResult` `memorySampling` (JV:1216). | Choose the text per backend (§3.9.4); values are diagnostics only. |
| O8 | Self-tests and demos. | Not ported (§2.6). Rebuild host-side only if a gating runner needs them. |

---

## 3. Protocols and areas

### 3.0 Shared two-runtime machinery

Async data, prepare, workspace restore and indicator params share per-runtime slots, one ticket counter and the buffer-copy globals. In Rust these become per-engine fields. They are not process-wide: each JS context evaluates the bundle separately.

#### 3.0.1 Per-engine slots

| JS slot | Where | Meaning |
|---|---|---|
| `nativeAsyncTicket` | B:3 | Counter from 0, shared by async, prepare, workspace and params begins |
| `nativeAsyncCapture` `{ticket, capture, ui?}` | B:3, B:5-6, B:52 | async/prepare source (`AsyncCapture` or `PrepareCapture`, plus the UI capture) |
| `nativeWorkspaceSource` row, `nativeWorkspaceRegistration` | B:2, B:40 | workspace source and its high-water mark |
| `nativeParamsSource` row, `nativeParamsRegistration`, `nativeParamsRecords` (≤4) | P:3-4, P:14 | params source, its own high-water mark, and the terminal status table |
| `nativeAsyncPrepared` | B:3 | target: `AsyncPrepared`, `PreparedData` or `NativeWorkspacePrepared` |
| `nativeParamsTarget` | P:3 | params target; stays installed (closed) after a step error |
| `nativeAsyncUIImport`, `nativeAsyncUIPrepared` | B:3 | async UI import in progress, and its finished `{model, ui}` |
| `nativePrepareTargetCreating`, `nativeWorkspaceTargetCreating`, `nativeParamsTargetCreating` | B:15, B:26, P:29 | reentrancy tokens (X) |

`nativeInit` resets none of these. A slot survives `nativeInit` and every staleness error; the next operation then fails its owner check (measured for async captures and params rows).

#### 3.0.2 Busy rules

| Call | Rejects with `Error 'Async capture busy'` / `Error 'Async target busy'` when |
|---|---|
| `nativeAsyncBegin`, `nativePrepareBegin`, `nativeWorkspaceSourceBegin`, `nativeParamsSourceBegin` | `nativeAsyncCapture`, `nativeWorkspaceSource` or `nativeParamsSource` is set (B:5, B:6, B:40, P:12). Params checks its registration token first (P:9, P:12). |
| `nativeAsyncCreate`, `nativePrepareCreate` | `nativeAsyncPrepared`, `nativePrepareTargetCreating`, `nativeWorkspaceTargetCreating`, `nativeParamsTarget` or `nativeParamsTargetCreating` is set (B:15, B:56). The UI-import slots are not checked, and there is no vacancy check: these work in a live runtime. |
| `nativeWorkspaceTargetCreate` | the five slots above plus `nativeAsyncUIImport`/`nativeAsyncUIPrepared`; then the empty-runtime check (B:24-26, map §3.15.3) |
| `nativeParamsTargetCreate` | any of the seven slots, including a closed params target; then the empty-runtime check (P:29) |

#### 3.0.3 Tickets and registrations

| Begin | Ticket consumed | Registration |
|---|---|---|
| async, prepare (B:5-6) | only after the capture succeeds; no overflow check | none; the ticket is the only correlation key |
| workspace (B:40) | at row creation (`++nativeAsyncTicket`), even if the capture constructor then fails | optional; when given it must be a safe integer above the mark, else `RangeError 'Workspace registration must increase'` (also for `0` and `null`); committed before the ticket |
| params (P:11-15) | at row creation, after token → busy → must-increase → ticket-limit checks | mandatory safe integer ≥ 1 (`RangeError 'Params registration'`); committed at row creation; the row is recorded (≤4, oldest evicted) |

After an async or workspace publish the host swaps runtimes, so the engine is the former target runtime: ticket counter 0 (the next begin gets ticket 1, measured), both registration marks 0, no frame caches, latest layout `null`, a fresh `BarStore` serial (D4), and an ingestion session restored at epoch 0. Params jobs keep the source runtime.

#### 3.0.4 Error policy per family

| Family | On error |
|---|---|
| async/prepare source (`nativeCapture`, B:4) | never drops the slot; only `nativeAsyncRelease(ticket)` frees it. A host that loses the begin response before reading the ticket leaks the slot and the lease until the runtime is discarded. |
| workspace source | drops the session (map §3.16.6) |
| params source operations | drop the row with status `'failed'`, except `'Params source ticket missing/released'` (P:6) and `'Params result write not armed'` (P:22) |
| async/prepare target | never disposed; the host abandons the whole runtime |
| params target | only `step()` errors dispose it (NPT:33-39); input-slice, start, descriptor, checkpoint and output-read errors leave it usable |
| workspace target | map §3.15.3 |

#### 3.0.5 Buffer routing and the FFI mapping

`nativeAsyncBuffer(ticket, slot, offset, count)` (B:49), first match wins:
1. `nativeParamsSource?.ticket === ticket` → params source read (§3.2), wrapped in the params operation guard.
2. a params target exists → `ticket` must equal its registration, else `Error 'Params target registration'`; then the params target output read.
3. `nativeWorkspaceSource?.ticket === ticket` → workspace source read (map §3.15.1).
4. otherwise `nativeCapture(ticket).buffer(slot, offset, count)`: async capture read (§3.1.2). A `PrepareCapture` has no `buffer` method: engine `TypeError` (D8). No slot → `Error 'Async stale: source replaced/released'`.

`nativeAsyncTargetBuffer(slot, offset, count)` (B:57):
1. a params source exists → the armed params result write (`nativeParamsWrite`, P:22);
2. a params target exists → params target column input;
3. `nativeAsyncPrepared` exists → its `target()` (async, prepare or workspace);
4. otherwise `Error 'Async target missing'`.

FFI mapping. `nativeAsyncBuffer`, JNI `readBuffer` (JNI:91-96) and Swift `asterTypedBytes` (SW:141-156) map to `bc_read_f64(engine, ticket_or_registration, slot, offset, count)` with exactly the routing above; it must accept `count 0` for the async branch. `nativeAsyncTargetBuffer`, JNI `writeBuffer` (JNI:97-102) and `BaroChartColumns.writeSlice` (JNI:106-111) map to `bc_write_f64(engine, slot, offset, data)` with the same routing. JS advances `received[slot]` when it hands out the view, before the host writes; Rust validates and copies in one step, which is indistinguishable to hosts. The engine is `Send` but not `Sync`: iOS builds and steps a target on a worker, then calls `nativeAsyncFinish` from main (SW:639); Java swaps the handle after the worker thread has died (JV:1207).

#### 3.0.6 Return types at the JSON seam

- JS **strings** (Swift reads them with `toString()`, Android double-encodes them): `nativeAsyncBegin`, `nativePrepareBegin`, `nativeAsyncCheckpoint`, `nativeAsyncUIBegin`, `nativeAsyncUINext`, `nativeAsyncStep`, `nativeParamsTargetDescriptor`, `nativeInspect`, `nativeBenchmarkDigest`, `nativeSelfTest`/`nativeExtendedSelfTest` (not ported).
- **Objects**: `nativeDataAsyncBegin`, all params source results except the `true` acknowledgements, `nativeParamsTargetStep`, `nativeParamsTargetCheckpoint`, `nativeDataExploration`, `nativeApplyUnchangedDataEvents`, `nativeReleaseDataIngestion`, `nativeDataIngestionCommand`.
- The boolean **`true`**: every other async, params and workspace function, unless §3.0.5 or §3.2 says otherwise. A Rust `1` instead of `true` fails Java `Boolean.TRUE.equals` (JV:1083) and Swift `isBoolean && toBool()` (SW:385-387).

#### 3.0.7 Host error mapping shared by all jobs

- Swift `asterInvoke` (SW:108-121): if the exception has `name=='IngestionError'`, a string `code` of 1..64 UTF-16 units and a string `message` of ≤256 units, it becomes `BaroChartIngestionError(code, message)`; otherwise `.javaScript(exception.toString())`, that is `Name: message`. The Rust error must expose `name`, `message` and `code`.
- Java `AsyncJob.classify` (JV:1142): `String.valueOf(message).toLowerCase(Locale.ROOT).contains("stale")` gives status `stale`, otherwise `failed`. Every message that contains "stale" must keep it, and no other message may gain it.
- Java statuses: `success | cancelled | timedOut | stale | failed | closed | superseded` (async); params adds commit outcomes `notCommitted | committed | unchanged | unknown`.

### 3.1 Async data jobs (correction, columns, seeded)

Three opt-in two-runtime jobs share one protocol: `applyDataEventAsync` (kind `correction`, any data event), `prepareColumnsAsync` (kind `columns`) and `prepareSeededAsync` (kind `seeded`). The source is the live runtime on the owner thread; the target is a fresh empty runtime on a worker. After the numeric work the latest UI and drawing history move as a header plus chunks. None of these jobs uses the process admission (Swift `BaroChartNativeAdmission`, Java `NativeJobBudget`); that is for workspace and params only.

#### 3.1.1 Host entry points

| Host | Entry | Checks, in order | Request JSON |
|---|---|---|---|
| Swift (SW:1507-1539, main thread, owner only) | `applyDataEventAsync(event, timeout=30, progress, completion)` | owner (`wrongThread`) → main (`mainOwnerRequired`) → not closed (`engineClosed`) → `workspaceAvailability()` (closing → `engineClosed`; a pending workspace/params registration still registered → `busy`; `activeParams`/`activeWorkspace` → `busy`) → `activeAsync == nil` (`busy`) → timeout finite in (0, 3600] (`invalidProtocol('Invalid timeout')`) → `JSONSerialization.isValidJSONObject` (`'Data event must be valid JSON'`; NaN fails) → sorted-keys JSON ≤ 8388608 bytes (`'Oversized data event'`) | the event, `.sortedKeys` |
| | `prepareColumnsAsync(columns, visibleBars=200, …)` | as above, then visibleBars 1...4194304 (`'Visible bars 1...4194304'`); `BaroChartColumns` requires equal lengths ≤ 4194304 (`'Equal column lengths <=4194304 required'`) | `{"kind":"columns","length":N,"visibleBars":V}` |
| | `prepareSeededAsync(count, seed: UInt32 = 42, visibleBars=200, …)` | count 0...4194304 and visibleBars 1...4194304 (`'Prepare count/visible bars'`) | `{"count":N,"kind":"seeded","seed":S,"visibleBars":V}` (sorted keys) |
| Java (JV:872-939) | `applyDataEventAsync(event, options, listener)` | `checkAsyncOwner`: owner, cleanup resume, `'Engine closed'`, `'Engine closing'`, main looper (`'Async calculation requires a main/UI owner engine'`) → non-null arguments (`'Async event, options and listener required'`) → `event.toString()` ≤ 8388608 chars (`'Async event size limit'`) | `event.toString()` (insertion order) |
| | `prepareColumnsAsync(columns, visibleBars, …)` | columns non-null (`'Owned columns required'`), visibleBars 1..4194304 (`'Visible bar limit'`) | `{"kind":"columns","length":N,"visibleBars":V}` |
| | `prepareSeededAsync(count, seed, visibleBars, …)` | count 0..4194304 (`'Synthetic bar count limit'`); seed `Integer.toUnsignedLong` | `{"kind":"seeded","count":N,"seed":S,"visibleBars":V}` |
| | all | `AsyncOptions`: timeoutMillis 1..600000 (default 30000), maxBarsPerStep 1..16384 (default 4096), else `'Async timeout/step limits'`. `beginAsync`: an active workspace or params job → `IllegalStateException('Workspace or parameter update is active')`. An active async job is **superseded**, not rejected: `stopOnOwner('superseded')` calls `nativeAsyncRelease`, and the new worker waits for the old worker thread to die. | |

Swift rejects a second async job with `busy`; Java supersedes. Swift steps with a fixed 4096 (SW:593); Java uses `maxBarsPerStep`. Both are pinned platform divergences.

#### 3.1.2 Source functions

| Function | Returns | Behaviour and check order |
|---|---|---|
| `nativeAsyncBegin(eventJSON)` (B:5) | JS string `JSON.stringify({ticket, metadataJSON, buffers:[{slot,length}…], checkpoints:[{entry,total,maxRows}…]})`, keys in this order; `slot` equals its array index; one checkpoint row per indicator entry in entry order (`total` may be 0); `maxRows` 64 or 1 | 1. busy → `Error 'Async capture busy'`. 2. `JSON.parse` (engine `SyntaxError`, D8). 3. `new AsyncCapture(nativeModel, event)` (AS:28-45): axis formatter callback → `TypeError 'Async unsupported axis formatter callback'` (J); `model.disposed` → `Error 'Async stale: model disposed'` (X); acquire the ingestion lease (map §3.6.3: CLOSED, then BUSY, then PENDING_DATA; then fence++), even if the event later proves invalid; `event := codecParse(codecStringify(event))` (A4); `asyncEvent` (AS:25): kind ∉ {reset, append, update, correction, prepend, batch} → `TypeError 'Async data event kind'`; batch → `snapshotIngestionEvents` (IngestionError INVALID_INPUT family; the result is discarded); append/update/correction → `validateBar`, then `RangeError 'Append time'` (time ≤ last), `'Update time'` (no bars, or time ≠ last), `'Correction time'` (no exact match). Reset and prepend payloads are **not** validated here; they fail at `nativeAsyncStart`. Then freeze the fingerprint (version, configuration key, revisions), collect buffers (A2), per entry `requirePortableFactory` (UIE, unreachable in Rust), `validateIndicatorParams`, sorted checkpoint keys, `maxRows` (A3); batch limits (A4); `metadataJSON = codecStringify(omitUndefined(metadata))`; `check()`. Any failure releases the lease (epoch +2 overall). 4. `ticket = ++nativeAsyncTicket`. 5. Store `{ticket, capture}`. |
| `nativePrepareBegin(requestJSON)` (B:6) | `'{"ticket":N,"metadataJSON":"…","buffers":[],"checkpoints":[]}'` | busy → parse → `PrepareCapture` (PS:15-25): axis formatter → `TypeError 'Prepare unsupported axis formatter callback'` (J); disposed → `Error 'Prepare stale: source disposed'` (X); lease; freeze version and key (no revisions); `prepareRequest` (PS:12): `optionRecord` keys `[kind,length,count,seed,visibleBars]`, label `'Prepare request'`; kind ∉ {columns, seeded} → `TypeError 'Prepare input kind'`; `length = kind==='columns' ? request.length : request.count`, `sizeLimit(length, 4194304, 'Prepare bar count')` (a missing value fails too); `seed = seed ?? 42`, `sizeLimit(seed, 4294967295, 'Prepare seed')`; `visibleBars = visibleBars ?? 200`, finite and 1..4194304 (fractions allowed) else `RangeError 'Prepare visible bars'`; `sizeLimit(length, store.maxBars, 'Prepare source bar limit')` (X natively); per entry `requirePortableFactory`, `validateIndicatorParams`, record `{id,name,params:{...},module?,outputs:[...],plotOffsets:{...def.plotOffsets}}`; any series with `values` → `TypeError 'Prepare borrowed series values unsupported'`; metadata and `preparedInput`; `metadataJSON = codecStringify(metadata)` (no omit pass); `check()`. The ticket is assigned only after success. |
| `nativeDataAsyncBegin(kind, requestJSON)` (B:7-10) | `{result: <begin string>}` or `{error:{name:'IngestionError', code, message}}` with `message = String(error.message).slice(0,256)` (UTF-16 units) | kind ∉ {correction, columns, seeded} → `TypeError 'Unknown async begin kind'` (thrown). `correction` → `nativeAsyncBegin`; otherwise `nativePrepareBegin`, where the **request's own** kind decides seeded or columns (measured: kind `columns` with a seeded request runs seeded). Only `IngestionError` is enveloped (PENDING_DATA, BUSY, CLOSED, STORE_BUDGET, INVALID_INPUT); everything else is rethrown unchanged. |
| `nativeAsyncCheck(ticket)` (B:48) | `true` | `nativeCapture(ticket)` (B:4): no slot, `slot.ticket !== ticket` (strict: `'1'` fails) or `capture.model !== globalThis.nativeModel` → `Error 'Async stale: source replaced/released'`. Then `capture.check()` (§3.1.3): `Error 'Async stale: data/configuration/revision changed'` (async) or `Error 'Prepare stale: data/configuration changed'` (prepare). Errors never clear the slot. |
| `nativeAsyncBuffer` async branch (AS:40) | `Float64Array` view of exactly `count` elements (borrowed; hosts copy at once) | `check()` first; `a = buffers[slot]`; `a` missing, non-integer `offset`/`count`, `offset<0`, `count<0`, `count>262144` or `offset+count > a.length` → `RangeError 'Async buffer slice'`. Random access; repeats allowed; `count 0` gives an empty array. |
| `nativeAsyncCheckpoint(ticket, entry, offset, count)` (B:50, AS:41) | JS string `codecStringify(keys.slice(offset,offset+count).map(k=>[k, liveMap.get(k)]))`, keys ascending | `check()`; row missing, non-integers, `offset<0`, `count<1`, `count > row.maxRows` or `offset+count > keys.length` → `RangeError 'Async checkpoint slice'`. States are read live at call time. `PrepareCapture` ticket → engine `TypeError`. |
| `nativeAsyncUIBegin(ticket)` (B:52) | JS string: the UI header (A9) | `nativeCapture`; `slot.ui` already set → `Error 'Async UI capture busy'`; `new AsyncUICapture(capture, nativeInput, nativeSize)`: `uiState` runs `check()`; `input.gesture` or `drawings.transaction` → `Error 'Async stale: active gesture'`; panel/axis formatter, or symbol formatters not installed by `setSymbol` → `Error 'Async unsupported formatter callback'` (J); header > 262144 UTF-16 units or > 1048576 UTF-8 bytes → `RangeError 'Async UI chunk text limit'` (X). Copies the item/undo/redo frame arrays (drawing references) and resets the cursor. On a throw `slot.ui` stays unset. `nativeSize` is not range-checked here. |
| `nativeAsyncUINext(ticket)` (B:53) | JS string: a chunk, or exactly `{"complete":true}` (17 chars), repeated on later calls | `nativeCapture`; no `slot.ui` → `Error 'Async UI capture missing'`; then A10. The cursor and slot table commit only on success (codec errors such as `'Checkpoint Unicode scalar'` and budget errors leave them unchanged). |
| `nativeAsyncUICheck(ticket)` (B:54) | `true` | `nativeCapture`; no `slot.ui` or not `lastComplete` → `Error 'Async UI incomplete source transfer'`; recompute `uiState` (same errors), rebuild the header and compare it with the begin header byte for byte, and compare item/undo/redo frames by element identity → `Error 'Async stale: UI changed during transfer'`. |
| `nativeAsyncRelease(ticket)` (B:55, **checked**) | `true`, always | If `nativeWorkspaceSource?.ticket === ticket`, drop the workspace source. If `nativeAsyncCapture?.ticket === ticket`, `capture.release()` (idempotent: session `leased=false`, epoch++, fence--) and clear the slot including `ui`. Quirk: `ticket === undefined` matches `null?.ticket` and throws an engine `TypeError` (D8; hosts always pass a number). |

#### 3.1.3 Source staleness

Every source call runs these checks (B:4, AS:39, PS:21):
1. `slot.ticket === ticket`, else `'Async stale: source replaced/released'`.
2. `capture.model === globalThis.nativeModel` by identity (`nativeInit` replaces it), else the same error.
3. `model.disposed`, `model.store !== captured store`, `store.version !== captured version`, or a different configuration key → `'Async stale: data/configuration/revision changed'` (async) / `'Prepare stale: data/configuration changed'` (prepare).
4. Async only: some captured entry's `revision` differs, or the entry is gone.

Configuration key (AS:15): `JSON.stringify([[...entries].map(([id,e])=>[id, ident(e), e.name, e.params, ident(e.def.create), ident(registry.get(e.name))]), series.map(s=>[s.id, s.type, s.source, s.indicator, s.output, ident(s.values)]), model.seriesValuesRevision ?? 0])`. `ident()` assigns per-runtime serials through a WeakMap and returns 0 for non-objects. Rust compares entry instance ids, factory ids and values-buffer ids plus the field values; only equality is observable.

Measured (p15): stale after any store mutation (including a typed `applyDataEvent`, which the lease does not block), `addIndicator`, `setIndicatorParams`, `removeIndicator`, series add/remove/reorder, `setSeries` changing type/source/indicator/output, `setSeriesValues`, and a render that computes an indicator left dirty at begin (it bumps the revision; prepare jobs ignore revisions). Not stale: `setVisibleRange`, `setTheme`, `setSeries` style changes or `visible:false`, pointer moves, `nativeResize`, `addDrawing`.

UI staleness (AU:16, AU:19), checked only by `nativeAsyncUICheck`: the rebuilt header text must equal the begin header byte for byte, and the frames must match by element identity. A no-op edit keeps identity; an edit, undo or redo does not. UI changes **before** `nativeAsyncUIBegin` are allowed and published (the "latest UI" contract; the `async.swift` success case relies on it).

While a capture exists (lease plus fence, ingestion.mjs:9-13, :114): `dataIngestionStats.state` is `'busy'`; enqueue → `IngestionError BUSY 'Async ingestion lease active'`; drain → BUSY `'Ingestion has an active async lease or drain'`; configure, load (even without a session) and `compactData` → BUSY `'Model has an active async ingestion fence'`; save and stats are allowed. Acquire and release each bump `session.epoch`, so a job (or a rejected begin) leaves the source epoch +2.

#### 3.1.4 Snapshot metadata and buffers

**A1, metadata key order.** `aster.async.snapshot` (AS:36), after `omitUndefined`:
`schema, protocol:1, event, batchLimits?{maxBars, maxStoreBytes}, store{length, capacity, maxBars, timeframeMs, timeOrigin, version, timeVersion, columns{time,open,high,low,close,volume: {buffer:n}}, index{size,min,max,sum,finiteCounts:false}}, panels (PANEL_KEYS order without formatter), axes (AXIS_KEYS order without formatter), theme (model order), precision, axisWidth, indicators[{id, name, params, module?, outputs, plotOffsets (def.plotOffsets ?? {}), arrays[{buffer}], checkpointCount, checkpointSize (256), revision, dirty, dirtyTo (?? store.length), invalidated (?? true), length, computedFrom (?? 0), computedUntil (?? store.length), entry}], series[{options (SERIES_KEYS order; values → {buffer}), revision?, dirtyFrom (?? 0; Infinity becomes {"$asterNumber":"Infinity"}), index}], bufferLengths, maxOutputBytes`.
A series `index` is `null`, or `{blocked:false, finiteCounts:true, tree:{size,min,max,sum,finiteCounts:true}}`, or `{blocked:true, finiteCounts:true, size, length, blockSize:32, tree:{size,min,max,sum,finiteCounts:false}}`; it is captured only when `rangeIndex.finiteCounts === true`.

`aster.prepare` (PS:19): `schema, protocol:1, input{kind, length, seed, visibleBars}, storeOptions{maxBars, timeframeMs, timeOrigin}, version (store.version+1), timeVersion (+1), panels, axes, theme, precision, axisWidth, indicators[{id, name, params, module?, outputs, plotOffsets}], series (SERIES_KEYS picks; never values), maxOutputBytes`. `preparedInput = {input, version, timeVersion, storeOptions, maxOutputBytes}` goes into the UI state.

**A2, buffer collection** (AS:32-36). `put(a)` requires a `Float64Array` (`TypeError 'Async Float64 buffer'`, X), deduplicates by (backing buffer identity, `byteOffset:length`) and returns `{buffer:slot}`. A new view adds its `byteLength`; a total above 536870912 → `RangeError 'Async snapshot byte limit'` (equality passes). Slot order:
1. indicator output arrays: entries in Map order, outputs in definition order;
2. per series in order: external `values`, then range-index tree `min`, `max`, `sum` (a `BlockRangeIndex` contributes its `.tree`);
3. store columns `time, open, high, low, close, volume`;
4. store index `min, max, sum`.

Measured: `nativeInit(600)` without a render gives 10 buffers (1024 ema; 6×1024 columns; 3×2048 index). After a render: 13 (the ema series tree, 3×2048, sits between the indicator and the columns). 70000 bars: the blocked ema tree has size 4096 (3×8192).

**A3, checkpoints** (AS:33, :41, :49, :54). Row per entry `{entry: ordinal, total: key count, maxRows}`. `maxRows = 1` when the entry is a linked module or any of `period, fast, slow, signal, smoothK, smoothD, stochPeriod, atrPeriod, conversion, base, span` satisfies `(params[k] ?? 0) > 100`; otherwise 64 (measured: sma period 101 gives 1). Slices carry live states. Hosts read `min(maxRows, total-offset)` rows per call.

**A4, event normalization and batch limits.** **(M0c)** Before the first parse, B:5 uses `assertJsonTextDepth(text,32,'Native data event document depth limit')`; B:6 uses `Native prepare document depth limit`. The busy check stays first, string coercion uses the string hint exactly once, and no capture/ticket is created on rejection. Then `event' = codecParse(codecStringify(JSON.parse(text)))`: Unicode scalars, depth 32 and 250000 values are enforced; `{"$asterNumber":"NaN"|"Infinity"|"-Infinity"|"-0"}` objects in host input become numbers; an invalid marker → `TypeError 'Checkpoint number marker'`. Extra keys on the event or the bar are tolerated and carried (measured). For a `batch` event with a session, `dataIngestionBatchLimits` (ingestion.mjs:14-20): `length = store.length + count(kind==='append')`, `capacity` = store capacity doubled until ≥ length; `length > maxStoredBars` or `96*capacity > maxStoreBytes` → `IngestionError STORE_BUDGET 'Batch exceeds configured stored-row/capacity-byte budget'`; else `{maxBars: maxStoredBars, maxStoreBytes}`.

The metadata value tree is internal, but its codec limits are begin-time failures and must be reproduced: with the demo `nativeInit(300)` layout (128 base values) a reset of 35696 bars passes and 35697 fails with `RangeError 'Checkpoint state limit'` (7 values per bar, measured).

#### 3.1.5 Target functions

| Function | Returns | Behaviour and check order |
|---|---|---|
| `nativeAsyncCreate(metadataJSON)` (B:56) | `true` | busy (§3.0.2) → `new AsyncPrepared(text)` (AS:47): codec parse; metadata validation (forged-only messages, §4.1; `TypeError 'Async protocol'` is reachable when the capture lists more than 1024 buffers); zero-filled `Float64Array(bufferLengths[i])`; `received` zeros; one empty checkpoint Map per indicator; phase `'capture'`. A constructor error leaves the slot empty. |
| `nativePrepareCreate(metadataJSON)` (B:14-21) | `true` | busy → creating token → `new PreparedData(text)` (PS:27-28): metadata validation; `RangeError 'Prepare indicator output budget'` (outputs × capacity × 8 > maxOutputBytes) is reachable; `capacity` = 16 doubled while < length; six zero-filled `Float64Array(capacity)`; phase `'capture'`, `at=0`, `previous=-Infinity`, `price=100`, `seed=input.seed`. |
| `nativeAsyncTargetBuffer` async/prepare branches | writable `Float64Array` view of `count` elements | `AsyncPrepared.target` (AS:48): buffer missing, non-integers, `offset !== received[slot]`, `count<1`, `count>262144` or `offset+count > length` → `RangeError 'Async target slice'`; `received[slot] += count` on hand-out. `PreparedData.target` (PS:29): phase `'capture'`, kind `'columns'`, integer slot 0..5, `offset === received[slot]`, count 1..262144, `offset+count ≤ length`, else `RangeError 'Prepare target slice'` (seeded targets reject every call). Slots are 0..`bufferLengths.length-1` (≤1024) for async targets, not 0..5. |
| `nativeAsyncCheckpointImport(entry, text)` (B:58, AS:49) | `true` | no target → `Error 'Async target missing'`; `codecParse(text)` runs first (its errors win); `indicators[entry]` missing, rows not an array, 0 rows or more than 64 → `TypeError 'Async checkpoint rows'`; per row: not a 2-element array, `row[0] !== map.size*checkpointSize`, or `row[0] > e.length` → `TypeError 'Async checkpoint order/history'`; `validateCheckpointState(name, params, state, key)` (map §3.8.4); `map.set`. Rows before a failing row stay (no rollback; the target can no longer complete). After the loop, `map.size > checkpointCount` → `RangeError 'Async checkpoint count'` (X). On a `PreparedData` or workspace target: engine `TypeError 'nativeAsyncPrepared.checkpoint is not a function'` (D8). |
| `nativeAsyncStart()` (B:59) | `true` | `AsyncPrepared.start` (A5): phase ≠ `'capture'` or a slot incomplete → `Error 'Async incomplete buffer capture'` (also on a second start). Reset, prepend and batch semantics fail **here** (measured): `TypeError 'OHLCV array required'`, `TypeError 'Prepend bars required'`, `RangeError 'Prepend must precede existing history without overlap'`, `RangeError 'Times must be strictly increasing'`, `RangeError 'Invalid OHLCV envelope'`, batch budget `RangeError`s. On failure the model is disposed and the phase stays `'capture'`; a retry fails identically. `PreparedData.start` (PS:30): phase ≠ `'capture'`, or kind columns with any `received !== length` → `Error 'Prepare incomplete input'`; then build the store (map §3.15.2) and enter `'generate'` (seeded) or `'validate'` (columns). |
| `nativeAsyncStep(maxBars)` (B:60) | JS string `JSON.stringify({phase, done, total, complete})` | `AsyncPrepared.step(maxBars=4096)` (AS:59-60): no model → `Error 'Async calculation not started'`. `maxBars` is **not** validated up front: the indicator generator throws `RangeError 'Calculation chunk size'` on its first `next()` when `maxBars` is outside the integers 1..65536, and the failed task stays installed, so the next step reports that entry as done without computing it (measured; same after any calculate error). `PreparedData.step` (PS:32-37): `maxBars` integer 1..65536, else `RangeError 'Prepare step size'` (checked first, even before start); phase `'capture'` → `Error 'Prepare not started'`. Phases: A6 (async), A7-A8 (prepare). |
| `nativeAsyncUIImportBegin(headerText)` (B:61) | `true` | target is a `NativeWorkspacePrepared` → `Error 'Workspace target does not import source UI'`; no target, or an import already installed → `Error 'Async UI target unavailable'` (`nativeAsyncUIPrepared` is not checked); `new AsyncUIImport(text, target)` (A11). No phase check, so it may run before start. |
| `nativeAsyncUIImportChunk(chunkText)` (B:62) | `true` | no import → `Error 'Async UI target missing'`; `chunk(text)` (A11). Records accepted before a failure stay. |
| `nativeAsyncUIImportEnd()` (B:63) | `true` | no import → `Error 'Async UI target missing'`; `nativeAsyncUIPrepared = import.finish()` (A12), and only then `nativeAsyncUIImport = null`. On failure the import stays installed: a retry re-runs `finish` (measured `'TypeError: Async size'` twice) and a new `UIImportBegin` fails with `'Async UI target unavailable'`. Legitimate source states that fail here: `nativeSize` outside 100..16384 × 80..16384 → `TypeError 'Async size'`; a series moved to another panel during the job → `Error 'Async stale: series binding'`; its old panel removed → `Error 'Async stale: panel binding'`. |
| `nativeAsyncFinish(uiJSON)` (B:64) | `true` | no target → `'Async target missing'`; `{model, ui} = nativeAsyncUIPrepared ?? target.finish(uiJSON)` (hosts pass `''`; without a chunked import that is an engine `SyntaxError`, measured); then A13. No rollback (D9): an error after `finishUI` leaves both target slots set. |

#### 3.1.6 Target reconstruction and stepping

**A5, `AsyncPrepared.start`** (AS:50-58, AS:27), in order:
1. every buffer slot fully received;
2. batch-limit checks (forged only);
3. `sizeLimit(length, maxBars, 'Async bars')` and capacity checks;
4. `new BarStore([], {maxBars, timeframeMs, timeOrigin})` with `length`, `capacity`, `version`, `timeVersion` assigned and the received buffers as columns; the store index restored by `asyncRestoreTree` (size a power of two; for finite-count caches each leaf is a count with the right meaning and each internal node is left+right);
5. column lengths equal `capacity`; the OHLC index has a sum;
6. `new ChartModel({store, panels, axes, theme, precision, axisWidth})` with default visible bars; from here on errors dispose the model;
7. per indicator: identifier, factory, `def = make(params)`, outputs and plotOffsets JSON-equal, `arrays.length === outputs.length`, every array the same power-of-two length (else `TypeError 'Async output definition'`, **reachable**: a capture taken after `compactData` leaves `arrays []` until the next calculation, measured), output bytes, checkpoint completeness (`map.size === checkpointCount`, and if `checkpointCount > 0` then `= floor(length/checkpointSize)+1`, else `TypeError 'Async checkpoint completeness'`), then `entries.set(id, {...e, def, arrays, checkpoints})`;
8. series: validated against a model view with an `indicators.get` stub; `values` = entry output, or `s.values`, or the store column; range index restored (blocked: blockSize 32, tree size = smallest power of two ≥ ceil(size/32)); aliasing with the volume sum buffer and duplicate ids rejected;
9. `asyncEvent(event, store)` again, then `store.applyEvents(events, batchLimits)` when batch limits exist, else the store-level `applyDataEvent(store, event)` (markets.mjs:200-208). The store notification marks entries dirty (map §3.7.6). Phase `'calculate'`.

Published entries are plain records `{...metadataIndicator, def, arrays, checkpoints}` in a plain `Map` with plain `Map` checkpoints (measured). They are **not** `NativeCheckpointEntries`, so D2 never applies to async-data or prepare publishes.

**A6, `AsyncPrepared.step`** (AS:59-60). In `'calculate'`: if `entry < ids.length`, create `task = calculate(ids[entry], maxBars)` if none, call `next()`; when done, `task = null`, `entry++`; return `{phase:'calculate', done: entry, total: ids.length, complete:false}`. Otherwise switch to `'indices'` and fall through. In `'indices'`: if `series < N`, take the next series; unless it is candles or ohlc run `model.seriesData(s)` (a full, unchunked build, map §3.9.5); return `{phase:'indices', done: series, total: N, complete:false}`. Otherwise switch to `'ready'` and return `{phase:'ready', done:1, total:1, complete:true}` (repeated on later calls). The calculation restarts from the checkpoint at `floor(dirty/256)*256` and may stop early on convergence (map §3.7.8). Results are bit-identical to the synchronous path (measured: equal inspect and scene).

**A7, `PreparedData` generate/validate/store-index** (PS:33-35). Validate and store-index are map §3.15.2 (same messages: `'Every OHLCV field must be finite'`, `'OHLCV UTC time'`, `'OHLCV increasing time'`, `'Invalid OHLCV envelope'`, `'Volume sum overflow'`). Generate, chunk `end = min(n, at+maxBars)`:
`rand(){ seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296 }`; per row `open = price; price = max(.1, price+(rand()-.497)*1.2); time = 1700000000000+i*60000; close = price; high = max(open,price)+rand()*.6; low = max(.01, min(open,price)-rand()*.6); volume = floor(100+rand()*9900)`. This is bit-identical to `seededColumns(n, seed)` (map §3.4.10, measured at n=5 and n=600).
Progress: generate `at/n`; validate `at/n`; store-index `(capacity-1-at)/(capacity-1)`. The progress object is built **before** the phase transition, so the last chunk of a phase reports that phase. For n=0: generate 0/0, validate 0/0, then store-index 15/15 in one step.

**A8, `PreparedData` calculate/indices** (PS:36-40). Calculate as A6; once all entries are done it calls `model.addSeries(options)` for every metadata series, sets `initialView = {...model.view}` (the view for `input.visibleBars`), switches to `'indices'` and falls through. Indices: candles and ohlc only advance the cursor; other series run the chunked range builder: `values` = entry output (capacity length) or `columns[source ?? 'close']`; `blocked = length ≥ 65536`; `blockSize` 32 or 1; `leaves = ceil(length/blockSize)`; `treeSize` = smallest power of two ≥ `ceil(capacity/blockSize)`; min/max/sum start at +Inf/−Inf/0; leaves are built in batches of `max(1, floor(maxBars/blockSize))` rows (finite min, max, count per leaf), internal nodes merge in batches of `maxBars` from `treeSize-1` down, yielding after each batch. Install: blocked → `BlockRangeIndex{size: capacity, length, blockSize, values, tree (finiteCounts false), finiteCounts:true}`, else the tree itself (finiteCounts true); `series.revision = entry ? entry.revision : store.version`; `dirtyFrom = Infinity`. Progress `done` = completed series. With no indicators `'calculate'` never appears; with no series the call after store-index returns ready. Measured (600 bars, maxBars 256, one line series): 9 indices steps (1 for candles, 7 yields, 1 completion), then ready.

#### 3.1.7 UI transfer, `finishUI` and publish

**A9, UI state and header** (AS:42, AU:8-9, :14). State key order: `preparedInput?, dataIngestion? (session save() text), bindings[{id,name,params,module?,outputs,plotOffsets}], view, follow, crosshair ({x,y}|null), theme, panels (raw model panel objects), axes, drawingTarget, series (SERIES_KEYS without values, indicator, output, source), precision, axisWidth, symbol?, drawings{limits{historyLimit,maxDrawings,maxPoints,maxDocumentChars,historyBytes}, items, undo, redo, selected, serial}, tool (input.tool ?? 'select'), text (input.text ?? ''), size (nativeSize)`. Header = `codecStringify({schema:'aster.async.ui', protocol:1, state: omitUndefined({...state, drawings:{limits, frameCounts:[items.length, ...undo[i].length, ...redo[j].length], undoCount, redoCount, selected, serial}})})`, bounded to 262144 UTF-16 units and 1048576 UTF-8 bytes. Measured header lengths: 1157 (`nativeInit(600)`), 1156 (`nativeInit(300)`). The test-only `nativeAsyncUI` returns the full state (limit 8388608 units, `RangeError 'Async UI state limit'`) and is not ported.

**A10, chunker** (`AsyncUICapture.next`, AU:12-13, :20-35):
1. `capture.check()`; skip frames whose offset equals their length; at the end set `lastComplete` and return `{"complete":true}`.
2. Otherwise `prefix = '{"complete":false,"frame":F,"offset":O,"refs":['`, `middle = '],"records":['`, `suffix = ']}'`; `chars = bytes = len(prefix+middle+suffix)`; `nodes = 6`; `points = 0`.
3. While `at < frame length` and fewer than 64 refs: take the drawing. Its slot is known (committed or pending) or new (`slot = committed + pending count`; the record is the deferred one if it is the same drawing, else `text = codecStringify(drawing)` with its UTF-8 bytes, nodes and points). `ref = String(slot)`; a new slot adds `row = '{"slot":S,"drawing":TEXT}'`. `extraChars = ref.length + (refs?1:0) + (row ? row.length + (records?1:0) : 0)`; `extraBytes = extraChars + (record ? bytes - text.length : 0)`; `extraNodes = 1 + (record ? 2 + nodes : 0)`; `extraPoints = record.points`. If a total would exceed 262144 chars, 1048576 bytes, 250000 nodes or 2048 points: with no refs yet → `RangeError 'Async UI single record exceeds chunk budget'`; otherwise defer the record and stop.
4. `text = prefix + refs.join(',') + middle + records.join(',') + suffix`; a length mismatch or exceeded total → `RangeError 'Async UI chunk budget mismatch'` (internal assertion).
5. Commit pending slots, the frame/offset cursor and the deferred record.

One chunk covers one frame from its current offset, never two frames; drawings are deduplicated by identity across all frames. UTF-8 count (AU:12): 1 byte ≤0x7F, 2 ≤0x7FF, 4 for a high surrogate (skipping its pair), else 3. Node count (AU:13): one per JSON value plus one per non-finite or −0 number. Measured with 70 drawings: frame 0 is sent as 64 refs with 64 records (11230 chars), then 6+6 (1111 chars); each undo frame of k drawings is one chunk of refs `[0..k-1]` without records (63 chars for k=1); frames over 64 split 64 + rest; the redo frame adds new slot 70.

**A11, import** (`AsyncUIImport`, AU:39-45). Constructor: codec parse; header keys; schema `'aster.async.ui'`, protocol 1, object state, else `'Async UI protocol'`; drawings header keys; limits keys; `new DrawingStore(limits)`; undoCount and redoCount ≤ historyLimit; serial ≤ 2^53−1; `frameCounts.length = 1+undo+redo`; each count ≤ maxDrawings; Σ ≤ maxDrawings + floor(historyBytes/8). `chunk(text)`: finished → error; a string of ≤262144 units; codec parse; chunk keys; `skipEmpty()` (for each completed frame: `store.budget`, duplicate ids, `store.weight`); cursor and bounds (refs 1..64, records ≤64, offset+refs ≤ count, else `'Async UI chunk order/offset'`). Each record: `slot === records.length`; a one-drawing document loads into a temporary `DrawingStore` (maxDocumentChars 8388608; style decoder `portableStyle(color, fill, preserveHex)`; `validatePanel` against the state panels; binding validation through a model view with the state's panels, axes and series, orphan series allowed); budgets: ≤2048 new points per chunk, Σ new points ≤ maxPoints + floor(historyBytes/32), Σ JSON length ≤ maxPoints·96 + maxDrawings·3072 + floor(historyBytes/2). Refs: `sizeLimit(slot, records.length-1)`, mark used, push. `finish()`: `skipEmpty`; every frame done; every record used; assemble the store (items = frames[0], undo, redo, selected, serial); `target.finishUI(state, store)`; `finished = true` only on success.

**A12, `finishUI`** (AS:62-85; `PreparedData` wraps it at PS:42). Validation order: phase ready (`'Async result not ready'`); UI keys; `preparedInput` deep-equal for prepare (`'Prepare stale: request/input binding'`) or absent otherwise (`'Async unsupported preparation signature'`); bindings equal to the target entries (`'Async stale: indicator request binding'`); view `{from,to}` finite with to > from and boolean follow (`'Async view'`); size `{width,height}` finite, width 100..16384, height 80..16384 (`'Async size'`); crosshair null or finite `{x,y}`; precision ≤18; axisWidth finite ≥20; theme keys and `portableStyle(background, grid, text, up, down, crosshair, preserveHex)`; `validateSymbol`; collections (1..32 panels; series count equal to the target's); each panel validated, no formatter, no duplicates; axes through a validator model's `addAxis`; every target series' panel exists (`'Async stale: panel binding'`); each series patch: an existing unique id with the same type and panel (`'Async stale: series binding'`), `portableStyle(color, fill, upColor, downColor)`, `normalizedSeries`; drawingTarget validated, and silently nulled when its seriesId is missing or bound to another panel or axis; drawings record, store, history lengths, visible selection, serial; `trim()`; ingestion restore (`allowBudgetMismatch` unless the kind is batch; a non-empty payload → `Error 'Async ingestion payload must be empty'`).
Installation: series patches `Object.assign` onto the target series (new keys go last, in SERIES_KEYS order); old session disposed; dataIngestion, drawings, panels, axes, theme, precision, axisWidth, `view = {...ui.view}`, follow and crosshair set. View rules: prepend while the captured store length > 0 → from and to += bars.length; reset → `model.fit()` (map §3.9.4, D3); otherwise, when follow is true and the event is an append, a batch containing an append, or a non-empty prepend into an empty store → `span = to-from; to = store.length + forwardOffset() - .5; from = to - span`. Prepare: when `ui.follow` is true, `view = {...initialView}` and follow true; otherwise the UI view is kept.
Measured views: append 399.5..599.5 → 400.5..600.5; prepend of 3 → 402.5..602.5; prepend of 3 into an empty store → −197.5..2.5; append into empty → −199.5..0.5; reset of 12 → −0.5..11.5; update, or batch without appends → unchanged; seeded n=600 vb=200 → 399.5..599.5; columns vb=100 → 499.5..599.5; vb=1.5 with n=20 → 18..19.5; follow false keeps the source view.

**A13, publish** (`nativeAsyncFinish`, B:64): `input = new InteractionController(model, ()=>globalThis.nativeSize)`; `api = new ChartAPI(model, {controller: input})`; `input.setTool(ui.tool)`; `api.setText(ui.text)`; `api.setDrawingTarget(ui.drawingTarget ?? null)`; `if (ui.symbol) api.setSymbol(ui.symbol)`; dispose the current `nativeModel`; `nativeLatestLayout = nativeLatestLayoutModel = null`; assign `nativeModel`, `nativeInput`, `nativeAPI`; `nativeSize = ui.size`; clear `nativeAsyncPrepared` and `nativeAsyncUIPrepared`.

#### 3.1.8 Host-checked fields (must match)

| Result | Swift | Java |
|---|---|---|
| begin descriptor | JS string read with `toString()`, a JSON object ≤ 8388608 UTF-8 bytes (SW:126-129); `ticket` an `NSNumber`, not a `CFBoolean`, finite, integral, 0..2^53−1 (SW:131-135); `BaroChartAsyncPlan` (SW:160-186): `metadataJSON` string ≤ 8388608 UTF-8 bytes; ≤ 8192 buffers, `slot` integer ≤ 8191 and unique, `length` ≤ 16777216, Σ length·8 ≤ 4294967296; ≤ 128 checkpoints, `entry` ≤ 127 unique, `total` ≤ 4194304, `maxRows` optional (default 64) 1..64. Prepare kinds require empty `buffers` and `checkpoints` (SW:530, `'Prepare must not copy source buffers'`). The ticket is read before the plan, so a plan failure still releases the capture; a descriptor parse failure does not. | `nativeDataAsyncBegin` result is a JSON object; `error` → `IngestionException(getString('code'), getString('message'))`; else `(String) get('result')` parsed (JV:1133, :165-168). `getLong('ticket') ≥ 0`; ≤ 2048 buffers with `getInt('slot') == i` and length 0..33554432; ≤ 128 checkpoints with `optInt('maxRows',64)` 1..64, `entry ≥ 0`, `total` 0..4194304. Violations: `IllegalStateException 'Async descriptor limits'` / `'Async buffer descriptor'` / `'Async checkpoint descriptor'` (JV:1134-1137). |
| buffer read | `asterTypedBytes` (SW:141-156): `Float64Array`, count 1..262144, `length == count`, `byteLength == count*8`, aligned and in bounds | JNI `readBuffer` (JNI:91-96): ticket ≥ 0, slot 0..2047, count 1..262144, offset+count ≤ 33554432; an intrinsic `Float64Array` of exactly `count*8` bytes |
| target write | same `asterTypedBytes` on `nativeAsyncTargetBuffer` (SW:543, 565) | JNI `writeBuffer` (JNI:97-102): slot 0..2047, 8..2097152 bytes, multiple of 8, offset+n ≤ 33554432; JNI `writeSlice` (JNI:106-111) and `BaroChartColumns.copyInto` (`BaroChartColumns.java:45`): slot 0..5, count 1..262144 |
| checkpoint rows | `toString()` ≤ 8388608 UTF-8 bytes (SW:581) | `(String)` cast (JV:1161) |
| step progress | JSON object string ≤ 8 MiB; `phase ∈ {generate, validate, store-index, calculate, indices, ready}`; `complete` castable to Bool; `done`, `total` pass `asterInteger`; `done ≤ total`; loop ends on `complete` (SW:593-596) | `getString('phase')`, `getLong('done')`, `getLong('total')`, `getBoolean('complete')`; no phase whitelist (JV:1181) |
| UI header | string ≤ 1048576 UTF-8 bytes, JSON object; `state.drawings.frameCounts` an array of ≤ 20001 integers each ≤ 10000 with Σ ≤ 5000000 (SW:605-610) | ≤ 262144 UTF-16 units and ≤ 1048576 UTF-8 bytes; frameCounts finite non-negative integers ≤ `Integer.MAX_VALUE`, summed with `addExact` (JV:1168, :1187) |
| UI chunk | ≤ 1048576 UTF-8 bytes, JSON object, `complete` a strict `CFBoolean`; if false, `refs` an array of 1..64 and the running ref count ≤ the frameCounts sum; after `complete:true` the ref count must **equal** the sum, else `invalidProtocol('UI transfer incomplete')` (SW:617-627) | same size limits; the terminal is detected by exact string equality with `{"complete":true}`; a data chunk needs `get('complete') == Boolean.FALSE` and refs 1..64 within the total; the final ref count must equal the header total (JV:1168, :1188-1189) |
| everything else | results of create, checkpoint import, start, UI import, `nativeAsyncCheck`, `nativeAsyncUICheck`, `nativeAsyncFinish` and `nativeAsyncRelease` are ignored; only "did not throw" matters | same; a release failure at commit aborts publication with `IllegalStateException('Async source release failed')` (JV:1206) |

#### 3.1.9 Internal payloads (may differ)

| Payload | Why it is internal | What Rust must still reproduce |
|---|---|---|
| `metadataJSON` (begin → create) | hosts check only "string" and the size | begin-time failures defined on the JS value tree: codec limits (250000 values, depth 32, 8388608 UTF-16 units, Unicode scalars in every string including labels), the 512 MiB snapshot budget, more than 1024 buffers rejected at create. Recommendation: build the same tree. |
| buffer contents | raw f64 bits | the descriptor list (count, `slot` = index, `length`) is **host-checked** and drives progress totals (`capture` = Σ length·8) and the copiedBytes/maximumChunkBytes metrics: keep the A2 layout and order |
| checkpoint row text | opaque except Swift's 8 MiB check | slicing is host-driven by `(entry, total, maxRows)`; the rows must still pass `validateCheckpointState` on the target |
| UI header body | hosts read only `frameCounts` and sizes | the header text is also the UI staleness fingerprint |
| UI chunk records | hosts read only `complete`, `refs.length` and the terminal text | the chunk count and byte counts feed the uiChunkCount/uiTransferBytes/maximumUIChunkBytes metrics: replicate A10 for metric parity |
| `nativeAsyncFinish(uiJSON)` argument | hosts always pass `""` | the full-state path is test-only |

#### 3.1.10 Host flows (unchanged; Rust must accept them)

- **Swift** (SW:1548-1565, 522-654). `startAsync` creates `BaroChartAsyncJob` (captures `engine.context` as its source; when the context was installed by a workspace restore it takes a capture lease, failing with `invalidProtocol('Source runtime is retiring')`), sets `activeAsync`, and on a later main turn: `job.check()` → `ownerSource()` → begin through `asterInvoke` → ticket → plan → worker thread `'Aster isolated JavaScriptCore'`. Worker: new VM + context, evaluate the bundle, create; for columns, per slot 0..5 in 262144 chunks a main-queue `sourceChunk` (owner check + `nativeAsyncCheck`) then `nativeAsyncTargetBuffer` + memcpy from the host column; per plan buffer and chunk, main `nativeAsyncBuffer` → worker target write (progress `'capture'`, total Σ length·8); per checkpoint row and `maxRows` chunk, main `nativeAsyncCheckpoint` → worker import (progress `'checkpoints'`); start; `nativeAsyncStep(4096)` until complete (progress at most every 16 ms); UI header → import begin (progress `'ui-copy'`); chunks until complete → import end. Handoff, one main-queue block: `ownerSource()`; `nativeAsyncUICheck`; `job.check()`; `nativeAsyncFinish("")` on the target; `ownerSource()` again; commit under the job lock: `nativeAsyncRelease(ticket)` on the source, swap `engine.context` and `contextRuntime`, retire the old runtime; `notifyChanges()`; success. Failure anywhere: retire the worker, then `finish` (`try? nativeAsyncRelease(ticket)` while the ticket is set, SW:275). `BaroChartCaptureBox.wait` polls every 20 ms. `close()` stops the job with `engineClosed`; deinit with `sourceDeallocated`. While a job is uncommitted, `command()` rejects `compactData` and the 7 ingestion mutators with `BaroChartIngestionError('BUSY','Native asynchronous job is active')` (SW:1618-1620).
- **Java** (JV:1108-1219). `AsyncJob.start` runs synchronously on the owner: `nativeDataAsyncBegin`, descriptor checks, `memoryUsed(source)`, then the worker `'Aster isolated calculation'` starts after the preceding worker died. Worker: `create(sourceBundle)` (fresh QuickJS handle) → create; transfers through a queue of capacity 1 (50 ms polls), with `captureNext` on main doing one item per turn (columns slice, `readBuffer` ≤262144 with progress `'capture'`, checkpoint rows with progress `'checkpoints'`); `nativeAsyncStart`; `nativeAsyncStep(maxBarsPerStep)` with progress coalesced at 40 ms per phase; UI capture on main (progress `'ui-capture'`), import on the worker. Commit (`awaitWorkerThenCommit`): wait for the worker thread; guards (stop requested; handle 0 → `closed`; not the active job → `superseded`); `nativeAsyncCheck`; `nativeAsyncUICheck`; `nativeAsyncFinish("")` on the prepared handle; synchronized: guards again, `nativeAsyncRelease`, `handle = prepared`, committed; `free(previous)`; notify; `complete('success')`. While uncommitted, `compactData` → `IngestionException('BUSY','Compaction has an active asynchronous calculation')`; ingestion ops other than stats/save → `IngestionException('BUSY','Data ingestion has an active asynchronous calculation')` (JV:216-218).

#### 3.1.11 Limits

| Limit | Value | Where |
|---|---|---|
| Source snapshot bytes | Σ unique view `byteLength` ≤ 536870912 | AS:32 |
| Target buffers | ≤ 1024; Σ length·8 ≤ 536870912; each ≤ 8388608 | AS:47 |
| Target indicators / series | ≤ 128 / ≤ 256 | AS:47, PS:14, PS:27 |
| Source buffer slice | integer offset ≥ 0, count 0..262144, random access | AS:40 |
| Target buffer slice | count 1..262144, `offset === received[slot]` | AS:48, PS:29 |
| Checkpoint rows | `maxRows` 64 or 1; slice 1..maxRows; import 1..64 rows per call; ordinal keys | AS:33, :41, :49 |
| `checkpointSize` | 1..4194305, equal across entries; 256 in practice | AS:47 |
| Codec (event, metadata, rows, header, records, chunks) | ≤ 8388608 UTF-16 units; depth ≤ 32; ≤ 250000 values | checkpoint-validation.mjs:6 |
| Batch events | 1..4096 | ingestion.mjs:36 |
| UI header / chunk | ≤ 262144 UTF-16 units and ≤ 1048576 UTF-8 bytes; chunk ≤ 64 refs, ≤ 250000 nodes (base 6), ≤ 2048 new points, one frame per chunk | AU:7, :14, :21-27 |
| UI size, misc | width 100..16384, height 80..16384, finite (fractions accepted, 100.5×80.25 measured); precision ≤ 18; axisWidth ≥ 20; panels 1..32 | AS:68-71 |
| Prepare request | length ≤ 4194304; seed 0..4294967295 (default 42 via `??`); visibleBars finite 1..4194304 (default 200 via `??`) | PS:12 |
| Prepare step / budgets | maxBars integer 1..65536; outputs·capacity·8 ≤ maxOutputBytes (268435456); capacity·8·(12+outputs) ≤ 805306368 | PS:27, :32 |
| Indicator chunk | `calculate` chunk size integer 1..65536 (lazy for `AsyncPrepared`) | indicators.mjs:241 |
| Swift job | timeout (0,3600] s; event ≤ 8388608 bytes; descriptor ≤ 8 MiB; step 4096; UI texts ≤ 1 MiB; frames ≤ 20001, each ≤ 10000, Σ ≤ 5000000 | SW:160-186, 522-631, 1507-1547 |
| Java job | timeout 1..600000 ms; maxBarsPerStep 1..16384; buffers ≤ 2048 with slot == index | JV:828-841, 1125-1219 |

#### 3.1.12 Published state and quirks

Measured published state (p2, p7, gold): store version = source + 1; `timeVersion` +1 only for kinds that change time (append, prepend, reset, batch with appends; prepare always +1); capacity rebuilt for prepare, kept or grown for corrections. From the latest source UI: panels, axes, theme, view (adjusted by A12), follow, crosshair, precision, axisWidth, drawings (items, undo, redo, selected, serial), series styles, symbol (re-installed through `setSymbol`), tool, text, drawingTarget (nulled when its series no longer matches) and `nativeSize`. `drawingMagnet` and `crosshairSnap` reset to `{mode:'off', radiusPx:8}` and `{mode:'free', target:null}` (not carried). The ingestion session is restored from `save()` text (epoch 0). Indicator values are bit-identical to a synchronous apply.

Quirks to replicate (or fix in JS first and re-freeze, D9):
1. After `compactData`, a correction job fails at `nativeAsyncStart` with `'Async output definition'` until the indicators recompute.
2. `AsyncPrepared.step` skips `maxBars` validation; after a calculate error the dead generator stays installed and the next step reports the entry as done.
3. A failed checkpoint import keeps its partial rows.
4. A failed `UIImportEnd` keeps the import installed.
5. `nativeAsyncFinish` has no rollback.
6. `nativeAsyncFinish('')` without a UI import is an engine `SyntaxError`.
7. Reset, prepend and batch-ordering errors surface at `nativeAsyncStart`, not at begin.
8. `$asterNumber` objects in host events decode to NaN, ±Infinity, −0.
9. Magnet and snap settings are not carried; tool, text, drawingTarget (maybe nulled), symbol and `nativeSize` are.
10. Style keys added during the job are appended in SERIES_KEYS order, so inspect key order differs from the source (measured: `…,"baseline":0,"label":"Vol"}` versus `…,"label":"Vol","baseline":0}`).
11. A render that computes a pending indicator makes a correction job stale.
12. The published engine's ticket counter, registration marks, frame caches and `BarStore` serial restart.
13. The source slot is never auto-expired.

#### 3.1.13 Goldens (oracle bundle; scratch `tier-a-async-data/`)

- `gold.mjs`: `nativeInit(20)`; `addDrawing {id:'t1', type:'text', text:'한국 🚀'}`; event `{kind:'correction', bar:{time:1700000000000, open:100, high:1000, low:99.36004549080171, close:1000, volume:2303}}`. Begin buffers: slots 0-6 length 32, slots 7-9 length 64; checkpoints `[{"entry":0,"total":1,"maxRows":64}]`; checkpoint text `[[0,{}]]`. Steps: calculate 1/1; indices 1/3, 2/3, 3/3; ready 1/1. Header frameCounts `[1,0]`, undoCount 1, redoCount 0, selected `'t1'`, serial 0. Chunk 1: `{"complete":false,"frame":0,"offset":0,"refs":[0],"records":[{"slot":0,"drawing":{"id":"t1","panel":"price","locked":false,"style":{"color":"#f5b85a","width":1.5},"type":"text","points":[{"time":1700000000000,"price":100}],"text":"한국 🚀"}}]}`, then `{"complete":true}`. Published: length 20, version 3, timeVersion 2, capacity 32, `close[0]` 1000, view {−0.5, 199.5}, size 1200×700. Inspect text and `nativeSceneJSON(640,360)` equal a synchronous apply.
- `p1.mjs`, `nativeInit(600)` without a render: 10 buffers; checkpoints `[{entry:0,total:3,maxRows:64}]`; metadataJSON 1716 chars; checkpoint text `[[0,{}],[256,{"e":{"count":20,"sum":0,"value":103.13158934016843}}],[512,{"e":{"count":20,"sum":0,"value":108.11521669435075}}]]`.
- `p3.mjs` prepare with ema(5) and an ema line, 600 bars, maxBars 256. Seeded: generate 256, 512, 600 of 600; validate ×3; store-index 256, 512, 768, 1023 of 1023; calculate 0/1, 0/1, 1/1; indices 1/2 ×8, then 2/2; ready. Columns: the same without generate. Published: version 3, timeVersion 3, capacity 1024, `close[599]` 106.80157022163287, `time[599]` 1700035940000, `ema[599]` 107.0309873891421, checkpoint keys [0,256,512].
- `p12.mjs`: seeded count 0 → generate 0/0, validate 0/0, store-index 15/15, indices 1/1, ready. Request errors: `'TypeError: Prepare request: object required'`, `'TypeError: Prepare request: unsupported field x'`, `'TypeError: Prepare input kind'`, `'RangeError: Prepare bar count: limit 4194304'`, `'RangeError: Prepare seed: limit 4294967295'`, `'RangeError: Prepare visible bars'`; `visibleBars:null` accepted (200).
- `p4.mjs`/`p5.mjs`: the source and target error strings of §4.1; `p9.mjs` the 70-drawing chunk sequence of A10; `p10.mjs` ingestion interplay (STORE_BUDGET envelope, PENDING_DATA, BUSY messages, CLOSED after `nativeReleaseDataIngestion`); `p11.mjs` the compaction quirk; `p13`/`p14.mjs` `'Async size'` (99×80 fails, 100×80 passes), series and panel binding; `p15.mjs` the staleness matrix; `p16`/`p17.mjs` event tolerance and start-time errors; `p7`/`p8.mjs` publish parity with a synchronous reference.
- Tickets: after one released begin the next begin gets ticket 2; the published engine's next begin gets ticket 1; a workspace begin takes ticket 1 and the next async begin gets 2.
- Swift fixtures as trace sources: `examples/native/async.swift` (31 cases), `examples/native/prepare.swift` (43 cases). Repo oracles: `test/async-state.test.mjs`, `prepare-state.test.mjs`, `async-ui.test.mjs`, `async-ui-boundaries.test.mjs`, `ingestion-async.test.mjs`.

### 3.2 Indicator-params jobs (`setIndicatorParamsAsync`)

An entry-only two-runtime job. The source (live runtime) validates and fingerprints the request, walks the existing checkpoint records for a logical byte plan, and lends its six columns in slices of 1..16384 values. A fresh empty target runtime rebuilds the definition, validates every bar, recomputes only that entry cold, validates the outputs and serves a descriptor, output slices and checkpoint texts. The source imports them into detached staging, validates, releases the ingestion lease in Prepare, and in Publish swaps only that entry in place (same Map position, same store), retires derived series caches and records a terminal receipt. 17 globals: 11 source (P:11-28), 6 target (P:29-35, `nativeParamsTargetDispose` not ported), plus the params branches of the buffer globals (§3.0.5).

#### 3.2.1 Row, operation guard and owner check

Row (P:13): `{registration, ticket, status, receipt, capture, arm, revision, model, api, input, size}`. Status: `'active'` → `'failed'` (any dropping error, including Begin's own capture error) | `'aborted'` (Abort while active) | `'committed'`/`'unchanged'` (Publish). Terminal rows keep the receipt; capture, arm and owner references are cleared. At most 4 rows, evicted in insertion order (= registration order).

Operation guard `nativeParamsOperation` (P:8), used by Step, Check, Receive, ArmWrite, Checkpoint, Validate, Prepare, the params buffer read and the params write:
1. find the active row by strict ticket equality, else `Error 'Params source ticket missing/released'` (the active row is **not** dropped);
2. owner check;
3. the operation;
4. `nativeParamsSource !== row` → `Error 'Params source registration changed'` (X);
5. owner check again.
Any throw while the row is still the source runs `nativeParamsDrop(row,'failed')`. Publish (P:26) does lookup, owner check and publish, with the same drop on error and no trailing owner check. Status and Abort take a registration, not a ticket, and run no owner check.

Owner check (B:36 via P:5): `nativeModel`, `nativeAPI`, `nativeInput`, `nativeSize` must be own data slots identical to the row's captured values, with `api.model===model`, `api.controller===input`, `input.model===model`; else `Error 'Workspace source stale: native owner replaced'`. It fails after `nativeInit`, `nativeResize` (even with the same size), `nativeSceneJSON`, a valid `nativeRenderFrameJSON` or `nativeScenePacket` call, `nativeBenchmarkDigest`, `nativeAsyncFinish`, or replacement of those globals. **Rust needs an engine generation plus a `nativeSize` generation bumped on every assignment of `nativeSize`, even for equal dimensions.** Frame calls that throw before assigning `nativeSize` (invalid token) leave the job intact.

#### 3.2.2 Source functions

| Function | Returns | Behaviour and check order |
|---|---|---|
| `nativeParamsSourceBegin(id, params, revision, maxBytes=805306368, registration)` (P:11-16; NPS:34-49) | `{ticket, registration, phase:'admission'\|'noop'}` in this order | 1. registration a safe integer ≥ 1, else `RangeError 'Params registration'`. 2. busy → `Error 'Async capture busy'`. 3. registration ≤ mark → `RangeError 'Params registration must increase'`. 4. ticket+1 not safe → `RangeError 'Params source ticket limit'` (X). Nothing is recorded before here. 5. `ticket = ++nativeAsyncTicket`; read `nativeModel`, `nativeAPI`, `nativeInput`, `nativeSize` as own data slots (missing → `TypeError 'Workspace own data slot: <key>'`; the ticket is consumed, the registration is not, no record). 6. mark = registration; record the row; evict past 4; set the active row. 7. owner check. 8. `NativeParamsCapture`: `identifier(id,'Indicator id')`; revision safe integer ≥ 0 (`RangeError 'Native params host revision'`); maxBytes safe integer 1..805306368 (`RangeError 'Native params byte budget'`; `null` fails, absent defaults); `model.disposed` → `Error 'Chart disposed'`; gesture, pointers or drawing transaction → `Error 'Native params active gesture'`; `assertDataIngestionIdle`; fingerprint (§3.2.3); entry lookup (`Error 'Missing indicator'`, before params validation); `engine.checkpointSize === 256`; `validateIndicatorParams(params)`; `params = {...params}`; validate again; acquire the ingestion lease (`IngestionError PENDING_DATA` if events are queued); `leaseEpoch` = the incremented epoch. No-op test: same key count and `Object.is` per key, order ignored, so `-0` ≠ `0` and `{period:20}` vs `{}` is not a no-op. No-op → layout = old `{outputs, plotOffsets}`, phase `'noop'`. Otherwise `requirePortableFactory` (UIE); a probe engine on an empty fake store runs `add(id, name, {...params})` (factory errors surface here); compare the layout with effective offsets (missing key = 0, `Object.is`), else `TypeError 'Native params output schema/offset change'`; binding and `metadataJSON = safeCheckpointStringify(binding)` (`'Checkpoint Unicode scalar'` on lone surrogates); Σ outputs·capacity·8 > `engine.maxOutputBytes` → `RangeError 'Native params total output byte limit'`; retained-byte accounting (§3.2.4); the list of ordinary checkpoint maps. A capture error after the lease disposes the capture and releases the lease. Any error after step 6 drops the row with `'failed'` (Status still answers). |
| `nativeParamsSourceStep(ticket, maxRecords=8, revision)` (P:17; NPS:52-54) | `{phase:'noop',complete:true}`; `{phase:'admission',complete:false}`; on first completion `{phase:'copy', complete:true, metadataJSON, plan:{retainedBytes, workerSourceBytes, workerOutputBytes, ownerOutputBytes, checkpointBytes, recordMetadataBytes, scratchBytes, transferBytes, totalBytes}}` (fresh copy); later `{phase:<current>, complete:true}` | guard; `check(revision)`. In any phase other than admission it returns at once and does not validate `maxRecords`. In admission: `maxRecords` safe integer 1..64 (`RangeError 'Native params admission records'`); the admission walk (§3.2.4); at the end `otherCheckpointBytes > 33554432` → `RangeError 'Native params other checkpoint byte limit'`; `remaining = 33554432 - other`; plan; `totalBytes > maxBytes` → `RangeError 'Native params combined logical byte limit'` (equality passes); phase `'copy'`. |
| `nativeParamsSourceCheck(ticket, revision)` (P:18) | `true` | guard + `check(revision)`: closed → `Error 'Native params capture closed'` (X); `StaleSourceError 'Native params stale: source/owner changed'` when the revision differs strictly, the fingerprint differs, or (with a session) `model.dataIngestion !== session`, `session.closed`, `session.epoch !== leaseEpoch` or `session.leased !== lease held` |
| params branch of `nativeAsyncBuffer(ticket, slot, offset, count)` | borrowed view of a store column | guard + `capture.buffer(…, row.revision)`: phase `'copy'`, integer slot 0..5, `offset === offsets[slot]` (sequential per slot, slots in any order), count 1..16384, `offset+count ≤ length`, else `RangeError 'Native params source slice'`; `offsets[slot] += count`. The Begin revision is used, so the JS revision check always passes here. |
| `nativeParamsSourceReceive(ticket, text, revision)` (P:19; NPI:9-17) | `true` | `check` → phase `'copy'` and every slot offset == length, else `Error 'Native params source copy incomplete'` (also a second Receive) → `NativeParamsImport` (§3.2.6) → `check` → phase `'receive'` |
| `nativeParamsSourceArmWrite(ticket, slot, offset, count, revision)` (P:21) | `true` | guard; `check`; an arm already pending → `Error 'Params write already armed'`; slot integer in [0, outputs), offset safe ≥ 0, count 1..16384, `offset+count ≤ binding.capacity`, else `RangeError 'Params result slice'`; store the arm. Phase is not checked: arming in admission or copy succeeds and the write then fails `'Native params result phase'`; in `noop` the binding is undefined and a valid slot gives an engine `TypeError` (D8). Ordering is checked by the write, not here. |
| params write (`nativeAsyncTargetBuffer` in a source runtime; P:22) | writable view into the staging array (allocated zero-filled, capacity length, on first use) | no arm → `Error 'Params result write not armed'` (no drop); consume the arm; guard; `(slot,offset,count)` ≠ arm → `RangeError 'Params armed slice mismatch'` (drops); `check`; phase ≠ `'receive'` → `Error 'Native params result phase'`; staging: slot < outputs, `offset === received[slot]`, count 1..16384, `offset+count ≤ capacity`, else `RangeError 'Native params result slice'` |
| `nativeParamsSourceCheckpoint(ticket, index, text, revision)` (P:23; NPI:21) | `true` | `check`; no stage (before Receive, or noop) → engine `TypeError`; phase `'receive'`, `ordinal < checkpointCount`, `index === ordinal*256`, string text with `text.length*2 ≤ 262144`, else `RangeError 'Native params result checkpoint record'`; codec parse; `checkpoints.set(index, state)` (full map §3.8.3 `set`, including `'Native checkpoint total byte limit'` against the import ledger); ordinal++; `usedBytes > declared checkpointBytes` → `RangeError 'Native params checkpoint declared bytes'`. Records may interleave with output slices. Errors dispose the stage (refunding its ledger) and drop the row. |
| `nativeParamsSourceValidate(ticket, maxValues=16384, revision)` (P:24; NPI:22-26) | `{phase:'validate', done: output*capacity+at, total: outputs*capacity, complete:false}` or `{phase:'ready', done:1, total:1, complete:true}` (repeats) | `check`; in capture phase `'receive'`, `stage.start()`: every output slot received to capacity, `ordinal === checkpointCount`, `usedBytes === declared`, else `Error 'Native params result incomplete'`; phase `'validate'`. A capture phase other than `'validate'` → `Error 'Native params validation phase'`. `maxValues` safe 1..16384 (`RangeError 'Native params validation work size'`); scan: index < length must not be ±Infinity (NaN and −0 allowed), index ≥ length must be NaN, else `TypeError 'Native params result finite/NaN tail'`. When done, build the entry (§3.2.6) and phase `'ready'`. |
| `nativeParamsSourcePrepare(ticket, revision)` (P:25; NPS:61-63) | `true` | a pending arm → `Error 'Params unconsumed write'`; `check`; non-noop: `stage.readyEntry()` (`Error 'Native params result not ready'`; no stage → engine `TypeError`); commit plan (X checks); dependents = series whose own `indicator === id`, in series order; release the lease (epoch +1); session closed, leased, or `epoch !== old+1` → `Error 'Native params stale ingestion release'` (a second Prepare with a session fails; without a session it succeeds again); `check`; `assertDataIngestionIdle`; receipt `{schema:'aster.native-params-published', version:1, registration, status: noop?'unchanged':'committed', id, outputs:[...], plotOffsets:{...}}` (the no-op receipt uses the **old** layout); phase `'armed'`. |
| `nativeParamsSourcePublish(ticket, revision)` (P:26; NPS:66) | `{registration, ticket, status, receipt}` (receipt copied) | lookup (`'Params source ticket missing/released'`); owner check; `check`; phase ≠ `'armed'` → `Error 'Native params not armed'`; non-noop: re-check writable series caches; commit (§3.2.6); for each dependent `rangeIndex = null`, `revision = undefined`, `dirtyFrom = 0`; release the staging into the entry; dispose the capture. The bridge stores the receipt and status, clears the row's capture/arm/owner references and the active slot. A pending arm is silently discarded. No `changed()`, no store change, old arrays untouched. |
| `nativeParamsSourceStatus(registration)` (P:27) | `{registration, ticket, status, receipt?}` or `null` (unknown or evicted) | token check (`RangeError 'Params registration'`), then lookup; no side effects |
| `nativeParamsSourceAbort(registration)` (P:28) | same shape, or `null` | token check; if the row is the active source: drop it with `'aborted'` (clears the arm, disposes the capture, releasing the lease and the staging ledger). Otherwise unchanged; a terminal row returns its status; an older registration can never abort a newer job. |

#### 3.2.3 Fingerprint staleness (`npSnapshot`, NPS:20-31)

An ordered array of identities and primitives compared element-wise with `Object.is` (NaN equals NaN; −0 differs from +0). Contents: api, model, store, engine, entries Map, registry Map, columns, controller, `model.disposed`; store `length, capacity, version, timeVersion, maxBars, timeframeMs, timeOrigin`; each column array, its length and its buffer; index with min/max/sum; `engine.checkpointSize`, `maxOutputBytes`; `model.seriesValuesRevision`, `model.dataIngestion`; series, panels and axes lists (identity, length, each row, flattened `SERIES_KEYS`/`PANEL_KEYS`/`AXIS_KEYS` values; series also `rangeIndex`, `rangeIndex.values`, `(tree ?? index).min/max/sum`); flattened view, follow, theme, symbol, precision, axisWidth, priceFormatter, timeFormatter; entries (count; per entry id, entry, flattened def and params, name, revision, dirty, dirtyTo, invalidated, length, arrays identity, length and each array, checkpoints identity and size, and `encodedBytes` for a `NativeCheckpointMap` else 0); registry (count, then each `[name, factory]`); controller (model; flattened gesture, pointers, tool, text, drawingTarget; pointers size); drawings (store, items, undoStack, redoStack, selected, serial, transaction; identities only); ingestion session (flattened policy, paused, count, head, capacity, nextSequence, firstPendingSequence, counters, closed). `flat()` pushes the value and, for plain objects and arrays, the key count plus each key and its flattened value (`Reflect.ownKeys` order; 32768-node and depth-8 budget, `RangeError 'Native params configuration limit'`, X; entries ≤128 `'Native params entry limit'`, registry ≤4096 `'Native params registry limit'`, X).

Not covered: crosshair, `crosshairSnap`, `drawingMagnet`, the latest layout, frame caches, series `revision`/`dirtyFrom`, and `session.leased/epoch` (checked separately). Rust rule: replacing an object, even with equal values, is a change; assigning equal primitives is not; range-cache construction and indicator recalculation are changes.

Measured (s1-s3; check after one action). **Stale:** pointer down, `nativeKey('ArrowLeft')`, `setTool('trendline')`, `setText('Hi')`, `setDrawingTarget({panel})`, `setTheme` (even `{}`), `setVisibleRange` (even equal values), `pan(0)`, `zoom(1)`, `fit` (even repeated), `addPanel`, `setPanel` (even `{}`), `addSeries`, `setSeries` (even an equal color), `addIndicator`, `setIndicatorParams` (other id), `setIndicatorPlacement`, `removeIndicator`, `applyDataEvent`, `addDrawing`, `editDrawing`, `selectDrawing(id)`, `enqueueDataEvents` during the lease (epoch++), `nativeReleaseDataIngestion`, `crosshairValues`/`crosshairSnapshot`/accessibility with a crosshair before any layout cache exists, any read that commits a dirty indicator (`dataAt` calculate mode, `nativeIndicatorBuffer`, `indicatorValues`, `indicatorValueAt`). **Not stale:** `nativeHoverExit`, pointer move (hover) and cancel, `setTool('select')` when already select, `setText('Note')` when already Note, `setDrawingMagnet`, `setCrosshairSnap`, `setDrawingTarget(null)` when already null, undo with nothing to undo, `selectDrawing(null)`, `setIndicatorParams(ema, same params)`, `registerIndicatorModule` (already present), `inspect`, `saveStudies`, `nativeSave`, `nativeSaveWorkspace`, `indicatorValues` on a clean entry, `dataAt`, accessibility without a crosshair, `crosshairValues` after an earlier render, `nativeReleaseFrameCache(s)`. Rejected without state change: `configureDataIngestion`, `compactData` (fence BUSY), pause/resume/cancel (`'Async ingestion lease active'`).

The ingestion lease spans Begin (after validation) to Prepare. A no-op job also holds it until Prepare (measured epoch 1 → 2). Hosts must call Publish in the same owner turn as Prepare.

#### 3.2.4 Source accounting (host-visible: `plan.totalBytes` is admitted and reported as `logicalAdmissionBytes`)

- `sourceBytes` (NPS:44-46): Σ `byteLength` over unique backing buffers, visited in this order: the six store columns (each a `Float64Array` with length ≥ store length); store index min, max, sum; every entry's output arrays (current lengths, which can lag capacity); per series `values`, `rangeIndex.values` and `(rangeIndex.tree ?? rangeIndex)` min, max, sum; ingestion session columns (6) and kinds. Layout to mirror: columns `capacity*8` each; store index 3 × `2*capacity*8`; a series `RangeIndex` (length < 65536) 3 × `2*capacity*8`; a `BlockRangeIndex` values `capacity*8` plus 3 × `2*(capacity/32)*8`; ingestion `6*cap*8 + cap` with `cap = min(maxQueuedEvents, floor(maxQueuedBytes/49))`.
- `oldCheckpointBytes`: a `NativeCheckpointMap` entry adds `encodedBytes + size*128` once at Begin (NPS:45) and is not walked; each record of an ordinary map adds `footprint.logicalBytes + 128` during Step. `otherCheckpointBytes`: for entries other than the target, `NativeCheckpointMap.encodedBytes` plus `footprint.encodedBytes` of ordinary records. `retainedBytes = sourceBytes + oldCheckpointBytes` (equal to the workspace source accounting without drawing frames).
- Admission walk (NPS:52): while records remain and `work < maxRecords`: open the next map's value iterator if needed (exhausted maps advance without counting work); `cost = nativeCheckpointFootprint(state)` (throws `RangeError 'Native checkpoint record byte limit'` once `chars*2 > 262144`, **even for the target's own old records**, where a synchronous `setIndicatorParams` succeeds); `old += logicalBytes + 128`; non-target → `other += encodedBytes`; `work++`; `check(revision)`; `old + sourceBytes > maxBytes` → `RangeError 'Native params retained source budget'`. Step calls = `floor(R/8)+1` for R ordinary records (measured R=3 → 1 call, R=8 → 2, two maps of 8 → 3, 157 → 20).
- Plan (NPS:53), keys in order: `retainedBytes`, `workerSourceBytes = length*48`, `workerOutputBytes = ownerOutputBytes = capacity*outputs*8`, `checkpointBytes = 67108864`, `recordMetadataBytes = count*256`, `scratchBytes = 33554432`, `transferBytes = 262144`, `totalBytes` = integer sum, where `count = length ? floor(length/256)+1 : 0`. Target plan (NPT:24): `sourceBytes = length*48`, `outputBytes = outputs*capacity*8`, `checkpointBytes = 33554432`, `recordMetadataBytes = count*128`, `scratchBytes = 16777216`, `totalBytes`. The source total is always ≥ the target total.
- Measured `nativeInit(600)`: sourceBytes 106496 (6×8192 + 3×16384 + ema 8192); old ema(20) records cost 36+128, 266+128, 266+128 → 952; retained 107448. After `nativeSceneJSON` 156600; with an ingestion ring of 8 → 107840; with a 600-value external series → 112248; `nativeInit(70000)` after a scene → 13935648.

#### 3.2.5 Target functions (fresh empty runtime)

| Function | Returns | Behaviour |
|---|---|---|
| `nativeParamsTargetCreate(text)` (P:29; NPT:12-28) | `true` | busy (§3.0.2) → empty-runtime check (B:24) → creating token → spec: string ≤ 131072 units (`RangeError 'Native params metadata limit'`); codec parse; `optionRecord` with 12 keys, label `'Native params metadata'`; schema `'aster.native-params-target'`, version 1, registration safe ≥ 1, else `TypeError 'Native params protocol'`; `identifier(id,'Indicator id')`, `identifier(name,'Indicator name')`; `validateIndicatorParams`; length 0..4194304 and capacity 16..4194304, ≥ length, a power of two, else `RangeError 'Native params dimensions'`; maxBytes 1..805306368 (`RangeError 'Native params byte limit'`); module binding; `resolveIndicatorFactory` + `requirePortableFactory` (UIE for an unknown name such as `'nope'`); probe `add` for the def; outputs and plotOffsets exactly equal (`TypeError 'Native params output binding'`); outputs·capacity·8 > 268435456 → `RangeError 'Native params output limit'` (X for builtins); target plan; `totalBytes > maxBytes` → `RangeError 'Native params target logical byte limit'`. Allocates six zero-filled `Float64Array(length)`, `received` zeros, phase `'capture'`, a new 32 MiB `NativeCheckpointBudget`. Vacancy and token re-checked (`'Params target creation cancelled'`, X); on failure dispose and clear the token. |
| params-target branch of `nativeAsyncTargetBuffer(slot, offset, count)` | writable column view | target active; phase `'capture'`, slot 0..5, `offset === received[slot]`, count 1..16384, `offset+count ≤ length`, else `RangeError 'Native params input slice'` (no dispose) |
| `nativeParamsTargetStart()` (P:31) | `true` | no target → `Error 'Params target missing'`; closed → `Error 'Native params target closed'`; phase `'capture'` and every column fully received, else `Error 'Native params incomplete input'` (also a second Start; no dispose); phase `'validate'` |
| `nativeParamsTargetStep(maxBars=4096)` (P:32; NPT:33-40) | `{phase, done, total, complete}` with the phase after any transition | `active()` outside the try (`'Native params target closed'`). Inside the try (any error disposes the target, which stays installed and closed): maxBars safe 1..16384 (`RangeError 'Native params work size'`) and equal to the first accepted value (`RangeError 'Native params work size must remain fixed'`, also after ready); phase `'capture'` → `Error 'Native params not started'`. Validate: rows `at..min(n, at+maxBars)` through `validateBar(bar, previous)`; at n build a fresh engine on `{length:n, capacity, columns}` with `NativeCheckpointEntries` and one entry `{def, name, params, dirty:0, dirtyTo:n, invalidated:true, length:0, arrays:[], checkpoints: NativeCheckpointMap(name, params, {budget}), revision:0}`; phase `'calculate'`, return `{calculate, 0, n}`. Calculate: one `next()` of `engine.calculate(id, maxBars)` per step, cold from 0, no convergence, records through `NativeCheckpointMap.set` (32 MiB ledger: `'Native checkpoint total byte limit'`, `'Native checkpoint record byte limit'`); `done` = last yield `to`; at the end `checkpoints.size === count` (`TypeError 'Native params checkpoint count'`, X); phase `'outputs'`. Outputs: scan `maxBars` values; index < n not ±Infinity, index ≥ n NaN (`TypeError 'Native params output finite/NaN'`, X); `done = output*capacity + at`, `total = outputs*capacity`; then `'ready'` `{1,1,true}` (repeatable). |
| `nativeParamsTargetDescriptor()` (P:33; NPT:42) | JS string `safeCheckpointStringify({schema:'aster.native-params-result', version:1, registration, id, name, params, module?, outputs, plotOffsets, length, capacity, checkpointCount, checkpointBytes: budget.usedBytes, plan:{…target plan}})` | `'Params target missing'`; guard; phase `'ready'` else `Error 'Native params target not ready'` (no dispose) |
| `nativeParamsTargetCheckpoint(ordinal)` (P:34) | `{index: ordinal*256, text}` | ready; ordinal safe 0..count−1, else `RangeError 'Native params checkpoint ordinal'`; random access; text over 262144 bytes → `RangeError 'Native params checkpoint record limit'` (X) |
| params-target branch of `nativeAsyncBuffer(registration, slot, offset, count)` | subarray of an output | ready; slot < outputs, offset safe ≥ 0, count 1..16384, `offset+count ≤ capacity`, else `RangeError 'Native params output slice'`; random access and re-reads allowed. After a step error disposed the target, `binding` is null: engine `TypeError` (D8). |

Progress sequences (measured, maxBars 4096): n=600 → calculate 0/600, outputs 0/1024, ready. n=8192 → validate 4096/8192, calculate 0, 4096, 8192/8192 (complete false), outputs 0/8192, 4096, ready. n=0 → calculate 0/0, outputs 0/16, ready.

#### 3.2.6 Import, publish and the checkpoint ledger

`NativeParamsImport` (NPI:9-17), in order: text a string ≤ 131072 units (`RangeError 'Native params result metadata limit'`); codec parse; `optionRecord` with 14 keys (schema, version, registration, id, name, params, module, outputs, plotOffsets, length, capacity, checkpointCount, checkpointBytes, plan; `plan` is never inspected and may be absent), label `'Native params result'`; schema/version (`TypeError 'Native params result protocol'`); registration, id, name, length, capacity `Object.is`-equal to the binding (`TypeError 'Native params result binding'`); dimensions (X); params validated and exactly equal (`TypeError 'Native params result parameters'`); module binding; outputs (1..32, identical, in order) and exact plotOffsets (`TypeError 'Native params result output binding'`); output bytes (X); `checkpointCount === (length ? floor(length/256)+1 : 0)` and `checkpointBytes` a safe integer in 0..`remaining` (`RangeError 'Native params result checkpoint budget'`); a new ledger with limit `remaining = 33554432 − otherCheckpointBytes` and a staging `NativeCheckpointMap`. This in-job budget stays after M0: a document whose other indicators already use most of 32 MiB is rejected here even though the synchronous `setIndicatorParams` succeeds (measured: other 23,770,518 B → remaining 9,783,914 B; sma(100)→sma(3000) on 30000 bars fails at Receive).

The ready entry (NPI:25), key order: `def, name, params, arrays, checkpoints, revision (length?1:0), computedFrom 0, computedUntil length, dirty length, dirtyTo 0, invalidated false, length`. For n=0 this differs from a synchronous add (`invalidated:true`, revision 0).

Publish commit (NC:71-79). Pre-M0 behaviour: the staging `NativeCheckpointMap` becomes the entry's checkpoints with its own fixed ledger (limit fixed at admission). On a plain entries Map: `Map.prototype.set` at the same key position, retire any previously adopted map for this id, register the adoption row. On a restored engine (`NativeCheckpointEntries`): `NativeCheckpointEntries.prototype.set` disposes the old restored map (refunding the shared ledger) and claims the new one. Later growth beyond the fixed limit makes reads throw `'Native checkpoint total byte limit'` (measured: sma 4000→5000 on 36000 bars, then +20000 appended bars → failure at 189 records / 33,468,776 B with the cycled-bar append of the M0 reader, or 202 records / 33,475,452 B with the params reader's append; limit 33,539,654 in both).

**Target behaviour after M0 Task 3** (O4, planned): the published entry gets an ordinary `Map` holding the same records in ascending index order; the ledger is discarded; no adoption registry. Rust then needs only ordinary checkpoint maps in live engines (§3.10.2). The in-job budgets (target 32 MiB ledger, import `remaining`, 256 KiB record limit, admission footprints) stay.

A no-op job publishes `'unchanged'` and keeps the entry identity. Both hosts skip observer notification for `'unchanged'`; the synchronous path always notifies.

#### 3.2.7 Host-checked fields

| Result | Swift | Java |
|---|---|---|
| Begin | object (`'Workspace object receipt'`); `registration` integer ≤ 2^53−1 equal to the job's (`'Params registration'`); `ticket` integer > 0 (`'Params ticket'`) (SW:1175-1178) | `registration` 1..2^53−1 equal to the token (`'Params begin registration'`); `ticket` 1..2^53−1 (JV:1054, `ParamsUpdateJob.java:88`) |
| Step | `complete` a `CFBoolean` (`'Workspace boolean receipt'`); not complete → phase `'admission'` (`'Params admission phase'`); `'noop'` → publish; else phase `'copy'`, `metadataJSON` ≤ 131072 UTF-16 and parsed with ≤ 524288 UTF-8 bytes: schema `'aster.native-params-target'`, version 1, registration, id == request id (`'Params metadata binding'`), length ≤ 4194304, capacity ≤ 4194304, ≥ max(16,length), power of two (`'Params capacity'`); `plan.totalBytes` integer 1..805306368 (`'Params admission bytes'`), then admitted (SW:1080-1091, 1185-1194) | `complete` a Boolean; `'noop'`; else phase `'copy'`; metadataJSON ≤ 131072 chars; only `length` (0..4194304) read from it; `plan.totalBytes` 1..805306368 (JV:1055) |
| acknowledgements | exactly `true` for Check, TargetCreate, TargetStart, Receive, ArmWrite, Checkpoint, Prepare (`'Workspace true receipt'`) | `Boolean.TRUE.equals` (`'Params acknowledgment'`, JV:1083) |
| buffers | `asterTypedBytes` on all four buffer calls | JNI exact `count*8` bytes; Java `'Params transfer length'` |
| TargetStep | phase ∈ {validate, calculate, outputs, ready}, `complete == (phase=='ready')`, done/total integers ≤ 134217728, `done ≤ total` (SW:1247-1251) | same phase rule; done/total 0..2^53−1 (JV:1062) |
| Descriptor | string ≤ 131072 UTF-16, ≤ 524288 UTF-8; schema `'aster.native-params-result'`, version 1, registration, length == plan.length, capacity == plan.capacity, outputs `[String]` 1..32, capacity·outputs·8 ≤ 268435456 (`'Params result bounds'`); checkpointCount == (length==0 ? 0 : length/256+1) and ≤ 16385, checkpointBytes 0..33554432 (`'Params checkpoint count'`) (SW:1256-1267) | ≤ 131072 chars; only outputs length 1..32, capacity 16..4194304 power of two, checkpointCount 0..16385 (JV:1063) |
| TargetCheckpoint | `index` == ordinal·256, text ≤ 131072 UTF-16 (`'Params checkpoint record'`) | text a String; index 0..4194304, multiple of 256, == i·256 |
| Validate | `complete` Bool; phase ∈ {validate, ready}, `complete == (phase=='ready')` (`'Params validation phase'`) | `complete` a Boolean only |
| Publish/Status/Abort | object; registration equal; status ∈ {active, committed, unchanged, failed, aborted}; for committed/unchanged the receipt: schema, version 1, registration, id, status equal; outputs `[String]` 1..32 unique non-empty ≤128 UTF-16; plotOffsets keys ⊆ outputs, values non-boolean finite integers with absolute value ≤ 10000 (SW:978-1001). `null` leaves the job pending. | `JSONObject.NULL` → `'unknown'`; registration equal; status String in {active, failed, aborted, committed, unchanged, unknown}; receipt binding; output names not `__proto__`/`constructor`/`prototype`; offsets −10000..10000 (JV:1084-1096) |

Internal payloads: the checkpoint record texts (opaque to hosts beyond ≤131072 units and the index rule) and the result slices. Keep the JS `safeCheckpointStringify` text for records anyway: the 256 KiB record limit, both ledgers and the declared-bytes equality are measured in its UTF-16 length. `metadataJSON` and the descriptor are **not** free formats: iOS parses the fields listed above.

#### 3.2.8 Host flows (unchanged)

- Swift (SW:1169-1353): `setIndicatorParamsAsync(_:params:timeout:30, maxBarsPerStep:4096, …)` checks owner, main, closed, `workspaceAvailability`, `activeAsync == nil`, timeout, id 1..128 UTF-16, maxBarsPerStep 1..16384, revision ≤ 2^53−1 (`'Params request bounds'`), valid JSON (`'Params request must be valid JSON'`), sorted-keys JSON ≤ 131072 bytes re-parsed (`'Params request size'`; JS therefore receives NSDictionary order), unchanged context and revision (`'Params source changed during arguments'`); registry reserve (process counter for params; `BaroChartNativeAdmission` 2 slots / 768 MiB, else `busy`; capture lease). Start: Begin. Admit: one Step per main turn. Worker (`Thread.detachNewThread`): new VM + context, TargetCreate; 6 columns in 16384 chunks (main Check + `nativeAsyncBuffer(ticket,…)`, worker `nativeAsyncTargetBuffer`); TargetStart; TargetStep loop; Descriptor; main Receive; per output slot and 16384 chunk, worker `nativeAsyncBuffer(registration,…)` then **one** main turn with Check + ArmWrite + `nativeAsyncTargetBuffer` + copy; per ordinal, worker TargetCheckpoint then main Checkpoint; main Validate until ready. Publish: Prepare, check, `cancelled` linearization, `publishing = true`, outcome unknown, Publish; on throw `recover()` (Status, then Abort if `'active'`); must end released (`'Params publication unresolved'`). A recover failure → `cleanupPending(registration, outcome)`.
- Java (JV:1043-1082, `ParamsUpdateJob.java:88-119`): same order through the `Host` interface; the no-op path calls Check then Prepare; the target is `create(sourceBundle)`; result reads use `readBuffer(target, registration, …)`; writes are ArmWrite then JNI `writeBuffer`; `cleanupOnOwner` resolves unknown publications through Status and releases through Abort.

#### 3.2.9 Limits

Registration safe ≥ 1, strictly increasing per runtime (Swift process counter per job kind, Java one counter shared with workspace, ≤ 2^53−1); 4 terminal records; admission records 1..64 (hosts 8); all slices 1..16384 values; target maxBars 1..16384 fixed after the first step; validate maxValues 1..16384 (hosts 16384); metadata, descriptor and record text ≤ 131072 UTF-16 units; record bytes ≤ 262144; target ledger 33554432; other ≤ 33554432; output bytes ≤ 268435456; length 0..4194304; capacity 16..4194304 power of two; fingerprint 32768 nodes, depth 8; host budget 2 jobs and 805306368 bytes per process.

#### 3.2.10 Goldens (scratch `tier-a-params-async/`)

- `g1.mjs`, `nativeInit(600)`, ema `{}` → `{period:9}`: Begin `{"ticket":1,"registration":1,"phase":"admission"}`; Step → metadata `{"schema":"aster.native-params-target","version":1,"registration":1,"id":"ema","name":"ema","params":{"period":9},"length":600,"capacity":1024,"outputs":["value"],"plotOffsets":{},"maxBytes":805306368}`, plan `{"retainedBytes":107448,"workerSourceBytes":28800,"workerOutputBytes":8192,"ownerOutputBytes":8192,"checkpointBytes":67108864,"recordMetadataBytes":768,"scratchBytes":33554432,"transferBytes":262144,"totalBytes":101078840}`. Descriptor `{"schema":"aster.native-params-result","version":1,"registration":1,"id":"ema","name":"ema","params":{"period":9},"outputs":["value"],"plotOffsets":{},"length":600,"capacity":1024,"checkpointCount":3,"checkpointBytes":212,"plan":{"sourceBytes":28800,"outputBytes":8192,"checkpointBytes":33554432,"recordMetadataBytes":384,"scratchBytes":16777216,"totalBytes":50369024}}`. Records `{index:0,text:'{}'}`, `{index:256,text:'{"e":{"count":9,"sum":0,"value":103.06557277375316}}'}`, `{index:512,text:'{"e":{"count":9,"sum":0,"value":108.56781382079213}}'}`. Publish `{"registration":1,"ticket":1,"status":"committed","receipt":{"schema":"aster.native-params-published","version":1,"registration":1,"status":"committed","id":"ema","outputs":["value"],"plotOffsets":{}}}`. Values equal the synchronous path (`v[8]=100.05017894276605`, `v[599]=107.22927311230852`).
- Budget boundaries (`e2`, `e4`): maxBytes 107447 → `'Native params retained source budget'`; 107448 and 101078839 → `'Native params combined logical byte limit'`; 101078840 → copy. Target maxBytes 50369023 → `'Native params target logical byte limit'`; 50369024 → true.
- No-op (`g3`): Begin phase `'noop'`, Step `{"phase":"noop","complete":true}`, Publish status `'unchanged'`. n=0: plan total 100927360; descriptor checkpointCount 0, plan total 50331776. n=1: retained 1828, checkpointBytes 4, target total 50331952.
- `nativeInit(40000)`: 19 admission steps, then copy with retainedBytes 6877290, totalBytes 110811498; descriptor checkpointCount 157, checkpointBytes 16126.
- ichimoku conversion 8: receipt outputs `["tenkan","kijun","spanA","spanB","chikou"]`, plotOffsets `{"spanA":26,"spanB":26,"chikou":-26}`. Pressure factor .25: metadata and descriptor carry `"module":{"id":"aster.volume-direction","version":1,"stateVersion":1,"exportName":"pressure","causal":true}` right after params; record 0 `{"previous":{"$asterNumber":"NaN"},"cumulative":0}`.
- Errors (`e1`-`e9`): registrations `undefined, null, 0, -1, 1.5, '1', NaN, 2^53, true` → `'Params registration'`; a Begin in an empty runtime → `TypeError 'Workspace own data slot: nativeModel'` with Status(1) null; after six aborted Begins Status(1) = Status(2) = null.

### 3.3 Ingestion queue, unchanged batch, release

Map §3.6 is correct for the snapshot validator, lease/fence, policy validation, `save()` and `restoreDataIngestion`. This section adds the queue state machine, receipts, accounting, the envelope, the unchanged batch and the release function. The queue is a bounded FIFO per model of sequenced append/update/correction events stored in owned Float64 columns (49 bytes per event). There are no timers; the host drains.

#### 3.3.1 Session slot and data model

`model.dataIngestion` has four states: `undefined` (never configured), an open session, a **closed session still attached** (after `nativeReleaseDataIngestion`), and `null` (after model dispose). `ingestion()` (`api.mjs:101`) maps `undefined`/`null` to `IngestionError NOT_CONFIGURED 'Configure data ingestion first'`; a closed attached session is returned and every op then throws `CLOSED 'Ingestion session closed or replaced'`.

| Part | Rust representation |
|---|---|
| Policy (frozen, canonical key order) | `streamId` (WTF-16, 1..128 units, not reserved), `generation` (safe ≥ 0, no default), `firstSequence` (default 0), `maxQueuedEvents` (1..4096, default 4096), `maxQueuedBytes` (49..16777216, default 262144), `maxBatchEvents` (1..4096, default 128), `maxStoredBars` (0..store.maxBars, default store.maxBars), `maxStoreBytes` (1536..402653184, default 402653184). Defaults use `??`, so `null` takes the default. Integers may be −0. |
| Ring | six `Vec<f64>` (time, open, high, low, close, volume) + `Vec<u8>` kinds (0 append, 1 update, 2 correction); `capacity = min(maxQueuedEvents, floor(maxQueuedBytes/49))` (1..4096); `head`, `count`; enqueue writes slot `(head+count+i) % capacity`; values stored bit-exactly (−0 survives) |
| Cursors | `nextSequence`, `firstPendingSequence` as f64 safe integers (may be −0; use f64 so `-0 + n` behaves as JS); `sourceVersion`; `epoch` |
| Flags | `paused`, `leased`, `draining` (true only inside drain; never host-visible), `closed` |
| Counters | 10 keys `accepted, applied, cancelled, rejectedPackets, rejectedEvents, failedDrains, peakPendingEvents, peakPendingBytes, lastAppliedSequence, lastCancelledSequence`; f64 safe integers, the last two nullable. Canonical order for configured sessions; **document order** for loaded sessions (`{...counters}`, ingestion.mjs:129), kept on later updates. Rust: a struct plus a key-order permutation. |
| `lastError` | `null` or `{code, message}`; a loaded one keeps the document's key order (`{message, code}` is possible); a computed SOURCE_CHANGED is always `{code, message}` |

#### 3.3.2 `nativeDataIngestionCommand(operation, args=[])` (B:90-94)

- `operation` not one of the 9 ops → `TypeError 'Unknown ingestion command'`, thrown, not enveloped (this includes `applyDataEvents` and `compactData`).
- Otherwise `nativeAPI.dispatch(op, args)` (`api.mjs:72-77`: `apiActive`; args not an Array → `TypeError 'Unknown chart command or argument list'`; more than the arity (configure/enqueue/drain/load 1, others 0) → `TypeError 'Chart command argument count'`).
- Success: `{result: X}` with `X = dispatch(...) ?? null` (not frozen; all results are objects except `saveDataIngestion`, a string).
- Failure: `{error:{name:'IngestionError', code, message}}`, keys in this order. `code` = the IngestionError code, else `'INVALID_DOCUMENT'` for `loadDataIngestion` and `'INVALID_INPUT'` for every other op. `message = String(error.message).slice(0,256)` (UTF-16; may split a pair). Before `nativeInit` the `nativeAPI` ReferenceError is enveloped with engine text (V8 `'nativeAPI is not defined'`, JSC `"Can't find variable: nativeAPI"`, QuickJS `"'nativeAPI' is not defined"`; compare the code only, D8).
- The same 9 ops through `nativeCommand` throw `IngestionError` raw; hosts never use that path.

#### 3.3.3 Operations, in exact check order

| Op | Checks | Effect and return (key order) |
|---|---|---|
| `configureDataIngestion(options)` (`api.mjs:102`; ingestion.mjs:44-64) | `apiActive` → fence (BUSY `'Model has an active async ingestion fence'`) → `old?.idle()` (CLOSED / BUSY `'Ingestion has an active async lease or drain'`) → `old?.count` → PENDING_DATA `'Drain or cancel pending data before reconfiguration'` → `new DataIngestion`: `ingestionRecord(options, 8 keys, 'Ingestion policy')`; `identifier(streamId,'Stream id')` rewrapped as INVALID_INPUT; integer ranges in the order generation, firstSequence, maxQueuedEvents, maxQueuedBytes, maxBatchEvents, maxStoredBars, maxStoreBytes (`'<field> integer range'`); STORE_BUDGET `'Current history exceeds ingestion admission budget'` if `store.length > maxStoredBars` or `96*capacity > maxStoreBytes` | install, dispose the old session, return the new stats. New session: epoch 0, `sourceVersion` = store version, `nextSequence = firstPendingSequence = firstSequence`. |
| `enqueueDataEvents(packet)` (:74-90) | `ingestion()` (NOT_CONFIGURED) → owner guard → active (CLOSED) → leased (BUSY `'Async ingestion lease active'`) → paused (PAUSED `'Ingestion paused'`) → `source()` (§3.3.4) → `ingestionRecord(packet, [streamId, generation, firstSequence, events], 'Packet')` → `snapshotIngestionEvents(events)` (map §3.6.2) → repeat the state checks → strict `streamId`/`generation` equality (`0` matches `-0`) else STREAM_MISMATCH `'Packet stream/generation mismatch'` → firstSequence safe ≥ 0 else INVALID_INPUT `'firstSequence integer range'` → `firstSequence !== nextSequence` → SEQUENCE_MISMATCH `'Packet firstSequence must equal nextSequence'` → `n > capacity-count` → QUEUE_BUDGET `'Packet exceeds queued event/typed-byte budget'` → `nextSequence > 2^53-1-n` or `accepted > 2^53-1-n` → SEQUENCE_LIMIT `'Sequence/counter limit'` → owner guard | write the ring; if the queue was empty `firstPendingSequence = firstSequence`; `count += n`, `nextSequence += n`, `accepted += n`, epoch++; `peakPendingEvents = max(peak, count)`, `peakPendingBytes = peak*49`. Returns `{events, firstSequence, nextSequence, pendingEvents, pendingBytes}` (`pendingBytes = count*49`). **Every rejection** (unless closed) increments `rejectedPackets` (only while < 2^53−1) and adds the already-snapshotted event count to `rejectedEvents` (saturating; 0 if the failure was before or inside the snapshot), then throws (non-IngestionErrors rewrapped as INVALID_INPUT with the message sliced to 256). BUSY and PAUSED rejections count too. |
| `drainDataEvents(maxEvents = policy.maxBatchEvents)` (:92-107) | `ingestion()` → active/idle (CLOSED; BUSY `'Ingestion has an active async lease or drain'`) → paused (PAUSED) → `source()` (SOURCE_CHANGED wins and does not count as a failed drain) → `ingestionInteger(maxEvents, 1, maxBatchEvents, 'Drain count')` (absent → default; `null` is not a default) → empty queue → empty receipt | `n = min(maxEvents, count)`; `events = prefix(n)` FIFO `{kind, bar}`; `draining = true`; an append while a series has truthy `values` → EXTERNAL_ALIGNMENT `'Length-changing ingestion requires host realignment of external values'`; `store._applyEvents(events, {maxBars: maxStoredBars, maxStoreBytes}, ledger)` (map §3.4.8). The ledger runs after the column commit and **before** the store listeners: head advances, `count -= n`, `firstPendingSequence += n`, `applied += n`, `lastAppliedSequence = first+n-1`, `sourceVersion = store.version+1`, epoch++. Any failure before commit: `failedDrains++` (saturating), `paused = true`, `lastError = {code:'DRAIN_FAILED', message: cause.slice(0,256)}`, throw `IngestionError('DRAIN_FAILED', message)`; queue and epoch unchanged. Returns `{events, appended, from, to, version, length, capacity, bytes, firstSequence, lastSequence}`; the empty receipt is `{events:0, appended:0, from:L, to:L, version:V, length:L, capacity:C, bytes:96*C, firstSequence:null, lastSequence:null}`. |
| `pauseDataIngestion()` / `resumeDataIngestion()` (:108-109) | active → not leased (BUSY `'Async ingestion lease active'`) | pause: `paused = true`, epoch++ (also when already paused). resume: `sourceVersion` = current store version (acknowledges an external change; pending events kept), `paused = false`, `lastError = null`, epoch++. Return stats. |
| `cancelDataEvents()` (:110) | active → not leased | `events = count`; `firstSequence = firstPendingSequence`; `lastSequence = first+events-1`; `cancelled += events`; if events > 0 `lastCancelledSequence = lastSequence`; `count = head = 0`; `firstPendingSequence = nextSequence`; epoch++. Returns `{events, firstSequence, lastSequence}` (both null when 0). Does **not** clear paused or lastError. |
| `dataIngestionStats()` (:111-112) | active | read-only. Key order: `policy{8 keys}, state, nextSequence, <10 counters in session order>, pendingEvents, pendingBytes, ownedBytes (capacity*49), lastError, storedBars (store.length), storeBytes (96*capacity)`. `state` = `'busy'` if leased or draining, else `'paused'` if paused or source-changed, else `'running'`. |
| `saveDataIngestion()` (:113) | active | `safeCheckpointStringify({schema:'aster.ingestion', version:1, policy, state ('paused'\|'running', never 'busy'), nextSequence, counters, lastError, pending:{firstSequence, events:[{kind, bar:{time,open,high,low,close,volume}}]}})`. −0 is written `{"$asterNumber":"-0"}`. A lone-surrogate streamId → `TypeError 'Checkpoint Unicode scalar'` (enveloped as INVALID_INPUT; iOS only). Host-visible and app-persisted: byte-identical across backends. |
| `loadDataIngestion(text)` (`api.mjs:110`; :117-133) | `apiActive` → fence → `old?.idle()` → `old?.count` → PENDING_DATA `'Cancel or drain pending data before restoration'` → `restoreDataIngestion(model, text)` (map §3.6.6, `allowBudgetMismatch` false) | install, dispose the old session, return stats; restored epoch 0, head 0, counter and lastError key order from the document. On failure the old session is untouched; non-IngestionErrors (codec errors, engine `SyntaxError`) become INVALID_DOCUMENT with the message sliced to 256. `policy.firstSequence:null` takes 0 and then fails conservation. `save(load(text)) === text` for every saved text. |

#### 3.3.4 Source changes and `lastError` precedence

Pending payload is bound to the store version as of the last enqueue, drain commit, resume, configure/load or compaction. Any other publication (typed apply, `setData`, single events, typed or unchanged batches, async or workspace publish) changes the version.
- `sourceStatus()` (read-only; stats and save): `changed = count > 0 && store.version !== sourceVersion`; reports `paused || changed`, and while changed reports the computed `{code:'SOURCE_CHANGED', message:'Source changed outside ingestion while payload is pending'}` instead of a stored `lastError` such as DRAIN_FAILED. After cancel (count 0) the stored DRAIN_FAILED is reported again (measured p20).
- `source()` (mutating; enqueue and drain only): with `count > 0` it sets `paused = true` and the stored `lastError`, then throws SOURCE_CHANGED (an enqueue counts as a rejected packet with +0 events; a drain does not count as failed). With `count == 0` it silently rebases `sourceVersion` (no epoch change).

Epoch increments: enqueue success, drain commit, pause (even when paused), resume, cancel, lease acquire, lease release, compaction commit. Unchanged by rejections, failed drains, stats/save, silent rebases and dispose. Workspace and params finish depend on `epoch == leaseEpoch + 1`.

#### 3.3.5 Session budgets in typed batches

`ChartAPI.applyDataEvents` (`api.mjs:100`, used by `applyDataEvent({kind:'batch'})`, the `applyDataEvents` op and `nativeApplyUnchangedDataEvents`) passes `{maxBars: policy.maxStoredBars, maxStoreBytes: policy.maxStoreBytes}` whenever `model.dataIngestion` is truthy, **including a closed attached session**. The store checks the resulting length and `96*capacity`, so once single appends, `setData`, `setColumns`, prepend or reset (which ignore the policy) have grown the store past the policy, every typed batch fails, update-only batches included: `RangeError 'Data batch bar budget limit <maxStoredBars>'` (checked first) or `'Data batch store byte budget limit <maxStoreBytes>'` (own `code:'STORE_BUDGET'`, not host-visible). Through `nativeCommand` the receipt is the frozen `{events, appended, from, to, version, length, capacity, bytes}` with no `unchanged` key (arity 1 forbids options).

#### 3.3.6 `nativeApplyUnchangedDataEvents(events)` (T:6-22)

1. Read own data globals `nativeAPI`, `nativeModel`, `nativeInput`; missing → `TypeError 'Native batch own data required'`.
2. Snapshot `store.version`, columns, index, length, capacity; owner check (`StaleSourceError 'Native batch owner/source changed'`, also for a disposed model).
3. `ChartAPI.prototype.applyDataEvents.call(api, events, {skipUnchanged:true})`; errors are thrown raw (IngestionError INVALID_INPUT/EXTERNAL_ALIGNMENT with code, store RangeErrors). Unchanged detection compares final values with `Object.is` (−0 replacing 0 counts as changed).
4. Owner check; copy the 9 receipt keys; `afterVersion = store.version`; self-validation (`TypeError 'Native batch receipt invalid'`, `'Native batch publication version'`, both X); owner check.
5. Return frozen `{schema:'aster.native-data-batch', version:1, beforeVersion, afterVersion, unchanged, receipt: frozen {events, appended, from, to, version, length, capacity, bytes, unchanged}}`.

Hosts call it directly, **bypassing `command()` and its BUSY gate** (SW:1716-1742; JV:339-353), validate the envelope (map §3.16.7, Appendix B) and notify when `!unchanged` or the revision moved; on failure with the same open context they notify conservatively and rethrow.

#### 3.3.7 `nativeReleaseDataIngestion()` (B:13) and the closed attached session

Returns `{cancelled: session?.count ?? 0, pendingEvents:0, ownedBytes:0}`; never throws. `session.dispose()` is idempotent: `cancelled += count`, `lastCancelledSequence` set if count > 0, `count = head = 0`, `firstPendingSequence = nextSequence`, `closed = true`, `leased = false`, ring freed, model/store references nulled, policy kept. It does **not** detach the session (D9). Afterwards (measured): every op, configure and load included, gives CLOSED (so no new session until `nativeInit`); typed batches still get the closed session's budgets; `compactData` with removal > 0 → `Error 'Compaction requires paused empty idle ingestion unless preserving retained pending data'`; `nativeWorkspaceSourceBegin` → `TypeError 'Workspace own data slot: time'`; async begins → CLOSED. Only Swift `close()` calls it (SW:1592, followed by `closed = true`), so the consequences are reachable only through raw calls. Java never calls it.

#### 3.3.8 Host behaviour (backend-independent)

- Swift `command()` (SW:1612-1675): envelope `error` present → `name == 'IngestionError'`, code a non-empty string ≤ 64 UTF-16 units, message a string ≤ 256 units, else `invalidScene`; then `BaroChartIngestionError(code, message)`. `result` must not be `undefined` (`null` accepted). Notifies after every successful op except stats and save (zero-event drains and cancels included). BUSY gate (SW:1618-1620): `compactData` and the 7 mutators (not stats, not save) throw `BaroChartIngestionError('BUSY','Native asynchronous job is active')` while an async job is uncommitted, a workspace or params job is active, or a pending registration is still in a registry.
- Java `command()` (JV:212-253): `getString('code'/'message')` without name or length checks (`getString` coerces); a missing `result` throws `JSONException`. Gates (JV:216-218) as in §3.1.10. Notifies except stats and save.
- Classification: Swift `BaroChartIngestionError` is `budgetExceeded` only when the **code** matches `budget|limit|full` (case-sensitive, practically never), message `'Ingestion <CODE>: <msg>'`; text `'IngestionError: …'` uses the message, case-insensitive. Java `IngestionException` is `BUDGET_EXCEEDED` when the **message** matches `(?s).*(budget|limit|full).*` (case-sensitive): `'Packet exceeds queued event/typed-byte budget'`, `'Sequence/counter limit'`, `'Checkpoint text limit'`, `'Stream id: string limit 128'` and a DRAIN_FAILED `'Data batch bar budget limit 9'` all classify as budget. Messages must be verbatim.

#### 3.3.9 Goldens (scratch `tier-a-ingestion-queue/`; JSC and QuickJS outputs in `goldens-jsc.txt`, `goldens-quickjs.txt`)

- `configureDataIngestion([{streamId:'s',generation:0}])` on 4 bars → `{"result":{"policy":{"streamId":"s","generation":0,"firstSequence":0,"maxQueuedEvents":4096,"maxQueuedBytes":262144,"maxBatchEvents":128,"maxStoredBars":4194304,"maxStoreBytes":402653184},"state":"running","nextSequence":0,"accepted":0,"applied":0,"cancelled":0,"rejectedPackets":0,"rejectedEvents":0,"failedDrains":0,"peakPendingEvents":0,"peakPendingBytes":0,"lastAppliedSequence":null,"lastCancelledSequence":null,"pendingEvents":0,"pendingBytes":0,"ownedBytes":200704,"lastError":null,"storedBars":4,"storeBytes":1536}}`.
- Policy `{streamId:'s', generation:7, firstSequence:40, maxQueuedEvents:8, maxQueuedBytes:392, maxBatchEvents:3, maxStoredBars:12, maxStoreBytes:1536}`: 20 mixed rejections → rejectedPackets 20, rejectedEvents 19; a valid 3-event packet → `{"events":3,"firstSequence":40,"nextSequence":43,"pendingEvents":3,"pendingBytes":147}`; empty drain → `{"events":0,"appended":0,"from":4,"to":4,"version":3,"length":4,"capacity":16,"bytes":1536,"firstSequence":null,"lastSequence":null}`; drain(2) of [update 3, append 4, …] → `{"events":2,"appended":1,"from":3,"to":5,"version":4,"length":5,"capacity":16,"bytes":1536,"firstSequence":40,"lastSequence":41}`.
- −0 (`p10`): configure `{streamId:'s', generation:-0, firstSequence:-0}` and enqueue an update with open/close/volume −0 → save `{"schema":"aster.ingestion","version":1,"policy":{"streamId":"s","generation":{"$asterNumber":"-0"},"firstSequence":{"$asterNumber":"-0"},"maxQueuedEvents":4096,…},"state":"running","nextSequence":1,…,"pending":{"firstSequence":{"$asterNumber":"-0"},"events":[{"kind":"update","bar":{"time":1700000180000,"open":{"$asterNumber":"-0"},"high":1,"low":-1,"close":{"$asterNumber":"-0"},"volume":{"$asterNumber":"-0"}}}]}}`; cancel → `{"events":1,"firstSequence":0,"lastSequence":0}` with firstSequence −0 and lastSequence +0.
- Saturation (`p9`): firstSequence 9007199254740990 + 2 events → SEQUENCE_LIMIT; +1 → nextSequence 9007199254740991. Loaded rejectedPackets 2^53−1 and rejectedEvents 2^53−2, then a 2-event rejection → both 9007199254740991.
- `p11` replays the Swift fixture `verifyNativeIngestion` (`examples/native/ingestion-verification.swift:55-164`) step by step, including the two save texts quoted by the reader; `p12` compaction with a session (§3.5.1); `p13`/`p14` async and workspace interplay; `p8` unchanged-batch envelopes (`{"schema":"aster.native-data-batch","version":1,"beforeVersion":3,"afterVersion":3,"unchanged":true,"receipt":{"events":1,"appended":0,"from":3,"to":4,"version":3,"length":4,"capacity":16,"bytes":1536,"unchanged":true}}`).

### 3.4 Data exploration (`dataAt`, `nativeDataExploration`)

Two synchronous single-runtime APIs; no JS engine is needed. Hosts check only that results are objects (or `null` for `dataAt`), never notify and never BUSY-gate these calls (SW:1671 read-only list, SW:1814-1838; JV:252, JV:525-531).

#### 3.4.1 `nativeCommand('dataAt', [query, options?])` (`api.mjs:149` → DX:33-90)

**Validation order** (measured precedence):
1. dispatch (`apiActive`; more than 2 args → `TypeError 'Chart command argument count'`);
2. query record: falsy, an array, a primitive or a non-plain object → `TypeError 'Data selection plain record'`; an own key outside `index, time, match` (Reflect.ownKeys order) → `TypeError 'Data selection fields'`; accessor or non-enumerable → `'Data selection own data fields'` (X);
3. options record (absent → `{}`; `null` and arrays rejected): `TypeError 'Data query options plain record'`, `'Data query options fields'` (keys `asOfIndex, includeHidden, indicatorMode`);
4. range: if `index` is an own key, it must be the only key and a safe integer ≥ 0 (−0 accepted), else `RangeError 'Data query index'`; otherwise the keys must be exactly `time` and `match`, `time` a safe integer with |time| ≤ 8640000000000000 (inclusive) and `match` `'exact'`/`'at-or-before'`, else `RangeError 'Data query time and explicit match'` (`{}` lands here);
5. `includeHidden` present and not boolean → `TypeError 'Data query hidden flag'` (`null` rejected);
6. `indicatorMode` present and not `'calculate'`/`'cached'` → `TypeError 'Data query indicator mode'`;
7. cutoff = `asOfIndex ?? length-1`, a safe integer with −1 ≤ cutoff < length, else `RangeError 'Data query cutoff'`;
8. if `model.symbol` is non-null: `boundedText(id,128,'Symbol id')`, `(currency,64,'Currency')`, `(volumeUnit,64,'Volume unit')` → `TypeError '<label>: string limit <n>'`. This runs **before** the lookup, so it fails even for null results and empty stores. Reachable: `setSymbol` (markets.mjs:30) does not bound these lengths.

**Lookup** (DX:55-57): by index directly; by time a lower bound over `columns.time[0..length)` (`mid = (lo+hi)>>>1`), then an exact match, or `lo-1` for at-or-before. Result `null` if `index < 0`, `index ≥ length` or `index > cutoff` (`asOfIndex:-1` always gives null). `-0 === +0`, so a query time 0 matches a stored −0 and the returned time stays −0.

**Result** (DX:88), key order `{index, time, asOfIndex, storeVersion, primary:{symbol: null | {id, currency, volumeUnit}, bar:{time, open, high, low, close, volume}}, series:[row…]}`. Row key order (DX:66): `{id, label (s.label ?? s.id), panel, axisId (?? null), symbolId (external: s.symbolId ?? null; else the primary symbol id or null), visible (s.visible !== false), type, kind ('source'|'external'|'indicator'), causality ('stored-source'|'host-aligned'|'unverified-study'|'canonical-builtin'), offset (s.offset ?? 0), source (kind source: s.source ?? 'close', else null), indicator, output, value, sourceIndex, sourceTime, status}`. Raw doubles, −0 preserved (`dataAt({index:-0})` returns index −0).

**Rows: two phases.** Phase 1 runs over `model.series` in order, skipping `visible === false` unless `includeHidden`: `sourceIndex = index - offset` (f64 subtraction, keeps signed zero); `kind`; causality (`'canonical-builtin'` iff the entry name is one of the 35 builtins; `pressure` and any linked module stay `'unverified-study'`). For indicator rows `output = s.output ?? def.outputs[0]`. Status, first match wins:
1. `sourceIndex < 0` or `≥ length` → `'outside-source'` (sourceIndex/sourceTime null);
2. `sourceIndex > cutoff` → `'after-cutoff'` (null/null);
3. indicator, `cutoff < length-1`, not canonical → `'unsupported-causality'` (null/null);
4. indicator, cached mode, not canonical → `'unsupported-cache'` (sourceIndex and sourceTime set, value null);
5. otherwise a pending item: an external row checks its values (a `Float64Array` shorter than the store → `TypeError 'Data query Float64 column length'`, thrown here before any calculation; reachable after append/prepend because external values are never realigned; longer vectors are read by raw index); a source row uses the store column; a cached indicator row applies cached readiness.

Phase 2, items in order: cached-pending → `'pending'` (sourceIndex, sourceTime set, value null); calculate mode → `IndicatorEngine.get(id)` at most once per id in row order (this **commits** a lazy recalculation, map §3.7.8), then `array[sourceIndex]`. `value = Number.isFinite(v) ? v : null`; status `'value'` or `'non-finite'`; `sourceTime = time[sourceIndex]`. Indicators of hidden, outside, after-cutoff or unsupported rows are never computed; a canonical builtin with a historical cutoff still computes the full dirty range, so later errors propagate. Calculation errors propagate unchanged.

**Cached readiness** (DX:77, :12), one snapshot per entry: ready iff `dirty === length && dirtyTo === 0 && invalidated === false && entry.length === length`; arrays null or empty → pending; `arrays.length !== outputs.length` → `TypeError 'Data query cached output shape'` (X); `arrays[k]` null → pending; not a `Float64Array` → `'Data query cached Float64 output'` (X); length ≠ capacity → pending. Rust entries must expose JS-identical readiness metadata with per-output vectors sized to capacity. Entries installed by `setIndicatorParams`, params import, async publish and workspace restore are clean, so a cached read hits at once (measured after restore).

#### 3.4.2 `nativeDataExploration(action, argument)` (E:6-29, K:1-36)

Checks in order, before any engine access:
1. `action` exactly one of `'setActive', 'navigate', 'refresh', 'read'`, else `TypeError 'Exploration action'`;
2. `setActive` needs a boolean (`'Exploration active boolean'`); `navigate` needs one of `'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'` (`'Exploration navigation key'`; Enter and Escape rejected); `refresh`/`read` take an absent or null argument (`'Exploration action takes no argument'`);
3. own data globals `nativeModel`, `nativeAPI`, `nativeInput`, `model.store`, `store.version`; missing → `TypeError 'Exploration owner data property required'` (reachable in a runtime without `nativeInit`);
4. owner check (`StaleSourceError 'Native exploration owner/source changed'`, X);
5. only `setActive(true)` while `nativeInput.gesture` is non-null → `Error 'Exploration requires an idle gesture'` (the gesture is not cancelled; other actions are allowed during a gesture);
6. explorer lookup in a `WeakMap` keyed by `nativeAPI` (E:2, **checked**), created inactive when absent. A new `nativeAPI` (from `nativeInit`, `nativeAsyncFinish`, `nativeWorkspaceTargetFinish`) means a fresh inactive explorer, silently;
7. action; busy flags (X).

Result: a fresh object `{schema:'aster.native-data-exploration', version:1, active, time, index, seriesId, phase, text}`. Inactive: `{active:false, time:null, index:null, seriesId:null, phase:'off', text:''}`. Active: `index` recomputed on every call as the exact stored position of `time`, or −1; phases returned are `'off'`, `'selected'`, `'changed'`, `'missing'`, `'read'` (the internal `'error'` phase is never observable because every later action resets it).

State machine (K:8-33):
- `setActive(b)`: `active = b`; if b: `time = length ? time[max(0, min(n-1, floor(view.to)))] : null`, `seriesId` = first visible series or null, phase `'selected'`; else phase `'off'`, text `''`.
- every other action first runs `changed()`: no-op when inactive; else reconcile `seriesId` to the first visible row if it is no longer visible, phase `index < 0 ? 'missing' : 'changed'`.
- `navigate`: inactive → `Error 'Enable data exploration first'`. Home/End select the first/last stored time; ArrowLeft/Right move one bar (clamped) only when the selection exists; ArrowUp/Down move one visible row (clamped; a missing current row counts as position 0); then reconcile; phase `index < 0 ? 'missing' : 'selected'`.
- `refresh`: returns the snapshot after `changed()`.
- `read`: inactive → `Error 'Enable data exploration first'`; missing selection → phase `'missing'` without a query; else `api.dataAt({time, match:'exact'})` with default options (calculate mode, visible rows, cutoff length−1), phase `'read'`, read text. Errors propagate (e.g. the symbol bound errors).

Texts (K:6, K:12, K:30, each `.slice(0,4096)` in UTF-16 units):
- no bars: `'No stored bars. Home or End selects a bar after data arrives.'`; selection gone: `'Selected bar is no longer available. Press Home or End to select a stored bar.'`;
- selection: `` `Bar ${index+1} of ${length}; stored time ${time} UTC ms. ${row ? `Series ${row.id}; panel ${row.panel}; axis ${row.axisId ?? 'default'}.` : 'No visible series.'} ${phase==='changed' ? 'Data or display changed. ' : ''}Press Enter to read current plotted values.` ``;
- read: `` `${symbol ? `${symbol.id}; currency ${symbol.currency}; volume unit ${symbol.volumeUnit}. ` : ''}Bar ${r.index+1}; stored time ${r.time} UTC ms. Open ${N(open)}; high ${N(high)}; low ${N(low)}; close ${N(close)}; volume ${N(volume)}. ${row ? `Series ${row.id}; panel ${row.panel}; axis ${row.axisId ?? 'default'}; ${row.status}; value ${row.value===null ? 'unavailable' : N(row.value)}; plot offset ${row.offset}; source index ${row.sourceIndex ?? 'none'}; source time ${row.sourceTime ?? 'none'} UTC ms.` : 'No visible series.'} Current plotted values, cutoff ${r.asOfIndex}; revised data, not historical arrival-time truth.` ``.
`N(v) = Object.is(v,-0) ? '-0' : Number::toString(v)` for OHLCV and value only; every other interpolation is JS `ToString` (−0 prints `0`).

#### 3.4.3 Cross-protocol effects

A calculate-mode `dataAt`, an explorer `read`, `nativeIndicatorBuffer`, `indicatorValues` and `indicatorValueAt` on a dirty entry commit `{dirty:n, dirtyTo:0, invalidated:false, length:n, revision++, arrays}`. Active sources compare these fields, so the next check fails (measured): params `StaleSourceError 'Native params stale: source/owner changed'` (status `'failed'`), workspace `StaleSourceError 'Workspace source stale: owner/data/configuration changed'`, async `Error 'Async stale: data/configuration/revision changed'`. `setActive`, `navigate`, `refresh` and cached reads leave sources valid. Rust must commit at exactly the same points.

#### 3.4.4 Not ported: resample and bar replay

`resample.mjs`, `resample-plan.mjs` and `bar-replay.mjs` are bundled (S:4) but reachable only through the raw `globalThis.Aster` namespace (`validateResamplePlan`, `resamplePlanResolver`, `resampleOHLCV`, `resampleFromSessions`, `alignConfirmedByTime`, `BarReplay`). No `native*` global, `COMMANDS` op or host code calls them, `call()`/`invoke()` resolve only single global names (SW:1430, JNI:59), and their inputs (typed arrays, `SessionCalendar` instances, `new`) are not JSON-expressible. Tier J: drop from the Rust scope (map §7 risk 11 listed resample).

#### 3.4.5 Goldens (scratch `tier-a-exploration/`)

- `nativeInit(5)`, `setActive(true)` → `{"schema":"aster.native-data-exploration","version":1,"active":true,"time":1700000240000,"index":4,"seriesId":"price","phase":"selected","text":"Bar 5 of 5; stored time 1700000240000 UTC ms. Series price; panel price; axis default. Press Enter to read current plotted values."}`.
- read on volume at bar 5 → `'Bar 5; stored time 1700000240000 UTC ms. Open 100.18698402891457; high 100.75703699483125; low 99.20410251904465; close 99.75883578651771; volume 8905. Series volume; panel volume; axis default; value; value 8905; plot offset 0; source index 4; source time 1700000240000 UTC ms. Current plotted values, cutoff 4; revised data, not historical arrival-time truth.'`
- `nativeInit(5)`, `dataAt({index:4})` → `{"index":4,"time":1700000240000,"asOfIndex":4,"storeVersion":2,"primary":{"symbol":null,"bar":{"time":1700000240000,"open":100.18698402891457,"high":100.75703699483125,"low":99.20410251904465,"close":99.75883578651771,"volume":8905}},"series":[{"id":"price","label":"price","panel":"price","axisId":null,"symbolId":null,"visible":true,"type":"candles","kind":"source","causality":"stored-source","offset":0,"source":"close","indicator":null,"output":null,"value":99.75883578651771,"sourceIndex":4,"sourceTime":1700000240000,"status":"value"},…,{"id":"ema",…,"kind":"indicator","causality":"canonical-builtin",…,"indicator":"ema","output":"value","value":null,"sourceIndex":4,"sourceTime":1700000240000,"status":"non-finite"}]}`.
- Status corpus (`p5`, 30 bars, sma3, pressure `p` with shift 2): at index 10 `pr` → `{"id":"pr","label":"pr","panel":"price","axisId":null,"symbolId":null,"visible":true,"type":"histogram","kind":"indicator","causality":"unverified-study","offset":2,"source":null,"indicator":"p","output":"cumulative","value":3600,"sourceIndex":8,"sourceTime":481000,"status":"value"}`; with asOfIndex 11 → `'unsupported-causality'`; cached → `'unsupported-cache'` (sourceIndex 8, value null); cached with asOfIndex 20 → `'unsupported-causality'` (causality beats cache).
- Signed zero (`p8`): read text `'Bar 1; stored time 0 UTC ms. Open -0; high 1e+21; low -1.5e-7; close -0; volume -0. Series o; panel price; axis default; value; value -0; plot offset 0; source index 0; source time 0 UTC ms. …'`.
- Error corpus (`p4`) as listed in §4.4; restore (`p18`): the target explorer is inactive and cached `dataAt` returns ema `'canonical-builtin'` `'value'` 102.66127423767902, identical to the source.

### 3.5 Tier-A `nativeCommand` ops not fully covered by the main map, and `pressure`

All of these are synchronous: no tickets, workers or internal payloads. Every return value reaches the host or the app, so receipts and the `aster.studies`/`aster.drawings` texts must be byte-exact. Validate completely before mutating, then swap. Interaction gating (G = `controller.gesture`, P = pointers non-empty, T = drawing transaction; natively T implies G) is summarized in §3.5.16. `invalidationFailed` is always `false` natively (the bridge `invalidate` is a no-op), but the key keeps its position.

#### 3.5.1 `compactData(options)` (`api.mjs:85` → compaction.mjs:38-92)

Order: dispatch `apiActive` → (X capture checks) → `model.disposed` → `Error 'Chart disposed'` → `compactionRecord(options)` (falsy or non-plain → `TypeError 'Compaction options plain data compactionRecord'`; an own key outside `keepLastBars, studyHistory, maxPeakStoreBytes, pendingData` → `TypeError 'Compaction options own data properties'`) → `keepLastBars` safe integer 1..4194304 (−0 fails) and `studyHistory === 'restart'`, else `RangeError 'Positive keepLastBars and studyHistory restart required'` → `pendingData` undefined, `'preserve-retained'` or `'reject'` (null fails), else `TypeError 'Compaction pendingData policy'` → `limit = maxPeakStoreBytes ?? 805306368` (null = default; −0 accepted) a safe integer 0..805306368, else `RangeError 'Compaction source peak byte limit'` → length 0 → `RangeError 'Cannot compact an empty store'` → **`keep ≥ length`: return the removed-0 receipt** with no event and none of the following checks (works during an async fence or a gesture) → (X) exclusive owners → `assertDataIngestionIdle` (IngestionError BUSY `'Model has an active async ingestion fence'`) → T → `Error 'Compaction during drawing transaction'` → G (pointers alone allowed) → `Error 'Compaction during interaction gesture'` → any series with values → `Error 'Compaction requires host realignment of external values'` → any **panel** with scale `'percent'` and `base === undefined` (axes not checked) → `Error 'Compaction percent panel requires an explicit base'` → (X `TypeError 'Compaction visible range'`) → session present and (model/store mismatch, closed, raw `paused` false, count > 0 without `'preserve-retained'`, draining or leased) → `Error 'Compaction requires paused empty idle ingestion unless preserving retained pending data'`; with `'preserve-retained'` run the pending revalidation **even when count is 0** → `C2` = 16 doubled while < keep; `96*(C+C2) > limit` → `RangeError 'Compaction source peak byte budget'` (equality passes).

Pending revalidation (compaction.mjs:16-37), all reachable: `q.sourceVersion !== store.version` → `Error 'Compaction pending source version changed'` (so a store change outside ingestion makes `'preserve-retained'` fail while the default policy succeeds); then FIFO rows from the virtual tail `time[L-1]`: append needs `time > tail` (`'Compaction pending append must follow virtual tail'`, then tail = time); update needs `time === tail` (`'Compaction pending update must match virtual tail'`); correction needs a time appended earlier in this queue or found by binary search in the retained range `[removed, L)` (`'Compaction pending correction requires retained timestamp'`).

Commit (cannot fail): each entry clears its checkpoints (a bounded map stays bounded and refunds its ledger) and gets `arrays=[]`, `dirty=0`, `dirtyTo=keep`, `invalidated=true`, `length=0`, `computedFrom=0`, `computedUntil=0`, `preparedVersion=undefined`; **`revision` is kept** (the next read reports revision+1). Series: `rangeIndex=null`, `revision=undefined`, `dirtyFrom=0`. Store swapped. View: `span = to-from; F = Math.max(0, ...offsets of visible series); end = (keep+F)-.5; from = follow ? end-span : Math.max(-.5, Math.min(end-span, view.from-removed)); to = from+span` (new object). `model.crosshair = null`; follow unchanged. Session `sourceVersion` = new version, epoch+1. Change record `{from:0, kind:'compact', version, removed, studyHistory:'restart'}`. Drawings, undo/redo, panels, axes, symbol, controller fields and frame caches are untouched.

Receipt (plain, key order): `removed, length, capacity, bytes (96*capacity), previousBytes (96*old capacity), peakSourceBytes (96*(C+C2) when removed>0, else 96*C), firstRetainedTime (time[removed]), version, timeVersion, studyHistory:'restart', invalidationFailed`. Hosts check `removed` (integral 0..4194304) and notify iff > 0 (SW:1630-1634; JV:170-177, 222-224).

#### 3.5.2 `setColumns(data, length?)` (`api.mjs:87`, :58-64; data.mjs:113-153)

For `time, open, high, low, close, volume` in this order: `values(data?.[key], length)`: not an Array (nor a `Float64Array`) → `TypeError 'Values must be Float64Array or a JSON array'`; any element of the **whole** array (also past `length`) that is not null/number, or is NaN/±Infinity → `TypeError 'Finite numbers or null gaps required'`; convert (null → NaN, −0 kept) before reading the next column. Then `store.setColumns`: `length !== undefined` → `sizeLimit(length, 4194304, 'Bar count')` (`null`, `'2'`, 1.5, −1 fail; **−0 is accepted and stored as length −0**); default length = time column length; a shorter column → `TypeError 'Numeric column arrays required'`; row-major validation inside `length` (null gap → `TypeError 'Every OHLCV field must be finite'`, then the time, order and envelope messages of map §3.4.2), root volume overflow → `RangeError 'Volume sum overflow'`; commit with change `{from:0, kind:'reset'}` (fit, entries reset, series `dirtyFrom=0`). Atomic. Returns `null`.

#### 3.5.3 Panels and axes

| Op | Behaviour |
|---|---|
| `addPanel(o)` → id (model.mjs:148) | `optionRecord(PANEL_KEYS,'Panel')` → `identifier(id,'Panel id')` → 32 panels → `RangeError 'Panel limit'` → duplicate id or `!Number.isFinite(weight ?? 1)` or `(weight ?? 1) <= 0` → `Error 'Unique panel id and positive weight'` → record `{weight:1, scale:'linear', inverted:false, padding:.08, ...options}` → `validatePanel` (explicit `weight:null` → `RangeError 'Panel scale/range'`; `range:null` is stored as null) → T → `Error 'Panel layout change during drawing transaction'`. No gesture check. |
| `setPanel(id, patch)` (`api.mjs:112` → model.mjs:152) | patch falsy, non-object or array → `TypeError 'Panel patch object'`; `next = {...patch}`; `range:null`/`base:null` become `undefined` in place; `optionRecord(PANEL_KEYS minus id, 'Panel patch')`; missing id (not validated) → `Error 'Missing panel'`; merge and `validatePanel`; during T: any weight change, a strip-width change, or a projection change (scale, inverted, padding, range elementwise `Object.is`, base, axisVisible, axisSide) of a panel used by a drawing in items or the transaction snapshot → `Error 'Panel projection change during drawing transaction'`. Always replaces the record object. |
| `setPanelOrder(ids)` → boolean (model.mjs:153-169) | `strictArrayValues(ids,'Panel order',32)` → `TypeError 'Panel order dense array required'`; wrong length → `TypeError 'Panel order must contain every current panel exactly once'`; per id `identifier(id,'Panel order id')`, then a duplicate or unknown id → **`Error`** (not TypeError) with the same message; G or P → `Error 'Panel layout change during active gesture'` (also when unchanged); unchanged → `false` without `changed()`; else installs a new array of the same panel objects and returns `true`. Swift requires a JS boolean and notifies iff true (SW:1635-1637); Java requires `Boolean` (JV:247-248). |
| `removePanel(id)` (model.mjs:170-184) | `identifier(id,'Panel id')` → G or P → `'Panel layout change during active gesture'` → `'Missing panel'` → `'Cannot remove the last panel'` → `'Panel is referenced by series'` → `'Panel is referenced by axis'` → (unreachable natively) `'Panel is referenced by an active drawing transaction'` → a drawing in items/undo/redo on it → `'Panel is referenced by drawing history'` (all `Error`). Then a new filtered array; the API sets `drawingTarget = null` (no cancel) when it referenced the panel. |
| `addAxis(o)` → id (model.mjs:233) | `optionRecord(AXIS_KEYS,'Axis')` → 64 axes → `RangeError 'Axis limit'` → `axes.some(id===options.id)` → `Error 'Duplicate axis'` (before id validation) → record `{side:'right', scale:'linear', inverted:false, padding:.08, visible:true, tickFormat:'fixed', ...options}` → `validateAxis`: `'Axis id'`/`'Axis panel'` identifiers; `Error 'Missing axis panel'`; `validatePanel` on the axis scale fields (messages read `'Panel …'`); `TypeError 'Axis side/visibility/format/width'` (width finite 20..256); `'Axis prefix: string limit 64'`/`'Axis suffix: string limit 64'` (empty allowed); percent: base 0 → `RangeError 'Panel scale/range'`, non-finite base → `RangeError 'Independent percent axis requires an explicit nonzero base'` → T and strip widths change → `Error 'Axis layout change during drawing transaction'`. No gesture check. |
| `setAxis(id, patch)` (`api.mjs:116` → model.mjs:234) | `optionRecord(patch, AXIS_KEYS minus id/panel, 'Axis patch')` **before** the spread (`null` → `'Axis patch: object required'`; `id`/`panel` → `'Axis patch: unsupported field id'`); null range/base → undefined; `Error 'Missing axis'`; merge, `validateAxis`; T with a strip-width change or a projection change (scale, inverted, padding, range, base, width, side, visible) of an axis used by a drawing → `Error 'Axis projection change during drawing transaction'` |
| `removeAxis(id)` (model.mjs:235-252) | `identifier(id,'Axis id')` → referenced by a series (`axisId ?? null`) or by a drawing in items, undo/redo or the transaction snapshot → `Error 'Axis is referenced by series or drawing history/transaction'` → new array (an unknown id still replaces the array) → strip widths change and T → `'Axis layout change during drawing transaction'` → strip widths change and (G or P) → `'Panel layout change during active gesture'` (removing a hidden axis never changes widths). The API nulls a drawing target that referenced the axis. |

#### 3.5.4 `setDrawingTarget(target|null)` (`api.mjs:147` → interaction.mjs:55)

`null`: global cancel, then `drawingTarget = null`. Otherwise: `optionRecord(['panel','axisId','seriesId'],'Drawing target')` (absent → `'Drawing target: object required'`) → `next = {panel:'price', ...target}` (an explicit `panel:null` fails) → `identifier(next.panel,'Drawing target panel')` → if `seriesId != null` and `axisId === undefined` and the series exists, append `axisId = series.axisId ?? null` → `model.validateDrawingBinding(next)` (`'Drawing axisId: string limit 128'`, `'Missing drawing panel'`, `'Missing drawing axis binding'`, `'Missing or mismatched drawing series binding'`) → **only then** `controller.cancel({notify:false})`, a global cancel that rolls back any transaction, restores the gesture's start view and follow, and clears pointers → set. A failing call changes nothing.

#### 3.5.5 `crosshairSnapshot(width, height)` (`api.mjs:151`; crosshair-snap.mjs:27-35, ohlc-snap.mjs:2-17)

`createLayout(model, width, height)` runs **first** (no coercion: a non-number, NaN or a size outside 100..16384 × 80..16384 → `RangeError 'Chart needs at least 100 × 80 CSS pixels'`, U+00D7), so layout errors and lazy study calculation happen even when the result is null. Then: no crosshair → `null`; no panel contains (x, y) → `null`; mode = the cursor's recorded request mode (same model, `Object.is` x and y) else `'free'`. Result key order: `mode, raw{x,y}, resolved{x,y}, panel, snapped, reason ('free'|'no-eligible'|'snapped'), index, time, field ('open'|'high'|'low'|'close'|null), price, axisId, seriesId, storeVersion`. Free → base result. Target `request.options.target ?? {panel: hovered}`; another panel → base with `'no-eligible'`; `nearestVisibleOHLC` (close mode uses only `close`) null → base; else snapped with raw OHLC price, `axisId: target.axisId ?? null` and `storeVersion`. Does not touch `nativeSize`; no notification. Measured on `nativeInit(64)`, 1200×700, cursor (600,300), ohlc: resolved x 363.15500000000003, y 136.49348819790325, field `'low'`, price 102.86555645310622, index 63, time 1700003780000.

#### 3.5.6 `setSeriesValues(id, values)` (`api.mjs:193` → model.mjs:278)

`values()` conversion first (`'Values must be Float64Array or a JSON array'`, `'Finite numbers or null gaps required'`), then missing series or converted length ≠ store length → `TypeError 'Aligned values and existing series required'`; candles/ohlc or indicator-bound → `TypeError 'External values require a general non-indicator series'`. Mutates the same series object in place: `values` (key appended when new), `dirtyFrom = 0`, per-series revision+1, `model.seriesValuesRevision = (prev ?? 0) + 1`. `inspect` shows `valueCount` last.

#### 3.5.7 `setIndicatorPlacement(id, placement)` → `{changed}` (`api.mjs:208` → model.mjs:185-223)

`identifier(id,'Indicator id')` → no entry → `Error 'Missing indicator'` → no bound series → `Error 'Indicator has no bound series'` → placement record (`TypeError 'Indicator placement record required'`, `'Indicator placement fields'`, `'Indicator placement panel required'`, identifiers `'Indicator placement panel'`/`'Indicator placement axis'`; axisId absent/undefined/null → null) → `Error 'Missing placement panel'` / `'Missing placement axis'` → G or P → `'Panel layout change during active gesture'` (also when nothing moves) → `changed` = bound series whose panel or `axisId ?? null` differ; 0 → plain `{changed:0}` without `changed()`; else each moved series is replaced by a clone (same key order and prototype, panel overwritten in place, **`axisId` written explicitly and appended when absent, value possibly `null`**, `rangeIndex`/`revision`/`dirtyFrom` copied, no cache reset), a new series array, and `changed({changed:n})`. A drawing target whose `seriesId` is bound gets a cloned target with the new panel/axisId (no cancel). The appended `axisId:null` appears in `inspect`, `saveStudies` and workspace series. Hosts check `changed` integral 0..256 and notify iff > 0.

#### 3.5.8 `indicatorValues(id, output?)` (`api.mjs:231`)

`indicators.get(id)` computes lazily (commit, §3.4.3): `Error 'Missing indicator: <String(id)>'` (`undefined` → `'Missing indicator: undefined'`), calculation errors, and on restored engines `'Native checkpoint record byte limit'`/`'Native checkpoint total byte limit'`. `key = output ?? first output`; not an own output (`''`, unknown) → `Error 'Missing indicator output'`. Returns `store.length` elements: finite numbers (−0 kept) or `null`. No notification.

#### 3.5.9 `registerIndicatorModule(id, version)` → `string[]` (`api.mjs:243` → indicator-modules.mjs:32)

`identifier(id,'id')` (`TypeError 'id: string limit 128'` / `'id: reserved identifier'`) → id contains `@` or `/` → `TypeError 'Indicator module id'` → version not a safe integer ≥ 1 (`'1'`, 1.5, 0, absent) → `TypeError 'Indicator module version'` → look up `id+'@'+version` in the linked table; a miss → `UnsupportedIndicatorError 'Unsupported indicator module: ' + (id+'@'+version).slice(0,128) + '; requires a canonical builtin or linked factory'` (code `UNSUPPORTED_INDICATOR_MODULE`) → per export, a registry entry bound to another factory → `Error 'Indicator module name conflict'` (unreachable in Rust) → `registry.set` (a no-op: every registry already holds every linked factory) → `changed(names)`. Rust: a static table with only `aster.volume-direction@1` → `["aster.volume-direction@1/pressure"]`, idempotent; any other id@version gives the identical UIE (§3.7).

#### 3.5.10 `saveStudies()` and `loadStudies(text)` (`api.mjs:244-245` → study-setup.mjs:11-20, :52-72)

Save: entries in Map order: `requirePortableFactory` (UIE, unreachable in Rust) → `validateIndicatorParams` → `{id, name, params:{...e.params}, module?}` (module = the frozen descriptor `{id, version, stateVersion, exportName, causal:true}`, linked modules only); series = `model.series` with a truthy `indicator`, picked in `SERIES_KEYS` order minus `values` (undefined dropped, null kept, e.g. `fill:null` and an appended `axisId:null`); `portableStyle(copy, colors, true)` validates only (fails only for raw legacy colors); `safeCheckpointStringify({schema:'aster.studies', version:1, indicators, series})` (−0 params → `{"$asterNumber":"-0"}`).

Load: `safeCheckpointParse` (non-string or > 8388608 → `RangeError 'Checkpoint text limit'`; duplicate keys, depth, untagged 1e400, markers; engine `SyntaxError`) → `optionRecord(['schema','version','indicators','series'],'Study setup')` → wrong schema/version, non-arrays, > 128 indicators or > 256 series → `TypeError 'Study setup schema/count'` → live + new over 128/256 → `RangeError 'Study setup capacity'` → candidate engine. Per definition: `optionRecord(['id','name','params','module'],'Study definition')` → `validateIndicatorParams` (missing → `'Indicator params'`) → id in this document or live → `Error 'Duplicate study id'` (before id validation) → portability: `requirePortableFactory(name)` (unknown → UIE, never `'Unknown indicator'`; in Rust this position also hosts the §3.7 rule) → module must equal `indicatorModule(name)` (both absent, or the same 5 keys compared order-insensitively with `Object.is`; `module:null` or a module on a builtin → `TypeError 'Study module version/codec mismatch'`) → `candidate.add` (identifier, factory errors, full calculation). Per series: `optionRecord(SERIES_KEYS minus values,'Study series')` → indicator not imported by this document → `Error 'Study series requires an imported indicator'` → id used → `Error 'Duplicate study series id'` → `normalizedSeries(portableStyle(s, colors, true))` (uppercase 6/8-digit hex kept verbatim). Commit: `entries.set` for each new id (already computed), `model.series = series.concat(added)`. Returns `{indicators, series}` counts. Atomic.

#### 3.5.11 `positionMetrics(id)` (`api.mjs:256` → position-drawing.mjs:3-10)

First item with that id (hidden drawings and drawings inside a create transaction included); none or not `longposition`/`shortposition` → `TypeError 'Position drawing required'`. Key order `direction, startTime, endTime, entry, stop, target, risk, reward, riskPercent, rewardPercent, ratio`. `risk = (entry-stop)*sign`, `reward = (target-entry)*sign`, `ratio = reward/risk`, `percent(v) = (v/Math.abs(entry))*100` or `null` when non-finite. Measured short {0.3, 0.4, 0.1}: risk 0.10000000000000003, reward 0.19999999999999998, ratio 1.9999999999999991, riskPercent 33.33333333333335, rewardPercent 66.66666666666666.

#### 3.5.12 Group drawing edits (drawing-translation.mjs:27-103, drawing-style-patch.mjs:3-10)

Pre-checks (translate, style, visibility): `apiActive` → disposed → G or T → `Error 'Drawing group edit requires no active gesture or transaction'` (pointers alone fine) → ids a plain array (`TypeError 'Drawing group edit plain array required'`) of ≤ 128 (`RangeError 'Drawing group edit array limit/shape'`) → options record (`TypeError 'Drawing group edit plain record required'` / `'Drawing group edit fields'`) → 0 ids → `RangeError 'Drawing group edit requires 1..128 ids'` → per id `identifier('Drawing id')`, duplicate → **`TypeError` `'Duplicate drawing id'`** → mode checks. **Duplicates validate the options record first, before the gesture check.**
- translate: both deltas finite numbers, else `TypeError 'Finite deltaTimeMs and deltaPrice required'`; anchors `{time: dt===0 ? t : t+dt, price: dp===0 ? p : p+dp}` (−0 deltas are no-ops).
- style: `drawingStylePatch`: no keys or an undefined/null value → `TypeError 'Drawing style nonempty defined patch required'`; then color, fill (`'Color string required'`, `'Color: string limit 128'`, `RangeError 'Portable color: hex, comma RGB/RGBA or basic named color required'`), font (`'Font: string limit 256'`, `RangeError 'Font size limit: 4..96px'`), width finite 0.1..50 (`RangeError 'Stroke width'`, strings too). `'Drawing style plain record required'` and `'Drawing style fields'` are unreachable through this op (the group record check fires first). A drawing changes iff some patch key is absent or differs by `Object.is` (normalizing `#f5b85a` to `#f5b85aff` counts as a change); new style `{...previous, ...patch}` (new keys appended in patch order; a style key appended to a drawing without one).
- visibility: `visible` not boolean → `TypeError 'Drawing visibility boolean required'` (after ids); locked drawings allowed; changes iff `(before.visible !== false) !== visible`; the key is appended when absent; hiding the selected drawing clears the selection; once present the `visible` key keeps the document at version 4.
- duplicate: `metadata = !(dt===0 && dp===0)` (−0 counts as 0); locked allowed; with metadata the identical-binding and live-binding checks apply; zero deltas keep the frozen points array and allow orphans and mixed panels; candidate `{...before, points, locked:false}` (overwrites in place or appends).
Walk in z-order: a selected locked drawing → `Error 'Drawing is locked'` (translate/style; may precede `'Missing drawing'`); the first selected drawing fixes the binding; a mismatch → `Error 'Drawing group edit requires identical panel/axis/series binding'`; binding not live → `Error 'Missing or mismatched drawing binding'`; `validateDrawing(candidate)` (overflow → `TypeError 'Anchor time/price must be finite and within Date range'`; position rounding → the position `RangeError`s). After the walk: a missing id → `Error 'Missing drawing'`; duplicates: items + copies > 10000, points > 200000 or text > 1,000,000 → `RangeError 'Drawing duplication resource limit'`; ids `'drawing-'+(++serial)` skipping existing and new ids; rows `{sourceId, id}` in **source z-order**; the would-be document JSON length > 8388608 → `RangeError 'Drawing duplication document limit'`. `changed == 0` → receipt with no state change. Otherwise one undo entry (redo cleared; trim to 100 entries and 33554432 bytes, weight `8*len + Σ 2*JSON length`); duplicates set `serial` to the last allocated (undo does not roll it back).
Receipts: `{changed, invalidationFailed:false}`; duplicates frozen `{changed, created: frozen [{sourceId, id}], invalidationFailed:false}`. Host checks: translate/style `changed` 0..128, single visibility ≤ 1, group visibility ≤ 128, notify iff > 0; duplicates `changed` ≥ 1 (exactly 1 for the single form), `created` length == changed, rows of exactly two non-empty ≤128 strings, distinct, always notify (SW:1643-1670). Java rejects `changed 0` for duplicates too: `DrawingTranslationReceipt.changed` returns `value > 0` and `!changed(...)` raises `JSONException 'Drawing duplication receipt shape'` (JV:180-187, :239; **checked**).

#### 3.5.13 `deleteDrawing(id = selected)` and `saveDrawings()`

`deleteDrawing` (`api.mjs:265`, drawings.mjs:34): the default applies only when the id is absent. Interactive = a gesture exists; items = the transaction snapshot when interactive with a transaction, else live items. A create gesture whose `gesture.id === id` and id not in those items → cancel (removes the uncommitted drawing) and return **`false`**. Else `drawings.remove(id, ctx)`: not found or locked → `false`, no side effects (a gesture stays). Otherwise the gesture is cancelled first (edit rolls back; pan restores the start view; pointers cleared), the drawing is removed in its own transaction (one undo entry, redo cleared), the selection cleared if needed → `true`. Hosts always notify.

`saveDrawings` (`api.mjs:267`): T → `Error 'Commit or cancel before saving'`; JSON length > maxDocumentChars → `TypeError 'Drawing document: string limit 8388608'`; byte-identical to `nativeSave`, but runs `apiActive` first (`'Chart disposed'` on a disposed model, where `nativeSave` still answers). Read-only.

#### 3.5.14 `setText(text)` and `pan(delta)`

`setText` (`api.mjs:272`): no controller, a non-string or more than 2000 UTF-16 units → `TypeError 'Drawing text, at most 2000 characters'` (`''` allowed); sets `controller.text` (default `'Note'`), used only when the text tool creates a drawing. Not in inspect or documents, but part of the workspace-source fingerprint (setText during a capture stales it, measured). `pan` (model.mjs:298): `setVisibleRange(view.from+delta, view.to+delta)` with JS `+`: numbers add, `true`/`false` add 1/0, `null` adds 0; absent, strings, arrays and objects give NaN or strings → `RangeError 'Visible range'`; a rounding collapse (delta 1e308) → the same error.

#### 3.5.15 Linked study `aster.volume-direction@1/pressure` (trusted-studies.mjs:5-18; D10)

- Factory: after `validateIndicatorParams`, destructure `{factor=1, shift=0}` (defaults only for absent keys; other keys ignored); `!Number.isFinite(factor)` (strings fail), `|factor| > 1`, `!Number.isInteger(shift)` or `|shift| > 10000` → `RangeError 'Volume-direction factor/shift'`. Outputs `['signed','cumulative']`; plotOffsets `{signed:shift, cumulative:shift}` (−0 kept).
- State `{previous: NaN, cumulative: 0}`; step: `signed = Number.isNaN(previous) ? 0 : (Math.sign(close-previous)*volume)*factor; previous = close; cumulative += signed; return [signed, cumulative]` (JS `Math.sign`, keeps ±0 and NaN; the first row is literal +0). Overflow of `cumulative` → `TypeError 'Output must be finite or NaN'`.
- Engine path: not canonical, so no convergence: recompute from `floor(dirty/256)*256` to n, restoring that checkpoint; checkpoints `{previous, cumulative}` in this key order at every 256 boundary and at n when `n % 256 == 0`; keys > n deleted.
- Descriptor (frozen, key order): `{id:'aster.volume-direction', version:1, stateVersion:1, exportName:'pressure', causal:true}`; written by `saveStudies`/`saveWorkspace`; `loadStudies` requires it exactly (order-insensitive).
- Checkpoint validation on restored engines (checkpoint-validation.mjs:124-125 → indicator-modules.mjs:38-47 → trusted-studies.mjs:13-17): index safe 0..4194304 else `TypeError 'Checkpoint state integer'`; `validateIndicatorParams`; round trip through the codec; `optionRecord(state, ['previous','cumulative'], 'Volume-direction checkpoint')`; exactly 2 keys, numeric `previous`, finite `cumulative`, and at index 0 `isNaN(previous) && cumulative === 0` (±0), else finite `previous`; failure → `TypeError 'Volume-direction checkpoint'`.
- `dataAt` causality stays `'unverified-study'`.
- Measured: closes 10, 11, 11, 9 with volumes 5, 7, 8, 9 and `{factor:1, shift:2}` → signed [0,7,0,−9], cumulative [0,7,7,−2]; factor −0 on rising closes → signed [0,−0,−0,…], cumulative all +0; checkpoint texts on `nativeInit(600)` with factor 0.5: key 0 `{"previous":{"$asterNumber":"NaN"},"cumulative":0}` (100 B, 3 nodes, logical 196), key 256 `{"previous":103.31460301074992,"cumulative":-39481}`, key 512 `{"previous":108.73631051368729,"cumulative":2896.5}`.

#### 3.5.16 Interaction gating summary

| Op | Rejects |
|---|---|
| `compactData` | T (`'Compaction during drawing transaction'`), then G (`'Compaction during interaction gesture'`); only when keep < length |
| group edits | G or T; duplicates check options first |
| `setPanelOrder`, `removePanel`, `setIndicatorPlacement` | G or P (`'Panel layout change during active gesture'`), even when unchanged |
| `removeAxis` | G or P only when strip widths change |
| `addPanel`, `addAxis`, `setPanel`, `setAxis` | only T with a layout or projection change |
| `setDrawingTarget` | never; cancels globally after validation |
| `deleteDrawing` | never; cancels G only when it really deletes, or for the uncommitted create drawing |
| `saveDrawings` | T |
| others in §3.5 | none |

#### 3.5.17 Goldens (scratch `tier-a-advanced-ops/`, probes `t1`-`t26`)

- `nativeInit(300)`, `compactData({keepLastBars:300,studyHistory:'restart'})` → `{"removed":0,"length":300,"capacity":512,"bytes":49152,"previousBytes":49152,"peakSourceBytes":49152,"firstRetainedTime":1700000000000,"version":2,"timeVersion":2,"studyHistory":"restart","invalidationFailed":false}`; keep 100 → `{"removed":200,"length":100,"capacity":128,"bytes":12288,"previousBytes":49152,"peakSourceBytes":61440,"firstRetainedTime":1700012000000,"version":3,"timeVersion":3,"studyHistory":"restart","invalidationFailed":false}`, view {99.5, 299.5} → {−100.5, 99.5}; non-following {50,150}, keep 200 → {−0.5, 99.5}; maxPeakStoreBytes 61439 → budget error, 61440 passes.
- Group edits (`t3`): `duplicateDrawings(['c','b'], {deltaTimeMs:60000, deltaPrice:0})` → created `[{"sourceId":"b","id":"drawing-3"},{"sourceId":"c","id":"drawing-4"}]` (source z-order); `setDrawingsStyle(['a','b'],{color:'blue',width:2})` → changed 2, repeat → 0; `{fill:'#ff000080'}` on b → style `{"color":"#0000ffff","width":2,"fill":"#ff000080"}`.
- Placement (`t7`, `t15`): `{panel:'p2', axisId:'A'}` → `{"changed":2}`; after `setIndicatorPlacement('ema',{panel:'p2'})`, `saveStudies` → `{"schema":"aster.studies","version":1,"indicators":[{"id":"ema","name":"ema","params":{}}],"series":[{"id":"ema","type":"line","panel":"p2","indicator":"ema","color":"#f0b755","width":1.5,"offset":0,"axisId":null}]}`.
- `saveStudies` with pressure, ema and a −0 param (`t8`): `{"schema":"aster.studies","version":1,"indicators":[{"id":"p","name":"aster.volume-direction@1/pressure","params":{"factor":1,"shift":2},"module":{"id":"aster.volume-direction","version":1,"stateVersion":1,"exportName":"pressure","causal":true}},{"id":"e","name":"ema","params":{"period":2,"source":"close"}},{"id":"z","name":"sma","params":{"period":2,"zero":{"$asterNumber":"-0"}}}],"series":[{"id":"ps","type":"histogram","panel":"price","indicator":"p","color":"#112233ff","width":1.5,"offset":2},{"id":"es","type":"line","panel":"price","indicator":"e","output":"value","color":"#7898ff","fill":null,"width":1.5,"offset":0,"label":"EMA 2"}]}`; reloading it on a fresh chart gives `{"indicators":3,"series":2}` and a byte-identical re-save.
- `registerIndicatorModule('aster.volume-direction',2)` → `UnsupportedIndicatorError: Unsupported indicator module: aster.volume-direction@2; requires a canonical builtin or linked factory`.
- Key-order goldens for panels, axes and series records change with M0 Task 1 (§3.10.1).

### 3.6 Public low-level surface

#### 3.6.1 Function table, `supports`, empty engines, transports

- **Function table.** The Rust table lists every one of the 100 names with a status: implemented, `UnavailableError` stub (`nativeRegisterIndicatorSource`, §3.7) or not-ported stub (§2.6). `bc_supports(name)` is true for every name in the table, stubs included, and the answer does not change when the engine is poisoned (Swift `close()` uses it for `nativeReleaseFrameCaches` and `nativeReleaseDataIngestion`, SW:1591-1592; `BaroChartFrameRenderer.swift:67` uses it for `nativeRenderFrameJSON`; answering false there silently pushes iOS to full-scene rendering).
- **Empty engine** (`bc_engine_new` without `nativeInit`; the JS state after evaluating the bundle). Valid: the target protocols, `nativeReleaseFrameCaches` (→ `true`), `nativeReleaseDataIngestion` (→ zeros), `nativeEcho`, `nativeIndicatorBuffer` (→ `RangeError 'Native indicator slice'`). Live-only globals throw an engine `ReferenceError`/`TypeError`; compare the class only (D8). Measured QuickJS texts: `nativeCommand` → `ReferenceError: 'nativeAPI' is not defined`; `nativeThemeFont` → `'nativeModel' is not defined`; `nativeGestureKind` → `'nativeInput' is not defined`; `nativeSave` → `TypeError: cannot read property 'drawings' of undefined`; `nativeDataIngestionCommand` → the enveloped INVALID_INPUT ReferenceError. JSC texts: `"Can't find variable: nativeAPI"`, `"undefined is not an object (evaluating 'globalThis.nativeModel.drawings')"`. Emit the QuickJS style on Android.
- **Android generic transports** `invoke(name, args…)` (JV:74) and `BaroChartView.fire` (JSON in, JSON out) must keep working on Rust. The result text must equal `JS_JSONStringify` byte for byte (measured on the vendored QuickJS): `undefined` at top level → `null`; `undefined` inside objects omitted, inside arrays `null`; functions in arrays `null`; −0 → `0`; `1e21` → `1e+21`; `1.5e-7` and `0.000001` unchanged; a parsed `"__proto__"` key stays an own key; lone surrogates escaped `\ud800`; U+2028 raw; controls `\u0001`; a `Float64Array` → index-keyed object `{"0":null,"1":1.75}` (O6). Non-finite arguments never reach the core from Android (`JSONArray.toString()` returns null and JNI reports `'UTF-8 allocation failed'`).
- **iOS.** `call`/`command` return `JSValue` (decision O1). The Rust value facade must reproduce the JSC conversions the host relies on (measured): `toDictionary` omits keys whose value is `undefined`, maps `null` → `NSNull`, keeps NaN, −0 and ±Infinity as `NSNumber`, booleans as `CFBoolean`; arrays map `undefined` → `NSNull`; `toDictionary(null/undefined/number/string)` → nil; `toBool` is JS ToBoolean; `toString` is JS ToString (`'null'`, `'undefined'`, `'[object Object]'`, `'1,2'`, `-0` → `'0'`, `1e21` → `'1e+21'`). Host checks depend on these: `result` undefined vs null (SW:1628), `CFBoolean` vs `NSNumber` (SW:381-387), truthiness for `deleteDrawing`, `toString()` coercion for `saveStudies`/`saveDataIngestion`/`addDrawing`.
- Ops reachable only through `command()` (no named method). Swift: `setPanelOrder`, `removePanel`, `setIndicatorPlacement`, `indicatorValues`, `pan`, raw `inspect`/`setVisibleRange`/`zoom`, the `saveDrawings` op. Java: additionally `addAxis`, `setAxis`, `removeAxis`, `setDrawingTarget`, raw `crosshairValues`. These form the parity matrix for O1.

#### 3.6.2 Legacy helpers (all implemented, exact JS behaviour)

Call the same internal functions as the JS bridge, **not** the Rust API layer (going through the API would add colour normalization and snapshot validation). None of them bumps the host revision or notifies (they are reached through `call`/`invoke`).

| Global | Behaviour | Returns |
|---|---|---|
| `nativeEcho(value)` (B:82) | identity; extra arguments ignored | the first argument (`undefined` → `null` on Android) |
| `nativeIndicator(id, name, params, panel='price')` (B:99) | 1) `nativeModel.indicators.add(id, name, params)` on the live engine (atomic: identifier, params, `'Indicator limit'`, `'Duplicate indicator id'`, `'Unknown indicator: <String(name)>'`, factory errors, full calculation; on failure the entry is removed). 2) for each output in `Object.keys` order `nativeModel.addSeries({id: id+'-'+output, type:'line', panel, indicator:id, output})` through model normalization. **Not atomic**: a step-2 failure (`'Series limit'`, `'Duplicate series'`, `'Series id: string limit 128'` for long `id+'-'+output`, `'Series panel: string limit 128'` for a null panel, `'Unique series id and existing panel required'`) leaves the entry and earlier series. No view change, no `changed()`. Pre-M0 series record: `{color:'#7898ff', width:1.5, id, type:'line', panel, indicator, output, offset (plotOffsets[output] ?? 0), dirtyFrom:0}`. | `Object.keys(outputs)` (e.g. macd → `["macd","signal","histogram"]`) |
| `nativeView(from, to)` (B:136) | `model.setVisibleRange(from, to)` (map §3.9.4), no coercion | `undefined` |
| `nativeFit()` (B:137) | `model.fit()`; always a new view object | `undefined` |
| `nativeAddPanel(options)` (B:138) | `model.addPanel(options)` (same as the API op) | panel id |
| `nativeSetPanel(id, patch)` (B:139) | `model.setPanel` without the API's `'Panel patch object'` check and null→undefined conversion: a null patch → `TypeError 'Panel patch: object required'`; `range:null` is stored (and shown as `"range":null`); `base:null` → `RangeError 'Panel scale/range'`; an empty patch still replaces the record | `undefined` |
| `nativeAddSeries(options)` (B:140) | `model.addSeries`: `'Series limit'` before option checks, then `'Duplicate series'`, then `normalizedSeries` **without** colour normalization (`'red'` and `null` colours stored); any truthy JSON `values` → `TypeError 'Values must be aligned Float64Array'`; falsy `values` stored (`0` later fails layout with `RangeError 'Index length: limit <capacity>'`; `null` later fails `saveWorkspace` with `TypeError 'Workspace external values unsupported'`); model-level messages differ from the API (`'Series style/visibility'`, `'Series source'`, `'Candles/OHLC use primary store OHLCV'`) | series id |
| `nativeRemoveSeries(id)` (B:141) | `model.removeSeries(id)` = filter into a new array (unknown ids too); no gesture cancel, no target clearing, so a stale `drawingTarget` makes the next create-tool down fail `'Missing or mismatched drawing series binding'` | `undefined` |
| `nativeTheme(theme)` (B:142) | `nativeModel.theme = {...nativeModel.theme, ...theme}` with **no validation**: any JSON value, extra keys; a string argument adds `'0'..'n-1'` keys (one UTF-16 unit each), an array its index keys, and index keys sort first; `null`/numbers/booleans add nothing but still replace the object; Android `"__proto__"` becomes an own key. Values flow into scene JSON (`background`, command `color`/`font`), the packet (`TypeError 'Native packet background string'` for a non-string background), the crosshair (`TypeError 'Color string required'` / `RangeError 'Portable color: …'` only when a crosshair is drawn), labels (`String(font)`), frame-cache static state (`Object.is` on background, grid, text, up, down, font), `saveWorkspace` (`'Color string required'`, `'Workspace: unsupported field <k>'`) and `nativeThemeFont`. Decision O3. | `undefined` |
| `nativeInspect()` (B:143) | read-only | JSON **string** `{"view":{"from","to"},"drawings":<items as stored>,"storedBars":n,"tool":…,"pointers":n,"gesture":kind\|null}` |
| `nativeTool(tool)` (B:147) | `nativeInput.setTool(tool)`: unknown tool (`null`, `5`, `'select.'`) → `Error 'Unknown drawing tool'` before any cancel; otherwise a global cancel even for the same tool, then set | `undefined` |
| `nativeWheel(delta, x)` (B:148) | `nativeInput.wheel(delta, x)`: nothing during a gesture; else build a layout (size `nativeSize ?? {1200,700}`; side effects: range caches, lazy indicators) and `model.zoom(Math.exp(Math.max(-1, Math.min(1, delta*.001))), (x-p.left)/(p.right-p.left))` with JS `ToNumber` on `delta` and `x` (`'100'` works, `null` → 0, `true` → 1, `[50]` → 50, objects → NaN). `'abc'` or NaN delta → `RangeError 'Zoom factor'`; missing x → `'Visible range'`; small sizes → the layout `RangeError`. Layout side effects remain on failure. `Math.exp` is engine-specific (D5). | `undefined` |
| `nativeLoad(text)` (B:151) | `nativeAPI.loadDrawings(text)` (map §3.10.5) | `undefined` |
| `nativeSetData(bars)` (B:80, **checked**) | `store.setData(bars)` then `model.fit()`; same errors and final state as the `setData` op for JSON input (the reset listener already fits; the second fit replaces the view object again) | `undefined` |
| `nativeDataEvent(event)` (B:81, **checked**) | store-level `applyDataEvent(store, event)` (markets.mjs:200-208). Differs from the API op: batch uses `store.applyEvents` messages (`TypeError 'Data batch array required'`, `RangeError 'Data batch event count must be 1..4096'`, `'Data batch event kind must be append, update or correction'`, `'Data batch event plain data record required'`, …) instead of IngestionError INVALID_INPUT; no EXTERNAL_ALIGNMENT check; no session budget injection; reset `columns` passed raw (`'Numeric column values required'` for null/string elements, `'Bar count: limit N'` for a missing time column, `'Numeric column arrays required'` for other missing columns); prepend non-array → `'Prepend bars required'`; `'Data event kind required'`, `'Unknown data event'`, `'Update is only the current bar'`, `'Correction requires an existing timestamp'`. Neither path checks the ingestion fence (`api.mjs:86, :100`). | `undefined` |

#### 3.6.3 Benchmark helpers

- `nativeBenchmarkEvent(index)` (B:189): `store.at(index)` (integer 0..length−1 without coercion; −0 and 1.0 accepted; 1.5, `'3'`, null, out of range, empty store → `RangeError 'Bar index'`) → `{kind:'correction', bar:{time, open, high: Math.max(high,1000), low: Math.min(low,1000), close:1000, volume}}` (JS min/max; keys keep `store.at` order).
- `nativeBenchmarkDigest()` (B:190), in this fixed order: (1) for each entry in Map order and each array in `e.arrays` (definition order), hash the first `store.length*2` little-endian u32 words of the f64 data **without recalculating** (stale values and NaN bits included; an array shorter than `length` → engine `RangeError`, e.g. V8 `'Invalid typed array length: 34'`, QuickJS `'invalid length'`; entries with `arrays []` are skipped and not counted): `a = (a ^ w).wrapping_mul(16777619)`, `b = (b ^ w).wrapping_mul(3266489917).wrapping_add(374761393)` (u32; from `a = 2166136261`, `b = 2246822519`), `outputs += 1` per array; (2) `nativeSceneJSON(1200,700)` (replaces `nativeSize`, computes drawn indicators, records the latest layout); (3) `store.at(length-1)` (empty store → `'Bar index'` after step 2's side effects). Returns the JSON **string** `{"hashes":[a,b],"outputs":n,"length":L,"layout":<scene.layout>,"last":<bar>}`. Not idempotent (the first call after a correction hashes stale values; the scene then computes them). `layout.geometryKey` carries the per-runtime `BarStore` serial (D4) and `timeVersion`: hosts compare digests within one backend, and `correction-benchmark.swift:105` compares raw geometry keys, so a Rust async target must create exactly one store and keep `timeVersion` 2 (prepare publishes end at 3, `PrepareBenchmark.java:18`). Golden: `nativeInit(64,opts)` + 8 indicators + scene → hashes `[4096567434,2752457944]`, outputs 15, 1758 B, sha256 `c3d62888f75c6884f020cd7f5c6bde55543932dd4962c65e65abb01b361d518b` (scratch `tier-a-legacy/digest-64.json`).

#### 3.6.4 `nativeIndicatorBuffer` and Android `indicatorBytes`

`nativeIndicatorBuffer(id, output, offset, count)` (B:65, **checked**): `values = globalThis.nativeModel?.indicators.get(id).outputs[output]`, then `!(values instanceof Float64Array) || !isSafeInteger(offset) || offset<0 || !isSafeInteger(count) || count<1 || count>262144 || offset+count > values.length` → `RangeError 'Native indicator slice'`; return `values.subarray(offset, offset+count)`. Consequences:
1. No engine → the same `RangeError` without looking at the arguments.
2. `get(id)` runs **first** and to completion: `Error 'Missing indicator: <ToString(id)>'` (Map lookup, so non-string ids never match), `RangeError 'Indicator output byte limit'` on the first read after a capacity change (state unchanged), calculation errors (`'Output must be finite or NaN'`; state keeps its metadata with `invalidated:true`). On success the lazy commit happens and **stays even when the output or range check then fails**; it stales active jobs (§3.4.3).
3. `output` uses `ToPropertyKey`; only own definition outputs match (`'constructor'`, `'__proto__'`, `'toString'` fail with the same `RangeError`, unlike `indicatorValues`' `'Missing indicator output'`).
4. The bound is `n = store.length` because `get()` returns `arrays[i].subarray(0, n)` (indicators.mjs:284): the stale tail beyond n is never readable here (map §5 rule 36 is wrong, §6).
5. Bytes are raw IEEE-754 little-endian (NaN payloads and −0 kept; canonical NaN fill `7ff8000000000000`).

Android path. `indicatorBytes(id, output, offset, count)` (JV:276, package-private) runs `check()` (owner, cleanup resume, closed, closing), then `IllegalArgumentException 'Indicator byte slice limits'` (null, more than 128 UTF-16 units, offset < 0, count outside 1..262144), then JNI `indicatorSlice` (JNI:112-116): `'Engine closed'` → `offset+count > 4194304` (and the same bounds) → `IllegalStateException 'Indicator byte slice bounds'` (before any JS call, so no lazy commit) → `utf8(id,512)`, `utf8(output,512)` (`getBytes("UTF-8")`, lone surrogates become `?`; `'Native argument size limit'`; NULL → `'Indicator identifier UTF-8 failed'`) → `JS_NewString` (strlen: **truncates at the first U+0000**; `'ema\u0000zz'` reads `ema`) → call → JS errors as `IllegalStateException('<Name>: <message>')` → exact `count*8` bytes. The Rust branch must sit **after** the shared bounds and UTF-8 steps, pass `strlen` lengths, and reuse `'Async Float64Array byte length/bounds mismatch'` if the returned length is not `count*8` (§3.9.3).

Through Android `invoke` the result is `{"0":…}` JSON with NaN as `null` and −0 as `0` (QuickJS, V8 and JSC give identical text). The 58-vector corpus (`tier-a-indicator-buffer/corpus.js`, 33 builtins + pressure) hashes to FNV-1a64 `1983021300a7ea4c` on all three engines.

### 3.7 Custom JS indicator rejection contract

#### 3.7.1 Only two surfaces stay JS-only

1. `nativeRegisterIndicatorSource`, the whole function.
2. `aster.studies` and `aster.workspace` documents that carry the descriptor of a **linkable** custom module.

Source-registered indicators never reach documents: `saveStudies` and `nativeSaveWorkspace` reject them with `UnsupportedIndicatorError` (measured). So a custom indicator inside a document is always a build-time linked module, and it always carries its descriptor. Entry-based portability checks (`api.mjs:236` `indicatorValueAt`, `study-setup.mjs:13`, `workspace.mjs:54`, AS:33, PS:17, NPS:40) are unreachable in Rust because Rust entries are only builtins and `pressure`. JS-only quirk, not compared: a params Begin with unchanged params on a source-registered indicator returns phase `'noop'` because the no-op test (NPS:39) runs before the portability check (NPS:40).

#### 3.7.2 `nativeRegisterIndicatorSource` on Rust

A reject stub in the function table: no argument or state inspection, no change to registry, entries or counters. It throws `{name:'UnavailableError', message:'Indicator source registration requires the javaScript backend', code:'JAVASCRIPT_BACKEND_REQUIRED'}` (61 chars), also before `nativeInit` and in target runtimes (where JS gives an engine `ReferenceError`). CLOSED and POISONED are decided first by the FFI (§3.8). Hosts call it with `call`/`invoke` and notify only after a normal return (SW:1906, JV:630), so a rejection notifies nothing. Swift sees `BaroChartLowLevelError.javaScript("UnavailableError: Indicator source registration requires the javaScript backend")`; Java an `IllegalStateException` with the same text; `wrap` gives `.unavailable`/`UNAVAILABLE` once the classifier rule (§3.7.6) exists. JS reference results to pin next to it (they differ): `null` on success; `TypeError 'Trusted factory expression, at most 64KiB'` (non-string, missing or > 65536 units), engine `SyntaxError` for bad source, `TypeError 'Factory function required'`, `TypeError 'Indicator name: string limit 128'`/`'Indicator name: reserved identifier'`, `TypeError 'Unique name and factory required'` (`'sma'`, the pressure name, duplicates).

#### 3.7.3 Documents: the "linkable" predicate and where it applies

`isLinkable(name, d)` never throws and is true when **all** hold: `name` is a string not in the Rust registry (35 builtins + `aster.volume-direction@1/pressure`); `name.length ≤ 128` UTF-16 units; `d` is a JSON object (not an array or null) whose own keys are exactly `{id, version, stateVersion, exportName, causal}`; `id` and `exportName` satisfy `identifier` (1..128 units, not `__proto__`/`constructor`/`prototype`) and contain neither `@` nor `/`; `version` and `stateVersion` are safe integers ≥ 1; `causal === true`; `id+'@'+String(version)` is not a Rust-linked module key; `name === id+'@'+String(version)+'/'+exportName` (UTF-16 code-unit comparison). This is exactly the set that some JS bundle linking that module would accept (`defineIndicatorModule` indicator-modules.mjs:13-22, `validateIndicatorModuleBinding` :35-36). Model checks: true for the test fixture descriptor, for stateVersion 9, and for `aster.volume-direction@2/pressure`; false for an extra key, `causal:false`, a mismatched exportName or version, `'sma'` with a module, `null`, `aster.volume-direction@1/other`, and a 133-char name.

Rule positions (Rust only; JS is unchanged):
- **Workspace** (`readWorkspaceDocument`, at the `workspace.mjs:41` `validateIndicatorModuleBinding` position; used by `nativePreflightWorkspace`, `nativeWorkspaceSourceBegin` and `nativeWorkspaceTargetCreate`): with `expected = indicatorModule(name)` (only pressure in Rust): no expected and no `module` key → pass (the later staging step, native-workspace.mjs:20, raises the UIE after the binding and extent checks); no expected and `isLinkable` → **`UnavailableError 'Indicator module requires the javaScript backend: <name>'`**, code `JAVASCRIPT_BACKEND_REQUIRED`; no expected otherwise → `TypeError 'Indicator module descriptor binding'` (null descriptors, builtins with a descriptor); expected → JS unchanged (`'Indicator module descriptor: object required'`/`plain object required`/`unsupported field <k>`, or `'Indicator module descriptor binding'` for a mismatch). Earlier checks of the same indicator (record, id, name, duplicate, params) run first; the first failing indicator in document order wins.
- **Studies** (`loadStudies`, at the `study-setup.mjs:63` `requirePortableFactory` position, after the definition record, params and `'Duplicate study id'`): name in the Rust registry → JS unchanged (`'Study module version/codec mismatch'` or `candidate.add`); else `isLinkable` → the same `UnavailableError`; else the JS UIE `'Unsupported indicator module: <String(name).slice(0,128)>; requires a canonical builtin or linked factory'`.

Unchanged on Rust and byte-identical to the standard JS bundle: `registerIndicatorModule` of an unlinked id (UIE; the Kotlin consumer checks for `Unsupported`, `StudyContract.kt:142-147`; `StudyVerification.java:26` expects an `IllegalStateException`); `addIndicator` with an unknown name (`Error 'Unknown indicator: <String(name)>'`, even for canonical module-shaped names: a bare name proves nothing and may be a typo); documents without a descriptor or with a broken one. Do not apply the rule inside internal payload validators (AS:47, PS:14/27, NPT:18, NPI:13): those see only forged inputs.

State after a rejected workspace Begin: as for any capture failure (B:40): the ticket is consumed, the registration mark is committed, the source slot is cleared, the lease released (epoch +2, not observable). Chart state is unchanged; protocol counters advance as in JS. Measured: reject reg 5 (ticket 1) → reg 5 again → `RangeError 'Workspace registration must increase'` before any ticket → reject reg 6 (ticket 2) → reg 7 succeeds `{ticket:3, phase:'admission', registration:7}`. `nativeWorkspaceSourceAbort` then returns `false`, which both hosts accept as "released" (SW:403-410, JV:988).

#### 3.7.4 Preflight (decision O2)

Recommended: preflight throws the same `UnavailableError` (no new receipt keys). Reasons: the map §3.14.6 receipt bytes stay unchanged; Rust cannot run the custom factory, so it cannot honestly report `counts`, `projectedOutputBytes` or `'validated-only'`; Begin calls the same validator first, so there is one rejection path. Design §5.2 and §8.1 M6 say "preflight `requiredBackend`"; update them to "UnavailableError with code `JAVASCRIPT_BACKEND_REQUIRED`".
Alternative (only if the owner wants a receipt): preflight alone returns `{schema:'aster.workspace-preflight', version:1, status:'requires-backend', restored:false, requiredBackend:'javaScript', dataset:<binding>, modules:[descriptors in document order, deduplicated by name, keys id, version, stateVersion, exportName, causal]}` after all other validation, binding/extent checks and staging of the Rust-known entries pass; Begin and target create still throw. Hosts only require an object (SW:1889-1891, JV:664-667).

#### 3.7.5 Unavailable-expectation table (design §8.3)

Proposed fixture `test/fixtures/rust-unavailable-expectations.json`, one row per case: `{id, surface (core|swift|java|runner), call, args or fixture, precondition, rust:{name,message,code}, host:{swift:{code,message}, java:{code,message}}, unchanged:[inspect, saveStudies, saveDrawings, dataIngestionStats], jsStandard, jsLinked}`. `jsLinked` uses `buildNativeBundle({modulePaths:['test/fixtures/native-workspace-module.mjs']})`.

| Row | Case | Rust | JS standard | JS linked |
|---|---|---|---|---|
| U1 | `nativeRegisterIndicatorSource(...)` on an open engine, then `addIndicator('custom','double')` | `UnavailableError` (§3.7.2), then `Error 'Unknown indicator: double'`; no notification | `null`, registered, one notification | same as standard |
| U1b | same before `nativeInit` / in a target runtime | `UnavailableError` | engine `ReferenceError` | same |
| U2 | `loadStudies(G2 studies)` (test module `test.native-workspace@1/pair`) | `UnavailableError … : test.native-workspace@1/pair`; inspect unchanged | UIE | `{indicators:1, series:1}` |
| U3 | `nativePreflightWorkspace(G2 workspace, binding d1/r1/1/USD/raw)` | `UnavailableError` | `TypeError 'Indicator module descriptor binding'` | `'validated-only'` receipt |
| U4 | `nativeWorkspaceSourceBegin(G2 workspace, …, 5)` | `UnavailableError`; counters as §3.7.3 | `TypeError`, same counters | admission |
| U5 | typed `restoreWorkspace(G2 workspace)` | Swift `BaroChartError(.unavailable, 'Indicator module requires the javaScript backend: test.native-workspace@1/pair')`; Android `RestoreCallback` `UNAVAILABLE`, status `'failed'`; no notification | `.invalidArgument` / `INVALID_ARGUMENT` | success |
| U6 | `nativeWorkspaceTargetCreate(linked-source metadata)` in a fresh runtime | `UnavailableError` (forged input) | `TypeError 'Indicator module descriptor binding'` | true |
| U7 | Swift `context` | precondition failure (decision O1 for `call`/`command`) | works | works |
| U8 | runner steps that need custom JS (`parity.swift:26-28,40`, `async.swift:153`, `prepare.swift:107` "unsupported-factory", `APIVerification.java:58`, the custom-bundle mode of `swift-study-consumer`) | marked JS-only | | |
| R1 | `registerIndicatorModule('test.native-workspace',1)` | UIE (Swift `.javaScript` full text, Java `UNAVAILABLE`) | same | `[…pair]` |
| R2 | `registerIndicatorModule('aster.volume-direction', 99 / 2 / 1)` | UIE / UIE / `["aster.volume-direction@1/pressure"]` | same | same |
| R3 | `addIndicator` with a module-shaped unknown name | `Error 'Unknown indicator: <name>'` | same | linked works |
| R4 | `loadStudies` with the module key removed / mismatched exportName; `'sma'` with a module | UIE; `'Study module version/codec mismatch'` | same | |
| R5 | preflight with the module key removed; mismatched descriptor; extra key; `causal:false`; `'sma'` with a module; name `'smaa'` | UIE after binding/extent checks; `'Indicator module descriptor binding'`; UIE | same | |
| R6 | pressure documents | §3.7.7 receipt | same | same |
| R7 | `dataAt` causality | builtins `'canonical-builtin'`, pressure `'unverified-study'` | same | custom `'unverified-study'` |
| R8 | `nativeCommand('registerIndicatorSource', …)` | `TypeError 'Unknown chart command or argument list'` | same | same |

Harness rule: a trace recorded against a custom bundle is JS-only; when a trace hits a U row on Rust, assert the exact error and stop replaying that trace (later lines depend on JS-only state).

#### 3.7.6 Host classifier changes

- Swift `classifyScript` (BaroChartError.swift:94-113), before the generic fallback: `if text.hasPrefix("UnavailableError: ") { return (.unavailable, String(text.dropFirst(18))) }`.
- Java `classify` (BaroChartException.java:84-107): `if (message.startsWith("UnavailableError: ")) return Code.UNAVAILABLE;` **before** `classifyHostMessage`, and add the prefix to `withoutScriptPrefix`. Without that order a module name containing `cancel`, `cleanup`, `budget` or `owning thread` would be misclassified (`classifyHostMessage` matches substrings of the whole text).
- Add the same two rows, in the same order, to the shared tables `TypedEngineCoverageTests.swift:42-58` and `BaroChartExceptionTest.java:33-49`: `('UnavailableError: Indicator source registration requires the javaScript backend', unavailable, 'Indicator source registration requires the javaScript backend')` and `('UnavailableError: Indicator module requires the javaScript backend: my.cancel-budget@1/x', unavailable, 'Indicator module requires the javaScript backend: my.cancel-budget@1/x')`.
- The UIE text stays exposed to the substring trap on Android (`registerIndicatorModule('my.budget',1)` classifies `BUDGET_EXCEEDED`), exactly as on the JS backend.
- The error-catalog CI (design §4.7) extracts messages from JS throws, so it needs a Rust-only allow-list: the two `UnavailableError` texts above, `<name> is not available in the Rust backend`, the M1 interim `… yet`, and `… backend is not included in this build`.

#### 3.7.7 Goldens (scratch `tier-a-custom-reject/`, identical on the oracle and the M0 bundles)

- Linked bundle, `nativeInit(40,…)` + `addIndicator('cx','test.native-workspace@1/pair',{})` + a line series: `saveStudies` (330 chars) = `{"schema":"aster.studies","version":1,"indicators":[{"id":"cx","name":"test.native-workspace@1/pair","params":{},"module":{"id":"test.native-workspace","version":1,"stateVersion":3,"exportName":"pair","causal":true}}],"series":[{"id":"cxs","type":"line","panel":"price","indicator":"cx","color":"#7898ff","width":1.5,"offset":2}]}`; the workspace text is 1091 chars with outputs `['value','toString']` and plotOffsets `{value:2,toString:2}`.
- Pressure preflight receipt: `{"schema":"aster.workspace-preflight","version":1,"status":"validated-only","restored":false,"dataset":{"key":"d1","revision":"r1","adjustmentVersion":"1","priceUnit":"USD","adjustment":"raw"},"source":{"length":40,"firstTime":1700000000000,"lastTime":1700002340000,"version":2},"counts":{"panels":1,"axes":0,"series":1,"indicators":1,"outputs":2,"drawings":0},"projectedOutputBytes":1024,"outputByteLimit":268435456,"modules":[{"id":"aster.volume-direction","version":1,"stateVersion":1,"exportName":"pressure","causal":true}]}`.
- `loadStudies` UIE names follow JS `ToString`: `5`, `null`, `true`, `[1,[2,null]]` → `1,2,`, `{}` → `[object Object]`, `1e21` → `1e+21`, `-0` → `0`; a 130-char name gives a 206-char message; `'가'×127+'😀'` leaves a trailing lone `\ud83d`.

### 3.8 Engine lifetime, CLOSED and POISONED

#### 3.8.1 Facts the design must respect

The JS bridge has no "closed" state. On iOS the following keep the source `JSContext` alive after `close()`, deinit or a runtime swap, and later call into it:
- cleanup records: `BaroChartWorkspaceSourceRecord.context` (SW:392) and `BaroChartParamsSourceRecord.context` (SW:960, with a weak `sourceIdentity` at :962) call `nativeWorkspaceSourceAbort`, `nativeParamsSourceStatus` and `nativeParamsSourceAbort` from the jobs' fail/settle paths, from the static `retryWorkspaceCleanup()`/`retryParamsCleanup()` (SW:1454-1467), from `BaroChartParamsJob.retryCleanup()` (:1133-1136), and from `close()` itself, **before** its `closed` check (SW:1586-1588, **checked**), so a second `close()` still reaches the source;
- `BaroChartAsyncJob.source` (SW:198): `finish()` calls `try? nativeAsyncRelease(ticket)` even after close or deinit (SW:275);
- the worker creator threads: `BaroChartWorkspaceRuntime.ownedContext` (SW:849), `BaroChartWorkspaceDelivery.context` (SW:840), the async `Prepared.context` (SW:503).

Android calls these functions only inside `close()` before freeing the handle: params and workspace `closeOnOwner()`, then `activeJob.stopOnOwner('closed')` (`nativeAsyncRelease`), then close observers, then `free` (JV:806-812, **checked**). A free resolves pending cleanup (`WorkspaceRestoreJob.java:62` treats `currentHandle() != source` as released; `ParamsUpdateJob.java:80`, :116 use `sourceFreed`). Java `check()` (JV:64) resumes pending owner cleanup on every engine call before the requested call runs.

Swift `close()` reads the public `context` (`context.objectForKeyedSubscript("nativeReleaseFrameCaches")`, SW:1591-1592, **checked**). Under design §4.3, `context` is a precondition failure on Rust, so `close()` would crash: these reads must move to `supports(name)` in the M0 seam. Static ownership tests pin the `JSContext` type names (`test/swift-workspace-ownership-source.test.mjs:95`, `test/swift-params-ownership-source.test.mjs:74,115,158`; `:81` forbids `recover` from looking at `closed`, `contextBacking`, handles or tickets); rename the types, keep the logic.

#### 3.8.2 Decisions

1. **The Rust engine lives exactly as long as its host wrapper.** iOS creates one `BaroChartRustCoreRuntime` object per `bc_engine_new` and stores that object wherever a `JSContext` is stored today; its deinit calls `bc_engine_free`. Every slot compares runtimes with `===`, so a second wrapper for the same engine is forbidden. Wrap FFI calls in `withExtendedLifetime(self)`. Android keeps today's `free` points. No reference counting inside Rust.
2. **Swift and Java `close()` do not change Rust state.** There is no Rust close entry point. CLOSED is returned only for a stale handle after `bc_engine_free`.
3. **POISONED** is entered when a panic unwinds out of `bc_call`, `bc_packet`, `bc_read_f64` or `bc_write_f64` for this engine; it is irreversible. Hosts show it as exactly `Error: Chart disposed` (iOS `BaroChartLowLevelError.javaScript` → typed `engineClosed`, BaroChartError.swift:111-112; Android `IllegalStateException` → `ENGINE_CLOSED`, BaroChartException.java:94).
4. A poisoned engine still answers the **cleanup whitelist** (§3.8.4) so that host slots and the 2-job / 768 MiB process admission are released and `close()` succeeds. Without it, iOS abort/status would fail forever (`cleanupPending`, both admission slots leaked, every later workspace/params job `busy`), and `close()` would throw at SW:1591-1592 and leave the engine open.
5. `BcHost` callbacks may only touch process-lifetime state (an engine may outlive its Swift or Java engine object). No callback runs during `bc_engine_free`.

#### 3.8.3 `bc_call` decision order and the poison transition

1. stale handle generation → CLOSED;
2. the per-engine busy guard (atomic compare-exchange) not acquired → BUSY (transient; never happens on cleanup paths, because source engines are called only on the owner thread and workers touch only targets);
3. name resolution (same in both states);
4. Poisoned: whitelist → ledger answer (argument errors keep the JS text); anything else → POISONED;
5. Open: dispatch inside `catch_unwind`; on a panic run the poison transition, then a whitelisted function returns its Poisoned answer **in the same call**; others return POISONED;
6. release the busy guard unconditionally outside `catch_unwind` (a leaked guard would make the engine BUSY forever, worse than POISONED).

Poison transition (holding the guard): state = Poisoned; if the params ledger has an active row, set its status `'failed'` (no receipt) and clear the active marker; treat every session as dropped (workspace source, params source and target, async capture, async/workspace targets, UI import); drop heavy core state inside a nested `catch_unwind` and `mem::forget` it if that panics too; record the function name and panic message for diagnostics. A poisoned engine therefore has no live session, so "abort returned false" and "status is terminal" are true statements, not invented ones (`docs/SWIFT-WORKSPACE-RESTORE.md:76-77`).

#### 3.8.4 Cleanup whitelist answers

| Function | Open | Poisoned |
|---|---|---|
| `nativeWorkspaceSourceAbort(registration)` (B:47) | `Number.isSafeInteger(r) && r ≥ 1` else `RangeError 'Workspace registration'` (0, −0, −1, 1.5, `'1'`, true, null, undefined, NaN, Infinity, 2^53, `[1]`); active row with that registration → drop (`capture.dispose` releases the lease) and `true`; otherwise `false` (also for a registration-less row). No owner or busy check: works after a Swift-close simulation and after `nativeInit` (measured `true`). | same validation, then `false` |
| `nativeParamsSourceStatus(r)` (P:27) | token check (`RangeError 'Params registration'`); row copy or `null`; no owner check (works after close simulation and `nativeInit`) | token check; row copy if present (an active row was failed by the transition); else **`r > params_mark` → synthetic `{registration:r, ticket:0, status:'failed'}`**; else `null` (evicted, as JS) |
| `nativeParamsSourceAbort(r)` (P:28) | as §3.2.2 | same answer as Status; drops nothing |
| `nativeAsyncRelease(ticket)` (B:55) | as §3.1.2 | `true` |
| `nativeReleaseFrameCaches()` (B:203) | `true` | `true` |
| `nativeReleaseFrameCache(token)` (B:202) | `true` (token not validated) | `true` |
| `nativeReleaseDataIngestion()` (B:13) | as §3.3.7 | `{cancelled:0, pendingEvents:0, ownedBytes:0}` |

The params ledger is separate from panicking core code and updated at the JS points (P:7, P:14-15, P:26, P:28) with non-panicking operations: `mark` (= `nativeParamsRegistration`), up to 4 rows in insertion order, and the active row. Row insertion and the mark update happen together (P:14), so a registration above the mark has never had a row in this runtime and cannot have committed: the synthetic `'failed'` row is provably correct. `ticket:0` marks it as synthetic (JS tickets are ≥ 1; hosts never read `ticket`). An evicted row (r ≤ mark) answers `null` as in JS; host flows cannot evict a pending row because the engine stays busy while a record is pending (SW:1441-1443; Android keeps `activeParams`).

`bc_supports` answers from the static table in both states and `false` for a freed handle. `bc_memory_stats` works on a poisoned engine. `bc_engine_free(engine)` never fails: any state, any thread (iOS last releases happen on main, on the workspace creator thread, on params workers and on async runtime threads); a stale or repeated free is a no-op; the drop runs inside `catch_unwind` and is leaked with `mem::forget` if it panics; it never terminates the process (a throwing JNI `free` would leave a params job pending forever, `ParamsUpdateJob.java:114`). If `free` meets a held busy guard (host rule violation), set `free_pending` and free when the call returns.

#### 3.8.5 Host scenarios with the hosts unchanged

- Source poisoned during a restore: `nativeWorkspaceSourceCheck` → POISONED (`Error: Chart disposed`) → `fail` → abort `false` → `remove` → slot released → the job fails with `engineClosed`.
- Params job started on a poisoned engine: Begin → POISONED → `settle` → Status (`r > mark`) synthetic `'failed'` → released → failure.
- Panic in `nativeParamsSourcePublish`: the active row becomes `'failed'`; `recover` releases; `settle(nil)` ends with `invalidProtocol('Params not committed')`; later calls give `engineClosed`.
- `close()` of a poisoned engine succeeds (whitelisted frame and ingestion releases); `isClosed == true`.
- Poisoned target on a worker: compute fails → retire → the creator thread drops the target wrapper (free) → `job.fail` → abort on the open source returns `true`.
- Android: abort/status answer from the ledger, so jobs terminate and release the budget before `close`; `free` must not throw.

#### 3.8.6 Goldens (scratch `tier-a-lifetime-poison/`; OPEN semantics only, the JS oracle has no POISONED/CLOSED states)

- `nativeWorkspaceSourceAbort(1)` on a fresh engine → `false`; Begin `(…,0,805306368,5)` → `{"ticket":1,"phase":"admission","registration":5}`, then abort(4) → `false`, abort(5) → `true`, abort(5) → `false`; a later Step(1,8,0) → `Error: Workspace source ticket missing/released`.
- Swift-close simulation: Begin reg 2 → `nativeReleaseFrameCaches()`, `nativeReleaseDataIngestion()` → `[true, {"cancelled":0,"pendingEvents":0,"ownedBytes":0}]` → abort(2) → `true`. Begin reg 3 → `nativeInit(10,null)` → abort(3) → `true`.
- `Begin(…,-1,…,3)` → `RangeError: Workspace source host revision` (registration 3 consumed) → `Begin(…,0,…,3)` → `'Workspace registration must increase'` → `Begin(…,0,…,4)` → ticket 4.
- Params: Begin reg 7 → `{"ticket":1,"registration":7,"phase":"admission"}`; Status(7) `{"registration":7,"ticket":1,"status":"active"}`; Abort(6) `null`; Abort(7) `{"registration":7,"ticket":1,"status":"aborted"}` (idempotent). A Begin that fails in the capture (`'Missing indicator'`) leaves `{"registration":1,"ticket":1,"status":"failed"}`. A busy Begin creates no row. Registrations 1..6 begun and aborted → Status gives `[null,null,"aborted","aborted","aborted","aborted"]`.
- `nativeReleaseDataIngestion()` with 3 pending → `{"cancelled":3,"pendingEvents":0,"ownedBytes":0}`, counters `cancelled 3`, `lastCancelledSequence 3`; then `dataIngestionStats` → `{"error":{"name":"IngestionError","code":"CLOSED","message":"Ingestion session closed or replaced"}}`.

Acceptance tests (M6; test builds only, e.g. a `test-hooks` feature `bc_debug_panic_on(engine, fn)` excluded from shipped artifacts): panic in a restore step → `engineClosed`, `workspaceCleanupStatus() == []`, two new jobs can start on another engine; panic in Publish → released, `notCommitted`, `paramsCleanupStatus() == []`; jobs on a poisoned engine fail without pending cleanup; `close()` of a poisoned engine succeeds; a pending record after engine deinit is released by `retryParamsCleanup()`; Android flows end with `NativeJobBudget.snapshot() == {0,0}` and a non-throwing `free`; Rust unit tests replay the goldens above; a stale handle gives CLOSED and a double free is a no-op.

### 3.9 Engine resource limits and the JNI layer

#### 3.9.1 JSON nesting depth (decision O5)

Before M0c the unguarded entry points differed in **class**, not just text, so D8 ("compare the name only") did not cover this. The raw-engine measurements below remain useful baselines:
- QuickJS re-arms a 1 MiB stack budget on every JNI entry (`JS_UpdateStackTop`, JNI:28; `stack_limit` = entry SP − 1 MiB, quickjs.c:2841-2859; `JS_SetMaxStackSize` is never called). Its JSON parser is recursive: past the budget it throws `SyntaxError: stack overflow` (quickjs.c:23366-23367); `JSON.stringify` throws `InternalError: stack overflow` (quickjs.c:7789-7791). Limits ≈ 1048576 / frame size: `json_parse_value` 160 B on arm64 (Android .so and macOS harness), 176 B on x86_64; `js_json_to_str` 256 B arm64 (224 B macOS), 272 B x86_64. Measured on the macOS harness: whole Android argument parse 6,552 levels pass / 6,553 fail (array of arguments included); `loadDrawings` text 6,517 / 6,518; `nativeAsyncBegin` text 6,538 / 6,539; stringify 4,680 / 4,681. Estimated on devices (not run): arm64 parse ≈ 6,552, stringify ≈ 4,096; x86_64 parse ≈ 5,957, stringify ≈ 3,855.
- V8 (node 22.20.0 `node:vm`) and JSC parse iteratively (5,000,000 levels parse) and then report the validator's error. Stringify limits: V8 6,817 / 6,818 (`RangeError: Maximum call stack size exceeded`); JSC a fixed 39,999 / 40,000 (`RangeError: Maximum call stack size exceeded.`, independent of thread stack).
- iOS JS backend: deep Swift argument arrays crash the process (25,000 levels give a validation error; 30,000 levels SIGSEGV during argument conversion).

All `safeCheckpointParse` paths (studies, ingestion documents, workspace documents, restore metadata) pre-scan depth 32 and agree on every engine (`RangeError 'Checkpoint depth limit'`; walk `'Checkpoint state limit'`). The three bare `JSON.parse` sites do not: `drawings.mjs:39` (`loadDrawings`, `nativeLoad`), B:5 (`nativeAsyncBegin`), B:6 (`nativePrepareBegin`, also via `nativeDataAsyncBegin`). Measured V8/JSC results for those sites at depth ≥ 33: `TypeError 'Drawing document: object required'`; async begin 33 → `'Checkpoint depth limit'`, ≥ 34 → `'Checkpoint state limit'`; prepare begin `TypeError 'Prepare request: object required'`.

**M0c normalization:** a nonrecursive text scan skips string contents and escapes, then caps container nesting at 32 before those three parses. The messages are `Drawing document depth limit`, `Native data event document depth limit`, and `Native prepare document depth limit` (all RangeError). It performs the same string-hint coercion as JSON.parse once and returns the checked string. The native capture busy check precedes coercion/depth validation; drawing length validation precedes the scan.

Host value-bridged argument graphs are capped at 64, including the outer argument array (`SyntaxError: Native argument depth limit`, both SDK classifiers report invalid argument). Swift iterates Array/Dictionary/NSArray/NSDictionary and unwraps Optional without increasing depth; existing JSValue/JSExport VM references stay opaque so traversal does not execute their getters. This is not a claim that arbitrary JS-only VM graphs have a global depth cap. Java checks JSONArray/JSONObject/Collection/Map/arrays before org.json recursively encodes them, and JNI scans the actual argument UTF-8 bytes before JS_ParseJSON. Reference-container subtree heights are memoized and cycles reject; a shared subtree reused deeper must still fit the limit. Normal inputs nest about 6 levels. The independent `barochart-js` parser/clone/drop keeps its iterative depth-100000 contract; engine and host boundaries impose their own limits.

#### 3.9.2 Memory caps

- QuickJS (JNI:14-26, :48): a tracking allocator adds `sizeof(AllocationHeader) = sizeof(union{max_align_t; size_t})` to every allocation: **32 B** on the shipped ABIs arm64-v8a and x86_64 (alignment 16; NDK 27.1 static assert), 16 B on armv7a/i686, 8 B on macOS. `JS_SetMemoryLimit(805306368)` applies to Σ(requested + 32), set after runtime and context creation. Exceeding it, or a failed system `malloc`, throws `InternalError: out of memory` (quickjs.c:7778-7787); strings above 2^30−1 units throw `RangeError: invalid string length`. After an OOM the runtime keeps working and `setData`/`setColumns` leave the old data in place (they build columns before publishing).
- On the JSON data path this cap bites **before** `maxBars` (measured): an empty engine fails `setColumns` with 4,194,304 bars; an engine holding 1M bars fails `setData` with 2M bars (parse ≈ 196 B per bar object, ≈ 19.4 B per numeric array element, plus the store's `96*capacity`). JSC has no such cap (`'RangeError: Out of memory'` only for huge single allocations such as `'x'.repeat(2**31)`).
- Rust recommendation: a per-engine `MemoryAccount {live, peak, limit}`; `charge(bytes)` with `try_reserve` before every input-proportional allocation (parsed arguments, decoded bar data, store columns and range indexes, indicator outputs, checkpoint texts, drawing documents and history, frame caches, result JSON); `release` on drop. `limit` = 805306368 on Android, 0 (unlimited) on iOS. Over the limit, throw before any state change: Android `InternalError: out of memory` (same text and `UNAVAILABLE` classification as QuickJS), iOS `RangeError: Out of memory` only when `try_reserve` fails. Thresholds cannot equal QuickJS's; differential tests compare the class only (or skip) when the oracle reports an engine-resource error, and allow Rust to succeed. Decode bulk data straight into column vectors so Rust never fails where QuickJS succeeds; keep the QuickJS boundary cases (`setData` 1M bars, `setColumns` 2M bars) as regression tests. Stable Rust aborts on an infallible allocation failure, so only large allocations can be guarded.

#### 3.9.3 JNI order and the Rust branch

Design §4.4 branches right after `enter()`. That would skip the backend-neutral checks. Structure each JNI function as: `enter()` (handle 0 → `'Engine closed'`; store `h->env`; call `JS_UpdateStackTop` only for QuickJS handles) → backend-neutral pre-checks in today's order → branch → backend-neutral post-checks → Java objects. All failures go through the same `fail()`, which does nothing when a Java exception is already pending (JNI:40), so the first failure wins.

| Function | Pre-checks (both backends, in order) | Post-checks |
|---|---|---|
| `call` (JNI:56-61) | `utf8(arguments, 268435456)`: UTF-16 length, then UTF-8 bytes > limit → `'Native argument size limit'`; NULL or failed conversion → `'UTF-8 allocation failed'`; (depth scan if O5 is adopted) | result UTF-8 > 268435456 → `'Native result size limit'` |
| `packet` (JNI:72-90) | extent: finite, 0 < w,h ≤ 16384, w·h ≤ 33554432 → `'Native packet extent'`; `utf8_n(mode,16)` then token `utf8_n(token,512)` (`'Native argument size limit'`), NULL → `'Native packet UTF-8 arguments'`; mode exactly `scene`/`frame`, frame token 1..128 UTF-16 → `'Native packet mode/token'` | metadata UTF-8 ≤ 1048576 (`'Native packet metadata byte budget'`); numbers ≤ 67108864 bytes, multiple of 8, aligned (`'Native packet Float64Array bounds/byte budget'`) |
| `readBuffer` (JNI:91-96) | ticket ≥ 0, slot 0..2047, offset ≥ 0, count 1..262144, offset+count ≤ 33554432 → `'Async buffer read bounds'` | length == count·8, else `'Async Float64Array byte length/bounds mismatch'` |
| `writeBuffer` (JNI:97-102) | bytes NULL → `'Async buffer bytes required'`; slot 0..2047, 8..2097152 bytes, multiple of 8, offset+n ≤ 33554432 → `'Async buffer write bounds'`; copy (`'Async copy allocation failed'`) | — |
| `writeSlice` (JNI:106-111) | values NULL → `'Owned input column required'`; slot 0..5, count 1..262144, offset+count ≤ values length → `'Prepare column slice bounds'`; copy (`'Prepare input allocation failed'`) | — |
| `indicatorSlice` (JNI:112-116) | §3.6.4 | length == count·8 |
| `memoryUsed/Peak/Stats`, `free` | `enter` | — |

Checks that only exist after parsing must come back from Rust as statuses: add **TRANSPORT** (message thrown without a prefix, used for `'At most 16 arguments'`, Android only; iOS has no argument-count limit) and **NOT_FOUND** (Android glue → `TypeError: not a function`; iOS → `Missing function: <name>`). Extra arguments beyond a function's arity are ignored, as in JS. QuickJS-only checks (`'Async helper must return an intrinsic Float64Array'`, `'Native packet object required'`, `'Native packet metadata string required'`, `'Native packet intrinsic Float64Array required'`, `'QuickJS error'`) stay in the QuickJS branch.

Error text encoding: Rust passes `name + ': ' + message` as **WTF-8** (a lone surrogate as 3 bytes, like `JS_ToCString`) to `fail()`, which uses `strlen`, so the text is truncated at the first U+0000 exactly as today (`'Error: Missing indicator: a\u0000b'` → `'Error: Missing indicator: a'`). Lone surrogates arise from `slice(0,64)`/`slice(0,256)` cutting a pair; OpenJDK turns them into U+FFFD (Android libcore not verified), the same for both backends. Results stay valid UTF-8 because the JSON writer escapes lone surrogates.

#### 3.9.4 `runtimeMetrics()` and memory statistics

`runtimeMetrics()` (JV:275) is **public** (**checked**). It runs `check()` and returns a `JSONObject` with keys in this order: `requestedLiveBytes`, `requestedPeakBytes`, `processLiveNativeHandles`, `processNativeHandlesCreated`, `processNativeHandlesFreed`, `scope` (QuickJS text: `'QuickJS requested bytes including aligned allocator headers; live handle counts include all engines and current isolated workers in this process'`). Values come from JNI `memoryStats` `[allocated, peak, live_hosts, created_hosts, freed_hosts]`; the last three are process-wide relaxed atomics (JNI:11, :53, :62, :105), incremented only after a fully successful create.

Consumers assert (all must stay true on Rust): `requested*Bytes` safe integers ≥ 1 with live ≤ peak; process counters safe integers; during ingestion collection 2 ≤ live ≤ 3 and created − freed == live (`scripts/android-ingestion-contract.mjs:9,66`); after closing everything, live == 1 and created − freed == 1 on a witness engine (`:147`, `scripts/test-android-scene-packet.mjs:38`, `test-android-prepare.mjs:16`, `kotlin-consumer-contract.mjs:52`, `test-android-retention.mjs:31`, `IngestionVerification.java:78`, `TimezoneVerification.java:64`, `HoverCacheVerification.java:77,98`, `RetentionVerification.java:137`, `NativeSoak.java:31`, Kotlin `ConsumerActivity.kt:250-251`).

Rules for Rust:
- The handle counters stay in `aster_jni.c` and are **shared by both backends**: `createRust()` (calloc → `'Allocation failed'`; `NewGlobalRef` or `bc_engine_new` failure → proposed `'Rust engine unavailable'`, classified `UNAVAILABLE`) sets `counted=1`, `live++`, `created++` only on success; `free` of a counted handle does `live--`, `freed++` whatever the backend. Witness engines use the default backend, so split counters would hide leaks.
- `requestedLiveBytes`/`requestedPeakBytes` = `bc_memory_stats` live/peak (live ≥ a fixed base > 0; peak monotonic). Values need not resemble QuickJS (an empty QuickJS engine is ≈ 2.5 MB live, 4.49 MB peak with 32 B headers).
- `scope`: chosen per backend (O7); proposed Rust text `'Rust engine accounted bytes for core-owned buffers and parsed arguments, not allocator RSS; live handle counts include all engines of both backends and current isolated workers in this process'`.
- `AsyncResult` metrics `sourceRuntimeMemoryBytes` (`memoryUsed(source)` after begin, JV:1138) and `workerRuntimeMemoryPeakBytes` (`memoryPeak(prepared)`, JV:1170-1191) are filled through the same JNI functions; nobody checks them. The fixed `memorySampling` string names QuickJS (O7).
- `memoryUsed/Peak/Stats` must be called on the thread that currently uses the handle (QuickJS `enter` rewrites `h->env` and the stack top).

### 3.10 Interaction with M0 normalization

#### 3.10.1 Record key order (M0 Task 1, committed as `f5c4dc8`; not merged)

M0 Task 1 normalizes record key order at the points where records are **created** (not only when saved), because `inspect()`, `nativeSceneJSON` layout and async payloads show in-memory order. Rust must canonicalize at the same points: drawing `add`/`edit`/`load`, group edits, gesture creation, workspace install (drawings, symbol, view), async UI and target imports (through `load`), `addPanel`/`setPanel`/`addAxis`/`setAxis`, `normalizedSeries`, the placement clone, `setSymbol`, `setDrawingTarget`, the preflight binding, `IndicatorEngine.add` (params).

Canonical orders in the M0 branch (to be confirmed when PR A merges): drawing `id, panel, locked, style, type, points, text, visible, axisId, seriesId`; style `color, width, fill, font`; anchor `time, price`; panels, axes, series, theme in `PANEL_KEYS`/`AXIS_KEYS`/`SERIES_KEYS`/`THEME_KEYS` order (contracts.mjs:11-14); symbol `id, exchange, timezone, currency, volumeUnit, priceDecimals, tickSize, adjustment, provider, adjustmentVersion`; drawingTarget `panel, axisId, seriesId`; view `from, to`; binding `key, revision, adjustmentVersion, priceUnit, adjustment`; indicator params in a per-builtin declaration order (e.g. sma/ema `[period, source]`, macd/ppo `[fast, slow, signal]`, bollinger `[period, deviation]`, stochastic `[period, smoothK, smoothD]`, vwap `[calendar, anchorTime, sessionMs, kinds, source, deviation]`, ichimoku `[conversion, base, span, displacement]`, pressure `[factor, shift]`), then other keys in UTF-16 order. Remaining keys always follow in UTF-16 code-unit order (compare `Vec<u16>`, not UTF-8 bytes or `char`); integer-like keys still come first by JS object rules. `optionRecord` reports the first unsupported key in that canonical order instead of `Object.keys` order (`{zeta, alpha, …}` → `alpha`; `{type, points, '10':1, '9':1}` → `10`), and `drawingStylePatch` checks keys in canonical order (`{fill:null, zeta:1}` → `'Drawing style nonempty defined patch required'` regardless of input order).

What changes with Task 1 (re-measure after merge): `inspect()` records (panels, axes, series, drawings, drawingTarget, symbol); `nativeSave`/`saveDrawings` and workspace drawings; params order in `saveStudies` and workspaces; workspace symbol; restored view; preflight `dataset`; `nativeSceneJSON` `layout.panels[i]`/`axes[]` leading keys (so the design §8.3 scene-byte gate must be re-measured); async UI payloads; multi-fault error choice. What does not change: workspace and studies series, panels, axes, theme and dataset (already written in `*_KEYS` order, so standard documents keep their bytes, including the demo panel `{"id":"price","weight":3,"label":…}`); all receipts; length-based limits; host envelopes. The M0 plan's literal series and panel orders (`['id','type','panel','indicator','color','width','offset']`, `['id','weight','scale','inverted','padding']`) would change standard documents; use the `*_KEYS` orders as the branch implementation does (§6.6).

Pre-M0 goldens (oracle `c8fd7ae5…`, needed until the merge): `addDrawing` builds `{id, panel, locked, style, ...input}` (a seriesId-only target appends `axisId`: `…,"points":[…],"seriesId":"l","axisId":"ax"}`); gestures create `type, seriesId, axisId, points, text`; `setDrawingVisibility` appends `visible`; style patches append keys in patch order; placement clones append `axisId`; `inspect` series `{"color":"#f0b755ff","width":1.5,"id":"e-line",…,"offset":0,"axisId":null}`; preflight `dataset` in caller order. Post-M0 values (branch bundle): `{"id":"e-line","type":"line","panel":"lower","indicator":"e","color":"#f0b755ff","width":1.5,"offset":0,"visible":true,"axisId":null,"label":"EMA"}`, drawing `…,"axisId":"ax","seriesId":"l"}`, style `{"color":"#f5b85a","width":1.5,"fill":"#112233ff","font":"14px sans-serif"}`.

#### 3.10.2 Params publish and the bounded map (M0 Task 3, pending)

Pre-M0, a params publish installs a `NativeCheckpointMap` with its own ledger whose limit is fixed at admission (§3.2.6). Observable effects (measured): later growth makes `indicatorValues`/`indicatorValueAt`/`nativeIndicatorBuffer` (and scenes that draw the series) throw `'Native checkpoint total byte limit'` where the synchronous path succeeds (219 records / 39,074,094 B without error); the 256 KiB record limit is enforced during calculation (`'Native checkpoint record byte limit'` after appending long decimals; the synchronous path defers the failure to the next async admission); removing other indicators or compacting does not raise the fixed limit; reset/prepend clear but keep it bounded; and the next params or workspace source accounting differs by provenance: same records, bounded vs ordinary → admission steps 18 vs 36, `plan.retainedBytes` 31878764 vs 52817676, `plan.totalBytes` 135616876 vs 156555788 (app-visible `logicalAdmissionBytes`), workspace finish `checkpointBytes` 24538732 vs 45477644, workspace `plan.totalBytes` 150403948 vs 171342860. Async-data and prepare publishes already install plain maps (measured: a params-bounded entry becomes a plain Map after `nativeAsyncFinish`).

With Task 3 (recommended, O4): every live entry has an ordinary checkpoint map; Rust stores `BTreeMap<u32, State>` per entry with no provenance flag; the "ordinary" numbers above are the expected values. Unchanged by Task 3: the params target 32 MiB ledger (`TargetStep` throws `'Native checkpoint total byte limit'` for sma(5000) on 56000 bars while the synchronous change succeeds), the import `remaining` budget (`'Native params result checkpoint budget'`), the 262144-byte record limit and the admission footprints.

Without Task 3 Rust must replicate: an entry state `Bounded{ledger}` with a ledger table; the limit `33554432 − other` computed once at admission; per-`set` record limit and ledger charge with refunds on delete/clear/dispose; deterministic re-failure after a partial write (records written before the failing one stay, `dirty` unchanged, `invalidated = true`); transitions on reset, prepend, compaction (bounded clear), removal, synchronous `setIndicatorParams` (back to an ordinary map), a second publish (retire and replace) and restored-engine adoption (NC:76); and the bounded formulas in params and workspace source accounting (not walked, not counted in `done`). About +450 lines.

#### 3.10.3 Goldens must name their bundle

Readers measured from the review directory while it changed (12:28-12:38 KST). Every tier-A golden in this document was measured on the pre-M0 oracle unless it says otherwise. After PR A merges: re-run the probes with `BUNDLE=<new bundle>`; re-measure the Task 1 class (inspect, drawings documents, params order, symbol, preflight dataset, scene layout, async payloads, multi-fault errors) and the Task 3 class (post-publish failures, plans, step counts, workspace finish); byte-compare the unchanged classes (workspace/studies records, receipts, in-job budgets, async-data and prepare publishes).

---

## 4. Error catalog for this surface

Same conventions as map §4. `Reach`: A reachable from host or JSON input, X unreachable natively (keep the message only), J JS-only. Messages already in map §4 with correct class and location are not repeated unless their reach changed. All IngestionError rows carry the code shown.

### 4.1 Async data jobs

| Message | Class | Code | Where | Reach |
|---|---|---|---|---|
| `Async capture busy` | Error | | B:5, B:6, B:40, P:12 | A |
| `Unknown async begin kind` | TypeError (thrown) | | B:8 | A |
| envelope `{error:{name:'IngestionError', code, message.slice(0,256)}}` | returned | PENDING_DATA, BUSY, CLOSED, STORE_BUDGET, INVALID_INPUT | B:9 | A |
| `Async stale: source replaced/released` | Error | | B:4 via B:48-54, B:49 | A |
| `Async UI capture busy` / `Async UI capture missing` / `Async UI incomplete source transfer` | Error | | B:52 / B:53 / B:54 | A |
| `Async target busy` | Error | | B:15, B:26, B:56, P:29 | A |
| `Async target missing` | Error | | B:57-60, B:64 | A |
| `Workspace target does not import source UI` | Error | | B:61 | A |
| `Async UI target unavailable` / `Async UI target missing` | Error | | B:61 / B:62-63 | A |
| `Params target registration` | Error | | B:49 | A |
| `nativeAsyncPrepared.checkpoint is not a function` (engine text) | TypeError (D8) | | B:58 on prepare/workspace targets; B:49-50 with a `PrepareCapture` ticket | A |
| engine JSON grammar text | SyntaxError (D8) | | B:5-6 parse; codec parse in create/import; `nativeAsyncFinish('')` without UI import | A |
| `Async unsupported axis formatter callback` / `Prepare unsupported axis formatter callback` / `Async unsupported formatter callback` | TypeError / TypeError / Error | | AS:30, :73; PS:16; AS:42 | J |
| `Async stale: model disposed` / `Prepare stale: source disposed` | Error | | AS:31 / PS:16 | X |
| `Ingestion session closed or replaced` | IngestionError | CLOSED | ingestion.mjs:65 via AS:31, PS:16 (after `nativeReleaseDataIngestion`) | A |
| `Ingestion has an active async lease or drain` | IngestionError | BUSY | ingestion.mjs:66 via AS:31, PS:16 | X (the slot is busy first) |
| `Drain or cancel pending data before async preparation` | IngestionError | PENDING_DATA | ingestion.mjs:114 | A |
| `Checkpoint state limit` / `Checkpoint depth limit` / `Checkpoint text limit` | RangeError | | checkpoint-validation.mjs:14 / :55 / :40, :44 via AS:31 (event), :37 (metadata), PS:19, AU:14 | A / A (edge) / practically X |
| `Checkpoint Unicode scalar` | TypeError | | checkpoint-validation.mjs:10: begin (event and metadata strings), `nativeAsyncUIBegin`, `nativeAsyncUINext` (cursor not advanced) | A on iOS only |
| `Checkpoint number marker` | TypeError | | checkpoint-validation.mjs:23 via AS:31 | A |
| `Async data event kind` | TypeError | | AS:25 (and again at :56) | A |
| `1–4096 ordered events required` and the snapshot family (map §4.4) | IngestionError | INVALID_INPUT | ingestion.mjs:34-42 via AS:25 (batch only) | A |
| `Every OHLCV field must be finite` / `Time must be an exact UTC millisecond integer in the Date range` / `Invalid OHLCV envelope` | TypeError / RangeError / RangeError | | data.mjs:43-48 via AS:25 (append/update/correction) | A |
| `Append time` / `Update time` / `Correction time` | RangeError | | AS:25 | A |
| `Async Float64 buffer` | TypeError | | AS:32 | X |
| `Async snapshot byte limit` | RangeError | | AS:32 | A (capacity 4194304 with ≥4 outputs plus series trees) |
| `Unsupported indicator module: <name≤128>; requires a canonical builtin or linked factory` | UnsupportedIndicatorError | UNSUPPORTED_INDICATOR_MODULE | AS:33, PS:17 (and targets AS:47, PS:14) | J (custom); X in Rust |
| `Batch exceeds configured stored-row/capacity-byte budget` | IngestionError | STORE_BUDGET | ingestion.mjs:18 via AS:35 | A |
| `Async stale: data/configuration/revision changed` / `Prepare stale: data/configuration changed` | Error | | AS:39 / PS:21 | A |
| `Async buffer slice` / `Async checkpoint slice` | RangeError | | AS:40 / AS:41 | A |
| `Async stale: active gesture` | Error | | AS:42 | A |
| `Async UI state limit` | RangeError | | AS:43 (`nativeAsyncUI`, not ported) | T |
| `Async metadata: object required` / `: plain object required` / `: unsupported field <key≤64>` | TypeError | | AS:47 | X |
| `Async protocol` | TypeError | | AS:47 | A (>1024 buffers); otherwise X |
| `Async output budget: limit 536870912`, `Async max bars: limit 4194304`, `Async length: limit <n>`, `Async revision: limit 9007199254740991`, `Async checkpoint size: limit 4194305`, `Async indicator <key>: limit <n>`, `Async dirty: limit 4194304`, `Async buffer: limit 8388608`, `Async buffer bytes`, `Async batch bar limit: limit <maxBars>`, `Async batch byte limit: limit 402653184`, `Async bars: limit <maxBars>`, `Async buffer slot: limit <buffers-1>` | RangeError | | AS:47, :51-52 | X |
| `Async store: …`, `Async capacity`, `Async indicator metadata: …`, `Async indicator: string limit 128`, `Async checkpoint size`, `Async indicator shape`, `Indicator module descriptor binding`, `Async batch limits event`, `Async batch limits: …`, `Async buffer reference(: …)`, `Async index: …`, `Async index size`, `Async finite-count cache role/leaf/aggregate`, `Async index buffers`, `Async column length`, `Async OHLC index`, `Async indicator id: …`, `Async indicator definition`, `Async checkpoint completeness`, `Async series output`, `Async finite-count cache marker`, `Async block index`, `Async cached capacity`, `Async block tree`, `Async finite-count cache aliases volume`, `Async duplicate series` | TypeError | | AS:27, :47, :51-55 | X |
| `Async output bytes` / `Missing indicator` | RangeError / Error | | AS:54 / AS:24 | X |
| `Async target slice` | RangeError | | AS:48 | A |
| `Async checkpoint rows` / `Async checkpoint order/history` | TypeError | | AS:49 | A |
| `Async checkpoint count` | RangeError | | AS:49 | X |
| `Async incomplete buffer capture` | Error | | AS:51 (also a second start) | A |
| `Async output definition` | TypeError | | AS:54 | **A** (capture after `compactData`) |
| `OHLCV array required` / `Prepend bars required` | TypeError | | data.mjs:101 / :155 via AS:56 | A (at start) |
| `Prepend must precede existing history without overlap` / `Times must be strictly increasing` / batch budget messages | RangeError | | data.mjs via AS:56 | A (at start) |
| `Async calculation not started` | Error | | AS:59 | A |
| `Calculation chunk size` | RangeError | | indicators.mjs:241 via AS:59 (lazy, first `next()`) | A |
| `Indicator output byte limit` / `Missing checkpoint` | RangeError / Error | | indicators.mjs:253 / :265 via AS:59, PS:36 | A / X |
| `Async result not ready` | Error | | AS:63 | A |
| `Async size` (and `Async size: …`) | TypeError | | AS:68 at `nativeAsyncUIImportEnd` | **A** (`nativeSize` outside 100..16384 × 80..16384) |
| `Async stale: panel binding` / `Async stale: series binding` | Error | | AS:74 / :75 | A |
| `Async UI state: …`, `Async unsupported preparation signature`, `Async view(: …)`, `Async crosshair(: …)`, `Async axis width`, `Async theme: …`, `Async UI collections`, `Async panel: …`, `Async unsupported panel formatter callback`, `Async duplicate panel`, `Async UI axes`, `Async axis: …`, `Async series patch: …`, `Async drawing target: …`, `Async drawings: …`, `Async drawing history`, `Async selection` | TypeError | | AS:64-80 | X |
| `Prepare stale: request/input binding` / `Async stale: indicator request binding` / `Async ingestion payload must be empty` | Error | | AS:65, :66, :83 | X |
| `Async precision: limit 18` / `Async drawing serial: limit 9007199254740991` | RangeError | | AS:70, :80 | X |
| `Prepare request: object required` / `: plain object required` / `: unsupported field <key>` | TypeError | | PS:12 via :16 | A |
| `Prepare input kind` | TypeError | | PS:12 | A |
| `Prepare bar count: limit 4194304` / `Prepare seed: limit 4294967295` / `Prepare visible bars` | RangeError | | PS:12 | A |
| `Prepare source bar limit: limit <maxBars>` | RangeError | | PS:16 | X natively |
| `Prepare borrowed series values unsupported` | TypeError | | PS:18 | A |
| `Prepare indicator output budget` / `Prepare retained typed-byte budget` | RangeError | | PS:27 | A / X |
| `Prepare metadata: …`, `Prepare protocol`, `Prepare input: …`, `Prepare indicators`, `Prepare indicator: …`, `Prepare indicator id: …`, `Prepare duplicate indicator`, `Prepare output definition`, `Prepare series(: …)`, `Prepare series id: …`, `Prepare store options: …`, `Prepare timeframe/origin` | TypeError | | PS:14, :27-28 | X |
| `Prepare output budget: limit 536870912`, `Prepare bar limit: limit 4194304`, `Prepare bars: limit <maxBars>`, `Prepare revision: limit 9007199254740991` | RangeError | | PS:27-28 | X |
| `Prepare target slice` / `Prepare incomplete input` / `Prepare step size` / `Prepare not started` | RangeError / Error / RangeError / Error | | PS:29 / :30 / :32 / :32 | A |
| `OHLCV UTC time` / `OHLCV increasing time` / `Volume sum overflow` | RangeError | | PS:34, :35 (columns) | A |
| `Async stale: UI changed during transfer` | Error | | AU:19 | A |
| `Async UI chunk text limit` / `Async UI single record exceeds chunk budget` / `Async UI chunk budget mismatch` | RangeError | | AU:14, :26, :34 | X |
| `Async drawing state: …`, `Async UI header: …`, `Async UI protocol`, `Async drawing header: …`, `Async drawing limits: …`, `Async UI frame counts`, `Async duplicate drawing ids`, `Async UI chunk: …`, `Async UI chunk order/offset`, `Async UI record: …`, `Async UI record slot`, `Async UI reference slot`, `Async UI unused record` | TypeError | | AU:18, :39-45 | X |
| `Async undo count: limit <h>`, `Async redo count: limit <h>`, `Async UI frame size: limit <maxDrawings>`, `Async UI history reference budget`, `Async UI chunk text`, `Async UI unique record budget`, `Async UI reference slot: limit <n>` | RangeError | | AU:39-43 | X |
| `Async UI import finished` / `Async UI incomplete transfer` | Error | | AU:41, :45 | X |

### 4.2 Indicator-params jobs

| Message | Class | Code | Where | Reach |
|---|---|---|---|---|
| `Params registration` | RangeError | | P:9 (Begin first check, Status, Abort) | A |
| `Params registration must increase` / `Params source ticket limit` | RangeError | | P:12 | A / X |
| `Workspace own data slot: <key>` | TypeError | | workspace.mjs:18 via P:13 (Begin in a runtime without globals; ticket consumed, registration not, no record) | A |
| `Workspace source stale: native owner replaced` | Error | | B:36 via P:5 | A |
| `Params source registration changed` | Error | | P:8, P:15 | X |
| `Params source ticket missing/released` | Error | | P:6 (does not drop) | A |
| `Params write already armed` / `Params unconsumed write` | Error | | P:21 / P:25 | A |
| `Params result slice` / `Params armed slice mismatch` | RangeError | | P:21 / P:22 (consumes the arm, drops) | A |
| `Params result write not armed` | Error | | P:22 (no drop) | A |
| `Workspace target global is not extensible` / `Workspace target requires an isolated empty runtime` | Error | | B:24 via P:29 | X / A |
| `Params target creation cancelled` | Error | | P:29 | X |
| `Params target missing` | Error | | P:30 | A |
| engine texts for ArmWrite in `noop`, Checkpoint/Prepare before Receive, a buffer read on a disposed target, metadata without plotOffsets | TypeError (D8) | | P:21, NPS:58, :61, B:49, NPT:22/NPI:14 | A (misuse) |
| `Native params actual API/model required` / `Native params source binding` / `Native params own data slots required` / `Native params linked factory` / `Native params factory changed params` / `Native params source length` / `Native params source capacity` / `Native params source vector` / `Native params capture closed` / `Native params plain series` / `Native params writable series cache` / `Native params definition changed` / `Native params entry owner` / `Native params checkpoint ownership` / `Native params entry commit stale` | TypeError/Error/RangeError | | NPS:15-61, NC:72-75 | X |
| `Indicator id: string limit 128` / `Indicator id: reserved identifier` | TypeError | | contracts.mjs:8, :10 via NPS:35, NPT:15 | A |
| `Indicator name: string limit 128` / `: reserved identifier` | TypeError | | via NPT:15 | X (forged) |
| `Native params host revision` / `Native params byte budget` | RangeError | | NPS:35 | A |
| `Native params registration` | RangeError | | NPS:35 | X |
| `Chart disposed` | Error | | NPS:37 | X |
| `Native params active gesture` | Error | | NPS:37 | A |
| `Model has an active async ingestion fence` | IngestionError | BUSY | via NPS:37, :62 | X |
| `Native params configuration limit` / `Native params entry limit` / `Native params registry limit` / `Native params checkpoint size` | RangeError | | NPS:21, :27, :28, :37 | X |
| `Missing indicator` | Error | | NPS:37 (before params validation) | A |
| `Indicator params…` family (map §3.7.11) | TypeError | | via NPS:38, NPT:15, NPI:13 | A |
| `Drain or cancel pending data before async preparation` | IngestionError | PENDING_DATA | via NPS:38 | A |
| `Unsupported indicator module: …` | UnsupportedIndicatorError | UNSUPPORTED_INDICATOR_MODULE | NPS:40 (custom factory, J), NPT:18 (unknown name) | J / A (forged) |
| factory messages (`Period must be 1..10000`, `Volume-direction factor/shift`, session-study errors) | RangeError/TypeError | | probe add at NPS:40, NPT:21 | A |
| `Native params output schema/offset change` | TypeError | | NPS:41 (output count/names, effective offset incl. 0↔−0, vwap deviation toggle, ichimoku displacement, pressure shift) | A |
| `Checkpoint Unicode scalar` | TypeError | | via NPS:42 (iOS lone surrogates); codec parse at NPT:13, NPI:10, :21 | A |
| `Native params total output byte limit` | RangeError | | NPS:43 | A |
| `Native params stale: source/owner changed` | StaleSourceError | | NPS:51 | A |
| `Native params admission records` | RangeError | | NPS:52 | A |
| `Native checkpoint record byte limit` | RangeError | | NC:8 via Step footprints (also the target's own old records), target calculate, import set | A |
| `Native checkpoint state limit` and the other native checkpoint shape messages (map §4.6) | RangeError/TypeError | | NC:9-10 | X for builtins |
| `Native params retained source budget` / `Native params other checkpoint byte limit` / `Native params combined logical byte limit` | RangeError | | NPS:52 / :53 / :53 | A |
| `Native params source slice` | RangeError | | NPS:55 | A |
| `Native params source copy incomplete` | Error | | NPS:56 | A |
| `Native params result metadata limit` | RangeError | | NPI:10 | A |
| `Native params result: object required` / `: plain object required` / `: unsupported field <key≤64>` | TypeError | | NPI:10 | A (forged) |
| `Native params result protocol` / `Native params result binding` / `Native params result parameters` / `Native params result output binding` | TypeError | | NPI:11, :11, :13, :14 | A (forged) |
| `Native params result dimensions` / `Native params result output byte limit` | RangeError | | NPI:12, :15 | X |
| `Indicator module descriptor binding` (and the descriptor record messages) | TypeError | | indicator-modules.mjs:11, :34-36 via NPI:13, NPT:18 | A (forged) |
| `Native params result checkpoint budget` | RangeError | | NPI:15 | **A** (other indicators near 32 MiB) |
| `Native params result phase` | Error | | NPS:57 | A |
| `Native params import closed` / `Native params import definition changed` / `Native params result not started` | Error | | NPI:18, :19, :23 | X |
| `Native params result slice` / `Native params result checkpoint record` / `Native params checkpoint declared bytes` | RangeError | | NPI:20 / :21 / :21 | A |
| `Native checkpoint total byte limit` | RangeError | | NC:16: import ledger, target ledger, post-publish growth of a bounded map (pre-M0) | A |
| `Native params validation phase` | Error | | NPS:59 | A |
| `Native params result incomplete` | Error | | NPI:22 | A |
| `Native params validation work size` | RangeError | | NPI:23 | A |
| `Native params result finite/NaN tail` | TypeError | | NPI:24 | A |
| `Native params result not ready` | Error | | NPI:27 | A |
| `Native params stale ingestion release` | Error | | NPS:62 (a second Prepare with a session) | A |
| `Native params not armed` | Error | | NPS:66 | A |
| `Native params metadata limit` / `Native params dimensions` / `Native params byte limit` / `Native params output limit` / `Native params target logical byte limit` | RangeError | | NPT:13, :16, :17, :23, :24 | A / A / A / X / A |
| `Native params metadata: object required` / `: plain object required` / `: unsupported field <key≤64>` | TypeError | | NPT:14 | A (forged) |
| `Native params protocol` / `Native params output binding` | TypeError | | NPT:15 / :22 | A (forged) |
| `Native params target closed` | Error | | NPT:29 | A |
| `Native params target entry changed` / `Native params checkpoint count` / `Native params output capacity` / `Native params output finite/NaN` / `Native params checkpoint record limit` | Error/TypeError/RangeError | | NPT:30, :36, :37, :37, :44 | X |
| `Native params input slice` / `Native params incomplete input` | RangeError / Error | | NPT:31 / :32 (no dispose) | A |
| `Native params work size` / `Native params work size must remain fixed` / `Native params not started` | RangeError / RangeError / Error | | NPT:34 (dispose) | A |
| bar validation messages (map §3.4.2) | TypeError/RangeError | | data.mjs:44-47 via NPT:35 (dispose) | A |
| calculation errors (`Output must be finite or NaN`, …) | TypeError/RangeError | | indicators.mjs via NPT:36 (dispose) | A |
| `Native params target not ready` / `Native params output slice` / `Native params checkpoint ordinal` | Error / RangeError / RangeError | | NPT:41 / :43 / :44 | A |

### 4.3 Ingestion queue and unchanged batch (additions to map §4.4)

| Message | Class | Code | Where | Reach |
|---|---|---|---|---|
| `Unknown ingestion command` | TypeError (thrown) | | B:92 | A |
| `Unknown chart command or argument list` / `Chart command argument count` / `Chart disposed` / the pre-`nativeInit` ReferenceError (engine text) | enveloped | INVALID_INPUT (INVALID_DOCUMENT for load) | `api.mjs:73-75` via B:93 | A (raw call) / A / X / A |
| `Configure data ingestion first` | IngestionError | NOT_CONFIGURED | `api.mjs:101` | A |
| `Ingestion session closed or replaced` | IngestionError | CLOSED | ingestion.mjs:65 (every op on a closed session; configure/load via `old?.idle()`) | A |
| `Drain or cancel pending data before reconfiguration` / `Cancel or drain pending data before restoration` | IngestionError | PENDING_DATA | `api.mjs:102` / `:110` | A |
| `Ingestion policy object required` / `… plain object required` / `… unsupported field` / `… data properties required` | IngestionError | INVALID_INPUT | ingestion.mjs:24-28 via :45 | A / A (iOS `__proto__` dictionary) / A / X |
| `Stream id: string limit 128` / `Stream id: reserved identifier` | IngestionError (rewrapped TypeError) | INVALID_INPUT | ingestion.mjs:45 | A |
| `generation integer range` … `maxStoreBytes integer range` (field order generation, firstSequence, maxQueuedEvents, maxQueuedBytes, maxBatchEvents, maxStoredBars, maxStoreBytes) | IngestionError | INVALID_INPUT | ingestion.mjs:47-49 | A |
| `Current history exceeds ingestion admission budget` | IngestionError | STORE_BUDGET | ingestion.mjs:50 (configure, load, workspace admission facade) | A |
| `Async ingestion lease active` | IngestionError | BUSY | ingestion.mjs:77/79 (enqueue, counted), :108-110 (pause, resume, cancel) | A |
| `Ingestion paused` | IngestionError | PAUSED | ingestion.mjs:77/79 (enqueue, counted, before packet validation), :93 (drain) | A |
| `Source changed outside ingestion while payload is pending` | IngestionError | SOURCE_CHANGED | ingestion.mjs:69 (enqueue counted with +0 events; drain not counted); also the computed `lastError` | A |
| `Packet object required` / `Packet plain object required` / `Packet unsupported field` / `Packet data properties required` | IngestionError | INVALID_INPUT | ingestion.mjs:78 | A / A / A / X |
| `Packet stream/generation mismatch` | IngestionError | STREAM_MISMATCH | ingestion.mjs:81 (strict `!==`; counted with the snapshotted events) | A |
| `firstSequence integer range` | IngestionError | INVALID_INPUT | ingestion.mjs:82 (packet) | A |
| `Packet firstSequence must equal nextSequence` | IngestionError | SEQUENCE_MISMATCH | ingestion.mjs:82 | A |
| `Packet exceeds queued event/typed-byte budget` | IngestionError | QUEUE_BUDGET | ingestion.mjs:83 | A |
| `Sequence/counter limit` | IngestionError | SEQUENCE_LIMIT | ingestion.mjs:84 | A |
| `Owner/cursor changed during packet snapshot` / owner-changed configure/restore messages | IngestionError | SOURCE_CHANGED | ingestion.mjs:63, :80, :131; `api.mjs:102, :110` | X |
| `Owner guard callback required` | TypeError | | ingestion.mjs:75 | X |
| `Drain count integer range` | IngestionError | INVALID_INPUT | ingestion.mjs:93 (after `source()`, before the empty-queue return) | A |
| `<cause message ≤256>` (e.g. `Data batch bar budget limit 12`, `Times must be strictly increasing`, `Data batch update is only the current timestamp`, `Data batch correction requires an existing timestamp`, `Volume sum overflow`, `Length-changing ingestion requires host realignment of external values`) | IngestionError | DRAIN_FAILED | ingestion.mjs:105 (side effects: paused, lastError, failedDrains++) | A |
| `Length-changing batches require host realignment of external values` | IngestionError | EXTERNAL_ALIGNMENT | `api.mjs:100` (typed batch, `applyDataEvents` op, unchanged batch) | A |
| `Data batch bar budget limit <N>` / `Data batch store byte budget limit <N>` | RangeError (own code STORE_BUDGET, not host-visible) | | data.mjs:40 via `api.mjs:100`; N = the policy value when any session is attached, closed included | A |
| `Native batch own data required` | TypeError | | T:3 | A (before `nativeInit`) |
| `Native batch disposed data required` / `Native batch receipt invalid` / `Native batch publication version` | TypeError | | T:4, :17, :20 | X |
| `Native batch owner/source changed` | StaleSourceError | | T:5, :10-13, :19 | X |
| `Workspace own data slot: time` | TypeError | | NWS:24 (workspace begin after `nativeReleaseDataIngestion`) | A |
| `Native asynchronous job is active` | Swift `BaroChartIngestionError` (host) | BUSY | SW:1619 | A |
| `Data ingestion has an active asynchronous calculation` / `Compaction has an active asynchronous calculation` | Java `IngestionException` (host) | BUSY | JV:218 / :216 | A |

### 4.4 Data exploration

| Message | Class | Where | Reach |
|---|---|---|---|
| `Exploration action` / `Exploration active boolean` / `Exploration navigation key` / `Exploration action takes no argument` | TypeError | E:7-10 (before engine access) | A |
| `Exploration owner data property required` | TypeError | E:3 via E:11-12, :14 | **A** (runtime without `nativeInit`) |
| `Exploration requires an idle gesture` | Error | E:14 (`setActive(true)` only) | A |
| `Enable data exploration first` | Error | E:25 (navigate inactive), K:25 (read inactive) | A |
| `Exploration disposed data property required`, `Native exploration owner/source changed` (StaleSourceError), `Exploration operation already running`, `Keyboard exploration owner changed` (StaleSourceError), `Exploration series limit` (RangeError), `Exploration mode boolean`, `Exploration read already running`, K:9 `Chart disposed` | various | E:4-18, K:5-25 | X |
| `Data selection plain record` / `Data selection fields` | TypeError | DX:9 via :34 | A |
| `Data selection own data fields` / `Data query options own data fields` | TypeError | DX:9 | X |
| `Data query options plain record` / `Data query options fields` | TypeError | DX:9 | A |
| `Data query index` / `Data query time and explicit match` | RangeError | DX:36 / :37 | A |
| `Data query hidden flag` / `Data query indicator mode` | TypeError | DX:38 / :39 | A |
| `Data query cutoff` | RangeError | DX:44 | A |
| `Symbol id: string limit 128` / `Currency: string limit 64` / `Volume unit: string limit 64` | TypeError | DX:53 (before lookup) | A |
| `Data query Float64 column length` | TypeError | DX:11 via :76 (stale external values) | A |
| `Data query own model required`, `Data query API owner changed`, `Data query owner object`, `Data query missing <key>`, `Data query own data properties required`, `Data query managed store/indicators`, `Data query source length`, `Shared data query buffer`, `<label> array`, `<label> limit/shape`, `Data query indicator limit`, `Data query definition metadata`, series identifier messages, `Data query series binding`, `Data query series offset`, label/type/symbol/indicator bound messages, `Data query source field`, `Missing indicator`, `Indicator output: string limit 128`, `Missing indicator output`, `Data query cached output shape`, `Data query cached Float64 output`, `Data query source or display configuration changed` (StaleSourceError), bar validation | various | DX:8-89, `api.mjs:149` | X |
| lazy calculation errors (`Indicator output byte limit`, `Native checkpoint total byte limit`, `Output must be finite or NaN`, …) | as thrown | DX:85 (calculate mode); propagated by explorer `read` | A |

### 4.5 Tier-A `nativeCommand` ops (additions to map §4.7-4.10)

| Message | Class | Where | Reach |
|---|---|---|---|
| `Compaction pending source version changed` / `… append must follow virtual tail` / `… update must match virtual tail` / `… correction requires retained timestamp` | Error | compaction.mjs:18, :31, :32, :33 | **A** (all four) |
| `Compaction source peak byte limit` (invalidArgument) vs `Compaction source peak byte budget` (budgetExceeded) | RangeError | compaction.mjs:51 / :73 | A |
| `Compaction visible range` | TypeError | compaction.mjs:66 | X |
| `Panel layout change during active gesture` | Error | model.mjs:42 via :163 (setPanelOrder), :172 (removePanel), :245 (removeAxis, only on a width change), :210/:212/:216 (setIndicatorPlacement); pointers without a gesture also trigger it | A |
| `Panel order must contain every current panel exactly once` | TypeError (length) / **Error** (duplicate or unknown id) | model.mjs:156 / :158 | A |
| `Panel order dense array required` / `Panel order id: string limit 128` / `: reserved identifier` | TypeError | model.mjs:155, :158 | A |
| `Panel is referenced by an active drawing transaction`, `Indicator placement during drawing transaction`, setPanelOrder's `Panel layout change during drawing transaction` | Error | model.mjs:177, :212/:215/:217, :164 | X natively (the gesture check fires first) |
| `Indicator placement record required` / `… fields` / `… panel required` / identifier messages | TypeError | model.mjs:57-61 | A |
| `Indicator placement axisId data field required` / `Indicator placement owner changed` (StaleSourceError) | TypeError | model.mjs:60, :79-82 | X |
| `Missing placement panel` / `Missing placement axis` / `Indicator has no bound series` | Error | model.mjs:203, :193 | A |
| `Drawing target: object required` / `: plain object required` / `: unsupported field <key>`; `Drawing target panel: …` | TypeError | interaction.mjs:55 | A |
| `Duplicate drawing id` | **TypeError** in group edits (Error in `add`) | drawing-translation.mjs:53 | A |
| `Drawing group edit plain record required` / `… fields` / `… requires no active gesture or transaction` / `… plain array required` / `… array limit/shape` / `… requires 1..128 ids` | TypeError / TypeError / Error / TypeError / RangeError / RangeError | drawing-translation.mjs:9, :46, :10, :52 | A |
| `Drawing style plain record required` / `Drawing style fields` / `Drawing style own data fields required` | TypeError | drawing-style-patch.mjs:4, :7 | **X** through `setDrawingsStyle` (map §4.8 says A) |
| `Drawing duplication resource limit` / `Drawing duplication document limit` | RangeError | drawing-translation.mjs:78, :82 | A |
| `Drawing group edit point limit`, `… resource limit`, `Drawing duplication ID exhaustion`, `Drawing duplication serial`, `… history/resource limit`, `… undo snapshot exceeds historyBytes`, `… retained history resource limit` | RangeError | drawing-translation.mjs:57-93 | X |
| `Position drawing required` | TypeError | `api.mjs:256` | A |
| `Drawing text, at most 2000 characters` | TypeError | `api.mjs:272` | A |
| `Indicator module id` / `Indicator module version` / `id: string limit 128` / `id: reserved identifier` | TypeError | indicator-modules.mjs:9-10 | A |
| `Indicator module name conflict` | Error | `api.mjs:243` | J (unreachable in Rust) |
| `Volume-direction factor/shift` | RangeError | trusted-studies.mjs:7 | A |
| `Volume-direction checkpoint` / `Volume-direction checkpoint: object required`/`plain object required`/`unsupported field <key>` / `Checkpoint state integer` | TypeError | trusted-studies.mjs:14-15, checkpoint-validation.mjs:124 | A (restore path, forged records) |
| `Module checkpoint index` / `Module checkpoint validation failed or mutated state` | RangeError / TypeError | indicator-modules.mjs:40, :46 | X for pressure |

### 4.6 Public surface, legacy helpers and host-side strings

| Message | Class | Where | Reach |
|---|---|---|---|
| `Native indicator slice` | RangeError | B:65 (no engine; after `get(id)`: non-own output, bad offset/count, `offset+count > n`) | A |
| `Missing indicator: <ToString(id)>` | Error | indicators.mjs:242 via B:65 (before the slice checks) | A |
| `Indicator byte slice limits` | Java IllegalArgumentException | JV:276 | A |
| `Indicator byte slice bounds` / `Indicator identifier UTF-8 failed` / `Native argument size limit` | JNI IllegalStateException | JNI:113, :31, :33 | A / X / X (Java pre-checks) |
| `Async helper must return an intrinsic Float64Array` / `Async Float64Array byte length/bounds mismatch` | JNI IllegalStateException | JNI:66, :68 | X (keep the second as the Rust length guard) |
| `Unknown drawing tool` | Error | interaction.mjs:54 via B:147 | A |
| `Zoom factor` / `Visible range` / `Chart needs at least 100 × 80 CSS pixels` | RangeError | model.mjs:297, :295, :333 via B:148/B:136 | A |
| `Index length: limit <capacity>` | RangeError | RangeIndex via model.mjs:291 (raw `nativeAddSeries` with `values:0`) | A |
| `Values must be aligned Float64Array` / `Series style/visibility` / `Series source` / `Candles/OHLC use primary store OHLCV` | TypeError | model.mjs:271, :266, :272, :268 (raw `nativeAddSeries`) | A |
| `Panel patch: object required` / `Panel scale/range` | TypeError / RangeError | model.mjs:152, :149 (raw `nativeSetPanel`) | A |
| `Native packet background string` / `Color string required` / `Portable color: …` / `Workspace: unsupported field <k>` / `Workspace external values unsupported` | TypeError/RangeError | N:16, scene-parts.mjs:46, workspace.mjs:38, :55 (after raw `nativeTheme`/`nativeAddSeries`) | A |
| `Data batch array required`, `Data batch event count must be 1..4096`, `Data batch event plain data record required`, `Data batch event unsupported field or accessor data property`, `Data batch event required data property`, `Data batch event kind must be append, update or correction`, `Data batch OHLCV plain data record required` (and siblings), `Numeric column values required`, `Data event kind required`, `Unknown data event`, `Update is only the current bar`, `Correction requires an existing timestamp` | TypeError/RangeError | data.mjs:11-40, :129, markets.mjs:200-208 (raw `nativeDataEvent`) | A |
| `Bar index` | RangeError | data.mjs:181 (`nativeBenchmarkEvent`; `nativeBenchmarkDigest` after its scene side effect) | A |
| typed-array length text (V8 `Invalid typed array length: <n>`, QuickJS `invalid length`) | RangeError (D8) | B:190 (digest on an array shorter than `length`) | A |
| `Workspace own data slot: <key>` | TypeError | workspace.mjs:18 via P:13 | A |
| `Missing function: <name>` | Swift host `.javaScript` | SW:110, :1431 | A |
| `not a function` | TypeError (QuickJS text) | Android `invoke` of an undefined global | A |
| `'nativeAPI' is not defined` (and `nativeModel`, `nativeInput`); `cannot read property 'drawings' of undefined` | ReferenceError / TypeError (D8) | live-only globals on an empty runtime | A |
| Swift host `invalidProtocol` texts for async (`'Invalid timeout'`, `'Data event must be valid JSON'`, `'Oversized data event'`, `'Visible bars 1...4194304'`, `'Prepare count/visible bars'`, `'Source runtime is retiring'`, `'Prepare must not copy source buffers'`, `'Invalid compute progress'`, `'Invalid progress bounds'`, `'Oversized UI header'`, `'UI drawing frame counts'`, `'UI reference budget'`, `'Oversized UI chunk'`, `'UI completion boolean'`, `'UI reference chunk bounds'`, `'UI transfer incomplete'`), params (`'Params request bounds'`, `'Params request must be valid JSON'`, `'Params request size'`, `'Params source changed during arguments'`, `'Params registration'`, `'Params ticket'`, `'Params admission phase'`, `'Params admission descriptor'`, `'Params metadata binding'`, `'Params capacity'`, `'Params admission bytes'`, `'Params target phase'`, `'Params target progress'`, `'Params result descriptor'`, `'Params result bounds'`, `'Params checkpoint count'`, `'Params checkpoint record'`, `'Params validation phase'`, `'Params status binding'`, `'Params published receipt'`, `'Params offset receipt'`, `'Params release not confirmed'`, `'Params publication unresolved'`, `'Params not committed'`) and shared decoders (`'Expected JSON string'`, `'Expected bounded JSON object string'`, `'Invalid integer'`, `'Invalid copy count'`, `'Expected Float64Array'`, `'Missing typed buffer'`, `'Typed buffer bounds mismatch'`) | `BaroChartAsyncError.invalidProtocol` | SW:123-1337 | host-generated; Rust must keep the fields these checks read |
| Java host texts: `'Async timeout/step limits'`, `'Async event, options and listener required'`, `'Async event size limit'`, `'Owned columns required'`, `'Synthetic bar count limit'`, `'Visible bar limit'`, `'Async calculation requires a main/UI owner engine'`, `'Workspace or parameter update is active'`, `'Async params busy'`, `'Params arguments required'`, `'Async descriptor limits'`, `'Async buffer descriptor'`, `'Async checkpoint descriptor'`, UI transfer texts, `'Async source release failed'`, `'Params begin registration'`, `'Params admission completion'`, `'Params metadata limit'`, `'Params progress bounds'`, `'Params result metadata'`, `'Params checkpoint text'`, `'Params checkpoint bounds'`, `'Params checkpoint order'`, `'Params validation completion'`, `'Params acknowledgment'`, `'Params status object'`, `'Params status registration'`, `'Params status string'`, `'Params publication receipt binding'`, `'Params publication outputs'`, `'Params publication output name'`, `'Params publication offset output'`, `'Params receipt'`, `'Params receipt binding'`, `'Drawing duplication receipt shape'`, `'Data query object receipt'`, `'Exploration object receipt'`, `'Exploration engine closing'`, `'Exploration engine changed'`, `'Data batch owner changed'` | IllegalArgument/IllegalState/JSONException | JV:170-1219, ParamsUpdateJob.java | host-generated |

### 4.7 Rust-only errors

| Message | Class | Code | Where |
|---|---|---|---|
| `Indicator source registration requires the javaScript backend` | UnavailableError | JAVASCRIPT_BACKEND_REQUIRED | `nativeRegisterIndicatorSource` stub (§3.7.2) |
| `Indicator module requires the javaScript backend: <name>` | UnavailableError | JAVASCRIPT_BACKEND_REQUIRED | workspace and studies document rule (§3.7.3) |
| `<name> is not available in the Rust backend` | UnavailableError | | not-ported stubs (§2.6) |
| `<name> is not available in the Rust backend yet` | UnavailableError | | M1 interim only |
| `… backend is not included in this build` | UnavailableError | | single-backend artifacts (M1 plan) |
| `Chart disposed` (host shows `Error: Chart disposed`) | status POISONED | | any non-whitelisted call on a poisoned engine (§3.8) |
| `Engine closed` (Android) / `engineClosed` (iOS) | status CLOSED | | stale handle after `bc_engine_free` |
| `Rust engine unavailable` (proposed) | JNI IllegalStateException | | `createRust` failure |
| `Native argument depth limit` (M0c) | SyntaxError | | host value argument traversal / JNI text scan |
| `Drawing document depth limit` (M0c) | RangeError | | before `drawings.mjs:39` |
| `Native data event document depth limit` (M0c) | RangeError | | before B:5 JSON.parse |
| `Native prepare document depth limit` (M0c) | RangeError | | before B:6 JSON.parse |

### 4.8 Engine-resource errors (compare the class only, or skip)

| Message | Class | Engine | Where |
|---|---|---|---|
| `stack overflow` | SyntaxError | QuickJS | recursive JSON parse past the 1 MiB budget (JNI argument parse, `drawings.mjs:39`, B:5, B:6) |
| `stack overflow` | InternalError | QuickJS | `JSON.stringify` of a deep result (JNI:60) |
| `Maximum call stack size exceeded` / `Maximum call stack size exceeded.` | RangeError | V8 / JSC | deep `JSON.stringify` (6,818 / 40,000 levels) |
| `out of memory` | InternalError | QuickJS | 805306368-byte accounted cap (Rust Android: same text by design, §3.9.2) |
| `invalid string length` | RangeError | QuickJS | strings over 2^30−1 units |
| `Out of memory` | RangeError | JSC | huge single allocations (Rust iOS on `try_reserve` failure) |
| `Native result size limit` | JNI IllegalStateException | both | result JSON over 268435456 UTF-8 bytes (measured with a 268,435,455-char string) |

---

## 5. Port order for this surface (on top of map §2.2)

Each step ends with a differential gate against the oracle in `node:vm` (and the same bundle under JSC/QuickJS where the platform matters), using `Object.is` for numbers and byte comparison for JSON and error strings `name: message` (plus `code`). The design milestones (design §8.1) are in brackets.

| Step | After map step | Port | Checkpoint and goldens |
|---|---|---|---|
| A0 [M1] | S1 skeleton | Function table with all 100 names and statuses; `bc_supports`; reject stubs (§2.6, §3.7.2); unknown-name platform texts; `UnavailableError` classifier rules; JNI restructuring (pre-checks before the branch, TRANSPORT and NOT_FOUND statuses, WTF-8 error text, shared handle counters, `createRust`) | census = 100 names; `supports` matches the JS bundle except not-ported names; shared classifier tables with the two new rows green on both platforms; JNI pre-check corpus (`tier-a-resource-limits/qjs/qjsjni32`, `basic.txt`); `runtimeMetrics` ledger assertions with mixed backends |
| A1 [M2] | 3 | Ingestion queue: session model, 9 ops, envelope, epoch, rejection accounting, `source()`/`sourceStatus()`, closed attached session, budget injection, unchanged batch | `tier-a-ingestion-queue/p1`-`p20` outputs byte-identical (`goldens-v8.txt`); the Swift fixture replay `p11`; −0 save text (`p10`); saturation (`p9`); ring wrap (`p15`); `save(load(t)) === t` for every saved text |
| A2 [M3] | 4 | `pressure` (factory, step, checkpoints, descriptor, validator); `registerIndicatorModule` static table | §3.5.15 vectors; checkpoint texts at 0/256/512; validator corpus (`t21`); the studies golden of §3.5.17 |
| A3 [M2-M4] | 5, 6, 9 | Tier-A ops: compaction (pending revalidation, removed-0 path, revision kept), `setColumns`, panels/axes gating, `setDrawingTarget`, `crosshairSnapshot`, `setSeriesValues`, placement clone, `indicatorValues`, studies, `positionMetrics`, group edits, `deleteDrawing`, `saveDrawings`, `setText`, `pan` | `tier-a-advanced-ops/t1`-`t26`; `test/compaction-oracles.test.mjs`, `drawing-translation-oracle.test.mjs`, `study-setup-oracle.test.mjs`, `position-drawing*.test.mjs`; `examples/native/axis-verification.swift` and `ingestion-verification.swift:150-165` traces |
| A4 [M4] | 4, 5, 9 | Exploration: `dataAt` (order, two phases, cached readiness, causality), explorer state machine and texts | `tier-a-exploration/p1`-`p18`; `test/data-explorer*.test.mjs` (all 35 builtins, cached vs calculate); `test/native-exploration.test.mjs`, `keyboard-explorer.test.mjs`; restore golden (`p18`) |
| A5 [M4-M5] | 7, 8, 11 | Public surface: legacy helpers (theme as a `Value` map, O3), benchmark helpers, `nativeIndicatorBuffer` and the Rust `indicatorSlice` path, Android typed-array JSON (O6), empty-engine behaviour, `nativeAccessibility` as a public global | `tier-a-legacy/golden.mjs` (digest n=64 sha256 `c3d62888…`, n=300, n=8192), `probe1`-`probe8`; `tier-a-indicator-buffer/slice-host` outputs and the 58-vector hash `1983021300a7ea4c`; QuickJS transport goldens (`tier-a-public-low-level-surface/qjs/s1`-`s5`) |
| A6 [M6] | 10 | Shared two-runtime machinery (§3.0): slots, busy matrix, ticket and registration rules, buffer routing, owner check with engine and `nativeSize` generations, error policies | busy-matrix corpus from `test/native-*` bridge tests; ticket goldens (§3.1.13); owner-check staleness after `nativeResize` with equal size |
| A7 [M6] | A6 | Async data jobs: capture (A1-A4), target (A5-A8), UI transfer (A9-A11), `finishUI` (A12), publish (A13), all quirks | `tier-a-async-data/gold.mjs`, `p1`-`p17` (descriptor envelope, every step string, header frameCounts, per-chunk ref counts, first failure `(step, name, message, code)`, source state after failure, published inspect/scene/drawings/ingestion bytes); Swift `async.swift` (31) and `prepare.swift` (43) as traces; Java `AsyncVerification`/`PrepareVerification` on Rust |
| A8 [M6] | A6, M0 Task 3 | Params jobs: capture and fingerprint, admission walk and plans, target cold calculation, import and ledgers, Prepare/Publish, records | `tier-a-params-async/g1`-`g7`, `e1`-`e9`, `s1`-`s3` (staleness matrix), `a1`-`a2`, `b1`-`b3`; plans byte-identical; with Task 3 landed, the "ordinary" numbers of §3.10.2 |
| A9 [M6] | A7, A8 | Custom-indicator document rule; lifetime: POISONED transition, whitelist, params ledger, `bc_engine_free`; resource limits (`MemoryAccount`, depth checks if O5 is adopted) | the unavailable-expectation table (§3.7.5) on both platforms; panic-injection acceptance tests (§3.8.6); `runtimeMetrics` runner assertions; QuickJS boundary cases for memory |
| A10 [M7] | 11 | Runners and suites on both backends | design §8.3 gate: trace corpus 100% (scene bytes after the M0 re-measure), XCTest, instrumentation, Compose, regression runners with JS-only rows from the expectation table |

Order constraints: A1 before A7 (async begins take the ingestion lease); A2 before A3 (studies) and A8 (pressure checkpoints); A6 before A7/A8; M0 Task 3 decided before A8; the M0 key-order merge before any byte golden of A3, A5 or A7 is frozen.

---

## 6. Corrections to the main map (and to the design and plans)

The main map is not edited here. Each item states what the map says and the fact, with evidence. Bold "Map §" numbers are main-map sections; plain parenthesized § numbers point into this document.

### 6.1 Header and scope (map header, §1)

1. **Header:** "Source snapshot … not a git checkout, so there is no commit id." The directory is a git checkout; the oracle is commit `11b467b` (bundle sha256 `c8fd7ae5…`). The directory's bundle no longer equals it (M0 branch, see this document's header). **(checked)**
2. **Map §1.1** "Job state machines … use strictly increasing registrations." Async-data jobs have no registration (the ticket is the only key). Params keep their own mark (`nativeParamsRegistration`, P:3), separate from workspace (B:2); the params registration is mandatory and consumed at row creation (P:14), the workspace one optional. Counters and marks are per runtime: after an async or workspace publish the engine restarts at ticket 1 (measured).
3. **Map §1.2 `nativeAsyncBuffer`** describes only the workspace branch. The async branch allows random access, repeats, `count 0` and any capture slot (≤1024); the params source branch is sequential with ≤16384 values and uses the Begin revision; the params target branch is keyed by the registration and allows random access; a `PrepareCapture` ticket gives an engine `TypeError` (§3.0.5).
4. **Map §1.2 `nativeAsyncTargetBuffer`** "Target columns 0..5" holds only for `PreparedData` and workspace targets. `AsyncPrepared` accepts slots 0..`bufferLengths.length-1`; in a params source runtime it is the one-shot armed write; in a params target it is the column input with ≤16384 values; seeded `PreparedData` rejects every call (`'Prepare target slice'`).
5. **Map §1.2 `nativeAsyncStart`/`nativeAsyncStep`**: for `AsyncPrepared` the start error is `Error 'Async incomplete buffer capture'` and start re-applies the event (reset/prepend/batch semantic errors surface there); steps report `calculate/indices/ready`, `maxBars` is not validated up front and a failed task stays installed (AS:51-60, measured).
6. **Map §1.2 note** "`nativeAsyncRelease` (async data jobs only)" is right about hosts, but it also drops a workspace source with the same ticket and always returns `true` (B:55). **(checked)**
7. **Map §1.2 `nativeAccessibility`** "used by the next function": it is also called by runners and benchmarks through the generic transports (`StudyVerification.java`, `MobileUXInstrumentation.java`, `study-verification.swift`, `benchmarks/cycle10/*`, `cycle11-native-readout.swift`); implement it as a public global.
8. **Map §1.2 `nativeRenderFrameJSON`** "JSON string of Frame": each non-null layer (`base`, `drawings`, `hover`) is a full scene object `{width, height, background, commands, layout, stats}`; Swift decodes each as `BaroChartScene` with integer-valued stats, and `hover` is required (`BaroChartFrameRenderer.swift:4-10`).
9. **Map §1.2 last line** "`nativeWheel` … is never called": true for SDK code only; `examples/native/main.swift:126-127` and `frame-validation.swift:21` call it.
10. **Map §1.2 `nativeReleaseDataIngestion`** "does not detach": the consequences are missing: every op (configure and load included) gives CLOSED until `nativeInit`; typed batches still get the closed session's budgets; `compactData` fails with the paused/empty message; `nativeWorkspaceSourceBegin` fails with `TypeError 'Workspace own data slot: time'`; async begins give CLOSED. Reachable only through raw calls (§3.3.7).
11. **Map §1.3.3 `dataAt`** "gap": specified in §3.4.
12. **Map §1.3.3 `nativeIndicatorBuffer` (Android package-private)**: the JS global is public on both platforms through `call()`/`invoke()`; only Java `indicatorBytes` is package-private, and Android runners in package `kr.coden.barochart` call it (`IngestionVerification.java:54`, `PrepareVerification.java:24-32`, `AsyncVerification.java:71,116`, cycle12/13 feeds). **(checked)**
13. **Map §1.4** is superseded by the owner decision: async data jobs, params jobs, exploration, the unchanged batch, the ingestion queue, the preflight receipt, `nativeIndicatorBuffer` and Java `runtimeMetrics` are tier A. `runtimeMetrics()` is **public** (JV:275, **checked**) and asserted by the Kotlin consumer and Android runners (§3.9.4).
14. **Map §1.4 raw JS row** lists `BaroChartView.fire()`: `fire` calls `invoke`, which is JSON in and JSON out over JNI (JV:74-79), so it is backend-neutral. Android has no raw JS surface; only Swift `context` and the `JSValue`-returning methods are raw.
15. **Map §1.4 pressure row and D10**: decided, ported (design §5.1). The checkpoint validator is part of the port (checkpoint-validation.mjs:124-125 → indicator-modules.mjs:38-47 → trusted-studies.mjs:13-17); map §3.8.4's "linked module → `validateModuleCheckpoint` (JS-only)" is wrong for pressure.
16. **Map §1.4 legacy row** "Bypass `ChartAPI` validation. Not called by the typed or view code": incomplete. `nativeIndicator`, `nativeTheme`, `nativeAddSeries` are documented (`docs/API-PARITY.md:46,56`, `docs/NATIVE.md:57`), runners call most helpers, and only `nativeTheme`, `nativeAddSeries`, `nativeSetPanel`, `nativeRemoveSeries`, `nativeDataEvent` and the non-atomic `nativeIndicator` really bypass the API; `nativeAddPanel`, `nativeView`, `nativeFit`, `nativeTool`, `nativeLoad` match API behaviour and `nativeSetData` matches the `setData` op's state. The API data commands do not check the ingestion fence either (`api.mjs:86`, `:100`). **(checked)** All 15 are implemented (§2.2).
17. **Map §1.4 benchmark row** (tier T): hosts parse and compare their results (`correction-benchmark.swift:103-105`, `AsyncVerification.java:28-33,113`, `PrepareBenchmark.java:18`); implement exactly (§3.6.3).
18. **Map §1.4 custom-indicator row** "reject … or pin to the JS backend": decided (§3.7): `UnavailableError` with code `JAVASCRIPT_BACKEND_REQUIRED`; no pinning or fallback (D12).
19. **Map §1.5 D1** superseded (full parity). **D2** covers only restored engines; the params async publish installs a bounded map with its own ledger fixed at admission (NPS:45, :52-53, :56 → NPI:15-16 → NC:71-79); M0 Task 3 already includes params (`plans/2026-11-02-rust-core-m0.md:179-209`, **checked**). **D4** "process-global `BarStore` serial": the counter is a module-level `let storeSerial=0` (data.mjs:9), so it is per JS runtime; each new context starts at 1 (**checked**, measured); Rust keeps it per engine. **D8** is incomplete: deep JSON changes the error **class** on QuickJS (`SyntaxError`/`InternalError: stack overflow`), not just the text (§3.9.1). **D12**: under the owner decision there is no "pin to JS" path; JS-only features raise `UnavailableError`.

### 6.2 Data, ingestion, indicators (map §3.4-§3.8, §5)

20. **Map §5 rule 36**: "visible through `nativeIndicatorBuffer` bytes and async copies only" is wrong for `nativeIndicatorBuffer`: B:65 slices `get(id).outputs[output]`, which is `arrays[i].subarray(0, n)` (indicators.mjs:284), and requires `offset+count ≤ n`, so the stale tail is never readable there (measured: after a 300→280 reset only `(279,1)` succeeds). Stale tails are visible in async-data capture buffers (capacity length) and `nativeBenchmarkDigest` hashes raw bits of `[0, n)` without recalculating. **(checked)**
21. **Map §5 rule 24** (intended coercions) misses `nativeWheel`: `delta*.001` and `x-p.left` use JS `ToNumber` (interaction.mjs:127).
22. **Map §3.2 optionRecord** "first violation in `Object.keys` order" is the pre-M0 rule; M0 Task 1 reports the first unsupported key in canonical order (§3.10.1). Mark the stage in §3.2, §3.7.11 and §4.2.
23. **Map §3.4.10 compaction**: all four pending-revalidation messages are reachable; `'preserve-retained'` revalidates even an empty queue (a store change outside ingestion then fails while the default policy succeeds); the `keep ≥ length` early return skips the fence, gesture and transaction checks; entry `revision` is kept; `previousBytes = 96*old capacity`, `peakSourceBytes = 96*(old+new)` when removed > 0, `firstRetainedTime = time[removed]`; `'Compaction visible range'` (X) sits between the percent-panel and ingestion checks (§3.5.1).
24. **Map §3.6.3/§3.6.4**: every enqueue rejection increments `rejectedPackets` (while < 2^53−1) and adds the already-snapshotted event count to `rejectedEvents` (saturating), including BUSY, PAUSED and SOURCE_CHANGED; rejections, failed drains, stats/save and silent rebases do not change the epoch; pause increments it even when already paused (measured).
25. **Map §3.6.5/§3.6.6**: `lastError` precedence is missing: while `count > 0` and the store version differs, stats and save report a computed SOURCE_CHANGED instead of a stored DRAIN_FAILED; the internal `paused` flag stays false until enqueue or drain; after cancel the stored DRAIN_FAILED shows again (ingestion.mjs:111).
26. **Map §3.6.7**: `dataIngestionBatchLimits` is reachable natively (async batch begin → STORE_BUDGET envelope, measured), not J. Single events, `setData`, `setColumns`, prepend and reset ignore the policy, after which **every** typed batch, update-only ones included, fails the policy budget; a closed attached session still injects its policy (`api.mjs:100` tests truthiness).
27. **Map §3.8.5/D2** apply to workspace restores only; async-data and prepare publishes install plain maps (measured), so neither D2 nor provenance tracking applies to them.
28. **Map §3.8.6**: the ledger is created by `NativeParamsImport` (NPI:16), not by `prepareNativeEntryCommit`; its limit `33554432 − otherCheckpointBytes` is fixed at admission and never recomputed (removing indicators or compacting does not raise it); `prepareNativeEntryCommit` also installs into `NativeCheckpointEntries` (restored engines: the old map is disposed and refunds the shared ledger, measured 22878 → 21708 B; the new map keeps its own ledger); a second publish of the same id retires the previous adopted map; reset, prepend and compaction clear but keep it bounded; the "141 records, 24,562,526 B" figure is data-dependent (24,465,426 B measured on `nativeInit(36000)`; the failure point after 20000 appends was 189 records / 33,468,776 B or 202 / 33,475,452 B depending on the appended values; limit 33,539,654 B).
29. **Map §3.8.5** "source accounting differs by provenance" applies to params as well: `plan.retainedBytes`, `plan.totalBytes` (app-visible `logicalAdmissionBytes`), admission step counts and workspace finish `checkpointBytes` (§3.10.2); and the lifecycle table lacks the params publish on a restored engine.

### 6.3 Model, drawings, scene, API (map §3.9-§3.13)

30. **Map §3.9.3 `_setIndicatorPlacement`** "returns `{changed, panel, axisId, boundIds}`" is the model-internal result; the op returns `{changed:0}` or `changed({changed:n})` (`api.mjs:208`). Also missing: `rejectOwnedInput` for any gesture **or pointer**, even when nothing moves; clones write `axisId` explicitly (appending `axisId:null`, visible in inspect, `saveStudies` and workspaces); range caches are not reset.
31. **Map §3.9.3 `removePanel`/`removeAxis`** "gesture check": the message is `Error 'Panel layout change during active gesture'` (model.mjs:42 via :172, :245) and pointers alone trigger it; for `removeAxis` the drawing-transaction check runs first and both apply only when strip widths change.
32. **Map §3.9.2** key-order examples are pre-M0 values; mark them (§3.10.1).
33. **Map §3.10.1** "Drawing record (ordered keys): {id, type, panel, points, …}" is the `validateDrawing` allow-list, not the stored order (pre-M0 `add` stores `{id, panel, locked, style, ...input}`).
34. **Map §3.10.6** misses position rules: duplicate writes `locked:false` in place or appends it; zero-offset copies share the original anchor array; translate and non-zero duplicates rebuild anchors as `{time, price}`; created rows come in source z-order.
35. **Map §3.10.11/§4.8**: `'Drawing style plain record required'` and `'Drawing style fields'` are unreachable through `setDrawingsStyle` (the group record check fires first); reachable order is color → fill → font → width.
36. **Map §3.11.5**: the crosshair background `portableColor` runs only when a crosshair command is built (a raw numeric background renders without hover); the packet path always requires a string background (`'Native packet background string'`, N:16).
37. **Map §3.11.6/§3.13.3 `crosshairSnapshot`**: `createLayout` runs before the crosshair is read, so size/axis errors and lazy calculation happen even when the result is `null` (measured).
38. **Map §3.12.6 `setDrawingTarget`**: the cancel is global (transaction rollback, gesture start view and follow restored, pointers cleared) and runs only after validation succeeds.
39. **Map §3.13.2 `values()`**: ±Infinity is rejected for `Float64Array` input too; only NaN is tolerated there (`api.mjs:60, :62`). Through `nativeCommand`, `applyDataEvents` never returns an `unchanged` key.
40. **Map §3.13.10 duplicates**: both hosts reject `changed 0`; Java through `DrawingTranslationReceipt.changed` returning `value > 0`, raising `'Drawing duplication receipt shape'` (JV:180-187, :239). **(checked**; a reader's claim that Java accepts 0 is wrong.)
41. **Map §3.14.6**: the preflight `dataset` is in caller order before M0 and canonical after M0 Task 1.

### 6.4 Restore, bridge and errors (map §3.15-§4)

42. **Map §3.15.1**: `sourceRefs` also include controller fields (`input.model`, `tool`, `text`, `drawingTarget`, `gesture`, `pointers`, `pointers.size`; NWS:25). Measured: `nativeTool('trendline')` stales a capture, an idle `nativeTool('select')` does not; renders and resizes give `'Workspace source stale: native owner replaced'`; reads that commit a dirty indicator give `StaleSourceError 'Workspace source stale: owner/data/configuration changed'`.
43. **Map §3.15.2 "(initialize)" row**: `UnsupportedIndicatorError` and `'Indicator module descriptor binding'` occur at `nativeWorkspaceTargetCreate` (constructor: `readWorkspaceDocument` at NWT:20, `prepareDefinitions` at PS:14), not at initialize (NWT:45 is unreachable after them); the spec list also lacks the `PreparedData` metadata validation (PS:27) and `TypeError 'Native workspace factory changed metadata'` (NWT:38).
44. **Map §3.15.3/§4.13**: the engine `TypeError` for `nativeAsyncCheckpointImport` also occurs on `PreparedData` targets, and `nativeAsyncBuffer`/`nativeAsyncCheckpoint` with a `PrepareCapture` ticket give one too.
45. **Map §3.16.1** "explorer sessions are not reset; later owner checks detect them as stale": wrong. Explorers live in a `WeakMap` keyed by `nativeAPI` (E:2), so after `nativeInit` the next call silently creates a fresh inactive explorer (**checked**, measured). Params rows do survive `nativeInit`: the old row stays `'active'`, blocks every capture begin until Abort, and fails its next op with the owner error.
46. **Map §3.16.5**: Swift also requires `error.name == 'IngestionError'` and a `result` that is not `undefined` (SW:1625, :1628); Java checks nothing (`getString` coerces, JV:165-168); the pre-`nativeInit` ReferenceError is enveloped with engine text.
47. **Map §3.16.6** "workspace and params operations drop their session on error" needs exceptions: `'Params source ticket missing/released'` and `'Params result write not armed'` do not drop; on the params target only step errors dispose, and the disposed target stays installed, so `nativeParamsTargetCreate` reports `'Async target busy'` until dispose.
48. **Map §3.16.8 exploration** is incomplete: `read` while inactive also throws `'Enable data exploration first'` (K:25); `refresh`/`read` accept an absent or null argument; Enter/Escape are rejected at the bridge; the gesture rule applies only to `setActive(true)`; argument checks precede owner checks; phase `'error'` is never observable; only `read` calculates.
49. **Map §4.0 Java**: `'Native params byte budget'` and `'Native params result checkpoint budget'` also classify `BUDGET_EXCEEDED` (they contain "budget"); QuickJS `'InternalError: …'` falls to `classifyHostMessage` (`UNAVAILABLE`, text kept with its prefix); the two packet byte-budget JNI messages classify `BUDGET_EXCEEDED`; JSC `'Maximum call stack size exceeded.'` and `'Out of memory'` classify `invalidArgument` on Swift. A UIE message containing a user id with `cancel`/`budget` is misclassified on Android on both backends.
50. **Map §4.1 tiers**: `'Exploration owner data property required'` is reachable (runtime without `nativeInit`); `'Exploration disposed data property required'`, `'Native exploration owner/source changed'`, `'Exploration operation already running'`, `'Keyboard exploration owner changed'`, `'Exploration series limit'`, `'Exploration mode boolean'`, `'Exploration read already running'` are X. Missing params-reachable rows: `'Workspace own data slot: <key>'`, `'Workspace target global is not extensible'` via P:29, `'Async stale: source replaced/released'` via B:49, and the D8 engine `TypeError`s of §4.2.
51. **Map §4.4 gap** closed by §4.3; the fence BUSY is also asserted by the params source (NPS:37, :62) and at workspace source finish (NWS:54).
52. **Map §4.5 UIE** "thrown at :31, :32": also :39; in Rust only `registerIndicatorModule` and the document paths reach it; entry-based sites are X.
53. **Map §4.7** `'Panel layout change during active gesture'` callers are :163, :172, :245, :210/:212/:216; `'Panel is referenced by an active drawing transaction'`, `'Indicator placement during drawing transaction'` and setPanelOrder's transaction message are unreachable natively.
54. **Map §4.12**: `'Prepare request: …'`, `'Prepare input kind'`, `'Prepare bar count: limit 4194304'`, `'Prepare seed: limit 4294967295'` and `'Prepare visible bars'` are reachable from `nativePrepareBegin` (A, not X); `'Prepare indicator output budget'` at `nativePrepareCreate`; the capture-side messages (`'Prepare stale: source disposed'`, `'Prepare stale: data/configuration changed'`, `'Prepare borrowed series values unsupported'`, `'Prepare source bar limit: limit N'`, `'Prepare unsupported axis formatter callback'`) are missing.
55. **Map §4.13** lacks the engine-resource rows of §4.8 and the unknown-name texts (`not a function`, `Missing function: <name>`).

### 6.5 Platform seams (map §6, §7, Appendix C)

56. **Map §6.1 `close()`**: it retries pending workspace/params registrations **before** its `closed` check (SW:1586-1588), reads the public `context` for the two `objectForKeyedSubscript` checks (SW:1591-1592; a crash on Rust unless moved to `supports`), and throws only `BaroChartError`. **(checked)**
57. **Map §6.1 BUSY gate**: exactly `compactData` and 7 of the 9 ingestion ops (not stats, not save), also while a pending registration is still registered and only until an async job commits (SW:1618-1620, **checked**); `applyDataEvents(_:skipUnchanged:true)` and exploration call their globals directly and bypass `command()` and the gate.
58. **Map §6.1 admission**: async-data jobs use neither `BaroChartNativeAdmission` nor `NativeJobBudget`; Swift rejects a second async job with `busy`, Java supersedes it (JV:937).
59. **Map §6.1 "Internal JSC coupling"** is incomplete: the params record, `BaroChartAsyncJob.source`, the workspace runtime `ownedContext`, the delivery context and the async `Prepared.context` all hold contexts (§3.8.1); the exploration facade bypasses `call()` (SW:1814-1838: capture lease, `objectForKeyedSubscript`, `toDictionary`, identity check).
60. **Map §6.2 `close()`**: before `free`, Android runs params and workspace `closeOnOwner()` (Status/Abort and `nativeWorkspaceSourceAbort`) and `activeJob.stopOnOwner('closed')` (`nativeAsyncRelease`), then close observers; `BaroChartView.onClose` sets `engineClosed` first, so no `nativeReleaseFrameCache` is issued (JV:806-812, **checked**). `check()` (JV:64) resumes pending owner cleanup before the requested call.
61. **Map §6.2 JNI**: `create` uses a 32-byte allocation header on shipped ABIs (limit 805306368 on requested + header bytes, set after runtime creation; counters only after full success); `call` checks the argument size (268435456 UTF-16 units, then UTF-8 bytes) before parsing and the argument count after parsing, maps unknown names to `'TypeError: not a function'`, and limits results to 268435456 UTF-8 bytes; `indicatorSlice` checks `offset+count ≤ 4194304` before any JS call, converts with `getBytes("UTF-8")` (512 limit, `?` for lone surrogates) and truncates at U+0000 (`JS_NewString`).
62. **Map §6.4**: `read_slice`/`write_slice` also carry the params protocol (target "ticket" = registration; the source write is the armed one-shot write); the `supports(Capability)` sketch should be the per-name `bc_supports` (§3.6.1).
63. **Map §6.5 lone surrogates** "replaced with `?` on Android": only for Java → JS arguments; results keep them (JSON escapes `\udXXX`, decoded back by org.json); error texts go through `new String(bytes, "UTF-8")` and become U+FFFD (OpenJDK; Android libcore not verified). Add: Android-only limits (16 arguments, 256 MiB argument/result text), the QuickJS 768 MiB cap hitting before `maxBars` on JSON data, JSC crashing on deep Swift arguments, and the deep-JSON class difference.
64. **Map §7 risks 11-12** are superseded (tier A in scope; no host fallback). **Appendix C** "+3,000 if ported" underestimates: see §7 here (about +10,000 net new lines).

### 6.6 Design document and plans

65. **Design §4.4** branches right after `enter()`: the backend-neutral JNI checks must run before the branch (§3.9.3); `enter()` must skip `JS_UpdateStackTop` for Rust handles; the time-zone upcall does not need `AttachCurrentThread` for calls that enter through JNI (`enter()` stores the caller's `JNIEnv`), only for threads Rust spawns itself.
66. **Design §4.7** "QuickJS throws a catchable exception at the 768 MB limit … Rust throws the same `RangeError`": QuickJS throws `InternalError: out of memory` at 805306368 accounted bytes (requested + 32-byte headers); JSC throws `RangeError: Out of memory` (§3.9.2).
67. **Design §4.2** "typed arrays never ride in JSON" conflicts with Android `invoke('nativeIndicatorBuffer', …)` (O6).
68. **Design §5.2 and §8.1 M6** "preflight `requiredBackend`": recommended replacement by the `UnavailableError` contract (O2).
69. **Design §5.3** lists `nativeSetData`/`nativeDataEvent` as not ported; this document implements all legacy helpers (§2.2) and confirms the not-ported list as self-tests, demos and test-only lifecycle (§2.6).
70. **Design §4.3/§11** (`call`/`command` unavailable on Rust) conflicts with §5.4 (existing tests unmodified) and `docs/IOS-GUIDE.md:180` (O1).
71. **Design §7.4-3 and §10 D2** mention restored engines only; include the params publish (M0 Task 3 already does).
72. **Design §7.4-1**: workspace and studies series, panels, axes, theme and dataset are already written in canonical order; the real document nondeterminism is in drawings (record, style, anchors), indicator params, symbol and the restored view; `inspect()`, the preflight `dataset` and scene layout are return-value nondeterminism.
73. **M0 plan Task 1** series and panel orders (`['id','type','panel','indicator','color','width','offset']`, `['id','weight','scale','inverted','padding']`) would change standard documents (e.g. the demo panel's `label`, a `source` series); use the `*_KEYS` orders, as the branch implementation does.
74. **M1 plan :263**: the interim miss text is M1-only; the final table separates defined-but-not-ported names (`UnavailableError`) from undefined names (platform texts, §2.7).

---

## 7. Rust size estimate and top risks

### 7.1 Size

| Area | Reader estimate | Net new on top of map Appendix C | Note |
|---|---|---|---|
| Async data jobs (capture, target, UI transfer, `finishUI`, publish) | 2,400 | 2,400 | builds on the stable store, indicator, drawing and ingestion modules |
| Indicator-params jobs | 2,400 | 2,200 | assumes M0 Task 3 (no adoption registry); +450 without it |
| Ingestion queue, envelope, unchanged batch, release, budget injection | 1,200 | 850 | about 350 overlap Appendix C "Ingestion 1,100" |
| Exploration (`dataAt`, explorer) | 700 | 700 | |
| Tier-A ops delta and `pressure` | 2,500 | 1,000 | compaction core, group edits, panels/axes and study setup are already in Appendix C rows |
| Public surface: 15 legacy helpers, 2 benchmark helpers, theme as a `Value` map, typed-array JSON, function table and stubs, `nativeIndicatorBuffer` path | 1,000 + 1,500 + 140 | 1,050 | the public-surface estimate overlaps the FFI glue already counted |
| Custom-indicator rejection | 170 | 170 | |
| Lifetime, POISONED, cleanup whitelist, params ledger | 650 | 650 | |
| Resource limits (`MemoryAccount`, `try_reserve` sites, depth checks, iterative `Drop`) | 650 | 650 | |
| M0 key-order canonicalization (also applies to the stable surface) | 350 | 350 | |
| **Total net new** | | **≈ 10,000** | stable + tier A ≈ 37,850 Rust lines |

Not Rust: `aster_jni.c` restructuring (pre-checks before the branch, `createRust`, shared counters, TRANSPORT/NOT_FOUND mapping, optional depth scan; about 300 C lines); Swift/Java host changes (two classifier rows each, `close()` moved to `supports`, the O1 value facade or the test ports, the Java `scope`/`memorySampling` texts). Tests are not included. Map Appendix C's "+3,000 if ported" for the async, params and exploration protocols was an underestimate: those three alone are about 5,300.

### 7.2 Top risks (ranked)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Staleness parity: params fingerprint, workspace `sourceRefs`, async configuration key and revisions, UI header comparison, owner check with `nativeSize` identity | A job succeeds on one backend and fails on the other, or a touch, resize, render or indicator read stales a job differently | Generation counters on every covered object, bumped exactly where JS replaces an object (equal values included) and never for crosshair, snap, magnet or frame caches; replay the measured staleness matrices (§3.1.3, §3.2.3, §3.4.3) |
| 2 | Cleanup under POISONED and after close | iOS admission slots leak (every later workspace/params job `busy`), `close()` throws and the engine stays open, Android jobs stay pending | The cleanup whitelist and params ledger (§3.8.4), busy-guard release outside `catch_unwind`, a never-failing `bc_engine_free`, panic-injection acceptance tests |
| 3 | Host-visible numbers that come from JS-internal layouts: `plan.totalBytes`/`logicalAdmissionBytes`, `retainedBytes`, progress totals, chunk metrics, checkpoint text sizes behind budgets | Admission decisions, metrics and budget failures diverge | Mirror the JS buffer layouts and the codec texts (§1.2 rule 3, §3.1.4, §3.2.4); compare plans byte for byte |
| 4 | Oracle drift during M0 (directory mutated; Task 1 and 2 committed on a branch; Task 3 pending) | Goldens measured on the wrong bundle; line numbers off | Pin goldens to bundle hashes and commits (this document uses `11b467b`); re-measure the Task 1 and Task 3 classes after PR A (§3.10.3) |
| 5 | Engine-resource behaviour: deep JSON (QuickJS stack overflow vs iterative V8/JSC), the QuickJS 768 MiB accounted cap, Rust abort on allocation failure | Different error classes; a Rust abort kills the host app | O5 normalization; `MemoryAccount` with `try_reserve`; class-only comparison for resource errors (§3.9) |
| 6 | Swift `JSValue` APIs and internal `context` use | `close()` crashes on Rust; documented `command()` and XCTests break | Move every internal `context` use behind the runtime seam in M0; decide O1 (value facade recommended) |
| 7 | JNI branch placement and text encoding | Missing pre-check messages, a different first error, U+0000 truncation and lone-surrogate handling differ | Pre-checks before the branch, TRANSPORT/NOT_FOUND statuses, WTF-8 through the shared `fail()` (§3.9.3) |
| 8 | Long check chains with many messages (`finishUI`, `AsyncUIImport`, params import, async metadata) and dropped X guards | A different first message for multi-fault inputs | Keep the order of every reachable validator; drop only guards that no host or JSON input can reach; keep their messages in the table |
| 9 | Lazy calculation commits on reads (`dataAt`, `nativeIndicatorBuffer`, `indicatorValues`, `crosshairSnapshot`, the explorer) | Different staleness of active jobs and different error timing | Commit at exactly the JS points, including when the later slice check fails (§3.6.4) |
| 10 | Ingestion corner cases: closed attached session, policy injection into typed batches, −0 sequences, counter and `lastError` key-order permutations, saturation | Byte-different app-persisted documents and receipts | f64 sequences, key-order permutations, the `p1`-`p20` corpus, `save(load(t)) === t` |
| 11 | `nativeTheme` raw values through the theme | A typed theme cannot hold them; scene, packet, workspace and frame-cache behaviour diverge | Theme as an ordered `Value` map (O3) or an owner-approved deviation |
| 12 | Platform divergences inside unchanged hosts (Java supersedes vs Swift busy, step sizes, `'stale'` substring classification, admission progress phase names) | Spurious parity failures or missed real ones | Pin them per platform in the differential driver; never "fix" them in Rust |
