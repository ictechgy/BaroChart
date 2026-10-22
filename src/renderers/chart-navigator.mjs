import {isHoverStateEvent} from './state-notification.mjs';
const owners=new WeakMap(),charts=new WeakMap(),SVG='http://www.w3.org/2000/svg';
export function disposeChartNavigators(chart){charts.get(chart)?.destroy();}
/** Optional single-chart range controls; source data and visible-range semantics stay core-owned. */
export function attachChartNavigator(container,chart,options={}){
 if(!options||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new TypeError('Navigator options: plain record required');
 for(const key of Reflect.ownKeys(options)){const d=Object.getOwnPropertyDescriptor(options,key);if(key!=='label'||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Navigator own label required');}
 const label=Object.hasOwn(options,'label')?options.label:'Chart navigator';
 if(typeof label!=='string'||!label.trim()||label.length>128)throw new TypeError('Navigator label');
 if(!container||typeof container.append!=='function'||container.children.length)throw new TypeError('Empty navigator container required');
 if(!chart||chart.disposed!==false||!chart.model||chart.model.disposed||!chart.api||chart.api.model!==chart.model||!chart.controller||!chart.container)throw new TypeError('Live chart required');
 if(owners.has(container)||charts.has(chart))throw new Error('Navigator already attached');
 const model=chart.model,api=chart.api,controller=chart.controller,host=chart.container,doc=container.ownerDocument??document,token={},listeners=[];
 const root=doc.createElement('section'),summary=doc.createElement('output'),status=doc.createElement('span'),fit=doc.createElement('button');
 root.className='barochart-navigator';root.setAttribute('role','group');root.setAttribute('aria-label',label);root.tabIndex=-1;
 root.style.cssText='display:grid;gap:6px;padding:8px;color:var(--barochart-ui-text,#dfe8f4);background:var(--barochart-ui-background,#0c1320);';
 const svg=doc.createElementNS(SVG,'svg'),line=doc.createElementNS(SVG,'polyline'),brush=doc.createElementNS(SVG,'rect');
 svg.setAttribute('viewBox','0 0 240 48');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label','Sampled close-price overview, not a full-resolution price chart');svg.style.cssText='display:block;width:100%;height:48px;';
 line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','1');line.setAttribute('vector-effect','non-scaling-stroke');
 brush.setAttribute('y','0');brush.setAttribute('height','48');brush.setAttribute('fill','currentColor');brush.setAttribute('fill-opacity','0.15');svg.append(line,brush);root.append(svg);
 const controls={};for(const key of ['from','to']){const row=doc.createElement('label'),text=doc.createElement('span'),input=doc.createElement('input');text.textContent=key==='from'?'Start bar':'End bar';input.type='range';input.step='any';input.setAttribute('data-chart-range',key);input.setAttribute('aria-label',text.textContent);input.style.cssText='min-height:44px;width:100%;';row.append(text,input);root.append(row);controls[key]=input;}
 fit.type='button';fit.textContent='Fit all';fit.style.cssText='font:inherit;min-height:44px;';status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.append(summary,fit,status);
 let disposed=false,busy=false,epoch=0,gesture=null,overview=null;
 const record={destroy};owners.set(container,token);charts.set(chart,record);
 const valid=()=>!disposed&&owners.get(container)===token&&charts.get(chart)===record&&chart.disposed===false&&chart.model===model&&!model.disposed&&chart.api===api&&api.model===model&&chart.controller===controller&&chart.container===host;
 const source=()=>({store:model.store,columns:model.store.columns,version:model.store.version,length:model.store.length,extent:Math.max(10,model.store.length+model.forwardOffset())});
 const same=(a,b)=>a&&b&&a.store===b.store&&a.columns===b.columns&&a.version===b.version&&a.length===b.length&&a.extent===b.extent;
 const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
 function snapshot(){if(!valid())throw new Error('Navigator disposed or owner changed');const s=source();return Object.freeze({from:model.view.from,to:model.view.to,follow:model.follow,totalBars:s.length,extentBars:s.extent,overviewSamples:Math.min(256,s.length)});}
 function refresh(){
  const state=snapshot(),s=source(),version=++epoch,current=()=>valid()&&epoch===version&&same(s,source());
  const effect=fn=>{if(!current())return false;fn();return current();};
  if(gesture&&!same(gesture.source,s))gesture.invalid=true;
  const max=s.extent-.5,from=clamp(state.from,-.5,max-10),to=clamp(state.to,from+10,max);
  for(const key of ['from','to']){
   const input=controls[key],disabled=s.length===0||s.extent===10;
   if(disabled&&doc.activeElement===input&&!effect(()=>root.focus()))return null;
   for(const [field,value]of Object.entries({disabled,min:key==='from'?-.5:from+10,max:key==='from'?to-10:max,value:key==='from'?from:to}))if(!effect(()=>input[field]=field==='disabled'?value:String(value)))return null;
   if(!effect(()=>input.setAttribute('aria-valuetext',String(key==='from'?state.from:state.to))))return null;
  }
  if(s.length===0&&doc.activeElement===fit&&!effect(()=>root.focus()))return null;
  if(!effect(()=>fit.disabled=s.length===0))return null;
  if(!same(overview,s)){
   const count=Math.min(256,s.length),samples=[];let lo=Infinity,hi=-Infinity;
   for(let i=0;i<count;i++){const index=count===1?0:Math.round(i*(s.length-1)/(count-1)),close=s.columns.close[index];if(!Number.isFinite(close))throw new TypeError('Navigator requires finite close values');samples.push({index,close});lo=Math.min(lo,close);hi=Math.max(hi,close);}
   const span=hi-lo,scale=Math.max(Math.abs(lo),Math.abs(hi));
   const points=samples.map(p=>{const ratio=hi===lo?.5:Number.isFinite(span)?(p.close-lo)/span:(p.close/scale-lo/scale)/(hi/scale-lo/scale);return ((p.index+.5)/s.extent*240)+','+(44-ratio*40);}).join(' ');
   if(!effect(()=>line.setAttribute('points',points)))return null;
   overview=s;
  }
  const x=clamp((state.from+.5)/s.extent*240,0,240),right=clamp((state.to+.5)/s.extent*240,0,240);
  if(!effect(()=>brush.setAttribute('x',String(x)))||!effect(()=>brush.setAttribute('width',String(Math.max(0,right-x)))))return null;
  if(!effect(()=>summary.textContent=s.length?`${s.length} stored bars · range ${state.from} to ${state.to}${state.follow?' · following':''}`:'No data'))return null;
  return state;
 }
 function errorText(error){if(valid())status.textContent=String(error?.message??'Navigator action failed').slice(0,256);}
 function change(key){
  if(!valid()||busy||controls[key].disabled)return;
  if(gesture&&gesture.control!==controls[key])return;
  if(gesture&&(gesture.invalid||!same(gesture.source,source()))){gesture.invalid=true;refresh();errorText(new Error('Data changed during navigation; start a new input.'));return;}
  const value=Number(controls[key].value);if(!Number.isFinite(value)){refresh();errorText(new Error('Finite navigator range required'));return;}
  busy=true;try{if(key==='from')api.setVisibleRange(value,Math.max(value+10,model.view.to));else api.setVisibleRange(Math.min(value-10,model.view.from),value);if(valid())status.textContent='';}
  catch(error){errorText(error);}finally{busy=false;if(valid())refresh();}
 }
 function on(node,type,fn){node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));}
 for(const key of ['from','to']){
  const input=controls[key];on(input,'input',()=>change(key));
  const start=(kind,event)=>{if(valid()&&!input.disabled)gesture={kind,control:input,pointerId:event.pointerId,keys:kind==='keyboard'?new Set([event.key]):null,source:source(),invalid:false};};
  on(input,'pointerdown',event=>{if(event.button!==undefined&&event.button!==0||event.isPrimary===false)return;start('pointer',event);});
  on(input,'keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))return;if(!gesture)start('keyboard',event);else if(gesture.kind==='keyboard'&&gesture.control===input)gesture.keys.add(event.key);});
  const end=event=>{if(!gesture||gesture.control!==input)return;if(event.type==='keyup'){if(gesture.kind!=='keyboard'||!gesture.keys.delete(event.key)||gesture.keys.size)return;}if(event.type.startsWith('pointer')&&(gesture.kind!=='pointer'||event.pointerId!==gesture.pointerId))return;gesture=null;if(valid()&&!busy)refresh();};
  for(const type of ['pointerup','pointercancel','keyup','blur'])on(input,type,end);
 }
 on(fit,'click',()=>{if(!valid()||busy||fit.disabled)return;busy=true;gesture=null;try{api.fit();if(valid())status.textContent='';}catch(error){errorText(error);}finally{busy=false;if(valid())refresh();}});
 const onState=event=>{if(valid()&&event.target===chart.canvas&&!isHoverStateEvent(event,chart.canvas)){if(gesture&&!same(gesture.source,source()))gesture.invalid=true;if(!busy)refresh();}};
 function destroy(){if(disposed)return;disposed=true;++epoch;gesture=null;const focus=doc.activeElement,focused=root.contains(focus);host.removeEventListener('aster:state',onState);for(const off of listeners)off();listeners.length=0;overview=null;if(charts.get(chart)===record)charts.delete(chart);if(owners.get(container)===token)owners.delete(container);root.remove();if(focused&&(doc.activeElement===null||doc.activeElement===doc.body||doc.activeElement===focus&&!focus?.isConnected)&&chart.disposed===false&&chart.model===model&&!model.disposed&&chart.api===api&&api.model===model&&chart.controller===controller&&chart.container===host&&!charts.has(chart)&&!owners.has(container))chart.canvas?.focus();}
 try{host.addEventListener('aster:state',onState);if(!valid())throw new Error('Navigator owner changed');container.append(root);if(!valid())throw new Error('Navigator owner changed');refresh();if(!valid())throw new Error('Navigator owner changed');return Object.freeze({snapshot,refresh,destroy});}
 catch(error){destroy();throw error;}
}
