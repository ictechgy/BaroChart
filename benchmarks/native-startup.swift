import Foundation
// 엔진 생성(번들 평가) → 첫 scene(2,000봉, 1200x700) 시간을 번들별로 잰다. 인자: 번들 경로들.
// scripts/measure-native-startup.mjs가 SDK 소스와 함께 컴파일해 실행한다(macOS JavaScriptCore).
func measure(_ url: URL, runs: Int) throws -> [Double] {
    var samples: [Double] = []
    for _ in 0..<(runs + 3) {
        let start = DispatchTime.now().uptimeNanoseconds
        let engine = try BaroChartEngine(bundleURL: url, count: 2000, options: nil)
        _ = try engine.scene(width: 1200, height: 700)
        samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
        try engine.close()
    }
    return Array(samples.dropFirst(3)).sorted()
}
var result: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
    let s = try measure(URL(fileURLWithPath: path), runs: 30)
    result.append(["bundle": (path as NSString).lastPathComponent, "p50Ms": s[s.count / 2], "p95Ms": s[Int(Double(s.count) * 0.95)], "runs": s.count])
}
print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
