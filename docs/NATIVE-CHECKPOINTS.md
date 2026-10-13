# Native restore checkpoint storage (internal preparation)

This module is an internal building block for the upcoming isolated-runtime
workspace restore protocol. Current Swift/Java APIs do not perform full workspace
restore. Existing chart engines keep their existing checkpoint behavior until an
explicitly owned restore engine installs these maps.

## Record and ownership contracts

`NativeCheckpointMap(name, params, {budget, block:256})` provides the checkpoint
Map operations used by IndicatorEngine. Records are safe-number-codec JSON strings,
not retained decoded object graphs. `get` decodes an independent value each time;
there is no decoded cache or growing raw override map. NaN, infinities and signed
zero preserve the existing checkpoint codec meaning.

- Per record:262,144 bytes; shared `NativeCheckpointBudget`:33,554,432 bytes.
  **Both charge encoded UTF-16 string storage at two bytes per code unit**, not
  UTF-8 wire bytes. This is an explicit native storage policy, not the web codec's
  UTF-8 packet-byte policy. Keys, escapes and number tags are included.
- Before creating a record string, a strict plain-data walk bounds exact serialized
  character cost, depth and nodes. Accessors, sparse/extra array fields, hidden or
  symbol fields, reserved keys, executable values and malformed Unicode reject.
  The callback producing the original state is trusted and cannot be preempted or
  prevented from allocating its own large objects. A record-size policy is not RSS.
- `set` independently decodes and validates the state using the built-in/static
  module checkpoint contract before changing storage/accounting. Failures leave
  the previous record intact. Mutations to a validator's discarded private copy
  do not reach storage; arbitrary trusted callback side effects cannot be undone.
- A mutation epoch makes outer set/history validation fail if a validator reenters
  set/delete/clear/dispose. Cleanup cannot be followed by the old operation
  resurrecting a record. History validation requires exactly the block positions
  through `floor(length/block)*block`; empty history has no index0 record.
- `clear` releases accounting and remains reusable for reset/prepend. `dispose`
  permanently retires the map; get/set/history validation then reject. Disposal
  is idempotent and does not mutate previously returned decoded values or outputs.

`NativeCheckpointEntries` is an owned Map subclass for restored engines. Ordinary
Map reads, iteration, identity and `instanceof Map` work. It captures the owned
checkpoint map at insertion; replacement/deletion/clear retires that captured map
exactly once. No user validator or public cleanup override runs during retirement.
Global private owner tokens reject one native checkpoint map being owned by two
registries or two IDs. Same-ID replacement retaining the same map preserves it.
The constructor stages up to128 input pairs, selects the final value for duplicate
IDs, and validates the entire final ownership set before adopting anything. Failed
construction leaves all input maps and accounting with their callers.

Install native checkpoints **before** inserting an entry, or explicitly reinsert
that same entry after attaching its map. Directly replacing an internal entry's
checkpoint field is not an ownership-transfer API. Entry retirement releases its
originally captured map, not an arbitrary later field or getter.

The integration is intentionally scoped: an existing core add/params operation
may subsequently replace a restored entry with its normal raw checkpoint Map.
The old native ledger is released, but the replacement is not silently encoded
inside an otherwise callback-free atomic commit. This policy bounds restoration
and the retained native-map entries, not the entire chart for its lifetime. A
future native async-params path needs its own consistent admission policy.

## Verification

Focused Node tests cover exact ASCII/escape/Unicode boundaries, actual aggregate
32MiB admission, failure atomicity, discarded validator metadata, reentry,
constructor/global ownership and retirement. All33built-in indicators are compared
with fresh calculation after initial data, update, append, correction, reset and
custom checkpoint-block cases. Held output arrays remain unchanged after retirement.

`npm run check:quickjs:checkpoints` compiles the existing vendored engine and runs
46 assertions in real standalone Linux QuickJS: number/Unicode storage, exact byte
bounds, reentry, registry ownership, retirement and EMA/RSI/Bollinger fresh-oracle
parity. Independent case/scenario/count and allocator cleanup gates apply. This
is not Java/JNI, Swift/JSC, native UI, SDK or device verification.
