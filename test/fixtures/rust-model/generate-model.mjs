#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {ChartAPI} from '../../../src/core/api.mjs';
import {SERIES_KEYS} from '../../../src/core/contracts.mjs';
import {BarStore} from '../../../src/core/data.mjs';
import {InteractionController} from '../../../src/core/interaction.mjs';
import {ChartModel} from '../../../src/core/model.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-model/model-oracle.jsonl');
const HEADER=Object.freeze({
 kind:'header',schema:'barochart.rust-model.model-oracle',version:1,
 workspaceBase:'cd68770fd736c5bf80793c3e4a46e36724cb12fe',
 modelSHA256:'64bb1a0a042841a9386a6f8f500c0e5f96a952d4a09602f91e2f3ef333f356ad',
 contractsSHA256:'832a919e16aa29f5c5655210308256e6195c032fc9e4831176e4adf53e4b78e2',
 dataSHA256:'4abba0d1ea3fd2e73d3cca968ba09b17a40f14f4a479bc260a55a230b9134d0b',
 apiSHA256:'581dfd1556e31770afc308c76afe7a1d27f75ce92d0e86f715871e832b4dffe8',
 interactionSHA256:'a814a4eddbba1fd8dc1aff716f079046bfc0b420c2ec1e85412861bdd3cc5ee0',
 indicatorsSHA256:'31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790',
 node:'v22.20.0',v8:'12.4.254.21-node.33',seed:'model-v1-6d2b79f5',
 encoding:'f64 big-endian bits; objects as ordered entry arrays; undefined explicitly tagged',
 callSequence:['actual ChartModel/BarStore/IndicatorEngine/DrawingStore/InteractionController','capture outcome','capture portable model state'],
 caseCounts:{record:2,validation:44,guard:8,view:1,store:1}
});

const sourceFiles=[
 ['src/core/model.mjs','modelSHA256'],['src/core/contracts.mjs','contractsSHA256'],
 ['src/core/data.mjs','dataSHA256'],['src/core/api.mjs','apiSHA256'],
 ['src/core/interaction.mjs','interactionSHA256'],['src/core/indicators.mjs','indicatorsSHA256']
];
const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function verifyEnvironment(){
 if(process.version!==HEADER.node||process.versions.v8!==HEADER.v8)throw new Error(`model oracle requires Node ${HEADER.node} / V8 ${HEADER.v8}; got ${process.version} / ${process.versions.v8}`);
 for(const [path,key] of sourceFiles)if(sha256(join(root,path))!==HEADER[key])throw new Error(`model oracle source hash changed: ${path}`);
}

const buffer=new ArrayBuffer(8),view=new DataView(buffer);
function f64(value){view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value){
 if(typeof value==='number')return{$f64:f64(value)};
 if(typeof value==='string'||typeof value==='boolean'||value===null)return value;
 if(value===undefined)return{$undefined:true};
 if(value instanceof Float64Array)return{$f64array:Array.from(value,f64)};
 if(Array.isArray(value))return value.map(encode);
 if(value&&typeof value==='object')return{$object:Object.entries(value).map(([key,child])=>[key,encode(child)])};
 throw new TypeError('Unsupported model oracle value');
}
function portableSeries(series){const output={};for(const key of SERIES_KEYS)if(key!=='values'&&Object.hasOwn(series,key))output[key]=series[key];return output;}
function snapshot(model){return{view:{from:model.view.from,to:model.view.to},theme:model.theme,panels:model.panels,axes:model.axes,series:model.series.map(portableSeries),axisWidth:model.axisWidth,precision:model.precision,follow:model.follow};}
function outcome(run){try{return{ok:run()};}catch(error){return{error:{name:error.name,message:error.message}};}}
function bar(time,close=time+10){return{time,open:close-1,high:close+2,low:close-2,close,volume:Math.abs(time)+1};}
function fresh(options={}){return new ChartModel({store:new BarStore(options.bars??[]),...(options.model??{})});}

