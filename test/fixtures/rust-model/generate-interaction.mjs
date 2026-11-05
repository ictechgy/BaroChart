#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {BarStore} from '../../../src/core/data.mjs';
import {InteractionController} from '../../../src/core/interaction.mjs';
import {ChartModel,createLayout} from '../../../src/core/model.mjs';
import {buildScene} from '../../../src/core/scene.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-model/interaction-oracle.jsonl');
const sourceFiles=[
 'src/core/contracts.mjs',
 'src/core/data.mjs',
 'src/core/drawing-validation.mjs',
 'src/core/drawings.mjs',
 'src/core/interaction.mjs',
 'src/core/model.mjs',
 'src/core/position-drawing.mjs',
 'src/core/crosshair-snap.mjs',
 'src/core/ohlc-snap.mjs',
 'src/core/scene.mjs',
 'src/core/scene-parts.mjs',
];
const HEADER=Object.freeze({
 kind:'header',schema:'barochart.rust-model.interaction-oracle',version:1,
 node:'v22.20.0',v8:'12.4.254.21-node.33',
 encoding:'f64 big-endian bits; objects as ordered entry arrays; undefined explicitly tagged; scene geometryKey[4] process-local store identity normalized',
 callSequence:['actual ChartModel/BarStore/InteractionController','capture state, model view, and buildScene output after each event'],
 caseCounts:{panCancel:3,hoverWheel:2,pointerMap:19,keyboard:5,drawingHandleAnchors:16,lockedZOrder:7,magnet:9,crosshairSnap:7,drawingTarget:5,errors:5},
});

