#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {DrawingStore,drawingGeometry} from '../../../src/core/drawings.mjs';
import {BarStore} from '../../../src/core/data.mjs';
import {ChartAPI} from '../../../src/core/api.mjs';
import {capturePointerCrosshair} from '../../../src/core/crosshair-snap.mjs';
import {InteractionController} from '../../../src/core/interaction.mjs';
import {ChartModel,createLayout} from '../../../src/core/model.mjs';
import {buildScene} from '../../../src/core/scene.mjs';
import {aggregateVolumeSeries,createDrawingCommands,formatAxisValue} from '../../../src/core/scene-parts.mjs';
import {createCrosshairCommands} from '../../../src/core/scene-parts.mjs';
import {resolveCrosshairSnapshot} from '../../../src/core/crosshair-snap.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-model/scene-oracle.jsonl');
const JSC='/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
const HEADER=Object.freeze({
 kind:'header',schema:'barochart.rust-model.scene-oracle',version:1,
 workspaceBase:'957540f7f11d6c0dfc4da1c2a53c0533b901abac',
 sceneSHA256:'f27b48dbbd05f2176505807973047e6813be4cd151953e738f76dff9771587b2',
 scenePartsSHA256:'ce945b315c563e6f7cdce960f198159d7cf82253dbd0333953d8d7d685ff929d',
 drawingsSHA256:'0cf404f1d9f9525fe3fe09a83bc4cd9a31b9a5c8668487248bcb18cd234da667',
 modelSHA256:'64bb1a0a042841a9386a6f8f500c0e5f96a952d4a09602f91e2f3ef333f356ad',
 labelsSHA256:'a5f47cd2a29aead2ee553a2acf2f6c3125205b353c29ad956f304391bad93ffa',
 drawingValidationSHA256:'4c2320c1db63dbb9175416f2105948948e800fbb4c636a68121990a6fe81abe8',
 positionDrawingSHA256:'0b96416c0b3c594207bcbf0629617ce9b541321495343c22b0c35f86eed228b2',
 marketsSHA256:'605de3d5a787145980b832022fbb06318bb3db65a0ec9e89933c9365ef847cf5',
 apiSHA256:'581dfd1556e31770afc308c76afe7a1d27f75ce92d0e86f715871e832b4dffe8',
 node:'v22.20.0',v8:'12.4.254.21-node.33',jsc:'system JavaScriptCore Math.log',
 seed:'scene-v1-fixed',encoding:'f64 big-endian bits; objects as ordered entry arrays; undefined explicitly tagged',
 callSequence:['DrawingStore.add','drawingGeometry twice with immutable drawing and geometryKey'],
 caseCounts:{drawing:20,format:5,aggregate:7,drawingCommands:2,scene:8,crosshair:2}
});
const sourceFiles=[
 ['src/core/scene.mjs','sceneSHA256'],['src/core/scene-parts.mjs','scenePartsSHA256'],
 ['src/core/drawings.mjs','drawingsSHA256'],['src/core/model.mjs','modelSHA256'],
 ['src/core/labels.mjs','labelsSHA256'],['src/core/drawing-validation.mjs','drawingValidationSHA256'],
 ['src/core/position-drawing.mjs','positionDrawingSHA256'],['src/core/markets.mjs','marketsSHA256'],['src/core/api.mjs','apiSHA256']
];
const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function verifyEnvironment(){
 if(process.version!==HEADER.node||process.versions.v8!==HEADER.v8)throw new Error(`scene oracle requires Node ${HEADER.node} / V8 ${HEADER.v8}; got ${process.version} / ${process.versions.v8}`);
 for(const [path,key] of sourceFiles)if(sha256(join(root,path))!==HEADER[key])throw new Error(`scene oracle source hash changed: ${path}`);
}

