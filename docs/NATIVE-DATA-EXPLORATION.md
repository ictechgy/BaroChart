# Explicit native bar exploration (experimental)

Swift and Java engines provide four opt-in methods for host-owned controls. The generated JavaScript bridge is tested in cloud VM fixtures; Java is typechecked against compile-only Android signatures. **Swift compilation/JSC/ARC, Android SDK/JNI, VoiceOver and TalkBack operation are not verified for this addition.** No platform key or accessibility action is installed automatically.

## Four explicit actions

| Method | Result |
| --- | --- |
| `setDataExploration(true/false)` | Enable or disable ephemeral selection. Default is OFF. Enabling rejects an active native gesture without cancelling it. |
| `navigateDataExploration(key)` | Active-mode navigation: `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End` only. No automatic `Enter` or `Escape` routing. |
| `refreshDataExploration()` | Reconcile selection against currently stored timestamps/visible series; discard old read text. Does not read indicator values. |
| `readDataExploration()` | Explicit synchronous `dataAt` query and bounded text. Can calculate **all visible dirty indicators**, including ones other than the selected series; their errors/costs apply. |

Java returns `JSONObject`; Swift returns `[String: Any]`. Each result contains `schema: "aster.native-data-exploration"`, `version: 1`, `active`, `time`, `index`, `seriesId`, `phase` and `text`. OFF has null time/index/seriesId. Active missing selection has index `-1`. Text is at most 4,096 UTF-16 code units; at most 256 visible series are accepted. These objects are snapshots of the explicit operation. There is no passive status API combining a current index with an older value readout.

Enabling chooses a loaded bar at the visible endpoint (clamped to loaded rows). Left/right move through stored bars, Home/End choose the first/last, and up/down select a visible series. Navigation does not fetch data or move the chart viewport/crosshair. Selection is anchored to exact stored time, not a pixel or persistent positional index. Append/prepend preserve an existing time; reset/compaction can leave it unavailable. It does not silently jump to the nearest surviving bar. Explicit Home/End selects again.

Returned read text describes current plotted values, offsets, source index/time and cutoff. It does not certify causal studies, historical arrival-time truth, exchange-feed freshness or exact decimal arithmetic. A host retaining text after a data update is retaining an old explicit result; call Refresh to invalidate that text or Read to request new values. No automatic subscription or live announcement is added.

## Host use

```java
engine.setDataExploration(true);
JSONObject selection = engine.navigateDataExploration("ArrowLeft");
// Show selection.getString("text") in a host-owned label.
JSONObject values = engine.readDataExploration(); // explicit user request
engine.setDataExploration(false);
```

```swift
try engine.setDataExploration(true)
let selection = try engine.navigateDataExploration("ArrowLeft")
let values = try engine.readDataExploration() // explicit user request
try engine.setDataExploration(false)
```

Invoke on the engine's existing owner thread while open. These dedicated methods do not increment the chart revision, notify chart observers, request rendering or implicitly run indicator calculations during navigation/Refresh. A host independently requesting a dirty chart redraw can still cause calculations. Hosts decide when to update labels or accessibility announcements; the APIs alone do not constitute completed accessible platform UI.

Selection belongs to the current API/model pair. Whole-model/runtime replacement, including workspace restore, starts OFF. Indicator parameter replacement in the same model keeps the timestamp selection; Refresh/Read then observes the new series state. Selection is not serialized in workspace documents. Separate engines have separate selections; views sharing one engine share its selection. Bridge checks reject mismatched owners and source changes during an operation. Closed or replaced host contexts/handles cannot return a successful stale result. Existing async ownership and cancellation protocols are unchanged. Navigation/Refresh preserve an in-flight parameter capture. Explicit Read can calculate a previously dirty entry and therefore make that capture stale under its existing rules; callers should wait for an async calculation when they need to avoid that interaction.

## Validation scope

Generated-bundle VM tests cover default OFF, explicit actions, empty/missing data, append/prepend/reset/compaction, series offsets/panels/visibility, source/owner reentry, gesture rejection, repeated enable/disable, separate runtimes and no navigation-induced indicator lookup. Facade source tests and Java compile-only consumers check forwarding and owner checks. This is not SDK/device execution or a claim about assistive-technology usability or UI latency.

The shared standalone fixture can be checked with `node scripts/test-quickjs-cloud.mjs --native-controls` using a local C compiler and the existing vendored QuickJS source. It exercises the JavaScript bridge, not the platform facade or accessibility integration; see [validation scope](PUBLIC-VALIDATION.md).

An opt-in [iOS/Android example panel](NATIVE-CONTROLS-DEMO.md) demonstrates explicit actions; its actual platform UI remains unverified.
