# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Web, iOS and Android share one version.

## [0.3.0-dev] - unreleased

Native SDK commercial-readiness work. See the [design](docs/superpowers/specs/2026-11-01-native-sdk-commercial-design.md) and the [iOS](docs/IOS-GUIDE.md) and [Android](docs/ANDROID-GUIDE.md) guides.

### Added
- Typed Swift and Android APIs: `BaroChartEngine(options:)` / `BaroChartEngine.create(context, options)`, data events, series, 35 indicator kinds, 16 drawing tools, themes, symbols, visible range, workspace save/restore with cancellation, crosshair values.
- One error type per platform: Swift `BaroChartError`, Android `BaroChartException`, with codes, messages and recovery advice.
- SwiftUI `BaroChartView` and Jetpack Compose `BaroChart` (`kr.coden:barochart-compose`), plus SwiftUI and Compose sample apps.
- Android `x86_64` ABI, 16 KiB load alignment checks, Maven publication setup (`kr.coden:barochart-android`).
- iOS privacy manifest (`PrivacyInfo.xcprivacy`).
- Native CI jobs (iOS build and tests, Android build, x86_64 emulator smoke) and distribution rehearsal script.
- English API reference comments on every public Swift and Android Java declaration, and `scripts/build-native-docs.mjs` (DocC + Javadoc, fails on any warning).
- 30-minute memory soak, accessibility audits and device benchmark harnesses for both platforms ([measurements](docs/measurements/)).
- Patch types for partial updates: Swift `BaroChartSeriesPatch` / `BaroChartDrawingPatch` with `updateSeries(id:_:)` / `updateDrawing(id:_:)`, Android `SeriesPatch` / `DrawingPatch`. Only the fields you set change.
- `configure` hook on SwiftUI `BaroChartView` and Compose `BaroChart` to set view options such as Dynamic Type or system font scaling.
- Android `BaroChartView.dispose()` / `isDisposed()`; Compose releases dispose the view and keep the engine open.

### Changed
- Native public names renamed from `Aster*` / `dev.aster.charts` to `BaroChart*` / `kr.coden.barochart` ([migration guide](docs/MIGRATING-FROM-ASTER.md)). Saved `aster.*` documents are unchanged.
- View setters throw instead of recording a silent `lastError`; Android `lastError` is now `getLastError()`.
- Workspace documents write the dataset binding in a fixed key order, so equal charts save identical bytes on every platform.

### Fixed
- VoiceOver escape gesture now cancels an active drawing gesture on iOS.
- Android touch input no longer throws out of the view when the engine fails; the failure goes to the error listener.
- A closed Android engine reports `ENGINE_CLOSED` instead of the off-thread message.
- A closed iOS engine's JavaScript context no longer stays alive until the caller's autorelease pool drains. Before, creating and closing engines in a loop on one thread kept every context in memory.
- Non-finite bar values passed to Swift `setBars` throw `invalidArgument` (was `unavailable`). Invalid bars inside a batch event, and malformed JSON documents, throw `invalidArgument` on both platforms (were `javaScript` / `UNAVAILABLE`).
- Android `close()` from another thread throws `BaroChartException` with `WRONG_THREAD` instead of `IllegalStateException`.
- Attaching an Android view to a closed engine reports `ENGINE_CLOSED` to the error listener instead of crashing.
- When a new view takes over an engine (for example a SwiftUI or Compose wrapper recreated with the same engine), font scaling is applied once from the original font. Before, iOS scaled the already scaled font and Android threw `IllegalStateException`.

## [0.2.13] - 2026-10-28

Last version before the native SDK rename. See [PUBLIC-VALIDATION.md](docs/PUBLIC-VALIDATION.md) and the dated review records in `docs/` for its history.
