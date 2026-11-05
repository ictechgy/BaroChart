import assert from 'node:assert/strict';
import {createDemoServer} from '../scripts/serve.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

const server=createDemoServer();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let browser;
try{
 browser=await launchBrowser({width:1100,height:820,dpr:1});
 await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`{
  if(location.search.includes('clearStorage=1'))localStorage.clear();
  const NativeWorker=Worker,stats=window.__workerStats={created:0,terminated:0,live:0,urls:[]};let failedOnce=false;
  window.Worker=function(...args){
   const workerURL=String(args[0]);
   const appWorker=['model-worker.mjs','demo-data-worker.mjs','src/web/wasm/worker-entry.mjs'].some(name=>workerURL.includes(name));
   if(location.search.includes('failWorkerOnce=1')&&!failedOnce&&appWorker){failedOnce=true;throw new Error('injected first Worker failure');}
   const worker=new NativeWorker(...args);stats.created++;stats.live++;stats.urls.push(String(args[0]));
   let closed=false;const terminate=worker.terminate.bind(worker),post=worker.postMessage.bind(worker);
   worker.terminate=()=>{if(!closed){closed=true;stats.terminated++;stats.live--;}return terminate();};
   worker.postMessage=(...values)=>{if(location.search.includes('delayWorkers=1'))setTimeout(()=>{if(!closed)post(...values);},40);else return post(...values);};
   return worker;
  };
  window.Worker.prototype=NativeWorker.prototype;
  const nativeFetch=window.fetch.bind(window);window.__wasmFetchStats={held:0,released:0};
  window.fetch=(input,init)=>{
   const url=String(input?.url??input);
   if(location.search.includes('holdWasm=1')&&url.includes('/src/web/wasm/barochart-core.wasm')&&!window.__releaseWasmFetch){
    window.__wasmFetchStats.held++;
    return new Promise((resolve,reject)=>{window.__releaseWasmFetch=()=>{window.__wasmFetchStats.released++;nativeFetch(input,init).then(resolve,reject);};});
   }
   return nativeFetch(input,init);
  };
 }`},browser.sessionId);
 const base=`http://127.0.0.1:${server.address().port}/examples/web/`;
 const navigate=path=>browser.navigate(base+path);

 await navigate('');
 const historyFailure=await browser.evaluate(`(async()=>{
  const source=await baroDemo.ready,nativeReplace=history.replaceState;let failures=0;
  history.replaceState=()=>{failures++;throw new Error('injected history failure');};
  try{
   await baroDemo.switchTo('rust-wasm');
   if(baroDemo.backend!=='rust-wasm'||baroDemo.controller.session.snapshot().data.length!==100000)throw new Error('Rust commit was rolled back by URL failure');
   await baroDemo.switchTo('javascript');
   if(baroDemo.backend!=='javascript'||baroDemo.controller.model.store.length!==100000)throw new Error('JavaScript commit was rolled back by URL failure');
   return {failures,live:__workerStats.live,connected:document.querySelector('main').isConnected,inert:document.querySelector('main').inert};
  }finally{history.replaceState=nativeReplace;}
 })()`,{timeout:120000,label:'history-failure-is-noncritical'});
 assert.deepEqual(historyFailure,{failures:2,live:0,connected:true,inert:false});

 await navigate('');
 const cleanupFailure=await browser.evaluate(`(async()=>{
  const source=await baroDemo.ready,liveRoot=document.querySelector('main'),nativeReplace=Element.prototype.replaceWith,nativeFreeze=Object.freeze;
  let replacementFailed=false,disposeFailed=false;
  Element.prototype.replaceWith=function(...nodes){if(this===liveRoot&&!replacementFailed){replacementFailed=true;throw new Error('injected DOM replacement failure');}return nativeReplace.apply(this,nodes);};
  Object.freeze=function(value){
   if(!disposeFailed&&value?.backend==='rust-wasm'&&typeof value.dispose==='function'){
    const dispose=value.dispose;value.dispose=async()=>{await dispose();disposeFailed=true;throw new Error('injected candidate dispose failure');};
   }
   return nativeFreeze(value);
  };
  let rejected=false;
  try{await baroDemo.switchTo('rust-wasm');}catch(error){rejected=/DOM replacement/.test(error.message);}
  finally{Element.prototype.replaceWith=nativeReplace;Object.freeze=nativeFreeze;}
  await new Promise(resolve=>setTimeout(resolve,0));
  return {rejected,replacementFailed,disposeFailed,same:baroDemo.controller===source,backend:baroDemo.backend,disposed:source.model.disposed===true,connected:liveRoot.isConnected,inert:liveRoot.inert,aster:window.aster?.model===source.model,mains:document.querySelectorAll('main').length,live:__workerStats.live};
 })()`,{timeout:120000,label:'cleanup-failure-preserves-source'});
 assert.deepEqual(cleanupFailure,{rejected:true,replacementFailed:true,disposeFailed:true,same:true,backend:'javascript',disposed:false,connected:true,inert:false,aster:true,mains:1,live:0});

 await navigate('');
 const suspended=await browser.evaluate(`(async()=>{
  const source=await baroDemo.ready,liveRoot=document.querySelector('main');let fired=false;
  const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.matches?.('main')&&node!==liveRoot&&!fired){fired=true;observer.disconnect();window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));}});
  observer.observe(document.body,{childList:true});let rejected=false;
  try{await baroDemo.switchTo('rust-wasm');}catch(error){rejected=error.name==='AbortError';}
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));await new Promise(resolve=>setTimeout(resolve,0));
  return {fired,rejected,same:baroDemo.controller===source,backend:baroDemo.backend,disposed:source.model.disposed===true,connected:liveRoot.isConnected,inert:liveRoot.inert,mains:document.querySelectorAll('main').length,live:__workerStats.live};
 })()`,{timeout:120000,label:'persisted-pagehide-aborts-staging'});
 assert.deepEqual(suspended,{fired:true,rejected:true,same:true,backend:'javascript',disposed:false,connected:true,inert:false,mains:1,live:0});

 await navigate('?holdWasm=1');
 const fetchCancel=await browser.evaluate(`(async()=>{
  const source=await baroDemo.ready,liveRoot=document.querySelector('main'),pending=baroDemo.switchTo('rust-wasm');
  for(let attempt=0;attempt<1000&&!window.__releaseWasmFetch;attempt++)await new Promise(resolve=>setTimeout(resolve,2));
  if(!window.__releaseWasmFetch)throw new Error('WASM fetch was not held');
  const started=performance.now();document.getElementById('backend-cancel').click();let rejected=false;try{await pending;}catch(error){rejected=error.name==='AbortError';}
  const elapsed=performance.now()-started,restored={same:baroDemo.controller===source,backend:baroDemo.backend,disposed:source.model.disposed===true,connected:liveRoot.isConnected,inert:liveRoot.inert,aster:window.aster?.model===source.model,live:__workerStats.live};
  window.__releaseWasmFetch();const rust=await baroDemo.switchTo('rust-wasm'),retryBars=rust.session.snapshot().data.length;await baroDemo.switchTo('javascript');
  return {rejected,fast:elapsed<1000,restored,retryBars,held:__wasmFetchStats.held,released:__wasmFetchStats.released,live:__workerStats.live};
 })()`,{timeout:120000,label:'wasm-fetch-cancel-restores-source'});
 assert.deepEqual(fetchCancel,{rejected:true,fast:true,restored:{same:true,backend:'javascript',disposed:false,connected:true,inert:false,aster:true,live:0},retryBars:100000,held:1,released:1,live:0});

 for(const [path,target] of [['','rust-wasm'],['?backend=rust-wasm','javascript']]){
  await navigate(path);
  const terminal=await browser.evaluate(`(async()=>{
   const source=await baroDemo.ready,sourceBackend=source.backend,liveRoot=document.querySelector('main'),nativeReplace=Element.prototype.replaceWith;let fired=false,rejected=false;
   Element.prototype.replaceWith=function(...nodes){const result=nativeReplace.apply(this,nodes);if(this===liveRoot&&!fired){fired=true;window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}));}return result;};
   try{await baroDemo.switchTo(${JSON.stringify(target)});}catch(error){rejected=true;}finally{Element.prototype.replaceWith=nativeReplace;}
   for(let attempt=0;attempt<100&&__workerStats.live;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
   return {fired,rejected,sourceBackend,currentBackend:baroDemo.backend,same:baroDemo.controller===source,mains:document.querySelectorAll('main').length,live:__workerStats.live};
  })()`,{timeout:120000,label:'terminal-pagehide-during-'+target});
  assert.deepEqual(terminal,{fired:true,rejected:true,sourceBackend:path?'rust-wasm':'javascript',currentBackend:path?'rust-wasm':'javascript',same:true,mains:1,live:0});
 }

 await navigate('?backend=rust-wasm&delayWorkers=1');
 const initialCancel=await browser.evaluate(`(async()=>{
  let rejected=false;document.getElementById('backend-cancel').click();
  try{await baroDemo.ready;}catch(error){rejected=error.name==='AbortError';}
  await new Promise(resolve=>setTimeout(resolve,300));
  return {rejected,backend:baroDemo.backend,controller:baroDemo.controller===null,live:__workerStats.live,terminated:__workerStats.terminated};
 })()`,{timeout:120000,label:'initial-rust-mount-cancel'});
 assert.equal(initialCancel.rejected,true);assert.equal(initialCancel.backend,null);assert.equal(initialCancel.controller,true);assert.equal(initialCancel.live,0);

 await navigate('?backend=rust-wasm&delayWorkers=1');
 const latestPreference=await browser.evaluate(`(async()=>{
  const market=document.getElementById('market'),count=document.getElementById('count'),theme=document.getElementById('theme');
  market.value='kr';market.dispatchEvent(new Event('change',{bubbles:true}));count.value='10000';count.dispatchEvent(new Event('change',{bubbles:true}));theme.click();
  const owner=await baroDemo.ready;
  return {backend:owner.backend,market:owner.state.market,count:owner.state.count,light:owner.state.light,bars:owner.session.snapshot().data.length,theme:document.documentElement.dataset.chartTheme,live:__workerStats.live};
 })()`,{timeout:120000,label:'latest-initial-preferences-win'});
 assert.deepEqual(latestPreference,{backend:'rust-wasm',market:'kr',count:10000,light:true,bars:10000,theme:'light',live:1});

 await navigate('?backend=rust-wasm&delayWorkers=1');
 const lateTheme=await browser.evaluate(`(async()=>{
  const count=document.getElementById('count');count.value='10000';count.dispatchEvent(new Event('change',{bubbles:true}));
  for(let attempt=0;attempt<1000&&!__workerStats.urls.some(url=>url.includes('/src/web/wasm/worker-entry.mjs'));attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  if(!__workerStats.urls.some(url=>url.includes('/src/web/wasm/worker-entry.mjs')))throw new Error('Rust actor did not begin before the late theme click');
  document.getElementById('theme').click();const owner=await baroDemo.ready,configuration=await owner.session.query('web.configuration');
  return {light:owner.state.light,background:configuration.theme.background,dataset:document.documentElement.dataset.chartTheme,aria:document.getElementById('theme').getAttribute('aria-pressed'),bars:owner.session.snapshot().data.length,live:__workerStats.live};
 })()`,{timeout:120000,label:'late-initial-theme-restarts-rust-candidate'});
 assert.deepEqual(lateTheme,{light:true,background:'#f8fafcff',dataset:'light',aria:'true',bars:10000,live:1});

 await navigate('?backend=rust-wasm&failWorkerOnce=1&clearStorage=1');
 const initialFailure=await browser.evaluate(`(async()=>{
  let failed=false;try{await baroDemo.ready;}catch{failed=true;}
  const retry=document.getElementById('backend-retry'),selector=document.getElementById('backend');
  const before={failed,retryVisible:!retry.hidden,selected:selector.value,backend:baroDemo.backend};
  selector.value='javascript';selector.dispatchEvent(new Event('change',{bubbles:true}));const owner=await baroDemo.ready;
  return {...before,recovered:owner.backend,bars:owner.model.store.length,retryHidden:retry.hidden,live:__workerStats.live};
 })()`,{timeout:120000,label:'initial-rust-failure-recovers-with-javascript'});
 assert.deepEqual(initialFailure,{failed:true,retryVisible:true,selected:'rust-wasm',backend:null,recovered:'javascript',bars:100000,retryHidden:true,live:0});

 await navigate('?failWorkerOnce=1&clearStorage=1');
 const sameModeRetry=await browser.evaluate(`(async()=>{
  let failed=false;try{await baroDemo.ready;}catch{failed=true;}
  const retry=document.getElementById('backend-retry');retry.click();const owner=await baroDemo.ready;
  return {failed,recovered:owner.backend,bars:owner.model.store.length,retryHidden:retry.hidden,live:__workerStats.live};
 })()`,{timeout:120000,label:'initial-javascript-failure-retries-same-engine'});
 assert.deepEqual(sameModeRetry,{failed:true,recovered:'javascript',bars:100000,retryHidden:true,live:0});

 await navigate('?backend=rust-wasm');
 const firstFrameFailure=await browser.evaluate(`(async()=>{
  const source=await baroDemo.ready,sourceGeneration=source.session.generation,liveRoot=document.querySelector('main'),nativeDraw=CanvasRenderingContext2D.prototype.drawImage;let injected=false,rejected=false;
  CanvasRenderingContext2D.prototype.drawImage=function(...args){const candidateRoot=this.canvas.closest?.('main');if(candidateRoot&&candidateRoot!==liveRoot){injected=true;throw new Error('injected JavaScript first-frame failure');}return nativeDraw.apply(this,args);};
  try{await baroDemo.switchTo('javascript');}catch(error){rejected=/first-frame|injected/.test(error.message);}
  finally{CanvasRenderingContext2D.prototype.drawImage=nativeDraw;}
  await source.chart.flush();
  return {injected,rejected,same:baroDemo.controller===source,backend:baroDemo.backend,generation:source.session.generation===sourceGeneration,closed:source.session.closed,connected:liveRoot.isConnected,inert:liveRoot.inert,aster:window.aster?.session===source.session,mains:document.querySelectorAll('main').length,live:__workerStats.live};
 })()`,{timeout:120000,label:'javascript-first-frame-failure-rolls-back'});
 assert.deepEqual(firstFrameFailure,{injected:true,rejected:true,same:true,backend:'rust-wasm',generation:true,closed:false,connected:true,inert:false,aster:true,mains:1,live:1});

 await navigate('?backend=rust-wasm&delayWorkers=1');
 const persistedInitial=await browser.evaluate(`(async()=>{
  const first=baroDemo.ready;window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  let firstRejected=false;try{await first;}catch(error){firstRejected=error.name==='AbortError';}
  const owner=await baroDemo.ready;
  return {firstRejected,backend:owner.backend,bars:owner.session.snapshot().data.length,live:__workerStats.live,connected:document.querySelector('main').isConnected,inert:document.querySelector('main').inert};
 })()`,{timeout:120000,label:'persisted-initial-suspend-resumes-once'});
 assert.deepEqual(persistedInitial,{firstRejected:true,backend:'rust-wasm',bars:100000,live:1,connected:true,inert:false});

 console.log(JSON.stringify({passed:true,historyFailure,cleanupFailure,suspended,fetchCancel,initialCancel,latestPreference,lateTheme,initialFailure,sameModeRetry,firstFrameFailure,persistedInitial}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
