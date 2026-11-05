import assert from 'node:assert/strict';
import test from 'node:test';
import {mountRustDemo} from '../examples/web/rust-demo.mjs';
import {fixture,event} from './helpers/customization-dom.mjs';
import {BarStore,ChartModel,ChartAPI,DEMO_SYMBOLS} from '../src/core/index.mjs';
import {saveDemoAnalysis} from '../examples/web/analysis-session.mjs';
import {RUST_LAYOUT_STORAGE_KEY,stringifyRustLayoutMemory,parseRustLayoutMemory} from '../examples/web/rust-layout-codec.mjs';

const IDS=[
 'chart','chart-row','workspace','market','count','cancel-compute','status','symbol','meta','stats','fit','recent','stream','theme',
 'renderer','series','scale','crosshair-snap','magnet','annotation','undo','redo','lock','delete','save','load','file',
 'selection','last-time','last-open','last-high','last-low','last-close','last-volume','drawing-manager-controls',
 'layout-indicator','layout-panel','layout-axis','apply-indicator-placement','separate-indicator-panel','reorder-panel',
 'panel-up','panel-down','layout-undo','layout-redo','layout-history-summary','indicator-layout-status',
 'save-chart-layout','load-chart-layout','chart-layout-file','remember-chart-layout','forget-chart-layout','chart-layout-status',
 'save-analysis','load-analysis','analysis-file','analysis-status','open-drawing-manager','drawing-manager',
];

function columns(count){return Object.fromEntries(['time','open','high','low','close','volume'].map((field,slot)=>[field,Float64Array.from({length:count},(_,index)=>field==='time'?1700000000000+index*60000:slot+index/10)]));}
function analysisText(t){
 const length=10000,store=new BarStore(),values={time:Float64Array.from({length},(_,index)=>1700000000000+index*60000),open:new Float64Array(length).fill(10),high:new Float64Array(length).fill(12),low:new Float64Array(length).fill(9),close:new Float64Array(length).fill(11),volume:new Float64Array(length).fill(100)};store.setColumns(values);const model=new ChartModel({store,panels:[{id:'price',weight:3.5},{id:'volume',weight:.8},{id:'rsi',weight:1,range:[0,100]}]}),api=new ChartAPI(model);t.after(()=>model.dispose());api.setSymbol(DEMO_SYMBOLS.us);api.addIndicator('ema','ema',{});api.addIndicator('bb','bollinger',{});api.addIndicator('rsi','rsi',{});model.addSeries({id:'price',type:'candles',panel:'price'});model.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume'});model.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema'});model.addSeries({id:'upper',type:'line',panel:'price',indicator:'bb',output:'upper'});model.addSeries({id:'lower',type:'line',panel:'price',indicator:'bb',output:'lower'});model.addSeries({id:'rsi',type:'line',panel:'rsi',indicator:'rsi'});return saveDemoAnalysis(api,{market:'us',count:10000,light:false});
}
function baseConfiguration(){return {schema:'aster.web-wasm.configuration',version:1,panels:[{id:'price',label:'PRICE',weight:3.5,scale:'linear'},{id:'volume',label:'VOLUME',weight:.8,scale:'linear'},{id:'rsi',label:'RSI',weight:1,scale:'linear'}],axes:[],series:[{id:'price',label:'가격',type:'candles',panel:'price',color:'#58cadbff'},{id:'volume',label:'거래량',type:'histogram',source:'volume',panel:'volume'},{id:'ema',label:'EMA',type:'line',panel:'price',indicator:'ema',color:'#f0b755ff'},{id:'upper',label:'BB upper',type:'line',panel:'price',indicator:'bb',output:'upper',color:'#63779eff'},{id:'lower',label:'BB lower',type:'line',panel:'price',indicator:'bb',output:'lower',color:'#63779eff'},{id:'rsi',label:'RSI',type:'line',panel:'rsi',indicator:'rsi',color:'#aa91f7ff'}],indicators:[{id:'ema',name:'ema',params:{},outputs:['value'],plotOffsets:{}},{id:'bb',name:'bollinger',params:{},outputs:['middle','upper','lower'],plotOffsets:{}},{id:'rsi',name:'rsi',params:{},outputs:['value'],plotOffsets:{}}],symbol:{id:'SYNTH:US',currency:'USD',timezone:'America/New_York',volumeUnit:'shares'},theme:{},axisWidth:85,precision:2};}
function baseTarget(configuration){return {panels:structuredClone(configuration.panels),axes:[],series:structuredClone(configuration.series),placements:configuration.series.filter(series=>series.indicator).map(series=>({seriesId:series.id,indicatorId:series.indicator,panelId:series.panel,axisId:series.axisId??null})),panelOrder:configuration.panels.map(panel=>panel.id),generatedPanels:[{id:'rsi',options:{label:'RSI',weight:1,scale:'linear'}}],generatedAxes:[]};}

