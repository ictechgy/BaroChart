# Portable workspace: first-slice design

Status: historical first-slice implementation design; public contract is in WORKSPACES.md. Source data remains
external. This is not a promise of complete host/native workspace support.

## Proposed API and ownership

- Core `saveWorkspace(chartAPI, datasetBinding): string` captures portable model
  configuration without computing pending indicators or copying OHLCV history.
- Root/worker `prepareWorkspaceAsync(store, text, {datasetBinding, signal,
  timeoutMs, onProgress, workerFactory}): Promise<ChartModel>` validates and
  prepares a new model. It never mutates/replaces an existing chart/model.
- The returned model shares the caller-owned real BarStore and subscribes to its
  subsequent managed events. It owns its new indicator entries, drawings, range
  caches and model/engine listeners. Caller must dispose it if not mounted.
  Disposing either old/new model must not dispose or mutate the shared store.
- Host controls visible chart replacement and old model teardown after success.
  CanvasChart accepts a prepared model, but browser mounting/renderer/native SDK
  behavior is not certified by Node core/Worker tests.
- Failure, cancellation, timeout or stale source disposes the staged candidate,
  releases its listeners/Workers/budget and leaves any old chart/store unchanged.
  Publication is returning the ready new model, not patching old controller state.

## Document shape

A strict versioned plain document:

    schema: 'aster.workspace'
    version: 1
    dataset: {key, revision, adjustmentVersion, priceUnit, adjustment}
    source: {length, firstTime, lastTime}
    chart: {panels, axes, theme, symbol, formatters, precision, axisWidth, view, follow}
    indicators: [{id, name, params, module?, outputs, plotOffsets}]
    series: [portable public series options, excluding external values]
    drawings: {schema:'aster.drawings', version:1|2, drawings:[...]}  // original first slice

Current compatibility note (2026-10-18): the outer workspace version remains 1,
but current embedded drawing documents accept versions 1/2/3/4. Position drawings
require v3 and any explicit visibility boolean requires v4; bindings are retained.
See [positions](POSITION-DRAWINGS.md), [visibility](DRAWING-VISIBILITY.md) and
[the current workspace contract](WORKSPACES.md). The shape above records the
original design, not a current loader restriction.

Dataset fields are required nonempty bounded strings. Expected binding is
supplied independently on restore and must exactly match all five fields.
Source extent and first/last UTC timestamps must match the supplied store; empty
source uses explicit null endpoints. View is finite index from/to plus follow,
so strict source extent/revision binding prevents silent remapping across history
prepending or adjustment versions. No implicit nearest-time or timeframe conversion.

Bindings are host assertions, not cryptographic data authentication. Matching
length/endpoints does not prove interior OHLCV identity, receipt history or
point-in-time availability. The host must advance revision/adjustmentVersion when
its dataset changes. Current store version is separately guarded during each
preparation; no automatic retry during a continuously updating feed.

Source OHLCV, indicator arrays/checkpoints, arbitrary external series.values,
executable code/functions, pointer/gesture/crosshair state, selection/tool/text,
undo/redo history and ingestion queues are absent. External values and unknown
custom formatters cause save rejection rather than silent omission. Active pointer/gesture state and drawing
transactions cannot be saved. A pending owned ingestion queue is not a workspace;
its persistence/lifecycle remains a separate API/host responsibility.

Known setSymbol formatter pairs may be recognized with hasPortableFormatters and
recreated from validated SymbolMetadata. Custom panel/axis/model formatter
functions are not serialized. Portable colors/fonts retain existing codec rules;
unsupported renderer CSS must fail export explicitly without narrowing live styles.
Time/price drawing anchors and axisId/seriesId bindings must survive roundtrip.

## Preparation and validation

1. Preabort before source/document getters, parsing, factory or Worker creation.
2. Bound text and parse safe numeric codec; reject unknown version/fields,
   prototype/accessor/function forms, wrong binding, duplicate identifiers and
   count/depth/size overflow. Metadata parsing is bounded but not preemptible.
