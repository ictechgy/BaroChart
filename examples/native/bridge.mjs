let nativeLatestLayout=null,nativeLatestLayoutModel=null;
let nativeWorkspaceSource=null,nativeWorkspaceRegistration=0;
let nativeAsyncCapture=null,nativeAsyncTicket=0,nativeAsyncPrepared=null,nativeAsyncUIImport=null,nativeAsyncUIPrepared=null;
function nativeCapture(ticket){if(!nativeAsyncCapture||nativeAsyncCapture.ticket!==ticket||nativeAsyncCapture.capture.model!==globalThis.nativeModel)throw new Error('Async stale: source replaced/released');nativeAsyncCapture.capture.check();return nativeAsyncCapture.capture;}
globalThis.nativeAsyncBegin=function(eventJSON){if(nativeAsyncCapture||nativeWorkspaceSource||nativeParamsSource)throw new Error('Async capture busy');const capture=new AsyncCapture(globalThis.nativeModel,JSON.parse(eventJSON)),ticket=++nativeAsyncTicket;nativeAsyncCapture={ticket,capture};return JSON.stringify({ticket,metadataJSON:capture.metadataJSON,buffers:capture.buffers.map((a,slot)=>({slot,length:a.length})),checkpoints:capture.checkpoints.map((row,entry)=>({entry,total:row.keys.length,maxRows:row.maxRows}))});};
globalThis.nativePrepareBegin=function(requestJSON){if(nativeAsyncCapture||nativeWorkspaceSource||nativeParamsSource)throw new Error('Async capture busy');const capture=new PrepareCapture(globalThis.nativeModel,JSON.parse(requestJSON)),ticket=++nativeAsyncTicket;nativeAsyncCapture={ticket,capture};return JSON.stringify({ticket,metadataJSON:capture.metadataJSON,buffers:[],checkpoints:[]});};
globalThis.nativeDataAsyncBegin=function(kind,requestJSON){
 if(!['correction','columns','seeded'].includes(kind))throw new TypeError('Unknown async begin kind');
 try{return {result:kind==='correction'?nativeAsyncBegin(requestJSON):nativePrepareBegin(requestJSON)};}catch(error){if(!(error instanceof IngestionError))throw error;return {error:{name:error.name,code:error.code,message:String(error.message).slice(0,256)}};}
};
// A retained closed Swift engine deliberately retains its raw JSContext. Retire
// the opt-in ring without changing that legacy raw-data/context ownership rule.
globalThis.nativeReleaseDataIngestion=function(){const session=globalThis.nativeModel?.dataIngestion;const cancelled=session?.count??0;session?.dispose();return {cancelled,pendingEvents:0,ownedBytes:0};};
globalThis.nativePrepareCreate=function(metadataJSON){if(nativeAsyncPrepared||nativeParamsTarget||nativeParamsTargetCreating)throw new Error('Async target busy');nativeAsyncPrepared=new PreparedData(metadataJSON);return true;};
// Internal target-only workspace protocol. Host source capture/publication is
// separate; reject use in an already initialized live runtime.
function nativeWorkspaceTargetVacant(){if(!Object.isExtensible(globalThis))throw new Error('Workspace target global is not extensible');for(const key of ['nativeModel','nativeAPI','nativeInput','nativeSize']){const d=Object.getOwnPropertyDescriptor(globalThis,key);if(d&&(!Object.hasOwn(d,'value')||d.value!==undefined||!d.configurable))throw new Error('Workspace target requires an isolated empty runtime');}}
globalThis.nativeWorkspaceTargetCreate=function(metadataJSON){if(nativeAsyncPrepared||nativeParamsTarget||nativeParamsTargetCreating||nativeAsyncUIImport||nativeAsyncUIPrepared)throw new Error('Async target busy');nativeWorkspaceTargetVacant();const target=new NativeWorkspacePrepared(metadataJSON);try{nativeWorkspaceTargetVacant();nativeAsyncPrepared=target;return true;}catch(error){target.dispose();throw error;}};
globalThis.nativeWorkspaceTargetFinish=function(){if(!(nativeAsyncPrepared instanceof NativeWorkspacePrepared))throw new Error('Workspace target missing');const target=nativeAsyncPrepared;let result;try{nativeWorkspaceTargetVacant();result=target.finish();nativeWorkspaceTargetVacant();const input=new InteractionController(result.model,()=>globalThis.nativeSize),api=new ChartAPI(result.model,{controller:input});Object.defineProperties(globalThis,{nativeSize:{value:result.size,writable:true,configurable:true,enumerable:true},nativeModel:{value:result.model,writable:true,configurable:true,enumerable:true},nativeInput:{value:input,writable:true,configurable:true,enumerable:true},nativeAPI:{value:api,writable:true,configurable:true,enumerable:true}});nativeLatestLayout=null;nativeLatestLayoutModel=null;nativeAsyncPrepared=null;return {schema:'aster.native-workspace-target-ready',version:1,status:'target-ready',hostPublished:false,plan:result.plan};}catch(error){try{result?.model.dispose();}finally{try{target.dispose();}finally{if(nativeAsyncPrepared===target)nativeAsyncPrepared=null;}}throw error;}};
globalThis.nativeWorkspaceTargetDispose=function(){if(nativeAsyncPrepared instanceof NativeWorkspacePrepared){const target=nativeAsyncPrepared;try{target.dispose();}finally{if(nativeAsyncPrepared===target)nativeAsyncPrepared=null;}return true;}return false;};
function nativeWorkspaceSourceOwner(row){if(workspaceSlot(globalThis,'nativeModel')!==row.model||workspaceSlot(globalThis,'nativeAPI')!==row.api||workspaceSlot(globalThis,'nativeInput')!==row.input||workspaceSlot(globalThis,'nativeSize')!==row.size||workspaceSlot(row.api,'model')!==row.model||workspaceSlot(row.api,'controller')!==row.input||workspaceSlot(row.input,'model')!==row.model)throw new Error('Workspace source stale: native owner replaced');}
function nativeWorkspaceSourceRow(ticket){const row=nativeWorkspaceSource;if(!row||row.ticket!==ticket)throw new Error('Workspace source ticket missing/released');return row;}
function nativeWorkspaceSourceDrop(row){try{row.capture?.dispose();}finally{if(nativeWorkspaceSource===row)nativeWorkspaceSource=null;}}
function nativeWorkspaceSourceOperation(ticket,operation){const row=nativeWorkspaceSourceRow(ticket);try{nativeWorkspaceSourceOwner(row);const result=operation(row);nativeWorkspaceSourceOwner(row);return result;}catch(error){nativeWorkspaceSourceDrop(row);throw error;}}
globalThis.nativeWorkspaceSourceBegin=function(document,binding,revision,maxBytes=805306368,registration){if(nativeAsyncCapture||nativeWorkspaceSource||nativeParamsSource)throw new Error('Async capture busy');if(registration!==undefined){if(!Number.isSafeInteger(registration)||registration<=nativeWorkspaceRegistration)throw new RangeError('Workspace registration must increase');nativeWorkspaceRegistration=registration;}if(!Number.isSafeInteger(nativeAsyncTicket+1))throw new RangeError('Workspace source ticket limit');const row={ticket:++nativeAsyncTicket,registration,model:workspaceSlot(globalThis,'nativeModel'),api:workspaceSlot(globalThis,'nativeAPI'),input:workspaceSlot(globalThis,'nativeInput'),size:workspaceSlot(globalThis,'nativeSize'),capture:null,revision};nativeWorkspaceSourceOwner(row);nativeWorkspaceSource=row;try{row.capture=new NativeWorkspaceCapture(row.api,document,binding,{input:row.input,size:row.size,revision,maxBytes});if(nativeWorkspaceSource!==row)throw new Error('Workspace source stale: registration changed');nativeWorkspaceSourceOwner(row);return {ticket:row.ticket,phase:'admission',...(registration===undefined?{}:{registration})};}catch(error){nativeWorkspaceSourceDrop(row);throw error;}};
globalThis.nativeWorkspaceSourceStep=function(ticket,maxRecords,revision){return nativeWorkspaceSourceOperation(ticket,row=>{const progress=row.capture.step(maxRecords,revision);return progress.complete?{...progress,ticket,metadataJSON:row.capture.metadataJSON,plan:row.capture.plan,buffers:FIELDS.map((_,slot)=>({slot,length:row.model.store.length})),checkpoints:[]}:progress;});};
globalThis.nativeWorkspaceSourceCheck=function(ticket,revision){return nativeWorkspaceSourceOperation(ticket,row=>row.capture.check(revision));};
globalThis.nativeWorkspaceSourceBuffer=function(ticket,slot,offset,count,revision){return nativeWorkspaceSourceOperation(ticket,row=>row.capture.buffer(slot,offset,count,revision));};
globalThis.nativeWorkspaceSourceFinish=function(ticket,revision){const row=nativeWorkspaceSourceRow(ticket);try{nativeWorkspaceSourceOwner(row);const receipt=row.capture.finish(revision);nativeWorkspaceSourceOwner(row);return {...receipt,ticket};}finally{nativeWorkspaceSourceDrop(row);}};
globalThis.nativeWorkspaceSourceDispose=function(ticket){if(!nativeWorkspaceSource||nativeWorkspaceSource.ticket!==ticket)return false;nativeWorkspaceSourceDrop(nativeWorkspaceSource);return true;};
// Host-known correlation identity survives lost Begin responses; not an authorization token.
globalThis.nativeWorkspaceSourceAbort=function(registration){if(!Number.isSafeInteger(registration)||registration<1)throw new RangeError('Workspace registration');if(!nativeWorkspaceSource||nativeWorkspaceSource.registration!==registration)return false;nativeWorkspaceSourceDrop(nativeWorkspaceSource);return true;};
globalThis.nativeAsyncCheck=function(ticket){nativeCapture(ticket);return true;};
globalThis.nativeAsyncBuffer=function(ticket,slot,offset,count){if(nativeParamsSource?.ticket===ticket)return nativeParamsOperation(ticket,row=>row.capture.buffer(slot,offset,count,row.revision));if(nativeParamsTarget){if(ticket!==nativeParamsTarget.binding.registration)throw new Error('Params target registration');return nativeParamsTarget.outputBuffer(slot,offset,count);}if(nativeWorkspaceSource?.ticket===ticket)return nativeWorkspaceSourceOperation(ticket,row=>row.capture.buffer(slot,offset,count,row.revision));return nativeCapture(ticket).buffer(slot,offset,count);};
globalThis.nativeAsyncCheckpoint=function(ticket,entry,offset,count){return nativeCapture(ticket).checkpoint(entry,offset,count);};
globalThis.nativeAsyncUI=function(ticket){return nativeCapture(ticket).ui(globalThis.nativeInput,globalThis.nativeSize);};
globalThis.nativeAsyncUIBegin=function(ticket){const capture=nativeCapture(ticket);if(nativeAsyncCapture.ui)throw new Error('Async UI capture busy');nativeAsyncCapture.ui=new AsyncUICapture(capture,globalThis.nativeInput,globalThis.nativeSize);return nativeAsyncCapture.ui.headerJSON;};
globalThis.nativeAsyncUINext=function(ticket){nativeCapture(ticket);if(!nativeAsyncCapture.ui)throw new Error('Async UI capture missing');return nativeAsyncCapture.ui.next();};
globalThis.nativeAsyncUICheck=function(ticket){nativeCapture(ticket);if(!nativeAsyncCapture.ui||!nativeAsyncCapture.ui.lastComplete)throw new Error('Async UI incomplete source transfer');return nativeAsyncCapture.ui.check(globalThis.nativeInput,globalThis.nativeSize);};
globalThis.nativeAsyncRelease=function(ticket){if(nativeWorkspaceSource?.ticket===ticket)nativeWorkspaceSourceDrop(nativeWorkspaceSource);if(nativeAsyncCapture?.ticket===ticket){nativeAsyncCapture.capture.release();nativeAsyncCapture=null;}return true;};
globalThis.nativeAsyncCreate=function(metadataJSON){if(nativeAsyncPrepared||nativeParamsTarget||nativeParamsTargetCreating)throw new Error('Async target busy');nativeAsyncPrepared=new AsyncPrepared(metadataJSON);return true;};
globalThis.nativeAsyncTargetBuffer=function(slot,offset,count){if(nativeParamsSource)return nativeParamsWrite(slot,offset,count);if(nativeParamsTarget)return nativeParamsTarget.target(slot,offset,count);if(!nativeAsyncPrepared)throw new Error('Async target missing');return nativeAsyncPrepared.target(slot,offset,count);};
globalThis.nativeAsyncCheckpointImport=function(entry,text){if(!nativeAsyncPrepared)throw new Error('Async target missing');nativeAsyncPrepared.checkpoint(entry,text);return true;};
globalThis.nativeAsyncStart=function(){if(!nativeAsyncPrepared)throw new Error('Async target missing');nativeAsyncPrepared.start();return true;};
globalThis.nativeAsyncStep=function(maxBars){if(!nativeAsyncPrepared)throw new Error('Async target missing');return JSON.stringify(nativeAsyncPrepared.step(maxBars));};
globalThis.nativeAsyncUIImportBegin=function(text){if(nativeAsyncPrepared instanceof NativeWorkspacePrepared)throw new Error('Workspace target does not import source UI');if(!nativeAsyncPrepared||nativeAsyncUIImport)throw new Error('Async UI target unavailable');nativeAsyncUIImport=new AsyncUIImport(text,nativeAsyncPrepared);return true;};
globalThis.nativeAsyncUIImportChunk=function(text){if(!nativeAsyncUIImport)throw new Error('Async UI target missing');nativeAsyncUIImport.chunk(text);return true;};
globalThis.nativeAsyncUIImportEnd=function(){if(!nativeAsyncUIImport)throw new Error('Async UI target missing');nativeAsyncUIPrepared=nativeAsyncUIImport.finish();nativeAsyncUIImport=null;return true;};
globalThis.nativeAsyncFinish=function(uiJSON){if(!nativeAsyncPrepared)throw new Error('Async target missing');const {model,ui}=nativeAsyncUIPrepared??nativeAsyncPrepared.finish(uiJSON),input=new InteractionController(model,()=>globalThis.nativeSize),api=new ChartAPI(model,{controller:input});input.setTool(ui.tool);api.setText(ui.text);api.setDrawingTarget(ui.drawingTarget??null);if(ui.symbol)api.setSymbol(ui.symbol);globalThis.nativeModel?.dispose();nativeLatestLayout=null;nativeLatestLayoutModel=null;globalThis.nativeModel=model;globalThis.nativeInput=input;globalThis.nativeAPI=api;globalThis.nativeSize=ui.size;nativeAsyncPrepared=null;nativeAsyncUIPrepared=null;return true;};
globalThis.nativeIndicatorBuffer=function(id,output,offset,count){const values=globalThis.nativeModel?.indicators.get(id).outputs[output];if(!(values instanceof Float64Array)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(count)||count<1||count>262144||offset+count>values.length)throw new RangeError('Native indicator slice');return values.subarray(offset,offset+count);};
globalThis.nativeInit = function(count = 100000, options = null) {
  if(options!==null&&(!options||typeof options!=='object'||Array.isArray(options)))throw new TypeError('Chart options object');
  const store = new BarStore(); store.setColumns(seededColumns(count, 42));
  const model = new ChartModel({store, axes:options?.axes??[],panels:options?.panels??[{id:'price',weight:3,...(options===null?{label:'ASTER · NATIVE'}:{})},...(options===null?[{id:'volume',weight:1,label:'VOLUME'}]:[])],visibleBars:options?.visibleBars??200,axisWidth:options?.axisWidth??82,precision:options?.precision??2});
  const size={width:1200,height:700},input=new InteractionController(model,()=>globalThis.nativeSize??size),api=new ChartAPI(model,{controller:input});
  try {
    if(options===null){model.addSeries({id:'price',type:'candles',panel:'price'});model.addSeries({id:'volume',type:'histogram',panel:'volume',source:'volume',color:'#397e8c'});model.indicators.add('ema','ema');model.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema',color:'#f0b755'});}
    else {if(options.theme)api.setTheme(options.theme);for(const series of options.series??[])api.addSeries(series);}
  } catch(error) {model.dispose();throw error;}
  globalThis.nativeModel?.dispose();
  nativeLatestLayout=null;nativeLatestLayoutModel=null;globalThis.nativeModel = model; globalThis.nativeSize = {width: 1200, height: 700};
  globalThis.nativeInput = input;globalThis.nativeAPI = api;
  return count;
};
globalThis.nativeSetData = function(bars) {globalThis.nativeModel.store.setData(bars); globalThis.nativeModel.fit();};
globalThis.nativeDataEvent = function(event) {applyDataEvent(globalThis.nativeModel.store,event);};
globalThis.nativeEcho = function(value) {return value;};
globalThis.nativeCommand = function(operation,args=[]) {return nativeAPI.dispatch(operation,args);};
// Dedicated reads intentionally bypass command mutation notification routing.
globalThis.nativeSaveWorkspace=function(binding){const api=globalThis.nativeAPI,model=globalThis.nativeModel,input=globalThis.nativeInput;if(api?.model!==model)throw new Error('Workspace native owner mismatch');const text=saveWorkspace(api,binding);if(globalThis.nativeAPI!==api||globalThis.nativeModel!==model||globalThis.nativeInput!==input){const error=new Error('Workspace native owner changed');error.name='StaleSourceError';throw error;}return text;};
globalThis.nativePreflightWorkspace=function(text,binding){const api=globalThis.nativeAPI,model=globalThis.nativeModel,input=globalThis.nativeInput;if(api?.model!==model)throw new Error('Workspace native owner mismatch');const receipt=nativeWorkspacePreflight(api,text,binding);if(globalThis.nativeAPI!==api||globalThis.nativeModel!==model||globalThis.nativeInput!==input){const error=new Error('Workspace native owner changed');error.name='StaleSourceError';throw error;}return receipt;};

// Typed ingestion facades retain stable error codes across JSC/JNI without
// changing the legacy generic JS exception boundary for other commands.
globalThis.nativeDataIngestionCommand = function(operation,args=[]) {
 const allowed=['configureDataIngestion','enqueueDataEvents','drainDataEvents','pauseDataIngestion','resumeDataIngestion','cancelDataEvents','dataIngestionStats','saveDataIngestion','loadDataIngestion'];
 if(!allowed.includes(operation))throw new TypeError('Unknown ingestion command');
 try{return {result:nativeAPI.dispatch(operation,args)};}catch(error){return {error:{name:'IngestionError',code:error instanceof IngestionError?error.code:operation==='loadDataIngestion'?'INVALID_DOCUMENT':'INVALID_INPUT',message:String(error.message).slice(0,256)}};}
};
globalThis.nativeRegisterIndicatorSource = function(name,source) {nativeAPI.registerIndicatorSource(name,source);return null;};
globalThis.nativeGestureKind=function(){return nativeInput.gesture?.kind??null;};
globalThis.nativeThemeFont=function(){return nativeModel.theme.font;};
globalThis.nativeAccessibility = function(useLastFrame=false){const last=nativeModel.store.length?nativeModel.store.at(nativeModel.store.length-1):null,selected=nativeModel.drawings.items.find(d=>d.id===nativeModel.drawings.selected);const close=last?(nativeModel.priceFormatter?nativeModel.priceFormatter(last.close):last.close.toPrecision(15)):'No data',selection=selected?selected.type+(selected.locked?' locked':' editable'):'No selection',panels=nativeModel.panels.map(p=>({id:p.id,title:p.label??p.id,series:nativeModel.series.filter(s=>s.panel===p.id&&s.visible!==false).map(s=>({id:s.id,label:s.label??s.indicator??s.id,...(s.indicator?{indicator:s.indicator}:{})}))})),crosshair=nativeModel.crosshair?(useLastFrame===true&&nativeLatestLayoutModel===nativeModel&&nativeLatestLayout?.width===nativeSize.width&&nativeLatestLayout?.height===nativeSize.height?crosshairValuesAt(nativeModel,nativeLatestLayout):nativeAPI.crosshairValues(nativeSize.width,nativeSize.height)):null,readout=[`${nativeModel.store.length} bars. Close ${close}. ${selection}. Tool ${nativeInput.tool}.`,...panels.map(p=>p.title+': '+p.series.map(s=>s.label).join(', ')),...(crosshair?[`Time ${new Date(crosshair.time).toISOString()}`, ...crosshair.axes.map(a=>(a.id??a.panel)+': '+a.formatted),...crosshair.series.map(s=>s.label+': '+(s.value??'gap'))]:[])].join('. ');return {bars:nativeModel.store.length,close,selection,tool:nativeInput.tool,panels,crosshair,readout};};
globalThis.nativeIndicator = function(id,name,params,panel='price') {const data=nativeModel.indicators.add(id,name,params);for(const output of Object.keys(data.outputs))nativeModel.addSeries({id:id+'-'+output,type:'line',panel,indicator:id,output});return Object.keys(data.outputs);};
globalThis.nativeAccessibilityText=function(useLastFrame=true,platform='android'){
 if(!['android','uikit'].includes(platform))throw new TypeError('Accessibility text platform');
 const summary=nativeAccessibility(useLastFrame);
 return platform==='android'?summary.readout:[summary.bars+' bars',summary.panels.map(p=>p.title).join('; '),summary.readout,summary.selection,'tool '+summary.tool].filter(text=>text.length>0).join('; ');
};
globalThis.nativeAnalysisDemo=function(){
 const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00',kind:'regular'}],exceptions:{}}),bars=[];
 for(const day of ['2026-03-06','2026-03-09']){const first=zonedEpoch(day,'07:00','America/New_York');for(let i=0;i<600;i++){const close=100+Math.sin(i/31)*2+i*.003;bars.push({time:first+i*60000,open:close-.1,high:close+.4,low:close-.4,close,volume:100+i%73});}}
 nativeInit(0,{panels:[{id:'price',weight:3,label:'SESSION VWAP · NY / DST'},{id:'analysis-volume',weight:1,label:'CLOSE-DIRECTION VOLUME PROXY'}],series:[{id:'price',type:'candles',panel:'price'}]});
 nativeAPI.setData(bars);nativeAPI.registerIndicatorModule('aster.volume-direction',1);
 nativeAPI.addIndicator('analysis-vwap','vwap',{calendar,deviation:2});
 for(const [output,color] of [['value','#f0b755'],['upper','#58cadb'],['lower','#58cadb']])nativeAPI.addSeries({id:'analysis-vwap-'+output,type:'line',panel:'price',indicator:'analysis-vwap',output,color,label:'VWAP '+output});
 const module='aster.volume-direction@1/pressure';nativeAPI.addIndicator('analysis-pressure',module);
 nativeAPI.addSeries({id:'analysis-pressure-signed',type:'histogram',panel:'analysis-volume',indicator:'analysis-pressure',output:'signed',color:'#7898ff',label:'Volume direction proxy'});nativeAPI.fit();
 return {schema:'aster.analysis-demo',checks:5,module,setup:nativeAPI.saveStudies(),asOf:nativeAPI.indicatorValueAt('analysis-vwap','value',bars.length-1)};
};
// Demo-only fresh study container: preserve current data/layout, import before
// swapping the engine, and leave the visible chart intact on an invalid file.
globalThis.nativeAnalysisReload=function(text){
 const old=nativeModel,model=new ChartModel({store:old.store,panels:old.panels.map(p=>({...p})),axes:old.axes.map(a=>({...a})),theme:old.theme,axisWidth:old.axisWidth,precision:old.precision}),input=new InteractionController(model,()=>nativeSize),api=new ChartAPI(model,{controller:input});
 try{for(const series of old.series.filter(s=>!s.indicator)){const options=Object.fromEntries(SERIES_KEYS.filter(k=>series[k]!==undefined).map(k=>[k,series[k]]));api.addSeries(options);}const result=api.loadStudies(text);model.view={...old.view};model.follow=old.follow;old.dispose();nativeModel=model;nativeInput=input;nativeAPI=api;nativeLatestLayout=null;nativeLatestLayoutModel=null;return result;}catch(error){model.dispose();throw error;}
};
globalThis.nativeStudyVerification=function(){
 const checks=[],check=(ok,message)=>{if(!ok)throw new Error(message);checks.push(message);},bars=[10,11,11,9].map((close,i)=>({time:Date.parse('2026-03-06T14:30:00Z')+i*60000,open:close,high:close,low:close,close,volume:[5,7,8,9][i]})),store=new BarStore(bars),model=new ChartModel({store}),api=new ChartAPI(model);
 let restored=null;
 try{
  const names=api.registerIndicatorModule('aster.volume-direction',1);check(names[0]==='aster.volume-direction@1/pressure','Canonical static module name');api.addIndicator('pressure',names[0],{shift:-2});
  check(JSON.stringify(api.indicatorValues('pressure','signed'))==='[0,7,0,-9]','Independent signed-volume literal');check(JSON.stringify(api.indicatorValues('pressure','cumulative'))==='[0,7,7,-2]','Independent cumulative-volume literal');
  check(api.indicatorValueAt('pressure','signed',0,{mode:'plot',asOfIndex:0}).sourceTime===null,'Negative shift cannot leak a future timestamp');check(api.indicatorValueAt('pressure','signed',0,{mode:'plot',asOfIndex:2}).value===0,'Observed shifted source becomes available');
  const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]});api.addIndicator('vwap','vwap',{calendar,deviation:2,source:'close'});check(Math.abs(api.indicatorValueAt('vwap','value',3).value-296/29)<1e-12,'Independent session VWAP weighted mean');check(api.indicatorValueAt('vwap','deviation',0).value===0,'One positive-volume observation has zero population deviation');
  api.addSeries({id:'vwap-line',type:'line',panel:'price',indicator:'vwap',color:'#f0b755'});const saved=api.saveStudies();restored=new ChartModel({store});const restoredAPI=new ChartAPI(restored),counts=restoredAPI.loadStudies(saved);check(counts.indicators===2&&counts.series===1,'Studies atomically imported into a fresh container');check(restoredAPI.saveStudies()===saved,'Study document roundtrip keeps exact module/config/bindings');
  const before=restoredAPI.saveStudies();let rejected=false;try{restoredAPI.loadStudies(saved);}catch{rejected=true;}check(rejected&&before===restoredAPI.saveStudies(),'Duplicate import rejects without changing the chart');
  const after={time:Date.parse('2026-03-09T13:30:00Z'),open:20,high:20,low:20,close:20,volume:2};store.append(after);check(api.indicatorValueAt('vwap','value',4).value===20,'DST session open resets at literal UTC instant');store.append({...after,time:Date.parse('2026-03-09T20:00:00Z'),close:30,open:30,high:30,low:30});check(api.indicatorValueAt('vwap','value',5).value===null,'Session close is an excluded boundary');
  return {passed:checks.length,checks};
 }finally{restored?.dispose();model.dispose();}
};
globalThis.nativeView = function(from,to) {nativeModel.setVisibleRange(from,to);};
globalThis.nativeFit = function() {nativeModel.fit();};
globalThis.nativeAddPanel = function(options) {return nativeModel.addPanel(options);};
globalThis.nativeSetPanel = function(id,patch) {nativeModel.setPanel(id,patch);};
globalThis.nativeAddSeries = function(options) {return nativeModel.addSeries(options);};
globalThis.nativeRemoveSeries = function(id) {nativeModel.removeSeries(id);};
globalThis.nativeTheme = function(theme) {nativeModel.theme={...nativeModel.theme,...theme};};
globalThis.nativeInspect = function() {return JSON.stringify({view:nativeModel.view,drawings:nativeModel.drawings.items,storedBars:nativeModel.store.length,tool:nativeInput.tool,pointers:nativeInput.pointers.size,gesture:nativeInput.gesture?.kind??null});};
globalThis.nativeSceneJSON = function(width, height) {globalThis.nativeSize = {width, height}; const scene = buildScene(globalThis.nativeModel, width, height); nativeLatestLayout=scene.layout;nativeLatestLayoutModel=nativeModel;return JSON.stringify(scene);};
globalThis.nativeResize = function(width, height) {globalThis.nativeSize = {width, height};};
globalThis.nativePointer = function(kind,id,x,y,hitTolerance=8){if(!['down','move','up','cancel'].includes(kind))throw new TypeError('Pointer operation');try{if(kind==='cancel')nativeInput.cancel();else if(kind==='down')nativeInput.down(id,x,y,hitTolerance);else nativeInput[kind](id,x,y);}catch(error){nativeInput.cancel();throw error;}};
globalThis.nativeTool = function(tool) {globalThis.nativeInput.setTool(tool);};
globalThis.nativeWheel = function(delta, x) {globalThis.nativeInput.wheel(delta, x);};
globalThis.nativeKey = function(key, ctrl, shift) {globalThis.nativeInput.key(key, {ctrl, shift});};
globalThis.nativeSave = function() {return globalThis.nativeModel.drawings.save();};
globalThis.nativeLoad = function(text) {nativeAPI.loadDrawings(text);};
// Host fixture for the common mutation/notification boundary; no global model changes.
globalThis.nativePublicationOrderSelfTest=function(){
 const T=1700000000000,rows=()=>Array.from({length:32},(_,i)=>({time:T+i*60000,open:100,high:120,low:90,close:110,volume:1})),checks=[];
 for(const kind of ['reset','prepend','correction','nested']){
  const store=new BarStore(rows());let api,armed=false,seen=null;
  const stop=store.subscribe(()=>{if(!armed)return;armed=false;if(kind==='nested')api.applyDataEvent({kind:'reset',bars:rows()});api.setVisibleRange(4,14);seen=api.indicatorValues('ema')[1];}),model=new ChartModel({store});api=new ChartAPI(model);api.addIndicator('ema','ema',{period:2});
  try{armed=true;api.applyDataEvent(kind==='reset'?{kind,bars:rows().map(b=>({...b,open:200,high:240,low:180,close:220}))}:kind==='correction'?{kind,bar:{...store.at(0),volume:999}}:{kind:'prepend',bars:[{...store.at(0),time:T-60000}]});if(model.view.from!==4||model.view.to!==14||model.follow||kind==='reset'&&seen!==220||store.listenerErrors.length)throw new Error('Native publication order '+kind);checks.push(kind+' latest viewport/current indicator');}
  finally{stop();model.dispose();if(store.listeners.size)throw new Error('Native publication subscription leak');}
 }
 return {passed:checks.length,checks,input:'Direct core API; no worker transport or OS touch',physicalDevice:false};
};
globalThis.nativeSelfTest = function() {
  const assertNative = (v, message) => {if (!v) throw new Error(message);};
  const store = new BarStore(); store.setColumns(seededColumns(300, 42)); const engine = new IndicatorEngine(store); engine.add('r', 'rsi');
  const b = store.at(299); store.upsert({...b, close: b.close + .1, high: Math.max(b.high, b.close + .1)}); const incremental = engine.get('r').outputs.value[299];
  const batch = new IndicatorEngine(store); assertNative(incremental === batch.add('r', 'rsi').outputs.value[299], 'RSI correction parity');
  const q = store.aggregate(0, 300, 10); assertNative(q[0].open === store.columns.open[0] && q[q.length - 1].close === store.columns.close[299], 'OHLC preservation');
  const d = new DrawingStore(); const id = d.add({type:'trendline', panel:'price', points:[{time:1,price:2},{time:3,price:4}]}); d.begin(); d.edit(id,{points:[{time:2,price:4},{time:4,price:5}]}); d.cancel(); assertNative(d.items[0].points[0].time === 1,'Gesture cancel'); const saved=d.save(); const loaded=new DrawingStore(); loaded.load(saved); assertNative(loaded.save()===saved,'Serialization');
  nativeInit(10000); const scene=JSON.parse(nativeSceneJSON(1200,700)); assertNative(scene.stats.storedBars===10000 && scene.commands.length>10,'Native scene');
  return JSON.stringify({passed:5, runtime:globalThis.nativeRuntime??'JavaScriptCore', storedBars:10000, sceneCommands:scene.commands.length});
};
globalThis.nativeExtendedSelfTest = function() {
 const checks=[],check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);};
 check(zonedEpoch('2026-03-09','09:30','America/New_York')===Date.parse('2026-03-09T13:30:00Z'),'New York DST opening');
 check(zonedEpoch('2026-11-01','01:30','America/New_York','later')-zonedEpoch('2026-11-01','01:30','America/New_York','earlier')===3600000,'DST repeated clock');
 let rejected=false;try{zonedEpoch('2026-03-08','02:30','America/New_York');}catch{rejected=true;}check(rejected,'DST nonexistent clock rejected');
 const s=new BarStore([{time:1700000000123,open:1.234567890123e-12,high:2e-12,low:1e-12,close:1.345678901234e-12,volume:7}]);
 check(s.at(0).close===1.345678901234e-12&&s.at(0).time===1700000000123,'Float64 tiny price and UTC');
 const d=new DrawingStore();d.add({type:'text',points:[{time:1700000000123,price:1.345678901234e-12}],text:'한국 🚀 café'});const saved=d.save(),restored=new DrawingStore();restored.load(saved);check(restored.items[0].text==='한국 🚀 café','Unicode text save/load');
 const m=new ChartModel({store:s,visibleBars:10});m.addSeries({id:'p',type:'candles',panel:'price'});const input=new InteractionController(m,()=>({width:1000,height:600}));input.setTool('rectangle');input.down(1,200,200);input.move(1,400,300);input.key('z',{ctrl:true});input.move(1,500,350);check(!input.gesture&&!input.pointers.size&&!m.drawings.items.length,'Undo during drag resets state');m.dispose();
 return JSON.stringify({passed:checks.length,checks,runtime:globalThis.nativeRuntime??'JavaScriptCore'});
};
globalThis.nativeHardeningSelfTest = function(){const checks=[],check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);},store=new BarStore();store.setColumns(seededColumns(40));store.subscribe(()=>{throw new Error('host callback')});const model=new ChartModel({store}),api=new ChartAPI(model);model.indicators.add('e','ema');store.update(39,{...store.at(39),close:1000,high:1000});const fresh=new IndicatorEngine(store);check(model.indicators.get('e').outputs.value[39]===fresh.add('e','ema').outputs.value[39]&&store.listenerErrors.length===1,'Listener failure preserves indicator consistency');
 let rejected=false;try{api.setPanel('price',JSON.parse('{"__proto__":{"range":[1,1e309]}}'));}catch{rejected=true;}check(rejected&&Object.getPrototypeOf(model.panels[0])===Object.prototype,'Prototype patch rejected');const listeners=store.listeners.size;try{new ChartModel({store,panels:[{id:'x'},{id:'x'}]});}catch{}check(store.listeners.size===listeners,'Failed constructor releases subscriptions');
 const input={schema:'aster.drawings',version:1,drawings:[{id:'green',type:'text',panel:'price',points:[{time:store.at(10).time,price:100}],text:'green',style:{color:'rgba(0,255,0,1)',font:'18px monospace'}}]};api.loadDrawings(JSON.stringify(input));check(model.drawings.items[0].style.color==='#00ff00ff','Imported style normalized for native renderer');const saved=api.saveDrawings();input.drawings[0].style.font='1000000px monospace';rejected=false;try{api.loadDrawings(JSON.stringify(input));}catch{rejected=true;}check(rejected&&api.saveDrawings()===saved,'Oversize import atomic');
 api.addIndicator('mac','macd');api.addSeries({id:'mac',type:'line',panel:'price',indicator:'mac',output:'signal'});api.setSeries('mac',{output:null});check(model.series[0].output===undefined,'Nullable output restored');rejected=false;try{api.dispatch('registerIndicatorSource',['unsafe','(()=>{throw new Error("executed")})()']);}catch{rejected=true;}check(rejected,'Code registration excluded from data dispatch');const unit=(time,volume)=>({time,open:1,high:1,low:1,close:1,volume}),tiny=2**969,edge=new BarStore([unit(1,Number.MAX_VALUE),unit(2,0),unit(3,tiny)]),edgeVersion=edge.version;rejected=false;try{edge.append(unit(4,tiny));}catch{rejected=true;}check(rejected&&edge.length===3&&edge.version===edgeVersion&&edge.columns.time[3]===0,'Overflow append preserves data/version');fresh.dispose();model.dispose();return {passed:checks.length,checks};};
