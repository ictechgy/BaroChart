# Feed integration verification — 2026-11-03

Base: `d6833f0` (#25), branch `feat/market-data-recipes`. Product improvement ③.

## Delivered behavior

An application-owned browser recipe connects a ready subscription to an authoritative HTTP snapshot and copied, bounded deltas. The provider must supply a shared contiguous watermark domain. Bootstrap stages all accepted events before source publication; live data reuses the existing SDK APIs. Duplicate sequence is ignored; gaps, source edits and invalid payloads stop the session. Explicit reconnect replaces old subscriptions and ignores old callbacks/snapshot results. Owner cancellation settles outstanding waits, including adapters that reject readiness while closing synchronously.

The local fixture uses actual HTTP + SSE with synthetic data only. It is not a provider connection or a production backend. It caps source growth and connections, accepts only same-origin JSON actions, and retains the existing demo server's filesystem/host boundaries. The HTTP adapter cancels snapshot bodies above 16 MiB rather than buffering them fully. Event text is bounded to 16,384 characters.

## Verification

- 19 focused tests passed: real ChartAPI/BarStore, snapshot/live overlap, producer object reuse, update/append/correction, duplicate/gap, invalid snapshot, queue overflow, stale source, reconnect, disposal, synchronous-close readiness rejection, HTTP/SSE and response byte-budget cancellation.
- Whole Node suite: **5,927 passed, zero failures/cancellations/skips**, with TypeScript 5.9.3 configured.
- Syntax: **651 modules**. Strict TypeScript and offline installed npm consumer passed. SDK source modules/public data API are unchanged.
- Isolated Chrome: **13 checks** passed using real fetch/EventSource, UI-triggered updates/appends/corrections, duplicate conservation, gap retention, new-snapshot recovery, server disconnect and user pause. Widths 1280/390/320 have no horizontal overflow; no uncaught page errors. Mobile screenshot inspected.
- Feed/onboarding documentation: 44 relative links resolved; `git diff --check` passed.

TDD evidence includes the initial missing session behavior, response-body budget failing to cancel, and synchronous subscription close causing an unhandled rejection. Final regressions pass on the corrected paths.

## Reproduction

```sh
node --test test/feed-session.test.mjs test/feed-transport.test.mjs
TSC_PATH=/path/to/typescript/lib/tsc.js node --test --test-concurrency=1 test/*.test.mjs
npm run check
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:package
node scripts/serve-feed.mjs
```

Open `http://127.0.0.1:5190/examples/web/feed.html`. [Provider contract and host integration](../FEED-INTEGRATION.md).

Local ignored evidence: `artifacts/product-completion-20261103/` (feed red/green TAP, whole-suite TAP, browser command runner/results/screenshots and package report). These are current local measurements, not physical-device, screen-reader, total-memory or latency guarantees. Network timeouts, retry, authentication and provider-specific sequence mapping remain host responsibilities. A post-commit SDK notification error does not prove rollback.
