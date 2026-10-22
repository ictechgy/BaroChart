import {BarStore,FIELDS,validateBar} from './data.mjs';
import {ChartModel} from './model.mjs';
import {resolveIndicatorFactory,isCanonicalBuiltinDefinition} from './indicators.mjs';
import {safeCheckpointParse,safeCheckpointStringify,validateCheckpointState} from './checkpoint-validation.mjs';
import {buildScene} from './scene.mjs';
import {identifier,boundedText,portableStyle,THEME_KEYS} from './contracts.mjs';

import {workspaceBinding,workspaceBindingSame,workspaceSnapshot} from './workspace.mjs';

const replayLimit=65536,replayFactories=new Map(['sma','ema','rsi'].map(name=>[name,resolveIndicatorFactory(name)]));
function replayRecord(value,keys){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Replay plain record required');const out={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!keys.includes(key)||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Replay own data fields required');out[key]=d.value;}return out;}
function replayInteger(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('Replay '+label+' must be '+min+'..'+max);return value;}
function replayList(value,max){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max||Reflect.ownKeys(value).length!==value.length+1)throw new TypeError('Replay dense bounded array required');const rows=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Replay array data properties required');rows.push(d.value);}return rows;}
function replaySource(bars){const refs=replayList(bars,replayLimit),columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(refs.length)]));let previous=-Infinity;for(let i=0;i<refs.length;i++){const bar=replayRecord(refs[i],FIELDS);validateBar(bar,previous);previous=bar.time;for(const key of FIELDS)columns[key][i]=bar[key];}
 // Reject ordinary row/array changes during capture; no getter is ever invoked.
 if(bars.length!==refs.length)throw new Error('Replay source changed during capture');for(let i=0;i<refs.length;i++){if(Object.getOwnPropertyDescriptor(bars,String(i))?.value!==refs[i])throw new Error('Replay source changed during capture');const bar=replayRecord(refs[i],FIELDS);if(FIELDS.some(key=>!Object.is(bar[key],columns[key][i])))throw new Error('Replay source changed during capture');}return columns;}
