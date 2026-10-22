// This executes generated and shipped JavaScript in Node VM, not a native SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
const canonical = await buildNativeBundle();
const shipped = await readFile(new URL('../native/Resources/aster-core.js', import.meta.url), 'utf8');
const fixture = `(()=>{
 const text='{"schema":"aster.drawings","version":1,"drawings":[{"id":"imported","type":"horizontal","panel":"price","points":[{"time":1e10,"price":1e20}],"style":{"color":"red"}}]}';
 const m=new Aster.ChartModel({visibleBars:20});m.drawings=new Aster.DrawingStore({maxDocumentChars:text.length});
 const old=m.drawings.add({id:'old',type:'horizontal',points:[{time:1,price:2}]});m.drawings.edit(old,{text:'keep'});
 const items=m.drawings.items,history=m.drawings.undoStack,selected=m.drawings.selected,serial=m.drawings.serial;
 let invalidations=0,error=null;const api=new Aster.ChartAPI(m,{invalidate(){invalidations++;}});
 try{api.loadDrawings(text);}catch(e){error=e.message;}
 const preserved=items===m.drawings.items&&history===m.drawings.undoStack&&selected===m.drawings.selected&&serial===m.drawings.serial;
 const rows=Array.from({length:30},(_,i)=>({time:1700000000000+i*60000,open:100,high:102,low:99,close:101,volume:1}));
 api.applyDataEvent({kind:'prepend',bars:rows});const initial={...m.view};
 m.view={from:3.25,to:18.75};m.follow=false;const time=m.store.at(7).time;
 api.applyDataEvent({kind:'prepend',bars:[{...rows[0],time:rows[0].time-60000}]});
 const historical={...m.view},anchor=m.store.at(8).time===time;m.dispose();
 const source=new Aster.ChartModel({visibleBars:20}),capture=new Aster.AsyncCapture(source,{kind:'prepend',bars:rows}),stage=new Aster.AsyncPrepared(capture.metadataJSON);
 try{for(let i=0;i<capture.buffers.length;i++){const n=capture.buffers[i].length;stage.target(i,0,n).set(capture.buffer(i,0,n));}
 stage.start();let turns=0;while(!stage.step(64).complete){if(++turns>1000)throw Error('Preparation bound');}
 const result=stage.finish(capture.ui(null,{width:800,height:480})).model;
 return JSON.stringify({error,preserved,invalidations,initial,historical,anchor,prepared:result.view,sourceLength:source.store.length});
 }finally{capture.release();stage.dispose();source.dispose();}
})()`;
function run(source) {
  const context = vm.createContext({});
  vm.runInContext(source, context, {timeout: 5000});
  return JSON.parse(vm.runInContext(fixture, context, {timeout: 5000}));
}
function verify(r) {
  assert.match(r.error ?? '', /^Drawing document: string limit 168$/, 'canonical import admission');
  assert.equal(r.preserved, true, 'rejected import retains prior state identity');
  assert.equal(r.invalidations, 2, 'only the two accepted data events notify');
  assert.deepEqual(r.initial, {from: 9.5, to: 29.5}, 'first history tail anchoring');
  assert.deepEqual(r.historical, {from: 4.25, to: 19.75}, 'existing history anchor rebasing');
  assert.equal(r.anchor, true);
  assert.deepEqual(r.prepared, {from: 9.5, to: 29.5}, 'prepared first history tail anchoring');
  assert.equal(r.sourceLength, 0);
}
for (const [name, source] of [['canonical', canonical], ['shipped', shipped]])
  test(`${name} JavaScript bridge keeps import admission and first/backfill view contracts`, () => verify(run(source)));
for (const [name, from, to, label] of [
  ['missing canonical admission', 'drawingDocument(items,this.maxDocumentChars);this.mutate', 'this.mutate', 'canonical import admission'],
  ['missing first-history follow', "||kind==='prepend'&&added>0&&store.length===added", '', 'first history tail anchoring'],
  ['missing prepared first-history follow', "||event.kind==='prepend'&&event.bars.length>0&&this.metadata.store.length===0", '', 'prepared first history tail anchoring'],
  ['missing existing-history rebase', 'this.view.from += added; this.view.to += added;', '', 'existing history anchor rebasing'],
]) test(`intentional ${name} fails its specific regression assertion`, t => {
  assert.equal(canonical.split(from).length, 2, 'unique fault site');
  const result = run(canonical.replace(from, to));
  let failure;
  assert.throws(() => verify(result), error => {
    failure = error;
    return error instanceof assert.AssertionError && error.message.includes(label);
  });
  t.diagnostic(failure.stack);
});
