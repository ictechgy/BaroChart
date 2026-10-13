import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const marketsURL=new URL('../src/core/markets.mjs',import.meta.url).href;
const coreURL=new URL('../src/core/index.mjs',import.meta.url).href;
let timezoneCacheCase=0;
async function timezoneCacheTracked(run){
 const original=Intl.DateTimeFormat,inputs=[];
 Intl.DateTimeFormat=class extends original {constructor(...args){inputs.push(args[1]?.timeZone);super(...args);}};
 try{return await run(await import(marketsURL+'?timezone-cache-test='+ ++timezoneCacheCase),inputs);}finally{Intl.DateTimeFormat=original;}
}
function timezoneCacheChild(body){
 const script=`import assert from 'node:assert/strict';
 const A=await import(${JSON.stringify(coreURL)}),M=await import(${JSON.stringify(marketsURL)});
 const original=Intl.DateTimeFormat,weak=[],inputs=[],canonical=new Set();
 Intl.DateTimeFormat=class extends original {constructor(...args){super(...args);inputs.push(args[1]?.timeZone);weak.push(new WeakRef(this));canonical.add(this.resolvedOptions().timeZone);}};
 const collect=async()=>{await new Promise(r=>setImmediate(r));globalThis.gc();await new Promise(r=>setImmediate(r));globalThis.gc();await new Promise(r=>setImmediate(r));return weak.filter(ref=>ref.deref()!==undefined).length;};
 try{${body}}finally{Intl.DateTimeFormat=original;}`;
 return JSON.parse(execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:30000}));
}

