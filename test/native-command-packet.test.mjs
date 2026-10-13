import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {packNativeCommands} from '../src/renderers/native-command-packet.mjs';
import {BarStore,ChartModel,buildScene} from '../src/core/index.mjs';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const options={mode:'scene',width:1200,height:700,background:'#000000',stats:{storedBars:100000}};
function records(packet){
 const metadata=JSON.parse(packet.metadata),result=[];let cursor=0;
 for(const layer of metadata.layers){if(layer===null){result.push(null);continue;}const rows=[];
  for(let i=0;i<layer.commands;i++){
   const header=Array.from(packet.numbers.subarray(cursor,cursor+15));
   const dash=Array.from(packet.numbers.subarray(cursor+15,cursor+15+header[9]));
   const geometry=Array.from(packet.numbers.subarray(cursor+15+header[9],cursor+header[1]));
   rows.push({header,dash,geometry});cursor+=header[1];
  }result.push(rows);
 }assert.equal(cursor,packet.numbers.length);return {metadata,layers:result};
}

test('native display packet preserves exact F64 geometry and the 15-value style header',()=>{
 const exact=1e12+2**-13,command={op:'lines',color:'#aabbccdd',width:2,clip:[-0,2,3,4],dash:[4,2],coords:[-0,exact,3,4,5,6,7,8]};
 const before=structuredClone(command),packet=packNativeCommands([{commands:[command]}],options),decoded=records(packet);
 assert.ok(packet.numbers instanceof Float64Array);assert.deepEqual(decoded.layers[0][0].header,[1,25,0,2,1,-0,2,3,4,2,-1,0,-1,-1,8]);
 assert.deepEqual(decoded.layers[0][0].dash,[4,2]);assert.deepEqual(decoded.layers[0][0].geometry,command.coords);
 assert.ok(Object.is(packet.numbers[17],-0));assert.equal(packet.numbers[18],exact);assert.deepEqual(command,before);
 assert.deepEqual(decoded.metadata,{schema:'aster.native.commands',version:1,...options,strings:['#aabbccdd'],layers:[{commands:1}]});
});

test('every native Canvas operation preserves ordered geometry, area fill and text strings',()=>{
 const text='한국어 😀\u0000\n"\\\ud800',commands=[
  {op:'rects',color:'#fff',coords:[1,2,3,4]},
  {op:'path',color:'#fff',points:[1,2,3,4],fill:'#12345678',baseline:-0,width:0},
  {op:'box',color:'#fff',x:1,y:2,w:3,h:4,fill:'#12345678'},
  {op:'ellipse',color:'#fff',x:5,y:6,w:7,h:8},
  {op:'text',color:'#fff',x:9,y:10,text,font:'italic 14px sans-serif'}
 ];
 const {metadata,layers}=records(packNativeCommands([{commands}],options));
 assert.deepEqual(layers[0].map(r=>r.header[0]),[2,3,4,5,6]);
 assert.deepEqual(layers[0].map(r=>r.geometry),[[1,2,3,4],[1,2,3,4],[1,2,3,4],[5,6,7,8],[9,10]]);
 assert.equal(metadata.strings[layers[0][1].header[10]],'#12345678');assert.ok(Object.is(layers[0][1].header[11],-0));
 assert.equal(metadata.strings[layers[0][4].header[12]],text);assert.equal(metadata.strings[layers[0][4].header[13]],'italic 14px sans-serif');
 assert.equal(layers[0][3].header[10],-1);assert.equal(layers[0][1].header[3],0);
});

test('frame packets distinguish omitted layers from explicit empty layers',()=>{
 const packet=packNativeCommands([null,{commands:[]},{commands:[{op:'text',color:'#fff',text:'x',x:1,y:2}]}],{...options,mode:'frame'});
 const decoded=records(packet);assert.deepEqual(decoded.metadata.layers,[null,{commands:0},{commands:1}]);
 assert.equal(decoded.layers[0],null);assert.deepEqual(decoded.layers[1],[]);assert.equal(decoded.layers[2].length,1);
 assert.equal(decoded.metadata.strings[decoded.layers[2][0].header[13]],'12px monospace');
});

