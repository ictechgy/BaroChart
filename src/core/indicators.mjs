import {registerStoreOwner,unregisterStoreOwner} from './store-owners.mjs';
import {optionRecord,identifier,RESOURCE_LIMITS} from './contracts.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {portableIndicatorFactory,portableIndicatorFactories,requirePortableIndicator} from './indicator-modules.mjs';
import './trusted-studies.mjs';
import {vwapDefinition,pivotsDefinition} from './session-studies.mjs';
const cloneState = x => Array.isArray(x) ? x.map(cloneState) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, cloneState(v)])) : x;
// Builtin snapshots contain only future-relevant state. Expired monotonic
// entries and a completed smoothing seed cannot influence another step.
function canonicalCheckpoint(x) {
  if(Array.isArray(x))return x.map(canonicalCheckpoint);
  if(!x||typeof x!=='object')return x;
  if(Object.keys(x).length===2&&Array.isArray(x.a)&&(!x.a.length||Array.isArray(x.a[0]))&&Number.isInteger(x.head))return {a:x.a.slice(x.head).map(canonicalCheckpoint),head:0};
  const out=Object.fromEntries(Object.entries(x).map(([k,v])=>[k,canonicalCheckpoint(v)]));
  if(Object.hasOwn(x,'count')&&Object.hasOwn(x,'sum')&&Object.hasOwn(x,'value')&&Number.isFinite(x.value))out.sum=0;
  return out;
}
function equalState(a,b){if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equalState(a[k],b[k]));}
function period(p) { if (!Number.isInteger(p) || p < 1 || p > 10000) throw new RangeError('Period must be 1..10000'); return p; }
function roll(s, key, value, n) {
  const q = s[key] ??= {a: [], head: 0, sum: 0};
  if (!Number.isFinite(value)) { q.a = []; q.head = 0; q.sum = 0; return NaN; }
  if (q.a.length < n) { q.a.push(value); q.sum += value; }
  else { q.sum += value - q.a[q.head]; q.a[q.head] = value; q.head = (q.head + 1) % n; }
  return q.a.length === n ? q.sum / n : NaN;
}
function smooth(s, key, value, n, alpha) {
  const q = s[key] ??= {count: 0, sum: 0, value: NaN};
  if (!Number.isFinite(value)) { q.count = 0; q.sum = 0; q.value = NaN; return NaN; }
  if (q.count < n) { q.count++; q.sum += value; if (q.count === n) q.value = q.sum / n; }
  else q.value += alpha * (value - q.value);
  return q.value;
}
function trueRange(b, previous) { return Number.isFinite(previous) ? Math.max(b.high - b.low, Math.abs(b.high - previous), Math.abs(b.low - previous)) : b.high - b.low; }
// Monotonic queues give amortized O(1) rolling highs/lows. Snapshot compaction
// also prevents stale queue storage from growing with the full data history.
function extreme(s, key, value, n, i, maximum) {
  const q = s[key] ??= {a: [], head: 0};
  while (q.a.length > q.head && (maximum ? q.a[q.a.length - 1][1] <= value : q.a[q.a.length - 1][1] >= value)) q.a.pop();
  q.a.push([i, value]);
  while (q.a[q.head]?.[0] <= i - n) q.head++;
  if (q.head > 256) { q.a = q.a.slice(q.head); q.head = 0; }
  return i >= n - 1 ? q.a[q.head][1] : NaN;
}
function definition(outputs, initial, step, plotOffsets = {}) {
  return {outputs, plotOffsets, create() { let s = cloneState(initial); return {step: (b, i) => step(s, b, i), snapshot: () => canonicalCheckpoint(s), restore: state => {s = cloneState(state);}}; }};
}
export const builtinIndicators = new Map();
// Private provenance follows definitions across local staging/hydration without
// trusting a mutable registry name. Weak keys do not retain retired studies.
const canonicalDefinitionOrigins=new WeakMap();
function add(name, make) {builtinIndicators.set(name,params=>{const def=make(params);canonicalDefinitionOrigins.set(def,{name,create:def.create,outputs:[...def.outputs],offsets:{...def.plotOffsets}});return def;});}
export function isCanonicalBuiltinDefinition(name,def){
 const origin=canonicalDefinitionOrigins.get(def);if(!origin||origin.name!==name)return false;
 const own=(object,key)=>{const d=Object.getOwnPropertyDescriptor(object,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;},outputs=own(def,'outputs'),offsets=own(def,'plotOffsets');
 if(own(def,'create')!==origin.create||!Array.isArray(outputs)||own(outputs,'length')!==origin.outputs.length||origin.outputs.some((key,i)=>own(outputs,String(i))!==key))return false;
 if(!offsets||![Object.prototype,null].includes(Object.getPrototypeOf(offsets))||Reflect.ownKeys(offsets).length!==Object.keys(origin.offsets).length)return false;
 return Object.keys(origin.offsets).every(key=>Object.is(own(offsets,key),origin.offsets[key]));
}
add('sma', ({period: p = 20, source = 'close'} = {}) => {period(p); return definition(['value'], {}, (s, b) => [roll(s, 'r', b[source], p)]);});
add('ema', ({period: p = 20, source = 'close'} = {}) => {period(p); return definition(['value'], {}, (s, b) => [smooth(s, 'e', b[source], p, 2 / (p + 1))]);});
add('wma', ({period: p = 20} = {}) => {period(p); return definition(['value'], {}, (s, b) => { roll(s, 'r', b.close, p); const q = s.r; if (q.a.length < p) return [NaN]; let sum = 0; for (let j = 0; j < p; j++) sum += q.a[(q.head + j) % p] * (j + 1); return [sum / (p * (p + 1) / 2)]; });});
add('rsi', ({period: p = 14} = {}) => {period(p); return definition(['value'], {previous: NaN}, (s, b) => {
  const delta = b.close - s.previous; s.previous = b.close; if (!Number.isFinite(delta)) return [NaN];
  const gain = smooth(s, 'g', Math.max(0, delta), p, 1 / p), loss = smooth(s, 'l', Math.max(0, -delta), p, 1 / p);
  return [!Number.isFinite(gain) ? NaN : gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)];
});});
add('atr', ({period: p = 14} = {}) => {period(p); return definition(['value'], {previous: NaN}, (s, b) => {const tr = trueRange(b, s.previous); s.previous = b.close; return [smooth(s, 'tr', tr, p, 1 / p)];});});
add('macd', ({fast = 12, slow = 26, signal = 9} = {}) => {period(fast); period(slow); period(signal); if (fast >= slow) throw new RangeError('MACD fast < slow'); return definition(['macd', 'signal', 'histogram'], {}, (s, b) => {
  const value = smooth(s, 'f', b.close, fast, 2 / (fast + 1)) - smooth(s, 'l', b.close, slow, 2 / (slow + 1)), sig = smooth(s, 's', value, signal, 2 / (signal + 1)); return [value, sig, value - sig];
});});
add('bollinger', ({period: p = 20, deviation = 2} = {}) => {period(p); if (!Number.isFinite(deviation) || deviation < 0) throw new RangeError('Deviation'); return definition(['middle', 'upper', 'lower'], {mean: 0, m2: 0, a: [], head: 0}, (s, b) => {
  if (s.a.length === p) {const old = s.a[s.head]; if (p > 1) {const next = (p * s.mean - old) / (p - 1); s.m2 -= (old - s.mean) * (old - next); s.mean = next;} else {s.mean = 0; s.m2 = 0;} s.a[s.head] = b.close; s.head = (s.head + 1) % p;}
  else s.a.push(b.close);
  const count = s.a.length, delta = b.close - s.mean; s.mean += delta / count; s.m2 += delta * (b.close - s.mean);
  if (count < p) return [NaN, NaN, NaN]; const d = deviation * Math.sqrt(Math.max(0, s.m2) / p); return [s.mean, s.mean + d, s.mean - d];
});});
add('donchian', ({period: p = 20} = {}) => {period(p); return definition(['middle', 'upper', 'lower'], {}, (s, b, i) => {const h = extreme(s, 'h', b.high, p, i, true), l = extreme(s, 'l', b.low, p, i, false); return [(h + l) / 2, h, l];});});
// Aroon period counts prior intervals, so the current-inclusive window has p+1
// bars. Monotonic queues retain the latest index when extrema tie (including ±0).
add('aroon', ({period: p = 25} = {}) => {period(p); return definition(['up', 'down', 'oscillator'], {}, (s, b, i) => {
  extreme(s, 'h', b.high, p + 1, i, true); extreme(s, 'l', b.low, p + 1, i, false);
  if (i < p) return [NaN, NaN, NaN];
  const up = 100 * (p - (i - s.h.a[s.h.head][0])) / p, down = 100 * (p - (i - s.l.a[s.l.head][0])) / p;
  return [up, down, up - down];
});});
add('stochastic', ({period: p = 14, smoothK = 3, smoothD = 3} = {}) => {period(p); period(smoothK); period(smoothD); return definition(['k', 'd'], {}, (s, b, i) => {const h = extreme(s, 'h', b.high, p, i, true), l = extreme(s, 'l', b.low, p, i, false), raw = !Number.isFinite(h) ? NaN : h === l ? 50 : 100 * (b.close - l) / (h - l), k = roll(s, 'k', raw, smoothK); return [k, roll(s, 'd', k, smoothD)];});});
add('roc', ({period: p = 12} = {}) => {period(p); return definition(['value'], {a: [], head: 0}, (s, b) => {let result = NaN; if (s.a.length === p) {const old = s.a[s.head]; result = old === 0 ? NaN : (b.close / old - 1) * 100; s.a[s.head] = b.close; s.head = (s.head + 1) % p;} else s.a.push(b.close); return [result];});});
add('williamsR', ({period: p = 14} = {}) => {period(p); return definition(['value'], {}, (s, b, i) => {const h = extreme(s, 'h', b.high, p, i, true), l = extreme(s, 'l', b.low, p, i, false); return [!Number.isFinite(h) ? NaN : h === l ? -50 : -100 * (h - b.close) / (h - l)];});});
add('cci', ({period: p = 20} = {}) => {period(p); return definition(['value'], {}, (s, b) => {const tp = (b.high + b.low + b.close) / 3, mean = roll(s, 'tp', tp, p); if (!Number.isFinite(mean)) return [NaN]; const dev = s.tp.a.reduce((v, x) => v + Math.abs(x - mean), 0) / p; return [dev === 0 ? 0 : (tp - mean) / (0.015 * dev)];});});
add('obv', () => definition(['value'], {previous: NaN, value: 0}, (s, b) => {if (Number.isFinite(s.previous)) s.value += Math.sign(b.close - s.previous) * b.volume; s.previous = b.close; return [s.value];}));
add('vwap',vwapDefinition);
add('mfi', ({period: p = 14} = {}) => {period(p); return definition(['value'], {previous: NaN}, (s, b) => {const tp = (b.high + b.low + b.close) / 3, sign = Math.sign(tp - s.previous); s.previous = tp; if (!Number.isFinite(sign)) return [NaN]; const pos = roll(s, 'p', sign > 0 ? tp * b.volume : 0, p), neg = roll(s, 'n', sign < 0 ? tp * b.volume : 0, p); return [!Number.isFinite(pos) ? NaN : pos === 0 && neg === 0 ? 50 : neg === 0 ? 100 : 100 - 100 / (1 + pos / neg)];});});
add('cmf', ({period: p = 20} = {}) => {period(p); return definition(['value'], {}, (s, b) => {const mf = b.high === b.low ? 0 : (2 * b.close - b.high - b.low) / (b.high - b.low) * b.volume, flow = roll(s, 'f', mf, p), vol = roll(s, 'v', b.volume, p); return [!Number.isFinite(flow) || vol === 0 ? NaN : flow / vol];});});
add('adx', ({period: p = 14} = {}) => {period(p); return definition(['adx', 'plusDI', 'minusDI'], {previous: null}, (s, b) => {
  const prev = s.previous; s.previous = {high: b.high, low: b.low, close: b.close}; if (!prev) return [NaN, NaN, NaN];
  const up = b.high - prev.high, down = prev.low - b.low, tr = smooth(s, 'tr', trueRange(b, prev.close), p, 1 / p), plus = smooth(s, 'p', up > down && up > 0 ? up : 0, p, 1 / p), minus = smooth(s, 'm', down > up && down > 0 ? down : 0, p, 1 / p);
  const a = !Number.isFinite(tr) ? NaN : tr === 0 ? 0 : 100 * plus / tr, z = !Number.isFinite(tr) ? NaN : tr === 0 ? 0 : 100 * minus / tr, dx = a + z === 0 ? 0 : 100 * Math.abs(a - z) / (a + z);
  return [smooth(s, 'dx', dx, p, 1 / p), a, z];
});});

