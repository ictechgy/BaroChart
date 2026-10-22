# Opt-in identity-checked primary drawing restore

`saveBoundDrawings` and `loadBoundDrawings`, exported from `barochart` and
`barochart/core`, add an explicit host-declared identity envelope to drawing
persistence. They prevent an accidental import when the saved declaration
differs from the destination declaration. They do not authenticate a file,
validate a market-data provider, or prove that source bars have those semantics.

```js
import {saveBoundDrawings, loadBoundDrawings} from 'barochart/core';

const identity = {
  symbolId: 'AAPL',
  exchange: 'NASDAQ',
  priceUnit: 'USD',
  timeframe: '1m:regular-session',
  adjustment: 'split',
  adjustmentVersion: 'host-splits-2026-10-20',
};
const text = saveBoundDrawings(source.api, identity);

// Obtain this independently from the destination's current host configuration.
// Never copy the expected identity out of an incoming file just to make it pass.
loadBoundDrawings(destination.api, text, destinationIdentity);
```

## Identity contract

All six fields are required, nonblank strings of at most 128 UTF-16 code units.
`adjustment` is `raw`, `split`, or `total-return`. Comparison is exact: there
is no trimming, case folding, timestamp conversion, price conversion, symbol
aliasing, or adjustment conversion. `symbolId` and `exchange` distinguish
instruments/venues; `priceUnit` declares the primary price unit; `timeframe`
is the host's canonical interval/session/calendar identifier; and
`adjustmentVersion` identifies the host's adjustment basis, including a stable
explicit value for raw data. Drawing times remain UTC milliseconds regardless
of the timeframe token. No timeframe is inferred from bar spacing.

When chart symbol metadata exists, its `id`, `exchange`, `currency`, and
`adjustment` must agree. Its `adjustmentVersion` must agree when present and
not undefined. Absent metadata does not establish a match with actual data:
the caller is responsible for truthful source and destination declarations.
Matching declarations do not detect mislabeled data, different feeds with the
same declared identity, or forged/edited JSON.

This first helper deliberately supports only drawings on the primary `price`
panel with no non-null `axisId` or `seriesId`. Both save and load reject
secondary-axis, comparison-series, and other-panel drawings, even if their IDs
exist on both charts. A primary identity cannot certify those coordinate spaces.
The legacy APIs still support them with their existing caller-owned binding
responsibilities. This is not drawing synchronization or chart-layout transfer.

## Format, compatibility and limits

The new envelope is `barochart.bound-drawings` version 1 with exactly
`schema`, `version`, `identity`, and `document` fields. `document` contains the
unchanged `aster.drawings` v1–v4 document as a JSON object. Ordinary
`saveDrawings`/`loadDrawings` formats, behavior, dispatch arity, and native
bridges are unchanged. A raw legacy drawing document is rejected by the new
loader because its missing identity cannot be established retrospectively.
The legacy loader likewise rejects the new envelope. To migrate a trusted old
document, the host must first determine its context, use the legacy import
deliberately, and then save a bound document; do not invent missing provenance.

The inner drawing document keeps its existing target-specific serialized,
drawing-count, point, and text limits. Envelope input is bounded by the target's
drawing-character limit (at most 8,388,608 UTF-16 units) plus 8,192 characters for metadata.
The six bounded identity strings and fixed envelope syntax fit within that
allowance even when JSON-escaped. The normalized inner document is admitted by
the existing loader before publication, so normalization cannot bypass the
inner budget. The wrapper does not reduce the ordinary 8 Mi-character capacity
to the smaller workspace document limit.

Save/load reject disposed charts, active drawing transactions, and active
controller pointers/gestures. Identity, format, geometry, binding and budget
rejections leave drawing items, selection, undo/redo, and redraw count unchanged.
An accepted load replaces the drawings using at most one existing undo step and
one invalidation; undo restores the previous set when it changed. As with `loadDrawings`, if a
host invalidation callback throws after the commit, the drawings have already
changed. Do not interpret that callback error as a rolled-back import.

## Workspace and platform boundaries

Workspace restore already requires an exact host-owned `WorkspaceDatasetBinding`
match and source extent checks. This change does not replace or modify that
contract. Workspace keys should still encode the host's instrument/timeframe
context. The new drawing helpers are standalone JavaScript/core functions,
not native SDK methods or native bridge commands. Node regression/type/offline
package checks do not establish actual browser, native device, accessibility,
pixel, performance, or user-workflow results.