test('malformed display commands reject before producing a packet',()=>{
 const valid={op:'lines',color:'#fff',coords:[1,2,3,4]};
 for(const patch of [{op:'future-op'},{coords:[1,2,3]},{coords:[1,2,Infinity,4]},{clip:[1,2,3]},
  {clip:[1,2,3,NaN]},{width:Infinity},{dash:[0,2]},{dash:[1]},{color:42}]){
  assert.throws(()=>packNativeCommands([{commands:[{...valid,...patch}]}],options));
 }
 assert.throws(()=>packNativeCommands([{commands:[{op:'path',color:'#fff',points:[1,2],fill:'#fff'}]}],options));
 assert.throws(()=>packNativeCommands([null],options));
 assert.throws(()=>packNativeCommands([{commands:[]}],{...options,mode:'frame'}));
 assert.throws(()=>packNativeCommands([{commands:[]}],{...options,width:NaN}));
});

test('private packet limits reject explicitly and retain the original source command arrays',()=>{
 const command={op:'text',color:'#fff',x:1,y:2,text:'😀'.repeat(270000)};
 assert.throws(()=>packNativeCommands([{commands:[command]}],options),/metadata/i);
 assert.equal(command.text.length,540000);
 const commands=new Array(65537).fill({op:'lines',color:'#fff',coords:[]});
 assert.throws(()=>packNativeCommands([{commands}],options),/command/i);assert.equal(commands.length,65537);
 const points=new Float64Array(8388608);
 assert.throws(()=>packNativeCommands([{commands:[{op:'path',color:'#fff',points}]}],options),/number|numeric/i);
 assert.equal(points.length,8388608);
});

test('actual renderer-neutral scenes preserve order and numeric coordinate values',()=>{
 const model=new ChartModel({store:new BarStore([{time:1,open:10,high:12,low:8,close:11,volume:20},{time:2,open:11,high:13,low:9,close:12,volume:30}])});
 try{
  model.addSeries({id:'candles',type:'candles',panel:'price'});model.addSeries({id:'close',type:'area',panel:'price',source:'close',color:'#fff'});
  const scene=buildScene(model,1200,700),decoded=records(packNativeCommands([scene],{...options,stats:scene.stats}));
  assert.equal(decoded.layers[0].length,scene.commands.length);
  for(let i=0;i<scene.commands.length;i++){
   const c=scene.commands[i],r=decoded.layers[0][i],expected=c.coords??c.points??(c.op==='text'?[c.x,c.y]:[c.x,c.y,c.w,c.h]);
   assert.deepEqual(r.geometry,expected);assert.equal(decoded.metadata.strings[r.header[2]],c.color);
  }
 }finally{model.dispose();}
});

test('native packet bridge keeps public scene JSON and cached layer semantics intact',async()=>{
 const context=vm.createContext({console});vm.runInContext(await buildNativeBundle(),context);
 const result=vm.runInContext(`(()=>{
  nativeInit(64);const before=nativeSceneJSON(1200,700),packet=nativeScenePacket('scene',null,1200,700,false),after=nativeSceneJSON(1200,700);
  const first=nativeScenePacket('frame','packet-test',1200,700,true),second=nativeScenePacket('frame','packet-test',1200,700,false);
  nativeReleaseFrameCache('packet-test');nativeModel.dispose();
  return {before,after,metadata:JSON.parse(packet.metadata),numberCount:packet.numbers.length,first:JSON.parse(first.metadata),second:JSON.parse(second.metadata)};
 })()`,context);
 assert.equal(result.before,result.after);assert.equal(result.metadata.mode,'scene');assert.ok(result.numberCount>0);
 assert.notEqual(result.first.layers[0],null);assert.equal(result.second.layers[0],null);assert.equal(result.second.layers[1],null);
 assert.equal(result.second.layers.length,3);assert.equal(result.metadata.stats.storedBars,64);
});
