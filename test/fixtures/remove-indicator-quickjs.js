// Runs unchanged in a bare Node VM and the standalone Linux QuickJS host.
(function(){
 const scenarios=[],assert=(value,message)=>{if(!value)throw Error(message);};
 const scenario=(label,run)=>{assert(!scenarios.includes(label),'Duplicate scenario');run();scenarios.push(label);};
 const rejects=(run,name)=>{let error;try{run();}catch(e){error=e;}assert(error!==undefined&&error.name===name,'Unexpected rejection: '+error);return error;};
 const sameValues=(a,b)=>a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
 const rows=()=>Array.from({length:8},(_,time)=>({time,open:1,high:9,low:0,close:1,volume:1}));
 const probe=globalThis.removeIndicatorQuickjsProbe={models:[],stores:[],budgets:[],callbacks:[],reentries:[],held:[],ledger:null};
 function remember(model){probe.models.push(model);if(!probe.stores.includes(model.store))probe.stores.push(model.store);return model;}
 function owner(store){const model=remember(new Aster.ChartModel(store?{store}:{}));if(!store)model.store.setData(rows());return {model,api:new Aster.ChartAPI(model)};}
 function custom(f=owner()){
  const {model,api}=f,calls={create:0,step:0,snapshot:0,restore:0};let armed=false,notifications=0;
  const hit=key=>{calls[key]++;if(armed)throw Error('Removal calculated '+key);};probe.callbacks.push(calls);api.invalidate=()=>notifications++;
  model.indicators.register('removal-probe',()=>({outputs:['value'],create(){hit('create');return {step(bar){hit('step');return [bar.close];},snapshot(){hit('snapshot');return 0;},restore(){hit('restore');}};}}));
  api.addIndicator('target','removal-probe');api.addSeries({id:'line',type:'line',panel:'price',indicator:'target'});
  return {...f,calls,notifications:()=>notifications,arm(){model.store.update(0,{...model.store.at(0),close:9});armed=true;for(const key of Object.keys(calls))calls[key]=0;}};
 }
 const noCalls=f=>assert(Object.values(f.calls).every(n=>n===0),'Removal invoked an indicator callback');
 function hold(array){const row={array,copy:Array.from(array)};probe.held.push(row);return row;}
 const heldUnchanged=row=>assert(sameValues(row.array,row.copy),'Retired output changed');

 scenario('native command removes dirty throwing custom without calculation',()=>{
  nativeInit(0,{series:[]});nativeCommand('setData',[rows()]);const f=custom({model:remember(nativeModel),api:nativeAPI}),{model}=f;
  assert(model instanceof Aster.ChartModel&&nativeAPI instanceof Aster.ChartAPI,'Native bundle ownership');
  nativeCommand('addSeries',[{id:'keep-line',type:'line',panel:'price',source:'close'}]);
  const held=hold(nativeIndicatorBuffer('target','value',0,8)),entry=model.indicators.entries.get('target'),revision=entry.revision;
  f.arm();const version=model.store.version,notifications=f.notifications();
  assert(nativeCommand('removeIndicator',['target'])===null,'Native remove return');noCalls(f);heldUnchanged(held);
  assert(!model.indicators.entries.has('target')&&model.series.length===1&&model.series[0].id==='keep-line','Wrong target or series removed');
  assert(model.store.version===version&&entry.revision===revision&&f.notifications()===notifications+1,'Removal mutated data, calculated, or missed notification');
 });
 scenario('controller callback and method getter replacements survive stale removal',()=>{
  for(const phase of ['cancel callback','target callback','cancel getter','target getter']){
   const f=custom(),{model,api}=f,old=model.indicators.entries.get('target');let replacement,replaced=0,methodCalls=0;
   const replace=()=>{replaced++;replacement={...old};model.indicators.entries.set('target',replacement);};
   const cancel=phase.startsWith('cancel'),getter=phase.endsWith('getter'),method=cancel?'cancel':'setDrawingTarget';
   model.drawings.items.push({id:'drawing',seriesId:'line'});
   const controller={gesture:cancel?{id:'drawing'}:null,drawingTarget:{seriesId:'line'}};
   if(getter)Object.defineProperty(controller,method,{get(){replace();return ()=>methodCalls++;}});
   else controller[method]=()=>{methodCalls++;replace();};
   api.controller=controller;f.arm();const series=model.series,notifications=f.notifications();
   rejects(()=>api.removeIndicator('target'),'StaleSourceError');noCalls(f);
   assert(replaced===1&&methodCalls===(getter?0:1),'Wrong controller reentry boundary');
   assert(model.indicators.entries.get('target')===replacement&&replacement!==old&&model.series===series&&model.series.length===1,'Replacement entry or series lost');
   assert(f.notifications()===notifications,'Rejected removal notified');probe.reentries.push(phase);model.dispose();
  }
 });
 scenario('remove method getter preserves replacement before deletion',()=>{
  const f=custom(),{model,api}=f,engine=model.indicators,old=engine.entries.get('target'),replacement={...old};let accesses=0,called=0;
  Object.defineProperty(engine,'remove',{get(){accesses++;engine.entries.set('target',replacement);return ()=>called++;}});
  f.arm();const series=model.series,notifications=f.notifications();rejects(()=>api.removeIndicator('target'),'StaleSourceError');noCalls(f);
  assert(accesses===1&&called===0&&engine.entries.get('target')===replacement,'Remove getter erased replacement');
  assert(model.series===series&&model.series.length===1&&f.notifications()===notifications,'Remove getter committed partial deletion');model.dispose();
 });
 scenario('shared store stays live and held output survives owner disposal',()=>{
  const f=custom(),{model,api}=f,other=owner(model.store).model,held=hold(model.indicators.get('target').outputs.value);
  other.indicators.add('other','ema',{period:2});const listeners=model.store.listeners.size;assert(listeners===4,'Expected two model/engine subscriptions');
  f.arm();api.removeIndicator('target');noCalls(f);assert(model.store.listeners.size===listeners,'Removal detached shared subscriptions');heldUnchanged(held);
  model.dispose();assert(model.store.listeners.size===2,'Owner disposal detached another model');
  model.store.update(7,{...model.store.at(7),close:7});const oracle=owner(model.store).model;
  assert(sameValues(other.indicators.get('other').outputs.value,oracle.indicators.add('oracle','ema',{period:2}).outputs.value),'Remaining model differs from fresh calculation');
  heldUnchanged(held);oracle.dispose();other.dispose();assert(model.store.listeners.size===0,'Shared store subscriptions retained');
 });
 scenario('native checkpoint removal releases only target ledger without calculation',()=>{
  const {model,api}=owner(),engine=model.indicators,budget=new Aster.NativeCheckpointBudget();probe.budgets.push(budget);engine.checkpointSize=2;
  for(const id of ['target','keep']){
   api.addIndicator(id,'ema',{period:2});const entry=engine.entries.get(id),map=new Aster.NativeCheckpointMap('ema',{period:2},{budget,block:2});
   for(const [index,state] of entry.checkpoints)map.set(index,state);entry.checkpoints=map;
  }
  engine.entries=new Aster.NativeCheckpointEntries(engine.entries);
  const target=engine.entries.get('target'),keep=engine.entries.get('keep'),held=hold(engine.get('target').outputs.value),remaining=keep.checkpoints.encodedBytes,total=budget.usedBytes;
  assert(total>remaining&&remaining>0,'Native checkpoint fixture has no charged records');target.checkpoints.validateHistory(8);keep.checkpoints.validateHistory(8);
  model.store.update(0,{...model.store.at(0),close:9});let calls=0;target.def.create=()=>{calls++;throw Error('Native removal calculated');};
  api.removeIndicator('target');assert(calls===0&&!engine.entries.has('target')&&engine.entries.get('keep')===keep,'Native deletion calculated or removed sibling');
  assert(budget.usedBytes===remaining&&target.checkpoints.encodedBytes===0&&target.checkpoints.size===0,'Wrong checkpoint ledger release');
  rejects(()=>target.checkpoints.get(0),'Error');heldUnchanged(held);keep.checkpoints.validateHistory(8);
  model.dispose();assert(budget.usedBytes===0,'Disposal retained native checkpoint bytes');probe.ledger={before:total,remaining,after:budget.usedBytes,calls};
 });
 scenario('all models entries checkpoint bytes and source listeners are released',()=>{
  for(const model of probe.models){model.dispose();model.dispose();}
  assert(probe.models.every(model=>model.disposed&&model.indicators.entries.size===0),'Disposed model retained entries');
  assert(probe.stores.every(store=>store.listeners.size===0),'Disposed source retained listeners');
  assert(probe.budgets.every(budget=>budget.usedBytes===0),'Disposed checkpoint ledger retained bytes');
  for(const held of probe.held)heldUnchanged(held);
 });
 return JSON.stringify({case:'remove-indicator-quickjs',passed:true,checks:scenarios.length,scenarios,scope:'bundled ChartAPI.removeIndicator and nativeCommand in standalone QuickJS/Node VM; no Android JNI, Apple JSC or device proof'});
})()
