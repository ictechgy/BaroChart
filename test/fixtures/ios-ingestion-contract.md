# iOS ingestion acceptance evidence

`ios-ingestion-evidence.mjs` generates fictional compact contract inputs and
65-byte replay buffers in memory. It is not a measured run or financial oracle.
No benchmark archive, Simulator, XCTest, or compiled SDK is needed:

```sh
node --test test/ios-ingestion-contract.test.mjs
```

The exported `validateIOSIngestionEvidence` takes a report, its expected
SHA256 (`JSON.stringify(report, null, 2)` byte representation), an independent
host build manifest and owned-run request, completed XCTest status/log/resource
hashes, exactly two actual replay Buffers, and actual Simulator cleanup.
Field-mutation tests refresh the report SHA so rejection exercises structural
guards. Separate byte-binding attacks preserve the expected report/app hash.

The gate requires two model slots, two complete raw6/output22 bitwise oracle
rows, two full replay files with matching SHA/bytes/rows/OHLCV/timestamps and
first/middle corrections, host/core conservation, source/fixture/resource/mode
consistency, actual input endpoints, raw heartbeat/statistic coverage,
process-clock/sampler consistency, committed Escape/save anchors, ARC cleanup
and owned Simulator retirement. A positive certificate is written only after
OS cleanup. A completed output directory is immutable.

Corrected pilots are30–60seconds and never qualify as900seconds. Either original
UIKit or the instrumented copy can qualify as900 only with a full900 request and
observed interval. Original UIKit requires zero draw samples and empty draw
metrics; instrumented requires full frame endpoints and statistics. The former
12second pilot/control predates the corrected first/middle and fourth-pinch
fixture and is retained as historical evidence, not recertified by this gate.

Legacy900 has no in-app run nonce or persisted absolute probe start/end. The
gate binds available owned UUID, destination log, requested config, manifests,
report bytes, replay history clocks and endpoint order. These checks do not
prove cryptographic same-run identity or add missing clocks. It does not invent
undo/redo evidence: the actual fixture checks committed anchors/Escape/save.
Neither mode measures physical-device input, GPU/compositor completion or FPS.
Declared full bitwise oracle coverage is checked; replay bytes do not contain
final indicator output arrays and are not a new independent financial oracle.

Fresh executions require an actual `ps` exit status of0 recorded in cleanup as
`processQueryStatus`. Nonzero/missing status is unavailable: process count/list
are null, the failed query is recorded, and no positive certificate is written.
Empty stdout alone never certifies cleanup. A successful query with no matching
owned UUID rows yields a known zero count.

The trusted caller can explicitly choose `executionPolicy: 'legacy-replay'` for
unchanged archived evidence that never recorded query status. Its outcome has
`processQueryVerified:false` and `newRunCertified:false`. Report fields cannot
downgrade the fresh default policy, and even archive mode rejects a recorded
nonzero status. No query success is added to old raw files.
