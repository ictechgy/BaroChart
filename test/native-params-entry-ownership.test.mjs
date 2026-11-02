import test from 'node:test';import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';import {ChartAPI} from '../src/core/api.mjs';import {seededColumns} from '../src/core/data.mjs';import {IndicatorEngine} from '../src/core/indicators.mjs';import {safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';import {NativeCheckpointBudget,NativeCheckpointMap,NativeCheckpointEntries,prepareNativeEntryCommit} from '../src/core/native-checkpoints.mjs';
function setup(t){const model=new ChartModel(),api=new ChartAPI(model);api.setColumns(seededColumns(300));api.addIndicator('a','ema',{period:3});api.addIndicator('b','sma',{period:3});t.after(()=>model.dispose());return {model,api,engine:model.indicators};}
// params 게시 커밋(설계 §7.4-3, 이식 지도 D2)은 검증된 준비 레코드를 평범한 Map으로 옮겨 설치하고 준비용 경계 맵을 닫아 원장을 바로 돌려준다.
// 그래서 게시된 항목은 새로 더한 지표와 같고, 나중에 회수할 경계 맵이 없다.
function adopted(f,id='a'){const previous=f.engine.entries.get(id),budget=new NativeCheckpointBudget(),checkpoints=new NativeCheckpointMap(previous.name,previous.params,{budget});for(const [i,state]of previous.checkpoints)checkpoints.set(i,state);const entry={...previous,arrays:previous.arrays.slice(),checkpoints};const commit=prepareNativeEntryCommit(f.engine.entries,id,previous,entry,new Map(checkpoints));commit();return {budget,checkpoints,entry,commit,values:entry.arrays[0],owner:f.engine.entries};}
/**
 * 체크포인트 컨테이너의 레코드를 색인 순서의 [색인, 정규 문자열] 목록으로 읽는다. 경계 맵과 평범한 Map 모두에 쓴다.
 * @param {Map|NativeCheckpointMap} map 체크포인트 컨테이너
 * @returns {Array<[number,string]>} 레코드 목록
 */
function records(map){return [...map].sort((a,b)=>a[0]-b[0]).map(([index,state])=>[index,safeCheckpointStringify(state)]);}
/**
 * 같은 저장소에서 새 엔진으로 계산한 출력과 차트 엔진의 출력이 비트 단위로 같은지 확인한다.
 * @param {object} f setup 결과
 * @param {string} id 차트 지표 id
 * @param {string} name 지표 이름
 * @param {object} params 지표 params
 * @returns {void}
 */
