import CoreGraphics
import Foundation
import JavaScriptCore
import XCTest
@testable import BaroChart

/// 코어 호출 추적(BCJSON) 기록기 테스트(M0 Task 6).
/// 이음새 리팩터링 전에 기록한 골든과 지금 코드가 기록한 추적이 바이트까지 같아야 한다. 골든 비교에는 새 프로세스에서
/// 기록한 추적을 쓴다. 작업 등록 번호처럼 프로세스 전체에서 늘어나는 상태가 앞서 돈 테스트에 따라 달라지지 않게 하려고서다.
@MainActor
final class TraceRecorderTests: BackendSelectedTestCase {
    /// 자식 프로세스가 추적을 쓸 디렉터리를 알려 주는 환경 변수
    private static let childOutputVariable = "BAROCHART_TRACE_SCENARIO_OUTPUT"
    /// 1이면 골든을 새로 기록한다(테스트는 실패로 끝나 다시 돌리게 한다)
    private static let recordVariable = "BAROCHART_RECORD_TRACE_GOLDENS"

    /// 유한한 숫자 글자가 JSC의 String(n)과 같아야 Node·JSC·Rust 추적이 같은 글자를 쓴다.
    func testNumberTextMatchesJavaScriptCore() throws {
        var values: [Double] = [0, 1, -1, 0.1, 0.5, 1.5, 100, 123.456, 1e21, 1e-7, 1.5e-7, 123456789012345683968, 1e20, 0.000001, 0.0000001,
                                5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 9007199254740991, 9007199254740994, 1700000000000, 1.0 / 3.0, 2.0 / 3.0]
        var state: UInt64 = 0x9E3779B97F4A7C15
        while values.count < 20000 {
            // 시드 고정 xorshift로 비트 패턴을 만들어 모든 지수 범위를 고르게 본다
            state ^= state << 13;state ^= state >> 7;state ^= state << 17
            let value = Double(bitPattern: state)
            if value.isFinite && value != 0 {values.append(value)}
        }
        let context = try XCTUnwrap(JSContext())
        let format = try XCTUnwrap(context.evaluateScript("(function(values){return values.map(String)})"))
        let expected = try XCTUnwrap(format.call(withArguments: [values]).toArray() as? [String])
        XCTAssertNil(context.exception)
        for (value, text) in zip(values, expected) {
            XCTAssertEqual(BaroChartTraceEncoder.number(value), text, "bits \(String(value.bitPattern, radix: 16))")
        }
        XCTAssertEqual(BaroChartTraceEncoder.number(-0.0), "-0")
        XCTAssertEqual(BaroChartTraceEncoder.number(.nan), "NaN")
        XCTAssertEqual(BaroChartTraceEncoder.number(.infinity), "Infinity")
        XCTAssertEqual(BaroChartTraceEncoder.number(-.infinity), "-Infinity")
    }

    /// 문자열 이스케이프는 JSON.stringify와 같다(제어 문자, 따옴표, 단독 서로게이트는 \udxxx 소문자).
    func testStringEscapingMatchesJSONStringify() throws {
        var samples: [NSString] = ["", "plain", "quote\" backslash\\ slash/", "\u{7f}\u{2028}\u{2029}", "é😀가", "tab\tline\nfeed\u{c}back\u{8}return\r"]
        samples.append(String((0..<32).map {Character(UnicodeScalar(UInt8($0)))}) as NSString)
        for units: [unichar] in [[0xD800], [0xDFFF], [0x61, 0xDBFF], [0xDC00, 0x61], [0xD83D, 0xDE00, 0xD83D]] {
            samples.append(NSString(characters: units, length: units.count))
        }
        let context = try XCTUnwrap(JSContext())
        let stringify = try XCTUnwrap(context.objectForKeyedSubscript("JSON")?.forProperty("stringify"))
        for sample in samples {
            XCTAssertEqual(BaroChartTraceEncoder.quoted(sample), stringify.call(withArguments: [sample]).toString(), sample as String)
        }
        XCTAssertNil(context.exception)
    }

