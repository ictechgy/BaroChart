# Native Rust backend

BaroChart has an opt-in native Rust core for local SDK validation and native
integration work. The JavaScript backend remains the default on both platforms.
The typed data, indicator, drawing, controller, workspace, scene and
asynchronous surfaces keep their existing host-language shapes and errors.

This page describes the current development integration. Distribution and a
default switch remain subject to the size, performance and device rollout gates.

## Choose a backend deliberately

Choose Rust when the app needs to exercise the native core, native Float64
transfers, or a chart flow without loading the JavaScript core bundle. Choose
JavaScript when the app needs JavaScriptCore/QuickJS access, JavaScript
indicator source registration, or a JavaScript-only demo/test hook. The normal
application choice remains JavaScript until the rollout gates are approved.

The choice is explicit and immutable for an engine. There is no runtime
fallback: if the selected backend is absent from the build, construction fails
with an unavailable error. Isolated workers created by restore, preparation,
parameter and data jobs use the same backend as their source engine.

## Selecting Rust

### Swift

Use the public typed initializer when selecting a backend for one engine:

```swift
let engine = try BaroChartEngine(
    options: BaroChartEngineOptions(),
    backend: .rust
)
assert(engine.backend == .rust)
```

`BaroChartBackend` has the cases `.javaScript` and `.rust`. For legacy
initializers, `BaroChartEngine.defaultBackend` selects the backend; changing it
must happen on the main thread and affects subsequently created engines only:

```swift
BaroChartEngine.defaultBackend = .rust
let engine = try BaroChartEngine(options: BaroChartEngineOptions())
```

The Rust XCFramework is an opt-in local Swift Package binary target. Set
`BAROCHART_RUST_XCFRAMEWORK` to a path such as
`artifacts/rust/BaroChartCoreRust.xcframework` before evaluating the package. The
path must be an existing `.xcframework` directory contained inside the Swift
package root; paths outside that root are rejected. The Rust initializer does
not read or evaluate a JavaScript bundle.

`engine.context` is available only with the JavaScript backend. Rust uses an
internal value-only JavaScriptCore context to preserve public `JSValue` results;
it does not expose a chart JavaScript context. Use typed methods or the
documented low-level calls supported by the bridge.

### Android

Use the explicit factory for one engine:

```kotlin
val engine = BaroChartEngine.create(
    context,
    EngineOptions.defaults(),
    EngineBackend.RUST,
)
```

`EngineBackend` has `JAVASCRIPT` and `RUST`. `BaroChartEngine.setDefaultBackend`
and `getDefaultBackend` control only legacy constructors and future engines;
the initial default is `JAVASCRIPT`. The Rust constructor does not load the
`aster-core.js` asset.

