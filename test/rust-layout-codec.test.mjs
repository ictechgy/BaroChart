import assert from 'node:assert/strict';
import test from 'node:test';

import {BarStore,ChartModel,ChartAPI} from '../src/core/index.mjs';
import {captureDemoLayout,parseDemoLayout,stringifyDemoLayout} from '../examples/web/demo-layout-preset.mjs';
import {createLayoutMemory} from '../examples/web/layout-memory.mjs';
import {
 RUST_LAYOUT_STORAGE_KEY,
 captureRustLayoutPreset,
 parseRustLayoutPreset,
 stringifyRustLayoutPreset,
 parseRustLayoutMemory,
 stringifyRustLayoutMemory,
 rustLayoutPlan,
 canonicalPresetToRustTarget,
} from '../examples/web/rust-layout-codec.mjs';

function configuration(){
 return {
  schema:'aster.web-wasm.configuration',version:1,
  panels:[
   {id:'price',weight:3.5,label:'PRICE',scale:'linear',inverted:false,padding:.08,axisVisible:true,axisSide:'right'},
   {id:'volume',weight:.8,label:'VOLUME',scale:'linear',inverted:false,padding:.08,precision:0,axisVisible:true,axisSide:'right'},
   {id:'osc',weight:1,label:'OSC',scale:'linear',inverted:false,padding:.08,range:[-0,100],precision:0,axisVisible:true,axisSide:'right'},
  ],
  axes:[{id:'osc-axis',panel:'osc',side:'right',scale:'linear',inverted:false,padding:.08,range:[-0,100],precision:0,tickFormat:'fixed',visible:true}],
  series:[
   {id:'price',type:'candles',panel:'price',axisId:null,color:'#58cadbff',offset:0,visible:true,label:'가격'},
   {id:'volume',type:'histogram',panel:'volume',axisId:null,source:'volume',color:'#2b6e78ff',offset:0,visible:true,label:'거래량'},
   {id:'ema-line',type:'line',panel:'osc',axisId:'osc-axis',indicator:'ema-id',output:'value',color:'#123456ff',width:2,offset:-0,visible:true,label:'EMA'},
  ],
  indicators:[{id:'ema-id',name:'ema',params:{period:9},outputs:['value'],plotOffsets:{}}],
 };
}

function captureOptions(){return {market:'us',count:100000,light:true,generatedPanelIds:['osc'],generatedAxisIds:['osc-axis'],panelPins:[['osc',{range:[-0,100]}]],axisPins:[['osc-axis',{range:[-0,100]}]]};}

test('Rust metadata exports the canonical JavaScript layout document without data or UI state',()=>{
 const preset=captureRustLayoutPreset(configuration(),captureOptions());
 assert.equal(RUST_LAYOUT_STORAGE_KEY,'barochart.main-demo.layout.v1');
 assert.equal(preset.schema,'barochart.main-demo-layout');
 assert.deepEqual(preset.managed,{panels:['osc'],axes:['osc-axis']});
 assert.equal(Object.hasOwn(preset.layout.indicators[0],'outputs'),false);
 assert.equal(Object.hasOwn(preset.layout.indicators[0],'plotOffsets'),false);
 assert.equal(Object.hasOwn(preset.layout.panels[2],'range'),false,'owned synthetic panel range is host state');
 assert.equal(Object.hasOwn(preset.layout.axes[0],'range'),false,'owned synthetic axis range is host state');
 for(const forbidden of ['data','drawings','view','history','columns'])assert.equal(JSON.stringify(preset).includes('"'+forbidden+'"'),false);
 const text=stringifyRustLayoutPreset(preset),legacy=parseDemoLayout(text);
 assert.deepEqual(legacy,preset);
 assert.ok(text.includes('"$asterNumber":"-0"'),'series signed zero survives the canonical wire');
 assert.deepEqual(parseRustLayoutPreset(text),preset);
});

test('file indicators reject runtime-only metadata and primary-axis null matches omission',()=>{
 const preset=captureRustLayoutPreset(configuration(),captureOptions()),file=structuredClone(preset);
 file.layout.indicators[0].outputs=['value'];
 assert.throws(()=>parseRustLayoutPreset(safeText(file)),/unsupported field outputs/i);
 const omitted=structuredClone(preset);delete omitted.layout.series[0].axisId;delete omitted.layout.series[1].axisId;
 assert.doesNotThrow(()=>canonicalPresetToRustTarget(layoutFrame(configuration()),omitted,configuration(),captureOptions()));
});

