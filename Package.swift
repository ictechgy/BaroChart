// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "AsterNative",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "AsterNative", targets: ["AsterNative"])],
    targets: [.target(name: "AsterNative", path: "native", exclude: ["android"], sources: ["AsterNative.swift", "AsterColumns.swift", "AsterFrameRenderer.swift", "AsterUIKit.swift"], resources: [.copy("Resources/aster-core.js")])],
    swiftLanguageModes: [.v5]
)
