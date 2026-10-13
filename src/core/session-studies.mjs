import {SessionCalendar,zonedParts,zonedEpoch,shiftDate,marketDate} from './markets.mjs';
import {optionRecord} from './contracts.mjs';
import {safeCheckpointParse} from './checkpoint-validation.mjs';

const sessionStudyMaxCalendarBytes=65536,sessionStudyConfigCache=new Map();
function sessionStudyRecord(value,allowed,required=[],label='Session options'){
 optionRecord(value,allowed,label);
 for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!allowed.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))throw new TypeError(label+' own data keys required');}
 for(const key of required)if(!Object.hasOwn(value,key))throw new TypeError(label+' missing '+key);
 return value;
}
function sessionStudyArray(value,max,label){
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)throw new TypeError(label+' array limit');
 const keys=Reflect.ownKeys(value);if(keys.length!==value.length+1)throw new TypeError(label+' array shape');
 for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data elements required');}
 return value;
}
function sessionStudyBytes(text){
 let bytes=0;for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new TypeError('Session Unicode scalar');bytes+=4;}else if(code>=0xdc00&&code<=0xdfff)throw new TypeError('Session Unicode scalar');else bytes+=code<128?1:code<2048?2:3;}return bytes;
}
function sessionStudyText(value,max,label){if(typeof value!=='string'||!value.length||value.length>max)throw new TypeError(label+' string limit');sessionStudyBytes(value);return value;}
function sessionStudyDate(date){sessionStudyText(date,10,'Session date');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new TypeError('Session ISO date');return date;}
function sessionStudyClock(clock){if(typeof clock!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock))throw new TypeError('Session HH:mm clock');return Number(clock.slice(0,2))*60+Number(clock.slice(3));}
function sessionStudyWindows(input){
 sessionStudyArray(input,16,'Session windows');let previousClose=-Infinity;
 return input.map(window=>{sessionStudyRecord(window,['open','close','kind'],['open','close'],'Session window');const open=sessionStudyClock(window.open),clock=sessionStudyClock(window.close),close=clock<=open?clock+1440:clock,kind=sessionStudyText(window.kind===undefined?'regular':window.kind,128,'Session kind');if(kind.includes(',')||kind.trim()!==kind)throw new TypeError('Session kind without comma/outer whitespace');if(open<previousClose)throw new RangeError('Ordered nonoverlapping session windows');previousClose=close;return {open:window.open,close:window.close,kind};});
}

/** A portable configuration, not a claim of an exchange holiday database.
 * UTF-8 length is checked without TextEncoder so the helper also works in JSC
 * and the existing narrow QuickJS timezone bridge.
 */
