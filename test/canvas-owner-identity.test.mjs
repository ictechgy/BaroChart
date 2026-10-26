import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel} from '../src/core/model.mjs';
import {CanvasChart} from '../src/renderers/canvas.mjs';

function environment(t){
 const owned=[];
 const keys=['document','requestAnimationFrame','cancelAnimationFrame'],saved=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
 class Canvas extends EventTarget{constructor(){super();this.style={};this.width=400;this.height=240;}setAttribute(){}remove(){this.connected=false;}getContext(){return {};}}
 const globals={document:{createElement:()=>new Canvas()},requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:globals[key],configurable:true,writable:true});
 t.after(()=>{for(const [chart,model] of owned){chart.destroy();model.dispose();}for(const [key,value] of saved)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
 const create=()=>{const model=new ChartModel(),chart=new CanvasChart({clientWidth:400,clientHeight:240,append(node){node.connected=true;}},model,{dpr:()=>1,interactive:false,observeResize:false,rendererFactory:()=>({kind:'test',dispose(){},render(){}})});owned.push([chart,model]);return chart;};
 return create;
}
const drawing={id:'fresh',type:'horizontal',points:[{time:0,price:1}]};

test('destroy retires the original controller and preserves a foreign public replacement',t=>{
 const create=environment(t),a=create(),b=create(),original=a.controller;
 b.controller.setTool('horizontal');b.controller.down(2,120,100);
 const transaction=b.model.drawings.transaction;assert(transaction);
 a.controller=b.controller;a.destroy();
 assert.equal(b.model.drawings.transaction,transaction);
 assert.throws(()=>original.setTool('select'),/disposed/i);
 b.controller.up(2);assert.equal(b.model.drawings.transaction,null);
 b.api.addDrawing(drawing);assert.equal(b.model.drawings.items.at(-1).id,'fresh');
});

test('arbitrary controller replacement cannot leave the original transaction locked',t=>{
 const create=environment(t),chart=create(),original=chart.controller;
 original.setTool('horizontal');original.down(1,120,100);assert(chart.model.drawings.transaction);
 chart.controller={};chart.destroy();
 assert.equal(chart.model.drawings.transaction,null);
 assert.equal(original.gesture,null);assert.equal(original.pointers.size,0);
 assert.throws(()=>original.setTool('select'),/disposed/i);
});

test('fallback rejects a foreign controller before cancelling its transaction',t=>{
 const create=environment(t),a=create(),b=create();
 b.controller.setTool('horizontal');b.controller.down(2,120,100);
 const transaction=b.model.drawings.transaction;assert(transaction);
 a.controller=b.controller;
 assert.throws(()=>a.fallback('test'),/owner changed/i);
 assert.equal(b.model.drawings.transaction,transaction);
 b.controller.up(2);assert.equal(b.model.drawings.transaction,null);
});

test('disposeModel applies to the original owned model after public identity replacement',t=>{
 const create=environment(t),a=create(),b=create(),owned=a.model;
 a.model=b.model;a.api=b.api;a.controller=b.controller;a.destroy({disposeModel:true});
 assert.equal(owned.disposed,true);assert.notEqual(b.model.disposed,true);
 b.api.addDrawing(drawing);assert.equal(b.model.drawings.items.at(-1).id,'fresh');
});

test('destroy releases its original canvas and preserves a foreign replacement',t=>{
 const create=environment(t),a=create(),b=create(),owned=a.canvas,foreign=b.canvas;
 a.canvas=foreign;a.destroy();
 assert.equal(owned.connected,false);assert.equal(owned.width,0);assert.equal(owned.height,0);
 assert.equal(foreign.connected,true);assert.equal(foreign.width,400);assert.equal(foreign.height,240);
});

test('fallback rejects a foreign canvas before releasing any owned resources',t=>{
 const create=environment(t),a=create(),b=create(),owned=a.canvas,foreign=b.canvas;
 a.canvas=foreign;assert.throws(()=>a.fallback('test'),/owner changed/i);
 assert.equal(owned.connected,true);assert.equal(foreign.connected,true);
});

test('a size callback cannot restart a controller gesture after chart destruction',t=>{
 const create=environment(t),chart=create(),controller=chart.controller;
 controller.size=()=>{chart.destroy();return {width:400,height:240};};
 assert.throws(()=>controller.down(1,120,100),/disposed/i);
 assert.equal(controller.gesture,null);assert.equal(controller.pointers.size,0);
 assert.equal(chart.model.drawings.transaction,null);
});
