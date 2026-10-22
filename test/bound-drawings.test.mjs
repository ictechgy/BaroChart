import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,ChartModel,ChartAPI,saveBoundDrawings,loadBoundDrawings} from '../src/core/index.mjs';
const identity={symbolId:'TEST',exchange:'VENUE',priceUnit:'USD',timeframe:'1m',adjustment:'raw',adjustmentVersion:'raw-v1'};
const symbol={id:'TEST',exchange:'VENUE',currency:'USD',timezone:'UTC',volumeUnit:'shares',priceDecimals:2,tickSize:.01,adjustment:'raw'};
function fixture(t,{metadata=true,controller=null}={}){
 const store=new BarStore([{time:0,open:10,high:11,low:9,close:10,volume:1},{time:60000,open:11,high:12,low:10,close:11,volume:2}]);
 const model=new ChartModel({store});let notices=0;const api=new ChartAPI(model,{controller,invalidate:()=>notices++});
 if(metadata)api.setSymbol(symbol);
 api.addDrawing({id:'keep',type:'horizontal',points:[{time:0,price:10}]});
 api.addDrawing({id:'redo',type:'horizontal',points:[{time:60000,price:11}]});
 api.undo();api.selectDrawing('keep');t.after(()=>model.dispose());
 return {model,api,get notices(){return notices;}};
}
function state(f){const m=f.model,d=m.drawings;return {items:d.items,undo:d.undoStack,redo:d.redoStack,undoRows:[...d.undoStack],redoRows:[...d.redoStack],selected:d.selected,transaction:d.transaction,serial:d.serial,historyBytes:d.retainedHistoryBytes,symbol:m.symbol,view:m.view,follow:m.follow,storeVersion:m.store.version,notices:f.notices};}
function unchanged(f,before){assert.deepEqual(state(f),before);for(const key of ['items','undo','redo','symbol','view','transaction'])assert.equal(state(f)[key],before[key],key);}
function document(f){return saveBoundDrawings(f.api,identity);}
function expectRejected(f,text,expected=identity){const before=state(f);assert.throws(()=>loadBoundDrawings(f.api,text,expected));unchanged(f,before);}

