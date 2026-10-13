import {spawn} from 'node:child_process';
const sourceVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
import {writeFile,readFile} from 'node:fs/promises';
import {launchBrowser} from '../scripts/cdp.mjs';
const server = spawn(process.execPath, ['scripts/serve.mjs'], {stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject) => {server.stdout.once('data',resolve);server.once('exit',c=>reject(new Error(`Server failed ${c}`)));});
let browser;const results=[];
try {
 for (const dpr of [1,2]) {
  browser=await launchBrowser({dpr});await browser.navigate('http://127.0.0.1:5173/benchmarks/harness.html');
  const row=await browser.evaluate(`(async()=>{
   const A=await import('/src/index.mjs'),host=document.getElementById('chart');
   let G;try {G=await import('/src/renderers/webgl.mjs');}catch{}
   const percentile=a=>{a.sort((x,y)=>x-y);return {p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],p99:a[Math.floor((a.length-1)*.99)]};};
   const rows=[];for(const mode of ['recent-200','full-million','dense-32-series','1000-drawings']){
    const store=new A.BarStore();store.setColumns(A.seededColumns(mode.includes('million')||mode==='recent-200'?1000000:100000,42));const m=new A.ChartModel({store});m.addSeries({id:'p',type:'candles',panel:'price'});
    if(mode==='full-million'||mode==='dense-32-series')m.fit();
    if(mode==='dense-32-series')for(let j=0;j<32;j++)m.addSeries({id:'s'+j,type:'line',panel:'price',values:Float64Array.from(store.columns.close.subarray(0,store.length),v=>v+(j-16)*.1),color:j%2?'#f5b85a':'#aa91f7'});
    if(mode==='1000-drawings'){const b=store.at(store.length-100);for(let j=0;j<1000;j++)m.drawings.add({type:'trendline',points:[{time:b.time-j*600,price:b.close+(j%100)*.01},{time:b.time+600000,price:b.close-(j%100)*.01}]});m.drawings.undoStack=[];}
    const sceneTimes=[];let scene;for(let i=0;i<100;i++){const t=performance.now();scene=A.buildScene(m,1200,700);if(i>=20)sceneTimes.push(performance.now()-t);}
    for(const renderer of G?['canvas','webgl2']:['canvas']){
     const c=document.createElement('canvas');c.width=1200*${dpr};c.height=700*${dpr};host.append(c);let gl,ctx,engine;
     if(renderer==='webgl2'){try{engine=new G.WebGLRenderer(c);gl=engine.gl;}catch(e){rows.push({mode,renderer,unavailable:e.message});c.remove();continue;}}else ctx=c.getContext('2d',{alpha:false});
     const cpu=[],completed=[],queries=[],elapsed=[],timer=gl?.getExtension('EXT_disjoint_timer_query_webgl2');let disjoint=false;for(let i=0;i<100;i++){const q=timer&&i>=20?gl.createQuery():null;if(q)gl.beginQuery(timer.TIME_ELAPSED_EXT,q);const t=performance.now();if(engine)engine.render(scene,${dpr});else A.renderCanvas(ctx,scene,${dpr});if(q){gl.endQuery(timer.TIME_ELAPSED_EXT);queries.push(q);}const submit=performance.now()-t;if(gl){gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));if(timer)disjoint=disjoint||gl.getParameter(timer.GPU_DISJOINT_EXT);}else ctx.getImageData(0,0,1,1);if(i>=20){cpu.push(submit);completed.push(performance.now()-t);}if(i%10===0)await new Promise(r=>requestAnimationFrame(r));}
     if(timer){await new Promise(r=>requestAnimationFrame(r));disjoint=disjoint||gl.getParameter(timer.GPU_DISJOINT_EXT);for(const q of queries){if(!disjoint&&gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))elapsed.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(q);}}
     const debug=gl?.getExtension('WEBGL_debug_renderer_info');rows.push({mode,renderer,dpr:${dpr},stats:scene.stats,sceneMs:percentile(sceneTimes),cpuSubmitMs:percentile(cpu),submitAndReadbackMs:percentile(completed),gpu:gl?{vendor:gl.getParameter(debug?debug.UNMASKED_VENDOR_WEBGL:gl.VENDOR),renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),timerExtension:!!timer,gpuElapsedQueryMs:elapsed.length?percentile(elapsed):null,timerSamples:elapsed.length,timerDisjoint:disjoint,metrics:engine.metrics,allocatedInstanceBufferBytes:engine.capacityBytes,atlasRGBABytes:2048*2048*4}:null});engine?.dispose();c.remove();
    }m.dispose();
   }return {rows,userAgent:navigator.userAgent};
  })()`);results.push(row);console.log(JSON.stringify(row.rows));await browser.close();browser=null;
 }
 const path=process.env.RENDERER_RESULT??'benchmarks/results/renderer.json';await writeFile(path,JSON.stringify({sourceVersion,timestamp:new Date().toISOString(),seed:42,warmup:20,samples:80,method:'1200x700 CSS pixels; scene generation measured separately. CPU submit includes renderer packing/atlas/GL or Canvas calls. Submit+1 pixel readback forces completion and includes GPU/CPU synchronization and readback; NOT pure GPU time or display FPS. GPU elapsed query spans the render call and may include waits for CPU command arrival; it is not isolated shader time. Disjoint/unavailable queries discarded. Static scenes; glyph cache warmed. Hardware and allocated buffer/atlas bytes recorded; allocated GL sizes are not measured driver VRAM retention. No commercial comparison.',results},null,2));console.log(path);
}finally{if(browser)await browser.close();server.kill();}
