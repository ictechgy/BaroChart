// 복원·params 비동기 게시 뒤 엔진이 새 차트와 같은 체크포인트 회계를 쓰는지 확인한다(설계 §7.4-3, 이식 지도 D2, M0 Task 3).
// 게시 직후 IndicatorEngine.entries와 모든 항목의 checkpoints가 같은 레코드를 담은 평범한 Map이고,
// 복원·params용 경계 예산이 해제되며, 이후 append·재계산·원본 회계가 새 차트와 같아야 한다.
// 복원 진행 중(대상 계산 단계)의 32 MiB 예산과 256 KiB 레코드 한도는 그대로다(이식 지도 §3.8.5 (a)(b)).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

/** 생성된 네이티브 번들 원문. 플랫폼이 싣는 산출물을 그대로 올린다(신선도는 native-resource-freshness가 따로 본다). */
const BUNDLE=await readFile(new URL('../native/Resources/aster-core.js',import.meta.url),'utf8');
/** 모든 런타임이 같은 값으로 쓰는 데이터셋 바인딩. */
const BINDING=Object.freeze({key:'checkpoint-publish',revision:'1',adjustmentVersion:'1',priceUnit:'USD',adjustment:'raw'});
/** 1 MiB(바이트). 복원 직후 체크포인트 합계 범위(24~32 MiB)를 적는 데 쓴다. */
const MIB=1048576;
/** 복원·params 경계 예산의 상한(32 MiB). 고치기 전에는 게시 뒤에도 이 한도가 남았다. */
const CHECKPOINT_BUDGET_BYTES=32*MIB;
/**
 * 큰 복원 시나리오의 막대 수. 긴 소수 종가(seededColumns)의 sma(5000)은 레코드 하나가 약 174 KB라
 * 38,000개면 149개 레코드, 약 24.6 MiB가 되어 복원은 32 MiB 안에서 성공한다.
 */
const LARGE_BARS=38000;
/** 큰 시나리오의 sma 기간. 레코드 하나가 256 KiB 한도 아래에 머무는 가장 큰 쪽의 대표값이다. */
const LARGE_PERIOD=5000;
/** 게시 뒤 덧붙이는 막대 수. 큰 복원 시나리오에 더하면 레코드 합계가 32 MiB를 넘는다. */
const APPEND_BARS=20000;
/** params 소스 런타임이 쓰는 호스트 revision. 값 자체는 의미가 없고 호출마다 같기만 하면 된다. */
const REVISION=3;
/** 워크스페이스 원본 복사 한 번의 최대 값 수(브리지 한도 262,144보다 작게 쪼갠다). */
const WORKSPACE_CHUNK=65536;
/** params 버퍼·검증 한 번의 최대 값 수(브리지 한도 16,384). */
const PARAMS_CHUNK=16384;

/**
 * vm 컨텍스트 안에서 코드를 실행한다.
 * @param {object} context node:vm 컨텍스트
 * @param {string} code 실행할 스크립트
 * @returns {*} 마지막 식의 값
 */
function run(context,code){return vm.runInContext(code,context);}

/**
 * 번들을 올린 새 런타임을 만든다.
 * 게시 직후 예산을 직접 보려고 복원 대상(start)과 params 가져오기(target)의 this를 전역에 붙잡는 감시를 단다.
 * 감시는 원래 메서드를 같은 인자로 부르기만 해서 동작을 바꾸지 않는다.
 * @param {import('node:test').TestContext} t 정리 훅을 걸 테스트 컨텍스트
 * @returns {object} 번들과 바인딩이 준비된 vm 컨텍스트
 */
function runtime(t){
 const context=vm.createContext({});run(context,BUNDLE);
 run(context,`globalThis.binding=JSON.parse(${JSON.stringify(JSON.stringify(BINDING))});
  (()=>{const start=Aster.NativeWorkspacePrepared.prototype.start;Aster.NativeWorkspacePrepared.prototype.start=function(...args){globalThis.heldTarget=this;return start.apply(this,args);};
   const write=Aster.NativeParamsImport.prototype.target;Aster.NativeParamsImport.prototype.target=function(...args){globalThis.heldImport=this;return write.apply(this,args);};})();`);
 t.after(()=>{context.nativeWorkspaceTargetDispose();context.nativeParamsTargetDispose();for(let registration=1;registration<=8;registration++)context.nativeParamsSourceAbort(registration);for(let ticket=1;ticket<=16;ticket++)context.nativeAsyncRelease(ticket);context.nativeModel?.dispose();});
 return context;
}