    /// 호스트 인자는 JSC 변환 규칙을 따르고, 딕셔너리 키는 UTF-16 오름차순이다.
    func testArgumentsFollowJavaScriptCoreConversionWithSortedKeys() throws {
        let nested: [String: Any] = ["b": 2, "a": [1.5, -0.0, Double.nan], "가": NSNull(), "A": false]
        let text = try BaroChartTraceEncoder.arguments([1, true, NSNull(), nested, "x", UInt64(9007199254740993), [Double]()])
        XCTAssertEqual(text, "[1,true,null,{\"A\":false,\"a\":[1.5,-0,NaN],\"b\":2,\"가\":null},\"x\",9007199254740992,[]]")
        XCTAssertThrowsError(try BaroChartTraceEncoder.arguments([Date(timeIntervalSince1970: 0)]))
    }

    /// 훅을 끄면 새 런타임은 기록기를 받지 않고 파일도 만들지 않는다.
    func testTracingOffCreatesNoFiles() throws {
        let directory = try TraceFiles.temporaryDirectory("off", removedAfter: self)
        BaroChartEngine.traceDirectoryForTesting = directory
        BaroChartEngine.traceDirectoryForTesting = nil
        XCTAssertNil(BaroChartTraceSettings.makeWriter())
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars(TraceFixture.bars(8))
        _ = try engine.scene(width: 400, height: 300)
        try engine.close()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    /// 시나리오마다 추적이 멈추지 않고 끝까지 기록된다. 자식 프로세스로 불리면 골든 비교용 추적을 그 디렉터리에 쓴다.
    func testScenarioTraces() async throws {
        let requested = ProcessInfo.processInfo.environment[Self.childOutputVariable].map {URL(fileURLWithPath: $0)}
        let output = try requested ?? TraceFiles.temporaryDirectory("scenarios", removedAfter: self)
        for scenario in TraceScenario.allCases {
            let directory = output.appendingPathComponent(scenario.rawValue)
            if FileManager.default.fileExists(atPath: directory.path) {try FileManager.default.removeItem(at: directory)}
            BaroChartEngine.traceDirectoryForTesting = directory
            do {try await scenario.run()} catch {BaroChartEngine.traceDirectoryForTesting = nil;throw error}
            BaroChartEngine.traceDirectoryForTesting = nil
            XCTAssertEqual(BaroChartTraceSettings.failuresForTesting, [], scenario.rawValue)
            let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
            XCTAssertEqual(names.filter {$0.hasSuffix(".meta.json")}, [], "\(scenario.rawValue) trace stopped")
            XCTAssertFalse(names.isEmpty, scenario.rawValue)
        }
    }

    #if os(macOS)
    /// 새 프로세스에서 기록한 추적이 골든과 바이트까지 같다(렌더러가 만드는 무작위 UUID 토큰만 순번으로 바꿔 비교한다).
    func testFreshProcessTracesMatchGoldens() throws {
        let output = try TraceFiles.temporaryDirectory("fresh", removedAfter: self)
        try runScenarioChild(output: output)
        let record = ProcessInfo.processInfo.environment[Self.recordVariable] == "1"
        for scenario in TraceScenario.allCases {
            let produced = try TraceFiles.traces(in: output.appendingPathComponent(scenario.rawValue), scenario: scenario)
            XCTAssertFalse(produced.isEmpty, scenario.rawValue)
            if record {try TraceFiles.writeGoldens(produced, scenario: scenario);continue}
            let goldens = try TraceFiles.goldens(scenario)
            XCTAssertEqual(produced.map(\.name), goldens.map(\.name), scenario.rawValue)
            for (actual, expected) in zip(produced, goldens) where actual.text != expected.text {
                XCTFail("\(actual.name) differs from the golden: \(TraceFiles.firstDifference(actual.text, expected.text))")
            }
        }
        if record {XCTFail("Recorded trace goldens into Tests/BaroChartTests/Fixtures/traces; rerun without \(Self.recordVariable)")}
    }

    /// 이 테스트 번들을 새 xctest 프로세스로 띄워 testScenarioTraces만 돌린다.
    private func runScenarioChild(output: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["xctest", "-XCTest", "BaroChartTests.TraceRecorderTests/testScenarioTraces", Bundle(for: TraceRecorderTests.self).bundlePath]
        var environment = ProcessInfo.processInfo.environment
        environment[Self.childOutputVariable] = output.path
        environment.removeValue(forKey: Self.recordVariable)
        // Xcode가 띄운 실행이면 이 두 변수가 자식의 테스트 선택을 IDE 세션으로 돌리므로 지운다(swift test에는 없다)
        environment.removeValue(forKey: "XCTestConfigurationFilePath")
        environment.removeValue(forKey: "XCTestSessionIdentifier")
        process.environment = environment
        let logURL = output.appendingPathComponent("child.log")
        XCTAssertTrue(FileManager.default.createFile(atPath: logURL.path, contents: nil))
        let log = try FileHandle(forWritingTo: logURL)
        process.standardOutput = log
        process.standardError = log
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = {_ in finished.signal()}
        try process.run()
        let timedOut = finished.wait(timeout: .now() + 600) == .timedOut
        if timedOut {process.terminate();finished.wait()}
        try log.close()
        let text = try String(contentsOf: logURL, encoding: .utf8)
        XCTAssertFalse(timedOut, "Trace child process timed out; see \(logURL.path)")
        XCTAssertEqual(process.terminationStatus, 0, "Trace child process failed:\n\(text.suffix(6000))")
    }
    #endif
}

/// 골든 추적 시나리오. 이름은 골든 파일 이름 앞부분이다.
enum TraceScenario: String, CaseIterable {
    case typedAPI = "typed-api"
    case viewInput = "view-input"
    case workspace = "workspace"
    case asyncJobs = "async-jobs"
    case lowLevel = "low-level"

