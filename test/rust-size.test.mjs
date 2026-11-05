import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
 SIZE_BUDGET,
 PORT_SCOPE,
 scenarioForecast,
 naiveLocDiagnostic,
 androidSdkSize,
 parseAppleSize,
 portablePath,
 validateReport,
 measurementSourceProvenance,
} from '../scripts/rust/measure-size.mjs';

test('forecast separates measured scaffold from the unbounded design-prior scenario',()=>{
 assert.equal(SIZE_BUDGET,5_242_880);
 const forecast=scenarioForecast({jsOnlyBytes:1_000_000,dualScaffoldBytes:2_200_000,designPriorRustBytes:2_621_440,budgetBytes:SIZE_BUDGET});
 assert.deepEqual(forecast.rustContributionBytes,{measuredScaffold:1_200_000,designPriorScenario:2_621_440});
 assert.deepEqual(forecast.dualBytes,{measuredScaffold:2_200_000,designPriorScenario:3_621_440});
 assert.equal(forecast.budget.actualExceeds,false);
 assert.equal(forecast.budget.designPriorScenarioExceeds,false);
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

test('a measured scaffold above the design prior does not rewrite the independent scenario',()=>{
 const forecast=scenarioForecast({jsOnlyBytes:1_000_000,dualScaffoldBytes:4_000_000,designPriorRustBytes:2_621_440});
 assert.deepEqual(forecast.rustContributionBytes,{measuredScaffold:3_000_000,designPriorScenario:2_621_440});
 assert.deepEqual(forecast.dualBytes,{measuredScaffold:4_000_000,designPriorScenario:3_621_440});
});

test('LOC diagnostics reject invalid line counts instead of persisting nonfinite JSON fields',()=>{
 for(const compiledScaffoldRustLines of [0,-1,NaN,Infinity,0.5]){
  assert.throws(()=>naiveLocDiagnostic({linkedRustDeltaBytes:1_000,compiledScaffoldRustLines,totalScopeLines:37_850,jsOnlyBytes:1_000}),RangeError);
 }
 for(const totalScopeLines of [0,-1,NaN,Infinity]){
  assert.throws(()=>naiveLocDiagnostic({linkedRustDeltaBytes:1_000,compiledScaffoldRustLines:1_000,totalScopeLines,jsOnlyBytes:1_000}),RangeError);
 }
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

test('Android SDK metric includes shared package entries even when the native .so fits',()=>{
 const metric=androidSdkSize({
  abi:'arm64-v8a',profile:'opt-s-panic-unwind',configuration:'dual',quickjs:true,
  nativeSo:{bytes:SIZE_BUDGET-1,sha256:'native'},classesJar:{bytes:2,sha256:'jar'},coreAsset:{bytes:3,sha256:'core'},
  sourceSha256:'source',packagingSha256:'packaging',
 });
 assert.equal(metric.bytes,SIZE_BUDGET+4);
 assert.equal(metric.budget.exceeds,true);
 assert.equal(metric.budget.remaining,-4);
 assert.deepEqual(Object.keys(metric.entries),['jni/arm64-v8a/libbarochart.so','classes.jar','assets/aster-core.js']);
});

test('report validator requires both ABIs, four profiles, provenance, iOS link delta, and no absolute user paths',()=>{
 const profiles=['opt-s-panic-unwind','opt-3-panic-unwind','opt-s-panic-abort','opt-3-panic-abort'];
 const packaged=(abi,profile,configuration,quickjs)=>({bytes:quickjs?3:2,entries:{['jni/'+abi+'/libbarochart.so']:{bytes:1,sha256:configuration==='dual'?'a':configuration==='rustOnly'?'b':'c',provenance:{kind:'native'}},'classes.jar':{bytes:1,sha256:'b',provenance:{kind:'java',packagingSha256:'packaging',profile,configuration}},...(quickjs?{'assets/aster-core.js':{bytes:1,sha256:'c',provenance:{kind:'asset',configuration}}}:{})},provenance:{sourceSha256:'source',packagingSha256:'packaging',abi,profile,configuration,quickjs},budget:{bytes:SIZE_BUDGET,exceeds:false,remaining:SIZE_BUDGET-(quickjs?3:2)}});
 const artifacts=Object.fromEntries(['arm64-v8a','x86_64'].map(abi=>[abi,Object.fromEntries(profiles.map(profile=>[profile,{dual:{bytes:1,sha256:'a'},rustOnly:{bytes:1,sha256:'b'},jsOnly:{bytes:1,sha256:'c'},packaged:packaged(abi,profile,'dual',true),rustOnlyPackaged:packaged(abi,profile,'rustOnly',false),jsOnlyPackaged:packaged(abi,profile,'jsOnly',true)}]))]));
 const report={schema:'barochart.rust-core-size',version:1,budgetBytes:SIZE_BUDGET,ownerBudgetDecision:{date:'2026-11-04',previousBudgetBytes:3_145_728,currentBudgetBytes:SIZE_BUDGET,noBinaryRebuild:true,defaultBackend:'JavaScript pending device gates'},source:{sha256:'source',androidPackagingSha256:'packaging',coreAssetSha256:'core',scope:PORT_SCOPE},android:{abis:['arm64-v8a','x86_64'],profiles,artifacts},ios:{baseline:{fileBytes:1,textSegmentBytes:1,sha256:'d'},rustReferenced:{fileBytes:2,textSegmentBytes:2,sha256:'e'},delta:{fileBytes:1,textSegmentBytes:1}},commands:[['$NODE','scripts/rust/cargo.mjs','build']],forecast:{'arm64-v8a':{},x86_64:{}}};
 assert.equal(validateReport(report),true);
 assert.throws(()=>validateReport(report,{sourceSha256:'different'}),/source changed during measurement/);
 report.android.artifacts['arm64-v8a'][profiles[0]].packaged.entries['classes.jar'].sha256=undefined;
 assert.throws(()=>validateReport(report),/missing Android package entry/);
 report.android.artifacts['arm64-v8a'][profiles[0]].packaged.entries['classes.jar'].sha256='b';
 report.commands.push(['/Users/person/private/tool']);
 assert.throws(()=>validateReport(report),/absolute user path/);
});

test('committed measurement report is complete and exactly fresh',async()=>{
 const report=JSON.parse(await readFile(new URL('../docs/measurements/rust-core-size.json',import.meta.url)));
 const current=await measurementSourceProvenance();
 assert.equal(report.source.sha256,current.sha256,'measurement source changed after the recorded build');
 assert.equal(report.source.androidPackagingSha256,current.androidPackagingSha256,'Android packaging source changed after the recorded build');
 assert.equal(report.source.coreAssetSha256,current.coreAssetSha256,'core asset changed after the recorded build');
 assert.equal(validateReport(report),true);
 for(const abi of report.android.abis){
  const shipping=report.android.artifacts[abi]['opt-s-panic-unwind'];
  assert.equal(shipping.targetProfile.shipping,true);
  assert.equal(shipping.targetProfile.panic,'unwind');
  assert.equal(typeof shipping.packaged.budget.exceeds,'boolean');
  assert.equal(report.android.artifacts[abi]['opt-s-panic-abort'].targetProfile.shipping,false);
  assert.match(report.android.artifacts[abi]['opt-s-panic-abort'].targetProfile.qualification,/comparison only/);
   assert.equal(report.forecast[abi].budget.designPriorScenarioExceeds,false);
  assert.equal(report.naiveLocDiagnostic[abi].useForDecision,false);
 }
 assert.ok(report.ios.delta.fileBytes>0&&report.ios.delta.textSegmentBytes>0);
 assert.equal(typeof report.conclusions.actualShippingPackageWithinBudget,'boolean');
 assert.equal(typeof report.conclusions.shippingPackageOverBudget,'boolean');
});
