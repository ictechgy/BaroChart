import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const output=resolve(process.env.ASTER_UIKIT_BUILD??'artifacts/ios-mobile-ux'),manifest=JSON.parse(await readFile(join(output,'build-manifest.json'),'utf8')),red=process.argv.includes('--expect-failure');
const digest=b=>createHash('sha256').update(b).digest('hex');
assert.equal(digest(await readFile(join(manifest.appPath,'MobileUX'))),manifest.appBinarySHA256);assert.equal(digest(await readFile(join(manifest.appPath,'aster-core.js'))),manifest.coreSHA256);
const sim=(args,optional=false)=>{const r=spawnSync('xcrun',['simctl',...args],{encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0&&!optional)throw new Error(r.stderr);return{status:r.status,stdout:r.stdout.trim(),stderr:r.stderr.trim()};};
let simulatorID;const cleanup=[];
try{
 const runtime=process.env.ASTER_IOS_RUNTIME??JSON.parse(sim(['list','runtimes','--json']).stdout).runtimes.find(r=>r.isAvailable&&r.name.startsWith('iOS'))?.identifier;assert(runtime);
 simulatorID=sim(['create',`Aster-mobile-ux-${Date.now()}`,process.env.ASTER_IOS_DEVICE??'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',runtime]).stdout;assert(/^[A-F0-9-]{36}$/i.test(simulatorID));
 await writeFile(join(output,'owned-simulator.json'),JSON.stringify({simulatorID,runtime,createdByThisRun:true},null,2)+'\n');sim(['boot',simulatorID]);sim(['bootstatus',simulatorID,'-b']);
 const target='MobileUXSystemTests/MobileUXSystemTests',only=process.argv.includes('--cancel-semantics-red')?[`${target}/testAccessibleEscapeSemantics`]:process.argv.includes('--batch-cancel-red')?[`${target}/testBatchAccessibleCancel`]:process.argv.includes('--batch-red')?[`${target}/testBatchCallbackCancellation`]:process.argv.includes('--reentry-red')?[`${target}/testReentrantDispose`]:red?[`${target}/testBaselineContracts`,`${target}/testBaselineBackgroundCancellation`]:[`${target}/testNativeSystemInputAndUX`,`${target}/testBatchCallbackCancellation`,`${target}/testBatchAccessibleCancel`];
 const args=['test-without-building','-xctestrun',manifest.xctestrunPath,'-destination',`id=${simulatorID}`,'-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1','-collect-test-diagnostics','never','-resultBundlePath',join(output,red?'baseline.xcresult':'mobile-ux.xcresult'),...only.map(t=>'-only-testing:'+t)];
 const result=spawnSync('xcodebuild',args,{encoding:'utf8',timeout:240000,maxBuffer:24*1024*1024});await writeFile(join(output,'xctest.log'),(result.stdout??'')+(result.stderr??''));
 const data=sim(['get_app_container',simulatorID,'dev.aster.charts.mobileux','data']).stdout,report=JSON.parse(await readFile(join(data,'Documents/ios-mobile-ux.json'),'utf8'));
 let batch;try{batch=JSON.parse(await readFile(join(data,'Documents/ios-mobile-batch.json'),'utf8'));await writeFile(join(output,'ios-mobile-batch.json'),JSON.stringify({...batch,simulatorID,runtime},null,2)+'\n');}catch{}
 const proofs={...report,batchVerification:batch??null,simulatorID,runtime,ownedTemporarySimulator:true,xcodebuildStatus:result.status,systemInputPublicXCTest:true,physicalDevice:false};await writeFile(join(output,'ios-mobile-ux.json'),JSON.stringify(proofs,null,2)+'\n');
 for(const row of report.glyphMatrix?.rows??[]){assert(/^glyph-[0-9]+-[0-9]+-[0-9]+-(sans|mono)\.png$/.test(row.png));await copyFile(join(data,'Documents',row.png),join(output,row.png));}
 if(red){assert.notEqual(result.status,0);assert((report.state?.failures?.length??0)>0||report.state?.pointers===1||(report.batchTouchEvents?.[0]?.pointerIDsAfterDispatch??0)>0,'Baseline must demonstrate missing contracts');}
 else{assert.equal(result.status,0,result.stderr||String(result.error));assert.equal(report.state.failures.length,0);assert(report.nativeChecks.passed>=43);assert.equal(report.viewLifetime.weakNilAfterMainQueue,true);assert(report.engineClosed);assert.equal(report.engineSubscriptionsAfterDetach,0);assert.equal(report.glyphMatrix.cases,16);assert(report.glyphMatrix.glyphLabels>0&&report.glyphMatrix.rawDataAndAnchorsUnchanged);assert.equal(report.glyphMatrix.violations.length,0);assert.equal(report.publicationOrder.passed,4);assert.equal(report.reentrantDisposal.callbacks,0);assert.equal(report.accessibleEscape.selectedAfter,null);assert.equal(report.accessibleEscape.crosshairCleared,true);
  const events=batch?.batchTouchEvents??[];assert.deepEqual(events.map(e=>e.kind).sort(),['batch-cancel','batch-dispose','batch-font','batch-resize']);for(const e of events){assert.equal(e.beganTouches,2);assert.equal(e.chartTargetBegans,2);assert.equal(e.pointerIDsAfterDispatch,0);assert.equal(e.corePointersAfterDispatch,0);}
 }
 await writeFile(join(output,'system-input-proof.json'),JSON.stringify({coreSHA256:manifest.coreSHA256,uikitSHA256:manifest.uikitSHA256,red,xcodebuildStatus:result.status,systemUITouch:true,publicAPIs:['XCUIElement.pinch','XCUICoordinate.tap/press/drag','XCUIDevice.home/orientation'],physicalDevice:false},null,2)+'\n');
 console.log(JSON.stringify({passed:true,red,simulatorID,coreSHA256:manifest.coreSHA256}));
}finally{
 if(simulatorID&&/^[A-F0-9-]{36}$/i.test(simulatorID)){for(const args of [['terminate',simulatorID,'dev.aster.charts.mobileux'],['shutdown',simulatorID],['delete',simulatorID]]){const r=sim(args,true);cleanup.push({operation:args[0],status:r.status,stderr:r.stderr});}}
 await writeFile(join(output,'simulator-cleanup.json'),JSON.stringify({simulatorID:simulatorID??null,cleanup,ownedOnly:true},null,2)+'\n');if(simulatorID)assert.equal(cleanup.find(r=>r.operation==='delete')?.status,0);
}
