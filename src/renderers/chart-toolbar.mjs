import {chartToolbarOptions as options} from './chart-toolbar-options.mjs';
import {isHoverStateEvent} from './state-notification.mjs';
import {DRAWING_TYPES} from '../core/drawings.mjs';
const owners=new WeakMap(),charts=new WeakMap();
const tools=['select',...DRAWING_TYPES],actions=['fit','zoomIn','zoomOut','undo','redo'];
const labels={select:'Select / pan',trendline:'Trend line',horizontal:'Horizontal line',fibonacci:'Fibonacci retracement',rectangle:'Rectangle',ellipse:'Ellipse',text:'Text',ray:'Ray',extendedline:'Extended line',channel:'Channel',fibextension:'Fibonacci extension',fibfan:'Fibonacci fan',fibtimezones:'Fibonacci time zones',freehand:'Freehand',longposition:'Long position',shortposition:'Short position',measurement:'Measurement',fit:'Fit all',zoomIn:'Zoom in',zoomOut:'Zoom out',undo:'Undo',redo:'Redo'};
export function disposeChartToolbars(chart){charts.get(chart)?.destroy();}
/** Optional HTML controls. The host owns container placement and CSS variables. */
export function attachChartToolbar(container,chart,initial={}){
 const configured=options(initial);
 if(!container||typeof container.append!=='function'||typeof container.addEventListener!=='function'||container.children.length)throw new TypeError('Empty toolbar container required');
 if(!chart||chart.disposed!==false||!chart.api||chart.api.model!==chart.model||!chart.container||!chart.controller)throw new TypeError('Live chart required');
 if(owners.has(container)||charts.has(chart))throw new Error('Toolbar already attached');
 const api=chart.api,model=chart.model,controller=chart.controller,host=chart.container,doc=container.ownerDocument??document,token={};
 let config=configured,disposed=false,busy=false,epoch=0;const rows=new Map();
 const root=doc.createElement('section'),status=doc.createElement('span');root.className='barochart-toolbar';root.setAttribute('role','group');root.tabIndex=-1;
 root.style.cssText='display:flex;gap:var(--barochart-ui-gap,6px);align-items:stretch;flex-wrap:wrap;padding:var(--barochart-ui-padding,6px);background:var(--barochart-ui-background,#0c1320);color:var(--barochart-ui-text,#dfe8f4);';
 status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 status.style.cssText='font:inherit;font-size:12px;overflow-wrap:anywhere;';
 const record={destroy};owners.set(container,token);charts.set(chart,record);
 const valid=()=>!disposed&&owners.get(container)===token&&charts.get(chart)===record&&chart.disposed===false&&chart.api===api&&chart.model===model&&api.model===model&&chart.controller===controller;
 function snapshot(){if(!valid())throw new Error('Toolbar disposed or owner changed');return Object.freeze({...config,activeTool:controller.tool,canUndo:!!controller.gesture||model.drawings.undoStack.length>0,canRedo:model.drawings.redoStack.length>0});}
 function refresh(){
  const state=snapshot(),version=++epoch,current=()=>valid()&&epoch===version;
  const effect=fn=>{if(!current())return false;fn();return current();};
  if(!effect(()=>root.setAttribute('aria-label',config.label))||!effect(()=>root.style.flexDirection=config.orientation==='vertical'?'column':'row'))return null;
  const ids=[...config.tools,...config.actions],wanted=new Set(ids),focus=doc.activeElement;
  for(const[id,row]of rows)if(!wanted.has(id)){
   rows.delete(id);row.button.removeEventListener('click',row.click);
   // Finish retiring the old node before focus can synchronously reconfigure.
   if(!effect(()=>row.button.remove()))return null;
   if(row.button===focus&&!effect(()=>root.focus()))return null;
  }
  for(let i=0;i<ids.length;i++){
   const id=ids[i];let row=rows.get(id);
   if(!row){
    const button=doc.createElement('button');button.type='button';button.textContent=labels[id];button.title=labels[id];button.setAttribute('data-chart-control',id);
    const click=()=>{if(!valid()||busy||rows.get(id)!==row||!config.tools.includes(id)&&!config.actions.includes(id)||button.disabled)return;busy=true;try{
     if(tools.includes(id))api.setTool(id);else if(id==='zoomIn'||id==='zoomOut')api.zoom(id==='zoomIn'?.8:1.25);else api[id]();
     if(valid())status.textContent='';
    }catch(error){if(valid())status.textContent=String(error?.message??'Chart action failed').slice(0,256);}finally{busy=false;if(valid())refresh();}};
    row={button,click};rows.set(id,row);button.addEventListener('click',click);
   }
   const selected=tools.includes(id)&&id===state.activeTool,disabled=id==='undo'?!state.canUndo:id==='redo'?!state.canRedo:false;
   if(disabled&&doc.activeElement===row.button&&!effect(()=>root.focus()))return null;
   if(!effect(()=>row.button.disabled=disabled))return null;
   if(tools.includes(id)&&!effect(()=>row.button.setAttribute('aria-pressed',String(selected))))return null;
   const background=selected?'var(--barochart-ui-selected-background,#18352f)':'var(--barochart-ui-surface,#111d2e)',foreground=selected?'var(--barochart-ui-selected-text,#7ce8ca)':'var(--barochart-ui-text,#dfe8f4)';
   if(!effect(()=>row.button.style.cssText='font:inherit;border:1px solid var(--barochart-ui-border,#2b3950);border-radius:6px;padding:6px 10px;min-height:'+(config.density==='compact'?32:44)+'px;background:'+background+';color:'+foreground+';cursor:'+(disabled?'default':'pointer')+';opacity:'+(disabled?'.5':'1')+';'))return null;
   if(root.children[i]!==row.button){
    const focused=doc.activeElement===row.button;
    if(!effect(()=>root.insertBefore(row.button,root.children[i]??null)))return null;
    if(focused&&(doc.activeElement===null||doc.activeElement===doc.body)&&!effect(()=>row.button.focus()))return null;
   }
  }
  if(!effect(()=>root.append(status)))return null;return state;
 }
 function setOptions(patch){
  if(!valid())throw new Error('Toolbar disposed or owner changed');const next=options(patch,config);config=next;++epoch;
  busy=true;try{if(!config.tools.includes(controller.tool))api.setTool('select');}finally{busy=false;if(valid())refresh();}
  return valid()?snapshot():null;
 }
 function onState(event){if(valid()&&!busy&&event.target===chart.canvas&&!isHoverStateEvent(event,chart.canvas))refresh();}
 function destroy(){if(disposed)return;disposed=true;++epoch;host.removeEventListener('aster:state',onState);for(const row of rows.values())row.button.removeEventListener('click',row.click);rows.clear();if(charts.get(chart)===record)charts.delete(chart);if(owners.get(container)===token){owners.delete(container);root.remove();}}
 try{host.addEventListener('aster:state',onState);container.append(root);if(!valid())throw new Error('Toolbar owner changed');setOptions({});return {get options(){if(!valid())throw new Error('Toolbar disposed or owner changed');return config;},setOptions,snapshot,refresh,destroy};}catch(error){destroy();throw error;}
}
