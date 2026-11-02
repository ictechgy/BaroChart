import {FIELDS, validateBar} from './data.mjs';
import {RESOURCE_LIMITS,SYMBOL_KEYS,orderedRecord} from './contracts.mjs';

// Shared per module/runtime, independent of chart lifetime. Keep reuse bounded
// and fold ASCII identifier case without depending on resolvedOptions (QuickJS's
// native timezone bridge exposes only formatToParts).
const formatters = new Map(),MARKET_TIMEZONE_FORMATTER_LIMIT=32;
// 시간대 계약 v1(설계 §7.4-2). 시각·이름·연도 검사와 오류 문구를 코어가 정해, V8(웹)·JSC(iOS)·
// QuickJS shim+java.time(Android)이 같은 입력에 같은 답과 같은 오류를 내게 한다.
// 시각 범위는 지원 연도(1000~9999)를 앞뒤로 하루씩 넓힌 것이다. 지역 시각의 연도는 변환 뒤에 다시 본다.
const MARKET_TIME_MIN=-30610310400000,MARKET_TIME_MAX=253402387199999;
// ±HH:MM 고정 오프셋. Intl을 부르지 않고 코어가 산술로 계산한다
const MARKET_FIXED_OFFSET=/^([+-])([01]\d|2[0-3]):([0-5]\d)$/;
// 호스트로 넘길 수 있는 IANA 꼴 이름의 문법. ASCII 밖 글자, 공백, 빈 경로 조각은 호스트까지 가지 않는다
const MARKET_ZONE_NAME=/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/;
// java.time만 받고 IANA·ICU는 거절하는 이름(Z, UT, UTC±…, GMT±…, UT±…)이다. 대소문자를 가리지 않는다.
// 맨 UT는 Android 호스트가 캐시 상태에 따라 소문자 ut까지 받게 되므로 함께 막는다.
const MARKET_HOST_ONLY_ZONE=/^(?:z|ut|(?:utc|gmt|ut)[+\-].*)$/i;

/**
 * 지원하지 않는 시간대 오류를 만든다. 문구에는 이름의 앞 64 UTF-16 단위만 담는다.
 * 호스트(Intl·java.time)가 실패한 경우에만 원래 오류를 cause로 남긴다. 문법에서 거절한 이름에는 cause가 없다.
 * @param {string} timezone 받은 이름
 * @param {unknown} [cause] 호스트가 던진 원래 오류
 * @returns {RangeError} 던질 오류
 */
function unsupportedTimeZone(timezone,cause){return new RangeError(`Unsupported time zone: ${timezone.slice(0,64)}`,cause===undefined?undefined:{cause});}
/**
 * 지원 연도(1000~9999)인지 확인한다. 범위 밖이면 iOS('999')와 Android('0999')가 다르게 쓰던 값을 내지 않고 거절한다.
 * @param {number} year 그레고리력 연도(NaN이면 범위 밖으로 본다)
 * @returns {number} 받은 연도
 */
function supportedMarketYear(year){if(!(year>=1000&&year<=9999))throw new RangeError('Time zone conversion year out of range');return year;}
/**
 * 지역 시각 성분을 계약 형식으로 만든다. 연도는 4자리, 나머지는 2자리로 0을 채우고 키 순서를 고정한다.
 * @param {number} year 연도(지원 범위를 여기서 확인한다)
 * @param {number|string} month 월
 * @param {number|string} day 일
 * @param {number|string} hour 시(00~23)
 * @param {number|string} minute 분
 * @param {number|string} second 초
 * @returns {{year: string, month: string, day: string, hour: string, minute: string, second: string}} 지역 시각
 */
function zonedPartsRecord(year,month,day,hour,minute,second){
  const two=value=>String(value).padStart(2,'0');
  return {year:String(supportedMarketYear(year)),month:two(month),day:two(day),hour:two(hour),minute:two(minute),second:two(second)};
}
/**
 * ±HH:MM 고정 오프셋의 지역 시각을 Intl 없이 계산한다.
 * Intl처럼 시각을 먼저 Date의 정수 밀리초로 자른 뒤 오프셋을 더해, 소수 밀리초에서도 같은 순간을 본다.
 * @param {number} time 범위 검사를 통과한 UTC epoch ms
 * @param {RegExpExecArray} offset MARKET_FIXED_OFFSET 일치 결과
 * @returns {ReturnType<typeof zonedPartsRecord>} 지역 시각
 */