function replayOptions(value,total){const o=replayRecord(value,['initialCount','visibleBars','priceScale','inverted','volume','theme','indicators']),initialCount=replayInteger(o.initialCount??0,0,total,'initial count'),visibleBars=replayInteger(o.visibleBars??200,1,2048,'visible bars'),priceScale=o.priceScale??'linear',inverted=o.inverted??false,volume=o.volume??false;if(!['linear','log'].includes(priceScale)||typeof inverted!=='boolean'||typeof volume!=='boolean')throw new TypeError('Replay price scale/inverted/volume');for(const k of Object.keys(o))if(o[k]===undefined||o[k]===null)throw new TypeError('Replay options must be defined');const theme=portableStyle(replayRecord(o.theme??{},THEME_KEYS),['background','grid','text','up','down','crosshair']);const ids=new Set(),indicators=replayList(o.indicators??[],4).map(input=>{const s=replayRecord(input,['id','kind','period','color']);identifier(s.id,'Replay study id');if(ids.has(s.id)||!replayFactories.has(s.kind))throw new TypeError('Replay unique study id and sma/ema/rsi kind required');ids.add(s.id);replayInteger(s.period,1,256,'study period');if(Object.hasOwn(s,'color')&&typeof s.color!=='string')throw new TypeError('Replay study color');return Object.freeze({...s,...portableStyle({color:s.color??'#7898ff'},['color'])});});return Object.freeze({initialCount,visibleBars,priceScale,inverted,volume,theme:Object.freeze(theme),indicators:Object.freeze(indicators)});}
function replayComplete(value,keys){const r=replayRecord(value,keys);if(keys.some(k=>!Object.hasOwn(r,k)))throw new TypeError('Replay session missing field');return r;}
function replayBookmark(value,total){const b=replayComplete(value,['id','label','count']);identifier(b.id,'Replay bookmark id');boundedText(b.label,128,'Replay bookmark label');replayInteger(b.count,0,total,'bookmark count');return Object.freeze(b);}
function replaySession(text){if(typeof text!=='string'||text.length>262144)throw new RangeError('Replay session text limit');const d=replayComplete(workspaceSnapshot(safeCheckpointParse(text)),['schema','version','dataset','total','options','count','bookmarks']);if(d.schema!=='barochart.replay-session'||d.version!==1)throw new TypeError('Replay session schema/version');d.dataset=workspaceBinding(d.dataset);replayInteger(d.total,0,replayLimit,'source total');replayInteger(d.count,0,d.total,'session count');replayComplete(d.options,['initialCount','visibleBars','priceScale','inverted','volume','theme','indicators']);d.options=replayOptions(d.options,d.total);const ids=new Set();d.bookmarks=replayList(d.bookmarks,128).map(row=>{const b=replayBookmark(row,d.total);if(ids.has(b.id))throw new TypeError('Duplicate replay bookmark');ids.add(b.id);return b;});return d;}
// Frames deliberately omit layout closures and include detached finite data only.
function replayData(value,depth=0){if(depth>12)throw new RangeError('Replay frame depth');if(value===null||typeof value==='string'||typeof value==='boolean')return value;if(typeof value==='number'){if(!Number.isFinite(value))throw new RangeError('Replay frame finite values required');return value;}if(Array.isArray(value))return value.map(v=>replayData(v,depth+1));if(value&&Object.getPrototypeOf(value)===Object.prototype){const out={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Replay frame data required');if(d.value!==undefined)out[key]=replayData(d.value,depth+1);}return out;}throw new TypeError('Replay frame data required');}
function replayFrame(model,width,height){replayInteger(width,100,4096,'frame width');replayInteger(height,80,2160,'frame height');const scene=buildScene(model,width,height,{crosshair:false,drawings:false});return replayData({width,height,background:scene.background,commands:scene.commands,stats:scene.stats,axes:scene.layout.panels.map(p=>({id:p.id,min:p.min,max:p.max,scale:p.scale,inverted:p.inverted}))});}

function replayGcd(a,b){while(b){const rest=a%b;a=b;b=rest;}return a;}
function replayStateCopy(value){if(Array.isArray(value))return value.map(replayStateCopy);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replayStateCopy(v)]));return value;}
// Replay-local adapter for IndicatorEngine's managed entry record. Eligibility
// failure uses a fresh cold calculation, including canonical live states that
// are valid at runtime but stricter serialized-checkpoint admission rejects.
function replayForwardSeeds(previous,store,o){if(!previous)return null;const from=previous.store.length,n=store.length,cap=store.capacity,oldCap=previous.store.capacity;
 if(!Number.isSafeInteger(from)||from<1||n<=from||n-from>256||cap<n||cap>replayLimit||oldCap<from||oldCap>replayLimit||o.indicators.length*cap*8>4*replayLimit*8)return null;
 const seeds=new Map();for(const s of o.indicators){const old=previous.indicators.entries.get(s.id);
  if(!old||old.name!==s.kind||previous.indicators.registry.get(s.kind)!==replayFactories.get(s.kind)||!isCanonicalBuiltinDefinition(s.kind,old.def)||
   !old.params||Object.keys(old.params).length!==1||old.params.period!==s.period||old.def.outputs.length!==1||old.def.outputs[0]!=='value'||
   old.dirty!==from||old.dirtyTo!==0||old.invalidated!==false||old.length!==from||old.arrays.length!==1||!(old.arrays[0] instanceof Float64Array)||old.arrays[0].length!==oldCap||
   !old.checkpoints||Object.getPrototypeOf(old.checkpoints)!==Map.prototype||old.checkpoints.size!==1||!old.checkpoints.has(from))return null;
  const state=replayStateCopy(old.checkpoints.get(from));try{validateCheckpointState(s.kind,{period:s.period},state,from);}catch{return null;}
  seeds.set(s.id,{def:old.def,array:old.arrays[0],state,from});
 }return seeds;
}
// Only the candidate receives managed records. Owned prefix vectors and copied
// checkpoint state must never alias the prior model; keep these fields in sync
// with IndicatorEngine and the exact-prefix/failure regressions.
function replayStagedStudy(model,s,seeds){const n=model.store.length,engine=model.indicators,seed=seeds?.get(s.id);
 if(!seed)engine.add(s.id,s.kind,{period:s.period});
 else {const cap=model.store.capacity;if((engine.entries.size+1)*cap*8>engine.maxOutputBytes)throw new RangeError('Indicator output byte limit');
  const array=new Float64Array(cap).fill(NaN);array.set(seed.array.subarray(0,seed.from));
  engine.entries.set(s.id,{def:seed.def,name:s.kind,params:{period:s.period},dirty:seed.from,dirtyTo:n,invalidated:true,length:seed.from,arrays:[array],checkpoints:new Map([[seed.from,seed.state]]),revision:0});engine.get(s.id);
 }
 const entry=engine.entries.get(s.id);if(n&&!entry.checkpoints.has(n))throw new Error('Replay endpoint checkpoint missing');for(const key of entry.checkpoints.keys())if(key!==n)entry.checkpoints.delete(key);
}

