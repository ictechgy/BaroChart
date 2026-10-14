# Native entry-only asynchronous indicator parameters

Design and staged implementation contract. Source-level async facades are now
provided for Java and Swift as experimental integration APIs, with different
validation limits below. Both SDKs expose synchronous
`setIndicatorParams`; the web Worker API is already entry-only. Whole-workspace
native restoration replaces the runtime and is not an equivalent implementation.
The entry-only native contract preserves the original runtime, ChartModel, BarStore,
other indicator entries, drawing history, series styles and axis bindings.

## Execution and ownership

1. On the owner thread, admit one engine job under the existing global job/byte
   limits. Reject another prepare/restore/params job, active gesture/transaction,
   or nonempty ingestion queue. Capture a host-known monotonically increasing
   registration plus a source-runtime ticket. Registration is correlation, not
   an authorization credential. Hold the ingestion lease until publication/abort.
2. Validate plain primitive params, linked static module/version, output schema
   and effective plot offsets. Replace the entire params object. Schema/offset
   changes are rejected; no-op equality uses Object.is (including signed zero).
   Source entry calculation is not invoked during admission. Copy six columns in
   bounded owner tasks; no borrowed view escapes the synchronous copy operation.
3. In an isolated background runtime, validate source rows and calculate only the
   requested entry through bounded generator steps. The job fixes maxBars on its
   first step (1..16384); changing it later is rejected because a suspended
   calculation generator retains its initial chunk size. No new scene, price index or
   other study is required. Custom linked code is trusted, not preemptible within
   a callback; limits bound cooperative work and encoded transport, not arbitrary
   callback CPU/allocation.
4. Send output Float64 slices and checkpoint records back into detached staging
   owned by the original runtime. Validate exact registration/request/module,
   schema/order/offsets, source length and capacity, finite-or-NaN values and NaN
   output tails. Checkpoint indices must be exactly 0,256,...floor(n/256)*256
   for nonempty data, empty for n=0. Preserve the existing signed-zero/NaN/Infinity
   checkpoint codec. At most 256KiB UTF-16 charge per encoded record and 32MiB
   total; validate one record at a time, never one giant owner JSON parse.
5. Dispose the worker runtime and wait for its actual cleanup acknowledgment.
   Release the source ingestion lease, finish callbacks, then check source/owner,
   host revision, all entry/registry identities, definition/module, series/axes/
   panels configuration and original target identity one final time. Commit only
   the target entry and invalidate its derived caches without callbacks.
6. Retain a bounded registration-bound terminal receipt in the source runtime so
   JNI/JSC response loss after commit can be queried rather than blindly retried.
   Release busy/global reservations before observer notification. Notification is
   once per committed registration; postcommit callback errors cannot change a
   successful operation into a failed mutation. Unknown commit state is pending,
   never permission to reapply. Older registrations cannot abort a newer job.

Copy completion does not release the source ticket. Source mutation during
worker execution/validation is stale; there is no automatic retry. Ingestion
lease release uncertainty retains the captured source/runtime and reservation.
Source close must not redirect cleanup to a replacement handle. Cleanup must be
idempotent across lost begin/abort replies, queued callbacks and engine close.

## Admission and checkpoint ownership

Count existing source typed buffers/indices/outputs/checkpoints, isolated worker
source and outputs, owner staging outputs/checkpoints, record metadata and the
bounded in-flight copy/parse scratch simultaneously. This is logical admission,
not an RSS limit or a bound on unrelated idle engines or caller-held old outputs.
Descriptor-before-admission failures need a provisional reservation or an explicit
slot-only limitation, never an asserted zero-byte total bound.

At publication admission, check other retained entries plus replacement
checkpoints against 32 MiB, excluding the retiring target. The adopted map keeps
its fixed remaining-budget allowance. Later growth or clearing of other entries
does not redistribute that allowance: this is not a lifetime engine-wide limit.
A sustained shared ledger would require separate growth-accounting validation.
This source admission contract also does not establish the host process memory
cap or RSS; host job reservations and cleanup acknowledgment remain separate.
Staging retains its own reservation until ownership transfer. Transfer/retirement
must be callback-free and exception-free after publication begins. Ordinary and
NativeCheckpointEntries source maps use the internal identity-gated ownership
helpers; borrowed temporary engine maps do not own or retire the source entries.

