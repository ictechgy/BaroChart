# Native feature surface and next steps

Private 0.2.13 Linux checkpoint. This inventory distinguishes available source
contracts from newly compiled native SDK support. It does not assert commercial
feature parity or performance superiority.

| Feature | Core / web | Native source surface | New platform verification |
|---|---|---|---|
| Synchronous atomic indicator params | ChartAPI, types, tests | Swift/Java command facade | Not compiled here |
| Entry-only async indicator params | Real Worker; original store retained | No native facade/job | Not implemented |
| OHLCV resampling / confirmed alignment | Pure core and web Worker APIs | Core functions bundled; no named Swift/Java facade/job | Not implemented as SDK API |
| Workspace export | Core canonical bounded writer | Dedicated Swift/Java save read | Node VM + standalone QuickJS + static facade tests only |
| Workspace preflight | Native metadata/source assertion | Dedicated Swift/Java validated-only read | Node VM + standalone QuickJS + static facade tests only |
| Workspace restore | Web prepares fresh model sharing host BarStore | Isolated JS source/target, Java restore adapter/state machine and Swift background-context source implementation | Node VM / standalone QuickJS protocol; Java state machine real-thread fake Host and compile-only Engine signatures; actual Android/JNI publication unverified; Swift source/static review only, no Swift/JSC build/run |
| Static indicator modules | Versioned application-linked exports | Existing linked module facades/bundle support | Earlier checkpoint native runs, not this new build |
| Background source preparation | Owned snapshots and stale checks | Existing correction/columns/seeded jobs replace context | Earlier checkpoint native runs, not new feature coverage |

## Native implementation roadmap

1. **Whole workspace restore:** reuse native background preparation to build a new
   isolated runtime from owned host source columns, apply the entire document and
   compute studies. Validate modules/checkpoints/output metadata; check source and
   UI revisions after all callbacks and cleanup; atomically replace the runtime
   and notify once. The host AsterEngine and view listeners can remain stable, but
   the runtime and internal BarStore identities change. JavaScriptCore JSValue /
   QuickJS context references cannot be shared or migrated silently. This is a
   native context-replacement contract, distinct from web's shared-BarStore return.
   Aggregate old/new runtime, source snapshot, vectors, checkpoints and document
   memory must be admitted together; existing 768 MiB prepare / 512 MiB correction
   snapshot logical policies require reconciliation rather than assuming RSS fits.
2. **Entry-only async params:** calculate the target in an isolated context, then
   transport bounded typed outputs plus checkpoint records into the original
   runtime. Validate schema, exact params/offsets, checkpoint positions and budgets
   before one entry/cache commit. Retain original BarStore identity and held old
   outputs. Source/owner/entry generation must remain current; cancellation and
   cleanup complete before publication. Replacing the whole runtime is not an
   equivalent implementation of this contract.
3. **Pure native async resampling:** transfer owned typed source columns and a
   serializable UTC session plan (at most 4096 dates / 16384 segments), not arbitrary
   calendar callbacks. Return validated typed values and confirmation/source-range
   metadata without chart mutation. Account for source/result copies, job budget,
   deadline, cancellation and stale version explicitly.

Java restore source implementation and its exact cloud-test boundary are described
in [JAVA-WORKSPACE-RESTORE.md](JAVA-WORKSPACE-RESTORE.md). The uncompiled Swift
source/creator-lifetime contract is in [SWIFT-WORKSPACE-RESTORE.md](SWIFT-WORKSPACE-RESTORE.md).
Native entry-only params and native background resampling remain subsequent work. The current small slice is documented in
[NATIVE-WORKSPACES.md](NATIVE-WORKSPACES.md).

## Minimum future platform verification

When platform access is explicitly resumed, inspect installed toolchains and
actual free disk first. No Mac access, SDK installation or device run was done for
this Linux cycle.

- macOS: warnings-as-errors Swift/SwiftPM build and JavaScriptCore tests for reads,
  malformed documents, module bindings, no notifications, owning-thread and closed
  engine errors. Verify the generated bundle actually ships with the facade.
- iOS: use an already installed simulator to verify the same APIs with a mounted
  view, active gesture preservation and no redraw/revision caused by reads.
- Android: compile Java/JNI and AAR, then exercise debug and R8/Kotlin consumers on
  an existing emulator. Check error transport, static modules, handle accounting
  and allocator ledger after success/failure and engine close. Old AAR results are
  not evidence for new methods.
- Future async restore/params need cancellation, stale publication, view/listener
  lifetimes, repeated jobs and memory pressure tests on each actual runtime.
  Device responsiveness and long-run retained memory require separate measurement.

Disk planning is provisional, not an SDK installation-size claim: for an
**already installed** toolchain, start only after measuring at least 5 GiB free
headroom and set a 2 GiB project build/scratch growth cap, stopping before that cap
requires more space. Reuse existing SDK/runtime/cache assets; do not download new
ones implicitly. If tools are absent, obtain actual vendor package sizes and an
approved storage plan before any installation. These caps do not guarantee build
completion and do not describe current Mac free space.


The small Linux standalone QuickJS check (not included in this source distribution) now executes
workspace reads in the vendored engine, with bounded failure/cleanup tests. It
requires no SDK and does not cover the JNI, Java, Apple JSC or UI/runtime-host gaps.
