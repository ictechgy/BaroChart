import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BarStore,ChartModel,createChart,buildScene} from '../src/index.mjs';
import {fixture,event} from './helpers/customization-dom.mjs';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('English and Korean first-chart code is the runnable module, with explicit container height',async()=>{
  const module=(await read('examples/web/quickstart.mjs')).trim();
  for(const file of ['README.md','README.ko.md']){
    const text=await read(file),code=[...text.matchAll(/```js\n([\s\S]*?)\n```/g)][0][1];
    assert.equal(code,module,file);
    assert(text.includes('examples/web/quickstart.html'));
  }
  const html=await read('examples/web/quickstart.html');
  assert.match(html,/name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html,/#chart\s*\{ height: 420px;/);
  assert.match(html,/<script type="module" src="\.\/quickstart.mjs"><\/script>/);
});

test('documented first chart executes, replaces its last bar and preserves/disposes ownership correctly',async t=>{
  // Modeled DOM/lifecycle only, not browser rendering or actual BFCache execution.
  const f=fixture(t),host=f.node();f.document.getElementById=id=>id==='chart'?host:null;
  const source=await read('examples/web/quickstart.mjs');
  const body=source.replace(/^import[^\n]+\n/,'');
  const {model,store,chart}=new Function('BarStore','ChartModel','createChart',body+'\nreturn {model,store,chart};')(BarStore,ChartModel,createChart);
  f.models.push(model);f.charts.push(chart);
  assert.equal(store.length,4);assert.equal(store.at(3).close,106);assert.equal(store.at(3).volume,900);
  assert.equal(model.series.length,2);assert.equal(model.view.to-model.view.from,10);
  const scene=buildScene(model,800,420);assert.equal(scene.stats.storedBars,4);assert(scene.commands.length>0);
  event(f.window,'pagehide',{persisted:true});assert.equal(chart.disposed,false);
  event(f.window,'pageshow',{persisted:true});assert.equal(chart.disposed,false);
  event(f.window,'pagehide',{persisted:false});assert.equal(chart.disposed,true);assert.equal(model.disposed,true);
  event(f.window,'pageshow',{persisted:true});assert.equal(chart.disposed,true);
});
