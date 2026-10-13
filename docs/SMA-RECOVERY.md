# SMA finite-window recovery

This change is limited to `sma`. It keeps the shared rolling helper used by WMA, Stochastic, CCI, MFI, CMF, HMA, Stoch RSI, Volume Oscillator and Vortex unchanged. EMA smoothing/seed overflow is also outside this fix.

## Numerical contract

The ordinary SMA update retains the previous rolling addition order. If the stored sum becomes nonfinite, or retirement/cancellation leaves a sum at the scale of rounding uncertainty, SMA recomputes the current ring from oldest to newest. The trigger compares the new sum against `4 * period * Number.EPSILON` times the maximum magnitude of the previous sum, expired value, new value and `new - expired` intermediate.

- Warmup is unchanged: the first complete window ends at index period−1.
- A sum still outside Float64's finite range produces **NaN**, including during warmup. A mathematically finite average can therefore remain a gap when its raw sum is not representable.
- Subsequent representable windows recover without resetting the indicator or source store.
- Period 1 returns the selected finite source value exactly, including signed zero. This also avoids an overflowing `new - expired` intermediate.
- A nonfinite selected input retains the existing reset/re-warmup policy.
- The fallback sums raw Float64 values in FIFO order. It is not arbitrary precision or a guarantee of the exact real sum for every highly cancelling ordering such as `[huge, small, -huge]`.

The direct factory formerly returned Infinity for some finite-source windows, causing `IndicatorEngine` to reject publication with “Output must be finite or NaN.” Those cases now return gaps and recover. Period-one rounding/signed-zero output and severe cancellation are intentional numerical behavior changes. Ordinary inputs are not promised bitwise identical if the new fallback is triggered.

The checkpoint shape remains `{r:{a,head,sum}}`. Existing Infinity, negative-Infinity or NaN sums can still be decoded and validated; subsequent steps normalize the current window. No new checkpoint fields or version are introduced. The sum stored in an overflow checkpoint may remain nonfinite while the published output is NaN.

Normal updates remain O(1); fallback is O(period), with no per-row vector allocation. Extreme or cancellation-heavy sequences can invoke it on every bar. Existing synchronous dirty-history cost remains and no UI latency guarantee is made.

## Regression coverage

Independent source-window tests distinguish exact analytical cases, FIFO Float64 references and legacy rolling tolerance checks. They cover overflow during warmup, new-minus-old overflow, dominant-term expiry, signed zero/subnormal inputs, every existing source field, source mutations and old checkpoint restore/ownership.

Actual Node Workers test params and workspace roundtrip with an Infinity checkpoint at index 256 followed by finite values. Native bundle VM and standalone vendored QuickJS test native commands, raw-window oracle, prepared workspace checkpoint ownership, compaction restart and cleanup.

Other extreme-value limitations remain. In particular, the existing EMA seed can overflow and remain NaN; this SMA-only change does not repair that seed or claim all other builtins recover from every finite-source intermediate overflow. Browser, Swift/JSC, Android/JNI and device execution remain unverified.

## Executed validation

Cloud Linux/Node 24.19.0: **2,753 full-suite tests passed, 0 failed, 0 skipped**; **377 ECMAScript modules** parsed and strict TypeScript 5.9.3 passed. The focused group has **34 tests**. The independent 30-test oracle was red against the previous commit (4 passed, 26 failed) and green after this change.

Against the previous commit, all 35 default builtins on one ordinary 520-bar seeded corpus matched bitwise across initial calculation, last/first/middle corrections and append: **161,262 output positions**, including NaN tails. This finite corpus does not prove every input bitwise unchanged. No wall-clock performance comparison was performed.

Standalone QuickJS executed four fixed native-command/oracle/parameter/workspace/compaction scenarios. Runtime, OOM and interruption cleanup all reported zero final tracked live bytes and allocation count. These counters are harness-specific and do not establish a process RSS bound or native SDK/device validation.
