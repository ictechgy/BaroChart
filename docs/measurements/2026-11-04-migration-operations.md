# Migration example and operations check — 2026-11-04

Base source: `397ed63c4de4d13df1aa68ebe898dc0746f8176b` (`feat/migration-operations` worktree), plus the uncommitted migration guide/example changes recorded in this worktree. This is a focused local-browser observation, not a release or device qualification.

## Environment and reproduction

- Node.js 22.20.0; `agent-browser` 0.38.1; headless Chrome user agent reports HeadlessChrome 154.
- Server: repository `scripts/serve.mjs`, bound to `127.0.0.1:5193` using `PORT=5193`.
- Page: `/examples/web/lightweight-migration.html`; synthetic candle rows only. No account, provider key, or market-data request was used.
- Commands: `PORT=5193 node scripts/serve.mjs`; in a separate terminal, `agent-browser --session codex-migration-ops-1104 open http://127.0.0.1:5193/examples/web/lightweight-migration.html`.
- This browser session requested local HTML/module assets and a local `favicon.ico` route, which returned 403 because the fixture serves only its allowlisted public assets. No external or provider requests appeared. The browser `errors` command reported no uncaught page errors. One diagnostic `eval` after disposal attempted to read the removed canvas and itself returned a TypeError; a follow-up check confirmed canvas count zero and the UI had no page exception.

## Observed behavior

| CSS viewport | Document width / horizontal overflow | Chart canvas | Update result |
| --- | --- | --- | --- |
| 1280 × 800 | `scrollWidth=1280`; no horizontal overflow | 960 × 420 | Clicking Update changed latest-bar status and a full-pixel canvas checksum from `273553326` to `3439660823`. |
| 390 × 844 | `scrollWidth=390`; no horizontal overflow | 342 × 420 | Update changed status from update 2 to 3 and checksum from `2688406842` to `3550743028`. |
| 320 × 720 | `scrollWidth=320`; no horizontal overflow | 272 × 420 | Update changed status from update 3 to 4 and checksum from `2985619204` to `3178842097`. At this height the page scrolls vertically to reach lower controls; the check is width overflow only. |

The button calls `applyLightweightBar` on the example's BarStore; the changed status and canvas pixels show the accepted latest-bar change reached the rendered chart. Inputs are four synthetic OHLCV rows. The update changes the final close by one unit; no live-data semantics are inferred.

Navigation from the example to `quickstart.html` and browser Back produced actual `pagehide` and `pageshow` events with `persisted: true`. The restored page retained its prior update count, kept one chart canvas, accepted another update, and reported no uncaught page errors. A separate synthetic non-persisted `PageTransitionEvent('pagehide')` exercised terminal cleanup: the chart canvas was removed and a subsequent button click left status unchanged. The synthetic event checks the handler path; it is not counted as a second real browser navigation.

## Saved screenshots

Files are in the gitignored `artifacts/migration-operations-20261104/` directory. PNG hashes identify the captured evidence.

| Screenshot | Pixel dimensions | SHA-256 |
| --- | --- | --- |
| `migration-1280.png` | 1280 × 800 | `f2baa22999a2d556625657cdedeb863dce6f5c33996c7f3305e01cc929cdfbc9` |
| `migration-updated-1280.png` | 1280 × 800 | `b594fa1b47c73906b69dab1d23f8f116257aecfdaacef7bf3bd541153945db2b` |
| `migration-390.png` | 390 × 844 | `145488199b780c96ca4e2f758f5842526751ee6494e5d0ad5312268954a46133` |
| `migration-updated-390.png` | 390 × 844 | `2ac95851484da5463e181d9adb1b5e6082dc97e78c936a78c47b7992594dcafa` |
| `migration-320.png` | 320 × 720 | `824b0e288e45df727392de9e053bc0763be516337275a41927b5cd8d4d2f93c3` |
| `migration-updated-320.png` | 320 × 720 | `e61ef3a2989c8ad05da9a6dbb25c11a4b82a3e3303fde3f77fc53527f62e7929` |

## Limits

This verifies one headless Chrome session and this local example only. Viewport resizing is not physical touch input; BFCache evidence covers one local history transition. No screen reader, other browser engine, device, React runtime/SSR, native SDK build, provider feed, performance timing, or release artifact was tested. See [support status, remaining manual checks, and release gates](../SUPPORT.md). The page is independent of TradingView and does not claim Lightweight Charts API or Advanced Charts/Pine compatibility.

## Integrated source checks

The parent reviewer inspected the converter, lifecycle implementation, guides and browser evidence, including the 320 px screenshot. The whole Node suite passed **5,931/5,931**, with zero failures/cancellations/skips and TypeScript 5.9.3 configured. Syntax checks parsed **653 modules**; strict types passed. The four converter tests include signed-zero preservation and unchanged source columns/version after rejected input.