const bitsBuffer=new ArrayBuffer(8),bitsView=new DataView(bitsBuffer);
function f64(value){bitsView.setFloat64(0,value,false);return bitsView.getBigUint64(0,false).toString(16).padStart(16,'0');}
function fromF64(hex){bitsView.setBigUint64(0,BigInt('0x'+hex),false);return bitsView.getFloat64(0,false);}
function encode(value){
 if(typeof value==='number')return{$f64:f64(value)};
 if(typeof value==='string'||typeof value==='boolean'||value===null)return value;
 if(value===undefined)return{$undefined:true};
 if(value instanceof Float64Array)return{$f64array:Array.from(value,f64)};
 if(Array.isArray(value))return value.map(encode);
 if(value&&typeof value==='object')return{$object:Object.entries(value).filter(([,child])=>typeof child!=='function').map(([key,child])=>[key,encode(child)])};
 throw new TypeError('Unsupported scene oracle value');
}
const point=(index,price)=>({time:index*60000,price});
const style={color:'#336699',width:2,fill:'#11223344',font:'16px serif'};
const drawings=[
 ['trendline','linear',[point(8,95),point(34,125)]],
 ['horizontal','linear',[point(12,105)]],
 ['fibonacci','log',[point(10,60),point(42,145)]],
 ['rectangle','linear',[point(15,90),point(38,128)]],
 ['ellipse','linear',[point(16,92),point(40,130)]],
 ['text','linear',[point(18,118)],{text:'한국 🚀'}],
 ['ray','linear',[point(20,100),point(30,112)]],
 ['extendedline','linear',[point(22,108),point(35,98)]],
 ['channel','linear',[point(9,98),point(29,119),point(9,88)]],
 ['fibextension','percent',[point(11,90),point(25,118),point(31,102)]],
 ['fibfan','log',[point(13,70),point(41,140)]],
 ['fibtimezones','linear',[point(5,100),point(9,110)]],
 ['freehand','linear',[point(7,94),point(14,101),point(22,97),point(31,115),point(45,108)]],
 ['measurement','linear',[point(10,105),point(20,112)]],
 ['longposition','linear',[point(12,100),point(12,90),point(12,120),point(36,100)]],
 ['shortposition','linear',[point(14,100),point(14,110),point(14,80),point(38,100)]]
];
const layoutSpecs={
 linear:{scale:'linear',min:50,max:160,base:100,left:20,right:620,top:20,bottom:320,from:0,to:60,font:'12px monospace'},
 log:{scale:'log',min:50,max:160,base:100,left:20,right:620,top:20,bottom:320,from:0,to:60,font:'12px monospace'},
 percent:{scale:'percent',min:50,max:160,base:100,left:20,right:620,top:20,bottom:320,from:0,to:60,font:'12px monospace'}
};
function transform(spec,value){return spec.scale==='log'?Math.log(value):spec.scale==='percent'?(value/spec.base-1)*100:value;}
function yFor(spec,value){const lo=transform(spec,spec.min),hi=transform(spec,spec.max),delta=hi-lo,origin=hi,extent=-delta;return spec.top+(transform(spec,value)-origin)/extent*(spec.bottom-spec.top);}
function makeLayout(spec,key,{missingAxis=false,yOverride=null,collectPrices=null}={}){
 const axis={id:'price',axisId:null,left:spec.left,right:spec.right,top:spec.top,bottom:spec.bottom,y(value){collectPrices?.push(value);return yOverride?yOverride(value):yFor(spec,value);}};
 const x=index=>spec.left+(index-spec.from)/(spec.to-spec.from)*(spec.right-spec.left);
 const index=sx=>spec.from+(sx-spec.left)/(spec.right-spec.left)*(spec.to-spec.from);
 return{
  geometryKey:key,geometryFont:spec.font,panels:[axis],index,
  drawingAxis(drawing){return !missingAxis&&drawing.panel==='price'&&drawing.axisId==null&&drawing.seriesId==null?axis:undefined;},
  toScreen(value,panel,axisId){if(panel!=='price'||axisId!=null||missingAxis)return{x:NaN,y:NaN};return{x:x(value.time/60000),y:axis.y(value.price)};}
 };
}
function canonicalDrawing(input){const store=new DrawingStore();store.add(input);return store.items[0];}
function jscLogY(spec,prices){
 const source=`const values=${JSON.stringify(prices)},spec=${JSON.stringify(spec)},b=new ArrayBuffer(8),v=new DataView(b);const h=n=>{v.setFloat64(0,n,false);return v.getUint32(0,false).toString(16).padStart(8,'0')+v.getUint32(4,false).toString(16).padStart(8,'0')};const lo=Math.log(spec.min),hi=Math.log(spec.max),delta=hi-lo,origin=hi,extent=-delta;print(JSON.stringify(values.map(value=>h(spec.top+(Math.log(value)-origin)/extent*(spec.bottom-spec.top)))));`;
 return JSON.parse(execFileSync(JSC,['-e',source],{encoding:'utf8',maxBuffer:16*1024*1024})).map(fromF64);
}
function geometryRow(id,kind,scale,points,extra={}){
 const spec=layoutSpecs[scale],input={id,panel:'price',locked:false,style:{...style},type:kind,points,...extra},drawing=canonicalDrawing(input),prices=[];
 const v8Layout=makeLayout(spec,`${id}-v8`,{collectPrices:prices}),expectedV8=drawingGeometry(drawing,v8Layout),cached=drawingGeometry(drawing,v8Layout);
 if(cached!==expectedV8)throw new Error(`drawingGeometry cache identity changed: ${id}`);
 let expectedJsc=null;
 if(scale==='log'){
  const jscValues=jscLogY(spec,prices),queues=new Map();
  for(let index=0;index<prices.length;index++){const key=f64(prices[index]),queue=queues.get(key)??[];queue.push(jscValues[index]);queues.set(key,queue);}
  const jscLayout=makeLayout(spec,`${id}-jsc`,{yOverride:value=>{const queue=queues.get(f64(value));if(!queue?.length)throw new Error(`missing JSC log projection ${value}`);return queue.shift();}});
  expectedJsc=drawingGeometry(drawing,jscLayout);
 }
 return{kind:'drawing',id,scale,layout:encode(spec),input:encode(input),expectedV8:encode(expectedV8),...(expectedJsc?{expectedJsc:encode(expectedJsc)}:{})};
}
function drawingRows(){
 const rows=drawings.map(([kind,scale,points,extra])=>geometryRow(`drawing-${kind}`,kind,scale,points,extra));
 rows.push(geometryRow('drawing-hidden','trendline','linear',[point(8,95),point(34,125)],{visible:false}));
 const missing={id:'drawing-unbound',panel:'price',locked:false,style:{...style},type:'trendline',points:[point(8,95),point(34,125)],axisId:'missing'},drawing=canonicalDrawing(missing),spec=layoutSpecs.linear;
 rows.push({kind:'drawing',id:'drawing-unbound',scale:'linear',layout:encode(spec),input:encode(missing),expectedV8:encode(drawingGeometry(drawing,makeLayout(spec,'unbound',{missingAxis:true})))});
 rows.push(geometryRow('drawing-collapsed-ray','ray','linear',[point(20,100),point(20,100)]));
 rows.push(geometryRow('drawing-negative-log','trendline','log',[point(8,-5),point(34,125)]));
 return rows;
}