const buffer=new ArrayBuffer(8),view=new DataView(buffer);
function f64(value){view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,path='root'){
 if(typeof value==='number')return{$f64:f64(value)};
 if(typeof value==='string'||typeof value==='boolean'||value===null)return value;
 if(value===undefined)return{$undefined:true};
 if(value instanceof Float64Array)return{$f64array:Array.from(value,f64)};
 if(Array.isArray(value))return value.map((child,index)=>encode(child,`${path}[${index}]`));
 if(value&&typeof value==='object')return{$object:Object.entries(value).filter(([,child])=>typeof child!=='function').map(([key,child])=>[key,encode(child,`${path}.${key}`)])};
 throw new TypeError(`Unsupported interaction oracle value at ${path}: ${Object.prototype.toString.call(value)}`);
}
function sha256(path){return createHash('sha256').update(readFileSync(join(root,path))).digest('hex');}
function verifyEnvironment(){
 if(process.version!==HEADER.node||process.versions.v8!==HEADER.v8)throw new Error(`interaction oracle requires Node ${HEADER.node} / V8 ${HEADER.v8}; got ${process.version} / ${process.versions.v8}`);
}
function bar(index){const close=40+index;return{time:1_700_000_000_000+index*60_000,open:close,high:close+4,low:close-4,close,volume:(index+1)*10};}
function fresh({modelOptions={},series=[{id:'candles',type:'candles',panel:'price'}],drawings=[],selected=null}={}){
 const model=new ChartModel({store:new BarStore(Array.from({length:40},(_,index)=>bar(index))),visibleBars:20,...modelOptions});
 for(const item of series)model.addSeries(item);
 for(const drawing of drawings)model.drawings.add(drawing);
 if(selected!==null)model.drawings.selected=selected;
 return model;
}
function gestureState(gesture){
 if(!gesture)return null;
 const result={kind:gesture.kind};
 const fields={
  wait:['staleViewport'],
  pan:['startX','view','follow','pixelWidth'],
  pinch:['distance','view','follow','midpoint'],
  create:['transaction','id','panel','axisId','seriesId','type','projection','lastX','lastY','moved'],
  edit:['transaction','id','handle','startX','startY','screenPoints','points','panel','axisId','seriesId','type','projection'],
 }[gesture.kind]??[];
 for(const name of fields){
  if(!Object.hasOwn(gesture,name))continue;
  if(name==='transaction')result[name]=gesture.transaction.map(drawing=>drawing.id);
  else if(name==='projection')result[name]=gesture.projection.map((value,index)=>index===11?'<store-identity>':value);
  else result[name]=gesture[name];
 }
 return result;
}
function controllerState(model,controller){
 const cursor=controller._crosshairPointer;
 return{
  tool:controller.tool,
  text:controller.text,
  drawingTarget:controller.drawingTarget,
  drawingMagnet:controller.drawingMagnet,
  crosshairSnap:controller.crosshairSnap,
  pointers:[...controller.pointers].map(([id,point])=>[id,{x:point.x,y:point.y}]),
  gesture:gestureState(controller.gesture),
  crosshair:model.crosshair?{x:model.crosshair.x,y:model.crosshair.y}:null,
  crosshairPointer:cursor?{x:cursor.x,y:cursor.y}:null,
 };
}
function capture(model,controller,width,height,invalidations){
 const scene=buildScene(model,width,height,{crosshair:true,drawings:true});
 const geometryKey=JSON.parse(scene.layout.geometryKey);
 geometryKey[4]='<store-identity>';
 scene.layout.geometryKey=JSON.stringify(geometryKey);
 return{
  invalidations:[...invalidations.splice(0)],
  controller:controllerState(model,controller),
  model:{view:{from:model.view.from,to:model.view.to},follow:model.follow,selected:model.drawings.selected,series:model.series.map(series=>({id:series.id,type:series.type,panel:series.panel})),drawings:model.drawings.items.map(drawing=>({id:drawing.id,type:drawing.type,panel:drawing.panel,points:drawing.points.map(point=>({time:point.time,price:point.price})),locked:!!drawing.locked,visible:drawing.visible!==false,axisId:drawing.axisId??null,seriesId:drawing.seriesId??null}))},
  scene,
 };
}
function makeCase(id,events,{drawings=[],selected=null,modelOptions={},series=[{id:'candles',type:'candles',panel:'price'}]}={}){
 const width=640,height=360,modelOptionsWithDefaults={visibleBars:20,...modelOptions},model=fresh({modelOptions:modelOptionsWithDefaults,series,drawings,selected}),invalidations=[];
 const controller=new InteractionController(model,()=>({width,height}),kind=>invalidations.push(kind??'default'));
 const layout=createLayout(model,width,height),panel=layout.panels[0];
 const x=panel.left+(panel.right-panel.left)*0.55,y=panel.top+(panel.bottom-panel.top)*0.45;
 const expanded=[],snapshots=[];
 for(const eventSource of events){
  const event=typeof eventSource==='function'?eventSource({x,y,model,controller,width,height}):eventSource;
  expanded.push(event);
  let error=null;
  try{
   switch(event.kind){
    case'down':controller.down(event.id,event.x,event.y,event.hitTolerance??8);break;
    case'move':controller.move(event.id,event.x,event.y);break;
    case'up':controller.up(event.id);break;
    case'cancel':controller.cancel();break;
    case'wheel':controller.wheel(event.delta,event.x);break;
    case'key':controller.key(event.key,{ctrl:event.ctrl??false,shift:event.shift??false});break;
    case'setTool':controller.setTool(event.tool,{notify:event.notify??true});break;
    case'setTarget':controller.setDrawingTarget(event.target,{notify:event.notify??true});break;
    case'setMagnet':controller.setDrawingMagnet(event.options,{notify:event.notify??true});break;
    case'setSnap':controller.setCrosshairSnap(event.options,{notify:event.notify??true});break;
    case'releaseCrosshair':controller.releaseCrosshair();break;
    default:throw new Error(`Unknown interaction event ${event.kind}`);
   }
  }catch(caught){error={name:caught.name,message:caught.message};}
  const snapshot={event:{...event,kind:undefined},...capture(model,controller,width,height,invalidations)};
  if(error)snapshot.error=error;
  snapshots.push(snapshot);
 }
 const row={kind:'interaction',id,input:{width,height,bars:Array.from({length:40},(_,index)=>bar(index)),model:modelOptionsWithDefaults,series,drawings,selected,events:expanded},expected:snapshots};
 model.dispose();
 return row;
}
function scenarios(){
 const drawingHandles=[
  {id:'position-long',type:'longposition',panel:'price',points:[{time:bar(25).time,price:65},{time:bar(25).time,price:60},{time:bar(25).time,price:75},{time:bar(30).time,price:65}]},
  {id:'position-short',type:'shortposition',panel:'price',points:[{time:bar(26).time,price:70},{time:bar(26).time,price:75},{time:bar(26).time,price:60},{time:bar(31).time,price:70}]},
  {id:'channel',type:'channel',panel:'price',points:[{time:bar(27).time,price:62},{time:bar(34).time,price:70},{time:bar(30).time,price:66}]},
  {id:'fib-extension',type:'fibextension',panel:'price',points:[{time:bar(28).time,price:64},{time:bar(34).time,price:72},{time:bar(30).time,price:68}]},
  {id:'horizontal',type:'horizontal',panel:'price',points:[{time:bar(29).time,price:67}]},
  {id:'text',type:'text',panel:'price',text:'Note',points:[{time:bar(32).time,price:66}]},
 ];
 const handleEvents=[];
 for(let drawingIndex=0;drawingIndex<drawingHandles.length;drawingIndex++){
  const drawing=drawingHandles[drawingIndex];
  if(drawingIndex>0)handleEvents.push({kind:'key',key:'PageDown'});
  for(let handle=0;handle<drawing.points.length;handle++){
   const pointerId=`handle-${drawingIndex}-${handle}`;
   let anchor={x:0,y:0};
   handleEvents.push(({model,width,height})=>{
    const current=model.drawings.items.find(item=>item.id===drawing.id),layout=createLayout(model,width,height),point=layout.toScreen(current.points[handle],current.panel,current.axisId);
    anchor={x:point.x,y:point.y};return{kind:'down',id:pointerId,x:point.x,y:point.y};
   });
   handleEvents.push(()=>({kind:'move',id:pointerId,x:anchor.x+1,y:anchor.y+1}));
   handleEvents.push({kind:'up',id:pointerId});
  }
 }
 return[
  makeCase('pan-cancel',[
   ({x,y})=>({kind:'down',id:1,x,y}),
   ({x,y})=>({kind:'move',id:1,x:x+24,y:y+2}),
   {kind:'cancel'},
  ]),
  makeCase('hover-wheel',[
   ({x,y})=>({kind:'move',id:'hover',x:x+8,y:y-5}),
   ({x})=>({kind:'wheel',delta:120,x}),
  ]),
  makeCase('pointer-map',[
   ({x,y})=>({kind:'down',id:0,x,y}),
   ({x,y})=>({kind:'down',id:-0,x:x+2,y}),
   ({x,y})=>({kind:'down',id:NaN,x:x+8,y}),
   ({x,y})=>({kind:'down',id:'late',x:x+30,y}),
   ({x,y})=>({kind:'move',id:NaN,x:x+18,y:y+3}),
   {kind:'up',id:0},
   ({x,y})=>({kind:'down',id:'0',x:x+10,y}),
   {kind:'cancel'},
   ({x,y})=>({kind:'down',id:undefined,x,y}),
   ({x,y})=>({kind:'move',id:undefined,x:x+2,y:y+1}),
   {kind:'up',id:undefined},
   ({x,y})=>({kind:'down',id:{opaque:'pointer'},x,y}),
   ({x,y})=>({kind:'move',id:{opaque:'pointer'},x:x+2,y:y+1}),
   {kind:'up',id:{opaque:'pointer'}},
   {kind:'cancel'},
   ({x,y})=>({kind:'down',id:[1,'pointer'],x,y}),
   ({x,y})=>({kind:'move',id:[1,'pointer'],x:x+2,y:y+1}),
   {kind:'up',id:[1,'pointer']},
   {kind:'cancel'},
  ]),
  makeCase('keyboard',[
   {kind:'key',key:'ArrowRight'},
   {kind:'key',key:'PageDown'},
   {kind:'key',key:'Delete'},
   {kind:'key',key:'z',ctrl:true},
   {kind:'key',key:'Escape'},
  ],{
   drawings:[
    {id:'line-a',type:'trendline',panel:'price',points:[{time:bar(25).time,price:65},{time:bar(30).time,price:70}]},
    {id:'line-b',type:'horizontal',panel:'price',points:[{time:bar(28).time,price:68}]},
   ],
   selected:'line-a',
  }),
  makeCase('drawing-handles',handleEvents,{drawings:drawingHandles,selected:drawingHandles[0].id}),
  makeCase('locked-z-order',[
   ({model,width,height})=>{const layout=createLayout(model,width,height),drawing=model.drawings.items.find(item=>item.id==='bottom'),point=layout.toScreen(drawing.points[0],drawing.panel,drawing.axisId);return{kind:'down',id:'edit',x:point.x,y:point.y};},
   ({model,width,height})=>{const layout=createLayout(model,width,height),drawing=model.drawings.items.find(item=>item.id==='bottom'),point=layout.toScreen(drawing.points[0],drawing.panel,drawing.axisId);return{kind:'move',id:'edit',x:point.x+1,y:point.y+1};},
   {kind:'up',id:'edit'},
   {kind:'key',key:'Escape'},
   ({model,width,height})=>{const layout=createLayout(model,width,height),point=layout.toScreen({time:bar(30).time,price:70},'price');return{kind:'down',id:'pan',x:point.x,y:point.y};},
   ({model,width,height})=>{const layout=createLayout(model,width,height),point=layout.toScreen({time:bar(30).time,price:70},'price');return{kind:'move',id:'pan',x:point.x+20,y:point.y};},
   {kind:'up',id:'pan'},
  ],{
   drawings:[
    {id:'bottom',type:'trendline',panel:'price',points:[{time:bar(25).time,price:65},{time:bar(35).time,price:75}]},
    {id:'top',type:'trendline',panel:'price',locked:true,points:[{time:bar(25).time,price:65},{time:bar(35).time,price:75}]},
   ],
   selected:'bottom',
  }),
  makeCase('magnet',[
   {kind:'setMagnet',options:{mode:'weak',radiusPx:8}},
   {kind:'setTool',tool:'trendline'},
   ({model,width,height})=>{const axis=createLayout(model,width,height).axis('price',null);return{kind:'down',id:'weak',x:createLayout(model,width,height).x(30),y:axis.y(bar(30).high)};},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price',null);return{kind:'move',id:'weak',x:layout.x(33),y:axis.y(bar(30).high)-20};},
   {kind:'up',id:'weak'},
   {kind:'setMagnet',options:{mode:'strong',radiusPx:1}},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price',null);return{kind:'down',id:'strong',x:layout.x(31),y:axis.y(bar(31).close)+30};},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price',null);return{kind:'move',id:'strong',x:layout.x(34),y:axis.y(bar(31).close)+10};},
   {kind:'up',id:'strong'},
  ]),
  makeCase('crosshair-snap',[
   {kind:'setSnap',options:{mode:'ohlc',target:{panel:'price',axisId:'secondary',seriesId:'candles-secondary'}}},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price','secondary');return{kind:'move',id:'snap',x:layout.x(30.25),y:axis.y(bar(30).high)};},
   {kind:'setSnap',options:{mode:'close',target:{panel:'price',axisId:'secondary',seriesId:'candles-secondary'}}},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price','secondary');return{kind:'move',id:'snap',x:layout.x(19.6),y:axis.y(bar(20).high)};},
   {kind:'setSnap',options:{mode:'free',target:{panel:'price',axisId:'secondary',seriesId:'candles-secondary'}}},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price','secondary');return{kind:'move',id:'snap',x:layout.x(30.25),y:axis.y(bar(30).high)};},
   {kind:'releaseCrosshair'},
  ],{
   modelOptions:{axes:[{id:'secondary',panel:'price',side:'left'}]},
   series:[{id:'candles',type:'candles',panel:'price'},{id:'candles-secondary',type:'candles',panel:'price',axisId:'secondary'}],
  }),
  makeCase('drawing-target',[
   {kind:'setTarget',target:{seriesId:'candles-secondary'}},
   {kind:'setTool',tool:'trendline'},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price','secondary');return{kind:'down',id:'target',x:layout.x(30),y:axis.y(bar(30).close)};},
   ({model,width,height})=>{const layout=createLayout(model,width,height),axis=layout.axis('price','secondary');return{kind:'move',id:'target',x:layout.x(33),y:axis.y(bar(33).high)};},
   {kind:'up',id:'target'},
  ],{
   modelOptions:{axes:[{id:'secondary',panel:'price',side:'left'}]},
   series:[{id:'candles',type:'candles',panel:'price'},{id:'candles-secondary',type:'candles',panel:'price',axisId:'secondary'}],
  }),
  makeCase('errors',[
   ({x,y})=>({kind:'down',id:1,x,y,hitTolerance:0}),
   {kind:'setTool',tool:'unknown'},
   {kind:'setMagnet',options:{mode:'weak',radiusPx:0}},
   {kind:'setSnap',options:{mode:'close',target:{panel:'missing'}}},
   ({x})=>({kind:'wheel',delta:'not-a-number',x}),
  ]),
 ];
}
export function generateInteractionOracle(){
 verifyEnvironment();
 const header={...HEADER,sourceSHA256:Object.fromEntries(sourceFiles.map(path=>[path,sha256(path)]))};
 const rows=scenarios();
 for(const [name,count]of Object.entries(HEADER.caseCounts)){
  const row=rows.find(row=>row.id===({panCancel:'pan-cancel',hoverWheel:'hover-wheel',pointerMap:'pointer-map',keyboard:'keyboard',drawingHandleAnchors:'drawing-handles',lockedZOrder:'locked-z-order',magnet:'magnet',crosshairSnap:'crosshair-snap',drawingTarget:'drawing-target',errors:'errors'})[name]);
  const actual=name==='drawingHandleAnchors'?row.input.drawings.reduce((sum,drawing)=>sum+drawing.points.length,0):row.expected.length;
  if(actual!==count)throw new Error(`${name} step count ${actual}`);
 }
 return[header,...rows].map(row=>JSON.stringify(encode(row))).join('\n')+'\n';
}
if(import.meta.url===`file://${process.argv[1]}`){
 const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-model/generate-interaction.mjs [--check|--write]');
 const output=generateInteractionOracle();
 if(mode==='--check'){
  if(readFileSync(fixture,'utf8')!==output)throw new Error('interaction-oracle.jsonl is stale');
  console.log('interaction oracle fresh: pan-cancel, hover-wheel, pointer-map, keyboard, drawing handles/z-order, magnet, crosshair snap');
 }else if(mode==='--write'){
  writeFileSync(fixture,output);console.log(`wrote ${fixture}`);
 }else process.stdout.write(output);
}
