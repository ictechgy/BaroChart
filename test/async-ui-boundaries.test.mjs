import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncUICapture,AsyncUIImport} from '../src/core/async-ui.mjs';
import {AsyncCapture,AsyncPrepared} from '../src/core/async-state.mjs';
import {PrepareCapture,PreparedData} from '../src/core/prepare-state.mjs';
import {BarStore,seededColumns} from '../src/core/data.mjs';
import {ChartModel} from '../src/core/model.mjs';
import {ChartAPI} from '../src/core/api.mjs';
import {InteractionController} from '../src/core/interaction.mjs';
import {DRAWING_TYPES,drawingPointCount} from '../src/core/drawings.mjs';
import {safeCheckpointParse} from '../src/core/checkpoint-validation.mjs';

const size={width:1200,height:700};
function setup(kind='prepare') {
 const store=new BarStore();store.setColumns(seededColumns(32,42));
 const model=new ChartModel({store}),input=new InteractionController(model,()=>size),api=new ChartAPI(model,{controller:input});
 api.addSeries({id:'p',type:'candles',panel:'price'});api.addIndicator('e','ema');
 const capture=kind==='prepare'?new PrepareCapture(model,{kind:'seeded',count:64}):new AsyncCapture(model,{kind:'correction',bar:{...store.at(0),volume:store.at(0).volume+1}});
 const prepared=kind==='prepare'?new PreparedData(capture.metadataJSON):new AsyncPrepared(capture.metadataJSON);
 if(kind==='correction') {
  capture.buffers.forEach((values,slot)=>prepared.target(slot,0,values.length).set(values));
  capture.checkpoints.forEach((row,entry)=>row.keys.forEach((_,offset)=>prepared.checkpoint(entry,capture.checkpoint(entry,offset,1))));
 }
 prepared.start();while(!prepared.step(16).complete){}
 return {model,input,api,capture,prepared,dispose(){model.dispose();prepared.dispose();}};
}
function graph(store) {
 const unique=new Map(),records=[],frames=[store.items,...store.undoStack,...store.redoStack].map(frame=>frame.map(drawing=>{
  if(!unique.has(drawing)){unique.set(drawing,records.length);records.push(JSON.parse(JSON.stringify(drawing)));}
  return unique.get(drawing);
 }));
 return {frames,records,selected:store.selected,serial:store.serial,limits:[store.historyLimit,store.maxDrawings,store.maxPoints,store.maxDocumentChars,store.historyBytes]};
}
function nodeCount(value){return 1+(value&&typeof value==='object'?Object.values(value).reduce((n,v)=>n+nodeCount(v),0):0);}
function collect(x) {
 const source=new AsyncUICapture(x.capture,x.input,size),chunks=[];let refs=0,newRecords=0;
 for(;;) {
  const text=source.next(),packet=JSON.parse(text);assert(text.length<=262144);assert(Buffer.byteLength(text,'utf8')<=1048576);assert(nodeCount(packet)<=250000);safeCheckpointParse(text);
  if(packet.complete)break;
  assert(packet.refs.length<=64);assert(packet.records.reduce((n,r)=>n+r.drawing.points.length,0)<=2048);
  refs+=packet.refs.length;newRecords+=packet.records.length;chunks.push(text);
 }
 assert(source.check(x.input,size));
 const expected=graph(x.model.drawings);assert.equal(refs,expected.frames.reduce((n,f)=>n+f.length,0));assert.equal(newRecords,expected.records.length);
 return {source,chunks,expected};
}
function roundtrip(x) {
 const q=collect(x),target=new AsyncUIImport(q.source.headerJSON,x.prepared);q.chunks.forEach(text=>target.chunk(text));
 const result=target.finish();assert.deepEqual(graph(result.model.drawings),q.expected);
 result.model.drawings.redo();x.model.drawings.redo();assert.equal(result.model.drawings.save(),x.model.drawings.save());
 result.model.drawings.undo();x.model.drawings.undo();assert.equal(result.model.drawings.save(),x.model.drawings.save());return q;
}
function notes(x,text,count=64) {for(let i=0;i<count;i++)x.api.addDrawing({id:'note-'+i,type:'text',points:[{time:1700000000000,price:100}],text});}

