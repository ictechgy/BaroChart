# Native accessibility checklist

Automated checks cover what tools can see: the XCUI accessibility audit on the SwiftUI sample (`examples/swiftui-sample/UITests/AccessibilityUITests.swift`) and Accessibility Test Framework checks on the Compose sample (`examples/compose-sample/.../AccessibilityTest.kt`). Screen-reader use needs a person. Run this list on a physical iPhone with VoiceOver and a physical Android phone with TalkBack before a release.

Items marked **[owner]** need the repository owner's sign-off on a real device. Record the device, OS version, SDK commit and result for each item.

## iOS (VoiceOver)

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| 1 | Swipe to the chart **[owner]** | VoiceOver reads "Financial chart" and the current value summary | |
| 2 | Swipe up / down on the chart **[owner]** | Zooms in / out; the value summary updates | |
| 3 | Rotor › Actions **[owner]** | Lists Zoom in, Zoom out, Pan earlier, Pan later, Next drawing, Previous drawing, Undo, Redo, Delete selected drawing, Cancel interaction | |
| 4 | Run "Pan earlier" and "Pan later" **[owner]** | Visible range moves; no crash | |
| 5 | Start a drawing, then two-finger scrub (escape) **[owner]** | The drawing in progress is cancelled; committed drawings stay | |
| 6 | Settings › Accessibility › Larger Text, with `adjustsFontForContentSizeCategory = true` **[owner]** | Axis and label text grows; turning it off restores the app font | |
| 7 | Send the app to the background and back during streaming **[owner]** | Chart resumes drawing; VoiceOver focus is not lost | |

## Android (TalkBack)

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| 1 | Swipe to the chart **[owner]** | TalkBack reads the chart description and value summary | |
| 2 | Actions menu on the chart **[owner]** | Lists zoom in, zoom out, clear crosshair and cancel interaction | |
| 3 | Run zoom in / zoom out **[owner]** | Visible range changes; no crash | |
| 4 | Start a drawing, then run "cancel interaction" **[owner]** | The drawing in progress is cancelled; committed drawings stay | |
| 5 | Settings › Display › Font size at maximum, with `setSystemFontScaleEnabled(true)` **[owner]** | Axis and label text grows; turning it off restores the app font | |
| 6 | Rotate the device during streaming **[owner]** | Chart redraws at the new size; TalkBack focus stays on the screen | |

## Automated results

| Platform | Check | Result (2026-11-01) |
| --- | --- | --- |
| iOS 27.0 Simulator | `performAccessibilityAudit()` on the SwiftUI sample chart screen (all audit types) | Pass, 0 issues. The first run found sample-app issues only: low-contrast status text and buttons, a clipped "Restore" label, and the "Live" button-style toggle, whose unfilled off state lacked contrast. The sample now uses a matching color scheme, a scrolling filled button row and a filled "Live"/"Pause" button. The test waits for the button's press highlight to settle before auditing. |
| Android API 36 emulator | Compose `enableAccessibilityChecks()` + `tryPerformAccessibilityChecks()` on the Compose sample | Pass, 0 issues |
| Android API 36 emulator | Control: a 10 dp unlabeled clickable must be rejected (`AccessibilityCheckSensitivityTest`) | Pass. With the checks turned off, this control fails, which proves the sample check is active |

The chart itself is one accessibility element with a value summary and custom actions. Automated audits cannot judge whether those actions are useful with a screen reader, so the manual items above still need a person.
