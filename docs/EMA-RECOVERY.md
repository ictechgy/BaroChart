# EMA seed and recurrence recovery

This fix applies only to `ema`. The shared `smooth`/`emaValue` paths used by RSI, ATR, MACD, ADX, DEMA, TEMA, Keltner, Supertrend, TRIX, PPO, Stoch RSI, Chaikin and Force Index are unchanged.

## Explicit recovery policy

For periods greater than one, ordinary finite seed sums and recurrence keep their existing operation order. The ordinary seed is still an SMA over period samples, not the first close.

- If a finite sample makes the seed sum overflow, the failed seed prefix is discarded. **That current finite sample is retained exactly once as the first sample of a new seed.** Until this seed reaches the requested period with a representable sum, output is NaN.
- A permitted legacy checkpoint with a nonfinite partial seed sum, or a mature NaN value, is reset before consuming the next finite input. A mature finite value is not reset just because its now-unused seed sum is nonfinite.
- If a mature finite recurrence becomes nonfinite because `new - old` overflows, the wrapper tries `(1-alpha)*old + alpha*new`. This avoids the overflowing subtraction for opposite-signed finite values and continues the existing state when finite.
- Nonfinite selected input keeps the prior reset/re-warmup behavior.
- Period 1 returns the current finite source directly and stores it, while either signed zero remains normalized to **+0**. This fixes the finite cancellation case `[1e308, 1]` that previously returned 0 on the second sample. It is an intentional period-one behavior correction; period>1 finite arithmetic is unchanged.

This is a bounded gap/reseed policy, **not an exact reconstruction of the original full-history mathematical EMA after seed overflow**. For period 2, `[1e308,1e308,1,1]` yields `[NaN,NaN,5e307,approximately 1.6667e307]` under the new policy. Repeated enormous samples can keep causing gaps even where a differently scaled mean would be mathematically finite. No arbitrary-precision or all-extreme-values accuracy guarantee is made.

## State and compatibility

The state shape remains `{e:{count,sum,value}}`; no array, new checkpoint field or version is introduced. Work and state remain O(1) per input. Warmup resets can delay the first finite output beyond the normal period−1 index.

The existing validator continues to accept partial seed `sum` values of Infinity, -Infinity or NaN and mature `value:NaN`. It already rejects `value:Infinity` or `value:-Infinity`; this fix does not claim worker/native hydration support for those rejected values. A valid mature finite value ignores a nonfinite obsolete seed sum, and canonical snapshots retain their previous normalization.

The tests distinguish ordinary bitwise compatibility, the new period-one correction, gap/reseed semantics and fallback continuity. Original source data, borrowed output ownership and existing async stale/publication contracts are not changed. Browser, Swift/JSC, Android/JNI and physical-device execution remain unverified.

## Executed validation

Cloud Linux/Node 24.19.0: **2,799 full-suite tests passed, 0 failed, 0 skipped**. The focused group has **46 tests**. Its independent 42-test oracle was red against the previous commit (5 passed, 37 failed) and green after this change.

All 35 default builtins on an ordinary 520-bar seeded corpus matched the previous commit bitwise across initial calculation, last/first/middle corrections and append: **161,262 output positions**, including NaN tails. This corpus excludes the intentional period-one correction and does not prove universal numerical equality. No wall-clock performance comparison was performed.

Standalone vendored QuickJS executed five fixed scenarios covering native commands, an independent prefix oracle, params/history mutations, prepared workspace checkpoint ownership, compaction cleanup, exact period-one values and legacy seed recovery. Runtime, OOM and interruption cleanup reported zero final tracked live bytes and allocation count. These harness counters do not establish process RSS bounds or SDK/device execution.

ECMAScript syntax validation covered **380 modules** and strict TypeScript 5.9.3 passed.
