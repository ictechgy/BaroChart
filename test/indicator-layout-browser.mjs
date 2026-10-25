import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {terminateOwnedBrowser} from '../scripts/browser-lifecycle.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

const root=resolve(import.meta.dirname,'..');
const routePath='/examples/web/index.html';
const route='http://127.0.0.1';
const artifact=process.env.INDICATOR_LAYOUT_BROWSER_ARTIFACT;
const checks=[];
const check=(value,name)=>{assert.ok(value,name);checks.push(name);};

async function availablePort(){
 const probe=createServer();
 await new Promise((resolvePort,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolvePort);});
 const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;
 await new Promise((resolveClose,reject)=>probe.close(error=>error?reject(error):resolveClose()));
 return port;
}

async function startServer(port){
 const child=spawn(process.execPath,['scripts/serve.mjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let output='';const append=chunk=>{output=(output+String(chunk)).slice(-4096);};
 child.stdout.on('data',append);child.stderr.on('data',append);
 const ready=new Promise((resolveReady,rejectReady)=>{
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.off('error',failed);child.off('exit',exited);child.stdout.off('data',readyData);error?rejectReady(error):resolveReady(value);};
  const failed=error=>finish(error);const exited=code=>finish(new Error(`Demo server exited ${code}: ${output.slice(-1200)}`));
  const readyData=()=>{if(output.includes('Aster demo:'))finish(null,true);};
  const timer=setTimeout(()=>finish(new Error(`Demo server startup timed out: ${output.slice(-1200)}`)),15000);
  child.on('error',failed);child.on('exit',exited);child.stdout.on('data',readyData);
 });
 try{await ready;}catch(error){try{await terminateOwnedBrowser(child,{graceMs:1000,killMs:1000});}catch(cleanupError){throw new AggregateError([error,cleanupError],'Demo server startup failed and cleanup was not confirmed',{cause:error});}throw error;}
 return {child,origin:`${route}:${port}`};
}

async function stopServer(server){
 if(!server?.child)return;
 const result=await terminateOwnedBrowser(server.child,{graceMs:1000,killMs:2000});
 if(!result.terminationConfirmed)throw new Error('Demo server termination was not confirmed');
}

const frame=`()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(browser,expression,{timeout=60000,label='browser condition'}={}){
 const deadline=Date.now()+timeout;let last;
 while(Date.now()<deadline){
  last=await browser.evaluate(expression,{timeout:5000,label});
  if(last)return last;
  await sleep(100);
 }
 throw new Error(`${label} timed out after ${timeout}ms${last===undefined?'':` (last=${JSON.stringify(last)})`}`);
}

async function requireControl(browser,id){
 return browser.evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});if(!n)throw new Error('Missing control: '+${JSON.stringify(id)});return {tag:n.tagName,disabled:n.disabled,options:n.tagName==='SELECT'?[...n.options].map(o=>({value:o.value,text:o.textContent})):[]};})()`,{label:`inspect ${id}`});
}

async function setSelect(browser,id,matcher){
 const result=await browser.evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});if(!n)throw new Error('Missing control: '+${JSON.stringify(id)});if(n.tagName!=='SELECT')throw new Error('Control is not a select: '+${JSON.stringify(id)});const options=[...n.options];const wanted=${JSON.stringify(matcher)};const option=wanted.map(value=>options.find(o=>o.value===value||o.textContent?.toLowerCase().includes(value.toLowerCase()))).find(Boolean);if(!option)throw new Error('No matching option for '+${JSON.stringify(id)}+': '+options.map(o=>o.value).join(','));n.value=option.value;n.dispatchEvent(new Event('change',{bubbles:true}));return {value:n.value,options:options.map(o=>o.value)};})()`,{label:`change ${id}`});
 await browser.evaluate(`(${frame})()`);return result.value;
}

async function click(browser,id){
 await browser.evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});if(!n)throw new Error('Missing control: '+${JSON.stringify(id)});if(n.disabled)throw new Error('Control is disabled: '+${JSON.stringify(id)});n.click();return true})()`,{label:`click ${id}`});
 await browser.evaluate(`(${frame})()`);
}

async function waitReady(browser,label='demo ready'){
 return waitFor(browser,`(()=>{const a=window.aster,add=document.getElementById('add-indicator'),section=document.getElementById('indicator-layout-section');return !!a&&!a.model?.disposed&&!a.chart?.disposed&&(!('ready' in a)||a.ready===true)&&!!add&&!add.disabled&&(!section||section.getAttribute('aria-busy')!=='true');})()`,{label});
}

async function snapshot(browser){
 return browser.evaluate(`(()=>{const a=window.aster;if(!a?.model||!a?.chart)throw new Error('window.aster model/chart unavailable');const m=a.model,canvas=a.chart.canvas,store=m.store,refs=window.__indicatorLayoutRefs??={model:m,chart:a.chart,canvas,store,columns:store.columns};const bufferIds=window.__indicatorLayoutBufferIds??=new WeakMap();let nextBufferId=window.__indicatorLayoutNextBufferId??0;const bufferId=buffer=>{if(!bufferIds.has(buffer))bufferIds.set(buffer,++nextBufferId);window.__indicatorLayoutNextBufferId=nextBufferId;return bufferIds.get(buffer);};const outputs={};for(const [id,e] of m.indicators.entries){const names=e.def?.outputs??[];outputs[id]=Object.fromEntries(names.map((name,index)=>{const values=e.arrays?.[index];return [name,values?{buffer:bufferId(values.buffer),length:values.length,last:Array.from(values.slice(Math.max(0,values.length-3)))}:{buffer:null,length:0,last:[]}];}));}return {identity:{model:m===refs.model,chart:a.chart===refs.chart,canvas:a.chart.canvas===refs.canvas,store:store===refs.store,columns:store.columns===refs.columns},storeSample:{first:store.length?store.at(0):null,last:store.length?store.at(store.length-1):null},storeLength:store.length,storeVersion:store.version,outputs,panels:m.panels.map(p=>({id:p.id,weight:p.weight,range:p.range})),axes:m.axes.map(x=>({id:x.id,panel:x.panel,range:x.range})),series:m.series.map(s=>({id:s.id,type:s.type,panel:s.panel,axisId:s.axisId??null,indicator:s.indicator??null,output:s.output??null,source:s.source??null})),drawings:JSON.stringify(m.drawings.items),undo:m.drawings.undoStack.length,redo:m.drawings.redoStack.length,view:{...m.view},scenePanels:a.chart.lastScene?.layout?.panels?.map(p=>({id:p.id,top:p.top,bottom:p.bottom,axes:p.axes?.map(x=>({axisId:x.axisId,min:x.min,max:x.max}))}))??[]};})()`,{label:'capture chart identity'});
}

