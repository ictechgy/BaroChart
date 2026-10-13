import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {launchBrowser} from '../scripts/cdp.mjs';

const server=spawn(process.execPath,['scripts/serve.mjs'],{stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',code=>reject(Error('Fixture server '+code)));});
const results=[];let browser;
try {
  for(const dpr of [1,2]) {
    browser=await launchBrowser({dpr,width:1280,height:900});await browser.navigate('http://127.0.0.1:5173/benchmarks/harness.html');
    const row=await browser.evaluate(`(${layerChecks.toString()})(${dpr})`);results.push(row);
    await browser.close();browser=null;
  }
  await writeFile('benchmarks/results/cycle5-layers-browser.json',JSON.stringify({results,scope:'Actual Chrome Canvas/WebGL2, DPR1/2. Cached frames versus independent full raster on every mutation; synthetic controller/DOM inputs, not physical input or performance samples.'},null,2));
  console.log(JSON.stringify({passed:results.reduce((n,r)=>n+r.checks.length,0),cases:results.length,pixelComparisons:results.reduce((n,r)=>n+r.pixels.length,0)}));
} finally {await browser?.close();server.kill();}

async function layerChecks(initialDpr) {
  const A=await import('/src/index.mjs'),checks=[],pixels=[],check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);};
  // Repeated pixel reads otherwise migrate one Canvas context to a software
  // rasterizer while the fresh oracle remains GPU-backed, changing text AA.
  // Pin both to the same readback backend; performance uses unmodified contexts.
  const getContext=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,options){return getContext.call(this,type,type==='2d'?{...options,willReadFrequently:true}:options);};
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  for(const kind of ['canvas','webgl2']) {
    const host=document.getElementById('chart');host.style.cssText='width:1000px;height:600px';let ratio=initialDpr;
    const store=new A.BarStore();store.setColumns(A.seededColumns(1000,42));
    const model=new A.ChartModel({store,panels:[{id:'price',weight:3},{id:'volume',weight:1}]});
    model.addSeries({id:'price',type:'candles',panel:'price'});model.addSeries({id:'v',type:'histogram',source:'volume',panel:'volume',color:'#5a7195'});
    for(let i=0;i<6;i++)model.addSeries({id:'l'+i,type:'line',source:i%2?'low':'close',panel:'price',color:i%2?'#f5b85a':'#7898ff'});
    const first=store.at(850),last=store.at(950);
    model.drawings.add({type:'trendline',points:[{time:first.time,price:first.close},{time:last.time,price:last.close}]});
    model.drawings.add({type:'text',points:[{time:last.time,price:last.high}],text:'저장된 관찰',style:{font:'14px monospace'}});
    const chart=A.createChart(host,model,{renderer:kind,dpr:()=>ratio,observeResize:false});
    check(chart.rendererKind===kind,kind+': selected actual renderer');
    const mutate=async(action)=>{const canvas=chart.canvas,pending=new Promise(resolve=>canvas.addEventListener('aster:render',resolve,{once:true}));action();await pending;};
    const readGL=(gl,canvas)=>{const raw=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,raw);check(gl.getError()===0,kind+': GL state valid');const data=new Uint8Array(raw.length);for(let y=0;y<canvas.height;y++)data.set(raw.subarray((canvas.height-y-1)*canvas.width*4,(canvas.height-y)*canvas.width*4),y*canvas.width*4);return data;};
    let renderedPixels;
    const capture=()=>{renderedPixels=chart.rendererKind==='webgl2'?readGL(chart.renderer.gl,chart.canvas):chart.ctx.getImageData(0,0,chart.canvas.width,chart.canvas.height).data;};
    chart.canvas.addEventListener('aster:render',capture);
    chart.onFallback=()=>chart.canvas.addEventListener('aster:render',capture);
    await frames();
    const compare=stage=>{
      const canvas=chart.canvas,size=chart.size(),scene=A.buildScene(model,size.width,size.height),reference=document.createElement('canvas');reference.width=canvas.width;reference.height=canvas.height;
      let actual,expected,renderer;
      if(chart.rendererKind==='webgl2'){actual=renderedPixels;renderer=new A.WebGLRenderer(reference);renderer.render(scene,ratio);expected=readGL(renderer.gl,reference);}
      else{actual=renderedPixels;const context=reference.getContext('2d',{alpha:false});A.renderCanvas(context,scene,ratio);expected=context.getImageData(0,0,reference.width,reference.height).data;}
      let total=0,max=0,bad=0;
      for(let i=0;i<actual.length;i+=4){let error=0;for(let c=0;c<3;c++){const delta=Math.abs(actual[i+c]-expected[i+c]);total+=delta;error+=delta;max=Math.max(max,delta);}if(error>60)bad++;}
      const mae=total/(canvas.width*canvas.height*3),badFraction=bad/(canvas.width*canvas.height);
      check(chart.rendererKind==='canvas'?max===0:mae<.05&&badFraction<.0005&&max<96,kind+': no stale pixels after '+stage+' (MAE '+mae+',max '+max+',bad '+badFraction+')');
      check(chart.lastScene.layout.geometryKey===scene.layout.geometryKey,kind+': coordinates agree after '+stage);
      check(JSON.stringify(chart.lastScene.commands)===JSON.stringify(scene.commands),kind+': scene commands agree after '+stage);
      pixels.push({kind,initialDpr,ratio,stage,mae,maxChannelError:max,badFraction});renderer?.dispose();reference.width=reference.height=0;
    };
    compare('initial');
    await mutate(()=>chart.controller.move(91,220,180));check(!chart.renderMetrics.baseRedrawn&&!chart.renderMetrics.drawingsRedrawn,kind+': hover reuses both stable layers');compare('hover');
    await mutate(()=>chart.controller.move(91,510,310));compare('crosshair move erases prior overlay');
    await mutate(()=>chart.canvas.dispatchEvent(new PointerEvent('pointerleave')));check(model.crosshair===null,kind+': leave clears cursor');compare('pointer leave');
    await mutate(()=>chart.controller.setTool('trendline'));await mutate(()=>chart.controller.down(1,300,180));await mutate(()=>chart.controller.move(1,500,220));
    check(!chart.renderMetrics.baseRedrawn&&chart.renderMetrics.drawingsRedrawn,kind+': drawing drag reuses data pixels');compare('drawing drag');await mutate(()=>chart.controller.up(1));
    const saved=model.drawings.save();await mutate(()=>chart.api.undo());compare('undo');await mutate(()=>chart.api.redo());check(model.drawings.save()===saved,kind+': redo restores exact document');compare('redo');
    await mutate(()=>chart.api.setVisibleRange(100,400));compare('pan');await mutate(()=>{model.zoom(.7);chart.invalidate();});compare('zoom');
    await mutate(()=>chart.api.setTheme({background:'#f8fafc',grid:'#dfe6ee',text:'#53657d'}));compare('theme');
    await mutate(()=>chart.api.setTheme({background:'#00102080'}));compare('alpha theme');await mutate(()=>chart.api.setVisibleRange(200,500));compare('alpha pan');await mutate(()=>chart.api.setTheme({background:'#f8fafc'}));compare('opaque restoration');
    await mutate(()=>chart.api.setPanel('price',{scale:'percent',base:100}));compare('percent');
    await mutate(()=>chart.api.setPanel('price',{scale:'log',range:[20,300],inverted:true}));compare('log inverted');
    await mutate(()=>chart.api.setPanel('volume',{inverted:true}));compare('inverted volume');
    await mutate(()=>store.update(250,{...store.at(250),high:200,close:200}));compare('historical correction');
    await mutate(()=>{const b=store.at(store.length-1);store.append({...b,time:b.time+60000});});compare('append');
    await mutate(()=>store.prepend([{...store.at(0),time:store.at(0).time-60000}]));compare('prepend');
    await mutate(()=>store.setColumns(A.seededColumns(1200,43)));compare('reset');
    await mutate(()=>chart.api.loadDrawings(saved));compare('drawing reload after reset');
    await mutate(()=>{host.style.cssText='width:720px;height:460px';chart.resize();});compare('resize');
    await mutate(()=>{ratio=initialDpr===1?2:1;chart.invalidate();});compare('DPR change');
    let prefix='A';model.timeFormatter=t=>prefix+t;await mutate(()=>chart.invalidate());prefix='B';chart.drawNow();compare('explicit drawNow reevaluates formatter closure');
    await mutate(()=>{chart.maxCachedPixels=0;chart.invalidate();});check(chart.renderMetrics.cachedPixelBytes===0,kind+': cache budget disables extra surfaces');compare('uncached memory policy');
    await mutate(()=>{chart.maxCachedPixels=8388608;chart.invalidate();});compare('cache re-enabled');
    if(kind==='webgl2'){
      const documentBefore=model.drawings.save();await mutate(()=>chart.controller.setTool('rectangle'));await mutate(()=>chart.controller.down(7,300,150));await mutate(()=>chart.controller.move(7,460,260));
      const renderer=chart.renderer;renderer.gl.getExtension('WEBGL_lose_context').loseContext();await new Promise(resolve=>setTimeout(resolve,100));await frames();
      check(chart.rendererKind==='canvas'&&renderer.disposed&&renderer.layers===null,kind+': context loss releases textures/MSAA and falls back');check(model.drawings.save()===documentBefore&&!chart.controller.gesture,kind+': loss cancels uncommitted drawing');compare('context loss after active drag');
    }
    const surface=chart.layerSurfaces;chart.destroy({disposeModel:true});
    check(!host.querySelector('canvas')&&!store.listeners.size&&chart.frame===null,kind+': no DOM/subscription/RAF');check(chart.sceneCache.base===null&&chart.layerSurfaces===null,kind+': retained chart releases cached scenes');
    if(surface)check(surface.base.width===0&&surface.stable.width===0,kind+': retained layer handles release pixel storage');
  }
  HTMLCanvasElement.prototype.getContext=getContext;
  return {initialDpr,checks,pixels};
}
