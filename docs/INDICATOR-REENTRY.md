# Indicator calculation ownership and reentry

`IndicatorEngine.get(id)` and its `calculate(id, chunkSize)` generator share a guarded calculation boundary. This also covers consumers such as scene building, crosshair readouts and preparation states which call the generator directly.

## Failure and recovery

A calculation captures its managed source identity/version/columns and target entry ownership. Source mutation, entry replacement/removal/disposal, or a superseding calculation prevents successful publication and throws StaleSourceError. There is no automatic retry. The host can make a new explicit request after the callback or mutation has finished. A trusted callback's own thrown value is preserved, including its identity.

When a changed source still belongs to the same entry and calculation generation, failure leaves dirty=0 and invalidated=true. The next explicit read recalculates current data. Old calculations never clean, dirty, write or retire a replacement generation. Checks include create, snapshot, restore, custom step/output access, checkpoint get/set/validation, yield resumption and result metadata construction before final clean revision publication.

A running same-entry dependency throws IndicatorBusyError instead of recursively exhausting the stack. Different entries may calculate normally, but a dependency cycle returning to an already-running entry also fails. A realm-local limit permits at most 32 simultaneously running calculations, shared across all IndicatorEngine instances in that realm. The 33rd call throws IndicatorBusyError before taking generation ownership. This also bounds callbacks which repeatedly remove and add a fresh entry to evade same-entry detection. Yield, completion and failure release their execution-depth slot; suspended iterators consume no slot. Normal nested calls across different engines share this limit. A callback that loops directly without reentering calculation is not preempted. APIs which internally read the same indicator, such as changing its output binding, cannot be called from that indicator's active calculation callback. Pure presentation-only series patches do not read it and may complete; an outer dataAt query still rejects a changed display snapshot as stale. Pure UI changes which do not read it are not a source mutation.

## Yield ownership

A generator owns an execution token while running. It releases execution ownership when yielding, so an abandoned yielded iterator does not permanently block future reads. A new explicit get/calculate can supersede that suspended generation; it restarts from the original dirty block and its preceding checkpoint, not from a partially computed row count. The old iterator's subsequent next fails stale; return/throw cleanup cannot change the new output, dirty markers, revision, checkpoint ledger or token. Calling calculate without advancing its iterator does not start a generation.

Checkpoints are updated in place. The active iterator captures its original suffix-convergence eligibility locally, but marks the entry invalidated before any partial checkpoint writes. Only successful completion clears that marker. Consequently the same uninterrupted calculation retains the existing convergence optimization, while superseding or retrying an interrupted calculation cannot mistake a newly written checkpoint for proof that an uncomputed suffix is already correct. A source change forces row-zero recovery; otherwise the original dirty block is retained.

## Existing output ownership

Engine output arrays are borrowed live views. Calculations can write some values before a later callback fails, just as in the existing in-place engine. This change does not add transactional output rollback, an immutable old-output promise, or a second full output allocation. Consumers must discard a failed calculation result and request a new completed result before treating it as coherent. After an iterator discovers source/ownership loss, it performs no more output/checkpoint writes; values written before that boundary may remain in held views.

The stronger old-output preservation guarantees of separate atomic parameter/workspace staging APIs are unchanged: those use different entries/buffers. NativeCheckpointEntries still owns retirement and shared ledger release; calculation guards do not replace or bypass its maps.

## Cost and trust boundary

Per-row callback guards are required for custom implementations and returned value access. The builtin fast path is eligible only for the actual unmodified canonical definition with its canonical registry binding. Those create/step/snapshot/restore closures are library-owned, not replaceable host callbacks under that provenance. Checkpoint operations are still guarded for all definitions, including native custom validators; registry name alone does not authorize skipping checks.

Managed source operations are covered. Direct writes to column buffers, arbitrary Proxy/internal replacements, modified runtime intrinsics and side effects outside the library remain outside the managed consistency contract. Trusted callback execution itself cannot be preempted, made allocation-free, or rolled back. This is bounded failure for calculation ownership, not a sandbox for custom code.