class FakeSession{
 constructor(id,source=null){this.id=id;this.generation=`g-${id}`;this.closed=false;this.calls=[];this.listeners=new Set();this.lastOutcome=null;this.outcome=0;this.configuration=source?structuredClone(source.configuration):baseConfiguration();this.drawings=source?structuredClone(source.drawings):{schema:'aster.web-wasm.drawings',version:1,items:[],selected:null,canUndo:false,canRedo:false,undoCount:0,redoCount:0,serial:0,transaction:false};this.state=source?structuredClone(source.state):{schema:'aster.web-wasm.presentation',version:1,generation:this.generation,revision:0,data:{length:0,version:1,timeVersion:1,capacity:16},view:{from:-.5,to:199.5,follow:true},configuration:{panels:3,axes:0,series:6,indicators:3},drawings:{count:0,selected:null,canUndo:false,canRedo:false,transaction:false,serial:0},interaction:{tool:'select',text:'',gestureKind:null,pointerCount:0,crosshair:null,crosshairSnap:{mode:'free'},drawingMagnet:{mode:'off'},drawingTarget:null}};this.state.generation=this.generation;this.target=source?structuredClone(source.target):baseTarget(this.configuration);this.applied=[];}
 snapshot(){return structuredClone(this.state);}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 emit(){for(const listener of this.listeners)listener(this.snapshot());}
 async resync(){this.emit();return this.snapshot();}
 async prepareData(input,{signal}={}){this.calls.push(['prepareData',input.kind]);const gate=this.prepareGate;this.prepareGate=null;if(gate)await gate;if(signal?.aborted)throw new DOMException('aborted','AbortError');this.state.data.length=input.columns.time.length;this.state.data.version++;this.emit();return{status:'committed'};}
 async query(name){
  if(name==='web.configuration')return structuredClone(this.configuration);
  if(name==='web.drawingsState')return structuredClone(this.drawings);
  if(name==='web.indicatorCatalog')return{schema:'aster.web-wasm.indicator-catalog',version:1,entries:[{name:'ema',params:['period'],outputs:['value']},{name:'rsi',params:['period'],outputs:['value']}]};
  if(name==='web.layoutCapture')return{schema:'aster.web-wasm.layout-frame',version:1,source:structuredClone(this.target),target:structuredClone(this.target)};
  if(name==='web.layoutReferences')return{schema:'aster.web-wasm.layout-references',version:1,panels:[],axes:[]};
  throw new Error(name);
 }
 async command(name,args=[]){
  this.calls.push([name,structuredClone(args)]);
  if(name==='dataAt'){const index=args[0].index;return{index,time:1700000000000+index*60000,primary:{bar:{time:1700000000000+index*60000,open:1,high:3,low:0,close:2,volume:4}},series:[]};}
  this.lastOutcome={id:++this.outcome,operation:'nativeCommand'};
  if(name==='setSymbol'){this.configuration.symbol=structuredClone(args[0]);this.configuration.precision=args[0].priceDecimals;}
  else if(name==='setSeries'){const patch=structuredClone(args[1]),configurationSeries=this.configuration.series.find(row=>row.id===args[0]);if(/^#[0-9a-f]{6}$/i.test(patch.color??''))patch.color+='ff';Object.assign(configurationSeries,patch);if(patch.axisId===null)delete configurationSeries.axisId;Object.assign(this.target.series.find(row=>row.id===args[0]),patch);}
  else if(name==='setPanel'){Object.assign(this.configuration.panels.find(row=>row.id===args[0]),args[1]);Object.assign(this.target.panels.find(row=>row.id===args[0]),args[1]);}
  else if(name==='setAxis'){Object.assign(this.configuration.axes.find(row=>row.id===args[0]),args[1]);Object.assign(this.target.axes.find(row=>row.id===args[0]),args[1]);}
  else if(name==='setPanelOrder'){this.configuration.panels=args[0].map(id=>this.configuration.panels.find(row=>row.id===id));this.target.panelOrder=[...args[0]];this.target.panels=args[0].map(id=>this.target.panels.find(row=>row.id===id));}
  else if(name==='setTheme')this.configuration.theme=structuredClone(args[0]);
  else if(name==='setVisibleRange')this.state.view={from:args[0],to:args[1],follow:false};
  else if(name==='fit')this.state.view={from:-.5,to:this.state.data.length-.5,follow:false};
  else if(name==='setCrosshairSnap')this.state.interaction.crosshairSnap=structuredClone(args[0]);
  else if(name==='setDrawingMagnet')this.state.interaction.drawingMagnet=structuredClone(args[0]);
  else if(name==='setDrawingTarget')this.state.interaction.drawingTarget=structuredClone(args[0]);
  else if(name==='setTool')this.state.interaction.tool=args[0];
  else if(name==='setText')this.state.interaction.text=args[0];
  else if(name==='addIndicator'){const existing=this.configuration.indicators.find(row=>row.id===args[0]),next={id:args[0],name:args[1],params:structuredClone(args[2]),outputs:['value'],plotOffsets:{}};if(existing)Object.assign(existing,next);else this.configuration.indicators.push(next);}
  else if(name==='removeIndicator')this.configuration.indicators=this.configuration.indicators.filter(row=>row.id!==args[0]);
  else if(name==='addSeries'){const existing=this.configuration.series.find(row=>row.id===args[0].id);if(existing)Object.assign(existing,structuredClone(args[0]));else{this.configuration.series.push(structuredClone(args[0]));this.target.series.push(structuredClone(args[0]));if(args[0].indicator)this.target.placements.push({seriesId:args[0].id,indicatorId:args[0].indicator,panelId:args[0].panel,axisId:args[0].axisId??null});}}
  else if(name==='removeSeries'){this.configuration.series=this.configuration.series.filter(row=>row.id!==args[0]);this.target.series=this.target.series.filter(row=>row.id!==args[0]);this.target.placements=this.target.placements.filter(row=>row.seriesId!==args[0]);}
  else if(name==='addPanel'){this.configuration.panels.push(structuredClone(args[0]));this.target.panels.push(structuredClone(args[0]));this.target.panelOrder.push(args[0].id);}
  else if(name==='removePanel'){this.configuration.panels=this.configuration.panels.filter(row=>row.id!==args[0]);this.target.panels=this.target.panels.filter(row=>row.id!==args[0]);this.target.panelOrder=this.target.panelOrder.filter(id=>id!==args[0]);}
  else if(name==='addAxis'){this.configuration.axes.push(structuredClone(args[0]));this.target.axes.push(structuredClone(args[0]));}
  else if(name==='removeAxis'){this.configuration.axes=this.configuration.axes.filter(row=>row.id!==args[0]);this.target.axes=this.target.axes.filter(row=>row.id!==args[0]);}
  else if(name==='loadDrawings'){this.drawings={...this.drawings,items:[{id:'loaded',type:'horizontal',panel:'price',points:[{time:1,price:2}]}],canUndo:true,undoCount:1};this.state.drawings={...this.state.drawings,count:1,canUndo:true};}
  else if(name==='applyDataEvent'&&args[0]?.kind==='append'){this.state.data.length++;this.state.data.version++;}
  this.state.revision++;this.emit();return null;
 }
 async setIndicatorParams(id,params){if(params.period===0)throw new RangeError('invalid period');this.configuration.indicators.find(row=>row.id===id).params=structuredClone(params);return{status:'committed'};}
 async applyLayoutFrame(frame){if(this.failLayout)throw new Error('candidate layout rejected');this.applied.push(structuredClone(frame.target));this.target=structuredClone(frame.target);this.configuration.panels=structuredClone(frame.target.panels);this.configuration.axes=structuredClone(frame.target.axes);this.configuration.series=structuredClone(frame.target.series).map(row=>{if(row.axisId===null)delete row.axisId;return row;});this.emit();}
 async exportColumns(){return{columns:columns(this.state.data.length),length:this.state.data.length,version:this.state.data.version,generation:this.generation};}
 async saveWorkspace(){return'{"schema":"aster.workspace","version":1}';}
 async withMigrationCapture(_binding,{consume,activate}){const capture={metadataJSON:JSON.stringify({fakeSession:this.id}),header:'{}',description:{},uiChunks:[],length:this.state.data.length,columns:columns(this.state.data.length)},value=await consume(capture);let handed=false;const activation=await activate({capture,value,handoff(){handed=true;}});assert.equal(handed,true);return{value,activation};}
 async close(){this.closed=true;}
}

function setup(t,{loadData}={}){
 const env=fixture(t),root=env.node('main'),nodes=new Map(),tools=[];env.document.defaultView=env.window;env.document.documentElement=env.node('html');env.document.hidden=false;
 env.window.setTimeout=setTimeout;env.window.clearTimeout=clearTimeout;env.window.setInterval=setInterval;env.window.clearInterval=clearInterval;const storage=new Map();env.window.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 for(const id of IDS){const node=env.document.createElement(id.includes('file')?'input':id==='market'||id==='count'||['renderer','series','scale','crosshair-snap','magnet','layout-indicator','layout-panel','layout-axis','reorder-panel'].includes(id)?'select':'button');node.setAttribute('id',id);root.append(node);nodes.set(id,node);}
 Object.assign(nodes.get('market'),{value:'us'});Object.assign(nodes.get('count'),{value:'10000'});Object.assign(nodes.get('renderer'),{value:'canvas'});Object.assign(nodes.get('series'),{value:'candles'});Object.assign(nodes.get('scale'),{value:'linear'});Object.assign(nodes.get('crosshair-snap'),{value:'free'});Object.assign(nodes.get('magnet'),{value:'off'});Object.assign(nodes.get('annotation'),{value:'관찰 메모'});
 for(const name of ['select','trendline','horizontal']){const node=env.document.createElement('button');node.dataset.tool=name;root.append(node);tools.push(node);}
 root.querySelector=selector=>selector.startsWith('#')?nodes.get(selector.slice(1))??null:null;root.querySelectorAll=selector=>selector==='[data-tool]'?tools:[];
 const sessions=[],backend={async createSession(){const session=new FakeSession(sessions.length+1);sessions.push(session);return session;},async createSessionFromMigration(capture={}){let source=sessions.at(-1);try{const id=JSON.parse(capture.metadataJSON).fakeSession;source=sessions.find(item=>item.id===id)??source;}catch{}const session=new FakeSession(sessions.length+1,source);session.failLayout=backend.failNextLayout;backend.failNextLayout=false;sessions.push(session);return session;},async createSessionFromWorkspace({signal}={}){const source=sessions.at(-1),candidate=new FakeSession(sessions.length+1,source);sessions.push(candidate);backend.workspaceStarted=(backend.workspaceStarted??0)+1;if(backend.workspaceGate)await backend.workspaceGate;if(signal?.aborted){await candidate.close();throw new DOMException('aborted','AbortError');}return candidate;}};
 const charts=[];const chartFactory=async(container,session,{renderer='canvas'}={})=>{const canvas=env.document.createElement('canvas');container.append(canvas);const chart={container,session,canvas,rendererKind:renderer,disposed:false,lastScene:{width:800,height:500,stats:{storedBars:session.state.data.length,visibleSourceBars:200,renderedCandleBuckets:200}},renderMetrics:{elapsedMs:1},async flush(){},async replaceRenderer(kind){this.rendererKind=kind;},async setTool(tool){session.state.interaction.tool=tool;session.emit();},resize(){},invalidate(){},async destroy(){this.disposed=true;canvas.remove();}};charts.push(chart);return chart;};
 const widgetCalls=[];let widgetOptions;const widgetsFactory=options=>{widgetOptions=options;return{async refresh(value){widgetCalls.push(value);},setBusy(){},dispose(){}};};
 return{...env,root,nodes,tools,backend,sessions,charts,storage,widgetCalls,get widgetOptions(){return widgetOptions;},chartFactory,widgetsFactory,loadData:loadData??(async({count})=>columns(count))};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(predicate,label){for(let index=0;index<100;index++){if(await predicate())return;await tick();}throw new Error(`Timeout: ${label}`);}
function delayedFile(text,{size=new TextEncoder().encode(text).length}={}){let release,reject,reads=0;const pending=new Promise((resolve,no)=>{release=()=>resolve(text);reject=no;});return{file:{size,text(){reads++;return pending;}},release,reject,get reads(){return reads;}};}
function selectFile(node,file){Object.defineProperty(node,'files',{configurable:true,value:[file]});event(node,'change');}
function layoutFile(session,period){
 const layout={panels:structuredClone(session.configuration.panels),axes:structuredClone(session.configuration.axes),series:structuredClone(session.configuration.series).map(row=>{if(row.axisId===null)delete row.axisId;return row;}),indicators:[]},id='extra-file',seriesId='extra-file-value';
 if(!layout.series.some(row=>row.id===seriesId))layout.series.push({id:seriesId,label:'FILE EMA',type:'line',panel:'price',indicator:id,output:'value'});
 const indicators=[...session.configuration.indicators.filter(row=>row.id!==id).map(row=>({id:row.id,name:row.name,params:structuredClone(row.params)})),{id,name:'ema',params:{period}}];
 layout.indicators=indicators;const text=JSON.stringify({schema:'barochart.main-demo-layout',version:1,market:'us',count:10000,light:false,managed:{panels:session.target.generatedPanels.map(row=>row.id),axes:session.target.generatedAxes.map(row=>row.id)},layout});
 return{size:new TextEncoder().encode(text).length,text:async()=>text};
}
function rememberedPreset({market='kr',light=true}={}){const configuration=baseConfiguration();return{schema:'barochart.main-demo-layout',version:1,market,count:10000,light,managed:{panels:['rsi'],axes:[]},layout:{panels:structuredClone(configuration.panels),axes:[],series:structuredClone(configuration.series),indicators:configuration.indicators.map(row=>({id:row.id,name:row.name,params:structuredClone(row.params)}))}};}

test('Rust demo prepares a Worker session, publishes the staged chart and drives main controls',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory});
 assert.equal(controller.backend,'rust-wasm');assert.equal(controller.session,f.sessions[0]);assert.equal(f.sessions[0].state.data.length,10000);assert.equal(f.nodes.get('chart').children.length,1);assert.equal(f.window.aster.session,controller.session);assert.ok(f.widgetCalls.length);assert.equal(controller.session.state.interaction.text,'관찰 메모');assert.equal(f.nodes.get('last-close').textContent,'2.00');assert.equal(f.nodes.get('chart-row').style.height,'515px');assert.doesNotMatch(f.nodes.get('last-time').textContent,/T.*Z$/);
 event(f.nodes.get('fit'),'click');await tick();assert.ok(f.sessions[0].calls.some(([name])=>name==='fit'));
 f.nodes.get('series').value='line';event(f.nodes.get('series'),'change');await tick();assert.equal(f.sessions[0].configuration.series.find(row=>row.id==='price').type,'line');
 event(f.tools[1],'click');await tick();assert.equal(f.sessions[0].state.interaction.tool,'trendline');assert.equal(f.tools[1].getAttribute('aria-pressed'),'true');
 controller.pause();assert.equal(f.nodes.get('fit').disabled,true);controller.resume();assert.equal(f.nodes.get('fit').disabled,false);
 await controller.dispose();assert.equal(f.sessions[0].closed,true);assert.equal(f.window.aster,undefined);
});

