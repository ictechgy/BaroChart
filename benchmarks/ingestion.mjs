// Portable fixture: no DOM, Node imports, clock, sampler or import side effects.
// Platform runners provide the core namespace and own input/render scheduling.
export const INGESTION_KINDS = Object.freeze(['current-update','append','correction-first','correction-middle','correction-tail','prepend','reset','period-set']);
export const INGESTION_SPEC = Object.freeze({seed:42,symbols:2,defaultBars:100000,width:1200,height:700,visibleBars:200,
  studies:['ema20','rsi14','NY-close-vwap5','aster.volume-direction@1/pressure2'],outputs:9,
  session:'Synthetic America/New_York Mon-Fri 09:30-16:00; no exchange holiday feed',
  periodSet:'Three existing public commands: removeIndicator, addIndicator, addSeries; not an atomic set-params API'});
const FIELDS=['time','open','high','low','close','volume'];
const MODULE='aster.volume-direction@1/pressure';
const calendarSpec={timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00',kind:'regular'}],exceptions:{}};
function requireCondition(ok,message){if(!ok)throw new Error(message);}
function integer(n,min,max,label){if(!Number.isSafeInteger(n)||n<min||n>max)throw new RangeError(label);return n;}
function nthSunday(year,month,n){return 1+(7-new Date(Date.UTC(year,month,1)).getUTCDay())%7+7*(n-1);}
// Independent US rule for this synthetic fixture, not the library calendar/Intl.
export function ingestionSession(time){const y=new Date(time).getUTCFullYear(),spring=Date.UTC(y,2,nthSunday(y,2,2),7),fall=Date.UTC(y,10,nthSunday(y,10,1),6),offset=time>=spring&&time<fall?4:5,d=new Date(time-offset*3600000),minute=d.getUTCHours()*60+d.getUTCMinutes();return d.getUTCDay()>=1&&d.getUTCDay()<=5&&minute>=570&&minute<960?d.toISOString().slice(0,10):null;}
function nextTradingMinute(time){let next=time+60000;while(ingestionSession(next)===null)next+=60000;return next;}
function columnsToRows(columns,n){return Array.from({length:n},(_,i)=>Object.fromEntries(FIELDS.map(k=>[k,columns[k][i]])));}
function changedBar(bar,seq){const close=bar.close+((seq%23)-11)*.0001;return {...bar,close,high:Math.max(bar.high,close),low:Math.min(bar.low,close),volume:bar.volume+seq%5};}
function hashBytes(bytes,initial=2166136261){let h=initial;for(const b of bytes)h=Math.imul(h^b,16777619)>>>0;return h;}
export function ingestionDigest(values){const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);let a=2166136261,b=2246822519;for(const v of values){view.setFloat64(0,Number.isNaN(v)?NaN:v,true);for(const n of bytes){a=Math.imul(a^n,16777619)>>>0;b=(Math.imul(b^n,3266489917)+374761393)>>>0;}}return [a,b];}
function outputsDigest(outputs){return Object.fromEntries(Object.entries(outputs).map(([k,a])=>[k,ingestionDigest(a)]));}
function symbolMetadata(id){return {id,exchange:'SYNTH',timezone:'America/New_York',currency:'USD',priceDecimals:2,tickSize:.01,volumeUnit:'shares',adjustment:'raw'};}
function emaSeries(){return {id:'ema-line',type:'line',panel:'price',indicator:'ema',offset:2,label:'EMA'};}
export function createIngestionFixture(core,{bars=INGESTION_SPEC.defaultBars,lineSeries=1}={}){
  integer(bars,32,100000,'Fixture bars');integer(lineSeries,1,32,'Line series');
  const owners=[];
  try{for(let symbol=0;symbol<2;symbol++){
    const columns=core.seededColumns(bars,42+symbol);let time=Date.parse('2026-03-02T14:30:00Z');for(let i=0;i<bars;i++){columns.time[i]=time;time=nextTradingMinute(time);}
    const original=columnsToRows(columns,bars),store=new core.BarStore(original),counts=[0,0,0,0],versions=[[],[],[],[]],stops=[],stats={attempted:0,completed:0,sourceEvents:0,sourcePublications:0,cancelled:0,invalidations:0,inputRollingFNV:2166136261,lastSequence:0,failed:0};
    const listener=i=>e=>{counts[i]++;const recent=versions[i];recent.push(e.version);if(recent.length>64)recent.shift();};
    for(const i of [0,1])stops.push(store.subscribe(listener(i)));
    const model=new core.ChartModel({store,visibleBars:200,panels:[{id:'price',weight:3},{id:'momentum',weight:1},{id:'volume',weight:1}]}),api=new core.ChartAPI(model,{invalidate:()=>stats.invalidations++});
    const owner={symbol:symbolMetadata('SYNTH:'+String.fromCharCode(65+symbol)),store,model,api,original,reference:original.map(b=>({...b})),counts,versions,stops,stats,initialVersion:store.version,emaPeriod:20};owners.push(owner);
    api.setSymbol(owner.symbol);api.registerIndicatorModule('aster.volume-direction',1);
    api.addIndicator('ema','ema',{period:20});api.addIndicator('rsi','rsi',{period:14});api.addIndicator('vwap','vwap',{calendar:core.portableSessionCalendar(calendarSpec),source:'close',deviation:2});api.addIndicator('module',MODULE,{shift:-2});
    model.addSeries({id:'candles',type:'candles',panel:'price'});model.addSeries(emaSeries());model.addSeries({id:'rsi-line',type:'line',panel:'momentum',indicator:'rsi'});
    for(const output of ['value','upper','lower'])model.addSeries({id:'vwap-'+output,type:'line',panel:'price',indicator:'vwap',output});
    model.addSeries({id:'pressure-line',type:'line',panel:'volume',indicator:'module',output:'signed'});
    for(let i=0;i<lineSeries;i++)model.addSeries({id:'close-'+i,type:'line',panel:'price',source:'close'});
    for(const i of [2,3])stops.push(store.subscribe(listener(i)));
    core.buildScene(model,1200,700);stats.invalidations=0;
  }}catch(e){for(const o of owners){o.model.dispose();for(const stop of o.stops)stop();}throw e;}
  return {core,owners,bars,lineSeries,disposed:false,scope:INGESTION_SPEC};
}
export function ingestionOperation(fixture,kind,symbol,sequence,{store:inputStore}={}){
  requireCondition(!fixture.disposed,'Fixture disposed');requireCondition(INGESTION_KINDS.includes(kind),'Operation kind');integer(symbol,0,1,'Symbol');integer(sequence,1,Number.MAX_SAFE_INTEGER,'Sequence');
  const owner=fixture.owners[symbol],store=inputStore??owner.store,last=store.at(store.length-1);let event,commands;
  if(kind==='current-update')event={kind:'update',bar:changedBar(last,sequence)};
  else if(kind==='append')event={kind:'append',bar:changedBar(last,sequence)} ,event.bar.time=nextTradingMinute(last.time);
  else if(kind.startsWith('correction-')){const i=kind==='correction-first'?0:kind==='correction-middle'?Math.floor(store.length/2):store.length-1;event={kind:'correction',bar:changedBar(store.at(i),sequence)};}
  else if(kind==='prepend'){const first=store.at(0);event={kind:'prepend',bars:Array.from({length:8},(_,i)=>({...first,time:first.time-(8-i)*60000,volume:1+i}))};}
  else if(kind==='reset')event={kind:'reset',bars:owner.original.map(b=>changedBar(b,sequence))};
  else{const period=sequence%2?21:20;commands=[['removeIndicator',['ema']],['addIndicator',['ema','ema',{period}]],['addSeries',[emaSeries()]]];}
  return {schema:'aster.ingestion.fixture',version:1,symbol,sequence,kind,...(event?{event}:{commands})};
}
function updateReference(owner,operation){
  const e=operation.event;
  if(!e){owner.emaPeriod=operation.commands[1][1][2].period;return;}
  if(e.kind==='append')owner.reference.push({...e.bar});
  else if(e.kind==='update')owner.reference[owner.reference.length-1]={...e.bar};
  else if(e.kind==='correction'){const i=owner.reference.findIndex(b=>b.time===e.bar.time);requireCondition(i>=0,'Reference correction timestamp');owner.reference[i]={...e.bar};}
  else if(e.kind==='prepend')owner.reference=e.bars.map(b=>({...b})).concat(owner.reference);
  else owner.reference=e.bars.map(b=>({...b}));
}
// Core dispatch only. Generation, JSON transport, reference/oracle/digest are
// separate caller-owned stages, never silently included in this boundary.
export function dispatchIngestionOperation(fixture,operation){const o=fixture.owners[operation.symbol];requireCondition(o&&operation.schema==='aster.ingestion.fixture'&&operation.version===1,'Operation envelope');requireCondition(operation.sequence>o.stats.lastSequence,'Per-symbol sequence');o.stats.attempted++;try{if(operation.event)o.api.applyDataEvent(operation.event);else for(const [name,args]of operation.commands)o.api.dispatch(name,args);o.stats.completed++;o.stats.lastSequence=operation.sequence;if(operation.event){o.stats.sourceEvents++;o.stats.sourcePublications++;}}catch(e){o.stats.failed++;throw e;}}
export function commitIngestionReference(fixture,operation){const o=fixture.owners[operation.symbol];updateReference(o,operation);const bytes=new TextEncoder().encode(JSON.stringify(operation));o.stats.inputRollingFNV=hashBytes(bytes,o.stats.inputRollingFNV);}
export function queryIngestionFixture(fixture,symbol){const o=fixture.owners[symbol];return Object.fromEntries(['ema','rsi','vwap','module'].map(id=>[id,o.model.indicators.get(id)]));}
export function renderIngestionFixture(fixture,symbol){return fixture.core.buildScene(fixture.owners[symbol].model,1200,700);}
function meanSeed(values,period,alpha){const a=new Float64Array(values.length).fill(NaN);let count=0,sum=0,value=NaN;for(let i=0;i<values.length;i++){const v=values[i];if(!Number.isFinite(v)){count=0;sum=0;value=NaN;continue;}if(count<period){count++;sum+=v;if(count===period)value=sum/period;}else value+=alpha*(v-value);a[i]=value;}return a;}
function oracle(rows,emaPeriod){
  const close=rows.map(b=>b.close),ema=meanSeed(close,emaPeriod,2/(emaPeriod+1)),deltas=close.map((v,i)=>i?v-close[i-1]:NaN),gains=meanSeed(deltas.map(v=>Math.max(0,v)),14,1/14),losses=meanSeed(deltas.map(v=>Math.max(0,-v)),14,1/14),rsi=Float64Array.from(gains,(g,i)=>!Number.isFinite(g)?NaN:g===0&&losses[i]===0?50:losses[i]===0?100:100-100/(1+g/losses[i])),vwap=Object.fromEntries(['value','upper','lower','deviation','volume'].map(k=>[k,new Float64Array(rows.length).fill(NaN)]));
  let date=null,prefix=[];const signed=new Float64Array(rows.length),cumulative=new Float64Array(rows.length);let total=0;
  for(let i=0;i<rows.length;i++){const b=rows[i];signed[i]=i?Math.sign(b.close-rows[i-1].close)*b.volume:0;total+=signed[i];cumulative[i]=total;const session=ingestionSession(b.time);if(!session)continue;if(session!==date){date=session;prefix=[];}prefix.push(b);let volume=0,pv=0;for(const p of prefix){volume+=p.volume;pv+=p.close*p.volume;}vwap.volume[i]=volume;if(!volume)continue;const mean=pv/volume;let variance=0;for(const p of prefix)variance+=p.volume*(p.close-mean)**2;const sigma=Math.sqrt(variance/volume);vwap.value[i]=mean;vwap.deviation[i]=sigma;vwap.upper[i]=mean+2*sigma;vwap.lower[i]=mean-2*sigma;}
  return {ema:{value:ema},rsi:{value:rsi},vwap,module:{signed,cumulative}};
}
function vectorChecks(actual,expected){let checked=0,maxRelativeError=0;for(const [name,array]of Object.entries(actual)){const wanted=expected[name];requireCondition(array.length===wanted.length,'Oracle length');for(let i=0;i<array.length;i++){const a=array[i],e=wanted[i];requireCondition(Number.isNaN(a)===Number.isNaN(e),name+' gap '+i);if(Number.isNaN(a))continue;const error=Math.abs(a-e)/Math.max(1,Math.abs(e));requireCondition(Number.isFinite(a)&&error<=1e-10,name+' oracle '+i);maxRelativeError=Math.max(error,maxRelativeError);checked++;}}return {checked,maxRelativeError};}
export function verifyIngestionFixture(fixture,{independentOracle=true}={}){
  const result=[];
  for(const o of fixture.owners){const {store,model,stats}=o;requireCondition(stats.attempted===stats.completed+stats.cancelled&&stats.failed===0,'Dropped/failed source operation');requireCondition(store.version===o.initialVersion+stats.sourcePublications,'Store epoch/version');requireCondition(store.length===o.reference.length,'Reference length');for(let i=0;i<store.length;i++)for(const k of FIELDS)requireCondition(Object.is(store.columns[k][i],o.reference[i][k]),'Source row '+i+'/'+k);
    requireCondition(o.counts.every(n=>n===stats.sourcePublications),'Notification count');requireCondition(store.listenerErrors.length===0&&store.pendingChanges.length===0&&!store.notifying,'Notification queue/error state');
    const expected=independentOracle?oracle(o.reference,o.emaPeriod):null,queries=queryIngestionFixture(fixture,o.symbol.id==='SYNTH:A'?0:1),freshStore=new fixture.core.BarStore(o.reference),fresh=new fixture.core.IndicatorEngine(freshStore),studies={};
    try{for(const [id,entry]of model.indicators.entries){if(!fresh.registry.has(entry.name))fresh.register(entry.name,model.indicators.registry.get(entry.name));const batch=fresh.add(id,entry.name,entry.params),live=queries[id];for(const [key,array]of Object.entries(live.outputs)){const expectedBatch=batch.outputs[key];requireCondition(array.length===expectedBatch.length,'Batch vector length');for(let i=0;i<array.length;i++)requireCondition(Object.is(array[i],expectedBatch[i]),'Full F64 incremental/batch '+id+'/'+key+'/'+i);}requireCondition(JSON.stringify(outputsDigest(live.outputs))===JSON.stringify(outputsDigest(batch.outputs)),'Full incremental/batch F64 digest '+id);const checks=expected?vectorChecks(live.outputs,expected[id]):null;studies[id]={outputs:outputsDigest(live.outputs),plotOffsets:live.plotOffsets,checks,computedFrom:live.computedFrom,computedUntil:live.computedUntil};}}
    finally{fresh.dispose();requireCondition(freshStore.listeners.size===0,'Fresh engine cleanup');}
    const q=o.api.indicatorValueAt('module','signed',0,{mode:'plot',asOfIndex:0});requireCondition(q.value===null&&q.sourceIndex===null&&q.sourceTime===null,'Negative-offset asof future leak');const observed=o.api.indicatorValueAt('module','signed',0,{mode:'plot',asOfIndex:2});requireCondition(observed.sourceIndex===2&&observed.sourceTime===store.columns.time[2],'Observed source offset');
    const scene=renderIngestionFixture(fixture,o.symbol.id==='SYNTH:A'?0:1),logicalOutputs=[...model.indicators.entries.values()].reduce((n,e)=>n+e.arrays.reduce((s,a)=>s+a.byteLength,0),0),checkpointStates=[...model.indicators.entries.values()].flatMap(e=>Array.from(e.checkpoints,([,state])=>state));
    result.push({symbol:o.symbol.id,length:store.length,capacity:store.capacity,version:store.version,sourceDigest:Object.fromEntries(FIELDS.map(k=>[k,ingestionDigest(store.columns[k].subarray(0,store.length))])),studies,counts:[...o.counts],recentNotificationVersions:o.versions.map(a=>[...a]),stats:{...stats,dropped:stats.attempted-stats.completed-stats.cancelled},scene:{storedBars:scene.stats.storedBars,commandCount:scene.commands.length},logicalMemory:{inputCapacityBytes:Object.values(store.columns).reduce((s,a)=>s+a.byteLength,0),outputCapacityBytes:logicalOutputs,outputVectors:9,checkpointCount:checkpointStates.length,checkpointJSONBytes:new TextEncoder().encode(JSON.stringify(checkpointStates)).length,retainedOracleRows:o.reference.length,retainedResetRows:o.original.length,scope:'Logical capacities plus explicit fixture reference rows; not process peak/leak or platform bridge allocations'}});
  }return result;
}
export function disposeIngestionFixture(fixture){if(fixture.disposed)return fixture.owners.map(o=>({symbol:o.symbol.id,listeners:o.store.listeners.size}));fixture.disposed=true;return fixture.owners.map(o=>{o.model.dispose();for(const stop of o.stops)stop();requireCondition(o.store.listeners.size===0,'Owned listener cleanup');return {symbol:o.symbol.id,listeners:o.store.listeners.size,pendingChanges:o.store.pendingChanges.length,modelDisposed:o.model.disposed};});}
export function verifyIngestionNotificationQueue(core,{burst=32}={}){
  integer(burst,1,256,'Nested queue burst');const store=new core.BarStore(columnsToRows(core.seededColumns(64,42),64)),seen=[[],[]];let armed=true;
  const a=store.subscribe(e=>{seen[0].push(e.version);if(!armed)return;armed=false;for(let i=0;i<burst;i++){const b=store.at(store.length-1);store.update(store.length-1,changedBar(b,i+1));}}),model=new core.ChartModel({store}),api=new core.ChartAPI(model);api.addIndicator('ema','ema',{period:20});const b=store.subscribe(e=>{seen[1].push(e.version);const current=model.indicators.get('ema');requireCondition(current.outputs.value.length===store.length,'Nested latest query');}),initial=store.version;
  try{store.update(store.length-1,changedBar(store.at(store.length-1),42));const expected=Array.from({length:burst+1},(_,i)=>initial+i+1);requireCondition(JSON.stringify(seen[0])===JSON.stringify(expected)&&JSON.stringify(seen[1])===JSON.stringify(expected),'Nested FIFO versions');requireCondition(store.pendingChanges.length===0&&!store.notifying&&store.listenerErrors.length===0,'Nested queue drained');return {burst,events:burst+1,FIFOVersions:expected,dropped:0,queueDrained:true};}finally{model.dispose();a();b();requireCondition(store.listeners.size===0,'Nested ledger cleanup');}
}