function formatRows(){
 const rows=[
  {id:'format-linear-fixed',model:{precision:3},axis:{precision:2,scale:'linear',tickFormat:'fixed',prefix:'$',suffix:' USD',axisId:'usd',id:'usd',transform:value=>value},value:123.456},
  {id:'format-linear-scientific',model:{precision:4},axis:{scale:'linear',tickFormat:'scientific',prefix:'',suffix:'',axisId:'sci',id:'sci',transform:value=>value},value:12345.5},
  {id:'format-percent',model:{precision:6},axis:{precision:3,scale:'percent',tickFormat:'fixed',prefix:'',suffix:' rel',axisId:null,id:'price',base:100,transform:value=>(value/100-1)*100},value:112.5},
  {id:'format-symbol-price',model:{precision:7,priceFormatter:value=>value.toFixed(2)},symbol:{priceDecimals:2},axis:{scale:'linear',tickFormat:'fixed',axisId:null,id:'price',transform:value=>value},value:123.456},
  {id:'format-percent-ignores-symbol',model:{precision:7,priceFormatter:value=>'BAD '+value},symbol:{priceDecimals:2},axis:{precision:2,scale:'percent',tickFormat:'fixed',axisId:null,id:'price',base:50,transform:value=>(value/50-1)*100},value:75}
 ];
 return rows.map(({id,model,axis,value,symbol})=>{
  const serialAxis={...axis};delete serialAxis.transform;
  return{kind:'format',id,input:encode({model:{precision:model.precision},axis:serialAxis,value,symbol:symbol??null}),expected:formatAxisValue(model,axis,value)};
 });
}

