# Java workspace restore ownership slice

Private 0.2.13 source implementation. `AsterEngine.restoreWorkspaceAsync` now
connects the existing native source/target protocol to a dedicated production Java
ownership state machine. The state machine executes under an independent Java
fake transport with real worker threads. The actual Engine typechecks against
compile-only Android/JSON signatures. This does **not** establish Android SDK,
Handler/Looper, JNI, QuickJS host integration or device correctness. The companion
[Swift workspace source](SWIFT-WORKSPACE-RESTORE.md) has not been compiled or run
under Swift/JSC. Existing AAR files do not contain this API.

## Contract

Call on the live Engine's main/UI owner thread with a portable workspace string,
explicit dataset binding, existing AsyncOptions and AsyncListener. The binding is
serialized once before admission; source identity/revision is checked afterwards.
One Engine accepts one active calculation; workspace jobs do not implicitly
supersede each other or generic prepare/correction jobs. Pending ingestion and
active gestures remain rejected by the source protocol.

The returned WorkspaceJob supports `cancel()`, `cleanupPending()` and
`pendingFailure()`. The latter two report the exceptional owner-queue-unavailable
state, not successful completion. Ordinary asynchronous status is delivered once
through AsyncListener. If initial owner enqueue fails before the public call
returns its handle, the call throws, clears only its own reservation and retains
no job inputs; no completion callback is emitted for that unstarted call. A late
queued start after that failure is ignored. Source capture/admission and JNI reads run on the owner;
a separate worker owns a fresh target runtime until transfer. The old runtime
continues to serve the chart during preparation. Source updates or managed UI
commands make the job stale rather than changing the document being restored.

On success, the target is complete and its worker has stopped. The owner releases
the source ingestion lease, checks source/runtime/revision/closed/cancel/deadline
again after callbacks, and swaps the handle with no intervening callback. It then
releases the job/byte reservation, frees the retired source and notifies existing
Engine observers. A notification exception, cancellation, close or new job after
this point cannot turn the committed result into failure. Diagnostics are bounded.
The Engine/view identity persists; context-bound native values and internal
BarStore/model identities do not. The target restores the document's settings,
not a late copy of the old UI. Empty ingestion policy/cursors/paused state travel
separately from the portable document.

The deadline starts when the job is constructed. It is checked at staged
boundaries; a native call, callback, allocation or one calculation step is not
preemptible. Small work may finish before a subsequently queued cancellation.
Worker progress is coalesced to one latest value and at most one queued progress
Runnable. It may skip intermediate values/phases; handoff and completion are
separate events and are never replaced by progress. Late progress after terminal
completion is ignored. Copies use at most 262144 doubles per source field/chunk. Inflight workspace jobs
are globally limited to two and 768 MiB of admitted logical old+new retained work.
Before a complete source descriptor establishes the retained cost, admission is
slot-only. An unknown cost is not zero actual retained bytes and is not covered by
the admitted-byte total yet. No target runtime is created until full admission.
This is not an RSS cap or a lifetime budget for every chart or external JSValue.

## Unavailable owner queue

A worker never impersonates the owner to invoke source JNI cleanup. If its final
owner post is rejected, it frees any untransferred target, drops large job input /
descriptor / worker references, and marks cleanup pending. The source Host/ticket
and the entire slot/byte reservation remain retained. This prevents unlimited
pending jobs across Engines; the same Engine cannot admit another job first.

The next owning-thread Engine operation or Engine.close completes idempotent
source cleanup and releases the reservation. This exceptional recovery can deliver
the failed job's completion callback before the requested Engine operation,
including a read; its subsequent closed-handle guard still runs after that
callback. The read method itself does not issue a change notification. The job does not fabricate a
completion callback while the owner is unreachable. If the owner thread never
returns, source cleanup/completion cannot be guaranteed and the bounded global
reservation remains consumed. `cleanupPending()` exposes that condition. Closing
an Engine from another thread remains unsupported. Successful posted Runnables
are assumed to execute eventually; silently discarded accepted work likewise
requires owner close/recovery and is not certified by the fake scheduler.

## Reproduce the cloud checks

- `node scripts/check-java-host.mjs`: actual Engine/Columns/job Java typecheck,
  compile-only Android/JSON signatures, warnings as errors.
- `node scripts/check-java-workspace-job.mjs`: production state machine runtime
  test with an independent fake Host, real worker thread, queued owner handoff,
  exact handle/ticket ownership, exceptions, cancellation, stale data, close,
  reentry, duplicate callbacks, budgets and rejected-owner recovery.
- `node --test test/native-workspace-source-bridge.test.mjs`: generated JS source /
  target protocol and exact admission-plan binding in isolated Node VMs.

The JDK compiler module is used directly with Java 8 source/bytecode flags. This
JDK lacks the `--release 8` platform image: compilation uses JDK 21 library
signatures, not certification of all Java 8 or Android API availability. Test-only
Android/JSON stubs throw if executed. No SDK, JNI library or device was installed
or run for these checks. No UI latency/performance claim follows from them.

## Lost responses and uncertain source cleanup

Each Java job allocates a positive safe-integer registration before entering JS.
The source runtime requires host registrations to increase; reuse is rejected
without an unbounded token-history cache. Registration is an ownership correlation
key, not a security credential. All calls remain bound to the captured source
handle. The Begin receipt binds the registration and native ticket. If Begin
registered a capture but its response serialization/parsing fails, the Host can
still call `nativeWorkspaceSourceAbort(registration)` without knowing the ticket.
A wrong or retired registration cannot abort a later job. Legacy ticket-only
internal callers remain supported, but the new Java adapter always registers.

Abort is idempotent: a normal false response means no matching capture remains.
The job marks source release confirmed only after a normal response, or after the
captured source handle has already been retired. If the Abort call throws before
execution or loses its response after execution, completion and reservation
release remain pending. A later owner operation/close retries only the original
registration on the original live handle. There is no automatic retry loop. A
second recovery or a retry after a lost successful response is harmless. Engine
close finishes recovery after retiring its original handle as well; it never
applies the old registration to a replacement handle.
