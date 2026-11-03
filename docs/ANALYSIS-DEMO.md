# Main analysis workflow

The [main demo](../examples/web/index.html) combines study discovery, chart drawing, the existing SDK drawing-object panel and an application-owned analysis file. Run `npm run demo` and open `http://127.0.0.1:5173/examples/web/`.

## Try it

1. Select an indicator in **지표 찾기** and add it. Use the placement/settings controls to adjust it.
2. Draw on the chart, then follow **2 · 도형 관리**. The existing panel supports checked multi-selection, hide/show, duplicate and selective style edits. Its checkboxes are a batch selection; canvas selection and the footer's lock/move actions remain separate.
3. Choose **분석 파일 저장**. Modify the data, remove a drawing or change a study, then use **분석 파일 복원** with that file.
4. The saved source, studies, committed drawings, theme and exact visible range replace the current analysis. The synthetic stream stays paused so the captured source is not immediately changed. Start it explicitly when ready.

The drawing panel is rebound when a prepared model or renderer replaces the chart. Old panel listeners are disposed with their chart. Pointer-hover events do not rebuild the object list. The manager is a collapsed details section, with a direct workflow link that opens it.

## Three different save actions

| Action | Included | Use |
| --- | --- | --- |
| Analysis file | Captured OHLCV and a portable workspace, plus demo market/appearance metadata | Reopen this complete demo analysis with its captured source. |
| Layout file / browser layout memory | Study configuration, panels and axes | Apply a layout to the current source while retaining compatible drawings/history. |
| Drawing file | Committed drawing objects | Export/import drawings separately. |

The analysis envelope is **example application code**, not a new SDK workspace schema or native import format. SDK `saveWorkspace` remains metadata-only and still requires independently supplied data/binding. A native app should manage its source separately. [Workspace contract](WORKSPACES.md).

## File contract and limits

- Schema `barochart.demo-analysis`, version 1; at most 250,000 bars and 32 MiB UTF-8. The million-bar demo remains usable, but cannot export this bounded analysis file; choose a smaller source first.
- The file includes six owned column arrays and an unchanged `aster.workspace` document. The column token `"-0"` preserves negative zero; other column values must be finite numbers. Times/order/OHLC bounds are validated by the real BarStore. Unknown fields, schema versions, unequal columns, mismatched market/binding and source extents reject.
- Nesting is bounded before outer JSON parsing; embedded workspace metadata uses the existing bounded workspace reader. File size is checked before reading and text size is checked afterward.
- This is a self-contained user file, not an authenticated feed revision or proof that historical prices are correct. No server upload or background synchronization is performed.
- Undo/redo history, drawing selection, in-progress gestures, pending ingestion, active tool, crosshair/magnet settings and renderer choice are not included. Restored panel/axis resources are explicit configuration; old demo layout-history ownership is reset.
- The main demo uses the SDK's portable symbol formatter pair, including the year in time labels. Arbitrary formatter functions, external output arrays and unsupported custom modules reject instead of being silently serialized.
- Export and initial file parsing are bounded synchronous work on the UI thread. Indicator reconstruction uses the existing dedicated workspace Worker; this does not make parsing or export nonblocking.

## Failure and ownership

A restore prepares a separate source/model and mounts it before retiring the current chart. Invalid files, failed preparation, cancellation, navigation and stale file reads leave the accepted chart intact. Changes to the current data, configuration or committed drawings during preparation reject the candidate. Superseded results are disposed and cannot clear the newer operation's busy state.

Successful restore pauses the stream and clears the old drawing/layout histories. It does not replay old callbacks or revive disposed renderers. Restore does not overwrite the source arrays belonging to the previous model.

## Verification

- `node --test test/demo-analysis-session.test.mjs`: exact bars (including negative zero), workspace reconstruction in a real Node Worker and malformed/oversized input.
- `node --test test/demo-readiness.test.mjs test/demo-page-lifecycle.test.mjs`: actual demo handlers, modeled DOM/renderers and controlled async jobs for readiness, cancellation, stale ownership and retained state.
- Browser verification separately checks the rendered workflow, file download/upload, drawing manager and desktop/mobile layout. Node checks alone do not certify physical touch or screen-reader behavior.