/**
 * 원본 런타임에서 워크스페이스 원본 admission을 끝까지 돌린다.
 * @param {object} source 원본 런타임
 * @param {string} [text] 원본 문서. 생략하면 지금 차트를 저장한 문서를 쓴다
 * @returns {{ticket:number,description:object,text:string}} 원본 티켓과 복사 설명
 */
function admitSource(source,text=source.nativeSaveWorkspace(source.binding)){
 const ticket=source.nativeWorkspaceSourceBegin(text,source.binding,0).ticket;
 for(let step=0;step<100000;step++){const row=source.nativeWorkspaceSourceStep(ticket,8,0);if(row.complete)return {ticket,description:row,text};}
 throw new Error('workspace source admission did not complete');
}

/**
 * 대상 런타임에 복원 대상을 만들고 원본 열을 모두 복사한 뒤 계산을 시작한다.
 * @param {object} source 원본 런타임
 * @param {object} target 대상 런타임
 * @param {{ticket:number,description:object}} admitted admitSource 결과
 * @returns {void}
 */
function startTarget(source,target,admitted){
 target.nativeWorkspaceTargetCreate(admitted.description.metadataJSON);
 for(const buffer of admitted.description.buffers)for(let offset=0;offset<buffer.length;offset+=WORKSPACE_CHUNK){
  const count=Math.min(WORKSPACE_CHUNK,buffer.length-offset);source.nativeWorkspaceSourceCheck(admitted.ticket,0);
  target.nativeAsyncTargetBuffer(buffer.slot,offset,count).set(source.nativeAsyncBuffer(admitted.ticket,buffer.slot,offset,count));
 }
 target.nativeAsyncStart();
}

/**
 * 대상 계산 단계를 끝까지(workspace-ready) 진행한다.
 * @param {object} target 대상 런타임
 * @returns {void}
 */
function stepTarget(target){
 for(let step=0;step<100000;step++)if(JSON.parse(target.nativeAsyncStep(4096)).complete)return;
 throw new Error('workspace target did not complete');
}

/**
 * 원본에서 대상으로 브리지 수준 복원을 끝까지 돌리고 대상 런타임에 게시한다.
 * @param {object} source 원본 런타임
 * @param {object} target 비어 있는 대상 런타임
 * @returns {{receipt:object,ready:object,retainedBytes:number}} 원본 끝 영수증, 대상 준비 영수증, 원본 retainedBytes
 */
function restore(source,target){
 const admitted=admitSource(source),retainedBytes=JSON.parse(admitted.description.metadataJSON).retainedBytes;
 startTarget(source,target,admitted);stepTarget(target);
 const receipt=source.nativeWorkspaceSourceFinish(admitted.ticket,0),ready=target.nativeWorkspaceTargetFinish();
 return {receipt,ready,retainedBytes};
}

/**
 * 지표 하나의 체크포인트 레코드를 색인 순서대로 정규 문자열로 읽는다. 경계 맵과 평범한 Map 모두에 쓴다.
 * @param {object} context 런타임
 * @param {string} expression 체크포인트 컨테이너를 가리키는 컨텍스트 안의 식
 * @returns {Array<[number,string]>} [색인, safeCheckpointStringify 문자열] 목록
 */
function checkpointTexts(context,expression){
 return JSON.parse(run(context,`JSON.stringify([...${expression}].sort((a,b)=>a[0]-b[0]).map(([index,state])=>[index,Aster.safeCheckpointStringify(state)]))`));
}

/**
 * 체크포인트 문자열 목록의 UTF-16 저장 바이트 합계를 구한다(NativeCheckpointMap.encodedBytes와 같은 셈).
 * @param {Array<[number,string]>} rows checkpointTexts 결과
 * @returns {number} 바이트 합계
 */
