'use client';

import {createElement,forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useRef} from 'react';
import {ChartModel} from '../core/model.mjs';
import {FIELDS} from '../core/data.mjs';
import {optionRecord} from '../core/contracts.mjs';
import {CanvasChart} from '../renderers/canvas.mjs';
import {interactionOptions} from '../renderers/interaction-options.mjs';
import {createChart} from '../renderers/webgl.mjs';

const useCommitEffect=typeof window==='undefined'?useEffect:useLayoutEffect;
const defaultModel=()=>{const model=new ChartModel();model.addSeries({id:'price',type:'candles',panel:'price'});return model;};
const asError=error=>error instanceof Error?error:new Error(String(error));
const interactionKeys=['pointer','wheelZoom','keyboardShortcuts','hitTolerancePx'];
const fingerprintFailure=Symbol('fingerprint failure');
// Descriptor fingerprint: do not evaluate accessor-backed values during render
// or repeatedly report the same rejected props from an onError-driven render.
function descriptorFingerprint(value){
 if(!value||typeof value!=='object')return{key:[typeof value,value]};
 try{const key=[Object.getPrototypeOf(value)];for(const name of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,name);key.push(name,d.value,d.get,d.set,d.enumerable,d.configurable,d.writable);}return{key};}
 catch(error){return{key:[fingerprintFailure,value],error};}
}
function interactionKey(value){return descriptorFingerprint(value).key;}
function readInteraction(props){try{return{value:props.options?.interaction};}catch(error){return{key:[fingerprintFailure,props.options],error};}}
const sameKey=(left,right)=>!!left&&!!right&&left.length===right.length&&left.every((value,index)=>Object.is(value,right[index]));
const themeKeys=['background','grid','text','up','down','crosshair','font'];

