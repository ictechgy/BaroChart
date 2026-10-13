import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, ChartModel, ChartAPI, buildScene} from '../src/core/index.mjs';

// Independent save/load contract regression. Run: node --test /tmp/aster-study-style-save.test.mjs
const bars=[10,11,9,12].map((close,i)=>({time:1700000000000+i*60000,open:close,high:close+1,low:close-1,close,volume:i+1}));
function fixture(t,style={},type='line') {
 const model=new ChartModel({store:new BarStore(bars)});let invalidations=0;
 const api=new ChartAPI(model,{invalidate:()=>invalidations++});t.after(()=>model.dispose());
 api.addIndicator('ma','sma',{period:1});
 model.addSeries({id:'study',type,panel:'price',indicator:'ma',output:'value',...style});
 return {model,api,invalidations:()=>invalidations};
}
function snapshot(f) {
 const {model,api}=f;
 const values=api.indicatorValues('ma','value');
 return {store:model.store,version:model.store.version,listeners:[...model.store.listeners],
  entries:model.indicators.entries,entryRefs:[...model.indicators.entries],params:[...model.indicators.entries].map(([id,e])=>[id,{...e.params}]),values,
  series:model.series,seriesRefs:[...model.series],seriesFields:model.series.map(s=>({...s})),inspect:api.inspect(),invalidations:f.invalidations(),
  drawings:model.drawings,items:model.drawings.items,undo:model.drawings.undoStack,redo:model.drawings.redoStack,
  history:JSON.stringify({items:model.drawings.items,undo:model.drawings.undoStack,redo:model.drawings.redoStack,selected:model.drawings.selected,serial:model.drawings.serial,bytes:model.drawings.retainedHistoryBytes})};
}
function unchanged(f,before) {
 const {model,api}=f;
 assert.equal(model.store,before.store);assert.equal(model.store.version,before.version);assert.deepEqual([...model.store.listeners],before.listeners);
 assert.equal(model.indicators.entries,before.entries);assert.equal(model.indicators.entries.size,before.entryRefs.length);
 for(const [id,entry] of before.entryRefs)assert.equal(model.indicators.entries.get(id),entry);
 for(const [id,params] of before.params)assert.deepEqual(model.indicators.entries.get(id).params,params);
 assert.deepEqual(api.indicatorValues('ma','value'),before.values);
 assert.equal(model.series,before.series);assert.equal(model.series.length,before.seriesRefs.length);
 before.seriesRefs.forEach((s,i)=>{assert.equal(model.series[i],s);assert.deepEqual({...s},before.seriesFields[i]);});
 assert.deepEqual(api.inspect(),before.inspect);assert.equal(f.invalidations(),before.invalidations,'save must never invalidate');
 assert.equal(model.drawings,before.drawings);assert.equal(model.drawings.items,before.items);
 assert.equal(model.drawings.undoStack,before.undo);assert.equal(model.drawings.redoStack,before.redo);
 assert.equal(JSON.stringify({items:model.drawings.items,undo:model.drawings.undoStack,redo:model.drawings.redoStack,selected:model.drawings.selected,serial:model.drawings.serial,bytes:model.drawings.retainedHistoryBytes}),before.history);
}
function rejection(f) {
 const before=snapshot(f);let error;
 try{f.api.saveStudies();}catch(caught){error=caught;}
 unchanged(f,before);
 assert.ok(error instanceof RangeError,'save must reject unsupported CSS before returning an unreadable document');
 assert.match(error.message,/portable color/i);
}
for(const [label,type,key,value] of [
 ['HSL line color','line','color','hsl(0, 100%, 50%)'],
 ['CSS variable line color','line','color','var(--study-color)'],
 ['modern named area fill','area','fill','rebeccapurple'],
 ['HSL histogram upColor','histogram','upColor','hsl(120, 100%, 50%)'],
 ['CSS variable histogram downColor','histogram','downColor','var(--down-color)'],
 ['wide-gamut area fill','area','fill','color(display-p3 1 0 0)'],
])test('save rejects '+label+' without changing owner state',t=>rejection(fixture(t,{[key]:value},type)));

