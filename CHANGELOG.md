# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Web, iOS and Android share one version.

## [0.3.0-dev] - unreleased

Native SDK commercial-readiness work. See the [design](docs/superpowers/specs/2026-11-01-native-sdk-commercial-design.md) and the [iOS](docs/IOS-GUIDE.md) and [Android](docs/ANDROID-GUIDE.md) guides.

### Added
- Platform-specific first-integration guide linking the web, React, SwiftUI and Compose consumers.
- Main demo drawing-object manager and an application-owned analysis file that restores captured bars, studies, drawings and viewport. Invalid or cancelled restores retain the mounted chart; successful restore pauses the synthetic stream. The file is limited to 250,000 bars / 32 MiB; SDK workspace schemas are unchanged.
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
- Drawing JSON and native async event/prepare documents reject nesting beyond 32 before parsing. Native value-bridged host argument containers reject nesting beyond 64, including the outer argument array, with `SyntaxError: Native argument depth limit` (`invalidArgument` / `INVALID_ARGUMENT`). Brackets inside strings do not count toward nesting.
- Native public names renamed from `Aster*` / `dev.aster.charts` to `BaroChart*` / `kr.coden.barochart` ([migration guide](docs/MIGRATING-FROM-ASTER.md)). Saved `aster.*` documents are unchanged.
- View setters throw instead of recording a silent `lastError`; Android `lastError` is now `getLastError()`.
- Workspace documents write the dataset binding in a fixed key order, so equal charts save identical bytes on every platform.
- Saved and returned records use one canonical key order, whatever order the host passed the fields in. This covers drawings (`id, panel, locked, style, type, points, text, visible, axisId, seriesId`), drawing styles (`color, width, fill, font`) and anchors (`time, price`), panels, axes, series, themes, symbols and drawing targets (in the order their validators list the fields), indicator parameters (in the order each indicator declares them), workspace preflight receipts and bar-replay sessions. The same chart now saves the same bytes on every run; before, a drawing added through the Swift typed API saved different bytes on each launch because Swift dictionaries have no fixed order. When several fields are wrong, the reported error no longer depends on the input order: allowed fields are checked in their listed order, then unsupported fields in UTF-16 order. A drawing edit that only reorders keys no longer adds an undo step.
  - Web: documents saved with another key order (for example from object literals) still load and restore, and saving them again writes the canonical order, so the bytes change but the meaning does not. `inspect()` returns panels, axes, series, symbol and drawing target in canonical order, and an input with several unsupported fields may report a different field than before.
- Time zones follow one contract on web, iOS and Android. A zone is an IANA-style name (ASCII letters, digits, `_`, `+`, `-` and `/`, letter case ignored) or a fixed offset `±HH:MM`. `Z`, `UT` and names starting with `UTC`, `GMT` or `UT` followed by `+` or `-` are rejected before the platform is asked. Times must be finite, and local years must lie between 1000 and 9999. The core writes the messages: `Unsupported time zone: <name>`, `Time zone conversion requires a finite time` and `Time zone conversion year out of range`. `zonedEpoch` and `shiftDate` parse ISO dates and clock times strictly instead of calling `Date.parse`. Before, the platforms disagreed: iOS reported `invalid time zone: X` and Android `Invalid timezone/date`, Android turned a NaN time into 1970 and accepted `Z` and `UTC+9`, and year 999 came out as `999` on iOS but `0999` on Android.
  - Web: the message changes from `Invalid time zone specified: X`. `GMT+0`, `GMT-0`, `+0900` and `+09` are now rejected. Impossible dates and times such as `2026-02-30`, `24:00` or fractional seconds throw `TypeError` (`zonedEpoch` threw `RangeError: Nonexistent local time at DST boundary`, and `shiftDate` rolled over into the next month). `shiftDate` no longer truncates results after year 9999. A workspace saved with a now-rejected zone, such as `GMT+0` on web or iOS or `Z` or `UTC+9` on Android, fails to restore with `Unsupported time zone`.

### Fixed
- VoiceOver escape gesture now cancels an active drawing gesture on iOS.
- Android touch input no longer throws out of the view when the engine fails; the failure goes to the error listener.
- A closed Android engine reports `ENGINE_CLOSED` instead of the off-thread message.
- A closed iOS engine's JavaScript context no longer stays alive until the caller's autorelease pool drains. Before, creating and closing engines in a loop on one thread kept every context in memory.
- Non-finite bar values passed to Swift `setBars` throw `invalidArgument` (was `unavailable`). Invalid bars inside a batch event, and malformed JSON documents, throw `invalidArgument` on both platforms (were `javaScript` / `UNAVAILABLE`).
- Android `close()` from another thread throws `BaroChartException` with `WRONG_THREAD` instead of `IllegalStateException`.
- Attaching an Android view to a closed engine reports `ENGINE_CLOSED` to the error listener instead of crashing.
- When a new view takes over an engine (for example a SwiftUI or Compose wrapper recreated with the same engine), font scaling is applied once from the original font. Before, iOS scaled the already scaled font and Android threw `IllegalStateException`.
- A restored engine, and an engine after an async indicator-parameter update, now accounts checkpoints like a fresh chart. Before, it kept the 32 MiB restore budget, so data and studies that worked on a fresh chart failed after a restore with `Native checkpoint total byte limit` (`invalidArgument` / `INVALID_ARGUMENT`) once more bars arrived. A restored engine that becomes the source of the next restore now reports the same retained checkpoint bytes as a fresh chart, which is more than before. A document close to the size limit may therefore stop with `Workspace source logical byte limit` first, as it would on a fresh chart.
  - Web: no change. Restore and async parameter publication with these budgets run only in the native bundle.

## [0.2.13] - 2026-10-28

Last version before the native SDK rename. See [PUBLIC-VALIDATION.md](docs/PUBLIC-VALIDATION.md) and the dated review records in `docs/` for its history.
