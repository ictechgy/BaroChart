# Swift workspace restore ownership slice

Source implementation contract, **not compiled or executed with a Swift compiler
or Apple JavaScriptCore SDK in this validation environment**. Static Node checks
and shared JS protocol execution in Node VMs or QuickJS do not certify Swift
typechecking, ARC, Dispatch/RunLoop scheduling, JavaScriptCore interoperability,
device behavior, responsiveness or performance. Existing packaged artifacts must
not be assumed to contain this API.

## API and execution boundary

`AsterEngine.restoreWorkspaceAsync(document, datasetBinding:, timeout: 30,
maxBarsPerStep: 4096, progress:, completion:)` returns an `AsterWorkspaceJob` whose
`cancel()` is thread-safe. Start restore on the live Engine's main owner thread.
One Engine permits one active generic **or** workspace job; a new request does not
implicitly supersede an existing job. The old chart remains usable while the
target is prepared. Source data changes and managed UI commands make the capture
stale rather than altering the workspace being restored.

The source owner reads captured `ownedData`. Six copied Float64 columns cross to
a separate JavaScriptCore VM created on a background worker, with at most 262144
doubles per field/chunk. No source `JSValue` or raw source storage is shared with
that VM. Target calculation uses bounded steps. Metadata and settings come from
the saved workspace, not a late copy of the old UI. The dataset binding is
explicit, and source capture retains the source identity/revision contract.

The deadline is cooperative: checks occur at staged boundaries. An in-flight JS
call, callback, allocation or calculation step cannot be preempted. A timeout or
cancellation therefore does not promise an immediate stop or a fixed UI latency.

## Admission and publication

Across Engines, at most two in-flight or cleanup-pending workspace jobs hold
reservations, with a 768 MiB limit on **admitted logical retained work**. This is
logical old+new work, neither an RSS ceiling nor a budget for every live chart or
external JS handle.
Before the full source descriptor establishes retained cost, the reservation is
slot-only. Unknown cost does not mean zero actual retained bytes; those bytes are
not yet covered by the admitted-byte total. A target VM is not created until full
admission succeeds. Pending cleanup continues consuming its slot and any admitted
byte reservation.

Publication has one linearization point:

1. Finish target work and hand it to the source owner.
2. Run source Finish, including callbacks that Finish may invoke.
3. Make the final source/context/revision/closed/cancel/deadline check after those
   callbacks. Allow no further callbacks between this check and the atomic
   context swap.
4. Transfer the target runtime to the Engine. Retire the old context and wait for
   its creator-side cleanup acknowledgment, where that runtime has a creator
   lifetime. Only then release busy state, slot and byte reservation.
5. Notify Engine observers, then emit success exactly once. An observer may
   reenter, start new work or close the Engine; it cannot reverse the committed
   result into failure.

Before publication, failure waits for cleanup acknowledgment of the untransferred
target and of any source already being retired, before normal completion or
reservation release. A failure does not retire an otherwise open, idle source:
that chart stays running. Source Abort uncertainty is the exceptional completion
path described below; it reports pending cleanup without freeing its reservation.

The Engine/view identity survives a successful swap; context-bound JS values and
internal data/model identities do not. Cancellation after the publication point
does not roll back the installed workspace.

## Lost responses and cleanup recovery

The host allocates a registration before entering source Begin. This known
correlation key permits Abort even if Begin installed the capture and then threw,
or if its response was lost before the host learned the ticket. Registration is
an ownership correlation key, not a security credential. Cleanup always addresses
the captured context and its original registration; an old key cannot abort a
later job on the same or a replacement Engine context.

Abort is uncertain when it throws before execution or loses its response after
execution. A normal Abort response, including a response that no matching capture
remains, confirms release. In the uncertain case:

- Emit the `cleanupPending` completion outcome exactly once, then drop the job's
  callbacks, retained Error and workspace document. Completion is not evidence
  that source cleanup or reservation release has finished. Cleanup of the
  untransferred target must still be acknowledged before this outcome.
- Keep only a minimal main-owner recovery record: captured context, any actual
  source-runtime retirement lease, registration/reservation and bounded numeric
  diagnostics. The registry must not retain the Engine, job, Error or callbacks.
- Keep the slot and any admitted-byte reservation until Abort is confirmed **and**
  any required retiring-source creator cleanup is acknowledged. A pending source
  lease delays actual retirement so that the context remains available for Abort;
  merely keeping a context pointer is insufficient.

