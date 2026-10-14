// Native-only bounded checkpoint records. No TextEncoder, timers or DOM APIs.
import {safeCheckpointStringify,safeCheckpointParse,validateCheckpointState} from './checkpoint-validation.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
export const NATIVE_CHECKPOINT_RECORD_BYTES=262144,NATIVE_CHECKPOINT_TOTAL_BYTES=33554432;
const nativeCheckpointMaxIndex=4194304;
// Count the exact UTF-16 JSON storage charge before building a record string.
// Snapshot callbacks themselves are trusted and cannot be made allocation-free.
export function nativeCheckpointFootprint(state){let chars=0,nodes=0;const ancestors=new Set(),add=n=>{chars+=n;if(chars*2>NATIVE_CHECKPOINT_RECORD_BYTES)throw new RangeError('Native checkpoint record byte limit');};
 const string=value=>{add(2);for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n===34||n===92||[8,9,10,12,13].includes(n))add(2);else if(n<32)add(6);else if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new TypeError('Native checkpoint Unicode');add(2);}else if(n>=0xdc00&&n<=0xdfff)throw new TypeError('Native checkpoint Unicode');else add(1);}};
 const walk=(v,depth)=>{if(++nodes>250000||depth>32)throw new RangeError('Native checkpoint state limit');if(v===null){add(4);return;}if(typeof v==='string'){string(v);return;}if(typeof v==='boolean'){add(v?4:5);return;}if(typeof v==='number'){add(Number.isFinite(v)&&!Object.is(v,-0)?String(v).length:JSON.stringify({$asterNumber:Object.is(v,-0)?'-0':String(v)}).length);return;}if(!v||typeof v!=='object'||ancestors.has(v))throw new TypeError('Native checkpoint plain state');const array=Array.isArray(v),proto=Object.getPrototypeOf(v);if(proto!==(array?Array.prototype:Object.prototype)&&!(proto===null&&!array))throw new TypeError('Native checkpoint plain state');const length=array?Object.getOwnPropertyDescriptor(v,'length')?.value:0;if(array&&(!Number.isSafeInteger(length)||length<0||length>65535))throw new RangeError('Native checkpoint record byte limit');const keys=Reflect.ownKeys(v);if(array&&keys.length!==length+1)throw new TypeError('Native checkpoint array shape');ancestors.add(v);add(2);let count=0;for(const key of keys){if(array&&key==='length')continue;if(typeof key!=='string'||['__proto__','prototype','constructor','toJSON','$asterNumber'].includes(key))throw new TypeError('Native checkpoint reserved key');const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value')||array&&key!==String(count))throw new TypeError('Native checkpoint own data fields');if(count++)add(1);if(!array){string(key);add(1);}walk(d.value,depth+1);}ancestors.delete(v);};
 walk(state,0);return {encodedBytes:chars*2,nodes,logicalBytes:chars*2+nodes*32};
}
function nativeCheckpointText(state){const measured=nativeCheckpointFootprint(state),text=safeCheckpointStringify(state);if(text.length*2!==measured.encodedBytes)throw new TypeError('Native checkpoint serialization changed');return text;}

const nativeCheckpointLedgers=new WeakMap(),nativeCheckpointMaps=new WeakSet(),nativeCheckpointRetired=new WeakSet(),nativeCheckpointEntryOwners=new WeakMap();
function nativeCheckpointCharge(budget,oldBytes,newBytes){const ledger=nativeCheckpointLedgers.get(budget);if(!ledger||!Number.isSafeInteger(oldBytes)||!Number.isSafeInteger(newBytes)||oldBytes<0||newBytes<0||oldBytes>ledger.used||ledger.used-oldBytes>ledger.limit-newBytes)throw new RangeError('Native checkpoint total byte limit');ledger.used+=newBytes-oldBytes;}
export class NativeCheckpointBudget {
 constructor(maxBytes=NATIVE_CHECKPOINT_TOTAL_BYTES){if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>NATIVE_CHECKPOINT_TOTAL_BYTES)throw new RangeError('Native checkpoint total byte limit');nativeCheckpointLedgers.set(this,{used:0,limit:maxBytes});}
 get usedBytes(){return nativeCheckpointLedgers.get(this).used;}get maxBytes(){return nativeCheckpointLedgers.get(this).limit;}
}
export class NativeCheckpointMap {
 #records=new Map();#bytes=0;#name;#params;#budget;#block;#epoch=0;#closed=false;
 constructor(name,params,{budget=new NativeCheckpointBudget(),block=256}={}){if(typeof name!=='string'||!name||!(budget instanceof NativeCheckpointBudget)||!nativeCheckpointLedgers.has(budget)||!Number.isSafeInteger(block)||block<1||block>nativeCheckpointMaxIndex)throw new TypeError('Native checkpoint context');validateIndicatorParams(params);this.#name=name;this.#params=Object.freeze({...params});this.#budget=budget;this.#block=block;nativeCheckpointMaps.add(this);}
 #check(epoch=this.#epoch){if(this.#closed)throw new Error('Native checkpoint disposed');if(epoch!==this.#epoch){const error=new Error('Native checkpoint changed during validation');error.name='StaleCheckpointError';throw error;}}
 get size(){return this.#records.size;}get encodedBytes(){return this.#bytes;}
 has(index){return this.#records.has(index);}
 get(index){this.#check();const text=this.#records.get(index);return text===undefined?undefined:safeCheckpointParse(text);}
 set(index,state){this.#check();const epoch=this.#epoch;if(!Number.isSafeInteger(index)||index<0||index>nativeCheckpointMaxIndex||index%this.#block)throw new RangeError('Native checkpoint index');const text=nativeCheckpointText(state),owned=safeCheckpointParse(text);validateCheckpointState(this.#name,this.#params,owned,index);if(nativeCheckpointText(owned)!==text)throw new TypeError('Native checkpoint validator mutated state');this.#check(epoch);const oldBytes=(this.#records.get(index)?.length??0)*2,newBytes=text.length*2;nativeCheckpointCharge(this.#budget,oldBytes,newBytes);this.#records.set(index,text);this.#bytes+=newBytes-oldBytes;this.#epoch++;return this;}
 delete(index){this.#epoch++;const text=this.#records.get(index);if(text===undefined)return false;const bytes=text.length*2;nativeCheckpointCharge(this.#budget,bytes,0);this.#records.delete(index);this.#bytes-=bytes;return true;}
 #empty(){this.#epoch++;nativeCheckpointCharge(this.#budget,this.#bytes,0);this.#records.clear();this.#bytes=0;}
 clear(){this.#empty();}
 dispose(){if(this.#closed)return;this.#closed=true;nativeCheckpointRetired.add(this);this.#empty();}
 *keys(){yield* [...this.#records.keys()].sort((a,b)=>a-b);}
 *[Symbol.iterator](){for(const index of this.keys())yield [index,this.get(index)];}
 validateHistory(length){this.#check();const epoch=this.#epoch;if(!Number.isSafeInteger(length)||length<0||length>nativeCheckpointMaxIndex)throw new RangeError('Native checkpoint history length');const expected=length===0?0:Math.floor(length/this.#block)+1;if(this.size!==expected)throw new TypeError('Native checkpoint history count');let i=0;for(const index of this.keys()){if(index!==i++*this.#block)throw new TypeError('Native checkpoint history boundary');const text=this.#records.get(index),state=safeCheckpointParse(text);validateCheckpointState(this.#name,this.#params,state,index);if(nativeCheckpointText(state)!==text)throw new TypeError('Native checkpoint validator mutated state');this.#check(epoch);}this.#check(epoch);return this;}
}

// Only restored engines install this owner map. Retirement never mutates held
// output vectors and never invokes a user-controlled cleanup callback.
const nativeCheckpointDispose=NativeCheckpointMap.prototype.dispose;
function nativeEntryCheckpoints(entry){const value=entry&&Object.getOwnPropertyDescriptor(entry,'checkpoints')?.value;return nativeCheckpointMaps.has(value)?value:null;}
export class NativeCheckpointEntries extends Map {
 #byId=new Map();#token={};
 constructor(entries){super();if(entries!==undefined){const staged=new Map();let count=0;for(const [id,entry] of entries){if(++count>128)throw new RangeError('Native checkpoint entry count');staged.set(id,entry);}const rows=[...staged].map(([id,entry])=>[id,entry,nativeEntryCheckpoints(entry)]),seen=new Set();for(const [, ,checkpoints] of rows){if(checkpoints&&(seen.has(checkpoints)||nativeCheckpointRetired.has(checkpoints)||nativeCheckpointEntryOwners.has(checkpoints)))throw new TypeError('Native checkpoint entry ownership');if(checkpoints)seen.add(checkpoints);}for(const [id,entry,checkpoints] of rows)this.#install(id,entry,checkpoints);}}
 #install(id,entry,checkpoints){if(checkpoints){this.#byId.set(id,checkpoints);nativeCheckpointEntryOwners.set(checkpoints,{owner:this.#token,id});}else this.#byId.delete(id);Map.prototype.set.call(this,id,entry);}
 set(id,entry){const next=nativeEntryCheckpoints(entry),previous=this.#byId.get(id),owner=next?nativeCheckpointEntryOwners.get(next):null;if(next&&(nativeCheckpointRetired.has(next)||owner&&(owner.owner!==this.#token||!(owner.id===id||Object.is(owner.id,id)))))throw new TypeError('Native checkpoint entry ownership');if(previous&&previous!==next){nativeCheckpointDispose.call(previous);nativeCheckpointEntryOwners.delete(previous);}this.#install(id,entry,next);return this;}
 delete(id){const previous=this.#byId.get(id),deleted=Map.prototype.delete.call(this,id);if(previous){nativeCheckpointDispose.call(previous);this.#byId.delete(id);nativeCheckpointEntryOwners.delete(previous);}return deleted;}
 clear(){for(const checkpoints of this.#byId.values()){nativeCheckpointDispose.call(checkpoints);nativeCheckpointEntryOwners.delete(checkpoints);}this.#byId.clear();Map.prototype.clear.call(this);}
}

// Compaction keeps the bounded map/owner binding but retires its old records.
// Both validation and commit use private brands, never application methods.
const nativeCheckpointClear=NativeCheckpointMap.prototype.clear,ordinaryCheckpointClear=Map.prototype.clear,ordinaryCheckpointHas=Map.prototype.has;
export function ownedCheckpointClear(map){
 if(nativeCheckpointMaps.has(map)){if(nativeCheckpointRetired.has(map)||Object.getPrototypeOf(map)!==NativeCheckpointMap.prototype||Reflect.ownKeys(map).length)throw new TypeError('Compaction requires an active unmodified checkpoint map');return ()=>nativeCheckpointClear.call(map);}
 if(Object.getPrototypeOf(map)!==Map.prototype||Reflect.ownKeys(map).length)throw new TypeError('Compaction requires an unmodified checkpoint Map');
 ordinaryCheckpointHas.call(map,0);return ()=>ordinaryCheckpointClear.call(map);
}

// Entry-only native publication can preserve an ordinary entries Map identity.
// The registry is keyed by that Map, never retained from a caller-held entry.
// Direct replacement/mutation of engine.entries or Map intrinsics is unsupported.
const nativeAdoptedOwners=new WeakMap(),nativeMapGet=Map.prototype.get,nativeMapSet=Map.prototype.set,nativeEntriesSet=NativeCheckpointEntries.prototype.set;
export function retireNativeEntryIfReplaced(entries,id){
 const owner=nativeAdoptedOwners.get(entries),row=owner?.rows.get(id);if(!row||nativeMapGet.call(entries,id)===row.entry)return;
 owner.rows.delete(id);nativeCheckpointEntryOwners.delete(row.checkpoints);nativeCheckpointDispose.call(row.checkpoints);
}
export function retireNativeEntriesAfterClear(entries){
 const owner=nativeAdoptedOwners.get(entries);if(!owner)return;for(const [id]of owner.rows)retireNativeEntryIfReplaced(entries,id);
}
export function prepareNativeEntryCommit(entries,id,previous,entry){
 const proto=Object.getPrototypeOf(entries);if(![Map.prototype,NativeCheckpointEntries.prototype].includes(proto)||Reflect.ownKeys(entries).length||nativeMapGet.call(entries,id)!==previous)throw new TypeError('Native params entry owner');
 const checkpoints=nativeEntryCheckpoints(entry);if(!checkpoints||nativeCheckpointRetired.has(checkpoints)||nativeCheckpointEntryOwners.has(checkpoints)||Object.getPrototypeOf(checkpoints)!==NativeCheckpointMap.prototype||Reflect.ownKeys(checkpoints).length)throw new TypeError('Native params checkpoint ownership');
 let owner=nativeAdoptedOwners.get(entries);if(proto===Map.prototype&&!owner){owner={token:{},rows:new Map()};nativeAdoptedOwners.set(entries,owner);}let used=false;
 return ()=>{if(used||nativeEntryCheckpoints(entry)!==checkpoints||nativeMapGet.call(entries,id)!==previous||nativeCheckpointRetired.has(checkpoints)||nativeCheckpointEntryOwners.has(checkpoints))throw new Error('Native params entry commit stale');used=true;
  if(proto===NativeCheckpointEntries.prototype){nativeEntriesSet.call(entries,id,entry);return;}
  nativeMapSet.call(entries,id,entry);retireNativeEntryIfReplaced(entries,id);owner.rows.set(id,{entry,checkpoints});nativeCheckpointEntryOwners.set(checkpoints,{owner:owner.token,id});
 };
}
