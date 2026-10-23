import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isAbsolute,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateCustomizationCode} from '../examples/web/customization-code.mjs';
import {CanvasChart} from '../src/index.mjs';
import {modeledChartDOM} from './helpers/shared-model-dom.mjs';
import {fixture as customizationDOM} from './helpers/customization-dom.mjs';

const theme={background:'#0c1320',grid:'#1d2a3a',text:'#8093ad',up:'#35d2ab',down:'#fa6c7c',crosshair:'#b9c9de',font:'bold 18px monospace'};
const interaction={pointer:true,wheelZoom:false,keyboardShortcuts:true,hitTolerancePx:12};
const toolbar={label:'Chart tools',tools:['select','trendline','rectangle'],actions:['fit','undo'],orientation:'vertical',density:'compact',labels:{select:'Select'}};
function profile(overrides={}){
 return {theme:{...theme,...overrides.theme},layout:{priceWeight:3.5,volumeWeight:1.25,axisSide:'left',placement:'right',...overrides.layout},ui:{interaction:{...interaction,...overrides.ui?.interaction},toolbar:{...toolbar,...overrides.ui?.toolbar}},extras:{navigator:false,overlays:false,tradeMarkers:false,...overrides.extras}};
}
function bars(){return Array.from({length:8},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:103+i,low:98+i,close:101+i,volume:i+1}));}
const repositoryRoot=fileURLToPath(new URL('..',import.meta.url)),artifactRoot=join(repositoryRoot,'artifacts');
mkdirSync(artifactRoot,{recursive:true});
function generatedFile(t,source,extension='mjs'){
 const directory=mkdtempSync(join(artifactRoot,'customization-code-')),path=join(directory,'generated.'+extension);
 writeFileSync(path,source);t.after(()=>rmSync(directory,{recursive:true,force:true}));return path;
}
function compilerPath(){
 const configured=process.env.TSC_PATH??'node_modules/typescript/lib/tsc.js';
 return isAbsolute(configured)?configured:resolve(repositoryRoot,configured);
}

test('generator rejects unknown language and invalid profiles before producing code',()=>{
 assert.throws(()=>generateCustomizationCode(profile(),{language:'rust'}),/language/i);
 assert.throws(()=>generateCustomizationCode({...profile(),unknown:true}),/exact fields|unknown/i);
 assert.throws(()=>generateCustomizationCode(profile(),{language:'TypeScript'}),/language/i);
});

