import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';
import {createWasmHarness,wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';

const cargoAvailable=existsSync(join(rustupBinDirectory(process.env),'cargo'));
const target=wasmTargetAvailable(),requireWasm=process.env.REQUIRE_WASM==='1';
const skip=requireWasm?false:(!cargoAvailable?'rustup cargo unavailable':!target.available?target.reason:false);
async function value(harness,name,args=[]){const result=await harness.call(name,args);assert.equal(result.status,0,`${name}: ${result.error?.name} ${result.error?.message}`);return result.value;}
const targetFrame=frame=>frame.target;
const series=(frame,id)=>targetFrame(frame).series.find(value=>value.id===id);
const placement=(frame,id)=>targetFrame(frame).placements.find(value=>value.seriesId===id);

async function setup(t,{drawing=false}={}){
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 await value(harness,'nativeInit',[32,{series:[]}]);
 await value(harness,'nativeCommand',['addIndicator',['ema','ema',{period:3}]]);
 await value(harness,'nativeCommand',['addSeries',[{id:'price',type:'candles',panel:'price'}]]);
 await value(harness,'nativeCommand',['addSeries',[{id:'ema-line',type:'line',panel:'price',indicator:'ema',color:'#123456',label:'EMA'}]]);
 await value(harness,'nativeCommand',['setVisibleRange',[3.5,20.5]]);
 if(drawing)await value(harness,'nativeCommand',['addDrawing',[{id:'d',type:'horizontal',panel:'price',points:[{time:0,price:10}]}]]);
 return harness;
}

test('web layout atomically publishes panel, axis, placement and style while preserving values, view and drawing history',{skip},async t=>{
 const harness=await setup(t,{drawing:true});
 const beforeValues=await value(harness,'nativeCommand',['indicatorValues',['ema','value']]);
 const beforeState=await value(harness,'web.presentationState');
 const beforeDrawings=await value(harness,'web.drawingsState');
 const frame=await value(harness,'web.layoutCapture',[[],[]]),next=targetFrame(frame);
 const panel={id:'osc',weight:1,label:'Oscillator',scale:'linear',inverted:false,padding:.08,axisVisible:true,axisSide:'right'};
 const axis={id:'osc-axis',panel:'osc',side:'right',scale:'linear',inverted:false,padding:.08,visible:true,tickFormat:'fixed'};
 next.panelOrder.push('osc');next.panels.push(panel);next.axes.push(axis);
 next.generatedPanels.push({id:'osc',options:Object.fromEntries(Object.entries(panel).filter(([key])=>key!=='id'))});
 next.generatedAxes.push({id:'osc-axis',panel:'osc',options:Object.fromEntries(Object.entries(axis).filter(([key])=>!['id','panel'].includes(key)))});
 Object.assign(series(frame,'ema-line'),{panel:'osc',axisId:'osc-axis',color:'#abcdef',width:3,label:'Moved EMA'});
 Object.assign(placement(frame,'ema-line'),{panelId:'osc',axisId:'osc-axis'});
 assert.equal(await value(harness,'web.applyLayoutFrame',[frame]),undefined);
 const configuration=await value(harness,'web.configuration');
 assert.deepEqual(configuration.panels.map(value=>value.id),['price','osc']);
 assert.ok(configuration.axes.some(value=>value.id==='osc-axis'&&value.panel==='osc'));
 assert.deepEqual(configuration.series.find(value=>value.id==='ema-line'),series(frame,'ema-line'));
 assert.deepEqual(await value(harness,'nativeCommand',['indicatorValues',['ema','value']]),beforeValues);
 assert.deepEqual((await value(harness,'web.presentationState')).view,beforeState.view);
 const afterDrawings=await value(harness,'web.drawingsState');
 assert.deepEqual({items:afterDrawings.items,canUndo:afterDrawings.canUndo,canRedo:afterDrawings.canRedo,selected:afterDrawings.selected},{items:beforeDrawings.items,canUndo:beforeDrawings.canUndo,canRedo:beforeDrawings.canRedo,selected:beforeDrawings.selected});
 const captured=await value(harness,'web.layoutCapture',[['osc'],['osc-axis']]);assert.deepEqual(captured.source,captured.target);
});

test('late invalid field and stale source reject without partial publication',{skip},async t=>{
 const harness=await setup(t),before=await value(harness,'web.configuration');
 const invalid=await value(harness,'web.layoutCapture',[[],[]]);
 series(invalid,'ema-line').panel='missing-last-field';placement(invalid,'ema-line').panelId='missing-last-field';
 assert.notEqual((await harness.call('web.applyLayoutFrame',[invalid])).status,0);
 assert.deepEqual(await value(harness,'web.configuration'),before);
 const stale=await value(harness,'web.layoutCapture',[[],[]]);
 await value(harness,'nativeCommand',['setSeries',['ema-line',{color:'#ff0000'}]]);
 const changed=await value(harness,'web.configuration'),staleResult=await harness.call('web.applyLayoutFrame',[stale]);
 assert.notEqual(staleResult.status,0);assert.equal(staleResult.error?.name,'StaleSourceError');assert.deepEqual(await value(harness,'web.configuration'),changed);
});

test('active interaction and retained drawing references protect publication',{skip},async t=>{
 const harness=await setup(t,{drawing:true}),frame=await value(harness,'web.layoutCapture',[[],[]]);
 await value(harness,'nativeTool',['trendline']);await value(harness,'nativePointer',['down',1,20,20,8]);
 const active=await harness.call('web.applyLayoutFrame',[frame]);assert.notEqual(active.status,0);assert.equal(active.error?.name,'StaleSourceError');await value(harness,'nativePointer',['cancel']);
 const created=await value(harness,'web.layoutCapture',[[],[]]),next=targetFrame(created);
 const panel={id:'draw-panel',weight:1,scale:'linear',inverted:false,padding:.08,axisVisible:true,axisSide:'right'};
 next.panelOrder.push('draw-panel');next.panels.push(panel);next.generatedPanels.push({id:'draw-panel',options:Object.fromEntries(Object.entries(panel).filter(([key])=>key!=='id'))});
 await value(harness,'web.applyLayoutFrame',[created]);
 await value(harness,'nativeCommand',['addDrawing',[{id:'held',type:'horizontal',panel:'draw-panel',points:[{time:0,price:10}]}]]);
 const removal=await value(harness,'web.layoutCapture',[['draw-panel'],[]]);
 removal.target.panelOrder=removal.target.panelOrder.filter(id=>id!=='draw-panel');removal.target.panels=removal.target.panels.filter(panel=>panel.id!=='draw-panel');removal.target.generatedPanels=[];
 assert.notEqual((await harness.call('web.applyLayoutFrame',[removal])).status,0);
 assert.ok((await value(harness,'web.configuration')).panels.some(panel=>panel.id==='draw-panel'));
});

test('series-bound drawings in retained history reject a mismatched prospective placement',{skip},async t=>{
 const harness=await setup(t);
 await value(harness,'nativeCommand',['addDrawing',[{id:'bound',type:'horizontal',panel:'price',seriesId:'ema-line',points:[{time:0,price:10}]}]]);
 const frame=await value(harness,'web.layoutCapture',[[],[]]),next=targetFrame(frame);
 const panel={id:'osc',weight:1,scale:'linear',inverted:false,padding:.08,axisVisible:true,axisSide:'right'};
 next.panelOrder.push('osc');next.panels.push(panel);next.generatedPanels.push({id:'osc',options:Object.fromEntries(Object.entries(panel).filter(([key])=>key!=='id'))});
 series(frame,'ema-line').panel='osc';placement(frame,'ema-line').panelId='osc';
 const before=await value(harness,'web.configuration'),failed=await harness.call('web.applyLayoutFrame',[frame]);
 assert.notEqual(failed.status,0);assert.deepEqual(await value(harness,'web.configuration'),before);
});

test('valid series-bound current and redo history allow an unchanged binding with new style',{skip},async t=>{
 const harness=await setup(t);
 await value(harness,'nativeCommand',['addDrawing',[{id:'bound-valid',type:'horizontal',panel:'price',seriesId:'ema-line',points:[{time:0,price:10}]}]]);
 const before=await value(harness,'web.drawingsState');
 const frame=await value(harness,'web.layoutCapture',[[],[]]);
 series(frame,'ema-line').color='#abcdef';frame.target.series.reverse();
 await value(harness,'web.applyLayoutFrame',[frame]);
 assert.equal((await value(harness,'web.configuration')).series.find(row=>row.id==='ema-line').color,'#abcdef');
 assert.deepEqual(await value(harness,'web.drawingsState'),before);
 await value(harness,'nativeCommand',['undo',[]]);
 const redo=await value(harness,'web.drawingsState'),again=await value(harness,'web.layoutCapture',[[],[]]);series(again,'ema-line').width=4;
 await value(harness,'web.applyLayoutFrame',[again]);
 assert.deepEqual(await value(harness,'web.drawingsState'),redo);
});

for(const orphan of ['removed','axis-rebound'])test(`an existing ${orphan} drawing orphan does not block an unchanged layout`,{skip},async t=>{
 const harness=await setup(t);
 await value(harness,'nativeCommand',['addDrawing',[{id:'orphan',type:'horizontal',panel:'price',seriesId:'ema-line',points:[{time:0,price:10}]}]]);
 if(orphan==='removed')await value(harness,'nativeCommand',['removeSeries',['ema-line']]);
 else{
  await value(harness,'nativeCommand',['addAxis',[{id:'secondary',panel:'price'}]]);
  await value(harness,'nativeCommand',['setSeries',['ema-line',{axisId:'secondary'}]]);
 }
 const before=await value(harness,'web.drawingsState'),frame=await value(harness,'web.layoutCapture',[[],[]]);
 series(frame,'price').width=2;
 await value(harness,'web.applyLayoutFrame',[frame]);
 assert.deepEqual(await value(harness,'web.drawingsState'),before);
});

test('layout references include current, undo, redo and controller-only panel/axis owners',{skip},async t=>{
 const harness=await setup(t);
 await value(harness,'nativeCommand',['addPanel',[{id:'osc',weight:1}]]);
 await value(harness,'nativeCommand',['addAxis',[{id:'osc-axis',panel:'osc',side:'right',scale:'linear',inverted:false,padding:.08,visible:true,tickFormat:'fixed'}]]);
 await value(harness,'nativeCommand',['setDrawingTarget',[{panel:'osc',axisId:'osc-axis'}]]);
 await value(harness,'nativeCommand',['addDrawing',[{id:'held',type:'horizontal',panel:'osc',axisId:'osc-axis',points:[{time:0,price:10}]}]]);
 await value(harness,'nativeCommand',['setDrawingTarget',[null]]);
 const refs=await value(harness,'web.layoutReferences',[]);
 assert.deepEqual(refs,{schema:'aster.web-wasm.layout-references',version:1,panels:['osc'],axes:['osc-axis']});
 await value(harness,'nativeCommand',['undo',[]]);
 const afterUndo=await value(harness,'web.layoutReferences',[]);
 assert.deepEqual(afterUndo,{schema:'aster.web-wasm.layout-references',version:1,panels:['osc'],axes:['osc-axis']});
 await value(harness,'nativeCommand',['redo',[]]);
 const afterRedo=await value(harness,'web.layoutReferences',[]);
 assert.deepEqual(afterRedo,{schema:'aster.web-wasm.layout-references',version:1,panels:['osc'],axes:['osc-axis']});
});

test('layout references returns an ordinary initialization error and remains usable',{skip},async t=>{
 const harness=await createWasmHarness();t.after(()=>harness.dispose());
 const before=await harness.call('web.layoutReferences',[]);assert.notEqual(before.status,0);assert.match(before.error?.message,/initialized/i);
 assert.equal((await harness.call('nativeInit',[8,null])).status,0);
 const after=await harness.call('web.layoutReferences',[]);assert.equal(after.status,0);assert.deepEqual(after.value.panels,[]);assert.deepEqual(after.value.axes,[]);
});