function weighted(s,key,value,n) {const mean=roll(s,key,value,n);if(!Number.isFinite(mean))return NaN;const q=s[key];let total=0;for(let j=0;j<n;j++)total+=q.a[(q.head+j)%n]*(j+1);return total/(n*(n+1)/2);}
function emaValue(s,key,value,n){return smooth(s,key,value,n,2/(n+1));}
function moneyFlow(b){return b.high===b.low?0:(2*b.close-b.high-b.low)/(b.high-b.low)*b.volume;}
for(const [name,order] of [['dema',2],['tema',3]])add(name,({period:p=20}={})=>{period(p);return definition(['value'],{},(s,b)=>{const a=emaValue(s,'a',b.close,p),z=emaValue(s,'b',a,p);return [order===2?2*a-z:3*a-3*z+emaValue(s,'c',z,p)];});});
add('hma',({period:p=20}={})=>{period(p);const half=Math.max(1,Math.floor(p/2)),root=Math.max(1,Math.floor(Math.sqrt(p)));return definition(['value'],{},(s,b)=>[weighted(s,'r',2*weighted(s,'h',b.close,half)-weighted(s,'f',b.close,p),root)]);});
add('keltner',({period:p=20,atrPeriod=10,multiplier=2}={})=>{period(p);period(atrPeriod);if(!Number.isFinite(multiplier)||multiplier<0)throw new RangeError('Multiplier');return definition(['middle','upper','lower'],{previous:NaN},(s,b)=>{const mid=emaValue(s,'e',b.close,p),atr=smooth(s,'a',trueRange(b,s.previous),atrPeriod,1/atrPeriod);s.previous=b.close;return [mid,mid+multiplier*atr,mid-multiplier*atr];});});
add('supertrend',({period:p=10,multiplier=3}={})=>{period(p);if(!Number.isFinite(multiplier)||multiplier<=0)throw new RangeError('Multiplier');return definition(['value','direction'],{previous:NaN,upper:NaN,lower:NaN,direction:1},(s,b)=>{
 const atr=smooth(s,'a',trueRange(b,s.previous),p,1/p),prev=s.previous;s.previous=b.close;if(!Number.isFinite(atr))return [NaN,NaN];const upper=(b.high+b.low)/2+multiplier*atr,lower=(b.high+b.low)/2-multiplier*atr;
 if(!Number.isFinite(s.upper)){s.upper=upper;s.lower=lower;}else{const oldUpper=s.upper,oldLower=s.lower;s.upper=upper<oldUpper||prev>oldUpper?upper:oldUpper;s.lower=lower>oldLower||prev<oldLower?lower:oldLower;if(s.direction<0&&b.close>s.upper)s.direction=1;else if(s.direction>0&&b.close<s.lower)s.direction=-1;}return [s.direction>0?s.lower:s.upper,s.direction];
});});
add('ichimoku',({conversion=9,base=26,span=52,displacement=26}={})=>{[conversion,base,span].forEach(period);if(!Number.isInteger(displacement)||displacement<0||displacement>10000)throw new RangeError('Displacement');return definition(['tenkan','kijun','spanA','spanB','chikou'],{},(s,b,i)=>{const midpoint=(key,n)=>(extreme(s,key+'h',b.high,n,i,true)+extreme(s,key+'l',b.low,n,i,false))/2,t=midpoint('t',conversion),k=midpoint('k',base);return [t,k,(t+k)/2,midpoint('b',span),b.close];},{spanA:displacement,spanB:displacement,chikou:-displacement});});
add('trix',({period:p=15}={})=>{period(p);return definition(['value'],{previous:NaN},(s,b)=>{const value=emaValue(s,'c',emaValue(s,'b',emaValue(s,'a',b.close,p),p),p),prev=s.previous;s.previous=value;
 // A zero denominator or unrepresentable percentage is a gap. Keep smoothing
 // state so a later representable percentage can recover without a reset.
 const change=!Number.isFinite(prev)||prev===0?NaN:(value/prev-1)*100;return [Number.isFinite(change)?change:NaN];});});
