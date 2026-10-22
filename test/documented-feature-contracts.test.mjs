// Current documentation contracts, not historical platform-result rewrites.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import * as core from '../src/core/index.mjs';
const read = path => readFile(new URL('../'+path,import.meta.url),'utf8');
const words = text => text.replace(/\s+/g,' ');
const requireText = (text,fragments) => {for(const fragment of fragments)assert.ok(words(text).includes(fragment),fragment);};

test('current tool counts match the runtime registry, without altering historical counts',async()=>{
 assert.equal(core.DRAWING_TYPES.length,16);
 for(const path of ['README.md','README.ko.md','docs/DRAWING-DELETE.md']) {
  const text=await read(path);assert.match(text,new RegExp(`\\b${core.DRAWING_TYPES.length}(?: drawing tools|종 그리기 도구| stored drawing types)`),path);
 }
 const parity=await read('docs/API-PARITY.md');requireText(parity,['기존14종 host 검사','새 롱/숏은 Node/VM 검사']);
});

for(const [version,extra] of [[1,{}],[2,{axisId:'B'}],[3,{type:'longposition',points:[{time:0,price:10},{time:0,price:9},{time:0,price:12},{time:1,price:10}]}],[4,{visible:true}]] )
 test(`documented drawing version ${version} is the minimal stored version and roundtrips`,async()=>{
  const store=new core.DrawingStore();store.add({id:'a',type:'horizontal',points:[{time:0,price:10}],...extra});
  const saved=store.save();assert.equal(JSON.parse(saved).version,version);
  const restored=new core.DrawingStore();restored.load(saved);assert.equal(restored.save(),saved);
  for(const path of ['docs/API.md','docs/API-PARITY.md'])assert.ok((await read(path)).includes('v1/v2/v3/v4'),path);
  requireText(await read('docs/INDEPENDENT-AXES.md'),['version 1/2/3/4']);
 });

test('workspace first-slice schema is qualified as historical and links current v3/v4 behavior',async()=>{
 const text=await read('docs/WORKSPACE-DESIGN.md');requireText(text,['historical first-slice','original first slice','outer workspace version remains 1','versions 1/2/3/4','Position drawings require v3','visibility boolean requires v4']);
});

test('financial coordinate example describes default Free and links implemented close/OHLC snap',async()=>{
 const model=new core.ChartModel(),controller=new core.InteractionController(model,()=>({width:640,height:280})),api=new core.ChartAPI(model,{controller});
 try {assert.equal(controller.crosshairSnap.mode,'free');for(const mode of ['close','ohlc']){api.setCrosshairSnap({mode});assert.equal(controller.crosshairSnap.mode,mode);}}
 finally {model.dispose();}
 const financial=await read('docs/FINANCIAL-COORDINATES.md');requireText(financial,['Free','close/OHLC','CROSSHAIR-SNAP.md']);assert.ok(!financial.includes('crosshair snapping은 미구현'));
});

test('locked visibility exception is both documented and admitted without geometry edits',async()=>{
 const model=new core.ChartModel(),api=new core.ChartAPI(model);
 try {api.addDrawing({id:'a',type:'horizontal',points:[{time:0,price:10}],locked:true});api.setDrawingVisibility('a',false);assert.equal(model.drawings.items[0].locked,true);assert.equal(model.drawings.items[0].visible,false);assert.throws(()=>api.editDrawing('a',{points:[{time:0,price:11}]}),/locked/);}
 finally {model.dispose();}
 requireText(await read('docs/API.md'),['visibility-only','DRAWING-VISIBILITY.md']);
});

test('presets/replay/comparison retain their explicit core/web/native scope',async()=>{
 assert.equal(typeof core.DrawingStylePresets,'function');assert.equal(typeof core.BarReplay,'function');assert.equal(Object.hasOwn(core,'normalizeComparisonSeries'),false);
 requireText(await read('docs/DRAWING-STYLE-PRESETS.md'),['no Swift/Java preset-store API','native preset UI','never run scripts']);
 requireText(await read('docs/BAR-REPLAY.md'),['no Swift/Java replay facade','native replay UI','no native SDK execution']);
 requireText(await read('docs/RELATIVE-COMPARISON.md'),['example-local']);
});

test('both README navigation paths expose replay/comparison/presets and shared-model ownership',async()=>{
 for(const path of ['README.md','README.ko.md'])requireText(await read(path),['bar-replay.html','comparison.html','docs/DRAWING-STYLE-PRESETS.md','docs/SHARED-MODEL-REFRESH.md']);
});

test('current validation identity and historical watchdog failure remain distinct',async()=>{
 const current=await read('docs/PUBLIC-VALIDATION.md');requireText(current,['381fb00fc41c49aadfb72f45fb0c0a66f500d62c','4,870/4,870','513 ESM','2,551/2,552','watchdog','Actual-browser checks for these changes remain unrun']);
 for(const path of ['README.md','README.ko.md']) {const text=await read(path);requireText(text,['381fb00fc41c49aadfb72f45fb0c0a66f500d62c','4,870/4,870','2,551','2,552','131/131']);}
});

test('current integration documentation has no broken local Markdown links',async()=>{
 const paths=['README.md','README.ko.md','docs/API.md','docs/API-PARITY.md','docs/DRAWING-DELETE.md','docs/INDEPENDENT-AXES.md','docs/WORKSPACE-DESIGN.md','docs/FINANCIAL-COORDINATES.md','docs/PUBLIC-VALIDATION.md','docs/SHARED-MODEL-REFRESH.md'];
 for(const path of paths)for(const match of (await read(path)).matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
  const href=match[1].split('#')[0];if(!href||/^[a-z]+:/i.test(href))continue;
  await assert.doesNotReject(access(new URL(href,new URL('../'+path,import.meta.url))),`${path}: ${href}`);
 }
});

test('visible main/analysis demo version badges agree with the package version',async()=>{
 const {version}=JSON.parse(await read('package.json'));
 for(const path of ['examples/web/index.html','examples/web/analysis.html']) {
  const badges=[...(await read(path)).matchAll(/<span\b[^>]*class="badge"[^>]*>([^<]*)<\/span>/g)];
  assert.equal(badges.length,1,path);assert.equal(badges[0][1].match(/\d+\.\d+\.\d+/)?.[0],version,path);
 }
});