## Staged acceptance

- Target protocol: all builtins versus fresh engine oracle, empty/hidden/multi-
  output, bounded chunks, malformed rows, schema/offset/module drift, checkpoint
  overflow and callback reentry, cancellation/disposal, no old-entry access.
- Source staging: wrong/late/duplicate packets, missing/out-of-order slices and
  records, capacity/NaN tails, source/entry replacement, params +/-0, unchanged
  unrelated held outputs; update/append/correction after publication versus fresh
  calculation. Full output and checkpoint budgets include non-target entries.
- Host state machines: real-thread fake transport and compile-only Java harness;
  owner queue failure, response loss/status, cleanup acknowledgment, cancellation
  at each phase, coalesced progress, close/reentry, observer exceptions and once
  release. Swift lifetime is statically reviewed until platform execution exists.
- Actual generated-bundle VM and standalone QuickJS protocols are separate from
  Android/JNI or Swift/JSC execution. SDK/device builds are not performed here.

Java now has the source-level async facade described below. Its cloud checks do
not establish Android/JNI runtime support. Swift now has a source implementation
and static ownership checks, without Swift compilation or JSC execution.

## Initial internal target slice

NativeParamsTarget is an internal computation building block, not a Swift/Java
async facade. Its input and output slices are borrowed Float64 views: the host
must copy immediately, may fill input only during capture, and must not write an
old input view after start or a returned output view. The final owner validator
must revalidate every transferred output and checkpoint before publication.
An isolated target does not prove source freshness or authenticate a result.

Ordinary entry-map adoption uses a private map-keyed ownership registry. It keeps
the original entries Map identity and does not claim borrowed candidate entries.
Managed removal, disposal, sync/web params replacement retire only registered
records after a successful map change. Direct replacement of engine.entries or
Map intrinsics is outside this contract. NativeCheckpointEntries keeps its own
existing ownership mechanism. Engine-wide result admission remains required in
the source publication stage; this helper alone does not enforce that budget.

Initial cloud verification: 229 related Node regressions passed, including the
ordinary-map adoption lifecycle, existing checkpoint and parameter packet tests,
calculation reentry, and isolated target tests. A standalone vendored QuickJS run
passed 71 target oracle/cleanup assertions for 35 builtins, plus runtime, OOM and
interrupt cleanup with zero final live allocations. The C executable was reused
after verifying its host/vendor source hashes against its recorded build. This
is not a new native SDK compilation or an end-to-end async parameter API test.

## Original-runtime transport (internal protocol)

`NativeParamsCapture` retains the original model, BarStore and entries map while
`NativeParamsImport` owns detached replacement vectors and bounded checkpoints.
Only the selected entry is adopted. All its derived series indices are retired,
even when the new numeric revision equals the old revision. Borrowed old output
vectors are not overwritten by the replacement. Copy, calculation, receipt and
validation retain the ingestion lease; source/configuration changes invalidate
the job. The host must acknowledge worker cleanup before source prepare releases
the lease, and must fence cancellation around final publication.

The internal bridge uses an increasing host-known registration and a fixed source
ticket. It records registration before construction. Status lookup retains the
latest four records, including committed/unchanged receipts; returned status is
a copy. A lost Begin or Publish response is resolved by status/abort for the same
registration, never by unconditional replay. Unknown or evicted status is
inconclusive. These tokens correlate ownership; they are not security credentials.
Notification, once-only completion and host reservation release are host
responsibilities. The Java and Swift source implementations below connect these
stages, with different unresolved-publication completion policies.

