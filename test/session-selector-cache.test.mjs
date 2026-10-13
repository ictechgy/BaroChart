import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore} from '../src/core/data.mjs';
import {IndicatorEngine} from '../src/core/indicators.mjs';
import {SessionCalendar} from '../src/core/markets.mjs';
import {portableSessionCalendar,vwapDefinition,pivotsDefinition} from '../src/core/session-studies.mjs';

const time=value=>Date.parse(value);
const bar=(stamp,price=10,volume=1)=>({time:typeof stamp==='number'?stamp:time(stamp),open:price,high:price,low:price,close:price,volume});
const spec=patch=>({timezone:'UTC',weekdays:[0,1,2,3,4,5,6],windows:[{open:'09:00',close:'16:00'}],...patch});
const calendar=patch=>portableSessionCalendar(spec(patch));
function trackParts(run){
 const original=Intl.DateTimeFormat.prototype.formatToParts;let calls=0;
 Intl.DateTimeFormat.prototype.formatToParts=function(...args){calls++;return original.apply(this,args);};
 try{return run(()=>calls);}finally{Intl.DateTimeFormat.prototype.formatToParts=original;}
}
const one=(def,row)=>def.create().step(row,0);
function near(actual,expected){
 assert.equal(actual.length,expected.length);
 for(let i=0;i<expected.length;i++)if(Number.isNaN(expected[i]))assert.ok(Number.isNaN(actual[i]),`Expected NaN at ${i}`);else assert.ok(Math.abs(actual[i]-expected[i])<=Math.max(1,Math.abs(expected[i]))*1e-11,`${actual[i]} != ${expected[i]} at ${i}`);
}
function twoPass(rows){
 const volume=rows.reduce((sum,row)=>sum+row.volume,0);if(!volume)return [NaN,NaN,NaN,NaN,0];
 const mean=rows.reduce((sum,row)=>sum+row.close*row.volume,0)/volume;
 const sigma=Math.sqrt(rows.reduce((sum,row)=>sum+row.volume*(row.close-mean)**2,0)/volume);
 return [mean,mean+2*sigma,mean-2*sigma,sigma,volume];
}

test('same exact timestamp reuses only the session key; price/volume and restore remain live',()=>{
 const def=vwapDefinition({calendar:calendar(),source:'close',deviation:2}),stamp=time('2026-03-09T09:00:00Z');
 trackParts(calls=>{
  near(one(def,bar(stamp,10)),[10,10,10,0,1]);assert.ok(calls()>0);const warmed=calls();
  near(one(def,bar(stamp,30,4)),[30,30,30,0,4]);assert.equal(calls(),warmed,'exact repeat must not call Intl');
  const instance=def.create(),initial=instance.snapshot();instance.step(bar(stamp,20,3),0);instance.restore(initial);near(instance.step(bar(stamp,40,2),0),[40,40,40,0,2]);assert.equal(calls(),warmed,'restore reuses selection, not financial state');
 });
});

test('successful null selections for gaps, closed dates, kinds and pre-anchor are memoized',()=>{
 const configs=[
  [{windows:[{open:'09:00',close:'11:30'},{open:'12:30',close:'16:00'}]},'2026-03-09T11:30:00Z'],
  [{},'2026-03-09T16:00:00Z'],
  [{exceptions:{'2026-03-10':[]}},'2026-03-10T09:00:00Z'],
  [{windows:[{open:'07:00',close:'08:00',kind:'extended'}]},'2026-03-09T07:30:00Z']
 ];
 for(const [patch,stamp] of configs){const def=vwapDefinition({calendar:calendar(patch),deviation:2});trackParts(calls=>{assert.ok(one(def,bar(stamp)).every(Number.isNaN));assert.ok(calls()>0);const warmed=calls();assert.ok(one(def,bar(stamp,100,100)).every(Number.isNaN));assert.equal(calls(),warmed,'null is a successful selected-session result');});}
 const def=vwapDefinition({calendar:calendar(),anchorTime:time('2026-03-09T10:00:00Z')});assert.deepEqual(one(def,bar('2026-03-09T09:00:00Z')),[NaN]);assert.deepEqual(one(def,bar('2026-03-09T09:00:00Z',999)),[NaN]);
});

test('portable selector has an exact-timestamp LRU bound of 512 and refreshes a hit',()=>{
 const def=vwapDefinition({calendar:calendar({windows:[{open:'00:00',close:'00:00'}]})}),stamp=time('2026-03-09T09:00:00Z');
 trackParts(calls=>{
  for(let i=0;i<512;i++)assert.deepEqual(one(def,bar(stamp+i)),[10]);const full=calls();
  one(def,bar(stamp));assert.equal(calls(),full,'hit refreshes the oldest selected key');
  one(def,bar(stamp+512));assert.ok(calls()>full,'distinct millisecond must be looked up');const added=calls();
  one(def,bar(stamp));assert.equal(calls(),added,'recent hit survives insertion 513');
  one(def,bar(stamp+1));assert.ok(calls()>added,'evicted key is looked up again');
 });
});

