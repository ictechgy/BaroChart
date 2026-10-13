# Aroon validation

Aroon is the 34th built-in. This is a correctness and integration addition, not a claim of commercial-product parity or rendering performance.

## Contract

- `aroon`, default `{period:25}`, integer period 1..10000.
- A period of p means p prior intervals plus the current bar: a p+1-bar window. The first finite output is at zero-based index p.
- `up = 100 * (p - barsSinceLatestHigh) / p`; `down` uses the latest low; `oscillator = up - down`.
- Equal extrema, including signed-zero prices, choose the most recent bar. A flat complete window returns 100, 100, 0.
- Time gaps do not add implicit bars. Existing finite OHLCV ingestion requirements apply.
- Monotonic extrema queues perform amortized constant work per bar and retain O(p) state. Checkpoints are canonical serializable copies. Existing checkpoint byte/count limits remain: a large permitted period does not guarantee every input fits an async/native workspace checkpoint budget.

## Executed checks

On cloud Linux with Node 24.19.0:

- Full serial suite: **2,683 passed, 0 failed, 0 skipped**.
- Syntax: **370 ECMAScript modules** parsed.
- Strict TypeScript 5.9.3 and offline installed-package export/consumer checks passed.
- Independent raw-window scan oracle covers literal examples, period 1/default/max, ties, signed zero, extreme finite prices, missing time intervals, warmup and append/update/correction/prepend/reset.
- Dedicated real Node Workers exercise parameter replacement and portable workspace restore. Other tests cover bindings, held old outputs, compact restart, historical cutoff, malformed checkpoints and all-34-builtin source/target paths.
- Final targeted Aroon/compaction/native-source suite: **123 passed**.
- Vendored QuickJS was compiled locally and executed four fixed fixture scenarios: native commands with independent scan, parameter/history mutation, prepared workspace/checkpoint ownership, and compact restart/cleanup. Runtime teardown, OOM and interrupt cleanup all reported zero final tracked live bytes and allocation count. These are allocator counters for this harness, not a general heap/RSS bound.

An earlier full run had four expected registration-coverage failures because two test files still pinned the previous 33-name list/count. The explicit output oracle was extended with all three Aroon outputs and the count checks now require 34. The final full run above uses those updated contracts; the failed run is retained in private verification evidence.

No browser pixel/assistive-technology, Swift/JSC, Android/JNI, mobile SDK or physical-device validation was performed for this addition. No cross-product speed benchmark was run. Current synchronous calculation and dirty-history recomputation costs still apply.
