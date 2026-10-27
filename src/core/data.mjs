import {snapshotDataBatchOptions} from './data-batch-options.mjs';
import {RESOURCE_LIMITS,sizeLimit} from './contracts.mjs';
// Capture typed-array metadata/copy intrinsics, avoiding caller length getters
// and subarray/constructor species during the column bulk-copy path.
const dataColumnPrototype=Object.getPrototypeOf(Float64Array.prototype);
const dataColumnSlot=key=>Object.getOwnPropertyDescriptor(dataColumnPrototype,key).get;
const dataColumnLength=dataColumnSlot('length'),dataColumnBuffer=dataColumnSlot('buffer'),dataColumnOffset=dataColumnSlot('byteOffset'),dataColumnTag=dataColumnSlot(Symbol.toStringTag),dataColumnSet=Float64Array.prototype.set;
const dataColumnConstructors=new Map([Float64Array,Float32Array,Int32Array,Uint32Array,Int16Array,Uint16Array,Int8Array,Uint8Array,Uint8ClampedArray,...(typeof globalThis.Float16Array==='function'?[globalThis.Float16Array]:[])].map(Type=>[Type.name,Type]));
let storeSerial=0;
export const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];
function readBar(bar,target={}) {if(!bar||typeof bar!=='object')throw new TypeError('OHLCV object required');for(const k of FIELDS)target[k]=bar[k];return target;}
function batchRecord(value,keys,label,required=keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain data record required');
  const copy={};
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!keys.includes(key)||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' unsupported field or accessor data property');
    copy[key]=descriptor.value;
  }
  if(required.some(key=>!Object.hasOwn(copy,key)))throw new TypeError(label+' required data property');
  return copy;
}
function batchEvents(events) {
  if(!Array.isArray(events))throw new TypeError('Data batch array required');
  const count=Object.getOwnPropertyDescriptor(events,'length')?.value;
  if(!Number.isSafeInteger(count)||count<1||count>4096)throw new RangeError('Data batch event count must be 1..4096');
  const keys=Reflect.ownKeys(events);
  if(keys.length!==count+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!Number.isSafeInteger(Number(key))||String(Number(key))!==key||Number(key)<0||Number(key)>=count)))throw new TypeError('Data batch dense array data properties required');
  const copy=[];
  for(let i=0;i<count;i++){
    const descriptor=Object.getOwnPropertyDescriptor(events,String(i));
    if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError('Data batch array accessor data property');
    const event=batchRecord(descriptor.value,['kind','bar'],'Data batch event');
    if(!['append','update','correction'].includes(event.kind))throw new TypeError('Data batch event kind must be append, update or correction');
    const bar=batchRecord(event.bar,FIELDS,'Data batch OHLCV');validateBar(bar);copy.push({kind:event.kind,bar});
  }
  return copy;
}
function batchBudget(value,max,label) {
  if(!Number.isSafeInteger(value)||value<0||value>max){const error=new RangeError('Data batch '+label+' budget limit '+max);error.code='STORE_BUDGET';throw error;}
  return value;
}
export function validateBar(b, previous = -Infinity) {
  if (!b || FIELDS.some(k => !Number.isFinite(b[k]))) throw new TypeError('Every OHLCV field must be finite');
  if (!Number.isSafeInteger(b.time) || Math.abs(b.time) > 8640000000000000) throw new RangeError('Time must be an exact UTC millisecond integer in the Date range');
  if (b.time <= previous) throw new RangeError('Times must be strictly increasing');
  if (b.volume < 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.low > b.high) throw new RangeError('Invalid OHLCV envelope');
}

