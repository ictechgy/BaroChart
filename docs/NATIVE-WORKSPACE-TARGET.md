# Isolated native workspace target protocol

This internal JS protocol builds a new, owned chart in an empty runtime. It is
not yet connected to Swift/Java restore methods or an atomic host runtime swap.
The existing public native workspace APIs still provide save and metadata-only
preflight. The internal source capture protocol is described in
NATIVE-WORKSPACE-SOURCE.md. Cancellation deadlines and host handle/ticket lifetime
still require the later host integration.

## Input and phases

`NativeWorkspacePrepared(metadataJSON)` accepts `schema:
"aster.native-workspace-target"`, `version: 1`, a bounded portable `document`,
`datasetBinding`, `source` (`length`, `maxBars`, `timeframeMs`, `timeOrigin`,
`version`, `timeVersion`), `size` (`width`, `height`), `retainedBytes`, and
`maxBytes`, plus optional bounded `dataIngestion` transport separate from the
workspace document. Dataset binding and source extent are assertions, not content hashes.
`retainedBytes` is currently a host-supplied logical assertion, not an independent
measurement of the old runtime. No combined process-RSS guarantee is implied.

Transfer six OHLCV columns through `target(slot, offset, count)` in per-column
contiguous order, at most 262144 doubles per call. Returned views belong to the
target; the caller must stop writing each view before calculation. `start()`
requires complete input. `step(maxBars)` accepts 1..65536 and performs bounded
validation, store indexing, indicator calculation, series indexing, and checkpoint
coverage verification. Callback execution, allocation, one encoded checkpoint,
and final bounded document/configuration validation cannot be preempted.

`workspace-ready` means target calculation/configuration is complete. It does not
mean publication into a host engine. `finish()` accepts no arguments and transfers
its `{model, size, plan}` exactly once. The wrapper drops source-column, entry,
store, model, task and document references. Disposing the wrapper after transfer
does not dispose the returned model. Failure/disposal retires the original owned
checkpoint registry even if a trusted callback replaced the engine registry.
Encoded checkpoints obey NATIVE-CHECKPOINTS.md; subsequent ordinary indicator
additions/replacements are not automatically converted to this storage policy.

## Configuration and freshness

Restore uses saved symbol/formatter settings, then saved precision, view/follow,
series/axes and exact drawing anchors. It never imports the old source's latest UI
through `finishUI`. Valid omitted panel/axis/series defaults and unbound version-2
drawing documents normalize to the existing writer's canonical representation.
Object field order does not change meaning; indicator output order does.

Factory/module/parameter/schema/offset bindings and managed target state are
checked during calculation and after callback-capable operations. Final ready
checks use the captured managed configuration. Arbitrary replacement of internal
fields with accessors/Proxies is not a supported chart API contract. Trusted module
side effects outside this owned target are not rolled back.

## Logical admission

Maximum combined reservation is 768 MiB, with a 256 MiB target output-vector cap.
The plan reserves source columns and store index, all target output vectors,
series range indexes, 32 MiB encoded checkpoints, per-record metadata, 32 MiB
scratch, 32 MiB document/copy work and 4 MiB transfer buffers, plus declared
`retainedBytes`. Admission precedes main target vector allocation. Optional ingestion metadata
validation uses a bounded ring (at most 4096 × 49 bytes); `ingestionBytes` reserves
three such work/target allocations, in addition to the original source ring. These are
conservative logical byte reservations, not allocator overhead or RSS limits.

## Bridge

`nativeWorkspaceTargetCreate(metadataJSON)` requires an empty isolated runtime
and no existing prepared job. The existing `nativeAsyncTargetBuffer`,
`nativeAsyncStart` and `nativeAsyncStep` drive it. `nativeWorkspaceTargetFinish()`
installs model/API/controller/size in that target runtime and returns
`aster.native-workspace-target-ready` v1, `status: "target-ready"`,
`hostPublished: false`. Source runtime globals are untouched.
`nativeWorkspaceTargetDispose()` drops an unpublished target; it is idempotent.
A live runtime, accessor/non-configurable publication slots and duplicate jobs
are rejected. Host code must still transfer the successful target runtime's
ownership and retire the old runtime safely; no Swift/Java method does this yet.

Node direct-class tests cover all 35 built-in indicator oracles after initial,
update, append and correction operations, configuration/scene/anchor fidelity,
malformed transfer, logical admission, reentry and ownership. Separate generated
bundle tests use source and target VMs. Native SDK/device/UI support cannot be
inferred from these tests.

The same builtin target protocol also passes 63 scenario assertions in actual
standalone Linux QuickJS (`npm run check:quickjs:target`), with normal/OOM/interrupt
runtime cleanup at zero requested live allocations. See
QUICKJS-CLOUD-VALIDATION.md for the independent coverage gate and exact limits.
