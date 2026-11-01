import Foundation
import BaroChart

/// 클라우드에서 작성만 되고 Swift/JSC에서 실행된 적 없던 최근 공개 API를 실제로 실행한다.
///
/// 각 API를 정상 경로 1회와 실패 경로 1회씩 호출하고, 통과한 검사 이름을 반환한다.
/// 기존 probe(`main.swift`)와 같은 엔진 소유 규칙(메인 스레드 소유)을 따른다.
/// - Parameter makeColumns: 테스트용 OHLCV 열을 만드는 함수(기존 probe의 `columns`)
/// - Returns: 통과한 검사 이름 목록
/// - Throws: 검사가 실패하면 `ProbeError.failed`
func runRecentAPIProbe(makeColumns: (Int) throws -> BaroChartColumns) throws -> [String] {
    var passed = [String]()
    let engine = try BaroChartEngine()
    defer { try? engine.close() }
    let source = try makeColumns(64)
    try engine.setData(probeBars(source))
    try engine.addIndicator("recent-ema", "ema", ["period": 3])
    passed += try probeCompaction(engine)
    passed += try probeDrawingGroups(engine, source: source)
    passed += try probeParamsAsync(engine)
    passed += try probeWorkspaceAsync(engine, makeColumns: makeColumns)
    return passed
}

/// 열 데이터를 `BaroChartBar` 배열로 바꾼다
private func probeBars(_ source: BaroChartColumns) -> [BaroChartBar] {
    (0..<source.length).map {
        BaroChartBar(time: source.time[$0], open: source.open[$0], high: source.high[$0],
                 low: source.low[$0], close: source.close[$0], volume: source.volume[$0])
    }
}

/// `inspect` 명령 결과의 저장 봉 수
private func storedBars(_ engine: BaroChartEngine) throws -> Int? {
    (try engine.command("inspect").toDictionary() as? [String: Any])?["storedBars"] as? Int
}

/// 실패해야 하는 호출이 실제로 던지는지 확인한다
private func expectThrow(_ name: String, _ body: () throws -> Void) throws -> String {
    do { try body() } catch { return name }
    throw ProbeError.failed("\(name) unexpectedly succeeded")
}

/// 보존 창 압축: 정상 축소와 잘못된 옵션 거부
private func probeCompaction(_ engine: BaroChartEngine) throws -> [String] {
    _ = try engine.compactData(["keepLastBars": 40, "studyHistory": "restart"])
    guard try storedBars(engine) == 40 else { throw ProbeError.failed("compactData keeps the newest 40 bars") }
    let rejected = try expectThrow("compactData rejects a non-positive window") {
        _ = try engine.compactData(["keepLastBars": 0, "studyHistory": "restart"])
    }
    return ["compactData keeps the newest 40 bars", rejected]
}

/// 드로잉 묶음 이동·삭제: 정상 경로와 없는 ID 거부
private func probeDrawingGroups(_ engine: BaroChartEngine, source: BaroChartColumns) throws -> [String] {
    let anchor = source.time[source.length - 5]
    let id = try engine.addDrawing(["id": "recent-line", "type": "horizontal", "points": [["time": anchor, "price": 101.0]]])
    let before = try engine.saveDrawings()
    _ = try engine.translateDrawings([id], deltaTimeMs: 0, deltaPrice: 2)
    guard try engine.saveDrawings() != before else { throw ProbeError.failed("translateDrawings moves the stored anchor") }
    let missingMove = try expectThrow("translateDrawings rejects a missing ID") {
        _ = try engine.translateDrawings(["missing"], deltaTimeMs: 0, deltaPrice: 1)
    }
    _ = try engine.deleteDrawings([id])
    guard !(try engine.saveDrawings()).contains("recent-line") else { throw ProbeError.failed("deleteDrawings removes the drawing") }
    let missingDelete = try expectThrow("deleteDrawings rejects a missing ID") { _ = try engine.deleteDrawings(["missing"]) }
    return ["translateDrawings moves the stored anchor", missingMove, "deleteDrawings removes the drawing", missingDelete]
}

/// 비동기 지표 파라미터 변경: 커밋 성공과 없는 지표 거부
private func probeParamsAsync(_ engine: BaroChartEngine) throws -> [String] {
    var result: Result<BaroChartParamsMetrics, Error>?
    let job = try engine.setIndicatorParamsAsync("recent-ema", params: ["period": 5]) { result = $0 }
    try wait { result != nil }
    _ = job
    let metrics = try result!.get()
    guard metrics.outcome == .committed else { throw ProbeError.failed("setIndicatorParamsAsync commits (\(metrics.outcome))") }
    var missing: Result<BaroChartParamsMetrics, Error>?
    var rejectedAtCall = false
    do {
        let missingJob = try engine.setIndicatorParamsAsync("missing-study", params: ["period": 5]) { missing = $0 }
        try wait { missing != nil }
        _ = missingJob
    } catch { rejectedAtCall = true }
    if !rejectedAtCall, case .success = missing! { throw ProbeError.failed("setIndicatorParamsAsync accepted a missing study") }
    return ["setIndicatorParamsAsync commits a new period", "setIndicatorParamsAsync rejects a missing study"]
}

/// 비동기 작업공간 복원: 저장 → 새 엔진 복원 성공과 바인딩 불일치 거부
private func probeWorkspaceAsync(_ engine: BaroChartEngine, makeColumns: (Int) throws -> BaroChartColumns) throws -> [String] {
    let binding: [String: Any] = ["key": "SYNTH:US", "revision": "r1", "adjustmentVersion": "a1", "priceUnit": "USD", "adjustment": "raw"]
    let document = try engine.saveWorkspace(binding)
    let target = try BaroChartEngine()
    defer { try? target.close() }
    let compacted = try makeColumns(64)
    try target.setData(Array(probeBars(compacted).suffix(40)))
    var restored: Result<BaroChartWorkspaceMetrics, Error>?
    let job = try target.restoreWorkspaceAsync(document, datasetBinding: binding) { restored = $0 }
    try wait { restored != nil }
    _ = job
    _ = try restored!.get()
    guard try target.saveWorkspace(binding) == document else { throw ProbeError.failed("restoreWorkspaceAsync reproduces the saved document") }
    var mismatch: Result<BaroChartWorkspaceMetrics, Error>?
    var mismatchAtCall = false
    var wrongBinding = binding
    wrongBinding["revision"] = "r2"
    do {
        let mismatchJob = try target.restoreWorkspaceAsync(document, datasetBinding: wrongBinding) { mismatch = $0 }
        try wait { mismatch != nil }
        _ = mismatchJob
    } catch { mismatchAtCall = true }
    if !mismatchAtCall, case .success = mismatch! { throw ProbeError.failed("restoreWorkspaceAsync accepted a mismatched binding") }
    return ["restoreWorkspaceAsync reproduces the saved document", "restoreWorkspaceAsync rejects a mismatched binding"]
}