// Flat segment tree: O(log N) edits and range queries, O(N) bulk construction.
export class RangeIndex {
  constructor(length, low, high = low, volume = null, capacity = length, countFinite = false) {
    sizeLimit(capacity,RESOURCE_LIMITS.maxBars,'Index capacity');sizeLimit(length,capacity,'Index length');
    if(typeof countFinite!=='boolean'||countFinite&&volume!==null)throw new TypeError('Finite-count index cannot also sum volume');
    if(!low||!high||low.length<length||high.length<length||volume&&volume.length<length)throw new RangeError('Index input length');
    this.size = 1;
    while (this.size < capacity) this.size *= 2;
    this.min = new Float64Array(this.size * 2).fill(Infinity);
    this.max = new Float64Array(this.size * 2).fill(-Infinity);
    this.finiteCounts=countFinite;
    this.sum = volume || countFinite ? new Float64Array(this.size * 2) : null;
    for (let i = 0; i < length; i++) this.leaf(i, low[i], high[i], volume?.[i] ?? 0);
    for(let i=this.size-1;i>0;i--)this.merge(i);if(this.sum&&!Number.isFinite(this.sum[1]))throw new RangeError('Volume sum overflow');
  }
  leaf(i, low, high, volume) {
    const p = this.size + i;
    this.min[p] = Number.isFinite(low) ? low : Infinity;
    this.max[p] = Number.isFinite(high) ? high : -Infinity;
    if (this.sum) this.sum[p] = this.finiteCounts ? Number(Number.isFinite(low)&&Number.isFinite(high)) : volume;
  }
  merge(p) {
    this.min[p] = Math.min(this.min[p * 2], this.min[p * 2 + 1]);
    this.max[p] = Math.max(this.max[p * 2], this.max[p * 2 + 1]);
    if(this.sum)this.sum[p]=this.sum[p*2]+this.sum[p*2+1];
  }
  update(i, low, high = low, volume = 0) {
    if(!Number.isInteger(i)||i<0||i>=this.size)throw new RangeError('Index update bounds');
    if(this.sum&&!this.finiteCounts){let sum=volume;if(!Number.isFinite(sum)||sum<0)throw new RangeError('Volume');for(let p=this.size+i;p>1;p>>=1)sum+=this.sum[p^1];if(!Number.isFinite(sum))throw new RangeError('Volume sum overflow');}
    this.leaf(i, low, high, volume);
    for (let p = (this.size + i) >> 1; p; p >>= 1) this.merge(p);
  }
  query(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.size) throw new RangeError('Range index bounds');
    let min = Infinity, max = -Infinity, sum = 0;
    for (let a = start + this.size, b = end + this.size; a < b; a >>= 1, b >>= 1) {
      if (a & 1) { min = Math.min(min, this.min[a]); max = Math.max(max, this.max[a]); sum += this.sum?.[a] ?? 0; a++; }
      if (b & 1) { --b; min = Math.min(min, this.min[b]); max = Math.max(max, this.max[b]); sum += this.sum?.[b] ?? 0; }
    }
    return {min, max, sum:this.finiteCounts?0:sum};
  }
  _sumRange(start,end){if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>this.size)throw new RangeError('Range index bounds');let count=0;for(let a=start+this.size,b=end+this.size;a<b;a>>=1,b>>=1){if(a&1){count+=this.sum?.[a]??0;a++;}if(b&1){--b;count+=this.sum?.[b]??0;}}return count;}
  finiteCount(start,end){if(!this.finiteCounts||!this.sum)throw new TypeError('Finite-count index required');return this._sumRange(start,end);}
  hasGaps(start,end){return this.finiteCount(start,end)!==end-start;}
  get bytes() { return this.min.byteLength + this.max.byteLength + (this.sum?.byteLength ?? 0); }
}