    /// 시나리오 하나를 끝까지 돌린다(엔진을 만들고 닫는다).
    @MainActor func run() async throws {
        switch self {
        case .typedAPI: try Self.typedAPI()
        case .viewInput: try Self.viewInput()
        case .workspace: try await Self.workspace()
        case .asyncJobs: try await Self.asyncJobs()
        case .lowLevel: try Self.lowLevel()
        }
    }

    /// 타입 API의 모든 메서드와 오류 경로
    @MainActor private static func typedAPI() throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions(
            panels: [BaroChartPanel(id: "price", weight: 3), BaroChartPanel(id: "volume", weight: 1, label: "Volume")],
            series: [BaroChartSeries(id: "price", type: .candles), BaroChartSeries(id: "volume", type: .histogram, panel: "volume", source: .volume)]))
        try engine.setBars(TraceFixture.bars(48))
        try engine.apply(.append(TraceFixture.bar(48)))
        try engine.apply(.update(TraceFixture.bar(48, close: 130.5)))
        try engine.apply(.correction(TraceFixture.bar(10, close: 99.25)))
        try engine.apply(.prepend(TraceFixture.bars(2, from: -2)))
        try engine.apply(.batch([.append(TraceFixture.bar(49)), .update(TraceFixture.bar(49, close: 131.75))]))
        try engine.addIndicator(.ema(period: 5), id: "ema")
        try engine.addSeries(BaroChartSeries(id: "ema-line", type: .line, indicator: "ema", color: "#f0b755", width: 2))
        try engine.updateSeries(id: "ema-line", BaroChartSeriesPatch(color: "#00ff00", width: 1.5, label: "EMA"))
        try engine.setIndicatorParams(id: "ema", ["period": 7])
        _ = try engine.indicatorValue(id: "ema", index: 20)
        try engine.addIndicator(.macd(fast: 6, slow: 13, signal: 4), id: "macd")
        try engine.addIndicator(.bollinger(period: 10, deviation: 2), id: "bands")
        _ = try engine.indicatorValue(id: "macd", output: "signal", index: 30)
        try engine.setTool(.trendline)
        let line = try engine.addDrawing(BaroChartDrawing(tool: .trendline, points: [TraceFixture.point(5, 101), TraceFixture.point(20, 112.5)],
                                                          style: BaroChartDrawingStyle(color: "#ff0000", width: 2), text: "trend"))
        let level = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [TraceFixture.point(12, 108)]))
        try engine.updateDrawing(id: line, BaroChartDrawingPatch(style: BaroChartDrawingStyle(color: "#00ff00", width: 3), text: "edited"))
        try engine.selectDrawing(level)
        try engine.selectDrawing(nil)
        _ = try engine.deleteDrawings(ids: [level])
        try engine.undo()
        try engine.redo()
        try engine.loadDrawings(try engine.saveDrawings())
        try engine.setTheme(.light)
        try engine.setSymbol(TraceFixture.symbol)
        _ = try engine.visibleRange()
        try engine.setVisibleRange(BaroChartVisibleRange(from: 10, to: 40))
        try engine.fit()
        _ = try engine.crosshair(width: 400, height: 300)
        _ = try engine.saveWorkspace(binding: TraceFixture.binding)
        try engine.removeSeries("ema-line")
        try engine.removeIndicator("bands")
        // 오류 경로: 코어 TypeError·RangeError·Error, 그리고 코어를 부르기 전에 호스트에서 끝나는 오류
        XCTAssertThrowsError(try engine.apply(.update(TraceFixture.bar(3))))
        XCTAssertThrowsError(try engine.addDrawing(BaroChartDrawing(tool: .select, points: [])))
        XCTAssertThrowsError(try engine.setSymbol(BaroChartSymbol(id: "TRACE", exchange: "TEST", timezone: "Z", currency: "USD", priceDecimals: 2, tickSize: 0.01)))
        XCTAssertThrowsError(try engine.addIndicator(.ema(period: 3), id: "ema"))
        XCTAssertThrowsError(try engine.setVisibleRange(BaroChartVisibleRange(from: 5, to: 5)))
        XCTAssertThrowsError(try engine.updateDrawing(id: "missing", BaroChartDrawingPatch(text: "x")))
        XCTAssertThrowsError(try engine.indicatorValue(id: "missing", index: 0))
        XCTAssertFalse(engine.isClosed)
        try engine.close()
        XCTAssertTrue(engine.isClosed)
        XCTAssertThrowsError(try engine.fit())
    }

    /// 뷰가 엔진에 보내는 입력과 그리기(UIView와 같은 함수·인자, 프레임 렌더러의 supports 경로)
    @MainActor private static func viewInput() throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars(TraceFixture.bars(60))
        let width = CGFloat(390), height = CGFloat(300)
        _ = try engine.call("nativeThemeFont").toString()
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativeAccessibilityText", [true, "uikit"])
        // 수평선 그리기 도구로 탭 한 번
        try engine.setTool(.horizontal)
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativePointer", ["down", 1, CGFloat(180.5), CGFloat(120), 22])
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativePointer", ["up", 1, 0, 0])
        // 선택 도구로 끌어 팬
        try engine.setTool(.select)
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativePointer", ["down", 2, CGFloat(200), CGFloat(200), 22])
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativePointer", ["move", 2, CGFloat(160.25), CGFloat(204)])
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativePointer", ["up", 2, 0, 0])
        // 하드웨어 키보드와 손쉬운 사용 동작
        _ = try engine.call("nativeResize", [width, height])
        _ = try engine.call("nativeKey", ["ArrowLeft", true, false])
        _ = try engine.call("nativePointer", ["cancel", 0, 0, 0])
        _ = try engine.call("nativeHoverExit")
        _ = try engine.call("nativeKey", ["Escape", false, false])
        _ = try engine.command("zoom", [0.8])
        try engine.setTheme(["font": "13.000px monospace"])
        _ = try engine.scene(width: Double(width), height: Double(height))
        // 캐시 렌더러: supports("nativeRenderFrameJSON")가 참이면 계층 캐시 경로를 탄다
        let renderer = BaroChartFrameRenderer(engine: engine, budget: BaroChartNativeCacheBudget(maxBytes: 134217728))
        let bitmap = try TraceFixture.bitmap(width: 780, height: 600, scale: 2)
        _ = try renderer.render(width: Double(width), height: Double(height), scale: 2, in: bitmap)
        _ = try renderer.render(width: Double(width), height: Double(height), scale: 2, in: bitmap)
        renderer.invalidate()
        _ = try renderer.render(width: Double(width), height: Double(height), scale: 2, in: bitmap)
        renderer.release()
        try engine.close()
    }

    /// 워크스페이스 저장, 사전 점검, 비동기 복원(작업 런타임으로 교체), 다시 저장, 바인딩이 다른 복원 실패
    @MainActor private static func workspace() async throws {
        let source = try BaroChartEngine(options: BaroChartEngineOptions())
        try source.setBars(TraceFixture.bars(40))
        try source.addIndicator(.ema(period: 3), id: "ema")
        try source.addIndicator(.rsi(period: 5), id: "rsi")
        try source.addSeries(BaroChartSeries(id: "ema-line", type: .line, indicator: "ema"))
        _ = try source.addDrawing(BaroChartDrawing(tool: .horizontal, points: [TraceFixture.point(5, 103)]))
        try source.setSymbol(TraceFixture.symbol)
        let document = try source.saveWorkspace(binding: TraceFixture.binding)
        _ = try source.preflightWorkspace(document, datasetBinding: TraceFixture.binding.lowLevel)
        let target = try BaroChartEngine(options: BaroChartEngineOptions())
        try target.setBars(TraceFixture.bars(40))
        try await target.restoreWorkspace(document, binding: TraceFixture.binding)
        XCTAssertEqual(try target.saveWorkspace(binding: TraceFixture.binding), document)
        let other = BaroChartDatasetBinding(key: "TRACE:OTHER", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
        do {
            try await target.restoreWorkspace(document, binding: other)
            XCTFail("A workspace with a different dataset binding must not restore")
        } catch {
            XCTAssertTrue(error is BaroChartError, "\(error)")
        }
        try source.close()
        try target.close()
    }

    /// 비동기 데이터·준비·지표 params 작업(작업 런타임 세 종류와 Float64Array 복사)과 그 오류 경로
    @MainActor private static func asyncJobs() async throws {
        let engine = try BaroChartEngine(options: BaroChartEngineOptions())
        try engine.setBars(TraceFixture.bars(64))
        try engine.addIndicator(.sma(period: 4), id: "sma")
        try engine.addSeries(BaroChartSeries(id: "sma-line", type: .line, indicator: "sma"))
        _ = try engine.addDrawing(BaroChartDrawing(tool: .horizontal, points: [TraceFixture.point(30, 110)]))
        try await TraceFixture.job {try engine.applyDataEventAsync(["kind": "correction", "bar": TraceFixture.barDictionary(20, close: 104.5)], completion: $0)}
        try await TraceFixture.job {try engine.prepareColumnsAsync(try TraceFixture.columns(40), visibleBars: 30, completion: $0)}
        try await TraceFixture.job {try engine.prepareSeededAsync(count: 48, seed: 7, visibleBars: 24, completion: $0)}
        try engine.addIndicator(.ema(period: 4), id: "ema")
        try engine.addSeries(BaroChartSeries(id: "ema-line", type: .line, indicator: "ema"))
        try await TraceFixture.job {try engine.setIndicatorParamsAsync("ema", params: ["period": 6], completion: $0)}
        do {
            try await TraceFixture.job {try engine.setIndicatorParamsAsync("missing", params: ["period": 3], completion: $0)}
            XCTFail("Parameters of a missing indicator must not publish")
        } catch {
            XCTAssertTrue(error is BaroChartLowLevelError || error is BaroChartIngestionError, "\(error)")
        }
        do {
            try await TraceFixture.job {try engine.applyDataEventAsync(["kind": "bogus"], completion: $0)}
            XCTFail("An unknown data event must not apply")
        } catch {
            XCTAssertTrue(error is BaroChartLowLevelError || error is BaroChartIngestionError, "\(error)")
        }
        try engine.close()
    }

    /// 저수준 사전 API: 무손실 값(NaN, -0, ±Infinity, 서로게이트), Float64Array 결과, 수집 큐, 전용 경로, 함수 없음
    @MainActor private static func lowLevel() throws {
        let engine = try BaroChartEngine(count: 24, options: ["panels": [["id": "price"]], "series": [["id": "price", "type": "candles", "panel": "price"]]])
        _ = try engine.call("nativeEcho", [[Double.nan, -0.0, 1e21, 1.5e-7, Double.infinity, -Double.infinity, 0.1, "quote\" back\\ \u{1} tab\t é 😀", NSNull(), true, ["only": 1]]])
        XCTAssertThrowsError(try engine.call("nativeIndicatorBuffer", ["missing", "value", 0, 4]))
        _ = try engine.addIndicator("sma", "sma", ["period": 5])
        _ = try engine.call("nativeIndicatorBuffer", ["sma", "value", 0, 8])
        _ = try engine.command("inspect")
        XCTAssertThrowsError(try engine.command("nope"))
        XCTAssertThrowsError(try engine.call("nativeMissingFunction"))
        let time = { (index: Int) in 1_700_000_000_000.0 + Double(index) * 60_000 }
        let bar = { (index: Int, close: Double) -> [String: Any] in ["time": time(index), "open": close, "high": close + 1, "low": close - 1, "close": close, "volume": Double(index + 100)] }
        _ = try engine.applyDataEvents([["kind": "append", "bar": bar(24, 111)], ["kind": "update", "bar": bar(24, 112)]])
        XCTAssertThrowsError(try engine.applyDataEvents([["kind": "append", "bar": bar(2, 90)]]))
        _ = try engine.applyDataEvents([["kind": "update", "bar": bar(24, 112)]], skipUnchanged: true)
        _ = try engine.applyDataEvents([["kind": "update", "bar": bar(24, 113)]], skipUnchanged: true)
        _ = try engine.configureDataIngestion(["streamId": "trace", "generation": 1, "firstSequence": 0, "maxQueuedEvents": 8, "maxQueuedBytes": 392,
                                               "maxBatchEvents": 3, "maxStoredBars": 64, "maxStoreBytes": 6144])
        _ = try engine.enqueueDataEvents(["streamId": "trace", "generation": 1, "firstSequence": 0, "events": [["kind": "update", "bar": bar(24, 114)], ["kind": "append", "bar": bar(25, 115)]]])
        XCTAssertThrowsError(try engine.enqueueDataEvents(["streamId": "trace", "generation": 1, "firstSequence": 0, "events": [["kind": "update", "bar": bar(25, 116)]]]))
        _ = try engine.drainDataEvents(1)
        _ = try engine.pauseDataIngestion()
        _ = try engine.resumeDataIngestion()
        _ = try engine.drainDataEvents()
        _ = try engine.dataIngestionStats()
        _ = try engine.saveDataIngestion()
        _ = try engine.setDataExploration(true)
        _ = try engine.navigateDataExploration("ArrowLeft")
        _ = try engine.readDataExploration()
        _ = try engine.refreshDataExploration()
        _ = try engine.setDataExploration(false)
        _ = try engine.dataAt(["index": 3])
        _ = try engine.crosshairSnapshot(width: 400, height: 300)
        let first = try engine.addDrawing(["type": "horizontal", "points": [["time": time(5), "price": 105]]])
        _ = try engine.translateDrawings([first], deltaTimeMs: 60_000, deltaPrice: 1.5)
        _ = try engine.setDrawingsStyle([first], patch: ["color": "#123456"])
        _ = try engine.setDrawingVisibility(first, visible: false)
        _ = try engine.duplicateDrawings([first], deltaTimeMs: 0, deltaPrice: 2)
        _ = try engine.deleteDrawing(first)
        _ = try engine.registerIndicatorModule("aster.volume-direction", version: 1)
        _ = try engine.saveStudies()
        try engine.close()
    }
}