test('external mount abort cancels initial loading and cleans the unaccepted controller',async t=>{
 let release;const f=setup(t,{loadData:({count})=>new Promise(resolve=>{release=()=>resolve(columns(count));})}),controller=new AbortController(),mount=mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,signal:controller.signal,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory});
 await tick();controller.abort();release();await assert.rejects(mount,error=>error.name==='AbortError');assert.equal(f.sessions.length,0);assert.equal(f.nodes.get('chart').children.length,0);assert.equal(f.window.aster,undefined);
});

test('input preferences changed during preparation survive commit and migrated empty text remains empty',async t=>{
 let release;const f=setup(t,{loadData:({count})=>new Promise(resolve=>{release=()=>resolve(columns(count));})}),mount=mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory});await tick();f.nodes.get('annotation').value='준비 중 메모';event(f.nodes.get('annotation'),'input');f.nodes.get('crosshair-snap').value='ohlc';event(f.nodes.get('crosshair-snap'),'change');f.nodes.get('magnet').value='strong';event(f.nodes.get('magnet'),'change');event(f.tools[1],'click');release();const controller=await mount;assert.equal(controller.session.state.interaction.text,'준비 중 메모');assert.equal(controller.session.state.interaction.tool,'trendline');assert.equal(controller.session.state.interaction.crosshairSnap.mode,'ohlc');assert.equal(controller.session.state.interaction.drawingMagnet.mode,'strong');await controller.dispose();
 const migrated=setup(t),source=new FakeSession(99);source.state.interaction.text='';const accepted=await mountRustDemo({root:migrated.root,backend:migrated.backend,initialSession:source,initialState:{market:'us',count:10000,light:false},loadData:migrated.loadData,chartFactory:migrated.chartFactory,widgetsFactory:migrated.widgetsFactory});assert.equal(accepted.session.state.interaction.text,'');await accepted.dispose();
});