function sameOutputBuffers(before,after){
 const beforeEntries=Object.entries(before.outputs),afterEntries=Object.fromEntries(Object.entries(after.outputs));
 for(const [id,outputs] of beforeEntries){
  if(!afterEntries[id])return false;
  for(const [name,meta] of Object.entries(outputs))if(afterEntries[id][name]?.buffer!==meta.buffer)return false;
 }
 return true;
}

function summary(snapshot){
 return {identity:snapshot.identity,storeLength:snapshot.storeLength,storeVersion:snapshot.storeVersion,outputBuffers:Object.fromEntries(Object.entries(snapshot.outputs).map(([id,outputs])=>[id,Object.fromEntries(Object.entries(outputs).map(([name,meta])=>[name,meta.buffer]))])),panels:snapshot.panels.map(panel=>panel.id),axes:snapshot.axes.map(axis=>({id:axis.id,panel:axis.panel})),series:snapshot.series.map(series=>({id:series.id,indicator:series.indicator,panel:series.panel,axisId:series.axisId,output:series.output})),drawings:snapshot.drawings,undo:snapshot.undo,redo:snapshot.redo,view:snapshot.view,scenePanels:snapshot.scenePanels};
}

async function runLayoutChecks(browser,origin){
 await browser.navigate(origin+routePath);
 const initial=await waitFor(browser,`(()=>{const count=document.getElementById('count');return !!window.aster||count?.value==='100000';})()`,{timeout:60000,label:'initial asynchronous demo bootstrap'});
 await waitReady(browser,'initial asynchronous model ready');
 const countInfo=await browser.evaluate(`(()=>{const n=document.getElementById('count');return {value:n?.value,options:[...(n?.options??[])].map(o=>o.value),workspaceBusy:document.getElementById('workspace')?.getAttribute('aria-busy')};})()`);
 check(countInfo.options.length>0,'main demo exposes its actual data-count options');
 check(countInfo.value==='100000'||countInfo.value===countInfo.options.find(v=>v==='100000'),'main demo completes the asynchronous 100,000-bar initial load');
 check(countInfo.workspaceBusy!=='true','main demo clears aria-busy after the initial worker result');

 const small=countInfo.options.find(v=>v==='512')??countInfo.options.map(Number).filter(Number.isFinite).sort((a,b)=>a-b)[0];
 check(Number.isFinite(Number(small)),'main demo exposes a bounded query count option');
 if(String(small)!==countInfo.value){await setSelect(browser,'count',[String(small)]);await waitReady(browser,'bounded query count ready');}

 await setSelect(browser,'layout-indicator',['rsi']);
 await setSelect(browser,'layout-panel',['price']);
 await setSelect(browser,'layout-axis',['independent']);
 await browser.evaluate('window.aster.chart.invalidate()');await browser.evaluate(`(${frame})()`);
 check(await browser.evaluate(`document.getElementById('layout-panel').value==='price'&&document.getElementById('layout-axis').value==='independent'`),'pending placement survives a render before Apply');
 const streamVersion=await browser.evaluate('window.aster.model.store.version');
 await click(browser,'stream');
 await waitFor(browser,`window.aster.model.store.version>${streamVersion}`,{timeout:5000,label:'one synthetic stream update'});
 await click(browser,'stream');
 check(await browser.evaluate(`document.getElementById('layout-panel').value==='price'&&document.getElementById('layout-axis').value==='independent'`),'pending placement survives a synthetic stream update');

 const base=await snapshot(browser);
 check(base.storeLength>0&&base.panels.some(p=>p.id==='price'),'ready demo exposes source data and price panel');
 check(base.scenePanels.length>0,'ready demo exposes a rendered scene');
 const drawing=await browser.evaluate(`(()=>{const a=window.aster,m=a.model,b=m.store.at(Math.max(0,m.store.length-20));a.chart.api.setVisibleRange(Math.max(0,m.store.length-180.5),m.store.length-.5);const id=a.chart.api.addDrawing({type:'horizontal',panel:'price',points:[{time:b.time,price:b.close}]});if(!id)throw new Error('Could not add baseline drawing');return {id,drawings:JSON.stringify(m.drawings.items),view:{...m.view},undo:m.drawings.undoStack.length};})()`);
 check(drawing.id&&drawing.undo>0,'baseline drawing and history are live before indicator layout changes');
 await browser.evaluate('window.aster.chart.drawNow()');
 const baseline=await snapshot(browser);

 const controls=['indicator-layout-section','layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down','indicator-layout-status'];
 for(const id of controls)check(!!(await requireControl(browser,id)),`indicator layout control ${id} exists`);
 await browser.evaluate(`(()=>{const s=document.getElementById('indicator-layout-section');if(s?.tagName==='DETAILS')s.open=true;return true})()`);
 await waitFor(browser,`(()=>{const n=document.getElementById('layout-indicator');return !!n&&n.options.length>0&&!n.disabled&&[...n.options].some(o=>o.value==='rsi');})()`,{label:'indicator layout options ready'});

 await setSelect(browser,'layout-indicator',['rsi']);
 await setSelect(browser,'layout-panel',['price']);
 await setSelect(browser,'layout-axis',['independent','primary']);
 await click(browser,'apply-indicator-placement');
 await waitFor(browser,`(()=>{const a=window.aster,m=a?.model;const r=m?.series?.filter(s=>s.indicator==='rsi');return !!r?.length&&r.every(s=>s.panel==='price'&&s.axisId!=null)&&document.getElementById('indicator-layout-status')?.textContent;})()`,{label:'RSI independent price placement'});
 await browser.evaluate('window.aster.chart.drawNow()');
 const independent=await snapshot(browser);
 check(!independent.panels.some(panel=>panel.id==='rsi'),'moving the last RSI series removes its unreferenced host panel');
 check(!await browser.evaluate(`document.getElementById('indicator-layout-status').textContent.includes('도형 기록')`),'ordinary overlay does not claim unrelated drawing-history retention');
 const rsi=independent.series.filter(s=>s.indicator==='rsi');
 check(rsi.length>0&&rsi.every(s=>s.panel==='price'&&s.axisId!==null&&s.axisId!==undefined),'RSI outputs bind to one independent price-panel axis');
 const independentAxis=rsi[0]?.axisId;
 check(independentAxis&&rsi.every(s=>s.axisId===independentAxis),'all RSI outputs share the newly created independent axis');
 const independentScene=independent.scenePanels.find(p=>p.id==='price');
 check(independentScene&&independentScene.bottom>independentScene.top&&independentScene.axes?.some(axis=>axis.axisId===independentAxis&&Number.isFinite(axis.min)&&Number.isFinite(axis.max)&&axis.min<axis.max),`the independent RSI axis is present in the actual scene with a non-collapsed range (${JSON.stringify({axis:independentAxis,scene:independent.scenePanels.find(p=>p.id==='price')})})`);
 const priceBefore=baseline.scenePanels.find(p=>p.id==='price')?.axes?.find(a=>a.axisId==null);
 const priceAfter=independent.scenePanels.find(p=>p.id==='price')?.axes?.find(a=>a.axisId==null);
 check(!priceBefore||!priceAfter||Math.abs((priceBefore.min??0)-(priceAfter.min??0))<1e-9&&Math.abs((priceBefore.max??0)-(priceAfter.max??0))<1e-9,`RSI independent placement leaves the primary price-axis range unchanged (${JSON.stringify({before:priceBefore,after:priceAfter})})`);
 check(independent.identity.model&&independent.identity.chart&&independent.identity.canvas&&independent.identity.store&&independent.identity.columns,'indicator movement preserves model chart canvas and store identity');
 check(independent.storeLength===baseline.storeLength&&JSON.stringify(independent.storeSample)===JSON.stringify(baseline.storeSample),'indicator movement preserves source data and length');
 check(sameOutputBuffers(baseline,independent),'indicator movement preserves existing indicator output buffers');
 check(independent.drawings===baseline.drawings&&independent.undo===baseline.undo&&JSON.stringify(independent.view)===JSON.stringify(baseline.view),'indicator movement preserves drawings history and viewport');

 await click(browser,'separate-indicator-panel');
 await waitReady(browser,'separate RSI panel ready');
 const afterSeparate=await snapshot(browser);
 const rsiPanel=afterSeparate.series.find(s=>s.indicator==='rsi')?.panel;
 check(rsiPanel&&rsiPanel!=='price','RSI can move back to a separate panel');
 const separateScene=afterSeparate.scenePanels.find(panel=>panel.id===rsiPanel);
 check(separateScene&&separateScene.bottom>separateScene.top,'the separate RSI panel has non-collapsed actual scene bounds');
 check(afterSeparate.identity.model&&afterSeparate.identity.canvas&&afterSeparate.identity.store,'separating an indicator panel preserves chart identity');
 check(afterSeparate.drawings===baseline.drawings&&afterSeparate.undo===baseline.undo&&JSON.stringify(afterSeparate.view)===JSON.stringify(baseline.view),'separating an indicator panel preserves drawings history and viewport');

 await setSelect(browser,'layout-panel',[rsiPanel]);
 await setSelect(browser,'reorder-panel',[rsiPanel]);
 const panelOrderBefore=await browser.evaluate(`window.aster.model.panels.map(p=>p.id)`);
 const orderIndex=panelOrderBefore.indexOf(rsiPanel);
 if(orderIndex>0){await click(browser,'panel-up');const panelOrderAfter=await browser.evaluate(`window.aster.model.panels.map(p=>p.id)`);check(panelOrderAfter.indexOf(rsiPanel)===orderIndex-1,'panel-up changes model panel order');}
 else {await click(browser,'panel-down');const panelOrderAfter=await browser.evaluate(`window.aster.model.panels.map(p=>p.id)`);check(panelOrderAfter.indexOf(rsiPanel)===orderIndex+1,'panel-down changes model panel order');}
 const reordered=await snapshot(browser);
 const sceneOrder=reordered.scenePanels.map(p=>p.id);
 check(sceneOrder.indexOf(rsiPanel)>=0&&sceneOrder.indexOf(rsiPanel)!==sceneOrder.indexOf('price'),'panel reorder is reflected in the rendered scene');
 check(reordered.scenePanels.filter(p=>p.id===rsiPanel).every(p=>p.bottom>p.top),'reordered indicator panel remains non-collapsed with valid scene bounds');
 check(reordered.scenePanels.find(p=>p.id===rsiPanel)?.top!==separateScene?.top,'panel reorder changes the indicator panel y position in the actual scene');

 const addControl=await requireControl(browser,'indicator');
 check(addControl.options.some(o=>o.value==='macd'),'main demo exposes MACD in the actual indicator options');
 await setSelect(browser,'indicator',['macd']);
 await click(browser,'add-indicator');
 await waitReady(browser,'MACD add worker result ready');
 const macd=await snapshot(browser);
 check(macd.storeLength===reordered.storeLength,'MACD add preserves the source length while allowing prepared model replacement');
 const macdEntries=macd.series.filter(s=>s.indicator&&s.indicator.startsWith('extra-'));
 check(macdEntries.length>=3,'MACD preparation exposes all non-direction outputs as series');
 const macdId=macdEntries[0]?.indicator;
 const sharedPanel=macdEntries[0]?.panel;
 await setSelect(browser,'layout-indicator',['bb']);
 await setSelect(browser,'layout-panel',[sharedPanel]);
 await setSelect(browser,'layout-axis',['independent']);
 await click(browser,'apply-indicator-placement');
 check(await browser.evaluate(`window.aster.model.series.filter(s=>s.indicator==='bb').every(s=>s.panel===${JSON.stringify(sharedPanel)})`),'a built-in indicator can share an added indicator panel');
 await setSelect(browser,'layout-indicator',[macdId]);
 await setSelect(browser,'layout-panel',['price']);
 await setSelect(browser,'layout-axis',['independent']);
 await click(browser,'apply-indicator-placement');
 await waitFor(browser,`(()=>{const id=${JSON.stringify(macdId)};return !!id&&window.aster?.model?.series?.filter(s=>s.indicator===id).every(s=>s.panel==='price'&&s.axisId!=null);})()`,{label:'MACD independent price overlay'});
 const macdPlaced=await snapshot(browser);
 const priceOverlays=macdPlaced.series.filter(s=>s.indicator===macdId&&s.panel==='price');
 check(priceOverlays.length===macdEntries.length&&priceOverlays.every(s=>s.axisId!=null),'MACD price overlay outputs bind to an independent axis');
 const builtins=macdPlaced.series.filter(s=>['ema','bb','rsi'].includes(s.indicator));
 check(builtins.length>0,'built-in studies remain after adding MACD');
 const beforeClear={panels:macdPlaced.panels.map(p=>p.id),builtins:builtins.map(s=>s.id),drawing:macdPlaced.drawings};
 await click(browser,'clear-indicators');
 await waitReady(browser,'clear added indicators');
 const cleared=await snapshot(browser);
 check(cleared.series.every(s=>!s.indicator?.startsWith('extra-')),'clearing added indicators removes only added study bindings');
 check(beforeClear.builtins.every(id=>cleared.series.some(s=>s.id===id)),'clearing added indicators preserves built-in studies');
 check(cleared.panels.some(panel=>panel.id===sharedPanel)&&cleared.series.filter(s=>s.indicator==='bb').every(s=>s.panel===sharedPanel),'clearing an added indicator preserves its panel used by a built-in indicator');
 check(beforeClear.panels.filter(id=>['price','volume','rsi'].includes(id)).every(id=>cleared.panels.some(p=>p.id===id)),'clearing added indicators preserves used built-in panels');

 const pending=await browser.evaluate(`(()=>{const a=window.aster;const button=document.getElementById('add-indicator');const before={model:a.model,chart:a.chart};button.click();return {disabled:button.disabled,beforeModel:before.model===window.aster.model,beforeChart:before.chart===window.aster.chart};})()`);
 check(pending.disabled,'layout and indicator mutation controls disable while worker computation is pending');
 const pendingLayout=await browser.evaluate(`(()=>{const ids=['layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down'];return ids.every(id=>{const n=document.getElementById(id);return n&&n.disabled;});})()`);
 check(pendingLayout,'all indicator layout controls disable during pending worker computation');
 await waitReady(browser,'pending worker cleanup');

 const gesture=await browser.evaluate(`(()=>{const a=window.aster;if(!a?.chart?.controller)return false;a.chart.controller.gesture={kind:'pan'};return true;})()`);
 if(gesture){
  await setSelect(browser,'layout-indicator',['rsi']);
  await setSelect(browser,'layout-panel',['price']);
  await setSelect(browser,'layout-axis',['primary']);
  await click(browser,'apply-indicator-placement');
  const status=await browser.evaluate(`document.getElementById('indicator-layout-status')?.textContent||''`);
  check(/gesture|제스처|busy|진행|실패/i.test(status),'indicator placement rejects an active gesture with an explicit status');
  await browser.evaluate(`(()=>{if(window.aster?.chart?.controller)window.aster.chart.controller.gesture=null;})()`);
 }

 const beforeTransaction=await browser.evaluate(`(()=>{const m=window.aster.model;m.drawings.begin();return {panels:m.panels.length,axes:m.axes.length};})()`);
 let transactionResult;
 try{await click(browser,'apply-indicator-placement');transactionResult=await browser.evaluate(`({message:document.getElementById('indicator-layout-status').textContent,panels:window.aster.model.panels.length,axes:window.aster.model.axes.length})`);}
 finally{await browser.evaluate('window.aster.model.drawings.cancel()');}
 check(transactionResult.message.includes('진행 중인 입력이 끝난 뒤')&&transactionResult.panels===beforeTransaction.panels&&transactionResult.axes===beforeTransaction.axes,'an open drawing transaction is rejected by the friendly layout gate before creating resources');

 const historyPanel=await browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster,panel=m.series.find(s=>s.indicator==='rsi').panel,bar=m.store.at(m.store.length-1);const id=c.api.addDrawing({type:'horizontal',panel,points:[{time:bar.time,price:50}]});c.api.deleteDrawing(id);return panel;})()`);
 await setSelect(browser,'layout-indicator',['rsi']);await setSelect(browser,'layout-panel',['price']);await setSelect(browser,'layout-axis',['independent']);await click(browser,'apply-indicator-placement');
 check(await browser.evaluate(`window.aster.model.panels.some(p=>p.id===${JSON.stringify(historyPanel)})&&window.aster.model.drawings.undoStack.some(frame=>frame.some(d=>d.panel===${JSON.stringify(historyPanel)}))`),'moving a study preserves its old panel referenced only by drawing history');

 return {checks:checks.length,initial,count:countInfo,before:summary(baseline),independent:summary(independent),afterSeparate:summary(afterSeparate),reordered:summary(reordered),macd:summary(macd),macdPlaced:summary(macdPlaced),cleared:summary(cleared)};
}

async function runRetainedRangeChecks(browser){
 await setSelect(browser,'indicator',['atr']);await click(browser,'add-indicator');await waitReady(browser,'ATR add ready');
 const study=await browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster,id=[...m.indicators.entries].find(([,entry])=>entry.name==='atr')[0],panel=m.series.find(s=>s.indicator===id).panel;c.drawNow();const axis=c.lastScene.layout.axis(panel),price=axis.min+(axis.max-axis.min)*.37,drawing=c.api.addDrawing({type:'horizontal',panel,points:[{time:m.store.at(m.store.length-1).time,price}]});return{id,panel,price,drawing,domain:[axis.min,axis.max]};})()`);
 const domain=async(panel,axisId,price)=>browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster;c.drawNow();const axis=c.lastScene.layout.axis(${JSON.stringify(panel)},${JSON.stringify(axisId)}),config=${axisId===null?`m.panels.find(p=>p.id===${JSON.stringify(panel)})`:`m.axes.find(a=>a.id===${JSON.stringify(axisId)})`};return{domain:[axis.min,axis.max],range:config.range??null,y:axis.y(${price}),top:axis.top,bottom:axis.bottom};})()`);
 const sameDomain=(actual,expected)=>actual.every((value,index)=>Math.abs(value-expected[index])<=Math.max(1,Math.abs(expected[index]))*1e-12);
 const visible=value=>Number.isFinite(value.y)&&value.y>=value.top&&value.y<=value.bottom;
 const reload=async()=>{const count=await browser.evaluate(`(()=>{const n=document.getElementById('count');return [...n.options].map(o=>o.value).filter(v=>v!==n.value).sort((a,b)=>Number(a)-Number(b))[0]})()`);await setSelect(browser,'count',[count]);await waitReady(browser,'retained domain reload');};
 await setSelect(browser,'layout-indicator',[study.id]);await setSelect(browser,'layout-panel',['price']);await setSelect(browser,'layout-axis',['independent']);await click(browser,'apply-indicator-placement');
 const retainedPanel=await domain(study.panel,null,study.price);
 check(!!retainedPanel.range&&sameDomain(retainedPanel.domain,study.domain)&&visible(retainedPanel),'an empty generated panel retains its prior domain and visible unbound drawing');
 await reload();
 const reloadedPanel=await domain(study.panel,null,study.price);
 check(sameDomain(reloadedPanel.domain,study.domain)&&visible(reloadedPanel),'an empty panel keeps its drawing domain through same-market worker reload');
 await setSelect(browser,'layout-indicator',['bb']);await setSelect(browser,'layout-panel',[study.panel]);await setSelect(browser,'layout-axis',['independent']);await click(browser,'apply-indicator-placement');
 const sharedPrimary=await domain(study.panel,null,study.price);
 check(!!sharedPrimary.range&&sameDomain(sharedPrimary.domain,study.domain),'an independent study in the same panel does not release its empty primary-domain pin');
 const overlay=await browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster,axisId=m.series.find(s=>s.indicator===${JSON.stringify(study.id)}).axisId;c.drawNow();const axis=c.lastScene.layout.axis('price',axisId),price=axis.min+(axis.max-axis.min)*.37,drawing=c.api.addDrawing({type:'horizontal',panel:'price',axisId,points:[{time:m.store.at(m.store.length-1).time,price}]});return{axisId,price,drawing,domain:[axis.min,axis.max]};})()`);
 await setSelect(browser,'layout-indicator',[study.id]);await setSelect(browser,'layout-panel',[study.panel]);await setSelect(browser,'layout-axis',['primary']);await click(browser,'apply-indicator-placement');
 const returnedPanel=await domain(study.panel,null,study.price),retainedAxis=await domain('price',overlay.axisId,overlay.price);
 check(returnedPanel.range===null,'returning a study after reload releases only the synthetic primary range');
 check(!!retainedAxis.range&&sameDomain(retainedAxis.domain,overlay.domain)&&visible(retainedAxis),'an empty generated independent axis retains its drawing domain');
 await reload();
 const reloadedAxis=await domain('price',overlay.axisId,overlay.price);
 check(sameDomain(reloadedAxis.domain,overlay.domain)&&visible(reloadedAxis),'an empty independent axis keeps its drawing domain through worker reload');
 const primaryBeforeMove=await domain(study.panel,null,study.price);
 await setSelect(browser,'layout-indicator',[study.id]);await setSelect(browser,'layout-panel',['price']);await setSelect(browser,'layout-axis',['axis:'+overlay.axisId]);await click(browser,'apply-indicator-placement');
 const returnedAxis=await domain('price',overlay.axisId,overlay.price);
 check(returnedAxis.range===null,'returning a study after reload releases the synthetic independent-axis range');
 const primaryWithOverlay=await domain(study.panel,null,study.price);
 check(!!primaryWithOverlay.range&&sameDomain(primaryWithOverlay.domain,primaryBeforeMove.domain),'the primary domain is pinned when only independent-axis series remain in the panel');
 await click(browser,'clear-indicators');
 const clearedAxis=await domain('price',overlay.axisId,overlay.price);
 check(!!clearedAxis.range&&sameDomain(clearedAxis.domain,returnedAxis.domain),'clearing the last study preserves the retained drawing axis domain');
 return {study,retainedPanel,reloadedPanel,returnedPanel,overlay,retainedAxis,reloadedAxis,returnedAxis,clearedAxis};
}