test('memo belongs to each immutable definition and cannot leak across calendar or kind contracts',()=>{
 const input=spec(),encoded=portableSessionCalendar(input),inside=vwapDefinition({calendar:encoded}),stamp='2026-03-09T09:30:00Z';
 input.windows[0].open='10:00';const outside=vwapDefinition({calendar:portableSessionCalendar(input)});
 const extended=vwapDefinition({calendar:calendar({windows:[{open:'09:00',close:'16:00',kind:'extended'}]}),kinds:'extended'});
 assert.deepEqual(one(inside,bar(stamp)),[10]);assert.deepEqual(one(outside,bar(stamp)),[NaN]);assert.deepEqual(one(extended,bar(stamp,30)),[30]);assert.deepEqual(one(inside,bar(stamp,40)),[40]);
});

test('DST ambiguity, nonexistent time and adjacent overlap errors are never cached or committed',()=>{
 const cases=[
  [{timezone:'America/New_York',weekdays:[0],windows:[{open:'01:30',close:'02:00'}],ambiguity:'reject'},'2026-11-01T06:45:00Z',/Ambiguous/],
  [{timezone:'America/New_York',weekdays:[0],windows:[{open:'02:30',close:'04:00'}]},'2026-03-08T08:00:00Z',/Nonexistent/],
  [{windows:[{open:'08:00',close:'12:00'},{open:'22:00',close:'09:00'}]},'2026-03-10T08:30:00Z',/Overlapping/]
 ];
 for(const [patch,stamp,error] of cases){const instance=vwapDefinition({calendar:calendar(patch),deviation:2}).create(),initial=instance.snapshot();trackParts(calls=>{for(let i=0;i<2;i++){const before=calls();assert.throws(()=>instance.step(bar(stamp),0),error);assert.ok(calls()>before,'failed lookup must be retried');assert.deepEqual(instance.snapshot(),initial);}});}
});

test('literal DST spring/fall, early-close and holiday outputs survive backward replay',()=>{
 const rows=[bar('2026-03-06T14:29:00Z'),bar('2026-03-06T14:30:00Z',10),bar('2026-03-09T13:29:00Z'),bar('2026-03-09T13:30:00Z',20),bar('2026-03-10T13:30:00Z'),bar('2026-03-11T17:00:00Z')];
 const def=vwapDefinition({calendar:calendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}],exceptions:{'2026-03-10':[],'2026-03-11':[{open:'09:30',close:'13:00'}]}})}),expected=[NaN,10,NaN,20,NaN,NaN];
 trackParts(calls=>{for(let i=0;i<rows.length;i++)assert.deepEqual(one(def,rows[i]),[expected[i]]);const warmed=calls();for(let i=rows.length-1;i>=0;i--)assert.deepEqual(one(def,rows[i]),[expected[i]]);assert.equal(calls(),warmed);});
 for(const [ambiguity,values] of [['earlier',[10,15]],['later',[NaN,20]]]){const fall=vwapDefinition({calendar:calendar({timezone:'America/New_York',weekdays:[0],windows:[{open:'01:30',close:'02:00'}],ambiguity})}),bars=[bar('2026-11-01T05:45:00Z',10),bar('2026-11-01T06:45:00Z',20)];trackParts(calls=>{let instance=fall.create();for(let i=0;i<bars.length;i++)assert.deepEqual(instance.step(bars[i],i),[values[i]]);const warmed=calls();instance=fall.create();for(let i=0;i<bars.length;i++)assert.deepEqual(instance.step(bars[i],i),[values[i]]);assert.equal(calls(),warmed);});}
});