function assertFresh(f,id,name,params){const oracle=new IndicatorEngine(f.model.store);try{const expected=oracle.add('fresh',name,params).outputs.value,actual=f.engine.get(id).outputs.value;assert.equal(actual.length,expected.length);assert.ok(actual.every((v,i)=>Object.is(v,expected[i])),id+' must equal a fresh calculation');}finally{oracle.dispose();}}
for(const operation of ['remove','replace','dispose','reset','prepend','compact'])test(`params commit publishes ordinary records; ${operation} works like a fresh entry while held outputs survive`,t=>{
 const f=setup(t),expected=records(f.engine.entries.get('a').checkpoints),a=adopted(f),copy=a.values.slice();
 // 커밋 직후: 같은 레코드를 담은 평범한 Map이 설치되고, 준비용 경계 맵은 닫혀 원장이 0이다
 assert.equal(a.budget.usedBytes,0);assert.throws(()=>a.checkpoints.get(0),/disposed/);
 assert.strictEqual(f.engine.entries.get('a'),a.entry);assert.equal(Object.getPrototypeOf(a.entry.checkpoints),Map.prototype);assert.deepEqual(records(a.entry.checkpoints),expected);
 if(operation==='remove')f.api.removeIndicator('a');if(operation==='replace')f.api.setIndicatorParams('a',{period:5});if(operation==='dispose')f.model.dispose();if(operation==='reset')f.api.setColumns(seededColumns(300,3));if(operation==='prepend'){const b=f.model.store.at(0);f.model.store.prepend([{...b,time:b.time-60000}]);}if(operation==='compact')f.api.compactData({keepLastBars:100,studyHistory:'restart'});
 assert.equal(a.budget.usedBytes,0);assert.deepEqual(a.values,copy);assert.strictEqual(f.engine.entries,a.owner);
 // 항목이 남는 작업 뒤에는 새 차트처럼 다시 계산하고 평범한 Map을 쓴다
 if(['replace','reset','prepend','compact'].includes(operation)){assertFresh(f,'a','ema',operation==='replace'?{period:5}:{period:3});assert.equal(Object.getPrototypeOf(f.engine.entries.get('a').checkpoints),Map.prototype);}
});
test('unrelated successful and failed params changes keep the published records',t=>{const f=setup(t),a=adopted(f),map=a.entry.checkpoints,expected=records(map);f.api.setIndicatorParams('b',{period:9});assert.throws(()=>f.api.setIndicatorParams('b',{period:0}));assert.strictEqual(f.engine.entries.get('a'),a.entry);assert.strictEqual(a.entry.checkpoints,map);assert.deepEqual(records(map),expected);assert.equal(a.budget.usedBytes,0);});
test('additive loadStudies keeps the published records',t=>{const f=setup(t),a=adopted(f),map=a.entry.checkpoints,expected=records(map);f.api.loadStudies(JSON.stringify({schema:'aster.studies',version:1,indicators:[{id:'new',name:'ema',params:{period:5}}],series:[]}));assert.strictEqual(f.engine.entries.get('a'),a.entry);assert.strictEqual(a.entry.checkpoints,map);assert.deepEqual(records(map),expected);assert.equal(a.budget.usedBytes,0);});
test('commit plan rejects reuse, a retired staging map and an overridden Map without touching the published entry',t=>{const f=setup(t),a=adopted(f),map=a.entry.checkpoints,expected=records(map);assert.throws(()=>a.commit(),/stale/);assert.throws(()=>prepareNativeEntryCommit(f.engine.entries,'b',f.engine.entries.get('b'),a.entry),/ownership/);assert.throws(()=>prepareNativeEntryCommit(f.engine.entries,'b',f.engine.entries.get('b'),{...a.entry,checkpoints:a.checkpoints}),/ownership/);assert.throws(()=>new NativeCheckpointEntries([['a',{checkpoints:a.checkpoints}]]),/ownership/);f.engine.entries.set=()=>assert.fail('override called');assert.throws(()=>prepareNativeEntryCommit(f.engine.entries,'a',a.entry,a.entry),/owner/);delete f.engine.entries.set;assert.strictEqual(f.engine.entries.get('a'),a.entry);assert.strictEqual(a.entry.checkpoints,map);assert.deepEqual(records(map),expected);assert.equal(a.budget.usedBytes,0);});
test('params commit into a NativeCheckpointEntries owner installs an ordinary entry without claiming the staging map',t=>{const f=setup(t);f.engine.entries=new NativeCheckpointEntries(f.engine.entries);const a=adopted(f);assert.equal(a.budget.usedBytes,0);assert.equal(Object.getPrototypeOf(a.entry.checkpoints),Map.prototype);assert.throws(()=>a.checkpoints.get(0),/disposed/);f.api.removeIndicator('a');assert.equal(a.budget.usedBytes,0);f.model.dispose();assert.equal(a.budget.usedBytes,0);});
test('web async replacement of a published params entry publishes only after success',async t=>{const {setIndicatorParamsAsync}=await import('../src/web/indicator-params-async.mjs'),{computeIndicatorParamsRequest}=await import('../src/web/indicator-params-worker.mjs');const f=setup(t),a=adopted(f);const factory=mutate=>()=>({onmessage:null,onerror:null,postMessage(request,transfer){const packet=computeIndicatorParamsRequest(structuredClone(request,{transfer}));mutate?.(packet);queueMicrotask(()=>this.onmessage?.({data:packet}));},terminate(){}});await assert.rejects(setIndicatorParamsAsync(f.api,'a',{period:5},{workerFactory:factory(p=>p.jobId++)}));assert.strictEqual(f.engine.entries.get('a'),a.entry);await setIndicatorParamsAsync(f.api,'a',{period:5},{workerFactory:factory()});assert.notStrictEqual(f.engine.entries.get('a'),a.entry);assert.equal(a.budget.usedBytes,0);assert.strictEqual(f.engine.entries,a.owner);assertFresh(f,'a','ema',{period:5});});