const validations=[
 ['panel-unknown','addPanel',{id:'x',extra:1}],
 ['panel-missing','addPanel',{}],
 ['panel-string-weight','addPanel',{id:'x',weight:'1'}],
 ['panel-null-weight','addPanel',{id:'x',weight:null}],
 ['panel-undefined-weight','addPanel',{id:'x',weight:undefined}],
 ['panel-axis-visible','addPanel',{id:'x',axisVisible:null}],
 ['panel-inverted','addPanel',{id:'x',inverted:0}],
 ['panel-range-shape','addPanel',{id:'x',range:{0:1,1:2}}],
 ['panel-range-values','addPanel',{id:'x',range:[2,1]}],
 ['panel-percent-zero','addPanel',{id:'x',scale:'percent',base:-0}],
 ['axis-missing','addAxis',{}],
 ['axis-panel','addAxis',{id:'x',panel:'missing'}],
 ['axis-side','addAxis',{id:'x',panel:'price',side:'middle'}],
 ['axis-percent','addAxis',{id:'x',panel:'price',scale:'percent'}],
 ['axis-percent-null','addAxis',{id:'x',panel:'price',scale:'percent',base:null}],
 ['series-missing','addSeries',{}],
 ['series-axis','addSeries',{id:'x',panel:'price',type:'line',axisId:'missing'}],
 ['series-symbol','addSeries',{id:'x',panel:'price',type:'line',symbolId:'s'}],
 ['series-style','addSeries',{id:'x',panel:'price',type:'line',width:0}],
 ['series-candle-source','addSeries',{id:'x',panel:'price',type:'candles',source:'close'}],
 ['series-type','addSeries',{id:'x',panel:'price',type:'spline'}],
 ['series-values-array','addSeries',{id:'x',panel:'price',type:'line',values:[]}],
 ['series-source','addSeries',{id:'x',panel:'price',type:'line',source:'median'}],
 ['series-offset','addSeries',{id:'x',panel:'price',type:'line',offset:1.5}],
 ['order-short','setPanelOrder',['price'],'panels'],
 ['order-duplicate','setPanelOrder',['price','price'],'panels'],
 ['order-missing','setPanelOrder',['price','missing'],'panels'],
 ['placement-missing-indicator','placement',{panel:'price'},'none'],
 ['placement-no-bound-series','placement',{panel:'price'},'indicator'],
 ['placement-extra-field','placement',{panel:'price',extra:true},'bound'],
 ['placement-panel-required','placement',{axisId:null},'bound'],
 ['placement-axis-type','placement',{panel:'price',axisId:7},'bound'],
 ['placement-missing-panel','placement',{panel:'missing'},'bound'],
 ['placement-missing-axis','placement',{panel:'price',axisId:'missing'},'bound'],
 ['set-panel-missing','setPanel',{id:'missing',patch:{}}],
 ['set-axis-missing','setAxis',{id:'missing',patch:{}}],
 ['remove-panel-last','removePanel','price'],
 ['remove-panel-missing','removePanel','missing','panels'],
 ['remove-panel-series','removePanel','lower','panel-series'],
 ['remove-panel-axis','removePanel','lower','panel-axis'],
 ['remove-axis-series','removeAxis','axis','axis-series'],
 ['drawing-missing-panel','validateDrawingBinding',{panel:'missing'}],
 ['drawing-missing-axis','validateDrawingBinding',{panel:'price',axisId:'missing'}],
 ['drawing-mismatched-series','validateDrawingBinding',{panel:'lower',seriesId:'line'},'binding-series']
];