function aggregateRows(){
 const rows=[
  ['aggregate-volume', {type:'histogram',source:'volume',offset:0,baseline:0}],
  ['aggregate-volume-negative-zero', {type:'histogram',source:'volume',offset:-0,baseline:-0}],
  ['aggregate-line', {type:'line',source:'volume',offset:0,baseline:0}],
  ['aggregate-offset', {type:'histogram',source:'volume',offset:1,baseline:0}],
  ['aggregate-values', {type:'histogram',source:'volume',values:[1],offset:0,baseline:0}],
  ['aggregate-indicator', {type:'histogram',source:'volume',indicator:'study',offset:0,baseline:0}],
  ['aggregate-null-baseline', {type:'histogram',source:'volume',offset:0,baseline:null}]
 ];
 return rows.map(([id,series])=>({kind:'aggregate',id,input:encode(series),expected:aggregateVolumeSeries(series)}));
}

function drawingCommandRows(){
 const inputs=drawings.map(([kind,,points,extra])=>({id:`command-${kind}`,panel:'price',locked:false,style:{...style},type:kind,points,...extra}));
 const store=new DrawingStore();for(const input of inputs)store.add(input);
 const spec=layoutSpecs.linear,layout=makeLayout(spec,'commands-all'),theme={background:'#0c1320',grid:'#1d2a3a',text:'#8093ad',up:'#35d2ab',down:'#fa6c7c',crosshair:'#b9c9de',font:'48px serif'};
 const all=createDrawingCommands({theme,drawings:store},layout);
 const lockedStore=new DrawingStore();const locked={id:'command-locked',panel:'price',locked:true,style:{color:'#aabbcc',width:3},type:'rectangle',points:[point(12,90),point(30,120)]};lockedStore.add(locked);
 const lockedCommands=createDrawingCommands({theme,drawings:lockedStore},makeLayout(spec,'commands-locked'));
 return[
  {kind:'drawing-commands',id:'all-types-selected-last',layout:encode(spec),theme:encode(theme),inputs:encode(inputs),selected:store.selected,expectedV8:encode(all)},
  {kind:'drawing-commands',id:'locked-selected-handles',layout:encode(spec),theme:encode(theme),inputs:encode([locked]),selected:lockedStore.selected,expectedV8:encode(lockedCommands)}
 ];
}

