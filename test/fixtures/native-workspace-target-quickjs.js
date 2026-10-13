// Isolated target only: no source capture, host runtime swap, JNI/JSC or device API.
(function(){
 let checks=0;const scenarios=new Set();
 const ok=(value,label)=>{if(!value)throw Error(label);checks++;scenarios.add(label);};
 const throws=(fn,label)=>{let caught=false;try{fn();}catch{caught=true;}ok(caught,label);};
 const fields=['time','open','high','low','close','volume'],names=['ema','rsi','bollinger'];
 const binding={key:'fixture:native-target/1m',revision:'r1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'};
 const probe=globalThis.nativeWorkspaceTargetQuickjsProbe={models:[],stores:[],targets:[]};
 function source(length){
  const store=new Aster.BarStore([],{maxBars:4096,timeframeMs:60000,timeOrigin:123});store.setColumns(Aster.seededColumns(length,713));
  const model=new Aster.ChartModel({store,precision:7,axisWidth:93,panels:[{id:'price',weight:3,padding:.03},{id:'osc',weight:1,range:[0,100]}],axes:[{id:'left',panel:'price',side:'left',width:67,precision:4,prefix:'P:'}],theme:{background:'#112233'}}),api=new Aster.ChartAPI(model);
  for(const name of names)api.addIndicator(name,name,{});
  api.addSeries({id:'candles',type:'candles',panel:'price',width:1.75});
  api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',color:'#44ccaa'});
  api.addSeries({id:'rsi-line',type:'line',panel:'osc',indicator:'rsi'});
  const time=length?store.at(0).time:1700000000000;
  api.addDrawing({id:'anchor',type:'trendline',panel:'price',axisId:'left',points:[{time:time-60000.25,price:97.125},{time:time+90000.75,price:103.875}],style:{color:'#ffcc88',width:1.75}});
  model.view={from:-40.125,to:length+80.875};model.follow=false;model.drawings.selected='anchor';model.crosshair={x:120,y:60};
  probe.models.push(model);probe.stores.push(store);return {model,store,api};
 }
 function spec(f){return {schema:'aster.native-workspace-target',version:1,document:Aster.saveWorkspace(f.api,binding),datasetBinding:{...binding},source:{length:f.store.length,maxBars:f.store.maxBars,timeframeMs:f.store.timeframeMs,timeOrigin:f.store.timeOrigin,version:f.store.version,timeVersion:f.store.timeVersion},size:{width:900,height:600},retainedBytes:123456,maxBytes:805306368};}
 function target(metadata){const p=new Aster.NativeWorkspacePrepared(Aster.safeCheckpointStringify(metadata));probe.targets.push(p);return p;}
 function copy(p,columns){let independent=true;for(let slot=0;slot<6;slot++)for(let offset=0;offset<p.length;offset+=71){const count=Math.min(71,p.length-offset),view=p.target(slot,offset,count);independent=independent&&view instanceof Float64Array&&view.length===count&&view.buffer!==columns[fields[slot]].buffer;view.set(columns[fields[slot]].subarray(offset,offset+count));}return independent;}
 function start(p){p.start();probe.stores.push(p.store);}
 function run(p,until){const phases=new Set([p.phase]);let bounded=true;for(let i=0;i<2000;i++){if(until&&p.phase===until)return {phases,bounded};const r=p.step(127);phases.add(r.phase);bounded=bounded&&typeof r.complete==='boolean'&&Number.isFinite(r.done)&&Number.isFinite(r.total)&&r.done>=0&&r.done<=r.total;if(r.complete){if(until)throw Error('target phase missing: '+until);return {phases,bounded};}}throw Error('target failed to terminate');}
 function released(p){return p.closed&&p.model===null&&p.store===null&&Object.keys(p.columns).length===0&&p.workspaceEntries.length===0&&p.workspaceEntryMap===null&&p.workspaceColumnRefs.length===0&&p.checkpointBudget.usedBytes===0;}
 function accounting(p,model,label){let bytes=0,valid=model.indicators.entries instanceof Aster.NativeCheckpointEntries;for(const entry of model.indicators.entries.values()){const map=entry.checkpoints,keys=[...map.keys()],count=model.store.length?Math.floor(model.store.length/256)+1:0;valid=valid&&map instanceof Aster.NativeCheckpointMap&&keys.length===count&&keys.every((k,i)=>k===i*256)&&map.validateHistory(model.store.length)===map;for(const [,state] of map)valid=valid&&Aster.safeCheckpointStringify(state).length*2<=262144;bytes+=map.encodedBytes;}ok(valid&&bytes===p.checkpointBudget.usedBytes&&bytes<=33554432&&p.checkpointBudget.maxBytes===33554432,label+' bounded checkpoints');}
 function parity(p,model,label){const store=new Aster.BarStore();store.setColumns(model.store.columns,model.store.length);probe.stores.push(store);const oracle=new Aster.IndicatorEngine(store);try{for(const name of names){const actual=model.indicators.get(name),expected=oracle.add(name,name,{});for(const key of Object.keys(expected.outputs)){const a=actual.outputs[key],b=expected.outputs[key];ok(a.length===b.length&&a.every((v,i)=>Object.is(v,b[i])),label+' '+name+'/'+key);}}}finally{oracle.dispose();}accounting(p,model,label);}
 const f=source(513);probe.sourceModel=f.model;probe.sourceStore=f.store;
 const metadata=spec(f),saved=metadata.document,sourceColumns=f.store.columns,sourceVersion=f.store.version,sourceTimeVersion=f.store.timeVersion,sourceListeners=[...f.store.listeners];
 const sourceValues=Object.fromEntries(fields.map(k=>[k,[...f.store.columns[k]]]));
 const p=target(metadata);ok(p instanceof Aster.PreparedData&&p.phase==='capture','isolated target admission');
 ok(p.plan.outputs===5&&p.plan.outputBytes===1024*5*8&&p.plan.checkpointBytes===33554432&&p.plan.retainedBytes===123456&&p.plan.totalBytes<=p.plan.maxBytes&&Object.isFrozen(p.plan),'bounded logical admission');
 ok(copy(p,f.store.columns),'copied source buffers');start(p);const progress=run(p);
 ok(progress.bounded&&['validate','store-index','calculate','indices','workspace-checkpoints','workspace-ready'].every(phase=>progress.phases.has(phase)),'bounded target progress');
 const result=p.finish(),model=result.model,store=model.store,api=new Aster.ChartAPI(model);probe.models.push(model);probe.targetModel=model;probe.targetStore=store;
 ok(Aster.saveWorkspace(api,binding)===saved,'canonical restored configuration');
 ok(model.precision===7&&model.axisWidth===93&&model.theme.background==='#112233'&&model.panels.length===2&&model.axes[0].id==='left'&&model.series.length===3,'saved chart configuration');
 ok(model.view.from===-40.125&&model.view.to===593.875&&model.follow===false,'fractional offscreen view');
 ok(Aster.safeCheckpointStringify(model.drawings.items)===Aster.safeCheckpointStringify(f.model.drawings.items)&&model.drawings.items[0].points[0].time===1699999939999.75,'fractional bound drawing anchors');
 ok(model.drawings.selected===null&&model.drawings.undoStack.length===0&&model.drawings.redoStack.length===0&&model.drawings.transaction===null&&model.crosshair===null,'transient UI reset');
 ok(result.size.width===900&&result.size.height===600&&result.plan===p.plan&&store.maxBars===4096&&store.timeframeMs===60000&&store.timeOrigin===123&&store.version===sourceVersion+1&&store.timeVersion===sourceTimeVersion+1,'restored source metadata');
 ok(store!==f.store&&fields.every(k=>store.columns[k].buffer!==sourceColumns[k].buffer&&store.columns[k].every((v,i)=>Object.is(v,sourceValues[k][i]))),'owned source columns');
 ok(f.store.columns===sourceColumns&&f.store.version===sourceVersion&&f.store.timeVersion===sourceTimeVersion&&sourceListeners.length===f.store.listeners.size&&sourceListeners.every(listener=>f.store.listeners.has(listener))&&Aster.saveWorkspace(f.api,binding)===saved,'source remains unchanged');
 ok(p.transferred&&p.model===null&&p.store===null&&Object.keys(p.columns).length===0&&p.workspaceEntries.length===0&&p.workspaceEntryMap===null&&p.workspaceColumnRefs.length===0&&p.workspace===null&&p.workspaceText===null,'finish drops wrapper references');
 throws(()=>p.finish(),'single finish ownership');const liveBytes=p.checkpointBudget.usedBytes;p.dispose();p.dispose();
 ok(model.disposed!==true&&store.listeners.size===2&&liveBytes>0&&p.checkpointBudget.usedBytes===liveBytes,'wrapper dispose preserves returned model');
 parity(p,model,'initial');
 const capturedVolume=store.at(2).volume,changed=f.store.at(2);f.store.update(2,{...changed,volume:changed.volume+7});f.api.setTheme({background:'#223344'});
 ok(store.at(2).volume===capturedVolume&&model.theme.background==='#112233'&&Aster.saveWorkspace(api,binding)===saved,'source changes stay independent');
 let row=store.at(store.length-1);store.update(store.length-1,{...row,close:row.high,volume:row.volume+1});parity(p,model,'update');
 row=store.at(store.length-1);store.append({...row,time:row.time+60000});parity(p,model,'append');
 row=store.at(5);store.update(5,{...row,close:row.low,volume:row.volume+11});parity(p,model,'correction');
 ok(f.store.length===513&&f.store.at(5).close===sourceValues.close[5]&&f.store.at(512).close===sourceValues.close[512]&&f.store.listeners.size===sourceListeners.length,'target changes stay independent');
 const map=model.indicators.entries.get('ema').checkpoints,retiredBytes=map.encodedBytes,beforeRemove=p.checkpointBudget.usedBytes,held=model.indicators.get('ema').outputs.value,heldValues=[...held];api.removeIndicator('ema');
 ok(p.checkpointBudget.usedBytes===beforeRemove-retiredBytes&&held.every((v,i)=>Object.is(v,heldValues[i])),'indicator retirement preserves held outputs');throws(()=>map.get(0),'retired checkpoint access rejected');
 model.dispose();ok(p.checkpointBudget.usedBytes===0&&store.listeners.size===0,'returned model cleanup');
 throws(()=>new Aster.NativeWorkspacePrepared('{bad'),'malformed target metadata');
 throws(()=>target({...metadata,datasetBinding:{...binding,revision:'wrong'}}),'target binding mismatch');
 const badDocument=Aster.safeCheckpointParse(saved);badDocument.indicators[0].outputs=['wrong'];
 throws(()=>target({...metadata,document:Aster.safeCheckpointStringify(badDocument)}),'target output schema mismatch');
 throws(()=>target({...metadata,maxBytes:p.plan.totalBytes-1}),'combined admission limit');
 const partial=target(metadata);partial.target(0,0,7).set(f.store.columns.time.subarray(0,7));throws(()=>partial.start(),'partial transfer rejected');partial.dispose();
 ok(released(partial),'partial transfer cleanup');
 const malformed=target(metadata);copy(malformed,f.store.columns);malformed.columns.close[2]=NaN;start(malformed);const malformedStore=malformed.store;throws(()=>run(malformed),'malformed copied column rejected');
 ok(released(malformed)&&malformedStore.listeners.size===0,'malformed copied column cleanup');
 const cancelled=target(metadata);copy(cancelled,f.store.columns);start(cancelled);run(cancelled,'workspace-checkpoints');const cancelledModel=cancelled.model,cancelledStore=cancelled.store,cancelledMap=cancelledModel.indicators.entries.get('ema').checkpoints;probe.models.push(cancelledModel);
 ok(cancelled.checkpointBudget.usedBytes>0,'partial calculation owns checkpoints');cancelled.dispose();cancelled.dispose();
 ok(released(cancelled)&&cancelledModel.disposed===true&&cancelledStore.listeners.size===0,'partial calculation cleanup');throws(()=>cancelledMap.get(0),'cancelled checkpoint access rejected');
 const stale=target(metadata);copy(stale,f.store.columns);start(stale);run(stale);const staleModel=stale.model,staleStore=stale.store;probe.models.push(staleModel);new Aster.ChartAPI(staleModel).setTheme({grid:'#334455'});
 throws(()=>stale.finish(),'ready mutation rejected');ok(released(stale)&&staleModel.disposed===true&&staleStore.listeners.size===0,'ready mutation cleanup');
 const empty=source(0),emptyMetadata=spec(empty),emptyTarget=target(emptyMetadata);start(emptyTarget);run(emptyTarget);const emptyModel=emptyTarget.finish().model;probe.models.push(emptyModel);
 ok(emptyModel.store.length===0&&Aster.saveWorkspace(new Aster.ChartAPI(emptyModel),binding)===emptyMetadata.document&&names.every(name=>Object.values(emptyModel.indicators.get(name).outputs).every(values=>values.length===0)),'empty target configuration');
 accounting(emptyTarget,emptyModel,'empty');emptyTarget.dispose();ok(emptyModel.disposed!==true&&emptyTarget.checkpointBudget.usedBytes===0,'empty target ownership');emptyModel.dispose();empty.model.dispose();
 ok(emptyModel.store.listeners.size===0&&empty.store.listeners.size===0,'empty target cleanup');
 ok(f.model.disposed!==true&&f.store.listeners.size===sourceListeners.length,'failed targets preserve source');f.model.dispose();
 ok(probe.stores.every(s=>s.listeners.size===0)&&probe.models.every(m=>m.disposed===true)&&probe.targets.every(t=>t.checkpointBudget.usedBytes===0),'all source and target listeners released');
 return JSON.stringify({case:'native-workspace-target-quickjs',passed:true,checks,scenarios:[...scenarios],scope:'isolated target in standalone Linux QuickJS; no source capture, host runtime swap, SDK restore, JNI/JSC or device'});
})()
