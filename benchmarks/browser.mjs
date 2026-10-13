import {spawn} from 'node:child_process';import {writeFile,readFile} from 'node:fs/promises';import {launchBrowser} from '../scripts/cdp.mjs';
const asterVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const server=spawn(process.execPath,['scripts/serve.mjs'],{stdio:['ignore','pipe','inherit']});await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',code=>reject(new Error(`Server failed ${code}`)));});
const all=[];let browser;
try {
 for(const dpr of [1,2]) {
  browser=await launchBrowser({dpr,width:1280,height:900});await browser.navigate('http://127.0.0.1:5173/benchmarks/harness.html');await browser.send('Performance.enable');
  const result=await browser.evaluate(`(async()=>{
   const A=await import('/src/index.mjs'),L=await import('/benchmarks/vendor/lightweight-charts-5.2.1.mjs');const host=document.getElementById('chart');const percentile=a=>{const b=[...a].sort((a,b)=>a-b);return {p50:b[Math.floor((b.length-1)*.5)],p95:b[Math.floor((b.length-1)*.95)],p99:b[Math.floor((b.length-1)*.99)]};};const raf=()=>new Promise(r=>requestAnimationFrame(r));const rows=[];
   for(const n of [10000,100000]) {
    const start=performance.now(),columns=A.seededColumns(n,42),generationMs=performance.now()-start,convert=performance.now(),tvBars=Array.from({length:n},(_,i)=>({time:columns.time[i]/1000,open:columns.open[i],high:columns.high[i],low:columns.low[i],close:columns.close[i]})),adapterMs=performance.now()-convert;
    for(const library of n===10000?['Aster','Lightweight Charts']:['Lightweight Charts','Aster']) {
     let chart,model,store,series;const begin=performance.now();
     if(library==='Aster'){store=new A.BarStore();store.setColumns(columns);model=new A.ChartModel({store,axisWidth:82});model.addSeries({id:'price',panel:'price',type:'candles'});chart=new A.CanvasChart(host,model,{interactive:false,observeResize:false,dpr:()=>${dpr}});}
     else{chart=L.createChart(host,{width:1200,height:700,layout:{background:{type:L.ColorType.Solid,color:'#0c1320'},textColor:'#8093ad',attributionLogo:false},grid:{vertLines:{color:'#1d2a3a'},horzLines:{color:'#1d2a3a'}},rightPriceScale:{minimumWidth:82},timeScale:{minBarSpacing:.001,timeVisible:true,secondsVisible:false},handleScroll:false,handleScale:false});series=chart.addSeries(L.CandlestickSeries,{upColor:'#35d2ab',downColor:'#fa6c7c',wickUpColor:'#35d2ab',wickDownColor:'#fa6c7c',borderVisible:false,priceFormat:{type:'price',precision:2,minMove:.01}});series.setData(tvBars);}
     const synchronousCreateSetDataMs=performance.now()-begin;await raf();await raf();const readyAfterTwoRafMs=performance.now()-begin;
     for(const mode of ['recent-200','full','current-update']) {
      if(mode==='current-update'){if(library==='Aster')model.setVisibleRange(n-200.5,n-.5);else chart.timeScale().setVisibleLogicalRange({from:n-200.5,to:n-.5});await raf();await raf();}
      const calls=[],frames=[];let previous;
      for(let i=0;i<105;i++){const t=await raf(),from=mode==='full'?-.5:n-220.5+(i%20),to=mode==='full'?n-.5:from+200;const a=performance.now();if(mode==='current-update'){const close=i%2?columns.high[n-1]:columns.low[n-1];if(library==='Aster')store.update(n-1,{time:columns.time[n-1],open:columns.open[n-1],high:columns.high[n-1],low:columns.low[n-1],close,volume:columns.volume[n-1]});else series.update({...tvBars[n-1],close});}else if(library==='Aster'){model.setVisibleRange(from,to);chart.invalidate();}else chart.timeScale().setVisibleLogicalRange({from,to});const call=performance.now()-a;const end=await raf();if(i>=15){calls.push(call);frames.push(end-t);}previous=end;}
      const common={library,version:library==='Aster'?${JSON.stringify(asterVersion)}:'5.2.1',storedBars:n,visibleLogicalSpan:mode==='full'?n:200,mode,width:1200,height:700,dpr:${dpr},seed:42,generationMs,lightweightSecondsAdapterMs:adapterMs,synchronousCreateSetDataMs,readyAfterTwoRafMs,apiCallMs:percentile(calls),rafIntervalMs:percentile(frames),samples:90};
      if(library==='Aster')common.asterStats=chart.lastScene.stats;
      else common.lightweightVisibleRange=chart.timeScale().getVisibleLogicalRange();rows.push(common);
     }
     if(library==='Aster')chart.destroy({disposeModel:true});else chart.remove();
    }
   }
   // Aster sync submission is separately measurable; does not compare against
   // an undocumented/private synchronous render function in the competitor.
   const store=new A.BarStore();store.setColumns(A.seededColumns(1000000,42));const m=new A.ChartModel({store});m.addSeries({id:'p',type:'candles',panel:'price'});const chart=new A.CanvasChart(host,m,{interactive:false,dpr:()=>${dpr}});await raf();await raf();const timings=[];for(let i=0;i<135;i++){const a=performance.now();chart.drawNow();if(i>=15)timings.push(performance.now()-a);}const million={storedBars:1000000,visibleSourceBars:chart.lastScene.stats.visibleSourceBars,width:1200,height:700,dpr:${dpr},synchronousSceneAndCanvasSubmitMs:percentile(timings),samples:120};chart.destroy({disposeModel:true});
   return {rows,million,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory??null};
  })()`);
  const metrics=await browser.send('Performance.getMetrics'),heap=await browser.send('Runtime.getHeapUsage');all.push({dpr,result,heap,performanceMetrics:metrics.metrics});console.log(`DPR ${dpr} done: ${result.rows.length} matched comparison cases`);
  await browser.close();browser=null;
 }
 const doc={timestamp:new Date().toISOString(),method:'Isolated headless Chrome, single panel candles, no indicators/drawings/stream, identical seed and OHLC, 1200x700 CSS pixels, fixed logical ranges, DPR 1/2. 15 warmup+90 paired rAF samples. rAF intervals are browser scheduling intervals, NOT pure draw time or compositor/display FPS. Create/setData includes library work; input generation and TV seconds adapter separate. Products run serially with order reversed at 100k. GC and compositor can affect tails. Memory is end-of-page process heap/backing storage, NOT per-library retention.',commercialProducts:'TradingView Advanced Charts / Trading Platform and SciChart: not executed; no access/license assumed.',all};
 await writeFile('benchmarks/results/browser.json',JSON.stringify(doc,null,2));console.log('Saved benchmarks/results/browser.json');
} finally {if(browser)await browser.close();server.kill();}
