import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {terminateOwnedBrowser} from '../scripts/browser-lifecycle.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';
import {generateCustomizationCode} from '../examples/web/customization-code.mjs';

const root=resolve(import.meta.dirname,'..');
const route='http://127.0.0.1';
const widths=[[320,568],[390,844],[768,1024],[1280,900]];
const artifact=process.env.CUSTOMIZATION_BROWSER_ARTIFACT;
const checks=[];
const check=(value,name)=>{assert.ok(value,name);checks.push(name);};
const generatedCaption='x'.repeat(128);
const generatedProfile={
 theme:{background:'#0c1320',grid:'#1d2a3a',text:'#8093ad',up:'#35d2ab',down:'#fa6c7c',crosshair:'#b9c9de',font:'12px monospace'},
 layout:{priceWeight:3.5,volumeWeight:1.25,axisSide:'right',placement:'right'},
 ui:{interaction:{pointer:true,wheelZoom:true,keyboardShortcuts:true,hitTolerancePx:12},toolbar:{label:'Chart tools',tools:['select','trendline','rectangle'],actions:['fit','undo'],orientation:'vertical',density:'compact',labels:{select:generatedCaption}}},
 extras:{navigator:true,overlays:true,tradeMarkers:true},
};
const generatedSource=generateCustomizationCode(generatedProfile).replace("from 'barochart';","from '/src/index.mjs';");

async function availablePort(){
 const probe=createServer();
 await new Promise((resolvePort,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolvePort);});
 const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;
 await new Promise((resolveClose,reject)=>probe.close(error=>error?reject(error):resolveClose()));
 return port;
}

async function startServer(port){
 const child=spawn(process.execPath,['scripts/serve.mjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let output='';
 const append=chunk=>{output=(output+String(chunk)).slice(-4096);};
 child.stdout.on('data',append);child.stderr.on('data',append);
 const ready=new Promise((resolveReady,rejectReady)=>{
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.off('error',failed);child.off('exit',exited);child.stdout.off('data',readyData);error?rejectReady(error):resolveReady(value);};
  const failed=error=>finish(error);const exited=code=>finish(new Error(`Demo server exited ${code}: ${output.slice(-1200)}`));
  const readyData=()=>{if(output.includes('Aster demo:'))finish(null,true);};
  const timer=setTimeout(()=>finish(new Error(`Demo server startup timed out: ${output.slice(-1200)}`)),15000);
  child.on('error',failed);child.on('exit',exited);child.stdout.on('data',readyData);
 });
 try{await ready;}catch(error){
  try{await terminateOwnedBrowser(child,{graceMs:1000,killMs:1000});}
  catch(cleanupError){throw new AggregateError([error,cleanupError],'Demo server startup failed and cleanup was not confirmed',{cause:error});}
  throw error;
 }
 return {child,origin:`${route}:${port}`,output};
}

async function stopServer(server){
 if(!server?.child)return;
 const result=await terminateOwnedBrowser(server.child,{graceMs:1000,killMs:2000});
 if(!result.terminationConfirmed)throw new Error('Demo server termination was not confirmed');
}

const frame=`()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`;
const waitStudio=String.raw`(()=>new Promise((resolve,reject)=>{const started=performance.now();const tick=()=>{if(window.customizationStudio?.ready)return resolve(true);if(performance.now()-started>15000)return reject(new Error('customization studio startup timed out'));requestAnimationFrame(tick)};tick()}))()`;
const routePath='/examples/web/customization.html';

async function change(browser,id,value){
 await browser.evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});if(!n)throw new Error('Missing control: '+${JSON.stringify(id)});${typeof value==='boolean'?`n.checked=${value}`:`n.value=${JSON.stringify(String(value))}`};n.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 await browser.evaluate(`(${frame})()`);
}