function encodedBytes(rows){return rows.reduce((sum,[,text])=>sum+text.length*2,0);}

/**
 * 시드 고정 원본(seededColumns(·,42))을 이어서 막대를 덧붙인다. nativeInit(n)의 앞부분과 같은 수열이다.
 * @param {object} context 런타임
 * @param {number} from 지금 막대 수(첫 덧붙일 색인)
 * @param {number} count 덧붙일 막대 수
 * @returns {void}
 */
function appendSeeded(context,from,count){
 run(context,`(()=>{const c=Aster.seededColumns(${from+count},42);if(nativeModel.store.length!==${from}||nativeModel.store.columns.close[${from-1}]!==c.close[${from-1}])throw new Error('seeded prefix mismatch');
  for(let i=${from};i<${from+count};i++)nativeDataEvent({kind:'append',bar:{time:c.time[i],open:c.open[i],high:c.high[i],low:c.low[i],close:c.close[i],volume:c.volume[i]}});})()`);
}

/**
 * 호스트가 게시 뒤 부르는 읽기 넷을 한 번에 부르고 결과를 문자열로 모은다.
 * 고치기 전에는 넷 모두 계산 중 'Native checkpoint total byte limit'로 실패했다(이식 지도 §3.8.5 (c)).
 * 장면의 layout.geometryKey는 저장소 식별 번호와 timeVersion(복원하면 원본+1)을 담아 런타임마다 달라서 비교에서 뺀다(설계 D4).
 * @param {object} context 런타임
 * @param {string} id 지표 id
 * @returns {{scene:string,valueAt:string,values:string,crosshair:string}} 읽기 결과
 */
function hostReads(context,id){
 run(context,'nativeModel.crosshair={x:600,y:300};');
 const last=run(context,'nativeModel.store.length-1'),scene=JSON.parse(context.nativeSceneJSON(1200,700));delete scene.layout.geometryKey;
 return {scene:JSON.stringify(scene),valueAt:JSON.stringify(run(context,`nativeCommand('indicatorValueAt',[${JSON.stringify(id)},'value',${last}])`)),
  values:run(context,`JSON.stringify(nativeCommand('indicatorValues',[${JSON.stringify(id)},'value']))`),crosshair:JSON.stringify(run(context,`nativeCommand('crosshairValues',[1200,700])`))};
}

/**
 * 게시 직후 엔진이 새 차트와 같은 평범한 컨테이너를 쓰는지 확인한다.
 * @param {object} context 게시가 끝난 런타임
 * @param {string} label 실패 메시지 앞머리
 * @returns {void}
 */
function assertOrdinaryEntries(context,label){
 assert.equal(run(context,'Object.getPrototypeOf(nativeModel.indicators.entries)===Map.prototype'),true,label+': entries must be an ordinary Map');
 assert.deepEqual(JSON.parse(run(context,'JSON.stringify([...nativeModel.indicators.entries].filter(([,e])=>Object.getPrototypeOf(e.checkpoints)!==Map.prototype).map(([id])=>id))')),[],label+': every checkpoints container must be an ordinary Map');
}

/**
 * 큰 복원 시나리오의 원본 차트(38,000개, sma(5000), 선 시리즈)를 만든다.
 * @param {object} source 빈 원본 런타임
 * @returns {void}
 */
function largeSource(source){
 run(source,`nativeInit(${LARGE_BARS},{series:[]});nativeAPI.addIndicator('slow','sma',{period:${LARGE_PERIOD}});nativeAPI.addSeries({id:'slow-line',type:'line',panel:'price',indicator:'slow'});`);
}

