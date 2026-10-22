const owners=new WeakMap(),charts=new WeakMap();
const names=['topLeft','topRight','bottomLeft','bottomRight'];
export function disposeChartOverlays(chart){charts.get(chart)?.destroy();}
/** Fixed host-owned DOM slots. No model geometry, HTML parsing or render callbacks. */
export function attachChartOverlays(container,chart,options={}){
 if(!options||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new TypeError('Overlay options: plain record required');
 for(const key of Reflect.ownKeys(options)){const d=Object.getOwnPropertyDescriptor(options,key);if(key!=='label'||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Overlay own label required');}
 const label=Object.hasOwn(options,'label')?options.label:'Chart overlays';
 if(typeof label!=='string'||!label.trim()||label.length>128)throw new TypeError('Overlay label');
 if(!container||typeof container.append!=='function'||container.children.length)throw new TypeError('Empty overlay container required');
 if(!chart||chart.disposed!==false||!chart.model||chart.model.disposed||!chart.api||chart.api.model!==chart.model||!chart.container||!chart.controller)throw new TypeError('Live chart required');
 if(owners.has(container)||charts.has(chart))throw new Error('Overlay slots already attached');
 const model=chart.model,api=chart.api,controller=chart.controller,host=chart.container,doc=container.ownerDocument??document,token={},slots={};
 const root=doc.createElement('section');root.className='barochart-overlays';root.setAttribute('role','group');root.setAttribute('aria-label',label);
 root.style.cssText='position:relative;width:100%;height:100%;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);padding:8px;gap:8px;pointer-events:none;';
 for(let i=0;i<names.length;i++){
  const slot=doc.createElement('div');slot.setAttribute('data-chart-slot',names[i]);
  slot.style.cssText='min-width:0;max-width:100%;max-height:100%;overflow:auto;pointer-events:auto;overflow-wrap:anywhere;align-self:'+(i<2?'start':'end')+';justify-self:'+(i%2?'end':'start')+';';
  slots[names[i]]=slot;root.append(slot);
 }
 let disposed=false;const record={destroy};owners.set(container,token);charts.set(chart,record);
 const valid=()=>!disposed&&owners.get(container)===token&&charts.get(chart)===record&&chart.disposed===false&&chart.model===model&&!model.disposed&&chart.api===api&&api.model===model&&chart.controller===controller&&chart.container===host;
 function destroy(){
  if(disposed)return;disposed=true;
  const focus=doc.activeElement,focused=root.contains(focus);
  if(charts.get(chart)===record)charts.delete(chart);
  if(owners.get(container)===token)owners.delete(container);
  root.remove();
  const lostFocus=doc.activeElement===null||doc.activeElement===doc.body||doc.activeElement===focus&&!focus?.isConnected;
  if(focused&&lostFocus&&chart.disposed===false&&chart.model===model&&!model.disposed&&chart.api===api&&chart.controller===controller&&!charts.has(chart)&&!owners.has(container))chart.canvas?.focus();
 }
 try{if(!valid())throw new Error('Overlay owner changed');container.append(root);if(!valid())throw new Error('Overlay owner changed');return Object.freeze({slots:Object.freeze(slots),destroy});}
 catch(error){destroy();throw error;}
}
