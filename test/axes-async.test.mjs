import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore,seededColumns} from '../src/core/data.mjs';
import {ChartModel,createLayout} from '../src/core/model.mjs';
import {ChartAPI} from '../src/core/api.mjs';
import {InteractionController} from '../src/core/interaction.mjs';
import {AsyncCapture,AsyncPrepared} from '../src/core/async-state.mjs';
import {PrepareCapture,PreparedData} from '../src/core/prepare-state.mjs';
import {AsyncUICapture,AsyncUIImport} from '../src/core/async-ui.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
import {DEMO_SYMBOLS} from '../src/core/markets.mjs';

const size={width:1200,height:700};
function fixture({empty=false,foreign=true}={}) {
 const store=new BarStore();if(!empty)store.setColumns(seededColumns(512,42));
 const model=new ChartModel({store,panels:[{id:'price',weight:3,axisVisible:false,axisSide:'left'},{id:'osc',weight:1}],axes:[
  {id:'usd',panel:'price',side:'left',range:[90,120],precision:3,prefix:'$',suffix:' USD',label:'Dollar',width:96},
  {id:'relative',panel:'price',side:'right',scale:'percent',base:100,range:[80,140],precision:2,tickFormat:'scientific'},
  {id:'momentum',panel:'osc',side:'left',range:[0,100],inverted:true,prefix:'RSI '}
 ]});
 model.addSeries({id:'primary',type:'candles',panel:'price',axisId:null,label:'Primary OHLC'});
 model.indicators.add('e','ema',{period:12});model.addSeries({id:'trend',type:'line',panel:'price',axisId:'usd',indicator:'e',label:'EMA'});
 if(foreign&&!empty)model.addSeries({id:'foreign',type:'line',panel:'price',axisId:'relative',symbolId:'FOREIGN',label:'Aligned foreign close',values:Float64Array.from({length:512},(_,i)=>100+i/100)});
 const input=new InteractionController(model,()=>size),api=new ChartAPI(model,{controller:input});api.setSymbol(DEMO_SYMBOLS.crypto);
 return {model,input,api};
}
function history(api,model) {
 const id=api.addDrawing({id:'bound',type:'text',seriesId:'trend',text:'initial',points:[{time:model.store.timeAtIndex(4),price:101}]});
 api.editDrawing(id,{text:'second'});api.undo();return id;
}
function correction(model){return {kind:'correction',bar:{...model.store.at(0),close:1000,high:1000}};}
function copy(capture,metadata=capture.metadataJSON){
 const prepared=new AsyncPrepared(metadata);
 for(let slot=0;slot<capture.buffers.length;slot++)for(let at=0;at<capture.buffers[slot].length;at+=137){const count=Math.min(137,capture.buffers[slot].length-at);prepared.target(slot,at,count).set(capture.buffer(slot,at,count));}
 for(let e=0;e<capture.checkpoints.length;e++)for(let at=0;at<capture.checkpoints[e].keys.length;at++)prepared.checkpoint(e,capture.checkpoint(e,at,1));
 return prepared;
}
function ready(capture,kind='correction'){const prepared=kind==='prepare'?new PreparedData(capture.metadataJSON):copy(capture);prepared.start();while(!prepared.step(64).complete){}return prepared;}
function segmented(capture,prepared,input){const source=new AsyncUICapture(capture,input,size),target=new AsyncUIImport(source.headerJSON,prepared);while(true){const text=source.next();if(JSON.parse(text).complete)break;target.chunk(text);}assert.equal(source.check(input,size),true);return target.finish();}
function assertRestored(result,source,input){
 assert.deepEqual(result.model.axes,source.axes);assert.deepEqual(result.model.panels,source.panels);
 assert.deepEqual(result.model.series.map(s=>[s.id,s.axisId,s.symbolId,s.label]),source.series.map(s=>[s.id,s.axisId,s.symbolId,s.label]));
 assert.deepEqual(result.ui.drawingTarget,input.drawingTarget);assert.deepEqual(result.model.drawings.items,source.drawings.items);
 assert.deepEqual(result.model.drawings.undoStack,source.drawings.undoStack);assert.deepEqual(result.model.drawings.redoStack,source.drawings.redoStack);
 const layout=createLayout(result.model,size.width,size.height);assert.equal(layout.axis('price','usd').min,source.axes[0].range[0]);assert.equal(layout.axis('price','usd').prefix,source.axes[0].prefix);
}