test('restored engine accepts appends like a fresh engine',t=>{
 const source=runtime(t),target=runtime(t);largeSource(source);
 const {ready}=restore(source,target);assert.equal(ready.status,'target-ready');
 // 게시 직후: 새 차트와 같은 레코드, 합계 24~32 MiB(복원은 진행 중 32 MiB 한도 안에서 성공한다)
 const expected=checkpointTexts(source,"nativeModel.indicators.entries.get('slow').checkpoints"),restored=checkpointTexts(target,"nativeModel.indicators.entries.get('slow').checkpoints");
 assert.equal(restored.length,Math.floor(LARGE_BARS/256)+1);assert.deepEqual(restored,expected);
 const restoredBytes=encodedBytes(restored);assert.ok(restoredBytes>=24*MIB&&restoredBytes<=CHECKPOINT_BUDGET_BYTES,`restored checkpoints ${restoredBytes} B must be within 24..32 MiB`);
 // 같은 20,000개를 새 차트(원본)와 복원 엔진에 덧붙이면 읽기 넷이 모두 성공하고 결과가 같다
 appendSeeded(source,LARGE_BARS,APPEND_BARS);appendSeeded(target,LARGE_BARS,APPEND_BARS);
 const reads=hostReads(target,'slow');assert.deepEqual(reads,hostReads(source,'slow'));
 assert.notEqual(reads.crosshair,'null','crosshair values must be calculated, not skipped');
 // 덧붙인 뒤 레코드는 옛 공유 한도(32 MiB)를 넘어 새 차트와 같은 만큼 자란다
 const grown=checkpointTexts(target,"nativeModel.indicators.entries.get('slow').checkpoints");
 assert.equal(grown.length,Math.floor((LARGE_BARS+APPEND_BARS)/256)+1);assert.ok(encodedBytes(grown)>CHECKPOINT_BUDGET_BYTES);
 assert.deepEqual(grown,checkpointTexts(source,"nativeModel.indicators.entries.get('slow').checkpoints"));
 // 게시 직후 상태: 평범한 컨테이너, 복원용 공유 예산 해제
 assertOrdinaryEntries(target,'restored engine');
 assert.equal(run(target,'heldTarget.checkpointBudget.usedBytes'),0,'restore budget must be released at publish');
});

test('restored source accounting equals a fresh source',t=>{
 const source=runtime(t),target=runtime(t),again=runtime(t);
 run(source,"nativeInit(3000,{series:[]});nativeAPI.addIndicator('ema','ema',{period:20});nativeAPI.addIndicator('sma','sma',{period:50});");
 const fresh=restore(source,target),restored=restore(target,again);
 // 새 차트 회계: 평범한 Map 레코드마다 encoded + nodes*32 + 128(이식 지도 §3.8.5)
 assert.equal(fresh.receipt.checkpointBytes,47134);
 assert.deepEqual({checkpointBytes:restored.receipt.checkpointBytes,sourceBytes:restored.receipt.sourceBytes,drawingBytes:restored.receipt.drawingBytes,retainedBytes:restored.retainedBytes},
  {checkpointBytes:fresh.receipt.checkpointBytes,sourceBytes:fresh.receipt.sourceBytes,drawingBytes:fresh.receipt.drawingBytes,retainedBytes:fresh.retainedBytes});
 assertOrdinaryEntries(again,'twice restored engine');
});

/**
 * params 비동기 작업을 원본 admission까지 진행한다.
 * @param {object} source 원본 런타임
 * @param {string} id 지표 id
 * @param {object} params 새 params(컨텍스트 밖 값이라 안에서 다시 만든다)
 * @param {number} registration 호스트 등록 번호(증가해야 한다)
 * @returns {{ticket:number,registration:number,metadataJSON:string}} 작업 상태
 */
function beginParams(source,id,params,registration){
 const begun=source.nativeParamsSourceBegin(id,run(source,`(${JSON.stringify(params)})`),REVISION,805306368,registration);let admission;
 do{admission=source.nativeParamsSourceStep(begun.ticket,8,REVISION);}while(!admission.complete);
 return {ticket:begun.ticket,registration,metadataJSON:admission.metadataJSON};
}

/**
 * 작업 런타임에서 새 params를 계산하고, 원본이 결과 설명을 받아 출력 버퍼를 모두 옮겨 쓴다.
 * @param {object} source 원본 런타임
 * @param {object} worker 비어 있는 작업 런타임
 * @param {{ticket:number,registration:number,metadataJSON:string}} job beginParams 결과
 * @returns {object} 작업 런타임의 결과 설명(descriptor)
 */
