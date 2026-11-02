# BaroChart Rust core porting map (stable surface)

> **Scope update (2026-11-02).** The owner decided that the Rust backend reaches full parity with every low-level API except custom JS indicators. The advanced surface, the definitive scope lists and the corrections to this map are in [`2026-11-02-rust-core-porting-map-tier-a.md`](2026-11-02-rust-core-porting-map-tier-a.md) (§2 scope, §6 corrections). Where the two disagree, the tier-A document wins.

- Date: 2026-11-02
- Source snapshot: `/Users/jinhongan/BaroChart-review-20261023` (not a git checkout, so there is no commit id).
- Oracle: `native/Resources/aster-core.js`, 588,614 UTF-16 units / 588,726 UTF-8 bytes. Readers confirmed it is byte-identical to a fresh `buildNativeBundle()` (`scripts/native-core-bundle.mjs`). So every `src/core/*` line reference below is valid for the shipped native core.
- Inputs: fourteen reader reports: bridge contract, platform consumers, data store, indicators, model/layout, scene, interaction, drawings, API, workspace/markets, restore pipeline, native checkpoints, study setup, ingestion. This document merges them and removes duplicates. Where two reports disagreed, the source was re-read and the fix is marked **(checked)**.
- Design reviews: the GLM, DeepSeek and Qwen answers from the earlier design consultation were checked claim by claim against this snapshot. Appendix D lists what they agree on, what was corrected, and what changed in this map because of them.
- Audience: engineers writing a selectable Rust backend that must pass differential tests against the JS core.

> **Exactness target.** On the stable surface (typed API + shipped views + drawings/workspace persistence) the Rust backend must:
> 1. return the same values, including JSON byte order wherever a host or a document can see it;
> 2. throw the same `(name, message[, code])`;
> 3. leave state unchanged on exactly the same failures;
> 4. produce byte-identical documents (`aster.drawings`, `aster.workspace`, `aster.studies`, `aster.ingestion`).

## Contents

- [0. Conventions](#0-conventions)
- [1. Scope summary](#1-scope-summary)
  - [1.1 Execution model the backend must reproduce](#11-execution-model-the-backend-must-reproduce)
  - [1.2 Bridge functions the backend must provide (tiers S, V, R)](#12-bridge-functions-the-backend-must-provide-tiers-s-v-r)
  - [1.3 `nativeCommand` operations](#13-nativecommand-operations)
  - [1.4 What stays JS-only (tiers J/T), and why](#14-what-stays-js-only-tiers-jt-and-why)
  - [1.5 Decisions to make before freezing oracles](#15-decisions-to-make-before-freezing-oracles)
- [2. Module dependency graph and port order](#2-module-dependency-graph-and-port-order)
  - [2.1 Dependency graph (arrows point from user to dependency)](#21-dependency-graph-arrows-point-from-user-to-dependency)
  - [2.2 Port order (leaves first) with differential-test checkpoints](#22-port-order-leaves-first-with-differential-test-checkpoints)
  - [2.3 Harness notes](#23-harness-notes)
- [3. Per-module specifications](#3-per-module-specifications)
  - [3.1 JS-compatibility foundation (Rust-only layer)](#31-js-compatibility-foundation-rust-only-layer)
  - [3.2 `contracts.mjs` (shared validators, limits, colors, fonts)](#32-contractsmjs-shared-validators-limits-colors-fonts)
  - [3.3 Checkpoint codec (`checkpoint-validation.mjs:1-60`)](#33-checkpoint-codec-checkpoint-validationmjs1-60)
  - [3.4 Data store (`data.mjs`, `block-index.mjs`, `data-batch-options.mjs`, `store-owners.mjs`)](#34-data-store-datamjs-block-indexmjs-data-batch-optionsmjs-store-ownersmjs)
  - [3.5 Markets and time (`markets.mjs`)](#35-markets-and-time-marketsmjs)
  - [3.6 Ingestion (`ingestion.mjs`, `ingestion-error.mjs`)](#36-ingestion-ingestionmjs-ingestion-errormjs)
  - [3.7 Indicators (`indicators.mjs`, `indicator-params.mjs`, `indicator-modules.mjs`, `trusted-studies.mjs`, `session-studies.mjs`)](#37-indicators-indicatorsmjs-indicator-paramsmjs-indicator-modulesmjs-trusted-studiesmjs-session-studiesmjs)
  - [3.8 Native checkpoint containers (`native-checkpoints.mjs`) and checkpoint-state validation](#38-native-checkpoint-containers-native-checkpointsmjs-and-checkpoint-state-validation)
  - [3.9 Model and layout (`model.mjs`)](#39-model-and-layout-modelmjs)
  - [3.10 Drawings (`drawings.mjs`, `drawing-validation.mjs`, `position-drawing.mjs`, `drawing-style-patch.mjs`, `drawing-translation.mjs`)](#310-drawings-drawingsmjs-drawing-validationmjs-position-drawingmjs-drawing-style-patchmjs-drawing-translationmjs)
  - [3.11 Scene (`scene.mjs`, `scene-parts.mjs`, `labels.mjs`, `frame-cache.mjs`, `crosshair-snap.mjs`, `ohlc-snap.mjs`) and the F64 packet (`native-command-packet.mjs`)](#311-scene-scenemjs-scene-partsmjs-labelsmjs-frame-cachemjs-crosshair-snapmjs-ohlc-snapmjs-and-the-f64-packet-native-command-packetmjs)
  - [3.12 Interaction (`interaction.mjs`)](#312-interaction-interactionmjs)
  - [3.13 ChartAPI facade (`api.mjs`) with `study-setup.mjs`](#313-chartapi-facade-apimjs-with-study-setupmjs)
  - [3.14 Workspace document (`workspace.mjs`) and preflight (`native-workspace.mjs`)](#314-workspace-document-workspacemjs-and-preflight-native-workspacemjs)
  - [3.15 Typed `restoreWorkspace` pipeline (`native-workspace-source.mjs`, `native-workspace-target.mjs`, `prepare-state.mjs` PreparedData, B:24-47, B:49-60)](#315-typed-restoreworkspace-pipeline-native-workspace-sourcemjs-native-workspace-targetmjs-prepare-statemjs-prepareddata-b24-47-b49-60)
  - [3.16 Bridge layer details (B, T, E)](#316-bridge-layer-details-b-t-e)
- [4. Error catalog](#4-error-catalog)
  - [4.0 Error model and host classification](#40-error-model-and-host-classification)
  - [4.1 Bridge and transport (B, T, E, N, P, S)](#41-bridge-and-transport-b-t-e-n-p-s)
  - [4.2 Shared validators (`contracts.mjs`) and the checkpoint codec](#42-shared-validators-contractsmjs-and-the-checkpoint-codec)
  - [4.3 Data store and markets](#43-data-store-and-markets)
  - [4.4 Ingestion (all `IngestionError`; the code is part of the contract)](#44-ingestion-all-ingestionerror-the-code-is-part-of-the-contract)
  - [4.5 Indicators, parameters, modules, session studies](#45-indicators-parameters-modules-session-studies)
  - [4.6 Native checkpoint containers and checkpoint-state validation](#46-native-checkpoint-containers-and-checkpoint-state-validation)
  - [4.7 Model and layout (`model.mjs`)](#47-model-and-layout-modelmjs)
  - [4.8 Drawings](#48-drawings)
  - [4.9 Scene, snap, interaction](#49-scene-snap-interaction)
  - [4.10 ChartAPI facade, study setup, compaction](#410-chartapi-facade-study-setup-compaction)
  - [4.11 Workspace and preflight](#411-workspace-and-preflight)
  - [4.12 Restore pipeline (source, target, prepare)](#412-restore-pipeline-source-target-prepare)
  - [4.13 Engine-specific errors (compare name/class only; D8)](#413-engine-specific-errors-compare-nameclass-only-d8)
- [5. Numeric and formatting rules that need JS-compatible implementations](#5-numeric-and-formatting-rules-that-need-js-compatible-implementations)
- [6. Platform seam notes](#6-platform-seam-notes)
  - [6.1 iOS today (JavaScriptCore)](#61-ios-today-javascriptcore)
  - [6.2 Android today (QuickJS through JNI)](#62-android-today-quickjs-through-jni)
  - [6.3 Logic that stays in Swift/Java regardless of backend](#63-logic-that-stays-in-swiftjava-regardless-of-backend)
  - [6.4 Where a backend switch fits (proposal)](#64-where-a-backend-switch-fits-proposal)
  - [6.5 Platform divergences to pin in differential tests](#65-platform-divergences-to-pin-in-differential-tests)
- [7. Risks (ranked)](#7-risks-ranked)
- [Appendix A. Evidence and reusable probes](#appendix-a-evidence-and-reusable-probes)
- [Appendix B. Golden values (measured on the shipped bundle)](#appendix-b-golden-values-measured-on-the-shipped-bundle)
- [Appendix C. Rust size estimate (stable surface)](#appendix-c-rust-size-estimate-stable-surface)
- [Appendix D. Use of the GLM, DeepSeek and Qwen design reviews](#appendix-d-use-of-the-glm-deepseek-and-qwen-design-reviews)

---

## 0. Conventions

**Path shorthands.** B = `examples/native/bridge.mjs`, P = `examples/native/params-bridge.mjs`, E = `examples/native/exploration-bridge.mjs`, T = `examples/native/batch-bridge.mjs`, N = `src/renderers/native-command-packet.mjs`, K = `src/renderers/keyboard-explorer.mjs`, S = `scripts/native-core-bundle.mjs`. A bare core file such as `data.mjs:45` means `src/core/data.mjs:45`. The sources are dense, near-minified JS, so one physical line often holds a whole function. Line numbers point at that line.

**Error classes.**
- `TypeError`, `RangeError`, `Error`, `SyntaxError` are JS built-ins.
- `StaleSourceError` is a plain `Error` whose `name` was set to `'StaleSourceError'`. It is not a subclass.
- `IngestionError` has `name:'IngestionError'` and a string `code` (`ingestion-error.mjs:1-3`).
- `UnsupportedIndicatorError` (`code:'UNSUPPORTED_INDICATOR_MODULE'`), `IndicatorBusyError` and `StaleCheckpointError` are `Error`s with `name` set.
- Hosts receive `String(error)` = `name + ': ' + message` (JSC `exception.toString()`, QuickJS `JS_ToCString`) and classify it by prefix (§4.0).

**Tiers** used throughout:

| Tag | Meaning | Rust obligation |
|---|---|---|
| **S** | Stable typed API or persistence (Swift `BaroChartEngine+Typed.swift` plus the typed-throwing basics in `BaroChartEngine.swift`; Java typed methods in `BaroChartEngine.java`) | Must match exactly |
| **V** | Used by the shipped views (`BaroChartUIView`, `BaroChartFrameRenderer`, `BaroChartView`) | Must match for view parity |
| **R** | Used only by the typed `restoreWorkspace` job protocol | Must match if the host job classes stay (Option A, §6.4) |
| **A** | Advanced or low-level, but reachable through public escape hatches (Swift `call()`/`command()`, Java `invoke()`/`command()`, `BaroChartView.fire()`) | Implement, or reject with one defined error (decision D1) |
| **J** | Stays JS-only (needs a JS engine, or is web-only) | Not ported |
| **T** | Test, demo or benchmark only | Not ported |
| **X** | Unreachable from JSON or typed inputs (JS object-model guards, reentrancy guards) | May be dropped; keep the message if it can ever surface |

**Evidence.** "Measured" means a reader ran the shipped bundle in `node:vm` (V8), or built a JavaScriptCore or vendored QuickJS 2026-06-04 probe. "Static" means source reading only. Probe scripts are listed in Appendix A.

---

## 1. Scope summary

### 1.1 Execution model the backend must reproduce

The native core is one sloppy-mode IIFE (S:6-24). It first sets `globalThis.Aster` (127 core names), then defines about 100 `native*` globals (B, P, E, T). Hosts call only those globals: iOS through `JSValue.call(withArguments:)`, Android through JNI `call(handle, name, argsJSON)`, which JSON-stringifies the result.

Per-runtime state (B:1-3, B:193, P:3-4, T:2, E:2):

- **Engine quadruple.**
  - `nativeModel`: `ChartModel`.
  - `nativeAPI`: `new ChartAPI(model,{controller:nativeInput})`. Its `invalidate` is a no-op.
  - `nativeInput`: `new InteractionController(model, ()=>globalThis.nativeSize??{width:1200,height:700})`.
  - `nativeSize`: `{width,height}`. It is replaced by a new object on every set.
  - Invariants: `api.model===model`, `api.controller===input`, `input.model===model`. Guards check these by identity. Rust may replace the identities with an engine generation counter but must keep the messages.
- **Latest layout.** `nativeLatestLayout` / `nativeLatestLayoutModel` hold the last rendered layout and the model it came from. Accessibility reuses them (§3.16.4).
- **Frame caches.** `nativeFrameCaches: Map<token, SceneCache>`, at most 64 entries (B:193-194).
- **Job state machines.** Async data, workspace restore and indicator params share one ticket counter (`nativeAsyncTicket`, starts at 0) and use strictly increasing registrations (§3.15, §3.16.6).

Calls are serialized on one owner thread. The core never runs concurrently.

**Notification contract.** Under the bridge the core's `invalidate` does nothing. Swift and Java bump their own revision and notify observers based on the operation name and the returned receipt (§6.3). So the Rust contract consists of three things:

1. Return values: shape, JS type and key order. Android turns them into JSON; iOS turns them into dictionaries.
2. Thrown `(name, message[, code])`.
3. "No state change" on every failure that is atomic in JS.

### 1.2 Bridge functions the backend must provide (tiers S, V, R)

| Function | Arguments → return | Tier | Behaviour (details in §3.16) | Host callers |
|---|---|---|---|---|
| `nativeInit(count=100000, options=null)` | → `count` (number, unchanged) | S | Builds a new engine, then disposes the old one. Default demo layout when `options===null`. | Swift `init(bundleURL:count:options:)` passes `[count, options ?? NSNull]`. Typed `init(options:)` passes count 0 with `{panels:[{id,weight,label?}],series:[…],theme?}`. Java constructor and typed `create` (count 0). |
| `nativeCommand(op, args=[])` | → `nativeAPI.dispatch(op,args) ?? null` | S/V/A | 65 operations (§1.3). | Swift `command()`, Java `command()` |
| `nativeSave()` | → string, an `aster.drawings` document | S | `nativeModel.drawings.save()` directly, without `apiActive`. Empty store gives `{"schema":"aster.drawings","version":1,"drawings":[]}`. | Swift/Java `saveDrawings()` |
| `nativeSaveWorkspace(binding)` | → string, an `aster.workspace` document | S | Owner check before and after (B:85). No notification. | `saveWorkspace(binding:)` |
| `nativeReleaseFrameCache(token)` | → `true` | S/V | Clears and deletes that cache (token not validated); resets latest layout. | Swift FrameRenderer release, Java packet-failure recovery |
| `nativeReleaseFrameCaches()` | → `true` | S | Clears all caches; resets latest layout. | Swift `close()` |
| `nativeReleaseDataIngestion()` | → `{cancelled, pendingEvents:0, ownedBytes:0}` | S | `cancelled = session?.count ?? 0`; `session?.dispose()`. Does not detach `model.dataIngestion`. | Swift `close()` (only if defined) |
| `nativeSceneJSON(w,h)` | → JSON string of Scene | V | Sets `nativeSize` first, builds the full scene, records the latest layout. | Swift `scene()`, Java `scene()`, FrameRenderer fallback |
| `nativeRenderFrameJSON(token,w,h,force=false)` | → JSON string of Frame | V | Per-token layered cache (§3.11.7). | Swift FrameRenderer, Java legacy cache path |
| `nativeScenePacket(mode,token,w,h,force=false)` | → `{metadata:string, numbers:Float64Array}` | V | F64 display packet (§3.11.8). | Android JNI `packet()`. Android falls back to JSON on failure. |
| `nativeResize(w,h)` | → `undefined` | V | `nativeSize={width,height}`. No validation. | iOS before every pointer/key call and in layout; Android `onSizeChanged` |
| `nativePointer(kind,id,x,y,hitTolerance=8)` | → `undefined` | V | `kind ∉ {down,move,up,cancel}` → `TypeError 'Pointer operation'`. Any later throw runs `nativeInput.cancel()` and then rethrows. | iOS touches (tolerance 22), Android touch/hover (24 finger / 8 other) |
| `nativeKey(key,ctrl,shift)` | → `undefined` | V | `nativeInput.key(key,{ctrl,shift})`. | iOS key commands and accessibility; Android keys and accessibility |
| `nativeHoverExit()` | → `true` | V | `nativeModel.crosshair=null`. | iOS cancel, Android hover exit |
| `nativeGestureKind()` | → `'pan'`, `'pinch'`, `'wait'`, `'create'`, `'edit'` or `null` | V | `nativeInput.gesture?.kind ?? null`. | Android `ACTION_DOWN` ownership decision |
| `nativeThemeFont()` | → string | V | `nativeModel.theme.font`. | Dynamic Type / fontScale |
| `nativeAccessibility(useLastFrame=false)` | → `{bars,close,selection,tool,panels,crosshair,readout}` | V | §3.16.4 | used by the next function |
| `nativeAccessibilityText(useLastFrame=true, platform='android')` | → string | V | `platform ∉ {'android','uikit'}` → `TypeError 'Accessibility text platform'`. | iOS `[true,'uikit']`, Android `[true,'android']` after every draw |
| `nativeWorkspaceSourceBegin(document,binding,revision,maxBytes=805306368,registration)` | → `{ticket, phase:'admission', registration?}` | R | Source capture (§3.15.1). | Swift `BaroChartWorkspaceJob.start`, Java `beginSource` |
| `nativeWorkspaceSourceStep(ticket,maxRecords,revision)` | → progress or the copy descriptor | R | Hosts pass `maxRecords` 8. | Swift `admit`, Java admission loop |
| `nativeWorkspaceSourceCheck(ticket,revision)` | → `true` | R | Staleness check; drops the session on failure. | before every source call (Swift), Java `checkSource` |
| `nativeWorkspaceSourceFinish(ticket,revision)` | → `{schema:'aster.native-workspace-source-finished',version:1,revision,sourceVersion,sourceBytes,checkpointBytes,drawingBytes,ticket}` | R | Always drops the session in `finally`. | Swift `install`, Java `finishSource` |
| `nativeWorkspaceSourceAbort(registration)` | → boolean | R | Correlation key, not an authority token. | Swift registry cleanup, Java `releaseSource` |
| `nativeWorkspaceTargetCreate(metadataJSON)` | → `true` | R | Must run in an isolated, empty runtime (no `nativeInit`). | fresh JSContext / QuickJS handle |
| `nativeWorkspaceTargetFinish()` | → `{schema:'aster.native-workspace-target-ready',version:1,status:'target-ready',hostPublished:false,plan}` | R | Installs the four engine globals in the target. | Swift/Java `finishTarget` |
| `nativeAsyncBuffer(ticket,slot,offset,count)` | → Float64Array of exactly `count` elements | R | Workspace branch: sequential slices of at most 262144. | Swift copy, Java JNI `readBuffer` |
| `nativeAsyncTargetBuffer(slot,offset,count)` | → writable Float64Array view | R | Target columns 0..5. | Swift copy, Java JNI `writeBuffer` |
| `nativeAsyncStart()` | → `true` | R | Target must have every column fully received. | both |
| `nativeAsyncStep(maxBars)` | → JSON **string** `{"phase":…,"done":…,"total":…,"complete":…}` | R | Phases in §3.15.2. | both |

Not used by the workspace path, despite the name: `nativeAsyncRelease` (async data jobs only; Swift `BaroChartEngine.swift:275,644`, Java `:1131`) **(checked)**. `nativeWheel` appears only in an iOS name comparison and is never called.

### 1.3 `nativeCommand` operations

#### 1.3.1 Dispatch contract (`api.mjs:72-77`)

1. `apiActive(this)` runs first, so a disposed engine reports `Error 'Chart disposed'` even for an unknown op.
2. If `op` is not in the 65-name `COMMANDS` set (`api.mjs:65`), or `args` is not an Array → `TypeError 'Unknown chart command or argument list'`.
3. If `args.length > arity[op]` → `TypeError 'Chart command argument count'`. Too few arguments are allowed: missing ones are `undefined`, so JS default parameters apply. `null` does not trigger a default (decoder must keep Absent / Null / Value apart, §3.1.4).
4. The result is `this[op](...args) ?? null`: `undefined` and `null` become `null`, while `false`, `0` and `''` stay as they are.

Arity table (verbatim from `api.mjs:75`, checked): `compactData 1, setData 1, setColumns 2, applyDataEvent 1, applyDataEvents 1, configureDataIngestion 1, enqueueDataEvents 1, drainDataEvents 1, pauseDataIngestion 0, resumeDataIngestion 0, cancelDataEvents 0, dataIngestionStats 0, saveDataIngestion 0, loadDataIngestion 1, addPanel 1, setPanel 2, setPanelOrder 1, removePanel 1, addAxis 1, setAxis 2, removeAxis 1, setDrawingTarget 1, setDrawingMagnet 1, setCrosshairSnap 1, crosshairSnapshot 2, crosshairValues 2, dataAt 2, addSeries 1, setSeries 2, setSeriesValues 2, removeSeries 1, addIndicator 3, setIndicatorParams 2, setIndicatorPlacement 2, removeIndicator 1, indicatorValues 2, indicatorValueAt 4, registerIndicatorModule 2, saveStudies 0, loadStudies 1, addDrawing 1, positionMetrics 1, editDrawing 2, translateDrawings 2, setDrawingsStyle 2, setDrawingVisibility 2, setDrawingsVisibility 2, duplicateDrawing 2, duplicateDrawings 2, deleteDrawings 1, deleteDrawing 1, selectDrawing 1, saveDrawings 0, loadDrawings 1, undo 0, redo 0, setTool 1, setText 1, setTheme 1, setSymbol 1, setVisibleRange 2, fit 0, zoom 2, pan 1, inspect 0`.

`registerIndicatorSource` and `registerIndicator` are intentionally not dispatchable.

#### 1.3.2 Operations used by the typed API and views (tiers S/V)

Typed method → op mapping comes from `BaroChartEngine+Typed.swift`, `BaroChartEngine.swift:1861-1977` and `BaroChartEngine.java:599-799, 1280-1400`. `removeIndicator`, `selectDrawing`, `undo`, `redo`, `fit`, `saveDrawings` and `loadDrawings` are typed-throwing on both platforms **(checked**: one reader claimed iOS lacks `removeIndicator`; it exists at `BaroChartEngine.swift:1869`).

| Op (args) | Return | Tier | Typed caller | Spec |
|---|---|---|---|---|
| `setData(bars)` | `null` | S | `setBars` | §3.13.2 |
| `applyDataEvent(event)` | `null`; for `{kind:'batch',events}` a frozen receipt `{events,appended,from,to,version,length,capacity,bytes}` (typed hosts discard it) | S | `apply(event)` | §3.13.2, §3.6 |
| `addSeries(options)` | series id (string) | S | `addSeries` | §3.13.4, §3.9.3 |
| `setSeries(id, patch)` | `null` | S | `updateSeries` | §3.13.4 |
| `removeSeries(id)` | `null` (missing id is a no-op) | S | `removeSeries` | §3.13.4 |
| `addIndicator(id, name, params={})` | `{outputs:[…], plotOffsets:{…}}` with outputs in `Object.keys` order | S | `addIndicator(_:id:)` | §3.13.5 |
| `setIndicatorParams(id, params)` | `{outputs:[...def.outputs], plotOffsets:{...def.plotOffsets}}` | S | `setIndicatorParams(id:_:)` | §3.13.6 |
| `removeIndicator(id)` | `null` | S | `removeIndicator` | §3.13.5 |
| `indicatorValueAt(id, output\|null, index, options={})` | `{value:number\|null, sourceIndex:int\|null, sourceTime:number\|null}` | S | `indicatorValue` | §3.13.5 |
| `setTool(tool)` | `null` | S/V | `setTool` (typed enum, UIView, BaroChartView) | §3.12.6 |
| `addDrawing(options)` | drawing id (string) | S | `addDrawing` (hosts reject `.select` first) | §3.13.7 |
| `editDrawing(id, patch)` | `null` | S | `updateDrawing` | §3.13.7 |
| `deleteDrawings(ids)` | `{changed:int, invalidationFailed:boolean}` | S | `deleteDrawings(ids:)` reads `changed` | §3.10.6 |
| `selectDrawing(id\|null)` | `null` | S | `selectDrawing` | §3.13.7 |
| `undo()`, `redo()` | `null` (even when nothing changed) | S | `undo`, `redo` | §3.12.5 |
| `fit()` | `null` | S | `fit` | §3.9.4 |
| `setTheme(patch)` | `null` | S/V | `setTheme`; views use `setTheme({font})` for Dynamic Type / fontScale | §3.13.8 |
| `setSymbol(symbol)` | `null` | S | `setSymbol` | §3.13.8 |
| `inspect()` | snapshot object (§3.13.9) | S | `visibleRange()` reads `view.from/to` | §3.13.9 |
| `setVisibleRange(from, to)` | `null` | S | `setVisibleRange` | §3.9.4 |
| `crosshairValues(w, h)` | `{index,time,primary:{symbolId,bar},series:[…],axes:[…]}` or `null` | S | `crosshair(width:height:)` | §3.11.5 |
| `loadDrawings(text)` | `null` | S | `loadDrawings` | §3.10.5 |
| `zoom(factor, anchor?)` | `null` | V | accessibility zoom in/out (0.8 / 1.25, anchor omitted) | §3.9.4 |
| `setCrosshairSnap(options)` | `null` | V | `BaroChartUIView/BaroChartView.setCrosshairSnap` | §3.11.6 |
| `setDrawingMagnet(options)` | `null` | V | `…setDrawingMagnet` | §3.12.6 |

#### 1.3.3 Advanced operations (tier A)

These are reachable through the public low-level `command()`. Hosts route the 9 ingestion ops through `nativeDataIngestionCommand` (§3.16.5), not `nativeCommand`.

| Op (args) | Return | Spec |
|---|---|---|
| `compactData({keepLastBars, studyHistory:'restart', maxPeakStoreBytes?, pendingData?})` | receipt `{removed,length,capacity,bytes,previousBytes,peakSourceBytes,firstRetainedTime,version,timeVersion,studyHistory:'restart',invalidationFailed}` (not frozen) | §3.4.10 |
| `setColumns(data, length?)` | `null` | §3.13.2 |
| `applyDataEvents(events)` | frozen batch receipt | §3.13.2 |
| `configureDataIngestion(o)`, `enqueueDataEvents(p)`, `drainDataEvents(max?)`, `pauseDataIngestion()`, `resumeDataIngestion()`, `cancelDataEvents()`, `dataIngestionStats()`, `saveDataIngestion()`, `loadDataIngestion(text)` | stats / receipts / string | §3.6 |
| `addPanel(o)` → id, `setPanel(id,patch)`, `setPanelOrder(ids)` → boolean, `removePanel(id)` | | §3.9.3 |
| `addAxis(o)` → id, `setAxis(id,patch)`, `removeAxis(id)` | | §3.9.3 |
| `setDrawingTarget(target\|null)` | `null` | §3.12.6 |
| `crosshairSnapshot(w,h)` | snapshot or `null` | §3.11.6 |
| `dataAt(query, options={})` | DataSnapshot or `null` | **gap**: `data-explorer.mjs` was not specified by any reader |
| `setSeriesValues(id, values)` | `null` | §3.9.3, §3.13.4 |
| `setIndicatorPlacement(id,{panel,axisId?})` | `{changed}` | §3.9.3 |
| `indicatorValues(id, output?)` | `(number\|null)[]` | §3.13.5 |
| `registerIndicatorModule(id, version)` | `string[]` | §3.7.9 |
| `saveStudies()` → string, `loadStudies(text)` → `{indicators, series}` | | §3.13.6 |
| `positionMetrics(id)` | PositionMetrics | §3.10.7 |
| `translateDrawings`, `setDrawingsStyle`, `setDrawingVisibility`, `setDrawingsVisibility`, `duplicateDrawing`, `duplicateDrawings` | `{changed, invalidationFailed}`; duplicate also returns frozen `created:[{sourceId,id}]` | §3.10.6 |
| `deleteDrawing(id = selected)` | boolean | §3.13.7 |
| `saveDrawings()` | string | §3.10.4 |
| `setText(text)` | `null` | §3.13.7 |
| `pan(delta)` | `null` | §3.9.4 |

Other tier-A bridge globals:
- `nativeDataIngestionCommand` (envelope, §3.16.5)
- `nativeApplyUnchangedDataEvents` (§3.16.7)
- `nativeDataExploration` (§3.16.8)
- `nativePreflightWorkspace` (§3.14.4)
- `nativeIndicatorBuffer` (Android package-private)
- the async data protocol: `nativeAsyncBegin`, `nativePrepareBegin`, `nativeDataAsyncBegin`, `nativeAsyncCheck`, `nativeAsyncCheckpoint`, `nativeAsyncUIBegin/UINext/UICheck`, `nativeAsyncRelease`, `nativeAsyncCreate`, `nativePrepareCreate`, `nativeAsyncCheckpointImport`, `nativeAsyncUIImportBegin/Chunk/End`, `nativeAsyncFinish`
- the indicator-params protocol (17 functions in P).

### 1.4 What stays JS-only (tiers J/T), and why

| Item | Reason |
|---|---|
| `nativeRegisterIndicatorSource`, `ChartAPI.registerIndicatorSource`, `ChartAPI.registerIndicator`, `IndicatorEngine.register` | Evaluate host JS source (`Function('"use strict"; return ('+source+');')()`, `api.mjs:247-251`) or take JS function factories. A Rust backend should reject these with a defined "unsupported in this backend" error, or the host should pin such engines to the JS backend. The second option exists only if both backends ship in the binary (D12). |
| `defineIndicatorModule`, build-time `modulePaths` bundles (S:17-19), `validateModuleCheckpoint` | Trusted JS modules with JS checkpoint validators. |
| `aster.volume-direction@1/pressure` (`trusted-studies.mjs`) | A linked JS module that is present in every engine registry. It is small and could be ported bit-exactly under the same descriptor (decision D10). Otherwise reject with `UnsupportedIndicatorError`. |
| `globalThis.Aster` namespace; Swift `public var context: JSContext`; Swift `call()`/`command()`/`addIndicator`/`setIndicatorParams` returning `JSValue`; `BaroChartView.fire()` | Raw JS-engine access. Needs a backend-neutral `Value` return type (§6.4). |
| Async data jobs (`applyDataEventAsync`, `prepareColumnsAsync`, `prepareSeededAsync`) and their bridge functions (`async-state.mjs`, `prepare-state.mjs` capture side, `async-ui.mjs`) | Experimental two-runtime protocols, documented as unverified on Apple. They can be reimplemented natively later. Only the functions shared with workspace restore are in scope (tier R). |
| Indicator-params async (`setIndicatorParamsAsync`, `native-params-*.mjs`, 17 P globals) | Experimental, entry-only. Installs budgeted checkpoint maps (§3.8.6). |
| `nativeDataExploration`, `KeyboardDataExplorer`, `data-explorer.mjs` (`dataAt`) | Experimental and low-level; not specified by readers in full. |
| `nativeApplyUnchangedDataEvents`, `nativeDataIngestionCommand` queue API | Low-level, opt-in. Configuring a session does affect the stable surface (§3.6.7), so decide D1 consistently. |
| `nativePreflightWorkspace` as a public receipt | Low-level. Its checks are still needed inside restore admission. |
| `nativeIndicatorBuffer`, Java `runtimeMetrics`, `sceneTiming`, `indicatorBytes` | Diagnostics, package-private, or QuickJS allocator statistics. |
| Legacy helpers `nativeSetData`, `nativeDataEvent`, `nativeIndicator`, `nativeView`, `nativeFit`, `nativeAddPanel`, `nativeSetPanel`, `nativeAddSeries`, `nativeRemoveSeries`, `nativeTheme`, `nativeInspect`, `nativeTool`, `nativeWheel`, `nativeLoad`, `nativeEcho` | Bypass `ChartAPI` validation. Not called by the typed or view code. |
| Test-only lifecycle: `nativeAsyncUI`, `nativeWorkspaceSourceBuffer`, `nativeWorkspaceSourceDispose`, `nativeWorkspaceTargetDispose`, `nativeParamsTargetDispose` | Hosts never call them. |
| Demos and self-tests: `nativeSelfTest`, `nativeExtendedSelfTest`, `nativeHardeningSelfTest`, `nativePublicationOrderSelfTest`, `nativeStudyVerification`, `nativeAxesSelfTest`, `nativeAnalysisDemo`, `nativeAnalysisReload`, `nativeComparisonDemo/Readout/Action`, `nativeBenchmarkEvent/Digest` | Tier T. Their goldens are still useful oracles (Appendix B). |
| Web-only modules: `bound-drawings.mjs`, `internal-indicator-bindings.mjs`, `retireInteractionController`, `releaseCrosshair`, `cancel({ownedDrawingsOnly:true})` as a caller option, `explorerInputAllowed`, `DrawingStylePresets` (bundled into `Aster` but no host calls it) | Not in the native bundle, or never reached from the native path. |
| Panel/axis `formatter` functions; custom `priceFormatter`/`timeFormatter` | JS callbacks. Only the formatters that `setSymbol` installs are portable (`contracts.mjs:17-19`). |
| JS object-model defenses: own-data descriptor checks, accessor rejection, Proxy/getter reentrancy, `StaleSourceError` reentrancy guards, WeakMap brands | Tier X. Rust ownership makes them unreachable. Keep the message table only. |

### 1.5 Decisions to make before freezing oracles

| # | Decision | Default recommendation |
|---|---|---|
| D1 | What Rust does for tier-A ops and globals | Implement the commonly used ones (axes, panels, group drawing edits, `deleteDrawing`, `setText`, `pan`, `saveDrawings`, `setDrawingTarget`, `crosshairSnapshot`). Reject the rest with one documented error so the host maps it to a code. |
| D2 | Restored engines keep the 32 MiB `NativeCheckpointMap` budget. Identical data and studies then succeed on a fresh chart and fail after restore (§3.8.5). | Fix in JS first (convert to ordinary maps at publish), then freeze oracles. If not fixed, Rust must replicate provenance tracking. |
| D3 | `fit()` with `L+F<10` sets `follow=false`, so a short-history reset chart stops following appends (§3.9.4) | Replicate for parity; file a bug. |
| D4 | `layout.geometryKey` embeds a process-global `BarStore` serial (`data.mjs:99`) | Normalize it in differential tests. Do not try to share the counter. |
| D5 | `Math.log`, `Math.exp`, `Math.hypot`, `Math.sin` differ by engine (V8 vs JSC vs QuickJS/libm) | Call what the platform's JS engine calls, and use the same-platform JS engine as the oracle. On Android that is libm for all four (`quickjs.c:46816-46833, 47182-47185`, checked). On iOS it is libm for `log`/`exp` and `hypot` as well: JSC on macOS 26.7.2 matched C `hypot` bit for bit on 200,000 inputs, including all 64,337 inputs where libm and the Kahan form differ (measured 2026-11-02, see the design spec §6.3). Confirm on an iPhone in M4. In the `node:vm` harness, inject V8's primitives. Use a 1-ulp tolerance only where neither is possible (§5). Do not pin a portable libm crate or an fdlibm port on device, as the GLM and Qwen reviews suggest: that breaks bit parity with the JS backend on the same device (Appendix D). |
| D6 | Time-zone source | Use a host callback `zonedParts(ms, tz)` so each platform keeps its current tzdb and formatting (§3.5.2). Do not bundle chrono-tz unless the platform differences in §6.5 are acceptable. The GLM and Qwen reviews agree; DeepSeek's chrono-tz proposal is rejected for this reason. The design synthesis's narrower variant (a host offset callback, with Rust computing proleptic-Gregorian parts) is acceptable only after the JS side pins the supported year range. Otherwise the §6.5 divergences (year padding below 1000, invalid dates) would differ from one platform's JS backend. iOS needs a new Swift callback in either shape, because JSC uses its built-in `Intl` today. |
| D7 | Lone UTF-16 surrogates in strings | Use WTF-16/WTF-8 strings in the value model. Rust `String` and `serde_json` defaults cannot represent them. |
| D8 | Engine-specific messages (JSON `SyntaxError` text, `ReferenceError`, property reads on `undefined`) | Compare the class/name only. |
| D9 | Known quirks: `'Tool select..'` double period, `nativeAsyncFinish` without rollback, `nativeReleaseDataIngestion` that does not detach, `deleteDrawing` during create, external-values `RangeError 'Range index bounds'` on render, iOS memory-warning budget never restored | Replicate unless D-listed for fixing. Each is described where it occurs. |
| D10 | Port the linked `pressure` module? | Small and deterministic. Porting avoids `UnsupportedIndicatorError` on restored documents that use it. |
| D11 | Non-finite numbers across the FFI | iOS passes NaN/±Infinity into the core; Android rejects them in `org.json` first. The Rust value model must represent non-finite doubles (not `serde_json::Value`). |
| D12 | Backend selection and fallback. The GLM review ships both backends and chooses at runtime. The DeepSeek and Qwen reviews exclude one at build time, so a shipped artifact carries one backend. All three keep JS as the default during 1.x. | Choose the backend per engine at creation and never change it afterwards. Same-process dual backends are needed for shadow comparison and per-app rollback, so decide the artifact split after measuring size (§2.2 track S2). Never fall back silently to JS on a Rust error (Qwen): it hides parity bugs. Under build-time exclusion, the §1.4 option "pin the engine to the JS backend" does not exist, so JS-only features must raise the D1 error. |


---

## 2. Module dependency graph and port order

### 2.1 Dependency graph (arrows point from user to dependency)

```
L0  js-compat foundation (Rust only)
      numbers (Number::toString, toFixed, toPrecision, toExponential, Math.* JS semantics)
      UTF-16 strings (length, slice, trim, \s, \d, \w, toLowerCase)
      ordered JSON value + JSON.stringify/parse clones, error triple (name, message, code)
        ^
L1  contracts.mjs ----------------------------> L0
    checkpoint-validation.mjs: codec part (safeCheckpointStringify/Parse)
        ^
L2  data.mjs (BarStore, RangeIndex) <- block-index.mjs, data-batch-options.mjs, store-owners.mjs
    markets.mjs (zonedParts -> host tz callback, zonedEpoch, validateSymbol, formatPrice, applyDataEvent, SessionCalendar)
    ingestion-error.mjs <- ingestion.mjs (snapshotIngestionEvents, lease/fence, save/restore)
        ^
L3  indicator-params.mjs <- indicators.mjs (35 builtins, engine) <- session-studies.mjs (vwap, pivots)
    indicator-modules.mjs, trusted-studies.mjs (linked JS module: J/D10)
    checkpoint-validation.mjs: validateCheckpointState <- native-checkpoints.mjs
        ^
L4  position-drawing.mjs <- drawing-validation.mjs <- drawings.mjs (store, history, geometry, hit test)
        ^
L5  model.mjs (ChartModel, view state machine, createLayout, axisRange)
        ^
L6  labels.mjs <- scene-parts.mjs, crosshair-snap.mjs, ohlc-snap.mjs <- scene.mjs <- frame-cache.mjs
    native-command-packet.mjs (renderer transport)
        ^
L7  interaction.mjs (pointer/key state machine)
        ^
L8  api.mjs (ChartAPI) + study-setup.mjs, compaction.mjs, drawing-translation.mjs, drawing-style-patch.mjs
    [data-explorer.mjs: tier A gap]
        ^
L9  workspace.mjs -> native-workspace.mjs (preflight)
    native-workspace-source.mjs, prepare-state.mjs (PreparedData) <- native-workspace-target.mjs
        ^
L10 bridge globals (B, T, E, P) + keyboard-explorer + host seam (§6)
```

Cycles to be aware of:
- `model.mjs` constructs `IndicatorEngine` and `DrawingStore`.
- `drawings.mjs` geometry consumes the `Layout` that `model.mjs` produces.
- `scene` calls back into `model.seriesData`, which runs lazy indicator calculation.

In Rust, break these with traits or by passing `&Model` to layout and geometry functions. A JS layout is a set of live closures that read `model.view` and `model.store` when called (§3.9.6, item 9), so pass the model at call time rather than snapshotting it. Because of these cycles, the port order in §2.2 gates model/layout (step 5) before drawing geometry (step 6), although the graph lists drawings one layer lower. The drawing store types can be ported or stubbed before step 5.

### 2.2 Port order (leaves first) with differential-test checkpoints

Each step ends with a gate: Rust output must equal the JS oracle (the shipped bundle in `node:vm` for V8; the same bundle under JSC/QuickJS for platform-specific math). Compare "bitwise" with `Object.is` semantics: any NaN equals any NaN, and `+0` differs from `-0`. Compare JSON byte for byte unless stated otherwise.

| Step | Port | Differential checkpoint (pass criteria) |
|---|---|---|
| 0 | L0 js-compat | 10^6 random and edge doubles: `Number::toString`, `toFixed(0..18)`, `toPrecision(1..21)`, `toExponential(0..20)` including exact ties; `Math.round/min/max/sign` on ±0, NaN and ties. JSON.stringify escaping and key order. JSON.parse with duplicate keys, `__proto__`, `1e400`, lone-surrogate escapes. UTF-16 `length`/`slice`/`trim` over the full whitespace table (§5). |
| 1 | contracts, checkpoint codec | `portableColor`/`portableFont` fuzz (named colors, `#rgb(a)`, `rgb()/rgba()` with % and fractions, Kelvin sign, U+FEFF/U+0085 trimming). `optionRecord` key order and messages. `safeCheckpointStringify/Parse` round trip of `-0`/NaN/±Infinity markers, depth 32/33, 250000 nodes, duplicate keys, `1e400`, `-`, `1.2.3`. |
| 2 | Data store | `seededColumns(n,42)` golden vectors. RangeIndex sums bit-exact (readers matched 7887/7887 cases with the dyadic query order; a naive left-to-right sum differed in 1954). Batch receipts and change records (`from, kind, version, …extra`). Error precedence corpus (options → shape → budgets → order → overflow). `test/data-batch.test.mjs`, `test/append-atomicity.test.mjs`. |
| 3 | Markets/time, ingestion | `zonedEpoch` vectors (New York DST: 2026-03-09 09:30 → 1773063000000; 2026-03-08 02:30 nonexistent; 2026-11-01 01:30 earlier 1793511000000 / later 1793514600000). `formatPrice` toFixed ties. `snapshotIngestionEvents` error corpus (41 cases, probe1). `restoreDataIngestion`/`save` corpus (35 cases, probe2) with byte-identical re-save. |
| 4 | Indicators, session studies, checkpoint containers | All 35 builtins on ordinary, flat, zero-volume, negative, signed-zero, subnormal, 1e300 and MAX_VALUE corpora (readers matched 2,933 vectors), including the same `TypeError 'Output must be finite or NaN'` throw points. Checkpoint JSON text at every 256 block. Metadata (`revision, computedFrom, computedUntil, dirty, dirtyTo, invalidated, length`). Incremental-versus-fresh equality after 60 random edit steps. |
| 5 | Model/layout | `createLayout` on 3000 random models: readers' spec-only reimplementation matched in 2137 cases and failed identically in 863. View state machine: 24000 random steps, `view` and `follow` compared with `Object.is`. Error-class/message corpus (~100 cases). |
| 6 | Drawings | `aster.drawings` save/load byte-identical; undo/redo stack lengths under the identity rules; geometry command JSON (key order) for all 16 tools; hit-test results on grid sweeps (avoid exact-tolerance boundaries, D5). |
| 7 | Scene + packet | `nativeSceneJSON` byte-identical after normalizing `layout.geometryKey` (D4). `nativeRenderFrameJSON` base/drawings null-protocol sequences across mutation scripts (`scratchpad/scene/t9.mjs`). Packet `metadata` bytes and `numbers` bits. |
| 8 | Interaction | Pointer/key scripts: invalidation kind sequences (§3.12.7), view, drawing documents, crosshair snapshots, error-then-cancel behaviour. |
| 9 | ChartAPI + study setup + compaction | `nativeCommand` corpus across all S/V ops (and A ops per D1): return JSON, error triple, state after failure. `test/api.test.mjs`, `test/hardening.test.mjs`, `test/atomic-indicator-params.test.mjs`, `test/set-series-presentation.test.mjs`. |
| 10 | Workspace + restore | `saveWorkspace` byte-identical to `test/fixtures/legacy/aster-workspace-v1.json`. `save(restore(text)) === text` for every saved text. Admission/target progress JSON sequences. Every restore error string and its phase. Post-publish state (§3.15.4). |
| 11 | Bridge + host seam | Swift `Tests/BaroChartTests/*` and Android instrumentation suites run against both backends. Accessibility text bytes. Frame-cache token semantics. JNI packet acceptance. |

**Parallel de-risking track.** This comes from the GLM and Qwen reviews. It runs alongside steps 0–2 and does not change the gates above.
- **S1, FFI walking skeleton.** `create`/`call`/`free` carry `nativeInit`, `nativeCommand('inspect')` and the `ScriptError` envelope through both hosts. Pass criteria: for one error of each class, the host classification in §4.0 gives the same typed error code as the JS backend, and the closed-engine and wrong-thread tables stay green (Qwen's step 1).
- **S2, packaging and size.** Push a hello-world Rust core through the SwiftPM binary target / xcframework build and the AAR/CMake build. Measure bytes per ABI against the 3 MB budget. The reviews' estimates for the Rust core vary: GLM 1.5–2.5 MB, Qwen 1.2–2 MB, DeepSeek under 1 MB. The measurement feeds D12.
- **S3, replay shim.** A WASM or native CLI build exposing `call(name, argsJSON) -> resultJSON`, the same entry point as §6.4. It replays the traces described in §2.3 (all three reviews).

### 2.3 Harness notes

- Load `native/Resources/aster-core.js` into a `node:vm` context. Build option objects **inside** the context with `JSON.parse`; objects from the outer realm fail `optionRecord` with `'…: plain object required'`.
- Call the same global names on the Rust side through a shim that exposes `call(name, argsJSON) -> resultJSON` (§6.4). Compare result JSON bytes plus the error string `name: message`.
- Use host-like inputs: for iOS, JSC dictionary conversion (key order not deterministic, NaN allowed); for Android, JSON text (insertion order, no NaN). Test both decoders.
- Seed corpora: the reader probes in Appendix A and the repo tests listed per step.
- The repo's Node suite cannot run against Rust as it is. A static grep of this snapshot finds 177 of 319 `test/*.test.mjs` files importing `src/core/*.mjs` directly, and 67 files that touch the bundle or bridge globals (23 do both). Harvest op traces from the bridge-level tests and from `artifacts/aster-native --self-test | --api-test | --async-test` (`examples/native/main.swift:7`), as the Qwen review suggests. The GLM review's "run all Node tests on WASM" and the DeepSeek review's "the tests are command scripts" do not hold for this snapshot.
- `examples/native/parity.swift:26` registers a custom JS indicator. Split that runner into a core part (both backends) and an advanced part (JS backend only), as the Qwen review suggests.
- Apply tolerances only in the comparator, never in emitted output. Quantizing emitted geometry, as the Qwen review proposes, would break byte parity with JS.
- Reusable tools in the repo:
  - `benchmarks/compare-histogram-scenes.mjs` (scene diff pattern);
  - `scripts/measure-native-device.mjs`;
  - Android `PerformanceTest.java` and `SoakTest.java`;
  - iOS `SoakTests.swift` and `EngineMemoryTests.swift`.

---

## 3. Per-module specifications

### 3.1 JS-compatibility foundation (Rust-only layer)

Every module depends on these semantics. Implement them once, test them exhaustively (step 0), and never call Rust `f64` formatting or `f64::min`/`max` directly in ported code.

#### 3.1.1 Numbers
- **`Number::toString`** (used by `JSON.stringify`, template strings, `String(n)`, `${max}` in error messages): shortest round-trip digits. Exponential form iff `|x| >= 1e21` or `|x| < 1e-6`, written as `1e+21`, `1.5e-7`, `5e-324`. Integers have no decimal point (`123456789012345680000`). `-0` → `"0"`, `NaN` → `"NaN"`, `±Infinity` → `"Infinity"`/`"-Infinity"`. Use a ryu-js style formatter. Rust `Display` differs (readers verified with rustc 1.96: `1e21` prints all digits, `1e-7` prints `0.0000001`).
- **`toFixed(f)`**: exact binary value; a tie picks the larger magnitude (`0.5→"1"`, `2.5→"3"`, `-2.5→"-3"`, `(0.125).toFixed(2)→"0.13"`, `(8.345).toFixed(2)→"8.35"`, `(1.005).toFixed(2)→"1.00"`). The sign is printed only when `x<0` (`-0→"0.00"`, `-1e-10→"-0.00"`). `|x|>=1e21` → `Number::toString`. Rust `format!("{:.2}")` rounds ties to even and prints `-0.00`.
- **`toPrecision(p)`**: exponential iff `e < -6 || e >= p`, same tie rule (`(123456789012344.5).toPrecision(15)→"123456789012345"`, `(1.25).toPrecision(2)→"1.3"`, `1.345678901234e-12→"1.34567890123400e-12"`, `1.5e21→"1.50000000000000e+21"`, `-0→"0.00000000000000"`).
- **`toExponential(f)`**: `d.ddd e±N` with the sign always present (`0→"0.00e+0"`, `123.456→"1.23e+2"`), same tie rule.
- **`Math.round`**: ties toward +∞ (`-2.5→-2`, `-0.4→-0`, `0.49999999999999994→0`). Rust `f64::round(-2.5)` is `-3`. The Qwen review's shortcut `floor(x+0.5)` is also wrong: it gives `1` for `0.49999999999999994` and `4503599627370498` for `2^52+1` (checked in Node 22). A correct shape:
  1. Return `x` for NaN, ±Infinity and ±0.
  2. Return `+0` for `0<x<0.5` and `-0` for `-0.5<=x<0`.
  3. Otherwise let `r=floor(x)`. Return `r+1` if `x-r>=0.5`, else `r`. The subtraction is exact in this range.
- **`Math.min/max`**: any NaN argument gives NaN; `-0 < +0`; `Math.max()` is `-Infinity`. Rust `f64::min/max` ignore NaN and have an unspecified zero sign.
- **`Math.sign`**: keeps `±0` and NaN. Rust `signum` returns `±1` for zeros.
- `Math.floor`, `ceil`, `abs`, `sqrt` map directly to IEEE. `Math.imul` + `>>>0` are u32 `wrapping_mul`/`wrapping_add`. `x|0`-style int32 operations appear only on values below 2^22.
- **Engine-dependent**:
  - `Math.log`, `Math.exp`: log axes (`model.mjs:317`) and wheel zoom (`interaction.mjs:127`).
  - `Math.hypot`: pinch, magnet, hit test and freehand (`drawings.mjs:46,105,120`, `interaction.mjs:40,67,93,105`).
  - `Math.sin`: demo data only (B:107).

  V8 uses a scaled, Kahan-compensated hypot. JSC does not: on macOS 26.7.2 its `Math.hypot` equals C `hypot` on 200,000 of 200,000 inputs, while V8 matched the Kahan form on all 64,337 inputs where the two differ (measured 2026-11-02; design spec §6.3). QuickJS calls libm: `Math.hypot` folds C `hypot` over its arguments (`native/android/quickjs/quickjs.c:46816-46833`), and `exp`/`log`/`sin` are the C functions (`:47182-47185`) **(checked)**. See D5.
- No FMA anywhere: evaluate every expression left-associatively, exactly as written. Rust does not contract by default; do not hand-simplify expressions.
- `Number.isFinite`, `isInteger`, `isSafeInteger` never coerce: strings, booleans and null fail. Some sites do coerce, and the exceptions are listed in §5 (zoom anchor: ToNumber; pan delta: `+` concatenation; `normalizeOHLCV`: `Number(string)`).

#### 3.1.2 Strings
- All length limits count **UTF-16 code units** (`.length`). Use `encode_utf16().count()` or store WTF-16.
- `slice(0,n)` cuts code units and may split a surrogate pair (error messages truncate keys to 64 and messages to 256 units).
- Lone surrogates are legal JS strings and arrive through JSON `\uD800` escapes. Some validators reject them (`'Checkpoint Unicode scalar'`, `'Workspace Unicode scalar'`, `'Native checkpoint Unicode'`); others accept them (the `aster.drawings` save path). See D7.
- `String.prototype.trim` and regex `\s` strip U+0009–000D, U+0020, U+00A0, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. They do **not** strip U+0085 or U+180E. Rust `str::trim` differs on U+FEFF and U+0085.
- Regex `\d` is `[0-9]` and `\w` is `[A-Za-z0-9_]` (non-unicode JS regexes). Use `(?-u)` or explicit classes in Rust.
- `toLowerCase` is full Unicode: U+212A KELVIN SIGN becomes `k`, so `'blacK'` normalizes to black (verified).
  - Rust `str::to_lowercase` gives the same result. It also applies the final-sigma rule as JS does (`"ΑΣ"` → `"ας"`, checked with rustc 1.96). Only per-`char` lowercasing is context-free, so the Qwen review's warning applies to `char::to_lowercase` alone.
  - The core lowercases in three places: `contracts.mjs:25` (colors, whose error text is constant), `interaction.mjs:131` (undo/redo keys) and `markets.mjs:10` (ASCII letters of time-zone names).

#### 3.1.3 Values and JSON
- **Object key order** = `OrdinaryOwnPropertyKeys`: canonical array-index keys (decimal `0`..`4294967294`, no leading zeros) come first in ascending numeric order, then the remaining string keys in insertion order. `'01'`, `'-1'`, `'1.5'` and `'4294967295'` are ordinary keys. `{...a}`, `JSON.stringify`, `Object.keys` and validation loops all follow this order.
- **Spread and assignment**: overwriting an existing key keeps its position; a new key is appended. A key holding `undefined` keeps its position (it matters after `setPanel` with `range:null`), but `JSON.stringify` omits it.
- **`JSON.parse`**: compact or spaced input; numbers correctly rounded; overflow becomes `±Infinity` (validators then reject it); duplicate keys keep the last value at the first position; `__proto__` becomes an ordinary own key; lone-surrogate escapes are accepted. `SyntaxError` messages are engine-specific (D8). `serde_json` defaults cannot be used.
- **`JSON.stringify`**: compact. Escapes `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`; other C0 controls become `\u00xx` (lowercase hex); lone surrogates become `\udxxx` (lowercase); everything else is raw, including `/`, DEL, U+2028/2029 and non-ASCII. `undefined` and functions are dropped from objects and become `null` in arrays. NaN/±Infinity → `null`, `-0` → `0`. Verified identical across V8, JSC and QuickJS 2026-06-04.
- Value enum needed by the core: `Undefined | Null | Bool | Number(f64, keeps -0, NaN, ±Inf) | String(WTF-16) | Array | Object(ordered map)`, plus host typed arrays (`Float64Array`) for the copy protocol.

#### 3.1.4 Argument decoding at the bridge
- Keep three states for every optional argument: **Absent** (the JS default applies), **Null** (no default) and **Value**. Examples: `zoom(f,null)` uses anchor 0; `indicatorValueAt(…,null)` throws `'Indicator query: object required'`; `addIndicator(id,name,null)` throws `'Indicator params'`; `deleteDrawing(null)` returns `false`.
- iOS (JSC, `BaroChartEngine.swift:1431`): Swift `[String:Any]` becomes JS objects in Swift `Dictionary` iteration order, which is randomized per process. `NSNull` → `null`, `Bool` → boolean, NaN/±Inf pass through, `-0.0` is preserved. A key `"__proto__"` with a primitive value is dropped silently; with a dictionary value it sets the prototype, giving `'…: plain object required'`. NSDate becomes a JS Date and fails as a non-plain object or non-finite field.
- Android (QuickJS, `aster_jni.c:57`): Java `JSONArray(args).toString()` → `JS_ParseJSON`. Insertion order is kept. `"__proto__"` becomes an own key (`'…: unsupported field __proto__'`). NaN/Inf can never reach the core: `org.json` throws `JSONException` first, which the host maps to `INVALID_ARGUMENT`. Float view coordinates arrive as `Float.toString` decimals.

#### 3.1.5 Errors
Represent errors as `ChartError { name: &'static str, message: String /*UTF-16-exact*/, code: Option<String>, cause: Option<Box<ChartError>> }`. Hosts must receive `name + ": " + message`. Classification is in §4.0.

---

### 3.2 `contracts.mjs` (shared validators, limits, colors, fonts)

**`RESOURCE_LIMITS`** (`contracts.mjs:1`, frozen): `maxBars 4194304, maxCanvasDimension 16384, maxCanvasPixels 33554432, maxDrawings 10000, maxDrawingPoints 200000, maxDocumentChars 8388608, maxHistoryBytes 33554432, maxPanels 32, maxAxes 64, maxSeries 256, maxIndicators 128`.

**Validators** (the message templates are part of the contract):

| Function | Rule | Message |
|---|---|---|
| `optionRecord(value, keys, label='Options')` (`:2-7`) | (1) falsy, non-object (including functions) or array → (2) prototype other than `Object.prototype`/`null` → (3) first key in `Object.keys` order that is `__proto__`, `constructor`, `prototype` or not in `keys`. Values are not checked; returns the same object. | `${label}: object required` / `${label}: plain object required` / `${label}: unsupported field ${key.slice(0,64)}` (all TypeError) |
| `boundedText(v, max=128, label='Text', empty=false)` (`:8`) | not a string, or `length>max`, or (`!empty` and empty) | TypeError `${label}: string limit ${max}` |
| `sizeLimit(v, max, label='Size')` (`:9`) | `!Number.isSafeInteger(v) \|\| v<0 \|\| v>max` (`-0` passes and is returned as `-0`) | RangeError `${label}: limit ${max}` (hosts classify as budget) |
| `identifier(v, label='Id')` (`:10`) | `boundedText(v,128,label)` then reserved `__proto__`, `prototype`, `constructor` | TypeError `${label}: string limit 128` / `${label}: reserved identifier` |

**Key lists.** The array order is the serialization order of workspace and study documents (`:11-14`):
- `PANEL_KEYS`: `id, weight, label, scale, inverted, padding, range, base, precision, formatter, axisVisible, axisSide`
- `AXIS_KEYS`: `id, panel, side, scale, inverted, padding, range, base, precision, tickFormat, prefix, suffix, label, visible, width, formatter`
- `SERIES_KEYS`: `id, type, panel, source, values, indicator, output, color, fill, width, baseline, offset, upColor, downColor, visible, axisId, symbolId, label`
- `THEME_KEYS`: `background, grid, text, up, down, crosshair, font`

**`portableColor(value)`** (`:22-31`). Converts to `#rrggbbaa`, lowercase, 9 chars.
1. Non-string → TypeError `Color string required`.
2. `boundedText(value,128,'Color')` → `Color: string limit 128`. This checks the untrimmed length; empty fails.
3. `c = value.trim().toLowerCase()` (JS trim and Unicode lowercase).
4. Named colors (own keys only): black `#000000`, silver `#c0c0c0`, gray `#808080`, white `#ffffff`, maroon `#800000`, red `#ff0000`, purple `#800080`, fuchsia `#ff00ff`, green `#008000`, lime `#00ff00`, olive `#808000`, yellow `#ffff00`, navy `#000080`, blue `#0000ff`, teal `#008080`, aqua `#00ffff`, transparent `#00000000`. There is no grey, orange or cyan.
5. `/^#[\da-f]{3,4}$/` → double each digit.
6. 6 digits → append `ff`; 8 digits → return as is.
7. `/^rgba?\(([^)]+)\)$/`: split on `,`, JS-trim each part, need 3 or 4 parts each matching `/^\d*\.?\d+%?$/`. `rgb = Number(x.replace('%',''))*(x.endsWith('%')?2.55:1)`; alpha uses `.01` for % or 1, default 1. Range check **before** rounding: `0<=rgb<=255` finite, `0<=alpha<=1` finite. Then `'#'+[...rgb, alpha*255].map(x=>Math.round(x).toString(16).padStart(2,'0')).join('')`. `rgb(` accepts 4 parts and `rgba(` accepts 3.
8. Otherwise RangeError `Portable color: hex, comma RGB/RGBA or basic named color required`.

Vectors: `rgb(50%,0,0)`→`#7f0000ff` (127.49999999999999); `RGBA(255,0,0,.5)`→`#ff000080`; `rgb(1,2,3,0.5)`→`#01020380`; `rgb(.5,0,0)`→`#010000ff`; `rgb(255.4,0,0)` → RangeError; `rgba(0,0,0,0.002)`→`#00000001`; `rgba(0,0,0,0.001)`→`#00000000`; U+FEFF+`red` → `#ff0000ff`; U+0085+`red` → RangeError.

**`portableFont(value)`** (`:32-35`): `boundedText(value,256,'Font')`; then `value.trim()` must match `/^((?:(?:bold|italic|normal)\s+)*)(\d+(?:\.\d+)?)px\s+([\w ."'\-,]+)$/` with size in `[4,96]`, else RangeError `Font size limit: 4..96px`. Returns the trimmed string. The match is case-sensitive (`Bold`, `12PX` fail), `\w` is ASCII (`12px 한글` fails), and the family class contains a literal space but no tab.

**`portableStyle(options, colors=['color','fill','upColor','downColor'], preserveHex=false)`** (`:36-39`): shallow copy. For each listed key that is not `undefined`: `fill:null` is kept; with `preserveHex`, a value matching `/^#[\da-f]{6}(?:[\da-f]{2})?$/i` is kept verbatim (case included); otherwise `portableColor`. Then `font` → `portableFont`.

**Formatter portability** (`:17-19`): `rememberSymbolFormatters(model)` records `{symbol, price, time}` in a WeakMap. `hasPortableFormatters(model)` is true when the model has no formatters, or when the record matches `symbol`, `priceFormatter` and `timeFormatter` by identity. Rust: keep a flag "formatters were installed by `setSymbol` for the current symbol object".

---

### 3.3 Checkpoint codec (`checkpoint-validation.mjs:1-60`)

This is the wire format for every persisted or cross-runtime JSON text: workspace, studies, ingestion, restore metadata and native checkpoints.

**Constants:** text ≤ 8388608 UTF-16 units; walk depth ≤ 32; nodes ≤ 250000 (`:6`).

**Number markers** (`:7`): an object whose only own key is `$asterNumber`, with value `'NaN'`, `'Infinity'`, `'-Infinity'` or `'-0'`. It may appear anywhere, including the root.

**`safeCheckpointStringify(state)`** (`:37-42`):
1. Walk without decoding (`:8-32`):
   - depth/nodes over limit → RangeError `Checkpoint state limit`;
   - lone surrogate in a value or key → TypeError `Checkpoint Unicode scalar`;
   - `undefined`, function, symbol, bigint → TypeError `Checkpoint unsupported value`;
   - cycle → `Checkpoint cyclic state`;
   - a non-array with a prototype other than `Object.prototype`/`null` → `Checkpoint object type` (arrays pass with any prototype);
   - array keys not exactly `0..n-1` → `Checkpoint array shape`;
   - accessor → `Checkpoint accessor state`.
   Only `Object.keys` are walked, so symbol keys and non-enumerables are silently left out.
2. `JSON.stringify(state, replacer)`: every number that is non-finite or `-0` (including the root) becomes `{$asterNumber: Object.is(v,-0)?'-0':String(v)}`.
3. Output length > 8388608 → RangeError `Checkpoint text limit`.

Output example: `{"a":{"$asterNumber":"-0"},"b":{"$asterNumber":"NaN"},"e":[1e+21,1e-7,0.1,123456789012345680000,5e-324,1.7976931348623157e+308]}`.

**`safeCheckpointParse(text)`** (`:43-60`). The order is fixed:
1. Not a string, or length > 8388608 → RangeError `Checkpoint text limit`.
2. **Raw pre-scan**, one left-to-right pass:
   - Strings are skipped with backslash awareness. After a string, whitespace matching JS `\s` is skipped; if the next char is `:`, the string is decoded as a key with `JSON.parse(slice)` (which can throw an engine `SyntaxError`). A key repeated in the same object frame → TypeError `Checkpoint duplicate state key`. A string *value* that happens to be followed by `:` is also treated as a key.
   - `{` and `[` increase depth; depth > 32 → RangeError `Checkpoint depth limit`. `}` and `]` pop without checking that brackets match.
   - A token starting with `-` or a digit extends over `[0-9eE+.-]*`. If `Number(token)` is not finite → TypeError `Checkpoint untagged nonfinite number`. This covers `1e400`, `-`, `[-]`, `1.2.3` and `1e`. `01` passes the scan and fails in `JSON.parse`. A leading `+` is not a token start.
3. `JSON.parse(text)` → engine `SyntaxError` on grammar errors.
4. **Decode walk** in `Object.keys` order: depth > 32 first, then nodes > 250000 → RangeError `Checkpoint state limit`; lone surrogate → TypeError `Checkpoint Unicode scalar`. An object with own `$asterNumber` must have exactly that one key with one of the four strings, else TypeError `Checkpoint number marker`. The marker is replaced in its parent by the number. Raw non-finite numbers → `Checkpoint untagged nonfinite number`.

Notes: `1e-400` is accepted as `0`. A raw `-0` token is accepted and yields `-0`. Underflow and correct rounding match Rust's `str::parse::<f64>`.

`validateCheckpointState` (`:62-171`) is specified in §3.8.4.

---

### 3.4 Data store (`data.mjs`, `block-index.mjs`, `data-batch-options.mjs`, `store-owners.mjs`)

#### 3.4.1 State
- `FIELDS = ['time','open','high','low','close','volume']` (`data.mjs:10`) is the column order, the row key order and the validation order.
- `BarStore` fields:
  - `geometryIdentity = ++storeSerial`. A module-global counter, incremented after option validation even if the constructor's `setData` later fails.
  - `maxBars`: safe int 0..4194304.
  - `timeframeMs`: finite, > 0, default 60000. `timeOrigin`: finite, default 0.
  - `onListenerError`; `listeners` (Set); private internal listeners; `listenerErrors` (≤32); `pendingChanges`; `notifying`.
  - `version`, `timeVersion`: both 1 after the constructor's `setData`, 2/2 after `nativeInit`.
  - `length`; `capacity` (a power of two, ≥16, ≥ length); `columns{time..volume: Float64Array(capacity)}`; `index`: a RangeIndex with `size==capacity`, a sum tree, `finiteCounts=false`.
- Invariants:
  - time is strictly increasing, a safe integer, and `|t| <= 8640000000000000`;
  - all values are finite, `volume >= 0` (`-0` allowed and preserved);
  - `low <= min(open,close)`, `high >= max(open,close)`, `low <= high`;
  - slots `[length, capacity)` are `+0`;
  - the root volume sum `index.sum[1]` is finite;
  - every tree node is a pure function of (leaves, size);
  - `bytes = 96*capacity` (6×8 for the columns + 3×2×8 for the tree).

#### 3.4.2 `validateBar(b, previous=-Infinity)` (`data.mjs:43-48`)
1. `!b` or any field failing `Number.isFinite` → TypeError `Every OHLCV field must be finite`.
2. `!Number.isSafeInteger(time) || Math.abs(time) > 8640000000000000` → RangeError `Time must be an exact UTC millisecond integer in the Date range`.
3. `time <= previous` → RangeError `Times must be strictly increasing` (`-0` then `0` fails).
4. `volume < 0 || low > Math.min(open,close) || high < Math.max(open,close) || low > high` → RangeError `Invalid OHLCV envelope`.

Negative prices and `-0` are allowed.

#### 3.4.3 Capacity policy
- `setData`/`setColumns` (and therefore prepend): start at 16 and double until ≥ count. `setData([])` shrinks to 16.
- Batch: start from the current capacity and double.
- `append` calls `reserve()` only when `length == capacity`. It copies the whole capacity into new arrays and rebuilds the RangeIndex.
- Compaction recomputes from 16, so capacity can shrink.

#### 3.4.4 RangeIndex: flat segment tree (`data.mjs:51-95`)
- **Constructor** `(length, low, high=low, volume=null, capacity=length, countFinite=false)`:
  1. `sizeLimit(capacity,4194304,'Index capacity')`, then `sizeLimit(length,capacity,'Index length')`.
  2. `countFinite` not boolean, or `countFinite && volume!==null` → TypeError `Finite-count index cannot also sum volume`. Short inputs → RangeError `Index input length`.
  3. `size` = smallest power of two ≥ capacity (minimum 1).
  4. `min` = Float64Array(2·size) filled with +∞, `max` filled with −∞, `sum` filled with 0 (or `null`).
  5. Leaves at `size+i` for `i < length`: `min = isFinite(low)?low:+∞`, `max = isFinite(high)?high:−∞`, `sum = finiteCounts ? Number(isFinite(low)&&isFinite(high)) : volume`.
  6. Merge `p = size-1 … 1`: `min = Math.min(child, child)`, `max = Math.max(…)`, `sum = sum[2p]+sum[2p+1]` (left + right).
  7. If `!isFinite(sum[1])` → RangeError `Volume sum overflow`.
- **`update(i, low, high=low, volume=0)`**: `i` must be an integer in `[0,size)` (note: `size`, not `length`) → RangeError `Index update bounds`. In a volume tree, a volume that is non-finite or < 0 → RangeError `Volume`. Path check: `s = volume; for (p = size+i; p > 1; p >>= 1) s += sum[p^1]`; non-finite → `Volume sum overflow` (nothing changed yet). Then write the leaf and re-merge the path.
- **`query(start,end)`**: integers with `0<=start<=end<=size`, else RangeError `Range index bounds`. Algorithm:
  ```
  a = start+size; b = end+size
  while a < b:
    if a odd: fold(a); a += 1
    if b odd: b -= 1; fold(b)
    a >>= 1; b >>= 1
  ```
  `fold` does `min = Math.min(min, node)`, `max = Math.max(…)`, `sum += sum?.[node] ?? 0`. It returns `{min, max, sum: finiteCounts ? 0 : sum}`; an empty range gives `{Infinity, -Infinity, 0}`. `_sumRange` uses the same loop and sums only.
- `finiteCount(s,e)` requires `finiteCounts && sum`, else TypeError `Finite-count index required`. `hasGaps(s,e) = finiteCount(s,e) !== e-s`.
- **Bit-exactness**: the summation order (left+right merges, dyadic query decomposition) decides aggregate volumes and overflow decisions. The decomposition is independent of tree size. Readers matched 7887/7887 cases. `Math.min/max` zero-sign rules apply: `min(0,-0)=-0`, `max(0,-0)=+0`.

#### 3.4.5 BlockRangeIndex (`block-index.mjs:3-18`)
Used when a series' `values.length >= 65536` (`model.mjs:12`).
- Block size 32; `count = ceil(length/32)`; `blocks = ceil(capacity/32)`.
- Each block is scanned with strict `v<min`/`v>max` over finite values, so on equal values the first seen wins (this differs from the RangeIndex zero rule). The result feeds `tree = RangeIndex(count, blockMin, blockMax, blockFiniteCount as volume, blocks)`.
- `query(from,to)`: integers with `0<=from<=to<=size`, else RangeError `Block index bounds`. Empty → `{Inf,-Inf,0}`. With `first=ceil(from/32)` and `last=floor(to/32)`: if `first>=last`, scan `[from,to)`; otherwise combine `scan(from,first*32)`, `tree.query(first,last)` and `scan(last*32,to)`; `sum` is always 0.
- `finiteCount` has the same bounds error and adds left scan + `tree._sumRange` + right scan.
- `update(i)`: `0<=i<size` integer, else RangeError `Block update bounds`. Sets `length = max(length, i+1)` and rescans only block `floor(i/32)`.
- `values` is a live alias of the source buffer.

#### 3.4.6 Constructor, `setData`, `setColumns`, `prepend` (`data.mjs:99-163`)
- **Constructor**: options check (timeframeMs finite > 0, timeOrigin finite, `onListenerError` null or function) → RangeError `Virtual timeframe/origin or listener error callback`; `sizeLimit(maxBars,4194304,'Bar limit')`; serial++; then `setData(bars)`.
- **`setData(bars)`**:
  1. Not an array → TypeError `OHLCV array required`.
  2. `sizeLimit(count,maxBars,'Bar count')` → RangeError `Bar count: limit N`.
  3. Allocate.
  4. Each row: `readBar` (falsy or non-object → TypeError `OHLCV object required`; arrays pass and only FIELDS are read), then `validateBar(row, previous)`.
  5. If the length changed during the snapshot → RangeError `OHLCV array length changed during snapshot` (X).
  6. Build the RangeIndex, commit, `changed(0,'reset')`.
- **`setColumns(input, length?, event={kind:'reset'})`**:
  1. `length` defaults to the time column's length; a missing column makes it `undefined` → `Bar count: limit N`.
  2. All 6 columns must be an array or an allowed typed array (Float64/Float32/Int32/Uint32/Int16/Uint16/Int8/Uint8/Uint8Clamped/Float16) with length ≥ `length`, else TypeError `Numeric column arrays required`.
  3. Copy. An array element that is a number but non-finite → TypeError `Numeric column values required`.
  4. Row-major validation (finite → time → increasing → envelope).
  5. Index, commit, `changed(0, event.kind, {added: event.added})`. Note: the `added` key is present even when its value is `undefined`.
- **`prepend(bars)`**:
  1. Not an array → TypeError `Prepend bars required`.
  2. Empty → return with no event and no version change.
  3. `sizeLimit(n+length, maxBars, 'Bar count')`.
  4. If there is existing data and `bars[last].time >= time[0]` → RangeError `Prepend must precede existing history without overlap`. This runs before bar validation; NaN/undefined compare false. A `null` last element throws an engine TypeError (D8).
  5. Validate each bar as strictly increasing.
  6. `setColumns(merged, n+length, {kind:'prepend', added:n})`.

#### 3.4.7 Point operations (`data.mjs:181, 247-267`)
- **`append(bar)`**: `readBar` → `sizeLimit(length+1,maxBars,'Bar count')` → `validateBar(bar, lastTime ?? -Infinity)` → pre-check `!isFinite(index.sum[1] + volume)` → RangeError `Volume sum overflow` → `reserve()` → `index.update` path check → write → `length++` → `changed(i,'append')` → returns `i`. Nothing can fail after `reserve()`.
- **`update(i, bar)`**: `i` must be an integer in `[0,length)` → RangeError `Bar index` (checked before reading the bar) → `readBar` → `validateBar(bar)` (no ordering check) → `bar.time !== time[i]` → RangeError `An edit cannot change time; reload to insert/reorder` → index update → write → `changed(i,'update')`.
- **`at(i)`**: RangeError `Bar index` out of range; returns a new object in FIELDS order.
- **`lowerBound(x)`**: binary search with `m=(a+b)>>>1`, `time[m]<x ? a=m+1 : b=m`. NaN gives 0.

#### 3.4.8 Batch transaction `_applyEvents(events, options={}, beforeNotify=null)` (`data.mjs:186-246`)
1. Snapshot the source (columns, index, length, capacity, version, timeVersion, maxBars).
2. `limits = snapshotDataBatchOptions(options)` (§3.4.11). Options are checked before events.
3. `batchEvents(events)`:
   - not an array → TypeError `Data batch array required`;
   - own `length` not a safe int in 1..4096 → RangeError `Data batch event count must be 1..4096` (ASCII `..`);
   - holes or extra keys → TypeError `Data batch dense array data properties required`; accessor or non-enumerable index → TypeError `Data batch array accessor data property`;
   - each event: `batchRecord(event,['kind','bar'],'Data batch event')`, kind in `append|update|correction` (else TypeError `Data batch event kind must be append, update or correction`), `batchRecord(bar, FIELDS, 'Data batch OHLCV')`, `validateBar(bar)`.
   - `batchRecord` messages: `${label} plain data record required`, `${label} unsupported field or accessor data property`, `${label} required data property`.
4. `beforeNotify` internal check (X).
5. Stale check (X).
6. Budgets, checked before any ordering check:
   - `maxBars = batchBudget(limits.maxBars ?? store.maxBars, store.maxBars, 'bar')`;
   - `maxBytes = batchBudget(limits.maxStoreBytes ?? 402653184, 402653184, 'store byte')`;
   - then `batchBudget(newLength, maxBars, 'bar')`, grow capacity by doubling, and `batchBudget(96*capacity, maxBytes, 'store byte')`.
   - Message: RangeError `Data batch ${label} budget limit ${max}` with `code:'STORE_BUDGET'`. `max` is the store limit for invalid options, otherwise the chosen budget.
   - Budgets are checked even when `appended==0`.
7. Sequential interpretation, with `next = source.length` and `tail = last time`:
   - `append`: `validateBar(b, tail)`, then index `next++`.
   - `update`: needs `next>0 && time===tail`, else RangeError `Data batch update is only the current timestamp`.
   - `correction`: looks up times appended in this batch first, then binary-searches the original column for an exact match; else RangeError `Data batch correction requires an existing timestamp`.
   - Track `from = min index` and `to = max index + 1`.
8. Staging volume sums in operation order:
   - for an append, pre-check `isFinite(root + v)`;
   - then the path check;
   - every intermediate root must be finite, even if the batch later returns to a finite sum → `Volume sum overflow`.
9. `skipUnchanged===true && appended===0` and every final value `Object.is`-equal to the original → return a frozen receipt with `version` unchanged and `unchanged:true`. No publication happens.
10. Commit (copy into the grown buffers if capacity changed), then `receipt = Object.freeze({events, appended, from, to, version: old+1, length, capacity, bytes: 96*capacity [, unchanged:false only when skipUnchanged===true]})`, `beforeNotify?.(receipt)`, `changed(from,'batch',{appended,to})`.

After the commit, the tree equals a freshly built tree bit for bit.

#### 3.4.9 Change ledger `changed(from, kind, extra)` (`data.mjs:171-180`)
1. If `kind !== 'update' && (kind !== 'batch' || extra.appended > 0)`, then `timeVersion++`.
2. `change = {from, kind, version: ++version, ...extra}` (key order `from, kind, version`, then extra).
3. Internal listeners run immediately, including those of nested changes. External listeners are snapshot at `changed()` time and drained FIFO by the outermost call. Listener exceptions are swallowed, recorded (≤32) and passed to `onListenerError`.

Records by kind:
- reset `{from:0,kind:'reset',version}` (setColumns adds `added:undefined`);
- prepend `{…,added:n}`;
- append `{from:i,…}`;
- update `{from:i,…}`;
- batch `{from,kind,version,appended,to}`;
- compact `{from:0,kind:'compact',version,removed,studyHistory:'restart'}`.

Rust needs internal callbacks only (model, indicator engine). Hosts observe through their own revision counter.

Downstream listeners:
- `model.mjs:146`: compact is ignored. Prepend with `length > added` shifts `view.from/to` by `added`. Reset calls `fit()`. Follow mode moves the view on append, on batch with `appended>0`, and on prepend that filled an empty store. Every series gets `dirtyFrom = min(dirtyFrom ?? Inf, from)`.
- `indicators.mjs:229`: compact is ignored; `dirty`, `dirtyTo` and `invalidated` rules are in §3.7.6.

#### 3.4.10 Time mapping, aggregation, seeded data, compaction
- **`indexAtTime(t)`** (`data.mjs:270-273`):
  - `length<2`: `(t - (length ? time[0] : timeOrigin)) / timeframeMs`;
  - otherwise `i = max(1, min(length-1, lowerBound(t)))`, result `i-1 + (t - time[i-1]) / (time[i] - time[i-1])`.
  - Extrapolates linearly; NaN propagates.
- **`timeAtIndex(x)`** (`:275-278`): `length<2`: `base + x*timeframeMs`; otherwise `i = max(0, min(length-2, floor(x)))`, result `time[i] + (x-i)*(time[i+1]-time[i])`. No FMA.
  - Vectors with times `[1000,2000,4000,8000]`: `indexAtTime(500)=-0.5`, `(9000)=3.25`, `(16000)=5`, `timeAtIndex(-1)=0`, `(3.5)=10000`.
- **`aggregate(start,end,maxBuckets)`** (`:280-291`):
  1. `maxBuckets` must be an integer ≥ 1 → RangeError `Positive bucket count required`.
  2. `start = max(0, floor(start))`, `end = min(length, ceil(end))` (ToNumber coercion). NaN → RangeError `Aggregate bounds must not be NaN`.
  3. `end <= start` → `[]`.
  4. `n = min(end-start, maxBuckets)`. Bucket `b`: `a = start + floor(b*(end-start)/n)`, `z = start + floor((b+1)*(end-start)/n)`, `q = index.query(a,z)`, giving `{start:a, end:z, index:(a+z-1)/2, time:time[a], open:open[a], high:q.max, low:q.min, close:close[z-1], volume:q.sum}`.
- **`seededColumns(length, seed=42)`** (`:295-306`):
  1. `sizeLimit(length,4194304,'Synthetic bar count')`.
  2. `s = seed>>>0`, `price = 100`, `rand() = (s = (Math.imul(s,1664525)+1013904223)>>>0) / 4294967296`.
  3. Per i: `open=price; price=max(0.1, price+(rand()-0.497)*1.2); time=1700000000000+i*60000; close=price; high=max(open,price)+rand()*0.6; low=max(0.01, min(open,price)-rand()*0.6); volume=floor(100+rand()*9900)`. The rand call order is price, high, low, volume.
  4. Seed coercion: `-1→4294967295`, `42.9→42`, `NaN→0`.
  - Golden (seed 42): bar0 `{time:1700000000000, open:100, high:100.05287502724677, low:99.36004549080171, close:99.70641420974061, volume:2303}`; closes 99.56080644627363, 100.01298289317563, 100.18698402891457, 99.75883578651771; volumes 1272, 5046, 998, 8905. For n=100000: `close[99999]=323.991462901075`, `volume[99999]=8790`, total volume 505196579, capacity 131072.
  - `prepare-state.mjs:33` duplicates this generator for chunked runs.
- **`compactData(api, options, ownerGuard)`** (`compaction.mjs:38-92`), tier A.
  - **Validation order**:
    1. `apiActive`, then owner guard.
    2. Model present and not disposed (`Error 'Chart disposed'`).
    3. Options record (TypeError `Compaction options plain data compactionRecord` (sic) / `Compaction options own data properties`).
    4. `keepLastBars` safe int 1..4194304 and `studyHistory==='restart'`, else RangeError `Positive keepLastBars and studyHistory restart required`.
    5. `pendingData` ∈ {undefined, `'preserve-retained'`, `'reject'`}, else TypeError `Compaction pendingData policy`.
    6. `maxPeakStoreBytes ?? 805306368` must be a safe int 0..805306368, else RangeError `Compaction source peak byte limit`.
    7. Empty store → RangeError `Cannot compact an empty store`.
    8. If `keep >= length`, return a removed-0 receipt now, with no event and none of the checks below.
    9. Exclusive model+engine (`Error 'Compaction requires one exclusive live model and indicator engine'`); ingestion fence (`IngestionError BUSY`); drawing transaction (`Error 'Compaction during drawing transaction'`); gesture (`'Compaction during interaction gesture'`); external values (`'Compaction requires host realignment of external values'`); percent panel without base (`'Compaction percent panel requires an explicit base'`); ingestion session state (`'Compaction requires paused empty idle ingestion unless preserving retained pending data'` plus the pending revalidation messages); peak `96*(oldCap+newCap) > limit` → RangeError `Compaction source peak byte budget`.
  - **Commit**:
    - indicator entries reset to `{arrays:[], dirty:0, dirtyTo:keep, invalidated:true, length:0, computedFrom:0, computedUntil:0, preparedVersion:undefined}` with their checkpoints cleared;
    - every series gets `rangeIndex=null`, `revision=undefined`, `dirtyFrom=0`;
    - the store swaps in the retained columns, version+1, timeVersion+1;
    - with `F = max(0, ...visible offsets)`, `end = keep+F-0.5`: if follow, `view.from = end-span`; else `view.from = max(-0.5, min(end-span, from-removed))`; `view.to = from+span`;
    - `crosshair = null`; follow is unchanged;
    - an ingestion session gets `sourceVersion` = new version and `epoch+1`;
    - `changed(0,'compact',{removed, studyHistory:'restart'})`, then `api.invalidate()` (on failure `invalidationFailed = true`).
  - Drawings and undo history are untouched (they are anchored by time).
  - Receipt key order: `removed, length, capacity, bytes, previousBytes, peakSourceBytes, firstRetainedTime, version, timeVersion, studyHistory, invalidationFailed`.

#### 3.4.11 Batch options and store owners
- `snapshotDataBatchOptions(options, storeLimits=true)` (`data-batch-options.mjs:2-12`):
  - a non-plain object → TypeError `Data batch options plain data record required`;
  - allowed keys are `[maxBars, maxStoreBytes, skipUnchanged]`, or only `[skipUnchanged]` when called from the API; a disallowed key, non-enumerable or accessor → TypeError `Data batch options unsupported field or accessor data property`;
  - `skipUnchanged` not boolean (including `null`) → TypeError `Data batch skipUnchanged must be boolean`.
- Store owners (`store-owners.mjs:3-6`) exist only so compaction can prove exclusivity. In Rust, single ownership makes it implicit. Keep the error message.

---

### 3.5 Markets and time (`markets.mjs`)

#### 3.5.1 Scope
- **Tier S/V**: `zonedParts`, `marketDate`, `shiftDate`, `zonedEpoch`, `validateSymbol`, `formatPrice`, `applyDataEvent`, and `SessionCalendar` (internal, for vwap/pivots calendars).
- **J/T**: `normalizeOHLCV`, `TickAggregator`, `alignSeriesByTime` (demo only), `DEMO_SYMBOLS`, `demoCalendar`.

#### 3.5.2 `zonedParts(time, tz)` (`:7-17`) and the host time-zone bridge
1. `tz` must be a string of 1..128 units → TypeError `Timezone string, at most 128 characters required`.
2. Cache key: `tz` with only ASCII A–Z lowercased (Kelvin sign not folded).
3. Formatter: `new Intl.DateTimeFormat('en-CA', {timeZone: tz (original spelling), year:'numeric', month/day/hour/minute/second:'2-digit', hourCycle:'h23'})`.
4. Result: `formatToParts(new Date(time))` minus `literal` parts → `{year, month, day, hour, minute, second}` as strings.
5. The 32-entry LRU is updated only on success.

Platform behaviour, which Rust must reproduce per platform via a host callback (D6):
- **iOS (JSC/ICU)**:
  - invalid zone → RangeError `invalid time zone: <tz>`;
  - invalid date → RangeError `date value is not finite in DateTimeFormat formatToParts()`;
  - the year is unpadded (`'999'`) and BCE years come out positive;
  - IANA ids are case-insensitive; links and `Etc/GMT±N` work, as does `'+09:00'`; `'Z'` and `'UTC+9'` are rejected.
- **Android (QuickJS)**: `aster_jni.c:51` installs the shim `Intl={DateTimeFormat:function(locale,options){this.formatToParts=function(date){return asterZonedParts(date.getTime(),options.timeZone);};}}`, whose constructor never validates.
  - `asterZonedParts` (`aster_jni.c:42-45`): `JS_ToInt64` maps NaN/Inf to 0 → Java `zonedParts` (`BaroChartEngine.java:1220-1252`, java.time, `%04d` year, `%02d` for the rest) → any Java exception becomes RangeError `Invalid timezone/date`; a null result becomes InternalError `Timezone bridge failed`.
  - It accepts java.time-only ids (`Z`, `UTC+9`) and maps invalid dates to 1970 parts instead of throwing.
- **V8/web**: `Invalid time zone specified: <tz>`.

#### 3.5.3 Dates and DST
- `marketDate(t,tz) = `${year}-${month}-${day}`` (`:18`).
- `shiftDate(date,days) = new Date(Date.parse(date+'T12:00:00Z') + days*86400000).toISOString().slice(0,10)` (`:19`). An invalid date gives the engine's RangeError; years beyond 9999 come back truncated.
- `zonedEpoch(date, clock, tz, ambiguity='earlier')` (`:20-28`):
  1. `iso = date+'T'+(clock.length===5 ? clock+':00' : clock)`; `naive = Date.parse(iso+'Z')`. Not finite → TypeError `ISO date and HH:mm[:ss] required`.
  2. Offsets are a Set over `t ∈ {naive-86400000, naive, naive+86400000}` (in this order): `Date.parse(partsISO(t)+'Z') - t`.
  3. Candidates are `naive - offset`, kept only if `zonedParts` text equals `iso` exactly, sorted ascending.
  4. None → RangeError `Nonexistent local time at DST boundary`. More than one with `'reject'` → RangeError `Ambiguous local time`. `'later'` takes the last; every other value takes the first.
  - Port this three-sample algorithm literally. A tz library resolver differs on `24:00`, fractional seconds and multi-transition windows.
  - Engine split: JSC `Date.parse('2026-02-30T…Z')` returns NaN (TypeError path), while V8/QuickJS normalize it (RangeError nonexistent).

#### 3.5.4 Symbol, price formatting, data events
- **`validateSymbol(s)`** (`:29-32`):
  - `id, exchange, timezone, currency, volumeUnit` must be non-empty strings; `priceDecimals` an integer 0..18; `tickSize` finite > 0; `adjustment ∈ {raw, split, total-return}`. Otherwise TypeError `Invalid symbol metadata`.
  - Then `zonedParts(0, tz)`.
  - Returns `Object.freeze({...s})`, keeping extra keys. A later `saveWorkspace` rejects those keys with `'Workspace: unsupported field <k>'`.
- **`formatPrice(v, s) = v.toFixed(s.priceDecimals)`** (`:33`).
- **`applyDataEvent(store, event)`** (`:200-208`):
  - falsy event or non-string kind → TypeError `Data event kind required`;
  - `batch` → `store.applyEvents(events)`;
  - `reset` → `columns ? setColumns(columns, length) : setData(bars)`;
  - `append` → `store.append(bar)`;
  - `update` → requires a non-empty store and `bar.time === lastTime`, else RangeError `Update is only the current bar`;
  - `correction` → `lowerBound` exact match, else RangeError `Correction requires an existing timestamp`;
  - `prepend` → `store.prepend(bars)`;
  - other kinds → TypeError `Unknown data event`.
  - A missing `bar` on update (non-empty store) or correction throws an engine TypeError (D8).

#### 3.5.5 SessionCalendar (`:102-149`, internal to vwap/pivots)
- **Constructor**: `provider` must be a function and `maxCachedDays` (default 512) a positive integer, else TypeError `Calendar provider and positive cache size required`. Then `zonedParts(0,tz)`.
- **`sessions(date)`** is cached (FIFO). It maps the provider's `{open, close, kind='regular'}` windows to:
  - `open = zonedEpoch(date, open)`;
  - `close = zonedEpoch(closeClock <= openClock ? shiftDate(date,1) : date, close)`, comparing padded `HH:mm:ss` strings;
  - both with ambiguity `'earlier'`.
  - `close <= open`, or an open before the previous close → RangeError `Ordered nonoverlapping sessions required`.
  - There is no fallback for a nonexistent local midnight (Santiago 2026-09-06 `00:00` throws).
- **`at(time, kinds=['regular'])`**: the first window in `[...sessions(d-1), ...sessions(d)]` with `open <= time < close` and an allowed kind.
- **`bucket(time, interval, kinds)`**:
  - a finite `interval > 0` → `open + floor((time-open)/interval)*interval`;
  - `'day'`, `'week'` (Monday via `getUTCDay` of `date+'T12:00:00Z'`) and `'month'` (`date.slice(0,7)+'-01'`) anchor at `localDateAnchor`;
  - anything else → TypeError `Interval is milliseconds/day/week/month`.
- **`localDateAnchor(date)`**: `zonedEpoch(date,'00:00')`. Only on the exact RangeError `Nonexistent local time at DST boundary`, it scans hourly over ±48h until `marketDate` equals `date`, then binary-searches to 1 ms (`before + floor((after-before)/2)`). If nothing is found → RangeError `Calendar period starts on a nonexistent local date`. Santiago 2026-09-06 → `2026-09-06T04:00:00.000Z`.

---

### 3.6 Ingestion (`ingestion.mjs`, `ingestion-error.mjs`)

Stable-surface relevance:
1. Typed `apply(.batch)` runs `snapshotIngestionEvents` before the store transaction.
2. The typed `restoreWorkspace` source takes an ingestion lease and carries `save()` text.
3. A configured session (tier A) injects its policy budgets into typed batches.

#### 3.6.1 `IngestionError` (`ingestion-error.mjs:1-3`)
`class IngestionError extends Error { constructor(code, message, cause) }`. It sets `name='IngestionError'` as an own property, `code`, and `cause` only when it is not `undefined`. Hosts see `IngestionError: <message>`.

#### 3.6.2 `snapshotIngestionEvents(input)` (`ingestion.mjs:33-43`)
A pure validator. Every failure is `IngestionError` with code `INVALID_INPUT`, and it stops at the first one. No ordering checks happen here.
1. Not an array → `1–4096 ordered events required` (U+2013 EN DASH, bytes E2 80 93).
2. Own `length` not a safe int in 1..4096 → the same message.
3. Not dense (key count ≠ length+1, non-canonical or out-of-range index keys, symbol keys) → `Dense event array required` (X).
4. Per row, in index order:
   1. an accessor slot → `Event array data entries required` (X);
   2. `ingestionRecord(row, ['kind','bar'], 'Event')`;
   3. `kind ∉ {'append','update','correction'}` (exact, case-sensitive, including missing) → `Ordered append/update/correction required`;
   4. `ingestionRecord(row.bar, FIELDS, 'OHLCV')`;
   5. `validateBar(bar)` with `previous=-Infinity`; on throw, rethrow `IngestionError('INVALID_INPUT', cause.message, cause)`.
5. If the length changed → `Event array length changed during snapshot` (X).

`ingestionRecord(value, keys, label)` (`:23-31`):
- falsy, non-object (including functions) or array → `${label} object required`;
- non-plain prototype → `${label} plain object required`;
- any key not allowed or non-string (in `Reflect.ownKeys` order) → `${label} unsupported field`;
- an accessor → `${label} data properties required`.
It copies values in own-key order and does not require any key to be present.

Typed-enum mapping: `.reset`, `.prepend` and nested `.batch` rows always produce `Event unsupported field` (keys `bars`/`events`). Verified on V8 and JSC.

#### 3.6.3 Lease / fence (`:8-13, :114`)
- **Fence**: a per-model counter (`WeakMap<ChartModel, int>`; in Rust a `fence_count` field).
  - `assertDataIngestionIdle(model)`: counter > 0 → IngestionError `BUSY`, `Model has an active async ingestion fence`.
- **`acquireDataIngestionLease(model)`**:
  1. The session lease runs first: `active()` (CLOSED `Ingestion session closed or replaced`); `leased || draining` → BUSY `Ingestion has an active async lease or drain`; `count > 0` → PENDING_DATA `Drain or cancel pending data before async preparation`; then `leased = true; epoch++`. Paused sessions may be leased.
  2. Only if the session lease succeeded: fence++.
  3. Release is idempotent: the session release sets `leased=false; epoch++`; then, in `finally`, fence--.
  4. Models without a session can hold several fences.
- **During a lease**:
  - `save` and `stats` are allowed (`state:'busy'`);
  - enqueue/pause/resume/cancel → BUSY `Async ingestion lease active`;
  - drain → BUSY `Ingestion has an active async lease or drain`;
  - configure/load → fence error;
  - typed `apply(.batch)` is **not** blocked. It mutates the store, which makes the restore source go stale.

#### 3.6.4 Session state (`DataIngestion`, `:56-64`)
- **Policy** (frozen; key order `streamId, generation, firstSequence, maxQueuedEvents, maxQueuedBytes, maxBatchEvents, maxStoredBars, maxStoreBytes`), from `ingestionPolicy` (`:44-50`):
  - defaults via `??` (so `null` also takes the default): `firstSequence 0`, `maxQueuedEvents 4096`, `maxQueuedBytes 262144`, `maxBatchEvents 128`, `maxStoredBars store.maxBars`, `maxStoreBytes 402653184`. `generation` has no default.
  - checked in order: `streamId` identifier (TypeError rewrapped as INVALID_INPUT `Stream id: string limit 128` / `Stream id: reserved identifier`); generation and firstSequence `[0, 2^53-1]`; maxQueuedEvents `[1,4096]`; maxQueuedBytes `[49,16777216]`; maxBatchEvents `[1,4096]`; maxStoredBars `[0, store.maxBars]`; maxStoreBytes `[1536, 402653184]`. Failure message: `<key> integer range` (INVALID_INPUT).
  - Unless `allowBudgetMismatch`: `store.length > maxStoredBars || store.bytes > maxStoreBytes` → STORE_BUDGET `Current history exceeds ingestion admission budget`.
- **Ring**: `capacity = min(maxQueuedEvents, floor(maxQueuedBytes/49))`; columns are 6 `Float64Array(capacity)` plus `kinds: Uint8Array` (0 append, 1 update, 2 correction). Each event costs 49 bytes.
- **Counters** (key order): `accepted, applied, cancelled, rejectedPackets, rejectedEvents, failedDrains, peakPendingEvents, peakPendingBytes, lastAppliedSequence|null, lastCancelledSequence|null`.
- **Flags**: `paused`, `draining`, `leased`, `closed`, `lastError {code,message}|null`, `epoch`, `nextSequence`, `firstPendingSequence`, `head`, `count`, `sourceVersion`.
- `epoch` increments on enqueue success, drain commit, pause, resume, cancel, lease acquire, lease release and compaction commit. A restored session starts at epoch 0 with `sourceVersion` = the current store version.

#### 3.6.5 `save()` (`:113`)
`active()`, `sourceStatus()`, then `safeCheckpointStringify({schema:'aster.ingestion', version:1, policy, state: paused?'paused':'running', nextSequence, counters, lastError, pending:{firstSequence, events: prefix()}})`.
- `prefix()` reads ring slots `(head+i)%capacity` → `{kind, bar}` with bar keys in FIELDS order.
- `policy` and `pending` are always in canonical order. `counters` and `lastError` keep the key order of the loaded document (verified).
- Bars keep `-0` through the marker.

#### 3.6.6 `restoreDataIngestion(model, text, {allowBudgetMismatch=false})` (`:117-133`)
The order is exact:
1. `safeCheckpointParse(text)` (§3.3).
2. `ingestionRecord(doc, 8 keys, 'Ingestion document')`.
3. `schema!=='aster.ingestion' || version!==1 || state ∉ {running,paused}` → INVALID_DOCUMENT `Ingestion schema/version/state`.
4. `new DataIngestion(model, doc.policy, …)`. Policy errors or STORE_BUDGET appear here. From this point on, failures dispose the candidate.
5. Counters: `ingestionRecord(…,'Counters')`, then integer checks in counter-key order. `last*` may be `null` but must be present: `<key> integer range` (INVALID_INPUT).
6. Pending: `ingestionRecord(['firstSequence','events'],'Pending')`. `events` not an array, or longer than capacity → INVALID_DOCUMENT `Pending count`.
7. `Next sequence integer range`, `Pending sequence integer range` (INVALID_INPUT).
8. Conservation, an OR chain → INVALID_DOCUMENT `Ingestion cursor/counter conservation`:
   - `accepted ≠ applied+cancelled+n`;
   - `firstSequence+accepted ≠ nextSequence`;
   - `pending.firstSequence+n ≠ nextSequence`;
   - `peak < n`, `peak > capacity`, `peakBytes ≠ peak*49`;
   - any non-null `last*` outside `[firstSequence, nextSequence)`.
9. For each of `applied`/`lastAppliedSequence` and `cancelled`/`lastCancelledSequence`: count 0 requires a null cursor; otherwise `firstSequence+count-1 <= cursor < pending.firstSequence`. Else INVALID_DOCUMENT `Ingestion completed cursor`.
10. INVALID_DOCUMENT `Ingestion history/counter bounds` when any of these holds:
    - `completed>0` and `max(lastApplied??-1, lastCancelled??-1) ≠ pf-1`;
    - `applied>0 && cancelled>0 && lastApplied===lastCancelled`;
    - `accepted>0 && peak===0`;
    - `failedDrains>0 && accepted===0`;
    - `rejectedPackets===0 && rejectedEvents≠0`;
    - `rejectedEvents > rejectedPackets*4096`.
11. `snapshotIngestionEvents(pending.events)` when `n>0`, written into the ring.
12. Install counters (document order), `paused`, and `lastError` via `ingestionLastError`: a missing key → `Last error object required`; a code not matching `/^[A-Z_]{1,64}$/`, or a message not a string ≤256 → INVALID_DOCUMENT `Last error shape`.
13. Not paused but `lastError` set → INVALID_DOCUMENT `Running ingestion cannot retain a paused error`.
14. Owner, store or version changed → SOURCE_CHANGED `Owner changed during ingestion restoration` (X).

Integers use `Number.isSafeInteger`, which accepts `-0`. `-0` round-trips as a marker, so a Rust `i64` cannot represent forged `-0` sequence numbers. Use `f64` or a sign flag if exact re-save of forged documents matters. `rejectedPackets*4096` can exceed `u64` range, so use f64 or u128.

#### 3.6.7 Interaction with the stable surface
- In `ChartAPI.applyDataEvents` (`api.mjs:100`), a configured session injects `{maxBars: policy.maxStoredBars, maxStoreBytes: policy.maxStoreBytes}` into batches only. Single appends ignore the policy. The store can therefore grow beyond the policy, and a later typed `restoreWorkspace` then fails at source admission with STORE_BUDGET `Current history exceeds ingestion admission budget` (measured).
- Restore carries `save()` text in `metadata.dataIngestion`; the target revalidates it against a facade and re-saves it (§3.15). The restored session's `save()` equals the source text byte for byte.
- `dataIngestionBatchLimits` (`:14-20`, STORE_BUDGET `Batch exceeds configured stored-row/capacity-byte budget`) is used only by async/web paths (J).


### 3.7 Indicators (`indicators.mjs`, `indicator-params.mjs`, `indicator-modules.mjs`, `trusted-studies.mjs`, `session-studies.mjs`)

#### 3.7.1 Core invariant (verified three ways)
For all 35 builtins, the published vector equals a **cold left-to-right fold over `bars[0..n)` from the initial state**. This holds whatever sequence of append, update, correction, batch, reset or prepend produced the store. Compaction restarts history on the retained suffix, which is again a cold fold.

Evidence:
- 806 incremental vectors were bit-identical to fresh engines.
- An independent reimplementation written from this spec matched 2,933 output vectors.
- Every `TypeError 'Output must be finite or NaN'` throw lined up with the reference emitting ±Infinity.

Checkpoints and convergence change only metadata (`revision`, `computedFrom`, `computedUntil`), the checkpoint ledger and the cost. So implement each indicator as a pure Rust state machine, then add checkpointing and early exit as metadata-preserving optimizations.

#### 3.7.2 Registry, definitions, provenance
- **Registry**: `builtinIndicators: Map<name, factory>`, registered in this order: `sma, vwma, ema, wma, rsi, atr, macd, bollinger, donchian, aroon, stochastic, roc, williamsR, cci, obv, vwap, mfi, cmf, adx, dema, tema, hma, keltner, supertrend, ichimoku, trix, ppo, stochRSI, adl, chaikin, forceIndex, volumeOscillator, vortex, pivots, parabolicSAR`. Names are case-sensitive camelCase.
  - `vwap` and `pivots` come from `session-studies.mjs:80,92`.
  - Every engine registry starts as `new Map([...builtinIndicators, ...portableIndicatorFactories()])`, so the linked `aster.volume-direction@1/pressure` is always present (`indicators.mjs:228`).
- **Definitions**: `definition(outputs, initial, step, plotOffsets={})` (`:112-114`) returns `{outputs, plotOffsets, create()}`.
  - `create()` deep-clones `initial` (`cloneState`: arrays mapped, objects rebuilt from `Object.entries`).
  - It returns `{step:(b,i)=>step(s,b,i), snapshot:()=>canonicalCheckpoint(s), restore:st=>{s=cloneState(st)}}`.
  - All builtins have `plotOffsets {}` except ichimoku.
- **Provenance**: `isCanonicalBuiltinDefinition(name, def)` (`:118-126`) is true only if the def came from the original factory and still has identical own `create`, `outputs` and `plotOffsets`. It gates the pure fast path and convergence.
- **`canonicalCheckpoint`** (`:11-18`) deep-copies with two rewrites:
  1. An object with exactly 2 own keys, where `a` is an array that is empty or whose first element is an array, and `head` is an integer (an extreme queue), becomes `{a: a.slice(head), head: 0}`.
  2. An object owning `count`, `sum` and `value` with a finite `value` gets `sum = +0` in place.
- **`equalState`** (`:19`): deep equality with `Object.is` on leaves, arrays vs objects distinguished, equal key counts, key order ignored.

#### 3.7.3 Shared helpers (exact expression shapes)

- **`period(p)`** (`:20`): `!Number.isInteger(p) || p<1 || p>10000` → RangeError `Period must be 1..10000`. `20.0` and `1e4` pass; `'20'`, `1.5`, `0` and `-0` fail.
- **`roll(s,key,x,n)`** (`:21-27`): rolling mean ring `q={a:[],head:0,sum:0}`.
  - Non-finite `x` → full reset (`a=[],head=0,sum=0`) and returns NaN.
  - Filling → `a.push(x); sum += x`.
  - Full → `sum += x - a[head]; a[head]=x; head=(head+1)%n` (the difference is computed first).
  - Returns `a.length===n ? sum/n : NaN`. The result can be ±Infinity.
- **`rebaseRoll(q)`** (CCI only, `:29-34`): re-sums FIFO (oldest first) from 0 into `q.sum` and returns it.
- **`smaRoll(s,key,x,n)`** (SMA only, `:37-46`):
  1. `before = prev?.sum ?? 0`; `expired = prev full ? a[head] : 0`.
  2. `r = roll(...)`. Non-finite `x` returns `r`.
  3. `n===1`: `q.sum=x`, returns `x` (`-0` kept).
  4. `scale = Math.max(|before|, |expired|, |x|, |x-expired|)`. If `!isFinite(q.sum) || (scale>0 && |q.sum| <= ((scale*Number.EPSILON)*4)*n)`, then `q.sum` = FIFO re-sum.
  5. `mean = full ? q.sum/n : NaN`; a non-finite mean returns NaN. SMA never emits Infinity.
- **VWMA compensated window** (`:49-68`). `sums` are three `[sum, comp]` pairs: [0] numerator (close·volume), [1] volume, [2] |product|.
  - `accumulate(pair, v)`:
    - `!isFinite(pair[0])` → return (sticky).
    - `next = prev + v`; `corr = pair[1] + (|prev| >= |v| ? (prev-next)+v : (v-next)+prev)`.
    - If any of `next`, `corr`, `next+corr` is non-finite → `[NaN, 0]`.
  - `step`:
    1. `large` = totals 1 or 2 are non-finite or `>= Number.MAX_VALUE/4`. Evaluated **before** the update.
    2. `pair = [close*volume, volume]`.
    3. If the window is full: `dominant = (|old[0]|>0 && |old[0]| >= |total0|/2) || (old[1]>0 && old[1] >= total1/2)`; subtract the old contribution; adjust the `invalid` and `positive` counters; replace the slot. Otherwise push.
    4. Add the new contribution.
    5. `positive==0` → zero all sums. Otherwise rebase (re-sum the ring, oldest first) when any of these holds: `dominant`, `large`, large after update, `|comp| > Math.max(Number.MIN_VALUE*32*p, |total|*Number.EPSILON*32*p)`, **`(i+1)%p==0` with absolute bar index `i`**, any total non-finite, `total1<=0`, `total2<0`.
    6. Output NaN unless the window is full, `invalid==0`, `positive>0`, all totals are finite and `num/vol` is finite.
  - `Number.MIN_VALUE` is `f64::from_bits(1)` (5e-324), not `f64::MIN_POSITIVE`.
- **`smooth(s,key,x,n,alpha)`** (`:69-75`): `q={count:0,sum:0,value:NaN}`.
  - Non-finite `x` → reset and returns NaN.
  - `count<n`: `count++; sum+=x`, and when `count===n`, `value=sum/n`.
  - Otherwise `value += alpha*(x-value)`. Never rewrite this as `(1-α)v+αx`.
  - EMA family `alpha=2/(p+1)`; Wilder `alpha=1/p`.
- **`emaRecover(s,key,x,n,alpha)`** (EMA only, `:77-91`):
  1. `n===1` and finite `x` → `count=1; sum=0; value=(x===0?0:x)`, returns value. This normalizes `-0` to `+0`.
  2. Finite `x` with an overflowed seed (`count<n && !isFinite(sum)`) or overflowed value → reset q.
  3. `before = mature ? value : NaN`; `r = smooth(...)`.
  4. Mature, `r` non-finite and `before` finite → `rec = (1-alpha)*before + alpha*x`; if finite, `value=rec`, return it.
  5. Still overflowed → `count=1; sum=x; value=(n===1?x:NaN)`.
  - EMA never emits Infinity.
- **`trueRange(b, pc)`** (`:92`): `isFinite(pc) ? Math.max(h-l, |h-pc|, |l-pc|) : h-l`.
- **`rebaseBollinger(s)`** (`:94-101`): Welford replay oldest-first: `d=x-mean; mean+=d/c; m2+=d*(x-mean)`.
- **`extreme(s,key,x,n,i,max)`** (`:104-111`): monotonic deque `{a:[[idx,val]],head}`.
  - Pop the tail while `last <= x` (max) or `last >= x` (min), so ties, including ±0, keep the **newest** entry. Push `[i,x]`.
  - Drop the head while `idx <= i-n`. If `head>256`, slice (memory only).
  - Returns `i >= n-1 ? a[head][1] : NaN`.
- **`weighted(s,key,x,n)`** (`:181`): `m=roll(...)`; non-finite `m` → NaN; else `Σ_{j=0..n-1} a[(head+j)%n]*(j+1)` from 0, divided by `(n*(n+1))/2`.
- **`emaValue(s,key,x,n) = smooth(s,key,x,n,2/(n+1))`** (`:182`).
- **`moneyFlow(b) = h===l ? 0 : ((((2*c)-h)-l)/(h-l))*v`** (`:183`).

#### 3.7.4 Builtin catalogue (params → outputs; state; step; first finite index)

Defaults apply only to **absent** keys. Unknown keys are accepted and ignored. A string where a number is expected fails the factory check (e.g. `period:'20'` → `Period must be 1..10000`). "first@" is the first index with a finite value on ordinary data.

- **sma** `{period=20, source='close'}` → `['value']`. State `{}` then `r`. `[smaRoll(s,'r',bar[source],p)]`. `source` is any property key of the bar object; only the six FIELDS give data, anything else gives all NaN. first@ p-1.
- **vwma** `{period=20}` (close only) → `['value']`. State `{a:[],head:0,sums:[[0,0],[0,0],[0,0]],invalid:0,positive:0}`. first@ p-1 if the window has positive volume and finite products.
- **ema** `{period=20, source='close'}` → `['value']`. `[emaRecover(s,'e',bar[source],p,2/(p+1))]`, seeded by the SMA of the first p finite samples. first@ p-1.
- **wma** `{period=20}` → `['value']`. `roll` (result ignored); `a.length<p ? NaN : Σa[(head+j)%p]*(j+1) / (p*(p+1)/2)`. Not gated on a finite mean, so it can emit ±Infinity (engine then throws). first@ p-1.
- **rsi** `{period=14}` → `['value']`. State `{previous:NaN}`.
  - `d=c-prev; prev=c`; a non-finite `d` gives NaN and leaves the smoothers untouched.
  - `g=smooth('g',Math.max(0,d),p,1/p)`, `l=smooth('l',Math.max(0,-d),p,1/p)`.
  - Output `!isFinite(g)?NaN : (g===0&&l===0)?50 : l===0?100 : 100-100/(1+g/l)`. first@ p.
- **atr** `{period=14}` → `['value']`. `tr=trueRange(b,prev); prev=c; smooth('tr',tr,p,1/p)`. first@ p-1.
- **macd** `{fast=12, slow=26, signal=9}` → `['macd','signal','histogram']`.
  - Checks `period(fast), period(slow), period(signal)`, then `fast>=slow` → RangeError `MACD fast < slow`.
  - `v=smooth('f',c,fast,2/(fast+1)) - smooth('l',c,slow,2/(slow+1)); sig=smooth('s',v,signal,…)`; output `[v, sig, v-sig]`.
  - first@ macd slow-1; signal and histogram slow+signal-2.
- **bollinger** `{period=20, deviation=2}` → `['middle','upper','lower']`.
  - `!isFinite(deviation)||deviation<0` → RangeError `Deviation`.
  - State `{mean:0,m2:0,a:[],head:0}`.
  - **Eviction** (window full, p>1): `total=p*mean; rem=total-old; next=isFinite(total)? rem/(p-1) : mean+(mean-old)/(p-1); rm=(old-mean)*(old-next); scale=max(|total|,|old|); severe=isFinite(total)&&scale>0&&|rem|<=((scale*EPS)*4)*p; cancel=!isFinite(next)||(severe&&isFinite(rm)&&isFinite(m2)&&|rm|>=|m2|/2); m2-=rm; mean=next`. With p==1: `mean=0; m2=0`.
  - **Add**: `d=c-mean; mean+=d/cnt; m2+=d*(c-mean)`.
  - Full with `(cancel||m2<0)` → rebase.
  - Output `dv=deviation*Math.sqrt(Math.max(0,m2)/p)`, giving `[mean, mean+dv, mean-dv]`.
  - Population variance; the middle band is **not** bit-equal to sma. Prices near 1e300 overflow m2 and the engine throws. first@ p-1.
- **donchian** `{period=20}` → `['middle','upper','lower']`. `h=extreme(high,max)`, `l=extreme(low,min)`, output `[(h+l)/2, h, l]`. first@ p-1.
- **aroon** `{period=25}` → `['up','down','oscillator']`. Queues of length p+1. `i<p` → NaN×3. `up=100*(p-(i-idxMaxHead))/p`, `down` likewise from the min queue, output `[up, down, up-down]`. first@ p.
- **stochastic** `{period=14, smoothK=3, smoothD=3}` → `['k','d']`.
  - `raw = !isFinite(h)?NaN : h===l?50 : 100*(c-l)/(h-l)`; `k=roll('k',raw,smoothK)`; `d=roll('d',k,smoothD)`.
  - first@ k p+smoothK-2, d p+smoothK+smoothD-3.
- **roc** `{period=12}` → `['value']`. State `{a:[],head:0}`. Window full: `old===0?NaN:(c/old-1)*100`; replace the slot. Otherwise push and return NaN. first@ p.
- **williamsR** `{period=14}` → `['value']`. `!isFinite(h)?NaN : h===l?-50 : -100*(h-c)/(h-l)`, which gives `-0` when `c==h`; keep the sign. first@ p-1.
- **cci** `{period=20}` → `['value']`. `tp=((h+l)+c)/3`; roll; `mean=rebaseRoll(tp)/p` (non-finite → NaN); `dev = (a.reduce(+|x-mean|, 0) in STORAGE order)/p`; output `dev===0 ? 0 : (tp-mean)/(0.015*dev)`. A subnormal `dev` can produce ±Infinity (throw). first@ p-1.
- **obv** (no params) → `['value']`. State `{previous:NaN, value:0}`. `if isFinite(prev) value += Math.sign(c-prev)*v; prev=c`. first@ 0.
- **vwap** → see §3.7.10.
- **mfi** `{period=14}` → `['value']`. `tp=(h+l+c)/3; sg=Math.sign(tp-prev); prev=tp`; a non-finite `sg` gives NaN with no ring update. `pos=roll('p', sg>0?tp*v:0)`, `neg=roll('n', sg<0?tp*v:0)`; output `!isFinite(pos)?NaN : pos===0&&neg===0?50 : neg===0?100 : 100-100/(1+pos/neg)`. Negative prices can produce ±Infinity (throw). first@ p.
- **cmf** `{period=20}` → `['value']`. `mf=h===l?0:(2c-h-l)/(h-l)*v`; `f=roll('f',mf)`, `vv=roll('v',v)`; output `!isFinite(f)||vv===0 ? NaN : f/vv`, a ratio of means. first@ p-1.
- **adx** `{period=14}` → `['adx','plusDI','minusDI']`. State `{previous:null}`; bar 0 gives NaN×3.
  - `up=h-prev.high; dn=prev.low-l`.
  - `tr=smooth('tr',trueRange(b,prev.close),p,1/p)`.
  - `pl=smooth('p',(up>dn&&up>0)?up:0)`, `mi=smooth('m',(dn>up&&dn>0)?dn:0)`.
  - `a=!isFinite(tr)?NaN : tr===0?0 : 100*pl/tr`; `z` likewise from `mi`.
  - `dx=(a+z===0)?0 : 100*|a-z|/(a+z)`.
  - Output `[smooth('dx',dx,p,1/p), a, z]`. Smoother creation order: `tr, p, m, dx`.
  - first@ DI p, ADX 2p-1.
- **dema / tema** `{period=20}` → `['value']`. `a=emaValue('a',c)`, `z=emaValue('b',a)`; dema `2*a-z`; tema `(3*a-3*z)+emaValue('c',z)`. first@ 2p-2 / 3p-3.
- **hma** `{period=20}` → `['value']`. `half=max(1,floor(p/2))`, `root=max(1,floor(sqrt(p)))`; `weighted('r', 2*weighted('h',c,half) - weighted('f',c,p), root)`; key creation order `h, f, r`. first@ p+root-2.
- **keltner** `{period=20, atrPeriod=10, multiplier=2}` → `['middle','upper','lower']`.
  - Checks `period(p), period(atrPeriod)`, then `!isFinite(m)||m<0` → RangeError `Multiplier`.
  - `mid=emaValue('e',c,p)` (plain smooth); `atr=smooth('a',trueRange(b,prev),atrPeriod,1/atrPeriod)`; `prev=c`.
  - Output `[mid, mid+m*atr, mid-m*atr]`. first@ middle p-1, bands max(p,atrPeriod)-1.
- **supertrend** `{period=10, multiplier=3}` → `['value','direction']`.
  - Checks `period(p)`, then `!isFinite(m)||m<=0` → RangeError `Multiplier`.
  - State `{previous:NaN, upper:NaN, lower:NaN, direction:1}`.
  - `atr=smooth('a',trueRange(b,prev),p,1/p); pc=prev; prev=c`. Non-finite `atr` → `[NaN,NaN]`.
  - `U=(h+l)/2+m*atr`, `L=(h+l)/2-m*atr`.
  - First time: `upper=U; lower=L`.
  - Afterwards: `upper=(U<oldU||pc>oldU)?U:oldU`; `lower=(L>oldL||pc<oldL)?L:oldL`; then `dir<0&&c>upper → 1`, else `dir>0&&c<lower → -1`.
  - Output `[dir>0?lower:upper, dir]`. first@ p-1.
- **ichimoku** `{conversion=9, base=26, span=52, displacement=26}` → `['tenkan','kijun','spanA','spanB','chikou']`.
  - `plotOffsets {spanA:d, spanB:d, chikou:-d}`, so `d=0` gives `chikou:-0` (`indicators.mjs:191`).
  - Displacement must be an integer 0..10000, else RangeError `Displacement`.
  - `mid(k,n)=(extreme(k+'h',h,n,max)+extreme(k+'l',l,n,min))/2`; output `[t, k, (t+k)/2, mid('b',span), close]`. Queue key order `th, tl, kh, kl, bh, bl`.
  - Output arrays are not shifted; offsets are metadata only.
  - first@ tenkan conv-1, kijun base-1, spanA max(conv,base)-1, spanB span-1, chikou 0.
- **trix** `{period=15}` → `['value']`. `v=emaValue('c',emaValue('b',emaValue('a',c)))`; `pv=prev; prev=v` (assigned even when NaN); `ch=(!isFinite(pv)||pv===0)?NaN:(v/pv-1)*100`; output `isFinite(ch)?ch:NaN`. first@ 3p-2.
- **ppo** `{fast=12, slow=26, signal=9}` → `['ppo','signal','histogram']`.
  - `fast>=slow` → RangeError `Fast < slow`.
  - `f=emaValue('f',c,fast)`, `l=emaValue('l',c,slow)`, `v=l===0?NaN:100*(f-l)/l`, `sg=emaValue('s',v,signal)`; output `[v,sg,v-sg]`.
- **stochRSI** `{period=14, stochPeriod=14, smoothK=3, smoothD=3}` → `['k','d']`. State `{previous:NaN, valid:0}`.
  1. RSI as above, written to `r`.
  2. If `r` is finite: `i=valid++`; `hi=extreme('h',r,stochPeriod,i,true)`, `lo=extreme('z',r,…,false)` (the queue index is the count of valid RSI values); `raw = !isFinite(hi)?NaN : hi===lo?50 : 100*(r-lo)/(hi-lo)`.
  3. `k=roll('k',raw,smoothK)`; output `[k, roll('d',k,smoothD)]`.
- **adl** (no params) → `['value']`. `value += moneyFlow(b)`. Can overflow (throw). first@ 0.
- **chaikin** `{fast=3, slow=10}` → `['value']`. `fast>=slow` → RangeError `Fast < slow`. `value+=moneyFlow`; output `emaValue('f',value,fast) - emaValue('l',value,slow)`. first@ slow-1.
- **forceIndex** `{period=13}` → `['value']`. `x=(c-prev)*v; prev=c`; output `emaValue('e',x,p)`. first@ p.
- **volumeOscillator** `{fast=14, slow=28}` → `['value']`. `fast>=slow` → RangeError `Fast < slow`. `f=roll('f',v,fast)`, `l=roll('l',v,slow)`; output `l===0?NaN:100*(f-l)/l`.
- **vortex** `{period=14}` → `['plus','minus']`. State `{previous:null}`.
  - `tr=roll('tr',trueRange(b,prev.close),p)`, `a=roll('p',|h-prev.low|,p)`, `z=roll('m',|l-prev.high|,p)`.
  - Output `[tr===0?NaN:a/tr, tr===0?NaN:z/tr]`. first@ p.
- **pivots** → see §3.7.10.
- **parabolicSAR** `{step=.02, max=.2}` → `['value','direction']`.
  - `!isFinite(step)||!isFinite(max)||step<=0||max<step||max>1` → RangeError `SAR acceleration`.
  - State `{previous:null, older:null, sar:NaN, ep:NaN, af:step, direction:1}`.
  - Bar 0 → NaN×2.
  - Init: `dir = c>=prev.close ? 1 : -1`; `sar = dir>0 ? min(prev.low,l) : max(prev.high,h)`; `ep = dir>0 ? max(prev.high,h) : min(prev.low,l)`.
  - Afterwards:
    - `s=sar+af*(ep-sar)`, clamped with `Math.min(s, prev.low, older?.low ?? prev.low)` (or `Math.max` with the highs);
    - reversal when `(dir>0 ? l<s : h>s)` → `dir=-dir; s=ep; ep=(dir>0?h:l); af=step`;
    - else when `(dir>0 ? h>ep : l<ep)` → `ep=…; af=Math.min(max, af+step)`.
  - `older=prev; prev={h,l,c}`; output `[sar, dir]`. first@ 1.

#### 3.7.5 Snapshot shapes and key insertion order (as computed from bar 0)
Key order matters because checkpoint JSON must be byte-identical:

- `sma {r}`, `ema {e}`, `wma {r}`, `cci {tp}`
- `vwma {a, head, sums:[[sum,comp]×3], invalid, positive}`
- `rsi {previous, g, l}`, `atr {previous, tr}`, `macd/ppo {f, l, s}`
- `bollinger {mean, m2, a, head}`, `roc {a, head}`
- `donchian/aroon/williamsR {h, l}`, `stochastic {h, l, k, d}`
- `obv {previous, value}`, `adl {value}`
- `mfi {previous, p, n}`, `cmf {f, v}`, `volumeOscillator {f, l}`
- `adx {previous:null|{high,low,close}, tr, p, m, dx}`
- `dema {a,b}`, `tema {a,b,c}`, `hma {h,f,r}`
- `keltner {previous, e, a}`, `supertrend {previous, upper, lower, direction, a}`
- `ichimoku {th, tl, kh, kl, bh, bl}`, `trix {previous, a, b, c}`
- `stochRSI {previous, valid, k, d, g, l, h, z}`
- `chaikin {value, f, l}`, `forceIndex {previous, e}`, `vortex {previous, tr, p, m}`
- `parabolicSAR {previous, older, sar, ep, af, direction}`

Shared sub-states:
- rolling ring `{a, head, sum}` (`head` stays 0 until full; `sum` may be NaN or ±Inf);
- smoothing `{count, sum, value}` (snapshots set `sum=+0` once `value` is finite);
- extreme queue `{a:[[idx,val]…], head:0}` in every snapshot.

The index-0 snapshot equals the initial state table in `checkpoint-validation.mjs:117-122` (`parabolicSAR af = params.step ?? .02`).

#### 3.7.6 Engine entries and store-notification invalidation (`indicators.mjs:226-237`)
- **Constructor**: `new IndicatorEngine(store, {checkpointSize=256, maxOutputBytes=268435456})`.
  - `checkpointSize` must be an integer ≥ 1, else RangeError `Checkpoint size`.
  - `maxOutputBytes` must be a safe int 0..536870912, else RangeError `Indicator output byte limit`.
  - Subscribes an internal store listener and registers itself as the store's `'engine'` owner.
- **Entry**:
  - `{def, name, params (cloneState, insertion order kept), dirty, dirtyTo, invalidated, length, arrays: Float64Array(capacity) per output (NaN-filled), checkpoints: Map<int,state> | NativeCheckpointMap, revision, computedFrom?, computedUntil?, preparedVersion?}`.
  - A clean entry has `dirty==n, dirtyTo==0, invalidated==false, length==n`.
- **Store listener**, on `({from, kind, to, appended})`:
  1. `compact` → return (compaction already reset the entries).
  2. For each entry, skipping `preparedVersion===store.version` (web only):
     - `dirty = min(dirty, from)`;
     - `dirtyTo = max(dirtyTo ?? 0, kind==='update' ? from+1 : kind==='batch' ? (to ?? length) : length)`;
     - `invalidated = true` unless `kind==='update'` or (`batch` with `appended==0`);
     - `reset`/`prepend` → `checkpoints.clear(); dirty=0; length=0`.
  3. Arrays are **not** cleared on reset: values past n remain. Async copies see them; public `subarray(0,n)` views do not.
- **Laziness**: mutations only mark entries dirty. Calculation, and its errors, happen at the next read: scene, `indicatorValues`/`indicatorValueAt`, crosshair, `dataAt`, `nativeIndicatorBuffer`. Rust must keep the same failure points.

#### 3.7.7 `IndicatorEngine.add(id, name, params={})` (`:232-237`)
1. `identifier(id,'Indicator id')`.
2. `validateIndicatorParams(params)` (§3.7.11).
3. `entries.size >= 128` → RangeError `Indicator limit`.
4. A duplicate id → Error `Duplicate indicator id`.
5. Registry lookup, else Error `Unknown indicator: ${name}`. `name` is not validated, so `null` stringifies to `Unknown indicator: null`.
6. `def = factory(params)`; factory errors propagate.
7. Def shape check, else TypeError `Invalid indicator definition`:
   - outputs: an array of 1..32 unique non-empty strings, each ≤128, none reserved;
   - `create` is a function;
   - every `plotOffsets` key is an output, with an integer value `|v|<=10000`.
8. Insert `{def, name, params: cloneState(params), dirty:0, dirtyTo:store.length, invalidated:true, length:0, arrays:[], checkpoints:new Map(), revision:0}`.
9. `return this.get(id)`. On error the entry is deleted and retired, and the error is rethrown.

#### 3.7.8 `calculate(id, chunkSize=4096)` generator and `get(id)` (`:240-294`)
- **Setup**:
  1. `chunkSize` must be an integer 1..65536, else RangeError `Calculation chunk size`. This is checked on the first `next()`.
  2. A missing entry → Error `Missing indicator: ${id}`. A running entry → IndicatorBusyError `Indicator calculation already running`. Depth > 32 → IndicatorBusyError `Indicator calculation nesting limit (32)`.
  3. Capture version, n, capacity and the columns.
- **Buffers**: if there are no arrays, or `arrays[0].length !== capacity`, check the budget: Σ over **all** entries of `outputs.length*capacity*8 > maxOutputBytes` → RangeError `Indicator output byte limit`. Then reallocate NaN-filled arrays and copy the old values.
- **Recompute** when `dirty < n`:
  1. `start = floor(dirty/256)*256`.
  2. `pure` = the registry factory is canonical and `isCanonicalBuiltinDefinition(name, def)`. `reuse = pure && !invalidated && length===n`.
  3. Set `invalidated=true` and create an instance. If `start>0`, restore `checkpoints[start]`, else Error `Missing checkpoint`.
  4. For `i` in `start..n-1`:
     - At `i%256==0`: `st = snapshot()`. If `reuse && i>start && i>=dirtyTo && old && equalState(st, canonicalCheckpoint(old))`, set `until=i` and break (converged). Otherwise `checkpoints.set(i, st)`.
     - Fill the **reused** bar object (keys `time, open, high, low, close, volume`, refilled per index; `index` is absolute), then `vals = step(bar,i)`.
     - `vals.length` must equal the output count, else TypeError `Indicator output arity`. Each value must be a number and not ±Infinity, else TypeError `Output must be finite or NaN`. NaN and `-0` are allowed.
     - Every `chunkSize` steps counted from `start`, yield `{from:start, to:i+1, total:n}`.
  5. If not converged: when `n%256==0`, write `checkpoints[n]`; delete keys > n.
  6. `computedFrom=start; computedUntil=until; revision++`.
- **Publish**: the result is `{outputs:{name: arrays[i].subarray(0,n)} (live views), plotOffsets:{...def.plotOffsets}, revision, computedFrom, computedUntil}`. If work was done, commit `{dirty:n, dirtyTo:0, invalidated:false, length:n, …}`.
- **Metadata quirks**:
  - an empty store gives `revision 0, computedFrom 0, computedUntil 0`;
  - after `setData([])` the stale `computedUntil` (e.g. 300) is returned with n=0;
  - a converged run reports `computedUntil` = the convergence boundary.
- **On failure mid-run**: records `[start, i)` stay replaced, metadata stays unchanged, `invalidated=true`. A retry recomputes from the same start and fails at the same place.
- **Guards (X)**: generation tokens, `sameSource`, and `StaleSourceError 'Stale indicator calculation: source changed or owner replaced, removed, or disposed'`.

#### 3.7.9 Linked modules (`indicator-modules.mjs`, `trusted-studies.mjs`)
- `aster.volume-direction@1/pressure`:
  - `factory({factor=1, shift=0}={})`: `!isFinite(factor) || abs(factor)>1 || !Number.isInteger(shift) || abs(shift)>10000` → RangeError `Volume-direction factor/shift`.
  - outputs `['signed','cumulative']`, plotOffsets `{signed:shift, cumulative:shift}`.
  - Step: `signed = Number.isNaN(previous) ? 0 : (Math.sign(c-previous)*v)*factor; previous=c; cumulative+=signed`.
  - Not canonical, so it runs with per-row guards, without convergence, from the dirty block to the end.
  - Vector: closes 10, 11, 11, 9 with volumes 5, 7, 8, 9 → signed `[0,7,0,-9]`, cumulative `[0,7,7,-2]`.
- `registerIndicatorModule(id, version)` (tier A, `api.mjs:243`):
  - `indicatorModuleDefinitions` validates: `identifier(id,'id')` (→ `id: string limit 128`, `id: reserved identifier`), then `@` or `/` in id → TypeError `Indicator module id`, then version a safe int ≥1 → TypeError `Indicator module version`. Unknown → `UnsupportedIndicatorError`.
  - A canonical name already bound to a different factory → Error `Indicator module name conflict`.
  - Otherwise writes the registry and returns the names. Idempotent.
- Descriptor: `{id, version, stateVersion, exportName, causal:true}` (frozen, this key order).
- `UnsupportedIndicatorError` message: `Unsupported indicator module: ${String(name).slice(0,128)}; requires a canonical builtin or linked factory`.

#### 3.7.10 Session studies (`session-studies.mjs`): vwap and pivots
- **Parameters** (`sessionStudyParams`, `:54-66`), in order:
  1. Record check (reserved/own keys).
  2. Every non-`calendar` value must be a string or a finite number, else TypeError `Primitive finite session study params`.
  3. `calendar` → `sessionStudyConfig` (parse and normalize, LRU 16).
  4. Own `sessionMs` together with calendar or anchorTime → TypeError `sessionMs conflicts with calendar/anchorTime`.
  5. `anchorTime` (vwap only; pivots with anchorTime also throws this): a safe int with `|t|<=8.64e15`, else RangeError `VWAP anchor UTC milliseconds`.
  6. `sessionMs = params.sessionMs ?? 86400000`: finite > 0 (non-integer allowed), else RangeError `Session duration`.
  7. `kinds`: requires a calendar (TypeError `Session kinds require calendar`); a string ≤2048 split on `,`, ≤16 entries, each non-empty, trimmed, ≤128 and unique (TypeError `Unique comma-separated session kinds`, `Session kinds string limit`).
  8. vwap `source ∈ {hlc3, close, hl2, ohlc4}` else TypeError `VWAP source`.
  9. vwap `deviation` finite ≥ 0 else RangeError `VWAP deviation multiplier`.
  - `advanced = calendar || anchor!==undefined || kinds!==undefined || (vwap && (source!==undefined || deviation!==undefined))`. Passing `source:'hlc3'` explicitly therefore switches to the advanced schema: the values are identical, but the state shape and overflow errors differ.
- **Selector** `select(time)`:
  - `anchor` set and `time<anchor` → `null`;
  - with a calendar: `s=calendar.at(time,kinds)`, none → `null`;
  - returns the anchor, else `s.date`, else `floor(time/sessionMs)` (non-finite → RangeError `Session bucket overflow`). Memoized (LRU 512, calendar only).
- **vwap, legacy mode**: `['value']`, state `{session:NaN, pv:0, v:0}`. `ses=floor(time/sessionMs)`; on a new session reset `pv, v`; `pv += ((h+l+c)/3)*vol; v += vol`; output `v===0?NaN:pv/v`. Overflow emits Infinity, which becomes the engine throw.
- **vwap, advanced mode**:
  - outputs `['value','upper','lower','deviation','volume']` when `deviation` is given, else `['value']`.
  - state `{session:null, count:0, pv:0, v:0, mean:0, m2:0}`.
  - step:
    1. `ses=select(bar)`; `null` → NaN outputs and no state change.
    2. `prev = same session ? state : initial`.
    3. `x` = source price: close; hl2 `(h+l)/2`; ohlc4 `(((o+h)+l)+c)/4`; hlc3 `((h+l)+c)/3`.
    4. `v=prev.v+vol; pv=prev.pv+x*vol`; non-finite → RangeError `Session study numeric overflow`.
    5. `mean = vol===0 ? prev.mean : prev.v===0 ? x : prev.mean+(x-prev.mean)*(vol/v)`.
    6. `m2 = (vol===0||prev.v===0) ? prev.m2 : prev.m2+(vol*(x-prev.mean))*(x-mean)`. Checks: finite (`Session study numeric overflow`); `m2<0` → RangeError `Session variance`.
    7. `value=v===0?NaN:pv/v`; `sigma=v===0?NaN:Math.sqrt(m2/v)`. Outputs `[value, value+dev*sigma, value-dev*sigma, sigma, v]`.
  - first finite: the first bar with cumulative session volume > 0.
- **pivots, legacy mode**:
  - `['pivot','r1','s1','r2','s2']`, state `{session:NaN, high:NaN, low:NaN, close:NaN, levels:[NaN×5]}`.
  - On a new session with a finite previous close: `p=(H+L+C)/3`, `levels=[p, 2p-L, 2p-H, (p+H)-L, (p-H)+L]` from the previous session. Then the high/low tracking restarts.
  - `close=c` always. Output `levels`.
- **pivots, advanced mode** (calendar or kinds):
  - state `{session:null, count:0, high:null, low, close, levels}`.
  - Requires finite `h, l, c` (else `Session study numeric overflow`) and `l<=c<=h` (else RangeError `Session OHLC`).
  - Levels are computed when `count>0`.
- **`portableSessionCalendar(options)`** (`:33-40`) → canonical JSON text `{timezone, weekdays(sorted), windows:[{open,close,kind}], exceptions, ambiguity}` (≤65536 UTF-8 bytes).
  - **Validation**:
    - timezone ≤128 and accepted by `zonedParts`;
    - weekdays: ≤7 unique ints 0..6 (`Unique weekdays 0..6 required`);
    - windows: ≤16 per day, HH:mm (`Session HH:mm clock`), ordered and non-overlapping (RangeError `Ordered nonoverlapping session windows`);
    - kind: no comma and no outer whitespace (`Session kind without comma/outer whitespace`);
    - exceptions: ≤512 ISO dates (`Session exception limit 512`), date strings round-tripping through `toISOString` (`Session ISO date`);
    - ambiguity: `earlier`/`later`/`reject` (`Session ambiguity earlier/later/reject`);
    - lone surrogates → `Session Unicode scalar`;
    - size → RangeError `Session calendar 64KiB limit`.
  - **Windows for a date**: the exception if present; else `windows` when `getUTCDay(date+'T12:00:00Z') ∈ weekdays`; else none.
  - **Sessions**: the overlap check `Ordered nonoverlapping sessions required`; the adjacent-day overlap check RangeError `Overlapping adjacent session dates`.
- **Advanced checkpoint validator** (`validateSessionCheckpoint`, `:111-123`): messages listed in §4.

#### 3.7.11 `validateIndicatorParams(params)` (`indicator-params.mjs:4-14`)
1. `!params || typeof params!=='object'` → TypeError `Indicator params`. This covers undefined, null, numbers, strings and booleans, and args of length 0 or 1 through dispatch.
2. `optionRecord(params, Object.keys(params), 'Indicator params')`: array → `Indicator params: object required`; non-plain → `…: plain object required`; an own `__proto__`/`constructor`/`prototype` → `…: unsupported field <key>` (first in `Object.keys` order; checked before the count).
3. `Reflect.ownKeys(getOwnPropertyDescriptors)` count > 32 → TypeError `Indicator parameter count` (32 passes).
4. Each key, in ownKeys order:
   - a symbol, non-enumerable or accessor → TypeError `Indicator parameter data properties`;
   - a number must be finite; any other value must be a string with UTF-16 length ≤256 (≤65536 when the key is exactly `calendar`); else TypeError `Indicator parameter values`. Booleans, null, objects, NaN and ±Inf are rejected. `-0` is accepted and preserved.
- Swift `BaroChartParamValue.flag` and Java `ParamValue.flag` (booleans) therefore always fail with `Indicator parameter values`.

#### 3.7.12 Throw points on extreme data (must match exactly)
These builtins can emit ±Infinity, which makes the engine throw `TypeError 'Output must be finite or NaN'` with partial outputs left written:

| Builtin | Trigger |
|---|---|
| bollinger | `m2` overflow at 1e300 |
| wma | huge prices |
| donchian | middle band `(h+l)/2` |
| roc | subnormal `old` |
| williamsR, adx, keltner, supertrend, dema, ichimoku, forceIndex, adl | overflow |
| legacy vwap | overflow |
| cci | subnormal `dev` |
| mfi | negative prices |

sma, ema and advanced vwap never emit Infinity: sma and ema recover, and advanced vwap throws its own RangeError instead.

---

### 3.8 Native checkpoint containers (`native-checkpoints.mjs`) and checkpoint-state validation

#### 3.8.1 Constants (`:4-5`)
- `NATIVE_CHECKPOINT_RECORD_BYTES = 262144` (UTF-16 units × 2, so 131072 chars).
- `NATIVE_CHECKPOINT_TOTAL_BYTES = 33554432` (ledger default and maximum).
- Max index `4194304`.
- Footprint limits: nodes 250000, depth 32, arrays ≤65535.

#### 3.8.2 `nativeCheckpointFootprint(state)` (`:8-12`)
Computes the exact UTF-16 length of `safeCheckpointStringify(state)` without building the string. It walks `Reflect.ownKeys` order depth-first, from depth 0.
- Per value: `++nodes`; `nodes>250000 || depth>32` → RangeError `Native checkpoint state limit`.
- Costs:
  - `null` 4, `true` 4, `false` 5;
  - a finite non-`-0` number: `String(v).length`; `-0` 21, NaN 22, Infinity 27, -Infinity 28 (marker lengths);
  - a string: 2 (quotes) + per unit: 2 for `"`, `\`, 0x08, 0x09, 0x0A, 0x0C, 0x0D; 6 for other <0x20; a valid surrogate pair counts 2 in total; a lone surrogate → TypeError `Native checkpoint Unicode`; everything else 1.
  - containers: 2 for brackets, 1 per separating comma, object keys cost the key string + 1 for the colon.
- Shape checks:
  - a non-object or cycle → TypeError `Native checkpoint plain state`; the prototype must be `Array.prototype` for arrays and `Object.prototype`/`null` for objects;
  - array `length` must be a safe int 0..65535, else RangeError `Native checkpoint record byte limit` (checked before children);
  - own key count ≠ length+1 → TypeError `Native checkpoint array shape`;
  - a non-string or reserved key (`__proto__`, `prototype`, `constructor`, `toJSON`, `$asterNumber`) → TypeError `Native checkpoint reserved key`;
  - non-enumerable, accessor, or an array key ≠ `String(index)` → TypeError `Native checkpoint own data fields`.
- Throws RangeError `Native checkpoint record byte limit` **as soon as** `chars*2 > 262144` (equality passes). This can pre-empt later structural errors.
- Returns `{encodedBytes: chars*2, nodes, logicalBytes: chars*2 + nodes*32}`.
- Measured record sizes: `sma(10000)` = 80,076 B with integer closes; 137,298 B with 2-decimal closes; over the limit with long decimals. `vwma(5000)` = 140,196–246,956 B. Number formatting is therefore load-bearing.

#### 3.8.3 `NativeCheckpointBudget` / `NativeCheckpointMap`
- **Budget** (`:17-20`): a private ledger `{used, limit}`. `limit` must be a safe int 0..33554432, default 33554432, else RangeError `Native checkpoint total byte limit`.
- **Map constructor** `new NativeCheckpointMap(name, params, {budget=new Budget(), block=256})` (`:22-23`): `name` must be a non-empty string, `budget` a real ledger, `block` an integer 1..4194304, else TypeError `Native checkpoint context`. `params` must pass `validateIndicatorParams` and are frozen.
- **`set(index, state)`** (`:13, :28`). The order is fixed and failure is atomic:
  1. Closed → Error `Native checkpoint disposed`.
  2. Capture the epoch.
  3. Index not a safe int, out of `[0,4194304]`, or `index % block ≠ 0` → RangeError `Native checkpoint index`.
  4. Footprint, then `safeCheckpointStringify`. `text.length*2 ≠ encodedBytes` → TypeError `Native checkpoint serialization changed`.
  5. `owned = safeCheckpointParse(text)`.
  6. `validateCheckpointState(name, params, owned, index)` (§3.8.4).
  7. Re-serialize; a differing result → TypeError `Native checkpoint validator mutated state`.
  8. Epoch check: closed → disposed; epoch changed → `StaleCheckpointError 'Native checkpoint changed during validation'` (X).
  9. Charge the ledger: `old = (existing length ?? 0)*2`, `new = text.length*2`. Fail when the ledger is missing, `old`/`new` invalid, `old > used`, or `used - old > limit - new` → RangeError `Native checkpoint total byte limit`. Equality passes.
  10. Store; `#bytes += new-old`; `epoch++`.
- **Other methods**:
  - `get(index)`: checks closed, then returns a fresh `safeCheckpointParse` copy, or `undefined`.
  - `has`, `size`, `encodedBytes`: no closed check.
  - `delete(index)`: `epoch++` first; returns false if missing, else refunds and returns true.
  - `clear()`: `epoch++` and refund everything.
  - `dispose()`: idempotent; closes, retires, empties.
  - `keys()`: a sorted numeric snapshot.
  - `validateHistory(length)`: tier J/T, tests only.

#### 3.8.4 `validateCheckpointState(name, params, state, index)` (`checkpoint-validation.mjs:62-171`)
Integrity checks for builtin incremental state.
- **Dispatch**:
  - `index` must be a safe int 0..4194304, else TypeError `Checkpoint state integer`; then `validateIndicatorParams`;
  - a linked module → `validateModuleCheckpoint` (JS-only);
  - `vwma` → `checkpointVwma`;
  - advanced `vwap`/`pivots` → `validateSessionCheckpoint`;
  - unknown name → TypeError `Checkpoint builtin name`.
  - At `index 0` the state must equal the initial state exactly (record keys + `Object.is` deep equality), else TypeError `Checkpoint initial state`.
- **Helpers**:
  - ring `{a: finite numbers, length ≤ min(n,index); head: 0 while not full, else 0..n-1; sum?: any number}`;
  - smoothing `{count: int 0..min(n,index); sum; value: not ±Inf, and NaN while count<n}`;
  - extreme queue `{a:[[idx, finite]], length ≤ min(n,index); head===0; idx in max(0,index-n)..index-1, strictly increasing; values strictly decreasing for max, increasing for min; non-empty when index>0}`;
  - bar `{high, low, close}` finite with `low<=close<=high`;
  - `n = params[key] ?? default`, an int 1..10000.
- **Per-indicator rules** (same defaults as §3.7.4):
  - aroon: latest index of both queues must be `index-1` and `h>=l` → `Checkpoint Aroon latest bar`;
  - vwap legacy: `session` an int or ±Inf (not NaN), `v>=0` → `Checkpoint negative volume`;
  - supertrend: direction ±1 → `Checkpoint direction`;
  - pivots: 5 levels → `Checkpoint pivot levels`;
  - parabolicSAR: `af` finite within `[step??0.02, max??0.2]`, direction ±1 → `Checkpoint SAR state`; index 1 requires `older===null`, index ≥2 requires it non-null → `Checkpoint SAR history`;
  - paired optional states (rsi g/l, mfi p/n, adx all-or-none, vortex all-or-none) → `Checkpoint paired state`.
- **VWMA** (n = period ?? 20):
  - `a.length===min(n,index)` → `Checkpoint VWMA window`; `head===(index<n?0:index%n)` → `Checkpoint VWMA head`.
  - Rows are `[product, volume]`: product a number but not NaN; volume finite ≥0; volume 0 requires product 0.
  - Recompute `invalid`, `positive` and the three Neumaier sums in ring order from head, using `add(q,v){a=q[0]; t=a+v; c=q[1]+(|a|>=|v|?(a-t)+v:(v-t)+a); q[0]=finite(t,c,t+c)?t:NaN; q[1]=finite(q[0])?c:0}`.
  - **Strict mode** (`index%n===0`, no positive volume, or a volume/abs sum that is non-finite or ≥ `MAX_VALUE/4`): sums must be `Object.is`-equal. Otherwise `|actual-wanted|` and `|q[1]|` must be ≤ `max(MIN_VALUE*32*n, |scale|*EPSILON*32*n)`.

#### 3.8.5 Ownership, restore installation, and the post-publish budget (decision D2)
- **`NativeCheckpointEntries extends Map`** (`:42-49`) replaces `IndicatorEngine.entries` in restored engines.
  - `set(id, entry)` adopts `entry.checkpoints` when it is a real `NativeCheckpointMap` (own data property).
  - A retired map, or one owned by another registry or another id → TypeError `Native checkpoint entry ownership`.
  - Replacing an id disposes the previous map, which refunds its budget. `delete` and `clear` dispose the maps too.
  - The constructor with an iterable is tests only (`Native checkpoint entry count` for more than 128 rows).
- **Restore target** (`native-workspace-target.mjs:38,44-45`): one shared 32 MiB budget per restore. Every restored indicator gets `new NativeCheckpointMap(name, params, {budget: shared})`. `nativeWorkspaceTargetFinish` publishes that model **as is**, so the container and the budget survive into the live engine.
- **Provenance-dependent behaviour** (measured with the shipped bundle):
  - (a) The current chart holds a record over 256 KiB (e.g. `sma`/`wma` period 10000 on long-decimal closes). Source admission fails with `RangeError 'Native checkpoint record byte limit'`, even if the document does not contain that study. A study present only in the document fails the same way in the target calculate phase.
  - (b) `sma(5000)` on 60,000 bars works on a fresh chart. A restore fails in the target `calculate` phase with `RangeError 'Native checkpoint total byte limit'`, after the full column copy, because the source does not pre-check the 32 MiB budget.
  - (c) A 36,000-bar restore succeeds (141 records, 24,567,056 B). Appending 20,000 bars then makes `nativeSceneJSON`, `indicatorValueAt`, `indicatorValues` and `crosshairValues` all throw the same RangeError. Afterwards the state is frozen at 188 records / 33,398,212 B, and retries fail deterministically.
- **Lifecycle after restore** (measured):

| Operation on a restored engine | Container afterwards |
|---|---|
| `setBars`/`setData`/`setColumns` (reset) | stays bounded; the failure is deferred to the next view call |
| `apply`/`applyDataEvent(s)` (append/update/batch) | stays bounded; limit enforced at the next calculation |
| `compactData` | stays bounded but empty (keep 40,000 → 157 records, 27,574,780 B after scene) |
| `setIndicatorParams`, same value | unchanged (early return) |
| `setIndicatorParams`, different value | becomes an ordinary `Map` for that id; the budget is refunded |
| `addIndicator` / `loadStudies` / `nativeIndicator` (new ids) | ordinary `Map` entries mixed into `NativeCheckpointEntries` |
| `removeIndicator`, engine/model dispose | budget refunded |
| async data job publish (`nativeAsyncFinish`) | all ordinary (new runtime) |

- The shared ledger couples studies: growth in one restored study reduces the headroom of the others.
- Host classification: these messages contain no `budget`, `exceeds` or `: limit N`, so Swift and Java report `invalidArgument`/`INVALID_ARGUMENT`, not `budgetExceeded` (static reading).
- Source accounting differs by provenance:
  - ordinary Map records cost `encoded + nodes*32 + 128` each;
  - NativeCheckpointMap costs `encoded + size*128`.
  - Example (`ema(20)+sma(50)`, 3000 bars): `retainedBytes` 47,124 for a fresh source vs 25,940 for a restored source.

#### 3.8.6 Params-path adoption (tier A, `:63-79`)
- `prepareNativeEntryCommit` installs a `NativeCheckpointMap` with an independent ledger (`32 MiB − encodedBytes of other entries`) into a **plain** `entries` Map. It keeps an adoption registry for later retirement (`retireNativeEntryIfReplaced`, `retireNativeEntriesAfterClear`).
- Consequence: after a low-level `setIndicatorParamsAsync` publish, even a fresh chart carries a bounded entry (measured: 141 records, 24,562,526 B, then failure after appending 20,000 bars).

#### 3.8.7 `ownedCheckpointClear(map)` (`:53-58`)
Used by compaction to separate validation from commit. A real map must be unretired and unmodified, else TypeError `Compaction requires an active unmodified checkpoint map`. A plain Map must have `Map.prototype` and no own keys, else TypeError `Compaction requires an unmodified checkpoint Map`. It returns a clear thunk.


### 3.9 Model and layout (`model.mjs`)

#### 3.9.1 State
- `ChartModel` fields:
  - `store`;
  - `theme`: keys in `DARK_THEME` order, raw strings; the model never normalizes them;
  - `panels` (1..32, array order = top-to-bottom), `axes` (0..64), `series` (0..256, drawing and autoscale order);
  - `seriesValueRevisions` (WeakMap), `seriesValuesRevision` (lazy int);
  - `axisWidth` (finite ≥20, no max; default 82), `precision` (int 0..18; default 2);
  - `view {from,to}`, `crosshair` (`{x,y}`/null), `follow`;
  - `indicators`, `drawings`, `unsubscribe`, `disposed`, `dataIngestion`;
  - `symbol`, `priceFormatter`, `timeFormatter`: set by the API.
- Themes (`:136-137`):
  - `DARK_THEME = {background:'#0c1320', grid:'#1d2a3a', text:'#8093ad', up:'#35d2ab', down:'#fa6c7c', crosshair:'#b9c9de', font:'12px monospace'}`;
  - `LIGHT_THEME = {'#f8fafc','#dfe6ee','#53657d','#078d6d','#df344b','#304158','12px monospace'}` in the same key order.
  - The 6-digit defaults survive until `setTheme` overrides a key; `setTheme` writes `#rrggbbaa`.
- **Constructor** (`:139-147`) `new ChartModel({store=new BarStore(), theme=DARK_THEME, panels=[{id:'price',weight:3}], axes=[], visibleBars=200, axisWidth=82, precision=2})`:
  1. Empty `panels`, non-finite or <20 `axisWidth`, non-finite or <1 `visibleBars`, or `precision` not an int 0..18 → RangeError `Panels, width, visible bars or precision`.
  2. Not a BarStore → TypeError `BarStore required`.
  3. `optionRecord(theme,THEME_KEYS,'Theme')`; each value `boundedText(v,256,'Theme value')`. No color or font syntax check.
  4. `theme = {...DARK_THEME,...theme}`.
  5. `view = {from: Math.max(-.5, L-visibleBars-.5), to: Math.max(visibleBars-.5, L-.5)}`, unclamped; `follow=true`.
  6. `addPanel` each panel; `axes` must be an array, else TypeError `Axes array required`; `addAxis` each axis.
  7. `IndicatorEngine(store)`, `DrawingStore()`, the store subscription and the owner registration.

#### 3.9.2 Record defaults and key order (visible in `inspect` and workspaces)
- **Panel**: `{weight:1, scale:'linear', inverted:false, padding:.08, ...options}`. Example: options `{id,weight}` give the key order `weight, scale, inverted, padding, id`. `setPanel` replaces the record with `{...prev,...patch}`. A patch key whose value is `undefined` stays as a positioned key.
- **Axis**: `{side:'right', scale:'linear', inverted:false, padding:.08, visible:true, tickFormat:'fixed', ...options}`.
- **Series**: `{color:'#7898ff', width:(candles/ohlc?1:1.5), ...options, offset, dirtyFrom:0}`. Runtime caches `rangeIndex`, `revision` and `dirtyFrom` are never serialized.
- `range` holds the caller's array reference. A falsy `range` (`null`, `0`, `false`, `''`) passes validation and is stored as is (inspect and workspace show it). Only the API `setPanel`/`setAxis` turn `range:null`/`base:null` into `undefined`.

#### 3.9.3 Validation and mutation rules
- **`addPanel(options)`** (`:148`):
  1. `optionRecord(PANEL_KEYS,'Panel')`, then `identifier(id,'Panel id')`.
  2. 32 panels → RangeError `Panel limit`.
  3. A duplicate id, or `!isFinite(weight??1)||(weight??1)<=0` → Error `Unique panel id and positive weight`. An explicit null/undefined weight overrides the default and fails validatePanel with RangeError instead.
  4. Defaults; `validatePanel`; an active drawing transaction → Error `Panel layout change during drawing transaction`; push.
- **`validatePanel(p)`** (`:149`), three stages:
  1. `axisVisible` defined and not boolean, or `axisSide` not left/right → TypeError `Panel axis visibility/side`.
  2. `inverted` not boolean, `label` defined and not a string, `formatter` defined and not a function, or `range` truthy and not a 2-array → TypeError `Panel label, inverted, formatter or range`. A label goes through `boundedText(label,256,'Panel label')`.
  3. RangeError `Panel scale/range` when any of these holds: `weight` non-finite or ≤0; `base` defined and non-finite; `scale` not linear/log/percent; `padding` outside `[0,1]`; `precision` defined and not an int 0..18; a truthy `range` with non-finite ends, `r0>=r1`, or `log` with `r0<=0`; `percent` with `base===0`.
- **`setPanel(id,patch)`** (`:152`): `optionRecord(PANEL_KEYS−id,'Panel patch')`; missing → Error `Missing panel`; validate the merged record. During a drawing transaction, a change of weight or strip width, or a projection change (scale, inverted, padding, range, base, axisVisible, axisSide) on a panel with bound drawings → Error `Panel projection change during drawing transaction`.
- **`setPanelOrder(ids)`** (`:153-169`):
  1. Disposed check.
  2. A dense array ≤32, else TypeError `Panel order dense array required`.
  3. Wrong length → TypeError `Panel order must contain every current panel exactly once`.
  4. Each id through `identifier('Panel order id')`; a duplicate or missing id → **Error** with the same message.
  5. An active gesture or pointers → Error `Panel layout change during active gesture`, even when the order is unchanged.
  6. A changed order during a transaction → Error `Panel layout change during drawing transaction`.
  7. Returns `false` when unchanged, `true` after replacing the array.
- **`removePanel(id)`** (`:170-184`): disposed → `identifier` → gesture check → Error `Missing panel`; `Cannot remove the last panel`; `Panel is referenced by series`; `Panel is referenced by axis`; `Panel is referenced by an active drawing transaction`; `Panel is referenced by drawing history` (items plus undo/redo frames).
- **`addAxis(options)`** (`:233`): `optionRecord(AXIS_KEYS,'Axis')` → 64 axes → RangeError `Axis limit` → duplicate id → Error `Duplicate axis` (checked **before** id validation) → defaults → `validateAxis` → strip width changed during a transaction → Error `Axis layout change during drawing transaction`.
- **`validateAxis(a)`** (`:224-232`):
  1. `identifier(id,'Axis id')`, `identifier(panel,'Axis panel')`; missing panel → Error `Missing axis panel`.
  2. `validatePanel` on the scale fields. Its messages say "Panel …".
  3. `side`, `visible`, `tickFormat` ∈ {fixed, scientific} and `width` in `[20,256]`, else TypeError `Axis side/visibility/format/width`.
  4. `prefix`/`suffix` `boundedText(…,64,…,empty ok)`.
  5. `percent` without a finite non-zero `base` → RangeError `Independent percent axis requires an explicit nonzero base`.
- **`setAxis(id, patch)`** (`:234`): `optionRecord(AXIS_KEYS−{id,panel},'Axis patch')` → Error `Missing axis` → validate → transaction projection check `Axis projection change during drawing transaction`.
- **`removeAxis(id)`** (`:235-252`): disposed → `identifier` → referenced by series or drawing history/transaction → Error `Axis is referenced by series or drawing history/transaction`. An unknown id is a no-op that still replaces the array. A strip-width change during a transaction → `Axis layout change during drawing transaction`; the gesture check applies only when the layout changes.
- **`normalizedSeries(o)`** (`:260-275`), in order:
  1. `optionRecord(SERIES_KEYS,'Series')`; `identifier` for id, panel and axisId (`Series axis`); an axis not on that panel → Error `Missing series axis in panel`.
  2. `symbolId` without `values` → TypeError `symbolId belongs to externally aligned values; store/indicator series use primary symbol`.
  3. `label` 1..256 (`Series label: string limit 256`); `color`, `fill`, `upColor`, `downColor` 1..128 (labels are the key names; `fill:null` allowed).
  4. `visible` not boolean, `width` outside `(0,50]` or non-finite, or `baseline` non-finite → TypeError `Series style/visibility`.
  5. Missing panel → Error `Unique series id and existing panel required`.
  6. candles/ohlc with indicator, values, source or symbolId → TypeError `Candles/OHLC use primary store OHLCV`.
  7. Unknown type → Error `Unknown series type`.
  8. Both values and indicator → TypeError `Series chooses external values or indicator output`.
  9. Values not a `Float64Array` of length `store.length` → TypeError `Values must be aligned Float64Array`.
  10. `indicators.get(id)`, which may **compute**; missing → Error `Missing indicator: <id>`.
  11. `source ∉ FIELDS` → TypeError `Series source`.
  12. Unknown output → Error `Missing indicator output`.
  13. `output = o.output ?? firstKey`; `offset = o.offset ?? plotOffsets[output] ?? 0`; a non-integer, `|offset|>10000`, or a non-zero offset on candles/ohlc → RangeError `Series plot offset`.
- **`addSeries`** (`:276`): 256 series → RangeError `Series limit` (checked before the options) → Error `Duplicate series` → normalize → push.
- **`removeSeries(id)`** (`:277`): filter. No validation.
- **`setSeriesValues(id, values)`** (`:278`): `Aligned values and existing series required` / `External values require a general non-indicator series` (TypeErrors); assigns, `dirtyFrom=0`, bumps the revisions.
- **`validateDrawingBinding(d)`** (`:253-259`):
  - `d.panel` defined (even `null`) → `identifier('Drawing panel')`; axisId and seriesId when not null/undefined;
  - missing panel (`d.panel ?? 'price'`) → Error `Missing drawing panel`;
  - an axis not on that panel → Error `Missing drawing axis binding`;
  - a series that is missing, on another panel, or with a different `axisId ?? null` → Error `Missing or mismatched drawing series binding`.
- **`_setIndicatorPlacement(id, {panel, axisId?})`** (tier A, `:185-223`): moves every series bound to the indicator. Returns `{changed, panel, axisId, boundIds}`. Messages are in §4.
- **`dispose()`** (`:299`): idempotent; disposes ingestion, unsubscribes, disposes the engine, clears range indexes. Only `setPanelOrder`, `removePanel`, `removeAxis`, placement, `setSeriesValues` and `seriesData` check `disposed` themselves; the API layer guards the rest.

#### 3.9.4 View state machine (`:143, :146, :294-298`)
- **`forwardOffset() = Math.max(0, ...offsets of visible series)`**.
- **Store listener**:
  - prepend with `L>added` shifts `from/to += added`;
  - reset calls `fit()`;
  - in follow mode, append, batch with `appended>0`, and prepend into an empty store do `span=to-from; to=L+F-.5; from=to-span` in place, unclamped, without recomputing `follow`.
- **`setVisibleRange(from,to)`**:
  1. Non-finite (no coercion), or `to<=from` → RangeError `Visible range`.
  2. `n = max(10, L+F)`; `span = min(n, max(min(10,n), to-from))`; `a = max(-.5, min(n-.5-span, from))`.
  3. `view = {from:a, to:a+span}`, a new object; `follow = |view.to - (L+F-.5)| < 1`.
  - An overflowed `to-from` (Infinity) gives `span=n`.
- **`fit()`** = `setVisibleRange(-.5, max(9.5, L+F-.5))`. With `L+F<10` it leaves `follow=false` (D3).
- **`zoom(factor, anchor=.5)`**:
  1. Non-finite or ≤0 factor → RangeError `Zoom factor`.
  2. An explicit anchor goes through `Math.max(0, Math.min(1, anchor))` with ToNumber: `null→0`, `true→1`, `'0.25'→0.25`, NaN or `'abc'` → NaN, which then throws `Visible range`.
  3. `span=to-from; at=from+span*anchor; next=span*factor; setVisibleRange(at-next*anchor, at+next*(1-anchor))`.
- **`pan(d)`** = `setVisibleRange(from+d, to+d)` with JS `+` (a string concatenates and then throws `Visible range`; `null` adds 0).
- Initial, follow and prepend views are unclamped (`from<-0.5` and span<10 are possible). Readers verified 24000 random steps.

#### 3.9.5 Series range cache `seriesData(s)` (`:279-293`)
- **Values source**: an indicator output (`indicators.get`; missing output → Error `Missing indicator output`) with `revision = data.revision`; otherwise `s.values ?? store.columns[source??'close'].subarray(0,L)` with `revision = store.version`.
- **Cache**: `RangeIndex(finiteCounts)`, or `BlockRangeIndex` when `values.length >= 65536`. It is rebuilt or updated incrementally on a revision change, policy mismatch, or capacity change. A rebuild happens when `computedUntil-start > values.length/4`.
- **Observable contract**: `query(a,b)` returns the exact finite min/max (or ±Inf). The only zero-sign difference is block scan (first seen) versus tree merge (`-0` wins for min).
- **Side effects**: it mutates `s.rangeIndex`, `s.revision` and `s.dirtyFrom=Infinity`, and it triggers indicator calculation. `createLayout` therefore has side effects.

#### 3.9.6 `createLayout(model, width, height)` (`:332-346`)
1. **Size**: non-finite, `width<100`, `height<80`, or either >16384 → RangeError `Chart needs at least 100 × 80 CSS pixels` (U+00D7).
2. **Strip widths** `axisStripWidths` (`:127-134`). For each panel:
   - the default axis contributes `axisWidth` on `axisSide` unless `axisVisible===false`;
   - each visible axis of that panel adds `axis.width ?? axisWidth` on its side;
   - take the max over panels → `[ls, rs]`.
3. **Horizontal**: `factor = Math.min(1, (width-32)/((ls+rs)||1))`; `left = 12+ls*factor`; `right = Math.max(left+20, width-rs*factor)`. `layout.from = a = Math.min(L, Math.max(0, Math.floor(view.from)))`; `layout.to = b = Math.max(a, Math.min(L, Math.ceil(view.to+1)))`.
4. **Vertical**:
   - `maxWeight = Math.max(...weights)`; `total = Σ (w/maxWeight)` accumulated left to right;
   - `size = labelMetrics(theme.font).size`; `footer = Math.min(height-24, Math.max(38, Math.ceil(size*1.5+20)))`; `panelSpace = height-footer`;
   - start with `top=12`; per panel: `row = panelSpace*((w/maxWeight)/total)`; `gap = Math.min(8, row/2)`; `bottom = (top+row)-gap`; next `top = bottom+gap`.
   - The 12 px top margin is not subtracted.
   - Vector: 640×360 with weights 3 and 1 gives panels `[12, 245.5]` and `[253.5, 326]`.
5. **Axis strips** per panel:
   - configs are `[default {...panel, axisId:null, side:axisSide??'right', visible:axisVisible!==false, width:axisWidth}, ...axes of that panel {...axis, axisId:axis.id, width:axis.width??axisWidth}]`;
   - starting from `lx=left, rx=right`: `w = visible ? width*factor : 0`; left side: `axisLeft=lx-w; lx-=w`; right side: `axisLeft=rx; rx+=w`; `axisRight=axisLeft+w`; `textX = left ? axisLeft+4 : axisLeft+8`.
   - Hidden axes are still range-computed, so their errors (e.g. log with data ≤0) fail the whole layout.
6. **`axisRange`** (`:304-329`):
   - **Data min/max** over the visible series bound to this axis (`(s.axisId??null)===config.axisId`):
     - volume histogram (`aggregateVolumeSeries`): `{min:0, max: Math.max(0, ...store.aggregate(a,b,Math.max(1,floor((right-left)/3))).map(v=>v.volume))}`;
     - candles/ohlc: `store.index.query(a,b)`;
     - others: offset-shifted `[sa,sb)` with `sa=min(L,max(0,floor(view.from-off)))`, `sb=max(sa,min(L,ceil(view.to+1-off)))`, queried through `seriesData(s).index`;
     - fold with `Math.min/Math.max`; histogram/area also include `baseline ?? 0`.
   - **Range**:
     1. Non-finite → `log ? [1,10] : [0,1]`.
     2. `log` with finite `min<=0` → RangeError `Log scale requires strictly positive visible data` (checked even when `range` is set).
     3. A truthy `range` replaces `[min,max]`.
     4. Otherwise: `baseline = min===0 && some histogram/area with baseline 0`; `padding = max===min ? ((Math.abs(max)*.01)||1)*p : max*p - min*p`; `min = Math.max(-MAX, min-padding)`, `max = Math.min(MAX, max+padding)`; `baseline → min=0`.
     5. Flat: `d = (Math.abs(min)*1e-12)||1`, then widen by `d` and clamp to ±`MAX_VALUE`.
     6. `log && min<=0` → RangeError `Log scale requires a strictly positive visible range (adjust padding/range)`.
     7. `base = config.base ?? (L ? close[0] : 1)`; `percent && base===0` → RangeError `Percent base cannot be zero`.
   - **Transform**: log → `Math.log`/`Math.exp`; percent → `(v/base-1)*100` / `(v/100+1)*base`; else identity.
     - `lo=T(min)`, `hi=T(max)`; non-finite → RangeError `Axis transform overflow`.
     - `delta=hi-lo`; `direct = isFinite(delta) && delta!==0`; `magnitude = Math.max(|lo|,|hi|)||1`; `span = hi/magnitude - lo/magnitude`.
     - `!direct` and a non-finite or zero `span` → RangeError `Axis transform has no representable span`.
     - `virtualLo = hi-delta`; `deltaError = (hi-(delta+virtualLo))+(virtualLo-lo)`.
     - `inverted` picks `origin=lo, extent=delta` (else `origin=hi, extent=-delta`), with the scaled equivalents.
   - **`y(v)`**: `m=T(v); d=m-origin; f = isFinite(d) ? d/extent : (m/magnitude-scaledOrigin)/scaledExtent; c = top+f*pixels`. Returns `c` if `|c| <= 3.4028234663852886e38`, else NaN. Non-direct uses the scaled path only.
   - **Projection check**: a finite `sourceMin` with `Math.fround(y(sourceMin))` or `Math.fround(y(sourceMax))` non-finite → RangeError `Axis projection overflow for visible values`.
   - **`price(sy)`**:
     - `fr=(sy-top)/(bottom-top)`; `f = inverted ? fr : 1-fr`;
     - `v = direct ? (f<=.5 ? lo+f*delta : hi-(1-f)*delta) : NaN`, plus `deltaError` correction (`f*dE`, or `-(1-f)*dE`);
     - non-finite → `((1-f)*scaledLo + f*scaledHi)*magnitude`;
     - return `inverse(v)`. The endpoints are exact.
7. **Layout object** keys: `geometryKey, geometryFont(=theme.font), width, height, panels, axis(), drawingAxis(), x(), index(), from, to, toScreen(), fromScreen()`. `PanelLayout = {...defaultAxisLayout, axes}`, so default-axis data is duplicated at panel level and in `axes[0]`.
   - AxisLayout keys: config keys, then `left, right, top, bottom, min, max, base (at its config position, else after max), y, price, transform, inverse, lo, hi, axisLeft, axisRight, textX`. Functions vanish in JSON.
8. **`geometryKey`** (`:344`) = `JSON.stringify([width, height, view.from, view.to, store.geometryIdentity, store.timeVersion, ...per axis [panelId, axisId, left, right, top, bottom, min, max, scale, inverted, base], ...per series [id, panel, axisId, visible]])`. It holds the process-global serial (D4).
9. **Coordinate closures** read `model.view` and `model.store` **at call time**:
   - `x(i) = left + ((i-view.from)/(view.to-view.from))*(right-left)`;
   - `index(sx) = view.from + ((sx-left)/(right-left))*(view.to-view.from)`;
   - `axis(panelId, axisId=null)`;
   - `drawingAxis(d)`: with a `seriesId`, the series must exist, be visible, and match panel and axis, else `undefined`;
   - `toScreen(point,…) = {x: x(store.indexAtTime(time)), y: axis.y(price)}`, or `{NaN,NaN}` without an axis;
   - `fromScreen(sx,sy,…)` → `{time: timeAtIndex(index(sx)), price: axis.price(sy)}`; a missing axis → Error `Missing axis`.

---

### 3.10 Drawings (`drawings.mjs`, `drawing-validation.mjs`, `position-drawing.mjs`, `drawing-style-patch.mjs`, `drawing-translation.mjs`)

#### 3.10.1 Types
- **`DRAWING_TYPES`** (`drawing-validation.mjs:4`): `trendline, horizontal, fibonacci, rectangle, ellipse, text, ray, extendedline, channel, fibextension, fibfan, fibtimezones, freehand, measurement, longposition, shortposition`. The tool set adds `select`.
- **Point counts** (`:5`): position 4; horizontal and text 1; channel and fibextension 3; freehand 2..2048 (2 at creation); the rest exactly 2.
- **Drawing record** (ordered keys): `{id, type, panel, points:[{time,price}], style?{color?,fill?,width?,font?}, text?, locked?, visible?, axisId?, seriesId?}`.
  - Deep-frozen.
  - `null` `axisId`/`seriesId` are dropped on add/edit/load through the JSON copy. That copy also turns `-0` into `0`, except on the workspace install path.

#### 3.10.2 `validateDrawing(d)` (`drawing-validation.mjs:6-15`)
The first failure wins:
1. `optionRecord(d, 10 keys, 'Drawing')`.
2. `identifier(id,'Drawing id')`, `identifier(panel,'Drawing panel')`; axisId and seriesId (when not null/undefined).
3. `type ∉ DRAWING_TYPES` → TypeError `Drawing type`.
4. Bad point count → TypeError `Drawing anchors`.
5. Each point: `optionRecord(['time','price'],'Anchor')`, then `!(isFinite(time) && |time|<=8.64e15 && isFinite(price))` → TypeError `Anchor time/price must be finite and within Date range`.
6. Position drawings → `positionMetricsFor` (two RangeErrors, §3.10.7).
7. `visible` defined and not boolean → TypeError `Drawing visible must be boolean`.
8. `text` → `boundedText(text,2000,'Drawing text',true)`.
9. `locked` defined and not boolean → TypeError `Locked must be boolean`.
10. `style` → `optionRecord(['color','fill','width','font'],'Drawing style')`; width non-finite or outside `[0.1,50]` → RangeError `Stroke width`; color and fill `boundedText(…,128,'Color')`; font → `portableFont`.

`null` counts as "defined" (`visible:null` fails). Position checks run before visible, text and style.

#### 3.10.3 `DrawingStore` (`drawings.mjs:14-41`)
- **Options**: `historyLimit=100` (1..10000, else RangeError `History limit 1..10000`); `maxDrawings=10000`; `maxPoints=200000` (≤2097152); `maxDocumentChars=8388608`; `historyBytes=33554432`. Size errors read `<name>: limit <max>`.
- **Fields**: `items` (z-order: later is on top and wins hit tests), `undoStack`, `redoStack` (full `items` snapshots sharing frozen objects), `selected`, `transaction` (a snapshot array or null), `serial` (monotonic; never reset by load/undo).
- **`budget(items)`**: more than `maxDrawings` → RangeError `Drawing count limit`; Σ points > maxPoints or Σ text length > 1,000,000 → RangeError `Drawing points/text limit`.
- **`weight(snapshot) = 8*len + Σ 2*UTF16Len(JSON.stringify(drawing))`**. A public accounting contract that tests rely on.
- **`add(input, {items, beforeMutation})`** (`:32`):
  1. `optionRecord`.
  2. A falsy `id` (undefined, null, '', 0, false) generates `'drawing-'+(++local)` from `serial`, skipping collisions in `items`.
  3. Merge into `{id, panel:'price', locked:false, style:{color:'#f5b85a', width:1.5}, ...input, id}`. Existing keys keep their position and `id` stays first. An `input.style` (even null or `{}`) replaces the default style.
  4. `validateDrawing`, JSON copy (null bindings dropped), validate again, freeze.
  5. A duplicate id → Error `Duplicate drawing id`.
  6. `budget`, then `beforeMutation?.()`, then mutate.
  7. Commit `serial`. Select the drawing if it is visible. Return the id.
- **`edit(id, patch, ctx)`** (`:33`):
  1. `optionRecord(9 keys without id,'Drawing patch')`.
  2. Missing → Error `Missing drawing`.
  3. Locked and the patch has keys other than locked/visible → Error `Drawing is locked`.
  4. `next={...prev,...patch}`. **`style` is replaced, not merged**, and `type` may change if the point count fits.
  5. Validate. If `JSON.stringify(prev)===JSON.stringify(next)` → call `beforeMutation` only and return (no change, no undo entry).
  6. Otherwise copy, validate, freeze, budget, mutate; a hidden selected drawing gets deselected.
  - Note: the patch `{axisId:null}` serializes differently, so it creates a new identical object and an undo entry.
- **`remove(id)`**: missing or locked → `false` (no throw); otherwise mutate, deselect, return `true`.
- **Transactions** (`:23-26`):
  - `begin()` while one is active → Error `A drawing transaction is already active`.
  - `commit()` pushes the snapshot to undo when the length differs or **any element differs by identity**, then clears redo and trims.
  - `cancel()` restores the snapshot and deselects if the selected drawing is missing or hidden.
  - `mutate(fn)` wraps begin/commit when no transaction is active and cancels on throw.
- **`undo()`/`redo()`** (`:35-36`): cancel any active transaction; if the stack is empty → false; swap snapshots; `selected=null`; trim; true.
- **`trim()`** (`:22`): while `undo.length>historyLimit || totalWeight>historyBytes`, drop the oldest undo entry, else the farthest redo entry. A single snapshot heavier than `historyBytes` is dropped silently (so undo becomes impossible).

#### 3.10.4 Document save and versions
- **`save()`** (`:11, :37`):
  1. Active transaction → Error `Commit or cancel before saving`.
  2. `text = JSON.stringify({schema:'aster.drawings', version: drawingDocumentVersion(items), drawings: items})`.
  3. UTF-16 length > `maxDocumentChars` → TypeError `Drawing document: string limit 8388608`. This can happen with default limits even though `add` succeeded.
- **`drawingDocumentVersion(items)`** (`position-drawing.mjs:31`): 4 if any drawing has `visible !== undefined`, else 3 if any position drawing, else 2 if any non-null axisId/seriesId, else 1.
- **`validateDrawingDocumentVersion(d, v)`** (`:32-35`):
  - `visible` defined and `v<4` → TypeError `Drawing visibility requires document version 4`;
  - position and `v<3` → `Position drawings require document version 3`;
  - `v===1` with bindings → `Bound drawings require document version 2`.
  - A higher declared version than needed is accepted; a re-save downgrades it.
- Verified output: `{"schema":"aster.drawings","version":1,"drawings":[{"id":"drawing-1","panel":"price","locked":false,"style":{"color":"#f5b85a","width":1.5},"type":"trendline","points":[{"time":1,"price":2},{"time":3,"price":4}]}]}`.

#### 3.10.5 `load(text, {styleDecoder, validatePanel, validateBinding})` (`:38-41`)
1. `boundedText(text, maxDocumentChars, 'Drawing document', true)`.
2. `JSON.parse` (engine SyntaxError).
3. `optionRecord(['schema','version','drawings'],'Drawing document')`.
4. Wrong schema, `version ∉ {1,2,3,4}`, a non-array, or length > maxDrawings → TypeError `Unsupported drawing document`.
5. Per drawing:
   - `validateDrawing`;
   - `validateDrawingDocumentVersion`;
   - binding check: in the API path, `model.validateDrawingBinding` throws directly; `Invalid drawing binding` is only reached by a falsy validator;
   - `validatePanel` → Error `Missing drawing panel`;
   - JSON copy; `styleDecoder` (API: `portableStyle(s,['color','fill'],true)`, which keeps 6/8-digit hex verbatim including uppercase and normalizes other colors; font trimmed);
   - validate again; freeze.
6. `budget`.
7. Duplicate ids → TypeError `Duplicate drawing ids`.
8. Active transaction → Error `Cannot load during a gesture`. This is checked after validation; load does not cancel the gesture.
9. Canonical re-serialization length check.
10. Mutate: an undo entry unless both the old and new lists are empty. `selected=null`. `serial` is kept.

#### 3.10.6 Group edits (`drawing-translation.mjs:27-103`, tier S for `deleteDrawings`, A for the rest)
Modes: translate `{deltaTimeMs, deltaPrice}`, delete, style (patch), visibility (boolean), duplicate (deltas).
- **Preparation order**:
  1. ownerGuard type → TypeError `Owner guard callback required` (X).
  2. Duplicate options are validated first.
  3. `metadata = translate || (duplicate && !(dt===0 && dp===0))`.
  4. Store, model and controller slots: disposed → Error `Chart disposed`; not a DrawingStore → TypeError `Drawing group edit managed store required`; controller model mismatch → Error `Drawing group edit controller owner mismatch`.
  5. **An active transaction or gesture → Error `Drawing group edit requires no active gesture or transaction`.** Group edits reject; they never cancel.
  6. ids not a plain array → TypeError `Drawing group edit plain array required`; more than 128 → RangeError `Drawing group edit array limit/shape`.
  7. Options record → TypeError `Drawing group edit plain record required` / `Drawing group edit fields`.
  8. 0 ids → RangeError `Drawing group edit requires 1..128 ids`.
  9. Each id through `identifier('Drawing id')`; a duplicate → **TypeError** `Duplicate drawing id`.
  10. Visibility not boolean → TypeError `Drawing visibility boolean required`.
  11. Non-finite deltas → TypeError `Finite deltaTimeMs and deltaPrice required`.
  12. Style → `drawingStylePatch` (§3.10.11).
  13. Limit integrity → RangeError `Drawing group edit history/resource limit`.
  14. Duplicate: serial must be a safe int ≥0, else RangeError `Drawing duplication serial`.
- **Walk the items** in z-order:
  - Σ points > maxPoints → RangeError `Drawing group edit point limit`.
  - **Locked** drawings reject every mode except visibility and duplicate → Error `Drawing is locked`.
  - Delete marks the drawing.
  - Visibility changes only when `(before.visible!==false)!==visible`; a new `visible` key is appended.
  - Style changes when any patch key is absent or differs (`Object.is`); `style={...prev,...patch}`, appended if `style` was absent.
  - Translate/duplicate with metadata:
    - every selected drawing must share `[panel, axisId??null, seriesId??null]`, else Error `Drawing group edit requires identical panel/axis/series binding`;
    - the binding must be live, else Error `Missing or mismatched drawing binding`;
    - new anchors `{time: dt===0 ? t : t+dt, price: dp===0 ? p : p+dp}` (time first);
    - duplicates get `locked:false`.
- **After the walk**:
  - a missing id → Error `Missing drawing`;
  - over the resource limits → RangeError `Drawing group edit resource limit`;
  - duplicate: `Drawing duplication resource limit`; ids `'drawing-'+(++serial)` skipping collisions (exhaustion → `Drawing duplication ID exhaustion`); copies appended unlocked and unselected; final document length → `Drawing duplication document limit`.
- **Receipt**: `{changed, (created: frozen [{sourceId,id}],) invalidationFailed:false}`. Only the duplicate receipt is frozen. With `changed===0`, nothing changes and no history entry is made.
- **History publish**:
  - `weight(items) > historyBytes` → RangeError `Drawing group edit undo snapshot exceeds historyBytes` (the store's `commit` would drop it silently instead);
  - Σ undo weights > 33554432 → RangeError `Drawing group edit retained history resource limit`;
  - append, trim, clear redo; deselect if hidden or deleted; duplicate updates `serial`.
- **Invalidate**: `('drawings')` for visibility and duplicate, `()` otherwise; any throw sets `invalidationFailed=true`.

#### 3.10.7 Position drawings (`position-drawing.mjs`)
- **`positionMetricsFor(d)`** (`:3-9`). Anchors are `[entry, stop, target, extent]`; `sign = long ? 1 : -1`.
  - `risk=(entry-stop)*sign`, `reward=(target-entry)*sign`, `ratio=reward/risk`.
  - `stop.time!==entry.time || target.time!==entry.time || extent.price!==entry.price || !(extent.time>entry.time)` → RangeError `Position anchors require shared start/entry and positive time extent`.
  - `!(risk>0&&reward>0&&ratio>0)` or any of them non-finite → RangeError `Position requires ordered entry/stop/target and finite positive risk, reward and ratio`.
  - `percent(v)=v/|entry|*100`, `null` when non-finite.
  - Returns `{direction:'long'|'short', startTime, endTime, entry, stop, target, risk, reward, riskPercent, rewardPercent, ratio}`.
- **`positionHandlePoints(points, h, p)`**:
  - h0: `[0]={...p}; [1].time=[2].time=p.time; [3].price=p.price`;
  - h1 and h2: price only;
  - h3: `[3].time` only.
- **`initialPositionPoints(type, point, layout, target)`**: the screen point gives `a=price(y-40)`, `b=price(y+40)`; long → `stop=min`, `target=max` (short is the reverse); extent time = `fromScreen(x+80, y).time`. Returns null if invalid.

#### 3.10.8 Geometry `calculateGeometry(d, layout)` (`drawings.mjs:56-84`)
1. Hidden → `[]`. No `drawingAxis` → `[]`. Any non-finite screen point → `[]`.
2. `color = style.color ?? '#f5b85a'`, `width = style.width ?? 1.5`, `clip = [p.left, p.top, p.right-p.left, p.bottom-p.top]`.
3. Commands (key order matters):
   - `lines {op,coords,color,width,clip,dash:null|[4,4]}`, omitted when coords are empty;
   - `text {op,x,y,text,color,font:'12px monospace',clip}` (the scene replaces `font` with `style.font ?? theme.font`, keeping the key position);
   - position boxes `{op:'box',x,y,w,h,fill,color,width,clip}`;
   - rectangle/ellipse `{op:'box'|'ellipse',x,y,w,h,color,width,fill,clip}`. `fill` is undefined when absent, so JSON omits it. The key order differs from the scene box.
4. Per tool:
   - **position**:
     - stop box with fill `'#ef535044'` over `y∈[min(a.y,b.y), |a.y-b.y|]`;
     - target box with fill `style.fill ?? '#26a69a44'`;
     - entry line;
     - labels at `left+4`, `y-4`:
       - ``${Long|Short} entry ${String(entry)} · R/R ${ratio.toPrecision(6)}``
       - ``Stop ${String(stop)} · Δ ${risk.toPrecision(6)} · ${rp===null?'n/a':rp.toPrecision(6)+'%'} of |entry|``
       - ``Target … · Δ ${reward.toPrecision(6)} · …% of |entry|``
   - **horizontal**: `[p.left, a.y, p.right, a.y]`. **trendline**: `[a.x, a.y, b.x, b.y]`.
   - **measurement**: the trendline plus a label at `((a.x+b.x)/2, min(a.y,b.y)-8)`: ``Δ ${delta.toPrecision(6)} (${p0===0?'n/a':(delta/p0*100).toFixed(2)+'%'}) · ${(index(b.x)-index(a.x)).toFixed(1)} bars · ${((t1-t0)/1000).toFixed(0)}s``. Example: `Δ 7.00000 (6.67%) · 10.0 bars · 600s`.
   - **ray / extendedline**: `extendedSegment(a, b, p, ray)`.
   - **channel**:
     - `extendedSegment(a,b)`;
     - `extendedSegment(c, {c.x+b.x-a.x, c.y+b.y-a.y})`;
     - a dashed `[4,4]` middle line from `m=((a.x+c.x)/2, (a.y+c.y)/2)` to `{m.x+b.x-a.x, m.y+b.y-a.y}` (left-associative).
   - **fibonacci**: `r ∈ [0,.236,.382,.5,.618,.786,1]`, `price = p0+(p1-p0)*r`. Skip non-finite y. Line `[a.x,y,b.x,y]` plus label `((r*100).toFixed(1)+'%')` at `(min(a.x,b.x)+4, y-3)`.
   - **fibextension**: `r ∈ [0,.618,1,1.272,1.618,2.618]`, `price = p2+(p1-p0)*r`, line to `p.right`.
   - **fibfan**: `r ∈ [.382,.5,.618]` rays to `{b.x, y(p0+(p1-p0)*r)}`, plus label `'38.2 / 50 / 61.8'` at `(a.x, a.y-8)`.
   - **fibtimezones**: `r ∈ [0,1,2,3,5,8,13,21,34]`, `x=a.x+(b.x-a.x)*r`; full-height lines; labels `String(r)` at `(x+3, p.top+28)`.
   - **freehand**: one `lines` command with consecutive segments.
   - **text**: `label(a.x, a.y, text ?? 'Note')`.
   - **rectangle/ellipse**: `x=min, y=min, w=|Δx|, h=|Δy|`.
5. `drawingGeometry` caches frozen results keyed by `layout.geometryKey` (no semantic effect).

#### 3.10.9 `extendedSegment(a, b, p, ray)` (`:48-53`)
1. `dx=b.x-a.x`, `dy=b.y-a.y`; both zero → `[]`.
2. `lo = ray ? 0 : -Infinity`, `hi = Infinity`.
3. For x then y: `delta==0` with origin outside `[min,max]` → `[]`. Otherwise `t=(min-o)/delta`, `z=(max-o)/delta`, `lo=Math.max(lo, Math.min(t,z))`, `hi=Math.min(hi, Math.max(t,z))`.
4. `lo<=hi` → `[a.x+dx*lo, a.y+dy*lo, a.x+dx*hi, a.y+dy*hi]`.
- JS `Math.min/max` semantics apply. Results such as `917.9999999999999` are expected.

#### 3.10.10 Hit test `drawingHitTest(store, layout, x, y, tol=8)` (`:91-128`)
1. `tol` non-finite or outside `[1,32]` → RangeError `Drawing hit tolerance must be 1..32 logical pixels`. Unreachable from the bridge, because `down()` checks first.
2. The panel containing `(x,y)` (bounds inclusive); none → `null`.
3. `ordered` = items reversed (newest first), visible only; position drawings need 4 finite screen points.
4. **Handles first**: the selected drawing (visible, unlocked, bound, same panel). Among points within `Math.hypot ≤ tol`, the strictly nearest wins, ties to the lowest index → `{id, handle:i}`.
5. **Bodies** in `ordered` order. `bt = text ? tol : Math.max(tol, (style.width??1.5)/2)`. Skip a drawing whose binding is missing, whose panel differs, or that fails `candidateBounds`. Hit rules:
   - position: box `[a.x-bt, extent.x+bt] × [min(stop.y,target.y)-bt, max(…)+bt]`;
   - horizontal: `|y-a.y|<=bt`;
   - text: `labelMetrics(style.font ?? theme.font ?? '12px monospace')`; `x ∈ [a.x-tol, a.x+labelWidth(text??'Note')+tol]`, `y ∈ [a.y-ascent-tol, a.y+descent+tol]`;
   - rectangle: inside the expanded box **and** `min(|x-l|,|x-r|,|y-t|,|y-b|) <= bt` (the interior does not hit);
   - ellipse: `rx,ry` both non-zero → `|hypot((x-cx)/rx,(y-cy)/ry)-1|*min(rx,ry) <= bt`; one zero → segment distance; both zero → none;
   - others: any `lines` segment within `bt` (labels do not hit; dashed lines do).
   - A hit returns `{id, handle:-1, locked:!!d.locked}`; locked bodies hit too.
- **`candidateBounds`** (freehand, trendline, rectangle, ellipse, text, measurement):
  - corners of the data-space min/max box via `toScreen`;
  - `fontSize = Number(font.match(/([0-9.]+)px/)?.[1] ?? 12)`;
  - `textWidth = text ? (text?.length ?? 4)*fontSize*1.2 : 0` (UTF-16 length, unlike `labelWidth`);
  - `labelHeight = text|measurement ? fontSize*2 : 0`.
- **`segmentDistance`**: `t = clamp(((x-a.x)*dx+(y-a.y)*dy)/((dx*dx+dy*dy)||1), 0, 1)`; distance `hypot(x-a.x-t*dx, y-a.y-t*dy)`.

#### 3.10.11 `drawingStylePatch(value)` (`drawing-style-patch.mjs:3-10`)
1. Not a plain object → TypeError `Drawing style plain record required`.
2. No own keys → TypeError `Drawing style nonempty defined patch required`.
3. Each key: not one of `color/fill/width/font` (symbols included) → `Drawing style fields`; not enumerable data → `Drawing style own data fields required`; `undefined` or `null` value → `Drawing style nonempty defined patch required`.
4. `portableStyle(patch, ['color','fill'])`.
5. `width` finite in `[0.1,50]`, else RangeError `Stroke width`.

Key order follows the input.

---

### 3.11 Scene (`scene.mjs`, `scene-parts.mjs`, `labels.mjs`, `frame-cache.mjs`, `crosshair-snap.mjs`, `ohlc-snap.mjs`) and the F64 packet (`native-command-packet.mjs`)

#### 3.11.1 Scene object and command shapes (JSON key order is exact)
- **Scene**: `{width, height, background(theme.background verbatim), commands, layout, stats:{storedBars, visibleSourceBars:layout.to-layout.from, renderedCandleBuckets, commandCount}}` (`scene.mjs:76`).
  - `renderedCandleBuckets` is always the aggregate length `(to>from ? min(to-from, max(1,floor(plotW/3))) : 0)`, whether or not a candle series exists.
  - Empty store: `commands=[{op:'text', x:Math.max(12,width/2-60), y:height/2, text:'No data', color:theme.text, font:theme.font}]` (color before font, no fullText/clip), stats `{0,0,0,1}`. Drawings and crosshair are not added.
- **Commands**:
  - `lines {op:'lines', coords:[x1,y1,x2,y2…], color, width, clip:[l,t,w,h]|null, dash:null|[4,4]}`;
  - `rects {op:'rects', coords:[x,y,w,h…], color, clip}` (no width/dash);
  - `path {op:'path', points, color, width:s.width, fill:(area ? s.fill ?? '#7898ff22' : null), baseline:(area only, axis.y(s.baseline??0); otherwise undefined and omitted), clip}`;
  - title mask `box {op:'box', x, y, w, h, fill, color, width:0, clip}`; handle box `{…, w:8, h:8, fill, color, width:1, clip}`; crosshair mask `{…fill:bg, color:bg, width:0, clip}`;
  - label text `{op:'text', x, y, text, fullText, font, color, clip, labelBounds:[x, y-ascent, width, height], role, (panelId), (axisId)}`.
  - Roles: `axis-title`, `price-tick`, `panel-title`, `time-tick`, `crosshair-price`. The default panel axis has `axisId:null`. `crosshair-time` exists only in typings and is never emitted.

#### 3.11.2 `buildScene(model, w, h, {crosshair=true, drawings=true})` order (`scene.mjs:6-77`)
1. `layout = createLayout(...)` (may throw); `metrics = labelMetrics(theme.font)`. An empty store returns the "No data" scene.
2. `buckets = store.aggregate(layout.from, layout.to, Math.max(1, Math.floor((P0.right-P0.left)/3)))`, shared by all panels.
3. Per panel, in layout order:
   - **Grid** (`:15-17`): `priceTicks = Math.max(1, Math.min(4, Math.floor((bottom-top)/40)))`. For `j=0..priceTicks`, `y = top+j*(bottom-top)/priceTicks`. For `j=0..5`, `x = left+(right-left)*j/5`. One `lines` command in `theme.grid`, width 1, `clip:null`, `dash:null`.
   - **Visible axes** (default first, then `model.axes` order; `:18-23`):
     - `axisClip=[axisLeft, top, axisRight-axisLeft, bottom-top]`; `x=axisLeft+4`; `maxWidth=(axisRight-x)-4`;
     - `hasTitle = !!label && bottom-top >= H*2+12` (the default axis label is the panel label, so it also appears as the axis title);
     - `labelTop = top+4`; with a title, add the title label and `labelTop += H+4`;
     - `space = bottom-4-labelTop`; `count = Math.max(0, Math.min(5, Math.floor((space+4)/(H+4))))`;
     - tick j: `top_j = labelTop + (count===1 ? (space-H)/2 : j*(space-H)/(count-1))`; `y = top_j+ascent`; `at = clamp(top_j+H/2)`; label = `formatAxisValue(axis.price(at))`.
   - **Series** in model order: visible, same panel, axis exists.
     - **candles/ohlc** (`:26-36`): `x=layout.x(b.index)`; `w = Math.max(.8, (x(end)-x(start))*.72)`; up when `close>=open`; wick `(x,y(high),x,y(low))`; ohlc ticks `±w/2`; candle body `rects (x-w/2, min(yO,yC), w, Math.max(1,|yO-yC|))`. Emit in order upLines, downLines, upRects, downRects with `s.upColor ?? theme.up` and `s.downColor ?? theme.down`.
     - **volume histogram** (`aggregateVolumeSeries`, `:37-40`): `baseline=y(0)`; rects `(x-w/2, min(baseline,y(vol)), w, max(1,|baseline-y(vol)|))` in `s.color`.
     - **line/area/histogram LOD** (`:41-63`):
       - `o=offset`; `sf`/`st` as in axisRange; `count = Math.min(st-sf, Math.max(1, Math.floor(plotW)))`; `gaps = index.hasGaps(sf,st)`.
       - Bucket k: `a = sf+floor(k*(st-sf)/count)`, `b = sf+floor((k+1)*(st-sf)/count)`, `end = min(b, values.length)`, `finite = gaps ? index.finiteCount(a,end) : end-a`.
       - `finite==0` → flush the path.
       - Mixed bucket: emit per point. `w = Math.max(1, |x(a+1)-x(a)|*.8)`; break the path at non-finite values.
       - Full bucket: `x = x((a+b-1)/2+o)`, `v = values[end-1]`. Histogram: rect width `Math.max(1, plotW/count*.8)`. Line/area: push the point, and if `b-a>1` and `q.max!==q.min`, add a wick line.
       - A path of a single point becomes a `±0.25` px dot line.
       - Emit order: rects, then paths, then lines.
       - Gaps are never bridged.
       - If external values are shorter than the store (append after `setSeriesValues`), `finiteCount` throws RangeError `Range index bounds` (≥65536 values: `Block index bounds`). Measured; D9.
   - **Panel title**, when `bottom-top >= H+8`: a mask box (`w=labelBounds[2]+8`, `h=H+8`, `theme.background`) followed by the label `panelTitle(model,p)`, after the series.
4. **Time labels** (`:68-73`):
   - `timeClip=[P0.left, max(P0.bottom+4, h-H-8), tw, min(H+8, h-P0.bottom-4)]`; only when `timeClip[3] >= H`.
   - `valueAt(f) = timeFormatter ? timeFormatter(t) : new Date(t).toISOString().slice(5,16).replace('T',' ')` with `t = timeAtIndex(from+(to-from)*f)`.
   - `maxW` = the larger label width of `f=0` and `f=1`; `count = max(1, min(5, floor((tw+4)/(maxW+4))))`; `f = count===1 ? .5 : j/(count-1)`.
   - `x = max(P0.left, min(P0.right-w, P0.left+tw*f-w/2))`. Skip a label if `x < lastRight+4`. Assign `c.x` and `labelBounds[0]` in place, keeping key positions.
   - The formatter is called `2+count` times.
5. Then drawings (§3.11.5), then the crosshair.

#### 3.11.3 Labels (`labels.mjs:3-23`)
- **`labelMetrics(font)`**: `size = Number(String(font).match(/([0-9.]+)px/)?.[1] ?? 12)`; `ascent=size*1.12`, `descent=size*.38`, `height=size*1.5`. At 12 px: 13.440000000000001 / 4.5600000000000005 / 18. Malformed `'1.2.3px'` gives NaN, and NaN propagates through the JS `Math.max/min`.
- **`labelWidth(value, m)`**: iterate code points, `units += code>127 ? 1.2 : 'MW@%'.includes(c) ? .98 : .74`; return `units*size` once at the end.
- **`fitLabel(value, maxWidth, m)`**:
  1. `fullText = String(value)`; `singleLine = fullText.replace(/\s/g,' ')` (JS `\s`).
  2. `!(maxWidth>0)` → null.
  3. Fits → `{text:singleLine, fullText, width}`.
  4. Otherwise, if even `…` (U+2026, 1.2 units) does not fit → null.
  5. Otherwise accumulate code points while `(width+next)+endWidth <= maxWidth`, summing `unit*size` per char (a different rounding from the full width: `'109.55'` gives 53.28 as a whole but 53.27999999999999 per char) → `{text:text+'…', fullText, width:width+endWidth}`.
- **`labelCommand(value, x, y, maxWidth, font, color, clip, metadata)`** → `{op:'text', x, y, text, fullText, font, color, clip, labelBounds:[x, y-ascent, width, height], ...metadata}`, or null.
- **`panelTitle(model, p)`** = `[p.label ?? p.id, ...new Set(visible series (s.label ?? s.indicator), falsy dropped)].join(' · ')` (U+00B7).

#### 3.11.4 `formatAxisValue(model, axis, value)` (`scene-parts.mjs:9-15`)
- `precision = axis.precision ?? (percent ? 2 : model.precision)`.
- Priority:
  1. `axis.formatter` (J) → `boundedText(String(out),256,'Axis formatter output',true)`;
  2. if `axisId==null && scale!=='percent' && model.priceFormatter && axis.id==='price'` → `boundedText(String(priceFormatter(value)),256,'Price formatter output',true)`;
  3. otherwise `(prefix??'') + (tickFormat==='scientific' ? n.toExponential(precision) : n.toFixed(precision)) + (percent ? '%' : '') + (suffix??'')`, with `n = percent ? axis.transform(value) : value`.
- The symbol price formatter therefore applies only to the default axis of a panel whose id is exactly `'price'`, and it ignores the panel precision.

#### 3.11.5 Drawings, crosshair, readout (`scene-parts.mjs:21-59`)
- **`createDrawingCommands(model, layout)`**: items in z-order.
  - Skip a drawing that is hidden, unbound, or whose screen points are non-finite (all 4 for position drawings, else points 0 and 1).
  - Text commands become `{...c, font: style.font ?? theme.font}`.
  - A selected drawing adds 8×8 handle boxes at every point: `{op:'box', x:q.x-4, y:q.y-4, w:8, h:8, fill: locked ? theme.text : theme.background, color, width:1, clip}`.
  - Points from index 2 on are not checked. A non-finite third point therefore yields NaN handles: `null` in JSON, and `TypeError 'Native packet finite geometry'` in the packet.
- **`createCrosshairCommands(model, layout)`**:
  1. No crosshair or an empty store → `[]`. `snap = resolveCrosshairSnapshot(...)`; null → `[]`.
  2. A vertical dashed line on every panel, then the horizontal line on the hovered panel: `{op:'lines', …, color:theme.crosshair, width:1, clip:null, dash:[4,4]}`.
  3. `bg = portableColor(theme.background).slice(0,7)+'ff'`. This is evaluated always and can throw for a non-portable background set through the raw `nativeTheme`.
  4. If the panel is tall enough, each visible axis gets a mask box and a `crosshair-price` label at `top = max(top+4, min(bottom-H-4, y-H/2))` with `maxWidth = (axisRight-axisLeft)-8`.
- **`crosshairValuesAt(model, layout)`** (`:55-59`):
  - Returns null without a crosshair, with an empty store, without a snapshot, or with an out-of-range index.
  - `index = snapped ? snapshot.index : Math.round(layout.index(c.x))` (JS round).
  - Returns `{index, time, primary:{symbolId: model.symbol?.id ?? null, bar: store.at(index)}, series:[visible series in all panels → {id, label: s.label ?? s.id, symbolId: values ? (s.symbolId ?? null) : (model.symbol?.id ?? null), panel, axisId: axisId ?? null, value: finite ? v : null, sourceIndex: index-offset, sourceTime: finite ? time[src] : null}], axes:[all axes of the hovered panel, hidden ones included → {id: axisId, panel, value, formatted}]}`.
  - An array shorter than the source index gives `null` (no throw).

#### 3.11.6 Crosshair snap and OHLC snap
- **`crosshairSnapOptions(model, o)`** (`crosshair-snap.mjs:7-13`):
  - `optionRecord(['mode','target'],'Crosshair snap')`;
  - `mode ∉ {free, close, ohlc}` → TypeError `Crosshair snap mode: free, close or ohlc required`;
  - a target goes through `optionRecord(['panel','axisId','seriesId'],'Crosshair snap target')` and `identifier(panel,'Crosshair snap panel')`, with `axisId` inferred from `seriesId`, then `validateDrawingBinding`;
  - returns frozen `{mode, target: frozen {panel, axisId|null, seriesId|null} | null}`.
- **Pointer intent**: every finite `move` creates a fresh cursor object recorded with `{model, owner, options, x, y}`. An explicitly assigned or mutated cursor resolves as `free`.
- **`resolveCrosshairSnapshot(model, layout)`** (`:27-35`):
  - The cursor must lie inside a panel's plot rectangle (inclusive), else null.
  - Base result: `{mode, raw:{x,y}, resolved:{x,y}, panel, snapped:false, reason: mode==='free' ? 'free' : 'no-eligible', index:null, time:null, field:null, price:null, axisId:null, seriesId:null, storeVersion:null}`.
  - A successful snap replaces `resolved` and sets `snapped:true, reason:'snapped'`, index, time, field, price, axisId, seriesId, `storeVersion`.
- **`crosshairAxisPrice(s, a)`** = `s.snapped && s.axisId===(a.axisId??null) ? s.price : a.price(s.resolved.y)`.
- **`nearestVisibleOHLC(model, layout, x, y, target, fields=['open','high','low','close'])`** (`ohlc-snap.mjs:2-17`):
  - Requires the axis, a non-empty store, and the cursor inside the axis rectangle.
  - Eligible series: visible, same panel and axis, candles/ohlc, offset 0, no indicator/values/source/symbolId (a specific `seriesId` if given).
  - `first=max(0,ceil(view.from))`, `last=min(N-1,floor(view.to))`.
  - `a=clamp(floor(index(x)))`, `b=clamp(ceil(…))`; pick `a` if `|x-x(a)| <= |x-x(b)|`.
  - The field with strictly minimal `|y(v)-y|` wins (ties go to the earlier field).
  - Returns `{index, time, price (raw), field, x, y, axisId, seriesId}`.

#### 3.11.7 `SceneCache` and the frame protocol (`frame-cache.mjs`, B:193-203)
- **`staticState(model,w,h)`**, the base invalidation key compared with `Object.is` element-wise (NaN equals NaN, `+0≠-0`), in this order:
  - `[w, h, store(identity), version, length, timeVersion, view.from, view.to, axisWidth, precision, priceFormatter(identity), timeFormatter(identity)]`;
  - `theme.background, grid, text, up, down, font` (**not** crosshair);
  - `panels.length`, then per panel `(id, weight, scale, inverted, padding, range?.[0], range?.[1], base, precision, label, formatter, axisVisible, axisSide)`;
  - `axes.length`, then per axis `(id, panel, side, scale, inverted, padding, range0, range1, base, precision, tickFormat, prefix, suffix, label, visible, width, formatter)`;
  - `series.length`, then per series `(id, type, panel, visible, offset, values(identity), source, indicator, output, color, upColor, downColor, fill, width, baseline, dirtyFrom, axisId, symbolId, label, entry(identity), entry.def(identity), entry.revision, entry.dirty, entry.length)`.
  - In Rust, model identity fields as generation counters.
- **`frame(model,w,h,{forceBase})`**:
  - `baseChanged = forceBase || !same(state, next)`. A changed base is rebuilt with `buildScene(…, {crosshair:false, drawings:false})`.
  - `drawingsChanged = baseChanged || selected changed || items differ by element identity`; the drawings are recomputed (`[]` on an empty store).
  - `hover` is recomputed every frame.
  - `scene = {...base, commands: base+drawings+hover, stats:{...base.stats, commandCount}}`.
  - Commit only after success: `state = staticState(...)` recomputed **after** the build (seriesData and indicator calculation mutate the inputs), `items.slice()`, `selected`, `drawingCommands`.
  - Returns `{scene, base, drawings: {...base, commands}, hover: {...base, commands}, baseChanged, drawingsChanged}`.
- **`nativeRenderFrame(token,w,h,force)`** (B:194):
  1. `token` not a string of length 1..128 → TypeError `Native frame token`.
  2. A new token while 64 caches exist → RangeError `Native frame cache count`. A new token registers before computing, so a failed frame still occupies a slot.
  3. `nativeSize={width,height}`.
  4. Record the latest layout.
  5. Returns `{width, height, background, base: baseChanged ? base : null, drawings: drawingsChanged ? drawings : null, hover, stats: scene.stats}`.
  - Every layer repeats `width/height/background/layout/stats`, and the layers' `stats` are `base.stats`; only the top-level `stats.commandCount` is the total.
  - `force` and the first frame guarantee non-null base and drawings.
  - JSON and packet paths share the cache map, so the first transport to read a token consumes its dirty flags.

#### 3.11.8 F64 display packet `packNativeCommands(layers, {mode, width, height, background, stats})` (N:13-56)
- **Layers**: `scene` mode takes `[scene]`; `frame` mode takes `[base|null, drawings|null, hover]`. `null` means unchanged (reuse the bitmap); `{commands:0}` means an explicit empty layer.
- **Validation**:
  - mode, layer count, or a null last layer → TypeError `Native packet mode/layers`;
  - `width`/`height` must be finite (`Native packet finite width/height`); `background` must be a string (`Native packet background string`).
- **Pass 1**, per layer and command:
  - commands must be an array (`Native packet commands array`); the running total of commands must stay ≤ 65536 (`Native packet command limit`, checked on layer entry);
  - op must be an own-property op name (`Native packet unsupported operation`); op codes: lines 1, rects 2, path 3, box 4, ellipse 5, text 6;
  - `color = string(c.color)`; `stroke = finite(c.width ?? 1)` ≥ 0 (`Native packet stroke`);
  - clip: null/undefined → flag 0 and `[0,0,0,0]`; otherwise an Array or Float64Array of exactly 4 finite numbers (`Native packet clip arity`);
  - dash: null → `[]`; otherwise a non-empty even-length Array or Float64Array (`Native packet dash arity`);
  - fill: null → -1, else a string index;
  - baseline: only for op 3 with a fill, `finite(c.baseline)`, else 0;
  - text and font: only for op 6 (font default `'12px monospace'`), else -1;
  - geometry: op 1–2 `coords` (length %4==0), op 3 `points` (%2==0), op 4–5 `[x,y,w,h]`, op 6 `[x,y]` (`Native packet geometry arity`);
  - `recordLength = 15 + dash + geometry`; total numbers ≤ 8388608 (`Native packet number limit`).
- **String dictionary**: first-appearance order per command (color → fill → text → font), ≤ 65536 entries (`Native packet string limit`). The UTF-8 byte sum of unique strings must be ≤ 1048576 (`Native packet metadata byte limit`). UTF-8 counting walks UTF-16 units: <128 → 1, <2048 → 2, a valid pair → 4, anything else (lone surrogates included) → 3.
- **Metadata** = `JSON.stringify({schema:'aster.native.commands', version:1, mode, width, height, background, stats, strings, layers:[{commands:n}|null]})`, ≤ 1048576 UTF-8 bytes.
- **Pass 2** writes a `Float64Array(total)`. Per record, 15 header values: `[op, recordLength, colorIndex, stroke, clipFlag, clipX, clipY, clipW, clipH, dashCount, fillIndex, baseline, textIndex, fontIndex, geometryCount]`, then dash values (finite and > 0, else `Native packet positive dash`; non-finite → `Native packet finite dash`), then geometry (finite, else `Native packet finite geometry`). A cursor mismatch → TypeError `Native packet geometry changed during encoding`.
- Values keep raw f64 bits (`-0`, `1e12+2^-13`).
- Goldens:
  - empty scene: strings `['#8093ad','No data','12px monospace']`, numbers `[6,17,0,1,0,0,0,0,0,0,-1,0,1,2,2,540,350]`;
  - test header `[1,25,0,2,1,-0,2,3,4,2,-1,0,-1,-1,8]`;
  - a second frame call gives layers `[null,null,{commands:5}]`.
- Label metadata (`fullText`, `labelBounds`, `role`, `panelId`, `axisId`) is not carried in packets. The Java decoder (`BaroChartEngine.java:82-117`) re-validates every invariant.

---

### 3.12 Interaction (`interaction.mjs`)

#### 3.12.1 State
- Fields, in creation order: `model, size(cb), invalidate(cb), pointers: Map<id,{x,y}>` (insertion order, at most 2), `tool:'select'`, `gesture:null`, `text:'Note'`, `drawingTarget:null`, `_drawingMagnet: frozen {mode:'off', radiusPx:8}`, `_crosshairSnap: frozen {mode:'free', target:null}`, `_crosshairOwner:{}`, `_crosshairPointer:null`.
- **Gestures**:
  - `pan {kind, startX, view, follow, pixelWidth, viewport}`;
  - `pinch {kind, distance, view, follow, midpoint, viewport}`;
  - `wait {kind:'wait'[, staleViewport:true]}`;
  - `create {kind, transaction, id, panel, axisId, seriesId, type, projection, lastX, lastY, moved}`;
  - `edit {kind, transaction, id, handle, startX, startY, screenPoints, points, panel, axisId, seriesId, type, projection}`.
- **Fingerprints**:
  - viewport `{store, identity: geometryIdentity, timeVersion, from, to, follow}` (`from/to` compared with `Object.is`);
  - projection: 13 elements `[axis.left, right, top, bottom, min, max, scale, inverted, base, view.from, view.to, geometryIdentity, timeVersion]`, compared with `Object.is` (`:53`).
- Transaction identity is a snapshot array; in Rust, use a TxnId. A gesture-identity check after layout calls needs a generation counter.

#### 3.12.2 Guard
`interactionActive` (`:9-16`) runs first in every public method and at three points inside `layout()`:
- `Actual interaction controller required` (TypeError, X);
- `Interaction controller own model required` (TypeError, X);
- owner token inactive → Error `Chart disposed`;
- model replaced → StaleSourceError `Interaction controller owner changed` (X);
- model disposed → Error `Chart disposed`.

#### 3.12.3 `down(id, x, y, hitTolerance=8)` (`:56-82`)
1. Guard.
2. Tolerance non-finite or outside `[1,32]` → RangeError `Pointer hit tolerance must be 1..32 logical pixels`. Checked before the coordinate check, so `down(1,NaN,NaN,0)` throws.
3. Non-finite x or y → return silently.
4. Stale viewport handling (`stopStaleViewport`).
5. Two pointers already and a new id → return.
6. `pointers.set` (an existing id keeps its position).
7. A stale gesture → `invalidate()` and return.
8. **Second pointer** → pinch: cancel the own drawing transaction; `distance = Math.hypot(b-a)||1`, `midpoint=(a.x+b.x)/2`; `invalidate()`.
9. Otherwise `layout()` (the size callback runs once). No panel contains the point → `gesture=null` and return; the pointer stays and nothing is invalidated.
10. **Create** (tool ≠ select):
    - `target = drawingTarget ?? {panel:p.id}`; a different panel → return; `validateDrawingBinding(target)`;
    - `point = magnet(...)`; position drawings call `initialPositionPoints`, and null → return;
    - `beginDrawing`: `begin()` (outside try; `A drawing transaction is already active` propagates); `add({type, ...target, panel:p.id, points, [text:this.text]})`; create gesture. On throw, cancel the own transaction.
11. **Select**: `hit = drawingHitTest(...)`; `selected = hit?.id ?? null` (outside any transaction, so not undoable). An unlocked hit starts an edit transaction; otherwise a pan gesture.
12. `invalidate('drawings')`.

Partial effects survive exceptions: `pointers.set` and the selection change. The bridge's catch-all `cancel()` cleans them up.

#### 3.12.4 `move(id,x,y)`, `up(id)`, `cancel(opts)`, `wheel` (`:83-127`)
- **`move`**:
  1. Guard; non-finite → return.
  2. Stale drawing (transaction replaced) → `gesture=null`, pointers cleared, `invalidate('drawings')`.
  3. Stale viewport handling.
  4. **Record the crosshair**: a new cursor plus the snap intent, on every finite move, during gestures too.
  5. An untracked id → `invalidate('hover')`.
  6. Update the pointer; no gesture → return.
- **pinch**: needs 2 pointers; `layout()`; `p=layout.panels[0]`; `span=g.view.to-g.view.from`; `factor=g.distance/(hypot(b-a)||1)`; `anchor=clamp01((g.midpoint-p.left)/(p.right-p.left))`; `at=g.view.from+span*anchor`; `delta=((((a.x+b.x)/2)-g.midpoint)/(p.right-p.left))*span*factor`; `setVisibleRange((at-((span*factor)*anchor))-delta, (at+((span*factor)*(1-anchor)))-delta)`. Always relative to the pinch start.
- **pan**: `delta=((g.startX-x)/g.pixelWidth)*(g.view.to-g.view.from)`; `setVisibleRange(from+delta, to+delta)`. No relayout, so a resize is not reflected.
- **create/edit validation**:
  - `layout()`; the drawing must still exist, be unlocked, visible and in a transaction, with the same panel/axis/series/type and a live `drawingAxis`;
  - the projection must equal the stored fingerprint;
  - otherwise a full `cancel()`, which rolls back. Keyboard zoom, Home/End, appends and autoscale changes mid-gesture therefore roll back the gesture.
- **create point update**:
  - default: `points = len===1 ? [point] : [points[0], point]`;
  - position: `points[2].price = point.price; points[3].time = point.time`; an invalid result → `invalidate('hover')` and the last valid geometry stays;
  - freehand: skip if `Math.hypot(Δ) < 1` or there are ≥2048 points; the first move replaces point 2, later moves append;
  - 3-point tools: the third point is `fromScreen(anchor.x, anchor.y+40)`, where the anchor is the raw pointer unless the point was magnet-snapped.
- **edit**:
  - position handles → `positionHandlePoints`;
  - handle `i` → replaces point `i`;
  - body drag → `fromScreen(sp.x + x - startX, …)`, i.e. `(screenX+x)-startX` from the start snapshot;
  - the magnet applies to create and handle drags only.
- **Epilogue**: refresh the viewport fingerprint; `invalidate(pan|pinch ? 'all' : 'drawings')`.
- **`up(id)`**:
  1. Stale drawing → as in move.
  2. Stale viewport handling; an untracked id → return.
  3. Delete the pointer.
  4. A stale wait clears the gesture when no pointers remain. Pinch with pointers left → `wait`, else `null`. Create/edit → `drawings.commit()` (one undo entry; taps commit degenerate drawings).
  5. `invalidate()`.
- **`cancel({notify=true, ownedDrawingsOnly=false})`**:
  - by default `drawings.cancel()` for **any** transaction;
  - with a current viewport, restore `model.view = {...g.view}` and `follow` directly (unclamped);
  - `gesture=null`; `pointers.clear()`; `invalidate()` when notifying.
- **`wheel(delta, x)`**: no gesture → `zoom(Math.exp(Math.max(-1, Math.min(1, delta*.001))), (x-p.left)/(p.right-p.left))` with `p` = panel 0; `invalidate()`. NaN delta → `Zoom factor`; NaN x → `Visible range`.

#### 3.12.5 `key(key, {ctrl=false, shift=false})` (`:128-145`)
1. Clear a hidden selection (for every key).
2. `undo = ctrl && key.toLowerCase()==='z' && !shift`; `redo = ctrl && ('y' || ('z' && shift))`; `deleting = key ∈ {Delete, Backspace}`. A non-string key with `ctrl` throws an engine TypeError.
3. By key:
   - `Escape`: `cancel()`, `selected=null`, `crosshair=null`.
   - `PageUp/PageDown`: `cancel()`, then cycle the visible drawings in z-order. With no selection, PageUp picks the last and PageDown the first; otherwise `(at±1+len)%len`.
   - Arrows: cancel any gesture.
     - A selected, unlocked, bound drawing with no `ctrl` is nudged by 1 px (10 with shift) in screen space via `toScreen → ± → fromScreen`. Position drawings must stay valid.
     - With no selection or with `ctrl`: Left/Right `pan(±(to-from)*.1)`; Up/Down `zoom(.9 / 1.1)`.
     - A locked or orphaned selection with no `ctrl` does nothing.
   - `'+'`, `'='` → `zoom(.8)`; `'-'`, `'_'` → `zoom(1.25)` (no cancel).
   - `Home` → `fit()`; `End` → `setVisibleRange(L-200.5, L-.5)` (ignores the forward offset).
   - undo/redo/delete:
     - `active = !!gesture`; `sel = selected` is captured **before** the cancel; `active → cancel()`;
     - undo only when there was no gesture (so undo during a gesture only cancels it); redo always runs after the cancel;
     - delete → `drawings.remove(sel)`. A locked drawing gives false; deleting during create removes nothing, because the cancel already removed the new drawing.
4. Always `invalidate()` at the end.

`ChartAPI.undo/redo` route through `key('z',{ctrl:true[,shift:true]})` (`api.mjs:269-270`), so they inherit these semantics.

#### 3.12.6 Setters
- **`setTool(tool)`** (`:54`): `tool !== 'select' && !DRAWING_TYPES.includes(tool)` → Error `Unknown drawing tool`. Then a **global** cancel (even for the same tool), set, invalidate.
- **`setDrawingTarget(t)`** (`:55`):
  - `t !== null` → `optionRecord(['panel','axisId','seriesId'],'Drawing target')`; `next={panel:'price',...t}` (panel first); `identifier(panel,'Drawing target panel')`;
  - `seriesId` set with `axisId===undefined` → infer the axis (key appended last);
  - `validateDrawingBinding`; cancel; store a new object.
  - `undefined` → `Drawing target: object required`.
- **`setDrawingMagnet({mode, radiusPx=8})`** (`:48`): `optionRecord`; `mode ∉ {off, weak, strong}` → TypeError `Drawing magnet mode: off, weak or strong required`; `radiusPx` finite in `[1,32]` (non-integers allowed) → RangeError `Drawing magnet radius must be 1..32 logical pixels`. Equal values → no-op. Otherwise cancel own transactions only and freeze.
- **`setCrosshairSnap(o)`** (`:50`): `crosshairSnapOptions`; equal mode and target fields → no-op; otherwise store, retarget the current pointer cursor's intent (only if it is still `model.crosshair` with the same x/y), `invalidate('hover')`. No gesture cancel.
- **Magnet** `magnetDrawingPoint` (`:36-42`): `free = fromScreen(...)` is always evaluated first (a missing axis throws `Missing axis`). Mode off, or freehand → free. Otherwise `snap = nearestVisibleOHLC(...)`; none, or weak with `hypot > radiusPx` → free; else `{time: snap.time, price: snap.price}` (raw values).

#### 3.12.7 Invalidation kinds (differential oracle, `undefined` ≠ `'all'`)

| Call | Sequence |
|---|---|
| `setTool`, `setDrawingTarget` | `[undefined]` |
| `setDrawingMagnet` | unchanged `[]`; changed `[undefined]` |
| `setCrosshairSnap` | unchanged `[]`; changed `['hover']` |
| `down` | early return or throw `[]`; stale `[undefined]`; pinch start `[undefined]`; single pointer `['drawings']` |
| `move` | ignored `[]`; stale drawing `['drawings']`; hover `['hover']`; pinch stale `[undefined]`; pan/pinch `['all']`; wait or create/edit `['drawings']`; validation cancel `[undefined]`; invalid position `['hover']` |
| `up` | stale drawing `['drawings']`; untracked `[]`; otherwise `[undefined]` |
| `cancel` | `[undefined]`, or `[]` with `notify:false` |
| `wheel` | during a gesture `[]`; otherwise `[undefined]` |
| `key` | Escape/PageUp/PageDown `[undefined, undefined]`; arrows, undo, redo, delete: 2 calls with a gesture, else 1; any other key `[undefined]` |

The bridge sets no invalidate callback, so these sequences are observable only in web tests. They still pin the control flow.

#### 3.12.8 Host input mapping (for scenario scripts)
- **iOS** (`BaroChartUIView.swift:178-277`):
  - pointer ids increase from 1; tolerance 22; `nativeResize(max(100,w), max(80,h))` before every pointer and key call;
  - up is `['up',id,0,0]`; cancel is `nativeKey('Escape')` or `nativePointer('cancel',0,0,0)` + `nativeHoverExit`;
  - accessibility zoom: `command('zoom',[0.8|1.25])`; accessibility pan: `nativeKey(Arrow, ctrl=true)`;
  - keys: arrows, `+`, `-`, Esc, Backspace, Cmd+Z, Cmd+Shift+Z; delete action `'Delete'`.
- **Android** (`BaroChartView.java:196-225`):
  - pointer id = `pointerId+1`; hover id 0; tolerance 24 (finger) or 8;
  - right after `down`, `nativeGestureKind()`: null cancels and yields the event to the parent; `'edit'`/`'create'` disallow parent interception;
  - a tap sends `move(0, downX, downY)` before `up`;
  - accessibility click: `move(0, w/d*.5, h/d*.35)`.


### 3.13 ChartAPI facade (`api.mjs`) with `study-setup.mjs`

#### 3.13.1 Lifecycle guard and change hook
- **`apiActive(api)`** (`:32-39`):
  1. `Actual ChartAPI required` (TypeError, X).
  2. `Chart API own model required: owner changed` (TypeError, X).
  3. Inactive owner token → Error `Chart disposed`.
  4. Model replaced → StaleSourceError `Chart API owner changed` (X).
  5. Model disposed → Error `Chart disposed`.
  - It runs at the start of `dispatch` and of every command, so a disposal error wins over validation errors.
- **`changed(result)`** (`:78-84`): calls `invalidate()` once and returns `result` unchanged. For an inactive or disposed owner it returns `result` without invalidating and without an error.
- **Constructor** (`:71`): a model whose own `disposed` is truthy, or an owner token with `active===false` → Error `Chart disposed`. Native bridges always pass `{controller}` and never deactivate the token.

#### 3.13.2 Data commands (`:44-64, 86-100`)
- **`snapshotBarsInput(bars, maxBars)`**:
  1. Not an array → TypeError `OHLCV array required`.
  2. `sizeLimit(count, maxBars, 'Bar count')`.
  3. A truthy object element (arrays included) becomes a new object with only the 6 FIELDS; anything else passes through and fails later as `OHLCV object required`.
  - Extra keys are ignored for `setData` and for scalar events (but rejected inside batches).
- **`values(input, prefix)`**:
  - Not a Float64Array or Array → TypeError `Values must be Float64Array or a JSON array`.
  - Every element must be `null` or a number, and in an Array it must not be NaN or ±Infinity → TypeError `Finite numbers or null gaps required` (the whole array is checked, including the tail past `length`).
  - `null` becomes NaN; `-0` is preserved.
  - `columns(input, length)` maps FIELDS in order and ignores extra keys.
- **`setData(bars)`**: apiActive → snapshot → `store.setData` → `changed()` → `null`.
- **`setColumns(data, length)`**: `columns()` → `store.setColumns(next, length)` → `null`. An OHLCV `null` (now NaN) fails as `Every OHLCV field must be finite`.
- **`applyDataEvent(event)`**:
  - `kind==='batch'` → `applyDataEvents(event.events)`, returning the receipt;
  - `reset` → `columns` (truthy) via `setColumns(next, event.length)`, else `setData`;
  - `prepend` → snapshot, then `markets.applyDataEvent`;
  - `append`/`update`/`correction` → `snapshotBarInput(bar)`, then `markets.applyDataEvent` (`Update is only the current bar`, `Correction requires an existing timestamp`);
  - any other kind → `markets.applyDataEvent(store, {kind})` (`Data event kind required` / `Unknown data event`).
  - Then `changed()` and `null`. Only `kind` and the relevant payload field are forwarded.
- **`applyDataEvents(events, options={})`** (`:100`):
  1. Capture the source.
  2. `snapshotDataBatchOptions(options, false)`; only `skipUnchanged` is allowed, and dispatch cannot pass options at all.
  3. `snapshotIngestionEvents(events)` (§3.6.2).
  4. Source changed → IngestionError SOURCE_CHANGED `Owner changed during batch snapshot` (X).
  5. Any append while a series has external `values` → IngestionError EXTERNAL_ALIGNMENT `Length-changing batches require host realignment of external values`.
  6. `store.applyEvents(snapshot, {...limits, ...(session ? policy budgets : {})})`.
  7. `unchanged===true` → return the receipt as is; otherwise `changed(receipt)`.

#### 3.13.3 Panels, axes, targets (facade parts)
- **`setPanel(id, patch)`** (`:112`): a falsy, non-object or array patch → TypeError `Panel patch object`. Then `next={...patch}`; `range:null` and `base:null` become `undefined` (the key keeps its position); then `model.setPanel`. A JSON `__proto__` key survives the spread and fails as `Panel patch: unsupported field __proto__`.
- **`setAxis(id, patch)`** (`:116`): `optionRecord(patch, AXIS_KEYS−{id,panel}, 'Axis patch')` runs **before** the spread; then the same null-to-undefined conversion.
- **`setPanelOrder(ids)`** (`:113`): returns a boolean; invalidates only when it returns true.
- **`removePanel(id)`** (`:114`): when the controller belongs to this model and `drawingTarget.panel===id`, the target is cleared **after** the removal succeeds, by assigning `drawingTarget=null` directly (no gesture cancel).
- **`removeAxis(id)`** (`:117-146`): a controller of another model → StaleSourceError `Interaction controller owner changed`. Clears a target whose `axisId===id`.
- **`setDrawingTarget(t)`**, **`setDrawingMagnet(o)`**, **`setTool(t)`**: no controller → Error `Interaction controller required`; then delegate with `{notify:false}` and call `changed()`.
- **`setCrosshairSnap(o)`**: no controller → the same Error; delegate; then call `invalidate('hover')` directly, even if the value did not change.
- **`crosshairSnapshot(w,h)`** and **`crosshairValues(w,h)`**: build a fresh `createLayout` each call, which can calculate dirty studies. They never invalidate.

#### 3.13.4 Series commands
- **`seriesOptions(o)`** (`:153-164`):
  1. `optionRecord(SERIES_KEYS,'Series')`.
  2. `portableStyle` on `color, fill, upColor, downColor` (`fill:null` passes; any other `null` → `Color string required`).
  3. `values` → `values()`.
  4. `source ∉ FIELDS` → TypeError `Unknown column source`.
  5. `width` not a finite number in `(0,50]` → RangeError `Series width`; `baseline` not finite (null included) → RangeError `Series baseline`; `visible` not boolean → TypeError `Series visible`.
  6. `indicator` → `indicators.get()` (computes; `Missing indicator: <id>`); an unknown `output` → Error `Missing indicator output`.
  7. candles/ohlc with indicator, values or source → TypeError `Candles/OHLC read store OHLCV; custom source/values/indicator need a general series`.
- **`addSeries(o)`**: `seriesOptions` → `model.addSeries` → returns the id.
- **`setSeries(id, patch)`** (`:166-192`). Missing id → Error `Missing series`.
  - **Presentation path**, when every own key of a truthy object patch is in `{color, fill, upColor, downColor, width, visible, label}` (the empty patch included):
    - `seriesOptions(patch)`; `label` through `boundedText(256,'Series label')` (empty or null rejected);
    - a bound indicator that vanished → Error `Missing indicator: <indicator>`;
    - `next={...current,...presentation}`, with keys outside SERIES_KEYS and the runtime caches deleted;
    - replace in place (same array, same slot), no normalization, **no computation, caches kept**, then `changed()`.
  - **Full path**:
    1. `next={...current,...seriesOptions(patch)}` (a null patch → `Series: object required`).
    2. Re-check indicator output and candle rules.
    3. A patch that owns `indicator` or `output` resets `next.offset=patch.offset`.
    4. Null `indicator`/`output`/`values` are deleted.
    5. `sameData` = values, indicator and output identical and `(source??'close')` equal.
    6. `validated = normalizedSeries({...next, id})`.
    7. A panel or axis change while a gesture's drawing is bound to this series → `controller.cancel({notify:false})`.
    8. Install `{...validated, id, ...(sameData ? caches : {})}`.
    9. Retarget `drawingTarget` via `setDrawingTarget` if it was bound and moved.
    10. `changed()`.
- **`setSeriesValues(id, values)`**: `values()` (full copy, null → NaN) → model.
- **`removeSeries(id)`**: cancel a gesture whose drawing is bound to this series; clear a target with that `seriesId`; filter (unknown ids are a no-op); `changed()`. Quirk: with `id` omitted, `undefined===undefined` matches drawings and targets that have no seriesId.

#### 3.13.5 Indicator commands
- **`addIndicator(id, name, params={})`** (`:195-206`):
  1. `validateIndicatorParams(params)`; `requested={...params}` (JS key order); validate again.
  2. 128 entries → RangeError `Indicator limit`; duplicate → Error `Duplicate indicator id`.
  3. Build a **candidate engine** on the same store (same checkpointSize and maxOutputBytes, copied registry) and run `candidate.add(id, name, requested)`, which computes in full. Errors: `Indicator id: …`, `Unknown indicator: <name>`, `Invalid indicator definition`, factory errors.
  4. Staging stale → StaleSourceError `Indicator owner changed during staging` (X).
  5. Budget: Σ live outputs + new outputs, ×capacity×8, > maxOutputBytes → RangeError `Indicator output byte limit`.
  6. Move the entry object into the live map.
  7. Return `changed({outputs: Object.keys(data.outputs), plotOffsets:{...}})`. On failure the live engine is untouched.
- **`removeIndicator(id)`** (`:209-230`):
  1. Missing → Error `Missing indicator: ${String(id)}` (JS ToString: `5→'5'`, `{}`→`'[object Object]'`, omitted → `'undefined'`).
  2. Cancel a gesture whose drawing is bound to a removed series; clear a target bound to one.
  3. Drop the bound series, then `engine.remove(id)` (retires any native checkpoint ledger).
  4. `changed()`. **No calculation.**
- **`indicatorValues(id, output?)`**: `get` (computes; `Missing indicator: <id>`) → key `output ?? first` → not an own output → Error `Missing indicator output` → `Array.from(values, v => isFinite(v) ? v : null)`. No portability check.
- **`indicatorValueAt(id, output, index, options={})`** (`:232-242`):
  1. `optionRecord(options, ['mode','asOfIndex'], 'Indicator query')`.
  2. `mode = options.mode ?? 'raw'`, `asOf = options.asOfIndex ?? n-1`. A mode other than `raw`/`plot`, a non-safe-int `index`, or `asOf` outside `[-1, n-1]` → RangeError `Indicator query index/mode`.
  3. Missing → Error `Missing indicator` (no id suffix).
  4. `requirePortableFactory`: custom factories → `UnsupportedIndicatorError`.
  5. A linked module with `causal!==true` → TypeError `Unsupported noncausal study query` (unreachable).
  6. `get(id)`; key; Error `Missing indicator output`.
  7. `src = index - (plot && own offset ? offset : 0)`. `src<0`, `src>=length` or `src>asOf` → `{value:null, sourceIndex:null, sourceTime:null}`; otherwise `{value: finite ? v : null, sourceIndex: src, sourceTime: time[src]}`.
  - An empty store allows `asOf=-1`, so every query returns the null triple. Never invalidates.

#### 3.13.6 Study setup (`study-setup.mjs`)
- **`setIndicatorParams(id, params)`**, the typed path through `api.mjs:207`:
  1. `apiActive`; `validateIndicatorParams` twice (on the original, then on a JS-ordered copy).
  2. `setStudyParams(model, id, requested, guard)` (`study-setup.mjs:23-49`):
     1. Missing entry → Error `Missing indicator`. There is **no** id type check; params errors take precedence.
     2. **No-op**: same key count and `Object.is` per key, order ignored (`-0` differs from `0`). Returns `{outputs:[...def.outputs], plotOffsets:{...def.plotOffsets}}` from the current def without calling the factory or recomputing. The params object and its stored key order are kept, entry identity is kept, async captures stay valid. `changed()` still runs, so hosts still notify.
     3. Otherwise build a candidate engine sharing the other live entries, minus `id`, and call `candidate.add(id, name, {...requested})`. This computes in full; factory, budget and calculation errors surface here. The budget is checked **before** the schema.
     4. A factory that mutated the params → TypeError `Indicator factory changed requested params` (X).
     5. Output names differ in order or content → TypeError `Indicator parameter update cannot change output schema`.
     6. The effective offset (own key value, else 0) per old output differs by `Object.is` → TypeError `Indicator parameter update cannot change plot offsets`.
     7. **Commit**: `entries.set(id, replacement)` at the same position (`NativeCheckpointEntries` disposes and refunds the old map); `retireNativeEntryIfReplaced`; every series bound to `id` gets `rangeIndex=null; revision=undefined; dirtyFrom=0`.
     8. Return the new def metadata.
  - Built-in triggers for steps 5 and 6: vwap `deviation` presence toggles 1↔5 outputs (schema); ichimoku `displacement` changes, including 0↔-0 (offsets); pressure `shift` changes and 0↔-0 (offsets).
  - The replacement entry equals a fresh `add`: `revision 1` when n>0 (or 0 with `invalidated:true` when n=0), checkpoints `{0,256,…}`.
- **`saveStudies()`** (tier A, `:11-20`):
  1. Disposed check.
  2. Per entry (Map order): `requirePortableFactory`; `validateIndicatorParams`; `{id, name, params:{...params}, module?}`.
  3. Series with a truthy `indicator`, picked in SERIES_KEYS order without `values` (`studyPick` drops `undefined`, keeps `null`). Colors are validated with `portableStyle(…,true)` but the original values are written.
  4. `safeCheckpointStringify({schema:'aster.studies', version:1, indicators, series})`.
- **`loadStudies(text)`** (tier A, `:52-71`): an atomic additive import.
  1. `safeCheckpointParse` → `optionRecord(…,'Study setup')`.
  2. Bad schema/version/arrays or counts over 128/256 → TypeError `Study setup schema/count`; with existing items over the limits → RangeError `Study setup capacity`.
  3. A candidate engine. Per study: `optionRecord(…,'Study definition')`, params validation, `Duplicate study id` (Error), `requirePortableFactory`, a module mismatch (TypeError `Study module version/codec mismatch`), `candidate.add`.
  4. Per series: `optionRecord(…,'Study series')`; it must reference an imported indicator (Error `Study series requires an imported indicator`); `Duplicate study series id` (Error); `proxy.normalizedSeries(portableStyle(s,colors,true))`.
  5. Commit and return `{indicators, series}`. `model.series` becomes a new array.

#### 3.13.7 Drawing commands
- **`drawingOptions(o)`** (`:253`):
  1. `optionRecord(10 keys, 'Drawing')`.
  2. A truthy `style` → `optionRecord(['color','fill','width','font'],'Drawing style')`, then `portableStyle(style,['color','fill'])`. Colors become `#rrggbbaa`; `fill:null` passes here and is rejected later by `validateDrawing`; the font is trimmed.
  3. `seriesId` set with `axisId===undefined` and the series exists → append `axisId = s.axisId ?? null`.
- **`drawingMutationContext()`** (`:254`): `interactive = !!controller.gesture`. `items` = the committed snapshot when interactive with a transaction, else `items`. `beforeMutation` cancels the gesture (`notify:false`) only after validation passed.
- **`addDrawing(o)`** (`:255`): `next={panel:'price',...drawingOptions(o)}` → `validateDrawingBinding(next)` (**before** `validateDrawing`) → `store.add(next, ctx)` → id.
- **`editDrawing(id, patch)`** (`:264`): the id must be in the committed items, else Error `Missing committed drawing` (checked **before** the patch) → `drawingOptions(patch)` (label `'Drawing'`; `id` passes here and is rejected by `store.edit` as `Drawing patch: unsupported field id`) → `validateDrawingBinding({...prev,...next})` → `store.edit`. A no-op edit still cancels an active gesture.
- **`deleteDrawing(id = drawings.selected)`** (`:265`):
  - the default applies only when `id` is `undefined` and is evaluated before `apiActive`;
  - a create gesture for an uncommitted id → cancel and `changed(false)` → `false`;
  - otherwise `store.remove(id, ctx)`: missing or locked → `false`, no throw;
  - always invalidates.
- **`deleteDrawings(ids)`**: the group-edit delete (§3.10.6). A missing id → Error `Missing drawing`; a locked drawing → Error `Drawing is locked`. Typed `deleteDrawings(ids:)` returns `changed` (Swift `.javaScript 'Delete receipt has no changed count.'` if the key is absent; Java `getInt` → JSONException).
- **`selectDrawing(id)`** (`:266`): `id!==null` with no visible drawing of that id (including `undefined`) → Error `Missing or hidden drawing`. A different id cancels the gesture first. Set, `changed()`.
- **`saveDrawings()`**: `store.save()`. Hosts use `nativeSave` (§1.2).
- **`loadDrawings(text)`**: §3.10.5 with the API decoders (`styleDecoder = portableStyle(s,['color','fill'],true)`, `validatePanel`, `validateBinding = model.validateDrawingBinding`). It does not cancel gestures.
- **`setText(text)`** (`:272`): no controller, not a string, or longer than 2000 → TypeError `Drawing text, at most 2000 characters` (the empty string is allowed).
- **`positionMetrics(id)`**: not found or not a position drawing → TypeError `Position drawing required` (hidden drawings are included).
- **`undo()`/`redo()`**: with a controller, `key('z',{ctrl:true[,shift:true]})`; otherwise `store.undo()/redo()`. Always `changed()` and `null`.

#### 3.13.8 Theme, symbol, view
- **`setTheme(patch)`** (`:273`):
  1. `optionRecord(THEME_KEYS,'Theme')`.
  2. `portableStyle(patch, [background, grid, text, up, down, crosshair])`: `null` → `Color string required`; font → `portableFont`.
  3. `theme={...theme,...next}`, so existing key positions stay.
  - Untouched keys keep their 6-digit defaults, so a partial theme mixes `#rrggbb` and `#rrggbbaa` strings.
- **`setSymbol(s)`** (`:274-279`):
  1. `validateSymbol`, then `zonedParts(0, tz)`.
  2. `model.symbol = frozen copy` (extra keys and the original timezone spelling kept); `precision = priceDecimals`.
  3. `priceFormatter = p => p.toFixed(priceDecimals)`.
  4. `timeFormatter = t => `${y}-${m}-${d} ${h}:${mi}`` from `zonedParts` (seconds dropped; Android `%04d` years).
  5. `rememberSymbolFormatters`, `changed()`.
- **`setVisibleRange`**, **`fit`**, **`zoom`**, **`pan`**: delegate to the model (§3.9.4) and call `changed()`.

#### 3.13.9 `inspect()` (`:284`)
`JSON.parse(JSON.stringify({view, theme, panels, axes, drawingTarget: controller?.drawingTarget ?? null, series: series.map(({rangeIndex, values, revision, dirtyFrom, ...s}) => ({...s, ...(values ? {valueCount: values.length} : {})})), symbol, storedBars, lastBar: length ? store.at(length-1) : null, drawings: items, selected, tool: controller?.tool ?? null, pointers: controller?.pointers.size ?? 0, gesture: controller?.gesture?.kind ?? null}))`.
- Key order: `view, theme, panels, axes, drawingTarget, series, symbol (omitted when undefined), storedBars, lastBar, drawings, selected, tool, pointers, gesture`.
- The JSON round trip drops `undefined` and functions, turns NaN into `null` and `-0` into `0`.
- Typed `visibleRange()` reads `view.from/to` (Swift `as? Double`, else `.javaScript 'Chart state has no visible range.'`).

#### 3.13.10 Host notification rules (implemented in Swift/Java, independent of the backend)
- `BaroChartEngine.swift:1612-1675`, `BaroChartEngine.java:213-253`.
- **Read-only ops** (no notify): `inspect, indicatorValues, indicatorValueAt, saveStudies, saveDrawings, positionMetrics, crosshairValues, crosshairSnapshot, dataAt, dataIngestionStats, saveDataIngestion`.
- **Receipt-gated ops**:
  - `compactData` notifies iff `removed` is an int in 0..4194304 and > 0;
  - `setPanelOrder` iff it returned `true`;
  - `setIndicatorPlacement` iff `changed` (0..256) > 0;
  - `translateDrawings`/`setDrawingsStyle` iff `changed` (0..128) > 0;
  - `setDrawingVisibility` (≤1) / `setDrawingsVisibility` (≤128) iff > 0;
  - `duplicateDrawing`/`duplicateDrawings` always, after validating `changed` (exactly 1 / 1..128) and `created` rows (exactly the keys `sourceId` and `id`, non-empty, ≤128 UTF-16, distinct, unique), plus a boolean `invalidationFailed`.
- Every other op notifies on success.
- A malformed receipt → Swift `invalidScene`, Java a fixed `JSONException` message. The JS mutation has already happened.
- Direct `call`/`invoke` paths never bump the revision: inputs, scene, `saveWorkspace`, `nativeSave`, exploration. `registerIndicatorSource` notifies explicitly. Async and workspace publication notify once.

---

### 3.14 Workspace document (`workspace.mjs`) and preflight (`native-workspace.mjs`)

#### 3.14.1 Document v1, as written by `saveWorkspace` (key order is part of the byte contract)
```
{schema:'aster.workspace', version:1,
 dataset:{key, revision, adjustmentVersion, priceUnit, adjustment},          // fixed order
 source:{length, firstTime:number|null, lastTime:number|null},
 chart:{panels:[…PANEL_KEYS order, undefined dropped, no formatter],
        axes:[…AXIS_KEYS order, no formatter], theme:{…model order},
        symbol:{…insertion order}|null, formatters:'default'|'symbol',
        precision:int, axisWidth:number, view:{…insertion order}, follow:boolean},
 indicators:[{id, name, params:{…Object.keys order}, module?:{id,version,stateVersion,exportName,causal:true},
              outputs:def.outputs, plotOffsets:def.plotOffsets??{}}],
 series:[…SERIES_KEYS order without values, undefined dropped],
 drawings:{schema:'aster.drawings', version:drawingDocumentVersion(items), drawings:items}}
```
- Reference vector: `test/fixtures/legacy/aster-workspace-v1.json` (1316 chars). Node and vendored QuickJS reproduce it byte for byte.
- Readers accept any key order. Validation walks JS key order, so key order decides which error wins.

#### 3.14.2 Bounded walk and the size estimate (`workspaceWalk`, `:26-31`)
- **Recursion** from depth 0, with shared counters. Per value:
  1. `++nodes > 250000 || depth > 32` → RangeError `Workspace node/depth limit` (primitives count).
  2. Scalars:
     - `null` costs 4; booleans 4/5;
     - numbers must be finite (else TypeError `Workspace finite number`) and cost `String(v).length`, or 21 for `-0`;
     - strings cost 2 plus, per unit: `"` and `\` 2; <0x20 **6**; ASCII 1; <0x800 1 char/2 bytes; a valid pair 2/4; other BMP 1/3. A lone surrogate → TypeError `Workspace Unicode scalar`.
  3. `undefined`, functions, symbols, bigints, cycles → TypeError `Workspace portable data required`.
  4. A prototype other than `Array.prototype`, or other than `Object.prototype`/`null` → TypeError `Workspace plain data`.
  5. Arrays: `Reflect.ownKeys` must be exactly `length+1` with length ≤250000 → TypeError `Workspace array shape`.
  6. Keys: symbols, `__proto__`, `constructor`, `prototype`, `toJSON` → TypeError `Workspace reserved key`; non-enumerable or accessor → `Workspace own data fields`.
  - Each container costs 2, each member 1, and object keys are charged as strings + 1.
- **Cost check**: `cost(c,b)` throws RangeError `Workspace document limit` as soon as chars > 2097152 or bytes > 4194304. The check is incremental.
- **Snapshot**: `copy=true` (`workspaceSnapshot`) builds fresh plain objects and arrays in ownKeys order and preserves `-0`.

#### 3.14.3 `readWorkspaceDocument(text)` and `validateWorkspaceDocument(doc)` (`:34-50`)
- **Read**:
  1. `boundedText(text, 2097152, 'Workspace document', true)` (whitespace padding up to exactly 2097152 passes).
  2. UTF-8 estimate over UTF-16 units: <0x80 → 1, <0x800 → 2, a high surrogate → 4 (skipping the next unit unchecked), anything else → 3. More than 4194304 → RangeError `Workspace document byte limit`.
  3. `safeCheckpointParse`.
  4. `workspaceWalk(copy=false)`.
  5. Validate.
- **Validate**, first failure wins:
  1. Top level: exactly the 8 keys → `Workspace: object required` / `Workspace: plain object required` / `Workspace: unsupported field <key>` / `Workspace missing field`.
  2. `schema==='aster.workspace' && version===1`, else TypeError `Workspace schema/version`.
  3. Dataset: exactly 5 string fields of 1..128 in order → TypeError `Workspace dataset <key>: string limit 128`; `adjustment ∈ {raw, split, total-return}` → TypeError `Workspace adjustment`.
  4. Source:
     - `length` a safe int 0..4194304 → RangeError `Workspace source length: limit 4194304`;
     - `length 0` requires null endpoints → TypeError `Empty workspace endpoints`;
     - otherwise safe-int endpoints with `|t|<=8.64e15`, `last>=first`, `length 1 ⇒ first===last`, `length>1 ⇒ first!==last` → TypeError `Workspace source endpoints`.
  5. Chart record (9 keys), then one combined check → TypeError `Workspace chart configuration`: panels an array of 1..32; axes ≤64; precision an int 0..18 (`-0` passes and is kept); axisWidth finite ≥20 (no max); follow boolean; formatters ∈ {default, symbol}.
  6. View `{from,to}` finite with `to>from`, else RangeError `Workspace view`.
  7. Theme: all 7 keys; `portableStyle(theme, 6 colors, preserveHex=true)`; font via `portableFont`. Nothing is written back.
  8. Symbol:
     - non-null: allowed keys `id, exchange, timezone, currency, volumeUnit, priceDecimals, tickSize, adjustment, provider?, adjustmentVersion?`; strings 1..128 → TypeError `Workspace symbol: string limit 128`; `validateSymbol` (`Invalid symbol metadata`, then the host time-zone error); `currency===dataset.priceUnit && adjustment===dataset.adjustment`, else TypeError `Workspace symbol dataset units/adjustment`;
     - null while `formatters==='symbol'` → TypeError `Workspace symbol formatter metadata`.
  9. `indicators` ≤128 and `series` ≤256, both arrays, else RangeError `Workspace study/series limit` (also when they are not arrays).
  10. Per indicator:
      - record (`module` optional); `identifier` id and name (`Workspace indicator id: …`, `Workspace indicator name: …`);
      - a duplicate id → TypeError `Duplicate workspace indicator`;
      - `validateIndicatorParams`; `validateIndicatorModuleBinding` (TypeError `Indicator module descriptor binding` / `Indicator module descriptor: …`);
      - outputs: 1..32 unique (`Workspace output schema`), each an identifier (`Workspace output: …`);
      - plotOffsets: keys ⊆ outputs, integer values with `|v|<=10000` (`Workspace output offset`).
      - Names are **not** checked against the builtins here; unknown names fail later.
  11. Facade validation through `ChartModel.prototype` methods on a fake model (indicators resolved from the document: `Missing workspace indicator`): panels via `addPanel`, axes via `addAxis`, series via `portableStyle(preserveHex)` then `addSeries`. All model messages apply (§4.7).
  12. Drawings:
      - exactly `{schema, version, drawings}`; `schema==='aster.drawings'`, version ∈1..4, an array → else TypeError `Workspace drawing schema`;
      - more than 10000 → RangeError `Workspace drawing count`;
      - per drawing: `validateDrawing`, `validateDrawingDocumentVersion`, strict `validateDrawingBinding` (no orphans), `portableStyle` check; duplicate ids → TypeError `Duplicate drawing ids`;
      - finally `budget` (`Drawing points/text limit`).
  - The document is never normalized.

#### 3.14.4 `saveWorkspace(chart, binding)` (`:51-60`) and `nativeSaveWorkspace` (B:85)
1. A non-`ChartAPI` → TypeError `Actual ChartAPI required`; a disposed model → Error `Chart disposed`; a gesture, pointers or a transaction → Error `Commit or cancel gestures before saving workspace`; `!hasPortableFormatters` → TypeError `Workspace custom formatters unsupported`; a non-BarStore → TypeError `Actual BarStore required`.
2. Indicators in entries order, through `requirePortableFactory` (`UnsupportedIndicatorError`). **No calculation**: pending studies stay pending.
3. Series that own a non-undefined `values` → TypeError `Workspace external values unsupported`; otherwise picked (accessors → `Workspace accessor: <k>`).
4. Rewrite the binding in canonical order.
5. Snapshot: `firstTime/lastTime` from the columns (`-0` possible → marker); `symbol` with undefined optional keys dropped; `formatters = priceFormatter||timeFormatter ? 'symbol' : 'default'`; `drawings.version` computed.
6. `validateWorkspaceDocument`.
7. `safeCheckpointStringify`.
8. `readWorkspaceDocument(text)`, a full round trip. Some failures only appear here, e.g. params holding a `$asterNumber` key.
9. Model, store, version or columns changed, or a gesture appeared → Error `Workspace owner changed during save` (X).
- **Bridge wrapper**:
  - `api.model!==model` → Error `Workspace native owner mismatch`;
  - after saving, any of `nativeAPI/nativeModel/nativeInput` changed → StaleSourceError `Workspace native owner changed`;
  - no revision bump.

#### 3.14.5 `installWorkspaceConfiguration(model, doc)` (`:61-67`)
1. `new ChartAPI(model)`.
2. Symbol: when not null and `formatters==='symbol'`, `api.setSymbol(symbol)` (rebuilds the formatters, sets precision); otherwise a frozen copy without formatters.
3. `precision = doc.precision` (overrides `priceDecimals`).
4. Add series (the native target passes `[]`).
5. `drawings.items` = frozen copies in document order, colors **not** normalized, `-0` kept. Selection, undo/redo and serial are untouched.
6. `view={...view}`, `follow`.

#### 3.14.6 `nativeWorkspacePreflight(api, text, binding)` (`native-workspace.mjs:10-26`, tier A as a public receipt, also used in restore admission)
1. API, model and store checks (`Actual ChartAPI required`, `Chart disposed`, `Actual BarStore required`).
2. Dimensions: `length` safe int ≤4194304; `capacity` a power of two in `[16, 4194304]` and ≥ length; `version` a safe int. Else RangeError `Workspace source dimensions/version`.
3. Each column an intrinsic Float64Array of length ≥ `length` → TypeError `Workspace source columns`; SharedArrayBuffer → `Shared workspace source`.
4. `binding = workspaceBinding(input)`; `doc = readWorkspaceDocument(text)`; guard (StaleSourceError `Workspace preflight owner/source changed`, X).
5. Binding fields not `===` → TypeError `Workspace dataset binding mismatch`.
6. `doc.source.length`, `firstTime` or `lastTime` (compared `===` with `time[0]` and `time[length-1]`) differ → TypeError `Workspace source extent mismatch`. Interior bars are trusted.
7. A staging engine on a fake empty store, per indicator:
   - `requirePortableFactory`; `staging.add` (factory errors, `Invalid indicator definition`);
   - params changed → TypeError `Workspace factory changed requested params`;
   - outputs or offsets differ (`Object.is`) → TypeError `Workspace output schema/offset binding`;
   - `outputs*capacity*8 > 268435456` (live capacity) → RangeError `Workspace projected output byte limit`.
8. Receipt:
   - `{schema:'aster.workspace-preflight', version:1, status:'validated-only', restored:false, dataset:<binding in caller key order>, source:{length, firstTime, lastTime, version}, counts:{panels, axes, series, indicators, outputs, drawings}, projectedOutputBytes, outputByteLimit:268435456, modules:[descriptors deduped by name]}`.
   - Legacy-chart vector: `source {40, 1700000000000, 1700002340000, version 1}`, counts `{1,0,2,1,1,2}`, `projectedOutputBytes 512`.

---

### 3.15 Typed `restoreWorkspace` pipeline (`native-workspace-source.mjs`, `native-workspace-target.mjs`, `prepare-state.mjs` PreparedData, B:24-47, B:49-60)

Restore runs across two runtimes: **source** is the live engine, **target** is a fresh runtime where `nativeInit` was never called. Nothing in the source changes; the host swaps engines atomically after both sides finish.

#### 3.15.1 Source capture `NativeWorkspaceCapture`
- **Constructor** (`:30-43`), in order:
  1. API and model types → TypeError `Workspace source actual API/model required`; disposed → Error `Chart disposed`.
  2. Controller binding → TypeError `Workspace source controller binding`; store → TypeError `Workspace source actual BarStore required`.
  3. Gesture, pointers or transaction → Error `Workspace source active gesture`.
  4. `revision` a safe int → RangeError `Workspace source host revision`; `maxBytes` a safe int 1..805306368 → RangeError `Workspace source byte limit`.
  5. Finite `size` → TypeError `Workspace source size`.
  6. `assertDataIngestionIdle`.
  7. Then: snapshot `sourceRefs`; acquire the ingestion lease (§3.6.3); re-compare (a change → StaleSourceError `Workspace source stale: owner/data/configuration changed`); `ingestionText = session?.save()`; `workspaceBinding`; `readWorkspaceDocument`; `nativeWorkspacePreflight`; `check`; byte accounting.
  - Any failure disposes the capture, which releases the lease.
- **`sourceRefs`** (`:17-24`): an `Object.is` fingerprint of everything that can change. It covers:
  - api, controller, model, input, the `size` object, store, columns, version, timeVersion, length, capacity, maxBars, timeframe, origin, disposed;
  - engine, entries, entries size; ingestion session; theme, symbol and both formatters; precision, axisWidth; the view object, `view.from`, `view.to`; follow; crosshair;
  - drawings, items, selected, serial, transaction, the undo/redo arrays and their lengths, size width/height;
  - every panel, axis and series object; every column array with its length and buffer; the index trees;
  - per entry: id, entry, def, name, params, revision, length, dirty, dirtyTo, invalidated, checkpoints and their count, the registry factory, arrays;
  - per series: values, revision, dirtyFrom, range index;
  - session policy and counters keys and values, flags and ring arrays.
  - `crosshairSnap` and `drawingMagnet` are not covered; the host revision catches those.
  - **Consequence**: any pointer move (new crosshair object), view change or render during a restore makes the next check stale. The bridge owner check also compares the `nativeSize` identity (B:36), and `nativeResize`, `nativeSceneJSON`, `nativeRenderFrame*` and `nativeScenePacket` all replace it. So interacting with or redrawing the chart during a restore fails it (`Workspace source stale: native owner replaced`). Option B must reproduce or document this (D9). This consequence comes from static reading of B:36 and `native-workspace-source.mjs:17-24`; it was not measured.
- **Byte accounting** `charge(bytes)` (`:44`):
  - `sourceInteger(bytes, maxBytes, 'logical bytes')` (RangeError `Workspace source logical bytes`);
  - then `sum > maxBytes - bytes` → RangeError `Workspace source logical byte limit`.
  - Charged items:
    - each **unique ArrayBuffer**'s full `byteLength`, deduplicated by identity: store columns, store index trees, ingestion ring columns and kinds, indicator arrays, series values, block values, range-tree arrays;
    - `NativeCheckpointMap` → `encodedBytes + size*128`;
    - an ordinary checkpoint Map → `size*128` now plus record footprints later;
    - drawing frames: `[items, ...undo, ...redo]` (≤20001 frames → else RangeError `Workspace source drawing frame count`; each a ≤10000-element array → else TypeError `Workspace source drawing frame`), each unique frame `length*8`.
  - `retainedBytes` therefore depends on allocation history: 49152 before the first render and 73728 after, on the same chart (measured).
- **`step(maxRecords, revision)`** (`:47-52`):
  1. `maxRecords` must be 1..64 → RangeError `Workspace source admission work` (hosts pass 8).
  2. `check`; if `phase!=='admission'` → return `{phase, complete:true}`.
  3. Charge `nativeCheckpointFootprint(state).logicalBytes` for each ordinary checkpoint record. A record over 256 KiB → RangeError `Native checkpoint record byte limit`, even if the document does not use that study.
  4. Charge each unique drawing's footprint (`Workspace source drawing` for non-objects).
  5. Not finished → `{phase:'admission', done: records+drawings, complete:false}`.
  6. Finished → build `metadataJSON`, run `plan = nativeWorkspaceTargetPlan(metadataJSON)` (the full target spec on the source side, so target-only limit errors appear **here**), `check`, set `phase='copy'`.
  - Measured: nativeInit(600) with 4 drawing frames finished on the second step (`done:6` first). Sources holding only `NativeCheckpointMap`s finish on the first step with `done:0`.
- **`metadataJSON`** (`:51`) = `safeCheckpointStringify({schema:'aster.native-workspace-target', version:1, [dataIngestion: save text], document: safeCheckpointStringify(parsed doc), datasetBinding, source:{length, maxBars, timeframeMs, timeOrigin, version, timeVersion}, size:{width,height}, retainedBytes, maxBytes})`. The document field is double-encoded.
- **Bridge Step response on completion** (B:41): `{phase:'copy', done, complete:true, ticket, metadataJSON, plan, buffers: FIELDS.map((_,slot)=>({slot, length: store.length})), checkpoints:[]}`.
- **`buffer(slot, offset, count, revision)`** (`:53`): requires phase `copy`, slot 0..5, `offset===` the slot's running offset, count 1..262144, `offset+count<=length`, else RangeError `Workspace source copy slice`. Returns a borrowed view over the live column, so the host copies it immediately.
- **`check(revision)`** (`:46`): `revision===hostRevision`, unchanged refs, `session===model.dataIngestion`, `epoch===leaseEpoch`, not closed, still leased. Otherwise StaleSourceError `Workspace source stale: owner/data/configuration changed`.
- **`finish(revision)`** (`:54`):
  1. `check`; phase `copy` and every offset complete, else Error `Workspace source copy incomplete`.
  2. Release the lease, then require `epoch===leaseEpoch+1`, unchanged revision and refs, and `assertDataIngestionIdle`.
  3. Receipt `{schema:'aster.native-workspace-source-finished', version:1, revision (the begin value), sourceVersion, sourceBytes, checkpointBytes, drawingBytes}`, then dispose. The bridge adds `ticket`.

#### 3.15.2 Target `NativeWorkspacePrepared extends PreparedData`
- **`nativeTargetSpec(text)`** (`native-workspace-target.mjs:18-35`), the order of checks:
  1. Not a string or longer than 8388608 → RangeError `Native workspace target metadata`.
  2. Parse; exactly 9 keys (`Native workspace target: …`); `schema/version` → TypeError `Native workspace target protocol`.
  3. `readWorkspaceDocument(m.document)`; binding equal → TypeError `Native workspace target dataset binding`.
  4. Source: exactly 6 keys. `length` and `maxBars` in 0..4194304 (`Native workspace source length` / `… max bars`); `length<=maxBars`; `doc.source.length===length`; finite `timeframeMs>0` and finite `timeOrigin` → RangeError `Native workspace target source settings`. `version`/`timeVersion` in 0..2^53-2 (`Native workspace source version` / `… time version`).
  5. Size: 2 keys, each finite 1..16384 → RangeError `Native workspace target size`; product ≤33554432 → RangeError `Native workspace target pixel limit`. A source whose `nativeSize` is below 1 fails here, at the end of source admission.
  6. `maxBytes` 1..805306368 (`Native workspace combined byte limit`); `retainedBytes` 0..maxBytes (`Native workspace retained source bytes`).
  7. Capacity from 16 by doubling ≥ length. `outputs = Σ doc outputs`; `outputBytes = outputs*capacity*8 > 268435456` → RangeError `Native workspace target output byte limit`.
  8. Ingestion text: must be a string ≤32768 (RangeError `Native workspace ingestion document limit`). Restore it on a facade `{disposed:false, dataIngestion:null, store:{length, capacity, maxBars, version, bytes:capacity*96}}` with `allowBudgetMismatch=false`; `count>0` → TypeError `Native workspace pending ingestion`; re-save; `ingestionBytes = capacity*147`.
  9. `rangeBytes = indexedSeries * (length>=65536 ? max(1,capacity/32) : capacity) * 48`, where indexedSeries counts doc series other than candles/ohlc.
  10. `checkpointRecords = (length===0 ? 0 : floor(length/256)+1) * indicators`; `recordMetadataBytes = records*128`.
  11. `totalBytes = retained+source(capacity*96)+output+range+33554432+recordMetadata+33554432+33554432+4194304+ingestion`; `> maxBytes` → RangeError `Native workspace combined logical byte limit` (equality passes).
  12. `plan = freeze({retainedBytes, sourceBytes, outputBytes, rangeBytes, checkpointBytes:33554432, recordMetadataBytes, scratchBytes:33554432, documentBytes:33554432, transferBytes:4194304, ingestionBytes, totalBytes, maxBytes, capacity, outputs})`.
  - Example for nativeInit(600) with an ingestion session of 8 queued events: `{109986, 98304, 8192, 98304, 33554432, 384, 33554432, 33554432, 4194304, 1176, total 105173946, 805306368, 1024, 1}`.
  13. Build the PreparedData metadata `{schema:'aster.prepare', protocol:1, input:{kind:'columns', length, seed:42, visibleBars: min(4194304, max(1, view.to-view.from))}, storeOptions:{maxBars, timeframeMs, timeOrigin}, version: s.version+1, timeVersion: s.timeVersion+1, panels, axes, theme, precision, axisWidth, indicators, series, maxOutputBytes:268435456}`.
- **Column receive**: `target(slot, offset, count)` writes sequential slices 1..262144 (RangeError `Prepare target slice`). `start()` requires every column complete (Error `Prepare incomplete input`) and installs a `BarStore` with the copied columns, a hand-built tree, and `version/timeVersion = source+1`.
- **Phases**, driven by `step(maxBars)` with `maxBars` an integer 1..65536 (RangeError `Prepare step size`; host default 4096, max 16384). The response reports the phase before any transition. Calling `step` before `start` → Error `Prepare not started` and the target is disposed.

| Phase | Work | Progress `{done,total}` | Errors |
|---|---|---|---|
| `validate` | per row: finite → safe-int time with `\|t\|<=8.64e15` → strictly increasing → envelope; then `index.leaf` | `at / n` | TypeError `Every OHLCV field must be finite`; RangeError `OHLCV UTC time`, `OHLCV increasing time`, `Invalid OHLCV envelope` (differs from `setColumns` wording) |
| `store-index` | `merge(p)` from `capacity-1` down to 1; root volume must be finite | `capacity-1-at / capacity-1` | RangeError `Volume sum overflow` |
| (initialize) | extent check `time[0]===firstTime`, `time[n-1]===lastTime` (TypeError `Native workspace target source extent`); `ChartModel(...)`; `entries = new NativeCheckpointEntries()`; each study: factory, portability, params and layout identical (TypeError `Native workspace target factory binding`), shared-budget `NativeCheckpointMap` | — | `UnsupportedIndicatorError`, `Indicator module descriptor binding` |
| `calculate` | one `calculate(id, maxBars).next()` per step, in document order, cold from 0; checkpoints every 256 (+n) go through `NativeCheckpointMap.set` | completed entries / entries | `Native checkpoint total byte limit`, `Native checkpoint record byte limit`, indicator errors (§3.7) |
| (series) | `model.addSeries` for each document series | — | §3.9.3 |
| `indices` | range trees per non-candle series (leaves in chunks of `max(1, floor(maxBars/blockSize))` rows, merges per maxBars nodes); sets `rangeIndex`, `revision`, `dirtyFrom=Infinity` | completed series / series | — |
| `workspace-checkpoints` | per entry: size must be `floor(n/256)+1` (0 when n=0) → TypeError `Native workspace checkpoint count`; keys must be `ordinal*256` → `Native workspace checkpoint boundary`; `max(1, floor(maxBars/256))` records per call | checked / expected | as listed |
| (install) | `installWorkspaceConfiguration(model, {...doc, series:[]})`; restore ingestion on the real model; snapshot the ready state; canonical check `readWorkspaceDocument(saveWorkspace(new ChartAPI(model), doc.dataset))` deep-equals (key order ignored, `Object.is` leaves) the facade-normalized document | — | TypeError `Native workspace canonical restore mismatch` |
| `workspace-ready` | — | `1 / 1`, `complete:true` | — |

- Phases with no work are skipped: with no indicators `calculate` never appears, and with no series `indices` never appears. With both empty the sequence is validate > store-index > workspace-checkpoints > workspace-ready.
- **`finish()`**: no arguments; phase must be `workspace-ready`, else Error `Native workspace target not ready`. `guardReady` (Error `Native workspace target configuration changed`), then return `{model, size, plan}` once.
- Any error inside target, start, step or finish disposes the target; later calls → Error `Native workspace target closed`.
- `finishUI` always throws; UI import is refused with `Workspace target does not import source UI`.

#### 3.15.3 Bridge state machine (B:24-60)
- **`nativeWorkspaceSourceBegin`**:
  1. Any of `nativeAsyncCapture`, `nativeWorkspaceSource`, `nativeParamsSource` active → Error `Async capture busy`.
  2. If `registration!==undefined`, it must be a safe int > the high-water mark, else RangeError `Workspace registration must increase`. The mark is consumed **even if Begin later fails**.
  3. `nativeAsyncTicket+1` not a safe int → RangeError `Workspace source ticket limit`.
  4. Build the row; owner check (Error `Workspace source stale: native owner replaced`).
  5. Construct the capture. If the slot changed meanwhile → Error `Workspace source stale: registration changed`.
  6. Return `{ticket, phase:'admission', registration?}` (registration only if given).
- **Every source operation** (Step, Check, Buffer, Finish) runs as owner check → op → owner check. **Any error drops the session**; later calls → Error `Workspace source ticket missing/released`.
- **`nativeWorkspaceSourceAbort(registration)`**: `registration` not a safe int ≥1 → RangeError `Workspace registration`. No active source or a different registration → `false`; otherwise drop and return `true`.
- **`nativeWorkspaceTargetCreate`**:
  1. A busy target slot (`nativeAsyncPrepared`, the creating tokens, a params target, UI import) → Error `Async target busy`.
  2. Vacancy check: a non-extensible global → Error `Workspace target global is not extensible`; any of the four engine globals present (an accessor, a non-undefined value, or non-configurable) → Error `Workspace target requires an isolated empty runtime`.
  3. Reserve a token, construct, check vacancy again, verify the token (Error `Workspace target creation cancelled`), install.
- **`nativeWorkspaceTargetFinish`**:
  1. Not a workspace target → Error `Workspace target missing`.
  2. Vacancy, `finish()`, vacancy again.
  3. New `InteractionController(model, ()=>globalThis.nativeSize)` and `ChartAPI`.
  4. `Object.defineProperties` in the order nativeSize, nativeModel, nativeInput, nativeAPI (writable, configurable, enumerable).
  5. Reset the latest layout; clear the slot; return the ready receipt.
  - On failure: dispose the model, dispose the target, clear the slot, rethrow.
- **`nativeAsyncBuffer(ticket, slot, offset, count)`** routing: params source ticket → params target registration → **workspace source ticket** → generic async capture (`Async stale: source replaced/released`).
- **`nativeAsyncTargetBuffer(slot, offset, count)`**: params source/target first, then `nativeAsyncPrepared.target(...)` (Error `Async target missing` when none).
- **`nativeAsyncStart()`** / **`nativeAsyncStep(maxBars)`**: Error `Async target missing` when no target. `nativeAsyncStep` returns `JSON.stringify(progress)`; the last one is `{"phase":"workspace-ready","done":1,"total":1,"complete":true}`.
- Misuse: `nativeAsyncCheckpointImport` on a workspace target throws an engine TypeError (no `checkpoint` method); `nativeAsyncFinish(uiJSON)` with an argument → `Native workspace target not ready` (and the target is disposed).

#### 3.15.4 Post-publish state (must match; measured)
- **Store**: `version`/`timeVersion` = source + 1 (2 → 3; a double restore gives 4). `capacity` is recomputed from 16. `maxBars`, `timeframeMs` and `timeOrigin` come from the source.
- **Model** (from the document): panels, axes, theme, precision, axisWidth, symbol and formatters, view, follow, drawings, series, indicators. Indicator values are fresh full recomputes.
- **Engine**: `entries` is a `NativeCheckpointEntries` with a 32 MiB shared budget (§3.8.5, D2).
- **Reset state**: `crosshair:null`; `drawings.selected:null`, `transaction:null`, `undoStack:[]`, `redoStack:[]`, `serial:0`.
  - `serial` 0 means later auto-ids can differ from the source. Example: after deleting `drawing-1` (serial 3), the source's next id is `drawing-4` but the restored engine's is `drawing-1`.
- **Controller**: `tool:'select'`, `text:'Note'`, `drawingTarget:null`, magnet `{off,8}`, snap `{free,null}`, no pointers or gesture.
- **`nativeSize`**: the captured size (e.g. 640×360).
- **Ingestion**: a re-created session (epoch 0) whose `save()` equals the source's. The source session's epoch is +2 after the restore.
- **Key order**: re-saving a restored model keeps the input key order for `view`, indicator params, drawing records/points/style and symbol. Theme, panels, series and dataset come back canonical. The canonical check ignores key order, so a reordered valid document still restores.
- **Round trip**: `save(restore(text)) === text` holds for every text produced by `saveWorkspace` (the legacy v1 fixture included).

#### 3.15.5 Host job flows (stay in Swift/Java under Option A)
- **Swift**: `BaroChartEngine.swift:469-930, 1486-1503`; typed `restoreWorkspace(_:binding:)` in `BaroChartEngine+Typed.swift:118-127, 152-185`.
  - Begin (768 MiB, registration echoed) → admit loop Step(8) on main-queue turns → admit `plan.totalBytes` into the process-wide budget (2 jobs, 768 MiB) → worker: new JSContext, evaluate bundle, TargetCreate → per slot, 262144-value chunks: main `SourceCheck` + `nativeAsyncBuffer`, worker `nativeAsyncTargetBuffer` → Start → Step loop → TargetFinish (`plan.totalBytes` must match) → main SourceFinish (schema, version, ticket, revision) → swap context → notify → complete.
  - Failure → `nativeWorkspaceSourceAbort(registration)`; if that also fails → `cleanupPending`.
- **Android**: `WorkspaceRestoreJob.java`, `NativeJobBudget.java`, `BaroChartEngine.java:940-1003, 1370-1409`. The same sequence over JNI `readBuffer`/`writeBuffer`. `publish` swaps `handle=target`. Status values: `success|failed|cancelled|timedOut|stale|closed`. The typed callback maps `cancelled` to `CANCELLED 'Workspace restore was cancelled.'` and others to `wrap(error)` or `UNAVAILABLE 'Workspace restore finished with status <s>.'`.
- **Host-side validation the Rust responses must satisfy**:
  - registration echo and `ticket>0`;
  - admission phase strings;
  - descriptor: exactly 6 buffers, slots 0..5 in order, equal lengths ≤4194304;
  - `plan.totalBytes` within 1..805306368;
  - metadata ≤8388608 UTF-16;
  - progress phases from the whitelist, `complete == (phase=='workspace-ready')`, `done<=total`;
  - finish receipts' schema, version, ticket and revision.

#### 3.15.6 Simplification option (B) for an in-process Rust backend
A Rust backend may replace the two-runtime protocol with "clone, compute on a worker, swap atomically". It must still reproduce:
- the same validation errors (document, binding, extent, budgets);
- the same failure conditions (stale on any source change, `busy`, `cancelled`, `timedOut`, `cleanupPending`);
- the post-publish state of §3.15.4 (including D2 if not fixed in JS).
Progress phase names are only visible in the advanced API. Typed restore exposes no progress.

---

### 3.16 Bridge layer details (B, T, E)

#### 3.16.1 `nativeInit(count=100000, options=null)` (B:66-79)
1. `options!==null` must be a non-array object, else TypeError `Chart options object`.
2. `store=new BarStore(); store.setColumns(seededColumns(count,42))` → RangeError `Synthetic bar count: limit 4194304` unless `count` is a safe int in 0..4194304. `null`, `'3'`, `1.5` and `-1` fail; only `undefined` defaults to 100000.
3. `model = new ChartModel({store, axes: options?.axes ?? [], panels: options?.panels ?? (options===null ? [{id:'price',weight:3,label:'ASTER · NATIVE'},{id:'volume',weight:1,label:'VOLUME'}] : [{id:'price',weight:3}]), visibleBars: options?.visibleBars ?? 200, axisWidth: options?.axisWidth ?? 82, precision: options?.precision ?? 2})`. The theme is **not** passed to the constructor; unknown option keys are ignored.
4. `input = new InteractionController(model, ()=>globalThis.nativeSize ?? {width:1200, height:700})`; `api = new ChartAPI(model,{controller:input})`.
5. **Demo layout** (`options===null`) uses **model-level** calls, so colors stay 6-digit: `addSeries({id:'price',type:'candles',panel:'price'})`, `addSeries({id:'volume',type:'histogram',panel:'volume',source:'volume',color:'#397e8c'})`, `indicators.add('ema','ema')`, `addSeries({id:'ema',type:'line',panel:'price',indicator:'ema',color:'#f0b755'})`.
6. **Options path** uses the API: `if (options.theme) api.setTheme(options.theme)`; `for (s of options.series ?? []) api.addSeries(s)`. Explicit colors become `#rrggbbff`.
7. On error the new model is disposed and the error rethrown; the previous engine stays intact.
8. **Commit**: `nativeModel?.dispose()`; reset the latest layout; `nativeModel=model`; `nativeSize={width:1200,height:700}` (new object); `nativeInput`; `nativeAPI`.
- Frame caches and async, workspace, params or explorer sessions are **not** reset; later owner checks detect them as stale.
- Returns `count`.
- Normalized demo series: price `{color:'#7898ff', width:1, offset:0, dirtyFrom:0}`, volume `{color:'#397e8c', width:1.5, source:'volume'}`, ema `{color:'#f0b755', width:1.5, indicator:'ema'}`. Views: 5 bars → `{from:-0.5, to:199.5}`; 300 bars → `{99.5, 299.5}`.

#### 3.16.2 Scene/frame/packet wrappers
See §3.11.7 and §3.11.8. Shared facts:
- `nativeSceneJSON`, `nativeRenderFrame*` and `nativeScenePacket` assign `nativeSize` **before** building. An exception leaves the new size in place.
- They record `nativeLatestLayout` and `nativeLatestLayoutModel` after success.

#### 3.16.3 `nativePointer`, `nativeKey`, `nativeHoverExit`, `nativeGestureKind`, `nativeThemeFont`, `nativeResize`
Simple delegations (§1.2). `nativePointer`'s catch-all `cancel()` runs a **global** cancel: it rolls back any transaction, restores the view and clears pointers. If `cancel()` itself throws (e.g. disposed), that error replaces the original. Inputs never bump the host revision.

#### 3.16.4 Accessibility (B:98-104, checked)
- **`nativeAccessibility(useLastFrame=false)`**:
  - `last = store.length ? store.at(length-1) : null`;
  - `close = last ? (priceFormatter ? priceFormatter(last.close) : last.close.toPrecision(15)) : 'No data'`;
  - `selection = selected drawing ? type + (locked ? ' locked' : ' editable') : 'No selection'`;
  - `panels = model.panels.map(p => ({id, title: p.label ?? p.id, series: visible series of p → {id, label: s.label ?? s.indicator ?? s.id, ...(indicator ? {indicator} : {})}}))`. All panels are listed, hidden series are dropped.
  - `crosshair`: only when `model.crosshair` is set. If `useLastFrame===true`, `nativeLatestLayoutModel===nativeModel`, and the latest layout's width and height equal `nativeSize`, use `crosshairValuesAt(model, latestLayout)` (no range recomputation; the stored closures read the **current** view). Otherwise `nativeAPI.crosshairValues(nativeSize.width, nativeSize.height)`.
  - `readout = [`${n} bars. Close ${close}. ${selection}. Tool ${tool}.`, ...panels.map(p => p.title+': '+labels.join(', ')), ...(crosshair ? ['Time '+new Date(time).toISOString(), ...axes.map(a => (a.id ?? a.panel)+': '+a.formatted), ...series.map(s => s.label+': '+(s.value ?? 'gap'))] : [])].join('. ')`.
  - The first segment already ends with `.`, which produces `Tool select..` (D9).
  - Returns `{bars, close, selection, tool, panels, crosshair, readout}`.
- **`nativeAccessibilityText(useLastFrame=true, platform='android')`**:
  - an invalid platform throws **before** computing;
  - calls `nativeAccessibility` exactly once;
  - `android` → `readout`;
  - `uikit` → `[bars+' bars', panels.map(title).join('; '), readout, selection, 'tool '+tool].filter(s=>s.length>0).join('; ')`.
- **Goldens**:
  - `nativeInit(5)` → `5 bars. Close 99.7588357865177. No selection. Tool select.. ASTER · NATIVE: price, ema. VOLUME: volume`;
  - uikit → `5 bars; ASTER · NATIVE; VOLUME; 5 bars. Close 99.7588357865177. No selection. Tool select.. ASTER · NATIVE: price, ema. VOLUME: volume; No selection; tool select`;
  - `nativeInit(0,{})` → `0 bars. Close No data. No selection. Tool select.. price: `;
  - `nativeInit(64)` plus a pointer move to (150,150) → `… VOLUME: volume. Time 2023-11-14T22:37:20.000Z. price: 102.71. price: 101.86524544848132. volume: 3927. ema: 100.99117287003492`.

#### 3.16.5 `nativeDataIngestionCommand(op, args=[])` (B:90-94, tier A)
1. An op outside the 9 ingestion ops → TypeError `Unknown ingestion command`, thrown, not enveloped.
2. Otherwise returns `{result: dispatch(op,args)}`, or on any exception `{error:{name:'IngestionError', code: (IngestionError ? error.code : op==='loadDataIngestion' ? 'INVALID_DOCUMENT' : 'INVALID_INPUT'), message: String(error.message).slice(0,256)}}`. Owner errors such as `Chart disposed` are enveloped too.
- Measured:
  - unconfigured stats → `{error:{name:'IngestionError', code:'NOT_CONFIGURED', message:'Configure data ingestion first'}}`;
  - `configureDataIngestion(1)` → INVALID_INPUT `Ingestion policy object required`.
- Hosts validate code 1..64 and message ≤256 UTF-16 (Swift), then throw `BaroChartIngestionError` (Swift) or `IngestionException` (Java).

#### 3.16.6 Shared job state and busy rules (B:3-21)
- **Source slot** (one per runtime): an async capture, a workspace source or a params source → `Async capture busy`.
- **Target slot**: `nativeAsyncPrepared`, the creating tokens, a params target, UI import or UI prepared → `Async target busy`. The checks differ per function: `nativeAsyncCreate`/`nativePrepareCreate` do not check the UI-import slots.
- **Tickets**: one counter for async, prepare, workspace and params. Workspace and params begins check for overflow; async and prepare begins do not.
- **On error**: workspace and params operations drop their session; generic `nativeCapture` operations keep it.

#### 3.16.7 `nativeApplyUnchangedDataEvents(events)` (T:6-22, tier A)
- Captures `ChartAPI.prototype.applyDataEvents` at load time and calls it with `{skipUnchanged:true}`.
- Owner and own-data checks: `Native batch own data required`, `Native batch disposed data required` (TypeErrors); StaleSourceError `Native batch owner/source changed`.
- Receipt validation → TypeError `Native batch receipt invalid` when any of these fails:
  - events 1..4096 and equal to the count;
  - `appended<=events`;
  - length ≤4194304;
  - capacity 1..4194304, a power of two, ≥ length;
  - `bytes===96*capacity`;
  - `from<to<=length`;
  - `before<=version<=after`.
- Unchanged requires appended 0 and identical vectors, columns, index and version (else StaleSourceError); changed requires `version===before+1` (else TypeError `Native batch publication version`).
- Returns `freeze({schema:'aster.native-data-batch', version:1, beforeVersion, afterVersion, unchanged, receipt: freeze({events, appended, from, to, version, length, capacity, bytes, unchanged})})`.

#### 3.16.8 `nativeDataExploration(action, argument)` (E:6-29, tier A, experimental)
- Action and argument checks (TypeErrors): `Exploration action`, `Exploration active boolean`, `Exploration navigation key` (only `ArrowLeft/Right/Up/Down/Home/End`), `Exploration action takes no argument`.
- Owner checks: `Exploration owner data property required`, `Exploration disposed data property required`; StaleSourceError `Native exploration owner/source changed`.
- State errors: `Exploration requires an idle gesture`, `Exploration operation already running`.
- `read`, `navigate` and `refresh` call `explorer.changed()` first; navigating while inactive → Error `Enable data exploration first`.
- Returns `{schema:'aster.native-data-exploration', version:1, active, time, index, seriesId, phase, text}`.
- The `KeyboardDataExplorer` text templates (K:12, K:31, sliced to 4096 UTF-16 units) are in the bridge reader report. They are not required for the stable surface.

#### 3.16.9 Bundle facts (S:4-24)
- `CORE_MODULES` (46) are concatenated in this order: `contracts, labels, data-batch-options, data, store-owners, block-index, markets, resample-plan, resample, indicator-params, indicator-modules, trusted-studies, session-studies, indicators, position-drawing, drawing-validation, drawings, ohlc-snap, crosshair-snap, scene-parts, model, scene, frame-cache, interaction, checkpoint-validation, native-checkpoints, ingestion-error, ingestion, study-setup, data-explorer, compaction, drawing-style-patch, drawing-translation, api, drawing-style-presets, bar-replay, workspace, native-workspace, async-state, prepare-state, native-workspace-target, native-workspace-source, native-params-target, native-params-import, native-params-source, async-ui`.
- Then `keyboard-explorer` wrapped as `NativeKeyboardDataExplorer`, then `native-command-packet`, then the four bridges.
- The bundle is sloppy mode; class bodies are strict, so `ChartAPI` semantics match the web.
- The only top-level duplicate name is `cloneDrawingTarget` (identical bodies).
- Android requires the bundle to be ≤1 MiB UTF-8 (`aster_jni.c:53`).


---

## 4. Error catalog

### 4.0 Error model and host classification

**Abbreviations used in this section**

| Code | Meaning |
|---|---|
| TE | TypeError |
| RE | RangeError |
| E | Error |
| SE | SyntaxError (engine-specific text) |
| SSE | Error with `name` = `'StaleSourceError'` |
| IE:CODE | IngestionError with `code` = CODE |
| UIE | UnsupportedIndicatorError (`code:'UNSUPPORTED_INDICATOR_MODULE'`) |
| IBE | IndicatorBusyError |
| SCE | StaleCheckpointError |
| IntE | QuickJS InternalError |

**Tier codes** (see §0): S, V, R, A, X, J, T. A message listed only as X can be dropped by Rust, but if Rust keeps the check it must keep the exact text.

**How hosts classify errors.** The class prefix and the message text together decide the typed error code. That is why Rust must reproduce both exactly.

- **Swift, low-level text path.** `BaroChartLowLevelError.javaScript(text)` is classified by `BaroChartError.swift:94-113`:
  - `TypeError: ` and `SyntaxError: ` → `invalidArgument`.
  - `RangeError: ` → `budgetExceeded` if the message matches `: limit \d+$|budget|exceeds` (case-insensitive); otherwise `invalidArgument`.
  - `IngestionError: ` → `budgetExceeded` if the message matches `budget|limit|full` (case-insensitive); otherwise `invalidArgument`.
  - `Error: Chart disposed` → `engineClosed`.
  - Any other `Error: ` → `javaScript`, with the prefix stripped.
  - Any other prefix (`StaleSourceError: `, `UnsupportedIndicatorError: `, `IndicatorBusyError: `) → `javaScript`, with the full text kept.
- **Swift, structured ingestion path.** `BaroChartIngestionError` (the `nativeDataIngestionCommand` envelope, and `asterInvoke` for async jobs) is classified by `BaroChartError.swift:72-74`. It matches `budget|limit|full` against the **code**, case-sensitively. Codes are uppercase, so this practically always yields `invalidArgument`, with the message `Ingestion <CODE>: <msg>`.
- **Java.** `BaroChartException.java:84-115`:
  - `IngestionException` → message matches `(?s).*(budget|limit|full).*` (case-sensitive).
  - `JSONException` and `IllegalArgumentException` → `INVALID_ARGUMENT`.
  - Text prefixes follow the same rules as Swift.
  - `Error: Chart disposed` → `ENGINE_CLOSED`.
  - Other `Error: ` → `JAVASCRIPT`.
  - Unknown prefixes go to `classifyHostMessage`, which usually yields `UNAVAILABLE`. So `StaleSourceError` is `javaScript` on iOS and `UNAVAILABLE` on Android.
  - The message keeps its text with the script prefix stripped.

**Consequences.**
- `sizeLimit` messages (`…: limit N`), `Data batch … budget limit N`, `Compaction source peak byte budget`, `Drawing group edit undo snapshot exceeds historyBytes` and `Native params retained source budget` classify as **budget**.
- Messages that say "limit" without `: limit N` at the end are **invalidArgument** for `RangeError`. Examples: `Indicator output byte limit`, `Native checkpoint total byte limit`, `Drawing count limit`.

### 4.1 Bridge and transport (B, T, E, N, P, S)

| Message (verbatim) | Class | Where | Tier |
|---|---|---|---|
| `Chart options object` | TE | B:67 | S |
| `Synthetic bar count: limit 4194304` | RE | `data.mjs:296` via B:68 | S |
| `Pointer operation` | TE | B:146 | V |
| `Accessibility text platform` | TE | B:101 | V |
| `Native frame token` | TE | B:194 | V |
| `Native frame cache count` | RE | B:194 | V |
| `Native packet mode` | TE | B:198 | V |
| `Workspace native owner mismatch` | E | B:85, B:86 | S |
| `Workspace native owner changed` | SSE | B:85, B:86 | S |
| `Async capture busy` | E | B:5, B:6, B:40; P:12 | R/A |
| `Async target busy` | E | B:15, B:26, B:56; P:29 | R/A |
| `Workspace target global is not extensible` | E | B:24 | R |
| `Workspace target requires an isolated empty runtime` | E | B:24 (create/finish, params target) | R |
| `Workspace target creation cancelled` | E | B:30 | X |
| `Workspace target missing` | E | B:34 | R |
| `Workspace source stale: native owner replaced` | E | B:36 (all workspace source ops; P:5 params owner) | R |
| `Workspace source ticket missing/released` | E | B:37 | R |
| `Workspace registration must increase` | RE | B:40 | R |
| `Workspace source ticket limit` | RE | B:40 | R |
| `Workspace source stale: registration changed` | E | B:40 | X |
| `Workspace registration` | RE | B:47 | R |
| `Async target missing` | E | B:57, B:58, B:59, B:60, B:64 | R |
| `Workspace target does not import source UI` | E | B:61 | R |
| `Unknown ingestion command` | TE | B:92 (thrown, not enveloped) | A |
| envelope `{error:{name:'IngestionError', code, message ≤256}}` | (returned) | B:93; B:9 | A |
| `Unknown async begin kind` | TE | B:8 | A |
| `Async stale: source replaced/released` | E | B:4 | A |
| `Params target registration` | E | B:49 | A |
| `Async UI capture busy` / `Async UI capture missing` / `Async UI incomplete source transfer` | E | B:52 / B:53 / B:54 | A |
| `Async UI target unavailable` / `Async UI target missing` | E | B:61 / B:62-63 | A |
| `Native indicator slice` | RE | B:65 | A |
| `Params source ticket missing/released` | E | P:6 | A |
| `Params source registration changed` | E | P:8, P:15 | A |
| `Params registration` / `Params registration must increase` / `Params source ticket limit` | RE | P:9 / P:12 / P:12 | A |
| `Params write already armed` / `Params result write not armed` / `Params unconsumed write` | E | P:21 / P:22 / P:25 | A |
| `Params result slice` / `Params armed slice mismatch` | RE | P:21 / P:22 | A |
| `Params target creation cancelled` / `Params target missing` | E | P:29 / P:30 | A |
| `Native batch own data required` / `Native batch disposed data required` | TE | T:3 / T:4 | A (X) |
| `Native batch owner/source changed` | SSE | T:5, T:10, T:19 | A |
| `Native batch receipt invalid` / `Native batch publication version` | TE | T:17 / T:20 | A |
| `Exploration owner data property required` / `Exploration disposed data property required` | TE | E:3 / E:4 | A (X) |
| `Native exploration owner/source changed` | SSE | E:5, E:13 | A |
| `Exploration action` / `Exploration active boolean` / `Exploration navigation key` / `Exploration action takes no argument` | TE | E:7 / E:8 / E:9 / E:10 | A |
| `Exploration requires an idle gesture` / `Exploration operation already running` | E | E:14 / E:18 | A |
| `Enable data exploration first` | E | E:25, K:25 | A |
| `Keyboard exploration owner changed` | SSE | K:5 | A |
| `Exploration series limit` | RE | K:10 | A |
| `Exploration mode boolean` | TE | K:14 | A |
| `Exploration read already running` | E | K:25 | A |
| `Native packet finite <label>`, label ∈ {width, height, stroke, clip, area baseline, dash, geometry} | TE | N:5 (called at N:15, 32, 34, 36, 51, 52) | V |
| `Native packet <label> array`, label ∈ {clip, dash, coords, points} | TE | N:6 | V |
| `Native packet mode/layers` / `Native packet background string` / `Native packet string` | TE | N:14 / N:16 / N:19 | V |
| `Native packet string limit` / `Native packet metadata byte limit` / `Native packet command limit` | RE | N:21 / N:22, N:47 / N:28 | V |
| `Native packet commands array` / `Native packet unsupported operation` | TE | N:27 / N:31 | V |
| `Native packet stroke` / `Native packet number limit` / `Native packet positive dash` | RE | N:32 / N:41 / N:51 | V |
| `Native packet clip arity` / `Native packet dash arity` / `Native packet geometry arity` | TE | N:33 / N:35 / N:39 | V |
| `Native packet geometry changed during encoding` | TE | N:54 | X |
| `Native module requires one local defineIndicatorModule import` / `Native module has unsupported import/export syntax` | TE | S:18 / S:19 (build time) | J |
| `Open comparison demo first` / `Save drawing document first` | E | B:217 / B:224 | T |
| `Saved drawing document string` / `Unknown comparison action` | TE | B:218 / B:226 | T |
| `Native publication order <kind>` / `Native publication subscription leak` | E | B:158 / B:159 | T |
| self-test label messages, e.g. `RSI correction parity`, `OHLC preservation`, `Gesture cancel`, `Serialization`, `Native scene` | E | B:123, 164, 174, 184, 230 | T |

### 4.2 Shared validators (`contracts.mjs`) and the checkpoint codec

**Template families**, with the labels that are reachable on the stable surface:

| Template | Class | Where | Labels (examples; each label is used verbatim) |
|---|---|---|---|
| `${label}: object required` / `${label}: plain object required` / `${label}: unsupported field ${key.slice(0,64)}` | TE | `contracts.mjs:3-5` | `Theme`, `Panel`, `Panel patch`, `Axis`, `Axis patch`, `Series`, `Drawing`, `Drawing patch`, `Drawing style`, `Anchor`, `Drawing document`, `Drawing magnet`, `Drawing target`, `Crosshair snap`, `Crosshair snap target`, `Indicator params`, `Indicator query`, `Indicator module descriptor`, `Study setup`, `Study definition`, `Study series`, `Workspace`, `Native workspace target`, `Native workspace target source`, `Native workspace target size`, `Prepare metadata`, `Prepare input`, `Prepare request`, `Prepare indicator`, `Prepare series`, `Prepare store options` |
| `${label}: string limit ${max}` | TE | `contracts.mjs:8` | `Panel id`, `Axis id`, `Axis panel`, `Series id`, `Series panel`, `Series axis`, `Series symbol`, `Drawing id`, `Drawing panel`, `Drawing axisId`, `Drawing seriesId`, `Drawing target panel`, `Crosshair snap panel`, `Panel order id`, `Indicator id`, `Indicator placement panel`, `Indicator placement axis` (128); `Panel label`, `Series label`, `Theme value`, `Font`, `Axis formatter output`, `Price formatter output` (256); `Color`, `color`, `fill`, `upColor`, `downColor` (128); `Axis prefix`, `Axis suffix` (64); `Drawing text` (2000); `Drawing document` (8388608 or the store's `maxDocumentChars`); `Workspace document` (2097152); `Workspace dataset <key>`, `Workspace symbol`, `Workspace indicator id`, `Workspace indicator name`, `Workspace output`, `Prepare indicator id`, `Prepare series id`, `id`, `export name`, `Canonical indicator name` (128) |
| `${label}: reserved identifier` | TE | `contracts.mjs:10` | any identifier label above |
| `${label}: limit ${max}` | RE | `contracts.mjs:9` | `Bar count` (store maxBars), `Bar limit` (4194304), `Synthetic bar count` (4194304), `Workspace source length` (4194304), `maxDrawings` (10000), `maxPoints` (2097152), `maxDocumentChars` (8388608), `historyBytes` (33554432), `Index capacity`/`Index length` (X), `Prepare bar count` (4194304), `Prepare seed` (4294967295), `Prepare output budget` (536870912), `Prepare bar limit` (4194304), `Prepare bars` (maxBars), `Prepare revision` (9007199254740991) |

**Single messages**

| Message | Class | Where | Tier |
|---|---|---|---|
| `Color string required` | TE | `contracts.mjs:23` | S |
| `Portable color: hex, comma RGB/RGBA or basic named color required` | RE | `contracts.mjs:30` | S |
| `Font size limit: 4..96px` | RE | `contracts.mjs:34` (also on regex mismatch) | S |
| `Checkpoint text limit` | RE | `checkpoint-validation.mjs:40, :44` | S |
| `Checkpoint depth limit` | RE | `:55` | S |
| `Checkpoint duplicate state key` | TE | `:53` | S |
| `Checkpoint untagged nonfinite number` | TE | `:57`, `:17` | S |
| `Checkpoint state limit` | RE | `:14` | S |
| `Checkpoint Unicode scalar` | TE | `:10` | S |
| `Checkpoint number marker` | TE | `:23` | S |
| `Checkpoint unsupported value` / `Checkpoint cyclic state` / `Checkpoint object type` / `Checkpoint array shape` | TE | `:18` / `:19` / `:20` / `:28` | X |
| `Checkpoint accessor state` | TE | `:29`, `:32` | X |
| JSON grammar errors (engine text) | SE | `:53`, `:59` | S (class only) |

### 4.3 Data store and markets

| Message | Class | Where | Tier |
|---|---|---|---|
| `Every OHLCV field must be finite` | TE | `data.mjs:44`, `:145`; `prepare-state.mjs:34` | S |
| `Time must be an exact UTC millisecond integer in the Date range` | RE | `data.mjs:45`, `:146` | S |
| `Times must be strictly increasing` | RE | `data.mjs:46`, `:147` (setData, setColumns, prepend, batch append) | S |
| `Invalid OHLCV envelope` | RE | `data.mjs:47`, `:148`; `prepare-state.mjs:34` | S |
| `OHLCV object required` | TE | `data.mjs:11` (setData rows, scalar append/update) | S |
| `OHLCV array required` | TE | `data.mjs:101`; `api.mjs:45` | S |
| `Prepend must precede existing history without overlap` | RE | `data.mjs:157` | S |
| `Volume sum overflow` | RE | `data.mjs:63, 78, 222, 224, 250`; `prepare-state.mjs:35` | S |
| `Data batch bar budget limit <max>` (code `STORE_BUDGET` property) | RE | `data.mjs:40` | S |
| `Data batch store byte budget limit <max>` (code `STORE_BUDGET`) | RE | `data.mjs:40` | S (session) |
| `Data batch update is only the current timestamp` | RE | `data.mjs:205` | S |
| `Data batch correction requires an existing timestamp` | RE | `data.mjs:208` | S |
| `Range index bounds` | RE | `data.mjs:83`, `:91` (render with stale external values) | V |
| `Block index bounds` | RE | `block-index.mjs:12`, `:14` (same, ≥65536 values) | V |
| `Numeric column arrays required` | TE | `data.mjs:119-132` | A |
| `Data batch options plain data record required` / `Data batch options unsupported field or accessor data property` / `Data batch skipUnchanged must be boolean` | TE | `data-batch-options.mjs:3` / `:7` / `:10` | A |
| `Data batch array required` / `Data batch dense array data properties required` | TE | `data.mjs:24` / `:28` (direct store calls only; the API path pre-validates) | A |
| `Data batch event count must be 1..4096` | RE | `data.mjs:26` | A |
| `Data batch event plain data record required` / `Data batch OHLCV plain data record required` | TE | `data.mjs:13` | A |
| `Data batch event unsupported field or accessor data property` / `Data batch OHLCV unsupported field or accessor data property` | TE | `data.mjs:17` | A |
| `Data batch event required data property` / `Data batch OHLCV required data property` | TE | `data.mjs:20` | A |
| `Data batch event kind must be append, update or correction` | TE | `data.mjs:34` | A |
| `Numeric column values required`, `Prepend bars required`, `Bar index`, `An edit cannot change time; reload to insert/reorder`, `Index update bounds`, `Volume`, `Finite-count index required`, `Index input length`, `Finite-count index cannot also sum volume`, `Block update bounds`, `Positive bucket count required`, `Aggregate bounds must not be NaN`, `Virtual timeframe/origin or listener error callback`, `Data batch array accessor data property` | TE/RE | `data.mjs:129, 155, 181/257, 261, 77, 78, 92, 55, 54`; `block-index.mjs:16`; `data.mjs:281, 283, 99, 32` | X |
| `OHLCV array length changed during snapshot` | RE | `data.mjs:108`; `api.mjs:45` | X |
| `Bar store changed during update snapshot` | E | `data.mjs:260` | X |
| `Data batch source changed during snapshot; stale transaction discarded` (code `SOURCE_CHANGED`) | E | `data.mjs:190` | X |
| `Internal data batch ledger requires unconditional publication` | TE | `data.mjs:193` | X |
| `Listener function required` | TE | `data.mjs:178` | J |
| `Data event kind required` | TE | `markets.mjs:201` | S |
| `Update is only the current bar` | RE | `markets.mjs:205` | S |
| `Correction requires an existing timestamp` | RE | `markets.mjs:206` | S |
| `Unknown data event` | TE | `markets.mjs:207` | S |
| `Invalid symbol metadata` | TE | `markets.mjs:30` | S |
| `Timezone string, at most 128 characters required` | TE | `markets.mjs:9` | S |
| `ISO date and HH:mm[:ss] required` | TE | `markets.mjs:21` | S (session calendars) |
| `Nonexistent local time at DST boundary` | RE | `markets.mjs:25` | S |
| `Ambiguous local time` | RE | `markets.mjs:26` | S |
| `Ordered nonoverlapping sessions required` | RE | `markets.mjs:133` | S |
| `Calendar period starts on a nonexistent local date` | RE | `markets.mjs:113` | S |
| `Calendar provider and positive cache size required` / `Interval is milliseconds/day/week/month` | TE | `markets.mjs:122` / `:146` | X |
| `normalizeOHLCV`, `alignSeriesByTime`, `TickAggregator`, `demoCalendar` messages (`OHLCV rows dense array required`, `Timestamp string must use decimal notation`, `Point {time,value} required`, `Tick object required`, `Unknown synthetic market`, …; full list in the workspace/markets reader report) | TE/RE/E | `markets.mjs:34-198, 216` | J/T |

### 4.4 Ingestion (all `IngestionError`; the code is part of the contract)

| Message | Code | Where | Tier |
|---|---|---|---|
| `1–4096 ordered events required` (U+2013) | INVALID_INPUT | `ingestion.mjs:34`, `:36` | S |
| `Event object required` / `Event plain object required` / `Event unsupported field` | INVALID_INPUT | `:24-27` via `:40` | S |
| `Ordered append/update/correction required` | INVALID_INPUT | `:40` | S |
| `OHLCV object required` / `OHLCV plain object required` / `OHLCV unsupported field` | INVALID_INPUT | `:24-27` via `:41` | S |
| validateBar messages rewrapped: `Every OHLCV field must be finite`, `Time must be an exact UTC millisecond integer in the Date range`, `Invalid OHLCV envelope` (`cause` = the original error) | INVALID_INPUT | `:41` | S |
| `Length-changing batches require host realignment of external values` | EXTERNAL_ALIGNMENT | `api.mjs:100` | S |
| `Model has an active async ingestion fence` | BUSY | `:9` (configure, load, compaction, workspace source) | S/R |
| `Ingestion has an active async lease or drain` | BUSY | `:66` | R/A |
| `Drain or cancel pending data before async preparation` | PENDING_DATA | `:114` (restore begin with pending events) | R |
| `Ingestion session closed or replaced` | CLOSED | `:65` | R/A |
| `Current history exceeds ingestion admission budget` | STORE_BUDGET | `:50` (also at restore source step via the facade) | R/A |
| `Ingestion schema/version/state`, `Pending count`, `Ingestion cursor/counter conservation`, `Ingestion completed cursor`, `Ingestion history/counter bounds`, `Last error shape`, `Running ingestion cannot retain a paused error` | INVALID_DOCUMENT | `:120, 123, 125, 126, 127, 52, 130` | R/A |
| `Ingestion policy object required` (and the `Ingestion policy` / `Packet` / `Last error` / `Ingestion document` / `Counters` / `Pending` families with ` object required`, ` plain object required`, ` unsupported field`, ` data properties required`) | INVALID_INPUT | `:23-31` | R/A |
| `Stream id: string limit 128` / `Stream id: reserved identifier` | INVALID_INPUT | `:45` (rewrapped TE) | A |
| `<key> integer range` (keys: generation, firstSequence, maxQueuedEvents, maxQueuedBytes, maxBatchEvents, maxStoredBars, maxStoreBytes, accepted, applied, cancelled, rejectedPackets, rejectedEvents, failedDrains, peakPendingEvents, peakPendingBytes, lastAppliedSequence, lastCancelledSequence), `Next sequence integer range`, `Pending sequence integer range` | INVALID_INPUT | `:32`, `:47-49`, `:122`, `:124` | R/A |
| `Configure data ingestion first` | NOT_CONFIGURED | `api.mjs:101` | A |
| `Drain or cancel pending data before reconfiguration` / `Cancel or drain pending data before restoration` | PENDING_DATA | `api.mjs:102` / `:110` | A |
| `Async ingestion lease active` | BUSY | `:77, 79, 108-110` | A |
| `Sequence/counter limit` | SEQUENCE_LIMIT | `:84` | A |
| `Batch exceeds configured stored-row/capacity-byte budget` | STORE_BUDGET | `:18` | J |
| `<String(cause.message).slice(0,256)>` (loadDataIngestion wraps non-IngestionErrors) | INVALID_DOCUMENT | `api.mjs:110` | A |
| `Dense event array required`, `Event array data entries required`, `Event data properties required`, `OHLCV data properties required`, `Event array length changed during snapshot` | INVALID_INPUT | `:37, 39, 28, 28, 42` | X |
| `Owner changed during batch snapshot`, `Owner changed while configuring ingestion`, `Owner changed during ingestion restoration`, `Ingestion owner changed during configuration`, `Ingestion owner changed during restoration` | SOURCE_CHANGED | `api.mjs:100`; `:63`, `:131`; `api.mjs:102`, `:110` | X |

**Gap:** readers did not enumerate every queue-specific `enqueue`/`drain` message (low-level, tier A). Specify these before implementing D1 for ingestion.

### 4.5 Indicators, parameters, modules, session studies

| Message | Class | Where | Tier |
|---|---|---|---|
| `Period must be 1..10000` | RE | `indicators.mjs:20` | S |
| `MACD fast < slow` | RE | `:137` | S |
| `Deviation` | RE | `:140` | S |
| `Multiplier` | RE | `:186` (keltner <0), `:187` (supertrend ≤0) | S |
| `Displacement` | RE | `:191` | S |
| `Fast < slow` | RE | `:196` ppo, `:202` chaikin, `:204` volumeOscillator | S |
| `SAR acceleration` | RE | `:207` | S |
| `Indicator id: string limit 128` / `Indicator id: reserved identifier` | TE | `:233` | S |
| `Indicator limit` | RE | `:233`; `api.mjs:198` | S |
| `Duplicate indicator id` | E | `:234`; `api.mjs:198` | S |
| `Unknown indicator: ${name}` (String(name), unbounded) | E | `:234` | S |
| `Indicator output byte limit` | RE | `:253`; `api.mjs:203`; `:228` (X) | S |
| `Missing indicator: ${id}` | E | `:242`; `api.mjs:213`, `:175` | S |
| `Output must be finite or NaN` | TE | `:277` (builtin overflow, §3.7.12) | S |
| `Indicator params` | TE | `indicator-params.mjs:5` | S |
| `Indicator params: object required` / `Indicator params: plain object required` / `Indicator params: unsupported field <key>` | TE | `:6` | S |
| `Indicator parameter count` | TE | `:8` | S |
| `Indicator parameter values` | TE | `:11` (booleans from typed `.flag`) | S |
| `Unsupported indicator module: <String(name).slice(0,128)>; requires a canonical builtin or linked factory` | UIE | `indicator-modules.mjs:7` (thrown at `:31`, `:32`) | S |
| `Indicator module name conflict` | E | `api.mjs:243` | A |
| `Indicator module id` / `Indicator module version` | TE | `indicator-modules.mjs:9-10` | A |
| `id: string limit 128` / `id: reserved identifier` | TE | `:10` | A |
| `Indicator module descriptor binding` | TE | `:34`, `:36` | R |
| `Volume-direction factor/shift` | RE | `trusted-studies.mjs:7` | S (if pressure ported, D10) |
| `Volume-direction checkpoint` (plus `Volume-direction checkpoint: object required` / `plain object required` / `unsupported field <key>`) | TE | `trusted-studies.mjs:14-15` | R |
| `Primitive finite session study params` | TE | `session-studies.mjs:56` | S |
| `sessionMs conflicts with calendar/anchorTime` | TE | `:58` | S |
| `VWAP anchor UTC milliseconds` | RE | `:59` (also pivots with anchorTime) | S |
| `Session duration` | RE | `:60` | S |
| `Session kinds require calendar` / `Unique comma-separated session kinds` / `Session kinds string limit` | TE | `:61` | S |
| `VWAP source` | TE | `:62` | S |
| `VWAP deviation multiplier` | RE | `:63` | S |
| `Session bucket overflow` | RE | `:69` | S |
| `Session study numeric overflow` | RE | `:78` (`:86, 88, 97, 98`) | S |
| `Session variance` | RE | `:87` | S |
| `Session volume` / `Session OHLC` | RE | `:86` / `:97` | X |
| `<label> own data keys required` / `<label> missing <key>` / `<label> array limit` / `<label> array shape` / `<label> own data elements required` / `<label> string limit` (labels: `Session study params`, `Session options`, `Session window`, `Session exceptions`, `Session windows`, `Session weekdays`, `Session timezone`, `Session kind`, `Session date`, `Session calendar`, `Session checkpoint`) | TE | `:8-21` | S |
| `Session Unicode scalar` / `Session ISO date` / `Session HH:mm clock` / `Session kind without comma/outer whitespace` / `Unique weekdays 0..6 required` / `Session ambiguity earlier/later/reject` | TE | `:19` / `:22` / `:23` / `:26` / `:35` / `:37` | S |
| `Ordered nonoverlapping session windows` / `Session exception limit 512` / `Session calendar 64KiB limit` / `Ordered nonoverlapping sessions required` / `Overlapping adjacent session dates` | RE | `:26` / `:36` / `:37`, `:40` / `:50` / `:52` | S |
| `Session checkpoint count`, `… initial session`, `… missing count`, `… anchor`, `… excluded date`, `… bucket`, `… index`, `… initial state`, `… finite numbers`, `… volume/variance`, `… VWAP invariant`, `… level count`, `… pivot levels`, `… initial OHLC`, `… OHLC`, `… pivot invariant` (each prefixed `Session checkpoint `) | TE | `:103-121` | R |
| `Calculation chunk size` | RE | `indicators.mjs:241` | R |
| `Invalid indicator definition` | TE | `:235` | X (custom factories) |
| `Missing checkpoint` | E | `:265` | X |
| `Checkpoint size` | RE | `:227` | X |
| `Indicator calculation already running` / `Indicator calculation nesting limit (32)` | IBE | `:243` / `:222` | X |
| `Stale indicator calculation: source changed or owner replaced, removed, or disposed` | SSE | `:249` | X |
| `Indicator parameter data properties` | TE | `indicator-params.mjs:10` | X |
| `Indicator name: string limit 128`, `Indicator name: reserved identifier`, `Unique name and factory required`, `Indicator output arity` | TE | `:231`, `:276` | J |
| `Duplicate indicator module`, `Indicator module export count`, `Canonical indicator name: string limit 128` / `… reserved identifier`, `Causal indicator factory and checkpoint validator required`, `Module checkpoint index`, `Module checkpoint validator must be synchronous`, `Module checkpoint validation failed or mutated state`, `export name: …`, `Indicator module export name`, `Indicator module state version`, `Indicator module: …` families | TE/RE | `indicator-modules.mjs:9-46` | J |
| `Trusted factory expression, at most 64KiB` / `Factory function required` | TE | `api.mjs:249` / `:250` | J |

### 4.6 Native checkpoint containers and checkpoint-state validation

| Message | Class | Where | Tier |
|---|---|---|---|
| `Native checkpoint record byte limit` | RE | `native-checkpoints.mjs:8`, `:10` | R (and post-restore S, D2) |
| `Native checkpoint total byte limit` | RE | `:16`, `:18` | R (and post-restore S, D2) |
| `Native checkpoint Unicode` / `Native checkpoint plain state` / `Native checkpoint array shape` / `Native checkpoint reserved key` / `Native checkpoint own data fields` | TE | `:9` / `:10` | R |
| `Native checkpoint state limit` | RE | `:10` | R |
| `Native checkpoint serialization changed` / `Native checkpoint validator mutated state` / `Native checkpoint context` / `Native checkpoint entry ownership` | TE | `:13` / `:28`, `:35` / `:23` / `:44`, `:46` | X |
| `Native checkpoint index` | RE | `:28` | X |
| `Native checkpoint disposed` | E | `:24` | X |
| `Native checkpoint changed during validation` | SCE | `:24` | X |
| `Native checkpoint history length` (RE) / `Native checkpoint history count` (TE) / `Native checkpoint history boundary` (TE) / `Native checkpoint entry count` (RE) | RE/TE | `:35`, `:44` | T |
| `Compaction requires an active unmodified checkpoint map` / `Compaction requires an unmodified checkpoint Map` | TE | `:55` / `:56` | X |
| `Native params entry owner` / `Native params checkpoint ownership` | TE | `:72` / `:73` | A |
| `Native params entry commit stale` | E | `:75` | A |
| `Checkpoint state record`, `Checkpoint state keys`, `Checkpoint state number`, `Checkpoint output number`, `Checkpoint session`, `Checkpoint state integer`, `Checkpoint state array`, `Checkpoint previous OHLC` | TE | `checkpoint-validation.mjs:63-73` | R |
| `Checkpoint smoothing state`, `Checkpoint extreme queue`, `Checkpoint extreme queue head`, `Checkpoint extreme pair`, `Checkpoint extreme ordering`, `Checkpoint empty extreme queue` | TE | `:81-92` | R |
| `Checkpoint VWMA window`, `… head`, `… pair`, `… product`, `… volume`, `… counters`, `… sums`, `… compensation`, `… invalid sum`, `… sum status`, `… canonical sums`, `… sum consistency` (each prefixed `Checkpoint VWMA `) | TE | `:97-108` | R |
| `Checkpoint builtin name`, `Checkpoint initial state`, `Checkpoint missing smoothing state`, `Checkpoint missing rolling state`, `Checkpoint missing extreme state`, `Checkpoint paired state` | TE | `:128-137` | R |
| `Checkpoint Aroon latest bar`, `Checkpoint negative volume`, `Checkpoint direction`, `Checkpoint pivot levels`, `Checkpoint SAR state`, `Checkpoint SAR history` | TE | `:146, 151, 158, 167, 168` | R |

### 4.7 Model and layout (`model.mjs`)

| Message | Class | Where | Tier |
|---|---|---|---|
| `Panels, width, visible bars or precision` | RE | `:140` | S (nativeInit options) |
| `BarStore required` | TE | `:141` | X |
| `Theme value: string limit 256` | TE | `:141` | S |
| `Axes array required` | TE | `:146` | S |
| `Panel limit` | RE | `:148` | S |
| `Unique panel id and positive weight` | E | `:148` | S |
| `Panel layout change during drawing transaction` | E | `:148`, `:164` | A |
| `Panel axis visibility/side` | TE | `:149` | S |
| `Panel label, inverted, formatter or range` | TE | `:149` (axes reuse it, `:227`) | S |
| `Panel scale/range` | RE | `:149` (axes reuse it) | S |
| `Missing panel` | E | `:152`, `:173` | A |
| `Panel projection change during drawing transaction` | E | `:152` | A |
| `Chart disposed` | E | `:154, 171, 189, 236, 278, 280, 286` | S |
| `Panel order dense array required` | TE | `:155` (`:45-51`) | A |
| `Panel order must contain every current panel exactly once` | TE (length) / E (duplicate or missing) | `:156` / `:158` | A |
| `Panel layout change during active gesture` | E | `:42` | A |
| `Cannot remove the last panel` / `Panel is referenced by series` / `Panel is referenced by axis` / `Panel is referenced by an active drawing transaction` / `Panel is referenced by drawing history` | E | `:174-178` | A |
| `Missing indicator` / `Indicator has no bound series` / `Missing placement panel` / `Missing placement axis` / `Indicator placement during drawing transaction` | E | `:190` / `:193` / `:203, 207` / `:203, 207` / `:212, 215, 217` | A |
| `Indicator placement record required` / `Indicator placement fields` / `Indicator placement panel required` / `Indicator placement axisId data field required` | TE | `:57` / `:58` / `:59` / `:60` | A |
| `Interaction controller drawing target must be writable own data` | TE | `:213`; `api.mjs:114`, `:131` | X |
| `Missing axis panel` | E | `:226` | S (options axes) |
| `Axis side/visibility/format/width` | TE | `:228` | S |
| `Independent percent axis requires an explicit nonzero base` | RE | `:230` | S |
| `Axis limit` | RE | `:233` | S |
| `Duplicate axis` | E | `:233` | S |
| `Axis layout change during drawing transaction` | E | `:233`, `:245` | A |
| `Missing axis` | E | `:234` (setAxis), `:345` (fromScreen) | A/V |
| `Axis projection change during drawing transaction` | E | `:234` | A |
| `Axis is referenced by series or drawing history/transaction` | E | `:238`, `:243` | A |
| `Missing drawing panel` / `Missing drawing axis binding` / `Missing or mismatched drawing series binding` | E | `:255` / `:256` / `:257` | S |
| `Missing series axis in panel` | E | `:262` | S |
| `symbolId belongs to externally aligned values; store/indicator series use primary symbol` | TE | `:263` | S |
| `Series style/visibility` | TE | `:266` | S |
| `Unique series id and existing panel required` | E | `:267` | S |
| `Candles/OHLC use primary store OHLCV` | TE | `:268` | S |
| `Unknown series type` | E | `:269` | S |
| `Series chooses external values or indicator output` | TE | `:270` | S |
| `Values must be aligned Float64Array` | TE | `:271` | A |
| `Series source` | TE | `:272` | S |
| `Missing indicator output` | E | `:272`, `:282` | S |
| `Series plot offset` | RE | `:273` | S |
| `Series limit` | RE | `:276` | S |
| `Duplicate series` | E | `:276` | S |
| `Aligned values and existing series required` / `External values require a general non-indicator series` | TE | `:278` | A |
| `Visible range` | RE | `:295` | S |
| `Zoom factor` | RE | `:297` | V |
| `Chart needs at least 100 × 80 CSS pixels` (U+00D7) | RE | `:333` | S/V |
| `Log scale requires strictly positive visible data` | RE | `:312` | S/V |
| `Log scale requires a strictly positive visible range (adjust padding/range)` | RE | `:315` | S/V |
| `Percent base cannot be zero` | RE | `:316` | S/V |
| `Axis transform overflow` | RE | `:318` | S/V |
| `Axis transform has no representable span` | RE | `:320` | S/V |
| `Axis projection overflow for visible values` | RE | `:328` | S/V |
| `<label> own data slot required` (labels: `Panel owner`, `Panel`, `Axis owner`, `Axis`, `Chart`, `Indicator engine`, `Drawing store`, `Interaction controller`, `Series`, `Drawing`, `Drawing target`), `Chart disposed own data slot required`, `<label> dense array required` (other than `Panel order`), `<label> owner changed` (SSE), `Owner guard callback required`, `Interaction controller pointers map required`, `Chart series owner is not writable`, `Series own data fields required`, `Drawing target own data fields required`, `Drawing axisId must be own data` | TE/SSE | `:19-125`, `:241` | X |
| engine-specific constructor errors (e.g. `panels:null`) | TE | `:140`, `:146` | class only |

### 4.8 Drawings

| Message | Class | Where | Tier |
|---|---|---|---|
| `Drawing type` | TE | `drawing-validation.mjs:8` | S |
| `Drawing anchors` | TE | `:9`; `drawing-translation.mjs:63` | S |
| `Anchor time/price must be finite and within Date range` | TE | `:10` | S |
| `Position anchors require shared start/entry and positive time extent` | RE | `position-drawing.mjs:6` | S |
| `Position requires ordered entry/stop/target and finite positive risk, reward and ratio` | RE | `position-drawing.mjs:7` | S |
| `Drawing visible must be boolean` | TE | `:12` | S |
| `Locked must be boolean` | TE | `:13` | S |
| `Stroke width` | RE | `:14`; `drawing-style-patch.mjs:8` | S |
| `Drawing count limit` | RE | `drawings.mjs:20` | S |
| `Drawing points/text limit` | RE | `drawings.mjs:20` | S |
| `A drawing transaction is already active` | E | `drawings.mjs:23` | V |
| `Duplicate drawing id` | E | `drawings.mjs:32` (add) | S |
| `Duplicate drawing id` | TE | `drawing-translation.mjs:53`, `:64` (group edits) | S |
| `Missing drawing` | E | `drawings.mjs:33`; `drawing-translation.mjs:75` | S |
| `Drawing is locked` | E | `drawings.mjs:33`; `drawing-translation.mjs:66` | S |
| `Commit or cancel before saving` | E | `drawings.mjs:37` | S |
| `Drawing document: string limit <maxDocumentChars>` | TE | `drawings.mjs:11`, `:39` | S |
| JSON grammar error (engine text) | SE | `drawings.mjs:39` | S (class only) |
| `Unsupported drawing document` | TE | `drawings.mjs:39` | S |
| `Drawing visibility requires document version 4` / `Position drawings require document version 3` / `Bound drawings require document version 2` | TE | `position-drawing.mjs:33` / `:34` / `:35` | S |
| `Duplicate drawing ids` | TE | `drawings.mjs:40`; `workspace.mjs:47` | S |
| `Cannot load during a gesture` | E | `drawings.mjs:40` | S |
| `Drawing group edit requires no active gesture or transaction` | E | `drawing-translation.mjs:46` | S |
| `Drawing group edit plain array required` / `Drawing group edit plain record required` / `Drawing group edit fields` | TE | `:10` / `:9` / `:9` | S |
| `Drawing group edit array limit/shape` / `Drawing group edit requires 1..128 ids` | RE | `:10` / `:52` | S |
| `Drawing visibility boolean required` / `Finite deltaTimeMs and deltaPrice required` | TE | `:54` / `:55` | A |
| `Drawing duplication serial` / `Drawing group edit point limit` / `Drawing group edit resource limit` / `Drawing duplication resource limit` / `Drawing duplication ID exhaustion` / `Drawing duplication document limit` | RE | `:61` / `:63` / `:75` / `:78` / `:80` / `:82` | A/S |
| `Drawing group edit requires identical panel/axis/series binding` / `Missing or mismatched drawing binding` | E | `:70` / `:71` | A |
| `Drawing group edit undo snapshot exceeds historyBytes` (budget class) / `Drawing group edit retained history resource limit` | RE | `:89` / `:91` | S |
| `Drawing style plain record required` / `Drawing style nonempty defined patch required` / `Drawing style fields` | TE | `drawing-style-patch.mjs:4` / `:6`, `:7` / `:7` | A |
| `History limit 1..10000` | RE | `drawings.mjs:16` | A |
| `Invalid drawing binding` | E | `drawings.mjs:40` | X |
| `Drawing hit tolerance must be 1..32 logical pixels` | RE | `drawings.mjs:99` | X |
| `Owner guard callback required`, `Drawing group edit own data fields required`, `Drawing group edit missing ${key}`, `Drawing group edit own data properties required`, `Drawing group edit managed owner required`, `Drawing group edit writable own state required`, `Drawing group edit managed store required`, `Drawing group edit writable history accounting required`, `Drawing group edit requires immutable managed drawings`, `Drawing group edit immutable anchors required`, `Drawing group edit immutable anchor required`, `Drawing group edit immutable style required`, `Drawing duplication writable serial required`, `Drawing group edit writable selection required`, `Drawing style own data fields required` | TE | `drawing-translation.mjs:8-85`; `drawing-style-patch.mjs:7` | X |
| `Drawing group edit owner changed`, `Drawing group edit controller owner mismatch` | E | `:11`, `:46` | X |
| `DrawingStylePresets` and `bound-drawings` messages (`Drawing preset …`, `Drawing identity …`, `Bound drawing …`) | TE/RE/E | `drawing-style-presets.mjs`, `bound-drawings.mjs` | J |

### 4.9 Scene, snap, interaction

| Message | Class | Where | Tier |
|---|---|---|---|
| `Crosshair snap mode: free, close or ohlc required` | TE | `crosshair-snap.mjs:9` | V |
| `Interaction controller required` | E | `api.mjs:147, 148, 150, 271` | X (native always has a controller) |
| `Drawing magnet mode: off, weak or strong required` | TE | `interaction.mjs:48` | V |
| `Drawing magnet radius must be 1..32 logical pixels` | RE | `:48` | V |
| `Unknown drawing tool` | E | `:54` | S/V |
| `Pointer hit tolerance must be 1..32 logical pixels` | RE | `:58` | V |
| `Chart disposed` | E | `interaction.mjs:12`, `:14`, `:46` | V |
| `Axis formatter output: string limit 256` / `Price formatter output: string limit 256` | TE | `scene-parts.mjs:11` / `:12` | J / X |
| `Actual interaction controller required` / `Interaction controller own model required` | TE | `interaction.mjs:10` / `:11` | X |
| `Interaction controller owner changed` | SSE | `interaction.mjs:13`; `api.mjs:123, 137, 139` | X |
| `key.toLowerCase is not a function` (V8 text; the others differ) | TE | `interaction.mjs:131` | class only |
| time-label `toISOString` / Intl errors (engine text) | RE | `scene.mjs:70`; `markets.mjs:12` | class only |

### 4.10 ChartAPI facade, study setup, compaction

| Message | Class | Where | Tier |
|---|---|---|---|
| `Chart disposed` | E | `api.mjs:35, 37, 71`; `compaction.mjs:41, 43`; `drawing-translation.mjs:42` | S (`engineClosed`) |
| `Unknown chart command or argument list` | TE | `api.mjs:74` | S |
| `Chart command argument count` | TE | `api.mjs:75` | S |
| `Values must be Float64Array or a JSON array` / `Finite numbers or null gaps required` | TE | `api.mjs:59` / `:60`, `:62` | A |
| `Panel patch object` | TE | `api.mjs:112` | A |
| `Unknown column source` | TE | `api.mjs:157` | S |
| `Series width` / `Series baseline` | RE | `api.mjs:158` / `:159` | S |
| `Series visible` | TE | `api.mjs:160` | S |
| `Candles/OHLC read store OHLCV; custom source/values/indicator need a general series` | TE | `api.mjs:162`, `:182` | S |
| `Missing series` | E | `api.mjs:168` | S |
| `Series label: string limit 256` | TE | `api.mjs:174`; `model.mjs:264` | S |
| `Indicator query index/mode` | RE | `api.mjs:235` | S |
| `Missing indicator` | E | `api.mjs:236`; `study-setup.mjs:26` | S |
| `Position drawing required` | TE | `api.mjs:256` | A |
| `Missing committed drawing` | E | `api.mjs:264` | S |
| `Missing or hidden drawing` | E | `api.mjs:266` | S |
| `Drawing text, at most 2000 characters` | TE | `api.mjs:272` | A |
| `Indicator parameter update cannot change output schema` | TE | `study-setup.mjs:40` | S |
| `Indicator parameter update cannot change plot offsets` | TE | `study-setup.mjs:42` | S |
| `Study setup schema/count` | TE | `study-setup.mjs:55` | A |
| `Study setup capacity` | RE | `:56` | A |
| `Duplicate study id` / `Study series requires an imported indicator` / `Duplicate study series id` | E | `:62` / `:67` / `:67` | A |
| `Study module version/codec mismatch` | TE | `:63` | A |
| `Positive keepLastBars and studyHistory restart required` | RE | `compaction.mjs:49` | A |
| `Compaction options plain data compactionRecord` (sic) / `Compaction options own data properties` | TE | `:9` | A |
| `Compaction pendingData policy` | TE | `:50` | A |
| `Compaction source peak byte limit` (invalidArgument) / `Compaction source peak byte budget` (budget) | RE | `:51` / `:73` | A |
| `Cannot compact an empty store` | RE | `:52` | A |
| `Compaction requires one exclusive live model and indicator engine` / `Compaction during drawing transaction` / `Compaction during interaction gesture` / `Compaction requires host realignment of external values` / `Compaction percent panel requires an explicit base` / `Compaction requires paused empty idle ingestion unless preserving retained pending data` | E | `:57` / `:60` / `:61` / `:63` / `:64` / `:68` | A |
| `Compaction pending source version changed` / `Compaction pending append must follow virtual tail` / `Compaction pending update must match virtual tail` / `Compaction pending correction requires retained timestamp` | E | `:18` / `:31` / `:32` / `:33` | A |
| `Actual ChartAPI required`, `Chart API own model required: owner changed`, `<label> own data slot required` (`Chart`, `Chart API`, `Interaction controller`, `Drawing target`), `Drawing target own data fields required`, `Interaction controller drawing target must be own data`, `Drawing target axisId must be own data`, `Data query own model required`, `Unsupported noncausal study query`, `Indicator factory changed requested params`, `Owner guard callback required`, compaction integrity messages (`Compaction ingestion policy plain data compactionRecord`, `Compaction ingestion counters plain data compactionRecord`, `… own data properties`, `Compaction owner own writable data required`, `Compaction ordinary array required`, `Compaction dense own data array`, `Compaction pending ring bounds`, `Compaction pending Float64 columns`, `Compaction pending kind column`, `Compaction pending event kind`, `Compaction BarStore required`, `Compaction owned Float64 columns`, `Compaction visible range`, `Compaction ordinary owned indicator entries`, `Compaction plain indicator entry`) | TE | `api.mjs:28-237`; `study-setup.mjs:33, 39, 44`; `compaction.mjs:9-72` | X |
| `Chart API owner changed`, `Data query API owner changed`, `Series presentation owner changed`, `Indicator owner changed during staging`, `Indicator removal owner changed`, `Compaction owner or source changed` | SSE | `api.mjs:36, 149, 173, 202, 217`; `compaction.mjs:8` | X |
| `Indicator params stale: owner changed during snapshot` / `… during metadata` / `… during staging`, `Study setup stale: owner changed during staging` | E | `study-setup.mjs:30, 33, 44, 68` | X |

### 4.11 Workspace and preflight

| Message | Class | Where | Tier |
|---|---|---|---|
| `Workspace missing field` | TE | `workspace.mjs:20` | S |
| `Workspace document limit` | RE | `:26` | S |
| `Workspace Unicode scalar` | TE | `:26` | S |
| `Workspace node/depth limit` | RE | `:27` | S |
| `Workspace finite number` | TE | `:27` | S |
| `Workspace array shape` / `Workspace reserved key` | TE | `:27` | S |
| `Workspace adjustment` | TE | `:32` | S |
| `Workspace schema/version` | TE | `:35` | S |
| `Empty workspace endpoints` / `Workspace source endpoints` | TE | `:36` | S |
| `Workspace chart configuration` | TE | `:37` | S |
| `Workspace view` | RE | `:37` | S |
| `Workspace symbol dataset units/adjustment` / `Workspace symbol formatter metadata` | TE | `:39` | S |
| `Workspace study/series limit` | RE | `:40` | S |
| `Duplicate workspace indicator` / `Workspace output schema` / `Workspace output offset` | TE | `:41` | S |
| `Missing workspace indicator` | E | `:44` | S |
| `Workspace drawing schema` | TE | `:47` | S |
| `Workspace drawing count` | RE | `:47` | S |
| `Workspace document byte limit` | RE | `:50` | S |
| `Actual ChartAPI required` / `Actual BarStore required` | TE | `:52` / `:53`; `native-workspace.mjs:11` | X |
| `Commit or cancel gestures before saving workspace` | E | `:52` | S |
| `Workspace custom formatters unsupported` | TE | `:52` | S (custom formatters are J) |
| `Workspace external values unsupported` | TE | `:55` | S |
| `Workspace dataset binding mismatch` / `Workspace source extent mismatch` | TE | `native-workspace.mjs:15` | R/A |
| `Workspace output schema/offset binding` | TE | `native-workspace.mjs:20` | R/A |
| `Workspace projected output byte limit` | RE | `native-workspace.mjs:20` | R/A |
| `Workspace source dimensions/version` | RE | `native-workspace.mjs:12` | R/A |
| `Workspace source columns` | TE | `native-workspace.mjs:13` | X |
| `Workspace own data slot: <key>`, `Workspace accessor: <key>`, `Workspace portable data required`, `Workspace plain data`, `Workspace own data fields`, `Workspace factory changed requested params`, `Shared workspace source` | TE | `workspace.mjs:18, 19, 27`; `native-workspace.mjs:13, 20` | X |
| `Workspace owner changed during save` | E | `workspace.mjs:59` | X |
| `Workspace preflight owner/source changed` | SSE | `native-workspace.mjs:9`, `:14` | X |

All validator messages from §4.2, §4.5, §4.7 and §4.8 also appear through workspace validation.

### 4.12 Restore pipeline (source, target, prepare)

| Message | Class | Where | Tier |
|---|---|---|---|
| `Workspace source active gesture` | E | `native-workspace-source.mjs:31` | R |
| `Workspace source host revision` | RE | `:13` via `:31` | R |
| `Workspace source byte limit` | RE | `:13`, `:31` | R |
| `Workspace source size` | TE | `:31` | R |
| `Workspace source stale: owner/data/configuration changed` | SSE | `:14` (via `:34`, `:46`, `:54`) | R |
| `Workspace source checkpoint count` | RE | `:13` via `:38` | R |
| `Workspace source drawing frame count` | RE | `:40` | R |
| `Workspace source drawing frame` | TE | `:40` | R |
| `Workspace source logical bytes` / `Workspace source logical byte limit` | RE | `:44` | R |
| `Workspace source admission work` | RE | `:47` | R |
| `Workspace source copy slice` | RE | `:53` | R |
| `Workspace source copy incomplete` | E | `:54` | R |
| `Workspace source actual API/model required` / `Workspace source controller binding` / `Workspace source actual BarStore required` / `Workspace source numeric buffer` / `Workspace source column length` / `Workspace source drawing` | TE | `:31`, `:36`, `:37`, `:49` | X |
| `Workspace source capture closed` | E | `:45` | X |
| `Native workspace target metadata` | RE | `native-workspace-target.mjs:19` | R |
| `Native workspace target protocol` / `Native workspace target dataset binding` | TE | `:19` / `:20` | R |
| `Native workspace source length` / `Native workspace source max bars` / `Native workspace source version` / `Native workspace source time version` / `Native workspace combined byte limit` / `Native workspace retained source bytes` | RE | `:14` via `:21`, `:23` | R |
| `Native workspace target source settings` / `Native workspace target size` / `Native workspace target pixel limit` / `Native workspace target output byte limit` / `Native workspace ingestion document limit` / `Native workspace combined logical byte limit` | RE | `:21` / `:22` / `:22` / `:23` / `:24` / `:29` | R |
| `Native workspace pending ingestion` | TE | `:24` | X |
| `Native workspace target closed` | E | `:39` | R |
| `Native workspace target source extent` / `Native workspace target factory binding` | TE | `:43` / `:45` | R |
| `Native workspace checkpoint count` / `Native workspace checkpoint boundary` / `Native workspace canonical restore mismatch` | TE | `:51` / `:51` / `:55` | R |
| `Native workspace target not ready` | E | `:59` | R |
| `Native workspace target does not import source UI` | E | `:60` | X |
| `Native workspace target accessor` / `Native workspace factory changed metadata` | TE | `:16` / `:38` | X |
| `Native workspace indicator binding`, `Native workspace target changed`, `Native workspace target entry changed`, `Native workspace target output binding`, `Native workspace target configuration changed` | E | `:17`, `:48`, `:58` | X |
| `Prepare step size` | RE | `native-workspace-target.mjs:49`; `prepare-state.mjs:32` | R |
| `Prepare target slice` | RE | `prepare-state.mjs:29` | R |
| `Prepare incomplete input` / `Prepare not started` | E | `:30` / `:32` | R |
| `OHLCV UTC time` / `OHLCV increasing time` | RE | `prepare-state.mjs:34` | R |
| `Prepare protocol`, `Prepare input kind`, `Prepare indicators`, `Prepare duplicate indicator`, `Prepare output definition`, `Prepare series`, `Prepare timeframe/origin` | TE | `prepare-state.mjs:12-28` | X (forged metadata only) |
| `Prepare visible bars`, `Prepare indicator output budget`, `Prepare retained typed-byte budget` | RE | `prepare-state.mjs:12`, `:27` | X |

### 4.13 Engine-specific errors (compare name/class only; D8)
- **JSON grammar**: `JSON.parse` `SyntaxError` text (V8 `Unexpected end of JSON input`, JSC `JSON Parse error: Unexpected EOF`, QuickJS `unexpected token: …`). This includes the INVALID_DOCUMENT message wrapped by `loadDataIngestion`.
- **Calls before `nativeInit`**: `ReferenceError` (e.g. `nativeAPI is not defined`).
- **Property reads on `null`/`undefined`**: `prepend` whose last element is null (`data.mjs:157`); `update`/`correction` without a bar (`markets.mjs:205-206`); `key.toLowerCase`; `nativeAsyncCheckpointImport` on a workspace target.
- **Date**: `toISOString` on an invalid date (V8 `Invalid time value`, JSC `Invalid Date`, QuickJS `Date value is NaN`).
- **Intl**: an invalid time zone (iOS `invalid time zone: <tz>`, V8 `Invalid time zone specified: <tz>`), and JSC's invalid-date `date value is not finite in DateTimeFormat formatToParts()`.
- **Android shim**: RangeError `Invalid timezone/date`, IntE `Timezone bridge failed`, TE `time and timezone required` (`aster_jni.c:42-45`).
- **Host-generated messages** stay in Swift/Java and are not produced by the backend. Examples: Swift `BaroChartAsyncError.invalidProtocol(...)` strings, Java `JSONException`/`IllegalStateException` validation strings (`Workspace registration binding`, `Native packet …` decoder checks, …), and JNI failures (`Native argument size limit`, `QuickJS error`, …). The platform-consumers reader report lists them; §3.15.5 lists what they validate.


---

## 5. Numeric and formatting rules that need JS-compatible implementations

Every row is observable in a return value, a document, a label, a size limit, or an error message.

| # | Rule | Where | Rust note |
|---|---|---|---|
| 1 | `JSON.stringify`: shortest round-trip numbers, `-0`→`0`, NaN/±Inf→`null`, insertion key order, `undefined` omitted, compact escaping (§3.1.3) | B:144 scene, B:195 frame, N:46 packet metadata, `api.mjs:284` inspect, `drawings.mjs:11` documents, B:5/6/41/60 progress and descriptors, `model.mjs:344` geometryKey | Needs a ryu-js-compatible `Number::toString` and a JS-order JSON writer. Rust `Display` and `serde_json` differ. |
| 2 | `$asterNumber` markers for `-0`, NaN, ±Infinity | `checkpoint-validation.mjs:39` (stringify), `:17-24` (parse) | Workspace, studies, ingestion, checkpoints and restore metadata. |
| 3 | Android re-stringifies every result: `JS_JSONStringify`, `undefined`→`null`, string results double-encoded; Java parses `'['+text+']'` | `aster_jni.c:60`; `BaroChartEngine.java:74, 1098` | Under the JSON seam (§6.4), Rust returns JSON text with JS number formatting. |
| 4 | iOS reads results through `JSValue.toDictionary/toArray/toDouble`; NaN survives | `BaroChartEngine.swift`; `BaroChartEngine+Typed.swift:49, 193-200` | A Rust `Value` must carry non-finite doubles to Swift. |
| 5 | `toPrecision(15)` for the accessibility close when no symbol is set | B:98 | Exponential iff `e<-6 \|\| e>=15`; ties pick the larger value (`123456789012344.5`→`123456789012345`). |
| 6 | `toFixed(priceDecimals)` symbol price formatter | `markets.mjs:33` via `api.mjs:277` | Exact binary value; ties away from zero; `-0`→`0.00`; ≥1e21 → `Number::toString`. |
| 7 | Axis labels: `toFixed(precision)` or `toExponential(precision)` (`tickFormat:'scientific'`), with prefix, `%` and suffix | `scene-parts.mjs:10-14` | `toExponential` always writes the exponent sign (`1.23e+2`, `0.00e+0`). |
| 8 | Drawing labels: `toPrecision(6)` (position, measurement), `toFixed(2/1/0)` (measurement), `(r*100).toFixed(1)` (fib), `String(r)` (time zones), `String(entry/stop/target)` | `drawings.mjs:66-72, 77, 79` | `.236*100=23.599999999999998` must print `23.6`. |
| 9 | Template string conversions in error messages: `${max}`, `${name}`, `${id}` | `contracts.mjs:5, 8-10`; `data.mjs:40`; `indicators.mjs:234, 242`; `api.mjs:213` | `2**60` → `1152921504606847000`; `{}` → `[object Object]`; arrays → `join(',')`. |
| 10 | `toISOString`: time axis `slice(5,16).replace('T',' ')`; accessibility `Time …`; `shiftDate` | `scene.mjs:70`; B:98; `markets.mjs:19` | Truncation toward zero (`new Date(-1.5)` → `…23:59:59.999Z`); expanded years `±YYYYYY`. Invalid dates throw engine-specific RangeErrors. |
| 11 | `Math.round` ties toward +∞ | `scene-parts.mjs:57` (crosshair index); `contracts.mjs:29` (colors, non-negative inputs only) | `-2.5→-2`, `-0.4→-0`. |
| 12 | `Math.min`/`Math.max` NaN propagation and `-0 < +0` | `data.mjs:47, 72-74`; `model.mjs:295-336`; `scene.mjs:15-73`; `drawings.mjs:49-52, 64`; `interaction.mjs:93, 127`; `ohlc-snap.mjs:8, 12`; `block-index.mjs` (strict compare; the first seen wins) | Provide `js_min`/`js_max`. Do not use `f64::min`/`max`. |
| 13 | `Math.sign` keeps `±0` | `indicators.mjs:170` (obv), `:172` (mfi); `trusted-studies.mjs:9` | `f64::signum(±0)` is `±1`, which is wrong here. |
| 14 | `Math.hypot` (engine algorithm) | `interaction.mjs:40, 67, 93, 105`; `drawings.mjs:45-46, 105, 120` | V8: scale + Kahan. JSC (macOS, measured) and QuickJS (source): C `hypot`. Avoid exact-threshold tests (D5). |
| 15 | `Math.log`/`Math.exp` | `model.mjs:317` (log axis); `interaction.mjs:127` (wheel) | Platform libm; use a same-platform oracle or a 1-ulp tolerance. |
| 16 | `Math.fround` projection check; f32 clamp `3.4028234663852886e38` | `model.mjs:327-328` | `as f32 as f64`. |
| 17 | LCG `Math.imul(s,1664525)+1013904223 >>> 0`, `s/4294967296` | `data.mjs:297-303`; `prepare-state.mjs:33` | `u32` wrapping ops; seed `>>>0` coercion. |
| 18 | RangeIndex merge `left+right` and dyadic query order; batch staging path sums; the append pre-check `root+v` | `data.mjs:62-91, 222-224, 250` | The same tree layout and loop order, or volumes and overflow decisions differ. |
| 19 | Rolling sums `sum += (x-old)`; FIFO re-sums; CCI deviation `reduce` in storage order; VWMA Neumaier; Welford; weighted sums from 0 | `indicators.mjs:21-34, 37-46, 49-68, 94-101, 140-156, 169, 181` | Keep the expression shapes; no FMA, no reassociation. |
| 20 | Label width: units summed then ×size, versus per-char ×size summed in `fitLabel` | `labels.mjs:8`, `:14` | Two different roundings (`53.28` vs `53.27999999999999`). |
| 21 | Layout arithmetic order (`row = space*((w/max)/total)`, `bottom = (top+row)-gap`, `top = bottom+gap`; `x()`, `index()`) | `model.mjs:336-343` | Left-associative. |
| 22 | Pinch, pan and body-drag formulas | `interaction.mjs:93-95, 109` | `(screenX+x)-startX` order. |
| 23 | `Number.isFinite`, `isInteger`, `isSafeInteger` never coerce | `contracts.mjs:9`; `data.mjs:44-45`; `indicators.mjs:20`; everywhere | Strings, booleans and null fail. |
| 24 | Deliberate coercions: zoom anchor `Math.max/min(anchor)` (ToNumber), `pan` uses `+`, `aggregate` `floor/ceil` | `model.mjs:297`, `:298`; `data.mjs:282` | `null` anchor = 0; a string delta → `Visible range`. |
| 25 | UTF-16 length limits and slices | `contracts.mjs:5` (64), `:8`; B:9/B:93 and `api.mjs:110` (256); `indicator-modules.mjs:7` (128); `drawings.mjs:95` (`text.length`) | Count code units, not bytes or chars. |
| 26 | UTF-8 byte estimates over UTF-16 (lone surrogate = 3, pair = 4) | N:7; `workspace.mjs:50`; `session-studies.mjs:19` | Must match Java `ScenePacket.utf8Length` (`BaroChartEngine.java:116`). |
| 27 | Exact JSON length accounting (`chars*2`) and node counts | `native-checkpoints.mjs:8-13`; `workspace.mjs:26-27`; `drawings.mjs:13, 21` | Depends on rule 1; boundaries are measured and tested at equality. |
| 28 | Code-point iteration (`for…of`) in label width and fitting | `labels.mjs:7-14` | Lone surrogates count as one code point. |
| 29 | JS `\s`, `trim`, `toLowerCase` | `labels.mjs:11`; `contracts.mjs:25, 33`; `checkpoint-validation.mjs:51`; `session-studies.mjs:26, 61` | The JS whitespace set (U+FEFF yes, U+0085 no); Unicode lowercase (Kelvin sign). |
| 30 | ASCII-only lowercase for the tz cache key | `markets.mjs:10` | Only the cache; not observable except through which spelling a formatter is built with. |
| 31 | Font size extraction `Number(match(/([0-9.]+)px/)[1] ?? 12)` | `labels.mjs:4`; `drawings.mjs:95` | `'1.2.3px'` → NaN propagates. |
| 32 | Date range bound `±8640000000000000` (inclusive) | `data.mjs:45`; `workspace.mjs:36`; `drawing-validation.mjs:10`; `markets.mjs:68, 87, 164`; `session-studies.mjs:59` | |
| 33 | `bytes = 96*capacity`; capacity doubles from 16 | `data.mjs:102, 124, 195-238`; `compaction.mjs:73`; `native-workspace-target.mjs:23`; `prepare-state.mjs:27` | |
| 34 | `Object.is` comparisons (NaN equals NaN, `+0≠-0`) | `frame-cache.mjs:18`; `interaction.mjs:21, 100`; `native-workspace.mjs:8`; `checkpoint-validation.mjs:113`; `study-setup.mjs:31`; `data.mjs:232`; `drawing-translation.mjs:72`; `native-workspace-target.mjs:15` | Use `to_bits` equality plus NaN equivalence. |
| 35 | `x \|\| 1` fallbacks (0, `-0`, NaN → 1) | `model.mjs:314, 315, 319, 336`; `interaction.mjs:67, 93`; `drawings.mjs:45` | |
| 36 | Float64 output buffers are NaN-filled (canonical `0x7ff8000000000000`) and stale values remain past n after a same-capacity reset | `indicators.mjs:254`, `:229` | Visible through `nativeIndicatorBuffer` bytes and async copies only. |
| 37 | Error-message slices: `String(message).slice(0,256)` | B:9, B:93; `api.mjs:110` | May split a surrogate pair; Swift validates `utf16.count<=256`. |
| 38 | Host-side (unchanged): Dynamic Type `String(format:"%.3f")`, Android `BigDecimal.valueOf(size).stripTrailingZeros().toPlainString()`, Java tz `%04d` years | `BaroChartUIView.swift:134-136`; `BaroChartView.java:138-139`; `BaroChartEngine.java:1251` | They produce font strings the core must accept (`portableFont`). |

---

## 6. Platform seam notes

### 6.1 iOS today (JavaScriptCore)
- **Construction**: `BaroChartEngine.init(bundleURL:count:options:)` creates a `JSContext`, evaluates the bundle, then calls `nativeInit` (`BaroChartEngine.swift:1405-1440`). Typed `init(options:)` reads `Bundle.module` (SwiftPM only; a missing resource maps to the misleading `invalidScene`).
- **Calls**: `call(name,args)` → `objectForKeyedSubscript(name)`. An undefined function → `.javaScript('Missing function: <name>')`; otherwise `call(withArguments:)`. A pending `context.exception` is cleared and mapped to `.javaScript(exception.toString())`.
- **`command()`** (`:1612-1675`): an owner-thread check and a closed check, then a BUSY gate. While an async, workspace or params job is active, ingestion ops and `compactData` fail with `IngestionError[BUSY]: Native asynchronous job is active`. Then the 9 ingestion ops are routed to `nativeDataIngestionCommand`, everything else to `nativeCommand`; receipts are validated and observers notified (§3.13.10).
- **JSValue surface used** (a replacement `Value` must support all of it):
  - function lookup by name;
  - `call(withArguments:)`;
  - exception read and clear;
  - `forProperty('name' | 'code' | 'message' | 'error' | 'result' | 'removed' | 'changed' | 'created' | 'invalidationFailed')`;
  - `isObject/isBoolean/isNumber/isString/isArray/isNull/isUndefined`;
  - `toDouble/toBool/toString/toDictionary/toArray`;
  - the typed-array C API for `Float64Array` copies (`BaroChartEngine.swift:141-156`).
- **Public leaks of JSC types**: `public var context: JSContext`; `call()`, `command()`, `addIndicator(_:_:_:)` and `setIndicatorParams(_:_:)` return `JSValue`. `BaroChartFrameRenderer` probes `engine.context.objectForKeyedSubscript("nativeRenderFrameJSON")` to choose its cached path (`BaroChartFrameRenderer.swift:67`).
- **Internal JSC coupling.** These are all private, but the backend switch must cut them **(checked)**:
  - `BaroChartWorkspaceSourceRecord` holds a `JSContext` (`BaroChartEngine.swift:389-396, 425`).
  - `asterTypedBytes(_ value: JSValue, _ context: JSContext, count:)` copies typed arrays (`:141`).
  - The async-data, workspace-target and params-target workers each create a `JSVirtualMachine` (`:525, :895, :1222`).
  - `private protocol BaroChartContextRuntime` (`:304-309`) only manages worker-runtime retirement and capture leases (`retire`, `acquireCaptureLease`, `releaseCaptureLease`). It can keep that role, but a Rust backend needs a new call protocol. The Qwen review suggested promoting this protocol instead (Appendix D).
- **Views**:
  - `BaroChartUIView` calls `nativeResize` before every pointer and key call, `nativePointer` (tolerance 22), `nativeKey`, `nativeHoverExit`, `command('zoom')`, `nativeThemeFont` + `setTheme({font})`, and `nativeAccessibilityText([true,'uikit'])` after every draw.
  - `BaroChartFrameRenderer` calls `nativeRenderFrameJSON(uuid, w, h, force)` and composes base and stable bitmaps.
- **Workspace restore**: the target is a new `JSVirtualMachine`/`JSContext` on a worker. The source stays on the main thread. A process-wide admission allows 2 jobs and 768 MiB. Details in §3.15.5.
- **Time zones**: the system JSC ICU `Intl`; there is no host callback.
- **`close()`** (`:1578-1598`): cancel jobs → frame cleanups (`nativeReleaseFrameCache(token)`) → `nativeReleaseFrameCaches()` → `nativeReleaseDataIngestion()` if defined → `closed=true`. A JS failure aborts `close` and leaves the engine open.

### 6.2 Android today (QuickJS through JNI)
- **JNI entry points** (`aster_jni.c`):
  - `create(bundle)`: a tracking allocator, a 768 MiB memory limit, `Float64Array` class id, `asterZonedParts` registration, the Intl shim, bundle evaluation (≤1 MiB);
  - `free(handle)`;
  - `call(handle, name, argsJSON)`: `JS_ParseJSON(args)`, ≤16 arguments, `globalThis[name](...)`; exceptions become `IllegalStateException(JS_ToCString(e))` (`'QuickJS error'` if that conversion fails); the result is `JS_JSONStringify(result ?? null)`;
  - `packet(...)`: `nativeScenePacket` → `{metadata ≤1 MiB, numbers: intrinsic Float64Array ≤64 MiB}` → `Object[]{String, double[]}`;
  - `readBuffer`/`writeBuffer`/`BaroChartColumns.writeSlice`/`indicatorSlice`: Float64 slice copies with exact length checks;
  - `memoryUsed`/`Peak`/`Stats`.
- **`BaroChartEngine.invoke(name, args...)`** (`BaroChartEngine.java:74`): checks owner, cleanup state, closed and closing; name 1..128 chars; ≤16 arguments; `new JSONArray(args).toString()` → JNI → parses `'['+text+']'`. `invokeHandle` (static, no owner check) serves job hosts.
- **`command()`** (`:213-253`): Java-specific BUSY messages (`Compaction has an active asynchronous calculation`, `Data ingestion has an active asynchronous calculation`), the ingestion envelope → `IngestionException(code, message)`, then receipt validation and notification.
- **Views**: `BaroChartView` uses the packet path by default. A failed frame packet leads to `releaseFrameCache(token)`, a forced base and the JSON fallback, with a 500 ms back-off. Frame tokens are `'android-view-<n>'`. Input mapping is in §3.12.8.
- **Time zones**: the shim forwards to Java `zonedParts` (java.time); see §3.5.2.
- **Workspace restore**: `WorkspaceRestoreJob` creates the target as a separate handle with `create(sourceBundle)`; `publish` swaps `handle`.
- **`close()`**: runs close observers, sets `handle=0` and calls JNI `free`. It does **not** call `nativeReleaseFrameCaches` or `nativeReleaseDataIngestion`.

### 6.3 Logic that stays in Swift/Java regardless of backend
- Revision counters and observer notification rules (§3.13.10), and the BUSY gates.
- Receipt validation: deletion counts, duplicate rows, batch receipts, workspace descriptors and receipts, params receipts.
- Error classification (§4.0). It needs the exact `name: message` text from the backend.
- Bitmap caches, layered composition, the cache budget (iOS 128 MiB, Android 64 MiB), and drawing with CoreGraphics/Canvas (including platform differences: iOS rects fill with `fill ?? color`, Android with `color`; invalid colors are white on iOS and fail the frame on Android).
- Input mapping, accessibility labels and actions, Dynamic Type/fontScale ownership records.
- Async, workspace and params job state machines, timeouts, cancellation, cleanup registries (Option A).

### 6.4 Where a backend switch fits (proposal)
The cleanest seam is the contract Android already uses. Make it explicit and shared:

```rust
enum Value { Undefined, Null, Bool(bool), Number(f64), String(Wtf16), Array(Vec<Value>), Object(OrderedMap<Wtf16, Value>) }

struct ScriptError { name: String, message: Wtf16, code: Option<String> }

trait ChartCoreBackend: Send {
    fn create(empty: bool, tz: Box<dyn Fn(i64, &str) -> Result<ZonedParts, TzError> + Send>) -> Result<Self, ScriptError> where Self: Sized;
    fn call(&mut self, name: &str, args: &[Value]) -> Result<Value, ScriptError>;
    fn packet(&mut self, mode: &str, token: Option<&str>, w: f64, h: f64, force: bool) -> Result<(String, Vec<f64>), ScriptError>;
    fn read_slice(&mut self, ticket: u64, slot: u32, offset: u32, count: u32) -> Result<Vec<f64>, ScriptError>;
    fn write_slice(&mut self, slot: u32, offset: u32, data: &[f64]) -> Result<(), ScriptError>;
    fn supports(&self, cap: Capability) -> bool;
}
```

Notes on the sketch:
- `Value` is backend-neutral: WTF-16 strings, `f64` that keeps `-0`, NaN and ±Infinity, and objects as ordered maps in JS key order (§3.1.3).
- `ScriptError` reaches the host as `name + ": " + message`. `code` carries the `IngestionError` and `UnsupportedIndicatorError` codes (§4.0).
- `create` replaces "evaluate the bundle". `empty == true` builds a target runtime that has not run `nativeInit` (restore Option A).
- `call` invokes a `native*` global by name, with the same arguments and results as the JS bridge.
- `packet` is the F64 display packet (§3.11.8).
- `read_slice`/`write_slice` are the workspace copy slices (Option A). Borrowed views become owned copies.
- `supports` answers for `FrameCache`, `Packet`, `AsyncJobs`, `ParamsJobs`, `JsIndicators` and `Exploration`.

Rules the backend must keep (the GLM, DeepSeek and Qwen reviews informed these; Appendix D):
- **Thread affinity.** The engine is `Send` but not `Sync`. A restore target built on a worker is installed into the owner engine at publish: iOS moves the context at `BaroChartEngine.swift:779`, and Android swaps the handle at `BaroChartEngine.java:995` (async data at `:1207`). All three reviews proposed `!Send`, which would block this hand-off. Each engine is still called from one thread at a time: the restore worker until publish, then the owner thread (§1.1).
- **Panics.** Build with `panic = "unwind"` and wrap every `extern "C"` entry point in `catch_unwind`, turning a panic into a `ScriptError`. Under `panic = "abort"`, `catch_unwind` cannot intercept anything: a test with rustc 1.96 aborted with exit code 134. So the GLM review's "abort in release, but catch first" cannot be implemented.
- **Output.** Write every emitted byte with the hand-written JS-compatible writers (§3.1.1, §3.1.3), as all three reviews advise. In CI, reject `format!("{:.N}")`-style precision formatting, `serde_json` serialization, `f64::mul_add`, `f64::min`/`max`, `f64::round` and `f64::signum` in ported code. The Qwen review proposed the CI ban; the list follows §3.1.1.
- **Input.** The GLM and Qwen reviews suggest `serde` for input, but `serde_json` defaults cannot keep Absent/Null/Value apart (§3.1.4) or reproduce `JSON.parse` (§3.1.3): duplicate keys keep the last value at the first position, `__proto__` becomes an own key, `1e400` becomes Infinity, and lone surrogates are allowed. Use a hand-written `Value` parser.
- **No silent fallback.** The backend is fixed per engine at creation (D12).

Host-side changes:
- **Swift**:
  - Introduce a `BaroChartBackend` protocol inside `BaroChartEngine`, with a JSC implementation (today's code) and a Rust implementation.
  - Replace `JSValue` in public signatures with a `BaroChartValue` enum, or add `Value`-returning variants and deprecate the `JSValue` ones.
  - Make `context` unavailable (or nil) on the Rust backend.
  - `BaroChartFrameRenderer` switches from the context probe to `backend.supports(.frameCache)`.
  - Typed `init(options:)` should not require a bundle URL when Rust is selected.
- **Java**: swap the JNI `call`/`packet`/`readBuffer`/`writeBuffer`/`create`/`free` natives for Rust FFI functions with identical signatures. `invoke` and `scenePacket` stay as they are. `WorkspaceRestoreJob.Host.createTarget` calls `create(empty=true)`.
- **Time zones**: pass a host callback (§3.5.2) so iOS keeps ICU behaviour and Android keeps java.time behaviour (D6).
- **Restore**:
  - Option A: keep the host job classes; the Rust backend implements the tier-R functions over two Rust engine instances.
  - Option B: add a native `restore_workspace(doc, binding, revision, cancel, progress)` and simplify the host jobs. Either way the observable contract in §3.15.4–3.15.6 holds.
- **Capability routing**: if an engine needs a JS-only feature (custom indicator source, linked modules other than any ported one, async jobs not ported), the host either selects the JS backend for that engine at creation or surfaces a defined error. The first choice exists only when both backends ship (D12). Neither choice is a fallback after a Rust error.

### 6.5 Platform divergences to pin in differential tests
- **Argument encoding**: iOS dictionaries arrive in random key order and may carry NaN; Android JSON keeps insertion order and never carries NaN (`org.json` rejects it first). Compare canonicalized key order when a host dictionary's order leaks into documents (params, symbol, drawing style).
- **`__proto__` keys**: dropped or prototype-setting on iOS; an own key (`unsupported field __proto__`) on Android.
- **Time zones**:
  - year padding: iOS `'999'` vs Android `'0999'`;
  - invalid zone text: iOS `invalid time zone: X`, Android `Invalid timezone/date`;
  - invalid dates: iOS throws, Android maps them to 1970;
  - zone ids: Android accepts `Z`/`UTC+9`;
  - tzdata versions differ.
- **Lone surrogates**: preserved on iOS; replaced with `?` on Android (JNI UTF-8 conversion).
- **`StaleSourceError` classification**: `javaScript` on iOS, `UNAVAILABLE` on Android. Ingestion budget classification uses the code on Swift and the message on Java.
- **Typed crosshair parse**: Swift defaults missing fields (`0`/`''`); Java `getInt`/`getDouble` throw.
- **Typed `deleteDrawings` missing `changed`**: Swift `.javaScript`, Java `INVALID_ARGUMENT`.
- **Close**: iOS releases frame caches and ingestion through the core; Android only frees the handle.
- **Views**: tolerance 22 (iOS) vs 24/8 (Android); Android sends a tap pre-move; Android yields vertical drags to the parent; pointer id schemes differ.

---

## 7. Risks (ranked)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | JS number and string formatting is not bit-compatible (`Number::toString`, `toFixed`, `toPrecision`, `toExponential`, JSON escaping, UTF-16 lengths) | Documents, labels, accessibility text, error messages and checkpoint **size limits** diverge (`sma(10000)` passes or fails the 256 KiB record limit depending on decimal digits) | Step 0 property tests against V8, JSC and QuickJS; never use Rust `Display`; a ryu-js-style formatter plus an exact decimal expansion for the fixed forms. |
| 2 | Error identity drift (class, name, message, code) | Hosts classify by prefix and regex. One wrong class or word changes the typed error code (e.g. `Duplicate drawing id` is `Error` in `add` but `TypeError` in group edits) | Generate the Rust error table from §4; differential tests compare the full `name: message`. |
| 3 | IEEE evaluation-order and Math semantics (dyadic tree sums, Neumaier/Welford shapes, JS `min`/`max`/`sign`/`round`, no FMA) | Autoscale, volume buckets, indicator values and overflow decisions differ in the last bit; cascades into scene JSON | Keep expression shapes; `js_*` helpers; lint against `mul_add` and `f64::min/max`; run the readers' bit-exact corpora (7887 tree cases, 2933 indicator vectors). |
| 4 | Engine-dependent transcendental functions (`log`, `exp`, `hypot`) | V8-based oracles differ from on-device JSC/QuickJS by up to 1 ulp | Use same-platform oracles, or port the engine algorithm; avoid exact-threshold fixtures (D5). |
| 5 | Time zones and DST (ICU vs java.time; formatting; invalid inputs; tzdata versions) | Session studies, symbol time labels, accessibility time, calendar validation | A host callback seam (D6); pin tzdata in tests; port the three-sample `zonedEpoch` literally. |
| 6 | Restored-engine checkpoint budget and provenance (D2) | The same data succeeds on a fresh chart and fails after restore (`Native checkpoint total byte limit`), and the error is classified `invalidArgument` | Decide before freezing oracles; preferably fix in JS (convert at publish), then port. |
| 7 | Hidden identity semantics (undo commit identity, `SceneCache` identity keys, entry identity for async staleness, viewport/projection fingerprints, a new `nativeSize` object on every render) | Undo stack lengths, base/drawings null-protocol frames, restore staleness and gesture rollbacks differ | Model identities as generation counters exactly where JS compares objects; replay mutation scripts. |
| 8 | Lazy calculation and failure timing (layout computes indicators; errors appear at read time; partial outputs stay written) | Errors surface on a different call, so hosts report them differently | Keep the dirty-marking plus calculate-on-read architecture; test failure points. |
| 9 | Key-order semantics (array-index-first order, spread positions, `undefined` placeholders, Swift dictionary randomness) | Byte-different documents and inspect output; different first-error choice | An ordered map with JS key ordering; canonicalize host dictionaries in tests. |
| 10 | Restore staleness on render, resize or pointer moves (`nativeSize` identity, crosshair and view identity in `sourceRefs`) | Touching or redrawing during a restore fails it | Keep the behaviour (or document it in Option B); hosts may block input during a restore. |
| 11 | Unspecified tier-A modules if pulled into scope (`data-explorer.mjs`/`dataAt`, low-level ingestion queue messages, `resample`, async UI) | Implementations from guesswork | Spec them before implementing D1; otherwise reject with a defined error. |
| 12 | JS-only features (custom and linked indicators, async/params jobs) | Engines that need them cannot use the Rust backend | Capability flags plus a host fallback to the JS backend; port `pressure` (D10). |
| 13 | Dropping the X guards changes first-error precedence | A different message for multi-fault JSON inputs | Drop only guards that JSON or typed inputs cannot reach; keep the check order of reachable validators. |
| 14 | Lone surrogates and WTF-16 | Panics or rejections in Rust where JS accepts | Use WTF-16 strings end to end (D7). |
| 15 | Line-number drift | §3/§4 references go stale as the JS evolves | Treat this map as tied to the 2026-11-02 snapshot; regenerate after JS fixes (D2, D3, D9). |
| 16 | Adopting design-review shortcuts that break parity: structural document comparison, a 1-ulp indicator tolerance, quantized output, `floor(x+0.5)`, pinned portable math on device, `panic = "abort"` (Appendix D) | Silent drift from the JS oracle that the gates exist to catch; a panic that kills the host app | Treat Appendix D.2–D.3 as a do-not-adopt list; keep the byte-exact gates; check crate settings against §6.4. |
| 17 | Transition cost: dual maintenance (the Qwen review estimates about 25% overhead) and binary size while both backends ship (GLM) | JS core changes land without their Rust twin, so the oracle moves under the port; the 3 MB per-ABI budget is exceeded | Mirror every JS core change behind the same parity gate, or freeze the core during the port; measure size early (track S2) and decide D12 on the numbers. |

---

## Appendix A. Evidence and reusable probes

- **Reader groups**: bridge contract; platform consumers; data store; indicators; model/layout; scene; interaction; drawings; API; workspace/markets; restore pipeline; native checkpoints; study setup; ingestion.
- **Probe scripts** (session scratchpad, not persistent; copy them into the test tree when building the harness):
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/model-layout/spec.mjs`, `probe2.mjs`…`probe6.mjs` (createLayout, view state machine, errors)
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/scene/harness.mjs`, `t9.mjs` (cache invalidation sequences), `t10.mjs` (stale external values)
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/interaction-probe/probe1.mjs`, `probe2.mjs`, `probe3.mjs`
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/exp1.mjs`…`exp7.mjs`, `bundlecmp.mjs`, `cmds.mjs`, `dupcheck.mjs` (API)
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/restore-pipeline-spec-r7/harness.mjs` and its `probe-*.mjs`
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/critic/probe2.mjs`…`probe7.mjs`
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/ckpt-spec-q7k2/restore-lib.mjs`, `probe-a.mjs`…`probe-h.mjs`
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/study-setup-port-7f3a/probe-a.mjs`…`probe-e.mjs`, `jsc-probe.swift`, `jsc-proto.swift`
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/ingest/probe1.mjs`…`probe8.mjs`, `jsc_probe.swift`, `jsc_proto.swift`
  - `/private/tmp/claude-501/-Users-jinhongan/ea344314-9ca8-460b-8768-08742568e0a0/scratchpad/review-claim-checks/lower.rs`, `abort.rs` (the rustc 1.96 checks behind Appendix D: lowercasing, `Display` and precision formatting, `catch_unwind` under `panic = "abort"`)
- **Repo oracles**:
  - `test/data-batch.test.mjs`, `test/append-atomicity.test.mjs`, `test/compaction-oracles.test.mjs`
  - `test/ingestion-oracle.test.mjs`, `test/ingestion*.test.mjs`
  - `test/api.test.mjs`, `test/hardening.test.mjs`, `test/set-series-presentation.test.mjs`, `test/remove-indicator-no-compute.test.mjs`, `test/atomic-indicator-params.test.mjs`, `test/indicator-params-publication.test.mjs`, `test/study-setup-oracle.test.mjs`
  - `test/scene-cache.test.mjs`, `test/native-command-packet.test.mjs`
  - `test/drawing-translation-oracle.test.mjs`, `test/drawings.test.mjs`, `test/position-drawing*.test.mjs`
  - `test/crosshair-snap.test.mjs`, `test/drawing-magnet.test.mjs`, `test/viewport-gesture-source.test.mjs`
  - `test/native-checkpoint-bounds.test.mjs`
  - `test/native-workspace-*.test.mjs`, `test/portable-workspace-roundtrip.test.mjs`, `test/timezone-cache.test.mjs`
  - `test/fixtures/legacy/aster-workspace-v1.json`
  - `Tests/BaroChartTests/TypedEngineTests.swift`, `TypedEngineCoverageTests.swift`

## Appendix B. Golden values (measured on the shipped bundle)

**Data and empty scene**
- `seededColumns(5,42)`: §3.4.10. For n=100000: `close[99999]=323.991462901075`, `volume[99999]=8790`.
- Empty `nativeSceneJSON(1200,700)`: commands `[{"op":"text","x":540,"y":350,"text":"No data","color":"#8093ad","font":"12px monospace"}]`, stats `{storedBars:0, visibleSourceBars:0, renderedCandleBuckets:0, commandCount:1}`.
- Empty scene packet: strings `['#8093ad','No data','12px monospace']`, numbers `[6,17,0,1,0,0,0,0,0,0,-1,0,1,2,2,540,350]`.

**Bridge**
- `nativeSelfTest()` → `{"passed":5,"runtime":"JavaScriptCore","storedBars":10000,"sceneCommands":29}`.
- Accessibility strings: §3.16.4.
- `nativeComparisonReadout` after a pointer move to (300,300) → `A OHLCV close 105.00 / B 2040.000 / UTC 1700000240000`.
- Unchanged batch envelope: `{schema:'aster.native-data-batch', version:1, beforeVersion:2, afterVersion:2, unchanged:true, receipt:{events:1, appended:0, from:1, to:2, version:2, length:4, capacity:16, bytes:1536, unchanged:true}}`.
- Inactive exploration refresh: `{schema:'aster.native-data-exploration', version:1, active:false, time:null, index:null, seriesId:null, phase:'off', text:''}`.

**Workspace**
- Source finish (300 bars, `ema(5)`, one horizontal line): `{schema:'aster.native-workspace-source-finished', version:1, revision:1, sourceVersion:2, sourceBytes:53248, checkpointBytes:556, drawingBytes:702, ticket:1}`.
- Target plan example: §3.15.2.

**Layout and views**
- Layout 1200×700 with one default panel: `left 12`, `right 1118`, axis `[1118,1200]`, `textX 1126`.
- 640×360 with weights 3 and 1: panels `[12,245.5]` and `[253.5,326]`.
- `geometryKey` example: `[1200,700,799.5,999.5,1,2,["price",null,12,1118,12,666,103.9449095940632,114.06656707783526,"linear",false,99.70641420974061],["p","price",null,null]]`. The serial `1` and timeVersion `2` need normalizing (D4).
- Interaction (894×446 grid, range [0,100], padding 0, `x(i)=32+40i`, `y(p)=412-4p`):
  - pinch from (300,200),(500,200), then pointer 2 → 600: view `5.7..15.7`;
  - `wheel(100,412)` from `4.5..14.5` → `3.9741454096217614..15.025854590378238`;
  - nudge 1 px: price `50 → 50.24999999999999`.

**Indicators and time zones**
- Pressure module: closes 10, 11, 11, 9 with volumes 5, 7, 8, 9 → signed `[0,7,0,-9]`, cumulative `[0,7,7,-2]`.
- New York DST vectors: §2.2 step 3. Santiago local midnight anchor: `2026-09-06T04:00:00.000Z`.

## Appendix C. Rust size estimate (stable surface)

| Area | Est. lines |
|---|---|
| JS-compat foundation (numbers, WTF-16 strings, ordered JSON value and codec, errors) | 1,500 |
| contracts + checkpoint codec | 600 |
| Data store + compaction | 1,900 |
| Markets/time (stable subset) | 900 |
| Ingestion (snapshot, lease, session save/restore) | 1,100 |
| Indicators + session studies | 3,400 |
| Native checkpoint containers + checkpoint-state validator | 1,300 |
| Model/layout | 1,700 |
| Drawings | 3,200 |
| Scene + packet | 1,800 |
| Interaction | 1,100 |
| ChartAPI facade + study setup | 2,850 |
| Workspace + preflight | 1,600 |
| Restore pipeline | 2,100 |
| Bridge ABI layer (stable functions, frame caches, accessibility, envelopes) | 1,800 |
| FFI glue (Rust side of §6.4) | 1,000 |
| **Total (stable surface)** | **~27,850** |

Not included:
- tier-A async data/params/exploration protocols: about +3,000 if ported;
- Swift/Java host changes for the backend switch: about 1,500–2,600 lines, not Rust;
- tests.

## Appendix D. Use of the GLM, DeepSeek and Qwen design reviews

**Sources and handling.** The design consultation that ran before this map was compiled produced the three answers used here. The relay labelled them GLM (exact version not reported), DeepSeek `deepseek-v4-pro` and Qwen `qwen3.8-max`. None of them read this snapshot in full. Per the consultation's attribution notes:
- GLM answered from the design brief without tools.
- DeepSeek shows no sign of reading the repository.
- Qwen fetched the public repository's `main` branch, which may differ from this snapshot.

This map therefore uses the reviews as design input, not as evidence. Every concrete claim was re-checked against the snapshot (D.2). Where a review conflicts with §3–§5, the specs win, and D.3 gives the reason. The design synthesis from the same consultation is cited where it settled a point.

### D.1 What all three reviews share, and where this map implements it

| Shared recommendation | Where it lands |
|---|---|
| Implement the existing bridge contract (option A): same global names, same JSON payloads, same `Name: message` errors | §1.2, §1.3, §4.0. The §2.2 gates compare at this boundary. |
| iOS: an internal runtime protocol under `BaroChartEngine`, not a JSContext shim that forwards to Rust. Android: swap the backend under the JNI `call(handle, name, argsJSON)` signature | §6.4 |
| No UniFFI rewrite of the platform layers during the port | §6.3, §6.4 |
| Port the stable typed surface first. Async jobs and custom JS indicators stay JS-only behind a defined "unsupported on this backend" error | §1.4, D1 |
| JS stays the default backend through 1.x | D12 |
| Differential replay against the JS core is the primary gate, backed by golden documents and the platform runners on both backends | §2.2, §2.3 |
| The main parity traps are number formatting (`Number::toString`, `toFixed` ties), UTF-16 lengths and summation order | §3.1, §5, risks 1 and 3 |
| A hand-written JSON writer for every emitted byte; no `serde_json` or `format!` precision in output | §3.1.3, §6.4 |
| A synchronous core with one caller at a time; threading stays in the hosts | §1.1, §6.3 |
| No panic may cross the FFI boundary | §6.4 |

### D.2 Claims checked against this snapshot

| Claim | Review | Result | Evidence |
|---|---|---|---|
| The bridge has about 45 `nativeCommand` ops | DeepSeek, Qwen | **Outdated**: there are 65 | `api.mjs:65` (COMMANDS), arity table `api.mjs:75`, §1.3.1 |
| The repo's 5,785 Node tests can run against the Rust core (on WASM, or because they are command scripts) | GLM, DeepSeek | **Does not hold** | 177 of 319 `test/*.test.mjs` files import `src/core/*.mjs` directly; 67 touch the bundle or bridge globals (static grep). §2.3 harvests traces instead. |
| Op traces can also come from `aster-native --self-test`, `--api-test` and `--async-test` | Qwen | **Confirmed** | `examples/native/main.swift:7`; the binary is `artifacts/aster-native` |
| `examples/native/parity.swift` uses `registerIndicatorSource`, so parity needs a core part and a JS-only part | Qwen | **Confirmed** | `examples/native/parity.swift:26` |
| Promote `private protocol BaroChartContextRuntime` to the iOS `CoreRuntime` | Qwen | **Partly**. The protocol exists but only manages worker-runtime retirement and capture leases. It is not a call interface, so the backend protocol must be new. | `BaroChartEngine.swift:304-309`; conformers at `:493` and `:843`; §6.1 |
| JSC types leak into internal records (`BaroChartWorkspaceSourceRecord`, `asterTypedBytes`) | Qwen | **Confirmed** | `BaroChartEngine.swift:389-396, 425` (holds a `JSContext`); `:141`; §6.1 |
| iOS async jobs run each worker in its own `JSVirtualMachine` | Qwen | **Confirmed** for async data, workspace target and params target | `BaroChartEngine.swift:525, 895, 1222` |
| `1e21` → `"1e+21"`, `1e-7` → `"1e-7"`, `1e-6` → `"0.000001"`, `-0` → `"0"`; `JSON.stringify` writes NaN/Infinity as `null`, escapes lone surrogates and leaves U+2028 raw | Qwen | **Confirmed** | Node 22 check; §3.1.1, §3.1.3 |
| Rust `{}` differs from JS for `1e21`, `-0` and integer-valued floats (`5.0`) | GLM | **Partly**. `Display` differs for `1e21` (all digits) and `-0` (`"-0"`), but prints `1.0` as `"1"`, like JS. The `1.0`-versus-`1` difference that DeepSeek describes belongs to `serde_json` output (not re-checked here). | rustc 1.96 check; §3.1.1 |
| JS `toFixed` ties behave like banker's rounding | GLM | **Wrong**. Ties pick the larger magnitude: `(0.125).toFixed(2)` is `"0.13"` and `(2.5).toFixed(0)` is `"3"`, as Qwen states. Rust `format!("{:.2}", 0.125)` gives `"0.12"`. | Node 22 and rustc 1.96 checks; §3.1.1 |
| Formatting sites `markets.mjs:33`, `scene-parts.mjs:14`, `drawings.mjs:72,77` | Qwen | **Confirmed**, plus `drawings.mjs:66` and the bridge (B:98, B:215) | §5 |
| Among libm-style functions the core uses only `sqrt`, `hypot`, `exp` and `log` (plus `imul` and `fround`) | Qwen | **Confirmed for the stable path**. `Math.sin` appears only in demo data (B:107). | §3.1.1 |
| `Math.round(x)` equals `floor(x+0.5)` | Qwen | **Wrong**. `0.49999999999999994` gives JS `0` and the formula `1`; `2^52+1` gives JS `2^52+1` and the formula `2^52+2`. | Node 22 check; §3.1.1 |
| Rust lowercasing is context-free (`"ΑΣ"` → `"ασ"`) | Qwen | **Wrong for `str::to_lowercase`**, which gives `"ας"` like JS; only per-`char` mapping is context-free. The core lowercases only colors, keys and ASCII zone letters. | rustc 1.96 check; §3.1.2 |
| `panic = "abort"` in release, but `catch_unwind` first and convert | GLM | **Not implementable**. Under `panic = "abort"`, `catch_unwind` catches nothing and the process aborts (exit code 134). | rustc 1.96 check; §6.4 |
| QuickJS uses the platform libm, close to the Rust `libm` crate | GLM | **First half confirmed** (`quickjs.c:46816-46833, 47182-47185`). The second half was not checked; it does not matter under D5, which calls what each engine calls. | D5 |
| `aster-core.js` is about 589 KB | GLM, DeepSeek, Qwen | **Confirmed** | 588,726 bytes (header) |

### D.3 Disagreements, and the position this map takes

| Topic | Review positions | This map |
|---|---|---|
| Backend selection | GLM: ship both and choose at runtime. DeepSeek, Qwen: exclude at build time; Qwen allows runtime switching in canary builds. | D12: a per-engine choice at creation and no silent fallback. Decide the artifact split after the S2 size measurement. |
| Time zones | GLM, Qwen: keep the host callback. DeepSeek: bundle `chrono-tz`. | D6: host callback. |
| Restore protocol in v1 | DeepSeek, Qwen: leave `nativeWorkspaceSource*`/`nativeWorkspaceTarget*` out of Rust v1. | In scope (tier R). Typed `restoreWorkspace` runs through that protocol on both platforms (`BaroChartEngine+Typed.swift:155-157`, `BaroChartEngine.java:1384-1385`), so leaving it out removes workspace restore from the stable surface. If porting the two-runtime protocol is the concern, use Option B (§3.15.6). |
| Document comparison | DeepSeek: structural equality that tolerates numeric formatting differences. | Byte equality. JSON text length decides checkpoint and document limits (risk 1: `sma(10000)` passes or fails the 256 KiB record limit depending on digits), and `save(restore(text)) === text` is a gate (§2.2 step 10). |
| Indicator tolerance | GLM: up to 1 ulp on indicator outputs, with a fixed summation order. | Bit-exact. Readers matched 2,933 indicator vectors bit for bit (§2.2 step 4). Indicators use only correctly rounded operations (§3.7.3); tolerance is reserved for the D5 functions. |
| Transcendentals | GLM: pin the Rust `libm` crate. Qwen: port fdlibm and quantize emitted geometry. | D5: call what the platform engine calls; quantize only inside the comparator (§2.3). |
| Scene transport | GLM: replace scene JSON with a new versioned binary layout. DeepSeek: JSON first, binary later. Qwen: port the existing F64 packet verbatim. | Keep `nativeSceneJSON` and `nativeRenderFrameJSON` as the oracle and port the existing packet (§3.11.8). A new format is out of scope. |
| Port order | GLM: data, model, indicators, drawings, workspace, then API dispatch and scene. DeepSeek: data and model, scene, then interaction, drawings and workspace, indicators last. Qwen: number/JSON layer, FFI skeleton, data, model, indicators, scene, interaction, drawings, workspace, then markets and ingestion. | §2.2. Scene cannot come before indicators, because layout and scene read indicator outputs through `model.seriesData` (§2.1). Markets and ingestion sit at step 3 because `applyDataEvent` and `SessionCalendar` live in `markets.mjs` and feed the data path and session studies. Qwen's early FFI skeleton is adopted as track S1. |
| Crate shape | GLM: `no_std` core and `panic = "abort"`. DeepSeek, Qwen: `std`; Qwen: `panic = "unwind"`. | Not a parity matter, except the panic policy: `unwind` plus `catch_unwind` at every entry (§6.4). |
| Engine thread affinity | All three: `!Send`. | `Send` but not `Sync`, because a restore target built on a worker is published to the owner thread (§6.4). |
| Input JSON parsing | GLM, Qwen: `serde` for input. | A hand-written `Value` parser: `serde_json` defaults cannot keep Absent/Null/Value apart (§3.1.4) or reproduce `JSON.parse` (§3.1.3). |

### D.4 Changes made to this map because of the reviews
- D5 says what to call on each platform and rejects pinned portable math on device.
- D6 records the split between the reviews and the condition for the offset-callback variant.
- D12 (backend selection and fallback) is new, and §1.4 notes that pinning an engine to JS depends on it.
- §2.2 gains the parallel de-risking track S1–S3.
- §2.3 gains the test-reuse facts, the `parity.swift` split, the comparator-only tolerance rule and the reusable repo tools.
- §3.1.1 cites the QuickJS math sources (checked) and gives a correct `Math.round` shape.
- §3.1.2 records that `str::to_lowercase` matches JS for the core's inputs.
- §6.1 corrects the reading of `BaroChartContextRuntime` and lists the internal JSC coupling.
- §6.4 adds the thread-affinity, panic, output, input and no-fallback rules.
- §7 adds risks 16 and 17.
