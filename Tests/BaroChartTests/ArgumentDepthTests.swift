import Foundation
import JavaScriptCore
import XCTest
@testable import BaroChart

/// 호스트가 값으로 넘기는 컨테이너는 인자 배열을 포함해 깊이 64까지 허용한다(M0c).
final class ArgumentDepthTests: XCTestCase {
    private func arguments(depth: Int, mixed: Bool = false) -> [Any] {
        var value: Any = 0
        for index in 0..<(depth - 1) {
            if mixed && index % 2 == 0 {value = ["child": value]}
            else {value = [value]}
        }
        return [value]
    }

    private func assertDepthFailure(message: String = "Native argument depth limit", _ body: () throws -> Void) {
        do {try body();XCTFail("Expected argument depth rejection")}
        catch let error as BaroChartError {
            XCTAssertEqual(error.code, .invalidArgument)
            XCTAssertEqual(error.message, message)
        } catch {XCTFail("Unexpected error: \(error)")}
    }

    func testExactLimitForArraysAndMixedRecords() throws {
        let engine = try BaroChartEngine()
        defer {try? engine.close()}
        for mixed in [false, true] {
            XCTAssertTrue(try engine.call("nativeEcho", arguments(depth: 64, mixed: mixed)).isObject)
            assertDepthFailure {_ = try BaroChartError.mapping {try engine.call("nativeEcho", arguments(depth: 65, mixed: mixed))}}
        }
        XCTAssertEqual(try engine.call("nativeEcho", [7]).toInt32(), 7)
    }

    func testOptionalContainersAndCyclesAreCheckedIterativelyWithoutCallingTheCore() throws {
        let engine = try BaroChartEngine()
        defer {try? engine.close()}
        engine.context.evaluateScript("var depthCalls=0;function nativeDepthProbe(){depthCalls++;return 7}")
        let nested = arguments(depth: 65)[0]
        assertDepthFailure {_ = try BaroChartError.mapping {try engine.call("nativeDepthProbe", [Optional<Any>.some(nested) as Any])}}
        XCTAssertEqual(engine.context.objectForKeyedSubscript("depthCalls")?.toInt32(), 0)
        let array = NSMutableArray(), record = NSMutableDictionary()
        array.add(array);record["self"] = record
        defer {array.removeAllObjects();record.removeAllObjects()}
        XCTAssertNotNil(BaroChartArgumentDepth.rejection(for: [array]))
        XCTAssertNotNil(BaroChartArgumentDepth.rejection(for: [record]))
        XCTAssertNil(BaroChartArgumentDepth.rejection(for: [Optional<Any>.none as Any]))
        let shared: [Any] = [1]
        XCTAssertNil(BaroChartArgumentDepth.rejection(for: [shared, shared]))
    }

    func testRuntimeInvokeAlsoRejectsBeforeFunctionExecution() throws {
        let runtime = try XCTUnwrap(BaroChartRuntimeFactory.makeIsolated(like: .javaScript))
        XCTAssertNil(runtime.evaluateBundle("var hits=0;function nativeDepthProbe(){hits++;return true}"))
        assertDepthFailure {_ = try BaroChartError.mapping {try runtime.invoke("nativeDepthProbe", arguments(depth: 65))}}
        XCTAssertEqual(runtime.javaScriptContext.objectForKeyedSubscript("hits")?.toInt32(), 0)
    }

    func testSharedReferenceHeightIsCheckedAtEveryDepth() {
        var subtree = NSMutableArray(array: [0])
        for _ in 1..<10 {let parent = NSMutableArray();parent.add(subtree);subtree = parent}
        XCTAssertNil(BaroChartArgumentDepth.rejection(for: [subtree, subtree]))
        var deeper: Any = subtree
        for _ in 0..<53 {deeper = [deeper]}
        XCTAssertNil(BaroChartArgumentDepth.rejection(for: [subtree, deeper]))
        deeper = [deeper]
        XCTAssertNotNil(BaroChartArgumentDepth.rejection(for: [subtree, deeper]))
        var shared = NSMutableArray(array: [0])
        for _ in 0..<20 {let parent = NSMutableArray();parent.add(shared);parent.add(shared);shared = parent}
        XCTAssertNil(BaroChartArgumentDepth.rejection(for: [shared]))
    }

    func testCoreDocumentLimitsUseInvalidArgumentAndLeaveDrawingsUntouched() throws {
        let engine = try BaroChartEngine()
        defer {try? engine.close()}
        let saved = try engine.call("nativeCommand", ["saveDrawings", []]).toString()
        for depth in [33, 100000] {
            let text = String(repeating: "[", count: depth) + "0" + String(repeating: "]", count: depth)
            assertDepthFailure(message: "Drawing document depth limit") {_ = try BaroChartError.mapping {try engine.call("nativeCommand", ["loadDrawings", [text]])}}
            for (name, message) in [("nativeAsyncBegin", "Native data event document depth limit"), ("nativePrepareBegin", "Native prepare document depth limit")] {
                assertDepthFailure(message: message) {_ = try BaroChartError.mapping {try engine.call(name, [text])}}
            }
        }
        XCTAssertEqual(try engine.call("nativeCommand", ["saveDrawings", []]).toString(), saved)
    }

    func testExistingVMReferencesAreNotReadByHostValueTraversal() throws {
        let engine = try BaroChartEngine()
        defer {try? engine.close()}
        let value = try XCTUnwrap(engine.context.evaluateScript("var reads=0;({get hidden(){reads++;return []}})"))
        XCTAssertTrue(try engine.call("nativeEcho", [value]).isObject)
        XCTAssertEqual(engine.context.objectForKeyedSubscript("reads")?.toInt32(), 0)
    }

    func testClosedEngineStillPrecedesArgumentInspection() throws {
        let engine = try BaroChartEngine()
        try engine.close()
        do {_ = try engine.call("nativeEcho", arguments(depth: 65));XCTFail("Expected closed engine")}
        catch let error as BaroChartAsyncError {
            guard case .engineClosed = error else {XCTFail("Unexpected error: \(error)");return}
        }
    }
}