function fixedOffsetZonedParts(time,offset){
  const local=new Date(new Date(time).getTime()+(offset[1]==='-'?-1:1)*(Number(offset[2])*60+Number(offset[3]))*60000);
  return zonedPartsRecord(local.getUTCFullYear(),local.getUTCMonth()+1,local.getUTCDate(),local.getUTCHours(),local.getUTCMinutes(),local.getUTCSeconds());
}
/**
 * 이름 있는 시간대의 지역 시각을 호스트 Intl(Android는 java.time shim)로 계산한다.
 * 포매터 생성이나 formatToParts 실패는 모두 같은 Unsupported 오류로 바꾸고, 캐시는 호출 전체가 성공했을 때만 갱신한다.
 * @param {number} time 범위 검사를 통과한 UTC epoch ms
 * @param {string} timezone 문법 검사를 통과한 이름(원래 철자 그대로 호스트에 넘긴다)
 * @returns {ReturnType<typeof zonedPartsRecord>} 지역 시각
 */
function intlZonedParts(time,timezone){
  const key=timezone.replace(/[A-Z]/g,char=>char.toLowerCase());let fmt=formatters.get(key),values;
  try{
    if(!fmt)fmt=new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
    values=Object.fromEntries(fmt.formatToParts(new Date(time)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  }catch(error){throw unsupportedTimeZone(timezone,error);}
  const result=zonedPartsRecord(Number(values.year),values.month,values.day,values.hour,values.minute,values.second);
  // The native shim can reject a zone at formatToParts, after construction.
  // Failed calls neither insert nor refresh/evict successful cached entries.
  // 연도 범위로 실패한 호출도 실패한 호출이다(위 zonedPartsRecord가 먼저 던진다).
  formatters.delete(key);formatters.set(key,fmt);if(formatters.size>MARKET_TIMEZONE_FORMATTER_LIMIT)formatters.delete(formatters.keys().next().value);
  return result;
}
/**
 * Converts a UTC instant to local calendar parts in a time zone (time zone contract v1).
 * Accepts ASCII IANA-style names, case-insensitively, and fixed offsets `±HH:MM`. Host-only names such as `Z`,
 * `UT` and `UTC+9` are rejected. The local year must be 1000 through 9999.
 * @param {number} time finite UTC epoch milliseconds
 * @param {string} timezone time zone name of 1..128 UTF-16 code units
 * @returns {{year: string, month: string, day: string, hour: string, minute: string, second: string}} zero-padded parts
 * @throws {TypeError} when the time zone is not a string of 1..128 code units
 * @throws {RangeError} `Time zone conversion requires a finite time`, `Time zone conversion year out of range` or
 *   `Unsupported time zone: <name>`; a host failure is kept as `cause`
 */
export function zonedParts(time, timezone) {
  if(typeof timezone!=='string'||!timezone.length||timezone.length>128)throw new TypeError('Timezone string, at most 128 characters required');
  if(!Number.isFinite(time))throw new RangeError('Time zone conversion requires a finite time');
  if(time<MARKET_TIME_MIN||time>MARKET_TIME_MAX)throw new RangeError('Time zone conversion year out of range');
  const offset=MARKET_FIXED_OFFSET.exec(timezone);if(offset)return fixedOffsetZonedParts(time,offset);
  if(!MARKET_ZONE_NAME.test(timezone)||MARKET_HOST_ONLY_ZONE.test(timezone))throw unsupportedTimeZone(timezone);
  return intlZonedParts(time,timezone);
}
/**
 * 엄격한 ISO 날짜 YYYY-MM-DD를 읽는다. 연도 1000~9999, 월 1~12, 일은 그레고리력 월 길이(윤년 포함) 이내다.
 * Date.parse는 엔진마다 2026-02-30을 다르게 다뤄(JSC는 NaN, V8·QuickJS는 3월로 넘김) 쓰지 않는다.
 * @param {unknown} date 날짜 문자열
 * @returns {[number, number, number]|null} [연, 월, 일], 틀리면 null
 */
function parseMarketDate(date){
  const match=typeof date==='string'?/^(\d{4})-(\d{2})-(\d{2})$/.exec(date):null;if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),leap=year%4===0&&(year%100!==0||year%400===0);
  return year>=1000&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]?[year,month,day]:null;
}
/**
 * 엄격한 시각 HH:mm 또는 HH:mm:ss를 읽는다. 시 00~23, 분·초 00~59다(24:00과 소수 초는 받지 않는다).
 * @param {unknown} clock 시각 문자열
 * @returns {[number, number, number]|null} [시, 분, 초], 틀리면 null
 */
