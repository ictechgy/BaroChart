import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
import {QUICKJS_NATIVE_SOURCE_SCENARIOS,validateQuickjsNativeSourceResults} from '../scripts/quickjs-cloud-result.mjs';

// Fixed oracle, deliberately independent of fixture output and runner constants.
const EXPECTED_SCENARIOS=Object.freeze([
 'source ingestion lease acquired','raw checkpoint admission is lazy','bounded source admission progress',
 'exact raw checkpoint footprint','source backing allocations charged once','admission avoids source recalculation',
 'source cache identities and values preserved','empty ingestion ring logical reservation','captured metadata and retained admission',
 'completed admission does not double charge','source slices borrow live buffers','target transfer owns separate buffers',
 'bounded source-to-target preparation','source finished receipt','source finish releases lease and references',
 'finished source capture rejects reuse','source listeners and undetached columns survive','source-to-target canonical save',
 'fractional view and drawing anchors','target transient UI reset','owned target columns match source',
 'empty ingestion policy cursor and pause preserved','restored ema/value','restored rsi/value',
 'restored bounded native checkpoint ownership','encoded source accounting avoids decode','encoded capture cleanup preserves owner',
 'target wrapper preserves returned ownership','source mutation stays independent','corrected ema/value','corrected rsi/value',
 'target correction stays independent','empty source admission','empty source-to-target canonical save','empty ema/value','empty rsi/value',
 'empty source ingestion state preserved','empty source cleanup and target ownership','combined budget exact boundary',
 'combined budget rejects one byte short','budget failure precedes target allocation','copy before admission rejected',
 'early copy failure releases source','lease reused after early copy failure','incomplete transfer cannot finish',
 'incomplete transfer releases source','partial cancellation releases source','lease reused after cancellation',
 'uncopyable raw checkpoint rejected','uncopyable record avoids getters and releases lease','lease reused after raw checkpoint failure',
 'raw checkpoint record byte limit','oversized raw record releases lease','stale data rejected','stale data releases source',
 'lease reused after stale data','stale UI rejected','stale UI releases source','lease reused after stale UI',
 'stale revision rejected','stale revision releases source','lease reused after stale revision',
 'final source freshness checked after target ready','stale ready target discarded independently',
 'lease reused after final freshness failure','incremental admission detects UI change','admission stale releases source',
 'host registration binds source capture','duplicate registration cannot overwrite source','wrong registration preserves source',
 'lost begin response can abort by registration','lost abort response retries idempotently',
 'retired registration cannot be reused','old registration cannot abort new job',
 'all captures models leases and listeners released'
]);
const EXPECTED_CHECKS=75;
function receipt(){return [{case:'native-workspace-source-quickjs',passed:true,checks:EXPECTED_CHECKS,scenarios:[...EXPECTED_SCENARIOS]},
 ...['workspace-runtime-cleanup','oom-cleanup','interrupt-cleanup'].map(name=>({case:name,passed:true,peakRequestedBytes:100,finalLiveBytes:0,finalAllocationCount:0}))];}

test('standalone native source fixture evaluates the real built bundle in a bare Node VM',async()=>{
 const context=vm.createContext({});
 vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 const result=JSON.parse(vm.runInContext(await readFile(new URL('./fixtures/native-workspace-source-quickjs.js',import.meta.url),'utf8'),context,{timeout:5000}));
 assert.equal(result.case,'native-workspace-source-quickjs');assert.equal(result.passed,true);
 assert.equal(result.checks,EXPECTED_CHECKS);assert.equal(EXPECTED_SCENARIOS.length,EXPECTED_CHECKS);
 assert.deepEqual(result.scenarios,EXPECTED_SCENARIOS);assert.equal(new Set(result.scenarios).size,EXPECTED_CHECKS);
 assert.match(result.scope,/builtin source capture and isolated target/);assert.match(result.scope,/no host runtime swap, SDK restore, JNI\/JSC or device/);
 const probe=context.nativeWorkspaceSourceQuickjsProbe;
 assert.equal(probe.models.length,5);assert.equal(probe.stores.length,8);assert.equal(probe.captures.length,23);assert.equal(probe.targets.length,3);assert.equal(probe.sessions.length,5);
 assert.notEqual(probe.sourceModel,probe.targetModel);assert.notEqual(probe.sourceStore,probe.targetStore);
 assert.equal(probe.sourceStore.length,513);assert.equal(probe.targetStore.length,513);
 assert.equal(probe.sourceModel.theme.background,'#334455ff');assert.equal(probe.targetModel.theme.background,'#112233');
 assert.notEqual(probe.sourceStore.at(3).volume,probe.targetStore.at(3).volume);
 assert.notEqual(probe.sourceStore.at(5).close,probe.targetStore.at(5).close);
 for(const model of probe.models){assert.equal(model.disposed,true);assert.equal(model.dataIngestion,null);}
 for(const store of probe.stores)assert.equal(store.listeners.size,0,'every source, target and fresh oracle drops listeners');
 for(const capture of probe.captures){
  assert.equal(capture.closed,true);assert.equal(capture.lease,null);
  for(const key of ['api','model','input','size','session','refs','before','document','binding','metadataJSON','ingestionText','recordIterator','seenDrawings','seenFrames'])assert.equal(capture[key],null,key);
  for(const key of ['records','frames','buffers'])assert.equal(capture[key].length,0,key);
 }
 for(const session of probe.sessions){
  assert.equal(session.closed,true);assert.equal(session.leased,false);assert.equal(session.model,null);assert.equal(session.store,null);
  assert.equal(Object.keys(session.columns).length,0);assert.equal(session.kinds,null);assert.equal(session.count,0);
 }
 for(const target of probe.targets){
  assert.equal(target.closed,true);assert.equal(target.checkpointBudget.usedBytes,0);assert.equal(target.model,null);assert.equal(target.store,null);
  assert.equal(Object.keys(target.columns).length,0);assert.equal(target.workspaceEntries.length,0);assert.equal(target.workspaceColumnRefs.length,0);
 }
 for(const key of ['time','open','high','low','close','volume']){
  assert.notEqual(probe.sourceStore.columns[key].buffer,probe.targetStore.columns[key].buffer);
  assert.ok(probe.sourceStore.columns[key].buffer.byteLength>0,'source buffers remain attached after capture and cleanup');
 }
 // No Node/web shims or native host publication are supplied by this test.
 for(const key of ['TextEncoder','TextDecoder','Buffer','process','require','setTimeout','structuredClone','nativeModel','nativeAPI','nativeInput'])assert.equal(context[key],undefined,key);
});

