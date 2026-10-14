import {BarStore} from '../core/data.mjs';
const hosts=new WeakMap(),members=new WeakMap(),models=new WeakMap();
const typed=Object.getPrototypeOf(Float64Array.prototype),lengthOf=Object.getOwnPropertyDescriptor(typed,'length').get,bufferOf=Object.getOwnPropertyDescriptor(typed,'buffer').get;
const ordinaryBuffer=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
function own(o,k){const d=Object.getOwnPropertyDescriptor(o,k);if(!d||!('value'in d))throw new TypeError('Time range requires owned data properties');return d.value;}
function writable(o,k){const d=Object.getOwnPropertyDescriptor(o,k);if(!d||!('value'in d)||!d.writable)throw new TypeError('Time range target must be writable');}
function options(o,keys){if(!o||Object.getPrototypeOf(o)!==Object.prototype||Reflect.ownKeys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))throw new TypeError('Explicit time range options required');return keys.map(k=>own(o,k));}
function capture(host){
 const chart=host.chart,model=host.model;if(own(chart,'model')!==model||own(chart,'disposed')||Object.getOwnPropertyDescriptor(model,'disposed')&&own(model,'disposed'))throw new Error('Time range owner changed');
 const store=own(model,'store');if(!(store instanceof BarStore))throw new TypeError('Time range store');
 const columns=own(store,'columns'),time=own(columns,'time'),length=own(store,'length'),version=own(store,'version'),view=own(model,'view'),from=own(view,'from'),to=own(view,'to');
 if(!(time instanceof Float64Array)||!Number.isSafeInteger(length)||length<0||lengthOf.call(time)<length||!Number.isFinite(from)||!Number.isFinite(to)||to<=from)throw new TypeError('Time range source');
 try{ordinaryBuffer.call(bufferOf.call(time));}catch{throw new TypeError('Time range requires non-shared columns');}
 return {host,store,columns,time,length,version,view,from,to};
}
function sameData(a,b){return a.store===b.store&&a.columns===b.columns&&a.time===b.time&&a.length===b.length&&a.version===b.version;}
function sameView(a,b){return a.from===b.from&&a.to===b.to;}
function finalGuard(s){const n=capture(s.host);if(!sameData(s,n)||s.view!==n.view||!sameView(s,n))throw new Error('Time range source changed');}
function bound(time,n,value,upper=false){let a=0,b=n;while(a<b){const m=Math.floor((a+b)/2);if(time[m]<value||upper&&time[m]===value)a=m+1;else b=m;}return a;}
function forward(model){const series=own(model,'series');if(!Array.isArray(series))throw new TypeError('Time range series');let offset=0;for(let i=0;i<series.length;i++){const s=own(series,String(i)),visible=Object.getOwnPropertyDescriptor(s,'visible'),o=Object.getOwnPropertyDescriptor(s,'offset');if(visible&&!('value'in visible)||o&&!('value'in o))throw new TypeError('Time range series metadata');if(visible?.value!==false){const v=o?.value??0;if(!Number.isFinite(v))throw new TypeError('Time range offset');offset=Math.max(offset,v);}}return offset;}
function storedRange(s,from,to){const a=Math.max(0,Math.ceil(from)),b=Math.min(s.length-1,Math.floor(to));return a<=b?{from:s.time[a],to:s.time[b]}:null;}
function plan(s,request,missing){
 const state={generation:request.generation,requestedTimeRange:{...request.range},matchedSourceIndices:null,effectiveIndices:{from:s.from,to:s.to},effectiveStoredTimes:storedRange(s,s.from,s.to),padding:{before:Math.max(0,-s.from-.5),after:Math.max(0,s.to-(s.length-.5))},expanded:false,clipped:false,applied:false,status:'empty',stale:false};
 if(!s.length)return {s,state};
 const clipped=request.range.from<s.time[0]||request.range.to>s.time[s.length-1];state.clipped=clipped;
 if(clipped&&missing==='reject'){state.status='insufficient';return {s,state};}
 const first=bound(s.time,s.length,request.range.from),last=bound(s.time,s.length,request.range.to,true)-1;
 if(first>last){state.status='unmatched';return {s,state};}
 const a=first-.5,b=last+.5,n=Math.max(10,s.length+forward(s.host.model)),span=Math.min(n,Math.max(Math.min(10,n),b-a)),from=Math.max(-.5,Math.min(n-.5-span,a)),to=from+span;
 writable(s.host.model,'view');writable(s.host.model,'follow');
 Object.assign(state,{matchedSourceIndices:{from:first,to:last},effectiveIndices:{from,to},effectiveStoredTimes:storedRange(s,from,to),padding:{before:Math.max(0,-from-.5),after:Math.max(0,to-(s.length-.5))},expanded:from<a||to>b,applied:true,status:clipped?'clipped':'applied'});
 return {s,state,view:{from,to}};
}
export function registerTimeRangeHost(chart,model,notify){hosts.set(chart,{chart,model,notify});}
export function disposeTimeRangeHost(chart){members.get(chart)?.detach();hosts.delete(chart);}
export function refreshTimeRange(chart){members.get(chart)?.refresh();}
/** Explicit bar-open center ranges; normal redraw may calculate dirty studies. */
export class TimeRangeGroup {
 #members=new Map();#generation=0;#disposed=false;#mode;#missing;#depth=0;#errors=[];#origin=null;
 constructor(o){const [mode,missing]=options(o,['mode','missing']);if(!['manual','view'].includes(mode)||!['clip','reject'].includes(missing))throw new TypeError('Time range policy');this.#mode=mode;this.#missing=missing;}
 get size(){return this.#members.size;}
 get diagnostics(){return this.#errors.map(x=>({...x}));}
 #error(kind){this.#errors.push({generation:this.#generation,kind});if(this.#errors.length>16)this.#errors.shift();}
 add(chart,o){if(this.#disposed)throw new Error('Time range group disposed');const [publish,receive]=options(o,['publish','receive']);if(typeof publish!=='boolean'||typeof receive!=='boolean'||!publish&&!receive)throw new TypeError('Time range roles');const host=hosts.get(chart);if(!host)throw new TypeError('Live CanvasChart required');if(members.has(chart)||models.has(host.model))throw new Error('Chart or model already belongs to a time range group');if(this.size>=8)throw new RangeError('Time range group limit');const baseline=capture(host),record={host,publish,receive,baseline,state:null,detach:null,refresh:null};record.detach=()=>this.#remove(record);record.refresh=()=>this.#refresh(record);this.#members.set(chart,record);members.set(chart,record);models.set(host.model,record);return ()=>record.detach?.();}
 #remove(record){const host=record.host;if(!host)return;if(this.#origin===record){this.#origin=null;for(const r of this.#members.values())if(r.state)r.state={...r.state,stale:true};}this.#members.delete(host.chart);members.delete(host.chart);models.delete(host.model);record.host=null;record.baseline=null;record.state=null;record.detach=null;record.refresh=null;this.#generation++;}
 #refresh(record){if(!record.host||this.#disposed)return;try{const now=capture(record.host),before=record.baseline;record.baseline=now;if(!sameData(before,now)){if(this.#origin===record){for(const r of this.#members.values())if(r.state)r.state={...r.state,stale:true};}else if(record.state)record.state={...record.state,stale:true};return;}if(!sameView(before,now)){if(record.state)record.state={...record.state,stale:true};if(this.#mode==='view'&&record.publish)this.syncFrom(record.host.chart);}}catch{this.#error('automatic-sync-failed');}}
 status(chart){const record=this.#members.get(chart);if(!record)throw new Error('Chart is not a time range member');if(!record.state)return null;const now=capture(record.host),origin=this.#origin,sourceStale=origin?!sameData(origin.baseline,capture(origin.host)):false;return structuredClone({...record.state,stale:record.state.stale||sourceStale||!sameData(record.baseline,now)||!sameView(record.baseline,now)});}
 syncFrom(chart){
  if(this.#disposed)throw new Error('Time range group disposed');const origin=this.#members.get(chart);if(!origin?.publish)throw new Error('Time range publishing not permitted');if(this.#depth>=16)throw new RangeError('Time range reentry limit');this.#depth++;
  try{
   const source=capture(origin.host),first=Math.max(0,Math.ceil(source.from)),last=Math.min(source.length-1,Math.floor(source.to));
   if(first>last)return {generation:this.#generation,published:false,status:'empty-source',requestedTimeRange:null,trimmed:false};
   const range={from:source.time[first],to:source.time[last]};if(!Number.isSafeInteger(range.from)||!Number.isSafeInteger(range.to)||range.from>range.to)throw new TypeError('Time range timestamps');
   const request={range,generation:this.#generation+1},staged=[];
   for(const record of this.#members.values())if(record!==origin&&record.receive)staged.push({record,...plan(capture(record.host),request,this.#missing)});
   finalGuard(source);for(const p of staged)finalGuard(p.s);
   this.#generation=request.generation;this.#origin=origin;origin.baseline=source;if(origin.state)origin.state={...origin.state,stale:true};
   for(const p of staged){if(p.view){p.s.host.model.view=p.view;p.s.host.model.follow=false;}p.record.state=p.state;p.record.baseline={...p.s,view:p.view??p.s.view,from:p.state.effectiveIndices.from,to:p.state.effectiveIndices.to};}
   for(const p of staged){if(this.#generation!==request.generation)break;try{finalGuard(source);}catch{this.#error('source-changed-during-notification');break;}const host=p.record.host;if(host&&this.#members.get(host.chart)===p.record&&p.state.applied){try{finalGuard(p.record.baseline);host.notify();}catch{this.#error('receiver-notification-failed');}}}
   return {generation:request.generation,published:true,status:'published',requestedTimeRange:{...range},trimmed:source.from<-.5||source.to>source.length-.5};
  }finally{this.#depth--;}
 }
 dispose(){if(this.#disposed)return;this.#disposed=true;for(const record of [...this.#members.values()])this.#remove(record);this.#errors=[];}
}