test('actual checkpoint correction, current replacement, append and prepend match independent financial oracles',()=>{
 const stamps=['2026-03-06T22:00:00Z','2026-03-07T01:00:00Z','2026-03-07T06:00:00Z','2026-03-09T22:00:00Z','2026-03-10T01:00:00Z','2026-03-10T22:00:00Z','2026-03-11T01:00:00Z','2026-03-11T22:00:00Z'];
 const selected=new Map(stamps.map((stamp,i)=>[time(stamp),[ '2026-03-06','2026-03-06',null,'2026-03-09','2026-03-09',null,null,'2026-03-11'][i]]));
 const cal=calendar({weekdays:[1,2,3,4,5],windows:[{open:'22:00',close:'06:00'}],exceptions:{'2026-03-10':[]}}),store=new BarStore(stamps.map((stamp,i)=>bar(stamp,10+i*5,i%3))),engine=new IndicatorEngine(store,{checkpointSize:2});
 engine.add('v','vwap',{calendar:cal,source:'close',deviation:2});engine.add('a','vwap',{calendar:cal,source:'close',deviation:2,anchorTime:time(stamps[3])});engine.add('p','pivots',{calendar:cal});
 const check=()=>{
  const vector=engine.get('v').outputs,anchored=engine.get('a').outputs,pivots=engine.get('p').outputs;let date=null,current=[],previous=[],anchor=[];
  for(let i=0;i<store.length;i++){
   const row=store.at(i),key=selected.get(row.time);assert.notEqual(key,undefined,'test must supply a literal session oracle');
   if(key===null){near(['value','upper','lower','deviation','volume'].map(k=>vector[k][i]),[NaN,NaN,NaN,NaN,NaN]);near(['value','upper','lower','deviation','volume'].map(k=>anchored[k][i]),[NaN,NaN,NaN,NaN,NaN]);near(['pivot','r1','s1','r2','s2'].map(k=>pivots[k][i]),[NaN,NaN,NaN,NaN,NaN]);continue;}
   if(key!==date){previous=current;current=[];date=key;}current.push(row);near(['value','upper','lower','deviation','volume'].map(k=>vector[k][i]),twoPass(current));
   if(row.time>=time(stamps[3]))anchor.push(row);near(['value','upper','lower','deviation','volume'].map(k=>anchored[k][i]),row.time<time(stamps[3])?[NaN,NaN,NaN,NaN,NaN]:twoPass(anchor));
   let levels=[NaN,NaN,NaN,NaN,NaN];if(previous.length){const h=Math.max(...previous.map(b=>b.high)),l=Math.min(...previous.map(b=>b.low)),c=previous.at(-1).close,p=(h+l+c)/3;levels=[p,2*p-l,2*p-h,p+h-l,p-h+l];}near(['pivot','r1','s1','r2','s2'].map(k=>pivots[k][i]),levels);
  }
 };
 try{check();trackParts(calls=>{
  store.update(1,bar(stamps[1],24,3));check();assert.equal(calls(),0,'historical checkpoint replay only visits known timestamps');
  store.update(2,bar(stamps[2],1000,50));check();assert.equal(calls(),0,'cached outside-session result ignores price correction');
  store.update(7,bar(stamps[7],80,2));check();store.update(7,bar(stamps[7],70,2));check();assert.equal(calls(),0,'current-bar replacement reuses selection');
  const next='2026-03-12T01:00:00Z';selected.set(time(next),'2026-03-11');store.append(bar(next,90,1));check();assert.ok(calls()>0);const afterAppend=calls();store.update(1,bar(stamps[1],30,3));check();assert.equal(calls(),afterAppend,'backward replay remains correct after append');
  const old='2026-03-05T22:00:00Z';selected.set(time(old),'2026-03-05');store.prepend([bar(old,5,2)]);check();assert.ok(calls()>afterAppend,'new older timestamp is evaluated');
 });}finally{engine.dispose();assert.equal(store.listeners.size,0);}
});

test('generic mutable provider still needs invalidate and is not selected-timestamp memoized',()=>{
 let open='09:00';const generic=new SessionCalendar('UTC',()=>[{open,close:'16:00'}]),stamp=time('2026-03-09T09:30:00Z');
 assert.ok(generic.at(stamp));open='10:00';assert.ok(generic.at(stamp));generic.invalidate();assert.equal(generic.at(stamp),null);
 trackParts(calls=>{generic.at(stamp);const first=calls();assert.ok(first>0);generic.at(stamp);assert.ok(calls()>first,'generic calendar remains dynamic, not globally memoized');});
});

test('noncalendar defaults and numeric overflow retain their existing state contracts',()=>{
 trackParts(calls=>{const legacy=vwapDefinition(),instance=legacy.create();assert.deepEqual(instance.snapshot(),{session:NaN,pv:0,v:0});assert.deepEqual(instance.step(bar(0,10,1),0),[10]);assert.deepEqual(instance.step(bar(1,20,3),1),[17.5]);assert.deepEqual(legacy.outputs,['value']);const advanced=vwapDefinition({sessionMs:1e-308,source:'close',deviation:0}).create(),initial=advanced.snapshot();assert.throws(()=>advanced.step(bar(8640000000000000),0),/overflow|bucket/);assert.deepEqual(advanced.snapshot(),initial);assert.equal(calls(),0);});
 assert.deepEqual(pivotsDefinition().create().snapshot(),{session:NaN,high:NaN,low:NaN,close:NaN,levels:[NaN,NaN,NaN,NaN,NaN]});
});
