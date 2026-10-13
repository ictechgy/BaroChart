import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel,ChartAPI,portableSessionCalendar} from '../src/core/index.mjs';

// Independent review study-budget-repro.mjs: each calendar is individually
// valid; duplicating it into all128 allowed definitions exceeds the reader.
function calendar(exceptionCount,kind='regular') {
 const exceptions={};
 for(let i=0;i<exceptionCount;i++) {
  const date=new Date(Date.UTC(2020,0,1)+i*86400000).toISOString().slice(0,10);
  exceptions[date]=[{open:'09:30',close:'16:00',kind}];
 }
 return portableSessionCalendar({timezone:'UTC',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}],exceptions});
}
function source(t,encoded) {
 const model=new ChartModel();let invalidations=0;
 const api=new ChartAPI(model,{invalidate:()=>invalidations++});
 t.after(()=>model.dispose());
 for(let i=0;i<128;i++)api.addIndicator('v'+i,'vwap',{calendar:encoded,source:'close'});
 return {model,api,invalidations:()=>invalidations};
}
function snapshot(f) {
 return {store:f.model.store,version:f.model.store.version,entries:f.model.indicators.entries,
  rows:[...f.model.indicators.entries].map(([id,entry])=>({id,entry,params:{...entry.params},outputs:f.api.indicatorValues(id,'value')})),
  series:f.model.series,listeners:[...f.model.store.listeners],publicState:f.api.inspect(),invalidations:f.invalidations()};
}
function unchanged(f,before) {
 assert.equal(f.model.store,before.store);assert.equal(f.model.store.version,before.version);
 assert.equal(f.model.indicators.entries,before.entries);assert.equal(f.model.indicators.entries.size,before.rows.length);
 for(const row of before.rows) {
  assert.equal(f.model.indicators.entries.get(row.id),row.entry,'save preserves indicator '+row.id);
  assert.deepEqual(row.entry.params,row.params,'save preserves parameters '+row.id);
  assert.deepEqual(f.api.indicatorValues(row.id,'value'),row.outputs,'save preserves output '+row.id);
 }
 assert.equal(f.model.series,before.series);assert.deepEqual([...f.model.store.listeners],before.listeners);
 assert.deepEqual(f.api.inspect(),before.publicState);assert.equal(f.invalidations(),before.invalidations,'save is read-only, including rejection');
}
function restore(t,text) {
 const target=new ChartModel(),api=new ChartAPI(target);t.after(()=>target.dispose());
 const listeners=[...target.store.listeners],version=target.store.version;let result;
 assert.doesNotThrow(()=>{result=api.loadStudies(text);},'a successful save must be readable by the same public loader');
 assert.deepEqual(result,{indicators:128,series:0});assert.equal(target.indicators.entries.size,128);
 assert.equal(target.store.version,version);assert.deepEqual([...target.store.listeners],listeners,'import releases its temporary subscription');
 return {model:target,api};
}

test('within-budget128-study save/load remains supported (existing passing control)',t=>{
 const encoded=calendar(8),f=source(t,encoded),before=snapshot(f),text=f.api.saveStudies();
 assert.equal(typeof text,'string');assert.ok(text.length<8388608);unchanged(f,before);
 const target=restore(t,text);
 for(let i=0;i<128;i++)assert.deepEqual(target.api.indicatorValues('v'+i,'value'),f.api.indicatorValues('v'+i,'value'));
});

test('128 individually-valid large-calendar studies cannot save an unreadable document',t=>{
 const encoded=calendar(512,'regular'+'.'.repeat(55));
 assert.equal(Buffer.byteLength(encoded,'utf8'),61580,'reuses the independent review valid-calendar input');
 assert.ok(Buffer.byteLength(encoded,'utf8')<=65536);
 const f=source(t,encoded),before=snapshot(f);let text,error;
 try {text=f.api.saveStudies();}catch(caught){error=caught;}
 unchanged(f,before);
 if(error) {
  assert.ok(error instanceof RangeError,'valid source may reject only with an explicit document budget error');
  assert.match(error.message,/limit|budget|size|text|depth|nodes?|state/i);
  return;
 }
 assert.equal(typeof text,'string');
 // Do not couple this contract to a future deduplicated schema: if a saver
 // chooses to return a document, its reader must accept the same document.
 restore(t,text);
});