Source columns and result vectors transfer in at most 16,384-value slices using
the existing F64 buffer transport. An original-runtime result write requires a
matching one-use ticket/slot/offset/count arm immediately before the write. The
host serializes these two calls on the owner thread; it must not interleave jobs
or retain borrowed views. Because legacy writeBuffer carries no ticket, a late
write with the same slice cannot be distinguished from a new arm by JS alone;
arm and write must be consecutive within one owner turn, never separate queued
callbacks. Every result value and NaN tail is checked before
publication. Each checkpoint is decoded independently with a native UTF-16 byte
limit, avoiding a single giant checkpoint JSON parse. First use of each result
vector still allocates/zeros its full capacity; allocation/GC and a single record
parse are not cooperatively preemptible. No UI latency bound is claimed.

VM transport tests exercise two isolated JS contexts and response loss by
ignoring an executed call's response. They do not simulate JNI/JSC serialization,
owner threads, actual native cancellation or OS process memory limits. Those
remain acceptance work for the host stages.

The source/transport slice passed 400 related Node tests, including two-context
transport, old-token isolation, constructor reentry, status-copy integrity and
post-cleanup stale rejection. A standalone vendored QuickJS run passed the 12
source-protocol assertions plus normal/OOM/interrupt cleanup with zero remaining
tracked allocations. Strict TypeScript and offline package checks passed. This is
a related-suite result, not a rerun of the entire project suite or native SDK QA.


## Java source facade and execution boundary

`AsterEngine.setIndicatorParamsAsync(id, params, options, listener)` returns a
`ParamsJob`. The complete parameter object replaces the old settings. The engine
must be main/UI-owned and no other async job may be active. There is no implicit
supersession. A custom indicator must be application-linked in the native bundle;
source strings and downloaded modules are not accepted for this operation.

The original runtime, store and unrelated entries remain in place. A temporary
worker runtime computes one replacement, sends bounded vectors/checkpoints back,
and is freed before owner prepare/publication. Workspace restore and
parameter jobs share two admission slots and 768 MiB of known logical bytes.
Before a descriptor is established only the slot is reserved. This is not an RSS
bound. Ordinary idle engine memory and externally held old results remain outside
that shared active-job budget.

`cancel()` is thread-safe; `cleanupPending()` and `commitOutcome()` expose state.
`retryCleanup()` must run on the original owner thread. An unavailable owner queue
retains the source and reservation until owner recovery. Completion metrics carry
`commitOutcome` (`notCommitted`, `committed`, `unchanged`, or `unknown`) and
`cleanupState`. Committed publication is not undone by later cancellation or
observer errors. An unchanged replacement completes without observer notification.

A lost publication reply is resolved through the registration status. If that
lookup also fails, outcome remains unknown, the engine remains busy and cleanup
is pending. Do not retry the mutation. Confirmed engine close plus worker cleanup
can complete as `indeterminate`/`unknown` without notification; this does not say
whether publication happened before close. If native free itself throws, its
outcome is uncertain: no blind second free, false success, or budget release is
performed. Such a pending job can continue occupying admission capacity.

Cancellation/deadlines are cooperative between native calls. A trusted custom
factory/step/validator, a single checkpoint parse, allocation or GC cannot be
preempted by this Java scheduler. No hard UI-latency or custom-code sandbox bound
is implied. The owner still performs bounded result validation and publication.

Cloud tests execute the production Java state machine with an independent fake
transport and real JVM worker threads. The complete Engine is typechecked against
compile-only Android and JSON signatures. Actual Handler scheduling, JSON/JNI
serialization, allocator behavior, Android builds and devices remain unverified.
Swift compilation/JSC runtime validation remains pending for the source implementation below.


## Swift source facade (not compiled or executed on Apple platforms)

**Experimental and unverified on Apple platforms.** Static checks cannot establish
Swift compilation, concurrency diagnostics, actual ARC cleanup, or JSC behavior.

`AsterEngine.setIndicatorParamsAsync(_:params:timeout:maxBarsPerStep:progress:completion:)`
returns `AsterParamsJob`. Create and call the engine on the main thread. The source
runtime, model, store and unrelated entries stay in place. The worker uses an
independent VM with a fixed calculation chunk (1..16,384). Static modules must be
prelinked in the same bundle; arbitrary registered source strings are unsupported.

