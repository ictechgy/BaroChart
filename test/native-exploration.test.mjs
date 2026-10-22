import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';
const bundle=await buildNativeBundle();
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(t,n=40){const c=vm.createContext({});vm.runInContext(bundle,c);c.nativeInit(n);t.after(()=>vm.runInContext('nativeModel.dispose()',c));return c;}
const run=(c,s)=>vm.runInContext(s,c);
const act=(c,a,v)=>plain(c.nativeDataExploration(a,v));

test('OFF is default; explicit navigation/read require enable and invalid actions reject',t=>{
 const c=fixture(t);assert.deepEqual(act(c,'refresh'),{schema:'aster.native-data-exploration',version:1,active:false,time:null,index:null,seriesId:null,phase:'off',text:''});
 for(const [a,v]of [['navigate','ArrowLeft'],['read'],['setActive',1],['navigate','Enter'],['snapshot'],['refresh',1]])assert.throws(()=>act(c,a,v));
});
test('navigation/refresh do not compute dirty indicators, change view or add subscriptions',t=>{
 const c=fixture(t);run(c,`globalThis.before=JSON.stringify([nativeModel.view,nativeModel.follow,nativeModel.crosshair,nativeModel.drawings.selected]);globalThis.listeners=nativeModel.store.listeners.size;nativeModel.store.update(0,nativeModel.store.at(0));globalThis.gets=0;Aster.IndicatorEngine.prototype.get=()=>{gets++;throw Error('unexpected calculation')};`);
 assert.equal(act(c,'setActive',true).index,39);
 for(const key of ['Home','ArrowRight','End','ArrowLeft','ArrowDown','ArrowUp'])act(c,'navigate',key);
 act(c,'refresh');assert.equal(run(c,'gets'),0);assert.equal(run(c,'JSON.stringify([nativeModel.view,nativeModel.follow,nativeModel.crosshair,nativeModel.drawings.selected])===before'),true);
 assert.equal(run(c,'nativeModel.store.listeners.size===listeners'),true);
 assert.throws(()=>act(c,'read'),/unexpected calculation/);assert.equal(run(c,'gets'),1);
});
test('explicit read returns bounded actual values and refresh discards old read text',t=>{
 const c=fixture(t);act(c,'setActive',true);const read=act(c,'read');assert.equal(read.phase,'read');assert.match(read.text,/Current plotted values, cutoff 39/);assert.match(read.text,/Open .*high .*low .*close .*volume /);assert.ok(read.text.length<=4096);
 run(c,`const b=nativeModel.store.at(39);nativeModel.store.update(39,{...b,close:b.high});`);
 const refresh=act(c,'refresh');assert.equal(refresh.phase,'changed');assert.doesNotMatch(refresh.text,/Current plotted values/);assert.equal(refresh.time,read.time);
});
test('exact time survives append/prepend and missing reset selection does not jump',t=>{
 const c=fixture(t);const selected=act(c,'setActive',true);run(c,`const b=nativeModel.store.at(39);nativeModel.store.append({...b,time:b.time+60000});const first=nativeModel.store.at(0);nativeModel.store.prepend([{...first,time:first.time-60000}]);`);
 let state=act(c,'refresh');assert.equal(state.time,selected.time);assert.equal(state.index,40);
 run(c,'nativeModel.store.setData([])');state=act(c,'refresh');assert.equal(state.index,-1);assert.equal(state.time,selected.time);assert.equal(state.phase,'missing');assert.equal(act(c,'navigate','Home').time,null);
});
test('empty data has bounded selection; enable rejects active gesture without cancellation',t=>{
 const c=fixture(t,0);assert.equal(act(c,'setActive',true).index,-1);assert.match(act(c,'read').text,/No stored bars/);act(c,'setActive',false);
 run(c,"nativeInput.gesture={kind:'pan',sentinel:17}");assert.throws(()=>act(c,'setActive',true),/idle gesture/);assert.equal(run(c,'nativeInput.gesture.sentinel'),17);assert.equal(act(c,'refresh').active,false);
});
test('same-model params replacement preserves time; new native runtime owner starts OFF',t=>{
 const c=fixture(t);const s=act(c,'setActive',true);run(c,"nativeAPI.setIndicatorParams('ema',{period:7})");assert.equal(act(c,'read').time,s.time);c.nativeInit(12);assert.equal(act(c,'refresh').active,false);
});
test('compaction removes selection only when exact timestamp is no longer stored',t=>{
 const c=fixture(t);act(c,'setActive',true);act(c,'navigate','Home');run(c,"nativeAPI.compactData({keepLastBars:12,studyHistory:'restart'})");assert.equal(act(c,'refresh').phase,'missing');assert.equal(act(c,'navigate','End').index,11);
});
test('owner mismatch and disposed accessor reject without invoking getter',t=>{
 const c=fixture(t);run(c,'globalThis.oldModel=nativeAPI.model;nativeAPI.model=new Aster.ChartModel()');assert.throws(()=>act(c,'setActive',true),/owner/);run(c,'nativeAPI.model.dispose();nativeAPI.model=oldModel;globalThis.calls=0;Object.defineProperty(nativeModel,"disposed",{get(){calls++;return false},configurable:true})');assert.throws(()=>act(c,'refresh'),/data property/);assert.equal(run(c,'calls'),0);run(c,'delete nativeModel.disposed');
});
test('read callback cannot return state from replaced owner or recursively navigate',t=>{
 const c=fixture(t);act(c,'setActive',true);run(c,`const read=nativeAPI.dataAt;nativeAPI.dataAt=function(...args){globalThis.nestedRejected=false;try{nativeDataExploration('navigate','Home')}catch(e){nestedRejected=/already running/.test(e.message)}return read.apply(this,args)}`);assert.equal(act(c,'read').phase,'read');assert.equal(run(c,'nestedRejected'),true);
 run(c,`nativeAPI.dataAt=function(){nativeInit(5);return null}`);assert.throws(()=>act(c,'read'),/disposed|owner/i);assert.equal(act(c,'refresh').active,false);
});
test('two runtime selections and returned receipt objects are isolated',t=>{
 const a=fixture(t),b=fixture(t);const s=act(a,'setActive',true);s.active=false;s.text='forged';assert.equal(act(a,'refresh').active,true);assert.equal(act(b,'refresh').active,false);for(let i=0;i<30;i++){act(a,'setActive',false);act(a,'setActive',true);}assert.equal(run(a,'nativeModel.store.listeners.size'),run(b,'nativeModel.store.listeners.size'));
});
test('coherent same-API model replacement drops old selection',t=>{
 const c=fixture(t);act(c,'setActive',true);run(c,`const old=nativeModel;nativeModel=new Aster.ChartModel();nativeAPI.model=nativeModel;nativeInput.model=nativeModel;old.dispose();`);assert.equal(act(c,'refresh').active,false);
});
test('read source mutation fails stale and later refresh recovers',t=>{
 const c=fixture(t);act(c,'setActive',true);run(c,`globalThis.originalRead=nativeAPI.dataAt;nativeAPI.dataAt=function(){const b=nativeModel.store.at(39);nativeModel.store.update(39,b);return null}`);assert.throws(()=>act(c,'read'),/changed/);run(c,'nativeAPI.dataAt=originalRead');assert.equal(act(c,'read').phase,'read');
});
test('visible-series limit is enforced without lazy calculation',t=>{
 const c=fixture(t);run(c,`nativeModel.series=Array.from({length:257},(_,i)=>({id:'s'+i,panel:'price',visible:true}));`);assert.throws(()=>act(c,'setActive',true),/series limit/);assert.equal(act(c,'setActive',false).active,false);
});
test('read preserves selected series panel/offset metadata and hides invisible series',t=>{
 const c=fixture(t);run(c,`nativeAPI.addPanel({id:'study'});nativeAPI.addSeries({id:'shifted',type:'line',panel:'study',source:'close',offset:2});nativeAPI.setSeries('volume',{visible:false});`);act(c,'setActive',true);act(c,'navigate','ArrowDown');const state=act(c,'navigate','ArrowDown');assert.equal(state.seriesId,'shifted');assert.match(act(c,'read').text,/Series shifted; panel study; axis default;.*plot offset 2; source index 37/);
});
test('navigation preserves pending parameter capture; explicit lazy read uses existing stale policy',t=>{
 const c=fixture(t);act(c,'setActive',true);
 run(c,`globalThis.job=nativeParamsSourceBegin('ema',{period:9},0,805306368,1)`);
 for(const key of ['Home','End','ArrowLeft','ArrowDown'])act(c,'navigate',key);
 act(c,'refresh');assert.equal(c.nativeParamsSourceCheck(c.job.ticket,0),true);c.nativeParamsSourceAbort(1);
 run(c,`nativeModel.store.update(0,nativeModel.store.at(0));globalThis.job=nativeParamsSourceBegin('ema',{period:9},0,805306368,2)`);
 assert.equal(act(c,'read').phase,'read');assert.throws(()=>c.nativeParamsSourceCheck(c.job.ticket,0),/changed|stale/i);assert.equal(c.nativeParamsSourceStatus(2).status,'failed');
});