async function runThemeAndFocusChecks(browser){
 await click(browser,'theme');
 const palette=await browser.evaluate(`(()=>{const color=getComputedStyle(document.querySelector('.indicator-layout-grid')).color,background=getComputedStyle(document.getElementById('indicator-layout-section')).backgroundColor;const luminance=text=>text.match(/[\\d.]+/g).slice(0,3).map(Number).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);const light=Math.max(luminance(color),luminance(background)),dark=Math.min(luminance(color),luminance(background));return{color,background,contrast:(light+.05)/(dark+.05)}})()`);
 const order=await browser.evaluate('window.aster.model.panels.map(panel=>panel.id)'),selected=order[order.length-1];
 await setSelect(browser,'reorder-panel',[selected]);
 await browser.evaluate(`document.getElementById('panel-up').focus()`);
 for(let index=1;index<order.length;index++)await click(browser,'panel-up');
 const top=await browser.evaluate(`({panel:window.aster.model.panels[0].id,focus:document.activeElement.id||document.activeElement.tagName})`);
 await browser.evaluate(`document.getElementById('panel-down').focus()`);
 for(let index=1;index<order.length;index++)await click(browser,'panel-down');
 const bottom=await browser.evaluate(`({panel:window.aster.model.panels.at(-1).id,focus:document.activeElement.id||document.activeElement.tagName})`);
 check(top.panel===selected&&bottom.panel===selected,'focused reorder controls move the selected panel to both boundaries');
 check(palette.contrast>=4.5,`light indicator labels keep readable contrast: ${JSON.stringify({palette,top,bottom})}`);
 check(['reorder-panel','panel-down'].includes(top.focus),'reaching the top preserves focus on an enabled layout control');
 check(['reorder-panel','panel-up'].includes(bottom.focus),'reaching the bottom preserves focus on an enabled layout control');
 for(let index=1;index<order.length-1;index++)await click(browser,'panel-up');
 await browser.evaluate(`(()=>{document.getElementById('panel-up').focus();window.aster.chart.container.addEventListener('aster:state',()=>document.getElementById('layout-indicator').focus(),{once:true});})()`);
 await click(browser,'panel-up');
 check(await browser.evaluate(`document.activeElement.id==='layout-indicator'`),'boundary focus repair preserves a newer focus choice made by a state listener');
 await click(browser,'theme');
 return {palette,top,bottom};
}

