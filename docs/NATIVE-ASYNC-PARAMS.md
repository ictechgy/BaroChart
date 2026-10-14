# Native entry-only asynchronous indicator parameters

Design and staged implementation contract. Swift/Java currently expose synchronous
`setIndicatorParams`; the web Worker API is already entry-only. Whole-workspace
native restoration replaces the runtime and is not an equivalent implementation.
The proposed native API must preserve the original runtime, ChartModel, BarStore,
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
NativeCheckpointEntries source maps need explicit compatible retirement behavior;
this must be established before connecting a host facade.

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

No public native async facade is advertised as available until its source
integration and the stated cloud acceptance stages are complete.

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

## Original-runtime transport (internal, host facade pending)

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
Notification, once-only completion and host reservation release are still host
responsibilities and have not been connected to Java/Swift yet.

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
