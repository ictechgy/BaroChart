import {BarStore,RangeIndex,FIELDS,validateBar} from './data.mjs';
import {RESOURCE_LIMITS} from './contracts.mjs';
import {exclusiveStoreOwners} from './store-owners.mjs';
import {ownedCheckpointClear,NativeCheckpointEntries} from './native-checkpoints.mjs';
import {assertDataIngestionIdle} from './ingestion.mjs';
const COMPACTION_MAX_PEAK=192*RESOURCE_LIMITS.maxBars, compactionMapEntries=Map.prototype.entries;
const compactionTyped=Object.getPrototypeOf(Float64Array.prototype),compactionTypedLength=Object.getOwnPropertyDescriptor(compactionTyped,'length').get,compactionTypedBuffer=Object.getOwnPropertyDescriptor(compactionTyped,'buffer').get,compactionBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
function compactionStale(){const e=new Error('Compaction owner or source changed');e.name='StaleSourceError';throw e;}
function compactionRecord(value,keys,label){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain data compactionRecord');const result={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!keys.includes(key)||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data properties');result[key]=d.value;}return result;}
// Internal public objects must retain their ordinary own-data shape. Accessors,
// substituted maps and arbitrary proxies are not supported compaction owners.
function compactionCapture(object,keys,guards,writes=[]){const result={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(object,key);if(d&&!Object.hasOwn(d,'value')||writes.includes(key)&&(d?!d.writable:!Object.isExtensible(object)))throw new TypeError('Compaction owner own writable data required');result[key]=d?.value;guards.push(()=>{const next=Object.getOwnPropertyDescriptor(object,key);if(Boolean(next)!==Boolean(d)||next&&(!Object.hasOwn(next,'value')||!Object.is(next.value,d.value)||next.writable!==d.writable||next.configurable!==d.configurable))compactionStale();});}return result;}
function compactionRows(array,guards){if(!Array.isArray(array)||Object.getPrototypeOf(array)!==Array.prototype)throw new TypeError('Compaction ordinary array required');const length=Object.getOwnPropertyDescriptor(array,'length').value,copy=[];guards.push(()=>{if(Object.getOwnPropertyDescriptor(array,'length').value!==length)compactionStale();});for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(array,String(i));if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Compaction dense own data array');copy.push(d.value);guards.push(()=>{if(Object.getOwnPropertyDescriptor(array,String(i))?.value!==d.value)compactionStale();});}return copy;}
// Queue preservation validates positional meaning, not future drain budgets or
// intermediate volume arithmetic. Never call the overridable prefix()/stats().
function compactionPending(ingestion,source,refs,removed,guards){
 const q=compactionCapture(ingestion,['sourceVersion','head','count','capacity','columns','kinds','nextSequence','firstPendingSequence','policy','counters','lastError'],guards);
 if(q.sourceVersion!==source.version)throw new Error('Compaction pending source version changed');
 if(!Number.isSafeInteger(q.capacity)||q.capacity<1||q.capacity>4096||!Number.isSafeInteger(q.count)||q.count<0||q.count>q.capacity||!Number.isSafeInteger(q.head)||q.head<0||q.head>=q.capacity)throw new TypeError('Compaction pending ring bounds');
 const policyKeys=['streamId','generation','firstSequence','maxQueuedEvents','maxQueuedBytes','maxBatchEvents','maxStoredBars','maxStoreBytes'],counterKeys=['accepted','applied','cancelled','rejectedPackets','rejectedEvents','failedDrains','peakPendingEvents','peakPendingBytes','lastAppliedSequence','lastCancelledSequence'];
 compactionRecord(q.policy,policyKeys,'Compaction ingestion policy');compactionCapture(q.policy,policyKeys,guards);
 compactionRecord(q.counters,counterKeys,'Compaction ingestion counters');compactionCapture(q.counters,counterKeys,guards);
 const columns=compactionCapture(q.columns,FIELDS,guards);
 for(const key of FIELDS){const a=columns[key];if(!(a instanceof Float64Array)||compactionTypedLength.call(a)!==q.capacity)throw new TypeError('Compaction pending Float64 columns');compactionBufferLength.call(compactionTypedBuffer.call(a));}
 if(!(q.kinds instanceof Uint8Array)||compactionTypedLength.call(q.kinds)!==q.capacity)throw new TypeError('Compaction pending kind column');compactionBufferLength.call(compactionTypedBuffer.call(q.kinds));
 // At most 4096 * 49 extra typed bytes, independent of store capacity. This
 // owned FIFO copy also checks that later owner inspection did not alter it.
 const snapshot=Object.fromEntries(FIELDS.map(key=>[key,new Float64Array(q.count)])),kinds=new Uint8Array(q.count),appended=new Set(),bar={};let tail=refs.time[source.length-1];
 for(let i=0;i<q.count;i++){
  const at=(q.head+i)%q.capacity;for(const key of FIELDS)bar[key]=snapshot[key][i]=columns[key][at];const kind=kinds[i]=q.kinds[at];validateBar(bar);
  if(kind===0){if(!(bar.time>tail))throw new Error('Compaction pending append must follow virtual tail');tail=bar.time;appended.add(bar.time);}
  else if(kind===1){if(bar.time!==tail)throw new Error('Compaction pending update must match virtual tail');}
  else if(kind===2){let low=removed,high=source.length;while(low<high){const mid=low+Math.floor((high-low)/2);if(refs.time[mid]<bar.time)low=mid+1;else high=mid;}if(!appended.has(bar.time)&&(low===source.length||refs.time[low]!==bar.time))throw new Error('Compaction pending correction requires retained timestamp');}
  else throw new TypeError('Compaction pending event kind');
 }
 guards.push(()=>{for(let i=0;i<q.count;i++){const at=(q.head+i)%q.capacity;if(q.kinds[at]!==kinds[i])compactionStale();for(const key of FIELDS)if(!Object.is(columns[key][at],snapshot[key][i]))compactionStale();}});
}
export function compactData(api,options){
 const guards=[],a=compactionCapture(api,['model','controller'],guards),model=a.model;
 if(!model)throw new Error('Chart disposed');
 const m=compactionCapture(model,['store','indicators','series','panels','axes','drawings','view','follow','crosshair','dataIngestion','disposed'],guards,['view','crosshair']);
 if(m.disposed)throw new Error('Chart disposed');
 const store=m.store,s=compactionCapture(store,['columns','index','length','capacity','maxBars','version','timeVersion'],guards,['columns','index','length','capacity','version','timeVersion']);
 const refs=compactionCapture(s.columns,FIELDS,guards);
 if(!(store instanceof BarStore))throw new TypeError('Compaction BarStore required');
 const o=compactionRecord(options,['keepLastBars','studyHistory','maxPeakStoreBytes','pendingData'],'Compaction options'),keep=o.keepLastBars,limit=o.maxPeakStoreBytes??COMPACTION_MAX_PEAK;
 if(!Number.isSafeInteger(keep)||keep<1||keep>RESOURCE_LIMITS.maxBars||o.studyHistory!=='restart')throw new RangeError('Positive keepLastBars and studyHistory restart required');
 if(o.pendingData!==undefined&&o.pendingData!=='preserve-retained'&&o.pendingData!=='reject')throw new TypeError('Compaction pendingData policy');
 if(!Number.isSafeInteger(limit)||limit<0||limit>COMPACTION_MAX_PEAK)throw new RangeError('Compaction source peak byte limit');
 if(!s.length)throw new RangeError('Cannot compact an empty store');
 for(const key of FIELDS){const source=refs[key];if(!(source instanceof Float64Array)||compactionTypedLength.call(source)!==s.capacity)throw new TypeError('Compaction owned Float64 columns');compactionBufferLength.call(compactionTypedBuffer.call(source));}
 const current=()=>{for(const check of guards)check();};current();
 const receipt={removed:0,length:s.length,capacity:s.capacity,bytes:96*s.capacity,previousBytes:96*s.capacity,peakSourceBytes:96*s.capacity,firstRetainedTime:refs.time[0],version:s.version,timeVersion:s.timeVersion,studyHistory:'restart',invalidationFailed:false};
 if(keep>=s.length)return receipt;
 const engine=m.indicators,e=compactionCapture(engine,['store','entries'],guards);if(e.store!==store||!exclusiveStoreOwners(store,model,engine))throw new Error('Compaction requires one exclusive live model and indicator engine');
 const ownerCheck=()=>{current();if(!exclusiveStoreOwners(store,model,engine))compactionStale();assertDataIngestionIdle(model);};
 assertDataIngestionIdle(model);
 const drawing=compactionCapture(m.drawings,['transaction'],guards);if(drawing.transaction)throw new Error('Compaction during drawing transaction');
 if(a.controller){const control=compactionCapture(a.controller,['model','gesture'],guards);if(control.model!==model||control.gesture)throw new Error('Compaction during interaction gesture');}
 const series=compactionRows(m.series,guards).map(row=>({row,state:compactionCapture(row,['values','offset','visible','rangeIndex','revision','dirtyFrom'],guards,['rangeIndex','revision','dirtyFrom'])}));
 if(series.some(({state})=>state.values!==undefined&&state.values!==null))throw new Error('Compaction requires host realignment of external values');
 for(const p of compactionRows(m.panels,guards)){const state=compactionCapture(p,['scale','base'],guards);if(state.scale==='percent'&&state.base===undefined)throw new Error('Compaction percent panel requires an explicit base');}
 compactionRows(m.axes,guards);
 const view=compactionCapture(m.view,['from','to'],guards);if(!Number.isFinite(view.from)||!Number.isFinite(view.to)||view.to<=view.from)throw new TypeError('Compaction visible range');
 let ingestion;
 if(m.dataIngestion){ingestion=compactionCapture(m.dataIngestion,['model','store','sourceVersion','policy','paused','count','draining','leased','closed','epoch'],guards,['sourceVersion','epoch']);if(ingestion.model!==model||ingestion.store!==store||ingestion.closed||!ingestion.paused||(ingestion.count&&o.pendingData!=='preserve-retained')||ingestion.draining||ingestion.leased)throw new Error('Compaction requires paused empty idle ingestion unless preserving retained pending data');if(o.pendingData==='preserve-retained')compactionPending(m.dataIngestion,s,refs,s.length-keep,guards);}
 if(![Map.prototype,NativeCheckpointEntries.prototype].includes(Object.getPrototypeOf(e.entries))||Reflect.ownKeys(e.entries).length)throw new TypeError('Compaction ordinary owned indicator entries');
 const entries=[...compactionMapEntries.call(e.entries)],entrySize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get;
 guards.push(()=>{if(entrySize.call(e.entries)!==entries.length)compactionStale();for(const [id,row] of entries)if(Map.prototype.get.call(e.entries,id)!==row)compactionStale();});
 const plans=entries.map(([,row])=>{if(Object.getPrototypeOf(row)!==Object.prototype)throw new TypeError('Compaction plain indicator entry');const state=compactionCapture(row,['checkpoints','arrays','dirty','dirtyTo','invalidated','length','computedFrom','computedUntil','preparedVersion'],guards,['arrays','dirty','dirtyTo','invalidated','length','computedFrom','computedUntil','preparedVersion']);return {row,clear:ownedCheckpointClear(state.checkpoints),arrays:[]};});
 let capacity=16;while(capacity<keep)capacity*=2;const peak=96*(s.capacity+capacity);if(peak>limit)throw new RangeError('Compaction source peak byte budget');
 const removed=s.length-keep,columns={};
 for(const key of FIELDS){const source=refs[key];columns[key]=new Float64Array(capacity);for(let i=0;i<keep;i++)columns[key][i]=source[removed+i];}
 const bar={};let previous=-Infinity;for(let i=0;i<keep;i++){for(const key of FIELDS)bar[key]=columns[key][i];validateBar(bar,previous);previous=bar.time;}
 const index=new RangeIndex(keep,columns.low,columns.high,columns.volume,capacity),span=view.to-view.from,forward=Math.max(0,...series.filter(({state})=>state.visible!==false).map(({state})=>state.offset??0));
 const end=keep+forward-.5,from=m.follow?end-span:Math.max(-.5,Math.min(end-span,view.from-removed)),nextView={from,to:from+span};
 Object.assign(receipt,{removed,length:keep,capacity,bytes:96*capacity,peakSourceBytes:peak,firstRetainedTime:columns.time[0],version:s.version+1,timeVersion:s.timeVersion+1});
 ownerCheck();
 // No user callback from here until the complete source/cache/view/ledger state
 // has been installed. Native clear returns private ledger bytes without decode.
 for(const plan of plans){plan.clear();Object.assign(plan.row,{arrays:plan.arrays,dirty:0,dirtyTo:keep,invalidated:true,length:0,computedFrom:0,computedUntil:0,preparedVersion:undefined});}
 for(const {row} of series){row.rangeIndex=null;row.revision=undefined;row.dirtyFrom=0;}
 store.columns=columns;store.index=index;store.length=keep;store.capacity=capacity;model.view=nextView;model.crosshair=null;
 if(ingestion){m.dataIngestion.sourceVersion=receipt.version;m.dataIngestion.epoch=ingestion.epoch+1;}
 BarStore.prototype.changed.call(store,0,'compact',{removed,studyHistory:'restart'});
 // Store listeners have their existing bounded error channel. New API keeps a
 // successful committed receipt even if the host invalidation observer throws.
 try{api.invalidate();}catch{receipt.invalidationFailed=true;}
 return receipt;
}
