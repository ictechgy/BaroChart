import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createDemoServer} from '../scripts/serve.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

await mkdir('artifacts/web-rust-wasm',{recursive:true});
const server=createDemoServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
let browser;
try{
 browser=await launchBrowser({width:1280,height:900,dpr:1});
 await browser.navigate(`http://127.0.0.1:${server.address().port}/benchmarks/harness.html`);
 const result=await browser.evaluate(`(async()=>{
  const {loadRustBackend}=await import('/src/web/wasm/backend.mjs');
  const {createRustChart}=await import('/src/web/wasm/chart.mjs');
  const backend=await loadRustBackend(),session=await backend.createSession({count:10000});
  let chart;
  try{
   chart=await createRustChart(document.getElementById('chart'),session,{renderer:'canvas',dpr:()=>1});
   await chart.flush();
   if(chart.lastScene.stats.storedBars!==10000)throw new Error('Rust scene data mismatch');
   await session.invoke('nativeTool',['trendline']);
   const rect=chart.canvas.getBoundingClientRect();
   for(const [type,x,y,buttons] of [['pointerdown',220,100,1],['pointermove',450,220,1],['pointerup',450,220,0]])chart.canvas.dispatchEvent(new PointerEvent(type,{pointerId:11,pointerType:'mouse',button:0,buttons,clientX:rect.left+x,clientY:rect.top+y,bubbles:true}));
   await chart.flush();
   const drawings=await session.query('web.drawingsState');
   if(drawings.items.length!==1||!drawings.canUndo)throw new Error('Rust drawing input/history mismatch');
   await session.command('undo',[]);await chart.flush();
   if((await session.query('web.drawingsState')).items.length!==0)throw new Error('Rust undo failed');
   await session.command('redo',[]);await chart.flush();
   let webgl={tested:false};
   const originalCanvas=chart.canvas,originalListen=HTMLCanvasElement.prototype.addEventListener;
   let injected=false;
   HTMLCanvasElement.prototype.addEventListener=function(type,...args){if(this!==originalCanvas&&type==='pointerdown'&&!injected){injected=true;throw new Error('candidate listener failed');}return originalListen.call(this,type,...args);};
   try{await chart.replaceRenderer('webgl2');throw new Error('Expected renderer binding failure');}catch(error){if(error.message!=='candidate listener failed')throw error;}finally{HTMLCanvasElement.prototype.addEventListener=originalListen;}
   if(!injected||chart.canvas!==originalCanvas||!originalCanvas.isConnected||chart.rendererKind!=='canvas')throw new Error('Renderer binding failure did not preserve active view');
   await chart.flush();
   try{await chart.replaceRenderer('webgl2');await chart.flush();webgl={tested:true,kind:chart.rendererKind};}catch(error){webgl={tested:false,error:error.message};}
   if(webgl.tested){await Promise.all([chart.replaceRenderer('canvas'),chart.replaceRenderer('webgl2')]);await chart.flush();if(chart.rendererKind!=='webgl2'||chart.container.querySelectorAll('canvas').length!==1)throw new Error('Concurrent renderer replacement leaked a surface');}
   if((await session.query('web.drawingsState')).items.length!==1)throw new Error('Renderer replacement lost drawings');
   let duringParams=false;
   const paramsReceipt=await session.setIndicatorParams('ema',{period:9},{onProgress:async()=>{if(duringParams)return;duringParams=true;await session.invoke('nativeView',[1,200]);await session.command('setText',['kept during computation']);}});
   const config=await session.query('web.configuration'),afterParams=session.snapshot();
   if(paramsReceipt.status!=='committed'||config.indicators.find(row=>row.id==='ema')?.params.period!==9||afterParams.view.from!==1||afterParams.view.to!==200||afterParams.interaction.text!=='kept during computation'||(await session.query('web.drawingsState')).items.length!==1)throw new Error('Two-Worker params publication did not preserve active UI');
   const originalGeneration=session.generation,originalDrawings=await session.query('web.drawingsState');
   const oldCanvas=chart.canvas,replaceWith=Element.prototype.replaceWith;
   let replaceFailed=false;
   Element.prototype.replaceWith=function(...nodes){if(this===oldCanvas&&!replaceFailed){replaceFailed=true;throw new Error('candidate DOM replacement failed');}return replaceWith.apply(this,nodes);};
   try{await session.recreate();throw new Error('Expected candidate activation failure');}catch(error){if(!replaceFailed||error.message==='Expected candidate activation failure')throw error;}finally{Element.prototype.replaceWith=replaceWith;}
   if(session.generation!==originalGeneration||chart.canvas!==oldCanvas||!oldCanvas.isConnected||session.requiresResync||session.activeJob!==null||JSON.stringify(await session.query('web.drawingsState'))!==JSON.stringify(originalDrawings))throw new Error('Candidate DOM failure changed the active session');
   await session.recreate();await chart.flush();
   if(session.generation===originalGeneration||JSON.stringify(await session.query('web.drawingsState'))!==JSON.stringify(originalDrawings)||session.snapshot().interaction.text!=='kept during computation')throw new Error('Worker promotion lost migration state');
   const migratedGeneration=session.generation;
   await session.prepareData({kind:'seeded',count:12000,seed:7,visibleBars:200});await chart.flush();
   if(session.generation===migratedGeneration||session.snapshot().data.length!==12000||JSON.stringify(await session.query('web.drawingsState'))!==JSON.stringify(originalDrawings))throw new Error('Full preparation did not atomically promote the prepared Worker');
   await chart.destroy();
   if(session.closed)throw new Error('View destruction closed session');
   chart=await createRustChart(document.getElementById('chart'),session,{renderer:'canvas',dpr:()=>1});await chart.flush();
   await session.close();
   if(!chart.disposed||document.getElementById('chart').querySelector('canvas'))throw new Error('Session close did not retire attached view');
   return {passed:true,backend:session.backend,storedBars:12000,drawingTools:true,undoRedo:true,rendererStatePreserved:true,rendererFailureRollback:true,concurrentRendererReplacement:true,paramsTwoWorkers:true,workspaceUiWorkerPromotion:true,fullPrepareWorkerPromotion:true,sessionViewLifetime:true,webgl,userAgent:navigator.userAgent};
  }finally{await chart?.destroy();await session.close();}
 })()`);
 assert.equal(result.passed,true);
 await writeFile('artifacts/web-rust-wasm/chart-browser.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(yes=>server.close(yes));}
