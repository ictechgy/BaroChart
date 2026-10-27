import Foundation

private final class UnsupportedJSONValue {}
private enum JSONInputProbeError: Error { case accepted(String) }

private func protocolMessage(_ error: Error?) -> String? {
    guard let error, case let AsterAsyncError.invalidProtocol(message) = error else { return nil }
    return message
}

private func statusSignature(_ statuses: [AsterWorkspaceCleanupStatus]) -> [[String: Any]] {
    statuses.map {
        ["registration": $0.registration, "admittedLogicalBytes": $0.admittedLogicalBytes,
         "retryFailures": $0.retryFailures, "admitted": $0.admitted,
         "awaitingCreatorCleanup": $0.awaitingCreatorCleanup]
    }
}

private func paramsSignature(_ statuses: [AsterParamsStatus]) -> [[String: Any]] {
    statuses.map {
        ["registration": $0.registration, "admittedLogicalBytes": $0.admittedLogicalBytes,
         "retryFailures": $0.retryFailures, "outcome": $0.outcome.rawValue,
         "cleanupPending": $0.cleanupPending, "awaitingCreatorCleanup": $0.awaitingCreatorCleanup]
    }
}

private func canonicalJSON(_ value: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else { throw AsterError.invalidScene }
    return text
}

/// Public Swift SDK regression probe for JSON boundary inputs. The invalid
/// cases are run through each public async entry point and must reject before
/// reservation, callbacks, or owner revision notification.
func verifyNativeJSONInputs(_ bundleURL: URL) throws -> [String: Any] {
    let engine = try AsterEngine(bundleURL: bundleURL, count: 0)
    var checks: [String] = [], failures: [String] = []
    var observerCalls = 0, callbackCalls = 0, progressCalls = 0
    let observer = try engine.observeChanges { observerCalls += 1 }
    defer { try? engine.removeObserver(observer); try? engine.close() }

    func require(_ value: Bool, _ name: String) {
        if value { checks.append(name) } else { failures.append(name) }
    }

    let invalidCases: [(String, [String: Any])] = [
        ("NaN", ["value": Double.nan]),
        ("positiveInfinity", ["value": Double.infinity]),
        ("negativeInfinity", ["value": -Double.infinity]),
        ("Date", ["value": Date(timeIntervalSince1970: 0)]),
        ("nestedUnsupportedValue", ["nested": ["value": UnsupportedJSONValue()]])
    ]

    func checkInvalid(_ api: String, _ name: String, _ payload: [String: Any], _ expected: String,
                      _ operation: () throws -> Void) throws {
        let beforeRevision = engine.revision
        let beforeObserverCalls = observerCalls
        let beforeCallbackCalls = callbackCalls
        let beforeProgressCalls = progressCalls
        let beforeWorkspace = try canonicalJSON(statusSignature(AsterEngine.workspaceCleanupStatus()))
        let beforeParams = try canonicalJSON(paramsSignature(AsterEngine.paramsCleanupStatus()))
        var thrown: Error?
        do { try operation() } catch { thrown = error }
        require(protocolMessage(thrown) == expected, "\(api) \(name) throws fixed invalidProtocol")
        require(engine.revision == beforeRevision, "\(api) \(name) preserves revision")
        require(observerCalls == beforeObserverCalls, "\(api) \(name) starts no observer callback")
        require(callbackCalls == beforeCallbackCalls, "\(api) \(name) starts no completion callback")
        require(progressCalls == beforeProgressCalls, "\(api) \(name) starts no progress callback")
        require(try canonicalJSON(statusSignature(AsterEngine.workspaceCleanupStatus())) == beforeWorkspace,
                "\(api) \(name) preserves workspace admission state")
        require(try canonicalJSON(paramsSignature(AsterEngine.paramsCleanupStatus())) == beforeParams,
                "\(api) \(name) preserves params admission state")
        _ = payload
    }

    for (name, payload) in invalidCases {
        try checkInvalid("setIndicatorParamsAsync", name, payload, "Params request must be valid JSON") {
            let job = try engine.setIndicatorParamsAsync("json-probe", params: payload, progress: { _ in progressCalls += 1 }) { _ in callbackCalls += 1 }
            job.cancel()
            throw JSONInputProbeError.accepted("setIndicatorParamsAsync")
        }
        try checkInvalid("restoreWorkspaceAsync", name, payload, "Workspace binding must be valid JSON") {
            let job = try engine.restoreWorkspaceAsync("{}", datasetBinding: payload, progress: { _ in progressCalls += 1 }) { _ in callbackCalls += 1 }
            job.cancel()
            throw JSONInputProbeError.accepted("restoreWorkspaceAsync")
        }
        try checkInvalid("applyDataEventAsync", name, payload, "Data event must be valid JSON") {
            let job = try engine.applyDataEventAsync(payload, progress: { _ in progressCalls += 1 }) { _ in callbackCalls += 1 }
            job.cancel()
            throw JSONInputProbeError.accepted("applyDataEventAsync")
        }
    }

    let int64Value = Int64(4294967296), uint64Value = UInt64(9007199254740991)
    let boundary: [String: Any] = [
        "int64": int64Value, "uint64": uint64Value, "double": 1.25,
        "number": NSNumber(value: 1.25)
    ]
    let boundaryJSON = try canonicalJSON(boundary)
    let decoded = try JSONSerialization.jsonObject(with: Data(boundaryJSON.utf8)) as! [String: Any]
    require(JSONSerialization.isValidJSONObject(boundary), "finite numeric boundary object is valid JSON")
    require((decoded["int64"] as! NSNumber).doubleValue == 4294967296, "Int64 boundary survives JSON round trip")
    require((decoded["uint64"] as! NSNumber).doubleValue == 9007199254740991, "UInt64 safe boundary survives JSON round trip")
    require((decoded["double"] as! NSNumber).doubleValue == 1.25, "Double boundary survives JSON round trip")
    require((decoded["number"] as! NSNumber).doubleValue == 1.25, "NSNumber boundary survives JSON round trip")

    return ["schema": "aster.native.json-inputs", "passed": checks.count, "checks": checks,
            "failures": failures, "failed": !failures.isEmpty, "invalidCases": invalidCases.map({ $0.0 }),
            "observerCalls": observerCalls, "completionCalls": callbackCalls, "progressCalls": progressCalls,
            "boundaryJSON": boundaryJSON]
}
