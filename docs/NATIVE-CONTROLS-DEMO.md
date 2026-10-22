# Opt-in native data controls example

This is experimental **example source**, not a new verified UIKit/Android UI or accessibility result. The existing iOS and Android demo screens can expose explicit bar/series navigation and a value readout. No new screenshots are claimed. Existing default launch behavior is unchanged.

## Enable on an already configured development machine

- iOS: build the existing `examples/ios/App.swift` application using `node scripts/build-ios.mjs`, then include `--data-controls` in its launch arguments.
- Android: build the existing `examples/android/DemoActivity.java` application using `node scripts/build-android.mjs`, then launch `dev.aster.charts.demo/dev.aster.charts.DemoActivity` with boolean Intent extra `data-controls=true` (for example `adb shell am start -n dev.aster.charts.demo/dev.aster.charts.DemoActivity --ez data-controls true`).
- Existing validation modes omit this optional panel even if the flag is supplied. These commands require an independently configured SDK/device; the cloud checks do not run or install them. The AppKit desktop example has no new controls in this unit.

## Explicit actions

Exploration starts OFF. Choose Explore on, then Previous/Next bar or Previous/Next series. Navigation and Refresh selection do not calculate dirty indicators or move the chart viewport. Read values is separate and may synchronously calculate **all visible dirty indicators**, so it can block the UI. The text area is scrollable and shows the last explicit result; it does not automatically refresh on a feed update. Refresh selection discards an old value readout. Explore off ends selection. Existing chart keyboard and gesture handlers are unchanged; enabling during an active gesture can fail rather than cancel it.

The panel deliberately has no “repeat last snapshot” button. The diagnostic `inspect.lastBar` path passes through JSON and loses signed zero, so replaying it would not be an exact duplicate. The separate [unchanged-batch API](NATIVE-BATCH-UNCHANGED.md) remains available for application-owned original feed snapshots; no raw-snapshot API is added for this example.

All controls remain focusable after an action: the example does not disable/remove the triggering button. Labels describe the action rather than relying on an icon. These source choices are not proof of VoiceOver/TalkBack focus, announcement, touch-target layout or actual device usability. No native key routing or automatic announcements are added.

Errors replace the last explicit result with a bounded message and are never automatically retried. Engine/UI identity, mount token and action generation gate result writes. The example's disconnect/destroy path invalidates its controls before closing its engine. Controls from a previous mount cannot operate a newly mounted panel. This does not introduce a new SDK-wide close subscription or an arbitrary hostile-host sandbox.

## Cloud verification boundary

Source contract tests cover opt-in gating, labels, lifecycle guards and routing. A generated-bundle VM regression verifies that explicit exploration preserves stored negative zero and source version even though diagnostic JSON would lose its sign. Existing Java consumer typechecks and standalone QuickJS verification cover the underlying facade signatures and exploration bridge contract.


The complete Activity/UIKit application is **not compiled or executed by these cloud checks**. Swift compiler/JSC/ARC, Android SDK/JNI, widget behavior and assistive technology remain pending actual platform verification.