function setupValidation(model,setup){
 if(['panels','panel-series','panel-axis','axis-series','binding-series'].includes(setup))model.addPanel({id:'lower'});
 if(setup==='panel-series')model.addSeries({id:'line',type:'line',panel:'lower',source:'close'});
 if(setup==='panel-axis')model.addAxis({id:'axis',panel:'lower'});
 if(setup==='axis-series'){model.addAxis({id:'axis',panel:'lower'});model.addSeries({id:'line',type:'line',panel:'lower',axisId:'axis',source:'close'});}
 if(setup==='binding-series')model.addSeries({id:'line',type:'line',panel:'price',source:'close'});
 if(setup==='indicator'||setup==='bound')model.indicators.add('study','sma',{period:2});
 if(setup==='bound')model.addSeries({id:'study-line',type:'line',panel:'price',indicator:'study'});
}
function invokeValidation(model,operation,input){
 if(operation==='addPanel')return model.addPanel(input);
 if(operation==='addAxis')return model.addAxis(input);
 if(operation==='addSeries')return model.addSeries(input);
 if(operation==='setPanelOrder')return model.setPanelOrder(input);
 if(operation==='placement')return model._setIndicatorPlacement('study',input);
 if(operation==='setPanel')return model.setPanel(input.id,input.patch);
 if(operation==='setAxis')return model.setAxis(input.id,input.patch);
 if(operation==='removePanel')return model.removePanel(input);
 if(operation==='removeAxis')return model.removeAxis(input);
 if(operation==='validateDrawingBinding')return model.validateDrawingBinding(input);
 throw new Error(`Unknown validation operation ${operation}`);
}
function validationRows(){return validations.map(([id,operation,input,setup='none'])=>{
 const model=fresh();setupValidation(model,setup);const before=snapshot(model),result=outcome(()=>invokeValidation(model,operation,input)),after=snapshot(model);model.dispose();
 if(!result.error)throw new Error(`Expected validation error: ${id}`);
 return{kind:'validation',id,operation,setup,input:encode(input),expected:encode({before,result,after})};
});}

function recordRows(){
 const defaults=fresh(),defaultResult={snapshot:snapshot(defaults),forwardOffset:defaults.forwardOffset()};defaults.dispose();
 const model=fresh({model:{theme:{font:'13px serif',background:'#ffffff'},panels:[{padding:.2,id:'price',weight:3},{id:'lower'}]}});
 const axis=model.addAxis({panel:'lower',id:'lower-axis',side:'left'});
 model.indicators.add('ichi','ichimoku',{conversion:2,base:3,span:4,displacement:5});
 const indicator=model.addSeries({panel:'price',indicator:'ichi',output:'spanA',type:'line',id:'ichi-line'});
 const line=model.addSeries({source:'close',offset:-0,panel:'price',type:'line',id:'line'});
 const placement=model._setIndicatorPlacement('ichi',{panel:'lower',axisId:'lower-axis'});
 const customResult={axis,indicator,line,placement,forwardOffset:model.forwardOffset(),snapshot:snapshot(model)};model.dispose();
 return[
  {kind:'record',id:'defaults',expected:encode(defaultResult)},
  {kind:'record',id:'custom-indicator-placement',expected:encode(customResult)}
 ];
}