test('bound primary drawing roundtrip commits once, clears selection and supports undo/redo',t=>{
 const f=fixture(t),source=fixture(t);source.api.editDrawing('keep',{points:[{time:60000,price:77}],style:{color:'red',width:3}});
 const text=document(source),before=state(f);assert.equal(loadBoundDrawings(f.api,text,identity),undefined);
 assert.equal(f.model.drawings.items[0].points[0].price,77);assert.equal(f.notices,before.notices+1);
 assert.equal(f.model.drawings.undoStack.length,before.undoRows.length+1);assert.equal(f.model.drawings.redoStack.length,0);assert.equal(f.model.drawings.selected,null);
 f.api.undo();assert.equal(f.model.drawings.items[0].points[0].price,10);f.api.redo();assert.equal(f.model.drawings.items[0].points[0].price,77);
});
for(const key of Object.keys(identity))test('mismatched '+key+' rejects without changing target',t=>{
 const f=fixture(t),doc=JSON.parse(document(f));doc.identity[key]=key==='adjustment'?'split':doc.identity[key]+'-other';expectRejected(f,JSON.stringify(doc));
});
for(const [field,key] of [['id','symbolId'],['exchange','exchange'],['currency','priceUnit'],['adjustment','adjustment'],['adjustmentVersion','adjustmentVersion']])test('available chart '+field+' consistency required on save/load',t=>{
 const f=fixture(t),text=document(f),before=state(f);f.api.setSymbol({...symbol,[field]:field==='adjustment'?'split':'different'});const changed=state(f);
 assert.throws(()=>saveBoundDrawings(f.api,identity),/chart symbol/);unchanged(f,changed);expectRejected(f,text);assert.notEqual(changed.symbol,before.symbol);
 assert.equal(key in identity,true);
});
test('missing symbol metadata remains an explicit host assertion, not inferred verification',t=>{
 const f=fixture(t,{metadata:false}),text=document(f);loadBoundDrawings(f.api,text,identity);assert.equal(f.model.symbol,undefined);
});
test('absent or undefined symbol adjustmentVersion is not inferred',t=>{
 const f=fixture(t);assert.doesNotThrow(()=>document(f));f.api.setSymbol({...symbol,adjustmentVersion:undefined});assert.doesNotThrow(()=>loadBoundDrawings(f.api,document(f),identity));
});
test('identity snapshot is detached, accepts field reordering, and preserves exact case',t=>{
 const f=fixture(t),binding={...identity},text=saveBoundDrawings(f.api,binding);binding.timeframe='changed';
 const reverse=Object.fromEntries(Object.entries(identity).reverse());loadBoundDrawings(f.api,text,reverse);expectRejected(f,text,{...identity,timeframe:'1M'});
});
for(const [name,make] of [
 ['missing field',()=>{const v={...identity};delete v.timeframe;return v;}],
 ['unknown field',()=>({...identity,extra:'x'})],
 ['symbol field',()=>({...identity,[Symbol('x')]:'x'})],
 ['hidden field',()=>Object.defineProperty({...identity},'timeframe',{value:'1m',enumerable:false})],
 ['accessor',()=>Object.defineProperty({...identity},'timeframe',{enumerable:true,get(){throw new Error('must not invoke');}})],
 ['array',()=>Object.values(identity)],['null',()=>null],
 ['custom prototype',()=>Object.assign(Object.create({inherited:true}),identity)],
 ['blank',()=>({...identity,timeframe:' \t\n'})],['oversize',()=>({...identity,timeframe:'x'.repeat(129)})],
 ['wrong type',()=>({...identity,timeframe:60})],['adjustment enum',()=>({...identity,adjustment:'adjusted'})],
])test('identity rejects '+name+' on save/load without mutation',t=>{
 const f=fixture(t),text=document(f),before=state(f);assert.throws(()=>saveBoundDrawings(f.api,make()));unchanged(f,before);expectRejected(f,text,make());
});
test('identity accessor is never invoked',t=>{
 const f=fixture(t),text=document(f);let reads=0;const value={...identity};Object.defineProperty(value,'timeframe',{enumerable:true,get(){reads++;return '1m';}});
 assert.throws(()=>saveBoundDrawings(f.api,value));expectRejected(f,text,value);assert.equal(reads,0);
});
test('null prototype identity is supported with exactly the required slots',t=>{
 const f=fixture(t),binding=Object.assign(Object.create(null),identity);loadBoundDrawings(f.api,saveBoundDrawings(f.api,binding),binding);
});
for(const version of [1,2,3,4])test('unchanged primary drawing document v'+version+' is supported inside envelope',t=>{
 const f=fixture(t),doc=JSON.parse(document(f));doc.document.version=version;loadBoundDrawings(f.api,JSON.stringify(doc),identity);assert.equal(f.model.drawings.items.length,1);
});
test('position and visibility data retain their ordinary document versions',t=>{
 const f=fixture(t);f.api.addDrawing({id:'long',type:'longposition',points:[{time:0,price:10},{time:0,price:9},{time:0,price:12},{time:60000,price:10}]});
 assert.equal(JSON.parse(document(f)).document.version,3);f.api.setDrawingVisibility('long',false);const text=document(f);assert.equal(JSON.parse(text).document.version,4);loadBoundDrawings(f.api,text,identity);assert.equal(f.model.drawings.items[1].visible,false);
});
for(const patch of [{panel:'indicator'},{axisId:'other'},{seriesId:'other'}])test('secondary context rejects on save/load: '+JSON.stringify(patch),t=>{
 const f=fixture(t),doc=JSON.parse(document(f));Object.assign(doc.document.drawings[0],patch);expectRejected(f,JSON.stringify(doc));
 const old=f.model.drawings.items;f.model.drawings.items=doc.document.drawings;const before=state(f);assert.throws(()=>document(f),/primary price/);unchanged(f,before);f.model.drawings.items=old;
});
test('legacy raw document cannot silently acquire a bound identity; legacy APIs remain unchanged',t=>{
 const f=fixture(t),raw=f.api.saveDrawings();expectRejected(f,raw);const bound=document(f);const before=state(f);assert.throws(()=>f.api.loadDrawings(bound));unchanged(f,before);f.api.loadDrawings(raw);assert.equal(f.api.saveDrawings(),raw);
});
for(const patch of [{schema:'other'},{version:2},{identity:null},{document:null},{extra:1}])test('invalid envelope rejects atomically: '+JSON.stringify(patch),t=>{
 const f=fixture(t);expectRejected(f,JSON.stringify({...JSON.parse(document(f)),...patch}));
});
test('invalid nested geometry and normalized size both reject before any state commit',t=>{
 const f=fixture(t),doc=JSON.parse(document(f));doc.document.drawings[0].points[0].price=null;expectRejected(f,JSON.stringify(doc));
 const normalized=JSON.parse(document(f));normalized.document.drawings[0].style={color:'red'};
 const inner=JSON.stringify(normalized.document);f.model.drawings.maxDocumentChars=inner.length;expectRejected(f,JSON.stringify(normalized));
});
test('inner exact serialized budget is preserved, independently of envelope overhead',t=>{
 const f=fixture(t),raw=f.api.saveDrawings();f.model.drawings.maxDocumentChars=raw.length;const text=document(f);loadBoundDrawings(f.api,text,identity);
 f.model.drawings.maxDocumentChars=raw.length-1;const before=state(f);assert.throws(()=>document(f));unchanged(f,before);expectRejected(f,text);
});
test('maximally escaped identity fields fit bounded overhead with exact host matching',t=>{
 const f=fixture(t,{metadata:false}),binding=Object.fromEntries(Object.keys(identity).map(k=>[k,k==='adjustment'?'raw':'\u0001'.repeat(128)]));
 const raw=f.api.saveDrawings(),text=saveBoundDrawings(f.api,binding);assert.ok(text.length<=raw.length+8192);loadBoundDrawings(f.api,text,binding);
});
test('over-limit envelope is rejected before JSON parse or state mutation',t=>{
 const f=fixture(t);expectRejected(f,' '.repeat(8388608+8193));
});
test('configured smaller target limit also caps whitespace-padded envelope input',t=>{
 const f=fixture(t),text=document(f);f.model.drawings.maxDocumentChars=f.api.saveDrawings().length;
 expectRejected(f,text+' '.repeat(8193));loadBoundDrawings(f.api,text,identity);
});
test('active drawing transaction preserves its preview and history',t=>{
 const f=fixture(t),text=document(f);f.model.drawings.begin();const before=state(f);assert.throws(()=>document(f));unchanged(f,before);expectRejected(f,text);f.model.drawings.cancel();
});
for(const controller of [{gesture:{kind:'pan'},pointers:new Map()},{gesture:null,pointers:new Map([[1,{}]])}])test('active controller ownership rejects bound persistence',t=>{
 const f=fixture(t),text=document(f);controller.model=f.model;f.api.controller=controller;const before=state(f);assert.throws(()=>document(f));unchanged(f,before);expectRejected(f,text);assert.equal(f.api.controller,controller);
});
test('controller owned by another model rejects even while idle',t=>{
 const f=fixture(t),other=fixture(t),text=document(f);f.api.controller={model:other.model,gesture:null,pointers:new Map()};
 const before=state(f);assert.throws(()=>document(f),/owner mismatch/);unchanged(f,before);expectRejected(f,text);
});
for(const key of ['model','controller'])test('chart '+key+' accessor is not evaluated',t=>{
 const f=fixture(t),text=document(f),value=f.api[key];let reads=0;Object.defineProperty(f.api,key,{configurable:true,get(){reads++;return value;}});
 assert.throws(()=>document(f),/own data/);assert.throws(()=>loadBoundDrawings(f.api,text,identity),/own data/);assert.equal(reads,0);
 Object.defineProperty(f.api,key,{value,writable:true,configurable:true});
});
for(const key of ['drawings','symbol'])test('model '+key+' accessor is not evaluated',t=>{
 const f=fixture(t),text=document(f),value=f.model[key];let reads=0;Object.defineProperty(f.model,key,{configurable:true,get(){reads++;return value;}});
 assert.throws(()=>document(f),/own data/);assert.throws(()=>loadBoundDrawings(f.api,text,identity),/own data/);assert.equal(reads,0);
 Object.defineProperty(f.model,key,{value,writable:true,configurable:true});
});
test('disposed and non-ChartAPI owners reject',t=>{
 const f=fixture(t),text=document(f);f.model.dispose();assert.throws(()=>document(f));assert.throws(()=>loadBoundDrawings(f.api,text,identity));assert.throws(()=>saveBoundDrawings({},identity));assert.throws(()=>loadBoundDrawings({},text,identity));
});
test('existing invalidate callback failure is post-commit, not a rolled-back restore',t=>{
 const f=fixture(t),source=fixture(t);source.api.editDrawing('keep',{points:[{time:0,price:99}]});const text=document(source);f.api.invalidate=()=>{throw new Error('host redraw failed');};
 assert.throws(()=>loadBoundDrawings(f.api,text,identity),/host redraw/);assert.equal(f.model.drawings.items[0].points[0].price,99);
});