function replayModel(columns,count,o,prior=null){const store=new BarStore([],{maxBars:replayLimit});store.setColumns(columns,count);const seeds=replayForwardSeeds(prior,store,o),previous=seeds?prior:null;const panels=[{id:'price',weight:3,scale:o.priceScale,inverted:o.inverted,padding:o.priceScale==='log'?0:.08}];if(o.volume)panels.push({id:'volume',weight:1});o.indicators.forEach((s,i)=>{if(s.kind==='rsi')panels.push({id:'replay-rsi-'+i,weight:1,range:[0,100]});});let model;
 try{model=new ChartModel({store,theme:o.theme,panels,visibleBars:o.visibleBars});model.indicators.checkpointSize=previous?replayGcd(previous.store.length,count):Math.max(1,count);model.indicators.maxOutputBytes=4*replayLimit*8;model.indicators.registry=new Map(replayFactories);model.addSeries({id:'replay-price',type:'candles',panel:'price'});if(o.volume)model.addSeries({id:'replay-volume',type:'histogram',panel:'volume',source:'volume',color:'#7898ff'});o.indicators.forEach((s,i)=>{replayStagedStudy(model,s,seeds);model.addSeries({id:'replay-study-'+i,type:'line',panel:s.kind==='rsi'?'replay-rsi-'+i:'price',indicator:s.id,color:s.color});});model.view={from:Math.max(-.5,count-o.visibleBars-.5),to:Math.max(o.visibleBars-.5,count-.5)};model.follow=true;replayFrame(model,800,480);return model;}catch(error){model?.dispose();throw error;}}

