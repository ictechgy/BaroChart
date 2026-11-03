# Support and operations status

Status snapshot: **2026-11-04** · [한국어](SUPPORT.ko.md) · [migration guide](MIGRATING-FROM-LIGHTWEIGHT-CHARTS.md) · [browser measurement](measurements/2026-11-04-migration-operations.md).

BaroChart `0.3.0-dev` is a development preview. The package is private and no npm, SwiftPM release tag, or Maven Central artifact has been published. “Supported lane” below describes the implementation and documentation available in this source tree; it is not a released-version compatibility promise.

## Compatibility and support matrix

| Lane | Current status | Evidence and boundary |
| --- | --- | --- |
| JavaScript core and web | **Current supported implementation lane.** DOM-free core; Canvas and WebGL2 web renderers; source and local package-consumer path. | The local demo and migration recipe were exercised in headless Chrome at 1280, 390, and 320 CSS px. This is one browser run, not certification of all browsers, GPUs, or input devices. The package remains an unreleased preview. |
| Lightweight Charts migration | **Narrow recipe, not an adapter.** Covers numeric-time candlesticks, UTC seconds to milliseconds, explicit OHLCV, append/update/correction, and host lifecycle. | See [migration contract](MIGRATING-FROM-LIGHTWEIGHT-CHARTS.md). It does not claim Lightweight Charts API compatibility or compatibility with Advanced Charts, Trading Platform, or Pine Script. |
| React web | **Optional adapter.** The compatibility export remains `AsterChart`. | The checked-in consumer is a runnable example. Modeled-hook tests alone do not prove installed React runtime, SSR, hydration, or every React version; run the consumer against the target app's locked React/ReactDOM versions. |
| Mobile web | **Responsive host examples and explicit input presets.** | The measured viewport widths have no horizontal overflow for the migration page. Browser viewport emulation does not verify touch gestures, scrolling arbitration, VoiceOver, TalkBack, or a physical handset. |
| Apple native | **Existing Swift/JavaScriptCore SDK integration.** SwiftUI and UIKit views are available from the local source checkout. | CI and dated simulator/device records are linked from the [native measurements](measurements/native-device-performance.json). The 2026-11-01 physical result is one iPhone and offscreen CPU work; it is not display FPS or broad device coverage. No public SwiftPM release tag is available. |
| Android native | **Existing Android/QuickJS SDK integration.** View and Compose APIs and two packaged ABIs are available from the local source checkout. | CI, emulator, and dated physical-device evidence are linked from the [native measurements](measurements/native-device-performance.json). The 2026-11-01 physical result is one Samsung device and CPU bitmap rendering; it is not display FPS or broad device coverage. No Maven Central release is available. |
| Rust native chart backend | **Incomplete and in development.** M1b ABI/package/internal-selection infrastructure is implemented; a complete chart backend and its conformance gates have not passed. | The [M1b checks](measurements/2026-11-04-rust-m1b.md) verify a count-echo scaffold. Do not claim JavaScript feature parity, a chart-speed ratio, or Rust as the default. Complete the authorized M1b–M7 implementation and host/platform gates before changing that status. |
| Feeds, accounts, and trading | **Host-owned; not supplied.** | The local HTTP/SSE fixture uses synthetic data. Production provider authentication, entitlements, sequence/watermark policy, retries, accounts, and order execution remain application responsibilities. See [feed integration](FEED-INTEGRATION.md). |

The web React name `AsterChart` and serialized `aster.*` schemas remain compatibility surfaces. Native SDK branding is `BaroChart`. Do not rename saved schemas as part of a product rename. This project is independent and does not claim an API relationship with TradingView products.

## Evidence, automation, and manual checks

The [2026-11-04 migration run](measurements/2026-11-04-migration-operations.md) is a real local-browser run of one page. It records synthetic input, viewport widths, an update visible in the canvas, actual BFCache restoration, terminal cleanup behavior, and zero uncaught page errors. It is not a full-browser matrix or a device test.

The [feed integration report](measurements/2026-11-03-feed-integration.md) and [onboarding report](measurements/2026-11-03-onboarding-analysis.md) preserve dated automated Node and Chrome results for their then-current source. Earlier checkpoints and failures remain in [public validation history](PUBLIC-VALIDATION.md). A historical passing count does not imply that the current checkout or pull request has passed those commands. The workflow definitions are in [CI](../.github/workflows/verify.yml); check the exact pull request's run before release.

The [mobile sample report](measurements/2026-11-04-mobile-quality.md) adds native lifecycle/rotation/source-revision regressions, simulated accessibility audits at large font sizes, and trusted Chrome touch emulation. Its native UI results are iOS 7 plus 2 large-font checks and Android 8 plus 1 large-font check; its 12 browser checks cover pan/pinch/cancel/keyboard/scroll. These remain simulated results; extreme chart text can be ellipsized and physical screen-reader usefulness is pending.

Automated tests and simulated DOM/RAF/host tests can check state transitions and API contracts. They cannot replace the following manual gates:

- Touch input, browser scroll behavior, and usable chart controls on physical iOS and Android devices.
- VoiceOver and TalkBack navigation, focus order, labels, and chart alternatives.
- The target app's real React/SSR setup, data provider sequence contract, and operational reconnect policy.
- Any release-specific native packaging, signing, store submission, or version compatibility review.

No item above should be marked passed solely from a simulated test. Record the device/browser/version, steps, result, and remaining issues for each manual gate.

## Release gates

Before describing this preview as a release or changing a support claim:

1. Run the tests and package/type checks for the exact reviewed source revision and confirm its CI result. Keep historical test counts labeled with their original date and revision.
2. Run browser checks on the intended browser/version set and manual touch and screen-reader checks on physical devices; retain failures and unavailable environments.
3. Keep React claims scoped to the React versions and runtime/SSR modes exercised by the actual consumer.
4. Finish Rust M1b–M7 implementation and JS/native conformance across supported hosts before stating feature parity, enabling it as a default, or publishing a speed comparison. Compare performance only after both implementations perform the same visible work under a recorded method.
5. Separately approve versioning, package publication, release tags, signing, and platform distribution. Current local source/package checks do not publish artifacts.

## Privacy-safe failure report

Use this template for a defect report. Replace sensitive input with a synthetic reproducer that preserves the relevant shape and event ordering. Attach only the sanitized files needed to reproduce the behavior.

```text
Product/revision: BaroChart <version or git revision>
Integration lane: <JS/web | React | Swift/iOS | Kotlin/Android | Rust work in progress>
Runtime and versions: <OS, browser/runtime, SDK/toolchain>
Expected behavior: <one observable result>
Observed behavior: <one observable result>
Reproduction steps: <short numbered steps>
Minimal synthetic input: <schema and generated values; no production bars>
Error: <name/code/message after removing paths and identifiers>
Relevant command/test: <command and exit status>
Evidence: <sanitized screenshot or minimal log path>
Manual or automated: <which, and device/simulator/browser details>
```

Remove API keys, tokens, cookies, authorization headers, account/customer identifiers, provider endpoints, private symbol/venue names, personal file paths, and proprietary OHLCV. Do not attach a workspace or export file unless it has been checked for private drawings, annotations, identifiers, and data. Do not send secrets to reproduce a feed problem; use the local synthetic fixture or a scrubbed adapter.