function parseMarketClock(clock){
  const match=typeof clock==='string'?/^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clock):null;if(!match)return null;
  const hour=Number(match[1]),minute=Number(match[2]),second=Number(match[3]??0);
  return hour<=23&&minute<=59&&second<=59?[hour,minute,second]:null;
}
export function marketDate(time, timezone) {const p = zonedParts(time, timezone); return `${p.year}-${p.month}-${p.day}`;}
/**
 * Moves a strict ISO date (`YYYY-MM-DD`, years 1000 through 9999) by whole days with Gregorian arithmetic.
 * @param {string} date ISO calendar date
 * @param {number} days days to add; negative values move back
 * @returns {string} the shifted ISO date
 * @throws {TypeError} `ISO date required` for a malformed or nonexistent date
 * @throws {RangeError} `Time zone conversion year out of range` when the result leaves years 1000 through 9999
 */
export function shiftDate(date, days) {
  const parts=parseMarketDate(date);if(!parts)throw new TypeError('ISO date required');
  // 정오(UTC)에서 날짜만큼 옮긴 뒤 UTC 날짜를 읽는다. 결과 연도도 지원 범위여야 한다(10000년을 잘라 쓰지 않는다)
  const shifted=new Date(Date.UTC(parts[0],parts[1]-1,parts[2],12)+days*86400000),year=supportedMarketYear(shifted.getUTCFullYear());
  return `${year}-${String(shifted.getUTCMonth()+1).padStart(2,'0')}-${String(shifted.getUTCDate()).padStart(2,'0')}`;
}
/**
 * Resolves a local wall-clock time in a time zone to UTC epoch milliseconds.
 * The date and clock are parsed strictly (`YYYY-MM-DD`, `HH:mm` or `HH:mm:ss`). For a repeated clock, `ambiguity`
 * picks the `earlier` (default) or `later` instant, or `reject`s it.
 * @param {string} date ISO calendar date, years 1000 through 9999
 * @param {string} clock local wall-clock time
 * @param {string} timezone time zone name accepted by {@link zonedParts}
 * @param {'earlier'|'later'|'reject'} [ambiguity] repeated-clock policy
 * @returns {number} UTC epoch milliseconds
 * @throws {TypeError} `ISO date and HH:mm[:ss] required`
 * @throws {RangeError} `Nonexistent local time at DST boundary`, `Ambiguous local time` or a {@link zonedParts} error
 */
