# Renderer-remount diagnostics

The saved Mac Chrome 155 QA run reached Canvas 10k bars with VWMA and Aroon, then attempted the WebGL2 renderer change. It did not record which individual Runtime.evaluate was pending. The final CDP connection-closed error followed termination of the owned test Chrome. This does **not** establish a product GPU hang or its cause.

The separate drawing-panel focus correction subsequently passed 16 scenarios / 60 checks in actual Mac Chrome. That result does not validate WebGL remount.

## Confirmed harness defect

Previously, scripts/cdp.mjs waited for Page.loadEventFired without a deadline or socket-close rejection after Page.navigate succeeded. A fake transport running that actual implementation reproduced a navigation Promise that remained pending after socket close. This is a harness defect, not evidence that the original renderer switch hit the navigation branch.

Navigation now shares a bounded operation deadline, clears its event listener and pending command on failure, and settles once. Launch/open failures dispose transport listeners and request termination of the owned child, then attempt owned-profile removal. Cleanup does not await child exit/reaping; an actual Chrome termination-and-profile-cleanup guarantee is not established by this fixture. Browser.close has a separate 3-second request limit. Existing send(method, params, session, timeoutMs), evaluate(expression), navigate(url), and on(method, listener) calls remain supported. Optional evaluate/navigate options accept timeout and a short label. diagnostics exposes the latest 128 request/phase records containing only id, method, label, elapsed milliseconds and state. Use fixed labels without secrets; expressions, URLs and response payloads are never captured by this log.

Transport deadlines require the host Node event loop to run. Timing out a Runtime.evaluate request does not preempt the browser's JavaScript/GPU work or guarantee cancellation of the underlying protocol command. Late replies are discarded.

## Subsequent bounded browser probe

A later, separately authorized Mac Chrome 155 run completed one Canvas → WebGL2 → Canvas round trip with 28/28 CDP requests responding. See [exact scope and limits](PUBLIC-VALIDATION.md#scoped-mac-browser-qa-2026-10-14). The earlier interruption was not reproduced and its cause remains unconfirmed. No product renderer change was made.

## Diagnostic protocol

No additional Mac execution is part of this change. A subsequent explicitly approved probe should:

1. Use the same 10k/VWMA/Aroon fixture and capture page exceptions before switching.
2. Log bounded fixed-label request records for change dispatch, post-dispatch select-value read, and each readiness query. Flush the small diagnostic list on failure before closing the owned browser.
3. Keep dispatch separate from readiness polling. After dispatch, query a small fixed snapshot: old/new chart identity, disposed flags, rendererKind, Boolean(lastScene), fallbackReason, lastError message (bounded), canvas count and bounded status text.
4. Poll under an overall monotonic deadline; pass the remaining budget to each request. A missing scene is a failed readiness observation, not proof of an infinite loop.
5. In finally, unsubscribe probe listeners and close only the owned browser/profile. Preserve the first operation error separately from cleanup errors.

The demo switch is synchronous: it destroys the old chart, creates the replacement, and then publishes window.aster. Construction failure can leave the old disposed chart published. A caught first-frame error can publish a new chart without lastScene. WebGL initialization normally falls back to Canvas, which can satisfy the actual readiness predicate. These are diagnostic branches, not reproduced product defects from this incident. The switch does not prepare a new worker model.

The transport regression uses fake socket messages and an intentionally missing executable. It does not exercise Chrome, WebGL, JSC, native SDKs or screen readers.
