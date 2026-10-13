# Linked user indicator modules and study documents

0.2.11 adds a static catalog contract alongside the existing synchronous `registerIndicator` and trusted `registerIndicatorSource`. It does not evaluate source code from saved JSON or asynchronous requests. The legacy source-expression API still exists for trusted synchronous application code; it is excluded from the data command dispatch and portable asynchronous/save contracts.

```js
import {defineIndicatorModule} from 'barochart/core';
defineIndicatorModule({id:'my.balance',version:1,stateVersion:1,indicators:{balance:{
  causal:true,
  factory(params){ /* return outputs/create/step/snapshot/restore */ },
  validateCheckpoint(params,state,index){ /* throw on an invalid state */ }
}}});
// After linking the same declaration in all execution environments:
const [name]=chart.api.registerIndicatorModule('my.balance',1);
chart.api.addIndicator('balance',name,{period:10});
```

Each exact module ID/version has one declaration per runtime. Its canonical name is `id@version/exportName`. Private factory identity and immutable descriptors bind `id,version,stateVersion,exportName,causal`; wrapper/bind/alias or naked factories do not acquire portability. Same IDs/versions must describe the same trusted implementation in the developer's build graph: version numbers are not an automatic code audit/hash or sandbox. Update version/stateVersion when implementation/state semantics change. Factories retain the ordinary create/step/snapshot/restore contract, primitive parameters, output/offset and resource bounds. Output lookup uses only declared own names; supported names such as `toString` do not inherit Object.prototype values. An absent own plot-offset entry means zero. The existing reserved output names `__proto__`, `constructor` and `prototype` remain invalid definitions. Custom state is checked by the general bounded checkpoint codec before the linked validator, without automatic builtin snapshot compaction or suffix convergence. Validators must not repair/mutate the supplied state.

Owner and worker both need the static module. A custom web Worker entry statically imports the local declaration first, then `src/web/compute-worker.mjs`; `recomputeInWorker(...,{workerURL})` selects that entry. See executable `examples/indicators/local-volume-balance.mjs`, `examples/web/analysis-worker.mjs` and the analysis demo. Missing versions/codecs/modules reject with `UnsupportedIndicatorError`, code `UNSUPPORTED_INDICATOR_MODULE`, before publication. No module URL, function body or dynamically fetched code is transmitted.

The supplied `aster.volume-direction@1/pressure` module is linked in the standard web, JavaScriptCore and QuickJS resources. Its two outputs are signed `sign(close−previousClose) × volume × factor` (first sample 0) and cumulative signed volume. `factor` is finite within −1..1 and `shift` an integer ±10000. This is a bar direction proxy, not classified trade/bid/ask volume. Native SDKs select it with named `registerIndicatorModule` and normal `addIndicator`/series APIs.

For a developer-owned native module, the local build accepts a deliberately small self-contained module format: one single-line named `defineIndicatorModule` import resolving to this checkout's helper, ordinary script declarations, no additional imports/exports or top-level await. Each selected module is wrapped in a separate scope. Unsupported dependency/module syntax rejects at build time. It is a local build operation; include the emitted bundle as the SDK's explicit resource/asset in **both owner and asynchronous workers**.

```sh
node scripts/build-native.mjs --bundle-only \
  --indicator-module examples/indicators/local-volume-balance.mjs \
  --output /tmp/aster-custom-core.js
# Standard asset/executable build, without optional custom module files:
npm run build:native
```

The Apple engine's explicit bundle URL and Android asset constructor support developer-owned resources; default SwiftPM/AAR bundles carry the standard module. SDK wrappers preserve Java/Swift owner, error and observer contracts. Custom modules are trusted build code with the host's privileges; this API does not fetch dependencies, isolate arbitrary code or implement Pine. [TradingView's custom study documentation](https://www.tradingview.com/charting-library-docs/latest/custom_studies/) is a comparison reference for registration/metadata concepts, not code copied into Aster or proof of compatibility.

`saveStudies()` returns an `aster.studies` version1 JSON string with indicator IDs, canonical names, primitive params, exact module descriptors and public styles/bindings of their indicator series. It excludes data arrays, output vectors, checkpoints, source functions/code, external unbound value series, panels/axes, drawings/history and viewport. Saving validates included series against the same portable style rules as loading. Low-level browser-only colors such as HSL/CSS variables remain valid for local rendering but cause an export error; choose portable styles explicitly for documents. Successful saves preserve the existing style strings without approximation or automatic conversion. `loadStudies(text)` atomically **merges new IDs** into the current data/layout; it returns `{indicators,series}`. Required panels/axes must already exist. Duplicate IDs, invalid style/output/offset, missing modules and mismatched versions reject. Calculation is synchronous and recomputes on the target's current OHLCV; large setup imports may block the owner. Existing asynchronous prepare remains the separate large-data operation.

Import stages an engine and series, checks the original store/version/configuration and object ownership immediately before publishing once, and releases the temporary subscription on success/error. Trusted calculation callbacks that change the owner make the import stale; those host changes are preserved. This does not provide a full-chart snapshot. Web/native demos import into a fresh study container to show repeatable restore without duplicate-ID overwrites. Existing drawing documents remain separate.

Reproduce module/state/ownership tests with `node --test test/indicator-modules-async.test.mjs test/study-setup-oracle.test.mjs test/native-module-build.test.mjs`.

Existing study parameters can be replaced atomically with
`chart.api.setIndicatorParams(id, params)` while retaining bound series and
annotations. The complete replacement, schema/offset limits, synchronous cost,
and stale-result rules are in [INDICATOR-PARAMETERS.md](INDICATOR-PARAMETERS.md).

Calculation callback reentry, yielded iterator ownership and borrowed-output recovery follow [INDICATOR-REENTRY.md](INDICATOR-REENTRY.md). Same-entry active recursion fails explicitly; interrupted checkpoints cannot certify an uncomputed suffix.
