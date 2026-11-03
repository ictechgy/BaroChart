import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
 SIZE_BUDGET,
 PORT_SCOPE,
 scenarioForecast,
 naiveLocDiagnostic,
 parseAppleSize,
 portablePath,
 validateReport,
 measurementSourceProvenance,
} from '../scripts/rust/measure-size.mjs';

test('forecast separates measured scaffold from the unbounded design-prior scenario',()=>{
 const forecast=scenarioForecast({jsOnlyBytes:1_000_000,dualScaffoldBytes:2_200_000,designPriorRustBytes:2_621_440,budgetBytes:SIZE_BUDGET});
 assert.deepEqual(forecast.rustContributionBytes,{measuredScaffold:1_200_000,designPriorScenario:2_621_440});
 assert.deepEqual(forecast.dualBytes,{measuredScaffold:2_200_000,designPriorScenario:3_621_440});
 assert.equal(forecast.budget.actualExceeds,false);
 assert.equal(forecast.budget.designPriorScenarioExceeds,true);
 assert.equal(forecast.method,'actual measured scaffold plus an independent 2.5 MiB design-prior scenario; the scenario is not a bound or probability interval');
 assert.equal('bytesPerLine' in forecast,false);
});

test('naive LOC projection is explicit and warns that fixed runtime overhead makes it unreliable',()=>{
 const diagnostic=naiveLocDiagnostic({linkedRustDeltaBytes:1_200_000,compiledScaffoldRustLines:4_000,totalScopeLines:37_850,jsOnlyBytes:1_000_000,budgetBytes:SIZE_BUDGET});
 assert.deepEqual(diagnostic.denominator,{shippingCrateSrcPhysicalLinesAllCfgBranches:4_000,crates:['barochart-js','barochart-core','barochart-bridge','barochart-ffi']});
 assert.equal(diagnostic.bytesPerCompiledScaffoldLine,300);
 assert.equal(diagnostic.projectedRustBytes,11_355_000);
 assert.equal(diagnostic.projectedDualBytes,12_355_000);
 assert.equal(diagnostic.exceedsBudget,true);
 assert.match(diagnostic.warning,/fixed std\/allocator\/FFI overhead/i);
 assert.equal(diagnostic.useForDecision,false);
});

test('authoritative port scope uses the corrected Tier-A estimate without claiming precision',()=>{
 assert.deepEqual(PORT_SCOPE,{stableRustLinesEstimate:27_850,tierANetNewRustLinesEstimate:10_000,totalRustLinesEstimate:37_850,kind:'reader-estimate-not-measurement'});
});

test('Apple size parser extracts executable and __TEXT bytes from size -m output',()=>{
 const output=`Segment __PAGEZERO: 0\nSegment __TEXT: 24576\n\tSection __text: 8192\nSegment __LINKEDIT: 4096\ntotal 28672\n`;
 assert.deepEqual(parseAppleSize(output,31_744),{fileBytes:31_744,textSegmentBytes:24_576});
 assert.throws(()=>parseAppleSize('Segment __DATA: 10',20),/__TEXT/);
});

test('portable paths never persist a user checkout prefix',()=>{
 assert.equal(portablePath('/work/repo/rust/target/a','/work/repo'),'$REPO/rust/target/a');
 assert.equal(portablePath('/opt/android/ndk/tool','/work/repo','/opt/android/ndk'),'$NDK/tool');
});

test('report validator requires both ABIs, four profiles, provenance, iOS link delta, and no absolute user paths',()=>{
 const profiles=['opt-s-panic-unwind','opt-3-panic-unwind','opt-s-panic-abort','opt-3-panic-abort'];
 const artifacts=Object.fromEntries(['arm64-v8a','x86_64'].map(abi=>[abi,Object.fromEntries(profiles.map(profile=>[profile,{dual:{bytes:1,sha256:'a'},rustOnly:{bytes:1,sha256:'b'},jsOnly:{bytes:1,sha256:'c'}}]))]));
 const report={schema:'barochart.rust-core-size',version:1,budgetBytes:SIZE_BUDGET,source:{sha256:'source',scope:PORT_SCOPE},android:{abis:['arm64-v8a','x86_64'],profiles,artifacts},ios:{baseline:{fileBytes:1,textSegmentBytes:1,sha256:'d'},rustReferenced:{fileBytes:2,textSegmentBytes:2,sha256:'e'},delta:{fileBytes:1,textSegmentBytes:1}},commands:[['$NODE','scripts/rust/cargo.mjs','build']],forecast:{'arm64-v8a':{},x86_64:{}}};
 assert.equal(validateReport(report),true);
 report.commands.push(['/Users/person/private/tool']);
 assert.throws(()=>validateReport(report),/absolute user path/);
});

test('committed measurement report is complete and distinguishes shipping from comparison profiles',async()=>{
 const report=JSON.parse(await readFile(new URL('../docs/measurements/rust-core-size.json',import.meta.url)));
 assert.equal(validateReport(report),true);
 for(const abi of report.android.abis){
  const shipping=report.android.artifacts[abi]['opt-s-panic-unwind'];
  assert.equal(shipping.targetProfile.shipping,true);
  assert.equal(shipping.targetProfile.panic,'unwind');
  assert.equal(shipping.budget.dualExceeds,false);
  assert.equal(report.android.artifacts[abi]['opt-s-panic-abort'].targetProfile.shipping,false);
  assert.match(report.android.artifacts[abi]['opt-s-panic-abort'].targetProfile.qualification,/comparison only/);
  assert.equal(report.forecast[abi].budget.designPriorScenarioExceeds,true);
  assert.equal(report.naiveLocDiagnostic[abi].useForDecision,false);
 }
 assert.ok(report.ios.delta.fileBytes>0&&report.ios.delta.textSegmentBytes>0);
 assert.equal(report.conclusions.actualShippingScaffoldWithinBudget,true);
 const current=await measurementSourceProvenance();
 assert.equal(report.source.sha256,current.sha256,'measurement source changed after the recorded build');
});
