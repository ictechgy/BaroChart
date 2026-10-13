import {spawn,execFile} from 'node:child_process';
import {access,readFile,writeFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {promisify} from 'node:util';
import {launchBrowser} from '../scripts/cdp.mjs';
import {startFixtureServer} from '../benchmarks/browser-soak.mjs';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function browserInventory(){
 const applications=[['chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],['safari','/Applications/Safari.app'],['edge','/Applications/Microsoft Edge.app'],['firefox','/Applications/Firefox.app']];
 const browsers=[];for(const [name,path] of applications)browsers.push({name,path,installed:await exists(path),tested:false});
 const cache=join(homedir(),'Library','Caches','ms-playwright'),cached=[];for(const name of await readdir(cache).catch(()=>[]))if(/chromium|firefox|webkit/.test(name))cached.push(name);browsers.push({name:'webkit-playwright',path:cache,installed:cached.some(n=>n.startsWith('webkit-')),tested:false});
 const chrome=browsers.find(b=>b.name==='chrome');if(chrome.installed)chrome.version=(await exec(chrome.path,['--version']).catch(e=>({stdout:e.message}))).stdout.trim();
 const safari=browsers.find(b=>b.name==='safari');safari.version=(await exec('/usr/bin/safaridriver',['--version']).catch(e=>({stdout:e.message}))).stdout.trim();
 return {timestamp:new Date().toISOString(),browsers,playwrightCache:cached,scope:'Installed paths/version commands only. Cached Chromium is not a separate browser-engine compatibility result. No browsers installed, downloaded or global preferences changed.'};
}
async function freePort(){const server=createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const port=server.address().port;await new Promise(r=>server.close(r));return port;}
export async function probeSafariDriver(runChecks=null){
 const port=await freePort(),driver=spawn('/usr/bin/safaridriver',['--port',String(port)],{stdio:['ignore','pipe','pipe']}),origin='http://127.0.0.1:'+port;let diagnostic='',session=null;
 driver.stdout.on('data',d=>diagnostic+=d);driver.stderr.on('data',d=>diagnostic+=d);driver.on('error',e=>diagnostic+=e.message);
 const request=async(path,method='GET',body)=>{const r=await fetch(origin+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});const json=await r.json();if(json.value?.error)throw new Error(json.value.message??json.value.error);return json;};
 try{let ready=false;for(let i=0;i<30;i++){if(driver.exitCode!==null)break;try{await request('/status');ready=true;break;}catch{await delay(100);}}if(!ready)return {status:'driver-unavailable',diagnostic:diagnostic.slice(-2000),ownedPort:port,preferencesChanged:false};
  const response=await request('/session','POST',{capabilities:{alwaysMatch:{browserName:'safari','safari:automaticInspection':false,'safari:automaticProfiling':false}}});session=response.value?.sessionId??response.sessionId;if(!session)throw Error('Safari driver returned no owned session');const result=runChecks?await runChecks({request,path:'/session/'+session}):null;return {status:'available',capabilities:response.value?.capabilities,result,ownedPort:port,preferencesChanged:false};
 }catch(error){return {status:/Allow Remote Automation|remote automation|Develop menu/i.test(error.message)?'automation-disabled':'driver-error',reason:error.message,diagnostic:diagnostic.slice(-2000),ownedPort:port,preferencesChanged:false};}
 finally{if(session)await request('/session/'+session,'DELETE').catch(()=>{});driver.kill();}
}
export async function compatRuntime(){
 const checks=[],check=(value,name)=>{if(!value)throw Error(name);checks.push(name);},A=await import('/src/index.mjs'),I=await import('/src/core/indicators.mjs'),W=await import('/src/web/worker.mjs');
 const features={canvas2d:!!document.createElement('canvas').getContext('2d'),webgl2:!!document.createElement('canvas').getContext('webgl2'),moduleWorkers:typeof Worker==='function',pointerEvents:typeof PointerEvent==='function',resizeObserver:typeof ResizeObserver==='function',textDecoder:typeof TextDecoder==='function',offscreenCanvas:typeof OffscreenCanvas==='function',sharedArrayBuffer:typeof SharedArrayBuffer==='function',longTasks:PerformanceObserver.supportedEntryTypes?.includes('longtask')??false};
 const host=document.getElementById('root');host.style.cssText='width:1000px;height:600px';const columns=A.seededColumns(1000,42);columns.open[0]=columns.close[0]=-0;columns.high[0]=1;columns.low[0]=-1;
 const store=new A.BarStore();store.setColumns(columns);const model=new A.ChartModel({store});let canvas,gpu,prepared;
 try{for(const name of I.builtinIndicators.keys()){const result=model.indicators.add(name,name);check(Object.values(result.outputs).every(v=>v.length===1000&&[...v].every(x=>typeof x==='number'&&x!==Infinity&&x!==-Infinity)),'builtin '+name);}
  model.addSeries({id:'price',type:'candles',panel:'price'});model.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema'});canvas=A.createChart(host,model,{renderer:'canvas'});canvas.drawNow();check(!!canvas.lastScene&&Object.is(store.at(0).close,-0),'Canvas and exact Float64 zero');
  const drawing=canvas.api.addDrawing({id:'note',type:'text',points:[{time:store.at(900).time,price:store.at(900).close}],text:'한글 🚀 <img onerror=1>'}),saved=canvas.api.saveDrawings();canvas.api.editDrawing(drawing,{text:'updated'});canvas.api.undo();check(canvas.api.saveDrawings()===saved,'drawing undo');canvas.api.redo();check(model.drawings.items[0].text==='updated','drawing redo');canvas.api.loadDrawings(saved);check(model.drawings.items[0].text.includes('한글'),'drawing Unicode persistence');
  const before=model.view.from;model.drawings.selected=null;canvas.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));check(model.view.from!==before,'keyboard input');
  gpu=A.createChart(host,model,{renderer:'webgl2'});gpu.drawNow();check(!!gpu.lastScene,'WebGL or Canvas fallback draws');const renderer=gpu.rendererKind;
  prepared=await W.prepareChartModel({columns,length:1000,options:{indicators:[{id:'ema',name:'ema',params:{period:20}}],series:[{id:'ema',type:'line',panel:'price',indicator:'ema'}]}});check(prepared.store.length===1000&&Object.is(prepared.store.at(0).close,-0),'actual module worker prepare');const old=prepared.store.at(0),event={kind:'correction',bar:{...old,close:2,high:2}};await W.recomputeInWorker(prepared,event);check(prepared.store.at(0).close===2,'actual module worker correction');
  const controller=new AbortController(),cancelled=W.recomputeInWorker(prepared,{kind:'correction',bar:{...prepared.store.at(0),close:3,high:3}},{signal:controller.signal});controller.abort();let rejected=false;try{await cancelled;}catch(e){rejected=e.name==='AbortError';}check(rejected&&prepared.store.at(0).close===2,'actual module worker abort');
  gpu.destroy();gpu=null;canvas.destroy();canvas=null;model.dispose();prepared.dispose();prepared=null;check(store.listeners.size===0&&!host.querySelector('canvas'),'owned chart cleanup');return {status:'passed',userAgent:navigator.userAgent,checks,features,renderer,limitations:'API/Canvas/worker smoke on this installed browser. No physical touch, screen reader, full Unicode/font catalogue or sustained performance claim.'};
 }finally{gpu?.destroy();canvas?.destroy();model.dispose();prepared?.dispose();}
}
export async function runBrowserCompatibility({sourceRoot=resolve(import.meta.dirname,'..'),output='benchmarks/results/browser-compat.json',safari=false,inventoryOnly=false}={}){
 const inventory=await browserInventory();if(inventoryOnly){const safariProbe=safari?await probeSafariDriver():null;const report={inventory,safari:safariProbe,chrome:null};await writeFile(output,JSON.stringify(report,null,2));return report;}
 const runtime=`try{globalThis.__compatResult=await (${compatRuntime.toString()})();}catch(error){globalThis.__compatResult={status:'failed',message:error.message,stack:error.stack};}`,server=await startFixtureServer(sourceRoot,runtime);let chrome;
 try{chrome=await launchBrowser({dpr:2,width:1280,height:900});await chrome.navigate(server.origin+'/harness.html');const result=await chrome.evaluate('new Promise((resolve,reject)=>{const end=performance.now()+30000,t=setInterval(()=>{if(globalThis.__compatResult){clearInterval(t);resolve(__compatResult)}else if(performance.now()>end){clearInterval(t);reject(Error("compat timeout"))}},20)})');
  const safariResult=safari?await probeSafariDriver(async({request,path})=>{await request(path+'/url','POST',{url:server.origin+'/harness.html'});for(let i=0;i<300;i++){const r=await request(path+'/execute/sync','POST',{script:'return globalThis.__compatResult || null;',args:[]});if(r.value)return r.value;await delay(100);}throw Error('Safari compatibility timeout');}):{status:'not-requested'};
  inventory.browsers.find(b=>b.name==='chrome').tested=result.status==='passed';inventory.browsers.find(b=>b.name==='safari').tested=safariResult.result?.status==='passed';const report={timestamp:new Date().toISOString(),sourceVersion:JSON.parse(await readFile(resolve(sourceRoot,'package.json'),'utf8')).version,inventory,chrome:result,safari:safariResult,untested:['Firefox','Edge','Playwright WebKit'],scope:'Only owned browser profiles or owned Safari automation session; local source fixture only. No enabling Remote Automation or browser preference changes.'};await writeFile(output,JSON.stringify(report,null,2));return report;
 }finally{await chrome?.close();await server.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const args=process.argv.slice(2),read=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},report=await runBrowserCompatibility({sourceRoot:read('--source-root'),output:read('--output'),safari:args.includes('--safari'),inventoryOnly:args.includes('--inventory-only')});console.log(JSON.stringify(report));if(report.chrome?.status==='failed'||report.safari?.result?.status==='failed')process.exitCode=1;}
