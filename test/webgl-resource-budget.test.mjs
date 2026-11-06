import test from 'node:test';
import assert from 'node:assert/strict';
import {GPUChart,WebGLRenderer} from '../src/renderers/webgl.mjs';
import {fixture} from './helpers/customization-dom.mjs';
const FRAME_INSTANCE_LIMIT=200000;

function renderer(overrides={}){
 const gl=new Proxy({isContextLost:()=>false,getExtension:()=>null},{get:(object,key)=>object[key]??(()=>{})});
 return Object.assign(Object.create(WebGLRenderer.prototype),{gl,canvas:{width:800,height:500,addEventListener(){},removeEventListener(){}},packed:new Float32Array(4096*16),capacityBytes:0,atlasDpr:1,atlasDirty:false,glyphs:new Map(),colors:new Map(),...overrides});
}

function webglFixture(f,{fail=null}={}){
 const created=new Map(),deleted=new Map(),calls=new Map();let serial=0;
 const mark=(name)=>calls.set(name,(calls.get(name)??0)+1),handle=type=>{mark(`create:${type}`);if(fail===type)return null;const value={type,id:++serial};created.set(type,(created.get(type)??0)+1);return value;},remove=type=>value=>{if(!value)return;mark(`delete:${type}`);deleted.set(type,(deleted.get(type)??0)+1);};
 const gl={RENDERBUFFER:1,RGBA8:2,SAMPLES:3,COMPILE_STATUS:4,VERTEX_SHADER:5,FRAGMENT_SHADER:6,LINK_STATUS:7,ARRAY_BUFFER:8,FLOAT:9,TEXTURE_2D:10,LINEAR:11,CLAMP_TO_EDGE:12,
  getInternalformatParameter:()=>[],getParameter:()=>0,isContextLost:()=>false,
  createProgram:()=>handle('program'),createShader:()=>handle('shader'),shaderSource(){},compileShader(){},getShaderParameter:()=>true,getShaderInfoLog:()=>'',deleteShader:remove('shader'),
  attachShader(){},linkProgram(){},getProgramParameter:()=>true,getProgramInfoLog:()=>'',deleteProgram:remove('program'),
  createVertexArray:()=>handle('vertex array'),deleteVertexArray:remove('vertex array'),createBuffer:()=>handle('buffer'),deleteBuffer:remove('buffer'),bindVertexArray(){},bindBuffer(){},enableVertexAttribArray(){},vertexAttribPointer(){},vertexAttribDivisor(){},getUniformLocation:()=>fail==='viewport uniform'?null:{type:'uniform'},
  createTexture:()=>handle('texture'),deleteTexture:remove('texture'),bindTexture(){},texParameteri(){},
  getExtension(name){mark(`extension:${name}`);return name==='WEBGL_lose_context'?{loseContext:()=>mark('loseContext')}:null;}
 };
 const context={clearRect(){}};let canvas2dContexts=0;const create=f.document.createElement;f.document.createElement=tag=>{const node=create(tag);if(tag==='canvas')node.getContext=type=>{if(type!=='2d')return null;canvas2dContexts++;if(fail==='glyph atlas 2D context'&&canvas2dContexts===1||fail==='color 2D context'&&canvas2dContexts===2)return null;return context;};return node;};
 const canvas=create('canvas');canvas.getContext=type=>type==='webgl2'?gl:null;return {canvas,gl,context,created,deleted,calls};
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

test('WebGL context loss is terminal and notifies once without opting into restoration',t=>{
 const f=fixture(t),mock=webglFixture(f),reasons=[];let renderer;renderer=new WebGLRenderer(mock.canvas,reason=>{reasons.push(reason);renderer.dispose();mock.canvas.dispatchEvent(new Event('webglcontextlost'));});
 const loss=new Event('webglcontextlost',{cancelable:true});mock.canvas.dispatchEvent(loss);mock.canvas.dispatchEvent(new Event('webglcontextlost'));
 assert.equal(loss.defaultPrevented,false);assert.deepEqual(reasons,['WebGL2 context lost']);
 assert.throws(()=>renderer.render({width:1,height:1,background:'#000000ff',commands:[]}),/WebGL2 context unavailable/);
 assert.throws(()=>renderer.renderLayers({},1),/WebGL2 context unavailable/);
 renderer.dispose();renderer.dispose();mock.canvas.dispatchEvent(new Event('webglcontextlost'));assert.deepEqual(reasons,['WebGL2 context lost']);
 assert.equal(mock.calls.get('loseContext')??0,0);for(const type of mock.created.keys())assert.equal(mock.deleted.get(type)??0,mock.created.get(type));
});

for(const fail of ['context','program','shader','vertex array','buffer','viewport uniform','texture','glyph atlas 2D context','color 2D context'])test(`WebGL constructor rolls back a missing ${fail}`,t=>{
 const f=fixture(t),mock=webglFixture(f,{fail}),reasons=[];if(fail==='context')mock.canvas.getContext=()=>null;
 assert.throws(()=>new WebGLRenderer(mock.canvas,reason=>reasons.push(reason)),/WebGL2/);assert.deepEqual(reasons,[]);assert.equal(mock.calls.get('loseContext')??0,0);
 for(const type of mock.created.keys())assert.equal(mock.deleted.get(type)??0,mock.created.get(type),`${type} cleanup`);
});