test('stream intent starts only after staged controller publish',async t=>{
 const f=setup(t),source=new FakeSession(88),controller=await mountRustDemo({root:f.root,backend:f.backend,initialSession:source,initialState:{market:'us',count:10000,light:false,streamIntent:true},publish:false,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory});assert.notEqual(f.nodes.get('stream').getAttribute('aria-pressed'),'true');controller.publish();assert.equal(f.nodes.get('stream').getAttribute('aria-pressed'),'true');controller.pause();assert.equal(f.nodes.get('stream').getAttribute('aria-pressed'),'false');controller.resume();assert.equal(f.nodes.get('stream').getAttribute('aria-pressed'),'true');await controller.dispose();
});

test('shared layout memory drives automatic Rust startup and disabled policy stays disabled',async t=>{
 const remembered=setup(t);remembered.storage.set(RUST_LAYOUT_STORAGE_KEY,stringifyRustLayoutMemory({enabled:true,preset:rememberedPreset()}));const controller=await mountRustDemo({root:remembered.root,backend:remembered.backend,initialState:{market:'us',count:10000,light:false,preferencesChanged:false},loadData:remembered.loadData,chartFactory:remembered.chartFactory,widgetsFactory:remembered.widgetsFactory});assert.equal(controller.state.market,'kr');assert.equal(controller.state.light,true);assert.equal(remembered.nodes.get('remember-chart-layout').checked,true);await controller.dispose();
 const disabled=setup(t);const disabledText=stringifyRustLayoutMemory({enabled:false,preset:null});disabled.storage.set(RUST_LAYOUT_STORAGE_KEY,disabledText);const second=await mountRustDemo({root:disabled.root,backend:disabled.backend,initialState:{market:'us',count:10000,light:false,preferencesChanged:false},loadData:disabled.loadData,chartFactory:disabled.chartFactory,widgetsFactory:disabled.widgetsFactory});assert.equal(second.state.market,'us');assert.equal(disabled.nodes.get('remember-chart-layout').checked,false);await new Promise(resolve=>setTimeout(resolve,350));assert.deepEqual(parseRustLayoutMemory(disabled.storage.get(RUST_LAYOUT_STORAGE_KEY)),{enabled:false,preset:null});await second.dispose();
});

