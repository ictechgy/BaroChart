# Deterministic Worker deadline lifecycle tests

These test-only fixtures separate Worker startup speed from deadline/cleanup
correctness. Production deadline semantics and the existing 500/600 ms values
are unchanged. The operation deadline still begins before snapshot and includes
workerFactory execution, calculation, validation and final publication guards.

The test host optionally reports ready only after the production Worker module
has imported and the dispatch listener is installed. Node's online event is not
used as module readiness. A prepared dedicated Worker is claimed once through
the existing synchronous workerFactory; it is not a reusable production pool.

Withheld-response cases observe an actual successful Worker result with matching
schema, kind, job ID and request binding. Only then does a test-controlled
monotonic clock reach the original deadline and run its registered timer. Ready,
dispatch and error packets cannot satisfy the result assertion. The tests prove
TimeoutError, no publication, one production termination, detached listeners and
recovered logical reservations. They do not prove that the real wall-clock
calculation finishes within 500/600 ms.

Separate startup coverage advances the controlled clock during workerFactory:
expiry must cause zero request posts and one termination. The termination-phase
case requires a matching successful packet and completed validation before it
advances the deadline, so early startup timeout cannot falsely pass it. Existing
real timer/macrotask coverage is retained in calculation-job-scheduling.test.mjs.

Unclaimed prepared Workers, import failure and assertion failure are cleaned up
by the fixture. Teardown's direct node.terminate fallback is counted separately
and cannot conceal missing production termination. Clock/timer globals are
restored only after pending operations settle. The independent focused run
passed 112 tests; the earlier failing full-suite and timing A/B evidence remain
unaltered in the evidence archive.

A subsequent full serial run passed 2334/2337 tests and exposed three other
startup assumptions; that failure log is also preserved. Registration-failure
subprocess tests now use import-ready/run IPC before the unchanged 5 ms operation
and verify its actual timer registration/removal, listener cleanup and absence
of unhandled rejections. Separate 15-second infrastructure watchdogs bound hung
startup/completion, replacing a 1-second whole-process startup assumption.

Workspace repeated timeouts now reach factory/post before the controlled 20 ms
deadline fires, verifying one termination and complete cleanup per iteration.
A separate preflight-expiry case requires zero Worker creations. These two files
passed 90 focused tests with their deadline/scheduling dependencies and independent
review. None of these changes resets or extends a production operation deadline.

A later run passed 2336/2338 tests; syntax/package verification overlapped part
of that run and it is not an isolated performance measurement. The remaining
two failures were phase-readiness assumptions: termination-stale before validated
results at 5000 ms, and validation progress before 1000 ms. The original run and
conditions remain archived.

The same test-only phase discipline now covers params snapshot/compute/validate
callbacks (700 ms), calendar provider (50 ms), validation callback (1000 ms), and
validated-result termination modes (600/5000 ms). Callback/provider cases advance
the monotonic clock without running the deadline timer, proving the post-callback
check itself rejects. Termination cases require a matching real result and
completed validation before injecting abort/stale/timeout/throw. Real watchdogs
bound fixture hangs and all operations settle before global clocks are restored.
The focused 112-test run passes; this does not assert those phases finish within
the corresponding real wall-clock budgets. Legacy separate-runner deadline tests
remain unchanged, as does real timer/macrotask coverage.

Final isolated serial run: 2336/2338 passed, with all modified Worker phase tests
passing. The two failures were unchanged 5000 ms Node VM checkpoint/source
fixture hang watchdogs, not these deadline tests. Their one unchanged isolated
rerun passed 50/50. No VM watchdog was raised, and the full-suite result remains
reported as two failures. Production code is unchanged from safety commit61651fd.
