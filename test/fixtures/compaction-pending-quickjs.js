(function(){
 const scenarios=[],models=[],stores=[],sessions=[];
 const assert=(v,m)=>{if(!v)throw Error(m);},run=(name,fn)=>{fn();scenarios.push(name);};
 const row=(time,volume=1)=>({time,open:2,high:3,low:1,close:2,volume});
 const opts=keepLastBars=>({keepLastBars,studyHistory:'restart',pendingData:'preserve-retained'});
 const reject=fn=>{let caught=false;try{fn();}catch{caught=true;}assert(caught,'Expected rejection');};
 const packet=events=>({streamId:'q',generation:1,firstSequence:0,events});
 const policy={streamId:'q',generation:1,maxQueuedEvents:8,maxBatchEvents:8,maxStoredBars:4,maxStoreBytes:1536};
 const create=()=>{const m=new Aster.ChartModel();m.store.setData([0,1,2,3].map(t=>row(t)));const api=new Aster.ChartAPI(m);api.configureDataIngestion(policy);models.push(m);stores.push(m.store);sessions.push(m.dataIngestion);return {m,api};};
 run('native command recovers a capped drain with exact pending FIFO and signed zero',()=>{
  nativeInit(0,{series:[]});nativeCommand('setData',[[0,1,2,3].map(t=>row(t))]);nativeCommand('configureDataIngestion',[policy]);
  const m=nativeModel,store=m.store,q=m.dataIngestion,columns=q.columns,kinds=q.kinds;models.push(m);stores.push(store);sessions.push(q);
  nativeCommand('enqueueDataEvents',[packet([{kind:'append',bar:row(4,-0)},{kind:'append',bar:row(5)},{kind:'correction',bar:row(3,7)}])]);
  reject(()=>nativeCommand('drainDataEvents',[8]));assert(q.paused&&q.count===3,'Failed drain lost pending data');
  const saved=nativeCommand('saveDataIngestion',[]),version=store.version,epoch=q.epoch;
  const receipt=nativeCommand('compactData',[opts(2)]);
  assert(receipt.removed===2&&m.store===store&&q.columns===columns&&q.kinds===kinds,'Source or queue identity changed');
  assert(nativeCommand('saveDataIngestion',[])===saved&&q.sourceVersion===version+1&&q.epoch===epoch+1,'Queue state changed');
  nativeCommand('resumeDataIngestion',[]);const drained=nativeCommand('drainDataEvents',[8]);
  assert(drained.events===3&&store.length===4&&store.at(0).time===2&&store.at(1).volume===7&&Object.is(store.at(2).volume,-0),'FIFO result mismatch');
  assert(q.count===0&&q.counters.applied===3&&q.counters.cancelled===0,'Sequence ledger mismatch');
 });
 run('evicted correction rejects source and queue publication atomically',()=>{
  const {m,api}=create();api.enqueueDataEvents(packet([{kind:'append',bar:row(4)},{kind:'correction',bar:row(0,5)}]));api.pauseDataIngestion();
  const saved=api.saveDataIngestion(),columns=m.store.columns,index=m.store.index,version=m.store.version,epoch=m.dataIngestion.epoch;
  reject(()=>api.compactData(opts(2)));assert(api.saveDataIngestion()===saved&&m.store.columns===columns&&m.store.index===index&&m.store.version===version&&m.dataIngestion.epoch===epoch,'Rejected compaction published');
 });
 run('future append does not retroactively authorize an earlier correction',()=>{
  const {m,api}=create();api.enqueueDataEvents(packet([{kind:'correction',bar:row(4)},{kind:'append',bar:row(4)}]));api.pauseDataIngestion();
  const saved=api.saveDataIngestion();reject(()=>api.compactData(opts(2)));assert(m.store.length===4&&api.saveDataIngestion()===saved,'Future dependency mutated source');
 });
 run('all source listeners and ingestion buffers are released',()=>{
  for(const m of models)m.dispose();assert(stores.every(s=>s.listeners.size===0&&s.listenerErrors.length===0),'Source listener/error leak');
  assert(sessions.every(q=>q.closed&&q.count===0&&q.kinds===null&&Object.keys(q.columns).length===0&&q.model===null&&q.store===null),'Ingestion ownership leak');
 });
 return JSON.stringify({case:'compaction-pending-quickjs',passed:true,checks:4,scenarios});
})()
