# Main demo page lifecycle

The main web demo prepares its first chart asynchronously. Previously, a
persisted `pagehide` aborted that preparation, while `pageshow` only refreshed
an already-created chart. Returning before the first chart had been installed
could therefore leave the page blank until another market/count choice.

## Narrow recovery policy

The demo now records an interrupted initialization only when all of these are
true: the page is being persisted, no model is installed, preparation is pending,
and its signal has not already been aborted. A persisted restoration consumes
that intent once and starts a fresh load using the current market/count controls.
Repeated hide events retain the pending intent; duplicate show events do not
start duplicate work.

Explicit user Cancel remains distinct, including when its rejection has not yet
settled at pagehide. Settled failures and successful loads are not automatically
retried. A canceled initial load can still be restarted by choosing a market or
bar count. Later reloads and Add Indicator operations are canceled, not replayed:
the installed model/drawings remain, and the market/count controls return to that
model's values.

Pagehide invalidates the old job before aborting it and clears its busy state.
Late progress, errors and finalizers cannot change a restored job's UI, and a
late successful but obsolete model is disposed instead of installed. A terminal
pagehide permanently closes this demo instance and clears its pending retry.

The synthetic stream starts only with a live chart/model on an active, visible,
non-preparing page, and only if streaming remains requested. Suspension stops it;
ordinary restoration preserves that intent without allocating duplicate timers.
These are demo-host guards, not changes to the worker cancellation contract,
chart APIs, drawing history, serialization, native bridges or browser history.

## Evidence boundary

Node tests execute the shipped event-handler source with the real
`prepareChartModel` cancellation, packet validation, hydration and chart core.
DOM controls, lifecycle dispatch, worker transport and interval scheduling are
modeled. Tests cover restoration both before and after abort settlement,
repeated suspension, explicit Cancel, settled failures/successes, existing-model
operations, stale completions/progress, and terminal stream cleanup. Controlled
promises are used separately to exercise obsolete success at the host boundary.

Actual browser back/forward-cache admission, visibility-event ordering, rendering,
trusted input and assistive technology remain unrun. A terminal-cleanup test
deliberately holds `document.hidden` false through settlement to establish the
host invariant; it is not a claim that browsers leave an orphan timer alive.
No Mac, native SDK, JNI or physical-device validation is implied.
