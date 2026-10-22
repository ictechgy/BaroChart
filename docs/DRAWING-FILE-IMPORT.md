# Drawing file import in the web demo

The main web demo reads drawing files asynchronously. An older `File.text()`
completion must not overwrite a newer file choice, local drawing work, or a
replacement chart. This coordination is local to `examples/web/demo.mjs` and
`drawing-file-import.mjs`; it adds no public core API.

## Ownership and user interaction

Each read has a latest-intent token. Opening the file picker, selecting another
file (including an empty or invalid selection), starting chart preparation,
installing a model, recreating the renderer, and page hiding invalidate older
reads. Page hiding cancels pending work even when the page enters the back/forward
cache. Cancellation ignores the result; it does not physically abort
`File.text()` or reclaim its pending buffer.

The demo captures the chart, API, model, controller, drawing store, items,
selection, symbol metadata and bar-store identities before reading. Immediately
before loading it checks that these still belong to the current live chart.
Changed ownership, items or selection discard the result with a cancellation
message. Active drawing transactions, controller gestures and pointers prevent
admission both before and after reading. Load is disabled during chart
preparation. A live-data append or viewport navigation alone does not invalidate
an otherwise unchanged drawing context.

The input is reset synchronously after capturing the selected file, allowing
same-file reselection. An older completion never clears the newer input or
replaces its status. An accepted import calls the existing synchronous
`loadDrawings` once and retains its selection, replacement and undo semantics.
Precommit failures leave the existing drawings intact. If a host redraw callback
throws after committing, the demo reports that the drawings were applied rather
than incorrectly claiming a rollback.

## Compatibility and limits

The existing 16 MiB file-size admission limit and nested drawing-document limits
remain in force. Drawing schemas, the legacy core API, native bridges, and
serialization are unchanged. This demo still loads the ordinary legacy drawing
document, not the opt-in [identity-bound envelope](BOUND-DRAWINGS.md).

These checks coordinate this demo's asynchronous UI work. They do not prove a
file's instrument, venue, timeframe, units or provenance, and are not a general
synchronization, authorization or rollback mechanism. The demo uses immutable
drawing-item publication and identity-based ownership checks, not a deep audit
of arbitrary host mutations.

## Validation boundary

Node regression tests exercise deferred file reads with real chart models,
drawing APIs and controllers, plus the actual event-handler source in a modeled
input environment. They cover out-of-order reads, edits/selection/undo/redo,
shared drawing-journal reuse, owner replacement/disposal, active gestures,
cancellation, malformed files, redraw errors, and input reset behavior.
These are not actual-browser scheduling, trusted file-picker, rendering,
accessibility, native SDK, JNI or physical-device results.