export class BarStore {
  #internalListeners = new Set();
  constructor(bars = [], {timeframeMs = 60000, timeOrigin = 0,maxBars=RESOURCE_LIMITS.maxBars,onListenerError=null} = {}) { if (!Number.isFinite(timeframeMs) || timeframeMs <= 0 || !Number.isFinite(timeOrigin)||onListenerError!==null&&typeof onListenerError!=='function') throw new RangeError('Virtual timeframe/origin or listener error callback');sizeLimit(maxBars,RESOURCE_LIMITS.maxBars,'Bar limit');this.geometryIdentity=++storeSerial;this.maxBars=maxBars;this.onListenerError=onListenerError;this.listenerErrors=[];this.pendingChanges=[];this.notifying=false; this.timeframeMs = timeframeMs; this.timeOrigin = timeOrigin; this.listeners = new Set(); this.version = 0;this.timeVersion=0; this.setData(bars); }
  setData(bars) {
    if(!Array.isArray(bars))throw new TypeError('OHLCV array required');const count=bars.length;sizeLimit(count,this.maxBars,'Bar count');
    let capacity=16;while(capacity<count)capacity*=2;
    const columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(capacity)])),scratch={};
    let previous = -Infinity;
    for(let i=0;i<count;i++){readBar(bars[i],scratch);validateBar(scratch,previous);previous=scratch.time;for(const k of FIELDS)columns[k][i]=scratch[k];}
    // Row/index getters may mutate the input array. Never expand the admitted
    // work or publish a different count after the initial capacity/budget check.
    if(bars.length!==count)throw new RangeError('OHLCV array length changed during snapshot');
    const index=new RangeIndex(count,columns.low,columns.high,columns.volume,capacity);
    Object.assign(this,{length:count,capacity,columns,index});this.changed(0,'reset');
  }
  // Fast column load avoids a million transient bar objects. Validates atomically.
  setColumns(input, length, event = {kind: 'reset'}) {
    if(length!==undefined)sizeLimit(length,this.maxBars,'Bar count');
    const sources=FIELDS.map(k=>input?.[k]);
    if(length===undefined){const time=sources[0];length=Array.isArray(time)?time.length:ArrayBuffer.isView(time)?dataColumnLength.call(time):undefined;}
    sizeLimit(length,this.maxBars,'Bar count');
    const types=sources.map(source=>{
      if(Array.isArray(source)){if(source.length<length)throw new TypeError('Numeric column arrays required');return null;}
      if(!ArrayBuffer.isView(source))throw new TypeError('Numeric column arrays required');
      const Type=dataColumnConstructors.get(dataColumnTag.call(source));
      if(!Type||dataColumnLength.call(source)<length)throw new TypeError('Numeric column arrays required');return Type;
    });
    let capacity=16;while(capacity<length)capacity*=2;
    const columns=Object.fromEntries(FIELDS.map((k,j)=>{
      const source=sources[j],a=new Float64Array(capacity);
      if(Array.isArray(source)){
        if(source.length<length)throw new TypeError('Numeric column arrays required');
        for(let i=0;i<length;i++){const value=source[i];if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Numeric column values required');a[i]=value;}
      }else{
        const Type=types[j];
        if(dataColumnLength.call(source)<length)throw new TypeError('Numeric column arrays required');
        // A fresh built-in view preserves the captured source's actual type and
        // logical byte range without consulting its constructor or species.
        const view=new Type(dataColumnBuffer.call(source),dataColumnOffset.call(source),length);
        dataColumnSet.call(a,view);
      }
      return [k,a];
    }));
    let previous = -Infinity;
    // Hot input path validates columns directly; no per-bar object allocation.
    const {time, open, high, low, close, volume} = columns;
    for (let i = 0; i < length; i++) {
      const t = time[i], o = open[i], h = high[i], l = low[i], c = close[i], v = volume[i];
      if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(v)) throw new TypeError('Every OHLCV field must be finite');
      if (!Number.isSafeInteger(t) || Math.abs(t) > 8640000000000000) throw new RangeError('Time must be an exact UTC millisecond integer in the Date range');
      if (t <= previous) throw new RangeError('Times must be strictly increasing');
      if (v < 0 || l > Math.min(o, c) || h < Math.max(o, c) || l > h) throw new RangeError('Invalid OHLCV envelope');
      previous = t;
    }
    const index=new RangeIndex(length,columns.low,columns.high,columns.volume,capacity);
    Object.assign(this,{length,capacity,columns,index});this.changed(0,event.kind,{added:event.added});
  }
  prepend(bars) {
    if (!Array.isArray(bars)) throw new TypeError('Prepend bars required'); if (!bars.length) return;
    sizeLimit(bars.length+this.length,this.maxBars,'Bar count');
    if (this.length && bars[bars.length - 1].time >= this.columns.time[0]) throw new RangeError('Prepend must precede existing history without overlap');
    let previous = -Infinity; for (const bar of bars) {validateBar(bar, previous); previous = bar.time;}
    const n = bars.length, columns = Object.fromEntries(FIELDS.map(k => [k, new Float64Array(n + this.length)]));
    for (let i = 0; i < n; i++) for (const k of FIELDS) columns[k][i] = bars[i][k];
    for (const k of FIELDS) columns[k].set(this.columns[k].subarray(0, this.length), n);
    this.setColumns(columns, n + this.length, {kind: 'prepend', added: n});
  }
  reindex() { const c = this.columns; this.index = new RangeIndex(this.length, c.low, c.high, c.volume, this.capacity); }
  reserve() {
    if (this.length < this.capacity) return;
    const capacity=this.capacity*2,columns=Object.fromEntries(FIELDS.map(k=>{const a=new Float64Array(capacity);a.set(this.columns[k]);return [k,a];})),index=new RangeIndex(this.length,columns.low,columns.high,columns.volume,capacity);Object.assign(this,{capacity,columns,index});
  }
  // Derived model/indicator state is updated at mutation time, including a
  // nested mutation. Public snapshots still drain in original version order.
  changed(from, kind, extra = {}) {
    if(kind!=='update'&&(kind!=='batch'||extra.appended>0))this.timeVersion++;const change={from,kind,version:++this.version,...extra},internal=[],external=[];
    for(const fn of this.listeners)(this.#internalListeners.has(fn)?internal:external).push(fn);
    const outer=!this.notifying;if(outer){this.notifying=true;this.listenerErrors=[];}this.pendingChanges.push({change,listeners:external});
    try {for(const fn of internal)this.#notify(fn,change);if(outer)while(this.pendingChanges.length){const {change,listeners}=this.pendingChanges.shift();for(const fn of listeners)this.#notify(fn,change);}}finally{if(outer)this.notifying=false;}
  }
  #notify(fn,change){try{fn(change);}catch(error){if(this.listenerErrors.length<32)this.listenerErrors.push({error,change});try{this.onListenerError?.(error,change);}catch(reportError){if(this.listenerErrors.length<32)this.listenerErrors.push({error:reportError,change});}}}
  subscribe(fn) {if(typeof fn!=='function')throw new TypeError('Listener function required');this.listeners.add(fn); return () => this.listeners.delete(fn); }
  // Package-internal subscriptions share the public ledger and cleanup path.
  _subscribeInternal(fn){const stop=this.subscribe(fn);this.#internalListeners.add(fn);return()=>{this.#internalListeners.delete(fn);stop();};}
  at(i) { if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError('Bar index'); return Object.fromEntries(FIELDS.map(k => [k, this.columns[k][i]])); }
  applyEvents(events,options={}) {return this._applyEvents(events,options);}
  // Package-internal ledger seam only. beforeNotify must be owned, synchronous,
  // pure with respect to the store, and nonthrowing. It runs after commit but
  // before changed()/public observers; public options never accept a callback.
  _applyEvents(events,options={},beforeNotify=null) {
    const source={columns:this.columns,index:this.index,length:this.length,capacity:this.capacity,version:this.version,timeVersion:this.timeVersion,maxBars:this.maxBars};
    const arrays=FIELDS.map(key=>source.columns[key]);
    const current=()=>{
      if(this.columns!==source.columns||this.index!==source.index||this.length!==source.length||this.capacity!==source.capacity||this.maxBars!==source.maxBars||FIELDS.some((key,i)=>this.columns[key]!==arrays[i])||this.timeVersion!==source.timeVersion||this.version!==source.version){const error=new Error('Data batch source changed during snapshot; stale transaction discarded');error.code='SOURCE_CHANGED';throw error;}
    };
    const limits=snapshotDataBatchOptions(options),copied=batchEvents(events);
    if(beforeNotify!==null&&(typeof beforeNotify!=='function'||limits.skipUnchanged===true))throw new TypeError('Internal data batch ledger requires unconditional publication');
    current();
    const maxBars=batchBudget(limits.maxBars===undefined?source.maxBars:limits.maxBars,source.maxBars,'bar'),maxBytes=batchBudget(limits.maxStoreBytes===undefined?96*RESOURCE_LIMITS.maxBars:limits.maxStoreBytes,96*RESOURCE_LIMITS.maxBars,'store byte');
    const appended=copied.reduce((n,event)=>n+Number(event.kind==='append'),0),length=source.length+appended;
    batchBudget(length,maxBars,'bar');let capacity=source.capacity;while(capacity<length)capacity*=2;batchBudget(96*capacity,maxBytes,'store byte');

    // Resolve sequential semantics without touching live data. Appends in this
    // batch may subsequently be updated or corrected by exact timestamp.
    const addedTimes=new Map(),operations=[];let next=source.length,tail=next?source.columns.time[next-1]:-Infinity,from=length,to=0;
    for(const event of copied){
      const b=event.bar;let index;
      if(event.kind==='append'){validateBar(b,tail);index=next++;tail=b.time;addedTimes.set(b.time,index);}
      else if(event.kind==='update'){if(!next||b.time!==tail)throw new RangeError('Data batch update is only the current timestamp');index=next-1;}
      else{
        index=addedTimes.get(b.time);
        if(index===undefined){let a=0,z=source.length;while(a<z){const mid=(a+z)>>>1;if(source.columns.time[mid]<b.time)a=mid+1;else z=mid;}index=a;if(index===source.length||source.columns.time[index]!==b.time)throw new RangeError('Data batch correction requires an existing timestamp');}
      }
      from=Math.min(from,index);to=Math.max(to,index+1);operations.push({index,bar:b,kind:event.kind});
    }

    // A fixed-capacity transaction stages only touched leaves and ancestors.
    // Growth builds the final larger tree once; its old buffers remain intact.
    const index=capacity===source.capacity?source.index:new RangeIndex(source.length,source.columns.low,source.columns.high,source.columns.volume,capacity),nodes=new Map(),values=new Map();
    const sumAt=p=>{const node=nodes.get(p);return node?node.sum:index.sum[p];};
    // Transaction-local records are reused only after their child values have
    // been read. No staged object is published to observers or kept afterward.
    const stage=(p,min,max,sum)=>{const node=nodes.get(p);if(node){node.min=min;node.max=max;node.sum=sum;}else nodes.set(p,{min,max,sum});};
    for(const operation of operations){
      const b=operation.bar,leaf=capacity+operation.index;
      if(operation.kind==='append'&&!Number.isFinite(sumAt(1)+b.volume))throw new RangeError('Volume sum overflow');
      // Mirror scalar RangeIndex.update's intermediate sum guard and merge order.
      let sum=b.volume;for(let p=leaf;p>1;p>>=1)sum+=sumAt(p^1);if(!Number.isFinite(sum))throw new RangeError('Volume sum overflow');
      stage(leaf,b.low,b.high,b.volume);
      for(let p=leaf>>1;p;p>>=1){const l=p*2,r=l+1,left=nodes.get(l),right=nodes.get(r);stage(p,Math.min(left?left.min:index.min[l],right?right.min:index.min[r]),Math.max(left?left.max:index.max[l],right?right.max:index.max[r]),(left?left.sum:index.sum[l])+(right?right.sum:index.sum[r]));}
      values.set(operation.index,b);
    }
    // All intermediate rows, capacity limits and tree arithmetic were validated.
    // Compare the final replacements, never infer freshness or collapse events.
    let unchanged=limits.skipUnchanged===true&&appended===0;
    if(unchanged)for(const [i,b] of values)if(FIELDS.some(key=>!Object.is(source.columns[key][i],b[key]))){unchanged=false;break;}
    if(unchanged){current();return Object.freeze({events:copied.length,appended,from,to,version:source.version,length,capacity,bytes:96*capacity,unchanged:true});}
    let columns=source.columns;
    if(capacity!==source.capacity){
      columns=Object.fromEntries(FIELDS.map(key=>{const array=new Float64Array(capacity);Float64Array.prototype.set.call(array,source.columns[key]);return [key,array];}));
    }
    const receipt=Object.freeze({events:copied.length,appended,from,to,version:source.version+1,length,capacity,bytes:96*capacity,...(limits.skipUnchanged===true?{unchanged:false}:{})});
    current();
    // Validation and capacity allocation finish before this guarded publication;
    // the writes below use only owned rows, tree nodes and numeric typed arrays.
    for(const [i,b] of values)for(const key of FIELDS)columns[key][i]=b[key];
    for(const [p,value] of nodes){index.min[p]=value.min;index.max[p]=value.max;index.sum[p]=value.sum;}
    Object.assign(this,{length,capacity,columns,index});
    beforeNotify?.(receipt);this.changed(from,'batch',{appended,to});return receipt;
  }
  append(bar) {
    bar=readBar(bar);sizeLimit(this.length+1,this.maxBars,'Bar count');
    validateBar(bar, this.length ? this.columns.time[this.length - 1] : -Infinity);
    if(!Number.isFinite(this.index.sum[1]+bar.volume))throw new RangeError('Volume sum overflow');
    this.reserve(); const i = this.length;
    this.index.update(i, bar.low, bar.high, bar.volume);
    for (const k of FIELDS) this.columns[k][i] = bar[k];
    this.length++;this.changed(i, 'append'); return i;
  }
  update(i, bar) {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError('Bar index');
    const version=this.version,columns=this.columns,index=this.index,length=this.length;
    bar=readBar(bar);validateBar(bar);
    if(this.version!==version||this.columns!==columns||this.index!==index||this.length!==length)throw new Error('Bar store changed during update snapshot');
    if (bar.time !== this.columns.time[i]) throw new RangeError('An edit cannot change time; reload to insert/reorder');
    this.index.update(i,bar.low,bar.high,bar.volume);for(const k of FIELDS)this.columns[k][i]=bar[k];this.changed(i,'update');
  }
  upsert(bar) {bar=readBar(bar); if (this.length && bar.time === this.columns.time[this.length - 1]) this.update(this.length - 1, bar); else this.append(bar); }
  lowerBound(time) {
    let a = 0, b = this.length;
    while (a < b) { const m = (a + b) >>> 1; if (this.columns.time[m] < time) a = m + 1; else b = m; }
    return a;
  }
  indexAtTime(time) {
    if (this.length < 2) return (time - (this.length ? this.columns.time[0] : this.timeOrigin)) / this.timeframeMs;
    const i = Math.max(1, Math.min(this.length - 1, this.lowerBound(time))), t = this.columns.time;
    return i - 1 + (time - t[i - 1]) / (t[i] - t[i - 1]);
  }
  timeAtIndex(index) {
    if (this.length < 2) return (this.length ? this.columns.time[0] : this.timeOrigin) + index * this.timeframeMs;
    const i = Math.max(0, Math.min(this.length - 2, Math.floor(index))), t = this.columns.time;
    return t[i] + (index - i) * (t[i + 1] - t[i]);
  }
  aggregate(start, end, maxBuckets) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) throw new RangeError('Positive bucket count required');
    start = Math.max(0, Math.floor(start)); end = Math.min(this.length, Math.ceil(end));
    if (Number.isNaN(start) || Number.isNaN(end)) throw new RangeError('Aggregate bounds must not be NaN');
    if (end <= start) return [];
    const n = Math.min(end - start, maxBuckets), c = this.columns, out = new Array(n);
    for (let b = 0; b < n; b++) {
      const a = start + Math.floor(b * (end - start) / n), z = start + Math.floor((b + 1) * (end - start) / n), q = this.index.query(a, z);
      out[b] = {start: a, end: z, index: (a + z - 1) / 2, time: c.time[a], open: c.open[a], high: q.max, low: q.min, close: c.close[z - 1], volume: q.sum};
    }
    return out;
  }
  get bytes() { return FIELDS.reduce((n, k) => n + this.columns[k].byteLength, this.index.bytes); }
}

export function seededColumns(length, seed = 42) {
  sizeLimit(length,RESOURCE_LIMITS.maxBars,'Synthetic bar count');
  let s = seed >>> 0, price = 100;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const c = Object.fromEntries(FIELDS.map(k => [k, new Float64Array(length)]));
  for (let i = 0; i < length; i++) {
    const open = price; price = Math.max(0.1, price + (rand() - 0.497) * 1.2);
    c.time[i] = 1700000000000 + i * 60000; c.open[i] = open; c.close[i] = price;
    c.high[i] = Math.max(open, price) + rand() * 0.6; c.low[i] = Math.max(0.01, Math.min(open, price) - rand() * 0.6); c.volume[i] = Math.floor(100 + rand() * 9900);
  }
  return c;
}
