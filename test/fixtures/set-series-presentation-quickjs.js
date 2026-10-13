// Runs unchanged in a bare Node VM and the standalone Linux QuickJS host.
(function(){
 const scenarios=[],assert=(value,message)=>{if(!value)throw Error(message);};
 const scenario=(label,run)=>{assert(!scenarios.includes(label),'Duplicate scenario');run();scenarios.push(label);};
 const rejects=(run,check)=>{let caught=false,error;try{run();}catch(e){caught=true;error=e;}assert(caught&&check(error),'Unexpected rejection: '+error);return error;};
 const sameValues=(a,b)=>a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
 const rows=()=>Array.from({length:8},(_,time)=>({time,open:1,high:9,low:0,close:1,volume:1}));
 const probe=globalThis.setSeriesPresentationQuickjsProbe={models:[],stores:[],budgets:[],callbacks:[],held:[],styles:[],reentry:null,fallback:null,ledger:null,visibility:null};
 function remember(model){probe.models.push(model);probe.stores.push(model.store);return model;}
 function owner(){const model=remember(new Aster.ChartModel());model.store.setData(rows());return {model,api:new Aster.ChartAPI(model)};}
 function custom(f=owner()){
  const {model,api}=f,calls={get:0,create:0,step:0,snapshot:0,restore:0},failure=new Error('Dirty presentation calculation');let armed=false,notifications=0;
  const hit=key=>{calls[key]++;if(armed)throw failure;};probe.callbacks.push(calls);api.invalidate=()=>notifications++;
  model.indicators.register('presentation-probe',()=>({outputs:['value'],create(){hit('create');return {step(bar){hit('step');return [bar.close];},snapshot(){hit('snapshot');return 0;},restore(){hit('restore');}};}}));
  api.addIndicator('target','presentation-probe');api.addSeries({id:'line',type:'line',panel:'price',indicator:'target'});
  const get=model.indicators.get;model.indicators.get=function(...args){calls.get++;return get.apply(this,args);};
  return {...f,calls,failure,notifications:()=>notifications,arm(){model.store.update(0,{...model.store.at(0),close:9});armed=true;for(const key of Object.keys(calls))calls[key]=0;}};
 }
 const noCalls=f=>assert(Object.values(f.calls).every(n=>n===0),'Presentation read or calculated an indicator');
 function hold(array){const row={array,copy:Array.from(array)};probe.held.push(row);return row;}
 const heldUnchanged=row=>assert(sameValues(row.array,row.copy),'Held output changed');
 function cache(model){const series=model.series[0];model.seriesData(series);return {range:series.rangeIndex,revision:series.revision};}
 function cacheUnchanged(model,before,dirty){const s=model.series[0];assert(s.rangeIndex===before.range&&s.revision===before.revision&&s.dirtyFrom===dirty,'Presentation changed raw range cache');}

 scenario('native command applies all presentation keys without get or calculation',()=>{
  nativeInit(0,{series:[]});nativeCommand('setData',[rows()]);const f=custom({model:remember(nativeModel),api:nativeAPI}),{model}=f;
  assert(model instanceof Aster.ChartModel&&nativeAPI instanceof Aster.ChartAPI,'Native bundle ownership');
  const before=cache(model),held=hold(nativeIndicatorBuffer('target','value',0,8)),entry=model.indicators.entries.get('target'),revision=entry.revision;
  f.arm();const dirty=model.series[0].dirtyFrom,version=model.store.version,notifications=f.notifications();
  const patches=[['color','red','#ff0000ff'],['fill',null,null],['upColor','#123','#112233ff'],['downColor','#456','#445566ff'],['width',2,2],['visible',false,false],['label','Updated label','Updated label']];
  for(const [key,value,expected] of patches){assert(nativeCommand('setSeries',['line',{[key]:value}])===null,'Native setSeries return');assert(model.series[0][key]===expected,'Presentation value not applied: '+key);probe.styles.push(key);noCalls(f);cacheUnchanged(model,before,dirty);heldUnchanged(held);}
  assert(model.indicators.entries.get('target')===entry&&entry.revision===revision&&model.store.version===version,'Presentation mutated indicator or source');
  assert(f.notifications()===notifications+7,'Wrong successful mutation notifications');
 });
 scenario('entry replacement and original getter errors preserve uncommitted state',()=>{
  const f=custom(),{model,api}=f,old=model.indicators.entries.get('target'),replacement={...old},series=model.series,before=series[0];
  f.arm();const notifications=f.notifications();let reads=0;
  rejects(()=>api.setSeries('line',{get color(){reads++;model.indicators.entries.set('target',replacement);return 'red';}}),e=>e.name==='StaleSourceError');
  assert(model.indicators.entries.get('target')===replacement&&replacement!==old&&model.series===series&&series[0]===before,'Rejected patch erased replacement or committed series');
  const original={original:true};rejects(()=>api.setSeries('line',{get color(){reads++;throw original;}}),e=>e===original);
  rejects(()=>api.setSeries('line',{width:0}),e=>e instanceof RangeError);
  assert(reads===2&&series[0]===before&&f.notifications()===notifications,'Rejected patch read twice, mutated state, or notified');
  const patch={get color(){assert(this===patch,'Getter receiver changed');reads++;return 'rgb(255,0,0)';}};api.setSeries('line',patch);noCalls(f);
  assert(reads===3&&series[0].color==='#ff0000ff'&&f.notifications()===notifications+1,'Successful getter not applied exactly once');
  probe.reentry={reads,notifications:f.notifications()-notifications,replacementPreserved:model.indicators.entries.get('target')===replacement,originalPreserved:true};
 });
 scenario('nonpresentation and mixed patches retain explicit calculation failures',()=>{
  const f=custom(),{model,api}=f;f.arm();const before=model.series[0],entry=model.indicators.entries.get('target'),notifications=f.notifications();
  const patches=[{output:'value'},{offset:0},{panel:'price'},{axisId:null},{type:'line'},{source:'close'},{baseline:0},{id:'line'},{color:'red',output:'value'}];
  for(const patch of patches){rejects(()=>api.setSeries('line',patch),e=>e===f.failure);assert(model.series[0]===before&&model.indicators.entries.get('target')===entry&&f.notifications()===notifications,'Failed calculation committed presentation state');}
  assert(f.calls.get===9&&f.calls.create===9&&f.calls.step===0&&f.calls.snapshot===0&&f.calls.restore===0,'Nonpresentation calculation boundary changed');
  probe.fallback={checks:patches.length,keys:patches.map(p=>Object.keys(p).join('+')),calls:f.calls};
 });
 scenario('native checkpoint ledgers held output and range index survive presentation',()=>{
  const {model,api}=owner(),engine=model.indicators,budget=new Aster.NativeCheckpointBudget();probe.budgets.push(budget);engine.checkpointSize=2;
  for(const id of ['target','keep']){
   api.addIndicator(id,'ema',{period:2});const entry=engine.entries.get(id),map=new Aster.NativeCheckpointMap('ema',{period:2},{budget,block:2});
   for(const [index,state] of entry.checkpoints)map.set(index,state);entry.checkpoints=map;
  }
  engine.entries=new Aster.NativeCheckpointEntries(engine.entries);api.addSeries({id:'line',type:'line',panel:'price',indicator:'target'});
  const entries=engine.entries,target=entries.get('target'),keep=entries.get('keep'),before=cache(model),held=hold(engine.get('target').outputs.value);
  const total=budget.usedBytes,targetBytes=target.checkpoints.encodedBytes,keepBytes=keep.checkpoints.encodedBytes,records=JSON.stringify([...target.checkpoints]),keepRecords=JSON.stringify([...keep.checkpoints]);
  assert(total===targetBytes+keepBytes&&targetBytes>0&&keepBytes>0,'Native checkpoint fixture has no charged records');
  model.store.update(0,{...model.store.at(0),close:9});const dirty=model.series[0].dirtyFrom,version=model.store.version,revision=target.revision;let gets=0,creates=0;
  engine.get=()=>{gets++;throw Error('Native presentation get');};target.def.create=()=>{creates++;throw Error('Native presentation create');};
  api.setSeries('line',{color:'blue',fill:null,width:3,visible:false,label:'Native study'});
  assert(engine.entries===entries&&entries.get('target')===target&&entries.get('keep')===keep,'Presentation replaced native entries');
  assert(gets===0&&creates===0&&budget.usedBytes===total&&target.checkpoints.encodedBytes===targetBytes&&keep.checkpoints.encodedBytes===keepBytes,'Presentation read, calculated, or changed checkpoint ledger');
  assert(JSON.stringify([...target.checkpoints])===records&&JSON.stringify([...keep.checkpoints])===keepRecords,'Presentation changed checkpoint records');
  assert(target.revision===revision&&model.store.version===version,'Native presentation changed revision');cacheUnchanged(model,before,dirty);heldUnchanged(held);
  target.checkpoints.validateHistory(8);keep.checkpoints.validateHistory(8);probe.ledger={before:total,afterPatch:budget.usedBytes,targetBytes,keepBytes,gets,creates,afterDispose:null};
 });
 scenario('hidden failing study renders lazily and displayed explicit read retains error',()=>{
  const f=custom(),{model,api}=f;api.addSeries({id:'price',type:'candles',panel:'price'});
  const before=cache(model),held=hold(model.indicators.get('target').outputs.value);f.arm();const dirty=model.series[0].dirtyFrom;
  api.setSeries('line',{visible:false,color:'blue'});const scene=Aster.buildScene(model,800,500);assert(scene.commands.length>0,'Hidden scene has no price commands');
  noCalls(f);cacheUnchanged(model,before,dirty);heldUnchanged(held);api.setSeries('line',{visible:true});noCalls(f);
  rejects(()=>api.indicatorValues('target','value'),e=>e===f.failure);heldUnchanged(held);cacheUnchanged(model,before,dirty);
  assert(f.calls.get===1&&f.calls.create===1&&f.calls.step===0&&f.calls.snapshot===0&&f.calls.restore===0,'Displayed explicit read changed failure boundary');
  probe.visibility={commands:scene.commands.length,hiddenGet:0,hiddenCalculation:0,shownGetBeforeRead:0,explicitReadErrorPreserved:true};
 });
 scenario('all models entries checkpoint bytes and source listeners are released',()=>{
  for(const model of probe.models){model.dispose();model.dispose();}
  assert(probe.models.every(model=>model.disposed&&model.indicators.entries.size===0&&model.series.every(s=>s.rangeIndex===null)),'Disposed model retained entries or range indexes');
  assert(probe.stores.every(store=>store.listeners.size===0),'Disposed source retained listeners');
  assert(probe.budgets.every(budget=>budget.usedBytes===0),'Disposed checkpoint ledger retained bytes');
  probe.ledger.afterDispose=probe.budgets[0].usedBytes;for(const held of probe.held)heldUnchanged(held);
 });
 return JSON.stringify({case:'set-series-presentation-quickjs',passed:true,checks:scenarios.length,scenarios,scope:'bundled ChartAPI.setSeries and nativeCommand in standalone QuickJS/Node VM; no Android JNI, Apple JSC, native SDK, browser or device proof'});
})()