for(const transfer of ['direct','segmented'])test(`native correction ${transfer} restores axes before series and latest UI/bound history`,()=>{
 const {model,input,api}=fixture();history(api,model);input.setDrawingTarget({panel:'price',seriesId:'trend'});createLayout(model,1200,700);
 const original=model.store.at(0),capture=new AsyncCapture(model,correction(model)),prepared=ready(capture);
 api.setAxis('usd',{range:[85,125],prefix:'US$',inverted:true,precision:4});api.setSeries('foreign',{label:'Latest aligned quote'});model.setVisibleRange(10,200);
 const result=transfer==='direct'?prepared.finish(capture.ui(input,size)):segmented(capture,prepared,input);
 assertRestored(result,model,input);assert.equal(result.model.store.at(0).close,1000);assert.deepEqual(model.store.at(0),original);
 assert.deepEqual(result.model.series.find(s=>s.id==='foreign').values,model.series.find(s=>s.id==='foreign').values);
 result.model.drawings.redo();assert.equal(result.model.drawings.items[0].text,'second');assert.equal(result.model.drawings.items[0].axisId,'usd');
 result.model.drawings.undo();assert.equal(result.model.drawings.items[0].text,'initial');model.dispose();prepared.dispose();
});

for(const transfer of ['direct','segmented'])test(`native prepare ${transfer} retains portable axes, target and v2 history`,()=>{
 const {model,input,api}=fixture({empty:true,foreign:false});history(api,model);input.setDrawingTarget({panel:'price',axisId:'usd',seriesId:'trend'});
 const capture=new PrepareCapture(model,{kind:'seeded',count:512,seed:42}),prepared=ready(capture,'prepare');api.setAxis('relative',{precision:5,suffix:'%' });
 const result=transfer==='direct'?prepared.finish(capture.ui(input,size)):segmented(capture,prepared,input);
 assertRestored(result,model,input);assert.equal(model.store.length,0);assert.equal(result.model.store.length,512);assert.equal(JSON.parse(result.model.drawings.save()).version,2);
 result.model.drawings.redo();assert.equal(result.model.drawings.items[0].text,'second');model.dispose();prepared.dispose();
});

test('async snapshot rejects forged OHLC symbol, indicator+values and invalid general series metadata before calculation',()=>{
 const {model}=fixture();delete model.series[0].axisId;const capture=new AsyncCapture(model,correction(model));
 const mutations=[meta=>{meta.series[0].options.symbolId='SPOOF';},meta=>{meta.series[0].options.values=meta.series[2].options.values;},meta=>{meta.series[1].options.values=meta.series[2].options.values;},meta=>{meta.series[1].options.offset=1.5;},meta=>{meta.series[2].options.symbolId=7;}];
 for(const mutate of mutations){const meta=safeCheckpointParse(capture.metadataJSON);mutate(meta);const prepared=copy(capture,safeCheckpointStringify(meta));assert.throws(()=>prepared.start(),/symbol|OHLC|external|offset|Series/i);assert.equal(prepared.model,null);prepared.dispose();}
 model.dispose();
});

test('snapshot series validation does not run pending indicators synchronously',()=>{
 const {model}=fixture();model.store.update(20,{...model.store.at(20),volume:9000});const capture=new AsyncCapture(model,correction(model)),prepared=copy(capture);
 prepared.start();const entry=prepared.model.indicators.entries.get('e');assert.equal(entry.revision,model.indicators.entries.get('e').revision);assert.equal(entry.dirty,0);assert.equal(prepared.phase,'calculate');
 model.dispose();prepared.dispose();
});

for(const transfer of ['direct','segmented'])test(`internal ${transfer} UI retains orphan series history but clears stale target`,()=>{
 const {model,input,api}=fixture({foreign:false});history(api,model);input.setDrawingTarget({panel:'price',seriesId:'trend'});model.removeSeries('trend');
 const saved=model.drawings.save();assert.throws(()=>api.loadDrawings(saved),/series binding/);const capture=new AsyncCapture(model,correction(model)),prepared=ready(capture);
 const result=transfer==='direct'?prepared.finish(capture.ui(input,size)):segmented(capture,prepared,input);
 assert.equal(result.ui.drawingTarget,null);assert.equal(result.model.drawings.save(),saved);assert.deepEqual(result.model.drawings.redoStack,model.drawings.redoStack);assert.equal(createLayout(result.model,1200,700).drawingAxis(result.model.drawings.items[0]),undefined);
 result.model.addSeries({id:'trend',type:'line',panel:'price',axisId:'usd',indicator:'e'});assert.equal(createLayout(result.model,1200,700).drawingAxis(result.model.drawings.items[0]).axisId,'usd');
 model.dispose();prepared.dispose();
});

