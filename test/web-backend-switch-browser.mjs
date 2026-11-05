import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createDemoServer} from '../scripts/serve.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

await mkdir('artifacts/web-rust-wasm',{recursive:true});
const server=createDemoServer();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let browser;
try{
 browser=await launchBrowser({width:1280,height:1000,dpr:1});
 await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`{
  const Original=Worker,stats=window.__workerStats={created:0,terminated:0,live:0};
  window.Worker=function(...args){const worker=new Original(...args);stats.created++;stats.live++;const terminate=worker.terminate.bind(worker);let closed=false;worker.terminate=()=>{if(!closed){closed=true;stats.terminated++;stats.live--;}return terminate();};return worker;};
  window.Worker.prototype=Original.prototype;
 }`},browser.sessionId);
 await browser.navigate(`http://127.0.0.1:${server.address().port}/examples/web/`);
 const result=await browser.evaluate(`(async()=>{
  const js=await window.baroDemo.ready;
  if(js.backend!=='javascript'||js.model.store.length!==100000)throw new Error('Default JavaScript demo did not initialize');
  const bar=js.model.store.at(100),api=js.chart.api;
  api.addDrawing({id:'kept',type:'horizontal',panel:'price',points:[{time:bar.time,price:bar.close}]});
  api.addDrawing({id:'redo',type:'horizontal',panel:'price',points:[{time:bar.time,price:bar.close+1}]});api.undo();api.selectDrawing('kept');
  js.chart.setTool('trendline');api.setText('backend switch note');api.setCrosshairSnap({mode:'ohlc'});api.setDrawingMagnet({mode:'strong'});api.setVisibleRange(70,270);
  const expected={drawings:api.saveDrawings(),undo:js.model.drawings.undoStack.length,redo:js.model.drawings.redoStack.length,selected:js.model.drawings.selected,serial:js.model.drawings.serial,last:js.model.store.at(99999)};
  await window.baroDemo.switchTo('rust-wasm');
  const rust=window.baroDemo.controller,snapshot=rust.session.snapshot(),drawings=await rust.session.query('web.drawingsState');
  if(snapshot.data.length!==100000||snapshot.view.from!==70||snapshot.view.to!==270||drawings.undoCount!==expected.undo||drawings.redoCount!==expected.redo||drawings.selected!==expected.selected||drawings.serial!==expected.serial||snapshot.interaction.tool!=='trendline'||snapshot.interaction.text!=='backend switch note'||snapshot.interaction.crosshairSnap.mode!=='ohlc'||snapshot.interaction.drawingMagnet.mode!=='strong')throw new Error('JavaScript to Rust state was not preserved: '+JSON.stringify({snapshot,drawings}));
  if(await rust.session.command('saveDrawings')!==expected.drawings)throw new Error('Rust drawing document differs');
  await window.baroDemo.switchTo('javascript');
  const back=window.baroDemo.controller;
  if(back.model.store.length!==100000||JSON.stringify(back.model.store.at(99999))!==JSON.stringify(expected.last)||back.chart.api.saveDrawings()!==expected.drawings||back.model.drawings.undoStack.length!==expected.undo||back.model.drawings.redoStack.length!==expected.redo||back.model.drawings.selected!==expected.selected||back.chart.controller.tool!=='trendline'||back.chart.controller.text!=='backend switch note'||back.chart.controller.crosshairSnap.mode!=='ohlc'||back.chart.controller.drawingMagnet.mode!=='strong')throw new Error('Rust to JavaScript state was not preserved');
  await window.baroDemo.switchTo('rust-wasm');await window.baroDemo.switchTo('javascript');
  if(window.__workerStats.live!==0)throw new Error('Backend switches leaked Workers: '+JSON.stringify(window.__workerStats));
  return {passed:true,defaultBackend:'javascript',bars:100000,bothDirections:true,history:true,controller:true,repeatedSwitches:true,workers:window.__workerStats,userAgent:navigator.userAgent};
 })()`,{timeout:120000,label:'main-demo-backend-switch'});
 assert.equal(result.passed,true);
 await writeFile('artifacts/web-rust-wasm/backend-switch-browser.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
