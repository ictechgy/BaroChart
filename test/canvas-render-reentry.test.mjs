import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/customization-dom.mjs';

// Modeled DOM and renderer callbacks only, not real browser/GPU pixel coverage.
function chartFixture(t,layerCaching,onPaint=()=>{}){
 const f=fixture(t),paints=[],errors=[];
 const {chart,model}=f.create({layerCaching,rasterCaching:'never',onError:error=>errors.push(error),rendererFactory:()=>({kind:'test',render(scene){paints.push(scene.background);onPaint(scene);},dispose(){}})});
 let renderEvents=0;chart.container.addEventListener('aster:render',()=>renderEvents++);
 const flush=()=>{const pending=[...f.frames];f.frames.clear();for(const [,callback]of pending)callback();};
 return {...f,chart,model,paints,errors,flush,get renderEvents(){return renderEvents;}};
}
function noPublishedState(f){assert.equal(f.chart.lastScene??null,null);assert.equal(f.chart.renderMetrics??null,null);assert.equal(f.chart.sceneCache.base,null);assert.equal(f.chart.timings.length,0);assert.equal(f.renderEvents,0);}
for(const layerCaching of [false,true]){
 for(const disposeModel of [false,true])test(`formatter teardown cannot resurrect render state: cache=${layerCaching}, model=${disposeModel}`,t=>{
  const f=chartFixture(t,layerCaching);let armed=true;
  f.model.setPanel('price',{formatter:value=>{if(armed){armed=false;f.chart.destroy({disposeModel});}return String(value);}});
  assert.equal(f.chart.drawNow(),undefined);assert.equal(f.chart.disposed,true);assert.equal(Boolean(f.model.disposed),disposeModel);assert.deepEqual(f.paints,[]);noPublishedState(f);assert.equal(f.frames.size,0);assert.deepEqual(f.errors,[]);
 });
 test(`formatter nested draw owns latest scene/cache/metrics: cache=${layerCaching}`,t=>{
  const f=chartFixture(t,layerCaching);let armed=true,inner;
  f.model.setPanel('price',{formatter:value=>{if(armed){armed=false;f.chart.api.setTheme({background:'#112233'});f.chart.drawNow();inner={scene:f.chart.lastScene,base:f.chart.sceneCache.base,metrics:f.chart.renderMetrics};}return String(value);}});
  assert.equal(f.chart.drawNow(),undefined);assert.deepEqual(f.paints,['#112233ff']);assert.equal(f.chart.lastScene,inner.scene);assert.equal(f.chart.sceneCache.base,inner.base);assert.equal(f.chart.renderMetrics,inner.metrics);assert.equal(f.chart.timings.length,1);assert.equal(f.renderEvents,1);assert.equal(f.chart.lastError,null);
 });
 test(`formatter fallback abandons obsolete draw before replacement paint: cache=${layerCaching}`,t=>{
  const f=chartFixture(t,layerCaching);let armed=true;
  f.model.setPanel('price',{formatter:value=>{if(armed){armed=false;f.chart.fallback('formatter replacement');}return String(value);}});
  const oldCanvas=f.chart.canvas;assert.equal(f.chart.drawNow(),undefined);assert.notEqual(f.chart.canvas,oldCanvas);assert.equal(f.chart.rendererKind,'canvas');assert.deepEqual(f.paints,[]);noPublishedState(f);assert.equal(f.frames.size,1);assert.deepEqual(f.errors,[]);
 });
 for(const action of ['destroy','nested','fallback'])test(`renderer ${action} cannot publish stale outer state: cache=${layerCaching}`,t=>{
  let f,armed=true,inner;f=chartFixture(t,layerCaching,()=>{if(!armed)return;armed=false;if(action==='destroy')f.chart.destroy();if(action==='fallback')f.chart.fallback('renderer replacement');if(action==='nested'){f.chart.api.setTheme({background:'#112233'});f.chart.drawNow();inner={scene:f.chart.lastScene,base:f.chart.sceneCache.base,metrics:f.chart.renderMetrics};}});
  assert.equal(f.chart.drawNow(),undefined);
  if(action==='nested'){assert.equal(f.chart.lastScene,inner.scene);assert.equal(f.chart.sceneCache.base,inner.base);assert.equal(f.chart.renderMetrics,inner.metrics);assert.equal(f.chart.lastScene.background,'#112233ff');assert.equal(f.chart.timings.length,1);assert.equal(f.renderEvents,1);assert.deepEqual(f.paints,['#0c1320','#112233ff']);}
  else {noPublishedState(f);assert.equal(f.chart.disposed,action==='destroy');assert.deepEqual(f.paints,['#0c1320']);if(action==='fallback')assert.equal(f.frames.size,1);}
  assert.deepEqual(f.errors,[]);
 });
 test(`formatter invalidation preserves next frame rather than certifying old cache: cache=${layerCaching}`,t=>{
  const f=chartFixture(t,layerCaching);let armed=true;
  f.model.setPanel('price',{formatter:value=>{if(armed){armed=false;f.chart.api.setTheme({background:'#112233'});}return String(value);}});
  f.flush();assert.deepEqual(f.paints,[]);noPublishedState(f);assert.equal(f.chart.fullDirty,true);assert.equal(f.frames.size,1);
  f.flush();assert.deepEqual(f.paints,['#112233ff']);assert.equal(f.chart.lastScene.background,'#112233ff');assert.equal(f.chart.fullDirty,false);assert.equal(f.frames.size,0);assert.equal(f.renderEvents,1);assert.deepEqual(f.errors,[]);
 });
 for(const action of ['destroy','nested'])for(const scheduled of [false,true])test(`stale formatter throw stays isolated: cache=${layerCaching}, action=${action}, RAF=${scheduled}`,t=>{
  const f=chartFixture(t,layerCaching),error=Error('obsolete formatting failure');let armed=true,inner;
  f.model.setPanel('price',{formatter:value=>{if(armed){armed=false;if(action==='destroy')f.chart.destroy();else{f.chart.api.setTheme({background:'#112233'});f.chart.drawNow();inner={scene:f.chart.lastScene,base:f.chart.sceneCache.base,metrics:f.chart.renderMetrics};}throw error;}return String(value);}});
  if(scheduled)f.flush();else assert.throws(()=>f.chart.drawNow(),e=>e===error);
  assert.equal(f.chart.lastError,null);assert.deepEqual(f.errors,[]);
  if(action==='destroy')noPublishedState(f);else{assert.equal(f.chart.lastScene,inner.scene);assert.equal(f.chart.sceneCache.base,inner.base);assert.equal(f.chart.renderMetrics,inner.metrics);assert.equal(f.chart.fullDirty,false);assert.equal(f.renderEvents,1);}
 });
 test(`current scheduled render failure still reports and can recover: cache=${layerCaching}`,t=>{
  const f=chartFixture(t,layerCaching),error=Error('current formatter failure');f.model.setPanel('price',{formatter:()=>{throw error;}});f.flush();assert.equal(f.chart.lastError,error);assert.deepEqual(f.errors,[error]);assert.equal(f.chart.fullDirty,true);assert.equal(f.chart.sceneCache.base,null);
  f.chart.api.setPanel('price',{formatter:value=>String(value)});f.flush();assert.equal(f.chart.lastError,null);assert.equal(f.paints.length,1);assert.equal(f.renderEvents,1);
 });
}
