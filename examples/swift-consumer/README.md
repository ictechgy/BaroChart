# Independent SwiftPM consumer

This executable package and Xcode iOS app depend on the local `AsterNative` library product. Their source targets do not include SDK Swift files or existing demo test imports. `AsterEngine()` resolves the library-owned SwiftPM resource internally.

From the repository root:

```sh
swift run --package-path examples/swift-consumer --scratch-path /tmp/aster-sdk-manual AsterSDKProbe
node scripts/test-swift-consumer.mjs --mode all
```

Open `iOS/AsterSDKConsumer.xcodeproj` for the UIKit app. The shared scheme includes XCUI tests. The runner copies only this consumer to an isolated `/tmp` directory, overrides its local package dependency to the selected SDK, uses installed tools, creates and deletes its own simulator, and preserves logs/results there. Physical devices require the host's own signing setup and are not part of this runner.

Contracts, platform/engine dependencies, view borrowing/cleanup and measured verification scope: [SWIFT-SDK.md](../../docs/SWIFT-SDK.md).