add('ppo',({fast=12,slow=26,signal=9}={})=>{[fast,slow,signal].forEach(period);if(fast>=slow)throw new RangeError('Fast < slow');return definition(['ppo','signal','histogram'],{},(s,b)=>{const f=emaValue(s,'f',b.close,fast),l=emaValue(s,'l',b.close,slow),v=l===0?NaN:100*(f-l)/l,sig=emaValue(s,'s',v,signal);return [v,sig,v-sig];});});
add('stochRSI',({period:p=14,stochPeriod=14,smoothK=3,smoothD=3}={})=>{[p,stochPeriod,smoothK,smoothD].forEach(period);return definition(['k','d'],{previous:NaN,valid:0},(s,b)=>{
 const delta=b.close-s.previous;s.previous=b.close;let r=NaN;if(Number.isFinite(delta)){const g=smooth(s,'g',Math.max(0,delta),p,1/p),l=smooth(s,'l',Math.max(0,-delta),p,1/p);r=!Number.isFinite(g)?NaN:g===0&&l===0?50:l===0?100:100-100/(1+g/l);}
 let raw=NaN;if(Number.isFinite(r)){const i=s.valid++,hi=extreme(s,'h',r,stochPeriod,i,true),lo=extreme(s,'z',r,stochPeriod,i,false);raw=!Number.isFinite(hi)?NaN:hi===lo?50:100*(r-lo)/(hi-lo);}const k=roll(s,'k',raw,smoothK);return [k,roll(s,'d',k,smoothD)];
});});
add('adl',()=>definition(['value'],{value:0},(s,b)=>[s.value+=moneyFlow(b)]));
add('chaikin',({fast=3,slow=10}={})=>{period(fast);period(slow);if(fast>=slow)throw new RangeError('Fast < slow');return definition(['value'],{value:0},(s,b)=>{s.value+=moneyFlow(b);return [emaValue(s,'f',s.value,fast)-emaValue(s,'l',s.value,slow)];});});
add('forceIndex',({period:p=13}={})=>{period(p);return definition(['value'],{previous:NaN},(s,b)=>{const value=(b.close-s.previous)*b.volume;s.previous=b.close;return [emaValue(s,'e',value,p)];});});
add('volumeOscillator',({fast=14,slow=28}={})=>{period(fast);period(slow);if(fast>=slow)throw new RangeError('Fast < slow');return definition(['value'],{},(s,b)=>{const f=roll(s,'f',b.volume,fast),l=roll(s,'l',b.volume,slow);return [l===0?NaN:100*(f-l)/l];});});
add('vortex',({period:p=14}={})=>{period(p);return definition(['plus','minus'],{previous:null},(s,b)=>{const prev=s.previous;s.previous={high:b.high,low:b.low,close:b.close};if(!prev)return [NaN,NaN];const tr=roll(s,'tr',trueRange(b,prev.close),p),a=roll(s,'p',Math.abs(b.high-prev.low),p),z=roll(s,'m',Math.abs(b.low-prev.high),p);return [tr===0?NaN:a/tr,tr===0?NaN:z/tr];});});
add('pivots',pivotsDefinition);
add('parabolicSAR',({step=.02,max=.2}={})=>{if(!Number.isFinite(step)||!Number.isFinite(max)||step<=0||max<step||max>1)throw new RangeError('SAR acceleration');return definition(['value','direction'],{previous:null,older:null,sar:NaN,ep:NaN,af:step,direction:1},(s,b)=>{
 const prev=s.previous;if(!prev){s.previous={high:b.high,low:b.low,close:b.close};return [NaN,NaN];}
 if(!Number.isFinite(s.sar)){s.direction=b.close>=prev.close?1:-1;s.sar=s.direction>0?Math.min(prev.low,b.low):Math.max(prev.high,b.high);s.ep=s.direction>0?Math.max(prev.high,b.high):Math.min(prev.low,b.low);}
 else{let sar=s.sar+s.af*(s.ep-s.sar);sar=s.direction>0?Math.min(sar,prev.low,s.older?.low??prev.low):Math.max(sar,prev.high,s.older?.high??prev.high);if(s.direction>0?b.low<sar:b.high>sar){s.direction=-s.direction;sar=s.ep;s.ep=s.direction>0?b.high:b.low;s.af=step;}else if(s.direction>0?b.high>s.ep:b.low<s.ep){s.ep=s.direction>0?b.high:b.low;s.af=Math.min(max,s.af+step);}s.sar=sar;}
 s.older=prev;s.previous={high:b.high,low:b.low,close:b.close};return [s.sar,s.direction];
});});