/** Renderer ownership follows React; borrowed models remain owned by the caller. */
export const AsterChart=forwardRef(function AsterChart(props,ref){
 const {model,createModel,data,dataRevision,theme,renderer='canvas',options,resetKey,tool,text,drawingTarget,visibleRange,
  onReady,onRender,onState,onError,onFallback,onDispose,style,children,...hostProps}=props;
 const host=useRef(null),active=useRef(null),committed=useRef(props),handle=useRef(null),retryInitialization=useRef(null);
 if(handle.current===null)handle.current={get chart(){return active.current?.chart??null;},get model(){return active.current?.model??null;},get api(){return active.current?.chart.api??null;}};
 useImperativeHandle(ref,()=>handle.current,[]);
 useCommitEffect(()=>{committed.current=props;});
 const report=error=>{const p=committed.current;try{(p.onError??p.options?.onError)?.(asError(error));}catch{}};
 const notify=(name,...args)=>{try{return committed.current[name]?.(...args);}catch(error){report(error);}};
 function synchronize(record,p){
  if(p.data!==undefined){
   try{const key=Array.isArray(p.data)?[p.data]:[...FIELDS.map(field=>p.data?.columns?.[field]),p.data?.length];
    if(!record.dataKey||key.length!==record.dataKey.length||key.some((value,index)=>!Object.is(value,record.dataKey[index]))||!Object.is(record.dataRevision,p.dataRevision)){
     record.dataKey=key;record.dataRevision=p.dataRevision;
     if(Array.isArray(p.data))record.chart.api.setData(Array.from(p.data));else record.chart.api.setColumns(p.data.columns,p.data.length);
    }
   }catch(error){report(error);}
  }else{record.dataKey=undefined;record.dataRevision=undefined;}
  if(p.theme===undefined)record.themeKey=undefined;
  else {const fingerprint=descriptorFingerprint(p.theme);
   if(!sameKey(fingerprint.key,record.themeKey)){
    record.themeKey=fingerprint.key;
    if(Object.hasOwn(fingerprint,'error'))report(fingerprint.error);
    else try{optionRecord(p.theme,themeKeys,'Theme');record.chart.api.setTheme(Object.fromEntries(Object.entries(p.theme).filter(([,value])=>value!==undefined)));}catch(error){report(error);}
   }
  }
  const interactionState=readInteraction(p);
  if(Object.hasOwn(interactionState,'error')){
   if(!sameKey(interactionState.key,record.inputKey)){record.inputKey=interactionState.key;record.inputValues=undefined;report(interactionState.error);}
  }else {const interaction=interactionState.value;
   if(interaction===undefined){record.inputKey=undefined;record.inputValues=undefined;}
   else {const fingerprint=descriptorFingerprint(interaction),key=fingerprint.key;
    if(!sameKey(key,record.inputKey)){
     record.inputKey=key;
     if(Object.hasOwn(fingerprint,'error'))report(fingerprint.error);
     else try{const next=interactionOptions(interaction),values=interactionKeys.map(key=>next[key]);
      if(!record.inputValues||values.some((value,index)=>!Object.is(value,record.inputValues[index]))){record.chart.setInteractionOptions(next);record.inputValues=values;}
     }catch(error){report(error);}
    }
   }
  }
  if(p.tool===undefined)record.tool=undefined;
  else if(!Object.is(p.tool,record.tool)){record.tool=p.tool;try{record.chart.api.setTool(p.tool);}catch(error){report(error);}}
  if(p.text===undefined)record.text=undefined;
  else if(!Object.is(p.text,record.text)){record.text=p.text;try{record.chart.api.setText(p.text);}catch(error){report(error);}}
  if(p.drawingTarget!==undefined){const target=p.drawingTarget,fingerprint=descriptorFingerprint(target),key=fingerprint.key;
   if(!sameKey(key,record.targetKey)){record.targetKey=key;if(Object.hasOwn(fingerprint,'error'))report(fingerprint.error);else try{record.chart.api.setDrawingTarget(target);}catch(error){report(error);}}
  }else record.targetKey=undefined;
  if(p.visibleRange!==undefined){const range=p.visibleRange,fingerprint=descriptorFingerprint(range),key=fingerprint.key;
   if(!sameKey(key,record.rangeKey)){
    record.rangeKey=key;
    if(Object.hasOwn(fingerprint,'error'))report(fingerprint.error);
    else try{if(range===null)record.chart.api.fit();else record.chart.api.setVisibleRange(range?.[0],range?.[1]);}catch(error){report(error);}
   }
  }else record.rangeKey=undefined;
 }
 useEffect(()=>{
  let closed=false,attempted,disposeAttempt=()=>{};
  const initialize=()=>{
  let record,readyCleanup,disposed=false;
  const container=host.current;
  const renderEvent=event=>{if(active.current===record&&event.target===record.chart.canvas)notify('onRender',record.context,event);};
  const stateEvent=event=>{if(active.current===record&&event.target===record.chart.canvas)notify('onState',record.context,event);};
  const cleanup=()=>{
   if(disposed)return;disposed=true;
   container.removeEventListener('aster:render',renderEvent);container.removeEventListener('aster:state',stateEvent);
   if(active.current===record)active.current=null;
   try{readyCleanup?.();}catch(error){report(error);}
   if(record){try{record.chart?.destroy();}catch(error){report(error);}finally{if(record.context)notify('onDispose',record.context);if(record.owned)try{record.model.dispose();}catch(error){report(error);}}}
  };
  try{
   const p=committed.current;if(p.model!==undefined&&p.createModel!==undefined)throw new TypeError('Pass model or createModel, not both');
   if(!['canvas','webgl2','auto'].includes(renderer))throw new TypeError('Unknown renderer');
   const next=p.model!==undefined?p.model:(p.createModel??defaultModel)();
   if(!(next instanceof ChartModel)||next.disposed)throw new TypeError('Expected a live ChartModel');
   record={model:next,owned:p.model===undefined,chart:null};
   const configured={...p.options,onError:report,onFallback:reason=>{try{(committed.current.onFallback??committed.current.options?.onFallback)?.(reason);}catch(error){report(error);}}};
   record.chart=renderer==='canvas'?new CanvasChart(container,next,configured):createChart(container,next,{...configured,renderer});
   record.context=Object.freeze({chart:record.chart,model:next});active.current=record;
   container.addEventListener('aster:render',renderEvent);container.addEventListener('aster:state',stateEvent);
   synchronize(record,p);
   const result=notify('onReady',record.context);if(typeof result==='function')readyCleanup=result;
   else if(result!==undefined){report(new TypeError('onReady must return a synchronous cleanup function or undefined'));Promise.resolve(result).catch(report);}
  }catch(error){cleanup();report(error);}
  return cleanup;
  };
  const retry=()=>{
   if(closed||active.current)return;
   const interactionState=readInteraction(committed.current),key=Object.hasOwn(interactionState,'error')?interactionState.key:interactionKey(interactionState.value);
   if(attempted&&key.length===attempted.length&&key.every((value,index)=>Object.is(value,attempted[index])))return;
   // Record before application callbacks, including an onError-driven rerender.
   attempted=key;disposeAttempt();disposeAttempt=initialize();
  };
  retryInitialization.current=retry;retry();
  return()=>{closed=true;if(retryInitialization.current===retry)retryInitialization.current=null;disposeAttempt();};
 },[model,renderer,resetKey,options?.dpr,options?.interactive,options?.observeResize,options?.layerCaching,options?.maxCachedPixels,options?.rasterCaching,options?.cacheBudget]);
 useEffect(()=>{if(active.current)synchronize(active.current,committed.current);else retryInitialization.current?.();});
 return createElement('div',{...hostProps,ref:host,style:{height:320,...style}});
});
