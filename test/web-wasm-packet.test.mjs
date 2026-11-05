import assert from 'node:assert/strict';
import test from 'node:test';
import {packNativeCommands} from '../src/renderers/native-command-packet.mjs';
import {decodeRustPacket} from '../src/web/wasm/packet.mjs';

const options={mode:'scene',width:640,height:360,background:'#fff',stats:{storedBars:10000,commandCount:6}};
const commands=[
 {op:'lines',coords:[-0,2,3,4],color:'#111',width:2,clip:[0,0,640,360],dash:[2,4]},
 {op:'rects',coords:[1,2,3,4],color:'#222'},
 {op:'path',points:[1,2,3,4],color:'#333',fill:'#444',baseline:42,width:1.5},
 {op:'box',x:1,y:2,w:30,h:40,color:'#555',fill:'#666',width:0},
 {op:'ellipse',x:3,y:4,w:5,h:6,color:'#777'},
 {op:'text',x:12,y:24,text:'가격 \ud800',font:'14px serif',color:'#888'},
];
const packed=()=>packNativeCommands([{commands}],options);

test('Rust packet decoder round-trips every renderer operation without changing float bits or strings',()=>{
 const packet=packed(),decoded=decodeRustPacket(packet);
 assert.equal(decoded.mode,'scene');assert.equal(decoded.layers.length,1);
 assert.equal(decoded.layers[0].commands.length,6);
 const again=packNativeCommands(decoded.layers,options);
 assert.equal(again.metadata,packet.metadata);
 assert.deepEqual(new Uint8Array(again.numbers.buffer),new Uint8Array(packet.numbers.buffer));
 assert.ok(Object.is(decoded.layers[0].commands[0].coords[0],-0));
});

test('frame packet decoder preserves absent cached layers and requires a present hover layer',()=>{
 const packet=packNativeCommands([null,null,{commands:[]}],{...options,mode:'frame'});
 const decoded=decodeRustPacket(packet);
 assert.deepEqual(decoded.layers,[null,null,{width:640,height:360,background:'#fff',stats:options.stats,commands:[]}]);
 const bad=JSON.parse(packet.metadata);bad.layers[2]=null;
 assert.throws(()=>decodeRustPacket({metadata:bad,numbers:packet.numbers}),/layer/i);
});

test('malformed packet headers, indices, arities and trailing values fail before renderer submission',()=>{
 for(const [index,value] of [[0,99],[1,2],[2,999],[3,-1],[4,2],[9,3],[10,-2],[14,3]]){
  const packet=packed(),numbers=packet.numbers.slice();numbers[index]=value;
  assert.throws(()=>decodeRustPacket({metadata:packet.metadata,numbers}),/packet/i,`header ${index}`);
 }
 const packet=packed();
 assert.throws(()=>decodeRustPacket({metadata:packet.metadata,numbers:new Float64Array([...packet.numbers,1])}),/packet/i);
 const bad=JSON.parse(packet.metadata);bad.version=99;
 assert.throws(()=>decodeRustPacket({metadata:bad,numbers:packet.numbers}),/packet/i);
});
