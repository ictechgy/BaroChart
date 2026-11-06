# Rust core review fixes — 2026-11-06

The six confirmed follow-up defects have regression coverage and fixes. The
JavaScript default and existing native Async/Prepare contracts are retained.
Unverified claims from external reviews were not implemented as fixes.

| Boundary | Corrected behavior | Regression evidence |
| --- | --- | --- |
| Workspace/UI symbol | Migration retains the canonical workspace symbol and rejects a different UI symbol before target publication. | Currency and adjustment mismatch; unchanged source and unpublished target; exact and nullish-symbol success cases. |
| Migration controls | Migration requires valid drawing magnet and crosshair snap state. Legacy Async/Prepare imports keep their optional fields. | Each missing field, both missing, invalid modes, normal round trip, and legacy imports. |
| Portable columns | All six genuine Float64Array references, lengths, metadata bounds, and aggregate bytes are validated before any owned copy. Copies use fixed-length views. | First/last mismatch causes zero column allocations; malformed bounds, shadowed accessors, resizable views, signed zero, and NaN payload bits. |
| Candidate admission | One cancellation/deadline covers the view flush, queue barrier, and workspace capture before the coordinator receives the remaining budget. | Already-aborted, pending-flush abort/timeout, pending workspace save, late completion, source preservation, and successful subsequent promotion. |
| Runtime close | An open in-flight runtime rejects reentrant close with BUSY before changing ownership or lifecycle state. | Math/Intl callbacks preserve the engine; a later normal close releases the host exactly once. |
| Worker replies | Falsy/malformed packets and non-boolean write receipts reject and quarantine the actor. Valid boolean receipts remain accepted. | Unit cases plus actual dedicated-Worker structured-clone responses and cleanup. |

The additional F64 input-boundary check rejects counts above the advertised
262,144-element transfer limit and lengths above `isize::MAX` before forming a
Rust slice. Its regression uses an approximately 2 MiB input; no multi-gigabyte
allocation is needed. In-bound requests still reach the core, and rejection
leaves the engine usable.

The strict migration symbol remains covered by an accounted `MemoryGroup`.
The implementation reuses the existing validators and preserves ingestion and
the source/candidate publication boundary. It does not loosen expected values,
stale-owner checks, error handling, or size-report freshness.

## Current-source validation

- Local Node suite: 6,166 passing cases plus 10 separately run native-size
  cases, with no skips. The focused host suite passes 112 cases.
- Rust workspace: 645 passed, 0 failed, 2 unchanged ignored decoder stress
  cases. Formatting, clippy, banned-pattern checks, generated header, and C11
  compile/link/call checks pass.
- Actual WASM protocols: 37 cases pass, including the new migration and F64
  boundary cases. Production-WASM Math and Intl reentrancy probes each retain
  ownership and release their host once after a normal close.
- Chrome 156: the main demo, both backend directions, all 16 drawing tools,
  protected layout/drawing history, files, streaming, renderer replacement,
  and bootstrap failures pass. Gated real-view admission tests prove that
  abort/timeout settle before a delayed flush, late flush creates no candidate,
  and the next prepare succeeds.

Production WASM source fingerprint:
`eb01ce6390b38c116c987568d25d0ff94f3ac65ca21ee8f7dd9712bbda874af1`.
The 3,324,243-byte asset SHA-256 is
`be3bb10e73d67905383bcb764cf01d35e148e950003eed8b3418355c81b4190b`.
The native input fingerprint is
`506da36a8f6713e8482a4e4f4ef0f4669303df5007cc0fc11cbf0283d621c091`.

The complete fresh native matrix records shipping dual SDK sizes of
4,452,088 bytes for arm64 and 5,097,128 bytes for x86_64, both within the
owner-approved 5 MiB per-ABI budget. See the
[size report](rust-core-size.json). The
[web comparison](web-rust-wasm.md) records the measured asset, methodology,
and environment rather than relabeling older results.

## Boundaries

The low-level unsafe ABI still requires non-aliasing caller buffers. The
review's out-of-contract alias probe and bounded temporary-allocation cleanup
are separate hardening candidates, not additional confirmed P2 fixes.
Safari/Firefox, physical touch, and assistive-technology coverage are not
implied. Native M7 physical Android performance/soak and manual VoiceOver/
TalkBack gates remain separate; JavaScript stays the default.