The Android Gradle module can contain both cores, Rust only, or JavaScript only
(see [Local builds](#local-builds)). These are build-time capabilities, not a
runtime fallback policy.

## Supported native surface

The Rust bridge implements the shared chart model and the host adapters for:

- OHLCV replacement and streaming (`reset`, `append`, `update`, `correction`,
  `prepend`, and batches), columns, ingestion queues, data exploration and
  Float64 indicator buffers.
- All 35 built-in indicators, plus the statically linked
  `aster.volume-direction@1/pressure` module available at startup. Indicator
  add/remove, parameter updates, scalar and bulk reads, and studies
  save/load are supported.
- Startup panels, series and theme; axes, symbols and time zones; scene JSON
  and native display packets; fit, zoom, pan, crosshair and readout queries.
- The drawing store and controller: the drawing tools, add/edit/translate,
  style and visibility changes, duplication, deletion, selection, undo/redo,
  text, pointer, wheel, key, hover-exit, gesture, accessibility and drawing
  target paths.
- Workspace save/preflight/restore and the asynchronous data, preparation,
  parameter and UI transfer jobs. Jobs retain owner-thread rules, cancellation
  and cleanup behavior; isolated runtimes use the source engine's backend.

The typed app flows remain the preferred entry point. The dictionary/JSON
`call`/`invoke` APIs and bridge globals are advanced surfaces; their exact
availability is defined by the [bridge manifest](../rust/crates/barochart-bridge/src/manifest.rs).

### Indicator modules and custom source

`registerIndicatorModule(id, version)` selects an application-linked, static
module and does not fetch or evaluate source. The built-in `pressure` module is
available without a registration call.

JavaScript indicator source registration is intentionally JavaScript-only.
Calling `registerIndicatorSource` on Rust returns the bridge error with:

```text
name: UnavailableError
code: JAVASCRIPT_BACKEND_REQUIRED
message: Indicator source registration requires the javaScript backend
```

There is no automatic pinning to JavaScript and no fallback. Register source
only on an explicitly JavaScript-backed engine, and pass only trusted source.

### Intentional unavailable globals

The following 17 names remain in `supports` as known Tier-A names but reject in
the Rust backend. They are test/demo hooks, JavaScript source registration, or
lifecycle disposal paths outside the Rust surface; this is intentional rather
than an accidental missing-function fallback:

```text
nativeAnalysisDemo
nativeAnalysisReload
nativeAsyncUI
nativeAxesSelfTest
nativeComparisonAction
nativeComparisonDemo
nativeComparisonReadout
nativeExtendedSelfTest
nativeHardeningSelfTest
nativeParamsTargetDispose
nativePublicationOrderSelfTest
nativeRegisterIndicatorSource
nativeSelfTest
nativeStudyVerification
nativeWorkspaceSourceBuffer
nativeWorkspaceSourceDispose
nativeWorkspaceTargetDispose
```

The manifest is the source of truth for this list and for all implemented
globals. A rejected name reports an `UnavailableError` naming the Rust backend;
it does not invoke JavaScript.

## Local builds

Use Node 22 (the repository requires Node `>=22`) and the repository's Rust
wrapper. The wrapper selects the rustup toolchain pinned in
`rust/rust-toolchain.toml` and deliberately does not fall back to Homebrew
Cargo. The release profile uses `panic = "unwind"`; this is required for the
FFI boundary's panic-to-poison recovery contract.

Focused checks and local packaging commands are:

```sh
node scripts/rust/check-header.mjs
node scripts/rust/c-smoke.mjs
node scripts/rust/cargo.mjs test --locked --workspace
node scripts/rust/build-xcframework.mjs
```

`check-header.mjs` verifies the committed public C ABI header against generated
output; `c-smoke.mjs` compiles and calls that header. The XCFramework command
creates local, untracked Rust slices for Swift Package use. It is not a release
or distribution step by itself.

The WASM exception-handling preparation is an internal conformance aid, not a
shipping dependency. Offline preparation is the default and requires
Python 3.11 or newer:

```sh
python3 scripts/rust/prepare-wasm-eh.py --offline
```

An explicit `--download` may fetch only checksum-locked public crates needed by
the preparation cache. The normal native SDK does not depend on that cache.

For Android, the module's two flags define the supported local configurations:

```sh
# dual (the default flags)
gradle --console=plain -p native/android/library \
  -PbarochartQuickjs=true -PbarochartRust=true assembleRelease

# Rust-only
gradle --console=plain -p native/android/library \
  -PbarochartQuickjs=false -PbarochartRust=true assembleRelease

# JavaScript-only
gradle --console=plain -p native/android/library \
  -PbarochartQuickjs=true -PbarochartRust=false assembleRelease
```

The Rust core's only direct third-party crate is `ryu-js`. The WASM preparation
cache contains additional standard-library build dependencies. Android
physical-device performance and soak/manual acceptance remain rollout gates.

## Rollout status

The native Rust core is opt-in. Fresh native SDK artifacts and review fixes
passed the local verification suites. The dual-backend package fits the
owner-approved 5 MiB per-ABI budget; see the
[measurement and artifact decision](measurements/2026-11-04-rust-core-size.md).

[Physical iPhone XR measurements](measurements/2026-11-05-native-rust-ios-ab.md)
passed the startup and pan budgets in Release. The same device passed 500
create/dispose cycles and a
[30-minute streaming soak](measurements/2026-11-05-native-rust-ios-soak.json).
JavaScript was faster in this workload; Rust used less process memory. Android
physical-device performance and soak, plus manual VoiceOver/TalkBack acceptance,
remain unverified. Keep JavaScript as the default until the platform rollout
gates are completed.

## Related guides

- [iOS guide](IOS-GUIDE.md) for ordinary SwiftUI/UIKit integration.
- [Android guide](ANDROID-GUIDE.md) for ordinary View/Compose integration.
- [Swift SDK reference](SWIFT-SDK.md) and [Android SDK reference](ANDROID-SDK.md)
  for advanced low-level APIs.