The entire worker computation and return transfer are inside an outer
`autoreleasepool`. Only owned `Data`, bounded checkpoint/descriptor strings and
primitive progress/results cross to the owner. The main cleanup acknowledgment
is enqueued after the pool exits. The owner then prepares and publishes; no
worker context is installed in the engine. This source ordering has static tests,
not evidence of actual JSC/ARC release timing or Swift 6 concurrency compilation.

Workspace and parameter jobs share two opaque admission slots and 768 MiB of
known logical admitted bytes. Before a descriptor is known only the slot is
bounded. Pending recovery and retiring-source creator acknowledgment keep that
reservation. Existing generic prepare jobs and idle engine memory are not covered
by this combined workspace/params accounting. The checkpoint limit remains the
publication-time policy described above, not a lifetime engine/RSS ceiling.

`cancel()` and `commitOutcome` are thread-safe. `cleanupPending`,
`job.retryCleanup()`, `AsterEngine.paramsCleanupStatus()` and
`AsterEngine.retryParamsCleanup(registration)` are main-owner operations.
Cancellation linearizes immediately before publication without holding a lock
across JavaScript. Once publication begins, a confirmed commit wins over later
cancellation/deadline. A noop completes as `unchanged`, without redraw.

### Uncertain publication and recovery

Swift differs from the Java host: closing an engine does not prove destruction
of its publicly exposed raw `JSContext`. Therefore close never converts an unknown
publication to cleanup-complete merely because the engine is closed.

If publication/status or Abort cannot be confirmed, the original completion is
called **once** with `AsterParamsError.cleanupPending(registration:outcome:)`.
This is **not permission to call the mutation again**. The job drops its client
progress/completion closures and error references. A bounded recovery registry
keeps the original context, actual creator-retirement lease, registration,
admission and small state. Engine/job references there are weak. It does not keep
client callbacks or an `Error` object.

Retry the original registration explicitly, even after the engine has closed or
been released. Each retry makes one Status/Abort attempt and returns numeric/enum
status snapshots. It never calls the original completion a second time. Keep the
returned outcome if the record is removed; an absent record alone does not mean
committed. `paramsCleanupStatus()` reports remaining records. An unresolved record
continues holding capacity; there is no automatic retry loop or hard timeout of
trusted synchronous JavaScript.

After confirmed release, any retiring-source creator cleanup must acknowledge
before admission/busy is released. If a previously unknown commit is then found,
an open engine still owning that exact source context is redrawn once, after
budget release. Closed, deallocated or replaced engines are not notified. Ordinary
observer errors use the existing bounded `observerErrors` / `onObserverError`
channel and do not reverse publication.

```swift
// Source example only: this new API has not been Swift-compiled in cloud checks.
var pendingRegistration: Int?
let job = try engine.setIndicatorParamsAsync("trend", params: ["period": 30]) { result in
    switch result {
    case .success(let metrics):
        print(metrics.outcome) // committed or unchanged
    case .failure(let error):
        if case AsterParamsError.cleanupPending(let registration, let outcome) = error {
            pendingRegistration = registration
            print("Publication/cleanup requires recovery", outcome)
            // Do not issue another setIndicatorParamsAsync here.
        } else {
            print(error)
        }
    }
}
// Later, from the main owner, even if the old engine has closed:
if let registration = pendingRegistration {
    let results = try AsterEngine.retryParamsCleanup(registration)
    let remaining = try AsterEngine.paramsCleanupStatus()
    // Record each result.outcome; if awaitingCreatorCleanup is true, inspect
    // remaining again after the creator acknowledgment. Do not retry mutation.
    print(results, remaining)
}
// Optional, before publication: job.cancel()
```

Each F64 transfer is at most 16,384 values; checkpoint decode is one record at a
time (256 KiB UTF-16 accounting) and output validation is chunked. This still
allocates full staged output vectors on the owner and can execute trusted factory,
validator, allocation/GC, or one record parse synchronously. No hard main-thread
latency bound is claimed. Actual Apple SDK compilation, JSC transfer/ARC behavior,
cancel/close/recovery races and device lifecycle tests remain required.
