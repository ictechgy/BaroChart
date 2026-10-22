// Node VM executes the shared native bridge. Facade checks are source-only;
// no JavaScriptCore/Swift/Android/JNI SDK execution is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
const read=path=>readFile(new URL(path,import.meta.url),'utf8'),canonical=await buildNativeBundle(),shipped=await read('../native/Resources/aster-core.js');
const fixture=`(()=>{
 nativeInit(20,{visibleBars:20,panels:[{id:'price',range:[0,100],padding:0}],series:[{id:'p',type:'candles',panel:'price'}]});nativeResize(894,446);
 const rows=Array.from({length:20},(_,i)=>({time:1700000000000+i*i*60000+i,open:40,high:80,low:10,close:60,volume:1}));nativeCommand('setData',[rows]);
 const off={...nativeInput.crosshairSnap};nativeCommand('setCrosshairSnap',[{mode:'close'}]);nativePointer('move',1,132,96);const first=nativeCommand('crosshairSnapshot',[894,446]),legacy=nativeCommand('crosshairValues',[894,446]);
 nativeCommand('setCrosshairSnap',[{mode:'ohlc'}]);const high=nativeCommand('crosshairSnapshot',[894,446]);nativeCommand('applyDataEvent',[{kind:'correction',bar:{...rows[2],high:85}}]);const corrected=nativeCommand('crosshairSnapshot',[894,446]);
 let errors=0;for(const bad of [{mode:'strong'},{mode:'close',target:{panel:'missing'}},{mode:'ohlc',target:{panel:'price',axisId:'missing'}}])try{nativeCommand('setCrosshairSnap',[bad]);}catch(e){errors++;}
 const validAfterErrors=nativeInput.crosshairSnap.mode==='ohlc'&&nativeModel.crosshair.x===132;
 const raw=0.00000000012345678912345678;nativeCommand('setData',[rows.map(b=>({...b,open:raw,high:raw*2,low:raw/2,close:raw*1.5}))]);nativeCommand('addAxis',[{id:'B',panel:'price',side:'left',scale:'log',inverted:true,range:[raw/4,raw*4],precision:18}]);nativeCommand('addSeries',[{id:'b',type:'ohlc',panel:'price',axisId:'B'}]);nativeCommand('setCrosshairSnap',[{mode:'ohlc',target:{panel:'price',seriesId:'b'}}]);nativePointer('move',1,94+4.5/20*718,212);
 const secondary=nativeCommand('crosshairSnapshot',[894,446]),axisRead=nativeCommand('crosshairValues',[894,446]).axes.find(a=>a.id==='B');
 nativeModel.indicators.add('e','ema',{period:2});const layout=nativeInput.layout(),get=nativeModel.indicators.get;let calls=0;nativeModel.indicators.get=function(...args){calls++;return get.apply(this,args);};Aster.createCrosshairCommands(nativeModel,layout);const preparedCalls=calls;nativeModel.indicators.get=get;
 nativeDataExploration('setActive',true);nativeDataExploration('navigate','Home');const keyboard=nativeDataExploration('refresh');const pointerAfterKeyboard=nativeCommand('crosshairSnapshot',[894,446]);
 nativeModel.dispose();return JSON.stringify({off,first,high,corrected,legacyKeys:Object.keys(legacy),legacyIndex:legacy.index,errors,validAfterErrors,secondary,axisRead,raw,preparedCalls,keyboardIndex:keyboard.index,pointerUnchanged:pointerAfterKeyboard.index===secondary.index,listeners:nativeModel.store.listeners.size});
})()`;
function run(source){const context=vm.createContext({});vm.runInContext(source,context,{timeout:5000});return JSON.parse(vm.runInContext(fixture,context,{timeout:5000}));}
function verify(r){
 assert.deepEqual(r.off,{mode:'free',target:null},'free default');assert.equal(r.first.index,2,'earlier midpoint');assert.equal(r.first.time,1700000240002,'exact source metadata');assert.equal(r.first.field,'close');assert.equal(r.first.price,60);
 assert.deepEqual(r.first.resolved,{x:112,y:172},'display coordinates');assert.equal(r.high.field,'high');assert.equal(r.high.price,80);assert.equal(r.corrected.price,85,'current correction');assert.equal(r.high.price,80,'detached old snapshot');
 assert.deepEqual(r.legacyKeys,['index','time','primary','series','axes']);assert.equal(r.legacyIndex,2);assert.equal(r.errors,3);assert.equal(r.validAfterErrors,true);
 assert.equal(r.secondary.axisId,'B');assert.equal(r.secondary.price,r.raw);assert.ok(Object.is(r.axisRead.value,r.raw),'raw axis readout');assert.equal(r.preparedCalls,0,'prepared resolver does zero study work');assert.equal(r.keyboardIndex,0);assert.equal(r.pointerUnchanged,true);assert.equal(r.listeners,0);
}
for(const [name,source]of [['canonical',canonical],['shipped',shipped]])test(`${name} native bridge executes snap config/snapshot/correction and separate keyboard selection`,()=>verify(run(source)));
for(const [name,from,to,label]of [
 ['timestamp corruption','time:snap.time,field:snap.field','time:snap.time+1,field:snap.field','exact source metadata'],
 ['raw XY substituted for snapped display','resolved:{x:snap.x,y:snap.y}','resolved:{x,y}','display coordinates'],
 ['inverse-roundtrip raw price loss','return snapshot.snapped&&snapshot.axisId===','return false&&snapshot.axisId===','raw axis readout'],
 ['hidden study queried during prepared hover','const cursor=model.crosshair;if(!cursor)return null;','if(model.indicators.entries.has("e"))model.indicators.get("e");const cursor=model.crosshair;if(!cursor)return null;','prepared resolver does zero study work']
])test(`intentional ${name} is caught by its specific assertion`,t=>{
 assert.equal(canonical.split(from).length,2,'unique mutation site');const r=run(canonical.replace(from,to));let failure;assert.throws(()=>verify(r),error=>{failure=error;return error instanceof assert.AssertionError&&error.message.includes(label);});t.diagnostic(failure.stack);
});
test('native facade config/query and read-only notification exclusion are symmetrical (source only)',async()=>{
 const swift=await read('../native/AsterNative.swift'),java=await read('../native/android/java/dev/aster/charts/AsterEngine.java'),ui=await read('../native/AsterUIKit.swift'),view=await read('../native/android/java/dev/aster/charts/AsterChartView.java');
 assert.match(swift,/public func setCrosshairSnap\(_ options: \[String: Any\]\) throws \{ try command\("setCrosshairSnap", \[options\]\) \}/);
 assert.match(swift,/public func crosshairSnapshot[\s\S]*?command\("crosshairSnapshot", \[width, height\]\)[\s\S]*?if value.isNull \{return nil\}[\s\S]*?throw AsterError.invalidScene/);
 assert.match(swift,/else if !\[[^\]]*"crosshairSnapshot"[^\]]*\].contains\(operation\)/);
 assert.match(java,/public void setCrosshairSnap\(JSONObject options\) throws JSONException \{command\("setCrosshairSnap",options\);\}/);
 assert.match(java,/public JSONObject crosshairSnapshot[\s\S]*?command\("crosshairSnapshot",width,height\);if\(result==JSONObject.NULL\)return null;[\s\S]*?instanceof JSONObject/);
 assert.match(java,/else if\([^\n]+!operation.equals\("crosshairSnapshot"\)[^\n]+notifyChanges\(\)/);
 assert.match(ui,/public func setCrosshairSnap[^\n]+guard !isDisposed,!disposing[^\n]+try engine.setCrosshairSnap\(options\);setNeedsDisplay\(\)/);
 assert.match(view,/public void setCrosshairSnap[^\n]+engine.setCrosshairSnap\(options\)/);
});
test('demo separate control defaults free and preserves choice on rebuild/renderer replacement (source only)',async()=>{
 const html=await read('../examples/web/index.html'),demo=await read('../examples/web/demo.mjs'),select=html.match(/<select id="crosshair-snap"[^>]*>(.*?)<\/select>/s);assert.ok(select);assert.deepEqual([...select[1].matchAll(/value="([^"]+)"/g)].map(m=>m[1]),['free','close','ohlc']);assert.match(html,/<label for="crosshair-snap">/);assert.match(html,/<label for="annotation">텍스트<\/label><input id="annotation"/);let depth=0;for(const label of html.matchAll(/<\/?label\b[^>]*>/g)){depth+=label[0].startsWith('</')?-1:1;assert.ok(depth>=0&&depth<=1,'Sibling labels must not nest');}assert.equal(depth,0);
 assert.equal(demo.split("chart.api.setCrosshairSnap({mode:$('crosshair-snap').value});chart.api.setDrawingMagnet").length,3);assert.match(demo,/\$\('crosshair-snap'\).onchange=\(\)=>\{if\(chart\)chart.api.setCrosshairSnap/);
});
