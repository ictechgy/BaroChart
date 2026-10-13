# Native workspace source capture

Internal JS building block for the staged restore protocol. No Swift/Java restore
facade or atomic host context swap is provided by this slice. The host still owns
threading, monotonic cancellation/deadlines, original runtime lifetime and final
publication. See NATIVE-WORKSPACE-RESTORE-DESIGN.md.

## Admission and copy

`NativeWorkspaceCapture(api, document, binding, {input, size, revision, maxBytes})`
requires an actual API/model/BarStore and matching controller. `revision` is the
native host's nonnegative safe-integer UI/command revision. A drawing or pointer
gesture, queued ingestion and an existing ingestion fence reject admission. The
capture acquires its own fence, performs bounded document/module preflight and
retains the original owner identities. It does not get or calculate dirty studies.

`step(maxRecords, revision)` admits at most 1..64 raw checkpoint/drawing records
per call. It counts full unique ArrayBuffers for columns, store index, every
indicator output, hidden/visible series values and indexes, plus the existing
empty ingestion ring. Overlapping/subarray views count the complete backing
allocation once. Already encoded NativeCheckpointMaps are charged directly,
without decoding or calling validators. Raw record traversal uses own data fields,
no getters/toJSON/custom iterator, and creates no full encoded Map.

Each raw checkpoint or source drawing record must fit the same 256KiB UTF-16 JSON
charge and node/depth limits as native checkpoint storage. This is a conservative
first-slice source restriction: a large otherwise valid existing drawing may be
rejected even if the new workspace removes it. A logical 32 bytes per visited
value plus encoded charge and record/frame metadata accounts for raw structures.
Repeated frozen drawings and backing buffers are deduplicated. These costs are
logical admission policy, not actual JS object sizes, allocator overhead or RSS.
Host-held JSValues, unrelated runtime globals, external references after retirement
and native renderer/device allocations are outside this known-state estimate.

After source admission, target plan validation must also succeed before a new
runtime is allocated. `metadataJSON` is then ready. `buffer(slot, offset, count,
revision)` returns a borrowed view of one of six OHLCV columns: per-slot contiguous
offsets, count 1..262144 and no values beyond logical source length. Copy each view
immediately into the target before yielding; never transfer/detach its buffer.
Empty sources need no chunk. Invalid or stale operations close that capture.

## Ingestion continuity

An empty queue can still have a policy, nonzero sequence/counters and paused/error
state. Its bounded source-owned ingestion document travels separately from the
portable workspace. The target restores it after workspace configuration; queued
events are rejected. The logical plan reserves three ring allocations (bounded
validation work plus the target ring), using actual capacity times 49 bytes.
The original ring's backing buffers are charged separately with source buffers.
Source policy identity/fields, cursor/counters, paused state, columns and epoch are
part of freshness. Acquire/release changes to the capture's own fence epoch are
handled explicitly; other changes are stale. Cleanup releases only this fence.

## Freshness and finish

Every step/copy checks owner/store/column/version/dimension identity, indicator
entries/caches, panel/axis/series identity, drawing/history/input state and the
provided host revision. Managed cache growth/recalculation is conservatively
stale. Native same-value commands and A→B→A edits must advance the host revision;
a content hash alone cannot identify them. Raw writes to internal columns/maps
or arbitrary accessor/Proxy replacement of chart internals are unsupported.

Call `finish(revision)` only after all chunks are copied, target calculation has
finished and the host is ready for its final handoff. It releases callback-capable
fences, then checks source/UI state again and drops captured references. The host
must independently reread its current revision, active job, immutable source
handle/context, closed/cancel/deadline state after this call. A numeric revision
argument cannot observe a callback's later change to host state. Do not await or
invoke user callbacks between those final checks and the atomic handle swap.
`dispose()` is idempotent and never disposes the live source model or subscriptions.

## Bridge ticket ownership

`nativeWorkspaceSourceBegin(document,binding,revision,maxBytes)` reserves a job
before factory callbacks and returns a ticket. API/model/controller/global owner
bindings must agree. SourceStep/Check/Buffer/Finish use that exact ticket. Admission
completion returns target metadata and six logical buffer descriptors. The existing
JNI-oriented `nativeAsyncBuffer` can dispatch source chunks, but the host must
perform the explicit source/revision check immediately beforehand and at finish.
No current replacement engine handle may be used with an old source ticket.

Unknown/released ticket copies throw. Duplicate or old-ticket disposal does not
release another job. Constructor reentry cannot overwrite a reservation. A failed
valid-ticket operation cleans that job; wrong-ticket operations leave the current
job alone. SourceFinish ends the source-side ticket, not the host's busy/admission
reservation, which must remain until atomic swap or final failure cleanup.

### Host-known registration for lost Begin responses

The bridge accepts optional fifth argument `registration` on
`nativeWorkspaceSourceBegin(document,binding,revision,maxBytes,registration)`.
It must be a positive safe integer strictly greater than every host registration
previously attempted in that runtime; failed attempts consume their registration.
The receipt echoes it. One scalar high-water mark bounds bookkeeping memory.
The Java Host allocates unique increasing registrations before invoking Begin.
This is an ownership correlation key, not an authorization/security token.

`nativeWorkspaceSourceAbort(registration)` drops only the matching registration,
returns true when it did so, and returns false when no matching capture remains.
It allows cleanup when registration succeeded but Begin response serialization or
host parsing failed before the native ticket was received. Wrong/old tokens do
not affect a new job; repeated Abort after a lost response returns false. Invalid
registration arguments reject. Existing ticket-only protocol calls remain valid.
The Host must retain its original source handle, interpret throwing Abort as
unconfirmed cleanup, keep admission reservations until confirmation/retirement,
and never apply cleanup to a newly published runtime.