test('the pure Rust reader accepts an existing JavaScript layout export without constructing a model',()=>{
 const model=new ChartModel({store:new BarStore(),panels:[{id:'price',weight:3.5},{id:'volume',weight:.8},{id:'osc',weight:1,range:[-0,100]}],axes:[{id:'osc-axis',panel:'osc',range:[-0,100]}]});
 const api=new ChartAPI(model);
 try{
  api.addSeries({id:'price',type:'candles',panel:'price'});api.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume'});
  api.addIndicator('ema-id','ema',{period:9});api.addSeries({id:'ema-line',type:'line',panel:'osc',axisId:'osc-axis',indicator:'ema-id',offset:-0});
  const jsPreset=captureDemoLayout(model,{market:'us',count:100000,light:false,generatedPanelIds:new Set(['osc']),generatedAxisIds:new Set(['osc-axis'])});
  const pure=parseRustLayoutPreset(stringifyDemoLayout(jsPreset));
  assert.deepEqual(pure,jsPreset);
  assert.deepEqual(parseDemoLayout(stringifyRustLayoutPreset(pure)),jsPreset);
 }finally{model.dispose();}
});

test('shared memory wrapper preserves enabled policy, preset and signed zero',()=>{
 const preset=captureRustLayoutPreset(configuration(),captureOptions()),text=stringifyRustLayoutMemory({enabled:true,preset}),parsed=parseRustLayoutMemory(text);
 assert.deepEqual(parsed,{enabled:true,preset});assert.equal(Object.is(parsed.preset.layout.series[2].offset,-0),true);
 assert.deepEqual(parseRustLayoutMemory(stringifyRustLayoutMemory({enabled:false,preset:null})),{enabled:false,preset:null});
 assert.throws(()=>parseRustLayoutMemory('{"schema":"barochart.main-demo-memory","version":1,"enabled":false,"preset":{}}'),/disabled|preset/i);
 const storage={value:text,getItem(key){assert.equal(key,RUST_LAYOUT_STORAGE_KEY);return this.value;},setItem(key,value){assert.equal(key,RUST_LAYOUT_STORAGE_KEY);this.value=value;}};
 const legacy=createLayoutMemory({getStorage:()=>storage,getPreset:()=>preset,delay:0});
 assert.deepEqual(legacy.read(),{enabled:true,preset});legacy.changed();assert.equal(legacy.flush(),true);
 assert.deepEqual(parseRustLayoutMemory(storage.value),{enabled:true,preset});legacy.dispose();
});

test('plan stays metadata-only and target conversion uses accepted Rust records with runtime pins',()=>{
 const preset=captureRustLayoutPreset(configuration(),captureOptions()),plan=rustLayoutPlan(preset);
 assert.deepEqual(plan.managed,{panels:['osc'],axes:['osc-axis']});assert.notStrictEqual(plan.layout,preset.layout);
 const accepted=configuration(),target={panelOrder:['price','volume','osc'],panels:structuredClone(accepted.panels),axes:structuredClone(accepted.axes),series:structuredClone(accepted.series),placements:[{seriesId:'ema-line',indicatorId:'ema-id',panelId:'osc',axisId:'osc-axis'}],generatedPanels:[{id:'osc',options:Object.fromEntries(Object.entries(accepted.panels[2]).filter(([key])=>key!=='id'))}],generatedAxes:[{id:'osc-axis',panel:'osc',options:Object.fromEntries(Object.entries(accepted.axes[0]).filter(([key])=>!['id','panel'].includes(key)))}]};
 const frame={schema:'aster.web-wasm.layout-frame',version:1,source:structuredClone(target),target:structuredClone(target)};
 const converted=canonicalPresetToRustTarget(frame,preset,accepted,{panelPins:captureOptions().panelPins,axisPins:captureOptions().axisPins});
 assert.notStrictEqual(converted,frame);assert.deepEqual(converted.source,frame.source);
 assert.deepEqual(converted.target.panelOrder,['price','volume','osc']);
 assert.equal(Object.is(converted.target.generatedPanels[0].options.range[0],-0),true);
 assert.equal(Object.is(converted.target.generatedAxes[0].options.range[0],-0),true);
 assert.equal(converted.target.series[2].color,'#123456ff','accepted Core record is authoritative');
 const changed=structuredClone(accepted);changed.series[2].panel='price';
 assert.throws(()=>canonicalPresetToRustTarget(frame,preset,changed,captureOptions()),/binding|accepted/i);
 const foreign=structuredClone(frame);foreign.target.series[2].id='another';
 assert.throws(()=>canonicalPresetToRustTarget(foreign,preset,accepted,captureOptions()),/another layout frame/i);
});

