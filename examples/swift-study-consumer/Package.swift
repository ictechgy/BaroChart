// swift-tools-version: 6.0
import Foundation
import PackageDescription
let sdk=ProcessInfo.processInfo.environment["ASTER_NATIVE_PACKAGE_PATH"] ?? "../.."
let package=Package(name:"AsterStudyConsumer",platforms:[.macOS(.v13)],dependencies:[.package(name:"BaroChart",path:sdk)],targets:[.executableTarget(name:"StudyConsumer",dependencies:[.product(name:"BaroChart",package:"BaroChart")])],swiftLanguageModes:[.v5])