const DAY=1704067200000;
function bar(index,close=100+index){return{time:DAY+index*60000,open:close-1,high:close+3,low:close-3,close,volume:(index+1)*10};}
function sceneModel(spec){
 const model=new ChartModel({store:new BarStore(spec.bars),...(spec.model??{})});
 for(const series of spec.series??[]){const input={...series};if(Array.isArray(input.values))input.values=Float64Array.from(input.values);model.addSeries(input);}
 for(const drawing of spec.drawings??[])model.drawings.add(drawing);
 if(spec.symbol)new ChartAPI(model).setSymbol(spec.symbol);
 return model;
}
function marketBar(iso,index){const close=100+index;return{time:Date.parse(iso),open:close-1,high:close+2,low:close-2,close,volume:(index+1)*10};}
function sceneSpecs(){
 const compositeBars=Array.from({length:12},(_,index)=>bar(index,100+[0,2,-1,4,3,6,5,8,7,9,11,10][index]));
 return[
  {id:'scene-empty',width:1200,height:700,bars:[],model:{},series:[],flags:{crosshair:true,drawings:true}},
  {id:'scene-composite',width:640,height:360,bars:compositeBars,model:{visibleBars:8,axisWidth:60,precision:2,panels:[{id:'price',weight:3,label:'Price'},{id:'volume',weight:1,label:'Volume'}],axes:[{id:'percent',panel:'price',side:'left',scale:'percent',base:100,precision:2,tickFormat:'fixed',prefix:'',suffix:' rel'}]},series:[
   {id:'candles',type:'candles',panel:'price'},
   {id:'ohlc',type:'ohlc',panel:'price',upColor:'#00aa88',downColor:'#dd3355'},
   {id:'close-line',type:'line',panel:'price',source:'close',offset:1,color:'#2244ff',width:2,label:'Close+1'},
   {id:'area-gap',type:'area',panel:'price',values:[98,99,NaN,101,102,NaN,104,105,106,107,108,109],color:'#8855ff',fill:'#8855ff33',baseline:95},
   {id:'hist-gap',type:'histogram',panel:'price',values:[1,2,NaN,4,5,6,7,8,9,10,11,12],color:'#ffaa00',baseline:-0},
   {id:'percent-line',type:'line',panel:'price',axisId:'percent',values:[100,101,99,104,103,106,105,108,107,109,111,110],color:'#00aaff'},
   {id:'volume',type:'histogram',panel:'volume',source:'volume',color:'#7898ff'}
  ],flags:{crosshair:false,drawings:false}},
  {id:'scene-compact-font48',width:320,height:240,bars:[bar(0),bar(1,103),bar(2,101),bar(3,106)],model:{visibleBars:4,theme:{font:'48px serif',text:'#123456'},panels:[{id:'price',weight:3,label:'A very long panel title'}]},series:[{id:'candles',type:'candles',panel:'price'},{id:'line',type:'line',panel:'price',source:'close',label:'Long series label'}],flags:{crosshair:false,drawings:false}},
  {id:'scene-log',width:480,height:300,bars:[bar(0,50),bar(1,60),bar(2,75),bar(3,100),bar(4,130),bar(5,150)],model:{visibleBars:6,panels:[{id:'price',weight:3,scale:'log',padding:.05,label:'Log'}]},series:[{id:'candles',type:'candles',panel:'price'},{id:'line',type:'line',panel:'price',source:'close',color:'#336699'}],flags:{crosshair:false,drawings:false}},
  {id:'scene-sampled-buckets',width:320,height:240,bars:Array.from({length:200},(_,index)=>bar(index,100+(index%17)-8)),model:{visibleBars:200},series:[{id:'candles',type:'candles',panel:'price'},{id:'line',type:'line',panel:'price',source:'close',color:'#336699'}],flags:{crosshair:false,drawings:false}},
  {id:'scene-symbol-seoul',width:480,height:280,bars:['2024-01-02T00:00:00Z','2024-01-02T02:00:00Z','2024-01-02T04:00:00Z','2024-01-02T06:00:00Z'].map(marketBar),model:{visibleBars:4},symbol:{id:'KR',exchange:'XKRX',timezone:'Asia/Seoul',currency:'KRW',volumeUnit:'shares',priceDecimals:0,tickSize:1,adjustment:'raw'},series:[{id:'candles',type:'candles',panel:'price'}],flags:{crosshair:false,drawings:false}},
  {id:'scene-symbol-new-york-dst',width:480,height:280,bars:['2024-03-10T06:30:00Z','2024-03-10T07:30:00Z','2024-03-10T08:30:00Z','2024-03-10T09:30:00Z'].map(marketBar),model:{visibleBars:4},symbol:{id:'US',exchange:'XNYS',timezone:'America/New_York',currency:'USD',volumeUnit:'shares',priceDecimals:2,tickSize:.01,adjustment:'raw'},series:[{id:'candles',type:'candles',panel:'price'}],flags:{crosshair:false,drawings:false}},
  {id:'scene-symbol-santiago-dst',width:480,height:280,bars:['2024-09-08T03:30:00Z','2024-09-08T04:30:00Z','2024-09-08T05:30:00Z','2024-09-08T06:30:00Z'].map(marketBar),model:{visibleBars:4},symbol:{id:'CL',exchange:'XSGO',timezone:'America/Santiago',currency:'CLP',volumeUnit:'shares',priceDecimals:0,tickSize:1,adjustment:'raw'},series:[{id:'candles',type:'candles',panel:'price'}],flags:{crosshair:false,drawings:false}}
 ];
}
function sceneRows(){return sceneSpecs().map(spec=>{const model=sceneModel(spec);const scene=buildScene(model,spec.width,spec.height,spec.flags);const row={kind:'scene',id:spec.id,input:encode(spec),expectedV8:encode(scene)};model.dispose();return row;});}