for(const kind of ['prepare','correction'])test(kind+' packs64 accepted escaped-text drawings below wire limit',()=>{
 const x=setup(kind);try{notes(x,'\n'.repeat(2000));assert.equal(x.model.drawings.items.length,64);assert(x.model.drawings.save().length>262144);const q=roundtrip(x);assert(q.chunks.length>1);}finally{x.dispose();}
});
for(const [label,text] of [
 ['six-character control escapes','\0'.repeat(2000)],['quotes and backslashes','"\\'.repeat(1000)],['CJK UTF8','가'.repeat(2000)],
 ['paired emoji UTF16','🚀'.repeat(1000)],['line/paragraph separators','\u2028\u2029'.repeat(1000)],['mixed scalar/control','\0\n"\\가🚀'.repeat(250)],
])test('max public text boundary: '+label,()=>{
 const x=setup();try{notes(x,text);assert(text.length<=2000);x.api.editDrawing('note-63',{text:'alternate history'});x.api.undo();x.api.selectDrawing('note-1');roundtrip(x);}finally{x.dispose();}
});
test('one maximum legal record fits without per-record protocol fragments',()=>{
 const x=setup();try{
  const points=Array.from({length:2048},(_,i)=>({time:i%2 ? 8640000000000000 : -8640000000000000,price:i%2 ? Number.MAX_VALUE : -Number.MAX_VALUE}));
  x.api.addDrawing({id:'\0'.repeat(128),type:'freehand',points,text:'\0'.repeat(2000),style:{color:'#ffffffff',fill:'#000000ff',width:50,font:'normal '.repeat(32)+'96px '+ 'x'.repeat(26)},locked:true});
  const q=roundtrip(x);assert.equal(JSON.parse(q.chunks[0]).records.length,1);assert(q.chunks[0].length<180000);
 }finally{x.dispose();}
});
test('long finite freehand coordinates and max escaped text split before size overflow',()=>{
 const x=setup();try{
  for(let i=0;i<64;i++)x.api.addDrawing({id:'ink-'+i,type:'freehand',points:Array.from({length:32},(_,j)=>({time:8640000000000000-j,price:j%2 ? Number.MAX_VALUE : -Number.MAX_VALUE})),text:'\0'.repeat(2000)});
  const q=roundtrip(x);assert(q.chunks.length>1);assert(JSON.parse(q.chunks[0]).refs.length<64);
 }finally{x.dispose();}
});
test('size boundary commits only included slots and serializes a deferred drawing once',()=>{
 const x=setup();try{
  notes(x,'\0'.repeat(2000));x.api.editDrawing('note-63',{text:'history variant'});x.api.undo();
  const source=new AsyncUICapture(x.capture,x.input,size),known=new Set([x.model.drawings.items,...x.model.drawings.undoStack,...x.model.drawings.redoStack].flat()),counts=new Map(),stringify=JSON.stringify;
  let first;
  try {
   JSON.stringify=function(value,...args){if(known.has(value))counts.set(value,(counts.get(value)??0)+1);return stringify.call(this,value,...args);};
   first=JSON.parse(source.next());assert(first.refs.length<64);assert.equal(source.offset,first.refs.length);assert.equal(source.slots.size,first.records.length);assert(!source.slots.has(source.current[source.offset]));
   while(!JSON.parse(source.next()).complete){}
  }finally{JSON.stringify=stringify;}
  assert.equal(counts.size,known.size);for(const count of counts.values())assert.equal(count,1);
 }finally{x.dispose();}
});
test('mixed every drawing type retains complete deduplicated undo/redo graph at boundaries',()=>{
 const x=setup();try{
  notes(x,'\0'.repeat(2000));for(const type of DRAWING_TYPES)x.api.addDrawing({id:'type-'+type,type,points:['longposition','shortposition'].includes(type)?[{time:1700000000000,price:100},{time:1700000000000,price:type==='longposition'?90:110},{time:1700000000000,price:type==='longposition'?120:80},{time:1700000060000,price:100}]:Array.from({length:type==='freehand'?2048:drawingPointCount(type)},(_,i)=>({time:1700000000000+i*60000,price:100+i*.01})),text:'"\\가🚀'.repeat(250)});
  x.api.editDrawing('note-63',{text:'new note'});x.api.undo();x.api.selectDrawing('type-freehand');const q=roundtrip(x);
  assert(q.expected.frames.length>2);assert(q.expected.frames.flat().length>q.expected.records.length);
 }finally{x.dispose();}
});
test('discard after first boundary chunk preserves source and refuses incomplete target finish',()=>{
 const x=setup();try{
  notes(x,'\0'.repeat(2000));const before=graph(x.model.drawings),version=x.model.store.version,source=new AsyncUICapture(x.capture,x.input,size),target=new AsyncUIImport(source.headerJSON,x.prepared);
  target.chunk(source.next());assert.throws(()=>target.finish(),/incomplete/);assert.deepEqual(graph(x.model.drawings),before);assert.equal(x.model.store.version,version);
 }finally{x.dispose();}
});
test('UI mutation after first size-boundary chunk is rejected without source rollback',()=>{
 const x=setup();try{
  notes(x,'\0'.repeat(2000));const source=new AsyncUICapture(x.capture,x.input,size),target=new AsyncUIImport(source.headerJSON,x.prepared);target.chunk(source.next());x.api.editDrawing('note-0',{text:'changed after capture'});
  assert.throws(()=>source.check(x.input,size),/stale|UI/);assert.throws(()=>target.finish(),/incomplete/);assert.equal(x.model.drawings.items[0].text,'changed after capture');
 }finally{x.dispose();}
});
test('invalid Unicode scalar remains rejected without advancing slot/offset state',()=>{
 const y=setup();try{
  y.api.addDrawing({id:'valid-scalar',type:'text',points:[{time:1,price:1}],text:'valid'});
  y.api.addDrawing({id:'invalid-scalar',type:'text',points:[{time:1,price:1}],text:'\ud800'});const source=new AsyncUICapture(y.capture,y.input,size);
  assert.throws(()=>source.next(),/Unicode scalar/);assert.equal(source.offset,0);assert.equal(source.slots.size,0);
 }finally{y.dispose();}
});
