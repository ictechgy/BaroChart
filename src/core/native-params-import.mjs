// Detached owner-runtime staging. Does not publish or inspect a live model.
import {safeCheckpointParse} from './checkpoint-validation.mjs';
import {optionRecord} from './contracts.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {validateIndicatorModuleBinding} from './indicator-modules.mjs';
import {NativeCheckpointBudget,NativeCheckpointMap,NATIVE_CHECKPOINT_TOTAL_BYTES,NATIVE_CHECKPOINT_RECORD_BYTES} from './native-checkpoints.mjs';
const nativeImportSame=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));
export class NativeParamsImport {
 constructor(text,expected,def,{checkpointBytes=NATIVE_CHECKPOINT_TOTAL_BYTES}={}){
  if(typeof text!=='string'||text.length>131072)throw new RangeError('Native params result metadata limit');const r=safeCheckpointParse(text);optionRecord(r,['schema','version','registration','id','name','params','module','outputs','plotOffsets','length','capacity','checkpointCount','checkpointBytes','plan'],'Native params result');
  if(r.schema!=='aster.native-params-result'||r.version!==1)throw new TypeError('Native params result protocol');for(const k of ['registration','id','name','length','capacity'])if(!Object.is(r[k],expected[k]))throw new TypeError('Native params result binding');
  if(!Number.isSafeInteger(r.length)||r.length<0||r.length>4194304||!Number.isSafeInteger(r.capacity)||r.capacity<16||r.capacity<r.length||r.capacity>4194304||(r.capacity&(r.capacity-1)))throw new RangeError('Native params result dimensions');
  validateIndicatorParams(r.params);if(!nativeImportSame(r.params,expected.params))throw new TypeError('Native params result parameters');validateIndicatorModuleBinding(r.name,r.module);
  if(!Array.isArray(r.outputs)||r.outputs.length<1||r.outputs.length>32||r.outputs.length!==expected.outputs.length||r.outputs.some((k,i)=>k!==expected.outputs[i])||!nativeImportSame(r.plotOffsets,expected.plotOffsets))throw new TypeError('Native params result output binding');
  if(r.outputs.length*r.capacity*8>268435456)throw new RangeError('Native params result output byte limit');const count=r.length?Math.floor(r.length/256)+1:0;if(r.checkpointCount!==count||!Number.isSafeInteger(r.checkpointBytes)||r.checkpointBytes<0||r.checkpointBytes>checkpointBytes)throw new RangeError('Native params result checkpoint budget');
  this.budget=new NativeCheckpointBudget(checkpointBytes);this.checkpoints=new NativeCheckpointMap(r.name,expected.params,{budget:this.budget});this.binding={...expected,params:{...expected.params},outputs:[...expected.outputs],plotOffsets:{...expected.plotOffsets}};this.def=def;this.create=def.create;this.phase='receive';this.closed=false;this.transferred=false;this.at=0;this.output=0;this.ordinal=0;this.expectedCheckpointBytes=r.checkpointBytes;this.checkpointCount=count;this.received=r.outputs.map(()=>0);this.arrays=r.outputs.map(()=>null);this.entry=null;
 }
 active(){if(this.closed)throw new Error('Native params import closed');}
 guard(){this.active();const b=this.binding;if(this.def.create!==this.create||this.def.outputs.length!==b.outputs.length||this.def.outputs.some((k,i)=>k!==b.outputs[i])||!nativeImportSame(this.def.plotOffsets??{},b.plotOffsets))throw new Error('Native params import definition changed');this.active();}
 target(slot,offset,count){this.active();if(this.phase!=='receive'||!Number.isInteger(slot)||slot<0||slot>=this.arrays.length||offset!==this.received[slot]||!Number.isSafeInteger(count)||count<1||count>16384||offset+count>this.binding.capacity)throw new RangeError('Native params result slice');if(this.arrays[slot]===null)this.arrays[slot]=new Float64Array(this.binding.capacity);this.received[slot]+=count;return this.arrays[slot].subarray(offset,offset+count);}
 checkpoint(index,text){this.active();try{this.guard();if(this.phase!=='receive'||this.ordinal>=this.checkpointCount||index!==this.ordinal*256||typeof text!=='string'||text.length*2>NATIVE_CHECKPOINT_RECORD_BYTES)throw new RangeError('Native params result checkpoint record');const state=safeCheckpointParse(text);this.checkpoints.set(index,state);this.guard();this.ordinal++;if(this.budget.usedBytes>this.expectedCheckpointBytes)throw new RangeError('Native params checkpoint declared bytes');return true;}catch(error){this.dispose();throw error;}}
 start(){this.guard();if(this.phase!=='receive'||this.received.some(n=>n!==this.binding.capacity)||this.ordinal!==this.checkpointCount||this.budget.usedBytes!==this.expectedCheckpointBytes)throw new Error('Native params result incomplete');this.phase='validate';return true;}
 step(maxValues=16384){this.active();try{if(!Number.isSafeInteger(maxValues)||maxValues<1||maxValues>16384)throw new RangeError('Native params validation work size');this.guard();if(this.phase==='ready')return {phase:'ready',done:1,total:1,complete:true};if(this.phase!=='validate')throw new Error('Native params result not started');const b=this.binding;let remaining=maxValues;
  while(this.output<this.arrays.length&&remaining){const a=this.arrays[this.output],end=Math.min(b.capacity,this.at+remaining);for(;this.at<end;this.at++,remaining--){const v=a[this.at];if(this.at>=b.length?!Number.isNaN(v):v===Infinity||v===-Infinity)throw new TypeError('Native params result finite/NaN tail');}if(this.at===b.capacity){this.at=0;this.output++;}}
  if(this.output<this.arrays.length)return {phase:'validate',done:this.output*b.capacity+this.at,total:this.arrays.length*b.capacity,complete:false};this.guard();this.entry={def:this.def,name:b.name,params:{...b.params},arrays:this.arrays,checkpoints:this.checkpoints,revision:b.length?1:0,computedFrom:0,computedUntil:b.length,dirty:b.length,dirtyTo:0,invalidated:false,length:b.length};this.phase='ready';return {phase:'ready',done:1,total:1,complete:true};
 }catch(error){this.dispose();throw error;}}
 readyEntry(){this.guard();if(this.phase!=='ready')throw new Error('Native params result not ready');return this.entry;}
 // Only call after callback-free adoption has succeeded. This drops wrapper
 // references without disposing the now-live checkpoint ledger or held outputs.
 releasePublished(){this.transferred=true;this.closed=true;this.drop();}
 drop(){this.arrays=[];this.entry=null;this.def=null;this.create=null;this.binding=null;this.checkpoints=null;this.received=[];}
 dispose(){if(this.closed)return;this.closed=true;try{if(!this.transferred)this.checkpoints.dispose();}finally{this.drop();}}
}
