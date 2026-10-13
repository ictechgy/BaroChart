// Built-in source/isolated-target protocols only; no host runtime swap or JNI/JSC.
(function(){
 let checks=0;const scenarios=new Set();
 const ok=(value,label)=>{if(!value)throw Error(label);if(scenarios.has(label))throw Error('duplicate scenario: '+label);checks++;scenarios.add(label);};
 const rejects=(fn,pattern,label)=>{let caught;try{fn();}catch(error){caught=error;}ok(!!caught&&pattern.test(caught.name+': '+caught.message),label);};
 const fields=['time','open','high','low','close','volume'],names=['ema','rsi'],revision=37;
 const binding={key:'fixture:native-source/1m',revision:'r1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'};
 const probe=globalThis.nativeWorkspaceSourceQuickjsProbe={models:[],stores:[],captures:[],targets:[],sessions:[]};
 const stringify=Aster.safeCheckpointStringify;
 function source(length){
  const store=new Aster.BarStore([],{maxBars:4096,timeframeMs:60000,timeOrigin:123});store.setColumns(Aster.seededColumns(length,419));
  const model=new Aster.ChartModel({store,precision:7,axisWidth:93,panels:[{id:'price',weight:3},{id:'osc',weight:1,range:[0,100]}],axes:[{id:'left',panel:'price',side:'left',width:67}],theme:{background:'#112233'}});
  const size={width:900,height:600},input=new Aster.InteractionController(model,()=>size),api=new Aster.ChartAPI(model,{controller:input});
  for(const name of names)api.addIndicator(name,name,{});
  api.addSeries({id:'candles',type:'candles',panel:'price'});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema'});api.addSeries({id:'rsi-line',type:'line',panel:'osc',indicator:'rsi'});
  const time=length?store.at(0).time:1700000000000;
  api.addDrawing({id:'anchor',type:'trendline',panel:'price',axisId:'left',points:[{time:time-60000.25,price:97.125},{time:time+90000.75,price:103.875}]});
  model.view={from:-40.125,to:length+80.875};model.follow=false;model.drawings.selected='anchor';model.crosshair={x:120,y:60};
  api.configureDataIngestion({streamId:'quickjs-source',generation:3,firstSequence:19,maxQueuedEvents:7,maxQueuedBytes:245,maxBatchEvents:3,maxStoredBars:4096,maxStoreBytes:393216});
  const bar=length?store.at(length-1):{time,open:100,high:101,low:99,close:100,volume:7};
  api.enqueueDataEvents({streamId:'quickjs-source',generation:3,firstSequence:19,events:[{kind:length?'update':'append',bar},{kind:length?'update':'append',bar:{...bar,time:length?bar.time:bar.time+60000}}]});
  if(length)api.drainDataEvents(2);else api.cancelDataEvents();api.pauseDataIngestion();
  const f={model,store,api,input,size,listeners:[...store.listeners],columns:fields.map(k=>store.columns[k])};
  probe.models.push(model);probe.stores.push(store);probe.sessions.push(model.dataIngestion);return f;
 }
 function capture(f,options={}){const c=new Aster.NativeWorkspaceCapture(f.api,Aster.saveWorkspace(f.api,binding),binding,{input:f.input,size:f.size,revision,...options});probe.captures.push(c);return c;}
 function admit(c,work=2){let bounded=true;for(let i=0;i<2000;i++){const before=c.recordCount+c.drawingCount,r=c.step(work,revision);bounded=bounded&&c.recordCount+c.drawingCount-before<=work&&typeof r.complete==='boolean';if(r.complete)return bounded;}throw Error('source admission did not terminate');}
 function copy(c,p){let borrowed=true,owned=true;const n=c.model.store.length;for(let offset=0;offset<n;offset+=71)for(let slot=5;slot>=0;slot--){const count=Math.min(71,n-offset),a=c.model.store.columns[fields[slot]],view=c.buffer(slot,offset,count,revision);borrowed=borrowed&&view.buffer===a.buffer&&view.byteOffset===a.byteOffset+offset*8&&view.length===count&&view.every((v,i)=>Object.is(v,a[offset+i]));if(p){const out=p.target(slot,offset,count);owned=owned&&out.buffer!==view.buffer&&out.length===count;out.set(view);}}return {borrowed,owned};}
 function target(c){const p=new Aster.NativeWorkspacePrepared(c.metadataJSON);probe.targets.push(p);return p;}
 function run(p){p.start();probe.stores.push(p.store);let bounded=true;for(let i=0;i<2000;i++){const r=p.step(127);bounded=bounded&&typeof r.complete==='boolean'&&Number.isFinite(r.done)&&r.done>=0&&r.done<=r.total;if(r.complete)return bounded;}throw Error('target preparation did not terminate');}
 function idle(f){try{Aster.assertDataIngestionIdle(f.model);return !f.model.dataIngestion.leased;}catch{return false;}}
 function live(f){return f.model.disposed!==true&&f.model.store===f.store&&f.listeners.length===f.store.listeners.size&&f.listeners.every(v=>f.store.listeners.has(v))&&fields.every((k,i)=>f.store.columns[k]===f.columns[i]&&f.columns[i].buffer.byteLength>0);}
 function released(c){return c.closed&&c.lease===null&&['api','model','input','size','session','refs','before','document','binding','metadataJSON','ingestionText','recordIterator','seenDrawings','seenFrames'].every(k=>c[k]===null)&&['records','frames','buffers'].every(k=>c[k].length===0);}
 function rawCost(value){function nodes(v){return 1+(v&&typeof v==='object'?Object.values(v).reduce((n,x)=>n+nodes(x),0):0);}return stringify(value).length*2+nodes(value)*32;}
 function backingBytes(model){const buffers=new Set(),add=a=>{if(a)buffers.add(a.buffer);},tree=t=>{if(t)for(const k of ['min','max','sum'])add(t[k]);};for(const k of fields)add(model.store.columns[k]);tree(model.store.index);const session=model.dataIngestion;if(session){for(const k of fields)add(session.columns[k]);add(session.kinds);}for(const e of model.indicators.entries.values())for(const a of e.arrays)add(a);for(const s of model.series){add(s.values);if(s.rangeIndex)add(s.rangeIndex.values);tree(s.rangeIndex instanceof Aster.BlockRangeIndex?s.rangeIndex.tree:s.rangeIndex);}return [...buffers].reduce((n,b)=>n+b.byteLength,0);}
 function parity(model,label){const store=new Aster.BarStore();store.setColumns(model.store.columns,model.store.length);probe.stores.push(store);const oracle=new Aster.IndicatorEngine(store);try{for(const name of names){const actual=model.indicators.get(name).outputs.value,expected=oracle.add(name,name,{}).outputs.value;ok(actual.length===expected.length&&actual.every((v,i)=>Object.is(v,expected[i])),label+' '+name+'/value');}}finally{oracle.dispose();}}
 function retry(f,label){const c=capture(f);admit(c);copy(c);const receipt=c.finish(revision);ok(receipt.revision===revision&&released(c)&&idle(f)&&live(f),label);}
 const f=source(513);probe.sourceModel=f.model;probe.sourceStore=f.store;
 const saved=Aster.saveWorkspace(f.api,binding),ingestion=f.api.saveDataIngestion(),epoch=f.model.dataIngestion.epoch;
 const entries=[...f.model.indicators.entries.values()],snapshots=entries.map(e=>({entry:e,arrays:e.arrays,values:e.arrays.map(a=>[...a]),records:[...e.checkpoints],revision:e.revision,dirty:e.dirty,create:e.def.create}));
 const count=snapshots.reduce((n,e)=>n+e.records.length,0),rawBytes=snapshots.reduce((n,e)=>n+e.records.reduce((sum,row)=>sum+128+rawCost(row[1]),0),0);
 const get=f.model.indicators.get;let gets=0,creates=0;f.model.indicators.get=()=>{gets++;throw Error('source get forbidden');};for(const e of entries)e.def.create=()=>{creates++;throw Error('source calculation forbidden');};
 const c=capture(f);ok(f.model.dataIngestion.leased&&!idle(f),'source ingestion lease acquired');
 ok(c.recordCount===0&&c.checkpointBytes===count*128&&count===6,'raw checkpoint admission is lazy');
 const first=c.step(1,revision);ok(!first.complete&&c.recordCount===1&&admit(c),'bounded source admission progress');
 ok(c.recordCount===count&&c.checkpointBytes===rawBytes,'exact raw checkpoint footprint');
 ok(c.sourceBytes===backingBytes(f.model),'source backing allocations charged once');
 ok(gets===0&&creates===0,'admission avoids source recalculation');
 ok(snapshots.every(s=>s.entry.arrays===s.arrays&&s.entry.revision===s.revision&&s.entry.dirty===s.dirty&&[...s.entry.checkpoints].every((row,i)=>row[0]===s.records[i][0]&&row[1]===s.records[i][1])&&s.arrays.every((a,i)=>a.every((v,j)=>Object.is(v,s.values[i][j])))),'source cache identities and values preserved');
 const metadata=Aster.safeCheckpointParse(c.metadataJSON),ringBytes=f.model.dataIngestion.capacity*49,noRing={...metadata,retainedBytes:metadata.retainedBytes-ringBytes};delete noRing.dataIngestion;
 ok(ringBytes===245&&c.plan.ingestionBytes===ringBytes*3&&c.plan.totalBytes-Aster.nativeWorkspaceTargetPlan(stringify(noRing)).totalBytes===ringBytes*4,'empty ingestion ring logical reservation');
 ok(metadata.document===saved&&metadata.dataIngestion===ingestion&&metadata.retainedBytes===c.sourceBytes+c.checkpointBytes+c.drawingBytes&&Object.isFrozen(c.plan),'captured metadata and retained admission');
 const bytes=c.sourceBytes+c.checkpointBytes+c.drawingBytes,metadataText=c.metadataJSON;c.step(64,revision);
 ok(c.metadataJSON===metadataText&&c.sourceBytes+c.checkpointBytes+c.drawingBytes===bytes,'completed admission does not double charge');
 const p=target(c),copied=copy(c,p);ok(copied.borrowed,'source slices borrow live buffers');ok(copied.owned,'target transfer owns separate buffers');
 ok(run(p),'bounded source-to-target preparation');const receipt=c.finish(revision);
 ok(receipt.schema==='aster.native-workspace-source-finished'&&receipt.revision===revision&&receipt.sourceVersion===f.store.version,'source finished receipt');
 ok(released(c)&&idle(f)&&f.model.dataIngestion.epoch===epoch+2,'source finish releases lease and references');
 rejects(()=>c.step(1,revision),/closed/,'finished source capture rejects reuse');
 ok(live(f),'source listeners and undetached columns survive');
 f.model.indicators.get=get;for(const s of snapshots)s.entry.def.create=s.create;
 const result=p.finish(),model=result.model,api=new Aster.ChartAPI(model);probe.models.push(model);probe.sessions.push(model.dataIngestion);probe.targetModel=model;probe.targetStore=model.store;
 ok(Aster.saveWorkspace(api,binding)===saved,'source-to-target canonical save');
 ok(model.view.from===-40.125&&model.view.to===593.875&&stringify(model.drawings.items)===stringify(f.model.drawings.items)&&model.drawings.items[0].points[0].time===1699999939999.75,'fractional view and drawing anchors');
 ok(model.drawings.selected===null&&model.drawings.undoStack.length===0&&model.drawings.redoStack.length===0&&model.crosshair===null,'target transient UI reset');
 ok(fields.every((k,i)=>model.store.columns[k].buffer!==f.columns[i].buffer&&model.store.columns[k].every((v,j)=>Object.is(v,f.columns[i][j]))),'owned target columns match source');
 ok(api.saveDataIngestion()===ingestion&&f.api.saveDataIngestion()===ingestion&&model.dataIngestion!==f.model.dataIngestion&&model.dataIngestion.nextSequence===21&&model.dataIngestion.paused&&model.dataIngestion.count===0&&fields.every(k=>model.dataIngestion.columns[k].buffer!==f.model.dataIngestion.columns[k].buffer),'empty ingestion policy cursor and pause preserved');
 parity(model,'restored');
 const encoded=[...model.indicators.entries.values()].map(e=>e.checkpoints),encodedBytes=encoded.reduce((n,map)=>n+map.encodedBytes+map.size*128,0);
 ok(encoded.every(map=>map instanceof Aster.NativeCheckpointMap&&map.size===3&&map.validateHistory(513)===map)&&p.checkpointBudget.usedBytes===encoded.reduce((n,map)=>n+map.encodedBytes,0)&&p.checkpointBudget.usedBytes<=33554432,'restored bounded native checkpoint ownership');
 const encodedSource={api,model,input:null,size:f.size};let decoded=0;for(const map of encoded)for(const key of ['get','keys',Symbol.iterator])map[key]=()=>{decoded++;throw Error('encoded source decoded');};
 const encodedCapture=capture(encodedSource);admit(encodedCapture);ok(decoded===0&&encodedCapture.recordCount===0&&encodedCapture.checkpointBytes===encodedBytes,'encoded source accounting avoids decode');
 encodedCapture.dispose();for(const map of encoded)for(const key of ['get','keys',Symbol.iterator])delete map[key];
 ok(released(encodedCapture)&&idle(encodedSource)&&p.checkpointBudget.usedBytes>0&&model.disposed!==true,'encoded capture cleanup preserves owner');
 p.dispose();ok(model.disposed!==true&&p.checkpointBudget.usedBytes>0,'target wrapper preserves returned ownership');
 const volume=model.store.at(3).volume,row=f.store.at(3);f.store.update(3,{...row,volume:row.volume+5});
 ok(model.store.at(3).volume===volume&&f.store.at(3).volume===volume+5,'source mutation stays independent');
 const targetRow=model.store.at(5);model.store.update(5,{...targetRow,close:targetRow.low});parity(model,'corrected');
 ok(f.store.at(5).close!==targetRow.low&&live(f),'target correction stays independent');
 const empty=source(0),emptySaved=Aster.saveWorkspace(empty.api,binding),emptyIngestion=empty.api.saveDataIngestion(),emptyCapture=capture(empty);admit(emptyCapture);
 ok(emptyCapture.recordCount===0&&emptyCapture.checkpointBytes===0&&emptyCapture.offsets.every(n=>n===0),'empty source admission');
 const emptyTarget=target(emptyCapture);run(emptyTarget);emptyCapture.finish(revision);const emptyModel=emptyTarget.finish().model;probe.models.push(emptyModel);probe.sessions.push(emptyModel.dataIngestion);
 ok(emptyModel.store.length===0&&Aster.saveWorkspace(new Aster.ChartAPI(emptyModel),binding)===emptySaved,'empty source-to-target canonical save');
 parity(emptyModel,'empty');
 ok(new Aster.ChartAPI(emptyModel).saveDataIngestion()===emptyIngestion&&emptyModel.dataIngestion.nextSequence===21&&emptyModel.dataIngestion.paused&&emptyModel.dataIngestion.counters.cancelled===2,'empty source ingestion state preserved');
 emptyTarget.dispose();ok(released(emptyCapture)&&idle(empty)&&live(empty)&&emptyTarget.checkpointBudget.usedBytes===0&&emptyModel.disposed!==true,'empty source cleanup and target ownership');
 const exact=capture(f);admit(exact);const limit=exact.plan.totalBytes;exact.dispose();const exactRetry=capture(f,{maxBytes:limit});admit(exactRetry);
 ok(exactRetry.plan.totalBytes===limit&&exactRetry.plan.maxBytes===limit,'combined budget exact boundary');exactRetry.dispose();
 const short=capture(f,{maxBytes:limit-1});let allocated=0;
 rejects(()=>{admit(short);allocated++;target(short);},/combined logical byte limit/,'combined budget rejects one byte short');
 ok(allocated===0&&released(short)&&idle(f)&&live(f),'budget failure precedes target allocation');
 const premature=capture(f);rejects(()=>premature.buffer(0,0,1,revision),/copy slice/,'copy before admission rejected');
 ok(released(premature)&&idle(f)&&live(f),'early copy failure releases source');retry(f,'lease reused after early copy failure');
 const partial=capture(f);admit(partial);partial.buffer(0,0,1,revision);rejects(()=>partial.finish(revision),/copy incomplete/,'incomplete transfer cannot finish');
 ok(released(partial)&&idle(f)&&live(f),'incomplete transfer releases source');
 const cancelled=capture(f);admit(cancelled);cancelled.buffer(0,0,1,revision);cancelled.dispose();cancelled.dispose();
 ok(released(cancelled)&&idle(f)&&live(f),'partial cancellation releases source');retry(f,'lease reused after cancellation');
 const checkpoint=f.model.indicators.entries.get('ema').checkpoints,oldRecord=checkpoint.get(0);let reads=0;checkpoint.set(0,{get malicious(){reads++;return 1;}});
 const uncopyable=capture(f);rejects(()=>admit(uncopyable),/own data/,'uncopyable raw checkpoint rejected');
 ok(reads===0&&released(uncopyable)&&idle(f)&&live(f),'uncopyable record avoids getters and releases lease');checkpoint.set(0,oldRecord);retry(f,'lease reused after raw checkpoint failure');
 checkpoint.set(0,{payload:'x'.repeat(131072)});const giant=capture(f);
 rejects(()=>admit(giant),/record byte limit/,'raw checkpoint record byte limit');
 ok(released(giant)&&idle(f)&&live(f),'oversized raw record releases lease');checkpoint.set(0,oldRecord);
 for(const [label,change] of [['data',s=>{const b=s.store.at(2);s.store.update(2,{...b,volume:b.volume+1});}],['UI',s=>s.api.setTheme({background:'#334455'})],['revision',()=>{}]]){
  const stale=capture(f);admit(stale);change(f);rejects(()=>stale.buffer(0,0,1,label==='revision'?revision+1:revision),/StaleSourceError/,'stale '+label+' rejected');
  ok(released(stale)&&idle(f)&&live(f),'stale '+label+' releases source');retry(f,'lease reused after stale '+label);
 }
 const finalCapture=capture(f);admit(finalCapture);const finalTarget=target(finalCapture);copy(finalCapture,finalTarget);run(finalTarget);const discardedModel=finalTarget.model;probe.models.push(discardedModel);probe.sessions.push(discardedModel.dataIngestion);f.api.setTheme({grid:'#667788'});
 rejects(()=>finalCapture.finish(revision),/StaleSourceError/,'final source freshness checked after target ready');finalTarget.dispose();
 ok(released(finalCapture)&&idle(f)&&live(f)&&discardedModel.disposed===true&&finalTarget.checkpointBudget.usedBytes===0,'stale ready target discarded independently');
 retry(f,'lease reused after final freshness failure');
 const admissionStale=capture(f);admissionStale.step(1,revision);f.model.view.from+=.125;
 rejects(()=>admissionStale.step(1,revision),/StaleSourceError/,'incremental admission detects UI change');
 ok(released(admissionStale)&&idle(f)&&live(f),'admission stale releases source');
 Object.assign(globalThis,{nativeModel:f.model,nativeAPI:f.api,nativeInput:f.input,nativeSize:f.size});
 const registeredText=nativeSaveWorkspace(binding),registered=nativeWorkspaceSourceBegin(registeredText,binding,revision,805306368,1);
 ok(registered.registration===1&&f.model.dataIngestion.leased,'host registration binds source capture');
 rejects(()=>nativeWorkspaceSourceBegin(registeredText,binding,revision,805306368,1),/busy/,'duplicate registration cannot overwrite source');
 ok(nativeWorkspaceSourceAbort(2)===false&&nativeWorkspaceSourceCheck(registered.ticket,revision)===true,'wrong registration preserves source');
 ok(nativeWorkspaceSourceAbort(1)===true&&idle(f),'lost begin response can abort by registration');
 ok(nativeWorkspaceSourceAbort(1)===false,'lost abort response retries idempotently');
 rejects(()=>nativeWorkspaceSourceBegin(registeredText,binding,revision,805306368,1),/registration/,'retired registration cannot be reused');
 const nextRegistration=nativeWorkspaceSourceBegin(registeredText,binding,revision,805306368,2);
 ok(nativeWorkspaceSourceAbort(1)===false&&nativeWorkspaceSourceCheck(nextRegistration.ticket,revision)===true&&nativeWorkspaceSourceAbort(2)===true&&idle(f),'old registration cannot abort new job');
 for(const key of ['nativeModel','nativeAPI','nativeInput','nativeSize'])delete globalThis[key];
 model.dispose();emptyModel.dispose();empty.model.dispose();f.model.dispose();
 ok(probe.captures.every(released)&&probe.models.every(m=>m.disposed===true)&&probe.stores.every(s=>s.listeners.size===0)&&probe.sessions.every(s=>s.closed&&!s.leased)&&probe.targets.every(t=>t.closed&&t.checkpointBudget.usedBytes===0),'all captures models leases and listeners released');
 return JSON.stringify({case:'native-workspace-source-quickjs',passed:true,checks,scenarios:[...scenarios],scope:'builtin source capture and isolated target in standalone Linux QuickJS; no host runtime swap, SDK restore, JNI/JSC or device'});
})()