async function runLayoutHistoryChecks(browser,origin){
 await click(browser,'forget-chart-layout');await browser.navigate(origin+routePath);await waitReady(browser,'fresh layout history');
 await setSelect(browser,'count',['10000']);await waitReady(browser,'bounded history source');
 check(await browser.evaluate(`document.getElementById('layout-undo').disabled&&document.getElementById('layout-redo').disabled`),'a new model starts with an empty layout journal');
 await browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster;window.__indicatorLayoutRefs={model:m,chart:c,canvas:c.canvas,store:m.store,columns:m.store.columns};c.api.addDrawing({id:'history-price',type:'horizontal',panel:'price',points:[{time:m.store.at(m.store.length-1).time,price:m.store.at(m.store.length-1).close}]});})()`);
 const before=await snapshot(browser),bindings=value=>value.series.filter(series=>series.indicator).map(series=>[series.id,series.panel,series.axisId]);
 await setSelect(browser,'layout-indicator',['rsi']);await setSelect(browser,'layout-panel',['price']);await setSelect(browser,'layout-axis',['independent']);await click(browser,'apply-indicator-placement');
 const overlay=await snapshot(browser);check(await browser.evaluate(`!document.getElementById('layout-undo').disabled`),'moving a study records one reversible layout command');
 await browser.evaluate(`document.getElementById('layout-undo').focus()`);await click(browser,'layout-undo');const undone=await snapshot(browser);
 check(JSON.stringify(bindings(undone))===JSON.stringify(bindings(before))&&JSON.stringify(undone.panels.map(p=>p.id))===JSON.stringify(before.panels.map(p=>p.id)),'undo restores study bindings and the pruned source panel');
 check(undone.identity.model&&undone.identity.chart&&undone.identity.store&&sameOutputBuffers(before,undone)&&undone.drawings===before.drawings&&undone.undo===before.undo&&undone.redo===before.redo&&JSON.stringify(undone.view)===JSON.stringify(before.view),'layout undo preserves buffers, source, drawing history and viewport');
 check(await browser.evaluate(`document.activeElement.id==='layout-redo'`),'undo at the journal boundary keeps focus on an enabled history action');
 await click(browser,'layout-redo');const redone=await snapshot(browser);
 check(JSON.stringify(bindings(redone))===JSON.stringify(bindings(overlay))&&redone.axes.some(axis=>axis.id===overlay.series.find(series=>series.indicator==='rsi').axisId),'redo recreates the same independent-axis binding');
 await click(browser,'separate-indicator-panel');const separated=await snapshot(browser),panel=separated.series.find(series=>series.indicator==='rsi').panel;
 await setSelect(browser,'reorder-panel',[panel]);await click(browser,'panel-up');const ordered=await snapshot(browser);
 await click(browser,'layout-undo');const orderUndone=await snapshot(browser);
 check(JSON.stringify(orderUndone.panels.map(p=>p.id))===JSON.stringify(separated.panels.map(p=>p.id)),'panel order is independently undoable');
 await click(browser,'layout-undo');const splitUndone=await snapshot(browser);
 check(JSON.stringify(bindings(splitUndone))===JSON.stringify(bindings(overlay)),'a chained undo reverses panel separation');
 await click(browser,'layout-redo');await click(browser,'layout-redo');const chainRedone=await snapshot(browser);
 check(JSON.stringify(chainRedone.panels.map(p=>p.id))===JSON.stringify(ordered.panels.map(p=>p.id))&&sameOutputBuffers(before,chainRedone),'chained redo restores the layout without replacing indicator buffers');
 await click(browser,'layout-undo');await setSelect(browser,'layout-indicator',['rsi']);await setSelect(browser,'layout-panel',[panel]);await setSelect(browser,'layout-axis',['primary']);await click(browser,'apply-indicator-placement');
 check(await browser.evaluate(`!document.getElementById('layout-redo').disabled`),'a no-op placement preserves the redo branch');
 await setSelect(browser,'editor-indicator',['rsi']);await browser.evaluate(`(()=>{const n=document.getElementById('editor-param-period');n.value='7';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click(browser,'editor-apply-params');await waitReady(browser,'history parameter replacement');
 await browser.evaluate(`(()=>{const n=document.getElementById('editor-color');n.value='#2357ab';n.dispatchEvent(new Event('input',{bubbles:true}));const width=document.getElementById('editor-width');width.value='2.75';width.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click(browser,'editor-apply-style');const styled=await snapshot(browser);
 await click(browser,'layout-redo');const afterSettings=await snapshot(browser);
 check(await browser.evaluate(`window.aster.model.indicators.entries.get('rsi').params.period===7&&window.aster.model.series.filter(s=>s.indicator==='rsi').every(s=>s.width===2.75&&s.color.startsWith('#2357ab'))`),'layout redo preserves newer indicator parameters and styles');
 check(sameOutputBuffers(styled,afterSettings),'layout redo preserves the latest calculated output buffers');
 await click(browser,'layout-undo');
 await browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster;c.api.addDrawing({id:'late-panel-note',type:'horizontal',panel:${JSON.stringify(panel)},points:[{time:m.store.at(m.store.length-1).time,price:50}]});})()`);
 const withNote=await snapshot(browser);await click(browser,'layout-undo');const retained=await snapshot(browser);
 check(retained.series.find(series=>series.indicator==='rsi').panel==='price'&&retained.panels.some(item=>item.id===panel)&&retained.drawings===withNote.drawings&&retained.undo===withNote.undo,'undo retains a newly referenced panel and its drawing history');
 check(await browser.evaluate(`!document.getElementById('layout-redo').disabled`),'retained drawing resources do not invalidate layout redo');
 await click(browser,'undo');check(await browser.evaluate(`!window.aster.model.drawings.items.some(d=>d.id==='late-panel-note')&&!document.getElementById('layout-redo').disabled`),'drawing undo does not clear the layout redo branch');
 await click(browser,'layout-redo');await click(browser,'redo');
 check(await browser.evaluate(`window.aster.model.series.find(s=>s.indicator==='rsi').panel===${JSON.stringify(panel)}&&window.aster.model.drawings.items.some(d=>d.id==='late-panel-note')`),'layout redo and drawing redo remain independent');
 await click(browser,'layout-undo');await setSelect(browser,'layout-indicator',['rsi']);await setSelect(browser,'layout-panel',['volume']);await setSelect(browser,'layout-axis',['independent']);await click(browser,'apply-indicator-placement');
 check(await browser.evaluate(`document.getElementById('layout-redo').disabled&&window.aster.model.drawings.items.some(d=>d.id==='late-panel-note')`),'a new effective layout command branches without changing drawings');
 const guarded=await snapshot(browser);await browser.evaluate(`window.aster.model.drawings.begin()`);try{await click(browser,'layout-undo');}finally{await browser.evaluate(`window.aster.model.drawings.cancel()`);}const blocked=await snapshot(browser);
 check(JSON.stringify(bindings(blocked))===JSON.stringify(bindings(guarded))&&blocked.panels.length===guarded.panels.length,'an active drawing transaction blocks layout history without mutation');
 await setSelect(browser,'count',['100000']);await waitReady(browser,'history source replacement');
 check(await browser.evaluate(`document.getElementById('layout-undo').disabled&&document.getElementById('layout-redo').disabled`),'source/model replacement resets the layout journal');
 await click(browser,'forget-chart-layout');await browser.navigate(origin+routePath);await waitReady(browser,'default chart after history checks');await setSelect(browser,'count',['10000']);await waitReady(browser,'bounded editor source');
 await browser.evaluate(`(()=>{const checkbox=document.getElementById('remember-chart-layout');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 return {checks:checks.length,retainedPanel:panel};
}

async function runEditorPersistenceChecks(browser,origin){
 await setSelect(browser,'indicator',['macd']);await click(browser,'add-indicator');await waitReady(browser,'saved MACD ready');
 const savedExtra=await browser.evaluate(`(()=>{const m=window.aster.model,[id]=[...m.indicators.entries].find(([,entry])=>entry.name==='macd');return{id,panel:m.series.find(s=>s.indicator===id).panel}})()`);
 await setSelect(browser,'editor-indicator',['rsi']);
 const before=await browser.evaluate(`(()=>{const {model:m,chart:c}=window.aster;window.__editorOwners={model:m,store:m.store,drawings:m.drawings,items:m.drawings.items,ema:m.indicators.entries.get('ema')};return{params:m.indicators.entries.get('rsi').params,source:m.store.at(m.store.length-1),length:m.store.length};})()`);
 await browser.evaluate(`(()=>{const n=document.getElementById('editor-param-period');n.value='7';n.dispatchEvent(new Event('input',{bubbles:true}));window.aster.chart.invalidate();})()`);await browser.evaluate(`(${frame})()`);
 check(await browser.evaluate(`document.getElementById('editor-param-period').value==='7'`),'indicator parameter draft survives chart rendering');
 await browser.evaluate(`document.getElementById('editor-apply-params').focus()`);await click(browser,'editor-apply-params');await waitReady(browser,'parameter worker complete');
 check(await browser.evaluate(`(()=>{const m=window.aster.model,r=window.__editorOwners;return m.indicators.entries.get('rsi').params.period===7&&m===r.model&&m.store===r.store&&m.drawings===r.drawings&&m.drawings.items===r.items&&m.indicators.entries.get('ema')===r.ema})()`),'background parameter editing preserves chart source, other indicators and drawings');
 check(await browser.evaluate(`document.activeElement.id==='editor-apply-params'`),'parameter application returns focus to the enabled action after computation');
 await browser.evaluate(`(()=>{const n=document.getElementById('editor-color');n.value='#cc3366';n.dispatchEvent(new Event('input',{bubbles:true}));const w=document.getElementById('editor-width');w.value='3';w.dispatchEvent(new Event('input',{bubbles:true}));const v=document.getElementById('editor-visible');v.checked=false;v.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await click(browser,'editor-apply-style');
 check(await browser.evaluate(`window.aster.model.series.filter(s=>s.indicator==='rsi').every(s=>s.color.startsWith('#cc3366')&&s.width===3&&s.visible===false)`),'individual indicator output color, width and visibility are applied');
 const saved=await browser.evaluate(`(async()=>{let blob;const original=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;URL.createObjectURL=value=>{blob=value;return original(value)};HTMLAnchorElement.prototype.click=function(){};try{document.getElementById('save-chart-layout').click();return blob?await blob.text():null;}finally{URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click}})()`);
 check(typeof saved==='string'&&JSON.parse(saved).schema==='barochart.main-demo-layout','layout file download contains a versioned layout preset');
 await browser.evaluate(`(()=>{const n=document.getElementById('editor-param-period');n.value='11';n.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('editor-apply-params').focus();window.aster.chart.container.addEventListener('aster:state',()=>document.getElementById('theme').focus(),{once:true});})()`);await click(browser,'editor-apply-params');await waitReady(browser,'second parameter worker complete');
 check(await browser.evaluate(`document.activeElement.id==='theme'`),'parameter completion preserves a newer external focus choice');
 const importFile=async(text,name='chart-layout.json')=>{await browser.evaluate(`(()=>{const input=document.getElementById('chart-layout-file'),data=new DataTransfer();data.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'application/json'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await waitReady(browser,'layout file preparation');};
 await waitFor(browser,`(()=>{const text=localStorage.getItem('barochart.main-demo.layout.v1');return text&&JSON.parse(text).preset?.layout.indicators.find(i=>i.id==='rsi')?.params.period===11})()`,{timeout:5000,label:'committed layout saved before stream'});
 const streamVersion=await browser.evaluate(`(()=>{window.__savedStorageSet=Storage.prototype.setItem;window.__streamLayoutWrites=0;Storage.prototype.setItem=function(key,value){if(key==='barochart.main-demo.layout.v1')window.__streamLayoutWrites++;return window.__savedStorageSet.call(this,key,value)};return window.aster.model.store.version})()`);
 await click(browser,'stream');await waitFor(browser,`window.aster.model.store.version>${streamVersion}`,{timeout:5000,label:'source update before layout import'});await click(browser,'stream');
 await browser.evaluate(`new Promise(resolve=>setTimeout(resolve,500))`);
 const streamWrites=await browser.evaluate(`(()=>{Storage.prototype.setItem=window.__savedStorageSet;return window.__streamLayoutWrites})()`);
 check(streamWrites===0,'stream updates and resulting renders do not write layout storage');
 const sourceBeforeImport=await browser.evaluate(`(()=>{const m=window.aster.model;window.__presetDrawingStore=m.drawings;return{length:m.store.length,first:m.store.at(0),last:m.store.at(m.store.length-1),view:{...m.view},follow:m.follow,undo:m.drawings.undoStack.length};})()`);
 await importFile(saved);
 const restored=await browser.evaluate(`(()=>{const m=window.aster.model;return{params:m.indicators.entries.get('rsi').params,length:m.store.length,first:m.store.at(0),last:m.store.at(m.store.length-1),view:{...m.view},follow:m.follow,undo:m.drawings.undoStack.length,sameDrawings:m.drawings===window.__presetDrawingStore};})()`);
 check(restored.params.period===7&&restored.sameDrawings&&restored.undo===sourceBeforeImport.undo,'layout file restore applies settings while retaining the actual drawing history');
 check(restored.length===sourceBeforeImport.length&&JSON.stringify(restored.first)===JSON.stringify(sourceBeforeImport.first)&&JSON.stringify(restored.last)===JSON.stringify(sourceBeforeImport.last)&&JSON.stringify(restored.view)===JSON.stringify(sourceBeforeImport.view)&&restored.follow===sourceBeforeImport.follow,'layout import preserves the current source and viewport');
 await browser.evaluate(`window.__validLayoutModel=window.aster.model`);await importFile('{"schema":"invalid"}');
 check(await browser.evaluate(`window.aster.model===window.__validLayoutModel&&window.aster.model.indicators.entries.get('rsi').params.period===7`),'an invalid layout file leaves the accepted chart unchanged');
 const explicit=JSON.parse(saved);explicit.layout.panels.push({id:'notes',label:'메모 패널',weight:1,range:[0,100]});explicit.layout.axes.push({id:'notes-axis',panel:'notes',side:'right',range:[-1,1]});await importFile(JSON.stringify(explicit));
 const explicitExport=await browser.evaluate(`(async()=>{let blob;const original=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;URL.createObjectURL=value=>{blob=value;return original(value)};HTMLAnchorElement.prototype.click=function(){};try{document.getElementById('save-chart-layout').click();return JSON.parse(await blob.text());}finally{URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click}})()`);
 check(explicitExport.layout.panels.some(p=>p.id==='notes')&&explicitExport.layout.axes.some(a=>a.id==='notes-axis'),'explicit empty preset panels and axes survive immediate export');
 await setSelect(browser,'editor-indicator',['rsi']);
 await browser.evaluate(`(()=>{const n=document.getElementById('editor-param-period');n.value='8';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click(browser,'editor-apply-params');await waitReady(browser,'remembered parameter worker complete');
 await waitFor(browser,`(()=>{const text=localStorage.getItem('barochart.main-demo.layout.v1');return text&&JSON.parse(text).preset?.layout.indicators.find(i=>i.id==='rsi')?.params.period===8})()`,{timeout:5000,label:'layout remembered'});
 await browser.navigate(origin+routePath);await waitReady(browser,'remembered layout on refresh');
 check(await browser.evaluate(`window.aster.model.indicators.entries.get('rsi').params.period===8&&window.aster.model.series.filter(s=>s.indicator==='rsi').every(s=>s.color.startsWith('#cc3366')&&s.width===3&&s.visible===false)`),'refresh restores remembered indicator parameters and styles');
 check(await browser.evaluate(`window.aster.model.panels.some(p=>p.id==='notes')&&window.aster.model.axes.some(a=>a.id==='notes-axis')`),'refresh preserves explicit empty resources');
 const existingIds=await browser.evaluate(`Array.from(window.aster.model.indicators.entries.keys())`);
 await setSelect(browser,'indicator',['macd']);await click(browser,'add-indicator');await waitReady(browser,'additional restored-study model ready');
 const addedIds=await browser.evaluate(`Array.from(window.aster.model.indicators.entries.keys())`);
 check(addedIds.length===existingIds.length+1&&existingIds.every(id=>addedIds.includes(id)),'adding a study after restore does not collide with restored identifiers');
 await click(browser,'clear-indicators');
 check(await browser.evaluate(`!window.aster.model.panels.some(p=>p.id===${JSON.stringify(savedExtra.panel)})&&window.aster.model.panels.some(p=>p.id==='notes')&&window.aster.model.axes.some(a=>a.id==='notes-axis')`),'cleanup after restore removes generated empty resources and retains explicit ones');
 await setSelect(browser,'editor-indicator',['rsi']);await click(browser,'editor-remove');
 check(await browser.evaluate(`!window.aster.model.indicators.entries.has('rsi')&&window.aster.model.series.every(s=>s.indicator!=='rsi')&&window.aster.model.indicators.entries.has('ema')`),'individual removal deletes only the selected study and its outputs');
 const storageFailure=await browser.evaluate(`(()=>{const original=Storage.prototype.setItem,before=localStorage.getItem('barochart.main-demo.layout.v1');Storage.prototype.setItem=function(){throw new DOMException('Denied','QuotaExceededError')};try{const checkbox=document.getElementById('remember-chart-layout');checkbox.checked=false;checkbox.dispatchEvent(new Event('change',{bubbles:true}));const toggle=checkbox.checked&&localStorage.getItem('barochart.main-demo.layout.v1')===before;document.getElementById('forget-chart-layout').click();return{toggle,clear:checkbox.checked&&localStorage.getItem('barochart.main-demo.layout.v1')===before}}finally{Storage.prototype.setItem=original}})()`);
 check(storageFailure.toggle&&storageFailure.clear,'failed storage preferences preserve the saved record and restore the checked control');
 await click(browser,'forget-chart-layout');await browser.navigate(origin+routePath);await waitReady(browser,'default chart after forgetting layout');
 check(await browser.evaluate(`window.aster.model.indicators.entries.has('rsi')&&!document.getElementById('remember-chart-layout').checked`),'forgetting saved layout persists opt-out and restores the default chart on refresh');
 return {sourceLength:before.length,restoredParameters:restored.params};
}

async function runResponsiveChecks(browser,origin){
 const results=[];
 for(const [width,height] of [[320,568],[390,844],[1280,900]]){
  await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:width<=390?2:1,mobile:width<=390,screenWidth:width,screenHeight:height});
  await browser.navigate(origin+routePath);await waitReady(browser,`responsive ${width}x${height}`);
  const result=await browser.evaluate(`(()=>{const root=document.documentElement,section=document.getElementById('indicator-layout-section'),status=document.getElementById('indicator-layout-status');const controls=['layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel','panel-up','panel-down','layout-undo','layout-redo'].map(id=>document.getElementById(id));return {width:innerWidth,height:innerHeight,scrollWidth:root.scrollWidth,section:!!section,controls:controls.map(n=>({id:n?.id,disabled:n?.disabled,text:n?.textContent?.trim()})),status:status?.getBoundingClientRect().height??0,readable:controls.every(n=>n&&n.getBoundingClientRect().width>24&&n.getBoundingClientRect().height>20)};})()`);
  check(result.scrollWidth<=width+1,`indicator layout ${width}x${height} has no horizontal overflow`);
  check(result.section&&result.readable,`indicator layout ${width}x${height} keeps readable controls`);
  const editor=await browser.evaluate(`(()=>{const controls=['save-chart-layout','load-chart-layout','editor-indicator','editor-param-period','editor-apply-params','editor-output','editor-color','editor-width','editor-apply-style','editor-remove'].map(id=>document.getElementById(id));return{readable:controls.every(n=>n&&!n.disabled&&n.getBoundingClientRect().width>24&&n.getBoundingClientRect().height>20),touchTargets:['remember-chart-layout','editor-visible'].every(id=>document.getElementById(id)?.closest('label')?.getBoundingClientRect().height>=44)}})()`);
  check(editor.readable,`indicator editor and preset actions remain readable at ${width}x${height}`);
  if(width<=390)check(editor.touchTargets,`checkbox labels provide touch targets at ${width}x${height}`);
  results.push(result);
 }
 return results;
}

const port=await availablePort();let server;let browser;const startedAt=Date.now();let browserInfo={};
try{
 server=await startServer(port);browser=await launchBrowser({width:1280,height:900,dpr:1});browserInfo=await browser.send('Browser.getVersion',{},null);
 const behavior=await runLayoutChecks(browser,server.origin);const retainedRanges=await runRetainedRangeChecks(browser);const accessibility=await runThemeAndFocusChecks(browser);const history=await runLayoutHistoryChecks(browser,server.origin);const editing=await runEditorPersistenceChecks(browser,server.origin);const responsive=await runResponsiveChecks(browser,server.origin);
 const result={status:'passed',checks:checks.length,behavior,retainedRanges,accessibility,history,editing,responsive,environment:{node:process.version,chromeOverride:Boolean(process.env.CHROME_BIN),browserProduct:browserInfo.product??'unknown',route:routePath,durationMs:Date.now()-startedAt}};
 if(artifact){await mkdir(resolve(artifact,'..'),{recursive:true});await writeFile(artifact,JSON.stringify(result,null,2));}
 console.log(JSON.stringify(result));
}catch(error){const result={status:'failed',checks:checks.length,error:String(error?.message??error),environment:{node:process.version,chromeOverride:Boolean(process.env.CHROME_BIN),browserProduct:browserInfo.product??'unknown',route:routePath,durationMs:Date.now()-startedAt}};if(artifact){await mkdir(resolve(artifact,'..'),{recursive:true});await writeFile(artifact,JSON.stringify(result,null,2));}throw error;
}finally{try{await browser?.close();}finally{await stopServer(server);}}
