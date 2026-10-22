// Actual adapter source with modeled hooks/DOM, not React runtime or StrictMode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture} from './helpers/customization-dom.mjs';
import * as hooks from './helpers/react-hook-model.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
let source=await fs.readFile(path.join(repo,'src/react/index.mjs'),'utf8');
source=source.replace(/from '([^']+)'/g,(_all,id)=>`from '${id==='react'?pathToFileURL(path.join(repo,'test/helpers/react-hook-model.mjs')):pathToFileURL(path.resolve(repo,'src/react',id))}'`);
const {AsterChart}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function setup(t,owned){
 const f=fixture(t),host=f.node();hooks.reset(host);t.after(()=>hooks.dispose());const ref={current:null},errors=[],models=[],disposed=[];let cleanups=0,ready=0;
 const createModel=()=>{const m=f.makeModel();models.push(m);return m;};const borrowed=owned?null:createModel();
 const options={dpr:()=>1,observeResize:false,layerCaching:false,rendererFactory:()=>({kind:'test',render(){},dispose(){}})};
 const base={...(owned?{createModel}:{model:borrowed}),options,onError:e=>errors.push(e),onDispose:context=>disposed.push(context),onReady:()=>{ready++;return()=>{cleanups++;};}};
 const render=(interaction,rest={})=>{hooks.begin();AsterChart({...base,options:{...options,interaction},...rest},ref);hooks.commit();};
 return {f,host,ref,errors,models,borrowed,disposed,render,get ready(){return ready;},get cleanups(){return cleanups;}};
}
for(const owned of [false,true]){
 test(`changed invalid interaction retries once and valid correction mounts: owned=${owned}`,t=>{
  const f=setup(t,owned);f.render({pointer:'invalid'});assert.equal(f.ref.current.chart,null);assert.equal(f.errors.length,1);const firstCount=f.models.length;
  f.render({pointer:'invalid'});f.render({pointer:'invalid'});assert.equal(f.errors.length,1);assert.equal(f.models.length,firstCount);
  f.render({wheelZoom:'invalid'});assert.equal(f.errors.length,2);assert.equal(f.ref.current.chart,null);
  f.render({pointer:false});const chart=f.ref.current.chart;assert.ok(chart);assert.equal(chart.interactionOptions.pointer,false);assert.equal(f.ready,1);
  f.render({pointer:true});assert.equal(f.ref.current.chart,chart);assert.equal(f.ready,1);assert.equal(chart.interactionOptions.pointer,true);
  hooks.dispose();assert.equal(f.ref.current.chart,null);assert.equal(chart.disposed,true);assert.equal(f.cleanups,1);assert.equal(f.disposed.length,1);assert.equal(f.host.children.length,0);assert.equal(f.f.frames.size,0);
  if(owned)for(const model of f.models){assert.equal(model.disposed,true);assert.equal(model.store.listeners.size,0);}else{assert.equal(Boolean(f.borrowed.disposed),false);assert.equal(f.borrowed.store.listeners.size,2);}
 });
 test(`in-place corrected descriptor retries without executing rejected accessor: owned=${owned}`,t=>{
  const f=setup(t,owned);let reads=0;const interaction={};Object.defineProperty(interaction,'pointer',{configurable:true,enumerable:true,get(){reads++;return false;}});
  f.render(interaction);f.render(interaction);assert.equal(reads,0);assert.equal(f.errors.length,1);assert.equal(f.ref.current.chart,null);
  Object.defineProperty(interaction,'pointer',{value:false,configurable:true,enumerable:true});f.render(interaction);assert.ok(f.ref.current.chart);assert.equal(f.ref.current.chart.interactionOptions.pointer,false);assert.equal(reads,0);assert.equal(f.errors.length,1);
 });
 test(`reset cleans successful retry and new lifecycle remains owned: owned=${owned}`,t=>{
  const f=setup(t,owned);f.render({pointer:'invalid'});f.render({pointer:false});const first=f.ref.current.chart,firstModel=f.ref.current.model;
  f.render({pointer:false},{resetKey:1});const second=f.ref.current.chart;assert.ok(second);assert.notEqual(first,second);assert.equal(first.disposed,true);assert.equal(f.cleanups,1);assert.equal(f.disposed.length,1);assert.equal(f.ready,2);
  assert.equal(Boolean(firstModel.disposed),owned);hooks.dispose();assert.equal(second.disposed,true);assert.equal(f.cleanups,2);assert.equal(f.disposed.length,2);assert.equal(f.f.frames.size,0);
 });
 test(`removing invalid interaction recovers default policy: owned=${owned}`,t=>{const f=setup(t,owned);f.render({pointer:'invalid'});f.render(undefined);assert.ok(f.ref.current.chart);assert.equal(f.ref.current.chart.interactionOptions.pointer,true);assert.equal(f.errors.length,1);});
}
