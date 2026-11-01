// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "BaroChart",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "BaroChart", targets: ["BaroChart"])],
    targets: [.target(name: "BaroChart", path: "native", exclude: ["android"], sources: ["BaroChartEngine.swift", "BaroChartColumns.swift", "BaroChartFrameRenderer.swift", "BaroChartUIView.swift"], resources: [.copy("Resources/aster-core.js"), .copy("Resources/PrivacyInfo.xcprivacy")])],
    swiftLanguageModes: [.v5]
)
