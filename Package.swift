// swift-tools-version: 6.0
import PackageDescription
import Foundation

let rustXCFrameworkPath = ProcessInfo.processInfo.environment["BAROCHART_RUST_XCFRAMEWORK"]
let hasRustXCFramework = rustXCFrameworkPath.map { FileManager.default.fileExists(atPath: $0) } ?? false
let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().standardizedFileURL.path
let rustXCFrameworkPackagePath = rustXCFrameworkPath.map { path in
    URL(fileURLWithPath: path).standardizedFileURL.path.replacingOccurrences(of: packageRoot + "/", with: "")
}
let rustBinaryTarget: Target? = hasRustXCFramework
    ? .binaryTarget(name: "BaroChartCoreRust", path: rustXCFrameworkPackagePath!)
    : nil
var packageTargets: [Target] = [
    .target(name: "BaroChart", dependencies: hasRustXCFramework ? ["BaroChartCoreRust"] : [], path: "native", exclude: ["android"], sources: ["BaroChartEngine.swift", "BaroChartCoreRuntime.swift", "BaroChartRustCoreRuntime.swift", "BaroChartTrace.swift", "BaroChartEngine+Typed.swift", "BaroChartError.swift", "BaroChartTypes.swift", "BaroChartColumns.swift", "BaroChartFrameRenderer.swift", "BaroChartUIView.swift", "BaroChartSwiftUI.swift"], resources: [.copy("Resources/aster-core.js"), .copy("Resources/PrivacyInfo.xcprivacy")]),
    .testTarget(name: "BaroChartTests", dependencies: ["BaroChart"], path: "Tests/BaroChartTests", resources: [.copy("Resources/vocabulary.json"), .copy("Resources/aster-workspace-v1.json"), .copy("Fixtures/traces")])
]
if let rustBinaryTarget { packageTargets.append(rustBinaryTarget) }

let package = Package(
    name: "BaroChart",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "BaroChart", targets: ["BaroChart"])],
    targets: packageTargets,
    swiftLanguageModes: [.v5]
)