function runGuard(id){
 const model=fresh();let controller=null;
 if(['set-panel-transaction','panel-order-gesture','axis-layout-transaction','remove-axis-gesture','placement-gesture','placement-transaction','placement-success'].includes(id))model.addPanel({id:'lower'});
 if(['remove-axis-gesture','placement-success'].includes(id))model.addAxis({id:'lower-axis',panel:'lower',side:'left'});
 if(['placement-gesture','placement-transaction','placement-success'].includes(id)){model.indicators.add('study','sma',{period:2});model.addSeries({id:'study-line',type:'line',panel:'price',indicator:'study'});}
 if(['panel-order-gesture','remove-axis-gesture','placement-gesture'].includes(id)){controller=new InteractionController(model,()=>({width:800,height:600}));controller.gesture={kind:'pan'};}
 if(id==='set-panel-transaction'){model.drawings.add({id:'d',type:'horizontal',panel:'lower',points:[{time:0,price:1}]});model.drawings.begin();}
 if(['add-panel-transaction','axis-layout-transaction','placement-transaction'].includes(id))model.drawings.begin();
 const before=snapshot(model);
 const result=outcome(()=>{
  if(id==='add-panel-transaction')return model.addPanel({id:'extra'});
  if(id==='set-panel-transaction')return model.setPanel('lower',{scale:'log'});
  if(id==='panel-order-gesture')return model.setPanelOrder(['lower','price'],{controller});
  if(id==='axis-layout-transaction')return model.addAxis({id:'axis',panel:'lower',side:'left'});
  if(id==='remove-axis-gesture')return model.removeAxis('lower-axis',{controller});
  if(id==='placement-gesture')return model._setIndicatorPlacement('study',{panel:'lower'},{controller});
  if(id==='placement-transaction')return model._setIndicatorPlacement('study',{panel:'lower'});
  if(id==='placement-success')return model._setIndicatorPlacement('study',{panel:'lower',axisId:'lower-axis'});
  throw new Error(`Unknown guard case ${id}`);
 });
 const after=snapshot(model);model.drawings.cancel();model.dispose();return{kind:'guard',id,expected:encode({before,result,after})};
}
function guardRows(){return['add-panel-transaction','set-panel-transaction','panel-order-gesture','axis-layout-transaction','remove-axis-gesture','placement-gesture','placement-transaction','placement-success'].map(runGuard);}

function nextRandom(state){state.value=(Math.imul(state.value,1664525)+1013904223)>>>0;return state.value/0x100000000;}
function viewOperations(){
 const operations=[
  {op:'set',from:-100,to:100},{op:'zoom',factor:.5,anchor:'0.25'},{op:'pan',delta:null},
  {op:'pan',delta:'1'},{op:'zoom',factor:2,anchor:true},{op:'fit'},
  {op:'zoom',factor:.75,anchor:'\t\n 0.25 \ufeff'},
  {op:'zoom',factor:.75,anchor:'0x10'},{op:'zoom',factor:.75,anchor:'0o10'},
  {op:'zoom',factor:.75,anchor:'0b10'},{op:'zoom',factor:.75,anchor:'.5'},
  {op:'zoom',factor:.75,anchor:'12.'},{op:'zoom',factor:.75,anchor:[]},
  {op:'zoom',factor:.75,anchor:[.75]},{op:'zoom',factor:.75,anchor:null},
  {op:'zoom',factor:.75,anchor:{}},{op:'zoom',factor:.75,anchor:{toString:0}},
  {op:'zoom',factor:.75,anchor:'-0'},{op:'zoom',factor:.75,anchor:'+0'},
  {op:'zoom',factor:.75,anchor:NaN},{op:'zoom',factor:.75,anchor:'NaN'},
  {op:'zoom',factor:.75,anchor:'0x'+('f'.repeat(400))},
  {op:'zoom',factor:.75,anchor:'9'.repeat(5000)},
  {op:'pan',delta:1},{op:'pan',delta:-0},{op:'pan',delta:NaN},
  {op:'pan',delta:null},{op:'pan',delta:true},{op:'pan',delta:'1'},
  {op:'pan',delta:[]},{op:'pan',delta:[1]},{op:'pan',delta:{}},
  {op:'pan',delta:{toString:0}},{op:'pan',delta:undefined}
 ];
 const random={value:0x6d2b79f5},anchors=[null,true,false,'0.25','bad',.75,[],[.5],{}],deltas=[null,true,false,'1',-20,-.5,.5,20,[],{}];
 for(let index=0;index<40;index++){
  const choice=Math.floor(nextRandom(random)*3);
  if(choice===0){const from=(nextRandom(random)*200)-80,span=index%7===0?0:nextRandom(random)*120;operations.push({op:'set',from,to:from+span});}
  else if(choice===1){const factors=[.1,.5,1,2,0,-1][Math.floor(nextRandom(random)*6)],anchor=anchors[Math.floor(nextRandom(random)*anchors.length)];operations.push({op:'zoom',factor:factors,anchor});}
  else operations.push({op:'pan',delta:deltas[Math.floor(nextRandom(random)*deltas.length)]});
 }
 return operations;
}
function runViewOperation(model,operation){
 if(operation.op==='set')return model.setVisibleRange(operation.from,operation.to);
 if(operation.op==='zoom')return model.zoom(operation.factor,operation.anchor);
 if(operation.op==='pan')return model.pan(operation.delta);
 if(operation.op==='fit')return model.fit();
 throw new Error(`Unknown view operation ${operation.op}`);
}
function viewRow(){
 const bars=Array.from({length:64},(_,index)=>bar(index));const model=fresh({bars,model:{visibleBars:12}});model.addSeries({id:'future',type:'line',panel:'price',source:'close',offset:3});
 const result={initial:{view:{...model.view},follow:model.follow,forwardOffset:model.forwardOffset()},frames:[]};
 for(const operation of viewOperations()){
  const outcomeValue=outcome(()=>runViewOperation(model,operation));
  const candidate=operation.op==='zoom'?operation.anchor:operation.op==='pan'?operation.delta:null;
  const shadow=candidate&&typeof candidate==='object'&&Object.hasOwn(candidate,'toString');
  const targetResults=shadow?{
   apple:{error:{name:'TypeError',message:'No default value'}},
   android:{error:{name:'TypeError',message:'toPrimitive'}},
   other:outcomeValue
  }:undefined;
  result.frames.push({operation,result:outcomeValue,view:{...model.view},follow:model.follow,...(targetResults?{targetResults}:{})});
 }
 model.dispose();return{kind:'view',id:'deterministic-view-state-machine',bars:encode(bars),expected:encode(result)};
}