test('market reload keeps the installed owner until the new Worker and chart are ready',async t=>{
 let release;const f=setup(t,{loadData:({count,market})=>market==='us'?Promise.resolve(columns(count)):new Promise(resolve=>{release=()=>resolve(columns(count));})}),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),first=controller.session;
 f.nodes.get('market').value='kr';const pending=controller.load();await tick();assert.equal(controller.session,first);assert.equal(first.closed,false);release();await pending;assert.notEqual(controller.session,first);assert.equal(first.closed,true);assert.equal(controller.state.market,'kr');
 await controller.dispose();
});

test('same-market count reload uses the stable session and preserves configuration, UI and drawings',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),owner=controller.session;
 owner.configuration.indicators.push({id:'extra-9',name:'ema',params:{period:37},outputs:['value'],plotOffsets:{}});owner.configuration.series.push({id:'extra-9-value',label:'Custom',type:'line',panel:'price',indicator:'extra-9',output:'value',color:'#123456ff'});owner.drawings={...owner.drawings,items:[{id:'kept',type:'horizontal',panel:'price',points:[{time:1,price:2}]}],selected:'kept',canUndo:true,canRedo:true,undoCount:2,redoCount:1,serial:9};owner.state.drawings={...owner.state.drawings,count:1,selected:'kept',canUndo:true,canRedo:true,serial:9};owner.state.view={from:30,to:80,follow:false};owner.state.interaction={...owner.state.interaction,tool:'trendline',text:'keep'};await controller.refresh();
 f.nodes.get('layout-indicator').value='rsi';f.nodes.get('layout-panel').value='price';f.nodes.get('layout-axis').value='primary';event(f.nodes.get('separate-indicator-panel'),'click');await tick();await tick();assert.equal(controller.state.layoutHistory.cursor,1);
 const before={configuration:structuredClone(owner.configuration),drawings:structuredClone(owner.drawings),view:structuredClone(owner.state.view),interaction:structuredClone(owner.state.interaction)};f.nodes.get('count').value='100000';await controller.load();
 assert.equal(controller.session,owner);assert.equal(owner.state.data.length,100000);assert.deepEqual(owner.configuration,before.configuration);assert.deepEqual(owner.drawings,before.drawings);assert.deepEqual(owner.state.view,before.view);assert.deepEqual(owner.state.interaction,before.interaction);assert.equal(controller.state.layoutHistory.cursor,0);
 await controller.dispose();
});

test('latest same-market count waits for cancelled prepare instead of failing JOB_BUSY',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),owner=controller.session;let release;owner.prepareGate=new Promise(resolve=>{release=resolve;});const before=owner.calls.filter(([name])=>name==='prepareData').length;f.nodes.get('count').value='100000';const first=controller.load();await settle(()=>owner.calls.filter(([name])=>name==='prepareData').length===before+1,'first count prepare');f.nodes.get('count').value='10000';const second=controller.load();release();await Promise.all([first,second]);assert.equal(controller.session,owner);assert.equal(owner.state.data.length,10000);assert.equal(f.nodes.get('count').value,'10000');await controller.dispose();
});

