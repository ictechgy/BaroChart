import {FIELDS, validateBar} from './data.mjs';
import {RESOURCE_LIMITS} from './contracts.mjs';

// Shared per module/runtime, independent of chart lifetime. Keep reuse bounded
// and fold ASCII identifier case without depending on resolvedOptions (QuickJS's
// native timezone bridge exposes only formatToParts).
const formatters = new Map(),MARKET_TIMEZONE_FORMATTER_LIMIT=32;
export function zonedParts(time, timezone) {
  if(typeof timezone!=='string'||!timezone.length||timezone.length>128)throw new TypeError('Timezone string, at most 128 characters required');
  const key=timezone.replace(/[A-Z]/g,char=>char.toLowerCase());let fmt=formatters.get(key);
  if(!fmt)fmt=new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const result=Object.fromEntries(fmt.formatToParts(new Date(time)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  // The native shim can reject a zone at formatToParts, after construction.
  // Failed calls neither insert nor refresh/evict successful cached entries.
  formatters.delete(key);formatters.set(key,fmt);if(formatters.size>MARKET_TIMEZONE_FORMATTER_LIMIT)formatters.delete(formatters.keys().next().value);
  return result;
}
export function marketDate(time, timezone) {const p = zonedParts(time, timezone); return `${p.year}-${p.month}-${p.day}`;}
export function shiftDate(date, days) {return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);}
export function zonedEpoch(date, clock, timezone, ambiguity = 'earlier') {
  const iso = `${date}T${clock.length === 5 ? clock + ':00' : clock}`, naive = Date.parse(iso + 'Z'); if (!Number.isFinite(naive)) throw new TypeError('ISO date and HH:mm[:ss] required');
  const offsets = new Set();
  for (const d of [-1, 0, 1]) {const t = naive + d * 86400000, p = zonedParts(t, timezone), local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); offsets.add(local - t);}
  const candidates = [...offsets].map(offset => naive - offset).filter(t => {const p = zonedParts(t, timezone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === iso;}).sort((a, b) => a - b);
  if (!candidates.length) throw new RangeError('Nonexistent local time at DST boundary');
  if (candidates.length > 1 && ambiguity === 'reject') throw new RangeError('Ambiguous local time');
  return ambiguity === 'later' ? candidates[candidates.length - 1] : candidates[0];
}
export function validateSymbol(symbol) {
  if (!symbol || ['id', 'exchange', 'timezone', 'currency', 'volumeUnit'].some(k => typeof symbol[k] !== 'string' || !symbol[k]) || !Number.isInteger(symbol.priceDecimals) || symbol.priceDecimals < 0 || symbol.priceDecimals > 18 || !Number.isFinite(symbol.tickSize) || symbol.tickSize <= 0 || !['raw', 'split', 'total-return'].includes(symbol.adjustment)) throw new TypeError('Invalid symbol metadata');
  zonedParts(0, symbol.timezone); return Object.freeze({...symbol});
}
export function formatPrice(value, symbol) {return value.toFixed(symbol.priceDecimals);}
// Timestamp strings use decimal arithmetic before conversion to binary64. Bounds
// prevent unbounded coefficient/exponent expansion; OHLCV values remain Number.
function decimalTime(value, timeUnit) {
  if(value.length>128)throw new RangeError('Timestamp text limit 128 characters');
  const match=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if(!match)throw new TypeError('Timestamp string must use decimal notation');
  const exponent=Number(match[5]??0);
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>10000)throw new RangeError('Timestamp exponent limit 10000');
  const fraction=match[3]??match[4]??'';
  let digits=((match[2]??'')+fraction).replace(/^0+/,'');
  if(!digits)return match[1]==='-'?-0:0;
  let shift=exponent-fraction.length+(timeUnit==='s'?3:0);
  while(shift<0&&digits.endsWith('0')){digits=digits.slice(0,-1);shift++;}
  if(shift<0)throw new RangeError('Time must be an exact UTC millisecond integer');
  if(digits.length+shift>16)throw new RangeError('Time must be in the Date range');
  const time=Number(digits+'0'.repeat(shift))*(match[1]==='-'?-1:1);
  if(Math.abs(time)>8640000000000000)throw new RangeError('Time must be in the Date range');
  return time;
}
export function normalizeOHLCV(rows, {timeUnit = 'ms', format = 'objects'} = {}) {
  if (!['ms', 's'].includes(timeUnit) || !['objects', 'tuples'].includes(format)) throw new TypeError('Explicit format/time unit required');
  return rows.map(row => {const b = Object.fromEntries(FIELDS.map((k, i) => {const value = format === 'tuples' ? row[i] : row[k]; if(k==='time'&&typeof value==='string')return [k,decimalTime(value,timeUnit)]; if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw new TypeError('Numeric fields or nonempty numeric strings required'); return [k, k==='time' ? value*(timeUnit==='s'?1000:1) : Number(value)];})); validateBar(b); return b;});
}