export function portableSessionCalendar(options){
 sessionStudyRecord(options,['timezone','weekdays','windows','exceptions','ambiguity'],['timezone','weekdays','windows']);const timezone=sessionStudyText(options.timezone,128,'Session timezone');zonedParts(0,timezone);
 sessionStudyArray(options.weekdays,7,'Session weekdays');const weekdays=[...options.weekdays];if(weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)||new Set(weekdays).size!==weekdays.length)throw new TypeError('Unique weekdays 0..6 required');weekdays.sort((a,b)=>a-b);
 const windows=sessionStudyWindows(options.windows),input=options.exceptions===undefined?{}:options.exceptions;sessionStudyRecord(input,input?Object.keys(input):[],[],'Session exceptions');if(Object.keys(input).length>512)throw new RangeError('Session exception limit 512');const exceptions={};for(const date of Object.keys(input).sort()){sessionStudyDate(date);exceptions[date]=sessionStudyWindows(input[date]);}
 const ambiguity=options.ambiguity===undefined?'earlier':options.ambiguity;if(!['earlier','later','reject'].includes(ambiguity))throw new TypeError('Session ambiguity earlier/later/reject');const text=JSON.stringify({timezone,weekdays,windows,exceptions,ambiguity});if(sessionStudyBytes(text)>sessionStudyMaxCalendarBytes)throw new RangeError('Session calendar 64KiB limit');return text;
}
function sessionStudyConfig(text){
 sessionStudyText(text,sessionStudyMaxCalendarBytes,'Session calendar');if(sessionStudyBytes(text)>sessionStudyMaxCalendarBytes)throw new RangeError('Session calendar 64KiB limit');if(sessionStudyConfigCache.has(text))return sessionStudyConfigCache.get(text);
 const parsed=JSON.parse(portableSessionCalendar(safeCheckpointParse(text)));
 for(const windows of [parsed.windows,...Object.values(parsed.exceptions)]){for(const window of windows)Object.freeze(window);Object.freeze(windows);}Object.freeze(parsed.weekdays);Object.freeze(parsed.exceptions);Object.freeze(parsed);sessionStudyConfigCache.set(text,parsed);if(sessionStudyConfigCache.size>16)sessionStudyConfigCache.delete(sessionStudyConfigCache.keys().next().value);return parsed;
}
function sessionStudyWindowsForDate(config,date){if(Object.hasOwn(config.exceptions,date))return config.exceptions[date];return config.weekdays.includes(new Date(date+'T12:00:00Z').getUTCDay())?config.windows:[];}
class sessionStudyCalendar extends SessionCalendar {
 constructor(config){
  super(config.timezone,date=>sessionStudyWindowsForDate(config,date));this.sessionStudyAmbiguity=config.ambiguity;
 }
 sessions(date){
  if(!this.cache.has(date)){const windows=this.provider(date).map(window=>({date,kind:window.kind,open:zonedEpoch(date,window.open,this.timezone,this.sessionStudyAmbiguity),close:zonedEpoch(window.close<=window.open?shiftDate(date,1):date,window.close,this.timezone,this.sessionStudyAmbiguity)}));if(windows.some((window,i)=>window.close<=window.open||i&&window.open<windows[i-1].close))throw new RangeError('Ordered nonoverlapping sessions required');this.cache.set(date,windows);if(this.cache.size>this.maxCachedDays)this.cache.delete(this.cache.keys().next().value);}return this.cache.get(date);
 }
 at(time,kinds=['regular']){const date=marketDate(time,this.timezone),previous=this.sessions(shiftDate(date,-1)),current=this.sessions(date);if(previous.length&&current.length&&previous[previous.length-1].close>current[0].open)throw new RangeError('Overlapping adjacent session dates');return [...previous,...current].find(window=>time>=window.open&&time<window.close&&kinds.includes(window.kind))??null;}
}
function sessionStudyParams(params,name){
 sessionStudyRecord(params,Object.keys(params),[],'Session study params');
 for(const [key,value] of Object.entries(params))if(key!=='calendar'&&(typeof value!=='string'&&typeof value!=='number'||typeof value==='number'&&!Number.isFinite(value)))throw new TypeError('Primitive finite session study params');
 const calendar=params.calendar===undefined?null:sessionStudyConfig(params.calendar),anchor=params.anchorTime;
 if(Object.hasOwn(params,'sessionMs')&&(calendar||anchor!==undefined))throw new TypeError('sessionMs conflicts with calendar/anchorTime');
 if(anchor!==undefined&&(name!=='vwap'||!Number.isSafeInteger(anchor)||Math.abs(anchor)>8640000000000000))throw new RangeError('VWAP anchor UTC milliseconds');
 const sessionMs=params.sessionMs??86400000;if(!Number.isFinite(sessionMs)||sessionMs<=0)throw new RangeError('Session duration');
 let kinds=['regular'];if(params.kinds!==undefined){if(!calendar)throw new TypeError('Session kinds require calendar');sessionStudyText(params.kinds,2048,'Session kinds');kinds=params.kinds.split(',');if(kinds.length>16||kinds.some(kind=>!kind||kind.trim()!==kind||kind.length>128)||new Set(kinds).size!==kinds.length)throw new TypeError('Unique comma-separated session kinds');}
 const source=params.source??'hlc3';if(name==='vwap'&&!['hlc3','close','hl2','ohlc4'].includes(source))throw new TypeError('VWAP source');
 if(name==='vwap'&&params.deviation!==undefined&&(!Number.isFinite(params.deviation)||params.deviation<0))throw new RangeError('VWAP deviation multiplier');
 const advanced=calendar!==null||anchor!==undefined||params.kinds!==undefined||name==='vwap'&&(params.source!==undefined||params.deviation!==undefined);
 return {calendar,anchor,sessionMs,kinds,source,deviation:params.deviation,advanced};
}
function sessionStudySelector(config){
 const calendar=config.calendar?new sessionStudyCalendar(config.calendar):null,memo=calendar?new Map():null;
 const select=time=>{if(config.anchor!==undefined&&time<config.anchor)return null;let session;if(calendar){session=calendar.at(time,config.kinds);if(!session)return null;}if(config.anchor!==undefined)return config.anchor;if(session)return session.date;const bucket=Math.floor(time/config.sessionMs);if(!Number.isFinite(bucket))throw new RangeError('Session bucket overflow');return bucket;};
 // Only this private immutable portable calendar can reuse a selected key.
 // Exact UTC timestamps include successful null selections, never lookup
 // errors or financial state. Generic mutable SessionCalendar is unchanged.
 return bar=>{const time=bar.time;if(!memo||!Number.isSafeInteger(time)||Math.abs(time)>8640000000000000)return select(time);if(memo.has(time)){const session=memo.get(time);memo.delete(time);memo.set(time,session);return session;}const session=select(time);memo.set(time,session);if(memo.size>512)memo.delete(memo.keys().next().value);return session;};
}
function sessionStudyCopy(state){return Object.fromEntries(Object.entries(state).map(([key,value])=>[key,Array.isArray(value)?value.slice():value]));}
function sessionStudyDefinition(outputs,initial,step){return {outputs,plotOffsets:{},create(){let state=sessionStudyCopy(initial);return {step:(bar,index)=>step(state,bar,index),snapshot:()=>sessionStudyCopy(state),restore:next=>{state=sessionStudyCopy(next);}};}};}
function sessionStudyPrice(bar,source){return source==='close'?bar.close:source==='hl2'?(bar.high+bar.low)/2:source==='ohlc4'?(bar.open+bar.high+bar.low+bar.close)/4:(bar.high+bar.low+bar.close)/3;}
function sessionStudyFinite(values){if(values.some(value=>!Number.isFinite(value)))throw new RangeError('Session study numeric overflow');}