test('market journal restores full drawing history and configuration without retaining old data arrays',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),us=controller.session;
 us.configuration.indicators.push({id:'extra-2',name:'ema',params:{period:21},outputs:['value'],plotOffsets:{}});us.configuration.series.push({id:'extra-2-value',label:'US custom',type:'line',panel:'price',indicator:'extra-2',output:'value',color:'#abcdef'});us.drawings={...us.drawings,items:[{id:'us-note',type:'text',panel:'price',points:[{time:1,price:2}]}],selected:'us-note',canUndo:true,canRedo:true,undoCount:3,redoCount:2,serial:17};us.state.drawings={...us.state.drawings,count:1,selected:'us-note',canUndo:true,canRedo:true,serial:17};us.state.interaction={...us.state.interaction,tool:'text',text:'US note'};await us.command('applyDataEvent',[{kind:'append',bar:{}}]);await controller.refresh();const expected={configuration:structuredClone(us.configuration),drawings:structuredClone(us.drawings),interaction:structuredClone(us.state.interaction)};
 f.nodes.get('market').value='kr';await controller.load();assert.equal(controller.state.market,'kr');assert.equal(us.closed,true);f.nodes.get('market').value='us';await controller.load();
 assert.equal(controller.state.market,'us');assert.equal(controller.session.state.data.length,10000);assert.deepEqual(controller.session.configuration,expected.configuration);assert.deepEqual(controller.session.drawings,expected.drawings);assert.deepEqual(controller.session.state.interaction,expected.interaction);
 await controller.dispose();
});

test('theme palette transforms known colors, preserves custom colors and defers while params are active',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),owner=controller.session;owner.configuration.series.find(row=>row.id==='price').type='line';owner.configuration.indicators.push({id:'extra-7',name:'ema',params:{period:7},outputs:['value'],plotOffsets:{}});owner.configuration.series.push({id:'extra-7-known',type:'line',panel:'price',indicator:'extra-7',output:'value',color:'#aa91f7ff'},{id:'custom',type:'line',panel:'price',color:'#123456ff'});await controller.refresh();
 event(f.nodes.get('theme'),'click');await settle(()=>owner.configuration.series.find(row=>row.id==='ema').color==='#946200ff','light palette');assert.equal(owner.configuration.series.find(row=>row.id==='price').color,'#285bb9ff');assert.equal(owner.configuration.series.find(row=>row.id==='extra-7-known').color,'#946200ff');assert.equal(owner.configuration.series.find(row=>row.id==='custom').color,'#123456ff');
 f.widgetOptions.onJob({kind:'params',active:true});event(f.nodes.get('theme'),'click');await tick();await tick();assert.equal(owner.configuration.series.find(row=>row.id==='ema').color,'#946200ff');f.widgetOptions.onJob({kind:'params',active:false});await settle(()=>owner.configuration.series.find(row=>row.id==='ema').color==='#f0b755ff','deferred dark palette');assert.equal(owner.configuration.series.find(row=>row.id==='custom').color,'#123456ff');
 await controller.dispose();
});

test('layout mutations use the atomic Rust frame and retain bounded undo history',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),session=controller.session;
 f.nodes.get('layout-indicator').value='rsi';f.nodes.get('layout-panel').value='price';f.nodes.get('layout-axis').value='primary';event(f.nodes.get('separate-indicator-panel'),'click');await tick();await tick();assert.equal(session.applied.length,1);assert.ok(session.configuration.panels.some(row=>row.id.startsWith('rsi-panel')));assert.equal(f.nodes.get('layout-undo').disabled,false);
 event(f.nodes.get('layout-undo'),'click');await tick();await tick();assert.equal(session.applied.length,2);assert.deepEqual(session.configuration.panels.map(row=>row.id),['price','volume','rsi']);
 await controller.dispose();
});

test('indicator placement honors explicit primary, defaults moved panels to projected axes, and separates on primary',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),session=controller.session,rsiPanel=session.configuration.panels.find(row=>row.id==='rsi'),projection={scale:'percent',inverted:true,padding:.2,range:[0,100],precision:1};Object.assign(rsiPanel,projection);Object.assign(session.target.panels.find(row=>row.id==='rsi'),projection);Object.assign(session.target.generatedPanels.find(row=>row.id==='rsi').options,projection);await controller.refresh();
 f.nodes.get('layout-indicator').value='rsi';event(f.nodes.get('layout-indicator'),'change');f.nodes.get('layout-panel').value='price';event(f.nodes.get('layout-panel'),'change');f.nodes.get('layout-axis').value='primary';event(f.nodes.get('layout-axis'),'change');event(f.nodes.get('apply-indicator-placement'),'click');await settle(()=>session.configuration.series.find(row=>row.id==='rsi').panel==='price','explicit primary placement');assert.equal(session.configuration.series.find(row=>row.id==='rsi').axisId??null,null);
 await settle(()=>!f.nodes.get('layout-undo').disabled,'layout undo ready');event(f.nodes.get('layout-undo'),'click');await settle(()=>session.configuration.series.find(row=>row.id==='rsi').panel==='rsi','placement undo');f.nodes.get('layout-panel').value='price';event(f.nodes.get('layout-panel'),'change');assert.equal(f.nodes.get('layout-axis').value,'independent');event(f.nodes.get('apply-indicator-placement'),'click');await tick();await tick();const moved=session.configuration.series.find(row=>row.id==='rsi'),axis=session.configuration.axes.find(row=>row.id===moved.axisId);assert.ok(axis);assert.equal(axis.scale,'percent');assert.equal(axis.base,2);assert.equal(axis.inverted,true);assert.equal(axis.padding,.2);
 event(f.nodes.get('layout-undo'),'click');await tick();await tick();f.nodes.get('layout-axis').value='independent';event(f.nodes.get('layout-axis'),'change');event(f.nodes.get('separate-indicator-panel'),'click');await tick();await tick();const separated=session.configuration.series.find(row=>row.id==='rsi'),panel=session.configuration.panels.find(row=>row.id===separated.panel);assert.equal(separated.axisId??null,null);assert.equal(panel.scale,'percent');assert.equal(panel.base,undefined);assert.equal(panel.inverted,true);
 await controller.dispose();
});

