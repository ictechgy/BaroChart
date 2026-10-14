// Internal isolated-runtime parameter calculation. No host publication or timers.
import {FIELDS,validateBar} from './data.mjs';
import {IndicatorEngine,resolveIndicatorFactory,requirePortableFactory} from './indicators.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {validateIndicatorModuleBinding} from './indicator-modules.mjs';
import {optionRecord,identifier,RESOURCE_LIMITS} from './contracts.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from './checkpoint-validation.mjs';
import {NativeCheckpointBudget,NativeCheckpointMap,NativeCheckpointEntries,NATIVE_CHECKPOINT_TOTAL_BYTES,NATIVE_CHECKPOINT_RECORD_BYTES} from './native-checkpoints.mjs';
const nativeParamsSame=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));
function nativeParamsLayout(def){return {outputs:[...def.outputs],plotOffsets:{...def.plotOffsets}};}
function nativeParamsLayoutEqual(a,b){return a.outputs.length===b.outputs.length&&a.outputs.every((k,i)=>k===b.outputs[i])&&nativeParamsSame(a.plotOffsets,b.plotOffsets);}
function nativeParamsSpec(text){
 if(typeof text!=='string'||text.length>131072)throw new RangeError('Native params metadata limit');const b=safeCheckpointParse(text);
 optionRecord(b,['schema','version','registration','id','name','params','module','length','capacity','outputs','plotOffsets','maxBytes'],'Native params metadata');
 if(b.schema!=='aster.native-params-target'||b.version!==1||!Number.isSafeInteger(b.registration)||b.registration<1)throw new TypeError('Native params protocol');identifier(b.id,'Indicator id');identifier(b.name,'Indicator name');validateIndicatorParams(b.params);
 if(!Number.isSafeInteger(b.length)||b.length<0||b.length>RESOURCE_LIMITS.maxBars||!Number.isSafeInteger(b.capacity)||b.capacity<16||b.capacity<b.length||b.capacity>RESOURCE_LIMITS.maxBars||(b.capacity&(b.capacity-1)))throw new RangeError('Native params dimensions');
 if(!Number.isSafeInteger(b.maxBytes)||b.maxBytes<1||b.maxBytes>805306368)throw new RangeError('Native params byte limit');
 validateIndicatorModuleBinding(b.name,b.module);const factory=resolveIndicatorFactory(b.name);requirePortableFactory(b.name,factory);
 // Definition construction follows the same IndicatorEngine admission as web.
 const store={length:0,capacity:0,columns:{},_subscribeInternal:()=>()=>{}},probe=new IndicatorEngine(store);let def;
 try{probe.registry.set(b.name,factory);probe.add(b.id,b.name,{...b.params});const entry=probe.entries.get(b.id);if(!nativeParamsSame(entry.params,b.params))throw new TypeError('Native params factory changed params');def=entry.def;}finally{probe.dispose();}
 const layout=nativeParamsLayout(def);if(!Array.isArray(b.outputs)||!nativeParamsLayoutEqual(layout,{outputs:b.outputs,plotOffsets:b.plotOffsets}))throw new TypeError('Native params output binding');
 const outputBytes=layout.outputs.length*b.capacity*8;if(outputBytes>268435456)throw new RangeError('Native params output limit');
 const checkpointCount=b.length?Math.floor(b.length/256)+1:0,plan={sourceBytes:b.length*48,outputBytes,checkpointBytes:NATIVE_CHECKPOINT_TOTAL_BYTES,recordMetadataBytes:checkpointCount*128,scratchBytes:16*1024*1024};plan.totalBytes=Object.values(plan).reduce((a,n)=>a+n,0);if(plan.totalBytes>b.maxBytes)throw new RangeError('Native params target logical byte limit');
 return {binding:b,def,create:def.create,layout,factory,checkpointCount,plan};
}
export class NativeParamsTarget {
 constructor(text){const s=nativeParamsSpec(text);Object.assign(this,s);this.closed=false;this.chunkSize=null;this.phase='capture';this.columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(s.binding.length)]));this.received=FIELDS.map(()=>0);this.at=0;this.output=0;this.previous=-Infinity;this.engine=null;this.entry=null;this.task=null;this.budget=new NativeCheckpointBudget();}
 active(){if(this.closed)throw new Error('Native params target closed');}
 guard(){this.active();if(this.def.create!==this.create||resolveIndicatorFactory(this.binding.name)!==this.factory||!nativeParamsLayoutEqual(nativeParamsLayout(this.def),this.layout))throw new Error('Native params definition changed');this.active();if(this.engine&&(this.engine.entries.get(this.binding.id)!==this.entry||this.entry.def!==this.def||!nativeParamsSame(this.entry.params,this.binding.params)))throw new Error('Native params target entry changed');}
 target(slot,offset,count){this.active();if(this.phase!=='capture'||!Number.isInteger(slot)||slot<0||slot>=6||offset!==this.received[slot]||!Number.isSafeInteger(count)||count<1||count>16384||offset+count>this.binding.length)throw new RangeError('Native params input slice');this.received[slot]+=count;return this.columns[FIELDS[slot]].subarray(offset,offset+count);}
 start(){this.guard();if(this.phase!=='capture'||this.received.some(n=>n!==this.binding.length))throw new Error('Native params incomplete input');this.phase='validate';return true;}
 step(maxBars=4096){this.active();try{
  if(!Number.isSafeInteger(maxBars)||maxBars<1||maxBars>16384)throw new RangeError('Native params work size');if(this.chunkSize!==null&&this.chunkSize!==maxBars)throw new RangeError('Native params work size must remain fixed');this.chunkSize=maxBars;this.guard();const b=this.binding,n=b.length;if(this.phase==='capture')throw new Error('Native params not started');
  if(this.phase==='validate'){const end=Math.min(n,this.at+maxBars),bar={};for(;this.at<end;this.at++){for(const k of FIELDS)bar[k]=this.columns[k][this.at];validateBar(bar,this.previous);this.previous=bar.time;}if(this.at<n)return this.progress(this.at,n);const store={length:n,capacity:b.capacity,columns:this.columns,_subscribeInternal:()=>()=>{}};this.engine=new IndicatorEngine(store);this.engine.entries=new NativeCheckpointEntries();this.entry={def:this.def,name:b.name,params:{...b.params},dirty:0,dirtyTo:n,invalidated:true,length:0,arrays:[],checkpoints:new NativeCheckpointMap(b.name,b.params,{budget:this.budget}),revision:0};this.engine.entries.set(b.id,this.entry);this.phase='calculate';this.at=0;return this.progress(0,n);}
  if(this.phase==='calculate'){if(!this.task)this.task=this.engine.calculate(b.id,maxBars);const next=this.task.next();this.guard();if(!next.done)return this.progress(next.value?.to??0,n);this.task=null;if(this.entry.checkpoints.size!==this.checkpointCount)throw new TypeError('Native params checkpoint count');this.phase='outputs';return this.progress(0,this.layout.outputs.length*b.capacity);}
  if(this.phase==='outputs'){let remaining=maxBars;while(this.output<this.layout.outputs.length&&remaining){const a=this.entry.arrays[this.output],end=Math.min(b.capacity,this.at+remaining);if(!(a instanceof Float64Array)||a.length!==b.capacity)throw new TypeError('Native params output capacity');for(;this.at<end;this.at++,remaining--){const v=a[this.at];if(this.at>=n?!Number.isNaN(v):v===Infinity||v===-Infinity)throw new TypeError('Native params output finite/NaN');}if(this.at===b.capacity){this.at=0;this.output++;}}if(this.output<this.layout.outputs.length)return this.progress(this.output*b.capacity+this.at,this.layout.outputs.length*b.capacity);this.phase='ready';}
  this.guard();return this.progress(1,1,true);
 }catch(error){this.dispose();throw error;}}
 progress(done,total,complete=false){return {phase:this.phase,done,total,complete};}
 ready(){this.guard();if(this.phase!=='ready')throw new Error('Native params target not ready');}
 descriptor(){this.ready();return {schema:'aster.native-params-result',version:1,registration:this.binding.registration,id:this.binding.id,name:this.binding.name,params:{...this.binding.params},module:this.binding.module?{...this.binding.module}:undefined,...nativeParamsLayout(this.def),length:this.binding.length,capacity:this.binding.capacity,checkpointCount:this.checkpointCount,checkpointBytes:this.budget.usedBytes,plan:{...this.plan}};}
 outputBuffer(slot,offset,count){this.ready();if(!Number.isInteger(slot)||slot<0||slot>=this.layout.outputs.length||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(count)||count<1||count>16384||offset+count>this.binding.capacity)throw new RangeError('Native params output slice');return this.entry.arrays[slot].subarray(offset,offset+count);}
 checkpoint(ordinal){this.ready();if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=this.checkpointCount)throw new RangeError('Native params checkpoint ordinal');const index=ordinal*256,text=safeCheckpointStringify(this.entry.checkpoints.get(index));this.guard();if(text.length*2>NATIVE_CHECKPOINT_RECORD_BYTES)throw new RangeError('Native params checkpoint record limit');return {index,text};}
 dispose(){if(this.closed)return;this.closed=true;try{this.task?.return();}finally{try{this.engine?.dispose();}finally{this.columns={};this.engine=null;this.entry=null;this.task=null;this.def=null;this.create=null;this.factory=null;this.layout=null;this.binding=null;}}}
}
