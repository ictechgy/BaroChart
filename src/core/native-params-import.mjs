// Detached owner-runtime staging. Does not publish or inspect a live model.
import {safeCheckpointParse} from './checkpoint-validation.mjs';
import {optionRecord} from './contracts.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {validateIndicatorModuleBinding} from './indicator-modules.mjs';
import {NativeCheckpointBudget,NativeCheckpointMap,NATIVE_CHECKPOINT_TOTAL_BYTES,NATIVE_CHECKPOINT_RECORD_BYTES} from './native-checkpoints.mjs';
const nativeImportSame=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));
// 게시용 평범한 Map에 레코드를 넣을 때는 애플리케이션이 바꿀 수 있는 메서드 대신 모듈을 불러올 때 붙잡은 내장 메서드를 쓴다
const nativeImportMapSet=Map.prototype.set;
export class NativeParamsImport {
 constructor(text,expected,def,{checkpointBytes=NATIVE_CHECKPOINT_TOTAL_BYTES}={}){
  if(typeof text!=='string'||text.length>131072)throw new RangeError('Native params result metadata limit');const r=safeCheckpointParse(text);optionRecord(r,['schema','version','registration','id','name','params','module','outputs','plotOffsets','length','capacity','checkpointCount','checkpointBytes','plan'],'Native params result');
  if(r.schema!=='aster.native-params-result'||r.version!==1)throw new TypeError('Native params result protocol');for(const k of ['registration','id','name','length','capacity'])if(!Object.is(r[k],expected[k]))throw new TypeError('Native params result binding');
  if(!Number.isSafeInteger(r.length)||r.length<0||r.length>4194304||!Number.isSafeInteger(r.capacity)||r.capacity<16||r.capacity<r.length||r.capacity>4194304||(r.capacity&(r.capacity-1)))throw new RangeError('Native params result dimensions');
  validateIndicatorParams(r.params);if(!nativeImportSame(r.params,expected.params))throw new TypeError('Native params result parameters');validateIndicatorModuleBinding(r.name,r.module);
  if(!Array.isArray(r.outputs)||r.outputs.length<1||r.outputs.length>32||r.outputs.length!==expected.outputs.length||r.outputs.some((k,i)=>k!==expected.outputs[i])||!nativeImportSame(r.plotOffsets,expected.plotOffsets))throw new TypeError('Native params result output binding');
  if(r.outputs.length*r.capacity*8>268435456)throw new RangeError('Native params result output byte limit');const count=r.length?Math.floor(r.length/256)+1:0;if(r.checkpointCount!==count||!Number.isSafeInteger(r.checkpointBytes)||r.checkpointBytes<0||r.checkpointBytes>checkpointBytes)throw new RangeError('Native params result checkpoint budget');
  // checkpoints(경계 맵)는 레코드를 검증하고 원장에 과금한다. ordinaryCheckpoints는 같은 레코드를 해독한 상태로 담아 게시 때 그대로 설치할 평범한 Map이다
  this.budget=new NativeCheckpointBudget(checkpointBytes);this.checkpoints=new NativeCheckpointMap(r.name,expected.params,{budget:this.budget});this.ordinaryCheckpoints=new Map();this.binding={...expected,params:{...expected.params},outputs:[...expected.outputs],plotOffsets:{...expected.plotOffsets}};this.def=def;this.create=def.create;this.phase='receive';this.closed=false;this.transferred=false;this.at=0;this.output=0;this.ordinal=0;this.expectedCheckpointBytes=r.checkpointBytes;this.checkpointCount=count;this.received=r.outputs.map(()=>0);this.arrays=r.outputs.map(()=>null);this.entry=null;
 }
 active(){if(this.closed)throw new Error('Native params import closed');}
 guard(){this.active();const b=this.binding;if(this.def.create!==this.create||this.def.outputs.length!==b.outputs.length||this.def.outputs.some((k,i)=>k!==b.outputs[i])||!nativeImportSame(this.def.plotOffsets??{},b.plotOffsets))throw new Error('Native params import definition changed');this.active();}
 target(slot,offset,count){this.active();if(this.phase!=='receive'||!Number.isInteger(slot)||slot<0||slot>=this.arrays.length||offset!==this.received[slot]||!Number.isSafeInteger(count)||count<1||count>16384||offset+count>this.binding.capacity)throw new RangeError('Native params result slice');if(this.arrays[slot]===null)this.arrays[slot]=new Float64Array(this.binding.capacity);this.received[slot]+=count;return this.arrays[slot].subarray(offset,offset+count);}
 // 레코드 하나를 받는 짧은 소유자 단계다. 해독도 여기서 한 번만 한다(리뷰 C5).
 // set()은 state를 정규 문자열로 바꿔 저장하고 그 문자열을 따로 해독해 검증할 뿐, state는 읽기만 하고 붙잡지 않는다.
 // 그래서 state는 get(index)가 돌려줄 새 사본과 같은 레코드이고, 다른 곳에서 참조하지 않는다.
 // 이것을 색인 오름차순(도착 순서)으로 평범한 Map에 담아 두면 게시는 레코드를 다시 해독하지 않고 상수 시간에 끝난다
 checkpoint(index,text){this.active();try{this.guard();if(this.phase!=='receive'||this.ordinal>=this.checkpointCount||index!==this.ordinal*256||typeof text!=='string'||text.length*2>NATIVE_CHECKPOINT_RECORD_BYTES)throw new RangeError('Native params result checkpoint record');const state=safeCheckpointParse(text);this.checkpoints.set(index,state);nativeImportMapSet.call(this.ordinaryCheckpoints,index,state);this.guard();this.ordinal++;if(this.budget.usedBytes>this.expectedCheckpointBytes)throw new RangeError('Native params checkpoint declared bytes');return true;}catch(error){this.dispose();throw error;}}
 start(){this.guard();if(this.phase!=='receive'||this.received.some(n=>n!==this.binding.capacity)||this.ordinal!==this.checkpointCount||this.budget.usedBytes!==this.expectedCheckpointBytes)throw new Error('Native params result incomplete');this.phase='validate';return true;}
 step(maxValues=16384){this.active();try{if(!Number.isSafeInteger(maxValues)||maxValues<1||maxValues>16384)throw new RangeError('Native params validation work size');this.guard();if(this.phase==='ready')return {phase:'ready',done:1,total:1,complete:true};if(this.phase!=='validate')throw new Error('Native params result not started');const b=this.binding;let remaining=maxValues;
  while(this.output<this.arrays.length&&remaining){const a=this.arrays[this.output],end=Math.min(b.capacity,this.at+remaining);for(;this.at<end;this.at++,remaining--){const v=a[this.at];if(this.at>=b.length?!Number.isNaN(v):v===Infinity||v===-Infinity)throw new TypeError('Native params result finite/NaN tail');}if(this.at===b.capacity){this.at=0;this.output++;}}
  if(this.output<this.arrays.length)return {phase:'validate',done:this.output*b.capacity+this.at,total:this.arrays.length*b.capacity,complete:false};this.guard();this.entry={def:this.def,name:b.name,params:{...b.params},arrays:this.arrays,checkpoints:this.checkpoints,revision:b.length?1:0,computedFrom:0,computedUntil:b.length,dirty:b.length,dirtyTo:0,invalidated:false,length:b.length};this.phase='ready';return {phase:'ready',done:1,total:1,complete:true};
 }catch(error){this.dispose();throw error;}}
 readyEntry(){this.guard();if(this.phase!=='ready')throw new Error('Native params result not ready');return this.entry;}
 /**
  * 레코드를 받으며 만들어 둔 게시용 평범한 Map을 돌려준다. readyEntry()의 경계 맵과 같은 색인·레코드를 색인 오름차순으로 담는다.
  * 게시 커밋(prepareNativeEntryCommit)이 이 Map을 그대로 엔트리에 설치하므로 소유 스레드의 게시 한 턴에서 레코드를 다시 해독하지 않는다.
  * @returns {Map<number, object>} 해독한 체크포인트 레코드
  */
 readyCheckpoints(){this.guard();if(this.phase!=='ready')throw new Error('Native params result not ready');return this.ordinaryCheckpoints;}
 // 콜백 없는 게시 커밋이 성공한 뒤에만 부른다. 커밋이 이미 ordinaryCheckpoints를 엔트리에 설치하고
 // 준비용 경계 맵(과 그 원장)을 닫았으므로, 여기서는 이제 엔진 것이 된 출력 벡터와 Map을 건드리지 않고 참조만 놓는다.
 releasePublished(){this.transferred=true;this.closed=true;this.drop();}
 drop(){this.arrays=[];this.entry=null;this.def=null;this.create=null;this.binding=null;this.checkpoints=null;this.ordinaryCheckpoints=null;this.received=[];}
 dispose(){if(this.closed)return;this.closed=true;try{if(!this.transferred)this.checkpoints.dispose();}finally{this.drop();}}
}