test('extra indicator allocator uses the resource union and Korean label',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),owner=controller.session;owner.configuration.panels.push({id:'extra-1',label:'retained',weight:1,scale:'linear'});owner.target.panels.push({id:'extra-1',label:'retained',weight:1,scale:'linear'});owner.target.panelOrder.push('extra-1');await controller.refresh();const id=await f.widgetOptions.onAddIndicator('ema','지수 이동평균');assert.equal(id,'extra-2');const current=controller.session.configuration;assert.ok(current.indicators.some(row=>row.id==='extra-2'));assert.equal(current.series.find(row=>row.indicator==='extra-2').label,'지수 이동평균');await controller.dispose();
});

test('series type preserves the layout branch, scale rebases it, and an awaited layout blocks switching',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),session=controller.session;
 f.nodes.get('layout-indicator').value='rsi';f.nodes.get('layout-panel').value='price';f.nodes.get('layout-axis').value='primary';event(f.nodes.get('separate-indicator-panel'),'click');await tick();await tick();assert.equal(controller.state.layoutHistory.cursor,1);
 event(f.nodes.get('layout-undo'),'click');await tick();await tick();assert.equal(controller.state.layoutHistory.cursor,0);assert.equal(controller.state.layoutHistory.commands.length,1);
 f.nodes.get('series').value='line';event(f.nodes.get('series'),'change');await tick();await tick();assert.equal(controller.state.layoutHistory.cursor,0);assert.equal(controller.state.layoutHistory.commands.length,1);
 f.nodes.get('scale').value='log';event(f.nodes.get('scale'),'change');await tick();await tick();assert.equal(controller.state.layoutHistory.cursor,0);assert.equal(controller.state.layoutHistory.commands.length,0);
 const apply=session.applyLayoutFrame.bind(session);let release;session.applyLayoutFrame=frame=>new Promise(resolve=>{release=()=>resolve(apply(frame));});event(f.nodes.get('separate-indicator-panel'),'click');assert.equal(controller.state.layoutBusy,true);await tick();release();await tick();await tick();assert.equal(controller.state.layoutBusy,false);
 await controller.dispose();
});

test('layout file reconciliation runs only in a migrated candidate and failure leaves the source exact',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),source=controller.session,input=f.nodes.get('chart-layout-file');
 f.nodes.get('layout-indicator').value='rsi';event(f.nodes.get('layout-indicator'),'change');event(f.nodes.get('separate-indicator-panel'),'click');await settle(()=>controller.state.layoutHistory.cursor===1,'pre-file layout history');
 source.drawings={...source.drawings,items:[{id:'kept',type:'horizontal',panel:'price',points:[{time:1,price:2}]}],selected:'kept',canUndo:true,undoCount:1};source.state.drawings={...source.state.drawings,count:1,selected:'kept',canUndo:true};await controller.refresh();
 const beforeDrawings=structuredClone(source.drawings),success=layoutFile(source,5);Object.defineProperty(input,'files',{configurable:true,value:[success]});event(input,'change');
 for(let index=0;index<100&&controller.session===source;index++)await tick();assert.notEqual(controller.session,source,`${f.nodes.get('chart-layout-status').textContent} / ${f.nodes.get('status').textContent} / ${JSON.stringify(f.sessions.at(-1).configuration.indicators)}`);
 assert.equal(source.closed,true);assert.equal(controller.session.configuration.indicators.find(row=>row.id==='extra-file').params.period,5);assert.deepEqual(controller.session.drawings,beforeDrawings);assert.equal(controller.state.layoutHistory.cursor,0);assert.equal(controller.state.layoutHistory.commands.length,0);
 const accepted=controller.session,acceptedConfig=structuredClone(accepted.configuration),acceptedDrawings=structuredClone(accepted.drawings),generation=accepted.generation,failure=layoutFile(accepted,0);Object.defineProperty(input,'files',{configurable:true,value:[failure]});event(input,'change');
 await settle(()=>/변경을 적용하지 못했습니다/.test(f.nodes.get('chart-layout-status').textContent),'candidate rejection');
 assert.equal(controller.session,accepted);assert.equal(controller.session.generation,generation);assert.deepEqual(controller.session.configuration,acceptedConfig);assert.deepEqual(controller.session.drawings,acceptedDrawings);assert.equal(f.sessions.at(-1).closed,true);
 await controller.dispose();
});

test('canonical file order rebuilds private series and indicators while preserving bound drawings and target',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),source=controller.session,input=f.nodes.get('chart-layout-file'),base=JSON.parse(await layoutFile(source,5).text());base.layout.series.reverse();base.layout.indicators.reverse();source.drawings={...source.drawings,items:[{id:'bound',type:'horizontal',panel:'price',seriesId:'ema',points:[{time:1,price:2}]}],selected:'bound',canUndo:true,undoCount:1};source.state.drawings={...source.state.drawings,count:1,selected:'bound',canUndo:true};source.state.interaction.drawingTarget={panel:'price',axisId:null,seriesId:'ema'};await controller.refresh();const expectedDrawings=structuredClone(source.drawings),expectedTarget=structuredClone(source.state.interaction.drawingTarget),file=delayedFile(JSON.stringify(base));selectFile(input,file.file);file.release();await settle(()=>controller.session!==source,'ordered candidate');assert.deepEqual(controller.session.configuration.series.map(row=>row.id),base.layout.series.map(row=>row.id));assert.deepEqual(controller.session.configuration.indicators.map(row=>row.id),base.layout.indicators.map(row=>row.id));assert.deepEqual(controller.session.drawings,expectedDrawings);assert.deepEqual(controller.session.state.interaction.drawingTarget,expectedTarget);await controller.dispose();
});