function crosshairRows(){
 const spec={bars:Array.from({length:8},(_,index)=>bar(index,100+index*2)),model:{visibleBars:8,panels:[{id:'price',weight:3,label:'Price'}]},series:[{id:'candles',type:'candles',panel:'price'}],width:640,height:360};
 const rows=[];
 for(const mode of ['free','ohlc']){
  const model=sceneModel(spec),layout=createLayout(model,spec.width,spec.height),axis=layout.axis('price',null),x=layout.x(3.2),y=axis.y(107);
  const controller=new InteractionController(model,()=>({width:spec.width,height:spec.height}));
  controller.setCrosshairSnap({mode},{notify:false});capturePointerCrosshair(controller,x,y);
  const resolved=resolveCrosshairSnapshot(model,layout),commands=createCrosshairCommands(model,layout);
  rows.push({kind:'crosshair',id:`crosshair-${mode}`,input:encode({...spec,theme:model.theme}),layout:encode(layout),resolved:encode(resolved),expectedV8:encode(commands)});
  model.dispose();
 }
 return rows;
}

export function generateSceneOracle(){
 verifyEnvironment();const geometry=drawingRows(),format=formatRows(),aggregate=aggregateRows(),drawingCommands=drawingCommandRows(),scene=sceneRows(),crosshair=crosshairRows();
 for(const [name,rows] of Object.entries({drawing:geometry,format,aggregate,drawingCommands,scene,crosshair}))if(rows.length!==HEADER.caseCounts[name])throw new Error(`${name} case count ${rows.length}`);
 return[HEADER,...geometry,...format,...aggregate,...drawingCommands,...scene,...crosshair].map(row=>JSON.stringify(row)).join('\n')+'\n';
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-model/generate-scene.mjs [--check|--write]');
 const output=generateSceneOracle();
 if(mode==='--check'){
  if(readFileSync(fixture,'utf8')!==output)throw new Error('scene-oracle.jsonl is stale');
  console.log(`scene oracle fresh: ${HEADER.caseCounts.drawing} drawing, ${HEADER.caseCounts.format} format, ${HEADER.caseCounts.aggregate} aggregate, ${HEADER.caseCounts.drawingCommands} drawing-commands, ${HEADER.caseCounts.scene} scene, ${HEADER.caseCounts.crosshair} crosshair`);
 }else if(mode==='--write'){
  writeFileSync(fixture,output);console.log(`wrote ${fixture}`);
 }else process.stdout.write(output);
}
