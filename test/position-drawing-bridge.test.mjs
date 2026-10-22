// Native command/resource tests run in Node VM; Swift/Java assertions are source-only.
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
const read=path=>readFile(new URL(path,import.meta.url),'utf8'),canonical=await buildNativeBundle(),shipped=await read('../native/Resources/aster-core.js');
const fixture=`(()=>{
 nativeInit(20,{visibleBars:20,panels:[{id:'price',range:[0,100],padding:0}],series:[]});nativeResize(894,446);nativeCommand('setData',[Array.from({length:20},(_,i)=>({time:1700000000000+i*60000,open:40,high:80,low:10,close:60,volume:1}))]);
 const points=[{time:1700000240000,price:50},{time:1700000240000,price:40},{time:1700000240000,price:70},{time:1700000720000,price:50}];
 nativeCommand('addDrawing',[{id:'p',type:'longposition',points}]);const metrics=nativeCommand('positionMetrics',['p']),version=JSON.parse(nativeCommand('saveDrawings')).version;
 let arity=false;try{nativeCommand('positionMetrics',['p','extra']);}catch(e){arity=/argument count/.test(e.message);}
 const notices=[],c=new Aster.InteractionController(nativeModel,()=>({width:894,height:446}),kind=>notices.push(kind));
 nativeModel.view={from:-.5,to:19.5};const l=c.layout(),q=l.toScreen(points[0],'price');c.down(1,q.x,q.y);c.move(1,q.x+5,192);c.up(1);
 const coupled=nativeModel.drawings.items[0].points,entry=coupled[0].price;
 c.setTool('longposition');c.down(2,112,212);const before=notices.length;c.move(2,232,252);const hover=notices.length===before+1&&notices.at(-1)==='hover';c.cancel();nativeModel.dispose();
 return JSON.stringify({metrics,version,arity,entry,coupled,hover});
})()`;
function run(source){const context=vm.createContext({});vm.runInContext(source,context,{timeout:5000});return JSON.parse(vm.runInContext(fixture,context,{timeout:5000}));}
function verify(r){assert.equal(r.metrics.ratio,2,'raw reward/risk oracle');assert.equal(r.version,3,'explicit v3 document oracle');assert.equal(r.arity,true,'dispatch arity oracle');assert.ok(Math.abs(r.entry-55)<1e-12,'coupled entry handle oracle');assert.equal(r.coupled[3].price,r.entry,'extent entry copy oracle');assert.equal(r.coupled[1].time,r.coupled[0].time,'shared start oracle');assert.equal(r.coupled[2].time,r.coupled[0].time,'shared start oracle');assert.equal(r.coupled[1].price,40,'stop retained oracle');assert.equal(r.coupled[2].price,70,'target retained oracle');assert.equal(r.hover,true,'rejected drag hover oracle');}
for(const [name,source]of [['canonical generator',canonical],['shipped SDK resource',shipped]])test(`${name}: positions through nativeCommand and real DOM-free controller`,()=>verify(run(source)));
for(const [name,from,to,label]of [
 ['reversed ratio','ratio=reward/risk;','ratio=risk/reward;','raw reward/risk oracle'],
 ['silent schema downgrade','items.some(d=>isPositionDrawing(d.type))?3:','items.some(d=>isPositionDrawing(d.type))?2:','explicit v3 document oracle'],
 ['omitted entry propagation','next[3].price=point.price;','next[3].price=points[3].price;','coupled entry handle oracle'],
 ['missing hover repaint',"this.invalidate('hover');return;}}\n        else if(d.type==='freehand')","return;}}\n        else if(d.type==='freehand')",'rejected drag hover oracle'],
])test(`intentional ${name} fails the specific independent assertion`,t=>{assert.equal(canonical.split(from).length,2,'unique mutation');const r=run(canonical.replace(from,to));let failure;assert.throws(()=>verify(r),e=>{failure=e;return e instanceof assert.AssertionError&&e.message.includes(label);});t.diagnostic(failure.stack);});
test('native public metrics wrappers are validated dictionary reads excluded from redraw notification (source only)',async()=>{
 const swift=await read('../native/AsterNative.swift'),java=await read('../native/android/java/dev/aster/charts/AsterEngine.java');
 assert.match(swift,/public func positionMetrics\(_ id: String\) throws -> \[String: Any\][\s\S]*?guard let result = try command\("positionMetrics", \[id\]\).toDictionary\(\) as\? \[String: Any\] else \{throw AsterError.invalidScene\}/);
 assert.match(swift,/else if !\[[^\n]+"positionMetrics"[^\n]+\.contains\(operation\)/);
 assert.match(java,/public JSONObject positionMetrics\(String id\) throws JSONException[\s\S]*?command\("positionMetrics",id\);if\(!\(result instanceof JSONObject\)\)throw new JSONException/);
 assert.match(java,/!operation.equals\("positionMetrics"\)/);
});
test('demo exposes both chart-only tools and no order controls (source only)',async()=>{const html=await read('../examples/web/index.html');for(const type of ['longposition','shortposition'])assert.equal([...html.matchAll(new RegExp('data-tool="'+type+'"','g'))].length,1);});