function computeParams(source,worker,job){
 worker.nativeParamsTargetCreate(job.metadataJSON);const meta=JSON.parse(job.metadataJSON);
 for(let slot=0;slot<6;slot++)for(let at=0;at<meta.length;at+=PARAMS_CHUNK){const count=Math.min(PARAMS_CHUNK,meta.length-at);worker.nativeAsyncTargetBuffer(slot,at,count).set(source.nativeAsyncBuffer(job.ticket,slot,at,count));}
 worker.nativeParamsTargetStart();while(!worker.nativeParamsTargetStep(PARAMS_CHUNK).complete){/* 작업 런타임 계산을 끝까지 진행한다 */}
 const text=worker.nativeParamsTargetDescriptor(),descriptor=JSON.parse(text);source.nativeParamsSourceReceive(job.ticket,text,REVISION);
 for(let slot=0;slot<descriptor.outputs.length;slot++)for(let at=0;at<descriptor.capacity;at+=PARAMS_CHUNK){const count=Math.min(PARAMS_CHUNK,descriptor.capacity-at);source.nativeParamsSourceArmWrite(job.ticket,slot,at,count,REVISION);source.nativeAsyncTargetBuffer(slot,at,count).set(worker.nativeAsyncBuffer(job.registration,slot,at,count));}
 return descriptor;
}

/**
 * 작업 런타임의 체크포인트를 원본으로 옮긴다.
 * @param {object} source 원본 런타임
 * @param {object} worker 작업 런타임
 * @param {{ticket:number}} job 작업 상태
 * @param {number} from 첫 서수
 * @param {number} to 끝 서수(포함하지 않음)
 * @returns {void}
 */
function importCheckpoints(source,worker,job,from,to){
 for(let ordinal=from;ordinal<to;ordinal++){const row=worker.nativeParamsTargetCheckpoint(ordinal);source.nativeParamsSourceCheckpoint(job.ticket,row.index,row.text,REVISION);}
}

/**
 * 받은 결과를 검증하고 작업 런타임을 정리한 뒤 게시 준비까지 진행한다.
 * @param {object} source 원본 런타임
 * @param {object} worker 작업 런타임
 * @param {{ticket:number}} job 작업 상태
 * @returns {void}
 */
function prepareParams(source,worker,job){
 while(!source.nativeParamsSourceValidate(job.ticket,PARAMS_CHUNK,REVISION).complete){/* 원본 쪽 출력 검증을 끝까지 진행한다 */}
 worker.nativeParamsTargetDispose();source.nativeParamsSourcePrepare(job.ticket,REVISION);
}

/**
 * params 비동기 작업을 처음부터 게시까지 돌린다.
 * @param {object} source 원본 런타임
 * @param {object} worker 작업 런타임
 * @param {string} id 지표 id
 * @param {object} params 새 params
 * @param {number} registration 호스트 등록 번호
 * @returns {object} 게시 상태 값
 */
function publishParams(source,worker,id,params,registration){
 const job=beginParams(source,id,params,registration),descriptor=computeParams(source,worker,job);
 importCheckpoints(source,worker,job,0,descriptor.checkpointCount);prepareParams(source,worker,job);
 return source.nativeParamsSourcePublish(job.ticket,REVISION);
}