/** Exact timestamp join onto an existing timeline. Unmatched values remain NaN.
 * Inputs are UTC integer milliseconds, strictly ordered, with no duplicate time.
 * This deliberately neither creates a union timeline nor carries values forward.
 */
export function alignSeriesByTime(referenceTimes, points) {
  if (!(Array.isArray(referenceTimes) || referenceTimes instanceof Float64Array) || !Array.isArray(points) || referenceTimes.length > RESOURCE_LIMITS.maxBars || points.length > RESOURCE_LIMITS.maxBars) throw new TypeError('Bounded reference times and point array required');
  const exactTime=time=>typeof time==='number' && Number.isSafeInteger(time) && Math.abs(time)<=8640000000000000;
  const reference=new Float64Array(referenceTimes.length);let previous=-Infinity;
  for(let i=0;i<reference.length;i++){const time=referenceTimes[i];if(!exactTime(time)||time<=previous)throw new TypeError('Reference times must be strictly ordered exact UTC milliseconds');reference[i]=time;previous=time;}
  const times=new Float64Array(points.length),values=new Float64Array(points.length);previous=-Infinity;
  for(let i=0;i<points.length;i++){
    const point=points[i];if(!point||typeof point!=='object'||Array.isArray(point))throw new TypeError('Point {time,value} required');
    const time=point.time,value=point.value;if(!exactTime(time)||time<=previous)throw new TypeError('Point times must be strictly ordered exact UTC milliseconds');
    if(value!==null&&(typeof value!=='number'||value===Infinity||value===-Infinity))throw new TypeError('Point values must be finite numbers, NaN or null gaps');
    times[i]=time;values[i]=value===null?NaN:value;previous=time;
  }
  const aligned=new Float64Array(reference.length).fill(NaN);let cursor=0;
  for(let i=0;i<reference.length&&cursor<times.length;i++){const time=reference[i];while(cursor<times.length&&times[cursor]<time)cursor++;if(times[cursor]===time)aligned[i]=values[cursor++];}
  return aligned;
}

const calendarAnchors=new WeakMap();
function localDateAnchor(calendar,date) {
  const cache=calendarAnchors.get(calendar);if(cache.has(date))return cache.get(date);
  let anchor;
  try {anchor=zonedEpoch(date,'00:00',calendar.timezone);}
  catch(error) {
    if(!(error instanceof RangeError)||error.message!=='Nonexistent local time at DST boundary')throw error;
    // Some zones advance at midnight. Resolve the period label to the first
    // actual instant of that local date, without changing explicit clock rules.
    const naive=Date.parse(date+'T00:00:00Z'),hour=3600000;let before=naive-48*hour,after=null;
    for(let time=before+hour;time<=naive+48*hour;time+=hour){if(marketDate(time,calendar.timezone)===date){after=time;break;}before=time;}
    if(after===null)throw new RangeError('Calendar period starts on a nonexistent local date');
    while(after-before>1){const middle=before+Math.floor((after-before)/2);if(marketDate(middle,calendar.timezone)===date)after=middle;else before=middle;}
    anchor=after;
  }
  cache.set(date,anchor);if(cache.size>calendar.maxCachedDays)cache.delete(cache.keys().next().value);return anchor;
}