/// 시나리오가 쓰는 고정 입력
enum TraceFixture {
    /// 첫 막대 시각(UTC epoch ms)
    static let start = 1_700_000_000_000.0
    /// 워크스페이스 바인딩
    static let binding = BaroChartDatasetBinding(key: "TRACE:US", revision: "1", adjustmentVersion: "raw", priceUnit: "USD", adjustment: .raw)
    /// 고정 오프셋 시간대 심볼(Intl을 부르지 않아 엔진·OS 판에 따라 결과가 바뀌지 않는다)
    static let symbol = BaroChartSymbol(id: "TRACE", exchange: "TEST", timezone: "+09:00", currency: "USD", priceDecimals: 2, tickSize: 0.01)

    /// index번째 1분봉. 가격은 이진수로 정확한 0.25 단위다.
    static func bar(_ index: Int, close: Double? = nil) -> BaroChartBar {
        let value = close ?? 100 + Double(index) * 0.5 + (index % 3 == 0 ? 0.75 : -0.25)
        return BaroChartBar(time: start + Double(index) * 60_000, open: value - 0.5, high: value + 1, low: value - 1.5, close: value, volume: 1000 + Double(index * 10))
    }

    /// from부터 count개의 막대
    static func bars(_ count: Int, from offset: Int = 0) -> [BaroChartBar] {(0..<count).map {bar($0 + offset)}}