/** Manual, isolated prefix replay. No live model/API or scheduling is exposed. */
export class BarReplay {
 #bookmarks=new Map();#columns;#options;#model;#count;#total;#paused=true;#generation=0;#disposed=false;#busy=false;
 constructor(bars,options={}){const columns=replaySource(bars),o=replayOptions(options,columns.time.length),model=replayModel(columns,o.initialCount,o);this.#columns=columns;this.#options=o;this.#total=columns.time.length;this.#count=o.initialCount;this.#model=model;}
 static restoreSession(bars,text,options){const o=replayComplete(options,['datasetBinding']),expected=workspaceBinding(o.datasetBinding),d=replaySession(text);if(!workspaceBindingSame(expected,d.dataset))throw new Error('Replay dataset binding mismatch');if(!Array.isArray(bars)||Object.getOwnPropertyDescriptor(bars,'length')?.value!==d.total)throw new Error('Replay source total mismatch');const candidate=new BarReplay(bars,{...d.options,initialCount:d.count});try{if(candidate.#total!==d.total)throw new Error('Replay source total mismatch');candidate.#options=d.options;candidate.#bookmarks=new Map(d.bookmarks.map(b=>[b.id,b]));return candidate;}catch(error){candidate.dispose();throw error;}}
 #active(){if(this.#disposed)throw new Error('Replay disposed');if(this.#busy)throw new Error('Replay transition busy');}
 snapshot(){this.#active();return Object.freeze({count:this.#count,total:this.#total,initialCount:this.#options.initialCount,lastTime:this.#count?this.#columns.time[this.#count-1]:null,paused:this.#paused,ended:this.#count===this.#total,generation:this.#generation});}
 #change(count,paused,forward=false){this.#active();if(count===this.#count&&paused===this.#paused)return Object.freeze({changed:false,state:this.snapshot()});if(this.#generation===Number.MAX_SAFE_INTEGER)throw new RangeError('Replay generation limit');let next=null;this.#busy=true;try{if(count!==this.#count)next=replayModel(this.#columns,count,this.#options,forward?this.#model:null);const old=this.#model;if(next)this.#model=next;this.#count=count;this.#paused=paused;this.#generation++;if(next)old.dispose();}finally{this.#busy=false;}return Object.freeze({changed:true,state:this.snapshot()});}
 start(){this.#active();return this.#change(this.#count,this.#count===this.#total);}
 pause(){this.#active();return this.#change(this.#count,true);}
 step(count=1){this.#active();replayInteger(count,1,256,'step count');if(this.#count===this.#total)return this.#change(this.#count,true);if(this.#paused)throw new Error('Start manual replay before stepping');const next=Math.min(this.#total,this.#count+count);return this.#change(next,next===this.#total,true);}
 seek(count){this.#active();replayInteger(count,0,this.#total,'revealed count');return this.#change(count,true);}
 reset(){this.#active();return this.#change(this.#options.initialCount,true);}
 bookmarks(){this.#active();return Object.freeze([...this.#bookmarks.values()]);}
 addBookmark(input){this.#active();this.#busy=true;try{const o=replayComplete(workspaceSnapshot(input),['id','label']),b=replayBookmark({...o,count:this.#count},this.#total);if(this.#bookmarks.has(b.id))throw new Error('Duplicate replay bookmark');if(this.#bookmarks.size>=128)throw new RangeError('Replay bookmark limit');this.#bookmarks.set(b.id,b);return b;}finally{this.#busy=false;}}
 renameBookmark(id,label){this.#active();this.#busy=true;try{const input=workspaceSnapshot({id,label});identifier(input.id,'Replay bookmark id');boundedText(input.label,128,'Replay bookmark label');const previous=this.#bookmarks.get(input.id);if(!previous)throw new Error('Missing replay bookmark');const b=Object.freeze({...previous,label:input.label});this.#bookmarks.set(input.id,b);return b;}finally{this.#busy=false;}}
 removeBookmark(id){this.#active();identifier(id,'Replay bookmark id');return this.#bookmarks.delete(id);}
 seekBookmark(id){this.#active();identifier(id,'Replay bookmark id');const b=this.#bookmarks.get(id);if(!b)throw new Error('Missing replay bookmark');return this.seek(b.count);}
 saveSession(datasetBinding){this.#active();this.#busy=true;try{const dataset=workspaceBinding(datasetBinding);const text=safeCheckpointStringify({schema:'barochart.replay-session',version:1,dataset,total:this.#total,options:this.#options,count:this.#count,bookmarks:[...this.#bookmarks.values()]});replaySession(text);return text;}finally{this.#busy=false;}}
 barAt(index){this.#active();replayInteger(index,0,this.#count-1,'revealed bar index');return Object.freeze(Object.fromEntries(FIELDS.map(k=>[k,this.#columns[k][index]])));}
 indicatorValues(id){this.#active();identifier(id,'Replay study id');if(!this.#options.indicators.some(s=>s.id===id))throw new Error('Missing replay study');return new Float64Array(this.#model.indicators.get(id).outputs.value);}
 frame(width,height){this.#active();return replayFrame(this.#model,width,height);}
 dispose(){if(this.#disposed)return;this.#active();this.#disposed=true;this.#model.dispose();this.#model=null;this.#columns=null;this.#options=null;this.#bookmarks.clear();}
}
