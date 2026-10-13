// Local packaging verification only; never publishes or downloads dependencies.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'aster-npm-verify-'));
const cache=join(scratch,'cache'),consumer=join(scratch,'consumer');await mkdir(consumer);
const run=(executable,args,cwd=root)=>{const r=spawnSync(executable,args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw new Error(`${executable} ${args[0]} failed:\n${r.stdout}${r.stderr}`);return r.stdout;};
const tsc=resolve(process.env.TSC_PATH??join(root,'node_modules/typescript/lib/tsc.js'));
const ts=(await import(pathToFileURL(join(dirname(tsc),'typescript.js')).href)).default;
const packed=JSON.parse(run('npm',['--cache',cache,'pack','--offline','--ignore-scripts','--json','--pack-destination',scratch]))[0];
assert(packed?.filename);const tarball=join(scratch,packed.filename),names=packed.files.map(f=>f.path);
assert(names.length>0);assert(!names.some(n=>/^(artifacts|benchmarks|test|examples|scripts)\//.test(n)),'npm payload includes development/evidence outputs');
assert(!names.some(n=>/\.(?:zip|apk|jks|so|png|log)$/.test(n)),'npm payload includes an output binary/key/log');
for(const n of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','src/index.mjs','src/index.d.mts','native/Resources/aster-core.js','native/android/quickjs/LICENSE','native/android/quickjs/PROVENANCE.json','native/AsterColumns.swift','Package.swift'])assert(names.includes(n),`Missing packaged source/license ${n}`);
await writeFile(join(consumer,'package.json'),JSON.stringify({name:'aster-isolated-consumer',private:true,type:'module'}));
run('npm',['--cache',cache,'install','--offline','--ignore-scripts','--no-audit','--no-fund',tarball],consumer);
await copyFile(join(root,'test/package-types.test.mts'),join(consumer,'consumer.mts'));
run(process.execPath,[tsc,'--strict','--noEmit','--module','nodenext','--target','es2022','consumer.mts'],consumer);
await copyFile(join(root,'test/package-consumers/core-node.mts'),join(consumer,'core-node.mts'));
await writeFile(join(consumer,'ingestion.mts'),(await readFile(join(root,'test/ingestion-types.mts'),'utf8')).replace("'../src/core/index.mjs'","'barochart/core'"));
await writeFile(join(consumer,'tsconfig-core.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,skipLibCheck:false,module:'NodeNext',target:'ES2022',lib:['ES2022'],types:[]},files:['core-node.mts','ingestion.mts']}));
run(process.execPath,[tsc,'--project','tsconfig-core.json'],consumer);
const installed=join(consumer,'node_modules/barochart'),pkg=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
assert.equal(pkg.private,true);assert.equal(pkg.license,'Apache-2.0');assert.equal(Object.keys(pkg.dependencies??{}).length,0);
assert.equal(await access(join(consumer,'node_modules/react')).then(()=>true,()=>false),false,'base package installed React');
const entries=[];
for(const [subpath,entry] of Object.entries(pkg.exports)){
 if(subpath==='./react'){assert(pkg.peerDependencies?.react);assert.equal(pkg.peerDependenciesMeta?.react?.optional,true);assert(names.includes('src/react/index.mjs')&&names.includes('src/react/index.d.mts'));entries.push({subpath,status:'optional peer intentionally absent; validated by test-package-consumers.mjs'});continue;}
 const runtimePath=join(installed,entry.import),typePath=join(installed,entry.types),runtime=await import(pathToFileURL(runtimePath).href);
 const program=ts.createProgram([typePath],{strict:true,noEmit:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,target:ts.ScriptTarget.ES2022,types:[],lib:subpath==='./core'?['lib.es2022.d.ts']:['lib.es2022.d.ts','lib.dom.d.ts']}),checker=program.getTypeChecker();
 const diagnostics=ts.getPreEmitDiagnostics(program);assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:n=>n,getCurrentDirectory:()=>consumer,getNewLine:()=> '\n'}));
 const declared=checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(typePath))).filter(s=>{const actual=s.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(s):s;return !!(actual.flags&ts.SymbolFlags.Value);}).map(s=>s.name).sort();
 const exported=Object.keys(runtime).sort();assert.deepEqual(declared,exported,`Runtime/type export mismatch: ${subpath}`);
 entries.push({subpath,runtimeExports:exported.length,typeExports:declared.length});
}
const {BarStore,ChartModel,ChartAPI,IngestionError,portableSessionCalendar,seededColumns,buildScene,drawingGeometry,drawingPointCount}=await import(pathToFileURL(join(installed,'src/core/index.mjs')).href);
const store=new BarStore();store.setColumns(seededColumns(512));const model=new ChartModel({store});model.addSeries({id:'p',type:'candles',panel:'price'});
const scene=buildScene(model,800,600);assert.equal(scene.stats.storedBars,512);assert(scene.commands.length>0);assert.equal(drawingPointCount('trendline'),2);assert(drawingGeometry({id:'t',type:'trendline',panel:'price',points:[{time:store.at(0).time,price:100},{time:store.at(100).time,price:105}]},scene.layout).length>0);model.dispose();
const studyStore=new BarStore([10,11,11,9].map((close,i)=>({time:1700000000000+i*60000,open:close,high:close+1,low:close-1,close,volume:[5,7,8,9][i]}))),studyModel=new ChartModel({store:studyStore}),studyAPI=new ChartAPI(studyModel);
assert.deepEqual(studyAPI.registerIndicatorModule('aster.volume-direction',1),['aster.volume-direction@1/pressure']);
studyAPI.addIndicator('pressure','aster.volume-direction@1/pressure',{shift:-2});
assert.deepEqual(Array.from(studyModel.indicators.get('pressure').outputs.signed),[0,7,0,-9]);
assert.deepEqual(studyAPI.indicatorValueAt('pressure','signed',0,{mode:'plot',asOfIndex:0}),{value:null,sourceIndex:null,sourceTime:null});
studyAPI.addIndicator('session','vwap',{calendar:portableSessionCalendar({timezone:'UTC',weekdays:[0,1,2,3,4,5,6],windows:[{open:'00:00',close:'23:59'}]}),deviation:2});
assert.deepEqual(Object.keys(studyModel.indicators.get('session').outputs),['value','upper','lower','deviation','volume']);
const document=studyAPI.saveStudies(),restored=new ChartModel({store:studyStore}),restoreAPI=new ChartAPI(restored);assert.deepEqual(restoreAPI.loadStudies(document),{indicators:2,series:0});assert.equal(restoreAPI.saveStudies(),document);restored.dispose();studyModel.dispose();assert.equal(studyStore.listeners.size,0);
// Owned packets and their restore path must work from the installed package too.
const feedStore=new BarStore(),restoreFeedStore=new BarStore();feedStore.setColumns(seededColumns(8));restoreFeedStore.setColumns(seededColumns(8));
const feedModel=new ChartModel({store:feedStore}),restoreFeedModel=new ChartModel({store:restoreFeedStore}),feedAPI=new ChartAPI(feedModel),restoreFeedAPI=new ChartAPI(restoreFeedModel);
feedAPI.configureDataIngestion({streamId:'package:A',generation:4,firstSequence:90,maxQueuedEvents:4,maxQueuedBytes:196,maxBatchEvents:2,maxStoredBars:10,maxStoreBytes:96*16});
const current={...feedStore.at(7),volume:-0},next={time:current.time+60000,open:100,high:101,low:99,close:100,volume:5};
feedAPI.enqueueDataEvents({streamId:'package:A',generation:4,firstSequence:90,events:[{kind:'update',bar:current},{kind:'append',bar:next}]});
current.volume=999;next.close=999;const pending=feedAPI.saveDataIngestion();restoreFeedAPI.loadDataIngestion(pending);
let publications=0;const off=feedStore.subscribe(()=>publications++);const batch=feedAPI.drainDataEvents();restoreFeedAPI.drainDataEvents();off();
assert.equal(batch.events,2);assert.equal(batch.appended,1);assert.equal(publications,1);assert.equal(feedStore.length,9);assert.equal(feedStore.at(8).close,100);assert(Object.is(feedStore.at(7).volume,-0));
assert.deepEqual(feedStore.columns,restoreFeedStore.columns);assert.equal(feedAPI.dataIngestionStats().applied,2);assert.equal(feedAPI.dataIngestionStats().nextSequence,92);
assert.throws(()=>feedAPI.enqueueDataEvents({streamId:'package:A',generation:4,firstSequence:90,events:[{kind:'update',bar:feedStore.at(8)}]}),error=>error instanceof IngestionError&&error.code==='SEQUENCE_MISMATCH');
feedModel.dispose();restoreFeedModel.dispose();assert.equal(feedStore.listeners.size,0);assert.equal(restoreFeedStore.listeners.size,0);
const result={version:pkg.version,packageName:pkg.name,bytes:packed.size,unpackedBytes:packed.unpackedSize,files:names.length,sha256:createHash('sha256').update(await readFile(tarball)).digest('hex'),entries,consumerTypes:'TypeScript '+ts.version+' strict NodeNext and DOM-free core ES2022 including ingestion contract passed',runtimeSmoke:'512 OHLCV/core/scene/drawing, exact module/as-of/calendar5/study roundtrip, owned packet/special-number restore/single-publication batch/sequence error and listener cleanup passed',private:true,license:pkg.license,productionDependencies:0,reactInstalled:false,network:'offline; no publication',scope:'Local npm tarball installation and ESM/type export contract; optional React entry is tested separately by test-package-consumers.mjs; browser/native execution measured separately'};
result.tarball=tarball; // Copy these exact verified bytes for the local deliverable.
const output=resolve(process.argv[2]??join(root,'artifacts/npm-package-verification.json'));await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