const canonicalBuiltinIndicators=new Map(builtinIndicators);
export function resolveIndicatorFactory(name){return canonicalBuiltinIndicators.get(name)??portableIndicatorFactory(name);}
export function requirePortableFactory(name,factory){const builtin=canonicalBuiltinIndicators.get(name);if(builtin&&factory===builtin)return null;return requirePortableIndicator(name,factory);}
// Running calls reject recursion; a suspended generator may be superseded by
// a new explicit calculation without leaving an abandoned iterator busy forever.
const indicatorCalculationGeneration=new WeakMap(),indicatorCalculationRunning=new WeakMap();
let indicatorCalculationDepth=0;
const MAX_INDICATOR_CALCULATION_DEPTH=32;
function acquireIndicatorCalculation(entry,token){if(indicatorCalculationDepth>=MAX_INDICATOR_CALCULATION_DEPTH)throw indicatorCalculationError('IndicatorBusyError','Indicator calculation nesting limit (32)');indicatorCalculationRunning.set(entry,token);indicatorCalculationDepth++;}
function releaseIndicatorCalculation(entry,token){if(indicatorCalculationRunning.get(entry)===token){indicatorCalculationRunning.delete(entry);indicatorCalculationDepth--;}}
function indicatorCalculationError(name,message){const error=new Error(message);error.name=name;return error;}
export class IndicatorEngine {
  constructor(store, {checkpointSize = 256,maxOutputBytes=268435456} = {}) {
    if (!Number.isInteger(checkpointSize) || checkpointSize < 1) throw new RangeError('Checkpoint size');
    if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<0||maxOutputBytes>536870912)throw new RangeError('Indicator output byte limit');this.maxOutputBytes=maxOutputBytes;this.store = store; this.checkpointSize = checkpointSize; this.registry = new Map([...builtinIndicators,...portableIndicatorFactories()]); this.entries = new Map();
    this.unsubscribe = store._subscribeInternal(({from, kind, to, appended}) => { if(kind==='compact')return;for (const e of this.entries.values()) {if(e.preparedVersion===store.version)continue;e.dirty = Math.min(e.dirty, from);e.dirtyTo=Math.max(e.dirtyTo??0,kind==='update'?from+1:kind==='batch'?(to??store.length):store.length);if(kind!=='update'&&(kind!=='batch'||appended>0))e.invalidated=true; if (kind === 'reset' || kind === 'prepend') {e.checkpoints.clear(); e.dirty = 0; e.length = 0;}} });registerStoreOwner(this,store,'engine');
  }
  register(name, factory) {identifier(name,'Indicator name');if (typeof name !== 'string' || typeof factory !== 'function' || this.registry.has(name)) throw new TypeError('Unique name and factory required'); this.registry.set(name, factory);}
  add(id, name, params = {}) {
    identifier(id,'Indicator id');validateIndicatorParams(params);if(this.entries.size>=RESOURCE_LIMITS.maxIndicators)throw new RangeError('Indicator limit');
    if (this.entries.has(id)) throw new Error('Duplicate indicator id'); const make = this.registry.get(name); if (!make) throw new Error(`Unknown indicator: ${name}`);
    const def = make(params); if (!Array.isArray(def.outputs) || !def.outputs.length||def.outputs.length>32 || def.outputs.some(k=>typeof k!=='string'||!k||k.length>128||['__proto__','constructor','prototype'].includes(k)) || new Set(def.outputs).size!==def.outputs.length || typeof def.create !== 'function' || Object.entries(def.plotOffsets??{}).some(([k,v])=>!def.outputs.includes(k)||!Number.isInteger(v)||Math.abs(v)>10000)) throw new TypeError('Invalid indicator definition');
    const entry={def,name,params:cloneState(params), dirty: 0, dirtyTo:this.store.length,invalidated:true,length: 0, arrays: [], checkpoints: new Map(), revision: 0};this.entries.set(id,entry);try{return this.get(id);}catch(error){if(this.entries.get(id)===entry)this.entries.delete(id);throw error;}
  }
  remove(id) {this.entries.delete(id);}
  get(id) {const task=this.calculate(id);let next;do{next=task.next();}while(!next.done);return next.value;}
  *calculate(id,chunkSize=4096) {
    if(!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>65536)throw new RangeError('Calculation chunk size');
    const entries=this.entries,e=entries.get(id);if(!e)throw new Error(`Missing indicator: ${id}`);
    if(indicatorCalculationRunning.has(e))throw indicatorCalculationError('IndicatorBusyError','Indicator calculation already running');
    const store=this.store,version=store.version,n=store.length,cap=store.capacity,c=store.columns,columnRefs=[c.time,c.open,c.high,c.low,c.close,c.volume],def=e.def,checkpoints=e.checkpoints,token={};
    let arrays=e.arrays,completed=false;
    acquireIndicatorCalculation(e,token);indicatorCalculationGeneration.set(e,token);
    const owned=()=>this.store===store&&this.entries===entries&&entries.get(id)===e&&indicatorCalculationGeneration.get(e)===token;
    const sameSource=()=>store.version===version&&store.length===n&&store.capacity===cap&&store.columns===c&&c.time===columnRefs[0]&&c.open===columnRefs[1]&&c.high===columnRefs[2]&&c.low===columnRefs[3]&&c.close===columnRefs[4]&&c.volume===columnRefs[5];
    const check=()=>{if(!owned()||!sameSource()||e.def!==def||e.checkpoints!==checkpoints||e.arrays!==arrays)throw indicatorCalculationError('StaleSourceError','Stale indicator calculation: source changed or owner replaced, removed, or disposed');};
    try {
      if(!arrays.length||arrays[0].length!==cap){
        const bytes=[...entries.values()].reduce((sum,item)=>sum+item.def.outputs.length*cap*8,0);check();
        if(bytes>this.maxOutputBytes)throw new RangeError('Indicator output byte limit');
        const next=def.outputs.map((_,j)=>{const a=new Float64Array(cap).fill(NaN);if(arrays[j])a.set(arrays[j].subarray(0,Math.min(cap,arrays[j].length)));return a;});
        check();e.arrays=next;arrays=next;
      }
      const block=this.checkpointSize;
      let computedFrom=e.computedFrom??0,computedUntil=e.computedUntil??n,revision=e.revision,calculated=false;
      if(e.dirty<n){
        const start=Math.floor(e.dirty/block)*block,pureBuiltin=this.registry.get(e.name)===canonicalBuiltinIndicators.get(e.name)&&isCanonicalBuiltinDefinition(e.name,def);check();
        const reuse=pureBuiltin&&!e.invalidated&&e.length===n;
        // Checkpoints are written in place. Until successful completion they
        // cannot prove that a still-uncomputed suffix matches this generation.
        e.invalidated=true;const inst=def.create();check();
        if(start){const has=checkpoints.has(start);check();if(!has)throw new Error('Missing checkpoint');const state=checkpoints.get(start);check();inst.restore(state);check();}
        const bar={};let until=n;
        for(let i=start;i<n;i++){
          if(i%block===0){
            const state=inst.snapshot();check();const old=checkpoints.get(i);check();
            const converged=reuse&&i>start&&i>=(e.dirtyTo??n)&&old&&equalState(state,canonicalCheckpoint(old));check();
            if(converged){until=i;break;}
            checkpoints.set(i,state);check();
          }
          bar.time=c.time[i];bar.open=c.open[i];bar.high=c.high[i];bar.low=c.low[i];bar.close=c.close[i];bar.volume=c.volume[i];
          const values=inst.step(bar,i);if(!pureBuiltin)check();
          const arity=values?.length;if(!pureBuiltin)check();if(arity!==arrays.length)throw new TypeError('Indicator output arity');
          for(let j=0;j<arity;j++){const value=values[j];if(!pureBuiltin)check();if(typeof value!=='number'||value===Infinity||value===-Infinity)throw new TypeError('Output must be finite or NaN');arrays[j][i]=value;}
          if((i-start+1)%chunkSize===0){check();releaseIndicatorCalculation(e,token);yield {from:start,to:i+1,total:n};check();acquireIndicatorCalculation(e,token);}
        }
        if(until===n&&n%block===0){const state=inst.snapshot();check();checkpoints.set(n,state);check();}
        if(until===n)for(const key of checkpoints.keys()){check();if(key>n){checkpoints.delete(key);check();}}
        computedFrom=start;computedUntil=until;revision++;calculated=true;
      }
      const result={outputs:Object.fromEntries(def.outputs.map((key,i)=>[key,arrays[i].subarray(0,n)])),plotOffsets:{...def.plotOffsets},revision,computedFrom,computedUntil};
      check();
      // Managed entries are ordinary data records. No user callback follows
      // this last guard before the clean revision becomes visible.
      if(calculated){e.computedFrom=computedFrom;e.computedUntil=computedUntil;e.dirty=n;e.dirtyTo=0;e.invalidated=false;e.length=n;e.revision=revision;}
      completed=true;return result;
    } finally {
      releaseIndicatorCalculation(e,token);
      if(!completed&&owned()&&!sameSource()){e.dirty=0;e.invalidated=true;}
    }
  }
  dispose() {try{this.unsubscribe(); this.entries.clear();}finally{unregisterStoreOwner(this);}}
}