test('panel and axis order come from the preset while semantic series and indicator order must already be reconciled',()=>{
 const accepted=configuration(),preset=captureRustLayoutPreset(accepted,captureOptions());
 preset.layout.panels=[preset.layout.panels[1],preset.layout.panels[0],preset.layout.panels[2]];
 const converted=canonicalPresetToRustTarget(layoutFrame(accepted),preset,accepted,captureOptions());
 assert.deepEqual(converted.target.panelOrder,['volume','price','osc']);assert.deepEqual(converted.target.panels.map(row=>row.id),['volume','price','osc']);
 const desiredSeries=structuredClone(preset);desiredSeries.layout.series.reverse();
 assert.throws(()=>canonicalPresetToRustTarget(layoutFrame(accepted),desiredSeries,accepted,captureOptions()),/resource order/i);
 const reordered=structuredClone(accepted);reordered.series.reverse();
 assert.doesNotThrow(()=>canonicalPresetToRustTarget(layoutFrame(reordered),desiredSeries,reordered,captureOptions()));
});

test('rejects accessors, unsupported fields, bad pins and byte/count limits before publication',()=>{
 const config=configuration();Object.defineProperty(config.panels[0],'label',{enumerable:true,get(){throw new Error('must not run');}});
 assert.throws(()=>captureRustLayoutPreset(config,captureOptions()),/own data|accessor/i);
 const valid=captureRustLayoutPreset(configuration(),captureOptions());
 assert.throws(()=>parseRustLayoutPreset(JSON.stringify({...valid,columns:[]})),/unsupported/i);
 const mismatched=captureRustLayoutPreset(configuration(),{...captureOptions(),panelPins:[['osc',{range:[1,100]}]]});
 assert.deepEqual(mismatched.layout.panels.find(row=>row.id==='osc').range,[-0,100],'a stale pin cannot authorize dropping the actual range');
 assert.throws(()=>captureRustLayoutPreset(configuration(),{...captureOptions(),generatedPanelIds:Array.from({length:33},(_,index)=>'p'+index)}),/limit|panel/i);
 assert.throws(()=>parseRustLayoutPreset('x'.repeat(512*1024+1)),/limit/i);
 const frame={schema:'aster.web-wasm.layout-frame',version:1,source:{panelOrder:[],panels:[],axes:[],placements:[],generatedPanels:[],generatedAxes:[],series:[]},target:{panelOrder:[],panels:[],axes:[],placements:[],generatedPanels:[],generatedAxes:[],series:[]}};
 Object.defineProperty(frame.source,'panels',{enumerable:true,get(){throw new Error('must not run frame getter');}});
 assert.throws(()=>canonicalPresetToRustTarget(frame,valid,configuration(),captureOptions()),/accessor/i);
 const memory={preset:null};Object.defineProperty(memory,'enabled',{enumerable:true,get(){throw new Error('must not run memory getter');}});
 assert.throws(()=>stringifyRustLayoutMemory(memory),/own data/i);
});

function safeText(value){return JSON.stringify(value,(_key,item)=>typeof item==='number'&&Object.is(item,-0)?{$asterNumber:'-0'}:item);}
function layoutFrame(config){const target={panelOrder:config.panels.map(row=>row.id),panels:structuredClone(config.panels),axes:structuredClone(config.axes),series:structuredClone(config.series),placements:config.series.filter(row=>row.indicator!==undefined).map(row=>({seriesId:row.id,indicatorId:row.indicator,panelId:row.panel,axisId:row.axisId??null})),generatedPanels:[{id:'osc',options:Object.fromEntries(Object.entries(config.panels.find(row=>row.id==='osc')).filter(([key])=>key!=='id'))}],generatedAxes:[{id:'osc-axis',panel:'osc',options:Object.fromEntries(Object.entries(config.axes.find(row=>row.id==='osc-axis')).filter(([key])=>!['id','panel'].includes(key)))}]};return{schema:'aster.web-wasm.layout-frame',version:1,source:structuredClone(target),target:structuredClone(target)};}
