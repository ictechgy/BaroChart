# Remaining product improvements

User authorization: continue all remaining items after #25, through implementation, verification, PR/CI/merge. Base `d6833f0`. Existing Rust rewrite remains a separate unfinished objective; the user has been asked whether full M1b–M7 is included in this run.

## 3. Data connection recipes

Deliver an application-owned session that subscribes before fetching a snapshot, buffers bounded deltas, checks the snapshot watermark, rejects gaps, drops duplicates and retires old callbacks on disconnect/reconnect/dispose. Snapshot and buffered events validate before publication; live events reuse SDK validation. The application owns transport, retry and source revision. No provider credential, feed subscription or order execution is added to the SDK.

Acceptance: runnable local HTTP snapshot + SSE fixture and browser example; tests for concurrent snapshot/live data, update/append/correction, duplicate/gap, stale snapshots, overflow, wrong source and cleanup. Document the required provider ordering/watermark contract and how to replace the fixture with app-owned transport.

## 4. Mobile quality

Inspect the existing native samples and real browser flows. Reproduce and repair lifecycle, stream suspension, cancellation/restore, rotation and accessibility problems that current tests expose. Run available simulator/emulator/UI tests and mobile viewport/trusted-input tests serially when load matters. Record physical-device availability. VoiceOver/TalkBack usefulness still requires the owner's actual-device sign-off; automated checks cannot fill it in.

Acceptance: new regression tests distinguish every behavior fix; available native and browser gates run with recorded device/runtime. Unavailable physical/manual checks have exact remaining steps and no pass claim.

## 5. Performance and backend evidence

Use existing pinned/accessible runtimes, identical data and visible work, explicit cold/warm sampling and source hashes. Separate API CPU, first-render scheduling, gesture/frame pacing and memory. Preserve failures/inconclusive comparisons. Existing native measurements are historical CPU/offscreen results, not display FPS.

The Rust engine is a count-echo scaffold on `feat/rust-m1b-abi-packaging`, not a chart backend. Never publish a JS/Rust chart-speed ratio from that scaffold. If the user selects product-first, deliver a reproducible JS/native baseline, fair competitor comparison and machine-readable unavailable status for the full Rust chart lane. If the user includes the complete rewrite, continue the existing Rust M1b–M7 plan and compare only after the implementation/conformance gates.

## 6. Migration and operations

Deliver a guide from the pinned Lightweight Charts product and an executable migration sample covering data/time units, series, update/append/correction, lifecycle and unsupported behaviors. Keep it distinct from Advanced Charts/Pine compatibility. Add a compact support/compatibility matrix and failure-reproduction template linking current evidence, known limits and release gates. Preserve older validation history.

## Delivery

One coherent branch/PR per bundle, tests before meaningful behavior changes, then whole affected checks and CI. Review final diffs before merging the exact verified head. Keep HANDOFF.md local. Public registry uploads, tags, deployment, new network destinations and credential reads retain their existing approval boundaries.