    /// 저수준 이벤트용 막대 딕셔너리
    static func barDictionary(_ index: Int, close: Double) -> [String: Any] {
        let value = bar(index, close: close)
        return ["time": value.time, "open": value.open, "high": value.high, "low": value.low, "close": value.close, "volume": value.volume]
    }

    /// count개 막대의 여섯 열
    static func columns(_ count: Int) throws -> BaroChartColumns {
        let rows = bars(count)
        return try BaroChartColumns(time: rows.map(\.time), open: rows.map(\.open), high: rows.map(\.high), low: rows.map(\.low), close: rows.map(\.close), volume: rows.map(\.volume))
    }

    /// index번째 막대 시각의 가격 점
    static func point(_ index: Int, _ price: Double) -> BaroChartPoint {BaroChartPoint(time: start + Double(index) * 60_000, price: price)}

    /// 렌더러가 기대하는 좌상단 원점·아래로 증가하는 좌표의 비트맵
    static func bitmap(width: Int, height: Int, scale: Double) throws -> CGContext {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
        return context
    }

    /// 완료 콜백형 비동기 작업 하나를 시작하고 끝날 때까지 기다린다(실패는 그대로 던진다).
    @MainActor static func job<Metrics>(_ start: (@escaping (Result<Metrics, Error>) -> Void) throws -> Any) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                _ = try start { result in
                    switch result {
                    case .success: continuation.resume()
                    case .failure(let error): continuation.resume(throwing: error)
                    }
                }
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

/// 추적 파일과 골든 읽기·쓰기
enum TraceFiles {
    /// 비교할 추적 파일 하나(이름과 정규화한 글자)
    struct Trace {
        /// 골든 파일 이름(<시나리오>-runtime-<n>.jsonl)
        let name: String
        /// UUID 토큰을 순번으로 바꾼 글자
        let text: String
    }