test('512 genuine Intl case variants share one formatter after models dispose and explicit GC',t=>{
 const result=timezoneCacheChild(`
 const base='America/New_York',spellings=[];
 for(let n=0;n<512;n++){let at=0;const timezone=base.replace(/[a-z]/gi,char=>((n>>at++)&1)?char.toUpperCase():char.toLowerCase());spellings.push(timezone);
  const calendar=A.portableSessionCalendar({timezone,weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]}),model=new A.ChartModel();model.indicators.add('v','vwap',{calendar,source:'close'});model.dispose();assert.equal(model.store.listeners.size,0);
 }
 console.log(JSON.stringify({spellings:new Set(spellings).size,canonical:[...canonical],constructed:weak.length,aliveAfterGC:await collect(),scope:'Actual Node Intl constructors, WeakRef and explicit GC; not RSS/soak/native collection'}));`);
 t.diagnostic(JSON.stringify(result));assert.equal(result.spellings,512);assert.deepEqual(result.canonical,['America/New_York']);assert.equal(result.constructed,1);assert.equal(result.aliveAfterGC,1);
});
test('actual Intl bounded LRU32 refreshes hits rather than evicting the oldest insertion',async()=>{
 await timezoneCacheTracked((m,inputs)=>{
  const zones=Intl.supportedValuesOf('timeZone').slice(0,33);assert.equal(zones.length,33);for(const zone of zones.slice(0,32))m.zonedParts(0,zone);assert.equal(inputs.length,32);
  m.zonedParts(0,zones[0].toUpperCase());assert.equal(inputs.length,32);m.zonedParts(0,zones[32]);assert.equal(inputs.length,33);m.zonedParts(0,zones[0]);assert.equal(inputs.length,33);m.zonedParts(0,zones[1]);assert.equal(inputs.length,34);assert.equal(inputs.at(-1),zones[1]);
 });
});
test('96 actual timezone formatters retain exactly32 cache entries after explicit GC',t=>{
 const result=timezoneCacheChild(`
 const zones=Intl.supportedValuesOf('timeZone').slice(0,96);assert.equal(zones.length,96);
 for(const zone of zones)M.zonedParts(0,zone);
 console.log(JSON.stringify({requested:zones.length,constructed:weak.length,aliveAfterGC:await collect(),scope:'Observed Node V8 WeakRef retention after explicit GC; no universal GC guarantee'}));`);
 t.diagnostic(JSON.stringify(result));assert.equal(result.requested,96);assert.equal(result.constructed,96);assert.equal(result.aliveAfterGC,32);
});
test('cache key folds case while actual Intl constructor receives the original valid string',async()=>{
 await timezoneCacheTracked((m,inputs)=>{
  const timestamp=Date.parse('2026-03-09T13:30:00Z'),expected={month:'03',day:'09',year:'2026',hour:'09',minute:'30',second:'00'};
  assert.deepEqual(m.zonedParts(timestamp,'AmErIcA/New_YoRk'),expected);assert.deepEqual(m.zonedParts(timestamp,'america/new_york'),expected);assert.deepEqual(inputs,['AmErIcA/New_YoRk']);
  assert.equal(m.marketDate(timestamp,'AMERICA/NEW_YORK'),'2026-03-09');assert.equal(m.zonedEpoch('2026-03-09','09:30','aMeRiCa/nEw_yOrK'),timestamp);assert.equal(inputs.length,1);
 });
});
test('genuine Intl rejects Unicode Kelvin lookalike both cold and after ASCII zone warming',async()=>{
 const invalid='Asia/\u212Auala_Lumpur';
 assert.throws(()=>new Intl.DateTimeFormat('en-CA',{timeZone:invalid}),RangeError,'genuine Intl is the identifier authority');
 await timezoneCacheTracked((m,inputs)=>{for(let i=0;i<2;i++)assert.throws(()=>m.zonedParts(0,invalid),RangeError);assert.deepEqual(inputs,[invalid,invalid]);});
 await timezoneCacheTracked((m,inputs)=>{
  const stamp=Date.parse('2026-03-09T00:00:00Z'),expected={month:'03',day:'09',year:'2026',hour:'08',minute:'00',second:'00'};
  assert.deepEqual(m.zonedParts(stamp,'Asia/Kuala_Lumpur'),expected);m.zonedParts(stamp,'ASIA/KUALA_LUMPUR');assert.equal(inputs.length,1);
  for(let i=0;i<2;i++)assert.throws(()=>m.zonedParts(0,invalid),RangeError,'warm valid spelling must not authorize Unicode lookalike');
  assert.deepEqual(m.zonedParts(stamp,'asia/kuala_lumpur'),expected);assert.deepEqual(inputs,['Asia/Kuala_Lumpur',invalid,invalid]);
 });
});
test('nonstring/empty/oversized timezone keys reject without coercion or constructing Intl',async()=>{
 await timezoneCacheTracked((m,inputs)=>{
  let coercions=0;const object={toString(){coercions++;return 'UTC';}};
  for(const zone of [undefined,null,42,true,{},[],object,new String('UTC'),Symbol('UTC'),()=>{},'','x'.repeat(129)])assert.throws(()=>m.zonedParts(0,zone),TypeError);
  assert.equal(coercions,0);assert.equal(inputs.length,0);
 });
});
test('invalid zones do not evict valid cached zones; genuine Intl remains authoritative',async()=>{
 await timezoneCacheTracked((m,inputs)=>{
  const zones=Intl.supportedValuesOf('timeZone').slice(0,32);for(const zone of zones)m.zonedParts(0,zone);const before=inputs.length;
  for(const zone of ['Not/AZone','America/NoSuchCity',' UTC','UTC\0'])for(let i=0;i<2;i++)assert.throws(()=>m.zonedParts(0,zone),RangeError);
  const attempted=inputs.length;assert.equal(attempted,before+8);m.zonedParts(0,zones[0]);assert.equal(inputs.length,attempted);
  assert.deepEqual(m.zonedParts(Date.parse('2026-01-01T00:00:00Z'),'UTC'),{month:'01',day:'01',year:'2026',hour:'00',minute:'00',second:'00'});
 });
});
test('formatToParts-only compatibility preserves original constructor input and avoids caching late failures',async()=>{
 // This is an API-shape compatibility control, not an actual QuickJS/JNI run.
 // All date calculations still delegate to genuine Intl in this process.
 const original=Intl.DateTimeFormat,inputs=[];let resolvedCalls=0;
 Intl.DateTimeFormat=class {constructor(locale,options){inputs.push(options.timeZone);this.formatToParts=date=>new original(locale,options).formatToParts(date);}get resolvedOptions(){resolvedCalls++;throw Error('Shim has no resolvedOptions');}};
 try{
  const m=await import(marketsURL+'?timezone-cache-test='+ ++timezoneCacheCase);
  for(let i=0;i<2;i++)assert.throws(()=>m.zonedParts(0,'Missing/Timezone'),RangeError);assert.equal(inputs.length,2,'late rejected formatter must not be retained');
  const expected={month:'03',day:'09',year:'2026',hour:'09',minute:'30',second:'00'};assert.deepEqual(m.zonedParts(Date.parse('2026-03-09T13:30:00Z'),'America/New_York'),expected);m.zonedParts(0,'AMERICA/NEW_YORK');assert.deepEqual(inputs,['Missing/Timezone','Missing/Timezone','America/New_York']);assert.equal(resolvedCalls,0);
 }finally{Intl.DateTimeFormat=original;}
});
test('generic SessionCalendar provider caching and invalidate semantics remain unchanged',async()=>{
 await timezoneCacheTracked((m,inputs)=>{
  let open='09:00',providerCalls=0,closed=false;const c=new m.SessionCalendar('UTC',()=>{providerCalls++;return closed?[]:[{open,close:'16:00'}];});const initial=c.sessions('2026-03-09');assert.equal(providerCalls,1);assert.equal(initial[0].open,Date.parse('2026-03-09T09:00:00Z'));
  open='10:00';assert.equal(c.sessions('2026-03-09'),initial);assert.equal(providerCalls,1);c.invalidate();const next=c.sessions('2026-03-09');assert.equal(providerCalls,2);assert.notEqual(next,initial);assert.equal(next[0].open,Date.parse('2026-03-09T10:00:00Z'));
  assert.equal(c.bucket(Date.parse('2026-03-09T11:00:00Z'),'day').time,Date.parse('2026-03-09T00:00:00Z'));closed=true;c.invalidate();assert.equal(c.at(Date.parse('2026-03-09T11:00:00Z')),null);assert.equal(inputs.length,1,'calendar invalidation does not discard a reusable shared formatter');
 });
});