test('params publish leaves ordinary entries',t=>{
 // 다른 지표('other', 평범한 Map 약 23 MiB)가 있으면 params 가져오기 원장은 32 MiB에서 그만큼 뺀 값이다.
 // 고치기 전에는 게시된 'slow'가 그 원장에 묶여, 같은 20,000개 append 뒤 계산이 'Native checkpoint total byte limit'로 실패했다.
 const bars=36000,source=runtime(t),worker=runtime(t);
 run(source,`nativeInit(${bars},{series:[]});nativeAPI.addIndicator('other','sma',{period:${LARGE_PERIOD}});nativeAPI.addIndicator('slow','sma',{period:10});nativeAPI.addSeries({id:'slow-line',type:'line',panel:'price',indicator:'slow'});globalThis.entriesBefore=nativeModel.indicators.entries;`);
 const status=publishParams(source,worker,'slow',{period:1500},1);assert.equal(status.status,'committed');
 // 게시 직후 레코드는 새로 계산한 sma(1500)과 같다
 const fresh="(globalThis.oracle=new Aster.IndicatorEngine(nativeModel.store),oracle.add('x','sma',{period:1500}),oracle.entries.get('x').checkpoints)";
 assert.deepEqual(checkpointTexts(source,"nativeModel.indicators.entries.get('slow').checkpoints"),checkpointTexts(source,fresh));run(source,'oracle.dispose()');
 // 같은 append 뒤 읽기 넷이 성공하고 새로 계산한 값과 같다
 appendSeeded(source,bars,APPEND_BARS);hostReads(source,'slow');
 assert.equal(run(source,`(()=>{const e=new Aster.IndicatorEngine(nativeModel.store);try{return JSON.stringify(Array.from(e.add('x','sma',{period:1500}).outputs.value,v=>Number.isFinite(v)?v:null));}finally{e.dispose();}})()`),run(source,"JSON.stringify(nativeCommand('indicatorValues',['slow','value']))"));
 assert.equal(run(source,"nativeModel.indicators.entries.get('slow').checkpoints.size"),Math.floor((bars+APPEND_BARS)/256)+1);
 // 게시 직후 상태: 같은 entries Map, 평범한 체크포인트 Map, 가져오기 원장 해제
 assert.equal(run(source,'nativeModel.indicators.entries===entriesBefore'),true);assertOrdinaryEntries(source,'params publish');
 assert.equal(run(source,'heldImport.budget.usedBytes'),0,'params staging budget must be released at publish');
});

/**
 * 원본 문서 맨 앞에 문서에만 있는 지표를 넣는다. 대상 계산 단계는 문서 순서로 계산하므로 이 지표가 먼저 돈다.
 * @param {string} text 원본 문서
 * @param {object} study 넣을 지표 항목(id, name, params, outputs, plotOffsets)
 * @returns {string} 고친 문서
 */
function withLeadingStudy(text,study){const doc=JSON.parse(text);doc.indicators.unshift(study);return JSON.stringify(doc);}

test('cancelled or failed restore releases budget',t=>{
 const source=runtime(t),target=runtime(t);largeSource(source);
 // 취소: 대상 계산 단계에서 레코드가 쌓인 뒤 호스트가 대상과 원본을 버린다
 let admitted=admitSource(source);startTarget(source,target,admitted);
 for(let step=0;step<1000&&!(run(target,'heldTarget.phase')==='calculate'&&run(target,'heldTarget.checkpointBudget.usedBytes')>0);step++)target.nativeAsyncStep(4096);
 assert.ok(run(target,'heldTarget.checkpointBudget.usedBytes')>0,'cancellation must happen after checkpoints were charged');
 run(target,'globalThis.cancelled=heldTarget;');assert.equal(target.nativeWorkspaceTargetDispose(),true);assert.equal(source.nativeWorkspaceSourceDispose(admitted.ticket),true);
 assert.equal(run(target,'cancelled.closed&&cancelled.checkpointBudget.usedBytes'),0);
 // stale: 계산 중 대상 원본이 바뀌면 다음 단계가 실패하고 대상을 버린다
 admitted=admitSource(source);startTarget(source,target,admitted);
 for(let step=0;step<1000&&!(run(target,'heldTarget.phase')==='calculate'&&run(target,'heldTarget.checkpointBudget.usedBytes')>0);step++)target.nativeAsyncStep(4096);
 run(target,'globalThis.stale=heldTarget;(()=>{const bar=stale.store.at(0);stale.store.update(0,{...bar,volume:bar.volume+1});})();');
 assert.throws(()=>target.nativeAsyncStep(4096),/Native workspace target changed/);source.nativeWorkspaceSourceDispose(admitted.ticket);
 assert.equal(run(target,'stale.closed&&stale.checkpointBudget.usedBytes'),0);assert.equal(target.nativeWorkspaceTargetDispose(),true);assert.equal(target.nativeWorkspaceTargetDispose(),false);
 // 실패: 문서에만 있는 sma(10000)은 긴 소수 종가에서 레코드가 256 KiB를 넘는다. 진행 중 레코드 한도는 그대로다
 admitted=admitSource(source,withLeadingStudy(source.nativeSaveWorkspace(source.binding),{id:'huge',name:'sma',params:{period:10000},outputs:['value'],plotOffsets:{}}));startTarget(source,target,admitted);
 assert.throws(()=>stepTarget(target),{name:'RangeError',message:'Native checkpoint record byte limit'});source.nativeWorkspaceSourceDispose(admitted.ticket);
 assert.equal(run(target,'heldTarget.closed&&heldTarget.checkpointBudget.usedBytes'),0);assert.equal(target.nativeModel,undefined);
 target.nativeWorkspaceTargetDispose();
 // 같은 대상 런타임에서 새 복원이 같은 32 MiB 예산으로 성공한다(24 MiB 넘는 레코드를 다시 담는다)
 const {ready}=restore(source,target);assert.equal(ready.status,'target-ready');
 assert.equal(run(target,'heldTarget.checkpointBudget.maxBytes'),CHECKPOINT_BUDGET_BYTES);
 assert.ok(encodedBytes(checkpointTexts(target,"nativeModel.indicators.entries.get('slow').checkpoints"))>=24*MIB);
});

