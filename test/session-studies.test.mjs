import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore} from '../src/core/data.mjs';
import {IndicatorEngine,builtinIndicators} from '../src/core/indicators.mjs';
import {portableSessionCalendar,vwapDefinition as currentVWAP,pivotsDefinition as currentPivots,validateSessionCheckpoint} from '../src/core/session-studies.mjs';

const vwapDefinition=currentVWAP,pivotsDefinition=currentPivots;
const time=s=>Date.parse(s),bar=(stamp,price,volume=1)=>({time:typeof stamp==='number'?stamp:time(stamp),open:price,high:price,low:price,close:price,volume});
const config=(patch={})=>({timezone:'UTC',weekdays:[0,1,2,3,4,5,6],windows:[{open:'09:00',close:'16:00',kind:'regular'}],...patch});
const calendar=patch=>portableSessionCalendar(config(patch));
const run=(def,bars)=>{const instance=def.create();return bars.map((b,i)=>instance.step(b,i));};
const close=(actual,expected)=>{assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){assert.equal(Number.isNaN(actual[i]),Number.isNaN(expected[i]),`NaN[${i}]`);if(Number.isFinite(expected[i]))assert.ok(Math.abs(actual[i]-expected[i])<=Math.max(1,Math.abs(expected[i]))*1e-11,`${i}: ${actual[i]} != ${expected[i]}`);}};
function twoPass(rows,multiplier=2){const volume=rows.reduce((n,r)=>n+r.volume,0);if(!volume)return [NaN,NaN,NaN,NaN,0];const mean=rows.reduce((n,r)=>n+r.close*r.volume,0)/volume,variance=rows.reduce((n,r)=>n+r.volume*(r.close-mean)**2,0)/volume,sigma=Math.sqrt(variance);return [mean,mean+multiplier*sigma,mean-multiplier*sigma,sigma,volume];}

