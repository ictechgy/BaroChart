import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/customization-dom.mjs';
import {GPUChart} from '../src/renderers/webgl.mjs';

// Invoke actual GPUChart fallback methods with a deterministic failed renderer.
// This tests lifecycle control flow, not real WebGL, context loss or pixels.
for(const raster of [false,true])for(const action of ['destroy','nested','plain','throw'])test(`GPU fallback retires old rendering work: raster=${raster}, callback=${action}`,t=>{
 const f=fixture(t),paints=[],errors=[],callbackError=Error('host fallback callback failed');let chart,inner,fallbacks=0;
 f.Element.prototype.getContext=function(){return new Proxy({},{get:(_object,key)=>(...args)=>{if(key==='fillRect'||key==='drawImage')paints.push(key);}});};
 ({chart}=f.create({layerCaching:raster,rasterCaching:raster?'always':'never',onError:error=>errors.push(error),onFallback:()=>{
  fallbacks++;if(action==='throw')throw callbackError;
  if(action==='destroy')chart.destroy();
  if(action==='nested'){chart.api.setTheme({background:'#112233'});chart.drawNow();inner={scene:chart.lastScene,base:chart.sceneCache.base,metrics:chart.renderMetrics,layers:chart.layerSurfaces,paints:paints.length};}
 },rendererFactory:()=>({kind:'webgl2',layerSamples:0,color:()=>[0,0,0,1],render(){throw Error('simulated GPU render failure');},renderLayers(){throw Error('simulated GPU render failure');},dispose(){}})}));
 // Constructor dependency is replaced only to avoid pretending Node has a GPU.
 Object.setPrototypeOf(chart,GPUChart.prototype);
 let events=0;chart.container.addEventListener('aster:render',()=>events++);
 assert.equal(chart.drawNow(),undefined);assert.equal(fallbacks,1);assert.deepEqual(errors,action==='throw'?[callbackError]:[]);
 if(action==='nested'){
  assert.equal(chart.lastScene,inner.scene);assert.equal(chart.sceneCache.base,inner.base);assert.equal(chart.renderMetrics,inner.metrics);assert.equal(chart.layerSurfaces,inner.layers);assert.equal(paints.length,inner.paints);assert.equal(chart.lastScene.background,'#112233ff');assert.equal(chart.timings.length,1);assert.equal(events,1);
 }else{
  assert.equal(paints.length,0);assert.equal(chart.lastScene??null,null);assert.equal(chart.sceneCache.base,null);assert.equal(chart.layerSurfaces,null);assert.equal(chart.renderMetrics,null);assert.equal(chart.timings.length,0);assert.equal(events,0);
  if(action==='destroy'){assert.equal(chart.disposed,true);assert.equal(f.frames.size,0);}
  else{assert.equal(chart.disposed,false);assert.equal(chart.rendererKind,'canvas');assert.equal(f.frames.size,1);const pending=[...f.frames];f.frames.clear();for(const[,fn]of pending)fn();assert.ok(chart.lastScene);assert.ok(paints.length>0);assert.equal(events,1);assert.equal(chart.lastError,null);}
 }
});