Main-owner static `AsterEngine.workspaceCleanupStatus` and
`AsterEngine.retryWorkspaceCleanup` remain reachable after both Engine and job
have died. One retry invocation makes at most one attempt per recovery record;
records already being retried are skipped on reentry. There is no automatic tight
retry loop, and successful recovery never emits a second completion. A permanently
unavailable owner/creator or perpetually failing Abort leaves bounded capacity
reserved rather than pretending cleanup succeeded.

## Runtime and retained-handle lifetime

The worker-created runtime is transferred to the Engine on success, together with
its creator-side cleanup responsibility. A newly installed workspace context has
optional internal backing, cleared by `close()`. The public open-Engine `context`
surface still returns a `JSContext`; reading that raw surface after close is
unsupported and may trap. This does not change legacy generic closed-Engine raw
context retention. Retaining an externally obtained `JSContext` or `JSValue` can
extend its lifetime beyond the Engine's internal cleanup acknowledgment.

A generic operation that sources a workspace-created runtime acquires its actual
source-runtime lease conditionally; ordinary legacy sources do not acquire a
fictitious workspace lifetime. Cancellation, close, deinit and repeated restores
must all release the same underlying ownership exactly once. Retiring a runtime
waits for active source leases, including cleanup-pending recovery leases.

No JS execution, user callback or last ARC release of a retained object is allowed
under a state lock. Creator-side cleanup acknowledgment covers internal releases;
it does not prove collection of externally retained handles or return to an RSS
baseline. Releasing internal context ownership on its creator is a conservative
policy of this implementation, not a claim that Apple universally requires every
`JSContext` release on the creating thread.

[Apple's JSVirtualMachine documentation](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine)
describes thread-safe API use, serialization within one VM and parallel execution
with separate VMs. The [WebKit JSVirtualMachine API header](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/API/JSVirtualMachine.h)
describes deferred work using the creator's run loop. These references motivate
the separate-VM and creator-lifetime policies; neither validates this Swift code.

## Validation and Apple SDK acceptance gate

Shared protocol checks include:

- `node --test test/native-workspace-source-bridge.test.mjs`
- `node --test test/native-workspace-target-bridge.test.mjs`

Source-structure assertions can catch missing guards and ownership paths. Common
JS VM/QuickJS tests exercise the common protocol only. Neither substitutes for
compiling the actual facade with warnings as errors and running an independent
Apple SDK consumer. No Swift compiler, Apple JavaScriptCore SDK, simulator or
device execution was performed for this source slice; no new SDK installation,
performance or leak-freedom claim is implied.

The SDK acceptance matrix must cover these cases with exact-once completion,
ownership counters and resource baselines:

- Cancel and close at every capture/copy/compute/handoff boundary and during
  Finish callbacks; cancellation racing publication.
- Lost Begin receipt; Abort throw before execution and after successful execution;
  retry success/failure, duplicate retries and retry reentry.
- Engine/job deinit with pending cleanup; recovery using only the static API;
  source retirement delayed until the pending lease is released.
- Retained completed jobs, callbacks, Errors, documents, raw contexts and JSValues;
  internal cleanup versus deliberately retained external handles.
- Observer reentry that reads, cancels, closes or starts the next job after swap.
- Workspace-to-workspace restore and generic jobs sourcing a workspace runtime;
  ordinary legacy sources and a failed restore leaving its open source running.
- Target failure cleanup, retired-source creator acknowledgment, creator run-loop
  shutdown and all reservations returning to baseline only after required cleanup.
- Two-slot/768 MiB admission boundaries, pre-descriptor unknown-cost slot-only
  behavior, no pre-admission target and stale recovery keys beside a newer job.

Measured responsiveness and resource recovery require Apple SDK execution with
stated fixture, device and observation window, separately from protocol parity.

Cloud static source regression: `node --test test/swift-workspace-ownership-source.test.mjs test/native-workspace-facade-source.test.mjs` (15 + 6 assertions; not Swift execution).

Cleanup acknowledgment may delay completion beyond the calculation deadline;
cleanup is not abandoned to make a timeout appear prompt. The budget is not a
limit on retained closed legacy Engines: their existing raw-context lifetime
contract remains outside completed-job reservations.