function storeRow(){
 const bars=Array.from({length:12},(_,index)=>bar(index)),model=fresh({bars,model:{visibleBars:5}});model.addSeries({id:'future',type:'line',panel:'price',source:'close',offset:3});
 const frames=[],capture=(operation,result)=>frames.push({operation,result,view:{...model.view},follow:model.follow});
 capture('initial',null);capture('append-follow',outcome(()=>model.store.append(bar(12))));
 capture('set-unfollow',outcome(()=>model.setVisibleRange(0,10)));capture('append-unfollow',outcome(()=>model.store.append(bar(13))));
 capture('fit',outcome(()=>model.fit()));capture('append-follow-again',outcome(()=>model.store.append(bar(14))));
 capture('prepend-rebase',outcome(()=>model.store.prepend([bar(-2),bar(-1)])));
 capture('reset-short',outcome(()=>model.store.setData([bar(100),bar(101),bar(102)])));
 const result={bars,frames,snapshot:snapshot(model)};model.dispose();return{kind:'store',id:'store-listener-view-effects',expected:encode(result)};
}

export function generateModelOracle(){verifyEnvironment();const rows=[HEADER,...recordRows(),...validationRows(),...guardRows(),viewRow(),storeRow()];return rows.map(row=>JSON.stringify(row)).join('\n')+'\n';}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-model/generate-model.mjs [--check|--write]');
 const output=generateModelOracle();
 if(mode==='--check'){
  if(readFileSync(fixture,'utf8')!==output)throw new Error('model-oracle.jsonl is stale');
  console.log(`model oracle fresh: ${HEADER.caseCounts.record} record, ${HEADER.caseCounts.validation} validation, ${HEADER.caseCounts.guard} guard, ${HEADER.caseCounts.view} view, ${HEADER.caseCounts.store} store`);
 }else if(mode==='--write'){
  writeFileSync(fixture,output);console.log(`wrote ${fixture}`);
 }else process.stdout.write(output);
}