test('changed candidate checkpoint identity invalidates the prepared adoption without publication',t=>{const f=setup(t),previous=f.engine.entries.get('a'),budget=new NativeCheckpointBudget(),checkpoints=new NativeCheckpointMap('ema',previous.params,{budget});for(const [i,s]of previous.checkpoints)checkpoints.set(i,s);const next={...previous,checkpoints},commit=prepareNativeEntryCommit(f.engine.entries,'a',previous,next,new Map(checkpoints));next.checkpoints=new Map();assert.throws(commit,/stale/);assert.strictEqual(f.engine.entries.get('a'),previous);assert.ok(budget.usedBytes>0);checkpoints.dispose();assert.equal(budget.usedBytes,0);});
// 쓰기 금지 checkpoints 칸은 모듈(엄격 모드)과 번들(느슨한 모드) 모두에서 같은 stale 오류로 설치 전에 멈춘다
test('a non-writable staged checkpoints slot fails the commit before installation',t=>{const f=setup(t),previous=f.engine.entries.get('a'),budget=new NativeCheckpointBudget(),checkpoints=new NativeCheckpointMap('ema',previous.params,{budget});for(const [i,s]of previous.checkpoints)checkpoints.set(i,s);const next={...previous,arrays:previous.arrays.slice()};Object.defineProperty(next,'checkpoints',{value:checkpoints,writable:false,enumerable:true,configurable:true});const commit=prepareNativeEntryCommit(f.engine.entries,'a',previous,next,new Map(checkpoints));assert.throws(commit,{name:'Error',message:'Native params entry commit stale'});assert.strictEqual(f.engine.entries.get('a'),previous);assert.strictEqual(next.checkpoints,checkpoints);assert.ok(budget.usedBytes>0);assert.ok(checkpoints.get(0));checkpoints.dispose();assert.equal(budget.usedBytes,0);});
// params 커밋은 가져오기가 레코드를 받으며 만들어 둔 평범한 Map을 그대로 설치한다. 소유 스레드의 커밋 한 턴에서 레코드를 다시 해독하지 않는다(리뷰 C5)
test('params commit installs the staged ordinary map itself and rejects a missing, foreign or resized one',t=>{
 const f=setup(t),previous=f.engine.entries.get('a'),budget=new NativeCheckpointBudget(),checkpoints=new NativeCheckpointMap('ema',previous.params,{budget});for(const [i,s]of previous.checkpoints)checkpoints.set(i,s);
 const next={...previous,arrays:previous.arrays.slice(),checkpoints},expected=records(checkpoints),withKey=Object.assign(new Map(checkpoints),{extra:true});
 // 준비: 평범한 Map이 아니거나, 자기 속성이 있거나, 레코드 수가 경계 맵과 다르면 소유 오류다
 for(const staged of [undefined,null,{},[...checkpoints],withKey,new Map()])assert.throws(()=>prepareNativeEntryCommit(f.engine.entries,'a',previous,next,staged),{name:'TypeError',message:'Native params checkpoint ownership'});
 // 커밋: 준비 뒤 staged의 레코드 수가 바뀌면 설치하지 않고 준비 원장도 그대로 둔다
 const resized=new Map(checkpoints),stale=prepareNativeEntryCommit(f.engine.entries,'a',previous,next,resized);resized.delete(0);
 assert.throws(stale,{name:'Error',message:'Native params entry commit stale'});assert.strictEqual(f.engine.entries.get('a'),previous);assert.strictEqual(next.checkpoints,checkpoints);assert.ok(budget.usedBytes>0);
 // 정상 커밋: 사본을 새로 만들지 않고 넘긴 Map 자체를 설치한 뒤 경계 맵을 닫아 원장을 돌려준다
 const staged=new Map(checkpoints);prepareNativeEntryCommit(f.engine.entries,'a',previous,next,staged)();
 assert.strictEqual(f.engine.entries.get('a'),next);assert.strictEqual(next.checkpoints,staged);assert.deepEqual(records(staged),expected);assert.equal(budget.usedBytes,0);assert.throws(()=>checkpoints.get(0),/disposed/);
});
