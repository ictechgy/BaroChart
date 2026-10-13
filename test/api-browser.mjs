import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {launchBrowser} from '../scripts/cdp.mjs';
const server=spawn(process.execPath,['scripts/serve.mjs'],{stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',c=>reject(new Error(`Server ${c}`)));});
let browser;
try {
 browser=await launchBrowser();await browser.navigate('http://127.0.0.1:5173/benchmarks/harness.html');
 const results=await browser.evaluate(`(async()=>{
  const A=await import('/src/index.mjs'),host=document.getElementById('chart'),checks=[];
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);};
  for(const renderer of ['canvas','webgl2']){
   const model=new A.ChartModel(),chart=A.createChart(host,model,{renderer}),api=chart.api;
   check(chart.rendererKind===renderer,renderer+' facade available');
   api.addSeries({id:'p',type:'candles',panel:'price'});const c=A.seededColumns(40,42);
   const bars=Array.from({length:40},(_,i)=>Object.fromEntries(A.FIELDS.map(k=>[k,c[k][i]])));api.setData(bars);await frame();
   check(chart.lastScene.stats.storedBars===40,renderer+' external input automatically paints');
   api.addPanel({id:'r',range:[0,100]});api.addIndicator('rsi','rsi',{period:14});api.addSeries({id:'r-line',type:'line',panel:'r',indicator:'rsi',output:'value'});
   api.setTheme({background:'#123',font:'bold 18px serif',up:'rgba(20,200,80,0.7)'});await frame();
   check(chart.lastScene.background==='#112233ff'&&chart.lastScene.commands.some(c=>c.font==='bold 18px serif'),renderer+' common theme/panel/indicator output');
   const last=bars.at(-1);api.applyDataEvent({kind:'append',bar:{...last,time:last.time+60000}});api.applyDataEvent({kind:'update',bar:{...last,time:last.time+60000,close:last.high}});await frame();
   const batch=new A.IndicatorEngine(model.store);check(chart.lastScene.stats.storedBars===41&&api.indicatorValues('rsi','value')[40]===batch.add('r','rsi',{period:14}).outputs.value[40],renderer+' stream and indicator batch parity');batch.dispose();
   const id=api.addDrawing({type:'text',text:'한국 🚀',points:[{time:last.time,price:last.close}],style:{font:'italic 24px monospace',color:'#abc'}});
   const saved=api.saveDrawings();api.undo();api.redo();api.editDrawing(id,{locked:true});check(!api.deleteDrawing(id),renderer+' drawing lock');api.editDrawing(id,{locked:false});
   await frame();check(api.saveDrawings()===saved&&chart.lastScene.commands.some(c=>c.text==='한국 🚀'&&c.font==='italic 24px monospace'),renderer+' drawing restoration/font reaches renderer');
   chart.destroy({disposeModel:true});check(!model.store.listeners.size&&!chart.listeners.length,renderer+' facade chart lifecycle');
  }return {checks,userAgent:navigator.userAgent};
 })()`);
 assert.equal(results.checks.length,14);await writeFile('benchmarks/results/api-browser-tests.json',JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.checks.length}));
}finally{if(browser)await browser.close();server.kill();}