test('generator escapes hostile labels and emits a data-only public module',()=>{
 const caption="quote ' \" `\\\n</script>\u2028\u2029";
 const source=generateCustomizationCode(profile({ui:{toolbar:{labels:{select:caption}}}}));
 assert.match(source,/from ['"]barochart['"]/);
 assert.match(source,/export function mountCustomizedChart/);
 assert.match(source,/store\.setData/);
 assert.doesNotMatch(source,/<\/script>/i);
 assert.doesNotMatch(source,/(?:^|[^\w])eval\s*\(/);
 assert.doesNotMatch(source,/seededColumns|demo[-_ ]?id|private\//i);
 assert.doesNotMatch(source,new RegExp(caption.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(source,/\\u003C/);
 assert.match(source,/\\u2028/);
 assert.match(source,/\\u2029/);
});

test('generated hostile captions round-trip as text without DOM injection',async t=>{
 const caption='<img src=x onerror="globalThis.__customization_code_injected=1"> \' " `\\\n</script>\u2028\u2029';
 const path=generatedFile(t,generateCustomizationCode(profile({ui:{toolbar:{labels:{select:caption}}}})));
 const generated=await import(pathToFileURL(path).href);
 const env=customizationDOM(t),host=env.node();
 delete globalThis.__customization_code_injected;
 const mounted=generated.mountCustomizedChart(host,bars());
 const find=(node,predicate)=>predicate(node)?node:node.children?.map(child=>find(child,predicate)).find(Boolean);
 const button=find(host,node=>node.getAttribute?.('data-chart-control')==='select');
 assert(button);
 assert.equal(button.textContent,caption);
 assert.equal(button.title,caption);
 assert.equal(button.getAttribute('aria-label'),caption);
 const tags=[];const visit=node=>{for(const child of node.children??[]){tags.push(child.tagName);visit(child);}};visit(host);
 assert.equal(tags.includes('IMG'),false);assert.equal(tags.includes('SCRIPT'),false);
 assert.equal(globalThis.__customization_code_injected,undefined);
 mounted.destroy();delete globalThis.__customization_code_injected;
});

test('generated JavaScript mounts an independent chart and idempotently preserves host content',async t=>{
 const dom=modeledChartDOM();t.after(()=>dom.restore());
 const elementPrototype=Object.getPrototypeOf(dom.root);
 elementPrototype.insertBefore=function(node,before){if(before===null){this.append(node);return;}node.remove();node.parentNode=this;this.children.splice(this.children.indexOf(before),0,node);};
 const source=generateCustomizationCode(profile());
 const path=generatedFile(t,source);
 const generated=await import(pathToFileURL(path).href);
 const host=dom.root,sentinel={remove(){this.removed=true;},parentNode:host};host.append(sentinel);
 const mounted=generated.mountCustomizedChart(host,bars());
 assert.equal(host.children.includes(sentinel),true);
 assert.equal(mounted.model.store.length,8);
 assert.equal(mounted.model.panels.find(panel=>panel.id==='price').weight,3.5);
 assert.equal(mounted.model.panels.find(panel=>panel.id==='volume').weight,1.25);
 assert.equal(mounted.model.panels.find(panel=>panel.id==='price').axisSide,'left');
 assert.equal(mounted.model.panels.find(panel=>panel.id==='volume').axisSide,'right');
 assert.equal(mounted.model.series.some(series=>series.type==='candles'&&series.panel==='price'),true);
 assert.equal(mounted.model.series.some(series=>series.type==='histogram'&&series.source==='volume'&&series.panel==='volume'&&series.color==='#4c8cad'),true);
 mounted.destroy();mounted.destroy();
 assert.equal(mounted.chart.disposed,true);
 assert.equal(mounted.model.disposed,true);
 assert.deepEqual(host.children,[sentinel]);
});

test('generated optional helpers use caller-owned markers and roll back owned DOM on mount failure',async t=>{
 const env=customizationDOM(t);
 const path=generatedFile(t,generateCustomizationCode(profile({layout:{placement:'top'},ui:{toolbar:{orientation:'horizontal'},},extras:{navigator:true,overlays:true,tradeMarkers:true}})));
 const generated=await import(pathToFileURL(path).href);
 const host=env.node(),sentinel=env.node();host.append(sentinel);
 const mounted=generated.mountCustomizedChart(host,bars(),[{id:'caller-marker',tradeID:'caller-trade',time:1700000000000,price:101,panel:'price',side:'buy',label:'Caller marker'}]);
 assert(mounted.navigator);assert(mounted.overlays);assert(mounted.tradeMarkers);assert(Object.values(mounted.overlays.slots).every(slot=>slot.children.length===0));
 mounted.destroy();assert.deepEqual(host.children,[sentinel]);
 const failedHost=env.node(),failedSentinel=env.node();failedHost.append(failedSentinel);
 assert.throws(()=>generated.mountCustomizedChart(failedHost,[{time:0,open:1,high:0,low:1,close:1,volume:1}]),/OHLCV/i);
 assert.deepEqual(failedHost.children,[failedSentinel]);
});

test('generated cleanup reports failures after attempting model and DOM teardown, then remains retryable',async t=>{
 const env=customizationDOM(t),path=generatedFile(t,generateCustomizationCode(profile())),generated=await import(pathToFileURL(path).href),host=env.node();
 const mounted=generated.mountCustomizedChart(host,bars()),ownedRoot=host.children[0],originalDestroy=mounted.chart.destroy,originalRemove=ownedRoot.remove;
 mounted.chart.destroy=()=>{throw new Error('chart cleanup');};ownedRoot.remove=()=>{throw new Error('DOM cleanup');};
 assert.throws(()=>mounted.destroy(),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors[0].message==='chart cleanup'&&error.errors[1].message==='DOM cleanup');
 assert.equal(mounted.model.disposed,true);
 mounted.chart.destroy=originalDestroy;ownedRoot.remove=originalRemove;mounted.destroy();mounted.destroy();
 assert.equal(mounted.chart.disposed,true);
});

test('mount failure keeps its original error when rollback also reports cleanup failure',async t=>{
 const env=customizationDOM(t),path=generatedFile(t,generateCustomizationCode(profile({extras:{tradeMarkers:true}}))),generated=await import(pathToFileURL(path).href),host=env.node(),sentinel=env.node();host.append(sentinel);
 const originalDestroy=CanvasChart.prototype.destroy;CanvasChart.prototype.destroy=function(){throw new Error('rollback chart cleanup');};
 try{
  assert.throws(()=>generated.mountCustomizedChart(host,bars(),[{id:'bad',tradeID:'bad',time:bars()[0].time,price:101,panel:'price',side:'hold'}]),error=>error instanceof AggregateError&&error.cause===error.errors[0]&&/Marker side/.test(error.errors[0].message)&&error.errors[1].message==='rollback chart cleanup');
 }finally{CanvasChart.prototype.destroy=originalDestroy;}
 assert.deepEqual(host.children,[sentinel]);
});

test('generated TypeScript is strict-checkable with the repository compiler when available',t=>{
 const compiler=compilerPath();
 if(!existsSync(compiler)){t.skip('TypeScript 5.9.3 compiler is not installed');return;}
 const path=generatedFile(t,generateCustomizationCode(profile({extras:{navigator:true,overlays:true,tradeMarkers:true}}),{language:'typescript'}),'mts');
 const result=spawnSync(process.execPath,[compiler,'--strict','--noEmit','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ES2022,DOM',path],{cwd:repositoryRoot,encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});