test('portable calendar is canonical, detached and uses trading-date windows',()=>{
 const input=config({weekdays:[5,1,3],exceptions:{'2026-03-10':[], '2026-03-09':[{open:'09:00',close:'12:00'}]}}),encoded=portableSessionCalendar(input),expected={timezone:'UTC',weekdays:[1,3,5],windows:[{open:'09:00',close:'16:00',kind:'regular'}],exceptions:{'2026-03-09':[{open:'09:00',close:'12:00',kind:'regular'}],'2026-03-10':[]},ambiguity:'earlier'};
 assert.equal(encoded,JSON.stringify(expected));assert.equal(portableSessionCalendar({...input,exceptions:{'2026-03-09':input.exceptions['2026-03-09'],'2026-03-10':[]}}),encoded);input.windows[0].open='10:00';assert.equal(JSON.parse(encoded).windows[0].open,'09:00');
});
test('portable calendar rejects unknown/prototype/accessor/array-shape input without invoking getters',()=>{
 let reads=0;const getter=Object.defineProperty(config(),'timezone',{get(){reads++;return 'UTC';},enumerable:true});
 for(const input of [getter,Object.assign(Object.create({hidden:1}),config()),{...config(),extra:1},{...config(),windows:[{open:'09:00',close:'16:00',extra:1}]},{...config(),weekdays:[1,1]},config({weekdays:[7]}),config({weekdays:[,1]}),config({windows:Object.assign([],{hidden:1})}),config({exceptions:JSON.parse('{"__proto__":[]}')}),config({exceptions:{'2026-02-29':[]}}),config({exceptions:null}),config({ambiguity:null}),config({windows:[{open:'09:00',close:'16:00',kind:null}]}),config({ambiguity:'guess'}),config({timezone:'Missing/Timezone'})])assert.throws(()=>portableSessionCalendar(input));
 assert.equal(reads,0);const win=Object.defineProperty({open:'09:00',close:'16:00'},'kind',{get(){reads++;return 'regular';},enumerable:true});assert.throws(()=>portableSessionCalendar(config({windows:[win]})));assert.equal(reads,0);
});
test('calendar bounds: 16 windows, 512 exceptions, 64KiB canonical text',()=>{
 const windows=Array.from({length:16},(_,i)=>({open:`${String(i).padStart(2,'0')}:00`,close:`${String(i).padStart(2,'0')}:30`,kind:'r'.repeat(120)})),exceptions=Object.fromEntries(Array.from({length:513},(_,i)=>[new Date(time('2024-01-01T00:00:00Z')+i*86400000).toISOString().slice(0,10),[]]));
 assert.throws(()=>portableSessionCalendar(config({windows:[...windows,{open:'20:00',close:'21:00'}]})));assert.throws(()=>portableSessionCalendar(config({exceptions})));
 const dates=Object.keys(exceptions).slice(0,512);assert.ok(portableSessionCalendar(config({exceptions:Object.fromEntries(dates.map(d=>[d,[]]))})).length<=65536);assert.throws(()=>portableSessionCalendar(config({windows,exceptions:Object.fromEntries(dates.map(d=>[d,windows]))})),/limit|64|size/i);
 assert.throws(()=>portableSessionCalendar(config({windows:[{open:'24:00',close:'02:00'}]})));assert.throws(()=>portableSessionCalendar(config({windows:[{open:'09:00',close:'12:00'},{open:'11:00',close:'16:00'}]})));
});
test('calendar counts UTF-8 bytes and rejects duplicate/nonfinite serialized keys',()=>{
 const windows=Array.from({length:16},(_,i)=>({open:`${String(i).padStart(2,'0')}:00`,close:`${String(i).padStart(2,'0')}:30`,kind:'한'.repeat(120)})),input=config({windows,exceptions:Object.fromEntries(Array.from({length:10},(_,i)=>[`2026-03-${String(i+1).padStart(2,'0')}`,windows]))});assert.ok(JSON.stringify(input).length<65536);assert.throws(()=>portableSessionCalendar(input),/64KiB/);
 const encoded=calendar();assert.throws(()=>vwapDefinition({calendar:encoded.replace('"timezone":"UTC"','"timezone":"UTC","timezone":"UTC"')}));assert.throws(()=>vwapDefinition({calendar:encoded.replace('[0,1,2,3,4,5,6]','[{"$asterNumber":"NaN"}]')}));
});
test('calendar consumer accepts JSON.stringify, whitespace, reordered keys and omitted defaults',()=>{
 const specs=[{timezone:'UTC',weekdays:[1],windows:[{open:'09:00',close:'16:00'}]},{windows:[{close:'16:00',open:'09:00'}],weekdays:[1],timezone:'UTC'}],bars=[bar('2026-03-09T08:59:00Z',999),bar('2026-03-09T09:00:00Z',10),bar('2026-03-09T10:00:00Z',20,3)];for(const spec of specs)for(const encoded of [JSON.stringify(spec),' \n'+JSON.stringify(spec,null,2)+'\n ']){assert.deepEqual(run(vwapDefinition({calendar:encoded}),bars),[[NaN],[10],[17.5]]);assert.deepEqual(run(pivotsDefinition({calendar:encoded}),bars),[[NaN,NaN,NaN,NaN,NaN],[NaN,NaN,NaN,NaN,NaN],[NaN,NaN,NaN,NaN,NaN]]);}
});
test('overlapping adjacent trading dates reject; an isolated overnight date remains valid',()=>{
 const windows=[{open:'08:00',close:'12:00'},{open:'22:00',close:'09:00'}],b=bar('2026-03-10T08:30:00Z',10);assert.throws(()=>run(vwapDefinition({calendar:calendar({windows})}),[b]),/overlap/i);assert.deepEqual(run(vwapDefinition({calendar:calendar({weekdays:[1],windows})}),[b]),[[10]]);
});
test('legacy default VWAP stays value-only with exact accumulation/zero-volume contract',()=>{
 const def=vwapDefinition(),bars=[bar(0,10,0),bar(1,10,1),bar(2,20,3),bar(86400000,30,0),bar(86400001,40,2)];assert.deepEqual(def.outputs,['value']);assert.deepEqual(run(def,bars),[[NaN],[10],[17.5],[NaN],[40]]);assert.deepEqual(def.create().snapshot(),{session:NaN,pv:0,v:0});
});
test('existing builtin names use the new definitions without increasing builtin count',()=>{
 assert.equal(builtinIndicators.size,33);assert.deepEqual(builtinIndicators.get('vwap')({deviation:2}).outputs,['value','upper','lower','deviation','volume']);assert.deepEqual(builtinIndicators.get('pivots')({calendar:calendar()}).create().snapshot(),{session:null,count:0,high:null,low:null,close:null,levels:[NaN,NaN,NaN,NaN,NaN]});
});
test('VWAP bands use independent two-pass volume-weighted population variance',()=>{
 const bars=[bar(0,10,0),bar(1,10,1),bar(2,20,3),bar(3,30,2),bar(4,999,0)],def=vwapDefinition({deviation:2});assert.deepEqual(def.outputs,['value','upper','lower','deviation','volume']);const actual=run(def,bars);for(let i=0;i<bars.length;i++)close(actual[i],twoPass(bars.slice(0,i+1)));close(actual[2],[17.5,17.5+2*Math.sqrt(18.75),17.5-2*Math.sqrt(18.75),Math.sqrt(18.75),4]);
});
test('source selection is explicit hlc3/close/hl2/ohlc4',()=>{
 const b={time:0,open:2,high:14,low:0,close:10,volume:5};for(const [source,value] of [['hlc3',8],['close',10],['hl2',7],['ohlc4',6.5]])close(run(vwapDefinition({source,deviation:0}),[b])[0],[value,value,value,0,5]);assert.throws(()=>vwapDefinition({source:'volume'}));
});
test('regular-session/lunch/holiday filtering preserves state and resets only trading date',()=>{
 const cal=calendar({weekdays:[1,2,3,4,5],windows:[{open:'09:00',close:'11:30'},{open:'12:30',close:'16:00'}],exceptions:{'2026-03-10':[]}}),def=vwapDefinition({calendar:cal,deviation:2}),bars=[bar('2026-03-09T08:59:00Z',999),bar('2026-03-09T09:00:00Z',10),bar('2026-03-09T11:30:00Z',999),bar('2026-03-09T12:30:00Z',20,3),bar('2026-03-09T16:00:00Z',999),bar('2026-03-10T09:00:00Z',999),bar('2026-03-11T09:00:00Z',30,2)];
 const actual=run(def,bars);for(const i of [0,2,4,5])assert.deepEqual(actual[i],[NaN,NaN,NaN,NaN,NaN]);close(actual[1],twoPass([bars[1]]));close(actual[3],twoPass([bars[1],bars[3]]));close(actual[6],twoPass([bars[6]]));
 const inst=def.create();inst.step(bars[1],0);const prior=inst.snapshot();inst.step(bars[2],1);assert.deepEqual(inst.snapshot(),prior);
});
test('chosen kinds and overnight windows share the starting trading date',()=>{
 const cal=calendar({windows:[{open:'07:00',close:'08:00',kind:'extended'},{open:'22:00',close:'06:00',kind:'regular'}]}),bars=[bar('2026-03-09T07:30:00Z',900),bar('2026-03-09T22:00:00Z',10),bar('2026-03-10T01:00:00Z',20,3),bar('2026-03-10T06:00:00Z',900),bar('2026-03-10T22:00:00Z',30)];
 assert.deepEqual(run(vwapDefinition({calendar:cal}),bars),[[NaN],[10],[17.5],[NaN],[30]]);assert.deepEqual(run(vwapDefinition({calendar:cal,kinds:'extended'}),bars),[[900],[NaN],[NaN],[NaN],[NaN]]);
});
test('New York spring DST session open changes UTC hour; holidays/early close are literal',()=>{
 const cal=calendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}],exceptions:{'2026-03-10':[],'2026-03-11':[{open:'09:30',close:'13:00'}]}}),bars=[bar('2026-03-06T14:29:00Z',999),bar('2026-03-06T14:30:00Z',10),bar('2026-03-09T13:29:00Z',999),bar('2026-03-09T13:30:00Z',20),bar('2026-03-10T13:30:00Z',999),bar('2026-03-11T17:00:00Z',999)];assert.deepEqual(run(vwapDefinition({calendar:cal}),bars),[[NaN],[10],[NaN],[20],[NaN],[NaN]]);
});
test('ambiguous DST earlier/later/reject and nonexistent local time use existing resolver',()=>{
 const cfg={timezone:'America/New_York',weekdays:[0],windows:[{open:'01:30',close:'02:00'}]},bars=[bar('2026-11-01T05:45:00Z',10),bar('2026-11-01T06:45:00Z',20)];assert.deepEqual(run(vwapDefinition({calendar:calendar({...cfg,ambiguity:'earlier'})}),bars),[[10],[15]]);assert.deepEqual(run(vwapDefinition({calendar:calendar({...cfg,ambiguity:'later'})}),bars),[[NaN],[20]]);assert.throws(()=>run(vwapDefinition({calendar:calendar({...cfg,ambiguity:'reject'})}),bars),/Ambiguous/);assert.throws(()=>run(vwapDefinition({calendar:calendar({...cfg,windows:[{open:'02:30',close:'04:00'}]})}),[bar('2026-03-08T08:00:00Z',10)]),/Nonexistent/);
});
test('explicit anchor is continuous across dates; calendar only filters included bars',()=>{
 const cal=calendar(),bars=[bar('2026-03-09T09:00:00Z',999),bar('2026-03-09T10:00:00Z',10),bar('2026-03-09T17:00:00Z',999),bar('2026-03-10T09:00:00Z',20,3)],params={calendar:cal,anchorTime:time('2026-03-09T10:00:00Z')};assert.deepEqual(run(vwapDefinition(params),bars),[[NaN],[10],[NaN],[17.5]]);assert.deepEqual(run(vwapDefinition({anchorTime:params.anchorTime}),bars),[[NaN],[10],[(10+999)/2],[(10+999+60)/5]]);
});
test('invalid params and conflicting session modes reject before calculation',()=>{
 for(const params of [{calendar:calendar(),sessionMs:86400000},{anchorTime:0,sessionMs:1},{calendar:{}},{calendar:'x'},{anchorTime:.5},{anchorTime:8640000000000001},{deviation:-1},{deviation:Infinity},{kinds:'regular,,extended'},{kinds:'regular'},{sessionMs:0}])assert.throws(()=>vwapDefinition(params));assert.throws(()=>pivotsDefinition({anchorTime:0}));
});
test('calendar pivots use only previous observed selected trading-date HLC and five levels',()=>{
 const cal=calendar({exceptions:{'2026-03-10':[]}}),bars=[{...bar('2026-03-09T09:00:00Z',10),high:14,low:8},{...bar('2026-03-09T15:00:00Z',12),high:16,low:6},bar('2026-03-09T17:00:00Z',1000),bar('2026-03-10T09:00:00Z',1000),bar('2026-03-11T09:00:00Z',20)],actual=run(pivotsDefinition({calendar:cal}),bars);for(const i of [0,1,2,3])assert.deepEqual(actual[i],[NaN,NaN,NaN,NaN,NaN]);close(actual[4],[34/3,50/3,20/3,64/3,4/3]);
 assert.deepEqual(pivotsDefinition().outputs,['pivot','r1','s1','r2','s2']);
});
test('checkpoint restore is detached and matches uninterrupted session/anchor output',()=>{
 const bars=[bar('2026-03-09T09:00:00Z',10),bar('2026-03-09T10:00:00Z',20,3),bar('2026-03-09T17:00:00Z',999),bar('2026-03-11T09:00:00Z',30),bar('2026-03-11T10:00:00Z',40)];
 for(const [name,make,params] of [['vwap',vwapDefinition,{calendar:calendar(),deviation:2}],['vwap',vwapDefinition,{calendar:calendar(),deviation:2,anchorTime:bars[0].time}],['pivots',pivotsDefinition,{calendar:calendar()}]]){const def=make(params),continuous=run(def,bars),a=def.create();for(let i=0;i<2;i++)a.step(bars[i],i);const snapshot=a.snapshot();assert.equal(validateSessionCheckpoint(name,params,snapshot,2),snapshot);const restored=def.create();restored.restore(snapshot);if(snapshot.levels)snapshot.levels[0]=999;for(let i=2;i<bars.length;i++)close(restored.step(bars[i],i),continuous[i]);}
});
test('new checkpoint validator enforces initial/index/shape/invariants and leaves legacy to existing validator',()=>{
 for(const [name,make,params] of [['vwap',currentVWAP,{deviation:2}],['pivots',currentPivots,{calendar:calendar()}]]){const def=make(params),inst=def.create(),initial=inst.snapshot();assert.equal(validateSessionCheckpoint(name,params,initial,0),initial);const b=bar('2026-03-09T09:00:00Z',10,2);inst.step(b,0);const state=inst.snapshot();assert.equal(validateSessionCheckpoint(name,params,state,1),state);assert.throws(()=>validateSessionCheckpoint(name,params,state,0));assert.throws(()=>validateSessionCheckpoint(name,params,state,-1));assert.throws(()=>validateSessionCheckpoint(name,params,{...state,extra:0},1));assert.throws(()=>validateSessionCheckpoint(name,params,Object.assign(Object.create({}),state),1));const bad={...state,count:2};assert.throws(()=>validateSessionCheckpoint(name,params,bad,1));if(name==='vwap'){for(const patch of [{v:-1},{m2:-1},{mean:Infinity},{pv:12345}])assert.throws(()=>validateSessionCheckpoint(name,params,{...state,...patch},1));}else {assert.throws(()=>validateSessionCheckpoint(name,params,{...state,low:11},1));assert.throws(()=>validateSessionCheckpoint(name,params,{...state,levels:[1,2,3,4,5]},1));}}
 assert.equal(validateSessionCheckpoint('vwap',{}, {session:NaN,pv:0,v:0},0),null);assert.equal(validateSessionCheckpoint('pivots',{}, {},0),null);
});
test('calendar checkpoint cannot claim an excluded trading date; closed-day initial state is valid',()=>{
 const params={calendar:calendar({weekdays:[1],exceptions:{'2026-03-09':[]}}),deviation:2},inst=currentVWAP(params).create(),initial=inst.snapshot();assert.equal(validateSessionCheckpoint('vwap',params,initial,20),initial);assert.throws(()=>validateSessionCheckpoint('vwap',params,{session:'2026-03-09',count:1,pv:10,v:1,mean:10,m2:0},20));
});
test('advanced numeric overflow fails deterministically without changing checkpoint state',()=>{
 const inst=vwapDefinition({source:'close',deviation:2}).create(),initial=inst.snapshot();assert.throws(()=>inst.step(bar(0,1e308,2),0),/overflow/);assert.deepEqual(inst.snapshot(),initial);close(inst.step(bar(1,10,1),1),[10,10,10,0,1]);
 const p=pivotsDefinition({calendar:calendar()}).create();p.step({...bar('2026-03-09T09:00:00Z',8e307),high:1e308,low:5e307},0);const prior=p.snapshot();assert.throws(()=>p.step(bar('2026-03-10T09:00:00Z',1),1),/overflow/);assert.deepEqual(p.snapshot(),prior);
});
test('advanced overflowing UTC session bucket rejects before checkpoint mutation',()=>{
 const inst=vwapDefinition({sessionMs:1e-308,deviation:0,source:'close'}).create(),initial=inst.snapshot();assert.throws(()=>inst.step(bar(8640000000000000,10),0),/overflow|bucket/);assert.deepEqual(inst.snapshot(),initial);
});
test('advanced weighted variance remains representable with a large price baseline',()=>{
 const rows=[bar(0,1e12+10,1),bar(1,1e12+20,3)],actual=run(vwapDefinition({source:'close',deviation:2}),rows);close(actual[1],twoPass(rows));assert.equal(actual[1][3],Math.sqrt(18.75));
});
test('actual indicator checkpoints preserve correction/current replacement/append against two-pass oracle',()=>{
 const T=time('2026-03-09T09:00:00Z'),bars=[bar(T,10),bar(T+3600000,20,3),bar(T+8*3600000,999),bar(T+86400000,30,2),bar(T+86400000+3600000,50),bar(T+86400000+2*3600000,90)],store=new BarStore(bars),engine=new IndicatorEngine(store,{checkpointSize:2}),params={calendar:calendar(),deviation:2};engine.register('session-fixture',vwapDefinition);engine.add('v','session-fixture',params);
 const check=()=>{const result=engine.get('v').outputs,now=Array.from({length:store.length},(_,i)=>store.at(i));for(let i=0;i<now.length;i++){const selected=i===2?null:now.slice(i<3?0:3,i+1).filter((_,j)=>i<3?j<2:true),expected=selected?twoPass(selected):[NaN,NaN,NaN,NaN,NaN];close(['value','upper','lower','deviation','volume'].map(k=>result[k][i]),expected);}};
 check();store.update(1,bar(bars[1].time,24,3));check();store.update(5,bar(bars[5].time,80,2));check();store.update(5,bar(bars[5].time,70,2));check();store.append(bar(T+86400000+3*3600000,100));check();engine.dispose();assert.equal(store.listeners.size,0);
});
test('calendar pivot checkpoints preserve historical correction/current replacement/new-session append',()=>{
 const T=time('2026-03-09T09:00:00Z'),bars=[bar(T,10),bar(T+3600000,20),bar(T+8*3600000,999),bar(T+86400000,30),bar(T+86400000+3600000,50),bar(T+86400000+2*3600000,90)],store=new BarStore(bars),engine=new IndicatorEngine(store,{checkpointSize:2});engine.register('session-pivots-fixture',pivotsDefinition);engine.add('p','session-pivots-fixture',{calendar:calendar()});
 const previousLevels=rows=>{const h=Math.max(...rows.map(r=>r.high)),l=Math.min(...rows.map(r=>r.low)),c=rows.at(-1).close,p=(h+l+c)/3;return [p,2*p-l,2*p-h,p+h-l,p-h+l];};
 const check=()=>{const outputs=engine.get('p').outputs;for(let i=0;i<store.length;i++){const previous=i<3?null:i<6?[store.at(0),store.at(1)]:[store.at(3),store.at(4),store.at(5)],expected=previous?previousLevels(previous):[NaN,NaN,NaN,NaN,NaN];close(['pivot','r1','s1','r2','s2'].map(k=>outputs[k][i]),expected);}};
 check();store.update(1,bar(bars[1].time,24));check();store.update(5,bar(bars[5].time,70));check();store.update(5,bar(bars[5].time,80));check();store.append(bar(T+2*86400000,40));check();engine.dispose();assert.equal(store.listeners.size,0);
});