export function zonedEpoch(date, clock, timezone, ambiguity = 'earlier') {
  const day=parseMarketDate(date),time=parseMarketClock(clock);if(!day||!time)throw new TypeError('ISO date and HH:mm[:ss] required');
  const iso = `${date}T${clock.length === 5 ? clock + ':00' : clock}`, naive = Date.UTC(day[0], day[1] - 1, day[2], time[0], time[1], time[2]);
  const offsets = new Set();
  // 세 표본(앞날·당일·다음날)과 후보 정렬 규칙은 그대로다(이식 지도 §3.5.3). 지역 시각만 Date.UTC로 되돌린다
  for (const d of [-1, 0, 1]) {const t = naive + d * 86400000, p = zonedParts(t, timezone), local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)); offsets.add(local - t);}
  const candidates = [...offsets].map(offset => naive - offset).filter(t => {const p = zonedParts(t, timezone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === iso;}).sort((a, b) => a - b);
  if (!candidates.length) throw new RangeError('Nonexistent local time at DST boundary');
  if (candidates.length > 1 && ambiguity === 'reject') throw new RangeError('Ambiguous local time');
  return ambiguity === 'later' ? candidates[candidates.length - 1] : candidates[0];
}
export function validateSymbol(symbol) {
  if (!symbol || ['id', 'exchange', 'timezone', 'currency', 'volumeUnit'].some(k => typeof symbol[k] !== 'string' || !symbol[k]) || !Number.isInteger(symbol.priceDecimals) || symbol.priceDecimals < 0 || symbol.priceDecimals > 18 || !Number.isFinite(symbol.tickSize) || symbol.tickSize <= 0 || !['raw', 'split', 'total-return'].includes(symbol.adjustment)) throw new TypeError('Invalid symbol metadata');
  // 호스트 객체 키 순서(Swift Dictionary 등)가 inspect()와 작업공간에 남지 않도록 검증기 허용 목록 순서로 담는다
  zonedParts(0, symbol.timezone); return Object.freeze(orderedRecord(symbol,SYMBOL_KEYS));
}
export function formatPrice(value, symbol) {return value.toFixed(symbol.priceDecimals);}
function boundedDenseArray(value,max,label,exactLength){
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError(label+' dense array required');
  const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length'),length=lengthDescriptor?.value;
  if(!lengthDescriptor||!Object.hasOwn(lengthDescriptor,'value')||!Number.isSafeInteger(length)||length<0)throw new TypeError(label+' own length required');
  if(length>max)throw new RangeError(label+': limit '+max);if(exactLength!==undefined&&length!==exactLength)throw new TypeError(label+' length '+exactLength+' required');
  if(Object.getOwnPropertySymbols(value).length)throw new TypeError(label+' dense array required');
  return length;
}
function ownArrayValue(value,index,label){
  const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
  if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');
  return descriptor.value;
}
function requireDenseSlots(value,length,label){for(let index=0;index<length;index++){const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');}}
function ownObjectValues(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain object required');
  return FIELDS.map(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');return descriptor.value;});
}
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
  const length=boundedDenseArray(rows,RESOURCE_LIMITS.maxBars,'OHLCV rows');requireDenseSlots(rows,length,'OHLCV row');const result=new Array(length);
  for(let rowIndex=0;rowIndex<length;rowIndex++){
    const row=ownArrayValue(rows,rowIndex,'OHLCV row'),values=format==='tuples'?(()=>{boundedDenseArray(row,FIELDS.length,'OHLCV tuple',FIELDS.length);return FIELDS.map((_key,index)=>ownArrayValue(row,index,'OHLCV tuple'));})():ownObjectValues(row,'OHLCV object');
    const b=Object.fromEntries(FIELDS.map((k,i)=>{const value=values[i];if(k==='time'&&typeof value==='string')return [k,decimalTime(value,timeUnit)];if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))throw new TypeError('Numeric fields or nonempty numeric strings required');return [k,k==='time'?value*(timeUnit==='s'?1000:1):Number(value)];}));validateBar(b);result[rowIndex]=b;
  }
  return result;
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
    if(maxBuckets>RESOURCE_LIMITS.maxBars||maxTicksPerBucket>RESOURCE_LIMITS.maxBars)throw new RangeError('Aggregation retention limit '+RESOURCE_LIMITS.maxBars);
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
    let at=ticks.length,bar;
    if(!late){
      const previous=entry?.bar;bar=previous?{time:bucket.time,open:previous.open,high:Math.max(previous.high,price),low:Math.min(previous.low,price),close:price,volume:previous.volume+volume}:{time:bucket.time,open:price,high:price,low:price,close:price,volume:0+volume};
    }else{
      at=ticks.findIndex(t=>t.time>time);if(at<0)at=ticks.length;
      // Accepted late corrections rebuild in stable chronological order. This
      // also resets the incremental aggregate to the exact cold-oracle sum.
      bar={time:bucket.time,open:at===0?price:ticks[0].price,high:-Infinity,low:Infinity,close:at===ticks.length?price:ticks[ticks.length-1].price,volume:0};
      for(let i=0;i<=ticks.length;i++){const t=i===at?copy:ticks[i<at?i:i-1];bar.high=Math.max(bar.high,t.price);bar.low=Math.min(bar.low,t.price);bar.volume+=t.volume;}
    }
    if (!Number.isFinite(bar.volume)) throw new RangeError('Aggregated tick volume must remain finite');
    validateBar(bar);
    const committed = entry ?? {ticks, ids: new Set(),bar:null};
    ticks.splice(at, 0, copy); if (id !== undefined) committed.ids.add(id);
    committed.bar=bar;
    if (!entry) this.buckets.set(bucket.time, committed);
    this.sequence++; this.lastTime = Math.max(this.lastTime, time);
    // Missing historical buckets are rejected above, so new entries arrive in
    // time order and Map insertion order identifies the oldest retained bucket.
    while(this.buckets.size>this.maxBuckets)this.buckets.delete(this.buckets.keys().next().value);
    return {status: late ? 'correction' : ticks.length === 1 ? 'append' : 'update', bar:{...bar}, sessionDate: bucket.sessionDate, sessionKind: bucket.kind};
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
