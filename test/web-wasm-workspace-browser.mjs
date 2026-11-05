import assert from 'node:assert/strict';
import {createDemoServer} from '../scripts/serve.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

const server=createDemoServer();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let browser;
try{
 browser=await launchBrowser({width:1000,height:800,dpr:1});
 await browser.navigate(`http://127.0.0.1:${server.address().port}/benchmarks/harness.html`);
 const result=await browser.evaluate(`(async()=>{
  const A=await import('/src/core/index.mjs'),{saveWorkspace}=await import('/src/core/workspace.mjs'),{safeCheckpointParse}=await import('/src/core/checkpoint-validation.mjs'),{loadRustBackend}=await import('/src/web/wasm/backend.mjs');
  const binding={key:'workspace-browser',revision:'7',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'};
  const store=new A.BarStore([],{maxBars:4096,timeframeMs:300000,timeOrigin:-0});store.setColumns(A.seededColumns(64,17));
  const model=new A.ChartModel({store,visibleBars:30}),api=new A.ChartAPI(model);
  api.setSymbol(A.DEMO_SYMBOLS.us);api.addSeries({id:'price',type:'candles',panel:'price'});api.addIndicator('ema-id','ema',{period:9});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema-id'});
  api.configureDataIngestion({streamId:'workspace-browser',generation:4,firstSequence:50,maxStoredBars:4096,maxQueuedEvents:8,maxBatchEvents:8});api.pauseDataIngestion();
  const columns=Object.fromEntries(A.FIELDS.map(field=>[field,store.columns[field].slice(0,store.length)])),source=Object.fromEntries(['length','maxBars','timeframeMs','timeOrigin','version','timeVersion'].map(field=>[field,store[field]])),dataIngestion=api.saveDataIngestion(),document=saveWorkspace(api,binding);
  const backend=await loadRustBackend();let session;
  try{
   session=await backend.createSessionFromWorkspace({columns,source,size:{width:777,height:444},document,binding,dataIngestion});
   if(await session.saveWorkspace(binding)!==document)throw new Error('Workspace file changed during restore');
   if(await session.command('saveDataIngestion')!==dataIngestion)throw new Error('Ingestion was reloaded or changed');
   let observed;
   await session.withMigrationCapture(binding,{consume:portable=>{observed=portable;return{dispose(){}};},activate:({handoff})=>{handoff();return true;}});
   const actual=safeCheckpointParse(observed.metadataJSON).source;
   for(const key of ['maxBars','timeframeMs'])if(!Object.is(actual[key],source[key]))throw new Error('Source metadata changed: '+key);
   if(!Object.is(actual.timeOrigin,-0))throw new Error('Source negative-zero timeOrigin was lost');
   for(const key of ['version','timeVersion'])if(actual[key]!==source[key]+1)throw new Error('Workspace target version policy changed: '+key);
   if(observed.metadata.size.width!==777||observed.metadata.size.height!==444)throw new Error('Workspace dimensions changed');
   for(const field of A.FIELDS)for(let index=0;index<64;index++)if(!Object.is(observed.columns[field][index],columns[field][index]))throw new Error('Restored raw field changed: '+field);
   const stats=await session.command('dataIngestionStats');
   if(stats.state!=='paused'||stats.pendingEvents!==0||stats.nextSequence!==50)throw new Error('Ingestion ledger changed');
   return {passed:true,bars:64,nondefaultStoreMetadata:true,signedZeroOrigin:true,rawColumnsExact:384,ingestionLoadedOnce:true,versionPolicy:'source+1',dimensions:true,userAgent:navigator.userAgent};
  }finally{await session?.close();model.dispose();}
 })()`);
 assert.equal(result.passed,true);console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