// Stages O(packet) shadow values, not an O(history) clone. References/generation
// remain outside the core timer. The same immutable packet feeds scalar/batch.
export function ingestionPacket(fixture,kind,symbol,firstSequence,count=8,{reference=false}={}){
  requireCondition(['current-update','append','correction-first','correction-middle','correction-tail'].includes(kind),'Batch supports ordered tail/correction events only');integer(count,1,4096,'Packet count');integer(firstSequence,0,Number.MAX_SAFE_INTEGER-count,'Packet sequence');
  const owner=fixture.owners[symbol],base=reference?{length:owner.reference.length,at:i=>({...owner.reference[i]})}:owner.store,staged=new Map(),shadow={length:base.length,at(i){return {...(staged.get(i)??base.at(i))};}},operations=[];
  for(let i=0;i<count;i++){const operation=ingestionOperation(fixture,kind,symbol,firstSequence+i+1,{store:shadow});operations.push(operation);let index;if(operation.event.kind==='append')index=shadow.length++;else if(operation.event.kind==='update')index=shadow.length-1;else index=kind==='correction-first'?0:kind==='correction-middle'?Math.floor(shadow.length/2):shadow.length-1;staged.set(index,operation.event.bar);}
  return {schema:'aster.ingestion.packet-fixture',version:1,symbol,kind,firstSequence,operations,events:operations.map(o=>o.event)};
}
export function dispatchIngestionPacket(fixture,packet,{strategy='scalar'}={}){
  requireCondition(packet.schema==='aster.ingestion.packet-fixture'&&packet.version===1,'Packet fixture envelope');const owner=fixture.owners[packet.symbol],count=packet.events.length;
  if(strategy==='scalar'){for(const op of packet.operations)dispatchIngestionOperation(fixture,op);return {events:count,version:owner.store.version,length:owner.store.length,capacity:owner.store.capacity,sourcePublications:count};}
  requireCondition(strategy==='atomic'&&typeof owner.api.applyDataEvents==='function','Candidate applyDataEvents unavailable');requireCondition(packet.firstSequence===owner.stats.lastSequence,'Atomic packet sequence');
  const receipt=owner.api.applyDataEvents(packet.events);owner.stats.attempted+=count;owner.stats.completed+=count;owner.stats.sourceEvents+=count;owner.stats.sourcePublications++;owner.stats.lastSequence=packet.firstSequence+count;return receipt;
}
export function commitIngestionPacketReference(fixture,packet){for(const operation of packet.operations)commitIngestionReference(fixture,operation);}
export function configureIngestionFixture(fixture,options={}){return fixture.owners.map((o,symbol)=>{requireCondition(typeof o.api.configureDataIngestion==='function','Candidate ingestion session unavailable');const policy={streamId:'fixture-'+symbol,generation:1,firstSequence:0,maxQueuedEvents:64,maxQueuedBytes:64*49,maxBatchEvents:8,...options};o.api.configureDataIngestion(policy);return policy;});}
export function ingestionLedger(api){const s=api.dataIngestionStats();requireCondition(s&&typeof s==='object','Ingestion stats snapshot');return s;}
export function assertIngestionLedger(stats){requireCondition(stats.accepted===stats.applied+stats.cancelled+stats.pendingEvents,'Accepted/applied/cancelled/pending conservation');requireCondition(stats.pendingBytes===stats.pendingEvents*49,'Pending typed bytes');requireCondition(stats.nextSequence===stats.policy.firstSequence+stats.accepted,'Accepted sequence cursor');requireCondition(stats.peakPendingEvents<=stats.policy.maxQueuedEvents&&stats.peakPendingBytes<=stats.policy.maxQueuedBytes,'Queue pressure bound');return true;}
export function enqueueIngestionPacket(fixture,packet){const owner=fixture.owners[packet.symbol],before=ingestionLedger(owner.api),policy=before.policy;assertIngestionLedger(before);const receipt=owner.api.enqueueDataEvents({streamId:policy.streamId,generation:policy.generation,firstSequence:packet.firstSequence,events:packet.events});requireCondition(receipt.events===packet.events.length,'Whole packet acceptance');owner.stats.attempted+=receipt.events;owner.stats.sourceEvents+=receipt.events;owner.stats.lastSequence=receipt.nextSequence;commitIngestionPacketReference(fixture,packet);assertIngestionLedger(ingestionLedger(owner.api));return receipt;}
export function drainIngestionFixture(fixture,symbol,maxEvents=8){const owner=fixture.owners[symbol],receipt=owner.api.drainDataEvents(maxEvents);if(receipt.events){owner.stats.completed+=receipt.events;owner.stats.sourcePublications++;}assertIngestionLedger(ingestionLedger(owner.api));return receipt;}
export function cancelIngestionFixture(fixture,symbol){const owner=fixture.owners[symbol],receipt=owner.api.cancelDataEvents();owner.stats.cancelled+=receipt.events;owner.reference=columnsToRows(owner.store.columns,owner.store.length);assertIngestionLedger(ingestionLedger(owner.api));return receipt;}
export function verifyIngestionQueueFixture(fixture){
  configureIngestionFixture(fixture,{maxQueuedEvents:16,maxQueuedBytes:16*49,maxBatchEvents:8});const checks=[];
  for(const symbol of [0,1]){const owner=fixture.owners[symbol],first=ingestionPacket(fixture,'append',symbol,0,8,{reference:true});enqueueIngestionPacket(fixture,first);const second=ingestionPacket(fixture,'current-update',symbol,8,8,{reference:true});enqueueIngestionPacket(fixture,second);const third=ingestionPacket(fixture,'current-update',symbol,16,8,{reference:true}),before=ingestionLedger(owner.api);let error;
    try{enqueueIngestionPacket(fixture,third);}catch(e){error=e;}requireCondition(error?.code==='QUEUE_BUDGET','Whole packet pressure reject');requireCondition(ingestionLedger(owner.api).nextSequence===before.nextSequence,'Reject cannot advance sequence');
    owner.api.pauseDataIngestion();try{enqueueIngestionPacket(fixture,third);throw new Error('Paused queue accepted');}catch(e){requireCondition(e.code==='PAUSED','Pause explicit reject');}owner.api.resumeDataIngestion();drainIngestionFixture(fixture,symbol,8);enqueueIngestionPacket(fixture,third);drainIngestionFixture(fixture,symbol,8);drainIngestionFixture(fixture,symbol,8);checks.push({symbol,afterRetry:ingestionLedger(owner.api)});
    const fourth=ingestionPacket(fixture,'append',symbol,24,8,{reference:true});enqueueIngestionPacket(fixture,fourth);const saved=owner.api.saveDataIngestion();const retired=owner.api.cancelDataEvents();requireCondition(retired.events===8,'Explicitly retire live pending before document restore');owner.api.loadDataIngestion(saved);requireCondition(owner.api.saveDataIngestion()===saved,'Pending session save/load bytes');const cancelled=cancelIngestionFixture(fixture,symbol);requireCondition(cancelled.events===8&&cancelled.firstSequence===24&&cancelled.lastSequence===31,'Explicit cancel range');const fifth=ingestionPacket(fixture,'append',symbol,32,8,{reference:true});enqueueIngestionPacket(fixture,fifth);drainIngestionFixture(fixture,symbol,8);checks.push({symbol,retiredLiveSession:retired,restoredDocumentCounters:true,cancelled,afterCancelRetry:ingestionLedger(owner.api)});
  }return {checks,proof:verifyIngestionFixture(fixture)};
}
