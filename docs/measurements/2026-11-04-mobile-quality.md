# Mobile sample verification — 2026-11-04

Product improvement ④, based on the tree merged as `397ed63` (#26). Native SDK implementation and the JavaScript chart engine are unchanged.

## Behavior

The SwiftUI sample uses a scene-owned streaming task. The Compose sample uses a lifecycle-owned task and an `AndroidViewModel` that retains the engine across configuration recreation and closes it when the owner ends. Backgrounding suspends synthetic source updates; returning retains the user's streaming intent. Save and Restore pause updates. Dataset revisions advance only after accepted events, so a workspace saved against older bars is rejected instead of silently accepting different data. These workspaces contain metadata, not bars, and remain in memory only.

The stream control is fixed outside the scrolling action row. Both samples opt into their SDK's system font scaling. This does not guarantee full numeric labels at extreme font sizes: labels may be ellipsized. Screen-reader usefulness remains a physical-device manual check.

## Regression evidence

- Android: activity recreation originally lost paused intent. Advancing the Compose effect clock while the activity was stopped also exposed continued source updates. Save did not pause, and the fixed dataset revision accepted a workspace after data changed. The final six flow tests cover these paths and engine retention/final close.
- iOS: the valid baseline exposed background updates, Save not pausing, and stale-source acceptance. A later test traced a missed Pause action to an offscreen button (`{-1, -1}` computed hit point). Fixing the button layout made the action work. The test waits for foreground hit readiness before tapping and checks that the pause action was accepted before backgrounding again.
- Infrastructure failures remain separate: an older simulator had no display port and never launched the runner. A fresh, dedicated simulator was used. Adding a generated scene manifest did not fix the button issue and was not retained.

## Results

| Environment | Executed verification | Result |
| --- | --- | --- |
| iPhone 17 Pro, iOS 27 simulator, arm64 | Whole sample UI scheme: five flow tests, accessibility audit, benchmark smoke | **7 passed**, zero failures/skips |
| Same simulator, largest accessibility content size | Accessibility audit and background/paused-intent flow | **2 passed**, zero failures/skips |
| Owned API 36 Android emulator, x86_64 | Six flow tests, accessibility audit, audit sensitivity control | **8 passed**, zero failures/skips |
| Same emulator, font scale 2.0 | Accessibility audit including visible stream button | **1 passed**; the pre-fix visibility assertion failed |
| Android sample lint | `:app:lintDebug` | Passed, zero errors; existing missing-application-icon warning remains |
| Isolated installed Chrome, touch emulation, 390/320 px | Trusted touch pan, two-finger pinch, gesture cancellation, keyboard movement, document scrolling, no overflow, usable plot and 44 px drawing targets | **12 checks passed**, zero uncaught page exceptions |
| Node 22.20.0, TypeScript 5.9.3 | Whole Node suite, module syntax, strict types, offline installed npm consumer | **5,927 passed**, zero failures/skips; 651 modules parsed; remaining checks passed |

Font settings were restored after each run. Large-font screenshots were inspected; the controls and plot remain present, while extreme chart labels use ellipses. This is automated and simulated validation, not physical touch, VoiceOver/TalkBack approval, display-frame performance or a JS/Rust speed comparison. The simulator benchmark smoke is not a performance acceptance gate.

## Reproduction

```sh
# Run the checked-in UI schemes using your own device/output paths.
xcodebuild test -project examples/swiftui-sample/BaroChartSample.xcodeproj \
  -scheme BaroChartSample -destination 'platform=iOS Simulator,id=<id>' \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
gradle -p examples/compose-sample :app:connectedDebugAndroidTest :app:lintDebug
TSC_PATH=/path/to/typescript/lib/tsc.js npm test
npm run check
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:package
```

Local ignored evidence is under `artifacts/product-completion-20261103/`: red/green Android XML/logs, iOS `.xcresult` bundles, font-setting restoration records, screenshots, whole-suite TAP and the trusted-input `mobile-probe.mjs`/JSON. CI adds the existing SDK checks after the final commit.

Before release, run the [physical-device accessibility checklist](../NATIVE-ACCESSIBILITY-CHECKLIST.md) and record actual device/OS/commit/results. Connect a physical iPhone and Android phone for the Rust design §8.3 startup/frame gates; no such result is claimed here.