// Calendar is injected. No exchange opening hours/holidays are asserted here.
export class SessionCalendar {
  constructor(timezone, sessionsForDate, {maxCachedDays = 512} = {}) {if (typeof sessionsForDate !== 'function' || !Number.isInteger(maxCachedDays) || maxCachedDays < 1) throw new TypeError('Calendar provider and positive cache size required'); this.timezone = timezone; this.provider = sessionsForDate; this.cache = new Map(); this.maxCachedDays = maxCachedDays; zonedParts(0, timezone);calendarAnchors.set(this,new Map());}
  invalidate() {this.cache.clear();calendarAnchors.get(this).clear();}
  sessions(date) {
    if (!this.cache.has(date)) {
      const windows = this.provider(date).map(s => {
        const kind=s.kind??'regular',open=s.open,close=s.close;
        // Match zonedEpoch's HH:mm / HH:mm:ss equivalence before deciding
        // whether the close belongs to the next local date (not UTC +24h).
        const openClock=open.length===5?open+':00':open,closeClock=close.length===5?close+':00':close;
        return {date,kind,open:zonedEpoch(date,open,this.timezone),close:zonedEpoch(closeClock<=openClock?shiftDate(date,1):date,close,this.timezone)};
      });
      if (windows.some(s => s.close <= s.open) || windows.some((s, i) => i && s.open < windows[i - 1].close)) throw new RangeError('Ordered nonoverlapping sessions required');
      this.cache.set(date, windows);
      if (this.cache.size > this.maxCachedDays) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(date);
  }
  at(time, kinds = ['regular']) {const day = marketDate(time, this.timezone); return [...this.sessions(shiftDate(day, -1)), ...this.sessions(day)].find(s => time >= s.open && time < s.close && kinds.includes(s.kind)) ?? null;}
  bucket(time, interval, kinds = ['regular']) {
    const session = this.at(time, kinds); if (!session) return null;
    if (Number.isFinite(interval) && interval > 0) return {time: session.open + Math.floor((time - session.open) / interval) * interval, sessionDate: session.date, kind: session.kind};
    let date = session.date;
    if (interval === 'week') {const day = new Date(date + 'T12:00:00Z').getUTCDay(); date = shiftDate(date, -((day + 6) % 7));}
    else if (interval === 'month') date = date.slice(0, 7) + '-01';
    else if (interval !== 'day') throw new TypeError('Interval is milliseconds/day/week/month');
    return {time: localDateAnchor(this,date), sessionDate: session.date, kind: session.kind};
  }
}

// Reference aggregater for externally supplied trades. Keeps bounded tick detail
// for deterministic late corrections. It does not open any network connection.
export class TickAggregator {
  constructor({calendar, interval = 60000, kinds = ['regular'], latePolicy = 'reject', maxBuckets = 256, maxTicksPerBucket = 100000} = {}) {
    if (!(calendar instanceof SessionCalendar) || !['reject', 'correct'].includes(latePolicy) || !Number.isSafeInteger(maxBuckets) || maxBuckets < 1 || !Number.isSafeInteger(maxTicksPerBucket) || maxTicksPerBucket < 1) throw new TypeError('Aggregation policy/calendar');
    if (!(Number.isSafeInteger(interval) && interval > 0) && !['day', 'week', 'month'].includes(interval)) throw new TypeError('Interval must be positive exact milliseconds/day/week/month');
    this.calendar = calendar; this.interval = interval; this.kinds = kinds; this.latePolicy = latePolicy; this.maxBuckets = maxBuckets; this.maxTicksPerBucket = maxTicksPerBucket; this.buckets = new Map(); this.lastTime = -Infinity; this.sequence = 0;
  }
  push(tick) {
    // Snapshot only the public fields once; do not retain caller objects/getters.
    if (!tick || typeof tick !== 'object') throw new TypeError('Tick object required');
    const {time, price, volume, id} = tick;
    if (!Number.isSafeInteger(time) || Math.abs(time) > 8640000000000000 || !Number.isFinite(price) || !Number.isFinite(volume) || volume < 0 || (id !== undefined && typeof id !== 'string')) throw new TypeError('Finite tick, exact UTC milliseconds and optional string id required');
    const bucket = this.calendar.bucket(time, this.interval, this.kinds); if (!bucket) return {status: 'outside-session'};
    const entry = this.buckets.get(bucket.time), late = time < this.lastTime;
    if (id !== undefined && entry?.ids.has(id)) return {status: 'duplicate'};
    if (late && this.latePolicy === 'reject') return {status: 'late-rejected'};
    // Corrections can replace retained bars, never insert a missing historical
    // timestamp into a downstream store. Historical insertion requires reset.
    if (!entry && late) return {status: 'outside-correction-window'};
    const ticks = entry?.ticks ?? [];
    if (ticks.length >= this.maxTicksPerBucket) throw new RangeError('Tick retention limit; externally aggregate higher-volume feeds');
    const copy = {time, price, volume, ...(id === undefined ? {} : {id}), order: this.sequence};
    let at = ticks.length;
    if (late) {at = ticks.findIndex(t => t.time > time); if (at < 0) at = ticks.length;}
    // Evaluate the stable chronological merge before committing any state. The
    // order of Float64 additions remains identical to stable sorting all ticks.
    const bar = {time: bucket.time, open: at === 0 ? price : ticks[0].price, high: -Infinity, low: Infinity, close: at === ticks.length ? price : ticks[ticks.length - 1].price, volume: 0};
    for (let i = 0; i <= ticks.length; i++) {
      const t = i === at ? copy : ticks[i < at ? i : i - 1];
      bar.high = Math.max(bar.high, t.price); bar.low = Math.min(bar.low, t.price); bar.volume += t.volume;
    }
    if (!Number.isFinite(bar.volume)) throw new RangeError('Aggregated tick volume must remain finite');
    validateBar(bar);
    const committed = entry ?? {ticks, ids: new Set()};
    ticks.splice(at, 0, copy); if (id !== undefined) committed.ids.add(id);
    if (!entry) this.buckets.set(bucket.time, committed);
    this.sequence++; this.lastTime = Math.max(this.lastTime, time);
    while (this.buckets.size > this.maxBuckets) this.buckets.delete(Math.min(...this.buckets.keys()));
    return {status: late ? 'correction' : ticks.length === 1 ? 'append' : 'update', bar, sessionDate: bucket.sessionDate, sessionKind: bucket.kind};
  }
  reset() {this.buckets.clear(); this.lastTime = -Infinity; this.sequence = 0;}
}

export function applyDataEvent(store, event) {
  if (!event || typeof event.kind !== 'string') throw new TypeError('Data event kind required');
  if (event.kind === 'batch') return store.applyEvents(event.events);
  if (event.kind === 'reset') event.columns ? store.setColumns(event.columns, event.length) : store.setData(event.bars);
  else if (event.kind === 'append') store.append(event.bar);
  else if (event.kind === 'update') {if (!store.length || event.bar.time !== store.columns.time[store.length - 1]) throw new RangeError('Update is only the current bar'); store.update(store.length - 1, event.bar);}
  else if (event.kind === 'correction') {const i = store.lowerBound(event.bar.time); if (i === store.length || store.columns.time[i] !== event.bar.time) throw new RangeError('Correction requires an existing timestamp'); store.update(i, event.bar);}
  else if (event.kind === 'prepend') store.prepend(event.bars); else throw new TypeError('Unknown data event');
}

export const DEMO_SYMBOLS = {
  kr: {id: 'SYNTH:KR', exchange: 'SYNTH-KR', timezone: 'Asia/Seoul', currency: 'KRW', priceDecimals: 0, tickSize: 100, volumeUnit: 'shares', adjustment: 'raw'},
  us: {id: 'SYNTH:US', exchange: 'SYNTH-US', timezone: 'America/New_York', currency: 'USD', priceDecimals: 2, tickSize: .01, volumeUnit: 'shares', adjustment: 'raw'},
  crypto: {id: 'SYNTH:COIN', exchange: 'SYNTH-24/7', timezone: 'UTC', currency: 'USD', priceDecimals: 12, tickSize: 1e-12, volumeUnit: 'base-asset', adjustment: 'raw'}
};
export function demoCalendar(market) {
  const symbol = DEMO_SYMBOLS[market]; if (!symbol) throw new Error('Unknown synthetic market');
  return new SessionCalendar(symbol.timezone, date => {
    if (market === 'crypto') return [{open: '00:00', close: '00:00', kind: 'regular'}];
    const weekday = new Date(date + 'T12:00:00Z').getUTCDay(); if ([0, 6].includes(weekday)) return [];
    return market === 'kr' ? [{open: '09:00', close: '15:30', kind: 'regular'}] : [{open: '04:00', close: '09:30', kind: 'extended'}, {open: '09:30', close: '16:00', kind: 'regular'}, {open: '16:00', close: '20:00', kind: 'extended'}];
  });
}