export function vwapDefinition(params={}){
 const config=sessionStudyParams(params,'vwap');
 if(!config.advanced)return sessionStudyDefinition(['value'],{session:NaN,pv:0,v:0},(state,bar)=>{const session=Math.floor(bar.time/config.sessionMs);if(state.session!==session){state.session=session;state.pv=0;state.v=0;}state.pv+=(bar.high+bar.low+bar.close)/3*bar.volume;state.v+=bar.volume;return [state.v===0?NaN:state.pv/state.v];});
 const bands=config.deviation!==undefined,outputs=bands?['value','upper','lower','deviation','volume']:['value'],select=sessionStudySelector(config),initial={session:null,count:0,pv:0,v:0,mean:0,m2:0};
 return sessionStudyDefinition(outputs,initial,(state,bar)=>{
  const session=select(bar);if(session===null)return outputs.map(()=>NaN);const previous=state.session===session?state:initial,price=sessionStudyPrice(bar,config.source),v=previous.v+bar.volume,pv=previous.pv+price*bar.volume;
  sessionStudyFinite([price,bar.volume,v,pv]);if(bar.volume<0)throw new RangeError('Session volume');
  const mean=bar.volume===0?previous.mean:previous.v===0?price:previous.mean+(price-previous.mean)*(bar.volume/v),m2=bar.volume===0||previous.v===0?previous.m2:previous.m2+bar.volume*(price-previous.mean)*(price-mean);sessionStudyFinite([mean,m2]);if(m2<0)throw new RangeError('Session variance');
  const value=v===0?NaN:pv/v,sigma=v===0?NaN:Math.sqrt(m2/v),upper=value+config.deviation*sigma,lower=value-config.deviation*sigma;if(v>0)sessionStudyFinite(bands?[value,sigma,upper,lower]:[value]);
  Object.assign(state,{session,count:previous.count+1,pv,v,mean,m2});return bands?[value,upper,lower,sigma,v]:[value];
 });
}
export function pivotsDefinition(params={}){
 const config=sessionStudyParams(params,'pivots');
 if(!config.advanced)return sessionStudyDefinition(['pivot','r1','s1','r2','s2'],{session:NaN,high:NaN,low:NaN,close:NaN,levels:[NaN,NaN,NaN,NaN,NaN]},(state,bar)=>{const session=Math.floor(bar.time/config.sessionMs);if(session!==state.session){if(Number.isFinite(state.close)){const p=(state.high+state.low+state.close)/3;state.levels=[p,2*p-state.low,2*p-state.high,p+state.high-state.low,p-state.high+state.low];}state.session=session;state.high=bar.high;state.low=bar.low;}else{state.high=Math.max(state.high,bar.high);state.low=Math.min(state.low,bar.low);}state.close=bar.close;return state.levels;});
 const select=sessionStudySelector(config),initial={session:null,count:0,high:null,low:null,close:null,levels:[NaN,NaN,NaN,NaN,NaN]};
 return sessionStudyDefinition(['pivot','r1','s1','r2','s2'],initial,(state,bar)=>{
  const session=select(bar);if(session===null)return [NaN,NaN,NaN,NaN,NaN];sessionStudyFinite([bar.high,bar.low,bar.close]);if(bar.low>bar.high||bar.close<bar.low||bar.close>bar.high)throw new RangeError('Session OHLC');
  let levels=state.levels;if(session!==state.session){if(state.count){const p=(state.high+state.low+state.close)/3;levels=[p,2*p-state.low,2*p-state.high,p+state.high-state.low,p-state.high+state.low];sessionStudyFinite(levels);}Object.assign(state,{session,count:1,high:bar.high,low:bar.low,close:bar.close,levels});}else{state.count++;state.high=Math.max(state.high,bar.high);state.low=Math.min(state.low,bar.low);state.close=bar.close;}return state.levels.slice();
 });
}

