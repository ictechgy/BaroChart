import test from 'node:test';import assert from 'node:assert/strict';
import {builtinIndicators} from '../src/core/indicators.mjs';
import {validateCheckpointState,safeCheckpointParse,safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
const valid=()=>({h:{a:[[7,9],[9,5]],head:0},l:{a:[[8,1],[9,2]],head:0}});
test('Aroon checkpoint accepts canonical bounded queues and rejects damaged history',()=>{
 assert.equal(validateCheckpointState('aroon',{period:3},valid(),10).h.a.length,2);
 for(const mutate of [s=>delete s.h,s=>s.extra=1,s=>s.h.head=1,s=>s.h.a=[],s=>s.h.a[0][0]=5,s=>s.h.a[1][0]=7,s=>s.h.a[1][0]=8,s=>s.l.a[1][0]=8,s=>s.h.a[1][1]=9,s=>s.l.a[1][1]=1,s=>s.h.a[1][1]=Infinity,s=>s.h.a[1][1]=NaN,s=>s.h.a[1][1]=1,s=>s.l.a[1][1]='2']){const s=valid();mutate(s);assert.throws(()=>validateCheckpointState('aroon',{period:3},s,10));}
 for(const p of [null,0,-1,1.5,10001,NaN,Infinity,'3'])assert.throws(()=>validateCheckpointState('aroon',{period:p},{},0));
 assert.deepEqual(validateCheckpointState('aroon',{}, {},0),{});
});
test('Aroon snapshots are bounded through deque compaction and preserve signed zero codec',()=>{
 const instance=builtinIndicators.get('aroon')({period:3}).create();
 for(let i=0;i<1100;i++){instance.step({high:i%2?0:-0,low:i%2?-0:0},i);const state=instance.snapshot();validateCheckpointState('aroon',{period:3},state,i+1);assert.ok(state.h.a.length<=4&&state.l.a.length<=4);assert.equal(state.h.head,0);assert.equal(state.l.head,0);assert.deepEqual(safeCheckpointParse(safeCheckpointStringify(state)),state);}
});