// Internal reproducible benchmark helpers, outside the data-command facade.
globalThis.nativeBenchmarkEvent=function(index){const bar=nativeModel.store.at(index);return {kind:'correction',bar:{...bar,close:1000,high:Math.max(bar.high,1000),low:Math.min(bar.low,1000)}};};
globalThis.nativeBenchmarkDigest=function(){let a=2166136261,b=2246822519,outputs=0;for(const e of nativeModel.indicators.entries.values())for(const data of e.arrays){const bits=new Uint32Array(data.buffer,data.byteOffset,nativeModel.store.length*2);for(let i=0;i<bits.length;i++){a=Math.imul(a^bits[i],16777619)>>>0;b=(Math.imul(b^bits[i],3266489917)+374761393)>>>0;}outputs++;}const scene=JSON.parse(nativeSceneJSON(1200,700));return JSON.stringify({hashes:[a,b],outputs,length:nativeModel.store.length,layout:scene.layout,last:nativeModel.store.at(nativeModel.store.length-1)});};

// Per-renderer tokens prevent one attached view consuming another view's dirty flag.
const nativeFrameCaches=new Map();
function nativeRenderFrame(token,width,height,force){if(typeof token!=='string'||token.length<1||token.length>128)throw new TypeError('Native frame token');let cache=nativeFrameCaches.get(token);if(!cache){if(nativeFrameCaches.size>=64)throw new RangeError('Native frame cache count');cache=new SceneCache();nativeFrameCaches.set(token,cache);}globalThis.nativeSize={width,height};const frame=cache.frame(nativeModel,width,height,{forceBase:force});nativeLatestLayout=frame.scene.layout;nativeLatestLayoutModel=nativeModel;return {width,height,background:frame.scene.background,base:frame.baseChanged?frame.base:null,drawings:frame.drawingsChanged?frame.drawings:null,hover:frame.hover,stats:frame.scene.stats};}
globalThis.nativeRenderFrameJSON=function(token,width,height,force=false){return JSON.stringify(nativeRenderFrame(token,width,height,force));};
globalThis.nativeScenePacket=function(mode,token,width,height,force=false){
 if(mode==='frame'){const frame=nativeRenderFrame(token,width,height,force);return packNativeCommands([frame.base,frame.drawings,frame.hover],{mode,width,height,background:frame.background,stats:frame.stats});}
 if(mode!=='scene')throw new TypeError('Native packet mode');
 globalThis.nativeSize={width,height};const scene=buildScene(nativeModel,width,height);nativeLatestLayout=scene.layout;nativeLatestLayoutModel=nativeModel;
 return packNativeCommands([scene],{mode,width,height,background:scene.background,stats:scene.stats});
};
globalThis.nativeReleaseFrameCache=function(token){const cache=nativeFrameCaches.get(token);cache?.clear();nativeFrameCaches.delete(token);nativeLatestLayout=null;nativeLatestLayoutModel=null;return true;};
globalThis.nativeReleaseFrameCaches=function(){for(const cache of nativeFrameCaches.values())cache.clear();nativeFrameCaches.clear();nativeLatestLayout=null;nativeLatestLayoutModel=null;return true;};

