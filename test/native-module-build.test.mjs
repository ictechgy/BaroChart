import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
test('locally linked native module uses canonical registration/calculation/save/isolated async without data source code',async()=>{
 const text=await buildNativeBundle({modulePaths:['examples/indicators/local-volume-balance.mjs']}),context=vm.createContext({console});vm.runInContext(text,context);
 const report=vm.runInContext(`(()=>{nativeInit(4,{series:[]});const name=nativeAPI.registerIndicatorModule('local.volume-balance',1)[0];nativeAPI.addIndicator('local',name,{period:2});nativeAPI.addSeries({id:'local-line',type:'line',panel:'price',indicator:'local'});return {name,setup:nativeAPI.saveStudies(),values:nativeAPI.indicatorValues('local'),capture:new Aster.AsyncCapture(nativeModel,{kind:'correction',bar:{...nativeModel.store.at(0),volume:1}}).metadataJSON};})()`,context);
 assert.equal(report.name,'local.volume-balance@1/smooth');assert.equal(report.values.length,4);assert.equal(JSON.parse(report.setup).indicators[0].module.stateVersion,1);assert.equal(JSON.parse(report.capture).indicators[0].module.id,'local.volume-balance');assert.ok(!report.capture.includes('step(bar)'));context.nativeModel.dispose();
});
test('unsupported dependency imports and missing local module paths reject at build time',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'aster-module-build-'));try{const file=join(folder,'bad.mjs');await writeFile(file,"import x from 'https://example.invalid/module.mjs';\n");await assert.rejects(buildNativeBundle({modulePaths:[file]}),/local defineIndicatorModule/);await assert.rejects(buildNativeBundle({modulePaths:[join(folder,'missing.mjs')]}));}finally{await rm(folder,{recursive:true,force:true});}
});
