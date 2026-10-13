# Native workspace restore: staged design

Status: bounded checkpoint storage, isolated JS restore target and bounded source
capture are implemented/tested. Java runtime publication now has a source adapter and an executed production
ownership state machine; see JAVA-WORKSPACE-RESTORE.md. Actual Android/JNI
integration and Swift host publication remain unverified/subsequent work. See
NATIVE-WORKSPACE-TARGET.md.

## Outcome and first-slice scope

Build a new isolated runtime from the current native engine's source columns and
a portable workspace document. Recalculate all studies and indexes there. Only
when validation and source/UI freshness checks succeed does the host atomically
replace its context/handle. Host Engine/view listener identity stays stable;
internal model/BarStore/JSValue identity changes. Old context-bound references must
not be treated as handles into the new runtime. Web's fresh-model/shared-BarStore
contract cannot be promised across JavaScriptCore or QuickJS contexts.

Only portable built-in or version-matched prelinked static modules are accepted.
The host maintains dataset/revision/adjustment metadata. Length/endpoints are
extent assertions, not a content hash. Source arrays are copied in owned bounded
chunks; unmanaged direct writes to their buffers remain unsupported.

Reject pending ingestion, an active gesture/drawing transaction, or another job
before starting. Do not silently drain/cancel a queue or implement implicit latest
wins. A source ingestion lease is retained while preparing. The document does not
restore history, selection, cursor, tool/text, pointer state or an ingestion queue.
Configuration comes from the document, not from the source's final UI.

## Target protocol

1. Validate bounded document/module/binding metadata and reserve the combined
   logical memory budget before source/target allocation. Reserve old and new
   vectors/indexes/checkpoints, documents/copies, transfer chunk and decode scratch;
   current PrepareData's output-only check is insufficient. Report the categories,
   units and exclusions, rather than treating a logical budget as measured RSS.
2. Transfer six source columns only. Check slot/order/offset/count, duplicates,
   missing spans, safe dimensions and bounds. Never copy old indicator outputs or
   raw checkpoint graphs into the target.
3. Reuse PreparedData's incremental OHLCV validation, store-index building,
   calculation and derived-index work where contracts match. New checkpoints use
   [bounded native records](NATIVE-CHECKPOINTS.md), validated before retention.
4. Verify exact requested params, ordered output schema/effective offsets, linked
   module versions, checkpoint positions and all source/target extents. Validate
   target source version/identity after trusted module callbacks.
5. Apply saved symbol/known formatter first, then saved precision, exact view /
   follow and drawings. Existing PreparedData.finishUI's follow reset and old
   nativeAsyncUI capture/import must not overwrite the document. No nearest-time
   snapping of fractional/offscreen/holiday drawing anchors.
6. Target finish transfers ownership of the new model/runtime. Later job cleanup
   must not dispose a successful transferred model. Failure or cancellation frees
   the untransferred target and releases its native checkpoint ledger.

## Source and publication protocol

Capture source runtime/handle, ticket, model/store/API/input identities, managed
source version/columns/dimensions, relevant UI state and host revision. Each read
uses the captured source handle and ticket; never use a current replacement handle
with an old ticket. Late cleanup must not access a freed source runtime.

Cancellation/deadline are monotonic and checked at every transfer/compute/validation
boundary, including after callbacks. Snapshot/provider/parse/allocation or one
trusted create/step/validator callback is not preemptible midway. Completion of the
worker's task does not mean that its successful new runtime should be freed.

Before publication, stop worker access and finish callback-capable source cleanup.
Then recheck source, UI, closed/job identity and cancellation using callback-free
final predicates. Atomically transfer the target context/handle exactly once.
Release busy/budget state before notifying observers, allowing a new job in a
completion callback. Observer throw, cancel, close or reentry after commit must not
turn the already committed success into a failure. Dispose only the retired source
runtime after ownership is unambiguous. Java's prepared=0 ownership pattern and
Swift's context retention must be covered separately when host wiring begins.

## Acceptance sequence

- JS protocol first: independent source/target VMs, exact canonical save and scene /
  indicator/anchor oracle, typed chunk protocol attacks, capacity/record limits,
  partial transfer cleanup, factory/metadata/validator reentry and source/UI stale.
- Real standalone QuickJS: same bounded protocol/codec assertions, plus OOM and
  interrupt cleanup. This does not substitute for JNI or JSC host tests.
- Native host stage later: cancel/close/deadline during capture/compute/finish /
  handoff, release callback changing source/UI, no double free or late progress,
  source ticket lifetime, single success publication and listener preservation.
  Compile and runtime certification require the respective SDK environments.

No new Mac task, SDK installation or device execution is part of the current
Linux implementation stage. See NATIVE-FEATURE-PARITY.md for the platform plan.

## Source capture and admission (JS protocol implemented)

The isolated target and source capture are implemented. The JS-only source
capture object operates with separate admission, transfer, finish-fence and disposal states. See
NATIVE-WORKSPACE-SOURCE.md for the exact protocol and source-record limits.
Its host-facing descriptor binds a ticket to the original model/API/controller,
BarStore, columns, versions, dimensions and managed UI configuration. It rejects
an existing job, queued ingestion, active pointer/drawing gesture and unsupported
source shapes before allocating the new runtime. No automatic drain or retry.

Admission counts full unique backing buffers for source columns/store index,
indicator arrays and series indexes/borrowed values. Shared backing buffers count
once; their complete allocation counts even for subviews. Existing checkpoint
records are measured incrementally with bounded own-data traversal, without
calculating dirty indicators, invoking module validators or serializing a giant
Map. Already encoded checkpoint storage can be charged without decoding it.
Raw record structural work and retained drawing/history/document work need
separate logical reservations; encoded text size alone is not a raw-object memory
measurement. Unknown or over-budget shapes fail closed. Actual QuickJS requested
allocation telemetry remains distinct; Apple JSC has no equivalent current hook.

Only six logical OHLCV columns are copied to the target in bounded chunks.
Existing source indicator vectors/checkpoints are retained-cost inputs, never
transferred as restoration truth. The target recomputes from the captured columns.
All source cache growth/recalculation, versions, entry replacement and managed
UI changes are conservatively stale during this first slice. Public store updates
may continue, but cause rejection; writes through raw column references remain
unsupported. Binding extent is not a content fingerprint or delivery-time proof.

A successful source finish must release callback-capable ingestion fences first,
then check the original source/managed UI again with no further user callbacks.
The host keeps an immutable source runtime handle/context plus ticket throughout.
Old tickets must never be applied to a replacement engine handle. Once ownership
has moved or a source runtime has been freed, late progress/cancel/cleanup cannot
read it. Failure clears source references and owned temporary work without
closing the live source model or its host subscriptions.

Later host publication uses the owner thread: worker ended and target ready;
source fence cleanup; final source/job/closed/cancel/deadline checks; callback-free
context/handle swap; busy/budget release; old runtime retirement and notification.
After commit, observer throw, cancel or reentrant job startup cannot turn success
into failure. One terminal completion and one target owner are required. The
existing generic async UI-copy path is deliberately not reused for workspace
configuration, and the legacy job's current-handle cleanup cannot be reused
without immutable source-handle binding.
