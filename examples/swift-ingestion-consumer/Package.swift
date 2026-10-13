// swift-tools-version: 6.0
import Foundation
import PackageDescription
let sdk=ProcessInfo.processInfo.environment["ASTER_NATIVE_PACKAGE_PATH"] ?? "../.."
let package=Package(name:"AsterIngestionConsumer",platforms:[.macOS(.v13)],dependencies:[.package(name:"AsterNative",path:sdk)],targets:[.executableTarget(name:"IngestionConsumer",dependencies:[.product(name:"AsterNative",package:"AsterNative")])],swiftLanguageModes:[.v5])
