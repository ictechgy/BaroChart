import {loadDemoData} from './load-demo-data.mjs';

const selector=document.getElementById('backend');
const cancelButton=document.getElementById('backend-cancel');
const retryButton=document.getElementById('backend-retry');
const message=document.getElementById('backend-status');
const template=document.querySelector('main').cloneNode(true);
let root=document.querySelector('main'),current=null,transition=null,backendPromise=null,serial=0,closed=false,suspended=false,resumeInitialMode=null,ready;
let initialLight=document.documentElement.dataset.chartTheme==='light',initialPreferencesChanged=false;

function status(text){message.textContent=text;}
function check(signal,owner){
 if(closed)throw new DOMException('Backend page is closed','AbortError');
 if(suspended)throw new DOMException('Backend page is suspended','AbortError');
 if(signal.aborted)throw new DOMException('Backend switch cancelled','AbortError');
 if(current!==owner)throw new Error('Backend owner changed during preparation');
}
async function rustBackend(signal){
 if(!backendPromise)backendPromise=import('../../src/web/wasm/backend.mjs').then(({loadRustBackend})=>loadRustBackend()).catch(error=>{backendPromise=null;throw error;});
 if(signal?.aborted)throw new DOMException('Backend switch cancelled','AbortError');
 let abort;
 const stopped=new Promise((_resolve,reject)=>{abort=()=>reject(new DOMException('Backend switch cancelled','AbortError'));signal?.addEventListener('abort',abort,{once:true});});
 try{return signal?await Promise.race([backendPromise,stopped]):await backendPromise;}
 finally{signal?.removeEventListener('abort',abort);}
}
function stageRoot(){
 const next=template.cloneNode(true),width=root.getBoundingClientRect().width;
 next.style.cssText=`position:absolute;left:-100000px;top:0;width:${width}px;box-sizing:border-box;visibility:hidden;pointer-events:none`;
 next.inert=true;document.body.append(next);return next;
}
function portableState(owner){
 const state=owner.state??{};
 return {...state,market:state.market??root.querySelector('#market').value,count:state.count??Number(root.querySelector('#count').value),light:state.light??document.documentElement.dataset.chartTheme==='light'};
}
function initialState(){return {market:root.querySelector('#market').value,count:Number(root.querySelector('#count').value),light:initialLight,preferencesChanged:initialPreferencesChanged};}
function setControls(next,state,input){
 next.querySelector('#market').value=state.market;
 next.querySelector('#count').value=String(state.count);
 next.querySelector('#renderer').value=root.querySelector('#renderer').value;
 if(!input)return;
 const tool=input.tool??'select';
 for(const button of next.querySelectorAll('[data-tool]'))button.setAttribute('aria-pressed',String(button.dataset.tool===tool));
 next.querySelector('#annotation').value=input.text??'';
 next.querySelector('#crosshair-snap').value=input.crosshairSnap?.mode??'free';
 next.querySelector('#magnet').value=input.drawingMagnet?.mode??'off';
}
function bindingFor(state,revision,currency='USD'){
 return {key:'barochart-web-demo:'+state.market,revision:String(revision),adjustmentVersion:'raw-v1',priceUnit:currency,adjustment:'raw'};
}
function commit(candidate,next,owner,signal){
 check(signal,owner);
 const previousRoot=root,previousCurrent=current,previousSelector=selector.value;
 try{
  previousRoot.replaceWith(next);next.style.cssText=template.style.cssText;next.inert=false;
  if(!candidate.publish())throw new Error('Prepared backend was disposed before publication');
  check(signal,owner);
  root=next;current=candidate;selector.value=candidate.backend;
 }catch(error){
  if(next.isConnected)next.replaceWith(previousRoot);
  root=previousRoot;current=previousCurrent;selector.value=previousSelector;
  owner?.publish();throw error;
 }
 const url=new URL(location.href);
 if(candidate.backend==='javascript')url.searchParams.delete('backend');else url.searchParams.set('backend','rust-wasm');
 try{history.replaceState(null,'',url);}catch(error){status('엔진 전환 완료 · 주소 갱신 실패: '+String(error.message).slice(0,100));}
 return owner;
}
async function retire(owner){
 try{await owner?.dispose();}catch(error){status('전환 완료 · 이전 화면 정리: '+String(error.message).slice(0,120));}
}
async function switchTo(mode){
 if(!['javascript','rust-wasm'].includes(mode))throw new TypeError('Chart backend');
 if(closed||suspended)throw new DOMException(closed?'Backend page is closed':'Backend page is suspended','AbortError');
 if(transition)throw new Error('Backend switch is already running');
 if(current?.backend===mode){selector.value=mode;return current;}
 const owner=current,controller=new AbortController(),signal=controller.signal;
 transition=controller;selector.value=mode;selector.disabled=true;cancelButton.hidden=false;retryButton.hidden=true;
 let next,candidate,capture,unmountedSession,accepted=false;
 const progress=value=>{check(signal,owner);const phase=value.phase??value.stage??'',detail=/transfer|copy/.test(phase)?'시세와 도형을 옮기고 있습니다.':/calcul|compute|indices/.test(phase)?'지표를 계산하고 있습니다.':'분석 화면을 준비하고 있습니다.';status(detail);};
 try{
  let state=owner?portableState(owner):initialState();
  if(owner){
   if(state.layoutBusy)throw new Error('진행 중인 작업을 마친 뒤 엔진을 전환하세요.');
   const input=owner.backend==='javascript'?owner.chart?.controller:owner.session?.snapshot().interaction;
   if(input?.gesture||input?.gestureKind||input?.pointers?.size||input?.pointerCount||owner.model?.drawings?.transaction||owner.session?.snapshot().drawings.transaction)throw new Error('진행 중인 입력을 마친 뒤 엔진을 전환하세요.');
   owner.pause();root.inert=true;
  }
  if(!owner){
   if(mode==='javascript'){const {mountJavaScriptDemo}=await import('./demo.mjs');state=initialState();candidate=await mountJavaScriptDemo({root,initialState:state,publish:false,signal});}
   else{const backend=await rustBackend(signal),{mountRustDemo}=await import('./rust-demo.mjs');state=initialState();candidate=await mountRustDemo({root,backend,initialState:state,publish:false,loadData:loadDemoData,signal});}
   check(signal,owner);if(!candidate.publish())throw new Error('Initial backend was disposed before publication');current=candidate;accepted=true;selector.value=mode;status(mode==='rust-wasm'?'Rust · WASM 엔진 사용 중':'JavaScript 엔진 사용 중');return candidate;
  }
  next=stageRoot();
  if(mode==='rust-wasm'){
   const [{captureJavaScriptMigration},backend,{mountRustDemo},{saveWorkspace}]=await Promise.all([import('../../src/web/wasm/javascript-migration.mjs'),rustBackend(signal),import('./rust-demo.mjs'),import('../../src/core/workspace.mjs')]);
   check(signal,owner);owner.chart.drawNow();
   const input=owner.chart.controller,size={width:owner.chart.lastScene.width,height:owner.chart.lastScene.height},binding=bindingFor(state,owner.model.store.version,owner.model.symbol?.currency);
   capture=await captureJavaScriptMigration({api:owner.chart.api,input,size,document:saveWorkspace(owner.chart.api,binding),binding,revision:++serial,signal,onProgress:progress});
   unmountedSession=await backend.createSessionFromMigration(capture,{signal,onProgress:progress});
   check(signal,owner);setControls(next,state,input);
   candidate=await mountRustDemo({root:next,backend,initialSession:unmountedSession,initialState:state,publish:false,loadData:loadDemoData,signal});
   unmountedSession=null;capture.check();check(signal,owner);capture.finish();
   const previous=commit(candidate,next,owner,signal);accepted=true;await retire(previous);
  }else{
   const [{importJavaScriptMigration},{mountJavaScriptDemo}]=await Promise.all([import('../../src/web/wasm/javascript-migration.mjs'),import('./demo.mjs')]);
   const configuration=await owner.session.query('web.configuration'),binding=bindingFor(state,owner.session.snapshot().data.version,configuration.symbol?.currency);
   let previous;
   await owner.session.withMigrationCapture(binding,{
    signal,onProgress:progress,
    consume:async portable=>{
     const imported=await importJavaScriptMigration(portable,{signal,onProgress:progress});
     let mounted;
     try{
      check(signal,owner);setControls(next,state,imported.input);
      mounted=await mountJavaScriptDemo({root:next,initialModel:imported.model,initialState:{...state,input:imported.input},publish:false,signal});
      await mounted.chart.drawNow();
      if(mounted.chart.disposed||!mounted.chart.lastScene)throw new Error('JavaScript candidate did not render its first frame');
      check(signal,owner);
      imported.handoff();
      candidate=mounted;
      return {controller:mounted,dispose(){mounted.dispose();next.remove();}};
     }catch(error){try{await mounted?.dispose?.();}catch{}imported.dispose();throw error;}
    },
    activate:({value,handoff})=>{previous=commit(value.controller,next,owner,signal);accepted=true;handoff();return value.controller;},
   });
   await retire(previous);
  }
  status(mode==='rust-wasm'?'Rust · WASM 엔진 사용 중':'JavaScript 엔진 사용 중');
  return current;
 }catch(error){
  if(!accepted){
   const cleanup=[];
   try{if(candidate?.dispose)cleanup.push(Promise.resolve().then(()=>candidate.dispose()));}catch(cleanupError){cleanup.push(Promise.reject(cleanupError));}
   try{if(unmountedSession?.close)cleanup.push(Promise.resolve().then(()=>unmountedSession.close()));}catch(cleanupError){cleanup.push(Promise.reject(cleanupError));}
   try{next?.remove();}catch{}
   if(owner){
    root.inert=false;
    if(!closed&&!suspended)try{owner.resume();}catch{}
    selector.value=owner.backend;
   }else{
    root.inert=false;selector.value=mode;
    if(!closed)retryButton.hidden=false;
   }
   await Promise.allSettled(cleanup);
  }
  status(error.name==='AbortError'?'엔진 전환을 취소했습니다.':String(error.message).slice(0,200));
  throw error;
 }finally{
  capture?.dispose();if(transition===controller)transition=null;selector.disabled=false;cancelButton.hidden=true;
  if(!transition&&!closed&&!suspended&&!current&&resumeInitialMode){const requested=resumeInitialMode;resumeInitialMode=null;ready=requestSwitch(requested);}
 }
}