    /// 이 테스트만 쓰는 빈 임시 디렉터리. 테스트가 끝나면 지운다(지우지 못하면 테스트 실패로 알린다).
    static func temporaryDirectory(_ label: String, removedAfter testCase: XCTestCase) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("barochart-trace-\(label)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        testCase.addTeardownBlock {
            do {try FileManager.default.removeItem(at: url)} catch {XCTFail("Temporary trace directory \(url.path) could not be removed: \(error)")}
        }
        return url
    }

    /// 시나리오 디렉터리의 추적을 런타임 번호 순으로 읽는다.
    static func traces(in directory: URL, scenario: TraceScenario) throws -> [Trace] {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter {$0.hasPrefix("runtime-") && $0.hasSuffix(".jsonl")}
        return try names.sorted {runtimeNumber($0) < runtimeNumber($1)}.map {name in
            Trace(name: "\(scenario.rawValue)-\(name)", text: normalized(try String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8)))
        }
    }

    /// 묶음 자원으로 실린 골든을 읽는다.
    static func goldens(_ scenario: TraceScenario) throws -> [Trace] {
        let directory = try XCTUnwrap(Bundle.module.url(forResource: "traces", withExtension: nil), "Trace goldens are not bundled")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter {$0.hasPrefix(scenario.rawValue + "-runtime-")}
        return try names.sorted {runtimeNumber($0) < runtimeNumber($1)}.map {
            Trace(name: $0, text: try String(contentsOf: directory.appendingPathComponent($0), encoding: .utf8))
        }
    }

    /// 골든을 소스 트리의 Fixtures/traces에 새로 쓴다(그 시나리오의 옛 파일은 지운다).
    static func writeGoldens(_ traces: [Trace], scenario: TraceScenario, file: StaticString = #filePath) throws {
        let directory = URL(fileURLWithPath: "\(file)").deletingLastPathComponent().appendingPathComponent("Fixtures/traces")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) where name.hasPrefix(scenario.rawValue + "-runtime-") {
            try FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
        for trace in traces {try Data(trace.text.utf8).write(to: directory.appendingPathComponent(trace.name))}
    }

    /// 파일 이름의 런타임 번호
    private static func runtimeNumber(_ name: String) -> Int {
        Int(name.split(separator: "-").last?.split(separator: ".").first ?? "") ?? 0
    }

    /// 프레임 렌더러가 만든 무작위 UUID 토큰을 처음 나온 순서대로 <uuid-n>으로 바꾼다. 그 밖의 글자는 그대로다.
    static func normalized(_ text: String) -> String {
        guard let pattern = try? NSRegularExpression(pattern: "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}") else {return text}
        var result = "", cursor = text.startIndex, seen: [String: Int] = [:]
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text) else {continue}
            let token = String(text[range]), number = seen[token] ?? seen.count + 1
            seen[token] = number
            result += text[cursor..<range.lowerBound] + "<uuid-\(number)>"
            cursor = range.upperBound
        }
        return result + text[cursor...]
    }

    /// 처음 다른 줄과 그 앞뒤(실패 문구용, 길면 자른다)
    static func firstDifference(_ actual: String, _ expected: String) -> String {
        let left = actual.components(separatedBy: "\n"), right = expected.components(separatedBy: "\n")
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : "<missing>", e = index < right.count ? right[index] : "<missing>"
            if a != e {return "line \(index + 1)\n actual:   \(a.prefix(600))\n expected: \(e.prefix(600))"}
        }
        return "texts differ only in length"
    }
}
