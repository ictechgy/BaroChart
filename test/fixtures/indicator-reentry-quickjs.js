// Runs unchanged in a bare Node VM and the standalone Linux QuickJS host.
// Borrowed outputs may contain writes made before a failure; no rollback claim.
(function(){
 const scenarios=[],assert=(value,message)=>{if(!value)throw Error(message);};
 const scenario=(label,run)=>{assert(!scenarios.includes(label),'Duplicate scenario');run();scenarios.push(label);};
 const rejects=(run,expected)=>{let error;try{run();}catch(e){error=e;}assert(error!==undefined,'Expected rejection');assert(typeof expected==='string'?error.name===expected:error===expected,'Unexpected rejection: '+error);return error;};
 const sameValues=(a,b)=>a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
 const rows=()=>Array.from({length:8},(_,time)=>({time,open:1,high:9,low:0,close:1,volume:1}));
 const probe=globalThis.indicatorReentryQuickjsProbe={models:[],engines:[],stores:[],budgets:[]};
 function owner(checkpointSize=2){const store=new Aster.BarStore(rows()),engine=new Aster.IndicatorEngine(store,{checkpointSize});probe.stores.push(store);probe.engines.push(engine);return {store,engine};}
 function bounded(engine,id){const entry=engine.entries.get(id),budget=new Aster.NativeCheckpointBudget(),map=new Aster.NativeCheckpointMap(entry.name,entry.params,{budget,block:2});for(const [index,state] of entry.checkpoints)map.set(index,state);entry.checkpoints=map;engine.entries=new Aster.NativeCheckpointEntries([[id,entry]]);probe.budgets.push(budget);return map;}
 function builtin(nativeRecords=false,name='sma',params={period:1},checkpointSize=2){const f=owner(checkpointSize);f.engine.add('s',name,params);if(nativeRecords)bounded(f.engine,'s');return f;}
 function custom(effect,f=owner()){
  let armed=false;f.engine.register('custom',()=>({outputs:['value'],create:()=>({step(bar,index){if(armed)effect({...f,index,disarm(){armed=false;}});return [bar.close];},snapshot:()=>({}),restore(){}})}));
  f.engine.add('c','custom');return {...f,arm(){f.store.update(0,{...f.store.at(0)});armed=true;}};
 }
 const change=(store,close)=>store.update(0,{...store.at(0),close});
 function capture(entry){return {arrays:entry.arrays,vectors:[...entry.arrays],values:entry.arrays.map(a=>Array.from(a)),checkpoints:entry.checkpoints,records:Aster.safeCheckpointStringify([...entry.checkpoints]),state:[entry.revision,entry.dirty,entry.dirtyTo,entry.invalidated,entry.length,entry.computedFrom,entry.computedUntil]};}
 function unchanged(entry,before){assert(entry.arrays===before.arrays&&entry.arrays.every((a,i)=>a===before.vectors[i]&&sameValues(a,before.values[i])),'Latest array ownership or values changed');assert(entry.checkpoints===before.checkpoints&&Aster.safeCheckpointStringify([...entry.checkpoints])===before.records,'Latest checkpoints changed');assert(sameValues([entry.revision,entry.dirty,entry.dirtyTo,entry.invalidated,entry.length,entry.computedFrom,entry.computedUntil],before.state),'Latest revision or dirty metadata changed');}

 scenario('native model exposes bundled indicator engine',()=>{
  nativeInit(0,{series:[]});nativeCommand('setData',[rows()]);probe.models.push(nativeModel);probe.engines.push(nativeModel.indicators);probe.stores.push(nativeModel.store);
  assert(nativeModel instanceof Aster.ChartModel&&nativeModel.indicators instanceof Aster.IndicatorEngine,'Generated native bridge ownership');
 });
 scenario('direct get rejects source mutation and recovers',()=>{
  const f=custom(({store,index,disarm})=>{if(index===3){disarm();change(store,9);}},{store:nativeModel.store,engine:nativeModel.indicators}),entry=f.engine.entries.get('c'),revision=entry.revision;
  f.arm();rejects(()=>f.engine.get('c'),'StaleSourceError');assert(entry.dirty===0&&entry.invalidated&&entry.revision===revision,'Failed calculation published clean state');
  assert(sameValues(nativeIndicatorBuffer('c','value',0,8),[9,1,1,1,1,1,1,1])&&!entry.invalidated&&entry.revision===revision+1,'Native buffer recovery');
 });
 for(const mutation of ['reset','empty'])scenario('callback '+mutation+' invalidates and recovers',()=>{
  const f=custom(({store,index,disarm})=>{if(index===3){disarm();store.setData(mutation==='empty'?[]:rows().map(bar=>({...bar,close:9})));}}),entry=f.engine.entries.get('c'),revision=entry.revision;
  f.arm();rejects(()=>f.engine.get('c'),'StaleSourceError');assert(entry.dirty===0&&entry.invalidated&&entry.revision===revision,'Source change published clean revision');
  assert(sameValues(f.engine.get('c').outputs.value,mutation==='empty'?[]:Array(8).fill(9)),'Source reset recovery');f.engine.dispose();
 });
 for(const at of ['middle','final'])scenario(at+' yield source mutation rejects before writes',()=>{
  const {store,engine}=builtin(false,'sma',{period:1},8),held=engine.get('s').outputs.value;change(store,9);const task=engine.calculate('s',2);
  for(let i=0;i<(at==='middle'?1:4);i++){const progress=task.next();assert(!progress.done&&progress.value.to===(i+1)*2,'Missing yield boundary');}
  change(store,8);const before=Array.from(held),revision=engine.entries.get('s').revision;rejects(()=>task.next(),'StaleSourceError');
  assert(sameValues(held,before)&&engine.entries.get('s').revision===revision,'Resumed stale iterator wrote or committed');assert(engine.get('s').outputs.value[0]===8,'Recovery after yielded source change');engine.dispose();
 });
 scenario('same entry recursion rejects and releases owner',()=>{
  const f=custom(({engine,index,disarm})=>{if(index===1){disarm();engine.get('c');}});f.arm();rejects(()=>f.engine.get('c'),'IndicatorBusyError');assert(f.engine.get('c').outputs.value[0]===1,'Busy owner was not released');f.engine.dispose();
 });
 scenario('independent entry calculation remains allowed',()=>{
  let calls=0;const f=custom(({engine,index,disarm})=>{if(index===1){disarm();assert(engine.get('s').outputs.value[0]===9,'Independent dependency value');calls++;}});f.engine.add('s','sma',{period:1});f.arm();change(f.store,9);
  assert(f.engine.get('c').outputs.value[0]===9&&calls===1,'Independent entry was blocked');f.engine.dispose();
 });
 for(const action of ['next','return','throw'])scenario('superseded '+action+' preserves new generation',()=>{
  const {store,engine}=builtin(true);change(store,9);const task=engine.calculate('s',2);assert(!task.next().done,'Expected suspension');change(store,8);
  const latest=engine.get('s'),entry=engine.entries.get('s'),before=capture(entry);assert(latest.outputs.value[0]===8&&!entry.invalidated,'New generation must be clean');
  if(action==='next')rejects(()=>task.next(),'StaleSourceError');else if(action==='return')assert(task.return().done,'Return did not finish');else {const error=Error('Stop superseded iterator');rejects(()=>task.throw(error),error);}
  unchanged(entry,before);entry.checkpoints.validateHistory(store.length);engine.dispose();
 });
 for(const action of ['remove','replacement','dispose'])scenario('suspended '+action+(action==='dispose'?' cannot revive entries':' cannot write retired buffers'),()=>{
  const {store,engine}=builtin(true),held=engine.get('s').outputs.value;change(store,9);const task=engine.calculate('s',2);assert(!task.next().done,'Expected suspension');const entry=engine.entries.get('s'),before=Array.from(held),revision=entry.revision;
  if(action==='dispose')engine.dispose();else engine.remove('s');if(action==='replacement')engine.add('s','sma',{period:2});
  rejects(()=>task.next(),'StaleSourceError');assert(sameValues(held,before)&&entry.revision===revision,'Retired output or revision changed');
  assert(action==='replacement'?engine.get('s').outputs.value[1]===5:engine.entries.size===0,'Retired entry resurrected');engine.dispose();
 });
 scenario('failed add preserves callback replacement',()=>{
  const {engine}=owner(),error=Error('Replacement callback failure');engine.register('replace',()=>({outputs:['value'],create:()=>({step(){engine.remove('s');engine.add('s','sma',{period:1});throw error;},snapshot:()=>({}),restore(){}})}));
  rejects(()=>engine.add('s','replace'),error);assert(engine.entries.get('s').name==='sma'&&engine.get('s').outputs.value[0]===1,'Failed add deleted replacement');engine.dispose();
 });
 for(const action of ['supersede','return','throw'])scenario('partial EMA '+action+' matches fresh oracle',()=>{
  // Check both raw and encoded checkpoints after exactly two of four yields.
  for(const nativeRecords of [false,true]){
   const {store,engine}=builtin(nativeRecords,'ema',{period:3}),entry=engine.entries.get('s'),revision=entry.revision;change(store,9);const task=engine.calculate('s',2);
   for(let i=0;i<2;i++){const progress=task.next();assert(!progress.done&&progress.value.to===(i+1)*2,'Partial EMA progress');assert(entry.invalidated&&entry.revision===revision,'Partial EMA certified an uncomputed suffix');}
   if(action==='return')assert(task.return().done,'Partial return');if(action==='throw'){const error=Error('Stop partial EMA');rejects(()=>task.throw(error),error);}
   assert(entry.invalidated&&entry.dirty===0&&entry.revision===revision,'Cancelled EMA committed partial state');
   const oracle=new Aster.IndicatorEngine(store,{checkpointSize:2});probe.engines.push(oracle);const expected=oracle.add('e','ema',{period:3}),actual=engine.get('s');
   assert(sameValues(actual.outputs.value,expected.outputs.value)&&actual.computedUntil===8&&!entry.invalidated&&entry.revision===revision+1,'Partial EMA differs from fresh full calculation');
   assert(Aster.safeCheckpointStringify([...entry.checkpoints])===Aster.safeCheckpointStringify([...oracle.entries.get('e').checkpoints]),'Recovered EMA checkpoint history differs');
   if(nativeRecords)entry.checkpoints.validateHistory(store.length);if(action==='supersede'){const before=capture(entry);rejects(()=>task.next(),'StaleSourceError');unchanged(entry,before);}oracle.dispose();engine.dispose();
  }
 });
 for(const action of ['mutation','reset','disposal'])scenario('native checkpoint validator '+action+(action==='disposal'?' rejects clean publication':' rejects and recovers'),()=>{
  const {store,engine}=owner(),name='test.native-checkpoint-quickjs@1/value';engine.add('s',name,{});const map=bounded(engine,'s'),entry=engine.entries.get('s'),revision=entry.revision;change(store,1);let called=false;
  nativeCheckpointQuickjsProbe.onValidate=(_state,index)=>{if(called||index!==8)return;called=true;if(action==='mutation')change(store,9);else if(action==='reset')store.setData(rows().map(bar=>({...bar,close:9})));else engine.dispose();};
  try {let error;try{engine.get('s');}catch(e){error=e;}assert(error&&(['StaleSourceError','StaleCheckpointError'].includes(error.name)||/disposed/.test(error.message)),'Final checkpoint reentry was not rejected');assert(called&&entry.revision===revision,'Final checkpoint callback or clean revision');}
  finally {nativeCheckpointQuickjsProbe.onValidate=null;}
  if(action==='disposal')assert(engine.entries.size===0,'Disposed entry resurrected');else {assert(entry.dirty===0&&entry.invalidated,'Failed native checkpoint marked clean');assert(engine.get('s').outputs.value[0]===9,'Native checkpoint recovery');map.validateHistory(store.length);}engine.dispose();
 });
 for(const count of [31,32,33])scenario('realm depth '+count+(count<=32?' succeeds across one and multiple engines':' rejects across one and multiple engines'),()=>{
  for(const multiple of [false,true]){
   const store=new Aster.BarStore(rows().slice(0,1)),engines=Array.from({length:multiple?count:1},()=>new Aster.IndicatorEngine(store));probe.stores.push(store);probe.engines.push(...engines);let armed=false,calls=0;
   for(let i=count-1;i>=0;i--){const engine=engines[multiple?i:0];engine.register('chain'+i,()=>({outputs:['value'],create:()=>({step(bar){if(armed){calls++;if(i+1<count)engines[multiple?i+1:0].get('x'+(i+1));}return [bar.close];},snapshot:()=>({}),restore(){}})}));engine.add('x'+i,'chain'+i);}
   try {change(store,1);armed=true;if(count<=32)assert(engines[0].get('x0').outputs.value[0]===1,'Allowed depth failed');else assert(/nesting limit/.test(rejects(()=>engines[0].get('x0'),'IndicatorBusyError').message),'Depth limit diagnostic');
    assert(calls===Math.min(count,32),'Wrong active depth boundary');armed=false;for(let i=0;i<count;i++)assert(engines[multiple?i:0].get('x'+i).outputs.value[0]===1,'Healthy get failed after depth unwind');
   } finally {for(const engine of engines)engine.dispose();}
  }
 });
 scenario('fresh remove add recursion stops at 32 and recovers',()=>{
  const {engine}=owner();let calls=0;engine.register('recursive',()=>({outputs:['value'],create:()=>({step(){calls++;engine.remove('x');engine.add('x','recursive');return [1];},snapshot:()=>({}),restore(){}})}));
  try {assert(/nesting limit/.test(rejects(()=>engine.add('x','recursive'),'IndicatorBusyError').message),'Replacement recursion depth diagnostic');assert(calls===32&&engine.entries.size===0,'Replacement recursion exceeded bound or retained failed entries');engine.add('x','sma',{period:1});assert(sameValues(engine.get('x').outputs.value,Array(8).fill(1)),'Healthy get failed after replacement recursion');}finally {engine.dispose();}
 });
 scenario('all models engines checkpoints and listeners released',()=>{
  for(const model of probe.models)model.dispose();for(const engine of probe.engines)engine.dispose();
  assert(probe.models.every(model=>model.disposed)&&probe.engines.every(engine=>engine.entries.size===0),'Model or engine ownership retained');assert(probe.stores.every(store=>store.listeners.size===0),'Source listeners retained');assert(probe.budgets.every(budget=>budget.usedBytes===0),'Checkpoint bytes retained');
 });
 return JSON.stringify({case:'indicator-reentry-quickjs',passed:true,checks:scenarios.length,scenarios,scope:'bundled IndicatorEngine and nativeModel in standalone QuickJS/Node VM; no Android JNI, Apple JSC or device proof'});
})()
