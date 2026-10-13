// Package-private lifetime ledger. Tokens never retain models or engines.
// An undisposed owner conservatively blocks in-place history compaction.
const storeOwnerLedgers=new WeakMap(),storeOwnerRecords=new WeakMap();
export function registerStoreOwner(owner,store,kind){const token={kind};let tokens=storeOwnerLedgers.get(store);if(!tokens)storeOwnerLedgers.set(store,tokens=new Set());tokens.add(token);storeOwnerRecords.set(owner,{store,token});}
export function unregisterStoreOwner(owner){const row=storeOwnerRecords.get(owner);if(!row)return;storeOwnerLedgers.get(row.store)?.delete(row.token);storeOwnerRecords.delete(owner);}
export function exclusiveStoreOwners(store,model,engine){const m=storeOwnerRecords.get(model),e=storeOwnerRecords.get(engine),tokens=storeOwnerLedgers.get(store);return m?.store===store&&e?.store===store&&m.token.kind==='model'&&e.token.kind==='engine'&&tokens?.size===2&&tokens.has(m.token)&&tokens.has(e.token);}