test('file admission enforces size before read and the newest drawing selection owns publication',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),layoutInput=f.nodes.get('chart-layout-file'),analysisInput=f.nodes.get('analysis-file'),drawingInput=f.nodes.get('file');
 const oversizedLayout=delayedFile('',{size:600000});selectFile(layoutInput,oversizedLayout.file);await tick();assert.equal(oversizedLayout.reads,0);assert.match(f.nodes.get('chart-layout-status').textContent,/512 KiB/);
 const oversizedAnalysis=delayedFile('',{size:33*1024*1024});selectFile(analysisInput,oversizedAnalysis.file);await tick();assert.equal(oversizedAnalysis.reads,0);assert.match(f.nodes.get('analysis-status').textContent,/32 MiB/);
 const first=delayedFile('{"first":true}'),second=delayedFile('{"second":true}');selectFile(drawingInput,first.file);assert.equal(drawingInput.value,'');selectFile(drawingInput,second.file);second.release();for(let index=0;index<10;index++)await tick();assert.equal(controller.session.calls.filter(([name])=>name==='loadDrawings').length,1,`${f.nodes.get('status').textContent} / ${f.nodes.get('chart-layout-status').textContent}`);first.release();await tick();await tick();assert.equal(controller.session.calls.filter(([name])=>name==='loadDrawings').length,1);
 await controller.dispose();
});

test('delayed drawing files cannot cross reload or renderer ownership and benign hover remains admissible',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),drawingInput=f.nodes.get('file'),source=controller.session;
 const reloadFile=delayedFile('{"reload":true}');selectFile(drawingInput,reloadFile.file);f.nodes.get('market').value='kr';const reload=controller.load();reloadFile.release();await reload;assert.notEqual(controller.session,source);assert.equal(controller.session.calls.some(([name])=>name==='loadDrawings'),false);
 const rendererFile=delayedFile('{"renderer":true}');selectFile(drawingInput,rendererFile.file);f.nodes.get('renderer').value='webgl2';event(f.nodes.get('renderer'),'change');rendererFile.release();await tick();await tick();assert.equal(controller.session.calls.some(([name,args])=>name==='loadDrawings'&&args[0]==='{"renderer":true}'),false);
 const hoverFile=delayedFile('{"hover":true}');selectFile(drawingInput,hoverFile.file);controller.session.lastOutcome={id:++controller.session.outcome,operation:'nativePointer'};controller.session.state.interaction.crosshair={x:20,y:30};controller.session.emit();hoverFile.release();await settle(()=>controller.session.calls.some(([name,args])=>name==='loadDrawings'&&args[0]==='{"hover":true}'),'hover drawing');
 await controller.dispose();
});

test('layout read rejects source edits and a reload cancels the old owner request',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),input=f.nodes.get('chart-layout-file'),source=controller.session,generation=source.generation;
 const edited=delayedFile(await layoutFile(source,5).text());selectFile(input,edited.file);await source.command('setVisibleRange',[4,50]);edited.release();await settle(()=>/파일을 읽는 동안/.test(f.nodes.get('chart-layout-status').textContent),'layout stale');assert.equal(controller.session.generation,generation);assert.equal(f.sessions.length,1);
 const reloaded=delayedFile(await layoutFile(source,5).text());selectFile(input,reloaded.file);f.nodes.get('market').value='kr';const load=controller.load();reloaded.release();await load;assert.notEqual(controller.session,source);assert.equal(controller.session.configuration.indicators.some(row=>row.id==='extra-file'),false);
 await controller.dispose();
});

test('analysis preparation rechecks view ownership before install and cancel stops a delayed read',async t=>{
 const text=analysisText(t),f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),input=f.nodes.get('analysis-file'),source=controller.session,before=structuredClone(source.state.view);let releaseWorkspace;f.backend.workspaceGate=new Promise(resolve=>{releaseWorkspace=resolve;});
 const pending=delayedFile(text);selectFile(input,pending.file);pending.release();await settle(()=>f.backend.workspaceStarted===1,'analysis candidate');await source.command('setVisibleRange',[10,80]);releaseWorkspace();await settle(()=>/파일을 읽는 동안/.test(f.nodes.get('analysis-status').textContent),'analysis stale');assert.equal(controller.session,source);assert.equal(source.closed,false);assert.notDeepEqual(source.state.view,before);assert.equal(f.sessions.at(-1).closed,true);
 f.backend.workspaceGate=null;const cancelled=delayedFile(text);selectFile(input,cancelled.file);event(f.nodes.get('cancel-compute'),'click');cancelled.release();await tick();await tick();assert.equal(f.backend.workspaceStarted,1);assert.equal(controller.session,source);
 await controller.dispose();
});

test('an intermediate pointer gesture rejects a file even when the final snapshot looks idle',async t=>{
 const f=setup(t),controller=await mountRustDemo({root:f.root,backend:f.backend,loadData:f.loadData,chartFactory:f.chartFactory,widgetsFactory:f.widgetsFactory}),input=f.nodes.get('file'),source=controller.session,pending=delayedFile('{"gesture":true}');selectFile(input,pending.file);source.lastOutcome={id:++source.outcome,operation:'nativePointer'};source.state.interaction.pointerCount=1;source.state.interaction.gestureKind='pan';source.emit();source.lastOutcome={id:++source.outcome,operation:'nativePointer'};source.state.interaction.pointerCount=0;source.state.interaction.gestureKind=null;source.emit();pending.release();await settle(()=>/파일을 읽는 동안/.test(f.nodes.get('status').textContent),'gesture stale');assert.equal(source.calls.some(([name])=>name==='loadDrawings'),false);await controller.dispose();
});
