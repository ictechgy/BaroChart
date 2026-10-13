import {BarStore,RangeIndex} from '../core/data.mjs';
import {snapshotIngestionEvents,dataIngestionBatchLimits} from '../core/ingestion.mjs';
import {BlockRangeIndex} from '../core/block-index.mjs';
import {ChartModel} from '../core/model.mjs';
import {resolveIndicatorFactory,requirePortableFactory} from '../core/indicators.mjs';
import {indicatorModule,validateIndicatorModuleBinding} from '../core/indicator-modules.mjs';
import {validateIndicatorParams} from '../core/indicator-params.mjs';
import {RESOURCE_LIMITS,sizeLimit,identifier,optionRecord,AXIS_KEYS,PANEL_KEYS,SERIES_KEYS} from '../core/contracts.mjs';
import {encodeCheckpoints,LazyCheckpoints} from './checkpoint-codec.mjs';
const seriesKeys=SERIES_KEYS;
const optionKeys=['panels','axes','series','theme','precision','axisWidth','visibleBars','indicators'];
const pick=(object,keys)=>Object.fromEntries(keys.filter(k=>object[k]!==undefined).map(k=>[k,object[k]]));
const preparedPackets=new WeakMap(),PROTOCOL_VERSION=1;
export function requestOptionsSnapshot(options={}){
 optionRecord(options,optionKeys,'Worker model options');const copy={...options};
 if(options.panels)copy.panels=options.panels.map(p=>{optionRecord(p,PANEL_KEYS,'Worker panel');if(p.formatter!==undefined)throw new TypeError('Worker unsupported panel formatter callback');return {...p,...(p.range?{range:[...p.range]}:{})};});
 copy.axes=(options.axes??[]).map(a=>{optionRecord(a,AXIS_KEYS,'Worker axis');if(a.formatter!==undefined)throw new TypeError('Worker unsupported axis formatter callback');return {...a,...(a.range?{range:[...a.range]}:{})};});
 if(options.theme)copy.theme={...options.theme};
 copy.series=(options.series??[]).map(s=>({...s}));
 copy.indicators=(options.indicators??[]).map(e=>{optionRecord(e,['id','name','params','module'],'Worker indicator');const params=validateIndicatorParams(e.params===undefined?{}:e.params),factory=resolveIndicatorFactory(e.name),module=requirePortableFactory(e.name,factory);if(e.module!==undefined)validateIndicatorModuleBinding(e.name,e.module);return {id:e.id,name:e.name,params:{...params},...(module?{module}:{})};});
 return copy;
}
export function modelRequest(model){
 if(model.panels.some(p=>p.formatter!==undefined)||(model.axes??[]).some(a=>a.formatter!==undefined))throw new TypeError('Worker unsupported formatter callback');
 const indicators=[...model.indicators.entries].map(([id,e])=>{const module=requirePortableFactory(e.name,model.indicators.registry.get(e.name));validateIndicatorParams(e.params);return {id,name:e.name,params:{...e.params},...(module?{module}:{})};});
 return {panels:model.panels.map(p=>pick(p,PANEL_KEYS.filter(k=>k!=='formatter'))),axes:(model.axes??[]).map(a=>pick(a,AXIS_KEYS.filter(k=>k!=='formatter'))),series:model.series.map(s=>pick(s,seriesKeys)),theme:{...model.theme},precision:model.precision,axisWidth:model.axisWidth,indicators};
}
const identities=new WeakMap();let serial=0;function identity(value){if(!value||typeof value!=='object'&&typeof value!=='function')return 0;if(!identities.has(value))identities.set(value,++serial);return identities.get(value);}
export function configurationKey(model){return JSON.stringify([[...model.indicators.entries].map(([id,e])=>[id,identity(e),e.name,e.params,identity(e.def.create),identity(model.indicators.registry.get(e.name))]),model.series.map(s=>[s.id,s.type,s.source,s.indicator,s.output,identity(s.values)]),model.seriesValuesRevision??0]);}
function treePacket(index){return {size:index.size,min:index.min,max:index.max,sum:index.sum,finiteCounts:index.finiteCounts===true};}
function restoreTree(packet){const tree=Object.create(RangeIndex.prototype);for(const key of ['size','min','max','sum','finiteCounts'])tree[key]=packet[key];return tree;}
export function packModel(model){
 // A prepared packet describes completed arrays, including hidden indicators.
 for(const id of model.indicators.entries.keys())model.indicators.get(id);
 const store=model.store,indices=[];for(const s of model.series)if(!['candles','ohlc'].includes(s.type)&&s.visible!==false){model.seriesData(s);const index=s.rangeIndex;indices.push({id:s.id,blocked:index instanceof BlockRangeIndex,finiteCounts:true,...(index instanceof BlockRangeIndex?{size:index.size,length:index.length,blockSize:index.blockSize,tree:treePacket(index.tree)}:{tree:treePacket(index)})});}
 return {protocolVersion:PROTOCOL_VERSION,view:{...model.view},follow:model.follow,store:{length:store.length,capacity:store.capacity,columns:store.columns,index:treePacket(store.index)},options:modelRequest(model),indicators:[...model.indicators.entries].map(([id,e])=>({id,name:e.name,params:{...e.params},...(indicatorModule(e.name)?{module:indicatorModule(e.name)}:{}),outputs:[...e.def.outputs],plotOffsets:{...e.def.plotOffsets},arrays:e.arrays,checkpoints:encodeCheckpoints(e.checkpoints),checkpointSize:model.indicators.checkpointSize,revision:e.revision,computedFrom:e.computedFrom??0,computedUntil:e.computedUntil??store.length,dirty:store.length,dirtyTo:0,invalidated:false,length:store.length})),indices};
}
export function transferBuffers(packet){const buffers=new Set();for(const v of Object.values(packet.store.columns))buffers.add(v.buffer);for(const v of ['min','max','sum'])if(packet.store.index[v])buffers.add(packet.store.index[v].buffer);for(const e of packet.indicators){for(const a of e.arrays)buffers.add(a.buffer);for(const a of Object.values(e.checkpoints))buffers.add(a.buffer);}for(const s of packet.options.series)if(s.values)buffers.add(s.values.buffer);for(const i of packet.indices)for(const k of ['min','max','sum'])if(i.tree[k])buffers.add(i.tree[k].buffer);return [...buffers];}
function sameRecord(a,b){if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)||Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));}
function requestedDefinitions(options){
 const list=options.indicators??[];if(!Array.isArray(list)||list.length>RESOURCE_LIMITS.maxIndicators)throw new TypeError('Requested indicator definitions');const definitions=new Map();
 for(const e of list){identifier(e.id,'Requested indicator id');identifier(e.name,'Requested indicator name');if(definitions.has(e.id))throw new TypeError('Duplicate requested indicator');const params=validateIndicatorParams(e.params===undefined?{}:e.params),factory=resolveIndicatorFactory(e.name);requirePortableFactory(e.name,factory);const module=validateIndicatorModuleBinding(e.name,e.module);definitions.set(e.id,{id:e.id,name:e.name,params:{...params},module,def:factory(params)});}
 return definitions;
}
function sameAxisValue(a,b){if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameAxisValue(a[k],b[k]));}
function normalizedAxes(options){const validator=Object.create(ChartModel.prototype);validator.panels=options.panels??[{id:'price'}];validator.axes=[];if(!Array.isArray(options.axes??[]))throw new TypeError('Prepared axes');for(const axis of options.axes??[]){optionRecord(axis,AXIS_KEYS,'Prepared axis');if(axis.formatter!==undefined)throw new TypeError('Worker unsupported axis formatter callback');validator.addAxis(axis);}return validator.axes.map(a=>pick(a,AXIS_KEYS.filter(k=>k!=='formatter')));}
function checkedAxesBinding(reply,expected){const wanted=normalizedAxes(expected),actual=normalizedAxes(reply);if(!sameAxisValue(wanted,actual))throw new TypeError('Prepared requested axis binding');}
function checkedDefinitions(packet,options){
 if(!packet||packet.protocolVersion!==PROTOCOL_VERSION||!Array.isArray(packet.indicators)||!packet.options||!Array.isArray(packet.options.indicators)||!Array.isArray(packet.options.series)||!Array.isArray(packet.indices))throw new TypeError('Prepared packet arrays/protocol');
 checkedAxesBinding(packet.options,options);
 const expected=requestedDefinitions(options);if(packet.indicators.length!==expected.size||packet.options.indicators.length!==expected.size)throw new TypeError('Prepared requested indicator count');
 const metadata=new Map();for(const e of packet.options.indicators){if(metadata.has(e.id))throw new TypeError('Prepared definition duplicate');metadata.set(e.id,e);}
 const found=new Set();for(const e of packet.indicators){const wanted=expected.get(e.id),copy=metadata.get(e.id);if(!wanted||found.has(e.id)||e.name!==wanted.name||!sameRecord(e.params,wanted.params)||!copy||copy.name!==wanted.name||!sameRecord(copy.params??{},wanted.params))throw new TypeError('Prepared requested indicator definition binding');found.add(e.id);validateIndicatorModuleBinding(e.name,e.module);validateIndicatorModuleBinding(copy.name,copy.module);
  if(!Array.isArray(e.outputs)||e.outputs.length!==wanted.def.outputs.length||e.outputs.some((k,i)=>k!==wanted.def.outputs[i])||!sameRecord(e.plotOffsets,wanted.def.plotOffsets??{}))throw new TypeError('Prepared output/plot offset binding');
 }
 const expectedSeries=options.series??[];if(!Array.isArray(expectedSeries)||expectedSeries.length!==packet.options.series.length||expectedSeries.length>RESOURCE_LIMITS.maxSeries)throw new TypeError('Prepared requested series count');const series=new Map();
 for(const s of expectedSeries){identifier(s.id,'Requested series id');if(series.has(s.id))throw new TypeError('Requested series duplicate');series.set(s.id,s);}
 const replies=new Map();for(const s of packet.options.series){const wanted=series.get(s.id);if(!wanted||replies.has(s.id))throw new TypeError('Prepared requested series binding');for(const key of ['type','panel','axisId','symbolId','label','source','indicator','output','visible'])if(s[key]!==wanted[key])throw new TypeError('Prepared series data binding');
  const def=wanted.indicator?expected.get(wanted.indicator)?.def:null,key=wanted.output??def?.outputs[0],offset=wanted.offset??(def?.plotOffsets&&Object.hasOwn(def.plotOffsets,key)?def.plotOffsets[key]:0);if(s.offset!==offset)throw new TypeError('Prepared series offset binding');
  if(wanted.values!==undefined&&(!(s.values instanceof Float64Array)||s.values.length!==packet.store?.length)||wanted.values===undefined&&s.values!==undefined)throw new TypeError('Prepared custom series binding');replies.set(s.id,s);
 }
 const cacheIds=new Set();for(const cache of packet.indices){const s=replies.get(cache.id);if(!s||cacheIds.has(cache.id)||['candles','ohlc'].includes(s.type)||s.visible===false)throw new TypeError('Prepared cache binding');cacheIds.add(cache.id);}
 for(const s of replies.values())if(!['candles','ohlc'].includes(s.type)&&s.visible!==false&&!cacheIds.has(s.id))throw new TypeError('Missing prepared series cache');
 return {expected,replies};
}
function completedMetadata(e,length,block){
 if(!Number.isSafeInteger(e.revision)||e.revision<0||!Number.isSafeInteger(e.computedFrom)||e.computedFrom<0||e.computedFrom>length||!Number.isSafeInteger(e.computedUntil)||e.computedUntil<e.computedFrom||e.computedUntil>length||e.length!==length||e.dirty!==length||e.dirtyTo!==0||e.invalidated!==false||e.checkpointSize!==block)throw new TypeError('Prepared completed indicator metadata');
}
function abortCheck(signal){if(signal?.aborted){const error=new Error('Calculation cancelled');error.name='AbortError';throw error;}}
function validationScheduler(custom){
 if(custom!==undefined){if(typeof custom!=='function')throw new TypeError('Validation yield function');return {yieldTask:custom,close(){}};}
 if(typeof globalThis.scheduler?.yield==='function')return {yieldTask:()=>globalThis.scheduler.yield(),close(){}};
 if(typeof MessageChannel==='function'){const channel=new MessageChannel(),pending=[];channel.port1.onmessage=()=>pending.shift()?.();return {yieldTask:()=>new Promise(resolve=>{pending.push(resolve);channel.port2.postMessage(0);}),close(){channel.port1.close();channel.port2.close();}};}
 return {yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0)),close(){}};
}
export async function validatePreparedPacketAsync(packet,expectedOptions,options={}){
 const expected=requestOptionsSnapshot(expectedOptions),bindings=checkedDefinitions(packet,expected),checkpoints=new Map(),countCaches=new Map(),length=packet.store?.length;sizeLimit(length,RESOURCE_LIMITS.maxBars,'Prepared data');let done=0,total=packet.indicators.reduce((n,e)=>n+(e.checkpoints?.indices?.length??0),0);
 const capacity=packet.store?.capacity;if(!Number.isSafeInteger(capacity)||capacity<16||capacity<length||capacity>RESOURCE_LIMITS.maxBars||(capacity&(capacity-1)))throw new RangeError('Prepared capacity');checkedTree(packet.store.index,capacity,true);
 const scheduling=validationScheduler(options.yieldTask);
 try{abortCheck(options.signal);for(const e of packet.indicators){completedMetadata(e,length,256);const lazy=new LazyCheckpoints({indices:e.checkpoints.indices,offsets:e.checkpoints.offsets,bytes:e.checkpoints.bytes}),start=done;
   await lazy.validateAsync(length,e.checkpointSize,e.name,bindings.expected.get(e.id).params,{...options,yieldTask:scheduling.yieldTask,onProgress:p=>{try{options.onProgress?.({phase:'validation',done:start+p.completed,total});}catch{}}});abortCheck(options.signal);done+=lazy.size;checkpoints.set(e.id,{source:e.checkpoints,lazy});
  }for(let i=0;i<packet.indices.length;i++){const cache=packet.indices[i],validation=countCacheValidation(cache,packet,bindings);while(true){abortCheck(options.signal);const step=validation.next();if(step.done){countCaches.set(cache,step.value);break;}try{options.onProgress?.({phase:'gap-validation',done:i,total:packet.indices.length});}catch{}await scheduling.yieldTask();}
  }}finally{scheduling.close();}
 abortCheck(options.signal);const token=Object.freeze({});preparedPackets.set(token,{packet,expected,checkpoints,countCaches});return token;
}
function checkedTree(packet,expectedSize,requireSum=false,finiteCounts=false){
 if(!packet||!Number.isSafeInteger(packet.size)||packet.size<1||packet.size!==expectedSize||!(packet.min instanceof Float64Array)||!(packet.max instanceof Float64Array)||packet.min.length!==packet.size*2||packet.max.length!==packet.size*2||requireSum&&(!(packet.sum instanceof Float64Array)||packet.sum.length!==packet.size*2))throw new TypeError('Prepared tree shape');if(packet.finiteCounts!==finiteCounts)throw new TypeError('Prepared finite-count cache role');return restoreTree(packet);
}
function cacheValues(cache,packet,bindings){const series=bindings.replies.get(cache.id),entry=series?.indicator?packet.indicators.find(e=>e.id===series.indicator):null,values=entry?entry.arrays?.[entry.outputs.indexOf(series.output??entry.outputs[0])]:series?.values??packet.store.columns[series?.source??'close'];if(!(values instanceof Float64Array)||values.length<packet.store.length)throw new TypeError('Prepared finite-count cache values');return values;}
function* countCacheValidation(cache,packet,bindings){
 if(cache.finiteCounts!==true||typeof cache.blocked!=='boolean')throw new TypeError('Prepared finite-count cache marker');const {store}=packet,block=cache.blocked?32:1;let size=1;while(size<Math.ceil(store.capacity/block))size*=2;
 if(cache.blocked&&(cache.size!==store.capacity||cache.length!==store.length||cache.blockSize!==32))throw new TypeError('Prepared block shape');const tree=checkedTree(cache.tree,size,true,!cache.blocked),values=cacheValues(cache,packet,bindings);if(tree.sum.buffer===store.index.sum?.buffer)throw new TypeError('Prepared finite-count cache aliases volume');
 const rows=Math.max(1,Math.floor(16384/block));for(let start=0;start<size;start+=rows){const end=Math.min(size,start+rows);for(let b=start;b<end;b++){let count=0;for(let i=b*block;i<Math.min(store.length,(b+1)*block);i++)if(Number.isFinite(values[i]))count++;if(tree.sum[size+b]!==count)throw new TypeError('Prepared finite-count cache leaf');}yield end;}
 for(let start=size-1;start>0;){const end=Math.max(0,start-16384);for(;start>end;start--)if(tree.sum[start]!==tree.sum[start*2]+tree.sum[start*2+1])throw new TypeError('Prepared finite-count cache aggregate');yield start;}
 return {tree:cache.tree,sum:cache.tree.sum,values};
}
function stagedState(model,packet,preparedVersion,expectedOptions,validation){
 const bindings=checkedDefinitions(packet,expectedOptions),validated=validation===undefined?null:preparedPackets.get(validation);if(validation!==undefined&&(!validated||validated.packet!==packet))throw new TypeError('Prepared validation handle');
 if(validated){const previous=requestedDefinitions(validated.expected);if(previous.size!==bindings.expected.size||[...previous].some(([id,e])=>{const current=bindings.expected.get(id);return !current||current.name!==e.name||!sameRecord(current.params,e.params);} ))throw new TypeError('Prepared validation request binding');}
 const {store}=packet;if(!store||!store.columns)throw new TypeError('Prepared store');sizeLimit(store.length,model.store.maxBars,'Prepared data');if(!Number.isSafeInteger(store.capacity)||store.capacity<16||store.capacity<store.length||store.capacity>RESOURCE_LIMITS.maxBars||(store.capacity&(store.capacity-1)))throw new RangeError('Prepared capacity');
 for(const key of ['time','open','high','low','close','volume'])if(!(store.columns[key] instanceof Float64Array)||store.columns[key].length!==store.capacity)throw new TypeError('Prepared column buffer');
 if(!packet.view||!Number.isFinite(packet.view.from)||!Number.isFinite(packet.view.to)||packet.view.to<=packet.view.from||typeof packet.follow!=='boolean')throw new TypeError('Prepared viewport');
 const index=checkedTree(store.index,store.capacity,true),entries=new Map();let outputBytes=0;
 for(const e of packet.indicators){const wanted=bindings.expected.get(e.id),def=wanted.def;completedMetadata(e,store.length,model.indicators.checkpointSize);
  if(!Array.isArray(e.arrays)||e.arrays.length!==def.outputs.length||e.arrays.some(a=>!(a instanceof Float64Array)||a.length!==store.capacity))throw new TypeError('Prepared indicator buffers');outputBytes+=e.arrays.reduce((n,a)=>n+a.byteLength,0);if(outputBytes>model.indicators.maxOutputBytes)throw new RangeError('Prepared output byte limit');
  const checked=validated?.checkpoints.get(e.id);if(validated&&(!checked||checked.source!==e.checkpoints))throw new TypeError('Prepared validated checkpoint binding');const checkpoints=checked?.lazy??new LazyCheckpoints(e.checkpoints).validate(store.length,e.checkpointSize,e.name,wanted.params);
  entries.set(e.id,{name:e.name,params:{...wanted.params},def,arrays:e.arrays.slice(),checkpoints,revision:e.revision,computedFrom:e.computedFrom,computedUntil:e.computedUntil,dirty:store.length,dirtyTo:0,invalidated:false,length:store.length,preparedVersion});
 }
 const caches=new Map();for(const cache of packet.indices){const series=bindings.replies.get(cache.id),e=series.indicator?entries.get(series.indicator):null,values=e?e.arrays[e.def.outputs.indexOf(series.output??e.def.outputs[0])]:series.values??store.columns[series.source??'close'];if(!(values instanceof Float64Array))throw new TypeError('Prepared series binding');let rangeIndex;
  if(validated){const count=validated.countCaches.get(cache);if(cache.finiteCounts!==true||!count||count.tree!==cache.tree||count.sum!==cache.tree.sum||count.values!==cacheValues(cache,packet,bindings))throw new TypeError('Prepared validated finite-count cache binding');}else for(const unused of countCacheValidation(cache,packet,bindings)){void unused;}
  if(cache.blocked){if(cache.size!==store.capacity||cache.length!==store.length||cache.blockSize!==32)throw new TypeError('Prepared block shape');let size=1;while(size<Math.ceil(store.capacity/cache.blockSize))size*=2;rangeIndex=Object.create(BlockRangeIndex.prototype);Object.assign(rangeIndex,{size:cache.size,length:cache.length,blockSize:cache.blockSize,values:new Float64Array(values.buffer,values.byteOffset,(values.buffer.byteLength-values.byteOffset)/8),tree:checkedTree(cache.tree,size,true),finiteCounts:true});}else rangeIndex=checkedTree(cache.tree,store.capacity,true,true);
  caches.set(series.id,{rangeIndex,revision:e?e.revision:preparedVersion,dirtyFrom:Infinity,...(series.values!==undefined?{values:series.values}:{})});
 }
 for(const series of bindings.replies.values())if(series.values!==undefined&&!caches.has(series.id))caches.set(series.id,{values:series.values,rangeIndex:undefined,revision:undefined,dirtyFrom:0});
 return {store,index,entries,caches};
}
function attachCaches(model,caches){for(const s of model.series)Object.assign(s,caches.get(s.id)??{rangeIndex:undefined,revision:undefined,dirtyFrom:0});}
function publish(model,staged){const {store,index,entries,caches}=staged;Object.assign(model.store,{length:store.length,capacity:store.capacity,columns:store.columns,index});model.indicators.entries=entries;attachCaches(model,caches);}
// Packets are owned by this library's worker. This is not an untrusted import API.
export function hydrateModel(packet,expectedOptions=packet.options,validation){
 const expected=requestOptionsSnapshot(expectedOptions),store=new BarStore(),model=new ChartModel({store,...expected});
 try{const staged=stagedState(model,packet,-1,expected,validation);publish(model,staged);model.series=expected.series.map(s=>model.normalizedSeries({...s,...(s.values!==undefined?{values:packet.options.series.find(reply=>reply.id===s.id).values}:{})}));attachCaches(model,staged.caches);model.setVisibleRange(packet.view.from,packet.view.to);model.follow=packet.follow;return model;}catch(error){model.dispose();throw error;}
}
export function installRecomputed(model,packet,event,expectedOptions=modelRequest(model),validation,beforePublish){
 if(model.disposed)throw new Error('Model disposed');
 if(!event||!['reset','append','update','correction','prepend','batch'].includes(event.kind))throw new TypeError('Prepared event kind');const kind=event.kind==='correction'?'update':event.kind;
 if(kind==='update'&&(!event.bar||!Number.isSafeInteger(event.bar.time))||kind==='prepend'&&!Array.isArray(event.bars))throw new TypeError('Prepared event metadata');
 const version=model.store.version+1,staged=stagedState(model,packet,version,expectedOptions,validation);let from=0;
 let appended=0,to=staged.store.length;
 if(kind==='batch'){dataIngestionBatchLimits(model,event,staged.store.length,staged.store.capacity);const events=snapshotIngestionEvents(event.events);if(events.some(e=>e.kind==='append')&&model.series.some(s=>s.values))throw new TypeError('Prepared length-changing batch requires external values alignment');from=staged.store.length;to=0;for(const e of events){const times=staged.store.columns.time;let a=0,b=staged.store.length;while(a<b){const mid=(a+b)>>>1;if(times[mid]<e.bar.time)a=mid+1;else b=mid;}if(a>=staged.store.length||times[a]!==e.bar.time)throw new TypeError('Prepared batch timestamp');from=Math.min(from,a);to=Math.max(to,a+1);appended+=Number(e.kind==='append');}if(staged.store.length!==model.store.length+appended)throw new TypeError('Prepared batch count');}
 else if(kind==='update'){const times=staged.store.columns.time;let a=0,b=staged.store.length;while(a<b){const mid=(a+b)>>>1;if(times[mid]<event.bar.time)a=mid+1;else b=mid;}from=a;if(from>=staged.store.length||times[from]!==event.bar.time)throw new TypeError('Prepared event timestamp');}else if(kind==='append')from=model.store.length;
 beforePublish?.();publish(model,staged);
 const published=model.series.map(series=>({series,index:series.rangeIndex,values:series.values,revision:series.revision,valuesRevision:model.seriesValueRevisions.get(series)}));
 model.store.changed(from,kind,{...(kind==='prepend'?{added:event.bars.length}:kind==='batch'?{appended,to}:{})});
 // Publication does not replace UI state. Owner callbacks run after commit and
 // may change the viewport; never replay a pre-notification view over them.
 if(model.store.version===version){for(const state of published){const s=state.series;if(!model.series.includes(s)||s.rangeIndex!==state.index||s.values!==state.values||s.revision!==state.revision||model.seriesValueRevisions.get(s)!==state.valuesRevision)continue;if(s.rangeIndex)s.dirtyFrom=Infinity;if(!s.indicator)s.revision=version;}}
}