test('latest series rebinding preserves orphan drawing/history and updated target',()=>{
 const {model,input,api}=fixture();history(api,model);input.setDrawingTarget({panel:'price',seriesId:'trend'});const capture=new AsyncCapture(model,correction(model)),prepared=ready(capture);
 api.setSeries('trend',{axisId:'relative'});const result=segmented(capture,prepared,input);assert.deepEqual(result.ui.drawingTarget,input.drawingTarget);assert.equal(result.ui.drawingTarget.axisId,'relative');assert.equal(result.model.series.find(s=>s.id==='trend').axisId,'relative');assert.equal(result.model.drawings.items[0].axisId,'usd');assert.equal(createLayout(result.model,1200,700).drawingAxis(result.model.drawings.items[0]),undefined);
 model.dispose();prepared.dispose();
});

test('resumed UI clears a selected series target whose axis binding changed',()=>{
 const {model,input,api}=fixture();history(api,model);input.setDrawingTarget({panel:'price',seriesId:'trend'});const capture=new AsyncCapture(model,correction(model)),prepared=ready(capture);
 api.setSeries('trend',{axisId:'relative'});input.drawingTarget={panel:'price',axisId:'usd',seriesId:'trend'};const result=segmented(capture,prepared,input);assert.equal(result.ui.drawingTarget,null);assert.equal(result.model.drawings.items[0].axisId,'usd');model.dispose();prepared.dispose();
});

test('invalid latest axes, target or drawing binding rejects atomically',()=>{
 const {model,input,api}=fixture();history(api,model);const capture=new AsyncCapture(model,correction(model)),prepared=ready(capture),originalAxes=structuredClone(prepared.model.axes),source=model.store.at(0),valid=capture.uiState(input,size);
 const mutations=[ui=>{ui.axes[0].panel='missing';},ui=>{ui.axes[1].base=0;},ui=>{ui.axes.push({...ui.axes[0]});},ui=>{ui.axes[0].formatter=v=>String(v);},ui=>{ui.panels[0].formatter=v=>String(v);},ui=>{ui.series[1].axisId='missing';},ui=>{ui.drawingTarget={panel:'price',axisId:'missing'};},ui=>{ui.drawingTarget={panel:'price',axisId:'missing',seriesId:'missing'};},ui=>{ui.drawingTarget={panel:null};},ui=>{ui.drawings.items[0].axisId='missing';},ui=>{ui.drawings.redo[0][0].axisId='missing';}];
 for(const mutate of mutations){const ui=safeCheckpointParse(safeCheckpointStringify(valid));mutate(ui);assert.throws(()=>prepared.finishUI(ui),/axis|base|percent|Duplicate|scale|formatter|target/i);assert.deepEqual(prepared.model.axes,originalAxes);assert.deepEqual(model.store.at(0),source);}
 model.dispose();prepared.dispose();
});

test('axis formatter callbacks are explicit synchronous-only and reject early and at latest UI capture',()=>{
 for(const kind of ['correction','prepare']){const {model,input}=fixture({foreign:false}),capture=kind==='prepare'?new PrepareCapture(model,{kind:'seeded',count:512}):new AsyncCapture(model,correction(model));model.setAxis('usd',{formatter:v=>'$'+v});assert.throws(()=>capture.ui(input,size),/formatter/);assert.throws(()=>kind==='prepare'?new PrepareCapture(model,{kind:'seeded',count:512}):new AsyncCapture(model,correction(model)),/formatter/);model.dispose();}
});

test('async aligned foreign values retain primary OHLC identity in crosshair results',()=>{
 const {model,input}=fixture();model.setVisibleRange(50,150);const capture=new AsyncCapture(model,correction(model)),prepared=ready(capture),result=prepared.finish(capture.ui(input,size)),layout=createLayout(result.model,1200,700);
 const doneAPI=new ChartAPI(result.model);doneAPI.setSymbol(DEMO_SYMBOLS.crypto);result.model.crosshair={x:layout.x(100),y:layout.axis('price','usd').y(105)};
 const values=doneAPI.crosshairValues(1200,700);assert.equal(values.primary.symbolId,DEMO_SYMBOLS.crypto.id);assert.deepEqual(values.primary.bar,result.model.store.at(100));
 const foreign=values.series.find(s=>s.id==='foreign');assert.equal(foreign.symbolId,'FOREIGN');assert.equal(foreign.value,101);assert.equal(foreign.sourceIndex,100);assert.equal(foreign.sourceTime,result.model.store.at(100).time);assert.equal(values.series.find(s=>s.id==='primary').symbolId,DEMO_SYMBOLS.crypto.id);
 model.dispose();prepared.dispose();
});
