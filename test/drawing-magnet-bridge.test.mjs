// Native command bridge in Node VM and facade/demo source checks only.
// No Swift/JSC, Android/JNI, browser or trusted pointer event execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const canonical=await buildNativeBundle(),shipped=await read('../native/Resources/aster-core.js');
const fixture=`(()=>{
 nativeInit(20,{visibleBars:20,panels:[{id:'price',range:[0,100],padding:0}],series:[{id:'p',type:'candles',panel:'price'}]});nativeResize(894,446);
 const rows=Array.from({length:20},(_,i)=>({time:1700000000000+i*i*60000+i,open:10,high:100,low:1,close:90,volume:1}));nativeCommand('setData',[rows]);
 const off={...nativeInput.drawingMagnet};nativeCommand('setDrawingMagnet',[{mode:'strong',radiusPx:1}]);
 const place=(x,y)=>{nativeCommand('setTool',['horizontal']);nativePointer('down',1,x,y);nativePointer('up',1,0,0);return nativeModel.drawings.items.at(-1).points[0];};
 const sourceAnchor=place(195,55),midpoint=place(132,55);
 nativeCommand('addAxis',[{id:'B',panel:'price',side:'left',range:[1,100],padding:0,scale:'log',inverted:true}]);nativeCommand('addSeries',[{id:'b',type:'ohlc',panel:'price',axisId:'B'}]);nativeCommand('setDrawingTarget',[{panel:'price',seriesId:'b'}]);
 const secondary=place(94+4.5/20*718+2,12+Math.log(35)/Math.log(100)*400);
 nativeCommand('setTool',['trendline']);nativePointer('down',1,94+4.5/20*718,200);const transaction=nativeModel.drawings.transaction;let errors=0;
 for(const options of [{mode:'wrong'},{mode:'weak',radiusPx:33},{mode:'weak',radiusPx:null},{mode:'off',extra:true}])try{nativeCommand('setDrawingMagnet',[options]);}catch(e){errors++;}
 const invalidPreserved=nativeModel.drawings.transaction===transaction&&nativeInput.drawingMagnet.mode==='strong';nativeCommand('setDrawingMagnet',[{mode:'strong',radiusPx:1}]);const samePreserved=nativeModel.drawings.transaction===transaction;
 nativeCommand('setDrawingMagnet',[{mode:'off'}]);const cancelled=nativeModel.drawings.transaction===null&&nativeInput.pointers.size===0;
 nativeModel.dispose();return JSON.stringify({off,sourceAnchor,midpoint,secondary,errors,invalidPreserved,samePreserved,cancelled,listeners:nativeModel.store.listeners.size});
})()`;
function run(source){const context=vm.createContext({});vm.runInContext(source,context,{timeout:5000});return JSON.parse(vm.runInContext(fixture,context,{timeout:5000}));}
function verify(result){
 assert.deepEqual(result.off,{mode:'off',radiusPx:8},'off default');
 assert.deepEqual(result.sourceAnchor,{time:1700000960004,price:90},'exact source anchor');
 assert.deepEqual(result.midpoint,{time:1700000240002,price:90},'earlier bar midpoint');
 assert.deepEqual(result.secondary,{time:1700000960004,price:90},'target-axis screen projection');
 assert.equal(result.errors,4,'invalid options reject');assert.equal(result.invalidPreserved,true,'invalid options preserve transaction');assert.equal(result.samePreserved,true,'same config preserves transaction');assert.equal(result.cancelled,true,'changed config rolls back local draft');assert.equal(result.listeners,0,'cleanup');
}
for(const [name,source]of [['canonical generator',canonical],['shipped SDK resource',shipped]])test(`${name} executes magnet through real nativeCommand/nativePointer in Node VM`,()=>verify(run(source)));
for(const [name,from,to,label]of [
 ['wrong stored timestamp','time:store.columns.time[at],price','time:store.columns.time[at]+1,price','exact source anchor'],
 ['later-bar tie','Math.abs(x-ax)<=Math.abs(x-bx)','Math.abs(x-ax)<Math.abs(x-bx)','earlier bar midpoint'],
 ['primary-axis substitution','py=axis.y(value);','py=layout.axis(target.panel).y(value);','target-axis screen projection']
])test(`intentional ${name} fault is caught by the specific independent assertion`,t=>{
 assert.equal(canonical.split(from).length,2,'unique mutation site');const result=run(canonical.replace(from,to));let failure;
 assert.throws(()=>verify(result),error=>{failure=error;return error instanceof assert.AssertionError&&error.message.includes(label);});
 t.diagnostic(failure.stack);
});
test('Swift/UIKit and Java/Android facades forward options to the same command validator (source only)',async()=>{
 const swift=await read('../native/AsterNative.swift'),ui=await read('../native/AsterUIKit.swift'),java=await read('../native/android/java/dev/aster/charts/AsterEngine.java'),view=await read('../native/android/java/dev/aster/charts/AsterChartView.java');
 assert.match(swift,/public func setDrawingMagnet\(_ options: \[String: Any\]\) throws \{ try command\("setDrawingMagnet", \[options\]\) \}/);
 assert.match(java,/public void setDrawingMagnet\(JSONObject options\) throws JSONException \{command\("setDrawingMagnet",options\);\}/);
 assert.match(ui,/public func setDrawingMagnet[^\n]+guard !isDisposed,!disposing[^\n]+try engine.setDrawingMagnet\(options\);setNeedsDisplay\(\)[^\n]+lastError = String\(describing: error\)/);
 assert.match(view,/public void setDrawingMagnet\(JSONObject options\)\{try\{engine.setDrawingMagnet\(options\);lastError=null;\}catch\(Exception e\)\{lastError=e.toString\(\);\}\}/);
});
test('demo selector defaults Off and reapplies explicit mode on both rebuild paths (source only)',async()=>{
 const html=await read('../examples/web/index.html'),demo=await read('../examples/web/demo.mjs');
 const selector=html.match(/<select id="magnet"[^>]*>(.*?)<\/select>/s);assert.ok(selector);assert.deepEqual([...selector[1].matchAll(/value="([^"]+)"/g)].map(m=>m[1]),['off','weak','strong']);
 assert.match(html,/<label for="magnet">/);assert.equal(demo.split("chart.api.setDrawingMagnet({mode:$('magnet').value});chart.controller.text=").length,3);
 assert.match(demo,/\$\('magnet'\).onchange=\(\)=>\{if\(chart\)chart.api.setDrawingMagnet\(\{mode:\$\('magnet'\).value\}\)/);
});