async function click(browser,id){
 await browser.evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});if(!n)throw new Error('Missing control: '+${JSON.stringify(id)});n.click();return true})()`);
 await browser.evaluate(`(${frame})()`);
}

async function runGeneratedMountCheck(browser,origin){
 const generatedUrl=origin+'/generated-check.mjs';
 const encodedSource=Buffer.from(generatedSource).toString('base64');
 const pending=new Set();let intercepted=0;let unexpected=0;let handlerError=null;
 const off=browser.on('Fetch.requestPaused',params=>{
  let task;
  task=(async()=>{
   try{
    if(params.request.url!==generatedUrl){unexpected++;await browser.send('Fetch.continueRequest',{requestId:params.requestId},undefined,5000);return;}
    intercepted++;await browser.send('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript; charset=utf-8'},{name:'Cache-Control',value:'no-store'}],body:encodedSource},undefined,5000);
   }catch(error){handlerError??=error;try{await browser.send('Fetch.failRequest',{requestId:params.requestId,errorReason:'Failed'},undefined,5000);}catch{}}
  })().finally(()=>pending.delete(task));
  pending.add(task);
 });
 const drain=async()=>{
  const deadline=Date.now()+5000;
  while(pending.size){await Promise.all([...pending]);if(Date.now()>deadline)throw new Error('Generated module Fetch handling timed out');}
 };
 let primaryError=null,cleanupError=null;
 try{
  await browser.send('Fetch.enable',{patterns:[{urlPattern:generatedUrl,requestStage:'Request'}]},undefined,5000);
  const mounted=await browser.evaluate(`(async()=>{const host=document.createElement('div'),sentinel=document.createElement('span');host.id='generated-check-host';host.style.cssText='width:600px;height:500px;overflow:hidden;box-sizing:border-box;';sentinel.id='generated-check-sentinel';sentinel.textContent='preserve';host.append(sentinel);document.body.append(host);const generated=await import(${JSON.stringify(generatedUrl)});const mounted=generated.mountCustomizedChart(host,Array.from({length:32},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:103+i,low:98+i,close:101+i,volume:i+1})),[{id:'generated-marker',tradeID:'generated-trade',time:1700000000000,price:101,panel:'price',side:'buy',label:'Generated marker'}]);window.__generatedCustomizationMount=mounted;window.__generatedCustomizationHost=host;window.__generatedCustomizationSentinel=sentinel;const button=host.querySelector('[data-chart-control="select"]'),chart=mounted.chart.canvas.getBoundingClientRect(),volume=mounted.model.panels.find(panel=>panel.id==='volume');return {hostWidth:host.clientWidth,hostScrollWidth:host.scrollWidth,chart:{width:chart.width,height:chart.height},helpers:{toolbar:!!mounted.toolbar,navigator:!!mounted.navigator,overlays:!!mounted.overlays,tradeMarkers:!!mounted.tradeMarkers},volumeAxis:volume?.axisSide,caption:button?.textContent,captionTitle:button?.title,captionAria:button?.getAttribute('aria-label')};})()`,{timeout:30000,label:'generated customization mount'});
  await drain();
  if(handlerError)throw handlerError;
  check(intercepted===1&&unexpected===0,'generated module is served by one bounded same-origin Fetch interception');
  check(mounted.hostWidth===600&&mounted.hostScrollWidth<=mounted.hostWidth+1,`generated chart host has no horizontal overflow (${mounted.hostWidth}x${mounted.hostScrollWidth})`);
  check(mounted.chart.width>=200&&mounted.chart.height>=300,'generated chart remains visible beside a long right toolbar');
  check(Object.values(mounted.helpers).every(Boolean)&&mounted.volumeAxis==='right','generated module mounts toolbar and optional helpers with the volume axis on the right');
  check(mounted.caption===generatedCaption&&mounted.captionTitle===generatedCaption&&mounted.captionAria===generatedCaption,'generated caption remains exact text across DOM accessibility surfaces');
  const destroyed=await browser.evaluate(`(()=>{const mounted=window.__generatedCustomizationMount,host=window.__generatedCustomizationHost,sentinel=window.__generatedCustomizationSentinel;mounted.destroy();mounted.destroy();return {chartDisposed:mounted.chart.disposed,modelDisposed:mounted.model.disposed,sentinel:host.contains(sentinel),children:host.children.length,owned:!!host.querySelector('[data-barochart-owned]')}})()`);
  check(destroyed.chartDisposed&&destroyed.modelDisposed&&destroyed.sentinel&&destroyed.children===1&&!destroyed.owned,'generated destroy preserves host sentinel and disposes owned chart model');
 }catch(error){primaryError=error;
 }finally{
  try{await drain();}catch(error){cleanupError??=error;}
  off();
  try{await browser.send('Fetch.disable',{},undefined,5000);}catch(error){cleanupError??=error;}
  try{await browser.evaluate(`(()=>{try{window.__generatedCustomizationMount?.destroy();}finally{document.getElementById('generated-check-host')?.remove();delete window.__generatedCustomizationMount;delete window.__generatedCustomizationHost;delete window.__generatedCustomizationSentinel;}})()`);}catch(error){cleanupError??=error;}
 }
 if(primaryError&&cleanupError)throw new AggregateError([primaryError,cleanupError],'Generated browser check failed and cleanup was not confirmed',{cause:primaryError});
 if(primaryError)throw primaryError;
 if(cleanupError)throw cleanupError;
 return {intercepted,unexpected};
}

async function runStudioChecks(browser,origin){
 await browser.navigate(origin+routePath);await browser.evaluate(waitStudio);
 await browser.evaluate('localStorage.clear()');
 await browser.navigate(origin+routePath);await browser.evaluate(waitStudio);
 const initial=await browser.evaluate(`(()=>{const s=window.customizationStudio;return {ready:s.ready,length:s.model.store.length}})()`);
 check(initial.ready,'studio route initializes');check(initial.length>0,'studio exposes nonempty data');
 const beforeIdentity=await browser.evaluate(`(()=>{const s=window.customizationStudio;const c=s.chart,m=s.model;const bar=m.store.at(10);c.api.setVisibleRange(20,80);const id=c.api.addDrawing({type:'horizontal',panel:'price',points:[{time:bar.time,price:bar.close}]});window.__customizationIdentity={canvas:c.canvas,model:m,store:m.store};return {length:m.store.length,drawing:id,drawings:JSON.stringify(m.drawings.items),view:JSON.stringify(m.view),theme:JSON.stringify(m.theme)}})()`);
 check(beforeIdentity.drawing,'drawing API accepts a live drawing');
 await browser.evaluate(`(${frame})()`);
 const canvasSize=await browser.evaluate('(()=>({width:document.querySelector("#customization-chart canvas")?.clientWidth??0,height:document.querySelector("#customization-chart canvas")?.clientHeight??0}))()');
 check(canvasSize.width>0&&canvasSize.height>0,'visible chart canvas has dimensions');
 await change(browser,'preset','light');await change(browser,'font-size',14);await change(browser,'placement','top');await change(browser,'density','compact');await change(browser,'price-weight',5);await change(browser,'volume-weight',2);await change(browser,'axis-side','left');await change(browser,'wheelZoom',false);await change(browser,'hitTolerancePx',18);
 await click(browser,'save-ui');
 const saved=await browser.evaluate(`(()=>({text:localStorage.getItem('barochart.customization.profile.v1'),state:document.getElementById('profile-state').dataset.state}))()`);
 check(saved.state==='saved'&&typeof saved.text==='string','explicit save records a profile');
 const savedState=await browser.evaluate(`(()=>{const s=window.customizationStudio;return {sameCanvas:s.chart.canvas===window.__customizationIdentity.canvas,sameModel:s.chart.model===window.__customizationIdentity.model,sameStore:s.model.store===window.__customizationIdentity.store,length:s.model.store.length,drawings:JSON.stringify(s.model.drawings.items),view:JSON.stringify(s.model.view)}})()`);
 check(savedState.length===beforeIdentity.length,'saved profile excludes data replacement');
 await change(browser,'wheelZoom',true);check(await browser.evaluate('document.getElementById("profile-state").dataset.state')==='dirty','editing marks profile dirty');
 await change(browser,'wheelZoom',false);check(await browser.evaluate('document.getElementById("profile-state").dataset.state')==='saved','reverting restores saved state');
 await change(browser,'preset','dark');await change(browser,'font-size',12);await click(browser,'load-ui');
 const loaded=await browser.evaluate(`(()=>{const s=window.customizationStudio;return {theme:s.model.theme.font,canvas:s.chart.canvas===window.__customizationIdentity.canvas,model:s.chart.model===window.__customizationIdentity.model,store:s.model.store===window.__customizationIdentity.store,length:s.model.store.length,drawings:JSON.stringify(s.model.drawings.items),view:JSON.stringify(s.model.view),wheel:s.chart.interactionOptions.wheelZoom,placement:document.getElementById('placement').value}})()`);
 check(loaded.theme==='14px monospace'&&loaded.wheel===false&&loaded.placement==='top','load restores saved settings');
 check(loaded.canvas&&loaded.model&&loaded.store&&loaded.length===beforeIdentity.length&&loaded.drawings===beforeIdentity.drawings&&loaded.view===beforeIdentity.view,'load preserves chart identity data drawings and viewport');
 await change(browser,'font-size',16);await click(browser,'undo-settings');
 check(await browser.evaluate('document.getElementById("font-size").value')==='14','settings undo restores previous value');
 await click(browser,'redo-settings');check(await browser.evaluate('document.getElementById("font-size").value')==='16','settings redo reapplies value');
 await change(browser,'placement','right');await click(browser,'undo-settings');
 check(await browser.evaluate('document.getElementById("placement").value')==='top'&&await browser.evaluate('document.getElementById("customization-demo").dataset.placement')==='top','settings undo restores toolbar placement');
 await click(browser,'redo-settings');check(await browser.evaluate('document.getElementById("placement").value')==='right'&&await browser.evaluate('document.getElementById("customization-demo").dataset.placement')==='right','settings redo reapplies toolbar placement');
 await change(browser,'show-navigator',true);
 const navigatorMounted=await browser.evaluate(`(()=>({checked:document.getElementById('show-navigator').checked,nodes:document.getElementById('customization-navigator').children.length}))()`);
 check(navigatorMounted.checked&&navigatorMounted.nodes>0,'navigator setting mounts its host nodes');
 await click(browser,'undo-settings');
 const navigatorUndone=await browser.evaluate(`(()=>({checked:document.getElementById('show-navigator').checked,nodes:document.getElementById('customization-navigator').children.length}))()`);
 check(!navigatorUndone.checked&&navigatorUndone.nodes===0,'settings undo removes navigator host nodes');
 await click(browser,'redo-settings');
 const navigatorRedone=await browser.evaluate(`(()=>({checked:document.getElementById('show-navigator').checked,nodes:document.getElementById('customization-navigator').children.length}))()`);
 check(navigatorRedone.checked&&navigatorRedone.nodes>0,'settings redo remounts navigator host nodes');
 const preInvalid=await browser.evaluate(`(()=>({font:document.getElementById('font-size').value,profile:localStorage.getItem('barochart.customization.profile.v1')}))()`);
 await browser.evaluate(`window.customizationStudio.actions.import('{bad')`);await browser.evaluate(`(${frame})()`);
 const invalid=await browser.evaluate(`(()=>({state:document.getElementById('profile-state').dataset.state,font:document.getElementById('font-size').value,profile:localStorage.getItem('barochart.customization.profile.v1')}))()`);
 check(invalid.state==='error'&&invalid.font===preInvalid.font&&invalid.profile===preInvalid.profile,'invalid profile import leaves live settings unchanged');
 const oldSet=await browser.evaluate(`(()=>{const original=Storage.prototype.setItem;window.__customizationOldSet=original;Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError')};return true})()`);check(oldSet,'storage quota fault installed');
 await click(browser,'save-ui');
 const quota=await browser.evaluate(`(()=>{Storage.prototype.setItem=window.__customizationOldSet;return {state:document.getElementById('profile-state').dataset.state,profile:localStorage.getItem('barochart.customization.profile.v1')}})()`);
 check(quota.state==='error'&&quota.profile===saved.text,'quota failure keeps prior saved profile');
 await browser.evaluate(`(()=>{const input=document.getElementById('profile-file'),file=new File([${JSON.stringify(saved.text)}],'profile.json',{type:'application/json'});Object.defineProperty(file,'text',{value:()=>new Promise(resolve=>window.__releaseCustomizationFile=resolve)});const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 await change(browser,'wheelZoom',true);
 await browser.evaluate(`(()=>{window.__customizationOldGet=Storage.prototype.getItem;Storage.prototype.getItem=function(){throw new Error('forced load failure')}})()`);
 await click(browser,'load-ui');
 const failedLoad=await browser.evaluate(`(()=>{Storage.prototype.getItem=window.__customizationOldGet;window.__releaseCustomizationFile?.(${JSON.stringify(saved.text)});return {state:document.getElementById('profile-state').dataset.state,wheel:window.customizationStudio.chart.interactionOptions.wheelZoom}})()`);
 await browser.evaluate(`(${frame})()`);
 check(failedLoad.state==='error'&&failedLoad.wheel===true&&await browser.evaluate('window.customizationStudio.chart.interactionOptions.wheelZoom')===true,'failed load invalidates stale file without overwriting newer settings');
 await click(browser,'load-ui');
 await browser.evaluate(`(()=>{const s=window.customizationStudio,c=s.chart,canvas=c.canvas,b=canvas.getBoundingClientRect();document.querySelector('[data-chart-control="trendline"]')?.click();c.setTool?.('trendline');window.__drawingBounds={x:b.x,y:b.y};return true})()`);
 const bounds=await browser.evaluate('window.__drawingBounds');
 if(bounds){await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:bounds.x+80,y:bounds.y+80,button:'left',clickCount:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.x+220,y:bounds.y+130,button:'left',buttons:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:bounds.x+220,y:bounds.y+130,button:'left',clickCount:1});await browser.evaluate(`(${frame})()`);const drawingState=await browser.evaluate('({count:window.customizationStudio.model.drawings.items.length,pointers:window.customizationStudio.chart.controller.pointers.size,gesture:window.customizationStudio.chart.controller.gesture})');check(drawingState.count>=1&&drawingState.pointers===0&&!drawingState.gesture,'CDP mouse drawing input settles without leaking gesture state');}
 const captionResult=await browser.evaluate(`(()=>{const control=document.getElementById('caption-control'),value=document.getElementById('caption-value'),apply=document.getElementById('caption-apply');if(!control||!value||!apply)throw new Error('Missing caption editor controls');control.value='select';control.dispatchEvent(new Event('change',{bubbles:true}));value.value='이동 <literal>';value.dispatchEvent(new Event('input',{bubbles:true}));const button=document.querySelector('[data-chart-control="select"]');if(!button)throw new Error('Missing select toolbar control');button.focus();const beforeActive=document.activeElement===button;apply.click();const after=document.querySelector('[data-chart-control="select"]');return {sameNode:after===button,text:after.textContent,title:after.title,aria:after.getAttribute('aria-label'),focused:document.activeElement===button,beforeActive,children:after.children.length};})()`);
 check(captionResult.text==='이동 <literal>'&&captionResult.title==='이동 <literal>'&&captionResult.aria==='이동 <literal>','caption editor preserves literal text and accessibility labels');
 check(captionResult.sameNode&&captionResult.beforeActive&&captionResult.focused&&captionResult.children===0,'caption update preserves the focused button node without child markup');
 await change(browser,'tool-set','analysis');
 const preset=await browser.evaluate(`(()=>({value:document.getElementById('tool-set').value,label:document.querySelector('[data-chart-control="select"]')?.textContent}))()`);
 check(preset.value==='analysis','tool preset selection remains recognized');check(preset.label==='이동 <literal>','tool preset preserves custom captions');
 await change(browser,'device-preset','mobile');
 const mobilePreset=await browser.evaluate(`(()=>({value:document.getElementById('tool-set').value,label:document.querySelector('[data-chart-control="select"]')?.textContent}))()`);
 check(mobilePreset.label==='이동 <literal>','device preset preserves custom captions');
 const code=await browser.evaluate(`(()=>{const language=document.getElementById('code-language'),output=document.getElementById('generated-code');if(!language||!output)throw new Error('Missing code generator controls');language.value='javascript';document.getElementById('export-code').click();const javascript=output.value??output.textContent;language.value='typescript';document.getElementById('export-code').click();const typescript=output.value??output.textContent;document.getElementById('copy-code').click();return {javascript,typescript}})()`);
 check(typeof code.javascript==='string'&&code.javascript.length>40&&/toolbar|customization|labels/.test(code.javascript),'JavaScript code export produces usable configuration');
 check(typeof code.typescript==='string'&&code.typescript.length>40&&code.typescript!==code.javascript,'TypeScript code export changes generated language');
 return {checks:checks.length,identity:true,canvas:canvasSize};
}

async function runLayoutCheck(browser,origin,width,height){
 await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:width<=390?2:1,mobile:width<=390,screenWidth:width,screenHeight:height});
 await browser.navigate(origin+routePath);await browser.evaluate(waitStudio);await browser.evaluate(`document.getElementById('tool-set').value='all';document.getElementById('tool-set').dispatchEvent(new Event('change',{bubbles:true}))`);await browser.evaluate(`document.getElementById('profile-section').open=true;document.getElementById('profile-section').scrollIntoView()`);await browser.evaluate(`(${frame})()`);
 const result=await browser.evaluate(`(()=>{const chart=document.getElementById('customization-chart').getBoundingClientRect(),save=document.getElementById('save-ui').getBoundingClientRect(),stage=document.querySelector('.chart-stage').getBoundingClientRect(),rail=document.querySelector('.settings-rail').getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,chart:{top:chart.top,bottom:chart.bottom,width:chart.width,height:chart.height},save:{top:save.top,bottom:save.bottom},stage:{top:stage.top,bottom:stage.bottom},rail:{top:rail.top,bottom:rail.bottom},tools:window.customizationStudio.toolbar.options.tools.length}})()`);
 check(result.scrollWidth<=width+1,`layout ${width}x${height} has no horizontal overflow`);check(result.tools===17,`layout ${width}x${height} mounts all 17 tools`);check(result.stage.top>=-1&&result.stage.bottom<=height+1,`layout ${width}x${height} keeps stage in viewport`);check(result.chart.top>=result.stage.top-1&&result.chart.bottom<=result.stage.bottom+1&&result.chart.width>=200&&result.chart.height>=150,`layout ${width}x${height} keeps chart visible`);if(width<=920){check(result.save.top>=result.stage.bottom-1&&result.save.bottom<=result.rail.bottom+1&&result.save.bottom<=height+1,`layout ${width}x${height} keeps settings save below stage and visible`);}return result;
}

const port=await availablePort();let server;let browser;const layout=[];const startedAt=Date.now();let browserInfo={};
try{
 server=await startServer(port);browser=await launchBrowser({width:1280,height:900,dpr:1});
 browserInfo=await browser.send('Browser.getVersion',{},null);
 const behavior=await runStudioChecks(browser,server.origin);
 const generated=await runGeneratedMountCheck(browser,server.origin);
 for(const [width,height] of widths)layout.push(await runLayoutCheck(browser,server.origin,width,height));
 const result={status:'passed',checks:checks.length,behavior,generated,layout,environment:{node:process.version,chromeOverride:Boolean(process.env.CHROME_BIN),browserProduct:browserInfo.product??'unknown',route:routePath,durationMs:Date.now()-startedAt}};
 if(artifact){await mkdir(resolve(artifact,'..'),{recursive:true});await writeFile(artifact,JSON.stringify(result,null,2));}
 console.log(JSON.stringify(result));
}catch(error){const result={status:'failed',checks:checks.length,error:String(error?.message??error),environment:{node:process.version,chromeOverride:Boolean(process.env.CHROME_BIN),browserProduct:browserInfo.product??'unknown',route:routePath,durationMs:Date.now()-startedAt}};if(artifact){await mkdir(resolve(artifact,'..'),{recursive:true});await writeFile(artifact,JSON.stringify(result,null,2));}throw error;
}finally{try{await browser?.close();}finally{await stopServer(server);}}