3. Validate source extent, symbol/precision, panels/axes, ordered series and every
   drawing binding against a detached configuration. Reject missing axes/studies,
   unsupported external values and active restore conflicts explicitly.
4. Require exact canonical builtin or static prelinked module id/version /
   stateVersion/exportName in owner and Worker. Validate requested params, ordered
   outputs and effective plot offsets; no eval or executable source in documents.
5. Capture actual store identity/version/columns/length/capacity and take owned
   chunked source snapshots. Managed changes throughout computation/validation /
   cleanup/final publication reject StaleSourceError. Direct raw writes are outside
   the managed contract. Worker receives snapshots, not caller-owned buffers.
6. Dedicated Worker calculates all requested indicators against one source copy,
   streaming checkpoints into an aggregate bounded encoding budget. No full-store
   or caller index is returned/replaced. Reuse target-entry computation/validation
   primitives where their contracts fit; do not repeatedly copy the source for
   each study or silently recalculate on the owner thread.
7. Validate all reply bindings, intrinsic typed ownership, output capacity/NaN
   tails, completed metadata and every checkpoint. Aggregate output/checkpoint
   limits apply across entries, not independently to128 entries.
8. Build a new model sharing the guarded store; install validated entries, series,
   symbol formatters, drawings and view without rebuilding pending indicators on
   the owner. Trusted factory/metadata errors remain pre-publication. Candidate
   construction/listeners are owned and disposed on every failure path.
9. Terminate Worker, detach job listeners, final callback-free owner/version guard,
   then return the new model. No callback/await between final guard and publication.
   A later cancellation cannot revoke a published model.

No transaction modifies the old chart, so rollback means disposing the unseen
candidate, not attempting to undo partial UI mutations. Host mounting is a separate
step. If a synchronous core-only restore is later offered, its blocking and
cancellation limits must be explicit; a Promise around blocking work is insufficient.

## Proposed first limits

- Workspace document at most2,097,152 UTF-16 code units, not UTF-8 bytes.
  Writer and reader share the same limit and safe numeric/depth codec.
- Existing model limits remain:32 panels,64 axes,256 series,128 indicators,
  10,000 drawings /200,000 points, further constrained by document size.
- Share2 active jobs,512MiB aggregate /256MiB per job with existing async APIs.
  Reserve from source length, actual capacity, total output count, bounded
  metadata and aggregate checkpoint encoding before large allocations.
- Aggregate checkpoint stream at most32MiB, each record256KiB, block256.
  Worker encoder must enforce remaining aggregate capacity during calculation,
  not only after retaining many decoded histories or joining all streams.
- Existing caller buffers, arbitrary trusted factory/runtime/GC allocations are
  separate from logical typed/serialized reservation, not a hard RSS bound.
  The conservative formula is48*N+16*C*O+160MiB+16*(K+1)*I; see WORKSPACES.md
  for dimensions and exclusions. There is no unbounded fallback cache/retry.

## Acceptance before release

Golden save/restore/save with multi-panel/axis OHLCV and indicator series, all
portable style/precision/symbol settings,16 drawing-tool anchors/bindings, hidden
studies, own-key output names and -0 params. Unknown versions/fields/module
versions, dataset revision/adjustment/extent mismatch, invalid axes/drawing refs,
functions, large documents/records and unsupported values must reject atomically.

Actual Worker parity for restored outputs and append/update/historical correction;
source updates at capture/compute/validation/termination/final callbacks reject;
preabort/timeout/repeated cancellation returns listener/job/byte counts to baseline.
No mutation/disposal of shared store or existing models, including held outputs.
Failed candidate construction/formatters/metadata/packet must leave no listeners.
No-op/mount lifecycle is host-owned, and browser/native execution stays unverified
until actually exercised. Measure owner parse/snapshot/validation and total wall,
not only worker CPU, and document large-document non-preemptible work.