function sessionStudyCheckpointSession(config,state,index){
 if(!Number.isSafeInteger(state.count)||state.count<0||state.count>index)throw new TypeError('Session checkpoint count');
 if(state.session===null){if(state.count!==0)throw new TypeError('Session checkpoint initial session');return;}
 if(state.count===0)throw new TypeError('Session checkpoint missing count');if(config.anchor!==undefined){if(state.session!==config.anchor)throw new TypeError('Session checkpoint anchor');}else if(config.calendar){sessionStudyDate(state.session);if(!sessionStudyWindowsForDate(config.calendar,state.session).some(window=>config.kinds.includes(window.kind)))throw new TypeError('Session checkpoint excluded date');}else if(!Number.isFinite(state.session)||!Number.isInteger(state.session))throw new TypeError('Session checkpoint bucket');
}
function sessionStudyNear(a,b){return Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-10;}
/** Returns null for legacy sessionMs-only states; the existing legacy validator
 * remains authoritative. New states are validated without state compaction.
 */
export function validateSessionCheckpoint(name,params,state,index){
 if(!['vwap','pivots'].includes(name))return null;const config=sessionStudyParams(params,name);if(!config.advanced)return null;if(!Number.isSafeInteger(index)||index<0||index>4194304)throw new TypeError('Session checkpoint index');
 const keys=name==='vwap'?['session','count','pv','v','mean','m2']:['session','count','high','low','close','levels'];sessionStudyRecord(state,keys,keys,'Session checkpoint');sessionStudyCheckpointSession(config,state,index);
 if(index===0&&state.session!==null)throw new TypeError('Session checkpoint initial state');
 if(name==='vwap'){
  for(const key of ['pv','v','mean','m2'])if(!Number.isFinite(state[key]))throw new TypeError('Session checkpoint finite numbers');if(state.v<0||state.m2<0)throw new TypeError('Session checkpoint volume/variance');
  if(state.v===0&&(state.pv!==0||state.mean!==0||state.m2!==0)||state.count===0&&state.v!==0||state.count===1&&state.m2!==0||state.v>0&&!sessionStudyNear(state.mean,state.pv/state.v))throw new TypeError('Session checkpoint VWAP invariant');
 }else{
  sessionStudyArray(state.levels,5,'Session checkpoint levels');if(state.levels.length!==5)throw new TypeError('Session checkpoint level count');const empty=state.levels.every(Number.isNaN);if(!empty&&state.levels.some(value=>!Number.isFinite(value)))throw new TypeError('Session checkpoint pivot levels');
  if(!state.count){if(state.high!==null||state.low!==null||state.close!==null||!empty)throw new TypeError('Session checkpoint initial OHLC');}else if(![state.high,state.low,state.close].every(Number.isFinite)||state.low>state.high||state.close<state.low||state.close>state.high)throw new TypeError('Session checkpoint OHLC');
  if(!empty){const [p,r1,s1,r2,s2]=state.levels,low=2*p-r1,high=2*p-s1,close=r1+s1-p;if(![low,high,close].every(Number.isFinite)||high<low||close<low-1e-10*Math.max(1,Math.abs(low))||close>high+1e-10*Math.max(1,Math.abs(high))||!sessionStudyNear(r2-p,p-s2)||!sessionStudyNear(r1-s1,r2-p))throw new TypeError('Session checkpoint pivot invariant');}
 }
 return state;
}
