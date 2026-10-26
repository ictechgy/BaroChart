import test from 'node:test';
import assert from 'node:assert/strict';
import {GPUChart,WebGLRenderer} from '../src/renderers/webgl.mjs';
import {fixture} from './helpers/customization-dom.mjs';
const FRAME_INSTANCE_LIMIT=200000;

function renderer(overrides={}){
 const gl=new Proxy({isContextLost:()=>false,getExtension:()=>null},{get:(object,key)=>object[key]??(()=>{})});
 return Object.assign(Object.create(WebGLRenderer.prototype),{gl,canvas:{width:800,height:500,addEventListener(){},removeEventListener(){}},packed:new Float32Array(4096*16),capacityBytes:0,atlasDpr:1,atlasDirty:false,glyphs:new Map(),colors:new Map(),...overrides});
}

test('WebGL rejects a legal expansion-heavy scene at a fixed retained packed allocation',()=>{
 const r=renderer(),command={op:'ellipse',x:0,y:0,w:4096,h:4096,width:1,color:'#ffffffff',fill:'#ffffffff'},scene={width:800,height:500,background:'#000000ff',commands:Array(391).fill(command)};
 assert.throws(()=>r.render(scene),error=>error instanceof RangeError&&error.name==='WebGLCapacityError'&&/instance limit/.test(error.message));
 assert.equal(r.count,FRAME_INSTANCE_LIMIT);assert.equal(r.packed.byteLength,16777216);
});

test('a typed WebGL capacity failure takes the owned GPU fallback and releases its packed buffer',t=>{
 const source=renderer();source.count=FRAME_INSTANCE_LIMIT;let capacityError;try{source.quad(0,0,1,0,0,1,1,1,[1,1,1,1]);}catch(error){capacityError=error;}
 assert(capacityError);const f=fixture(t),owned={kind:'webgl2',packed:new Float32Array(64),render(){throw capacityError;},dispose(){this.packed=null;this.disposed=true;}},{chart}=f.create({rendererFactory:()=>owned});Object.setPrototypeOf(chart,GPUChart.prototype);
 chart.renderScene({width:800,height:500,background:'#000000ff',commands:[]},1);
 assert.equal(chart.rendererKind,'canvas');assert.equal(chart.renderer,null);assert.equal(owned.disposed,true);assert.equal(owned.packed,null);assert.match(chart.fallbackReason,/instance limit/);
});

test('canonical rgba hex bypasses CSS parsing while fallback CSS colors use a bounded LRU',()=>{
 let parses=0,fill='#000000';const colorContext={clearRect(){},fillRect(){},get fillStyle(){return fill;},set fillStyle(value){if(value!=='invalid-color')fill=value;},getImageData(){parses++;return{data:new Uint8ClampedArray(fill==='#ffffff'?[255,255,255,255]:[17,34,51,68])};}},r=renderer({colorContext});
 const rgba=r.color('#01020304');assert.deepEqual(rgba,[1/255,2/255,3/255,4/255]);assert.equal(r.color('#01020304'),rgba);assert.equal(parses,0);assert.equal(r.colors.size,1);
 for(let i=0;i<257;i++)r.color(`hsl(${i}deg 100% 50%)`);
 assert.equal(r.colors.size,256);const before=parses;r.color('hsl(0deg 100% 50%)');assert.equal(parses,before+1);assert.equal(r.colors.size,256);const recent=r.color('hsl(256deg 100% 50%)');assert.equal(parses,before+1);assert.equal(r.color('hsl(256deg 100% 50%)'),recent);
 assert.deepEqual(r.color('invalid-color'),[1,1,1,1]);
});
