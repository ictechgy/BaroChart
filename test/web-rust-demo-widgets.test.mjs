import assert from 'node:assert/strict';
import test from 'node:test';
import {createRustDemoWidgets} from '../examples/web/rust-demo-widgets.mjs';

class Element {
 constructor(tag,document){this.tagName=tag.toUpperCase();this.nodeType=1;this.ownerDocument=document;this.children=[];this.listeners=new Map();this.attributes=new Map();this.dataset={};this.style={};this.value='';this.textContent='';this.disabled=false;this.checked=false;this.isConnected=true;}
 append(...nodes){for(const node of nodes)if(node){this.children.push(node);node.parentNode=this;}}
 appendChild(node){this.append(node);return node;}
 replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;this.isConnected=false;}
 addEventListener(type,fn,options){const list=this.listeners.get(type)??[];list.push({fn,options});this.listeners.set(type,list);}
 removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)??[]).filter(row=>row.fn!==fn));}
 dispatch(type,detail={}){const event={target:this,detail,key:detail.key,defaultPrevented:false,isComposing:false,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},stopImmediatePropagation(){this.immediateStopped=true;},...detail};for(const row of this.listeners.get(type)??[]){row.fn(event);if(event.immediateStopped)break;}return event;}
 click(){this.onclick?.({target:this});this.dispatch('click');}
 setAttribute(name,value){this.attributes.set(name,String(value));}
 getAttribute(name){return this.attributes.get(name)??null;}
 focus(){this.ownerDocument.activeElement=this;}
 contains(node){return node===this||this.walk().includes(node);}
 walk(){return this.children.flatMap(child=>[child,...child.walk()]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 querySelectorAll(selector){
  const nodes=this.walk();
  if(selector.startsWith('#'))return nodes.filter(node=>node.id===selector.slice(1));
  if(selector==='button,input')return nodes.filter(node=>['BUTTON','INPUT'].includes(node.tagName));
  if(selector==='input[data-param]')return nodes.filter(node=>node.tagName==='INPUT'&&node.dataset.param);
  if(selector==='button')return nodes.filter(node=>node.tagName==='BUTTON');
  if(selector==='input')return nodes.filter(node=>node.tagName==='INPUT');
  return [];
 }
 get textContent(){return this._text||this.children.map(child=>child.textContent).join('');}
 set textContent(value){this._text=String(value);}
}
class Document extends Element {
 constructor(){super('document',null);this.nodeType=9;this.ownerDocument=this;this.activeElement=null;}
 createElement(tag){return new Element(tag,this);}
 getElementById(id){return this.querySelector(`#${id}`);}
}

const ids=['indicator-search','indicator-category','indicator','indicator-search-summary','add-indicator','clear-indicators','indicator-editor','drawing-controls','chart-readout','explore','explore-read','explorer-readout','explorer-live'];
function host(document,label){const root=document.createElement('main');root.dataset.owner=label;for(const id of ids){const tag=id.includes('search')?'input':id==='indicator'||id==='indicator-category'?'select':id.includes('indicator')&&id!=='indicator-editor'?'button':'div';const node=document.createElement(tag);node.id=id;root.append(node);}document.append(root);return root;}
const wait=()=>new Promise(resolve=>setImmediate(resolve));
function rustSession(){
 const calls=[];
 const configuration={schema:'aster.web-wasm.configuration',version:1,axisWidth:85,symbol:{id:'TEST',timezone:'UTC',currency:'USD',volumeUnit:'shares',priceDecimals:2},
  indicators:[{id:'extra-1',name:'ema',params:{period:9},outputs:['value'],plotOffsets:{value:0}}],
  series:[{id:'extra-1-value',indicator:'extra-1',output:'value',label:'My EMA',panel:'price',type:'line',color:'#123456',width:2,visible:true}]};
 const drawings={items:[{id:'d1',type:'trendline',visible:true,locked:false,points:[{time:1,price:2}]}]};
 const state={data:{length:10,version:1},view:{from:0,to:9},interaction:{crosshair:{x:400,y:100}}};
 return {calls,configuration,drawings,state,
  async query(name){calls.push(['query',name]);if(name==='web.indicatorCatalog')return{entries:[{name:'ema',params:['period','source'],outputs:['value'],provenance:'builtin'},{name:'pressure',params:[],outputs:['value'],provenance:'builtin'}]};if(name==='web.configuration')return structuredClone(configuration);if(name==='web.drawingsState')return structuredClone(drawings);throw Error(name);},
  snapshot(){return structuredClone(state);},
  async command(name,args){calls.push(['command',name,structuredClone(args)]);if(name==='dataAt'){assert.deepEqual(Object.keys(args[0]),['index']);assert.equal(args[1].indicatorMode,'cached');const index=args[0].index;return{index,time:1000+index,primary:{bar:{time:1000+index,open:1,high:3,low:0,close:2,volume:4}},series:[{id:'extra-1-value',label:'My EMA',status:'value',value:2.5}]};}if(name==='removeSeries'){const at=configuration.series.findIndex(row=>row.id===args[0]);if(at>=0)configuration.series.splice(at,1);}if(name==='removeIndicator'){const at=configuration.indicators.findIndex(row=>row.id===args[0]);if(at>=0)configuration.indicators.splice(at,1);}if(name==='setDrawingVisibility'){const row=drawings.items.find(item=>item.id===args[0]);if(row)row.visible=args[1];return{changed:row?1:0};}if(name==='setDrawingsVisibility'){for(const row of drawings.items)if(args[0].includes(row.id))row.visible=args[1];return{changed:args[0].length};}if(name==='setDrawingsStyle'){for(const row of drawings.items)if(args[0].includes(row.id))row.style={...(row.style??{}),...args[1]};return{changed:args[0].length};}if(name==='duplicateDrawings'){const created=[];for(const id of args[0]){const source=drawings.items.find(item=>item.id===id),copy=structuredClone(source),next=`copy-${id}`;copy.id=next;copy.locked=false;copy.points=copy.points.map(point=>({time:point.time+args[1].deltaTimeMs,price:point.price+args[1].deltaPrice}));drawings.items.push(copy);created.push({sourceId:id,id:next});}return{changed:created.length,created};}if(name==='deleteDrawings'){drawings.items=drawings.items.filter(row=>!args[0].includes(row.id));return{changed:args[0].length};}return{name,ok:true};},
  async setIndicatorParams(id,params){calls.push(['params',id,structuredClone(params)]);configuration.indicators[0].params=structuredClone(params);return{status:'committed'};},
 };
}

test('scoped Rust widgets use Korean catalog metadata and actual indicator IDs for params/styles',async()=>{
 const document=new Document(),root=host(document,'active'),other=host(document,'staged'),rust=rustSession(),chart={canvas:document.createElement('canvas'),lastScene:{width:800}};let added=null;
 other.querySelector('#indicator-search-summary').textContent='other-owner';
 const widgets=createRustDemoWidgets({root,getSession:()=>rust,getChart:()=>chart,onAddIndicator:(name,label)=>{added=[name,label];}});
 await widgets.refresh();await wait();
 assert.equal(root.querySelector('#indicator').value,'ema');assert.equal(other.querySelector('#indicator-search-summary').textContent,'other-owner');
 const search=root.querySelector('#indicator-search');search.value='지수 이동평균';search.dispatch('input');assert.equal(root.querySelector('#indicator').value,'ema');
 root.querySelector('#add-indicator').click();await wait();assert.deepEqual(added,['ema','지수 이동평균']);
 const period=root.querySelector('#editor-param-period');assert.ok(period);assert.equal(period.value,'9');period.value='12';period.oninput();root.querySelector('#editor-apply-params').click();await wait();await wait();
 assert.ok(rust.calls.some(call=>call[0]==='params'&&call[1]==='extra-1'&&call[2].period===12));
 const output=root.querySelector('#editor-output');assert.equal(output.value,'extra-1-value');root.querySelector('#editor-width').value='3';root.querySelector('#editor-width').oninput();root.querySelector('#editor-apply-style').click();await wait();await wait();
 assert.ok(rust.calls.some(call=>call[1]==='setSeries'&&call[2][0]==='extra-1-value'&&call[2][1].width===3));
 assert.match(root.querySelector('#chart-readout').textContent,/Rust 십자선.*종가 2\.00 USD.*My EMA/);assert.match(root.querySelector('#chart-readout').getAttribute('aria-label'),/time 100/);assert.doesNotMatch(root.querySelector('#chart-readout').textContent,/시각 100/);
 widgets.dispose();assert.equal(widgets.disposed,true);
});

test('drawing manager sends supported batch commands and preserves external busy state',async()=>{
 const document=new Document(),root=host(document,'active'),rust=rustSession(),widgets=createRustDemoWidgets({root,getSession:()=>rust,getChart:()=>({canvas:document.createElement('canvas'),lastScene:{width:800}})});
 await widgets.refresh();await wait();const drawing=root.querySelector('#drawing-controls'),check=drawing.querySelector('input');check.checked=true;check.onchange();
 const action=name=>drawing.querySelectorAll('button').find(node=>node.dataset.action===name);
 action('setDrawingsVisibility').click();await wait();await wait();assert.ok(rust.calls.some(call=>call[1]==='setDrawingsVisibility'&&call[2][0][0]==='d1'&&call[2][1]===false));
 const check2=root.querySelector('#drawing-controls').querySelector('input');check2.checked=true;check2.onchange();const duplicate=root.querySelector('#drawing-controls').querySelectorAll('button').find(node=>node.dataset.action==='duplicateDrawings');
 widgets.setBusy(true);assert.equal(duplicate.disabled,true);duplicate.click();await wait();assert.equal(rust.calls.some(call=>call[1]==='duplicateDrawings'),false);
 widgets.setBusy(false);const check3=root.querySelector('#drawing-controls').querySelector('input');check3.checked=true;check3.onchange();root.querySelector('#drawing-controls').querySelectorAll('button').find(node=>node.dataset.action==='duplicateDrawings').click();await wait();await wait();
 assert.ok(rust.calls.some(call=>call[1]==='duplicateDrawings'&&call[2][1].deltaTimeMs===0));widgets.dispose();
});

test('drawing manager paginates 32 rows, keeps off-page selection, validates style and duplicate fields',async()=>{
 const document=new Document(),root=host(document,'active'),rust=rustSession();rust.drawings.items=Array.from({length:40},(_,index)=>({id:`d${index+1}`,type:'rectangle',panel:'price',visible:true,locked:false,points:[{time:index,price:index}]}));
 const widgets=createRustDemoWidgets({root,getSession:()=>rust,getChart:()=>({canvas:document.createElement('canvas'),lastScene:{width:800}})});await widgets.refresh();
 const panel=()=>root.querySelector('#drawing-controls'),action=name=>panel().querySelectorAll('button').find(node=>node.dataset.action===name),row=id=>panel().walk().find(node=>node.dataset?.drawingId===id&&node.tagName==='LI');
 assert.equal(panel().querySelectorAll('input').filter(node=>node.type==='checkbox'&&!node.dataset.enableField).length,32);
 let first=row('d1').querySelector('input');first.checked=true;first.onchange();action('next-page').click();let offpage=row('d33').querySelector('input');offpage.checked=true;offpage.onchange();assert.match(panel().walk().find(node=>node.dataset?.role==='drawing-count').textContent,/2개 선택/);
 action('clear-selection').click();action('previous-page').click();assert.equal(row('d1').querySelector('input').checked,false);
 first=row('d1').querySelector('input');first.checked=true;first.onchange();const fill=panel().walk().find(node=>node.dataset?.enableField==='fill'),font=panel().walk().find(node=>node.dataset?.enableField==='font');fill.checked=true;font.checked=true;panel().walk().find(node=>node.dataset?.field==='fill').value='#11223344';panel().walk().find(node=>node.dataset?.field==='font').value='13px monospace';action('setDrawingsStyle').click();await wait();await wait();assert.deepEqual(rust.drawings.items[0].style,{fill:'#11223344',font:'13px monospace'});
 const current=rust.drawings.items.length;const selected=panel().querySelector('input');selected.checked=true;selected.onchange();panel().walk().find(node=>node.dataset?.field==='deltaTimeMs').value='60000';panel().walk().find(node=>node.dataset?.field==='deltaPrice').value='2.5';action('duplicateDrawings').click();await wait();await wait();const copy=rust.drawings.items.find(item=>item.id==='copy-d1');assert.equal(rust.drawings.items.length,current+1);assert.deepEqual(copy.points,[{time:60000,price:2.5}]);
 const before=rust.calls.filter(call=>call[1]==='duplicateDrawings').length,selectedAgain=panel().querySelector('input');selectedAgain.checked=true;selectedAgain.onchange();panel().walk().find(node=>node.dataset?.field==='deltaTimeMs').value='not-a-number';action('duplicateDrawings').click();await wait();assert.equal(rust.calls.filter(call=>call[1]==='duplicateDrawings').length,before);assert.match(panel().walk().find(node=>node.dataset?.role==='drawing-status').textContent,/유한한 숫자/);
 widgets.dispose();
});

test('per-row visibility uses the single-row command and owner swap refreshes the new source',async()=>{
 const document=new Document(),root=host(document,'active'),first=rustSession(),second=rustSession(),chart={canvas:document.createElement('canvas'),lastScene:{width:800}};let current=first,release;
 const original=first.command.bind(first);first.command=async(name,args)=>{if(name==='setDrawingVisibility')await new Promise(resolve=>{release=resolve;});return original(name,args);};
 const widgets=createRustDemoWidgets({root,getSession:()=>current,getChart:()=>chart});await widgets.refresh();const toggle=root.querySelector('#drawing-controls').querySelectorAll('button').find(node=>node.dataset.action==='row-visibility');toggle.click();while(!release)await wait();current=second;release();await wait();await wait();
 assert.ok(first.calls.some(call=>call[1]==='setDrawingVisibility'));assert.ok(second.calls.some(call=>call[0]==='query'&&call[1]==='web.configuration'));assert.match(root.querySelector('#drawing-controls').walk().find(node=>node.dataset?.role==='drawing-status').textContent,/owner changed/);widgets.dispose();
});

test('delayed style and params fence stale-owner callbacks while retaining the old primary error',async()=>{
 const document=new Document(),root=host(document,'active'),old=rustSession(),replacement=rustSession();let current=old,callbacks=0,styleResolve,paramReject;const errors=[];
 const command=old.command.bind(old);old.command=async(name,args)=>name==='setSeries'?new Promise(resolve=>{styleResolve=()=>resolve({changed:true});}):command(name,args);old.setIndicatorParams=()=>new Promise((_resolve,reject)=>{paramReject=reject;});
 const widgets=createRustDemoWidgets({root,getSession:()=>current,getChart:()=>({canvas:document.createElement('canvas'),lastScene:{width:800}}),onMutation:()=>{callbacks++;},onError:error=>errors.push(error.message)});await widgets.refresh();
 root.querySelector('#editor-width').value='4';root.querySelector('#editor-width').oninput();root.querySelector('#editor-apply-style').click();while(!styleResolve)await wait();current=replacement;await widgets.refresh();styleResolve();for(let i=0;i<4;i++)await wait();
 assert.equal(callbacks,0);assert.ok(errors.some(message=>/owner changed/.test(message)));assert.ok(replacement.calls.some(call=>call[0]==='query'&&call[1]==='web.configuration'));
 current=old;await widgets.refresh();const period=root.querySelector('#editor-param-period');period.value='13';period.oninput();root.querySelector('#editor-apply-params').click();while(!paramReject)await wait();current=replacement;await widgets.refresh();paramReject(new Error('old-primary'));for(let i=0;i<4;i++)await wait();
 assert.equal(callbacks,0);assert.match(root.querySelector('#indicator-search-summary').textContent,/old-primary/);assert.ok(replacement.calls.filter(call=>call[0]==='query'&&call[1]==='web.configuration').length>=2);widgets.dispose();
});

test('indicator removal deletes every bound series first and refreshes after partial failure',async()=>{
 const document=new Document(),root=host(document,'active'),rust=rustSession();rust.configuration.indicators.push({id:'kept',name:'ema',params:{period:20},outputs:['value'],plotOffsets:{value:0}});rust.configuration.series.push({id:'kept-value',indicator:'kept',output:'value',panel:'price',type:'line'});
 const widgets=createRustDemoWidgets({root,getSession:()=>rust,getChart:()=>({canvas:document.createElement('canvas'),lastScene:{width:800}})});await widgets.refresh();await wait();root.querySelector('#editor-remove').click();await wait();await wait();
 const mutations=rust.calls.filter(call=>call[0]==='command'&&['removeSeries','removeIndicator'].includes(call[1]));assert.deepEqual(mutations.map(call=>[call[1],call[2][0]]),[['removeSeries','extra-1-value'],['removeIndicator','extra-1']]);
 assert.deepEqual(rust.configuration.indicators.map(row=>row.id),['kept']);assert.deepEqual(rust.configuration.series.map(row=>row.id),['kept-value']);assert.equal(rust.drawings.items[0].id,'d1');widgets.dispose();

 const root2=host(document,'partial'),failed=rustSession(),original=failed.command.bind(failed);failed.command=async(name,args)=>{if(name==='removeIndicator'){failed.calls.push(['command',name,structuredClone(args)]);throw new Error('injected remove failure');}return original(name,args);};
 const partial=createRustDemoWidgets({root:root2,getSession:()=>failed,getChart:()=>({canvas:document.createElement('canvas'),lastScene:{width:800}})});await partial.refresh();root2.querySelector('#editor-remove').click();await wait();await wait();
 assert.equal(failed.configuration.series.length,0);assert.equal(failed.configuration.indicators[0].id,'extra-1');assert.equal(root2.querySelector('#editor-indicator').value,'extra-1');assert.ok(failed.calls.filter(call=>call[0]==='query'&&call[1]==='web.configuration').length>=2);partial.dispose();
});

test('keyboard exploration navigates without reads and Enter uses the exact dataAt contract',async()=>{
 const document=new Document(),root=host(document,'active'),rust=rustSession(),canvas=document.createElement('canvas'),widgets=createRustDemoWidgets({root,getSession:()=>rust,getChart:()=>({canvas,lastScene:{width:800}})});
 await widgets.refresh();await wait();rust.calls.length=0;root.querySelector('#explore').click();
 canvas.dispatch('keydown',{key:'Home'});canvas.dispatch('keydown',{key:'ArrowRight'});assert.equal(rust.calls.some(call=>call[1]==='dataAt'),false);
 const event=canvas.dispatch('keydown',{key:'Enter'});assert.equal(event.defaultPrevented,true);await wait();await wait();
 const read=rust.calls.find(call=>call[1]==='dataAt');assert.deepEqual(read[2],[{index:1},{indicatorMode:'cached'}]);assert.match(root.querySelector('#explorer-readout').textContent,/키보드 선택.*봉 2/);
 canvas.dispatch('keydown',{key:'Escape'});assert.equal(root.querySelector('#explore').getAttribute('aria-pressed'),'false');widgets.dispose();
});

test('refresh ownership is last-writer-wins and dispose removes listeners',async()=>{
 const document=new Document(),root=host(document,'active'),rust=rustSession();let resolveFirst;
 const original=rust.query.bind(rust);let held=true;rust.query=name=>name==='web.configuration'&&held?(held=false,new Promise(resolve=>{resolveFirst=resolve;})):original(name);
 const widgets=createRustDemoWidgets({root,getSession:()=>rust,getChart:()=>({canvas:document.createElement('canvas')})});
 const first=widgets.refresh(),second=widgets.refresh({configuration:{axisWidth:85,indicators:[],series:[]},drawings:{items:[]},state:rust.state});await second;resolveFirst(structuredClone(rust.configuration));await first;
 assert.equal(root.querySelector('#editor-indicator')?.children.length??0,0);widgets.dispose();const before=rust.calls.length;root.querySelector('#explore').click();await wait();assert.equal(rust.calls.length,before);
});

test('constructor rejects missing ownership callbacks',()=>{const document=new Document(),root=host(document,'active');assert.throws(()=>createRustDemoWidgets({root,getSession:null,getChart:()=>({})}),/session getter/i);});
