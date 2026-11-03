# JSON oracle runtime investigation — 2026-11-04

A whole-suite run selected Homebrew Node 26.5.0 (V8 14.6.202.34-node.24, Unicode 17) through npm's `#!/usr/bin/env node`, even when the npm launcher was addressed through the Node 22 installation directory. Calling an absolute npm path does not pin the interpreter found through `PATH`.

On that runtime, the seeded JSON corpus produced a `json#584` expected key U+005C while Rust returned U+D800. This was reproduced independently of Rust, the custom UTF-8 codec, and the JIT:

```js
const target = '{"-0":0,"\\uD800":0}';
Object.keys(JSON.parse(target)); // second key U+D800
JSON.parse('{"-0":{},"\\\\":0}');
Object.keys(JSON.parse(target)); // Node 26.5.0: second key U+005C
```

The same two-parse probe passes on Node 22.20.0 (V8 12.4.254.21-node.33, Unicode 16). Node 26.5.0 also fails with `--jitless`. The corpus's `jsonLossless#514` carrier contains the triggering shape; parsing that carrier alone changes the later result. Shape/transition-cache reuse is an inference; no upstream implementation or fixed version was verified.

Run the standalone, dependency-free [probe](../../test/fixtures/node-json-key-probe.mjs) with the interpreter being evaluated:

```sh
node test/fixtures/node-json-key-probe.mjs
```

It prints runtime versions and before/after UTF-16 key units, and returns 2 if the key changes. The conformance CLI now runs the same capability check before building/calling Rust. An affected oracle exits as an environment error, with no comparison performed. This does not exclude a corpus case, alter expected Rust values, retry a failure to green, or establish that other Node/browser versions are affected or fixed.

Verification uses the project's Node 22 toolchain, with its directory at the front of `PATH` when invoking npm, and TypeScript 5.9.3 configured. Reports retain Node/kernel executable SHA-256 and Unicode versions. A genuine first V8 JSON mismatch additionally retains the original verdict and logs portable/native replays and UTF-16 keys for diagnosis; replays cannot change that verdict. The regression tests cover this separation and rejection of a simulated broken oracle.

Earlier failed evidence remains under the local M1b investigation record; its missing executable identity is not retroactively filled in. Current reproduction evidence is in ignored `artifacts/conformance-oracle-debug/`, `artifacts/rust-size/node26-conformance-*`, and `artifacts/task6-parent/`. No Rust JSON semantic workaround or new divergence exemption was added.
