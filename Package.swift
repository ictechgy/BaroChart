// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "BaroChart",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "BaroChart", targets: ["BaroChart"])],
    targets: [.target(name: "BaroChart", path: "native", exclude: ["android"], sources: ["BaroChartEngine.swift", "BaroChartError.swift", "BaroChartTypes.swift", "BaroChartColumns.swift", "BaroChartFrameRenderer.swift", "BaroChartUIView.swift"], resources: [.copy("Resources/aster-core.js"), .copy("Resources/PrivacyInfo.xcprivacy")]),
        .testTarget(name: "BaroChartTests", dependencies: ["BaroChart"], path: "Tests/BaroChartTests", resources: [.copy("Resources/vocabulary.json")])],
    swiftLanguageModes: [.v5]
)
