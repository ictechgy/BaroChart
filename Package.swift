// swift-tools-version: 6.0
import PackageDescription
import Foundation

let rustXCFrameworkPath = ProcessInfo.processInfo.environment["BAROCHART_RUST_XCFRAMEWORK"]
let packageRootURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .standardizedFileURL
    .resolvingSymlinksInPath()

func rustFrameworkPackagePath(_ configuredPath: String) -> String {
    let candidate = URL(fileURLWithPath: configuredPath, relativeTo: packageRootURL)
        .standardizedFileURL
        .resolvingSymlinksInPath()
    let rootComponents = packageRootURL.pathComponents
    let candidateComponents = candidate.pathComponents
    guard candidateComponents.count > rootComponents.count,
          Array(candidateComponents.prefix(rootComponents.count)) == rootComponents else {
        fatalError("BAROCHART_RUST_XCFRAMEWORK must resolve inside the Swift package root.")
    }
    guard candidate.pathExtension == "xcframework" else {
        fatalError("BAROCHART_RUST_XCFRAMEWORK must point to an .xcframework directory.")
    }
    var isDirectory = ObjCBool(false)
    guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
          isDirectory.boolValue else {
        fatalError("BAROCHART_RUST_XCFRAMEWORK must point to an existing .xcframework directory inside the package.")
    }
    return candidateComponents.dropFirst(rootComponents.count).joined(separator: "/")
}
let rustXCFrameworkPackagePath = rustXCFrameworkPath.map(rustFrameworkPackagePath)
let hasRustXCFramework = rustXCFrameworkPackagePath != nil
let rustBinaryTarget: Target? = rustXCFrameworkPackagePath.map {
    .binaryTarget(name: "BaroChartCoreRust", path: $0)
}
var packageTargets: [Target] = [
    .target(name: "BaroChart", dependencies: hasRustXCFramework ? ["BaroChartCoreRust"] : [], path: "native", exclude: ["android"], sources: ["BaroChartEngine.swift", "BaroChartCoreRuntime.swift", "BaroChartRustCoreRuntime.swift", "BaroChartTrace.swift", "BaroChartEngine+Typed.swift", "BaroChartError.swift", "BaroChartTypes.swift", "BaroChartColumns.swift", "BaroChartFrameRenderer.swift", "BaroChartUIView.swift", "BaroChartSwiftUI.swift", "BaroChartValidation.swift"], resources: [.copy("Resources/aster-core.js"), .copy("Resources/PrivacyInfo.xcprivacy")]),
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
