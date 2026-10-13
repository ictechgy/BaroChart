import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {CORE_MODULES as files} from '../scripts/native-core-bundle.mjs';
function bridge(){
 const source=files.map(file=>readFileSync(new URL(`../src/core/${file}.mjs`,import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export \{.*\} from .*;\n/gm,'').replace(/export (?=class|function|const)/g,'')).join('\n');
 const context=vm.createContext({console});vm.runInContext(`(function(){${source}\n${readFileSync(new URL('../examples/native/bridge.mjs',import.meta.url),'utf8')}\n})();`,context);return context;
}
test('native comparison remove and restore preserve an unrelated drawing target',()=>{
 const c=bridge();try{vm.runInContext("nativeComparisonDemo(); nativeAPI.addAxis({id:'C',panel:'price',range:[0,100]});nativeAPI.addSeries({id:'C-line',panel:'price',type:'line',axisId:'C',values:new Float64Array(24).fill(50)});nativeAPI.setDrawingTarget({panel:'price',seriesId:'C-line'});nativeComparisonAction('series');",c);
  assert.equal(c.nativeInput.drawingTarget.seriesId,'C-line');vm.runInContext("nativeComparisonAction('series')",c);assert.equal(c.nativeInput.drawingTarget.seriesId,'C-line');
 }finally{c.nativeModel?.dispose();}
});
test('native View text bridge preserves byte-exact UIKit/Android readings and one snapshot',()=>{
 const c=bridge();try{
  for(const state of ['nativeInit(0)','nativeInit(64);nativePointer("move",0,150,150)','nativeAnalysisDemo();nativeResize(320,568)']){
   vm.runInContext(state,c);const original=c.nativeAccessibility,summary=original(true);let calls=0;c.nativeAccessibility=(...args)=>{calls++;return original(...args);};
   assert.equal(c.nativeAccessibilityText(true,'android'),summary.readout);assert.equal(calls,1);
   assert.equal(c.nativeAccessibilityText(true,'uikit'),[summary.bars+' bars',summary.panels.map(p=>p.title).join('; '),summary.readout,summary.selection,'tool '+summary.tool].filter(s=>s.length>0).join('; '));assert.equal(calls,2);c.nativeAccessibility=original;
  }
  assert.throws(()=>c.nativeAccessibilityText(true,'unknown'));
 }finally{c.nativeModel?.dispose();}
});
test('native analysis sample uses session bands/module and atomically restores into a fresh container',()=>{
 const c=bridge();try{const result=c.nativeAnalysisDemo();assert.equal(result.schema,'aster.analysis-demo');assert.equal(c.nativeModel.store.length,1200);assert.equal(c.nativeModel.indicators.get('analysis-vwap').outputs.volume.length,1200);assert.equal(c.nativeModel.series.length,5);const old=c.nativeModel;assert.throws(()=>c.nativeAnalysisReload('{bad}'));assert.equal(c.nativeModel,old);const restored=c.nativeAnalysisReload(result.setup);assert.equal(restored.indicators,2);assert.equal(restored.series,4);assert.equal(old.disposed,true);assert.equal(c.nativeAPI.saveStudies(),result.setup);assert.equal(c.nativeStudyVerification().passed,12);}finally{c.nativeModel?.dispose();}
});
test('study restore preserves default six-digit and explicit eight-digit public colors exactly',()=>{
 const c=bridge();try{vm.runInContext(`nativeInit(32,{series:[]});nativeAPI.addIndicator('study','ema',{period:2});nativeAPI.addSeries({id:'default',type:'line',panel:'price',indicator:'study'});nativeAPI.addSeries({id:'explicit',type:'line',panel:'price',indicator:'study',color:'#abcdef44'});`,c);const text=c.nativeAPI.saveStudies();c.nativeAnalysisReload(text);assert.equal(c.nativeAPI.saveStudies(),text);}finally{c.nativeModel?.dispose();}
});
test('removing the active comparison series clears its target without reselecting on restore',()=>{
 const c=bridge();try{vm.runInContext("nativeComparisonDemo();nativeComparisonAction('series')",c);assert.equal(c.nativeInput.drawingTarget,null);vm.runInContext("nativeComparisonAction('series')",c);assert.equal(c.nativeInput.drawingTarget,null);}finally{c.nativeModel?.dispose();}
});
test('native accessibility retains full shortened labels and tiny helpers avoid inspection snapshots',()=>{
 const c=bridge();try{vm.runInContext("nativeInit(64,{theme:{font:'24px monospace'},panels:[{id:'price',label:'Full primary title'}],series:[{id:'price',type:'candles',panel:'price',label:'Complete candle title'}]});nativeResize(320,240);nativeFit();nativePointer('move',0,120,100);",c);
  const a=c.nativeAccessibility();assert.equal(c.nativeThemeFont(),'24px monospace');assert.equal(c.nativeGestureKind(),null);assert.equal(a.panels[0].title,'Full primary title');assert.ok(a.readout.includes('Complete candle title'));assert.ok(a.crosshair);assert.ok(a.readout.includes(new Date(a.crosshair.time).toISOString()));assert.ok(a.readout.includes(a.crosshair.axes[0].formatted));
 }finally{c.nativeModel?.dispose();}
});
test('native pointer accepts the optional touch radius and cancels rejected native packets',()=>{
 const c=bridge();try{vm.runInContext("nativeInit(64,{});nativeResize(800,500);nativePointer('down',1,200,200,24)",c);assert.equal(c.nativeGestureKind(),'pan');assert.throws(()=>c.nativePointer('down',2,300,200,100),/tolerance/);assert.equal(c.nativeGestureKind(),null);assert.equal(c.nativeInput.pointers.size,0);}finally{c.nativeModel?.dispose();}
});
test('native post-frame accessibility reuses the cached layout without range queries',()=>{
 const c=bridge();try{vm.runInContext("nativeInit(1000);nativeFit();nativeResize(800,500);nativeRenderFrameJSON('view',800,500);nativePointer('move',0,200,100);nativeModel.seriesData=()=>{throw Error('readout rebuilt series range');};nativeModel.store.index.query=()=>{throw Error('readout rebuilt OHLC range');};",c);assert.ok(c.nativeAccessibility(true).crosshair);assert.throws(()=>c.nativeAccessibility(),/rebuilt/);c.nativeReleaseFrameCache('view');assert.throws(()=>c.nativeAccessibility(true),/rebuilt/);}finally{c.nativeModel?.dispose();}
});
test('native host publication-order fixture keeps viewport, indicator and subscriptions',()=>{const c=bridge();assert.equal(c.nativePublicationOrderSelfTest().passed,4);});