function requestSwitch(mode){const attempt=switchTo(mode);if(!current)ready=attempt;void attempt.catch(()=>{});return attempt;}
selector.addEventListener('change',()=>requestSwitch(selector.value));
cancelButton.addEventListener('click',()=>transition?.abort());
retryButton.addEventListener('click',()=>{if(!current&&!transition)requestSwitch(selector.value);});
for(const control of [root.querySelector('#market'),root.querySelector('#count')])control?.addEventListener('change',()=>{if(!current)initialPreferencesChanged=true;});
const initialThemeButton=root.querySelector('#theme');
initialThemeButton?.addEventListener('click',()=>{
 if(current)return;initialPreferencesChanged=true;const before=initialThemeButton.getAttribute('aria-pressed')==='true';
 queueMicrotask(()=>{const after=initialThemeButton.getAttribute('aria-pressed')==='true';initialLight=after===before?!before:after;document.documentElement.dataset.chartTheme=initialLight?'light':'dark';initialThemeButton.setAttribute('aria-pressed',String(initialLight));});
});
const onPageHide=event=>{
 if(event.persisted&&!current&&transition)resumeInitialMode=selector.value;
 transition?.abort();suspended=true;
 if(!event.persisted){closed=true;resumeInitialMode=null;}
};
const onPageShow=event=>{
 if(!event.persisted||closed)return;
 suspended=false;root.inert=false;
 try{current?.resume();}catch{}
 if(!current&&!transition&&resumeInitialMode){const requested=resumeInitialMode;resumeInitialMode=null;ready=requestSwitch(requested);}
};
window.addEventListener('pagehide',onPageHide);
window.addEventListener('pageshow',onPageShow);
const initial=new URL(location.href).searchParams.get('backend');
ready=requestSwitch(initial==='rust-wasm'||initial==='rust'?'rust-wasm':'javascript');
window.baroDemo=Object.freeze({get ready(){return ready;},switchTo:requestSwitch,get backend(){return current?.backend??null;},get controller(){return current;}});
