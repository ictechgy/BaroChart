# Versioned UI preferences and host-owned saved charts

`saveChartUI(options)` and `readChartUI(text)` are exported from `barochart/canvas`
and the root package. They serialize **web input and optional toolbar preferences**
as `barochart.web-ui` version 1, or version 2 when a toolbar label override is
present. They do not read a live chart, install settings,
mount controls, access storage, send data, or change a workspace/native protocol.
Chart appearance profiles, theme choices, CSS variables and host placement remain
host-owned records; this codec does not absorb them.

```js
import {saveChartUI, readChartUI, saveWorkspace, prepareWorkspaceAsync,
  CanvasChart, attachChartToolbar} from 'barochart';

const uiText = saveChartUI({
  interaction: chart.interactionOptions,
  toolbar: toolbar.options, // stable options, not snapshot()'s transient fields
});
const preferences = readChartUI(uiText);
// At fresh mounting time:
const nextChart = new CanvasChart(chartElement, readyModel, {
  interaction: preferences.interaction,
});
const nextToolbar = preferences.toolbar === null ? null
  : attachChartToolbar(emptyToolbarElement, nextChart, preferences.toolbar);
```

Omitted interaction preferences use existing defaults: pointer/wheel/ordinary
keyboard shortcuts enabled, hit tolerance 8 logical pixels. Omitted/null toolbar
means no toolbar. A supplied toolbar record uses existing option defaults. The
saved document includes normalized stable values; an empty `labels` map is omitted
in version 1 for compatibility, so a later named preset does not reinterpret them.
Toolbar `labels` maps existing tool/action IDs to bounded
nonblank Unicode captions; they are reflected into button text, titles and
accessible names through text-only DOM properties. Read results, nested records
and lists are detached and frozen.
`toolbar.options` is an immutable current configuration; held earlier values stay
unchanged, and reading it after destruction rejects.

Documents without label overrides retain the exact version 1 field layout and
serialization. Version 1 toolbar records exclude `labels`. A nonempty `labels`
map is serialized with version 2 and is required in that version; the reader
rejects missing, empty or extra per-version fields instead of reinterpreting a
document under another version. A `labels: {}` override resets captions and
still serializes as version 1.

Input must be portable plain own-data records. Unknown fields/versions, missing
document fields, accessors, hidden/symbol/reserved keys, sparse or extended arrays,
invalid Unicode, duplicate JSON keys and invalid option values reject. Text is
bounded to 8,192 UTF-16 code units before parsing. The codec invokes neither
getters nor `toJSON`. A JSON string is data, never HTML or executable content.

## Compose, do not duplicate workspace v1

Existing [workspace serialization](WORKSPACES.md) already saves chart theme,
panels/axes/series, indicators, drawings, exact index viewport and follow state.
Keep its text unchanged, including its signed-zero encoding. A host can write one
versioned application record containing both strings, for example:

```js
const record = {
  schema: 'my-app.saved-chart', version: 1,
  workspace: saveWorkspace(chart.api, independentlyKnownDatasetBinding),
  ui: saveChartUI({interaction: chart.interactionOptions, toolbar: toolbar.options}),
};
// hostStorage owns envelope validation, size bounds, encoding, durable writes,
// key/revision/conflict policy, errors, and any optional account/cloud storage.
await hostStorage.write(chartKey, record);
```

Do not store these as two independently updated keys and assume atomicity. Storage
failure is not a successful save. Do not autosave a full workspace on hover: it is
synchronous, potentially large, and `aster:state` is not a complete change journal.

On restore, validate the host envelope and UI first, then call
`prepareWorkspaceAsync(store, record.workspace, {datasetBinding, signal})` with an
**independently supplied** binding. This returns a fresh model, never mutates the
old one, and rejects changed source extent/revision. Validate a host load-generation
token after every awaited read/preparation and again immediately before publishing
the mounted replacement. Abort superseded jobs, dispose every abandoned ready
model, and destroy partially mounted candidates on failure. Keep the old chart
until the new chart and optional controls mount successfully. Never assign to an
existing `chart.model` or derive the expected binding from the incoming record.

UI preferences can be restored independently when a live feed has grown; this does
not authorize relaxing workspace identity/extent checks. Programmatic commands
remain available, and `interactive:false` remains the constructor master switch.

## Explicit demo storage and limits

The customization studio has explicit **appearance-profile Save and Load** buttons
using `barochart.customization.profile.v1` in localStorage. There is no automatic
save or restore. It reports missing, invalid, blocked and quota-failed storage.
Only when that key is absent does Load try the previous
`barochart.customization.web-ui.v1` key; an invalid new record never silently falls
back to an older record.

The example-owned `customization-profile.mjs` codec stores a versioned envelope
containing six theme colors and font, price/volume panel weights, price-axis side,
toolbar placement, a `saveChartUI` string, and navigator/overlay/trade-marker
visibility. Its text is limited to 16,384 UTF-16 code units. It validates exact
fields and values before applying anything to the live chart. A toolbar is
required; top placement requires horizontal orientation, and either side requires
vertical orientation. It is an example module, not a new package export.

JSON can be pasted, copied, downloaded or imported from a file. File imports reject
files larger than 64 KiB before reading, then enforce the smaller codec limit.
Pending reads cannot replace newer settings. Save/Load and import preserve the
existing model, data, drawings and viewport. Appearance reset changes only the
theme; draft reset restores the studio defaults without deleting a saved record.
A host wanting full chart content uses the workspace composition above.

Settings Undo/Redo keeps at most 30 prior transitions in memory and never stores
drawing history. Successful profile loads, imports and resets can be undone;
Save and read-only export/copy actions leave that history unchanged. Undo/Redo
does not overwrite the persisted profile or its saved baseline. Caption edits
are ordinary profile changes and survive device-preset selection. The studio's
JS/TS code export is a separate application module, not another persistence schema.

The demo rejects Load while a gesture, pointer or drawing transaction is active. It applies a validated profile to its live chart using existing setters. This
is an explicit user action, not a transactional chart replacement: tool filtering
and pointer disabling can cancel an owned gesture, callbacks may reenter, and a
reported application error does not prove rollback. Use fresh mounting for a
host-controlled replacement boundary.

Transient tool/selection, undo/redo, gestures, focus, explorer/cursor state, DOM,
CSS variables, arbitrary docking, callbacks and renderer resources are excluded.
No shortcut remapping, backend storage or native UI parity is introduced. Tests
cover the pure codecs and modeled DOM/storage, including invalid input, storage
errors and stale file reads. Real touch hardware and assistive technology require
separate validation.
