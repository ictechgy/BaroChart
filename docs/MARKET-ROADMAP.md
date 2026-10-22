# Incremental chart experience roadmap

This implementation sequence extends existing chart contracts instead of replacing
them. Every item is opt-in and preserves current defaults. Source OHLCV comes from
the host: feed acquisition, entitlement, reconnect/reconciliation, broker orders,
accounts, server notifications, journal backends and cross-device storage are not
chart-library responsibilities. Nothing in this roadmap publishes the package.

## P0: runtime evidence and boundaries

On 2026-10-22, the restored `13292369c5e919c4b8de255e6e277a982a19b343`
baseline passed all **40 portable-workspace roundtrip tests** on Node 24.19.0:

```sh
node --test test/portable-workspace-roundtrip.test.mjs
```

The fixture uses real `node:worker_threads`, real module evaluation, message
transfer and termination, with a Worker interface adapter. It checks exact
configuration/drawing/indicator roundtrips, independent dataset identity, source
changes, cancellation, cleanup, limits and ownership. This is actual Node Worker
execution, not an actual browser Worker or UI test. Existing modeled DOM, generated
bundle VM and source checks remain separately labeled.

Actual browser rendering, trusted input/focus/touch, React runtime integration,
GPU, native SDK/device/JNI and assistive-technology validation remain unresolved.
P0 is therefore
**partial**, not a cross-platform runtime acceptance gate.

## P1: portable state and optional web controls

1. Implemented: [versioned web UI preferences](WEB-UI-STATE.md) compose with existing workspace v1.
   Reuse its indicator, drawing, theme, panel, axis and viewport serialization.
   Keep storage and candidate mounting/disposal explicit and host-owned.
2. Implemented: explicit desktop/mobile input/control presets without user-agent detection or default
   changes. Do not claim touch-device validation from model tests.
3. Implemented: [host-owned fixed overlay slots](CHART-OVERLAYS.md) with bounded lifecycle/placement contracts.
4. Implemented: [optional single-chart navigator](CHART-NAVIGATOR.md) using the existing visible-range API.

Existing workspace restore requires the exact source extent and the independently
supplied five-field dataset binding. A source that has appended since save is not
silently accepted; equal endpoints alone never prove dataset identity. UI-only
preferences must be usable without replacing the source or chart configuration.

## P2: replay and external trade annotations

5. Implemented: existing isolated BarReplay now has [portable session/bookmark metadata](BAR-REPLAY.md#versioned-sessions-and-bookmarks).
   Do not expose future bars, a mutable replay model or execution semantics.
6. Implemented: [bounded external trade-ID marker annotations](TRADE-MARKERS.md). The host owns trade identity,
   storage, reconciliation and action handling; a marker is not an order.

General multi-chart/alert editing, free docking and shortcut remapping are not
part of these initial slices. Per-feature documentation records completed APIs,
regressions and the exact verification limits; this list is not a claim that all
items already exist.