test('native source runner coverage matches the independent fixed scenario oracle',()=>{
 assert.equal(QUICKJS_NATIVE_SOURCE_SCENARIOS.length,EXPECTED_CHECKS);
 assert.deepEqual([...QUICKJS_NATIVE_SOURCE_SCENARIOS].sort(),[...EXPECTED_SCENARIOS].sort());
 assert.equal(new Set(QUICKJS_NATIVE_SOURCE_SCENARIOS).size,EXPECTED_CHECKS);
});
test('native source result gate accepts complete deterministic coverage and cleanup',()=>{
 const results=receipt();assert.equal(validateQuickjsNativeSourceResults(results),results);
});
test('native source result gate accepts exact allocator limits',()=>{
 const results=receipt();results[1].peakRequestedBytes=128*1024*1024;results[2].peakRequestedBytes=results[3].peakRequestedBytes=8*1024*1024;
 assert.equal(validateQuickjsNativeSourceResults(results),results);
});
for(const [name,mutate] of Object.entries({
 'wrong fixture case':r=>r[0].case='native-workspace-target-quickjs',
 'failed fixture':r=>r[0].passed=false,
 'nonboolean success':r=>r[0].passed='true',
 'null fixture':r=>r[0]=null,
 'missing checks':r=>delete r[0].checks,
 'reduced checks':r=>r[0].checks=67,
 'extra checks':r=>r[0].checks=69,
 'string checks':r=>r[0].checks='75',
 'missing scenario':r=>r[0].scenarios.pop(),
 'extra scenario':r=>r[0].scenarios.push('unverified native host swap'),
 'duplicate scenario':r=>r[0].scenarios[1]=r[0].scenarios[0],
 'unknown scenario':r=>r[0].scenarios[0]='SDK restore complete',
 'nonarray scenarios':r=>r[0].scenarios={},
 'missing scenarios':r=>delete r[0].scenarios,
 'missing runtime cleanup':r=>r.splice(1,1),
 'missing OOM cleanup':r=>r.splice(2,1),
 'missing interrupt cleanup':r=>r.pop(),
 'duplicate cleanup':r=>r[3]=r[2],
 'extra cleanup case':r=>r.push({...r[3]}),
 'reordered cleanup':r=>[r[1],r[2]]=[r[2],r[1]],
 'null cleanup':r=>r[1]=null,
 'failed runtime cleanup':r=>r[1].passed=false,
 'failed OOM cleanup':r=>r[2].passed=false,
 'failed interrupt cleanup':r=>r[3].passed=false,
 'nonboolean cleanup success':r=>r[2].passed=1,
 'nonzero live bytes':r=>r[1].finalLiveBytes=1,
 'nonzero allocation count':r=>r[2].finalAllocationCount=1,
 'missing cleanup accounting':r=>delete r[3].finalLiveBytes,
 'string cleanup accounting':r=>r[3].finalAllocationCount='0',
 'invalid peak':r=>r[3].peakRequestedBytes=NaN,
 'zero peak':r=>r[1].peakRequestedBytes=0,
 'fractional peak':r=>r[2].peakRequestedBytes=1.5,
 'string peak':r=>r[3].peakRequestedBytes='100',
 'runtime peak above limit':r=>r[1].peakRequestedBytes=128*1024*1024+1,
 'OOM peak above limit':r=>r[2].peakRequestedBytes=8*1024*1024+1,
 'interrupt peak above limit':r=>r[3].peakRequestedBytes=8*1024*1024+1
}))test('native source result gate rejects '+name,()=>{
 const results=receipt();mutate(results);assert.throws(()=>validateQuickjsNativeSourceResults(results));
});
for(const [name,value] of [['null',null],['object',{}],['empty',[]]])test('native source result gate rejects '+name+' result input',()=>assert.throws(()=>validateQuickjsNativeSourceResults(value)));