function roundTrip(t,f,expectedColors) {
 const before=snapshot(f),text=f.api.saveStudies(),doc=JSON.parse(text);unchanged(f,before);
 // Save is validation-only: it must retain every previously serialized public value exactly.
 assert.deepEqual(doc.series,before.inspect.series.filter(s=>s.indicator));
 const keys=['id','type','panel','source','indicator','output','color','fill','width','baseline','offset','upColor','downColor','visible','axisId','symbolId','label'];
 const expectedSeries=before.inspect.series.filter(s=>s.indicator).map(s=>Object.fromEntries(keys.filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
 assert.equal(text,JSON.stringify({schema:'aster.studies',version:1,indicators:[{id:'ma',name:'sma',params:{period:1}}],series:expectedSeries}));
 const target=new ChartModel({store:new BarStore(bars)}),api=new ChartAPI(target);t.after(()=>target.dispose());
 assert.deepEqual(api.loadStudies(text),{indicators:1,series:1});
 for(const [key,value] of Object.entries(expectedColors))assert.equal(target.series[0][key],value,key);
 assert.deepEqual(api.indicatorValues('ma','value'),f.api.indicatorValues('ma','value'));
 for(const key of ['width','baseline','offset','visible','label'])if(Object.hasOwn(doc.series[0],key))assert.equal(target.series[0][key],doc.series[0][key],key);
 return doc;
}
for(const [label,style,expected] of [
 ['mixed-case full hex',{color:'#AbCdEf',fill:'#Ff000080',upColor:'#12aBcD',downColor:'#C0fFeE01'},{color:'#AbCdEf',fill:'#Ff000080',upColor:'#12aBcD',downColor:'#C0fFeE01'}],
 ['short hex and comma RGB/RGBA',{color:'#aBc',fill:'rgba(255, 0, 128, 0.5)',upColor:'rgb(1, 2, 3)',downColor:'#F00a'},{color:'#aabbccff',fill:'#ff008080',upColor:'#010203ff',downColor:'#ff0000aa'}],
 ['basic names and whitespace',{color:' RED ',fill:'transparent',upColor:'Lime',downColor:' Navy '},{color:'#ff0000ff',fill:'#00000000',upColor:'#00ff00ff',downColor:'#000080ff'}],
])test('save preserves exact '+label+' text and round-trips values',t=>{
 const f=fixture(t,{...style,width:3.25,baseline:.5,offset:-2,visible:false,label:'kept exactly'},'area');
 roundTrip(t,f,expected);
});

test('default style and null fill remain supported',t=>{
 const f=fixture(t,{fill:null},'area');const doc=roundTrip(t,f,{color:'#7898ff',fill:null});
 assert.equal(doc.series[0].fill,null);assert.equal(Object.hasOwn(doc.series[0],'upColor'),false);assert.equal(Object.hasOwn(doc.series[0],'downColor'),false);
});

test('unsupported colors on excluded non-indicator series cannot block study save',t=>{
 const f=fixture(t,{color:'#123456'});
 f.model.addSeries({id:'external',type:'area',panel:'price',values:new Float64Array(bars.length).fill(42),color:'hsl(240, 100%, 50%)',fill:'var(--fill)'});
 f.model.addSeries({id:'candles',type:'candles',panel:'price',upColor:'rebeccapurple',downColor:'color(display-p3 1 0 0)'});
 const doc=roundTrip(t,f,{color:'#123456'});assert.deepEqual(doc.series.map(s=>s.id),['study']);
});

test('failed save leaves ordinary HSL scene, entries, drawing undo/redo and invalidations intact',t=>{
 const color='hsl(0, 100%, 50%)',f=fixture(t,{color});
 for(let i=0;i<2;i++)f.api.addDrawing({type:'text',panel:'price',points:[{time:bars[i].time,price:bars[i].close}],text:'drawing '+i});
 f.api.undo();assert.ok(f.model.drawings.undoStack.length);assert.ok(f.model.drawings.redoStack.length);
 const scene=buildScene(f.model,400,240).commands;
 assert.ok(scene.some(command=>command.color===color),'low-level rendering accepts and preserves the configured CSS color');
 let error;try{rejection(f);}catch(caught){error=caught;}
 assert.deepEqual(buildScene(f.model,400,240).commands,scene,'save cannot alter normal rendering');
 if(error)throw error;
});
