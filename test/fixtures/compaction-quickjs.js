// Runs unchanged in a bare Node VM and the standalone Linux QuickJS host.
(function(){
 const scenarios=[],assert=(value,message)=>{if(!value)throw Error(message);};
 const scenario=(label,run)=>{assert(!scenarios.includes(label),'Duplicate scenario');run();scenarios.push(label);};
 const rejects=(run,check)=>{let caught=false,error;try{run();}catch(e){caught=true;error=e;}assert(caught&&check(error),'Unexpected rejection: '+error);return error;};
 const sameValues=(a,b)=>a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
 const fields=['time','open','high','low','close','volume'],options=keepLastBars=>({keepLastBars,studyHistory:'restart'});
 const rows=(length=65)=>Array.from({length},(_,i)=>{const close=(i%7-3)*.125;return {time:(i-45)*60000,open:close-.125,high:close+1,low:close-1,close,volume:i+.5};});
 const probe=globalThis.compactionQuickjsProbe={models:[],stores:[],engines:[],budgets:[],held:[],subscriptions:[],sessions:[],native:null,custom:null,ledger:null,owners:null,noop:null,ingestion:null,views:[],atomic:null,reentry:null,invalidation:null};
 function remember(model){probe.models.push(model);probe.stores.push(model.store);return model;}
 function owner(data=rows()){const model=remember(new Aster.ChartModel());model.store.setData(data);let notifications=0;return {model,api:new Aster.ChartAPI(model,{invalidate:()=>notifications++}),notifications:()=>notifications};}
 function observe(store,callback){const row={store,active:true,stop:null},unsubscribe=store.subscribe(callback);row.stop=()=>{if(row.active){unsubscribe();row.active=false;}};probe.subscriptions.push(row);return row.stop;}
 const cleanObservers=store=>assert(store.listenerErrors.length===0,'Observer assertion was swallowed');
 function hold(array){const row={array,copy:Array.from(array)};probe.held.push(row);return row;}
 const heldUnchanged=row=>assert(sameValues(row.array,row.copy),'Held output or source changed');
 function exactSource(store,expected){assert(store.length===expected.length,'Suffix length');for(const field of fields)for(let i=0;i<expected.length;i++)assert(Object.is(store.columns[field][i],expected[i][field]),'Suffix differs at '+field+'/'+i);}
 function snapshot(model){return {columns:model.store.columns,index:model.store.index,length:model.store.length,capacity:model.store.capacity,version:model.store.version,timeVersion:model.store.timeVersion,view:model.view,follow:model.follow,crosshair:model.crosshair,entries:model.indicators.entries,series:model.series};}
 function unchanged(model,before){const after=snapshot(model);for(const key of Object.keys(before))assert(Object.is(after[key],before[key]),'Rejected/no-op compaction changed '+key);}
 function resetEntry(entry,length){assert(entry.arrays.length===0&&entry.checkpoints.size===0&&entry.dirty===0&&entry.dirtyTo===length&&entry.invalidated===true&&entry.length===0&&entry.computedFrom===0&&entry.computedUntil===0&&entry.preparedVersion===undefined,'Study was not completely retired');}

 scenario('native command retains exact six-column suffix and publishes one committed event',()=>{
  const data=rows();data[45]={time:-0,open:-0,high:-0,low:-0,close:-0,volume:-0};nativeInit(0,{series:[]});nativeCommand('setData',[data]);
  const model=remember(nativeModel),store=model.store,before=snapshot(model),oldColumns=fields.map(field=>hold(store.columns[field]));let events=0,invalidations=0;
  assert(model instanceof Aster.ChartModel&&nativeAPI instanceof Aster.ChartAPI,'Native bundle ownership');
  nativeAPI.invalidate=()=>{assert(events===1,'Invalidation preceded publication');invalidations++;};
  const stop=observe(store,event=>{events++;assert(JSON.stringify(Object.keys(event).sort())===JSON.stringify(['from','kind','removed','studyHistory','version']),'Unexpected compact event shape');assert(event.kind==='compact'&&event.from===0&&event.removed===45&&event.studyHistory==='restart'&&event.version===before.version+1,'Wrong compact event');assert(store===model.store&&store.version===before.version+1&&store.timeVersion===before.timeVersion+1&&store.capacity===32,'Observer saw uncommitted source');exactSource(store,data.slice(-20));});
  const receipt=nativeCommand('compactData',[{...options(20),maxPeakStoreBytes:15360}]);stop();cleanObservers(store);
  assert(events===1&&invalidations===1,'Wrong native publication count');assert(model.store===store&&store.columns!==before.columns&&store.index!==before.index,'Compaction replaced store or retained old source/index');
  assert(JSON.stringify(Object.keys(receipt).sort())===JSON.stringify(['bytes','capacity','firstRetainedTime','invalidationFailed','length','peakSourceBytes','previousBytes','removed','studyHistory','timeVersion','version']),'Unexpected receipt shape');
  assert(receipt.removed===45&&receipt.length===20&&receipt.capacity===32&&receipt.bytes===3072&&receipt.previousBytes===12288&&receipt.peakSourceBytes===15360&&Object.is(receipt.firstRetainedTime,-0)&&receipt.version===before.version+1&&receipt.timeVersion===before.timeVersion+1&&receipt.studyHistory==='restart'&&receipt.invalidationFailed===false,'Wrong native receipt');
  exactSource(store,data.slice(-20));for(const row of oldColumns)heldUnchanged(row);
  rejects(()=>nativeCommand('compactData',[options(10),{}]),e=>e instanceof TypeError);assert(store.length===20&&events===1&&invalidations===1,'Arity rejection mutated source');
  probe.native={receipt,events,invalidations,fields:fields.slice(),negativeZero:fields.every(field=>Object.is(store.columns[field][0],-0)),sameStore:model.store===store};
 });
 scenario('dirty visible hidden and unbound custom studies retire without callbacks or held-output writes',()=>{
  const f=owner(),{model,api}=f,calls={factory:0,get:0,create:0,step:0,snapshot:0,restore:0,validate:0},failure=new Error('Dirty compact calculation');let armed=false;
  const hit=key=>{calls[key]++;if(armed)throw failure;};model.indicators.checkpointSize=4;
  const definitions=Aster.defineIndicatorModule({id:'test.compaction-quickjs',version:1,stateVersion:1,indicators:{value:{causal:true,validateCheckpoint(params,state){hit('validate');return state===0;},factory(){hit('factory');return {outputs:['value'],create(){hit('create');return {step(bar){hit('step');return [bar.close];},snapshot(){hit('snapshot');return 0;},restore(){hit('restore');}};}};}}}}),name=definitions[0].name,budget=new Aster.NativeCheckpointBudget();probe.budgets.push(budget);
  model.indicators.register(name,definitions[0].factory);
  for(const id of ['visible','hidden','unbound']){api.addIndicator(id,name);const entry=model.indicators.entries.get(id),map=new Aster.NativeCheckpointMap(name,{}, {budget,block:4});for(const [index,state] of entry.checkpoints)map.set(index,state);entry.checkpoints=map;}
  model.indicators.entries=new Aster.NativeCheckpointEntries(model.indicators.entries);assert(calls.validate>0&&budget.usedBytes>0,'Custom checkpoint validator fixture did not run');
  for(const id of ['visible','hidden'])api.addSeries({id,type:'line',panel:'price',indicator:id,visible:id==='visible'});
  const entries=[...model.indicators.entries.values()],held=entries.map(entry=>hold(entry.arrays[0])),maps=entries.map(entry=>entry.checkpoints),revisions=entries.map(entry=>entry.revision);
  for(const series of model.series){model.seriesData(series);assert(series.rangeIndex!==null,'Custom range fixture');}
  model.store.update(0,{...model.store.at(0),volume:1});armed=true;for(const key of Object.keys(calls))calls[key]=0;
  const get=model.indicators.get;model.indicators.get=function(...args){calls.get++;return get.apply(this,args);};const notifications=f.notifications();
  api.compactData(options(17));assert(Object.values(calls).every(n=>n===0)&&budget.usedBytes===0,'Compaction invoked study callback or retained checkpoint bytes');
  entries.forEach((entry,i)=>{assert(model.indicators.entries.get(['visible','hidden','unbound'][i])===entry&&entry.checkpoints===maps[i]&&entry.revision===revisions[i],'Compaction replaced study ownership');resetEntry(entry,17);});
  for(const series of model.series)assert(series.rangeIndex===null&&series.revision===undefined&&series.dirtyFrom===0,'Series cache not retired');
  assert(f.notifications()===notifications+1,'Custom compaction notification');for(const row of held)heldUnchanged(row);
  const afterCompaction={...calls};rejects(()=>api.indicatorValues('visible','value'),e=>e===failure);assert(calls.get===1&&calls.create===1&&Object.entries(calls).every(([key,n])=>['get','create'].includes(key)||n===0),'Explicit query failure boundary');for(const row of held)heldUnchanged(row);
  probe.custom={calls,afterCompaction,studies:entries.length,boundSeries:model.series.length,checkpointBytesAfterCompact:budget.usedBytes,explicitErrorPreserved:true};
 });
 scenario('native checkpoint maps release ledger bytes and remain reusable for fresh suffix studies',()=>{
  const data=rows(),f=owner(data),{model,api}=f,engine=model.indicators,budget=new Aster.NativeCheckpointBudget();probe.budgets.push(budget);engine.checkpointSize=4;
  for(const id of ['target','unbound']){api.addIndicator(id,'ema',{period:3});const entry=engine.entries.get(id),map=new Aster.NativeCheckpointMap('ema',{period:3},{budget,block:4});for(const [index,state] of entry.checkpoints)map.set(index,state);entry.checkpoints=map;}
  engine.entries=new Aster.NativeCheckpointEntries(engine.entries);api.addSeries({id:'line',type:'line',panel:'price',indicator:'target',visible:false});model.seriesData(model.series[0]);
  const entries=engine.entries,maps=[...entries.values()].map(entry=>entry.checkpoints),held=[...entries.values()].map(entry=>hold(entry.arrays[0])),before=budget.usedBytes;
  assert(before>0&&before===maps.reduce((sum,map)=>sum+map.encodedBytes,0),'Native fixture not charged');api.compactData(options(17));
  assert(engine.entries===entries&&budget.usedBytes===0&&maps.every(map=>map.size===0&&map.encodedBytes===0),'Native checkpoint ledger not reset');for(const entry of entries.values())resetEntry(entry,17);
  const fresh=owner(data.slice(-17));fresh.api.addIndicator('fresh','ema',{period:3});const expected=fresh.model.indicators.get('fresh').outputs.value;
  for(const [i,id] of ['target','unbound'].entries()){assert(engine.entries.get(id).checkpoints===maps[i],'Native checkpoint map replaced');assert(sameValues(engine.get(id).outputs.value,expected),'Restart differs from fresh suffix');maps[i].validateHistory(17);assert(maps[i].size===5&&maps[i].encodedBytes>0,'Native map not reused');}
  assert(budget.usedBytes>0&&budget.usedBytes===maps.reduce((sum,map)=>sum+map.encodedBytes,0),'Reused ledger charge');for(const row of held)heldUnchanged(row);
  probe.ledger={before,afterCompact:0,afterReuse:budget.usedBytes,mapCount:maps.length,recordCounts:maps.map(map=>map.size),afterDispose:null};
 });
 scenario('shared model and standalone engine ownership reject atomically until disposed',()=>{
  const f=owner(),{model,api}=f,peer=remember(new Aster.ChartModel({store:model.store}));let events=0;const stop=observe(model.store,()=>events++),before=snapshot(model);
  rejects(()=>api.compactData(options(17)),e=>/exclusive/.test(e.message));unchanged(model,before);assert(events===0&&f.notifications()===0,'Shared model rejection published');peer.dispose();
  const engine=new Aster.IndicatorEngine(model.store);probe.engines.push(engine);rejects(()=>api.compactData(options(17)),e=>/exclusive/.test(e.message));unchanged(model,before);assert(events===0&&f.notifications()===0,'Standalone engine rejection published');engine.dispose();
  const receipt=api.compactData(options(17));stop();cleanObservers(model.store);assert(receipt.removed===48&&events===1&&f.notifications()===1,'Disposed owner continued blocking');probe.owners={rejections:2,removed:receipt.removed,events,notifications:f.notifications()};
 });
 scenario('no-op permits shared owners and implicit percent without source cache or view changes',()=>{
  const f=owner(),{model,api}=f;api.addIndicator('ema','ema',{period:3});api.addSeries({id:'line',type:'line',panel:'price',indicator:'ema'});model.seriesData(model.series[0]);model.setPanel('price',{scale:'percent'});model.crosshair={x:10,y:20};
  remember(new Aster.ChartModel({store:model.store}));const before=snapshot(model),entry=model.indicators.entries.get('ema'),arrays=entry.arrays,checkpoints=JSON.stringify([...entry.checkpoints]),range=model.series[0].rangeIndex,revision=entry.revision,notifications=f.notifications();let events=0;const stop=observe(model.store,()=>events++);
  for(const keep of [65,100]){const receipt=api.compactData({...options(keep),maxPeakStoreBytes:0});unchanged(model,before);assert(receipt.removed===0&&receipt.length===65&&receipt.capacity===128&&receipt.bytes===12288&&receipt.previousBytes===12288&&receipt.peakSourceBytes===12288&&receipt.version===before.version&&receipt.timeVersion===before.timeVersion&&receipt.invalidationFailed===false,'No-op receipt');assert(entry.arrays===arrays&&entry.revision===revision&&JSON.stringify([...entry.checkpoints])===checkpoints&&model.series[0].rangeIndex===range,'No-op changed caches');}
  stop();cleanObservers(model.store);assert(events===0&&f.notifications()===notifications,'No-op published or invalidated');probe.noop={checks:2,events,invalidations:f.notifications()-notifications,sourceUnchanged:true,cacheUnchanged:true,crosshairRetained:model.crosshair===before.crosshair};
 });
 scenario('paused empty ingestion preserves policy cursor counters and resumes against compacted source',()=>{
  const f=owner(),{model,api}=f;api.configureDataIngestion({streamId:'compact-stream',generation:3,firstSequence:10,maxBatchEvents:4,maxQueuedEvents:8});const session=model.dataIngestion;probe.sessions.push(session);
  const packet=sequence=>({streamId:'compact-stream',generation:3,firstSequence:sequence,events:[{kind:'append',bar:{...model.store.at(model.store.length-1),time:model.store.at(model.store.length-1).time+60000}}]});
  api.enqueueDataEvents(packet(10));api.pauseDataIngestion();const pending=api.saveDataIngestion(),beforePending=snapshot(model);rejects(()=>api.compactData(options(17)),e=>/paused empty idle/.test(e.message));unchanged(model,beforePending);assert(api.saveDataIngestion()===pending,'Pending rejection lost ingestion ledger');
  api.resumeDataIngestion();assert(api.drainDataEvents().events===1,'Ingestion fixture did not drain');api.pauseDataIngestion();const release=session.acquireLease(),leased=snapshot(model);rejects(()=>api.compactData(options(17)),e=>/lease|idle|busy/i.test(e.message));unchanged(model,leased);release();
  const saved=api.saveDataIngestion(),policy=session.policy,counters=JSON.stringify(session.counters),epoch=session.epoch,notifications=f.notifications();let events=0;
  const stop=observe(model.store,event=>{if(event.kind!=='compact')return;events++;assert(session.paused===true&&session.sourceVersion===model.store.version&&session.epoch===epoch+1,'Observer saw stale ingestion binding');assert(api.saveDataIngestion()===saved,'Observer saw changed ingestion ledger');});
  api.compactData(options(17));stop();cleanObservers(model.store);assert(model.dataIngestion===session&&session.policy===policy&&JSON.stringify(session.counters)===counters&&api.saveDataIngestion()===saved&&session.paused===true&&session.sourceVersion===model.store.version&&session.epoch===epoch+1,'Compaction changed ingestion ledger');assert(events===1&&f.notifications()===notifications+1,'Ingestion compaction publication');
  api.resumeDataIngestion();api.enqueueDataEvents(packet(11));assert(api.drainDataEvents().events===1,'Resume did not use retained source');const stats=api.dataIngestionStats();assert(stats.nextSequence===12&&stats.accepted===2&&stats.applied===2&&stats.cancelled===0&&stats.pendingEvents===0&&stats.state==='running'&&model.store.length===18,'Resumed ingestion accounting');
  probe.ingestion={rejections:2,events,epochAdvance:1,savedUnchanged:true,policyUnchanged:true,nextSequence:stats.nextSequence,accepted:stats.accepted,applied:stats.applied,cancelled:stats.cancelled,pendingEvents:stats.pendingEvents,length:model.store.length};
 });
 scenario('follow and manual views preserve drawing anchors selection and undo redo documents',()=>{
  for(const follow of [true,false]){const f=owner(rows(100)),{model,api}=f;api.addSeries({id:'forward',type:'line',panel:'price',offset:5});api.addSeries({id:'hidden-forward',type:'line',panel:'price',offset:100,visible:false});
   api.addDrawing({id:'anchor',type:'trendline',panel:'price',points:[{time:model.store.at(2).time,price:-.25},{time:model.store.at(95).time,price:.75}]});api.editDrawing('anchor',{style:{color:'red',width:2}});api.undo();api.selectDrawing('anchor');
   const drawings=model.drawings,items=drawings.items,undo=drawings.undoStack,redo=drawings.redoStack,doc=api.saveDrawings(),history=JSON.stringify([undo,redo]),selected=drawings.selected;assert(undo.length>0&&redo.length>0,'Drawing history fixture');
   model.view={from:80,to:95};model.follow=follow;model.crosshair={x:12,y:30};api.compactData(options(30));const expected=follow?{from:19.5,to:34.5}:{from:10,to:25};assert(model.view.from===expected.from&&model.view.to===expected.to&&model.follow===follow&&model.crosshair===null,'Compaction view/follow policy');
   assert(model.drawings===drawings&&drawings.items===items&&drawings.undoStack===undo&&drawings.redoStack===redo&&drawings.selected===selected&&api.saveDrawings()===doc&&JSON.stringify([undo,redo])===history,'Drawing state changed');assert(items[0].points[0].time<model.store.at(0).time,'Evicted drawing anchor was dropped');
   let clamped=null;if(!follow){api.compactData(options(10));clamped={...model.view};assert(clamped.from===-.5&&clamped.to===14.5&&model.follow===false&&api.saveDrawings()===doc&&JSON.stringify([undo,redo])===history&&drawings.selected===selected,'Manual clamping changed drawings or follow');}
   probe.views.push({follow,from:expected.from,to:expected.to,clamped,historyPreserved:true,selection:selected,evictedAnchorPreserved:true});
  }
 });
 scenario('validation and exact peak-budget rejection preserve source caches and notifications',()=>{
  const f=owner(),{model,api}=f;api.addIndicator('ema','ema',{period:3});api.addSeries({id:'line',type:'line',panel:'price',indicator:'ema'});model.seriesData(model.series[0]);
  const before=snapshot(model),entry=model.indicators.entries.get('ema'),arrays=entry.arrays,range=model.series[0].rangeIndex,checkpoints=JSON.stringify([...entry.checkpoints]),notifications=f.notifications();let reads=0,events=0;const stop=observe(model.store,()=>events++);
  const attempts=[()=>api.compactData({keepLastBars:17}),()=>api.compactData({...options(17),extra:true}),()=>api.compactData({get keepLastBars(){reads++;return 17;},studyHistory:'restart'}),()=>api.compactData({...options(17),maxPeakStoreBytes:15359})];
  for(const attempt of attempts){rejects(attempt,e=>e instanceof TypeError||e instanceof RangeError);unchanged(model,before);assert(entry.arrays===arrays&&entry.checkpoints.size>0&&JSON.stringify([...entry.checkpoints])===checkpoints&&model.series[0].rangeIndex===range&&f.notifications()===notifications&&events===0,'Rejected compaction changed cache or notification');}
  assert(reads===0,'Option accessor ran');const receipt=api.compactData({...options(17),maxPeakStoreBytes:15360});stop();cleanObservers(model.store);assert(receipt.peakSourceBytes===15360&&events===1&&f.notifications()===notifications+1,'Exact peak budget rejected');probe.atomic={rejections:attempts.length,reads,events,peakSourceBytes:receipt.peakSourceBytes};
 });
 scenario('reentrant observer sees retired caches and outer receipt retains its own commit',()=>{
  const f=owner(),{model,api}=f;api.addIndicator('ema','ema',{period:3});api.addSeries({id:'line',type:'line',panel:'price',indicator:'ema'});model.seriesData(model.series[0]);const version=model.store.version,notifications=f.notifications();let events=0,inner=null;const versions=[];
  const stop=observe(model.store,event=>{if(event.kind!=='compact')return;events++;versions.push(event.version);resetEntry(model.indicators.entries.get('ema'),model.store.length);assert(model.series[0].rangeIndex===null,'Observer saw old series index');assert(model.indicators.get('ema').outputs.value.length===model.store.length,'Observer could not explicitly recalculate');if(events===1){const last=model.store.at(model.store.length-1);model.store.append({...last,time:last.time+60000});inner=api.compactData(options(8));}});
  const outer=api.compactData(options(17));stop();cleanObservers(model.store);assert(events===2&&f.notifications()===notifications+2&&outer.length===17&&outer.removed===48&&outer.version===version+1&&outer.capacity===32&&inner.length===8&&inner.removed===10&&inner.version===version+3&&model.store.length===8&&model.store.version===version+3,'Reentrant commit/receipt mismatch');
  probe.reentry={events,invalidations:f.notifications()-notifications,outerLength:outer.length,outerRemoved:outer.removed,innerLength:inner.length,innerRemoved:inner.removed,versionDeltas:versions.map(value=>value-version),finalLength:model.store.length,listenerErrors:model.store.listenerErrors.length};
 });
 scenario('postcommit invalidation failure returns a successful diagnostic receipt',()=>{
  const {model,api}=owner();let events=0,invalidations=0;const stop=observe(model.store,event=>{assert(event.kind==='compact'&&model.store.length===17,'Invalidation observer saw incomplete commit');events++;});api.invalidate=()=>{invalidations++;throw new Error('Host invalidation failed');};
  const receipt=api.compactData(options(17));stop();cleanObservers(model.store);assert(receipt.invalidationFailed===true&&receipt.length===17&&receipt.removed===48&&model.store.length===17&&events===1&&invalidations===1,'Invalidation converted commit into failure');assert(Object.values(receipt).every(value=>!(value instanceof Error)),'Receipt retained Error');probe.invalidation={events,invalidations,invalidationFailed:receipt.invalidationFailed,length:receipt.length};
 });
 scenario('all models engines subscriptions ingestion rings and checkpoint ledgers are released',()=>{
  for(const row of probe.subscriptions){assert(row.active===false,'External observer leaked before teardown');row.stop();}
  for(const engine of probe.engines){engine.dispose();engine.dispose();}for(const model of probe.models){model.dispose();model.dispose();}
  assert(probe.models.every(model=>model.disposed&&model.indicators.entries.size===0&&model.dataIngestion===null&&model.series.every(series=>series.rangeIndex===null)),'Disposed model retained entries ingestion or range indexes');
  assert(probe.engines.every(engine=>engine.entries.size===0),'Standalone engine retained entries');assert(probe.stores.every(store=>store.listeners.size===0&&store.listenerErrors.length===0),'Source retained listeners or swallowed observer errors');assert(probe.budgets.every(budget=>budget.usedBytes===0),'Disposed checkpoint ledger retained bytes');
  assert(probe.sessions.every(session=>session.closed&&session.count===0&&session.kinds===null&&Object.keys(session.columns).length===0&&session.model===null&&session.store===null),'Disposed ingestion ring retained data');probe.ledger.afterDispose=probe.budgets.reduce((sum,budget)=>sum+budget.usedBytes,0);for(const row of probe.held)heldUnchanged(row);
 });
 return JSON.stringify({case:'compaction-quickjs',passed:true,checks:scenarios.length,scenarios,scope:'bundled ChartAPI.compactData and nativeCommand in standalone QuickJS/Node VM; no Android JNI, Apple JSC, native SDK, browser or device proof'});
})()