// Synthetic independent-axis demonstration; exact UTC join, never a carried quote.
let nativeComparisonValues=null,nativeComparisonSaved='',nativeComparisonScale=0;
globalThis.nativeComparisonDemo=function(){
  nativeInit(0,{panels:[{id:'price',weight:1,label:'A OHLCV / B ALIGNED PRICE',padding:0}],axes:[{id:'comparison-B',panel:'price',side:'left',padding:0,precision:3,prefix:'B ',label:'SYNTH:B'}],series:[{id:'comparison-A',type:'candles',panel:'price'}]});
  const bars=Array.from({length:24},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:1000+i}));nativeAPI.setData(bars);
  const points=bars.filter((_,i)=>[1,2,4].includes(i%6)).map(b=>({time:b.time,value:2000+(b.time-1700000000000)/6000}));
  nativeComparisonValues=alignSeriesByTime(new Float64Array(bars.map(b=>b.time)),points);nativeComparisonSaved='';nativeComparisonScale=0;
  nativeAPI.addSeries({id:'comparison-B-line',panel:'price',type:'line',axisId:'comparison-B',symbolId:'SYNTH:B',label:'B exact / gaps',values:nativeComparisonValues,color:'#f0b755',width:2});
  nativeAPI.setDrawingTarget({panel:'price',seriesId:'comparison-B-line'});nativeAPI.fit();return {bars:24,matches:12,gaps:12,primary:'A store OHLCV',foreign:'SYNTH:B aligned price',schema:2};
};
globalThis.nativeComparisonReadout=function(width=1200,height=700){const r=nativeAPI.crosshairValues(width,height),b=r?.series.find(s=>s.id==='comparison-B-line');return {text:r?`A OHLCV close ${r.primary.bar.close.toFixed(2)} / B ${b?b.value===null?'gap':b.value.toFixed(3):'removed'} / UTC ${r.time}`:'A OHLCV / B exact price · move cursor',reading:r};};
globalThis.nativeComparisonAction=function(action,width=1200,height=700,savedDocument=null){
  if(action==='setup')return nativeComparisonDemo();if(!nativeModel.axes.some(a=>a.id==='comparison-B'))throw new Error('Open comparison demo first');
  if(!nativeComparisonValues){nativeComparisonValues=nativeModel.series.find(s=>s.id==='comparison-B-line')?.values??new Float64Array(Array.from({length:nativeModel.store.length},(_,i)=>[1,2,4].includes(i%6)?2000+10*i:NaN));}if(savedDocument!==null){if(typeof savedDocument!=='string')throw new TypeError('Saved drawing document string');nativeComparisonSaved=savedDocument;}
  if(action==='hide-axis'){const a=nativeModel.axes.find(a=>a.id==='comparison-B');nativeAPI.setAxis(a.id,{visible:!a.visible});}
  else if(action==='scale'){const current=nativeModel.axes.find(a=>a.id==='comparison-B').scale,mode=['linear','log','percent'][(['linear','log','percent'].indexOf(current)+1)%3];nativeAPI.setAxis('comparison-B',{scale:mode,base:2010,padding:0,range:null});}
  else if(action==='series'){if(nativeModel.series.some(s=>s.id==='comparison-B-line'))nativeAPI.removeSeries('comparison-B-line');else nativeAPI.addSeries({id:'comparison-B-line',panel:'price',type:'line',axisId:'comparison-B',symbolId:'SYNTH:B',values:nativeComparisonValues,color:'#f0b755',width:2});}
  else if(action==='drawing')nativeAPI.addDrawing({type:'trendline',panel:'price',axisId:'comparison-B',seriesId:'comparison-B-line',points:[{time:1700000000123,price:2010},{time:1700001380000,price:2230}]});
  else if(action==='save')nativeComparisonSaved=nativeAPI.saveDrawings();
  else if(action==='load'){if(!nativeComparisonSaved)throw new Error('Save drawing document first');nativeAPI.loadDrawings(nativeComparisonSaved);}
  else if(action==='primary')nativeAPI.setDrawingTarget(null);
  else throw new TypeError('Unknown comparison action');
  return {action,axis:nativeModel.axes[0],seriesPresent:nativeModel.series.some(s=>s.id==='comparison-B-line'),drawingCount:nativeModel.drawings.items.length,savedDocument:nativeComparisonSaved,readout:nativeComparisonReadout(width,height)};
};
globalThis.nativeAxesSelfTest=function(){
  const checks=[],check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);};nativeComparisonDemo();let l=createLayout(nativeModel,800,500),a=l.panels[0],b=l.axis('price','comparison-B');
  check(a.min===99&&a.max===125&&b.min===2010&&b.max===2220,'independent literal price ranges');nativeModel.crosshair={x:l.x(2),y:b.y(2100)};let r=nativeAPI.crosshairValues(800,500);check(r.primary.bar.close===103&&r.series.find(s=>s.id==='comparison-B-line').value===2020,'primary OHLCV and B price separated');nativeModel.crosshair.x=l.x(3);check(nativeAPI.crosshairValues(800,500).series.find(s=>s.id==='comparison-B-line').value===null,'exact UTC gap has no carried B quote');
  nativeAPI.setAxis('comparison-B',{scale:'log',range:[100,10000]});l=createLayout(nativeModel,800,500);b=l.axis('price','comparison-B');check(Math.abs(b.y(1000)-(b.top+b.bottom)/2)<1e-8,'log geometric midpoint');nativeAPI.setAxis('comparison-B',{scale:'percent',base:2000,range:[2000,4000],precision:1});l=createLayout(nativeModel,800,500);b=l.axis('price','comparison-B');nativeModel.crosshair={x:l.x(2),y:b.y(3000)};check(nativeAPI.crosshairValues(800,500).axes.find(a=>a.id==='comparison-B').formatted==='B 50.0%','independent percent base literal');
  const id=nativeAPI.addDrawing({type:'horizontal',panel:'price',seriesId:'comparison-B-line',points:[{time:1700000120000,price:3000}]});let d=nativeModel.drawings.items[0];check(d.axisId==='comparison-B'&&drawingGeometry(d,l)[0].coords[1]===(b.top+b.bottom)/2,'bound drawing uses B transform');const saved=nativeAPI.saveDrawings();check(JSON.parse(saved).version===2,'bound document v2');nativeAPI.setAxis('comparison-B',{visible:false});l=createLayout(nativeModel,800,500);check(drawingGeometry(d,l).length===1,'hidden axis retains drawing domain');nativeAPI.removeSeries('comparison-B-line');check(drawingGeometry(d,createLayout(nativeModel,800,500)).length===0,'removed series leaves hidden orphan');let rejected=false;try{nativeAPI.loadDrawings(saved);}catch{rejected=true;}check(rejected&&nativeAPI.saveDrawings()===saved,'missing binding import rejected atomically');nativeAPI.addSeries({id:'comparison-B-line',type:'line',panel:'price',axisId:'comparison-B',symbolId:'SYNTH:B',values:nativeComparisonValues});nativeAPI.loadDrawings(saved);check(nativeAPI.saveDrawings()===saved,'series reconnect document restores exact anchors');nativeAPI.editDrawing(id,{points:[{time:1700000120000,price:3200}]});nativeAPI.undo();check(nativeAPI.saveDrawings()===saved,'bound edit undo restores exact document');nativeAPI.redo();check(nativeModel.drawings.items[0].points[0].price===3200,'bound redo restores edited value');
  nativeComparisonDemo();return {passed:checks.length,checks,physicalDevice:false};
};

globalThis.nativeHoverExit=function(){nativeModel.crosshair=null;return true;};