test('cancelled, stale or failed params jobs release their staged budget',t=>{
 const source=runtime(t),worker=runtime(t);
 run(source,"nativeInit(1000,{series:[]});nativeAPI.addIndicator('s','sma',{period:20});globalThis.oldEntry=nativeModel.indicators.entries.get('s');");
 // 취소: 체크포인트 일부를 받은 뒤 호스트가 등록 번호로 중단한다
 let job=beginParams(source,'s',{period:30},1),descriptor=computeParams(source,worker,job);importCheckpoints(source,worker,job,0,2);
 run(source,'globalThis.aborted=heldImport;');assert.ok(run(source,'aborted.budget.usedBytes')>0);
 assert.equal(source.nativeParamsSourceAbort(1).status,'aborted');worker.nativeParamsTargetDispose();
 assert.equal(run(source,'aborted.budget.usedBytes'),0);assert.equal(run(source,"nativeModel.indicators.entries.get('s')===oldEntry"),true);
 // stale: 게시 준비 뒤 원본 데이터가 바뀌면 게시가 실패하고 옛 항목이 남는다
 job=beginParams(source,'s',{period:30},2);descriptor=computeParams(source,worker,job);importCheckpoints(source,worker,job,0,descriptor.checkpointCount);prepareParams(source,worker,job);
 run(source,'globalThis.staleImport=heldImport;(()=>{const bar=nativeModel.store.at(nativeModel.store.length-1);nativeDataEvent({kind:"update",bar:{...bar,volume:bar.volume+1}});})();');
 assert.throws(()=>source.nativeParamsSourcePublish(job.ticket,REVISION),/stale/);assert.equal(source.nativeParamsSourceStatus(2).status,'failed');
 assert.equal(run(source,'staleImport.budget.usedBytes'),0);assert.equal(run(source,"nativeModel.indicators.entries.get('s')===oldEntry"),true);
 // 실패: 검증을 통과하지 못한 체크포인트를 받으면 작업이 실패한다
 job=beginParams(source,'s',{period:30},3);descriptor=computeParams(source,worker,job);importCheckpoints(source,worker,job,0,1);run(source,'globalThis.failedImport=heldImport;');
 assert.throws(()=>source.nativeParamsSourceCheckpoint(job.ticket,256,'{"broken":true}',REVISION));assert.equal(source.nativeParamsSourceStatus(3).status,'failed');worker.nativeParamsTargetDispose();
 assert.equal(run(source,'failedImport.budget.usedBytes'),0);assert.equal(run(source,"nativeModel.indicators.entries.get('s')===oldEntry"),true);
 // 그 뒤 새 작업은 게시되고, 게시된 항목은 평범한 Map이며 가져오기 원장도 해제된다
 assert.equal(publishParams(source,worker,'s',{period:30},4).status,'committed');
 assertOrdinaryEntries(source,'params publish after failures');assert.equal(run(source,'heldImport.budget.usedBytes'),0);
});
