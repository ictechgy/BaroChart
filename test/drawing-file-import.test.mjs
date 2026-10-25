import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {ChartModel,ChartAPI,BarStore,InteractionController} from '../src/core/index.mjs';
import {createDrawingFileImport} from '../examples/web/drawing-file-import.mjs';
const demo=await readFile(new URL('../examples/web/demo.mjs',import.meta.url),'utf8');
const doc=(id='incoming',price=2)=>JSON.stringify({schema:'aster.drawings',version:1,drawings:[{id,type:'horizontal',panel:'price',points:[{time:0,price}]}]});
function deferred(id='incoming'){let resolve,reject,reads=0;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {file:{size:100,text(){reads++;return promise;}},resolve(text=doc(id)){resolve(text);},reject(error=new Error('read failed')){reject(error);},get reads(){return reads;}};}
function fixture(t){
 const store=new BarStore([{time:0,open:1,high:2,low:0,close:1,volume:1}]),model=new ChartModel({store});
 const controller=new InteractionController(model,()=>({width:800,height:500}));let notices=0;
 const api=new ChartAPI(model,{controller,invalidate(){notices++;}}),chart={model,controller,api,disposed:false};
 api.addDrawing({id:'keep',type:'horizontal',points:[{time:0,price:1}]});api.editDrawing('keep',{text:'future'});api.undo();api.selectDrawing('keep');
 const statuses=[],errors=[];let current=chart;
 const importer=createDrawingFileImport({getChart:()=>current,onStatus:message=>statuses.push(message),onError:(error,state)=>errors.push({error,...state})});
 t.after(()=>model.dispose());
 return {store,model,controller,api,chart,importer,statuses,errors,set current(value){current=value;},get current(){return current;},get notices(){return notices;}};
}
function state(f){const d=f.model.drawings;return {items:d.items,undo:d.undoStack,redo:d.redoStack,undoRows:[...d.undoStack],redoRows:[...d.redoStack],selected:d.selected,transaction:d.transaction,serial:d.serial,history:d.retainedHistoryBytes,notices:f.notices};}
function unchanged(f,before){assert.deepEqual(state(f),before);for(const key of ['items','undo','redo','transaction'])assert.equal(state(f)[key],before[key],key);}
test('current read imports exactly once with existing history/selection semantics',async t=>{
 const f=fixture(t),a=deferred(),before=state(f),pending=f.importer.read(a.file);assert.equal(a.reads,1);unchanged(f,before);a.resolve();assert.deepEqual(await pending,{status:'loaded'});
 assert.equal(f.model.drawings.items[0].id,'incoming');assert.equal(f.model.drawings.undoStack.length,before.undoRows.length+1);assert.equal(f.model.drawings.redoStack.length,0);assert.equal(f.model.drawings.selected,null);assert.equal(f.notices,before.notices+1);assert.equal(f.statuses.length,1);f.api.undo();assert.equal(f.model.drawings.items[0].id,'keep');
});
for(const order of ['older-first','newer-first'])test('latest selected file wins: '+order,async t=>{
 const f=fixture(t),a=deferred('older'),b=deferred('newer'),pa=f.importer.read(a.file),pb=f.importer.read(b.file);
 if(order==='older-first'){a.resolve();assert.equal((await pa).status,'superseded');b.resolve();await pb;}else{b.resolve();await pb;const before=state(f);a.resolve();assert.equal((await pa).status,'superseded');unchanged(f,before);}
 assert.equal(f.model.drawings.items[0].id,'newer');assert.equal(f.statuses.length,1);assert.equal(f.errors.length,0);
});
for(const outcome of ['resolve','reject'])test('superseded '+outcome+' never changes later status or state',async t=>{
 const f=fixture(t),a=deferred('old'),b=deferred('new'),pa=f.importer.read(a.file),pb=f.importer.read(b.file);b.resolve();await pb;const before=state(f),messages=[...f.statuses];a[outcome]();assert.equal((await pa).status,'superseded');unchanged(f,before);assert.deepEqual(f.statuses,messages);assert.equal(f.errors.length,0);
});
for(const [name,change] of [
 ['edit',f=>f.api.editDrawing('keep',{text:'new local work'})],
 ['selection',f=>f.api.selectDrawing(null)],
 ['undo',f=>f.api.undo()],['redo',f=>f.api.redo()],
 ['delete',f=>f.api.deleteDrawing('keep')],
 ['add',f=>f.api.addDrawing({id:'new',type:'horizontal',points:[{time:0,price:4}]})],
 ['hide',f=>f.api.setDrawingVisibility('keep',false)],
 ['transaction',f=>f.model.drawings.begin()],
 ['gesture',f=>{f.controller.gesture={kind:'pan'};}],
 ['pointer',f=>f.controller.pointers.set(7,{x:1,y:1})],
 ['symbol replacement',f=>{f.model.symbol={id:'new'};}],
 ['store replacement',f=>{f.model.store=new BarStore();}],
 ['chart disposed',f=>{f.chart.disposed=true;}],
 ['model disposed',f=>f.model.dispose()],
 ['chart replacement',f=>{f.current={...f.chart};}],
 ['API replacement',f=>{f.chart.api=new ChartAPI(f.model);}],
 ['controller replacement',f=>{f.chart.controller=new InteractionController(f.model,()=>({width:1,height:1}));}],
 ['owner unavailable',f=>{f.current=null;}],
])test('intervening '+name+' discards pending import and preserves newer state',async t=>{
 const f=fixture(t),a=deferred(),pending=f.importer.read(a.file);change(f);const before=state(f);a.resolve();assert.equal((await pending).status,'stale');unchanged(f,before);assert.equal(f.statuses.length,1);assert.match(f.statuses[0],/바뀌어/);assert.equal(f.errors.length,0);
});
test('old disposed model cannot mutate a journal reused by its replacement',async t=>{
 const f=fixture(t),a=deferred(),pending=f.importer.read(a.file),next=new ChartModel({store:f.store});next.drawings=f.model.drawings;f.current={model:next,api:new ChartAPI(next)};f.model.dispose();const before=state(f);a.resolve();assert.equal((await pending).status,'stale');unchanged(f,before);assert.equal(next.drawings.items[0].id,'keep');next.dispose();
});
for(const kind of ['transaction','gesture','pointer'])test('already active '+kind+' is rejected before file read',async t=>{
 const f=fixture(t),a=deferred();if(kind==='transaction')f.model.drawings.begin();else if(kind==='gesture')f.controller.gesture={kind:'pan'};else f.controller.pointers.set(1,{x:0,y:0});
 const before=state(f);assert.equal((await f.importer.read(a.file)).status,'error');assert.equal(a.reads,0);unchanged(f,before);assert.equal(f.errors.length,1);
});
test('live data append and viewport navigation do not falsely invalidate stable drawing context',async t=>{
 const f=fixture(t),a=deferred(),pending=f.importer.read(a.file);f.store.append({time:60000,open:2,high:3,low:1,close:2,volume:2});f.api.pan(-5);a.resolve();assert.equal((await pending).status,'loaded');assert.equal(f.model.drawings.items[0].id,'incoming');
});
for(const size of [-1,NaN,Infinity,16*1024*1024+1])test('invalid file size '+String(size)+' rejects before reading and supersedes prior request',async t=>{
 const f=fixture(t),old=deferred('old'),pending=f.importer.read(old.file),next=deferred();next.file.size=size;
 const before=state(f);assert.equal((await f.importer.read(next.file)).status,'error');assert.equal(next.reads,0);old.resolve();assert.equal((await pending).status,'superseded');unchanged(f,before);
});
test('exact file byte limit is admitted without reducing nested drawing validation',async t=>{
 const f=fixture(t),a=deferred();a.file.size=16*1024*1024;const p=f.importer.read(a.file);a.resolve();assert.equal((await p).status,'loaded');
});
test('empty selection cancels prior pending intent without error/status',async t=>{
 const f=fixture(t),a=deferred(),p=f.importer.read(a.file),before=state(f);assert.equal((await f.importer.read(undefined)).status,'empty');a.resolve();assert.equal((await p).status,'superseded');unchanged(f,before);assert.equal(f.statuses.length,0);assert.equal(f.errors.length,0);
});
for(const outcome of ['resolve','reject'])test('explicit cancellation ignores later '+outcome,async t=>{
 const f=fixture(t),a=deferred(),p=f.importer.read(a.file),before=state(f);f.importer.cancel();a[outcome]();assert.equal((await p).status,'superseded');unchanged(f,before);assert.equal(f.statuses.length+f.errors.length,0);
});
test('current read failure is visible while newer user work masks stale read failure',async t=>{
 const f=fixture(t),a=deferred(),p=f.importer.read(a.file),before=state(f);a.reject();assert.equal((await p).status,'error');unchanged(f,before);assert.equal(f.errors[0].changed,false);
 const b=deferred(),q=f.importer.read(b.file);f.api.editDrawing('keep',{text:'latest'});const after=state(f);b.reject();assert.equal((await q).status,'stale');unchanged(f,after);assert.equal(f.errors.length,1);
});
for(const text of ['{',JSON.stringify({schema:'invalid'}),doc('bad',null)])test('malformed drawing import remains precommit error: '+text.slice(0,25),async t=>{
 const f=fixture(t),a=deferred(),p=f.importer.read(a.file),before=state(f);a.resolve(text);assert.equal((await p).status,'error');unchanged(f,before);assert.equal(f.errors[0].changed,false);
});
test('synchronous file.text exception is handled as current read error',async t=>{
 const f=fixture(t),before=state(f);assert.equal((await f.importer.read({size:1,text(){throw new Error('read');}})).status,'error');unchanged(f,before);
});
test('postcommit redraw failure is not reported as preserved old drawings',async t=>{
 const f=fixture(t),a=deferred();f.api.invalidate=()=>{throw new Error('redraw failed');};const p=f.importer.read(a.file);a.resolve();assert.equal((await p).status,'applied-error');assert.equal(f.model.drawings.items[0].id,'incoming');assert.equal(f.errors[0].changed,true);
});
test('invalidation starting a newer intent suppresses older success status',async t=>{
 const f=fixture(t),a=deferred();f.api.invalidate=()=>f.importer.cancel();const p=f.importer.read(a.file);a.resolve();assert.equal((await p).status,'loaded');assert.equal(f.statuses.length,0);
});
function handlerFixture(t){
 const f=fixture(t),elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{value:'chosen',files:[],click(){this.clicks=(this.clicks??0)+1;},setAttribute(){}});return elements.get(id);};
 const context={$: $,drawingFileImport:f.importer,model:f.model,chart:f.chart,preparing:false,document:{querySelectorAll:()=>[]}};vm.runInNewContext(demo.slice(demo.indexOf("$('load').onclick="),demo.indexOf("$('add-indicator').onclick=")),context);
 return Object.assign(f,{$,context});
}
test('actual file handler resets captured input synchronously and never clears later selection',async t=>{
 const f=handlerFixture(t),a=deferred(),input=f.$('file');input.files=[a.file];const p=input.onchange({target:input});assert.equal(input.value,'');input.value='newer-selection';a.resolve();await p;assert.equal(input.value,'newer-selection');
});
test('actual file handler supports same-file reselection and latest completion wins',async t=>{
 const f=handlerFixture(t),a=deferred('old'),b=deferred('new'),input=f.$('file');input.files=[a.file];const p=input.onchange({target:input});input.files=[b.file];const q=input.onchange({target:input});b.resolve();await q;a.resolve();await p;assert.equal(f.model.drawings.items[0].id,'new');assert.equal(f.statuses.length,1);
});
test('opening actual picker cancels old read even when no new file is selected',async t=>{
 const f=handlerFixture(t),a=deferred(),p=f.importer.read(a.file),before=state(f);f.$('load').onclick();assert.equal(f.$('file').clicks,1);a.resolve();assert.equal((await p).status,'superseded');unchanged(f,before);
});
test('actual busy handler cancels pending read and disables Load during preparation',async t=>{
 const f=handlerFixture(t),a=deferred(),p=f.importer.read(a.file);f.context.preparing=false;f.context.indicatorEditor={sync(){}};f.context.indicatorPicker={sync(){},selectedName:'ema'};f.context.pageActive=true;f.context.pageClosed=false;
 const start=demo.indexOf('function busy(value)'),end=demo.indexOf('\nfunction progress',start);vm.runInNewContext(demo.slice(start,end),f.context);f.context.busy(true);
 assert.equal(f.context.preparing,true);assert.equal(f.$('load').disabled,true);a.resolve();assert.equal((await p).status,'superseded');f.context.busy(false);assert.equal(f.$('load').disabled,false);
});
test('install, renderer recreation and persisted pagehide are wired to invalidate reads',()=>{
 assert.match(demo,/function install\([^]*?\{\s*drawingFileImport\.cancel\(\);/);
 assert.match(demo,/\$\('renderer'\)\.onchange=\(\)=>\{if\(!model\|\|!chart\|\|chart\.disposed\|\|preparing\)return;drawingFileImport\.cancel\(\);/);
 assert.match(demo,/addEventListener\('pagehide',e=>\{\s*drawingFileImport\.cancel\(\);/);
 assert.match(demo,/getChart:\(\)=>preparing\?null:chart/);
});
